import { normalizeSocialVideoTitle } from "../core/source-title";
import { ParserError } from "../parsing/parser-types";
import type { SourceManifest } from "../types";
import { replaceUnsafeFilenameCharacters, stripUnsafeControlCharacters } from "../utils/text-safety";
import type { SourceConnector, SourceConnectorContext } from "./source-connector";
import {
  SpawnYtDlpAdapter,
  type CookieBrowser,
  type OnlineVideoMetadata,
  type YtDlpDownloadProgress,
  type YtDlpInfo,
  type YtDlpPort,
  type YtDlpRuntimeOptions
} from "./yt-dlp";

const DOUYIN_HOSTS = new Set([
  "douyin.com",
  "www.douyin.com",
  "v.douyin.com",
  "iesdouyin.com",
  "www.iesdouyin.com"
]);

export type DouyinCapturePhase =
  | "resolving"
  | "metadata"
  | "downloading"
  | "storing"
  | "uploading"
  | "transcribing"
  | "reading-media-info"
  | "extracting-frames"
  | "filtering-frames"
  | "visual-analysis"
  | "building-markdown"
  | "quality-check"
  | "publishing"
  | "verifying"
  | "complete";

export interface DouyinCaptureOptions {
  enabled: boolean;
  ytDlpPath: string;
  maxDownloadBytes: number;
  taskTimeoutMs: number;
  cookieBrowser?: CookieBrowser;
  ffmpegPath?: string;
  useBrowserCookies?: boolean;
}

export interface DouyinCaptureRequest {
  url: string;
  options: DouyinCaptureOptions;
  signal?: AbortSignal;
  reportProgress?(
    phase: DouyinCapturePhase,
    progress?: YtDlpDownloadProgress
  ): void;
}

export interface DouyinCaptureResult {
  manifest: SourceManifest;
  duplicate: boolean;
  metadata: OnlineVideoMetadata;
  requestedUrl: string;
  finalUrl: string;
}

type YtDlpFactory = (options: YtDlpRuntimeOptions) => YtDlpPort;

export class DouyinVideoConnector implements SourceConnector {
  readonly id = "douyin-video";
  private context?: SourceConnectorContext;
  private readonly activeCaptures = new Set<AbortController>();

  constructor(
    private readonly createYtDlp: YtDlpFactory = (options) => new SpawnYtDlpAdapter(options)
  ) {}

  async start(context: SourceConnectorContext): Promise<void> {
    this.context = context;
  }

  async stop(): Promise<void> {
    for (const controller of this.activeCaptures) controller.abort();
    this.activeCaptures.clear();
    this.context = undefined;
  }

  async testInstallation(
    options: Omit<DouyinCaptureOptions, "useBrowserCookies">,
    signal = new AbortController().signal
  ): Promise<YtDlpInfo> {
    return this.adapter(options).testInstallation(signal);
  }

  async capture(request: DouyinCaptureRequest): Promise<DouyinCaptureResult> {
    if (!this.context) throw new Error("DouyinVideoConnector 尚未启动");
    if (!request.options.enabled) throw new ParserError("DOUYIN_DISABLED", "请先在设置中启用抖音在线视频解析");
    const requested = validateDouyinUrl(request.url);
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    request.signal?.addEventListener("abort", abort, { once: true });
    this.activeCaptures.add(controller);
    try {
      const ytDlp = this.adapter(request.options);
      request.reportProgress?.("resolving");
      const metadata = normalizeMetadata(await ytDlp.inspect(requested.toString(), controller.signal));
      request.reportProgress?.("metadata");
      const finalUrl = validateResolvedDouyinUrl(metadata.webpageUrl).toString();
      if (!metadata.id || !/^\d{5,30}$/.test(metadata.id)) {
        throw new ParserError("DOUYIN_METADATA_FAILED", "yt-dlp 未返回合法的抖音视频 ID");
      }
      const downloaded = await ytDlp.download(
        finalUrl,
        controller.signal,
        (progress) => request.reportProgress?.("downloading", progress)
      );
      try {
        request.reportProgress?.("storing", {
          downloadedBytes: downloaded.size,
          totalBytes: downloaded.size,
          percent: 100
        });
        const provenance = {
          kind: "video" as const,
          uri: finalUrl,
          requestedUri: requested.toString(),
          acquiredBy: this.id,
          deferParse: true,
          metadata: {
            title: metadata.title,
            ...(metadata.originalTitle ? { source_title_original: metadata.originalTitle } : {}),
            ...(metadata.author ? { author: metadata.author } : {}),
            ...(metadata.authorId ? { author_id: metadata.authorId } : {}),
            ...(metadata.description ? { description: metadata.description } : {}),
            source_platform: "douyin",
            douyin_video_id: metadata.id,
            ...(metadata.durationMs === undefined ? {} : { duration_ms: String(metadata.durationMs) })
          },
          capture: {
            platform: "douyin" as const,
            videoId: metadata.id,
            durationMs: metadata.durationMs,
            contentType: "video/mp4"
          }
        };
        const imported = this.context.importSourceBody
          ? await this.context.importSourceBody(sourceName(metadata, downloaded.name), downloaded.source, provenance)
          : await this.context.importSource(
            sourceName(metadata, downloaded.name),
            await downloaded.source.readAll(request.options.maxDownloadBytes),
            provenance
          );
        request.reportProgress?.("complete");
        return {
          ...imported,
          metadata,
          requestedUrl: requested.toString(),
          finalUrl
        };
      } finally {
        await downloaded.cleanup();
      }
    } catch (error) {
      if (controller.signal.aborted && !(error instanceof ParserError && error.code === "DOUYIN_CANCELLED")) {
        throw new ParserError("DOUYIN_CANCELLED", "抖音视频处理已取消", true);
      }
      throw error;
    } finally {
      request.signal?.removeEventListener("abort", abort);
      this.activeCaptures.delete(controller);
    }
  }

