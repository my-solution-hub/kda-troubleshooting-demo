# Amazon Managed Service for Apache Flink（原 KDA）故障排查学习资料

> 面向客户的一套动手学习材料：如何用 CloudWatch Logs 排查 Managed Flink（Kinesis Data Analytics for Apache Flink）应用问题，并结合 AI / Kiro 提升排查效率。

## 背景与术语

- **KDA**：Kinesis Data Analytics。其中"KDA for Apache Flink"已更名为 **Amazon Managed Service for Apache Flink (MSF)**。本资料统称 **Managed Flink**。
- Managed Flink 是全托管的 Apache Flink 运行环境，服务负责 Job Manager / Task Manager 的调度、扩缩容、checkpoint/snapshot 备份等。
- 应用日志由服务托管，以**固定 JSON 格式**统一投递到 CloudWatch Logs（Job Manager 与所有 Task Manager 写入同一个 log stream）。

### Job Manager / Task Manager 是干什么的

Flink 集群只有两种角色，可以拿"包工头 + 施工队"类比：

| | Job Manager（JM）· 包工头，1 个 | Task Manager（TM）· 施工队，N 个 |
|---|---|---|
| 职责 | **协调管理**，不算数据 | **实际处理数据**的工作进程 |
| 干什么 | 把作业拆成子任务并派发到 TM；跟踪任务状态、监控 TM 心跳；触发 checkpoint；任务失败时决定重启策略 | 跑算子逻辑（map/filter/window/UDF）；提供 task slot（并行度越高需要越多）；管理本地内存与网络缓冲；持有算子 state 并在 checkpoint 时上传 |
| 日志里的典型输出 | `Job xxx switched from state RUNNING to RESTARTING`、checkpoint 协调、调度信息 | UDF 异常栈、数据处理错误、`TimeoutException` / heartbeat 相关 |

在 Managed Flink 中这两种角色**完全由服务托管**：你只管代码、并行度和 KPU 数量（1 KPU ≈ 1 vCPU + 4GB 内存），JM/TM 的创建、调度、替换和 checkpoint 存储都不用操心。

**排查时的关键点**：JM 和所有 TM 写**同一个 log stream**，看日志要靠 `threadName` / `logger` 分辨说话的是"包工头"（调度、重启、checkpoint）还是"施工队"（算子异常、UDF 报错）。

## 学习目标

学完这套资料，客户应能够：

1. 说清 Managed Flink 日志的**格式、字段含义与位置**，会在控制台/CLI 找到 log group 与 log stream。
2. 针对常见故障场景，用 **CloudWatch Logs Insights** 查询定位根因，掌握 Insights QL 基本语法。
3. 了解 CloudWatch Logs 的 **OpenSearch 语法支持**（PPL / SQL），按团队背景选择合适的查询语言。
4. 用 **AI（Amazon Q / Bedrock / Kiro / AWS DevOps Agent）** 辅助解读日志、生成查询、归纳根因。
5. 把 **Kiro 当作技术支持助手**，从日志 → 假设 → 验证 → 修复形成闭环。
6. 独立完成一次端到端 **Demo**。

## 目录

| 章节 | 文件 | 内容 |
|------|------|------|
| 1. 日志格式与位置 | [01-log-format-and-location.md](01-log-format-and-location.md) | JSON schema、字段、log group/stream、日志级别、监控级别 |
| 2. 场景分析 - 结合 AI | [02-scenarios-analysis-with-ai.md](02-scenarios-analysis-with-ai.md) | 6 大高频故障场景 + Insights 查询 + AI 提示词 |
| 3. Kiro 作为技术支持 | [03-kiro-as-technical-support.md](03-kiro-as-technical-support.md) | 工作流、提示词模板、可自动化的 hooks/steering |
| 4. Demo | [04-demo/](04-demo/) | 样本日志、Insights 查询、CLI 脚本，以及可一键部署的 CDK 应用（[04-demo/cdk/](04-demo/cdk/)） |
| 5. 端到端验证流程 | [05-validated-test-runbook.md](05-validated-test-runbook.md) | Demo D 在 us-east-1 的真实验证过程、结果、踩坑与彩排 checklist |
| 6. CloudWatch MCP 自然语言查询 | [06-cloudwatch-mcp-natural-language.md](06-cloudwatch-mcp-natural-language.md) | 配置 CloudWatch MCP，用人话查日志/指标，免背语法 |
| 7. 查询语法介绍（QL / PPL / SQL） | [07-opensearch-query-syntax.md](07-opensearch-query-syntax.md) | CloudWatch Logs Insights QL 语法介绍 + OpenSearch PPL / SQL 语法介绍与三语言对照 |

## AI 排查工具怎么选：Kiro / CloudWatch MCP / AWS DevOps Agent

三者定位不同，可以叠加使用：

| 工具 | 定位 | 适合的场景 |
|------|------|-----------|
| **Kiro + CloudWatch MCP**（第 3、6 章） | 交互式排查助手：你提问、它查日志拉指标、还能直接改代码修复 | 开发调试阶段、需要"排查 → 改代码 → 验证"闭环 |
| **AWS DevOps Agent**（2026 年 3 月 GA） | **自主排查 Agent**：7×24 自动接收告警并展开调查，关联指标、日志与应用拓扑，产出根因分析和缓解建议 | 生产环境值守：CloudWatch 告警（如 `fullRestarts` 突增）自动触发调查，人还没上线它已给出根因候选 |
| **Amazon Q / Bedrock** | 通用 AI：解读异常栈、生成查询语句 | 把脱敏日志片段粘进去做一次性分析 |

DevOps Agent 与本资料的结合点：把第 2 章的六大场景对应的 CloudWatch 告警（`fullRestarts`、`downtime`、`millisBehindLatest` 等）接入 DevOps Agent 的自动调查触发，再用 **Skills** 把第 5 章沉淀的 runbook 编码进去，让 Agent 按团队验证过的排查步骤执行；调查结论可回流 Slack / ServiceNow。剩下的"改代码修复"环节交给 Kiro。

## 建议的授课节奏（约 90 分钟）

1. 概念 + 日志格式（15 min）
2. 定位日志、跑第一条 Insights 查询（15 min）
3. 场景演练：重启风暴 / 反压 / 权限 / 资源不足（30 min）
4. AI + Kiro 辅助排查（20 min）
5. Q&A（10 min）

## 参考来源

- [Logging in Managed Service for Apache Flink](https://docs.aws.amazon.com/managed-flink/latest/java/logging.html)
- [Analyze logs with CloudWatch Logs Insights](https://docs.aws.amazon.com/managed-flink/latest/java/cloudwatch-logs-reading.html)
- [Write custom messages to CloudWatch Logs](https://docs.aws.amazon.com/managed-flink/latest/java/cloudwatch-logs-writing.html)
- [Application is restarting（排查文档）](https://docs.aws.amazon.com/managed-flink/latest/java/troubleshooting-rt-restarts.html)
- [Troubleshoot why a MSF application restarts (re:Post)](https://repost.aws/knowledge-center/msaf-restart)
- [AWS DevOps Agent 正式可用公告](https://aws.amazon.com/blogs/mt/announcing-general-availability-of-aws-devops-agent/)
- [DevOps Agent Incident Response（用户指南）](https://docs.aws.amazon.com/devopsagent/latest/userguide/devops-agent-incident-response.html)

> 内容已根据许可要求做改写整理（Content was rephrased for compliance with licensing restrictions）。
