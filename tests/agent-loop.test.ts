import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop } from "../src/agent/agent-loop";
import { AgentCommandRegistry } from "../src/agent/agent-command-registry";
import { EvidenceLedger } from "../src/agent/evidence-ledger";
import type { AgentRuntimeFactory } from "../src/agent/runtime-factory";
import { ToolPolicy, ToolRegistry, type AgentTool, type ToolExecutionContext } from "../src/agent/tools";
import { WorkingSet } from "../src/agent/working-set";
import { markdownSections } from "../src/agent/wiki-tools";
import { makePageTemplate } from "../src/core/wiki-core";
import type { AgentRuntime, AgentTurnRequest, AgentTurnResult } from "../src/types";

const budget = {
  maxIterations: 5, maxToolCalls: 8, maxChangedPages: 2, maxWallTimeMs: 10_000,
  maxInputTokens: 10_000, maxOutputTokens: 1_000, maxToolResultTokens: 1_000
};

test("AgentLoop runs parallel-safe reads concurrently and serializes stage tools", async () => {
  const registry = new ToolRegistry();
  let activeReads = 0;
  let peakReads = 0;
  const mutationOrder: string[] = [];
  for (const name of ["read_a", "read_b"]) registry.register(fakeTool(name, "read", true, async () => {
    activeReads += 1;
    peakReads = Math.max(peakReads, activeReads);
    await delay(15);
    activeReads -= 1;
    return { output: { ok: true }, summary: name };
  }));
  for (const name of ["stage_a", "stage_b"]) registry.register(fakeTool(name, "stage", false, async () => {
    mutationOrder.push(`${name}:start`);
    await delay(5);
    mutationOrder.push(`${name}:end`);
    return { output: { ok: true }, summary: name };
  }));
  const runtime = new TurnsRuntime([
    calls("read_a", "read_b"),
    calls("stage_a", "stage_b"),
    { text: "done", toolCalls: [], provider: "anthropic-messages", model: "test" }
  ]);
  const result = await new AgentLoop(factory(runtime), registry).run({
    purpose: "query", modelRole: "fast", systemPrompt: "test", userPrompt: "test",
    allowedTools: ["read_a", "read_b", "stage_a", "stage_b"], budget, requiresSubmit: false,
    context: context(), signal: new AbortController().signal
  }, () => undefined);
  assert.equal(result.text, "done");
  assert.equal(peakReads, 2);
  assert.deepEqual(mutationOrder, ["stage_a:start", "stage_a:end", "stage_b:start", "stage_b:end"]);
});

test("AgentLoop gives read-only answers two bounded local-validation repair turns", async () => {
  const runtime = new TurnsRuntime([
    { text: "uncited", toolCalls: [], provider: "anthropic-messages", model: "test" },
    { text: "still uncited", toolCalls: [], provider: "anthropic-messages", model: "test" },
    { text: "verified [[wiki/concepts/a]]", toolCalls: [], provider: "anthropic-messages", model: "test" }
  ]);
  let validations = 0;
  const result = await new AgentLoop(factory(runtime), new ToolRegistry()).run({
    purpose: "query", modelRole: "fast", systemPrompt: "test", userPrompt: "test",
    allowedTools: [], budget, requiresSubmit: false, context: context(),
    validateFinalText: async (text) => ({
      ok: ++validations === 3,
      message: "missing citation",
      degradedText: `${text}\nwarning`
    }),
    maxFinalRepairs: 2
  }, () => undefined);
  assert.equal(validations, 3);
  assert.equal(result.text, "verified [[wiki/concepts/a]]");
  assert.equal(result.trace.iterations, 3);
});

test("ToolPolicy rejects unauthorized tools and invalid structured parameters", () => {
  const tool = fakeTool("read", "read", true, async () => ({ output: {}, summary: "ok" }), {
    type: "object", additionalProperties: false, required: ["limit"],
    properties: { limit: { type: "integer", minimum: 1, maximum: 3 } }
  });
  assert.throws(() => new ToolPolicy(new Set()).authorize(tool, context(), { limit: 1 }), /不允许/);
  const policy = new ToolPolicy(new Set(["read"]));
  assert.throws(() => policy.authorize(tool, context(), { limit: 4, surprise: true }), /参数无效/);
  assert.doesNotThrow(() => policy.authorize(tool, context(), { limit: 2 }));
});

test("AgentLoop wall-time budget cancels an in-flight provider turn", async () => {
  const runtime = new BlockingRuntime();
  const loop = new AgentLoop(factory(runtime), new ToolRegistry());
  await assert.rejects(() => loop.run({
    purpose: "chat", modelRole: "fast", systemPrompt: "test", userPrompt: "test",
    allowedTools: [], budget: { ...budget, maxWallTimeMs: 20 }, requiresSubmit: false,
    context: context(), signal: new AbortController().signal
  }, () => undefined), /超时/);
  assert.equal(runtime.cancelled, true);
});

