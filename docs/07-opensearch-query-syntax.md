# 7. 查询语法介绍：CloudWatch Logs Insights QL 与 OpenSearch PPL / SQL

> CloudWatch Logs Insights 现在支持 **三种查询语言**：
> 1. **Logs Insights QL**（默认语法，`fields | filter | stats`，本章 7.1 系统介绍）
> 2. **OpenSearch PPL**（Piped Processing Language，Unix 管道风格）
> 3. **OpenSearch SQL**（熟悉关系型数据库的人首选）
>
> 本章先介绍 **Logs Insights QL 的语法规则**（第 2、4 章的查询都基于它），再介绍
> **OpenSearch 语法支持的背景与能力**，最后用 **PPL 和 SQL** 查询同一批 Managed Flink 日志。
> 字段沿用固定 JSON schema：
> `messageType`、`message`、`logger`、`applicationARN`、`@timestamp`、`@message`、`@logStream`。

## 7.0 怎么切换查询语言

- **控制台**：CloudWatch → Logs Insights → 查询编辑器上方的**语言下拉框**选择
  `OpenSearch PPL` 或 `OpenSearch SQL`（默认是 Logs Insights QL），再选 log group。
- **CLI/API**：`start-query` 时通过 `--query-language` 指定（`CWLI` | `PPL` | `SQL`），
  PPL/SQL 里可用 `SOURCE` / `FROM` 指定 log group（`SOURCE`/`filterIndex` 仅 CLI/API 支持）。

---

## 7.1 CloudWatch Logs Insights QL 语法介绍

这是 CloudWatch 原生的查询语言，也是第 2、4 章所有查询用的语法。核心思想：**用 `|` 把命令串成流水线**，每个命令处理上一步的输出。

### 基本结构

```text
fields <要显示的字段>
| filter <过滤条件>
| stats <聚合函数> by <分组字段>
| sort <字段> desc/asc
| limit <行数>
```

### 常用命令速查

| 命令 | 作用 | 例子 |
|------|------|------|
| `fields` | 选择要显示的字段 | `fields @timestamp, messageType, message` |
| `filter` | 过滤（支持 `=`、`like`、正则、`and`/`or`/`not`） | `filter messageType = "ERROR"` |
| `stats` | 聚合统计（`count`、`sum`、`avg`、`min`、`max` 等） | `stats count(*) as errors by logger` |
| `sort` | 排序 | `sort @timestamp desc` |
| `limit` | 限制返回行数 | `limit 20` |
| `parse` | 从文本抽取临时字段（glob 或正则） | `parse message "default, *" as @parallelism` |
| `dedup` | 按字段去重 | `dedup logger` |
| `display` | 只显示指定字段（覆盖 fields） | `display @timestamp, message` |
| `bin(时间)` | 按时间桶聚合，配合 stats 看趋势 | `stats count(*) by bin(5m)` |

### 语法要点

- **内置字段以 `@` 开头**：`@timestamp`（投递时间）、`@message`（原始记录全文）、`@logStream`、`@log`。KDA 日志的顶层 JSON 字段（`messageType`、`logger` 等）自动发现，直接引用即可。
- **模糊匹配**用 `like`，两种写法：`filter message like "AccessDenied"`（子串）或 `filter message like /RESTARTING|FAILED/`（正则，`/` 包裹）。
- **嵌套 JSON** 用点号访问，如 `field.subfield`；带特殊字符的字段用反引号包裹。
- **正则抽取**：`parse message /country=(?<country>[^ ]+)/` 可以把非结构化正文变成可聚合的字段。
- 一条查询**最多 10000 行结果**；默认按扫描量计费，务必先缩小时间窗。

### 一条典型查询（按 logger 统计错误）

```text
fields @timestamp, message, logger
| filter messageType = "ERROR"
| stats count(*) as errors by logger
| sort errors desc
| limit 10
```

---

## 7.2 OpenSearch 语法支持：背景与能力

