/**
 * Qoder（阿里系）供应商实现。
 *
 * 与其余脉系都不同源：
 *   - 登录：**PKCE 设备码轮询**（不起本地监听端口）
 *   - 推理：走**加密端点**（请求体由内嵌 WASM 加密、签名头必须原样透传、
 *     响应套一层信封）—— 全部由 vendor 的 `qoder-adapter.ts` /
 *     `qoder-wasm.ts` / `qoder-envelope.ts` 处理，本文件只做接线。
 *   - 积分：`/sash/` 端点，需 `Cosy-ClientType` + 成对的 machine 头。
 */
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { QoderAuth } from '../../vendor/src/qoder-auth.js'
import { QoderAdapter } from '../../vendor/src/qoder-adapter.js'
import { AccountPool } from '../../vendor/src/account-pool.js'
import { QODER } from '../../vendor/src/qoder-product.js'
import { claimQoderDailyCheckin, fetchQoderCreditBalance } from '../../vendor/src/qoder-credits.js'
import {
  applyModelDisabled,
  clearAllModelsDisabled,
  listModelsWithState,
  refreshModels,
  resetLimits,
  retest,
} from '../core/provider-common.js'
import { createGatewayContext, withStateDir, type GatewayContext } from '../core/context.js'
import { qoderFetch } from '../core/qoder-transport.js'
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

export interface QoderProviderDeps {
  dataDir: string
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
}

export class QoderProvider implements Provider {
  readonly id = QODER.id
  readonly displayName = QODER.displayName
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

  private readonly auth: QoderAuth
  private readonly defaultRef: string

  private constructor(deps: QoderProviderDeps, gateway: GatewayContext, pool: AccountPool) {
    this.gateway = gateway
    this.pool = pool
    this.defaultRef = QODER.defaultCredentialRef
    // ⚠️ auth 也必须用 Qoder 专用传输：续期走 `openapi.qoder.sh`，
    //    该 host 与推理 host 同样在 TLS 1.3 下被重置（实测 ECONNRESET，
    //    TLS 1.2 → HTTP 404 正常）。不注入就会「续期网络失败：fetch failed」。
    this.auth = new QoderAuth(gateway.ctx as never, { product: QODER, fetcher: qoderFetch })

    // 同 buddy：直接构造适配器类，不注册到 DSH 的 ctx.llm。
    this.adapter = new QoderAdapter({
      credentialRef: credentialRef(this.defaultRef),
      resolveCredential: async (modelId?: string) => {
        const available = await pool.getAvailableAccount(QODER.id, modelId ?? '')
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
        // ⚠️⚠️ **必须按账号池里的 ref 续期**（真实缺陷，2026-10-13）。
        //
        // `auth.refresh()` 读的是产品的**默认** ref（`QODER_ACCESS_TOKEN`），
        // 而账号池里每个账号的凭据存在自己的 ref（如 `QODER_ACCOUNT_51965821`）。
        // 两者不一致时 `refresh()` 必然抛「未配置凭据，请先登录」——**文案是误导**，
        // 凭据其实齐全且就在池里。触发条件是凭据过期（`isQoderExpired`），
        // 表现为「用着用着突然全部模型都报未登录、重登也没用」。
        //
        // 修法：优先用 `refreshAccountCredential(该账号的 ref, pool, id)` 续期；
        // 只有池里没有可用账号时才退回默认 ref（单凭据场景）。
        const available = await pool.getAvailableAccount(QODER.id, '')
        if (available) {
          await this.auth.refreshAccountCredential(
            available.entry.credentialRef,
            pool,
            available.entry.id,
          )
          return
        }
        await this.auth.refresh()
      },
      accountPool: pool,
      product: QODER,
      // ⚠️ Qoder 专用传输：**只对 qoder 用 TLS 1.2**。
      //    Windows 上默认 TLS 1.3 到 qoder 主机的握手会被中断（实测 10.8s 超时，
      //    而 TLS 1.2 稳定 461ms）。诊断与理由见 src/core/qoder-transport.ts。
      //    其余供应商保持默认 —— 不做全局降级。
      fetchImpl: qoderFetch,
    }) as LlmAdapter
  }

  static async create(deps: QoderProviderDeps): Promise<QoderProvider> {
    const stateDir = `${deps.dataDir}/providers/${QODER.id}`
    const gateway = createGatewayContext({
      dataDir: stateDir,
      providerId: QODER.id,
      ...(deps.logLevel ? { logLevel: deps.logLevel } : {}),
    })
    const pool = await withStateDir(stateDir, () => new AccountPool(gateway.ctx as never))
    return new QoderProvider(deps, gateway, pool)
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

    // Qoder 的登录 URL 是本地构造的（设备码流程），立即可返回。
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
        const balance = await fetchQoderCreditBalance(credential as never, QODER)
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
        const outcome = await claimQoderDailyCheckin(credential as never, QODER)
        if (outcome.kind === 'claimed') {
          claimed += 1
          if (typeof outcome.credit === 'number') amount += outcome.credit
        } else if (outcome.kind === 'already-claimed') {
          already += 1
        } else if (outcome.kind === 'failed') {
          failures.push(`${account.nickname}: ${outcome.message}`)
        }
        // inactive：可能是"账号未开通"，vendor 已把可操作提示放进 message，
        // 这里当作未领到但不计失败（避免误报）。
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

export function createQoderProvider(deps: QoderProviderDeps): Promise<QoderProvider> {
  return QoderProvider.create(deps)
}
