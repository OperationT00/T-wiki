import assert from "node:assert/strict";
import test from "node:test";
import type { DataAdapter } from "obsidian";

import { normalizePluginSettings } from "../src/agent/agent-settings";
import { RecoveryCenterService, redactDiagnosticText } from "../src/services/recovery-center";
import { PendingPlanStore } from "../src/services/pending-plan-store";
import type { RecoveryOverview, SourceManifest } from "../src/types";

test("recovery is a persisted workbench tab without a settings schema migration", () => {
  const settings = normalizePluginSettings({ schemaVersion: 6, activeTab: "recovery" });
  assert.equal(settings.schemaVersion, 6);
  assert.equal(settings.activeTab, "recovery");
});

test("recovery center aggregates durable records without exposing plan content", async () => {
  const adapter = new MemoryAdapter();
  adapter.put(".llm-wiki/transactions/op-fault.fault.json", JSON.stringify({
    version: 1,
    detectedAt: "2026-09-06T02:00:00.000Z",
    error: "Authorization: Bearer top-secret at C:\\Users\\private\\vault and https://host.test/path?token=secret"
  }));
  await new PendingPlanStore(adapter as unknown as DataAdapter, ".llm-wiki/pending-plan.json").save({
    version: 1,
    operationId: "pending-operation",
    summary: "secret summary",
    operations: [{
      action: "create",
      path: "wiki/concepts/private.md",
      content: "RAW AND WIKI PRIVATE BODY",
      reason: "private reason"
    }]
  }, []);

  const jobId = "a".repeat(32);
  adapter.put(`.llm-wiki/media-jobs/${jobId}/job.json`, JSON.stringify({
    version: 1,
    jobId,
    sourceId: "media-source",
    sourceHash: "b".repeat(64),
    parseKey: "parse-key",
    sourcePath: "C:\\private\\source.mp4",
    durationMs: 1000,
    chunks: [{ status: "completed" }, { status: "pending" }],
    createdAt: "2026-09-06T01:00:00.000Z",
    updatedAt: "2026-09-06T02:00:00.000Z",
    expiresAt: "2999-09-06T02:00:00.000Z"
  }));
  const manifests = [
    sourceManifest("raw-source", {
      parseStatus: "parse_failed",
      parseAttempt: {
        attemptId: "parse-raw",
        status: "parse_failed",
        startedAt: "2026-09-06T01:00:00.000Z",
        pendingRevision: {
          revision: 2,
          parserId: "markdown-normalize",
          parserVersion: "1.0.0",
          parseKey: "key",
          rawPath: "raw/documents/private.md",
          contentHash: "c".repeat(64),
          artifactHash: "d".repeat(64),
          artifactSchemaVersion: 3,
          metadata: {},
          quality: quality(),
          warnings: []
        }
      }
    }),
    sourceManifest("media-source", {
      parseStatus: "parse_failed",
      kind: "video",
      parseAttempt: {
        attemptId: "parse-media",
        parserId: "media-transcription",
        parserVersion: "1.3.0",
        status: "parse_failed",
        startedAt: "2026-09-06T01:00:00.000Z",
        resumeToken: JSON.stringify({ v: 1, jobId, sourceHash: "b".repeat(64), parseKey: "parse-key", nextChunk: 1 })
      }
    })
  ];
  const service = new RecoveryCenterService(
    adapter as unknown as DataAdapter,
    ".llm-wiki",
    async () => ({ manifests, errors: [] })
  );

  const overview = await service.inspect();
  assert.equal(overview.healthy, false);
  assert.equal(overview.counts.total, 4);
  assert.equal(overview.items.some((item) => item.kind === "pending-plan" && item.operationId === "pending-operation"), true);
  assert.equal(overview.items.find((item) => item.kind === "raw-publication")?.action, "recover-raw-publication");
  assert.deepEqual(overview.items.find((item) => item.kind === "media-resume")?.progress, { completed: 1, total: 2 });
  const serialized = JSON.stringify(overview);
  assert.doesNotMatch(serialized, /RAW AND WIKI PRIVATE BODY|secret summary|private reason/);
  assert.doesNotMatch(serialized, /top-secret|Users\\private|token=secret/);
});

