import type { AgentRunTrace } from "../agent/agent-loop";

export type AcceptanceCategory = "ingest" | "query" | "parse" | "media";
export type AcceptanceAggregation = "mean" | "p50" | "p95" | "min" | "max";
export type AcceptanceOperator = "lte" | "gte";

export interface AcceptanceThreshold {
  metric: string;
  label: string;
  unit: "ms" | "count" | "tokens" | "ratio" | "mib" | "per-minute";
  aggregation: AcceptanceAggregation;
  operator: AcceptanceOperator;
  target: number;
}

export interface AcceptanceScenario {
  id: string;
  category: AcceptanceCategory;
  title: string;
  description: string;
  minimumSamples: number;
  thresholds: AcceptanceThreshold[];
}

export interface AcceptanceSuite {
  schemaVersion: 1;
  suiteId: string;
  title: string;
  scenarios: AcceptanceScenario[];
}

export interface AcceptanceSample {
  schemaVersion: 1;
  scenarioId: string;
  runId: string;
  recordedAt: string;
  origin: "measured" | "manual-review";
  metrics: Record<string, number>;
}

export interface AcceptanceSampleSet {
  schemaVersion: 1;
  suiteId: string;
  samples: AcceptanceSample[];
}

export interface AcceptanceMetricResult extends AcceptanceThreshold {
  value?: number;
  sampleCount: number;
  passed: boolean;
  reason?: string;
}

export interface AcceptanceScenarioResult {
  id: string;
  category: AcceptanceCategory;
  title: string;
  sampleCount: number;
  minimumSamples: number;
  passed: boolean;
  metrics: AcceptanceMetricResult[];
}

export interface AcceptanceReport {
  schemaVersion: 1;
  suiteId: string;
  generatedAt: string;
  passed: boolean;
  summary: {
    scenarioCount: number;
    passedScenarios: number;
    failedScenarios: number;
    sampleCount: number;
  };
  scenarios: AcceptanceScenarioResult[];
}

export interface QueryManualAssessment {
  expectedRelevantPages: number;
  relevantPagesRead: number;
  citedClaims: number;
  verifiedCitedClaims: number;
  factualClaims: number;
  unsupportedClaims: number;
  requiredGraphHops: number;
}

export interface IngestManualAssessment {
  expectedKnowledgeUnits: number;
  matchedKnowledgeUnits: number;
  generatedKnowledgePages: number;
  duplicateKnowledgePages: number;
}

export interface AcceptanceAssessment {
  ingest?: IngestManualAssessment;
  query?: QueryManualAssessment;
}

export interface ParseAcceptanceMeasurement {
  runId: string;
  recordedAt: string;
  durationMs?: number;
  throughputPerMinute?: number;
  queueWaitMs?: number;
  peakMemoryMiB?: number;
  recoverySuccess?: number;
  orphanArtifactRate?: number;
}

export interface MediaAcceptanceMeasurement {
  runId: string;
  recordedAt: string;
  durationMs?: number;
  overlapResolutionRate?: number;
  contentConservationRate?: number;
  paragraphReadability?: number;
  timestampAccuracy?: number;
  timelineOrderRate?: number;
}

export function evaluateAcceptance(
  suite: AcceptanceSuite,
  sampleSet: AcceptanceSampleSet,
  generatedAt = new Date().toISOString()
): AcceptanceReport {
  validateSuite(suite);
  validateSampleSet(sampleSet, suite);
  const scenarios = suite.scenarios.map((scenario): AcceptanceScenarioResult => {
    const samples = sampleSet.samples.filter((sample) => sample.scenarioId === scenario.id);
    const enoughSamples = samples.length >= scenario.minimumSamples;
    const metrics = scenario.thresholds.map((threshold): AcceptanceMetricResult => {
      const values = samples
        .map((sample) => sample.metrics[threshold.metric])
        .filter((value): value is number => Number.isFinite(value));
      if (values.length !== samples.length || values.length === 0) {
        return { ...threshold, sampleCount: values.length, passed: false, reason: "缺少有效指标样本" };
      }
      const value = aggregate(values, threshold.aggregation);
      return {
        ...threshold,
        value,
        sampleCount: values.length,
        passed: enoughSamples && compare(value, threshold.operator, threshold.target),
        ...(!enoughSamples ? { reason: `样本不足：需要 ${scenario.minimumSamples}，实际 ${samples.length}` } : {})
      };
    });
    return {
      id: scenario.id,
      category: scenario.category,
      title: scenario.title,
      sampleCount: samples.length,
      minimumSamples: scenario.minimumSamples,
      passed: enoughSamples && metrics.every((metric) => metric.passed),
      metrics
    };
  });
  const passedScenarios = scenarios.filter((scenario) => scenario.passed).length;
  return {
    schemaVersion: 1,
    suiteId: suite.suiteId,
    generatedAt,
    passed: passedScenarios === scenarios.length,
    summary: {
      scenarioCount: scenarios.length,
      passedScenarios,
      failedScenarios: scenarios.length - passedScenarios,
      sampleCount: sampleSet.samples.length
    },
    scenarios
  };
}

