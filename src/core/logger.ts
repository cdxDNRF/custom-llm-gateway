/**
 * 轻量日志器：满足 vendor 代码对 `ctx.logger` 的调用契约。
 *
 * vendor 只用到 `debug` / `info` / `warn` / `error` 四个方法，且大量使用可选链
 * （`ctx.logger?.warn?.(...)`），所以这里只需提供这四个函数即可。
 * 为可读性加上了 `[providerId]` 前缀与时间戳。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface Logger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
  /** 网关自己的扩展：订阅日志（Web UI 实时日志用）。 */
  subscribe(listener: (line: LogEntry) => void): () => void
}

export interface LogEntry {
  at: number
  level: LogLevel
  providerId: string
  text: string
}

/** 全局环形缓冲：所有供应商的日志都汇到这里，Web UI 统一展示。 */
const RING: LogEntry[] = []
const RING_MAX = 500
const LISTENERS = new Set<(line: LogEntry) => void>()

export function recentLogs(limit = 200): LogEntry[] {
  return RING.slice(-limit)
}

function emit(entry: LogEntry): void {
  RING.push(entry)
  if (RING.length > RING_MAX) RING.splice(0, RING.length - RING_MAX)
  for (const listener of LISTENERS) {
    try {
      listener(entry)
    } catch {
      // 订阅者出错不影响主流程。
    }
  }
}

export function createLogger(options: { level: LogLevel; prefix: string }): Logger {
  const threshold = ORDER[options.level]

  const write = (level: LogLevel, args: unknown[]): void => {
    if (ORDER[level] < threshold) return
    const text = args
      .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a)))
      .join(' ')
    emit({ at: Date.now(), level, providerId: options.prefix, text })
    const time = new Date().toISOString().slice(11, 19)
    const line = `${time} ${level.toUpperCase().padEnd(5)} [${options.prefix}] ${text}`
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  }

  return {
    debug: (...a: unknown[]) => write('debug', a),
    info: (...a: unknown[]) => write('info', a),
    warn: (...a: unknown[]) => write('warn', a),
    error: (...a: unknown[]) => write('error', a),
    subscribe(listener) {
      LISTENERS.add(listener)
      return () => LISTENERS.delete(listener)
    },
  }
}
