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

  const adapter = new GeminiAdapter({
    credentialRef: credentialRef(GEMINI.defaultCredentialRef),
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
            items.push({ name: `${account.nickname}：${result.error ?? '查不到额度'}`, remain: 0 })
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
            items.push({ name: `${account.nickname} · 账号规格 ${result.tier.label}`, remain: 0 })
          }
          total += result.balance.total
        } catch (error) {
          gateway.logger.warn(`账号 ${account.id} 额度查询失败:`, error)
        }
      }

      if (!got) return undefined
      return { total, unit: 'credits', items, at: Date.now() }
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
    disabledModels: () => new Set(), // 黑名单由账号池侧统一处理（与其它家一致）
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
    disabledModels: () => new Set(),
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
