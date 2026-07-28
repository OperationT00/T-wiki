import { estimateTokens } from "../core/context-budget";
import { makePageTemplate, normalizeVaultPath, sha256 } from "../core/wiki-core";
import { buildNavigationIndex, indexPage, type WikiNavigationIndex } from "../core/wiki-navigation-index";
import { currentRevision } from "../services/raw-artifacts";
import type {
  LintReport,
  EvidenceReference,
  IngestCoverageReport,
  SearchResult,
  SourceManifest,
  WikiPage,
  WikiPageType
} from "../types";
import { ToolRegistry, type AgentTool, type ToolExecutionContext, type ToolResult } from "./tools";
import { reconcileIngestCoverage, validateIngestCoverage } from "./ingest-coverage";

export interface VerifiedSource {
  manifest: SourceManifest;
  content: string;
}

export interface WikiAgentHost {
  listSources(): Promise<SourceManifest[]>;
  getSource(sourceId: string): Promise<SourceManifest>;
  readVerifiedSource(sourceId: string): Promise<VerifiedSource>;
  search(query: string): Promise<SearchResult[]>;
  readWikiPage(path: string): Promise<WikiPage>;
  readPages(): Promise<WikiPage[]>;
  getNavigationIndex?(): Promise<WikiNavigationIndex>;
  readNavigationIndex?(input: { type?: WikiPageType; tag?: string; cursor?: string; limit?: number }): Promise<{
    revision: string;
    cards: Array<Record<string, unknown>>;
    nextCursor?: string;
  }>;
  runLint(): Promise<LintReport>;
}

