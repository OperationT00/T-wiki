import yaml from "js-yaml";
import type { DataAdapter } from "obsidian";

import { normalizeVaultPath, sha256 } from "../core/wiki-core";
import type {
  DocumentSourceMap,
  ParseIssue,
  ParseRevision,
  RawVerification,
  SourceManifest
} from "../types";
import type { BuiltRawArtifact } from "../parsing/artifact-builder";
import { BLOCK_MARKER } from "../parsing/block-indexer";
import { ParserError } from "../parsing/parser-types";
import { errorIssue } from "../parsing/pipeline-errors";
import type { PublishedRawArtifact } from "../parsing/ports";
import { atomicWriteBinary, atomicWriteText, SourceMapStore } from "./source-store";

const RAW_FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

export class RawPublisher {
  constructor(
    private readonly adapter: DataAdapter,
    private readonly rawRoot: string,
    private readonly rawWriter: (path: string, content: string) => Promise<void> =
      (path, content) => atomicWriteText(adapter, path, content)
  ) {}

  async initialize(): Promise<void> {}

  async publish(
    manifest: SourceManifest,
    revision: number,
    built: BuiltRawArtifact
  ): Promise<PublishedRawArtifact> {
    const folder = manifest.source.kind === "pdf"
      ? `${this.rawRoot}/documents`
      : `${this.rawRoot}/articles`;
    const basename = canonicalBasename(manifest.original.name);
    const revisionSuffix = revision > 1 ? `--r${revision}` : "";
    const rawPath = normalizeVaultPath(
      `${folder}/${basename}--${manifest.sourceHash.slice(0, 8)}${revisionSuffix}.md`
    );
    const rawExisted = await this.adapter.exists(rawPath);
    const createdAssets: string[] = [];
    try {
      for (const asset of built.assets) {
        if (await this.adapter.exists(asset.path)) {
          const existing = new Uint8Array(await this.adapter.readBinary(asset.path));
          if (sha256(existing) !== asset.hash) throw new Error(`ASSET_CONFLICT:${asset.path}`);
          continue;
        }
        await atomicWriteBinary(this.adapter, asset.path, asset.bytes);
        const written = new Uint8Array(await this.adapter.readBinary(asset.path));
        if (sha256(written) !== asset.hash) {
          await this.adapter.remove(asset.path);
          throw new Error(`ASSET_HASH_MISMATCH:${asset.path}`);
        }
        createdAssets.push(asset.path);
      }
      if (rawExisted) {
        const existing = await this.adapter.read(rawPath);
        if (sha256(existing) !== built.artifactHash) {
          throw new ParserError("PUBLISH_CONFLICT", `raw 目标已存在且内容不同：${rawPath}`);
        }
        return {
          rawPath,
          createdRaw: false,
          createdAssetPaths: createdAssets
        };
      }
      await this.rawWriter(rawPath, built.artifact);
      const written = await this.adapter.read(rawPath);
      if (sha256(written) !== built.artifactHash) {
        await this.adapter.remove(rawPath);
        throw new ParserError("PUBLISH_HASH_MISMATCH", `raw 发布后哈希不一致：${rawPath}`);
      }
      return {
        rawPath,
        createdRaw: true,
        createdAssetPaths: createdAssets
      };
    } catch (error) {
      for (const path of createdAssets) {
        if (await this.adapter.exists(path)) await this.adapter.remove(path);
      }
      throw error;
    }
  }

  async rollback(published: PublishedRawArtifact): Promise<void> {
    if (published.createdRaw && await this.adapter.exists(published.rawPath)) {
      await this.adapter.remove(published.rawPath);
    }
    for (const path of published.createdAssetPaths) {
      if (await this.adapter.exists(path)) await this.adapter.remove(path);
    }
  }
}

export class RawVerifier {
  constructor(
    private readonly adapter: DataAdapter,
    private readonly rawRoot: string,
    private readonly sourceMaps: SourceMapStore
  ) {}

