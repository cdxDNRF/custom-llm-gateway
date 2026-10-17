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
import { sanitizeGeminiSchema } from '../../vendor/src/gemini.js'
import type { BuildRelay } from '../core/build-relay.js'

/**
 * Build 渠道实测可用的模型，附**免费层速率上限**。
 *
 * ## ⚠️ 核心事实：Build 与 API Key 是**两套独立额度**（已实测证实）
 *
 * 最初我的实现让 App 的**服务端**用注入的 API Key 直连
 * `generativelanguage.googleapis.com` —— 那条路烧的是 **API Key 额度**，
 * 所以当时实测"调用后 rate-limit 页面 +1"，并据此错误地断言过"同池、无独立价值"，
 * 甚至一度把这个渠道整个移除。
 *
 * 真相来自对 [AIStudio2API](https://github.com/Mag1cFall/AIStudio2API) 的调研
 * （`docs/build.md`）：Build 应用经 AI Studio **宿主页**调用 **MakerSuite 代理 RPC**
 * 访问 Gemini API，**这部分额度与 Playground（= API Key）分开计算**。
 *
 * 关键在于**谁执行 fetch**：
 *
 * ```
 * ❌ 服务端 fetch（带 API Key）→ generativelanguage 直连 → API Key 额度
 * ✅ 浏览器端 fetch（不带 key）→ 宿主页 shim 拦截 → MakerSuite 代理 → Build 额度
 * ```
 *
 * 宿主页 shim 会接管 iframe 内匹配 `generativelanguage.googleapis.com` 的 `fetch`，
 * 经 MessagePort 转发给宿主页，由它完成 BotGuard/WAA proof 后走代理 RPC。
 * **故我们无需自己实现 WAA** —— 用户的浏览器本来就在 AI Studio 页面里。
 *
 * ### 决定性实验（2026-10-17 15:00）
 *
 * 经网关对 `gemini-3.1-flash-lite` 连发 **6 次**（relay 计数 3→9，精确 +6），
 * 随后刷新 https://ai.dev/rate-limit：该模型 RPD **仍是 35/500，纹丝不动**。
 * 而 App 界面显示 `Intercepted by MakerSuite Host Proxy`。
 * ⇒ 客户端 fetch 路径**不计入 API Key 额度**。
 *
 * ⚠️ 一个必要前提（来自宿主页的交互门控）：宿主页只在**用户激活后**才转发，
 *    要求 `navigator.userActivation.hasBeenActive` 且累计约 30 次可信 mousemove
 *    与 5 次 keydown。故**用户必须在 App 页面上动一动鼠标/敲几下键**，
 *    否则 iframe 的 fetch 会一直挂起（症状是请求超时而非报错）。
 *
 * ## 速率上限（取自用户账页面，2026-10-17）
 *
 * | 模型族 | RPM | RPD | 实测 |
 * |---|---|---|---|
 * | Gemini 3.x Flash（3.5/3.6/3.7/3.8） | 5 | **20** | 快速连打 4 次 → 后 3 次 429；**等 60 秒仍 429** ⇒ 撞每日额度 |
 * | Gemini 3.x Flash-Lite | 15 | 500 | 快速连打 4 次 → **全部成功** |
 * | Gemma 4 31B | 30 | 14.4K | 可用（明显较慢） |
 *
 * ⚠️ 这些是 **Build 通道自己的**上限（页面上的 RPD 列）。
 *
 * ⚠️ **不标"当前是否耗尽"** —— 那随当天用量变化，写死必然过期
 *    （实测教训：曾标的「额度耗尽」次日全部恢复，成了假信息）。
 */
