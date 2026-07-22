# 4. Demo — 动手排查一次"重启风暴"

这个 demo 用一份仿真日志，带客户走一遍完整排查流程。**无需真实 AWS 环境也能演示**（本地文件 + Kiro / AI），有环境的话再演示真实 Insights 查询。

## 目录

```
04-demo/
├── README.md                     # 本文件：动手步骤
├── sample-logs/
│   ├── restart-loop.json         # 场景1：未处理异常导致重启
│   ├── access-denied.json        # 场景4：IAM 权限
│   └── backpressure.json         # 场景6：源端限流/反压
├── queries/
│   └── insights-queries.md       # 可直接粘贴的 Insights 查询集
├── scripts/
│   └── fetch-logs.sh             # 用 CLI 拉取日志的脚本模板
└── cdk/                          # Demo D：CDK 部署一个真实的"重启风暴"应用
    ├── README.md                 # 部署/启动/清理步骤
    ├── lib/flink-demo-stack.ts   # CDK 栈定义
    └── flink-app/main.py         # 带 intentional bug 的 PyFlink 应用
```

## Demo A：本地日志 + AI（5 分钟，无需 AWS 账号）

1. 打开 `sample-logs/restart-loop.json`，让学员先肉眼找线索。
2. 在 Kiro 聊天里输入：
   ```
   #File 04-demo/sample-logs/restart-loop.json
   这是 Managed Flink 的 CloudWatch 日志，请还原时间线并给出 root cause 和修复建议。
   ```
3. 期望结论：`RUNNING → RESTARTING`，由算子内 `NullPointerException` 触发，从 checkpoint 恢复；修复方向是对该字段做空值处理。
4. 对比 `access-denied.json` 和 `backpressure.json`，让学员判断各属于哪个场景。

## Demo B：真实环境 Insights 查询（10 分钟，需 AWS 账号）

1. 确认应用已开启 CloudWatch logging，找到 log group `/aws/kinesis-analytics/<app>`。
2. 进 CloudWatch → Logs Insights，选中该 log group。
3. 依次运行 `queries/insights-queries.md` 里的查询：
   - 先跑"最近 20 条"确认有数据；
   - 再跑"task-related failures"定位重启；
   - 用"任务分布"查看并行度是否倾斜。
4. 结合指标面板（`fullRestarts` / `downtime`）对照时间窗。

## Demo C：用 CLI + Kiro 自动拉取（5 分钟）

1. 编辑 `scripts/fetch-logs.sh` 顶部的变量（APP、REGION、时间窗）。
2. 运行：
   ```bash
   bash 04-demo/scripts/fetch-logs.sh
   ```
3. 把输出的 JSON 交给 Kiro / AI 归纳（提示词见第 3 章）。

## Demo D：CDK 部署真实的"重启风暴"应用（15 分钟，需 AWS 账号）

用 CDK 在你的 **default profile** 上部署一个真实 Managed Flink 应用，它内置数据源、
故意在 UDF 抛异常，制造真实的重启循环，让学员在真实的 CloudWatch Logs 上排查。

```bash
cd 04-demo/cdk
npm install
npx cdk bootstrap      # 首次在该账号/区域需要
npx cdk deploy         # 使用 default profile
npm run start-app      # 启动后 1-3 分钟进入重启循环
```

详细步骤（含清理）见 [cdk/README.md](cdk/README.md)。这是最贴近真实排查、也最适合结合
Kiro"改代码修复"闭环的演示。

## 讲解要点（Takeaways）

- 日志是**固定 JSON**，靠 `messageType` / `message` / `logger` 过滤。
- **先指标定位时间窗，再日志找根因**。
- 重启类问题九成来自**未处理异常**或**资源预置不足**。
- AI/Kiro 的价值：读栈快、生成查询快、能直接改代码、能沉淀 runbook。
