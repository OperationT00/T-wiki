import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentRunTrace } from "../src/agent/agent-loop";
import {
  agentTraceSample,
  aggregate,
  evaluateAcceptance,
  mediaAcceptanceSample,
  parseAcceptanceSample,
  type AcceptanceSample,
  type AcceptanceSampleSet,
  type AcceptanceSuite
} from "../src/evaluation/acceptance";

const suite: AcceptanceSuite = {
  schemaVersion: 1,
  suiteId: "test-suite",
  title: "Test",
  scenarios: [{
    id: "query-direct",
    category: "query",
    title: "Direct",
    description: "test",
    minimumSamples: 5,
    thresholds: [
      { metric: "durationMs", label: "Latency", unit: "ms", aggregation: "p95", operator: "lte", target: 100 },
      { metric: "citationAccuracy", label: "Citations", unit: "ratio", aggregation: "mean", operator: "gte", target: 0.98 }
    ]
  }]
};

test("acceptance evaluator computes reproducible percentiles and passes complete samples", () => {
  const report = evaluateAcceptance(suite, sampleSet([50, 60, 70, 80, 90]), "2026-09-06T00:00:00.000Z");
  assert.equal(report.passed, true);
  assert.equal(report.scenarios[0]?.metrics[0]?.value, 88);
  assert.deepEqual(report.summary, { scenarioCount: 1, passedScenarios: 1, failedScenarios: 0, sampleCount: 5 });
  assert.equal(aggregate([1, 2, 3, 4, 5], "p50"), 3);
});

test("acceptance evaluator fails closed when samples or metrics are missing", () => {
  const tooFew = evaluateAcceptance(suite, sampleSet([50, 60, 70, 80]));
  assert.equal(tooFew.passed, false);
  assert.match(tooFew.scenarios[0]?.metrics[0]?.reason ?? "", /样本不足/);

  const missingMetric = sampleSet([50, 60, 70, 80, 90]);
  delete missingMetric.samples[0]?.metrics.citationAccuracy;
  const missing = evaluateAcceptance(suite, missingMetric);
  assert.equal(missing.passed, false);
  assert.match(missing.scenarios[0]?.metrics[1]?.reason ?? "", /缺少有效指标/);
});

test("acceptance evaluator rejects duplicate run identities", () => {
  const input = sampleSet([50, 60, 70, 80, 90]);
  input.samples[1]!.runId = input.samples[0]!.runId;
  assert.throws(() => evaluateAcceptance(suite, input), /验收样本重复/);
});

test("agent trace adapter derives ingest quality and duplicate-read metrics", () => {
  const trace = baseTrace("ingest");
  trace.candidateCompletion = { total: 4, completed: 3 };
  trace.readStats = { rawUnique: 2, rawDuplicate: 0, wikiUnique: 3, wikiDuplicate: 1 };
  trace.ingestCoverage = {
    sources: [],
    categoryAssessments: [],
    decisions: [{
      candidateId: "c1", sourceId: "s1", type: "concept", title: "TCP", decision: "created",
      targetPath: "wiki/concepts/tcp.md", reason: "new", evidence: [{
        sourceId: "s1", contentHash: "a".repeat(64), sectionId: "s0001"
      }]
    }]
  };
  const sample = agentTraceSample("ingest-standard", trace, {
    ingest: { expectedKnowledgeUnits: 5, matchedKnowledgeUnits: 4, generatedKnowledgePages: 4, duplicateKnowledgePages: 1 }
  });
  assert.equal(sample.metrics.candidateCompletionRate, 0.75);
  assert.equal(sample.metrics.duplicateWikiReadRate, 0.25);
  assert.equal(sample.metrics.candidateRecall, 0.8);
  assert.equal(sample.metrics.duplicatePageRate, 0.25);
  assert.equal(sample.metrics.evidencePassRate, 1);
});

test("agent trace adapter requires grounded query assessment and detects two-hop traversal", () => {
  const trace = baseTrace("query");
  trace.query = {
    indexRevision: "rev", indexReads: ["root"],
    wikiReads: [{ path: "wiki/concepts/tcp.md", hash: "a".repeat(64), mode: "section", sectionId: "s1" }],
    graphTraversals: [{ from: "wiki/sources/book", to: "wiki/concepts/tcp", hop: 2, direction: "outgoing" }],
    rawReads: 0, citationStatus: "verified", citationErrors: []
  };
  assert.throws(() => agentTraceSample("query-two-hop", trace), /必须提供人工/);
  const sample = agentTraceSample("query-two-hop", trace, {
    query: {
      expectedRelevantPages: 2, relevantPagesRead: 2, citedClaims: 3, verifiedCitedClaims: 3,
      factualClaims: 5, unsupportedClaims: 0, requiredGraphHops: 2
    }
  });
  assert.equal(sample.metrics.relevantPageRecall, 1);
  assert.equal(sample.metrics.citationAccuracy, 1);
  assert.equal(sample.metrics.multiHopSuccess, 1);
});

