import type { ParseProgress, ParseProgressEvent } from "../types";

export type ParseProgressListener = (event: ParseProgressEvent) => void;

export interface ParseProgressIdentity {
  sourceId: string;
  sourceName: string;
  attemptId: string;
  parserId: string;
  parserVersion: string;
}

/**
 * Process-local delivery for responsive UI updates. Durable recovery remains
 * the responsibility of ParseAttempt.progress in the manifest.
 */
export class ParseProgressBus {
  private readonly listeners = new Set<ParseProgressListener>();
  private readonly latest = new Map<string, ParseProgressEvent>();

  publish(event: ParseProgressEvent): void {
    const snapshot = structuredClone(event);
    this.latest.set(event.sourceId, snapshot);
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(snapshot));
      } catch {
        // A UI listener must never interrupt parsing.
      }
    }
  }

  subscribe(listener: ParseProgressListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getLatest(sourceId: string): ParseProgressEvent | undefined {
    const event = this.latest.get(sourceId);
    return event ? structuredClone(event) : undefined;
  }
}

const STAGES: Record<string, { start: number; weight: number; fallback: string }> = {
  preparing: { start: 0, weight: 5, fallback: "正在准备原件" },
  probing: { start: 5, weight: 5, fallback: "正在选择解析器" },
  uploading: { start: 10, weight: 10, fallback: "正在上传文档" },
  parsing: { start: 10, weight: 70, fallback: "正在解析文档" },
  downloading: { start: 75, weight: 5, fallback: "正在下载解析结果" },
  normalizing: { start: 80, weight: 8, fallback: "正在标准化 Markdown" },
  quality_check: { start: 88, weight: 6, fallback: "正在执行质量检查" },
  publishing: { start: 94, weight: 5, fallback: "正在发布 raw Markdown" },
  verifying: { start: 99, weight: 1, fallback: "正在验证解析产物" },
  completed: { start: 100, weight: 0, fallback: "解析完成" }
};

export function createProgressEvent(
  identity: ParseProgressIdentity,
  update: ParseProgress,
  previous?: ParseProgressEvent,
  state: ParseProgressEvent["state"] = "running"
): ParseProgressEvent {
  const phase = normalizePhase(update.phase);
  const stage = STAGES[phase] ?? STAGES.parsing!;
  const hasExactTotal = finiteNonNegative(update.completed)
    && finitePositive(update.total);
  const fraction = hasExactTotal
    ? clamp(update.completed! / update.total!, 0, 1)
    : 0;
  const calculated = state === "completed"
    ? 100
    : Math.round(stage.start + stage.weight * fraction);
  const percent = Math.max(previous?.percent ?? 0, clamp(calculated, 0, 100));
  return {
    ...identity,
    phase,
    completed: finiteNonNegative(update.completed) ? update.completed : undefined,
    total: finitePositive(update.total) ? update.total : undefined,
    unit: update.unit,
    percent,
    mode: hasExactTotal || state === "completed" ? "determinate" : "indeterminate",
    precision: hasExactTotal ? "exact" : "stage",
    message: update.message?.trim() || stage.fallback,
    updatedAt: new Date().toISOString(),
    state
  };
}

export function persistedProgress(event: ParseProgressEvent): ParseProgress {
  return {
    phase: event.phase,
    completed: event.completed,
    total: event.total,
    unit: event.unit,
    percent: event.percent,
    mode: event.mode,
    precision: event.precision,
    message: event.message,
    updatedAt: event.updatedAt
  };
}

function normalizePhase(phase: string): string {
  switch (phase) {
    case "pdf":
    case "decode":
    case "extract":
    case "parse":
    case "mineru-poll":
      return "parsing";
    case "mineru-submit":
    case "mineru-upload":
      return "uploading";
    case "mineru-download":
      return "downloading";
    case "complete":
      return "parsing";
    default:
      return phase;
  }
}

function finiteNonNegative(value: number | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function finitePositive(value: number | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
