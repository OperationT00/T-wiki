import { lookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { BlockList, isIP } from "node:net";
import type { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

export interface WebPageFetchResult {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string;
  bytes: Uint8Array;
  etag?: string;
  lastModified?: string;
}

export interface WebPageFetcherPort {
  fetch(url: string, signal?: AbortSignal): Promise<WebPageFetchResult>;
}

export interface SafeWebPageFetcherOptions {
  maxRedirects?: number;
  timeoutMs?: number;
  maxBytes?: number;
  /** Tests only. Production composition must keep this false. */
  allowPrivateAddresses?: boolean;
}

export class WebCaptureError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false
  ) {
    super(message);
    this.name = "WebCaptureError";
  }
}

export class SafeWebPageFetcher implements WebPageFetcherPort {
  private readonly options: Required<SafeWebPageFetcherOptions>;

  constructor(options: SafeWebPageFetcherOptions = {}) {
    this.options = {
      maxRedirects: options.maxRedirects ?? 5,
      timeoutMs: options.timeoutMs ?? 30_000,
      maxBytes: options.maxBytes ?? 10 * 1024 * 1024,
      allowPrivateAddresses: options.allowPrivateAddresses ?? false
    };
  }

  async fetch(input: string, signal?: AbortSignal): Promise<WebPageFetchResult> {
    const requested = validateWebUrl(input);
    const deadline = Date.now() + this.options.timeoutMs;
    return this.fetchRedirect(requested, requested, 0, deadline, signal);
  }

  private async fetchRedirect(
    requested: URL,
    current: URL,
    redirects: number,
    deadline: number,
    signal?: AbortSignal
  ): Promise<WebPageFetchResult> {
    if (signal?.aborted) throw new WebCaptureError("WEB_FETCH_CANCELLED", "网页抓取已取消", true);
    if (Date.now() >= deadline) throw new WebCaptureError("WEB_FETCH_TIMEOUT", "网页抓取超时", true);
    const address = await this.resolveAddress(current.hostname);
    const response = await this.requestOnce(current, address, deadline, signal);
    const location = response.headers.location;
    if (response.status >= 300 && response.status < 400 && location) {
      response.stream.resume();
      if (redirects >= this.options.maxRedirects) {
        throw new WebCaptureError("WEB_TOO_MANY_REDIRECTS", "网页重定向次数过多");
      }
      let next: URL;
      try {
        next = validateWebUrl(new URL(location, current).toString());
      } catch {
        throw new WebCaptureError("WEB_REDIRECT_INVALID", "网页返回了无效的重定向地址");
      }
      return this.fetchRedirect(requested, next, redirects + 1, deadline, signal);
    }
    if (response.status < 200 || response.status >= 300) {
      response.stream.resume();
      throw new WebCaptureError(
        "WEB_HTTP_STATUS",
        `网页请求失败（HTTP ${response.status}）`,
        response.status === 408 || response.status === 429 || response.status >= 500
      );
    }

    const contentType = headerValue(response.headers["content-type"]) ?? "";
    const mediaType = contentType.split(";", 1)[0]!.trim().toLocaleLowerCase();
    if (mediaType && mediaType !== "text/html" && mediaType !== "application/xhtml+xml") {
      response.stream.resume();
      throw new WebCaptureError("WEB_UNSUPPORTED_CONTENT_TYPE", `网页响应不是 HTML（${mediaType}）`);
    }
    const bytes = await readResponseBytes(
      response.stream,
      headerValue(response.headers["content-encoding"]),
      this.options.maxBytes,
      signal,
      Math.max(1, deadline - Date.now())
    );
    if (!mediaType && !looksLikeHtml(bytes)) {
      throw new WebCaptureError("WEB_UNSUPPORTED_CONTENT_TYPE", "网页响应缺少 HTML Content-Type，且内容不是 HTML");
    }
    return {
      requestedUrl: requested.toString(),
      finalUrl: current.toString(),
      status: response.status,
      contentType: contentType || "text/html",
      bytes,
      etag: headerValue(response.headers.etag),
      lastModified: headerValue(response.headers["last-modified"])
    };
  }

  private async resolveAddress(hostnameInput: string): Promise<{ address: string; family: 4 | 6 }> {
    const hostname = hostnameInput.replace(/^\[|\]$/g, "");
    const literalFamily = isIP(hostname);
    const addresses = literalFamily
      ? [{ address: hostname, family: literalFamily as 4 | 6 }]
      : await lookup(hostname, { all: true, verbatim: true });
    if (addresses.length === 0) {
      throw new WebCaptureError("WEB_DNS_FAILED", "无法解析网页域名", true);
    }
    if (!this.options.allowPrivateAddresses && addresses.some((item) => !isPublicAddress(item.address))) {
      throw new WebCaptureError("WEB_BLOCKED_ADDRESS", "出于安全原因，不能抓取本机、内网或保留地址");
    }
    return addresses[0] as { address: string; family: 4 | 6 };
  }

