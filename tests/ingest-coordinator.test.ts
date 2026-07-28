import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_AGENT_BUDGETS } from "../src/agent/agent-settings";
import { EvidenceLedger } from "../src/agent/evidence-ledger";
import { IngestCoordinator } from "../src/agent/ingest-coordinator";
import { AgentProviderError } from "../src/agent/llm-provider";
import type { AgentRuntimeFactory } from "../src/agent/runtime-factory";
import { makePageTemplate, parseMarkdown, sha256, validateChangePlan } from "../src/core/wiki-core";
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
  SessionOptions,
  SourceManifest,
  WikiPage
} from "../src/types";

test("EvidenceLedger returns stable session IDs and resolves legacy references", () => {
  const ledger = new EvidenceLedger();
  const raw = ledger.recordRaw("source", "a".repeat(64), "s0001");
  const duplicate = ledger.recordRaw("source", "a".repeat(64), "s0001");
  const wiki = ledger.recordWiki("wiki/concepts/tcp.md", "b".repeat(64));

  assert.equal(raw, "r0001");
  assert.equal(duplicate, raw);
  assert.equal(wiki, "w0001");
  assert.deepEqual(ledger.resolveAll([raw, wiki]), [
    { sourceId: "source", contentHash: "a".repeat(64), sectionId: "s0001" },
    { wikiPath: "wiki/concepts/tcp.md", wikiHash: "b".repeat(64) }
  ]);
});

test("IngestCoordinator uses Flash then Pro, rejects guessed sections, and builds host coverage without submit", async () => {
  const input = ingestInput();
  const runtime = new CoordinatorRuntime(input);
  const host = coordinatorHost(input, []);
  const coordinator = new IngestCoordinator(host as any, factory(runtime), settings);
  const controller = new AbortController();

  const result = await coordinator.run({
    attempts: [{ sourceId: input.sourceId, attemptId: "attempt", input }],
    budget: DEFAULT_AGENT_BUDGETS.ingest,
    sink: () => undefined,
    signal: controller.signal
  });

  assert.deepEqual(runtime.roles, ["fast", "default", "default", "fast", "default"]);
  assert.deepEqual(runtime.tools, [
    "select_raw_sections", "analyze_ingest_sources", "complete_knowledge_merge", "plan_wiki_links",
    "generate_wiki_page_drafts"
  ]);
  assert.ok(!runtime.tools.includes("submit_changes"));
  assert.ok(result.trace.iterations <= 16);
  assert.equal(result.trace.contextCheckpoints, undefined);
  assert.equal(result.plan.operations.length, 2);
  assert.deepEqual(result.plan.operations.map((item) => item.path).sort(), [
    "wiki/concepts/tcp-sticky-packet.md",
    "wiki/sources/test-source.md"
  ]);
  assert.deepEqual(result.plan.ingestCoverage?.sources[0]?.reviewedSectionIds, ["s0001"]);
  assert.equal(result.plan.ingestCoverage?.decisions[0]?.decision, "created");
  assert.match(result.plan.operations.find((item) => item.path.startsWith("wiki/sources/"))?.reason ?? "", /s0001/);
  const sourceOperation = result.plan.operations.find((item) => item.path.startsWith("wiki/sources/"))!;
  const sourcePage = parseMarkdown(sourceOperation.path, sourceOperation.content)!;
  assert.equal(sourcePage.frontmatter.author, "Trusted Author");
  assert.equal(sourcePage.frontmatter.url, "https://example.com/article?token=%5BREDACTED%5D&view=full");
});

