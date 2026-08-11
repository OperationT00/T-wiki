import assert from "node:assert/strict";
import test from "node:test";
import type { DataAdapter } from "obsidian";

import { EvidenceLedger } from "../src/agent/evidence-ledger";
import { buildNavigationIndex, indexCardFromPage, patchNavigationIndex } from "../src/core/wiki-navigation-index";
import { ContentSnapshotStore } from "../src/services/content-snapshot-store";
import { PendingPlanStore } from "../src/services/pending-plan-store";
import { classifyTransactionFile } from "../src/services/transaction-recovery";
import type { WikiPage } from "../src/types";

test("content-addressed rollback snapshots are compressed and deduplicated", async () => {
  const adapter = new MemoryAdapter();
  const store = new ContentSnapshotStore(adapter as unknown as DataAdapter, ".llm-wiki");
  const content = "# Large page\n\n" + "repeatable rollback content\n".repeat(2_000);
  const first = await store.put(content);
  const second = await store.put(content);
  assert.equal(first, second);
  assert.equal(await store.get(first), content);
  const paths = [...adapter.binary.keys()].filter((path) => path.endsWith(".gz"));
  assert.equal(paths.length, 1);
  assert.ok(adapter.binary.get(paths[0]!)!.byteLength < new TextEncoder().encode(content).byteLength / 4);
});

test("pending review plans survive store recreation and clear atomically", async () => {
  const adapter = new MemoryAdapter();
  const path = ".llm-wiki/pending-plan.json";
  const first = new PendingPlanStore(adapter as unknown as DataAdapter, path);
  const plan = {
    version: 1 as const,
    operationId: "operation-persist-1",
    summary: "Persist review",
    operations: [{ action: "create" as const, path: "wiki/concepts/persist.md", content: "body", reason: "test" }]
  };
  await first.save(plan, []);
  const restored = await new PendingPlanStore(adapter as unknown as DataAdapter, path).load();
  assert.deepEqual(restored?.plan, plan);
  await first.clear();
  assert.equal(await first.load(), null);
});

test("evidence claims require a verbatim passage from the read evidence", () => {
  const ledger = new EvidenceLedger();
  const id = ledger.recordRaw("source-1", "a".repeat(64), "s0001", "TCP uses a three-way handshake before data transfer.");
  const claim = ledger.bindClaim(id, "TCP connection establishment uses three messages", "TCP uses a three-way handshake");
  assert.equal(claim.relation, "supports");
  assert.equal(claim.evidence.sectionId, "s0001");
  assert.throws(() => ledger.bindClaim(id, "Unsupported", "This sentence was never read"), /不包含支持引文/);
});

test("navigation index patches one page while retaining graph backlinks", () => {
  const a = page("wiki/concepts/a.md", "A", ["wiki/concepts/b"]);
  const b = page("wiki/concepts/b.md", "B", []);
  const base = buildNavigationIndex([a, b], "before", "2026-01-01T00:00:00.000Z");
  const changed = page("wiki/concepts/b.md", "B2", ["wiki/concepts/a"]);
  const patched = patchNavigationIndex(base, new Map([[changed.path, indexCardFromPage(changed)]]), "after");
  assert.equal(patched.pages.find((item) => item.path === changed.path)?.title, "B2");
  assert.deepEqual(patched.pages.find((item) => item.path === a.path)?.backlinks, ["wiki/concepts/b"]);
  assert.deepEqual(patched.pages.find((item) => item.path === changed.path)?.backlinks, ["wiki/concepts/a"]);
});

test("transaction recovery identifies writes from hashes without a progress log", () => {
  const before = "a".repeat(64);
  const after = "b".repeat(64);
  assert.equal(classifyTransactionFile(before, after, before), "not_applied");
  assert.equal(classifyTransactionFile(before, after, after), "applied");
  assert.equal(classifyTransactionFile(before, after, "c".repeat(64)), "conflict");
  assert.equal(classifyTransactionFile(null, after, null), "not_applied");
});

function page(path: string, title: string, links: string[]): WikiPage {
  return {
    path, basename: path.split("/").pop()!, type: "concept", title, tldr: title,
    status: "draft", created: "2026-01-01", updated: "2026-01-01", tags: [], related: [], aliases: [],
    frontmatter: {}, body: `# ${title}`, content: `---\ntype: concept\ntitle: ${title}\n---\n# ${title}`,
    links
  };
}

class MemoryAdapter {
  readonly text = new Map<string, string>();
  readonly binary = new Map<string, Uint8Array>();
  readonly folders = new Set<string>();
  async exists(path: string) { return this.text.has(path) || this.binary.has(path) || this.folders.has(path); }
  async mkdir(path: string) { this.folders.add(path); }
  async write(path: string, value: string) { this.text.set(path, value); }
  async read(path: string) { const value = this.text.get(path); if (value === undefined) throw new Error(path); return value; }
  async writeBinary(path: string, value: ArrayBuffer) { this.binary.set(path, new Uint8Array(value)); }
  async readBinary(path: string) {
    const value = this.binary.get(path); if (!value) throw new Error(path);
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  }
  async remove(path: string) { this.text.delete(path); this.binary.delete(path); }
  async rename(from: string, to: string) {
    if (this.text.has(from)) { this.text.set(to, this.text.get(from)!); this.text.delete(from); return; }
    if (this.binary.has(from)) { this.binary.set(to, this.binary.get(from)!); this.binary.delete(from); return; }
    throw new Error(from);
  }
}
