import { randomUUID } from "node:crypto";

import { isWritableWikiPath, normalizeVaultPath, sha256, validateChangePlan } from "../core/wiki-core";
import type { ChangeOperation, EvidenceReference, WikiChangePlan, WikiPage } from "../types";
export type { EvidenceReference } from "../types";

export interface StagedWikiPage {
  path: string;
  action: "create" | "update";
  baseHash?: string;
  originalContent?: string;
  currentContent: string;
  evidence: EvidenceReference[];
  validationErrors: string[];
}

export interface WorkingSetHost {
  currentHashes(): Promise<Map<string, string>>;
  readWikiPage(path: string): Promise<WikiPage>;
}

export class WorkingSet {
  private readonly pages = new Map<string, StagedWikiPage>();
  private frozen = false;
  private revisionValue = 0;
  private validatedRevision?: number;

  constructor(
    private readonly host: WorkingSetHost,
    private readonly maxChangedPages: number
  ) {}

  list(): StagedWikiPage[] {
    return [...this.pages.values()].map((page) => structuredClone(page));
  }

  get size(): number {
    return this.pages.size;
  }

  async create(path: string, content: string, evidence: EvidenceReference[] = []): Promise<StagedWikiPage> {
    this.assertMutable();
    path = assertStagedPath(path);
    this.assertCapacity(path);
    if (this.pages.has(path) || (await this.host.currentHashes()).has(path)) {
      throw new Error(`创建目标已存在：${path}`);
    }
    const page: StagedWikiPage = {
      path,
      action: "create",
      currentContent: content,
      evidence: normalizeEvidence(evidence),
      validationErrors: []
    };
    this.pages.set(path, page);
    this.markChanged();
    return structuredClone(page);
  }

  async edit(
    path: string,
    baseHash: string,
    oldText: string,
    newText: string,
    evidence: EvidenceReference[] = []
  ): Promise<StagedWikiPage> {
    this.assertMutable();
    path = assertStagedPath(path);
    this.assertCapacity(path);
    let page = this.pages.get(path);
    if (!page) {
      const existing = await this.host.readWikiPage(path);
      const actualHash = sha256(existing.content);
      if (actualHash !== baseHash) throw new Error(`文件已变化：${path}`);
      page = {
        path,
        action: "update",
        baseHash: actualHash,
        originalContent: existing.content,
        currentContent: existing.content,
        evidence: [],
        validationErrors: []
      };
      this.pages.set(path, page);
    } else if (page.action === "update" && page.baseHash !== baseHash) {
      throw new Error(`WorkingSet baseHash 不一致：${path}`);
    }
    if (!oldText) throw new Error("oldText 不能为空");
    const first = page.currentContent.indexOf(oldText);
    if (first < 0) throw new Error(`oldText 在 ${path} 中不存在`);
    if (page.currentContent.indexOf(oldText, first + oldText.length) >= 0) {
      throw new Error(`oldText 在 ${path} 中不是唯一匹配`);
    }
    page.currentContent = `${page.currentContent.slice(0, first)}${newText}${page.currentContent.slice(first + oldText.length)}`;
    page.evidence = normalizeEvidence([...page.evidence, ...evidence]);
    page.validationErrors = [];
    this.markChanged();
    return structuredClone(page);
  }

  async replace(path: string, content: string, evidence: EvidenceReference[] = []): Promise<StagedWikiPage> {
    this.assertMutable();
    path = assertStagedPath(path);
    const page = this.requirePage(path);
    if (!content.trim()) throw new Error(`WorkingSet 替换内容不能为空：${path}`);
    if (page.currentContent === content && evidence.length === 0) return structuredClone(page);
    page.currentContent = content;
    page.evidence = normalizeEvidence([...page.evidence, ...evidence]);
    page.validationErrors = [];
    this.markChanged();
    return structuredClone(page);
  }

  inspect(path?: string, detail: "summary" | "diff" = path ? "diff" : "summary"): Array<{
    path: string;
    action: string;
    currentHash: string;
    characters: number;
    addedLines: number;
    removedLines: number;
    diff?: string;
  }> {
    const pages = path ? [this.requirePage(path)] : [...this.pages.values()];
    return pages.map((page) => {
      const diff = simpleDiff(page.originalContent ?? "", page.currentContent);
      const lines = diff.split("\n");
      return {
        path: page.path,
        action: page.action,
        currentHash: sha256(page.currentContent),
        characters: page.currentContent.length,
        addedLines: lines.filter((line) => line.startsWith("+")).length,
        removedLines: lines.filter((line) => line.startsWith("-")).length,
        ...(detail === "diff" ? { diff } : {})
      };
    });
  }

