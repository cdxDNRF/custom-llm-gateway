/**
 * **OpenAI 兼容上游**的通用适配器：把任意 `POST /v1/chat/completions`
 * 的服务当作一个供应商的推理后端。
 *
 * ## 为什么需要它
 *
 * 有些能力我们**不想自己实现**，但已经有成熟实现 —— 典型例子是
 * [AIStudio2API](https://github.com/Mag1cFall/AIStudio2API)：它把 AI Studio
 * 的 **Playground 与 Build 两条独立额度通道**（都需要 Cookie + SAPISID 签名 +
 * WAA/BotGuard proof）封装成了标准 OpenAI 兼容端点。
 *
 * 那套 WAA 机制需要执行 Google 混淆过的 BotGuard VM —— 上游项目为此写了
 * 849 行文档并 fork 了 goja。自己重写不现实，**把它当作内部上游**是最理性的选择。
 *
 * ⇒ 本适配器只做「协议搬运」：`GenerateOptions` ⇄ OpenAI Chat Completions，
 *   不碰任何认证/额度逻辑（那是上游的事）。
 *
 * ## 与 `aistudio-adapter.ts` 的区别（两者不要混）
 *
 * | | `aistudio-adapter` | 本文件 |
 * |---|---|---|
 * | 上游 | **官方** `generativelanguage` | **第三方** OpenAI 兼容服务 |
 * | 认证 | 我们带 `x-goog-api-key` | 可能完全不需要（本机回环）|
 * | 额度 | API Key 免费层 | 取决于上游（AIStudio2API = 网页两条额度）|
 * | 协议 | Gemini REST | OpenAI Chat Completions |
 */
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  LlmModelInfo, LlmResolvedModelInfo, StreamChunk, GenerateOptions,
} from '@deepseek-ai/dsh-llm'

/** 上游一条 Chat Completions 流帧（只取我们用到的字段）。 */
interface UpstreamChunk {
  choices?: {
    index?: number
    delta?: { role?: string; content?: string | null; reasoning_content?: string | null; tool_calls?: UpstreamToolCall[] }
    finish_reason?: string | null
  }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

interface UpstreamToolCall {
  index?: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

export interface OpenAiCompatAdapterOptions {
  /** 上游根地址，如 `http://127.0.0.1:2048`（不带 `/v1`）。 */
  baseUrl: string
  /** 上游的认证密钥（留空则不带 Authorization —— 本机回环通常免密）。 */
  apiKey?: string
  /**
   * 模型目录获取方式。
   *
   * ⚠️ 用**函数**而非静态表：上游模型目录会随 AI Studio 更新（它有实时
   *    `ListModels`），写死会很快过期。
   */
  listModels: () => Promise<readonly { id: string; name?: string; contextWindow?: number }[]>
  /** 诊断日志。 */
  warn?: (message: string) => void
  /** 单次请求超时（毫秒）。默认 5 分钟。 */
  timeoutMs?: number
}

/** 默认超时：5 分钟（网页额度通道的推理可能较慢）。 */
const DEFAULT_TIMEOUT_MS = 5 * 60_000

/**
 * 把 OpenAI 兼容上游包装成 `LlmAdapter`。
 *
 * 🔑 认证：仅当 `apiKey` 非空时带 `Authorization: Bearer`。
 *    本机回环的上游（如 AIStudio2API 的 `PROXY_API_KEY=` 留空）**不需要**。
 */
export class OpenAiCompatAdapter extends LlmAdapter {
  private readonly options: OpenAiCompatAdapterOptions
  /** 目录缓存（`undefined` 表示还没拉过）。 */
  private catalog: readonly { id: string; name?: string; contextWindow?: number }[] | undefined

  constructor(options: OpenAiCompatAdapterOptions) {
    super()
    this.options = options
  }

  override providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: 'AI Studio (Web / Playground+Build)' }
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    if (this.catalog === undefined) {
      this.catalog = await this.options.listModels()
    }
    return this.catalog.map((m) => ({
      provider: 'aistudio2api',
      id: m.id,
      name: m.name ?? m.id,
    }))
  }

