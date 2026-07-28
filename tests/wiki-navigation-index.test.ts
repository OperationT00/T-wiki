import assert from "node:assert/strict";
import test from "node:test";

import {
  buildNavigationIndex,
  compactTldr,
  indexPage,
  isNavigationIndex,
  rootIndexView
} from "../src/core/wiki-navigation-index";
import { makePageTemplate, parseMarkdown } from "../src/core/wiki-core";
import type { WikiPage } from "../src/types";

test("navigation index is deterministic, compact, and builds backlinks", () => {
  const first = page("wiki/concepts/a.md", "A", "A summary | table | " + "long ".repeat(80), "[[wiki/concepts/b]]");
  const second = page("wiki/concepts/b.md", "B", "B summary", "## Details\nBody");
  const left = buildNavigationIndex([first, second], "fingerprint", "2026-01-01T00:00:00.000Z");
  const right = buildNavigationIndex([second, first], "other-fingerprint", "2027-01-01T00:00:00.000Z");
  assert.equal(left.revision, right.revision);
  assert.ok(left.pages[0]!.tldr.length <= 180);
  assert.deepEqual(left.pages[0]!.outgoing, ["wiki/concepts/b"]);
  assert.deepEqual(left.pages[1]!.backlinks, ["wiki/concepts/a"]);
  assert.deepEqual(left.pages[1]!.headings, ["Details"]);
  assert.doesNotMatch(compactTldr("text | a | b"), /\|/);
  assert.equal(isNavigationIndex(left), true);
  assert.equal(isNavigationIndex({ ...left, revision: "tampered" }), false);
});

test("navigation root becomes layered and sub-index pagination is stable", () => {
  const pages = Array.from({ length: 700 }, (_, index) => page(
    `wiki/concepts/page-${String(index).padStart(4, "0")}.md`,
    `Page ${index}`,
    `A useful navigation summary for page ${index} ${"detail ".repeat(20)}`,
    `## Section ${index}\nBody`,
    index % 2 === 0 ? ["even"] : ["odd"]
  ));
  const navigation = buildNavigationIndex(pages, "large");
  assert.equal(rootIndexView(navigation).mode, "layered");
  const first = indexPage(navigation, { type: "concept", tag: "even", limit: 10 });
  assert.equal(first.cards.length, 10);
  assert.ok(first.nextCursor);
  const second = indexPage(navigation, { type: "concept", tag: "even", limit: 10, cursor: first.nextCursor });
  assert.equal(second.cards.length, 10);
  assert.notEqual(first.cards[0]!.path, second.cards[0]!.path);
  assert.throws(() => indexPage(navigation, { cursor: "../bad" }), /cursor/);
});

function page(path: string, title: string, tldr: string, body: string, tags: string[] = []): WikiPage {
  const content = makePageTemplate("concept", title, tldr, body)
    .replace("tags: []", `tags: [${tags.join(", ")}]`);
  const parsed = parseMarkdown(path, content);
  assert.ok(parsed);
  return parsed;
}
