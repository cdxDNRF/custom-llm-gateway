/**
 * **AI Studio** 适配器：用 **API Key**（`AIza…` 标准 / `AQ.…` 授权）调 `generativelanguage`
 * 的 Gemini 模型。
 *
 * ## 与本网关另两个 Gemini 渠道的区别
 *
 * | 渠道 | 端点 | 认证 | 额度 |
 * |---|---|---|---|
 * | `gemini`（反重力） | `daily-cloudcode-pa` + `/v1internal:*` | OAuth Bearer | Antigravity 额度 |
 * | **`aistudio`**（本文件） | `generativelanguage/v1beta/models/*` | **`x-goog-api-key`** | **API Key 免费层额度** |
 * | `build` | 同 aistudio | 由 AI Studio 宿主页代劳 | **Build 独立额度** |
 *
 * ⇒ 三者**额度互不相同**。本渠道是最"标准"的一条：任何人拿一个 AI Studio
 *    API Key 即可用，不需要 OAuth、不需要浏览器。
 *
 * ## 为什么复用 `gemini-rest.ts`
 *
 * 请求体/响应体形状与 Build 渠道**完全一致**（都是裸 REST），差别只在
 * 传输与认证。故协议翻译抽到 `gemini-rest.ts`，两处共用 —— 避免同一份
 * 逻辑写两遍后**只修一处**（这是本仓库反复踩过的缺陷类型）。
 */
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmResolvedModelInfo, StreamChunk, GenerateOptions } from '@deepseek-ai/dsh-llm'
import { consumeGeminiSse, translateGeminiResponse } from '../../vendor/src/gemini-messages.js'
import type { GeminiResponse } from '../../vendor/src/gemini-messages.js'
import {
  GEMINI_REST_BASE, toGeminiRestBody, stripPrefill, jsonResponseToChunks,
} from '../core/gemini-rest.js'

/**
 * 本渠道暴露的模型（用户指定 3 个）。
 *
 * ⚠️ 只列**实测确认存在**的模型（用户明确指定）：
 *   · `gemma-4-31b-it`            —— Gemma 系
 *   · `gemini-flash-lite-latest`  —— Flash-Lite 最新别名
 *   · `gemini-flash-latest`       —— Flash 最新别名
 *
 * ⚠️ 用 `-latest` **别名**而非固定版本号：上游会随版本推进指向新模型，
 *    写死版本号（如 `gemini-3.8-flash`）会在上游下线后 404。
 */
export const AISTUDIO_MODELS: readonly { id: string; name: string; contextWindow: number }[] = [
  { id: 'gemini-flash-lite-latest', name: 'Gemini Flash Lite (latest)', contextWindow: 1_048_576 },
  { id: 'gemini-flash-latest', name: 'Gemini Flash (latest)', contextWindow: 1_048_576 },
  { id: 'gemma-4-31b-it', name: 'Gemma 4 31B', contextWindow: 1_048_576 },
]

/** 单次调用取凭据的回调（由 provider 注入，从账号池现读）。 */
export interface AiStudioAdapterOptions {
  /** 取当前可用账号的 API Key；无可用账号时返回 `undefined`。 */
  apiKey: () => Promise<string | undefined>
  /** 诊断日志。 */
  warn?: (message: string) => void
  /** 是否默认走假流式（上游流式偶发截断时用；AI Studio 一般不需要）。 */
  defaultNonStream?: boolean
}

/**
 * AI Studio 适配器。
 *
 * 🔑 **认证方式**：`x-goog-api-key: <key>` 请求头（`AIza…` 标准 Key 与 `AQ.…` 授权 Key 都支持）。
 *    （也支持 `?key=` 查询参数，但请求头更干净、不会进日志/Referer。）
 */
export class AiStudioAdapter extends LlmAdapter {
  private readonly options: AiStudioAdapterOptions

  constructor(options: AiStudioAdapterOptions) {
    super()
    this.options = options
  }

