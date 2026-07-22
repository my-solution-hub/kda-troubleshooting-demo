# 2. 场景分析 — 结合 AI（Scenarios Analysis using AI）

本章把高频故障场景整理成"**症状 → 日志特征 → Insights 查询 → 根因 → 修复**"的模式，并给出可直接喂给 AI（Amazon Q / Bedrock / Kiro）的**提示词模板**。

> 所有查询中请替换 `{{us-west-2}}`（Region）、`{{012345678901}}`（Account ID）、`{{YourApplication}}`（应用名）。

## 2.0 排查心法：先指标，后日志

- **指标**告诉你"有没有病、病在哪一层"：`fullRestarts`、`downtime`、`numberOfFailedCheckpoints`、`lastCheckpointDuration`、`cpuUtilization`、`heapMemoryUtilization`、`millisBehindLatest`、`numRecordsOutPerSecond`。
- **日志**告诉你"为什么病"：异常栈、状态变更、连接器报错。
- 标准动作：指标发现异常时间窗 → 到该时间窗内查日志。

---

## 场景 1：应用反复重启（Restart Storm）

**症状**：`fullRestarts` > 0 且持续增长；`downtime` > 0；处理停滞。

**日志特征**：状态从 `RUNNING` → `RESTARTING` / `FAILED`；伴随未捕获异常（如 `NullPointerException`、`ClassCastException`）。

**Insights 查询（task-related failures）**：

```
fields @timestamp, @message
| filter applicationARN like /arn:aws:kinesisanalytics{{us-west-2}}:{{012345678901}}:application\/{{YourApplication}}/
| filter @message like /RESTARTING|FAILED|Exception/
| sort @timestamp desc
| limit 200
```

**常见根因**：
- 算子里抛出未处理异常 → 从最近 checkpoint 恢复（保证 exactly-once），表现为周期性 downtime。修复：对可重试异常做处理。
- Kinesis 源/汇未正确预置：检查 `ReadProvisionedThroughputExceeded` / `WriteProvisionedThroughputExceeded`，需增加 shard。
- 依赖的外部 source/sink 限流或不可用。

---

## 场景 2：Task Manager 崩溃 / 心跳超时

**症状**：重启，且日志出现连接/心跳类异常。

**日志特征**（关键词）：

```
java.util.concurrent.TimeoutException: The heartbeat of JobManager with id xxx timed out
org.apache.flink.util.FlinkException: The assigned slot xxx was removed
org.apache.flink.runtime.io.network.netty.exception.RemoteTransportException: Connection unexpectedly closed by remote task manager
```

**Insights 查询**：

```
fields @timestamp, @message
| filter @message like /TimeoutException|FlinkException|RemoteTransportException|heartbeat/
| sort @timestamp desc
| limit 200
```

**根因/修复**：TM 受 CPU/内存压力而失败。检查 `cpuUtilization`、`heapMemoryUtilization` 是否有尖峰；排查吞吐瓶颈；检查代码未处理异常。必要时提升并行度/KPU 或优化算子。

---

## 场景 3：网络缓冲区不足（Insufficient network buffers）

**日志特征**：

```
java.io.IOException: Insufficient number of network buffers
```

**根因**：network buffer 数量随并行度和 job graph 复杂度线性增长，内存不够。

**修复**：
- 降低 `parallelismPerKpu`（每个 subtask 分到更多内存），但会增加 KPU 与成本；可同比降低 parallelism 保持 KPU 不变。
- 简化 job graph（减少算子/减少 shuffle）。

---

## 场景 4：权限错误（Access Denied）

**症状**：应用起不来或读写失败。

**Insights 查询**：

```
fields @timestamp, @message, @messageType
| filter applicationARN like /arn:aws:kinesisanalytics{{us-west-2}}:{{012345678901}}:application\/{{YourApplication}}/
| filter @message like /AccessDenied/
| sort @timestamp desc
```

**根因/修复**：应用的 IAM 服务角色缺少权限（如访问 Kinesis / S3 / CloudWatch `PutMetricData`）。核对信任关系（`kinesisanalytics.amazonaws.com`）与资源级权限。

---

## 场景 5：源/汇资源不存在（ResourceNotFound）

**Insights 查询**：