export function createWikiToolRegistry(host: WikiAgentHost): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(tool("read_wiki_index", "Read a safe page of the generated Wiki navigation index. It never accepts a Vault path.", schema({
    group: {
      type: "object", additionalProperties: false,
      properties: {
        type: { type: "string", enum: ["source", "entity", "concept", "synthesis", "output"] },
        tag: stringProp("Optional exact tag")
      }
    },
    cursor: stringProp("Opaque cursor returned by a previous call"),
    limit: { type: "integer", minimum: 1, maximum: 100 }
  }), "read", true, async (input, context) => {
    const group = input.group && typeof input.group === "object" ? input.group as Record<string, unknown> : {};
    const request = {
      type: group.type as WikiPageType | undefined,
      tag: typeof group.tag === "string" ? group.tag : undefined,
      cursor: typeof input.cursor === "string" ? input.cursor : undefined,
      limit: Number(input.limit ?? 50)
    };
    const page = host.readNavigationIndex
      ? await host.readNavigationIndex(request)
      : indexPage(await loadNavigationIndex(host), request);
    if (context.queryState) {
      context.queryState.indexRevision = page.revision;
      const key = `${group.type ?? "all"}:${group.tag ?? "all"}:${input.cursor ?? "0"}`;
      if (!context.queryState.indexReads.includes(key)) context.queryState.indexReads.push(key);
    }
    return result(page, `Read ${page.cards.length} Wiki index cards`);
  }));
  registry.register(tool("inspect_source", "Inspect one manifest-backed source. Use this before reading raw content.", schema({
    sourceId: stringProp("Manifest source ID")
  }, ["sourceId"]), "read", true, async (input, context) => {
    requireSource(input.sourceId, context);
    const manifest = await host.getSource(input.sourceId);
    const revision = currentRevision(manifest);
    return result({
      sourceId: manifest.sourceId,
      name: manifest.original.name,
      kind: manifest.source.kind,
      sourceUri: manifest.source.uri,
      sourceHash: manifest.sourceHash,
      contentHash: revision?.contentHash,
      parser: revision ? `${revision.parserId}@${revision.parserVersion}` : undefined,
      metadata: revision?.metadata,
      quality: revision?.quality,
      warnings: revision?.warnings ?? []
    }, `Inspected source ${manifest.original.name}`);
  }));
  registry.register(tool("list_raw_outline", "List deterministic Markdown sections for a verified source. Read sections by sectionId afterwards.", schema({
    sourceId: stringProp("Manifest source ID"),
    maxDepth: { type: "integer", minimum: 1, maximum: 6 }
  }, ["sourceId"]), "read", true, async (input, context) => {
    requireSource(input.sourceId, context);
    const verified = await host.readVerifiedSource(input.sourceId);
    const maxDepth = Number(input.maxDepth ?? 6);
    const sections = markdownSections(verified.content).filter((section) => section.level === 0 || section.level <= maxDepth);
    return result({
      sourceId: input.sourceId,
      contentHash: currentRevision(verified.manifest)?.contentHash,
      evidenceEligible: false,
      estimatedTokens: estimateTokens(verified.content),
      sections: sections.map(({ content: _content, ...section }) => section)
    }, `Listed ${sections.length} raw sections`);
  }));
  registry.register(tool("read_raw_section", "Read one verified canonical raw Markdown section. Never accepts a filesystem path.", schema({
    sourceId: stringProp("Manifest source ID"),
    contentHash: stringProp("Expected current content SHA-256"),
    sectionId: stringProp("Section ID returned by list_raw_outline")
  }, ["sourceId", "contentHash", "sectionId"]), "read", true, async (input, context) => {
    requireSource(input.sourceId, context);
    const verified = await host.readVerifiedSource(input.sourceId);
    const revision = currentRevision(verified.manifest);
    if (!revision || revision.contentHash !== input.contentHash) throw new Error("raw contentHash 已变化");
    const section = markdownSections(verified.content).find((item) => item.sectionId === input.sectionId);
    if (!section) throw new Error(`raw section 不存在：${input.sectionId}`);
    const evidenceId = context.evidenceLedger.recordRaw(input.sourceId, revision.contentHash, section.sectionId);
    return result({
      sourceId: input.sourceId,
      contentHash: revision.contentHash,
      evidenceEligible: true,
      evidenceId,
      sectionId: section.sectionId,
      heading: section.heading,
      startLine: section.startLine,
      endLine: section.endLine,
      content: section.content
    }, `Read ${input.sectionId} (${estimateTokens(section.content)} tokens)`);
  }));
  registry.register(tool("search_raw", "Search paragraphs in allowed verified raw sources and return source-bound excerpts.", schema({
    sourceIds: { type: "array", items: { type: "string" }, maxItems: 20 },
    query: stringProp("Search terms"),
    matchMode: matchModeSchema(),
    limit: { type: "integer", minimum: 1, maximum: 20 }
  }, ["query"]), "read", true, async (input, context) => {
    const ids = await resolveRawScope(host, input.sourceIds, context);
    const matches: Array<Record<string, unknown>> = [];
    const terms = searchTerms(String(input.query));
    const mode = normalizeMatchMode(input.matchMode);
    for (const sourceId of ids) {
      const verified = await host.readVerifiedSource(sourceId);
      const revision = currentRevision(verified.manifest);
      for (const section of markdownSections(verified.content)) {
        const normalized = section.content.toLocaleLowerCase();
        const score = searchScore(normalized, String(input.query), terms, mode);
        if (score <= 0) continue;
        matches.push({
          sourceId,
          contentHash: revision?.contentHash,
          sectionId: section.sectionId,
          heading: section.heading,
          score,
          excerpt: section.content.replace(/\s+/g, " ").slice(0, 800)
        });
      }
    }
    const limited = matches.sort((a, b) => Number(b.score) - Number(a.score)).slice(0, Number(input.limit ?? 8));
    return result({ matches: limited }, `Found ${limited.length} raw matches`);
  }));
  registry.register(tool("get_page_template", "Get the authoritative Wiki page template before creating a page.", schema({
    type: { type: "string", enum: ["source", "entity", "concept", "synthesis", "output"] }
  }, ["type"]), "read", true, async (input) => {
    const type = input.type as WikiPageType;
    return result({ type, template: makePageTemplate(type, "TITLE", "TLDR", "BODY") }, `Loaded ${type} template`);
  }));
  registry.register(tool("search_wiki", "Fallback search when navigation index titles and summaries are insufficient. Read selected results afterwards.", schema({
    query: stringProp("Search terms"),
    matchMode: matchModeSchema(),
    types: { type: "array", items: { type: "string", enum: ["source", "entity", "concept", "synthesis", "output"] }, maxItems: 5 },
    tags: { type: "array", items: { type: "string" }, maxItems: 10 },
    limit: { type: "integer", minimum: 1, maximum: 20 }
  }, ["query"]), "read", true, async (input) => {
    const types = new Set<string>(input.types ?? []);
    const tags = new Set<string>(input.tags ?? []);
    const mode = normalizeMatchMode(input.matchMode);
    const index = await loadNavigationIndex(host);
    const terms = searchTerms(String(input.query));
    let candidates = index.pages.map((page) => {
      const searchable = [page.title, page.aliases.join(" "), page.tldr, page.tags.join(" "), page.headings.join(" "), page.outgoing.join(" ")]
        .join("\n").toLocaleLowerCase();
      const score = searchScore(searchable, String(input.query), terms, mode);
      return { page, score, reasons: score > 0 ? [`index:${mode}:${String(input.query).trim()}`] : [] };
    }).filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.page.path.localeCompare(right.page.path));
    if (candidates.length === 0) {
      candidates = (await host.search(String(input.query))).map(({ page, score, reasons }) => ({
        page: {
          path: page.path, hash: sha256(page.content), type: page.type, title: page.title,
          aliases: page.aliases, tags: page.tags, tldr: page.tldr, headings: [], outgoing: page.links, backlinks: []
        }, score, reasons: [...reasons, "正文后备检索"]
      }));
    }
    const values = candidates
      .filter(({ page }) => types.size === 0 || types.has(page.type))
      .filter(({ page }) => tags.size === 0 || page.tags.some((tag) => tags.has(tag)))
      .slice(0, Number(input.limit ?? 8))
      .map(({ page, score, reasons }) => ({
        path: page.path,
        type: page.type,
        title: page.title,
        tldr: page.tldr,
         hash: page.hash,
        score,
        reasons
      }));
    return result({ matches: values }, `Found ${values.length} Wiki matches`);
  }));
  registry.register(tool("read_wiki_page", "Read a Wiki outline or one section. Defaults to outline; request full only when section reads are insufficient.", schema({
    path: stringProp("Wiki Markdown path"),
    expectedHash: stringProp("Optional expected SHA-256"),
    mode: { type: "string", enum: ["outline", "section", "full"] },
    sectionId: stringProp("Section ID returned by outline mode; required for section mode")
  }, ["path"]), "read", true, async (input, context) => {
    const page = await host.readWikiPage(assertWikiPath(input.path));
    const hash = sha256(page.content);
    if (input.expectedHash && input.expectedHash !== hash) throw new Error(`Wiki page 已变化：${page.path}`);
    const mode = input.mode ?? "outline";
    const sections = markdownSections(page.body);
    if (mode === "outline") {
      const readKey = `${page.path}\u0000${hash}\u0000outline`;
      if (context.queryReadKeys?.has(readKey)) {
        return result({ path: page.path, hash, mode, alreadyRead: true }, `Skipped duplicate outline ${page.path}`);
      }
      context.queryReadKeys?.add(readKey);
      return result({
        path: page.path,
        hash,
        evidenceEligible: false,
        type: page.type,
        frontmatter: page.frontmatter,
        estimatedTokens: estimateTokens(page.content),
        sections: sections.map(({ content: _content, ...section }) => section)
      }, `Outlined ${page.path} (${sections.length} sections)`);
    }
    if (mode === "section") {
      if (!input.sectionId) throw new Error("read_wiki_page section 模式需要 sectionId");
      const section = sections.find((item) => item.sectionId === input.sectionId);
      if (!section) throw new Error(`Wiki section 不存在：${input.sectionId}`);
      const readKey = `${page.path}\u0000${hash}\u0000section\u0000${section.sectionId}`;
      if (context.queryReadKeys?.has(readKey)) {
        return result({ path: page.path, hash, mode, sectionId: section.sectionId, alreadyRead: true }, `Skipped duplicate ${page.path}#${section.sectionId}`);
      }
      context.queryReadKeys?.add(readKey);
      const evidenceId = context.evidenceLedger.recordWiki(page.path, hash);
      recordQueryRead(context, page.path, hash, "section", section.sectionId);
      return result({
        path: page.path, hash, type: page.type, evidenceEligible: true, evidenceId, sectionId: section.sectionId,
        heading: section.heading, startLine: section.startLine, endLine: section.endLine, content: section.content
      }, `Read ${page.path}#${section.sectionId} (${estimateTokens(section.content)} tokens)`);
    }
    const readKey = `${page.path}\u0000${hash}\u0000full`;
    if (context.queryReadKeys?.has(readKey)) {
      return result({ path: page.path, hash, mode, alreadyRead: true }, `Skipped duplicate full read ${page.path}`);
    }
    context.queryReadKeys?.add(readKey);
    const evidenceId = context.evidenceLedger.recordWiki(page.path, hash);
    recordQueryRead(context, page.path, hash, "full");
    return result({
      path: page.path, hash, type: page.type, evidenceEligible: true, evidenceId,
      frontmatter: page.frontmatter, content: page.content
    }, `Read full ${page.path}`);
  }));
  registry.register(tool("get_wiki_links", "Inspect and pre-expand outgoing links and backlinks. Use summaries to choose which pages to read.", schema({
    path: stringProp("Wiki Markdown path"),
    direction: { type: "string", enum: ["outgoing", "backlinks", "both"] },
    depth: { type: "integer", minimum: 1, maximum: 2 },
    limit: { type: "integer", minimum: 1, maximum: 50 }
  }, ["path"]), "read", true, async (input, context) => {
    const path = assertWikiPath(input.path);
    const index = await loadNavigationIndex(host);
    const key = path.replace(/\.md$/i, "");
    const byPath = new Map(index.pages.map((page) => [page.path.replace(/\.md$/i, ""), page]));
    if (!byPath.has(key)) throw new Error(`Wiki 页面不存在：${path}`);
    const direction = input.direction ?? "both";
    const depth = Number(input.depth ?? 1);
    const limit = Number(input.limit ?? 20);
    const queue: Array<{ key: string; hop: number; route: string[] }> = [{ key, hop: 0, route: [key] }];
    const found = new Map<string, { page: typeof index.pages[number]; hop: number; paths: Array<{ direction: "outgoing" | "backlink"; path: string[] }> }>();
    const expanded = new Set<string>();
    while (queue.length > 0 && found.size < limit) {
      const current = queue.shift()!;
      if (current.hop >= depth || expanded.has(`${current.key}:${current.hop}`)) continue;
      expanded.add(`${current.key}:${current.hop}`);
      const page = byPath.get(current.key);
      if (!page) continue;
      const neighbors: Array<{ target: string; direction: "outgoing" | "backlink" }> = [
        ...(direction === "backlinks" ? [] : page.outgoing.map((target) => ({ target, direction: "outgoing" as const }))),
        ...(direction === "outgoing" ? [] : page.backlinks.map((target) => ({ target, direction: "backlink" as const })))
      ];
      for (const neighbor of neighbors) {
        const targetKey = neighbor.target.replace(/\.md$/i, "");
        if (targetKey === key || current.route.includes(targetKey)) continue;
        const target = byPath.get(targetKey);
        if (!target) continue;
        const route = [...current.route, targetKey];
        const item = found.get(targetKey) ?? { page: target, hop: current.hop + 1, paths: [] };
        if (!item.paths.some((entry) => entry.direction === neighbor.direction && entry.path.join("\0") === route.join("\0"))) {
          item.paths.push({ direction: neighbor.direction, path: route });
        }
        found.set(targetKey, item);
        queue.push({ key: targetKey, hop: current.hop + 1, route });
        if (found.size >= limit) break;
      }
    }
    const neighbors = [...found.values()].map(({ page, hop, paths }) => ({
      path: page.path, hash: page.hash, type: page.type, title: page.title, tldr: page.tldr,
      hop, paths,
      alreadyRead: Boolean(context.queryState?.wikiReads.some((read) => read.path === page.path))
    }));
    if (context.queryState) {
      context.queryState.indexRevision = index.revision;
      for (const neighbor of neighbors) {
        for (const route of neighbor.paths) {
          const lastFrom = route.path.at(-2) ?? key;
          if (!context.queryState.graphTraversals.some((item) =>
            item.from === lastFrom && item.to === neighbor.path.replace(/\.md$/i, "")
            && item.hop === neighbor.hop && item.direction === route.direction)) {
            context.queryState.graphTraversals.push({
              from: lastFrom,
              to: neighbor.path.replace(/\.md$/i, ""),
              hop: neighbor.hop,
              direction: route.direction
            });
          }
        }
      }
    }
    return result({
      path,
      revision: index.revision,
      outgoing: direction === "backlinks" ? [] : (byPath.get(key)?.outgoing ?? []).map((target) => ({
        target,
        exists: byPath.has(target.replace(/\.md$/i, ""))
      })),
      backlinks: direction === "outgoing" ? [] : (byPath.get(key)?.backlinks ?? []).flatMap((target) => {
        const page = byPath.get(target.replace(/\.md$/i, ""));
        return page ? [{ path: page.path, hash: page.hash }] : [];
      }),
      neighbors
    }, `Inspected ${found.size} link neighbors for ${path}`);
  }));
  registry.register(tool("get_lint_report", "Run deterministic Wiki Core validation without writing files.", schema({
    mode: { type: "string", enum: ["all", "quick", "frontmatter", "content", "queue"] }
  }), "read", false, async () => {
    const report = await host.runLint();
    return result(report, `Lint found ${report.issues.length} issues`);
  }));
  registry.register(tool("create_wiki_page", "Create a Wiki page only in the in-memory WorkingSet. It never writes the Vault.", schema({
    path: stringProp("New wiki/**/*.md path"),
    content: stringProp("Complete Markdown including frontmatter"),
    evidence: evidenceSchema(),
    evidenceIds: evidenceIdSchema()
  }, ["path", "content"]), "stage", false, async (input, context) => {
    const evidence = resolveToolEvidence(input, context);
    context.evidenceLedger.assertKnown(evidence, context.requireEvidence);
    const page = await context.workingSet.create(assertWikiPath(input.path), input.content, evidence);
    return result({ path: page.path, action: page.action }, `Staged create ${page.path}`);
  }));
  registry.register(tool("edit_wiki_page", "Apply one unique exact replacement to an in-memory Wiki page. Read the page first and provide its baseHash.", schema({
    path: stringProp("Existing wiki/**/*.md path"),
    baseHash: stringProp("Hash returned by read_wiki_page"),
    oldText: stringProp("Unique exact text"),
    newText: { type: "string" },
    evidence: evidenceSchema(),
    evidenceIds: evidenceIdSchema()
  }, ["path", "baseHash", "oldText", "newText"]), "stage", false, async (input, context) => {
    const evidence = resolveToolEvidence(input, context);
    context.evidenceLedger.assertKnown(evidence, context.requireEvidence);
    const page = await context.workingSet.edit(assertWikiPath(input.path), input.baseHash, input.oldText, input.newText, evidence);
    return result({ path: page.path, action: page.action }, `Staged edit ${page.path}`);
  }));
  registry.register(tool("inspect_changes", "Inspect WorkingSet summaries by default, or one explicit file diff.", schema({
    path: stringProp("Staged Wiki path; required when detail=diff"),
    detail: { type: "string", enum: ["summary", "diff"] }
  }), "read", false, async (input, context) => {
    const detail = input.detail ?? (input.path ? "diff" : "summary");
    if (detail === "diff" && !input.path) throw new Error("inspect_changes diff 模式需要 path");
    const changes = context.workingSet.inspect(input.path, detail);
    return result({ changes }, `Inspected ${changes.length} staged changes`);
  }));
  registry.register(tool("validate_working_set", "Validate staged pages with the local Wiki schema, path, hash and dangling-link checks.", schema({
    scope: stringProp("Use all, or one staged path")
  }), "read", false, async (_input, context) => {
    context.validationCount += 1;
    if (context.validationCount > 3) throw new Error("WorkingSet 已超过两轮修复机会");
    const validation = await context.workingSet.validate();
    return result({ ok: validation.ok, errors: validation.errors }, validation.ok ? "WorkingSet valid" : `Validation failed: ${validation.errors.join("; ")}`);
  }));
  registry.register(tool("submit_changes", "Freeze a valid WorkingSet into a candidate WikiChangePlan for human Diff review. This does not write files.", schema({
    summary: stringProp("Concise change summary"),
    rationale: stringProp("Why these changes are appropriate"),
    ingestCoverage: ingestCoverageSchema()
  }, ["summary"]), "terminal", false, async (input, context) => {
    const coverage = context.allowedSourceIds.size > 0
      ? validateIngestCoverage(reconcileIngestCoverage(input.ingestCoverage, context), context)
      : undefined;
    if (context.allowedSourceIds.size === 0 && input.ingestCoverage !== undefined) {
      throw new Error("非 Ingest 命令不能提交 ingestCoverage");
    }
    const basePlan = await context.workingSet.freeze(input.summary);
    const plan = coverage ? { ...basePlan, ingestCoverage: coverage } : basePlan;
    context.terminal = { type: "plan", plan };
    return result({ operationId: plan.operationId, changedPaths: plan.operations.map((item) => item.path) }, `Submitted ${plan.operations.length} changes for review`);
  }));
  registry.register(tool("finish_without_changes", "Finish explicitly when the evidence does not justify a Wiki change.", schema({
    reason: stringProp("Why no change is needed"),
    knowledgeGaps: { type: "array", items: { type: "string" }, maxItems: 20 }
  }, ["reason"]), "terminal", false, async (input, context) => {
    context.terminal = { type: "no_changes", reason: input.reason, knowledgeGaps: input.knowledgeGaps ?? [] };
    return result({ finished: true }, "Finished without changes");
  }));
  registry.register(tool("request_user_direction", "Pause only a --discuss ingest to ask the user which findings to emphasize.", schema({
    discoveries: stringProp("Key findings so far"),
    questions: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 }
  }, ["discoveries", "questions"]), "interaction", false, async (input, context) => {
    if (context.requestDirection) {
      const answer = await context.requestDirection(input.discoveries, input.questions);
      return result({ userDirection: answer }, "Received user direction");
    }
    context.terminal = { type: "waiting_user", discoveries: input.discoveries, questions: input.questions };
    return result({ waiting: true }, "Waiting for user direction");
  }));
  return registry;
}

