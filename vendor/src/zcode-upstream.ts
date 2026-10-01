/**
 * ZCode 上游 HTTP 客户端（额度 / 签到 / 模型目录）。
 *
 * ## 这一层与其它 provider 的差异
 *
 * 其它 provider 的「额度 / 签到」是各家私有协议；ZCode 这套的**特点**是
 * 同一组请求头要在三处复用，且**鉴权要求按端点不同**（实测）：
 *
 * | 端点 | 需要 `Authorization: Bearer <jwt>` | 需要 `X-Device-Mid` |
 * |---|---|---|
 * | `GET /zcode-plan/billing/balance` | **是**（缺则 401） | **是**（缺则 400 code 3001） |
 * | `GET /zcode-plan/billing/preview` | 否 | 是 |
 * | `POST /api/v1/event/report` | 否 | 是 |
 * | `POST /zcode-plan/billing/claim` | **是** | 是（另需 captcha 头） |
 * | `GET /api/v1/client/configs` | **是** | 是 |
 *
 * ⚠ 这两条都踩过：不带 `Authorization` 查额度得 **401**；
 * 不带 `X-Device-Mid` 得 **400 `{"code":3001,"msg":"parameter error"}`**。
 *
 * ## 签到为什么要「补激活上报」
 *
 * 服务端**不会主动推送**活动。`preview` 的内容依赖**客户端活跃信号**：
 *
 * ```
 * 补 POST /api/v1/event/report {app_launch, app_daily_active} 之前：
 *   preview → {"code":0,"data":{"plans":[]}}          ← 空
 * 补之后：
 *   preview → {"code":0,"data":{"plans":[{plan_id:"zcode-v3-start-plan-trust-…"}]}}
 * ```
 *
 * **⇒ 「每日随机派发」不是随机推送，而是「服务端按活跃信号决定要不要给」。**
 * 所以要领额度必须**先补两条事件**，再查 preview，再 claim。
 */

import type { ZcodeCredential } from './zcode.js'
import { ZCODE_APP_VERSION_FALLBACK } from './zcode.js'
import type { ZcodeRemoteModelLike } from './zcode-product.js'

/** ZCode 平台 origin（官方默认）。 */
export const ZCODE_ORIGIN = 'https://zcode.z.ai'

/** 免费额度通道的 Anthropic 端点。 */
export const ZCODE_PLAN_MESSAGES_URL = `${ZCODE_ORIGIN}/api/v1/zcode-plan/anthropic/v1/messages`

/** 额度余额端点（**需要 Authorization**）。 */
export const ZCODE_BILLING_BALANCE_URL = `${ZCODE_ORIGIN}/api/v1/zcode-plan/billing/balance`

/** 可领活动预览端点（**不需要 Authorization**）。 */
export const ZCODE_BILLING_PREVIEW_URL = `${ZCODE_ORIGIN}/api/v1/zcode-plan/billing/preview`

/** 领取端点（**需要 Authorization + captcha**）。 */
export const ZCODE_BILLING_CLAIM_URL = `${ZCODE_ORIGIN}/api/v1/zcode-plan/billing/claim`

/** 客户端活跃上报端点（**不需要 Authorization**）。 */
export const ZCODE_EVENT_REPORT_URL = `${ZCODE_ORIGIN}/api/v1/event/report`

/** 客户端配置端点（captcha 配置与模型池都从这里来）。 */
export const ZCODE_CLIENT_CONFIGS_URL = `${ZCODE_ORIGIN}/api/v1/client/configs`

/**
 * 构造 ZCode 的「来源标识」请求头。
 *
 * ⚠ 这些头是官方客户端在真实流量里发的。实测**它们不是 3012 的判据**
 * （判据是请求体里的 system 内容），但它们仍是「像官方客户端」的一部分，
 * 且 `X-Device-Mid` **是硬需求**（缺它 billing 全家桶回 400）。
 */
export function buildZcodeHeaders(
  credential: Pick<ZcodeCredential, 'device_mid' | 'app_version'>,
  options: { authorization?: string; json?: boolean; captcha?: { param: string; region: string } } = {},
): Record<string, string> {
  const appVersion = credential.app_version ?? ZCODE_APP_VERSION_FALLBACK
  const headers: Record<string, string> = {
    'User-Agent': `ZCode/${appVersion}`,
    'HTTP-Referer': ZCODE_ORIGIN,
    'X-ZCode-App-Version': appVersion,
    'X-Release-Channel': 'stable',
    'X-Client-Language': 'zh-CN',
    'X-Client-Timezone': 'Asia/Shanghai',
    'X-Device-Mid': credential.device_mid,
    'X-Platform': 'win32',
    'X-Os-Category': 'windows',
    'anthropic-version': '2023-06-01',
  }
  if (options.json !== false) headers['Content-Type'] = 'application/json'
  if (options.authorization !== undefined) headers['Authorization'] = options.authorization
  if (options.captcha !== undefined) {
    headers['x-aliyun-captcha-verify-param'] = options.captcha.param
    headers['x-aliyun-captcha-verify-region'] = options.captcha.region
  }
  return headers
}

