import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open as openFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { DataAdapter } from "obsidian";

import { normalizeVaultPath, sha256 } from "../core/wiki-core";
import type { DocumentSourceMap, SourceKind, SourceManifest } from "../types";
import { ParserError, type SourceBody } from "../parsing/parser-types";

export class ObjectStore {
  constructor(
    private readonly adapter: DataAdapter,
    private readonly internalRoot: string
  ) {}

  async initialize(): Promise<void> {
    await ensureFolder(this.adapter, this.root);
  }

  async put(sourceHash: string, extension: string, bytes: Uint8Array): Promise<string> {
    if (sha256(bytes) !== sourceHash) throw new Error("SOURCE_HASH_MISMATCH");
    const safeExtension = extension.replace(/[^a-z0-9]/gi, "").toLocaleLowerCase() || "bin";
    const folder = `${this.root}/${sourceHash.slice(0, 2)}`;
    await ensureFolder(this.adapter, folder);
    const path = `${folder}/${sourceHash}.${safeExtension}`;
    if (await this.adapter.exists(path)) {
      const existing = new Uint8Array(await this.adapter.readBinary(path));
      if (sha256(existing) !== sourceHash) throw new Error(`对象库哈希冲突：${path}`);
      return path;
    }
    const temp = `${path}.${randomUUID()}.tmp`;
    await this.adapter.writeBinary(temp, exactArrayBuffer(bytes));
    const written = new Uint8Array(await this.adapter.readBinary(temp));
    if (sha256(written) !== sourceHash) {
      await this.adapter.remove(temp);
      throw new Error("SOURCE_HASH_MISMATCH");
    }
    await this.adapter.rename(temp, path);
    return path;
  }

  async putBody(sourceHash: string, extension: string, source: SourceBody): Promise<string> {
    const safeExtension = extension.replace(/[^a-z0-9]/gi, "").toLocaleLowerCase() || "bin";
    const folder = `${this.root}/${sourceHash.slice(0, 2)}`;
    await ensureFolder(this.adapter, folder);
    const path = `${folder}/${sourceHash}.${safeExtension}`;
    if (await this.adapter.exists(path)) {
      const existingHash = await hashAdapterFile(this.adapter, path);
      if (existingHash !== sourceHash) throw new Error(`Object hash conflict: ${path}`);
      return path;
    }
    const basePath = adapterBasePath(this.adapter);
    if (!basePath) return this.put(sourceHash, extension, await source.readAll(source.size ?? Number.MAX_SAFE_INTEGER));
    const temp = `${path}.${randomUUID()}.tmp`;
    const absoluteTemp = safeAbsolutePath(basePath, temp);
    const writer = createWriteStream(absoluteTemp, { flags: "wx" });
    const hash = createHash("sha256");
    try {
      for await (const chunk of source.openStream()) {
        hash.update(chunk);
        if (!writer.write(chunk)) await onceDrain(writer);
      }
      await closeWriter(writer);
      if (hash.digest("hex") !== sourceHash) throw new Error("SOURCE_HASH_MISMATCH");
      await this.adapter.rename(temp, path);
      return path;
    } catch (error) {
      writer.destroy();
      if (await this.adapter.exists(temp)) await this.adapter.remove(temp);
      throw error;
    }
  }

  async read(manifest: SourceManifest): Promise<Uint8Array> {
    const path = normalizeVaultPath(manifest.original.objectPath);
    if (!path.startsWith(`${this.root}/`) || path.split("/").includes("..")) {
      throw new Error(`对象路径越界：${manifest.original.objectPath}`);
    }
    const bytes = new Uint8Array(await this.adapter.readBinary(path));
    if (sha256(bytes) !== manifest.sourceHash) throw new Error("SOURCE_HASH_MISMATCH");
    return bytes;
  }

