import { ParserError, throwIfAborted } from "../parsing/parser-types";
import type { SourceBody } from "../parsing/parser-types";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BilibiliCaptionPackage, TimedTranscriptSegment } from "../parsing/media/transcript-types";
import type { SourceManifest } from "../types";
import { replaceUnsafeFilenameCharacters } from "../utils/text-safety";
import type { SourceConnector, SourceConnectorContext } from "./source-connector";

const ALLOWED_HOSTS = new Set(["www.bilibili.com", "bilibili.com", "m.bilibili.com", "api.bilibili.com", "b23.tv"]);
const ALLOWED_MEDIA_SUFFIXES = [".hdslb.com", ".bilivideo.com", ".bilibili.com"];

export interface BilibiliCaptureRequest {
  url: string;
  pages?: "current" | "all" | number[];
  language?: string;
  signal?: AbortSignal;
  reportProgress?(phase: "metadata" | "caption" | "complete", completed?: number, total?: number): void;
}

export interface BilibiliCaptureResult {
  manifests: SourceManifest[];
  duplicates: number;
  bvid: string;
}

interface VideoPage { cid: string; page: number; part: string; durationMs?: number }
interface VideoInfo { bvid: string; aid: string; title: string; author: string; description?: string; pages: VideoPage[] }
interface CaptionTrack { url: string; language: string; label: string; kind: "author" | "ai" | "unknown" }

export class BilibiliVideoConnector implements SourceConnector {
  readonly id = "bilibili-video";
  private context?: SourceConnectorContext;

  async start(context: SourceConnectorContext): Promise<void> { this.context = context; }
  async stop(): Promise<void> { this.context = undefined; }

  async capture(request: BilibiliCaptureRequest): Promise<BilibiliCaptureResult> {
    if (!this.context) throw new Error("BilibiliVideoConnector 尚未启动");
    const signal = request.signal ?? new AbortController().signal;
    const resolved = await resolveBilibiliUrl(request.url, signal);
    request.reportProgress?.("metadata");
    const info = await getVideoInfo(resolved, signal);
    const selected = selectPages(info.pages, resolved, request.pages);
    if (selected.length > 100) throw new ParserError("BILIBILI_PAGE_LIMIT", "一次最多导入 100 个分 P");
    const manifests: SourceManifest[] = [];
    let duplicates = 0;
    for (let index = 0; index < selected.length; index += 2) {
      const batch = selected.slice(index, index + 2);
      const results = await Promise.all(batch.map(async (page, offset) => {
        request.reportProgress?.("caption", index + offset, selected.length);
        const tracks = await getCaptionTracks(info.bvid, page.cid, signal);
        const track = chooseTrack(tracks, request.language);
        if (!track) {
          throw new ParserError(
            "NO_CAPTION_TRACK",
            `${info.title} · ${page.part} 没有公开字幕，可在确认后使用远程语音转写`
          );
        }
        const segments = await getCaptionSegments(track.url, signal);
        const packageValue: BilibiliCaptionPackage = {
          schemaVersion: 1,
          bvid: info.bvid,
          cid: page.cid,
          page: page.page,
          title: info.title,
          partTitle: page.part,
          author: info.author,
          ...(info.description ? { description: info.description } : {}),
          language: track.language,
          trackKind: track.kind,
          ...(page.durationMs === undefined ? {} : { durationMs: page.durationMs }),
          segments
        };
        const sourceUri = `https://www.bilibili.com/video/${info.bvid}?p=${page.page}`;
        return this.context!.importSource(
          `${safeName(info.title)}-p${page.page}.bili-caption`,
          new TextEncoder().encode(`${JSON.stringify(packageValue)}\n`),
          {
            kind: "video",
            uri: sourceUri,
            requestedUri: request.url,
            acquiredBy: this.id
          }
        );
      }));
      for (const result of results) {
        manifests.push(result.manifest);
        if (result.duplicate) duplicates += 1;
      }
    }
    request.reportProgress?.("complete", selected.length, selected.length);
    return { manifests, duplicates, bvid: info.bvid };
  }

