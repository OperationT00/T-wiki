import {
  normalizeVaultPath,
  parseMarkdown,
  stringifyMarkdown
} from "../core/wiki-core";
import {
  hasManagedRelatedSection,
  managedRelatedTargets,
  normalizeRelatedTarget,
  normalizeRelatedTargets,
  renderManagedRelatedBody
} from "../core/wiki-links";
import type { WikiPage } from "../types";
import type { StagedWikiPage, WorkingSet } from "./working-set";

export const WIKI_RELATION_TYPES = [
  "prerequisite",
  "component",
  "contrast",
  "implementation",
  "lifecycle",
  "related"
] as const;

export type WikiRelationType = typeof WIKI_RELATION_TYPES[number];

export interface ProposedWikiRelation {
  fromCandidateId: string;
  toCandidateId?: string;
  toWikiPath?: string;
  type: WikiRelationType;
  reason?: string;
  confidence: number;
}

export interface LinkableKnowledgeCandidate {
  candidateId: string;
  sourceId: string;
  title: string;
  /** Legacy callers may still supply type; the link planner itself is type agnostic. */
  type?: "entity" | "concept" | "synthesis";
  proposedType?: "entity" | "concept" | "synthesis";
  resolvedType?: "entity" | "concept" | "synthesis";
  decision?: "created" | "updated" | "already_covered" | "source_only" | "insufficient_evidence";
  targetPath?: string;
}

export interface WikiLinkEdge {
  fromPath: string;
  toPath: string;
  type: WikiRelationType;
  reason: string;
  confidence: number;
}

export interface WikiLinkPlan {
  proposedCount: number;
  edges: WikiLinkEdge[];
  dropped: Record<string, number>;
  unlinkedPaths: string[];
  fallback?: string;
}

export interface WikiLinkValidation {
  errors: string[];
  warnings: string[];
}

const RELATION_PRIORITY: Record<WikiRelationType, number> = {
  prerequisite: 6,
  component: 5,
  contrast: 4,
  implementation: 3,
  lifecycle: 2,
  related: 1
};

export class WikiLinkPlanner {
  build(
    proposals: ProposedWikiRelation[],
    candidates: LinkableKnowledgeCandidate[],
    existingPages: WikiPage[],
    fallback?: string
  ): WikiLinkPlan {
    const dropped: Record<string, number> = {};
    const drop = (reason: string): void => { dropped[reason] = (dropped[reason] ?? 0) + 1; };
    const byId = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
    const existing = new Set(existingPages.map((page) => page.path.replace(/\.md$/i, "")));
    const best = new Map<string, WikiLinkEdge>();

    for (const proposal of proposals) {
      const from = byId.get(proposal.fromCandidateId);
      if (!from || (from.decision !== "created" && from.decision !== "updated") || !from.targetPath) {
        drop("invalid_from");
        continue;
      }
      const hasCandidate = Boolean(proposal.toCandidateId);
      const hasPath = Boolean(proposal.toWikiPath);
      if (hasCandidate === hasPath) {
        drop("invalid_target_shape");
        continue;
      }
      if (!WIKI_RELATION_TYPES.includes(proposal.type)) {
        drop("invalid_relation");
        continue;
      }
      if (!Number.isFinite(proposal.confidence) || proposal.confidence < 0.7 || proposal.confidence > 1) {
        drop("low_confidence");
        continue;
      }

      const fromPath = normalizeWikiPath(from.targetPath);
      let toPath: string | null = null;
      if (proposal.toCandidateId) {
        const target = byId.get(proposal.toCandidateId);
        if (target?.targetPath && target.decision !== "source_only" && target.decision !== "insufficient_evidence") {
          toPath = normalizeWikiPath(target.targetPath);
        }
      } else if (proposal.toWikiPath) {
        const target = normalizeRelatedTarget(proposal.toWikiPath);
        if (target && existing.has(target)) toPath = target;
      }
      if (!fromPath || !toPath) {
        drop("unknown_target");
        continue;
      }
      if (fromPath === toPath) {
        drop("self_link");
        continue;
      }
      const edge: WikiLinkEdge = {
        fromPath,
        toPath,
        type: proposal.type,
        reason: proposal.reason?.trim() || proposal.type,
        confidence: proposal.confidence
      };
      const key = `${fromPath}\u0000${toPath}`;
      const previous = best.get(key);
      if (!previous || compareEdges(edge, previous) < 0) best.set(key, edge);
      else drop("duplicate");
    }

    const grouped = new Map<string, WikiLinkEdge[]>();
    for (const edge of best.values()) grouped.set(edge.fromPath, [...(grouped.get(edge.fromPath) ?? []), edge]);
    const edges: WikiLinkEdge[] = [];
    for (const values of grouped.values()) {
      const sorted = values.sort(compareEdges);
      edges.push(...sorted.slice(0, 5));
      for (let index = 5; index < sorted.length; index += 1) drop("outgoing_limit");
    }
    edges.sort((left, right) => left.fromPath.localeCompare(right.fromPath) || compareEdges(left, right));

    const linked = new Set(edges.map((edge) => edge.fromPath));
    const unlinkedPaths = candidates
      .filter((candidate) => (candidate.decision === "created" || candidate.decision === "updated") && candidate.targetPath)
      .map((candidate) => normalizeWikiPath(candidate.targetPath!))
      .filter((path): path is string => Boolean(path) && !linked.has(path!))
      .sort();
    return { proposedCount: proposals.length, edges, dropped, unlinkedPaths, ...(fallback ? { fallback } : {}) };
  }
}

