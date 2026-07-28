import type { BuiltRawArtifact } from "./artifact-builder";
import type {
  DocumentSourceMap,
  RawVerification,
  SourceManifest
} from "../types";

export interface ObjectStorePort {
  initialize(): Promise<void>;
  put(sourceHash: string, extension: string, bytes: Uint8Array): Promise<string>;
  read(manifest: SourceManifest): Promise<Uint8Array>;
}

export interface ManifestRepositoryPort {
  initialize(): Promise<void>;
  list(): Promise<SourceManifest[]>;
  findByHash(sourceHash: string): Promise<SourceManifest | null>;
  read(sourceId: string): Promise<SourceManifest>;
  create(manifest: SourceManifest): Promise<SourceManifest>;
  update(
    sourceId: string,
    expectedRevision: number,
    mutate: (current: SourceManifest) => SourceManifest
  ): Promise<SourceManifest>;
  remove(sourceId: string): Promise<void>;
}

export interface RawPublisherPort {
  initialize(): Promise<void>;
  publish(
    manifest: SourceManifest,
    revision: number,
    built: BuiltRawArtifact
  ): Promise<PublishedRawArtifact>;
  rollback(published: PublishedRawArtifact): Promise<void>;
}

export interface PublishedRawArtifact {
  rawPath: string;
  createdRaw: boolean;
  createdAssetPaths: string[];
}

export interface RawVerifierPort {
  readAndVerifyRevision(
    manifest: SourceManifest,
    revisionNumber: number
  ): Promise<{ body: string; sourceMap?: DocumentSourceMap }>;
  verifyAll(manifests: SourceManifest[]): Promise<RawVerification[]>;
}
