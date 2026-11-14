/**
 * **agy（antigravity）渠道的模型清单来源修正**（2026-11-14）。
 *
 * ## 问题
 *
 * 用户反馈：「gemini-4-hydrogen 响应不了？同样账号的 CPA 反代倒是有这个模型」。
 *
 * 实测确认（本机 2026-11-14）：
 *
 * | 来源 | gemini-4-hydrogen | 说明 |
 * |---|---|---|
 * | 我们用的 `fetchAvailableModels` | ❌ 没有 | 只返回 12 个「基础族」 |
 * | CPA 的 `/v1/models`（8317 端口） | ✅ `gemini-4-hydrogen-xhigh` | 暴露 7 个 |
 * | 经 CPA 真实调用 hydrogen | ✅ **200 "OK"** | **上游确实支持** |
 *
 * ⇒ 不是账号没权限，是**我们查错了接口**。
 *
 * ## 真正的来源：`loadCodeAssist` 的 `capability_hints`
 *
 * CPA 的凭据文件里存着这个结构（`oauth/antigravity-*.json`）：
 *
 * ```json
 * "antigravity_capability_hints": {
 *   "endpoint": "https://daily-cloudcode-pa.googleapis.com",
 *   "model_ids": ["claude-opus-5-5-high", ..., "gemini-4-hydrogen-xhigh", ...],
 *   "project_id": "...",
 *   "web_search_model_ids": [...]
 * }
 * ```
 *
 * 共 **31 个** model id，包含 `gemini-4-argon-*`、`gemini-4-hydrogen-*`、
 * `gemini-3.8-flash-tiered` 等 `fetchAvailableModels` 拿不到的条目。
 *
 * 而**我们的 `resolveGeminiProject` 早就在调 `loadCodeAssist` 了**
 * （`vendor/src/gemini-project.ts`），但只取了 `cloudaicompanionProject`、
 * 把同一次响应里的 `capabilityHints` 丢掉了 —— 这是本次修复的关键点。
 *
 * ## 为什么不做「硬编码一份模型表」
 *
 * CPA 的二进制里确实硬编码了 `gemini-4-argon` / `gemini-4-carbon`
 * （字符串里能搜到），但**没有** `gemini-4-hydrogen` —— 说明它用的是运行时
 * hints，而不是写死的表。跟着上游走才不会在上游加模型时掉队。
 */

/** `loadCodeAssist` 响应里的 capability hints（我们关心的字段）。 */
export interface AntigravityCapabilityHints {
  endpoint?: string
  projectId?: string
  /** 该凭据可用的**全部** model id（含档位后缀，如 `gemini-4-hydrogen-xhigh`）。 */
  modelIds: readonly string[]
  /** 可用于原生搜索的模型 id。 */
  webSearchModelIds?: readonly string[]
}

/**
 * 从 `loadCodeAssist` 的响应里解析 capability hints。
 *
 * ⚠️ 字段名兼容两种写法（`capabilityHints` 驼峰 / `capability_hints` 下划线）：
 *    上游是 protobuf-JSON，历史抓包里两种都见过；只认一种会在上游切换时静默失效。
 *
 * @returns 解析不到返回 `undefined`（调用方回落到 `fetchAvailableModels`）
 */
export function parseCapabilityHints(payload: unknown): AntigravityCapabilityHints | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  const raw = record.capabilityHints ?? record.capability_hints
  if (typeof raw !== 'object' || raw === null) return undefined
  const hints = raw as Record<string, unknown>

  const modelIds = toStringArray(hints.model_ids ?? hints.modelIds)
  if (modelIds.length === 0) return undefined

  const endpoint = typeof hints.endpoint === 'string' ? hints.endpoint : undefined
  const projectId = typeof hints.project_id === 'string'
    ? hints.project_id
    : typeof hints.projectId === 'string' ? hints.projectId : undefined
  const webSearch = toStringArray(hints.web_search_model_ids ?? hints.webSearchModelIds)

  return {
    modelIds,
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(webSearch.length === 0 ? {} : { webSearchModelIds: webSearch }),
  }
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item !== '')
}

/**
 * 把 hints 里的 model id 归一成「模型族」（去掉档位后缀、去掉内部条目）。
 *
 * ⚠️ 与 `src/core/gemini-catalog.ts` 的 `stripEffortSuffix` **同一套规则**：
 *    档位后缀是 `-low` / `-medium` / `-high` / `-tiered` / `-extra-low` / `-xhigh`
 *    / `-disabled`。两边不一致会让「同一个 id 在目录里出现两次」或「后缀被当名字」。
 *
 * ⚠️ 过滤 `chat_*` / `tab_*` 内部条目 —— 它们在 hints 里有，但不是对话模型
 *    （实测 `chat_20706` / `tab_flash_lite_preview` 打过去会 400）。
 *
 * ⚠️ 过滤 `-disabled` 结尾的：hints 里 `gemini-4-carbon-disabled` 是**显式禁用**，
 *    与「不可用」不同，别把它当普通模型展开。
 */
const TIER_SUFFIXES = ['-extra-low', '-disabled', '-xhigh', '-tiered', '-medium', '-high', '-low'] as const

export function familyOf(hintedId: string): string | undefined {
  if (/^(chat_|tab_)/.test(hintedId)) return undefined
  for (const suffix of TIER_SUFFIXES) {
    if (hintedId.endsWith(suffix)) {
      // `-disabled` 的模型直接丢弃（上游明确禁用）
      if (suffix === '-disabled') return undefined
      return hintedId.slice(0, hintedId.length - suffix.length)
    }
  }
  return hintedId
}

/**
 * 从 hints 提取**去重后的模型族列表**（保持上游顺序）。
 *
 * 例：`['gemini-4-hydrogen-low','gemini-4-hydrogen-xhigh','claude-opus-5-5-high',…]`
 * ⇒ `['gemini-4-hydrogen','claude-opus-5-5',…]`
 */
export function familiesFromHints(hints: AntigravityCapabilityHints): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of hints.modelIds) {
    const family = familyOf(id)
    if (family === undefined || seen.has(family)) continue
    seen.add(family)
    out.push(family)
  }
  return out
}
