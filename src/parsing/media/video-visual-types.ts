import type { ParseContext, SourceBody } from "../parser-types";
import type { ParseIssue, ParsedAsset } from "../../types";
import type { TimedTranscript } from "./transcript-types";

export const VIDEO_FRAME_CATEGORIES = [
  "slide", "diagram", "chart", "code", "ui", "document",
  "demonstration", "talking_head", "other"
] as const;

export type VideoFrameCategory = typeof VIDEO_FRAME_CATEGORIES[number];

export interface VideoMetadata {
  durationMs: number;
  width: number;
  height: number;
  videoCodec?: string;
  ffmpegVersion: string;
}

export interface FrameExtractionOptions {
  workingDirectory: string;
  sceneThreshold: number;
  maxCandidates: number;
  maxWidth: number;
  imageFormat: "webp";
  imageQuality: number;
}

export interface VideoFrameCandidate {
  frameId: string;
  timestampMs: number;
  imagePath: string;
  thumbnailPath: string;
  width?: number;
  height?: number;
  mime: "image/webp";
}

export interface VisionFrameInput {
  frameId: string;
  timestampMs: number;
  thumbnailBytes: Uint8Array;
  mime: "image/webp" | "image/png";
  transcriptWindow: string;
}

export interface VideoFrameAssessment {
  frameId: string;
  valuable: boolean;
  category: VideoFrameCategory;
  title: string;
  description: string;
  reason: string;
  confidence: number;
}

export interface VideoVisualOptions {
  enabled: boolean;
  ffmpegPath: string;
  sceneThreshold: number;
  minFrameGapSeconds: number;
  candidatesPerHour: number;
  maxCandidates: number;
  selectedPerHour: number;
  maxSelectedFrames: number;
  maxWidth: number;
  imageFormat: "webp";
  imageQuality: number;
  confidenceThreshold: number;
  maxAssetBytes: number;
  vision: {
    protocol: "openai-chat-completions";
    baseUrl: string;
    model: string;
    batchSize: number;
    timeoutMs: number;
    maxRetries: number;
    captionLanguage: string;
  };
}

export interface SelectedVideoFrame extends VideoFrameAssessment {
  timestampMs: number;
  assetId: string;
}

export interface VideoVisualResult {
  metadata: VideoMetadata;
  frames: SelectedVideoFrame[];
  assets: ParsedAsset[];
  issues: ParseIssue[];
}

export interface VideoFrameExtractor {
  probe(source: SourceBody, signal: AbortSignal): Promise<VideoMetadata>;
  extract(
    sourcePath: string,
    options: FrameExtractionOptions,
    context: ParseContext
  ): Promise<VideoFrameCandidate[]>;
  fingerprint(signal: AbortSignal): Promise<string>;
}

export interface FrameSelectionProvider {
  assess(frames: VisionFrameInput[], context: ParseContext): Promise<VideoFrameAssessment[]>;
  testConnection(signal: AbortSignal): Promise<{ ok: boolean; message: string }>;
}

export interface VideoVisualAnalyzer {
  analyze(
    source: SourceBody,
    sourceName: string,
    transcript: TimedTranscript,
    context: ParseContext
  ): Promise<VideoVisualResult>;
  fingerprint(signal: AbortSignal): Promise<string>;
}

export interface VisionCredentials {
  getToken(): Promise<string>;
}
