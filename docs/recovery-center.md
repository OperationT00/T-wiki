# 恢复中心

恢复中心不维护新的事实状态。它只聚合现有耐久记录：

```text
Transaction Journal  -> Wiki 写入与回滚
Pending Plan         -> 待审核 Diff
ParseAttempt         -> 解析、Raw 发布和重试
Media Checkpoint     -> 音视频分片进度
Manifest             -> 单个来源生命周期
```

## 行为

- 启动时继续执行原有事务恢复和 Pending Plan 恢复。
- 工作台“恢复”页面重新扫描上述记录，按错误、警告和信息排序。
- 损坏事务保留主日志、恢复副本和 fault 记录；系统不会自动删除未知事务。
- `pendingRevision` 只在 Raw 与资产重新通过 Hash 校验后提交到 Manifest。
- 媒体继续任务必须重新确认远程上传；清理断点不会删除 ObjectStore 原件。
- 损坏 Pending Plan 只有在用户确认后才会删除，并把 `awaiting_review` 来源重置为可重新 Ingest。

## 诊断隐私

导出的诊断位于 `.llm-wiki/diagnostics/`，仅包含恢复元数据。Raw、Wiki、Prompt、媒体分片和模型响应不会写入诊断；Token、URL 查询参数和本机绝对路径会被脱敏。
