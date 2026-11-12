/**
 * **Gemini Decisions API** —— 决策专用端点的透传网关（2026-11-12）。
 *
 * ## 为什么单独一个端点，而不是塞进模型列表
 *
 * `gemini-decision-1` 不是聊天模型：它**不生成文字**，而是对「给定的候选选项」
 * 打分并返回概率/置信度（零输出 token）。
 *
 * 实测（本机 2026-11-12，AI Studio API Key）：
 *
 * | 端点 | 结果 |
 * |---|---|
 * | `POST /v1beta/decisions` | ✅ 200（**唯一**可用） |
 * | `/v1beta/models/gemini-decision-1:decisions` | ❌ 404 |
 * | `/v1beta/models/gemini-decision-1:generateContent` | ❌ 400（不接受 `input`/`questions`） |
 * | `/v1beta/models` 列表 | ❌ 50 个模型里**没有** decision-1 |
 *
 * ⇒ 塞进 `/v1/models` 会让客户端选中后必然失败（它不接受 `messages`）。
 * 故做成**独立端点**：`POST /v1/decisions`，请求体与官方 `decisions.create` 同形，
 * 客户端（含 agent）可直接调用。
 *
 * ## 三种决策类型（全部实测通过，2026-11-12）
 *
 * ```jsonc
 * // ① noul（是/否判断）
 * {"type":"noul","instructions":"Is there a spill?"}
 * // → {"confidence":0.974,"noul":0.974,"type":"noul"}
 *
 * // ② choice（多选，2..255 个）
 * {"type":"choice","instructions":"Cleanup?",
 *  "criteria":{"mop":"use a mop","vacuum":"use vacuum"}}
 * // → {"choice":"mop","confidence":0.990,"probabilities":{"mop":0.990,"vacuum":0.010}}
 * // ⚠️ `criteria` 必须是 **选项名→描述 的对象**。传数组会报
 * //    `Invalid input at 'questions.<key>'`（错误信息不提示正确形状，
 * //    是本机逐格试出来的）。
 *
 * // ③ score（有序评分）
 * {"type":"score","instructions":"Rate severity","criteria":["none","minor","major"]}
 * // → {"score":1.04,"confidence":0.755,"probabilities":{"0":0.10,"1":0.76,"2":0.14},
 * //    "legend":{"0":"none","1":"minor","2":"major"}}
 * // ⚠️ `criteria` 这里是 **字符串数组**（与 choice 相反）。
 * ```
 *
 * ⚠️ 两种类型的 `criteria` 形状**不一样**，这不是笔误 —— 是实测结果。
 *
 * ## 一次请求多个问题
 *
 * `questions` 是对象，可放最多 1000 个问题，三种类型可混用；共用同一个 `input`
 * （材料只计费一次）。`input` 支持 text / image / audio / video / pdf。
 *
 * ## 代理
 *
 * `generativelanguage.googleapis.com` 在墙外 ⇒ 复用 `gemini-proxy.ts` 的按 host
 * 分流（其 `PROXIED_HOST_PATTERN` 已含 `googleapis.com`）。
 */

/** 决策请求体的最小形状（其余字段原样透传）。 */
export interface DecisionsRequest {
  /** 模型 id；缺省 `gemini-decision-1`（当前唯一支持值）。 */
  model?: string
  /** 共享材料（一个请求只解析一次，多问题复用）。 */
  input: unknown[]
  /** 问题集：键是调用方自定义的名字，值见上三种类型。 */
  questions: Record<string, unknown>
}

/** 决策响应的最小形状（只列我们读的字段，其余原样返回）。 */
export interface DecisionsResponse {
  answers?: Record<string, unknown>
  usage?: {
    total_tokens?: number
    total_input_tokens?: number
    total_output_tokens?: number
    [key: string]: unknown
  }
  error?: unknown
}

const DECISIONS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/decisions'
/** 上游唯一支持的模型 id（缺省值）。 */
export const DECISION_MODEL_ID = 'gemini-decision-1'
/** 上游等待上限：文档说 150-250ms，但大输入（256K）留足余量。 */
const DECISIONS_TIMEOUT_MS = 120_000

export interface CallDecisionsOptions {
  /** 取一个可用的 AI Studio API Key（每次现读，多账号轮询）。 */
  apiKey: () => Promise<string | undefined>
  /** 可注入的 fetch（单测 / 代理替身）。缺省全局 fetch（已装代理路由）。 */
  fetcher?: typeof fetch
  /** 日志出口。 */
  warn?: (message: string) => void
  /** 请求中止信号（客户端断开时由上层传入）。 */
  signal?: AbortSignal
}

