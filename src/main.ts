#!/usr/bin/env node
/**
 * 入口：启动全部供应商端点 + 总览服务（Web 控制台）。
 *
 * 用法：
 *   node --import tsx src/main.ts            # 开发（直接跑 TS）
 *   node src/main.js                          # 编译后
 *
 * 环境变量：
 *   GATEWAY_HOME   数据目录（默认 ~/.dsh-llm-gateway）
 *   GATEWAY_PORT   总览/Web 端口（默认 8790，会覆盖 config.json）
 */
import { loadConfig, createProviders } from './providers/registry.js'
import { ProviderServer } from './core/provider-server.js'
import { OverviewServer } from './core/server.js'

async function main(): Promise<void> {
  const config = await loadConfig()
  if (process.env.GATEWAY_PORT !== undefined) {
    const port = Number(process.env.GATEWAY_PORT)
    if (Number.isInteger(port) && port > 0) config.webPort = port
  }

  console.log('')
  console.log('  dsh-llm-gateway — 本地多供应商 LLM 网关')
  console.log(`  数据目录：${config.dataDir}`)
  console.log('')

  const providers = await createProviders(config)
  if (providers.length === 0) {
    console.warn('⚠️  没有任何已启用的供应商，请检查 config.json 的 providers 段。')
  }

  // ── 每个供应商一个独立端点 ──
  const providerServers: ProviderServer[] = []
  const providerPorts: Record<string, number> = {}
  for (const provider of providers) {
    const entry = config.providers[provider.id]
    if (!entry) continue
    const server = new ProviderServer({
      provider,
      port: entry.port,
      ...(entry.accessToken ? { accessToken: entry.accessToken } : {}),
    })
    try {
      await server.start()
      providerServers.push(server)
      providerPorts[provider.id] = entry.port
    } catch (error) {
      // 端口占用等：不阻塞其余供应商启动。
      provider.gateway.logger.error(`启动失败（端口 ${entry.port}）：`, error)
    }
  }

  // ── 总览服务 ──
  const overview = new OverviewServer({
    providers: providers.filter((p) => providerPorts[p.id] !== undefined),
    port: config.webPort,
    providerPorts,
  })
  await overview.start()

  console.log('')
  console.log('  ┌─ 接入地址 ─────────────────────────────────────────────')
  for (const [id, port] of Object.entries(providerPorts)) {
    console.log(`  │ ${id.padEnd(12)} http://127.0.0.1:${port}/v1`)
  }
  console.log(`  │ ${'聚合端点'.padEnd(11)} http://127.0.0.1:${config.webPort}/v1  （模型写成 provider/model）`)
  console.log('  └────────────────────────────────────────────────────────')
  console.log('')
  console.log(`  🌐 Web 控制台：http://127.0.0.1:${config.webPort}/`)
  console.log('')

  // ── 定时续期：每 30 分钟（与 DSH 插件一致）──
  const REFRESH_INTERVAL_MS = 30 * 60 * 1000
  const timer = setInterval(() => {
    for (const provider of providers) {
      void provider.refreshAll().catch((error: unknown) => {
        provider.gateway.logger.warn('定时续期失败:', error)
      })
    }
  }, REFRESH_INTERVAL_MS)
  timer.unref?.()

  // ── 优雅退出 ──
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n收到 ${signal}，正在停止…`)
    clearInterval(timer)
    await overview.stop().catch(() => {})
    for (const server of providerServers) await server.stop().catch(() => {})
    for (const provider of providers) await provider.dispose().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((error: unknown) => {
  console.error('启动失败：', error)
  process.exit(1)
})
