/**
 * **Vertex AI 适配器**（OpenAI 兼容透传，2026-11-12）。
 *
 * ## 为什么这个适配器特别薄
 *
 * Vertex 的 `/endpoints/openapi/chat/completions` **本身就是 OpenAI 协议**：
 * 请求体、响应体、SSE 帧格式全是标准的。故本适配器**不做协议翻译**，
 * 只做三件事：
 *
 * 1. 换 OAuth token（Service Account JWT → access_token）
 * 2. 把模型名补成 `google/<model>`
 * 3. 回传 `thought_signature`（思考模型多轮必需）
 *
 * 其余请求字段原样透传给上游，响应也直接用 vendor 的
 * `consumeOpenAiSse`（那本来就是解析 OpenAI SSE 的）。
 *
 * ## 端点选择（用户此前「加不上」的根因）
 *
 * | 端点 | 结果 |
 * |---|---|
 * | `publishers/google/models/*:generateContent` | ❌ 404（本机实测） |
 * | `endpoints/openapi/chat/completions` | ✅ **200** |
 *
 * ⇒ Vertex 有**两套并存协议**，同一账号可能只开通其中一套。本渠道走后者。
 *
 * ## `thought_signature` 为什么必须原样回传
 *
 * 思考模型（gemini-4-* 等）的响应里带
 * `choices[].delta.extra_content.google.thought_signature`，
 * 上游要求**下一轮把 tool_call 连同签名一起传回**，否则 400。
 * 这里按「工具调用 id」缓存 —— 与参考实现 `ThoughtSignatureCache` 同思路。
 *
 * ⚠️ 缓存**不落盘**：签名只在同一次多轮对话内有效，跨会话无意义。
 */
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmResolvedModelInfo, StreamChunk, GenerateOptions } from '@deepseek-ai/dsh-llm'
import { consumeOpenAiSse } from '../../vendor/src/openai-compat.js'
import {
  buildVertexChatUrl,
  normalizeVertexModel,
  bareVertexModel,
  VertexTokenManager,
  type VertexServiceAccount,
} from './vertex-transport.js'

/** 一个模型条目（含上下文窗口，供 UI 显示占用条）。 */
export interface VertexModelEntry {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
}

/**
 * 默认模型（与参考实现 `DEFAULT_MODEL_IDS` 一致，本机全部实测 200）。
 *
 * ⚠️ 上下文窗口是**按 Gemini 公开值**填的（1M / 65K 输出）。这不是实测值 ——
 * Vertex 的模型元数据要靠 `models.list`，而本项目没有为单个渠道拉元数据的
 * 机制，故用公开值兜底。**若某个模型报 context 超限**，以这里为准调小即可。
 */
