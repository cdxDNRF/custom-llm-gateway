/**
 * 用量统计：记录每次调用的模型 / token / 耗时，并聚合出可查询的报表。
 *
 * ## 存储选型：JSONL 追加 + 内存聚合
 *
 * 候选是 `node:sqlite`（Node 22+ 内置）与 JSONL。这里选 **JSONL**，理由：
 *
 * 1. **跨版本稳妥**：Windows 端 Node v22 下 `node:sqlite` 会打
 *    `ExperimentalWarning`（API 可能变），而本项目要求"双击就跑、零依赖"，
 *    不适合把统计建在实验性 API 上；
 * 2. **写入模式匹配**：统计是**纯追加**（每次调用一行），没有更新/事务需求，
 *    `appendFileSync` 一行就是全部实现；
 * 3. **可直接查**：JSONL 能用 `jq`/grep/Excel 直接分析，不需要额外工具；
 * 4. **坏行可跳过**：单行损坏只影响那一行，不会像 SQLite 那样整个库打不开。
 *
 * ## 为什么内存里还要聚合
 *
 * 报表接口（按天/按模型/按供应商）若每次都扫全文件，文件一大就卡。
 * 故启动时**尾部读取**（默认最近 5000 条）建立内存索引，运行时增量累加；
 * 全量数据始终在 JSONL 里，需要更长历史时可直接读文件。
 *
 * ## 写入性能（重要）
 *
 * `appendFileSync` 是同步 IO，但**一次一行、OS 有页缓存**，实测微秒级，
 * 不会拖慢请求。若将来量大，可换成流式 append 或批量 flush —— 但那需要
 * 处理进程退出时的缓冲丢失，当前量级不值得。
 *
 * ## 隐私
 *
 * **只记元数据**（模型、token 数、耗时、状态），**不记请求/响应正文**
 * ——与 workbuddy-manager 的做法一致，避免提示词与输出落盘。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 一次调用的统计记录（一行 JSONL）。 */
export interface UsageRecord {
  /** 时间戳（毫秒）。 */
  at: number
  /** 供应商 id，如 `buddy`。 */
  provider: string
  /** 模型 id（**不含**供应商前缀，如 `glm-5.3`）。 */
  model: string
  /**
   * 调用面：`openai`（/v1/chat/completions）或 `anthropic`（/v1/messages）。
   * 便于区分不同客户端的用量。
   */
  api: 'openai' | 'anthropic'
  /** 是否流式。 */
  stream: boolean
  /** 调用是否成功（false = 上游报错或网关异常）。 */
  ok: boolean
  /** 失败时的简短原因（截断，不含敏感信息）。 */
  error?: string
  /** 输入 token（上游未给则为 0）。 */
  inputTokens: number
  /** 输出 token。 */
  outputTokens: number
  /** 总耗时（毫秒），从收到请求到响应结束。 */
  ms: number
  /**
   * 首字节延迟（毫秒）：流式下才有意义，衡量"多久开始出字"。
   * 非流式时为 undefined。
   */
  ttftMs?: number
}

/** 聚合维度。 */
export interface UsageBucket {
  key: string
  calls: number
  okCalls: number
  inputTokens: number
  outputTokens: number
  /** 平均耗时（毫秒，四舍五入）。 */
  avgMs: number
  /** 调用失败次数。 */
  failures: number
}

export interface UsageSummary {
  /** 统计覆盖的记录条数（内存索引里的）。 */
  sampled: number
  /** 聚合起点时间（内存索引里最早一条的时间）。 */
  since: number | null
  total: UsageBucket
  byDay: UsageBucket[]
  byProvider: UsageBucket[]
  byModel: UsageBucket[]
  /** 最近 N 条原始记录（倒序，便于"刚才那次用了多少"）。 */
  recent: UsageRecord[]
}

/** 内存里保留的最大记录数（超出后丢弃最旧的，仅影响报表，JSONL 仍完整）。 */
const MAX_IN_MEMORY = 5000
/** 报表默认返回的最近记录条数。 */
const RECENT_LIMIT = 50

interface UsageStoreOptions {
  dataDir: string
  /** 关闭落盘（单测用）。 */
  persist?: boolean
}

/**
 * 用量存储：追加写 JSONL + 内存聚合。
 *
 * ⚠️ 构造后必须调用 {@link load} 才会读入历史数据（异步/同步分离，
 * 避免在构造函数里做 IO）。
 */
export class UsageStore {
  private readonly file: string
  private readonly persist: boolean
  private readonly ring: UsageRecord[] = []
  /** 记录数，用于判断是否需要裁剪。 */
  private count = 0

