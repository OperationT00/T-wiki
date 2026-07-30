# 音视频解析架构

音视频模块只负责把公开字幕或语音转写结果转换为可追溯的 canonical raw Markdown，不改变后续 Ingest、Review 和 Apply。

```text
Bilibili URL / 抖音 URL / 本地音视频
  -> Source acquisition
  -> ObjectStore（原件或确定性字幕包）
  -> bilibili-caption / media-transcription
  -> TimedTranscript
  -> TranscriptMarkdownBuilder
  -> raw/audio 或 raw/videos
```

本地视频以及抖音下载后的本地原件，在 `media-transcription@1.1.1` 中可以继续执行可选的图文流水线：

```text
TimedTranscript
  -> 本机 FFprobe / FFmpeg 场景抽帧
  -> 黑屏、模糊、重复与过密候选过滤
  -> OpenAI-compatible Vision（512px 缩略图 + 前后 30 秒文字）
  -> MediaTimelineComposer
  -> raw/videos/*.md + raw/assets/<sourceId>/*.webp
```

视觉模型只判断画面是否值得保留，并生成客观标题与描述；知识总结仍由 Ingest 完成。默认每小时最多保留 16 张、单视频最多 64 张。视觉服务、FFmpeg 或画面筛选失败时，Parser 发布纯文字稿并写入 `VIDEO_VISUAL_SKIPPED` warning。

## 安全边界

- Bilibili 只访问允许的官方页面、API 与 CDN HTTPS 域名，不读取 Cookie。
- 抖音 Connector 只接受官方 HTTPS 单视频链接，通过用户安装的 yt-dlp 下载到受控临时目录；输出经过路径、大小、魔数和 FFprobe 视频流校验后才进入 ObjectStore。
- 抖音默认无 Cookie。只有 yt-dlp 明确报告登录/风控时，UI 才允许用户为当前任务授权一次 `--cookies-from-browser`；Cookie 不进入插件配置、Manifest 或日志。
- 有公开字幕时不调用 ASR；只有明确的 `NO_CAPTION_TRACK` 才显示转写回退。
- 本地媒体和 Bilibili 音轨每次远程上传前都显示协议、Base URL、模型和文件信息，授权只保存在当前操作内存。
- OpenAI-compatible 远程地址必须使用 HTTPS；loopback 自托管服务可以使用 HTTP。
- Token 分协议保存在 Obsidian Secret Storage，不写入配置、Manifest、raw 或日志。
- 视觉 Token 使用独立 Secret ID；候选缩略图、视觉响应正文和临时视频不进入审计文件。
- FFmpeg 由用户安装，插件通过参数数组直接启动进程，不经过 Shell；取消、超时和插件卸载都会终止进程并清理 Session 临时目录。

## 扩展点

- `TranscriptionTransport` 隔离 OpenAI-compatible 与 Whisper ASR Webservice 协议。
- `TimedTranscript` 是所有字幕/ASR Provider 的统一结果。
- `TranscriptMarkdownBuilder` 负责确定性分段、时间链接和质量 warning。
- `VideoFrameExtractor`、`FrameSelectionProvider` 与 `VideoVisualPipeline` 分离本地抽帧、远程判断和宿主筛选。
- `MediaTimelineComposer` 只把已经验证的截图插入对应转写段落；资产仍由统一 RawPublisher 发布并由 RawVerifier 校验 Hash。
- 新 Provider 只需实现 `TranscriptionTransport`；无需修改 RawPublisher 或 Ingest。
