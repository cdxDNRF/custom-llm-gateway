/**
 * **渠道原生搜索**：把供应商自带的搜索端点接成标准的 `web_search` 工具调用。
 *
 * ## 要解决的问题
 *
 * 客户端（酒馆 / opencode / ccswitch …）声明的 `web_search` 工具，最终会变成
 * 一个 `tool_call` 交给客户端自己执行 —— 但很多客户端**没有**搜索实现，
 * 于是模型永远拿不到搜索结果。
 *
 * 而多家供应商**自带搜索后端**（与聊天同源、同账号）：
 *
 * | 渠道 | 原生端点 | 认证 |
 * |---|---|---|
 * | `buddy` / `workbuddy` | 腾讯 `{endpoint}/agenttool/v1/search` | `Bearer access_token` |
 * | `qoder` / `qodercn` | Qoder `/api/v1/webSearch/oneSearch` | WASM 签名（COSY） |
 *
 * ⇒ 本模块直接调那个端点，把结果包成 `tool_call` 返回给客户端 ——
 *   **任意 agent 客户端都能因此获得搜索能力**，无需客户端自己实现。
 *
 * ## 与 Jet Hub 插件的关系（同效果，不同架构）
 *
 * Jet Hub 是 **DSH 插件**，在 Cordis 的 `tools/execute` waterfall 上拦截官方
 * `web_search`；本网关没有那个 seam，故改为在 **HTTP 聚合层**识别工具声明。
 * 两者达成的效果一致：模型可用的工具名不变、结果形状同构。
 *
 * ## 三条硬约束（都来自实测/踩坑）
 *
 * 1. **只在该渠道支持时才介入**：能力表里没有的渠道**原样透传**，
 *    不让功能影响既有链路。
 * 2. **搜索失败不下毒**：失败时返回一条**可读的错误文本**作为工具结果，
 *    而不是让整个对话报 500 —— 模型能据此改用其它方式回答。
 * 3. **必须过滤空 `url`**：实测腾讯搜索结果里**第一条的 `url` 就是空字符串**
 *    （"来自日历插件的参考资料"）。官方 `web_search` 的 schema 要求 `url` 必填，
 *    空值会让客户端校验失败、**整条工具调用报废**（不是少一条结果）。
 */
import type { Provider } from './provider.js'

/** 一条搜索结果（对齐官方 `web_search` 的 `sources[]` 形态）。 */
export interface NativeSearchSource {
  url: string
  title?: string
  snippet?: string
}

/** 搜索请求。 */
export interface NativeSearchRequest {
  query: string
  /** 最多返回几条（默认 5）。 */
  maxResults?: number
  /** 允许的域名（部分后端支持）。 */
  allowedDomains?: readonly string[]
}

/** 搜索失败的分类（供调用方决定文案）。 */
export class NativeSearchError extends Error {
  readonly code:
    | 'NO_ACCOUNT'
    | 'UPSTREAM'
    | 'BAD_RESPONSE'
    | 'TIMEOUT'
    | 'UNSUPPORTED'
  constructor(code: NativeSearchError['code'], message: string) {
    super(message)
    this.name = 'NativeSearchError'
    this.code = code
  }
}

/** 单次搜索的上游超时（毫秒）。与官方客户端 20s 对齐。 */
const SEARCH_TIMEOUT_MS = 20_000

/** 默认结果条数。 */
const DEFAULT_MAX_RESULTS = 5

/**
 * 哪些渠道支持原生搜索（**能力表**）。
 *
 * ⚠️ 新增渠道时**只在这里加一行**，实现放到 `backends` 里 —— 两者分离是为了
 *    让「支持哪些渠道」一眼可见（而不是埋在 if/else 里）。
 */
export const NATIVE_SEARCH_PROVIDERS: ReadonlySet<string> = new Set([
  'buddy',
  'workbuddy',
  'qoder',
  'qodercn',
])

/**
 * 执行一次原生搜索。
 *
 * @throws {NativeSearchError}
 */
