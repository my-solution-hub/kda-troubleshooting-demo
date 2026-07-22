#!/usr/bin/env bash
# 从 CloudWatch Logs 拉取 Managed Flink 应用日志的模板脚本。
# 用法：编辑下面变量后执行  bash fetch-logs.sh
set -euo pipefail

# ---- 需要修改的变量 ----
APP_NAME="order-enrichment"
REGION="ap-southeast-1"
LOG_GROUP="/aws/kinesis-analytics/${APP_NAME}"
LOOKBACK_MINUTES=30
# 只看 ERROR；改成空字符串则拉全部
QUERY_STRING='fields @timestamp, messageType, logger, message | filter messageType = "ERROR" | sort @timestamp desc | limit 200'
# ------------------------

# 计算时间窗（兼容 macOS 的 date -v；Linux 用 date -d 请自行调整）
if date -v-1M >/dev/null 2>&1; then
  START_TIME=$(date -v-"${LOOKBACK_MINUTES}"M +%s)   # macOS
else
  START_TIME=$(date -d "-${LOOKBACK_MINUTES} minutes" +%s)  # Linux
fi
END_TIME=$(date +%s)

echo ">> 启动查询 log group=${LOG_GROUP} region=${REGION} 窗口=${LOOKBACK_MINUTES}min"
QUERY_ID=$(aws logs start-query \
  --region "${REGION}" \
  --log-group-name "${LOG_GROUP}" \
  --start-time "${START_TIME}" \
  --end-time "${END_TIME}" \
  --query-string "${QUERY_STRING}" \
  --query 'queryId' --output text)

echo ">> queryId=${QUERY_ID}，等待结果..."
STATUS="Running"
while [ "${STATUS}" = "Running" ] || [ "${STATUS}" = "Scheduled" ]; do
  sleep 2
  STATUS=$(aws logs get-query-results --region "${REGION}" --query-id "${QUERY_ID}" --query 'status' --output text)
done

echo ">> 查询状态: ${STATUS}"
aws logs get-query-results --region "${REGION}" --query-id "${QUERY_ID}" --output json
