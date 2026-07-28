import type { ParsePayload } from "../../types";
import { decodeText, normalizeMarkdownBody } from "../normalizer";
import type { DocumentParser, ParseContext, ParseInput, ProbeResult } from "../parser-types";

export class TextParser implements DocumentParser {
  readonly descriptor = {
    id: "plain-text",
    version: "1.0.0",
    execution: "local",
    supportedKinds: ["text"],
    capabilities: { sourceMap: false, assets: false, resumable: false }
  } as const;

  validateOptions(_options: Readonly<Record<string, unknown>>): void {}

  probe(input: ParseInput): ProbeResult {
    return {
      supported: input.kind === "text" || input.extension === "txt",
      confidence: input.extension === "txt" ? 1 : 0.6,
      detectedMime: "text/plain"
    };
  }

  async parse(input: ParseInput, context: ParseContext): Promise<ParsePayload> {
    context.reportProgress({
      phase: "parsing",
      completed: 0,
      total: Math.max(1, input.bytes.length),
      unit: "byte",
      message: "正在解码文本"
    });
    const decoded = decodeText(input.bytes);
    const body = normalizeMarkdownBody(
      decoded
        .replace(/\r\n?/g, "\n")
        .split(/\n{2,}/)
        .map((paragraph) => paragraph.trim())
        .filter(Boolean)
        .join("\n\n")
    );
    context.reportProgress({
      phase: "parsing",
      completed: Math.max(1, input.bytes.length),
      total: Math.max(1, input.bytes.length),
      unit: "byte",
      message: "文本解析完成"
    });
    return {
      schemaVersion: 2,
      metadata: {},
      markdown: body,
      assets: [],
      issues: []
    };
  }
}
