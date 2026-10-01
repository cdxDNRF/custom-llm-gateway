#!/usr/bin/env bash
# 停止网关与守护进程。
#
# ⚠️ 设计要点：**按进程身份识别，绝不按端口杀**。
#
# 早期版本用「谁在监听 8790/3901-3904 就杀谁」，实测会**误杀无关程序**
# （2026-10-01 用一个占用 3901 的 python 进程复现：它被 stop.sh 杀掉了）。
# 那在别人机器上是灾难 —— 同一个端口完全可能被别的服务用着。
#
# 现在的判据：命令行里出现**本项目的绝对路径**
# （`<项目>/src/main.ts` 或 `<项目>/scripts/daemon.sh`）。
#
# ★ 本脚本**不会**关闭 WSL，也不会碰任何其它进程。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDFILE=/tmp/dsh-llm-gateway-daemon.pid
FORCE="${1:-}"

# ── 收集属于本项目的 pid ──
collect_pids() {
  # 守护进程：优先用 pidfile，但**必须复核**命令行确实是我们的 daemon.sh
  if [ -f "$PIDFILE" ]; then
    local dpid cmd
    dpid=$(cat "$PIDFILE" 2>/dev/null || true)
    if [ -n "${dpid:-}" ] && kill -0 "$dpid" 2>/dev/null; then
      cmd=$(tr '\0' ' ' < "/proc/$dpid/cmdline" 2>/dev/null || true)
      case "$cmd" in
        *"$HERE/scripts/daemon.sh"*) echo "$dpid" ;;
      esac
    fi
  fi

  # 网关本体与守护：按**项目绝对路径**匹配命令行
  ps -eo pid=,args= 2>/dev/null | while read -r pid args; do
    case "$args" in
      *"$HERE/src/main.ts"*)       echo "$pid" ;;
      *"$HERE/scripts/daemon.sh"*) echo "$pid" ;;
    esac
  done
}

PIDS=$(collect_pids | sort -un | grep -v '^$' || true)

if [ -z "$PIDS" ]; then
  echo "网关未在运行（没有找到属于 $HERE 的进程）。"
  rm -f "$PIDFILE"
  exit 0
fi

echo "将停止以下进程（均属于 $HERE）："
for pid in $PIDS; do
  args=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | cut -c1-88)
  echo "  pid=$pid  $args"
done

if [ "$FORCE" = "--force" ]; then
  for pid in $PIDS; do kill -9 "$pid" 2>/dev/null || true; done
else
  # 先杀守护，否则它会立刻把网关拉回来
  for pid in $PIDS; do
    args=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
    case "$args" in
      *"daemon.sh"*) kill "$pid" 2>/dev/null || true ;;
    esac
  done
  sleep 1
  for pid in $PIDS; do kill "$pid" 2>/dev/null || true; done
fi

sleep 2
# 复核
LEFT=""
for pid in $PIDS; do kill -0 "$pid" 2>/dev/null && LEFT="$LEFT $pid"; done
rm -f "$PIDFILE"

if [ -n "$LEFT" ]; then
  echo "仍有进程未退出：$LEFT（可执行：bash scripts/stop.sh --force）"
else
  echo "已停止。WSL 与其它程序均未受影响。"
fi
