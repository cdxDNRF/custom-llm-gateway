/**
 * 供应商的共用实现片段。
 *
 * 各供应商差异在"协议与认证"，而**模型管理 / 账号进阶操作 / 永久积分锁**
 * 这三块完全共用 vendor 的 AccountPool 原语，逻辑一致 —— 放在这里避免
 * 每个供应商复制一遍（否则会像 vendor 的踩坑记录说的那样"长出一份互相
 * 不一致的实现"）。
 */
import type { AccountPool } from '../../vendor/src/account-pool.js'
import type { ProviderAccountEntry } from '../../vendor/src/types.js'
import { retestAccount, retestAllAccounts } from '../../vendor/src/account-probe.js'
import type { ModelView, RetestResult } from './provider.js'

/**
 * 从限流报错文案里兜底解析出重置时刻。
 *
 * ## 为什么需要它
 *
 * vendor 的 `parseRateLimitError` 先 `JSON.parse(body)`，而腾讯侧限流报错常是
 * **纯文本**（如 `buddy: 您的使用量已超出频率限制，将在 2026-10-02 12:55:34
 * UTC+8 重置…`）——JSON.parse 抛异常后，因探测路径没传 status，最终返回 null，
 * 重置时刻丢失（前端显示「仍受限但无时间」）。
 *
 * 但文案里**其实带着完整时间**。这里用同一套正则从 message 文本里抠出来，
 * 与 vendor 的 `RESET_TIME_PATTERN` 保持同构（见 llm-adapter.ts）。
 *
 * 返回毫秒时间戳；解析不到返回 undefined（调用方保留原值或显示「无时间」）。
 */
const RESET_TIME_IN_MESSAGE = /(?:将在|reset at)\s+([\d-]+\s+[\d:]+)\s+(UTC[+-]\d+(?::\d+)?)/i

function extractResetTimeFromMessage(message: string | undefined): number | undefined {
  if (message === undefined) return undefined
  const m = RESET_TIME_IN_MESSAGE.exec(message)
  if (!m) return undefined
  const ms = Date.parse(`${m[1]} ${m[2]}`)
  return Number.isNaN(ms) ? undefined : ms
}

/** 适配器里 `listAllModels()` 的返回形状（不受黑名单影响）。 */
interface AdapterWithAllModels {
  listAllModels?(): readonly { id: string; name: string; contextWindow?: number; credits?: string }[]
}

/**
 * 列出模型及启用状态。
 *
 * 数据来源分两层（与 DSH 插件一致）：
 *   - **全集**：适配器的 `listAllModels()`（不受用户黑名单影响）
 *   - **黑名单**：账号池的 `listDisabledModels(provider)`
 *
 * ⚠️ 为什么不直接用 `adapter.listModels()`：那个方法**已经过滤**了黑名单，
 * 用它做"显示列表"会让被停用的模型从界面上消失、用户再也无法重新启用。
 * 这是 vendor 在注释里明确记录过的设计（"带最终展示名/倍率"）。
 *
 * ⚠️⚠️ **必须先 await `adapter.listModels()`**（真实缺陷，2026-10-01 实测）：
 *
 * `listAllModels()` 是**纯读缓存**的同步方法 —— 它只看 `this.remoteModels`，
 * **不会触发远端拉取**（拉取在 `listModels()` 的 `ensureRemoteModels()` 里）。
 * 于是网关刚启动、还没人调用过 OpenAI 端点时：
 *
 * ```
 * ① 先查 /api/p/trae/models  → 28 个（remoteModels 仍是 undefined → 静态兜底表 33-5）
 * ② 再查 /v1/models          → 38 个（这次触发了远端拉取）
 * ③ 重查 /api/p/trae/models  → 38 个（缓存已有）
 * ```
 *
 * 用户看到的是「管理界面的模型比实际能用的少」——非常难排查。
 * 故这里先 `await listModels()` 把远端目录**预热**好，再读 `listAllModels()`。
 * 该调用顺带有 30 秒 TTL 的鉴权缓存与账号门控，不会造成额外压力。
 */