export const BUILD_MODELS: readonly {
  id: string
  name: string
  contextWindow: number
  /** 实测偏慢（同一请求曾超时 130 秒），名字上标出来。 */
  slow?: boolean
}[] = [
  { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', contextWindow: 1_048_576 },
  { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite', contextWindow: 1_048_576 },
  { id: 'gemma-4-31b-it', name: 'Gemma 4 31B', contextWindow: 1_048_576, slow: true },
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', contextWindow: 1_048_576 },
  { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', contextWindow: 1_048_576 },
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', contextWindow: 1_048_576 },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', contextWindow: 1_048_576 },
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
    // 限额数字的来源问题见 listAllModels 的注释（那是 API Key 的数，不是 Build 的）。
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
    // ⚠️ **不标限额数字** —— 先前标的"500/天 15/分"是 **API Key（Playground）** 的
    //    限额（取自 rate-limit 页面），而实测证明 Build 走**独立额度**、且那个页面
    //    **不显示 Build 的用量** ⇒ 把 API Key 的数字标在 Build 模型上属于误导
    //    （用户已指出："供应商页面的模型名称还是 apikey 的"）。
    //    真实上限未公开；能确定的是**按模型独立**且**会重置**。
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
      // ⚠️ 429 有**多种含义**，不能一律说"需要付费等级"（初版就是这么写的，
      //    属于误导）：上游原文会区分，且**每日配额是会重置的** —— 说成
      //    "需要付费"会让用户以为永久不可用而放弃。
      //
      // 实测（2026-10-17）三种 429：
      //   · 每日/项目配额用尽 → `* Quota exceeded for quota metric 'Generate
      //     requests per day …'` ⇒ **明天重置**，等即可
      //   · 每分钟限流 → `Generate requests per minute` ⇒ 稍后重试
      //   · 模型需付费等级 → 免费层无权限
      if (response2.status === 429) {
        throw new LlmError(
          `build: 429 ${describe429(response2.body, response2.headers, model)}`,
          'QUOTA_EXCEEDED',
          { status: 429 },
        )
      }
      if (response2.status === 400 && /has not been activated|user activation/i.test(response2.body)) {
        // ⚠️ 宿主页的交互门控：未满足时 iframe 的 fetch **保持等待**（不是报错），
        //    表现是超时。少数情况下上游会明确回 activation 相关文案，此时给出
        //    可行动的提示 —— 这是本渠道最易误判的失败方式。
        throw new LlmError(
          'build: 宿主页尚未放行转发 —— 请在 App 页面上**移动鼠标 / 按几下键**'
          + '（约 30 次 mousemove + 5 次 keydown，且需 navigator.userActivation.hasBeenActive）。',
          'INVALID_REQUEST',
          { status: 400 },
        )
      }
      throw new LlmError(
        `build: HTTP ${response2.status} — ${upstreamMessage(response2.body)}`,
        'SERVER',
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

/**
 * 从上游错误体里取 `error.message`（取不到就回退原文）。
 *
 * ⚠️ 不要直接 `body.slice(0, 300)`：那会在 JSON 中间截断，把最关键的一句
 * （通常是 `* Quota exceeded for …`）切掉 —— 实测踩到，只剩 `* Quota ex`。
 */
function upstreamMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } }
    const message = parsed.error?.message
    if (typeof message === 'string' && message.length > 0) return message.replace(/\s+/g, ' ').trim()
  } catch {
    // 非 JSON：回退原文。
  }
  return body.replace(/\s+/g, ' ').trim().slice(0, 300)
}

/**
 * 把 429 的原文翻译成**可行动**的中文提示。
 *
 * ⚠️ 关键区分：**每日配额会重置**（等到次日即可），而"需付费等级"是永久的。
 *    初版一律标成后者，会让用户误以为这个渠道废了。
 */
