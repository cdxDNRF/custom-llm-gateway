# Build 渠道（AI Studio App 反代）

> 本文记录 Build 渠道的设计、实测结论与使用约束。所有"实测"标注的结论都
> 有对应的复现步骤，不是推测。

## 1. 这是什么，以及它与其它 17 家的根本差异

其它供应商都是**我们主动出网**（`fetch` 到上游）。Build 渠道反过来：
上游是一个跑在 **Google Cloud Run** 上的 AI Studio「Build App」，
由**用户浏览器里的页面**主动连回本网关的 WebSocket。

```
你的 Chrome（AI Studio App 页面）
   ↕ ws://127.0.0.1:8790/v1/ws?auth_token=…
本网关（BuildRelay 服务端）
   ↕
酒馆 / DSH / 任意 OpenAI 客户端
```

**为什么必须由浏览器发起连接**：App 的服务端代码跑在 Google 云上，它连不到你的
`127.0.0.1`；而**页内 JS** 跑在你的浏览器里，可以。

> 实测：HTTPS 页面连 `ws://127.0.0.1` **不受混合内容限制** ——
> Chrome 对 localhost 有豁免。故**无需 HTTPS、无需公网 IP、无需隧道**。

## 2. ⚠️ 核心事实：Build 与 API Key 是**两套独立额度**

这是本渠道**唯一有实用价值的地方**，也是最容易搞错的地方。

### 两条路的区别只在「谁执行 fetch」

```
❌ App 服务端 fetch（带 API Key）→ generativelanguage 直连 → 烧 API Key 额度
✅ 浏览器端 fetch（不带 key）  → 宿主页 shim 拦截 → MakerSuite 代理 → Build 额度
```

Build App 运行在 `*.scf.usercontent.goog` 的沙箱 iframe 中。AI Studio 宿主页会向
iframe 发 `bootstrap` + `MessagePort`，iframe 内的 shim **接管匹配
`generativelanguage.googleapis.com` 的 `fetch`**，经端口转发给宿主页，由宿主页完成
**BotGuard/WAA proof** 后调用 MakerSuite 代理 RPC
（`ProxyStreamedCall` / `ProxyUnaryCall`）。

### 我们因此**不需要实现 WAA**

