/**
 * Gemini 的动态模型目录：从上游 `fetchAvailableModels` 拉取账号真正可用的模型。
 *
 * ## 为什么需要它（真实发现，2026-10-15）
 *
 * 上游插件把 Gemini 的模型表**硬编码**成 1 个（`GEMINI_FALLBACK_MODELS` 只有
 * `gemini-3.8-flash`），理由是「用户拍板：不拉远端目录」。
 *
 * 但实际探测发现官方客户端的**模型发现端点存在且可用**：
 *
 * ```
 * POST /v1internal:fetchAvailableModels   → HTTP 200
 * ```
 *
 * 用它拉取，本机账号有 **19 个条目**，逐个实测可推理的 **15 个** ——
 * 包括两个 Anthropic 模型（`claude-sonnet-4-6` / `claude-opus-4-6-thinking`，
 * 经 Google 网关转发）。即**只暴露 1 个模型是严重的信息损失**。
 *
 * ## 三条实测纪律（都踩过）
 *
 * 1. **列表里的名字不能直接当模型 id**：返回的是族名（`gemini-3.8-flash-tiered`），
 *    而真实可调名需要档位后缀（裸 `gemini-3.8-flash` 上游 404，
 *    `gemini-3.8-flash-medium` 才 200）。故要**剥掉档位后缀**再入库 ——
 *    档位由用户在下拉框选，不占独立模型位。
 * 2. **必须过滤"已下线"**：3 个条目（`gemini-3-flash-agent`、`gemini-3.5-flash-low`、
 *    `gemini-3.5-flash-extra-low`）**HTTP 200 但正文是
 *    "Gemini 3.5 Flash is no longer available"** —— 只看状态码会把它们当可用。
 *    列表接口**不带**下线标记，只能逐个真发一次请求探测。
 * 3. **探测有成本**：每个候选一次真实推理（约 1-3s）。故探测结果**落盘缓存**，
 *    仅在显式"重拉目录"时重做。
 *
 * ## 能力字段
 *
 * `fetchAvailableModels` 顺带给出 `maxTokens` / `supportsImages` /
 * `supportsThinking` —— 直接映射成目录条目的上下文窗口与模态，不必猜。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 上游返回的单个条目（只列我们用到的字段）。 */
interface AvailableModelMeta {
  displayName?: string
  supportsImages?: boolean
  supportsThinking?: boolean
  maxTokens?: number
  maxOutputTokens?: number
}

/** 目录条目（与 vendor 的 `GeminiModelEntry` 同形）。 */
export interface GeminiCatalogModel {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  supportsImage: boolean
  effortOptions?: readonly string[]
  defaultEffort?: string
  /**
   * 上游调用这个模型时**是否需要拼档位后缀**。
   *
   * ⚠️ **按模型族不同，不能统一**（实测对照表，2026-10-15）：
   *
   * | 模型 | 裸名 | 加 `-medium` |
   * |---|---|---|
   * | `gemini-3.8-flash` | ❌ 404 | ✅ **需要后缀** |
   * | `gpt-oss-120b` | ❌ 404 | ✅ **需要后缀** |
   * | `claude-sonnet-4-6` | ✅ **裸名** | ❌ 404 |
   * | `claude-opus-4-6-thinking` | ✅ **裸名** | — |
   * | `gemini-3-flash` / `gemini-2.5-flash` | ✅ **裸名** | ❌ 404 |
   *
   * 缺省（未探测过）视为 `true` —— 与改动前的行为一致（当时唯一的模型
   * `gemini-3.8-flash` 正是需要后缀的）。探测会写入实测值。
   */
  needsEffortSuffix?: boolean
  /**
   * **固定档位**（本仓库扩展，2026-11-09）。
   *
   * 非 `undefined` 时，适配器**忽略外部 effort**、恒用这个 tier 拼 upstream 名。
   * 用于「档位写进模型名」的条目（`claude-opus-5-5-high` 等），
   * 保证「选哪个名字就跑哪一档」，不受 DSH 的档位下拉影响。
   */
  pinnedTier?: 'low' | 'medium' | 'high'
}

/** 已知档位后缀（与 vendor 的 `GEMINI_EFFORT_IDS` 一致）。 */
const EFFORT_IDS = ['low', 'medium', 'high', 'tiered', 'extra-low'] as const

