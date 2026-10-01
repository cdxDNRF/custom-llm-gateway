# dsh-llm-gateway

把 **CodeBuddy / WorkBuddy / TRAE / Qoder** 的订阅额度包装成**本地 OpenAI 兼容 API**，带 Web 控制台。

由 [dsh-codearts-auth](https://gitee.com/iJetLi/deepseek-harness-codearts) 插件的认证/协议层复用而来，
**每个供应商独立包装**（各自端口、各自账号池、各自凭据），保留原插件的全部能力：OAuth 登录、多账号池、
一键签到、积分余额、限流自动换号、静默续期、模型管理。

> ⚠️ **合规警告**：本项目以「模拟官方客户端身份调用未公开接口」的方式复用你**自己账号**的订阅额度。
> 这**大概率违反各上游平台的用户协议**，可能导致**账号被限流、封禁或额度清零**。
> 仅供个人学习与自用，**请勿使用主账号**，并自行承担全部风险。
> 详见下方[风险提示](#风险提示)。

---

## 快速开始

```bash
git clone git@github.com:cdxDNRF/custom-llm-gateway.git dsh-llm-gateway
cd dsh-llm-gateway
pnpm install                 # 或 npm install
bash scripts/start.sh        # 启动（幂等）
```

打开 **http://127.0.0.1:8790/** 即为 Web 控制台，点「＋ 新建账号」登录各上游。

```bash
bash scripts/status.sh       # 查看运行状态
bash scripts/stop.sh         # 停止（不会影响 WSL 与其它程序）
```

**Windows 用户**：`scripts/windows/` 下有现成的 `.bat`（零配置，自动识别 WSL 发行版与项目路径），
可给它们建桌面快捷方式：

| 文件 | 作用 |
|---|---|
| `Start-Gateway.bat` | 启动网关（含守护）并打开控制台 |
| `Status-Gateway.bat` | 查看运行状态 |
| `Stop-Gateway.bat` | 停止网关 |
| `Autostart-Gateway.bat` | 放进启动文件夹可开机自启（可选） |

> **常驻保障**：启动时会同时拉起守护进程，网关崩溃后约 5 秒自动重启。
> 详见 [docs/how-to-run.md](docs/how-to-run.md)。

```
  ┌─ 接入地址 ─────────────────────────────────────────────
  │ buddy        http://127.0.0.1:3901/v1
  │ workbuddy    http://127.0.0.1:3902/v1
  │ trae         http://127.0.0.1:3903/v1
  │ qoder        http://127.0.0.1:3904/v1
  │ 聚合端点      http://127.0.0.1:8790/v1   （模型写成 provider/model）
  └────────────────────────────────────────────────────────
```

**两种接入方式**，按需选：

| 方式 | baseURL | 模型 id 写法 | 适用 |
|---|---|---|---|
| **独立端点**（推荐） | `http://127.0.0.1:3901/v1` | 裸名，如 `glm-5.3` | 一个客户端只用一个供应商；端口隔离，互不影响 |
| **聚合端点** | `http://127.0.0.1:8790/v1` | `供应商/模型`，如 `buddy/glm-5.3` | 一次接入全部（当前 72 个模型） |

---

## Web 控制台

http://127.0.0.1:8790/ 提供：

**每个供应商一张卡片**，卡片上：

- **能力标签**：OAuth 登录 / 多账号 / 每日签到 / 积分查询 / 锁定永久积分 / 自动续期
- **锁定永久积分**开关（仅 CodeBuddy / WorkBuddy 显示）—— 开启后只用不会过期的积分，避免浪费即将作废的额度
- **＋ 新建账号**：两步式登录 —— 弹出官方授权页，后台轮询，成功后自动刷新列表
- **一键签到**：对该供应商下全部启用账号执行每日领取（幂等，重复点安全）
- **查积分**：合计 + 每个资源包明细
- **模型管理**：逐个模型勾选启停（黑名单制），显示 `启用 N / 共 M`、上游倍率；停用后**立即从 `/v1/models` 消失**
- **续期** / **更多 ▾**（重测账号、重置限流标记、全部模型启用/停用）
- **账号行**：序号（= 选号优先级）、昵称、凭据 ref、有效期、限流明细；`↑ ↓` 调整优先级，启用/停用，删除
- **运行日志**：最近 300 条（登录、签到、限流换号都在这里）

底部「接入方式」直接给出可复制的 baseURL。

---

## 功能对照（vs DSH 插件）

网关保留了原插件的全部能力：

| DSH 插件 RPC | 网关 | 说明 |
|---|---|---|
| `account.create` | ✅ | `POST /api/p/<id>/login` |
| `account.list` | ✅ | `GET /api/p/<id>/accounts` |
| `account.delete` | ✅ | `DELETE /api/p/<id>/accounts?id=` |
| `account.update` | ✅ | `POST /api/p/<id>/enable` |
| `account.reorder` | ✅ | `POST /api/p/<id>/accounts/reorder`（顺序 = 选号优先级） |
| `account.reset` / `resetAll` | ✅ | `POST /api/p/<id>/accounts/reset` |
| `account.retest` / `retestAll` | ✅ | `POST /api/p/<id>/accounts/retest`（真实探针） |
| `account.refresh` | ✅ | `POST /api/p/<id>/refresh` |
| `credits.balances` | ✅ | `GET /api/p/<id>/balance` |
| `credits.claimAll` | ✅ | `POST /api/p/<id>/checkin` |
| `credits.permanentLock` | ✅ | `GET/POST /api/p/<id>/permanentLock` |
| `model.list` | ✅ | `GET /api/p/<id>/models`（含启用状态） |
| `model.setDisabled` / `setMany` / `setAll` | ✅ | `POST /api/p/<id>/model/toggle`、`/toggleMany`、`/enableAll` |
| （适配器内置）限流自动换号 | ✅ | 每个供应商的账号池独立生效 |
| （适配器内置）30 分钟静默续期 | ✅ | `main.ts` 里的定时器 |

**未纳入**（如需可加）：`backup.export/import`、`login.sendSms`（Loomy 专用）、
`cline.*` / `loomy.*` / `raccoon.*` 等未接入供应商的专属端点。

---

## 已支持供应商

| id | 显示名 | 端口 | 登录 | 签到 | 积分 | 锁定永久积分 | 协议 |
|---|---|---|---|---|---|---|---|
| `buddy` | CodeBuddy (腾讯) | 3901 | ✅ | ✅ | ✅ | ✅ | OpenAI 兼容 |
| `workbuddy` | WorkBuddy (国际版) | 3902 | ✅ | ❌¹ | ✅ | ✅ | OpenAI 兼容 |
| `trae` | TRAE (字节) | 3903 | ✅ | ✅ | ✅ | — | SOLO 自定义 SSE |
| `qoder` | Qoder | 3904 | ✅ | ✅ | ✅ | — | 加密信封 |

¹ WorkBuddy 国际版后端不提供签到接口（vendor 的 `credits.ts` 有实测证据）。

> 其余脉系（LobsterAI / Loomy / Raccoon / MiniMax / Cline / CodeArts / ZCode / QoderCN）
> 的代码已在 `vendor/` 里，增加新供应商只需照 `src/providers/buddy.ts` 写一个新文件
> （约 200 行接线代码），**不需要改动 vendor**。

---

## 架构

```
┌──────────────────────────────────────────────────────────────┐
│  src/（自有代码 ~3,000 行）                                    │
│                                                              │
│  core/context.ts    宿主替身：真 Cordis Context + 凭据 + 日志   │
│  core/credentials.ts 凭据存储（0600 权限、原子写）              │
│  core/protocol.ts   ★ OpenAI ⇄ DSH 协议转换（网关核心）        │
│  core/provider.ts   供应商统一契约                             │
│  core/provider-common.ts 共用实现（模型管理/限流/重测/永久锁）   │
│  core/provider-server.ts  每个供应商一个 HTTP 服务             │
│  core/server.ts     总览服务：Web UI + 聚合端点                │
│  providers/buddy.ts   ├ CodeBuddy / WorkBuddy（同源，两份实例） │
│  providers/trae.ts    ├ TRAE                                  │
│  providers/qoder.ts   └ Qoder                                 │
│  main.ts            启动全部端点 + 定时续期                     │
│                                                              │
│  web/               控制台前端（原生 JS，无构建步骤）           │
├──────────────────────────────────────────────────────────────┤
│  vendor/（复用代码 58,279 行，来自 dsh-codearts-auth，MIT）     │
│  ★ 一行未改 —— 靠 core/context.ts 提供宿主接口                │
└──────────────────────────────────────────────────────────────┘
```

### 为什么 vendor 能一行不改

原插件用 Cordis 依赖注入取宿主能力。实测**真实的 `@deepseek-ai/cordis` 可以独立构造**，
所以网关自己提供一个 Context 并实现 `credentials` / `logger` 两项服务即可：

```ts
const ctx = new Context()
ctx.provide('credentials', { resolve, describe, set, unset })
ctx.provide('logger', logger)
// 之后 vendor 的 AccountPool / BuddyAuth / *Adapter 全部按原样工作
```

另外**适配器类本身不持有 ctx**（只有 `registerXxxLlm` 包装函数用到 `ctx.llm`），
而网关不需要注册到 DSH 的注册表 —— 直接 `new BuddyAdapter({...})` 拿到实例。

**账号池隔离**：vendor 的 `resolveJetHubHome()` 优先读环境变量 `DSH_JET_HUB_STATE_DIR`，
网关在构造账号池时按供应商设置该变量（`withStateDir()` 做了串行化），
于是每个供应商的数据落在 `providers/<id>/` 下，且**完全不碰真实 DSH 的 `~/.dsh`**。

### 协议转换层做了什么

vendor 适配器的输出是 DSH 内部的 `StreamChunk`：

```ts
{ type:'text-delta', text } | { type:'reasoning-delta', text }
| { type:'tool-call-delta', id, name, argumentsDelta } | { type:'usage' } | { type:'finish' }
```

`core/protocol.ts` 把它翻译成 OpenAI SSE：

```ts
delta.content            ← text-delta
delta.reasoning_content  ← reasoning-delta   （社区约定，DeepSeek/智谱同款）
delta.tool_calls[]       ← tool-call-delta   （⚠️ 只转增量，block-end 是完整版会重复）
finish_reason            ← finish（stop / tool_calls / length）
usage                    ← usage（含 cached_tokens / reasoning_tokens）
```

反方向把 OpenAI 请求转成 `GenerateOptions`，其中两处 vendor 硬要求已处理：
assistant 消息**必须带 `reasoning_content`**（缺失上游会 400）；工具调用分片要正确归并。

---

## 配置

数据目录默认 `~/.dsh-llm-gateway`，首次启动生成 `config.json`：

```json
{
  "logLevel": "info",
  "webPort": 8790,
  "providers": {
    "buddy":     { "enabled": true, "port": 3901 },
    "workbuddy": { "enabled": true, "port": 3902 },
    "trae":      { "enabled": true, "port": 3903 },
    "qoder":     { "enabled": true, "port": 3904 }
  }
}
```

- `enabled: false` 可关掉某个供应商
- `accessToken: "xxx"` 可给某端口加 Bearer 校验（默认不校验，见下方风险）
- 环境变量：`GATEWAY_HOME`（数据目录）、`GATEWAY_PORT`（Web 端口）

**安全**：凭据文件权限为 `0600`、数据目录 `0700`；不监听公网（只绑 `127.0.0.1`）。

---

## 实测记录（2026-10-01）

| 项目 | 结果 |
|---|---|
| 四个供应商端点启动 | ✅ 3901–3904 全部监听，`/health` 正确返回能力声明 |
| 上游模型目录 | ✅ buddy 17 个、trae 38 个、qoder 17 个（真实拉取） |
| 聚合端点 | ✅ 72 个模型，`provider/model` 命名 |
| **非流式对话** | ✅ buddy/trae/qoder 三家均返回正确内容与 usage |
| **流式对话** | ✅ SSE 分帧正确，`reasoning_content` 与 `content` 分离 |
| 积分余额 | ✅ buddy 3970.7、trae 1941.59、qoder 100 credits |
| 一键签到 | ✅ trae 实际领取 +100，其余返回"今日已领"（幂等） |
| 登录流程 | ✅ 返回真实腾讯授权 URL，占位账号登记正常 |
| 未登录时的行为 | ✅ 返回明确中文提示，不崩溃 |
| 错误处理 | ✅ 未知供应商 / 裸模型名 都有可操作提示 |
| 静态资源目录穿越 | ✅ `400` 拒绝 |
| **模型管理** | ✅ UI 勾选 → 服务端落库 → `/v1/models` 立即过滤（往返验证） |
| **重测账号** | ✅ 无限流标记时 0 次探测（不浪费额度） |
| **限流重置** | ✅ `clearedCount` 正确返回 |
| **永久积分锁** | ✅ 开关可用；不支持的供应商返回明确错误 |
| **账号排序** | ✅ 顺序持久化（= 选号优先级） |
| UI 交互自动化 | ✅ 4 卡片 / 16 模型行 / 2 锁开关渲染，**零 JS 错误** |

---

## ⚠️ 风险提示（务必阅读）

1. **违反上游用户协议**：这是"用客户端身份头调未公开接口"的做法
   （`X-Product-Code: codebuddy`、`UA: CodeBuddyIDE/1.106.1` 等伪造身份照发）。
   **可能导致账号被限流、封禁或额度清零**。别用主账号。
2. **默认无鉴权**：端口只绑 `127.0.0.1`，但同机任何进程都能借道消耗你的额度。
   介意的话在 `config.json` 里给各供应商加 `accessToken`。
3. **凭据即账号权限**：`providers/*/credentials.json` 里的令牌在有效期内可直接代表你调用上游。
   权限已设为 `0600`，**不要**复制到别处或提交进仓库。
4. **上游协议随时可变**：这些是未公开接口，失效时会表现为"登录成功但对话报错"。
   重新登录或升级 `vendor/`（见下）通常能恢复。

---

## 维护

```bash
# 类型检查（自有代码；vendor 的 minimax-* 有已知的历史类型漂移，已排除）
npx tsc --noEmit -p tsconfig.json

# 从上游同步 vendor（会覆盖 vendor/src，不要在其中直接改代码）
cd /tmp && rm -rf codearts && git clone --depth 1 https://gitee.com/iJetLi/deepseek-harness-codearts.git codearts
rsync -a --delete --exclude .git --exclude lib --exclude node_modules \
      /tmp/codearts/src/ ~/dsh-llm-gateway/vendor/src/
```

**改代码的纪律**：需要定制时改 `src/`，**不要改 `vendor/`** —— 那是为了能随时从上游同步。
`vendor/SOURCE.md` 记录了这一约定。

---

## 文件说明

| 路径 | 作用 |
|---|---|
| `src/` | 网关自有代码（core / providers / main） |
| `vendor/src/` | 复用的 dsh-codearts-auth 源码（**不要改**，见 `vendor/SOURCE.md`） |
| `web/` | Web 控制台前端（原生 JS，无构建） |
| `scripts/ensure.sh` | 幂等启动（固定 Node 路径，见 [how-to-run](docs/how-to-run.md)） |
| `scripts/daemon.sh` | 守护进程（崩溃自动重启） |
| `scripts/start.sh` / `stop.sh` / `status.sh` | 启停与状态 |
| `scripts/windows/*.bat` | Windows 侧入口（桌面快捷方式与开机启动项调用） |
| `docs/how-to-run.md` | 运行方式、常驻机制、踩坑记录 |
| `docs/architecture.md` | 架构：为什么 vendor 能零改动、协议转换、端口布局、请求路径 |
| `docs/model-updates.md` | **模型更新机制**：远端目录 vs 静态表、两个「重拉」入口、`sync-vendor.sh` |
| `LICENSE` | MIT（含第三方代码声明） |
| `scripts/sync-vendor.sh` | 从上游同步 `vendor/`（自动备份 + 类型检查 + 重启） |

---

## 许可

网关自有代码：同上（跟随原项目的 MIT）。
`vendor/` 来自 [dsh-codearts-auth](https://gitee.com/iJetLi/deepseek-harness-codearts)，MIT，见 `vendor/LICENSE`。
