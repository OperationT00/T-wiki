import type {
  ParsePayload,
  ParseProgress,
  SourceKind
} from "../types";

export interface ParseInput {
  sourceId: string;
  sourceHash: string;
  kind: SourceKind;
  name: string;
  extension: string;
  mime: string;
  size?: number;
  source?: SourceBody;
  /** @deprecated Compatibility for parser unit tests and legacy adapters. */
  bytes?: Uint8Array;
  sourceUri?: string;
  sourceMetadata?: import("../types").SourceMetadata;
  captureContentType?: string;
}

/**
 * Re-readable source abstraction. Implementations must return a fresh stream on
 * every openStream() call; parsers may probe and parse the same source.
 */
export interface SourceBody {
  readonly size?: number;
  readHead(maxBytes: number): Promise<Uint8Array>;
  readAll(maxBytes: number): Promise<Uint8Array>;
  openStream(): AsyncIterable<Uint8Array>;
}

export function sourceBodyFromBytes(bytes: Uint8Array): SourceBody {
  return {
    size: bytes.byteLength,
    async readHead(maxBytes) {
      return bytes.slice(0, Math.max(0, maxBytes));
    },
    async readAll(maxBytes) {
      if (bytes.byteLength > maxBytes) {
        throw new ParserError("FILE_TOO_LARGE", `Source exceeds ${maxBytes} bytes`);
      }
      return bytes.slice();
    },
    async *openStream() {
      yield bytes;
    }
  };
}

export function sourceBodyFromBlob(blob: Blob): SourceBody {
  return {
    size: blob.size,
    async readHead(maxBytes) {
      return new Uint8Array(await blob.slice(0, Math.max(0, maxBytes)).arrayBuffer());
    },
    async readAll(maxBytes) {
      if (blob.size > maxBytes) {
        throw new ParserError("FILE_TOO_LARGE", `Source exceeds ${maxBytes} bytes`);
      }
      return new Uint8Array(await blob.arrayBuffer());
    },
    async *openStream() {
      const reader = blob.stream().getReader();
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          yield item.value;
        }
      } finally {
        reader.releaseLock();
      }
    }
  };
}

export async function readParseInput(input: ParseInput, maxBytes = Number.MAX_SAFE_INTEGER): Promise<Uint8Array> {
  return parseInputSource(input).readAll(maxBytes);
}

export function parseInputSource(input: ParseInput): SourceBody {
  if (input.source) return input.source;
  if (input.bytes) return sourceBodyFromBytes(input.bytes);
  throw new ParserError("SOURCE_BODY_MISSING", "Parse input has no source body");
}

export function parseInputSize(input: ParseInput): number {
  return input.size ?? input.source?.size ?? input.bytes?.byteLength ?? 0;
}

export type ProbeInput = ParseInput;
export type ParseRequest = ParseInput;

export interface ProbeResult {
  supported: boolean;
  confidence: number;
  detectedMime?: string;
  reason?: string;
}

export interface ParserDescriptor {
  id: string;
  version: string;
  execution: "local" | "remote";
  supportedKinds: readonly SourceKind[];
  capabilities: {
    sourceMap: boolean;
    assets: boolean;
    resumable: boolean;
  };
}

export interface ParseContext {
  signal: AbortSignal;
  options: Readonly<Record<string, unknown>>;
  reportProgress(progress: ParseProgress): void;
  saveResumeToken(token: string): Promise<void>;
}

export interface DocumentParser {
  readonly descriptor: ParserDescriptor;
  validateOptions(options: Readonly<Record<string, unknown>>): void;
  probe(input: ProbeInput): Promise<ProbeResult> | ProbeResult;
  /**
   * Optional process/runtime fingerprint used only for deterministic cache
   * invalidation. It must never include credentials or transient paths.
   */
  runtimeFingerprint?(
    input: ParseRequest,
    options: Readonly<Record<string, unknown>>,
    signal: AbortSignal
  ): Promise<unknown> | unknown;
  parse(input: ParseRequest, context: ParseContext): Promise<ParsePayload>;
  resume?(input: ParseRequest, token: string, context: ParseContext): Promise<ParsePayload>;
}

export interface ParserSelectionDiagnostic {
  parserId: string;
  parserVersion: string;
  supported: boolean;
  confidence: number;
  reason?: string;
  error?: string;
}

export interface ParserSelection {
  parser: DocumentParser;
  probe: ProbeResult;
  diagnostics: ParserSelectionDiagnostic[];
}

export class ParserError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly details?: Record<string, string | number | boolean>
  ) {
    super(message);
    this.name = "ParserError";
  }
}

export class ParserSelectionError extends ParserError {
  constructor(
    message: string,
    readonly diagnostics: ParserSelectionDiagnostic[]
  ) {
    super("UNSUPPORTED_FORMAT", message, false, {
      probeFailures: diagnostics.filter((item) => item.error).length
    });
    this.name = "ParserSelectionError";
  }
}

export class OcrRequiredError extends ParserError {
  constructor(readonly pages: number[]) {
    super(
      "OCR_REQUIRED",
      `检测到 ${pages.length} 个需要 OCR 的页面：${pages.slice(0, 20).join(", ")}${pages.length > 20 ? "…" : ""}`,
      false,
      { pageCount: pages.length }
    );
    this.name = "OcrRequiredError";
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ParserError("PARSE_CANCELLED", "解析已取消", true);
}

export function numericOption(
  options: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number
): number {
  const value = options[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