test("per-turn context capacity does not cap cumulative run input tokens", async () => {
  const registry = new ToolRegistry();
  registry.register(fakeTool("read", "read", true, async () => ({ output: { text: "evidence" }, summary: "read" })));
  const runtime = new TurnsRuntime([
    { ...calls("read"), usage: { inputTokens: 6_000, outputTokens: 10, totalTokens: 6_010 } },
    { text: "done", toolCalls: [], provider: "anthropic-messages", model: "test",
      usage: { inputTokens: 6_000, outputTokens: 10, totalTokens: 6_010 } }
  ]);
  const result = await new AgentLoop(factory(runtime), registry).run({
    purpose: "query", modelRole: "fast", systemPrompt: "test", userPrompt: "test",
    allowedTools: ["read"], budget: { ...budget, maxInputTokens: 15_000 },
    maxContextTokens: 5_000, maxTurnOutputTokens: 500, requiresSubmit: false,
    context: context(), signal: new AbortController().signal
  }, () => undefined);
  assert.equal(result.text, "done");
  assert.equal(result.trace.inputTokens, 12_000);
});

test("AgentLoop creates fast LLM checkpoints and sends a compacted protocol-safe history", async () => {
  const registry = new ToolRegistry();
  let reads = 0;
  registry.register(fakeTool("read", "read", true, async () => ({
    output: { content: `READ-${++reads}-`.repeat(1_000) }, summary: "read"
  })));
  const runtime = new CheckpointRuntime();
  const result = await new AgentLoop(factory(runtime), registry).run({
    purpose: "query", modelRole: "default", systemPrompt: "test", userPrompt: "test",
    allowedTools: ["read"], budget: { ...budget, maxIterations: 10, maxInputTokens: 100_000 },
    maxContextTokens: 100_000, maxTurnOutputTokens: 1_000, requiresSubmit: false,
    context: context(), signal: new AbortController().signal
  }, () => undefined);
  assert.equal(result.text, "done");
  assert.equal(result.trace.contextCheckpoints?.[0]?.usedLlm, true);
  assert.ok((result.trace.contextCheckpoints?.[0]?.beforeTokens ?? 0) > (result.trace.contextCheckpoints?.[0]?.afterTokens ?? 0));
  assert.equal(runtime.checkpointCalls, 1);
  assert.doesNotMatch(runtime.mainRequests.at(-2) ?? "", /READ-1-/);
  assert.match(runtime.mainRequests.at(-2) ?? "", /context checkpoint/);
});

test("invalid LLM checkpoint falls back to deterministic memory without stopping the run", async () => {
  const registry = new ToolRegistry();
  registry.register(fakeTool("read", "read", true, async () => ({ output: { content: "x".repeat(2_000) }, summary: "read" })));
  const runtime = new CheckpointRuntime(true);
  const result = await new AgentLoop(factory(runtime), registry).run({
    purpose: "query", modelRole: "default", systemPrompt: "test", userPrompt: "test",
    allowedTools: ["read"], budget: { ...budget, maxIterations: 10, maxInputTokens: 100_000 },
    maxContextTokens: 100_000, requiresSubmit: false, context: context()
  }, () => undefined);
  assert.equal(result.text, "done");
  assert.equal(result.trace.contextCheckpoints?.[0]?.usedLlm, false);
  assert.ok(result.trace.inputTokens >= 100);
  assert.ok(result.trace.outputTokens >= 20);
});

test("AgentLoop fails explicitly when compaction cannot bring live context below 90 percent", async () => {
  const runtime = new CheckpointRuntime();
  await assert.rejects(() => new AgentLoop(factory(runtime), new ToolRegistry()).run({
    purpose: "chat", modelRole: "default", systemPrompt: "SYSTEM-CONTEXT-".repeat(2_000), userPrompt: "test",
    allowedTools: [], budget: { ...budget, maxInputTokens: 100_000 }, maxContextTokens: 1_000,
    requiresSubmit: false, context: context()
  }, () => undefined), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "CONTEXT_CAPACITY_EXCEEDED");
    assert.match((error as Error).message, /90%/);
    assert.match((error as Error).message, /system/);
    return true;
  });
  assert.equal(runtime.checkpointCalls, 1);
  assert.equal(runtime.mainCalls, 0);
});

