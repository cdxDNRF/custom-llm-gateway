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

/**
 * 已知档位后缀（用于**剥名字**）。
 *
 * ⚠️ 比 `GEMINI_EFFORT_IDS` 多一个 `extra-low`：上游历史上出现过
 * `gemini-3.5-flash-extra-low` 这类名字，**剥离**时需要认得它
 * （否则会被当成模型名的一部分）。
 */
const EFFORT_IDS = ['low', 'medium', 'high', 'tiered', 'extra-low'] as const

/**
 * **向客户端暴露的档位**（档位下拉里的选项）。
 *
 * ⚠️ 必须与 `vendor/src/gemini.ts` 的 `GEMINI_EFFORT_IDS` 一致 ——
 * 那边是**上游真正接受**的集合（`low/medium/high/tiered`）。
 * 之前这里误用了 `EFFORT_IDS`（含 `extra-low`）⇒ 下拉里会出现一个
 * 上游不认的选项（用户选了必然 404 或降级到 medium，且无从判断）。
 *
 * ⚠️ `tiered`：只发 `includeThoughts`、不发 `thinkingBudget`，由上游自适应
 * （见 gemini.ts 的 `GEMINI_BUDGET_TIERED = -1`）。
 */
const CLIENT_EFFORT_OPTIONS = ['low', 'medium', 'high', 'tiered'] as const

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
        ? { effortOptions: CLIENT_EFFORT_OPTIONS, defaultEffort: 'medium' }
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
/**
 * **只排除这些历史族**（2026-11-14 从白名单改为黑名单）。
 *
 * ## 为什么改
 *
 * 原来是 `KEPT_FAMILIES` 白名单（只留 4 个族）。问题是**白名单会挡住新模型**：
 * 上游后来上线的 `gemini-4-argon`、`gemini-4-hydrogen` 都不在名单里，
 * 于是**永远不显示** —— 用户反馈「gemini-4-hydrogen 响应不了？CPA 反代倒是有」。
 * 实测经 CPA 调用 `gemini-4-hydrogen-xhigh` **200 正常**，上游确实支持，
 * 纯粹是被我们自己的白名单挡掉了。
 *
 * ## 现在：黑名单只排「明确的历史噪音」
 *
 * 用户原始诉求是「老的 3 / 3.1 / 3.5 没必要了，去掉就好」——
 * 那是个**排除**需求，不是「只留这 4 个」。改用黑名单后：
 * - 历史噪音仍然被排掉（用户看到的界面不变干净）
 * - **上游新加的模型自动出现**，不需要每次改代码
 *
 * ⚠️ 黑名单的固有风险是「上游加新的历史族会漏」—— 但这些族的特征很稳定
 *    （`gemini-2.5-*` / `gemini-3.1-*` / `gemini-3.5-*` / `*-flash-lite`），
 *    用前缀正则覆盖即可，不必逐条列。
 */
const EXCLUDED_FAMILY_PATTERNS: readonly RegExp[] = [
  // 2.5 / 3.0 / 3.1 / 3.5 代：用户明确说不要的历史族
  /^gemini-2\.5-/,
  /^gemini-3-flash$/,
  /^gemini-3\.1-/,
  /^gemini-3\.5-/,
  // flash-lite 系列（各代都有，且上游 displayName 互相串）
  /-flash-lite$/,
]

/** 该模型族是否保留（按去掉档位后缀的裸 id 判）。 */
export function isKeptFamily(id: string): boolean {
  const family = stripEffortSuffix(id)
  return !EXCLUDED_FAMILY_PATTERNS.some((pattern) => pattern.test(family))
}

/**
 * **用户手动追加的模型族**（2026-11-14）。
 *
 * ## ⚠️ 实测结论：cloudcode 后端确实没有 gemini-4-* 这些新模型
 *
 * 用户报障「gemini-4-hydrogen 响应不了？CPA 反代倒是有」。查证链路：
 *
 * | 检查 | 结果 |
 * |---|---|
 * | 我们的 `fetchAvailableModels`（cloudcode） | 12 个族，**无** hydrogen/argon |
 * | `loadCodeAssist` 的 capabilityHints | 本账号**无此字段**（free-tier） |
 * | 直接打 cloudcode 的 `gemini-4-hydrogen{,-high,-xhigh,-medium}` | **全 404** |
 * | CPA 反代调 `gemini-4-hydrogen-xhigh` | ✅ 200 |
 * | **我们的 vertex 渠道调 `gemini-4-hydrogen`** | ✅ **200 "OK"** |
 *
 * ⇒ 根因：**CPA 的 antigravity 走 Vertex 后端**（二进制里有
 *   `aiplatform.googleapis.com` + `global`），而 agy 渠道走 cloudcode。
 *   同一账号在 Vertex 上有这批模型，在 cloudcode 上没有。
 *
 * 故这里**留空**（cloudcode 上确实不存在）。要 `gemini-4-*` 请用 **vertex 渠道**，
 * 它本来就支持（含档位 low/medium/high/max）。
 */
const MANUAL_FAMILIES: readonly string[] = []

/**
 * **必须带特定后缀才能调用的族**（2026-11-14 实测）。
 *
 * 用户报障后逐个试出来的：这些族的**裸名与 low/medium/high 全 404**，
 * 只有 **`-xhigh`**（hydrogen）/ **`-high`**（argon）可用 ——
 * 与 CPA 反代一致（它暴露的正是 `gemini-4-hydrogen-xhigh` / `gemini-4-argon-high`）。
 *
 * ⚠️ 与 `needsEffortSuffix` 的区别：那个表示「要不要展开 low/medium/high 三档」；
 *    这个表示「**只有一个固定档位可用**」。故它们**不展开**，直接作为单条目。
 */
