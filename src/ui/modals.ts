import { Modal, Notice, Setting, type App } from "obsidian";

import { DEFAULT_CONFIG, sha256 } from "../core/wiki-core";
import { isBilibiliUrl } from "../connectors/bilibili-video-connector";
import { isDouyinUrl } from "../connectors/douyin-video-connector";
import type {
  IngestCoverageReport,
  KnowledgeDecision,
  RollbackPreview,
  SourceDeletionPreview,
  WikiChangePlan,
  WikiConfig
} from "../types";
import type LLMWikiPlugin from "../main";

export function confirmAction(
  app: App,
  title: string,
  message: string,
  confirmText = "确认",
  destructive = false
): Promise<boolean> {
  return new Promise((resolve) => {
    new ConfirmationModal(app, title, message, confirmText, destructive, resolve).open();
  });
}

export function requestText(
  app: App,
  title: string,
  description: string,
  initialValue = "",
  multiline = false
): Promise<string | undefined> {
  return new Promise((resolve) => {
    new TextRequestModal(app, title, description, initialValue, multiline, resolve).open();
  });
}

class ConfirmationModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly titleText: string,
    private readonly message: string,
    private readonly confirmText: string,
    private readonly destructive: boolean,
    private readonly resolve: (confirmed: boolean) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(this.titleText);
    this.contentEl.createEl("p", { text: this.message, cls: "llm-wiki-confirm-message" });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("取消").onClick(() => this.finish(false)))
      .addButton((button) => {
        button.setButtonText(this.confirmText).setCta();
        if (this.destructive) button.buttonEl.addClass("mod-warning");
        button.onClick(() => this.finish(true));
      });
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.resolve(false);
  }

  private finish(value: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(value);
    this.close();
  }
}

class TextRequestModal extends Modal {
  private settled = false;
  private value: string;

  constructor(
    app: App,
    private readonly titleText: string,
    private readonly description: string,
    initialValue: string,
    private readonly multiline: boolean,
    private readonly resolve: (value: string | undefined) => void
  ) {
    super(app);
    this.value = initialValue;
  }

  onOpen(): void {
    this.setTitle(this.titleText);
    if (this.description) this.contentEl.createEl("p", { text: this.description });
    const setting = new Setting(this.contentEl).setName("内容");
    if (this.multiline) {
      setting.addTextArea((input) => input
        .setValue(this.value)
        .onChange((value) => { this.value = value; }));
    } else {
      setting.addText((input) => input
        .setValue(this.value)
        .onChange((value) => { this.value = value; }));
    }
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("取消").onClick(() => this.finish(undefined)))
      .addButton((button) => button.setButtonText("确定").setCta().onClick(() => this.finish(this.value.trim())));
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.resolve(undefined);
  }

  private finish(value: string | undefined): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(value);
    this.close();
  }
}

export class InitializeModal extends Modal {
  private config: WikiConfig = structuredClone(DEFAULT_CONFIG);

