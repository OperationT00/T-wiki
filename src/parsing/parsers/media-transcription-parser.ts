import type { ParsePayload } from "../../types";
import { normalizeSocialVideoTitle } from "../../core/source-title";
import { TranscriptMarkdownBuilder } from "../media/transcript-markdown-builder";
import { FfmpegFrameExtractor } from "../media/ffmpeg-frame-extractor";
import { OpenAICompatibleVisionProvider } from "../media/openai-vision-provider";
import { assertVideoVisualReady } from "../media/video-visual-options";
import { DEFAULT_VIDEO_VISUAL_OPTIONS } from "../media/video-visual-options";
import { VideoVisualPipeline } from "../media/video-visual-pipeline";
import { MediaTimelineComposer } from "../media/media-timeline-composer";
import { ChunkedTranscriptionCoordinator } from "../media/chunked-transcription-coordinator";
import type { MediaJobStorePort } from "../media/media-job";
import {
  composeMediaDocumentTitle,
  resolveMediaAuthorIdentity,
  sanitizeGeneratedContentTitle,
  type TranscriptTitleGenerator
} from "../media/transcript-title";
import type {
  VideoVisualAnalyzer,
  VideoVisualOptions,
  VisionCredentials
} from "../media/video-visual-types";
import {
  createTranscriptionTransport,
  parseMediaTranscriptionOptions,
  type TranscriptionCredentials
} from "../media/transcription-transports";
import {
  ParserError,
  parseInputSize,
  parseInputSource,
  type DocumentParser,
  type ParseContext,
  type ParseInput,
  type ProbeResult
} from "../parser-types";

export interface MediaUploadConsent {
  consume(sourceId: string): boolean;
}

export class InMemoryMediaUploadConsent implements MediaUploadConsent {
  private readonly approved = new Set<string>();
  approve(sourceId: string): void { this.approved.add(sourceId); }
  revoke(sourceId: string): void { this.approved.delete(sourceId); }
  consume(sourceId: string): boolean { return this.approved.delete(sourceId); }
  clear(): void { this.approved.clear(); }
}

export class MediaTranscriptionParser implements DocumentParser {
  readonly descriptor = {
    id: "media-transcription",
    version: "1.3.0",
    execution: "remote",
    supportedKinds: ["audio", "video"],
    capabilities: { sourceMap: false, assets: true, resumable: true },
    resumePolicy: "user-confirmed"
  } as const;

  constructor(
    private readonly credentials: TranscriptionCredentials,
    private readonly consent: MediaUploadConsent,
    private readonly builder = new TranscriptMarkdownBuilder(),
    private readonly visionCredentials: VisionCredentials = { async getToken() { return ""; } },
    private readonly visualFactory?: (options: VideoVisualOptions) => VideoVisualAnalyzer,
    private readonly titleGenerator?: TranscriptTitleGenerator,
    private readonly mediaJobs?: MediaJobStorePort
  ) {}

  validateOptions(options: Readonly<Record<string, unknown>>): void {
    parseMediaTranscriptionOptions(options);
  }

  async initialize(): Promise<void> {
    await this.mediaJobs?.prune();
  }

  async reconcileSources(sources: ReadonlyMap<string, string>): Promise<void> {
    await this.mediaJobs?.prune(new Date(), sources);
  }

  async cleanupSource(sourceId: string): Promise<void> {
    await this.mediaJobs?.cleanupSource(sourceId);
  }

  probe(input: ParseInput): ProbeResult {
    const supported = input.kind === "audio" || input.kind === "video";
    return { supported, confidence: supported ? 1 : 0, detectedMime: supported ? input.mime : undefined };
  }

