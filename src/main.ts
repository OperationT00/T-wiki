import { join } from "node:path";
import { Notice, Plugin, TFile, type DataAdapter, type WorkspaceLeaf } from "obsidian";

import {
  normalizePluginSettings,
  type StoredPluginSettings
} from "./agent/agent-settings";
import { EmbeddedAgentRuntimeFactory } from "./agent/runtime-factory";
import { AgentTranscriptTitleGenerator } from "./agent/transcript-title-generator";
import { AgentTranscriptFormatter } from "./agent/transcript-formatter";
import {
  FilePickerConnector,
  UrlCaptureConnector,
  WebClipperInboxConnector,
  type ConnectorScanResult,
  type UrlCaptureResult
} from "./connectors/source-connector";
import { BilibiliVideoConnector } from "./connectors/bilibili-video-connector";
import {
  DouyinVideoConnector,
  type DouyinCapturePhase,
  type DouyinCaptureResult
} from "./connectors/douyin-video-connector";
import type { YtDlpDownloadProgress, YtDlpInfo } from "./connectors/yt-dlp";
import { UrlCaptureRouter } from "./connectors/url-capture-router";
import { SafeWebPageFetcher, validateWebUrl } from "./connectors/web-page-fetcher";
import { createDefaultParserRegistry } from "./parsing/default-parser-registry";
import type { MinerUProtocol } from "./parsing/parsers/mineru-parser";
import { InMemoryMediaUploadConsent } from "./parsing/parsers/media-transcription-parser";
import type { TranscriptionProtocol } from "./parsing/media/transcript-types";
import { ObsidianHttpClient } from "./services/obsidian-http-client";
import { SecretStore } from "./services/secret-store";
import { FileSystemMediaJobStore } from "./services/media-job-store";
import { WikiService, type MigrationPreview } from "./services/wiki-service";
import { WorkflowService } from "./services/workflow-service";
import type { ChatSession, PluginSettings } from "./types";
import {
  DeleteSourceModal,
  EditableDiffModal,
  InitializeModal,
  ReviewModal,
  RollbackModal,
  UrlCaptureModal,
  chooseRevisionMode,
  requestText
} from "./ui/modals";
import { LLMWikiSettingTab } from "./ui/settings-tab";
import { VIEW_TYPE_LLM_WIKI, WorkbenchView } from "./ui/workbench-view";

export const MINERU_CLOUD_SECRET_ID = "t-wiki-mineru-cloud-token";
export const MINERU_SELF_HOSTED_SECRET_ID = "t-wiki-mineru-self-hosted-token";
export const MEDIA_OPENAI_SECRET_ID = "t-wiki-media-openai-token";
export const MEDIA_WHISPER_SECRET_ID = "t-wiki-media-whisper-token";
export const VIDEO_VISION_SECRET_ID = "t-wiki-video-vision-token";

export default class LLMWikiPlugin extends Plugin {
  declare settings: PluginSettings;
  wiki!: WikiService;
  secrets!: SecretStore;
  workflows!: WorkflowService;
  private readonly filePicker = new FilePickerConnector();
  private readonly webUrlCapture = new UrlCaptureConnector(new SafeWebPageFetcher());
  private readonly bilibiliCapture = new BilibiliVideoConnector();
  private readonly douyinCapture = new DouyinVideoConnector();
  private readonly urlCapture = new UrlCaptureRouter(this.webUrlCapture, this.bilibiliCapture, this.douyinCapture);
  readonly mediaUploadConsent = new InMemoryMediaUploadConsent();
  private webClipper?: WebClipperInboxConnector;