test("IngestCoordinator registers one Wiki evidence for repeated search matches and emits already-covered coverage", async () => {
  const input = ingestInput();
  const existingContent = makePageTemplate("concept", "TCP 粘包", "已有完整内容", "# TCP 粘包\n\n已有完整内容。");
  const existing = wikiPage("wiki/concepts/tcp-sticky-packet.md", existingContent);
  const runtime = new CoordinatorRuntime(input, "already_covered");
  const host = coordinatorHost(input, [existing]);
  const coordinator = new IngestCoordinator(host as any, factory(runtime), settings);

  const result = await coordinator.run({
    attempts: [{ sourceId: input.sourceId, attemptId: "attempt", input }],
    budget: DEFAULT_AGENT_BUDGETS.ingest,
    sink: () => undefined,
    signal: new AbortController().signal
  });

  assert.equal(result.trace.readStats?.wikiUnique, 1);
  assert.equal(result.trace.readStats?.wikiDuplicate, 0);
  assert.equal(result.trace.readStats?.wikiIndexQueries, 1);
  assert.equal(result.plan.ingestCoverage?.decisions[0]?.decision, "already_covered");
  assert.deepEqual(result.plan.operations.map((item) => item.path), ["wiki/sources/test-source.md"]);
  assert.equal(result.plan.ingestCoverage?.decisions[0]?.evidence.some((item) => item.wikiPath === existing.path), true);
});

test("IngestCoordinator corrects an entity proposal to an existing cross-type concept", async () => {
  const input = ingestInput();
  const existingContent = makePageTemplate("concept", "HTTP 协议", "已有 HTTP 知识", "# HTTP 协议\n\n已有内容。");
  const existing = wikiPage("wiki/concepts/http-protocol.md", existingContent);
  const runtime = new CrossTypeRuntime(input);
  const coordinator = new IngestCoordinator(coordinatorHost(input, [existing]) as any, factory(runtime), settings);

  const result = await coordinator.run({
    attempts: [{ sourceId: input.sourceId, attemptId: "attempt", input }],
    budget: DEFAULT_AGENT_BUDGETS.ingest,
    sink: () => undefined,
    signal: new AbortController().signal
  });

  assert.equal(result.state.candidates[0]?.proposedType, "entity");
  assert.equal(result.state.candidates[0]?.resolvedType, "concept");
  assert.equal(result.plan.ingestCoverage?.decisions[0]?.targetPath, existing.path);
  assert.equal(result.plan.ingestCoverage?.decisions[0]?.type, "concept");
  assert.deepEqual(result.plan.operations.map((operation) => operation.path), ["wiki/sources/test-source.md"]);
  assert.equal(result.trace.readStats?.crossTypeMatches, 1);
  assert.equal(result.trace.readStats?.typeCorrections, 1);
});

test("IngestCoordinator repairs an incomplete DeepSeek-style analysis instead of accepting zero candidates", async () => {
  const input = ingestInput();
  const runtime = new CoordinatorRuntime(input, "created", true);
  const coordinator = new IngestCoordinator(coordinatorHost(input, []) as any, factory(runtime), settings);

  const result = await coordinator.run({
    attempts: [{ sourceId: input.sourceId, attemptId: "attempt", input }],
    budget: DEFAULT_AGENT_BUDGETS.ingest,
    sink: () => undefined,
    signal: new AbortController().signal
  });

  assert.deepEqual(runtime.tools.slice(0, 3), [
    "select_raw_sections", "analyze_ingest_sources", "repair_source_analysis"
  ]);
  assert.equal(result.plan.ingestCoverage?.decisions.length, 1);
  assert.equal(result.plan.ingestCoverage?.categoryAssessments.find((item) => item.type === "concept")?.outcome, "candidates_found");
});

test("IngestCoordinator splits only the malformed merge batch and keeps completed decisions", async () => {
  const input = ingestInput();
  const runtime = new CoordinatorRuntime(input, "created", false, 2, true);
  const coordinator = new IngestCoordinator(coordinatorHost(input, []) as any, factory(runtime), settings);

  const result = await coordinator.run({
    attempts: [{ sourceId: input.sourceId, attemptId: "attempt", input }],
    budget: DEFAULT_AGENT_BUDGETS.ingest,
    sink: () => undefined,
    signal: new AbortController().signal
  });

  assert.equal(runtime.tools.filter((name) => name === "complete_knowledge_merge").length, 3);
  assert.equal(result.plan.ingestCoverage?.decisions.length, 2);
  assert.equal(result.plan.operations.filter((item) => item.path.startsWith("wiki/concepts/")).length, 2);
  const linked = result.plan.operations.find((item) => item.path === "wiki/concepts/tcp-sticky-packet.md")!;
  const linkedPage = parseMarkdown(linked.path, linked.content)!;
  assert.deepEqual(linkedPage.related, ["wiki/concepts/tcp-sticky-2"]);
  assert.match(linkedPage.body, /llm-wiki:related:start/);
  assert.equal(result.trace.linkGraph?.acceptedEdges, 1);
  assert.ok(result.trace.iterations <= 16);
});

