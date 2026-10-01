# 局域网接入：让手机 / 平板用上网关

> 目标：手机上的 **SillyTavern（酒馆）**、浏览器或任意 OpenAI 兼容 App，
> 通过局域网直连电脑上正在跑的网关。2026-10-02 实测通过。

## 一句话

把 `config.json` 的 `host` 从 `127.0.0.1` 改成 `0.0.0.0`，重启网关；
启动日志会打印**局域网地址**和**访问令牌**，把它们填进手机即可。

只开放 **8790 聚合端点**（`/v1`）；各供应商端口（3901…）仍锁在回环，缩小暴露面。

---

## 一、开起来（两步）

### 1. 改配置

编辑数据目录下的 `config.json`：

```json
{
  "host": "0.0.0.0",
  "webPort": 8790,
  "accessToken": "留空则启动时自动生成",
  "providers": { "...": "不动" }
}
```

- WSL 端：`~/.dsh-llm-gateway/config.json` → 改完 `bash scripts/start.sh`
- Windows 端：`%USERPROFILE%\.dsh-llm-gateway-win\config.json` → 双击桌面「启动」

> `accessToken` 可以**不写**：监听 `0.0.0.0` 且令牌为空时，网关会**自动生成**
> 一个随机令牌并写回 `config.json`，同时打印到启动日志。这是防止你无意中
> 把账号池暴露给同网段的兜底。

### 2. 看启动日志

```
  ┌─ 局域网接入（手机 / 平板 / 酒馆）（需带令牌，见下方） ───────────────
  │ 控制台      http://10.198.81.112:8790/
  │ API 基址    http://10.198.81.112:8790/v1
  └────────────────────────────────────────────────────────

  🔑 访问令牌：<启动日志里打印的 32 位十六进制串>
```

`10.198.81.112` 就是手机要填的地址（**你这里会不同**，以日志为准）。
令牌也**以你自己的启动日志为准**：每台机器首次开放局域网时会各自生成一个，
不要照抄文档里的示例值（真实令牌只应存在于本机 `config.json` 里）。

---

## 二、手机 / 酒馆怎么填

以 SillyTavern 为例：

| 项 | 填什么 |
|---|---|
| API | `Custom (OpenAI-compatible)` |
| API 地址 / Base URL | `http://10.198.81.112:8790/v1` |
| API Key | 上面打印的访问令牌 |
| 模型 | `trae/deepseek-v4.1-flash`（**必须带供应商前缀**） |

端点分工：

| 端点 | 地址 | 模型写法 |
|---|---|---|
| **聚合**（推荐手机用） | `http://<局域网IP>:8790/v1` | `trae/kimi-k3`、`buddy/glm-5.3` |
| 单个供应商 | `http://127.0.0.1:3903/v1` | `kimi-k3`（**仅本机**，局域网访问不到） |

⚠️ 聚合端点上**模型名必须写成 `供应商/模型`**。只写 `kimi-k3` 会返回
`在聚合端点上请使用 "供应商/模型" 形式`——因为聚合端点要消歧。

### 怎么知道有哪些模型

```bash
curl -H "Authorization: Bearer <令牌>" http://<局域网IP>:8790/v1/models
```

返回 `provider/model` 形式的完整列表。

---

## 三、鉴权规则（重要）

令牌**只挡局域网，不挡本机**：

| 来源 | 是否要令牌 | 原因 |
|---|---|---|
| `127.0.0.1` / `::1` | ❌ 免验证 | 本机浏览器打开控制台不该被拦；能连回环的进程本来就在本机 |
| 局域网其它设备 | ✅ 必须 | 否则同网段任何人都能白用你的账号与签到积分 |

携带方式二选一：

```bash
# ① 请求头（客户端/脚本标准做法）
curl -H "Authorization: Bearer <令牌>" http://<IP>:8790/v1/models

# ② 查询参数（手机浏览器直接开控制台用）
http://<IP>:8790/?token=<令牌>
```

用 ② 打开后，前端会把令牌存进 `localStorage` 并**从地址栏抹掉**，
之后自动携带，不用每次输。

静态页面（`/`、`/static/*`）**不鉴权**，否则手机打开会只看到一个 401
JSON、连"在哪填令牌"的入口都没有。

---

## 四、实测结果（2026-10-02）

在 Windows 端 + WLAN `10.198.81.112` 上验证：

