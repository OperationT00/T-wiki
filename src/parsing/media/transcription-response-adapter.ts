import { ParserError } from "../parser-types";
import type { TimedTranscript, TimedTranscriptSegment, TimestampUnit } from "./transcript-types";

export interface TranscriptionResponseOptions {
  provider: string;
  model: string;
  generated: boolean;
  timestampUnit: TimestampUnit;
  allowEmpty?: boolean;
}

/** Normalizes the common OpenAI/Whisper-compatible response dialects. */
export function adaptTranscriptionResponse(
  json: unknown,
  text: string,
  options: TranscriptionResponseOptions
): TimedTranscript {
  const root = unwrapRecord(json);
  const rawSegments = firstArray(root, ["segments", "utterances", "chunks"]);
  const rawWords = firstArray(root, ["words"]);
  const segmentValues = rawSegments.length > 0 ? rawSegments : wordsToGroups(rawWords);
  const timestampUnit = inferredUnit(root, segmentValues, options.timestampUnit);
  const segments = segmentValues.flatMap((value): TimedTranscriptSegment[] => normalizeItem(value, timestampUnit));
  const plainText = stringValue(root?.text)
    ?? stringValue(root?.transcript)
    ?? stringValue(json)
    ?? (json === undefined ? text.trim() : undefined);
  if (segments.length === 0 && plainText) segments.push({ text: plainText });
  if (segments.length === 0 && !options.allowEmpty) {
    throw new ParserError("TRANSCRIPTION_RESULT_INVALID", "转写服务未返回可识别的文字内容");
  }
  const precision = segments.some((item) => item.startMs !== undefined) ? "segment" : "none";
  return {
    schemaVersion: 1,
    language: stringValue(root?.language),
    durationMs: timeToMs(root?.duration_ms ?? root?.duration, root?.duration_ms !== undefined ? "milliseconds" : timestampUnit),
    segments,
    provider: options.provider,
    model: options.model,
    generated: options.generated,
    timePrecision: precision,
    issues: precision === "none" && segments.length > 0
      ? [{ code: "TRANSCRIPT_TIMESTAMPS_MISSING", severity: "warning", message: "服务仅返回纯文本，无法生成精确时间戳" }]
      : []
  };
}

function unwrapRecord(value: unknown): Record<string, unknown> | undefined {
  let current = recordValue(value);
  for (let depth = 0; depth < 3 && current; depth += 1) {
    const nested = recordValue(current.data) ?? recordValue(current.output) ?? recordValue(current.result);
    if (!nested) break;
    current = nested;
  }
  return current;
}

function normalizeItem(value: unknown, unit: TimestampUnit): TimedTranscriptSegment[] {
  const item = recordValue(value);
  if (!item) return [];
  const text = stringValue(item.text) ?? stringValue(item.transcript) ?? stringValue(item.word);
  if (!text) return [];
  const timestamp = Array.isArray(item.timestamp) ? item.timestamp : undefined;
  const explicitMs = item.start_ms !== undefined || item.end_ms !== undefined;
  const start = item.start_ms ?? item.start_time ?? item.start ?? timestamp?.[0];
  const end = item.end_ms ?? item.end_time ?? item.end ?? timestamp?.[1];
  return [{
    startMs: timeToMs(start, explicitMs ? "milliseconds" : unit),
    endMs: timeToMs(end, explicitMs ? "milliseconds" : unit),
    text,
    speaker: stringValue(item.speaker) ?? stringValue(item.speaker_id),
    confidence: numberValue(item.confidence) ?? numberValue(item.probability)
  }];
}

function wordsToGroups(words: unknown[]): unknown[] {
  const normalized = words.flatMap((value) => normalizeItem(value, "auto"));
  if (normalized.length === 0) return [];
  const groups: Array<Record<string, unknown>> = [];
  let current: Record<string, unknown> | undefined;
  for (const word of normalized) {
    const text = word.text.trim();
    if (!current || String(current.text ?? "").length >= 120
      || ((word.startMs ?? 0) - Number(current.end_ms ?? word.startMs ?? 0)) > 1500) {
      current = { text, start_ms: word.startMs, end_ms: word.endMs, speaker: word.speaker };
      groups.push(current);
    } else {
      current.text = `${String(current.text ?? "")}${needsSpace(String(current.text ?? ""), text) ? " " : ""}${text}`;
      current.end_ms = word.endMs ?? current.end_ms;
    }
  }
  return groups;
}

function firstArray(record: Record<string, unknown> | undefined, keys: string[]): unknown[] {
  for (const key of keys) if (Array.isArray(record?.[key])) return record[key] as unknown[];
  return [];
}

function timeToMs(value: unknown, unit: TimestampUnit): number | undefined {
  const number = numberValue(value);
  if (number === undefined) return undefined;
  if (unit === "milliseconds") return Math.round(number);
  // Standard Whisper/OpenAI fields are seconds. Explicit *_ms fields bypass this branch.
  return Math.round(number * 1000);
}

function inferredUnit(
  root: Record<string, unknown> | undefined,
  values: unknown[],
  configured: TimestampUnit
): TimestampUnit {
  if (configured !== "auto") return configured;
  const duration = numberValue(root?.duration);
  const times = values.flatMap((value) => {
    const item = recordValue(value);
    if (!item || item.start_ms !== undefined || item.end_ms !== undefined) return [];
    const timestamp = Array.isArray(item.timestamp) ? item.timestamp : [];
    return [item.start, item.start_time, item.end, item.end_time, ...timestamp]
      .flatMap((candidate) => numberValue(candidate) === undefined ? [] : [numberValue(candidate)!]);
  });
  const maximum = Math.max(0, ...times);
  if (duration !== undefined && duration > 0 && maximum > duration * 10) return "milliseconds";
  return maximum >= 10_000 ? "milliseconds" : "seconds";
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

function needsSpace(left: string, right: string): boolean {
  return /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right);
}
