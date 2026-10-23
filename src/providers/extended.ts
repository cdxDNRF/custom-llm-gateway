/**
 * 其余七家供应商（lobsterai / cline / loomy / raccoon / minimax / qodercn / zcode）。
 *
 * 全部走通用骨架（generic.ts）；各家差异：
 *   - lobsterai / cline：Auth.startLogin 自带 refName/accountId/pool（登录后自动登记账号池）
 *   - raccoon / minimax：startLogin 不带 pool，凭据要自己 persist（调 Auth.persistLogin）
 *   - loomy：登录走微信扫码（startWechatLogin）；无自动续期端点（refresh 是"探测有效性"）
 *   - qodercn：与 qoder 同一个 QoderAdapter / QoderAuth，差异全在 QODER_CN 产品配置
 *   - zcode：适配器无注入 mintCaptcha 时自建常驻浏览器（约 200MB）；需 ZCODE_CHROME_PATH
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { GeminiCatalogModel } from '../core/gemini-catalog.js'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { AccountPool } from '../../vendor/src/account-pool.js'
import { createGatewayContext, withStateDir, type GatewayContext } from '../core/context.js'
import { GenericProviderBase } from './generic.js'
import type {
  BalanceView,
  CheckinResult,
  LoginStart,
  LoginSubmit,
  Provider,
  ProviderCapabilities,
} from '../core/provider.js'

function shortId(): string {
  return Math.random().toString(16).slice(2, 10)
}

/** 各家通用的「占位账号登记 + 后台等结果 + 失败清幽灵」流程。 */
function wireLogin(
  provider: { pool: AccountPool; gateway: GatewayContext; id: string },
  id: string,
  refName: string,
  nickname: string | undefined,
  result: Promise<{ access: string; refreshable: boolean; expiresAt?: number; nickname?: string }>,
): LoginStart {
  result.catch(() => {})
  void (async () => {
    try {
      const r = await result
      provider.gateway.credentials.set(refName, r.access)
      await provider.pool.updateAccount(id, {
        nickname: r.nickname && r.nickname.length > 0 ? r.nickname : id,
        ...(r.expiresAt !== undefined ? { expiresAt: r.expiresAt } : {}),
        refreshable: r.refreshable,
      })
      provider.gateway.logger.info(`账号 ${id} 登录成功`)
    } catch (error) {
      await provider.pool.removeAccount(id).catch(() => {})
      provider.gateway.logger.warn(`账号 ${id} 登录失败:`, error)
    }
  })()
  return { loginUrl: '', accountId: id, completed: Promise.resolve({ ok: true }) }
}

/** 余额汇总的通用实现：逐启用账号调 balanceFn，合并 items。 */
async function sumBalances<T>(
  provider: { pool: AccountPool; gateway: GatewayContext; id: string },
  balanceFn: (credential: T) => Promise<import('../core/provider.js').BalanceView['total'] | { view: BalanceView } | null>,
): Promise<BalanceView | undefined> {
  const accounts = await provider.pool.listAccounts(provider.id)
  const enabled = accounts.filter((a) => a.enabled)
  if (enabled.length === 0) return undefined
  let total = 0
  const items: BalanceView['items'] = []
  for (const account of enabled) {
    const raw = provider.gateway.credentials.get(account.credentialRef)
    if (raw === undefined) continue
    try {
      const credential = JSON.parse(raw) as T
      const r = await balanceFn(credential)
      if (typeof r === 'number') {
        total += r
        items.push({ name: account.nickname, remain: r })
      } else if (r && typeof r === 'object' && 'view' in r) {
        total += r.view.total
        items.push(...(r.view.items ?? []))
      }
    } catch (error) {
      provider.gateway.logger.warn(`账号 ${account.id} 余额查询失败:`, error)
    }
  }
  if (items.length === 0) return undefined
  return { total, unit: 'credits', items, at: Date.now() }
}