  async validate(summary = "Agent staged changes"): Promise<{ ok: boolean; errors: string[]; plan?: WikiChangePlan }> {
    if (this.pages.size === 0) return { ok: false, errors: ["WorkingSet 没有变更"] };
    const candidate = this.buildCandidate(summary);
    try {
      const plan = validateChangePlan(candidate, await this.host.currentHashes());
      for (const page of this.pages.values()) page.validationErrors = [];
      this.validatedRevision = this.revisionValue;
      return { ok: true, errors: [], plan };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const page of this.pages.values()) page.validationErrors = [message];
      this.validatedRevision = undefined;
      return { ok: false, errors: [message] };
    }
  }

  async freeze(summary: string): Promise<WikiChangePlan> {
    const validation = await this.validate(summary);
    if (!validation.ok || !validation.plan) throw new Error(`WorkingSet 校验失败：${validation.errors.join("；")}`);
    this.frozen = true;
    return validation.plan;
  }

  summary(): string {
    if (this.pages.size === 0) return "WorkingSet: empty";
    return [
      `WorkingSet: ${this.pages.size}/${this.maxChangedPages} pages`,
      ...[...this.pages.values()].map((page) => `- ${page.action} ${page.path}`
        + ` base=${page.baseHash ?? "new"} current=${sha256(page.currentContent).slice(0, 12)}`
        + ` chars=${page.currentContent.length} evidence=${page.evidence.length}`
        + ` validation=${page.validationErrors.length > 0 ? "failed" : this.isCurrentRevisionValidated ? "valid" : "pending"}`)
    ].join("\n");
  }

  get revision(): number {
    return this.revisionValue;
  }

  get isCurrentRevisionValidated(): boolean {
    return this.pages.size > 0 && this.validatedRevision === this.revisionValue;
  }

  private buildCandidate(summary: string): WikiChangePlan {
    const operations: ChangeOperation[] = [...this.pages.values()].map((page) => ({
      action: page.action,
      path: page.path,
      expectedHash: page.baseHash,
      content: page.currentContent,
      reason: evidenceReason(page.evidence)
    }));
    return { version: 1, operationId: randomUUID(), summary, operations };
  }

  private assertMutable(): void {
    if (this.frozen) throw new Error("WorkingSet 已冻结");
  }

  private markChanged(): void {
    this.revisionValue += 1;
    this.validatedRevision = undefined;
  }

  private assertCapacity(path: string): void {
    if (!this.pages.has(path) && this.pages.size >= this.maxChangedPages) {
      throw new Error(`变更页数超过预算：${this.maxChangedPages}`);
    }
  }

  private requirePage(path: string): StagedWikiPage {
    const value = this.pages.get(path);
    if (!value) throw new Error(`WorkingSet 中没有页面：${path}`);
    return value;
  }
}

function assertStagedPath(path: string): string {
  const normalized = normalizeVaultPath(path);
  if (!isWritableWikiPath(normalized) || normalized === "wiki/index.md" || normalized === "wiki/log.md") {
    throw new Error(`WorkingSet 禁止目标：${path}`);
  }
  return normalized;
}

function normalizeEvidence(values: EvidenceReference[]): EvidenceReference[] {
  const result = new Map<string, EvidenceReference>();
  for (const value of values) result.set(JSON.stringify(value), structuredClone(value));
  return [...result.values()];
}

function evidenceReason(values: EvidenceReference[]): string {
  if (values.length === 0) return "Agent staged change";
  return `Evidence: ${values.map((item) => item.sourceId
    ? `${item.sourceId}${item.sectionId ? `#${item.sectionId}` : ""}`
    : `${item.wikiPath ?? "wiki"}@${(item.wikiHash ?? "").slice(0, 8)}`).join(", ")}`;
}

function simpleDiff(before: string, after: string): string {
  if (before === after) return "(no changes)";
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix += 1;
  const removed = oldLines.slice(prefix, oldLines.length - suffix).map((line) => `-${line}`);
  const added = newLines.slice(prefix, newLines.length - suffix).map((line) => `+${line}`);
  return [`@@ line ${prefix + 1} @@`, ...removed, ...added].join("\n");
}
