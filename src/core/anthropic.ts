/**
 * Anthropic Messages 协议层：让 `/v1/messages` 与 OpenAI 端点并存。
 *
 * ## 设计：翻译而非重写
 *
 * 网关的内部管线（`toGenerateOptions` → 适配器 → `StreamChunk`）是围绕
 * OpenAI 语义建的。本模块**不复制这套管线**，而是把 Anthropic 请求先
 * 归一化成内部的 OpenAI 形状，复用同一条路径，再把输出翻译回 Anthropic
 * 格式。好处：
 *   - 所有供应商适配器、限流换号、账号池逻辑**一行都不用改**；
 *   - 两条协议路径的行为天然一致（同一个 bug 不会只在一条路径上被修）。
 *
 * ## 协议差异（翻译时必须处理的点）
 *
 * | 维度 | OpenAI | Anthropic |
 * |---|---|---|
 * | system | `messages` 里的 system 角色 | 顶层 `system` 字段（可为字符串或块数组） |
 * | 正文 | `content` 字符串 | content **块数组**（`text` / `image` / `tool_use` / `tool_result`） |
 * | 图片 | `image_url: {url}` | `image: {source:{type:'base64'|'url',...}}` |
 * | 工具 | `tools[].function.{name,description,parameters}` | `tools[].{name,description,input_schema}` |
 * | 工具调用 | assistant `tool_calls` + `tool` 角色消息 | assistant `tool_use` 块 + user `tool_result` 块 |
 * | 最大输出 | `max_tokens`（可选） | `max_tokens`（**必填**） |
 * | 停止词 | `stop` | `stop_sequences` |
 * | 流式结束 | `data: [DONE]` | `message_stop` 事件（**无** `[DONE]`） |
 * | 用量 | `prompt_tokens`/`completion_tokens` | `input_tokens`/`output_tokens` |
 *
 * 参考：https://docs.anthropic.com/en/api/messages
 */
import type { OpenAiChatRequest, OpenAiMessage, OpenAiContentPart, OpenAiTool } from './protocol.js'
import type { StreamChunk, FinishReason } from '@deepseek-ai/dsh-llm'

// ─────────────────────────── Anthropic 请求类型 ───────────────────────────

/** Anthropic 的 content 块（请求侧只用到这几种）。 */
export interface AnthropicContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result' | 'thinking' | 'document'
  /** `type: 'text'` */
  text?: string
  /** `type: 'image'` */
  source?: {
    type: 'base64' | 'url'
    media_type?: string
    data?: string
    url?: string
  }
  /** `type: 'tool_use'`（assistant 发起的调用） */
  id?: string
  name?: string
  input?: unknown
  /** `type: 'tool_result'`（user 回传的结果） */
  tool_use_id?: string
  content?: string | AnthropicContentBlock[]
  is_error?: boolean
  [key: string]: unknown
}

export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

export interface AnthropicTool {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
  /** 部分客户端会带；忽略。 */
  [key: string]: unknown
}

export interface AnthropicMessagesRequest {
  model: string
  messages: AnthropicMessage[]
  /** 必填（Anthropic 协议要求）。 */
  max_tokens?: number
  system?: string | AnthropicContentBlock[]
  stream?: boolean
  temperature?: number
  top_p?: number
  top_k?: number
  stop_sequences?: string[]
  tools?: AnthropicTool[]
  tool_choice?: unknown
  metadata?: { user_id?: string }
  /** 思考预算（部分客户端用）。映射到 reasoning_effort。 */
  thinking?: { type?: string; budget_tokens?: number }
  [key: string]: unknown
}

// ─────────────────────────── 请求：Anthropic → OpenAI（内部格式） ───────────────────────────

/** 把 Anthropic 的 system（字符串或块数组）压成纯文本。 */
function flattenSystem(system: AnthropicMessagesRequest['system']): string | undefined {
  if (system === undefined) return undefined
  if (typeof system === 'string') return system.length > 0 ? system : undefined
  const parts: string[] = []
  for (const block of system) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  const text = parts.join('\n')
  return text.length > 0 ? text : undefined
}

/** 把 Anthropic 的图片块转成 OpenAI 的 `image_url`（base64 转 data URL）。 */
function imageBlockToOpenAi(block: AnthropicContentBlock): OpenAiContentPart | undefined {
  const source = block.source
  if (source === undefined) return undefined
  if (source.type === 'url' && typeof source.url === 'string') {
    return { type: 'image_url', image_url: { url: source.url } }
  }
  if (source.type === 'base64' && typeof source.data === 'string') {
    const media = source.media_type ?? 'image/png'
    return { type: 'image_url', image_url: { url: `data:${media};base64,${source.data}` } }
  }
  return undefined
}