  override providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: 'AI Studio' }
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return AISTUDIO_MODELS.map((m) => ({ provider: 'aistudio', id: m.id, name: m.name }))
  }

  /**
   * 完整目录（不套黑名单），供 Web UI 的「模型管理」用。
   *
   * ⚠️ 必须**同步**返回：契约要求 `readonly []`，写成 async 会让
   *    `[...all]` / `all.map` 抛 `TypeError: all is not iterable`
   *    （与 `minimax-adapter.ts` 记录的同类缺陷相同）。
   */
  listAllModels(): readonly { id: string; name: string }[] {
    return AISTUDIO_MODELS.map((m) => ({ id: m.id, name: m.name }))
  }

  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const entry = AISTUDIO_MODELS.find((m) => m.id === model)
    if (entry === undefined) {
      throw new LlmError(
        `aistudio: 模型 "${model}" 不在本渠道目录中（当前可用：${AISTUDIO_MODELS.map((m) => m.id).join(', ')}）`,
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

  async *stream(rawOptions: GenerateOptions): AsyncIterable<StreamChunk> {
    const options = rawOptions as GenerateOptions & { useNonStream?: boolean }
    const model = String(options.model)
    const entry = AISTUDIO_MODELS.find((m) => m.id === model)
    if (entry === undefined) {
      throw new LlmError(`aistudio: 模型 "${model}" 不在本渠道目录中`, 'INVALID_REQUEST', { status: 404 })
    }

    const apiKey = await this.options.apiKey()
    if (apiKey === undefined || apiKey.length === 0) {
      throw new LlmError(
        'aistudio: 没有可用的 API Key —— 请到「供应商」页为 AI Studio 新建账号并填入密钥（AIza… 或 AQ.…）。',
        'INVALID_REQUEST',
        { status: 401 },
      )
    }

    const body = toGeminiRestBody(options)
    // 预填充：部分模型拒绝以 model turn 结尾的请求（见 gemini-rest.ts 注释）。
    const stripped = stripPrefill(body)
    const payload = stripped ?? body
    if (stripped !== undefined) {
      this.options.warn?.(`[aistudio] ${model} 请求以 model turn 结尾 —— 已剥离预填充`)
    }

    // 默认走流式（AI Studio 的流式足够稳定，不像 Build 那样易截断）。
    const useNonStream = this.options.defaultNonStream === true
      ? options.useNonStream !== false
      : options.useNonStream === true

    const method = useNonStream ? 'generateContent' : 'streamGenerateContent?alt=sse'
    const url = `${GEMINI_REST_BASE}/models/${model}:${method}`

    // ⚠️ 代理：Google 域名在本机网络环境**不可直连**，必须走 Clash。
    //    本渠道的 `fetch` 是全局裸 fetch —— 由 `gemini-proxy.ts` 的
    //    host 路由拦截器自动接管（`*.googleapis.com` 已在其匹配列表中），
    //    故这里**不需要**自行挂 proxy（provider 侧已安装该拦截器）。
    // ⚠️ 加超时：实测 `gemini-flash-latest` 偶发**挂起不响应**（直连上游 85 秒
    //    HTTP 000），无超时会让客户端一直等。120 秒足够覆盖正常的慢推理
    //    （thought 模型首字可能较晚），又不会无限挂起。
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 120_000)
    timer.unref?.()
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // 🔑 AI Studio 的认证头（不要泄漏到 URL —— 会被日志/Referer 记录）。
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
    } catch (error) {
      clearTimeout(timer)
      const aborted = (error as { name?: string }).name === 'AbortError'
      throw new LlmError(
        aborted
          ? `aistudio: 上游 120 秒无响应 —— ${model} 可能正忙/额度耗尽后挂起。`
            + '可换模型重试（实测 gemini-flash-lite-latest / gemma-4-31b-it 更稳）。'
          : `aistudio: 请求失败 —— ${String(error)}`,
        'SERVER',
      )
    }
    clearTimeout(timer)

    if (response.status !== 200) {
      const text = await response.text().catch(() => '')
      throw new LlmError(
        `aistudio: HTTP ${response.status} — ${describeError(response.status, text)}`,
        response.status === 429 ? 'QUOTA_EXCEEDED'
          : response.status === 401 || response.status === 403 ? 'FORBIDDEN' : 'SERVER',
        { status: response.status },
      )
    }

    if (useNonStream) {
      const text = await response.text()
      let parsed: GeminiResponse
      try {
        const json = JSON.parse(text) as { response?: GeminiResponse }
        parsed = (json.response ?? json) as GeminiResponse
      } catch {
        throw new LlmError(`aistudio: 非流式响应不是 JSON — ${text.slice(0, 160)}`, 'SERVER')
      }
      // ⚠️ 数组不是 AsyncIterable —— 用 `for...of` 逐个 yield（不能 `yield*`）。
      for (const chunk of jsonResponseToChunks(parsed, (r) => translateGeminiResponse({ response: r as never }))) {
        yield chunk
      }
      return
    }

    const stream = response.body
    if (stream === null) throw new LlmError('aistudio: 响应体为空', 'SERVER')
    // 复用 vendor 的 SSE 消费器（已兼容信封与裸两种形态）。
    yield* consumeGeminiSse({ body: stream }) as AsyncIterable<StreamChunk>
  }
}