test("AgentLoop replays immutable read tools from the session cache and audits the hit", async () => {
  const registry = new ToolRegistry();
  let executions = 0;
  registry.register(fakeTool("get_page_template", "read", true, async () => ({
    output: { template: `template-${++executions}` }, summary: "template"
  }), {
    type: "object", additionalProperties: false, required: ["type"],
    properties: { type: { type: "string" } }
  }));
  const runtime = new TurnsRuntime([
    { text: "", provider: "anthropic-messages", model: "test", toolCalls: [{ id: "t1", name: "get_page_template", input: { type: "concept" } }] },
    { text: "", provider: "anthropic-messages", model: "test", toolCalls: [{ id: "t2", name: "get_page_template", input: { type: "concept" } }] },
    { text: "done", provider: "anthropic-messages", model: "test", toolCalls: [] }
  ]);
  const result = await new AgentLoop(factory(runtime), registry).run({
    purpose: "query", modelRole: "fast", systemPrompt: "test", userPrompt: "test",
    allowedTools: ["get_page_template"], budget, requiresSubmit: false, context: context()
  }, () => undefined);
  assert.equal(executions, 1);
  assert.equal(result.trace.toolCalls[1]?.cacheHit, true);
  assert.equal(result.trace.context?.cacheHits, 1);
});

test("AgentLoop stops repeated submit_changes failures instead of spending the full budget", async () => {
  const registry = new ToolRegistry();
  registry.register({
    descriptor: {
      name: "submit_changes", description: "submit", inputSchema: { type: "object", properties: {} },
      risk: "terminal", parallelSafe: false
    },
    execute: async () => { throw new Error("覆盖报告遗漏暂存知识页面：wiki/concepts/a.md"); }
  });
  const execution = context();
  await execution.workingSet.create("wiki/concepts/a.md", makePageTemplate("concept", "A", "A", "Body"));
  await execution.workingSet.validate();
  const runtime = new TurnsRuntime([1, 2, 3].map((index) => ({
    text: "", provider: "anthropic-messages" as const, model: "test",
    toolCalls: [{ id: `submit-${index}`, name: "submit_changes", input: {} }]
  })));
  await assert.rejects(() => new AgentLoop(factory(runtime), registry).run({
    purpose: "save", modelRole: "default", systemPrompt: "test", userPrompt: "test",
    allowedTools: ["submit_changes"], budget: { ...budget, maxIterations: 20, maxToolCalls: 20 },
    requiresSubmit: true, context: execution
  }, () => undefined), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "AGENT_TOOL_RETRY_LOOP");
    return true;
  });
});

test("WorkingSet refuses raw, index and log paths before staging", async () => {
  const workingSet = new WorkingSet({
    currentHashes: async () => new Map(),
    readWikiPage: async () => { throw new Error("not found"); }
  }, 3);
  await assert.rejects(() => workingSet.create("raw/articles/a.md", "x"), /禁止/);
  await assert.rejects(() => workingSet.create("wiki/index.md", "x"), /禁止/);
  await assert.rejects(() => workingSet.create("wiki/log.md", "x"), /禁止/);
});

test("WorkingSet summaries are body-free and validation is bound to its revision", async () => {
  const workingSet = new WorkingSet({
    currentHashes: async () => new Map(),
    readWikiPage: async () => { throw new Error("not found"); }
  }, 3);
  const body = "SENSITIVE-BODY-".repeat(200);
  await workingSet.create("wiki/concepts/context-window.md", makePageTemplate("concept", "Context Window", "Window", body));
  const summary = workingSet.summary();
  assert.doesNotMatch(summary, /SENSITIVE-BODY/);
  assert.match(summary, /chars=|current=/);
  assert.equal("diff" in workingSet.inspect()[0]!, false);
  assert.match(workingSet.inspect("wiki/concepts/context-window.md", "diff")[0]?.diff ?? "", /SENSITIVE-BODY/);
  const revision = workingSet.revision;
  assert.equal((await workingSet.validate()).ok, true);
  assert.equal(workingSet.revision, revision);
  assert.equal(workingSet.isCurrentRevisionValidated, true);
});

test("command registry parses scoped query, batch ingest and dry-run save", () => {
  const commands = new AgentCommandRegistry();
  assert.deepEqual(commands.parse('/query "why now" --scope hybrid --confidence'), {
    name: "query", question: "why now", scope: "hybrid", deep: false, cite: true, confidence: true
  });
  assert.deepEqual(commands.parse("/ingest batch a b --discuss"), {
    name: "ingest-batch", targets: ["a", "b"], discuss: true
  });
  assert.deepEqual(commands.parse("/ingest rollback source-1"), {
    name: "ingest-rollback", target: "source-1"
  });
  assert.deepEqual(commands.parse("/ingest rollback"), {
    name: "ingest-rollback", target: undefined
  });
  assert.deepEqual(commands.parse("/ingest delete raw/articles/source.md"), {
    name: "ingest-delete", target: "raw/articles/source.md"
  });
  assert.deepEqual(commands.parse("/save --type synthesis --dry-run hello"), {
    name: "save", content: "hello", pageType: "synthesis", dryRun: true
  });
});