export async function listModelsWithState(
  adapter: unknown,
  pool: AccountPool,
  provider: string,
): Promise<ModelView[]> {
  const target = adapter as AdapterWithAllModels & {
    listModels(id: string): Promise<readonly unknown[]>
  }
  // 预热：触发 ensureRemoteModels()，把远端目录填进缓存。
  // 失败（未登录/网络问题）不影响后续——那时 listAllModels 回退静态表是正确行为。
  try {
    await target.listModels(provider)
  } catch {
    // 忽略：下面用现有缓存/静态表渲染。
  }
  const source = target.listAllModels?.() ?? []
  const disabled = pool.listDisabledModels(provider)
  return source.map((model) => ({
    id: model.id,
    name: model.name ?? model.id,
    enabled: disabled[model.id] !== true,
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model.credits !== undefined ? { credits: model.credits } : {}),
  }))
}

/** 批量 / 单个模型启停。 */
export async function applyModelDisabled(
  pool: AccountPool,
  provider: string,
  modelIds: readonly string[],
  disabled: boolean,
): Promise<void> {
  for (const modelId of modelIds) {
    await pool.setModelDisabled(provider, modelId, disabled)
  }
}

/** 全部启用（清空黑名单）。 */
export async function clearAllModelsDisabled(pool: AccountPool, provider: string): Promise<void> {
  await pool.clearDisabledModels(provider)
}

/**
 * 清掉适配器上的远端模型缓存，并重新拉一次。
 *
 * vendor 的适配器用实例字段 `remoteModels` 缓存远端目录，判据是
 * 「非 undefined 就不再拉」—— 于是进程内**只拉一次**，上游新增模型要**重启**才可见。
 * TS 的 `private` 只是编译期约束，运行时这些字段可读写，故网关可以就地清掉，
 * **无需改 vendor**（保持日后能同步）。
 *
 * ⚠️ 字段名随适配器而异：buddy / trae 用 `remoteModels`；
 * qoder 的 `listModels` 恒用静态表（不发网络请求），清缓存对它是空操作。
 * 若上游将来改字段名，这里会安全退化为「什么都没清」（不抛错）——
 * 用 `/api/p/<id>/models` 观察数量是否变化即可发现。
 */
export async function refreshModels(
  adapter: unknown,
  provider: string,
): Promise<{ count: number }> {
  const target = adapter as {
    listModels(id: string): Promise<readonly unknown[]>
    remoteModels?: unknown
    modelsCache?: unknown
    remoteMeta?: unknown
  }
  delete target.remoteModels
  // ⚠️ `remoteMeta` 必须一起清：它是 id→模型的映射，供能力判定（图片/推理/上下文）
  // 使用。只清 `remoteModels` 而不清它，会出现「模型列表是新的、能力查的是旧的」
  // 这种不一致（trae 的 inputModalitiesFor / reasoningConfigFor 都读它）。
  //
  // ⚠️⚠️ **必须重置为 `new Map()`，不能用 `delete`**（真实缺陷，2026-10-20）：
  //    这些字段在 vendor 里的声明是
  //      `private remoteMeta: ReadonlyMap<string, T> = new Map()`
  //    —— **初始值就是空 Map，永不 undefined**。而 `delete` 会把它变成
  //    `undefined`，于是刷新过程中任何读它的代码（如 buddy 的
  //    `isFreeModel` 里 `this.remoteMeta.get(modelId)`）直接抛
  //    `TypeError: Cannot read properties of undefined (reading 'get')`。
  //
  //    为什么以前没暴露：手动点「重拉」前用户通常先打开过模型管理页
  //    （`listModels` 已填好 `remoteMeta`），时序上恰好躲过；
  //    而**后台保鲜器是自动跑的**，撞上「已清空但尚未重新填充」的窗口概率高得多
  //    —— 正是它把这个潜伏缺陷暴露了出来。
  if ('remoteMeta' in target) {
    target.remoteMeta = new Map()
  }
  // `modelsCache` 的初始值在各家不同（多为 undefined），delete 是安全的。
  delete target.modelsCache
  const models = await target.listModels(provider)
  return { count: models.length }
}