test("IngestCoordinator de-duplicates oversized raw evidence lists without aborting Ingest", async () => {
  const input = ingestInput();
  const runtime = new CoordinatorRuntime(input, "created", false, 1, false, 80);
  const coordinator = new IngestCoordinator(coordinatorHost(input, []) as any, factory(runtime), settings);

  const result = await coordinator.run({
    attempts: [{ sourceId: input.sourceId, attemptId: "attempt", input }],
    budget: DEFAULT_AGENT_BUDGETS.ingest,
    sink: () => undefined,
    signal: new AbortController().signal
  });

  assert.equal(result.plan.ingestCoverage?.decisions.length, 1);
  assert.deepEqual(result.plan.ingestCoverage?.decisions[0]?.evidence, [{
    sourceId: input.sourceId,
    contentHash: input.contentHash,
    sectionId: "s0001"
  }]);
});

test("IngestCoordinator drafts sixteen candidates in six plain-Markdown batches", async () => {
  const input = ingestInput();
  const runtime = new CoordinatorRuntime(input, "created", false, 16);
  const coordinator = new IngestCoordinator(coordinatorHost(input, []) as any, factory(runtime), settings);

  const result = await coordinator.run({
    attempts: [{ sourceId: input.sourceId, attemptId: "attempt", input }],
    budget: DEFAULT_AGENT_BUDGETS.ingest,
    sink: () => undefined,
    signal: new AbortController().signal
  });

  assert.equal(runtime.tools.filter((name) => name === "generate_wiki_page_drafts").length, 6);
  assert.equal(runtime.tools.filter((name) => name === "repair_wiki_page_drafts").length, 0);
  assert.equal(result.plan.operations.filter((item) => item.path.startsWith("wiki/concepts/")).length, 16);
  const draftTraces = result.trace.toolCalls.filter((item) => item.name === "generate_wiki_page_drafts");
  assert.deepEqual(draftTraces.map((item) => item.parameters.batchSize), [3, 3, 3, 3, 3, 1]);
  assert.ok(draftTraces.every((item) => item.parameters.protocol === "plain-markdown"));
  assert.ok(draftTraces.every((item) => item.parameters.invalidCount === 0));
});

test("IngestCoordinator drafts with two independent runtimes and shared request accounting", async () => {
  const input = ingestInput();
  const primary = new CoordinatorRuntime(input, "created", false, 6);
  const secondary = new CoordinatorRuntime(input, "created", false, 6);
  const coordinator = new IngestCoordinator(
    coordinatorHost(input, []) as any,
    rotatingFactory(primary, secondary),
    settings
  );

  const result = await coordinator.run({
    attempts: [{ sourceId: input.sourceId, attemptId: "attempt", input }],
    budget: DEFAULT_AGENT_BUDGETS.ingest,
    sink: () => undefined,
    signal: new AbortController().signal
  });

  assert.equal(result.trace.draftConcurrency?.configured, 2);
  assert.equal(result.trace.draftConcurrency?.peak, 2);
  assert.equal(result.trace.draftConcurrency?.degradedToSerial, false);
  assert.equal(result.plan.operations.filter((operation) => operation.path.startsWith("wiki/concepts/")).length, 6);
  assert.equal(result.trace.iterations, result.trace.providerRequests?.length);
});

