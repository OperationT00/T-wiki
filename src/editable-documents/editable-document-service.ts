import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { posix } from "node:path";

import type { DataAdapter, Vault } from "obsidian";

import { normalizeVaultPath, sha256 } from "../core/wiki-core";
import type { IntakeProvenance } from "../services/intake-service";
import { ensureFolder } from "../services/source-store";
import { ContentSnapshotStore } from "../services/content-snapshot-store";
import type { SourceManifest, WikiConfig } from "../types";
import { replaceUnsafeFilenameCharacters } from "../utils/text-safety";
import { parseYaml, stringifyYaml } from "../utils/yaml";

import { EditableDocumentStore } from "./editable-document-store";
import { computeTextDiff } from "./text-diff";
import type {
  EditableDocumentRecord,
  EditableCurrentSnapshot,
  EditableDocumentView,
  EditablePublishedSnapshot,
  EditableRawBase,
  EditableRebasePreview,
  EditableRevisionMode,
  TextDiff
} from "./types";
import { resolveThreeWayConflicts, threeWayMerge } from "./three-way-merge";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const MAX_NOTE_ASSET_BYTES = 16 * 1024 * 1024;
const MAX_NOTE_ASSETS_BYTES = 64 * 1024 * 1024;

export interface EditableAttachmentResolver {
  resolve(linkPath: string, sourcePath: string): string | undefined;
}

interface PublicationAsset {
  assetId: string;
  mime: string;
  path: string;
  hash: string;
  bytes: Uint8Array;
  source?: import("../types").SourceSpan;
  replacements: Array<{ literal: string; replacement: string }>;
}

export interface PreparedEditablePublication {
  record: EditableDocumentRecord;
  content: string;
  contentHash: string;
  bytes: Uint8Array;
  name: string;
  provenance: IntakeProvenance;
}

export class EditableDocumentService {
  private readonly notesRoot: string;
  private readonly snapshots: ContentSnapshotStore;

  constructor(
    private readonly vault: Vault,
    private readonly adapter: DataAdapter,
    private readonly config: WikiConfig,
    private readonly attachmentResolver?: EditableAttachmentResolver,
    private readonly store = new EditableDocumentStore(adapter, config.paths.internal)
  ) {
    this.notesRoot = validateNotesRoot(config);
    this.snapshots = new ContentSnapshotStore(adapter, config.paths.internal);
  }

  async initialize(): Promise<void> {
    await Promise.all([
      ensureFolder(this.adapter, `${this.notesRoot}/notes`),
      ensureFolder(this.adapter, `${this.notesRoot}/revisions`),
      ensureFolder(this.adapter, `${this.notesRoot}/assets`),
      this.store.initialize()
    ]);
  }

  async createNote(title: string): Promise<EditableDocumentView> {
    await this.initialize();
    const normalizedTitle = cleanTitle(title, "未命名笔记");
    const documentId = randomUUID();
    const path = await this.availablePath("notes", normalizedTitle);
    const createdAt = new Date().toISOString();
    try {
      await this.createFile(path, renderDraftFrontmatter({
        documentId,
        kind: "note",
        title: normalizedTitle,
        createdAt
      }, `# ${normalizedTitle}\n\n`));
      const record = await this.store.put({
        version: 1,
        documentId,
        kind: "note",
        path,
        title: normalizedTitle,
        createdAt
      });
      return this.view(record);
    } catch (error) {
      if (await this.adapter.exists(path)) await this.adapter.remove(path).catch(() => undefined);
      throw error;
    }
  }

