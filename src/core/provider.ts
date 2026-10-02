/**
 * 供应商的统一契约。
 *
 * 设计要求（用户明确指定）：**每个供应商各自包装**，不合并成一个万能对象。
 * 因此这里定义的是一个**薄接口**，各供应商在自己的模块里实现它，
 * 每个供应商拥有：
 *   - 独立的适配器实例（复用 vendor 里对应的 *-adapter.ts）
 *   - 独立的账号池（state.json 落在 data/providers/<id>/）
 *   - 独立的凭据空间（credentials.json 同上）
 *   - 独立的 HTTP 挂载点（/p/<id>/v1/...）与自己的端口
 */
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { AccountPool } from '../../vendor/src/account-pool.js'
import type { GatewayContext } from '../core/context.js'

/** 供应商能力声明（Web UI 据此决定显示哪些按钮）。 */
export interface ProviderCapabilities {
  /** 是否支持 OAuth 浏览器登录。 */
  login: boolean
  /** 是否支持「一键签到」领取积分。 */
  dailyCheckin: boolean
  /** 是否可查积分/余额。 */
  balance: boolean
  /** 是否支持「锁定永久积分」。 */
  permanentLock: boolean
  /** 是否支持多账号。 */
  multiAccount: boolean
  /** 是否支持静默续期。 */
  refresh: boolean
}

/** 账号视图（Web UI 展示用，不含令牌明文）。 */
export interface AccountView {
  id: string
  nickname: string
  enabled: boolean
  credentialRef: string
  expiresAt?: number
  refreshable: boolean
  /** 该账号被限流的模型 → 解禁时间戳。 */
  modelRateLimits?: Record<string, number>
}

/** 一次登录尝试。 */
export interface LoginStart {
  /** 待用户打开的授权 URL。 */
  loginUrl: string
  /** 账号 id（占位，授权完成后填充凭据）。 */
  accountId: string
  /** 授权完成后 resolve。 */
  completed: Promise<{ ok: boolean; error?: string }>
}

/** 积分/余额读数。 */
export interface BalanceView {
  /** 总额（单位由 provider 决定：积分或 token）。 */
  total: number
  /** 量纲说明，便于前端如实标注。 */
  unit: 'credits' | 'tokens'
  /** 分项（如多个资源包）。 */
  items?: { name: string; remain: number; expireAt?: number }[]
  /** 取得该读数的时间。 */
  at: number
}

/** 签到结果。 */
export interface CheckinResult {
  ok: boolean
  /** already-claimed = 今天已领（幂等成功）。 */
  status: 'claimed' | 'already-claimed' | 'unavailable' | 'failed'
  message?: string
  /** 领取到的数量（若服务端返回）。 */
  amount?: number
}

/**
 * 供应商实现。
 *
 * ⚠️ 实现者只需提供这些方法；HTTP/OpenAI 协议转换、账号池、凭据存储
 * 都由 core 统一提供，避免"每个供应商长出一份互相不一致的实现"。
 */
export interface Provider {
  /** 供应商 id（也是 URL 前缀与数据目录名）。 */
  readonly id: string
  /** 展示名。 */
  readonly displayName: string
  /** 能力声明。 */
  readonly capabilities: ProviderCapabilities
  /** 该供应商的适配器（vendor 实现），core 用它做对话与模型列表。 */
  readonly adapter: LlmAdapter
  /** 账号池。 */
  readonly pool: AccountPool
  /** 宿主上下文（含凭据存储与日志）。 */
  readonly gateway: GatewayContext

  /** 列出账号（不含令牌）。 */
  listAccounts(): Promise<AccountView[]>

  /** 启动一次登录，立即返回授权 URL（两步式，避免弹窗被拦截）。 */
  startLogin(nickname?: string): Promise<LoginStart>

  /** 删除账号。 */
  removeAccount(accountId: string): Promise<void>

  /** 启用/停用账号。 */
  setAccountEnabled(accountId: string, enabled: boolean): Promise<void>

