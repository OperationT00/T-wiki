import { randomUUID } from "node:crypto";

import { KeyedLock } from "../parsing/keyed-lock";
import { interruptedError, toPipelineError } from "../parsing/pipeline-errors";
import type { ManifestRepositoryPort, RawVerifierPort } from "../parsing/ports";
import type {
  IngestInput,
  IngestCoverageReport,
  IngestStatus,
  PipelineError,
  SourceManifest
} from "../types";
import { currentRevision } from "./raw-artifacts";

export class IngestPreparationService {
  constructor(
    private readonly manifests: ManifestRepositoryPort,
    private readonly verifier: RawVerifierPort,
    private readonly lock = new KeyedLock()
  ) {}

  async initialize(): Promise<void> {
    await this.manifests.initialize();
    for (const manifest of await this.manifests.list()) {
      if (manifest.ingest.status !== "planning" && manifest.ingest.status !== "awaiting_review") continue;
      await this.manifests.update(manifest.sourceId, manifest.manifestRevision, (current) => {
        current.ingest.status = "ingest_failed";
        const active = [...current.ingest.attempts].reverse().find((attempt) =>
          attempt.status === "planning" || attempt.status === "awaiting_review"
        );
        if (active) {
          active.status = "ingest_failed";
          active.completedAt = new Date().toISOString();
          active.error = interruptedError("ingest");
        }
        return current;
      });
    }
  }

  async begin(sourceId: string): Promise<{ input: IngestInput; content: string; attemptId: string }> {
    return this.lock.run(sourceId, async () => {
      let manifest = await this.manifests.read(sourceId);
      const revision = currentRevision(manifest);
      if (manifest.parse.status !== "parsed" || !revision) {
        throw new Error(`素材尚未解析完成：${manifest.parse.status}`);
      }
      const verified = await this.verifier.readAndVerifyRevision(manifest, revision.revision);
      const attemptId = randomUUID();
      manifest = await this.manifests.update(sourceId, manifest.manifestRevision, (current) => {
        current.ingest.status = "planning";
        current.ingest.revision = revision.revision;
        current.ingest.attempts.push({
          attemptId,
          revision: revision.revision,
          status: "planning",
          startedAt: new Date().toISOString(),
          acceptedPaths: []
        });
        return current;
      });
      return {
        attemptId,
        content: verified.body,
        input: {
          sourceId,
          revision: revision.revision,
          rawPath: revision.rawPath,
          sourceHash: manifest.sourceHash,
          contentHash: revision.contentHash,
          artifactHash: revision.artifactHash,
          parserId: revision.parserId,
          parserVersion: revision.parserVersion,
          parseWarnings: revision.warnings,
          metadata: revision.metadata
        }
      };
    });
  }

  async update(
    sourceId: string,
    attemptId: string,
    status: IngestStatus,
    updates: {
      operationId?: string;
      sourcePage?: string;
      acceptedPaths?: string[];
      coverage?: IngestCoverageReport;
      hasUserExclusions?: boolean;
      rolledBackAt?: string;
      rollbackOperationId?: string;
      error?: PipelineError;
    } = {}
  ): Promise<SourceManifest> {
    return this.lock.run(sourceId, async () => {
      const manifest = await this.manifests.read(sourceId);
      return this.manifests.update(sourceId, manifest.manifestRevision, (current) => {
        const attempt = current.ingest.attempts.find((item) => item.attemptId === attemptId);
        if (!attempt) throw new Error(`Ingest attempt 不存在：${attemptId}`);
        attempt.status = status;
        if (updates.operationId !== undefined) attempt.operationId = updates.operationId;
        if (updates.sourcePage !== undefined) attempt.sourcePage = updates.sourcePage;
        if (updates.acceptedPaths !== undefined) attempt.acceptedPaths = updates.acceptedPaths;
        if (updates.coverage !== undefined) attempt.coverage = structuredClone(updates.coverage);
        if (updates.hasUserExclusions !== undefined) attempt.hasUserExclusions = updates.hasUserExclusions;
        if (updates.rolledBackAt !== undefined) attempt.rolledBackAt = updates.rolledBackAt;
        if (updates.rollbackOperationId !== undefined) attempt.rollbackOperationId = updates.rollbackOperationId;
        if (updates.error !== undefined) attempt.error = updates.error;
        if (status === "ingested" || status === "ingest_failed" || status === "not_started") {
          attempt.completedAt = new Date().toISOString();
        }
        current.ingest.status = status;
        return current;
      });
    });
  }

  pipelineError(error: unknown, stage: PipelineError["stage"]): PipelineError {
    return toPipelineError(error, stage);
  }
}
