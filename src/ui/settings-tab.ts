import { Notice, PluginSettingTab, Setting } from "obsidian";

import LLMWikiPlugin, {
  MINERU_CLOUD_SECRET_ID,
  MINERU_SELF_HOSTED_SECRET_ID
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

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName("T-Wiki 设置")
      .setHeading();

    this.renderAgentSettings();

    new Setting(containerEl)
      .setName("模型映射")
      .setHeading();
    for (const role of ["fast", "default", "deep"] as const) this.renderModel(role);

    this.renderAgentBudgets();

    this.renderWebClipper();
    void this.renderMinerU();

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
      .setDesc("相对于 Vault 根目录，不能与 raw、wiki、.llm-wiki 或 .obsidian 重叠。")
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
