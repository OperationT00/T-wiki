import assert from "node:assert/strict";
import test from "node:test";

import { selectActiveTools } from "../src/agent/agent-loop";
import { AgentContextManager } from "../src/agent/context-manager";
import { ContextMemory } from "../src/agent/context-memory";
import { EvidenceLedger } from "../src/agent/evidence-ledger";
import { ToolResultCache } from "../src/agent/tool-result-cache";
import type { ToolExecutionContext } from "../src/agent/tools";
import { WorkingSet } from "../src/agent/working-set";
import { makePageTemplate } from "../src/core/wiki-core";
import type { AgentConversationMessage, ContextCheckpoint } from "../src/types";

test("context compaction drops old large tool pairs and preserves recent reasoning continuations", () => {
  const manager = new AgentContextManager();
  const messages: AgentConversationMessage[] = [{ role: "user", content: [{ type: "text", text: "goal" }] }];
  for (let index = 1; index <= 5; index += 1) {
    messages.push({
      role: "assistant",
      content: [
        { type: "reasoning", provider: "anthropic-messages", text: `thinking-${index}`, signature: `sig-${index}` },
        { type: "tool_call", id: `call-${index}`, name: "create_wiki_page", input: { content: `BODY-${index}-`.repeat(500) } }
      ]
    });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", toolCallId: `call-${index}`, output: { content: `RESULT-${index}-`.repeat(500) }, isError: false }]
    });
  }
  const result = manager.compact(messages, checkpoint(), 3);
  const checkpointHistory = JSON.stringify(manager.checkpointHistory(messages, 3));
  const serialized = JSON.stringify(result.messages);
  assert.equal(result.messages[0]?.role, "user");
  assert.doesNotMatch(serialized, /BODY-1|RESULT-1|sig-1/);
  assert.match(serialized, /BODY-3|RESULT-3|sig-5/);
  const calls = new Set(result.messages.flatMap((message) => message.content)
    .filter((item) => item.type === "tool_call").map((item) => item.id));
  const results = result.messages.flatMap((message) => message.content)
    .filter((item) => item.type === "tool_result").map((item) => item.toolCallId);
  assert.equal(calls.size, 3);
  assert.equal(results.every((id) => calls.has(id)), true);
  assert.ok(result.compactedTokens > 0);
  assert.match(checkpointHistory, /BODY-1|RESULT-1/);
  assert.doesNotMatch(checkpointHistory, /BODY-3|RESULT-3|BODY-5|RESULT-5/);

  const aggressive = manager.compact(messages, checkpoint(), 1);
  const aggressiveSerialized = JSON.stringify(aggressive.messages);
  assert.equal(aggressive.messages.flatMap((message) => message.content)
    .filter((item) => item.type === "tool_call").length, 1);
  assert.doesNotMatch(aggressiveSerialized, /BODY-4|RESULT-4|sig-4/);
  assert.match(aggressiveSerialized, /BODY-5|RESULT-5|sig-5/);
});

test("checkpoint validation removes forged evidence and deterministic fallback contains only fact references", () => {
  const ledger = new EvidenceLedger();
  ledger.recordRaw("source-1", "a".repeat(64), "s0001");
  const workingSet = emptyWorkingSet();
  const memory = new ContextMemory("ingest", ledger, workingSet, new Set(["source-1"]));
  memory.refreshPhase();
  const manager = new AgentContextManager();
  const value = manager.validateCheckpoint({
    completedActions: ["read_raw_section"],
    keyFindings: [{
      statement: "Fact",
      evidence: [
        { sourceId: "source-1", contentHash: "a".repeat(64), sectionId: "s0001" },
        { sourceId: "source-1", contentHash: "b".repeat(64), sectionId: "forged" }
      ]
    }],
    unresolved: ["Need comparison"],
    nextActions: ["Search Wiki"]
  }, memory.snapshot(), ledger);
  assert.equal(value.phase, "knowledge_comparison");
  assert.equal(value.keyFindings[0]?.evidence.length, 1);
  assert.equal(manager.deterministicCheckpoint(memory.snapshot()).keyFindings.length, 1);
});

test("session tool cache keys immutable reads and evicts least recently used entries", () => {
  const cache = new ToolResultCache(2, 10_000);
  const rawKey = cache.keyFor("read_raw_section", {
    sourceId: "s", contentHash: "a".repeat(64), sectionId: "s0001"
  })!;
  assert.equal(cache.keyFor("read_wiki_page", { path: "wiki/a.md", mode: "full" }), undefined);
  cache.set(rawKey, { output: { content: "A" }, summary: "A" });
  cache.set("second", { output: { content: "B" }, summary: "B" });
  assert.equal(cache.get(rawKey)?.summary, "A");
  cache.set("third", { output: { content: "C" }, summary: "C" });
  assert.equal(cache.get("second"), undefined, "least recently used entry should be evicted");
  assert.equal(cache.hits, 1);
  cache.clear();
  assert.equal(cache.get(rawKey), undefined);
});

test("ingest dynamic tools unlock stage after raw evidence and submit only after current revision validates", async () => {
  const ledger = new EvidenceLedger();
  const workingSet = emptyWorkingSet();
  const context = executionContext(workingSet, ledger);
  const memory = new ContextMemory("ingest", ledger, workingSet, new Set(["source-1"]));
  const allowed = [
    "read_raw_section", "search_wiki", "get_page_template", "create_wiki_page",
    "inspect_changes", "validate_working_set", "submit_changes", "finish_without_changes"
  ];
  assert.equal(selectActiveTools(allowed, "ingest", memory, context).includes("create_wiki_page"), false);
  ledger.recordRaw("source-1", "a".repeat(64), "s0001");
  memory.refreshPhase();
  assert.equal(selectActiveTools(allowed, "ingest", memory, context).includes("create_wiki_page"), true);
  assert.equal(selectActiveTools(allowed, "ingest", memory, context).includes("submit_changes"), false);
  await workingSet.create("wiki/concepts/context-memory.md", makePageTemplate("concept", "Context Memory", "Memory", "Body"));
  await workingSet.validate();
  memory.refreshPhase();
  assert.equal(selectActiveTools(allowed, "ingest", memory, context).includes("submit_changes"), true);
  assert.equal(selectActiveTools(allowed, "ingest", memory, context).includes("finish_without_changes"), false);
});

function checkpoint(): ContextCheckpoint {
  return {
    version: 1,
    phase: "staging",
    completedActions: ["read", "stage"],
    keyFindings: [],
    unresolved: [],
    nextActions: ["validate"]
  };
}

function emptyWorkingSet(): WorkingSet {
  return new WorkingSet({
    currentHashes: async () => new Map(),
    readWikiPage: async () => { throw new Error("not found"); }
  }, 20);
}

function executionContext(workingSet: WorkingSet, evidenceLedger: EvidenceLedger): ToolExecutionContext {
  return {
    signal: new AbortController().signal,
    allowedSourceIds: new Set(["source-1"]),
    allowAllRaw: false,
    allowDiscussion: false,
    workingSet,
    evidenceLedger,
    requireEvidence: true,
    validationCount: 0
  };
}
