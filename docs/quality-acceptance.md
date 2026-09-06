# 固定质量与性能验收

0.1.7 引入可重复的验收协议，用于回答“这次优化是否真的更快、更准”。它不是线上遥测，也不会自动上传数据。

## 两层验证

1. `npm run verify` 执行确定性单元与集成测试，验证指标计算、P50/P95、缺失样本失败和 Agent Trace 转换。
2. `npm run acceptance` 读取同一组固定场景的本机实测样本，生成可比较的 JSON 报告。

固定场景和阈值位于 `acceptance/suite-v1.json`。首版覆盖：

- 常规与增量 Ingest；
- Index 直接命中与两跳 Query；
- 混合文件批量 Parse 与崩溃恢复；
- 音视频重叠消解、段落可读性和时间轴。

每个场景至少运行 5 次。少于最小样本数、缺少指标、非有限数值或重复运行 ID 都会失败，避免用单次偶然结果宣称通过。

## 运行

把本机观察值保存为下列结构：

```json
{
  "schemaVersion": 1,
  "suiteId": "t-wiki-core-v1",
  "samples": [
    {
      "schemaVersion": 1,
      "scenarioId": "query-direct-index",
      "runId": "query-direct-001",
      "recordedAt": "2026-09-06T10:00:00.000Z",
      "origin": "manual-review",
      "metrics": {
        "durationMs": 42000,
        "relevantPageRecall": 1,
        "citationAccuracy": 1,
        "unsupportedClaimRate": 0,
        "wikiReads": 3
      }
    }
  ]
}
```

然后运行：

```bash
npm run acceptance -- --input .llm-wiki-acceptance/observations.json --output .llm-wiki-acceptance/report.json
```

全部场景通过时退出码为 0；阈值不通过或样本不足时退出码为 1；缺少命令参数时退出码为 2。

## 指标边界

Agent 审计可以自动提供耗时、Provider 请求数、Token、重复读取、候选完成度、Wiki 精读和图谱跳数。候选召回率、答案相关性、无依据结论率和段落可读性需要根据固定答案人工或由独立评审标注，不能从“流程成功”推断。

验收样本和报告只允许保存：场景 ID、运行 ID、时间和数值指标。不要写入 Prompt、回答、Raw/Wiki 正文、文件路径、Base URL、Token 或媒体内容。真实模型结果具有服务和网络波动，应在同一模型、同一机器和相近网络条件下比较两个版本。
