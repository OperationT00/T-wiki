import assert from "node:assert/strict";
import test from "node:test";

import type { DataAdapter } from "obsidian";

import { EditableDocumentStore } from "../src/editable-documents/editable-document-store";
import {
  EditableDocumentService,
  extractDraftBody,
  resolveEditableTitle
} from "../src/editable-documents/editable-document-service";
import { computeTextDiff, renderUnifiedDiff } from "../src/editable-documents/text-diff";
import { resolveThreeWayConflicts, threeWayMerge } from "../src/editable-documents/three-way-merge";
import type { EditableDocumentRecord } from "../src/editable-documents/types";
import { DEFAULT_CONFIG, sha256 } from "../src/core/wiki-core";
import { mergeConfig } from "../src/core/wiki-config";
import { EditableDocumentBundleParser } from "../src/parsing/parsers/editable-document-bundle-parser";
import { sourceBodyFromBytes } from "../src/parsing/parser-types";

test("editable document store persists metadata without document bodies", async () => {
  const adapter = new MemoryAdapter();
  const store = new EditableDocumentStore(adapter as unknown as DataAdapter, ".llm-wiki");
  const record: EditableDocumentRecord = {
    version: 1,
    documentId: "document-0001",
    kind: "note",
    path: "notes/t-wiki/notes/tcp.md",
    title: "TCP 笔记",
    createdAt: "2026-08-31T00:00:00.000Z"
  };
  await store.put(record);

  const restored = await new EditableDocumentStore(
    adapter as unknown as DataAdapter,
    ".llm-wiki"
  ).get(record.documentId);
  assert.deepEqual(restored, record);
  const persisted = await adapter.read(".llm-wiki/editable-documents-v1.json");
  assert.doesNotMatch(persisted, /正文不应被保存/);

  await store.update(record.documentId, (current) => ({
    ...current,
    path: "notes/t-wiki/notes/tcp-renamed.md"
  }));
  assert.equal((await store.get(record.documentId)).path, "notes/t-wiki/notes/tcp-renamed.md");
  await store.remove(record.documentId);
  assert.deepEqual(await store.list(), []);
});

test("editable workspace path cannot overlap canonical or internal roots", () => {
  assert.throws(() => mergeConfig({ paths: { ...DEFAULT_CONFIG.paths, notes: "raw/notes" } }), /不能与系统目录重叠/);
  assert.throws(() => mergeConfig({ paths: { ...DEFAULT_CONFIG.paths, notes: ".llm-wiki" } }), /不能与系统目录重叠/);
  assert.equal(mergeConfig({}).paths.notes, "notes/t-wiki");
});

test("editable title follows frontmatter, H1, filename, then creation title", () => {
  const record: EditableDocumentRecord = {
    version: 1,
    documentId: "title-document-1",
    kind: "note",
    path: "notes/t-wiki/notes/file-title.md",
    title: "Creation title",
    createdAt: "2026-08-31T00:00:00.000Z"
  };
  assert.equal(resolveEditableTitle(record, "---\ntitle: Frontmatter title\n---\n# Heading title\n"), "Frontmatter title");
  assert.equal(resolveEditableTitle(record, "---\ntitle: \"\"\n---\n# Heading title\n"), "Heading title");
  assert.equal(resolveEditableTitle(record, "---\ntitle: \"\"\n---\nBody\n"), "file-title");
});

test("editable document store recovers an interrupted atomic replacement", async () => {
  const adapter = new MemoryAdapter();
  const path = ".llm-wiki/editable-documents-v1.json";
  await adapter.mkdir(".llm-wiki");
  await adapter.write(`${path}.recovery.prev`, JSON.stringify({ version: 1, revision: 2, documents: [] }));
  await adapter.write(`${path}.abandoned.tmp`, "partial");
  const store = new EditableDocumentStore(adapter as unknown as DataAdapter, ".llm-wiki");
  assert.deepEqual(await store.list(), []);
  assert.equal(await adapter.exists(path), true);
  assert.equal(await adapter.exists(`${path}.recovery.prev`), false);
  assert.equal(await adapter.exists(`${path}.abandoned.tmp`), false);
});