/**
 * 从 429 错误体里解析 `QuotaFailure` 元数据。
 *
 * ⚠️ 这是本渠道**唯一**能拿到额度明细的来源（没有额度查询 API）。
 *
 * 上游结构（Google RPC 标准）：
 * ```json
 * { "error": {
 *     "details": [
 *       { "@type": ".../google.rpc.QuotaFailure",
 *         "violations": [{ "quotaMetric": "...", "quotaId": "...",
 *                          "quotaValue": "20", "quotaDimensions": {...} }] },
 *       { "@type": ".../google.rpc.RetryInfo", "retryDelay": "37s" }
 *     ] } }
 * ```
 *
 * @returns 一句人类可读的摘要；解析不出时返回 `undefined`（由调用方回退通用文案）。
 */
function parseQuotaFailure(raw: string): string | undefined {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return undefined }
  const details = (parsed as { error?: { details?: unknown } }).error?.details
  if (!Array.isArray(details)) return undefined

  const parts: string[] = []
  for (const detail of details as { '@type'?: string; violations?: unknown; retryDelay?: unknown }[]) {
    const type = String(detail['@type'] ?? '')
    if (type.endsWith('QuotaFailure') && Array.isArray(detail.violations)) {
      for (const v of detail.violations as { quotaMetric?: unknown; quotaId?: unknown; quotaValue?: unknown }[]) {
        // quotaId 形如 `GenerateRequestsPerDayPerProjectPerModel-FreeTier`
        const id = String(v.quotaId ?? v.quotaMetric ?? '')
        const value = v.quotaValue === undefined ? '' : ` 上限 ${String(v.quotaValue)}`
        // 把 snake/长 id 换成简短中文
        const what = /PerDay/i.test(id) ? '每日请求数'
          : /PerMinute/i.test(id) ? '每分钟请求数'
            : /Token/i.test(id) ? 'token 数'
              : id
        if (what.length > 0) parts.push(`${what}${value}`)
      }
    } else if (type.endsWith('RetryInfo') && typeof detail.retryDelay === 'string') {
      parts.push(`${detail.retryDelay} 后可重试`)
    }
  }
  return parts.length > 0 ? parts.join('、') : undefined
}

