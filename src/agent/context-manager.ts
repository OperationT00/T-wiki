import { estimateTokens } from "../core/context-budget";
import type {
  AgentConversationMessage,
  ContextCheckpoint,
  ContextUsage,
  EvidenceReference,
  LlmToolDefinition
} from "../types";
import type { ContextMemorySnapshot } from "./context-memory";
import type { EvidenceLedger } from "./evidence-ledger";

export interface ContextCompactionResult {
  messages: AgentConversationMessage[];
  beforeTokens: number;
  afterTokens: number;
  compactedTokens: number;
}

export class AgentContextManager {
  canCompact(messages: AgentConversationMessage[], keepToolTurns = 3): boolean {
    return toolTurnStarts(messages).length > keepToolTurns;
  }

  usage(input: {
    systemPrompt: string;
    tools: LlmToolDefinition[];
    messages: AgentConversationMessage[];
    workingSetSummary: string;
    maxContextTokens: number;
    cumulativeInputTokens: number;
    cumulativeOutputTokens: number;
    cachedInputTokens: number;
    cacheHits: number;
    checkpointCount: number;
    compactedTokens: number;
  }): ContextUsage {
    const system = estimateTokens(input.systemPrompt);
    const tools = estimateTokens(JSON.stringify(input.tools));
    const messages = estimateTokens(JSON.stringify(input.messages));
    const workingSet = estimateTokens(input.workingSetSummary);
    const shares = toolTokenShares(input.messages);
    return {
      liveContextTokens: system + tools + messages + workingSet,
      maxContextTokens: input.maxContextTokens,
      cumulativeInputTokens: input.cumulativeInputTokens,
      cumulativeOutputTokens: input.cumulativeOutputTokens,
      cachedInputTokens: input.cachedInputTokens,
      cacheHits: input.cacheHits,
      checkpointCount: input.checkpointCount,
      compactedTokens: input.compactedTokens,
      breakdown: { system, tools, messages, raw: shares.raw, wiki: shares.wiki, workingSet }
    };
  }

  compact(
    messages: AgentConversationMessage[],
    checkpoint: ContextCheckpoint,
    keepToolTurns: number
  ): ContextCompactionResult {
    const beforeTokens = estimateTokens(JSON.stringify(messages));
    const starts = toolTurnStarts(messages);
    if (starts.length <= keepToolTurns) return { messages, beforeTokens, afterTokens: beforeTokens, compactedTokens: 0 };
    const keepFrom = starts[Math.max(0, starts.length - keepToolTurns)]!;
    const next: AgentConversationMessage[] = [
      { role: "user", content: [{ type: "text", text: checkpointText(checkpoint) }] },
      ...messages.slice(keepFrom)
    ];
    const afterTokens = estimateTokens(JSON.stringify(next));
    return { messages: next, beforeTokens, afterTokens, compactedTokens: Math.max(0, beforeTokens - afterTokens) };
  }

  checkpointHistory(messages: AgentConversationMessage[], keepToolTurns: number): AgentConversationMessage[] {
    const starts = toolTurnStarts(messages);
    if (starts.length <= keepToolTurns) return messages;
    const keepFrom = starts[Math.max(0, starts.length - keepToolTurns)]!;
    return messages.slice(0, keepFrom);
  }

  deterministicCheckpoint(snapshot: ContextMemorySnapshot): ContextCheckpoint {
    return {
      version: 1,
      phase: snapshot.phase,
      completedActions: snapshot.completedTools.slice(-20),
      keyFindings: [
        ...snapshot.rawEvidence.slice(-20).map((evidence) => ({ statement: `已读取 raw ${evidence.sectionId}`, evidence: [evidence] })),
        ...snapshot.wikiEvidence.slice(-20).map((evidence) => ({ statement: `已读取 Wiki ${evidence.wikiPath}`, evidence: [evidence] })),
        ...snapshot.stagedPages.slice(-20).map((page) => ({
          statement: `WorkingSet ${page.action} ${page.path} (${page.characters} chars)`, evidence: []
        }))
      ].slice(-30),
      unresolved: snapshot.unresolved.slice(0, 20),
      nextActions: nextActionsFor(snapshot.phase)
    };
  }

