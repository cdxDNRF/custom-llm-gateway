# Windows 原生启动（不经 WSL）

这一组脚本让网关**直接跑在 Windows 上**（用 Windows 的 Node），不启动 WSL 虚拟机 ——
内存占用约 75 MB（WSL 端约 150 MB + 虚拟机固定开销）。

## 使用

| 文件 | 作用 |
|---|---|
| `Start-Gateway-Win-Hidden.bat` | **后台启动**（推荐，双击即用） |
| `Start-Gateway-Win.bat` | 前台启动（窗口里看日志，关窗口=停止） |
| `Status-Gateway-Win.bat` | 查看状态（服务/各供应商/账号数） |
| `Stop-Gateway-Win.bat` | 停止 Windows 端 |
| `_config.bat` 等下划线文件 | 被 *.bat 调用的内部实现，勿直接运行 |

首次双击会自动 `pnpm install`。之后即点即用。

## ⚠️ 与 WSL 端的端口互斥

两端**共用同一组端口**（8790 / 3901-3904），**同时只能跑一个**：

- 双击 Win 端启动时若 WSL 端在跑，脚本会提示并直接帮你打开控制台（用正在跑的那个）。
- 切换：在 WSL 里 `bash ~/dsh-llm-gateway/scripts/stop.sh` 后再双击 Win 端。
- 反过来，`Stop-Gateway-Win.bat` 只停 Windows 端；若端口被 WSL 端占用，
  它会明确提示你去 WSL 里停。

客户端配置**两边通用**（同端口），切换端无需改任何客户端配置。

## 数据目录

```
C:\Users\<你>\.dsh-llm-gateway-win\
├── config.json                  端口等配置
└── providers\<id>\
    ├── credentials.json         OAuth 令牌（0600 权限在 WSL 侧设置，NTFS 下请勿共享）
    └── jet-hub\state.json       账号池
```

与 WSL 端（`~/.dsh-llm-gateway/`）**相互独立**。注意两点：

1. **限流标记互不共享**（两边各自累积）—— 一边被限流，另一边可能仍可用。
2. **签到/积分是账号级操作**，在哪边执行效果一样（服务端幂等）。

## 更新

项目通过 GitHub 同步（WSL 端开发 → push，Win 端 `git pull`）：

```bat
cd /d D:\AIagent\dsh-llm-gateway
git pull
```

若 `vendor/` 有更新，重启网关即可生效；模型目录可在控制台点「↻ 重拉模型目录」。
