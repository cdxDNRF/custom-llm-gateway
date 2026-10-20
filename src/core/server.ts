/**
 * 总览服务：Web 控制台 + 聚合端点。
 *
 * 与"每个供应商各自一个端口"的分工：
 *   - 本服务（默认 8790）负责**管理与聚合**：账号、登录、签到、积分、模型开关、
 *     以及一个"所有供应商模型"的合并列表（前缀 `provider/model`）。
 *   - 各供应商端口（3901…）是**纯 OpenAI 兼容端点**，供客户端直接接入。
 *
 * 这样用户可以"只配一个 baseURL 用全部模型"，也可以"每个供应商单独接"。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectCompletion, streamChunksToSse, toGenerateOptions, type OpenAiChatRequest,
  type OpenAiMessage,
} from './protocol.js'
import { recentLogs } from './logger.js'
import { lanAddresses } from './net.js'
import { corsHeaders } from './cors.js'
import { tapUsage, type StreamUsage, type UsageStore } from './usage.js'
import type { BuildRelay } from './build-relay.js'
import {
  anthropicToOpenAiRequest,
  streamChunksToAnthropicSse,
  openAiCompletionToAnthropic,
  type AnthropicMessagesRequest,
} from './anthropic.js'
import type { Provider } from './provider.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB_DIR = join(HERE, '..', '..', 'web')

export interface OverviewServerOptions {
  providers: Provider[]
  port: number
  host?: string
  /**
   * 访问令牌（`Bearer` 语义）。非空时管理 API 与聚合端点都要求携带，
   * **但来自回环地址的请求豁免**（见 `authorized`）。
   */
  accessToken?: string
  /** 各供应商的监听端口，用于在 Web UI 上显示接入地址。 */
  providerPorts: Record<string, number>
  /** 数据目录（读写 config.json 实现开关持久化）。 */
  dataDir: string
  /** 运行时管理器：让启用/停用立即生效（热插拔）。 */
  runtime?: ProviderRuntime
  /** 用量统计（记录每次调用的模型/token/耗时）。 */
  usage?: UsageStore
  /**
   * Build 渠道的 WebSocket 中继。
   *
   * ⚠️ 与 provider 侧是**同一个实例**（进程级单例，见 `build.ts`）——
   * 否则 server 收到连接 A、provider 往 B 发请求，症状是"已连接但请求超时"。
   */
  buildRelay?: BuildRelay
  /**
   * 模型目录保鲜器（供 `/api/catalog-status` 观察各家的最近刷新结果）。
   *
   * ⚠️ 只用于**观测**：刷新本身由 `main.ts` 里的定时器驱动，不由 HTTP 触发
   *    （否则一次页面刷新就可能打一批上游请求）。
   */
  catalogRefresher?: { lastResults(): readonly { provider: string; ok: boolean; count: number; error?: string }[] }
  /**
   * 渠道原生搜索的**总开关**（Web UI 上的开关）。
   *
   * ⚠️ 传**函数**而不是布尔值：用户在界面上切换后必须**立即生效**，
   *    不能被启动时的快照钉死（与 Jet Hub 的 `nativeWebSearchEnabled()` 同一取舍）。
   */
  nativeSearchEnabled?: () => boolean
  /** 日志出口（info 级）。 */
  catalogInfo?: (message: string) => void
  /** 日志出口（warn 级）。 */
  catalogWarn?: (message: string) => void
}

import type { ProviderRuntime } from './provider-runtime.js'

const MAX_BODY_BYTES = 32 * 1024 * 1024

/**
 * 判断一个远端地址是否属于本机回环。
 *
 * 覆盖 Node 可能给出的几种写法：
 *   - `127.0.0.1` / `127.x.x.x`（整个 127/8 都是回环）
 *   - `::1`（IPv6 回环）
 *   - `::ffff:127.0.0.1`（IPv4-mapped IPv6，双栈监听时最常见）
 *
 * ⚠️ 不要用 `=== '127.0.0.1'` 判断：在 `host: '0.0.0.0'` 的双栈监听下，
 * Node 常把本机连接报成 `::ffff:127.0.0.1` 或 `::1`，那样回环豁免会失效。
 */
function isLoopback(address: string | undefined): boolean {
  if (address === undefined) return false
  if (address === '::1') return true
  const ipv4 = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  return /^127\./.test(ipv4)
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'access-control-allow-origin': '*',
  })
  response.end(text)
}

export class OverviewServer {
  private server: Server | undefined
  /** 启动时创建的固定集合（无 runtime 时的回落）。 */
  private readonly providers: Provider[]
  private readonly port: number
  private readonly host: string
  private readonly accessToken: string | undefined
  private readonly providerPorts: Record<string, number>
  private readonly dataDir: string
  private readonly runtime: ProviderRuntime | undefined
  private readonly usage: UsageStore | undefined
  /** Build 渠道的 WebSocket 中继（可选；未启用时为 undefined）。 */
  private buildRelay: BuildRelay | undefined
  private readonly catalogRefresher: OverviewServerOptions['catalogRefresher']
  private readonly nativeSearchEnabled: (() => boolean) | undefined
  private readonly catalogInfo: ((message: string) => void) | undefined
  private readonly catalogWarn: ((message: string) => void) | undefined

  constructor(options: OverviewServerOptions) {
    this.providers = options.providers
    this.port = options.port
    this.host = options.host ?? '127.0.0.1'
    this.accessToken = options.accessToken
    this.providerPorts = options.providerPorts
    this.dataDir = options.dataDir
    this.runtime = options.runtime
    this.usage = options.usage
    this.buildRelay = options.buildRelay
    this.catalogRefresher = options.catalogRefresher
    this.nativeSearchEnabled = options.nativeSearchEnabled
    this.catalogInfo = options.catalogInfo
    this.catalogWarn = options.catalogWarn
  }

  get baseUrl(): string {
    return `http://${this.host}:${this.port}`
  }