  async onload(): Promise<void> {
    let stage = "读取插件设置";
    try {
      await this.initializePlugin((nextStage) => { stage = nextStage; });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[T-Wiki] 插件加载失败（${stage}）`, error);
      new Notice(`T-Wiki 加载失败（${stage}）：${detail}`, 0);
      throw error;
    }
  }

  private async initializePlugin(setStage: (stage: string) => void): Promise<void> {
    await this.loadSettings();
    setStage("初始化服务");
    this.secrets = new SecretStore(this.app);
    const http = new ObsidianHttpClient();
    const runtimeFactory = new EmbeddedAgentRuntimeFactory(this.secrets, () => this.settings);
    const transcriptTitleGenerator = new AgentTranscriptTitleGenerator(runtimeFactory, () => this.settings);
    const transcriptFormatter = new AgentTranscriptFormatter(runtimeFactory, () => this.settings);
    this.wiki = new WikiService(this.app, (config) => createDefaultParserRegistry({
      mineru: {
        http,
        credentials: {
          getToken: (protocol: MinerUProtocol) => this.secrets.get(
            protocol === "cloud-v4" ? MINERU_CLOUD_SECRET_ID : MINERU_SELF_HOSTED_SECRET_ID
          )
        }
      },
      media: {
        consent: this.mediaUploadConsent,
        credentials: {
          getToken: (protocol: TranscriptionProtocol) => this.secrets.get(
            protocol === "openai-transcriptions" ? MEDIA_OPENAI_SECRET_ID : MEDIA_WHISPER_SECRET_ID
          )
        },
        visionCredentials: {
          getToken: () => this.secrets.get(VIDEO_VISION_SECRET_ID)
        },
        titleGenerator: transcriptTitleGenerator,
        formatter: transcriptFormatter,
        jobs: createMediaJobStore(this.app.vault.adapter, config?.paths.internal ?? ".llm-wiki")
      }
    }));
    this.workflows = new WorkflowService(this.wiki, runtimeFactory, () => this.settings);
    setStage("监听 Vault 变更");
    this.registerEvent(this.app.vault.on("create", (file) => {
      if (file.path.endsWith(".md")) this.wiki.markNavigationIndexDirty(file.path);
    }));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file.path.endsWith(".md")) this.wiki.markNavigationIndexDirty(file.path);
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (file.path.endsWith(".md")) this.wiki.markNavigationIndexDirty(file.path);
      if (file.path.endsWith(".md")) {
        void this.wiki.handleEditableDocumentDelete(file.path)
          .catch((error) => new Notice(`笔记状态同步失败：${error instanceof Error ? error.message : String(error)}`));
      }
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (file.path.endsWith(".md")) this.wiki.markNavigationIndexDirty(file.path);
      if (oldPath.endsWith(".md")) this.wiki.markNavigationIndexDirty(oldPath);
      if (file.path.endsWith(".md") || oldPath.endsWith(".md")) {
        void this.wiki.handleEditableDocumentRename(oldPath, file.path)
          .catch((error) => new Notice(`笔记状态同步失败：${error instanceof Error ? error.message : String(error)}`));
      }
    }));
    setStage("启动来源连接器");
    await this.filePicker.start(this.connectorContext());
    await this.webUrlCapture.start(this.connectorContext());
    await this.bilibiliCapture.start(this.connectorContext());
    await this.douyinCapture.start(this.connectorContext());

    setStage("注册界面和命令");
    this.addRibbonIcon("library-big", "打开 T-Wiki", () => void this.openWorkbench());
    this.addSettingTab(new LLMWikiSettingTab(this));
    this.registerCommands();
    // Register the view last. If an earlier UI registration fails, a retry will
    // not inherit a partially registered view type from the failed attempt.
    this.registerView(VIEW_TYPE_LLM_WIKI, (leaf: WorkspaceLeaf) => new WorkbenchView(leaf, this));

    this.app.workspace.onLayoutReady(() => void this.completeLayoutStartup());
  }

  private async completeLayoutStartup(): Promise<void> {
    try {
      if (await this.wiki.isInitialized()) {
        const recovered = await this.wiki.recoverTransactions();
        if (recovered > 0) new Notice(`T-Wiki 已恢复 ${recovered} 个未完成事务`);
        try {
          if (await this.workflows.restorePendingPlan()) new Notice("T-Wiki 已恢复待审核变更计划");
        } catch (error) {
          new Notice(`待审核计划无法安全恢复：${error instanceof Error ? error.message : String(error)}`);
        }
        const recovery = await this.wiki.inspectRecovery().catch(() => null);
        if (recovery?.counts.blocked) {
          new Notice(`T-Wiki 恢复中心有 ${recovery.counts.blocked} 个项目需要处理`);
        }
        await this.restartWebClipperConnector();
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error("[T-Wiki] 工作区恢复失败", error);
      new Notice(`T-Wiki 已加载，但启动恢复未完成：${detail}`, 0);
    }
  }

  onunload(): void {
    this.wiki?.dispose();
    void this.workflows?.dispose();
    void this.filePicker.stop();
    void this.webUrlCapture.stop();
    void this.bilibiliCapture.stop();
    void this.douyinCapture.stop();
    this.mediaUploadConsent.clear();
    void this.webClipper?.stop();
  }

  async importFiles(files: File[]): Promise<import("./types").SourceManifest[]> {
    return this.filePicker.importFiles(files);
  }

  async captureUrl(
    url: string,
    signal?: AbortSignal,
    reportProgress?: (phase: "download" | "parse" | "complete") => void,
    bilibili?: { pages?: "current" | "all" | number[]; language?: string },
    mode: "web" | "video" = bilibili ? "video" : "web"
  ): Promise<UrlCaptureResult> {
    if (!(await this.wiki.isInitialized())) throw new Error("请先初始化 T-Wiki");
    if (await this.wiki.requiresParsingMigration()) throw new Error("请先迁移解析配置");
    return this.urlCapture.capture({
      url,
      mode,
      signal,
      reportProgress,
      bilibiliPages: bilibili?.pages,
      bilibiliLanguage: bilibili?.language
    });
  }

  async testDouyinYtDlp(signal = new AbortController().signal): Promise<YtDlpInfo> {
    const settings = this.settings.onlineVideo.douyin;
    return this.douyinCapture.testInstallation(settings, signal);
  }

  async captureDouyinWithTranscription(
    url: string,
    useBrowserCookies: boolean,
    signal?: AbortSignal,
    reportProgress?: (phase: DouyinCapturePhase, progress?: YtDlpDownloadProgress) => void
  ): Promise<DouyinCaptureResult> {
    if (!(await this.wiki.isInitialized())) throw new Error("请先初始化 T-Wiki");
    if (await this.wiki.requiresParsingMigration()) throw new Error("请先迁移解析配置");
    const config = await this.wiki.loadConfig();
    const provider = config.parsing.providers["media-transcription"];
    if (!provider?.enabled) throw new Error("请先在设置中启用音视频远程转写");
    const visual = provider.options.visual && typeof provider.options.visual === "object"
      ? provider.options.visual as Record<string, unknown>
      : {};
    const captured = await this.urlCapture.captureDouyin({
      url,
      signal,
      reportProgress,
      options: {
        ...this.settings.onlineVideo.douyin,
        useBrowserCookies,
        ffmpegPath: String(visual.ffmpegPath ?? "")
      }
    });
    this.mediaUploadConsent.approve(captured.manifest.sourceId);
    const unsubscribeProgress = await this.wiki.subscribeParseProgress((event) => {
      if (event.sourceId !== captured.manifest.sourceId) return;
      const phase = DOUYIN_PARSE_PHASES[event.phase];
      if (phase) reportProgress?.(phase);
    });
    const abortParse = (): void => { void this.wiki.cancelParse(captured.manifest.sourceId); };
    signal?.addEventListener("abort", abortParse, { once: true });
    try {
      if (signal?.aborted) throw new Error("抖音视频处理已取消");
      const manifest = await this.wiki.reparseSourceWith(captured.manifest.sourceId, "media-transcription");
      reportProgress?.("complete");
      return { ...captured, manifest };
    } catch (error) {
      this.mediaUploadConsent.revoke(captured.manifest.sourceId);
      throw error;
    } finally {
      unsubscribeProgress();
      signal?.removeEventListener("abort", abortParse);
    }
  }

  async captureBilibiliWithTranscription(
    url: string,
    signal?: AbortSignal,
    reportProgress?: (downloaded: number, total?: number) => void
  ): Promise<import("./types").SourceManifest> {
    const config = await this.wiki.loadConfig();
    const provider = config.parsing.providers["media-transcription"];
    if (!provider?.enabled) throw new Error("请先在设置中启用音视频远程转写");
    const manifest = await this.bilibiliCapture.captureAudioForTranscription(
      url,
      signal ?? new AbortController().signal,
      reportProgress
    );
    this.mediaUploadConsent.approve(manifest.sourceId);
    return this.wiki.reparseSourceWith(manifest.sourceId, "media-transcription");
  }

  async openUrlInBrowser(input: string): Promise<void> {
    const url = validateWebUrl(input);
    const electron = await import("electron");
    await electron.shell.openExternal(url.toString());
  }

  async restartWebClipperConnector(): Promise<void> {
    await this.webClipper?.stop();
    this.webClipper = undefined;
    if (!this.settings.webClipper.enabled
      || !(await this.wiki.isInitialized())
      || await this.wiki.requiresParsingMigration()) return;
    this.webClipper = new WebClipperInboxConnector(this.app.vault, this.settings.webClipper);
    await this.webClipper.start(this.connectorContext());
  }

  async scanWebClipper(): Promise<ConnectorScanResult> {
    if (this.webClipper) return this.webClipper.scan();
    if (!(await this.wiki.isInitialized())) throw new Error("请先初始化 T-Wiki");
    const connector = new WebClipperInboxConnector(this.app.vault, {
      ...this.settings.webClipper,
      scanExistingOnStartup: false
    });
    await connector.start(this.connectorContext());
    try {
      return await connector.scan();
    } finally {
      await connector.stop();
    }
  }

  async openWorkbench(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_LLM_WIKI)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE_LLM_WIKI, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
  }

  async openVaultPath(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`文件不存在：${path}`);
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  async refreshView(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_LLM_WIKI)) {
      const view = leaf.view;
      if (view instanceof WorkbenchView) await view.render();
    }
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as StoredPluginSettings | null;
    this.settings = normalizePluginSettings(data);
    if (data && (data.schemaVersion !== 6 || !data.agent)) await this.saveData(this.settings);
    if (!this.settings.activeSessionId || !this.settings.sessions.some((item) => item.id === this.settings.activeSessionId)) {
      const session = createSession();
      this.settings.sessions.unshift(session);
      this.settings.activeSessionId = session.id;
    }
  }

  private connectorContext(): import("./connectors/source-connector").SourceConnectorContext {
    return {
      importSource: (name, bytes, provenance) => this.wiki.importSourceDetailed(name, bytes, provenance),
      importSourceBody: (name, source, provenance) => this.wiki.importSourceDetailed(name, source, provenance),
      reportError: (connectorId, path, error) => {
        new Notice(`${connectorId} 导入失败：${path} · ${error instanceof Error ? error.message : String(error)}`);
      }
    };
  }

  async saveSettings(): Promise<void> {
    this.settings.sessions = this.settings.sessions
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 20);
    await this.saveData(this.settings);
  }

  activeSession(): ChatSession {
    let session = this.settings.sessions.find((item) => item.id === this.settings.activeSessionId);
    if (!session) {
      session = createSession();
      this.settings.sessions.unshift(session);
      this.settings.activeSessionId = session.id;
    }
    return session;
  }

  newSession(): ChatSession {
    const session = createSession();
    this.settings.sessions.unshift(session);
    this.settings.activeSessionId = session.id;
    return session;
  }

  switchSession(sessionId: string): ChatSession {
    const session = this.settings.sessions.find((item) => item.id === sessionId);
    if (!session) throw new Error("会话不存在或已被删除");
    this.settings.activeSessionId = session.id;
    return session;
  }

  clearSession(sessionId = this.settings.activeSessionId): ChatSession {
    const session = this.settings.sessions.find((item) => item.id === sessionId);
    if (!session) throw new Error("会话不存在或已被删除");
    session.title = "新会话";
    session.messages = [];
    session.updatedAt = new Date().toISOString();
    delete session.runtimeSessionId;
    return session;
  }

  renameSession(title: string, sessionId = this.settings.activeSessionId): ChatSession {
    const session = this.settings.sessions.find((item) => item.id === sessionId);
    if (!session) throw new Error("会话不存在或已被删除");
    const normalized = title.trim().replace(/\s+/g, " ").slice(0, 80);
    if (!normalized) throw new Error("会话标题不能为空");
    session.title = normalized;
    session.updatedAt = new Date().toISOString();
    return session;
  }

  deleteSession(sessionId = this.settings.activeSessionId): ChatSession {
    const index = this.settings.sessions.findIndex((item) => item.id === sessionId);
    if (index < 0) throw new Error("会话不存在或已被删除");
    this.settings.sessions.splice(index, 1);
    const next = this.settings.sessions[Math.min(index, this.settings.sessions.length - 1)];
    if (next) {
      this.settings.activeSessionId = next.id;
      return next;
    }
    return this.newSession();
  }

  async importClaudianSettings(config: NonNullable<MigrationPreview["claudian"]>): Promise<void> {
    this.settings.agent.protocol = "anthropic-messages";
    if (config.baseUrl) this.settings.agent.baseUrl = config.baseUrl;
    if (config.models.length > 0) {
      const fast = config.models.find((item) => /flash|haiku|mini|fast/i.test(item.id)) ?? config.models.at(-1)!;
      const deep = config.models.find((item) => /pro|opus|max|deep/i.test(item.id)) ?? config.models[0]!;
      this.settings.agent.models = [
        { id: fast.id, label: fast.id, contextWindow: fast.contextWindow, role: "fast" },
        { id: deep.id, label: deep.id, contextWindow: deep.contextWindow, role: "default" },
        { id: deep.id, label: deep.id, contextWindow: deep.contextWindow, role: "deep" }
      ];
    }
    await this.saveSettings();
    new Notice("已导入 Claudian 的 Anthropic-compatible API 与模型设置；请重新输入 Token");
  }

  private registerCommands(): void {
    this.addCommand({
      id: "open-workbench",
      name: "打开工作台",
      callback: () => void this.openWorkbench()
    });
    this.addCommand({
      id: "initialize-or-migrate",
      name: "初始化或迁移 Wiki",
      callback: () => new InitializeModal(this).open()
    });
    this.addCommand({
      id: "import-materials",
      name: "导入素材",
      callback: async () => {
        this.settings.activeTab = "materials";
        await this.saveSettings();
        await this.openWorkbench();
        await this.refreshView();
      }
    });
    this.addCommand({
      id: "new-editable-note",
      name: "新建笔记",
      callback: async () => {
        if (!(await this.wiki.isInitialized())) {
          new Notice("请先初始化 T-Wiki");
          return;
        }
        const title = await requestText(
          this.app,
          "新建 T-Wiki 笔记",
          "笔记可自由编辑，发布后才会进入 Raw 和 Ingest。",
          "",
          false,
          "笔记标题"
        );
        if (!title?.trim()) return;
        try {
          const view = await this.wiki.createEditableNote(title);
          await this.openVaultPath(view.record.path);
        } catch (error) {
          new Notice(`创建笔记失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });
    this.addCommand({
      id: "create-revision-from-active-raw",
      name: "基于当前 Raw 创建修订稿",
      callback: async () => {
        const active = this.app.workspace.getActiveFile();
        if (!active) {
          new Notice("请先打开一个 Raw Markdown");
          return;
        }
        const source = (await this.wiki.listSources()).find((item) => item.parse.revisions.some((revision) =>
          revision.rawPath === active.path
        ));
        if (!source) {
          new Notice("当前文件不是受 T-Wiki 管理的 Raw");
          return;
        }
        try {
          const mode = await chooseRevisionMode(this.app);
          if (!mode) return;
          const view = await this.wiki.createRawRevisionDraft(source.sourceId, mode);
          await this.openVaultPath(view.record.path);
        } catch (error) {
          new Notice(`创建修订稿失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });
    this.addCommand({
      id: "absorb-active-editable-document",
      name: "沉淀当前笔记或修订稿",
      callback: async () => {
        const active = this.app.workspace.getActiveFile();
        const view = active
          ? (await this.wiki.listEditableDocuments()).find((item) => item.record.path === active.path)
          : undefined;
        if (!view) {
          new Notice("当前文件不是 T-Wiki 可编辑文稿");
          return;
        }
        const absorb = async (): Promise<void> => {
          const plan = await this.workflows.absorbEditableDocument(view.record.documentId, () => undefined);
          new ReviewModal(this, plan).open();
        };
        try {
          if (view.record.kind === "raw_revision" && (view.status === "draft" || view.status === "dirty")) {
            const diff = await this.wiki.diffEditableDocument(view.record.documentId);
            new EditableDiffModal(this.app, `${view.title ?? view.record.title} · 确认沉淀`, diff, absorb).open();
          } else {
            await absorb();
          }
        } catch (error) {
          new Notice(`沉淀失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });
    this.addCommand({
      id: "import-audio-video",
      name: "导入音视频",
      callback: () => {
        const input = createEl("input");
        input.type = "file";
        input.multiple = true;
        input.accept = "audio/*,video/*,.mkv,.avi,.flac,.ogg,.m4a,.webm";
        input.onchange = () => void this.importFiles(Array.from(input.files ?? []))
          .then(async () => {
            this.settings.activeTab = "materials";
            await this.saveSettings();
            await this.openWorkbench();
            await this.refreshView();
            new Notice("媒体原件已保存；请在素材页确认远程转写");
          })
          .catch((error) => new Notice(error instanceof Error ? error.message : String(error)));
        input.click();
      }
    });
    this.addCommand({
      id: "capture-web-page",
      name: "抓取网页正文",
      callback: () => new UrlCaptureModal(this, "web").open()
    });
    this.addCommand({
      id: "capture-online-video",
      name: "解析在线视频",
      callback: () => new UrlCaptureModal(this, "video").open()
    });
    this.addCommand({
      id: "scan-materials",
      name: "校验 raw 素材",
      checkCallback: (checking) => {
        if (!checking) void this.wiki.verifyRaw().then((report) => {
          const failures = report.filter((item) => !item.ok).length;
          new Notice(failures > 0 ? `raw 校验完成：${failures} 个异常` : "raw 校验通过");
          return this.refreshView();
        }).catch((error) => new Notice(error instanceof Error ? error.message : String(error)));
        return true;
      }
    });
    this.addCommand({
      id: "scan-web-clipper-inbox",
      name: "扫描 Web Clipper Inbox",
      callback: () => void this.scanWebClipper().then((result) => {
        new Notice(`Clipper 扫描：新增 ${result.imported}，重复 ${result.duplicates}，失败 ${result.failed.length}`);
        return this.refreshView();
      }).catch((error) => new Notice(error instanceof Error ? error.message : String(error)))
    });
    this.addCommand({
      id: "lint",
      name: "运行 Wiki 健康检查",
      checkCallback: (checking) => {
        if (!checking) void this.workflows.executeCommandText("/lint").then((result) => {
          new Notice(result.text);
          this.settings.activeTab = "home";
          return this.refreshView();
        }).catch((error) => new Notice(error instanceof Error ? error.message : String(error)));
        return true;
      }
    });
    this.addCommand({
      id: "reindex",
      name: "重建 Wiki 索引",
      checkCallback: (checking) => {
        if (!checking) void this.workflows.executeCommandText("/reindex")
          .then((result) => new Notice(result.text))
          .catch((error) => new Notice(error instanceof Error ? error.message : String(error)));
        return true;
      }
    });
    this.addCommand({
      id: "rollback-last-ingest",
      name: "回滚上一次 Ingest",
      callback: () => void this.workflows.previewIngestRollback()
        .then((preview) => new RollbackModal(this, preview, () => void this.refreshView()).open())
        .catch((error) => new Notice(error instanceof Error ? error.message : String(error)))
    });
    this.addCommand({
      id: "delete-active-raw-source",
      name: "删除当前 raw 来源及关联数据",
      callback: () => {
        const path = this.app.workspace.getActiveFile()?.path;
        if (!path) return void new Notice("请先打开一个 canonical raw Markdown");
        void this.workflows.previewSourceDeletion(path)
          .then((preview) => new DeleteSourceModal(this, preview, () => void this.refreshView()).open())
          .catch((error) => new Notice(error instanceof Error ? error.message : String(error)));
      }
    });
    this.addCommand({
      id: "agent-status",
      name: "Agent 运行状态",
      callback: () => void this.workflows.executeCommandText("/agent status")
        .then((result) => new Notice(result.text))
    });
    this.addCommand({
      id: "agent-cancel",
      name: "取消当前 Agent",
      callback: () => void this.workflows.executeCommandText("/agent cancel")
        .then((result) => new Notice(result.text))
    });
    this.addCommand({
      id: "query",
      name: "打开智能工作区（知识查询）",
      callback: async () => {
        this.settings.activeTab = "query";
        await this.saveSettings();
        await this.openWorkbench();
        await this.refreshView();
      }
    });
    this.addCommand({
      id: "open-recovery-center",
      name: "打开恢复中心",
      callback: async () => {
        if (!(await this.wiki.isInitialized())) {
          new Notice("请先初始化 T-Wiki");
          return;
        }
        this.settings.activeTab = "recovery";
        await this.saveSettings();
        await this.openWorkbench();
        await this.refreshView();
      }
    });
  }
}

function createMediaJobStore(adapter: DataAdapter, internalRoot: string): FileSystemMediaJobStore | undefined {
  const basePath = (adapter as DataAdapter & { getBasePath?: () => string }).getBasePath?.();
  return typeof basePath === "string" && basePath
    ? new FileSystemMediaJobStore(join(basePath, ...internalRoot.replaceAll("\\", "/").split("/"), "media-jobs"))
    : undefined;
}

const DOUYIN_PARSE_PHASES: Readonly<Record<string, DouyinCapturePhase>> = {
  uploading: "uploading",
  transcribing: "transcribing",
  "formatting-transcript": "formatting-transcript",
  "reading-media-info": "reading-media-info",
  "extracting-frames": "extracting-frames",
  "filtering-frames": "filtering-frames",
  "visual-analysis": "visual-analysis",
  "building-markdown": "building-markdown",
  "quality-check": "quality-check",
  publishing: "publishing",
  verifying: "verifying",
  completed: "complete"
};

function createSession(): ChatSession {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: "新会话",
    createdAt: now,
    updatedAt: now,
    messages: []
  };
}