  async captureAudioForTranscription(
    input: string,
    signal = new AbortController().signal,
    reportProgress?: (downloaded: number, total?: number) => void
  ): Promise<SourceManifest> {
    if (!this.context) throw new Error("BilibiliVideoConnector 尚未启动");
    const resolved = await resolveBilibiliUrl(input, signal);
    const info = await getVideoInfo(resolved, signal);
    const page = selectPages(info.pages, resolved, "current")[0]!;
    const mediaUrl = await getPublicAudioUrl(info.bvid, page.cid, signal);
    const temporary = await downloadTemporaryMedia(mediaUrl, signal, reportProgress);
    try {
      const provenance = {
        kind: "audio" as const,
        uri: `https://www.bilibili.com/video/${info.bvid}?p=${page.page}`,
        requestedUri: input,
        acquiredBy: "bilibili-audio",
        deferParse: true
      };
      const result = this.context.importSourceBody
        ? await this.context.importSourceBody(`${safeName(info.title)}-p${page.page}.m4a`, temporary.body, provenance)
        : await this.context.importSource(
          `${safeName(info.title)}-p${page.page}.m4a`,
          await temporary.body.readAll(500 * 1024 * 1024),
          provenance
        );
      return result.manifest;
    } finally {
      await temporary.cleanup();
    }
  }
}

export function isBilibiliUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === "https:" && (ALLOWED_HOSTS.has(url.hostname.toLocaleLowerCase())
      || url.hostname.toLocaleLowerCase().endsWith(".bilibili.com"));
  } catch { return false; }
}

async function resolveBilibiliUrl(input: string, signal: AbortSignal): Promise<URL> {
  let current: URL;
  try { current = new URL(input); } catch { throw new ParserError("BILIBILI_URL_INVALID", "Bilibili URL 无效"); }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    assertAllowedPageUrl(current);
    if (current.hostname !== "b23.tv") return current;
    const response = await window.fetch(current, { method: "GET", redirect: "manual", credentials: "omit", signal });
    if (response.status < 300 || response.status >= 400) throw new ParserError("BILIBILI_SHORT_URL_FAILED", `b23.tv 返回 HTTP ${response.status}`, response.status >= 500);
    const location = response.headers.get("location");
    if (!location) throw new ParserError("BILIBILI_SHORT_URL_FAILED", "b23.tv 未返回重定向地址");
    current = new URL(location, current);
  }
  throw new ParserError("BILIBILI_REDIRECT_LIMIT", "Bilibili 短链重定向次数过多");
}

async function getVideoInfo(url: URL, signal: AbortSignal): Promise<VideoInfo> {
  const bvid = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i)?.[1];
  const aid = url.pathname.match(/\/video\/(?:av)?(\d+)/i)?.[1];
  if (!bvid && !aid) throw new ParserError("BILIBILI_URL_INVALID", "URL 中未找到 BV/AV 号");
  const api = new URL("https://api.bilibili.com/x/web-interface/view");
  api.searchParams.set(bvid ? "bvid" : "aid", bvid ?? aid!);
  const data = await apiData(api, signal);
  const owner = object(data.owner);
  const pages = array(data.pages).map((value): VideoPage => {
    const page = object(value);
    return {
      cid: String(page.cid ?? ""),
      page: Number(page.page ?? 1),
      part: String(page.part ?? data.title ?? "视频"),
      durationMs: typeof page.duration === "number" ? Math.round(page.duration * 1000) : undefined
    };
  }).filter((page) => page.cid);
  if (pages.length === 0) throw new ParserError("BILIBILI_API_CHANGED", "Bilibili 未返回分 P 信息");
  return {
    bvid: String(data.bvid ?? bvid ?? ""),
    aid: String(data.aid ?? aid ?? ""),
    title: String(data.title ?? "Bilibili 视频"),
    author: String(owner.name ?? ""),
    description: typeof data.desc === "string" ? data.desc : undefined,
    pages
  };
}

async function getCaptionTracks(bvid: string, cid: string, signal: AbortSignal): Promise<CaptionTrack[]> {
  const api = new URL("https://api.bilibili.com/x/player/v2");
  api.searchParams.set("bvid", bvid);
  api.searchParams.set("cid", cid);
  const data = await apiData(api, signal);
  const subtitle = object(data.subtitle);
  return array(subtitle.subtitles).flatMap((value): CaptionTrack[] => {
    const item = object(value);
    const rawUrl = String(item.subtitle_url ?? "");
    if (!rawUrl) return [];
    const url = rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl;
    assertAllowedMediaUrl(new URL(url));
    const label = String(item.lan_doc ?? item.lan ?? "unknown");
    const type = Number(item.type ?? 0);
    return [{
      url,
      language: String(item.lan ?? label),
      label,
      kind: type === 0 ? "author" : /ai/i.test(label) || type > 0 ? "ai" : "unknown"
    }];
  });
}

