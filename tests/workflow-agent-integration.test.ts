import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_AGENT_BUDGETS } from "../src/agent/agent-settings";
import { enrichWikiContent } from "../src/agent/wiki-link-graph";
import type { AgentRuntimeFactory } from "../src/agent/runtime-factory";
import { makePageTemplate, parseMarkdown, sanitizePlanDanglingLinks, sha256, validateChangePlan } from "../src/core/wiki-core";
import { validateSourceDeletionChain } from "../src/services/source-deletion";
import { WorkflowService } from "../src/services/workflow-service";
import type {
  AgentConfig,
  AgentEvent,
  AgentMessage,
  AgentRuntime,
  AgentSession,
  AgentTurnRequest,
  AgentTurnResult,
  IngestInput,
  PluginSettings,
  RollbackReceipt,
  SessionOptions,
  SourceManifest,
  WikiChangePlan
} from "../src/types";

test("tool Agent keeps the ingest/review lifecycle without writing the Vault", async () => {
  const updates: Array<{ status: string; attemptId: string }> = [];
  const audits: Record<string, unknown>[] = [];
  let beginCount = 0;
  const input = ingestInput();
  const wiki = makeWikiHost({
    beginIngest: async () => {
      beginCount += 1;
      return { input, content: "# Runtime migration\n\nFact.", attemptId: "ingest-1" };
    },
    updateIngestAttempt: async (_sourceId: string, attemptId: string, status: string) => {
      updates.push({ status, attemptId });
    },
    writeAgentRunAudit: async (audit: Record<string, unknown>) => { audits.push(audit); }
  });
  const events: AgentEvent[] = [];
  const service = new WorkflowService(wiki as any, new ScriptedFactory(input), settings);
  const manifest = sourceManifest();
  const result = await service.ingest(manifest, (event) => events.push(event));

  assert.equal(result.operations.length, 1);
  assert.equal(result.operations[0]?.path, "wiki/sources/source.md");
  assert.equal(beginCount, 1);
  assert.deepEqual(updates, [{ status: "awaiting_review", attemptId: "ingest-1" }]);
  assert.ok(events.some((event) => event.type === "tool_started" && event.name === "analyze_ingest_sources"));
  assert.ok(events.some((event) => event.type === "plan_ready"));
  assert.equal(service.getIngestProgress(manifest.sourceId)?.state, "awaiting_review");
  assert.ok((service.getIngestProgress(manifest.sourceId)?.activities.length ?? 0) > 0);
  assert.equal(audits.length, 1);
  assert.equal(manifest.parse.status, "parsed");

  await service.rejectPending();
  assert.equal(beginCount, 1, "review rejection must not parse or ingest again");
  assert.equal(updates.at(-1)?.status, "not_started");
  assert.equal(service.getIngestProgress(manifest.sourceId), undefined);
  assert.equal(manifest.parse.status, "parsed");
});

test("agent failure updates only ingest state and leaves parsed source untouched", async () => {
  const updates: string[] = [];
  const input = ingestInput();
  const wiki = makeWikiHost({
    beginIngest: async () => ({ input, content: "body", attemptId: "ingest-2" }),
    updateIngestAttempt: async (_sourceId: string, _attemptId: string, status: string) => { updates.push(status); }
  });
  const manifest = sourceManifest();
  const service = new WorkflowService(wiki as any, new ErrorFactory(), settings);
  await assert.rejects(() => service.ingest(manifest, () => undefined), /provider failed/);
  assert.deepEqual(updates, ["ingest_failed"]);
  assert.equal(manifest.parse.status, "parsed");
  assert.equal(manifest.parse.currentRevision, 1);
  assert.equal(service.getIngestProgress(manifest.sourceId)?.state, "failed");
});

