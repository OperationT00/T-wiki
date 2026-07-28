import { normalizeVaultPath, parseMarkdown } from "../core/wiki-core";
import type {
  EvidenceReference,
  IngestCoverageReport,
  KnowledgeDecision,
  KnowledgeDecisionStatus
} from "../types";
import type { ToolExecutionContext } from "./tools";

const KNOWLEDGE_TYPES = ["entity", "concept", "synthesis"] as const;
const MODEL_DECISIONS: KnowledgeDecisionStatus[] = [
  "created", "updated", "already_covered", "source_only", "insufficient_evidence"
];

export class IngestCoverageValidationError extends Error {
  readonly code = "INGEST_COVERAGE_INVALID";

  constructor(message: string, public readonly details: Record<string, unknown>) {
    super(message);
    this.name = "IngestCoverageValidationError";
  }
}

/**
 * Reconciles objective WorkingSet operations into the model-authored report.
 * The model still owns semantic no-change decisions; the host only fills facts
 * that are already proven by a staged page and its raw Evidence references.
 */
export function reconcileIngestCoverage(
  input: unknown,
  context: ToolExecutionContext
): unknown {
  if (!input || typeof input !== "object") return input;
  const report = structuredClone(input) as Partial<IngestCoverageReport>;
  if (!Array.isArray(report.decisions) || !Array.isArray(report.categoryAssessments)) return report;

  // Source pages are mandatory host-managed operations, not Entity/Concept/Synthesis
  // candidates. Compatible models frequently include them despite the schema prompt.
  report.decisions = report.decisions.flatMap((decision) => {
    const targetPath = decision?.targetPath ? normalizeVaultPath(decision.targetPath) : undefined;
    if (targetPath?.startsWith("wiki/sources/") || targetPath?.startsWith("wiki/source/")) return [];
    const pathType = targetPath ? typeForPath(targetPath) : undefined;
    return [{ ...decision, ...(pathType ? { type: pathType } : {}) }];
  });

  // Keep assessments consistent after filtering Source candidates or correcting a
  // model-supplied type from the objective target directory.
  for (const assessment of report.categoryAssessments) {
    const hasDecision = report.decisions.some((decision) =>
      decision?.sourceId === assessment?.sourceId && decision.type === assessment.type);
    assessment.outcome = hasDecision ? "candidates_found" : "none";
    if (!String(assessment.reason ?? "").trim()) {
      assessment.reason = hasDecision
        ? "覆盖报告包含该类别的候选决策"
        : "没有保留该类别的有效知识候选";
    }
  }

  const knownIds = new Set(report.decisions.map((item) => String(item?.candidateId ?? "")));
  for (const page of context.workingSet.list()) {
    if (page.path.startsWith("wiki/sources/")) continue;
    const type = typeForPath(page.path);
    if (!type) continue;
    const alreadyRepresented = report.decisions.some((decision) => decision?.targetPath
      && normalizeVaultPath(decision.targetPath) === page.path
      && decision.decision === (page.action === "create" ? "created" : "updated"));
    if (alreadyRepresented) continue;

    const sourceIds = [...new Set(page.evidence.flatMap((evidence) =>
      evidence.sourceId && evidence.contentHash && evidence.sectionId && context.allowedSourceIds.has(evidence.sourceId)
        ? [evidence.sourceId]
        : []))];
    for (const sourceId of sourceIds) {
      const baseId = `host:${sourceId}:${page.path}`;
      let candidateId = baseId;
      let suffix = 2;
      while (knownIds.has(candidateId)) candidateId = `${baseId}:${suffix++}`;
      knownIds.add(candidateId);
      report.decisions.push({
        candidateId,
        sourceId,
        type,
        title: parseMarkdown(page.path, page.currentContent)?.title ?? titleFromPath(page.path),
        decision: page.action === "create" ? "created" : "updated",
        targetPath: page.path,
        reason: `宿主根据已验证 WorkingSet 自动补齐 ${page.action} 决策`,
        evidence: structuredClone(page.evidence)
      });
      const assessment = report.categoryAssessments.find((item) => item?.sourceId === sourceId && item.type === type);
      if (assessment) {
        assessment.outcome = "candidates_found";
        if (!String(assessment.reason ?? "").trim()) assessment.reason = "WorkingSet 包含该类别的已暂存知识页面";
      } else {
        report.categoryAssessments.push({
          sourceId, type, outcome: "candidates_found", reason: "WorkingSet 包含该类别的已暂存知识页面"
        });
      }
    }
  }
  return report;
}