/** 一次额度桶（`balances[]` 的一项）。 */
export interface ZcodeBalanceBucket {
  planId?: string
  /** 展示名（实测为模型名，如 `GLM-5.3-Flash`）。 */
  showName?: string
  /**
   * ★ **计量单位** —— 上游明确下发，实测为 `"token"`。
   *
   * ⚠ **真实缺陷**（用户报障）：「智谱 plan 给的不是积分是 tokens，
   * 应该显示 `Token: xx.yyM` 这种格式」。
   *
   * 上游 `billing/balance` 的桶里有两个字段直接说明单位：
   * ```json
   * { "meter": "model_usage", "unit_type": "token",
   *   "total_units": 100000000, "used_units": 5460725,
   *   "remaining_units": 94539275 }
   * ```
   * 此前我们把它当泛化的「积分」渲染，于是界面显示 `94539275`（无单位、
   * 且量级看起来像积分），而正确形态是 **`94.54M` tokens**。
   */
  unitType?: string
  /** 计量口径（实测 `model_usage`）。 */
  meter?: string
  totalUnits?: number
  usedUnits?: number
  remainingUnits?: number
  availableUnits?: number
  /** 到期时间（Unix 秒）。 */
  expiresAt?: number
}

/** 余额查询结果。 */
export interface ZcodeBalanceResult {
  /** 是否为「企业版」等不下发额度数字的形态（此时 buckets 为空）。 */
  enterprise?: boolean
  buckets: readonly ZcodeBalanceBucket[]
  /** 汇总剩余额度（所有桶累加）。 */
  remaining: number
  /** 汇总总量。 */
  total: number
  /** 最早到期时间（Unix 秒），用于展示解禁时刻。 */
  expiresAt?: number
  /** 显示名（首个桶的模型名）。 */
  planName?: string
}

/** 一次可领活动。 */
export interface ZcodeClaimablePlan {
  planId: string
  priority: number
  name?: string
}

/** 领取结果。 */
export interface ZcodeClaimOutcome {
  planId: string
  /** 上游业务码：`0` 成功、`1003` 已领取（幂等成功）。 */
  code?: number
  ok: boolean
  /** 已领取过（幂等，视为成功）。 */
  alreadyClaimed?: boolean
  httpStatus?: number
  message?: string
}

/** 从数字字段安全取值（上游可能给 `null`）。 */
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * `fetch` 的超时包装（外部输入必须有上限）。
 *
 * ⚠ **必须用调用方传进来的 `fetchImpl`**，不能直接用全局 `fetch`。
 *
 * **真实缺陷**（做 ref 缺口探针时暴露）：早期这里写的是裸 `fetch(...)`，
 * 而所有公开函数都接收 `fetchImpl` 参数**却从不往下传** —— 于是
 * `ZcodeAuth` 注入的桩 fetch 对「额度 / 签到 / captcha 配置」全部无效：
 *   - 单测无法桩住网络（会真的打上游）；
 *   - `fetchImpl` 沦为**死参数**（签名说有、行为上没有）。
 *
 * 症状很隐蔽：`ZcodeAdapter` 的推理路径**自己**用 `this.fetchImpl`，
 * 所以「推理桩得住、额度桩不住」，看起来像是额度接口本身的问题。
 */
async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: string,
  init: RequestInit & { timeoutMs?: number },
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 查余额。
 *
 * ⚠ **`Authorization` 必需**（缺则 401）；`X-Device-Mid` 也必需
 * （缺则 400 code 3001）。
 *
 * 企业版（`displayMode: "enterprise"`）不下发额度数字、只给外部链接 ——
 * 此时返回 `{enterprise:true, buckets:[]}`，**不要**显示成 0
 * （0 是「已用光」的语义）。
 */
