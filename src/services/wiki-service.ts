import { TFile, TFolder, type App, type DataAdapter, type Vault } from "obsidian";

import {
  canonicalizePage,
  DEFAULT_CONFIG,
  EMPTY_STATE,
  generateIndex,
  isoDate,
  lintWiki,
  normalizeVaultPath,
  parseMarkdown,
  retrieve,
  sanitizePlanDanglingLinks,
  sha256,
  validateChangePlan
} from "../core/wiki-core";
import { mergeConfig } from "../core/wiki-config";
import {
  buildNavigationIndex,
  indexPage,
  isNavigationIndex,
  renderRootIndexForPrompt,
  rootIndexView,
  type WikiNavigationIndex
} from "../core/wiki-navigation-index";
import { migrateSourceRawReference } from "../parsing/migration";
import { toPipelineError } from "../parsing/pipeline-errors";
import type { ParserRegistry } from "../parsing/parser-registry";
import type { SourceBody } from "../parsing/parser-types";
import type { IntakeProvenance } from "./intake-service";
import type {
  IngestInput,
  LintReport,
  RawRecord,
  RawVerification,
  RollbackPreview,
  RollbackReceipt,
  RollbackResult,
  SearchResult,
  SourceDeletionPreview,
  SourceDeletionResult,
  SourceManifest,
  WikiChangePlan,
  WikiConfig,
  WikiPage,
  WikiPageType,
  WikiState
} from "../types";
import type { ParseProgressListener } from "../parsing/parse-progress";
import { ParsingFacade } from "./parsing-service";
import { validateSourceDeletionChain } from "./source-deletion";
import {
  atomicReplaceText,
  normalizeManifest,
  SourceStore
} from "./source-store";

interface TransactionJournal {
  id: string;
  status: "prepared" | "applying";
  createdAt: string;
  kind?: "apply" | "rollback";
  plan?: WikiChangePlan;
  originals: Record<string, string | null>;
  receiptPath?: string;
  receiptBefore?: RollbackReceipt;
}

interface DocumentParserWithConnection {
  testConnection?(options: Readonly<Record<string, unknown>>): Promise<{ ok: boolean; message: string }>;
  testVisualConnection?(options: Readonly<Record<string, unknown>>): Promise<{ ok: boolean; message: string }>;
  testFfmpeg?(options: Readonly<Record<string, unknown>>): Promise<{ ok: boolean; message: string }>;
}

export interface MigrationPreview {
  legacy: boolean;
  parsingFrameworkV2?: boolean;
  pages: Array<{ path: string; changed: boolean; warnings: string[] }>;
  claudian?: {
    cliPath: string;
    baseUrl: string;
    models: Array<{ id: string; contextWindow: number }>;
  };
}

export class WikiService {
  private config: WikiConfig | null = null;
  private state: WikiState | null = null;
  private parsing: ParsingFacade | null = null;
  private legacyRawState: Record<string, RawRecord> | null = null;
  private navigationIndex: WikiNavigationIndex | null = null;
  private navigationIndexDirty = false;

  constructor(
    private readonly app: App,
    private readonly parserRegistryFactory?: () => ParserRegistry
  ) {}

  get vault(): Vault {
    return this.app.vault;
  }

  get adapter(): DataAdapter {
    return this.vault.adapter;
  }

  async isInitialized(): Promise<boolean> {
    return this.adapter.exists("llm-wiki.config.json");
  }

  async loadConfig(): Promise<WikiConfig> {
    if (this.config) return this.config;
    if (!(await this.isInitialized())) throw new Error("Wiki 尚未初始化");
    const parsed = JSON.parse(await this.adapter.read("llm-wiki.config.json")) as Partial<WikiConfig>;
    this.config = mergeConfig(parsed);
    return this.config;
  }

  async loadState(): Promise<WikiState> {
    if (this.state) return this.state;
    const config = await this.loadConfig();
    const path = `${config.paths.internal}/state.json`;
    if (!(await this.adapter.exists(path))) {
      this.state = structuredClone(EMPTY_STATE);
      await this.writeInternalJson(path, this.state);
      return this.state;
    }
    const parsed = JSON.parse(await this.adapter.read(path)) as Partial<WikiState> & {
      raw?: Record<string, RawRecord>;
    };
    this.legacyRawState = parsed.raw ?? null;
    this.state = {
      schemaVersion: 2,
      recentOperations: parsed.recentOperations ?? []
    };
    return this.state;
  }

  async previewMigration(): Promise<MigrationPreview> {
    const pages = await this.readPagesFromPath("wiki");
    const previews = await Promise.all(pages.map(async (page) => {
      const file = this.vault.getAbstractFileByPath(page.path);
      if (!(file instanceof TFile)) return { path: page.path, changed: false, warnings: [] };
      const content = await this.vault.read(file);
      const result = canonicalizePage(page.path, content);
      return { path: page.path, changed: result.changed, warnings: result.warnings };
    }));
    let legacyConfig = false;
    let parsingFrameworkV2 = false;
    if (await this.isInitialized()) {
      try {
        const config = JSON.parse(await this.adapter.read("llm-wiki.config.json")) as {
          schemaVersion?: number;
          paths?: { internal?: string };
        };
        const manifestRoot = `${config.paths?.internal ?? ".llm-wiki"}/manifests`;
        const hasManifests = await this.adapter.exists(manifestRoot)
          && (await this.adapter.list(manifestRoot)).files.some((path) => path.endsWith(".json"));
        parsingFrameworkV2 = (config.schemaVersion === 2 || config.schemaVersion === 3) && hasManifests;
        legacyConfig = config.schemaVersion !== 4;
      } catch {
        legacyConfig = true;
      }
    }
    return {
      legacy: legacyConfig || (!(await this.isInitialized()) && (
        await this.adapter.exists("CLAUDE.md")
        || await this.adapter.exists("raw")
        || await this.adapter.exists("wiki")
      )),
      parsingFrameworkV2,
      pages: previews,
      claudian: await this.readClaudianNonSecretSettings()
    };
  }

