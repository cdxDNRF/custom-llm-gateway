/**
 * MiniMax Code 认证服务。
 *
 * 登录走 **OAuth 设备码 + PKCE**（见 `minimax-oauth.ts`），
 * 续期走 `refresh_token` grant。
 *
 * ⚠️ **`refreshAll` 只按 `refreshable` 过滤，不看 `enabled`**
 * （AGENTS.md「续期不得按 enabled 过滤」的真实缺陷教训）。
 */

import { Service } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Context } from '@deepseek-ai/cordis'
import type { AccountPool } from './account-pool.js'
import {
  refreshAccountWithReconcile,
  type ExpiryAccessors,
} from './expiry-sync.js'
import {
  MINIMAX,
  MINIMAX_MODELS_PATH,
  MINIMAX_REQUEST_TIMEOUT_MS,
  type MinimaxProduct,
} from './minimax-product.js'
import { fetchMinimaxUserIdentity } from './minimax-identity.js'
import {
  inheritMinimaxIdentity,
  fallbackToEntry,
  isMinimaxRefreshable,
  minimaxCredentialExpiresAtMs,
  describeMinimaxGeoRoute,
  minimaxFetch,
  minimaxHeaders,
  minimaxHeadersFor,
  normalizeMinimaxModel,
  type MinimaxCredential,
  type MinimaxModelEntry,
} from './minimax.js'
import {
  pollMinimaxDeviceToken,
  refreshMinimaxCredential,
  startMinimaxDeviceAuthorization,
  fetchMinimaxForcedLoginUrl,
  type MinimaxDeviceAuthorization,
} from './minimax-oauth.js'

/**
 * 过期信息提取器（供共享实现 `refreshAccountWithReconcile` 用）。
 *
 * ⚠️ `identityOf` 的语义是「**凭据内容**」（这里是 access_token）而**不是** ref 名
 * —— 传 ref 名会恒匹配失败且**静默无报错**（`src/expiry-sync.ts` 记录的坑）。
 *
 * ⚠️ `refreshableOf` 提供时共享实现会据此写池里的 `refreshable`。
 * MiniMax **确实有** refresh 端点，故提供它是**诚实**的
 *（与 Loomy 相反 —— 那边恒 false 故刻意不提供）。
 */
export const MINIMAX_EXPIRY_ACCESSORS: ExpiryAccessors<MinimaxCredential> = {
  expiresAtOf: (credential) => minimaxCredentialExpiresAtMs(credential),
  refreshableOf: (credential) => isMinimaxRefreshable(credential),
  identityOf: (credential) => credential.access_token,
}

/** refresh_token 已失效，需要重新登录。 */
export class MinimaxRefreshTokenExpiredError extends Error {
  constructor(message: string) {
    super(message)
    // ⚠️ `name` **必须**是 `'RefreshTokenExpiredError'`（真实缺陷，2026-09-29 修正）。
    //
    // `src/refresh.ts` 的终态判据是结构化比较：
    //   `if (error.name === 'RefreshTokenExpiredError') return true`
    //   `return /refresh[_ ]?token/i.test(error.message)`
    //
    // 早期这里写 `'MinimaxRefreshTokenExpiredError'` ⇒ 第一个分支**恒不命中**，
    // 只能靠第二个分支的**文案正则**兜底。而 `refresh()` 里
    // 「凭据未配置，请先登录」不含 `refresh_token` ⇒ 一旦走到那里，
    // `RefreshScheduler` 会把它当成**可重试**错误而**无限重试**。
    // 文案一改即静默退化，极难排查。
    //
    // 八个既有 provider 的同类类**一律**用 `'RefreshTokenExpiredError'`
    // （`cline-auth.ts`、`qoder-auth.ts`、`lobsterai-auth.ts`、
    // `loomy-auth.ts`、`raccoon-auth.ts`、`trae-auth.ts`、
    // `buddy-oauth.ts`、`oauth.ts`）—— 本 provider 不应破例。
    // 之所以能跨模块这样判，是因为判据是**字符串**而非 `instanceof`
    //（各模块的同名类是不同 identity，`instanceof` 会穿透）。
    this.name = 'RefreshTokenExpiredError'
  }
}

