/**
 * **Vertex AI 渠道**（GCP Service Account 凭证，2026-11-12 用户要求）。
 *
 * ## 为什么这个渠道比其他家简单得多
 *
 * Vertex 提供 **OpenAI 兼容端点**：
 *
 * ```
 * POST https://{host}/{v1|v1beta1}/projects/{project}/locations/{loc}
 *      /endpoints/openapi/chat/completions
 * ```
 *
 * 请求体与响应体**就是标准 OpenAI 格式**（本机实测：非流式返回
 * `choices` / `usage`，流式返回 `data: {...}` SSE），故本适配器**不做协议转换**，
 * 只做两件事：① 拿 OAuth token ② 改 URL / 模型名。其余原样透传。
 *
 * ## 端点踩坑记录（用户此前问过「为什么加不了」，根因就在这）
 *
 * 之前我测的是 `publishers/google/models/{model}:generateContent`（Gemini 原生
 * 协议），该账号**全部 404**，于是误判为「项目无 Vertex 权限」。实际是：
 *
 * | 端点 | 结果 |
 * |---|---|
 * | `publishers/google/models/*:generateContent` | ❌ 404（该模型不在这个路径下） |
 * | `endpoints/openapi/chat/completions` | ✅ **200**（参考实现用的就是这个） |
 *
 * ⇒ 教训：Vertex 有**两套并存协议**，同一账号可能只在其中一套上开通。
 *
 * ## 模型名要带 `google/` 前缀
 *
 * 上游要求 `google/<model>`。客户端写裸名（`gemini-4-argon`）时自动补前缀；
 * 已带前缀（`google/xxx` 或别的 publisher）则原样用。
 *
 * ## `thought_signature`（思考模型必需）
 *
 * 响应里会带 `extra_content.google.thought_signature`，**下一轮必须原样回传**，
 * 否则上游 400。参考实现为此专门写了 `ThoughtSignatureCache`。
 * 本适配器用**按工具调用 id 记**的 Map 缓存（与 gemini 渠道的 sigStore 同思路，
 * 但不需要落盘 —— Vertex 的签名只在同一次多轮对话内有效）。
 */

/** 服务账号 JSON 的最小形状。 */
export interface VertexServiceAccount {
  type?: string
  project_id?: string
  private_key?: string
  private_key_id?: string
  client_email?: string
  token_uri?: string
}

export interface VertexAdapterOptions {
  /** 取当前可用的服务账号（按账号池轮询）。 */
  resolveAccount: () => Promise<{ accountId: string; credential: VertexServiceAccount } | undefined>
  /** 区域；缺省 `global`（该凭证在 global 可用，见 README）。 */
  location?: string
  /** API 版本；缺省 `v1`。 */
  apiVersion?: string
  /** 模型列表（`/v1/models` 用）。 */
  models?: readonly string[]
  /** 日志。 */
  warn?: (message: string) => void
  /** 可注入的 fetch（测试用）。缺省全局 fetch（已装代理路由）。 */
  fetcher?: typeof fetch
}

/** 默认模型列表（与参考实现的 `DEFAULT_MODEL_IDS` 一致，本机全部实测 200）。 */
export const VERTEX_DEFAULT_MODELS: readonly string[] = [
  'gemini-4-argon',
  'gemini-4-carbon',
  // ⚠️ 不带 `-preview`（实测 404）
  'gemini-4-hydrogen',
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.1-pro-preview',
  'gemini-3-flash-preview',
]

/** OAuth scope（与参考实现一致）。 */
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'
/** 提前多久刷新 token（参考实现是 5 分钟）。 */
const REFRESH_AHEAD_MS = 5 * 60_000

/**
 * Service Account → OAuth access token 的管理器。
 *
 * ⚠️ **token 必须缓存**：每轮请求都换一次 token 会让延迟翻倍（换 token 是一次
 * 网络往返）。按「过期前 5 分钟刷新」策略缓存，与参考实现一致。
 */
