import assert from "node:assert/strict";
import test from "node:test";
import { strToU8, zipSync } from "fflate";

import type { HttpClientPort, HttpRequest, HttpResponse } from "../src/parsing/http-client";
import { ParserError, type ParseContext } from "../src/parsing/parser-types";
import {
  MinerUParser,
  type MinerUCredentials
} from "../src/parsing/parsers/mineru-parser";
import { sha256 } from "../src/core/wiki-core";

const CLOUD_TOKEN = "cloud-secret-never-persist";

test("MinerU Cloud v4 uses the official signed-upload contract and selects results by data_id", async () => {
  const archive = cloudArchive();
  const http = new StrictHttp([
    (request) => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "https://mineru.net/api/v4/file-urls/batch");
      assert.deepEqual(request.headers, {
        "content-type": "application/json",
        authorization: `Bearer ${CLOUD_TOKEN}`
      });
      const body = JSON.parse(String(request.body)) as Record<string, unknown>;
      assert.deepEqual(body, {
        files: [{ name: "scan.pdf", data_id: "source-1", is_ocr: true }],
        model_version: "vlm",
        language: "ch",
        enable_table: true,
        enable_formula: true
      });
      assert.equal("is_ocr" in body, false, "is_ocr must be a per-file option");
      return jsonResponse({ code: 0, data: { batch_id: "batch-1", file_urls: ["https://upload.example/signed?secret=x"] } });
    },
    (request) => {
      assert.equal(request.method, "PUT");
      assert.equal(request.url, "https://upload.example/signed?secret=x");
      assert.deepEqual(request.headers ?? {}, {}, "signed PUT must not add Content-Type or Authorization");
      assert.deepEqual(request.body, pdfInput().bytes);
      return bytesResponse(new Uint8Array(), 200);
    },
    (request) => {
      assert.equal(request.method ?? "GET", "GET");
      assert.equal(request.url, "https://mineru.net/api/v4/extract-results/batch/batch-1");
      assert.deepEqual(request.headers, { authorization: `Bearer ${CLOUD_TOKEN}` });
      return jsonResponse({
        code: "0",
        data: {
          extract_result: [
            { data_id: "someone-else", file_name: "other.pdf", state: "done", full_zip_url: "https://evil.example/wrong.zip" },
            { data_id: "source-1", file_name: "scan.pdf", state: "done", full_zip_url: "https://download.example/result.zip" }
          ]
        }
      });
    },
    (request) => {
      assert.equal(request.url, "https://download.example/result.zip");
      assert.equal(request.headers?.authorization, undefined);
      return bytesResponse(archive, 200, { "content-type": "application/zip" });
    }
  ]);
  const parser = cloudParser(http);
  assert.equal(parser.descriptor.version, "1.1.0");
  let resumeToken = "";
  const payload = await parser.parse(pdfInput(), context(cloudOptions(), (token) => { resumeToken = token; }));

  assert.match(payload.markdown, /# Cloud/);
  assert.match(payload.markdown, /llm-wiki-asset:mineru-0001/);
  assert.equal(payload.assets.length, 1);
  const resume = JSON.parse(resumeToken) as Record<string, unknown>;
  assert.equal(resume.v, 2);
  assert.equal(resume.dataId, "source-1");
  assert.equal(resume.id, "batch-1");
  assert.doesNotMatch(resumeToken, /cloud-secret|signed|authorization|upload\.example/i);
  http.assertDone();
});

test("MinerU Cloud accepts every documented in-progress state and rejects unknown states", async () => {
  const progressing = new StrictHttp([
    submitResponse(), uploadResponse(),
    ...["waiting-file", "pending", "running", "converting"].map((state) => pollResponse(state)),
    pollResponse("done", { full_zip_url: "https://download.example/result.zip" }),
    () => bytesResponse(cloudArchive(), 200, { "content-type": "application/zip" })
  ]);
  const payload = await cloudParser(progressing).parse(pdfInput(), context(cloudOptions()));
  assert.match(payload.markdown, /Cloud/);
  progressing.assertDone();

  const unknown = new StrictHttp([submitResponse(), uploadResponse(), pollResponse("mystery")]);
  await expectParserError(
    () => cloudParser(unknown).parse(pdfInput(), context(cloudOptions())),
    "MINERU_RESULT_INVALID",
    false
  );
});

