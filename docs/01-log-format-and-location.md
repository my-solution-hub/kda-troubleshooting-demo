# 1. 日志格式与位置（Log Format & Location）

## 1.1 日志投递到哪里

Managed Flink 应用启用 CloudWatch logging option 后，运行时日志会写入 CloudWatch Logs：

- **Log group**：通常命名为 `/aws/kinesis-analytics/<application-name>`（也可在创建时自定义）。
- **Log stream**：一般形如 `kinesis-analytics-log-stream`。
- **关键特征**：Job Manager 和**所有** Task Manager 的日志都写入**同一个 log stream**。因此在多并行度场景下，同一时刻会交错出现来自不同节点的日志，排查时要善用字段过滤。

在控制台定位：
1. Managed Flink 应用页 → **Monitoring / Configuration** 标签，可看到关联的 log group 链接。
2. 或直接进 CloudWatch → **Log groups** → 搜 `kinesis-analytics`。

用 CLI 查看应用的日志配置：

```bash
aws kinesisanalyticsv2 describe-application \
  --application-name YourApplication \
  --query 'ApplicationDetail.CloudWatchLoggingOptionDescriptions'
```

## 1.2 日志是固定 JSON 格式

日志由服务托管，格式固定，**无法自定义 JSON 结构**（应用代码只能控制 `message` 内容和日志级别）。一条典型日志：

```json
{
  "locationInformation": "com.amazonaws.services.managed-flink.StreamingJob.main(StreamingJob.java:95)",
  "logger": "com.amazonaws.services.managed-flink.StreamingJob",
  "message": "This message will be written to the application's CloudWatch log",
  "threadName": "Flink-DispatcherRestEndpoint-thread-2",
  "applicationARN": "arn:aws:kinesisanalytics:us-east-1:123456789012:application/test",
  "applicationVersionId": "1",
  "messageSchemaVersion": "1",
  "messageType": "INFO"
}
```

### 字段说明

| 字段 | 含义 | 排查用途 |
|------|------|----------|
| `messageType` | 日志级别：`INFO` / `WARN` / `ERROR` / `DEBUG` | 过滤错误：`filter messageType = "ERROR"` |
| `message` | 实际日志正文（异常栈、状态变更等都在这里） | 关键词匹配的主要字段 |
| `logger` | 产生日志的 logger 类名 | 定位来源组件，如 `PythonDriver`、连接器类 |
| `locationInformation` | 代码位置（类.方法(文件:行)） | 快速定位代码行 |
| `threadName` | 线程名 | 区分 JM/TM、连接器线程 |
| `applicationARN` | 应用 ARN | 多应用共用日志时按应用过滤 |
| `applicationVersionId` | 应用版本 | 判断问题是否在某次更新后出现 |
| `messageSchemaVersion` | 日志 schema 版本，目前为 `"1"` | — |

> 注意：CloudWatch Logs Insights 中，顶层字段可直接用 `messageType`、`message` 引用；`@message` 表示整条原始记录，`@timestamp` 为投递时间。

## 1.3 日志级别（Log Level）与监控级别（Monitoring Level）

这是两个**不同**的概念，客户经常混淆：

### 日志级别（Logging level）
控制写入多少详细度的日志，作用于所有 logger（服务级统一设置，不支持 per-package）：
- 可选 `DEBUG` / `INFO` / `WARN` / `ERROR`。
- 生产环境建议 `INFO` 或 `WARN`；排查疑难问题时临时开 `DEBUG`，排查完调回，避免成本与吞吐影响。

### 监控指标级别（Monitoring metrics level）
控制 CloudWatch **指标**（不是日志）的粒度，从粗到细：
- `Application`（默认）→ `Task` → `Operator` → `Parallelism`
- 报告当前级别及以上所有级别（如设为 `Operator`，则同时报告 Application/Task/Operator）。
- **`Parallelism` 级别不建议用于 Parallelism > 64 的应用**，会产生过高成本。

CLI 更新监控配置示例：

```bash
aws kinesisanalyticsv2 update-application \
  --application-name YourApplication \
  --current-application-version-id 3 \
  --application-configuration-update '{
    "FlinkApplicationConfigurationUpdate": {
      "MonitoringConfigurationUpdate": {
        "ConfigurationTypeUpdate": "CUSTOM",
        "LogLevelUpdate": "DEBUG",
        "MetricsLevelUpdate": "TASK"
      }
    }
  }'
```

## 1.4 应用可以写自定义日志吗？

可以。Java/Scala 用 **Log4j** 或 **SLF4J**，Python 用 `logging` 包或 `print()`：

```java
// Java: SLF4J
private static final Logger log = LoggerFactory.getLogger(YourApplicationClass.class);
log.info("Custom message to CloudWatch");   // 建议用 INFO 级别，便于过滤
```

```python
# Python UDF 内写日志
import logging

@udf(input_types=[DataTypes.BIGINT()], result_type=DataTypes.BIGINT())
def doNothingUdf(i):
    logging.info("Got {} in the doNothingUdf".format(str(i)))
    return i
```

> **性能提示**：Flink 为高吞吐低延迟优化，日志子系统不是。**不要对每条消息都打日志**。若确需逐条记录，应在应用里另开一条 DataStream，用专门的 sink 写到 S3 或 CloudWatch。自定义日志建议只在开发阶段使用。

## 1.5 Python 应用的日志特点

- `main` 方法里 `print()` 的内容会进日志。
- UDF 里用 `logging` 包写的内容会进日志。
- `main` 抛出的异常会带 `Python Process Started/Exited` 边界和完整 Traceback，例如：

```text
--------------------------- Python Process Started --------------------------
Traceback (most recent call last):
  File ".../PythonUdfUndeclared.py", line 54, in main
    table_env.register_function("doNothingUdf", doNothingUdf)
NameError: name 'doNothingUdf' is not defined
--------------------------- Python Process Exited ---------------------------
Run python process failed
```

- 查 Python 入口日志的 Insights 查询：

```
fields @timestamp, message
| sort @timestamp asc
| filter logger like /PythonDriver/
| limit 1000
```

## 小结

排查前先确认三件事：**日志在哪个 log group / stream** → **日志级别是否够（必要时开 DEBUG）** → **用哪些字段过滤（`messageType` / `message` / `logger`）**。