2024 年 11 月起，CloudWatch Logs Insights 原生集成了 **OpenSearch 的两种查询语言**（PPL 和 SQL），三种语言查询**同一批数据**，无需把日志导出到 OpenSearch 集群，也不额外收费（仍按 Insights 扫描量计费）。

**这对排查 KDA 日志意味着什么：**

- **零迁移成本**：日志还在 CloudWatch Logs 里，只是多了两种查询方式。团队里有人熟 Splunk/管道式分析（→ PPL）、有人熟数据库（→ SQL），可以各用各的。
- **能力增强**：PPL 提供 `top`/`rare`/`dedup`/`eventstats`/`trendline` 等 QL 没有的分析命令；SQL 支持 `JOIN`（跨 log group 关联）、子查询、`HAVING`、`CASE/IF` 条件分类等复杂分析。
- **AI 友好**：主流大模型对 SQL 的生成准确率高，让 Kiro/AI 生成 SQL 查日志往往比生成 QL 更稳（第 6 章的 MCP 自然语言查询底层也可指定语言）。

**注意边界：**

- PPL/SQL 仅支持**查询已有字段**，不支持 Insights QL 的 `pattern`、`diff` 等专有命令。
- `SOURCE`（PPL）/`filterIndex` 只在 CLI/API 生效；控制台里通过界面选 log group。
- 每种语言支持的函数集见文末"Supported SQL and PPL commands"官方文档。

---

## 7.3 OpenSearch PPL（管道风格）

思路和 Logs Insights QL 很像，都是 `|` 串联，但命令集更丰富（`top`、`rare`、`dedup`、`eventstats`、`trendline` 等）。

### 常用命令速查

| 命令 | 作用 | 例子 |
|------|------|------|
| `fields` | 选择列 | `fields @timestamp, messageType, message` |
| `where` | 过滤 | `where messageType = "ERROR"` |
| `stats` | 聚合 | `stats count() by logger` |
| `sort` | 排序（`-` 降序） | `sort -@timestamp` |
| `head` | 限制行数 | `head 20` |
| `parse` | 正则抽取字段 | `parse message ".*country=(?<country>[^ ]+).*"` |
| `top` / `rare` | 最频繁/最少见 | `top 5 logger` |
| `dedup` | 去重 | `dedup logger` |
| `eval` | 计算新列 | `eval level = upper(messageType)` |

### 场景化 PPL 查询（KDA 日志）

**最近的错误（对应场景 1 重启）**
```ppl
fields @timestamp, messageType, message
| where messageType = "ERROR"
| sort -@timestamp
| head 25
```

**抓重启 / 任务失败**
```ppl
fields @timestamp, message
| where like(message, '%RESTARTING%') OR like(message, '%FAILED%') OR like(message, '%Exception%')
| sort -@timestamp
| head 100
```

**按 logger 统计错误数（Top 10）**
```ppl
where messageType = "ERROR"
| stats count() as errors by logger
| sort -errors
| head 10
```

**权限错误**
```ppl
fields @timestamp, message
| where like(message, '%AccessDenied%')
| sort -@timestamp
```

**从异常消息里抽取业务字段（我们 demo 的 country）**
```ppl
fields @timestamp, message
| where like(message, '%enrichment error%')
| parse message ".*country=(?<country>[^ ]+).*"
| stats count() as hits by country
| sort -hits
```

**源端限流 / 反压**
```ppl
fields @timestamp, message
| where like(message, '%ProvisionedThroughputExceeded%') OR like(message, '%Backing off%')
| sort -@timestamp
| head 100
```

---

## 7.4 OpenSearch SQL（关系型风格）

用 `SELECT ... FROM <logGroup> WHERE ... GROUP BY ... ORDER BY ...`。
`FROM` 后接 log group 名（控制台里选好 log group 后可用别名/反引号）。

### 场景化 SQL 查询（KDA 日志）

