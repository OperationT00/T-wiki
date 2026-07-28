import type {
  AgentEvent,
  IngestActivity,
  IngestProgressPhase,
  IngestProgressSnapshot,
  IngestProgressState
} from "../types";

export type IngestProgressListener = (snapshot: IngestProgressSnapshot) => void;

const MAX_ACTIVITIES = 50;

const TOOL_PRESENTATION: Record<string, { phase: IngestProgressPhase; label: string }> = {
  select_raw_sections: { phase: "reading_source", label: "选择原文章节" },
  analyze_ingest_sources: { phase: "reading_source", label: "提取知识候选" },
  repair_source_analysis: { phase: "reading_source", label: "修复候选提取结果" },
  complete_knowledge_merge: { phase: "retrieving_wiki", label: "比对并合并知识" },
  plan_wiki_links: { phase: "retrieving_wiki", label: "规划 Wiki 关联图谱" },
  repair_wiki_links: { phase: "retrieving_wiki", label: "修复关联图谱结构" },
  repair_merge_decisions: { phase: "drafting", label: "修复候选决策" },
  generate_wiki_page_drafts: { phase: "drafting", label: "生成 Wiki 页面草稿" },
  repair_wiki_page_drafts: { phase: "drafting", label: "修复 Wiki 页面草稿" },
  select_ambiguity_evidence: { phase: "retrieving_wiki", label: "补充歧义证据" },
  repair_wiki_pages: { phase: "validating", label: "修复 Wiki 草稿" },
  inspect_source: { phase: "reading_source", label: "检查来源" },
  list_raw_outline: { phase: "reading_source", label: "读取文档目录" },
  read_raw_section: { phase: "reading_source", label: "读取原文章节" },
  search_raw: { phase: "reading_source", label: "检索原文" },
  search_wiki: { phase: "retrieving_wiki", label: "搜索相关 Wiki" },
  read_wiki_page: { phase: "retrieving_wiki", label: "读取 Wiki 页面" },
  get_wiki_links: { phase: "retrieving_wiki", label: "检查 Wiki 链接" },
  get_page_template: { phase: "retrieving_wiki", label: "读取页面模板" },
  create_wiki_page: { phase: "drafting", label: "创建 Wiki 页面草稿" },
  edit_wiki_page: { phase: "drafting", label: "修改 Wiki 页面草稿" },
  inspect_changes: { phase: "validating", label: "检查暂存变更" },
  validate_working_set: { phase: "validating", label: "验证 Wiki 变更" },
  submit_changes: { phase: "submitting", label: "生成变更计划" },
  finish_without_changes: { phase: "submitting", label: "结束处理" },
  request_user_direction: { phase: "reading_source", label: "等待处理方向" }
};

export class IngestProgressBus {
  private readonly listeners = new Set<IngestProgressListener>();
  private readonly latest = new Map<string, IngestProgressSnapshot>();

  publish(snapshot: IngestProgressSnapshot): void {
    const value = structuredClone(snapshot);
    for (const sourceId of value.sourceIds) this.latest.set(sourceId, value);
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(value));
      } catch {
        // Progress listeners must never interrupt an Agent Run.
      }
    }
  }

  subscribe(listener: IngestProgressListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getLatest(sourceId: string): IngestProgressSnapshot | undefined {
    const value = this.latest.get(sourceId);
    return value ? structuredClone(value) : undefined;
  }

  clear(sourceIds: string[]): void {
    for (const sourceId of sourceIds) this.latest.delete(sourceId);
  }
}

export class IngestProgressTracker {
  private readonly runs = new Map<string, IngestProgressSnapshot>();

  constructor(private readonly bus = new IngestProgressBus()) {}

  start(sourceIds: string[], maxIterations: number, maxToolCalls: number): IngestProgressSnapshot {
    const now = new Date().toISOString();
    const snapshot: IngestProgressSnapshot = {
      runId: crypto.randomUUID(),
      sourceIds: [...sourceIds],
      state: "running",
      phase: "preparing",
      message: "正在准备 Wiki 吸收",
      iteration: 0,
      maxIterations,
      toolCalls: 0,
      maxToolCalls,
      elapsedMs: 0,
      startedAt: now,
      updatedAt: now,
      activities: []
    };
    this.runs.set(snapshot.runId, snapshot);
    this.bus.publish(snapshot);
    return structuredClone(snapshot);
  }