  constructor(private readonly plugin: LLMWikiPlugin) {
    super(plugin.app);
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    if (await this.plugin.wiki.isInitialized()) {
      this.config = structuredClone(await this.plugin.wiki.loadConfig());
    }
    contentEl.createEl("h2", { text: "初始化 T-Wiki" });
    const preview = await this.plugin.wiki.previewMigration();
    if (preview.legacy) {
      contentEl.createEl("p", {
        text: preview.parsingFrameworkV2
          ? "检测到解析框架 v2；将备份并升级配置和 Manifest，不会重解析或删除现有 raw Markdown。"
          : `检测到 v1 Wiki；${preview.pages.filter((item) => item.changed).length} 个页面需要 Schema 迁移。原件、状态、Source 引用和页面会在完整备份后升级。`,
        cls: "llm-wiki-muted"
      });
    }
    new Setting(contentEl).setName("知识库名称").addText((text) => text
      .setValue(this.config.name)
      .onChange((value) => { this.config.name = value.trim() || DEFAULT_CONFIG.name; }));
    new Setting(contentEl).setName("知识领域").addText((text) => text
      .setValue(this.config.domain)
      .onChange((value) => { this.config.domain = value.trim() || DEFAULT_CONFIG.domain; }));
    new Setting(contentEl).setName("目标读者").addText((text) => text
      .setValue(this.config.audience)
      .onChange((value) => { this.config.audience = value.trim() || DEFAULT_CONFIG.audience; }));
    new Setting(contentEl).setName("内容语言").addText((text) => text
      .setValue(this.config.language)
      .onChange((value) => { this.config.language = value.trim() || "zh-CN"; }));
    new Setting(contentEl)
      .setName(preview.legacy ? "迁移现有 Wiki" : "创建目录与模板")
      .setDesc(preview.legacy
        ? preview.parsingFrameworkV2
          ? "升级到可扩展 Parser Provider、Parse Attempt 与 Source Map 框架；旧 revision 保持可用。"
          : "原件进入内部对象库，MD/TXT/PDF 解析为 raw Markdown；任一步失败将保留 v1 数据。"
        : "生成标准目录、解析配置、Schema 和 Agent 规则。")
      .addButton((button) => button
        .setCta()
        .setButtonText(preview.legacy ? "备份并迁移" : "初始化")
        .onClick(async () => {
          button.setDisabled(true);
          try {
            await this.plugin.wiki.initialize(this.config, preview.legacy);
            if (preview.claudian) await this.plugin.importClaudianSettings(preview.claudian);
            new Notice("T-Wiki 初始化完成");
            this.close();
            await this.plugin.openWorkbench();
            await this.plugin.refreshView();
          } catch (error) {
            new Notice(`初始化失败：${error instanceof Error ? error.message : String(error)}`);
            button.setDisabled(false);
          }
        }));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class UrlCaptureModal extends Modal {
  private controller?: AbortController;
  private pendingInlineConfirmation?: (confirmed: boolean) => void;

  constructor(
    private readonly plugin: LLMWikiPlugin,
    private readonly mode: "web" | "video" = "web"
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    const videoMode = this.mode === "video";
    contentEl.createEl("h2", { text: videoMode ? "解析在线视频" : "抓取网页正文" });
    contentEl.createEl("p", {
      text: videoMode
        ? "支持公开 Bilibili 和抖音视频。Bilibili 优先读取字幕；抖音通过本机 yt-dlp 下载后复用 ASR 与关键画面解析。不会自动 Ingest。"
        : "提取公开网页的正文并生成 Markdown。登录、动态或受保护页面请使用浏览器 Web Clipper；视频链接请使用“解析在线视频”。",
      cls: "llm-wiki-muted"
    });
    let url = "";
    let bilibiliPages: "current" | "all" = "current";
    let bilibiliLanguage = "";
    const status = contentEl.createEl("p", {
      text: videoMode ? "等待输入 Bilibili 或抖音视频地址" : "等待输入网页地址",
      cls: "llm-wiki-muted"
    });
    let directButton: import("obsidian").ButtonComponent | undefined;
    let browserButton: import("obsidian").ButtonComponent | undefined;
    let transcribeButton: import("obsidian").ButtonComponent | undefined;
    const bilibiliSettings: Setting[] = [];
    const updateVideoPlatform = (): void => {
      if (!videoMode) return;
      const douyin = isDouyinUrl(url);
      const bilibili = isBilibiliUrl(url);
      directButton?.setButtonText(douyin ? "下载并图文解析" : "读取视频字幕");
      for (const setting of bilibiliSettings) setting.settingEl.hidden = douyin;
      if (transcribeButton) setButtonVisible(transcribeButton, false);
      status.setText(douyin
        ? "已识别抖音视频：将通过本机 yt-dlp 下载完整视频"
        : bilibili ? "已识别 Bilibili 视频" : "等待输入 Bilibili 或抖音视频地址");
    };
    new Setting(contentEl)
      .setName(videoMode ? "视频地址" : "网页地址")
      .addText((text) => text
        .setPlaceholder(videoMode ? "https://www.bilibili.com/video/BV... 或 https://v.douyin.com/..." : "https://example.com/article")
        .onChange((value) => {
          url = value.trim();
          updateVideoPlatform();
        }));
    if (videoMode) {
      bilibiliSettings.push(new Setting(contentEl)
        .setName("Bilibili 分 P")
        .setDesc("URL 中的 p 参数决定“当前分 P”。")
        .addDropdown((dropdown) => dropdown
          .addOption("current", "当前分 P")
          .addOption("all", "全部分 P（最多 100）")
          .setValue(bilibiliPages)
          .onChange((value) => { bilibiliPages = value === "all" ? "all" : "current"; })));
      bilibiliSettings.push(new Setting(contentEl)
        .setName("字幕语言偏好")
        .setDesc("可选，例如 zh-CN；留空时按简体中文、中文、第一条字幕排序。")
        .addText((text) => text.onChange((value) => { bilibiliLanguage = value.trim(); })));
    }
    const actions = new Setting(contentEl);
    if (!videoMode) {
      actions.addButton((button) => {
        browserButton = button;
        button.setButtonText("在浏览器中采集").onClick(async () => {
          try {
            await this.plugin.openUrlInBrowser(url);
            status.setText(this.plugin.settings.webClipper.enabled
              ? `已打开浏览器。请使用 Web Clipper 保存到 ${this.plugin.settings.webClipper.inboxPath}/。`
              : `已打开浏览器。Web Clipper Inbox 尚未启用，请在设置中启用并保存到 ${this.plugin.settings.webClipper.inboxPath}/。`);
          } catch (error) {
            status.setText(error instanceof Error ? error.message : String(error));
          }
        });
      });
    }
    actions.addButton((button) => {
        directButton = button;
        button.setCta().setButtonText(videoMode ? "读取视频字幕" : "直接抓取正文").onClick(async () => {
          if (videoMode && isDouyinUrl(url)) {
            await this.captureDouyin(url, status, directButton, browserButton, transcribeButton);
            return;
          }
          if (videoMode && !isBilibiliUrl(url)) {
            status.setText("当前在线视频入口支持公开 Bilibili 和抖音 HTTPS 地址。");
            return;
          }
          if (!videoMode && (isBilibiliUrl(url) || isDouyinUrl(url))) {
            status.setText("这是视频平台地址，请关闭窗口并使用素材页的“解析在线视频”入口。");
            return;
          }
          directButton?.setDisabled(true);
          browserButton?.setDisabled(true);
          this.controller = new AbortController();
          try {
            const result = await this.plugin.captureUrl(
              url,
              this.controller.signal,
              (phase) => status.setText(videoMode
                ? phase === "download"
                  ? "正在读取视频元数据…"
                  : phase === "parse" ? "正在获取并整理字幕…" : "在线视频解析完成"
                : phase === "download"
                  ? "正在下载网页 HTML…"
                  : phase === "parse"
                    ? "HTML 已保存，正在解析并发布 Markdown…"
                    : "网页抓取完成"),
              { pages: bilibiliPages, language: bilibiliLanguage || undefined },
              videoMode ? "video" : "web"
            );
            new Notice(result.duplicate
              ? "内容已存在，已复用原素材"
              : videoMode ? "视频字幕已生成 raw Markdown" : "网页已抓取并生成 raw Markdown");
            this.plugin.settings.activeTab = "materials";
            await this.plugin.saveSettings();
            await this.plugin.refreshView();
            this.close();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const noCaption = error && typeof error === "object" && (error as { code?: string }).code === "NO_CAPTION_TRACK";
            status.setText(noCaption
              ? `${message}。可以在明确确认后下载公开音轨并发送到已配置的转写服务。`
              : videoMode ? message : `${message}。可改用“在浏览器中采集”。`);
            if (noCaption && transcribeButton) setButtonVisible(transcribeButton, true);
            directButton?.setDisabled(false);
            browserButton?.setDisabled(false);
          }
        });
      });
    if (videoMode) {
      actions.addButton((button) => {
        transcribeButton = button;
        setButtonVisible(button, false);
        button.setCta().setButtonText("确认并远程转写");
        button.buttonEl.addClass("mod-warning");
        button.onClick(async () => {
          if (!isBilibiliUrl(url)) {
            status.setText(isDouyinUrl(url)
              ? "抖音视频请点击“下载并图文解析”；该按钮仅用于 Bilibili 无字幕时的音轨转写。"
              : "请先输入有效的 Bilibili 或抖音视频地址，也可以直接粘贴抖音数字视频 ID。");
            setButtonVisible(button, false);
            return;
          }
          try {
            const config = await this.plugin.wiki.loadConfig();
            const provider = config.parsing.providers["media-transcription"];
            if (!provider?.enabled) throw new Error("请先在设置中启用音视频远程转写");
            const options = provider.options;
            const confirmed = await confirmAction(this.plugin.app, "确认远程转写", [
              `来源：${url}`,
              `协议：${String(options.protocol ?? "openai-transcriptions")}`,
              `服务：${String(options.baseUrl ?? "")}`,
              `模型：${String(options.model ?? "")}`,
              "",
              "将先下载该分 P 的公开音轨，再把音轨发送给上述远程服务。是否仅授权本次操作？"
            ].join("\n"), "确认并转写", true);
            if (!confirmed) return;
            directButton?.setDisabled(true);
            browserButton?.setDisabled(true);
            transcribeButton?.setDisabled(true);
            this.controller = new AbortController();
            await this.plugin.captureBilibiliWithTranscription(
              url,
              this.controller.signal,
              (completed, total) => status.setText(total
                ? `正在下载公开音轨：${Math.round(completed / total * 100)}%`
                : `正在下载公开音轨：${Math.round(completed / 1024 / 1024)} MiB`)
            );
            new Notice("Bilibili 音轨已转写并生成 raw Markdown");
            this.plugin.settings.activeTab = "materials";
            await this.plugin.saveSettings();
            await this.plugin.refreshView();
            this.close();
          } catch (error) {
            status.setText(error instanceof Error ? error.message : String(error));
            directButton?.setDisabled(false);
            browserButton?.setDisabled(false);
            transcribeButton?.setDisabled(false);
          }
        });
      });
    }
    updateVideoPlatform();
  }

  private async captureDouyin(
    url: string,
    status: HTMLParagraphElement,
    directButton?: import("obsidian").ButtonComponent,
    browserButton?: import("obsidian").ButtonComponent,
    transcribeButton?: import("obsidian").ButtonComponent
  ): Promise<void> {
    try {
      const douyin = this.plugin.settings.onlineVideo.douyin;
      if (!douyin.enabled) throw new Error("请先在 T-Wiki 设置中启用“在线视频 / 抖音”并测试 yt-dlp");
      const config = await this.plugin.wiki.loadConfig();
      const provider = config.parsing.providers["media-transcription"];
      if (!provider?.enabled) throw new Error("请先在设置中启用音视频远程转写");
      const options = provider.options;
      const visual = options.visual && typeof options.visual === "object"
        ? options.visual as Record<string, unknown>
        : {};
      const vision = visual.vision && typeof visual.vision === "object"
        ? visual.vision as Record<string, unknown>
        : {};
      directButton?.setDisabled(true);
      browserButton?.setDisabled(true);
      transcribeButton?.setDisabled(true);
      const confirmed = await this.confirmInline("确认解析抖音视频", [
        `来源：${url}`,
        `yt-dlp：${douyin.ytDlpPath || "自动检测"}`,
        `最大下载：${Math.round(douyin.maxDownloadBytes / 1024 / 1024)} MiB`,
        "",
        `ASR 服务：${String(options.baseUrl ?? "")}`,
        `ASR 模型：${String(options.model ?? "")}`,
        ...(visual.enabled === true ? [
          `视觉服务：${String(vision.baseUrl ?? "")}`,
          `视觉模型：${String(vision.model ?? "")}`
        ] : ["关键画面：未启用，将生成纯文字稿"]),
        "",
        "将下载完整公开视频并发送给 ASR；启用关键画面时还会发送缩略图及相邻文字。默认不会读取浏览器 Cookie。是否仅授权本次操作？"
      ].join("\n"), "确认并解析", true);
      if (!confirmed) {
        status.setText("已取消本次抖音解析，未下载或上传视频");
        directButton?.setDisabled(false);
        browserButton?.setDisabled(false);
        transcribeButton?.setDisabled(false);
        return;
      }
      status.setText("授权完成，正在启动抖音解析；关闭此窗口将取消任务…");
      new Notice("抖音视频解析已启动，进度将在当前窗口持续显示");
      this.controller = new AbortController();
      const report = (phase: import("../connectors/douyin-video-connector").DouyinCapturePhase, progress?: import("../connectors/yt-dlp").YtDlpDownloadProgress): void => {
        const messages = {
          resolving: "正在解析抖音分享链接…",
          metadata: "视频信息已确认，准备下载…",
          storing: "正在校验并保存视频原件…",
          uploading: "正在上传音视频到转写服务…",
          transcribing: "正在进行语音转写…",
          "reading-media-info": "正在读取视频媒体信息…",
          "extracting-frames": "正在提取关键帧候选…",
          "filtering-frames": "正在本地筛选关键帧…",
          "visual-analysis": "正在使用视觉模型判断关键画面…",
          "building-markdown": "正在合成图文 Markdown…",
          "quality-check": "正在执行解析质量校验…",
          publishing: "正在发布 canonical raw Markdown…",
          verifying: "正在验证 Markdown 与图片完整性…",
          complete: "抖音视频图文解析完成"
        } as const;
        if (phase === "downloading") {
          status.setText(progress?.percent !== undefined
            ? `正在下载抖音视频：${Math.round(progress.percent)}%`
            : `正在下载抖音视频：${Math.round((progress?.downloadedBytes ?? 0) / 1024 / 1024)} MiB`);
        } else status.setText(messages[phase]);
      };
      let result;
      try {
        result = await this.plugin.captureDouyinWithTranscription(url, false, this.controller.signal, report);
      } catch (error) {
        const cookieRequired = error && typeof error === "object"
          && (error as { code?: string }).code === "DOUYIN_COOKIE_REQUIRED";
        if (!cookieRequired) throw error;
        const allowCookies = await this.confirmInline("浏览器 Cookie 一次性授权", [
          "抖音要求有效的浏览器登录状态。",
          `浏览器：${browserLabel(douyin.cookieBrowser)}`,
          "",
          "T-Wiki 不会读取、复制或保存 Cookie；只会让 yt-dlp 在本次重试中临时读取浏览器 Cookie。是否授权一次？"
        ].join("\n"), "授权本次重试", true);
        if (!allowCookies) throw new Error("已取消浏览器 Cookie 授权，未继续下载");
        status.setText("已获得本次 Cookie 授权，正在重新解析抖音视频…");
        result = await this.plugin.captureDouyinWithTranscription(url, true, this.controller.signal, report);
      }
      new Notice(result.duplicate ? "视频原件已存在，已重新生成文字稿" : "抖音视频已生成 raw Markdown");
      this.plugin.settings.activeTab = "materials";
      await this.plugin.saveSettings();
      await this.plugin.refreshView();
      this.close();
    } catch (error) {
      status.setText(error instanceof Error ? error.message : String(error));
      directButton?.setDisabled(false);
      browserButton?.setDisabled(false);
      transcribeButton?.setDisabled(false);
    }
  }

  private confirmInline(
    title: string,
    message: string,
    confirmText: string,
    destructive = false
  ): Promise<boolean> {
    this.pendingInlineConfirmation?.(false);
    return new Promise((resolve) => {
      const card = this.contentEl.createDiv({ cls: "llm-wiki-card" });
      card.createEl("h3", { text: title });
      card.createEl("p", { text: message, cls: "llm-wiki-confirm-message" });
      let settled = false;
      const finish = (confirmed: boolean): void => {
        if (settled) return;
        settled = true;
        if (this.pendingInlineConfirmation === finish) this.pendingInlineConfirmation = undefined;
        card.remove();
        resolve(confirmed);
      };
      this.pendingInlineConfirmation = finish;
      new Setting(card)
        .addButton((button) => button.setButtonText("取消").onClick(() => finish(false)))
        .addButton((button) => {
          button.setButtonText(confirmText).setCta();
          if (destructive) button.buttonEl.addClass("mod-warning");
          button.onClick(() => finish(true));
        });
      card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }

  onClose(): void {
    this.pendingInlineConfirmation?.(false);
    this.pendingInlineConfirmation = undefined;
    this.controller?.abort();
    this.contentEl.empty();
  }
}

function browserLabel(value: "edge" | "chrome" | "firefox"): string {
  if (value === "chrome") return "Google Chrome";
  if (value === "firefox") return "Mozilla Firefox";
  return "Microsoft Edge";
}

export class ReviewModal extends Modal {
  constructor(
    private readonly plugin: LLMWikiPlugin,
    private readonly plan: WikiChangePlan,
    private readonly onApplied?: () => void,
    private readonly readOnly = false
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "审阅 Wiki 变更" });
    contentEl.createEl("p", { text: this.plan.summary });
    if (this.plan.ingestCoverage) renderIngestCoverage(contentEl, this.plan.ingestCoverage);
    const selected = new Set(this.plan.operations.map((operation) => operation.path));
    for (const operation of this.plan.operations) {
      const card = contentEl.createDiv({ cls: "llm-wiki-card" });
      const row = card.createDiv({ cls: "llm-wiki-row" });
      if (!this.readOnly) {
        const checkbox = row.createEl("input", { type: "checkbox" });
        checkbox.checked = true;
        const requiredSource = Boolean(this.plan.ingestCoverage && operation.path.startsWith("wiki/sources/"));
        checkbox.disabled = requiredSource;
        if (requiredSource) checkbox.title = "Ingest 来源页面必须应用";
        checkbox.onchange = () => {
          if (checkbox.checked) selected.add(operation.path);
          else selected.delete(operation.path);
        };
      }
      row.createEl("h3", { text: `${operation.action === "create" ? "新增" : "修改"} · ${operation.path}` });
      card.createEl("p", { text: operation.reason || "未提供原因", cls: "llm-wiki-muted" });
      card.createEl("pre", { text: operation.content, cls: "llm-wiki-diff" });
    }
    if (this.readOnly) {
      new Setting(contentEl).setDesc("Dry run：该计划不会进入待审阅状态，也不能 Apply。")
        .addButton((button) => button.setButtonText("关闭").onClick(() => this.close()));
      return;
    }
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("拒绝").onClick(async () => {
        await this.plugin.workflows.rejectPending();
        this.close();
        await this.plugin.refreshView();
      }))
      .addButton((button) => button.setCta().setButtonText("全部接受").onClick(async () => {
        button.setDisabled(true);
        try {
          await this.plugin.workflows.applyPending(selected);
          new Notice("Wiki 变更已应用");
          this.close();
          this.onApplied?.();
          await this.plugin.refreshView();
        } catch (error) {
          new Notice(`应用失败：${error instanceof Error ? error.message : String(error)}`);
          button.setDisabled(false);
        }
      }));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class RollbackModal extends Modal {
  constructor(
    private readonly plugin: LLMWikiPlugin,
    private readonly preview: RollbackPreview,
    private readonly onRolledBack?: () => void
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "回滚 Ingest" });
    contentEl.createEl("p", {
      text: this.preview.summary ?? `操作 ${this.preview.operationId}`
    });
    contentEl.createEl("p", {
      text: "回滚会删除本次新增页面、恢复本次更新页面；不会修改 raw Markdown 或原件。",
      cls: "llm-wiki-muted"
    });
    if (this.preview.appliedAt) {
      contentEl.createEl("p", { text: `应用时间：${new Date(this.preview.appliedAt).toLocaleString()}` });
    }
    for (const change of this.preview.changes) {
      const action = change.rollbackAction === "delete" ? "删除本次新增" : "恢复应用前版本";
      contentEl.createEl("p", { text: `${action} · ${change.path}` });
    }
    if (!this.preview.available) {
      contentEl.createEl("p", {
        text: this.preview.unavailableReason ?? "该操作没有可用的回滚快照。",
        cls: "llm-wiki-danger"
      });
    }
    if (this.preview.conflicts.length > 0) {
      const conflicts = contentEl.createDiv({ cls: "llm-wiki-card" });
      conflicts.createEl("h3", { text: "检测到后续修改，已阻止回滚" });
      for (const conflict of this.preview.conflicts) {
        conflicts.createEl("p", { text: `${conflict.path} · ${conflict.reason}`, cls: "llm-wiki-danger" });
      }
    }
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
      .addButton((button) => {
        button.setCta().setButtonText("确认回滚");
        button.setDisabled(!this.preview.available || this.preview.conflicts.length > 0);
        button.onClick(async () => {
          button.setDisabled(true);
          try {
            const result = await this.plugin.workflows.rollbackIngest(this.preview.operationId);
            new Notice(`回滚完成：恢复 ${result.restoredPaths.length} 个页面，删除 ${result.deletedPaths.length} 个页面`);
            this.close();
            this.onRolledBack?.();
            await this.plugin.refreshView();
          } catch (error) {
            new Notice(`回滚失败：${error instanceof Error ? error.message : String(error)}`);
            button.setDisabled(false);
          }
        });
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class DeleteSourceModal extends Modal {
  constructor(
    private readonly plugin: LLMWikiPlugin,
    private readonly preview: SourceDeletionPreview,
    private readonly onDeleted?: () => void
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "永久删除来源" });
    contentEl.createEl("p", {
      text: `将删除「${this.preview.sourceName}」及其全部受管数据。此操作不能撤销。`,
      cls: "llm-wiki-danger"
    });
    const details = contentEl.createEl("details", { cls: "llm-wiki-card" });
    details.open = true;
    details.createEl("summary", {
      text: `Wiki 变更 ${this.preview.wikiChanges.length} 项 · 数据文件 ${this.preview.dataPaths.length} 项`
    });
    for (const change of this.preview.wikiChanges) {
      details.createEl("p", {
        text: `${change.action === "delete" ? "删除 Wiki 页面" : "恢复 Wiki 旧版本"} · ${change.path}`
      });
    }
    for (const path of this.preview.dataPaths) details.createEl("p", { text: `删除数据 · ${path}` });
    if (this.preview.blockers.length > 0) {
      const blockers = contentEl.createDiv({ cls: "llm-wiki-card" });
      blockers.createEl("h3", { text: "当前不能安全删除" });
      for (const blocker of this.preview.blockers) {
        blockers.createEl("p", {
          text: `${blocker.path ? `${blocker.path} · ` : ""}${blocker.reason}`,
          cls: "llm-wiki-danger"
        });
      }
    }
    let confirmed = false;
    let deleteButton: import("obsidian").ButtonComponent | undefined;
    new Setting(contentEl)
      .setName("我理解该操作会永久删除原件和 raw 数据")
      .addToggle((toggle) => toggle.onChange((value) => {
        confirmed = value;
        deleteButton?.setDisabled(!confirmed || this.preview.blockers.length > 0);
      }));
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
      .addButton((button) => {
        deleteButton = button;
        button.setCta().setButtonText("永久删除").setDisabled(true);
        button.buttonEl.addClass("mod-warning");
        button.onClick(async () => {
          button.setDisabled(true);
          try {
            const result = await this.plugin.workflows.deleteSource(this.preview.sourceId);
            new Notice(`来源已删除：清理 ${result.deletedDataPaths.length} 个数据文件`);
            this.close();
            this.onDeleted?.();
            await this.plugin.refreshView();
          } catch (error) {
            new Notice(`删除失败：${error instanceof Error ? error.message : String(error)}`);
            button.setDisabled(!confirmed || this.preview.blockers.length > 0);
          }
        });
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function renderIngestCoverage(container: HTMLElement, report: IngestCoverageReport): void {
  const details = container.createEl("details", { cls: "llm-wiki-card" });
  details.open = true;
  details.createEl("summary", { text: `知识合并报告 · ${report.decisions.length} 个候选` });
  details.createEl("p", {
    text: "Source 页面为必选；其他变更可排除，排除项会记录为 user_rejected。",
    cls: "llm-wiki-muted"
  });
  for (const type of ["entity", "concept", "synthesis"] as const) {
    const assessments = report.categoryAssessments.filter((item) => item.type === type);
    const decisions = report.decisions.filter((item) => item.type === type);
    const section = details.createDiv({ cls: "llm-wiki-coverage-section" });
    section.createEl("h3", { text: `${coverageTypeLabel(type)} · ${decisions.length}` });
    for (const assessment of assessments) {
      section.createEl("p", {
        text: `${shortId(assessment.sourceId)} · ${assessment.outcome === "none" ? "无候选" : "已发现候选"} · ${assessment.reason}`,
        cls: "llm-wiki-muted"
      });
    }
    for (const decision of decisions) renderKnowledgeDecision(section, decision);
  }
}

function renderKnowledgeDecision(container: HTMLElement, decision: KnowledgeDecision): void {
  const card = container.createDiv({ cls: "llm-wiki-card" });
  card.createEl("strong", { text: `${decisionLabel(decision.decision)} · ${decision.title}` });
  if (decision.targetPath) card.createDiv({ text: decision.targetPath, cls: "llm-wiki-muted" });
  card.createEl("p", { text: decision.reason });
  card.createDiv({
    text: `Evidence: ${decision.evidence.map(formatCoverageEvidence).join(", ")}`,
    cls: "llm-wiki-muted"
  });
}

function formatCoverageEvidence(value: KnowledgeDecision["evidence"][number]): string {
  if (value.sourceId) return `${shortId(value.sourceId)}${value.sectionId ? `#${value.sectionId}` : ""}`;
  return `${value.wikiPath ?? "wiki"}@${(value.wikiHash ?? "").slice(0, 8)}`;
}

function coverageTypeLabel(type: KnowledgeDecision["type"]): string {
  return type === "entity" ? "Entity" : type === "concept" ? "Concept" : "Synthesis";
}

function decisionLabel(decision: KnowledgeDecision["decision"]): string {
  const labels: Record<KnowledgeDecision["decision"], string> = {
    created: "新建", updated: "更新", already_covered: "已覆盖", source_only: "仅保留 Source",
    insufficient_evidence: "证据不足", user_rejected: "用户排除"
  };
  return labels[decision];
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}

function setButtonVisible(button: import("obsidian").ButtonComponent, visible: boolean): void {
  button.buttonEl.hidden = !visible;
  button.buttonEl.style.display = visible ? "" : "none";
}

export function summarizePlan(plan: WikiChangePlan): string {
  return `${plan.summary} · ${plan.operations.length} 个文件 · ${sha256(JSON.stringify(plan)).slice(0, 8)}`;
}
