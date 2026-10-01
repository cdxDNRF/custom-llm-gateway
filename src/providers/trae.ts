/**
 * TRAE（字节）供应商实现。
 *
 * 与腾讯系完全不同源（vendor 里的第五个脉系）：
 *   - 登录：**本地回调服务器**收 token（不是轮询）
 *   - 凭据：`ExchangeToken` 轮换 refreshToken
 *   - 协议：请求需从 OpenAI 转成 SOLO 格式，响应是 SOLO 自定义 SSE 事件
 *     —— 这些都由 vendor 的 `trae-adapter.ts` 处理，本文件只做接线。
 */
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { TraeAuth } from '../../vendor/src/trae-auth.js'
import { TraeAdapter } from '../../vendor/src/trae-adapter.js'
import { AccountPool } from '../../vendor/src/account-pool.js'
import { TRAE } from '../../vendor/src/trae-product.js'
import { claimTraeDailyCheckin, fetchTraeCreditBalance } from '../../vendor/src/trae-credits.js'
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

function shortId(): string {
  return Math.random().toString(16).slice(2, 10)
}

export interface TraeProviderDeps {
  dataDir: string
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
}

export class TraeProvider implements Provider {
  readonly id = TRAE.id
  readonly displayName = TRAE.displayName
  readonly capabilities: ProviderCapabilities = {
    login: true,
    dailyCheckin: true,
    balance: true,
    permanentLock: false,
    multiAccount: true,
    refresh: true,
  }
  readonly adapter: LlmAdapter
  readonly pool: AccountPool
  readonly gateway: GatewayContext

  private readonly auth: TraeAuth
  private readonly defaultRef: string

  private constructor(deps: TraeProviderDeps, gateway: GatewayContext, pool: AccountPool) {
    this.gateway = gateway
    this.pool = pool
    this.defaultRef = TRAE.defaultCredentialRef
    this.auth = new TraeAuth(gateway.ctx as never, { product: TRAE })

    // 同 buddy：直接构造适配器类，不注册到 DSH 的 ctx.llm。
    this.adapter = new TraeAdapter({
      credentialRef: credentialRef(this.defaultRef),
      resolveCredential: async (modelId?: string) => {
        const available = await pool.getAvailableAccount(TRAE.id, modelId ?? '')
        if (available) return available.credential as never
        const raw = gateway.credentials.get(this.defaultRef)
        if (raw === undefined) return undefined
        try {
          return JSON.parse(raw) as never
        } catch {
          return undefined
        }
      },
      refresh: async () => {
        await this.auth.refresh()
      },
      fetchRemoteModels: () => this.auth.fetchModels(pool),
      accountPool: pool,
      product: TRAE,
    }) as LlmAdapter
  }

  static async create(deps: TraeProviderDeps): Promise<TraeProvider> {
    const stateDir = `${deps.dataDir}/providers/${TRAE.id}`
    const gateway = createGatewayContext({
      dataDir: stateDir,
      providerId: TRAE.id,
      ...(deps.logLevel ? { logLevel: deps.logLevel } : {}),
    })
    const pool = await withStateDir(stateDir, () => new AccountPool(gateway.ctx as never))
    return new TraeProvider(deps, gateway, pool)
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

    await this.pool.addAccount({
      id,
      provider: this.id,
      nickname: nickname ?? id,
      enabled: true,
      credentialRef: refName,
      refreshable: false,
      createdAt: Date.now(),
    })

    // TRAE 用**本地回调服务器**：startLogin 会起一个 127.0.0.1 端口等浏览器回调。
    const started = await this.auth.startLogin({ refName, accountId: id, pool: this.pool })

    const completed = started.result
      .then((result) => {
        this.gateway.logger.info(`账号 ${id} 登录成功（${result.refreshable ? '可续期' : '不可续期'}）`)
        return { ok: true as const }
      })
      .catch(async (error: unknown) => {
        await this.pool.removeAccount(id).catch(() => {})
        this.gateway.logger.warn(`账号 ${id} 登录失败:`, error)
        return { ok: false as const, error: String(error) }
      })

    return { loginUrl: started.loginUrl, accountId: id, completed }
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
      let credential: unknown
      try {
        credential = JSON.parse(raw)
      } catch {
        continue
      }
      try {
        const balance = await fetchTraeCreditBalance(credential as never, TRAE)
        if (balance === null) continue
        total += balance.total
        for (const pkg of balance.packages) {
          if (!pkg.active) continue
          items.push({ name: `${account.nickname} · ${pkg.name}`, remain: pkg.remaining })
        }
      } catch (error) {
        this.gateway.logger.warn(`账号 ${account.id} 余额查询失败:`, error)
      }
    }
    if (items.length === 0) return undefined
    return { total, unit: 'credits', items, at: Date.now() }
  }

  async checkin(): Promise<CheckinResult> {
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
      let credential: unknown
      try {
        credential = JSON.parse(raw)
      } catch {
        continue
      }
      try {
        const outcome = await claimTraeDailyCheckin(credential as never, TRAE)
        if (outcome.kind === 'claimed') {
          claimed += 1
          amount += outcome.credit
        } else if (outcome.kind === 'already-claimed') {
          already += 1
        } else if (outcome.kind === 'failed') {
          failures.push(`${account.nickname}: ${outcome.message}`)
        }
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

  async resetRateLimits(accountId?: string): Promise<{ clearedCount: number; accountCount: number }> {
    return resetLimits(this.pool, this.id, accountId)
  }

  async retest(accountId?: string): Promise<RetestResult> {
    return retest(this.pool, this.id, accountId)
  }

// ─────────── 永久积分锁（该供应商不支持）───────────

  permanentLocked(): boolean {
    return false
  }

  async setPermanentLocked(_locked: boolean): Promise<void> {
    throw new Error(`${this.displayName} 不支持「锁定永久积分」（仅 CodeBuddy / WorkBuddy 有该能力）`)
  }

  async dispose(): Promise<void> {
    try {
      this.auth.stop()
    } catch {
      // 忽略卸载期异常。
    }
  }
}

export function createTraeProvider(deps: TraeProviderDeps): Promise<TraeProvider> {
  return TraeProvider.create(deps)
}