export async function nativeSearch(
  provider: Provider,
  request: NativeSearchRequest,
): Promise<NativeSearchSource[]> {
  const id = provider.id
  if (!NATIVE_SEARCH_PROVIDERS.has(id)) {
    throw new NativeSearchError('UNSUPPORTED', `渠道 ${id} 不支持原生搜索`)
  }
  if (id === 'buddy' || id === 'workbuddy') {
    return await searchViaTencent(provider, request)
  }
  if (id === 'qoder' || id === 'qodercn') {
    return await searchViaQoder(provider, request)
  }
  throw new NativeSearchError('UNSUPPORTED', `渠道 ${id} 尚未接入原生搜索`)
}

/**
 * 从 provider 的账号池里取第一个可用账号的凭据。
 *
 * ⚠️ **每次现读**（不缓存）：用户可能在界面上停用/新增账号，缓存会让开关失灵。
 * ⚠️ 只取 `enabled` 的账号：停用的账号不该被用来搜索。
 */
async function firstEnabledCredential(
  provider: Provider,
): Promise<Record<string, unknown> | undefined> {
  const entries = await provider.pool.listAccounts(provider.id)
  for (const entry of entries) {
    if (entry.enabled !== true) continue
    const raw = provider.gateway.credentials.get(entry.credentialRef)
    if (raw === undefined) continue
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      return parsed
    } catch {
      // 凭据损坏：跳过该账号（不因一个坏条目让整个搜索失效）。
    }
  }
  return undefined
}

/**
 * 腾讯原生搜索（buddy / workbuddy）。
 *
 * 实测（2026-10-20）：用账号池里的 `access_token` 直调即 200，无需额外签名。
 * 请求体与响应形状来自官方客户端逆向（见 Jet Hub 的
 * `docs/workbuddy-native-search-research.md`）。
 */
async function searchViaTencent(
  provider: Provider,
  request: NativeSearchRequest,
): Promise<NativeSearchSource[]> {
  const credential = await firstEnabledCredential(provider)
  const token = typeof credential?.access_token === 'string' ? credential.access_token : ''
  if (token.length === 0) {
    throw new NativeSearchError(
      'NO_ACCOUNT',
      `${provider.id}: 没有可用的登录账号 —— 请先在「供应商」页为该渠道新建账号。`,
    )
  }

  // 端点前缀随产品变（CodeBuddy / WorkBuddy 各自不同）。
  const endpoint = `${tencentEndpointOf(provider.id)}/agenttool/v1/search`
  const body: Record<string, unknown> = {
    query: request.query,
    type: 'text2text',
    max_results: request.maxResults ?? DEFAULT_MAX_RESULTS,
  }
  // ⚠️ `allowed_domains` 是**独立字段**；而 `blocked_domains` 在官方客户端里
  //    是**拼进 query 的 `-site:` 后缀**（不是字段）—— 这里只支持前者。
  if (request.allowedDomains !== undefined && request.allowedDomains.length > 0) {
    body.allowed_domains = [...request.allowedDomains]
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)
  timer.unref?.()

  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json;charset=UTF-8',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (error) {
    clearTimeout(timer)
    const aborted = (error as { name?: string }).name === 'AbortError'
    throw new NativeSearchError(
      aborted ? 'TIMEOUT' : 'UPSTREAM',
      aborted
        ? `${provider.id} 搜索超时（${SEARCH_TIMEOUT_MS}ms）。`
        : `${provider.id} 搜索请求失败：${String(error)}`,
    )
  }
  clearTimeout(timer)

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new NativeSearchError(
      'UPSTREAM',
      `${provider.id} 搜索失败（HTTP ${response.status}）—— ${detail.slice(0, 200)}`,
    )
  }

  let json: unknown
  try {
    json = await response.json()
  } catch (error) {
    throw new NativeSearchError('BAD_RESPONSE', `${provider.id} 搜索响应不是 JSON：${String(error)}`)
  }

  const results = (json as { results?: unknown }).results
  if (!Array.isArray(results)) {
    throw new NativeSearchError(
      'BAD_RESPONSE',
      `${provider.id} 搜索响应形状异常（缺少 results 数组）—— 上游 API 可能已变更。`,
    )
  }

  const out: NativeSearchSource[] = []
  for (const raw of results) {
    if (typeof raw !== 'object' || raw === null) continue
    const item = raw as { url?: unknown; title?: unknown; snippet?: unknown }
    const url = typeof item.url === 'string' ? item.url.trim() : ''
    // ⚠️ **必须过滤空 url**：实测第一条结果（"来自日历插件的参考资料"）的 url
    //    就是空字符串。官方 schema 要求 url 必填，空值会让客户端校验失败、
    //    整条工具调用报废 —— 宁可少一条结果。
    if (url.length === 0) continue
    out.push({
      url,
      ...(typeof item.title === 'string' && item.title.length > 0 ? { title: item.title } : {}),
      ...(typeof item.snippet === 'string' && item.snippet.length > 0 ? { snippet: item.snippet } : {}),
    })
  }
  return out
}