test("partial Ingest apply keeps Source mandatory and records user-rejected knowledge", async () => {
  const input = ingestInput();
  const sourceContent = enrichWikiContent(
    "wiki/sources/source.md",
    makePageTemplate("source", "Source", "Imported source", "# Source\n\nFact.")
    .replace('raw_path: ""', `raw_path: ${input.rawPath}`)
    .replace('raw_hash: ""', `raw_hash: ${input.sourceHash}`),
    ["wiki/concepts/syn-flood"]
  );
  const conceptContent = makePageTemplate("concept", "SYN Flood", "TCP attack", "# SYN Flood\n\nFact.");
  const plan: WikiChangePlan = {
    version: 1,
    operationId: "partial-operation",
    summary: "Source and concept",
    operations: [
      { action: "create", path: "wiki/sources/source.md", content: sourceContent, reason: "source" },
      { action: "create", path: "wiki/concepts/syn-flood.md", content: conceptContent, reason: "concept" }
    ],
    ingestCoverage: {
      sources: [{ sourceId: input.sourceId, contentHash: input.contentHash, reviewedSectionIds: ["s0001"] }],
      categoryAssessments: [
        { sourceId: input.sourceId, type: "entity", outcome: "none", reason: "none" },
        { sourceId: input.sourceId, type: "concept", outcome: "candidates_found", reason: "found" },
        { sourceId: input.sourceId, type: "synthesis", outcome: "none", reason: "none" }
      ],
      decisions: [{
        candidateId: "c001", sourceId: input.sourceId, type: "concept", title: "SYN Flood",
        decision: "created", targetPath: "wiki/concepts/syn-flood.md", reason: "reusable",
        evidence: [{ sourceId: input.sourceId, contentHash: input.contentHash, sectionId: "s0001" }]
      }]
    }
  };
  const updates: Array<{ status: string; updates: Record<string, any> }> = [];
  let applied: WikiChangePlan | undefined;
  const wiki = makeWikiHost({
    preparePlan: async (candidate: WikiChangePlan) => validateChangePlan(
      sanitizePlanDanglingLinks(candidate, new Map()), new Map()
    ),
    applyPlan: async (candidate: WikiChangePlan) => {
      applied = validateChangePlan(candidate, new Map());
      return applied;
    },
    updateIngestAttempt: async (_sourceId: string, _attemptId: string, status: string, value: Record<string, any>) => {
      updates.push({ status, updates: value });
    }
  });
  const service = new WorkflowService(wiki as any, new ErrorFactory(), settings);
  service.pendingPlan = plan;
  service.pendingAgentPlan = { plan, attempts: [{ sourceId: input.sourceId, attemptId: "attempt", input }] } as any;

  await assert.rejects(
    () => service.applyPending(new Set(["wiki/concepts/syn-flood.md"])),
    /必须接受来源页面/
  );
  await service.applyPending(new Set(["wiki/sources/source.md"]));
  assert.deepEqual(applied?.operations.map((item) => item.path), ["wiki/sources/source.md"]);
  const appliedSource = parseMarkdown(applied!.operations[0]!.path, applied!.operations[0]!.content)!;
  assert.deepEqual(appliedSource.related, []);
  assert.doesNotMatch(appliedSource.body, /syn-flood/);
  assert.equal(applied?.ingestCoverage?.decisions[0]?.decision, "user_rejected");
  assert.equal(updates.at(-1)?.status, "ingested");
  assert.equal(updates.at(-1)?.updates.hasUserExclusions, true);
  assert.equal(updates.at(-1)?.updates.coverage.decisions[0].decision, "user_rejected");
});

