import { ParserError, sourceBodyFromBytes, throwIfAborted, type ParseContext } from "../parser-types";
import { clearAppTimeout, setAppTimeout } from "../../utils/timers";
import { StreamingMultipartClient, validatedProviderUrl } from "./streaming-multipart-client";
import type {
  MediaMetadata,
  MediaTranscriptionOptions,
  TimedTranscript,
  TimedTranscriptSegment,
  TranscriptionProtocol,
  TranscriptionTransport
} from "./transcript-types";
import { parseVideoVisualOptions } from "./video-visual-options";

export interface TranscriptionCredentials {
  getToken(protocol: TranscriptionProtocol): Promise<string>;
}

abstract class BaseTransport implements TranscriptionTransport {
  abstract readonly protocol: TranscriptionProtocol;
  constructor(
    protected readonly options: MediaTranscriptionOptions,
    protected readonly credentials: TranscriptionCredentials,
    protected readonly client = new StreamingMultipartClient()
  ) {}

  abstract transcribe(source: import("../parser-types").SourceBody, metadata: MediaMetadata, context: ParseContext): Promise<TimedTranscript>;

  async testConnection(signal: AbortSignal): Promise<{ ok: boolean; message: string }> {
    const source = sourceBodyFromBytes(silentWav());
    const result = await this.transcribe(source, { name: "t-wiki-connection-test.wav", mime: "audio/wav", size: source.size! }, {
      signal,
      options: {},
      reportProgress() {},
      async saveResumeToken() {}
    });
    return { ok: true, message: `${this.protocol} 可用（${result.provider}）` };
  }

  protected async post(input: {
    url: string;
    fields: Record<string, string | boolean | number | undefined>;
    fieldName: string;
    source: import("../parser-types").SourceBody;
    metadata: MediaMetadata;
    context: ParseContext;
    requireToken: boolean;
  }) {
    const token = (await this.credentials.getToken(this.protocol)).trim();
    if (input.requireToken && !token) throw new ParserError("TRANSCRIPTION_AUTH_REQUIRED", "远程转写 API Token 未配置");
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await this.client.post({
          url: input.url,
          fields: input.fields,
          file: { fieldName: input.fieldName, fileName: input.metadata.name, mime: input.metadata.mime, source: input.source },
          headers: token ? { authorization: `Bearer ${token}` } : {},
          timeoutMs: this.options.taskTimeoutMs,
          signal: input.context.signal,
          onUploaded: (completed, total) => input.context.reportProgress({
            phase: "uploading",
            completed,
            total,
            unit: "byte",
            mode: total ? "determinate" : "indeterminate",
            message: attempt === 0 ? "正在上传媒体" : `正在重试上传（${attempt + 1}/3）`
          })
        });
        if (response.status >= 200 && response.status < 300) return response;
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        const detail = errorMessage(response.json) ?? `HTTP ${response.status}`;
        throw new ParserError("TRANSCRIPTION_REQUEST_FAILED", `转写请求失败：${detail}`, retryable, { status: response.status });
      } catch (error) {
        lastError = error;
        if (!(error instanceof ParserError) || !error.retryable || attempt === 2) throw error;
        await abortableDelay(500 * (2 ** attempt), input.context.signal);
      }
    }
    throw lastError;
  }
}

export class OpenAITranscriptionTransport extends BaseTransport {
  readonly protocol = "openai-transcriptions" as const;

  async transcribe(source: import("../parser-types").SourceBody, metadata: MediaMetadata, context: ParseContext): Promise<TimedTranscript> {
    throwIfAborted(context.signal);
    if (metadata.size > Math.min(this.options.maxUploadBytes, 25 * 1024 * 1024)) {
      throw new ParserError("TRANSCRIPTION_FILE_TOO_LARGE", "OpenAI-compatible 转写单文件上限为 25 MB，请切换自托管 Whisper");
    }
    const base = validatedProviderUrl(this.options.baseUrl);
    const url = new URL(`${base.pathname.replace(/\/$/, "")}/audio/transcriptions`, base.origin).toString();
    const responseFormat = this.options.responseFormat
      ?? (this.options.diarization ? "diarized_json" : this.options.model === "whisper-1" ? "verbose_json" : "json");
    const response = await this.post({
      url,
      fields: {
        model: this.options.model,
        language: normalizedLanguage(this.options.language),
        response_format: responseFormat,
        chunking_strategy: this.options.diarization ? "auto" : undefined
      },
      fieldName: "file",
      source,
      metadata,
      context,
      requireToken: !isLoopback(base)
    });
    context.reportProgress({ phase: "transcribing", mode: "indeterminate", message: "正在解析转写结果" });
    return parseTranscriptResponse(response.json, response.text, this.protocol, this.options.model, true);
  }
}

export class WhisperAsrTransport extends BaseTransport {
  readonly protocol = "whisper-asr-webservice" as const;

