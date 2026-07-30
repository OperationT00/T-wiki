import type { IngestProgressSnapshot, SourceManifest } from "../types";

export type PipelineStepState = "completed" | "active" | "pending" | "failed";
export type PipelineStepId = "import" | "parse" | "ingest" | "review" | "write";

export interface PipelineStep {
  id: PipelineStepId;
  label: string;
  state: PipelineStepState;
}

export function sourcePipelineSteps(
  source: SourceManifest,
  progress?: IngestProgressSnapshot
): PipelineStep[] {
  const effectiveIngest = progress?.state ?? source.ingest.status;
  const parse = parseState(source.parse.status);
  const ingest = ingestState(effectiveIngest);
  const review: PipelineStepState = effectiveIngest === "awaiting_review"
    ? "active"
    : effectiveIngest === "completed" || effectiveIngest === "ingested"
      ? "completed"
      : "pending";
  const write: PipelineStepState = effectiveIngest === "completed" || effectiveIngest === "ingested"
    ? "completed"
    : "pending";
  return [
    { id: "import", label: "原件导入", state: "completed" },
    { id: "parse", label: "文档解析", state: parse },
    { id: "ingest", label: "Wiki 吸收", state: ingest },
    { id: "review", label: "Diff 审阅", state: review },
    { id: "write", label: "写入 Wiki", state: write }
  ];
}

function parseState(status: SourceManifest["parse"]["status"]): PipelineStepState {
  if (status === "parsed") return "completed";
  if (status === "parse_failed" || status === "needs_ocr") return "failed";
  if (status === "parsing") return "active";
  return "pending";
}

function ingestState(
  status: SourceManifest["ingest"]["status"] | IngestProgressSnapshot["state"]
): PipelineStepState {
  if (status === "ingested" || status === "completed" || status === "awaiting_review") return "completed";
  if (status === "planning" || status === "running") return "active";
  if (status === "ingest_failed" || status === "failed" || status === "cancelled") return "failed";
  return "pending";
}
