# T-Wiki for Obsidian

T-Wiki 是一个桌面端 Obsidian 插件，用于把文档、网页和剪藏内容整理成结构化、可追溯、相互链接的 Markdown Wiki。

项目地址：[OperationT00/T-wiki](https://github.com/OperationT00/T-wiki)

## 功能简介

- 导入 Markdown、TXT、文本型 PDF、本地音视频、公开网页、Bilibili 和抖音公开视频
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
- **Bilibili**：在“解析在线视频”中输入 BV/AV/b23 地址。优先读取公开作者字幕或平台 AI 字幕；没有字幕时才提供远程语音转写选项。
- **抖音**：先安装 [yt-dlp](https://github.com/yt-dlp/yt-dlp)，然后在“在线视频 / 抖音”中自动检测或填写 `yt-dlp.exe` 路径并启用。通过“解析在线视频”输入公开单视频链接；插件会在确认后下载视频并复用 ASR、FFmpeg 和视觉解析。默认不读取浏览器 Cookie，只有抖音明确要求登录时才会请求一次性授权。
- **音视频转写**：在“音视频解析”中选择 OpenAI-compatible `/audio/transcriptions` 或自托管 Whisper ASR Webservice `/asr`。默认由 FFmpeg 提取 16 kHz 单声道音频并按 15 分钟分片顺序转写；网络中断后可在 24 小时内继续，已完成分片不会重复上传。每次开始或恢复远程上传都需要单独确认。
- **视频关键画面**：可在“音视频解析 → 关键画面”中启用。先配置共用的 FFmpeg/FFprobe，再填写独立的 OpenAI-compatible 视觉 Base URL、Token 和图片模型。插件合并场景抽帧与周期抽帧，只上传 512px 缩略图及其前后 30 秒文字；部分视觉批次失败时仍保留其他成功截图。
- **音视频智能标题**：ASR 完成后，插件会调用 Agent 的快速模型，根据代表性文字稿生成简短的内容标题，并按“作者 ID - 内容简述”命名新 raw 文档。没有平台作者 ID 时使用作者名，本地文件回退为 `local`；模型失败只会回退到来源标题，不影响解析结果发布。

### 4. 导入并生成 Wiki

1. 在“素材”页选择文件、抓取网页、解析 Bilibili/抖音视频，或扫描 Clipper Inbox。音视频处理前请核对远程上传目标。
2. 等待解析完成，并按需查看 Markdown 预览和质量报告。
3. 点击“开始 Ingest”。
4. Agent 会读取来源、比较已有 Wiki，并生成新增或更新建议。
5. 在 Diff 中审阅变更，确认后写入 Wiki。
6. 在“智能”页面提问，或继续导入其他资料。

## 权限与隐私

- 默认文档与 Wiki 操作只访问当前 Vault；Clipper 仅扫描配置的 Inbox，索引仅遍历 `raw/` 和 `wiki/`。
- FFmpeg、FFprobe 和 yt-dlp 是可选桌面能力，仅在用户启用并主动发起音视频任务时以参数数组执行，不会向 LLM 暴露 Shell。
- LLM、MinerU、ASR 和视觉服务可能接收相关正文或媒体；Token 仅保存到 Obsidian Secret Storage，远程媒体上传按任务确认。
- 详细的安全边界见 [SECURITY.md](SECURITY.md)。

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
