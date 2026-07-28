import yaml from "js-yaml";

import { sha256 } from "../core/wiki-core";
import type {
  ParsePayload,
  ParseQuality,
  PublishedAsset,
  SourceManifest
} from "../types";
import { assessQuality, normalizeMarkdownBody } from "./normalizer";
import type { ParserDescriptor } from "./parser-types";
import { indexMarkdownBlocks } from "./block-indexer";
import { sanitizeSourceUri } from "./source-uri";

export interface BuiltRawArtifact {
  artifactSchemaVersion: 3;
  body: string;
  artifact: string;
  contentHash: string;
  artifactHash: string;
  assets: Array<PublishedAsset & { bytes: Uint8Array }>;
  quality: ParseQuality;
}

export class ArtifactBuilder {
  constructor(private readonly rawRoot = "raw") {}

  build(
    manifest: SourceManifest,
    parser: ParserDescriptor,
    payload: ParsePayload,
    maxOutputBytes: number
  ): BuiltRawArtifact {
    const assets = buildAssets(this.rawRoot, manifest, payload);
    const normalized = normalizeMarkdownBody(rewriteAssetReferences(payload.markdown, assets, this.rawRoot));
    // Block analysis is retained only for the quality statistic. New raw schema
    // v3 deliberately publishes the normalized Markdown without inline block
    // or page markers; block-level provenance is postponed.
    const indexed = indexMarkdownBlocks(normalized, {
      kind: manifest.source.kind,
      sourceUri: sanitizeSourceUri(manifest.source.uri),
      hints: payload.provenanceHints
    });
    const contentHash = sha256(normalized);
    const quality = assessQuality(payload, normalized, { maxOutputBytes }, indexed.entries.length);
    const frontmatter = rawFrontmatter(manifest, parser, payload, contentHash);
    const header = yaml.dump(frontmatter, {
      lineWidth: -1,
      noRefs: true,
      sortKeys: false,
      quotingType: "\""
    }).trimEnd();
    const artifact = `---\n${header}\n---\n${normalized}`;
    return {
      artifactSchemaVersion: 3,
      body: normalized,
      artifact,
      contentHash,
      artifactHash: sha256(artifact),
      assets,
      quality
    };
  }
}

function buildAssets(
  rawRoot: string,
  manifest: SourceManifest,
  payload: ParsePayload
): Array<PublishedAsset & { bytes: Uint8Array }> {
  const ids = new Set<string>();
  return payload.assets.map((asset) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(asset.assetId)) {
      throw new Error(`无效 assetId：${asset.assetId}`);
    }
    if (ids.has(asset.assetId)) throw new Error(`重复 assetId：${asset.assetId}`);
    ids.add(asset.assetId);
    const extension = extensionForMime(asset.mime);
    return {
      assetId: asset.assetId,
      mime: asset.mime,
      path: `${rawRoot.replace(/\/+$/, "")}/assets/${manifest.sourceId}/${asset.assetId}.${extension}`,
      hash: sha256(asset.bytes),
      bytes: asset.bytes
    };
  });
}

function rewriteAssetReferences(
  markdown: string,
  assets: Array<PublishedAsset & { bytes: Uint8Array }>,
  rawRoot: string
): string {
  const prefix = `${rawRoot.replace(/\/+$/, "")}/`;
  const byId = new Map(assets.map((asset) => [
    asset.assetId,
    asset.path.startsWith(prefix) ? `../${asset.path.slice(prefix.length)}` : asset.path
  ]));
  return markdown.replace(/llm-wiki-asset:([a-zA-Z0-9_-]+)/g, (_match, assetId: string) => {
    const path = byId.get(assetId);
    if (!path) throw new Error(`Markdown 引用了未提供的资源：${assetId}`);
    return path;
  });
}

function extensionForMime(mime: string): string {
  const extensions: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/svg+xml": "svg"
  };
  const extension = extensions[mime.toLocaleLowerCase()];
  if (!extension) throw new Error(`不支持的资源 MIME：${mime}`);
  return extension;
}

function rawFrontmatter(
  manifest: SourceManifest,
  parser: ParserDescriptor,
  payload: ParsePayload,
  contentHash: string
): Record<string, unknown> {
  const output: Record<string, unknown> = {
    schema_version: 3,
    kind: "raw_document",
    source_id: manifest.sourceId,
    source_kind: manifest.source.kind,
    source_hash: manifest.sourceHash,
    content_hash: contentHash,
    original_name: manifest.original.name,
    original_mime: manifest.original.mime,
    parser_id: parser.id,
    parser_version: parser.version
  };
  const safeUri = sanitizeSourceUri(manifest.source.uri ?? payload.metadata.url ?? payload.metadata.source);
  if (safeUri) output.source_uri = safeUri;
  if (manifest.source.capturedAt) output.captured_at = manifest.source.capturedAt;
  for (const key of ["title", "author", "published", "created", "description", "tags"] as const) {
    const value = payload.metadata[key];
    if (value !== undefined) output[key] = value;
  }
  if (payload.stats?.pageCount !== undefined) output.page_count = payload.stats.pageCount;
  if (payload.issues.length > 0) output.parse_warnings = payload.issues.map((warning) => warning.code);
  return output;
}