test("recovery center reports corrupt manifests and orphan awaiting-review state without guessing", async () => {
  const adapter = new MemoryAdapter();
  const awaiting = sourceManifest("awaiting-source", {});
  awaiting.ingest = {
    status: "awaiting_review",
    attempts: [{
      attemptId: "ingest-attempt",
      revision: 1,
      status: "awaiting_review",
      startedAt: "2026-09-06T01:00:00.000Z",
      operationId: "missing-operation",
      acceptedPaths: []
    }]
  };
  const service = new RecoveryCenterService(
    adapter as unknown as DataAdapter,
    ".llm-wiki",
    async () => ({
      manifests: [awaiting],
      errors: [{ path: ".llm-wiki/manifests/broken.json", message: "invalid json" }]
    })
  );

  const overview = await service.inspect();
  assert.equal(overview.counts.blocked, 2);
  assert.equal(overview.items.find((item) => item.id.startsWith("pending-plan:missing"))?.action, "none");
  assert.equal(overview.items.find((item) => item.kind === "manifest")?.action, "none");
});

test("recovery diagnostic is atomic metadata-only output with secret and path redaction", async () => {
  const adapter = new MemoryAdapter();
  const service = new RecoveryCenterService(
    adapter as unknown as DataAdapter,
    ".llm-wiki",
    async () => ({ manifests: [], errors: [] })
  );
  const overview: RecoveryOverview = {
    version: 1,
    generatedAt: "2026-09-06T03:04:05.000Z",
    healthy: false,
    counts: { total: 1, recoverable: 0, blocked: 1 },
    items: [{
      id: "manifest:C:\\private\\file",
      kind: "manifest",
      severity: "error",
      title: "Token token=very-secret-value",
      detail: "C:\\Users\\private\\vault https://example.com/file?signature=secret",
      action: "none"
    }]
  };

  const path = await service.writeDiagnostic(overview);
  assert.equal(path, ".llm-wiki/diagnostics/recovery-2026-09-06T03-04-05-000Z.json");
  const stored = await adapter.read(path);
  assert.doesNotMatch(stored, /very-secret-value|Users\\private|signature=secret/);
  assert.match(stored, /<redacted>|<local-path>/);
  assert.equal(redactDiagnosticText("api_key=sk-test-secret-value-123456"), "api_key=<redacted>");
});

function sourceManifest(
  sourceId: string,
  options: {
    parseStatus?: SourceManifest["parse"]["status"];
    kind?: SourceManifest["source"]["kind"];
    parseAttempt?: SourceManifest["parse"]["attempts"][number];
  }
): SourceManifest {
  return {
    schemaVersion: 3,
    manifestRevision: 1,
    sourceId,
    sourceHash: "b".repeat(64),
    source: { kind: options.kind ?? "markdown", acquiredBy: "test" },
    original: {
      name: "private-name.md",
      extension: "md",
      mime: "text/markdown",
      size: 10,
      objectPath: ".llm-wiki/objects/sha256/bb/hash",
      importedAt: "2026-09-06T00:00:00.000Z"
    },
    parse: {
      status: options.parseStatus ?? "parsed",
      revisions: [],
      attempts: options.parseAttempt ? [options.parseAttempt] : []
    },
    ingest: { status: "not_started", attempts: [] }
  };
}

function quality() {
  return {
    characterCount: 10,
    blockCount: 1,
    replacementCharacterRatio: 0,
    veryLongLineCount: 0,
    omittedImageCount: 0,
    tableCount: 0,
    overall: "pass" as const
  };
}

class MemoryAdapter {
  readonly text = new Map<string, string>();
  readonly folders = new Set<string>();

  put(path: string, value: string): void {
    this.text.set(path, value);
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) this.folders.add(parts.slice(0, index).join("/"));
  }

  async exists(path: string) { return this.text.has(path) || this.folders.has(path); }
  async mkdir(path: string) { this.folders.add(path); }
  async write(path: string, value: string) { this.put(path, value); }
  async read(path: string) {
    const value = this.text.get(path);
    if (value === undefined) throw new Error(path);
    return value;
  }
  async remove(path: string) { this.text.delete(path); }
  async rename(from: string, to: string) {
    const value = this.text.get(from);
    if (value === undefined) throw new Error(from);
    this.text.delete(from);
    this.put(to, value);
  }
  async list(path: string) {
    const prefix = `${path.replace(/\/$/, "")}/`;
    return {
      files: [...this.text.keys()].filter((item) => item.startsWith(prefix) && !item.slice(prefix.length).includes("/")),
      folders: [...this.folders].filter((item) => item.startsWith(prefix) && !item.slice(prefix.length).includes("/"))
    };
  }
}
