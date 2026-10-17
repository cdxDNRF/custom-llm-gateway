/**
 * Gemini **REST 协议**（`generativelanguage.googleapis.com`）的请求构造与响应解码。
 *
 * ## 为什么单独一个模块
 *
 * 本网关有**三个**走 Gemini 系协议的渠道，它们的传输与认证完全不同，
 * 但**请求体与响应体是同一种形状**：
 *
 * | 渠道 | 端点 | 认证 | 传输 |
 * |---|---|---|---|
 * | `gemini`（反重力） | `daily-cloudcode-pa` + `/v1internal:*` | OAuth Bearer + 身份头 | fetch |
 * | **`aistudio`**（本模块的主要使用者） | `generativelanguage/v1beta/models/*` | `x-goog-api-key` | fetch |
 * | `build`（AI Studio App 反代） | 同 aistudio | 由宿主页代劳 | WebSocket 中继 |
 *
 * 反重力那个用的是 **cloudcode 信封**（`{model, project, request:{...}}`，
 * 见 vendor 的 `translateGeminiRequest`），与本模块的**裸 REST** 不同，
 * 故不复用。
 *
 * ## 实测约束（都是踩过的坑）
 *
 * · `systemInstruction` 必须是对象 `{parts:[...]}`，**不能是裸字符串**
 * · 工具参数必须用 **`parametersJsonSchema`**，不是 `parameters`
 *   （后者只接受 OpenAPI 子集；Build 通道上连无参数的 tool 都 400）
 * · 请求以 **model turn 结尾**（预填充）时，部分模型会 400
 *   （`gemini-3.8-flash`: `Requests ending with a model turn are not supported.`）
 */
import type { StreamChunk, GenerateOptions } from '@deepseek-ai/dsh-llm'

/** Gemini REST 端点基址。 */
export const GEMINI_REST_BASE = 'https://generativelanguage.googleapis.com/v1beta'

/** 构造「取消预填充」后的请求体（末条不是 model turn 时返回 `undefined`）。 */
export function stripPrefill(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const contents = body.contents
  if (!Array.isArray(contents) || contents.length === 0) return undefined
  const last = contents[contents.length - 1] as { role?: unknown } | undefined
  if (last?.role !== 'model') return undefined
  return { ...body, contents: contents.slice(0, -1) }
}

/**
 * DSH 的 `GenerateOptions` → Gemini REST 请求体（**裸 REST**，无信封）。
 *
 * @param options DSH 生成参数
 * @returns 可直接 `JSON.stringify` 后 POST 到 `/v1beta/models/<id>:generateContent` 的 body
 */
export function toGeminiRestBody(options: GenerateOptions): Record<string, unknown> {
  const contents: Record<string, unknown>[] = []
  const systemParts: string[] = []

  for (const message of options.messages as readonly {
    role?: string
    content?: unknown
  }[]) {
    // ⚠️ Gemini 只认 `user` / `model` 两种角色；`system` 单独走 systemInstruction。
    const role = message.role === 'assistant' ? 'model' : 'user'
    const parts = toParts(message.content)
    if (parts.length === 0) continue
    if (message.role === 'system') {
      systemParts.push(...parts.map((p) => String(p.text ?? '')))
      continue
    }
    contents.push({ role, parts })
  }

  const body: Record<string, unknown> = { contents }
  if (systemParts.length > 0) {
    // ⚠️ 必须是对象 `{parts:[...]}` —— 裸字符串会让上游 400（实测）。
    body.systemInstruction = { parts: systemParts.map((text) => ({ text })) }
  }

  const generationConfig: Record<string, unknown> = {}
  if (typeof options.maxTokens === 'number') generationConfig.maxOutputTokens = options.maxTokens
  if (typeof options.temperature === 'number') generationConfig.temperature = options.temperature
  if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig

  if (Array.isArray(options.tools) && options.tools.length > 0) {
    body.tools = [{
      functionDeclarations: options.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        // ⚠️⚠️ 必须是 **`parametersJsonSchema`**，不是 `parameters`
        //    （真实缺陷，2026-10-17 用户报障：opencode agent 场景恒 400
        //    `Request contains an invalid argument.`）。
        //
        //    两者语义不同：
        //      · `parameters`           —— 只接受 **OpenAPI 子集**（白名单键；
        //        多一个 `$schema`/`exclusiveMinimum` 就报 `Unknown name …`）
        //      · `parametersJsonSchema` —— 接受**完整 JSON Schema，原样发送**
        //
        //    实测：Build 通道上任何 `parameters` 都 400（**连无参数的极简 tool
        //    也 400**），换 `parametersJsonSchema` 立即通过。参考实现
        //    AIStudio2API 的 `docs/build.md` 亦写明该字段名。
        ...(tool.parameters === undefined
          ? {}
          : { parametersJsonSchema: tool.parameters }),
      })),
    }]
  }

  // 模型 id 不在 body 里 —— REST 端点把它放在 URL 路径。
  return body
}