export class WikiLinkEnricher {
  async apply(
    plan: WikiLinkPlan,
    workingSet: WorkingSet,
    knowledgePaths: Iterable<string>
  ): Promise<void> {
    const outgoing = new Map<string, string[]>();
    for (const edge of plan.edges) outgoing.set(edge.fromPath, [...(outgoing.get(edge.fromPath) ?? []), edge.toPath]);
    for (const rawPath of knowledgePaths) {
      const path = normalizeWikiPath(rawPath);
      if (!path) continue;
      const staged = workingSet.list().find((page) => page.path === `${path}.md` || page.path.replace(/\.md$/i, "") === path);
      if (!staged) continue;
      const content = enrichWikiContent(staged.path, staged.currentContent, outgoing.get(path) ?? []);
      if (content !== staged.currentContent) await workingSet.replace(staged.path, content);
    }
  }
}

export function enrichWikiContent(path: string, content: string, targets: Iterable<unknown>): string {
  const page = parseMarkdown(path, content);
  if (!page) throw new Error(`无法为非法 Wiki Markdown 写入关联链接：${path}`);
  const related = normalizeRelatedTargets([...page.related, ...targets])
    .filter((target) => target !== page.path.replace(/\.md$/i, ""));
  const frontmatter = { ...page.frontmatter, related };
  return stringifyMarkdown(frontmatter, renderManagedRelatedBody(page.body, related));
}

export function validateIngestLinkGraph(input: {
  stagedPages: StagedWikiPage[];
  existingPages: WikiPage[];
  sourcePaths: Map<string, string>;
  candidates: LinkableKnowledgeCandidate[];
  plan: WikiLinkPlan;
}): WikiLinkValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const overlay = new Map(input.existingPages.map((page) => [page.path, page]));
  const stagedPaths = new Set(input.stagedPages.map((page) => page.path));
  for (const staged of input.stagedPages) {
    const page = parseMarkdown(staged.path, staged.currentContent);
    if (!page) {
      errors.push(`链接图谱页面不是合法 Wiki Markdown：${staged.path}`);
      continue;
    }
    overlay.set(staged.path, page);
  }
  const validTargets = new Set([...overlay.keys()].map((path) => path.replace(/\.md$/i, "")));
  for (const path of stagedPaths) {
    const page = overlay.get(path);
    if (!page) continue;
    const self = path.replace(/\.md$/i, "");
    if (page.links.includes(self)) errors.push(`链接图谱包含自链接：${path}`);
    for (const target of page.links) {
      if (!validTargets.has(target)) errors.push(`链接图谱包含悬空链接：${path} -> ${target}`);
    }
    const rawRelated = Array.isArray(page.frontmatter.related) ? page.frontmatter.related : [];
    const normalizedRelated = normalizeRelatedTargets(rawRelated);
    if (normalizedRelated.length !== rawRelated.length) errors.push(`related 包含非法或重复目标：${path}`);
    if (normalizedRelated.length > 0 && !hasManagedRelatedSection(page.body)) {
      errors.push(`related 缺少托管关联区域：${path}`);
    }
    if (hasManagedRelatedSection(page.body)) {
      const rendered = managedRelatedTargets(page.body);
      if (!sameTargets(normalizedRelated, rendered)) errors.push(`related 与正文关联区域不一致：${path}`);
    }
  }

  const outgoing = new Map<string, string[]>();
  for (const page of overlay.values()) outgoing.set(page.path.replace(/\.md$/i, ""), page.links);
  for (const candidate of input.candidates) {
    if ((candidate.decision !== "created" && candidate.decision !== "updated") || !candidate.targetPath) continue;
    const sourcePath = input.sourcePaths.get(candidate.sourceId)?.replace(/\.md$/i, "");
    const targetPath = candidate.targetPath.replace(/\.md$/i, "");
    if (!sourcePath || !reachableWithin(outgoing, sourcePath, targetPath, 2)) {
      errors.push(`知识页面无法从对应 Source 在两跳内到达：${targetPath}`);
    }
  }
  for (const path of input.plan.unlinkedPaths) warnings.push(`知识页面没有高置信度语义出链：${path}`);
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

function normalizeWikiPath(path: string): string | null {
  return normalizeRelatedTarget(normalizeVaultPath(path));
}

function compareEdges(left: WikiLinkEdge, right: WikiLinkEdge): number {
  return right.confidence - left.confidence
    || RELATION_PRIORITY[right.type] - RELATION_PRIORITY[left.type]
    || left.toPath.localeCompare(right.toPath);
}

function sameTargets(left: string[], right: string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function reachableWithin(graph: Map<string, string[]>, start: string, target: string, maxDepth: number): boolean {
  if (start === target) return true;
  let frontier = [start];
  const seen = new Set(frontier);
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const next: string[] = [];
    for (const path of frontier) {
      for (const linked of graph.get(path) ?? []) {
        if (linked === target) return true;
        if (!seen.has(linked)) { seen.add(linked); next.push(linked); }
      }
    }
    frontier = next;
  }
  return false;
}