  /**
   * 是否放行该请求。
   *
   * ## 回环豁免（重要，且必须谨慎）
   *
   * 令牌校验**跳过来自 `127.0.0.1` / `::1` 的请求**。原因：控制台前端是静态
   * 页面，浏览器不可能自动带上令牌；若回环也要令牌，用户在本机打开
   * `http://127.0.0.1:8790/` 会直接看到 401，连"在哪填令牌"都不知道。
   *
   * ⚠️ **Tailscale serve 与 Funnel 的反代都以 127.0.0.1 转发到本机**，会让
   * 远程请求的 `remoteAddress` 变成回环地址。若无条件按回环放行，等于给
   * 经 Tailscale 进来的请求**全部免令牌**——这是真实发生过的漏洞（实测：
   * 匿名经 Funnel 访问 /v1/models 与 /api/overview 均返回 200）。
   *
   * 因此回环豁免必须叠加一个判据：**带 Tailscale 身份头（Tailscale-User-Login）
   * 的请求是经 Tailscale 反代转发来的远程请求，不得享受回环豁免**，必须走
   * 令牌校验。这样：
   *   - 本机直接访问（127.0.0.1，无身份头）→ 豁免，浏览器免令牌开控制台
   *   - 经 Tailscale serve/funnel 进来（带身份头，哪怕 remoteAddress 是回环）
   *     → 强制令牌
   *
   * ## 支持两种携带方式
   *
   * - `Authorization: Bearer <token>`（OpenAI 客户端 / 酒馆 / curl）
   * - `?token=<token>` 查询参数（便于浏览器直接打开控制台）
   */
  private authorized(request: IncomingMessage, url: URL): boolean {
    if (this.accessToken === undefined) return true
    // 带 Tailscale 身份头 = 远程转发来的请求，不享受回环豁免。
    const isTailscaleForwarded = this.isTailscaleForwarded(request)
    if (isLoopback(request.socket.remoteAddress) && !isTailscaleForwarded) return true

    const header = request.headers.authorization
    if (typeof header === 'string') {
      const match = /^Bearer\s+(.+)$/i.exec(header.trim())
      if (match?.[1] === this.accessToken) return true
    }
    // 浏览器直开控制台时的退路（前端会把它转存到 localStorage 后重定向）。
    const queryToken = url.searchParams.get('token')
    return queryToken === this.accessToken
  }

  /**
   * 请求是否经 Tailscale 反代（serve 或 funnel）转发而来。
   *
   * tailscaled 反代时会在请求头注入 Tailscale 身份信息，实测字段：
   *   `Tailscale-Headers-Info`, `Tailscale-User-Login`, `Tailscale-User-Name`,
   *   `X-Forwarded-For`, `X-Forwarded-Proto` 等。
   *
   * 判据用 `Tailscale-User-Login`（存在即代表经 Tailscale 转发、有身份）。
   * 注意 Funnel（公网匿名）访问**不带** User-Login，但 B-1 方案只开 serve
   * （tailnet-only），公网根本进不来，所以这里只需覆盖 serve 场景。
   * 若将来再开 funnel，需另行按「缺身份头 + 反代来源」补强。
   */
  private isTailscaleForwarded(request: IncomingMessage): boolean {
    return request.headers['tailscale-user-login'] !== undefined
  }

