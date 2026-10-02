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

  constructor(init: {
    id: string
    displayName: string
    capabilities: ProviderCapabilities
    adapter: LlmAdapter
    pool: AccountPool
    gateway: GatewayContext
    loginImpl: (nickname?: string) => Promise<LoginStart>
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
  }

  async startLogin(nickname?: string): Promise<LoginStart> {
    return this.loginImpl(nickname)
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