export async function fetchZcodeBalance(
  credential: ZcodeCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<ZcodeBalanceResult | undefined> {
  const response = await fetchWithTimeout(fetchImpl, ZCODE_BILLING_BALANCE_URL, {
    method: 'GET',
    headers: buildZcodeHeaders(credential, { authorization: `Bearer ${credential.zcode_jwt}` }),
  }, 30_000)
  if (!response.ok) return undefined

  let parsed: {
    code?: unknown
    data?: {
      displayMode?: unknown
      balances?: unknown
      plans?: unknown
    }
  }
  try {
    parsed = await response.json() as typeof parsed
  } catch {
    return undefined
  }
  const data = parsed.data
  if (data === undefined) return undefined
  if (typeof data.displayMode === 'string' && data.displayMode === 'enterprise') {
    return { enterprise: true, buckets: [], remaining: 0, total: 0 }
  }

  const rawBuckets = Array.isArray(data.balances) ? data.balances : []
  const buckets: ZcodeBalanceBucket[] = []
  for (const item of rawBuckets) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    buckets.push({
      planId: typeof record.plan_id === 'string' ? record.plan_id : undefined,
      showName: typeof record.show_name === 'string' ? record.show_name : undefined,
      // ⚠ 单位字段必须带上：上游说 `unit_type: "token"`，界面据此显示 M 量级。
      unitType: typeof record.unit_type === 'string' ? record.unit_type : undefined,
      meter: typeof record.meter === 'string' ? record.meter : undefined,
      totalUnits: num(record.total_units),
      usedUnits: num(record.used_units),
      remainingUnits: num(record.remaining_units),
      availableUnits: num(record.available_units),
      expiresAt: num(record.expires_at),
    })
  }

  let remaining = 0
  let total = 0
  let expiresAt: number | undefined
  for (const bucket of buckets) {
    // 优先用 available（若给了），否则用 remaining。
    remaining += bucket.availableUnits ?? bucket.remainingUnits ?? 0
    total += bucket.totalUnits ?? 0
    const exp = bucket.expiresAt
    if (exp !== undefined && (expiresAt === undefined || exp < expiresAt)) expiresAt = exp
  }

  return {
    buckets,
    remaining,
    total,
    expiresAt,
    planName: buckets[0]?.showName,
  }
}

/**
 * 补客户端活跃信号。
 *
 * ⚠ **这一步不能省**：不补这两条事件，`preview` 恒为空 `plans: []` ——
 * 于是「今天可领」永远是「没有可领」，用户以为签到坏了。
 *
 * 幂等（服务端按 device_mid + 日期去重），故每次查 preview 前都可以补。
 */
export async function reportZcodeActivation(
  credential: ZcodeCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const appVersion = credential.app_version ?? ZCODE_APP_VERSION_FALLBACK
  for (const event of ['app_launch', 'app_daily_active']) {
    try {
      await fetchWithTimeout(fetchImpl, ZCODE_EVENT_REPORT_URL, {
        method: 'POST',
        headers: buildZcodeHeaders(credential, { json: true }),
        body: JSON.stringify({
          event,
          device_mid: credential.device_mid,
          platform: 'win32',
          app_version: appVersion,
        }),
      }, 20_000)
    } catch {
      // 上报失败不阻塞（下一次调用会再补）。
    }
  }
}

