import type { ParseContext, SourceBody } from "../parser-types";
import type { ParseIssue } from "../../types";
import type { VideoVisualOptions } from "./video-visual-types";

export interface TimedTranscriptSegment {
  startMs?: number;
  endMs?: number;
  text: string;
  speaker?: string;
  confidence?: number;
}

export interface TimedTranscript {
  schemaVersion: 1;
  language?: string;
  durationMs?: number;
  segments: TimedTranscriptSegment[];
  provider: string;
  model?: string;
  generated: boolean;
  timePrecision?: "segment" | "chunk" | "none";
  issues: ParseIssue[];
}

export type TranscriptionProtocol = "openai-transcriptions" | "whisper-asr-webservice";
export type TimestampUnit = "auto" | "seconds" | "milliseconds";

export interface MediaPreprocessingOptions {
  enabled: boolean;
  ffmpegPath: string;
  chunkDurationSeconds: number;
  overlapSeconds: number;
  audioBitrateKbps: number;
  sampleRateHz: number;
  channels: number;
  resumeRetentionHours: number;
}

export interface MediaMetadata {
  name: string;
  mime: string;
  size: number;
  durationMs?: number;
  allowEmpty?: boolean;
}

export interface MediaTranscriptionOptions {
  protocol: TranscriptionProtocol;
  baseUrl: string;
  model: string;
  language?: string;
  responseFormat?: string;
  vadFilter: boolean;
  wordTimestamps: boolean;
  diarization: boolean;
  maxUploadBytes: number;
  taskTimeoutMs: number;
  timestampUnit?: TimestampUnit;
  preprocessing?: MediaPreprocessingOptions;
  visual?: VideoVisualOptions;
}

export interface TranscriptionTransport {
  readonly protocol: TranscriptionProtocol;
  testConnection(signal: AbortSignal): Promise<{ ok: boolean; message: string }>;
  transcribe(
    source: SourceBody,
    metadata: MediaMetadata,
    context: ParseContext
  ): Promise<TimedTranscript>;
}

export interface BilibiliCaptionPackage {
  schemaVersion: 1;
  bvid: string;
  cid: string;
  page: number;
  title: string;
  partTitle: string;
  author: string;
  description?: string;
  language: string;
  trackKind: "author" | "ai" | "unknown";
  durationMs?: number;
  segments: TimedTranscriptSegment[];
}
