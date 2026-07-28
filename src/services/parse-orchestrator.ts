import { randomUUID } from "node:crypto";

import { sha256 } from "../core/wiki-core";
import { ArtifactBuilder } from "../parsing/artifact-builder";
import { KeyedLock } from "../parsing/keyed-lock";
import {
  ParseProgressBus,
  createProgressEvent,
  persistedProgress
} from "../parsing/parse-progress";
import {
  OcrRequiredError,
  ParserError,
  ParserSelectionError,
  type ParseContext,
  type ParseInput,
  type ParserSelection
} from "../parsing/parser-types";
import type {
  ManifestRepositoryPort,
  ObjectStorePort,
  RawPublisherPort,
  RawVerifierPort,
  PublishedRawArtifact
} from "../parsing/ports";
import { ParserRegistry } from "../parsing/parser-registry";
import { interruptedError, toPipelineError } from "../parsing/pipeline-errors";
import { sanitizeSourceUri } from "../parsing/source-uri";
import type {
  ParseAttempt,
  ParseProgress,
  ParseProgressEvent,
  SourceManifest,
  WikiConfig
} from "../types";

export class ParseOrchestrator {
  constructor(
    private readonly objects: ObjectStorePort,
    private readonly manifests: ManifestRepositoryPort,
    private readonly registry: ParserRegistry,
    private readonly builder: ArtifactBuilder,
    private readonly publisher: RawPublisherPort,
    private readonly verifier: RawVerifierPort,
    private readonly config: WikiConfig,
    private readonly progressBus = new ParseProgressBus(),
    private readonly lock = new KeyedLock()
  ) {}

  async initialize(): Promise<void> {
    await Promise.all([
      this.objects.initialize(),
      this.manifests.initialize(),
      this.publisher.initialize()
    ]);
    const resumable: string[] = [];
    for (const manifest of await this.manifests.list()) {
      if (manifest.parse.status !== "parsing") continue;
      const attempt = latestActiveAttempt(manifest);
      const parser = attempt?.parserId
        ? this.registry.list().find((candidate) =>
          candidate.descriptor.id === attempt.parserId
          && candidate.descriptor.version === attempt.parserVersion
        )
        : undefined;
      if (attempt?.resumeToken && parser?.descriptor.capabilities.resumable && parser.resume) {
        resumable.push(manifest.sourceId);
        continue;
      }
      await this.manifests.update(manifest.sourceId, manifest.manifestRevision, (current) => {
        current.parse.status = "parse_failed";
        current.parse.error = interruptedError("parse");
        delete current.parse.startedAt;
        const active = latestActiveAttempt(current);
        if (active) {
          active.status = "parse_failed";
          active.completedAt = new Date().toISOString();
          active.error = current.parse.error;
        }
        return current;
      });
    }
    for (const sourceId of resumable) await this.parseSource(sourceId, { resume: true });
  }

  async parseSource(
    sourceId: string,
    options: {
      force?: boolean;
      resume?: boolean;
      signal?: AbortSignal;
      parserId?: string;
    } = {}
  ): Promise<SourceManifest> {
    return this.lock.run(sourceId, async () => {
      const manifest = await this.manifests.read(sourceId);
      const bytes = await this.objects.read(manifest);
      const input: ParseInput = {
        sourceId,
        sourceHash: manifest.sourceHash,
        kind: manifest.source.kind,
        name: manifest.original.name,
        extension: manifest.original.extension,
        mime: manifest.original.mime,
        bytes,
        sourceUri: manifest.source.uri,
        captureContentType: manifest.source.capture?.contentType
      };
      let candidates: ParserSelection[];
      try {
        candidates = await this.registry.rank(input, this.config.parsing.providers);
      } catch (error) {
        return this.commitSelectionFailure(sourceId, manifest, error);
      }
      let selected = candidates[0]!;
      if (options.resume) {
        const active = latestActiveAttempt(manifest);
        selected = candidates.find((candidate) =>
          candidate.parser.descriptor.id === active?.parserId
          && candidate.parser.descriptor.version === active.parserVersion
        ) ?? selected;
      } else if (options.parserId) {
        const requested = candidates.find((candidate) => candidate.parser.descriptor.id === options.parserId);
        if (!requested) {
          return this.commitSelectionFailure(
            sourceId,
            manifest,
            new ParserError("PARSER_NOT_AVAILABLE", `解析器未启用或不支持当前文件：${options.parserId}`)
          );
        }
        selected = requested;
      }
      const fallbacks = options.parserId || options.resume
        ? []
        : candidates.filter((candidate) => candidate !== selected);
      return this.executeSelection(sourceId, input, selected, fallbacks, options);
    });
  }

