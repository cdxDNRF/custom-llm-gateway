#!/usr/bin/env bash
# 查看网关状态与访问地址。
set -uo pipefail
PORT="${GATEWAY_PORT:-8790}"
PIDFILE=/tmp/dsh-llm-gateway-daemon.pid
LOG=/tmp/dsh-llm-gateway.log

echo "── dsh-llm-gateway 状态 ──"
if curl -s -m 3 "http://127.0.0.1:${PORT}/api/overview" -o /tmp/.gwstatus.json 2>/dev/null; then
  echo "  服务：运行中"
  python3 - <<'PY' 2>/dev/null || true
import json
d=json.load(open('/tmp/.gwstatus.json'))
for p in d['providers']:
    n=len(p['accounts'])
    print(f"    {p['id']:10s} :{p['port']}  账号 {n}  {p['baseUrl']}")
PY
  echo "  控制台：http://127.0.0.1:${PORT}/"
  echo "  聚合端点：http://127.0.0.1:${PORT}/v1"
else
  echo "  服务：未运行"
fi
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
  echo "  守护：运行中（pid $(cat "$PIDFILE")）—— 崩溃会自动重启"
else
  echo "  守护：未运行"
fi
echo "  日志：$LOG"
rm -f /tmp/.gwstatus.json