test("IngestCoordinator degrades draft concurrency after provider overload and retries only unresolved work", async () => {
  const input = ingestInput();
  const primary = new CoordinatorRuntime(input, "created", false, 6);
  const secondary = new OverloadedDraftRuntime(input);
  const coordinator = new IngestCoordinator(
    coordinatorHost(input, []) as any,
    rotatingFactory(primary, secondary),
    settings
  );

  const events: AgentEvent[] = [];
  const result = await coordinator.run({
    attempts: [{ sourceId: input.sourceId, attemptId: "attempt", input }],
    budget: DEFAULT_AGENT_BUDGETS.ingest,
    sink: (event) => events.push(event),
    signal: new AbortController().signal
  });

  assert.equal(result.trace.draftConcurrency?.degradedToSerial, true);
  assert.equal(result.plan.operations.filter((operation) => operation.path.startsWith("wiki/concepts/")).length, 6);
  assert.equal(events.some((event) => event.type === "error"), false);
  assert.equal(events.some((event) => event.type === "status" && event.message.includes("降级为串行")), true);
});

test("IngestCoordinator keeps valid pages and repairs only the missing draft", async () => {
  const input = ingestInput();
  const runtime = new PartialDraftRuntime(input);
  const coordinator = new IngestCoordinator(coordinatorHost(input, []) as any, factory(runtime), settings);

  const result = await coordinator.run({
    attempts: [{ sourceId: input.sourceId, attemptId: "attempt", input }],
    budget: DEFAULT_AGENT_BUDGETS.ingest,
    sink: () => undefined,
    signal: new AbortController().signal
  });

  assert.deepEqual(runtime.draftBatchSizes, [3, 1]);
  assert.equal(result.plan.operations.filter((item) => item.path.startsWith("wiki/concepts/")).length, 3);
  const generated = result.trace.toolCalls.find((item) => item.name === "generate_wiki_page_drafts")!;
  const repaired = result.trace.toolCalls.find((item) => item.name === "repair_wiki_page_drafts")!;
  assert.equal(generated.parameters.validCount, 2);
  assert.equal(generated.parameters.invalidCount, 1);
  assert.equal(repaired.parameters.validCount, 1);
});

test("IngestCoordinator splits a truncated text batch and does not use JSON draft tools", async () => {
  const input = ingestInput();
  const runtime = new TruncatedDraftRuntime(input);
  const coordinator = new IngestCoordinator(coordinatorHost(input, []) as any, factory(runtime), settings);

  const result = await coordinator.run({
    attempts: [{ sourceId: input.sourceId, attemptId: "attempt", input }],
    budget: DEFAULT_AGENT_BUDGETS.ingest,
    sink: () => undefined,
    signal: new AbortController().signal
  });

  assert.deepEqual(runtime.draftBatchSizes, [3, 2, 1]);
  assert.equal(result.plan.operations.filter((item) => item.path.startsWith("wiki/concepts/")).length, 3);
  assert.ok(runtime.draftRequests.every((request) => request.tools.length === 0 && request.toolChoice === "none"));
});

test("IngestCoordinator sends only the invalid WorkingSet page to plain-Markdown repair", async () => {
  const input = ingestInput();
  const runtime = new WorkingSetRepairRuntime(input);
  const coordinator = new IngestCoordinator(coordinatorHost(input, []) as any, factory(runtime), settings);

  const result = await coordinator.run({
    attempts: [{ sourceId: input.sourceId, attemptId: "attempt", input }],
    budget: DEFAULT_AGENT_BUDGETS.ingest,
    sink: () => undefined,
    signal: new AbortController().signal
  });

  assert.deepEqual(runtime.repairedPaths, ["wiki/concepts/tcp-sticky-packet.md"]);
  assert.equal(result.plan.operations.length, 2);
  const repair = result.trace.toolCalls.find((item) => item.name === "repair_wiki_pages")!;
  assert.equal(repair.parameters.protocol, "plain-markdown");
  assert.equal(repair.parameters.batchSize, 1);
});

