# 流式超时与错误下发策略

记录「流式请求在什么情况下中断、中断后客户端看到什么」——
这类决策无法从代码直接看出意图，而**改错的代价是用户丢掉整轮回答**，
故单独立文档。

## 一、超时参数（Vertex 渠道）

`src/providers/vertex-adapter.ts` 里 `consumeOpenAiSse` 的两个超时：

| 参数 | 值 | 含义 |
|---|---|---|
| `firstTokenTimeoutMs` | **300_000**（5 分钟） | 从发请求到**收到第一个字节** |
| `chunkTimeoutMs` | **300_000**（5 分钟） | 首字节之后，**两次数据之间**的最大间隔 |

### 为什么首字要 5 分钟

上下文 100k–150k tokens + `reasoning_effort: high` 时，旗舰模型
（`gemini-4-carbon` / `gemini-4-hydrogen`）冷预填充 + 首发实测
**110–255 秒**。原来的 120 秒会直接误杀。

### 为什么流中途也要 5 分钟（这条曾经判断错）

第一版只放宽了首字超时，注释写「流中途卡住通常是真的挂了，不该一起放宽」——
**这个判断是错的**。

ZCode 实测（210 条消息 + high 思考）：

```
20.75s  收到首帧，输出了 2 个 tool-input-delta
→      模型转入长思考 / 生成大工具参数，60 秒无新字节
→      触发 "vertex: sse chunk timeout after 60000ms"
```

**首帧之后照样会有长停顿**：思考模型的输出节奏是「想完一大段才吐下一段」，
中间的空闲期可能远超 60 秒。这与「连接真的挂了」在流层面**无法区分**，
但误杀活着的连接的代价（用户丢掉整轮回答）远大于多占 5 分钟连接。

参照同仓库 `vendor/src/astudio-product.ts`：同类思考流设的也是
`chunkTimeoutMs: 300_000`（该文件 fact 378 明确要求 ≥300s）。

**多占的连接不会长期滞留**：`options.signal` 在客户端断开时立刻中止
（见 `aggregateChat` / `aggregateMessages` 的 `AbortController` 接线）。

## 二、中断后怎么告诉客户端

分两种情况，**取决于错误发生在首帧之前还是之后**。

### 首帧之前出错 → 用真实 HTTP 状态码（正常 JSON，不是 SSE）

```ts
const firstFrame = await sseFrames.next()   // 先拉一帧
try { ... } catch (error) { sendOpenAiError(response, error) }  // 还没 writeHead(200)
```

客户端能正确分类：429 → 限流可重试；404 → 模型不存在；401 → 鉴权失败。

**为什么必须这样做**：ZCode / Claude Code 等客户端靠 **HTTP 状态码**判断
可重试性。一旦发了 200，就算 SSE 里写 `error`，它们也只会当成
「成功的流中途出了业务错误」⇒ `ProviderBusinessError / retryable=false`，
**不会重试**。这是 2026-11-13 修的那批问题的根因。

### 首帧之后出错 → 只能在 SSE 里发 error 帧

HTTP 状态码已经发出去了，改不了。此时下发：

```json
data: {"error":{"message":"...","type":"server_error","code":"gateway_timeout","status":504}}
```

### 为什么不「直接断 TCP」让客户端重试（评估过，不采用）

ZCode 对两类失败的反应不同（来自实际报障反推）：

| 失败形态 | ZCode 行为 |
|---|---|
| TCP 异常断开（ECONNRESET / premature close） | 识别为 `network_error`，**自动重试** |
| HTTP 200 的 SSE 里嵌 `error` 帧 | 识别为 `ProviderBusinessError`，**不重试** |

看起来「断连接」更划算（能触发重试），但代价是：

- **丢掉具体错误文案** —— 用户只看到「连接断了」，无法判断是限流、鉴权
  还是模型问题，也没法反馈排查
- 只对**流式**适用；非流式响应没有这个选项，两种协议要维护两套行为
- 最根本的是：**断连接治的是症状，不是病**。真正的病是「把活着的流误杀」，
  那个用放宽 `chunkTimeoutMs` 解决了。误杀消灭后，SSE error 帧只会在
  真出故障时出现 —— 那时「让用户看到真实原因」比「盲目重试」更有价值

⇒ **保留 SSE error 帧**，并保证它带 `type` / `code` / `status`
（原来只有 `message`，所以客户端报 `reason=unknown`）。

## 三、Vertex 的上游重试

`VertexAdapter.postWithRetry` 在**拿到响应头之后、开始消费流之前**重试：

- 只重试 **429 / 500 / 502 / 503 / 504**（确定性错误 400/401/403/404 不重试）
- **尊重 `Retry-After`**（秒数 / HTTP 日期两种形态）
- 指数退避 + 30% 抖动，最多 2 次
- 单次等待上限 10 秒（再长不该由网关替用户等）
- `sleep` 可被 `signal` 打断 —— 客户端断开就立刻停，不留幽灵重试

这只覆盖「上游在响应头阶段就拒绝」的瞬时抖动；**流中途的中断不在重试范围**
（此时已向客户端发过数据，重试会导致内容重复）。

## 四、改动这两处前请先想清楚

- `chunkTimeoutMs` 再调小：会重新引入本文件里记录的误杀。若要调，先确认
  「思考模型在真实长上下文下两次吐字的最大间隔」实测数据。
- 改成「断 TCP」：会丢掉错误文案，且需要同时处理流式与非流式两条路径。
