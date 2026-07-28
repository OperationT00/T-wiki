import assert from "node:assert/strict";
import test from "node:test";

import { EvidenceLedger } from "../src/agent/evidence-ledger";
import {
  applyCoverageSelection,
  hasUserExclusions,
  IngestCoverageValidationError,
  reconcileIngestCoverage,
  validateIngestCoverage
} from "../src/agent/ingest-coverage";
import type { ToolExecutionContext } from "../src/agent/tools";
import { WorkingSet } from "../src/agent/working-set";
import { makePageTemplate } from "../src/core/wiki-core";
import type { IngestCoverageReport } from "../src/types";

const sourceId = "source-1";
const contentHash = "b".repeat(64);
const rawEvidence = { sourceId, contentHash, sectionId: "s0001" };

test("coverage validates created knowledge against WorkingSet and EvidenceLedger", async () => {
  const context = await contextWithPages();
  const report = validCoverage();
  assert.deepEqual(validateIngestCoverage(report, context), report);
});

test("ingest cannot terminate without a coverage report", async () => {
  const context = await contextWithPages();
  assert.throws(() => validateIngestCoverage(undefined, context), /必须提交知识覆盖报告/);
});

test("coverage rejects forged evidence, missing category, action mismatch and model user_rejected", async () => {
  const forged = validCoverage();
  forged.sources[0]!.reviewedSectionIds = ["s9999"];
  assert.throws(() => validateIngestCoverage(forged, awaitableNever()), /未读取/);

  const context = await contextWithPages();
  const missing = validCoverage();
  missing.categoryAssessments.pop();
  assert.throws(() => validateIngestCoverage(missing, context), /缺少分类评估/);

  const mismatch = validCoverage();
  mismatch.decisions[0]!.decision = "updated";
  assert.throws(() => validateIngestCoverage(mismatch, context), /WorkingSet 操作不一致/);

  const rejected = validCoverage();
  rejected.decisions[0]!.decision = "user_rejected";
  assert.throws(() => validateIngestCoverage(rejected, context), /模型不得提交决策/);
});

test("partial review turns deselected knowledge changes into user_rejected", () => {
  const report = validCoverage();
  const selected = new Set(["wiki/sources/source.md"]);
  const next = applyCoverageSelection(report, selected)!;
  assert.equal(next.decisions[0]?.decision, "user_rejected");
  assert.equal(hasUserExclusions(next), true);
  assert.equal(report.decisions[0]?.decision, "created", "original report must remain immutable");
});

test("coverage accepts already-covered and source-only decisions without file churn", async () => {
  const context = await contextWithPages(false);
  context.evidenceLedger.recordWiki("wiki/concepts/syn-flood.md", "d".repeat(64));
  const covered = validCoverage();
  covered.decisions[0] = {
    ...covered.decisions[0]!,
    decision: "already_covered",
    evidence: [rawEvidence, { wikiPath: "wiki/concepts/syn-flood.md", wikiHash: "d".repeat(64) }]
  };
  assert.doesNotThrow(() => validateIngestCoverage(covered, context));

  const sourceOnly = validCoverage();
  sourceOnly.decisions[0] = {
    ...sourceOnly.decisions[0]!, decision: "source_only", targetPath: undefined,
    reason: "Too source-specific for a durable concept."
  };
  assert.doesNotThrow(() => validateIngestCoverage(sourceOnly, context));
});

test("host reconciles omitted staged create/update decisions from WorkingSet evidence", async () => {
  const context = await contextWithPages();
  const incomplete = validCoverage();
  incomplete.decisions = [];
  incomplete.categoryAssessments[1] = {
    sourceId, type: "concept", outcome: "none", reason: "Model accidentally omitted the staged page."
  };
  const reconciled = reconcileIngestCoverage(incomplete, context) as IngestCoverageReport;
  const derived = reconciled.decisions.find((item) => item.targetPath === "wiki/concepts/syn-flood.md");
  assert.equal(derived?.decision, "created");
  assert.equal(derived?.sourceId, sourceId);
  assert.deepEqual(derived?.evidence, [rawEvidence]);
  assert.equal(reconciled.categoryAssessments.find((item) => item.type === "concept")?.outcome, "candidates_found");
  assert.doesNotThrow(() => validateIngestCoverage(reconciled, context));
});