export function validateIngestCoverage(
  input: unknown,
  context: ToolExecutionContext
): IngestCoverageReport {
  if (!input || typeof input !== "object") throw new Error("Ingest 必须提交知识覆盖报告");
  const report = structuredClone(input) as IngestCoverageReport;
  if (!Array.isArray(report.sources) || !Array.isArray(report.categoryAssessments) || !Array.isArray(report.decisions)) {
    throw new Error("知识覆盖报告结构无效");
  }
  const expectedSources = [...context.allowedSourceIds].sort();
  if (expectedSources.length === 0) throw new Error("当前命令不需要 Ingest 覆盖报告");

  const sourceIds = unique(report.sources.map((item) => item?.sourceId), "覆盖报告 sourceId").sort();
  if (JSON.stringify(sourceIds) !== JSON.stringify(expectedSources)) {
    throw new Error("知识覆盖报告必须且只能覆盖本次全部来源");
  }
  for (const source of report.sources) {
    if (!/^[a-f0-9]{64}$/.test(String(source.contentHash ?? ""))) throw new Error(`来源 ${source.sourceId} contentHash 无效`);
    if (!Array.isArray(source.reviewedSectionIds) || source.reviewedSectionIds.length === 0) {
      throw new Error(`来源 ${source.sourceId} 至少需要读取一个 raw section`);
    }
    unique(source.reviewedSectionIds, `来源 ${source.sourceId} reviewedSectionIds`);
    for (const sectionId of source.reviewedSectionIds) {
      if (!context.evidenceLedger.hasRaw(source.sourceId, source.contentHash, sectionId)) {
        throw new Error(`来源 ${source.sourceId} 声明了未读取的 raw section：${sectionId}`);
      }
    }
  }

  const assessments = new Set<string>();
  for (const item of report.categoryAssessments) {
    if (!expectedSources.includes(item?.sourceId)) throw new Error(`分类评估包含未知来源：${item?.sourceId ?? ""}`);
    if (!KNOWLEDGE_TYPES.includes(item?.type)) throw new Error(`分类评估类型无效：${item?.type ?? ""}`);
    if (item.outcome !== "candidates_found" && item.outcome !== "none") throw new Error("分类评估 outcome 无效");
    if (!String(item.reason ?? "").trim()) throw new Error(`分类评估缺少原因：${item.sourceId}/${item.type}`);
    const key = `${item.sourceId}\u0000${item.type}`;
    if (assessments.has(key)) throw new Error(`分类评估重复：${item.sourceId}/${item.type}`);
    assessments.add(key);
  }
  for (const sourceId of expectedSources) {
    for (const type of KNOWLEDGE_TYPES) {
      if (!assessments.has(`${sourceId}\u0000${type}`)) throw new Error(`缺少分类评估：${sourceId}/${type}`);
    }
  }

  const staged = new Map(context.workingSet.list().map((page) => [page.path, page]));
  const candidateIds = new Set<string>();
  const representedPaths = new Set<string>();
  for (const decision of report.decisions) {
    validateDecision(decision, expectedSources, context, staged);
    if (candidateIds.has(decision.candidateId)) throw new Error(`candidateId 重复：${decision.candidateId}`);
    candidateIds.add(decision.candidateId);
    if (decision.targetPath && (decision.decision === "created" || decision.decision === "updated")) {
      representedPaths.add(normalizeVaultPath(decision.targetPath));
    }
  }
  for (const assessment of report.categoryAssessments) {
    const found = report.decisions.some((decision) =>
      decision.sourceId === assessment.sourceId && decision.type === assessment.type
    );
    if (assessment.outcome === "candidates_found" && !found) {
      throw new Error(`分类声明发现候选但没有决策：${assessment.sourceId}/${assessment.type}`);
    }
    if (assessment.outcome === "none" && found) {
      throw new Error(`分类声明无候选但存在决策：${assessment.sourceId}/${assessment.type}`);
    }
  }
  const missingPaths = [...staged.values()]
    .filter((page) => !page.path.startsWith("wiki/sources/") && !representedPaths.has(page.path))
    .map((page) => page.path);
  if (missingPaths.length > 0) {
    throw new IngestCoverageValidationError(
      `覆盖报告遗漏 ${missingPaths.length} 个暂存知识页面：${missingPaths.join("，")}`,
      { missingPaths, stagedPaths: [...staged.keys()] }
    );
  }
  return report;
}

