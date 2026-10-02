/**
 * 腾讯系（CodeBuddy / WorkBuddy）供应商实现。
 *
 * 两者**同源**：同一后端、同一协议、同一登录流程，差异全部由
 * `product` 配置承载（endpoint / platform / productCode / User-Agent）。
 * 因此这里用一份实现，由 `createBuddyProvider(product)` 产出两个**独立**的
 * 供应商实例（各自端口、各自账号池、各自凭据空间）。
 *
 * ⚠️ 登录采用**两步式**（先拿 URL 立刻返回，后台再等回调）：
 * 浏览器只在用户点击后的短暂窗口（transient activation，约 5 秒）内允许
 * window.open；若阻塞到授权完成才返回 URL，弹窗必被拦截。
 */
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { BuddyAuth, createPoolRefresh, BUDDY_CREDENTIAL_REF } from '../../vendor/src/buddy-auth.js'
import { BuddyAdapter } from '../../vendor/src/buddy-adapter.js'
import { AccountPool } from '../../vendor/src/account-pool.js'
import { fetchAuthState, decorateLoginUrl, runBuddyLoginFlow } from '../../vendor/src/buddy-oauth.js'
import {
  credentialExpiresAtMs,
  isRefreshable,
  jwtNickname,
  type BuddyCredential,
} from '../../vendor/src/buddy.js'
import { fetchCreditBalance, fetchCheckinStatus, claimDailyCheckin } from '../../vendor/src/credits.js'
import {
  applyModelDisabled,
  clearAllModelsDisabled,
  listModelsWithState,
  refreshModels,
  resetLimits,
  retest,
} from '../core/provider-common.js'
import { createGatewayContext, withStateDir, type GatewayContext } from '../core/context.js'
import type {
  AccountView,
  BalanceView,
  CheckinResult,
  LoginStart,
  ModelView,
  Provider,
  ProviderCapabilities,
  RetestResult,
} from '../core/provider.js'
import type { BuddyProduct } from '../../vendor/src/product.js'

/** 生成短 id（账号 id 与凭据 ref 后缀）。 */
function shortId(): string {
  return Math.random().toString(16).slice(2, 10)
}

/**
 * 解析凭据 JSON。
 *
 * vendor 的 `parseCredential` 是 `buddy-auth.ts` 的私有函数，判据是
 * 「能 JSON.parse 且 `access_token` 是非空字符串」。这里就地复刻同一判据，
 * 避免依赖内部实现（升级后若私有函数改名不会影响我们）。
 */
