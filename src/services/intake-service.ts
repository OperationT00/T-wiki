import { randomUUID } from "node:crypto";

import { sha256 } from "../core/wiki-core";
import { sanitizeSourceUri } from "../parsing/source-uri";
import { detectSource } from "../parsing/parser-registry";
import { ParserError } from "../parsing/parser-types";
import type { ManifestRepositoryPort, ObjectStorePort } from "../parsing/ports";
import type { SourceKind, SourceManifest, WikiConfig } from "../types";

export interface IntakeProvenance {
  kind?: SourceKind;
  uri?: string;
  requestedUri?: string;
  capturedAt?: string;
  acquiredBy?: string;
  capture?: SourceManifest["source"]["capture"];
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
    bytes: Uint8Array,
    provenance: IntakeProvenance = {}
  ): Promise<{ manifest: SourceManifest; duplicate: boolean }> {
    await this.initialize();
    if (bytes.byteLength > this.config.parsing.maxImportBytes) {
      throw new ParserError(
        "FILE_TOO_LARGE",
        `${name} 超过 ${Math.round(this.config.parsing.maxImportBytes / 1024 / 1024)} MB`
      );
    }
    const detected = detectSource(name, bytes);
    const sourceHash = sha256(bytes);
    const duplicate = await this.manifests.findByHash(sourceHash);
    if (duplicate) {
      const safeUri = sanitizeSourceUri(provenance.uri);
      const safeRequestedUri = sanitizeSourceUri(provenance.requestedUri);
      if ((safeUri && !duplicate.source.uri)
        || (safeRequestedUri && !duplicate.source.requestedUri)
        || (provenance.capturedAt && !duplicate.source.capturedAt)
        || (provenance.capture && !duplicate.source.capture)
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
            return current;
          }
        );
        return { manifest: updated, duplicate: true };
      }
      return { manifest: duplicate, duplicate: true };
    }
    const objectPath = await this.objects.put(sourceHash, detected.extension, bytes);
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
        capture: provenance.capture ? structuredClone(provenance.capture) : undefined
      },
      original: {
        name,
        extension: detected.extension,
        mime: detected.mime,
        size: bytes.byteLength,
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
