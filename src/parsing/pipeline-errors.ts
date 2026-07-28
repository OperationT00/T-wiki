import type { ParseIssue, PipelineError } from "../types";
import { ParserError } from "./parser-types";

export function toPipelineError(
  error: unknown,
  stage: PipelineError["stage"]
): PipelineError {
  if (isPipelineError(error)) return error;
  if (error instanceof ParserError) {
    return {
      stage,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: error.details,
      at: new Date().toISOString()
    };
  }
  if (error && typeof error === "object") {
    const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown };
    if (typeof candidate.code === "string"
      && typeof candidate.message === "string"
      && typeof candidate.retryable === "boolean") {
      return {
        stage,
        code: candidate.code,
        message: candidate.message,
        retryable: candidate.retryable,
        at: new Date().toISOString()
      };
    }
  }
  return {
    stage,
    code: stage === "ingest" || stage === "plan" ? "AGENT_RUNTIME_FAILED" : "UNEXPECTED_ERROR",
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
    at: new Date().toISOString()
  };
}

export function interruptedError(stage: "parse" | "ingest"): PipelineError {
  return {
    stage,
    code: "INTERRUPTED",
    message: stage === "parse" ? "应用重启中断了解析，可重新解析" : "应用重启中断了 Ingest，可重试",
    retryable: true,
    at: new Date().toISOString()
  };
}

export function errorIssue(code: string, message: string): ParseIssue {
  return { code, severity: "error", message };
}

function isPipelineError(value: unknown): value is PipelineError {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PipelineError>;
  return typeof candidate.stage === "string"
    && typeof candidate.code === "string"
    && typeof candidate.message === "string"
    && typeof candidate.retryable === "boolean"
    && typeof candidate.at === "string";
}
