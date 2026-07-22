# 3. Kiro 作为技术支持（Kiro as Technical Support）

本章展示如何把 **Kiro** 当成随身的 Managed Flink 排查助手：从"把日志丢给它"到"它帮你查、帮你改、帮你固化经验"。

## 3.1 Kiro 能做什么

| 能力 | 在排查中的用途 |
|------|----------------|
| 读取本地文件/日志 | 直接解析导出的 CloudWatch 日志（JSON/CSV），归纳错误 |
| 运行终端命令 | 帮你跑 `aws logs` / `aws kinesisanalyticsv2` CLI 拉日志、查配置 |
| 联网检索 | 查最新的错误代码、连接器参数、Flink 版本兼容性 |
| 写/改代码 | 直接修复 Flink 应用代码（异常处理、连接器参数、pom 依赖） |
| Steering | 把团队排查规范固化为长期上下文 |
| Hooks | 事件触发自动检查（如保存代码后跑 lint / 单测） |

## 3.2 推荐工作流（日志 → 修复闭环）

```
1. 复现/取证：让 Kiro 用 CLI 拉取问题时间窗的日志
2. 归因：把日志交给 Kiro，产出「症状-根因-验证-修复」
3. 验证：让 Kiro 跑对应的 Insights 查询或检查指标
4. 修复：让 Kiro 直接改代码/配置，并解释为何这样改
5. 固化：把这次经验写进 steering，形成团队知识库
```

### 用 Kiro 拉日志（示例对话）

> 你：`帮我拉取应用 order-enrichment 最近 30 分钟内所有 ERROR 日志，Region 是 ap-southeast-1`

Kiro 会构造并运行类似命令：

```bash
aws logs start-query \
  --log-group-name "/aws/kinesis-analytics/order-enrichment" \
  --start-time $(date -v-30M +%s) \
  --end-time $(date +%s) \
  --query-string 'fields @timestamp, message, logger | filter messageType = "ERROR" | sort @timestamp desc | limit 100'

# 然后用返回的 queryId 拉结果
aws logs get-query-results --query-id <queryId>
```

## 3.3 提示词模板（贴进 Kiro 聊天）

**排查一段日志：**
```
#File 04-demo/sample-logs/restart-loop.json
这是 Managed Flink 应用的 CloudWatch 日志。请：
1) 还原事件时间线；2) 给出 root cause；3) 指出要验证的指标；
4) 如果是代码问题，直接改 #File flink-app 里对应文件并解释。
```

**生成查询：**
```
基于 Managed Flink 固定 JSON 日志格式，写一条 Insights 查询：
统计每个 logger 的 ERROR 数量 Top 10，时间窗过去 6 小时。
```

## 3.4 用 Steering 固化排查规范

在 `.kiro/steering/` 下建一个 always-included 文件，让 Kiro 每次都带着团队排查经验。示例见：

- [.kiro/steering/flink-troubleshooting.md](.kiro/steering/flink-troubleshooting.md)（本资料已附样例）

这样当团队成员问"应用又重启了怎么办"，Kiro 会自动按你们的 runbook 顺序排查。

## 3.5 用 Hook 做自动化（可选）

例如：每当有人在本地修改 Flink 应用代码，自动提醒检查异常处理是否完善。

```json
{
  "name": "Flink Exception-Handling Check",
  "version": "1.0.0",
  "when": {
    "type": "fileEdited",
    "patterns": ["**/*.java", "**/*.py"]
  },
  "then": {
    "type": "askAgent",
    "prompt": "检查刚修改的 Flink 算子/UDF 是否对可重试异常做了处理，避免未捕获异常导致应用 failover 重启。列出风险点。"
  }
}
```

## 3.6 边界与最佳实践

- **敏感数据**：把日志给 Kiro 前先脱敏（Account ID、内网 IP、业务字段）。
- **生产操作**：Kiro 生成的高风险命令（改生产配置、删资源）需人工确认后再执行。
- **可复现**：让 Kiro 把每次排查过程记录成 markdown，沉淀为 runbook。