  async createRawRevision(
    title: string,
    base: EditableRawBase,
    verifiedRawBody: string,
    mode: EditableRevisionMode = "correction"
  ): Promise<EditableDocumentView> {
    await this.initialize();
    if (sha256(normalizeNewlines(verifiedRawBody)) !== base.contentHash) {
      throw new Error("RAW_REVISION_BASE_HASH_MISMATCH");
    }
    const baseSnapshot = await this.snapshots.put(normalizeNewlines(verifiedRawBody));
    if (baseSnapshot !== base.contentHash) throw new Error("RAW_REVISION_BASE_HASH_MISMATCH");
    const normalizedTitle = cleanTitle(title, "Raw 修订稿");
    const documentId = randomUUID();
    const path = await this.availablePath("revisions", `${normalizedTitle}-修订`);
    const createdAt = new Date().toISOString();
    try {
      const assets = await this.copyBaseAssets(documentId, path, base);
      const bodyWithWorkspaceAssets = rewriteBaseAssetReferences(
        normalizeNewlines(verifiedRawBody),
        assets,
        path
      );
      const workspaceBase: EditableRawBase = { ...structuredClone(base), assets };
      await this.createFile(path, renderDraftFrontmatter({
        documentId,
        kind: "raw_revision",
        title: normalizedTitle,
        createdAt,
        mode,
        base: workspaceBase
      }, bodyWithWorkspaceAssets));
      const record = await this.store.put({
        version: 1,
        documentId,
        kind: "raw_revision",
        path,
        title: normalizedTitle,
        createdAt,
        mode,
        base: workspaceBase
      });
      return this.view(record);
    } catch (error) {
      if (await this.adapter.exists(path)) await this.adapter.remove(path).catch(() => undefined);
      await this.removeAssetWorkspace(documentId);
      throw error;
    }
  }

  async list(): Promise<EditableDocumentView[]> {
    await this.initialize();
    return Promise.all((await this.store.list()).map((record) => this.view(record)));
  }

  async get(documentId: string): Promise<EditableDocumentView> {
    await this.initialize();
    return this.view(await this.store.get(documentId));
  }

  async readContent(documentId: string): Promise<string> {
    const record = await this.store.get(documentId);
    return this.readAndValidate(record);
  }

  async currentSnapshot(documentId: string): Promise<EditableCurrentSnapshot> {
    const record = await this.store.get(documentId);
    const content = normalizeNewlines(await this.readAndValidate(record));
    const title = resolveEditableTitle(record, content);
    const assets = await this.collectPublicationAssets(record, content);
    const bundle = this.buildPublicationBundle(record, content, title, assets);
    return {
      contentHash: snapshotHash(content, assets),
      title,
      canonicalMarkdown: bundle?.markdown ?? extractDraftBody(content),
      assets: assets.map((asset) => ({ assetId: asset.assetId, hash: asset.hash, mime: asset.mime }))
        .sort((left, right) => left.assetId.localeCompare(right.assetId))
    };
  }

  async diffFromBase(documentId: string, verifiedBaseBody: string): Promise<TextDiff> {
    const record = await this.store.get(documentId);
    if (record.kind !== "raw_revision" || !record.base) {
      throw new Error("只有 Raw 修订稿可以与 Base 比较");
    }
    const normalizedBase = normalizeNewlines(verifiedBaseBody);
    if (sha256(normalizedBase) !== record.base.contentHash) throw new Error("RAW_REVISION_BASE_HASH_MISMATCH");
    const content = await this.readAndValidate(record);
    const comparableDraft = restoreBaseAssetReferences(record, extractDraftBody(content));
    return computeTextDiff(normalizedBase, comparableDraft);
  }

  async previewRebase(
    documentId: string,
    newBase: EditableRawBase,
    verifiedNewBaseBody: string
  ): Promise<EditableRebasePreview> {
    const record = await this.store.get(documentId);
    if (record.kind !== "raw_revision" || !record.base) throw new Error("只有 Raw 修订稿可以 Rebase");
    const upstream = normalizeNewlines(verifiedNewBaseBody);
    if (sha256(upstream) !== newBase.contentHash) throw new Error("REBASE_NEW_BASE_HASH_MISMATCH");
    const oldBase = normalizeNewlines(await this.snapshots.get(record.base.contentHash));
    const content = await this.readAndValidate(record);
    const user = restoreBaseAssetReferences(record, extractDraftBody(content));
    const result = threeWayMerge(oldBase, user, upstream);
    return {
      documentId,
      oldBase: structuredClone(record.base),
      newBase: structuredClone(newBase),
      merged: result.merged,
      conflicts: result.conflicts
    };
  }

