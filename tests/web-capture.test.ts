import assert from "node:assert/strict";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { createServer } from "node:http";
import test from "node:test";
import { JSDOM } from "jsdom";

import {
  UrlCaptureConnector,
  sourceNameForUrl
} from "../src/connectors/source-connector";
import {
  SafeWebPageFetcher,
  WebCaptureError,
  isPublicAddress,
  validateWebUrl,
  type WebPageFetcherPort
} from "../src/connectors/web-page-fetcher";
import { sha256 } from "../src/core/wiki-core";
import { WebPageParser, decodeHtml } from "../src/parsing/parsers/webpage-parser";
import type { SourceManifest } from "../src/types";

installDomGlobals();

const parseContext = {
  signal: new AbortController().signal,
  options: {},
  reportProgress: () => undefined,
  saveResumeToken: async () => undefined
};

test("webpage parser extracts canonical Markdown, metadata and absolute remote images", async () => {
  const html = `<!doctype html><html><head>
    <title>测试文章</title>
    <meta name="author" content="Alice">
    <meta name="description" content="用于测试的网页">
  </head><body><nav>导航</nav><article>
    <h1>测试文章</h1>
    <p>这是一段足够明确的中文正文，用于验证网页正文提取。</p>
    <p>第二段包含 <strong>重点</strong> 和 <a href="/docs">链接</a>。</p>
    ${Array.from({ length: 16 }, (_, index) => `<p>正文段落 ${index + 3}：网页资料需要被稳定提取、规范化并保存，以便后续检索、审阅和知识整理。</p>`).join("\n")}
    <img src="/image.png" alt="示意图">
  </article><footer>页脚</footer></body></html>`;
  const bytes = new TextEncoder().encode(html);
  const payload = await new WebPageParser().parse({
    sourceId: "web-1",
    sourceHash: sha256(bytes),
    kind: "web",
    name: "article.html",
    extension: "html",
    mime: "text/html",
    bytes,
    sourceUri: "https://example.com/articles/one"
  }, parseContext);
  assert.equal(payload.metadata.title, "测试文章");
  assert.equal(payload.metadata.author, "Alice");
  assert.match(payload.markdown, /这是一段足够明确的中文正文/);
  assert.match(payload.markdown, /https:\/\/example\.com\/docs/);
  assert.match(payload.markdown, /https:\/\/example\.com\/image\.png/);
  assert.doesNotMatch(payload.markdown, /<nav>|页脚/);
  assert.equal(payload.assets.length, 0);
});

test("webpage parser warns for valid short pages and rejects browser-only/access-gate pages", async () => {
  const parser = new WebPageParser();
  const short = new TextEncoder().encode("<!doctype html><html><title>Short</title><body><article><p>Small but valid.</p></article></body></html>");
  const parsed = await parser.parse(input(short), parseContext);
  assert.equal(parsed.issues[0]?.code, "WEB_CONTENT_SPARSE");

  const shell = new TextEncoder().encode("<!doctype html><html><title>App</title><body><div id='app'></div><script src='app.js'></script></body></html>");
  await assert.rejects(() => parser.parse(input(shell), parseContext), (error: unknown) =>
    error instanceof WebCaptureError || (error as { code?: string }).code === "WEB_BROWSER_REQUIRED");

  const blocked = new TextEncoder().encode("<!doctype html><html><title>Wait</title><body><article><p>Checking your browser. Verify you are human. Cloudflare CAPTCHA.</p></article></body></html>");
  await assert.rejects(() => parser.parse(input(blocked), parseContext), (error: unknown) =>
    (error as { code?: string }).code === "WEB_ACCESS_BLOCKED");
});

test("HTML decoder honors HTTP and meta charsets", () => {
  const latin = Uint8Array.from(Buffer.from("<meta charset='windows-1252'><p>caf\xe9</p>", "latin1"));
  assert.match(decodeHtml(latin), /café/);
  assert.match(decodeHtml(latin, "text/html; charset=windows-1252"), /café/);
});