function describe429(body: string, headers: Record<string, string> = {}, model = ''): string {
  const raw = upstreamMessage(body)
  const lower = raw.toLowerCase()
  // ⚠️ 判据必须**具体**：`please check your plan and billing details` 是**所有**
  //    配额错误的通用句（实测踩到 —— 用它判"需付费等级"会把每日配额也说成
  //    永久不可用）。故只认上游的**配额明细行** `* Quota exceeded for quota metric
  //    '…'`，它才区分 per day / per minute。
  const metric = /quota exceeded for quota metric '([^']+)'|quota metric '([^']+)'/i.exec(raw)
  const metricName = (metric?.[1] ?? metric?.[2] ?? '').toLowerCase()
  const probe = metricName.length > 0 ? metricName : lower

  let verdict: string
  // ⚠️ 实测（2026-10-17）：这条 429 的原文**没有**配额明细行 —— 只有通用句
  //    "please check your plan and billing details"。故上面按 metric 判据多半落空，
  //    得靠**已知的官方限额**给出确切解释（这比"配额/限流"有用得多）。
  const entry = BUILD_MODELS.find((m) => m.id === model)

  if (/per\s*day|daily/.test(probe)) {
    verdict = '免费层**每日**配额已用完。**会重置** —— 等次日再试，或先换其它模型'
      + '（如 gemini-3.1-flash-lite，500 次/天）。'
  } else if (/per\s*minute|per\s*second|per\s*minute\s*per\s*user/.test(probe)) {
    verdict = '触发**每分钟**限流（请求过快）。等几十秒再试即可。'
  } else if (!/billing|paid|plan/.test(lower) && /free\s*tier|unsupported/i.test(lower)) {
    verdict = '该模型在免费层**无权限**（需付费等级）。'
  } else if (entry !== undefined) {
    // ⚠️ **不报具体数字**：Build 通道自己的限额未公开（rate-limit 页面只显示
    //    API Key/Playground 的用量，**不含 Build**，故那里看不到本渠道的额度）。
    //    实测确定的事实只有：按模型计、会重置、隔 90 秒重试仍 429（⇒ 非每分钟限流）。
    verdict = `${entry.name} 的额度已用完（**会重置**）。`
      + '额度**按模型独立**计算 —— 其它模型不受影响，可换一个再试。'
      + 'Build 通道的用量不在 api 密钥的 rate-limit 页面显示。'
  } else {
    verdict = '配额/限流。'
  }
  // ⚠️ **始终附带原文** —— 判据总会遇到没覆盖的形态，原文是唯一可靠依据
  //    （加这条之前，我因为误判把每日配额说成了"需付费"，用户会以为渠道废了）。
  // ⚠️ 实测：这条 429 的原文**没有配额明细行**（只有通用句 "please check your
  //    plan and billing details"），故单靠文案**无法**区分是每日配额还是每分钟
  //    限流。此时响应头是更可靠的线索 —— Google 会带 `retry-after` / 配额相关头。
  const hints: string[] = []
  for (const key of ['retry-after', 'x-ratelimit-*', 'x-goog-*']) {
    for (const [k, v] of Object.entries(headers)) {
      const lk = k.toLowerCase()
      if (key === 'x-ratelimit-*' ? lk.startsWith('x-ratelimit') : key === 'x-goog-*' ? lk.startsWith('x-goog') : lk === key) {
        hints.push(`${k}=${String(v).slice(0, 40)}`)
      }
    }
  }
  const headerText = hints.length > 0 ? `｜响应头：${hints.join(', ')}` : ''
  return `${verdict}（上游原文：${raw.slice(0, 240)}${headerText}）`
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
        // ⚠️⚠️ **必须清洗**（真实缺陷，2026-10-17 用户报障）：DSH 给的是完整
        //    JSON Schema，而 Gemini 的 `functionDeclarations[].parameters` 只接受
        //    **OpenAPI 子集**。直接透传会 400：
        //      Invalid JSON payload received. Unknown name "$schema" at
        //      'tools[0].function_declarations[0].parameters'
        //      Unknown name "exclusiveMinimum" …
        //    复用 vendor 的 `sanitizeGeminiSchema`（反重力渠道走的就是它）：
        //    白名单删键 + 递归 properties/items/anyOf + 数组 type 收敛 + 非字符串
        //    枚举整删。⚠️ 不自己写一份 —— 那份已经处理了这些边角，重写必然漏。
        ...(tool.parameters === undefined
          ? {}
          : { parameters: sanitizeGeminiSchema(tool.parameters as Record<string, unknown>) }),
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
