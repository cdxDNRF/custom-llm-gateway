/**
 * 8 家新接入供应商的通用实现骨架。
 *
 * 这些 provider 的差异只在「调哪个 adapter 类 / Auth 类 / credits 函数」，
 * 结构完全一致：构造 Context → AccountPool → 适配器 → 实现统一契约。
 * 抽到这里避免 8 份复制粘贴各长各的 bug。
 *
 * 与既有 buddy/trae/qoder provider 的关系：那三个先写、粒度更细；
 * 这批走通用骨架（同一作者、同一轮写的），行为契约完全相同。
 */
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { AccountPool } from '../../vendor/src/account-pool.js'
import {
  createGatewayContext,
  withStateDir,
  type GatewayContext,
} from '../core/context.js'
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
import {
  applyModelDisabled,
  clearAllModelsDisabled,
  listModelsWithState,
  refreshModels as refreshModelsCommon,
  resetLimits,
  retest,
} from '../core/provider-common.js'

/** 通用能力集：都能登录/多账号/续期或探测；签到与余额按家声明。 */
export interface GenericProviderSpec {
  id: string
  displayName: string
  /** 适配器实例（由各 provider 文件构造好传入）。 */
  adapter: LlmAdapter
  pool: AccountPool
  gateway: GatewayContext
  /** 静默续期（调 Auth 的 refreshAccountCredential / refreshAll）。 */
  refreshAll: () => Promise<void>
  /** 余额查询；不支持返回 undefined。 */
  queryBalance?: () => Promise<BalanceView | undefined>
  /** 签到；不支持返回 unavailable。 */
  checkin?: () => Promise<CheckinResult>
  /** 是否支持锁定永久积分。 */
  permanentLock?: boolean
}

/** 骨架：把 spec 组装成完整 Provider（模型管理/限流/重测等全部共用实现）。 */
export abstract class GenericProviderBase implements Provider {
  abstract readonly id: string
  abstract readonly displayName: string
  abstract readonly capabilities: ProviderCapabilities
  abstract readonly adapter: LlmAdapter
  abstract readonly pool: AccountPool
  abstract readonly gateway: GatewayContext

  protected readonly spec: GenericProviderSpec

  constructor(spec: GenericProviderSpec) {
    this.spec = spec
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

  abstract startLogin(nickname?: string): Promise<LoginStart>

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
    if (this.spec.queryBalance === undefined) return undefined
    return this.spec.queryBalance()
  }

  async checkin(): Promise<CheckinResult> {
    if (this.spec.checkin === undefined) {
      return { ok: false, status: 'unavailable', message: `${this.displayName} 不支持每日签到` }
    }
    return this.spec.checkin()
  }

  async refreshAll(): Promise<void> {
    await this.spec.refreshAll()
  }

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

  async refreshModels(): Promise<{ count: number }> {
    return refreshModelsCommon(this.adapter, this.id)
  }

  async reorderAccounts(orderedIds: readonly string[]): Promise<void> {
    await this.pool.reorderAccounts(this.id, orderedIds)
  }

  async resetRateLimits(accountId?: string): Promise<{ clearedCount: number; accountCount: number }> {
    return resetLimits(this.pool, this.id, accountId)
  }

  async retest(accountId?: string): Promise<RetestResult> {
    return retest(this.pool, this.id, accountId)
  }

  permanentLocked(): boolean {
    if (this.spec.permanentLock === true) return this.pool.permanentLocked(this.id)
    return false
  }

  async setPermanentLocked(locked: boolean): Promise<void> {
    if (this.spec.permanentLock === true) {
      await this.pool.setPermanentLocked(this.id, locked)
      return
    }
    throw new Error(`${this.displayName} 不支持「锁定永久积分」`)
  }

  async dispose(): Promise<void> {
    // 各家的 Auth.stop 在 spec 的创建闭包里另行接线；这里由 provider 文件覆写。
  }
}

/** 帮助函数：按「账号池优先，单凭据兜底」解析凭据（与既有 provider 同语义）。 */
export function makeCredentialResolver<T>(
  gateway: GatewayContext,
  pool: AccountPool,
  providerId: string,
  defaultRef: string,
): (modelId?: string) => Promise<T | undefined> {
  return async (modelId?: string): Promise<T | undefined> => {
    // ⚠️ modelId 必须透传：限流按「账号×模型」记，传空串会让限流过滤失效
    //（vendor 的踩坑记录）。
    const available = await pool.getAvailableAccount(providerId, modelId ?? '')
    if (available) return available.credential as T
    const raw = gateway.credentials.get(defaultRef)
    if (raw === undefined) return undefined
    try {
      return JSON.parse(raw) as T
    } catch {
      return undefined
    }
  }
}

export { withStateDir }
