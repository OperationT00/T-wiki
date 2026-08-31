import type { DataAdapter } from "obsidian";

import { normalizeVaultPath } from "../core/wiki-core";
import { atomicReplaceText, atomicWriteText, ensureFolder } from "../services/source-store";

import type { EditableDocumentRecord } from "./types";

interface StoredEditableDocuments {
  version: 1;
  revision: number;
  documents: EditableDocumentRecord[];
}

const EMPTY: StoredEditableDocuments = { version: 1, revision: 0, documents: [] };

export class EditableDocumentStore {
  private writeTail: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(
    private readonly adapter: DataAdapter,
    private readonly internalRoot: string
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await ensureFolder(this.adapter, normalizeVaultPath(this.internalRoot));
    await this.recoverInterruptedWrite();
    if (!(await this.adapter.exists(this.path))) {
      await atomicWriteText(this.adapter, this.path, serializeStore(EMPTY));
    }
    await this.readState();
    this.initialized = true;
  }

  async list(): Promise<EditableDocumentRecord[]> {
    await this.initialize();
    return (await this.readState()).documents.map((item) => structuredClone(item));
  }

  async get(documentId: string): Promise<EditableDocumentRecord> {
    assertDocumentId(documentId);
    const value = (await this.list()).find((item) => item.documentId === documentId);
    if (!value) throw new Error(`可编辑文稿不存在：${documentId}`);
    return value;
  }

  async put(record: EditableDocumentRecord): Promise<EditableDocumentRecord> {
    const normalized = normalizeRecord(record);
    return this.mutate((state) => {
      if (state.documents.some((item) => item.documentId === normalized.documentId)) {
        throw new Error(`可编辑文稿已存在：${normalized.documentId}`);
      }
      if (state.documents.some((item) => item.path.toLocaleLowerCase() === normalized.path.toLocaleLowerCase())) {
        throw new Error(`文稿路径已登记：${normalized.path}`);
      }
      state.documents.push(normalized);
      return normalized;
    });
  }

  async update(
    documentId: string,
    mutate: (record: EditableDocumentRecord) => EditableDocumentRecord
  ): Promise<EditableDocumentRecord> {
    assertDocumentId(documentId);
    return this.mutate((state) => {
      const index = state.documents.findIndex((item) => item.documentId === documentId);
      if (index < 0) throw new Error(`可编辑文稿不存在：${documentId}`);
      const next = normalizeRecord(mutate(structuredClone(state.documents[index]!)));
      if (next.documentId !== documentId) throw new Error("documentId 不可修改");
      if (state.documents.some((item, itemIndex) => itemIndex !== index
        && item.path.toLocaleLowerCase() === next.path.toLocaleLowerCase())) {
        throw new Error(`文稿路径已登记：${next.path}`);
      }
      state.documents[index] = next;
      return next;
    });
  }

  async remove(documentId: string): Promise<void> {
    assertDocumentId(documentId);
    await this.mutate((state) => {
      state.documents = state.documents.filter((item) => item.documentId !== documentId);
    });
  }

  private async mutate<T>(mutate: (state: StoredEditableDocuments) => T): Promise<T> {
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.writeTail = this.writeTail.then(async () => {
      try {
        await this.initialize();
        const state = await this.readState();
        const value = mutate(state);
        state.revision += 1;
        await atomicReplaceText(this.adapter, this.path, serializeStore(state));
        resolveResult(structuredClone(value));
      } catch (error) {
        rejectResult(error);
      }
    });
    await this.writeTail;
    return result;
  }

  private async readState(): Promise<StoredEditableDocuments> {
    const raw = JSON.parse(await this.adapter.read(this.path)) as unknown;
    if (!raw || typeof raw !== "object") throw new Error("可编辑文稿状态无效");
    const input = raw as Record<string, unknown>;
    if (input.version !== 1 || !Number.isInteger(input.revision) || !Array.isArray(input.documents)) {
      throw new Error("可编辑文稿状态 Schema 无效");
    }
    return {
      version: 1,
      revision: Number(input.revision),
      documents: input.documents.map((item) => normalizeRecord(item as EditableDocumentRecord))
    };
  }

  private async recoverInterruptedWrite(): Promise<void> {
    const root = normalizeVaultPath(this.internalRoot);
    const listing = await this.adapter.list(root);
    const basename = this.path.split("/").at(-1)!;
    const tempPrefix = `${root}/${basename}.`;
    for (const candidate of listing.files) {
      if (!candidate.startsWith(tempPrefix)) continue;
      if (candidate.endsWith(".tmp")) {
        await this.adapter.remove(candidate);
        continue;
      }
      if (!candidate.endsWith(".prev")) continue;
      if (await this.adapter.exists(this.path)) await this.adapter.remove(candidate);
      else await this.adapter.rename(candidate, this.path);
    }
  }

  private get path(): string {
    return `${normalizeVaultPath(this.internalRoot)}/editable-documents-v1.json`;
  }
}

function normalizeRecord(value: EditableDocumentRecord): EditableDocumentRecord {
  if (!value || typeof value !== "object") throw new Error("可编辑文稿记录无效");
  assertDocumentId(value.documentId);
  if (value.version !== 1 || (value.kind !== "note" && value.kind !== "raw_revision")) {
    throw new Error(`可编辑文稿类型无效：${value.documentId}`);
  }
  const path = normalizeVaultPath(String(value.path ?? ""));
  if (!path.toLocaleLowerCase().endsWith(".md") || path.split("/").includes("..")) {
    throw new Error(`可编辑文稿路径无效：${value.path}`);
  }
  if (!String(value.title ?? "").trim() || !isIsoDate(value.createdAt)) {
    throw new Error(`可编辑文稿元数据无效：${value.documentId}`);
  }
  if (value.kind === "raw_revision" && !value.base) {
    throw new Error(`Raw 修订稿缺少 Base：${value.documentId}`);
  }
  const base = value.base ? {
    ...structuredClone(value.base),
    assets: (value.base.assets ?? []).map((asset) => {
      const assetPath = normalizeVaultPath(String(asset.path ?? ""));
      if (!/^[a-zA-Z0-9_-]+$/.test(asset.assetId)
        || !/^image\/(?:png|jpeg|webp|gif|svg\+xml)$/.test(asset.mime)
        || !/^[a-f0-9]{64}$/.test(asset.hash)
        || !assetPath || assetPath.split("/").includes("..")) {
        throw new Error(`可编辑文稿附件记录无效：${value.documentId}`);
      }
      return { ...structuredClone(asset), path: assetPath };
    })
  } : undefined;
  return structuredClone({ ...value, path, title: value.title.trim(), ...(base ? { base } : {}) });
}

function assertDocumentId(value: string): void {
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(value)) throw new Error(`documentId 无效：${value}`);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function serializeStore(value: StoredEditableDocuments): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
