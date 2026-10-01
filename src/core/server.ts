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
import { collectCompletion, streamChunksToSse, toGenerateOptions, type OpenAiChatRequest } from './protocol.js'
import { recentLogs } from './logger.js'
import type { Provider } from './provider.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB_DIR = join(HERE, '..', '..', 'web')

export interface OverviewServerOptions {
  providers: Provider[]
  port: number
  host?: string
  /** 各供应商的监听端口，用于在 Web UI 上显示接入地址。 */
  providerPorts: Record<string, number>
  /** 数据目录（读写 config.json 实现开关持久化）。 */
  dataDir: string
  /** 运行时管理器：让启用/停用立即生效（热插拔）。 */
  runtime?: ProviderRuntime
}

import type { ProviderRuntime } from './provider-runtime.js'

const MAX_BODY_BYTES = 32 * 1024 * 1024

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
  private readonly providerPorts: Record<string, number>
  private readonly dataDir: string
  private readonly runtime: ProviderRuntime | undefined

  constructor(options: OverviewServerOptions) {
    this.providers = options.providers
    this.port = options.port
    this.host = options.host ?? '127.0.0.1'
    this.providerPorts = options.providerPorts
    this.dataDir = options.dataDir
    this.runtime = options.runtime
  }

  get baseUrl(): string {
    return `http://${this.host}:${this.port}`
  }

  async start(): Promise<void> {
    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        if (!response.headersSent) sendJson(response, 500, { error: String(error) })
        else response.end()
      })
    })
    this.server = server
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
      response.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type',
      })
      response.end()
      return
    }

    // ─────────── 静态前端 ───────────
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
            port: this.providerPorts[entry.id] ?? entry.defaultPort,
            baseUrl: null,
            accounts: [],
            permanentLocked: false,
          }
        }
        return this.describeProvider(p)
      }),
    )
    sendJson(response, 200, { providers })
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
        return {
          id: p.id,
          displayName: p.displayName,
          note: '',
          enabledInConfig: true,
          running: true,
          capabilities: p.capabilities,
          permanentLocked: p.capabilities.permanentLock ? p.permanentLocked() : false,
          port: this.providerPorts[p.id] ?? null,
          baseUrl: this.providerPorts[p.id] ? `http://127.0.0.1:${this.providerPorts[p.id]}/v1` : null,
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
      sendJson(response, 200, { loginUrl: started.loginUrl, accountId: started.accountId })
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
      } catch {
        // 单个供应商不可用不影响整体列表。
      }
    }
    sendJson(response, 200, { object: 'list', data })
  }

  private async aggregateChat(request: IncomingMessage, response: ServerResponse): Promise<void> {
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

    const generate = toGenerateOptions({ ...body, model: modelId }, {
      provider: providerId,
      model: modelId,
      sessionId: `gw-agg-${providerId}-${Date.now().toString(36)}`,
    })
    const id = `chatcmpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const created = Math.floor(Date.now() / 1000)

    let chunks: AsyncIterable<never>
    try {
      chunks = provider.adapter.stream(generate) as AsyncIterable<never>
    } catch (error) {
      sendJson(response, 502, { error: { message: String(error) } })
      return
    }

    if (body.stream !== true) {
      try {
        const completion = await collectCompletion(chunks, { id, model: raw, created })
        sendJson(response, 200, completion)
      } catch (error) {
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
      for await (const frame of streamChunksToSse(chunks, { id, model: raw, created })) {
        response.write(frame)
      }
      response.write('data: [DONE]\n\n')
      response.end()
    } catch (error) {
      response.write(`data: ${JSON.stringify({ error: { message: String(error) } })}\n\n`)
      response.write('data: [DONE]\n\n')
      response.end()
    }
  }
}
