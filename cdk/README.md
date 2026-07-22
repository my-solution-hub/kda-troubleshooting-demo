# Demo D — 用 CDK 部署一个会"重启风暴"的真实 Managed Flink 应用

这个 CDK 栈会在你的 **default AWS profile** 对应的账号/区域里部署一个 PyFlink 应用。
它用 Flink 内置的 `datagen` 源和 `blackhole` 汇（**不依赖外部 Kinesis/S3**），
并在 UDF 里故意抛异常，制造真实的 **重启风暴**，让学员在 CloudWatch Logs 里练习排查。

## 部署了什么

- 一个 Managed Flink (kinesisanalyticsv2) 应用 `kda-troubleshooting-demo`，运行时 `FLINK-1_20`
- CloudWatch Log group `/aws/kinesis-analytics/kda-troubleshooting-demo` + log stream
- IAM 服务角色（logs / cloudwatch:PutMetricData / 读取代码 zip）
- PyFlink 代码 zip（通过 CDK asset 上传，`flink-app/main.py`）

## 前置条件

- 已安装 Node.js 18+ 和 AWS CLI，且 **default profile 已配置好凭证**
  （`aws sts get-caller-identity` 能成功）
- 账号在目标 region 已 `cdk bootstrap` 过（下面有命令）

> 全程使用 default profile。如需指定其他 profile，在命令后加 `--profile <name>`。

## 一步步部署

```bash
# 进入 cdk 目录
cd 04-demo/cdk

# 1) 安装依赖
npm install

# 2) 首次使用当前账号/区域需要 bootstrap（default profile）
npx cdk bootstrap

# 3) 部署（default profile）
npx cdk deploy
# 部署完成后，输出里会给出 StartCommand / StopCommand / LogGroupName
```

部署后应用处于 **READY**（未运行）状态，需要手动启动：

```bash
# 4) 启动应用（开始产生数据并很快进入重启循环）
npm run start-app
# 等价于：
# aws kinesisanalyticsv2 start-application --application-name kda-troubleshooting-demo \
#   --run-configuration '{"FlinkRunConfiguration":{"AllowNonRestoredState":true}}'

# 查看状态（STARTING -> RUNNING）
npm run status
```

启动后约 1–3 分钟，应用会因 UDF 抛异常反复 `RUNNING -> RESTARTING`。

## 观察与排查

1. 打开 CloudWatch → Logs Insights，选择 log group `/aws/kinesis-analytics/kda-troubleshooting-demo`。
2. 运行 [../queries/insights-queries.md](../queries/insights-queries.md) 里的查询：
   - #0 确认有日志
   - #2 抓 `RESTARTING/FAILED/Exception`
   - #10 看错误随时间分布
3. 指标：在应用的 Monitoring 页看 `fullRestarts`、`downtime` 是否 > 0。
4. 把日志喂给 Kiro/AI（提示词见 [../../03-kiro-as-technical-support.md](../../03-kiro-as-technical-support.md)）验证 root cause。

## 演示"修复"（可选，很有说服力）

把应用从"生病"切到"健康"，无需改代码，只改运行时属性：

```bash
# 方式一：改属性 fail_mode=false 后重新部署
# 编辑 lib/flink-demo-stack.ts 里 FlinkAppProperties.fail_mode 改成 'false'
npx cdk deploy
npm run stop-app && npm run start-app
```

或直接在代码里修 `flink-app/main.py` 的 UDF（对 risk==7 做兜底而不是抛异常），
再 `cdk deploy` —— 这正好演示第 3 章"Kiro 直接改代码修复"的闭环。

## 清理（重要，避免持续计费）

```bash
# 1) 先停应用。注意：处于重启循环(downtime)时，普通 stop 会因无法生成 snapshot 失败，
#    需要加 --force 强制停止。
aws kinesisanalyticsv2 stop-application --application-name kda-troubleshooting-demo --force
# 等状态变为 READY（约 30-60 秒）
npm run status

# 2) 再销毁栈
npx cdk destroy
```

> Managed Flink 运行中会按 KPU 计费。demo 结束务必 stop + destroy。
>
> **实测坑**：本 demo 故意让应用一直 downtime，普通 `stop-application` 会报
> `InvalidApplicationConfigurationException: Failed to take snapshot ... currently experiencing downtime`。
> 用 `--force` 即可强制停止（会跳过 snapshot）。

## 常见问题

- **START 失败 / 一直 STARTING**：查 log group 是否已创建、IAM 角色是否有 logs 权限（本栈已配好）。
- **看不到日志**：确认应用已 `start`（部署完是 READY 不产生日志），并等 1–2 分钟。
- **destroy 报应用在运行**：先停应用，等状态变 `READY` 再 destroy。
- **stop 报 "Failed to take snapshot ... downtime"**：应用在重启循环中无法生成 snapshot，改用
  `aws kinesisanalyticsv2 stop-application --application-name kda-troubleshooting-demo --force`。
- **首次 deploy 报 "unable to get the specified fileKey"**：这是 IAM 读权限策略与应用创建的竞态，
  本栈已通过 `flinkApp.node.addDependency(...)` 显式建立依赖修复。
- **region 不对**：CDK 用 default profile 的 region；可用 `AWS_REGION=xxx npx cdk deploy` 覆盖。
