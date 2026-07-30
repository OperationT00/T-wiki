import { normalizeSocialVideoTitle } from "../../core/source-title";
import type { SourceMetadata } from "../../types";
import type { TimedTranscript } from "./transcript-types";

export interface TranscriptTitleRequest {
  originalTitle: string;
  description?: string;
  authorIdentity: string;
  transcript: TimedTranscript;
}

export interface GeneratedTranscriptTitle {
  summary: string;
  model?: string;
}

export interface TranscriptTitleGenerator {
  generate(input: TranscriptTitleRequest, signal: AbortSignal): Promise<GeneratedTranscriptTitle>;
  fingerprint?(): unknown;
}

export function resolveMediaAuthorIdentity(metadata: SourceMetadata | undefined): string {
  for (const key of ["author_id", "uploader_id", "author"] as const) {
    const value = metadata?.[key];
    const candidate = Array.isArray(value) ? value[0] : value;
    if (!candidate) continue;
    const normalized = normalizeSocialVideoTitle(candidate, "")
      .replace(/[\\/:*?"<>|#]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (normalized) return [...normalized].slice(0, 48).join("");
  }
  return "local";
}

export function composeMediaDocumentTitle(authorIdentity: string, contentTitle: string): string {
  const author = normalizeSocialVideoTitle(authorIdentity, "local")
    .replace(/[\\/:*?"<>|#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "local";
  let summary = sanitizeGeneratedContentTitle(contentTitle, "音视频文字稿");
  const authorPrefix = new RegExp(`^${escapeRegExp(author)}[\\s:：\\-–—|｜]+`, "iu");
  summary = summary.replace(authorPrefix, "").trim() || "音视频文字稿";
  return `${author}-${summary}`;
}

export function sanitizeGeneratedContentTitle(input: string, fallback: string): string {
  let title = normalizeSocialVideoTitle(input, "")
    .replace(/^(?:标题|内容简述|主题)\s*[:：]\s*/u, "")
    .replace(/^(?:本视频|这段视频|该视频|本音频|这段音频|该音频)(?:主要)?(?:介绍|讲解|讨论|讲述|分享)(?:了|的是)?/u, "")
    .replace(/[“”‘’"']/g, "")
    .replace(/[\\/:*?<>|#]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[\s\-–—|｜·,:：,，。.!！?？…_]+$/u, "")
    .trim();
  title = [...title].slice(0, 36).join("").trim();
  return title || normalizeSocialVideoTitle(fallback, "音视频文字稿");
}

export function representativeTranscript(transcript: TimedTranscript, maxChars = 8_000): string {
  const text = transcript.segments.map((segment) => segment.text.trim()).filter(Boolean).join("\n");
  if (text.length <= maxChars) return text;
  const firstLength = Math.floor(maxChars * 0.4);
  const middleLength = Math.floor(maxChars * 0.3);
  const lastLength = maxChars - firstLength - middleLength;
  const middleStart = Math.max(firstLength, Math.floor(text.length / 2 - middleLength / 2));
  return [
    `[开头]\n${text.slice(0, firstLength)}`,
    `[中段]\n${text.slice(middleStart, middleStart + middleLength)}`,
    `[结尾]\n${text.slice(-lastLength)}`
  ].join("\n\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
