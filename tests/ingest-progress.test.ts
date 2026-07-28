import assert from "node:assert/strict";
import test from "node:test";

import { IngestProgressTracker } from "../src/agent/ingest-progress";
import { sourcePipelineSteps } from "../src/ui/pipeline-model";
import type { SourceManifest } from "../src/types";

test("Ingest progress maps Agent tools to phases and updates parallel activities", () => {
  const tracker = new IngestProgressTracker();
  const started = tracker.start(["source-1", "source-2"], 20, 40);
  tracker.accept(started.runId, { type: "iteration", iteration: 2, maxIterations: 20 });
  tracker.accept(started.runId, {
    type: "budget", iterations: 2, toolCalls: 0, elapsedMs: 1_250,
    context: {
      liveContextTokens: 40_000, maxContextTokens: 100_000,
      cumulativeInputTokens: 80_000, cumulativeOutputTokens: 2_000, cachedInputTokens: 10_000,
      cacheHits: 3, checkpointCount: 1, compactedTokens: 20_000,
      breakdown: { system: 1_000, tools: 2_000, messages: 35_000, raw: 10_000, wiki: 8_000, workingSet: 2_000 }
    }
  });
  tracker.accept(started.runId, { type: "tool_started", toolCallId: "a", name: "search_wiki" });
  tracker.accept(started.runId, { type: "tool_started", toolCallId: "b", name: "read_wiki_page" });
  tracker.accept(started.runId, {
    type: "tool_completed", toolCallId: "b", name: "read_wiki_page", isError: false, summary: "read page"
  });
  tracker.accept(started.runId, {
    type: "tool_completed", toolCallId: "a", name: "search_wiki", isError: true, summary: "search failed"
  });

  const snapshot = tracker.getLatest("source-2")!;
  assert.equal(snapshot.phase, "retrieving_wiki");
  assert.equal(snapshot.iteration, 2);
  assert.equal(snapshot.toolCalls, 2);
  assert.equal(snapshot.elapsedMs >= 1_250, true);
  assert.equal(snapshot.context?.liveContextTokens, 40_000);
  assert.equal(snapshot.context?.cacheHits, 3);
  assert.deepEqual(snapshot.activities.map((item) => [item.toolCallId, item.status]), [
    ["a", "failed"], ["b", "completed"]
  ]);
});

test("Ingest progress ignores model text, caps history, and redacts summaries", () => {
  const tracker = new IngestProgressTracker();
  const started = tracker.start(["source-1"], 20, 80);
  tracker.accept(started.runId, { type: "text", text: "private model narration" });
  for (let index = 0; index < 55; index += 1) {
    const id = `call-${index}`;
    tracker.accept(started.runId, { type: "tool_started", toolCallId: id, name: "read_raw_section" });
    tracker.accept(started.runId, {
      type: "tool_completed",
      toolCallId: id,
      name: "read_raw_section",
      isError: false,
      summary: index === 54
        ? "Authorization: Bearer secret https://example.com/file?token=bad"
        : `section ${index}`
    });
  }
  const snapshot = tracker.getLatest("source-1")!;
  assert.equal(snapshot.toolCalls, 55);
  assert.equal(snapshot.activities.length, 50);
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /private model narration|Bearer secret|token=bad/);
  assert.match(serialized, /REDACTED/);
});

test("Ingest progress bus restores batch snapshots and terminal state", () => {
  const tracker = new IngestProgressTracker();
  const received: string[] = [];
  const unsubscribe = tracker.subscribe((snapshot) => received.push(snapshot.state));
  const started = tracker.start(["source-1", "source-2"], 28, 64);
  tracker.accept(started.runId, { type: "plan_ready", operationId: "op", changedPaths: ["wiki/a.md"] });
  assert.equal(tracker.getLatest("source-1")?.state, "awaiting_review");
  assert.equal(tracker.getLatest("source-2")?.state, "awaiting_review");
  tracker.markCompleted(started.runId, ["source-1"]);
  tracker.clear(["source-2"]);
  assert.equal(tracker.getLatest("source-1")?.state, "completed");
  assert.equal(tracker.getLatest("source-2"), undefined);
  assert.deepEqual(received, ["running", "awaiting_review", "completed"]);
  unsubscribe();
});

test("pipeline maps parse, ingest, review, failure, and completion states", () => {
  const source = manifest();
  assert.deepEqual(sourcePipelineSteps(source).map((item) => item.state), [
    "completed", "completed", "pending", "pending", "pending"
  ]);
  source.ingest.status = "awaiting_review";
  assert.deepEqual(sourcePipelineSteps(source).map((item) => item.state), [
    "completed", "completed", "completed", "active", "pending"
  ]);
  source.ingest.status = "ingested";
  assert.deepEqual(sourcePipelineSteps(source).map((item) => item.state), [
    "completed", "completed", "completed", "completed", "completed"
  ]);
  source.parse.status = "needs_ocr";
  source.ingest.status = "not_started";
  assert.equal(sourcePipelineSteps(source)[1]?.state, "failed");
  source.parse.status = "parsed";
  source.ingest.status = "ingest_failed";
  assert.equal(sourcePipelineSteps(source)[2]?.state, "failed");
});

function manifest(): SourceManifest {
  return {
    schemaVersion: 3,
    manifestRevision: 1,
    sourceId: "source-1",
    sourceHash: "a".repeat(64),
    source: { kind: "markdown", acquiredBy: "test" },
    original: {
      name: "source.md", extension: ".md", mime: "text/markdown", size: 1,
      objectPath: ".llm-wiki/objects/source.md", importedAt: new Date().toISOString()
    },
    parse: { status: "parsed", currentRevision: 1, revisions: [], attempts: [] },
    ingest: { status: "not_started", attempts: [] }
  };
}
