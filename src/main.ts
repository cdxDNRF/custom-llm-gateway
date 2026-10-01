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
import { loadConfig, createProviders, generateAccessToken, persistOverviewSettings } from './providers/registry.js'
import { ProviderServer } from './core/provider-server.js'
import { OverviewServer } from './core/server.js'
import { ProviderRuntime } from './core/provider-runtime.js'
import { lanAddresses } from './core/net.js'

async function main(): Promise<void> {
  const config = await loadConfig()
  if (process.env.GATEWAY_PORT !== undefined) {
    const port = Number(process.env.GATEWAY_PORT)
    if (Number.isInteger(port) && port > 0) config.webPort = port
  }
  // 监听地址也可用环境变量临时覆盖（不必改 config.json）。
  if (process.env.GATEWAY_HOST !== undefined && process.env.GATEWAY_HOST.length > 0) {
    config.host = process.env.GATEWAY_HOST
  }

  // ── 暴露到局域网时必须带令牌 ──
  //
  // 监听 0.0.0.0 而 accessToken 为空 = 同网段任何人都能白用你的账号池
  // （含签到积分）。这里自动生成一个随机令牌并写回 config.json，用户
  // 只需照启动日志里打印的地址配置客户端即可，不会裸奔。
  //
  // ⚠️ 只对"明确不是回环"的 host 生效：`0127.0.0.1` 这类写法保守视为回环，
  // 避免误判把本机访问也拦下来。
  const exposed = config.host !== '127.0.0.1' && config.host !== 'localhost' && config.host !== '::1'
  if (exposed && (config.accessToken === undefined || config.accessToken.length === 0)) {
    config.accessToken = generateAccessToken()
    persistOverviewSettings(config.dataDir, { accessToken: config.accessToken })
    console.log('  ⚠️  检测到监听地址为 ' + config.host + ' 且未设置访问令牌。')
    console.log('      已自动生成随机令牌并写入 config.json（避免账号池暴露给同网段）。')
    console.log('')
  }

  console.log('')
  console.log('  dsh-llm-gateway — 本地多供应商 LLM 网关')
  console.log(`  数据目录：${config.dataDir}`)
  console.log('')

  const providers = await createProviders(config)
  if (providers.length === 0) {
    console.warn('⚠️  没有任何已启用的供应商，请检查 config.json 的 providers 段。')
  }

  // ── 运行时管理器（让控制台的启用/停用立即生效，不必重启）──
  const runtime = new ProviderRuntime(config, providers)

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
      runtime.attachInitial(provider, server)
      providerPorts[provider.id] = entry.port
    } catch (error) {
      // 端口占用等：不阻塞其余供应商启动。
      provider.gateway.logger.error(`启动失败（端口 ${entry.port}）：`, error)
    }
  }

  // ── 总览服务（Web UI + 聚合端点）──
  const overview = new OverviewServer({
    providers: providers.filter((p) => providerPorts[p.id] !== undefined),
    port: config.webPort,
    host: config.host,
    ...(config.accessToken ? { accessToken: config.accessToken } : {}),
    providerPorts,
    dataDir: config.dataDir,
    runtime,
  })
  await overview.start()

  // ── 接入地址 ──
  //
  // ⚠️ 供应商端口（3901…）按设计**恒绑回环**：本方案只把 8790 聚合端点
  // 开放到局域网（用户明确选择），少一个暴露面。故它们的地址始终是
  // 127.0.0.1，局域网设备要统一走聚合端点。
  const lan = lanAddresses()
  console.log('')
  console.log('  ┌─ 本机接入地址 ────────────────────────────────────────')
  for (const [id, port] of Object.entries(providerPorts)) {
    console.log(`  │ ${id.padEnd(12)} http://127.0.0.1:${port}/v1`)
  }
  console.log(`  │ ${'聚合端点'.padEnd(11)} http://127.0.0.1:${config.webPort}/v1  （模型写成 provider/model）`)
  console.log('  └────────────────────────────────────────────────────────')
  console.log('')
  if (exposed && lan.length > 0) {
    const tokenHint = config.accessToken !== undefined
      ? `（需带令牌，见下方）`
      : ''
    console.log(`  ┌─ 局域网接入（手机 / 平板 / 酒馆）${tokenHint} ───────────────`)
    for (const entry of lan) {
      console.log(`  │ ${entry.iface} 网卡（IP 可能随校园网变化，以控制台显示为准）`)
      console.log(`  │ 控制台      http://${entry.address}:${config.webPort}/`)
      console.log(`  │ API 基址    http://${entry.address}:${config.webPort}/v1`)
    }
    console.log('  └────────────────────────────────────────────────────────')
    console.log('')
    if (config.accessToken !== undefined) {
      console.log(`  🔑 访问令牌：${config.accessToken}`)
      console.log('     客户端里把它填到 API Key / 密码栏即可（作为 Bearer 令牌）。')
      console.log('     本机（127.0.0.1）访问无需令牌；令牌用于挡住局域网其它设备。')
      console.log('     令牌固定不变；IP 变化时刷新控制台页面即可看到新地址。')
      console.log('')
    }
  } else if (lan.length > 0) {
    console.log('  ℹ️  当前仅监听本机回环，手机等局域网设备无法访问。')
    console.log('     要开放：编辑 config.json 加 "host": "0.0.0.0" 后重启网关。')
    console.log('')
  }
  console.log(`  🌐 Web 控制台：http://127.0.0.1:${config.webPort}/`)
  console.log('')

  // ── 定时续期：每 30 分钟（与 DSH 插件一致）──
  const REFRESH_INTERVAL_MS = 30 * 60 * 1000
  const timer = setInterval(() => {
    for (const provider of runtime.currentProviders()) {
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
    // 逐个停（含运行时热启用起来的那些）——先停监听再 dispose。
    for (const id of runtime.runningIds()) await runtime.disable(id).catch(() => {})
    for (const server of providerServers) await server.stop().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((error: unknown) => {
  console.error('启动失败：', error)
  process.exit(1)
})