  async runtimeFingerprint(
    input: ParseInput,
    optionsInput: Readonly<Record<string, unknown>>,
    signal: AbortSignal
  ): Promise<unknown> {
    const options = parseMediaTranscriptionOptions(optionsInput);
    const visualOptions = withSharedFfmpeg(options.visual ?? DEFAULT_VIDEO_VISUAL_OPTIONS, options.preprocessing?.ffmpegPath);
    const title = this.titleGenerator?.fingerprint?.();
    let preprocessingFingerprint: string | undefined;
    if (options.preprocessing?.enabled && this.mediaJobs) {
      try {
        preprocessingFingerprint = await new FfmpegFrameExtractor(options.preprocessing.ffmpegPath).fingerprint(signal);
      } catch {
        preprocessingFingerprint = "unavailable";
      }
    }
    if (input.kind !== "video" || !visualOptions.enabled) {
      return title || preprocessingFingerprint
        ? { ...(title ? { title } : {}), preprocessingFfmpeg: preprocessingFingerprint }
        : undefined;
    }
    try {
      return {
        ...(title ? { title } : {}),
        preprocessingFfmpeg: preprocessingFingerprint,
        ffmpeg: await this.createVisualPipeline(visualOptions).fingerprint(signal),
        visionModel: visualOptions.vision.model
      };
    } catch {
      // Missing FFmpeg is a supported text-only degradation path. The marker
      // prevents reusing an older visual revision while the runtime is absent.
      return {
        ...(title ? { title } : {}),
        preprocessingFfmpeg: preprocessingFingerprint,
        ffmpeg: "unavailable",
        visionModel: visualOptions.vision.model
      };
    }
  }

  async parse(input: ParseInput, context: ParseContext): Promise<ParsePayload> {
    return this.execute(input, context);
  }

  async resume(input: ParseInput, token: string, context: ParseContext): Promise<ParsePayload> {
    return this.execute(input, context, token);
  }

  private async execute(input: ParseInput, context: ParseContext, resumeToken?: string): Promise<ParsePayload> {
    if (!this.consent.consume(input.sourceId)) {
      throw new ParserError("REMOTE_UPLOAD_CONSENT_REQUIRED", "远程转写需要本次任务的明确确认");
    }
    const options = parseMediaTranscriptionOptions(context.options);
    const transport = createTranscriptionTransport(options, this.credentials);
    const size = parseInputSize(input);
    const coordinator = new ChunkedTranscriptionCoordinator(this.mediaJobs);
    context.reportProgress({ phase: "preparing-media", completed: 0, total: size, unit: "byte", message: "正在准备媒体转写" });
    const coordinated = await coordinator.transcribe(input, transport, options, context, resumeToken);
    const transcript = coordinated.transcript;
    let visual: Awaited<ReturnType<VideoVisualAnalyzer["analyze"]>> | undefined;
    const visualIssues = [];
    const visualOptions = withSharedFfmpeg(options.visual ?? DEFAULT_VIDEO_VISUAL_OPTIONS, options.preprocessing?.ffmpegPath);
    if (input.kind === "video" && visualOptions.enabled) {
      try {
        assertVideoVisualReady(visualOptions);
        visual = await this.createVisualPipeline(visualOptions).analyze(
          parseInputSource(input),
          input.name,
          transcript,
          context
        );
        visualIssues.push(...visual.issues);
      } catch (error) {
        if (context.signal.aborted || (error instanceof ParserError && error.code === "PARSE_CANCELLED")) throw error;
        visualIssues.push({
          code: "VIDEO_VISUAL_SKIPPED",
          severity: "warning" as const,
          message: `关键画面解析失败，已发布纯文字稿：${safeVisualError(error)}`
        });
      }
    }
    context.reportProgress({ phase: "building-markdown", mode: "indeterminate", message: "正在生成 Markdown" });
    const documentTranscript = transcript.durationMs === undefined && visual?.metadata.durationMs
      ? { ...transcript, durationMs: visual.metadata.durationMs }
      : transcript;
    const sourceTitle = typeof input.sourceMetadata?.title === "string"
      ? input.sourceMetadata.title
      : input.name.replace(/\.[^.]+$/, "");
    const isDouyin = input.sourceMetadata?.source_platform === "douyin";
    const fallbackContentTitle = isDouyin
      ? normalizeSocialVideoTitle(
        sourceTitle,
        `douyin-${String(input.sourceMetadata?.douyin_video_id ?? input.sourceId)}`
      )
      : sourceTitle;
    const authorIdentity = resolveMediaAuthorIdentity(input.sourceMetadata);
    let contentTitle = sanitizeGeneratedContentTitle(fallbackContentTitle, "音视频文字稿");
    let titleModel: string | undefined;
    let titleGenerated = false;
    if (this.titleGenerator) {
      context.reportProgress({ phase: "generating-title", mode: "indeterminate", message: "正在生成内容标题" });
      try {
        const generated = await this.titleGenerator.generate({
          originalTitle: sourceTitle,
          description: metadataString(input.sourceMetadata?.description),
          authorIdentity,
          transcript: documentTranscript
        }, context.signal);
        contentTitle = sanitizeGeneratedContentTitle(generated.summary, contentTitle);
        titleModel = generated.model;
        titleGenerated = true;
      } catch (error) {
        if (context.signal.aborted) throw error;
        visualIssues.push({
          code: "MEDIA_TITLE_FALLBACK",
          severity: "warning" as const,
          message: `智能标题生成失败，已使用来源标题：${safeVisualError(error)}`
        });
      }
    }
    const title = composeMediaDocumentTitle(authorIdentity, contentTitle);
    const result = new MediaTimelineComposer(this.builder).compose(documentTranscript, {
      title,
      sourceUri: input.sourceUri
    }, visual ? {
      frames: visual.frames,
      metadata: visual.metadata,
      model: visualOptions.vision.model
    } : undefined);
    context.reportProgress({ phase: "quality-check", completed: 1, total: 1, unit: "document", message: "文字稿质量校验完成" });
    const payload: ParsePayload = {
      schemaVersion: 2,
      markdown: result.markdown,
      metadata: {
        ...input.sourceMetadata,
        ...(isDouyin && title !== sourceTitle && input.sourceMetadata?.source_title_original === undefined
          ? { source_title_original: sourceTitle }
          : {}),
        content_title: contentTitle,
        title_generated: String(titleGenerated),
        ...(titleModel ? { title_model: titleModel } : {}),
        ...result.metadata
      },
      assets: visual?.assets ?? [],
      issues: [...result.issues, ...coordinated.warnings, ...visualIssues],
      stats: {
        durationMs: documentTranscript.durationMs,
        visualFrameCount: visual?.frames.length ?? 0,
        transcriptionChunkCount: coordinated.chunkCount,
        emptyTranscriptionChunkCount: coordinated.emptyChunkCount
      }
    };
    await coordinator.cleanup(coordinated.jobId);
    return payload;
  }