export class VertexTokenManager {
  private token: string | undefined
  /** 到期时间（毫秒时间戳，0 = 未知）。 */
  private expiresAt = 0
  /** 正在进行的刷新（并发去重：同时来 10 个请求只换一次 token）。 */
  private inflight: Promise<string> | undefined

  constructor(private readonly options: { fetcher?: typeof fetch; warn?: (m: string) => void } = {}) {}

  /** 取一个有效 token（必要时刷新）。 */
  async getToken(account: VertexServiceAccount): Promise<string> {
    const now = Date.now()
    if (this.token !== undefined && now < this.expiresAt - REFRESH_AHEAD_MS) return this.token
    if (this.inflight !== undefined) return this.inflight
    this.inflight = this.refresh(account).finally(() => { this.inflight = undefined })
    return this.inflight
  }

  /** 强制刷新（401 时用）。 */
  invalidate(): void {
    this.token = undefined
    this.expiresAt = 0
  }

  private async refresh(account: VertexServiceAccount): Promise<string> {
    const { SignJWT, importPKCS8 } = await import('jose')
    const privateKey = String(account.private_key ?? '').replace(/\\n/g, '\n')
    if (privateKey === '') throw new Error('Vertex 凭据缺少 private_key')
    const tokenUri = account.token_uri ?? 'https://oauth2.googleapis.com/token'
    const nowSec = Math.floor(Date.now() / 1000)
    const key = await importPKCS8(privateKey, 'RS256')
    const assertion = await new SignJWT({ scope: CLOUD_PLATFORM_SCOPE })
      .setProtectedHeader({ alg: 'RS256', kid: account.private_key_id })
      .setIssuer(String(account.client_email ?? ''))
      .setAudience(tokenUri)
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + 3600)
      .sign(key)

    const response = await (this.options.fetcher ?? fetch)(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`Vertex 换取 token 失败（HTTP ${response.status}）：${text.slice(0, 200)}`)
    }
    let payload: { access_token?: string; expires_in?: number } = {}
    try {
      payload = JSON.parse(text) as typeof payload
    } catch {
      throw new Error('Vertex token 端点返回的不是 JSON')
    }
    const token = payload.access_token ?? ''
    if (token === '') throw new Error('Vertex token 端点返回了空 token')
    this.token = token
    this.expiresAt = Date.now() + (payload.expires_in ?? 3600) * 1000
    return token
  }
}

/** 解析服务账号 JSON（容错：字段缺失时不抛，交给上层判断）。 */
export function parseServiceAccount(raw: string): VertexServiceAccount | undefined {
  try {
    const parsed = JSON.parse(raw) as VertexServiceAccount
    if (typeof parsed !== 'object' || parsed === null) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/**
 * 归一化模型名：补 `google/` 前缀。
 *
 * 上游要求 `publisher/model`。已带 `/` 的原样返回（允许用户指定别的 publisher）。
 */
export function normalizeVertexModel(model: string): string {
  const cleaned = model.trim().replace(/^vertex_ai\//, '')
  if (cleaned === '') return cleaned
  return cleaned.includes('/') ? cleaned : `google/${cleaned}`
}

/** 从模型名反解出裸名（去掉 publisher 前缀）。 */
export function bareVertexModel(model: string): string {
  const normalized = normalizeVertexModel(model)
  const slash = normalized.indexOf('/')
  return slash < 0 ? normalized : normalized.slice(slash + 1)
}

/** 构造 chat/completions 的完整 URL（与参考实现逐字一致）。 */
export function buildVertexChatUrl(options: {
  projectId: string
  location?: string
  apiVersion?: string
}): string {
  const location = options.location ?? 'global'
  const apiVersion = options.apiVersion ?? 'v1'
  const host = location === 'global'
    ? 'https://aiplatform.googleapis.com'
    : `https://${location}-aiplatform.googleapis.com`
  return `${host}/${apiVersion}/projects/${options.projectId}/locations/${location}/endpoints/openapi/chat/completions`
}