/** 解析凭据 JSON；形状不对返回 undefined（不抛错）。 */
export function parseMinimaxCredential(value: string): MinimaxCredential | undefined {
  try {
    const parsed = JSON.parse(value) as MinimaxCredential
    return typeof parsed === 'object' && parsed !== null
      && typeof parsed.access_token === 'string' && parsed.access_token.length > 0
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/** 认证服务选项。 */
export interface MinimaxAuthOptions {
  /** 产品配置；默认 {@link MINIMAX}。 */
  product?: MinimaxProduct
  /** 服务名覆盖（默认由产品 id 派生为 `minimaxAuth`）。 */
  serviceName?: string
  /** 注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch
  /**
   * 按**账号 id** 取该账号的出口（MiniMax 国际站代理支持）。
   *
   * ## 为什么要有它
   *
   * `agent.minimax.io` 按**出口 IP 国别**分流，大陆来源恒被 307 到中国站 ⇒
   * 报出与「凭据失效」**逐字同形**的 401（issue IKMEVG）。既有的
   * `X-Forwarded-For` 只是**声明**一个海外 IP，真正换出口要靠代理。
   *
   * ⚠️ 优先级：`fetchImpl`（单测替身）> `fetchFor(accountId)`（生产代理）>
   * 全局 `fetch`。与 `GeminiAuth` 的同名字段**逐字同构**（同一份判据，只换
   * 产品语义）。
   *
   * ⚠️ 只在**国际站实例**上注入（中国站直连才是最优，出海反而更慢且可能被
   * 引到国际站）。未注入时本字段 `undefined` ⇒ `fetcherFor()` 恒走既有路径，
   * **行为逐字节不变**。
   */
  fetchFor?: (accountId: string) => typeof fetch
  /** 注入的 sleep（测试用）。 */
  sleep?: (ms: number) => Promise<void>
}

/** 登录流程句柄。 */
export interface StartedMinimaxLoginFlow {
  /** 用户点开的授权链接（**含 user_code**）。 */
  loginUrl: string
  /**
   * 「保证走一遍登录」的链接（**可能为 undefined**）。
   *
   * ## 为什么登录链接需要两个版本（2026-10-24，用户报障「一打开就自带旧 session」）
   *
   * `loginUrl` 里的 `user_code` **不含身份**，身份全在浏览器 cookie ⇒ 用已有
   * 会话的浏览器打开就直接复用旧账号（上游不认任何 `prompt=*` 强制参数，实测）。
   * 本字段是上游「切换账号」按钮的等价物：`/unified-login?login_redirect=<授权页>`，
   * 由 {@link fetchMinimaxForcedLoginUrl} 用**无 cookie** 的服务端请求换来，
   * 登录完自动回到授权页放行**新**账号。
   *
   * ⚠️ 它**不依赖**无痕窗口能力 ⇒ 在「手机/远端浏览器经隧道访问、宿主没有你的
   * 浏览器」这种部署里，这是**唯一**生效的路径。
   * ⚠️ 可选字段：拿不到时调用方退回 {@link loginUrl}（行为与从前逐字节相同）。
   */
  forcedLoginUrl?: string
  /** 授权完成后的凭据。 */
  result: Promise<MinimaxCredential>
  /** 放弃本次登录。 */
  close: () => void
}

/** MiniMax Code 认证服务。 */
export class MinimaxAuth extends Service {
  /** 本实例所属的产品配置。 */
  readonly product: MinimaxProduct
  /** 本实例默认读写的凭据 ref 名称。 */
  readonly credentialRefName: string

  private lastRefreshError: string | undefined

  constructor(ctx: Context, private readonly options: MinimaxAuthOptions = {}) {
    const product = options.product ?? MINIMAX
    super(ctx, options.serviceName ?? `${product.id}Auth`)
    this.product = product
    this.credentialRefName = product.defaultCredentialRef
  }

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch
  }

  /**
   * 取**某个账号**该走的 fetcher（MiniMax 国际站代理支持）。
   *
   * ⚠️⚠️ **必须按账号现取，不能在构造/循环外固化**：本类在一轮流程里可能换号
   * （目录取号走 `getAvailableAccount`、续期按 ref 逐个走），出口必须跟着换 ——
   * 固化一份会让「换了号却仍走旧账号的出口」，症状是「配了代理还是被分流」
   * 且**零报错**，属最难查的一类静默失效。
   *
   * ⚠️ 优先级：`fetchImpl`（单测替身）> `fetchFor(accountId)`（生产代理）>
   * 全局 `fetch`。未注入 `fetchFor`（中国站实例 / 旧接线）⇒ 恒走既有路径，
   * **行为逐字节不变**。
   *
   * ⚠️ 空账号 id（`''`）= 直连：`fetchFor` 的解析器按「空 id = 没配代理」处理
   * （见 `minimax-proxy.ts`）—— 拿不到账号时不该去查一个空 id。
   */
  private fetcherFor(accountId: string): typeof fetch {
    if (this.options.fetchImpl !== undefined) return this.options.fetchImpl
    if (this.options.fetchFor !== undefined) return this.options.fetchFor(accountId)
    return fetch
  }

  /** 申请设备码（供 RPC 提前拿到 loginUrl）。 */
  async fetchDeviceAuthorization(accountId?: string): Promise<MinimaxDeviceAuthorization> {
    return startMinimaxDeviceAuthorization(this.fetcherFor(accountId ?? ''), this.product)
  }

  /**
   * 两步式登录：**立即**返回 `loginUrl`，后台轮询。
   *
   * ⚠️ 不能在这里阻塞等授权完成 —— 前端 `window.open` 只在
   * transient activation 窗口内有效（见 AGENTS.md「两步式登录」）。
   *
   * @param options.accountId 本次登录**将要落在哪个账号条目上**（可选）。
   *
   * ## ⚠️⚠️ 为什么登录也必须知道账号 id（换 token 的那一步要出海）
   *
   * 设备码申请与轮询换 token 都发生在**凭据落盘之前**，此时凭据还在内存里、
   * 账号池里也**只有那条占位条目**认得这个账号 ⇒ 代理只能按 `accountId`
   * 从池里读（`minimaxIntlProxy`）。不带 ⇒ 国际站在大陆网络下**登录恒失败**，
   * 而用户**没法给一个还不存在的账号配代理**（面板的「代理」按钮按
   * `accountId` 打开）⇒ **死锁**（与 Gemini 的 IKLTZ2 审计 P2-1 同型）。
   *
   * 触发路径很常见：refresh_token 失效时面板明示的既定动作就是「删号重登」，
   * 而重登造的是**全新 id** ⇒ 旧号上的代理配置必然丢失。
   *
   * ⚠️ 不传时是空串 = 直连，与既有行为**逐字节一致**（`fetcherFor('')`）。
   */
  async startLogin(options: { accountId?: string } = {}): Promise<StartedMinimaxLoginFlow> {
    const auth = await this.fetchDeviceAuthorization(options.accountId)
    let aborted = false
    const controller = new AbortController()
    const result = pollMinimaxDeviceToken(auth, {
      fetcher: this.fetcherFor(options.accountId ?? ''),
      ...this.options.sleep === undefined ? {} : { sleep: this.options.sleep },
      signal: controller.signal,
      product: this.product,
    })
    // 与 `cline-auth.ts` 同理：结果可能早于调用方 `await` 而落定，
    // 先挂空处理器避免「未处理的拒绝」告警（错误仍会传给真正的消费者）。
    //
    // ⚠️ 本例**必然**会走到这里：`close()` → `controller.abort()` →
    // `pollMinimaxDeviceToken` 里的 `options.signal?.throwIfAborted()`
    // 会 reject（用户关掉登录弹窗就是这条路径）。缺这一句时，
    // 若调用方在 `await result` 之前就放弃，Node 会报 `unhandledRejection`。
    result.catch(() => {})
    /**
     * ⚠️⚠️ 2026-10-24：**额外**去换一条「保证需要登录」的链接。
     *
     * 用户报障：「登录链接一打开就自带旧 session 登录态」。`loginUrl` 的
     * `user_code` 不含身份、身份全在浏览器 cookie；上游不认 `prompt=*`，
     * 但它的「切换账号」按钮走 `/oauth2/device/authorize`（无 cookie ⇒
     * `401 login_required` + `login_url`）⇒ 服务端已替我们拼好「登录完回到授权页」。
     *
     * ⚠️ 它**不消耗任何凭据**（纯 GET、无 `Authorization`），可安全地在每次
     * 「新建账号」时调用 —— 本仓库有过「诊断请求烧掉 refresh_token」的事故。
     * ⚠️ 该函数**永不抛错**（失败退回本地兜底；再失败返回 undefined）。
     */
    const forcedLoginUrl = await fetchMinimaxForcedLoginUrl(auth, this.fetchImpl, this.product)
    return {
      loginUrl: auth.verificationUriComplete,
      ...forcedLoginUrl === undefined ? {} : { forcedLoginUrl },
      result,
      close: () => {
        aborted = true
        controller.abort()
      },
    }
  }

  /**
   * 落盘凭据（登录成功后调用）。
   *
   * ⚠️ 返回 `accountId` 供调用方构造展示名。
   *
   * ## ⚠️⚠️ 2026-10-23（Gitee IKP8UA）：这里**补查一次账号身份**
   *
   * MiniMax 的 `access_token` **不是 JWT**（`mmoat_` 前缀、60 字符、0 个点），
   * 登录响应体也**不含任何身份字段** ⇒ 原昵称判据（`decodeJwtSub`）恒 undefined
   * ⇒ 账号卡片恒显示插件内部 id（`minimax-6395cf64`），多账号无法分辨。
   *
   * ⇒ 落盘前查一次 `GET /v1/api/user/info`（见 `minimax-identity.ts`），
   *   把读到的 `name` 写进**凭据**（供自愈路径读）并**返回**给调用方写进账号池。
   *
   * ## 为什么收口在这里，而不是 RPC 分支
   *
   * 登录路径与**启动自愈**（`repairAccountNicknames`）都要身份 —— 若只写在 RPC
   * 那一段，自愈就得再写一份（「同一语义两套判据」）。收口在凭据落盘处，
   * 两条路径共用一份实现。
   *
   * ## 三条纪律
   *
   * 1. **查不到不影响登录**：身份是展示信息，失败一律 `undefined`
   *    （与 qoder 的 `fetchQoderUserNickname` 同原则）；
   * 2. **显式传入的 `nickname` 优先**（调用方可能有更权威的来源）；
   * 3. **国际站必须带池里的 XFF**：`agent.minimax.io` 对大陆出口恒 307 到
   *    `agent.minimaxi.com`，跨 origin 跟随会剥掉 `Authorization` ⇒ 401
   *    （真机实测：无 XFF 时国际站身份**永远**拿不到）。
   *
   * @param options.accountId 落盘到**哪个账号条目**（可选，供代理取出口）。
   *   ⚠️ 它是唯一能让「换 token 之后的身份查询」走对出口的来源 —— 此刻凭据
   *   刚落盘、按凭据反查账号 id 那条路还没建立（与 `startLogin` 同因）。
   */
  async persistLogin(
    credential: MinimaxCredential,
    options: { refName: string; nickname?: string; accountId?: string },
  ): Promise<{ accountId?: string; nickname?: string; userId?: string }> {
    // ⚠️ 与 `fetchModels` 同一份 XFF 取法（`typeof` 判一下：单测/旧接线可能传
    //    只实现部分方法的池替身，直接 `.minimaxXff()` 会抛 TypeError）。
    const pool = this.ctx.accountPool
    const xff = typeof pool?.minimaxXff === 'function' ? pool.minimaxXff() : undefined
    // ⚠️ 查不到（含抛错、401、非 JSON、空 name）一律 `undefined`，不阻塞登录。
    const identity = options.nickname === undefined
      ? await fetchMinimaxUserIdentity(
          credential,
          this.fetcherFor(options.accountId ?? ''),
          this.product,
          xff,
        )
      : undefined
    const nickname = options.nickname ?? identity?.name

    const payload: MinimaxCredential = {
      ...credential,
      ...nickname === undefined ? {} : { nickname },
      // ⚠️ 稳定身份必须落进凭据 —— 它是「同账号去重」的**唯一**判据
      //    （`account.create` 的 minimax 分支按它查 `findAccountIdByIdentityField`）。
      //    `identity.userId` 一直拿得到（`GET /v1/api/user/info` 的 `userID`），
      //    但此前**只用来拼昵称、随后被丢弃** ⇒ 去重无从下手。
      ...identity?.userId === undefined ? {} : { user_id: identity.userId },
    }
    await this.ctx.credentials.set(credentialRef(options.refName), JSON.stringify(payload))
    this.lastRefreshError = undefined
    return {
      ...credential.account_id === undefined ? {} : { accountId: credential.account_id },
      ...nickname === undefined ? {} : { nickname },
      ...identity?.userId === undefined ? {} : { userId: identity.userId },
    }
  }

  /** 解析默认单凭据。 */
  private async resolveDefaultCredential(): Promise<MinimaxCredential | undefined> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName))
    if (!resolved) return undefined
    return parseMinimaxCredential(resolved.value)
  }

  /**
   * 续期**默认单凭据**。
   *
   * ⚠️⚠️ **这是第 5 条续期路径，且必须同样继承身份**（2026-10-25 合并审计）：
   * PR !147 声称「收口在**唯一**出口 `refreshCredentialFor`」，但本方法在生产上
   * **可达**（`src/index.ts` 的 `getAvailableAccount()` 返回空时就走这里 ——
   * 而「返回空」正是去重把两张卡都停用后的形态），且它此前直接
   * `set(refreshMinimaxCredential(...))` ⇒ `nickname` / `user_id` **双双消失**
   * （实测：续期后落盘只剩令牌五件套）。后果是 IKP8UA（昵称退回内部 id）+
   * 去重失去唯一判据，**每 30 分钟一轮**，必然复现。
   *
   * ⇒ 与 `refreshCredentialFor` 共用同一个纯函数 `inheritMinimaxIdentity`。
   */
  async refresh(): Promise<void> {
    const credential = await this.resolveDefaultCredential()
    if (credential === undefined) {
      throw new MinimaxRefreshTokenExpiredError('凭据未配置，请先登录')
    }
    if (!isMinimaxRefreshable(credential)) {
      throw new MinimaxRefreshTokenExpiredError('凭据缺少 refresh_token，请重新登录')
    }
    try {
      const refreshed = await refreshMinimaxCredential(
        credential.refresh_token as string,
        this.fetchImpl,
        this.product,
      )
      // ⚠️ 与 `refreshCredentialFor` **同一份**继承判据（同义判据分两处必然漂移）。
      const next = inheritMinimaxIdentity(refreshed, credential)
      await this.ctx.credentials.set(credentialRef(this.credentialRefName), JSON.stringify(next))
      this.lastRefreshError = undefined
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.lastRefreshError = message
      throw error
    }
  }

  /**
   * 续期**指定 ref**（RPC `account.refresh` / 定时器）。
   *
   * ⚠️ 只读写传入的 ref，**不碰**默认单凭据 ref。
   * ⚠️ **走共享实现 `refreshAccountWithReconcile`** —— 它保证「凭据仍有效」时
   * 也把池值对账（见 `refreshAll` 的注释）。
   */
  async refreshAccountCredential(
    refName: string,
    pool?: AccountPool,
    accountId?: string,
  ): Promise<void> {
    const ref = credentialRef(refName)
    const resolved = await this.ctx.credentials.resolve(ref)
    if (!resolved) throw new Error('凭据未配置')
    const credential = parseMinimaxCredential(resolved.value)
    if (!credential) throw new Error('凭据解析失败')
    if (!isMinimaxRefreshable(credential)) {
      throw new MinimaxRefreshTokenExpiredError('凭据缺少 refresh_token，请重新登录')
    }
    // 无账号池时退化为「直接续期 + 落盘」（单凭据路径）
    if (pool === undefined) {
      const next = await this.refreshCredentialFor(credential, accountId)
      await this.ctx.credentials.set(ref, JSON.stringify(next))
      return
    }
    await refreshAccountWithReconcile({
      pool,
      provider: this.product.id,
      tag: `[${this.product.id}]`,
      accountId: accountId ?? '',
      credential,
      accessors: MINIMAX_EXPIRY_ACCESSORS,
      refresh: (c) => this.refreshCredentialFor(c, accountId),
      save: (c) => this.ctx.credentials.set(ref, JSON.stringify(c)),
      warn: (message) => this.ctx.logger?.warn?.(message),
      info: (message) => this.ctx.logger?.info?.(message),
    })
  }

  /**
   * 批量续期：**只按 `refreshable` 过滤，不看 `enabled`**。
   *
   * ⚠️ **必须走共享实现 `refreshAccountWithReconcile`**（`src/expiry-sync.ts`），
   * **不要**手写对账逻辑。九个既有 provider 里**八个**都用它
   *（buddy / cline / lobsterai / qoder / service / trae / loomy / raccoon 的部分路径）；
   * 手写版本会在「凭据仍有效」的分支漏掉池值对账，导致 UI **永远**显示「已过期」
   * —— 那正是 `src/expiry-sync.ts` 模块注释记录的真实缺陷。
   *
   * 照 `src/cline-auth.ts` 的 `refreshAll` 形态（它是最规范的一份）。
   */
  async refreshAll(pool: AccountPool): Promise<void> {
    const accounts = await pool.listAccounts(this.product.id)
    for (const entry of accounts) {
      // ⚠️ 判据只看 refreshable，不看 enabled
      if (!entry.refreshable) continue
      try {
        const ref = credentialRef(entry.credentialRef)
        const resolved = await this.ctx.credentials.resolve(ref)
        if (!resolved) {
          await pool.updateAccount(entry.id, { refreshable: false })
          continue
        }
        const credential = parseMinimaxCredential(resolved.value)
        if (!credential || !isMinimaxRefreshable(credential)) {
          await pool.updateAccount(entry.id, { refreshable: false })
          continue
        }
        await refreshAccountWithReconcile({
          pool,
          provider: this.product.id,
          tag: `[${this.product.id}]`,
          accountId: entry.id,
          credential,
          accessors: MINIMAX_EXPIRY_ACCESSORS,
          current: entry,
          refresh: (c) => this.refreshCredentialFor(c, entry.id),
          save: (c) => this.ctx.credentials.set(ref, JSON.stringify(c)),
          warn: (message) => this.ctx.logger?.warn?.(message),
        })
      } catch (error) {
        if (error instanceof MinimaxRefreshTokenExpiredError) {
          try {
            await pool.updateAccount(entry.id, { refreshable: false })
          } catch {
            // 忽略 updateAccount 本身的错误
          }
          this.ctx.logger?.warn?.(
            `[minimax] 账号 ${entry.id} 的 refresh_token 已失效，已标记为不可续期（需重新登录）`,
          )
        } else {
          // 非终态失败（网络抖动、5xx…）**必须留下日志** ——
          // 静默失败会让账号在 UI 上仍显示「可续期」却永远刷不动，无从排查。
          this.ctx.logger?.warn?.(
            `[minimax] 账号 ${entry.id} 续期失败：`
            + `${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    }
  }

  /**
   * 续期给定凭据（供 `refreshAccountWithReconcile` 的 `refresh` 回调）。
   *
   * ⚠️ **不落盘** —— 落盘由共享实现的 `save` 回调负责。
   *
   * @param accountId 该凭据属于哪个账号（可选，供代理取出口）。
   *   ⚠️ 与推理路径同因：国际站的续期端点也在 `agent.minimax.io` 上，
   *   大陆出口直连会 307 ⇒ 续期恒失败而 UI 只显示「已过期」。
   */
  async refreshCredentialFor(
    credential: MinimaxCredential,
    accountId?: string,
  ): Promise<MinimaxCredential> {
    if (!isMinimaxRefreshable(credential)) {
      throw new MinimaxRefreshTokenExpiredError('凭据缺少 refresh_token，请重新登录')
    }
    let refreshed: MinimaxCredential
    try {
      refreshed = await refreshMinimaxCredential(
        credential.refresh_token as string,
        this.fetcherFor(accountId ?? ''),
        this.product,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/invalid_grant|expired|revoked/i.test(message)) {
        throw new MinimaxRefreshTokenExpiredError('refresh_token 已失效，请重新登录')
      }
      throw error
    }
    /**
     * ⚠️⚠️ 续期**必须继承**身份字段（2026-10-24）。
     *
     * `parseMinimaxTokenGrant` 只构造令牌五件套（`access_token` / `refresh_token` /
     * `token_type` / `expires_at` / `scope`），**不认识** `nickname` / `user_id`；
     * 而续期结果会被整体覆盖落盘 ⇒ 每续期一次丢一次：`nickname` 丢了账号卡片退回
     * 内部 id（IKP8UA 复发），`user_id` 丢了**同账号去重失去唯一判据**。
     * 定时续期 30 分钟一轮、SELF_HEAL 还会补一次 ⇒ 这个丢失**必然发生**。
     *
     * ⚠️ 收口在**唯一**的续期出口（本方法）：本文件有 4 条续期路径，在各调用点
     *    分别补必然漏一处。
     */
    return inheritMinimaxIdentity(refreshed, credential)
  }

  /**
   * 拉取远端模型目录（给定凭据）。
   *
   * ⚠️ **测试专用入口**（无需账号池）：`fetchModels` 是它的薄包装。
   *
   * @param accountId 用**哪个账号**的出口（可选，供代理取）。
   */
  async fetchModelsWith(
    credential: MinimaxCredential,
    accountId?: string,
  ): Promise<readonly MinimaxModelEntry[]> {
    const raw = await this.fetchRawModels(credential, accountId)
    return raw ?? this.product.fallbackModels.map(fallbackToEntry)
  }

  /**
   * 拉取**裸**远端目录：拿到就是拿到，拿不到一律 `undefined`（**不**回退兜底表）。
   *
   * 这是全插件唯一一处真正解析远端模型目录的地方；两个公开入口的差别只在
   * 「拿不到时回吐什么」：
   * - {@link fetchModelsWith} / {@link fetchModels} ⇒ **展示侧**语义，回退兜底表；
   * - {@link fetchRemoteModelsOnly} ⇒ **接线侧**语义，回 `[]`。
   *
   * ⚠ 把这个区分做在**这里**（而不是让接线自己去比对结果与兜底表）是刻意的：
   * 兜底表内容可以被改写，若远端下发的恰好与兜底表相同，「比较内容」的判据会把
   * 一次成功的拉取误判为失败。只有「解析函数返回了几个条目」这个**内部事实**
   * 能可靠区分两者。
   *
   * @param accountId 用**哪个账号**的出口（可选，供代理取）。
   *   ⚠️ 目录端点也在 `agent.minimax.io` 上：大陆出口直连恒 307 ⇒ 整个
   *   provider 会从模型选择器里**消失**（issue IKMEVG 的另一症状面）。
   */
  private async fetchRawModels(
    credential: MinimaxCredential,
    accountId?: string,
  ): Promise<readonly MinimaxModelEntry[] | undefined> {
    try {
      const url = new URL(`${this.product.apiHost}${MINIMAX_MODELS_PATH}`)
      url.searchParams.set('region', this.product.region)
      url.searchParams.set('buildEnv', this.product.buildEnv)
      /**
       * ⚠️ **带传输级重试 + 保凭据跟随重定向**（两个真实缺陷的修法）。
       *
       * 传输级重试（2026-10-15）：「模型连接测试失败，显示 `fetch failed`」。
       * 本机实测环境里的 HTTPS 检查代理约 **50%** 概率打断到本家的请求
       *（`fetch failed ← SELF_SIGNED_CERT_IN_CHAIN`）⇒ 一次偶发中断就整轮失败。
       *
       * 保凭据跟随 3xx（2026-10-17，issue IKMEVG）：`agent.minimax.io` 恒 307 到
       * `agent.minimaxi.com`，而 fetch 跨 origin 跟随会**剥掉 `Authorization`**
       * ⇒ 第二跳无凭据 ⇒ 目录也拿不到（连带让 provider 在模型选择器里消失）。
       *
       * ⚠️ 两者合并在 `minimaxFetch` 一处，与推理 / 签到积分路径**共用同一份**
       *（`src/minimax.ts`）—— 本文件不另写判据（同义判据分两处必然漂移）。
       * `buildInit` 每跳重建头，保证跟随后的请求仍带凭据。
       *
       * ⚠️ 国际站另需附用户设置的 `X-Forwarded-For`（绕开 Akamai 按出口 IP
       * 的地理分流）。没有它，大陆出口的用户连目录都拿不到 ⇒ provider 在模型
       * 选择器里整个消失（这是本 issue 的另一个症状面）。
       */
      // ⚠️ 用 `typeof` 判一下：单测/旧接线可能传只实现部分方法的池替身，
      //    直接 `.minimaxXff()` 会在那种替身上抛 `TypeError`（`?.` 挡不住）。
      const pool = this.ctx.accountPool
      const xff = typeof pool?.minimaxXff === 'function' ? pool.minimaxXff() : undefined
      let geoRouted = false
      const response = await minimaxFetch(
        url.toString(),
        () => ({
          headers: minimaxHeadersFor(credential, xff, this.product.id),
          signal: AbortSignal.timeout(MINIMAX_REQUEST_TIMEOUT_MS),
        }),
        {
          fetcher: this.fetcherFor(accountId ?? ''),
          onGeoRoute: () => { geoRouted = true },
        },
      )
      if (!response.ok) {
        // ⚠️ 地理路由必须留**可操作**的日志：否则用户只看到「模型列表变空」，
        //    而真因（出口 IP 被判定为中国大陆）完全不可见。
        if (geoRouted) {
          this.ctx.logger?.warn?.(`[${this.product.id}] ${describeMinimaxGeoRoute()}`)
        }
        return undefined
      }
      const body: unknown = await response.json().catch(() => undefined)
      const entries = parseMinimaxModelsPayload(body)
      // ⚠️ 远端成功但解析出 0 条时也回退兜底表（避免空列表让整个 provider 消失）
      if (entries.length === 0) {
        // ⚠️ **必须留日志**：否则无法区分「远端坏了」与「远端返回 0 条」，
        // 两者都静默给出兜底表，排查时只知道「模型列表不对」却找不到原因。
        // 目录是展示信息，故仍不抛错（不该让整个 provider 报错）。
        this.ctx.logger?.warn?.(
          `[${this.product.id}] 远端模型目录解析出 0 条，已回退兜底表`,
        )
        return undefined
      }
      return entries
    } catch (error) {
      // ⚠️ 远端失败静默回退，但**必须留日志**（同上：否则无从排查）。
      this.ctx.logger?.warn?.(
        `[${this.product.id}] 远端模型目录获取失败，已回退兜底表：`
        + `${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
  }

  /** 拉取远端模型目录（账号池版本）。 */
  async fetchModels(pool?: AccountPool): Promise<readonly MinimaxModelEntry[]> {
    const picked = await this.resolveModelsCredential(pool)
    if (picked === undefined) return this.product.fallbackModels.map(fallbackToEntry)
    return this.fetchModelsWith(picked.credential, picked.accountId)
  }

  /**
   * 目录拉取用哪份凭据：账号池优先，其次插件自存的默认凭据。
   *
   * ⚠️ **同时返回账号 id**（代理支持）：目录端点也在 `agent.minimax.io` 上，
   * 国际站必须走该账号的出口才拿得到。单凭据回退时 id 是空串（= 直连），
   * 与既有行为一致。
   */
  private async resolveModelsCredential(
    pool?: AccountPool,
  ): Promise<{ credential: MinimaxCredential; accountId: string } | undefined> {
    if (pool !== undefined) {
      // ⚠ `getAvailableAccount` 返回 **`{ entry, credential }`**（两层），
      // **不是**「账号条目本身」—— 照抄既有 provider 的写法：
      // `const available = await pool.getAvailableAccount<MinimaxCredential>(id, ''); available?.credential`
      const available = await pool.getAvailableAccount<MinimaxCredential>(this.product.id, '')
      if (available) {
        return { credential: available.credential, accountId: available.entry.id }
      }
    }
    const credential = await this.resolveDefaultCredential()
    if (credential === undefined) return undefined
    return { credential, accountId: '' }
  }
  /**
   * 只取**真远端**目录；未登录 / 上游失败 / 解析出 0 条 ⇒ `[]`。
   *
   * ⚠ 与 {@link fetchModels} 的区别是**不回退兜底表**，专供适配器与本地桥使用。
   *
   * 为什么必须有这条：适配器判「这次拿到目录了吗」的判据是「返回空数组」。
   * 若接线用 `fetchModels()`（失败时回吐兜底表），那个判据**永不命中**
   * ⇒ 兜底表被当成远端结果写进 `remoteModels` 并永久缓存，用户登录 /
   * 网络恢复后**再也不会重拉**（连失败冷却都不会开），只能重启 DSH。
   * 「回退兜底表」这件事只应由**展示侧**（适配器）做一次。
   *
   * 日志语义与 {@link fetchModelsWith} 一致（失败 / 解析 0 条都留 warn），
   * 只是**不**把兜底表当结果返回。
   */
  async fetchRemoteModelsOnly(pool?: AccountPool): Promise<readonly MinimaxModelEntry[]> {
    const picked = await this.resolveModelsCredential(pool)
    if (picked === undefined) return []
    return (await this.fetchRawModels(picked.credential, picked.accountId)) ?? []
  }

  /**
   * ★★ **启动自愈：补齐存量账号的显示名**（Gitee issue IKP8UA 修法 ③）。
   *
   * ## 为什么必须有这条
   *
   * 只改登录路径**不会自愈存量账号** —— 用户已有的账号（本机实测 7 条）
   * 昵称早已是插件内部 id 且已落盘。不给这条腿，用户要**删号重登**才看得到真名。
   *
   * ## 形态照 `gemini-auth.ts` 的同名方法（那是本仓库最规范的一份）
   *
   * | 纪律 | 理由 |
   * |---|---|
   * | 逐账号 `try/catch` | 单账号失败不得拖住其余（本方法是启动期循环，一个挂住会连累后面全部） |
   * | **只在确实变化时**写池 | `updateAccount` 是整体 replace，每次启动都写 = 平白落盘 |
   * | 失败**不告警**（只用 debug） | 老账号 token 可能早已过期，拿不到是常态，不该刷 warn |
   * | 查不到就**保持原样** | 绝不退回用池 id 重算昵称（那是本 issue 的缺陷本身） |
   *
   * ⚠️ **国际站必须带池里的 XFF**：否则恒 307 → 401（真机实测），
   *    自愈对国际站账号将**永远**失败且看起来「和国内站一样在跑」。
   *
   * @returns 被修复的账号 id（供接线层记日志/计数）。
   */
  async repairAccountNicknames(pool: AccountPool): Promise<string[]> {
    const repaired: string[] = []
    let entries: Awaited<ReturnType<AccountPool['listAccounts']>>
    try {
      entries = await pool.listAccounts(this.product.id)
    } catch {
      // ⚠️ 读不到池绝不当成「没有账号」—— 但这是启动期的尽力而为，
      //    下一次启动还会重试，故这里只静默返回（不删任何东西）。
      return repaired
    }

    // ⚠️ 与 `fetchModels` / `persistLogin` **同一份** XFF 取法。
    const xffPool = this.ctx.accountPool
    const xff = typeof xffPool?.minimaxXff === 'function' ? xffPool.minimaxXff() : undefined

    for (const entry of entries) {
      try {
        const ref = credentialRef(entry.credentialRef)
        const resolved = await this.ctx.credentials.resolve(ref)
        if (!resolved) continue
        const credential = parseMinimaxCredential(resolved.value)
        if (credential === undefined) continue

        // 查一次身份（只读 GET；失败返回 undefined，不抛错）。
        // ⚠️ **走 `fetcherFor(entry.id)`**：国际站的用户信息端点也在
        //    `agent.minimax.io` 上，大陆出口直连会 307 ⇒ 401（真机实测）
        //    ⇒ 自愈对国际站账号恒失败且看起来「和国内站一样在跑」。
        const identity = await fetchMinimaxUserIdentity(
          credential,
          this.fetcherFor(entry.id),
          this.product,
          xff,
        )
        if (identity === undefined) {
          // 拿不到就保持原样（绝不退回用池 id 重算昵称 —— 那正是本 issue 的缺陷）。
          this.ctx.logger?.debug?.(
            `[${this.product.id}] 账号 ${entry.id} 补拉账号身份失败（昵称保持原样）`,
          )
          continue
        }

        // ⚠️ 只在**确实变化**时写：`updateAccount` 是整体 replace。
        if (identity.name !== entry.nickname) {
          await pool.updateAccount(entry.id, { nickname: identity.name })
          repaired.push(entry.id)
        }
        /**
         * 顺带把身份写进凭据（`persistLogin` 的读取侧约定见该方法注释）。
         *
         * ⚠️⚠️ **必须连 `user_id` 一起补写**（2026-10-25 合并审计打穿）：
         * 改前这里只写 `nickname`，而 `identity.userId` **就在手上**却被丢掉 ⇒
         * 存量凭据（PR 之前登录的）永远没有 `user_id` ⇒ `account.create` 的
         * 同账号去重**永不命中**（`findAccountIdByIdentityField` 对缺失字段是
         * **跳过**，不是「不匹配」）⇒ 一个号仍可无限建卡、各持一份 token。
         *
         * 这条自愈是**唯一**能给存量账号补身份的地方：`persistLogin` 只写新账号，
         * `inheritMinimaxIdentity` 只能继承「已有的」，救不了「从来没有的」。
         * 本机三份 `MINIMAX_ACCOUNT_*` 凭据实测**零份**带 `user_id` ⇒ 不是边角情况。
         */
        const needsNicknameBackfill = (credential as { nickname?: string }).nickname !== identity.name
        const needsUserIdBackfill = identity.userId !== undefined
          && (credential as { user_id?: string }).user_id !== identity.userId
        if (needsNicknameBackfill || needsUserIdBackfill) {
          await this.ctx.credentials.set(
            ref,
            JSON.stringify({
              ...credential,
              nickname: identity.name,
              ...identity.userId === undefined ? {} : { user_id: identity.userId },
            }),
          )
        }
      } catch (error) {
        // 单账号失败不得中断其余（与 gemini 同纪律）。
        this.ctx.logger?.debug?.(
          `[${this.product.id}] 修复账号 ${entry.id} 的显示名失败（不影响使用）：`
          + `${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return repaired
  }
}

/**
 * 解析远端目录响应。
 *
 * 校验（照 asar `parseSnapshot`）：`providers[]` 含 `providerId === 'minimax'`、
 * `config.models` 是非空对象；逐条经 {@link normalizeMinimaxModel} 归一。
 */
export function parseMinimaxModelsPayload(payload: unknown): readonly MinimaxModelEntry[] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return []
  const providers = (payload as Record<string, unknown>).providers
  if (!Array.isArray(providers)) return []
  const minimax = providers.find(
    (p): p is Record<string, unknown> =>
      typeof p === 'object' && p !== null && (p as Record<string, unknown>).providerId === 'minimax',
  )
  if (minimax === undefined) return []
  const config = minimax.config
  if (typeof config !== 'object' || config === null) return []
  const models = (config as Record<string, unknown>).models
  if (typeof models !== 'object' || models === null || Array.isArray(models)) return []

  const out: MinimaxModelEntry[] = []
  for (const [id, raw] of Object.entries(models as Record<string, unknown>)) {
    // ⚠️ 把对象的 **key** 注入为 `id`（长名），条目自带的 `name` 是短名。
    // 两者都要保留 —— 合并会丢失官方展示名。
    const withId = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? { ...raw as Record<string, unknown>, id }
      : { id }
    const entry = normalizeMinimaxModel(withId)
    if (entry !== undefined) out.push(entry)
  }
  // ⚠️ 按远端 model_order 排序（若提供），否则保持对象插入序
  const order = (config as Record<string, unknown>).model_order
  if (Array.isArray(order)) {
    const index = new Map<string, number>()
    order.forEach((id, i) => { if (typeof id === 'string') index.set(id, i) })
    out.sort((a, b) => (index.get(a.id) ?? Number.MAX_SAFE_INTEGER)
      - (index.get(b.id) ?? Number.MAX_SAFE_INTEGER))
  }
  return out
}