  private async executeSelection(
    sourceId: string,
    input: ParseInput,
    selection: ParserSelection,
    fallbacks: ParserSelection[],
    options: { force?: boolean; resume?: boolean; signal?: AbortSignal }
  ): Promise<SourceManifest> {
    let manifest = await this.manifests.read(sourceId);
    const parser = selection.parser;
    const inferredKind = manifest.source.kind === "unknown"
      && parser.descriptor.supportedKinds.length === 1
      && parser.descriptor.supportedKinds[0] !== "unknown"
      ? parser.descriptor.supportedKinds[0]
      : undefined;
    if (inferredKind || (selection.probe.detectedMime && selection.probe.detectedMime !== manifest.original.mime)) {
      manifest = await this.manifests.update(sourceId, manifest.manifestRevision, (current) => {
        if (inferredKind) current.source.kind = inferredKind;
        if (selection.probe.detectedMime) current.original.mime = selection.probe.detectedMime;
        return current;
      });
      if (inferredKind) input.kind = inferredKind;
      if (selection.probe.detectedMime) input.mime = selection.probe.detectedMime;
    }
    const providerConfig = this.config.parsing.providers[parser.descriptor.id]
      ?? { enabled: true, priority: 0, options: {} };
    const parseKey = sha256(canonicalJson({
      sourceHash: manifest.sourceHash,
      parserId: parser.descriptor.id,
      parserVersion: parser.descriptor.version,
      options: providerConfig.options
    }));
    const existing = manifest.parse.revisions.find((revision) => revision.parseKey === parseKey);
    if (!options.force && !options.resume && existing) {
      try {
        await this.verifier.readAndVerifyRevision(manifest, existing.revision);
        return this.manifests.update(sourceId, manifest.manifestRevision, (current) => {
          current.parse.status = "parsed";
          current.parse.currentRevision = existing.revision;
          delete current.parse.startedAt;
          delete current.parse.error;
          return current;
        });
      } catch {
        // Broken cache is not reused.
      }
    }

    const resumable = options.resume
      ? latestResumableAttempt(manifest, parser.descriptor.id, parser.descriptor.version, parseKey)
      : undefined;
    const attemptId = resumable?.attemptId ?? randomUUID();
    manifest = await this.manifests.update(sourceId, manifest.manifestRevision, (current) => {
      current.parse.status = "parsing";
      current.parse.startedAt = new Date().toISOString();
      delete current.parse.error;
      if (resumable) {
        const attempt = current.parse.attempts.find((candidate) => candidate.attemptId === attemptId);
        if (attempt) {
          attempt.status = "parsing";
          attempt.parseKey = parseKey;
        }
      } else {
        current.parse.attempts.push({
          attemptId,
          parseKey,
          parserId: parser.descriptor.id,
          parserVersion: parser.descriptor.version,
          status: "parsing",
          startedAt: new Date().toISOString(),
          probeDiagnostics: selection.diagnostics
        });
      }
      return current;
    });

    const controller = new AbortController();
    let timedOut = false;
    const abort = (): void => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const providerTimeout = parser.descriptor.execution === "remote"
      ? numericProviderOption(providerConfig.options.taskTimeoutMs, this.config.parsing.timeoutMs)
      : this.config.parsing.timeoutMs;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, providerTimeout);
    let progressQueue = Promise.resolve();
    const persistAttempt = (mutate: (attempt: ParseAttempt) => void): Promise<void> => {
      progressQueue = progressQueue.then(async () => {
        const current = await this.manifests.read(sourceId);
        await this.manifests.update(sourceId, current.manifestRevision, (next) => {
          const attempt = next.parse.attempts.find((candidate) => candidate.attemptId === attemptId);
          if (attempt) mutate(attempt);
          return next;
        });
      });
      return progressQueue;
    };
    const identity = {
      sourceId,
      sourceName: manifest.original.name,
      attemptId,
      parserId: parser.descriptor.id,
      parserVersion: parser.descriptor.version
    };
    let latestProgress: ParseProgressEvent | undefined;
    let pendingProgress: ParseProgress | undefined;
    let progressTimer: ReturnType<typeof setTimeout> | undefined;
    const flushProgress = (): Promise<void> => {
      if (progressTimer) {
        clearTimeout(progressTimer);
        progressTimer = undefined;
      }
      if (!pendingProgress) return progressQueue;
      const snapshot = pendingProgress;
      pendingProgress = undefined;
      return persistAttempt((attempt) => { attempt.progress = structuredClone(snapshot); });
    };
    const reportProgress = (
      update: ParseProgress,
      state: ParseProgressEvent["state"] = "running"
    ): ParseProgressEvent => {
      latestProgress = createProgressEvent(identity, update, latestProgress, state);
      this.progressBus.publish(latestProgress);
      pendingProgress = persistedProgress(latestProgress);
      if (!progressTimer) {
        progressTimer = setTimeout(() => {
          progressTimer = undefined;
          void flushProgress();
        }, 750);
      }
      return latestProgress;
    };
    const context: ParseContext = {
      signal: controller.signal,
      options: Object.freeze({ ...providerConfig.options, timeoutMs: providerTimeout }),
      reportProgress: (progress: ParseProgress) => {
        reportProgress(progress);
      },
      saveResumeToken: async (token: string) => {
        validateResumeToken(token);
        await flushProgress();
        await persistAttempt((attempt) => { attempt.resumeToken = token; });
      }
    };