/** 查当前可领的活动。 */
export async function fetchZcodeClaimablePlans(
  credential: ZcodeCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<readonly ZcodeClaimablePlan[]> {
  const appVersion = credential.app_version ?? ZCODE_APP_VERSION_FALLBACK
  const url = `${ZCODE_BILLING_PREVIEW_URL}?app_version=${encodeURIComponent(appVersion)}&platform=win32`
  const response = await fetchWithTimeout(fetchImpl, url, {
    method: 'GET',
    headers: buildZcodeHeaders(credential, { json: false }),
  }, 25_000)
  if (!response.ok) return []
  let parsed: { data?: { plans?: unknown } }
  try {
    parsed = await response.json() as typeof parsed
  } catch {
    return []
  }
  const raw = Array.isArray(parsed.data?.plans) ? parsed.data.plans : []
  const plans: ZcodeClaimablePlan[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    if (typeof record.plan_id !== 'string' || record.plan_id.length === 0) continue
    plans.push({
      planId: record.plan_id,
      priority: num(record.priority) ?? 0,
      name: typeof record.name === 'string' ? record.name : undefined,
    })
  }
  // priority 降序（与官方/第三方实现一致：先领高优先级）。
  plans.sort((a, b) => b.priority - a.priority)
  return plans
}

/**
 * 领取一个 plan。
 *
 * ⚠ **captcha 是一次性的**：每个 plan 都必须**重新 mint** 一个新 param。
 * 复用同一个 param 会得到 `3007`（captcha 校验失败）。
 *
 * 业务码语义（桥侧实测记录）：
 *
 * | code | 含义 | 处理 |
 * |---|---|---|
 * | `0` | 成功领取 | ok |
 * | `1003` | **已领取过（幂等，不是错误）** | 视为成功 |
 * | `1001` | plan 不存在 | 失败 |
 * | `1002` | 活动已结束 | 失败 |
 * | `1004` | 不符合条件 | 失败 |
 * | `1005` | 名额用完 | 失败 |
 * | `3007` | captcha 失败（需换新 param） | 失败 |
 * | 401 | 未登录 | 失败 |
 */
export async function claimZcodePlan(
  credential: ZcodeCredential,
  planId: string,
  captcha: { param: string; region: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ZcodeClaimOutcome> {
  let response: Response
  try {
    response = await fetchWithTimeout(fetchImpl, ZCODE_BILLING_CLAIM_URL, {
      method: 'POST',
      headers: buildZcodeHeaders(credential, {
        authorization: `Bearer ${credential.zcode_jwt}`,
        captcha,
      }),
      body: JSON.stringify({ plan_id: planId }),
    }, 60_000)
  } catch (error) {
    return {
      planId,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }
  }

  const text = await response.text().catch(() => '')
  let code: number | undefined
  let message: string | undefined
  try {
    const parsed = JSON.parse(text) as { code?: unknown; msg?: unknown; message?: unknown }
    code = num(parsed.code)
    message = typeof parsed.msg === 'string' ? parsed.msg
      : typeof parsed.message === 'string' ? parsed.message : undefined
  } catch {
    message = text.slice(0, 200)
  }

  // 1003 = 已领取过 —— **幂等成功，不是错误**。
  const alreadyClaimed = code === 1003
  const ok = response.ok && (code === 0 || alreadyClaimed)
  return {
    planId,
    code,
    ok,
    alreadyClaimed,
    httpStatus: response.status,
    message: message ?? (ok ? undefined : `HTTP ${response.status}`),
  }
}

/**
 * 拉服务端下发的 captcha 配置。
 *
 * ⚠ `platform` 必须是 **`unknown`** —— 实测 `win32` / `win64` / `windows` /
 * `electron` / `desktop` / `linux` 一律 `400 {"code":3001}`。
 * `unknown` 正是官方在非 Electron 上下文的取值。
 *
 * 失败返回 `undefined`，由调用方回退到内置兜底值
 * （{@link ZCODE_CAPTCHA_FALLBACK}）—— **不让配置拉取失败阻塞推理**。
 */
export async function fetchZcodeCaptchaConfig(
  credential: ZcodeCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<{ region: string; prefix: string; sceneId: string } | undefined> {
  const appVersion = credential.app_version ?? ZCODE_APP_VERSION_FALLBACK
  const url = `${ZCODE_CLIENT_CONFIGS_URL}?app_version=${encodeURIComponent(appVersion)}&platform=unknown`
  try {
    const response = await fetchWithTimeout(fetchImpl, url, {
      method: 'GET',
      headers: buildZcodeHeaders(credential, { authorization: `Bearer ${credential.zcode_jwt}`, json: false }),
    }, 20_000)
    if (!response.ok) return undefined
    const parsed = await response.json() as {
      data?: { configs?: { captcha?: { region?: unknown; prefix?: unknown; sceneId?: unknown } } }
    }
    const captcha = parsed.data?.configs?.captcha
    if (captcha === undefined) return undefined
    const region = captcha.region
    const prefix = captcha.prefix
    const sceneId = captcha.sceneId
    if (typeof region !== 'string' || typeof prefix !== 'string' || typeof sceneId !== 'string') {
      return undefined
    }
    return { region, prefix, sceneId }
  } catch {
    return undefined
  }
}

/**
 * 从上游拉**模型目录**（含上下文窗口、最大输出、思考档位、视觉能力）。
 *
 * ## ⚠ 为什么要真拉，不能照抄兜底表
 *
 * **真实缺陷**（用户报障）：模型配置页里上下文窗口显示 **1,000,000**、
 * 最大输出 **128,000**，而思考档位选择器**根本没出现** —— 尽管 ZCode IDE
 * 里可以设置。
 *
 * 兜底表当时填的是 `200_000` / `32_768`（**凭空估的**），且模型都标了
 * `supportsImage: true`（但上游说只有 Flash 有 `capabilities.vision`）。
 * ⇒ 这类「能力字段」必须**抄上游**，不能按「同族应该一样」推断。
 *
 * ## 上游形状（`GET /api/v1/client/configs` 的 `data.builtinModels`）
 *
 * ⚠ `builtinModels` 是**对象**（key 不是模型 id，实测为序号字串），
 * 故必须 `Object.values(...)` 而不是数组下标。实测两条：
 *
 * ```json
 * { "modelId": "GLM-5.3-Flash", "contextWindow": 1000000,
 *   "maxCompletionTokens": 128000,
 *   "capabilities": { "vision": true },
 *   "modalities": { "input": ["text","image","video"], "output": ["text"] },
 *   "reasoning": { "levels": { "low": {...}, "max": {...}, "high": {...} },
 *                  "defaultLevel": "max" } }
 * ```
 *
 * ⚠ `reasoning.levels` 的**键序**就是官方展示顺序（实测 low → max → high
 * 的插入序，但客户端按 `low/high/max` 渲染 —— 故我们**显式排序**为
 * `low → high → max`，与 IDE 截图一致；未知档位排在后面保持原序）。
 *
 * 失败返回 `undefined`，由调用方回退兜底表（**不让目录拉取失败让 provider 不可用**）。
 */
export async function fetchZcodeModels(
  credential: ZcodeCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<ZcodeRemoteModelLike[] | undefined> {
  const appVersion = credential.app_version ?? ZCODE_APP_VERSION_FALLBACK
  const url = `${ZCODE_CLIENT_CONFIGS_URL}?app_version=${encodeURIComponent(appVersion)}&platform=unknown`
  try {
    const response = await fetchWithTimeout(fetchImpl, url, {
      method: 'GET',
      headers: buildZcodeHeaders(credential, { authorization: `Bearer ${credential.zcode_jwt}`, json: false }),
    }, 20_000)
    if (!response.ok) return undefined
    const parsed = await response.json() as { data?: { builtinModels?: unknown } }
    const raw = parsed.data?.builtinModels
    if (typeof raw !== 'object' || raw === null) return undefined
    /**
     * ⚠ `builtinModels` 是**对象**（键为序号）—— 实测：
     * `{"0": {...GLM-5.3}, "1": {...GLM-5.3-Flash}}`。
     * 用 `Array.isArray` 判定会得到「0 个模型」的**假阴性**。
     */
    const entries = Array.isArray(raw) ? raw : Object.values(raw as Record<string, unknown>)
    const models: ZcodeRemoteModelLike[] = []
    for (const item of entries) {
      if (typeof item !== 'object' || item === null) continue
      const record = item as Record<string, unknown>
      const id = record.modelId ?? record.id
      if (typeof id !== 'string' || id.length === 0) continue
      const contextWindow = num(record.contextWindow)
      const maxCompletionTokens = num(record.maxCompletionTokens ?? record.maxTokens)
      const capabilities = record.capabilities
      const vision = typeof capabilities === 'object' && capabilities !== null
        ? (capabilities as { vision?: unknown }).vision === true
        : false
      /** 档位：按 IDE 的展示序 `low → high → max`，未知档位按原序排后面。 */
      const reasoning = record.reasoning
      let reasoningLevels: string[] | undefined
      let defaultReasoningLevel: string | undefined
      if (typeof reasoning === 'object' && reasoning !== null) {
        const levels = (reasoning as { levels?: unknown }).levels
        if (typeof levels === 'object' && levels !== null) {
          const keys = Object.keys(levels as Record<string, unknown>)
          if (keys.length > 0) reasoningLevels = orderReasoningLevels(keys)
        }
        const def = (reasoning as { defaultLevel?: unknown }).defaultLevel
        if (typeof def === 'string' && def.length > 0) defaultReasoningLevel = def
      }
      models.push({
        id,
        name: typeof record.name === 'string' && record.name.length > 0 ? record.name : id,
        // 缺字段时给保守值（0 会让 DSH 认为无窗口）。
        contextWindow: contextWindow !== undefined && contextWindow > 0 ? contextWindow : 200_000,
        maxTokens: maxCompletionTokens !== undefined && maxCompletionTokens > 0
          ? maxCompletionTokens
          : 32_768,
        supportsImage: vision,
        ...reasoningLevels !== undefined ? { reasoningLevels } : {},
        ...defaultReasoningLevel !== undefined ? { defaultReasoningLevel } : {},
      })
    }
    return models.length > 0 ? models : undefined
  } catch {
    return undefined
  }
}

/**
 * 把档位键排成 IDE 的展示序。
 *
 * ⚠ **不能直接用对象的键序**：上游 JSON 里 `levels` 的插入序实测是
 * `low, max, high`，而 IDE 的档位条显示 `low, high, max`（用户截图为证）。
 * 已知档位按 `low → medium → high → xhigh → max` 排，未知的按原序追加。
 */
function orderReasoningLevels(keys: readonly string[]): string[] {
  const order = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  const known = order.filter((level) => keys.includes(level))
  const unknown = keys.filter((key) => !order.includes(key))
  return [...known, ...unknown]
}
