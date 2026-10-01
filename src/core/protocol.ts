/**
 * OpenAI ⇄ DSH 协议转换层（网关的核心）。
 *
 * ## 为什么需要这一层
 *
 * vendor 的适配器（`buddy-adapter.ts` 等）输入输出都用 DSH 的内部协议：
 *   - 输入：`GenerateOptions`（含 `messages: RequestMessage[]`）
 *   - 输出：`AsyncIterable<StreamChunk>`
 *
 * 网关要对外的却是 **OpenAI 兼容协议**。两者形状不同，但**语义基本同构**
 * （DSH 本来就是把各家协议归一化后的中间表示），所以转换是"字段搬运"
 * 而非"重新实现协议"。
 *
 * ## 为什么不改适配器
 *
 * 改适配器意味着 4 个文件、每个约 12 处输出语句，且以后无法从上游同步。
 * 在这一层统一转换只需**一个文件**，且适配器保持零改动。
 *
 * ## 两处必须小心的语义差异
 *
 * 1. **`block-end` 里的 `tool-call` 块**：适配器会在流末尾补一个完整的
 *    tool-call 块，而 OpenAI 流式协议要求 tool_calls 是**增量的**。若两者
 *    都转出去，客户端会收到重复的工具调用。故本层**只转增量**
 *    （`tool-call-delta`），`block-end` 仅用于判断"该工具调用结束"。
 *
 * 2. **`reasoning-delta`**：OpenAI 官方格式没有思维链字段，但社区约定用
 *    `delta.reasoning_content`（DeepSeek / 智谱等都用这个）。本层采用该约定，
 *    并在非流式响应里映射为 `message.reasoning_content`。
 */
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmResolvedModelInfo,
  RequestMessage,
  StreamChunk,
  ToolSchema,
  TokenUsage,
  FinishReason,
} from '@deepseek-ai/dsh-llm'

// ─────────────────────────── OpenAI 请求/响应类型 ───────────────────────────

export interface OpenAiChatRequest {
  model: string
  messages: OpenAiMessage[]
  stream?: boolean
  temperature?: number
  top_p?: number
  max_tokens?: number
  max_completion_tokens?: number
  stop?: string | string[]
  tools?: OpenAiTool[]
  tool_choice?: unknown
  reasoning_effort?: string
  /** 部分客户端会带；忽略即可。 */
  [key: string]: unknown
}

export interface OpenAiMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool'
  content?: string | OpenAiContentPart[] | null
  name?: string
  tool_calls?: OpenAiToolCall[]
  tool_call_id?: string
  reasoning_content?: string
}

export interface OpenAiContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string; detail?: string }
}

export interface OpenAiTool {
  type: 'function'
  function: { name: string; description?: string; parameters?: Record<string, unknown> }
}

export interface OpenAiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
  index?: number
}

// ─────────────────────────── 请求：OpenAI → GenerateOptions ───────────────────────────

/** 把 OpenAI 的 content（字符串或多模态数组）压成 DSH 的纯文本 + 图片列表。 */
function splitContent(content: OpenAiMessage['content']): {
  text: string
  images: { url: string }[]
} {
  if (content === null || content === undefined) return { text: '', images: [] }
  if (typeof content === 'string') return { text: content, images: [] }
  const texts: string[] = []
  const images: { url: string }[] = []
  for (const part of content) {
    if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text)
    else if (part.type === 'image_url' && part.image_url?.url) images.push({ url: part.image_url.url })
  }
  return { text: texts.join('\n'), images }
}

/** 把 OpenAI 的消息数组转成 DSH 的 RequestMessage[]。 */
export function toDshMessages(messages: OpenAiMessage[]): {
  messages: RequestMessage[]
  system: string | undefined
} {
  const out: RequestMessage[] = []
  const systemParts: string[] = []

  for (const message of messages) {
    const { text, images } = splitContent(message.content)

    if (message.role === 'system' || message.role === 'developer') {
      if (text.length > 0) systemParts.push(text)
      continue
    }

    if (message.role === 'user') {
      // ⚠️ DSH 的 user 消息 content 是块数组；图片块需要 attachment 引用
      // （由附件服务提供），网关没有附件服务，故这里把图片降级为文本说明，
      // 避免静默丢图导致模型看到空内容。
      const blocks: Record<string, unknown>[] = []
      for (const image of images) {
        blocks.push({ type: 'text', text: `[image omitted: ${image.url.slice(0, 64)}]` })
      }
      blocks.push({ type: 'text', text })
      out.push({
        role: 'user',
        content: blocks.length === 1 ? text : blocks,
      } as unknown as RequestMessage)
      continue
    }

    if (message.role === 'assistant') {
      const blocks: Record<string, unknown>[] = []
      // ⚠️ vendor 适配器要求 assistant 消息**始终**携带 reasoning_content 字段
      // （推理模型缺失会 400）。这里统一补上空串。
      if (typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0) {
        blocks.push({ type: 'reasoning', text: message.reasoning_content })
      }
      if (text.length > 0 || (message.tool_calls ?? []).length === 0) {
        blocks.push({ type: 'text', text })
      }
      for (const call of message.tool_calls ?? []) {
        blocks.push({
          type: 'tool-call',
          id: call.id,
          name: call.function?.name ?? '',
          arguments: call.function?.arguments ?? '{}',
        })
      }
      out.push({ role: 'assistant', content: blocks } as unknown as RequestMessage)
      continue
    }

    if (message.role === 'tool') {
      out.push({
        role: 'tool',
        toolCallId: message.tool_call_id ?? '',
        content: text,
      } as unknown as RequestMessage)
    }
  }

  return { messages: out, system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined }
}