/** 签到的通用实现：逐启用账号调 claimFn。 */
async function claimAll<T>(
  provider: { pool: AccountPool; gateway: GatewayContext; id: string },
  claimFn: (credential: T) => Promise<import('../core/provider.js').CheckinResult>,
): Promise<CheckinResult> {
  const accounts = await provider.pool.listAccounts(provider.id)
  const enabled = accounts.filter((a) => a.enabled)
  if (enabled.length === 0) return { ok: false, status: 'unavailable', message: '没有已启用的账号' }
  let claimed = 0
  let already = 0
  let amount = 0
  const failures: string[] = []
  for (const account of enabled) {
    const raw = provider.gateway.credentials.get(account.credentialRef)
    if (raw === undefined) continue
    try {
      const credential = JSON.parse(raw) as T
      const r = await claimFn(credential)
      if (r.status === 'claimed') {
        claimed += 1
        amount += r.amount ?? 0
      } else if (r.status === 'already-claimed') already += 1
      else if (r.status === 'failed') failures.push(`${account.nickname}: ${r.message}`)
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

/** 通用 Provider 骨架（具体行为由工厂闭包注入）。 */
class GenericImpl extends GenericProviderBase implements Provider {
  readonly id: string
  readonly displayName: string
  readonly capabilities: ProviderCapabilities
  readonly adapter: LlmAdapter
  readonly pool: AccountPool
  readonly gateway: GatewayContext
  readonly loginImpl: (nickname?: string) => Promise<LoginStart>
  readonly submitLoginImpl: ((input: LoginSubmit) => Promise<{ ok: boolean; error?: string }>) | undefined
  readonly refreshModelsImpl: (() => Promise<{ count: number }>) | undefined

  constructor(init: {
    id: string
    displayName: string
    capabilities: ProviderCapabilities
    adapter: LlmAdapter
    pool: AccountPool
    gateway: GatewayContext
    loginImpl: (nickname?: string) => Promise<LoginStart>
    /** 「填文本」型登录的提交回调（见 LoginStart.input）。 */
    submitLoginImpl?: (input: LoginSubmit) => Promise<{ ok: boolean; error?: string }>
    /**
     * 「重拉模型目录」的专用实现。
     *
     * 缺省走通用 `refreshModelsCommon`（清缓存 + 重新 listModels）。
     * 动态目录的 provider（如 Gemini —— 表来自远端拉取 + 可用性探测）
     * 需要自己的实现，通用路径对它无事可做。
     */
    refreshModelsImpl?: () => Promise<{ count: number }>
    refreshAll: () => Promise<void>
    queryBalance?: () => Promise<BalanceView | undefined>
    checkin?: () => Promise<CheckinResult>
    permanentLock?: boolean
  }) {
    super(init)
    this.id = init.id
    this.displayName = init.displayName
    this.capabilities = init.capabilities
    this.adapter = init.adapter
    this.pool = init.pool
    this.gateway = init.gateway
    this.loginImpl = init.loginImpl
    this.submitLoginImpl = init.submitLoginImpl
    this.refreshModelsImpl = init.refreshModelsImpl
  }

  /** 「重拉模型目录」：有专用实现走它，否则退回通用路径。 */
  async refreshModels(): Promise<{ count: number }> {
    if (this.refreshModelsImpl !== undefined) return this.refreshModelsImpl()
    return super.refreshModels()
  }

  async startLogin(nickname?: string): Promise<LoginStart> {
    return this.loginImpl(nickname)
  }

  async submitLogin(input: LoginSubmit): Promise<{ ok: boolean; error?: string }> {
    if (this.submitLoginImpl === undefined) {
      return { ok: false, error: `${this.displayName} 不支持填写式登录` }
    }
    return this.submitLoginImpl(input)
  }

  async refreshAll(): Promise<void> {
    await super.refreshAll()
  }

  async dispose(): Promise<void> {
    // 各 Auth 的 stop 由工厂闭包持有（见 create* 工厂）。
  }
}

/** 创建 context+pool 的公共头。 */
async function makeBase(
  id: string,
  dataDir: string,
  logLevel?: 'debug' | 'info' | 'warn' | 'error',
): Promise<{ gateway: GatewayContext; pool: AccountPool }> {
  const stateDir = `${dataDir}/providers/${id}`
  const gateway = createGatewayContext({ dataDir: stateDir, providerId: id, ...(logLevel ? { logLevel } : {}) })
  const pool = await withStateDir(stateDir, () => new AccountPool(gateway.ctx as never))
  return { gateway, pool }
}

// ─────────────────────────── LobsterAI ───────────────────────────

export async function createLobsteraiProvider(
  dataDir: string,
  logLevel?: 'debug' | 'info' | 'warn' | 'error',
): Promise<Provider> {
  const { gateway, pool } = await makeBase('lobsterai', dataDir, logLevel)
  const { LobsteraiAuth } = await import('../../vendor/src/lobsterai-auth.js')
  const { LobsteraiAdapter } = await import('../../vendor/src/lobsterai-adapter.js')
  const { LOBSTERAI } = await import('../../vendor/src/lobsterai-product.js')
  const { claimLobsteraiDailyCheckin, fetchLobsteraiCreditBalance } = await import('../../vendor/src/lobsterai-credits.js')
  const auth = new LobsteraiAuth(gateway.ctx as never, { product: LOBSTERAI })
  const resolve = async (modelId?: string) => {
    const available = await pool.getAvailableAccount('lobsterai', modelId ?? '')
    if (available) return available.credential
    const raw = gateway.credentials.get(LOBSTERAI.defaultCredentialRef)
    try { return raw === undefined ? undefined : JSON.parse(raw) } catch { return undefined }
  }
  const adapter = new LobsteraiAdapter({
    credentialRef: credentialRef(LOBSTERAI.defaultCredentialRef),
    resolveCredential: resolve,
    refresh: async () => {
      const available = await pool.getAvailableAccount('lobsterai', '')
      if (available) await auth.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
      else await auth.refresh()
    },
    fetchRemoteModels: () => auth.fetchModels(pool),
    resolveClientVersion: () => auth.resolveClientVersion(),
    accountPool: pool,
    product: LOBSTERAI,
  }) as LlmAdapter
  return new GenericImpl({
    id: 'lobsterai',
    displayName: 'LobsterAI (有道)',
    capabilities: { login: true, dailyCheckin: true, balance: true, permanentLock: false, multiAccount: true, refresh: true },
    adapter, pool, gateway,
    loginImpl: async () => {
      const id = `lobsterai-${shortId()}`
      const refName = `LOBSTERAI_ACCOUNT_${shortId().toUpperCase()}`
      await pool.addAccount({ id, provider: 'lobsterai', nickname: id, enabled: true, credentialRef: refName, refreshable: false, createdAt: Date.now() })
      const started = await auth.startLogin({ refName, accountId: id, pool })
      const completed = started.result
        .then(async (r) => { gateway.logger.info(`账号 ${id} 登录成功`); return { ok: true as const } })
        .catch(async (e) => { await pool.removeAccount(id).catch(() => {}); return { ok: false as const, error: String(e) } })
      return { loginUrl: started.loginUrl, accountId: id, completed }
    },
    refreshAll: async () => {
      const available = await pool.getAvailableAccount('lobsterai', '')
      if (available) await auth.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
      else await auth.refresh()
    },
    queryBalance: () =>
      sumBalances<{ total?: number }>( { pool, gateway, id: 'lobsterai' }, async (c) => {
        const b = await fetchLobsteraiCreditBalance(c as never, LOBSTERAI)
        return b?.total ?? 0
      }),
    checkin: () =>
      claimAll<never>({ pool, gateway, id: 'lobsterai' }, async (c) => {
        const o = await claimLobsteraiDailyCheckin(c as never, LOBSTERAI, '0.0.0')
        return { status: o.kind === 'claimed' ? 'claimed' : o.kind === 'already-claimed' ? 'already-claimed' : 'failed', message: 'message' in o ? o.message : '', amount: 'credit' in o ? o.credit : undefined } as CheckinResult
      }),
  })
}

// ─────────────────────────── Cline ───────────────────────────

export async function createClineProvider(
  dataDir: string,
  logLevel?: 'debug' | 'info' | 'warn' | 'error',
): Promise<Provider> {
  const { gateway, pool } = await makeBase('cline', dataDir, logLevel)
  const { ClineAuth } = await import('../../vendor/src/cline-auth.js')
  const { ClineAdapter } = await import('../../vendor/src/cline-adapter.js')
  const { CLINE } = await import('../../vendor/src/cline-product.js')
  const { fetchClineCreditBalance } = await import('../../vendor/src/cline-credits.js')
  const auth = new ClineAuth(gateway.ctx as never, { product: CLINE })
  const adapter = new ClineAdapter({
    credentialRef: credentialRef(CLINE.defaultCredentialRef),
    resolveCredential: async (modelId?: string) => {
      const available = await pool.getAvailableAccount('cline', modelId ?? '')
      if (available) return available.credential as never
      const raw = gateway.credentials.get(CLINE.defaultCredentialRef)
      try { return raw === undefined ? undefined : JSON.parse(raw) } catch { return undefined }
    },
    refresh: async () => {
      const available = await pool.getAvailableAccount('cline', '')
      if (available) await auth.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
      else await auth.refresh()
    },
    accountPool: pool,
  }) as LlmAdapter
  return new GenericImpl({
    id: 'cline',
    displayName: 'Cline',
    capabilities: { login: true, dailyCheckin: false, balance: true, permanentLock: false, multiAccount: true, refresh: true },
    adapter, pool, gateway,
    loginImpl: async () => {
      const id = `cline-${shortId()}`
      const refName = `CLINE_ACCOUNT_${shortId().toUpperCase()}`
      await pool.addAccount({ id, provider: 'cline', nickname: id, enabled: true, credentialRef: refName, refreshable: false, createdAt: Date.now() })
      const started = await auth.startLogin({ refName, accountId: id, pool })
      const completed = started.result
        .then(async (r) => { gateway.logger.info(`账号 ${id} 登录成功（${r.refreshable ? '可续期' : '不可续期'}）`); return { ok: true as const } })
        .catch(async (e) => { await pool.removeAccount(id).catch(() => {}); return { ok: false as const, error: String(e) } })
      return { loginUrl: started.loginUrl, accountId: id, completed }
    },
    refreshAll: async () => {
      const available = await pool.getAvailableAccount('cline', '')
      if (available) await auth.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
      else await auth.refresh()
    },
    queryBalance: () =>
      sumBalances<never>({ pool, gateway, id: 'cline' }, async (c) => {
        const r = await fetchClineCreditBalance(c as never, CLINE)
        return r.balance?.total ?? 0
      }),
  })
}

// ─────────────────────────── Loomy ───────────────────────────

/**
 * 读取讯飞 AccessKey（Loomy 账号端点 HMAC 签名用）。
 *
 * ⚠️ 密钥**不在仓库里**：曾硬编码在 `vendor/src/loomy-product.ts` 并随首次
 * 提交进入公开历史，现已清空，改为从两处本地配置读取（按序取先到）：
 *
 * 1. 环境变量 `LOOMY_ACCESS_KEY_ID` / `LOOMY_ACCESS_KEY_SECRET`
 * 2. `<数据目录>/loomy.env`（`KEY=VALUE` 行，未跟踪，权限 0600）
 *
 * 两处都没有时抛错 —— registry 对单个供应商初始化失败有隔离（只挡 Loomy，
 * 不影响其它家），缺配置即「Loomy 不可用」，这正是期望行为。
 *
 * 注意 `loomy.env` 默认在 `~/.dsh-llm-gateway/`（或 `GATEWAY_HOME` 指向的
 * 数据目录），而仓库里那份 `.dsh-llm-gateway/config.json` 只在用仓库目录
 * 作 `GATEWAY_HOME` 时才会被读到 —— 两处互不影响。
 */
async function loadLoomyAccessKeys(dataDir: string): Promise<{ id: string; secret: string }> {
  const fromEnv = process.env.LOOMY_ACCESS_KEY_ID ?? ''
  const fromEnvSecret = process.env.LOOMY_ACCESS_KEY_SECRET ?? ''
  if (fromEnv.length > 0 && fromEnvSecret.length > 0) {
    return { id: fromEnv, secret: fromEnvSecret }
  }

  const envPath = resolve(dataDir, 'loomy.env')
  try {
    const lines = readFileSync(envPath, 'utf8').split(/\r?\n/)
    const values = new Map<string, string>()
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq <= 0) continue
      const key = trimmed.slice(0, eq).trim()
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
      if (key.length > 0) values.set(key, value)
    }
    const id = values.get('LOOMY_ACCESS_KEY_ID') ?? ''
    const secret = values.get('LOOMY_ACCESS_KEY_SECRET') ?? ''
    if (id.length > 0 && secret.length > 0) return { id, secret }
  } catch {
    // 文件不存在：走下方统一报错。
  }

  throw new Error(
    'Loomy 讯飞 AccessKey 未配置（LOOMY_ACCESS_KEY_ID / LOOMY_ACCESS_KEY_SECRET）。'
    + `请在 ${envPath} 写入 KEY=VALUE 两行，或设置同名环境变量；未配置时 Loomy 保持禁用。`,
  )
}

export async function createLoomyProvider(
  dataDir: string,
  logLevel?: 'debug' | 'info' | 'warn' | 'error',
): Promise<Provider> {
  const { gateway, pool } = await makeBase('loomy', dataDir, logLevel)
  const { LoomyAuth } = await import('../../vendor/src/loomy-auth.js')
  const { LoomyAdapter } = await import('../../vendor/src/loomy-adapter.js')
  const { LOOMY } = await import('../../vendor/src/loomy-product.js')
  const { claimLoomyDailyQuota, fetchLoomyCreditBalance } = await import('../../vendor/src/loomy-credits.js')
  const { parseLoomyRemoteModels } = await import('../../vendor/src/loomy-adapter.js')
  // 密钥必须先于任何 Auth/Adapter 构造注入（它们拿到的 product 引用是共享的）。
  const keys = await loadLoomyAccessKeys(dataDir)
  LOOMY.accessKeyId = keys.id
  LOOMY.accessKeySecret = keys.secret
  const auth = new LoomyAuth(gateway.ctx as never, { product: LOOMY })
  const adapter = new LoomyAdapter({
    credentialRef: credentialRef(LOOMY.defaultCredentialRef),
    resolveCredential: async (modelId?: string) => {
      const available = await pool.getAvailableAccount('loomy', modelId ?? '')
      if (available) return available.credential as never
      const raw = gateway.credentials.get(LOOMY.defaultCredentialRef)
      try { return raw === undefined ? undefined : JSON.parse(raw) } catch { return undefined }
    },
    // ⚠️ Loomy 没有 refresh 端点：refresh 语义是「探测凭据有效性」，失效要重登。
    refresh: async () => {
      const available = await pool.getAvailableAccount('loomy', '')
      if (available) await auth.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
      else await auth.refresh()
    },
    fetchRemoteModels: async () => {
      const available = await pool.getAvailableAccount('loomy', '')
      const raw = available
        ? JSON.stringify(available.credential)
        : gateway.credentials.get(LOOMY.defaultCredentialRef)
      if (raw === undefined) return []
      try {
        const credential = JSON.parse(raw) as { access_token: string }
        const response = await fetch(`${LOOMY.apiBase}/models`, {
          headers: { Accept: 'application/json', token: credential.access_token },
          signal: AbortSignal.timeout(30_000),
        })
        if (!response.ok) return []
        return parseLoomyRemoteModels(await response.json())
      } catch { return [] }
    },
    accountPool: pool,
    product: LOOMY,
  }) as LlmAdapter
  return new GenericImpl({
    id: 'loomy',
    displayName: 'Loomy (讯飞)',
    capabilities: { login: true, dailyCheckin: true, balance: true, permanentLock: false, multiAccount: true, refresh: false },
    adapter, pool, gateway,
    loginImpl: async () => {
      const id = `loomy-${shortId()}`
      const refName = `LOOMY_ACCOUNT_${shortId().toUpperCase()}`
      await pool.addAccount({ id, provider: 'loomy', nickname: id, enabled: true, credentialRef: refName, refreshable: false, createdAt: Date.now() })
      // Loomy 走微信扫码（startWechatLogin 起本地页，返回 loginUrl）
      const started = await auth.startWechatLogin()
      started.result.then(async (login) => {
        const result = await auth.persistWechatLogin(login, { refName })
        const credential = JSON.parse(result.access) as { phone?: string; nickname?: string }
        await pool.updateAccount(id, {
          nickname: login.nickname && login.nickname.length > 0 ? login.nickname
            : credential.phone && credential.phone.length >= 4 ? `Loomy ${credential.phone.slice(-4)}` : id,
          ...(result.expires > 0 ? { expiresAt: result.expires } : {}),
          refreshable: false,
        })
        gateway.logger.info(`账号 ${id} 登录成功`)
      }).catch(async (e) => {
        await pool.removeAccount(id).catch(() => {})
        gateway.logger.warn(`账号 ${id} 登录失败:`, e)
      })
      return { loginUrl: started.loginUrl, accountId: id, completed: Promise.resolve({ ok: true }) }
    },
    refreshAll: async () => {
      const available = await pool.getAvailableAccount('loomy', '')
      if (available) await auth.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
      else await auth.refresh()
    },
    queryBalance: () =>
      sumBalances<never>({ pool, gateway, id: 'loomy' }, async (c) => {
        const b = await fetchLoomyCreditBalance(c as never, LOOMY)
        return b?.total ?? 0
      }),
    checkin: () =>
      claimAll<never>({ pool, gateway, id: 'loomy' }, async (c) => {
        const o = await claimLoomyDailyQuota(c as never, LOOMY)
        return { status: o.kind === 'claimed' ? 'claimed' : o.kind === 'already-claimed' ? 'already-claimed' : 'failed', message: 'message' in o ? o.message : '' } as CheckinResult
      }),
  })
}

// ─────────────────────────── Raccoon ───────────────────────────

export async function createRaccoonProvider(
  dataDir: string,
  logLevel?: 'debug' | 'info' | 'warn' | 'error',
): Promise<Provider> {
  const { gateway, pool } = await makeBase('raccoon', dataDir, logLevel)
  const { RaccoonAuth } = await import('../../vendor/src/raccoon-auth.js')
  const { RaccoonAdapter } = await import('../../vendor/src/raccoon-adapter.js')
  const { RACCOON } = await import('../../vendor/src/raccoon-product.js')
  const { claimRaccoonLoginReward, fetchRaccoonCreditBalance } = await import('../../vendor/src/raccoon-credits.js')
  const auth = new RaccoonAuth(gateway.ctx as never, { product: RACCOON })
  const adapter = new RaccoonAdapter({
    credentialRef: credentialRef(RACCOON.defaultCredentialRef),
    resolveCredential: async (modelId?: string) => {
      const available = await pool.getAvailableAccount('raccoon', modelId ?? '')
      if (available) return available.credential as never
      const raw = gateway.credentials.get(RACCOON.defaultCredentialRef)
      try { return raw === undefined ? undefined : JSON.parse(raw) } catch { return undefined }
    },
    refresh: async () => {
      const available = await pool.getAvailableAccount('raccoon', '')
      if (available) await auth.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
      else await auth.refresh()
    },
    fetchRemoteModels: () => auth.fetchModels(pool),
    accountPool: pool,
    product: RACCOON,
  }) as LlmAdapter
  return new GenericImpl({
    id: 'raccoon',
    displayName: 'Raccoon (商汤)',
    capabilities: { login: true, dailyCheckin: false, balance: true, permanentLock: false, multiAccount: true, refresh: true },
    adapter, pool, gateway,
    loginImpl: async () => {
      const id = `raccoon-${shortId()}`
      const refName = `RACCOON_ACCOUNT_${shortId().toUpperCase()}`
      await pool.addAccount({ id, provider: 'raccoon', nickname: id, enabled: true, credentialRef: refName, refreshable: false, createdAt: Date.now() })
      // raccoon.startLogin 不带 pool：result 是凭据本体，要自己 persist
      const started = await auth.startLogin()
      started.result.then(async (credential) => {
        const result = await auth.persistLogin(credential, { refName })
        await pool.updateAccount(id, {
          // raccoon 的 persistLogin 不回 accountId（服务端 name 是自动生成默认名）。
          // 登录结果里没有稳定昵称时保留占位 id，用户可自行删除重复账号。
          ...(result.expires > 0 ? { expiresAt: result.expires } : {}),
          refreshable: result.refreshable,
        })
        gateway.logger.info(`账号 ${id} 登录成功`)
      }).catch(async (e) => {
        await pool.removeAccount(id).catch(() => {})
        gateway.logger.warn(`账号 ${id} 登录失败:`, e)
      })
      return { loginUrl: started.loginUrl, accountId: id, completed: Promise.resolve({ ok: true }) }
    },
    refreshAll: async () => {
      const available = await pool.getAvailableAccount('raccoon', '')
      if (available) await auth.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
      else await auth.refresh()
    },
    queryBalance: () =>
      sumBalances<never>({ pool, gateway, id: 'raccoon' }, async (c) => {
        const b = await fetchRaccoonCreditBalance(RACCOON, c as never)
        return b?.total ?? 0
      }),
  })
}

// ─────────────────────────── MiniMax ───────────────────────────

export async function createMinimaxProvider(
  dataDir: string,
  logLevel?: 'debug' | 'info' | 'warn' | 'error',
): Promise<Provider> {
  const { gateway, pool } = await makeBase('minimax', dataDir, logLevel)
  const { MinimaxAuth } = await import('../../vendor/src/minimax-auth.js')
  const { loadMinimaxAdapter } = await import('./minimax-runtime.js')
  const MinimaxAdapter = await loadMinimaxAdapter()
  const { MINIMAX } = await import('../../vendor/src/minimax-product.js')
  const { claimMinimaxDailyCheckin, fetchMinimaxCreditBalance } = await import('../../vendor/src/minimax-credits.js')
  const { isMinimaxRefreshable, minimaxCredentialExpiresAtMs } = await import('../../vendor/src/minimax.js')
  const auth = new MinimaxAuth(gateway.ctx as never, { product: MINIMAX })
  const adapter = new MinimaxAdapter({
    credentialRef: credentialRef(MINIMAX.defaultCredentialRef),
    resolveCredential: async (modelId?: string) => {
      const available = await pool.getAvailableAccount('minimax', modelId ?? '')
      if (available) return available.credential as never
      const raw = gateway.credentials.get(MINIMAX.defaultCredentialRef)
      try { return raw === undefined ? undefined : JSON.parse(raw) } catch { return undefined }
    },
    refresh: async () => {
      const available = await pool.getAvailableAccount('minimax', '')
      if (available) await auth.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
      else await auth.refresh()
    },
    fetchRemoteModels: () => auth.fetchModels(pool),
    accountPool: pool,
  }) as LlmAdapter
  return new GenericImpl({
    id: 'minimax',
    displayName: 'MiniMax Code',
    capabilities: { login: true, dailyCheckin: true, balance: true, permanentLock: false, multiAccount: true, refresh: true },
    adapter, pool, gateway,
    loginImpl: async () => {
      const id = `minimax-${shortId()}`
      const refName = `MINIMAX_ACCOUNT_${shortId().toUpperCase()}`
      await pool.addAccount({ id, provider: 'minimax', nickname: id, enabled: true, credentialRef: refName, refreshable: false, createdAt: Date.now() })
      const started = await auth.startLogin()
      started.result.then(async (credential) => {
        const result = await auth.persistLogin(credential, { refName })
        await pool.updateAccount(id, {
          nickname: result.accountId === undefined ? id : `MiniMax ${result.accountId.slice(0, 8)}`,
          expiresAt: minimaxCredentialExpiresAtMs(credential),
          refreshable: isMinimaxRefreshable(credential),
        })
        gateway.logger.info(`账号 ${id} 登录成功`)
      }).catch(async (e) => {
        await pool.removeAccount(id).catch(() => {})
        gateway.logger.warn(`账号 ${id} 登录失败:`, e)
      })
      return { loginUrl: started.loginUrl, accountId: id, completed: Promise.resolve({ ok: true }) }
    },
    refreshAll: async () => {
      const available = await pool.getAvailableAccount('minimax', '')
      if (available) await auth.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
      else await auth.refresh()
    },
    queryBalance: () =>
      sumBalances<never>({ pool, gateway, id: 'minimax' }, async (c) => {
        const b = await fetchMinimaxCreditBalance(c as never)
        return b?.total ?? 0
      }),
    checkin: () =>
      claimAll<never>({ pool, gateway, id: 'minimax' }, async (c) => {
        const o = await claimMinimaxDailyCheckin(c as never)
        return { status: o.kind === 'claimed' ? 'claimed' : o.kind === 'already-claimed' ? 'already-claimed' : 'failed', message: 'message' in o ? o.message : '' } as CheckinResult
      }),
  })
}

// ─────────────────────────── Qoder CN ───────────────────────────

export async function createQoderCnProvider(
  dataDir: string,
  logLevel?: 'debug' | 'info' | 'warn' | 'error',
): Promise<Provider> {
  const { gateway, pool } = await makeBase('qodercn', dataDir, logLevel)
  const { QoderAuth } = await import('../../vendor/src/qoder-auth.js')
  const { QoderAdapter } = await import('../../vendor/src/qoder-adapter.js')
  const { QODER_CN } = await import('../../vendor/src/qoder-product.js')
  const { claimQoderDailyCheckin, fetchQoderCreditBalance } = await import('../../vendor/src/qoder-credits.js')
  const auth = new QoderAuth(gateway.ctx as never, { product: QODER_CN })
  const adapter = new QoderAdapter({
    credentialRef: credentialRef(QODER_CN.defaultCredentialRef),
    resolveCredential: async (modelId?: string) => {
      const available = await pool.getAvailableAccount('qodercn', modelId ?? '')
      if (available) return available.credential as never
      const raw = gateway.credentials.get(QODER_CN.defaultCredentialRef)
      try { return raw === undefined ? undefined : JSON.parse(raw) } catch { return undefined }
    },
    refresh: async () => {
      const available = await pool.getAvailableAccount('qodercn', '')
      if (available) await auth.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
      else await auth.refresh()
    },
    accountPool: pool,
    product: QODER_CN,
  }) as LlmAdapter
  return new GenericImpl({
    id: 'qodercn',
    displayName: 'Qoder (中国版)',
    capabilities: { login: true, dailyCheckin: true, balance: true, permanentLock: false, multiAccount: true, refresh: true },
    adapter, pool, gateway,
    loginImpl: async () => {
      const id = `qodercn-${shortId()}`
      const refName = `QODERCN_ACCOUNT_${shortId().toUpperCase()}`
      await pool.addAccount({ id, provider: 'qodercn', nickname: id, enabled: true, credentialRef: refName, refreshable: false, createdAt: Date.now() })
      const started = await auth.startLogin({ refName, accountId: id, pool })
      const completed = started.result
        .then(() => { gateway.logger.info(`账号 ${id} 登录成功`); return { ok: true as const } })
        .catch(async (e) => { await pool.removeAccount(id).catch(() => {}); return { ok: false as const, error: String(e) } })
      return { loginUrl: started.loginUrl, accountId: id, completed }
    },
    refreshAll: async () => {
      const available = await pool.getAvailableAccount('qodercn', '')
      if (available) await auth.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
      else await auth.refresh()
    },
    queryBalance: () =>
      sumBalances<never>({ pool, gateway, id: 'qodercn' }, async (c) => {
        const b = await fetchQoderCreditBalance(c as never, QODER_CN)
        return b?.total ?? 0
      }),
    checkin: () =>
      claimAll<never>({ pool, gateway, id: 'qodercn' }, async (c) => {
        const o = await claimQoderDailyCheckin(c as never, QODER_CN)
        return { status: o.kind === 'claimed' ? 'claimed' : o.kind === 'already-claimed' ? 'already-claimed' : 'failed', message: 'message' in o ? o.message : '' } as CheckinResult
      }),
  })
}

// ─────────────────────────── ZCode ───────────────────────────

export async function createZcodeProvider(
  dataDir: string,
  logLevel?: 'debug' | 'info' | 'warn' | 'error',
): Promise<Provider> {
  const { gateway, pool } = await makeBase('zcode', dataDir, logLevel)
  const { ZcodeAuth } = await import('../../vendor/src/zcode-auth.js')
  const { ZcodeAdapter } = await import('../../vendor/src/zcode-adapter.js')
  const { ZCODE } = await import('../../vendor/src/zcode-product.js')
  const auth = new ZcodeAuth(gateway.ctx as never, { product: ZCODE })
  const adapter = new ZcodeAdapter({
    credentialRef: credentialRef(ZCODE.defaultCredentialRef),
    resolveCredential: async (modelId?: string) => {
      const available = await pool.getAvailableAccount('zcode', modelId ?? '')
      if (available) return available.credential as never
      const raw = gateway.credentials.get(ZCODE.defaultCredentialRef)
      try { return raw === undefined ? undefined : JSON.parse(raw) } catch { return undefined }
    },
    refresh: async () => { /* zcode 凭据是静态 JWT（无 exp），无续期端点 */ },
    accountPool: pool,
    product: ZCODE,
  }) as LlmAdapter
  return new GenericImpl({
    id: 'zcode',
    displayName: 'ZCode (智谱)',
    capabilities: { login: true, dailyCheckin: false, balance: false, permanentLock: false, multiAccount: true, refresh: false },
    adapter, pool, gateway,
    loginImpl: async () => {
      const id = `zcode-${shortId()}`
      const refName = `ZCODE_ACCOUNT_${shortId().toUpperCase()}`
      await pool.addAccount({ id, provider: 'zcode', nickname: id, enabled: true, credentialRef: refName, refreshable: false, createdAt: Date.now() })
      const started = await auth.startLogin({ refName })
      if (started.loginUrl === undefined) {
        await pool.removeAccount(id).catch(() => {})
        throw new Error('无法启动 ZCode 登录（授权 URL 为空）')
      }
      started.result.then(async (r) => {
        gateway.credentials.set(refName, JSON.stringify(r.credential))
        await pool.updateAccount(id, {
          nickname: r.credential.account_label && r.credential.account_label.length > 0 ? r.credential.account_label : id,
          refreshable: false,
        })
        gateway.logger.info(`账号 ${id} 登录成功`)
      }).catch(async (e) => {
        await pool.removeAccount(id).catch(() => {})
        gateway.logger.warn(`账号 ${id} 登录失败:`, e)
      })
      return { loginUrl: started.loginUrl, accountId: id, completed: Promise.resolve({ ok: true }) }
    },
    refreshAll: async () => {
      // 静态凭据：无续期。空实现。
    },
  })
}

// ─────────────────────────── Gemini（Cloud Code Assist） ───────────────────────────

/**
 * Gemini Code Assist（Google Antigravity 客户端协议）。
 *
 * 与其它家的差异：
 *   - **OAuth 授权码流程**（`startLogin` 返回 loginUrl，用户在浏览器里同意；
 *     回调由插件内置的本地 HTTP 服务承接）。⚠️ 该流程需要 `GEMINI_DEFAULT_CLIENT_ID`
 *     / `..._SECRET`，它们**已从 vendor 中清空**（上游硬编码的 Google OAuth 凭据会被
 *     GitHub Push Protection 拒绝推送，见 sync-vendor.sh 的 ④c 步）。
 *     故**未设环境变量时登录会失败**——这是有意为之：凭据由使用者提供。
 *     设置 `CMDC_PAK_GOOGLE_CLIENT_ID` / `CMDC_PAK_GOOGLE_CLIENT_SECRET` 即可启用。
 *   - 需要先探测 project 号（`loadCodeAssist`），适配器内部已处理并有跨请求缓存。
 *   - 无每日签到；额度查询走 `retrieveUserQuotaSummary`。
 */
/**
 * 把 Gemini 的 Google OAuth 凭据注入**进程环境变量**。
 *
 * ## 为什么需要（真实故障，2026-10-14 用户报障）
 *
 * 上游 `gemini-oauth.ts` 原本硬编码了 `GEMINI_DEFAULT_CLIENT_ID/SECRET`，但那是
 * **GitHub Push Protection 会拦下的密钥**（GH013：Google OAuth Client ID +
 * Secret），会让整个仓库推不上去。故本仓库同步 vendor 时把它清成了空串
 * （见 `scripts/sync-vendor.sh` 的 ④c 步）。
 *
 * 清空的后果：授权 URL 拼出 `client_id=`（空），Google 直接回
 * **`Missing required parameter: client_id`** —— 登录页打不开。
 * 而 DSH 插件侧用的是未清空的版本，所以插件能登录、网关不能（现象即用户截图）。
 *
 * ## 做法：注入环境变量，而不是改 vendor
 *
 * `geminiClientId()` / `geminiClientSecret()` 本来就是**env 优先**的设计
 * （`process.env.CMDC_PAK_GOOGLE_CLIENT_ID` → 兜底常量）。所以我们只需在
 * 构造 Auth 之前把值写进 `process.env`，**vendor 一行都不用改** ——
 * 与 loomy 的 AccessKey 同一套「凭据不进仓库」的思路。
 *
 * 取值顺序（先到先用）：
 *  1. 已存在的环境变量（用户自己设的，不动它）
 *  2. `<数据目录>/gemini.env`（`KEY=VALUE` 行，未跟踪）
 *
 * 两处都没有时**不报错**：保持未配置状态，登录时 Google 会回一个明确错误；
 * 而 provider 的其它能力（模型目录等）不受影响。
 */
async function loadGeminiOAuthCredentials(dataDir: string): Promise<{ configured: boolean }> {
  if ((process.env.CMDC_PAK_GOOGLE_CLIENT_ID ?? '').trim().length > 0) {
    return { configured: true }
  }
  const envPath = resolve(dataDir, 'gemini.env')
  try {
    const values = new Map<string, string>()
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq <= 0) continue
      const key = trimmed.slice(0, eq).trim()
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
      if (key.length > 0) values.set(key, value)
    }
    const id = values.get('CMDC_PAK_GOOGLE_CLIENT_ID') ?? ''
    const secret = values.get('CMDC_PAK_GOOGLE_CLIENT_SECRET') ?? ''
    if (id.length === 0 || secret.length === 0) return { configured: false }
    // ⚠️ 写进 process.env 而不是传参：`geminiClientId()` 只认环境变量（vendor 设计）。
    process.env.CMDC_PAK_GOOGLE_CLIENT_ID = id
    process.env.CMDC_PAK_GOOGLE_CLIENT_SECRET = secret
    return { configured: true }
  } catch {
    // 文件不存在 / 不可读：视为未配置（不阻断 provider 初始化）。
    return { configured: false }
  }
}

