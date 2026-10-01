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
import { retestAccount, resetAccount, resetAllAccounts, retestAllAccounts } from '../../vendor/src/account-probe.js'
import type { ModelView, RetestResult } from './provider.js'

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
  delete target.remoteMeta
  delete target.modelsCache
  const models = await target.listModels(provider)
  return { count: models.length }
}

/** 重置限流标记（accountId 省略时重置该供应商全部账号）。 */
export async function resetLimits(
  pool: AccountPool,
  provider: string,
  accountId?: string,
): Promise<{ clearedCount: number; accountCount: number }> {
  const result = accountId === undefined
    ? await resetAllAccounts(pool as never, provider)
    : await resetAccount(pool as never, accountId)
  return { clearedCount: result.clearedCount, accountCount: result.accountCount }
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
        ...(m.resetTimeMs !== undefined ? { resetTimeMs: m.resetTimeMs } : {}),
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