  /** 查询积分/余额；不支持时返回 undefined。 */
  queryBalance(): Promise<BalanceView | undefined>

  /** 一键签到；不支持时返回 unavailable。 */
  checkin(): Promise<CheckinResult>

  /** 静默续期全部账号。 */
  refreshAll(): Promise<void>

  // ─────────── 模型管理（对齐 DSH 插件的 model.* 端点）───────────

  /** 列出模型及其启用状态（黑名单制：默认全部显示）。 */
  listModelsWithState(): Promise<ModelView[]>

  /** 启用/停用某个模型（停用后不出现在模型列表与选择器）。 */
  setModelDisabled(modelId: string, disabled: boolean): Promise<void>

  /** 批量设置模型启停。 */
  setModelsDisabled(modelIds: readonly string[], disabled: boolean): Promise<void>

  /** 全部启用（清空黑名单）。 */
  clearAllModelsDisabled(): Promise<void>

  /**
   * 强制重新从上游拉取模型目录。
   *
   * ## 为什么需要它（真实缺陷，2026-10-01 实测）
   *
   * vendor 的适配器把远端目录缓存在实例字段 `remoteModels` 上，且判据是
   * 「只要不是 undefined 就不再拉」：
   *
   * ```ts
   * if (this.remoteModels !== undefined || this.options.fetchRemoteModels === undefined) return
   * ```
   *
   * 于是**进程生命周期内只拉一次** —— 上游新增了模型，网关要等到**重启**才看得见。
   * 对常驻服务来说这是真实的可用性问题（用户问的正是这个）。
   *
   * 修法：网关侧清掉该缓存字段（TS 的 `private` 只是编译期约束，运行时是普通字段），
   * 下次 `listModels` 就会重新拉上游。**不改 vendor 代码**，保持可同步。
   *
   * @returns 重新拉取后的模型数量（上游不可达时可能为 0，不抛错）
   */
  refreshModels(): Promise<{ count: number }>

  // ─────────── 账号进阶操作（对齐 account.* 端点）───────────

  /** 调整账号顺序（顺序 = 选号优先级）。 */
  reorderAccounts(orderedIds: readonly string[]): Promise<void>

  /**
   * 重置账号的限流标记：**清标记后立刻对受限模型真实发一次请求**，
   * 用上游的裁决决定是否真恢复。返回与 {@link retest} 同构的结果。
   */
  resetRateLimits(accountId?: string): Promise<RetestResult>

  /** 重测账号：对带限流标记的模型真实发一次最小请求，判断是否真的还受限。 */
  retest(accountId?: string): Promise<RetestResult>

  // ─────────── 永久积分锁（仅 buddy 系支持）───────────

  /** 读取「锁定永久积分」开关状态（本地开关，同步）。 */
  permanentLocked(): boolean

  /** 设置「锁定永久积分」。 */
  setPermanentLocked(locked: boolean): Promise<void>

  /** 释放资源（关闭浏览器、定时器等）。 */
  dispose(): Promise<void>
}

/** 模型视图（含启用状态与来源）。 */
export interface ModelView {
  id: string
  name: string
  enabled: boolean
  contextWindow?: number
  /** 上游下发的倍率文案（如 `x0.29`）。 */
  credits?: string
}

/** 重测结果（对齐 vendor 的 ProbeAccountResult）。 */
export interface RetestResult {
  /** 被重测的账号数（单账号重测时为 1）。 */
  accounts: {
    accountId: string
    nickname?: string
    tested: number
    /** 确认恢复正常、标记已清除的模型 id。 */
    cleared: string[]
    /** 仍受限的模型（含上游给出的新重置时刻）。 */
    stillLimited: { modelId: string; message?: string; resetTimeMs?: number }[]
    error?: string
  }[]
  /** 解除限流的模型总数。 */
  clearedCount: number
  /** 仍受限的模型总数。 */
  stillLimitedCount: number
}
