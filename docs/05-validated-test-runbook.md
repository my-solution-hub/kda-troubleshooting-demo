# 5. 端到端验证流程文档（Validated Test Runbook）

> 本文档记录了 Demo D（CDK 部署重启风暴应用）在 **default profile / us-east-1** 上的
> **真实验证过程、结果、踩坑与结论**。可作为讲师彩排脚本，也可作为客户自测的 checklist。
> 账号：`613477150601`，区域：`us-east-1`，运行时：`FLINK-1_20`。

## 5.1 验证目标

1. CDK 能把一个会"重启风暴"的 Managed Flink 应用一键部署到 default profile。
2. 应用启动后能在 CloudWatch Logs 产生与"场景 1（未处理异常导致重启）"一致的日志。
3. 指标 `fullRestarts` 能反映重启循环。
4. 能干净地停止并销毁，不留计费资源。

## 5.2 完整流程（按实际执行顺序）

### Step 0 — 前置检查

```bash
aws sts get-caller-identity
# 确认 Account / Arn 正确（本次：613477150601, user/yagrxu）

aws cloudformation describe-stacks --stack-name CDKToolkit --region us-east-1 \
  --query 'Stacks[0].StackStatus' --output text
# 已 bootstrap 返回 UPDATE_COMPLETE / CREATE_COMPLETE；否则先 npx cdk bootstrap
```

### Step 1 — 部署

```bash
cd 04-demo/cdk
npm install
AWS_REGION=us-east-1 CDK_DEFAULT_REGION=us-east-1 npx cdk deploy --require-approval never
```

期望输出（Outputs）：`ApplicationName`、`LogGroupName`、`StartCommand`、`StopCommand`。

> ⚠️ **实测踩坑 1（已修复）**：首次部署失败，报
> `Please check the role provided or validity of S3 location ... unable to get the specified fileKey`。
> **根因**：Managed Flink 在创建应用时立即校验 S3 代码位置，但此时 IAM 服务角色的
> read 权限内联策略（`DefaultPolicy`）还没附加完成 —— 这是 CloudFormation 并行创建导致的**竞态**。
> **修复**：在栈里对应用显式加依赖，确保策略先就绪：
> ```ts
> codeAsset.grantRead(serviceRole);
> const roleDefaultPolicy = serviceRole.node.tryFindChild('DefaultPolicy');
> flinkApp.node.addDependency(serviceRole);
> if (roleDefaultPolicy) flinkApp.node.addDependency(roleDefaultPolicy);
> ```
> 修复后重新 `cdk deploy`，59 秒完成。

### Step 2 — 启动应用

```bash
aws kinesisanalyticsv2 start-application --region us-east-1 \
  --application-name kda-troubleshooting-demo \
  --run-configuration '{"FlinkRunConfiguration":{"AllowNonRestoredState":true}}'
```

轮询状态直到 `RUNNING`（约 1 分钟）：

```bash
aws kinesisanalyticsv2 describe-application --region us-east-1 \
  --application-name kda-troubleshooting-demo \
  --query 'ApplicationDetail.ApplicationStatus' --output text
# STARTING -> RUNNING
```

### Step 3 — 观察日志（核心验证点）

等 2–3 分钟让重启循环产生日志，然后跑 Insights 查询：

```bash
START=$(( $(date +%s) - 900 )); END=$(date +%s)
QID=$(aws logs start-query --region us-east-1 \
  --log-group-name "/aws/kinesis-analytics/kda-troubleshooting-demo" \
  --start-time $START --end-time $END \
  --query-string 'fields @timestamp, messageType, message | filter @message like /RESTARTING|FAILED|Exception|enrichment error/ | sort @timestamp desc | limit 25' \
  --query 'queryId' --output text)
sleep 8
aws logs get-query-results --region us-east-1 --query-id "$QID"
```

**实测抓到的关键日志（符合预期）**：