/** 把 OpenAI 的 tools 转成 DSH 的 ToolSchema[]。 */
export function toDshTools(tools: OpenAiTool[] | undefined): ToolSchema[] | undefined {
  if (!tools || tools.length === 0) return undefined
  const out: ToolSchema[] = []
  for (const tool of tools) {
    if (tool.type !== 'function' || !tool.function?.name) continue
    out.push({
      name: tool.function.name,
      description: tool.function.description ?? '',
      parameters: tool.function.parameters ?? { type: 'object', properties: {} },
    })
  }
  return out.length > 0 ? out : undefined
}

export interface ToGenerateOptionsContext {
  provider: string
  model: string
  sessionId: string
}

/** OpenAI 请求 → DSH GenerateOptions。 */
export function toGenerateOptions(
  request: OpenAiChatRequest,
  context: ToGenerateOptionsContext,
): GenerateOptions {
  const { messages, system } = toDshMessages(request.messages ?? [])
  const tools = toDshTools(request.tools)
  const stop = typeof request.stop === 'string' ? [request.stop] : request.stop
  const maxTokens = request.max_tokens ?? request.max_completion_tokens

  const options: GenerateOptions = {
    provider: context.provider,
    model: context.model,
    messages,
  }
  if (system !== undefined) options.system = system
  if (tools !== undefined) options.tools = tools
  if (typeof request.temperature === 'number') options.temperature = request.temperature
  if (typeof maxTokens === 'number' && Number.isFinite(maxTokens)) options.maxTokens = maxTokens
  if (Array.isArray(stop) && stop.length > 0) options.stop = stop
  if (typeof request.reasoning_effort === 'string' && request.reasoning_effort.length > 0) {
    options.reasoningEffort = request.reasoning_effort as GenerateOptions['reasoningEffort']
  }
  return options
}

// ─────────────────────────── 响应：StreamChunk → OpenAI SSE ───────────────────────────

export interface OpenAiChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: {
    index: number
    delta: Record<string, unknown>
    finish_reason: string | null
  }[]
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: { cached_tokens: number }
    completion_tokens_details?: { reasoning_tokens: number }
  }
}

/** 把 DSH 的 finish reason 映射为 OpenAI 的 finish_reason 字符串。 */
export function toOpenAiFinishReason(reason: FinishReason | undefined): string {
  if (!reason) return 'stop'
  switch (reason.kind) {
    case 'stop':
      return 'stop'
    case 'tool-calls':
      return 'tool_calls'
    case 'max-tokens':
      return 'length'
    case 'error':
    case 'aborted':
      return 'stop'
    default:
      return 'stop'
  }
}

export function toOpenAiUsage(usage: TokenUsage | undefined): OpenAiChunk['usage'] {
  if (!usage) return undefined
  const prompt = usage.inputTokens ?? 0
  const completion = usage.outputTokens ?? 0
  const result: NonNullable<OpenAiChunk['usage']> = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: usage.totalTokens ?? prompt + completion,
  }
  if (usage.cacheReadTokens !== undefined && usage.cacheReadTokens > 0) {
    result.prompt_tokens_details = { cached_tokens: usage.cacheReadTokens }
  }
  if (usage.reasoningTokens !== undefined && usage.reasoningTokens > 0) {
    result.completion_tokens_details = { reasoning_tokens: usage.reasoningTokens }
  }
  return result
}

/**
 * 把 DSH 的 chunk 流翻译成 OpenAI SSE 帧。
 *
 * 返回的是**已序列化的 SSE 文本**（含 `data: ` 前缀与空行结尾），
 * 便于直接写进 HTTP 响应；`[DONE]` 由调用方在流结束时补。
 */