test("MinerU Cloud reports the documented extracted page progress", async () => {
  const http = new StrictHttp([
    submitResponse(),
    uploadResponse(),
    pollResponse("running", {
      extract_progress: { extracted_pages: 4, total_pages: 10 }
    }),
    pollResponse("done", { full_zip_url: "https://download.example/result.zip" }),
    () => bytesResponse(cloudArchive(), 200, { "content-type": "application/zip" })
  ]);
  const progress: import("../src/types").ParseProgress[] = [];
  const parseContext: ParseContext = {
    ...context(cloudOptions()),
    reportProgress: (update) => progress.push(update)
  };

  await cloudParser(http).parse(pdfInput(), parseContext);

  assert.equal(progress.some((update) =>
    update.phase === "mineru-poll"
      && update.completed === 4
      && update.total === 10
      && update.unit === "page"
  ), true);
  assert.equal(progress.some((update) => update.phase === "mineru-download" && update.completed === 1), true);
  http.assertDone();
});

test("MinerU Cloud validates envelopes, upload URLs, completed results, and archives", async (t) => {
  await t.test("missing code is not treated as success", async () => {
    await expectParserError(
      () => cloudParser(new StrictHttp([() => jsonResponse({ data: {} })])).parse(pdfInput(), context(cloudOptions())),
      "MINERU_SUBMIT_FAILED",
      false
    );
  });
  await t.test("invalid signed URL is rejected before upload", async () => {
    await expectParserError(
      () => cloudParser(new StrictHttp([() => jsonResponse({ code: 0, data: { batch_id: "batch", file_urls: ["javascript:alert(1)"] } })]))
        .parse(pdfInput(), context(cloudOptions())),
      "MINERU_RESULT_INVALID",
      false
    );
  });
  await t.test("done without a ZIP URL is rejected", async () => {
    await expectParserError(
      () => cloudParser(new StrictHttp([submitResponse(), uploadResponse(), pollResponse("done")]))
        .parse(pdfInput(), context(cloudOptions())),
      "MINERU_RESULT_INVALID",
      false
    );
  });
  await t.test("invalid ZIP is rejected", async () => {
    await expectParserError(
      () => cloudParser(new StrictHttp([
        submitResponse(), uploadResponse(), pollResponse("done", { full_zip_url: "https://download.example/result.zip" }),
        () => bytesResponse(new Uint8Array([0x50, 0x4b, 1]), 200, { "content-type": "application/zip" })
      ])).parse(pdfInput(), context(cloudOptions())),
      "MINERU_RESULT_INVALID",
      false
    );
  });
  await t.test("ZIP without Markdown is rejected", async () => {
    await expectParserError(
      () => cloudParser(new StrictHttp([
        submitResponse(), uploadResponse(), pollResponse("done", { full_zip_url: "https://download.example/result.zip" }),
        () => bytesResponse(zipSync({ "result/image.png": new Uint8Array([1]) }), 200, { "content-type": "application/zip" })
      ])).parse(pdfInput(), context(cloudOptions())),
      "MINERU_RESULT_INVALID",
      false
    );
  });
  await t.test("ZIP with a non-canonical Markdown file but no full.md is rejected", async () => {
    await expectParserError(
      () => cloudParser(new StrictHttp([
        submitResponse(), uploadResponse(), pollResponse("done", { full_zip_url: "https://download.example/result.zip" }),
        () => bytesResponse(zipSync({ "result/other.md": strToU8("# Wrong artifact") }), 200, { "content-type": "application/zip" })
      ])).parse(pdfInput(), context(cloudOptions())),
      "MINERU_RESULT_INVALID",
      false
    );
  });
});

test("MinerU Cloud classifies string and numeric business codes", async (t) => {
  for (const code of ["A0202", "A0211"]) {
    await t.test(`${code} is a non-retryable authentication error`, async () => {
      const error = await captureParserError(() => cloudParser(new StrictHttp([
        () => jsonResponse({ code, msg: `auth failed ${CLOUD_TOKEN}`, trace_id: "trace-auth" })
      ])).parse(pdfInput(), context(cloudOptions())));
      assert.equal(error.code, "MINERU_SUBMIT_FAILED");
      assert.equal(error.retryable, false);
      assert.equal(error.details?.apiCode, code);
      assert.equal(error.details?.traceId, "trace-auth");
      assert.doesNotMatch(error.message, new RegExp(CLOUD_TOKEN));
    });
  }
  for (const code of [-10001, -60001, -60007, -60008, -60009, -60010, -60020, -60021, -60022]) {
    await t.test(`${code} is retryable`, async () => {
      const error = await captureParserError(() => cloudParser(new StrictHttp([
        () => jsonResponse({ code, msg: "service busy" })
      ])).parse(pdfInput(), context(cloudOptions())));
      assert.equal(error.retryable, true);
      assert.equal(error.details?.apiCode, code);
    });
  }
  for (const code of [-500, -10002, -60002, -60006, -60011, -60019, "UNKNOWN"]) {
    await t.test(`${code} is not retryable`, async () => {
      const error = await captureParserError(() => cloudParser(new StrictHttp([
        () => jsonResponse({ code, msg: "bad input" })
      ])).parse(pdfInput(), context(cloudOptions())));
      assert.equal(error.retryable, false);
    });
  }
});