  async body(manifest: SourceManifest): Promise<SourceBody> {
    const path = this.assertObjectPath(manifest.original.objectPath);
    const basePath = adapterBasePath(this.adapter);
    const readAllVerified = async (maxBytes: number): Promise<Uint8Array> => {
      if (manifest.original.size > maxBytes) {
        throw new ParserError("FILE_TOO_LARGE", `Source exceeds ${maxBytes} bytes`);
      }
      const bytes = new Uint8Array(await this.adapter.readBinary(path));
      if (sha256(bytes) !== manifest.sourceHash) throw new Error("SOURCE_HASH_MISMATCH");
      return bytes;
    };
    return {
      size: manifest.original.size,
      readHead: async (maxBytes) => {
        if (!basePath) return (await readAllVerified(manifest.original.size)).slice(0, maxBytes);
        const handle = await openFile(safeAbsolutePath(basePath, path), "r");
        try {
          const buffer = new Uint8Array(Math.min(maxBytes, manifest.original.size));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          return buffer.slice(0, bytesRead);
        } finally {
          await handle.close();
        }
      },
      readAll: readAllVerified,
      openStream: async function* () {
        if (!basePath) {
          yield await readAllVerified(manifest.original.size);
          return;
        }
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(safeAbsolutePath(basePath, path))) {
          const bytes = new Uint8Array(chunk as Buffer);
          hash.update(bytes);
          yield bytes;
        }
        if (hash.digest("hex") !== manifest.sourceHash) throw new Error("SOURCE_HASH_MISMATCH");
      }
    };
  }

  async verify(manifest: SourceManifest): Promise<void> {
    const source = await this.body(manifest);
    for await (const _chunk of source.openStream()) {
      // Hash verification is performed by SourceBody after its final chunk.
    }
  }

  private assertObjectPath(value: string): string {
    const path = normalizeVaultPath(value);
    if (!path.startsWith(`${this.root}/`) || path.split("/").includes("..")) {
      throw new Error(`Object path escapes store: ${value}`);
    }
    return path;
  }

  private get root(): string {
    return `${normalizeVaultPath(this.internalRoot)}/objects/sha256`;
  }
}

function adapterBasePath(adapter: DataAdapter): string | undefined {
  const value = (adapter as DataAdapter & { getBasePath?: () => string }).getBasePath?.();
  return typeof value === "string" && value.length > 0 ? resolve(value) : undefined;
}

async function hashAdapterFile(adapter: DataAdapter, path: string): Promise<string> {
  const basePath = adapterBasePath(adapter);
  if (!basePath) return sha256(new Uint8Array(await adapter.readBinary(path)));
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(safeAbsolutePath(basePath, path))) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function safeAbsolutePath(basePath: string, vaultPath: string): string {
  const absolute = resolve(basePath, ...normalizeVaultPath(vaultPath).split("/"));
  const root = `${resolve(basePath)}${process.platform === "win32" ? "\\" : "/"}`.toLocaleLowerCase();
  if (!`${absolute}${absolute.endsWith("/") || absolute.endsWith("\\") ? "" : process.platform === "win32" ? "\\" : "/"}`
    .toLocaleLowerCase().startsWith(root)) {
    throw new Error("OBJECT_PATH_OUTSIDE_VAULT");
  }
  return absolute;
}

function onceDrain(writer: ReturnType<typeof createWriteStream>): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    writer.once("drain", resolvePromise);
    writer.once("error", reject);
  });
}

function closeWriter(writer: ReturnType<typeof createWriteStream>): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    writer.once("error", reject);
    writer.end(resolvePromise);
  });
}

export class ManifestRepository {
  constructor(
    private readonly adapter: DataAdapter,
    private readonly internalRoot: string
  ) {}

  async initialize(): Promise<void> {
    await ensureFolder(this.adapter, this.root);
    await this.recoverWrites();
  }

  async list(): Promise<SourceManifest[]> {
    return (await this.inspect()).manifests;
  }

  async inspect(): Promise<{
    manifests: SourceManifest[];
    errors: Array<{ path: string; message: string }>;
  }> {
    await this.initialize();
    const listing = await this.adapter.list(this.root);
    const manifests: SourceManifest[] = [];
    const errors: Array<{ path: string; message: string }> = [];
    for (const path of listing.files.filter((item) => item.endsWith(".json"))) {
      try {
        manifests.push(await this.readPath(path));
      } catch (error) {
        errors.push({ path, message: error instanceof Error ? error.message : String(error) });
      }
    }
    manifests.sort((a, b) => b.original.importedAt.localeCompare(a.original.importedAt));
    return { manifests, errors };
  }

  async findByHash(sourceHash: string): Promise<SourceManifest | null> {
    return (await this.list()).find((manifest) => manifest.sourceHash === sourceHash) ?? null;
  }

  async read(sourceId: string): Promise<SourceManifest> {
    return this.readPath(this.pathFor(sourceId));
  }

