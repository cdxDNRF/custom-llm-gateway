#!/usr/bin/env bash
# 确保网关在运行（幂等）：已经健康就直接返回，否则拉起守护进程。
#
# 这是所有入口的公共实现：
#   - scripts/start.sh      手动启动
#   - scripts/daemon.sh     由它派驻守护
#   - Windows 开机启动项     调用它
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

# ─────────────────────────────────────────────────────────────
# ⚠️ 必须固定 Node 路径（真实缺陷，2026-10-01 实测）
#
# 从 Windows 侧调用本脚本时（快捷方式 / 开机启动项），WSL 的 interop 会把
# Windows 的 PATH 注入进来，而 `bash -l` 又可能没加载 nvm —— 结果是
# `node` 解析到 Windows 的 Node（v22）或干脆找不到，进而报
# `Cannot find module 'esbuild'`（因为 Windows Node 用 UNC 路径读 node_modules）。
#
# 解决：显式挑选 nvm 下最高版本的 node，并把它固定给本脚本及其子进程。
# ─────────────────────────────────────────────────────────────
resolve_node() {
  if [ -n "${DSH_GATEWAY_NODE:-}" ] && [ -x "${DSH_GATEWAY_NODE}" ]; then
    echo "${DSH_GATEWAY_NODE}"; return 0
  fi
  # nvm 的安装目录（默认 ~/.nvm/versions/node/<ver>/bin/node），取版本最高的
  local candidate
  candidate=$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then echo "$candidate"; return 0; fi
  # 退路：系统 node，但必须是 Linux 版（能跑 node_modules 里的原生模块）
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  return 1
}

NODE_BIN="$(resolve_node)" || {
  echo "[错误] 找不到可用的 Linux 版 node。请安装 Node 22+ 或设置 DSH_GATEWAY_NODE。" >&2
  exit 1
}
export PATH="$(dirname "$NODE_BIN"):$PATH"
LOG=/tmp/dsh-llm-gateway.log
DAEMON_PIDFILE=/tmp/dsh-llm-gateway-daemon.pid
PORT="${GATEWAY_PORT:-8790}"
HEALTH="http://127.0.0.1:${PORT}/api/overview"

# ① 已经健康 → 什么都不做
if curl -s -m 2 -o /dev/null "$HEALTH" 2>/dev/null; then
  echo "网关已在运行：http://127.0.0.1:${PORT}/"
  exit 0
fi

# ② 守护进程活着但服务没起来 → 等它自己重启（最多 40 秒）
if [ -f "$DAEMON_PIDFILE" ] && kill -0 "$(cat "$DAEMON_PIDFILE" 2>/dev/null)" 2>/dev/null; then
  echo "守护进程已在运行，等待网关就绪…"
  for _ in $(seq 1 40); do
    sleep 1
    if curl -s -m 2 -o /dev/null "$HEALTH" 2>/dev/null; then
      echo "网关已就绪：http://127.0.0.1:${PORT}/"
      exit 0
    fi
  done
  echo "等待超时，请看 $LOG" >&2
  exit 1
fi

# ③ 都没有 → 拉起守护进程（它会立刻启动网关并负责看护）
echo "正在启动网关（含守护）…"
setsid nohup bash "$HERE/scripts/daemon.sh" >> "$LOG" 2>&1 &
disown 2>/dev/null || true

for _ in $(seq 1 40); do
  sleep 1
  if curl -s -m 2 -o /dev/null "$HEALTH" 2>/dev/null; then
    echo "已启动：http://127.0.0.1:${PORT}/"
    exit 0
  fi
done

echo "启动超时，最后 20 行日志：" >&2
tail -20 "$LOG" >&2 2>/dev/null || true
exit 1
