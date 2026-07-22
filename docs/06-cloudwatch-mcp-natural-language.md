# 6. 用 CloudWatch MCP 做自然语言查询（无需背语法）

> 目标：让客户**不用记 Logs Insights / PPL / SQL 语法**，直接用中文/英文自然语言向 Kiro 提问，
> 由 Kiro 通过 **AWS CloudWatch MCP Server** 自动调用 CloudWatch API 完成查询、分析、归因。

## 6.1 它解决什么问题

传统排查要求会员工：记住字段名、写对 Insights 查询、手动跑指标、来回切控制台。
接入 CloudWatch MCP 后，客户只需要说人话：

> "帮我看看 kda-troubleshooting-demo 这个应用最近 15 分钟为什么一直重启"

Kiro 会自动：定位 log group → 分析错误模式 → 拉 `fullRestarts`/`downtime` 指标 → 给出根因和建议。

## 6.2 已完成的配置

已在 `~/.kiro/settings/mcp.json` 增加 `cloudwatch` server（其余配置未改动）：

```jsonc
{
  "mcpServers": {
    "cloudwatch": {
      "command": "uvx",
      "args": ["awslabs.cloudwatch-mcp-server@latest"],
      "env": {
        "AWS_PROFILE": "default",
        "AWS_REGION": "us-east-1",
        "FASTMCP_LOG_LEVEL": "ERROR"
      },
      "disabled": false,
      "autoApprove": [
        "describe_log_groups",
        "analyze_log_group",
        "execute_log_insights_query",
        "get_logs_insights_query_results",
        "get_metric_data",
        "get_metric_metadata",
        "analyze_metric"
      ]
    }
  }
}
```

前置条件：
- 已安装 `uv` / `uvx`（本机 `/opt/homebrew/bin/uvx`，版本 0.10.9）。
- default profile 有读取 CloudWatch Logs/Metrics 的权限。
- 首次启动会下载依赖（botocore/pandas/scipy 等，较大），耐心等或提前预热缓存：
  `uv tool install awslabs.cloudwatch-mcp-server`

> 改了 mcp.json 后，在 Kiro 的 MCP Server 面板点击重连，或重启 Kiro，即可加载 `cloudwatch` 工具。

## 6.3 CloudWatch MCP 提供的能力（任务导向）

| 类别 | 工具 | 用途 |
|------|------|------|
| 日志 | `describe_log_groups` | 发现/列出 log group |
| 日志 | `analyze_log_group` | 在时间窗内分析异常、消息模式、错误模式 |
| 日志 | `execute_log_insights_query` / `get_logs_insights_query_results` | 跑 Logs Insights 查询并取结果 |
| 指标 | `get_metric_data` | 取任意指标数据（支持百分位、数学表达式、批量） |
| 指标 | `get_metric_metadata` | 指标的含义与推荐统计量 |
| 指标 | `analyze_metric` | 分析趋势、季节性、统计特征 |
| 告警 | `get_recommended_metric_alarms` | 按最佳实践推荐告警阈值 |

> 注意：MCP 工具名以实际连接后 Kiro 面板显示为准；`autoApprove` 里写的是只读类工具，写操作不自动批准。

## 6.4 自然语言提问示例（直接说给 Kiro）

**排查重启（对应 Demo D）**
```
kda-troubleshooting-demo（us-east-1）最近 15 分钟一直重启，帮我找根因，
看看日志里的异常和 fullRestarts 指标。
```

**统计错误分布**
```
过去 1 小时，/aws/kinesis-analytics/kda-troubleshooting-demo 这个 log group 里
ERROR 最多的是哪几类？按出现次数排序。
```

**关联指标与日志**
```
这个 Flink 应用的 downtime 从什么时候开始变大？那个时间点前后日志里有什么异常？
```

**权限类问题**
```
帮我查这个应用有没有 AccessDenied 或 ResourceNotFound 的报错。
```

**性能/反压**
```
看看 millisBehindLatest 有没有持续升高，日志里有没有 ProvisionedThroughputExceeded。
```

## 6.5 推荐话术模板（给客户培训用）

> 结构：**目标应用 + 区域 + 时间窗 + 想知道什么**

- "应用 `<name>`，区域 `<region>`，最近 `<N>` 分钟，`<症状>`，帮我定位根因并给修复建议。"
- "把这段时间的错误按 `<维度>` 聚合，告诉我 Top N。"
- "对比 `<指标A>` 和日志异常的时间线，判断谁先发生。"

## 6.6 MCP vs 手写查询：怎么选

| 场景 | 推荐方式 |
|------|----------|
| 探索式排查、不确定查什么 | **MCP 自然语言**（第 6 章） |
| 固定的、要反复跑的查询 | 存成 Logs Insights 查询（第 4 章 queries 集） |
| 团队里熟 SQL/PPL 的成员做深度分析 | **OpenSearch SQL/PPL**（第 7 章） |
| 需要脱敏后给外部 LLM | 先导出脱敏，再用第 2 章的提示词模板 |

## 6.7 安全与成本提示

- MCP 只在本机运行，用的是 default profile 的凭证 —— 权限即凭证权限，建议用只读角色。
- `analyze_log_group` / Insights 查询会**扫描日志产生费用**，缩小时间窗、用字段索引可降本。
- 自动批准（autoApprove）只放只读工具；涉及创建告警等写操作时让 Kiro 先征求确认。