  constructor(options: UsageStoreOptions) {
    this.file = join(options.dataDir, 'usage.jsonl')
    this.persist = options.persist !== false
    if (this.persist) {
      mkdirSync(options.dataDir, { recursive: true })
    }
  }

  /** 数据文件路径（设置页展示用）。 */
  get path(): string {
    return this.file
  }

  /**
   * 读入历史记录（只读尾部 MAX_IN_MEMORY 行）。
   *
   * ⚠️ 逐行 JSON.parse 且**跳过坏行**：文件可能被外部编辑或写入中途断电，
   * 一行损坏不该让统计整个不可用。
   */
  load(): void {
    if (!this.persist || !existsSync(this.file)) return
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      return // 文件被占用/权限问题：统计从空开始，不影响网关主流程。
    }
    const lines = text.split('\n')
    // 只取尾部：历史更长时报表仍可用，全量数据在文件里。
    const tail = lines.length > MAX_IN_MEMORY ? lines.slice(lines.length - MAX_IN_MEMORY) : lines
    for (const line of tail) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      try {
        const parsed = JSON.parse(trimmed) as UsageRecord
        if (typeof parsed.at !== 'number') continue
        this.ring.push(normalize(parsed))
        this.count++
      } catch {
        // 坏行跳过。
      }
    }
    this.trim()
  }

  /** 记录一次调用。**绝不抛错**——统计失败不能影响请求本身。 */
  record(record: UsageRecord): void {
    try {
      const normalized = normalize(record)
      this.ring.push(normalized)
      this.count++
      this.trim()
      if (this.persist) {
        appendFileSync(this.file, `${JSON.stringify(normalized)}\n`, 'utf8')
      }
    } catch {
      // 磁盘满 / 权限问题：静默降级为"只内存统计"。
    }
  }

  /** 清空统计数据（文件会被重命名备份，不直接删）。 */
  clear(): { removed: number; backup?: string } {
    const removed = this.count
    this.ring.length = 0
    this.count = 0
    if (!this.persist || !existsSync(this.file)) return { removed }
    const backup = `${this.file}.bak-${Date.now()}`
    try {
      renameSync(this.file, backup)
      return { removed, backup }
    } catch {
      return { removed }
    }
  }

  /** 汇总成报表。 */
  summary(recentLimit = RECENT_LIMIT): UsageSummary {
    const records = this.ring
    const total = emptyBucket('total')
    const days = new Map<string, UsageBucket>()
    const providers = new Map<string, UsageBucket>()
    const models = new Map<string, UsageBucket>()

    for (const r of records) {
      accumulate(total, r)
      accumulate(getBucket(days, dayKey(r.at)), r)
      accumulate(getBucket(providers, r.provider), r)
      // 模型维度带上供应商前缀，避免不同家的同名模型被合并（如 glm-5.3）。
      accumulate(getBucket(models, `${r.provider}/${r.model}`), r)
    }

    return {
      sampled: records.length,
      since: records.length > 0 ? records[0]!.at : null,
      total: finalize(total),
      // 天/供应商/模型都按"最近优先"排序，便于阅读。
      byDay: finalizeAll(days).sort((a, b) => b.key.localeCompare(a.key)),
      byProvider: finalizeAll(providers).sort((a, b) => b.calls - a.calls),
      byModel: finalizeAll(models).sort((a, b) => b.calls - a.calls),
      recent: records.slice(-recentLimit).reverse(),
    }
  }

  /** 总记录数（含已被内存裁剪掉的历史行数）。 */
  get size(): number {
    return this.count
  }

  /** 文件字节数（设置页展示用）。 */
  bytes(): number {
    try {
      return this.persist && existsSync(this.file) ? statSync(this.file).size : 0
    } catch {
      return 0
    }
  }

  private trim(): void {
    if (this.ring.length <= MAX_IN_MEMORY) return
    this.ring.splice(0, this.ring.length - MAX_IN_MEMORY)
  }
}

/** 补齐缺失字段（旧记录可能没有 api/stream）。 */
function normalize(r: UsageRecord): UsageRecord {
  return {
    at: typeof r.at === 'number' ? r.at : Date.now(),
    provider: String(r.provider ?? ''),
    model: String(r.model ?? ''),
    api: r.api === 'anthropic' ? 'anthropic' : 'openai',
    stream: r.stream === true,
    ok: r.ok !== false,
    ...(r.error !== undefined ? { error: String(r.error).slice(0, 200) } : {}),
    inputTokens: Number(r.inputTokens) || 0,
    outputTokens: Number(r.outputTokens) || 0,
    ms: Number(r.ms) || 0,
    ...(typeof r.ttftMs === 'number' ? { ttftMs: r.ttftMs } : {}),
  }
}