export async function* streamChunksToSse(
  chunks: AsyncIterable<StreamChunk>,
  options: { id: string; model: string; created: number },
): AsyncGenerator<string, void, undefined> {
  const toolIndexById = new Map<string, number>()
  let nextToolIndex = 0
  let sentRole = false

  const frame = (delta: Record<string, unknown>, finishReason: string | null = null): string => {
    const chunk: OpenAiChunk = {
      id: options.id,
      object: 'chat.completion.chunk',
      created: options.created,
      model: options.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    }
    return `data: ${JSON.stringify(chunk)}\n\n`
  }

  for await (const chunk of chunks) {
    // 首个非空帧前先补 role（OpenAI 客户端普遍期望）。
    const ensureRole = (): string => {
      if (sentRole) return ''
      sentRole = true
      return frame({ role: 'assistant', content: '' })
    }

    switch (chunk.type) {
      case 'text-delta': {
        if (chunk.text.length === 0) break
        yield ensureRole() + frame({ content: chunk.text })
        break
      }
      case 'reasoning-delta': {
        if (chunk.text.length === 0) break
        yield ensureRole() + frame({ reasoning_content: chunk.text })
        break
      }
      case 'tool-call-delta': {
        const id = String(chunk.id)
        let index = toolIndexById.get(id)
        if (index === undefined) {
          index = nextToolIndex++
          toolIndexById.set(id, index)
        }
        // ⚠️ 首次出现必须带 id 与 name；后续分片只带 arguments。
        const toolCall: Record<string, unknown> = {
          index,
          ...(chunk.name !== undefined && chunk.name.length > 0
            ? { id, type: 'function', function: { name: chunk.name, arguments: '' } }
            : {}),
        }
        if (chunk.name === undefined || chunk.name.length === 0) {
          // 后续分片：沿用已有的 id，但 OpenAI 客户端按 index 归并。
          toolCall.id = id
          toolCall.type = 'function'
          toolCall.function = { arguments: chunk.argumentsDelta }
        } else {
          ;(toolCall.function as { name: string; arguments: string }).arguments = chunk.argumentsDelta
        }
        yield ensureRole() + frame({ tool_calls: [toolCall] })
        break
      }
      case 'usage': {
        const usage = toOpenAiUsage(chunk.usage)
        if (usage) {
          const withUsage: OpenAiChunk = {
            id: options.id,
            object: 'chat.completion.chunk',
            created: options.created,
            model: options.model,
            choices: [],
            usage,
          }
          yield `data: ${JSON.stringify(withUsage)}\n\n`
        }
        break
      }
      case 'finish': {
        yield ensureRole() + frame({}, toOpenAiFinishReason(chunk.reason))
        break
      }
      // block-start / block-end 不直接映射到 OpenAI 帧：
      // block-end 的 tool-call 块是"完整版"，与前面已发的增量重复，故忽略。
      default:
        break
    }
  }
}

// ─────────────────────────── 非流式聚合 ───────────────────────────

export interface OpenAiCompletion {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: {
    index: number
    message: {
      role: 'assistant'
      content: string
      reasoning_content?: string
      tool_calls?: OpenAiToolCall[]
    }
    finish_reason: string
  }[]
  usage?: OpenAiChunk['usage']
}

/** 把 chunk 流聚合成一个非流式响应（OpenAI `/v1/chat/completions` 的 `stream:false`）。 */
export async function collectCompletion(
  chunks: AsyncIterable<StreamChunk>,
  options: { id: string; model: string; created: number },
): Promise<OpenAiCompletion> {
  let content = ''
  let reasoning = ''
  let finishReason = 'stop'
  let usage: OpenAiChunk['usage']
  const toolCalls = new Map<number, { id: string; name: string; args: string }>()
  let nextToolIndex = 0

  for await (const chunk of chunks) {
    switch (chunk.type) {
      case 'text-delta':
        content += chunk.text
        break
      case 'reasoning-delta':
        reasoning += chunk.text
        break
      case 'tool-call-delta': {
        const id = String(chunk.id)
        let index: number | undefined
        for (const [k, v] of toolCalls) if (v.id === id) index = k
        if (index === undefined) {
          index = nextToolIndex++
          toolCalls.set(index, { id, name: chunk.name ?? '', args: '' })
        }
        const entry = toolCalls.get(index)
        if (entry) {
          if (chunk.name !== undefined && chunk.name.length > 0) entry.name = chunk.name
          entry.args += chunk.argumentsDelta
        }
        break
      }
      case 'usage':
        usage = toOpenAiUsage(chunk.usage)
        break
      case 'finish':
        finishReason = toOpenAiFinishReason(chunk.reason)
        break
      default:
        break
    }
  }

  const message: OpenAiCompletion['choices'][0]['message'] = { role: 'assistant', content }
  if (reasoning.length > 0) message.reasoning_content = reasoning
  if (toolCalls.size > 0) {
    message.tool_calls = [...toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({
        id: v.id,
        type: 'function' as const,
        function: { name: v.name, arguments: v.args.length > 0 ? v.args : '{}' },
      }))
  }

  return {
    id: options.id,
    object: 'chat.completion',
    created: options.created,
    model: options.model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  }
}

// ─────────────────────────── 模型列表 ───────────────────────────

export interface OpenAiModel {
  id: string
  object: 'model'
  created: number
  owned_by: string
}

export function toOpenAiModels(
  models: readonly (LlmModelInfo | LlmResolvedModelInfo)[],
  provider: string,
  created: number,
): OpenAiModel[] {
  return models.map((m) => ({ id: m.id, object: 'model', created, owned_by: provider }))
}