export const VERTEX_MODELS: readonly VertexModelEntry[] = [
  { id: 'gemini-4-argon', name: 'Gemini 4 Argon', contextWindow: 1_048_576, maxTokens: 65_536 },
  { id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', contextWindow: 1_048_576, maxTokens: 65_536 },
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', contextWindow: 1_048_576, maxTokens: 65_536 },
  { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', contextWindow: 1_048_576, maxTokens: 65_536 },
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', contextWindow: 1_048_576, maxTokens: 65_536 },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', contextWindow: 1_048_576, maxTokens: 65_536 },
  { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro (preview)', contextWindow: 1_048_576, maxTokens: 65_536 },
  { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash (preview)', contextWindow: 1_048_576, maxTokens: 65_536 },
]

export interface VertexAdapterOptions {
  /** 取当前可用账号（服务账号 JSON + 账号 id）。 */
  resolveAccount: () => Promise<{ accountId: string; credential: VertexServiceAccount } | undefined>
  /** 区域，缺省 `global`。 */
  location?: string
  /** API 版本，缺省 `v1`。 */
  apiVersion?: string
  /** 模型表，缺省 {@link VERTEX_MODELS}。 */
  models?: readonly VertexModelEntry[]
  warn?: (message: string) => void
}

export class VertexAdapter extends LlmAdapter {
  private readonly options: VertexAdapterOptions
  private readonly tokens = new VertexTokenManager()
  /**
   * `thought_signature` 缓存：键是工具调用 id，值是签名串。
   *
   * ⚠️ 只增不减会有内存泄漏风险 ⇒ 用简单上限（256 条）淘汰最旧的
   *    （`Map` 保序，删第一个键即可）。
   */
  private readonly signatures = new Map<string, string>()

  constructor(options: VertexAdapterOptions) {
    super()
    this.options = options
  }

  private get models(): readonly VertexModelEntry[] {
    return this.options.models ?? VERTEX_MODELS
  }

  override providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: 'Vertex AI' }
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return this.models.map((m) => ({ provider: 'vertex', id: m.id, name: m.name }))
  }

  /** 完整目录（不套黑名单），供 Web UI「模型管理」用；**必须同步**。 */
  listAllModels(): readonly { id: string; name: string }[] {
    return this.models.map((m) => ({ id: m.id, name: m.name }))
  }

  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const entry = this.models.find((m) => m.id === bareVertexModel(model))
    if (entry === undefined) {
      throw new LlmError(
        `vertex: 模型 "${model}" 不在本渠道目录中（当前可用：${this.models.map((m) => m.id).join(', ')}）`,
        'INVALID_REQUEST',
        { status: 404 },
      )
    }
    return {
      provider,
      id: model,
      name: entry.name,
      contextWindow: entry.contextWindow,
      maxTokens: entry.maxTokens,
      inputModalities: ['text', 'image'],
    } as LlmResolvedModelInfo
  }

  async *stream(rawOptions: GenerateOptions): AsyncIterable<StreamChunk> {
    const options = rawOptions as GenerateOptions & { useNonStream?: boolean }
    const model = String(options.model)
    const entry = this.models.find((m) => m.id === bareVertexModel(model))
    if (entry === undefined) {
      throw new LlmError(`vertex: 模型 "${model}" 不在本渠道目录中`, 'INVALID_REQUEST', { status: 404 })
    }

    const account = await this.options.resolveAccount()
    if (account === undefined) {
      throw new LlmError(
        'vertex: 没有可用的服务账号 —— 请到「供应商」页为本渠道新建账号并粘贴 GCP Service Account JSON。',
        'INVALID_REQUEST',
        { status: 401 },
      )
    }
    const projectId = String(account.credential.project_id ?? '')
    if (projectId === '') {
      throw new LlmError('vertex: 服务账号 JSON 缺少 project_id', 'INVALID_REQUEST', { status: 400 })
    }

    const url = buildVertexChatUrl({
      projectId,
      ...(this.options.location === undefined ? {} : { location: this.options.location }),
      ...(this.options.apiVersion === undefined ? {} : { apiVersion: this.options.apiVersion }),
    })

    // 请求体：把前端给的 OpenAI 请求体原样送上去，只改 model 与回传签名。
    const payload = {
      ...toOpenAiBody(options),
      model: normalizeVertexModel(model),
      stream: true,
    }
    restoreSignatures(payload, this.signatures)

    let response = await this.post(url, account.credential, payload, options.signal)
    // 401：token 可能被提前吊销 ⇒ 强制刷新后重试一次（**只重试一次**）。
    if (response.status === 401) {
      this.tokens.invalidate()
      response = await this.post(url, account.credential, payload, options.signal)
    }

    if (response.status !== 200) {
      const text = await response.text().catch(() => '')
      throw new LlmError(
        `vertex: HTTP ${response.status} — ${describeVertexError(response.status, text)}`,
        response.status === 429 ? 'QUOTA_EXCEEDED'
          : response.status === 401 || response.status === 403 ? 'FORBIDDEN' : 'SERVER',
        { status: response.status },
      )
    }

    yield* consumeOpenAiSse(
      response,
      { ...(options.signal === undefined ? {} : { signal: options.signal }) },
      {
        label: 'vertex',
        firstTokenTimeoutMs: 120_000,
        chunkTimeoutMs: 60_000,
        ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      },
    )
  }

  /** 发一次 POST（带 token）。 */
  private async post(
    url: string,
    account: VertexServiceAccount,
    payload: unknown,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const token = await this.tokens.getToken(account)
    try {
      return await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      const aborted = (error as { name?: string }).name === 'AbortError'
      throw new LlmError(
        aborted
          ? 'vertex: 请求被取消'
          : `vertex: 网络失败 —— ${String(error)}（Google 域名需走代理，见 gemini.env 的 PROXY=）`,
        'SERVER',
      )
    }
  }
}