| 场景 | 结果 |
|---|---|
| 回环 + 无令牌 `/api/overview` | ✅ 200（豁免生效） |
| 局域网 + 无令牌 `/api/overview` | ✅ 401（拦截生效） |
| 局域网 + 错误令牌 | ✅ 401 |
| 局域网 + 正确令牌 | ✅ 200（12 个供应商） |
| 局域网 `/v1/models` + 令牌 | ✅ 200（74 个模型） |
| 局域网静态控制台页 | ✅ 200 |
| **局域网 + 令牌真实对话** | ✅ 返回 `OK`，`finish_reason: stop` |
| 局域网流式（SSE） | ✅ 标准 `data: {...}` 帧 + `[DONE]` 收尾 |
| 供应商端口的局域网访问 | ✅ 拒绝（按设计只绑回环） |
| 供应商端口的回环访问 | ✅ 200（本机客户端不受影响） |

FFI/响应头也确认可用：`content-type: text/event-stream`、
`cache-control: no-cache, no-transform`、`x-accel-buffering: no`、
`access-control-allow-origin: *`。

---

## 五、两个环境细节（排查时先看这里）

### 1. WSL 里 curl 局域网 IP 会 `Connection refused`

**这是正常的，不代表配置错了。**

你在 WSL2 的 **mirrored** 网络模式下，WSL 与 Windows 共享同一个 IP。
当网关跑在 **Windows 端**时：

- 从 **Windows** 访问 `10.198.81.112:8790` → ✅ 通
- 从 **WSL** 访问同一个地址 → ❌ refused（该地址在 WSL 内指向 WSL 自己的网卡）

要验证"到底通不通"，请**从 Windows 侧**试：

```powershell
Invoke-WebRequest -Uri 'http://10.198.81.112:8790/' -UseBasicParsing -TimeoutSec 6
```

### 2. 防火墙

手机连不上时，按序检查：

1. **网络类别与防火墙开关**

   ```powershell
   Get-NetConnectionProfile | Select-Object InterfaceAlias, NetworkCategory
   Get-NetFirewallProfile | Select-Object Name, Enabled
   ```

   本机实测：WLAN = `Public`，而 **Public 防火墙 = `False`（关闭）**，
   所以没有入站过滤，手机可直连。

2. **如果 Public 防火墙是开的**——需要以**管理员**身份加一条放行规则：

   ```powershell
   New-NetFirewallRule -DisplayName "dsh-llm-gateway LAN 8790" `
     -Direction Inbound -Protocol TCP -LocalPort 8790 `
     -Action Allow -Profile Any -RemoteAddress LocalSubnet
   ```

   `-RemoteAddress LocalSubnet` 限定只允许**同子网**访问，比放开 Any 安全。
   普通权限会报 `Access is denied.`，需要管理员 PowerShell。

3. **确认监听地址**（应为 `0.0.0.0:8790`）：

   ```powershell
   netstat -ano | findstr :8790
   ```

---

## 六、安全提醒（请认真看）

网关背后是**你的真实付费账号池 + 签到积分**。开放到局域网后：

- 令牌**等于密码**。别贴聊天记录、别提交进 git（`config.json` 已在 `.gitignore`）。
- 你的 WLAN 是 `10.198.0.0/16` 的**校园/公司网段**（网关 `10.198.255.254`）。
  这个网段里**可能有别人**——这正是默认自动生成令牌、并建议用
  `-RemoteAddress LocalSubnet` 的原因。
- 令牌泄露了怎么换：改 `config.json` 的 `accessToken` 为任意新值，重启网关。
  旧令牌立即失效（`localStorage` 里的旧值会让前端提示重输）。
- **不用了就关掉**：把 `host` 改回 `127.0.0.1` 并重启，局域网访问立刻消失，
  令牌留着也不影响本机使用。

---

## 七、相关代码位置

| 位置 | 作用 |
|---|---|
| `src/providers/registry.ts` | `GatewayConfig.host` / `accessToken` 解析、自动生成令牌、`persistOverviewSettings` |
| `src/core/server.ts` | `OverviewServer` 的 host 监听、`authorized()`（含回环豁免）、`isLoopback()` |
| `src/main.ts` | 接线配置、`lanAddresses()` 打印局域网地址与令牌 |
| `web/app.js` | 令牌的三种来源、`api()` 自动带 `Authorization`、401 重试 |
| `web/index.html` | 顶栏「🔑 令牌」按钮 |

环境变量临时覆盖（不改配置文件）：

```bash
GATEWAY_HOST=0.0.0.0 GATEWAY_PORT=8790 bash scripts/start.sh
```