  async transcribe(source: import("../parser-types").SourceBody, metadata: MediaMetadata, context: ParseContext): Promise<TimedTranscript> {
    if (metadata.size > this.options.maxUploadBytes) {
      throw new ParserError("TRANSCRIPTION_FILE_TOO_LARGE", `媒体超过配置的 ${this.options.maxUploadBytes} bytes 上传上限`);
    }
    const base = validatedProviderUrl(this.options.baseUrl);
    const url = new URL(`${base.pathname.replace(/\/$/, "")}/asr`, base.origin);
    url.searchParams.set("output", "json");
    url.searchParams.set("task", "transcribe");
    const language = normalizedLanguage(this.options.language);
    if (language) url.searchParams.set("language", language);
    if (this.options.vadFilter) url.searchParams.set("vad_filter", "true");
    if (this.options.wordTimestamps) url.searchParams.set("word_timestamps", "true");
    if (this.options.diarization) url.searchParams.set("diarization", "true");
    const response = await this.post({
      url: url.toString(),
      fields: {},
      fieldName: "audio_file",
      source,
      metadata,
      context,
      requireToken: false
    });
    return parseTranscriptResponse(response.json, response.text, this.protocol, this.options.model, true);
  }
}

export function parseMediaTranscriptionOptions(input: Readonly<Record<string, unknown>>): MediaTranscriptionOptions {
  const protocol = input.protocol === "whisper-asr-webservice"
    ? "whisper-asr-webservice"
    : "openai-transcriptions";
  const baseUrl = String(input.baseUrl ?? (protocol === "openai-transcriptions" ? "https://api.openai.com/v1" : "http://127.0.0.1:9000"));
  validatedProviderUrl(baseUrl);
  const maxUploadBytes = finite(input.maxUploadBytes, protocol === "openai-transcriptions" ? 25 * 1024 * 1024 : 500 * 1024 * 1024);
  const taskTimeoutMs = finite(input.taskTimeoutMs, 3_600_000);
  if (maxUploadBytes <= 0 || taskTimeoutMs < 1000) throw new ParserError("INVALID_PARSER_OPTIONS", "音视频上传限制或超时配置无效");
  return {
    protocol,
    baseUrl,
    model: String(input.model ?? (protocol === "openai-transcriptions" ? "gpt-4o-mini-transcribe" : "whisper-1")),
    language: String(input.language ?? "auto"),
    responseFormat: typeof input.responseFormat === "string" ? input.responseFormat : undefined,
    vadFilter: input.vadFilter !== false,
    wordTimestamps: input.wordTimestamps === true,
    diarization: input.diarization === true,
    maxUploadBytes,
    taskTimeoutMs,
    visual: parseVideoVisualOptions(input.visual)
  };
}

export function createTranscriptionTransport(
  options: MediaTranscriptionOptions,
  credentials: TranscriptionCredentials
): TranscriptionTransport {
  return options.protocol === "whisper-asr-webservice"
    ? new WhisperAsrTransport(options, credentials)
    : new OpenAITranscriptionTransport(options, credentials);
}

function parseTranscriptResponse(
  json: unknown,
  text: string,
  provider: string,
  model: string,
  generated: boolean
): TimedTranscript {
  const record = json && typeof json === "object" ? json as Record<string, unknown> : undefined;
  const rawSegments = Array.isArray(record?.segments)
    ? record!.segments
    : Array.isArray(record?.utterances) ? record!.utterances : [];
  const segments = rawSegments.flatMap((value): TimedTranscriptSegment[] => {
    if (!value || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    const segmentText = String(item.text ?? item.transcript ?? "").trim();
    if (!segmentText) return [];
    return [{
      startMs: secondsToMs(item.start ?? item.start_time),
      endMs: secondsToMs(item.end ?? item.end_time),
      text: segmentText,
      speaker: typeof item.speaker === "string" ? item.speaker : undefined,
      confidence: typeof item.confidence === "number" ? item.confidence : undefined
    }];
  });
  const plainText = String(record?.text ?? (json === undefined ? text : "")).trim();
  if (segments.length === 0 && plainText) segments.push({ text: plainText });
  if (segments.length === 0) throw new ParserError("TRANSCRIPTION_RESULT_INVALID", "转写服务未返回文字内容");
  return {
    schemaVersion: 1,
    language: typeof record?.language === "string" ? record.language : undefined,
    durationMs: secondsToMs(record?.duration),
    segments,
    provider,
    model,
    generated,
    issues: rawSegments.length === 0
      ? [{ code: "TRANSCRIPT_TIMESTAMPS_MISSING", severity: "warning", message: "服务仅返回纯文本，无法生成精确时间戳" }]
      : []
  };
}

function secondsToMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 1000) : undefined;
}

function errorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const nested = record.error && typeof record.error === "object" ? record.error as Record<string, unknown> : undefined;
  const message = nested?.message ?? record.message ?? record.detail;
  return typeof message === "string" ? message.replace(/(?:Bearer\s+)?[A-Za-z0-9_-]{24,}/g, "[redacted]").slice(0, 500) : undefined;
}

function normalizedLanguage(value: string | undefined): string | undefined {
  const result = value?.trim();
  return !result || result === "auto" ? undefined : result;
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isLoopback(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

function silentWav(): Uint8Array {
  const samples = 1600;
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, 36 + samples * 2, true);
  bytes.set(new TextEncoder().encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode("data"), 36); view.setUint32(40, samples * 2, true);
  return bytes;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timer = setAppTimeout(resolvePromise, ms);
    signal.addEventListener("abort", () => {
      clearAppTimeout(timer);
      reject(new ParserError("PARSE_CANCELLED", "转写已取消"));
    }, { once: true });
  });
}
