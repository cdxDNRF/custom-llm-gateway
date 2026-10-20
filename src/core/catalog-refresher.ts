/**
 * 模型目录的**后台保鲜**（TTL 刷新 + 冷启动有界预热）。
 *
 * ## 为什么需要它
 *
 * vendor 的适配器把远端目录缓存在实例字段 `remoteModels` 上，短路判据是
 * **「非 `undefined` 就不再拉」**（如 `buddy-adapter.ts` 的
 * `if (this.remoteModels !== undefined) return`）。于是：
 *
 * 1. **进程内只拉一次** —— 上游新增/下线模型后，必须重启网关才可见，
 *    或用户手动点「重拉模型目录」。这是个真实的运维痛点。
 * 2. **冷启动首拉失败会永久退化** —— 凭据还没就绪、或首次连接抖动时，
 *    适配器回落到静态兜底表；之后**没有任何东西会再试一次**，
 *    只有用户碰巧触发重读（打开模型管理页）才会恢复。
 *
 * ## 与上游 `dsh-providers-hub` 的关系（借鉴其思路，不照抄实现）
 *
 * 上游用 `isCatalogFresh` 唯一判据 + 20 分钟刷新器 + `catalog-prewarm`
 * 有界预热解决了同类问题。本模块借鉴**这三点意图**，但按本网关的架构重写：
 *
 * | 上游 | 本网关 |
 * |---|---|
 * | 适配器内部字段 + 独立 TTL 表 | 复用已有的 `Provider.refreshModels()`（它已会 `delete` 缓存字段） |
 * | 需要 `catalog-broadcast` 通知 DSH 客户端 | **不需要** —— 我们的 Web UI 是轮询式，没有「ready 即短路」的客户端缓存 |
 * | 每个适配器各自实现 TTL | 集中一处，对所有 provider 一视同仁 |
 *
 * ## 三条设计约束（都来自实测教训）
 *
 * 1. **有界预热，不做无限轮询**：冷启动只排固定几轮。若做成长期轮询，
 *    一个**真的**连不上目录的 provider（未登录/上游长期故障）会被反复唤醒，
 *    永远打无谓请求。
 * 2. **刷新失败不改变下次时机**（失败也记账）：否则失败的 provider 会被
 *    「立即重试」拖进紧密循环。宁可等一个完整周期。
 * 3. **单个 provider 抛错绝不影响其它**：逐家 try/catch，一家坏了不能停摆。
 */

/** 一次刷新的结果（供日志与测试观察）。 */
export interface CatalogRefreshOutcome {
  provider: string
  /** 是否成功（失败时 `count` 为 0）。 */
  ok: boolean
  /** 刷新后拿到的模型数。 */
  count: number
  /** 失败原因（成功时无）。 */
  error?: string
}

export interface CatalogRefresherOptions {
  /**
   * 取当前运行中的 provider 列表。
   *
   * ⚠️ 用**函数**而非数组：运行时可热启用/停用供应商，固定数组会漏掉
   *    之后启用的那些（那类「只在重启后生效」的缺陷很难察觉）。
   */
  providers: () => readonly {
    id: string
    refreshModels: () => Promise<{ count: number }>
  }[]
  /** 诊断日志。 */
  warn?: (message: string) => void
  /** 日志（info 级，用于正常路径）。 */
  info?: (message: string) => void
  /** 刷新周期（毫秒）。默认 20 分钟（与上游一致）。 */
  intervalMs?: number
  /** 冷启动预热的轮数。默认 3 轮。 */
  prewarmRounds?: number
  /**
   * 预热首轮延迟（毫秒）。默认 40 秒。
   *
   * ⚠️ 必须**大于**适配器的失败冷却窗口，否则重试会被适配器自己的闸门
   *    原样挡回、等于没预热。上游用的是「> 30 秒冷却」⇒ 35 秒；
   *    这里给 40 秒留更多余量（本网关的启动 + 首拉通常要更久）。
   */
  prewarmDelayMs?: number
  /** 预热的轮间递增倍数（第 n 轮间隔 = delay × n）。默认 1.5。 */
  prewarmBackoff?: number
}

/** 默认周期：20 分钟。 */
const DEFAULT_INTERVAL_MS = 20 * 60_000
/** 默认预热轮数。 */
const DEFAULT_PREWARM_ROUNDS = 3
/** 默认首轮预热延迟。 */
const DEFAULT_PREWARM_DELAY_MS = 40_000

