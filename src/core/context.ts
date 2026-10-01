/**
 * 宿主替身：一个最小可用的 Cordis Context。
 *
 * 为什么需要它：vendor/ 下的插件源码（dsh-codearts-auth）以 Cordis 服务注入
 * 的方式取用宿主能力（`ctx.credentials` / `ctx.logger`）。我们不想改它
 * （便于日后从上游同步），所以在网关里**自己提供一个真 Context**，
 * 把这几项服务按网关的语义实现。
 *
 * 实测结论：真实 `@deepseek-ai/cordis` 的 `Context` / `Service` 可独立构造，
 * 无需 DSH 宿主；因此 vendor 代码**一行都不用改**。
 */
import { Context } from '@deepseek-ai/cordis'
import { CredentialStore } from './credentials.js'
import { createLogger, type LogLevel, type Logger } from './logger.js'

export interface GatewayContextOptions {
  /** 本供应商的独立数据目录（凭据、账号池都放这里）。 */
  dataDir: string
  /** 日志级别。 */
  logLevel?: LogLevel
  /** 供应商 id，用于日志前缀。 */
  providerId: string
}

export interface GatewayContext {
  /** 真实 Cordis Context，可直接交给 vendor 的 Service 子类。 */
  ctx: Context
  /** 网关自己的凭据存储（vendor 通过 ctx.credentials 访问）。 */
  credentials: CredentialStore
  logger: Logger
}

/**
 * 构造供 vendor 代码使用的宿主上下文。
 *
 * `credentials` 的实现**必须与 DSH 契约一致**，因为 vendor 的 `AccountPool` /
 * `*Auth` 都按那个契约调用（取自 @deepseek-ai/dsh-credentials）：
 *   - `resolve(ref)` → `{ value, source } | undefined`
 *   - `describe(ref)` → `{ configured, source?, writable }`
 *   - `set(ref, value)` / `unset(ref)`
 *
 * 账号池隔离：vendor 的 `resolveJetHubHome(ctx)` 会优先读环境变量
 * `DSH_JET_HUB_STATE_DIR`。我们**按供应商设置该变量**，让每个供应商的
 * 账号池 state.json 落在各自目录里（符合"每个供应商各自包装"的要求），
 * 且完全不碰真实 DSH 的 `~/.dsh`。
 *
 * ⚠️ 该函数会临时设置/恢复进程环境变量，故**必须串行调用**（见 registry 的
 * 初始化锁）。这是唯一一处依赖进程级状态的妥协，换取 vendor 代码零改动。
 */
export function createGatewayContext(options: GatewayContextOptions): GatewayContext {
  const { dataDir, providerId } = options
  const logger = createLogger({ level: options.logLevel ?? 'info', prefix: providerId })
  const credentials = new CredentialStore(dataDir, providerId)

  const ctx = new Context()

  const provide = (name: string, value: unknown): void => {
    ;(ctx as unknown as { provide(name: string, value: unknown): void }).provide(name, value)
  }

  provide('credentials', {
    async resolve(ref: unknown) {
      const value = credentials.get(String(ref))
      return value === undefined ? undefined : { value, source: 'gateway' }
    },
    async describe(ref: unknown) {
      return { configured: credentials.has(String(ref)), source: 'gateway', writable: true }
    },
    async set(ref: unknown, value: string) {
      credentials.set(String(ref), value)
    },
    async unset(ref: unknown) {
      credentials.delete(String(ref))
    },
  })

  provide('logger', logger)

  return { ctx, credentials, logger }
}

/**
 * 以「该供应商的账号池目录」为上下文，运行一段会触碰 `DSH_JET_HUB_STATE_DIR`
 * 的同步代码。
 *
 * vendor 的 `createJetHubStore` 在**构造时**读取该环境变量，所以只要保证
 * 「构造期间」该变量指向本供应商的目录即可；构造完成后账号池自己持有路径，
 * 环境变量可以恢复。
 */
let HOME_LOCK: Promise<unknown> = Promise.resolve()

export function withStateDir<T>(stateDir: string, fn: () => T): Promise<T> {
  const run = async (): Promise<T> => {
    const previous = process.env.DSH_JET_HUB_STATE_DIR
    process.env.DSH_JET_HUB_STATE_DIR = stateDir
    try {
      return fn()
    } finally {
      if (previous === undefined) delete process.env.DSH_JET_HUB_STATE_DIR
      else process.env.DSH_JET_HUB_STATE_DIR = previous
    }
  }
  // 串行化：避免两个供应商同时初始化时互相覆盖环境变量。
  const next = HOME_LOCK.then(run, run)
  HOME_LOCK = next.catch(() => undefined)
  return next
}