test("checked-in acceptance suite is valid and incomplete data cannot pass", async () => {
  const realSuite = JSON.parse(await readFile("acceptance/suite-v1.json", "utf8")) as AcceptanceSuite;
  const report = evaluateAcceptance(realSuite, { schemaVersion: 1, suiteId: realSuite.suiteId, samples: [] });
  assert.equal(realSuite.scenarios.length, 8);
  assert.equal(report.passed, false);
  assert.equal(report.summary.failedScenarios, 8);
});

test("parse and media sample helpers only emit metadata metrics", () => {
  const parse = parseAcceptanceSample("parse-mixed-batch", {
    runId: "parse-001", recordedAt: "2026-09-06T00:00:00.000Z",
    throughputPerMinute: 8, queueWaitMs: 2000, peakMemoryMiB: 256
  });
  const media = mediaAcceptanceSample("media-overlap-merge", {
    runId: "media-001", recordedAt: "2026-09-06T00:00:00.000Z",
    overlapResolutionRate: 1, contentConservationRate: 0.99
  }, "manual-review");
  assert.deepEqual(Object.keys(parse.metrics).sort(), ["peakMemoryMiB", "queueWaitMs", "throughputPerMinute"]);
  assert.equal(media.origin, "manual-review");
  assert.equal(Object.values(media.metrics).every((value) => typeof value === "number"), true);
  assert.equal(Object.prototype.hasOwnProperty.call(media, "notes"), false);
});

test("acceptance evaluator rejects impossible ratio samples", () => {
  const input = sampleSet([50, 60, 70, 80, 90]);
  input.samples[0]!.metrics.citationAccuracy = 1.2;
  assert.throws(() => evaluateAcceptance(suite, input), /比例指标超出/);
});

test("acceptance CLI starts on Windows-compatible CommonJS execution", async () => {
  const result = await runAcceptanceCli();
  assert.equal(result.code, 2);
  assert.match(result.stderr, /缺少 --input/);
  assert.doesNotMatch(result.stderr, /Top-level await/);
});

test("acceptance CLI reads samples and writes a passing metadata report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "t-wiki-acceptance-"));
  const suitePath = join(directory, "suite.json");
  const inputPath = join(directory, "samples.json");
  const outputPath = join(directory, "report.json");
  try {
    await writeFile(suitePath, JSON.stringify(suite), "utf8");
    await writeFile(inputPath, JSON.stringify(sampleSet([50, 60, 70, 80, 90])), "utf8");
    const result = await runAcceptanceCli(["--suite", suitePath, "--input", inputPath, "--output", outputPath]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /acceptance test-suite: PASS/);
    const report = JSON.parse(await readFile(outputPath, "utf8")) as { passed?: boolean; scenarios?: unknown[] };
    assert.equal(report.passed, true);
    assert.equal(report.scenarios?.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function sampleSet(durations: number[]): AcceptanceSampleSet {
  return {
    schemaVersion: 1,
    suiteId: suite.suiteId,
    samples: durations.map((durationMs, index): AcceptanceSample => ({
      schemaVersion: 1,
      scenarioId: "query-direct",
      runId: `run-${index}`,
      recordedAt: `2026-09-06T00:00:0${index}.000Z`,
      origin: "measured",
      metrics: { durationMs, citationAccuracy: 1 }
    }))
  };
}

function baseTrace(purpose: AgentRunTrace["purpose"]): AgentRunTrace {
  return {
    sessionId: "trace-run-01",
    purpose,
    startedAt: "2026-09-06T00:00:00.000Z",
    completedAt: "2026-09-06T00:00:01.000Z",
    iterations: 2,
    requestIds: [],
    toolCalls: [],
    inputTokens: 100,
    outputTokens: 20,
    status: "completed",
    providerRequests: [
      { phase: "one", modelRole: "default", model: "test", latencyMs: 100 },
      { phase: "two", modelRole: "default", model: "test", latencyMs: 100 }
    ]
  };
}

function runAcceptanceCli(args: string[] = []): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/run-acceptance.ts", ...args], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolveResult({ code, stdout, stderr }));
  });
}
