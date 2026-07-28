import assert from "node:assert/strict";
import test from "node:test";

import { EvidenceLedger } from "../src/agent/evidence-ledger";
import type { ToolExecutionContext } from "../src/agent/tools";
import { WorkingSet } from "../src/agent/working-set";
import { createWikiToolRegistry } from "../src/agent/wiki-tools";
import { makePageTemplate, parseMarkdown, sha256 } from "../src/core/wiki-core";
import type { SourceManifest, WikiPage } from "../src/types";

test("search_wiki supports exact, all_terms and any_terms without changing lexical host search", async () => {
  let lexicalCalls = 0;
  const pages = [page("wiki/concepts/syn-flood.md", "SYN Flood", "半连接队列耗尽"), page("wiki/concepts/xss.md", "XSS", "跨站脚本攻击")];
  const registry = createWikiToolRegistry({
    listSources: async () => [], getSource: async () => { throw new Error("unused"); },
    readVerifiedSource: async () => { throw new Error("unused"); },
    search: async () => { lexicalCalls += 1; return [{ page: pages[1]!, score: 9, reasons: ["legacy"] }]; },
    readWikiPage: async () => { throw new Error("unused"); }, readPages: async () => pages,
    runLint: async () => ({ generatedAt: "", issues: [], pageCount: pages.length })
  });
  const tool = registry.get("search_wiki");
  const lexical = await tool.execute({ query: "anything" }, context());
  assert.equal((lexical.output as any).matches[0].path, "wiki/concepts/xss.md");
  assert.equal(lexicalCalls, 1);

  const exact = await tool.execute({ query: "SYN Flood", matchMode: "exact" }, context());
  assert.deepEqual((exact.output as any).matches.map((item: any) => item.path), ["wiki/concepts/syn-flood.md"]);
  const all = await tool.execute({ query: "半连接 队列", matchMode: "all_terms" }, context());
  assert.equal((all.output as any).matches.length, 1);
  const any = await tool.execute({ query: "半连接 不存在", matchMode: "any_terms" }, context());
  assert.equal((any.output as any).matches.length, 1);
  assert.equal(lexicalCalls, 1, "non-lexical modes use deterministic page scanning");
});

test("search_raw match modes remain restricted to allowed verified sources", async () => {
  const manifest = sourceManifest();
  const registry = createWikiToolRegistry({
    listSources: async () => [manifest], getSource: async () => manifest,
    readVerifiedSource: async (sourceId) => {
      if (sourceId !== manifest.sourceId) throw new Error("unexpected source");
      return { manifest, content: "# Security\n\nSYN Flood exhausts the half-open connection queue.\n\n# Other\n\nXSS." };
    },
    search: async () => [], readWikiPage: async () => { throw new Error("unused"); }, readPages: async () => [],
    runLint: async () => ({ generatedAt: "", issues: [], pageCount: 0 })
  });
  const tool = registry.get("search_raw");
  const allowed = context(new Set([manifest.sourceId]));
  const exact = await tool.execute({ query: "SYN Flood", matchMode: "exact" }, allowed);
  assert.equal((exact.output as any).matches.length, 1);
  const all = await tool.execute({ query: "half-open queue", matchMode: "all_terms" }, allowed);
  assert.equal((all.output as any).matches.length, 1);
  await assert.rejects(() => tool.execute({ sourceIds: ["other-source"], query: "SYN" }, allowed), /不在当前任务范围/);
});

test("read_wiki_page defaults to outline and records evidence only for section or explicit full reads", async () => {
  const target = page("wiki/concepts/tcp.md", "TCP", "# Handshake\n\nThree steps.\n\n# Reliability\n\nACK and retransmission.");
  const registry = createWikiToolRegistry({
    listSources: async () => [], getSource: async () => { throw new Error("unused"); },
    readVerifiedSource: async () => { throw new Error("unused"); }, search: async () => [],
    readWikiPage: async () => target, readPages: async () => [target],
    runLint: async () => ({ generatedAt: "", issues: [], pageCount: 1 })
  });
  const tool = registry.get("read_wiki_page");
  const toolContext = context();
  const hash = sha256(target.content);
  const outline = await tool.execute({ path: target.path, expectedHash: hash }, toolContext);
  assert.equal("content" in (outline.output as any), false);
  assert.equal((outline.output as any).sections.length, 2);
  assert.equal(toolContext.evidenceLedger.hasWiki(target.path, hash), false);
  const sectionId = (outline.output as any).sections[0].sectionId;
  const section = await tool.execute({ path: target.path, expectedHash: hash, mode: "section", sectionId }, toolContext);
  assert.match((section.output as any).content, /Three steps/);
  assert.equal(toolContext.evidenceLedger.hasWiki(target.path, hash), true);
  const full = await tool.execute({ path: target.path, expectedHash: hash, mode: "full" }, toolContext);
  assert.equal((full.output as any).content, target.content);
});

