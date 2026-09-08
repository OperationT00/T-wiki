# 安全与权限模型

[English](SECURITY.md) | [简体中文](SECURITY.zh-CN.md)

T-Wiki 是一款仅支持桌面端的插件。默认的文档与 Wiki 操作使用 Obsidian 的 Vault/DataAdapter API，并限制在当前活动 Vault 内。

## 桌面端扩展能力

以下两个可选媒体功能需要使用 Obsidian 标记为高风险的能力：

- Node.js 文件系统访问仅用于操作系统临时目录、媒体流式暂存、可执行文件发现，以及向基于内容寻址的 `.llm-wiki/objects/` 对象存储流式写入大文件。对象存储路径根据当前 Vault 的 DataAdapter 基础路径构建、规范化，并在打开原生文件流前确认目标仍位于 Vault 内；无法获取本地基础路径时，插件会使用 Obsidian DataAdapter。临时路径在使用前会被解析和校验，并在任务成功、失败、取消或超时后清理。
- 只有用户启用 FFmpeg/FFprobe 或 yt-dlp 功能时，插件才会启动本地进程。插件使用 `spawn(executable, args)` 调用程序，并设置 `shell: false`；URL 和路径均作为独立参数传入。插件不会向 LLM 提供 Shell 工具。

只有相关功能已经配置且由用户主动发起时，插件才会使用这些能力。远程 ASR、视觉模型、MinerU 和 LLM 请求会展示或说明目标服务，并要求用户配置相应凭据。Token 保存在 Obsidian Secret Storage 中，并从诊断信息中脱敏。

恢复诊断只会在用户明确操作后生成。它们仅包含恢复类型、ID、时间、数量和经过脱敏的错误摘要；不会保存 Raw/Wiki 正文、Prompt、媒体分片、访问令牌、URL 查询参数或本机绝对路径。

质量验收观察和报告仅作为本地开发产物保存。其 Schema 只接受场景或运行标识、时间、来源和数值指标；`.llm-wiki-acceptance/` 已被 Git 忽略。不得将 Prompt、回答、来源正文、媒体、本机路径、服务 URL 或凭据写入验收文件。

## Vault 访问边界

- Web Clipper 只扫描用户配置的 Inbox 目录。
- Wiki 索引和 Lint 只遍历配置中的 `wiki/` 与 `raw/`，不会扫描整个 Vault。
- Agent Tool 只接受来源 ID 或经过校验的 Wiki 路径；不能读取任意 Vault 路径，也不能直接写入 `raw/`。
- 可见文件删除使用 Obsidian 的回收站 API。内部原子暂存与回滚数据保存在配置的 `.llm-wiki/` 数据目录。

如需报告安全问题，请通过 GitHub Security Advisory 私下联系仓库所有者。
