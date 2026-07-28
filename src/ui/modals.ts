import { Modal, Notice, Setting } from "obsidian";

import { DEFAULT_CONFIG, sha256 } from "../core/wiki-core";
import type {
  IngestCoverageReport,
  KnowledgeDecision,
  RollbackPreview,
  SourceDeletionPreview,
  WikiChangePlan,
  WikiConfig
} from "../types";
import type LLMWikiPlugin from "../main";

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

  constructor(private readonly plugin: LLMWikiPlugin) {
    super(plugin.app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "抓取网页" });
    contentEl.createEl("p", {
      text: "公开网页会直接提取为 canonical Markdown；登录、动态或受保护页面请使用浏览器 Web Clipper。",
      cls: "llm-wiki-muted"
    });
    let url = "";
    const status = contentEl.createEl("p", { text: "等待输入网页地址", cls: "llm-wiki-muted" });
    let directButton: import("obsidian").ButtonComponent | undefined;
    let browserButton: import("obsidian").ButtonComponent | undefined;
    new Setting(contentEl)
      .setName("网页地址")
      .addText((text) => text
        .setPlaceholder("https://example.com/article")
        .onChange((value) => { url = value.trim(); }));
    new Setting(contentEl)
      .addButton((button) => {
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
      })
      .addButton((button) => {
        directButton = button;
        button.setCta().setButtonText("直接抓取").onClick(async () => {
          directButton?.setDisabled(true);
          browserButton?.setDisabled(true);
          this.controller = new AbortController();
          try {
            const result = await this.plugin.captureUrl(
              url,
              this.controller.signal,
              (phase) => status.setText(phase === "download"
                ? "正在下载网页 HTML…"
                : phase === "parse"
                  ? "HTML 已保存，正在解析并发布 Markdown…"
                  : "网页抓取完成")
            );
            new Notice(result.duplicate ? "网页内容已存在，已复用原素材" : "网页已抓取并生成 raw Markdown");
            this.plugin.settings.activeTab = "materials";
            await this.plugin.saveSettings();
            await this.plugin.refreshView();
            this.close();
          } catch (error) {
            status.setText(`${error instanceof Error ? error.message : String(error)}。可改用“在浏览器中采集”。`);
            directButton?.setDisabled(false);
            browserButton?.setDisabled(false);
          }
        });
      });
  }

  onClose(): void {
    this.controller?.abort();
    this.contentEl.empty();
  }
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
        button.setWarning().setButtonText("永久删除").setDisabled(true).onClick(async () => {
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
  if (decision.targetPath) card.createEl("div", { text: decision.targetPath, cls: "llm-wiki-muted" });
  card.createEl("p", { text: decision.reason });
  card.createEl("div", {
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

export function summarizePlan(plan: WikiChangePlan): string {
  return `${plan.summary} · ${plan.operations.length} 个文件 · ${sha256(JSON.stringify(plan)).slice(0, 8)}`;
}