  async create(manifest: SourceManifest): Promise<SourceManifest> {
    const path = this.pathFor(manifest.sourceId);
    if (await this.adapter.exists(path)) throw new Error(`Manifest 已存在：${manifest.sourceId}`);
    const value = { ...manifest, schemaVersion: 3 as const, manifestRevision: 1 };
    await atomicWriteText(this.adapter, path, `${JSON.stringify(value, null, 2)}\n`);
    return value;
  }

  async update(
    sourceId: string,
    expectedRevision: number,
    mutate: (current: SourceManifest) => SourceManifest
  ): Promise<SourceManifest> {
    const current = await this.read(sourceId);
    if (current.manifestRevision !== expectedRevision) {
      throw new Error(`MANIFEST_CONFLICT:${sourceId}:${expectedRevision}:${current.manifestRevision}`);
    }
    const next = mutate(structuredClone(current));
    next.schemaVersion = 3;
    next.sourceId = current.sourceId;
    next.sourceHash = current.sourceHash;
    next.manifestRevision = current.manifestRevision + 1;
    const beforeCommit = await this.read(sourceId);
    if (beforeCommit.manifestRevision !== expectedRevision) {
      throw new Error(`MANIFEST_CONFLICT:${sourceId}:${expectedRevision}:${beforeCommit.manifestRevision}`);
    }
    await atomicReplaceText(this.adapter, this.pathFor(sourceId), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  async remove(sourceId: string): Promise<void> {
    const path = this.pathFor(sourceId);
    if (await this.adapter.exists(path)) await this.adapter.remove(path);
  }

  private get root(): string {
    return `${normalizeVaultPath(this.internalRoot)}/manifests`;
  }

  private pathFor(sourceId: string): string {
    assertSafeId(sourceId, "sourceId");
    return `${this.root}/${sourceId}.json`;
  }

  private async readPath(path: string): Promise<SourceManifest> {
    const value = JSON.parse(await this.adapter.read(path)) as unknown;
    return normalizeManifest(value, path);
  }

  private async recoverWrites(): Promise<void> {
    const listing = await this.adapter.list(this.root);
    for (const path of listing.files) {
      if (path.endsWith(".tmp")) {
        await this.adapter.remove(path);
        continue;
      }
      if (!path.endsWith(".prev")) continue;
      const target = path.replace(/\.[^.]+\.prev$/, "");
      if (await this.adapter.exists(target)) await this.adapter.remove(path);
      else await this.adapter.rename(path, target);
    }
  }
}

export class SourceMapStore {
  constructor(
    private readonly adapter: DataAdapter,
    private readonly internalRoot: string
  ) {}

  async initialize(): Promise<void> {
    await ensureFolder(this.adapter, this.root);
  }

  pathFor(sourceId: string, contentHash: string): string {
    assertSafeId(sourceId, "sourceId");
    if (!/^[a-f0-9]{64}$/.test(contentHash)) throw new Error("无效 contentHash");
    return `${this.root}/${sourceId}/${contentHash}.json`;
  }

  async put(
    sourceId: string,
    contentHash: string,
    content: string,
    expectedHash: string
  ): Promise<string> {
    if (sha256(content) !== expectedHash) throw new Error("SOURCE_MAP_HASH_MISMATCH");
    const path = this.pathFor(sourceId, contentHash);
    if (await this.adapter.exists(path)) {
      if (sha256(await this.adapter.read(path)) !== expectedHash) {
        throw new Error(`SOURCE_MAP_CONFLICT:${path}`);
      }
      return path;
    }
    await atomicWriteText(this.adapter, path, content);
    if (sha256(await this.adapter.read(path)) !== expectedHash) {
      await this.adapter.remove(path);
      throw new Error("SOURCE_MAP_HASH_MISMATCH");
    }
    return path;
  }

  async read(path: string, expectedHash: string): Promise<DocumentSourceMap> {
    const normalizedPath = normalizeVaultPath(path);
    if (!normalizedPath.startsWith(`${this.root}/`) || normalizedPath.split("/").includes("..")) {
      throw new Error(`Source Map 路径越界：${path}`);
    }
    const content = await this.adapter.read(normalizedPath);
    if (sha256(content) !== expectedHash) throw new Error(`sourceMapHash 不一致：${path}`);
    const value = JSON.parse(content) as DocumentSourceMap;
    if (value.schemaVersion !== 1 || !Array.isArray(value.entries)) {
      throw new Error(`Source Map 无效：${path}`);
    }
    return value;
  }

  async remove(path: string): Promise<void> {
    if (await this.adapter.exists(path)) await this.adapter.remove(path);
  }

  private get root(): string {
    return `${normalizeVaultPath(this.internalRoot)}/source-maps`;
  }
}

/**
 * Compatibility facade retained for migration code and external tests.
 * New application services depend on the focused stores above.
 */
export class SourceStore {
  readonly objects: ObjectStore;
  readonly manifests: ManifestRepository;
  readonly sourceMaps: SourceMapStore;

  constructor(adapter: DataAdapter, internalRoot: string) {
    this.objects = new ObjectStore(adapter, internalRoot);
    this.manifests = new ManifestRepository(adapter, internalRoot);
    this.sourceMaps = new SourceMapStore(adapter, internalRoot);
  }

  async initialize(): Promise<void> {
    await Promise.all([
      this.objects.initialize(),
      this.manifests.initialize(),
      this.sourceMaps.initialize()
    ]);
  }

  storeObject(sourceHash: string, extension: string, bytes: Uint8Array): Promise<string> {
    return this.objects.put(sourceHash, extension, bytes);
  }

  readObject(manifest: SourceManifest): Promise<Uint8Array> {
    return this.objects.read(manifest);
  }

  listManifests(): Promise<SourceManifest[]> {
    return this.manifests.list();
  }

  findByHash(sourceHash: string): Promise<SourceManifest | null> {
    return this.manifests.findByHash(sourceHash);
  }

  readManifest(sourceId: string): Promise<SourceManifest> {
    return this.manifests.read(sourceId);
  }

  createManifest(manifest: SourceManifest): Promise<SourceManifest> {
    return this.manifests.create(manifest);
  }

  updateManifest(
    sourceId: string,
    expectedRevision: number,
    mutate: (current: SourceManifest) => SourceManifest
  ): Promise<SourceManifest> {
    return this.manifests.update(sourceId, expectedRevision, mutate);
  }

  removeManifest(sourceId: string): Promise<void> {
    return this.manifests.remove(sourceId);
  }
}

export async function ensureFolder(adapter: DataAdapter, folder: string): Promise<void> {
  if (!folder) return;
  const parts = normalizeVaultPath(folder).split("/");
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!(await adapter.exists(current))) await adapter.mkdir(current);
  }
}