/** 把一段 Anthropic content 块数组转成 OpenAI 的 content（字符串或多模态数组）。 */
function blocksToOpenAiContent(blocks: AnthropicContentBlock[]): string | OpenAiContentPart[] {
  const parts: OpenAiContentPart[] = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      const image = imageBlockToOpenAi(block)
      if (image !== undefined) parts.push(image)
    }
  }
  // 纯文本时退回字符串（保持与 OpenAI 客户端一致的最简形态）。
  if (parts.every((p) => p.type === 'text')) {
    return parts.map((p) => p.text ?? '').join('\n')
  }
  return parts
}

/**
 * 把 Anthropic 请求翻译成内部的 OpenAI 请求。
 *
 * 关键映射：
 *   - `system`（顶层）→ 一条 `role: 'system'` 消息（放最前）
 *   - assistant 的 `tool_use` 块 → OpenAI 的 `tool_calls`
 *   - user 的 `tool_result` 块 → 独立的 `role: 'tool'` 消息
 *
 * ⚠️ `tool_result` 必须**拆成独立消息**（OpenAI 的 tool 角色是消息级而非块级）。
 * 一个 user 消息里若同时有 text 与 tool_result 块，要拆成「tool 消息 + user 消息」，
 * 否则工具结果会被当成普通用户文本、模型看不到工具返回值。
 */
export function anthropicToOpenAiRequest(body: AnthropicMessagesRequest): OpenAiChatRequest {
  const messages: OpenAiMessage[] = []

  const system = flattenSystem(body.system)
  if (system !== undefined) messages.push({ role: 'system', content: system })

  for (const message of body.messages ?? []) {
    const blocks = typeof message.content === 'string'
      ? [{ type: 'text', text: message.content } as AnthropicContentBlock]
      : message.content

    if (message.role === 'assistant') {
      // assistant：文本 + tool_use（→ tool_calls）
      const textParts: string[] = []
      const toolCalls: NonNullable<OpenAiMessage['tool_calls']> = []
      for (const block of blocks ?? []) {
        if (block.type === 'text' && typeof block.text === 'string') textParts.push(block.text)
        else if (block.type === 'tool_use') {
          toolCalls.push({
            id: String(block.id ?? ''),
            type: 'function',
            function: {
              name: String(block.name ?? ''),
              arguments: JSON.stringify(block.input ?? {}),
            },
          })
        }
        // thinking 块不回传（上游多数不接受历史思考；与 Anthropic 官方 SDK 行为一致
        // 的做法是只在当轮请求里带，历史轮省略）。
      }
      const assistant: OpenAiMessage = { role: 'assistant', content: textParts.join('\n') }
      if (toolCalls.length > 0) assistant.tool_calls = toolCalls
      messages.push(assistant)
      continue
    }

    // user：可能同时含 tool_result（→ 独立 tool 消息）与普通文本/图片
    const userParts: AnthropicContentBlock[] = []
    for (const block of blocks ?? []) {
      if (block.type === 'tool_result') {
        // ⚠️ 先把已累积的用户内容冲出去，保证 tool 消息紧跟其对应的 assistant 调用。
        if (userParts.length > 0) {
          messages.push({ role: 'user', content: blocksToOpenAiContent(userParts.splice(0)) })
        }
        const inner = typeof block.content === 'string'
          ? block.content
          : (block.content ?? [])
              .filter((b) => b.type === 'text' && typeof b.text === 'string')
              .map((b) => b.text ?? '')
              .join('\n')
        messages.push({
          role: 'tool',
          tool_call_id: String(block.tool_use_id ?? ''),
          content: inner,
        })
      } else {
        userParts.push(block)
      }
    }
    if (userParts.length > 0) {
      messages.push({ role: 'user', content: blocksToOpenAiContent(userParts) })
    }
  }

  const request: OpenAiChatRequest = { model: body.model, messages }
  if (typeof body.max_tokens === 'number') request.max_tokens = body.max_tokens
  if (typeof body.temperature === 'number') request.temperature = body.temperature
  if (typeof body.top_p === 'number') request.top_p = body.top_p
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    request.stop = body.stop_sequences
  }
  if (body.stream === true) request.stream = true

  // 工具：Anthropic 的 `input_schema` → OpenAI 的 `function.parameters`
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const tools: OpenAiTool[] = []
    for (const tool of body.tools) {
      if (typeof tool.name !== 'string' || tool.name.length === 0) continue
      // Anthropic 内置工具（如 web_search_*）没有 input_schema 且**不能**
      // 透传给上游（我们的上游没有同名工具）。没有 input_schema 的一律跳过。
      if (tool.input_schema === undefined) continue
      tools.push({
        type: 'function',
        function: {
          name: tool.name,
          ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
          parameters: tool.input_schema,
        },
      })
    }
    if (tools.length > 0) {
      request.tools = tools
      if (body.tool_choice !== undefined) request.tool_choice = body.tool_choice
    }
  }

  // thinking.budget_tokens → reasoning_effort（粗略映射；上游只认档位字符串）
  const budget = body.thinking?.budget_tokens
  if (typeof budget === 'number' && budget > 0) {
    request.reasoning_effort = budget >= 8000 ? 'high' : budget >= 2000 ? 'medium' : 'low'
  }

  return request
}

