import type { ParsePayload } from "../../types";
import { TranscriptMarkdownBuilder } from "../media/transcript-markdown-builder";
import type { BilibiliCaptionPackage, TimedTranscript } from "../media/transcript-types";
import {
  ParserError,
  parseInputSize,
  parseInputSource,
  type DocumentParser,
  type ParseContext,
  type ParseInput,
  type ProbeResult
} from "../parser-types";

export class BilibiliCaptionParser implements DocumentParser {
  readonly descriptor = {
    id: "bilibili-caption",
    version: "1.0.0",
    execution: "local",
    supportedKinds: ["video"],
    capabilities: { sourceMap: false, assets: false, resumable: false }
  } as const;

  constructor(private readonly builder = new TranscriptMarkdownBuilder()) {}

  validateOptions(options: Readonly<Record<string, unknown>>): void {
    const maxPages = options.maxPagesPerCapture ?? 100;
    if (typeof maxPages !== "number" || maxPages < 1 || maxPages > 100) {
      throw new ParserError("INVALID_PARSER_OPTIONS", "Bilibili 分 P 上限必须在 1 到 100 之间");
    }
  }

  async probe(input: ParseInput): Promise<ProbeResult> {
    const head = new TextDecoder().decode(await parseInputSource(input).readHead(256));
    const supported = input.kind === "video"
      && (input.extension === "bili-caption" || head.includes('"schemaVersion":1') && head.includes('"bvid"'));
    return {
      supported,
      confidence: supported ? 1 : 0,
      detectedMime: supported ? "application/vnd.t-wiki.bilibili-caption+json" : undefined
    };
  }

  async parse(input: ParseInput, context: ParseContext): Promise<ParsePayload> {
    context.reportProgress({ phase: "caption", completed: 0, total: 1, unit: "document", message: "正在读取 Bilibili 字幕" });
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      await parseInputSource(input).readAll(parseInputSize(input))
    );
    const value = parsePackage(text);
    const transcript: TimedTranscript = {
      schemaVersion: 1,
      language: value.language,
      durationMs: value.durationMs,
      segments: value.segments,
      provider: "bilibili-caption",
      generated: value.trackKind === "ai",
      issues: []
    };
    const uri = `https://www.bilibili.com/video/${value.bvid}?p=${value.page}`;
    const built = this.builder.build(transcript, {
      title: value.partTitle === value.title ? value.title : `${value.title} · ${value.partTitle}`,
      sourceUri: uri,
      bilibiliBvid: value.bvid,
      bilibiliPage: value.page,
      author: value.author,
      platform: "bilibili",
      trackKind: value.trackKind
    });
    built.metadata.bilibili_cid = value.cid;
    built.metadata.bilibili_page = String(value.page);
    context.reportProgress(value.durationMs
      ? { phase: "quality-check", completed: Math.round(value.durationMs / 1000), total: Math.round(value.durationMs / 1000), unit: "second", message: "Bilibili 字幕解析完成" }
      : { phase: "quality-check", completed: 1, total: 1, unit: "document", message: "Bilibili 字幕解析完成" });
    return { schemaVersion: 2, markdown: built.markdown, metadata: built.metadata, assets: [], issues: built.issues };
  }
}

function parsePackage(text: string): BilibiliCaptionPackage {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new ParserError("BILIBILI_CAPTION_INVALID", "字幕采集包 JSON 无效"); }
  if (!value || typeof value !== "object") throw new ParserError("BILIBILI_CAPTION_INVALID", "字幕采集包格式无效");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || !/^(?:BV[0-9A-Za-z]+)$/.test(String(record.bvid ?? ""))
    || !Array.isArray(record.segments)) {
    throw new ParserError("BILIBILI_CAPTION_INVALID", "字幕采集包缺少必填字段");
  }
  const segments = record.segments.flatMap((item): BilibiliCaptionPackage["segments"] => {
    if (!item || typeof item !== "object") return [];
    const segment = item as Record<string, unknown>;
    const text = String(segment.text ?? "").trim();
    if (!text) return [];
    return [{
      startMs: numberOrUndefined(segment.startMs),
      endMs: numberOrUndefined(segment.endMs),
      text,
      speaker: typeof segment.speaker === "string" ? segment.speaker : undefined
    }];
  });
  return {
    schemaVersion: 1,
    bvid: String(record.bvid),
    cid: String(record.cid ?? ""),
    page: Math.max(1, Math.floor(Number(record.page ?? 1))),
    title: String(record.title ?? "Bilibili 视频"),
    partTitle: String(record.partTitle ?? record.title ?? "Bilibili 视频"),
    author: String(record.author ?? ""),
    description: typeof record.description === "string" ? record.description : undefined,
    language: String(record.language ?? "unknown"),
    trackKind: record.trackKind === "author" || record.trackKind === "ai" ? record.trackKind : "unknown",
    durationMs: numberOrUndefined(record.durationMs),
    segments
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