export async function createGeminiProvider(
  dataDir: string,
  logLevel?: 'debug' | 'info' | 'warn' | 'error',
): Promise<Provider> {
  const { gateway, pool } = await makeBase('gemini', dataDir, logLevel)

  // ⚠️ **必须在任何请求之前**装好按 host 分流的路由器：Gemini 的推理请求用的是
  //    裸全局 `fetch`（适配器里没有 fetch 注入点），只能从全局 dispatcher 下手。
  //    真实故障（2026-10-14）：关掉 TUN 后 Gemini 全部无响应 —— Google 域名在此
  //    网络环境不可直连，必须走代理；而其余 15 家直连更快，故只对 Google 域名分流。
  {
    const { installGeminiProxyRouting } = await import('../core/gemini-proxy.js')
    const proxyUrl = installGeminiProxyRouting(dataDir)
    if (proxyUrl === undefined) {
      gateway.logger.warn(
        'Gemini 未配置代理出口：若无法直连 Google（常见于国内网络），请求会超时。'
        + `请设置环境变量 GATEWAY_GEMINI_PROXY=http://127.0.0.1:7897，`
        + `或在 ${resolve(dataDir, 'gemini.env')} 写一行 PROXY=http://127.0.0.1:7897。`,
      )
    } else {
      gateway.logger.info(`Gemini 出口已配置：仅 Google 域名经 ${proxyUrl}，其余直连`)
    }
  }

  const { GeminiAuth } = await import('../../vendor/src/gemini-auth.js')
  const { GeminiAdapter } = await import('../../vendor/src/gemini-adapter.js')
  const { GEMINI } = await import('../../vendor/src/gemini.js')
  const { fetchGeminiCreditBalance } = await import('../../vendor/src/gemini-credits.js')
  // ⚠️ 必须在构造 Auth **之前**注入：`geminiClientId()` 只认环境变量。
  const { configured: geminiConfigured } = await loadGeminiOAuthCredentials(dataDir)
  if (!geminiConfigured) {
    gateway.logger.warn(
      'Gemini 未配置 Google OAuth 凭据：登录会失败（Google 报 Missing required parameter: client_id）。'
      + `请在 ${resolve(dataDir, 'gemini.env')} 写入 CMDC_PAK_GOOGLE_CLIENT_ID / CMDC_PAK_GOOGLE_CLIENT_SECRET 两行，`
      + '或设置同名环境变量。',
    )
  }
  const auth = new GeminiAuth(gateway.ctx as never, { product: GEMINI })

  /**
   * ⚠️ project 探测缓存**必须由接线侧长期持有**（适配器注释明确要求）：
   * 每次调用现造等于没有跨请求缓存，每轮推理都会多打一次 `loadCodeAssist`。
   */
  const projectCache = new Map<string, string>()

  /**
   * **动态模型目录**（2026-10-15）。
   *
   * 上游静态表只有 1 个模型（`gemini-3.8-flash`），而实测账号真正可用 15 个
   * （含 `claude-sonnet-4-6` / `claude-opus-4-6-thinking`，经 Google 网关转发）。
   * 这里优先用落盘缓存；缓存缺失时适配器退回静态表，等用户点「重拉模型目录」
   * 触发联网拉取 + 可用性探测。
   *
   * ⚠️ 必须**同步**可读（适配器的 `loadModels()` 是同步方法）⇒ 缓存读在
   *    构造前做一次、存进闭包变量，而不是在回调里 await。
   */
  let catalogModels: readonly GeminiCatalogModel[] = []
  try {
    const { readCatalogCache } = await import('../core/gemini-catalog.js')
    catalogModels = readCatalogCache(dataDir) ?? []
    if (catalogModels.length > 0) {
      gateway.logger.info(`Gemini 动态目录：已载入 ${catalogModels.length} 个模型（本地缓存）`)
    }
  } catch (error) {
    gateway.logger.warn('Gemini 目录缓存读取失败，将使用静态表:', error)
  }

  /**
   * ⚠️⚠️ **探测期的"先有鸡还是先有蛋"**（真实缺陷，2026-10-15，写完即被实测抓住）：
   *
   * `loadModels()` 是**同步**方法，它既决定「暴露哪些模型」也决定
   * 「门控放行哪些模型」（`geminiModelSpec` 的 allowed 来自它）。
   * 若只在拉取成功后才把新目录写进去，那么**探测阶段**门控拿到的还是旧表
   * （首次运行时只有静态表的 1 个），于是 14 个候选**全部被自己的门控拒绝**：
   *
   *     Gemini 模型 claude-sonnet-4-6 探测失败，已剔除:
   *       gemini: 模型 "claude-sonnet-4-6" 不在本 provider 目录中（仅支持 gemini-3.8-flash）
   *     → Gemini 目录已更新：1 个可用模型（候选 14 个）
   *
   * 修法：把目录做成**可变引用**，探测前先写入候选全集（放行门控），
   * 探测后再收窄为实测可用的集合。
   */
  /**
   * ⚠️⚠️ **`thoughtSignature` 缓存必须提供**（真实缺陷，2026-10-15，用户报障）。
   *
   * **症状**：带工具的会话第二轮起必然 400 ——
   * ```
   * Function call is missing a thought_signature in functionCall parts.
   * This is required for tools to work correctly …
   * Additional data, function call `default_api:skill`, position 6.
   * ```
   *
   * **根因**：适配器的注释写明「未提供 `sigStore` 则**每轮都不带签名**」，
   * 而我们的接线**从来没传过它**（上游插件用 `createGeminiSigStore(ctx)` 建，
   * 我们的网关没有 DSH 的 `ctx.jetHubHome`，故直接 `new` 即可）。
   *
   * 上游对思考型模型校验 `functionCall` 上的签名：响应里带的签名要按
   * 「工具名 + 规范化参数」记下来，下一轮回传历史时按同一个键回填。
   * 没有缓存 ⇒ 第二轮的历史 functionCall 缺签名 ⇒ 400。
   *
   * ⚠️ 落盘路径用**网关自己的数据目录**（`<dataDir>/gemini-sigs.json`），
   *    不用 `resolveJetHubHome`（那是 DSH home，网关没有）。
   *    落盘的意义：进程重启后签名不丢，否则长任务跨重启仍会 400。
   */
  const geminiSigStore = new (await import('../../vendor/src/gemini-sigstore.js')).GeminiSigStore(
    resolve(dataDir, 'gemini-sigs.json'),
    { warn: (message: string) => gateway.logger.warn(message) },
  )

  const adapter = new GeminiAdapter({
    credentialRef: credentialRef(GEMINI.defaultCredentialRef),
    // ⚠️ 工具调用的签名缓存（缺它 = 带工具的第二轮必然 400，见上）。
    sigStore: geminiSigStore as never,
    // ⚠️ 始终注入（即使是空数组也没关系）：探测期需要它作为可变的放行名单。
    //    为空时 `geminiModelSpec` 会退回「只允许静态表模型」的旧行为。
    modelsProvider: () => catalogModels,
    resolveCredential: async (modelId?: string) => {
      const available = await pool.getAvailableAccount('gemini', modelId ?? '')
      if (available) return available.credential as never
      const raw = gateway.credentials.get(GEMINI.defaultCredentialRef)
      try { return raw === undefined ? undefined : JSON.parse(raw) } catch { return undefined }
    },
    refresh: async () => {
      const available = await pool.getAvailableAccount('gemini', '')
      if (available) {
        await auth.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
      } else {
        await auth.refresh()
      }
    },
    accountPool: pool,
    product: GEMINI,
    projectCache,
    logger: { warn: (message: string) => gateway.logger.warn(message) },
  }) as LlmAdapter

  return new GenericImpl({
    id: 'gemini',
    displayName: 'Gemini (Google)',
    capabilities: {
      login: true, dailyCheckin: false, balance: true,
      permanentLock: false, multiAccount: true, refresh: true,
    },
    adapter, pool, gateway,
    loginImpl: async () => {
      const id = `gemini-${shortId()}`
      const refName = `GEMINI_ACCOUNT_${shortId().toUpperCase()}`
      await pool.addAccount({
        id, provider: 'gemini', nickname: id, enabled: true,
        credentialRef: refName, refreshable: false, createdAt: Date.now(),
      })
      try {
        // ⚠️ 未配置 OAuth 凭据时**提前给出可行动的报错**。
        //    否则会走完整个流程、由 Google 回一个 `Missing required parameter:
        //    client_id` 页面，用户完全不知道要去改哪里（真实报障 2026-10-14）。
        if (!geminiConfigured) {
          await pool.removeAccount(id).catch(() => {})
          throw new Error(
            'Gemini 未配置 Google OAuth 凭据，无法发起授权。'
            + `请在网关数据目录的 gemini.env 写入 CMDC_PAK_GOOGLE_CLIENT_ID 与 `
            + 'CMDC_PAK_GOOGLE_CLIENT_SECRET 两行（可参考 DSH 插件的取值），然后重启网关。',
          )
        }
        // gemini.startLogin 不带 pool：result 是凭据本体，要自己 persist（同 raccoon）。
        const started = await auth.startLogin()
        started.result.then(async (credential) => {
          // ⚠️ persistLogin 只返回 `{ accountId? }`（没有 expires/refreshable）——
          //    与 raccoon 的 persistLogin 形状不同，别照抄。
          //    Gemini 凭据含 refresh_token 时才算可续期，用它决定 refreshable。
          await auth.persistLogin(credential, { refName })
          const refreshable = typeof credential.refresh_token === 'string' && credential.refresh_token.length > 0
          await pool.updateAccount(id, {
            refreshable,
            // 展示名优先用邮箱（`sub` 是 21 位数字，拼出来用户认不出）。
            ...(typeof credential.email === 'string' && credential.email.length > 0
              ? { nickname: credential.email }
              : {}),
          })
          gateway.logger.info(`账号 ${id} 登录成功`)
        }).catch(async (e) => {
          await pool.removeAccount(id).catch(() => {})
          gateway.logger.warn(`账号 ${id} 登录失败:`, e)
        })
        return { loginUrl: started.loginUrl, accountId: id, completed: Promise.resolve({ ok: true }) }
      } catch (error) {
        // ⚠️ 凭据未配置时 startLogin 会抛错（见函数头）。清掉占位账号，
        //    避免留下一个永远登录不成的幽灵账号。
        await pool.removeAccount(id).catch(() => {})
        const hint = '（提示：Gemini 需要设置 CMDC_PAK_GOOGLE_CLIENT_ID / CMDC_PAK_GOOGLE_CLIENT_SECRET）'
        throw new Error(`${error instanceof Error ? error.message : String(error)}${hint}`)
      }
    },
    refreshAll: async () => {
      await auth.refreshAll(pool)
    },

    /**
     * 「重拉模型目录」：从上游 `fetchAvailableModels` 拉取 + **逐个探测可用性**。
     *
     * ⚠️ 为什么必须探测：上游对**已下线的模型**返回 **HTTP 200**，正文是一句
     *    `"… is no longer available …"`。只看状态码会把 3 个废弃模型
     *    （实测 `gemini-3-flash-agent` / `gemini-3.5-flash-low` /
     *     `gemini-3.5-flash-extra-low`）当可用暴露出去，用户选中才发现拿不到答案。
     *
     * ⚠️ 探测成本：每个候选一次真实推理（约 1–3s），19 个候选约 20–60s。
     *    故结果**落盘缓存**，只在用户显式点「重拉」时才跑。
     */
    refreshModelsImpl: async () => {
      const [{ fetchAvailableModels, writeCatalogCache, looksDeprecated }, { GEMINI_ENDPOINTS }] =
        await Promise.all([
          import('../core/gemini-catalog.js'),
          import('../../vendor/src/gemini.js') as Promise<{ GEMINI_ENDPOINTS: readonly string[] }>,
        ])
      // 取一条可用凭据（第一个启用的账号）。
      const accounts = (await pool.listAccounts('gemini')).filter((a) => a.enabled)
      const account = accounts[0]
      if (account === undefined) throw new Error('Gemini 没有已启用的账号，无法拉取目录')
      const raw = gateway.credentials.get(account.credentialRef)
      if (raw === undefined) throw new Error('Gemini 凭据缺失，请重新登录')
      const credential = JSON.parse(raw) as { access_token?: string; cloudaicompanionProject?: string }
      const accessToken = credential.access_token ?? ''
      if (accessToken.length === 0) throw new Error('Gemini 凭据无 access_token，请重新登录')

      let candidates: readonly GeminiCatalogModel[] = []
      for (const endpoint of GEMINI_ENDPOINTS) {
        candidates = await fetchAvailableModels({ accessToken, project: credential.cloudaicompanionProject, endpoint })
        if (candidates.length > 0) break
      }
      if (candidates.length === 0) throw new Error('上游未返回可用模型列表（端点或凭据可能已变）')

      // ⚠️ **先把候选全集写进目录**，否则下面的探测会被自己的门控拒绝
      //    （见 adapter 构造处那段"先有鸡还是先有蛋"的注释）。
      catalogModels = candidates

      /**
       * 逐个探测可用性。
       *
       * ⚠️⚠️ **必须直连上游，不能走 `adapter.stream()`**（真实缺陷，2026-10-15，
       * 实测抓到）：`stream()` 会经 `resolveCredential` → `getAvailableAccount`，
       * 而后者在**每次都失败**时会**把该模型写进账号的限流标记**。
       * 于是探测本身把账号打上 12 个模型的限流标记，后续候选全部被自己的
       * 限流机制拒绝 —— 日志里表现为连 `claude-sonnet-4-6` 这种**明明可用**的
       * 模型也报"所有账号均不可用（限流或额度耗尽）"，最终只剩 2 个。
       *
       * 探测只是问"这个模型名上游认不认"，与账号池选号无关 ⇒ 直接用凭据打
       * 上游，**不碰账号池**（自然也不产生任何标记）。
       */
      const { translateGeminiRequest, consumeGeminiSse } = await import('../../vendor/src/gemini-messages.js')
      const { geminiHeaders, newGeminiRequestId } = await import('../../vendor/src/gemini.js')
      const project = credential.cloudaicompanionProject ?? 'aicode-consumers'
      const usable: GeminiCatalogModel[] = []
      for (const model of candidates) {
        try {
          /**
           * ⚠️⚠️ **档位后缀是"按模型族"决定的，不能统一加**（真实缺陷，2026-10-15，
           * 实测把 11 个可用模型误判成 404）。
           *
           * 逐名实测的对照表：
           *
           * | 模型 | 裸名 | 加 `-medium` |
           * |---|---|---|
           * | `gemini-3.8-flash` | ❌ 404 | ✅ **必须带后缀** |
           * | `gpt-oss-120b` | ❌ 404 | ✅ **必须带后缀** |
           * | `claude-sonnet-4-6` | ✅ **裸名可用** | ❌ 404 |
           * | `claude-opus-4-6-thinking` | ✅ **裸名可用** | — |
           * | `gemini-3-flash` | ✅ **裸名可用** | ❌ 404 |
           * | `gemini-2.5-flash` | ✅ **裸名可用** | ❌ 404 |
           *
           * 故策略：**先裸名、失败再试 `-medium`**（两个都不行才剔除）。
           * 每条探测最多两次请求，但正确性远比省一次请求重要。
           */
          const candidateNames = [model.id, `${model.id}-medium`]
          let text = ''
          let probed = false
          /** 实测哪个名字成功 ⇒ 据此决定"是否要档位后缀"（见 needsEffortSuffix）。 */
          let usedSuffix: boolean | undefined
          for (const upstream of candidateNames) {
            // ⚠️ `thinkingBudget` 必须**小于** `maxTokens`（上游硬要求，Antigravity
            //    API 文档明示 "maxOutputTokens must be GREATER than thinkingBudget"）。
            const envelope = translateGeminiRequest({
              modelId: model.id,
              spec: { upstream, tier: 'medium', thinkingBudget: 2000, includeThoughts: true },
              messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply exactly: OK' }] }],
              project,
              sessionLane: 'probe',
              requestId: newGeminiRequestId(),
              maxTokens: 8192,
            } as never)
            const response = await fetch(`${GEMINI_ENDPOINTS[0]}/v1internal:streamGenerateContent?alt=sse`, {
              method: 'POST',
              headers: geminiHeaders(credential as never),
              body: JSON.stringify(envelope),
              signal: AbortSignal.timeout(30_000),
            })
            if (!response.ok) {
              await response.text().catch(() => '')
              continue
            }
            const body = response.body
            if (body === null) continue
            probed = true
            for await (const chunk of consumeGeminiSse({ body }) as AsyncIterable<{ type?: string; text?: string }>) {
              if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
              if (text.length > 200) break
            }
            if (!looksDeprecated(text)) {
              // 记下成功的形式：裸名成功 ⇒ 不需要后缀；`-medium` 成功 ⇒ 需要。
              usedSuffix = upstream !== model.id
              break
            }
            // 命中"已下线"文案：换下一个名字也没用，直接标记不可用。
            probed = false
            break
          }
          if (!probed) {
            gateway.logger.info(`Gemini 模型 ${model.id} 不可用（裸名与档位名均失败或已下线），已剔除`)
            continue
          }
          // ⚠️ 把实测出的"是否需要后缀"写回目录条目 —— 适配器拼 upstream 时按它决定，
          //    否则 claude / gemini-2.5 系会被拼上后缀而 404。
          usable.push({ ...model, needsEffortSuffix: usedSuffix ?? true })
        } catch (error) {
          gateway.logger.warn(`Gemini 模型 ${model.id} 探测失败，已剔除:`, error)
        }
      }

      if (usable.length === 0) throw new Error('全部候选模型都探测失败，保留原目录')
      catalogModels = usable
      writeCatalogCache(dataDir, usable)
      gateway.logger.info(`Gemini 目录已更新：${usable.length} 个可用模型（候选 ${candidates.length} 个）`)
      return { count: usable.length }
    },

    /**
     * 额度读数：与 DSH 插件面板同口径（**两个配额窗口 + 账号规格**）。
     *
     * ## 为什么不能用通用的 `sumBalances`
     *
     * `sumBalances` 只把各家读数**累加成一个数字**，而 Gemini 的额度是
     * **双窗口**（5 小时 / 周），每个窗口都有"已用百分比 + 剩余量"两个维度。
     * 累加会丢掉窗口语义 —— 用户最需要知道的恰是"哪个窗口快满了"。
     * 故直接返回完整 `BalanceView`（`sumBalances` 支持 `{ view }` 形态），
     * 窗口逐条放进 `items`。
     *
     * ⚠️ **账号规格（tier）在 `BalanceView` 里无处安放**（没有 tier 字段），
     * 而 `items[].name` 是自由文本 ⇒ 把档位作为一条只读附注放进 items
     * （`remain: 0`）。这比丢掉它好：DSH 面板能看到"账号规格 Free"，
     * 本网关也应能看到。
     */
    queryBalance: async () => {
      const accounts = (await pool.listAccounts('gemini')).filter((a) => a.enabled)
      if (accounts.length === 0) return undefined

      let total = 0
      const items: NonNullable<BalanceView['items']> = []
      let got = false

      for (const account of accounts) {
        const raw = gateway.credentials.get(account.credentialRef)
        if (raw === undefined) continue
        let credential: unknown
        try { credential = JSON.parse(raw) } catch { continue }
        try {
          // ⚠️ 本函数**不抛错**（vendor 契约）：未授权时返回
          //    `{ balance: null, error: '尚未授权 Google 账号' }`。
          const result = await fetchGeminiCreditBalance(credential as never, GEMINI)
          got = true
          if (result.balance === null) {
            // 未授权/查不到：如实记一条（不静默跳过，否则用户只看到"无数据"）。
            items.push({ name: `${account.nickname}：${result.error ?? '查不到额度'}`, remain: 0, note: true })
            continue
          }
          for (const pkg of result.balance.packages ?? []) {
            // ⚠️ `CreditPackage` **没有 `expireAt`**（那是别的 provider 的字段名）：
            //    它的失效时间是 `deductionEndTime`（毫秒，实测才是"何时作废"的真相源
            //    —— `expiredTime` 只在包**真正失效后**才由服务端回填，见 credits.ts 长注释）。
            //    未激活的包如实标注，避免用户以为那些额度还能用。
            const suffix = pkg.active ? '' : '（已失效）'
            items.push({
              name: `${account.nickname} · ${pkg.name}${suffix}`,
              remain: pkg.remaining,
              ...(typeof pkg.deductionEndTime === 'number' && pkg.deductionEndTime > 0
                ? { expireAt: pkg.deductionEndTime }
                : {}),
            })
          }
          if (result.tier !== undefined) {
            // `GeminiAccountTier` 有 `label` 字段（'Free' / 'Pro' / 'Ultra'），
            // 正是 DSH 面板"账号规格"那一栏的取值。
            items.push({ name: `${account.nickname} · 账号规格 ${result.tier.label}`, remain: 0, note: true })
          }
          total += result.balance.total
        } catch (error) {
          gateway.logger.warn(`账号 ${account.id} 额度查询失败:`, error)
        }
      }

      if (!got) return undefined
      // ⚠️ `unit: 'percent'`：Gemini 的额度是**剩余百分比**（上游的
      //    `GEMINI_QUOTA_UNIT` 就是 `'%'`），不是积分。写成 `credits`
      //    会让前端显示「100 积分」——用户会以为有 100 积分可用。
      return { total, unit: 'percent', items, at: Date.now() }
    },
  })
}

