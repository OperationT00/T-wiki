import assert from "node:assert/strict";
import test from "node:test";

import {
  buildIngestSearchQuery,
  canonicalizePage,
  DEFAULT_CONFIG,
  extractJsonObject,
  extractWikiLinks,
  generateIndex,
  isWritableWikiPath,
  lintWiki,
  makePageTemplate,
  parseMarkdown,
  retrieve,
  sanitizePlanDanglingLinks,
  sha256,
  strongIngestMatches,
  validateChangePlan
} from "../src/core/wiki-core";

test("canonicalizePage migrates legacy frontmatter without changing body", () => {
  const legacy = `---
type: concept
tags:
  - tcp
created: 2026-07-23
updated: 2026-07-23
---

# TCP 握手

正文内容。

## 关联条目
- [[wiki/concepts/http-protocol]]
`;
  const result = canonicalizePage("wiki/concepts/tcp-handshake.md", legacy);
  assert.equal(result.changed, true);
  const page = parseMarkdown("wiki/concepts/tcp-handshake.md", result.content);
  assert.ok(page);
  assert.equal(page.title, "TCP 握手");
  assert.equal(page.frontmatter.schema_version, 1);
  assert.equal(page.status, "draft");
  assert.match(page.body, /正文内容/);
});

test("extractWikiLinks normalizes aliases, headings and extensions", () => {
  assert.deepEqual(
    extractWikiLinks("[[wiki/a|A]] [[wiki/b#标题]] [[wiki/c.md]]"),
    ["wiki/a", "wiki/b", "wiki/c"]
  );
});

test("extractJsonObject repairs invalid model escape sequences locally", () => {
  const parsed = extractJsonObject(
    "{\"version\":1,\"content\":\"后到请求应重新读取已有记录，此时它\\[后到请求]不再执行业务\"}"
  ) as { content: string };
  assert.equal(parsed.content, "后到请求应重新读取已有记录，此时它[后到请求]不再执行业务");
});

test("canonicalizePage repairs legacy YAML list spacing", () => {
  const legacy = `---
type: concept
tags:
  - tcp
  -挥手
created: 2026-07-23
updated: 2026-07-23
---

# TCP 四次挥手

正文。
`;
  const result = canonicalizePage("wiki/concepts/tcp-four-way-wave.md", legacy);
  assert.match(result.warnings.join(""), /已修复/);
  const page = parseMarkdown("wiki/concepts/tcp-four-way-wave.md", result.content);
  assert.deepEqual(page?.tags, ["tcp", "挥手"]);
});

test("page parser repairs unescaped quotes inside quoted YAML scalars", () => {
  const content = `---
schema_version: 1
type: source
title: API 幂等性键
tldr: "服务端使用"用户 ID + 幂等性键"作为唯一标识"
status: draft
created: 2026-07-24
updated: 2026-07-24
tags: []
related: []
source_type: article
author: 未知
url: ""
raw_path: raw/articles/test.md
raw_hash: abc
---

# API 幂等性键

正文

## 关联条目
`;
  const page = parseMarkdown("wiki/sources/api-idempotency-key.md", content);
  assert.ok(page);
  assert.equal(page.tldr, "服务端使用\"用户 ID + 幂等性键\"作为唯一标识");
});

test("raw guard accepts only wiki markdown paths", () => {
  assert.equal(isWritableWikiPath("wiki/concepts/a.md"), true);
  assert.equal(isWritableWikiPath("raw/articles/a.md"), false);
  assert.equal(isWritableWikiPath(".obsidian/plugins/a.md"), false);
  assert.equal(isWritableWikiPath("wiki/../raw/a.md"), false);
  assert.equal(isWritableWikiPath("llm-wiki.config.json"), false);
});

test("validateChangePlan rejects raw writes and stale hashes", () => {
  const content = makePageTemplate("concept", "A", "摘要", "正文");
  assert.throws(() => validateChangePlan({
    version: 1,
    operationId: "one",
    summary: "bad",
    operations: [{ action: "create", path: "raw/a.md", content, reason: "" }]
  }), /禁止写入/);

  assert.throws(() => validateChangePlan({
    version: 1,
    operationId: "two",
    summary: "stale",
    operations: [{
      action: "update",
      path: "wiki/concepts/a.md",
      expectedHash: "old",
      content,
      reason: ""
    }]
  }, new Map([["wiki/concepts/a.md", "new"]])), /文件已变化/);
});

test("validateChangePlan rejects dangling links but accepts links created in the same plan", () => {
  const linked = makePageTemplate("concept", "A", "摘要", "正文\n\n## 关联条目\n- [[wiki/concepts/b]]");
  assert.throws(() => validateChangePlan({
    version: 1,
    operationId: "dangling",
    summary: "bad link",
    operations: [{ action: "create", path: "wiki/concepts/a.md", content: linked, reason: "" }]
  }), /悬空链接/);

  const other = makePageTemplate("concept", "B", "摘要", "正文\n\n## 关联条目\n- [[wiki/concepts/a]]");
  const plan = validateChangePlan({
    version: 1,
    operationId: "paired",
    summary: "paired pages",
    operations: [
      { action: "create", path: "wiki/concepts/a.md", content: linked, reason: "" },
      { action: "create", path: "wiki/concepts/b.md", content: other, reason: "" }
    ]
  });
  assert.equal(plan.operations.length, 2);
});