/**
 * 剥掉档位后缀（`gemini-3.8-flash-tiered` → `gemini-3.8-flash`）。
 *
 * ⚠️ 必须先试**长后缀**（`extra-low` 在 `low` 之前），否则
 * `gemini-3.5-flash-extra-low` 会先匹配 `low`、剥成 `...-extra`（错名）。
 */
export function stripEffortSuffix(id: string): string {
  const sorted = [...EFFORT_IDS].sort((a, b) => b.length - a.length)
  for (const effort of sorted) {
    if (id.endsWith(`-${effort}`)) return id.slice(0, id.length - effort.length - 1)
  }
  return id
}

/** 该条目名是否像"内部/预览"项（`tab_*`、`chat_*`）—— 实测不可用或非对话模型，排除。 */
function isInternalEntry(id: string): boolean {
  return /^(tab_|chat_)/.test(id)
}

/**
 * 从上游 `fetchAvailableModels` 的响应里解析出候选模型。
 *
 * 纯函数（不联网），便于单测与复用。
 */
export function parseAvailableModels(payload: unknown): GeminiCatalogModel[] {
  if (typeof payload !== 'object' || payload === null) return []
  const models = (payload as { models?: unknown }).models
  if (typeof models !== 'object' || models === null) return []

  const byId = new Map<string, GeminiCatalogModel>()
  for (const [rawId, rawMeta] of Object.entries(models as Record<string, unknown>)) {
    if (isInternalEntry(rawId)) continue
    const id = stripEffortSuffix(rawId)
    const meta = (typeof rawMeta === 'object' && rawMeta !== null ? rawMeta : {}) as AvailableModelMeta
    // 同名族（`-low` / `-medium` / …）只留一条；后到的若信息更全则覆盖。
    const existing = byId.get(id)
    const contextWindow = typeof meta.maxTokens === 'number' && meta.maxTokens > 0 ? meta.maxTokens : 0
    const maxTokens = typeof meta.maxOutputTokens === 'number' && meta.maxOutputTokens > 0
      ? meta.maxOutputTokens
      : 65_536
    const entry: GeminiCatalogModel = {
      id,
      name: typeof meta.displayName === 'string' && meta.displayName.length > 0
        ? meta.displayName
        : id,
      contextWindow,
      maxTokens,
      supportsImage: meta.supportsImages === true,
      // 档位选项：上游声明支持思考就给全档（与静态表同口径 —— 档位是自由旋钮，
      // 名字只是标签，见 gemini.ts 文件头的实测结论）。
      ...(meta.supportsThinking === true
        ? { effortOptions: EFFORT_IDS, defaultEffort: 'medium' }
        : {}),
      // ⚠️ 缺省 true（与"唯一模型 gemini-3.8-flash 需要后缀"的旧行为一致）；
      //    探测阶段会按实测改成 false（claude / gemini-2.5 等）。
      needsEffortSuffix: true,
    }
    if (existing === undefined || contextWindow > existing.contextWindow) byId.set(id, entry)
  }
  return [...byId.values()]
}

/**
 * 把「一个模型 + 档位下拉」**展开成 N 个独立模型条目**（2026-11-09，用户要求）。
 *
 * ## 为什么要有这一步
 *
 * 原先的做法是：每个模型占**一个**条目，档位放在 `effortOptions` 下拉里
 * （DSH 的模型名后面显示「Medium」，点开再选 low/high）。用户明确要求改成
 * 「**每个模型分 low/medium/high 三种，共 12 个**」—— 即档位写进模型名，
 * 在模型列表里直接可见可选，不必再进二级下拉。
 *
 * ## 关键事实（本机实测，2026-11-09；`daily-cloudcode-pa` + Pro 账号）
 *
 * 档位**只**由上游模型名的后缀决定，`thinkingBudget` 与它**解耦**：
 *
 * | 测试 | 结果 |
 * |---|---|
 * | `claude-opus-5-5-high` + budget(high) | ✅ 200 |
 * | `claude-opus-5-5-high` + budget(low)  | ✅ 200 |
 * | `claude-opus-5-5-low`  + budget(high) | ✅ 200 |
 *
 * ⇒ 后缀决定"上游用哪一档"，budget 只是附带旋钮。故每个展开条目只要
 * **固定自己的 tier** 即可，不需要把 budget 也绑死。
 *
 * ## 哪些模型才展开（**逐档实测**，不是按名字猜）
 *
 * | 模型族 | 裸名 | `-low`/`-medium`/`-high` |
 * |---|---|---|
 * | `gemini-3.8-flash` | ❌ 404 | ✅ 三档全通 |
 * | `claude-opus-5-5` | ❌ 404 | ✅ 三档全通 |
 * | `claude-sonnet-5-5` | ❌ 404 | ✅ 三档全通 |
 * | `gemini-3-flash` / `gemini-2.5-pro` / `gemini-*-flash-lite` | ✅ 裸名可用 | ❌ **三档全 404** |
 *
 * ⇒ **不能对所有模型展开**：那些"只认裸名"的族展开出来会全部 404。
 * 判据用探测阶段写回的 `needsEffortSuffix`（实测值，不是猜的）。
 *
 * ⚠️ 未探测过的条目（`needsEffortSuffix === undefined`）**不展开** ——
 * 宁可保守：展开错了会让用户点到必然失败的模型，而不展开只是少 2 个选项。
 */