test("text diff produces separate exact hunks for multiple changes", () => {
  const before = [
    "# TCP", "line 1", "timeout 80 seconds", "line 3", "line 4", "line 5", "line 6", "two handshakes", "tail"
  ].join("\n");
  const after = [
    "# TCP", "line 1", "timeout 90 seconds", "line 3", "line 4", "line 5", "line 6", "three handshakes", "tail"
  ].join("\n");
  const diff = computeTextDiff(before, after, 1);
  assert.equal(diff.addedLines, 2);
  assert.equal(diff.removedLines, 2);
  assert.equal(diff.hunks.length, 2);
  assert.equal(diff.truncated, false);
  const rendered = renderUnifiedDiff(diff);
  assert.match(rendered, /-timeout 80 seconds/);
  assert.match(rendered, /\+timeout 90 seconds/);
  assert.match(rendered, /-two handshakes/);
  assert.match(rendered, /\+three handshakes/);
});

test("three-way rebase merges independent edits and requires explicit conflict choices", () => {
  const base = "# Note\n\nalpha\nbeta\ngamma\n";
  const independent = threeWayMerge(
    base,
    "# Note\n\nalpha-user\nbeta\ngamma\n",
    "# Note\n\nalpha\nbeta\ngamma-upstream\n"
  );
  assert.equal(independent.conflicts.length, 0);
  assert.match(independent.merged, /alpha-user/);
  assert.match(independent.merged, /gamma-upstream/);

  const conflict = threeWayMerge(base, base.replace("beta", "beta-user"), base.replace("beta", "beta-upstream"));
  assert.equal(conflict.conflicts.length, 1);
  assert.throws(() => resolveThreeWayConflicts(conflict, {}), /尚未处理冲突/);
  assert.match(resolveThreeWayConflicts(conflict, { "conflict-0001": "upstream" }), /beta-upstream/);
});