  private requestOnce(
    url: URL,
    address: { address: string; family: 4 | 6 },
    deadline: number,
    signal?: AbortSignal
  ): Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
    stream: http.IncomingMessage;
  }> {
    return new Promise((resolve, reject) => {
      const transport = url.protocol === "https:" ? https : http;
      const request = transport.request({
        protocol: url.protocol,
        hostname: address.address,
        family: address.family,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        agent: false,
        servername: url.protocol === "https:" ? url.hostname.replace(/^\[|\]$/g, "") : undefined,
        headers: {
          Host: url.host,
          Accept: "text/html,application/xhtml+xml;q=0.9",
          Connection: "close",
          "Accept-Encoding": "gzip, deflate, br",
          "User-Agent": "LLM-Wiki/0.1 (+Obsidian; deterministic web capture)"
        }
      }, (response) => {
        request.setTimeout(0);
        cleanup();
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          stream: response
        });
      });
      const remaining = Math.max(1, deadline - Date.now());
      request.setTimeout(remaining, () => {
        request.destroy(new WebCaptureError("WEB_FETCH_TIMEOUT", "网页抓取超时", true));
      });
      const abort = (): void => {
        request.destroy(new WebCaptureError("WEB_FETCH_CANCELLED", "网页抓取已取消", true));
      };
      const cleanup = (): void => signal?.removeEventListener("abort", abort);
      signal?.addEventListener("abort", abort, { once: true });
      request.on("error", (error) => {
        cleanup();
        reject(error instanceof WebCaptureError
          ? error
          : new WebCaptureError("WEB_NETWORK_ERROR", "网页网络请求失败", true));
      });
      request.end();
    });
  }
}

export function validateWebUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new WebCaptureError("WEB_URL_INVALID", "请输入有效的网页地址");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebCaptureError("WEB_URL_INVALID", "网页地址只支持 HTTP 或 HTTPS");
  }
  if (url.username || url.password) {
    throw new WebCaptureError("WEB_URL_CREDENTIALS", "网页地址不能包含用户名或密码");
  }
  return url;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split(".").map(Number);
    if (parts.length !== 4 || parts.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
      return false;
    }
    const value = (((parts[0]! << 24) >>> 0)
      + (parts[1]! << 16)
      + (parts[2]! << 8)
      + parts[3]!) >>> 0;
    return !IPV4_BLOCKS.some(([base, prefix]) => inIpv4Subnet(value, base, prefix));
  }
  if (family === 6) return !IPV6_BLOCKLIST.check(address, "ipv6");
  return false;
}

async function readResponseBytes(
  response: http.IncomingMessage,
  encodingInput: string | undefined,
  maxBytes: number,
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<Uint8Array> {
  const encoding = encodingInput?.split(",", 1)[0]?.trim().toLocaleLowerCase();
  let stream: Readable = response;
  if (encoding === "gzip" || encoding === "x-gzip") stream = response.pipe(createGunzip());
  else if (encoding === "deflate") stream = response.pipe(createInflate());
  else if (encoding === "br") stream = response.pipe(createBrotliDecompress());
  else if (encoding && encoding !== "identity") {
    response.resume();
    throw new WebCaptureError("WEB_UNSUPPORTED_ENCODING", `不支持网页压缩格式：${encoding}`);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const abort = (): void => {
      stream.destroy(new WebCaptureError("WEB_FETCH_CANCELLED", "网页抓取已取消", true));
    };
    const timeout = setTimeout(() => {
      stream.destroy(new WebCaptureError("WEB_FETCH_TIMEOUT", "网页抓取超时", true));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    };
    signal?.addEventListener("abort", abort, { once: true });
    stream.on("data", (chunk: Buffer | Uint8Array) => {
      const buffer = Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > maxBytes) {
        stream.destroy(new WebCaptureError("WEB_BODY_TOO_LARGE", "网页 HTML 超过 10 MiB 限制"));
        return;
      }
      chunks.push(buffer);
    });
    stream.on("end", () => {
      cleanup();
      resolve(new Uint8Array(Buffer.concat(chunks)));
    });
    stream.on("error", (error) => {
      cleanup();
      reject(error instanceof WebCaptureError
        ? error
        : new WebCaptureError("WEB_DECOMPRESSION_FAILED", "网页响应解压失败", true));
    });
  });
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function looksLikeHtml(bytes: Uint8Array): boolean {
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, Math.min(bytes.length, 2048)))
    .replace(/^\uFEFF/, "")
    .trimStart();
  return /^<(?:!doctype\s+html|html|head|body|meta|title|article)(?:\s|>)/i.test(head);
}

function inIpv4Subnet(value: number, base: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) >>> 0 === (base & mask) >>> 0;
}

function ipv4(a: number, b: number, c: number, d: number): number {
  return (((a << 24) >>> 0) + (b << 16) + (c << 8) + d) >>> 0;
}

const IPV4_BLOCKS: Array<[number, number]> = [
  [ipv4(0, 0, 0, 0), 8], [ipv4(10, 0, 0, 0), 8], [ipv4(100, 64, 0, 0), 10],
  [ipv4(127, 0, 0, 0), 8], [ipv4(169, 254, 0, 0), 16], [ipv4(172, 16, 0, 0), 12],
  [ipv4(192, 0, 0, 0), 24], [ipv4(192, 0, 2, 0), 24], [ipv4(192, 168, 0, 0), 16],
  [ipv4(198, 18, 0, 0), 15], [ipv4(198, 51, 100, 0), 24], [ipv4(203, 0, 113, 0), 24],
  [ipv4(224, 0, 0, 0), 4], [ipv4(240, 0, 0, 0), 4]
];

const IPV6_BLOCKLIST = new BlockList();
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["fc00::", 7],
  ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32]
] as Array<[string, number]>) {
  IPV6_BLOCKLIST.addSubnet(network, prefix, "ipv6");
}