test("raw section ids are deterministic and carry PDF page provenance", () => {
  const markdown = "<!-- llm-wiki:page=1 -->\n# One\n\nA\n<!-- llm-wiki:page=2 -->\n## Two\n\nB";
  const first = markdownSections(markdown);
  const second = markdownSections(markdown);
  assert.deepEqual(first, second);
  assert.equal(first.find((section) => section.heading === "One")?.page, 1);
  assert.equal(first.find((section) => section.heading === "Two")?.page, 2);
});

function context(): ToolExecutionContext {
  return {
    signal: new AbortController().signal,
    allowedSourceIds: new Set(), allowAllRaw: false, allowDiscussion: false,
    workingSet: new WorkingSet({ currentHashes: async () => new Map(), readWikiPage: async () => { throw new Error("not found"); } }, 2),
    evidenceLedger: new EvidenceLedger(), requireEvidence: false, validationCount: 0
  };
}

function fakeTool(
  name: string,
  risk: "read" | "stage",
  parallelSafe: boolean,
  execute: AgentTool["execute"],
  inputSchema: Record<string, unknown> = { type: "object", additionalProperties: false, properties: {} }
): AgentTool {
  return { descriptor: { name, description: name, inputSchema, risk, parallelSafe }, execute };
}

function calls(...names: string[]): AgentTurnResult {
  return {
    text: "", provider: "anthropic-messages", model: "test",
    toolCalls: names.map((name, index) => ({ id: `${name}-${index}`, name, input: {} }))
  };
}

class TurnsRuntime implements AgentRuntime {
  constructor(private readonly turns: AgentTurnResult[]) {}
  async runTurn(_request: AgentTurnRequest): Promise<AgentTurnResult> {
    const turn = this.turns.shift();
    if (!turn) throw new Error("unexpected turn");
    return turn;
  }
  async initialize(): Promise<void> {}
  async startSession(): Promise<{ id: string }> { return { id: "test" }; }
  async *send(): AsyncIterable<never> {}
  async testConnection(): Promise<string> { return "OK"; }
  async cancel(): Promise<void> {}
  async dispose(): Promise<void> {}
}

class CheckpointRuntime implements AgentRuntime {
  checkpointCalls = 0;
  mainCalls = 0;
  mainRequests: string[] = [];
  constructor(private readonly invalidCheckpoint = false) {}
  async runTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    if (request.tools.length === 0) {
      this.checkpointCalls += 1;
      return {
        text: this.invalidCheckpoint ? "not-json" : JSON.stringify({
          version: 1, phase: "answering", completedActions: ["read"],
          keyFindings: [], unresolved: [], nextActions: ["continue"]
        }),
        toolCalls: [], provider: "anthropic-messages", model: "fast",
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 }
      };
    }
    this.mainCalls += 1;
    this.mainRequests.push(JSON.stringify(request.messages));
    if (this.mainCalls <= 5) {
      return {
        text: "", provider: "anthropic-messages", model: "test",
        toolCalls: [{ id: `read-${this.mainCalls}`, name: "read", input: {} }]
      };
    }
    return { text: "done", toolCalls: [], provider: "anthropic-messages", model: "test" };
  }
  async initialize(): Promise<void> {}
  async startSession(): Promise<{ id: string }> { return { id: "checkpoint" }; }
  async *send(): AsyncIterable<never> {}
  async testConnection(): Promise<string> { return "OK"; }
  async cancel(): Promise<void> {}
  async dispose(): Promise<void> {}
}

class BlockingRuntime implements AgentRuntime {
  cancelled = false;
  private reject?: (error: Error) => void;
  async runTurn(): Promise<AgentTurnResult> {
    return new Promise<AgentTurnResult>((_resolve, reject) => { this.reject = reject; });
  }
  async initialize(): Promise<void> {}
  async startSession(): Promise<{ id: string }> { return { id: "blocking" }; }
  async *send(): AsyncIterable<never> {}
  async testConnection(): Promise<string> { return "OK"; }
  async cancel(): Promise<void> {
    this.cancelled = true;
    this.reject?.(new Error("cancelled"));
  }
  async dispose(): Promise<void> {}
}

function factory(runtime: AgentRuntime): AgentRuntimeFactory {
  return { create: async () => runtime };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