  /**
   * 完整目录（不套黑名单），供 Web UI 的「模型管理」用。
   *
   * ⚠️ 必须**同步**：契约要求 `readonly []`，写成 async 会让
   *    `[...all]` / `all.map` 抛 `TypeError: all is not iterable`。
   *    故这里返回**最近一次 listModels 的结果**（未拉过则为空），
   *    不在这里做网络请求。
   */
  listAllModels(): readonly { id: string; name: string }[] {
    return (this.catalog ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id }))
  }

  /** 丢弃目录缓存（供「重拉模型目录」用）。 */
  clearCatalog(): void {
    this.catalog = undefined
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const entry = (this.catalog ?? []).find((m) => m.id === model)
    return {
      provider,
      id: model,
      name: entry?.name ?? model,
      // ⚠️ 上游没给就**省略** contextWindow（= 未知），不编造数字。
      ...(entry?.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
      maxTokens: 65_536,
      inputModalities: ['text', 'image'],
    } as LlmResolvedModelInfo
  }

  async *stream(rawOptions: GenerateOptions): AsyncIterable<StreamChunk> {
    const options = rawOptions as GenerateOptions & { useNonStream?: boolean }
    const model = String(options.model)
    const body = toUpstreamBody(options, model)

    const controller = new AbortController()
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()

    let response: Response
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      // 仅当配了密钥才带（本机回环免密）。
      if (this.options.apiKey !== undefined && this.options.apiKey.length > 0) {
        headers.authorization = `Bearer ${this.options.apiKey}`
      }
      response = await fetch(`${this.options.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      clearTimeout(timer)
      const aborted = (error as { name?: string }).name === 'AbortError'
      throw new LlmError(
        aborted
          ? `aistudio2api: 上游 ${Math.round(timeoutMs / 1000)} 秒无响应（模型 " ${model} " 可能正忙或额度受限）。`
          : `aistudio2api: 无法连接上游 ${this.options.baseUrl} —— ${String(error)}`,
        'SERVER',
      )
    }

    if (response.status !== 200) {
      clearTimeout(timer)
      const text = await response.text().catch(() => '')
      throw new LlmError(
        `aistudio2api: HTTP ${response.status} — ${describeError(response.status, text)}`,
        response.status === 429 ? 'QUOTA_EXCEEDED'
          : response.status === 401 || response.status === 403 ? 'FORBIDDEN' : 'SERVER',
        { status: response.status },
      )
    }

    const stream = response.body
    if (stream === null) {
      clearTimeout(timer)
      throw new LlmError('aistudio2api: 响应体为空', 'SERVER')
    }

    try {
      yield* parseOpenAiSse(stream)
    } finally {
      clearTimeout(timer)
    }
  }
}

/** `GenerateOptions` → 上游 Chat Completions 请求体。 */
function toUpstreamBody(options: GenerateOptions, model: string): Record<string, unknown> {
  const messages: Record<string, unknown>[] = []

  // 显式 system 槽（一次性调用方会传）。
  if (typeof options.system === 'string' && options.system.length > 0) {
    messages.push({ role: 'system', content: options.system })
  }

  for (const message of options.messages as readonly {
    role?: string
    content?: unknown
    toolCalls?: unknown
    toolCallId?: unknown
    name?: unknown
  }[]) {
    const role = message.role ?? 'user'
    if (role === 'tool') {
      messages.push({
        role: 'tool',
        tool_call_id: typeof message.toolCallId === 'string' ? message.toolCallId : '',
        content: textOf(message.content),
      })
      continue
    }
    const toolCalls = asToolCalls(message.toolCalls)
    if (toolCalls !== undefined) {
      messages.push({ role, content: textOf(message.content) || null, tool_calls: toolCalls })
      continue
    }
    messages.push({ role, content: textOf(message.content) })
  }

  const body: Record<string, unknown> = { model, messages, stream: true }
  // ⚠️ 必须显式要 usage，否则上游流末不带 token 数（用量统计会全是 0）。
  body.stream_options = { include_usage: true }

  if (typeof options.maxTokens === 'number') body.max_tokens = options.maxTokens
  if (typeof options.temperature === 'number') body.temperature = options.temperature
  if (Array.isArray(options.stop) && options.stop.length > 0) body.stop = options.stop
  if (typeof options.reasoningEffort === 'string') body.reasoning_effort = options.reasoningEffort

  if (Array.isArray(options.tools) && options.tools.length > 0) {
    body.tools = options.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        // 上游是 OpenAI 协议 ⇒ 用标准 `parameters`（完整 JSON Schema 即可，
        // 不需要像 Gemini 那样换 `parametersJsonSchema`）。
        parameters: tool.parameters,
      },
    }))
  }
  return body
}

/** DSH 的 content（字符串或块数组）→ 纯文本。 */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as readonly { type?: string; text?: string }[])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

/** DSH 的 toolCalls → 上游 `tool_calls` 形状。 */
function asToolCalls(raw: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const out: Record<string, unknown>[] = []
  for (const call of raw as readonly { id?: unknown; name?: unknown; arguments?: unknown }[]) {
    if (typeof call.name !== 'string') continue
    out.push({
      id: typeof call.id === 'string' ? call.id : `call_${out.length}`,
      type: 'function',
      function: {
        name: call.name,
        arguments: typeof call.arguments === 'string' ? call.arguments : '{}',
      },
    })
  }
  return out.length === 0 ? undefined : out
}

/**
 * 解析上游的 OpenAI 流式 SSE → DSH chunk。
 *
 * ⚠️ 必须处理**行跨包**：TCP 不保证一次 `read` 对应一行 SSE，故用累积缓冲
 *    按 `\n` 切。否则长响应会被截断（表现为"回答不完整"）。
 */
async function* parseOpenAiSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamChunk, void, unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  /** 当前打开的块索引（文本/思考各一个，已开则复用）。 */
  let textIndex: number | undefined
  let reasoningIndex: number | undefined
  const toolIndexMap = new Map<number, number>()
  let nextIndex = 0
  let finishReason = 'stop'

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // 按行切（保留最后一行的残余到下一轮）。
      for (;;) {
        const nl = buffer.indexOf('\n')
        if (nl < 0) break
        const line = buffer.slice(0, nl).replace(/\r$/, '')
        buffer = buffer.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload.length === 0 || payload === '[DONE]') continue

        let chunk: UpstreamChunk
        try { chunk = JSON.parse(payload) as UpstreamChunk } catch { continue }

        // usage 可能单独一帧（stream_options.include_usage）。
        if (chunk.usage !== undefined) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: chunk.usage.prompt_tokens ?? 0,
              outputTokens: chunk.usage.completion_tokens ?? 0,
            },
          } as StreamChunk
        }

        const choice = chunk.choices?.[0]
        if (choice === undefined) continue
        const delta = choice.delta

        // 正文
        if (typeof delta?.content === 'string' && delta.content.length > 0) {
          if (textIndex === undefined) {
            textIndex = nextIndex++
            yield { type: 'block-start', index: textIndex, blockType: 'text' } as StreamChunk
          }
          yield { type: 'text-delta', index: textIndex, text: delta.content } as StreamChunk
        }

        // 思考（部分上游用 reasoning_content）
        if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
          if (reasoningIndex === undefined) {
            reasoningIndex = nextIndex++
            yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' } as StreamChunk
          }
          yield {
            type: 'reasoning-delta', index: reasoningIndex, text: delta.reasoning_content,
          } as StreamChunk
        }

        // 工具调用（上游按 index 分片下发）
        if (Array.isArray(delta?.tool_calls)) {
          for (const call of delta.tool_calls) {
            const upstreamIndex = call.index ?? 0
            let index = toolIndexMap.get(upstreamIndex)
            if (index === undefined) {
              index = nextIndex++
              toolIndexMap.set(upstreamIndex, index)
              yield { type: 'block-start', index, blockType: 'tool-call' } as StreamChunk
            }
            yield {
              type: 'tool-call-delta',
              index,
              id: (call.id ?? `call_${index}`) as never,
              ...(call.function?.name !== undefined ? { name: call.function.name } : {}),
              argumentsDelta: call.function?.arguments ?? '',
            } as StreamChunk
          }
        }

        if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) {
          finishReason = choice.finish_reason
        }
      }
    }
  } finally {
    try { await reader.cancel() } catch { /* 忽略 */ }
  }

  // 收尾：关掉所有打开的块。
  if (textIndex !== undefined) {
    yield {
      type: 'block-end', index: textIndex,
      block: { type: 'text', text: '' },
    } as StreamChunk
  }
  if (reasoningIndex !== undefined) {
    yield {
      type: 'block-end', index: reasoningIndex,
      block: { type: 'reasoning', text: '' },
    } as StreamChunk
  }
  for (const index of toolIndexMap.values()) {
    yield {
      type: 'block-end', index,
      block: { type: 'tool-call', id: `call_${index}`, name: '', arguments: '{}' },
    } as StreamChunk
  }
  yield {
    type: 'finish',
    reason: (finishReason === 'tool_calls' ? 'tool-calls'
      : finishReason === 'length' ? 'length' : 'stop') as never,
  } as StreamChunk
}

/** 把上游错误翻译成可行动的提示。 */
function describeError(status: number, raw: string): string {
  let message = raw
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } }
    if (typeof parsed.error?.message === 'string') message = parsed.error.message
  } catch { /* 非 JSON：用原文 */ }
  const brief = message.replace(/\s+/g, ' ').trim().slice(0, 400)

  if (status === 429) return `额度/限流用尽（上游两条链路均受限）。原文：${brief}`
  if (status === 403) return `无权限（403）—— 上游账户可能需重新登录。原文：${brief}`
  if (status === 404) return `模型不存在（404）—— 该模型可能已下线。原文：${brief}`
  if (status === 503 || /high demand|overloaded/i.test(message)) {
    return '该模型**当前过载**（上游临时性，非额度问题）—— 换时间或换模型重试。'
  }
  return brief
}
