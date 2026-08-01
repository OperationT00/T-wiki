import {
  ItemView,
  MarkdownRenderer,
  Notice,
  TFile,
  setIcon,
  type WorkspaceLeaf
} from "obsidian";

import type LLMWikiPlugin from "../main";
import { normalizeSocialVideoTitle } from "../core/source-title";
import type {
  AgentEvent,
  ChatSession,
  IngestProgressSnapshot,
  ParseProgress,
  ParseProgressEvent,
  PluginSettings,
  SourceManifest
} from "../types";
import {
  DeleteSourceModal,
  InitializeModal,
  ReviewModal,
  RollbackModal,
  UrlCaptureModal,
  confirmAction,
  requestText,
  summarizePlan
} from "./modals";
import { sourcePipelineSteps } from "./pipeline-model";

export const VIEW_TYPE_LLM_WIKI = "llm-wiki-workbench";

type SmartMode = "query" | "agent";

export class WorkbenchView extends ItemView {
  private progressUnsubscribe?: () => void;
  private ingestProgressUnsubscribe?: () => void;
  private readonly progressSnapshots = new Map<string, ParseProgressEvent>();
  private readonly progressElements = new Map<string, ProgressElements>();
  private readonly ingestProgressSnapshots = new Map<string, IngestProgressSnapshot>();
  private readonly ingestProgressElements = new Map<string, IngestProgressElements>();
  private readonly floatingPipelines = new Set<HTMLElement>();
  private readonly pipelineAnchors = new WeakMap<HTMLElement, HTMLElement>();
  private readonly terminalProgressTimers = new Set<number>();
  private ingestElapsedTimer?: number;
  private progressRefreshScheduled = false;
  private historyDrawerOpen = false;
  private renderQueue: Promise<void> = Promise.resolve();

  constructor(leaf: WorkspaceLeaf, private readonly plugin: LLMWikiPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_LLM_WIKI;
  }

  getDisplayText(): string {
    return "T-Wiki";
  }

  getIcon(): string {
    return "library-big";
  }

  async onOpen(): Promise<void> {
    await this.render();
    this.ingestElapsedTimer = window.setInterval(() => this.refreshIngestElapsed(), 1_000);
  }

  async onClose(): Promise<void> {
    this.progressUnsubscribe?.();
    this.progressUnsubscribe = undefined;
    this.ingestProgressUnsubscribe?.();
    this.ingestProgressUnsubscribe = undefined;
    this.progressElements.clear();
    this.ingestProgressElements.clear();
    this.progressSnapshots.clear();
    this.ingestProgressSnapshots.clear();
    this.removeFloatingPipelines();
    if (this.ingestElapsedTimer !== undefined) window.clearInterval(this.ingestElapsedTimer);
    this.ingestElapsedTimer = undefined;
    for (const timer of this.terminalProgressTimers) window.clearTimeout(timer);
    this.terminalProgressTimers.clear();
  }

  async render(): Promise<void> {
    const operation = this.renderQueue.then(() => this.renderNow());
    this.renderQueue = operation.catch(() => undefined);
    return operation;
  }

  private async renderNow(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    const previousTab = root.dataset.llmWikiActiveTab;
    const previousPanel = root.querySelector<HTMLElement>(".llm-wiki-panel");
    const previousScrollTop = previousTab === this.plugin.settings.activeTab
      ? previousPanel?.scrollTop ?? 0
      : 0;
    this.removeFloatingPipelines();
    root.empty();
    this.progressElements.clear();
    this.ingestProgressElements.clear();
    root.addClass("llm-wiki-view");
    root.dataset.llmWikiActiveTab = this.plugin.settings.activeTab;
    const header = root.createDiv({ cls: "llm-wiki-header" });
    const brand = header.createDiv({ cls: "t-wiki-brand" });
    brand.createSpan({ text: "T", cls: "t-wiki-mark", attr: { "aria-hidden": "true" } });
    const brandText = brand.createDiv({ cls: "t-wiki-brand-text" });
    brandText.createEl("h2", { text: "T-Wiki" });
    brandText.createSpan({ text: "Traceable knowledge workspace" });
    const refresh = header.createEl("button", { attr: { "aria-label": "刷新" } });
    setIcon(refresh, "refresh-cw");
    refresh.onclick = () => void this.render();

    if (!(await this.plugin.wiki.isInitialized())) {
      root.dataset.llmWikiActiveTab = "home";
      const tabs = root.createDiv({ cls: "llm-wiki-tabs" });
      const homeTab = tabs.createEl("button", { text: "首页", cls: "llm-wiki-tab is-active" });
      homeTab.disabled = true;
      const panel = root.createDiv({ cls: "llm-wiki-panel" });
      this.renderInitializationHome(panel);
      return;
    }
    await this.ensureProgressSubscription();

    const tabs = root.createDiv({ cls: "llm-wiki-tabs" });
    const definitions: Array<{ id: "home" | "materials" | "smart" | "review"; label: string }> = [
      { id: "home", label: "首页" },
      { id: "materials", label: "素材" },
      { id: "smart", label: "智能" },
      { id: "review", label: "审阅" }
    ];
    for (const { id, label } of definitions) {
      const button = tabs.createEl("button", { text: label, cls: "llm-wiki-tab" });
      const isActive = id === "smart"
        ? this.plugin.settings.activeTab === "agent" || this.plugin.settings.activeTab === "query"
        : this.plugin.settings.activeTab === id;
      button.toggleClass("is-active", isActive);
      button.onclick = async () => {
        this.plugin.settings.activeTab = id === "smart"
          ? (this.plugin.settings.activeTab === "agent" ? "agent" : "query")
          : id;
        await this.plugin.saveSettings();
        await this.render();
      };
    }
    const panel = root.createDiv({ cls: "llm-wiki-panel" });
    if (this.plugin.settings.activeTab === "home") await this.renderHome(panel);
    if (this.plugin.settings.activeTab === "materials") await this.renderMaterials(panel);
    if (this.plugin.settings.activeTab === "agent" || this.plugin.settings.activeTab === "query") {
      await this.renderSmart(panel);
    }
    if (this.plugin.settings.activeTab === "review") this.renderReview(panel);
    if (previousScrollTop > 0) {
      panel.scrollTop = previousScrollTop;
      window.requestAnimationFrame(() => { panel.scrollTop = previousScrollTop; });
    }
  }

  private async renderHome(panel: HTMLElement): Promise<void> {
    const [pages, state, lint, sources] = await Promise.all([
      this.plugin.wiki.readPages(),
      this.plugin.wiki.loadState(),
      this.plugin.wiki.runLint(),
      this.plugin.wiki.listSources()
    ]);
    const grid = panel.createDiv({ cls: "llm-wiki-grid" });
    stat(grid, "Wiki 页面", pages.length);
    stat(grid, "待吸收", sources.filter((item) =>
      item.parse.status === "parsed" && item.ingest.status !== "ingested"
    ).length);
    stat(grid, "错误", lint.issues.filter((item) => item.severity === "error").length);
    stat(grid, "警告", lint.issues.filter((item) => item.severity === "warning").length);

    const actions = panel.createDiv({ cls: "llm-wiki-card llm-wiki-actions" });
    action(actions, "扫描素材", async () => {
      const report = await this.plugin.wiki.verifyRaw();
      const failures = report.filter((item) => !item.ok).length;
      new Notice(failures > 0 ? `素材校验完成：${failures} 个异常` : "素材校验通过");
      await this.render();
    });
    action(actions, "运行 Lint", async () => {
      await this.showLint(panel);
    });
    action(actions, "重建索引", async () => {
      await this.plugin.wiki.reindex();
      new Notice("index.md 已重建");
    });

    const recent = panel.createDiv({ cls: "llm-wiki-card" });
    recent.createEl("h3", { text: "最近操作" });
    if (state.recentOperations.length === 0) recent.createEl("p", { text: "暂无操作", cls: "llm-wiki-muted" });
    for (const item of state.recentOperations.slice(0, 10)) {
      recent.createEl("p", { text: `${new Date(item.at).toLocaleString()} · ${item.summary}` });
    }
  }