test("IngestCoordinator repairs invalid link planning once and then falls back without aborting", async () => {
  const input = ingestInput();
  const runtime = new InvalidLinkRuntime(input);
  const coordinator = new IngestCoordinator(coordinatorHost(input, []) as any, factory(runtime), settings);

  const result = await coordinator.run({
    attempts: [{ sourceId: input.sourceId, attemptId: "attempt", input }],
    budget: DEFAULT_AGENT_BUDGETS.ingest,
    sink: () => undefined,
    signal: new AbortController().signal
  });

  assert.equal(runtime.tools.filter((name) => name === "plan_wiki_links").length, 1);
  assert.equal(runtime.tools.filter((name) => name === "repair_wiki_links").length, 1);
  assert.equal(result.trace.linkGraph?.fallback, "invalid_relation_output");
  assert.equal(result.plan.operations.filter((item) => item.path.startsWith("wiki/concepts/")).length, 2);
});

class CoordinatorRuntime implements AgentRuntime {
  readonly roles: string[] = [];
  readonly tools: string[] = [];
  private failedLargeMerge = false;

  constructor(
    private readonly input: IngestInput,
    private readonly decision: "created" | "already_covered" = "created",
    private readonly omitInitialCandidates = false,
    private readonly candidateCount = 1,
    private readonly failLargeMergeOnce = false,
    private readonly evidenceRepeatCount = 1
  ) {}

  async initialize(_config: AgentConfig): Promise<void> {}
  async startSession(_options: SessionOptions): Promise<AgentSession> { return { id: "coordinator" }; }
  async *send(_message: AgentMessage): AsyncIterable<never> {}
  async runTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    const payload = requestPayload(request);
    const isTextDraft = request.tools.length === 0;
    const name = isTextDraft
      ? (payload.candidate ? "repair_wiki_page_drafts" : payload.path ? "repair_wiki_pages" : "generate_wiki_page_drafts")
      : request.tools[0]!.name;
    this.roles.push(String(request.modelRole));
    this.tools.push(name);
    if (isTextDraft) {
      const candidates = (payload.payload?.candidates ?? (payload.candidate ? [payload.candidate] : [])) as Array<Record<string, unknown>>;
      const text = markedDrafts(candidates);
      return {
        text,
        toolCalls: [],
        provider: "anthropic-messages",
        model: request.modelRole === "fast" ? "flash" : "pro",
        usage: { inputTokens: 100, outputTokens: 50 },
        finishReason: "end_turn"
      };
    }
    let value: Record<string, unknown>;
    if (name === "select_raw_sections") {
      // s9999 is deliberately undisclosed; the host must fall back to s0001.
      value = { sources: [{ sourceId: this.input.sourceId, sectionIds: ["s9999"] }] };
    } else if (name === "analyze_ingest_sources" && this.omitInitialCandidates) {
      value = {
        sourceDrafts: [{
          sourceId: this.input.sourceId,
          title: "Test Source",
          slug: "test-source",
          tldr: "A verified source",
          body: "# Test Source\n\nVerified source summary."
        }]
      };
    } else if (name === "analyze_ingest_sources" || name === "repair_source_analysis") {
      value = {
        sourceDrafts: [{
          sourceId: this.input.sourceId,
          title: "Test Source",
          slug: "test-source",
          tldr: "A verified source",
          body: "# Test Source\n\nVerified source summary."
        }],
        candidates: Array.from({ length: this.candidateCount }, (_, index) => ({
          candidateId: index === 0 ? "tcp-sticky" : `tcp-sticky-${index + 1}`,
          sourceId: this.input.sourceId,
          type: "concept",
          title: index === 0 ? "TCP 粘包" : `TCP 粘包扩展 ${index + 1}`,
          rawEvidenceIds: Array.from({ length: this.evidenceRepeatCount }, () => "r0001"),
          searchQueries: index === 0 ? ["TCP 粘包", "sticky packet"] : [`TCP 粘包扩展 ${index + 1}`]
        })),
        categoryAssessments: [
          { sourceId: this.input.sourceId, type: "entity", outcome: "none", reason: "来源没有需要独立维护的命名实体" },
          { sourceId: this.input.sourceId, type: "concept", outcome: "candidates_found", reason: "识别到 TCP 粘包这一可复用概念" },
          { sourceId: this.input.sourceId, type: "synthesis", outcome: "none", reason: "当前证据不足以形成跨概念综合页面" }
        ]
      };
    } else if (name === "plan_wiki_links" || name === "repair_wiki_links") {
      const candidates = payload.candidates as Array<Record<string, unknown>>;
      value = {
        relations: candidates.length > 1 ? [{
          fromCandidateId: String(candidates[0]!.candidateId),
          toCandidateId: String(candidates[1]!.candidateId),
          type: "related",
          reason: "两个知识候选属于同一来源主题",
          confidence: 0.9
        }] : []
      };
    } else {
      const candidates = payload.candidates as Array<Record<string, unknown>>;
      if (this.failLargeMergeOnce && candidates.length > 1 && !this.failedLargeMerge) {
        this.failedLargeMerge = true;
        throw new AgentProviderError("INVALID_STRUCTURED_OUTPUT", "Tool complete_knowledge_merge 参数不是有效 JSON", false);
      }
      value = {
        decisions: candidates.map((candidate, index) => this.decision === "created" ? {
          candidateId: String(candidate.candidateId),
          decision: "created",
          targetPath: index === 0 && String(candidate.candidateId) === "tcp-sticky"
            ? "wiki/concepts/tcp-sticky-packet.md"
            : `wiki/concepts/${String(candidate.candidateId)}.md`,
          reason: "具有长期复用价值",
          evidenceIds: ["r0001"],
          confidence: 0.95,
          needsExploration: false
        } : {
          candidateId: String(candidate.candidateId),
          decision: "already_covered",
          targetPath: "wiki/concepts/tcp-sticky-packet.md",
          reason: "现有页面已完整覆盖",
          evidenceIds: ["r0001", "w0001"],
          confidence: 0.95,
          needsExploration: false
        })
      };
    }
    return {
      text: "",
      toolCalls: [{ id: `${name}-call`, name, input: value }],
      provider: "anthropic-messages",
      model: request.modelRole === "fast" ? "flash" : "pro",
      usage: { inputTokens: 100, outputTokens: 50 }
    };
  }
  async testConnection(): Promise<string> { return "OK"; }
  async cancel(): Promise<void> {}
  async dispose(): Promise<void> {}
}

