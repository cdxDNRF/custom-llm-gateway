/**
 * 供应商注册表：按配置创建并持有各供应商实例。
 *
 * "每个供应商各自包装"在代码结构上的体现：这里只是**组装**，
 * 每个供应商的实现、账号池、凭据、端口都在各自的模块与目录里。
 */
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { CODEBUDDY, WORKBUDDY } from '../../vendor/src/product.js'
import { createBuddyProvider } from './buddy.js'
import { createTraeProvider } from './trae.js'
import { createQoderProvider } from './qoder.js'
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

export async function loadConfig(): Promise<GatewayConfig> {
  const home = process.env.GATEWAY_HOME ?? resolve(process.env.HOME ?? '.', '.dsh-llm-gateway')
  const dataDir = resolve(home)
  mkdirSync(dataDir, { recursive: true })

  const configPath = resolve(dataDir, 'config.json')
  const { existsSync, readFileSync, writeFileSync } = await import('node:fs')

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

  return {
    dataDir,
    logLevel: parsed.logLevel ?? DEFAULT_CONFIG.logLevel,
    webPort: parsed.webPort ?? DEFAULT_CONFIG.webPort,
    providers: { ...DEFAULT_CONFIG.providers, ...(parsed.providers ?? {}) },
  }
}

/** 默认配置：四个供应商各占一个端口（CodeArts/LobsterAI 等暂不纳入，见 README）。 */
export const DEFAULT_CONFIG: GatewayConfig = {
  dataDir: '',
  logLevel: 'info',
  webPort: 8790,
  providers: {
    buddy: { enabled: true, port: 3901 },
    workbuddy: { enabled: true, port: 3902 },
    trae: { enabled: true, port: 3903 },
    qoder: { enabled: true, port: 3904 },
  },
}

/** 创建全部已启用的供应商。 */
export async function createProviders(config: GatewayConfig): Promise<Provider[]> {
  const providers: Provider[] = []
  const entry = (id: string): ProviderEntryConfig | undefined => config.providers[id]

  if (entry('buddy')?.enabled) {
    providers.push(
      await createBuddyProvider({ product: CODEBUDDY, dataDir: config.dataDir, logLevel: config.logLevel }),
    )
  }
  if (entry('workbuddy')?.enabled) {
    providers.push(
      await createBuddyProvider({ product: WORKBUDDY, dataDir: config.dataDir, logLevel: config.logLevel }),
    )
  }
  if (entry('trae')?.enabled) {
    providers.push(await createTraeProvider({ dataDir: config.dataDir, logLevel: config.logLevel }))
  }
  if (entry('qoder')?.enabled) {
    providers.push(await createQoderProvider({ dataDir: config.dataDir, logLevel: config.logLevel }))
  }

  return providers
}