// ─────────────────────────── OpenCode（Zen） ───────────────────────────

/**
 * OpenCode Zen 通道。
 *
 * ## 与其它家的根本差异：**匿名可用**
 *
 * 它有一个凭据为字面量 `public` 的**匿名通道**（`OPENCODE.anonymousKey`），
 * 服务端认它作免费通道 —— **无需登录、无需 API Key 就能调 7 个免费模型**
 * （`big-pickle` / `space-bunny-free` / `nemotron-*` 等）。
 * 但**收费模型必须用真实 API Key**（匿名送付费模型必然 401/403，
 * 适配器的 `pickSlot` 已按此规则跳过匿名槽）。
 *
 * 故本 provider 的 `loginImpl` 与其它家不同：**不跳转授权页、不扫码**，
 * 直接建一条匿名账号即可用；想用收费模型则需在别处（插件侧）登录后把
 * 真实 Key 填进账号。
 *
 * ## 多身份槽（指纹隔离）
 *
 * 每条账号会被派生成一个「身份槽」（`listIdentitySlots`），带各自的
 * project 指纹（匿名槽用**条目 id** 派生，避免多条匿名通道指纹相同）。
 * 指纹用于上游的项目级隔离；`generation` 变更即轮换指纹。
 *
 * ## 代理
 *
 * 凭据里可带 `proxy` 字段（每条账号独立出口 IP）。空/非法一律**降级为直连**
 * 而非报错（适配器注释明确：用户临时填错地址不该让整个 provider 停摆）。
 */