/** 把上游错误翻译成可行动的提示。 */
function describeError(status: number, raw: string): string {
  let message = raw
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } }
    if (typeof parsed.error?.message === 'string') message = parsed.error.message
  } catch { /* 非 JSON：用原文 */ }
  // ⚠️⚠️ **不截断原文**（真实缺陷，2026-10-18 用户报障）：
  //    先前截到 300 字，而 Google 的 429 原文**末尾**才是额度明细
  //    （`* Quota exceeded for metric: generativelanguage.googleapis.com/…`），
  //    截断后用户只能看到 `generativelanguage.googleapis.c` —— 正好把
  //    "哪个指标超了"这个唯一有用的信息切掉。
  //
  //    额度明细是**多行**的（含 `metric` / `limit` / `quotaId`），故这里
  //    保留完整文本，仅在 UI 层做换行处理。
  const brief = message.replace(/\s+/g, ' ').trim()

  if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(message)) {
    // ⚠️ **不要断言前缀**：`AQ.` 开头的**授权 Key**（2026-05 起 AI Studio 默认）
    //    也是合法的；先前写成"必须是 AIza"是错的（用户实测报障纠正）。
    //    真正该排除的是 OAuth access token（`ya29.`）与 OAuth 凭据（`AQ.` 之外的形态），
    //    但那类错误通常回的是别的 reason，故这里只给中性提示。
    return 'API Key 无效或已撤销 —— 请到 https://aistudio.google.com/apikey '
      + '重新确认（AIza… 标准 Key 与 AQ.… 授权 Key 都支持）。原文：' + brief
  }
  if (status === 429) {
    // ⚠️ **额度信息只在这里能拿到**（实测确认：Gemini API 没有独立的额度查询
    //    端点 —— `/v1beta/quota` 等全部 404；ListModels 只回 token 上下文上限；
    //    正常响应的头也不带 x-ratelimit-*）。
    //
    //    故 429 的 `QuotaFailure` 元数据是**唯一**能知道"哪个指标、上限多少、
    //    何时重置"的来源。参考实现 AIStudio2API 的 docs/development.md 亦按
    //    `quota_unit` / `quota_limit` / `quota_metric` + `RetryInfo` 判定。
    // 先把**完整**原文给出去（含 `* Quota exceeded for metric: …` 明细）——
    // 先前截断到 300 字，正好把 metric 名切断，用户无法判断是哪种限流。
    const quota = parseQuotaFailure(raw)
    // ⚠️ 区分「每分钟」与「每日」：用户实测"额度没耗完"却报 429，多半是
    //    **每分钟/每项目**的短窗口限流，等几十秒就好，不必等到次日。
    //    上游原文里 `quotaId`/`metric` 会带 PerMinute / PerDay 字样。
    const perMinute = /PerMinute|per.?minute|RPM/i.test(raw)
    const perDay = /PerDay|per.?day|daily|RPD/i.test(raw)
    if (quota !== undefined) {
      const hint = perMinute ? '（是**每分钟**限流，等几十秒即可，不用等次日）'
        : perDay ? '（是**每日**配额，次日重置）'
          : '（会重置；若额度没耗完，多半是短窗口限流，等一会再试）'
      return `额度/限流：${quota}${hint}`
    }
    if (perMinute) return '触发**每分钟**限流（请求过快）—— 等几十秒再试即可，不用等次日。'
    return '额度/限流用尽。若确认额度没耗完，多半是**短窗口限流**（每分钟/每项目），'
      + '等几十秒重试；也可能该 Key 所在项目有并发限制。完整原文：' + brief
  }
  if (status === 403) {
    return `无权限（403）—— 该 Key 可能未启用此模型，或所在地区受限。原文：${brief}`
  }
  if (status === 404) {
    return `模型不存在（404）—— 该模型可能已下线。原文：${brief}`
  }
  // ⚠️ 503 / 500 分两种（实测区分，2026-10-18）：
  //    · 503 `This model is currently experiencing high demand` —— **模型过载**，
  //      换时间或换模型即可，**不是额度问题**
  //    · 500 `Internal error encountered` —— 同为上游不稳定，与过载常伴生
  //      （实测 gemma-4-31b-it 8 次里 5 次 500）
  //    先前一律当"服务器错误"抛出，用户会误以为是自己的配置问题。
  if (status === 503 || /high demand|overloaded|UNAVAILABLE/i.test(message)) {
    return '该模型**当前过载**（上游临时性，非额度问题）—— 换时间或换模型重试。'
      + `原文：${brief}`
  }
  if (status === 500 && /internal error/i.test(message)) {
    return '上游**内部错误**（多为模型不稳定/过载的伴生现象，非你的配置问题）'
      + ' —— 重试或换模型（实测 gemini-flash-lite-latest 最稳）。'
      + `原文：${brief}`
  }
  return brief
}