/** 腾讯系产品的端点前缀（与 vendor 的 `API_ENDPOINT` 保持一致）。 */
function tencentEndpointOf(_providerId: string): string {
  // ⚠️ 目前 CodeBuddy 与 WorkBuddy 实测共用 `copilot.tencent.com`。
  //    若将来分开，按 providerId 返回不同值即可（这里保留参数以示意）。
  return 'https://copilot.tencent.com'
}

/**
 * Qoder 原生搜索。
 *
 * ⚠️ Qoder 的请求体要 **WASM 加密**并生成 `COSY.<载荷>.<签名>` 请求头。
 *    我们的 vendor 里已有 `QoderEncryptedInfer`（`vendor/src/qoder-wasm.ts`），
 *    但它的 `prepareRequest` 目前只服务推理链路 —— 搜索路径需要确认签名
 *    是否同样适用。**故本函数暂时明确报「未接入」而不是假装支持**
 *    （宁可让用户看到清晰的"未支持"，也不要静默返回空结果）。
 */
async function searchViaQoder(
  provider: Provider,
  request: NativeSearchRequest,
): Promise<NativeSearchSource[]> {
  const credential = await firstEnabledCredential(provider)
  const oauthToken = typeof credential?.security_oauth_token === 'string'
    ? credential.security_oauth_token
    : typeof credential?.access_token === 'string' ? credential.access_token : ''
  const machineId = typeof credential?.machine_id === 'string' ? credential.machine_id : ''
  if (oauthToken.length === 0 || machineId.length === 0) {
    throw new NativeSearchError(
      'NO_ACCOUNT',
      `${provider.id}: 没有可用的登录账号（缺 security_oauth_token / machine_id）`
      + ' —— 请先在「供应商」页重新登录该渠道。',
    )
  }

  // ⚠️ 用产品配置里的身份与 host（不硬编码）：Qoder 的 `clientMetadata` 是
  //    请求签名的一部分，写错会被上游拒；而 CN / 国际站的 host 不同。
  const { QODER, QODER_CN } = await import('../../vendor/src/qoder-product.js')
  const product = provider.id === 'qodercn' ? QODER_CN : QODER
  const host = product.encryptedInferBase
  const { QoderEncryptedInfer } = await import('../../vendor/src/qoder-wasm.js')

  // ⚠️ 每次新建 + finally dispose：wasm 的 QoderContext 是堆上对象，
  //    不释放会让进程级 wasm 堆只增不减，长会话最后以裸 `unreachable` 暴毙
  //    （见 vendor/src/qoder-wasm.ts 文件头的事故记录）。
  let client: Awaited<ReturnType<typeof QoderEncryptedInfer.create>> | undefined
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)
  timer.unref?.()
  try {
    client = await QoderEncryptedInfer.create({
      user: { uid: typeof credential?.uid === 'string' ? credential.uid : '', securityOauthToken: oauthToken },
      machineId,
      metadata: { ...product.clientMetadata },
      host,
    })

    // ① payload（照官方 WebSearchTool 的字段与默认值）
    const payload = {
      query: request.query,
      timeRange: 'NoLimit',
      // ⚠️ 三项都关：只要标题/link/snippet，不要正文（正文会让响应大几十倍）。
      contents: { mainText: false, markdownText: false, summary: false },
    }
    // ② 信封：官方是 `{ payload: <JSON 字符串>, encodeVersion: '1' }`
    const bodyJson = JSON.stringify({ payload: JSON.stringify(payload), encodeVersion: '1' })
    // ③ WASM 生成 url + 全套 COSY 签名头
    const signed = client.prepareRequest(host, '/api/v1/webSearch/oneSearch', 'POST', 'auth', bodyJson, undefined)

    const response = await fetch(signed.url, {
      method: 'POST',
      headers: signed.headers,
      body: signed.body,
      signal: controller.signal,
    })
    clearTimeout(timer)

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new NativeSearchError(
        'UPSTREAM',
        `${provider.id} 搜索失败（HTTP ${response.status}）—— ${detail.slice(0, 200)}`,
      )
    }

    const json = await response.json() as { pageItems?: unknown }
    const items = json.pageItems
    if (!Array.isArray(items)) {
      throw new NativeSearchError(
        'BAD_RESPONSE',
        `${provider.id} 搜索响应形状异常（缺少 pageItems 数组）—— 上游 API 可能已变更。`,
      )
    }

    const out: NativeSearchSource[] = []
    for (const raw of items) {
      if (typeof raw !== 'object' || raw === null) continue
      const item = raw as { link?: unknown; title?: unknown; snippet?: unknown }
      // ⚠️ Qoder 的字段名是 `link`（不是 `url`）。
      const url = typeof item.link === 'string' ? item.link.trim() : ''
      // ⚠️ 必须过滤空 url：官方 schema 要求 url 必填，空值会让整条工具调用报废。
      if (url.length === 0) continue
      out.push({
        url,
        ...(typeof item.title === 'string' && item.title.length > 0 ? { title: item.title } : {}),
        ...(typeof item.snippet === 'string' && item.snippet.length > 0 ? { snippet: item.snippet } : {}),
      })
    }
    return out
  } catch (error) {
    clearTimeout(timer)
    if (error instanceof NativeSearchError) throw error
    const aborted = (error as { name?: string }).name === 'AbortError'
    throw new NativeSearchError(
      aborted ? 'TIMEOUT' : 'UPSTREAM',
      aborted
        ? `${provider.id} 搜索超时（${SEARCH_TIMEOUT_MS}ms）。`
        : `${provider.id} 搜索失败：${String(error)}`,
    )
  } finally {
    clearTimeout(timer)
    client?.dispose()
  }
}



