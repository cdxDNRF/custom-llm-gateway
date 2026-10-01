/**
 * 供应商注册表：按配置创建并持有各供应商实例。
 *
 * "每个供应商各自包装"在代码结构上的体现：这里只是**组装**，
 * 每个供应商的实现、账号池、凭据、端口都在各自的模块与目录里。
 *
 * 启动开关（用户要求，对齐 DSH 插件体验）：
 *   - catalog.ts 登记全部 12 家（id/展示名/默认端口/默认开关）
 *   - 既有四家默认开；新接入八家默认关（未登录也占端口没有意义）
 *   - Web 控制台的开关 → POST /api/config/enable → 写 config.json → 需重启生效
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CODEBUDDY, WORKBUDDY } from '../../vendor/src/product.js'
import { createBuddyProvider } from './buddy.js'
import { createTraeProvider } from './trae.js'
import { createQoderProvider } from './qoder.js'
import {
  createLobsteraiProvider,
  createClineProvider,
  createLoomyProvider,
  createRaccoonProvider,
  createMinimaxProvider,
  createQoderCnProvider,
  createZcodeProvider,
} from './extended.js'
import { CodeArtsProvider } from './codearts.js'
import { PROVIDER_CATALOG, catalogEntry } from './catalog.js'
import type { Provider } from '../core/provider.js'

/** 供应商的启动配置。 */
export interface ProviderEntryConfig {
  /** 是否启用。 */
  enabled: boolean
  /** 监听端口（每个供应商独立）。 */
  port: number
  /**
   * 访问令牌。留空表示不校验（仅本机回环时通常可接受，
   * 但**不建议**——同机其他进程可借道消耗你的额度）。
   */
  accessToken?: string
}

export interface GatewayConfig {
  /** 数据根目录。 */
  dataDir: string
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  /** 总览服务（Web UI）端口。 */
  webPort: number
  /** 各供应商配置。 */
  providers: Record<string, ProviderEntryConfig>
  /** ZCode captcha 用的浏览器路径（仅 zcode 需要）。 */
  zcodeChromePath?: string
}

export function configPathFor(dataDir: string): string {
  return resolve(dataDir, 'config.json')
}

export async function loadConfig(): Promise<GatewayConfig> {
  const home = process.env.GATEWAY_HOME ?? resolve(process.env.HOME ?? '.', '.dsh-llm-gateway')
  const dataDir = resolve(home)
  mkdirSync(dataDir, { recursive: true })

  const configPath = configPathFor(dataDir)

  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8')
  }
  let parsed: Partial<GatewayConfig> = {}
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<GatewayConfig>
  } catch {
    // 配置损坏时用默认值启动，并把原文件备份，避免直接覆盖用户数据。
    const backup = `${configPath}.broken-${Date.now()}`
    try {
      writeFileSync(backup, readFileSync(configPath, 'utf8'), 'utf8')
    } catch {
      // 备份失败不阻塞启动。
    }
  }

  // 合并：默认值 ← 用户配置。目录里新登记的供应商自动获得默认端口/开关。
  const providers: Record<string, ProviderEntryConfig> = {}
  for (const entry of PROVIDER_CATALOG) {
    const user = parsed.providers?.[entry.id]
    providers[entry.id] = {
      enabled: user?.enabled ?? entry.defaultEnabled,
      port: user?.port ?? entry.defaultPort,
      ...(user?.accessToken ? { accessToken: user.accessToken } : {}),
    }
  }

  return {
    dataDir,
    logLevel: parsed.logLevel ?? DEFAULT_CONFIG.logLevel,
    webPort: parsed.webPort ?? DEFAULT_CONFIG.webPort,
    providers,
    ...(parsed.zcodeChromePath ? { zcodeChromePath: parsed.zcodeChromePath } : {}),
  }
}

/** 默认配置：既有四家默认开，其余默认关（用户在控制台开开关）。 */
export const DEFAULT_CONFIG: GatewayConfig = {
  dataDir: '',
  logLevel: 'info',
  webPort: 8790,
  providers: Object.fromEntries(
    PROVIDER_CATALOG.map((e) => [e.id, { enabled: e.defaultEnabled, port: e.defaultPort }]),
  ),
}

/** 持久化某个供应商的开关（写入 config.json；重启后生效）。 */
export async function setProviderEnabled(dataDir: string, id: string, enabled: boolean): Promise<void> {
  if (catalogEntry(id) === undefined) throw new Error(`未知供应商 ${id}`)
  const configPath = configPathFor(dataDir)
  let config: GatewayConfig = { ...DEFAULT_CONFIG, providers: {} }
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8')) as GatewayConfig
  } catch {
    // 读不到就用默认值（首次启动必然走这里之前已写默认文件，这里是兜底）。
  }
  const entry = config.providers?.[id] ?? {
    port: catalogEntry(id)?.defaultPort ?? 3900,
  }
  config.providers = { ...(config.providers ?? {}), [id]: { ...entry, enabled } }
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')
}

/** 读取当前 config.json 里某供应商的开关（供控制台显示）。 */
export function readProviderEnabled(dataDir: string, id: string): boolean | undefined {
  try {
    const config = JSON.parse(readFileSync(configPathFor(dataDir), 'utf8')) as GatewayConfig
    return config.providers?.[id]?.enabled
  } catch {
    return undefined
  }
}

/** 创建全部已启用的供应商。 */
export async function createProviders(config: GatewayConfig): Promise<Provider[]> {
  const providers: Provider[] = []
  const entry = (id: string): ProviderEntryConfig | undefined => config.providers[id]
  const on = (id: string): boolean => entry(id)?.enabled === true
  const dir = config.dataDir
  const level = config.logLevel

  const jobs: (() => Promise<Provider>)[] = [
    () => createBuddyProvider({ product: CODEBUDDY, dataDir: dir, logLevel: level }),
    () => createBuddyProvider({ product: WORKBUDDY, dataDir: dir, logLevel: level }),
    () => createTraeProvider({ dataDir: dir, logLevel: level }),
    () => createQoderProvider({ dataDir: dir, logLevel: level }),
    () => createQoderCnProvider(dir, level),
    () => CodeArtsProvider.create(dir, level),
    () => createLobsteraiProvider(dir, level),
    () => createClineProvider(dir, level),
    () => createLoomyProvider(dir, level),
    () => createRaccoonProvider(dir, level),
    () => createMinimaxProvider(dir, level),
    () => createZcodeProvider(dir, level),
  ]
  const ids = PROVIDER_CATALOG.map((e) => e.id)

  // ⚠️ 串行创建：withStateDir 内部要临时设置进程环境变量，
  // 并行会互相踩（虽然 withStateDir 已有内部锁，这里串行更直白）。
  for (let i = 0; i < ids.length; i++) {
    if (!on(ids[i])) continue
    try {
      providers.push(await jobs[i]())
    } catch (error) {
      // 单个供应商初始化失败不阻塞其余（与端口占用的处理同策略）。
      console.error(`[registry] 供应商 ${ids[i]} 初始化失败：`, error)
    }
  }

  return providers
}
