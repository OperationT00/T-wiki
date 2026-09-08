import assert from "node:assert/strict";
import test from "node:test";

import type { WikiNavigationIndex } from "../src/core/wiki-navigation-index";
import type { EditableDocumentView } from "../src/editable-documents/types";
import type { RecoveryOverview, SourceManifest } from "../src/types";
import { homeDashboardSummary } from "../src/ui/home-dashboard";

test("home dashboard summarizes navigation graph and actionable source states", () => {
  const summary = homeDashboardSummary(
    navigation([
      page("wiki/sources/book.md", ["wiki/concepts/tcp", "wiki/concepts/ip"]),
      page("wiki/concepts/tcp.md", ["wiki/concepts/ip"])
    ]),
    [
      source("parsed", "not_started"),
      source("queued", "not_started"),
      source("parsed", "awaiting_review"),
      source("parse_failed", "ingest_failed")
    ],
    [{} as EditableDocumentView],
    recovery(1, 1, 0)
  );

  assert.equal(summary.empty, false);
  assert.deepEqual(summary.stats, { wikiPages: 2, sources: 4, links: 3, notes: 1 });
  assert.deepEqual(summary.pending, {
    readyToIngest: 1,
    parsing: 1,
    awaitingReview: 1,
    failed: 1,
    recoverable: 1,
    blocked: 0
  });
});

test("home dashboard only uses the empty state when knowledge and recovery state are both absent", () => {
  assert.equal(homeDashboardSummary(navigation([]), [], [], recovery(0, 0, 0)).empty, true);
  assert.equal(homeDashboardSummary(navigation([]), [], [], recovery(1, 0, 1)).empty, false);
});

function navigation(pages: WikiNavigationIndex["pages"]): WikiNavigationIndex {
  return {
    schemaVersion: 1,
    revision: "revision",
    fingerprint: "fingerprint",
    generatedAt: "2026-09-08T00:00:00.000Z",
    pages,
    groups: {
      types: { source: 0, entity: 0, concept: 0, synthesis: 0, output: 0 },
      tags: {}
    }
  };
}

function page(path: string, outgoing: string[]): WikiNavigationIndex["pages"][number] {
  return {
    path,
    hash: "a".repeat(64),
    type: path.includes("/sources/") ? "source" : "concept",
    title: path,
    aliases: [],
    tags: [],
    tldr: path,
    headings: [],
    outgoing,
    backlinks: []
  };
}

function source(parseStatus: SourceManifest["parse"]["status"], ingestStatus: SourceManifest["ingest"]["status"]): SourceManifest {
  return {
    parse: { status: parseStatus },
    ingest: { status: ingestStatus }
  } as unknown as SourceManifest;
}

function recovery(total: number, recoverable: number, blocked: number): RecoveryOverview {
  return {
    version: 1,
    generatedAt: "2026-09-08T00:00:00.000Z",
    healthy: total === 0,
    counts: { total, recoverable, blocked },
    items: []
  };
}
