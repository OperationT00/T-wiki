import assert from "node:assert/strict";
import test from "node:test";

import {
  estimateTokens,
  inputTokenBudget,
  splitMarkdownByTokenBudget,
  splitTextByTokenBudget,
  truncateToTokenBudget
} from "../src/core/context-budget";

test("token estimate is conservative for Chinese and compact for ASCII", () => {
  assert.equal(estimateTokens("中文测试"), 4);
  assert.equal(estimateTokens("abcdefgh"), 2);
});

test("input budget reserves completion and safety margin", () => {
  assert.equal(inputTokenBudget(1_048_565), 813_252);
  assert.equal(inputTokenBudget(10_000), 8_000);
});

test("large text is split without loss or oversized chunks", () => {
  const source = `${"中".repeat(20)}\n\n${"a".repeat(80)}\n\n${"文".repeat(20)}`;
  const chunks = splitTextByTokenBudget(source, 20);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((chunk) => estimateTokens(chunk) <= 20));
  assert.equal(chunks.join("").replaceAll("\n", ""), source.replaceAll("\n", ""));
});

test("truncate respects token budget", () => {
  const result = truncateToTokenBudget("中文abcdefgh", 4);
  assert.equal(estimateTokens(result), 4);
  assert.ok("中文abcdefgh".startsWith(result));
});

test("markdown splitting prefers headings and page markers", () => {
  const source = `<!-- llm-wiki:page=1 -->

# 第一节

${"中".repeat(18)}

<!-- llm-wiki:page=2 -->

# 第二节

${"文".repeat(18)}`;
  const chunks = splitMarkdownByTokenBudget(source, 28);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((chunk) => estimateTokens(chunk) <= 28));
  assert.match(chunks[0]!, /page=1/);
  assert.ok(chunks.some((chunk) => /page=2/.test(chunk)));
});
