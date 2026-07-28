import { randomUUID } from "node:crypto";
import type { DataAdapter } from "obsidian";

import { ArtifactBuilder } from "../parsing/artifact-builder";
import { createDefaultParserRegistry } from "../parsing/default-parser-registry";
import { ParseProgressBus, type ParseProgressListener } from "../parsing/parse-progress";
import type { DocumentParser } from "../parsing/parser-types";
import { ParserRegistry } from "../parsing/parser-registry";
import { toPipelineError } from "../parsing/pipeline-errors";
import type {
  IngestInput,
  IngestStatus,
  PipelineError,
  RawVerification,
  SourceManifest,
  WikiConfig
} from "../types";
import { IngestPreparationService } from "./ingest-preparation-service";
import { IntakeService, type IntakeProvenance, type LegacyIntakeState } from "./intake-service";
import { ParseOrchestrator } from "./parse-orchestrator";
import { RawPublisher, RawVerifier, currentRevision } from "./raw-artifacts";
import { atomicWriteText, ensureFolder, SourceStore } from "./source-store";

/**
 * Stable application facade used by WikiService and the UI.
 * Parsing behavior lives in focused intake/orchestration/artifact services.
 */
export class ParsingFacade {
  private readonly intake: IntakeService;
  private readonly orchestrator: ParseOrchestrator;
  private readonly verifier: RawVerifier;
  private readonly ingest: IngestPreparationService;
  private readonly progressBus = new ParseProgressBus();
  private initialized = false;

  constructor(
    private readonly adapter: DataAdapter,
    private readonly config: WikiConfig,
    private readonly store = new SourceStore(adapter, config.paths.internal),
    private readonly registry = createDefaultParserRegistry(),
    rawWriter: (path: string, content: string) => Promise<void>
      = (path, content) => atomicWriteText(adapter, path, content)
  ) {
    const publisher = new RawPublisher(
      adapter,
      config.paths.raw,
      rawWriter
    );
    this.verifier = new RawVerifier(adapter, config.paths.raw, store.sourceMaps);
    this.intake = new IntakeService(store.objects, store.manifests, config);
    this.orchestrator = new ParseOrchestrator(
      store.objects,
      store.manifests,
      registry,
      new ArtifactBuilder(config.paths.raw),
      publisher,
      this.verifier,
      config,
      this.progressBus
    );
    this.ingest = new IngestPreparationService(store.manifests, this.verifier);
  }

  registerParser(parser: DocumentParser): void {
    this.registry.register(parser);
  }

  subscribeProgress(listener: ParseProgressListener): () => void {
    return this.progressBus.subscribe(listener);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.store.initialize();
    await ensureFolder(this.adapter, `${this.config.paths.raw}/articles`);
    await ensureFolder(this.adapter, `${this.config.paths.raw}/documents`);
    await ensureFolder(this.adapter, `${this.config.paths.raw}/assets`);
    await this.orchestrator.initialize();
    await this.ingest.initialize();
    this.initialized = true;
  }