/**
 * 模型目录保鲜器。
 *
 * 用法（见 `main.ts`）：`new CatalogRefresher({...}).start()`，
 * 退出时 `stop()`。
 */
export class CatalogRefresher {
  private readonly options: CatalogRefresherOptions
  private intervalTimer: NodeJS.Timeout | undefined
  private readonly prewarmTimers: NodeJS.Timeout[] = []
  private stopped = false
  /** 各 provider 最近一次刷新结果（供 `/api/...` 观察与排查）。 */
  private readonly lastOutcome = new Map<string, CatalogRefreshOutcome>()

  constructor(options: CatalogRefresherOptions) {
    this.options = options
  }

  /** 启动：立即排预热，并装周期刷新。 */
  start(): void {
    if (this.stopped) return
    const intervalMs = this.options.intervalMs ?? DEFAULT_INTERVAL_MS

    // ── 冷启动预热（有界）──
    //
    // ⚠️ **有界**是关键：目录问题是**启动期**问题。稳态下适配器已在
    //    `remoteModels !== undefined` 处短路，刷新调用是零成本的本地判断；
    //    但无限轮询会让「真的拿不到目录」的 provider 永远被唤醒。
    const rounds = this.options.prewarmRounds ?? DEFAULT_PREWARM_ROUNDS
    const baseDelay = this.options.prewarmDelayMs ?? DEFAULT_PREWARM_DELAY_MS
    const backoff = this.options.prewarmBackoff ?? 1.5
    let at = 0
    for (let round = 0; round < rounds; round++) {
      at += Math.round(baseDelay * Math.pow(backoff, round))
      const timer = setTimeout(() => {
        if (this.stopped) return
        this.options.info?.(`目录预热：第 ${round + 1}/${rounds} 轮`)
        void this.refreshAll('预热')
      }, at)
      timer.unref?.()
      this.prewarmTimers.push(timer)
    }

    // ── 周期刷新 ──
    this.intervalTimer = setInterval(() => {
      if (this.stopped) return
      void this.refreshAll('周期')
    }, intervalMs)
    this.intervalTimer.unref?.()

    this.options.info?.(`模型目录保鲜已启动：每 ${Math.round(intervalMs / 60_000)} 分钟`,
    )
  }

  /** 停止所有定时器。 */
  stop(): void {
    this.stopped = true
    if (this.intervalTimer !== undefined) clearInterval(this.intervalTimer)
    for (const timer of this.prewarmTimers) clearTimeout(timer)
    this.prewarmTimers.length = 0
  }

  /** 最近一次刷新结果（快照，供排查/UI）。 */
  lastResults(): readonly CatalogRefreshOutcome[] {
    return [...this.lastOutcome.values()]
  }

  /**
   * 立即刷新全部运行中的 provider 的目录。
   *
   * ⚠️ 逐家 try/catch：一家抛错不能影响其它家（这是本类最容易被写错的点 ——
   *    把循环放在一个 try 里，第一家失败就全跳过）。
   */
  async refreshAll(reason: string): Promise<readonly CatalogRefreshOutcome[]> {
    const providers = this.options.providers()
    if (providers.length === 0) return []

    const outcomes: CatalogRefreshOutcome[] = []
    for (const provider of providers) {
      try {
        const { count } = await provider.refreshModels()
        outcomes.push({ provider: provider.id, ok: true, count })
        this.lastOutcome.set(provider.id, { provider: provider.id, ok: true, count })
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error).slice(0, 200)
        outcomes.push({ provider: provider.id, ok: false, count: 0, error: message })
        this.lastOutcome.set(provider.id, {
          provider: provider.id, ok: false, count: 0, error: message,
        })
        // ⚠️ 失败只记 warn，**不提前重试**：否则失败者会被拖进紧密循环
        //    （与上游「失败不改变下次时机」同一取舍）。
        this.options.warn?.(`目录刷新失败（${reason}）：${provider.id} —— ${message}`)
      }
    }

    const failed = outcomes.filter((o) => !o.ok)
    const summary = failed.length === 0
      ? `全部 ${outcomes.length} 家成功`
      : `${outcomes.length - failed.length}/${outcomes.length} 家成功，失败：${failed.map((f) => f.provider).join(', ')}`
    this.options.info?.(`目录刷新完成（${reason}）：${summary}`)
    return outcomes
  }
}