  async applyRebase(
    preview: EditableRebasePreview,
    verifiedNewBaseBody: string,
    resolutions: Record<string, "user" | "upstream">
  ): Promise<EditableDocumentView> {
    const original = await this.store.get(preview.documentId);
    const freshPreview = await this.previewRebase(preview.documentId, preview.newBase, verifiedNewBaseBody);
    if (JSON.stringify(freshPreview.conflicts) !== JSON.stringify(preview.conflicts)
      || freshPreview.merged !== preview.merged) {
      throw new Error("Rebase 预览已过期，请重新检查冲突");
    }
    const resolved = resolveThreeWayConflicts(
      { merged: freshPreview.merged, conflicts: freshPreview.conflicts },
      resolutions
    );
    const rebased = await this.createRawRevision(
      resolveEditableTitle(original, await this.readAndValidate(original)),
      preview.newBase,
      verifiedNewBaseBody,
      original.mode ?? "correction"
    );
    const rebasedRecord = await this.store.get(rebased.record.documentId);
    const rebasedContent = await this.readAndValidate(rebasedRecord);
    const body = rewriteBaseAssetReferences(resolved, rebasedRecord.base?.assets ?? [], rebasedRecord.path);
    await this.adapter.write(rebasedRecord.path, replaceDraftBody(rebasedContent, body));
    return this.get(rebasedRecord.documentId);
  }

  async preparePublication(
    documentId: string,
    verifiedBaseBody?: string
  ): Promise<PreparedEditablePublication> {
    const record = await this.store.get(documentId);
    const content = normalizeNewlines(await this.readAndValidate(record));
    const currentTitle = resolveEditableTitle(record, content);
    const assets = await this.collectPublicationAssets(record, content);
    const contentHash = snapshotHash(content, assets);
    if (record.lastPublished?.contentHash === contentHash) {
      throw new Error("EDITABLE_DOCUMENT_UNCHANGED");
    }
    if (record.kind === "raw_revision") {
      if (!record.base || verifiedBaseBody === undefined) throw new Error("RAW_REVISION_BASE_REQUIRED");
      if (sha256(normalizeNewlines(verifiedBaseBody)) !== record.base.contentHash) {
        throw new Error("RAW_REVISION_BASE_HASH_MISMATCH");
      }
      const comparableDraft = restoreBaseAssetReferences(record, extractDraftBody(content));
      if (sha256(normalizeNewlines(comparableDraft)) === record.base.contentHash) {
        throw new Error("修订稿与 Base 正文没有差异（RAW_REVISION_UNCHANGED）");
      }
    }
    const lineage: NonNullable<SourceManifest["source"]["lineage"]> = record.kind === "note"
      ? { type: "user-note", documentId: record.documentId, snapshotContentHash: contentHash }
      : {
          type: "user-revision",
          documentId: record.documentId,
          snapshotContentHash: contentHash,
          mode: record.mode ?? "correction",
          baseSourceId: record.base!.sourceId,
          baseParseRevision: record.base!.parseRevision,
          baseContentHash: record.base!.contentHash
        };
    const bundle = this.buildPublicationBundle(record, content, currentTitle, assets);
    const bytes = bundle
      ? new TextEncoder().encode(`${JSON.stringify(bundle)}\n`)
      : new TextEncoder().encode(content);
    return {
      record,
      content,
      contentHash,
      bytes,
      name: `${safeBasename(currentTitle, "editable-document")}.${bundle ? "twdoc" : "md"}`,
      provenance: {
        kind: "markdown",
        acquiredBy: record.kind === "note" ? "user-note" : "user-raw-revision",
        metadata: {
          title: currentTitle,
          editable_document_id: record.documentId,
          editable_document_path: record.path,
          editable_document_kind: record.kind
        },
        lineage,
        // A user workspace document has an identity distinct from an identical imported file.
        deduplicateManifest: false
      }
    };
  }