社区方案（[AIStudio2API](https://github.com/Mag1cFall/AIStudio2API)、CLIProxyAPI 等）
要跑无头浏览器 + 提取 Cookie，甚至**重实现 BotGuard**（AIStudio2API 的 `docs/waa.md`
有 849 行），因为它们追求"服务端全自动"。

我们不用的原因：**用户的浏览器本来就在 AI Studio 页面里**，宿主页代劳了最难的
WAA 部分。代价是**用户必须开着那个标签页** —— 这正是「手动连接」设计的由来。

### 决定性实验（2026-10-17 15:00）

| 步骤 | 结果 |
|---|---|
| 经网关对 `gemini-3.1-flash-lite` 连发 **6 次** | relay 计数 **3→9**（精确 +6） |
| 随后刷新 https://ai.dev/rate-limit | 该模型 RPD **仍是 35/500，纹丝不动** |
| App 界面 | 显示 `Intercepted by MakerSuite Host Proxy` |

⇒ 客户端 fetch 路径**不计入 API Key 额度**。

⚠️ 反例（曾经的错误实现）：让 App 服务端带 key 直连时，同样的调用会让
rate-limit 页面 **+1**。所以**「谁执行 fetch」是这个渠道成立与否的关键**。

## 3. ⚠️ 必须满足的前提：用户激活

宿主页只在**用户激活后**才转发客户端 fetch：

- `navigator.userActivation.hasBeenActive` 为真
- 且累计约 **30 次可信 `mousemove`** 与 **5 次可信 `keydown`**（或处于移动设备）

**未满足时 iframe 的 fetch 保持挂起** —— 症状是**超时而非报错**。没有状态指示
就只能靠猜，故：

| 环节 | 实现 |
|---|---|
| App 上报 | 每个 `ping` 帧**顶层**带 `activation`；连上时与 `active` 变 true 时另发独立帧 |
| 网关解析 | `BuildRelay.readActivation`（同时兼容顶层与 `payload` 两种形状） |
| UI 显示 | Build 页「用户激活（转发前提）」卡片，三态：🟢 已激活 / 🔴 未激活 / ⚪ 未上报 |
| 挂起检测 | 超过 **15 秒**未收到任何帧 ⇒ UI 显示可行动的告警条 |
| App 未上报时 | 显示「未上报」而**不假装 false** —— 否则会误导用户去乱动鼠标 |

## 4. 模型清单：真流式 / 假流式拆成两个条目

上游模型 7 个，但每个**派生两个客户端条目**（共 14 条）：

| 条目 | 行为 |
|---|---|
| `gemini-3.8-flash` | **真流式** —— 跟随请求的 `stream` 参数 |
| `gemini-3.8-flash-假流式` | **锁定假流式** —— 忽略 `stream` 参数 |

**为什么拆开**：两条路是**上游行为**层面的差别，不是同一个模型的开关：

- **真流式**：体验好（逐字出），但 Build 的**流式审核非常严格、易截断**
- **`-假流式`**：上游一次性返回（`:generateContent`）、我们按 DSH 帧协议分片，
  **不截断**，但首字延迟高

合成一个模型时用户无法自主选择；拆开后能在酒馆里直接切。

> **额度按基础模型统一计**：`gemini-3.8-flash` 与 `gemini-3.8-flash-假流式`
> 在上游是**同一个模型**、共用同一份配额。拆开只影响客户端选择，不影响额度归属。
> 本地计数也按基础 id 归并（适配器发的上游 id 已去掉后缀）。

### 可用模型（实测）

| 模型 | 实测 |
|---|---|
| `gemini-3.1-flash-lite` | ✅ |
| `gemini-3.5-flash-lite` | ✅ |
| `gemma-4-31b-it` | ✅ 但**明显较慢**（同一请求曾超时 130 秒） |
| `gemini-3.8 / 3.7 / 3.6 / 3.5-flash` | ✅（额度撞限时 429） |

## 5. 预填充：不是所有模型都支持

> 实测：`gemini-3.8-flash` 明确拒绝"以 model turn 结尾"的请求并回 400 ——
> `Requests ending with a model turn are not supported.`；
> 而 `gemini-3.1-flash-lite` 接受。

故构造请求时**统一剥离**末条 model turn，而不是把 400 抛给用户
（后者在酒馆里表现为莫名报错，且要换预设才能绕过）。

判据按**请求形态**（末条 `role === 'model'`）而非模型名黑名单 —— 上游行为可能变。

## 6. 额度：上游查不到，故本地记账

**三条查额度的路都堵死：**

| 方案 | 结果 |
|---|---|
| MakerSuite 代理 RPC 查额度 | ❌ 无公开端点 |
| https://ai.dev/rate-limit | ❌ 只显示 API Key（Playground）用量，**不含 Build** |
| 宿主页 `get_model_quota` | ❌ iframe↔宿主页**私有通道**，外部 WS 看不到 |

**故改为本地记账**：按模型分桶计数，跨日自动清零。

- 计数时机：**`stream_start` 到达时**才 +1 —— 只有上游真的开始回应才算消耗，
  "挂起/超时"多数没打到上游，不该计入
- 归并：按**基础模型 id**（两条流式变体合并）
- **日界：北京时间 15:00 重置**

> 用户情报：「刷新时间在北京时间每天下午 3 点或 4 点」。
> 实测吻合：2026-10-17 15:00 前 `3.7/3.5-flash` 恒 429，当日 15:43 复测即恢复。
> 故日界实现为「上一个北京时间 15:00 到现在」。

⚠️ **具体上限未公开**。社区流传"flash 每天 100 条、pro 每天 10 条"，但**未经证实**，
故代码里**不写死数字** —— 先前曾把 API Key 渠道的文档值当成 Build 的实测值断言出去，
是错的。UI 只显示"今日 N 次"。

## 7. 常见问题（来自前公益站实战经验 + 实测核对）

| 现象 | 原因 | 处理 |
|---|---|---|
| **429** | 当日额度耗尽（**按模型独立**） | 等到下一个 15:00 重置 / 换模型 / 换账号 |
| **403 permission denied** | 代理问题或账号需重新登录 | 刷新 App 页面重登；也可换模型（实测 3.6-flash 复测即恢复） |
| **回答截断** | Build 流式审核严格 | **改用 `-假流式` 条目** |
| **请求超时（无报错）** | 宿主页未放行转发（用户未激活） | 到 App 页面**移动鼠标 / 按几下键** |
| **白屏无法加载** | 浏览器缺环境 / 代理问题 | 用 Chrome/Firefox（不用国内浏览器） |
| **网页端正常、客户端断开** | 客户端要流式但走真流式 | 选 `-假流式` 条目 |
| **手机切后台断连** | 浏览器杀后台 | 开「后台保活」（音频或画中画）；开着保活时不要放其它有声音的 App |

## 8. 多账号

App 链接的 `.com` 后加 `/u/<序号>` 可切换 Google 账号，例如：

```
https://aistudio.google.com/u/1/apps/<app-id>
```

各账号的 Build 额度**独立计算**，故多账号可叠加。

## 9. 相关代码

| 文件 | 职责 |
|---|---|
| `src/core/build-relay.ts` | WebSocket 服务端（挂网关同端口 `/v1/ws`）；帧编解码、挂起检测、本地计数 |
| `src/providers/build-adapter.ts` | Gemini REST ↔ DSH 翻译；模型表、预填充剥离、假流式 |
| `src/providers/build.ts` | Provider + 连接开关（`accepting`） |

### 协议

文本帧，JSON：`{id, type, payload}`

| type | 方向 | 说明 |
|---|---|---|
| `ping` / `pong` | 双向 | App 每 20 秒 ping；**ping 顶层携带 `activation`** |
| `activation` | App → 我们 | 连上时与 `active` 变 true 时主动上报 |
| `http_request` | 我们 → App | `{url, method, headers, body}` |
| `stream_start` | App → 我们 | `{status, headers}` |
| `stream_chunk` | App → 我们 | `{data}` |
| `stream_end` | App → 我们 | — |
| `error` | App → 我们 | `{message}` |

⚠️ 帧解析必须处理 **TCP 分片/粘包**（用累积缓冲，凑够整帧才消费）——
否则长响应会被截断，表现为"模型回答中断"这类极难定位的问题。

⚠️ **host 白名单**：App 侧只放行 `*.googleapis.com`。这是它的安全设计，不应绕过。

## 10. 运维要点

- **默认不启用**（`defaultEnabled: false`）：它依赖一个开着的浏览器标签页
- 供应商启用即**自动接受连接** —— 不需要每次手动点「连接」
  （曾经的缺陷：`accepting` 默认 false 且是内存状态，网关一重启就变回 false，
  App 重连被 403；用户看到的现象是"自动重连没用"，而真凶是我们在拒绝）
- 聚合端点（`/v1/models`）会带上 14 个 `build/…` 条目
- App 的重连**有次数上限**，超过后需**刷新页面**
