import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";

import type { ParseIssue } from "../../types";
import { ParserError, parseInputSize, parseInputSource, throwIfAborted, type ParseContext, type ParseInput, type SourceBody } from "../parser-types";
import type { MediaJobCheckpoint, MediaJobStorePort, MediaResumeToken } from "./media-job";
import { MediaPreprocessor, parseMediaResumeToken, resumeToken } from "./media-preprocessor";
import type { MediaTranscriptionOptions, TimedTranscript, TimedTranscriptSegment, TranscriptionTransport } from "./transcript-types";

export interface CoordinatedTranscript {
  transcript: TimedTranscript;
  jobId?: string;
  warnings: ParseIssue[];
  chunkCount: number;
  emptyChunkCount: number;
}

export class ChunkedTranscriptionCoordinator {
  constructor(
    private readonly jobs?: MediaJobStorePort,
    private readonly preprocessor = jobs ? new MediaPreprocessor(jobs) : undefined
  ) {}

  async transcribe(
    input: ParseInput,
    transport: TranscriptionTransport,
    options: MediaTranscriptionOptions,
    context: ParseContext,
    serializedResumeToken?: string
  ): Promise<CoordinatedTranscript> {
    const preprocessing = options.preprocessing;
    if (!preprocessing?.enabled || !this.jobs || !this.preprocessor) {
      return this.direct(input, transport, context, []);
    }
    let checkpoint: MediaJobCheckpoint;
    try {
      checkpoint = serializedResumeToken
        ? await this.resumeCheckpoint(input, context, parseMediaResumeToken(serializedResumeToken))
        : await this.preprocessor.prepare(input, preprocessing, context);
    } catch (error) {
      if (!isPreprocessorUnavailable(error)) throw error;
      if (!canDirectUpload(input, options.maxUploadBytes)) {
        throw new ParserError(
          "MEDIA_PREPROCESSOR_REQUIRED",
          "该媒体无法安全整文件上传；请安装并配置 FFmpeg 后重试",
          true
        );
      }
      return this.direct(input, transport, context, [{
        code: "MEDIA_PREPROCESSING_SKIPPED",
        severity: "warning",
        message: `FFmpeg 预处理不可用，已回退为整文件上传：${safeError(error)}`
      }]);
    }
    for (const chunk of checkpoint.chunks) {
      throwIfAborted(context.signal);
      if (chunk.status !== "pending") continue;
      const actual = await stat(chunk.path);
      if (actual.size !== chunk.size || await hashFile(chunk.path) !== chunk.hash) {
        throw new ParserError("TRANSCRIPTION_RESUME_INVALID", `音频分片 ${chunk.index + 1} 完整性校验失败`);
      }
      const chunkContext: ParseContext = {
        ...context,
        reportProgress: (progress) => {
          const transfer = progress.unit === "byte" && progress.completed !== undefined
            ? ` · ${formatBytes(progress.completed)}${progress.total ? `/${formatBytes(progress.total)}` : ""}`
            : "";
          const retry = progress.message?.includes("重试") ? ` · ${progress.message}` : "";
          context.reportProgress({
            ...progress,
            phase: progress.phase === "uploading" ? "uploading-chunk" : "transcribing-chunk",
            completed: chunk.index,
            total: checkpoint.chunks.length,
            unit: "item",
            message: progress.phase === "uploading"
              ? `正在上传分片 ${chunk.index + 1}/${checkpoint.chunks.length}${transfer}${retry}`
              : `正在转写分片 ${chunk.index + 1}/${checkpoint.chunks.length}${retry}`
          });
        }
      };
      const result = await transport.transcribe(fileBody(chunk.path, chunk.size), {
        name: `chunk-${String(chunk.index).padStart(5, "0")}.mp3`,
        mime: "audio/mpeg",
        size: chunk.size,
        durationMs: chunk.endMs - chunk.startMs,
        allowEmpty: true
      }, chunkContext);
      chunk.status = result.segments.length === 0 ? "empty" : "completed";
      chunk.resultPath = await this.jobs.saveResult(checkpoint.jobId, chunk.index, result);
      chunk.resultHash = await hashFile(chunk.resultPath);
      checkpoint.expiresAt = new Date(Date.now() + preprocessing.resumeRetentionHours * 3_600_000).toISOString();
      await this.jobs.save(checkpoint);
      await context.saveResumeToken(JSON.stringify(resumeToken(checkpoint)));
      context.reportProgress({
        phase: "transcribing-chunk",
        completed: chunk.index + 1,
        total: checkpoint.chunks.length,
        unit: "item",
        message: `已完成分片 ${chunk.index + 1}/${checkpoint.chunks.length} · 分片缓存 ${formatBytes(jobSize(checkpoint))} · 可断点恢复`
      });
    }
    if (checkpoint.chunks.some((chunk) => chunk.status === "pending" || !chunk.resultPath)) {
      throw new ParserError("TRANSCRIPTION_COVERAGE_INCOMPLETE", "仍有音频分片未完成，禁止发布不完整文字稿", true);
    }
    context.reportProgress({ phase: "merging-transcript", completed: 0, total: 1, unit: "document", message: "正在合并分片时间轴" });
    const results = await Promise.all(checkpoint.chunks.map(async (chunk) => {
      if (!chunk.resultHash || await hashFile(chunk.resultPath!) !== chunk.resultHash) {
        throw new ParserError("TRANSCRIPTION_RESULT_HASH_MISMATCH", `分片 ${chunk.index + 1} 的转写缓存 Hash 不一致`);
      }
      return this.jobs!.readResult(chunk.resultPath!);
    }));
    const transcript = mergeChunkTranscripts(checkpoint, results);
    const emptyChunkCount = checkpoint.chunks.filter((chunk) => chunk.status === "empty").length;
    if (transcript.segments.length === 0) throw new ParserError("EMPTY_TRANSCRIPT", "全部音频分片均未识别到文字");
    const warnings: ParseIssue[] = emptyChunkCount > 0 ? [{
      code: "TRANSCRIPT_EMPTY_CHUNKS",
      severity: "warning",
      message: `${emptyChunkCount} 个音频分片未识别到语音，请确认媒体内容完整性`
    }] : [];
    return { transcript, jobId: checkpoint.jobId, warnings, chunkCount: checkpoint.chunks.length, emptyChunkCount };
  }

