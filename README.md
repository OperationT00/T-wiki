# T-Wiki for Obsidian

T-Wiki 是一个桌面端 Obsidian 插件，用于把文档、网页和剪藏内容整理成结构化、可追溯、相互链接的 Markdown Wiki。

项目地址：[OperationT00/T-wiki](https://github.com/OperationT00/T-wiki)

## 功能简介

- 导入 Markdown、TXT、文本型 PDF 和公开网页
- 将不同来源统一解析为干净的 `raw/` Markdown
- 使用 PDF.js 本地解析 PDF，并可选用 MinerU 处理扫描件或复杂 PDF
- 使用用户配置的 LLM API 提取、比较和合并知识
- 自动创建或更新 Source、Entity、Concept 和 Synthesis 页面
- 自动维护 WikiLink、索引和知识图谱关系
- 支持 Diff 审阅，确认后才写入 `wiki/`
- 支持基于 Wiki 索引和链接图谱的多跳查询
- 原件、解析记录和 Agent 操作均可追溯

T-Wiki 不要求安装 Claude Code。Agent Runtime 已内置在插件中，但需要用户自行提供兼容的 LLM API。

## 使用说明

### 1. 安装与初始化

从 Obsidian 社区插件中搜索 **T-Wiki** 并安装。也可以从 [GitHub Releases](https://github.com/OperationT00/T-wiki/releases) 下载 `main.js`、`manifest.json` 和 `styles.css`，放入：

```text
<Vault>/.obsidian/plugins/t-wiki/
```

启用插件后，打开 T-Wiki 工作台，点击“初始化 T-Wiki”。插件会创建 `raw/`、`wiki/`、`templates/` 和内部数据目录。

### 2. 配置 LLM API

进入 Obsidian 设置 → T-Wiki → **Agent Runtime / LLM API**：

1. 选择 `Anthropic Messages` 或 `OpenAI-compatible` 协议。
2. 填写服务的 Base URL 和 API Token。
3. 配置 Fast、Default、Deep 三档模型；不需要区分时可填写同一个模型。
4. 点击“测试连接”。

兼容服务需要支持原生 Tool Calling。API Token 只保存在 Obsidian Secret Storage，不会写入 Wiki 或插件配置文件。

Ingest 和 Query 会把相关的 raw Markdown 与 Wiki 上下文发送到所配置的 LLM API，请根据资料的隐私要求选择服务。

### 3. 配置文档解析

默认情况下无需额外配置：

- Markdown：保留正文并规范化格式
- TXT：支持 UTF-8 和带 BOM 的 UTF-16
- PDF：优先使用本地 PDF.js 解析
- 网页：输入公开 URL 后在本地提取正文

可选功能：

- **MinerU**：在设置的“文档解析 / MinerU”中选择 Cloud 或自托管服务，填写 Token 后启用。扫描型或复杂 PDF 可自动回退到 MinerU，也可以手动选择“使用 MinerU 重新解析”。启用远程 MinerU 会上传 PDF 原件。
- **Web Clipper Inbox**：配置 Obsidian Web Clipper 的保存目录后，T-Wiki 可以扫描其中的新 Markdown。导入后只生成 raw，不会自动执行 Ingest。

### 4. 导入并生成 Wiki

1. 在“素材”页选择文件、抓取网页或扫描 Clipper Inbox。
2. 等待解析完成，并按需查看 Markdown 预览和质量报告。
3. 点击“开始 Ingest”。
4. Agent 会读取来源、比较已有 Wiki，并生成新增或更新建议。
5. 在 Diff 中审阅变更，确认后写入 Wiki。
6. 在“智能”页面提问，或继续导入其他资料。

## 常用命令

以下 Slash Command 可在 T-Wiki 的 Agent/智能输入框中使用：

| 命令 | 作用 |
|---|---|
| `/query <问题>` | 查询 Wiki |
| `/query <问题> --deep` | 深度查询，并允许回溯 raw |
| `/query <问题> --scope wiki\|raw\|hybrid` | 指定查询范围 |
| `/save [内容]` | 将内容或最近回答保存为 Wiki 页面 |
| `/save --type output\|synthesis` | 指定保存页面类型 |
| `/lint` | 检查 Wiki 健康状态 |
| `/lint --fix` | 生成可审阅的修复建议 |
| `/reindex` | 重建 Wiki 索引 |
| `/agent status` | 查看当前 Agent 状态 |
| `/agent cancel` | 取消当前 Agent 任务 |

Ingest 通常直接在“素材”页操作；也支持以下命令：

| 命令 | 作用 |
|---|---|
| `/ingest scan` | 查看可处理来源 |
| `/ingest process <sourceId或raw路径>` | 处理单个来源 |
| `/ingest batch <来源1> <来源2> ...` | 批量处理 1–5 个来源 |
| `/ingest status [sourceId]` | 查看 Ingest 状态 |
| `/ingest retry <sourceId或raw路径>` | 重试失败的 Ingest |

开发者常用命令：

```powershell
npm.cmd install
npm.cmd run verify
npm.cmd run build
```
