/**
 * 供应商运行时管理：让「启用 / 停用」**立即生效**，不需要重启网关。
 *
 * 为什么需要它：
 *   第一版只把开关写进 config.json，界面上提示「重启后生效」—— 这既是
 *   体验问题，也让「停用」看起来像没实现（用户的真实反馈：有启用没关闭）。
 *   实际上 Provider 与 ProviderServer 都能干净地停（`dispose()` / `stop()`），
 *   没有理由要求重启。
 *
 * 职责：
 *   - 持有「当前已创建的 provider 实例」与「其监听服务」的可变映射
 *   - enable(id)：按目录创建 provider → 起监听 → 注册进映射
 *   - disable(id)：停监听 → dispose → 从映射移除（端口立即释放）
 *   - 与 config.json 的持久化解耦（调用方负责写盘），但两者总是同向操作
 *
 * ⚠️ 创建 provider 会建立账号池/凭据上下文（`withStateDir` 会临时改动进程
 * 环境变量），故所有变更操作串行化（`queue`），避免并发创建互相踩。
 */
import type { Provider } from './provider.js'
import { ProviderServer } from './provider-server.js'
import { createProviderById } from '../providers/registry.js'
import type { GatewayConfig } from '../providers/registry.js'

interface Running {
  provider: Provider
  server: ProviderServer
}

export class ProviderRuntime {
  private readonly config: GatewayConfig
  private readonly running = new Map<string, Running>()
  /** 串行化启停（provider 创建要动进程环境变量，不可并发）。 */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(config: GatewayConfig, providers: Provider[]) {
    this.config = config
    // 由 main.ts 已经起好的那批先登记（它们已经监听，这里只补登记）。
    // 注意：main.ts 传入的是「成功监听的」子集，故这里只登记已有实例，
    // server 由 attachInitial 注入。
    for (const p of providers) this.pending.set(p.id, p)
  }

  /** main.ts 启动阶段成功监听的实例，待 attach 进来（避免重复起监听）。 */
  private readonly pending = new Map<string, Provider>()

  /** 把启动阶段已监听好的 (provider, server) 登记进来。 */
  attachInitial(provider: Provider, server: ProviderServer): void {
    this.pending.delete(provider.id)
    this.running.set(provider.id, { provider, server })
  }

  isRunning(id: string): boolean {
    return this.running.has(id)
  }

  runningIds(): string[] {
    return [...this.running.keys()]
  }

  currentProviders(): Provider[] {
    return [...this.running.values()].map((r) => r.provider)
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task)
    // 吞掉链上的异常，避免一次失败卡死后续任务。
    this.queue = next.catch(() => undefined)
    return next
  }

  /** 启用：创建 provider 并起监听。已启用则幂等返回。 */
  async enable(id: string): Promise<void> {
    return this.serialize(async () => {
      if (this.running.has(id)) return
      const entry = this.config.providers[id]
      if (entry === undefined) throw new Error(`配置里没有供应商 ${id}`)

      const provider = await createProviderById(this.config, id)
      const server = new ProviderServer({
        provider,
        port: entry.port,
        ...(entry.accessToken ? { accessToken: entry.accessToken } : {}),
      })
      try {
        await server.start()
      } catch (error) {
        // 起不来就把刚创建的 provider 也清掉，别留半成品（它会持有账号池等资源）。
        await provider.dispose().catch(() => {})
        throw error
      }
      this.running.set(id, { provider, server })
      this.config.providers[id] = entry
    })
  }

  /** 停用：停监听并释放资源，端口立即归还。未运行则幂等返回。 */
  async disable(id: string): Promise<void> {
    return this.serialize(async () => {
      const current = this.running.get(id)
      if (current === undefined) return
      this.running.delete(id)
      // 先停监听（端口立即释放），再 dispose（关凭据上下文/定时器等）。
      await current.server.stop().catch(() => {})
      await current.provider.dispose().catch(() => {})
    })
  }

  /** 供 overview 查端口：优先看运行时，回落配置。 */
  portOf(id: string): number | undefined {
    return this.config.providers[id]?.port
  }
}