test("MinerU Cloud retries signed PUT without submitting a second task", async () => {
  let putCount = 0;
  const http = new StrictHttp([
    submitResponse(),
    (request) => {
      putCount += 1;
      assert.equal(request.method, "PUT");
      throw new Error("temporary network outage containing https://upload.example/signed?secret=x");
    },
    (request) => {
      putCount += 1;
      assert.equal(request.method, "PUT");
      return bytesResponse(new Uint8Array(), 429, { "retry-after": "0" });
    },
    (request) => {
      putCount += 1;
      assert.equal(request.method, "PUT");
      return bytesResponse(new Uint8Array(), 200);
    },
    pollResponse("done", { full_zip_url: "https://download.example/result.zip" }),
    () => bytesResponse(cloudArchive(), 200, { "content-type": "application/zip" })
  ]);
  await cloudParser(http).parse(pdfInput(), context(cloudOptions()));
  assert.equal(putCount, 3);
  assert.equal(http.requests.filter((request) => request.method === "POST").length, 1);
  http.assertDone();
});

test("MinerU Cloud retries transient polling failures without resubmitting", async () => {
  const http = new StrictHttp([
    submitResponse(), uploadResponse(),
    () => jsonResponse({ message: "temporary outage" }, 503, { "retry-after": "0" }),
    () => jsonResponse({ code: -60009, msg: "queue full" }, 200, { "retry-after": "0" }),
    pollResponse("done", { full_zip_url: "https://download.example/result.zip" }),
    () => bytesResponse(cloudArchive(), 200, { "content-type": "application/zip" })
  ]);
  const payload = await cloudParser(http).parse(pdfInput(), context(cloudOptions()));
  assert.match(payload.markdown, /Cloud/);
  assert.equal(http.requests.filter((request) => request.method === "POST").length, 1);
  http.assertDone();
});

test("MinerU Cloud cancellation interrupts Retry-After waits", async () => {
  const controller = new AbortController();
  const retryAt = new Date(Date.now() + 60_000).toUTCString();
  const http = new StrictHttp([
    submitResponse(), uploadResponse(),
    () => jsonResponse({ message: "temporary outage" }, 503, { "retry-after": retryAt })
  ]);
  const parseContext = { ...context(cloudOptions()), signal: controller.signal };
  const parsing = cloudParser(http).parse(pdfInput(), parseContext);
  setTimeout(() => controller.abort(), 20);
  await expectParserError(() => parsing, "PARSE_CANCELLED", true);
  http.assertDone();
});

test("MinerU Cloud redacts signed URL queries from terminal upload errors", async () => {
  const http = new StrictHttp([
    submitResponse(),
    ...Array.from({ length: 3 }, () => () => {
      throw new Error("upload failed at https://upload.example/signed?secret=never-log-this");
    })
  ]);
  const error = await captureParserError(() => cloudParser(http).parse(pdfInput(), context(cloudOptions())));
  assert.equal(error.code, "MINERU_UPLOAD_FAILED");
  assert.equal(error.retryable, true);
  assert.doesNotMatch(error.message, /never-log-this/);
  assert.match(error.message, /REDACTED/);
  http.assertDone();
});

test("MinerU Cloud resume supports v1 and v2 tokens without POST or PUT", async (t) => {
  const tokens = [
    JSON.stringify({ v: 1, protocol: "cloud-v4", id: "old-batch", fileName: "scan.pdf" }),
    JSON.stringify({ v: 2, protocol: "cloud-v4", id: "new-batch", fileName: "scan.pdf", dataId: "source-1" })
  ];
  for (const token of tokens) {
    await t.test(`resumes token ${JSON.parse(token).v}`, async () => {
      const expectedBatch = JSON.parse(token).id as string;
      const http = new StrictHttp([
        (request) => {
          assert.equal(request.method ?? "GET", "GET");
          assert.match(request.url, new RegExp(`/batch/${expectedBatch}$`));
          return jsonResponse({
            code: 0,
            data: { extract_result: [{ data_id: "source-1", file_name: "scan.pdf", state: "done", full_zip_url: "https://download.example/result.zip" }] }
          });
        },
        () => bytesResponse(cloudArchive(), 200, { "content-type": "application/zip" })
      ]);
      const payload = await cloudParser(http).resume!(pdfInput(), token, context(cloudOptions()));
      assert.match(payload.markdown, /Cloud/);
      assert.equal(http.requests.some((request) => request.method === "POST" || request.method === "PUT"), false);
      http.assertDone();
    });
  }

  await t.test("rejects a v2 token belonging to another source", async () => {
    const http = new StrictHttp([]);
    const token = JSON.stringify({
      v: 2,
      protocol: "cloud-v4",
      id: "batch-other",
      fileName: "scan.pdf",
      dataId: "another-source"
    });
    await expectParserError(
      () => cloudParser(http).resume!(pdfInput(), token, context(cloudOptions())),
      "MINERU_RESUME_MISMATCH",
      false
    );
    assert.equal(http.requests.length, 0);
  });
});

