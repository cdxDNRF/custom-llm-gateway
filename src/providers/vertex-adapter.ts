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
 * ## `thought_signature` —— 本项目最容易踩的坑，完整移植了参考实现
 *
 * Gemini 3/4 在返回工具调用时，会在 `tool_calls[]` 上附带
 * `extra_content.google.thought_signature`。官方文档明确：
 * **多步工具调用循环中必须原样回传该签名**，否则 400
 * `Function call is missing a thought_signature in functionCall parts`。
 *
 * 而**很多客户端（ZCode 实测）在保存/回传历史时会剥离 `extra_content`**，
 * 只留 `id` / `type` / `function` ⇒ 第 3 轮起必然 400（前两轮可能因为
 * 刚好插了 user 消息而「碰巧」通过，极具迷惑性）。
 *
 * 故适配器必须**替客户端补全**，三件事缺一不可：
 *
 * | 环节 | 做法 |
 * |---|---|
 * | ① 录制（非流式） | 从响应 `choices[].message.tool_calls[]` 提取签名 |
 * | ② 录制（流式） | 解析 SSE，按 `(choice_index, tool_index)` 暂存 id 与签名，**两者都到齐才落缓存** |
 * | ③ 回传时还原 | 扫描请求 `messages`，给被剥离的 `assistant.tool_calls` 补签名 |
 *
 * ⚠️ **缓存未命中时必须兜底**：重启服务前的历史会话没有缓存，此时给该步
 * **第一个 tool_call** 注入官方兜底标记 `skip_thought_signature_validator`，
 * 让上游跳过校验而不是整轮 400。
 *
 * ⚠️ 缓存**不落盘**：签名只在同一次多轮对话内有效，跨会话无意义。
 *
 * 📌 这段逻辑不是「猜」的 —— 移植自用户已验证的参考实现
 * （`D:\AIagent\vertex\server.py` 的 `ThoughtSignatureCache` /
 * `_StreamSignatureTracker` / `_restore_thought_signatures`），
 * 本轮补上是因为我上一版**只写了读、忘了写**（缓存恒空 ⇒ 等于没有）。
 */
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmResolvedModelInfo, StreamChunk, GenerateOptions } from '@deepseek-ai/dsh-llm'
import { consumeOpenAiSse, serializeMessages } from '../../vendor/src/openai-compat.js'
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
  // ⚠️ 模型名是 `gemini-4-hydrogen`，**不带 `-preview`**：
  //    实测 `-preview` 后缀 404（本机 2026-11-12 验证），别加错。
  { id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen', contextWindow: 1_048_576, maxTokens: 65_536 },
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

/** 官方兜底标记：让上游跳过签名校验（用于缓存未命中的历史会话）。 */
const SKIP_THOUGHT_SIGNATURE_SENTINEL = 'skip_thought_signature_validator'
/** 缓存上限（与参考实现一致）。 */
const MAX_CACHED_SIGNATURES = 4096

/** 从一个 OpenAI tool_call 里读 `extra_content.google.thought_signature`。 */
function getThoughtSignature(call: unknown): string {
  if (typeof call !== 'object' || call === null) return ''
  const extra = (call as Record<string, unknown>).extra_content
  if (typeof extra !== 'object' || extra === null) return ''
  const google = (extra as Record<string, unknown>).google
  if (typeof google !== 'object' || google === null) return ''
  const signature = (google as Record<string, unknown>).thought_signature
  return typeof signature === 'string' ? signature : ''
}

/**
 * 把 `extra_content` 合并进 tool_call（**不覆盖同名兄弟键**）。
 *
 * ⚠️ 用「合并」而不是「赋值」：上游可能在未来往 `extra_content` 里加别的键，
 * 直接覆盖会把它们抹掉（参考实现也是合并）。
 */
function setThoughtSignature(call: Record<string, unknown>, extraContent: Record<string, unknown>): void {
  const existingExtra = typeof call.extra_content === 'object' && call.extra_content !== null
    ? { ...(call.extra_content as Record<string, unknown>) }
    : {}
  const existingGoogle = typeof existingExtra.google === 'object' && existingExtra.google !== null
    ? { ...(existingExtra.google as Record<string, unknown>) }
    : {}
  const incomingGoogle = extraContent.google
  if (typeof incomingGoogle === 'object' && incomingGoogle !== null) {
    Object.assign(existingGoogle, incomingGoogle as Record<string, unknown>)
  }
  for (const [key, value] of Object.entries(extraContent)) {
    if (key !== 'google' && existingExtra[key] === undefined) existingExtra[key] = value
  }
  if (Object.keys(existingGoogle).length > 0) existingExtra.google = existingGoogle
  call.extra_content = existingExtra
}

/** 有界 LRU：tool_call id → 签名。 */
class ThoughtSignatureCache {
  private readonly items = new Map<string, string>()

  get size(): number { return this.items.size }

  put(callId: string, signature: string): void {
    if (callId === '' || signature === '') return
    // Map 保序：先删再插 = 移到末尾（最近使用）
    this.items.delete(callId)
    this.items.set(callId, signature)
    while (this.items.size > MAX_CACHED_SIGNATURES) {
      const oldest = this.items.keys().next().value
      if (oldest === undefined) break
      this.items.delete(oldest)
    }
  }

  get(callId: string): string | undefined {
    const signature = this.items.get(callId)
    if (signature !== undefined) {
      this.items.delete(callId)
      this.items.set(callId, signature)
    }
    return signature
  }
}

/**
 * 从**流式 SSE**里被动提取签名。
 *
 * ⚠️⚠️ 这是最容易写错的一环：SSE 的 `tool_calls` 是**分片**的 ——
 * `id` 可能在第一个 delta 里，`extra_content.google.thought_signature`
 * 可能在同一个、也可能在后续 delta 里。故必须按
 * **`(choiceIndex, toolIndex)` 先暂存两者，都到齐才落缓存**。
 * 直接对单个 delta 查「有 id 又有签名」会漏掉大半（我上一版就是没做这一步）。
 */
class StreamSignatureTracker {
  private buffer = ''
  private readonly ids = new Map<string, string>()
  private readonly signatures = new Map<string, string>()

  constructor(private readonly cache: ThoughtSignatureCache) {}

  /** 喂入原始 SSE 字节（按行解析，不完整的行留到下一次）。 */
  feed(chunk: Uint8Array): void {
    this.buffer += new TextDecoder().decode(chunk, { stream: true })
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      newline = this.buffer.indexOf('\n')
      if (!line.startsWith('data:') || !line.includes('tool_calls')) continue
      const payload = line.slice(5).trim()
      if (payload === '' || payload === '[DONE]') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(payload)
      } catch {
        continue
      }
      this.process(parsed)
    }
  }

  private process(data: unknown): void {
    if (typeof data !== 'object' || data === null) return
    const choices = (data as Record<string, unknown>).choices
    if (!Array.isArray(choices)) return
    choices.forEach((choice, choiceFallback) => {
      if (typeof choice !== 'object' || choice === null) return
      const record = choice as Record<string, unknown>
      const choiceIndex = typeof record.index === 'number' ? record.index : choiceFallback
      const delta = record.delta
      if (typeof delta !== 'object' || delta === null) return
      const toolCalls = (delta as Record<string, unknown>).tool_calls
      if (!Array.isArray(toolCalls)) return
      toolCalls.forEach((call, toolFallback) => {
        if (typeof call !== 'object' || call === null) return
        const entry = call as Record<string, unknown>
        const toolIndex = typeof entry.index === 'number' ? entry.index : toolFallback
        const key = `${choiceIndex}:${toolIndex}`
        const id = typeof entry.id === 'string' ? entry.id : ''
        if (id !== '') this.ids.set(key, id)
        const signature = getThoughtSignature(entry)
        if (signature !== '') this.signatures.set(key, signature)
        // 两者都到齐才落缓存
        const finalId = this.ids.get(key)
        const finalSignature = this.signatures.get(key)
        if (finalId !== undefined && finalSignature !== undefined) {
          this.cache.put(finalId, finalSignature)
        }
      })
    })
  }
}