test("Ingest rollback previews the receipt and resets every affected source only after success", async () => {
  const manifest = sourceManifest();
  manifest.ingest.status = "ingested";
  manifest.ingest.attempts.push({
    attemptId: "attempt-applied",
    revision: 1,
    status: "ingested",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    operationId: "operation-rollback-1",
    sourcePage: "wiki/sources/source.md",
    acceptedPaths: ["wiki/sources/source.md"]
  });
  const updates: Array<{ status: string; values: Record<string, unknown> }> = [];
  let rollbackCalls = 0;
  const preview = {
    operationId: "operation-rollback-1",
    available: true,
    status: "applied" as const,
    summary: "Import source",
    sourceIds: [manifest.sourceId],
    changes: [{
      path: "wiki/sources/source.md", originalAction: "create" as const,
      rollbackAction: "delete" as const, afterHash: "d".repeat(64)
    }],
    conflicts: []
  };
  const wiki = makeWikiHost({
    listSources: async () => [manifest],
    previewRollback: async () => preview,
    rollbackOperation: async () => {
      rollbackCalls += 1;
      return {
        operationId: preview.operationId,
        rollbackOperationId: "rollback-operation-1",
        restoredPaths: [],
        deletedPaths: ["wiki/sources/source.md"],
        lintErrors: 0
      };
    },
    updateIngestAttempt: async (_sourceId: string, _attemptId: string, status: string, values: Record<string, unknown>) => {
      updates.push({ status, values });
    }
  });
  const service = new WorkflowService(wiki as any, new ErrorFactory(), settings);

  assert.equal((await service.previewIngestRollback(manifest.sourceId)).operationId, preview.operationId);
  const result = await service.rollbackIngest(preview.operationId);

  assert.equal(rollbackCalls, 1);
  assert.equal(result.deletedPaths.length, 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.status, "not_started");
  assert.equal(updates[0]?.values.rollbackOperationId, "rollback-operation-1");
  assert.equal(typeof updates[0]?.values.rolledBackAt, "string");
});

test("Ingest rollback refuses conflicts before invoking the reverse transaction", async () => {
  const manifest = sourceManifest();
  manifest.ingest.status = "ingested";
  manifest.ingest.attempts.push({
    attemptId: "attempt-conflict", revision: 1, status: "ingested",
    startedAt: "2026-01-01T00:00:00.000Z", operationId: "operation-conflict-1", acceptedPaths: []
  });
  let rollbackCalls = 0;
  const wiki = makeWikiHost({
    listSources: async () => [manifest],
    previewRollback: async () => ({
      operationId: "operation-conflict-1", available: true, sourceIds: [manifest.sourceId], changes: [],
      conflicts: [{ path: "wiki/concepts/http.md", reason: "文件已被后续修改" }]
    }),
    rollbackOperation: async () => { rollbackCalls += 1; throw new Error("must not run"); }
  });
  const service = new WorkflowService(wiki as any, new ErrorFactory(), settings);

  await assert.rejects(() => service.rollbackIngest("operation-conflict-1"), /后续修改/);
  assert.equal(rollbackCalls, 0);
});

test("source deletion command resolves the raw path and delegates only after preview", async () => {
  const manifest = sourceManifest();
  const preview = {
    sourceId: manifest.sourceId,
    sourceName: manifest.original.name,
    wikiChanges: [],
    dataPaths: [manifest.original.objectPath, manifest.parse.revisions[0]!.rawPath],
    blockers: []
  };
  let deletedSourceId = "";
  const wiki = makeWikiHost({
    listSources: async () => [manifest],
    previewSourceDeletion: async () => preview,
    deleteSource: async (sourceId: string) => {
      deletedSourceId = sourceId;
      return {
        sourceId,
        deletionOperationId: "deletion-operation-1",
        deletedDataPaths: preview.dataPaths,
        restoredWikiPaths: [],
        deletedWikiPaths: []
      };
    }
  });
  const service = new WorkflowService(wiki as any, new ErrorFactory(), settings);

  const command = await service.executeCommandText(`/ingest delete ${manifest.parse.revisions[0]!.rawPath}`);
  assert.equal(command.sourceDeletionPreview?.sourceId, manifest.sourceId);
  assert.equal(deletedSourceId, "", "command parsing must never delete without visual confirmation");
  await service.deleteSource(manifest.sourceId);
  assert.equal(deletedSourceId, manifest.sourceId);
});

test("source deletion validates multiple Ingest receipts as one reverse hash chain", () => {
  const path = "wiki/concepts/http.md";
  const original = "original";
  const first = "first ingest";
  const second = "second ingest";
  const receipts: RollbackReceipt[] = [{
    version: 1, operationId: "operation-newest", status: "applied", summary: "newest",
    appliedAt: "2026-01-02T00:00:00.000Z", sourceIds: ["source-1"],
    changes: [{ path, originalAction: "update", rollbackAction: "restore", before: first, afterHash: sha256(second) }]
  }, {
    version: 1, operationId: "operation-oldest", status: "applied", summary: "oldest",
    appliedAt: "2026-01-01T00:00:00.000Z", sourceIds: ["source-1"],
    changes: [{ path, originalAction: "update", rollbackAction: "restore", before: original, afterHash: sha256(first) }]
  }];

  assert.deepEqual(validateSourceDeletionChain(receipts, new Map([[path, second]])), []);
  assert.match(
    validateSourceDeletionChain(receipts, new Map([[path, "later manual edit"]]))[0]?.reason ?? "",
    /后续操作修改/
  );
});