export async function atomicWriteText(adapter: DataAdapter, path: string, content: string): Promise<void> {
  await ensureFolder(adapter, path.split("/").slice(0, -1).join("/"));
  const temp = `${path}.${randomUUID()}.tmp`;
  await adapter.write(temp, content);
  if (await adapter.exists(path)) {
    await adapter.remove(temp);
    throw new Error(`PUBLISH_CONFLICT:${path}`);
  }
  await adapter.rename(temp, path);
}

export async function atomicWriteBinary(adapter: DataAdapter, path: string, content: Uint8Array): Promise<void> {
  await ensureFolder(adapter, path.split("/").slice(0, -1).join("/"));
  const temp = `${path}.${randomUUID()}.tmp`;
  await adapter.writeBinary(temp, exactArrayBuffer(content));
  if (await adapter.exists(path)) {
    await adapter.remove(temp);
    throw new Error(`PUBLISH_CONFLICT:${path}`);
  }
  await adapter.rename(temp, path);
}

export async function atomicReplaceText(adapter: DataAdapter, path: string, content: string): Promise<void> {
  await ensureFolder(adapter, path.split("/").slice(0, -1).join("/"));
  const temp = `${path}.${randomUUID()}.tmp`;
  const previous = `${path}.${randomUUID()}.prev`;
  await adapter.write(temp, content);
  let movedPrevious = false;
  try {
    if (await adapter.exists(path)) {
      await adapter.rename(path, previous);
      movedPrevious = true;
    }
    await adapter.rename(temp, path);
    if (movedPrevious && await adapter.exists(previous)) await adapter.remove(previous);
  } catch (error) {
    if (await adapter.exists(temp)) await adapter.remove(temp);
    if (movedPrevious && !(await adapter.exists(path)) && await adapter.exists(previous)) {
      await adapter.rename(previous, path);
    }
    throw error;
  }
}