  async readAndVerifyRevision(
    manifest: SourceManifest,
    revisionNumber: number
  ): Promise<{ body: string; sourceMap?: DocumentSourceMap }> {
    const revision = manifest.parse.revisions.find((item) => item.revision === revisionNumber);
    if (!revision) throw new Error(`解析 revision 不存在：${revisionNumber}`);
    const normalizedRawPath = normalizeVaultPath(revision.rawPath);
    if (!normalizedRawPath.startsWith(`${normalizeVaultPath(this.rawRoot)}/`)
      || normalizedRawPath.split("/").includes("..")) {
      throw new Error(`raw 路径越界：${revision.rawPath}`);
    }
    if (!(await this.adapter.exists(revision.rawPath))) throw new Error(`raw 文件不存在：${revision.rawPath}`);
    const artifact = await this.adapter.read(revision.rawPath);
    if (sha256(artifact) !== revision.artifactHash) {
      throw new Error(`raw artifactHash 不一致：${revision.rawPath}`);
    }
    const match = artifact.match(RAW_FRONTMATTER);
    if (!match?.[1]) throw new Error(`raw frontmatter 无效：${revision.rawPath}`);
    const frontmatter = (yaml.load(match[1]) as Record<string, unknown>) ?? {};
    if (String(frontmatter.kind) !== "raw_document") throw new Error("raw kind 无效");
    if (String(frontmatter.source_id) !== manifest.sourceId) throw new Error("raw source_id 不一致");
    if (String(frontmatter.source_hash) !== manifest.sourceHash) throw new Error("raw source_hash 不一致");
    if (String(frontmatter.parser_id) !== revision.parserId) throw new Error("raw parser_id 不一致");
    if (String(frontmatter.parser_version) !== revision.parserVersion) {
      throw new Error("raw parser_version 不一致");
    }
    const body = artifact.slice(match[0].length);
    if (sha256(body) !== revision.contentHash) throw new Error("raw contentHash 不一致");
    if (String(frontmatter.content_hash) !== revision.contentHash) {
      throw new Error("raw frontmatter content_hash 不一致");
    }
    if (revision.artifactSchemaVersion === 1) {
      validatePageMarkers(body, revision.quality.pageCount);
      return { body };
    }
    if (Number(frontmatter.schema_version) !== revision.artifactSchemaVersion) {
      throw new Error("raw schema_version 不一致");
    }
    if (String(frontmatter.source_kind) !== manifest.source.kind) throw new Error("raw source_kind 不一致");
    let sourceMap: DocumentSourceMap | undefined;
    if (revision.artifactSchemaVersion === 2) {
      validatePageMarkers(body, revision.quality.pageCount);
      if (!revision.sourceMapPath || !revision.sourceMapHash) throw new Error("revision 缺少 Source Map");
      sourceMap = await this.sourceMaps.read(revision.sourceMapPath, revision.sourceMapHash);
      validateSourceMap(manifest, revision, body, sourceMap);
    } else {
      validateCleanBody(body);
      if (revision.sourceMapPath || revision.sourceMapHash) {
        throw new Error("raw schema v3 不应包含 Source Map");
      }
    }
    for (const asset of revision.assets ?? []) {
      const assetPath = normalizeVaultPath(asset.path);
      if (!assetPath.startsWith(`${normalizeVaultPath(this.rawRoot)}/assets/${manifest.sourceId}/`)
        || assetPath.split("/").includes("..")) {
        throw new Error(`资源路径越界：${asset.path}`);
      }
      const bytes = new Uint8Array(await this.adapter.readBinary(assetPath));
      if (sha256(bytes) !== asset.hash) throw new Error(`资源哈希不一致：${asset.path}`);
    }
    return { body, sourceMap };
  }

  async verifyAll(manifests: SourceManifest[]): Promise<RawVerification[]> {
    const results: RawVerification[] = [];
    const managedPaths = new Set<string>();
    for (const manifest of manifests) {
      const issues: ParseIssue[] = [];
      const current = currentRevision(manifest);
      if (manifest.parse.status === "parsed" && !current) {
        issues.push(errorIssue("RAW_REVISION_MISSING", "Manifest 没有当前解析 revision"));
      }
      for (const revision of manifest.parse.revisions) {
        managedPaths.add(revision.rawPath);
        try {
          await this.readAndVerifyRevision(manifest, revision.revision);
        } catch (error) {
          issues.push(errorIssue(
            "RAW_INTEGRITY_FAILED",
            `revision ${revision.revision}：${error instanceof Error ? error.message : String(error)}`
          ));
        }
      }
      results.push({ sourceId: manifest.sourceId, ok: issues.length === 0, issues });
    }
    for (const path of await listFilesRecursive(this.adapter, this.rawRoot)) {
      if (path.startsWith(`${this.rawRoot}/assets/`) || managedPaths.has(path)) continue;
      results.push({
        sourceId: `unmanaged:${path}`,
        ok: false,
        issues: [errorIssue("UNMANAGED_RAW_FILE", `raw 中存在未受 manifest 管理的文件：${path}`)]
      });
    }
    return results;
  }
}