test("cancelling Ingest aborts the Agent and leaves a retryable progress state", async () => {
  const updates: string[] = [];
  const input = ingestInput();
  const wiki = makeWikiHost({
    beginIngest: async () => ({ input, content: "body", attemptId: "ingest-cancel" }),
    updateIngestAttempt: async (_sourceId: string, _attemptId: string, status: string) => { updates.push(status); }
  });
  const factory = new BlockingFactory();
  const service = new WorkflowService(wiki as any, factory, settings);
  const manifest = sourceManifest();
  const pending = service.ingest(manifest, () => undefined);
  await factory.runtime.started;
  await service.cancel();
  await assert.rejects(pending, /cancelled/);
  assert.deepEqual(updates, ["ingest_failed"]);
  assert.equal(service.getIngestProgress(manifest.sourceId)?.state, "cancelled");
  assert.equal(manifest.parse.status, "parsed");
});

class ScriptedFactory implements AgentRuntimeFactory {
  constructor(private readonly input: IngestInput) {}
  async create(): Promise<AgentRuntime> { return new ScriptedRuntime(this.input); }
}

class ErrorFactory implements AgentRuntimeFactory {
  async create(): Promise<AgentRuntime> { return new FailingRuntime(); }
}

class BlockingFactory implements AgentRuntimeFactory {
  readonly runtime = new BlockingRuntime();
  async create(): Promise<AgentRuntime> { return this.runtime; }
}

class ScriptedRuntime implements AgentRuntime {
  constructor(private readonly input: IngestInput) {}
  async initialize(_config: AgentConfig): Promise<void> {}
  async startSession(_options: SessionOptions): Promise<AgentSession> { return { id: "runtime-session" }; }
  async *send(_message: AgentMessage): AsyncIterable<AgentEvent> {}
  async runTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    const name = request.tools[0]?.name;
    const calls = name === "select_raw_sections"
      ? [{ id: "call-select", name, input: { sources: [{ sourceId: this.input.sourceId, sectionIds: ["s0001"] }] } }]
      : name === "analyze_ingest_sources"
        ? [{ id: "call-analyze", name, input: {
          sourceDrafts: [{
            sourceId: this.input.sourceId, title: "Source", slug: "source",
            tldr: "Imported source", body: "# Source\n\nFact."
          }],
          candidates: [],
          categoryAssessments: [
            { sourceId: this.input.sourceId, type: "entity", outcome: "none", reason: "测试短文中没有需要独立维护的实体" },
            { sourceId: this.input.sourceId, type: "concept", outcome: "none", reason: "测试短文只有一个未展开的事实" },
            { sourceId: this.input.sourceId, type: "synthesis", outcome: "none", reason: "测试短文不足以形成综合页面" }
          ]
        } }]
        : [];
    return { text: "", toolCalls: calls, provider: "anthropic-messages", model: "test" };
  }
  async testConnection(): Promise<string> { return "OK"; }
  async cancel(): Promise<void> {}
  async dispose(): Promise<void> {}
}

class FailingRuntime implements AgentRuntime {
  async initialize(_config: AgentConfig): Promise<void> {}
  async startSession(_options: SessionOptions): Promise<AgentSession> { return { id: "error-session" }; }
  async *send(_message: AgentMessage): AsyncIterable<AgentEvent> {}
  async runTurn(_request: AgentTurnRequest): Promise<AgentTurnResult> { throw new Error("provider failed"); }
  async testConnection(): Promise<string> { return "OK"; }
  async cancel(): Promise<void> {}
  async dispose(): Promise<void> {}
}