/**
 * **只保留这些模型族**（2026-11-09，用户要求）。
 *
 * 用户原话：「那几个老的模型：3，3.1，3.5 就没必要了去掉就好」。
 * 上游 `fetchAvailableModels` 会返回一堆历史族（`gemini-3-flash`、
 * `gemini-3.1-flash-lite`、`gemini-3.5-flash-lite`、`gemini-2.5-*`），
 * 它们的显示名还互相串（4 个不同 id 的 displayName 都是
 * "Gemini 3.5 Flash Lite"，因为上游按当前别名渲染）—— 留着只制造噪音。
 *
 * ⚠️ **白名单而不是黑名单**：上游随时会加新的历史族，黑名单必然漏。
 * 用户实际要用的就是截图里那 4 个（3 个可用 + GPT-OSS），故白名单最省心。
 *
 * ⚠️ 这是**用户偏好**，不是技术约束 —— 想恢复全部模型，删掉这个过滤即可
 * （`parseAvailableModels` 拿到的仍是上游全集）。
 */
const KEPT_FAMILIES: readonly string[] = [
  'gemini-3.8-flash',
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'gpt-oss-120b',
]

/** 该模型族是否保留（按去掉档位后缀的裸 id 判）。 */
export function isKeptFamily(id: string): boolean {
  return KEPT_FAMILIES.includes(stripEffortSuffix(id))
}

export function expandTiers(models: readonly GeminiCatalogModel[]): GeminiCatalogModel[] {
  /** 要展开的档位（`tiered` / `extra-low` 不在用户要求的三档里）。 */
  const TIERS = ['low', 'medium', 'high'] as const
  const out: GeminiCatalogModel[] = []
  for (const model of models) {
    /**
     * **丢掉用户不要的历史族**（见 `KEPT_FAMILIES`）。
     * ⚠️ 放在幂等判断**之前**：已展开的旧族条目（带 `pinnedTier`）也要能滤掉，
     *    否则老缓存里的 `gemini-3.5-flash-lite` 会一直显形。
     */
    if (!isKeptFamily(model.id)) continue
    /**
     * ⚠️⚠️ **幂等：已经展开过的条目不能再展开一次**（否则
     * `claude-opus-5-5-high` 会变成 `claude-opus-5-5-high-low`）。
     * 判据是 `pinnedTier` 已存在 —— 展开出来的条目都带它。
     */
    if (model.pinnedTier !== undefined) {
      out.push(model)
      continue
    }
    // 只有「必须带后缀」的族才展开（见上方实测对照表）。
    if (model.needsEffortSuffix !== true) {
      out.push(model)
      continue
    }
    /**
     * 展示名去掉上游附带的 `(Medium)` 之类括号，再由我们统一拼档位。
     *
     * ⚠️ `gemini-3.8-flash` 的上游 displayName 是**小写开头**（就是 id 本身），
     * 混在 `Claude Opus 5.5` / `GPT-OSS 120B` 里很扎眼 ⇒ 归一成标题式。
     * 只影响展示，不改 id。
     */
    const rawName = model.name.replace(/\s*\((?:low|medium|high|tiered|extra-low)\)\s*$/i, '').trim()
      || model.id
    const baseName = rawName === model.id && /^[a-z]/.test(rawName)
      ? rawName.replace(/(^|[-\s])([a-z])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase())
      : rawName
    for (const tier of TIERS) {
      out.push({
        ...model,
        // ⚠️ id 带档位后缀：它同时是「模型唯一标识」和「上游准入钥匙」。
        id: `${model.id}-${tier}`,
        name: `${baseName} (${tier[0]!.toUpperCase()}${tier.slice(1)})`,
        // ⚠️ **必须清掉 `effortOptions`**：档位已经写进模型名了，
        //    再留一个下拉就是「同一件事两处可选」且可能互相矛盾
        //    （用户选 `-high` 的模型、下拉又选 low，症状极难解释）。
        effortOptions: undefined,
        defaultEffort: undefined,
        /**
         * **固定档位**：适配器据此拼 upstream，忽略（或不许）外部 effort。
         * 见 `vendor/src/gemini.ts` 的 `pinnedTier` 支持。
         */
        pinnedTier: tier,
      })
    }
  }
  return out
}