class CrossTypeRuntime implements AgentRuntime {
  private readonly base: CoordinatorRuntime;

  constructor(private readonly input: IngestInput) { this.base = new CoordinatorRuntime(input); }
  async initialize(config: AgentConfig): Promise<void> { await this.base.initialize(config); }
  async startSession(options: SessionOptions): Promise<AgentSession> { return this.base.startSession(options); }
  async *send(message: AgentMessage): AsyncIterable<never> { yield* this.base.send(message); }
  async runTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    const name = request.tools[0]?.name;
    if (name === "complete_knowledge_merge" || name === "repair_merge_decisions") {
      return {
        text: "",
        toolCalls: [{ id: "merge", name, input: { decisions: [{
          candidateId: "http",
          resolvedType: "entity",
          decision: "already_covered",
          targetPath: "wiki/concepts/http-protocol.md",
          reason: "已有页面覆盖",
          evidenceIds: ["r0001", "w0001"],
          confidence: 0.95,
          needsExploration: false
        }] } }],
        provider: "anthropic-messages", model: "pro",
        usage: { inputTokens: 100, outputTokens: 50 }
      };
    }
    const result = await this.base.runTurn(request);
    if (name === "analyze_ingest_sources" || name === "repair_source_analysis") {
      const output = result.toolCalls[0]!.input as Record<string, any>;
      output.candidates = [{
        candidateId: "http", sourceId: this.input.sourceId, type: "entity", title: "HTTP协议",
        rawEvidenceIds: ["r0001"], searchQueries: ["HTTP", "HTTP 协议"]
      }];
      output.categoryAssessments = [
        { sourceId: this.input.sourceId, type: "entity", outcome: "candidates_found", reason: "模型建议为实体" },
        { sourceId: this.input.sourceId, type: "concept", outcome: "none", reason: "模型未识别概念" },
        { sourceId: this.input.sourceId, type: "synthesis", outcome: "none", reason: "没有综合候选" }
      ];
    }
    return result;
  }
  async testConnection(): Promise<string> { return "OK"; }
  async cancel(): Promise<void> { await this.base.cancel(); }
  async dispose(): Promise<void> { await this.base.dispose(); }
}

