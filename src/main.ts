import { Notice, Plugin, type WorkspaceLeaf } from "obsidian";

import {
  normalizePluginSettings,
  type StoredPluginSettings
} from "./agent/agent-settings";
import { EmbeddedAgentRuntimeFactory } from "./agent/runtime-factory";
import {
  FilePickerConnector,
  UrlCaptureConnector,
  WebClipperInboxConnector,
  type ConnectorScanResult,
  type UrlCaptureResult
} from "./connectors/source-connector";
import { SafeWebPageFetcher, validateWebUrl } from "./connectors/web-page-fetcher";
import { createDefaultParserRegistry } from "./parsing/default-parser-registry";
import type { MinerUProtocol } from "./parsing/parsers/mineru-parser";
import { ObsidianHttpClient } from "./services/obsidian-http-client";
import { SecretStore } from "./services/secret-store";
import { WikiService, type MigrationPreview } from "./services/wiki-service";
import { WorkflowService } from "./services/workflow-service";
import type { ChatSession, PluginSettings } from "./types";
import { DeleteSourceModal, InitializeModal, RollbackModal, UrlCaptureModal } from "./ui/modals";
import { LLMWikiSettingTab } from "./ui/settings-tab";
import { VIEW_TYPE_LLM_WIKI, WorkbenchView } from "./ui/workbench-view";

export const MINERU_CLOUD_SECRET_ID = "t-wiki-mineru-cloud-token";
export const MINERU_SELF_HOSTED_SECRET_ID = "t-wiki-mineru-self-hosted-token";

export default class LLMWikiPlugin extends Plugin {
  declare settings: PluginSettings;
  wiki!: WikiService;
  secrets!: SecretStore;
  workflows!: WorkflowService;
  private readonly filePicker = new FilePickerConnector();
  private readonly urlCapture = new UrlCaptureConnector(new SafeWebPageFetcher());
  private webClipper?: WebClipperInboxConnector;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.secrets = new SecretStore(this.app);
    const http = new ObsidianHttpClient();
    this.wiki = new WikiService(this.app, () => createDefaultParserRegistry({
      mineru: {
        http,
        credentials: {
          getToken: (protocol: MinerUProtocol) => this.secrets.get(
            protocol === "cloud-v4" ? MINERU_CLOUD_SECRET_ID : MINERU_SELF_HOSTED_SECRET_ID
          )
        }
      }
    }));
    const runtimeFactory = new EmbeddedAgentRuntimeFactory(this.secrets, () => this.settings);
    this.workflows = new WorkflowService(this.wiki, runtimeFactory, () => this.settings);
    this.registerEvent(this.app.vault.on("create", (file) => {
      if (file.path.endsWith(".md")) this.wiki.markNavigationIndexDirty(file.path);
    }));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file.path.endsWith(".md")) this.wiki.markNavigationIndexDirty(file.path);
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (file.path.endsWith(".md")) this.wiki.markNavigationIndexDirty(file.path);
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (file.path.endsWith(".md")) this.wiki.markNavigationIndexDirty(file.path);
      if (oldPath.endsWith(".md")) this.wiki.markNavigationIndexDirty(oldPath);
    }));
    await this.filePicker.start(this.connectorContext());
    await this.urlCapture.start(this.connectorContext());

    this.registerView(VIEW_TYPE_LLM_WIKI, (leaf: WorkspaceLeaf) => new WorkbenchView(leaf, this));
    this.addRibbonIcon("library-big", "打开 T-Wiki", () => void this.openWorkbench());
    this.addSettingTab(new LLMWikiSettingTab(this));
    this.registerCommands();

    this.app.workspace.onLayoutReady(async () => {
      if (await this.wiki.isInitialized()) {
        const recovered = await this.wiki.recoverTransactions();
        if (recovered > 0) new Notice(`T-Wiki 已恢复 ${recovered} 个未完成事务`);
        await this.restartWebClipperConnector();
      }
    });
  }

  onunload(): void {
    void this.workflows?.dispose();
    void this.filePicker.stop();
    void this.urlCapture.stop();
    void this.webClipper?.stop();
  }

  async importFiles(files: File[]): Promise<import("./types").SourceManifest[]> {
    return this.filePicker.importFiles(files);
  }

  async captureUrl(
    url: string,
    signal?: AbortSignal,
    reportProgress?: (phase: "download" | "parse" | "complete") => void
  ): Promise<UrlCaptureResult> {
    if (!(await this.wiki.isInitialized())) throw new Error("请先初始化 T-Wiki");
    if (await this.wiki.requiresParsingMigration()) throw new Error("请先迁移解析配置");
    return this.urlCapture.capture({ url, signal, reportProgress });
  }

  async openUrlInBrowser(input: string): Promise<void> {
    const url = validateWebUrl(input);
    const electron = require("electron") as { shell: { openExternal(url: string): Promise<void> } };
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

  async refreshView(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_LLM_WIKI)) {
      const view = leaf.view;
      if (view instanceof WorkbenchView) await view.render();
    }
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as StoredPluginSettings | null;
    this.settings = normalizePluginSettings(data);
    if (data && (data.schemaVersion !== 5 || !data.agent)) await this.saveData(this.settings);
    if (!this.settings.activeSessionId || !this.settings.sessions.some((item) => item.id === this.settings.activeSessionId)) {
      const session = createSession();
      this.settings.sessions.unshift(session);
      this.settings.activeSessionId = session.id;
    }
  }

  private connectorContext(): import("./connectors/source-connector").SourceConnectorContext {
    return {
      importSource: (name, bytes, provenance) => this.wiki.importSourceDetailed(name, bytes, provenance),
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
      id: "capture-web-page",
      name: "抓取网页",
      callback: () => new UrlCaptureModal(this).open()
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
  }
}

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
