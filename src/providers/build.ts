/**
 * Build 渠道 Provider：把「浏览器里的 AI Studio App」包装成一个标准供应商。
 *
 * ## 与其它 16 家的根本差异
 *
 * 其它家都是**我们主动连上游**；Build 渠道反过来 —— 上游是跑在 Google
 * Cloud Run 上的 App，由**用户浏览器里的页面**主动连回本网关的 WebSocket。
 *
 * ```
 * 你的 Chrome（AI Studio App 页面）
 *    ↕ ws://127.0.0.1:<网关端口>/v1/ws?auth_token=...
 * 本网关（BuildRelay 服务端）
 *    ↕
 * 酒馆 / DSH / 任意 OpenAI 客户端
 * ```
 *
 * ## 为什么默认关闭、且「连接」是显式动作
 *
 * 这个渠道**依赖一个开着的浏览器标签页**：
 *   · 页面关了 → 渠道失效（不是我们挂了，是链路断了）
 *   · 标签页被 Chrome 休眠 → 同上
 *
 * 所以它不该像其它家那样"启用了就默默跑"——用户必须知道这一点。
 * 故：`defaultEnabled: false`，且 Web UI 上有明确的「连接 / 断开」。
 *
 * ## 为什么不需要 Cookie / 无头浏览器（推翻社区做法的实测结论）
 *
 * 社区方案（CLIProxyAPI、AIStudioBuildWS）都要跑无头浏览器 + 提取 Cookie，
 * 因为它们的模型假设是"服务端全自动"。但实测发现 Build App 用的是
 * **服务端自动注入的密钥**（App 界面上的 `Server Key: Configured`），
 * 于是：
 *   · 不需要无头浏览器（用你日常 Chrome 开个标签页即可）
 *   · 不需要提取 Cookie（Chrome 的 Cookie 是 DPAPI 加密 + 运行时锁定，本来就取不出）
 *   · 不需要公网入口（页内 JS 连 127.0.0.1 —— 实测不受混合内容限制）
 */
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { BuildRelay } from '../core/build-relay.js'
import { BuildAdapter, BUILD_MODELS } from './build-adapter.js'
import { GenericProviderBase } from './generic.js'
import { createGatewayContext, withStateDir, type GatewayContext } from '../core/context.js'
import { AccountPool } from '../../vendor/src/account-pool.js'
import type { LoginStart, Provider, ProviderCapabilities } from '../core/provider.js'

/**
 * **进程级单例**：relay 必须被 server（挂 upgrade 监听）与 provider（发请求）
 * 共享同一个实例。
 *
 * ⚠️ 不能各建一个：server 收到的是 relay A 的连接，而 provider 往 relay B 发请求
 * —— 表现为"页面显示 Connected，但请求永远超时"（极难定位）。
 */
let sharedRelay: BuildRelay | undefined

/** 取（或建）共享的 relay 实例。 */
export function buildRelayFor(port: number, token: string, logLevel?: string): BuildRelay {
  if (sharedRelay === undefined) {
    sharedRelay = new BuildRelay({
      port,
      token,
      warn: (message: string) => console.warn(message),
    })
  }
  // 令牌可能变（用户改配置）—— 每次同步，保证与当前配置一致。
  ;(sharedRelay as unknown as { options: { token: string } }).options.token = token
  void logLevel
  return sharedRelay
}

/** 当前 relay（未创建时返回 undefined，供 server/Web UI 查询状态）。 */
export function currentBuildRelay(): BuildRelay | undefined {
  return sharedRelay
}

class BuildProvider extends GenericProviderBase implements Provider {
  readonly id = 'build'
  readonly displayName = 'Build (AI Studio)'
  readonly capabilities: ProviderCapabilities = {
    // ⚠️ 没有传统意义的"登录"：连接由浏览器页面发起。
    //    login 置 false，避免 UI 显示一个点了没用的「新建账号」。
    login: false,
    dailyCheckin: false,
    balance: false,
    permanentLock: false,
    multiAccount: false,
    refresh: false,
  }
  readonly adapter: LlmAdapter
  readonly pool: AccountPool
  readonly gateway: GatewayContext
  private readonly relay: BuildRelay

  constructor(deps: {
    relay: BuildRelay
    adapter: LlmAdapter
    pool: AccountPool
    gateway: GatewayContext
  }) {
    super({
      id: 'build',
      displayName: 'Build (AI Studio)',
      adapter: deps.adapter,
      pool: deps.pool,
      gateway: deps.gateway,
      refreshAll: async () => { /* 无需续期：密钥由 App 服务端持有 */ },
    })
    this.relay = deps.relay
    this.adapter = deps.adapter
    this.pool = deps.pool
    this.gateway = deps.gateway
  }

  /** Build 渠道的连接状态（供 API/UI 查询）。 */
  status(): ReturnType<BuildRelay['status']> {
    return this.relay.status()
  }

  /** 允许/禁止 App 连接（Web UI 的「连接 / 断开」）。 */
  setConnected(value: boolean): void {
    this.relay.setAccepting(value)
    this.gateway.logger.info(value ? 'Build 渠道已开启，等待 App 连接' : 'Build 渠道已断开')
  }

  async startLogin(): Promise<LoginStart> {
    // ⚠️ 不提供「新建账号」：这个渠道的"登录"是去浏览器打开 App 页面。
    //    返回一个明确的错误而不是假装成功（否则 UI 会停在空白弹窗）。
    throw new Error(
      'Build 渠道没有传统登录流程。请到「Build 渠道」页点「连接」，'
      + '然后在浏览器里打开你的 AI Studio App 页面完成握手。',
    )
  }

  async queryBalance(): Promise<undefined> {
    // 额度归 App owner 的 Google 账号，本网关无从查询（那是网页侧的数据）。
    return undefined
  }
}

/**
 * 创建 Build provider。
 *
 * @param dataDir 数据目录
 * @param logLevel 日志级别
 * @param port 网关监听端口（App 连的就是它，路径 `/v1/ws`）
 * @param token 访问令牌（App 用 `?auth_token=` 传入）
 */
export async function createBuildProvider(
  dataDir: string,
  logLevel?: 'debug' | 'info' | 'warn' | 'error',
  port = 8790,
  token = '',
): Promise<Provider> {
  const stateDir = `${dataDir}/providers/build`
  const gateway = createGatewayContext({
    dataDir: stateDir,
    providerId: 'build',
    ...(logLevel ? { logLevel } : {}),
  })
  const pool = await withStateDir(stateDir, () => new AccountPool(gateway.ctx as never))
  const relay = buildRelayFor(port, token, logLevel)
  const adapter = new BuildAdapter({
    relay,
    warn: (message: string) => gateway.logger.warn(message),
  }) as LlmAdapter

  // ⚠️ 供应商被创建（= 已启用）即接受连接。用户不需要额外点「连接」——
  //    这是 2026-10-17 的体验修复：默认 false 会导致每次重启都要手动点，
  //    而用户以为"自动重连坏了"（其实是我们拒绝）。
  relay.setAccepting(true)

  const provider = new BuildProvider({ relay, adapter, pool, gateway })
  gateway.logger.info(
    `Build 渠道已就绪（默认未连接）。可用模型：${BUILD_MODELS.map((m) => m.id).join(', ')}`,
  )
  return provider
}