    reportProgress({
      phase: "preparing",
      completed: 1,
      total: 1,
      unit: "document",
      message: "原件准备完成"
    });
    reportProgress({
      phase: "probing",
      completed: 1,
      total: 1,
      unit: "document",
      message: `已选择 ${parser.descriptor.id}`
    });

    let errorStage: "parse" | "publish" = "parse";
    let publishedForRollback: PublishedRawArtifact | undefined;
    try {
        const payload = resumable?.resumeToken && parser.resume
          ? await parser.resume(input, resumable.resumeToken, context)
          : await parser.parse(input, context);
        await flushProgress();
        await progressQueue;
        if (controller.signal.aborted) {
          throw new ParserError(
            timedOut ? "PARSE_TIMEOUT" : "PARSE_CANCELLED",
            timedOut ? "解析超时" : "解析已取消",
            true
          );
        }
        let buildManifest = await this.manifests.read(sourceId);
        const declaredKind = singleMetadataValue(payload.metadata.source_type);
        const declaredUri = sanitizeSourceUri(
          singleMetadataValue(payload.metadata.url) ?? singleMetadataValue(payload.metadata.source)
        );
        const declaredCapturedAt = normalizeTimestamp(singleMetadataValue(payload.metadata.captured_at));
        if ((declaredKind === "web" && buildManifest.source.kind !== "web")
          || (declaredUri && !buildManifest.source.uri)
          || (declaredCapturedAt && !buildManifest.source.capturedAt)) {
          buildManifest = await this.manifests.update(sourceId, buildManifest.manifestRevision, (current) => {
            if (declaredKind === "web") current.source.kind = "web";
            if (declaredUri && !current.source.uri) current.source.uri = declaredUri;
            if (declaredCapturedAt && !current.source.capturedAt) {
              current.source.capturedAt = declaredCapturedAt;
            }
            return current;
          });
        }
        reportProgress({ phase: "normalizing", completed: 0, total: 1, unit: "document" });
        const built = this.builder.build(
          buildManifest,
          parser.descriptor,
          payload,
          this.config.parsing.maxOutputBytes
        );
        reportProgress({
          phase: "quality_check",
          completed: 1,
          total: 1,
          unit: "document",
          message: "Markdown 标准化与质量检查完成"
        });
        const currentBeforePublish = await this.manifests.read(sourceId);
        const revisionNumber = Math.max(
          0,
          ...currentBeforePublish.parse.revisions.map((revision) => revision.revision)
        ) + 1;
        errorStage = "publish";
        reportProgress({ phase: "publishing", completed: 0, total: 1, unit: "document" });
        const published = await this.publisher.publish(currentBeforePublish, revisionNumber, built);
        publishedForRollback = published;
        reportProgress({
          phase: "publishing",
          completed: 1,
          total: 1,
          unit: "document",
          message: "raw Markdown 发布完成"
        });
        await flushProgress();
        await progressQueue;
        const current = await this.manifests.read(sourceId);
        const completedProgress = createProgressEvent(
          identity,
          { phase: "completed", completed: 1, total: 1, unit: "document", message: "解析完成" },
          latestProgress,
          "completed"
        );
        const committed = await this.manifests.update(sourceId, current.manifestRevision, (next) => {
          next.parse.status = "parsed";
          next.parse.currentRevision = revisionNumber;
          delete next.parse.startedAt;
          delete next.parse.error;
          const attempt = next.parse.attempts.find((candidate) => candidate.attemptId === attemptId);
          if (attempt) {
            attempt.status = "parsed";
            attempt.completedAt = new Date().toISOString();
            attempt.progress = persistedProgress(completedProgress);
            delete attempt.resumeToken;
          }
          next.parse.revisions.push({
            revision: revisionNumber,
            parserId: parser.descriptor.id,
            parserVersion: parser.descriptor.version,
            parseKey,
            completedAt: new Date().toISOString(),
            rawPath: published.rawPath,
            contentHash: built.contentHash,
            artifactHash: built.artifactHash,
            artifactSchemaVersion: built.artifactSchemaVersion,
            assets: built.assets.map(({ bytes: _bytes, ...asset }) => asset),
            metadata: payload.metadata,
            quality: built.quality,
            warnings: payload.issues
          });
          return next;
        });
        publishedForRollback = undefined;
        latestProgress = completedProgress;
        pendingProgress = undefined;
        this.progressBus.publish(completedProgress);
      return committed;
    } catch (error) {
        await flushProgress().catch(() => undefined);
        await progressQueue.catch(() => undefined);
        let rollbackError: unknown;
        if (publishedForRollback) {
          try {
            await this.publisher.rollback(publishedForRollback);
          } catch (failure) {
            rollbackError = failure;
          }
        }
        const current = await this.manifests.read(sourceId);
        const normalizedError = rollbackError
          ? new ParserError(
            "PUBLISH_ROLLBACK_FAILED",
            `发布提交失败且回滚失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
            false
          )
          : controller.signal.aborted && !(error instanceof ParserError)
          ? new ParserError(
            timedOut ? "PARSE_TIMEOUT" : "PARSE_CANCELLED",
            timedOut ? "解析超时" : "解析已取消",
            true
          )
          : error;
      const pipelineError = toPipelineError(normalizedError, errorStage);
      const failedProgress = createProgressEvent(
        identity,
        {
          phase: latestProgress?.phase ?? "parsing",
          message: pipelineError.message
        },
        latestProgress,
        "failed"
      );
      const attemptStatus = normalizedError instanceof OcrRequiredError ? "needs_ocr" : "parse_failed";
      const fallback = errorStage === "parse" && shouldFallback(normalizedError, parser.descriptor.id)
        ? fallbacks.find((candidate) => candidate.parser.descriptor.id === "mineru-http")
        : undefined;
      const failed = await this.manifests.update(sourceId, current.manifestRevision, (next) => {
          const status = fallback ? "parsing" : attemptStatus;
          next.parse.status = status;
          if (fallback) delete next.parse.error;
          else next.parse.error = pipelineError;
          if (!fallback) delete next.parse.startedAt;
          const attempt = next.parse.attempts.find((candidate) => candidate.attemptId === attemptId);
          if (attempt) {
            attempt.status = attemptStatus;
            attempt.completedAt = new Date().toISOString();
            attempt.progress = persistedProgress(failedProgress);
            attempt.error = pipelineError;
          }
          return next;
        });
      latestProgress = failedProgress;
      pendingProgress = undefined;
      this.progressBus.publish(failedProgress);
      if (fallback) {
        return this.executeSelection(sourceId, input, fallback, [], {
          force: true,
          signal: options.signal
        });
      }
      return failed;
    } finally {
        if (progressTimer) clearTimeout(progressTimer);
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
    }
  }

  private async commitSelectionFailure(
    sourceId: string,
    manifest: SourceManifest,
    error: unknown
  ): Promise<SourceManifest> {
    const pipelineError = toPipelineError(error, "parse");
    return this.manifests.update(sourceId, manifest.manifestRevision, (current) => {
      current.parse.status = "parse_failed";
      current.parse.error = pipelineError;
      delete current.parse.startedAt;
      current.parse.attempts.push({
        attemptId: randomUUID(),
        status: "parse_failed",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        probeDiagnostics: error instanceof ParserSelectionError ? error.diagnostics : undefined,
        error: pipelineError
      });
      return current;
    });
  }
}

function latestActiveAttempt(manifest: SourceManifest): ParseAttempt | undefined {
  return [...manifest.parse.attempts].reverse().find((attempt) => attempt.status === "parsing");
}

function latestResumableAttempt(
  manifest: SourceManifest,
  parserId: string,
  parserVersion: string,
  parseKey: string
): ParseAttempt | undefined {
  return [...manifest.parse.attempts].reverse().find((attempt) =>
    attempt.status === "parsing"
    && attempt.parserId === parserId
    && attempt.parserVersion === parserVersion
    && attempt.parseKey === parseKey
    && Boolean(attempt.resumeToken)
  );
}

function validateResumeToken(token: string): void {
  if (!token || token.length > 2048) throw new ParserError("INVALID_RESUME_TOKEN", "resume token 长度无效");
  if (/(?:bearer\s+|sk-ant-|api[_-]?key\s*=|authorization\s*=)/i.test(token)) {
    throw new ParserError("INVALID_RESUME_TOKEN", "resume token 不能包含访问密钥");
  }
}

function shouldFallback(error: unknown, parserId: string): boolean {
  return parserId === "pdfjs-layout"
    && error instanceof ParserError
    && (error.code === "OCR_REQUIRED" || error.code === "QUALITY_GATE_FAILED");
}

function numericProviderOption(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function singleMetadataValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? undefined : timestamp.toISOString();
}