  async commitPublished(
    documentId: string,
    expectedContentHash: string,
    snapshot: Omit<EditablePublishedSnapshot, "contentHash" | "publishedAt">
  ): Promise<EditableDocumentView> {
    const recordBeforeCommit = await this.store.get(documentId);
    const current = normalizeNewlines(await this.readAndValidate(recordBeforeCommit));
    const currentAssets = await this.collectPublicationAssets(recordBeforeCommit, current);
    if (snapshotHash(current, currentAssets) !== expectedContentHash) {
      throw new Error("EDITABLE_DOCUMENT_CHANGED_DURING_PUBLISH");
    }
    const record = await this.store.update(documentId, (value) => ({
      ...value,
      lastPublished: {
        ...snapshot,
        contentHash: expectedContentHash,
        publishedAt: new Date().toISOString()
      }
    }));
    return this.view(record);
  }

  async markAbsorbed(documentId: string, contentHash: string, operationId: string): Promise<void> {
    await this.store.update(documentId, (value) => {
      if (value.lastPublished?.contentHash !== contentHash) {
        throw new Error("吸收版本不是当前已发布版本");
      }
      return {
        ...value,
        lastAbsorbed: { contentHash, operationId, absorbedAt: new Date().toISOString() }
      };
    });
  }

  /** Remove only mutable-workspace metadata after the host has trashed its files. */
  async forget(documentId: string): Promise<void> {
    await this.initialize();
    await this.store.remove(documentId);
  }

  async handleRename(oldPath: string, newPath: string): Promise<void> {
    await this.initialize();
    const oldNormalized = normalizeVaultPath(oldPath);
    const record = (await this.store.list()).find((item) => item.path === oldNormalized);
    if (!record) return;
    const next = normalizeVaultPath(newPath);
    if (!isManagedDraftPath(next, this.notesRoot)) {
      await this.store.remove(record.documentId);
      await this.removeAssetWorkspace(record.documentId);
      return;
    }
    await this.store.update(record.documentId, (value) => ({ ...value, path: next }));
  }

  async handleDelete(path: string): Promise<void> {
    await this.initialize();
    const normalized = normalizeVaultPath(path);
    const record = (await this.store.list()).find((item) => item.path === normalized);
    if (record) {
      await this.store.remove(record.documentId);
      await this.removeAssetWorkspace(record.documentId);
    }
  }

  private async view(record: EditableDocumentRecord): Promise<EditableDocumentView> {
    if (!(await this.adapter.exists(record.path))) return { record, title: record.title, status: "missing" };
    const content = normalizeNewlines(await this.adapter.read(record.path));
    const title = resolveEditableTitle(record, content);
    let currentHash: string;
    try {
      currentHash = snapshotHash(content, await this.collectPublicationAssets(record, content));
    } catch {
      // Keep the document visible and dirty when an attachment is missing or
      // invalid; publication will surface the precise actionable error.
      currentHash = sha256(`${content}\nattachment-state-invalid`);
    }
    const status = !record.lastPublished
      ? "draft"
      : record.lastPublished.contentHash !== currentHash
        ? "dirty"
        : record.lastAbsorbed?.contentHash === currentHash
          ? "absorbed"
          : "published";
    return { record, title, currentHash, status };
  }