  async start(): Promise<void> {
    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        if (!response.headersSent) sendJson(response, 500, { error: String(error) })
        else response.end()
      })
    })
    this.server = server

    // ── Build 渠道：把 WebSocket upgrade 挂到同一个 server 上 ──
    //
    // ⚠️ 必须**复用网关端口**（不另开一个）：App 页面里的 URL 由用户在
    //    Web UI 上复制，多一个端口就多一处配错的地方。WebSocket 走 `upgrade`
    //    事件、普通请求走 `request` 事件，两者在同一端口天然共存。
    //
    // ⚠️ relay 实例是**进程级单例**（见 build.ts 的 `buildRelayFor`）——
    //    server 挂的监听与 provider 发请求必须是同一个对象，否则
    //    "页面显示 Connected 但请求永远超时"。
    if (this.buildRelay !== undefined) {
      this.buildRelay.attach(server)
    }

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.port, this.host, () => {
        server.off('error', reject)
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    const server = this.server
    if (server === undefined) return
    this.server = undefined
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /**
   * 某供应商的端口。
   *
   * ⚠️ 必须优先问 runtime：`providerPorts` 是 main.ts 启动时的**快照**，
   * 热启用起来的供应商不在其中——直接读它会得到 undefined，前端就渲染成
   * 「已启用但没有地址」（端口 —、底部列表显示未启动）。这是实际发生过的 bug。
   */
  private portFor(id: string, fallback?: number): number | undefined {
    if (this.runtime?.isListening(id) === true) return this.runtime.portOf(id)
    return this.providerPorts[id] ?? fallback
  }

  /**
   * 当前**实际在运行**的供应商集合。
   * 有 runtime 时以它为准（热启用/停用后立即正确）；否则回落启动时集合。
   */
  private liveProviders(): Provider[] {
    return this.runtime?.currentProviders() ?? this.providers
  }

  private findProvider(id: string): Provider | undefined {
    return this.liveProviders().find((p) => p.id === id)
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.baseUrl)
    const path = url.pathname

    if (request.method === 'OPTIONS') {
      response.writeHead(204, corsHeaders(request))
      response.end()
      return
    }

    // ─────────── 静态前端（**不加鉴权**）───────────
    //
    // 顺序很重要：静态资源必须在鉴权之前返回。否则手机打开
    // `http://<局域网IP>:8790/` 会直接收到 401 JSON，页面上连"在哪填令牌"
    // 的入口都没有，用户会以为服务坏了。
    //
    // 静态文件只有 HTML/CSS/JS 三个壳，不含任何凭据或账号数据，公开无风险。
    if (request.method === 'GET' && (path === '/' || path === '/index.html')) {
      this.serveFile(response, join(WEB_DIR, 'index.html'), 'text/html; charset=utf-8')
      return
    }
    if (request.method === 'GET' && path.startsWith('/static/')) {
      const name = path.slice('/static/'.length)
      // 防目录穿越：只允许简单文件名。
      if (!/^[\w.-]+$/.test(name)) {
        sendJson(response, 400, { error: 'bad path' })
        return
      }
      const ext = name.split('.').pop() ?? ''
      const mime = ext === 'css' ? 'text/css; charset=utf-8'
        : ext === 'js' ? 'application/javascript; charset=utf-8'
          : 'application/octet-stream'
      this.serveFile(response, join(WEB_DIR, name), mime)
      return
    }

    // ─────────── 鉴权（局域网访问时必需；回环豁免）───────────
    if (!this.authorized(request, url)) {
      sendJson(response, 401, {
        error: {
          message: 'unauthorized: 缺少或错误的访问令牌。'
            + '请在请求头带上 Authorization: Bearer <token>（令牌见启动日志或 config.json 的 accessToken 字段）。',
          type: 'unauthorized',
          code: 'unauthorized',
        },
      })
      return
    }

    // ─────────── 管理 API ───────────
    if (path === '/api/overview' && request.method === 'GET') {
      await this.apiOverview(response)
      return
    }
    // ── 供应商启动开关：**立即生效**（热插拔），同时写 config.json 持久化 ──
    //
    // 第一版只写配置并要求重启，用户的反馈是「有启用没有关闭」——停用根本
    // 无处可点。现在真的启停：停用会释放端口，启用会立刻建实例并监听。
    if (path === '/api/config/enable' && request.method === 'POST') {
      const body = await this.safeJson(request)
      const id = String(body.id ?? '')
      const enabled = body.enabled !== false
      if (id.length === 0) {
        sendJson(response, 400, { error: '缺少 id' })
        return
      }
      try {
        const { setProviderEnabled } = await import('../providers/registry.js')
        const { catalogEntry } = await import('../providers/catalog.js')
        const entryInfo = catalogEntry(id)
        if (entryInfo === undefined) {
          sendJson(response, 400, { error: `未知供应商 ${id}` })
          return
        }
        // 先落盘（重启后仍是用户选的状态），再热切换运行时。
        await setProviderEnabled(this.dataDir, id, enabled)
        let applied: 'running' | 'stopped' | 'config-only' = 'config-only'
        if (this.runtime !== undefined) {
          if (enabled) {
            await this.runtime.enable(id)
            applied = 'running'
          } else {
            await this.runtime.disable(id)
            applied = 'stopped'
          }
        }
        const note =
          applied === 'running' ? '已启用并立即开始监听'
          : applied === 'stopped' ? '已停用，端口已释放'
          : '已写入配置（重启网关后生效）'
        sendJson(response, 200, { ok: true, id, enabled, applied, note })
      } catch (error) {
        sendJson(response, 400, { error: String(error) })
      }
      return
    }

    // ── 全局一键签到：把所有「支持签到且正在运行」的供应商一次签完 ──
    //
    // 各卡片原本已有单家「一键签到」，但用户需要一个总入口（对齐 DSH 插件）。
    // 语义要点：
    //   - 只签能签的（capabilities.dailyCheckin 且已启用），不因个别失败中断
    //   - 汇总每家的 ok/status/message，前端能逐条展示
    //   - already-claimed 视为成功（幂等：今天已领也算好结果）
    if (path === '/api/checkin-all' && request.method === 'POST') {
      const results: {
        id: string
        displayName: string
        ok: boolean
        status: string
        message?: string
        amount?: number
      }[] = []
      for (const p of this.liveProviders()) {
        if (p.capabilities.dailyCheckin !== true) continue
        try {
          const r = await p.checkin()
          results.push({
            id: p.id,
            displayName: p.displayName,
            ok: r.ok,
            status: r.status,
            ...(r.message ? { message: r.message } : {}),
            ...(r.amount !== undefined ? { amount: r.amount } : {}),
          })
        } catch (error) {
          // 单家异常不影响其余。
          results.push({
            id: p.id,
            displayName: p.displayName,
            ok: false,
            status: 'failed',
            message: String(error),
          })
        }
      }
      const claimed = results.filter((r) => r.ok).length
      sendJson(response, 200, { ok: true, total: results.length, claimed, results })
      return
    }

    if (path === '/api/models/refresh-all' && request.method === 'POST') {
      // 一键重拉全部供应商的模型目录（对应「上游更新了模型」的场景）。
      const results: Record<string, unknown> = {}
      for (const p of this.liveProviders()) {
        try {
          results[p.id] = await p.refreshModels()
        } catch (error) {
          results[p.id] = { error: String(error) }
        }
      }
      sendJson(response, 200, { ok: true, results })
      return
    }

    if (path === '/api/logs' && request.method === 'GET') {
      sendJson(response, 200, { logs: recentLogs(300) })
      return
    }

    // ── 渠道原生搜索：开关读写 + 能力查询（Web UI 的开关）──
    if (path === '/api/native-search' && request.method === 'GET') {
      const { NATIVE_SEARCH_PROVIDERS } = await import('./native-search.js')
      const { readNativeSearchEnabled } = await import('../providers/registry.js')
      sendJson(response, 200, {
        enabled: readNativeSearchEnabled(this.dataDir),
        providers: [...NATIVE_SEARCH_PROVIDERS],
      })
      return
    }
    if (path === '/api/native-search' && request.method === 'POST') {
      let body: { enabled?: unknown } = {}
      try { body = JSON.parse(await readBody(request)) as typeof body } catch { body = {} }
      const { setNativeSearchEnabled, readNativeSearchEnabled } = await import('../providers/registry.js')
      setNativeSearchEnabled(this.dataDir, body.enabled === true)
      sendJson(response, 200, { ok: true, enabled: readNativeSearchEnabled(this.dataDir) })
      return
    }

    // ── 模型目录保鲜状态（观测用）──
    if (path === '/api/catalog-status' && request.method === 'GET') {
      sendJson(response, 200, {
        results: this.catalogRefresher?.lastResults() ?? [],
      })
      return
    }

    // ── Build 渠道：连接控制（Web UI 的「连接 / 断开」）──
    //
    // ⚠️ 语义是「是否接受 App 连接」，不是"开关端口"（端口与网关共用）。
    //    断开时 App 会收到 403、显示 Disconnected（符合用户预期）。
    if (path === '/api/build/status' && request.method === 'GET') {
      const relay = this.buildRelay
      const { readBuildAppUrl } = await import('../providers/registry.js')
      sendJson(response, 200, relay === undefined
        ? { enabled: false, appUrl: readBuildAppUrl(this.dataDir) }
        : { enabled: true, appUrl: readBuildAppUrl(this.dataDir), ...relay.status() })
      return
    }
    // 保存/清空 App 链接（Build 页的输入框）。
    if (path === '/api/build/app-url' && request.method === 'POST') {
      let body: { url?: unknown } = {}
      try { body = JSON.parse(await readBody(request)) as typeof body } catch { body = {} }
      const url = typeof body.url === 'string' ? body.url : ''
      const { setBuildAppUrl } = await import('../providers/registry.js')
      const result = setBuildAppUrl(this.dataDir, url)
      // ⚠️ 错误用 `{ error: '...' }` 形状（与其它接口一致）——前端 `api()`
      //    读的是 `body.error`，用 `reason` 会退化成显示 "HTTP 400"（实测踩到）。
      sendJson(response, result.ok ? 200 : 400,
        result.ok ? { ok: true, url } : { error: result.reason })
      return
    }
    if (path === '/api/build/connect' && request.method === 'POST') {
      if (this.buildRelay === undefined) {
        sendJson(response, 400, { error: 'Build 渠道未启用（请先在「供应商」页启用它）' })
        return
      }
      let body: { connected?: unknown } = {}
      try { body = JSON.parse(await readBody(request)) as typeof body } catch { body = {} }
      const want = body.connected !== false
      this.buildRelay.setAccepting(want)
      sendJson(response, 200, { ok: true, ...this.buildRelay.status() })
      return
    }

    // ── 用量统计 ──
    //
    // 只记**元数据**（模型/token/耗时/状态），不记请求与响应正文（见 usage.ts）。
    if (path === '/api/usage' && request.method === 'GET') {
      if (this.usage === undefined) {
        sendJson(response, 200, { enabled: false })
        return
      }
      const url = new URL(request.url ?? '/', this.baseUrl)
      const recent = Number(url.searchParams.get('recent') ?? '50')
      sendJson(response, 200, {
        enabled: true,
        file: this.usage.path,
        bytes: this.usage.bytes(),
        size: this.usage.size,
        ...this.usage.summary(Number.isFinite(recent) && recent > 0 ? Math.min(recent, 500) : 50),
      })
      return
    }
    // 清空统计：文件会被**重命名备份**而非删除，避免误点丢数据。
    if (path === '/api/usage/clear' && request.method === 'POST') {
      if (this.usage === undefined) {
        sendJson(response, 200, { ok: true, removed: 0 })
        return
      }
      const result = this.usage.clear()
      sendJson(response, 200, { ok: true, ...result })
      return
    }

    // /api/p/<id>/...
    const match = /^\/api\/p\/([a-z0-9-]+)\/(.+)$/.exec(path)
    if (match) {
      const [, providerId, action] = match
      const provider = this.findProvider(providerId)
      if (!provider) {
        sendJson(response, 404, { error: `未知供应商 ${providerId}` })
        return
      }
      await this.handleProviderAction(request, response, provider, action, url)
      return
    }

    // ─────────── 聚合 OpenAI 端点（可选：一次接入全部供应商）───────────
    if (path === '/v1/models' && request.method === 'GET') {
      await this.aggregateModels(response)
      return
    }
    if (path === '/v1/chat/completions' && request.method === 'POST') {
      await this.aggregateChat(request, response)
      return
    }
    // ── Anthropic Messages 协议（Claude 系客户端：Claude Code / Cline / 部分酒馆）──
    //
    // 与 OpenAI 端点并存，同一套供应商管线。模型写法同样是 `供应商/模型`。
    if (path === '/v1/messages' && request.method === 'POST') {
      await this.aggregateMessages(request, response)
      return
    }

    sendJson(response, 404, { error: `未知路径 ${path}` })
  }

  private serveFile(response: ServerResponse, file: string, mime: string): void {
    if (!existsSync(file)) {
      sendJson(response, 404, { error: `缺少文件 ${file}` })
      return
    }
    const body = readFileSync(file)
    response.writeHead(200, { 'content-type': mime, 'content-length': body.length })
    response.end(body)
  }

  private async apiOverview(response: ServerResponse): Promise<void> {
    const { PROVIDER_CATALOG } = await import('../providers/catalog.js')
    const { readProviderEnabled } = await import('../providers/registry.js')
    const byId = new Map(this.liveProviders().map((p) => [p.id, p]))
    const providers = await Promise.all(
      PROVIDER_CATALOG.map(async (entry) => {
        const p = byId.get(entry.id)
        if (p === undefined) {
          // 未启用的供应商：来自目录，capabilities 用占位（前端只显示开关与说明）
          return {
            id: entry.id,
            displayName: entry.displayName,
            note: entry.note,
            enabledInConfig: readProviderEnabled(this.dataDir, entry.id) ?? entry.defaultEnabled,
            running: false,
            capabilities: null,
            port: this.portFor(entry.id, entry.defaultPort),
            baseUrl: null,
            accounts: [],
            permanentLocked: false,
          }
        }
        return this.describeProvider(p)
      }),
    )

    // ── 局域网接入信息（**每次请求实时计算**）──
    //
    // ⚠️ 绝对不能在启动时算一次就缓存：校园网 IP 会变（DHCP 续租、换楼层、
    // 换热点）。缓存下来的旧地址格式完全正常，只是没人应答——用户照着填
    // 进手机会"静默连不上"，是最难排查的一类问题。
    //
    // 所以这里每次请求都重新读网卡，前端 20 秒轮询一次，IP 一变就能看到。
    const lan = lanAddresses()
    sendJson(response, 200, {
      providers,
      // 手机/平板该填的地址（由服务端探测，浏览器无法得知电脑的网卡 IP）
      lan: {
        addresses: lan,
        port: this.port,
        host: this.host,
        // 是否真的开放了局域网（不然前端会提示"仅本机"）
        exposed: this.host !== '127.0.0.1' && this.host !== 'localhost' && this.host !== '::1',
        // 令牌固定不变，这里回传给前端便于一键复制（回环访问已通过鉴权，
        // 且局域网访问本就需要令牌才能拿到本响应）。
        ...(this.accessToken !== undefined ? { accessToken: this.accessToken } : {}),
      },
    })
  }

  private async describeProvider(p: Provider): Promise<unknown> {
    {
      {
        let accounts: unknown[] = []
        let accountsError: string | undefined
        try {
          accounts = await p.listAccounts()
        } catch (error) {
          accountsError = String(error)
        }
        const port = this.portFor(p.id)
        return {
          id: p.id,
          displayName: p.displayName,
          note: '',
          enabledInConfig: true,
          running: true,
          capabilities: p.capabilities,
          permanentLocked: p.capabilities.permanentLock ? p.permanentLocked() : false,
          port: this.portFor(p.id) ?? null,
          // ⚠️ 供应商端口按设计**恒绑回环**（见 README 的"只开放聚合端点"决定），
          // 故这里始终显示 127.0.0.1：局域网访问统一走 8790 聚合端点。
          baseUrl: port !== undefined ? `http://127.0.0.1:${port}/v1` : null,
          accounts,
          ...(accountsError ? { accountsError } : {}),
        }
      }
    }
  }

  private async handleProviderAction(
    request: IncomingMessage,
    response: ServerResponse,
    provider: Provider,
    action: string,
    url: URL,
  ): Promise<void> {
    if (action === 'accounts' && request.method === 'GET') {
      sendJson(response, 200, { accounts: await provider.listAccounts() })
      return
    }

    if (action === 'login' && request.method === 'POST') {
      const body = request.method === 'POST' ? await this.safeJson(request) : {}
      const nickname = typeof body.nickname === 'string' ? body.nickname : undefined
      const started = await provider.startLogin(nickname)
      // ⚠️ 立即返回 URL（两步式）：后台继续等授权回调。
      // 前端拿到后会 window.open，然后再轮询 /accounts 看结果。
      // ⚠️ `input` 必须一并透传：有它时前端弹输入框（而非开窗口），
      //    漏传会让「填 Key」型登录退化成打开一个空 URL（真实缺陷）。
      sendJson(response, 200, {
        loginUrl: started.loginUrl,
        accountId: started.accountId,
        ...(started.input !== undefined ? { input: started.input } : {}),
      })
      return
    }

    // ── 提交「填文本」型登录（OpenCode API Key 等）──
    if (action === 'login/submit' && request.method === 'POST') {
      let parsed: { value?: unknown } = {}
      try {
        parsed = JSON.parse(await readBody(request)) as { value?: unknown }
      } catch {
        sendJson(response, 400, { error: '请求体不是合法 JSON' })
        return
      }
      const value = typeof parsed.value === 'string' ? parsed.value : ''
      if (provider.submitLogin === undefined) {
        sendJson(response, 400, { error: `${provider.displayName} 不支持填写式登录` })
        return
      }
      const result = await provider.submitLogin({ value })
      sendJson(response, result.ok ? 200 : 400, result)
      return
    }

    if (action === 'accounts' && request.method === 'DELETE') {
      const id = url.searchParams.get('id')
      if (!id) {
        sendJson(response, 400, { error: '缺少 id' })
        return
      }
      await provider.removeAccount(id)
      sendJson(response, 200, { ok: true })
      return
    }

    if (action === 'enable' && request.method === 'POST') {
      const body = await this.safeJson(request)
      const id = String(body.id ?? '')
      const enabled = body.enabled !== false
      if (!id) {
        sendJson(response, 400, { error: '缺少 id' })
        return
      }
      await provider.setAccountEnabled(id, enabled)
      sendJson(response, 200, { ok: true })
      return
    }

    if (action === 'balance' && request.method === 'GET') {
      const balance = await provider.queryBalance()
      sendJson(response, 200, { balance: balance ?? null })
      return
    }

    if (action === 'checkin' && request.method === 'POST') {
      const result = await provider.checkin()
      sendJson(response, 200, { result })
      return
    }

    if (action === 'refresh' && request.method === 'POST') {
      await provider.refreshAll()
      sendJson(response, 200, { ok: true })
      return
    }

    if (action === 'models' && request.method === 'GET') {
      // 用 listModelsWithState（含启用状态）；带 ?enabled=1 时只返回启用的
      // （client-facing 语义，与 /v1/models 一致）。
      const models = await provider.listModelsWithState()
      const onlyEnabled = url.searchParams.get('enabled') === '1'
      sendJson(response, 200, { models: onlyEnabled ? models.filter((m) => m.enabled) : models })
      return
    }

    // ── 模型管理（对齐 DSH 插件 model.* 端点）──
    if (action === 'model/toggle' && request.method === 'POST') {
      const body = await this.safeJson(request)
      const id = String(body.id ?? '')
      if (!id) {
        sendJson(response, 400, { error: '缺少 id' })
        return
      }
      await provider.setModelDisabled(id, body.disabled !== false)
      sendJson(response, 200, { ok: true })
      return
    }

    if (action === 'model/toggleMany' && request.method === 'POST') {
      const body = await this.safeJson(request)
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : []
      if (ids.length === 0) {
        sendJson(response, 400, { error: '缺少 ids' })
        return
      }
      await provider.setModelsDisabled(ids, body.disabled !== false)
      sendJson(response, 200, { ok: true })
      return
    }

    if (action === 'model/enableAll' && request.method === 'POST') {
      await provider.clearAllModelsDisabled()
      sendJson(response, 200, { ok: true })
      return
    }

    // ── 强制重拉上游模型目录（解决「上游新增模型，网关要重启才可见」）──
    if (action === 'models/refresh' && request.method === 'POST') {
      const result = await provider.refreshModels()
      sendJson(response, 200, { ok: true, ...result })
      return
    }

    // ── 账号进阶操作 ──
    if (action === 'accounts/reorder' && request.method === 'POST') {
      const body = await this.safeJson(request)
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : []
      await provider.reorderAccounts(ids)
      sendJson(response, 200, { ok: true })
      return
    }

    if (action === 'accounts/reset' && request.method === 'POST') {
      const body = await this.safeJson(request)
      const id = typeof body.id === 'string' && body.id.length > 0 ? body.id : undefined
      const result = await provider.resetRateLimits(id)
      sendJson(response, 200, { result })
      return
    }

    if (action === 'accounts/retest' && request.method === 'POST') {
      const body = await this.safeJson(request)
      const id = typeof body.id === 'string' && body.id.length > 0 ? body.id : undefined
      const result = await provider.retest(id)
      sendJson(response, 200, { result })
      return
    }

    // ── 永久积分锁 ──
    if (action === 'permanentLock' && request.method === 'GET') {
      sendJson(response, 200, { locked: provider.permanentLocked() })
      return
    }

    if (action === 'permanentLock' && request.method === 'POST') {
      const body = await this.safeJson(request)
      await provider.setPermanentLocked(body.locked === true)
      sendJson(response, 200, { ok: true, locked: provider.permanentLocked() })
      return
    }

    sendJson(response, 404, { error: `未知操作 ${action}` })
  }

  private async safeJson(request: IncomingMessage): Promise<Record<string, unknown>> {
    try {
      const text = await readBody(request)
      if (text.trim().length === 0) return {}
      const parsed = JSON.parse(text) as unknown
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }

  // ─────────── 聚合端点 ───────────

  private async aggregateModels(response: ServerResponse): Promise<void> {
    const data: unknown[] = []
    const created = Math.floor(Date.now() / 1000)
    for (const provider of this.liveProviders()) {
      try {
        const models = await provider.adapter.listModels(provider.id)
        for (const model of models) {
          data.push({
            id: `${provider.id}/${model.id}`,
            object: 'model',
            created,
            owned_by: provider.id,
          })
        }
      } catch (error) {
        // ⚠️⚠️ **必须记日志**（真实缺陷，2026-10-18 用户报障"buddy 没了"）：
        //    原先这里是一个**完全静默**的 `catch {}` —— 某家供应商的
        //    `listModels` 一旦抛错，它的模型就会从聚合列表里**无声消失**，
        //    而 UI 上供应商卡片显示 `running: True`、自己的端口也列得出模型。
        //
        //    症状极具误导性：用户以为"供应商没开"，实际是聚合时抛错被吞了。
        //    故这里至少要把 `provider.id` 与错误原因写进日志。
        // 通过供应商自己的 logger 记（它会进 Web UI 的日志面板）。
        try {
          provider.gateway.logger.warn(
            `聚合模型列表：本家 listModels 抛错，模型已被跳过 —— ${String(error)}`,
          )
        } catch {
          console.warn(`[aggregateModels] ${provider.id} listModels 失败：${String(error)}`)
        }
      }
    }
    sendJson(response, 200, { object: 'list', data })
  }

  /**
   * **渠道原生搜索**：把客户端声明的 `web_search` 工具变成真实搜索。
   *
   * @returns `undefined` 表示「不接管」（保持原请求逐字节不变）；
   *          否则返回注入搜索结果后的 message 列表。
   *
   * ⚠️ **失败绝不中断对话**：搜索失败时把失败原因也注入上下文，让模型知道
   *    "搜索没成功"，从而改用其它方式回答 —— 而不是让整个请求 500。
   */
  private async maybeRunNativeSearch(
    provider: Provider,
    providerId: string,
    body: OpenAiChatRequest,
  ): Promise<{ messages: OpenAiMessage[]; toolName: string } | undefined> {
    // 临时诊断：记录客户端传来的工具名（定位 zcode 为何不生效）
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      const names = (body.tools as unknown[]).map((t) => {
        if (typeof t !== 'object' || t === null) return '?'
        const r = t as { name?: unknown; function?: { name?: unknown } }
        return typeof r.name === 'string' ? r.name
          : typeof r.function?.name === 'string' ? r.function.name : '?'
      })
      this.catalogInfo?.(`[tools] ${providerId} ← ${names.join(', ')}`)
    }

    // ① 用户开关（Web UI）
    if (this.nativeSearchEnabled?.() !== true) return undefined
    // ② 该渠道支持原生搜索（能力表见 native-search.ts）
    const { NATIVE_SEARCH_PROVIDERS, pickSearchTool, nativeSearch, buildSearchContextMessage } =
      await import('./native-search.js')
    if (!NATIVE_SEARCH_PROVIDERS.has(providerId)) return undefined
    // ③ 客户端真的声明了搜索工具
    const tool = pickSearchTool(body.tools as unknown[] | undefined)
    if (tool === undefined) return undefined
    // 还需要一条 user 文本作为查询
    const query = latestUserText(body.messages)
    if (query.length === 0) return undefined

    const { buildSearchContextMessage: build } = await import('./native-search.js')
    try {
      const sources = await nativeSearch(provider, { query, maxResults: 5 })
      const context = build(query, sources)
      this.catalogInfo?.(`原生搜索（${providerId}）：「${query}」→ ${sources.length} 条结果`)
      // ⚠️ 合并进最后一条 user 消息，**不能**追加一条 role:'system'
      //    （末尾的 system 会被多数上游忽略 —— 实测模型答"我无法获取实时信息"）。
      const { injectSearchIntoMessages } = await import('./native-search.js')
      const messages = injectSearchIntoMessages(body.messages ?? [], context)
      return { messages, toolName: tool.name }
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error)
      this.catalogWarn?.(`原生搜索失败（${providerId}）：${message}`)
      // ⚠️ 失败也注入（说明"搜索没成功"），而不是静默忽略 —— 否则模型会
      //    误以为自己有搜索结果却拿不到，或者直接报错中断对话。
      const { injectSearchIntoMessages } = await import('./native-search.js')
      const messages = injectSearchIntoMessages(
        body.messages ?? [],
        `[网络搜索失败] 网关尝试为该渠道执行原生搜索时失败：${message}\n`
        + '请明确告知用户搜索未能完成，并基于已有知识谨慎回答；不要编造搜索来源。',
      )
      return { messages, toolName: tool.name }
    }
  }

  private async aggregateChat(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const startedAt = Date.now()
    let body: OpenAiChatRequest
    try {
      body = JSON.parse(await readBody(request)) as OpenAiChatRequest
    } catch (error) {
      sendJson(response, 400, { error: { message: `请求体不是合法 JSON：${String(error)}` } })
      return
    }

    const raw = typeof body.model === 'string' ? body.model : ''
    const slash = raw.indexOf('/')
    // 约定：聚合端点上模型必须写成 `provider/model`，避免歧义。
    if (slash <= 0) {
      sendJson(response, 400, {
        error: { message: `在聚合端点上请使用 "供应商/模型" 形式，例如 "buddy/glm-5.3"（当前：${raw}）` },
      })
      return
    }
    const providerId = raw.slice(0, slash)
    const modelId = raw.slice(slash + 1)
    const provider = this.findProvider(providerId)
    if (!provider) {
      sendJson(response, 404, { error: { message: `未知供应商 ${providerId}` } })
      return
    }

    // ── 渠道原生搜索：把客户端的 web_search 工具变成**真实搜索** ──
    //
    // 为什么在这里做（而不是返回 tool_call 让客户端执行）：
    // 酒馆等客户端**没有搜索实现**，返回 tool_call 它执行不了、对话会卡住。
    // 故网关在服务端闭环：先搜 → 把资料作为上下文注入 → 模型基于真实资料回答。
    // 客户端全程无感（仍是一次普通 chat 请求）。
    //
    // ⚠️ 三重门槛，缺一不接管（宁可不生效，也不影响既有链路）：
    //    ① 用户开关打开   ② 该渠道支持原生搜索   ③ 客户端**声明了**搜索工具
    const searchOutcome = await this.maybeRunNativeSearch(provider, providerId, body)
    // ⚠️ 接管后要**把搜索工具从声明里摘掉**（真实缺陷，2026-10-20 实测）：
    //    只注入上下文而不摘工具时，模型看到 `web_search` 仍可用，倾向自己调
    //    （返回 tool_calls），我们注入的资料白费。摘掉后它只能基于资料回答。
    const effectiveBody = searchOutcome === undefined
      ? body
      : {
          ...body,
          messages: searchOutcome.messages,
          tools: stripSearchTools(body.tools, searchOutcome.toolName),
        }

    const generate = toGenerateOptions({ ...effectiveBody, model: modelId }, {
      provider: providerId,
      model: modelId,
      sessionId: `gw-agg-${providerId}-${Date.now().toString(36)}`,
      // ⚠️ **必须传**：Build 渠道默认走「假流式」（上游流式审核严、易截断），
      //    只有客户端显式 stream:true 时才用真流式。
      //    漏传会让这个开关对经聚合端点的调用**完全失效**（实测踩到：
      //    打 8790 时 raw=undefined、始终走假流式，而打 3917 才生效）。
      useNonStream: body.stream !== true,
    })
    const id = `chatcmpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const created = Math.floor(Date.now() / 1000)
    const stream = body.stream === true
    // 用量采集上下文（旁路，见 tapUsage）。
    const tap: StreamUsage = { inputTokens: 0, outputTokens: 0, finished: false }

    let chunks: AsyncIterable<never>
    try {
      chunks = provider.adapter.stream(generate) as AsyncIterable<never>
    } catch (error) {
      this.recordUsage({
        at: startedAt, provider: providerId, model: modelId, api: 'openai', stream,
        ok: false, error: String(error), tap, startedAt,
      })
      sendJson(response, 502, { error: { message: String(error) } })
      return
    }

    const tapped = tapUsage(chunks as AsyncIterable<{ type: string }>, tap) as AsyncIterable<never>

    if (!stream) {
      try {
        const completion = await collectCompletion(tapped, { id, model: raw, created })
        this.recordUsage({
          at: startedAt, provider: providerId, model: modelId, api: 'openai', stream: false,
          ok: true, tap, startedAt, completionUsage: completion.usage,
        })
        sendJson(response, 200, completion)
      } catch (error) {
        this.recordUsage({
          at: startedAt, provider: providerId, model: modelId, api: 'openai', stream: false,
          ok: false, error: String(error), tap, startedAt,
        })
        sendJson(response, 502, { error: { message: String(error) } })
      }
      return
    }

    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
      'x-accel-buffering': 'no',
    })
    try {
      for await (const frame of streamChunksToSse(tapped, { id, model: raw, created })) {
        response.write(frame)
      }
      response.write('data: [DONE]\n\n')
      response.end()
      this.recordUsage({
        at: startedAt, provider: providerId, model: modelId, api: 'openai', stream: true,
        ok: true, tap, startedAt,
      })
    } catch (error) {
      response.write(`data: ${JSON.stringify({ error: { message: String(error) } })}\n\n`)
      response.write('data: [DONE]\n\n')
      response.end()
      this.recordUsage({
        at: startedAt, provider: providerId, model: modelId, api: 'openai', stream: true,
        ok: false, error: String(error), tap, startedAt,
      })
    }
  }

  /**
   * 落一条用量记录。
   *
   * ⚠️ **绝不抛错、绝不 await 阻塞**：统计是旁路，任何异常都不能影响请求。
   * `UsageStore.record` 内部已有 try/catch，这里再包一层是防御未来改动。
   */
  private recordUsage(input: {
    at: number
    provider: string
    model: string
    api: 'openai' | 'anthropic'
    stream: boolean
    ok: boolean
    error?: string
    tap: StreamUsage
    startedAt: number
    /** 非流式时由 collectCompletion 给出的权威 usage（优先于 tap 采集）。 */
    completionUsage?: { prompt_tokens?: number; completion_tokens?: number } | undefined
  }): void {
    if (this.usage === undefined) return
    try {
      const inputTokens = input.completionUsage?.prompt_tokens ?? input.tap.inputTokens
      const outputTokens = input.completionUsage?.completion_tokens ?? input.tap.outputTokens
      this.usage.record({
        at: input.at,
        provider: input.provider,
        model: input.model,
        api: input.api,
        stream: input.stream,
        ok: input.ok,
        ...(input.error !== undefined ? { error: input.error } : {}),
        inputTokens,
        outputTokens,
        ms: Date.now() - input.startedAt,
        ...(input.tap.firstByteAt !== undefined ? { ttftMs: input.tap.firstByteAt - input.startedAt } : {}),
      })
    } catch {
      // 统计失败不影响请求。
    }
  }

  /**
   * `POST /v1/messages`：Anthropic Messages 协议（Claude 系客户端用）。
   *
   * 实现策略：把 Anthropic 请求翻译成内部的 OpenAI 形状 → **复用同一条
   * 供应商管线** → 输出再翻译回 Anthropic 事件/JSON。故适配器、限流换号、
   * 账号池逻辑全部不变（见 `anthropic.ts` 的模块说明）。
   *
   * ⚠️ Anthropic 的错误体形状是 `{type:'error', error:{type,message}}`，
   * 与 OpenAI 的 `{error:{message}}` 不同；Claude 客户端按前者解析，故这里
   * 单独构造。
   */
  private async aggregateMessages(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const sendAnthropicError = (status: number, type: string, message: string): void => {
      sendJson(response, status, { type: 'error', error: { type, message } })
    }

    let body: AnthropicMessagesRequest
    try {
      body = JSON.parse(await readBody(request)) as AnthropicMessagesRequest
    } catch (error) {
      sendAnthropicError(400, 'invalid_request_error', `请求体不是合法 JSON：${String(error)}`)
      return
    }

    const raw = typeof body.model === 'string' ? body.model : ''
    const slash = raw.indexOf('/')
    if (slash <= 0) {
      sendAnthropicError(
        400,
        'invalid_request_error',
        `在聚合端点上请使用 "供应商/模型" 形式，例如 "buddy/glm-5.3"（当前：${raw}）`,
      )
      return
    }
    const providerId = raw.slice(0, slash)
    const modelId = raw.slice(slash + 1)
    const provider = this.findProvider(providerId)
    if (!provider) {
      sendAnthropicError(404, 'not_found_error', `未知供应商 ${providerId}`)
      return
    }

    const openAiBody = anthropicToOpenAiRequest({ ...body, model: modelId })
    const generate = toGenerateOptions(openAiBody, {
      provider: providerId,
      model: modelId,
      sessionId: `gw-msg-${providerId}-${Date.now().toString(36)}`,
      // 同聚合 Chat：Build 渠道默认假流式，需显式传开关。
      useNonStream: openAiBody.stream !== true,
    })
    // Anthropic 的消息 id 惯例是 `msg_` 前缀。
    const id = `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    const startedAt = Date.now()
    const stream = body.stream === true
    const tap: StreamUsage = { inputTokens: 0, outputTokens: 0, finished: false }

    let chunks: AsyncIterable<never>
    try {
      chunks = provider.adapter.stream(generate) as AsyncIterable<never>
    } catch (error) {
      this.recordUsage({
        at: startedAt, provider: providerId, model: modelId, api: 'anthropic', stream,
        ok: false, error: String(error), tap, startedAt,
      })
      sendAnthropicError(502, 'api_error', String(error))
      return
    }

    const tapped = tapUsage(chunks as AsyncIterable<{ type: string }>, tap) as AsyncIterable<never>

    // 非流式：聚合成 OpenAI 完成对象后翻译
    if (!stream) {
      try {
        const completion = await collectCompletion(tapped, { id, model: raw, created: Math.floor(Date.now() / 1000) })
        this.recordUsage({
          at: startedAt, provider: providerId, model: modelId, api: 'anthropic', stream: false,
          ok: true, tap, startedAt, completionUsage: completion.usage,
        })
        sendJson(response, 200, openAiCompletionToAnthropic(completion))
      } catch (error) {
        this.recordUsage({
          at: startedAt, provider: providerId, model: modelId, api: 'anthropic', stream: false,
          ok: false, error: String(error), tap, startedAt,
        })
        sendAnthropicError(502, 'api_error', String(error))
      }
      return
    }

    // 流式：翻译成 Anthropic 事件序列（以 message_stop 收尾，**不发** [DONE]）
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
      'x-accel-buffering': 'no',
    })
    try {
      for await (const frame of streamChunksToAnthropicSse(tapped, { id, model: raw })) {
        response.write(frame)
      }
      response.end()
      this.recordUsage({
        at: startedAt, provider: providerId, model: modelId, api: 'anthropic', stream: true,
        ok: true, tap, startedAt,
      })
    } catch (error) {
      // 流已开始，无法改状态码；按 Anthropic 的 error 事件下发。
      response.write(`event: error\ndata: ${JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: String(error) },
      })}\n\n`)
      response.end()
      this.recordUsage({
        at: startedAt, provider: providerId, model: modelId, api: 'anthropic', stream: true,
        ok: false, error: String(error), tap, startedAt,
      })
    }
  }
}

