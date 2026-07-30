import { Notice, PluginSettingTab, Setting, type SettingDefinitionItem, type ToggleComponent } from "obsidian";

import LLMWikiPlugin, {
  MINERU_CLOUD_SECRET_ID,
  MINERU_SELF_HOSTED_SECRET_ID,
  MEDIA_OPENAI_SECRET_ID,
  MEDIA_WHISPER_SECRET_ID,
  VIDEO_VISION_SECRET_ID
} from "../main";
import type { ModelProfile, ParserProviderConfig } from "../types";

const SAVED_SECRET_MASK = "••••••••••••••••••••";

function boundedInteger(value: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export class LLMWikiSettingTab extends PluginSettingTab {
  constructor(private readonly plugin: LLMWikiPlugin) {
    super(plugin.app, plugin);
  }

  /**
   * Search metadata for Obsidian 1.13+. The imperative renderer remains the
   * compatibility path for the plugin's current minimum Obsidian version.
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      settingIndex("Agent Runtime / LLM API", "API 协议、Base URL、Token、结构化输出、超时、重试和连接测试", ["模型服务", "Provider"]),
      settingIndex("模型映射", "快速、默认和深度模型及上下文窗口", ["fast", "default", "deep"]),
      settingIndex("Agent Loop 预算", "轮数、工具调用、页面变更、Token 和总耗时限制", ["budget"]),
      settingIndex("Obsidian Web Clipper", "Clipper Inbox 路径、启动扫描和手动扫描", ["网页剪藏"]),
      settingIndex("在线视频 / 抖音", "yt-dlp 路径、Cookie 浏览器、下载上限和任务超时", ["Douyin", "在线视频"]),
      settingIndex("文档解析 / MinerU", "MinerU 协议、Base URL、Token、OCR、模型和轮询设置", ["PDF", "OCR"]),
      settingIndex("音视频解析", "远程转写协议、Base URL、Token、模型、语言、VAD 和说话人分离", ["ASR", "Whisper"]),
      settingIndex("关键画面", "FFmpeg、场景阈值、视觉 API、视觉模型和截图数量", ["Vision", "视频截图"])
    ];
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName("常规")
      .setHeading();

    this.renderAgentSettings();

    new Setting(containerEl)
      .setName("模型映射")
      .setHeading();
    for (const role of ["fast", "default", "deep"] as const) this.renderModel(role);

    this.renderAgentBudgets();

    this.renderWebClipper();
    this.renderOnlineVideo();
    void (async () => {
      await this.renderMinerU();
      await this.renderMediaTranscription();
    })();

  }

  private renderAgentSettings(): void {
    const agent = this.plugin.settings.agent;
    new Setting(this.containerEl)
      .setName("Agent Runtime / LLM API")
      .setHeading();
    this.containerEl.createEl("p", {
      text: "Ingest 时，canonical raw Markdown 与检索到的 Wiki 上下文会发送到所配置的远程 API。Token 仅保存到 Secret Storage。",
      cls: "llm-wiki-muted"
    });
    this.containerEl.createEl("p", {
      text: "领域 Agent 依赖 Provider 原生 Tool Calling；不支持工具调用的兼容服务会被连接测试明确拒绝，不会降级为 Prompt 模拟工具。",
      cls: "llm-wiki-muted"
    });
    new Setting(this.containerEl)
      .setName("API 协议")
      .addDropdown((dropdown) => dropdown
        .addOption("anthropic-messages", "Anthropic Messages")
        .addOption("openai-chat-completions", "OpenAI-compatible Chat Completions")
        .setValue(agent.protocol)
        .onChange(async (value) => {
          const previous = agent.protocol;
          agent.protocol = value === "openai-chat-completions" ? value : "anthropic-messages";
          if (previous !== agent.protocol) {
            if (agent.protocol === "openai-chat-completions" && agent.baseUrl === "https://api.anthropic.com") {
              agent.baseUrl = "https://api.openai.com/v1";
            } else if (agent.protocol === "anthropic-messages" && agent.baseUrl === "https://api.openai.com/v1") {
              agent.baseUrl = "https://api.anthropic.com";
            }
          }
          await this.plugin.saveSettings();
          this.display();
        }));
    new Setting(this.containerEl)
      .setName("Base URL")
      .setDesc("保留服务要求的路径，例如 OpenAI-compatible 常见为 https://host/v1。远程服务必须使用 HTTPS。")
      .addText((text) => text
        .setValue(agent.baseUrl)
        .onChange(async (value) => {
          agent.baseUrl = value.trim();
          await this.plugin.saveSettings();
        }));

    const tokenSetting = new Setting(this.containerEl).setName("API Token");
    let tokenInput: HTMLInputElement | undefined;
    const refreshToken = async (): Promise<void> => {
      const saved = Boolean((await this.plugin.secrets.get(agent.secretId)).trim());
      const persistence = this.plugin.secrets.isPersistent() ? "Obsidian Secret Storage" : "本次运行内存";
      tokenSetting.setDesc(saved
        ? `已保存到 ${persistence}；不会回显真实 Token。`
        : `尚未保存；仅 loopback OpenAI-compatible 服务允许空 Token。`);
      if (tokenInput && document.activeElement !== tokenInput) tokenInput.value = saved ? SAVED_SECRET_MASK : "";
    };
    tokenSetting.addText((text) => {
      tokenInput = text.inputEl;
      text.inputEl.type = "password";
      text.setPlaceholder("输入新 Token").onChange(async (value) => {
        if (value && value !== SAVED_SECRET_MASK) await this.plugin.secrets.set(agent.secretId, value);
      });
      text.inputEl.addEventListener("focus", () => {
        if (text.inputEl.value === SAVED_SECRET_MASK) text.inputEl.value = "";
      });
      text.inputEl.addEventListener("blur", () => void refreshToken());
    });
    void refreshToken();

    new Setting(this.containerEl)
      .setName("结构化输出")
      .setDesc("Auto 会优先使用原生 JSON Schema；服务明确不支持时才降级为 Prompt JSON。")
      .addDropdown((dropdown) => dropdown
        .addOption("auto", "Auto")
        .addOption("native", "仅原生 JSON Schema")
        .addOption("prompt", "Prompt JSON 兼容")
        .setValue(agent.structuredOutputMode)
        .onChange(async (value) => {
          agent.structuredOutputMode = value === "native" || value === "prompt" ? value : "auto";
          await this.plugin.saveSettings();
        }));
    new Setting(this.containerEl)
      .setName("请求超时（毫秒）")
      .addText((text) => text.setValue(String(agent.timeoutMs)).onChange(async (value) => {
        const parsed = Number(value);
        if (Number.isInteger(parsed) && parsed >= 1_000 && parsed <= 600_000) agent.timeoutMs = parsed;
        await this.plugin.saveSettings();
      }));
    new Setting(this.containerEl)
      .setName("瞬时错误重试次数")
      .addDropdown((dropdown) => {
        for (let value = 0; value <= 5; value += 1) dropdown.addOption(String(value), String(value));
        dropdown.setValue(String(agent.maxRetries)).onChange(async (value) => {
          agent.maxRetries = Number(value);
          await this.plugin.saveSettings();
        });
      });
    const connectionSetting = new Setting(this.containerEl)
      .setName("连接测试")
      .setDesc("验证协议、Base URL、认证、快速模型以及原生 Tool Calling 续轮。")
      .addButton((button) => button.setButtonText("测试连接").onClick(async () => {
        button.setDisabled(true).setButtonText("测试中…");
        connectionSetting.setDesc("正在执行两轮 Tool Call / Tool Result 兼容性测试…");
        try {
          const output = await this.plugin.workflows.testConnection(() => undefined);
          button.setButtonText(output || "成功");
          connectionSetting.setDesc(`连接成功：${output || "Tool Calling 续轮正常"}`);
        } catch (error) {
          button.setButtonText("失败");
          connectionSetting.setDesc(`连接失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
          button.setDisabled(false);
        }
      }));
  }

  private renderAgentBudgets(): void {
    new Setting(this.containerEl)
      .setName("Agent Loop 预算")
      .setHeading();
    this.containerEl.createEl("p", {
      text: "预算用于限制模型循环、工具调用、页面变更、累计 Token 和总耗时。单轮上下文容量由模型 context window 独立控制。修改只影响新启动的 Agent Run。",
      cls: "llm-wiki-muted"
    });
    const labels = {
      chat: "Chat", query: "Query", queryDeep: "Query deep", ingest: "Ingest single",
      ingestBatch: "Ingest batch", save: "Save", lintFix: "Lint fix"
    } as const;
    for (const [key, label] of Object.entries(labels) as Array<[keyof typeof labels, string]>) {
      const budget = this.plugin.settings.agent.budgets[key];
      new Setting(this.containerEl)
        .setClass("llm-wiki-budget-setting")
        .setClass("llm-wiki-budget-setting-limits")
        .setName(label)
        .setDesc("轮数 / Tool Calls / 最大变更页 / 总耗时秒")
        .addText((text) => text.setValue(String(budget.maxIterations)).onChange(async (value) => {
          budget.maxIterations = boundedInteger(value, budget.maxIterations, 1, 500);
          await this.plugin.saveSettings();
        }))
        .addText((text) => text.setValue(String(budget.maxToolCalls)).onChange(async (value) => {
          budget.maxToolCalls = boundedInteger(value, budget.maxToolCalls, 1, 2000);
          await this.plugin.saveSettings();
        }))
        .addText((text) => text.setValue(String(budget.maxChangedPages)).onChange(async (value) => {
          budget.maxChangedPages = boundedInteger(value, budget.maxChangedPages, 0, 500);
          await this.plugin.saveSettings();
        }))
        .addText((text) => text.setValue(String(Math.round(budget.maxWallTimeMs / 1000))).onChange(async (value) => {
          budget.maxWallTimeMs = boundedInteger(value, Math.round(budget.maxWallTimeMs / 1000), 10, 21600) * 1000;
          await this.plugin.saveSettings();
        }));
      new Setting(this.containerEl)
        .setClass("llm-wiki-budget-setting")
        .setClass("llm-wiki-budget-setting-tokens")
        .setName(`${label} Token`)
        .setDesc("累计输入 / 累计输出 / 单次 Tool Result（tokens）")
        .addText((text) => text.setValue(String(budget.maxInputTokens)).onChange(async (value) => {
          budget.maxInputTokens = boundedInteger(value, budget.maxInputTokens, 1000, 20_000_000);
          await this.plugin.saveSettings();
        }))
        .addText((text) => text.setValue(String(budget.maxOutputTokens)).onChange(async (value) => {
          budget.maxOutputTokens = boundedInteger(value, budget.maxOutputTokens, 256, 2_000_000);
          await this.plugin.saveSettings();
        }))
        .addText((text) => text.setValue(String(budget.maxToolResultTokens)).onChange(async (value) => {
          budget.maxToolResultTokens = boundedInteger(value, budget.maxToolResultTokens, 256, 250_000);
          await this.plugin.saveSettings();
        }));
    }
  }

  private renderWebClipper(): void {
    new Setting(this.containerEl)
      .setName("来源采集 / Obsidian Web Clipper")
      .setHeading();
    new Setting(this.containerEl)
      .setName("监听 Clipper Inbox")
      .setDesc("只自动 Parse 到 raw，不会自动调用 Agent 或 Ingest。")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.webClipper.enabled)
        .onChange(async (value) => {
          this.plugin.settings.webClipper.enabled = value;
          await this.plugin.saveSettings();
          try {
            await this.plugin.restartWebClipperConnector();
          } catch (error) {
            this.plugin.settings.webClipper.enabled = false;
            await this.plugin.saveSettings();
            new Notice(error instanceof Error ? error.message : String(error));
          }
        }));
    new Setting(this.containerEl)
      .setName("Inbox 文件夹")
      .setDesc(`相对于 Vault 根目录，不能与 raw、wiki、.llm-wiki 或 ${this.plugin.app.vault.configDir} 重叠。`)
      .addText((text) => text
        .setPlaceholder("Clippings")
        .setValue(this.plugin.settings.webClipper.inboxPath)
        .onChange(async (value) => {
          this.plugin.settings.webClipper.inboxPath = value.trim();
          await this.plugin.saveSettings();
        }));
    new Setting(this.containerEl)
      .setName("启动时扫描已有文件")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.webClipper.scanExistingOnStartup)
        .onChange(async (value) => {
          this.plugin.settings.webClipper.scanExistingOnStartup = value;
          await this.plugin.saveSettings();
        }));
    new Setting(this.containerEl)
      .setName("应用并扫描")
      .setDesc("重启监听器，并对 Inbox 中已有 Markdown 执行一次 sourceHash 去重扫描。")
      .addButton((button) => button.setButtonText("扫描 Clipper Inbox").onClick(async () => {
        button.setDisabled(true).setButtonText("扫描中…");
        try {
          await this.plugin.restartWebClipperConnector();
          const result = await this.plugin.scanWebClipper();
          button.setButtonText(`新增 ${result.imported} · 重复 ${result.duplicates} · 失败 ${result.failed.length}`);
        } catch (error) {
          button.setButtonText(error instanceof Error ? error.message : String(error));
        } finally {
          button.setDisabled(false);
        }
      }));
  }

  private renderOnlineVideo(): void {
    const settings = this.plugin.settings.onlineVideo.douyin;
    new Setting(this.containerEl)
      .setName("在线视频 / 抖音")
      .setHeading();
    this.containerEl.createEl("p", {
      text: "通过用户安装的 yt-dlp 下载单个抖音公开视频，再复用现有 ASR、FFmpeg 和视觉解析流程。默认不会读取浏览器 Cookie。",
      cls: "llm-wiki-muted"
    });
    new Setting(this.containerEl)
      .setName("yt-dlp 路径")
      .setDesc("可填写 yt-dlp.exe 绝对路径；留空时依次从 PATH 和 Windows WinGet 安装目录查找。")
      .addText((text) => text
        .setPlaceholder("自动检测或 C:\\path\\to\\yt-dlp.exe")
        .setValue(settings.ytDlpPath)
        .onChange(async (value) => {
          settings.ytDlpPath = value.trim();
          await this.plugin.saveSettings();
        }))
      .addButton((button) => button.setButtonText("自动检测").onClick(async () => {
        button.setDisabled(true).setButtonText("检测中…");
        try {
          settings.ytDlpPath = "";
          const info = await this.plugin.testDouyinYtDlp();
          await this.plugin.saveSettings();
          button.setButtonText(info.version);
          new Notice(`已找到 yt-dlp：${info.executable}`);
          this.display();
        } catch (error) {
          button.setButtonText("未找到");
          new Notice(error instanceof Error ? error.message : String(error));
        } finally {
          button.setDisabled(false);
        }
      }));
    new Setting(this.containerEl)
      .setName("浏览器 Cookie 来源")
      .setDesc("仅在公开下载被抖音要求登录且你对当前任务再次确认后，才让 yt-dlp 临时读取。")
      .addDropdown((dropdown) => dropdown
        .addOption("edge", "Microsoft Edge")
        .addOption("chrome", "Google Chrome")
        .addOption("firefox", "Mozilla Firefox")
        .setValue(settings.cookieBrowser)
        .onChange(async (value) => {
          settings.cookieBrowser = value === "chrome" || value === "firefox" ? value : "edge";
          await this.plugin.saveSettings();
        }));
    new Setting(this.containerEl)
      .setName("最大下载（MiB）")
      .addText((text) => text
        .setValue(String(Math.round(settings.maxDownloadBytes / 1024 / 1024)))
        .onChange(async (value) => {
          settings.maxDownloadBytes = boundedInteger(value, 500, 1, 500) * 1024 * 1024;
          await this.plugin.saveSettings();
        }));
    new Setting(this.containerEl)
      .setName("任务超时（秒）")
      .addText((text) => text
        .setValue(String(Math.round(settings.taskTimeoutMs / 1000)))
        .onChange(async (value) => {
          settings.taskTimeoutMs = boundedInteger(value, 1800, 30, 3600) * 1000;
          await this.plugin.saveSettings();
        }));
    new Setting(this.containerEl)
      .setName("启用抖音解析")
      .setDesc("启用前会验证 yt-dlp；真正处理视频时还会再次确认远程 ASR 与视觉上传。")
      .addToggle((toggle) => toggle
        .setValue(settings.enabled)
        .onChange(async (value) => {
          if (!value) {
            settings.enabled = false;
            await this.plugin.saveSettings();
            return;
          }
          try {
            const info = await this.plugin.testDouyinYtDlp();
            settings.enabled = true;
            await this.plugin.saveSettings();
            new Notice(`抖音解析已启用 · yt-dlp ${info.version}`);
          } catch (error) {
            settings.enabled = false;
            toggle.setValue(false);
            await this.plugin.saveSettings();
            new Notice(error instanceof Error ? error.message : String(error));
          }
        }));
    new Setting(this.containerEl)
      .setName("yt-dlp 环境测试")
      .setDesc("仅执行 yt-dlp --version，不访问抖音、不读取浏览器 Cookie。")
      .addButton((button) => button.setButtonText("测试 yt-dlp").onClick(async () => {
        button.setDisabled(true).setButtonText("测试中…");
        try {
          const info = await this.plugin.testDouyinYtDlp();
          button.setButtonText(`可用 · ${info.version}`);
        } catch (error) {
          button.setButtonText("失败");
          new Notice(error instanceof Error ? error.message : String(error));
        } finally {
          button.setDisabled(false);
        }
      }));
  }

  private async renderMinerU(): Promise<void> {
    new Setting(this.containerEl)
      .setName("文档解析 / MinerU")
      .setHeading();
    if (!(await this.plugin.wiki.isInitialized())) {
      this.containerEl.createEl("p", {
        text: "初始化 T-Wiki 后可配置 MinerU。"
      });
      return;
    }
    const config = await this.plugin.wiki.loadConfig();
    const current = config.parsing.providers["mineru-http"] ?? {
      enabled: false,
      priority: 50,
      options: {}
    };
    const draft: ParserProviderConfig = structuredClone(current);
    const options = draft.options;
    type MinerUSettingsProtocol = "cloud-v4" | "self-hosted";
    const tokenDrafts: Partial<Record<MinerUSettingsProtocol, string>> = {};
    let tokenSetting: Setting | undefined;
    let tokenInput: HTMLInputElement | undefined;
    const currentProtocol = (): MinerUSettingsProtocol => options.protocol === "self-hosted"
      ? "self-hosted"
      : "cloud-v4";
    const secretIdFor = (protocol: MinerUSettingsProtocol): string => protocol === "self-hosted"
      ? MINERU_SELF_HOSTED_SECRET_ID
      : MINERU_CLOUD_SECRET_ID;
    const refreshTokenState = async (): Promise<boolean> => {
      const protocol = currentProtocol();
      const saved = Boolean((await this.plugin.secrets.get(secretIdFor(protocol))).trim());
      const persistence = this.plugin.secrets.isPersistent()
        ? "Obsidian Secret Storage"
        : "本次运行内存";
      tokenSetting?.setDesc(saved
        ? `已保存到 ${persistence}（出于安全不会回显）；输入新 Token 可覆盖。`
        : `尚未保存；Cloud 必填，自托管可选。Token 仅保存到 ${persistence}。`);
      if (tokenInput) {
        tokenInput.placeholder = saved ? "已保存；输入新 Token 可替换" : "输入新 Token";
        tokenInput.value = tokenDrafts[protocol] || (saved ? SAVED_SECRET_MASK : "");
      }
      return saved;
    };
    const persistCurrentToken = async (required: boolean): Promise<void> => {
      const protocol = currentProtocol();
      const value = tokenDrafts[protocol]?.trim() ?? "";
      if (value) {
        await this.plugin.secrets.set(secretIdFor(protocol), value);
        tokenDrafts[protocol] = "";
      }
      const saved = await refreshTokenState();
      if (required && !saved) throw new Error("MinerU Cloud Token 尚未填写或保存失败");
    };
    new Setting(this.containerEl)
      .setName("启用 MinerU")
      .setDesc("启用表示允许在 PDF.js 遇到 OCR/质量失败时将原件发送到所选 MinerU 服务。")
      .addToggle((toggle) => toggle.setValue(draft.enabled).onChange((value) => {
        draft.enabled = value;
      }));
    new Setting(this.containerEl)
      .setName("API 协议")
      .setDesc("Cloud v4 使用 MinerU 官方签名上传；自托管使用 mineru-api /tasks。")
      .addDropdown((dropdown) => dropdown
        .addOption("cloud-v4", "MinerU Cloud v4")
        .addOption("self-hosted", "自托管 mineru-api")
        .setValue(String(options.protocol ?? "cloud-v4"))
        .onChange((value) => {
          options.protocol = value;
          if (value === "cloud-v4" && !String(options.baseUrl ?? "").includes("mineru.net")) {
            options.baseUrl = "https://mineru.net";
          }
          if (value === "self-hosted" && String(options.baseUrl ?? "") === "https://mineru.net") {
            options.baseUrl = "http://127.0.0.1:8000";
          }
          void refreshTokenState();
        }));
    new Setting(this.containerEl)
      .setName("Base URL")
      .addText((text) => text
        .setValue(String(options.baseUrl ?? "https://mineru.net"))
        .onChange((value) => { options.baseUrl = value.trim(); }));
    tokenSetting = new Setting(this.containerEl)
      .setName("MinerU API Token")
      .addText((text) => {
        tokenInput = text.inputEl;
        text.inputEl.type = "password";
        text.setPlaceholder("输入新 Token").onChange((value) => {
          if (value !== SAVED_SECRET_MASK) tokenDrafts[currentProtocol()] = value;
        });
        text.inputEl.addEventListener("focus", () => {
          if (text.inputEl.value === SAVED_SECRET_MASK) text.inputEl.value = "";
        });
        text.inputEl.addEventListener("blur", () => {
          if (!tokenDrafts[currentProtocol()]) void refreshTokenState();
        });
      });
    await refreshTokenState();
    new Setting(this.containerEl)
      .setName("模型版本")
      .addDropdown((dropdown) => dropdown
        .addOption("vlm", "VLM")
        .addOption("pipeline", "Pipeline")
        .setValue(String(options.modelVersion ?? "vlm"))
        .onChange((value) => { options.modelVersion = value; }));
    new Setting(this.containerEl)
      .setName("解析语言")
      .addText((text) => text
        .setValue(String(options.language ?? "ch"))
        .onChange((value) => { options.language = value.trim() || "ch"; }));
    for (const [key, label] of [
      ["enableTable", "识别表格"],
      ["enableFormula", "识别公式"],
      ["isOcr", "启用 OCR"]
    ] as const) {
      new Setting(this.containerEl)
        .setName(label)
        .addToggle((toggle) => toggle
          .setValue(options[key] !== false)
          .onChange((value) => { options[key] = value; }));
    }
    new Setting(this.containerEl)
      .setName("MinerU 配置")
      .setDesc("默认 PDF.js 优先；只有 OCR_REQUIRED 或 QUALITY_GATE_FAILED 自动回退 MinerU。")
      .addButton((button) => button.setButtonText("保存").onClick(async () => {
        button.setDisabled(true);
        try {
          await persistCurrentToken(draft.enabled && currentProtocol() === "cloud-v4");
          await this.plugin.wiki.updateParsingProvider("mineru-http", draft);
          button.setButtonText("已保存");
        } catch (error) {
          button.setButtonText(error instanceof Error ? error.message : String(error));
        } finally {
          button.setDisabled(false);
        }
      }))
      .addButton((button) => button.setButtonText("测试连接").onClick(async () => {
        button.setDisabled(true).setButtonText("测试中…");
        try {
          await persistCurrentToken(currentProtocol() === "cloud-v4");
          await this.plugin.wiki.updateParsingProvider("mineru-http", draft);
          const result = await this.plugin.wiki.testParserConnection("mineru-http");
          button.setButtonText(result.message);
        } catch (error) {
          button.setButtonText(error instanceof Error ? error.message : String(error));
        } finally {
          button.setDisabled(false);
        }
      }));
  }

  private async renderMediaTranscription(): Promise<void> {
    new Setting(this.containerEl).setName("音视频解析").setHeading();
    if (!(await this.plugin.wiki.isInitialized())) {
      this.containerEl.createEl("p", { text: "初始化 T-Wiki 后可配置音视频转写。" });
      return;
    }
    const config = await this.plugin.wiki.loadConfig();
    const current = config.parsing.providers["media-transcription"] ?? {
      enabled: false,
      priority: 100,
      options: {}
    };
    const draft: ParserProviderConfig = structuredClone(current);
    const options = draft.options;
    const visual = options.visual && typeof options.visual === "object" && !Array.isArray(options.visual)
      ? options.visual as Record<string, unknown>
      : (options.visual = {}) as Record<string, unknown>;
    const vision = visual.vision && typeof visual.vision === "object" && !Array.isArray(visual.vision)
      ? visual.vision as Record<string, unknown>
      : (visual.vision = {}) as Record<string, unknown>;
    type Protocol = "openai-transcriptions" | "whisper-asr-webservice";
    let tokenDraft = "";
    let visionTokenDraft = "";
    const protocol = (): Protocol => options.protocol === "whisper-asr-webservice"
      ? "whisper-asr-webservice"
      : "openai-transcriptions";
    const secretId = (): string => protocol() === "openai-transcriptions"
      ? MEDIA_OPENAI_SECRET_ID
      : MEDIA_WHISPER_SECRET_ID;
    let transcriptionToggle: ToggleComponent | undefined;
    new Setting(this.containerEl)
      .setName("启用远程转写")
      .setDesc("音频和视频解析的总开关。媒体只会在每次任务再次确认后上传；导入本身不会自动发起远程请求。")
      .addToggle((toggle) => {
        transcriptionToggle = toggle;
        toggle.setValue(draft.enabled).onChange((value) => { draft.enabled = value; });
      });
    new Setting(this.containerEl)
      .setName("转写协议")
      .addDropdown((dropdown) => dropdown
        .addOption("openai-transcriptions", "OpenAI-compatible /audio/transcriptions")
        .addOption("whisper-asr-webservice", "Whisper ASR Webservice /asr")
        .setValue(protocol())
        .onChange((value) => {
          options.protocol = value;
          if (value === "openai-transcriptions") {
            options.baseUrl = "https://api.openai.com/v1";
            options.model = "gpt-4o-mini-transcribe";
            options.maxUploadBytes = 25 * 1024 * 1024;
          } else {
            options.baseUrl = "http://127.0.0.1:9000";
            options.model = "whisper-1";
            options.maxUploadBytes = 500 * 1024 * 1024;
          }
        }));
    new Setting(this.containerEl).setName("Base URL").addText((text) => text
      .setValue(String(options.baseUrl ?? "https://api.openai.com/v1"))
      .onChange((value) => { options.baseUrl = value.trim(); }));
    new Setting(this.containerEl).setName("API Token").setDesc("分别保存到协议专用 Secret Storage；自托管服务可留空。")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("已保存的 Token 不会回显").onChange((value) => { tokenDraft = value; });
      });
    new Setting(this.containerEl).setName("模型").addText((text) => text
      .setValue(String(options.model ?? "gpt-4o-mini-transcribe"))
      .onChange((value) => { options.model = value.trim(); }));
    new Setting(this.containerEl).setName("语言").setDesc("auto 表示自动识别。")
      .addText((text) => text.setValue(String(options.language ?? "auto"))
        .onChange((value) => { options.language = value.trim() || "auto"; }));
    new Setting(this.containerEl).setName("VAD 语音检测").addToggle((toggle) => toggle
      .setValue(options.vadFilter !== false).onChange((value) => { options.vadFilter = value; }));
    new Setting(this.containerEl).setName("说话人分离").addToggle((toggle) => toggle
      .setValue(options.diarization === true).onChange((value) => { options.diarization = value; }));
    new Setting(this.containerEl).setName("最大上传（MiB）").addText((text) => text
      .setValue(String(Math.round(Number(options.maxUploadBytes ?? 25 * 1024 * 1024) / 1024 / 1024)))
      .onChange((value) => { options.maxUploadBytes = boundedInteger(value, 25, 1, 500) * 1024 * 1024; }));
    new Setting(this.containerEl).setName("关键画面").setHeading();
    this.containerEl.createEl("p", {
      text: "仅本地视频使用。FFmpeg 在本机抽取候选帧；远程视觉服务只接收最长边 512px 的缩略图和前后 30 秒文字。视觉失败会发布纯文字稿。",
      cls: "llm-wiki-muted"
    });
    new Setting(this.containerEl)
      .setName("启用关键画面")
      .setDesc("启用后会同时开启远程转写总开关；每次视频任务仍需单独确认 ASR 与视觉上传。")
      .addToggle((toggle) => toggle.setValue(visual.enabled === true)
        .onChange((value) => {
          visual.enabled = value;
          if (value) {
            draft.enabled = true;
            transcriptionToggle?.setValue(true);
          }
        }));
    new Setting(this.containerEl)
      .setName("FFmpeg 路径")
      .setDesc("留空时从 PATH 查找；也可填写 ffmpeg 或 ffmpeg.exe 的绝对路径。FFprobe 应位于同目录或 PATH。")
      .addText((text) => text.setPlaceholder("例如 D:\\ffmpeg\\bin\\ffmpeg.exe")
        .setValue(String(visual.ffmpegPath ?? ""))
        .onChange((value) => { visual.ffmpegPath = value.trim(); }));
    new Setting(this.containerEl).setName("场景阈值").setDesc("0–1，越低候选越多。")
      .addText((text) => text.setValue(String(visual.sceneThreshold ?? 0.32))
        .onChange((value) => {
          const parsed = Number(value);
          if (Number.isFinite(parsed) && parsed > 0 && parsed < 1) visual.sceneThreshold = parsed;
        }));
    new Setting(this.containerEl).setName("每小时保留图片").setDesc("最终上限；每个视频最多 64 张。")
      .addText((text) => text.setValue(String(visual.selectedPerHour ?? 16))
        .onChange((value) => { visual.selectedPerHour = boundedInteger(value, 16, 1, 64); }));
    new Setting(this.containerEl).setName("视觉 Base URL")
      .addText((text) => text.setPlaceholder("https://host/v1")
        .setValue(String(vision.baseUrl ?? ""))
        .onChange((value) => { vision.baseUrl = value.trim(); }));
    new Setting(this.containerEl).setName("视觉 API Token").setDesc("保存到独立的 Obsidian Secret Storage。")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("已保存的 Token 不会回显")
          .onChange((value) => { visionTokenDraft = value; });
      });
    new Setting(this.containerEl).setName("视觉模型")
      .addText((text) => text.setPlaceholder("支持图片输入的模型 ID")
        .setValue(String(vision.model ?? ""))
        .onChange((value) => { vision.model = value.trim(); }));
    new Setting(this.containerEl).setName("视觉批大小").setDesc("每批最多 12 张缩略图。")
      .addText((text) => text.setValue(String(vision.batchSize ?? 12))
        .onChange((value) => { vision.batchSize = boundedInteger(value, 12, 1, 12); }));
    const persist = async (): Promise<void> => {
      if (tokenDraft.trim()) await this.plugin.secrets.set(secretId(), tokenDraft.trim());
      if (visionTokenDraft.trim()) await this.plugin.secrets.set(VIDEO_VISION_SECRET_ID, visionTokenDraft.trim());
      tokenDraft = "";
      visionTokenDraft = "";
      await this.plugin.wiki.updateParsingProvider("media-transcription", draft);
    };
    new Setting(this.containerEl)
      .setName("音视频转写配置")
      .setDesc("连接测试会上传插件生成的短静音 WAV，不会读取 Vault 内容。")
      .addButton((button) => button.setButtonText("保存").onClick(async () => {
        button.setDisabled(true);
        try {
          await persist();
          button.setButtonText(draft.enabled ? "已保存并启用" : "已保存（转写未启用）");
        }
        catch (error) { button.setButtonText(error instanceof Error ? error.message : String(error)); }
        finally { button.setDisabled(false); }
      }))
      .addButton((button) => button.setButtonText("测试连接").onClick(async () => {
        button.setDisabled(true).setButtonText("测试中…");
        try {
          await persist();
          const result = await this.plugin.wiki.testParserConnection("media-transcription");
          button.setButtonText(result.message);
        } catch (error) { button.setButtonText(error instanceof Error ? error.message : String(error)); }
        finally { button.setDisabled(false); }
      }));
    new Setting(this.containerEl)
      .setName("关键画面环境测试")
      .setDesc("FFmpeg 测试不读取 Vault；视觉测试上传插件生成的测试图片。")
      .addButton((button) => button.setButtonText("测试 FFmpeg").onClick(async () => {
        button.setDisabled(true).setButtonText("测试中…");
        try {
          await persist();
          const result = await this.plugin.wiki.testParserFfmpeg("media-transcription");
          button.setButtonText(result.ok ? "FFmpeg 可用" : result.message);
          new Notice(result.message);
        } catch (error) { button.setButtonText(error instanceof Error ? error.message : String(error)); }
        finally { button.setDisabled(false); }
      }))
      .addButton((button) => button.setButtonText("测试视觉连接").onClick(async () => {
        button.setDisabled(true).setButtonText("测试中…");
        try {
          await persist();
          const result = await this.plugin.wiki.testParserVisualConnection("media-transcription");
          button.setButtonText(result.message);
        } catch (error) { button.setButtonText(error instanceof Error ? error.message : String(error)); }
        finally { button.setDisabled(false); }
      }));
  }

  private renderModel(role: ModelProfile["role"]): void {
    const model = this.plugin.settings.agent.models.find((item) => item.role === role)!;
    new Setting(this.containerEl)
      .setName(role === "fast" ? "快速模型" : role === "deep" ? "深度模型" : "默认模型")
      .addText((text) => text
        .setPlaceholder("模型 ID")
        .setValue(model.id)
        .onChange(async (value) => {
          model.id = value.trim();
          await this.plugin.saveSettings();
        }))
      .addText((text) => text
        .setPlaceholder("显示名称")
        .setValue(model.label)
        .onChange(async (value) => {
          model.label = value.trim() || model.id;
          await this.plugin.saveSettings();
        }))
      .addText((text) => text
        .setPlaceholder("上下文长度")
        .setValue(String(model.contextWindow))
        .onChange(async (value) => {
          const parsed = Number(value);
          if (Number.isFinite(parsed) && parsed > 0) model.contextWindow = parsed;
          await this.plugin.saveSettings();
        }));
  }
}

function settingIndex(name: string, desc: string, aliases: string[]): SettingDefinitionItem {
  return { name, desc, aliases };
}
