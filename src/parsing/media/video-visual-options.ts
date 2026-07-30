import { ParserError } from "../parser-types";
import type { VideoVisualOptions } from "./video-visual-types";

export const DEFAULT_VIDEO_VISUAL_OPTIONS: VideoVisualOptions = {
  enabled: false,
  ffmpegPath: "",
  sceneThreshold: 0.32,
  minFrameGapSeconds: 8,
  candidatesPerHour: 48,
  maxCandidates: 96,
  selectedPerHour: 16,
  maxSelectedFrames: 64,
  maxWidth: 1280,
  imageFormat: "webp",
  imageQuality: 82,
  confidenceThreshold: 0.75,
  maxAssetBytes: 32 * 1024 * 1024,
  vision: {
    protocol: "openai-chat-completions",
    baseUrl: "",
    model: "",
    batchSize: 12,
    timeoutMs: 120_000,
    maxRetries: 2,
    captionLanguage: "auto"
  }
};

export function parseVideoVisualOptions(value: unknown): VideoVisualOptions {
  const input = record(value);
  const vision = record(input.vision);
  const result: VideoVisualOptions = {
    enabled: input.enabled === true,
    ffmpegPath: string(input.ffmpegPath, ""),
    sceneThreshold: number(input.sceneThreshold, 0.32),
    minFrameGapSeconds: number(input.minFrameGapSeconds, 8),
    candidatesPerHour: integer(input.candidatesPerHour, 48),
    maxCandidates: integer(input.maxCandidates, 96),
    selectedPerHour: integer(input.selectedPerHour, 16),
    maxSelectedFrames: integer(input.maxSelectedFrames, 64),
    maxWidth: integer(input.maxWidth, 1280),
    imageFormat: "webp",
    imageQuality: integer(input.imageQuality, 82),
    confidenceThreshold: number(input.confidenceThreshold, 0.75),
    maxAssetBytes: integer(input.maxAssetBytes, 32 * 1024 * 1024),
    vision: {
      protocol: "openai-chat-completions",
      baseUrl: string(vision.baseUrl, ""),
      model: string(vision.model, ""),
      batchSize: integer(vision.batchSize, 12),
      timeoutMs: integer(vision.timeoutMs, 120_000),
      maxRetries: integer(vision.maxRetries, 2),
      captionLanguage: string(vision.captionLanguage, "auto")
    }
  };
  if (result.sceneThreshold <= 0 || result.sceneThreshold >= 1
    || result.minFrameGapSeconds < 0
    || result.candidatesPerHour < 1 || result.maxCandidates < 1
    || result.selectedPerHour < 1 || result.maxSelectedFrames < 1
    || result.maxWidth < 320 || result.maxWidth > 4096
    || result.imageQuality < 1 || result.imageQuality > 100
    || result.confidenceThreshold < 0 || result.confidenceThreshold > 1
    || result.maxAssetBytes < 1024
    || result.vision.batchSize < 1 || result.vision.batchSize > 12
    || result.vision.timeoutMs < 1000 || result.vision.maxRetries < 0 || result.vision.maxRetries > 5) {
    throw new ParserError("INVALID_VIDEO_VISUAL_OPTIONS", "关键画面配置超出允许范围");
  }
  return result;
}
export function assertVideoVisualReady(options: VideoVisualOptions): void {
  if (!options.enabled) return;
  if (!options.vision.baseUrl.trim() || !options.vision.model.trim()) {
    throw new ParserError("VIDEO_VISION_CONFIG_REQUIRED", "请配置关键画面视觉 Base URL 和模型");
  }
  validatedVisionUrl(options.vision.baseUrl);
}

export function validatedVisionUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); }
  catch { throw new ParserError("VIDEO_VISION_URL_INVALID", "视觉 Base URL 无效"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ParserError("VIDEO_VISION_URL_INVALID", "视觉 Base URL 只允许 HTTP/HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ParserError("VIDEO_VISION_URL_INVALID", "视觉 Base URL 不允许包含凭据、查询参数或 fragment");
  }
  if (url.protocol !== "https:" && !isLoopback(url.hostname)) {
    throw new ParserError("VIDEO_VISION_HTTPS_REQUIRED", "远程视觉服务必须使用 HTTPS");
  }
  return url;
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function number(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function integer(value: unknown, fallback: number): number {
  return Math.round(number(value, fallback));
}
