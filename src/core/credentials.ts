/**
 * 网关的凭据存储。
 *
 * 语义对齐 DSH 的 `@deepseek-ai/dsh-credentials`（vendor 代码按那个契约调用），
 * 但落到网关自己的文件上，**与真实 DSH 的 ~/.dsh 完全隔离**。
 *
 * 文件格式刻意做成「一个 ref 一行 JSON 对象」，便于人工查看与备份：
 *
 *   {
 *     "BUDDY_ACCOUNT_1A2B3C4D": "{\"access_token\":\"...\"}",
 *     "WORKBUDDY_ACCOUNT_9F8E7D6C": "..."
 *   }
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export class CredentialStore {
  private readonly file: string
  private cache: Record<string, string> | undefined

  constructor(
    private readonly dataDir: string,
    private readonly providerId: string,
  ) {
    this.file = join(dataDir, 'credentials.json')
  }

  /** 该存储对应的文件路径（供 Web UI 展示）。 */
  get path(): string {
    return this.file
  }

  private load(): Record<string, string> {
    if (this.cache !== undefined) return this.cache
    try {
      if (!existsSync(this.file)) {
        this.cache = {}
        return this.cache
      }
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        this.cache = {}
        return this.cache
      }
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v
      }
      this.cache = out
      return out
    } catch {
      this.cache = {}
      return this.cache
    }
  }

  private persist(): void {
    const data = this.load()
    mkdirSync(dirname(this.file), { recursive: true })
    // 原子写：先写临时文件再 rename，避免进程中断留下半个文件。
    const tmp = `${this.file}.tmp`
    // ⚠️ 凭据文件含 OAuth 令牌，必须限权（0600）。mkdtemp 之外的普通写
    // 默认是 0644，同机其他用户可读 —— 那是真实的信息泄露。
    writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.file)
  }

  get(ref: string): string | undefined {
    return this.load()[ref]
  }

  has(ref: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.load(), ref)
  }

  set(ref: string, value: string): void {
    this.load()[ref] = value
    this.persist()
  }

  delete(ref: string): void {
    delete this.load()[ref]
    this.persist()
  }

  /** 列出该供应商下的全部 ref（供 Web UI 展示账号）。 */
  listRefs(): string[] {
    return Object.keys(this.load()).sort()
  }

  /** 读取并解析某个 ref 的 JSON 值；损坏时返回 undefined（不抛错）。 */
  getJson<T>(ref: string): T | undefined {
    const raw = this.get(ref)
    if (raw === undefined) return undefined
    try {
      return JSON.parse(raw) as T
    } catch {
      return undefined
    }
  }

  /** 删除该供应商下的全部凭据（供 Web UI「清空」用）。 */
  clear(): void {
    this.cache = {}
    this.persist()
  }
}