  private async readAndValidate(record: EditableDocumentRecord): Promise<string> {
    if (!(await this.adapter.exists(record.path))) throw new Error(`文稿文件不存在：${record.path}`);
    const content = normalizeNewlines(await this.adapter.read(record.path));
    const metadata = parseDraftMetadata(content);
    if (metadata.t_wiki_document_id !== record.documentId
      || metadata.t_wiki_document_kind !== record.kind) {
      throw new Error(`文稿身份信息已变化：${record.path}`);
    }
    return content;
  }

  private async createFile(path: string, content: string): Promise<void> {
    if (await this.adapter.exists(path)) throw new Error(`文稿文件已存在：${path}`);
    await ensureFolder(this.adapter, path.split("/").slice(0, -1).join("/"));
    await this.vault.create(path, content);
  }

  private async copyBaseAssets(
    documentId: string,
    documentPath: string,
    base: EditableRawBase
  ): Promise<NonNullable<EditableRawBase["assets"]>> {
    const output: NonNullable<EditableRawBase["assets"]> = [];
    for (const asset of base.assets ?? []) {
      const originalPath = normalizeVaultPath(asset.path);
      const rawAssetsRoot = `${normalizeVaultPath(this.config.paths.raw)}/assets/`;
      if (!originalPath.startsWith(rawAssetsRoot) || !(await this.adapter.exists(originalPath))) {
        throw new Error(`Raw 修订附件不存在或越界：${asset.path}`);
      }
      const bytes = new Uint8Array(await this.adapter.readBinary(originalPath));
      if (sha256(bytes) !== asset.hash) throw new Error(`Raw 修订附件 Hash 不匹配：${asset.path}`);
      const extension = originalPath.split(".").at(-1)?.replace(/[^a-z0-9]/gi, "") || "bin";
      const target = `${this.notesRoot}/assets/${documentId}/${asset.assetId}.${extension}`;
      await ensureFolder(this.adapter, target.split("/").slice(0, -1).join("/"));
      await this.adapter.writeBinary(target, exactArrayBuffer(bytes));
      output.push({
        ...structuredClone(asset),
        path: target,
        baseReference: relativeReference(base.rawPath, originalPath)
      });
    }
    return output;
  }

  private buildPublicationBundle(
    record: EditableDocumentRecord,
    content: string,
    title: string,
    assets: PublicationAsset[]
  ): {
    schemaVersion: 1;
    markdown: string;
    metadata: Record<string, string>;
    assets: Array<{ assetId: string; mime: string; data: string; source?: import("../types").SourceSpan }>;
  } | undefined {
    if (assets.length === 0) return undefined;
    let markdown = extractDraftBody(content);
    const bundled = [];
    for (const asset of assets) {
      for (const replacement of asset.replacements) {
        markdown = markdown.split(replacement.literal).join(replacement.replacement);
      }
      bundled.push({
        assetId: asset.assetId,
        mime: asset.mime,
        data: Buffer.from(asset.bytes).toString("base64"),
        ...(asset.source ? { source: asset.source } : {})
      });
    }
    return {
      schemaVersion: 1,
      markdown,
      metadata: { title, editable_document_id: record.documentId },
      assets: bundled
    };
  }

  private async collectPublicationAssets(
    record: EditableDocumentRecord,
    content: string
  ): Promise<PublicationAsset[]> {
    if (record.kind === "raw_revision") return this.collectManagedRevisionAssets(record);
    return this.collectNoteAttachments(record, content);
  }

  private async collectManagedRevisionAssets(record: EditableDocumentRecord): Promise<PublicationAsset[]> {
    const output: PublicationAsset[] = [];
    for (const asset of record.base?.assets ?? []) {
      const path = normalizeVaultPath(asset.path);
      const expectedRoot = `${this.notesRoot}/assets/${record.documentId}/`;
      if (!path.startsWith(expectedRoot) || !(await this.adapter.exists(path))) {
        throw new Error(`文稿附件不存在或越界：${asset.path}`);
      }
      const bytes = new Uint8Array(await this.adapter.readBinary(path));
      assertAssetSize(path, bytes.byteLength);
      const reference = relativeReference(record.path, path);
      output.push({
        assetId: asset.assetId,
        mime: asset.mime,
        path,
        hash: sha256(bytes),
        bytes,
        ...(asset.source ? { source: asset.source } : {}),
        replacements: [
          { literal: reference, replacement: `llm-wiki-asset:${asset.assetId}` },
          { literal: path, replacement: `llm-wiki-asset:${asset.assetId}` }
        ]
      });
    }
    assertTotalAssetSize(output);
    return output;
  }

