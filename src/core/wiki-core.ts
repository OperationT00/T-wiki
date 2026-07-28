import { createHash, randomUUID } from "node:crypto";
import yaml from "js-yaml";
import { jsonrepair } from "jsonrepair";

import {
  hasManagedRelatedSection,
  normalizeRelatedTarget,
  normalizeRelatedTargets,
  renderManagedRelatedBody,
  stripManagedRelatedSection
} from "./wiki-links";

import {
  PAGE_TYPES,
  type ChangeOperation,
  type IngestCoverageReport,
  type KnowledgeDecision,
  type LintIssue,
  type LintReport,
  type SearchResult,
  type WikiChangePlan,
  type WikiConfig,
  type WikiPage,
  type WikiPageType,
  type WikiState
} from "../types";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const WIKILINK = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const REQUIRED = [
  "schema_version",
  "type",
  "title",
  "tldr",
  "status",
  "created",
  "updated",
  "tags",
  "related"
] as const;
const TYPE_DIR: Record<WikiPageType, string> = {
  source: "sources",
  entity: "entities",
  concept: "concepts",
  synthesis: "synthesis",
  output: "outputs"
};

export const DEFAULT_CONFIG: WikiConfig = {
  schemaVersion: 3,
  name: "LLM Wiki",
  domain: "Java 后端",
  audience: "准备技术面试的开发者",
  language: "zh-CN",
  paths: {
    raw: "raw",
    wiki: "wiki",
    index: "index.md",
    log: "log.md",
    internal: ".llm-wiki"
  },
  retrieval: {
    topK: 8,
    maxPages: 12
  },
  parsing: {
    maxImportBytes: 50 * 1024 * 1024,
    maxOutputBytes: 20 * 1024 * 1024,
    timeoutMs: 120_000,
    providers: {
      "markdown-pass-through": {
        enabled: true,
        priority: 100,
        options: {}
      },
      "plain-text": {
        enabled: true,
        priority: 100,
        options: {}
      },
      "webpage-defuddle": {
        enabled: true,
        priority: 100,
        options: {}
      },
      "pdfjs-layout": {
        enabled: true,
        priority: 100,
        options: {
          maxPdfPages: 1000,
          maxPdfTextItems: 2_000_000,
          lineYToleranceRatio: 0.35,
          scannedPageMinChars: 40,
          maxReplacementCharacterRatio: 0.05,
          repeatedMarginTextPageRatio: 0.6
        }
      },
      "mineru-http": {
        enabled: false,
        priority: 50,
        options: {
          protocol: "cloud-v4",
          baseUrl: "https://mineru.net",
          modelVersion: "vlm",
          language: "ch",
          enableTable: true,
          enableFormula: true,
          isOcr: true,
          pollIntervalMs: 2000,
          taskTimeoutMs: 600000
        }
      }
    }
  }
};

export const EMPTY_STATE: WikiState = {
  schemaVersion: 2,
  recentOperations: []
};

export function normalizeVaultPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+/g, "/");
}

export function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function parseMarkdown(path: string, content: string): WikiPage | null {
  const match = content.match(FRONTMATTER);
  if (!match?.[1]) return null;
  const parsedYaml = parseYamlFrontmatter(match[1]);
  if (!parsedYaml) return null;
  const frontmatter = parsedYaml.value;

  const type = String(frontmatter.type ?? "");
  if (!PAGE_TYPES.includes(type as WikiPageType)) return null;
  const body = content.slice(match[0].length);
  const titleFromBody = body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "";
  const related = stringArray(frontmatter.related);
  const links = [...new Set([
    ...extractWikiLinks(body),
    ...normalizeRelatedTargets(related)
  ])];
  return {
    path: normalizeVaultPath(path),
    basename: normalizeVaultPath(path).split("/").pop()?.replace(/\.md$/i, "") ?? "",
    type: type as WikiPageType,
    title: String(frontmatter.title ?? titleFromBody),
    tldr: String(frontmatter.tldr ?? ""),
    status: normalizeStatus(frontmatter.status),
    created: String(frontmatter.created ?? frontmatter.date_created ?? ""),
    updated: String(frontmatter.updated ?? frontmatter.date_modified ?? ""),
    tags: stringArray(frontmatter.tags),
    related,
    aliases: stringArray(frontmatter.aliases),
    frontmatter,
    body,
    content,
    links
  };
}