  async importFiles(files: File[]): Promise<SourceManifest[]> {
    const imported: SourceManifest[] = [];
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      imported.push(await this.importBytes(file.name, bytes));
    }
    return imported;
  }

  async importSource(
    name: string,
    bytes: Uint8Array,
    provenance: IntakeProvenance
  ): Promise<SourceManifest> {
    return (await this.importSourceDetailed(name, bytes, provenance)).manifest;
  }

  async importSourceDetailed(
    name: string,
    bytes: Uint8Array,
    provenance: IntakeProvenance
  ): Promise<{ manifest: SourceManifest; duplicate: boolean }> {
    await this.initialize();
    const intake = await this.intake.intake(name, bytes, provenance);
    const manifest = intake.duplicate
      ? intake.manifest
      : this.orchestrator.parseSource(intake.manifest.sourceId);
    return { manifest: await manifest, duplicate: intake.duplicate };
  }

  async importBytes(
    name: string,
    bytes: Uint8Array,
    legacy?: LegacyIntakeState
  ): Promise<SourceManifest> {
    await this.initialize();
    const intake = await this.intake.intake(name, bytes, {
      capturedAt: legacy?.importedAt,
      acquiredBy: legacy ? "legacy-migration" : "file-picker"
    });
    let manifest = intake.duplicate
      ? intake.manifest
      : await this.orchestrator.parseSource(intake.manifest.sourceId);
    if (legacy?.status === "ingested" && manifest.parse.status === "parsed") {
      manifest = await this.setLegacyIngested(manifest.sourceId, legacy.sourcePage ?? undefined);
    }
    return manifest;
  }

  async parseSource(sourceId: string, force = false): Promise<SourceManifest> {
    await this.initialize();
    return this.orchestrator.parseSource(sourceId, { force });
  }

  async parseSourceWith(sourceId: string, parserId: string): Promise<SourceManifest> {
    await this.initialize();
    return this.orchestrator.parseSource(sourceId, { force: true, parserId });
  }

  async listSources(): Promise<SourceManifest[]> {
    await this.initialize();
    return this.store.manifests.list();
  }

  async getSource(sourceId: string): Promise<SourceManifest> {
    await this.initialize();
    return this.store.manifests.read(sourceId);
  }

  async readVerifiedSource(sourceId: string): Promise<{ manifest: SourceManifest; content: string }> {
    await this.initialize();
    const manifest = await this.store.manifests.read(sourceId);
    const revision = currentRevision(manifest);
    if (manifest.parse.status !== "parsed" || !revision) {
      throw new Error(`素材尚未解析完成：${manifest.parse.status}`);
    }
    const verified = await this.verifier.readAndVerifyRevision(manifest, revision.revision);
    return { manifest, content: verified.body };
  }

  async verifyRaw(): Promise<RawVerification[]> {
    await this.initialize();
    const inspection = await this.store.manifests.inspect();
    const manifests = inspection.manifests;
    const results = await this.verifier.verifyAll(manifests);
    for (const error of inspection.errors) {
      results.push({
        sourceId: `invalid-manifest:${error.path}`,
        ok: false,
        issues: [{
          code: "MANIFEST_INVALID",
          severity: "error",
          message: error.message
        }]
      });
    }
    for (const manifest of manifests) {
      try {
        await this.store.objects.read(manifest);
      } catch (error) {
        const result = results.find((candidate) => candidate.sourceId === manifest.sourceId);
        result?.issues.push({
          code: "SOURCE_OBJECT_INVALID",
          severity: "error",
          message: error instanceof Error ? error.message : String(error)
        });
        if (result) result.ok = false;
      }
    }
    return results;
  }

  async beginIngest(sourceId: string): Promise<{
    input: IngestInput;
    content: string;
    attemptId: string;
  }> {
    await this.initialize();
    return this.ingest.begin(sourceId);
  }

  async updateIngestAttempt(
    sourceId: string,
    attemptId: string,
    status: IngestStatus,
    updates: {
      operationId?: string;
      sourcePage?: string;
      acceptedPaths?: string[];
      coverage?: import("../types").IngestCoverageReport;
      hasUserExclusions?: boolean;
      rolledBackAt?: string;
      rollbackOperationId?: string;
      error?: PipelineError;
    } = {}
  ): Promise<SourceManifest> {
    await this.initialize();
    return this.ingest.update(sourceId, attemptId, status, updates);
  }

  pipelineError(error: unknown, stage: PipelineError["stage"]): PipelineError {
    return toPipelineError(error, stage);
  }

  private async setLegacyIngested(sourceId: string, sourcePage?: string): Promise<SourceManifest> {
    const manifest = await this.store.manifests.read(sourceId);
    const revision = currentRevision(manifest);
    if (!revision) return manifest;
    return this.store.manifests.update(sourceId, manifest.manifestRevision, (current) => {
      current.ingest.status = "ingested";
      current.ingest.revision = revision.revision;
      current.ingest.attempts.push({
        attemptId: `legacy-${randomUUID()}`,
        revision: revision.revision,
        status: "ingested",
        startedAt: current.original.importedAt,
        completedAt: new Date().toISOString(),
        sourcePage,
        acceptedPaths: sourcePage ? [sourcePage] : []
      });
      return current;
    });
  }
}

/** @deprecated Import ParsingFacade in new code. */
export class ParsingService extends ParsingFacade {}