test("MinerU Cloud connection test distinguishes valid token, auth, base URL, and outage", async (t) => {
  await t.test("missing batch means authenticated and reachable", async () => {
    const parser = cloudParser(new StrictHttp([() => jsonResponse({ code: -60012, msg: "task does not exist" })]));
    assert.equal((await parser.testConnection(cloudOptions())).ok, true);
  });
  for (const code of ["A0202", "A0211"]) {
    await t.test(`${code} fails authentication`, async () => {
      await expectParserError(
        () => cloudParser(new StrictHttp([() => jsonResponse({ code, msg: "invalid token" })])).testConnection(cloudOptions()),
        "MINERU_CONNECTION_FAILED",
        false
      );
    });
  }
  await t.test("HTTP 404 is a bad base URL", async () => {
    await expectParserError(
      () => cloudParser(new StrictHttp([() => jsonResponse({ message: "not found" }, 404)])).testConnection(cloudOptions()),
      "MINERU_CONNECTION_FAILED",
      false
    );
  });
  await t.test("HTTP 503 is retryable", async () => {
    await expectParserError(
      () => cloudParser(new StrictHttp([() => jsonResponse({ message: "down" }, 503)])).testConnection(cloudOptions()),
      "MINERU_CONNECTION_FAILED",
      true
    );
  });
});

test("MinerU validates Cloud option allowlists and endpoint security", async () => {
  const parser = cloudParser(new StrictHttp([]));
  for (const modelVersion of ["pipeline", "vlm"]) {
    assert.doesNotThrow(() => parser.validateOptions({ ...cloudOptions(), modelVersion }));
  }
  for (const modelVersion of ["MinerU-HTML", "future-model", ""]) {
    assert.throws(() => parser.validateOptions({ ...cloudOptions(), modelVersion }), /model|模型/i);
  }
  for (const language of ["ch", "ch_server", "en", "japan", "korean", "chinese_cht", "ta", "te", "ka", "el", "th", "latin", "arabic", "cyrillic", "east_slavic", "devanagari"]) {
    assert.doesNotThrow(() => parser.validateOptions({ ...cloudOptions(), language }));
  }
  assert.throws(() => parser.validateOptions({ ...cloudOptions(), language: "unsupported" }), /language|语言/i);
  assert.throws(() => parser.validateOptions({ protocol: "self-hosted", baseUrl: "http://remote.example" }), /HTTPS/);
  assert.throws(() => parser.validateOptions({ ...cloudOptions(), baseUrl: "https://user:password@mineru.net" }), /敏感|凭据|credential/i);
  assert.throws(() => parser.validateOptions({ ...cloudOptions(), baseUrl: "https://mineru.net?tenant=x" }), /查询参数|query/i);
});

test("MinerU reports missing Cloud credentials without making a request", async () => {
  const http = new StrictHttp([]);
  const parser = new MinerUParser(http, { getToken: async () => "" });
  await expectParserError(() => parser.parse(pdfInput(), context(cloudOptions())), "MINERU_AUTH_MISSING", false);
  assert.equal(http.requests.length, 0);
});