// ─────────────────────────── 响应：OpenAI → Anthropic ───────────────────────────

/** Anthropic 的 stop_reason 取值。 */
export function toAnthropicStopReason(openAiReason: string | undefined): string {
  switch (openAiReason) {
    case 'length':
      return 'max_tokens'
    case 'tool_calls':
      return 'tool_use'
    case 'stop':
      return 'end_turn'
    default:
      // Anthropic 没有 'stop'；未知一律归 end_turn（可预期、客户端不会卡住）。
      return 'end_turn'
  }
}

/** Anthropic 的 usage 形状。 */
export function toAnthropicUsage(usage: unknown): Record<string, number> {
  const u = (usage ?? {}) as {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
  const input = u.prompt_tokens ?? 0
  const output = u.completion_tokens ?? 0
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0
  return {
    input_tokens: input,
    output_tokens: output,
    // ⚠️ 这两个字段 Anthropic 客户端会读（尤其 Claude Code 用它算缓存命中）。
    // 缺失时多数客户端仍能工作，故仅在有值时给非零。
    ...(cached > 0 ? { cache_read_input_tokens: cached } : {}),
  }
}

// ─────────────────────────── 流式：StreamChunk → Anthropic SSE ───────────────────────────

/**
 * Anthropic 的流式事件序列（与 OpenAI 的「一串同构 delta 帧」完全不同）：
 *
 * ```
 * message_start           ← 含 message 骨架（id/model/role/usage.input_tokens）
 * content_block_start     ← 每个内容块一次（text / thinking / tool_use）
 * content_block_delta     ← 增量（text_delta / thinking_delta / input_json_delta）
 * content_block_stop
 * message_delta           ← 收尾时带 stop_reason 与 usage.output_tokens
 * message_stop
 * ```
 *
 * ⚠️ **块索引（index）必须严格递增且与实际内容块对应**：Claude 客户端
 * （含 Claude Code）按 index 归并增量，索引错乱会导致正文与工具调用串位。
 * 故这里维护一个状态机，按 DSH 的 chunk 类型惰性开启/关闭内容块。
 *
 * ⚠️ **没有 `[DONE]`**：Anthropic 用 `message_stop` 收尾。多发包会让
 * 严格客户端报解析错误。
 */
export async function* streamChunksToAnthropicSse(
  chunks: AsyncIterable<StreamChunk>,
  options: { id: string; model: string },
): AsyncGenerator<string, void, undefined> {
  const send = (event: string, data: Record<string, unknown>): string =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

  let inputTokens = 0
  let outputTokens = 0
  let nextIndex = 0
  /** 当前打开的内容块：undefined 表示没有。 */
  let openBlock: { index: number; kind: 'text' | 'thinking' | 'tool_use' } | undefined
  let stopReason = 'end_turn'
  /** 工具调用 id → 块索引（同一工具的分片要落在同一块里）。 */
  const toolBlockIndex = new Map<string, number>()

  // ① message_start：即使还没有任何内容也要先发（客户端据此初始化状态机）。
  yield send('message_start', {
    type: 'message_start',
    message: {
      id: options.id,
      type: 'message',
      role: 'assistant',
      model: options.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })

  const closeBlock = (): string => {
    if (openBlock === undefined) return ''
    const frame = send('content_block_stop', { type: 'content_block_stop', index: openBlock.index })
    openBlock = undefined
    return frame
  }

  const openText = (kind: 'text' | 'thinking'): string => {
    if (openBlock?.kind === kind) return ''
    let out = closeBlock()
    const index = nextIndex++
    openBlock = { index, kind }
    out += send('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: kind === 'text'
        ? { type: 'text', text: '' }
        // Anthropic 用 `thinking` 块承载推理内容（Claude 系）；signature 字段
        // 在真 Claude 上必填，但我们是转发第三方模型的思考内容，客户端只读
        // `thinking` 文本，给空串即可被接受。
        : { type: 'thinking', thinking: '', signature: '' },
    })
    return out
  }

  for await (const chunk of chunks) {
    switch (chunk.type) {
      case 'text-delta': {
        if (chunk.text.length === 0) break
        let out = openText('text')
        if (openBlock !== undefined) {
          out += send('content_block_delta', {
            type: 'content_block_delta',
            index: openBlock.index,
            delta: { type: 'text_delta', text: chunk.text },
          })
        }
        yield out
        break
      }
      case 'reasoning-delta': {
        if (chunk.text.length === 0) break
        let out = openText('thinking')
        if (openBlock !== undefined) {
          out += send('content_block_delta', {
            type: 'content_block_delta',
            index: openBlock.index,
            delta: { type: 'thinking_delta', thinking: chunk.text },
          })
        }
        yield out
        break
      }
      case 'tool-call-delta': {
        const id = String(chunk.id)
        let index = toolBlockIndex.get(id)
        if (index === undefined) {
          // 新工具：关掉当前块，开一个 tool_use 块。
          let out = closeBlock()
          index = nextIndex++
          toolBlockIndex.set(id, index)
          openBlock = { index, kind: 'tool_use' }
          out += send('content_block_start', {
            type: 'content_block_start',
            index,
            content_block: {
              type: 'tool_use',
              id,
              name: chunk.name ?? '',
              input: {},
            },
          })
          yield out
        }
        if (chunk.argumentsDelta.length > 0) {
          yield send('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: chunk.argumentsDelta },
          })
        }
        break
      }
      case 'usage': {
        inputTokens = chunk.usage.inputTokens ?? inputTokens
        outputTokens = chunk.usage.outputTokens ?? outputTokens
        break
      }
      case 'finish': {
        stopReason = toAnthropicStopReason(chunk.reason ? finishReasonToOpenAi(chunk.reason) : undefined)
        break
      }
      default:
        break
    }
  }

  // ② 收尾：关块 → message_delta（带 stop_reason 与 output usage）→ message_stop
  yield closeBlock()
  yield send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  })
  yield send('message_stop', { type: 'message_stop' })
}

