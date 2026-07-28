import type { ParserProviderConfig, SourceKind } from "../types";
import type {
  DocumentParser,
  ParseInput,
  ParserSelection,
  ParserSelectionDiagnostic,
  ProbeResult
} from "./parser-types";
import { ParserError, ParserSelectionError } from "./parser-types";

export class ParserRegistry {
  private readonly parsers = new Map<string, DocumentParser>();

  constructor(parsers: DocumentParser[] = []) {
    for (const parser of parsers) this.register(parser);
  }

  register(parser: DocumentParser): this {
    const key = parserKey(parser);
    if (this.parsers.has(key)) throw new Error(`PARSER_ALREADY_REGISTERED:${key}`);
    this.parsers.set(key, parser);
    return this;
  }

  list(): DocumentParser[] {
    return [...this.parsers.values()];
  }

  async select(
    input: ParseInput,
    configs: Record<string, ParserProviderConfig>
  ): Promise<ParserSelection> {
    return (await this.rank(input, configs))[0]!;
  }

  async rank(
    input: ParseInput,
    configs: Record<string, ParserProviderConfig>
  ): Promise<ParserSelection[]> {
    const diagnostics: ParserSelectionDiagnostic[] = [];
    const candidates: Array<{
      parser: DocumentParser;
      probe: ProbeResult;
      confidence: number;
      priority: number;
    }> = [];
    await Promise.all(this.list().map(async (parser) => {
      const descriptor = parser.descriptor;
      const config = configs[descriptor.id] ?? { enabled: true, priority: 0, options: {} };
      if (!config.enabled) {
        diagnostics.push({
          parserId: descriptor.id,
          parserVersion: descriptor.version,
          supported: false,
          confidence: 0,
          reason: "disabled"
        });
        return;
      }
      try {
        parser.validateOptions(config.options);
        const probe = await parser.probe(input);
        diagnostics.push({
          parserId: descriptor.id,
          parserVersion: descriptor.version,
          supported: probe.supported,
          confidence: probe.confidence,
          reason: probe.reason
        });
        if (probe.supported) {
          candidates.push({
            parser,
            probe,
            confidence: probe.confidence,
            priority: config.priority
          });
        }
      } catch (error) {
        diagnostics.push({
          parserId: descriptor.id,
          parserVersion: descriptor.version,
          supported: false,
          confidence: 0,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }));
    const ranked = candidates.sort((left, right) =>
      right.confidence - left.confidence
      || right.priority - left.priority
      || left.parser.descriptor.id.localeCompare(right.parser.descriptor.id)
    );
    if (ranked.length === 0) {
      throw new ParserSelectionError(
        `${input.name} 没有可用的文档解析器`,
        diagnostics
      );
    }
    return ranked.map((candidate) => ({
      parser: candidate.parser,
      probe: candidate.probe,
      diagnostics
    }));
  }
}

export function detectSource(
  name: string,
  bytes: Uint8Array
): { extension: string; mime: string; kind: SourceKind } {
  const extension = name.split(".").pop()?.toLocaleLowerCase() ?? "";
  const pdfHeader = new TextDecoder("ascii").decode(bytes.subarray(0, 5));
  if (pdfHeader === "%PDF-") return { extension: "pdf", mime: "application/pdf", kind: "pdf" };
  if (extension === "pdf") {
    throw new ParserError("UNSUPPORTED_FORMAT", `${name} 扩展名为 PDF，但 magic bytes 无效`);
  }
  if (extension === "md" || extension === "markdown") {
    return { extension: "md", mime: "text/markdown", kind: "markdown" };
  }
  if (extension === "txt") return { extension: "txt", mime: "text/plain", kind: "text" };
  return {
    extension: extension.replace(/[^a-z0-9]/gi, "") || "bin",
    mime: "application/octet-stream",
    kind: "unknown"
  };
}

/** @deprecated Use detectSource. */
export function mimeForFile(name: string, bytes: Uint8Array): {
  extension: string;
  mime: string;
} {
  const { extension, mime } = detectSource(name, bytes);
  return { extension, mime };
}

function parserKey(parser: DocumentParser): string {
  return `${parser.descriptor.id}@${parser.descriptor.version}`;
}
