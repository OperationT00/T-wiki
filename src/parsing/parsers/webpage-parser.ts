import Defuddle from "defuddle/full";

import type { ParseIssue, ParsePayload, SourceMetadata } from "../../types";
import type { DocumentParser, ParseContext, ParseInput, ProbeResult } from "../parser-types";
import { ParserError, parseInputSize, parseInputSource, throwIfAborted } from "../parser-types";

const ACCESS_GATE = /(?:enable\s+javascript|javascript\s+(?:is\s+)?required|access\s+denied|captcha|cloudflare|checking\s+your\s+browser|verify\s+you\s+are\s+human|请启用\s*javascript|访问被拒绝|人机验证|安全验证)/i;

export class WebPageParser implements DocumentParser {
  readonly descriptor = {
    id: "webpage-defuddle",
    version: "1.0.0",
    execution: "local",
    supportedKinds: ["web"],
    capabilities: { sourceMap: false, assets: false, resumable: false }
  } as const;

  validateOptions(options: Readonly<Record<string, unknown>>): void {
    if (Object.keys(options).length > 0) {
      throw new ParserError("INVALID_PARSER_OPTIONS", "webpage-defuddle@1.0.0 暂不接受配置项");
    }
  }

  async probe(input: ParseInput): Promise<ProbeResult> {
    const extensionMatch = input.extension === "html" || input.extension === "htm" || input.extension === "xhtml";
    const mimeMatch = /^text\/html(?:;|$)|^application\/xhtml\+xml(?:;|$)/i.test(input.mime)
      || /^text\/html(?:;|$)|^application\/xhtml\+xml(?:;|$)/i.test(input.captureContentType ?? "");
    const magicMatch = looksLikeHtml(await parseInputSource(input).readHead(2048));
    const supported = input.kind === "web" && (extensionMatch || mimeMatch || magicMatch);
    return {
      supported,
      confidence: supported ? (mimeMatch || magicMatch ? 1 : 0.9) : 0,
      detectedMime: supported ? "text/html" : undefined,
      reason: supported ? "web HTML source" : "not an HTML web source"
    };
  }

  async parse(input: ParseInput, context: ParseContext): Promise<ParsePayload> {
    throwIfAborted(context.signal);
    context.reportProgress({ phase: "decode", completed: 0, total: 3, message: "正在解码网页 HTML" });
    const html = decodeHtml(
      await parseInputSource(input).readAll(parseInputSize(input)),
      input.captureContentType
    );
    if (typeof DOMParser === "undefined") {
      throw new ParserError("WEB_DOM_UNAVAILABLE", "当前 Obsidian 环境不支持 DOMParser");
    }
    const Parser = DOMParser;
    const document = new Parser().parseFromString(html, "text/html");
    if (!document?.documentElement) throw new ParserError("WEB_HTML_INVALID", "网页 HTML 无法解析");

    throwIfAborted(context.signal);
    context.reportProgress({ phase: "extract", completed: 1, total: 3, message: "正在提取网页正文" });
    let result: ReturnType<Defuddle["parse"]>;
    try {
      result = new Defuddle(document, {
        url: input.sourceUri,
        markdown: true,
        useAsync: false
      }).parse();
    } catch {
      throw new ParserError("WEB_EXTRACTION_FAILED", "Defuddle 无法提取网页正文");
    }
    throwIfAborted(context.signal);
    const markdown = result.content?.trim() ?? "";
    const visibleText = document.body?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    const gateText = `${visibleText.slice(0, 4000)}\n${markdown.slice(0, 4000)}`;
    if (!markdown || result.wordCount === 0) {
      throw new ParserError(
        "WEB_BROWSER_REQUIRED",
        "网页没有可提取的正文，可能需要 JavaScript 渲染；请改用浏览器 Web Clipper"
      );
    }
    if (markdown.startsWith("Partial conversion completed with errors.")) {
      throw new ParserError("WEB_MARKDOWN_CONVERSION_FAILED", "网页正文转换 Markdown 失败");
    }
    if (result.wordCount < 200 && ACCESS_GATE.test(gateText)) {
      throw new ParserError(
        "WEB_ACCESS_BLOCKED",
        "网页返回了登录、验证码或访问拦截页面；请改用浏览器 Web Clipper"
      );
    }

    const issues: ParseIssue[] = [];
    if (result.wordCount < 50) {
      issues.push({
        code: "WEB_CONTENT_SPARSE",
        severity: "warning",
        message: `网页正文较短（${result.wordCount} 词），请在 Ingest 前预览确认`
      });
    }
    context.reportProgress({ phase: "complete", completed: 3, total: 3, message: "网页正文提取完成" });
    return {
      schemaVersion: 2,
      markdown,
      metadata: buildMetadata(result, input.sourceUri),
      assets: [],
      issues,
      stats: {
        wordCount: result.wordCount,
        parseTimeMs: result.parseTime
      }
    };
  }
}

function buildMetadata(
  result: ReturnType<Defuddle["parse"]>,
  sourceUri: string | undefined
): SourceMetadata {
  return compactMetadata({
    title: result.title,
    author: result.author,
    published: result.published,
    description: result.description,
    url: sourceUri,
    site: result.site,
    language: result.language
  });
}

function compactMetadata(input: SourceMetadata): SourceMetadata {
  return Object.fromEntries(Object.entries(input).filter(([, value]) =>
    Array.isArray(value) ? value.length > 0 : typeof value === "string" && value.trim().length > 0
  ));
}

export function decodeHtml(bytes: Uint8Array, contentType?: string): string {
  let offset = 0;
  let encoding = charsetFromContentType(contentType);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    encoding = "utf-8";
    offset = 3;
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = "utf-16le";
    offset = 2;
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = "utf-16be";
    offset = 2;
  }
  if (!encoding) encoding = charsetFromHtml(bytes) ?? "utf-8";
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(offset));
  } catch {
    throw new ParserError("UNSUPPORTED_ENCODING", `不支持或无法解码网页字符集：${encoding}`);
  }
}

function charsetFromContentType(contentType: string | undefined): string | undefined {
  return contentType?.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1]?.toLocaleLowerCase();
}

function charsetFromHtml(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 8192)));
  return head.match(/<meta[^>]+charset\s*=\s*["']?([^\s"'/>]+)/i)?.[1]?.toLocaleLowerCase()
    ?? head.match(/<meta[^>]+content\s*=\s*["'][^"']*charset=([^\s;"']+)/i)?.[1]?.toLocaleLowerCase();
}

function looksLikeHtml(bytes: Uint8Array): boolean {
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, Math.min(bytes.length, 2048)))
    .replace(/^\uFEFF/, "")
    .trimStart();
  return /^<(?:!doctype\s+html|html|head|body|meta|title|article)(?:\s|>)/i.test(head);
}
