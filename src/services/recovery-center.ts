import type { DataAdapter } from "obsidian";

import type { RecoveryItem, RecoveryOverview, SourceManifest } from "../types";
import { PendingPlanStore } from "./pending-plan-store";
import { atomicReplaceText } from "./source-store";

interface ManifestInspection {
  manifests: SourceManifest[];
  errors: Array<{ path: string; message: string }>;
}

interface TransactionMetadata {
  id?: string;
  kind?: "apply" | "rollback";
  status?: "prepared" | "applying";
  createdAt?: string;
}

/**
 * Read-only aggregation over the existing durable recovery records.
 *
 * The recovery center deliberately does not persist another state machine:
 * journals, Pending Plan, ParseAttempt and media checkpoints remain the facts.
 */
export class RecoveryCenterService {
  constructor(
    private readonly adapter: DataAdapter,
    private readonly internalRoot: string,
    private readonly inspectManifests: () => Promise<ManifestInspection>
  ) {}

  async inspect(): Promise<RecoveryOverview> {
    const pendingPlanItems = await this.inspectPendingPlan();
    const hasRestorablePendingPlan = pendingPlanItems.some((item) =>
      item.kind === "pending-plan" && item.severity !== "error");
    const items = [
      ...await this.inspectTransactions(),
      ...pendingPlanItems,
      ...await this.inspectSources(hasRestorablePendingPlan)
    ].sort(compareRecoveryItems);
    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      healthy: items.length === 0,
      counts: {
        total: items.length,
        recoverable: items.filter((item) => item.action !== "none").length,
        blocked: items.filter((item) => item.severity === "error").length
      },
      items
    };
  }

  async writeDiagnostic(overview: RecoveryOverview): Promise<string> {
    const timestamp = overview.generatedAt.replace(/[:.]/g, "-");
    const path = `${this.internalRoot}/diagnostics/recovery-${timestamp}.json`;
    const diagnostic = {
      version: 1,
      generatedAt: overview.generatedAt,
      healthy: overview.healthy,
      counts: overview.counts,
      items: overview.items.map((item) => ({
        id: safeDiagnosticId(item.id),
        kind: item.kind,
        severity: item.severity,
        title: redactDiagnosticText(item.title),
        detail: redactDiagnosticText(item.detail),
        action: item.action,
        ...(item.sourceId ? { sourceId: safeDiagnosticId(item.sourceId) } : {}),
        ...(item.operationId ? { operationId: safeDiagnosticId(item.operationId) } : {}),
        ...(item.createdAt ? { createdAt: item.createdAt } : {}),
        ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}),
        ...(item.progress ? { progress: item.progress } : {})
      }))
    };
    await atomicReplaceText(this.adapter, path, `${JSON.stringify(diagnostic, null, 2)}\n`);
    return path;
  }

  private async inspectTransactions(): Promise<RecoveryItem[]> {
    const root = `${this.internalRoot}/transactions`;
    if (!(await this.adapter.exists(root))) return [];
    let listing: Awaited<ReturnType<DataAdapter["list"]>>;
    try {
      listing = await this.adapter.list(root);
    } catch (error) {
      return [blockedItem(
        "transaction:listing",
        "transaction",
        "事务目录无法读取",
        diagnosticError(error)
      )];
    }
    const groups = new Map<string, Set<string>>();
    for (const path of listing.files.filter((item) => /(?:\.json|\.recovery\.json|\.fault\.json)$/.test(item))) {
      const base = path.replace(/(?:\.recovery|\.fault)?\.json$/, "");
      const files = groups.get(base) ?? new Set<string>();
      files.add(path);
      groups.set(base, files);
    }
    const items: RecoveryItem[] = [];
    for (const [base, files] of groups) {
      const operationId = base.split("/").pop() ?? "unknown";
      const faultPath = [...files].find((path) => path.endsWith(".fault.json"));
      if (faultPath) {
        const fault = await this.readObject(faultPath);
        items.push({
          id: `transaction:${operationId}`,
          kind: "transaction",
          severity: "error",
          title: "Wiki 事务需要处理",
          detail: redactDiagnosticText(String(fault?.error ?? "事务日志及恢复副本无法自动校验")),
          action: "recover-transactions",
          operationId: safeDiagnosticId(operationId),
          ...(typeof fault?.detectedAt === "string" ? { updatedAt: fault.detectedAt } : {})
        });
        continue;
      }
      const metadata = await this.readTransactionMetadata(files);
      items.push({
        id: `transaction:${operationId}`,
        kind: "transaction",
        severity: "warning",
        title: metadata.kind === "rollback" ? "回滚事务尚未完成" : "Wiki 写入事务尚未完成",
        detail: metadata.status === "applying" ? "事务在写入阶段中断，可按文件 Hash 自动判定并恢复。" : "事务已准备但尚未完成。",
        action: "recover-transactions",
        operationId: safeDiagnosticId(metadata.id ?? operationId),
        ...(metadata.createdAt ? { createdAt: metadata.createdAt } : {})
      });
    }
    return items;
  }

  private async inspectPendingPlan(): Promise<RecoveryItem[]> {
    const path = `${this.internalRoot}/pending-plan.json`;
    if (!(await this.adapter.exists(path))) return [];
    try {
      const stored = await new PendingPlanStore(this.adapter, path).load();
      if (!stored) return [];
      return [{
        id: `pending-plan:${safeDiagnosticId(stored.plan.operationId)}`,
        kind: "pending-plan",
        severity: "info",
        title: "Ingest 计划等待审阅",
        detail: `${stored.plan.operations.length} 个 Wiki 变更、${stored.attempts.length} 个来源，可恢复到 Diff 审阅。`,
        action: "restore-pending-plan",
        operationId: safeDiagnosticId(stored.plan.operationId),
        createdAt: stored.savedAt
      }];
    } catch (error) {
      return [blockedItem(
        "pending-plan:corrupt",
        "pending-plan",
        "待审核计划无法读取",
        diagnosticError(error)
      )];
    }
  }

  private async inspectSources(hasRestorablePendingPlan: boolean): Promise<RecoveryItem[]> {
    let inspection: ManifestInspection;
    try {
      inspection = await this.inspectManifests();
    } catch (error) {
      return [blockedItem("manifest:listing", "manifest", "来源状态无法读取", diagnosticError(error))];
    }
    const items: RecoveryItem[] = inspection.errors.map((error, index) => blockedItem(
      `manifest:corrupt:${index}`,
      "manifest",
      "来源 Manifest 损坏",
      `${safeRelativePath(error.path)}：${diagnosticError(error.message)}`
    ));
    for (const manifest of inspection.manifests) {
      if (manifest.ingest.status === "awaiting_review" && !hasRestorablePendingPlan) {
        const attempt = [...manifest.ingest.attempts].reverse().find((candidate) => candidate.status === "awaiting_review");
        items.push({
          id: `pending-plan:missing:${manifest.sourceId}`,
          kind: "pending-plan",
          severity: "error",
          title: "待审核状态缺少变更计划",
          detail: "来源仍标记为 awaiting_review，但持久化 Pending Plan 不存在或已损坏；系统不会猜测待写入内容。",
          action: "none",
          sourceId: manifest.sourceId,
          operationId: attempt?.operationId,
          updatedAt: attempt?.completedAt ?? attempt?.startedAt
        });
      }
      const attempts = [...manifest.parse.attempts].reverse();
      const pending = attempts.find((attempt) => Boolean(attempt.pendingRevision));
      if (pending?.pendingRevision) {
        items.push({
          id: `raw-publication:${manifest.sourceId}`,
          kind: "raw-publication",
          severity: manifest.parse.error?.code === "PUBLISH_RECOVERY_REQUIRED" ? "error" : "warning",
          title: "Raw 发布尚未提交",
          detail: manifest.parse.error?.code === "PUBLISH_RECOVERY_REQUIRED"
            ? redactDiagnosticText(manifest.parse.error.message)
            : `Parse Revision ${pending.pendingRevision.revision} 已生成，等待重新校验并提交 Manifest。`,
          action: "recover-raw-publication",
          sourceId: manifest.sourceId,
          updatedAt: manifest.parse.error?.at ?? pending.completedAt ?? pending.startedAt
        });
        continue;
      }
      const resumable = attempts.find((attempt) => attempt.parserId === "media-transcription" && Boolean(attempt.resumeToken));
      if (resumable) {
        const progress = await this.mediaProgress(resumable.resumeToken!);
        items.push({
          id: `media-resume:${manifest.sourceId}`,
          kind: "media-resume",
          severity: progress.expired ? "error" : "warning",
          title: progress.expired ? "媒体断点已过期" : "音视频解析可以继续",
          detail: progress.detail,
          action: progress.expired ? "none" : "resume-media",
          sourceId: manifest.sourceId,
          updatedAt: progress.updatedAt ?? resumable.completedAt ?? resumable.startedAt,
          ...(progress.counts ? { progress: progress.counts } : {})
        });
        continue;
      }
      if (manifest.parse.status === "parse_failed" && manifest.parse.error?.retryable) {
        const isMedia = manifest.source.kind === "audio" || manifest.source.kind === "video";
        items.push({
          id: `parse-retry:${manifest.sourceId}`,
          kind: "parse-retry",
          severity: "warning",
          title: "来源解析可以重试",
          detail: `${manifest.parse.error.code}：${redactDiagnosticText(manifest.parse.error.message)}`,
          action: isMedia ? "resume-media" : "retry-parse",
          sourceId: manifest.sourceId,
          updatedAt: manifest.parse.error.at
        });
      }
    }
    return items;
  }

  private async readTransactionMetadata(files: Set<string>): Promise<TransactionMetadata> {
    for (const path of [...files].filter((item) => !item.endsWith(".fault.json"))) {
      const value = await this.readObject(path);
      if (value) return value as TransactionMetadata;
    }
    return {};
  }

  private async mediaProgress(token: string): Promise<{
    detail: string;
    counts?: { completed: number; total: number };
    updatedAt?: string;
    expired: boolean;
  }> {
    try {
      const parsed = JSON.parse(token) as { jobId?: unknown };
      const jobId = typeof parsed.jobId === "string" && /^[a-f0-9]{32}$/i.test(parsed.jobId) ? parsed.jobId : undefined;
      if (!jobId) throw new Error("媒体断点 ID 无效");
      const value = await this.readObject(`${this.internalRoot}/media-jobs/${jobId}/job.json`);
      if (!value || !Array.isArray(value.chunks)) throw new Error("媒体断点索引不存在或损坏");
      const total = value.chunks.length;
      const completed = value.chunks.filter((chunk) => {
        const status = chunk && typeof chunk === "object" ? (chunk as { status?: unknown }).status : undefined;
        return status === "completed" || status === "empty";
      }).length;
      const expiresAt = typeof value.expiresAt === "string" ? value.expiresAt : undefined;
      const expired = !expiresAt || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now();
      return {
        detail: expired
          ? `已完成 ${completed}/${total} 个分片，但断点已过期；原始媒体仍保留，可重新开始解析。`
          : `已完成 ${completed}/${total} 个分片；继续前需要重新确认远程上传。`,
        counts: { completed, total },
        updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined,
        expired
      };
    } catch (error) {
      return { detail: diagnosticError(error), expired: true };
    }
  }

  private async readObject(path: string): Promise<Record<string, unknown> | null> {
    try {
      const value: unknown = JSON.parse(await this.adapter.read(path));
      return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
}

function blockedItem(id: string, kind: RecoveryItem["kind"], title: string, detail: string): RecoveryItem {
  return { id, kind, severity: "error", title, detail, action: "none" };
}

function compareRecoveryItems(left: RecoveryItem, right: RecoveryItem): number {
  const priority = { error: 0, warning: 1, info: 2 } as const;
  return priority[left.severity] - priority[right.severity]
    || (right.updatedAt ?? right.createdAt ?? "").localeCompare(left.updatedAt ?? left.createdAt ?? "")
    || left.id.localeCompare(right.id);
}

function diagnosticError(error: unknown): string {
  return redactDiagnosticText(error instanceof Error ? error.message : String(error));
}

function safeRelativePath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return /^(?:\.llm-wiki|raw|wiki|notes\/t-wiki)\//.test(normalized) ? normalized : "<internal-path>";
}

function safeDiagnosticId(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9:_-]/g, "").slice(0, 120);
  return safe || "unknown";
}

export function redactDiagnosticText(value: string): string {
  return value
    .replace(/\b(?:sk|api|token)[-_][a-z0-9_-]{12,}\b/gi, "<redacted-token>")
    .replace(/\b(authorization)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, "$1=<redacted>")
    .replace(/\b(api[_-]?key|token)\s*[:=]\s*[^\s,;]+/gi, "$1=<redacted>")
    .replace(/https?:\/\/[^\s]+/gi, (url) => {
      try {
        const parsed = new URL(url);
        return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
      } catch {
        return "<redacted-url>";
      }
    })
    .replace(/\b[A-Za-z]:\\[^\r\n;]+/g, "<local-path>")
    .slice(0, 1_000);
}
