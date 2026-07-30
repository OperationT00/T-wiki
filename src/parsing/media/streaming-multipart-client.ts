import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { clearAppTimeout, setAppTimeout } from "../../utils/timers";

import { ParserError, throwIfAborted, type SourceBody } from "../parser-types";

export interface MultipartFile {
  fieldName: string;
  fileName: string;
  mime: string;
  source: SourceBody;
}

export interface MultipartResponse {
  status: number;
  headers: Record<string, string>;
  bytes: Uint8Array;
  text: string;
  json?: unknown;
}

export class StreamingMultipartClient {
  async post(input: {
    url: string;
    fields: Record<string, string | boolean | number | undefined>;
    file: MultipartFile;
    headers?: Record<string, string>;
    timeoutMs: number;
    signal: AbortSignal;
    onUploaded?: (bytes: number, total?: number) => void;
  }): Promise<MultipartResponse> {
    const url = validatedProviderUrl(input.url);
    const boundary = `----t-wiki-${crypto.randomUUID()}`;
    const prefix = multipartPrefix(boundary, input.fields, input.file);
    const suffix = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
    const contentLength = input.file.source.size === undefined
      ? undefined
      : prefix.byteLength + input.file.source.size + suffix.byteLength;
    return new Promise<MultipartResponse>((resolvePromise, reject) => {
      const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
      const request = requestFn(url, {
        method: "POST",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
          ...(contentLength === undefined ? {} : { "content-length": String(contentLength) }),
          ...(input.headers ?? {})
        }
      }, (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.byteLength;
          if (length > 20 * 1024 * 1024) {
            request.destroy(new Error("TRANSCRIPTION_RESPONSE_TOO_LARGE"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const bytes = new Uint8Array(Buffer.concat(chunks));
          const text = new TextDecoder().decode(bytes);
          let json: unknown;
          try { json = JSON.parse(text); } catch { json = undefined; }
          resolvePromise({
            status: response.statusCode ?? 0,
            headers: normalizeHeaders(response.headers),
            bytes,
            text,
            json
          });
        });
      });
      const timeout = setAppTimeout(() => request.destroy(new Error("TRANSCRIPTION_TIMEOUT")), input.timeoutMs);
      const abort = (): void => { request.destroy(new Error("TRANSCRIPTION_CANCELLED")); };
      input.signal.addEventListener("abort", abort, { once: true });
      request.once("error", (error) => reject(new ParserError(
        error.message === "TRANSCRIPTION_CANCELLED" ? "PARSE_CANCELLED" : "TRANSCRIPTION_NETWORK_ERROR",
        sanitizeNetworkError(error.message),
        error.message !== "TRANSCRIPTION_CANCELLED"
      )));
      request.once("close", () => {
        clearAppTimeout(timeout);
        input.signal.removeEventListener("abort", abort);
      });
      void (async () => {
        try {
          throwIfAborted(input.signal);
          request.write(prefix);
          let uploaded = 0;
          for await (const chunk of input.file.source.openStream()) {
            throwIfAborted(input.signal);
            if (!request.write(chunk)) await drain(request);
            uploaded += chunk.byteLength;
            input.onUploaded?.(uploaded, input.file.source.size);
          }
          request.end(suffix);
        } catch (error) {
          request.destroy(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    });
  }
}

export function validatedProviderUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ParserError("INVALID_PROVIDER_URL", "转写 Base URL 无效"); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new ParserError("INVALID_PROVIDER_URL", "转写地址必须为不含用户信息的 HTTP/HTTPS URL");
  }
  if (url.search || url.hash) throw new ParserError("INVALID_PROVIDER_URL", "转写 Base URL 不能包含 query 或 fragment");
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !loopback) {
    throw new ParserError("INSECURE_PROVIDER_URL", "非本机转写服务必须使用 HTTPS");
  }
  return url;
}

function multipartPrefix(
  boundary: string,
  fields: Record<string, string | boolean | number | undefined>,
  file: MultipartFile
): Uint8Array {
  let value = "";
  for (const [name, fieldValue] of Object.entries(fields)) {
    if (fieldValue === undefined) continue;
    value += `--${boundary}\r\nContent-Disposition: form-data; name="${headerValue(name)}"\r\n\r\n${String(fieldValue)}\r\n`;
  }
  value += `--${boundary}\r\nContent-Disposition: form-data; name="${headerValue(file.fieldName)}"; filename="${headerValue(file.fileName)}"\r\nContent-Type: ${headerValue(file.mime)}\r\n\r\n`;
  return new TextEncoder().encode(value);
}

function headerValue(value: string): string {
  return value.replace(/[\r\n"\\]/g, "_").slice(0, 240);
}

function normalizeHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).flatMap(([key, value]) =>
    value === undefined ? [] : [[key.toLocaleLowerCase(), Array.isArray(value) ? value.join(", ") : value]]
  ));
}

function drain(request: ReturnType<typeof httpRequest>): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    request.once("drain", resolvePromise);
    request.once("error", reject);
  });
}

function sanitizeNetworkError(message: string): string {
  return message.replace(/https?:\/\/[^\s]+/gi, "[provider-url]").slice(0, 500);
}