export async function createOpencodeProvider(
  dataDir: string,
  logLevel?: 'debug' | 'info' | 'warn' | 'error',
): Promise<Provider> {
  const { gateway, pool } = await makeBase('opencode', dataDir, logLevel)
  const { OpencodeAdapter } = await import('../../vendor/src/opencode-adapter.js')
  const { OPENCODE } = await import('../../vendor/src/opencode-product.js')
  const { listIdentitySlots, ensureDefaultAnonymousSlot } = await import('../../vendor/src/opencode-auth.js')

  /**
   * 组装身份槽：读账号池 → 解析各自凭据 → 交给 `listIdentitySlots`。
   *
   * ⚠️ 每次都现读（不缓存）：用户在界面上停用/新增账号后应立即生效，
   *    缓存会让开关看起来失灵。
   */
  const identitySlots = async () => {
    const entries = await pool.listAccounts('opencode')
    const snapshots = entries.map((entry) => {
      const raw = gateway.credentials.get(entry.credentialRef)
      let parsed: { api_key?: unknown; proxy?: unknown } = {}
      try { parsed = raw === undefined ? {} : JSON.parse(raw) } catch { parsed = {} }
      return {
        id: entry.id,
        enabled: entry.enabled,
        apiKey: typeof parsed.api_key === 'string' ? parsed.api_key : '',
        ...(typeof parsed.proxy === 'string' && parsed.proxy.length > 0 ? { proxy: parsed.proxy } : {}),
      }
    })
    return listIdentitySlots(snapshots, OPENCODE.defaultUserAgent)
  }

  const adapter = new OpencodeAdapter({
    identitySlots,
    warn: (message: string) => gateway.logger.warn(message),
    // 限流回调：把上游给的解禁时刻写回该槽（账号）的模型标记。
    markLimited: async (slotId: string, modelId: string, resetAtMs: number) => {
      await pool.updateModelRateLimit(slotId, modelId, resetAtMs).catch(() => {})
    },
    // ⚠️ 2026-10-24 上游把「黑名单 / 关闭意图」收敛进共享骨架
    //    （`model-catalog.ts` 从 `accountPool` 读走），`disabledModels` 回调
    //    **已删除**。这里不再传；传了是编译错误，且会重现「同一语义两套判据」。
    //    上游明确要求：不要把它加回来。
  }) as LlmAdapter

  return new GenericImpl({
    id: 'opencode',
    displayName: 'OpenCode (Zen)',
    capabilities: {
      login: true, dailyCheckin: false, balance: false,
      permanentLock: false, multiAccount: true, refresh: false,
    },
    adapter, pool, gateway,
    loginImpl: async () => {
      // ⚠️ opencode 的主用法是**填 API Key**（上游不给授权页），故这里返回
      //    `input` 让前端弹输入框；真正的建号在 `submitLoginImpl` 里做。
      //
      //    匿名通道（`api_key: 'public'`）仍保留为一条**快捷路径**，但注意：
      //    上游已封禁匿名免费推理（实测 403 FreeTierError），故不再作为主入口，
      //    仅通过 `submitLoginImpl` 接受空值时的显式分支创建。
      return {
        loginUrl: '',
        accountId: '',
        completed: Promise.resolve({ ok: true }),
        input: {
          placeholder: '粘贴 OpenCode API Key（sk- 开头）',
          hint: '在 opencode.ai 的 workspace 里生成。留空则创建匿名通道（仅目录可用，上游已封禁其推理）。',
        },
      }
    },

    /**
     * 收到用户填的 Key → 建号并写凭据。
     *
     * 空值 = 显式要匿名通道（保留该路径，但界面上已说明它调不通）。
     */
    submitLoginImpl: async ({ value }) => {
      const key = value.trim()
      const anonymous = key.length === 0
      if (!anonymous && !key.startsWith('sk-')) {
        return { ok: false, error: 'OpenCode 的 Key 应以 sk- 开头，请检查是否复制完整' }
      }
      const id = `opencode-${anonymous ? 'anon' : 'key'}-${shortId()}`
      const refName = `OPENCODE_${anonymous ? 'ANON' : 'KEY'}_${shortId().toUpperCase()}`
      await pool.addAccount({
        id, provider: 'opencode',
        nickname: anonymous ? '匿名通道' : `Key ...${key.slice(-6)}`,
        enabled: true,
        credentialRef: refName,
        // 匿名通道没有可续期凭据（标 true 是不实承诺）；API Key 也无续期端点。
        refreshable: false,
        createdAt: Date.now(),
      })
      await gateway.credentials.set(refName, JSON.stringify({
        api_key: anonymous ? OPENCODE.anonymousKey : key,
        nickname: anonymous ? '匿名通道' : 'API Key',
      }))
      gateway.logger.info(`账号 ${id} 已创建（${anonymous ? '匿名通道' : 'API Key'}）`)
      return { ok: true }
    },
    refreshAll: async () => {
      // 匿名通道无可续期凭据；真实 API Key 亦无续期端点。空实现。
    },
  })
}