  async testConnection(
    optionsInput: Readonly<Record<string, unknown>>,
    signal = new AbortController().signal
  ): Promise<{ ok: boolean; message: string }> {
    const options = parseMediaTranscriptionOptions(optionsInput);
    return createTranscriptionTransport(options, this.credentials).testConnection(signal);
  }

  async testVisualConnection(
    optionsInput: Readonly<Record<string, unknown>>,
    signal = new AbortController().signal
  ): Promise<{ ok: boolean; message: string }> {
    const parsed = parseMediaTranscriptionOptions(optionsInput);
    const options = withSharedFfmpeg(parsed.visual ?? DEFAULT_VIDEO_VISUAL_OPTIONS, parsed.preprocessing?.ffmpegPath);
    assertVideoVisualReady({ ...options, enabled: true });
    const provider = new OpenAICompatibleVisionProvider(options.vision, this.visionCredentials);
    return provider.testConnection(signal);
  }

  async testFfmpeg(
    optionsInput: Readonly<Record<string, unknown>>,
    signal = new AbortController().signal
  ): Promise<{ ok: boolean; message: string }> {
    const options = parseMediaTranscriptionOptions(optionsInput);
    const ffmpegPath = options.preprocessing?.ffmpegPath || options.visual?.ffmpegPath || "";
    const version = await new FfmpegFrameExtractor(ffmpegPath).fingerprint(signal);
    return { ok: true, message: version };
  }

  private createVisualPipeline(options: VideoVisualOptions): VideoVisualAnalyzer {
    if (this.visualFactory) return this.visualFactory(options);
    return new VideoVisualPipeline(
      new FfmpegFrameExtractor(options.ffmpegPath),
      new OpenAICompatibleVisionProvider(options.vision, this.visionCredentials),
      options
    );
  }
}

function withSharedFfmpeg(options: VideoVisualOptions, preprocessingPath: string | undefined): VideoVisualOptions {
  return options.ffmpegPath || !preprocessingPath ? options : { ...options, ffmpegPath: preprocessingPath };
}

function metadataString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function safeVisualError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(?:Bearer\s+)?[A-Za-z0-9._-]{24,}/gi, "[redacted]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 400);
}