export interface CallDecisionsResult {
  ok: boolean
  /** 上游 HTTP 状态（网络层失败时为 0）。 */
  status: number
  /** 上游响应体（成功时是决策结果，失败时是错误）。 */
  body: unknown
  /** 网络层失败的说明（`ok=false` 且 `status=0` 时才有）。 */
  error?: string
}

/**
 * 调一次上游 Decisions API。
 *
 * ⚠️ **不抛错**（与各家 `fetch*CreditBalance` 同口径）：所有失败都归到
 * `{ ok:false, status, body/error }`，让上层决定 HTTP 状态码。这样调用方
 * （agent / curl）拿到的永远是结构化响应，而不是一堆栈。
 */
export async function callDecisions(
  request: DecisionsRequest,
  options: CallDecisionsOptions,
): Promise<CallDecisionsResult> {
  const key = await options.apiKey()
  if (key === undefined || key === '') {
    return {
      ok: false,
      status: 401,
      body: { error: { message: '没有可用的 AI Studio API Key：请在 Web 控制台的 AI Studio 渠道添加账号', code: 'missing_api_key' } },
    }
  }

  // 请求体原样透传（上游字段可能比我们已知的多），只补缺省 model。
  const payload = { ...request, model: request.model ?? DECISION_MODEL_ID }

  let response: Response
  try {
    response = await (options.fetcher ?? fetch)(DECISIONS_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // AI Studio 的鉴权方式是 key 头（不是 Bearer）。
        'x-goog-api-key': key,
      },
      body: JSON.stringify(payload),
      signal: options.signal ?? AbortSignal.timeout(DECISIONS_TIMEOUT_MS),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    options.warn?.(`Decisions API 网络失败：${message}`)
    return {
      ok: false,
      status: 0,
      body: undefined,
      error: `Decisions API 网络失败：${message}（Google 域名需走代理，见 gemini.env 的 PROXY=）`,
    }
  }

  const text = await response.text().catch(() => '')
  let body: unknown = text
  if (text !== '') {
    try {
      body = JSON.parse(text)
    } catch {
      // 上游有时回 HTML 错误页（边缘节点）——原样带上，便于辨认。
      body = { error: { message: text.slice(0, 500), code: 'non_json_response' } }
    }
  }

  return { ok: response.ok, status: response.status, body }
}

/**
 * 请求体形状校验（**只挡明显错误**，不重复上游的严格校验）。
 *
 * 为什么不逐字段校验：上游的 schema 会演进（本轮就发现 `choice.criteria`
 * 必须是对象、`score.criteria` 必须是数组，且错误信息不提示正确形状）。
 * 网关若把 schema 抄一份，上游一变就会**拦住本来能用的请求** —— 那比放过
 * 一个坏请求更糟（坏请求会被上游明确拒绝，而误拦是静默的）。
 *
 * ⇒ 这里只检查**结构骨架**：`input` 是数组、`questions` 是非空对象。
 * 字段级的对错交给上游。
 */
export function validateDecisionsRequest(raw: unknown): { ok: true; value: DecisionsRequest } | { ok: false; message: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, message: '请求体必须是 JSON 对象' }
  }
  const record = raw as Record<string, unknown>
  if (!Array.isArray(record.input) || record.input.length === 0) {
    return { ok: false, message: "缺少 input（数组）：把要判断的材料放进去，如 [{\"type\":\"text\",\"text\":\"…\"}]" }
  }
  const questions = record.questions
  if (typeof questions !== 'object' || questions === null || Array.isArray(questions)) {
    return { ok: false, message: '缺少 questions（对象）：键是自定义名字，值含 type/instructions' }
  }
  if (Object.keys(questions as Record<string, unknown>).length === 0) {
    return { ok: false, message: 'questions 不能为空' }
  }
  return { ok: true, value: record as unknown as DecisionsRequest }
}

/**
 * 人类可读的结果摘要（日志 / 控制台用）。
 *
 * 只摘一层（`answers.<key>.choice|noul|score`），不递归 —— 决策结果本来就是扁平的。
 */
export function summarizeDecisions(body: unknown): string {
  if (typeof body !== 'object' || body === null) return '(无响应体)'
  const answers = (body as DecisionsResponse).answers
  if (typeof answers !== 'object' || answers === null) return '(无 answers)'
  const parts: string[] = []
  for (const [name, value] of Object.entries(answers as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue
    const answer = value as Record<string, unknown>
    const confidence = typeof answer.confidence === 'number' ? answer.confidence.toFixed(3) : '?'
    if (typeof answer.choice === 'string') parts.push(`${name}=${answer.choice}(${confidence})`)
    else if (typeof answer.noul === 'number') parts.push(`${name}=${answer.noul.toFixed(3)}`)
    else if (typeof answer.score === 'number') parts.push(`${name}=${answer.score.toFixed(2)}(${confidence})`)
  }
  return parts.length === 0 ? '(answers 为空)' : parts.join(', ')
}