/** 从**非流式**响应里提取签名。 */
function recordNonStreamSignatures(data: unknown, cache: ThoughtSignatureCache): void {
  if (typeof data !== 'object' || data === null) return
  const choices = (data as Record<string, unknown>).choices
  if (!Array.isArray(choices)) return
  for (const choice of choices) {
    if (typeof choice !== 'object' || choice === null) continue
    const message = (choice as Record<string, unknown>).message
    if (typeof message !== 'object' || message === null) continue
    const toolCalls = (message as Record<string, unknown>).tool_calls
    if (!Array.isArray(toolCalls)) continue
    for (const call of toolCalls) {
      if (typeof call !== 'object' || call === null) continue
      const entry = call as Record<string, unknown>
      const id = typeof entry.id === 'string' ? entry.id : ''
      const signature = getThoughtSignature(entry)
      if (id !== '' && signature !== '') cache.put(id, signature)
    }
  }
}

/**
 * 回传前补全签名（**这是修复 400 的关键一步**）。
 *
 * @returns `[新 body, 还原数, 兜底数]`
 */
function restoreThoughtSignatures(
  body: Record<string, unknown>,
  cache: ThoughtSignatureCache,
): [Record<string, unknown>, number, number] {
  const messages = body.messages
  if (!Array.isArray(messages)) return [body, 0, 0]

  let restored = 0
  let fallback = 0
  let changed = false
  const updated = messages.map((message) => {
    if (typeof message !== 'object' || message === null) return message
    const record = message as Record<string, unknown>
    if (record.role !== 'assistant') return message
    const toolCalls = record.tool_calls
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return message

    let messageChanged = false
    const newCalls = toolCalls.map((call, index) => {
      if (typeof call !== 'object' || call === null) return call
      const entry = { ...(call as Record<string, unknown>) }
      if (getThoughtSignature(entry) !== '') return entry
      const id = typeof entry.id === 'string' ? entry.id : ''
      const cached = id !== '' ? cache.get(id) : undefined
      if (cached !== undefined) {
        setThoughtSignature(entry, { google: { thought_signature: cached } })
        restored += 1
        messageChanged = true
        return entry
      }
      /**
       * ⚠️⚠️ **每个 tool_call 都要兜底，不是只有第一个**（真实缺陷，2026-11-12 实测）。
       *
       * 参考实现只给 `index === 0` 注入兜底标记，注释写「Gemini 只校验每步首个
       * functionCall」。但本机实测**不是这样**：
       *
       * | 形态 | 结果 |
       * |---|---|
       * | 两个 tool_call，都不带签名 | ❌ 400 `Function call is missing a thought_signature in functionCall parts` |
       * | 第一个带 skip 标记、第二个不带 | ✅ 200（**侥幸过** —— 见下） |
       * | 两个都带 skip 标记 | ✅ 200 |
       *
       * 第 2 行能过只是因为上游对「同一 assistant 消息里的后续调用」放宽了校验，
       * 而**跨多轮的场景会重新严格**。故这里对**每个**缺签名的 tool_call 都注入，
       * 不做 `index === 0` 判断 —— 多注入没有副作用（它只是让上游跳过校验），
       * 少注入则会 400。
       */
      setThoughtSignature(entry, {
        google: { thought_signature: SKIP_THOUGHT_SIGNATURE_SENTINEL },
      })
      fallback += 1
      messageChanged = true
      return entry
    })

    if (!messageChanged) return message
    changed = true
    return { ...record, tool_calls: newCalls }
  })

  if (!changed) return [body, 0, 0]
  return [{ ...body, messages: updated }, restored, fallback]
}