class OverloadedDraftRuntime extends CoordinatorRuntime {
  private overloaded = false;

  override async runTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    if (request.tools.length === 0 && !this.overloaded) {
      this.overloaded = true;
      throw new AgentProviderError("RATE_LIMITED", "too many requests", true, 429);
    }
    return super.runTurn(request);
  }
}

class PartialDraftRuntime extends CoordinatorRuntime {
  readonly draftBatchSizes: number[] = [];
  private generated = false;

  constructor(input: IngestInput) {
    super(input, "created", false, 3);
  }

  override async runTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    if (request.tools.length > 0) return super.runTurn(request);
    const payload = requestPayload(request);
    const candidates = (payload.payload?.candidates ?? (payload.candidate ? [payload.candidate] : [])) as Array<Record<string, unknown>>;
    this.draftBatchSizes.push(candidates.length);
    if (!this.generated) {
      this.generated = true;
      this.roles.push(String(request.modelRole));
      this.tools.push("generate_wiki_page_drafts");
      return textTurn(`模型说明：以下是草稿。\n${markedDrafts(candidates.slice(0, 2))}`, request);
    }
    const content = markedDrafts(candidates).replace(/\n/g, "\r\n");
    this.roles.push(String(request.modelRole));
    this.tools.push("repair_wiki_page_drafts");
    return textTurn(`\uFEFF\`\`\`markdown\r\n${content}\r\n\`\`\``, request);
  }
}

class TruncatedDraftRuntime extends CoordinatorRuntime {
  readonly draftBatchSizes: number[] = [];
  readonly draftRequests: AgentTurnRequest[] = [];
  private truncated = false;

  constructor(input: IngestInput) {
    super(input, "created", false, 3);
  }

  override async runTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    if (request.tools.length > 0) return super.runTurn(request);
    const payload = requestPayload(request);
    const candidates = (payload.payload?.candidates ?? []) as Array<Record<string, unknown>>;
    this.draftBatchSizes.push(candidates.length);
    this.draftRequests.push(request);
    this.roles.push(String(request.modelRole));
    this.tools.push("generate_wiki_page_drafts");
    if (!this.truncated) {
      this.truncated = true;
      return { ...textTurn(markedDrafts(candidates.slice(0, 1)), request), finishReason: "max_tokens" };
    }
    return textTurn(markedDrafts(candidates), request);
  }
}

class WorkingSetRepairRuntime extends CoordinatorRuntime {
  readonly repairedPaths: string[] = [];

  constructor(input: IngestInput) {
    super(input);
  }

  override async runTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    if (request.tools.length > 0) return super.runTurn(request);
    const payload = requestPayload(request);
    this.roles.push(String(request.modelRole));
    if (payload.path) {
      this.tools.push("repair_wiki_pages");
      this.repairedPaths.push(String(payload.path));
      return textTurn(makePageTemplate("concept", "TCP 粘包", "TCP 消息边界问题", "修复后的正文。"), request);
    }
    this.tools.push("generate_wiki_page_drafts");
    const candidates = payload.payload.candidates as Array<Record<string, unknown>>;
    const candidate = candidates[0]!;
    const content = makePageTemplate(
      "concept", String(candidate.title), "TCP 消息边界问题", "包含一个 [[wiki/concepts/not-found]] 悬空链接。"
    );
    return textTurn(
      `<!-- llm-wiki:draft=${String(candidate.candidateId)} -->\n${content}\n<!-- llm-wiki:end-draft -->`,
      request
    );
  }
}

class InvalidLinkRuntime extends CoordinatorRuntime {
  constructor(input: IngestInput) {
    super(input, "created", false, 2);
  }

  override async runTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    const name = request.tools[0]?.name;
    if (name !== "plan_wiki_links" && name !== "repair_wiki_links") return super.runTurn(request);
    this.roles.push(String(request.modelRole));
    this.tools.push(name);
    return {
      text: "",
      toolCalls: [{ id: `${name}-call`, name, input: { relations: [{ fromCandidateId: "tcp-sticky" }] } }],
      provider: "anthropic-messages",
      model: "flash",
      usage: { inputTokens: 100, outputTokens: 20 }
    };
  }
}