> 下面把 log group 记作 `` `kda_demo` ``，实际用时替换为
> `` `/aws/kinesis-analytics/kda-troubleshooting-demo` `` 或控制台选定的表名。

**最近的错误**
```sql
SELECT `@timestamp`, messageType, message
FROM `kda_demo`
WHERE messageType = 'ERROR'
ORDER BY `@timestamp` DESC
LIMIT 25
```

**抓重启 / 任务失败**
```sql
SELECT `@timestamp`, message
FROM `kda_demo`
WHERE message LIKE '%RESTARTING%'
   OR message LIKE '%FAILED%'
   OR message LIKE '%Exception%'
ORDER BY `@timestamp` DESC
LIMIT 100
```

**按 logger 统计错误数，并只看超过阈值的**
```sql
SELECT logger, COUNT(*) AS errors
FROM `kda_demo`
WHERE messageType = 'ERROR'
GROUP BY logger
HAVING errors > 5
ORDER BY errors DESC
```

**每个 log stream 的日志量**
```sql
SELECT `@logStream`, COUNT(*) AS log_count
FROM `kda_demo`
GROUP BY `@logStream`
ORDER BY log_count DESC
```

**条件分类（把错误标成 High/Low）**
```sql
SELECT messageType,
       IF(messageType = 'ERROR', 'High', 'Low') AS severity,
       message
FROM `kda_demo`
ORDER BY `@timestamp` DESC
LIMIT 50
```

**权限错误**
```sql
SELECT `@timestamp`, message
FROM `kda_demo`
WHERE message LIKE '%AccessDenied%'
ORDER BY `@timestamp` DESC
```

---

## 7.5 三种语言对照（同一个需求）

需求：**过去时间窗内，按 logger 统计 ERROR 数量，取 Top 10**

```text
# Logs Insights QL
fields @timestamp, message, logger
| filter messageType = "ERROR"
| stats count(*) as errors by logger
| sort errors desc
| limit 10
```

```ppl
# OpenSearch PPL
where messageType = "ERROR"
| stats count() as errors by logger
| sort -errors
| head 10
```

```sql
-- OpenSearch SQL
SELECT logger, COUNT(*) AS errors
FROM `kda_demo`
WHERE messageType = 'ERROR'
GROUP BY logger
ORDER BY errors DESC
LIMIT 10
```

## 7.6 选型建议

- **PPL**：习惯管道/日志分析工具（Splunk、OpenSearch Observability）的人上手最快，命令最丰富。
- **SQL**：习惯数据库、要做 JOIN/子查询/复杂聚合的人首选。可跨 log group JOIN、关联分析。
- **Logs Insights QL**：AWS 老用户的默认，文档示例最多（本资料第 4 章）。
- 三者可按查询切换，结果一致；建议团队统一一种主语言 + 会读另外两种。

## 7.7 小贴士

- 字段名带特殊字符（`@timestamp`、`@logStream`）在 SQL 里用**反引号**包裹。
- PPL 的字符串包含匹配用 `like(field, '%kw%')`；SQL 用 `field LIKE '%kw%'`。
- 大范围扫描按扫描量计费：**缩小时间窗**、给高频字段建**字段索引**（`filterIndex`/`aws:fieldIndex`）可显著降本提速。
- `SOURCE`（PPL）和 `filterIndex` 只在 CLI/API 生效，控制台里用界面选 log group。

## 参考

- [Analyzing log data with CloudWatch Logs Insights（三语言总览）](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/AnalyzingLogData.html)
- [CloudWatch Logs Insights QL 语法参考](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CWL_QuerySyntax.html)
- [OpenSearch PPL in CloudWatch Logs](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CWL_AnalyzeLogData_PPL.html)
- [OpenSearch SQL in CloudWatch Logs](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CWL_AnalyzeLogData_SQL.html)
- [Supported SQL and PPL commands](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/direct-query-supported-commands.html)

> 内容已根据许可要求做改写整理（Content was rephrased for compliance with licensing restrictions）。