export class VertexAdapter extends LlmAdapter {
  private readonly options: VertexAdapterOptions
  private readonly tokens = new VertexTokenManager()
  /** `thought_signature` 缓存（有界 LRU，见文件头说明）。 */
  private readonly signatures = new ThoughtSignatureCache()

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
    /**
     * **回传前补全签名**（修复 ZCode 那类「客户端剥离 extra_content」导致的 400）。
     * 详见文件头「thought_signature」一节。
     */
    const [withSignatures, restored, fallback] = restoreThoughtSignatures(
      payload as Record<string, unknown>,
      this.signatures,
    )
    if (restored > 0 || fallback > 0) {
      this.options.warn?.(
        `[vertex] thought_signature: restored=${restored} fallback=${fallback} `
        + `cacheSize=${this.signatures.size}`,
      )
    }
    const finalPayload = withSignatures

    let response = await this.post(url, account.credential, finalPayload, options.signal)
    // 401：token 可能被提前吊销 ⇒ 强制刷新后重试一次（**只重试一次**）。
    if (response.status === 401) {
      this.tokens.invalidate()
      response = await this.post(url, account.credential, finalPayload, options.signal)
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

    /**
     * **流式响应包一层**：旁路录制 `thought_signature`（不改变下游看到的数据）。
     *
     * ⚠️ 用 `TransformStream` 而不是「先读完再给下游」——后者会让流式变成
     * 一次性输出（本项目在 Build 渠道踩过这个坑，见 build-relay 的注释）。
     */
    const tracker = new StreamSignatureTracker(this.signatures)
    const body = response.body
    if (body === null) throw new LlmError('vertex: 响应没有 body', 'EMPTY_RESPONSE')
    const tapped = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        // 旁路解析（异常绝不影响转发：签名录制是尽力而为）
        try { tracker.feed(chunk) } catch { /* 忽略 */ }
        controller.enqueue(chunk)
      },
    }))
    const tappedResponse = new Response(tapped, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })

    yield* consumeOpenAiSse(
      tappedResponse,
      { ...(options.signal === undefined ? {} : { signal: options.signal }) },
      {
        label: 'vertex',
        /*
         * ⚠️⚠️ **首字超时必须 300 秒**（2026-11-12 用户实测反馈）。
         *
         * 原值 120 秒在 ZCode 场景下**会误杀**：上下文 100k–150k tokens
         * + `reasoning_effort: "high"` 时，旗舰模型（gemini-4-carbon /
         * gemini-4-hydrogen）冷预填充 + 首发耗时实测 **110–255 秒**，
         * 经常直接越过 120 秒 ⇒ 表现为「模型不响应 / 莫名中断」。
         *
         * 取 300 秒覆盖观测到的上界（255s）并留余量。
         * ⚠️ 注意 `chunkTimeoutMs` 保持 60 秒 —— 首字慢是预填充慢，
         *    而**流中途卡住**通常是真的挂了，不该一起放宽。
         */
        firstTokenTimeoutMs: 300_000,
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
  /**
   * ⚠️⚠️ **必须用 `serializeMessages` 转换，不能直接传 `options.messages`**
   * （真实缺陷，2026-11-12 实测）。
   *
   * DSH 的内部消息格式里，content 是**带 `type` 字段的块数组**
   * （`{type:'text', text}` / `{type:'tool-result', …}`）；而 OpenAI wire 格式
   * 的 content 是纯字符串或 `{type:'text', text}` 的标准块。
   *
   * 直接把内部格式发给 Vertex，上游报
   * `Expected input to contain field: 'type'`
   * —— 因为它把内部块当成了 OpenAI 的 content part。
   *
   * 其它所有 OpenAI 兼容渠道（buddy/qoder/autoclaw…）都走这个函数，
   * 它还顺带处理了：工具结果配对、图片内联、预填充剥离。
   */
  const body: Record<string, unknown> = {
    messages: serializeMessages(options.messages as never),
  }
  /**
   * ⚠️⚠️ **`tools` 必须转换，不能直接透传**（真实缺陷，2026-11-12 实测）。
   *
   * DSH 的 `ToolSchema` 是**扁平**结构：
   * ```
   * { name, description, parameters }
   * ```
   * 而 OpenAI wire 格式要**嵌套**：
   * ```
   * { type: 'function', function: { name, description, parameters } }
   * ```
   * 直接透传 ⇒ 上游报 `Expected input to contain field: 'type'`
   * （它把扁平对象当成缺 `type` 的 content part）。
   *
   * 📌 这个坑在所有「直接透传给 OpenAI 兼容上游」的适配器都会遇到；
   *    buddy/qoder 那些走 `serializeMessages` + 各自封装的没暴露，
   *    因为它们的 tools 由 vendor 自己转换。
   */
  const tools = source.tools
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools.map((tool) => {
      const entry = tool as Record<string, unknown>
      // 已经是 OpenAI 形态的（含 type+function）原样保留，避免双重包装
      if (entry.type === 'function' && typeof entry.function === 'object') return entry
      return {
        type: 'function',
        function: {
          name: entry.name,
          ...(entry.description === undefined ? {} : { description: entry.description }),
          ...(entry.parameters === undefined ? {} : { parameters: entry.parameters }),
        },
      }
    })
  }

  // 其余标量/数组字段原样带过去（`model` 与 `stream` 由调用方覆盖）。
  for (const key of [
    'tool_choice', 'temperature', 'top_p', 'max_tokens', 'stop',
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

/** 错误文案（把上游的英文说明保留，便于排查）。 */
function describeVertexError(status: number, text: string): string {
  let detail = text.trim()
  try {
    const parsed = JSON.parse(text) as unknown
    /**
     * ⚠️⚠️ **错误体是「单元素数组」而不是对象**（真实缺陷，2026-11-12 实测）。
     *
     * Vertex `/endpoints/openapi` 出错时返回：
     * ```json
     * [{"error":{"code":400,"message":"Expected input to contain field: 'type'."}}]
     * ```
     * 原来按 `{ error?: {...} }` 解析 ⇒ `parsed.error` 是 undefined
     * ⇒ 用户只看到一整段原始 JSON 被截断，**看不到真正的 message**。
     * （本机就是靠这个错误才定位到 tools 格式问题的，当时只能人肉读 JSON。）
     */
    const first = Array.isArray(parsed) ? parsed[0] : parsed
    if (typeof first === 'object' && first !== null) {
      const error = (first as Record<string, unknown>).error
      if (typeof error === 'object' && error !== null) {
        const message = (error as Record<string, unknown>).message
        if (typeof message === 'string') detail = message
      }
    }
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