export function agentTraceSample(
  scenarioId: string,
  trace: AgentRunTrace,
  assessment: AcceptanceAssessment = {}
): AcceptanceSample {
  const durationMs = elapsedMs(trace.startedAt, trace.completedAt);
  const common: Record<string, number> = {
    durationMs,
    providerRequests: trace.providerRequests?.length ?? trace.iterations,
    inputTokens: trace.inputTokens,
    outputTokens: trace.outputTokens
  };
  if (trace.purpose === "ingest") {
    const completion = trace.candidateCompletion;
    const reads = trace.readStats;
    const decisions = trace.ingestCoverage?.decisions ?? [];
    const evidenceDecisions = decisions.filter((decision) => decision.evidence.length > 0).length;
    common.candidateCompletionRate = ratio(completion?.completed ?? 0, completion?.total ?? 0, 1);
    common.duplicateWikiReadRate = ratio(reads?.wikiDuplicate ?? 0, (reads?.wikiUnique ?? 0) + (reads?.wikiDuplicate ?? 0));
    common.evidencePassRate = ratio(evidenceDecisions, decisions.length, 1);
    if (assessment.ingest) {
      common.candidateRecall = ratio(
        assessment.ingest.matchedKnowledgeUnits,
        assessment.ingest.expectedKnowledgeUnits,
        1
      );
      common.duplicatePageRate = ratio(
        assessment.ingest.duplicateKnowledgePages,
        assessment.ingest.generatedKnowledgePages
      );
    }
  }
  if (trace.purpose === "query") {
    if (!assessment.query) throw new Error("Query 验收样本必须提供人工/固定答案评估");
    common.relevantPageRecall = ratio(assessment.query.relevantPagesRead, assessment.query.expectedRelevantPages, 1);
    common.citationAccuracy = ratio(assessment.query.verifiedCitedClaims, assessment.query.citedClaims, 1);
    common.unsupportedClaimRate = ratio(assessment.query.unsupportedClaims, assessment.query.factualClaims);
    const achievedHop = Math.max(0, ...((trace.query?.graphTraversals ?? []).map((edge) => edge.hop)));
    common.multiHopSuccess = achievedHop >= assessment.query.requiredGraphHops ? 1 : 0;
    common.wikiReads = trace.query?.wikiReads.length ?? 0;
  }
  return {
    schemaVersion: 1,
    scenarioId,
    runId: trace.sessionId,
    recordedAt: trace.completedAt || new Date().toISOString(),
    origin: assessment.ingest || assessment.query ? "manual-review" : "measured",
    metrics: common
  };
}

export function parseAcceptanceSample(
  scenarioId: string,
  measurement: ParseAcceptanceMeasurement
): AcceptanceSample {
  return measurementSample(scenarioId, measurement);
}

export function mediaAcceptanceSample(
  scenarioId: string,
  measurement: MediaAcceptanceMeasurement,
  origin: AcceptanceSample["origin"] = "measured"
): AcceptanceSample {
  return measurementSample(scenarioId, measurement, origin);
}

export function aggregate(values: number[], aggregation: AcceptanceAggregation): number {
  if (values.length === 0) throw new Error("无法聚合空指标集合");
  const sorted = [...values].sort((left, right) => left - right);
  if (aggregation === "min") return sorted[0]!;
  if (aggregation === "max") return sorted.at(-1)!;
  if (aggregation === "mean") return sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return percentile(sorted, aggregation === "p50" ? 0.5 : 0.95);
}

function percentile(sorted: number[], quantile: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const fraction = position - lower;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * fraction;
}

function compare(value: number, operator: AcceptanceOperator, target: number): boolean {
  return operator === "lte" ? value <= target : value >= target;
}