  private async collectNoteAttachments(
    record: EditableDocumentRecord,
    content: string
  ): Promise<PublicationAsset[]> {
    const references = extractLocalImageReferences(extractDraftBody(content));
    if (references.length === 0) return [];
    if (!this.attachmentResolver) throw new Error("当前环境无法解析笔记附件路径");
    const byIdentity = new Map<string, PublicationAsset>();
    for (const reference of references) {
      const resolved = this.attachmentResolver.resolve(reference.linkPath, record.path);
      if (!resolved) throw new Error(`找不到笔记图片：${reference.linkPath}`);
      const path = normalizeVaultPath(resolved);
      if (path.startsWith(`${normalizeVaultPath(this.config.paths.internal)}/`)
        || path.startsWith(".obsidian/")) {
        throw new Error(`笔记不能归档系统目录中的图片：${reference.linkPath}`);
      }
      const mime = imageMime(path);
      if (!mime) throw new Error(`不支持的笔记图片格式：${reference.linkPath}`);
      if (!(await this.adapter.exists(path))) throw new Error(`找不到笔记图片：${reference.linkPath}`);
      const bytes = new Uint8Array(await this.adapter.readBinary(path));
      assertAssetSize(path, bytes.byteLength);
      const hash = sha256(bytes);
      const identity = `${mime}:${hash}`;
      const assetId = `note-${hash.slice(0, 20)}`;
      const replacement = reference.syntax === "wiki"
        ? `![${escapeMarkdownAlt(posix.basename(path, posix.extname(path)))}](llm-wiki-asset:${assetId})`
        : reference.literal.replace(reference.linkToken, `llm-wiki-asset:${assetId}`);
      const existing = byIdentity.get(identity);
      if (existing) {
        existing.replacements.push({ literal: reference.literal, replacement });
      } else {
        byIdentity.set(identity, {
          assetId,
          mime,
          path,
          hash,
          bytes,
          replacements: [{ literal: reference.literal, replacement }]
        });
      }
    }
    const output = [...byIdentity.values()].sort((left, right) => left.assetId.localeCompare(right.assetId));
    assertTotalAssetSize(output);
    return output;
  }

  private async removeAssetWorkspace(documentId: string): Promise<void> {
    const root = `${this.notesRoot}/assets/${documentId}`;
    if (await this.adapter.exists(root)) await this.adapter.rmdir(root, true).catch(() => undefined);
  }

  private async availablePath(folder: "notes" | "revisions", title: string): Promise<string> {
    const basename = safeBasename(title, folder === "notes" ? "note" : "revision");
    for (let suffix = 1; suffix <= 10_000; suffix += 1) {
      const candidate = `${this.notesRoot}/${folder}/${basename}${suffix === 1 ? "" : `-${suffix}`}.md`;
      if (!(await this.adapter.exists(candidate))) return candidate;
    }
    throw new Error("无法生成可用的文稿路径");
  }
}

export function extractDraftBody(content: string): string {
  const normalized = normalizeNewlines(content);
  const match = normalized.match(FRONTMATTER);
  return match ? normalized.slice(match[0].length) : normalized;
}

function replaceDraftBody(content: string, body: string): string {
  const normalized = normalizeNewlines(content);
  const match = normalized.match(FRONTMATTER);
  if (!match) throw new Error("文稿缺少 T-Wiki frontmatter");
  return `${match[0]}${normalizeNewlines(body).replace(/^\n+/, "")}`;
}