interface MarkdownSection {
  sectionId: string;
  heading: string;
  level: number;
  startLine: number;
  endLine: number;
  estimatedTokens: number;
  page?: number;
  content: string;
}

export function markdownSections(markdown: string): MarkdownSection[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const starts: Array<{ line: number; heading: string; level: number; page?: number }> = [];
  let fenced = false;
  let page: number | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*(```|~~~)/.test(lines[index]!)) fenced = !fenced;
    if (fenced) continue;
    const pageMarker = lines[index]!.match(/^<!--\s*llm-wiki:page=(\d+)\s*-->$/);
    if (pageMarker) page = Number(pageMarker[1]);
    const match = lines[index]!.match(/^(#{1,6})\s+(.+)$/);
    if (match) starts.push({ line: index, heading: match[2]!.trim(), level: match[1]!.length, page });
  }
  if (starts.length === 0 || starts[0]!.line > 0) starts.unshift({ line: 0, heading: starts.length ? "Preamble" : "Document", level: 0 });
  return starts.map((start, index) => {
    const endExclusive = starts[index + 1]?.line ?? lines.length;
    const content = lines.slice(start.line, endExclusive).join("\n").trimEnd();
    return {
      sectionId: `s${String(index + 1).padStart(4, "0")}`,
      heading: start.heading,
      level: start.level,
      startLine: start.line + 1,
      endLine: endExclusive,
      estimatedTokens: estimateTokens(content),
      page: start.page,
      content
    };
  });
}

function tool(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  risk: AgentTool["descriptor"]["risk"],
  parallelSafe: boolean,
  execute: AgentTool["execute"]
): AgentTool {
  return { descriptor: { name, description, inputSchema, risk, parallelSafe }, execute };
}

function schema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", additionalProperties: false, properties, required };
}

function stringProp(description: string): Record<string, unknown> {
  return { type: "string", description };
}

function recordQueryRead(
  context: ToolExecutionContext,
  path: string,
  hash: string,
  mode: "section" | "full",
  sectionId?: string
): void {
  if (!context.queryState) return;
  if (context.queryState.wikiReads.some((read) =>
    read.path === path && read.hash === hash && read.mode === mode && read.sectionId === sectionId)) return;
  context.queryState.wikiReads.push({ path, hash, mode, ...(sectionId ? { sectionId } : {}) });
}

async function loadNavigationIndex(host: WikiAgentHost): Promise<WikiNavigationIndex> {
  return host.getNavigationIndex
    ? host.getNavigationIndex()
    : buildNavigationIndex(await host.readPages(), "ephemeral-test-index");
}

function evidenceSchema(): Record<string, unknown> {
  return {
    type: "array",
    maxItems: 30,
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        sourceId: { type: "string" }, contentHash: { type: "string" }, sectionId: { type: "string" },
        wikiPath: { type: "string" }, wikiHash: { type: "string" }
      }
    }
  };
}

function evidenceIdSchema(): Record<string, unknown> {
  return { type: "array", maxItems: 30, items: { type: "string" } };
}

function resolveToolEvidence(input: Record<string, any>, context: ToolExecutionContext): EvidenceReference[] {
  const explicit = Array.isArray(input.evidence) ? input.evidence as EvidenceReference[] : [];
  const ids = Array.isArray(input.evidenceIds) ? input.evidenceIds.map(String) : [];
  return [...explicit, ...context.evidenceLedger.resolveAll(ids)];
}

function ingestCoverageSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["sources", "categoryAssessments", "decisions"],
    properties: {
      sources: {
        type: "array", minItems: 1, maxItems: 5,
        items: schema({
          sourceId: { type: "string" },
          contentHash: { type: "string" },
          reviewedSectionIds: { type: "array", minItems: 1, maxItems: 200, items: { type: "string" } },
          noReusableKnowledgeReason: { type: "string" }
        }, ["sourceId", "contentHash", "reviewedSectionIds"])
      },
      categoryAssessments: {
        type: "array", minItems: 3, maxItems: 15,
        items: schema({
          sourceId: { type: "string" },
          type: { type: "string", enum: ["entity", "concept", "synthesis"] },
          outcome: { type: "string", enum: ["candidates_found", "none"] },
          reason: { type: "string", minLength: 1 }
        }, ["sourceId", "type", "outcome", "reason"])
      },
      decisions: {
        type: "array", maxItems: 200,
        items: schema({
          candidateId: { type: "string", minLength: 1 },
          sourceId: { type: "string" },
          type: { type: "string", enum: ["entity", "concept", "synthesis"] },
          title: { type: "string", minLength: 1 },
          decision: {
            type: "string",
            enum: ["created", "updated", "already_covered", "source_only", "insufficient_evidence"]
          },
          targetPath: { type: "string" },
          reason: { type: "string", minLength: 1 },
          evidence: evidenceSchema()
        }, ["candidateId", "sourceId", "type", "title", "decision", "reason", "evidence"])
      }
    }
  };
}

function result<T>(output: T, summary: string): ToolResult<T> {
  return { output, summary };
}

function requireSource(sourceId: string, context: ToolExecutionContext): void {
  if (!context.allowAllRaw && !context.allowedSourceIds.has(sourceId)) throw new Error(`Source 不在当前任务范围：${sourceId}`);
}

async function resolveRawScope(host: WikiAgentHost, requested: string[] | undefined, context: ToolExecutionContext): Promise<string[]> {
  const ids = requested?.length
    ? requested
    : context.allowAllRaw ? (await host.listSources()).filter((item) => item.parse.status === "parsed").map((item) => item.sourceId) : [...context.allowedSourceIds];
  for (const id of ids) requireSource(id, context);
  return [...new Set(ids)].slice(0, 20);
}

function assertWikiPath(path: string): string {
  const normalized = normalizeVaultPath(String(path));
  if (!normalized.startsWith("wiki/") || !normalized.endsWith(".md") || normalized.includes("../")) {
    throw new Error(`禁止访问路径：${path}`);
  }
  return normalized;
}

function searchTerms(input: string): string[] {
  return [...new Set(input.toLocaleLowerCase().match(/[\p{L}\p{N}_.+#/-]{2,}/gu) ?? [])];
}

function occurrences(text: string, term: string): number {
  return Math.min(5, text.split(term).length - 1);
}

type MatchMode = "lexical" | "exact" | "all_terms" | "any_terms";

function matchModeSchema(): Record<string, unknown> {
  return { type: "string", enum: ["lexical", "exact", "all_terms", "any_terms"] };
}

function normalizeMatchMode(value: unknown): MatchMode {
  return value === "exact" || value === "all_terms" || value === "any_terms" ? value : "lexical";
}

function searchScore(text: string, query: string, terms: string[], mode: MatchMode): number {
  if (mode === "exact") {
    const phrase = query.trim().toLocaleLowerCase();
    return phrase ? occurrences(text, phrase) : 0;
  }
  if (terms.length === 0) return 0;
  if (mode === "all_terms" && !terms.every((term) => text.includes(term))) return 0;
  return terms.reduce((sum, term) => sum + occurrences(text, term), 0);
}