test("host removes Source-page candidates and normalizes knowledge type from target directory", async () => {
  const context = await contextWithPages();
  const report = validCoverage();
  report.decisions.push({
    candidateId: "source-xiaolin-net",
    sourceId,
    type: "entity",
    title: "Source",
    decision: "created",
    targetPath: "wiki/sources/source.md",
    reason: "Model incorrectly treated the mandatory Source page as knowledge.",
    evidence: [rawEvidence]
  });
  report.decisions[0] = { ...report.decisions[0]!, type: "entity" };
  const reconciled = reconcileIngestCoverage(report, context) as IngestCoverageReport;
  assert.equal(reconciled.decisions.some((item) => item.candidateId === "source-xiaolin-net"), false);
  assert.equal(reconciled.decisions[0]?.type, "concept");
  assert.equal(reconciled.categoryAssessments.find((item) => item.type === "entity")?.outcome, "none");
  assert.equal(reconciled.categoryAssessments.find((item) => item.type === "concept")?.outcome, "candidates_found");
  assert.doesNotThrow(() => validateIngestCoverage(reconciled, context));
});

test("coverage omission error reports every missing staged knowledge path", async () => {
  const context = await contextWithPages();
  await context.workingSet.create(
    "wiki/entities/test-router.md",
    makePageTemplate("entity", "Test Router", "Router", "Body"),
    [rawEvidence]
  );
  const report = validCoverage();
  report.decisions = [];
  report.categoryAssessments = report.categoryAssessments.map((item) => ({ ...item, outcome: "none" }));
  assert.throws(() => validateIngestCoverage(report, context), (error: unknown) => {
    assert.equal(error instanceof IngestCoverageValidationError, true);
    const paths = (error as IngestCoverageValidationError).details.missingPaths as string[];
    assert.deepEqual(paths.sort(), ["wiki/concepts/syn-flood.md", "wiki/entities/test-router.md"]);
    return true;
  });
});

async function contextWithPages(includeConcept = true): Promise<ToolExecutionContext> {
  const ledger = new EvidenceLedger();
  ledger.recordRaw(sourceId, contentHash, "s0001");
  const workingSet = new WorkingSet({
    currentHashes: async () => new Map(),
    readWikiPage: async () => { throw new Error("not found"); }
  }, 5);
  await workingSet.create(
    "wiki/sources/source.md",
    makePageTemplate("source", "Source", "Source", "Body")
      .replace('raw_path: ""', "raw_path: raw/articles/source.md")
      .replace('raw_hash: ""', `raw_hash: ${"a".repeat(64)}`),
    [rawEvidence]
  );
  if (includeConcept) {
    await workingSet.create(
      "wiki/concepts/syn-flood.md",
      makePageTemplate("concept", "SYN Flood", "TCP attack", "Body"),
      [rawEvidence]
    );
  }
  return {
    signal: new AbortController().signal,
    allowedSourceIds: new Set([sourceId]),
    allowAllRaw: false,
    allowDiscussion: false,
    workingSet,
    evidenceLedger: ledger,
    requireEvidence: true,
    validationCount: 0
  };
}

function validCoverage(): IngestCoverageReport {
  return {
    sources: [{ sourceId, contentHash, reviewedSectionIds: ["s0001"] }],
    categoryAssessments: [
      { sourceId, type: "entity", outcome: "none", reason: "No durable entity." },
      { sourceId, type: "concept", outcome: "candidates_found", reason: "Found SYN Flood." },
      { sourceId, type: "synthesis", outcome: "none", reason: "No synthesis change." }
    ],
    decisions: [{
      candidateId: "c001",
      sourceId,
      type: "concept",
      title: "SYN Flood",
      decision: "created",
      targetPath: "wiki/concepts/syn-flood.md",
      reason: "Reusable network security concept.",
      evidence: [rawEvidence]
    }]
  };
}

function awaitableNever(): ToolExecutionContext {
  // Only the forged reviewed section is evaluated before WorkingSet contents.
  const ledger = new EvidenceLedger();
  ledger.recordRaw(sourceId, contentHash, "s0001");
  return {
    signal: new AbortController().signal,
    allowedSourceIds: new Set([sourceId]),
    allowAllRaw: false,
    allowDiscussion: false,
    workingSet: new WorkingSet({
      currentHashes: async () => new Map(),
      readWikiPage: async () => { throw new Error("not found"); }
    }, 5),
    evidenceLedger: ledger,
    requireEvidence: true,
    validationCount: 0
  };
}