function renderDraftFrontmatter(
  input: {
    documentId: string;
    kind: "note" | "raw_revision";
    title: string;
    createdAt: string;
    mode?: EditableRevisionMode;
    base?: EditableRawBase;
  },
  body: string
): string {
  const frontmatter = {
    t_wiki_document_id: input.documentId,
    t_wiki_document_kind: input.kind,
    title: input.title,
    created: input.createdAt.slice(0, 10),
    ...(input.mode ? { revision_mode: input.mode } : {}),
    ...(input.base
      ? {
          base_source_id: input.base.sourceId,
          base_parse_revision: input.base.parseRevision,
          base_raw_path: input.base.rawPath,
          base_content_hash: input.base.contentHash
        }
      : {})
  };
  return `---\n${stringifyYaml(frontmatter)}\n---\n${normalizeNewlines(body).replace(/^\n+/, "")}`;
}

function parseDraftMetadata(content: string): Record<string, unknown> {
  const match = normalizeNewlines(content).match(FRONTMATTER);
  if (!match?.[1]) throw new Error("文稿缺少 T-Wiki frontmatter");
  const parsed = parseYaml(match[1]);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("文稿 frontmatter 无效");
  }
  return parsed as Record<string, unknown>;
}

function validateNotesRoot(config: WikiConfig): string {
  const root = normalizeVaultPath(config.paths.notes);
  if (!root || root === "." || root.split("/").includes("..")) throw new Error("用户笔记目录无效");
  const protectedRoots = [config.paths.raw, config.paths.wiki, config.paths.internal, ".obsidian"]
    .map(normalizeVaultPath);
  if (protectedRoots.some((value) => root === value
    || root.startsWith(`${value}/`) || value.startsWith(`${root}/`))) {
    throw new Error(`用户笔记目录不能与系统目录重叠：${root}`);
  }
  return root;
}

function isManagedDraftPath(path: string, root: string): boolean {
  return path.toLocaleLowerCase().endsWith(".md")
    && (path.startsWith(`${root}/notes/`) || path.startsWith(`${root}/revisions/`));
}

function cleanTitle(value: string, fallback: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) || fallback;
}

