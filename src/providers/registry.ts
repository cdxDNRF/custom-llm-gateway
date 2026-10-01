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
import { randomUUID } from 'node:crypto'
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
  /**
   * 总览服务（Web UI + 聚合端点）的监听地址。
   *
   * - `127.0.0.1`（默认）：仅本机可访问，最安全。
   * - `0.0.0.0`：局域网内任意设备（手机 / 平板 / 其他电脑）可访问，
   *   手机端的 SillyTavern 等客户端因此能接入。
   *
   * ⚠️ 改成 `0.0.0.0` 后**必须同时设置 `accessToken`**：网关持有的是你的
   * 真实账号池与签到积分，同网段任何人都能借道消耗。启动时会强制校验。
   */
  host: string
  /** 总览服务（Web UI）端口。 */
  webPort: number
  /**
   * 总览服务的访问令牌（`Bearer` 语义）。
   *
   * **只对本服务（Web UI + 聚合端点）生效**，与各供应商端口的
   * `providers[].accessToken` 相互独立。
   *
   * 设置为非空后：
   *   - 聚合端点 `/v1/*` 要求 `Authorization: Bearer <token>`
   *   - 管理 API `/api/*` 同样要求（否则同网段可任意开关供应商）
   *   - **来自 `127.0.0.1` / `::1` 的请求豁免**，浏览器打开控制台不会被拦
   *     （前端会在首次连接时提示输入令牌并存入 localStorage）
   *
   * 监听 `0.0.0.0` 时若此字段为空，启动会**自动生成**一个随机令牌并写回
   * config.json，避免用户无意中把账号池暴露到局域网。
   */
  accessToken?: string
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
    host: parsed.host ?? DEFAULT_CONFIG.host,
    webPort: parsed.webPort ?? DEFAULT_CONFIG.webPort,
    ...(parsed.accessToken ? { accessToken: parsed.accessToken } : {}),
    providers,
    ...(parsed.zcodeChromePath ? { zcodeChromePath: parsed.zcodeChromePath } : {}),
  }
}

/** 默认配置：既有四家默认开，其余默认关（用户在控制台开开关）。 */
export const DEFAULT_CONFIG: GatewayConfig = {
  dataDir: '',
  logLevel: 'info',
  // 默认只听回环：不设 accessToken 也安全。要上局域网请改 host 为 0.0.0.0，
  // 启动时会强制要求令牌（缺失则自动生成并写回 config.json）。
  host: '127.0.0.1',
  webPort: 8790,
  providers: Object.fromEntries(
    PROVIDER_CATALOG.map((e) => [e.id, { enabled: e.defaultEnabled, port: e.defaultPort }]),
  ),
}

/**
 * 生成一个随机访问令牌（32 字符 hex）。
 *
 * 用 `crypto.randomUUID()` 去掉连字符而不是自拼随机数：与项目其它地方
 * （trae 的 machine_id 生成）保持同一风格，且无需引入依赖。
 */
export function generateAccessToken(): string {
  return randomUUID().replace(/-/g, '')
}

/**
 * 把总览服务的 host / accessToken 持久化进 config.json。
 *
 * 与 `setProviderEnabled` 同样采用「读-改-写」：该文件同时承载供应商开关，
 * 整体覆盖会丢掉其它字段。读失败时以默认值为底（首次启动已写过文件，
 * 这里是兜底）。
 */
export function persistOverviewSettings(
  dataDir: string,
  patch: { host?: string; accessToken?: string },
): void {
  const configPath = configPathFor(dataDir)
  let config: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown
    if (typeof parsed === 'object' && parsed !== null) config = parsed as Record<string, unknown>
  } catch {
    // 读不到/损坏：以空对象为底，仅写入本次要改的字段。
  }
  if (patch.host !== undefined) config.host = patch.host
  if (patch.accessToken !== undefined) config.accessToken = patch.accessToken
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')
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

/** 单个供应商的创建工厂（按目录 id）。 */
function factoryFor(id: string, dir: string, level: GatewayConfig['logLevel']): (() => Promise<Provider>) | undefined {
  const table: Record<string, () => Promise<Provider>> = {
    buddy: () => createBuddyProvider({ product: CODEBUDDY, dataDir: dir, logLevel: level }),
    workbuddy: () => createBuddyProvider({ product: WORKBUDDY, dataDir: dir, logLevel: level }),
    trae: () => createTraeProvider({ dataDir: dir, logLevel: level }),
    qoder: () => createQoderProvider({ dataDir: dir, logLevel: level }),
    qodercn: () => createQoderCnProvider(dir, level),
    codearts: () => CodeArtsProvider.create(dir, level),
    lobsterai: () => createLobsteraiProvider(dir, level),
    cline: () => createClineProvider(dir, level),
    loomy: () => createLoomyProvider(dir, level),
    raccoon: () => createRaccoonProvider(dir, level),
    minimax: () => createMinimaxProvider(dir, level),
    zcode: () => createZcodeProvider(dir, level),
  }
  return table[id]
}

/**
 * 按 id 创建单个供应商（供运行时热启用用）。
 * 与 createProviders 共用同一张工厂表，避免两处走样。
 */
export async function createProviderById(config: GatewayConfig, id: string): Promise<Provider> {
  if (catalogEntry(id) === undefined) throw new Error(`未知供应商 ${id}`)
  const factory = factoryFor(id, config.dataDir, config.logLevel)
  if (factory === undefined) throw new Error(`供应商 ${id} 没有创建工厂`)
  return factory()
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
