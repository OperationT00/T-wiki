import type { BilibiliVideoConnector } from "./bilibili-video-connector";
import { isBilibiliUrl } from "./bilibili-video-connector";
import type {
  DouyinCaptureRequest,
  DouyinCaptureResult,
  DouyinVideoConnector
} from "./douyin-video-connector";
import { isDouyinUrl } from "./douyin-video-connector";
import { ParserError } from "../parsing/parser-types";
import type { UrlCaptureConnector, UrlCaptureRequest, UrlCaptureResult } from "./source-connector";

export class UrlCaptureRouter {
  constructor(
    private readonly web: UrlCaptureConnector,
    private readonly bilibili: BilibiliVideoConnector,
    private readonly douyin: DouyinVideoConnector
  ) {}

  async capture(request: UrlCaptureRequest): Promise<UrlCaptureResult> {
    const videoUrl = isBilibiliUrl(request.url) || isDouyinUrl(request.url);
    if (request.mode === "web" && videoUrl) {
      throw new ParserError("VIDEO_URL_REQUIRES_VIDEO_CONNECTOR", "视频平台链接请使用“解析在线视频”入口");
    }
    if (request.mode === "video" && !videoUrl) {
      throw new ParserError("UNSUPPORTED_VIDEO_PLATFORM", "当前在线视频入口支持 Bilibili 和抖音公开视频");
    }
    if (isDouyinUrl(request.url)) {
      throw new ParserError("DOUYIN_CAPTURE_OPTIONS_REQUIRED", "抖音视频必须通过受控下载流程处理");
    }
    if (!isBilibiliUrl(request.url)) return this.web.capture(request);
    const result = await this.bilibili.capture({
      url: request.url,
      signal: request.signal,
      pages: request.bilibiliPages,
      language: request.bilibiliLanguage,
      reportProgress: (phase) => request.reportProgress?.(phase === "complete" ? "complete" : phase === "caption" ? "parse" : "download")
    });
    const manifest = result.manifests[0];
    if (!manifest) throw new Error("Bilibili 没有可导入的字幕来源");
    return {
      manifest,
      duplicate: result.duplicates === result.manifests.length,
      requestedUrl: request.url,
      finalUrl: manifest.source.uri ?? request.url
    };
  }

  async captureDouyin(request: DouyinCaptureRequest): Promise<DouyinCaptureResult> {
    if (!isDouyinUrl(request.url)) {
      throw new ParserError("DOUYIN_URL_INVALID", "这不是受支持的抖音视频地址");
    }
    return this.douyin.capture(request);
  }
}