export function applyCoverageSelection(
  report: IngestCoverageReport | undefined,
  selectedPaths: Set<string>
): IngestCoverageReport | undefined {
  if (!report) return undefined;
  const next = structuredClone(report);
  next.decisions = next.decisions.map((decision) => {
    if ((decision.decision !== "created" && decision.decision !== "updated")
      || !decision.targetPath
      || selectedPaths.has(normalizeVaultPath(decision.targetPath))) return decision;
    return {
      ...decision,
      decision: "user_rejected" as const,
      reason: `用户在 Diff Review 中排除此变更。原判断：${decision.reason}`
    };
  });
  return next;
}

export function coverageForSource(
  report: IngestCoverageReport | undefined,
  sourceId: string
): IngestCoverageReport | undefined {
  if (!report) return undefined;
  return {
    sources: report.sources.filter((item) => item.sourceId === sourceId),
    categoryAssessments: report.categoryAssessments.filter((item) => item.sourceId === sourceId),
    decisions: report.decisions.filter((item) => item.sourceId === sourceId)
  };
}

export function hasUserExclusions(report: IngestCoverageReport | undefined): boolean {
  return Boolean(report?.decisions.some((item) => item.decision === "user_rejected"));
}

function validateDecision(
  decision: KnowledgeDecision,
  expectedSources: string[],
  context: ToolExecutionContext,
  staged: Map<string, ReturnType<ToolExecutionContext["workingSet"]["list"]>[number]>
): void {
  if (!decision || typeof decision !== "object") throw new Error("知识候选决策无效");
  if (!String(decision.candidateId ?? "").trim()) throw new Error("candidateId 不能为空");
  if (!expectedSources.includes(decision.sourceId)) throw new Error(`候选包含未知来源：${decision.sourceId}`);
  if (!KNOWLEDGE_TYPES.includes(decision.type)) throw new Error(`候选类型无效：${decision.type}`);
  if (!String(decision.title ?? "").trim()) throw new Error(`候选 ${decision.candidateId} title 不能为空`);
  if (!MODEL_DECISIONS.includes(decision.decision)) throw new Error(`模型不得提交决策：${decision.decision}`);
  if (!String(decision.reason ?? "").trim()) throw new Error(`候选 ${decision.candidateId} 缺少处理原因`);
  if (!Array.isArray(decision.evidence) || decision.evidence.length === 0) {
    throw new Error(`候选 ${decision.candidateId} 缺少 evidence`);
  }
  context.evidenceLedger.assertKnown(decision.evidence, true);
  if (!decision.evidence.some((item) => item.sourceId === decision.sourceId && item.contentHash && item.sectionId)) {
    throw new Error(`候选 ${decision.candidateId} 缺少当前来源 raw evidence`);
  }

  if (decision.decision === "created" || decision.decision === "updated") {
    const path = validateTargetPath(decision);
    const page = staged.get(path);
    if (!page || page.action !== (decision.decision === "created" ? "create" : "update")) {
      throw new Error(`候选 ${decision.candidateId} 与 WorkingSet 操作不一致`);
    }
  } else if (decision.decision === "already_covered") {
    const path = validateTargetPath(decision);
    if (!decision.evidence.some((item) => item.wikiPath === path && item.wikiHash
      && context.evidenceLedger.hasWiki(path, item.wikiHash))) {
      throw new Error(`候选 ${decision.candidateId} 的 already_covered 未绑定已读取 Wiki Hash`);
    }
  } else if (decision.targetPath) {
    validateTargetPath(decision);
  }
}

function validateTargetPath(decision: KnowledgeDecision): string {
  if (!decision.targetPath) throw new Error(`候选 ${decision.candidateId} 缺少 targetPath`);
  const path = normalizeVaultPath(decision.targetPath);
  const directory = decision.type === "entity" ? "entities" : decision.type === "concept" ? "concepts" : "synthesis";
  if (!path.startsWith(`wiki/${directory}/`) || !path.endsWith(".md")) {
    throw new Error(`候选 ${decision.candidateId} targetPath 与类型不匹配`);
  }
  return path;
}

function unique(values: unknown[], label: string): string[] {
  const normalized = values.map((value) => String(value ?? "").trim());
  if (normalized.some((value) => !value)) throw new Error(`${label} 包含空值`);
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} 包含重复值`);
  return normalized;
}

function typeForPath(path: string): KnowledgeDecision["type"] | undefined {
  if (path.startsWith("wiki/entities/")) return "entity";
  if (path.startsWith("wiki/concepts/")) return "concept";
  if (path.startsWith("wiki/synthesis/")) return "synthesis";
  return undefined;
}

function titleFromPath(path: string): string {
  return path.split("/").at(-1)?.replace(/\.md$/i, "").replace(/[-_]+/g, " ") ?? path;
}