/**
 * 按 **UTC+8** 归日（与 Qoder 等上游的"每日"口径一致，见 model-queue.ts）。
 *
 * ⚠️ 不用 `toISOString().slice(0,10)`（那是 UTC，会让晚上 8 点后的调用
 * 落到"昨天"，与用户直觉不符）。
 */
function dayKey(at: number): string {
  const shifted = new Date(at + 8 * 3_600_000)
  const y = shifted.getUTCFullYear()
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const d = String(shifted.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function emptyBucket(key: string): UsageBucket {
  return { key, calls: 0, okCalls: 0, inputTokens: 0, outputTokens: 0, avgMs: 0, failures: 0 }
}

/** 累加时把 `avgMs` 当作"耗时总和"暂存，finalize 时再除（省一个字段）。 */
function accumulate(bucket: UsageBucket, r: UsageRecord): void {
  bucket.calls++
  if (r.ok) bucket.okCalls++
  else bucket.failures++
  bucket.inputTokens += r.inputTokens
  bucket.outputTokens += r.outputTokens
  bucket.avgMs += r.ms
}

function finalize(bucket: UsageBucket): UsageBucket {
  bucket.avgMs = bucket.calls > 0 ? Math.round(bucket.avgMs / bucket.calls) : 0
  return bucket
}

function finalizeAll(map: Map<string, UsageBucket>): UsageBucket[] {
  return [...map.values()].map(finalize)
}

function getBucket(map: Map<string, UsageBucket>, key: string): UsageBucket {
  let bucket = map.get(key)
  if (bucket === undefined) {
    bucket = emptyBucket(key)
    map.set(key, bucket)
  }
  return bucket
}

// ─────────────────────────── 流式拦截（旁路采集用量） ───────────────────────────

/** 从 chunk 流里采集到的用量信息。 */
export interface StreamUsage {
  inputTokens: number
  outputTokens: number
  /** 首个**内容**帧的到达时刻（毫秒时间戳）；用于算 TTFT。 */
  firstByteAt?: number
  /** 是否看到了 finish 帧（判断流是否正常走完）。 */
  finished: boolean
}

/**
 * 旁路拦截 chunk 流：**原样透传**，同时采集 usage 与首字节时刻。
 *
 * ## 为什么用生成器而不是改各端点
 *
 * 三条路径（OpenAI 聚合、Anthropic 聚合、供应商端口）都消费 chunk 流。
 * 若在每个端点的 for-await 里各写一遍采集逻辑，必然漂移且容易漏改
 * （vendor 注释里反复记录过"只修了一条通道"的教训）。
 * 故做成一个可复用的包装器，各端点只多一行。
 *
 * ⚠️ **必须逐 chunk 及时 yield**，不能先收集再吐（那样流式就退化成
 * 非流式，TTFT 与用户体验全毁）。
 */
export async function* tapUsage(
  chunks: AsyncIterable<StreamChunkLike>,
  sink: StreamUsage,
): AsyncGenerator<StreamChunkLike, void, undefined> {
  for await (const chunk of chunks) {
    if (sink.firstByteAt === undefined) {
      // 首个"有内容"的帧才算首字节：纯 role/骨架帧不算（它们不体现生成速度）。
      const t = chunk.type
      if (t === 'text-delta' || t === 'reasoning-delta' || t === 'tool-call-delta') {
        sink.firstByteAt = Date.now()
      }
    }
    if (chunk.type === 'usage') {
      const usage = (chunk as { usage?: { inputTokens?: number; outputTokens?: number } }).usage
      if (typeof usage?.inputTokens === 'number') sink.inputTokens = usage.inputTokens
      if (typeof usage?.outputTokens === 'number') sink.outputTokens = usage.outputTokens
    }
    if (chunk.type === 'finish') sink.finished = true
    yield chunk
  }
}

/**
 * tapUsage 的最小结构约束。
 *
 * ⚠️ 刻意**不 import dsh-llm 的 StreamChunk 类型**：本模块要能被单测
 * 直接 import（不拉进整个 vendor 依赖图），且我们只读 `type` 与 `usage`
 * 两个字段，宽类型更稳。
 */
export interface StreamChunkLike {
  type: string
  [key: string]: unknown
}
