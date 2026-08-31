import type { SourceSpan } from "../types";

export type EditableDocumentKind = "note" | "raw_revision";
export type EditableRevisionMode = "supplement" | "correction" | "rewrite";

export interface EditableRawBase {
  sourceId: string;
  parseRevision: number;
  rawPath: string;
  contentHash: string;
  assets?: EditableDocumentAsset[];
}

export interface EditableDocumentAsset {
  assetId: string;
  mime: string;
  /** Mutable workspace copy, always constrained to notes/t-wiki/assets/<documentId>/. */
  path: string;
  hash: string;
  source?: SourceSpan;
  /** Reference as it appeared in the verified base Raw body. */
  baseReference?: string;
}

export interface EditablePublishedSnapshot {
  contentHash: string;
  sourceId: string;
  sourceHash: string;
  rawPath: string;
  publishedAt: string;
}

export interface EditableAbsorption {
  contentHash: string;
  operationId: string;
  absorbedAt: string;
}

/**
 * Metadata for a user-owned mutable Markdown file. Body content remains in the
 * Vault and is never duplicated in this store.
 */
export interface EditableDocumentRecord {
  version: 1;
  documentId: string;
  kind: EditableDocumentKind;
  path: string;
  title: string;
  createdAt: string;
  mode?: EditableRevisionMode;
  base?: EditableRawBase;
  lastPublished?: EditablePublishedSnapshot;
  lastAbsorbed?: EditableAbsorption;
}

export type EditableDocumentStatus =
  | "missing"
  | "draft"
  | "dirty"
  | "published"
  | "absorbed";

export interface EditableDocumentView {
  record: EditableDocumentRecord;
  /** Current deterministic title: frontmatter → first H1 → filename → creation title. */
  title?: string;
  currentHash?: string;
  status: EditableDocumentStatus;
  publicationCount?: number;
  baseChanged?: boolean;
}

export interface EditablePublicationHistoryItem {
  sourceId: string;
  sourceHash: string;
  snapshotContentHash: string;
  rawPath: string;
  publishedAt: string;
  ingestStatus: "not_started" | "planning" | "awaiting_review" | "ingested" | "ingest_failed";
  operationId?: string;
  assetCount: number;
}

export interface EditableCurrentSnapshot {
  contentHash: string;
  title: string;
  canonicalMarkdown: string;
  assets: Array<{ assetId: string; hash: string; mime: string }>;
}

export interface EditableRebasePreview {
  documentId: string;
  oldBase: EditableRawBase;
  newBase: EditableRawBase;
  merged: string;
  conflicts: Array<{
    conflictId: string;
    startLine: number;
    endLine: number;
    base: string;
    user: string;
    upstream: string;
  }>;
}

export interface DiffLine {
  type: "context" | "add" | "remove";
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface TextDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface TextDiff {
  beforeHash: string;
  afterHash: string;
  addedLines: number;
  removedLines: number;
  hunks: TextDiffHunk[];
  truncated: boolean;
  assetChanges?: {
    added: number;
    removed: number;
    changed: number;
  };
}
