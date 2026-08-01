import { ParserRegistry } from "./parser-registry";
import { MarkdownParser } from "./parsers/markdown-parser";
import { MinerUParser, type MinerUCredentials } from "./parsers/mineru-parser";
import { PdfParser } from "./parsers/pdf-parser";
import { TextParser } from "./parsers/text-parser";
import { WebPageParser } from "./parsers/webpage-parser";
import { BilibiliCaptionParser } from "./parsers/bilibili-caption-parser";
import {
  MediaTranscriptionParser,
  type MediaUploadConsent
} from "./parsers/media-transcription-parser";
import type { TranscriptionCredentials } from "./media/transcription-transports";
import type { VisionCredentials } from "./media/video-visual-types";
import type { TranscriptTitleGenerator } from "./media/transcript-title";
import type { HttpClientPort } from "./http-client";
import type { MediaJobStorePort } from "./media/media-job";

/** Composition root for built-in parsers. */
export function createDefaultParserRegistry(dependencies: {
  mineru?: { http: HttpClientPort; credentials: MinerUCredentials };
  media?: {
    credentials: TranscriptionCredentials;
    consent: MediaUploadConsent;
    visionCredentials?: VisionCredentials;
    titleGenerator?: TranscriptTitleGenerator;
    jobs?: MediaJobStorePort;
  };
} = {}): ParserRegistry {
  const registry = new ParserRegistry()
    .register(new PdfParser())
    .register(new MarkdownParser())
    .register(new TextParser())
    .register(new WebPageParser())
    .register(new BilibiliCaptionParser());
  if (dependencies.mineru) {
    registry.register(new MinerUParser(
      dependencies.mineru.http,
      dependencies.mineru.credentials
    ));
  }
  if (dependencies.media) {
    registry.register(new MediaTranscriptionParser(
      dependencies.media.credentials,
      dependencies.media.consent,
      undefined,
      dependencies.media.visionCredentials,
      undefined,
      dependencies.media.titleGenerator,
      dependencies.media.jobs
    ));
  }
  return registry;
}