// ─────────────────────────── Accio（阿里） ───────────────────────────

/**
 * Accio（阿里）—— PKCE 授权码登录 + 免签名推理。
 *
 * ⚠️ **新接入、未充分实测**（上游 2026-10-13 才合并）。默认 `enabled: false`。
 *
 * 与其它家的差异：
 *   1. OAuth PKCE：`startLogin` 返回授权页 URL，本地回调服务器接 code 换令牌；
 *   2. 区域：`'cn'`（www.accio-ai.com）/ `'global'`（zh.accio.com），
 *      只影响**登录页域名**，推理 gateway 两区域相同；
 *   3. `utdid`：设备标识。上游**不校验**（实测自造值同样 200），
 *      有 `~/.accio/utdid` 时用真值，否则用适配器的进程内兜底值。
 */
export async function createAccioProvider(
  dataDir: string,
  logLevel?: 'debug' | 'info' | 'warn' | 'error',
): Promise<Provider> {
  const { gateway, pool } = await makeBase('accio', dataDir, logLevel)
  const { AccioAuth, ACCIO_CREDENTIAL_REF } = await import('../../vendor/src/accio-auth.js')
  const { AccioAdapter } = await import('../../vendor/src/accio-adapter.js')
  const { ACCIO } = await import('../../vendor/src/accio-product.js')
  const { fetchAccioQuota } = await import('../../vendor/src/accio-credits.js')

  const auth = new AccioAuth(gateway.ctx as never)

  /** 读 `~/.accio/utdid`（有则用真值，无则由适配器用兜底值）。 */
  const readUtdid = (): string | undefined => {
    try {
      const value = readFileSync(resolve(homedir(), '.accio', 'utdid'), 'utf8').trim()
      return value.length > 0 ? value : undefined
    } catch {
      return undefined
    }
  }
  const utdid = readUtdid()

  const adapter = new AccioAdapter({
    resolveCredential: async (modelId?: string) => {
      const available = await pool.getAvailableAccount('accio', modelId ?? '')
      if (available) return available.credential as never
      const raw = gateway.credentials.get(ACCIO_CREDENTIAL_REF)
      try { return raw === undefined ? undefined : JSON.parse(raw) } catch { return undefined }
    },
    refresh: async () => {
      // ⚠️ 按**账号池里的 ref** 续期（与 qoder/trae 同一教训：默认 ref ≠ 池内 ref）。
      const available = await pool.getAvailableAccount('accio', '')
      if (available) {
        await auth.refreshAccountCredential(available.entry.credentialRef, pool, available.entry.id)
      } else {
        await auth.refreshAll(pool)
      }
    },
    accountPool: pool,
    product: ACCIO,
    ...(utdid !== undefined ? { utdid } : {}),
  }) as LlmAdapter

  return new GenericImpl({
    id: 'accio',
    displayName: 'Accio (阿里)',
    capabilities: {
      login: true, dailyCheckin: false, balance: true,
      permanentLock: false, multiAccount: true, refresh: true,
    },
    adapter, pool, gateway,
    loginImpl: async () => {
      const id = `accio-${shortId()}`
      const refName = `ACCIO_ACCOUNT_${shortId().toUpperCase()}`
      await pool.addAccount({
        id, provider: 'accio', nickname: id, enabled: true,
        credentialRef: refName, refreshable: false, createdAt: Date.now(),
      })
      const started = await auth.startLogin({ pool, accountId: id, refName })
      started.result.then(async () => {
        await pool.updateAccount(id, { refreshable: true, nickname: `Accio ${id.slice(-6)}` })
        gateway.logger.info(`账号 ${id} 登录成功`)
      }).catch(async (e) => {
        // ⚠️ 失败删占位条目，否则留下「永远登录不成的幽灵账号」。
        await pool.removeAccount(id).catch(() => {})
        gateway.logger.warn(`账号 ${id} 登录失败:`, e)
      })
      return { loginUrl: started.loginUrl, accountId: id, completed: Promise.resolve({ ok: true }) }
    },
    refreshAll: async () => { await auth.refreshAll(pool) },
    // ⚠️ `AccioQuota` 只有 `usagePercent` / `refreshCountdownSeconds`，
    //    **没有总额字段**（与其它家的积分桶不同）⇒ 本家不提供余额读数。
  })
}