/** 把 DSH 的 FinishReason 归一成 OpenAI 的字符串（复用 protocol.ts 的映射语义）。 */
function finishReasonToOpenAi(reason: FinishReason): string {
  switch (reason.kind) {
    case 'stop': return 'stop'
    case 'tool-calls': return 'tool_calls'
    case 'max-tokens': return 'length'
    default: return 'stop'
  }
}

// ─────────────────────────── 非流式：OpenAI 完成 → Anthropic 消息 ───────────────────────────

/**
 * 把 OpenAI 非流式完成对象翻译成 Anthropic Messages 响应。
 *
 * ⚠️ 思考内容**不放进 content**：Anthropic 的 `thinking` 块要求 `signature`
 * 字段且校验严格，伪造会 400；多数客户端也只是把 thinking 当附加信息。
 * 故这里只保留 text 与 tool_use 块 —— 正文与工具调用是功能必需的。
 */
export function openAiCompletionToAnthropic(
  completion: {
    id: string
    model: string
    choices: {
      message: { content?: string; reasoning_content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }
      finish_reason: string
    }[]
    usage?: unknown
  },
): Record<string, unknown> {
  const choice = completion.choices[0]
  const content: Record<string, unknown>[] = []

  const text = choice?.message.content ?? ''
  if (text.length > 0) content.push({ type: 'text', text })

  for (const call of choice?.message.tool_calls ?? []) {
    let input: unknown = {}
    try {
      input = JSON.parse(call.function.arguments.length > 0 ? call.function.arguments : '{}')
    } catch {
      // 上游给出非法 JSON（罕见但存在）：退化成空对象，保住工具调用的结构性，
      // 避免整个响应因一段坏 JSON 而失败。
      input = {}
    }
    content.push({ type: 'tool_use', id: call.id, name: call.function.name, input })
  }

  return {
    id: completion.id,
    type: 'message',
    role: 'assistant',
    model: completion.model,
    content,
    stop_reason: toAnthropicStopReason(choice?.finish_reason),
    stop_sequence: null,
    usage: toAnthropicUsage(completion.usage),
  }
}