function elapsedMs(startedAt: string, completedAt: string): number {
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error("Agent trace 时间范围无效");
  return end - start;
}

function ratio(numerator: number, denominator: number, emptyValue = 0): number {
  if (denominator <= 0) return emptyValue;
  return Math.max(0, Math.min(1, numerator / denominator));
}

function validateSuite(suite: AcceptanceSuite): void {
  if (suite.schemaVersion !== 1 || !safeId(suite.suiteId)) throw new Error("验收集版本或 ID 无效");
  if (suite.scenarios.length === 0) throw new Error("验收集不能为空");
  const ids = new Set<string>();
  for (const scenario of suite.scenarios) {
    if (!safeId(scenario.id) || ids.has(scenario.id)) throw new Error(`验收场景 ID 无效或重复：${scenario.id}`);
    ids.add(scenario.id);
    if (!Number.isInteger(scenario.minimumSamples) || scenario.minimumSamples < 1 || scenario.minimumSamples > 100) {
      throw new Error(`验收场景样本数无效：${scenario.id}`);
    }
    if (scenario.thresholds.length === 0) throw new Error(`验收场景没有指标：${scenario.id}`);
    const metrics = new Set<string>();
    for (const threshold of scenario.thresholds) {
      if (!safeId(threshold.metric) || metrics.has(threshold.metric) || !Number.isFinite(threshold.target)) {
        throw new Error(`验收指标无效或重复：${scenario.id}/${threshold.metric}`);
      }
      if (threshold.unit === "ratio" && (threshold.target < 0 || threshold.target > 1)) {
        throw new Error(`比例阈值超出 0–1：${scenario.id}/${threshold.metric}`);
      }
      if (threshold.unit !== "ratio" && threshold.target < 0) {
        throw new Error(`验收阈值不能为负数：${scenario.id}/${threshold.metric}`);
      }
      metrics.add(threshold.metric);
    }
  }
}

function validateSampleSet(sampleSet: AcceptanceSampleSet, suite: AcceptanceSuite): void {
  if (sampleSet.schemaVersion !== 1 || sampleSet.suiteId !== suite.suiteId) throw new Error("验收样本与验收集不匹配");
  const scenarioIds = new Set(suite.scenarios.map((scenario) => scenario.id));
  const runKeys = new Set<string>();
  for (const sample of sampleSet.samples) {
    if (sample.schemaVersion !== 1 || !scenarioIds.has(sample.scenarioId) || !safeId(sample.runId)) {
      throw new Error(`验收样本标识无效：${sample.scenarioId}/${sample.runId}`);
    }
    const key = `${sample.scenarioId}:${sample.runId}`;
    if (runKeys.has(key)) throw new Error(`验收样本重复：${key}`);
    runKeys.add(key);
    if (!Number.isFinite(Date.parse(sample.recordedAt))) throw new Error(`验收样本时间无效：${key}`);
    const scenario = suite.scenarios.find((candidate) => candidate.id === sample.scenarioId)!;
    const thresholdByMetric = new Map(scenario.thresholds.map((threshold) => [threshold.metric, threshold]));
    for (const [metric, value] of Object.entries(sample.metrics)) {
      if (!safeId(metric) || !Number.isFinite(value)) throw new Error(`验收样本指标无效：${key}/${metric}`);
      const threshold = thresholdByMetric.get(metric);
      if (threshold?.unit === "ratio" && (value < 0 || value > 1)) throw new Error(`比例指标超出 0–1：${key}/${metric}`);
      if (threshold && threshold.unit !== "ratio" && value < 0) throw new Error(`验收指标不能为负数：${key}/${metric}`);
    }
  }
}

function measurementSample(
  scenarioId: string,
  measurement: ParseAcceptanceMeasurement | MediaAcceptanceMeasurement,
  origin: AcceptanceSample["origin"] = "measured"
): AcceptanceSample {
  const metrics: Record<string, number> = {};
  for (const [key, value] of Object.entries(measurement)) {
    if (key === "runId" || key === "recordedAt" || value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`验收指标无效：${scenarioId}/${key}`);
    metrics[key] = value;
  }
  return {
    schemaVersion: 1,
    scenarioId,
    runId: measurement.runId,
    recordedAt: measurement.recordedAt,
    origin,
    metrics
  };
}

function safeId(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value);
}