function safeParseBuddyCredential(value: string): BuddyCredential | undefined {
  try {
    const parsed = JSON.parse(value) as BuddyCredential
    return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

export interface BuddyProviderDeps {
  product: BuddyProduct
  dataDir: string
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
}

export class BuddyProvider implements Provider {
  readonly id: string
  readonly displayName: string
  readonly capabilities: ProviderCapabilities
  readonly adapter: LlmAdapter
  readonly pool: AccountPool
  readonly gateway: GatewayContext

  private readonly auth: BuddyAuth
  private readonly product: BuddyProduct
  private readonly defaultRef: string

  private constructor(deps: BuddyProviderDeps, gateway: GatewayContext, pool: AccountPool) {
    this.product = deps.product
    this.gateway = gateway
    this.pool = pool
    this.id = deps.product.id
    this.displayName = deps.product.displayName
    this.defaultRef = deps.product.defaultCredentialRef ?? BUDDY_CREDENTIAL_REF
    this.auth = new BuddyAuth(gateway.ctx as never, { product: deps.product })

    this.capabilities = {
      login: true,
      // 国际版 WorkBuddy 后端没有签到接口（vendor 的 credits.ts 有实测证据）；
      // 中国版 CodeBuddy 有每日签到。
      dailyCheckin: deps.product.id !== 'workbuddy',
      balance: true,
      permanentLock: true,
      multiAccount: true,
      refresh: true,
    }

    // ⚠️ 直接用适配器**类**，不走 registerBuddyLlm：后者需要宿主提供
    // `ctx.llm`（DSH 的 LLM 服务注册表），而网关不需要注册到任何注册表 ——
    // 我们只要实例。实测 `BuddyAdapter` 类本身不持有 ctx（仅在 register
    // 包装函数里用到 ctx.llm），故可安全直接构造。
    this.adapter = new BuddyAdapter({
      credentialRef: credentialRef(this.defaultRef),
      resolveCredential: async (modelId?: string) => {
        // 账号池优先（多账号 + 限流切换）；⚠️ modelId 必须透传，
        // 否则模型级限流标记会被忽略（vendor 里的踩坑记录）。
        const available = await pool.getAvailableAccount(deps.product.id, modelId ?? '')
        if (available) return available.credential as BuddyCredential
        const raw = gateway.credentials.get(this.defaultRef)
        if (raw === undefined) return undefined
        try {
          return JSON.parse(raw) as BuddyCredential
        } catch {
          return undefined
        }
      },
      refresh: createPoolRefresh(pool, deps.product.id, this.auth),
      fetchRemoteModels: () => this.auth.fetchModels(pool),
      accountPool: pool,
      product: deps.product,
    }) as LlmAdapter
  }

  /**
   * 异步工厂。
   *
   * ⚠️ 账号池的构造需要临时设置 `DSH_JET_HUB_STATE_DIR`（vendor 的
   * `resolveJetHubHome` 在此刻读取），故 `withStateDir` 内部做了串行化。
   */
  static async create(deps: BuddyProviderDeps): Promise<BuddyProvider> {
    const stateDir = `${deps.dataDir}/providers/${deps.product.id}`
    const gateway = createGatewayContext({
      dataDir: stateDir,
      providerId: deps.product.id,
      ...(deps.logLevel ? { logLevel: deps.logLevel } : {}),
    })
    const pool = await withStateDir(stateDir, () => new AccountPool(gateway.ctx as never))
    return new BuddyProvider(deps, gateway, pool)
  }

  async listAccounts(): Promise<AccountView[]> {
    const accounts = await this.pool.listAccounts(this.id)
    return accounts.map((a) => ({
      id: a.id,
      nickname: a.nickname,
      enabled: a.enabled,
      credentialRef: a.credentialRef,
      ...(a.expiresAt !== undefined ? { expiresAt: a.expiresAt } : {}),
      refreshable: a.refreshable,
      ...(a.modelRateLimits ? { modelRateLimits: a.modelRateLimits } : {}),
    }))
  }

  async startLogin(nickname?: string): Promise<LoginStart> {
    const id = `${this.id}-${shortId()}`
    const refName = `${this.id.toUpperCase()}_ACCOUNT_${shortId().toUpperCase()}`

    // ① 取授权地址（服务端下发 authUrl，按产品追加参数）
    const authState = await fetchAuthState(undefined, undefined, this.product)
    const loginUrl = decorateLoginUrl(authState.authUrl, this.product)

    // ② 先登记占位账号，让前端能立刻看到"登录中"
    await this.pool.addAccount({
      id,
      provider: this.id,
      nickname: nickname ?? id,
      enabled: true,
      credentialRef: refName,
      refreshable: false,
      createdAt: Date.now(),
    })

    // ③ 后台用**同一个 state** 跑完整流程（不 await，否则弹窗被拦截）
    const completed = runBuddyLoginFlow({
      openBrowser: () => {},
      state: authState.state,
      product: this.product,
    })
      .then(async (flow) => {
        this.gateway.credentials.set(refName, flow.access)
        this.auth.scheduleRefresh()
        // 解析凭据取昵称/有效期（vendor 的 parseCredential 是私有的，
        // 这里按同样的判据就地解析，避免依赖内部实现）。
        const credential = safeParseBuddyCredential(flow.access)
        await this.pool.updateAccount(id, {
          nickname: credential ? (credential.nickname || jwtNickname(credential.access_token) || id) : id,
          expiresAt: credential ? credentialExpiresAtMs(credential) : undefined,
          refreshable: credential !== undefined && isRefreshable(credential),
        })
        this.gateway.logger.info(`账号 ${id} 登录成功（${credential?.nickname || '未知昵称'}）`)
        return { ok: true as const }
      })
      .catch(async (error: unknown) => {
        // 登录失败：移除占位条目，避免留下无凭据的幽灵账号。
        await this.pool.removeAccount(id).catch(() => {})
        this.gateway.logger.warn(`账号 ${id} 登录失败:`, error)
        return { ok: false as const, error: String(error) }
      })

    return { loginUrl, accountId: id, completed }
  }

  async removeAccount(accountId: string): Promise<void> {
    const accounts = await this.pool.listAccounts(this.id)
    const target = accounts.find((a) => a.id === accountId)
    if (target) this.gateway.credentials.delete(target.credentialRef)
    await this.pool.removeAccount(accountId)
  }

  async setAccountEnabled(accountId: string, enabled: boolean): Promise<void> {
    await this.pool.updateAccount(accountId, { enabled })
  }

  async queryBalance(): Promise<BalanceView | undefined> {
    const accounts = await this.pool.listAccounts(this.id)
    const enabled = accounts.filter((a) => a.enabled)
    if (enabled.length === 0) return undefined

    const items: BalanceView['items'] = []
    let total = 0

    for (const account of enabled) {
      const raw = this.gateway.credentials.get(account.credentialRef)
      if (raw === undefined) continue
      let credential: BuddyCredential
      try {
        credential = JSON.parse(raw) as BuddyCredential
      } catch {
        continue
      }
      try {
        const balance = await fetchCreditBalance(credential, this.product)
        if (balance === null) continue
        total += balance.total
        for (const pkg of balance.packages) {
          if (!pkg.active) continue
          items.push({
            name: `${account.nickname} · ${pkg.name}`,
            remain: pkg.remaining,
          })
        }
      } catch (error) {
        this.gateway.logger.warn(`账号 ${account.id} 余额查询失败:`, error)
      }
    }

    if (items.length === 0) return undefined
    return { total, unit: 'credits', items, at: Date.now() }
  }

  async checkin(): Promise<CheckinResult> {
    if (!this.capabilities.dailyCheckin) {
      return {
        ok: false,
        status: 'unavailable',
        message: '该供应商（WorkBuddy 国际版）的后端不提供签到接口',
      }
    }
    const accounts = await this.pool.listAccounts(this.id)
    const enabled = accounts.filter((a) => a.enabled)
    if (enabled.length === 0) {
      return { ok: false, status: 'unavailable', message: '没有已启用的账号' }
    }

    let claimed = 0
    let already = 0
    let amount = 0
    const failures: string[] = []

    for (const account of enabled) {
      const raw = this.gateway.credentials.get(account.credentialRef)
      if (raw === undefined) continue
      let credential: BuddyCredential
      try {
        credential = JSON.parse(raw) as BuddyCredential
      } catch {
        continue
      }
      try {
        const outcome = await claimDailyCheckin(credential, this.product)
        if (outcome.kind === 'claimed') {
          claimed += 1
          amount += outcome.credit
        } else if (outcome.kind === 'already-claimed') {
          already += 1
        } else if (outcome.kind === 'failed') {
          failures.push(`${account.nickname}: ${outcome.message}`)
        }
        // inactive（无资格/活动结束）按"未领到"处理，但不计入失败。
      } catch (error) {
        failures.push(`${account.nickname}: ${String(error)}`)
      }
    }

    if (failures.length > 0 && claimed === 0 && already === 0) {
      return { ok: false, status: 'failed', message: failures.join('；') }
    }
    return {
      ok: true,
      status: claimed > 0 ? 'claimed' : 'already-claimed',
      message: `领取 ${claimed} 个账号（+${amount}），${already} 个今日已领`,
      ...(amount > 0 ? { amount } : {}),
    }
  }

  async refreshAll(): Promise<void> {
    await this.auth.refreshAll(this.pool)
  }

  // ─────────── 模型管理（对齐 DSH 插件的 model.* 端点）───────────

  async listModelsWithState(): Promise<ModelView[]> {
    return listModelsWithState(this.adapter, this.pool, this.id)
  }

  async setModelDisabled(modelId: string, disabled: boolean): Promise<void> {
    await applyModelDisabled(this.pool, this.id, [modelId], disabled)
  }

  async setModelsDisabled(modelIds: readonly string[], disabled: boolean): Promise<void> {
    await applyModelDisabled(this.pool, this.id, modelIds, disabled)
  }

  async clearAllModelsDisabled(): Promise<void> {
    await clearAllModelsDisabled(this.pool, this.id)
  }

  /**
   * 强制重拉上游模型目录（清掉适配器的进程内缓存）。
   * 见 `provider-common.ts` 的 `refreshModels` 注释说明为什么需要它。
   */
  async refreshModels(): Promise<{ count: number }> {
    return refreshModels(this.adapter, this.id)
  }

  // ─────────── 账号进阶操作（对齐 account.* 端点）───────────

  async reorderAccounts(orderedIds: readonly string[]): Promise<void> {
    // 顺序 = 选号优先级（vendor 的 getAvailableAccount 按数组顺序取第一个可用账号）。
    await this.pool.reorderAccounts(this.id, orderedIds)
  }

  async resetRateLimits(accountId?: string): Promise<RetestResult> {
    return resetLimits(this.pool, this.id, accountId)
  }

  async retest(accountId?: string): Promise<RetestResult> {
    return retest(this.pool, this.id, accountId)
  }

  permanentLocked(): boolean {
    return this.pool.permanentLocked(this.id)
  }

  async setPermanentLocked(locked: boolean): Promise<void> {
    await this.pool.setPermanentLocked(this.id, locked)
  }

  async dispose(): Promise<void> {
    try {
      this.auth.stop()
    } catch {
      // 忽略卸载期异常。
    }
  }
}

/** 工厂：由产品配置产出独立的供应商实例。 */
export function createBuddyProvider(deps: BuddyProviderDeps): Promise<BuddyProvider> {
  return BuddyProvider.create(deps)
}

export { isRefreshable }