// ─────────────────────────── OfficeAce（果办） ───────────────────────────

/**
 * OfficeAce（果办）—— 华为 MaaS 云端直连。
 *
 * ⚠️ **新接入、未充分实测**。默认 `enabled: false`。
 *
 * 与其它家的差异：
 *   1. **无独立登录 UI**：凭据从果办客户端自己的会话文件读
 *      （`~/.dsh-officeace/session.json`，由上游 `officeace-auth.ts` 维护）。
 *      即「先在果办客户端登录过，本 provider 才可用」；
 *   2. **多模态**：部分模型支持图片输入（实测表在 `OFFICEACE_MODELS`）；
 *   3. **签到**：上游 auth 模块**不导出**签到函数（签到在 DSH 插件的 RPC 层），
 *      故本网关如实返回 `unavailable`，不假装成功。
 */
export async function createOfficeAceProvider(
  dataDir: string,
  logLevel?: 'debug' | 'info' | 'warn' | 'error',
): Promise<Provider> {
  const { gateway, pool } = await makeBase('officeace', dataDir, logLevel)
  const { OfficeAceAdapter } = await import('../../vendor/src/officeace-adapter.js')
  const { readStoredCredential, refreshStoredCredential } = await import('../../vendor/src/officeace-auth.js')

  const adapter = new OfficeAceAdapter({
    // ⚠️ 每次现读（不缓存）：用户可能刚在果办客户端登录，缓存会让新凭据迟迟不生效。
    credentialProvider: async () => readStoredCredential(),
    // ⚠️ 续期**必须注入**（上游注释明确）：漏接的症状是账号永不过期、
    //    重新登录后旧凭据仍被沿用，且日志里一个字都没有。
    refresh: async () => { await refreshStoredCredential() },
    // ⚠️ 2026-10-24 上游迁移：`disabledModels` 回调已删除，改由共享骨架从
    //    `accountPool` 读取。这里传 `pool` 才能保留「关闭供应商 / 黑名单」语义。
    accountPool: pool,
  }) as LlmAdapter

  return new GenericImpl({
    id: 'officeace',
    displayName: 'OfficeAce (果办)',
    capabilities: {
      login: true, dailyCheckin: false, balance: false,
      permanentLock: false, multiAccount: false, refresh: true,
    },
    adapter, pool, gateway,
    loginImpl: async () => {
      // 无独立授权流程：凭据来自果办客户端会话文件。这里只登记一条账号条目。
      const existing = readStoredCredential()
      if (existing === undefined) {
        throw new Error(
          'OfficeAce 无独立登录：请先在果办客户端登录一次'
          + '（凭据由客户端写入 ~/.dsh-officeace/session.json），然后回本页点「刷新」。',
        )
      }
      const id = 'officeace-default'
      const accounts = await pool.listAccounts('officeace')
      if (!accounts.some((a) => a.id === id)) {
        await pool.addAccount({
          id, provider: 'officeace', nickname: '果办客户端会话', enabled: true,
          credentialRef: 'OFFICEACE_DEFAULT', refreshable: true, createdAt: Date.now(),
        })
      }
      return { loginUrl: '', accountId: id, completed: Promise.resolve({ ok: true }) }
    },
    refreshAll: async () => { await refreshStoredCredential() },
    checkin: async () => ({
      ok: false, status: 'unavailable',
      message: 'OfficeAce 签到由 DSH 插件侧执行，本网关不提供',
    } as never),
  })
}