/** 探测结果缓存文件（落盘，避免每次启动都重新探测）。 */
function cachePath(dataDir: string): string {
  return join(dataDir, 'gemini-models.json')
}

/**
 * 读缓存（不存在/损坏返回 undefined）。
 *
 * ⚠️ 缓存带 `probedAt`：上游模型会变，故只在"重拉目录"时才信缓存之外的东西；
 * 但**启动时用缓存**能立刻给出一份像样的目录（好过只有 1 个模型的静态表）。
 */
export function readCatalogCache(dataDir: string): GeminiCatalogModel[] | undefined {
  try {
    const raw = readFileSync(cachePath(dataDir), 'utf8')
    const parsed = JSON.parse(raw) as { models?: unknown }
    if (!Array.isArray(parsed.models)) return undefined
    const models = parsed.models.filter(
      (m): m is GeminiCatalogModel =>
        typeof m === 'object' && m !== null && typeof (m as { id?: unknown }).id === 'string',
    )
    return models.length > 0 ? models : undefined
  } catch {
    return undefined
  }
}

/** 写缓存（best-effort：失败不影响主流程）。 */
export function writeCatalogCache(dataDir: string, models: readonly GeminiCatalogModel[]): void {
  try {
    mkdirSync(dirname(cachePath(dataDir)), { recursive: true })
    writeFileSync(
      cachePath(dataDir),
      JSON.stringify({ probedAt: Date.now(), models }, null, 2),
      'utf8',
    )
  } catch {
    // 忽略：缓存失败只是下次要重新探测。
  }
}

/**
 * 拉取账号可用的模型目录（**联网**，不含可用性探测）。
 *
 * @param accessToken Google OAuth access token。
 * @param project `cloudaicompanionProject`（拿不到时用上游默认 `aicode-consumers`）。
 * @param endpoint 上游端点（缺省 daily；调用方应传 `GEMINI_ENDPOINTS` 之一）。
 */
export async function fetchAvailableModels(options: {
  accessToken: string
  project?: string
  endpoint: string
  signal?: AbortSignal
}): Promise<GeminiCatalogModel[]> {
  const response = await fetch(`${options.endpoint}/v1internal:fetchAvailableModels`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${options.accessToken}`,
      'user-agent': 'antigravity',
    },
    body: JSON.stringify({ project: options.project ?? 'aicode-consumers' }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  if (!response.ok) return []
  return parseAvailableModels(await response.json().catch(() => null))
}

/**
 * 判定一次探测结果是否表示"模型已下线"。
 *
 * ⚠️ 上游对下线模型返回 **HTTP 200 + 正常 SSE 结构**，正文是一句固定文案
 * （实测 `"Gemini 3.5 Flash is no longer available. Please switch to …"`）。
 * 只看状态码会把它当可用模型暴露出去，用户选中才发现拿不到答案。
 */
export function looksDeprecated(text: string): boolean {
  return /is no longer available|has been deprecated|no longer supported/i.test(text)
}

/** 目录缓存文件是否存在（供日志/诊断）。 */
export function hasCatalogCache(dataDir: string): boolean {
  return existsSync(cachePath(dataDir))
}
