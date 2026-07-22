# CloudWatch Logs Insights 查询集（可直接粘贴）

> 替换 `{{us-west-2}}` / `{{012345678901}}` / `{{YourApplication}}`。

## 0. 确认有数据（最近 20 条）

```
fields @timestamp, messageType, logger, message
| sort @timestamp desc
| limit 20
```

## 1. 只看错误，按 logger 分组统计

```
fields @timestamp, message, logger
| filter messageType = "ERROR"
| stats count(*) as errors by logger
| sort errors desc
| limit 10
```

## 2. 应用重启 / task 失败（Restart Storm）

```
fields @timestamp, @message
| filter applicationARN like /arn:aws:kinesisanalytics{{us-west-2}}:{{012345678901}}:application\/{{YourApplication}}/
| filter @message like /RESTARTING|FAILED|Exception/
| sort @timestamp desc
| limit 200
```

## 3. TM 崩溃 / 心跳超时

```
fields @timestamp, @message
| filter @message like /TimeoutException|FlinkException|RemoteTransportException|heartbeat/
| sort @timestamp desc
| limit 200
```

## 4. 权限错误

```
fields @timestamp, @message, @messageType
| filter applicationARN like /arn:aws:kinesisanalytics{{us-west-2}}:{{012345678901}}:application\/{{YourApplication}}/
| filter @message like /AccessDenied/
| sort @timestamp desc
```

## 5. 源/汇不存在

```
fields @timestamp, @message
| filter applicationARN like /arn:aws:kinesisanalytics{{us-west-2}}:{{012345678901}}:application\/{{YourApplication}}/
| filter @message like /ResourceNotFoundException/
| sort @timestamp desc
```

## 6. 源端限流 / 反压

```
fields @timestamp, message, threadName
| filter message like /ProvisionedThroughputExceeded|millisBehindLatest|Backing off/
| sort @timestamp desc
| limit 200
```

## 7. 任务在各 Task Manager 的分布（查数据倾斜）

```
fields @timestamp, message
| filter message like /Deploying/
| parse message " to flink-taskmanager-*" as @tmid
| stats count(*) by @tmid
| sort @timestamp desc
| limit 2000
```

## 8. 并行度变化（自动/手动扩缩容）

```
fields @timestamp, @parallelism
| filter message like /property: parallelism.default, /
| parse message "default, *" as @parallelism
| sort @timestamp asc
```

## 9. Python 入口日志

```
fields @timestamp, message
| sort @timestamp asc
| filter logger like /PythonDriver/
| limit 1000
```

## 10. 错误随时间分布（每 5 分钟）

```
fields @timestamp
| filter messageType = "ERROR"
| stats count(*) as errors by bin(5m)
| sort @timestamp asc
```