export function stringifyMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  const rendered = yaml.dump(frontmatter, {
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
    quotingType: '"',
    forceQuotes: false
  }).trimEnd();
  return `---\n${rendered}\n---\n\n${body.trimStart()}`;
}

export function extractWikiLinks(content: string): string[] {
  const links = new Set<string>();
  for (const match of content.matchAll(WIKILINK)) {
    const target = match[1]?.trim();
    if (target) links.add(normalizeVaultPath(target).replace(/\.md$/i, ""));
  }
  return [...links];
}

export function normalizeStatus(value: unknown): "stub" | "draft" | "reviewed" {
  return value === "stub" || value === "reviewed" ? value : "draft";
}

export function canonicalizePage(
  path: string,
  content: string,
  date = isoDate()
): { content: string; changed: boolean; warnings: string[] } {
  const match = content.match(FRONTMATTER);
  if (!match?.[1]) {
    return { content, changed: false, warnings: ["缺少 frontmatter，无法安全自动迁移"] };
  }
  const parsedYaml = parseYamlFrontmatter(match[1]);
  if (!parsedYaml) {
    return { content, changed: false, warnings: ["frontmatter YAML 无法解析"] };
  }
  const fm = parsedYaml.value;

  const body = content.slice(match[0].length);
  const title = String(fm.title ?? body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? path);
  const type = PAGE_TYPES.includes(fm.type as WikiPageType)
    ? String(fm.type)
    : inferTypeFromPath(path);
  const links = extractWikiLinks(content);
  const next: Record<string, unknown> = {
    schema_version: 1,
    type,
    title,
    tldr: String(fm.tldr ?? inferTldr(body)),
    status: normalizeStatus(fm.status),
    created: String(fm.created ?? fm.date_created ?? date),
    updated: String(fm.updated ?? fm.date_modified ?? date),
    tags: stringArray(fm.tags),
    related: stringArray(fm.related).length > 0 ? stringArray(fm.related) : links
  };
  if (type === "source") {
    Object.assign(next, {
      source_type: String(fm.source_type ?? "article"),
      author: String(fm.author ?? ""),
      url: String(fm.url ?? fm.external_url ?? ""),
      raw_path: String(fm.raw_path ?? fm.raw_note ?? ""),
      raw_hash: String(fm.raw_hash ?? "")
    });
  }
  if (type === "synthesis") Object.assign(next, {
    sources: stringArray(fm.sources),
    conflicts: stringArray(fm.conflicts)
  });
  if (type === "output") next.output_type = String(fm.output_type ?? "tldr");

  const consumed = new Set([
    "schema_version", "type", "title", "tldr", "status", "created", "updated",
    "date_created", "date_modified", "tags", "related", "explored",
    "external_url", "raw_note", "source_type", "author", "url", "raw_path", "raw_hash",
    "sources", "conflicts", "output_type"
  ]);
  for (const [key, value] of Object.entries(fm)) {
    if (!consumed.has(key)) next[key] = value;
  }
  const rendered = stringifyMarkdown(next, body);
  return {
    content: rendered,
    changed: rendered !== content,
    warnings: parsedYaml.repaired ? ["已修复 frontmatter 列表项缺少空格"] : []
  };
}

