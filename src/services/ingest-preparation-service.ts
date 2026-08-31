import { randomUUID } from "node:crypto";

import { markdownSections, type MarkdownSection } from "../core/markdown-sections";
import { sha256 } from "../core/wiki-core";
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
          metadata: revision.metadata,
          lineage: manifest.source.lineage ? structuredClone(manifest.source.lineage) : undefined,
          incremental: await this.incrementalScope(manifest, verified.body)
        }
      };
    });
  }

  private async incrementalScope(
    manifest: SourceManifest,
    currentContent: string
  ): Promise<IngestInput["incremental"]> {
    const lineage = manifest.source.lineage;
    if (!lineage) return undefined;
    const all = await this.manifests.list();
    const explicitBase = lineage.baseSourceId
      ? all.find((item) => item.sourceId === lineage.baseSourceId && item.ingest.status === "ingested")
      : undefined;
    const previous = explicitBase ?? all
      .filter((item) => item.sourceId !== manifest.sourceId
        && item.source.lineage?.documentId === lineage.documentId
        && item.ingest.status === "ingested"
        && item.parse.status === "parsed"
        && item.original.importedAt <= manifest.original.importedAt)
      .sort((left, right) => latestIngestTime(right).localeCompare(latestIngestTime(left)))[0];
    if (!previous) return undefined;
    const revision = currentRevision(previous);
    if (!revision) return undefined;
    try {
      const prior = await this.verifier.readAndVerifyRevision(previous, revision.revision);
      return compareSections(previous.sourceId, revision.contentHash, prior.body, currentContent);
    } catch {
      // Incremental scope is an optimization. Verification failure falls back to
      // the existing full-source path instead of weakening Ingest correctness.
      return undefined;
    }
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

function compareSections(
  previousSourceId: string,
  previousContentHash: string,
  previousContent: string,
  currentContent: string
): NonNullable<IngestInput["incremental"]> | undefined {
  const previous = keyedSections(markdownSections(previousContent));
  const current = keyedSections(markdownSections(currentContent));
  const changedIndexes: number[] = [];
  for (let index = 0; index < current.length; index += 1) {
    const section = current[index]!;
    const old = previous.find((item) => item.key === section.key);
    if (!old || sha256(old.section.content) !== sha256(section.section.content)) changedIndexes.push(index);
  }
  const currentKeys = new Set(current.map((item) => item.key));
  const removedHeadings = previous
    .filter((item) => !currentKeys.has(item.key))
    .map((item) => item.section.heading);
  if (changedIndexes.length === 0 && removedHeadings.length === 0) return undefined;
  // The Coordinator's evidence ceiling is 24 sections. A larger delta is no
  // longer meaningfully incremental, so preserve the established full review.
  if (changedIndexes.length > 24) return undefined;
  const contextIndexes = new Set<number>();
  for (const index of changedIndexes) {
    if (index > 0) contextIndexes.add(index - 1);
    if (index + 1 < current.length) contextIndexes.add(index + 1);
  }
  for (const index of changedIndexes) contextIndexes.delete(index);
  return {
    previousSourceId,
    previousContentHash,
    changedSectionIds: changedIndexes.map((index) => current[index]!.section.sectionId),
    contextSectionIds: [...contextIndexes].sort((a, b) => a - b).map((index) => current[index]!.section.sectionId),
    unchangedSectionCount: Math.max(0, current.length - changedIndexes.length),
    removedHeadings: [...new Set(removedHeadings)]
  };
}

function keyedSections(sections: MarkdownSection[]): Array<{ key: string; section: MarkdownSection }> {
  const occurrences = new Map<string, number>();
  return sections.map((section) => {
    const identity = `${section.level}\u0000${section.heading.trim().toLocaleLowerCase()}`;
    const occurrence = (occurrences.get(identity) ?? 0) + 1;
    occurrences.set(identity, occurrence);
    return { key: `${identity}\u0000${occurrence}`, section };
  });
}

function latestIngestTime(manifest: SourceManifest): string {
  return [...manifest.ingest.attempts].reverse().find((attempt) => attempt.status === "ingested")?.completedAt
    ?? manifest.original.importedAt;
}
