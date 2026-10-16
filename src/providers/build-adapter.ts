/**
 * Build 渠道适配器：把 Build App 中继来的 Gemini REST 响应翻译成 DSH 的 chunk 流。
 *
 * ## 为什么单独一个适配器（不复用 `gemini-adapter.ts`）
 *
 * 两者**协议不同**：
 *
 * | | 反重力渠道（gemini-adapter） | **Build 渠道（本文件）** |
 * |---|---|---|
 * | 端点 | `cloudcode-pa.googleapis.com/v1internal:*` | **`generativelanguage.googleapis.com/v1beta/*`** |
 * | 认证 | OAuth Bearer + 五个身份头 | **无**（App 服务端自带密钥） |
 * | 请求体 | `{model, project, request:{...}, requestId, userAgent}` 信封 | **裸 REST**：`{contents, generationConfig, tools}` |
 * | 响应 | `{response:{candidates}}` 信封 | **裸** `{candidates, usageMetadata}` |
 * | 传输 | `fetch` | **WebSocket 中继**（经用户浏览器） |
 *
 * 差异集中在"信封"和"传输"两处，**响应侧的 chunk 解析可以复用**
 * `consumeGeminiSse`（它已兼容信封与裸两种形态，实测确认）。
 *
 * ## 可用模型（实测，2026-10-17）
 *
 * `fetchAvailableModels` 列出 50 个，但逐个真发推理请求后：
 *
 * | 状态 | 模型 |
 * |---|---|
 * | ✅ 200 可用 | `gemini-3.8-flash`、`3.7-flash`、`3.6-flash`、`3.5-flash`、`3.1-flash-lite` |
 * | ⚠️ 429 需付费 | `3.1-pro-preview`、`4-argon`、`pro-latest`、`nano-banana-pro-preview` |
 * | ❌ 404 已下线 | `2.5-pro`、`2.5-flash`（上游："no longer available to new users"） |
 *
 * 用户拍板：**只用 flash 系列**，付费的不关注。
 */
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmResolvedModelInfo, StreamChunk, GenerateOptions } from '@deepseek-ai/dsh-llm'
import { consumeGeminiSse } from '../../vendor/src/gemini-messages.js'
import type { BuildRelay } from '../core/build-relay.js'

/**
 * Build 渠道可用的模型（实测确认可推理的 flash 系列）。
 *
 * ⚠️ 刻意**只放实测 200 的**：429（需付费）与 404（已下线）的不列，
 * 否则用户选中必然失败，且错误信息（"quota exceeded"）会让人以为是限流。
 */