export function lintWiki(
  pages: WikiPage[],
  config: WikiConfig,
  existingPaths: Iterable<string>
): LintReport {
  const issues: LintIssue[] = [];
  const pathSet = new Set([...existingPaths].map((path) => normalizeVaultPath(path).replace(/\.md$/i, "")));
  const linkedTargets = new Set(pages.flatMap((page) => page.links));
  const titles = new Map<string, string[]>();
  const identities = new Map<string, WikiPage[]>();

  for (const page of pages) {
    const filename = page.path.split("/").pop() ?? "";
    if (!KEBAB.test(filename)) {
      issues.push(issue("invalid-filename", "warning", page.path, "文件名不是 kebab-case"));
    }
    for (const field of REQUIRED) {
      if (!(field in page.frontmatter) || page.frontmatter[field] === "") {
        issues.push(issue("missing-field", "error", page.path, `缺少必填字段：${field}`));
      }
    }
    const titleKey = page.title.trim().toLocaleLowerCase();
    titles.set(titleKey, [...(titles.get(titleKey) ?? []), page.path]);
    if (page.type === "entity" || page.type === "concept" || page.type === "synthesis") {
      for (const identity of new Set([page.title, ...page.aliases, page.basename.replace(/\.md$/i, "")]
        .map(normalizeWikiIdentity)
        .filter((value) => value.length >= 2))) {
        identities.set(identity, [...(identities.get(identity) ?? []), page]);
      }
    }

    for (const link of page.links) {
      if (!pathSet.has(link)) {
        issues.push(issue("dangling-link", "error", page.path, `链接目标不存在：[[${link}]]`));
      }
    }
    if (!linkedTargets.has(page.path.replace(/\.md$/i, "")) && page.links.length === 0) {
      issues.push(issue("orphan-page", "warning", page.path, "页面没有入链或出链"));
    }
    if (page.type === "source") {
      const rawPath = String(page.frontmatter.raw_path ?? page.frontmatter.raw_note ?? "");
      if (!rawPath) {
        issues.push(issue("missing-raw-path", "error", page.path, "Source 缺少 raw_path"));
      } else {
        const cleaned = normalizeVaultPath(rawPath.replace(/^\[\[|\]\]$/g, ""));
        if (!pathSet.has(cleaned.replace(/\.md$/i, "")) && !pathSet.has(cleaned)) {
          issues.push(issue("missing-raw-file", "warning", page.path, `原始素材不存在：${rawPath}`));
        }
      }
    }
  }

  for (const [title, paths] of titles) {
    if (title && paths.length > 1) {
      for (const path of paths) {
        issues.push(issue("duplicate-title", "warning", path, `重复标题：${title}`));
      }
    }
  }

  const reportedCrossType = new Set<string>();
  for (const [identity, matched] of identities) {
    const pagesByPath = [...new Map(matched.map((page) => [page.path, page])).values()];
    if (new Set(pagesByPath.map((page) => page.type)).size < 2) continue;
    const paths = pagesByPath.map((page) => page.path).sort();
    const conflictKey = paths.join("\u0000");
    if (reportedCrossType.has(conflictKey)) continue;
    reportedCrossType.add(conflictKey);
    const summary = pagesByPath
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((page) => `${page.path} (${page.type})`)
      .join("；");
    for (const page of pagesByPath) {
      issues.push(issue("CROSS_TYPE_DUPLICATE", "warning", page.path, `跨类型知识标识重复：${identity}；${summary}`));
    }
  }

  const expectedIndex = generateIndex(pages, config);
  if (!pathSet.has(config.paths.index.replace(/\.md$/i, "")) && !pathSet.has(config.paths.index)) {
    issues.push(issue("missing-index", "warning", config.paths.index, "索引文件不存在", true));
  } else if (!expectedIndex.trim()) {
    issues.push(issue("empty-index", "warning", config.paths.index, "索引无法生成"));
  }

  return { generatedAt: new Date().toISOString(), issues, pageCount: pages.length };
}

export function normalizeWikiIdentity(value: string): string {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s·・,，.。:：;；'"“”‘’()（）\[\]【】/_-]+/gu, "")
    .trim();
}