test("safe web fetcher follows controlled redirects and decompresses gzip/brotli", async () => {
  const article = Buffer.from("<!doctype html><html><body><article><p>Hello fetched page.</p></article></body></html>");
  const server = createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/gzip" }).end();
      return;
    }
    if (request.url === "/gzip") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" });
      response.end(gzipSync(article));
      return;
    }
    response.writeHead(200, { "content-type": "text/html", "content-encoding": "br" });
    response.end(brotliCompressSync(article));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert(address && typeof address === "object");
    const fetcher = new SafeWebPageFetcher({ allowPrivateAddresses: true });
    const redirected = await fetcher.fetch(`http://127.0.0.1:${address.port}/redirect`);
    assert.match(new TextDecoder().decode(redirected.bytes), /Hello fetched page/);
    assert.match(redirected.finalUrl, /\/gzip$/);
    const brotli = await fetcher.fetch(`http://127.0.0.1:${address.port}/brotli`);
    assert.match(new TextDecoder().decode(brotli.bytes), /Hello fetched page/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("safe web fetcher validates URLs, address classes, content type and size", async () => {
  assert.throws(() => validateWebUrl("file:///etc/passwd"), /HTTP/);
  assert.throws(() => validateWebUrl("https://user:pass@example.com"), /用户名/);
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("127.0.0.1"), false);
  assert.equal(isPublicAddress("10.0.0.1"), false);
  assert.equal(isPublicAddress("::1"), false);

  const server = createServer((request, response) => {
    if (request.url === "/json") {
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    response.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><p>too large</p>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const fetcher = new SafeWebPageFetcher({ allowPrivateAddresses: true, maxBytes: 8 });
    await assert.rejects(() => fetcher.fetch(`${base}/json`), hasCode("WEB_UNSUPPORTED_CONTENT_TYPE"));
    await assert.rejects(() => fetcher.fetch(`${base}/large`), hasCode("WEB_BODY_TOO_LARGE"));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("safe web fetcher enforces cancellation, timeout and private-address blocking", async () => {
  const server = createServer((_request, response) => {
    setTimeout(() => response.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><p>late</p>"), 80);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/slow`;
    await assert.rejects(
      () => new SafeWebPageFetcher().fetch(url),
      hasCode("WEB_BLOCKED_ADDRESS")
    );
    await assert.rejects(
      () => new SafeWebPageFetcher({ allowPrivateAddresses: true, timeoutMs: 20 }).fetch(url),
      hasCode("WEB_FETCH_TIMEOUT")
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => new SafeWebPageFetcher({ allowPrivateAddresses: true }).fetch(url, controller.signal),
      hasCode("WEB_FETCH_CANCELLED")
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("URL connector forwards HTML provenance and deterministic source names", async () => {
  const bytes = new TextEncoder().encode("<!doctype html><p>Captured</p>");
  const fetcher: WebPageFetcherPort = {
    fetch: async () => ({
      requestedUrl: "https://example.com/start?token=secret",
      finalUrl: "https://example.com/articles/中文标题",
      status: 200,
      contentType: "text/html; charset=utf-8",
      bytes,
      etag: "abc"
    })
  };
  let capturedName = "";
  let capturedProvenance: Record<string, unknown> = {};
  const connector = new UrlCaptureConnector(fetcher);
  await connector.start({
    importSource: async (name, inputBytes, provenance) => {
      capturedName = name;
      capturedProvenance = provenance as unknown as Record<string, unknown>;
      assert.deepEqual(inputBytes, bytes);
      return { manifest: manifest(sha256(inputBytes)), duplicate: false };
    }
  });
  const result = await connector.capture({ url: "https://example.com/start?token=secret" });
  assert.equal(result.duplicate, false);
  assert.equal(capturedName, "中文标题.html");
  assert.equal(capturedProvenance.acquiredBy, "url-capture");
  assert.equal((capturedProvenance.capture as { etag?: string }).etag, "abc");
  assert.equal(sourceNameForUrl("https://example.com/"), "example.com.html");
});

test("URL connector does not call Intake when downloading fails", async () => {
  let imported = false;
  const connector = new UrlCaptureConnector({
    fetch: async () => { throw new WebCaptureError("WEB_NETWORK_ERROR", "network", true); }
  });
  await connector.start({
    importSource: async () => {
      imported = true;
      return { manifest: manifest("0".repeat(64)), duplicate: false };
    }
  });
  await assert.rejects(() => connector.capture({ url: "https://example.com" }), hasCode("WEB_NETWORK_ERROR"));
  assert.equal(imported, false);
});

function input(bytes: Uint8Array) {
  return {
    sourceId: "web-test",
    sourceHash: sha256(bytes),
    kind: "web" as const,
    name: "page.html",
    extension: "html",
    mime: "text/html",
    bytes,
    sourceUri: "https://example.com/page"
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof WebCaptureError && error.code === code;
}

function installDomGlobals(): void {
  const window = new JSDOM("<!doctype html><html><body></body></html>").window;
  Object.assign(globalThis, {
    DOMParser: window.DOMParser,
    document: window.document,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement
  });
}

function manifest(sourceHash: string): SourceManifest {
  return {
    schemaVersion: 3,
    manifestRevision: 1,
    sourceId: "source-web",
    sourceHash,
    source: { kind: "web", acquiredBy: "url-capture" },
    original: {
      name: "page.html",
      extension: "html",
      mime: "text/html",
      size: 1,
      objectPath: ".llm-wiki/objects/page.html",
      importedAt: "2026-07-26T00:00:00.000Z"
    },
    parse: { status: "queued", revisions: [], attempts: [] },
    ingest: { status: "not_started", attempts: [] }
  };
}