function markedDrafts(candidates: Array<Record<string, unknown>>): string {
  return candidates.map((candidate) => {
    const candidateId = String(candidate.candidateId);
    const content = makePageTemplate(
      "concept", String(candidate.title), "TCP 消息边界问题", `# ${String(candidate.title)}\n\n来自来源的事实。`
    );
    return `<!-- llm-wiki:draft=${candidateId} -->\n${content}\n<!-- llm-wiki:end-draft -->`;
  }).join("\n\n");
}

function textTurn(text: string, request: AgentTurnRequest): AgentTurnResult {
  return {
    text,
    toolCalls: [],
    provider: "anthropic-messages",
    model: request.modelRole === "fast" ? "flash" : "pro",
    usage: { inputTokens: 100, outputTokens: 50 },
    finishReason: "end_turn"
  };
}

function requestPayload(request: AgentTurnRequest): Record<string, any> {
  const text = request.messages?.flatMap((message) => message.content)
    .find((item) => item.type === "text") as { type: "text"; text: string } | undefined;
  return JSON.parse(text?.text ?? "{}");
}

function factory(runtime: AgentRuntime): AgentRuntimeFactory {
  return { create: async () => runtime };
}

function rotatingFactory(...runtimes: AgentRuntime[]): AgentRuntimeFactory {
  let index = 0;
  return { create: async () => runtimes[Math.min(index++, runtimes.length - 1)]! };
}

function coordinatorHost(input: IngestInput, pages: WikiPage[]): Record<string, unknown> {
  const hashes = new Map(pages.map((page) => [page.path, sha256(page.content)]));
  return {
    readVerifiedSource: async () => ({ manifest: sourceManifest(input), content: "# Test\n\nTCP sticky packet fact." }),
    search: async () => pages.map((page) => ({ page, score: 10, reasons: ["test"] })),
    readPages: async () => pages,
    readWikiPage: async (path: string) => {
      const page = pages.find((item) => item.path === path);
      if (!page) throw new Error(`not found: ${path}`);
      return page;
    },
    currentHashes: async () => new Map(hashes),
    validateAgentPlan: async (plan: unknown) => validateChangePlan(plan, new Map(hashes))
  };
}

function ingestInput(): IngestInput {
  return {
    sourceId: "source-1",
    revision: 1,
    rawPath: "raw/articles/test.md",
    sourceHash: "a".repeat(64),
    contentHash: "b".repeat(64),
    artifactHash: "c".repeat(64),
    parserId: "markdown-pass-through",
    parserVersion: "1.0.0",
    parseWarnings: [],
    metadata: {
      author: "Trusted Author",
      url: "https://user:password@example.com/article?token=secret&view=full"
    }
  };
}

function sourceManifest(input: IngestInput): SourceManifest {
  return {
    schemaVersion: 3,
    manifestRevision: 1,
    sourceId: input.sourceId,
    sourceHash: input.sourceHash,
    original: { name: "test.md", mime: "text/markdown", size: 32, objectPath: ".llm-wiki/objects/test.md" },
    source: { kind: "markdown", acquiredBy: "file-picker" },
    parse: { status: "parsed", currentRevision: 1, attempts: [], revisions: [] },
    ingest: { status: "planning", attempts: [] }
  } as unknown as SourceManifest;
}

function wikiPage(path: string, content: string): WikiPage {
  return parseMarkdown(path, content)!;
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
      models: [
        { id: "flash", label: "Flash", contextWindow: 200_000, role: "fast" },
        { id: "pro", label: "Pro", contextWindow: 1_000_000, role: "default" },
        { id: "pro", label: "Deep", contextWindow: 1_000_000, role: "deep" }
      ]
    },
    activeTab: "home",
    sessions: [],
    activeSessionId: "",
    webClipper: { enabled: false, inboxPath: "Clippings", scanExistingOnStartup: false }
  };
}
