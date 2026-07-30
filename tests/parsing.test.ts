import assert from "node:assert/strict";
import test from "node:test";
import type { DataAdapter } from "obsidian";

import { DEFAULT_CONFIG, sha256 } from "../src/core/wiki-core";
import { mergeConfig } from "../src/core/wiki-config";
import { indexMarkdownBlocks } from "../src/parsing/block-indexer";
import { migrateSourceRawReference } from "../src/parsing/migration";
import { MarkdownParser } from "../src/parsing/parsers/markdown-parser";
import { isOcrCandidate, reconstructPdfLines } from "../src/parsing/parsers/pdf-parser";
import { TextParser } from "../src/parsing/parsers/text-parser";
import { OcrRequiredError, ParserError, type DocumentParser } from "../src/parsing/parser-types";
import { ParserRegistry } from "../src/parsing/parser-registry";
import { ParsingService } from "../src/services/parsing-service";
import { normalizeManifest, SourceStore } from "../src/services/source-store";

const context = {
  signal: new AbortController().signal,
  options: {},
  reportProgress: () => undefined,
  saveResumeToken: async () => undefined
};

test("markdown parser preserves body and extracts source metadata", async () => {
  const source = `---
title: 测试文档
author:
  - Alice
tags: [one, two]
---
# 标题

正文。
`;
  const bytes = new TextEncoder().encode(source);
  const parsed = await new MarkdownParser().parse({
    sourceId: "one",
    sourceHash: sha256(bytes),
    kind: "markdown",
    name: "one.md",
    extension: "md",
    mime: "text/markdown",
    bytes
  }, context);
  assert.equal(parsed.metadata.title, "测试文档");
  assert.deepEqual(parsed.metadata.author, ["Alice"]);
  assert.match(parsed.markdown, /^# 标题/m);
  assert.doesNotMatch(parsed.markdown, /^---/);
});

test("markdown parser retains malformed frontmatter as content and warns", async () => {
  const bytes = new TextEncoder().encode("---\ntitle: [broken\n# 正文\n");
  const parsed = await new MarkdownParser().parse({
    sourceId: "one",
    sourceHash: sha256(bytes),
    kind: "markdown",
    name: "broken.md",
    extension: "md",
    mime: "text/markdown",
    bytes
  }, context);
  assert.equal(parsed.issues[0]?.code, "MARKDOWN_FRONTMATTER_INVALID");
  assert.match(parsed.markdown, /title: \[broken/);
});

test("text parser decodes UTF-16LE BOM and rejects unknown encoding", async () => {
  const utf16 = new Uint8Array([0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65]);
  const parser = new TextParser();
  const parsed = await parser.parse({
    sourceId: "one",
    sourceHash: sha256(utf16),
    kind: "text",
    name: "one.txt",
    extension: "txt",
    mime: "text/plain",
    bytes: utf16
  }, context);
  assert.equal(parsed.markdown.trim(), "中文");

  const invalid = new Uint8Array([0xc3, 0x28]);
  await assert.rejects(() => parser.parse({
    sourceId: "two",
    sourceHash: sha256(invalid),
    kind: "text",
    name: "bad.txt",
    extension: "txt",
    mime: "text/plain",
    bytes: invalid
  }, context), (error: unknown) => error instanceof ParserError && error.code === "UNSUPPORTED_ENCODING");
});

test("PDF line reconstruction uses coordinates and hasEOL", () => {
  const lines = reconstructPdfLines([
    { str: "世界", transform: [1, 0, 0, 12, 40, 100], width: 24, height: 12, hasEOL: true },
    { str: "Hello", transform: [1, 0, 0, 12, 0, 100], width: 30, height: 12 },
    { str: "下一行", transform: [1, 0, 0, 12, 0, 80], width: 36, height: 12 }
  ]);
  assert.deepEqual(lines.map((line) => line.text), ["Hello 世界", "下一行"]);
  assert.equal(lines[0]?.forcedBreak, true);
  assert.equal(isOcrCandidate(12, true, 40), true);
  assert.equal(isOcrCandidate(0, false, 40), false);
});

test("parsing service publishes deterministic raw markdown and detects tampering", async () => {
  const adapter = new MemoryAdapter();
  const service = new ParsingService(adapter as unknown as DataAdapter, DEFAULT_CONFIG);
  const bytes = new TextEncoder().encode("# API 幂等性\n\n正文。\n");
  const imported = await service.importBytes("API 幂等性.md", bytes);
  assert.equal(imported.parse.status, "parsed");
  assert.equal(imported.parse.revisions.length, 1);
  const first = imported.parse.revisions[0]!;
  assert.match(first.rawPath, /^raw\/articles\/api-幂等性--[a-f0-9]{8}\.md$/);
  assert.equal((await service.verifyRaw())[0]?.ok, true);

  const duplicate = await service.importBytes("duplicate.md", bytes);
  assert.equal(duplicate.sourceId, imported.sourceId);
  assert.equal(duplicate.parse.revisions.length, 1);

  const reparsed = await service.parseSource(imported.sourceId, true);
  assert.equal(reparsed.parse.revisions.length, 2);
  assert.equal(reparsed.parse.revisions[0]?.contentHash, reparsed.parse.revisions[1]?.contentHash);
  assert.equal(reparsed.parse.revisions[0]?.artifactHash, reparsed.parse.revisions[1]?.artifactHash);

  const ingest = await service.beginIngest(imported.sourceId);
  await service.updateIngestAttempt(imported.sourceId, ingest.attemptId, "ingest_failed", {
    error: service.pipelineError(new Error("invalid plan"), "plan")
  });
  const failedIngest = await service.getSource(imported.sourceId);
  assert.equal(failedIngest.parse.status, "parsed");
  assert.equal(failedIngest.ingest.status, "ingest_failed");

  const current = reparsed.parse.revisions[1]!;
  await adapter.write(current.rawPath, `${await adapter.read(current.rawPath)}篡改`);
  const verification = await service.verifyRaw();
  assert.equal(verification[0]?.ok, false);
  await assert.rejects(() => service.beginIngest(imported.sourceId), /artifactHash/);
});

test("parsing service emits monotonic realtime progress and persists completion", async () => {
  const adapter = new MemoryAdapter();
  const service = new ParsingService(adapter as unknown as DataAdapter, DEFAULT_CONFIG);
  const events: import("../src/types").ParseProgressEvent[] = [];
  const unsubscribe = service.subscribeProgress((event) => events.push(event));
  const bytes = new TextEncoder().encode("# Progress\n\nBody.\n");

  const imported = await service.importBytes("progress.md", bytes);
  unsubscribe();

  assert.ok(events.length >= 6);
  assert.deepEqual(
    events.map((event) => event.percent),
    [...events.map((event) => event.percent)].sort((a, b) => (a ?? 0) - (b ?? 0))
  );
  assert.equal(events.at(-1)?.state, "completed");
  assert.equal(events.at(-1)?.percent, 100);
  assert.equal(events.some((event) => event.phase === "normalizing"), true);
  assert.equal(events.some((event) => event.phase === "publishing"), true);
  assert.equal(imported.parse.attempts.at(-1)?.progress?.percent, 100);
  assert.equal(imported.parse.attempts.at(-1)?.progress?.mode, "determinate");
});

test("v1 source reference migration fills empty hash and rejects conflicts", () => {
  const source = `---
schema_version: 1
type: source
title: Old
tldr: old
status: draft
created: 2026-01-01
updated: 2026-01-01
tags: []
related: []
source_type: article
author: ""
url: ""
raw_path: raw/documents/old.pdf
raw_hash: ""
---
# Old
`;
  const migrated = migrateSourceRawReference(
    "wiki/sources/old.md",
    source,
    "raw/documents/old.pdf",
    "raw/documents/old--12345678.md",
    "12345678"
  );
  assert.equal(migrated.changed, true);
  assert.match(migrated.content, /raw_path: raw\/documents\/old--12345678\.md/);
  assert.match(migrated.content, /raw_hash: "12345678"/);
  assert.throws(() => migrateSourceRawReference(
    "wiki/sources/old.md",
    source.replace('raw_hash: ""', "raw_hash: other"),
    "raw/documents/old.pdf",
    "raw/documents/old--12345678.md",
    "12345678"
  ), /raw_hash/);
});

test("parse failure does not publish raw markdown", async () => {
  const adapter = new MemoryAdapter();
  const service = new ParsingService(adapter as unknown as DataAdapter, DEFAULT_CONFIG);
  const manifest = await service.importBytes("broken.txt", new Uint8Array([0xc3, 0x28]));
  assert.equal(manifest.parse.status, "parse_failed");
  assert.equal(manifest.parse.revisions.length, 0);
  const raw = await adapter.list("raw/articles");
  assert.deepEqual(raw.files, []);
});

test("manifest CAS rejects stale revisions", async () => {
  const adapter = new MemoryAdapter();
  const service = new ParsingService(adapter as unknown as DataAdapter, DEFAULT_CONFIG);
  const manifest = await service.importBytes("one.md", new TextEncoder().encode("# One"));
  const store = new SourceStore(adapter as unknown as DataAdapter, DEFAULT_CONFIG.paths.internal);
  await assert.rejects(() => store.updateManifest(
    manifest.sourceId,
    manifest.manifestRevision - 1,
    (current) => current
  ), /MANIFEST_CONFLICT/);
  const current = await store.readManifest(manifest.sourceId);
  assert.equal(current.parse.revisions.length, 1);
});

test("startup recovery marks interrupted parse as retryable failure", async () => {
  const adapter = new MemoryAdapter();
  const service = new ParsingService(adapter as unknown as DataAdapter, DEFAULT_CONFIG);
  const manifest = await service.importBytes("one.md", new TextEncoder().encode("# One"));
  const store = new SourceStore(adapter as unknown as DataAdapter, DEFAULT_CONFIG.paths.internal);
  await store.updateManifest(manifest.sourceId, manifest.manifestRevision, (current) => {
    current.parse.status = "parsing";
    current.parse.startedAt = new Date().toISOString();
    return current;
  });
  const recoveredService = new ParsingService(adapter as unknown as DataAdapter, DEFAULT_CONFIG);
  await recoveredService.initialize();
  const recovered = await recoveredService.getSource(manifest.sourceId);
  assert.equal(recovered.parse.status, "parse_failed");
  assert.equal(recovered.parse.error?.code, "INTERRUPTED");
  assert.equal(recovered.parse.error?.retryable, true);
});

test("parser registry is explicit, deterministic, and isolates probe failures", async () => {
  const low = fakeParser("low", "text", 0.8);
  const highPriority = fakeParser("priority", "text", 0.8);
  const broken = fakeParser("broken", "text", 1, true);
  const registry = new ParserRegistry([low, highPriority, broken]);
  assert.throws(() => registry.register(low), /PARSER_ALREADY_REGISTERED/);
  const bytes = new TextEncoder().encode("hello");
  const selection = await registry.select({
    sourceId: "registry",
    sourceHash: sha256(bytes),
    kind: "unknown",
    name: "sample.custom",
    extension: "custom",
    mime: "application/octet-stream",
    bytes
  }, {
    low: { enabled: true, priority: 1, options: {} },
    priority: { enabled: true, priority: 10, options: {} },
    broken: { enabled: true, priority: 100, options: {} }
  });
  assert.equal(selection.parser.descriptor.id, "priority");
  assert.equal(selection.diagnostics.find((item) => item.parserId === "broken")?.supported, false);
  assert.match(selection.diagnostics.find((item) => item.parserId === "broken")?.error ?? "", /probe failed/);
});

test("block indexer is deterministic and does not index markers inside code fences", () => {
  const markdown = `# Heading

Paragraph.

\`\`\`text
<!-- llm-wiki:block=b999999 -->
\`\`\`
`;
  const first = indexMarkdownBlocks(markdown, { kind: "markdown" });
  const second = indexMarkdownBlocks(first.markdown, { kind: "markdown" });
  assert.equal(first.markdown, second.markdown);
  assert.deepEqual(first.entries.map((entry) => entry.blockId), ["b000001", "b000002", "b000003"]);
  assert.equal(first.entries[2]?.type, "code");
  assert.match(first.markdown, /<!-- llm-wiki:block=b999999 -->/);
});

test("block indexer maps PDF blocks to the active page marker", () => {
  const indexed = indexMarkdownBlocks(`<!-- llm-wiki:page=1 -->

# First

<!-- llm-wiki:page=2 -->

Second page.
`, { kind: "pdf" });
  assert.deepEqual(indexed.entries.map((entry) =>
    entry.source.kind === "pdf" ? entry.source.page : 0
  ), [1, 2]);
});

test("block indexer keeps a contiguous Markdown list in one source block", () => {
  const indexed = indexMarkdownBlocks("- one\n- two\n  - nested\n", { kind: "markdown" });
  assert.equal(indexed.entries.length, 1);
  assert.equal(indexed.entries[0]?.type, "list");
});

test("new parser registration completes the pipeline without orchestrator changes", async () => {
  const adapter = new MemoryAdapter();
  const htmlParser: DocumentParser = {
    descriptor: {
      id: "fake-html",
      version: "1.0.0",
      execution: "local",
      supportedKinds: ["web"],
      capabilities: { sourceMap: false, assets: false, resumable: false }
    },
    validateOptions: () => undefined,
    probe: (input) => ({
      supported: input.extension === "html",
      confidence: input.extension === "html" ? 1 : 0,
      detectedMime: "text/html"
    }),
    parse: async () => ({
      schemaVersion: 2,
      markdown: "# Imported HTML\n\nConverted body.\n",
      metadata: { title: "Imported HTML" },
      assets: [],
      issues: []
    })
  };
  const service = new ParsingService(
    adapter as unknown as DataAdapter,
    DEFAULT_CONFIG,
    undefined,
    new ParserRegistry([htmlParser])
  );
  const imported = await service.importSource(
    "page.html",
    new TextEncoder().encode("<h1>Imported HTML</h1>"),
    {
      kind: "web",
      uri: "https://user:pass@example.com/page?token=secret&lang=zh",
      requestedUri: "https://example.com/start?signature=secret",
      capturedAt: "2026-07-25T00:00:00.000Z",
      acquiredBy: "test",
      capture: {
        status: 200,
        contentType: "text/html; charset=utf-8",
        etag: "etag-one"
      }
    }
  );
  assert.equal(imported.parse.status, "parsed");
  assert.equal(imported.source.kind, "web");
  assert.equal(imported.source.requestedUri, "https://example.com/start?signature=%5BREDACTED%5D");
  assert.equal(imported.source.capture?.etag, "etag-one");
  assert.equal(imported.original.mime, "text/html");
  const revision = imported.parse.revisions[0]!;
  assert.equal(revision.artifactSchemaVersion, 3);
  assert.equal(revision.sourceMapPath, undefined);
  const raw = await adapter.read(revision.rawPath);
  assert.match(raw, /schema_version: 3/);
  assert.match(raw, /source_kind: web/);
  assert.match(raw, /source_uri: https:\/\/example.com\/page\?token=%5BREDACTED%5D&lang=zh/);
  assert.doesNotMatch(raw, /user:pass/);
  assert.doesNotMatch(raw, /<!--\s*llm-wiki:(?:block|page)=/);
  assert.match(raw, /# Imported HTML\n\nConverted body\./);
  assert.equal((await service.verifyRaw())[0]?.ok, true);
});

test("PDF OCR failure falls back to MinerU with independent parse attempts", async () => {
  const adapter = new MemoryAdapter();
  const localPdf: DocumentParser = {
    descriptor: {
      id: "pdfjs-layout",
      version: "1.0.0",
      execution: "local",
      supportedKinds: ["pdf"],
      capabilities: { sourceMap: true, assets: false, resumable: false }
    },
    validateOptions: () => undefined,
    probe: () => ({ supported: true, confidence: 1, detectedMime: "application/pdf" }),
    parse: async () => { throw new OcrRequiredError([1]); }
  };
  const mineru: DocumentParser = {
    descriptor: {
      id: "mineru-http",
      version: "1.0.0",
      execution: "remote",
      supportedKinds: ["pdf"],
      capabilities: { sourceMap: false, assets: false, resumable: true }
    },
    validateOptions: () => undefined,
    probe: () => ({ supported: true, confidence: 1, detectedMime: "application/pdf" }),
    parse: async (_input, parseContext) => {
      await parseContext.saveResumeToken(JSON.stringify({ v: 1, protocol: "cloud-v4", id: "task", fileName: "scan.pdf" }));
      return {
        schemaVersion: 2,
        markdown: "# MinerU result\n\nOCR body.\n",
        metadata: {},
        assets: [],
        issues: []
      };
    },
    resume: async () => ({
      schemaVersion: 2,
      markdown: "# MinerU result\n\nOCR body.\n",
      metadata: {},
      assets: [],
      issues: []
    })
  };
  const config = structuredClone(DEFAULT_CONFIG);
  config.parsing.providers["mineru-http"] = {
    enabled: true,
    priority: 50,
    options: { taskTimeoutMs: 10_000 }
  };
  const service = new ParsingService(
    adapter as unknown as DataAdapter,
    config,
    undefined,
    new ParserRegistry([localPdf, mineru])
  );
  const imported = await service.importBytes("scan.pdf", new TextEncoder().encode("%PDF-scan"));
  assert.equal(imported.parse.status, "parsed");
  assert.equal(imported.parse.revisions[0]?.parserId, "mineru-http");
  assert.deepEqual(imported.parse.attempts.map((attempt) => attempt.status), ["needs_ocr", "parsed"]);
  assert.equal(imported.ingest.status, "not_started");
  const raw = await adapter.read(imported.parse.revisions[0]!.rawPath);
  assert.doesNotMatch(raw, /llm-wiki:(?:block|page)=/);
});

test("new raw schema keeps Markdown body clean and does not publish a source map", async () => {
  const adapter = new MemoryAdapter();
  const service = new ParsingService(adapter as unknown as DataAdapter, DEFAULT_CONFIG);
  const imported = await service.importBytes("mapped.md", new TextEncoder().encode("# One\n\nBody.\n"));
  const revision = imported.parse.revisions[0]!;
  assert.equal(revision.artifactSchemaVersion, 3);
  assert.equal(revision.sourceMapPath, undefined);
  assert.equal(revision.sourceMapHash, undefined);
  const raw = await adapter.read(revision.rawPath);
  assert.doesNotMatch(raw, /<!--\s*llm-wiki:(?:block|page)=/);
  assert.match(raw, /---\n# One\n\nBody\.\n$/);
  assert.equal((await service.verifyRaw())[0]?.ok, true);
  assert.equal((await service.beginIngest(imported.sourceId)).content, "# One\n\nBody.\n");
});

test("verifyRaw surfaces invalid manifests instead of silently skipping them", async () => {
  const adapter = new MemoryAdapter();
  const service = new ParsingService(adapter as unknown as DataAdapter, DEFAULT_CONFIG);
  await service.initialize();
  await adapter.write(".llm-wiki/manifests/broken.json", "{invalid");
  const result = await service.verifyRaw();
  assert.equal(result.some((item) =>
    item.sourceId.includes("broken.json")
    && item.issues.some((issue) => issue.code === "MANIFEST_INVALID")
  ), true);
});

test("unsupported formats create a parse_failed attempt without publishing raw", async () => {
  const adapter = new MemoryAdapter();
  const service = new ParsingService(
    adapter as unknown as DataAdapter,
    DEFAULT_CONFIG,
    undefined,
    new ParserRegistry()
  );
  const imported = await service.importBytes("unknown.bin", new Uint8Array([0, 1, 2]));
  assert.equal(imported.parse.status, "parse_failed");
  assert.equal(imported.parse.error?.code, "UNSUPPORTED_FORMAT");
  assert.equal(imported.parse.attempts.length, 1);
  assert.equal(imported.parse.revisions.length, 0);
});

test("media raw uses the generated author-summary basename once and keeps it stable across reparses", async () => {
  const adapter = new MemoryAdapter();
  const config = structuredClone(DEFAULT_CONFIG);
  config.parsing.providers["media-transcription"]!.enabled = true;
  let title = "70387613618-Java Agent 架构设计";
  const mediaParser: DocumentParser = {
    descriptor: {
      id: "media-transcription",
      version: "1.2.0",
      execution: "local",
      supportedKinds: ["video"],
      capabilities: { sourceMap: false, assets: false, resumable: false }
    },
    validateOptions() {},
    probe: () => ({ supported: true, confidence: 1 }),
    parse: async () => ({
      schemaVersion: 2,
      markdown: `# ${title}\n\n正文。\n`,
      metadata: { title },
      assets: [],
      issues: []
    })
  };
  const service = new ParsingService(
    adapter as unknown as DataAdapter,
    config,
    undefined,
    new ParserRegistry().register(mediaParser)
  );
  const bytes = new Uint8Array(16);
  bytes.set(new TextEncoder().encode("ftypisom"), 4);
  const first = await service.importBytes("platform-caption.mp4", bytes);
  const hashPrefix = first.sourceHash.slice(0, 8);
  assert.equal(first.parse.revisions[0]?.rawPath, `raw/videos/70387613618-java-agent-架构设计--${hashPrefix}.md`);

  title = "70387613618-重新生成但不改已有路径";
  const reparsed = await service.parseSource(first.sourceId, true);
  assert.equal(
    reparsed.parse.revisions[1]?.rawPath,
    `raw/videos/70387613618-java-agent-架构设计--${hashPrefix}--r2.md`
  );
});

test("v2 manifest normalizes to v3 without reparsing legacy raw", () => {
  const value = normalizeManifest({
    schemaVersion: 2,
    manifestRevision: 7,
    sourceId: "legacy-source",
    sourceHash: "a".repeat(64),
    original: {
      name: "legacy.pdf",
      extension: "pdf",
      mime: "application/pdf",
      size: 1,
      objectPath: ".llm-wiki/objects/sha256/aa/example.pdf",
      importedAt: "2026-01-01T00:00:00.000Z"
    },
    parse: {
      status: "parsed",
      currentRevision: 1,
      revisions: [{
        revision: 1,
        parserId: "pdfjs-layout",
        parserVersion: "1.0.0",
        parseKey: "key",
        completedAt: "2026-01-01T00:00:00.000Z",
        rawPath: "raw/documents/legacy.md",
        contentHash: "b".repeat(64),
        artifactHash: "c".repeat(64),
        metadata: {},
        quality: {
          characterCount: 1,
          blockCount: 1,
          replacementCharacterRatio: 0,
          veryLongLineCount: 0,
          omittedImageCount: 0,
          tableCount: 0,
          overall: "pass"
        },
        warnings: []
      }]
    },
    ingest: { status: "not_started", attempts: [] }
  });
  assert.equal(value.schemaVersion, 3);
  assert.equal(value.source.kind, "pdf");
  assert.equal(value.parse.revisions[0]?.artifactSchemaVersion, 1);
  assert.deepEqual(value.parse.attempts, []);
});

test("legacy parsing config maps to namespaced v4 provider options", () => {
  const migrated = mergeConfig({
    schemaVersion: 2,
    parsing: {
      maxImportBytes: 10,
      maxOutputBytes: 20,
      timeoutMs: 30,
      maxPdfPages: 44,
      maxPdfTextItems: 55,
      pdf: {
        lineYToleranceRatio: 0.2,
        scannedPageMinChars: 12,
        maxReplacementCharacterRatio: 0.04,
        repeatedMarginTextPageRatio: 0.7
      }
    }
  } as any);
  assert.equal(migrated.schemaVersion, 4);
  assert.equal(migrated.parsing.maxMediaImportBytes, 500 * 1024 * 1024);
  assert.equal(migrated.parsing.providers["pdfjs-layout"]?.options.maxPdfPages, 44);
  assert.equal(migrated.parsing.providers["pdfjs-layout"]?.options.maxPdfTextItems, 55);
  assert.equal("pdf" in migrated.parsing, false);
  assert.throws(() => mergeConfig({
    ...DEFAULT_CONFIG,
    parsing: {
      ...DEFAULT_CONFIG.parsing,
      providers: {
        remote: {
          enabled: true,
          priority: 1,
          options: { apiKey: "must-not-be-here" }
        }
      }
    }
  }), /密钥不能写入配置/);
});

test("resumable remote parser continues an interrupted attempt after restart", async () => {
  const adapter = new MemoryAdapter();
  let resumeCalls = 0;
  const remote: DocumentParser = {
    descriptor: {
      id: "fake-remote",
      version: "1.0.0",
      execution: "remote",
      supportedKinds: ["unknown"],
      capabilities: { sourceMap: false, assets: false, resumable: true }
    },
    validateOptions: () => undefined,
    probe: (input) => ({ supported: input.extension === "remote", confidence: 1 }),
    parse: async () => ({
      schemaVersion: 2,
      markdown: "# Initial\n",
      metadata: {},
      assets: [],
      issues: []
    }),
    resume: async (_input, token, context) => {
      assert.equal(token, "job-123");
      resumeCalls += 1;
      context.reportProgress({ phase: "download", completed: 1, total: 1 });
      return {
        schemaVersion: 2,
        markdown: "# Resumed\n",
        metadata: {},
        assets: [],
        issues: []
      };
    }
  };
  const registry = new ParserRegistry([remote]);
  const firstService = new ParsingService(
    adapter as unknown as DataAdapter,
    DEFAULT_CONFIG,
    undefined,
    registry
  );
  const imported = await firstService.importBytes("document.remote", new Uint8Array([1, 2, 3]));
  const store = new SourceStore(adapter as unknown as DataAdapter, DEFAULT_CONFIG.paths.internal);
  await store.updateManifest(imported.sourceId, imported.manifestRevision, (current) => {
    current.parse.status = "parsing";
    current.parse.startedAt = new Date().toISOString();
    current.parse.attempts.push({
      attemptId: "remote-attempt",
      parseKey: imported.parse.revisions[0]!.parseKey,
      parserId: "fake-remote",
      parserVersion: "1.0.0",
      status: "parsing",
      startedAt: new Date().toISOString(),
      resumeToken: "job-123"
    });
    return current;
  });
  const recovered = new ParsingService(
    adapter as unknown as DataAdapter,
    DEFAULT_CONFIG,
    undefined,
    new ParserRegistry([remote])
  );
  const manifest = await recovered.getSource(imported.sourceId);
  assert.equal(resumeCalls, 1);
  assert.equal(manifest.parse.status, "parsed");
  assert.equal(manifest.parse.revisions.length, 2);
  assert.equal(manifest.parse.attempts.at(-1)?.status, "parsed");
  assert.equal(manifest.parse.attempts.at(-1)?.resumeToken, undefined);
});

test("parser assets are published, rewritten, and hash verified", async () => {
  const adapter = new MemoryAdapter();
  const assetBytes = new Uint8Array([137, 80, 78, 71]);
  const parser: DocumentParser = {
    descriptor: {
      id: "asset-parser",
      version: "1.0.0",
      execution: "local",
      supportedKinds: ["unknown"],
      capabilities: { sourceMap: false, assets: true, resumable: false }
    },
    validateOptions: () => undefined,
    probe: () => ({ supported: true, confidence: 1 }),
    parse: async () => ({
      schemaVersion: 2,
      markdown: "![figure](llm-wiki-asset:figure-1)\n",
      metadata: {},
      assets: [{
        assetId: "figure-1",
        mime: "image/png",
        bytes: assetBytes,
        source: { startLine: 1, endLine: 1, startMs: 12_000, endMs: 12_000 }
      }],
      issues: []
    })
  };
  const service = new ParsingService(
    adapter as unknown as DataAdapter,
    DEFAULT_CONFIG,
    undefined,
    new ParserRegistry([parser])
  );
  const imported = await service.importBytes("asset.custom", new Uint8Array([4, 5, 6]));
  const revision = imported.parse.revisions[0]!;
  assert.equal(revision.assets?.length, 1);
  const asset = revision.assets![0]!;
  assert.deepEqual(asset.source, { startLine: 1, endLine: 1, startMs: 12_000, endMs: 12_000 });
  assert.equal(await adapter.exists(asset.path), true);
  assert.match(await adapter.read(revision.rawPath), /!\[figure\]\(\.\.\/assets\//);
  assert.equal((await service.verifyRaw())[0]?.ok, true);
  await adapter.writeBinary(asset.path, new Uint8Array([0]).buffer);
  assert.equal((await service.verifyRaw())[0]?.ok, false);
});

test("parser runtime fingerprint invalidates a deterministic parse cache without forcing", async () => {
  const adapter = new MemoryAdapter();
  let runtime = "ffmpeg-a";
  let parses = 0;
  const parser: DocumentParser = {
    descriptor: {
      id: "runtime-parser",
      version: "1.0.0",
      execution: "local",
      supportedKinds: ["unknown"],
      capabilities: { sourceMap: false, assets: false, resumable: false }
    },
    validateOptions: () => undefined,
    probe: () => ({ supported: true, confidence: 1 }),
    runtimeFingerprint: () => runtime,
    parse: async () => {
      parses += 1;
      return { schemaVersion: 2, markdown: `run ${parses}\n`, metadata: {}, assets: [], issues: [] };
    }
  };
  const service = new ParsingService(
    adapter as unknown as DataAdapter,
    DEFAULT_CONFIG,
    undefined,
    new ParserRegistry([parser])
  );
  const imported = await service.importBytes("runtime.custom", new Uint8Array([7, 8, 9]));
  await service.parseSource(imported.sourceId);
  assert.equal(parses, 1);
  runtime = "ffmpeg-b";
  const reparsed = await service.parseSource(imported.sourceId);
  assert.equal(parses, 2);
  assert.equal(reparsed.parse.revisions.length, 2);
});

test("legacy raw v1 remains ingestible after manifest normalization", async () => {
  const adapter = new MemoryAdapter();
  const sourceId = "legacy-ingest";
  const originalBytes = new TextEncoder().encode("legacy original");
  const sourceHash = sha256(originalBytes);
  const objectPath = `.llm-wiki/objects/sha256/${sourceHash.slice(0, 2)}/${sourceHash}.md`;
  await adapter.writeBinary(objectPath, originalBytes.buffer);
  const body = "# Legacy\n\nBody.\n";
  const contentHash = sha256(body);
  const artifact = `---
schema_version: 1
kind: raw_document
source_id: ${sourceId}
source_hash: ${sourceHash}
content_hash: ${contentHash}
original_name: legacy.md
original_mime: text/markdown
parser_id: markdown-pass-through
parser_version: 1.0.0
---
${body}`;
  const rawPath = "raw/articles/legacy--12345678.md";
  await adapter.write(rawPath, artifact);
  await adapter.write(`.llm-wiki/manifests/${sourceId}.json`, `${JSON.stringify({
    schemaVersion: 2,
    manifestRevision: 1,
    sourceId,
    sourceHash,
    original: {
      name: "legacy.md",
      extension: "md",
      mime: "text/markdown",
      size: originalBytes.byteLength,
      objectPath,
      importedAt: "2026-01-01T00:00:00.000Z"
    },
    parse: {
      status: "parsed",
      currentRevision: 1,
      revisions: [{
        revision: 1,
        parserId: "markdown-pass-through",
        parserVersion: "1.0.0",
        parseKey: "legacy-key",
        completedAt: "2026-01-01T00:00:00.000Z",
        rawPath,
        contentHash,
        artifactHash: sha256(artifact),
        metadata: {},
        quality: {
          characterCount: body.length,
          blockCount: 2,
          replacementCharacterRatio: 0,
          veryLongLineCount: 0,
          omittedImageCount: 0,
          tableCount: 0,
          overall: "pass"
        },
        warnings: []
      }]
    },
    ingest: { status: "not_started", attempts: [] }
  }, null, 2)}\n`);
  const service = new ParsingService(adapter as unknown as DataAdapter, DEFAULT_CONFIG);
  const prepared = await service.beginIngest(sourceId);
  assert.equal(prepared.content, body);
  assert.equal(prepared.input.contentHash, contentHash);
});

test("manifest commit failure rolls back newly published raw", async () => {
  const adapter = new MemoryAdapter();
  adapter.failNextManifestCommitAfterRaw = true;
  const service = new ParsingService(adapter as unknown as DataAdapter, DEFAULT_CONFIG);
  const imported = await service.importBytes("rollback.md", new TextEncoder().encode("# Rollback\n\nBody.\n"));
  assert.equal(imported.parse.status, "parse_failed");
  assert.equal(imported.parse.revisions.length, 0);
  assert.deepEqual((await adapter.list("raw/articles")).files, []);
  const sourceMapRoot = `.llm-wiki/source-maps/${imported.sourceId}`;
  assert.deepEqual((await adapter.list(sourceMapRoot)).files, []);
});

function fakeParser(
  id: string,
  kind: "text",
  confidence: number,
  throws = false
): DocumentParser {
  return {
    descriptor: {
      id,
      version: "1.0.0",
      execution: "local",
      supportedKinds: [kind],
      capabilities: { sourceMap: false, assets: false, resumable: false }
    },
    validateOptions: () => undefined,
    probe: () => {
      if (throws) throw new Error("probe failed");
      return { supported: true, confidence };
    },
    parse: async () => ({
      schemaVersion: 2,
      markdown: "parsed\n",
      metadata: {},
      assets: [],
      issues: []
    })
  };
}

class MemoryAdapter {
  private readonly files = new Map<string, Uint8Array>();
  private readonly folders = new Set<string>();
  failNextManifestCommitAfterRaw = false;

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path);
  }

  async mkdir(path: string): Promise<void> {
    this.folders.add(path);
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, new TextEncoder().encode(content));
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (!value) throw new Error(`Missing ${path}`);
    return new TextDecoder().decode(value);
  }

  async writeBinary(path: string, content: ArrayBuffer): Promise<void> {
    this.files.set(path, new Uint8Array(content.slice(0)));
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const value = this.files.get(path);
    if (!value) throw new Error(`Missing ${path}`);
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }

  async rename(from: string, to: string): Promise<void> {
    const value = this.files.get(from);
    if (!value) throw new Error(`Missing ${from}`);
    if (this.files.has(to)) throw new Error(`Exists ${to}`);
    if (this.failNextManifestCommitAfterRaw
      && to.startsWith(".llm-wiki/manifests/")
      && to.endsWith(".json")
      && from.endsWith(".tmp")
      && [...this.files.keys()].some((path) => path.startsWith("raw/") && path.endsWith(".md"))) {
      this.failNextManifestCommitAfterRaw = false;
      throw new Error("simulated manifest commit failure");
    }
    this.files.set(to, value);
    this.files.delete(from);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
    this.folders.delete(path);
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = `${path.replace(/\/$/, "")}/`;
    const files = [...this.files.keys()].filter((entry) =>
      entry.startsWith(prefix) && !entry.slice(prefix.length).includes("/")
    );
    const folders = [...this.folders].filter((entry) =>
      entry.startsWith(prefix) && !entry.slice(prefix.length).includes("/")
    );
    return { files, folders };
  }
}