/** DSH 的 content（字符串或块数组）→ Gemini 的 `parts[]`。 */
function toParts(content: unknown): Record<string, unknown>[] {
  if (typeof content === 'string') return content.length > 0 ? [{ text: content }] : []
  if (!Array.isArray(content)) return []
  const parts: Record<string, unknown>[] = []
  for (const block of content as readonly {
    type?: string
    text?: string
    name?: string
    arguments?: string
    content?: unknown
  }[]) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      parts.push({ text: block.text })
    } else if (block.type === 'tool-call' && typeof block.name === 'string') {
      let args: unknown = {}
      try { args = JSON.parse(block.arguments ?? '{}') } catch { args = {} }
      parts.push({ functionCall: { name: block.name, args } })
    } else if (block.type === 'tool-result') {
      // ⚠️ tool-result 的文本在 `content` 里（可能是嵌套块数组）。
      const text = typeof block.content === 'string'
        ? block.content
        : Array.isArray(block.content)
          ? (block.content as readonly { type?: string; text?: string }[])
              .filter((b) => b.type === 'text' && typeof b.text === 'string')
              .map((b) => b.text).join('\n')
          : ''
      parts.push({ functionResponse: { name: block.name ?? '', response: { content: text } } })
    }
  }
  return parts
}

/** 非流式 JSON 响应 → DSH 的 chunk 序列（供假流式分片用）。 */
export function jsonResponseToChunks(
  json: unknown,
  translate: (response: unknown) => { blocks: readonly unknown[]; reason: unknown; usage?: unknown },
): StreamChunk[] {
  const envelope = json as { response?: unknown }
  const translated = translate(envelope.response ?? json)
  const chunks: StreamChunk[] = []
  for (let index = 0; index < translated.blocks.length; index++) {
    const block = translated.blocks[index] as {
      type: string
      text?: string
      id?: string
      name?: string
      arguments?: string
    }
    if (block.type === 'text') {
      chunks.push({ type: 'block-start', index, blockType: 'text' } as StreamChunk)
      chunks.push({ type: 'text-delta', index, text: block.text ?? '' } as StreamChunk)
      chunks.push({ type: 'block-end', index, block: block as never } as StreamChunk)
    } else if (block.type === 'reasoning') {
      chunks.push({ type: 'block-start', index, blockType: 'reasoning' } as StreamChunk)
      chunks.push({ type: 'reasoning-delta', index, text: block.text ?? '' } as StreamChunk)
      chunks.push({ type: 'block-end', index, block: block as never } as StreamChunk)
    } else if (block.type === 'tool-call') {
      chunks.push({ type: 'block-start', index, blockType: 'tool-call' } as StreamChunk)
      chunks.push({
        type: 'tool-call-delta', index,
        id: block.id as never,
        name: block.name,
        argumentsDelta: block.arguments ?? '{}',
      } as StreamChunk)
      chunks.push({ type: 'block-end', index, block: block as never } as StreamChunk)
    }
  }
  if (translated.usage !== undefined) {
    chunks.push({ type: 'usage', usage: translated.usage as never } as StreamChunk)
  }
  chunks.push({ type: 'finish', reason: translated.reason as never } as StreamChunk)
  return chunks
}