test("editable workspace unifies blank notes and hash-bound Raw revisions", async () => {
  const adapter = new MemoryAdapter();
  const vault = {
    create: async (path: string, content: string) => {
      await adapter.write(path, content);
      return { path };
    }
  };
  const service = new EditableDocumentService(
    vault as never,
    adapter as unknown as DataAdapter,
    DEFAULT_CONFIG
  );
  const note = await service.createNote("TCP 学习笔记");
  assert.equal(note.status, "draft");
  assert.match(note.record.path, /^notes\/t-wiki\/notes\//);
  assert.match(await adapter.read(note.record.path), /t_wiki_document_kind: note/);

  const baseBody = "# 网络课程\n\n超时时间是 90 秒。\n";
  const base = {
    sourceId: "source-raw-1",
    parseRevision: 1,
    rawPath: "raw/articles/network.md",
    contentHash: sha256(baseBody)
  };
  const revision = await service.createRawRevision("网络课程", base, baseBody, "correction");
  const edited = (await adapter.read(revision.record.path)).replace("90 秒", "80 秒");
  await adapter.write(revision.record.path, edited);
  const diff = await service.diffFromBase(revision.record.documentId, baseBody);
  assert.equal(diff.addedLines, 1);
  assert.equal(diff.removedLines, 1);

  const prepared = await service.preparePublication(revision.record.documentId, baseBody);
  assert.equal(prepared.provenance.acquiredBy, "user-raw-revision");
  assert.equal(prepared.provenance.deduplicateManifest, false);
  assert.equal(prepared.provenance.lineage?.baseSourceId, base.sourceId);
  assert.match(extractDraftBody(prepared.content), /80 秒/);

  const published = await service.commitPublished(revision.record.documentId, prepared.contentHash, {
    sourceId: "derived-source-1",
    sourceHash: "a".repeat(64),
    rawPath: "raw/articles/network-revision.md"
  });
  assert.equal(published.status, "published");
  await service.markAbsorbed(revision.record.documentId, prepared.contentHash, "operation-1");
  assert.equal((await service.get(revision.record.documentId)).status, "absorbed");
  await adapter.write(revision.record.path, `${edited}\n新增说明。\n`);
  assert.equal((await service.get(revision.record.documentId)).status, "dirty");
});

test("Raw revision owns copied assets and publishes a retry-safe immutable bundle", async () => {
  const adapter = new MemoryAdapter();
  const vault = { create: async (path: string, content: string) => {
    await adapter.write(path, content);
    return { path };
  } };
  const service = new EditableDocumentService(vault as never, adapter as unknown as DataAdapter, DEFAULT_CONFIG);
  const image = new Uint8Array([82, 73, 70, 70, 1, 2, 3]);
  const originalAsset = "raw/assets/source-raw-2/frame-1.webp";
  await adapter.writeBinary(originalAsset, image.buffer);
  const body = "# 图文课程\n\n![架构图](../assets/source-raw-2/frame-1.webp)\n";
  const revision = await service.createRawRevision("图文课程", {
    sourceId: "source-raw-2",
    parseRevision: 2,
    rawPath: "raw/videos/course.md",
    contentHash: sha256(body),
    assets: [{
      assetId: "frame-1",
      mime: "image/webp",
      path: originalAsset,
      hash: sha256(image),
      source: { startMs: 1200 }
    }]
  }, body);
  const workspaceContent = await adapter.read(revision.record.path);
  assert.match(workspaceContent, new RegExp(`\.\./assets/${revision.record.documentId}/frame-1\.webp`));
  const assetOnlyDiff = await service.diffFromBase(revision.record.documentId, body);
  assert.equal(assetOnlyDiff.addedLines, 0);
  assert.equal(assetOnlyDiff.removedLines, 0);
  await assert.rejects(
    () => service.preparePublication(revision.record.documentId, body),
    /RAW_REVISION_UNCHANGED/
  );
  await adapter.write(revision.record.path, workspaceContent.replace("# 图文课程", "# 图文课程（修订）"));

  const prepared = await service.preparePublication(revision.record.documentId, body);
  assert.match(prepared.name, /\.twdoc$/);
  assert.equal(prepared.provenance.lineage?.snapshotContentHash, prepared.contentHash);
  const parser = new EditableDocumentBundleParser();
  const payload = await parser.parse({
    sourceId: "derived-with-assets",
    sourceHash: sha256(prepared.bytes),
    kind: "markdown",
    name: prepared.name,
    extension: "twdoc",
    mime: "application/vnd.t-wiki.editable-document+json",
    size: prepared.bytes.byteLength,
    source: sourceBodyFromBytes(prepared.bytes)
  }, {
    signal: new AbortController().signal,
    options: {},
    reportProgress: () => undefined,
    saveResumeToken: async () => undefined
  });
  assert.match(payload.markdown, /llm-wiki-asset:frame-1/);
  assert.equal(payload.assets.length, 1);
  assert.deepEqual(payload.assets[0]?.bytes, image);
});

test("ordinary notes archive local Markdown and Wiki image embeds by content hash", async () => {
  const adapter = new MemoryAdapter();
  const vault = { create: async (path: string, content: string) => {
    await adapter.write(path, content);
    return { path };
  } };
  const imagePath = "attachments/network.png";
  const image = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  await adapter.writeBinary(imagePath, image.buffer);
  const service = new EditableDocumentService(
    vault as never,
    adapter as unknown as DataAdapter,
    DEFAULT_CONFIG,
    { resolve: (linkPath) => linkPath === "network.png" ? imagePath : undefined }
  );
  const note = await service.createNote("图文网络笔记");
  const original = await adapter.read(note.record.path);
  await adapter.write(note.record.path, `${original}\n![[network.png|拓扑图]]\n\n![同一图片](network.png)\n\n\`![[ignored.png]]\`\n`);
  const prepared = await service.preparePublication(note.record.documentId);
  assert.match(prepared.name, /\.twdoc$/);
  const bundle = JSON.parse(new TextDecoder().decode(prepared.bytes));
  assert.equal(bundle.assets.length, 1);
  assert.equal((bundle.markdown.match(/llm-wiki-asset:note-/g) ?? []).length, 2);
  assert.match(bundle.markdown, /`!\[\[ignored\.png\]\]`/);

  const published = await service.commitPublished(note.record.documentId, prepared.contentHash, {
    sourceId: "note-source-with-assets",
    sourceHash: sha256(prepared.bytes),
    rawPath: "raw/articles/visual-note.md"
  });
  assert.equal(published.status, "published");
  await adapter.writeBinary(imagePath, new Uint8Array([...image, 4]).buffer);
  assert.equal((await service.get(note.record.documentId)).status, "dirty");
  const republished = await service.preparePublication(note.record.documentId);
  assert.notEqual(republished.contentHash, prepared.contentHash);
});

test("Raw revision rebases onto a newer verified base without overwriting the original draft", async () => {
  const adapter = new MemoryAdapter();
  const vault = { create: async (path: string, content: string) => {
    await adapter.write(path, content);
    return { path };
  } };
  const service = new EditableDocumentService(vault as never, adapter as unknown as DataAdapter, DEFAULT_CONFIG);
  const oldBody = "# Protocol\n\nuser target\n\nupstream target\n";
  const original = await service.createRawRevision("Protocol", {
    sourceId: "rebase-source",
    parseRevision: 1,
    rawPath: "raw/articles/protocol.md",
    contentHash: sha256(oldBody)
  }, oldBody);
  const originalContent = await adapter.read(original.record.path);
  await adapter.write(original.record.path, originalContent.replace("user target", "user changed"));
  const newBody = oldBody.replace("upstream target", "upstream changed");
  const newBase = {
    sourceId: "rebase-source",
    parseRevision: 2,
    rawPath: "raw/articles/protocol.md",
    contentHash: sha256(newBody)
  };
  const preview = await service.previewRebase(original.record.documentId, newBase, newBody);
  assert.equal(preview.conflicts.length, 0);
  const rebased = await service.applyRebase(preview, newBody, {});
  assert.notEqual(rebased.record.documentId, original.record.documentId);
  const rebasedBody = extractDraftBody(await adapter.read(rebased.record.path));
  assert.match(rebasedBody, /user changed/);
  assert.match(rebasedBody, /upstream changed/);
  assert.match(await adapter.read(original.record.path), /user changed/);
});

class MemoryAdapter {
  readonly text = new Map<string, string>();
  readonly binary = new Map<string, Uint8Array>();
  readonly folders = new Set<string>();

  async exists(path: string): Promise<boolean> {
    return this.text.has(path) || this.binary.has(path) || this.folders.has(path);
  }

  async mkdir(path: string): Promise<void> {
    this.folders.add(path);
  }

  async write(path: string, value: string): Promise<void> {
    this.text.set(path, value);
  }

  async read(path: string): Promise<string> {
    const value = this.text.get(path);
    if (value === undefined) throw new Error(path);
    return value;
  }

  async writeBinary(path: string, value: ArrayBuffer): Promise<void> {
    this.binary.set(path, new Uint8Array(value.slice(0)));
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const value = this.binary.get(path);
    if (!value) throw new Error(path);
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }

  async remove(path: string): Promise<void> {
    this.text.delete(path);
    this.binary.delete(path);
    this.folders.delete(path);
  }

  async rename(from: string, to: string): Promise<void> {
    const value = this.text.get(from);
    const binary = this.binary.get(from);
    if (value === undefined && binary === undefined) throw new Error(from);
    if (this.text.has(to) || this.binary.has(to)) throw new Error(to);
    if (value !== undefined) {
      this.text.set(to, value);
      this.text.delete(from);
    } else if (binary) {
      this.binary.set(to, binary);
      this.binary.delete(from);
    }
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = `${path.replace(/\/$/, "")}/`;
    return {
      files: [...new Set([...this.text.keys(), ...this.binary.keys()])].filter((item) => item.startsWith(prefix)
        && !item.slice(prefix.length).includes("/")),
      folders: [...this.folders].filter((item) => item.startsWith(prefix)
        && !item.slice(prefix.length).includes("/"))
    };
  }
}