- `ERROR` — 我们埋的 bug，命中 `main.py:100`：
  ```
  ValueError: Unhandled enrichment error: downstream lookup failed for country=202 (risk=7)
  ```
- `WARN` — 任务失败：
  ```
  Source: orders[1] -> PythonCalc[2] -> Calc[3] (1/1) switched from RUNNING to FAILED with failure cause:
  ```
- 完整 Python Traceback（Beam SDK worker → pyflink → main.py 的 `enrich_country`）。

### Step 4 — 验证指标

```bash
aws cloudwatch get-metric-statistics --region us-east-1 \
  --namespace "AWS/KinesisAnalytics" --metric-name fullRestarts \
  --dimensions Name=Application,Value=kda-troubleshooting-demo \
  --start-time "$(date -u -v-15M +%Y-%m-%dT%H:%M:%S)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
  --period 60 --statistics Maximum \
  --query 'Datapoints[*].[Timestamp,Maximum]' --output text | sort
```

**实测结果**：`fullRestarts` 在 15 分钟内从 **767 → 789** 稳步递增，坐实重启风暴。

> macOS 的 `date` 用 `-v-15M`；Linux 用 `date -u -d '-15 minutes'`。

### Step 5 — 停止（踩坑 2）

```bash
# ❌ 普通停止会失败：
aws kinesisanalyticsv2 stop-application --region us-east-1 \
  --application-name kda-troubleshooting-demo
# InvalidApplicationConfigurationException: Failed to take snapshot ... currently experiencing downtime
```

> ⚠️ **实测踩坑 2**：应用一直处于 downtime（重启循环），停止时默认要先做 snapshot，
> 而 downtime 状态无法生成 snapshot，于是报错。
> **解决**：加 `--force` 强制停止（跳过 snapshot）：

```bash
aws kinesisanalyticsv2 stop-application --region us-east-1 \
  --application-name kda-troubleshooting-demo --force
# 状态 FORCE_STOPPING -> READY（约 30-60 秒）
```

### Step 6 — 销毁

```bash
cd 04-demo/cdk
AWS_REGION=us-east-1 CDK_DEFAULT_REGION=us-east-1 npx cdk destroy --force
# 依次删除 LoggingOption -> Application -> IAM -> LogGroup/Stream -> Stack
# ✅ KdaFlinkTroubleshootingDemo: destroyed
```

## 5.3 验证结论

| 验证点 | 结果 |
|--------|------|
| CDK 一键部署到 default profile | ✅（修复权限竞态后 59s 完成） |
| 产生场景 1 一致的重启日志 | ✅（ValueError + RUNNING→FAILED + Traceback） |
| `fullRestarts` 反映重启循环 | ✅（767→789 递增） |
| 干净停止 + 销毁 | ✅（需 `--force` 停止） |

## 5.4 讲师彩排 checklist

- [ ] `aws sts get-caller-identity` 确认账号/区域
- [ ] `npm install` 完成
- [ ] `cdk deploy` 成功，记下 Outputs
- [ ] `start-application` 后状态到 `RUNNING`
- [ ] 等 2–3 分钟，Insights 查询能看到 `enrichment error` 与 `FAILED`
- [ ] `fullRestarts` 指标在涨
- [ ] Demo 结束：`stop-application --force` → 状态 `READY` → `cdk destroy`
- [ ] 确认 CloudFormation 栈已删除、无残留应用（避免计费）

## 5.5 关键经验（可直接讲给客户）

1. **IAM 权限竞态**是 IaC 部署 Managed Flink 的高频坑：应用创建会立即校验 S3 代码位置，
   务必让应用依赖角色策略（本 demo 已在 CDK 里处理）。
2. **downtime 中的应用停不掉**要用 `--force`；这也解释了为什么生产里"应用卡在重启还删不掉"。
3. **日志格式固定为 JSON**，PyFlink 的异常会带 Beam SDK worker 的多层 traceback，
   真正的业务错误在栈的中间（`main.py` 那一行），排查时别被最外层的框架栈迷惑。
