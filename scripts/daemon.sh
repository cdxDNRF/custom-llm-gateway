#!/usr/bin/env bash
# 守护进程：让网关一直活着（崩了自动重启）。
#
# 为什么需要它：WSL 里 systemd 是 offline 状态，用不了 systemd 服务；
# 而网关必须常驻才能对外提供 API。这里用一个最简单的监督循环代替。
#
# 用法（通常不直接调用，走 ensure.sh）：
#   nohup bash scripts/daemon.sh >/dev/null 2>&1 &
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
PIDFILE=/tmp/dsh-llm-gateway-daemon.pid
PORT="${GATEWAY_PORT:-8790}"
HEALTH="http://127.0.0.1:${PORT}/api/overview"

# 防止重复启动：健康检查能通就说明已有实例在服务。
if curl -s -m 2 -o /dev/null "$HEALTH" 2>/dev/null; then
  echo "网关已在运行，守护进程退出。"
  exit 0
fi

echo $$ > "$PIDFILE"

# ─────────────────────────────────────────────────────────────
# ⚠️ 信号处理（真实缺陷，2026-10-01 实测）
#
# 早期写的是 `trap 'rm -f "$PIDFILE"; exit 0' TERM INT`。它**不起作用**：
# bash 在**前台等待子进程**（`"$NODE_BIN" ... src/main.ts`）时收到 TERM，
# trap 要等子进程结束后才执行；而子进程不会自己结束 —— 于是
# `stop.sh` 看到「仍有进程未退出」，网关也没停。
#
# 正确做法：在 trap 里**先杀子进程**，再退出。
# ─────────────────────────────────────────────────────────────
CHILD_PID=""
shutdown() {
  # 让看护循环别再重启
  STOPPING=1
  if [ -n "$CHILD_PID" ] && kill -0 "$CHILD_PID" 2>/dev/null; then
    kill "$CHILD_PID" 2>/dev/null || true
    # 给它最多 5 秒优雅退出（网关自己会关端口、释放资源）
    for _ in $(seq 1 25); do
      kill -0 "$CHILD_PID" 2>/dev/null || break
      sleep 0.2
    done
    kill -9 "$CHILD_PID" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
  exit 0
}
STOPPING=0
trap shutdown TERM INT

RESTART_DELAY=5
rapid_failures=0

while true; do
  started=$(date +%s)
  echo "[daemon $(date '+%F %T')] 启动网关…" >> "$LOG"
  # 用固定的 node 显式执行 tsx（不依赖 .bin/tsx 的 shebang —— 那条 shebang 在
  # Windows 侧调用时可能解析到错误的 node）。
  "$NODE_BIN" ./node_modules/tsx/dist/cli.mjs src/main.ts >> "$LOG" 2>&1 &
  CHILD_PID=$!
  wait "$CHILD_PID"
  code=$?
  CHILD_PID=""
  ran=$(( $(date +%s) - started ))

  # 收到过停止信号 → 不再重启
  if [ "$STOPPING" -eq 1 ]; then
    echo "[daemon $(date '+%F %T')] 收到停止信号，守护结束。" >> "$LOG"
    break
  fi

  # 正常退出（收到信号）就不再重启。
  if [ "$code" -eq 0 ] || [ "$code" -eq 143 ] || [ "$code" -eq 130 ]; then
    echo "[daemon $(date '+%F %T')] 网关正常退出（code=$code），守护结束。" >> "$LOG"
    break
  fi

  # 跑不到 10 秒就挂 → 说明是配置/端口类硬错误，别疯狂重启刷日志。
  if [ "$ran" -lt 10 ]; then
    rapid_failures=$((rapid_failures + 1))
    if [ "$rapid_failures" -ge 5 ]; then
      echo "[daemon $(date '+%F %T')] 连续 $rapid_failures 次秒退，暂停 60 秒再试。请看日志排查。" >> "$LOG"
      sleep 60
      rapid_failures=0
      continue
    fi
  else
    rapid_failures=0
  fi

  echo "[daemon $(date '+%F %T')] 网关退出（code=$code，运行 ${ran}s），${RESTART_DELAY}s 后重启…" >> "$LOG"
  sleep "$RESTART_DELAY"
done

rm -f "$PIDFILE"
