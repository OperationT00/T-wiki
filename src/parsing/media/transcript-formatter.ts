import type { ParseIssue } from "../../types";
import type { TimedTranscript } from "./transcript-types";

export interface FormattedTranscript {
  transcript: TimedTranscript;
  model?: string;
  applied: boolean;
  issues: ParseIssue[];
}

export interface TranscriptFormatter {
  format(transcript: TimedTranscript, signal: AbortSignal): Promise<FormattedTranscript>;
  fingerprint?(): unknown;
}
