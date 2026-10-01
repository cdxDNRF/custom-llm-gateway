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

# ① 已经健康 → 判断是不是**本端（WSL）自己**在跑
#
# ⚠️ 真实缺陷（2026-10-01）：早期只看 HTTP 是否通，于是**Windows 端**网关在跑时
# 这里也会打印「网关已在运行」并 exit 0，用户以为 WSL 端起来了，实际那是 Win 端。
# 两端是同一组端口、互斥的，必须区分：只有「守护 pidfile 活着」才算本端在跑。
if curl -s -m 2 -o /dev/null "$HEALTH" 2>/dev/null; then
  if [ -f "$DAEMON_PIDFILE" ] && kill -0 "$(cat "$DAEMON_PIDFILE" 2>/dev/null)" 2>/dev/null; then
    echo "网关已在运行：http://127.0.0.1:${PORT}/"
    exit 0
  fi
  # 服务通、但本端守护没跑 → 端口被**另一端**（Windows 端）占着。
  cat >&2 <<EOF
8790 已被占用，但**不是 WSL 端**在跑 —— 很可能是 Windows 端网关。
两端共用同一组端口，同时只能运行一个。

  ① 直接用 Windows 端（现在就能用）
     控制台：http://127.0.0.1:${PORT}/

  ② 改用 WSL 端
     先在 Windows 上停止：桌面「dsh-llm-gateway 停止(Win)」
     然后再执行本脚本。

  查看当前是哪一端：Windows 桌面「状态(Win)」，或本机 bash scripts/status.sh。
EOF
  exit 1
fi

# ①b 服务不通但端口被占（对方正在启动/半死状态）→ 直接给同样提示，别盲目拉守护。
#     用 bash 内建的 /dev/tcp 探测：连得上说明有东西在听（不一定应 HTTP）。
if (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null; then
  echo "8790 端口被占用，但 HTTP 无响应 —— 可能是另一端正在启动，或残留进程未回收。" >&2
  echo "请稍等几秒重试；若持续如此，在 Windows 侧检查是否有网关进程。" >&2
  exit 1
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
