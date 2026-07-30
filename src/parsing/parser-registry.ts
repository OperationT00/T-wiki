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
  if (extension === "bili-caption") {
    return { extension, mime: "application/vnd.t-wiki.bilibili-caption+json", kind: "video" };
  }
  const media = detectMediaMagic(bytes, extension);
  if (media) return media;
  if (AUDIO_EXTENSIONS.has(extension) || VIDEO_EXTENSIONS.has(extension)) {
    throw new ParserError(
      "MEDIA_MAGIC_MISMATCH",
      `${name} 的扩展名与文件内容不匹配，已拒绝远程上传`
    );
  }
  return {
    extension: extension.replace(/[^a-z0-9]/gi, "") || "bin",
    mime: "application/octet-stream",
    kind: "unknown"
  };
}

const AUDIO_EXTENSIONS = new Set(["wav", "mp3", "m4a", "mpga", "mpeg", "ogg", "oga", "flac"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm", "mkv", "avi"]);

function detectMediaMagic(
  bytes: Uint8Array,
  extension: string
): { extension: string; mime: string; kind: SourceKind } | undefined {
  const ascii = (start: number, length: number): string =>
    new TextDecoder("ascii").decode(bytes.subarray(start, start + length));
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") {
    return { extension: "wav", mime: "audio/wav", kind: "audio" };
  }
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "AVI ") {
    return { extension: "avi", mime: "video/x-msvideo", kind: "video" };
  }
  if (ascii(0, 3) === "ID3" || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) {
    return { extension: "mp3", mime: "audio/mpeg", kind: "audio" };
  }
  if (ascii(0, 4) === "fLaC") return { extension: "flac", mime: "audio/flac", kind: "audio" };
  if (ascii(0, 4) === "OggS") return { extension: extension === "oga" ? "oga" : "ogg", mime: "audio/ogg", kind: "audio" };
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    const audio = extension === "webm" && AUDIO_EXTENSIONS.has(extension);
    return { extension: extension === "mkv" ? "mkv" : "webm", mime: audio ? "audio/webm" : "video/webm", kind: audio ? "audio" : "video" };
  }
  if (ascii(4, 4) === "ftyp") {
    const brand = ascii(8, 8).toLocaleLowerCase();
    const audio = extension === "m4a" || brand.includes("m4a");
    const mov = extension === "mov" || brand.includes("qt");
    return audio
      ? { extension: "m4a", mime: "audio/mp4", kind: "audio" }
      : { extension: mov ? "mov" : "mp4", mime: mov ? "video/quicktime" : "video/mp4", kind: "video" };
  }
  return undefined;
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