/**
 * 取**最近一条 user 消息**的纯文本（作为原生搜索的查询串）。
 *
 * ⚠️ 取「最近一条」而非拼接全部：搜索要的是一个查询，把整段对话塞进去
 *    会让搜索结果跑偏（实测过长的 query 返回无关结果）。
 */
function latestUserText(messages: readonly OpenAiMessage[] | undefined): string {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role !== 'user') continue
    const content = message.content
    if (typeof content === 'string') return content.trim()
    if (Array.isArray(content)) {
      const text = content
        .filter((part): part is { type?: string; text?: string } => typeof part === 'object' && part !== null)
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text!)
        .join('\n')
        .trim()
      if (text.length > 0) return text
    }
  }
  return ''
}

/**
 * 从工具声明里摘掉**已被我们接管**的搜索工具。
 *
 * ⚠️ 为什么必须摘（真实缺陷，2026-10-20 实测）：只注入搜索结果而不摘工具时，
 *    模型看到 `web_search` 仍可用，**倾向于自己调用**（返回 `tool_calls`），
 *    于是我们注入的资料完全白费，客户端还会因为不会执行该工具而卡住。
 *
 * ⚠️ 摘掉后若工具列表为空，要**整个删掉 `tools` 字段** —— 传空数组 `[]`
 *    会让部分上游报 400（"tools 不能为空"）。
 */
function stripSearchTools<T>(tools: T[] | undefined, searchToolName: string): T[] | undefined {
  if (!Array.isArray(tools)) return tools
  const kept = tools.filter((tool) => {
    if (typeof tool !== 'object' || tool === null) return true
    const rec = tool as { name?: unknown; function?: { name?: unknown } }
    const name = typeof rec.name === 'string' ? rec.name
      : typeof rec.function?.name === 'string' ? rec.function.name
        : ''
    return name !== searchToolName
  })
  return kept.length > 0 ? kept : undefined
}