function validateCleanBody(body: string): void {
  let fence: string | null = null;
  for (const line of body.split("\n")) {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/)?.[1];
    if (fenceMatch) {
      const marker = fenceMatch[0]!;
      if (!fence) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence) continue;
    if (BLOCK_MARKER.test(line.trim())
      || /^<!--\s*llm-wiki:page=\d+(?:\s+source=\w+)?\s*-->$/.test(line.trim())) {
      throw new Error("raw schema v3 正文包含已停用的来源 marker");
    }
  }
}

function validatePageMarkers(body: string, expectedPageCount: number | undefined): void {
  if (expectedPageCount === undefined) return;
  const pages: number[] = [];
  let fence: string | null = null;
  for (const line of body.split("\n")) {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/)?.[1];
    if (fenceMatch) {
      const marker = fenceMatch[0]!;
      if (!fence) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence) continue;
    const match = line.trim().match(/^<!--\s*llm-wiki:page=(\d+)(?:\s+source=\w+)?\s*-->$/);
    if (match?.[1]) pages.push(Number(match[1]));
  }
  if (pages.length !== expectedPageCount || pages.some((page, index) => page !== index + 1)) {
    throw new Error("raw PDF 页标记数量或顺序不一致");
  }
}

function validateSourceMap(
  manifest: SourceManifest,
  revision: ParseRevision,
  body: string,
  sourceMap: DocumentSourceMap
): void {
  if (sourceMap.sourceId !== manifest.sourceId) throw new Error("Source Map sourceId 不一致");
  if (sourceMap.sourceHash !== manifest.sourceHash) throw new Error("Source Map sourceHash 不一致");
  if (sourceMap.contentHash !== revision.contentHash) throw new Error("Source Map contentHash 不一致");
  const markers = collectBlockMarkers(body);
  const ids = sourceMap.entries.map((entry) => entry.blockId);
  if (new Set(markers).size !== markers.length) throw new Error("raw block marker 重复");
  if (new Set(ids).size !== ids.length) throw new Error("Source Map blockId 重复");
  if (markers.length !== ids.length || markers.some((marker, index) => marker !== ids[index])) {
    throw new Error("raw block marker 与 Source Map 不一致");
  }
  const lines = body.replace(/\n$/, "").split("\n");
  for (const entry of sourceMap.entries) {
    if (entry.raw.startLine < 2 || entry.raw.endLine < entry.raw.startLine || entry.raw.endLine > lines.length) {
      throw new Error(`Source Map raw 行号无效：${entry.blockId}`);
    }
    if (lines[entry.raw.startLine - 2]?.trim() !== `<!-- llm-wiki:block=${entry.blockId} -->`) {
      throw new Error(`Source Map marker 位置无效：${entry.blockId}`);
    }
  }
}

function collectBlockMarkers(body: string): string[] {
  const markers: string[] = [];
  let fence: string | null = null;
  for (const line of body.split("\n")) {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/)?.[1];
    if (fenceMatch) {
      const marker = fenceMatch[0]!;
      if (!fence) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence) continue;
    const match = line.trim().match(BLOCK_MARKER);
    if (match?.[1]) markers.push(match[1]);
  }
  return markers;
}

export function currentRevision(manifest: SourceManifest): ParseRevision | undefined {
  return manifest.parse.revisions.find((revision) => revision.revision === manifest.parse.currentRevision);
}

export function canonicalBasename(name: string): string {
  const withoutExtension = name.replace(/\.[^.]+$/, "");
  return withoutExtension
    .normalize("NFC")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .toLocaleLowerCase()
    .slice(0, 100) || "document";
}

async function listFilesRecursive(adapter: DataAdapter, root: string): Promise<string[]> {
  if (!(await adapter.exists(root))) return [];
  const listing = await adapter.list(root);
  const nested = await Promise.all(listing.folders.map((folder) => listFilesRecursive(adapter, folder)));
  return [...listing.files, ...nested.flat()];
}