/**
 * 从工具列表里挑出「我们接管的搜索工具」。
 *
 * ⚠️ 只在客户端**显式声明了**该工具时才接管：没声明就不该有搜索行为
 *    （否则等于偷偷给模型加了能力，不可预期）。
 */
export function pickSearchTool(
  tools: readonly unknown[] | undefined,
): { name: string } | undefined {
  if (!Array.isArray(tools)) return undefined
  for (const tool of tools) {
    const name = toolNameOf(tool)
    if (name !== undefined && isSearchToolName(name)) return { name }
  }
  return undefined
}

/**
 * 从一个工具声明里取工具名。
 *
 * ⚠️⚠️ **必须同时认两种形状**（真实缺陷，2026-10-20 实测）：
 *
 *   OpenAI:  `{ type:'function', function:{ name:'web_search', … } }`
 *   Gemini:  `{ name:'web_search', parameters:{…} }`
 *
 * 先前只读 `tool.name` ⇒ **OpenAI 格式永远匹配不到**（名字在 `function.name`），
 * 于是原生搜索**完全不生效**，而现象是「模型返回 tool_calls 自己调」——
 * 看起来像模型的选择问题，实际是我们没认出来。
 */
function toolNameOf(tool: unknown): string | undefined {
  if (typeof tool !== 'object' || tool === null) return undefined
  const rec = tool as { name?: unknown; function?: { name?: unknown } }
  if (typeof rec.name === 'string' && rec.name.length > 0) return rec.name
  if (typeof rec.function?.name === 'string' && rec.function.name.length > 0) return rec.function.name
  return undefined
}

/**
 * 把搜索结果包成**上游模型能理解的一则上下文消息**。
 *
 * ## 为什么走「注入上下文」而不是「返回 tool_call」
 *
 * 客户端（酒馆等）**没有搜索实现** —— 返回 `tool_call` 它执行不了，对话就卡住。
 * 故由网关**在服务端完成整个搜索闭环**：先搜、再把资料作为上下文交给模型、
 * 模型基于真实资料回答。客户端全程无感（仍是普通的一次 chat 请求）。
 *
 * 这与 Jet Hub 插件达到的**效果**一致（模型回答时手里有真实搜索结果），
 * 只是拦截点不同（它在工具执行层，我们在 HTTP 聚合层）。
 */