/**
 * 重置限流标记：**只清本地标记，不发任何请求**。
 *
 * ## 与 {@link retest} 的分工（用户要求，2026-10-12）
 *
 * 曾经本函数被改成「清标记 + 立刻强制重测」，因为只清标记会被上游立刻
 * 写回（限流状态在服务端，客户端解不掉）。但那样**每次重置都真实消耗一次
 * 上游额度**，只想快速清个标记时代价过大。
 *
 * 现在是两个独立动作，各司其职：
 *   - **本函数（重置）**：秒级完成、零额度消耗。适用于「我要让账号重新参与
 *     选号」——若上游其实已解禁，下次调用即可成功；若仍受限，调用时会自动
 *     重新记账（标记回来是**正确行为**，不是 bug）。
 *   - **`retest()`（重测）**：真实发请求，用上游裁决决定是否解除。适用于
 *     「不确定到底解没解禁」。
 *
 * ⚠️ 用户须知：重置后若立刻又被标记，说明**上游确实还在限流**，只能等到
 * 上游给的重置时刻。这是服务端状态，不是网关能绕过的。
 */
export async function resetLimits(
  pool: AccountPool,
  provider: string,
  accountId?: string,
): Promise<{ clearedCount: number; accountCount: number }> {
  const entries = pool.listAccountsByProvider(provider)
  let clearedCount = 0
  let accountCount = 0
  for (const entry of entries) {
    if (accountId !== undefined && entry.id !== accountId) continue
    const cleared = await pool.clearModelRateLimits(entry.id)
    if (cleared > 0) {
      clearedCount += cleared
      accountCount++
    }
  }
  return { clearedCount, accountCount }
}

/**
 * 重测账号：对带限流标记的模型**真实发一次最小对话请求**，判断上游是否真的
 * 还在限流。仍受限时会把上游给出的新重置时刻写回标记（vendor 的滚动语义）。
 */
export async function retest(
  pool: AccountPool,
  provider: string,
  accountId?: string,
): Promise<RetestResult> {
  const normalize = (
    accounts: readonly {
      accountId: string
      nickname?: string
      tested: number
      cleared: string[]
      stillLimited: readonly { modelId: string; message?: string; resetTimeMs?: number }[]
      error?: string
    }[],
  ): RetestResult => ({
    accounts: accounts.map((a) => ({
      accountId: a.accountId,
      ...(a.nickname !== undefined ? { nickname: a.nickname } : {}),
      tested: a.tested,
      cleared: a.cleared,
      stillLimited: a.stillLimited.map((m) => ({
        modelId: m.modelId,
        ...(m.message !== undefined ? { message: m.message } : {}),
        // ⚠️ vendor 的 parseRateLimitError 在纯文本报错（非 JSON 体）上会
        // 丢失重置时刻（JSON.parse 抛异常 → 没传 status → 返回 null）。但
        // 上游文案里其实带着完整时间（「将在 YYYY-MM-DD HH:mm:ss UTC±x 重置」）。
        // 这里兜底解析，避免前端把「仍受限但无重置时间」显示成空白。
        ...(() => {
          const t = m.resetTimeMs ?? extractResetTimeFromMessage(m.message)
          return t !== undefined ? { resetTimeMs: t } : {}
        })(),
      })),
      ...(a.error !== undefined ? { error: a.error } : {}),
    })),
    clearedCount: accounts.reduce((sum, a) => sum + a.cleared.length, 0),
    stillLimitedCount: accounts.reduce((sum, a) => sum + a.stillLimited.length, 0),
  })

  if (accountId !== undefined) {
    return normalize([await retestAccount(pool as never, accountId)])
  }
  const result = await retestAllAccounts(pool as never, provider)
  return normalize(result.accounts)
}

/** 账号视图映射（账号池 entry → 前端用的 AccountView）。 */
export function toAccountView(entry: ProviderAccountEntry): {
  id: string
  nickname: string
  enabled: boolean
  credentialRef: string
  expiresAt?: number
  refreshable: boolean
  modelRateLimits?: Record<string, number>
} {
  return {
    id: entry.id,
    nickname: entry.nickname,
    enabled: entry.enabled,
    credentialRef: entry.credentialRef,
    ...(entry.expiresAt !== undefined ? { expiresAt: entry.expiresAt } : {}),
    refreshable: entry.refreshable,
    ...(entry.modelRateLimits !== undefined ? { modelRateLimits: entry.modelRateLimits } : {}),
  }
}