test("prepare-stage sanitizer removes dangling links without weakening final validation", () => {
  const content = makePageTemplate(
    "concept",
    "幂等性键",
    "避免重复执行",
    "正文引用 [[wiki/synthesis/java-backend-interview|不存在的综合页]]。\n\n## 关联条目\n- [[wiki/concepts/existing]]"
  );
  const input = {
    version: 1,
    operationId: "sanitize",
    summary: "sanitize",
    operations: [{
      action: "create",
      path: "wiki/concepts/idempotency-key.md",
      content,
      reason: "生成概念页"
    }]
  };
  const hashes = new Map([["wiki/concepts/existing.md", "hash"]]);
  const sanitized = sanitizePlanDanglingLinks(input, hashes);
  const plan = validateChangePlan(sanitized, hashes);
  assert.doesNotMatch(plan.operations[0]!.content, /\[\[wiki\/synthesis\/java-backend-interview/);
  assert.match(plan.operations[0]!.content, /不存在的综合页/);
  assert.match(plan.operations[0]!.reason, /Core 已移除悬空链接/);
  assert.match(plan.operations[0]!.content, /\[\[wiki\/concepts\/existing\]\]/);
});

test("index and lint are deterministic", () => {
  const a = parseMarkdown("wiki/concepts/a.md", makePageTemplate("concept", "A", "Alpha", "正文\n\n## 关联条目\n- [[wiki/concepts/b]]"));
  const b = parseMarkdown("wiki/concepts/b.md", makePageTemplate("concept", "B", "Beta", "正文\n\n## 关联条目\n- [[wiki/concepts/a]]"));
  assert.ok(a && b);
  const index = generateIndex([b, a], DEFAULT_CONFIG);
  assert.match(index, /\[\[wiki\/concepts\/a\]\] — Alpha/);
  const report = lintWiki(
    [a, b],
    DEFAULT_CONFIG,
    ["wiki/concepts/a.md", "wiki/concepts/b.md", "index.md"]
  );
  assert.equal(report.issues.filter((issue) => issue.code === "dangling-link").length, 0);
});

test("lint reports cross-type identity duplicates without changing pages", () => {
  const concept = parseMarkdown(
    "wiki/concepts/http-protocol.md",
    makePageTemplate("concept", "HTTP 协议", "应用层协议", "正文")
  )!;
  const entity = parseMarkdown(
    "wiki/entities/http-protocol.md",
    makePageTemplate("entity", "HTTP协议", "重复实体", "正文")
  )!;
  const before = [concept.content, entity.content];
  const report = lintWiki(
    [concept, entity], DEFAULT_CONFIG,
    [concept.path, entity.path, "index.md"]
  );
  const conflicts = report.issues.filter((issue) => issue.code === "CROSS_TYPE_DUPLICATE");
  assert.equal(conflicts.length, 2);
  assert.ok(conflicts.every((issue) => issue.severity === "warning"));
  assert.deepEqual([concept.content, entity.content], before);
});

test("retrieval ranks title and expands one-hop links", () => {
  const tcp = parseMarkdown(
    "wiki/concepts/tcp-handshake.md",
    makePageTemplate("concept", "TCP 三次握手", "TCP 建连", "连接过程\n\n## 关联条目\n- [[wiki/concepts/http]]")
  );
  const http = parseMarkdown(
    "wiki/concepts/http.md",
    makePageTemplate("concept", "HTTP", "应用层协议", "正文\n\n## 关联条目\n- [[wiki/concepts/tcp-handshake]]")
  );
  assert.ok(tcp && http);
  const results = retrieve("TCP 握手", [http, tcp], 1, 2);
  assert.equal(results[0]?.page.path, "wiki/concepts/tcp-handshake.md");
  assert.equal(results.length, 2);
});

test("ingest retrieval seed avoids broad body text and keeps only strong title matches", () => {
  const seed = buildIngestSearchQuery(`# API 幂等性键：避免重复创建订单

客户端可能因为网络超时而重复发送请求。

状态包括 \`processing\` 和 \`completed\`。`);
  assert.equal(seed, "API 幂等性键：避免重复创建订单 processing completed");

  const idempotency = parseMarkdown(
    "wiki/concepts/idempotency-key.md",
    makePageTemplate("concept", "幂等性键", "避免重复执行", "正文")
  )!;
  const network = parseMarkdown(
    "wiki/concepts/network-timeout.md",
    makePageTemplate("concept", "网络超时", "客户端可能重复发送请求", "正文")
  )!;
  const matches = strongIngestMatches(retrieve(seed, [network, idempotency], 8, 12));
  assert.deepEqual(matches.map((item) => item.page.path), ["wiki/concepts/idempotency-key.md"]);
});

test("sha256 is stable for unicode", () => {
  assert.equal(sha256("中文"), sha256(new TextEncoder().encode("中文")));
});
