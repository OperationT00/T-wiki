import type { ParseIssue, SourceMetadata } from "../../types";
import { ParserError } from "../parser-types";
import type { TimedTranscript, TimedTranscriptSegment } from "./transcript-types";
import type { SelectedVideoFrame } from "./video-visual-types";

export interface TranscriptMarkdownOptions {
  title?: string;
  sourceUri?: string;
  bilibiliBvid?: string;
  bilibiliPage?: number;
  author?: string;
  platform?: string;
  trackKind?: string;
  visualFrames?: SelectedVideoFrame[];
  visualMetadata?: {
    extractor: string;
    ffmpegVersion: string;
    model: string;
  };
}

export interface TranscriptMarkdownResult {
  markdown: string;
  metadata: SourceMetadata;
  issues: ParseIssue[];
}

export class TranscriptMarkdownBuilder {
  build(transcript: TimedTranscript, options: TranscriptMarkdownOptions = {}): TranscriptMarkdownResult {
    const normalized = normalizeSegments(transcript.segments);
    if (normalized.length === 0) throw new ParserError("EMPTY_TRANSCRIPT", "转写结果为空");
    assertTimeline(normalized, transcript.durationMs);
    const paragraphs = aggregateSegments(normalized);
    const frameGroups = alignFrames(paragraphs, options.visualFrames ?? []);
    const hasTimeline = paragraphs.some((paragraph) => paragraph.startMs !== undefined);
    const transcriptContent = hasTimeline
      ? paragraphs.flatMap((paragraph, index) => [
        renderTime(paragraph.startMs, options),
        "",
        paragraph.text,
        "",
        ...renderFrames(frameGroups.byParagraph.get(index) ?? [])
      ])
      : [
        "> 转写服务未返回精确时间戳，以下文字已按语句自动分段。",
        "",
        ...paragraphs.flatMap((paragraph) => [paragraph.text, ""])
      ];
    const precisionNotice = transcript.timePrecision === "chunk"
      ? ["> 时间位置由音频分片近似推算，不代表句级精确时间戳。", ""]
      : [];
    const appendix = frameGroups.unaligned.length > 0
      ? ["## 关键画面", "", ...frameGroups.unaligned.flatMap(renderFrame)]
      : [];
    const markdown = [
      options.title ? `# ${options.title.trim()}` : "# 文字稿",
      "",
      "## 文字稿",
      "",
      ...precisionNotice,
      ...transcriptContent,
      ...appendix
    ].join("\n").trimEnd() + "\n";
    const issues = [...transcript.issues];
    if (normalized.every((item) => item.startMs === undefined)
      && !issues.some((issue) => issue.code === "TRANSCRIPT_TIMESTAMPS_MISSING")) {
      issues.push({ code: "TRANSCRIPT_TIMESTAMPS_MISSING", severity: "warning", message: "转写服务未返回时间戳" });
    }
    if ((options.visualFrames?.length ?? 0) > 0 && !frameGroups.hasTimeline) {
      issues.push({ code: "VISUAL_ALIGNMENT_UNAVAILABLE", severity: "warning", message: "文字稿缺少可用时间戳，关键画面已集中放到文末" });
    }
    if (markdown.length < 160) {
      issues.push({ code: "TRANSCRIPT_SHORT", severity: "warning", message: "文字稿较短，请在 Ingest 前确认内容完整" });
    }
    const confidences = normalized.flatMap((item) => item.confidence === undefined ? [] : [item.confidence]);
    if (confidences.length > 0
      && confidences.reduce((sum, value) => sum + value, 0) / confidences.length < 0.5) {
      issues.push({ code: "TRANSCRIPT_LOW_CONFIDENCE", severity: "warning", message: "转写服务返回的平均置信度较低" });
    }
    const unique = new Set(normalized.map((item) => item.text)).size;
    if (normalized.length >= 10 && unique / normalized.length < 0.7) {
      issues.push({ code: "TRANSCRIPT_REPETITION_HIGH", severity: "warning", message: "文字稿包含较多重复片段" });
    }
    return {
      markdown,
      metadata: compact({
        title: options.title,
        author: options.author,
        url: options.sourceUri,
        source_platform: options.platform,
        bilibili_bvid: options.bilibiliBvid,
        transcript_language: transcript.language,
        transcript_kind: options.trackKind,
        transcript_provider: transcript.provider,
        transcript_model: transcript.model,
        transcript_generated: String(transcript.generated),
        transcript_time_precision: transcript.timePrecision ?? (hasTimeline ? "segment" : "none"),
        duration_ms: transcript.durationMs === undefined ? undefined : String(transcript.durationMs),
        visual_extractor: options.visualMetadata?.extractor,
        ffmpeg_version: options.visualMetadata?.ffmpegVersion,
        visual_model: options.visualMetadata?.model,
        visual_frame_count: options.visualFrames ? String(options.visualFrames.length) : undefined
      }),
      issues
    };
  }
}

