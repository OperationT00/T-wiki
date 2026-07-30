import type { ParsePayload, SourceMetadata } from "../../types";
import { parseYaml } from "../../utils/yaml";
import { decodeText, issue, normalizeMarkdownBody } from "../normalizer";
import { parseInputSize, parseInputSource, type DocumentParser, type ParseContext, type ParseInput, type ProbeResult } from "../parser-types";

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

export class MarkdownParser implements DocumentParser {
  readonly descriptor = {
    id: "markdown-pass-through",
    version: "1.0.0",
    execution: "local",
    supportedKinds: ["markdown"],
    capabilities: { sourceMap: false, assets: false, resumable: false }
  } as const;

  validateOptions(_options: Readonly<Record<string, unknown>>): void {}

  probe(input: ParseInput): ProbeResult {
    return {
      supported: input.kind === "markdown" || input.extension === "md",
      confidence: input.extension === "md" ? 1 : 0.7,
      detectedMime: "text/markdown"
    };
  }

  async parse(input: ParseInput, context: ParseContext): Promise<ParsePayload> {
    const size = parseInputSize(input);
    const bytes = await parseInputSource(input).readAll(size);
    context.reportProgress({
      phase: "parsing",
      completed: 0,
      total: Math.max(1, size),
      unit: "byte",
      message: "正在读取 Markdown"
    });
    const decoded = decodeText(bytes, false).replace(/\r\n?/g, "\n");
    const match = decoded.match(FRONTMATTER);
    let body = decoded;
    let metadata: SourceMetadata = {};
    const issues = [];
    if (match?.[1] !== undefined) {
      try {
        metadata = normalizeMetadata((parseYaml(match[1]) as Record<string, unknown>) ?? {});
        body = decoded.slice(match[0].length);
      } catch {
        issues.push(issue("MARKDOWN_FRONTMATTER_INVALID", "原 Markdown frontmatter 无法解析，已按正文原样保留"));
      }
    } else if (decoded.startsWith("---\n")) {
      issues.push(issue("MARKDOWN_FRONTMATTER_INVALID", "原 Markdown frontmatter 未闭合，已按正文原样保留"));
    }
    body = normalizeMarkdownBody(body);
    if (input.kind === "web" && hasRelativeImageReference(body)) {
      issues.push(issue(
        "WEB_CLIPPER_LOCAL_ASSET_NOT_ARCHIVED",
        "Web Clipper Markdown 包含本地或相对图片引用；首期保留引用但不复制附件"
      ));
    }
    const title = firstString(metadata.title) || body.match(/^#\s+(.+)$/m)?.[1]?.trim();
    if (title) metadata.title = title;
    context.reportProgress({
      phase: "parsing",
      completed: Math.max(1, size),
      total: Math.max(1, size),
      unit: "byte",
      message: "Markdown 解析完成"
    });
    return {
      schemaVersion: 2,
      metadata,
      markdown: body,
      assets: [],
      issues
    };
  }
}

function hasRelativeImageReference(markdown: string): boolean {
  return /!\[\[[^\]]+\]\]/.test(markdown)
    || /!\[[^\]]*\]\((?!https?:\/\/|data:|\/|#)[^)]+\)/i.test(markdown);
}

function normalizeMetadata(input: Record<string, unknown>): SourceMetadata {
  const output: SourceMetadata = {};
  for (const key of [
    "title", "author", "authors", "source", "url", "published", "created",
    "description", "tags", "source_type", "captured_at"
  ]) {
    const value = input[key];
    if (Array.isArray(value)) output[key] = value.map(String).filter(Boolean);
    else if (value !== undefined && value !== null && String(value).trim()) output[key] = String(value);
  }
  return output;
}

function firstString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
