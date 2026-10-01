# 架构

## 全貌

```
┌─────────────────────────────────────────────────────────────────┐
│  src/  —— 本项目自有代码（约 3,900 行）                            │
│                                                                 │
│  main.ts                    入口：起全部端点 + 定时续期             │
│                                                                 │
│  core/                                                          │
│    context.ts               宿主替身：构造真 Cordis Context        │
│    credentials.ts           凭据存储（0600 权限、原子写）           │
│    logger.ts                日志（含环形缓冲，供 Web 显示）         │
│    protocol.ts          ★   OpenAI ⇄ DSH 协议转换（网关核心）      │
│    provider.ts              供应商契约（Provider 接口）             │
│    provider-common.ts       共用实现（模型管理/限流/重测/永久锁）    │
│    provider-server.ts       每个供应商一个 HTTP 服务               │
│    server.ts                总览服务：Web UI + 聚合端点            │
│                                                                 │
│  providers/                                                     │
│    buddy.ts     ├ CodeBuddy + WorkBuddy（同源，两个独立实例）      │
│    trae.ts      ├ TRAE                                          │
│    qoder.ts     └ Qoder                                         │
│    registry.ts  组装：按 config.json 创建已启用的供应商            │
│                                                                 │
│  web/                       控制台前端（原生 JS，无构建步骤）       │
├─────────────────────────────────────────────────────────────────┤
│  vendor/src/  —— 复用代码（58,279 行，MIT，来自 dsh-codearts-auth）│
│  ★ 一行未改                                                     │
└─────────────────────────────────────────────────────────────────┘
```

---

## 一、为什么 vendor 能一行不改

上游插件用 **Cordis 依赖注入**取宿主能力。关键实测结论：

1. **真实的 `@deepseek-ai/cordis` 可以独立构造** —— 不需要 DSH 宿主：

   ```ts
   import { Context } from '@deepseek-ai/cordis'
   const ctx = new Context()
   ctx.provide('credentials', { resolve, describe, set, unset })
   ctx.provide('logger', logger)
   ```

2. **适配器「类」本身不持有 `ctx`** —— `ctx.llm` 只出现在 `registerXxxLlm()`
   包装函数里。网关不需要注册到任何注册表，直接 `new BuddyAdapter({...})` 即可。

于是 `src/core/context.ts` 提供这两项服务后，vendor 的
`AccountPool` / `BuddyAuth` / `*Adapter` 全部按原样工作。

### 账号池隔离

vendor 的 `resolveJetHubHome(ctx)` 优先读环境变量 `DSH_JET_HUB_STATE_DIR`。
网关在**构造账号池的那一刻**按供应商设置它（`withStateDir()` 内部串行化），
于是每个供应商的数据落在 `~/.dsh-llm-gateway/providers/<id>/`，
且**完全不碰真实 DSH 的 `~/.dsh`**。

> 这是唯一一处依赖进程级状态的妥协，换取 vendor 零改动。

---

## 二、协议转换层（`core/protocol.ts`）

vendor 适配器的输出是 DSH 内部的 `StreamChunk`：

```ts
{ type:'text-delta',      index, text }        // 正文
{ type:'reasoning-delta', index, text }        // 思维链
{ type:'tool-call-delta', index, id, name?, argumentsDelta }
{ type:'usage',           usage }
{ type:'finish',          reason }
{ type:'block-start' | 'block-end', index, ... }
```

翻译成 OpenAI SSE：

| OpenAI 字段 | 来源 | 注意 |
|---|---|---|
| `delta.content` | `text-delta` | |
| `delta.reasoning_content` | `reasoning-delta` | 社区约定（DeepSeek / 智谱同款） |
| `delta.tool_calls[]` | `tool-call-delta` | ⚠️ **只转增量**，见下 |
| `finish_reason` | `finish` | `stop` / `tool_calls` / `length` |
| `usage` | `usage` | 含 `cached_tokens` / `reasoning_tokens` |

反方向把 OpenAI 请求转成 `GenerateOptions`，其中两个 vendor 硬要求已处理：

1. **assistant 消息必须带 `reasoning_content`** —— vendor 注释记录：
   「推理模型缺失会 400」，故统一补空串。
2. **工具调用分片要正确归并** —— 首片带 `id` + `name`，后续片只有 `arguments`。

### 为什么 `block-end` 不转

适配器会在流末尾补一个**完整的** `tool-call` 块，而 OpenAI 流式协议要求
tool_calls 是**增量的**。两者都转出去客户端会收到重复调用。
故只转 `tool-call-delta`，`block-end` 仅用于判断结束。

---

## 三、端口布局

```
127.0.0.1:3901   buddy      纯 OpenAI 端点（模型 id 用裸名）
127.0.0.1:3902   workbuddy  同上
127.0.0.1:3903   trae       同上
127.0.0.1:3904   qoder      同上
127.0.0.1:8790   总览服务    Web 控制台 + 管理 API + 聚合 OpenAI 端点
                            （聚合端点上模型 id 写成 `供应商/模型`）
```

**为什么分成两类**：

- **独立端点**：端口隔离，任一供应商崩了不影响其余；客户端只用一个上游时最省事。
- **聚合端点**：一次接入全部（本机实测 72 个模型）；模型 id 带前缀以消歧义。

---

## 四、一次请求的完整路径

```
客户端 POST http://127.0.0.1:3901/v1/chat/completions
   │
   ├─ core/provider-server.ts  解析 OpenAI 请求体
   │
   ├─ core/protocol.ts         toGenerateOptions()
   │      messages → RequestMessage[]（含图片降级、reasoning_content 补位）
   │      tools    → ToolSchema[]
   │      → GenerateOptions { provider, model, messages, system, tools, ... }
   │
   ├─ vendor/src/buddy-adapter.ts   stream(options)
   │      ① 从账号池取凭据（限流则换号）
   │      ② 组装官方身份头（X-Product-Code / UA / X-Domain…）
   │      ③ POST 上游 /v2/chat/completions，解析 SSE
   │      ④ 产出 StreamChunk
   │
   ├─ core/protocol.ts         streamChunksToSse()
   │      StreamChunk → `data: {...}` 帧
   │
   └─ 写回客户端，末尾 `data: [DONE]`
```

---

## 五、目录与数据

| 内容 | 位置 | 是否入库 |
|---|---|---|
| 源码 | `src/`、`web/`、`scripts/` | ✅ |
| 复用代码 | `vendor/src/` | ✅（MIT，见 `vendor/LICENSE`） |
| 依赖 | `node_modules/` | ❌ |
| 同步备份 | `vendor/.backup-*/` | ❌ |
| **配置 / 凭据 / 账号池** | `~/.dsh-llm-gateway/` | ❌（在项目外） |
| 运行日志 | `/tmp/dsh-llm-gateway.log` | ❌ |

**凭据绝不入库**：它们在用户家目录下，权限 `0600`，且 `.gitignore` 已排除
备份与同步标记。仓库里搜不到任何真实令牌。