  private renderInitializationHome(panel: HTMLElement): void {
    const onboarding = panel.createDiv({ cls: "llm-wiki-onboarding" });
    onboarding.createSpan({ text: "首次使用", cls: "llm-wiki-onboarding-badge" });
    onboarding.createEl("h1", { text: "创建你的 T-Wiki 工作空间" });
    onboarding.createEl("p", {
      text: "当前 Vault 还是空的。初始化后即可导入文档，把原始资料持续整理成可追溯、互相链接的 Markdown Wiki。",
      cls: "llm-wiki-onboarding-lead"
    });

    const contents = onboarding.createDiv({ cls: "llm-wiki-onboarding-contents" });
    for (const [title, description] of [
      ["Raw 与 Wiki 目录", "保存规范原文和结构化知识页面"],
      ["模板与 Agent 规则", "生成 Source、Entity、Concept、Synthesis 和 Output 模板"],
      ["内部状态与索引", "建立来源追溯、解析状态、审计数据和可重建导航索引"]
    ]) {
      const item = contents.createDiv({ cls: "llm-wiki-onboarding-item" });
      const marker = item.createSpan({ cls: "llm-wiki-onboarding-check", attr: { "aria-hidden": "true" } });
      setIcon(marker, "check");
      const copy = item.createDiv();
      copy.createEl("strong", { text: title });
      copy.createSpan({ text: description });
    }

    const actions = onboarding.createDiv({ cls: "llm-wiki-onboarding-actions" });
    const initialize = actions.createEl("button", { cls: "mod-cta llm-wiki-initialize-button" });
    setIcon(initialize, "sparkles");
    initialize.createSpan({ text: "初始化 T-Wiki" });
    initialize.onclick = () => new InitializeModal(this.plugin).open();
    actions.createEl("p", {
      text: "初始化只创建本地目录和规则，不会自动上传资料或调用 LLM API。",
      cls: "llm-wiki-muted"
    });
  }

  private async showLint(panel: HTMLElement): Promise<void> {
    const old = panel.querySelector(".llm-wiki-lint");
    old?.remove();
    const report = await this.plugin.wiki.runLint();
    const card = panel.createDiv({ cls: "llm-wiki-card llm-wiki-lint" });
    card.createEl("h3", { text: `健康检查 · ${report.issues.length} 个问题` });
    for (const issue of report.issues.slice(0, 100)) {
      card.createEl("p", {
        text: `[${issue.severity}] ${issue.path} — ${issue.message}`,
        cls: issue.severity === "error" ? "llm-wiki-danger" : ""
      });
    }
  }

  private async renderMaterials(panel: HTMLElement): Promise<void> {
    if (await this.plugin.wiki.requiresParsingMigration()) {
      const migration = panel.createDiv({ cls: "llm-wiki-card" });
      migration.createEl("h3", { text: "需要升级解析存储" });
      migration.createEl("p", {
        text: "当前配置或解析 Manifest 使用旧版 Schema。请运行命令“T-Wiki: 初始化或迁移 Wiki”；升级会先备份，现有 canonical Markdown 不会被静默重解析。",
        cls: "llm-wiki-muted"
      });
      return;
    }
    const toolbar = panel.createDiv({ cls: "llm-wiki-card llm-wiki-material-toolbar" });
    const importActions = toolbar.createDiv({
      cls: "llm-wiki-material-action-group llm-wiki-material-action-group-primary"
    });
    const maintenanceActions = toolbar.createDiv({
      cls: "llm-wiki-material-action-group llm-wiki-material-action-group-secondary"
    });
    const input = toolbar.createEl("input");
    input.type = "file";
    input.multiple = true;
    // ParserRegistry decides support. Keeping this unrestricted lets a newly
    // registered provider become usable without changing the UI.
    input.accept = "";
    input.hidden = true;
    action(importActions, "选择文件", async () => input.click());
    action(importActions, "抓取网页正文", async () => new UrlCaptureModal(this.plugin, "web").open());
    action(importActions, "解析在线视频", async () => new UrlCaptureModal(this.plugin, "video").open());
    action(maintenanceActions, "扫描 Clipper Inbox", async () => {
      try {
        const result = await this.plugin.scanWebClipper();
        new Notice(`Clipper 扫描：新增 ${result.imported}，重复 ${result.duplicates}，失败 ${result.failed.length}`);
        await this.render();
      } catch (error) {
        new Notice(error instanceof Error ? error.message : String(error));
      }
    });
    action(maintenanceActions, "校验 raw/", async () => {
      const report = await this.plugin.wiki.verifyRaw();
      const failures = report.filter((item) => !item.ok).length;
      new Notice(failures > 0 ? `${failures} 个 raw 产物异常` : "raw 产物校验通过");
      await this.render();
    });
    input.onchange = async () => {
      try {
        await this.plugin.importFiles(Array.from(input.files ?? []));
        new Notice("文件已导入");
        await this.render();
      } catch (error) {
        new Notice(error instanceof Error ? error.message : String(error));
      }
    };

    panel.ondragover = (event) => {
      event.preventDefault();
      panel.addClass("is-dragging");
    };
    panel.ondragleave = () => panel.removeClass("is-dragging");
    panel.ondrop = async (event) => {
      event.preventDefault();
      panel.removeClass("is-dragging");
      try {
        await this.plugin.importFiles(Array.from(event.dataTransfer?.files ?? []));
        new Notice("文件已导入");
        await this.render();
      } catch (error) {
        new Notice(error instanceof Error ? error.message : String(error));
      }
    };

    const sources = await this.plugin.wiki.listSources();
    const parsingConfig = (await this.plugin.wiki.loadConfig()).parsing;
    const mineruEnabled = parsingConfig.providers["mineru-http"]?.enabled === true;
    const mediaProvider = parsingConfig.providers["media-transcription"];
    if (sources.length === 0) {
      panel.createEl("p", { text: "拖拽 MD、TXT、PDF、音频或视频到这里开始。", cls: "llm-wiki-muted" });
      return;
    }
    for (const source of sources) this.renderSource(panel, source, mineruEnabled, mediaProvider);
  }