  async cleanup(jobId: string | undefined): Promise<void> {
    if (jobId && this.jobs) await this.jobs.cleanup(jobId);
  }

  private async resumeCheckpoint(input: ParseInput, context: ParseContext, token: MediaResumeToken): Promise<MediaJobCheckpoint> {
    if (!this.jobs) throw new ParserError("TRANSCRIPTION_RESUME_INVALID", "媒体任务存储不可用");
    const parseKey = context.parseKey ?? input.sourceHash;
    if (token.sourceHash !== input.sourceHash || token.parseKey !== parseKey) {
      throw new ParserError("TRANSCRIPTION_RESUME_INVALID", "媒体断点与当前原件或解析配置不匹配");
    }
    const checkpoint = await this.jobs.load(token.jobId);
    if (checkpoint.sourceId !== input.sourceId || checkpoint.sourceHash !== input.sourceHash
      || checkpoint.parseKey !== parseKey || Date.parse(checkpoint.expiresAt) <= Date.now()) {
      throw new ParserError("MEDIA_JOB_EXPIRED", "媒体断点任务已过期或与当前来源不匹配");
    }
    return checkpoint;
  }

  private async direct(
    input: ParseInput,
    transport: TranscriptionTransport,
    context: ParseContext,
    warnings: ParseIssue[]
  ): Promise<CoordinatedTranscript> {
    const transcript = await transport.transcribe(parseInputSource(input), {
      name: input.name,
      mime: input.mime,
      size: parseInputSize(input)
    }, context);
    return { transcript, warnings, chunkCount: 1, emptyChunkCount: 0 };
  }
}

