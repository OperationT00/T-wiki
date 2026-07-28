import assert from "node:assert/strict";
import test from "node:test";

import {
  enrichWikiContent,
  validateIngestLinkGraph,
  WikiLinkEnricher,
  WikiLinkPlanner
} from "../src/agent/wiki-link-graph";
import { WorkingSet } from "../src/agent/working-set";
import {
  makePageTemplate,
  parseMarkdown,
  sanitizePlanDanglingLinks,
  sha256,
  validateChangePlan
} from "../src/core/wiki-core";
import type { WikiPage } from "../src/types";

test("Wiki pages expose frontmatter related and body WikiLinks as one effective graph", () => {
  const content = makePageTemplate("concept", "A", "A", "# A\n\n正文链接 [[wiki/concepts/body-link]].")
    .replace("related: []", "related:\n  - wiki/concepts/frontmatter-link\n  - '[[wiki/concepts/frontmatter-link.md]]'");
  const page = parseMarkdown("wiki/concepts/a.md", content)!;

  assert.deepEqual(page.links.sort(), [
    "wiki/concepts/body-link",
    "wiki/concepts/frontmatter-link"
  ]);
});

test("WikiLinkPlanner validates endpoints, confidence, duplicates, and outgoing limits", () => {
  const candidates = ["a", "b", "c", "d", "e", "f", "g"].map((id) => ({
    candidateId: id,
    sourceId: "source",
    title: id.toUpperCase(),
    type: "concept" as const,
    decision: "created" as const,
    targetPath: `wiki/concepts/${id}.md`
  }));
  const proposals = candidates.slice(1).map((target, index) => ({
    fromCandidateId: "a",
    toCandidateId: target.candidateId,
    type: "related" as const,
    reason: "same topic",
    confidence: 0.99 - index * 0.01
  }));
  proposals.push({
    fromCandidateId: "a", toCandidateId: "a", type: "related", reason: "self", confidence: 0.99
  });
  proposals.push({
    fromCandidateId: "a", toCandidateId: "b", type: "related", reason: "low", confidence: 0.2
  });

  const plan = new WikiLinkPlanner().build(proposals, candidates, []);
  assert.equal(plan.edges.length, 5);
  assert.equal(plan.dropped.self_link, 1);
  assert.equal(plan.dropped.low_confidence, 1);
  assert.equal(plan.dropped.outgoing_limit, 1);
});

test("WikiLinkEnricher writes an idempotent managed section and graph validation follows Source links", async () => {
  const host = memoryHost([]);
  const workingSet = new WorkingSet(host, 10);
  const concept = makePageTemplate("concept", "A", "A", "# A\n\n用户正文保留。");
  const source = makePageTemplate("source", "Source", "Source", "# Source\n\n来源摘要。");
  await workingSet.create("wiki/concepts/a.md", concept);
  await workingSet.create("wiki/sources/source.md", enrichWikiContent(
    "wiki/sources/source.md", source, ["wiki/concepts/a"]
  ));

  const plan = {
    proposedCount: 1,
    edges: [{
      fromPath: "wiki/concepts/a", toPath: "wiki/concepts/existing", type: "related" as const,
      reason: "same topic", confidence: 0.9
    }],
    dropped: {},
    unlinkedPaths: []
  };
  const existing = page("wiki/concepts/existing.md", makePageTemplate("concept", "Existing", "Existing", "# Existing"));
  const enricher = new WikiLinkEnricher();
  await enricher.apply(plan, workingSet, workingSet.list().map((item) => item.path));
  const once = workingSet.list().find((item) => item.path === "wiki/concepts/a.md")!.currentContent;
  await enricher.apply(plan, workingSet, workingSet.list().map((item) => item.path));
  const twice = workingSet.list().find((item) => item.path === "wiki/concepts/a.md")!.currentContent;

  assert.equal(once, twice);
  assert.match(once, /用户正文保留/);
  assert.equal((once.match(/llm-wiki:related:start/g) ?? []).length, 1);
  assert.deepEqual(parseMarkdown("wiki/concepts/a.md", once)!.related, ["wiki/concepts/existing"]);
  const validation = validateIngestLinkGraph({
    stagedPages: workingSet.list(),
    existingPages: [existing],
    sourcePaths: new Map([["source", "wiki/sources/source.md"]]),
    candidates: [{
      candidateId: "a", sourceId: "source", title: "A", type: "concept",
      decision: "created", targetPath: "wiki/concepts/a.md"
    }],
    plan
  });
  assert.deepEqual(validation.errors, []);
});

test("partial-plan sanitizing removes rejected targets from related and managed body", () => {
  const source = enrichWikiContent(
    "wiki/sources/source.md",
    makePageTemplate("source", "Source", "Source", "# Source"),
    ["wiki/concepts/accepted", "wiki/concepts/rejected"]
  );
  const input = {
    version: 1,
    operationId: "partial-links",
    summary: "partial links",
    operations: [{ action: "create", path: "wiki/sources/source.md", content: source, reason: "source" }]
  };
  const hashes = new Map([["wiki/concepts/accepted.md", "hash"]]);
  const sanitized = sanitizePlanDanglingLinks(input, hashes);
  const plan = validateChangePlan(sanitized, hashes);
  const parsed = parseMarkdown(plan.operations[0]!.path, plan.operations[0]!.content)!;

  assert.deepEqual(parsed.related, ["wiki/concepts/accepted"]);
  assert.match(parsed.body, /\[\[wiki\/concepts\/accepted\]\]/);
  assert.doesNotMatch(parsed.body, /rejected/);
});

function memoryHost(pages: WikiPage[]) {
  return {
    currentHashes: async () => new Map(pages.map((item) => [item.path, sha256(item.content)])),
    readWikiPage: async (path: string) => {
      const match = pages.find((item) => item.path === path);
      if (!match) throw new Error(`not found: ${path}`);
      return match;
    }
  };
}

function page(path: string, content: string): WikiPage {
  return parseMarkdown(path, content)!;
}