  async initialize(input: Partial<WikiConfig>, migrateLegacy: boolean): Promise<MigrationPreview> {
    const config = mergeConfig(input);
    const preview = await this.previewMigration();
    const preservedState = preview.parsingFrameworkV2 ? structuredClone(await this.loadState()) : null;
    let configWrittenDuringMigration = false;
    const folders = [
      `${config.paths.raw}/articles`, `${config.paths.raw}/audio`, `${config.paths.raw}/videos`,
      `${config.paths.raw}/documents`, `${config.paths.raw}/assets`,
      `${config.paths.wiki}/sources`, `${config.paths.wiki}/entities`,
      `${config.paths.wiki}/concepts`, `${config.paths.wiki}/synthesis`,
      `${config.paths.wiki}/outputs`,
      "templates", `${config.paths.internal}/objects/sha256`,
      `${config.paths.internal}/manifests`, `${config.paths.internal}/source-maps`,
      `${config.paths.internal}/parse-staging`,
      `${config.paths.internal}/transactions`, `${config.paths.internal}/operations`,
      `${config.paths.internal}/backups`
    ];
    for (const folder of folders) await ensureAdapterFolder(this.adapter, folder);

    if (migrateLegacy && preview.legacy) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupRoot = `${config.paths.internal}/backups/${stamp}`;
      await ensureAdapterFolder(this.adapter, backupRoot);
      for (const path of ["CLAUDE.md", "index.md", "log.md", "llm-wiki.config.json", ".llm-wiki/state.json"]) {
        if (await this.adapter.exists(path)) await this.backupPath(path, `${backupRoot}/${path}`);
      }
      const legacyRawFiles = preview.parsingFrameworkV2
        ? []
        : this.listVaultFilesUnder(config.paths.raw)
          .filter((file) => ["md", "txt", "pdf"].includes(file.extension.toLocaleLowerCase()));
      for (const file of legacyRawFiles) await this.backupBinaryPath(file.path, `${backupRoot}/${file.path}`);
      const manifestOriginals = new Map<string, string>();
      const configOriginal = await this.adapter.exists("llm-wiki.config.json")
        ? await this.adapter.read("llm-wiki.config.json")
        : null;
      const manifestRoot = `${config.paths.internal}/manifests`;
      if (preview.parsingFrameworkV2 && await this.adapter.exists(manifestRoot)) {
        const listing = await this.adapter.list(manifestRoot);
        for (const path of listing.files.filter((item) => item.endsWith(".json"))) {
          const original = await this.adapter.read(path);
          manifestOriginals.set(path, original);
          await this.backupPath(path, `${backupRoot}/${path}`);
        }
      }
      const pageOriginals = new Map<string, string>();
      const migrationPages = await this.readPagesFromPath("wiki");
      const backupPagePaths = new Set([
        ...preview.pages.filter((entry) => entry.changed).map((entry) => entry.path),
        ...migrationPages.filter((page) => page.type === "source").map((page) => page.path)
      ]);
      for (const path of backupPagePaths) {
        const file = this.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) continue;
        const original = await this.vault.read(file);
        pageOriginals.set(path, original);
        await this.backupPath(path, `${backupRoot}/${path}`);
      }
      try {
        for (const item of preview.pages.filter((entry) => entry.changed)) {
          const file = this.vault.getAbstractFileByPath(item.path);
          if (!(file instanceof TFile)) continue;
          const original = await this.vault.read(file);
          const migrated = canonicalizePage(item.path, original);
          if (migrated.changed) await this.vault.modify(file, migrated.content);
        }
        this.config = config;
        this.parsing = null;
        if (preview.parsingFrameworkV2) {
          await this.migrateParsingFrameworkV2(manifestOriginals);
          await this.adapter.write("llm-wiki.config.json", `${JSON.stringify(config, null, 2)}\n`);
          configWrittenDuringMigration = true;
        } else {
          await this.migrateLegacyRaw(legacyRawFiles);
        }
      } catch (error) {
        for (const [path, original] of pageOriginals) await this.writeVisible(path, original);
        for (const [path, original] of manifestOriginals) {
          await atomicReplaceText(this.adapter, path, original);
        }
        if (configOriginal !== null) {
          await this.adapter.write("llm-wiki.config.json", configOriginal);
        }
        this.config = null;
        this.parsing = null;
        throw error;
      }
    }

    if (!configWrittenDuringMigration) {
      await this.adapter.write("llm-wiki.config.json", `${JSON.stringify(config, null, 2)}\n`);
    }
    this.config = config;
    this.parsing = null;
    if (migrateLegacy && preview.legacy) await this.writeVisible("CLAUDE.md", renderClaudeMd(config));
    else await this.writeIfMissing("CLAUDE.md", renderClaudeMd(config));
    await this.writeIfMissing("index.md", renderInitialIndex(config));
    await this.writeIfMissing("log.md", "# 操作日志\n");
    for (const type of ["source", "entity", "concept", "synthesis", "output"] as WikiPageType[]) {
      await this.writeIfMissing(`templates/${type}.md`, renderTemplate(type));
    }
    this.state = preservedState ?? structuredClone(EMPTY_STATE);
    this.legacyRawState = null;
    await this.writeInternalJson(`${config.paths.internal}/state.json`, this.state);
    await this.reindex();
    await this.appendLog("Init", migrateLegacy && preview.legacy ? "初始化插件并迁移旧 Wiki" : "初始化 LLM Wiki");
    return preview;
  }

  async readPages(): Promise<WikiPage[]> {
    const config = await this.loadConfig();
    return this.readPagesFromPath(config.paths.wiki);
  }

  async readWikiPage(path: string): Promise<WikiPage> {
    const normalized = normalizeVaultPath(path);
    const config = await this.loadConfig();
    if (!normalized.startsWith(`${normalizeVaultPath(config.paths.wiki)}/`)
      || !normalized.endsWith(".md")
      || normalized.includes("../")) {
      throw new Error(`禁止读取路径：${path}`);
    }
    const file = this.vault.getAbstractFileByPath(normalized);
    if (!(file instanceof TFile)) throw new Error(`Wiki 页面不存在：${normalized}`);
    const content = await this.vault.cachedRead(file);
    const page = parseMarkdown(normalized, content);
    if (!page) throw new Error(`Wiki 页面不符合 Schema：${normalized}`);
    return page;
  }

  async readPagesFromPath(root: string): Promise<WikiPage[]> {
    const pages: WikiPage[] = [];
    for (const file of this.listVaultFilesUnder(root).filter((item) => item.extension.toLocaleLowerCase() === "md")) {
      const content = await this.vault.cachedRead(file);
      const parsed = parseMarkdown(file.path, content);
      if (parsed) pages.push(parsed);
    }
    return pages;
  }

  async runLint(): Promise<LintReport> {
    const config = await this.loadConfig();
    const pages = await this.readPages();
    const paths = (await this.listAllPaths()).concat([config.paths.index]);
    return lintWiki(pages, config, paths);
  }

  async reindex(): Promise<void> {
    const config = await this.loadConfig();
    const pages = await this.readPages();
    const fingerprint = this.wikiFingerprint(config);
    const navigation = buildNavigationIndex(pages, fingerprint);
    await this.writeVisible(config.paths.index, generateIndex(pages, config));
    await atomicReplaceText(
      this.adapter,
      `${config.paths.internal}/retrieval/navigation-index-v1.json`,
      `${JSON.stringify(navigation, null, 2)}\n`
    );
    this.navigationIndex = navigation;
    this.navigationIndexDirty = false;
  }

  markNavigationIndexDirty(path?: string): void {
    if (path && this.config) {
      const prefix = `${normalizeVaultPath(this.config.paths.wiki).replace(/\/$/, "")}/`;
      if (!normalizeVaultPath(path).startsWith(prefix)) return;
    }
    this.navigationIndexDirty = true;
  }

  async getNavigationIndex(): Promise<WikiNavigationIndex> {
    const config = await this.loadConfig();
    const fingerprint = this.wikiFingerprint(config);
    if (!this.navigationIndexDirty && this.navigationIndex?.fingerprint === fingerprint) return this.navigationIndex;
    const path = `${config.paths.internal}/retrieval/navigation-index-v1.json`;
    if (!this.navigationIndexDirty && await this.adapter.exists(path)) {
      try {
        const parsed: unknown = JSON.parse(await this.adapter.read(path));
        if (isNavigationIndex(parsed) && parsed.fingerprint === fingerprint) {
          this.navigationIndex = parsed;
          return parsed;
        }
      } catch {
        // Derived indexes are rebuilt below when unreadable.
      }
    }
    await this.reindex();
    return this.navigationIndex!;
  }

  async navigationRootPrompt(): Promise<string> {
    return renderRootIndexForPrompt(await this.getNavigationIndex());
  }

  async navigationRootView() {
    return rootIndexView(await this.getNavigationIndex());
  }

  async readNavigationIndex(input: {
    type?: WikiPageType;
    tag?: string;
    cursor?: string;
    limit?: number;
  }) {
    return indexPage(await this.getNavigationIndex(), input);
  }

  async search(query: string): Promise<SearchResult[]> {
    const config = await this.loadConfig();
    return retrieve(query, await this.readPages(), config.retrieval.topK, config.retrieval.maxPages);
  }

  private wikiFingerprint(config: WikiConfig): string {
    const entries = this.listVaultFilesUnder(config.paths.wiki)
      .filter((file) => file.extension.toLocaleLowerCase() === "md")
      .map((file) => `${normalizeVaultPath(file.path)}\u0000${file.stat.mtime}\u0000${file.stat.size}`)
      .sort();
    return sha256(entries.join("\n"));
  }

  async listSources(): Promise<SourceManifest[]> {
    if (await this.requiresParsingMigration()) {
      const config = await this.loadConfig();
      return new SourceStore(this.adapter, config.paths.internal).listManifests();
    }
    return (await this.parsingService()).listSources();
  }

  async getSource(sourceId: string): Promise<SourceManifest> {
    await this.ensureParsingFrameworkCurrent();
    return (await this.parsingService()).getSource(sourceId);
  }

  async readVerifiedSource(sourceId: string): Promise<{ manifest: SourceManifest; content: string }> {
    await this.ensureParsingFrameworkCurrent();
    return (await this.parsingService()).readVerifiedSource(sourceId);
  }

  async writeAgentRunAudit(record: Record<string, unknown>): Promise<void> {
    const config = await this.loadConfig();
    const sessionId = String(record.sessionId ?? "");
    if (!/^[a-zA-Z0-9-]{8,80}$/.test(sessionId)) throw new Error("Agent audit sessionId 无效");
    await this.writeInternalJson(`${config.paths.internal}/agent-runs/${sessionId}.json`, record);
  }

  async subscribeParseProgress(listener: ParseProgressListener): Promise<() => void> {
    await this.ensureParsingFrameworkCurrent();
    return (await this.parsingService()).subscribeProgress(listener);
  }

  async requiresParsingMigration(): Promise<boolean> {
    if (!(await this.isInitialized())) return false;
    try {
      const config = JSON.parse(await this.adapter.read("llm-wiki.config.json")) as { schemaVersion?: number };
      return config.schemaVersion !== 4;
    } catch {
      return true;
    }
  }

  async verifyRaw(): Promise<RawVerification[]> {
    await this.ensureParsingFrameworkCurrent();
    return (await this.parsingService()).verifyRaw();
  }

  async importFiles(files: File[]): Promise<SourceManifest[]> {
    await this.ensureParsingFrameworkCurrent();
    return (await this.parsingService()).importFiles(files);
  }

  async importSourceDetailed(
    name: string,
    source: Uint8Array | SourceBody,
    provenance: IntakeProvenance
  ): Promise<{ manifest: SourceManifest; duplicate: boolean }> {
    await this.ensureParsingFrameworkCurrent();
    return (await this.parsingService()).importSourceDetailed(name, source, provenance);
  }

  async reparseSource(sourceId: string): Promise<SourceManifest> {
    await this.ensureParsingFrameworkCurrent();
    return (await this.parsingService()).parseSource(sourceId, true);
  }

  async reparseSourceWith(sourceId: string, parserId: string): Promise<SourceManifest> {
    await this.ensureParsingFrameworkCurrent();
    return (await this.parsingService()).parseSourceWith(sourceId, parserId);
  }

  async cancelParse(sourceId: string): Promise<boolean> {
    return (await this.parsingService()).cancelParse(sourceId);
  }

  dispose(): void {
    this.parsing?.dispose();
  }

  async updateParsingProvider(
    providerId: string,
    provider: WikiConfig["parsing"]["providers"][string]
  ): Promise<void> {
    await this.ensureParsingFrameworkCurrent();
    const parser = this.parserRegistryFactory?.().list()
      .find((candidate) => candidate.descriptor.id === providerId);
    parser?.validateOptions(provider.options);
    const current = await this.loadConfig();
    const active = (await this.listSources()).some((source) => source.parse.status === "parsing");
    if (active) throw new Error("存在进行中的解析任务，请等待完成后再修改 Parser Provider");
    const next = mergeConfig({
      ...current,
      parsing: {
        ...current.parsing,
        providers: { ...current.parsing.providers, [providerId]: provider }
      }
    });
    await atomicReplaceText(this.adapter, "llm-wiki.config.json", `${JSON.stringify(next, null, 2)}\n`);
    this.config = next;
    this.parsing = null;
  }

  async testParserConnection(providerId: string): Promise<{ ok: boolean; message: string }> {
    const config = await this.loadConfig();
    const parser = this.parserRegistryFactory?.().list()
      .find((candidate) => candidate.descriptor.id === providerId) as (DocumentParserWithConnection | undefined);
    if (!parser?.testConnection) throw new Error(`Parser 不支持连接测试：${providerId}`);
    return parser.testConnection(config.parsing.providers[providerId]?.options ?? {});
  }

  async testParserVisualConnection(providerId: string): Promise<{ ok: boolean; message: string }> {
    const config = await this.loadConfig();
    const parser = this.parserRegistryFactory?.().list()
      .find((candidate) => candidate.descriptor.id === providerId) as (DocumentParserWithConnection | undefined);
    if (!parser?.testVisualConnection) throw new Error(`Parser 不支持视觉连接测试：${providerId}`);
    return parser.testVisualConnection(config.parsing.providers[providerId]?.options ?? {});
  }

  async testParserFfmpeg(providerId: string): Promise<{ ok: boolean; message: string }> {
    const config = await this.loadConfig();
    const parser = this.parserRegistryFactory?.().list()
      .find((candidate) => candidate.descriptor.id === providerId) as (DocumentParserWithConnection | undefined);
    if (!parser?.testFfmpeg) throw new Error(`Parser 不支持 FFmpeg 测试：${providerId}`);
    return parser.testFfmpeg(config.parsing.providers[providerId]?.options ?? {});
  }

  async beginIngest(sourceId: string): Promise<{
    input: IngestInput;
    content: string;
    attemptId: string;
  }> {
    await this.ensureParsingFrameworkCurrent();
    return (await this.parsingService()).beginIngest(sourceId);
  }

  async updateIngestAttempt(
    sourceId: string,
    attemptId: string,
    status: SourceManifest["ingest"]["status"],
    updates: {
      operationId?: string;
      sourcePage?: string;
      acceptedPaths?: string[];
      coverage?: import("../types").IngestCoverageReport;
      hasUserExclusions?: boolean;
      rolledBackAt?: string;
      rollbackOperationId?: string;
      error?: import("../types").PipelineError;
    } = {}
  ): Promise<SourceManifest> {
    await this.ensureParsingFrameworkCurrent();
    return (await this.parsingService()).updateIngestAttempt(sourceId, attemptId, status, updates);
  }

  async pipelineError(
    error: unknown,
    stage: import("../types").PipelineError["stage"]
  ): Promise<import("../types").PipelineError> {
    return toPipelineError(error, stage);
  }

  async currentHashes(): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (const page of await this.readPages()) result.set(page.path, sha256(page.content));
    return result;
  }

  async preparePlan(input: unknown): Promise<WikiChangePlan> {
    const hashes = await this.currentHashes();
    return validateChangePlan(sanitizePlanDanglingLinks(input, hashes), hashes);
  }

  async validateAgentPlan(input: unknown): Promise<WikiChangePlan> {
    return validateChangePlan(input, await this.currentHashes());
  }

  async applyPlan(input: unknown): Promise<WikiChangePlan> {
    const plan = validateChangePlan(input, await this.currentHashes());
    const journal: TransactionJournal = {
      id: plan.operationId,
      status: "prepared",
      createdAt: new Date().toISOString(),
      kind: "apply",
      plan,
      originals: {}
    };
    for (const operation of plan.operations) {
      const file = this.vault.getAbstractFileByPath(operation.path);
      journal.originals[operation.path] = file instanceof TFile ? await this.vault.read(file) : null;
    }
    const journalPath = await this.transactionJournalPath(plan.operationId);
    const receiptPath = await this.rollbackReceiptPath(plan.operationId);
    journal.receiptPath = receiptPath;
    await this.writeInternalJson(journalPath, journal);
    journal.status = "applying";
    await this.writeInternalJson(journalPath, journal);
    try {
      for (const operation of plan.operations) {
        await ensureVisibleParent(this.vault, operation.path);
        const file = this.vault.getAbstractFileByPath(operation.path);
        if (operation.action === "create") {
          if (file) throw new Error(`创建目标已存在：${operation.path}`);
          await this.vault.create(operation.path, operation.content);
        } else {
          if (!(file instanceof TFile)) throw new Error(`更新目标不存在：${operation.path}`);
          await this.vault.modify(file, operation.content);
        }
      }
      await this.reindex();
      const lint = await this.runLint();
      const errors = lint.issues.filter((issue) => issue.severity === "error").length;
      const receipt: RollbackReceipt = {
        version: 1,
        operationId: plan.operationId,
        status: "applied",
        summary: plan.summary,
        appliedAt: new Date().toISOString(),
        sourceIds: [...new Set(plan.ingestCoverage?.sources.map((source) => source.sourceId) ?? [])],
        changes: plan.operations.map((operation) => ({
          path: operation.path,
          originalAction: operation.action,
          rollbackAction: journal.originals[operation.path] === null ? "delete" : "restore",
          before: journal.originals[operation.path] ?? null,
          afterHash: sha256(operation.content)
        }))
      };
      await this.writeInternalJson(receiptPath, receipt);
      await this.appendLog("Apply", `${plan.summary}（${plan.operations.length} 个文件，Lint ${errors} 个错误）`);
      await this.recordOperation(plan.operationId, "apply", plan.summary);
      await this.adapter.remove(journalPath);
      return plan;
    } catch (error) {
      await this.rollbackJournal(journal);
      await this.reindex().catch(() => undefined);
      if (await this.adapter.exists(receiptPath)) await this.adapter.remove(receiptPath).catch(() => undefined);
      await this.adapter.remove(journalPath);
      throw error;
    }
  }

  async previewRollback(operationId: string): Promise<RollbackPreview> {
    const receiptPath = await this.rollbackReceiptPath(operationId);
    if (!(await this.adapter.exists(receiptPath))) {
      return {
        operationId, available: false, sourceIds: [], changes: [], conflicts: [],
        unavailableReason: "该操作完成时尚未保存回滚快照，无法安全恢复更新前正文"
      };
    }
    const receipt = this.parseRollbackReceipt(await this.adapter.read(receiptPath), operationId);
    const conflicts = await this.rollbackConflicts(receipt);
    return {
      operationId,
      available: receipt.status === "applied",
      status: receipt.status,
      summary: receipt.summary,
      appliedAt: receipt.appliedAt,
      sourceIds: [...receipt.sourceIds],
      changes: receipt.changes.map(({ before: _before, ...change }) => change),
      conflicts,
      ...(receipt.status === "rolled_back" ? { unavailableReason: "该 Ingest 已经回滚" } : {})
    };
  }

  async rollbackOperation(operationId: string): Promise<RollbackResult> {
    const receiptPath = await this.rollbackReceiptPath(operationId);
    if (!(await this.adapter.exists(receiptPath))) throw new Error("该操作没有可用的回滚快照");
    const receipt = this.parseRollbackReceipt(await this.adapter.read(receiptPath), operationId);
    if (receipt.status !== "applied") throw new Error("该操作已经回滚，不能重复执行");
    const conflicts = await this.rollbackConflicts(receipt);
    if (conflicts.length > 0) {
      throw new Error(`回滚冲突：${conflicts.map((item) => `${item.path}（${item.reason}）`).join("；")}`);
    }

    const rollbackOperationId = crypto.randomUUID();
    const journal: TransactionJournal = {
      id: rollbackOperationId,
      status: "prepared",
      createdAt: new Date().toISOString(),
      kind: "rollback",
      originals: {},
      receiptPath,
      receiptBefore: structuredClone(receipt)
    };
    for (const change of receipt.changes) {
      const file = this.vault.getAbstractFileByPath(change.path);
      journal.originals[change.path] = file instanceof TFile ? await this.vault.read(file) : null;
    }
    const journalPath = await this.transactionJournalPath(rollbackOperationId);
    await this.writeInternalJson(journalPath, journal);
    journal.status = "applying";
    await this.writeInternalJson(journalPath, journal);
    try {
      const restoredPaths: string[] = [];
      const deletedPaths: string[] = [];
      for (const change of [...receipt.changes].reverse()) {
        const file = this.vault.getAbstractFileByPath(change.path);
        if (change.before === null) {
          if (!(file instanceof TFile)) throw new Error(`回滚删除目标不存在：${change.path}`);
          await this.app.fileManager.trashFile(file);
          deletedPaths.push(change.path);
        } else if (file instanceof TFile) {
          await this.vault.modify(file, change.before);
          restoredPaths.push(change.path);
        } else {
          await ensureVisibleParent(this.vault, change.path);
          await this.vault.create(change.path, change.before);
          restoredPaths.push(change.path);
        }
      }
      await this.reindex();
      const lint = await this.runLint();
      const lintErrors = lint.issues.filter((issue) => issue.severity === "error").length;
      receipt.status = "rolled_back";
      receipt.rolledBackAt = new Date().toISOString();
      receipt.rollbackOperationId = rollbackOperationId;
      await atomicReplaceText(this.adapter, receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
      await this.appendLog("Rollback", `回滚 ${receipt.summary}（恢复 ${restoredPaths.length}，删除 ${deletedPaths.length}，Lint ${lintErrors} 个错误）`);
      await this.recordOperation(rollbackOperationId, "rollback", `回滚 ${receipt.summary}`);
      await this.adapter.remove(journalPath);
      return { operationId, rollbackOperationId, restoredPaths, deletedPaths, lintErrors };
    } catch (error) {
      await this.rollbackJournal(journal);
      await this.reindex().catch(() => undefined);
      if (journal.receiptBefore) {
        await atomicReplaceText(this.adapter, receiptPath, `${JSON.stringify(journal.receiptBefore, null, 2)}\n`).catch(() => undefined);
      }
      await this.adapter.remove(journalPath).catch(() => undefined);
      throw error;
    }
  }

  async previewSourceDeletion(sourceId: string): Promise<SourceDeletionPreview> {
    const manifest = await this.getSource(sourceId);
    const config = await this.loadConfig();
    const blockers: SourceDeletionPreview["blockers"] = [];
    if (manifest.parse.status === "parsing") {
      blockers.push({ reason: "该来源正在解析，请先等待解析结束或取消任务" });
    }
    const receipts: RollbackReceipt[] = [];
    const allOperationIds = [...new Set(manifest.ingest.attempts
      .filter((attempt) => attempt.operationId)
      .map((attempt) => attempt.operationId!))];
    const operationIds = [...new Set(manifest.ingest.attempts
      .filter((attempt) => attempt.status === "ingested" && attempt.operationId)
      .map((attempt) => attempt.operationId!))];
    for (const operationId of operationIds) {
      const path = await this.rollbackReceiptPath(operationId);
      if (!(await this.adapter.exists(path))) {
        blockers.push({ reason: `Ingest ${operationId} 没有回滚快照，无法判定其 Wiki 改动` });
        continue;
      }
      const receipt = this.parseRollbackReceipt(await this.adapter.read(path), operationId);
      if (receipt.status === "rolled_back") continue;
      if (receipt.sourceIds.length !== 1 || receipt.sourceIds[0] !== sourceId) {
        blockers.push({ reason: `Ingest ${operationId} 与其他来源共享一个批次，不能单独删除` });
        continue;
      }
      receipts.push(receipt);
    }
    receipts.sort((left, right) => right.appliedAt.localeCompare(left.appliedAt));
    const chainConflicts = await this.sourceDeletionConflicts(receipts);
    blockers.push(...chainConflicts);
    if (chainConflicts.length === 0 && receipts.length > 0) {
      const finalContents = new Map<string, string | null>();
      const affected = new Set<string>();
      for (const receipt of receipts) {
        for (const change of receipt.changes) {
          affected.add(change.path);
          finalContents.set(change.path, change.before);
        }
      }
      const deletedTargets = new Set([...finalContents.entries()]
        .filter(([, content]) => content === null)
        .map(([path]) => normalizeVaultPath(path).replace(/\.md$/i, "")));
      for (const page of await this.readPages()) {
        if (affected.has(page.path)) continue;
        const dangling = page.links.find((link) => deletedTargets.has(normalizeVaultPath(link).replace(/\.md$/i, "")));
        if (dangling) blockers.push({ path: page.path, reason: `其他 Wiki 页面仍引用将删除的页面：${dangling}` });
      }
    }
    const dataPaths = await this.sourceDataPaths(manifest, allOperationIds, config);
    return {
      sourceId,
      sourceName: manifest.original.name,
      wikiChanges: receipts.flatMap((receipt) => receipt.changes.map((change) => ({
        path: change.path,
        action: change.rollbackAction
      }))),
      dataPaths,
      blockers
    };
  }

  async deleteSource(sourceId: string): Promise<SourceDeletionResult> {
    const preview = await this.previewSourceDeletion(sourceId);
    if (preview.blockers.length > 0) {
      throw new Error(`删除被阻止：${preview.blockers.map((item) => item.reason).join("；")}`);
    }
    const manifest = await this.getSource(sourceId);
    const receipts: RollbackReceipt[] = [];
    const allOperationIds = [...new Set(manifest.ingest.attempts
      .filter((attempt) => attempt.operationId)
      .map((attempt) => attempt.operationId!))];
    const operationIds = [...new Set(manifest.ingest.attempts
      .filter((attempt) => attempt.status === "ingested" && attempt.operationId)
      .map((attempt) => attempt.operationId!))];
    for (const operationId of operationIds) {
      const path = await this.rollbackReceiptPath(operationId);
      if (!(await this.adapter.exists(path))) continue;
      const receipt = this.parseRollbackReceipt(await this.adapter.read(path), operationId);
      if (receipt.status === "applied") receipts.push(receipt);
    }
    receipts.sort((left, right) => right.appliedAt.localeCompare(left.appliedAt));
    const restoredWikiPaths: string[] = [];
    const deletedWikiPaths: string[] = [];
    for (const receipt of receipts) {
      const result = await this.rollbackOperation(receipt.operationId);
      restoredWikiPaths.push(...result.restoredPaths);
      deletedWikiPaths.push(...result.deletedPaths);
    }

    const deletionOperationId = crypto.randomUUID();
    const config = await this.loadConfig();
    const paths = await this.sourceDataPaths(manifest, allOperationIds, config);
    const stagingRoot = `${config.paths.internal}/deletions/${deletionOperationId}`;
    await ensureAdapterFolder(this.adapter, stagingRoot);
    const moved: Array<{ from: string; to: string }> = [];
    try {
      for (const [index, path] of paths.entries()) {
        if (!(await this.adapter.exists(path))) continue;
        const target = `${stagingRoot}/${String(index).padStart(5, "0")}`;
        await this.adapter.rename(path, target);
        moved.push({ from: path, to: target });
      }
    } catch (error) {
      for (const item of [...moved].reverse()) {
        if (await this.adapter.exists(item.to)) {
          await ensureAdapterFolder(this.adapter, item.from.split("/").slice(0, -1).join("/"));
          await this.adapter.rename(item.to, item.from).catch(() => undefined);
        }
      }
      throw error;
    }
    await this.adapter.rmdir(stagingRoot, true).catch(() => undefined);
    await this.reindex();
    await this.appendLog("Delete Source", `删除来源 ${manifest.original.name}（${sourceId}），清理 ${moved.length} 个数据文件`);
    await this.recordOperation(deletionOperationId, "delete-source", `删除来源 ${manifest.original.name}`);
    return {
      sourceId,
      deletionOperationId,
      deletedDataPaths: moved.map((item) => item.from),
      restoredWikiPaths: [...new Set(restoredWikiPaths)],
      deletedWikiPaths: [...new Set(deletedWikiPaths)]
    };
  }

  async recoverTransactions(): Promise<number> {
    const config = await this.loadConfig();
    const root = `${config.paths.internal}/transactions`;
    if (!(await this.adapter.exists(root))) return 0;
    const listing = await this.adapter.list(root);
    let recovered = 0;
    for (const path of listing.files.filter((item) => item.endsWith(".json"))) {
      try {
        const journal = JSON.parse(await this.adapter.read(path)) as TransactionJournal;
        await this.rollbackJournal(journal);
        if (journal.kind === "rollback" && journal.receiptPath && journal.receiptBefore) {
          await atomicReplaceText(
            this.adapter,
            journal.receiptPath,
            `${JSON.stringify(journal.receiptBefore, null, 2)}\n`
          );
        } else if (journal.kind === "apply" && journal.receiptPath && await this.adapter.exists(journal.receiptPath)) {
          await this.adapter.remove(journal.receiptPath);
        }
        await this.adapter.remove(path);
        recovered += 1;
      } catch {
        // Keep malformed journals for manual inspection.
      }
    }
    return recovered;
  }

  async buildContext(results: SearchResult[]): Promise<string> {
    return results.map(({ page, score }) => [
      `--- PAGE ${page.path} | score=${score.toFixed(2)} | sha256=${sha256(page.content)} ---`,
      page.content
    ].join("\n")).join("\n\n");
  }

  private async rollbackJournal(journal: TransactionJournal): Promise<void> {
    for (const [path, original] of Object.entries(journal.originals).reverse()) {
      const file = this.vault.getAbstractFileByPath(path);
      if (original === null) {
        if (file instanceof TFile) await this.app.fileManager.trashFile(file);
      } else if (file instanceof TFile) {
        await this.vault.modify(file, original);
      } else {
        await ensureVisibleParent(this.vault, path);
        await this.vault.create(path, original);
      }
    }
  }

  private async rollbackReceiptPath(operationId: string): Promise<string> {
    if (!/^[a-zA-Z0-9-]{8,100}$/.test(operationId)) throw new Error("operationId 无效");
    const config = await this.loadConfig();
    return `${config.paths.internal}/operations/${operationId}.json`;
  }

  private async transactionJournalPath(operationId: string): Promise<string> {
    if (!/^[a-zA-Z0-9-]{8,100}$/.test(operationId)) throw new Error("operationId 无效");
    const config = await this.loadConfig();
    return `${config.paths.internal}/transactions/${operationId}.json`;
  }

  private parseRollbackReceipt(content: string, operationId: string): RollbackReceipt {
    const value = JSON.parse(content) as Partial<RollbackReceipt>;
    if (value.version !== 1 || value.operationId !== operationId
      || (value.status !== "applied" && value.status !== "rolled_back")
      || !Array.isArray(value.sourceIds) || !Array.isArray(value.changes)) {
      throw new Error("回滚快照损坏");
    }
    for (const change of value.changes) {
      if (!change || typeof change.path !== "string" || !change.path.startsWith("wiki/")
        || (change.originalAction !== "create" && change.originalAction !== "update")
        || (change.rollbackAction !== "delete" && change.rollbackAction !== "restore")
        || typeof change.afterHash !== "string" || !/^[a-f0-9]{64}$/.test(change.afterHash)
        || (change.before !== null && typeof change.before !== "string")) {
        throw new Error("回滚快照包含无效文件记录");
      }
    }
    return value as RollbackReceipt;
  }

  private async rollbackConflicts(receipt: RollbackReceipt): Promise<Array<{ path: string; reason: string }>> {
    const conflicts: Array<{ path: string; reason: string }> = [];
    for (const change of receipt.changes) {
      const file = this.vault.getAbstractFileByPath(change.path);
      if (!(file instanceof TFile)) {
        conflicts.push({ path: change.path, reason: "文件已不存在" });
        continue;
      }
      const currentHash = sha256(await this.vault.read(file));
      if (currentHash !== change.afterHash) conflicts.push({ path: change.path, reason: "文件已被后续修改" });
    }
    return conflicts;
  }

  private async sourceDeletionConflicts(receipts: RollbackReceipt[]): Promise<Array<{ path?: string; reason: string }>> {
    const simulated = new Map<string, string | undefined>();
    for (const receipt of receipts) {
      for (const change of receipt.changes) {
        if (!simulated.has(change.path)) {
          const file = this.vault.getAbstractFileByPath(change.path);
          simulated.set(change.path, file instanceof TFile ? await this.vault.read(file) : undefined);
        }
      }
    }
    return validateSourceDeletionChain(receipts, simulated);
  }

  private async sourceDataPaths(
    manifest: SourceManifest,
    operationIds: string[],
    config: WikiConfig
  ): Promise<string[]> {
    const paths = new Set<string>();
    for (const revision of manifest.parse.revisions) {
      paths.add(normalizeVaultPath(revision.rawPath));
      if (revision.sourceMapPath) paths.add(normalizeVaultPath(revision.sourceMapPath));
      for (const asset of revision.assets ?? []) paths.add(normalizeVaultPath(asset.path));
    }
    const manifests = await this.listSources();
    if (!manifests.some((item) => item.sourceId !== manifest.sourceId
      && normalizeVaultPath(item.original.objectPath) === normalizeVaultPath(manifest.original.objectPath))) {
      paths.add(normalizeVaultPath(manifest.original.objectPath));
    }
    for (const operationId of operationIds) {
      const receiptPath = await this.rollbackReceiptPath(operationId);
      if (!(await this.adapter.exists(receiptPath))) continue;
      try {
        const receipt = this.parseRollbackReceipt(await this.adapter.read(receiptPath), operationId);
        if (receipt.sourceIds.length === 1 && receipt.sourceIds[0] === manifest.sourceId) paths.add(receiptPath);
      } catch {
        // Preserve malformed receipts for manual recovery rather than deleting unverifiable data.
      }
    }
    paths.add(`${config.paths.internal}/manifests/${manifest.sourceId}.json`);
    for (const root of [
      `${config.paths.raw}/assets/${manifest.sourceId}`,
      `${config.paths.internal}/source-maps/${manifest.sourceId}`,
      `${config.paths.internal}/parse-staging/${manifest.sourceId}`
    ]) {
      for (const path of await listAdapterFilesRecursive(this.adapter, root)) paths.add(path);
    }
    const auditRoot = `${config.paths.internal}/agent-runs`;
    if (await this.adapter.exists(auditRoot)) {
      const listing = await this.adapter.list(auditRoot);
      for (const path of listing.files.filter((item) => item.endsWith(".json"))) {
        try {
          const content = await this.adapter.read(path);
          const shared = manifests.some((item) => item.sourceId !== manifest.sourceId && content.includes(item.sourceId));
          if (content.includes(manifest.sourceId) && !shared) paths.add(path);
        } catch {
          // Malformed audit files are preserved for inspection.
        }
      }
    }
    return [...paths].filter((path) => isSourceManagedPath(path, config, manifest.sourceId)).sort();
  }

  private async saveState(): Promise<void> {
    if (!this.state) return;
    const config = await this.loadConfig();
    const value = this.legacyRawState
      ? {
        schemaVersion: 1,
        raw: this.legacyRawState,
        recentOperations: this.state.recentOperations
      }
      : this.state;
    await this.writeInternalJson(`${config.paths.internal}/state.json`, value);
  }

  private async recordOperation(id: string, type: string, summary: string): Promise<void> {
    const state = await this.loadState();
    state.recentOperations.unshift({ id, type, summary, at: new Date().toISOString() });
    state.recentOperations = state.recentOperations.slice(0, 50);
    await this.saveState();
  }

  private async appendLog(type: string, summary: string): Promise<void> {
    const config = await this.loadConfig();
    const file = this.vault.getAbstractFileByPath(config.paths.log);
    const entry = `\n## [${isoDate()}]\n### ${type}\n- ${summary}\n`;
    if (file instanceof TFile) {
      await this.vault.process(file, (content) => `${content.trimEnd()}\n${entry}`);
    } else {
      await this.vault.create(config.paths.log, `# 操作日志\n${entry}`);
    }
  }

  private async writeVisible(path: string, content: string): Promise<void> {
    await ensureVisibleParent(this.vault, path);
    const file = this.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) await this.vault.modify(file, content);
    else await this.vault.create(path, content);
  }

  private async writeIfMissing(path: string, content: string): Promise<void> {
    if (!(await this.adapter.exists(path))) await this.writeVisible(path, content);
  }

  private async writeInternalJson(path: string, value: unknown): Promise<void> {
    await ensureAdapterFolder(this.adapter, path.split("/").slice(0, -1).join("/"));
    await this.adapter.write(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  private async backupPath(source: string, target: string): Promise<void> {
    await ensureAdapterFolder(this.adapter, target.split("/").slice(0, -1).join("/"));
    if (await this.adapter.exists(source)) await this.adapter.write(target, await this.adapter.read(source));
  }

  private async backupBinaryPath(source: string, target: string): Promise<void> {
    await ensureAdapterFolder(this.adapter, target.split("/").slice(0, -1).join("/"));
    if (await this.adapter.exists(source)) {
      await this.adapter.writeBinary(target, await this.adapter.readBinary(source));
    }
  }

  private async parsingService(): Promise<ParsingFacade> {
    if (this.parsing) return this.parsing;
    this.parsing = new ParsingFacade(
      this.adapter,
      await this.loadConfig(),
      undefined,
      this.parserRegistryFactory?.(),
      (path, content) => this.writeVisibleAtomically(path, content)
    );
    await this.parsing.initialize();
    return this.parsing;
  }

  private async ensureParsingFrameworkCurrent(): Promise<void> {
    if (await this.requiresParsingMigration()) {
      throw new Error("请先运行“初始化或迁移 Wiki”，升级解析配置和 Manifest");
    }
  }

  private async writeVisibleAtomically(path: string, content: string): Promise<void> {
    await ensureVisibleParent(this.vault, path);
    if (this.vault.getAbstractFileByPath(path)) throw new Error(`PUBLISH_CONFLICT:${path}`);
    const tempPath = `${path}.${crypto.randomUUID()}.tmp`;
    const temp = await this.vault.create(tempPath, content);
    try {
      await this.vault.rename(temp, path);
    } catch (error) {
      const current = this.vault.getAbstractFileByPath(tempPath);
      if (current instanceof TFile) await this.adapter.remove(tempPath);
      throw error;
    }
  }

  private async migrateLegacyRaw(files: TFile[]): Promise<void> {
    if (files.length === 0) return;
    const legacyState = await this.readLegacyRawState();
    const parsing = await this.parsingService();
    const manifestsBefore = new Set((await parsing.listSources()).map((manifest) => manifest.sourceId));
    const rawBefore = new Set(this.listVaultFilesUnder(this.config!.paths.raw)
      .map((file) => normalizeVaultPath(file.path)));
    const objectRoot = `${this.config!.paths.internal}/objects`;
    const internalBefore = new Set(await listAdapterFilesRecursive(this.adapter, objectRoot));
    const sourceOriginals = new Map<string, string>();
    const legacyBytes = new Map<string, Uint8Array>();
    const mappings = new Map<string, SourceManifest>();
    try {
      for (const file of files) {
        const bytes = new Uint8Array(await this.vault.readBinary(file));
        legacyBytes.set(file.path, bytes);
        const record = legacyState[file.path];
        const manifest = await parsing.importBytes(file.name, bytes, {
          importedAt: record?.importedAt,
          status: record?.status,
          sourcePage: record?.sourcePage
        });
        if (manifest.parse.status !== "parsed") {
          throw new Error(`旧素材解析失败：${file.path}（${manifest.parse.status}）`);
        }
        mappings.set(normalizeVaultPath(file.path), manifest);
      }

      for (const page of await this.readPagesFromPath("wiki")) {
        if (page.type !== "source") continue;
        const oldPath = normalizeVaultPath(String(page.frontmatter.raw_path ?? ""));
        const manifest = mappings.get(oldPath);
        if (!manifest) continue;
        const revision = manifest.parse.revisions.find((item) => item.revision === manifest.parse.currentRevision);
        if (!revision) throw new Error(`迁移后的素材缺少 revision：${oldPath}`);
        const file = this.vault.getAbstractFileByPath(page.path);
        if (!(file instanceof TFile)) throw new Error(`Source 页面不存在：${page.path}`);
        const original = await this.vault.read(file);
        const migrated = migrateSourceRawReference(
          page.path,
          original,
          oldPath,
          revision.rawPath,
          manifest.sourceHash
        );
        if (migrated.changed) {
          sourceOriginals.set(page.path, original);
          await this.vault.modify(file, migrated.content);
        }
      }

      for (const file of files) {
        const current = this.vault.getAbstractFileByPath(file.path);
        if (current instanceof TFile) await this.app.fileManager.trashFile(current);
      }
    } catch (error) {
      for (const [path, content] of sourceOriginals) {
        const file = this.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) await this.vault.modify(file, content);
      }
      for (const [path, bytes] of legacyBytes) {
        if (!this.vault.getAbstractFileByPath(path)) {
          await ensureVisibleParent(this.vault, path);
          await this.vault.createBinary(path, exactArrayBuffer(bytes));
        }
      }
      for (const manifest of await parsing.listSources()) {
        if (manifestsBefore.has(manifest.sourceId)) continue;
        for (const revision of manifest.parse.revisions) {
          if (!rawBefore.has(revision.rawPath) && await this.adapter.exists(revision.rawPath)) {
            const rawFile = this.vault.getAbstractFileByPath(revision.rawPath);
            if (rawFile instanceof TFile) await this.app.fileManager.trashFile(rawFile);
            else await this.adapter.remove(revision.rawPath);
          }
        }
        const store = new SourceStore(this.adapter, this.config!.paths.internal);
        await store.removeManifest(manifest.sourceId);
      }
      for (const path of await listAdapterFilesRecursive(this.adapter, objectRoot)) {
        if (!internalBefore.has(path) && await this.adapter.exists(path)) await this.adapter.remove(path);
      }
      throw error;
    }
  }

  private async migrateParsingFrameworkV2(manifests: Map<string, string>): Promise<void> {
    for (const [path, original] of manifests) {
      const parsed = JSON.parse(original) as { schemaVersion?: number; manifestRevision?: number };
      if (parsed.schemaVersion === 3) continue;
      if (parsed.schemaVersion !== 2) throw new Error(`不支持的 Manifest Schema：${path}`);
      const migrated = normalizeManifest(parsed, path);
      migrated.manifestRevision = Number(parsed.manifestRevision ?? 0) + 1;
      await atomicReplaceText(this.adapter, path, `${JSON.stringify(migrated, null, 2)}\n`);
      const verified = normalizeManifest(JSON.parse(await this.adapter.read(path)), path);
      if (verified.schemaVersion !== 3) throw new Error(`Manifest v3 写入校验失败：${path}`);
    }
  }

  private async readLegacyRawState(): Promise<Record<string, RawRecord>> {
    if (this.legacyRawState) return this.legacyRawState;
    const path = `${this.config?.paths.internal ?? DEFAULT_CONFIG.paths.internal}/state.json`;
    if (!(await this.adapter.exists(path))) return {};
    try {
      const value = JSON.parse(await this.adapter.read(path)) as { raw?: Record<string, RawRecord> };
      return value.raw ?? {};
    } catch {
      return {};
    }
  }

  private async listAllPaths(): Promise<string[]> {
    const config = await this.loadConfig();
    return [
      ...this.listVaultFilesUnder(config.paths.raw),
      ...this.listVaultFilesUnder(config.paths.wiki)
    ].map((file) => normalizeVaultPath(file.path));
  }

  private listVaultFilesUnder(root: string): TFile[] {
    const folder = this.vault.getFolderByPath(normalizeVaultPath(root));
    if (!folder) return [];
    const files: TFile[] = [];
    const visit = (current: TFolder): void => {
      for (const child of current.children) {
        if (child instanceof TFile) files.push(child);
        else if (child instanceof TFolder) visit(child);
      }
    };
    visit(folder);
    return files;
  }

  private async readClaudianNonSecretSettings(): Promise<MigrationPreview["claudian"]> {
    const path = ".claudian/claudian-settings.json";
    if (!(await this.adapter.exists(path))) return undefined;
    try {
      const value = JSON.parse(await this.adapter.read(path)) as Record<string, any>;
      const claude = value.providerConfigs?.claude ?? {};
      const environment = parseEnv(String(claude.environmentVariables ?? ""));
      const customLimits = value.customContextLimits ?? {};
      const ids = new Set<string>();
      for (const key of [
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL"
      ]) {
        if (environment[key]) ids.add(environment[key]);
      }
      return {
        cliPath: String(claude.cliPath || Object.values(claude.cliPathsByHost ?? {})[0] || ""),
        baseUrl: String(environment.ANTHROPIC_BASE_URL ?? ""),
        models: [...ids].map((id) => ({ id, contextWindow: Number(customLimits[id] ?? 200000) }))
      };
    } catch {
      return undefined;
    }
  }
}