```
fields @timestamp, @message
| filter applicationARN like /arn:aws:kinesisanalytics{{us-west-2}}:{{012345678901}}:application\/{{YourApplication}}/
| filter @message like /ResourceNotFoundException/
| sort @timestamp desc
```

**根因/修复**：Kinesis 源/汇 stream 名称或 Region 配置错误、stream 被删除。核对 runtime properties 中的资源名与 Region。

---

## 场景 6：性能问题 / 源端反压与限流

**症状**：`millisBehindLatest` 高或持续升高（Kinesis 源），吞吐下降。

**根因**：Flink Kinesis 连接器默认 `GetRecords` 每次抓取记录数很激进，容易触发源端限流（`ReadProvisionedThroughputExceeded`）。

**修复**：调低连接器 `SHARD_GETRECORDS_MAX`、调整 `SHARD_GETRECORDS_INTERVAL_MILLIS`；或给 stream 扩 shard。检查算子并行度分布是否均衡（数据倾斜）。

**运维类查询 — 任务分布 / 并行度变化**：

```
# 任务在各 Task Manager 的分布（把时间窗对准一次 job run）
fields @timestamp, message
| filter message like /Deploying/
| parse message " to flink-taskmanager-*" as @tmid
| stats count(*) by @tmid
| sort @timestamp desc
| limit 2000
```

```
# 并行度变化（自动扩缩容或手动调整）
fields @timestamp, @parallelism
| filter message like /property: parallelism.default, /
| parse message "default, *" as @parallelism
| sort @timestamp asc
```

---

## 2.7 用 AI 辅助分析：提示词模板

把日志片段脱敏后交给 AI，能显著加速"读栈 → 归因 → 给方案"。以下模板可直接用于 Amazon Q、Bedrock 或 Kiro。

### 模板 A：解读异常栈

```
你是 Apache Flink 与 AWS Managed Flink 的排查专家。
下面是我从 CloudWatch Logs 导出的日志（JSON，字段含 messageType/message/logger/threadName）。
请：
1) 用一句话概括发生了什么；
2) 指出最可能的根因（区分：应用代码 / 资源预置 / 权限 / 配置 / 平台）；
3) 给出可验证根因的下一步（要看哪个指标、跑哪条 Insights 查询）；
4) 给出修复建议，并标注是否需要重启或重置 state。
日志：
<粘贴日志>
```

### 模板 B：让 AI 生成 Insights 查询

```
基于 Managed Flink 固定 JSON 日志格式（顶层字段 messageType、message、logger、applicationARN），
帮我写一条 CloudWatch Logs Insights 查询：
目标：<例如：统计过去 3 小时内每 5 分钟的 ERROR 数量，并按 logger 分组>
要求：使用 stats/bin，按时间排序，limit 合理。
```

### 模板 C：根因归纳（多条日志聚合）

```
这是同一时间窗内的多条日志。请按时间线还原事件因果链，
输出格式：时间 -> 事件 -> 影响。最后给出"最可能的初始触发点(root cause)"。
```

### 使用 AI 的注意事项
- **脱敏**：去掉 Account ID、ARN、内网地址、业务数据后再喂给外部模型。
- **给足上下文**：附上应用语言（Java/Python）、Flink 版本、并行度/KPU、source/sink 类型。
- **交叉验证**：AI 给出的根因要用指标或再查一次日志验证，别直接照搬到生产。
- 优先用 **Bedrock（数据不出账户边界可控）** 或 **Amazon Q Developer** 处理敏感日志。

## 场景速查表

| 关键词 / 症状 | 最可能方向 | 先看指标 |
|---------------|-----------|----------|
| `RESTARTING` / `FAILED` / `Exception` | 应用代码未处理异常 | `fullRestarts`, `downtime` |
| `heartbeat ... timed out` / `slot was removed` | TM 资源压力 | `cpu`, `heapMemory` |
| `Insufficient number of network buffers` | 内存/并行度配置 | `heapMemory`, parallelism |
| `AccessDenied` | IAM 权限 | — |
| `ResourceNotFoundException` | source/sink 配置错误 | — |
| `millisBehindLatest` 高 | 源端反压/限流/数据倾斜 | `millisBehindLatest`, 吞吐 |
| checkpoint 失败 | 状态过大 / 后端慢 / 超时 | `numberOfFailedCheckpoints`, `lastCheckpointDuration` |