export function mergeChunkTranscripts(checkpoint: MediaJobCheckpoint, transcripts: TimedTranscript[]): TimedTranscript {
  const output: TimedTranscriptSegment[] = [];
  let precision: TimedTranscript["timePrecision"] = "segment";
  const issues = transcripts.flatMap((item) => item.issues);
  for (let index = 0; index < transcripts.length; index += 1) {
    const chunk = checkpoint.chunks[index]!;
    const transcript = transcripts[index]!;
    if (transcript.segments.length === 0) continue;
    const hasTimes = transcript.segments.some((segment) => segment.startMs !== undefined);
    if (!hasTimes) precision = precision === "segment" ? "chunk" : precision;
    for (const [segmentIndex, segment] of transcript.segments.entries()) {
      const adjusted: TimedTranscriptSegment = hasTimes
        ? {
          ...segment,
          startMs: segment.startMs === undefined ? undefined : chunk.startMs + segment.startMs,
          endMs: segment.endMs === undefined ? undefined : chunk.startMs + segment.endMs
        }
        : {
          ...segment,
          startMs: segmentIndex === 0 ? chunk.startMs + chunk.overlapMs : undefined,
          endMs: segmentIndex === transcript.segments.length - 1 ? chunk.endMs : undefined
        };
      if (adjusted.startMs !== undefined && adjusted.startMs > checkpoint.durationMs + 1000) {
        throw new ParserError("TRANSCRIPTION_TIMELINE_OUT_OF_RANGE", "转写时间戳超出媒体时长");
      }
      appendDeduplicated(output, adjusted);
    }
  }
  return {
    schemaVersion: 1,
    language: transcripts.find((item) => item.language)?.language,
    durationMs: checkpoint.durationMs,
    segments: output,
    provider: transcripts[0]?.provider ?? "unknown",
    model: transcripts[0]?.model,
    generated: true,
    timePrecision: output.length === 0 ? "none" : precision,
    issues: [
      ...issues.filter((issue) => issue.code !== "TRANSCRIPT_TIMESTAMPS_MISSING"),
      ...(precision === "chunk" ? [{
        code: "TRANSCRIPT_TIMESTAMPS_APPROXIMATE",
        severity: "warning" as const,
        message: "服务未返回句级时间戳，当前时间位置按音频分片近似标注"
      }] : [])
    ]
  };
}

function appendDeduplicated(output: TimedTranscriptSegment[], next: TimedTranscriptSegment): void {
  const previous = output.at(-1);
  if (!previous) { output.push(next); return; }
  const overlap = commonBoundary(previous.text, next.text);
  if (overlap >= 8) next = { ...next, text: next.text.slice(overlap).trimStart() };
  if (!next.text.trim()) return;
  output.push(next);
}

function commonBoundary(left: string, right: string): number {
  const maximum = Math.min(160, left.length, right.length);
  for (let length = maximum; length >= 8; length -= 1) {
    if (normalize(left.slice(-length)) === normalize(right.slice(0, length))) return length;
  }
  return 0;
}

function normalize(value: string): string { return value.replace(/[\s，。！？、,.!?]/g, "").toLowerCase(); }

function canDirectUpload(input: ParseInput, limit: number): boolean {
  const size = parseInputSize(input);
  return size <= limit && /^(?:audio\/(?:mpeg|mp4|wav|webm|ogg)|video\/(?:mp4|mpeg|webm))$/i.test(input.mime);
}

function isPreprocessorUnavailable(error: unknown): boolean {
  return error instanceof ParserError && ["FFMPEG_NOT_AVAILABLE", "MEDIA_PREPROCESSOR_REQUIRED", "FFMPEG_PATH_INVALID"].includes(error.code);
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " ").slice(0, 300);
}

function fileBody(path: string, size: number): SourceBody {
  return {
    size,
    async readHead(maxBytes) {
      const handle = await open(path, "r");
      try {
        const bytes = new Uint8Array(Math.min(size, maxBytes));
        const result = await handle.read(bytes, 0, bytes.length, 0);
        return bytes.slice(0, result.bytesRead);
      } finally { await handle.close(); }
    },
    async readAll(maxBytes) {
      if (size > maxBytes) throw new ParserError("FILE_TOO_LARGE", `Source exceeds ${maxBytes} bytes`);
      return new Uint8Array(await readFile(path));
    },
    async *openStream() {
      for await (const chunk of createReadStream(path)) yield new Uint8Array(chunk as Buffer);
    }
  };
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function jobSize(checkpoint: MediaJobCheckpoint): number {
  return checkpoint.chunks.reduce((sum, chunk) => sum + chunk.size, 0);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}
