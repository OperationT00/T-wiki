import { createHash, randomUUID } from "node:crypto";

import { sanitizeSourceUri } from "../parsing/source-uri";
import { detectSource } from "../parsing/parser-registry";
import { ParserError, sourceBodyFromBytes, type SourceBody } from "../parsing/parser-types";
import type { ManifestRepositoryPort, ObjectStorePort } from "../parsing/ports";
import type { SourceKind, SourceManifest, SourceMetadata, WikiConfig } from "../types";

export interface IntakeProvenance {
  kind?: SourceKind;
  uri?: string;
  requestedUri?: string;
  capturedAt?: string;
  acquiredBy?: string;
  metadata?: SourceMetadata;
  capture?: SourceManifest["source"]["capture"];
  /** Keep the immutable source queued until the UI grants remote processing consent. */
  deferParse?: boolean;
}

export interface LegacyIntakeState {
  importedAt?: string;
  status?: string;
  sourcePage?: string | null;
}

export class IntakeService {
  constructor(
    private readonly objects: ObjectStorePort,
    private readonly manifests: ManifestRepositoryPort,
    private readonly config: WikiConfig
  ) {}

  async initialize(): Promise<void> {
    await Promise.all([this.objects.initialize(), this.manifests.initialize()]);
  }

  async intake(
    name: string,
    input: Uint8Array | SourceBody,
    provenance: IntakeProvenance = {}
  ): Promise<{ manifest: SourceManifest; duplicate: boolean }> {
    await this.initialize();
    const source = input instanceof Uint8Array ? sourceBodyFromBytes(input) : input;
    const detected = detectSource(name, await source.readHead(64));
    const limit = detected.kind === "audio" || detected.kind === "video"
      ? this.config.parsing.maxMediaImportBytes
      : this.config.parsing.maxImportBytes;
    if (source.size !== undefined && source.size > limit) {
      throw new ParserError(
        "FILE_TOO_LARGE",
        `${name} 超过 ${Math.round(limit / 1024 / 1024)} MB`
      );
    }
    const { hash: sourceHash, size } = await hashSource(source, limit);
    const duplicate = await this.manifests.findByHash(sourceHash);
    if (duplicate) {
      const safeUri = sanitizeSourceUri(provenance.uri);
      const safeRequestedUri = sanitizeSourceUri(provenance.requestedUri);
      if ((safeUri && !duplicate.source.uri)
        || (safeRequestedUri && !duplicate.source.requestedUri)
        || (provenance.capturedAt && !duplicate.source.capturedAt)
        || (provenance.capture && !duplicate.source.capture)
        || (provenance.metadata && !duplicate.source.metadata)
        || (provenance.kind && duplicate.source.kind === "unknown")) {
        const updated = await this.manifests.update(
          duplicate.sourceId,
          duplicate.manifestRevision,
          (current) => {
            if (safeUri && !current.source.uri) current.source.uri = safeUri;
            if (safeRequestedUri && !current.source.requestedUri) {
              current.source.requestedUri = safeRequestedUri;
            }
            if (provenance.capturedAt && !current.source.capturedAt) {
              current.source.capturedAt = provenance.capturedAt;
            }
            if (provenance.kind && current.source.kind === "unknown") {
              current.source.kind = provenance.kind;
            }
            if (provenance.capture && !current.source.capture) {
              current.source.capture = structuredClone(provenance.capture);
            }
            if (provenance.metadata && !current.source.metadata) {
              current.source.metadata = structuredClone(provenance.metadata);
            }
            return current;
          }
        );
        return { manifest: updated, duplicate: true };
      }
      return { manifest: duplicate, duplicate: true };
    }
    const objectPath = this.objects.putBody
      ? await this.objects.putBody(sourceHash, detected.extension, source)
      : await this.objects.put(sourceHash, detected.extension, await source.readAll(limit));
    const importedAt = provenance.capturedAt ?? new Date().toISOString();
    const manifest = await this.manifests.create({
      schemaVersion: 3,
      manifestRevision: 0,
      sourceId: randomUUID(),
      sourceHash,
      source: {
        kind: provenance.kind ?? detected.kind,
        uri: sanitizeSourceUri(provenance.uri),
        requestedUri: sanitizeSourceUri(provenance.requestedUri),
        capturedAt: provenance.capturedAt,
        acquiredBy: provenance.acquiredBy ?? "file-picker",
        metadata: provenance.metadata ? structuredClone(provenance.metadata) : undefined,
        capture: provenance.capture ? structuredClone(provenance.capture) : undefined
      },
      original: {
        name,
        extension: detected.extension,
        mime: detected.mime,
        size,
        objectPath,
        importedAt
      },
      parse: {
        status: "queued",
        revisions: [],
        attempts: []
      },
      ingest: {
        status: "not_started",
        attempts: []
      }
    });
    return { manifest, duplicate: false };
  }
}

async function hashSource(source: SourceBody, maxBytes: number): Promise<{ hash: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of source.openStream()) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new ParserError("FILE_TOO_LARGE", `Source exceeds ${maxBytes} bytes`);
    hash.update(chunk);
  }
  return { hash: hash.digest("hex"), size };
}
