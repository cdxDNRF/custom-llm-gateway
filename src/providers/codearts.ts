/**
 * 华为云 CodeArts 供应商。
 *
 * 特点：IAM OAuth 登录（本地回调服务器收授权码）；AK/SK 凭据 + HMAC 签名；
 * 每日签到得积分（SDK-HMAC-SHA256 签名的活动端点）。
 * 登录/续期/签到全由 vendor 的 `service.ts`（CodeArtsAuth）与 `codearts-credits.ts` 承载。
 */
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { CodeArtsAuth, CODEARTS_CREDENTIAL_REF } from '../../vendor/src/service.js'
import { CodeArtsAdapter } from '../../vendor/src/llm-adapter.js'
import { AccountPool } from '../../vendor/src/account-pool.js'
import {
  claimCodeArtsDailyCheckin,
  fetchCodeArtsAccountInfoDetailed,
} from '../../vendor/src/codearts-credits.js'
import type { CodeArtsCredential } from '../../vendor/src/types.js'
import { createGatewayContext, withStateDir, type GatewayContext } from '../core/context.js'
import { GenericProviderBase, makeCredentialResolver } from './generic.js'
import type {
  BalanceView,
  CheckinResult,
  LoginStart,
  Provider,
  ProviderCapabilities,
} from '../core/provider.js'

function shortId(): string {
  return Math.random().toString(16).slice(2, 10)
}

export class CodeArtsProvider extends GenericProviderBase implements Provider {
  readonly id = 'codearts'
  readonly displayName = 'CodeArts (华为云)'
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

  private readonly auth: CodeArtsAuth

  private constructor(gateway: GatewayContext, pool: AccountPool) {
    super({
      id: 'codearts',
      displayName: 'CodeArts (华为云)',
      adapter: undefined as unknown as LlmAdapter,
      pool,
      gateway,
      refreshAll: async () => { /* 由子类覆写 refreshAll 实现 */ },
    })
    this.gateway = gateway
    this.pool = pool
    this.auth = new CodeArtsAuth(gateway.ctx as never)
    const resolve = makeCredentialResolver<CodeArtsCredential>(gateway, pool, 'codearts', CODEARTS_CREDENTIAL_REF)
    this.adapter = new CodeArtsAdapter({
      credentialRef: credentialRef(CODEARTS_CREDENTIAL_REF),
      resolveCredential: async () => resolve(),
      refresh: async () => {
        const available = await pool.getAvailableAccount('codearts', '')
        if (available) {
          await this.auth.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
        }
      },
      fetchRemoteModels: () => this.auth.refreshModels(pool),
      accountPool: pool,
    }) as LlmAdapter
  }

  static async create(dataDir: string, logLevel?: 'debug' | 'info' | 'warn' | 'error'): Promise<CodeArtsProvider> {
    const stateDir = `${dataDir}/providers/codearts`
    const gateway = createGatewayContext({ dataDir: stateDir, providerId: 'codearts', ...(logLevel ? { logLevel } : {}) })
    const pool = await withStateDir(stateDir, () => new AccountPool(gateway.ctx as never))
    return new CodeArtsProvider(gateway, pool)
  }

  override async startLogin(_nickname?: string): Promise<LoginStart> {
    const id = `codearts-${shortId()}`
    const refName = `CODEARTS_ACCOUNT_${shortId().toUpperCase()}`
    await this.pool.addAccount({
      id, provider: 'codearts', nickname: id, enabled: true,
      credentialRef: refName, refreshable: false, createdAt: Date.now(),
    })
    const started = await this.auth.startLogin({ refName, accountId: id, pool: this.pool })
    const completed = started.result
      .then(() => ({ ok: true as const }))
      .catch(async (error: unknown) => {
        await this.pool.removeAccount(id).catch(() => {})
        return { ok: false as const, error: String(error) }
      })
    return { loginUrl: started.loginUrl, accountId: id, completed }
  }

  private async balanceImpl(): Promise<BalanceView | undefined> {
    const accounts = await this.pool.listAccounts(this.id)
    for (const account of accounts.filter((a) => a.enabled)) {
      const raw = this.gateway.credentials.get(account.credentialRef)
      if (raw === undefined) continue
      try {
        const credential = JSON.parse(raw) as CodeArtsCredential
        const info = await fetchCodeArtsAccountInfoDetailed(credential)
        if (!info.ok) continue
        return {
          total: 0,
          unit: 'credits',
          items: [{ name: `${account.nickname} · ${info.info.packageName}`, remain: 0 }],
          at: Date.now(),
        }
      } catch {
        // 单账号失败不影响整体。
      }
    }
    return undefined
  }

  private async checkinImpl(): Promise<CheckinResult> {
    const accounts = await this.pool.listAccounts(this.id)
    const enabled = accounts.filter((a) => a.enabled)
    if (enabled.length === 0) return { ok: false, status: 'unavailable', message: '没有已启用的账号' }
    let claimed = 0
    let already = 0
    const failures: string[] = []
    for (const account of enabled) {
      const raw = this.gateway.credentials.get(account.credentialRef)
      if (raw === undefined) continue
      try {
        const credential = JSON.parse(raw) as CodeArtsCredential
        const outcome = await claimCodeArtsDailyCheckin(credential)
        if (outcome.kind === 'claimed') claimed += 1
        else if (outcome.kind === 'already-claimed') already += 1
        else if (outcome.kind === 'failed') failures.push(`${account.nickname}: ${outcome.message}`)
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
      message: `领取 ${claimed} 个账号，${already} 个今日已领`,
    }
  }

  override async refreshAll(): Promise<void> {
    const available = await this.pool.getAvailableAccount('codearts', '')
    if (available) {
      await this.auth.refreshAccountCredential(available.entry.credentialRef, this.pool, available.entry.id)
    }
  }

  /** CodeArtsAuth 无 stop（本地回调服务器在登录流程内自管）。 */
  async dispose(): Promise<void> {
    try {
      this.auth.stop()
    } catch {
      // 忽略。
    }
  }
}