interface Paragraph { startMs?: number; endMs?: number; text: string; speaker?: string }

function alignFrames(
  paragraphs: Paragraph[],
  frames: SelectedVideoFrame[]
): { byParagraph: Map<number, SelectedVideoFrame[]>; unaligned: SelectedVideoFrame[]; hasTimeline: boolean } {
  const byParagraph = new Map<number, SelectedVideoFrame[]>();
  const timed = paragraphs.flatMap((paragraph, index) => paragraph.startMs === undefined
    ? []
    : [{ paragraph, index }]);
  if (timed.length === 0) return { byParagraph, unaligned: [...frames], hasTimeline: false };
  for (const frame of frames) {
    const closest = [...timed].sort((left, right) => distanceToParagraph(frame.timestampMs, left.paragraph)
      - distanceToParagraph(frame.timestampMs, right.paragraph))[0];
    if (!closest) continue;
    const group = byParagraph.get(closest.index) ?? [];
    if (group.length < 2) {
      group.push(frame);
      byParagraph.set(closest.index, group);
    }
  }
  const alignedIds = new Set([...byParagraph.values()].flat().map((frame) => frame.assetId));
  return { byParagraph, unaligned: frames.filter((frame) => !alignedIds.has(frame.assetId)), hasTimeline: true };
}

function distanceToParagraph(timestampMs: number, paragraph: Paragraph): number {
  const start = paragraph.startMs ?? timestampMs;
  const end = paragraph.endMs ?? start;
  if (timestampMs >= start && timestampMs <= end) return 0;
  return Math.min(Math.abs(timestampMs - start), Math.abs(timestampMs - end));
}

function renderFrames(frames: SelectedVideoFrame[]): string[] {
  return frames.flatMap(renderFrame);
}

function renderFrame(frame: SelectedVideoFrame): string[] {
  const title = escapeAlt(frame.title || "视频关键画面");
  const description = frame.description.replace(/[\r\n]+/g, " ").trim() || "画面内容由视觉模型客观描述。";
  return [
    `![${title}](llm-wiki-asset:${frame.assetId})`,
    "",
    `> 关键画面：${description}`,
    `> 视频位置：${formatTime(Math.floor(frame.timestampMs / 1000))}`,
    ""
  ];
}

function escapeAlt(value: string): string {
  return value.replace(/[[\]\r\n]/g, " ").trim().slice(0, 160);
}

function normalizeSegments(input: TimedTranscriptSegment[]): TimedTranscriptSegment[] {
  return input.flatMap((segment) => {
    const text = segment.text.replace(/\s+/g, " ").trim();
    if (!text) return [];
    if (segment.startMs !== undefined || segment.endMs !== undefined || text.length <= 480) {
      return [{ ...segment, text }];
    }
    return paragraphizeUntimedText(text).map((paragraph) => ({
      ...segment,
      text: paragraph
    }));
  });
}

/**
 * Turns a provider's single untimed transcript into readable paragraphs without
 * changing wording or inventing timestamps/headings. Boundaries are stable so
 * identical provider output produces identical canonical Markdown.
 */
export function paragraphizeUntimedText(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const units = splitSentenceUnits(normalized).flatMap(splitLongUnit);
  const paragraphs: string[] = [];
  let current = "";
  for (const unit of units) {
    const combined = joinText(current, unit);
    if (current && combined.length > 480) {
      paragraphs.push(current);
      current = unit;
      continue;
    }
    current = combined;
    if (current.length >= 260 && isSentenceEnding(current)) {
      paragraphs.push(current);
      current = "";
    }
  }
  if (current) paragraphs.push(current);
  return paragraphs;
}