async function ensureAdapterFolder(adapter: DataAdapter, folder: string): Promise<void> {
  if (!folder) return;
  const parts = normalizeVaultPath(folder).split("/");
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!(await adapter.exists(current))) await adapter.mkdir(current);
  }
}

async function ensureVisibleParent(vault: Vault, path: string): Promise<void> {
  const parts = normalizeVaultPath(path).split("/").slice(0, -1);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!vault.getAbstractFileByPath(current)) await vault.createFolder(current);
  }
}

async function listAdapterFilesRecursive(adapter: DataAdapter, root: string): Promise<string[]> {
  if (!(await adapter.exists(root))) return [];
  const listing = await adapter.list(root);
  const nested = await Promise.all(listing.folders.map((folder) => listAdapterFilesRecursive(adapter, folder)));
  return [...listing.files, ...nested.flat()];
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function parseEnv(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of input.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    if (key === "ANTHROPIC_AUTH_TOKEN" || key === "ANTHROPIC_API_KEY") continue;
    result[key] = line.slice(index + 1).trim();
  }
  return result;
}

function isSourceManagedPath(path: string, config: WikiConfig, sourceId: string): boolean {
  const normalized = normalizeVaultPath(path);
  const rawRoot = normalizeVaultPath(config.paths.raw);
  const internal = normalizeVaultPath(config.paths.internal);
  return normalized.startsWith(`${rawRoot}/`)
    || normalized.startsWith(`${internal}/objects/sha256/`)
    || normalized.startsWith(`${internal}/source-maps/${sourceId}/`)
    || normalized === `${internal}/manifests/${sourceId}.json`
    || normalized.startsWith(`${internal}/operations/`)
    || normalized.startsWith(`${internal}/agent-runs/`);
}

