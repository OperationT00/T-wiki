import { TranscriptMarkdownBuilder, type TranscriptMarkdownOptions, type TranscriptMarkdownResult } from "./transcript-markdown-builder";
import type { TimedTranscript } from "./transcript-types";
import type { SelectedVideoFrame, VideoMetadata } from "./video-visual-types";

/**
 * Keeps visual timeline composition separate from ASR and frame selection.
 * TranscriptMarkdownBuilder remains the deterministic renderer for both audio
 * and video, while this component supplies only verified, selected frames.
 */
export class MediaTimelineComposer {
  constructor(private readonly builder = new TranscriptMarkdownBuilder()) {}

  compose(
    transcript: TimedTranscript,
    options: TranscriptMarkdownOptions,
    visual?: { frames: SelectedVideoFrame[]; metadata: VideoMetadata; model: string }
  ): TranscriptMarkdownResult {
    return this.builder.build(transcript, {
      ...options,
      visualFrames: visual?.frames,
      visualMetadata: visual ? {
        extractor: "ffmpeg-scene@1",
        ffmpegVersion: visual.metadata.ffmpegVersion,
        model: visual.model
      } : undefined
    });
  }
}