const FIXED_TIER_BY_FAMILY: Readonly<Record<string, string>> = {
  // 留空 —— cloudcode 上没有可用的 gemini-4-* 族（见上面的实测表）。
  // 若将来上游在 cloudcode 上线，在这里加 `'gemini-4-xxx': '档位'` 即可。
}

/** 把手动追加的族并进候选列表（已存在的跳过）。 */
export function withManualFamilies(
  models: readonly GeminiCatalogModel[],
): GeminiCatalogModel[] {
  const known = new Set(models.map((m) => m.id))
  const extras = MANUAL_FAMILIES
    .filter((id) => !known.has(id))
    .map((id) => ({ id, name: id } as GeminiCatalogModel))
  if (extras.length === 0) return [...models]
  /**
   * 把固定档位**拼进 id**（`gemini-4-hydrogen` → `gemini-4-hydrogen-xhigh`）：
   * 探测与上游调用都用这个完整名，裸名本身就是 404。
   */
  const withTier = extras.map((model) => {
    const tier = FIXED_TIER_BY_FAMILY[model.id]
    if (tier === undefined) return model
    return { ...model, id: `${model.id}-${tier}` } as GeminiCatalogModel
  })
  return [...models, ...withTier]
}

/**
 * **整理模型目录：过滤噪音，但不再按档位展开**（2026-11-14 用户要求回退）。
 *
 * ## 为什么回退
 *
 * 用户原话：「目前 gemini agy 里的这个是按照 high，low 这种思考等级来的，
 * 回退到以前不用这个的情况，把这一套逻辑删除掉」。
 *
 * 之前（2026-11-09）把每个「必须带档位后缀」的模型族展开成 low/medium/high
 * 三个独立条目，12 条目录里有 9 条是同一批模型的档位变体 —— 模型列表变得很长
 * 且难以浏览。回退后：**一族一个条目**，档位改为**模型自带的档位下拉**
 * （`effortOptions`），用户在客户端里选档。
 *
 * ## 函数名保留但语义已变
 *
 * ⚠️ 名字仍叫 `expandTiers` 是**故意的**：调用点有两处（启动读缓存、
 *    重拉后写缓存），改名要同步改两处+缓存迁移，收益为零。但**它现在不展开任何东西**
 *    —— 只做「过滤历史噪音族」。新代码请按「normalize/sanitize」理解它。
 *
 * ## 关键：`needsEffortSuffix` 仍然必须保留
 *
 * 回退的是「目录里显示几条」，**不是**「上游怎么拼名字」。上游对
 * `gemini-3.8-flash` / `claude-opus-5-5` 这些族**只认带后缀的名字**
 * （裸名 404），故 `needsEffortSuffix: true` 必须留着 ——
 * `vendor/src/gemini.ts` 的 `geminiModelSpec` 靠它决定是否拼 `-${tier}`。
 */
export function expandTiers(models: readonly GeminiCatalogModel[]): GeminiCatalogModel[] {
  const out: GeminiCatalogModel[] = []
  for (const model of models) {
    /**
     * **丢掉用户不要的历史族**（见 `EXCLUDED_FAMILY_PATTERNS`）。
     */
    if (!isKeptFamily(model.id)) continue
    /**
     * ⚠️ **兼容旧缓存**：老缓存里存的是**已展开**的条目（带 `pinnedTier`，
     * id 形如 `claude-opus-5-5-high`）。回退后要把它们**折叠回族**，
     * 否则用户升级后会看到 12 条旧展开条目一直留着（直到手动重拉）。
     *
     * 折叠规则：`pinnedTier` 存在 ⇒ 剥掉档位后缀取裸 id；同族的后续条目跳过。
     */
    if (model.pinnedTier !== undefined) {
      const baseId = stripEffortSuffix(model.id)
      if (out.some((m) => m.id === baseId)) continue
      /**
       * 恢复成「裸 id + 档位下拉」形态：
       * - `id` 用裸名（客户端看到的模型名）
       * - `effortOptions` 给回三档（上游实际支持的就是这三档）
       * - `needsEffortSuffix: true`（上游仍要后缀，见函数头注释）
       */
      const baseName = stripTierSuffix(model.name)
      out.push({
        ...model,
        id: baseId,
        name: baseName,
        needsEffortSuffix: true,
        effortOptions: [...CLIENT_EFFORT_OPTIONS],
        defaultEffort: 'medium',
        pinnedTier: undefined,
      })
      continue
    }
    /**
     * 已经是「族」形态的条目：保留，并**补上档位下拉**（若该族需要后缀）。
     *
     * ⚠️ 只给 `needsEffortSuffix === true` 的族补 —— 那些「只认裸名」的族
     *    （`gemini-3-flash` / `gemini-2.5-*`）加后缀会 404，给它们档位下拉
     *    等于让用户选一个必然失败的组合。
     */
    if (model.needsEffortSuffix === true && (model.effortOptions === undefined || model.effortOptions.length === 0)) {
      out.push({
        ...model,
        effortOptions: [...CLIENT_EFFORT_OPTIONS],
        defaultEffort: model.defaultEffort ?? 'medium',
      })
      continue
    }
    out.push(model)
  }
  return out
}

/**
 * 从展示名里剥掉档位括注（`Claude Opus 5.5 (High)` → `Claude Opus 5.5`）。
 *
 * ⚠️ 用于把旧缓存里的**展开条目**折叠回族时恢复原名，避免显示成
 *    `Claude Opus 5.5 (High)` 而 id 是 `claude-opus-5-5` 的不一致形态。
 */
function stripTierSuffix(name: string): string {
  return name.replace(/\s*\((?:low|medium|high|tiered|extra-low)\)\s*$/i, '').trim() || name
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