export const BUILD_MODELS: readonly { id: string; name: string; contextWindow: number }[] = [
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', contextWindow: 1_048_576 },
  { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', contextWindow: 1_048_576 },
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', contextWindow: 1_048_576 },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', contextWindow: 1_048_576 },
  { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', contextWindow: 1_048_576 },
]

/** REST 端点基址（App 的 host 白名单只放行 `*.googleapis.com`）。 */
const REST_BASE = 'https://generativelanguage.googleapis.com/v1beta'

export interface BuildAdapterOptions {
  /** WebSocket 中继（由 provider 持有）。 */
  relay: BuildRelay
  /** 诊断日志。 */
  warn?: (message: string) => void
}

/**
 * Build 渠道适配器。
 *
 * ⚠️ 它**不实现 `listModels` 之外的任何"上游目录拉取"** —— 模型表是硬编码的
 * 实测结果（见 {@link BUILD_MODELS}）。原因：Build 渠道的"模型列表"接口
 * 返回 50 个，但大半不可用（429/404），全列出来只会误导用户。
 */
export class BuildAdapter extends LlmAdapter {
  private readonly relay: BuildRelay
  private readonly warn: ((message: string) => void) | undefined

  constructor(options: BuildAdapterOptions) {
    super()
    this.relay = options.relay
    this.warn = options.warn
  }

  /** 路由展示信息（与其它适配器同款）。 */
  override providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: 'Build (AI Studio)' }
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return BUILD_MODELS.map((m) => ({
      provider: 'build',
      id: m.id,
      name: m.name,
    }))
  }

  /**
   * 完整目录（**不套黑名单**），供 Web UI 的「模型管理」用。
   *
   * ⚠️ **必须实现**：网关的管理 API 走的是 `listAllModels()` 而不是 `listModels()`
   * （见 `provider-common.ts` 的 `listModelsWithState`）。只实现后者时，
   * 供应商端口能列出模型、但 Web UI 的「模型管理」是**空的** —— 实测踩到
   * （`/v1/models` 返回 5 个，`/api/p/build/models` 返回 `[]`）。
   *
   * ⚠️ 且**必须同步**返回（不是 async）：契约要求 `readonly []`，
   * 写成 async 会让 `[...all]` / `all.map` 抛 `TypeError: all is not iterable`
   * （与 `minimax-adapter.ts` 记录的同类缺陷相同）。
   */
  listAllModels(): readonly { id: string; name: string }[] {
    return BUILD_MODELS.map((m) => ({ id: m.id, name: m.name }))
  }

  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const entry = BUILD_MODELS.find((m) => m.id === model)
    if (entry === undefined) {
      throw new LlmError(
        `build: 模型 "${model}" 不在本渠道目录中（当前可用：${BUILD_MODELS.map((m) => m.id).join(', ')}）`,
        'INVALID_REQUEST',
        { status: 404 },
      )
    }
    return {
      provider,
      id: model,
      name: entry.name,
      contextWindow: entry.contextWindow,
      maxTokens: 65_536,
      inputModalities: ['text', 'image'],
    } as LlmResolvedModelInfo
  }

  /**
   * 推理。
   *
   * 流程：DSH 的 `GenerateOptions` → **Gemini REST body** → 经中继发给 App →
   * App 转发到 `generativelanguage.googleapis.com` → 把返回的 SSE 文本喂给
   * `consumeGeminiSse` → 得到 DSH 的 chunk 流。
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const model = String(options.model)
    if (!BUILD_MODELS.some((m) => m.id === model)) {
      throw new LlmError(`build: 模型 "${model}" 不在本渠道目录中`, 'INVALID_REQUEST', { status: 404 })
    }

    const body = toRestBody(options, model)
    const url = `${REST_BASE}/models/${model}:streamGenerateContent?alt=sse`

    const response = await this.relay.fetch({
      url,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

    /**
     * ⚠️⚠️ **Cloud Run 冷启动**（真实缺陷，2026-10-17 实测抓到）。
     *
     * App 的服务端跑在 Cloud Run 上，**无流量时会缩容到零**。此时第一个请求
     * 会拿到一个 **HTTP 200 + HTML 启动页**（`<title>Starting Server...</title>`），
     * 而不是 SSE —— 症状是「模型未返回任何内容块」，看起来像模型不回复。
     *
     * ⚠️⚠️ **任何 HTML 都重试**（不区分是哪一页）—— 实测教训：
     *    起初只对**启动页**（`<title>Starting Server...</title>`）重试，结果撞到
     *    另一种 HTML 时直接报错。抓到 title 后真相大白：
     *
     *      `title=「Gemini WebSocket Relay Bridge」` ← **App 自己的页面**
     *
     *    即返回的是 **SPA 兜底页**（App 的前端路由接管了 `/api/relay`），
     *    而不是冷启动页。两者都意味着"App 的服务端此刻没给出 API 响应"，
     *    且**都是暂时的**（实测重试后即恢复，随后连续 4 次调用全部成功）。
     *
     * 重试间隔 2s→25s 递增，累计约 90 秒。**静默重试**而不是让用户"稍后重发"——
     * 后者要求用户理解 Cloud Run 的缩容行为。
     */
    let final = response
    if (isHtml(final.body)) {
      this.warn?.(`[build] 收到 HTML 而非模型响应（title=${htmlTitle(final.body) || '无'}），等待重试…`)
      for (const wait of [2000, 3000, 5000, 8000, 12000, 15000, 20000, 25000]) {
        await new Promise((r) => setTimeout(r, wait))
        const retry = await this.relay.fetch({
          url, method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!isHtml(retry.body)) { final = retry; break }
      }
      if (isHtml(final.body)) {
        // ⚠️ 错误信息带 **title** 与可见文本 —— 只给前 120 字 HTML 源码时
        //    `<html><head><meta…` 全是噪音，看不出是哪一页（实测踩到）。
        throw new LlmError(
          'build: App 服务端持续返回 HTML 而非模型响应（已重试约 90 秒）。'
          + `title=「${htmlTitle(final.body) || '无'}」，`
          + `文本：${htmlText(final.body) || '(无)'}`,
          'SERVER',
        )
      }
    }
    const response2 = final

    if (response2.status !== 200) {
      // 429 单独给出可行动的文案（实测那几个 pro/argon 就是这个）。
      const hint = response2.status === 429
        ? '（该模型需要付费等级；本渠道免费层只有 flash 系列）'
        : ''
      throw new LlmError(
        `build: HTTP ${response2.status} — ${response2.body.slice(0, 300)}${hint}`,
        response2.status === 429 ? 'QUOTA_EXCEEDED' : 'SERVER',
        { status: response2.status },
      )
    }

    // ⚠️ 复用 vendor 的 SSE 消费器：它已兼容"信封"与"裸 Response"两种形态
    //    （源码注释：「先试信封形态，再试裸 Response」），而 build 渠道正是裸形态。
    const stream = new Response(response2.body).body
    if (stream === null) throw new LlmError('build: 响应体为空', 'SERVER')
    yield* consumeGeminiSse({ body: stream }) as AsyncIterable<StreamChunk>
  }
}