function chooseTrack(tracks: CaptionTrack[], preferred?: string): CaptionTrack | undefined {
  if (preferred) {
    const exact = tracks.find((track) => track.language === preferred || track.label === preferred);
    if (exact) return exact;
  }
  return tracks.find((track) => /zh-cn|简体|中文（简体）/i.test(`${track.language} ${track.label}`))
    ?? tracks.find((track) => /zh|中文/i.test(`${track.language} ${track.label}`))
    ?? tracks[0];
}

async function getCaptionSegments(url: string, signal: AbortSignal): Promise<TimedTranscriptSegment[]> {
  const target = new URL(url);
  assertAllowedMediaUrl(target);
  const json = await getJson(target, signal);
  const body = array(object(json).body);
  const segments = body.flatMap((value): TimedTranscriptSegment[] => {
    const item = object(value);
    const text = String(item.content ?? "").trim();
    if (!text) return [];
    return [{
      startMs: seconds(item.from),
      endMs: seconds(item.to),
      text,
      speaker: typeof item.speaker === "string" ? item.speaker : undefined
    }];
  });
  if (segments.length === 0) throw new ParserError("BILIBILI_CAPTION_EMPTY", "字幕轨没有文字内容");
  return segments;
}

async function getPublicAudioUrl(bvid: string, cid: string, signal: AbortSignal): Promise<URL> {
  const api = new URL("https://api.bilibili.com/x/player/playurl");
  api.searchParams.set("bvid", bvid);
  api.searchParams.set("cid", cid);
  api.searchParams.set("fnval", "16");
  const data = await apiData(api, signal);
  const audio = array(object(data.dash).audio)
    .map((value) => object(value))
    .sort((left, right) => Number(right.bandwidth ?? 0) - Number(left.bandwidth ?? 0))[0];
  const raw = String(audio?.baseUrl ?? audio?.base_url ?? "");
  if (!raw) throw new ParserError("BILIBILI_AUDIO_UNAVAILABLE", "Bilibili 未返回可用的公开音轨");
  const url = new URL(raw);
  assertAllowedMediaUrl(url);
  return url;
}