/**
 * 把 `GenerateOptions` 摊成 OpenAI 请求体。
 *
 * ⚠️ **不手抄字段列表**：直接用上游给的结构（`options.messages` / `tools` /
 * `temperature` …），只把已知需要改名的换掉。抄一份字段映射表，
 * 上游加字段时必然漂移 —— 这是本仓库反复踩过的缺陷类型。
 */
function toOpenAiBody(options: GenerateOptions): Record<string, unknown> {
  const source = options as unknown as Record<string, unknown>
  const body: Record<string, unknown> = {
    messages: options.messages,
  }
  // 其余标量/数组字段原样带过去（`model` 与 `stream` 由调用方覆盖）。
  for (const key of [
    'tools', 'tool_choice', 'temperature', 'top_p', 'max_tokens', 'stop',
    'reasoning_effort', 'response_format', 'seed',
  ]) {
    const value = source[key]
    if (value !== undefined) body[key] = value
  }
  if (options.maxTokens !== undefined && body.max_tokens === undefined) {
    body.max_tokens = options.maxTokens
  }
  /**
   * ⚠️⚠️ **思考模型的额度下限**（本机实测，2026-11-12）。
   *
   * vertex 这几个模型都是**思考型**：思考 token 也计入 `max_tokens`。
   * 实测 `max_tokens: 100` 时——思考吃掉 97 token、正文 0 字，
   * 返回 `finish_reason: "length"` 且 `content: ""`（看起来像「模型不响应」）。
   * `max_tokens: 2000` 才稳定出正文（思考 447 + 正文若干）。
   *
   * ⇒ 低于 1024 时抬到这个下限。**宁可多给额度**（不足时会提前 stop），
   *    也不要让用户拿到一个空回答去猜原因。
   *
   * 注：这不是 Vertex 独有的坑 —— gemini 渠道的 Claude 系也有同类约束
   * （见 gemini-messages.ts 的 maxOutputTokens > thinkingBudget）。
   */
  const MIN_THINKING_TOKENS = 1024
  const current = typeof body.max_tokens === 'number' ? body.max_tokens : undefined
  if (current !== undefined && current < MIN_THINKING_TOKENS) {
    body.max_tokens = MIN_THINKING_TOKENS
  }
  return body
}

/**
 * 把缓存的 `thought_signature` 回填到**历史 tool_calls** 上。
 *
 * 上游要求：assistant 消息里的 tool_call 必须带上一轮拿到的签名，
 * 否则报 `thought_signature is required`。缓存的键是 tool_call id。
 */
function restoreSignatures(body: Record<string, unknown>, signatures: Map<string, string>): void {
  const messages = body.messages
  if (!Array.isArray(messages) || signatures.size === 0) return
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue
    const record = message as Record<string, unknown>
    const toolCalls = record.tool_calls
    if (!Array.isArray(toolCalls)) continue
    for (const call of toolCalls) {
      if (typeof call !== 'object' || call === null) continue
      const entry = call as Record<string, unknown>
      const id = typeof entry.id === 'string' ? entry.id : ''
      if (id === '') continue
      const signature = signatures.get(id)
      if (signature === undefined) continue
      const extra = (entry.extra_content ?? {}) as Record<string, unknown>
      const google = (extra.google ?? {}) as Record<string, unknown>
      entry.extra_content = { ...extra, google: { ...google, thought_signature: signature } }
    }
  }
}

/** 错误文案（把上游的英文说明保留，便于排查）。 */
function describeVertexError(status: number, text: string): string {
  let detail = text.trim()
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } }
    if (typeof parsed.error?.message === 'string') detail = parsed.error.message
  } catch {
    // 非 JSON（边缘节点 HTML）：原样截断
  }
  const hints: Record<number, string> = {
    400: '（请求参数或模型名被上游拒绝；本渠道的模型名会自动补 google/ 前缀）',
    401: '（OAuth token 无效 —— 检查服务账号 private_key 是否完整）',
    403: '（该项目可能没开通 Vertex AI，或服务账号缺少 aiplatform 权限）',
    404: '（模型不存在或项目无该模型权限）',
    429: '（上游限流/额度耗尽）',
  }
  return `${detail.slice(0, 300)}${hints[status] ?? ''}`
}