  private renderSource(
    panel: HTMLElement,
    source: SourceManifest,
    mineruEnabled: boolean,
    mediaProvider?: import("../types").ParserProviderConfig
  ): void {
    const card = panel.createDiv({
      cls: "llm-wiki-card llm-wiki-source-card",
      attr: { tabindex: "0" }
    });
    const revision = source.parse.revisions.find((item) => item.revision === source.parse.currentRevision);
    const parserId = revision?.parserId ?? [...source.parse.attempts]
      .reverse()
      .find((attempt) => attempt.parserId)?.parserId;
    const storedTitle = typeof revision?.metadata.title === "string"
      ? revision.metadata.title
      : typeof source.source.metadata?.title === "string" ? source.source.metadata.title : source.original.name;
    const displayTitle = source.source.acquiredBy === "douyin-video"
      || source.source.metadata?.source_platform === "douyin"
      ? normalizeSocialVideoTitle(
        storedTitle,
        `douyin-${String(source.source.metadata?.douyin_video_id ?? source.sourceId)}`
      )
      : storedTitle;
    const heading = card.createDiv({ cls: "llm-wiki-source-heading" });
    heading.createEl("h3", { text: displayTitle });
    if (parserId) {
      heading.createSpan({
        text: parserDisplayName(parserId),
        cls: `llm-wiki-parser-badge ${parserBadgeClass(parserId)}`
      });
    }
    if (source.source.acquiredBy === "obsidian-web-clipper") {
      card.createEl("p", { text: "来源：Obsidian Web Clipper", cls: "llm-wiki-muted" });
    } else if (source.source.acquiredBy === "url-capture") {
      card.createEl("p", { text: "来源：网页直接抓取", cls: "llm-wiki-muted" });
    } else if (source.source.acquiredBy === "bilibili-video") {
      card.createEl("p", { text: "来源：Bilibili 公开字幕", cls: "llm-wiki-muted" });
    } else if (source.source.acquiredBy === "douyin-video" || source.source.metadata?.source_platform === "douyin") {
      const author = typeof source.source.metadata?.author === "string" ? ` · ${source.source.metadata.author}` : "";
      const duration = formatMediaDuration(Number(source.source.metadata?.duration_ms));
      card.createEl("p", {
        text: `来源：抖音公开视频${author}${duration ? ` · ${duration}` : ""}`,
        cls: "llm-wiki-muted"
      });
    } else if (source.source.kind === "audio" || source.source.kind === "video") {
      card.createEl("p", { text: `来源：本地${source.source.kind === "audio" ? "音频" : "视频"}`, cls: "llm-wiki-muted" });
    }
    if (source.source.kind === "video" && revision) {
      const frameCount = Number(revision.metadata.visual_frame_count ?? 0);
      card.createEl("p", {
        text: frameCount > 0 ? `图文文字稿 · ${frameCount} 张关键画面` : "纯文字稿",
        cls: "llm-wiki-muted"
      });
    }
    if (source.source.uri) {
      const openSource = card.createEl("button", { text: "打开来源网页" });
      openSource.onclick = () => void this.plugin.openUrlInBrowser(source.source.uri!);
    }
    const parseError = source.parse.error?.message;
    const lastAttempt = source.ingest.attempts.at(-1);
    const candidateProgress = this.ingestProgressSnapshots.get(source.sourceId)
      ?? this.plugin.workflows.getIngestProgress(source.sourceId);
    const ingestProgress = candidateProgress && isIngestProgressRelevant(source, candidateProgress)
      ? candidateProgress
      : undefined;
    if (ingestProgress) {
      this.ingestProgressSnapshots.set(source.sourceId, ingestProgress);
    } else {
      this.ingestProgressSnapshots.delete(source.sourceId);
    }
    const pipelineDetails = this.renderSourcePipeline(
      card,
      source,
      ingestProgress,
      parseError,
      lastAttempt?.error?.message,
      revision?.quality.overall === "warning"
    );
    const liveProgress = this.progressSnapshots.get(source.sourceId);
    if (source.parse.status === "parsing" || liveProgress) {
      const activeAttempt = [...source.parse.attempts]
        .reverse()
        .find((attempt) => attempt.status === "parsing");
      this.renderParseProgress(
        pipelineDetails,
        source.sourceId,
        liveProgress ?? activeAttempt?.progress
      );
      const cancelParse = card.createEl("button", { text: "取消解析" });
      cancelParse.onclick = async () => {
        cancelParse.disabled = true;
        await this.plugin.wiki.cancelParse(source.sourceId);
      };
    } else {
      this.progressSnapshots.delete(source.sourceId);
    }
    if (ingestProgress && ingestProgress.state !== "completed") {
      this.renderIngestProgress(pipelineDetails, source.sourceId, ingestProgress);
    }
    if (revision) {
      const openRaw = card.createEl("button", { text: "预览 Markdown" });
      openRaw.onclick = () => void this.openVaultFileExact(revision.rawPath);
      const quality = card.createEl("button", { text: "质量报告" });
      quality.onclick = () => new Notice(
        `${revision.quality.overall} · ${revision.quality.characterCount} 字符`
        + `${revision.quality.pageCount ? ` · ${revision.quality.pageCount} 页` : ""}`
        + ` · ${revision.warnings.length} 个警告`
      );
    }
    const sourcePage = [...source.ingest.attempts].reverse()
      .find((item) => item.status === "ingested" && item.sourcePage)?.sourcePage;
    if (lastAttempt?.status === "ingested" && lastAttempt.hasUserExclusions) {
      card.createEl("p", { text: "Ingest 已完成 · 含人工排除的知识变更", cls: "llm-wiki-muted" });
    }
    if (sourcePage) {
      const open = card.createEl("button", { text: "打开 Source" });
      open.onclick = () => void this.openVaultFileExact(sourcePage);
    }
    const rollbackAttempt = [...source.ingest.attempts].reverse()
      .find((attempt) => attempt.status === "ingested" && attempt.operationId);
    if (rollbackAttempt?.operationId) {
      const rollback = card.createEl("button", { text: "回滚 Ingest" });
      rollback.onclick = async () => {
        rollback.disabled = true;
        try {
          const preview = await this.plugin.workflows.previewIngestRollback(rollbackAttempt.operationId);
          new RollbackModal(this.plugin, preview, () => void this.render()).open();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : String(error));
        } finally {
          rollback.disabled = false;
        }
      };
    }
    const remove = card.createEl("button", { text: "删除来源" });
    remove.onclick = async () => {
      remove.disabled = true;
      try {
        const preview = await this.plugin.workflows.previewSourceDeletion(source.sourceId);
        new DeleteSourceModal(this.plugin, preview, () => void this.render()).open();
      } catch (error) {
        new Notice(error instanceof Error ? error.message : String(error));
      } finally {
        remove.disabled = false;
      }
    };
    const resumableMediaAttempt = [...source.parse.attempts].reverse().find((attempt) =>
      attempt.parserId === "media-transcription" && Boolean(attempt.resumeToken));
    if (source.parse.status === "parse_failed" && !resumableMediaAttempt) {
      const reparse = card.createEl("button", { text: "重新解析" });
      reparse.onclick = async () => {
        reparse.disabled = true;
        await this.plugin.wiki.reparseSource(source.sourceId);
        await this.render();
      };
      if (source.source.kind === "web" && source.source.uri) {
        const browser = card.createEl("button", { text: "改用浏览器 Web Clipper" });
        browser.onclick = async () => {
          await this.plugin.openUrlInBrowser(source.source.uri!);
          new Notice(this.plugin.settings.webClipper.enabled
            ? `请使用 Web Clipper 保存到 ${this.plugin.settings.webClipper.inboxPath}/`
            : "Web Clipper Inbox 尚未启用，请先在 T-Wiki 设置中启用");
        };
      }
    }
    if (mineruEnabled
      && source.source.kind === "pdf"
      && (source.parse.status === "needs_ocr" || source.parse.status === "parse_failed")) {
      const mineru = card.createEl("button", { text: "使用 MinerU 重新解析" });
      mineru.onclick = async () => {
        mineru.disabled = true;
        new Notice("原件将发送到已配置的 MinerU 服务");
        await this.plugin.wiki.reparseSourceWith(source.sourceId, "mineru-http");
        await this.render();
      };
    }
    if (mediaProvider?.enabled
      && (source.source.kind === "audio" || source.source.kind === "video")
      && parserId !== "bilibili-caption"
      && (source.parse.status === "queued" || source.parse.status === "parse_failed" || source.parse.status === "parsed")) {
      const transcribe = card.createEl("button", {
        text: resumableMediaAttempt
          ? "继续解析"
          : source.parse.status === "parse_failed"
          ? "重试远程转写"
          : source.parse.status === "parsed" ? "重新生成文字稿" : "开始远程转写",
        cls: "mod-cta"
      });
      transcribe.onclick = async () => {
        const options = mediaProvider.options;
        const preprocessing = options.preprocessing && typeof options.preprocessing === "object"
          ? options.preprocessing as Record<string, unknown>
          : {};
        const visual = options.visual && typeof options.visual === "object"
          ? options.visual as Record<string, unknown>
          : {};
        const vision = visual.vision && typeof visual.vision === "object"
          ? visual.vision as Record<string, unknown>
          : {};
        const visualLines = source.source.kind === "video" && visual.enabled === true
          ? [
            "",
            "关键画面已启用：",
            `本地 FFmpeg：${String(preprocessing.ffmpegPath || visual.ffmpegPath || "PATH 自动查找")}`,
            `视觉服务：${String(vision.baseUrl ?? "")}`,
            `视觉模型：${String(vision.model ?? "")}`,
            "将上传候选帧的 512px 缩略图与前后 30 秒文字，不上传完整视频。"
          ]
          : [];
        const titleModel = this.plugin.settings.agent.models.find((model) => model.role === "fast")
          ?? this.plugin.settings.agent.models[0];
        const summary = [
          `来源：${source.original.name}`,
          `大小：${formatBytes(source.original.size)}`,
          `协议：${String(options.protocol ?? "openai-transcriptions")}`,
          `服务：${String(options.baseUrl ?? "")}`,
          `模型：${String(options.model ?? "")}`,
          `媒体预处理：${preprocessing.enabled === false ? "关闭，可能上传完整原件" : "开启，上传 16 kHz 单声道音频分片"}`,
          ...(preprocessing.enabled === false ? [] : [
            `分片：${Math.round(Number(preprocessing.chunkDurationSeconds ?? 900) / 60)} 分钟，重叠 ${Number(preprocessing.overlapSeconds ?? 2)} 秒`,
            "中断后会保留已完成分片；继续前仍需再次确认远程上传。"
          ]),
          `标题生成：${titleModel?.id ?? "未配置 fast 模型"}`,
          "标题生成会把最多约 8,000 字的代表性文字稿发送给 Agent API。",
          ...visualLines,
          "",
          ...(source.parse.status === "parsed"
            ? ["这会创建新的 Parse Revision，旧 revision 仍保留在 Manifest 历史中。", ""]
            : []),
          "是否仅授权本次 ASR 转写及上方列出的视觉分析？"
        ].join("\n");
        if (!await confirmAction(this.app, "确认远程解析", summary, "确认并解析", true)) return;
        transcribe.disabled = true;
        try {
          this.plugin.mediaUploadConsent.approve(source.sourceId);
          if (resumableMediaAttempt) {
            await this.plugin.wiki.resumeSourceWith(source.sourceId, "media-transcription");
          } else {
            await this.plugin.wiki.reparseSourceWith(source.sourceId, "media-transcription");
          }
        } catch (error) {
          new Notice(error instanceof Error ? error.message : String(error));
        } finally {
          await this.render();
        }
      };
      if (resumableMediaAttempt) {
        const discard = card.createEl("button", { text: "放弃并清理断点" });
        discard.onclick = async () => {
          if (!await confirmAction(this.app, "清理媒体断点", "将删除已生成的音频分片和规范化转写缓存，但不会删除 ObjectStore 中的原始媒体。", "确认清理", true)) return;
          discard.disabled = true;
          try {
            await this.plugin.wiki.discardMediaResume(source.sourceId);
          } catch (error) {
            new Notice(error instanceof Error ? error.message : String(error));
          } finally {
            await this.render();
          }
        };
      }
    }
    if (mediaProvider?.enabled !== true
      && (source.source.kind === "audio" || source.source.kind === "video")
      && parserId !== "bilibili-caption"
      && source.parse.status === "queued") {
      card.createDiv({
        text: "等待转写：请在 T-Wiki 设置的“音视频解析”中开启“启用远程转写”并保存。",
        cls: "llm-wiki-warning"
      });
    }
    if (source.parse.status === "parsed"
      && (source.ingest.status === "not_started" || source.ingest.status === "ingest_failed")) {
      const ingest = card.createEl("button", {
        text: source.ingest.status === "ingest_failed" ? "重试 Ingest" : "开始 Ingest",
        cls: "mod-cta"
      });
      ingest.onclick = async () => {
        ingest.disabled = true;
        const budget = this.plugin.settings.agent.budgets.ingest;
        const now = new Date().toISOString();
        const preparing: IngestProgressSnapshot = {
          runId: `pending:${source.sourceId}`,
          sourceIds: [source.sourceId],
          state: "running",
          phase: "preparing",
          message: "正在准备 Wiki 吸收",
          iteration: 0,
          maxIterations: budget.maxIterations,
          toolCalls: 0,
          maxToolCalls: budget.maxToolCalls,
          elapsedMs: 0,
          startedAt: now,
          updatedAt: now,
          activities: []
        };
        this.ingestProgressSnapshots.set(source.sourceId, preparing);
        const progressElements = this.ingestProgressElements.get(source.sourceId);
        if (progressElements) this.updateIngestProgress(progressElements, preparing);
        else this.renderIngestProgress(pipelineDetails, source.sourceId, preparing);
        const ingestStep = card.querySelector<HTMLElement>('[data-step="ingest"]');
        if (ingestStep) {
          ingestStep.classList.remove("is-pending", "is-failed", "is-completed");
          ingestStep.classList.add("is-active");
          const marker = ingestStep.querySelector<HTMLElement>(".llm-wiki-pipeline-marker");
          if (marker) {
            marker.empty();
            marker.setAttr("aria-hidden", "true");
            setIcon(marker, "loader-circle");
          }
        }
        try {
          const plan = await this.plugin.workflows.ingest(source, () => undefined);
          await this.render();
          new ReviewModal(this.plugin, plan).open();
        } catch (error) {
          new Notice(`Ingest 失败：${error instanceof Error ? error.message : String(error)}`);
          await this.render();
        } finally {
          ingest.disabled = false;
        }
      };
    }
  }

  private async openVaultFileExact(path: string): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice(`文件不存在：${path}`);
      return;
    }
    await this.plugin.app.workspace.getLeaf(false).openFile(file);
  }

  private renderSourcePipeline(
    card: HTMLElement,
    source: SourceManifest,
    ingestProgress: IngestProgressSnapshot | undefined,
    parseError: string | undefined,
    ingestError: string | undefined,
    parseWarning: boolean
  ): HTMLElement {
    const container = card.createDiv({ cls: "llm-wiki-pipeline is-floating" });
    let hideTimer: number | undefined;
    const cancelHide = () => {
      if (hideTimer !== undefined) window.clearTimeout(hideTimer);
      hideTimer = undefined;
    };
    const show = () => {
      cancelHide();
      this.positionSourcePipeline(card, container);
      container.addClass("is-visible");
    };
    const scheduleHide = () => {
      cancelHide();
      hideTimer = window.setTimeout(() => {
        hideTimer = undefined;
        const active = document.activeElement;
        if (card.matches(":hover") || container.matches(":hover") || card.contains(active) || container.contains(active)) return;
        container.removeClass("is-visible");
      }, 80);
    };
    card.addEventListener("mouseenter", show);
    card.addEventListener("mouseleave", scheduleHide);
    card.addEventListener("focusin", show);
    card.addEventListener("focusout", scheduleHide);
    container.addEventListener("mouseenter", show);
    container.addEventListener("mouseleave", scheduleHide);
    container.addEventListener("focusin", show);
    container.addEventListener("focusout", scheduleHide);
    const steps = container.createDiv({ cls: "llm-wiki-pipeline-steps" });
    for (const step of sourcePipelineSteps(source, ingestProgress)) {
      const element = steps.createDiv({ cls: `llm-wiki-pipeline-step is-${step.state}` });
      element.setAttr("data-step", step.id);
      const marker = element.createSpan({ cls: "llm-wiki-pipeline-marker" });
      marker.setAttr("aria-hidden", "true");
      if (step.state !== "pending") {
        setIcon(marker, step.state === "completed" ? "check" : step.state === "failed" ? "x" : "loader-circle");
      }
      element.createSpan({ text: step.label, cls: "llm-wiki-pipeline-label" });
      element.createSpan({ text: pipelineStateLabel(step.state), cls: "llm-wiki-sr-only" });
    }
    const details = container.createDiv({ cls: "llm-wiki-pipeline-details" });
    if (parseError) details.createDiv({ text: `解析失败：${parseError}`, cls: "llm-wiki-pipeline-error" });
    else if (parseWarning) details.createDiv({ text: "解析已完成，但质量报告包含警告", cls: "llm-wiki-progress-detail" });
    if (ingestError && !ingestProgress) {
      details.createDiv({ text: `Ingest 失败：${ingestError}`, cls: "llm-wiki-pipeline-error" });
    }
    document.body.appendChild(container);
    this.floatingPipelines.add(container);
    this.pipelineAnchors.set(container, card);
    return details;
  }

  private positionSourcePipeline(card: HTMLElement, popup: HTMLElement): void {
    const cardRect = card.getBoundingClientRect();
    const popupWidth = popup.offsetWidth || 248;
    const popupHeight = Math.min(popup.scrollHeight || 180, window.innerHeight - 16);
    const gap = 10;
    const spaceLeft = cardRect.left - gap;
    const spaceRight = window.innerWidth - cardRect.right - gap;
    const opensRight = spaceLeft < popupWidth && spaceRight > spaceLeft;
    const idealLeft = opensRight ? cardRect.right + gap : cardRect.left - popupWidth - gap;
    const left = Math.max(8, Math.min(idealLeft, window.innerWidth - popupWidth - 8));
    const top = Math.max(8, Math.min(cardRect.top, window.innerHeight - popupHeight - 8));
    popup.style.left = `${Math.round(left)}px`;
    popup.style.top = `${Math.round(top)}px`;
    popup.toggleClass("opens-right", opensRight);
  }

  private removeFloatingPipelines(): void {
    for (const pipeline of this.floatingPipelines) pipeline.remove();
    this.floatingPipelines.clear();
  }

  private renderIngestProgress(
    parent: HTMLElement,
    sourceId: string,
    snapshot: IngestProgressSnapshot
  ): void {
    const container = parent.createDiv({ cls: "llm-wiki-ingest-progress" });
    const header = container.createDiv({ cls: "llm-wiki-progress-header" });
    const message = header.createSpan();
    const cancel = header.createEl("button", { text: "取消 Ingest", cls: "llm-wiki-cancel-ingest" });
    cancel.onclick = async () => {
      cancel.disabled = true;
      message.setText("正在取消 Ingest…");
      await this.plugin.workflows.cancel();
    };
    const track = container.createDiv({
      cls: "llm-wiki-progress-track",
      attr: { role: "progressbar", "aria-label": "Wiki 吸收进度" }
    });
    track.createDiv({ cls: "llm-wiki-progress-fill" });
    const detail = container.createDiv({ cls: "llm-wiki-progress-detail" });
    const activityDetails = container.createEl("details", { cls: "llm-wiki-ingest-activities" });
    activityDetails.createEl("summary", { text: "执行详情" });
    const activityList = activityDetails.createDiv({ cls: "llm-wiki-activity-list" });
    const elements = { container, track, message, detail, cancel, activityList };
    this.ingestProgressElements.set(sourceId, elements);
    this.updateIngestProgress(elements, snapshot);
  }

  private updateIngestProgress(elements: IngestProgressElements, snapshot: IngestProgressSnapshot): void {
    for (const state of ["running", "awaiting_review", "completed", "failed", "cancelled"] as const) {
      elements.container.toggleClass(`is-${state.replace("_", "-")}`, snapshot.state === state);
    }
    elements.message.setText(snapshot.message);
    elements.track.setAttr("aria-valuetext", snapshot.message);
    elements.cancel.toggleClass("is-hidden", snapshot.state !== "running");
    elements.cancel.disabled = snapshot.state !== "running";
    elements.detail.setText(
      `第 ${snapshot.iteration} / ${snapshot.maxIterations} 轮`
      + ` · ${snapshot.toolCalls} / ${snapshot.maxToolCalls} 次工具`
      + ` · ${Math.round(snapshot.elapsedMs / 1000)} 秒`
      + `${snapshot.context ? ` · 上下文 ${formatTokens(snapshot.context.liveContextTokens)}/${formatTokens(snapshot.context.maxContextTokens)}` : ""}`
      + `${snapshot.context ? ` · 累计输入 ${formatTokens(snapshot.context.cumulativeInputTokens)}` : ""}`
      + `${snapshot.context?.checkpointCount ? ` · ${snapshot.context.checkpointCount} 次压缩` : ""}`
      + `${snapshot.context?.cacheHits ? ` · ${snapshot.context.cacheHits} 次缓存命中` : ""}`
      + `${snapshot.sourceIds.length > 1 ? ` · 批量 ${snapshot.sourceIds.length} 个来源` : ""}`
    );
    elements.activityList.empty();
    if (snapshot.activities.length === 0) {
      elements.activityList.createDiv({ text: "正在等待第一个工具调用…", cls: "llm-wiki-muted" });
      return;
    }
    for (const activity of snapshot.activities) {
      const row = elements.activityList.createDiv({ cls: `llm-wiki-activity is-${activity.status}` });
      row.createSpan({
        text: activity.status === "completed" ? "✓" : activity.status === "failed" ? "!" : "●",
        cls: "llm-wiki-activity-marker"
      });
      const body = row.createDiv({ cls: "llm-wiki-activity-body" });
      body.createDiv({ text: activity.label, cls: "llm-wiki-activity-label" });
      if (activity.summary) body.createDiv({ text: activity.summary, cls: "llm-wiki-activity-summary" });
    }
    const popup = elements.container.closest<HTMLElement>(".llm-wiki-pipeline");
    const card = popup ? this.pipelineAnchors.get(popup) : undefined;
    if (popup && card) window.requestAnimationFrame(() => this.positionSourcePipeline(card, popup));
  }

  private refreshIngestElapsed(): void {
    for (const [sourceId, snapshot] of this.ingestProgressSnapshots) {
      if (snapshot.state !== "running") continue;
      const elements = this.ingestProgressElements.get(sourceId);
      if (!elements) continue;
      this.updateIngestProgress(elements, {
        ...snapshot,
        elapsedMs: Math.max(snapshot.elapsedMs, Date.now() - Date.parse(snapshot.startedAt))
      });
    }
  }

  private async ensureProgressSubscription(): Promise<void> {
    if (await this.plugin.wiki.requiresParsingMigration()) return;
    if (!this.progressUnsubscribe) {
      this.progressUnsubscribe = await this.plugin.wiki.subscribeParseProgress((event) => {
        this.progressSnapshots.set(event.sourceId, event);
        const elements = this.progressElements.get(event.sourceId);
        if (elements) this.updateParseProgress(elements, event);
        if (!elements || event.state !== "running") this.scheduleMaterialsRefresh();
        if (event.state !== "running") this.retainTerminalProgress(event);
      });
    }
    if (!this.ingestProgressUnsubscribe) {
      this.ingestProgressUnsubscribe = this.plugin.workflows.subscribeIngestProgress((snapshot) => {
        for (const sourceId of snapshot.sourceIds) {
          this.ingestProgressSnapshots.set(sourceId, snapshot);
          const elements = this.ingestProgressElements.get(sourceId);
          if (elements) this.updateIngestProgress(elements, snapshot);
          else this.scheduleMaterialsRefresh();
        }
        if (snapshot.state !== "running") this.scheduleMaterialsRefresh();
      });
    }
  }

  private retainTerminalProgress(event: ParseProgressEvent): void {
    const timer = window.setTimeout(() => {
      this.terminalProgressTimers.delete(timer);
      const current = this.progressSnapshots.get(event.sourceId);
      if (current?.attemptId !== event.attemptId || current.state === "running") return;
      this.progressSnapshots.delete(event.sourceId);
      this.scheduleMaterialsRefresh();
    }, 1200);
    this.terminalProgressTimers.add(timer);
  }

  private renderParseProgress(
    card: HTMLElement,
    sourceId: string,
    progress?: ParseProgress
  ): void {
    const container = card.createDiv({ cls: "llm-wiki-parse-progress" });
    const header = container.createDiv({ cls: "llm-wiki-progress-header" });
    const message = header.createSpan({ text: "正在准备解析" });
    const percent = header.createEl("strong", { text: "0%" });
    const track = container.createDiv({
      cls: "llm-wiki-progress-track",
      attr: {
        role: "progressbar",
        "aria-valuemin": "0",
        "aria-valuemax": "100",
        "aria-valuenow": "0"
      }
    });
    const fill = track.createDiv({ cls: "llm-wiki-progress-fill" });
    const detail = container.createDiv({ cls: "llm-wiki-progress-detail" });
    const elements = { container, track, fill, message, percent, detail };
    this.progressElements.set(sourceId, elements);
    this.updateParseProgress(elements, progress ?? {
      phase: "preparing",
      percent: 0,
      mode: "indeterminate",
      precision: "stage",
      message: "正在准备解析"
    });
  }

  private updateParseProgress(elements: ProgressElements, progress: ParseProgress): void {
    const value = Math.min(100, Math.max(0, Math.round(progress.percent ?? 0)));
    elements.message.setText(progress.message || progressPhaseLabel(progress.phase));
    elements.percent.setText(`${value}%`);
    elements.fill.style.width = `${value}%`;
    elements.track.setAttr("aria-valuenow", String(value));
    elements.container.toggleClass("is-indeterminate", progress.mode === "indeterminate");
    elements.container.toggleClass("is-complete", value === 100);
    elements.detail.setText(formatProgressDetail(progress));
  }

  private scheduleMaterialsRefresh(): void {
    if (this.plugin.settings.activeTab !== "materials" || this.progressRefreshScheduled) return;
    this.progressRefreshScheduled = true;
    window.setTimeout(() => {
      this.progressRefreshScheduled = false;
      void this.render();
    }, 50);
  }

  private async renderAgent(panel: HTMLElement): Promise<void> {
    const session = this.plugin.activeSession();
    const conversation = panel.createDiv({ cls: "llm-wiki-conversation" });
    const header = conversation.createDiv({ cls: "llm-wiki-conversation-header" });
    header.createEl("strong", { text: session.title });
    header.createSpan({ text: `${session.messages.length} 条消息`, cls: "llm-wiki-muted" });

    const chat = conversation.createDiv({ cls: "llm-wiki-chat llm-wiki-conversation-messages" });
    await this.renderConversationMessages(chat, session);
    this.renderSessionDock(conversation);
    const composer = conversation.createDiv({ cls: "llm-wiki-composer" });
    const textarea = composer.createEl("textarea", {
      cls: "llm-wiki-textarea llm-wiki-composer-input",
      attr: { placeholder: "输入消息或 /save、/lint 等指令。Enter 发送，Shift+Enter 换行。" }
    });
    const actions = composer.createDiv({ cls: "llm-wiki-actions llm-wiki-composer-actions" });
    actions.createSpan({ text: "自动携带本会话最近消息", cls: "llm-wiki-muted" });
    const send = actions.createEl("button", { text: "发送", cls: "mod-cta" });
    const submit = async () => {
      const content = textarea.value.trim();
      if (!content) return;
      textarea.value = "";
      chat.querySelector(".llm-wiki-empty-conversation")?.remove();
      session.messages.push({ role: "user", content, at: new Date().toISOString() });
      session.updatedAt = new Date().toISOString();
      if (session.messages.length === 1) session.title = content.slice(0, 30);
      const user = chat.createDiv({ cls: "llm-wiki-message user" });
      await MarkdownRenderer.render(this.app, content, user, "", this);
      const assistant = chat.createDiv({ cls: "llm-wiki-message assistant is-streaming" });
      const monitor = createRunMonitor(assistant, chat);
      const streaming = assistant.createDiv({ cls: "llm-wiki-streaming-content" });
      let output = "";
      send.disabled = true;
      textarea.disabled = true;
      scrollConversation(chat);
      try {
        const history = session.messages.slice(0, -1).map(({ role, content }) => ({ role, content }));
        const sink = (event: AgentEvent) => {
          if (event.type === "text") {
            streaming.appendText(event.text);
            scrollConversation(chat);
          }
          monitor.accept(event);
        };
        const requestDirection = async (discoveries: string, questions: string[]) =>
          await requestText(
            this.app,
            "需要你的处理方向",
            `${discoveries}\n\n${questions.map((question, index) => `${index + 1}. ${question}`).join("\n")}`,
            "",
            true
          ) || "按当前发现继续，保留不确定性并在变更说明中标注。";
        if (content.startsWith("/")) {
          const result = await this.plugin.workflows.executeCommandText(content, sink, history, requestDirection);
          output = result.text;
          if (result.plan) {
            const readOnly = this.plugin.workflows.pendingPlan?.operationId !== result.plan.operationId;
            new ReviewModal(this.plugin, result.plan, undefined, readOnly).open();
          }
          if (result.rollbackPreview) {
            new RollbackModal(this.plugin, result.rollbackPreview, () => void this.render()).open();
          }
          if (result.sourceDeletionPreview) {
            new DeleteSourceModal(this.plugin, result.sourceDeletionPreview, () => void this.render()).open();
          }
        } else {
          output = await this.plugin.workflows.chat(content, history, sink, requestDirection);
        }
        streaming.empty();
        await MarkdownRenderer.render(this.app, output, streaming, "", this);
        session.messages.push({ role: "assistant", content: output, at: new Date().toISOString() });
        session.updatedAt = new Date().toISOString();
        await this.plugin.saveSettings();
        monitor.complete();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        streaming.setText(message);
        streaming.addClass("llm-wiki-danger");
        monitor.fail(message);
      } finally {
        assistant.removeClass("is-streaming");
        send.disabled = false;
        textarea.disabled = false;
        textarea.focus();
        scrollConversation(chat);
      }
    };
    send.onclick = () => void submit();
    textarea.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      void submit();
    });
    window.requestAnimationFrame(() => scrollConversation(chat));
  }

  private async renderSmart(panel: HTMLElement): Promise<void> {
    const mode: SmartMode = this.plugin.settings.activeTab === "agent" ? "agent" : "query";
    const workspace = panel.createDiv({ cls: "llm-wiki-smart-workspace" });
    const toolbar = workspace.createDiv({ cls: "llm-wiki-card llm-wiki-smart-toolbar" });
    const heading = toolbar.createDiv({ cls: "llm-wiki-smart-heading" });
    heading.createEl("strong", { text: "智能工作区" });
    heading.createSpan({
      text: mode === "query"
        ? "从 Index 进入 Wiki，并沿知识链接查找答案"
        : "自由对话或执行 /save、/lint 等 Agent 指令",
      cls: "llm-wiki-muted"
    });

    const controls = toolbar.createDiv({ cls: "llm-wiki-smart-controls" });
    const modeSwitch = controls.createDiv({ cls: "llm-wiki-mode-switch", attr: { role: "tablist", "aria-label": "智能模式" } });
    this.smartModeButton(modeSwitch, "query", "知识查询", mode);
    this.smartModeButton(modeSwitch, "agent", "自由对话", mode);
    this.renderToolMenu(controls);

    const content = workspace.createDiv({ cls: "llm-wiki-smart-content" });
    if (mode === "query") await this.renderQuery(content);
    else await this.renderAgent(content);
  }

  private renderSessionDock(container: HTMLElement): void {
    const dock = container.createDiv({ cls: "llm-wiki-session-dock" });
    const recent = dock.createDiv({ cls: "llm-wiki-session-tabs", attr: { role: "tablist", "aria-label": "最近对话" } });
    for (const [index, session] of this.plugin.settings.sessions.slice(0, 4).entries()) {
      const title = session.title.trim() || `对话 ${index + 1}`;
      const button = recent.createEl("button", {
        cls: "llm-wiki-session-tab",
        attr: {
          role: "tab",
          title,
          "aria-selected": String(session.id === this.plugin.settings.activeSessionId)
        }
      });
      button.createSpan({ text: title.slice(0, 16), cls: "llm-wiki-session-tab-title" });
      button.createSpan({ text: String(index + 1), cls: "llm-wiki-session-tab-number" });
      button.toggleClass("is-active", session.id === this.plugin.settings.activeSessionId);
      button.onclick = async () => {
        if (session.id === this.plugin.settings.activeSessionId) return;
        this.plugin.switchSession(session.id);
        await this.plugin.saveSettings();
        await this.render();
      };
    }

    const actions = dock.createDiv({ cls: "llm-wiki-session-dock-actions" });
    this.iconAction(actions, "square-plus", "新建对话", async () => {
      this.plugin.newSession();
      await this.plugin.saveSettings();
      await this.render();
    });
    this.iconAction(actions, "pencil", "重命名当前对话", async () => {
      await this.renameCurrentSession();
    });
    this.iconAction(actions, "history", "打开对话历史", async () => {
      this.historyDrawerOpen = true;
      await this.render();
    });
    if (this.historyDrawerOpen) this.renderHistoryDrawer(container);
  }

  private renderHistoryDrawer(container: HTMLElement): void {
    const backdrop = container.createDiv({ cls: "llm-wiki-history-backdrop" });
    backdrop.onclick = async (event) => {
      if (event.target !== backdrop) return;
      this.historyDrawerOpen = false;
      await this.render();
    };
    const drawer = backdrop.createEl("aside", { cls: "llm-wiki-history-drawer", attr: { "aria-label": "全部对话历史" } });
    const header = drawer.createDiv({ cls: "llm-wiki-history-header" });
    const title = header.createDiv();
    title.createEl("strong", { text: "对话历史" });
    title.createSpan({ text: `${this.plugin.settings.sessions.length} 个会话`, cls: "llm-wiki-muted" });
    this.iconAction(header, "x", "关闭对话历史", async () => {
      this.historyDrawerOpen = false;
      await this.render();
    });
    const search = drawer.createEl("input", {
      type: "search",
      cls: "llm-wiki-history-search",
      attr: { placeholder: "搜索对话…", "aria-label": "搜索对话" }
    });
    const list = drawer.createDiv({ cls: "llm-wiki-history-list" });
    const grouped = new Map<string, { container: HTMLElement; items: HTMLElement[] }>();
    for (const session of this.plugin.settings.sessions) {
      const groupName = sessionDateGroup(session.updatedAt);
      let group = grouped.get(groupName);
      if (!group) {
        const groupContainer = list.createDiv({ cls: "llm-wiki-history-group" });
        groupContainer.createDiv({ text: groupName, cls: "llm-wiki-history-group-title" });
        group = { container: groupContainer, items: [] };
        grouped.set(groupName, group);
      }
      const item = group.container.createEl("button", {
        cls: "llm-wiki-history-item",
        attr: { "aria-current": String(session.id === this.plugin.settings.activeSessionId) }
      });
      item.dataset.searchText = `${session.title} ${session.messages.slice(-12).map((message) => message.content.slice(0, 80)).join(" ")}`.toLocaleLowerCase();
      item.toggleClass("is-active", session.id === this.plugin.settings.activeSessionId);
      item.createSpan({ text: session.title || "新会话", cls: "llm-wiki-history-item-title" });
      item.createSpan({
        text: `${session.messages.length} 条消息 · ${formatSessionTime(session.updatedAt)}`,
        cls: "llm-wiki-history-item-meta"
      });
      item.onclick = async () => {
        this.plugin.switchSession(session.id);
        this.historyDrawerOpen = false;
        await this.plugin.saveSettings();
        await this.render();
      };
      group.items.push(item);
    }
    search.oninput = () => {
      const query = search.value.trim().toLocaleLowerCase();
      for (const group of grouped.values()) {
        let visible = 0;
        for (const item of group.items) {
          const matches = !query || (item.dataset.searchText ?? "").includes(query);
          item.toggleClass("is-hidden", !matches);
          if (matches) visible += 1;
        }
        group.container.toggleClass("is-hidden", visible === 0);
      }
    };

    const footer = drawer.createDiv({ cls: "llm-wiki-history-footer" });
    const create = action(footer, "＋ 新建对话", async () => {
      this.plugin.newSession();
      this.historyDrawerOpen = false;
      await this.plugin.saveSettings();
      await this.render();
    });
    create.addClass("mod-cta");
    action(footer, "重命名", () => this.renameCurrentSession());
    action(footer, "清空", () => this.clearCurrentSession());
    const remove = action(footer, "删除", () => this.deleteCurrentSession());
    remove.addClass("llm-wiki-session-delete");
    window.requestAnimationFrame(() => search.focus());
  }

  private renderToolMenu(container: HTMLElement): void {
    const menu = container.createEl("details", { cls: "llm-wiki-tool-menu" });
    menu.createEl("summary", { text: "工具" });
    const items = menu.createDiv({ cls: "llm-wiki-tool-menu-items" });
    this.commandShortcut(items, "运行 Lint", "/lint");
    this.commandShortcut(items, "重建索引", "/reindex");
    this.commandShortcut(items, "运行状态", "/agent status");
    this.commandShortcut(items, "取消运行", "/agent cancel");
  }

  private iconAction(container: HTMLElement, icon: string, label: string, handler: () => void | Promise<void>): HTMLButtonElement {
    const button = container.createEl("button", { cls: "llm-wiki-icon-button", attr: { "aria-label": label, title: label } });
    setIcon(button, icon);
    button.onclick = () => void handler();
    return button;
  }

  private async renameCurrentSession(): Promise<void> {
    const current = this.plugin.activeSession();
    const title = await requestText(this.app, "重命名对话", "输入新的对话名称。", current.title);
    if (!title || title === current.title) return;
    this.plugin.renameSession(title, current.id);
    await this.plugin.saveSettings();
    await this.render();
  }

  private async clearCurrentSession(): Promise<void> {
    const current = this.plugin.activeSession();
    if (current.messages.length > 0 && !await confirmAction(
      this.app,
      "清空对话",
      `清空对话“${current.title}”？该操作无法撤销。`,
      "清空",
      true
    )) return;
    this.plugin.clearSession(current.id);
    await this.plugin.saveSettings();
    await this.render();
  }

  private async deleteCurrentSession(): Promise<void> {
    const current = this.plugin.activeSession();
    if (!await confirmAction(
      this.app,
      "删除对话",
      `删除对话“${current.title}”？该操作无法撤销。`,
      "删除",
      true
    )) return;
    this.plugin.deleteSession(current.id);
    await this.plugin.saveSettings();
    await this.render();
  }

  private smartModeButton(container: HTMLElement, target: SmartMode, label: string, current: SmartMode): void {
    const button = container.createEl("button", {
      text: label,
      cls: "llm-wiki-mode-button",
      attr: { role: "tab", "aria-selected": String(target === current) }
    });
    button.toggleClass("is-active", target === current);
    button.onclick = async () => {
      if (target === current) return;
      this.plugin.settings.activeTab = target;
      await this.plugin.saveSettings();
      await this.render();
    };
  }

  private commandShortcut(container: HTMLElement, label: string, command: string): void {
    const button = action(container, label, async () => {
      button.disabled = true;
      try {
        const result = await this.plugin.workflows.executeCommandText(command);
        new Notice(result.text);
        if (result.rollbackPreview) {
          new RollbackModal(this.plugin, result.rollbackPreview, () => void this.render()).open();
        }
        if (result.sourceDeletionPreview) {
          new DeleteSourceModal(this.plugin, result.sourceDeletionPreview, () => void this.render()).open();
        }
        if (command === "/reindex" || command === "/lint") await this.render();
      } catch (error) {
        new Notice(error instanceof Error ? error.message : String(error));
      } finally {
        button.disabled = false;
      }
    });
  }

  private renderReview(panel: HTMLElement): void {
    const plan = this.plugin.workflows.pendingPlan;
    if (!plan) {
      panel.createEl("p", { text: "没有待审阅的变更。", cls: "llm-wiki-muted" });
      return;
    }
    const card = panel.createDiv({ cls: "llm-wiki-card" });
    card.createEl("h3", { text: "待审阅计划" });
    card.createEl("p", { text: summarizePlan(plan) });
    const button = card.createEl("button", { text: "打开 Diff 审阅", cls: "mod-cta" });
    button.onclick = () => new ReviewModal(this.plugin, plan).open();
  }

  private async renderQuery(panel: HTMLElement): Promise<void> {
    const session = this.plugin.activeSession();
    const conversation = panel.createDiv({ cls: "llm-wiki-conversation" });
    const header = conversation.createDiv({ cls: "llm-wiki-conversation-header" });
    header.createEl("strong", { text: session.title });
    header.createSpan({ text: "支持根据上一轮答案继续追问", cls: "llm-wiki-muted" });
    const chat = conversation.createDiv({ cls: "llm-wiki-chat llm-wiki-conversation-messages" });
    await this.renderConversationMessages(chat, session);
    this.renderSessionDock(conversation);

    const composer = conversation.createDiv({ cls: "llm-wiki-composer" });
    const textarea = composer.createEl("textarea", {
      cls: "llm-wiki-textarea llm-wiki-composer-input",
      attr: { placeholder: "询问 Wiki。Enter 发送，Shift+Enter 换行。" }
    });
    const options = composer.createDiv({ cls: "llm-wiki-actions llm-wiki-query-options" });
    const scope = options.createEl("select", { attr: { "aria-label": "查询范围" } });
    for (const [value, label] of [["wiki", "Wiki"], ["hybrid", "Hybrid"], ["raw", "Raw"]] as const) {
      scope.createEl("option", { value, text: label });
    }
    const depth = options.createEl("select", { attr: { "aria-label": "查询深度" } });
    depth.createEl("option", { value: "standard", text: "Standard" });
    depth.createEl("option", { value: "deep", text: "Deep" });
    const confidenceLabel = options.createEl("label");
    const confidence = confidenceLabel.createEl("input", { type: "checkbox" });
    confidenceLabel.appendText(" 显示置信度");
    const ask = options.createEl("button", { text: "发送", cls: "mod-cta" });
    const submit = async () => {
      const question = textarea.value.trim();
      if (!question) return;
      textarea.value = "";
      ask.disabled = true;
      textarea.disabled = true;
      chat.querySelector(".llm-wiki-empty-conversation")?.remove();
      const history = session.messages.map(({ role, content }) => ({ role, content }));
      session.messages.push({ role: "user", content: question, at: new Date().toISOString() });
      session.updatedAt = new Date().toISOString();
      if (session.messages.length === 1) session.title = question.slice(0, 30);
      const user = chat.createDiv({ cls: "llm-wiki-message user" });
      await MarkdownRenderer.render(this.app, question, user, "", this);
      const assistant = chat.createDiv({ cls: "llm-wiki-message assistant is-streaming" });
      const monitor = createRunMonitor(assistant, chat);
      const streaming = assistant.createDiv({ cls: "llm-wiki-streaming-content" });
      scrollConversation(chat);
      try {
        const response = await this.plugin.workflows.query(question, (event) => {
          if (event.type === "text") {
            streaming.appendText(event.text);
            scrollConversation(chat);
          }
          monitor.accept(event);
        }, {
          scope: scope.value as "wiki" | "raw" | "hybrid",
          deep: depth.value === "deep",
          confidence: confidence.checked,
          history
        });
        streaming.empty();
        await MarkdownRenderer.render(this.app, response.answer, streaming, "", this);
        session.messages.push({ role: "assistant", content: response.answer, at: new Date().toISOString() });
        session.updatedAt = new Date().toISOString();
        await this.plugin.saveSettings();
        monitor.complete();
        const resultActions = assistant.createDiv({ cls: "llm-wiki-actions" });
        action(resultActions, "保存为 Output", () => this.startSave(response.answer, "output", assistant));
        action(resultActions, "保存为 Synthesis", () => this.startSave(response.answer, "synthesis", assistant));
        const exploration = assistant.createEl("details", { cls: "llm-wiki-ingest-activities" });
        exploration.createEl("summary", { text: "查询探索轨迹" });
        exploration.createEl("p", {
          text: `Index ${response.exploration.indexRevision?.slice(0, 12) ?? "unknown"} · `
            + `${response.exploration.wikiReads.length} 次正文读取 · `
            + `${response.exploration.graphTraversals.length} 条图路径 · `
            + `${response.exploration.rawReads} 次 Raw 回溯 · `
            + `引用 ${response.exploration.citationStatus}`,
          cls: "llm-wiki-muted"
        });
        if (response.exploration.wikiReads.length > 0) {
          const list = exploration.createEl("ul");
          for (const read of response.exploration.wikiReads) {
            list.createEl("li", { text: `${read.path}${read.sectionId ? `#${read.sectionId}` : ""} (${read.mode})` });
          }
        }
        if (response.exploration.indexReads.length > 0) {
          exploration.createEl("p", {
            text: `子 Index：${response.exploration.indexReads.join("、")}`,
            cls: "llm-wiki-muted"
          });
        }
        if (response.exploration.graphTraversals.length > 0) {
          const paths = exploration.createEl("ul");
          for (const edge of response.exploration.graphTraversals) {
            paths.createEl("li", {
              text: `${edge.from} → ${edge.to}（${edge.hop} 跳，${edge.direction}）`
            });
          }
        }
        if (response.exploration.citationErrors.length > 0) {
          exploration.createEl("p", {
            text: response.exploration.citationErrors.join("；"),
            cls: "llm-wiki-danger"
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        streaming.setText(message);
        streaming.addClass("llm-wiki-danger");
        monitor.fail(message);
      } finally {
        assistant.removeClass("is-streaming");
        ask.disabled = false;
        textarea.disabled = false;
        textarea.focus();
        scrollConversation(chat);
      }
    };
    ask.onclick = () => void submit();
    textarea.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      void submit();
    });
    window.requestAnimationFrame(() => scrollConversation(chat));
  }

  private async renderConversationMessages(chat: HTMLElement, session: ChatSession): Promise<void> {
    if (session.messages.length === 0) {
      const empty = chat.createDiv({ cls: "llm-wiki-empty-conversation" });
      empty.createEl("strong", { text: "开始一段对话" });
      empty.createEl("p", {
        text: "你可以查询 Wiki、继续追问，或切换到自由对话执行指令。",
        cls: "llm-wiki-muted"
      });
      return;
    }
    for (const message of session.messages) {
      const el = chat.createDiv({ cls: `llm-wiki-message ${message.role}` });
      await MarkdownRenderer.render(this.app, message.content, el, "", this);
    }
  }

  private async startSave(content: string, type: "output" | "synthesis", container: HTMLElement): Promise<void> {
    const status = container.createEl("p", { text: "正在生成保存计划…", cls: "llm-wiki-muted" });
    try {
      const plan = await this.plugin.workflows.save(content, type, eventSink(status));
      new ReviewModal(this.plugin, plan).open();
    } catch (error) {
      new Notice(`生成保存计划失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function formatMediaDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return "";
  const totalSeconds = Math.round(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds % 3600 / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

interface RunMonitor {
  accept(event: AgentEvent): void;
  complete(): void;
  fail(message: string): void;
}

function createRunMonitor(container: HTMLElement, scrollTarget: HTMLElement): RunMonitor {
  const details = container.createEl("details", { cls: "llm-wiki-run-monitor" });
  details.open = true;
  const summary = details.createEl("summary", { text: "正在思考与规划…" });
  const metrics = details.createDiv({ cls: "llm-wiki-run-metrics" });
  const activities = details.createEl("ul", { cls: "llm-wiki-run-activities" });
  const toolRows = new Map<string, HTMLElement>();

  const addActivity = (text: string, className?: string): HTMLElement => {
    const row = activities.createEl("li", { text });
    if (className) row.addClass(className);
    while (activities.children.length > 60) activities.firstElementChild?.remove();
    scrollConversation(scrollTarget);
    return row;
  };

  return {
    accept(event) {
      if (event.type === "text") return;
      if (event.type === "status") summary.setText(event.message);
      if (event.type === "iteration") summary.setText(`正在思考 · 第 ${event.iteration}/${event.maxIterations} 轮`);
      if (event.type === "budget") {
        const context = event.context
          ? ` · 上下文 ${formatTokens(event.context.liveContextTokens)}/${formatTokens(event.context.maxContextTokens)}`
          : "";
        metrics.setText(`${event.iterations} 轮 · ${event.toolCalls} 次工具 · ${Math.round(event.elapsedMs / 1000)} 秒${context}`);
      }
      if (event.type === "tool_started") {
        summary.setText(`正在执行 ${event.name}`);
        toolRows.set(event.toolCallId, addActivity(`进行中 · ${event.name}`, "is-running"));
      }
      if (event.type === "tool_completed") {
        const row = toolRows.get(event.toolCallId) ?? addActivity(event.name);
        row.setText(`${event.isError ? "失败" : "完成"} · ${event.name}${event.summary ? ` · ${event.summary}` : ""}`);
        row.removeClass("is-running");
        row.addClass(event.isError ? "is-error" : "is-complete");
      }
      if (event.type === "waiting_user") summary.setText("正在等待用户确认方向");
      if (event.type === "plan_ready") addActivity(`变更计划已就绪 · ${event.changedPaths.length} 个页面`, "is-complete");
      if (event.type === "result") {
        const usage = event.usage?.totalTokens ? ` · ${formatTokens(event.usage.totalTokens)} tokens` : "";
        addActivity(`${event.provider} · ${event.model}${usage}`, "is-complete");
      }
      if (event.type === "error") {
        summary.setText(event.error);
        summary.addClass("llm-wiki-danger");
      }
    },
    complete() {
      summary.setText("执行完成 · 查看过程");
      details.removeClass("is-running");
      details.addClass("is-complete");
      details.open = false;
    },
    fail(message) {
      summary.setText(`执行失败 · ${message}`);
      summary.addClass("llm-wiki-danger");
      details.removeClass("is-running");
      details.open = true;
    }
  };
}

function scrollConversation(container: HTMLElement): void {
  window.requestAnimationFrame(() => {
    container.scrollTop = container.scrollHeight;
  });
}

function sessionDateGroup(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "更早";
  const today = new Date();
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startToday - startDate) / 86_400_000);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  if (days < 7) return "最近 7 天";
  return "更早";
}

function formatSessionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知时间";
  return date.toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.max(0, Math.round(value)));
}

interface ProgressElements {
  container: HTMLElement;
  track: HTMLElement;
  fill: HTMLElement;
  message: HTMLElement;
  percent: HTMLElement;
  detail: HTMLElement;
}

interface IngestProgressElements {
  container: HTMLElement;
  track: HTMLElement;
  message: HTMLElement;
  detail: HTMLElement;
  cancel: HTMLButtonElement;
  activityList: HTMLElement;
}

function isIngestProgressRelevant(source: SourceManifest, snapshot: IngestProgressSnapshot): boolean {
  if (snapshot.state === "running") return true;
  if (snapshot.state === "awaiting_review") return source.ingest.status === "awaiting_review";
  if (snapshot.state === "completed") return source.ingest.status === "ingested";
  return source.ingest.status === "ingest_failed";
}

function pipelineStateLabel(state: "completed" | "active" | "pending" | "failed"): string {
  switch (state) {
    case "completed": return "已完成";
    case "active": return "进行中";
    case "failed": return "失败";
    case "pending": return "等待中";
  }
}

function progressPhaseLabel(phase: string): string {
  switch (phase) {
    case "preparing": return "正在准备原件";
    case "probing": return "正在选择解析器";
    case "uploading": return "正在上传文档";
    case "preparing-media": return "正在准备媒体";
    case "reading-media-info": return "正在读取媒体信息";
    case "extracting-audio": return "正在提取音频";
    case "uploading-chunk": return "正在上传音频分片";
    case "transcribing-chunk": return "正在转写音频分片";
    case "merging-transcript": return "正在合并时间轴";
    case "extracting-frames": return "正在提取关键帧";
    case "filtering-frames": return "正在筛选关键帧";
    case "visual-analysis": return "正在分析关键画面";
    case "building-markdown": return "正在生成 Markdown";
    case "quality-check": return "正在执行完整性校验";
    case "parsing": return "正在解析文档";
    case "downloading": return "正在下载解析结果";
    case "normalizing": return "正在标准化 Markdown";
    case "quality_check": return "正在执行质量检查";
    case "publishing": return "正在发布 raw Markdown";
    case "completed": return "解析完成";
    default: return "正在解析文档";
  }
}

function formatProgressDetail(progress: ParseProgress): string {
  if (progress.completed !== undefined && progress.total !== undefined) {
    if (progress.unit === "page") return `已解析 ${progress.completed} / ${progress.total} 页`;
    if (progress.unit === "byte") {
      return `已处理 ${formatBytes(progress.completed)} / ${formatBytes(progress.total)}`;
    }
    if (progress.unit === "document") return "正在处理文档";
    if (progress.unit === "second") return `已处理 ${progress.completed} / ${progress.total} 秒`;
    return `已完成 ${progress.completed} / ${progress.total}`;
  }
  return progress.precision === "stage" ? "阶段进度 · 服务暂未返回页级进度" : "正在计算进度";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function parserDisplayName(parserId: string): string {
  switch (parserId) {
    case "mineru-http": return "MinerU";
    case "pdfjs-layout": return "PDF.js";
    case "markdown-pass-through": return "Markdown";
    case "plain-text": return "TXT";
    case "webpage-defuddle": return "网页";
    case "bilibili-caption": return "Bilibili 字幕";
    case "media-transcription": return "音视频转写";
    default: return "扩展解析器";
  }
}

function parserBadgeClass(parserId: string): string {
  return `is-${parserId.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLocaleLowerCase()}`;
}

function stat(container: HTMLElement, label: string, value: number): void {
  const el = container.createDiv({ cls: "llm-wiki-stat" });
  el.createEl("strong", { text: String(value) });
  el.createSpan({ text: label });
}

function action(container: HTMLElement, label: string, handler: () => void | Promise<void>): HTMLButtonElement {
  const button = container.createEl("button", { text: label });
  button.onclick = () => void handler();
  return button;
}

function eventSink(status: HTMLElement): (event: AgentEvent) => void {
  return (event) => updateAgentStatus(status, event);
}

function updateAgentStatus(status: HTMLElement, event: AgentEvent): void {
  if (event.type === "status") status.setText(event.message);
  if (event.type === "iteration") status.setText(`Agent 第 ${event.iteration} / ${event.maxIterations} 轮`);
  if (event.type === "budget") status.setText(`Agent：${event.iterations} 轮 · ${event.toolCalls} 次工具 · ${Math.round(event.elapsedMs / 1000)} 秒`);
  if (event.type === "tool_started") status.setText(`正在执行 ${event.name}`);
  if (event.type === "tool_completed") {
    status.setText(`${event.name}：${event.isError ? "失败" : "完成"}${event.summary ? ` · ${event.summary}` : ""}`);
  }
  if (event.type === "waiting_user") status.setText("Agent 正在等待用户确认方向");
  if (event.type === "plan_ready") status.setText(`变更计划已就绪：${event.changedPaths.length} 个页面`);
  if (event.type === "error") {
    status.setText(event.error);
    status.addClass("llm-wiki-danger");
  }
}