async function downloadTemporaryMedia(
  url: URL,
  signal: AbortSignal,
  reportProgress?: (downloaded: number, total?: number) => void
): Promise<{ body: SourceBody; cleanup(): Promise<void> }> {
  assertAllowedMediaUrl(url);
  const response = await window.fetch(url, { signal, redirect: "error", credentials: "omit" });
  if (!response.ok || !response.body) {
    throw new ParserError("BILIBILI_AUDIO_DOWNLOAD_FAILED", `音轨下载失败：HTTP ${response.status}`, response.status >= 500);
  }
  const total = numberHeader(response.headers.get("content-length"));
  const limit = 500 * 1024 * 1024;
  if (total !== undefined && total > limit) throw new ParserError("FILE_TOO_LARGE", "Bilibili 音轨超过 500 MiB");
  const root = await mkdtemp(join(tmpdir(), "t-wiki-media-"));
  const filePath = join(root, "audio.m4a");
  const writer = createWriteStream(filePath, { flags: "wx" });
  const reader = response.body.getReader();
  let size = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new ParserError("FILE_TOO_LARGE", "Bilibili 音轨超过 500 MiB");
      if (!writer.write(chunk.value)) await writerDrain(writer);
      reportProgress?.(size, total);
    }
    await writerClose(writer);
  } catch (error) {
    writer.destroy();
    await rm(root, { recursive: true, force: true });
    throw error;
  } finally {
    reader.releaseLock();
  }
  const body: SourceBody = {
    size,
    async readHead(maxBytes) {
      const handle = await open(filePath, "r");
      try {
        const bytes = new Uint8Array(Math.min(maxBytes, size));
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        return bytes.slice(0, bytesRead);
      } finally { await handle.close(); }
    },
    async readAll(maxBytes) {
      if (size > maxBytes) throw new ParserError("FILE_TOO_LARGE", `Source exceeds ${maxBytes} bytes`);
      const chunks: Buffer[] = [];
      for await (const chunk of createReadStream(filePath)) chunks.push(chunk as Buffer);
      return new Uint8Array(Buffer.concat(chunks));
    },
    async *openStream() {
      if ((await stat(filePath)).size !== size) throw new Error("TEMP_MEDIA_CHANGED");
      for await (const chunk of createReadStream(filePath)) yield new Uint8Array(chunk as Buffer);
    }
  };
  return { body, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function selectPages(pages: VideoPage[], url: URL, selection: BilibiliCaptureRequest["pages"]): VideoPage[] {
  if (Array.isArray(selection)) {
    const wanted = new Set(selection);
    return pages.filter((page) => wanted.has(page.page));
  }
  if (selection === "all") return pages;
  const requested = Math.max(1, Number(url.searchParams.get("p") ?? 1));
  return [pages.find((page) => page.page === requested) ?? pages[0]!];
}

async function apiData(url: URL, signal: AbortSignal): Promise<Record<string, unknown>> {
  const json = object(await getJson(url, signal));
  if (Number(json.code ?? -1) !== 0) {
    throw new ParserError("BILIBILI_API_ERROR", `Bilibili API 错误：${String(json.message ?? json.code ?? "unknown")}`, Number(json.code) === -412);
  }
  return object(json.data);
}

async function getJson(url: URL, signal: AbortSignal): Promise<unknown> {
  throwIfAborted(signal);
  const response = await window.fetch(url, {
    signal,
    redirect: "error",
    credentials: "omit",
    headers: { "user-agent": "T-Wiki/0.1 (+https://github.com/OperationT00/T-wiki)" }
  });
  if (!response.ok) throw new ParserError("BILIBILI_NETWORK_ERROR", `Bilibili 返回 HTTP ${response.status}`, response.status === 429 || response.status >= 500);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > 10 * 1024 * 1024) throw new ParserError("BILIBILI_RESPONSE_TOO_LARGE", "Bilibili 响应超过 10 MB");
  if (!response.body) throw new ParserError("BILIBILI_NETWORK_ERROR", "Bilibili 响应没有正文");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      received += item.value.byteLength;
      if (received > 10 * 1024 * 1024) throw new ParserError("BILIBILI_RESPONSE_TOO_LARGE", "Bilibili 响应超过 10 MB");
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new ParserError("BILIBILI_API_CHANGED", "Bilibili 返回了无法识别的 JSON"); }
}

function assertAllowedPageUrl(url: URL): void {
  if (url.protocol !== "https:" || (!ALLOWED_HOSTS.has(url.hostname.toLocaleLowerCase())
    && !url.hostname.toLocaleLowerCase().endsWith(".bilibili.com"))) {
    throw new ParserError("BILIBILI_URL_NOT_ALLOWED", "只允许公开 Bilibili HTTPS 地址");
  }
}

function assertAllowedMediaUrl(url: URL): void {
  const host = url.hostname.toLocaleLowerCase();
  if (url.protocol !== "https:" || !(ALLOWED_HOSTS.has(host) || ALLOWED_MEDIA_SUFFIXES.some((suffix) => host.endsWith(suffix)))) {
    throw new ParserError("BILIBILI_MEDIA_URL_NOT_ALLOWED", "Bilibili API 返回了非允许媒体地址");
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function seconds(value: unknown): number | undefined { return typeof value === "number" ? Math.round(value * 1000) : undefined; }
function safeName(value: string): string { return replaceUnsafeFilenameCharacters(value.normalize("NFKC")).replace(/\s+/g, "-").slice(0, 100) || "bilibili"; }
function numberHeader(value: string | null): number | undefined { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined; }
function writerDrain(writer: ReturnType<typeof createWriteStream>): Promise<void> { return new Promise((resolvePromise, reject) => { writer.once("drain", resolvePromise); writer.once("error", reject); }); }
function writerClose(writer: ReturnType<typeof createWriteStream>): Promise<void> { return new Promise((resolvePromise, reject) => { writer.once("error", reject); writer.end(resolvePromise); }); }