test("MinerU self-hosted keeps health, optional auth, multipart task, polling, and JSON result", async () => {
  const http = new StrictHttp([
    (request) => {
      assert.equal(request.url, "http://127.0.0.1:8000/health");
      assert.equal(request.headers?.authorization, undefined);
      return jsonResponse({ protocol_version: "1" });
    },
    (request) => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "http://127.0.0.1:8000/tasks");
      assert.match(request.headers?.["content-type"] ?? "", /^multipart\/form-data; boundary=/);
      assert.equal(request.headers?.authorization, undefined);
      const body = new TextDecoder().decode(request.body as Uint8Array);
      assert.match(body, /name="is_ocr"\r\n\r\ntrue/);
      assert.match(body, /filename="scan\.pdf"/);
      return jsonResponse({ task_id: "task-1" });
    },
    (request) => {
      assert.equal(request.url, "http://127.0.0.1:8000/tasks/task-1");
      return jsonResponse({ status: "done" });
    },
    (request) => {
      assert.equal(request.url, "http://127.0.0.1:8000/tasks/task-1/result");
      return jsonResponse({ markdown: "# Self hosted\n\nBody.\n" });
    }
  ]);
  const parser = new MinerUParser(http, { getToken: async () => "" });
  assert.equal((await parser.testConnection(selfHostedOptions())).ok, true);
  const payload = await parser.parse(pdfInput(), context(selfHostedOptions()));
  assert.match(payload.markdown, /Self hosted/);
  http.assertDone();
});

type Step = (request: HttpRequest) => HttpResponse | Promise<HttpResponse>;

class StrictHttp implements HttpClientPort {
  readonly requests: HttpRequest[] = [];
  private next = 0;

  constructor(private readonly steps: Step[]) {}

  async request(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const step = this.steps[this.next++];
    if (!step) throw new Error(`Unexpected request #${this.next}: ${request.method ?? "GET"} ${request.url}`);
    return step(request);
  }

  assertDone(): void {
    assert.equal(this.next, this.steps.length, `${this.steps.length - this.next} expected HTTP step(s) were not called`);
  }
}

function cloudParser(http: HttpClientPort): MinerUParser {
  const credentials: MinerUCredentials = { getToken: async () => CLOUD_TOKEN };
  return new MinerUParser(http, credentials);
}

function context(
  options: Record<string, unknown>,
  onResumeToken: (token: string) => void = () => undefined
): ParseContext {
  return {
    signal: new AbortController().signal,
    options,
    reportProgress: () => undefined,
    saveResumeToken: async (token) => { onResumeToken(token); }
  };
}

function pdfInput() {
  const bytes = new TextEncoder().encode("%PDF-test");
  return {
    sourceId: "source-1",
    sourceHash: sha256(bytes),
    kind: "pdf" as const,
    name: "scan.pdf",
    extension: "pdf",
    mime: "application/pdf",
    bytes
  };
}

function cloudOptions(): Record<string, unknown> {
  return {
    protocol: "cloud-v4",
    baseUrl: "https://mineru.net",
    modelVersion: "vlm",
    language: "ch",
    enableTable: true,
    enableFormula: true,
    isOcr: true,
    pollIntervalMs: 250,
    taskTimeoutMs: 10_000
  };
}

function selfHostedOptions(): Record<string, unknown> {
  return {
    protocol: "self-hosted",
    baseUrl: "http://127.0.0.1:8000",
    pollIntervalMs: 250,
    taskTimeoutMs: 10_000
  };
}

function submitResponse(): Step {
  return () => jsonResponse({ code: 0, data: { batch_id: "batch-1", file_urls: ["https://upload.example/signed?secret=x"] } });
}

function uploadResponse(): Step {
  return (request) => {
    assert.equal(request.method, "PUT");
    return bytesResponse(new Uint8Array(), 200);
  };
}

function pollResponse(state: string, fields: Record<string, unknown> = {}): Step {
  return () => jsonResponse({
    code: 0,
    data: { extract_result: [{ data_id: "source-1", file_name: "scan.pdf", state, ...fields }] }
  });
}

function cloudArchive(): Uint8Array {
  return zipSync({
    "result/full.md": strToU8("# Cloud\n\n![figure](images/a.png)\n"),
    "result/images/a.png": new Uint8Array([1, 2, 3])
  });
}

async function captureParserError(run: () => Promise<unknown>): Promise<ParserError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof ParserError, `Expected ParserError, received ${String(error)}`);
    return error;
  }
  assert.fail("Expected operation to reject");
}

async function expectParserError(
  run: () => Promise<unknown>,
  code: string,
  retryable: boolean
): Promise<void> {
  const error = await captureParserError(run);
  assert.equal(error.code, code);
  assert.equal(error.retryable, retryable);
}

function jsonResponse(json: unknown, status = 200, headers: Record<string, string> = {}): HttpResponse {
  const text = JSON.stringify(json);
  return {
    status,
    headers: { "content-type": "application/json", ...headers },
    bytes: new TextEncoder().encode(text),
    text,
    json
  };
}

function bytesResponse(bytes: Uint8Array, status: number, headers: Record<string, string> = {}): HttpResponse {
  return { status, headers, bytes, text: "" };
}
