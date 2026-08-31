import { Buffer } from "node:buffer";

import type { ParsePayload, SourceMetadata, SourceSpan } from "../../types";
import { normalizeMarkdownBody } from "../normalizer";
import {
  parseInputSize,
  parseInputSource,
  ParserError,
  type DocumentParser,
  type ParseContext,
  type ParseInput,
  type ProbeResult
} from "../parser-types";

interface EditableBundle {
  schemaVersion: 1;
  markdown: string;
  metadata: SourceMetadata;
  assets: Array<{
    assetId: string;
    mime: string;
    data: string;
    source?: SourceSpan;
  }>;
}

/**
 * Immutable, retry-safe container used only when an editable Markdown snapshot
 * owns attachments. It prevents a derived Raw revision from depending on the
 * lifetime of another source's raw/assets directory.
 */
export class EditableDocumentBundleParser implements DocumentParser {
  readonly descriptor = {
    id: "editable-document-bundle",
    version: "1.0.0",
    execution: "local",
    supportedKinds: ["markdown"],
    capabilities: { sourceMap: false, assets: true, resumable: false }
  } as const;

  validateOptions(_options: Readonly<Record<string, unknown>>): void {}

  probe(input: ParseInput): ProbeResult {
    return {
      supported: input.extension === "twdoc",
      confidence: input.extension === "twdoc" ? 1 : 0,
      detectedMime: "application/vnd.t-wiki.editable-document+json"
    };
  }

  async parse(input: ParseInput, context: ParseContext): Promise<ParsePayload> {
    const size = parseInputSize(input);
    const bytes = await parseInputSource(input).readAll(size);
    context.reportProgress({
      phase: "parsing",
      completed: 0,
      total: Math.max(1, size),
      unit: "byte",
      message: "正在读取可编辑文稿快照"
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new ParserError("EDITABLE_BUNDLE_INVALID", "可编辑文稿快照 JSON 无效");
    }
    const bundle = validateBundle(parsed);
    const assets = bundle.assets.map((asset) => ({
      assetId: asset.assetId,
      mime: asset.mime,
      bytes: new Uint8Array(Buffer.from(asset.data, "base64")),
      source: asset.source ?? {}
    }));
    context.reportProgress({
      phase: "parsing",
      completed: Math.max(1, size),
      total: Math.max(1, size),
      unit: "byte",
      message: "可编辑文稿快照解析完成"
    });
    return {
      schemaVersion: 2,
      markdown: normalizeMarkdownBody(bundle.markdown),
      metadata: bundle.metadata,
      assets,
      issues: []
    };
  }
}

function validateBundle(input: unknown): EditableBundle {
  if (!input || typeof input !== "object") throw new ParserError("EDITABLE_BUNDLE_INVALID", "快照必须是对象");
  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== 1 || typeof value.markdown !== "string"
    || !value.metadata || typeof value.metadata !== "object" || Array.isArray(value.metadata)
    || !Array.isArray(value.assets)) {
    throw new ParserError("EDITABLE_BUNDLE_INVALID", "可编辑文稿快照 Schema 无效");
  }
  const ids = new Set<string>();
  const assets = value.assets.map((item) => {
    if (!item || typeof item !== "object") throw new ParserError("EDITABLE_BUNDLE_INVALID", "附件记录无效");
    const asset = item as Record<string, unknown>;
    if (typeof asset.assetId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(asset.assetId)
      || ids.has(asset.assetId)
      || typeof asset.mime !== "string" || !/^image\/(?:png|jpeg|webp|gif|svg\+xml)$/.test(asset.mime)
      || typeof asset.data !== "string" || !isCanonicalBase64(asset.data)) {
      throw new ParserError("EDITABLE_BUNDLE_INVALID", "附件身份、MIME 或编码无效");
    }
    ids.add(asset.assetId);
    return {
      assetId: asset.assetId,
      mime: asset.mime,
      data: asset.data,
      ...(asset.source && typeof asset.source === "object" && !Array.isArray(asset.source)
        ? { source: asset.source as SourceSpan }
        : {})
    };
  });
  return {
    schemaVersion: 1,
    markdown: value.markdown,
    metadata: value.metadata as SourceMetadata,
    assets
  };
}

function isCanonicalBase64(value: string): boolean {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try {
    return Buffer.from(value, "base64").toString("base64") === value;
  } catch {
    return false;
  }
}
