import { open, readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

import { ParserError, sourceBodyFromBytes, throwIfAborted, type ParseContext, type SourceBody } from "../parser-types";
import type { TimedTranscript } from "./transcript-types";
import type {
  FrameSelectionProvider,
  SelectedVideoFrame,
  VideoFrameCandidate,
  VideoFrameExtractor,
  VideoVisualAnalyzer,
  VideoVisualOptions,
  VideoVisualResult,
  VisionFrameInput
} from "./video-visual-types";

export class VideoVisualPipeline implements VideoVisualAnalyzer {
  constructor(
    private readonly extractor: VideoFrameExtractor,
    private readonly provider: FrameSelectionProvider,
    private readonly options: VideoVisualOptions
  ) {}

  async fingerprint(signal: AbortSignal): Promise<string> {
    return this.extractor.fingerprint(signal);
  }

  async analyze(
    source: SourceBody,
    sourceName: string,
    transcript: TimedTranscript,
    context: ParseContext
  ): Promise<VideoVisualResult> {
    throwIfAborted(context.signal);
    const directory = await mkdtemp(join(tmpdir(), "t-wiki-video-"));
    const extension = safeExtension(sourceName);
    const sourcePath = join(directory, `source${extension}`);
    try {
      context.reportProgress({ phase: "reading-media-info", mode: "indeterminate", message: "正在读取视频信息" });
      await copySourceBody(source, sourcePath, context.signal);
      const fileBody = fileSourceBody(sourcePath, source.size);
      const metadata = await this.extractor.probe(fileBody, context.signal);
      const candidateLimit = densityLimit(
        metadata.durationMs,
        this.options.candidatesPerHour,
        12,
        this.options.maxCandidates
      );
      context.reportProgress({
        phase: "extracting-frames",
        completed: 0,
        total: Math.ceil(metadata.durationMs / 1000),
        unit: "second",
        message: "正在提取场景候选帧"
      });
      const candidates = await this.extractor.extract(sourcePath, {
        workingDirectory: directory,
        sceneThreshold: this.options.sceneThreshold,
        maxCandidates: candidateLimit,
        maxWidth: this.options.maxWidth,
        imageFormat: this.options.imageFormat,
        imageQuality: this.options.imageQuality
      }, context);
      if (candidates.length === 0) {
        return {
          metadata,
          frames: [],
          assets: [],
          issues: [{ code: "VIDEO_VISUAL_SKIPPED", severity: "warning", message: "未提取到可供视觉判断的候选画面" }]
        };
      }
      context.reportProgress({ phase: "filtering-frames", completed: candidates.length, total: candidates.length, unit: "item", message: `本地筛选完成：${candidates.length} 张候选画面` });
      const assessments = [];
      for (let offset = 0; offset < candidates.length; offset += this.options.vision.batchSize) {
        throwIfAborted(context.signal);
        const batch = candidates.slice(offset, offset + this.options.vision.batchSize);
        const inputs = await Promise.all(batch.map((candidate) => visionInput(candidate, transcript)));
        context.reportProgress({
          phase: "visual-analysis",
          completed: offset,
          total: candidates.length,
          unit: "item",
          message: `正在判断关键画面（${Math.min(offset + batch.length, candidates.length)}/${candidates.length}）`
        });
        assessments.push(...await this.provider.assess(inputs, context));
      }
      const selectedLimit = densityLimit(
        metadata.durationMs,
        this.options.selectedPerHour,
        1,
        this.options.maxSelectedFrames
      );
      const selected = selectFrames(candidates, assessments, {
        confidenceThreshold: this.options.confidenceThreshold,
        minimumGapMs: this.options.minFrameGapSeconds * 1000,
        limit: selectedLimit
      });
      const assets = [];
      const frames: SelectedVideoFrame[] = [];
      let totalBytes = 0;
      for (const item of selected) {
        throwIfAborted(context.signal);
        const bytes = new Uint8Array(await readFile(item.candidate.imagePath));
        if (bytes.byteLength === 0 || bytes.byteLength > 8 * 1024 * 1024) {
          throw new ParserError("VIDEO_FRAME_ASSET_INVALID", `关键画面 ${item.candidate.frameId} 大小无效`);
        }
        totalBytes += bytes.byteLength;
        if (totalBytes > this.options.maxAssetBytes) {
          throw new ParserError("VIDEO_FRAME_ASSET_LIMIT", "关键画面总大小超过配置上限");
        }
        assets.push({
          assetId: item.candidate.frameId,
          mime: item.candidate.mime,
          bytes,
          source: { startMs: item.candidate.timestampMs, endMs: item.candidate.timestampMs }
        });
        frames.push({
          ...item.assessment,
          timestampMs: item.candidate.timestampMs,
          assetId: item.candidate.frameId
        });
      }
      return { metadata, frames, assets, issues: [] };
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export function densityLimit(durationMs: number, perHour: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.ceil(durationMs / 3_600_000 * perHour)));
}

export function selectFrames(
  candidates: VideoFrameCandidate[],
  assessments: import("./video-visual-types").VideoFrameAssessment[],
  options: { confidenceThreshold: number; minimumGapMs: number; limit: number }
): Array<{ candidate: VideoFrameCandidate; assessment: import("./video-visual-types").VideoFrameAssessment }> {
  const candidatesById = new Map(candidates.map((candidate) => [candidate.frameId, candidate]));
  const ranked = assessments.flatMap((assessment) => {
    const candidate = candidatesById.get(assessment.frameId);
    return candidate
      && assessment.valuable
      && assessment.category !== "talking_head"
      && assessment.confidence >= options.confidenceThreshold
      ? [{ candidate, assessment }]
      : [];
  }).sort((left, right) => right.assessment.confidence - left.assessment.confidence
    || left.candidate.timestampMs - right.candidate.timestampMs);
  const selected: typeof ranked = [];
  for (const item of ranked) {
    if (selected.some((current) => Math.abs(current.candidate.timestampMs - item.candidate.timestampMs) < options.minimumGapMs)) continue;
    selected.push(item);
    if (selected.length >= options.limit) break;
  }
  return selected.sort((left, right) => left.candidate.timestampMs - right.candidate.timestampMs);
}

async function visionInput(candidate: VideoFrameCandidate, transcript: TimedTranscript): Promise<VisionFrameInput> {
  return {
    frameId: candidate.frameId,
    timestampMs: candidate.timestampMs,
    thumbnailBytes: new Uint8Array(await readFile(candidate.thumbnailPath)),
    mime: candidate.mime,
    transcriptWindow: transcriptWindow(transcript, candidate.timestampMs)
  };
}

function transcriptWindow(transcript: TimedTranscript, timestampMs: number): string {
  const start = timestampMs - 30_000;
  const end = timestampMs + 30_000;
  const selected = transcript.segments.filter((segment) => {
    if (segment.startMs === undefined) return false;
    return (segment.endMs ?? segment.startMs) >= start && segment.startMs <= end;
  });
  return selected.map((segment) => segment.text.trim()).filter(Boolean).join(" ").slice(0, 6000);
}

async function copySourceBody(source: SourceBody, path: string, signal: AbortSignal): Promise<void> {
  const handle = await open(path, "wx");
  try {
    for await (const chunk of source.openStream()) {
      throwIfAborted(signal);
      await handle.write(chunk);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function fileSourceBody(path: string, size?: number): SourceBody {
  return {
    size,
    async readHead(maxBytes) {
      const handle = await open(path, "r");
      try {
        const bytes = new Uint8Array(maxBytes);
        const result = await handle.read(bytes, 0, maxBytes, 0);
        return bytes.slice(0, result.bytesRead);
      } finally { await handle.close(); }
    },
    async readAll(maxBytes) {
      const bytes = new Uint8Array(await readFile(path));
      if (bytes.byteLength > maxBytes) throw new ParserError("FILE_TOO_LARGE", `Source exceeds ${maxBytes} bytes`);
      return bytes;
    },
    async *openStream() {
      const handle = await open(path, "r");
      try {
        const chunk = new Uint8Array(1024 * 1024);
        let position = 0;
        while (true) {
          const result = await handle.read(chunk, 0, chunk.byteLength, position);
          if (result.bytesRead === 0) break;
          position += result.bytesRead;
          yield chunk.slice(0, result.bytesRead);
        }
      } finally { await handle.close(); }
    }
  };
}

function safeExtension(name: string): string {
  const extension = extname(name).toLocaleLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : ".media";
}