  validateCheckpoint(
    input: unknown,
    snapshot: ContextMemorySnapshot,
    ledger: EvidenceLedger
  ): ContextCheckpoint {
    if (!input || typeof input !== "object") throw new Error("Checkpoint 必须为对象");
    const value = input as Partial<ContextCheckpoint>;
    const findings = Array.isArray(value.keyFindings) ? value.keyFindings : [];
    return {
      version: 1,
      phase: snapshot.phase,
      completedActions: strings(value.completedActions, 20),
      keyFindings: findings.slice(0, 30).flatMap((item) => {
        if (!item || typeof item !== "object" || !String(item.statement ?? "").trim()) return [];
        const evidence = Array.isArray(item.evidence)
          ? item.evidence.filter((reference) => isKnownEvidence(reference, ledger)).map((reference) => structuredClone(reference))
          : [];
        return [{ statement: String(item.statement).trim().slice(0, 500), evidence }];
      }),
      unresolved: strings(value.unresolved, 20),
      nextActions: strings(value.nextActions, 10)
    };
  }
}

export function checkpointPrompt(snapshot: ContextMemorySnapshot, transcript: string): string {
  return `把下面的 Agent 历史压缩为 JSON Checkpoint。不得发明证据；evidence 只能使用事实快照中的引用。
输出字段：version=1, phase, completedActions[], keyFindings[{statement,evidence[]}], unresolved[], nextActions[]。

事实快照：
${JSON.stringify(snapshot)}

待压缩历史：
${transcript}`;
}

function toolTurnStarts(messages: AgentConversationMessage[]): number[] {
  const starts: number[] = [];
  for (let index = 0; index < messages.length - 1; index += 1) {
    const assistant = messages[index];
    const result = messages[index + 1];
    if (assistant?.role !== "assistant" || result?.role !== "user") continue;
    const callIds = new Set(assistant.content.filter((item) => item.type === "tool_call").map((item) => item.id));
    const resultIds = result.content.filter((item) => item.type === "tool_result").map((item) => item.toolCallId);
    if (callIds.size > 0 && resultIds.length > 0 && resultIds.every((id) => callIds.has(id))) starts.push(index);
  }
  return starts;
}

function checkpointText(value: ContextCheckpoint): string {
  return `[LLM Wiki context checkpoint]\n${JSON.stringify(value)}\nEarlier tool turns were compacted. Re-read by sourceId/path/hash when full content is needed.`;
}

function toolTokenShares(messages: AgentConversationMessage[]): { raw: number; wiki: number } {
  const categories = new Map<string, "raw" | "wiki">();
  let raw = 0;
  let wiki = 0;
  const rawNames = new Set(["read_raw_section", "search_raw", "list_raw_outline"]);
  const wikiNames = new Set(["read_wiki_page", "search_wiki", "get_wiki_links"]);
  for (const message of messages) {
    for (const item of message.content) {
      if (item.type === "tool_call") {
        const category = rawNames.has(item.name) ? "raw" : wikiNames.has(item.name) ? "wiki" : undefined;
        if (!category) continue;
        categories.set(item.id, category);
        if (category === "raw") raw += estimateTokens(JSON.stringify(item));
        else wiki += estimateTokens(JSON.stringify(item));
      } else if (item.type === "tool_result") {
        const category = categories.get(item.toolCallId);
        if (category === "raw") raw += estimateTokens(JSON.stringify(item));
        else if (category === "wiki") wiki += estimateTokens(JSON.stringify(item));
      }
    }
  }
  return { raw, wiki };
}

function strings(value: unknown, limit: number): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item ?? "").trim()).filter(Boolean).slice(0, limit).map((item) => item.slice(0, 500))
    : [];
}

function isKnownEvidence(value: unknown, ledger: EvidenceLedger): value is EvidenceReference {
  if (!value || typeof value !== "object") return false;
  const item = value as EvidenceReference;
  return Boolean(
    item.sourceId && item.contentHash && item.sectionId && ledger.hasRaw(item.sourceId, item.contentHash, item.sectionId)
    || item.wikiPath && item.wikiHash && ledger.hasWiki(item.wikiPath, item.wikiHash)
  );
}

function nextActionsFor(phase: ContextMemorySnapshot["phase"]): string[] {
  if (phase === "source_understanding") return ["继续读取来源章节"];
  if (phase === "knowledge_comparison" || phase === "researching") return ["搜索并读取相关 Wiki"];
  if (phase === "staging") return ["完成暂存变更并检查 Diff"];
  if (phase === "validating") return ["修复验证问题并重新验证"];
  if (phase === "submitting") return ["提交变更计划"];
  return ["形成最终回答"];
}
