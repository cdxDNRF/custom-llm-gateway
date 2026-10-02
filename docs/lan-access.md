# 手机接入网关：局域网 + Tailscale 随处访问

> 目标：手机 / 平板 / 酒馆（SillyTavern）接入电脑上正在跑的网关。
> 两种方式：**局域网**（同 Wi-Fi 免费直连）与 **Tailscale**（随处可访问、
> 不依赖局域网、不暴露公网）。2026-10-02 均实测通过。

## 两种方式怎么选

| 方式 | 场景 | 手机要装 App 吗 | 公网风险 |
|---|---|---|---|
| **局域网**（见一~六章） | 手机和电脑在**同一 Wi-Fi/网段** | 不用 | 无 |
| **Tailscale**（见七章） | 手机**不在家/不在同一网络**也能用 | 要装 Tailscale | 无（tailnet-only） |

两者可并存，互不影响。**只开放 8790 聚合端点**（`/v1`）；各供应商端口
（3901…）仍锁在回环，缩小暴露面。

---

## 一句话（局域网）

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

## 七、Tailscale：随处访问（不依赖局域网，零公网风险）

> 手机出门在外、连的是蜂窝数据或别人的 Wi-Fi 时，用这条。**不暴露公网**：
> 只有登录了你 Tailscale 账号的设备能连。

### 原理

Tailscale 在电脑和手机之间建一条加密的 overlay 网络（tailnet），给你一个
**固定**的 HTTPS 地址。电脑上跑 `tailscale serve`，把 tailnet 的 443 端口
反代到本机 8790；手机装上 Tailscale App、登录同一账号后即可访问。

### 1. 电脑端（Windows）一次性配置

Tailscale 已装好且登录后，执行：

```powershell
tailscale serve --bg --https=443 http://127.0.0.1:8790
```

用 `tailscale status` 查本机的 tailnet 名字：

```
100.x.y.z  <你的机器名>  <你的账号>@  windows  -
```

得到的访问地址是：

```
https://<你的机器名>.<你的tailnet后缀>.ts.net
```

> 机器名/后缀/账号以你自己的 `tailscale status` 输出为准，**别照抄示例**。
> 关掉：`tailscale serve --https=443 off`。

### 2. 手机端

1. 装 **Tailscale** App（App Store / Google Play）
2. 登录电脑上**同一个账号**（即电脑端 Tailscale 登录的账号）
3. 打开 Tailscale App，确保能看到这台电脑在线

### 3. 酒馆 / 客户端填法

| 项 | 填什么 |
|---|---|
| API 地址 / Base URL | `https://<你的机器名>.<你的tailnet后缀>.ts.net/v1` |
| API Key | 访问令牌（与局域网同一个） |
| 模型 | `trae/deepseek-v4.1-flash`（聚合端点带供应商前缀） |

### 4. 实测（2026-10-02）

| 场景 | 结果 |
|---|---|
| tailnet URL + 令牌 `/v1/models` | ✅ 200（74 模型） |
| tailnet URL 无令牌 `/v1/models` | ✅ 401（强制令牌） |
| tailnet URL 无令牌 `/api/overview` | ✅ 401 |
| tailnet URL + 令牌 `/api/overview` | ✅ 200 |
| tailnet URL 真实推理 | ✅ `TAILNET-OK` |
| 公网（非 tailnet）访问 | ✅ 不可达（零公网暴露） |

### 5. 安全要点

- **用 `serve`，不要用 `funnel`**。`funnel` 会把服务暴露到公网，且实测会
  绕过鉴权（见下）。
- 经 Tailscale 反代进来的请求，网关**强制校验令牌**（不会因为来源是
  127.0.0.1 而豁免——这是 2026-10-02 修掉的安全漏洞，见 [server.ts](src/core/server.ts) 的
  `isTailscaleForwarded()`）。
- tailnet 是你自己的私有网络，只有你账号下的设备能进；但令牌仍应妥善保管，
  不要贴进聊天记录或提交 git。

---

## 八、相关代码位置

| 位置 | 作用 |
|---|---|
| `src/providers/registry.ts` | `GatewayConfig.host` / `accessToken` 解析、自动生成令牌、`persistOverviewSettings` |
| `src/core/server.ts` | `OverviewServer` 的 host 监听、`authorized()`（含回环豁免 + Tailscale 反代识别）、`isLoopback()`、`isTailscaleForwarded()` |
| `src/main.ts` | 接线配置、`lanAddresses()` 打印局域网地址与令牌 |
| `web/app.js` | 令牌的三种来源、`api()` 自动带 `Authorization`、401 重试 |
| `web/index.html` | 顶栏「🔑 令牌」按钮 |

环境变量临时覆盖（不改配置文件）：

```bash
GATEWAY_HOST=0.0.0.0 GATEWAY_PORT=8790 bash scripts/start.sh
```