export function generateIndex(pages: WikiPage[], config: WikiConfig): string {
  const grouped = new Map<WikiPageType, WikiPage[]>();
  for (const type of PAGE_TYPES) grouped.set(type, []);
  for (const page of pages) grouped.get(page.type)?.push(page);

  const lines = [
    `# ${config.name} — 目录索引`,
    "",
    `> ${config.domain}知识库`,
    `> 最后更新：${isoDate()}`,
    ""
  ];
  for (const type of PAGE_TYPES) {
    lines.push(`## wiki/${TYPE_DIR[type]}/`);
    const entries = (grouped.get(type) ?? []).sort((a, b) => a.title.localeCompare(b.title));
    if (entries.length === 0) {
      lines.push("*暂无条目*");
    } else {
      for (const page of entries) {
        lines.push(`- [[${page.path.replace(/\.md$/i, "")}]] — ${compactIndexDescription(page.tldr || page.title)}`);
      }
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function compactIndexDescription(value: string): string {
  const compact = value
    .replace(/\|[^\n]*\|/g, " ")
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "$1")
    .replace(/[`*_>#-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return compact.length <= 180 ? compact : `${compact.slice(0, 179).trimEnd()}…`;
}

export function retrieve(
  query: string,
  pages: WikiPage[],
  topK = 8,
  maxPages = 12
): SearchResult[] {
  const tokens = tokenize(query);
  const scored = pages.map((page) => {
    let score = 0;
    const reasons: string[] = [];
    const title = `${page.title} ${page.aliases.join(" ")}`.toLocaleLowerCase();
    const tags = page.tags.join(" ").toLocaleLowerCase();
    const tldr = page.tldr.toLocaleLowerCase();
    const body = page.body.toLocaleLowerCase();
    for (const token of tokens) {
      if (title.includes(token)) { score += 12; reasons.push(`标题:${token}`); }
      if (tags.includes(token)) { score += 6; reasons.push(`标签:${token}`); }
      if (tldr.includes(token)) { score += 4; reasons.push(`摘要:${token}`); }
      const occurrences = body.split(token).length - 1;
      score += Math.min(occurrences, 5);
    }
    return { page, score, reasons };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score);

  const primary = scored.slice(0, topK);
  const selected = new Map(primary.map((item) => [item.page.path.replace(/\.md$/i, ""), item]));
  for (const item of primary) {
    for (const link of item.page.links) {
      if (selected.size >= maxPages) break;
      const linked = pages.find((page) => page.path.replace(/\.md$/i, "") === link);
      if (linked && !selected.has(link)) {
        selected.set(link, { page: linked, score: Math.max(1, item.score * 0.25), reasons: ["关联页面"] });
      }
    }
  }
  return [...selected.values()].sort((a, b) => b.score - a.score).slice(0, maxPages);
}

export function buildIngestSearchQuery(content: string): string {
  const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim()
    ?? content.split(/\r?\n/).find((line) => line.trim())?.trim()
    ?? "";
  const codeTerms = [...content.matchAll(/`([^`\n]{2,80})`/g)]
    .map((match) => match[1]!.trim())
    .filter(Boolean)
    .slice(0, 12);
  return [...new Set([title.slice(0, 240), ...codeTerms])].filter(Boolean).join(" ");
}

export function strongIngestMatches(results: SearchResult[], maxPages = 4): SearchResult[] {
  return results
    .filter((result) =>
      result.score >= 12
      && result.reasons.some((reason) => reason.startsWith("标题:") || reason.startsWith("标签:"))
    )
    .slice(0, maxPages);
}

export function validateChangePlan(
  input: unknown,
  currentHashes: Map<string, string> = new Map()
): WikiChangePlan {
  if (!input || typeof input !== "object") throw new Error("变更计划必须是对象");
  const value = input as Partial<WikiChangePlan>;
  if (value.version !== 1 || !Array.isArray(value.operations)) {
    throw new Error("变更计划版本或 operations 无效");
  }
  const plannedTargets = new Set(
    value.operations
      .filter((operation): operation is ChangeOperation => Boolean(operation && typeof operation === "object"))
      .map((operation) => normalizeVaultPath(String(operation.path ?? "")).replace(/\.md$/i, ""))
  );
  const validLinkTargets = new Set([
    ...[...currentHashes.keys()].map((path) => path.replace(/\.md$/i, "")),
    ...plannedTargets
  ]);
  const operations: ChangeOperation[] = value.operations.map((operation, index) => {
    if (!operation || typeof operation !== "object") throw new Error(`操作 ${index + 1} 无效`);
    const op = operation as ChangeOperation;
    const path = normalizeVaultPath(String(op.path ?? ""));
    if (op.action !== "create" && op.action !== "update") throw new Error(`操作 ${index + 1} action 无效`);
    if (!isWritableWikiPath(path)) throw new Error(`禁止写入路径：${path}`);
    if (!path.endsWith(".md")) throw new Error(`只允许写入 Markdown：${path}`);
    if (!String(op.content ?? "").trim()) throw new Error(`操作 ${index + 1} 内容为空`);
    const parsed = parseMarkdown(path, op.content);
    if (!parsed) throw new Error(`操作 ${index + 1} 内容不符合 Wiki Schema`);
    const schemaProblems = schemaErrors(parsed);
    if (schemaProblems.length > 0) {
      throw new Error(`操作 ${index + 1} Schema 缺失：${schemaProblems.join(", ")}`);
    }
    for (const link of parsed.links) {
      if (!validLinkTargets.has(link)) throw new Error(`操作 ${index + 1} 包含悬空链接：[[${link}]]`);
    }
    let expectedHash = op.expectedHash;
    if (op.action === "update") {
      const actual = currentHashes.get(path);
      if (!actual) throw new Error(`更新目标不存在：${path}`);
      if (op.expectedHash && op.expectedHash !== actual) throw new Error(`文件已变化：${path}`);
      expectedHash ??= actual;
    } else if (currentHashes.has(path)) {
      throw new Error(`创建目标已存在：${path}`);
    }
    return { ...op, path, expectedHash, reason: String(op.reason ?? "") };
  });
  const ingestCoverage = value.ingestCoverage === undefined
    ? undefined
    : normalizeIngestCoverage(value.ingestCoverage, operations);
  return {
    version: 1,
    operationId: String(value.operationId || randomUUID()),
    summary: String(value.summary || "Wiki 变更"),
    operations,
    ...(ingestCoverage ? { ingestCoverage } : {})
  };
}

function normalizeIngestCoverage(input: unknown, operations: ChangeOperation[]): IngestCoverageReport {
  if (!input || typeof input !== "object") throw new Error("ingestCoverage 无效");
  const report = structuredClone(input) as IngestCoverageReport;
  if (!Array.isArray(report.sources) || !Array.isArray(report.categoryAssessments) || !Array.isArray(report.decisions)) {
    throw new Error("ingestCoverage 结构无效");
  }
  const operationByPath = new Map(operations.map((operation) => [operation.path, operation]));
  const candidateIds = new Set<string>();
  for (const source of report.sources) {
    if (!source || typeof source.sourceId !== "string" || !/^[a-f0-9]{64}$/.test(String(source.contentHash ?? ""))
      || !Array.isArray(source.reviewedSectionIds)) throw new Error("ingestCoverage source 无效");
  }
  for (const assessment of report.categoryAssessments) {
    if (!assessment || !["entity", "concept", "synthesis"].includes(assessment.type)
      || !["candidates_found", "none"].includes(assessment.outcome)
      || !String(assessment.reason ?? "").trim()) throw new Error("ingestCoverage categoryAssessment 无效");
  }
  for (const decision of report.decisions) {
    validateStoredDecision(decision, operationByPath, candidateIds);
  }
  return report;
}

function validateStoredDecision(
  decision: KnowledgeDecision,
  operationByPath: Map<string, ChangeOperation>,
  candidateIds: Set<string>
): void {
  if (!decision || !String(decision.candidateId ?? "").trim() || candidateIds.has(decision.candidateId)) {
    throw new Error("ingestCoverage candidateId 无效或重复");
  }
  candidateIds.add(decision.candidateId);
  if (!["entity", "concept", "synthesis"].includes(decision.type)
    || !["created", "updated", "already_covered", "source_only", "insufficient_evidence", "user_rejected"].includes(decision.decision)
    || !String(decision.title ?? "").trim()
    || !String(decision.reason ?? "").trim()
    || !Array.isArray(decision.evidence)) throw new Error(`ingestCoverage 决策无效：${decision.candidateId}`);
  if (decision.targetPath) decision.targetPath = normalizeVaultPath(decision.targetPath);
  if (decision.decision === "created" || decision.decision === "updated") {
    const operation = decision.targetPath ? operationByPath.get(decision.targetPath) : undefined;
    const expectedAction = decision.decision === "created" ? "create" : "update";
    if (!operation || operation.action !== expectedAction) throw new Error(`ingestCoverage 与操作不一致：${decision.candidateId}`);
  }
}

export function sanitizePlanDanglingLinks(
  input: unknown,
  currentHashes: Map<string, string> = new Map()
): unknown {
  if (!input || typeof input !== "object") return input;
  const value = input as Partial<WikiChangePlan>;
  if (!Array.isArray(value.operations)) return input;

  const plannedTargets = new Set(
    value.operations
      .filter((operation): operation is ChangeOperation => Boolean(operation && typeof operation === "object"))
      .map((operation) => normalizeVaultPath(String(operation.path ?? "")).replace(/\.md$/i, ""))
  );
  const validTargets = new Set([
    ...[...currentHashes.keys()].map((path) => normalizeVaultPath(path).replace(/\.md$/i, "")),
    ...plannedTargets
  ]);

  return {
    ...value,
    operations: value.operations.map((operation) => {
      if (!operation || typeof operation !== "object") return operation;
      const op = operation as ChangeOperation;
      const result = stripDanglingLinks(String(op.content ?? ""), validTargets);
      if (result.removed.length === 0) return operation;
      const note = `Core 已移除悬空链接：${result.removed.map((link) => `[[${link}]]`).join("、")}`;
      return {
        ...op,
        content: result.content,
        reason: [String(op.reason ?? "").trim(), note].filter(Boolean).join("；")
      };
    })
  };
}

function stripDanglingLinks(
  content: string,
  validTargets: Set<string>
): { content: string; removed: string[] } {
  const removed = new Set<string>();
  const match = content.match(FRONTMATTER);
  if (!match?.[1]) return { content, removed: [] };
  const parsedYaml = parseYamlFrontmatter(match[1]);
  if (!parsedYaml) return { content, removed: [] };

  const frontmatter = { ...parsedYaml.value };
  frontmatter.related = stringArray(frontmatter.related).flatMap((item) => {
    const target = normalizeRelatedTarget(item);
    if (!target) return [];
    if (validTargets.has(target)) return [target];
    removed.add(target);
    return [];
  });

  const managed = hasManagedRelatedSection(content.slice(match[0].length));
  const bodyWithoutManaged = managed
    ? stripManagedRelatedSection(content.slice(match[0].length))
    : content.slice(match[0].length);
  let body = bodyWithoutManaged.replace(
    WIKILINK,
    (whole, rawTarget: string) => {
      const target = normalizeVaultPath(rawTarget.trim()).replace(/\.md$/i, "");
      if (validTargets.has(target)) return whole;
      removed.add(target);
      const inner = whole.slice(2, -2);
      const alias = inner.includes("|") ? inner.slice(inner.indexOf("|") + 1) : "";
      const fallback = target.split("/").pop()?.replaceAll("-", " ") || target;
      return alias.trim() || fallback;
    }
  );
  if (managed) body = renderManagedRelatedBody(body, frontmatter.related as unknown[]);
  return {
    content: stringifyMarkdown(frontmatter, body),
    removed: [...removed]
  };
}

export function isWritableWikiPath(path: string): boolean {
  const normalized = normalizeVaultPath(path).toLocaleLowerCase();
  return normalized.startsWith("wiki/")
    && !normalized.includes("../")
    && !normalized.startsWith("raw/")
    && !normalized.startsWith(".obsidian/")
    && normalized !== "llm-wiki.config.json";
}

export function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  if (!source) throw new Error("Agent 未返回 JSON");
  try {
    return JSON.parse(source);
  } catch (originalError) {
    try {
      return JSON.parse(jsonrepair(source));
    } catch {
      throw originalError;
    }
  }
}

export function makePageTemplate(type: WikiPageType, title: string, tldr: string, body: string): string {
  const date = isoDate();
  const fm: Record<string, unknown> = {
    schema_version: 1,
    type,
    title,
    tldr,
    status: "draft",
    created: date,
    updated: date,
    tags: [],
    related: []
  };
  if (type === "source") Object.assign(fm, { source_type: "article", author: "", url: "", raw_path: "", raw_hash: "" });
  if (type === "synthesis") Object.assign(fm, { sources: [], conflicts: [] });
  if (type === "output") Object.assign(fm, { output_type: "tldr" });
  return stringifyMarkdown(fm, `# ${title}\n\n${body}\n\n## 关联条目\n`);
}

export function isoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function inferTypeFromPath(path: string): WikiPageType {
  const normalized = normalizeVaultPath(path);
  if (normalized.includes("/sources/")) return "source";
  if (normalized.includes("/entities/")) return "entity";
  if (normalized.includes("/synthesis/")) return "synthesis";
  if (normalized.includes("/outputs/")) return "output";
  return "concept";
}

function inferTldr(body: string): string {
  return body
    .replace(/^#.*$/gm, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/[*_`>#-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function tokenize(value: string): string[] {
  const normalized = value.toLocaleLowerCase().trim();
  const latin = normalized.match(/[a-z0-9][a-z0-9.+#/-]*/g) ?? [];
  const chinese = normalized.match(/[\p{Script=Han}]{2,}/gu)?.flatMap((part) => {
    if (part.length <= 4) return [part];
    const grams: string[] = [];
    for (let i = 0; i < part.length - 1; i += 1) grams.push(part.slice(i, i + 2));
    return grams;
  }) ?? [];
  return [...new Set([...latin, ...chinese])];
}

function issue(
  code: string,
  severity: LintIssue["severity"],
  path: string,
  message: string,
  fixable = false
): LintIssue {
  return { code, severity, path, message, fixable };
}

function parseYamlFrontmatter(source: string): { value: Record<string, unknown>; repaired: boolean } | null {
  try {
    return { value: (yaml.load(source) as Record<string, unknown>) ?? {}, repaired: false };
  } catch {
    const repaired = source
      .replace(/^(\s*)-(\S)/gm, "$1- $2")
      .replace(
        /^(\s*[^#\s][^:\n]*:\s*)"([^"\n]*(?:"[^"\n]*)+)"\s*$/gm,
        (_line, prefix: string, value: string) =>
          `${prefix}'${value.replaceAll("\\\"", "\"").replaceAll("'", "''")}'`
      );
    if (repaired === source) return null;
    try {
      return { value: (yaml.load(repaired) as Record<string, unknown>) ?? {}, repaired: true };
    } catch {
      return null;
    }
  }
}

function schemaErrors(page: WikiPage): string[] {
  const missing = REQUIRED.filter((field) => !(field in page.frontmatter) || page.frontmatter[field] === "");
  if (page.type === "source") {
    for (const field of ["source_type", "author", "url", "raw_path", "raw_hash"]) {
      if (!(field in page.frontmatter)) missing.push(field as typeof REQUIRED[number]);
    }
  }
  if (page.type === "synthesis") {
    for (const field of ["sources", "conflicts"]) {
      if (!(field in page.frontmatter)) missing.push(field as typeof REQUIRED[number]);
    }
  }
  if (page.type === "output" && !("output_type" in page.frontmatter)) {
    missing.push("output_type" as typeof REQUIRED[number]);
  }
  return missing;
}