  private adapter(options: Omit<DouyinCaptureOptions, "useBrowserCookies"> & { useBrowserCookies?: boolean }): YtDlpPort {
    return this.createYtDlp({
      executablePath: options.ytDlpPath,
      ffmpegPath: options.ffmpegPath,
      maxDownloadBytes: options.maxDownloadBytes,
      timeoutMs: options.taskTimeoutMs,
      cookieBrowser: options.useBrowserCookies ? options.cookieBrowser : undefined
    });
  }
}

export function isDouyinUrl(input: string): boolean {
  try {
    validateDouyinUrl(input);
    return true;
  } catch {
    return false;
  }
}

export function validateDouyinUrl(input: string): URL {
  const trimmed = input.trim();
  const normalized = /^\d{5,30}$/.test(trimmed)
    ? `https://www.douyin.com/video/${trimmed}`
    : trimmed;
  let url: URL;
  try { url = new URL(normalized); }
  catch { throw new ParserError("DOUYIN_URL_INVALID", "抖音 URL 或视频 ID 无效"); }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw new ParserError("DOUYIN_URL_INVALID", "只允许不含认证信息的抖音 HTTPS 地址");
  }
  const host = url.hostname.toLocaleLowerCase();
  if (!DOUYIN_HOSTS.has(host)) throw new ParserError("DOUYIN_URL_INVALID", "这不是受支持的抖音官方地址");
  if (host === "douyin.com" || host === "www.douyin.com") {
    const modalIds = url.searchParams.getAll("modal_id");
    if (modalIds.length === 1 && /^\d{5,30}$/.test(modalIds[0]!)) {
      return new URL(`https://www.douyin.com/video/${modalIds[0]}`);
    }
    if (modalIds.length > 0) {
      throw new ParserError("DOUYIN_URL_INVALID", "抖音地址中的 modal_id 无效或不唯一");
    }
  }
  const validPath = host === "v.douyin.com"
    ? /^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)
    : host.endsWith("iesdouyin.com")
      ? /^\/share\/video\/\d+\/?$/.test(url.pathname)
      : /^\/video\/\d+\/?$/.test(url.pathname);
  if (!validPath) throw new ParserError("DOUYIN_URL_INVALID", "抖音地址中没有可识别的单个视频 ID");
  if (host !== "v.douyin.com") {
    url.search = "";
    url.hash = "";
  }
  return url;
}

function validateResolvedDouyinUrl(input: string): URL {
  const url = validateDouyinUrl(input);
  if (url.hostname.toLocaleLowerCase() === "v.douyin.com") {
    throw new ParserError("DOUYIN_METADATA_FAILED", "yt-dlp 未解析抖音短链接的最终页面");
  }
  url.hash = "";
  url.search = "";
  return url;
}

function sourceName(metadata: OnlineVideoMetadata, downloadedName: string): string {
  const extension = downloadedName.split(".").at(-1)?.toLocaleLowerCase().replace(/[^a-z0-9]/g, "") || "mp4";
  const title = replaceUnsafeFilenameCharacters(metadata.title.normalize("NFKC"))
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100) || "douyin-video";
  return `${title}--${metadata.id}.${extension}`;
}

function normalizeMetadata(value: OnlineVideoMetadata): OnlineVideoMetadata {
  const originalTitle = cleanText(value.title, 500) || `douyin-${value.id}`;
  const title = normalizeSocialVideoTitle(originalTitle, `douyin-${value.id}`);
  return {
    ...value,
    title,
    ...(title === originalTitle ? {} : { originalTitle }),
    author: value.author ? cleanText(value.author, 120) || undefined : undefined,
    authorId: value.authorId ? cleanText(value.authorId, 120) || undefined : undefined,
    description: value.description ? cleanText(value.description, 2_000) || undefined : undefined
  };
}

function cleanText(value: string, maxLength: number): string {
  return stripUnsafeControlCharacters(value.normalize("NFKC"))
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, maxLength);
}