export function normalizeManifest(value: unknown, path = "manifest"): SourceManifest {
  if (!value || typeof value !== "object") throw new Error(`Manifest 无效：${path}`);
  const input = value as Record<string, any>;
  if (![2, 3].includes(Number(input.schemaVersion))
    || typeof input.sourceId !== "string"
    || !/^[a-zA-Z0-9-]+$/.test(input.sourceId)
    || typeof input.sourceHash !== "string"
    || !/^[a-f0-9]{64}$/.test(input.sourceHash)
    || !input.original
    || typeof input.original.name !== "string"
    || typeof input.original.extension !== "string"
    || typeof input.original.mime !== "string"
    || typeof input.original.size !== "number"
    || typeof input.original.objectPath !== "string"
    || typeof input.original.importedAt !== "string"
    || !input.parse
    || !Array.isArray(input.parse.revisions)
    || !input.ingest
    || !Array.isArray(input.ingest.attempts)) {
    throw new Error(`Manifest 无效：${path}`);
  }
  const extension = String(input.original?.extension ?? "").toLocaleLowerCase();
  const sourceKind = kindForExtension(extension);
  const source = (input.source ?? {}) as Record<string, unknown>;
  const capture = normalizeCaptureMetadata(source.capture);
  const metadata = normalizeSourceMetadata(source.metadata);
  return {
    ...input,
    schemaVersion: 3,
    source: {
      kind: isSourceKind(source.kind) ? source.kind : sourceKind,
      ...(typeof source.uri === "string" ? { uri: source.uri } : {}),
      ...(typeof source.requestedUri === "string" ? { requestedUri: source.requestedUri } : {}),
      ...(typeof source.capturedAt === "string"
        ? { capturedAt: source.capturedAt }
        : input.schemaVersion === 2
          ? { capturedAt: input.original?.importedAt }
          : {}),
      acquiredBy: typeof source.acquiredBy === "string" ? source.acquiredBy : "legacy-v2",
      ...(metadata ? { metadata } : {}),
      ...(capture ? { capture } : {})
    },
    parse: {
      ...input.parse,
      revisions: (input.parse?.revisions ?? []).map((revision: Record<string, unknown>) => ({
        ...revision,
        artifactSchemaVersion: revision.artifactSchemaVersion === 3
          ? 3
          : revision.artifactSchemaVersion === 2 ? 2 : 1
      })),
      attempts: input.parse?.attempts ?? []
    }
  } as SourceManifest;
}

function normalizeCaptureMetadata(value: unknown): SourceManifest["source"]["capture"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const capture = value as Record<string, unknown>;
  const output: NonNullable<SourceManifest["source"]["capture"]> = {
    ...(typeof capture.status === "number" ? { status: capture.status } : {}),
    ...(typeof capture.contentType === "string" ? { contentType: capture.contentType } : {}),
    ...(typeof capture.etag === "string" ? { etag: capture.etag } : {}),
    ...(typeof capture.lastModified === "string" ? { lastModified: capture.lastModified } : {}),
    ...(capture.platform === "bilibili" || capture.platform === "douyin" ? { platform: capture.platform } : {}),
    ...(typeof capture.videoId === "string" ? { videoId: capture.videoId } : {}),
    ...(typeof capture.durationMs === "number" && Number.isFinite(capture.durationMs)
      ? { durationMs: capture.durationMs }
      : {})
  };
  return Object.keys(output).length > 0 ? output : undefined;
}

function normalizeSourceMetadata(value: unknown): SourceManifest["source"]["metadata"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const output: Record<string, string | string[]> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string") output[key] = item;
    else if (Array.isArray(item) && item.every((entry) => typeof entry === "string")) {
      output[key] = item.slice();
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function kindForExtension(extension: string): SourceKind {
  if (extension === "md" || extension === "markdown") return "markdown";
  if (extension === "txt") return "text";
  if (extension === "pdf") return "pdf";
  if (["mp3", "m4a", "wav", "ogg", "oga", "flac", "mpga", "mpeg"].includes(extension)) return "audio";
  if (["mp4", "mov", "webm", "mkv", "avi", "bili-caption"].includes(extension)) return "video";
  return "unknown";
}

function isSourceKind(value: unknown): value is SourceKind {
  return ["markdown", "text", "pdf", "web", "audio", "video", "unknown"].includes(String(value));
}

function assertSafeId(value: string, label: string): void {
  if (!/^[a-zA-Z0-9-]+$/.test(value)) throw new Error(`无效 ${label}：${value}`);
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