test("get_wiki_links traverses frontmatter related as outgoing links and backlinks", async () => {
  const sourceContent = makePageTemplate("source", "Source", "Source", "# Source")
    .replace("related: []", "related:\n  - wiki/concepts/target");
  const source = parseMarkdown("wiki/sources/source.md", sourceContent)!;
  const target = parseMarkdown(
    "wiki/concepts/target.md",
    makePageTemplate("concept", "Target", "Target", "# Target")
  )!;
  const pages = [source, target];
  const registry = createWikiToolRegistry({
    listSources: async () => [], getSource: async () => { throw new Error("unused"); },
    readVerifiedSource: async () => { throw new Error("unused"); }, search: async () => [],
    readWikiPage: async (path) => pages.find((item) => item.path === path)!, readPages: async () => pages,
    runLint: async () => ({ generatedAt: "", issues: [], pageCount: pages.length })
  });
  const tool = registry.get("get_wiki_links");
  const outgoing = await tool.execute({ path: source.path, direction: "both" }, context());
  assert.deepEqual((outgoing.output as any).outgoing, [{ target: "wiki/concepts/target", exists: true }]);
  const incoming = await tool.execute({ path: target.path, direction: "both" }, context());
  assert.equal((incoming.output as any).backlinks[0].path, source.path);
});

test("get_wiki_links pre-expands two hops, removes cycles, and returns navigation summaries", async () => {
  const pages = [
    linkedPage("wiki/concepts/a.md", "A", "wiki/concepts/b"),
    linkedPage("wiki/concepts/b.md", "B", "wiki/concepts/c"),
    linkedPage("wiki/concepts/c.md", "C", "wiki/concepts/a")
  ];
  const registry = createWikiToolRegistry({
    listSources: async () => [], getSource: async () => { throw new Error("unused"); },
    readVerifiedSource: async () => { throw new Error("unused"); }, search: async () => [],
    readWikiPage: async (path) => pages.find((item) => item.path === path)!, readPages: async () => pages,
    runLint: async () => ({ generatedAt: "", issues: [], pageCount: pages.length })
  });
  const toolContext = context();
  toolContext.queryState = {
    indexReads: [], wikiReads: [], graphTraversals: [], citationStatus: "pending", citationErrors: []
  };
  const result = await registry.get("get_wiki_links").execute({
    path: "wiki/concepts/a.md", direction: "outgoing", depth: 2, limit: 20
  }, toolContext);
  const output = result.output as any;
  assert.deepEqual(output.neighbors.map((item: any) => [item.path, item.hop]), [
    ["wiki/concepts/b.md", 1], ["wiki/concepts/c.md", 2]
  ]);
  assert.equal(output.neighbors[0].title, "B");
  assert.equal(output.neighbors.some((item: any) => item.path === "wiki/concepts/a.md"), false);
  assert.equal(toolContext.queryState.graphTraversals.length, 2);
});

function context(allowedSourceIds = new Set<string>()): ToolExecutionContext {
  return {
    signal: new AbortController().signal, allowedSourceIds, allowAllRaw: false, allowDiscussion: false,
    workingSet: new WorkingSet({ currentHashes: async () => new Map(), readWikiPage: async () => { throw new Error("not found"); } }, 2),
    evidenceLedger: new EvidenceLedger(), requireEvidence: false, validationCount: 0
  };
}

function page(path: string, title: string, body: string): WikiPage {
  return {
    path, basename: path.split("/").at(-1)!.replace(/\.md$/, ""), type: "concept", title, tldr: body,
    status: "draft", created: "2026-01-01", updated: "2026-01-01", tags: [], related: [], aliases: [],
    frontmatter: {}, body, content: `# ${title}\n\n${body}`, links: []
  };
}

function linkedPage(path: string, title: string, target: string): WikiPage {
  const parsed = parseMarkdown(path, makePageTemplate("concept", title, `${title} summary`, `[[${target}]]`));
  assert.ok(parsed);
  return parsed;
}

function sourceManifest(): SourceManifest {
  return {
    schemaVersion: 3, manifestRevision: 1, sourceId: "source-1", sourceHash: "a".repeat(64),
    source: { kind: "markdown", acquiredBy: "test" },
    original: { name: "source.md", extension: ".md", mime: "text/markdown", size: 1, objectPath: ".llm-wiki/objects/a.md", importedAt: "2026-01-01" },
    parse: { status: "parsed", currentRevision: 1, attempts: [], revisions: [{
      revision: 1, parserId: "markdown-pass-through", parserVersion: "1", parseKey: "key", completedAt: "2026-01-01",
      rawPath: "raw/articles/source.md", contentHash: "b".repeat(64), artifactHash: "c".repeat(64), artifactSchemaVersion: 3,
      metadata: {}, quality: { characterCount: 1, blockCount: 1, replacementCharacterRatio: 0, veryLongLineCount: 0, omittedImageCount: 0, tableCount: 0, overall: "pass" }, warnings: []
    }] },
    ingest: { status: "not_started", attempts: [] }
  };
}