/** 是否是 HTML（而非模型响应）。 */
function isHtml(text: string): boolean {
  return text.trimStart().startsWith('<')
}

/**
 * 取 HTML 的 `<title>`（诊断用）。
 *
 * ⚠️ 只给前 N 字 HTML 源码时 `<!doctype html><html lang="en"><head><meta…`
 * 全是噪音 —— title 才是"这是哪一页"的唯一有效线索。
 */
function htmlTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  return m?.[1]?.trim().slice(0, 80) ?? ''
}

/** 取 HTML 的可见文本片段（跳过标签/script/style，诊断用）。 */
function htmlText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
}

/**
 * DSH 的 `GenerateOptions` → Gemini REST 请求体。
 *
 * ⚠️ 与 `gemini-messages.ts` 的 `translateGeminiRequest` **不共用**：
 * 那个产出的是 cloudcode 信封（`{model, project, request:{...}}`），
 * 而这里要的是**裸 REST**（`{contents, generationConfig}`），少一层包裹。
 * 强行复用会让两处语义纠缠（那是"只修一条通道"类缺陷的温床）。
 */
function toRestBody(options: GenerateOptions, model: string): Record<string, unknown> {
  const contents: Record<string, unknown>[] = []
  const systemParts: string[] = []

  for (const message of options.messages as readonly {
    role?: string
    content?: unknown
  }[]) {
    const role = message.role === 'assistant' ? 'model' : 'user'
    const parts = toParts(message.content)
    if (parts.length === 0) continue
    if (message.role === 'system') { systemParts.push(...parts.map((p) => String(p.text ?? ''))); continue }
    contents.push({ role, parts })
  }

  const body: Record<string, unknown> = { contents }
  if (systemParts.length > 0) {
    // ⚠️ 必须是对象 `{parts:[...]}`，不能是裸字符串（上游会 400）。
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
        ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
      })),
    }]
  }

  // 模型名不在 body 里 —— REST 端点把它放在 URL 路径（`:streamGenerateContent`）。
  void model
  return body
}

/** DSH 的 content（字符串或块数组）→ Gemini 的 `parts[]`。 */
function toParts(content: unknown): Record<string, unknown>[] {
  if (typeof content === 'string') return content.length > 0 ? [{ text: content }] : []
  if (!Array.isArray(content)) return []
  const parts: Record<string, unknown>[] = []
  for (const block of content as readonly { type?: string; text?: string; name?: string; arguments?: string; id?: string }[]) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      parts.push({ text: block.text })
    } else if (block.type === 'tool-call' && typeof block.name === 'string') {
      let args: unknown = {}
      try { args = JSON.parse(block.arguments ?? '{}') } catch { args = {} }
      parts.push({ functionCall: { name: block.name, args } })
    } else if (block.type === 'tool-result') {
      // ⚠️ tool-result 的文本在 `content` 里（可能嵌套块数组）。
      const inner = (block as { content?: unknown }).content
      const text = typeof inner === 'string'
        ? inner
        : Array.isArray(inner)
          ? (inner as readonly { type?: string; text?: string }[])
              .filter((b) => b.type === 'text' && typeof b.text === 'string')
              .map((b) => b.text).join('\n')
          : ''
      const name = typeof (block as { name?: unknown }).name === 'string' ? String((block as { name?: unknown }).name) : ''
      parts.push({ functionResponse: { name, response: { content: text } } })
    }
  }
  return parts
}