class BlockingRuntime implements AgentRuntime {
  private reject?: (error: Error) => void;
  private markStarted!: () => void;
  readonly started = new Promise<void>((resolve) => { this.markStarted = resolve; });
  async initialize(_config: AgentConfig): Promise<void> {}
  async startSession(_options: SessionOptions): Promise<AgentSession> { return { id: "blocking-session" }; }
  async *send(_message: AgentMessage): AsyncIterable<AgentEvent> {}
  async runTurn(_request: AgentTurnRequest): Promise<AgentTurnResult> {
    this.markStarted();
    return new Promise<AgentTurnResult>((_resolve, reject) => { this.reject = reject; });
  }
  async testConnection(): Promise<string> { return "OK"; }
  async cancel(): Promise<void> { this.reject?.(new Error("cancelled")); }
  async dispose(): Promise<void> { await this.cancel(); }
}

function makeWikiHost(overrides: Record<string, unknown>): Record<string, unknown> {
  const input = ingestInput();
  return {
    readVerifiedSource: async () => ({ manifest: sourceManifest(), content: "# Runtime migration\n\nFact." }),
    getSource: async () => sourceManifest(),
    beginIngest: async () => ({ input, content: "# Runtime migration\n\nFact.", attemptId: "ingest-1" }),
    currentHashes: async () => new Map<string, string>(),
    readPages: async () => [],
    search: async () => [],
    readWikiPage: async () => { throw new Error("not found"); },
    validateAgentPlan: async (plan: WikiChangePlan) => plan,
    preparePlan: async (plan: WikiChangePlan) => plan,
    updateIngestAttempt: async () => undefined,
    pipelineError: async (error: unknown, stage: string) => ({
      stage, code: "TEST", message: error instanceof Error ? error.message : String(error), retryable: false, at: new Date().toISOString()
    }),
    writeAgentRunAudit: async () => undefined,
    ...overrides
  };
}

function settings(): PluginSettings {
  return {
    schemaVersion: 5,
    agent: {
      protocol: "anthropic-messages",
      baseUrl: "https://api.example.com",
      secretId: "secret",
      structuredOutputMode: "auto",
      timeoutMs: 300_000,
      maxRetries: 2,
      toolCallingRequired: true,
      budgets: structuredClone(DEFAULT_AGENT_BUDGETS),
      models: [{ id: "fast", label: "Fast", contextWindow: 100_000, role: "fast" }]
    },
    activeTab: "home",
    sessions: [],
    activeSessionId: "",
    webClipper: { enabled: false, inboxPath: "Clippings", scanExistingOnStartup: false }
  };
}

function ingestInput(): IngestInput {
  return {
    sourceId: "source-1", revision: 1, rawPath: "raw/articles/source.md",
    sourceHash: "a".repeat(64), contentHash: "b".repeat(64), artifactHash: "c".repeat(64),
    parserId: "markdown-pass-through", parserVersion: "1.0.0", parseWarnings: [], metadata: { title: "Source" }
  };
}

function sourceManifest(): SourceManifest {
  return {
    schemaVersion: 3, manifestRevision: 1, sourceId: "source-1", sourceHash: "a".repeat(64),
    source: { kind: "markdown", acquiredBy: "test" },
    original: {
      name: "source.md", extension: ".md", mime: "text/markdown", size: 10,
      objectPath: ".llm-wiki/objects/source.md", importedAt: new Date().toISOString()
    },
    parse: { status: "parsed", currentRevision: 1, revisions: [{
      revision: 1,
      parserId: "markdown-pass-through",
      parserVersion: "1.0.0",
      parseKey: "test",
      completedAt: new Date().toISOString(),
      rawPath: "raw/articles/source.md",
      contentHash: "b".repeat(64),
      artifactHash: "c".repeat(64),
      artifactSchemaVersion: 3,
      metadata: { title: "Source" },
      quality: {
        characterCount: 28, blockCount: 1, replacementCharacterRatio: 0,
        veryLongLineCount: 0, omittedImageCount: 0, tableCount: 0, overall: "pass"
      },
      warnings: []
    }], attempts: [] },
    ingest: { status: "not_started", attempts: [] }
  };
}