export function buildSearchContextMessage(
  query: string,
  sources: readonly NativeSearchSource[],
): string {
  return [
    '[网络搜索结果]',
    `针对查询「${query}」，网关已通过该渠道的原生搜索后端取得以下资料：`,
    '',
    renderSearchResults(query, sources),
    '',
    '请基于以上资料回答用户的问题，并在合适处引用来源 URL。',
    '若资料不足以回答，请明确说明，不要编造。',
  ].join('\n')
}

/**
 * 把搜索结果**合并进最后一条 user 消息**（而不是追加一条 system）。
 *
 * ⚠️ 为什么不能追加 `role:'system'`（真实缺陷，2026-10-20 实测）：
 *    OpenAI 协议里 system 消息**惯例在最前**，追加到末尾（在 user 之后）
 *    会让多数上游**忽略它** —— 实测模型回答"我无法获取实时信息"，
 *    明明搜索已成功、资料也注入了，模型却完全没看到。
 *
 * 合并进 user 消息则不存在这个问题：模型**必然**会读到自己那条输入。
 */
export function injectSearchIntoMessages<T extends { role?: string; content?: unknown }>(
  messages: readonly T[],
  context: string,
): T[] {
  if (messages.length === 0) return [...messages]
  // 从后往前找最后一条 user。
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role !== 'user') continue
    const content = message.content
    const merged = typeof content === 'string'
      ? `${content}\n\n${context}`
      : Array.isArray(content)
        ? [...content, { type: 'text', text: context }]
        : context
    const copy = [...messages]
    copy[i] = { ...message, content: merged } as T
    return copy
  }
  // 没有 user 消息（极罕见）：追加一条。
  return [...messages, { role: 'user', content: context } as unknown as T]
}

/**
 * 把搜索结果渲染成**模型可读**的文本（作为 tool_call 的结果内容）。
 *
 * 形状参考各家 web_search 的通用约定：编号列表 + 标题 + URL + 摘要。
 */
export function renderSearchResults(query: string, sources: readonly NativeSearchSource[]): string {
  if (sources.length === 0) {
    return `搜索「${query}」没有返回结果。可以换个关键词，或直接基于已有知识回答。`
  }
  const lines = [`搜索「${query}」的结果（共 ${sources.length} 条）：`, '']
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i]!
    lines.push(`${i + 1}. ${s.title ?? '(无标题)'}`)
    lines.push(`   ${s.url}`)
    if (s.snippet !== undefined) lines.push(`   ${s.snippet}`)
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

/** 判断某个工具名是否是我们接管的搜索工具。 */
export function isSearchToolName(name: string): boolean {
  const normalized = name.toLowerCase()
  // 精确名（各家标准写法）
  if (normalized === 'web_search'
    || normalized === 'websearch'
    || normalized === 'web_search_20250305'
    || normalized === 'search') return true
  // ⚠️ **模式匹配**（真实缺陷，2026-10-20 用户报障）：各客户端/agent 框架会用
  //    **带前缀**的搜索工具名，精确枚举永远追不上。实测 DSH 传的是：
  //      `exa_web_search_exa`、`tavily_tavily_search`、`tavily_tavily_research`
  //    这些都不等于 `web_search` ⇒ 只做精确匹配就**完全不生效**，
  //    而症状是"模型自己调搜索工具却返回 0 条结果"（因为那些工具没配 key），
  //    极易被误判成"搜索功能坏了"。
  //
  //    判据：名字里**含 `search`** 且不是常见的**非搜索**工具
  //    （如 `search_files` / `grep_search` 这类本地文件搜索不该被接管）。
  if (!normalized.includes('search')) return false
  // 排除本地/非网络搜索（这些不该走渠道原生搜索）
  if (normalized.includes('file') || normalized.includes('code')
    || normalized.includes('grep') || normalized.includes('repo')) return false
  return true
}