function renderClaudeMd(config: WikiConfig): string {
  return `# ${config.name} — Agent 规则

这是一个面向“${config.domain}”的结构化知识库，目标读者是${config.audience}，内容语言为 ${config.language}。

## 不可违反的边界

- \`raw/\` 是由插件发布的不可变规范 Markdown；原件保存在 \`${config.paths.internal}/objects/\`。新产物正文保持干净，不插入 block/page marker；\`${config.paths.internal}/source-maps/\` 仅用于兼容已有历史产物。
- \`wiki/\` 页面必须符合 \`llm-wiki.config.json\` 与 templates 中的 Schema。
- 所有写入由 LLM Wiki 插件审阅和执行；Agent 应返回结构化变更计划，不直接写文件。
- 新页面使用 kebab-case 文件名并维护 Obsidian 双链。
- 不掩盖来源之间的冲突，应在 synthesis 或 concept 中明确标注。

## 数据流

Human 导入原件 → Parser Provider → Markdown 标准化 → raw/**/*.md → Agent 分析 → WikiChangePlan → 插件校验与 Diff → wiki/ → index.md/log.md
`;
}

function renderInitialIndex(config: WikiConfig): string {
  return `# ${config.name} — 目录索引\n\n> ${config.domain}知识库\n> 最后更新：${isoDate()}\n`;
}

function renderTemplate(type: WikiPageType): string {
  const extras = type === "source"
    ? "source_type: article\nauthor: \"\"\nurl: \"\"\nraw_path: \"\"\nraw_hash: \"\"\n"
    : type === "synthesis"
      ? "sources: []\nconflicts: []\n"
      : type === "output"
        ? "output_type: tldr\n"
        : "";
  return `---
schema_version: 1
type: ${type}
title: ""
tldr: ""
status: draft
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags: []
related: []
${extras}---

# 标题

## 内容

## 关联条目
`;
}