// ─────────────────────────── AI Studio（API Key）───────────────────────────

/**
 * AI Studio 供应商：用普通 **API Key**（`AIza…`）调 Gemini。
 *
 * ## 与现有两个 Gemini 系渠道的区别（三者额度池互不相同）
 *
 * | 渠道 | 认证 | 额度池 | 需浏览器 |
 * |---|---|---|---|
 * | `gemini`（反重力） | OAuth（Google 账号） | Antigravity 额度 | 否 |
 * | **`aistudio`**（本函数） | **API Key** | **API Key 免费层** | **否** |
 * | `build` | 宿主页代劳 | Build 独立额度 | **是** |
 *
 * ⇒ 本渠道门槛最低：一个 `AIza…` 密钥即可，不需要 OAuth、不用开浏览器。
 *
 * ## ⚠️ 必须走代理
 *
 * Google 域名在本机网络环境**不可直连**（实测 `daily-cloudcode-pa`：直连超时
 * 15s、经 Clash 0.8s）。本渠道用全局裸 `fetch`，由 `gemini-proxy.ts` 的
 * host 路由拦截器接管（`*.googleapis.com` 已在其匹配列表），故这里只需
 * **安装该拦截器**（与反重力渠道同一个）。
 */
export async function createAiStudioProvider(
  dataDir: string,
  logLevel?: 'debug' | 'info' | 'warn' | 'error',
): Promise<Provider> {
  const { gateway, pool } = await makeBase('aistudio', dataDir, logLevel)
  const { AiStudioAdapter, AISTUDIO_MODELS } = await import('./aistudio-adapter.js')

  // 装代理路由（与 gemini 渠道共用同一个按 host 分流的拦截器）。
  {
    const { installGeminiProxyRouting } = await import('../core/gemini-proxy.js')
    const proxyUrl = installGeminiProxyRouting(dataDir)
    if (proxyUrl === undefined) {
      gateway.logger.warn(
        'AI Studio 未配置代理出口：Google 域名在国内网络不可直连，请求会超时。'
        + '请设置 GATEWAY_GEMINI_PROXY=http://127.0.0.1:7897，'
        + `或在 ${dataDir}/gemini.env 写一行 PROXY=http://127.0.0.1:7897。`,
      )
    } else {
      gateway.logger.info(`AI Studio 出口已配置：仅 Google 域名经 ${proxyUrl}，其余直连`)
    }
  }

  /**
   * 取当前可用账号的 API Key（**每次现读**，多账号**轮询**）。
   *
   * ⚠️ 不缓存：用户在界面停用/新增账号后应立刻生效，缓存会让开关看起来失灵
   *    （opencode 的 identitySlots 同样处理）。
   * ⚠️ 轮询而非固定取第一个：免费层额度**按 Key 独立**计算，轮询能把多份
   *    额度都利用起来。
   */
  let cursor = 0
  const apiKey = async (): Promise<string | undefined> => {
    const entries = await pool.listAccounts('aistudio')
    const usable = entries.filter((entry) => entry.enabled)
    if (usable.length === 0) return undefined
    const start = cursor % usable.length
    cursor = (cursor + 1) % usable.length
    for (let offset = 0; offset < usable.length; offset++) {
      const entry = usable[(start + offset) % usable.length]!
      const raw = gateway.credentials.get(entry.credentialRef)
      if (raw === undefined) continue
      try {
        const parsed = JSON.parse(raw) as { api_key?: unknown }
        const key = typeof parsed.api_key === 'string' ? parsed.api_key.trim() : ''
        if (key.length > 0) return key
      } catch {
        // 凭据损坏：跳过该账号（不因一个坏条目让整渠道失效）。
      }
    }
    return undefined
  }

  const adapter = new AiStudioAdapter({
    apiKey,
    warn: (message: string) => gateway.logger.warn(message),
  }) as LlmAdapter

  return new GenericImpl({
    id: 'aistudio',
    displayName: 'AI Studio (API Key)',
    capabilities: {
      login: true, dailyCheckin: false, balance: false,
      permanentLock: false, multiAccount: true, refresh: false,
    },
    adapter, pool, gateway,
    loginImpl: async () => ({
      loginUrl: '',
      accountId: '',
      completed: Promise.resolve({ ok: true }),
      input: {
        placeholder: '粘贴 AI Studio API Key（AIza… 或 AQ.… 开头）',
        hint: '在 https://aistudio.google.com/apikey 创建。'
          + 'AIza…（标准 Key）与 AQ.…（授权 Key，2026-05 起默认）都支持。',
      },
    }),
    submitLoginImpl: async ({ value }) => {
      const key = value.trim()
      if (key.length === 0) return { ok: false, error: '请粘贴 API Key' }
      // ⚠️ 前缀校验是最有价值的一道防线：实测 OAuth token 与 `AQ.` 凭据都在
      //    调用时以 401 `ACCESS_TOKEN_TYPE_UNSUPPORTED` 失败，用户很难从那
      //    个错误看出"是凭据类型不对"。
      // ⚠️ **不要按前缀拒绝**（这是先前的一个错误断言，已纠正）。
      //
      //    Google 官方文档（https://ai.google.dev/gemini-api/docs/api-key）：
      //      · **标准 Key**：`AIza…`
      //      · **授权 Key**：`AQ.…` —— 直接绑定 Cloud 服务账号，权限更细
      //      自 **2026-05-28** 起，AI Studio 新建的 Key **默认就是授权 Key**。
      //      Gemini API 已**拒绝无限制的标准 Key**。
      //
      //    ⇒ 新用户的 Key 很可能就是 `AQ.` 开头，按 `AIza` 硬拦会把
      //      **当代的合法 Key 全部拒之门外**（用户实测报障："我的 key 是 AQ 开头"）。
      //
      //    故只在明显不像 Key 时提示（例如含空白、过长过短、是我们已知的
      //    OAuth access token 形态 `ya29.`）：
      if (key.startsWith('ya29.')) {
        return {
          ok: false,
          error: '这是 OAuth access token（ya29. 开头），不是 API Key。'
            + '请在 https://aistudio.google.com/apikey 创建 API Key（AIza… 或 AQ.… 开头）',
        }
      }
      if (/\s/.test(key)) {
        return { ok: false, error: 'Key 里含有空白字符，请检查是否复制完整/多粘贴了' }
      }
      const id = `aistudio-key-${shortId()}`
      const refName = `AISTUDIO_KEY_${shortId().toUpperCase()}`
      await pool.addAccount({
        id, provider: 'aistudio',
        nickname: `Key ...${key.slice(-6)}`,
        enabled: true,
        credentialRef: refName,
        refreshable: false,
        createdAt: Date.now(),
      })
      await gateway.credentials.set(refName, JSON.stringify({ api_key: key }))
      gateway.logger.info(`账号 ${id} 已创建（API Key）`)
      return { ok: true }
    },
    refreshAll: async () => {
      // API Key 无过期/续期概念。
    },
  })
}
