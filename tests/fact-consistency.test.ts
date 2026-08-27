import assert from "node:assert/strict";
import test from "node:test";

import {
  extractNumericFacts,
  validateClaimNumericConsistency,
  validateDraftNumericConsistency
} from "../src/agent/fact-consistency";
import type { EvidenceClaim } from "../src/types";

const evidence = (claim: string, quote: string): EvidenceClaim => ({
  claim,
  supportingQuote: quote,
  relation: "supports",
  evidence: { sourceId: "source", contentHash: "a".repeat(64), sectionId: "s0001" },
  quoteHash: "b".repeat(64)
});

test("numeric fact guard rejects a changed percentage in a claim and Wiki draft", () => {
  const claimResult = validateClaimNumericConsistency("该方法成功率为 80%", "该方法成功率为 90%", "supports");
  assert.match(claimResult.errors.join("\n"), /80%.*90%/);

  const draftResult = validateDraftNumericConsistency(
    "该方法的成功率为 80%。",
    [evidence("该方法成功率为 90%", "实验显示，该方法成功率为 90%。")]
  );
  assert.match(draftResult.errors.join("\n"), /NUMERIC_FACT_MISMATCH/);
});

test("numeric fact guard accepts exact values and deterministic unit conversion", () => {
  const claims = [evidence("连接超时为 90 秒", "连接超时为 90 秒。")];
  assert.deepEqual(validateDraftNumericConsistency("连接超时为 90 秒。", claims).errors, []);
  assert.deepEqual(validateDraftNumericConsistency("连接超时为 1.5 分钟。", claims).errors, []);
});

test("numeric fact guard does not cross-match numbers belonging to different subjects", () => {
  const claims = [evidence(
    "成功率为 90%，覆盖率为 80%",
    "测试结果显示成功率为 90%，覆盖率为 80%。"
  )];
  assert.match(
    validateDraftNumericConsistency("成功率为 80%，覆盖率为 80%。", claims).errors.join("\n"),
    /80%.*90%/
  );
});

test("numeric fact guard preserves qualifiers and ignores structural metadata", () => {
  const claims = [evidence("成功率至少为 90%", "成功率至少为 90%。")];
  assert.match(validateDraftNumericConsistency("成功率为 90%。", claims).errors.join("\n"), /NUMERIC_FACT_MISMATCH/);
  assert.equal(extractNumericFacts("---\nschema_version: 1\nupdated: 2026-08-12\n---\n\n# 概览").length, 0);
});

test("contradicting claims may intentionally use a different source number", () => {
  assert.deepEqual(
    validateClaimNumericConsistency("另一报告给出 80%", "原报告给出 90%", "contradicts").errors,
    []
  );
});