  accept(runId: string, event: AgentEvent): IngestProgressSnapshot | undefined {
    const snapshot = this.runs.get(runId);
    if (!snapshot || snapshot.state !== "running") return snapshot ? structuredClone(snapshot) : undefined;
    if (event.type === "text" || event.type === "result") return structuredClone(snapshot);
    if (event.type === "status") snapshot.message = sanitizeSummary(event.message);
    if (event.type === "iteration") {
      snapshot.iteration = event.iteration;
      snapshot.maxIterations = event.maxIterations;
    }
    if (event.type === "budget") {
      snapshot.iteration = Math.max(snapshot.iteration, event.iterations);
      snapshot.toolCalls = Math.max(snapshot.toolCalls, event.toolCalls);
      snapshot.elapsedMs = Math.max(snapshot.elapsedMs, event.elapsedMs);
      if (event.context) snapshot.context = structuredClone(event.context);
    }
    if (event.type === "tool_started") this.startActivity(snapshot, event.toolCallId, event.name);
    if (event.type === "tool_completed") {
      this.completeActivity(snapshot, event.toolCallId, event.name, event.isError, event.summary);
    }
    if (event.type === "waiting_user") snapshot.message = "Agent 正在等待用户确认方向";
    if (event.type === "plan_ready") {
      snapshot.state = "awaiting_review";
      snapshot.phase = "submitting";
      snapshot.message = `变更计划已生成，等待 Diff 审阅（${event.changedPaths.length} 个页面）`;
    }
    if (event.type === "error") {
      snapshot.state = event.code === "CANCELLED" ? "cancelled" : "failed";
      snapshot.message = sanitizeSummary(event.error);
    }
    this.touch(snapshot);
    return structuredClone(snapshot);
  }

  markAwaitingReview(runId: string, changedPages: number): void {
    this.finish(runId, "awaiting_review", `变更计划已生成，等待 Diff 审阅（${changedPages} 个页面）`);
  }

  markFailed(runId: string, error: unknown, cancelled = false): void {
    this.finish(
      runId,
      cancelled ? "cancelled" : "failed",
      cancelled ? "Ingest 已取消，可重新尝试" : sanitizeSummary(error instanceof Error ? error.message : String(error))
    );
  }

  markCompleted(runId: string, sourceIds?: string[]): void {
    const snapshot = this.runs.get(runId);
    if (!snapshot) return;
    if (sourceIds) snapshot.sourceIds = [...sourceIds];
    this.finish(runId, "completed", "Wiki 变更已写入");
  }

  clear(sourceIds: string[]): void {
    this.bus.clear(sourceIds);
  }

  subscribe(listener: IngestProgressListener): () => void {
    return this.bus.subscribe(listener);
  }

  getLatest(sourceId: string): IngestProgressSnapshot | undefined {
    return this.bus.getLatest(sourceId);
  }

  private startActivity(snapshot: IngestProgressSnapshot, toolCallId: string, name: string): void {
    const presentation = toolPresentation(name);
    snapshot.phase = presentation.phase;
    snapshot.message = `正在${presentation.label}`;
    snapshot.toolCalls += 1;
    snapshot.activities.push({
      id: `${snapshot.runId}:${toolCallId}`,
      toolCallId,
      name,
      label: presentation.label,
      status: "running",
      startedAt: new Date().toISOString()
    });
    if (snapshot.activities.length > MAX_ACTIVITIES) {
      snapshot.activities.splice(0, snapshot.activities.length - MAX_ACTIVITIES);
    }
  }

  private completeActivity(
    snapshot: IngestProgressSnapshot,
    toolCallId: string,
    name: string,
    isError: boolean,
    summary: string
  ): void {
    let activity = [...snapshot.activities].reverse().find((item) => item.toolCallId === toolCallId);
    if (!activity) {
      const presentation = toolPresentation(name);
      activity = {
        id: `${snapshot.runId}:${toolCallId}`,
        toolCallId,
        name,
        label: presentation.label,
        status: "running",
        startedAt: new Date().toISOString()
      };
      snapshot.activities.push(activity);
      snapshot.toolCalls += 1;
    }
    activity.status = isError ? "failed" : "completed";
    activity.completedAt = new Date().toISOString();
    activity.summary = sanitizeSummary(summary);
    snapshot.message = `${activity.label}${isError ? "失败" : "完成"}`;
  }

  private finish(runId: string, state: IngestProgressState, message: string): void {
    const snapshot = this.runs.get(runId);
    if (!snapshot) return;
    snapshot.state = state;
    snapshot.message = message;
    this.touch(snapshot);
  }

  private touch(snapshot: IngestProgressSnapshot): void {
    snapshot.updatedAt = new Date().toISOString();
    snapshot.elapsedMs = Math.max(snapshot.elapsedMs, Date.now() - Date.parse(snapshot.startedAt));
    this.bus.publish(snapshot);
  }
}

export function toolPresentation(name: string): { phase: IngestProgressPhase; label: string } {
  return TOOL_PRESENTATION[name] ?? { phase: "preparing", label: `执行 ${sanitizeSummary(name)}` };
}

function sanitizeSummary(value: string): string {
  return String(value ?? "")
    .replace(/(authorization|api[-_ ]?key|token)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/https?:\/\/[^\s?#]+\?[^\s]*/gi, (url) => url.split("?")[0]!)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}