export function resolveEditableTitle(record: EditableDocumentRecord, content: string): string {
  let frontmatterTitle = "";
  try {
    const value = parseDraftMetadata(content).title;
    if (typeof value === "string") frontmatterTitle = value;
  } catch {
    // Identity validation reports malformed frontmatter during publication; the
    // title resolver remains usable for a diagnostic workbench card.
  }
  const body = extractDraftBody(content);
  const heading = body.match(/^#\s+(.+?)\s*$/m)?.[1] ?? "";
  const filename = posix.basename(record.path, posix.extname(record.path));
  return cleanTitle(frontmatterTitle, cleanTitle(heading, cleanTitle(filename, record.title)));
}

function safeBasename(value: string, fallback: string): string {
  return replaceUnsafeFilenameCharacters(value, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 96) || fallback;
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

export function currentRawBase(manifest: SourceManifest): EditableRawBase {
  const revision = manifest.parse.revisions.find((item) => item.revision === manifest.parse.currentRevision);
  if (manifest.parse.status !== "parsed" || !revision) throw new Error(`素材尚未解析完成：${manifest.parse.status}`);
  return {
    sourceId: manifest.sourceId,
    parseRevision: revision.revision,
    rawPath: revision.rawPath,
    contentHash: revision.contentHash,
    assets: (revision.assets ?? []).map((asset) => ({
      assetId: asset.assetId,
      mime: asset.mime,
      path: asset.path,
      hash: asset.hash,
      ...(asset.source ? { source: asset.source } : {})
    }))
  };
}

function relativeReference(fromDocument: string, target: string): string {
  const relative = posix.relative(posix.dirname(normalizeVaultPath(fromDocument)), normalizeVaultPath(target));
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function rewriteBaseAssetReferences(
  markdown: string,
  assets: NonNullable<EditableRawBase["assets"]>,
  documentPath: string
): string {
  let output = markdown;
  for (const asset of assets) {
    const workspaceReference = relativeReference(documentPath, asset.path);
    if (asset.baseReference) output = output.split(asset.baseReference).join(workspaceReference);
  }
  return output;
}

function restoreBaseAssetReferences(record: EditableDocumentRecord, markdown: string): string {
  let output = markdown;
  for (const asset of record.base?.assets ?? []) {
    if (!asset.baseReference) continue;
    const workspaceReference = relativeReference(record.path, asset.path);
    output = output.split(workspaceReference).join(asset.baseReference);
  }
  return output;
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function snapshotHash(content: string, assets: PublicationAsset[]): string {
  if (assets.length === 0) return sha256(normalizeNewlines(content));
  return sha256(JSON.stringify({
    content: normalizeNewlines(content),
    assets: assets.map((asset) => ({
      assetId: asset.assetId,
      mime: asset.mime,
      hash: asset.hash
    })).sort((left, right) => left.assetId.localeCompare(right.assetId))
  }));
}

interface LocalImageReference {
  syntax: "markdown" | "wiki";
  literal: string;
  linkToken: string;
  linkPath: string;
}

function extractLocalImageReferences(markdown: string): LocalImageReference[] {
  const masked = maskMarkdownCode(markdown);
  const output: LocalImageReference[] = [];
  const markdownImage = /!\[[^\]]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
  for (const match of masked.matchAll(markdownImage)) {
    const literal = markdown.slice(match.index!, match.index! + match[0].length);
    const token = match[1] ?? match[2] ?? "";
    const linkPath = localLinkPath(token);
    if (linkPath) output.push({ syntax: "markdown", literal, linkToken: token, linkPath });
  }
  const wikiImage = /!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
  for (const match of masked.matchAll(wikiImage)) {
    const literal = markdown.slice(match.index!, match.index! + match[0].length);
    const token = match[1]?.trim() ?? "";
    const linkPath = localLinkPath(token);
    if (linkPath) output.push({ syntax: "wiki", literal, linkToken: token, linkPath });
  }
  return output;
}

function maskMarkdownCode(markdown: string): string {
  const preserveLines = (value: string): string => value.replace(/[^\n]/g, " ");
  let masked = markdown.replace(/^(?:```|~~~)[^\n]*\n[\s\S]*?^(?:```|~~~)\s*$/gm, preserveLines);
  masked = masked.replace(/`+[^`\n]*`+/g, preserveLines);
  return masked;
}

function localLinkPath(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return undefined;
  const withoutFragment = trimmed.split("#", 1)[0]!.split("?", 1)[0]!;
  try {
    return decodeURIComponent(withoutFragment).replace(/^\/+/, "");
  } catch {
    throw new Error(`笔记图片路径编码无效：${trimmed}`);
  }
}

function imageMime(path: string): string | undefined {
  const extension = posix.extname(path).slice(1).toLocaleLowerCase();
  return ({
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    svg: "image/svg+xml"
  } as Record<string, string>)[extension];
}

function assertAssetSize(path: string, size: number): void {
  if (size <= 0) throw new Error(`笔记图片为空：${path}`);
  if (size > MAX_NOTE_ASSET_BYTES) {
    throw new Error(`笔记图片超过 16 MiB：${path}`);
  }
}

function assertTotalAssetSize(assets: PublicationAsset[]): void {
  const total = assets.reduce((sum, asset) => sum + asset.bytes.byteLength, 0);
  if (total > MAX_NOTE_ASSETS_BYTES) throw new Error("笔记图片总量超过 64 MiB");
}

function escapeMarkdownAlt(value: string): string {
  return value.replace(/[[\]\\]/g, "").trim() || "图片";
}
