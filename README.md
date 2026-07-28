# T-Wiki for Obsidian

T-Wiki 是桌面端 Obsidian 插件，通过内置 TypeScript Agent Runtime 和用户配置的 LLM API，把原始资料持续编译成结构化、可追溯、互相链接的 Markdown Wiki。

项目主页：[OperationT00/T-wiki](https://github.com/OperationT00/T-wiki)

## 当前能力

- 初始化空 Vault，或备份并迁移旧版 LLM Wiki
- 导入 MD、TXT、文本型 PDF，或输入公开网页 URL，确定性解析为统一 Markdown 后发布到 `raw/`
- 原件按 SHA-256 保存到 `.llm-wiki/objects/`，解析 revision 与 Ingest attempt 独立追踪
- Parser 显式注册并支持本地/远程 Provider；新增格式不需要修改解析编排、发布或 Ingest
- Web Clipper Inbox 可自动监听或手动扫描，新笔记只 Parse 到 raw，不自动 Ingest
- 内置网页抓取使用 Defuddle 提取公开 HTML；动态、登录和反爬页面可一键转到浏览器 Web Clipper
- MinerU 支持 Cloud v4 与自托管 mineru-api；PDF.js 遇到 OCR/质量失败时可受控回退
- raw schema v3 只保留系统 frontmatter 和干净正文，不插入 block/page marker
- PDF 恢复页面顺序、行、段落和标题；扫描型页面明确进入 `needs_ocr`
- 确定性 Schema、双链、孤立页和索引检查
- 内置 Agent Runtime，支持 Anthropic Messages 与 OpenAI-compatible Chat Completions
- 自定义 Base URL、结构化输出模式、模型映射和 Secret Storage
- 领域型多轮 Wiki Agent：按需搜索、分段阅读、沿 WikiLink 探索并在内存 WorkingSet 中修正
- Ingest 强制完成 Entity、Concept、Synthesis 三类知识比对，并提交可审计的 created/updated/already-covered/source-only/insufficient-evidence 覆盖报告
- Ingest、Query、Chat、Save、Lint fix 与统一 slash command
- 素材卡片使用“导入 → 解析 → 吸收 → 审阅 → 写入”统一 Pipeline；Parse 显示真实页级进度，Ingest 显示 Agent 阶段、轮数、工具数、耗时和可折叠活动时间线
- Agent Run 的累计 Token 预算与模型单轮 context window 分离；默认 Ingest 预算适合长文多轮检索和知识合并，并可在设置页独立调整
- Session 级 ContextMemory、LRU 读取缓存和 fast-model Checkpoint；50% 压缩、80% 激进压缩、90% 明确容量失败
- Wiki 默认 outline → section 精细读取，WorkingSet 正文引用化，避免每轮重复发送全文和 Diff
- Evidence Ledger、结构化工具调用、逐文件 Diff 审阅、事务写入和失败回滚

## 开发

```powershell
npm.cmd install
npm.cmd run verify
```

生产构建产物写入：

```text
dist/
```

开发监听默认写入 `../.obsidian/plugins/t-wiki`，也可以通过 `T_WIKI_DEV_PLUGIN_DIR` 指定测试 Vault 的插件目录：

```powershell
$env:T_WIKI_DEV_PLUGIN_DIR="D:\path\to\vault\.obsidian\plugins\t-wiki"
npm.cmd run dev
```

一次性安装生产构建到测试 Vault：

```powershell
npm.cmd run build:dev-install
```

在 Obsidian 中重载应用后，从左侧书本图标或命令面板打开 `T-Wiki: 打开工作台`。

## 使用

1. 打开工作台，选择“初始化 LLM Wiki”。v1 Wiki 会备份并迁移原件；解析框架 v2 会原子升级配置和 Manifest，不重解析现有 raw。
2. 在设置的“Agent Runtime / LLM API”中选择协议，填写 Base URL、Token 和模型；如需 Web Clipper 或 MinerU，再启用对应配置。
3. 在“素材”页上传文件、输入网页 URL 或扫描 Clipper Inbox，等待 Parse 完成，预览 Markdown/质量报告后开始 Ingest。
4. 先审阅按 Entity、Concept、Synthesis 分组的知识覆盖报告，再逐文件选择变更。Source 页面不可取消；其他知识变更可取消并记录为人工排除，接受后插件才写入 `wiki/`。
5. 在“查询”或“Agent”页使用 Wiki 上下文回答，并可保存为 Output/Synthesis。

## 安全边界

- API Token 只写入 Obsidian Secret Storage。
- Agent 没有 Shell、任意文件、联网或真实 Vault 写入工具；只有受控的 raw/Wiki 读取与内存暂存工具。
- Ingest 会把 canonical raw Markdown 和检索到的 Wiki 上下文发送到配置的 LLM API。
- Agent 只能在 WorkingSet 暂存 `wiki/*.md` create/update；`raw/`、`wiki/index.md`、`wiki/log.md`、删除和路径穿越在暂存前拒绝。
- 原件按 hash 进入不可变对象库；`raw/` 只保存可校验的规范 Markdown 和引用资源。

## 解析配置

`llm-wiki.config.json` v3 的 `parsing.providers` 按 Parser ID 配置 `enabled`、`priority` 和独立 `options`。PDF 页数、text item、布局及扫描页阈值位于 `pdfjs-layout.options`。密钥禁止写入 Provider options，只能进入 Obsidian Secret Storage。检测到扫描页时不会发布缺页 Markdown，也不会调用 Agent。

`mineru-http` 默认关闭、优先级低于 `pdfjs-layout`。启用后只有本地 PDF.js 返回 `OCR_REQUIRED` 或 `QUALITY_GATE_FAILED` 才自动发送原件；也可在素材卡片上手动选择 MinerU。Cloud Token 和可选的自托管 Token 分别保存在 Secret Storage，任务 ID 可作为不含凭据的 resume token 在重启后继续轮询。

`webpage-defuddle` 默认启用，只处理 URL 采集得到的 HTML 原件。抓取器不执行 JavaScript、不携带 Cookie、不访问内网地址；原始 HTML 进入 ObjectStore，Defuddle 仅在本地生成 Markdown。图片保留远程 URL。正文为空或遇到验证码/访问拦截时不发布 raw，素材页会提示改用浏览器 Web Clipper。

新 Parser 实现 `DocumentParser`、options validator 和测试后，在 `parsing/default-parser-registry.ts` 注册即可；远程 Provider 可通过 resume token 恢复任务，但 token 不得携带鉴权信息。

## 解析框架

```text
SourceConnector
├─ FilePickerConnector
├─ UrlCaptureConnector → SafeWebPageFetcher
└─ WebClipperInboxConnector
        ↓
ParsingFacade
├─ IntakeService
├─ ParseOrchestrator
│  ├─ ParserRegistry
│  │  ├─ PDF.js
│  │  ├─ Defuddle HTML
│  │  └─ MinerU HTTP（Cloud / Self-hosted）
│  ├─ ArtifactBuilder / Normalizer
│  └─ RawPublisher
├─ RawVerifier
└─ IngestPreparationService

Storage
├─ ObjectStore
├─ ManifestRepository
└─ SourceMapStore（仅兼容历史 raw v2）
```

Parser 和 Orchestrator 依赖 `parsing/ports.ts` 中的端口，不依赖 Obsidian API；`DataAdapter` 只出现在 Facade、存储和 raw infrastructure 层。`ParsePayload.markdown` 是唯一正文事实源。块级来源映射、citation 和 PDF bbox 跳转作为后续能力保留；历史 raw v2 的 Source Map 仍可校验和 Ingest。

## Agent Runtime

```text
AgentCommandRegistry
→ WorkflowService
→ AgentLoop / ContextMemory / ContextManager
→ EmbeddedAgentRuntime
   └─ Anthropic Messages / OpenAI Chat Completions
→ ToolPolicy / ToolRegistry
   ├─ verified raw / Wiki search-read-link
   ├─ Session ToolResultCache
   ├─ EvidenceLedger
   └─ WorkingSet create-edit-validate
→ submit_changes
→ 宿主构建 WikiChangePlan
→ Core 本地校验 → Diff → Transaction Apply
```

第一轮强制 Tool Calling；只读安全工具可以并行，暂存与终止工具严格串行。Ingest 的暂存变更必须绑定本轮真实读取过的证据，并在 `submit_changes` 时覆盖全部来源、已读章节及 Entity/Concept/Synthesis 三类评估。模型不能直接提交 operations JSON，也不能写 Vault；`submit_changes` 只冻结 WorkingSet，Plan 由宿主确定性构建。`search_raw`/`search_wiki` 支持 lexical、exact、all_terms、any_terms，但不开放 grep、任意正则或任意 Vault 路径。Wiki 阅读默认返回 outline，按 section 精确取正文。旧工具轮次在 50% 模型窗口后按完整协议轮次压缩为可校验证据的 Checkpoint，读取缓存只存在于当前 Session 内存。设置页“连接测试”会验证真实 Tool Call 与 Tool Result 续轮，不支持原生 Tool Calling 的服务不会降级为 Prompt 模拟。

工作台支持 `/ingest`、`/query`、`/save`、`/lint`、`/reindex` 与 `/agent` 命令。Agent Run 的脱敏摘要保存在 `.llm-wiki/agent-runs/`，不保存 raw/Wiki 正文或 Token。
