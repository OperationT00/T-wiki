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
  bytes: Uint8Array;
  sourceUri?: string;
  captureContentType?: string;
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