function splitSentenceUnits(text: string): string[] {
  const units: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (!/[。！？!?；;]/u.test(text[index]!)) continue;
    let end = index + 1;
    while (end < text.length && /[”’」』】)\]]/u.test(text[end]!)) end += 1;
    const unit = text.slice(start, end).trim();
    if (unit) units.push(unit);
    start = end;
    index = end - 1;
  }
  const tail = text.slice(start).trim();
  if (tail) units.push(tail);
  return units.length > 0 ? units : [text];
}

function splitLongUnit(text: string): string[] {
  if (text.length <= 480) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 480) {
    const window = remaining.slice(0, 480);
    const candidates = [window.lastIndexOf("，"), window.lastIndexOf(","), window.lastIndexOf("、"), window.lastIndexOf(" ")];
    const preferred = Math.max(...candidates.filter((index) => index >= 180));
    const splitAt = preferred >= 180 ? preferred + 1 : 480;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function joinText(left: string, right: string): string {
  if (!left) return right;
  return `${left}${needsSpace(left, right) ? " " : ""}${right}`;
}

function isSentenceEnding(text: string): boolean {
  return /[。！？!?；;][”’」』】)\]]?$/u.test(text);
}

function assertTimeline(segments: TimedTranscriptSegment[], durationMs: number | undefined): void {
  let previous = -1;
  for (const segment of segments) {
    if (segment.text.includes("\uFFFD")) throw new ParserError("TRANSCRIPT_ENCODING_INVALID", "文字稿包含乱码替换字符");
    if (segment.startMs !== undefined) {
      if (!Number.isFinite(segment.startMs) || segment.startMs < previous) {
        throw new ParserError("TRANSCRIPT_TIMELINE_INVALID", "文字稿时间戳不是单调递增");
      }
      previous = segment.startMs;
    }
    if (segment.endMs !== undefined && segment.startMs !== undefined && segment.endMs < segment.startMs) {
      throw new ParserError("TRANSCRIPT_TIMELINE_INVALID", "文字稿结束时间早于开始时间");
    }
    if (durationMs !== undefined
      && ((segment.startMs ?? 0) > durationMs + 1000 || (segment.endMs ?? 0) > durationMs + 1000)) {
      throw new ParserError("TRANSCRIPTION_TIMELINE_OUT_OF_RANGE", "文字稿时间戳超出媒体时长");
    }
  }
}

function aggregateSegments(segments: TimedTranscriptSegment[]): Paragraph[] {
  const output: Paragraph[] = [];
  let current: Paragraph | undefined;
  for (const segment of segments) {
    const gap = current?.endMs !== undefined && segment.startMs !== undefined
      ? segment.startMs - current.endMs
      : 0;
    const duration = current?.startMs !== undefined && segment.endMs !== undefined
      ? segment.endMs - current.startMs
      : 0;
    const speakerChanged = Boolean(current?.speaker && segment.speaker && current.speaker !== segment.speaker);
    const shouldBreak = Boolean(current) && (
      gap > 3000
      || duration > 45_000
      || current!.text.length + segment.text.length > 600
      || (current!.text.length >= 160 && /[。！？.!?][”’」』】)]?$/.test(current!.text))
      || speakerChanged
    );
    if (!current || shouldBreak) {
      current = { startMs: segment.startMs, endMs: segment.endMs, text: segment.text, speaker: segment.speaker };
      output.push(current);
    } else {
      current.text += `${needsSpace(current.text, segment.text) ? " " : ""}${segment.text}`;
      current.endMs = segment.endMs ?? current.endMs;
    }
  }
  return output.map((item) => ({
    ...item,
    text: item.speaker ? `**${item.speaker}：** ${item.text}` : item.text
  }));
}

function needsSpace(left: string, right: string): boolean {
  return /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right);
}

function renderTime(startMs: number | undefined, options: TranscriptMarkdownOptions): string {
  if (startMs === undefined) return "**[无时间戳]**";
  const seconds = Math.max(0, Math.floor(startMs / 1000));
  const label = formatTime(seconds);
  if (options.bilibiliBvid) {
    const page = options.bilibiliPage && options.bilibiliPage > 1 ? `p=${options.bilibiliPage}&` : "";
    return `**[${label}](https://www.bilibili.com/video/${options.bilibiliBvid}?${page}t=${seconds})**`;
  }
  return `**[${label}]**`;
}

function formatTime(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

function compact(input: SourceMetadata): SourceMetadata {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== ""));
}
