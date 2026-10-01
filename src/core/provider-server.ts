/**
 * 每个供应商一个 HTTP 服务实例。
 *
 * 用户要求「每个供应商提供各自包装而不是合在一起」，所以这里做的是：
 *   - 每个 Provider 起**自己的监听端口**（默认 3901/3902/…，可配）
 *   - 每个 Provider 暴露**自己的** `/v1/models` 与 `/v1/chat/completions`
 *   - 另有一个总览服务（见 server.ts）提供 Web UI 与聚合视图
 *
 * 这样任何一个供应商崩了/没登录，都不影响其余供应商的端点。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { LlmAdapter, GenerateOptions } from '@deepseek-ai/dsh-llm'
import {
  collectCompletion,
  streamChunksToSse,
  toGenerateOptions,
  toOpenAiModels,
  type OpenAiChatRequest,
} from './protocol.js'
import type { Provider } from './provider.js'

export interface ProviderServerOptions {
  provider: Provider
  port: number
  host?: string
  /** 可选的访问令牌：设置后要求 `Authorization: Bearer <token>`（非 OpenAI key 语义）。 */
  accessToken?: string
}

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

function sendError(response: ServerResponse, status: number, message: string, code = 'gateway_error'): void {
  sendJson(response, status, { error: { message, type: code, code } })
}

/**
 * 模型 id 路由：支持 `providerId/model` 与裸 `model` 两种写法。
 * 裸写法下假定属于当前端口的供应商（因为每个供应商端口是独立的）。
 */
function resolveModelId(raw: string, providerId: string): string {
  const prefix = `${providerId}/`
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw
}

/** 从请求里推断调用方希望用哪个适配器（默认就是本端口的供应商）。 */
function adapterFor(providerId: string, modelId: string): { adapterProvider: string; model: string } {
  return { adapterProvider: providerId, model: resolveModelId(modelId, providerId) }
}

export class ProviderServer {
  private server: Server | undefined
  readonly provider: Provider
  readonly port: number
  private readonly host: string
  private readonly accessToken: string | undefined

  constructor(options: ProviderServerOptions) {
    this.provider = options.provider
    this.port = options.port
    this.host = options.host ?? '127.0.0.1'
    this.accessToken = options.accessToken
  }

  get baseUrl(): string {
    return `http://${this.host}:${this.port}`
  }

  private authorized(request: IncomingMessage): boolean {
    if (this.accessToken === undefined) return true
    const header = request.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    return match?.[1] === this.accessToken
  }

  async start(): Promise<void> {
    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        this.provider.gateway.logger.error('请求处理失败:', error)
        if (!response.headersSent) sendError(response, 500, String(error))
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
    this.provider.gateway.logger.info(
      `供应商 ${this.provider.id} 已监听 ${this.baseUrl}（本地 OpenAI 兼容端点）`,
    )
  }

  async stop(): Promise<void> {
    const server = this.server
    if (server === undefined) return
    this.server = undefined
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.baseUrl)

    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type',
      })
      response.end()
      return
    }

    if (!this.authorized(request)) {
      sendError(response, 401, 'unauthorized: 缺少或错误的 Bearer 令牌', 'unauthorized')
      return
    }

    // ── /v1/models ──
    if (request.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      const models = await this.provider.adapter.listModels(this.provider.id)
      sendJson(response, 200, {
        object: 'list',
        data: toOpenAiModels(models, this.provider.id, Math.floor(Date.now() / 1000)),
      })
      return
    }

    // ── /v1/chat/completions ──
    if (
      request.method === 'POST'
      && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')
    ) {
      await this.handleChat(request, response)
      return
    }

    // ── /health ──
    if (url.pathname === '/health') {
      sendJson(response, 200, {
        ok: true,
        provider: this.provider.id,
        displayName: this.provider.displayName,
        capabilities: this.provider.capabilities,
      })
      return
    }

    sendError(response, 404, `未知路径：${url.pathname}`, 'not_found')
  }

  private async handleChat(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let body: OpenAiChatRequest
    try {
      body = JSON.parse(await readBody(request)) as OpenAiChatRequest
    } catch (error) {
      sendError(response, 400, `请求体不是合法 JSON：${String(error)}`, 'invalid_request')
      return
    }

    if (typeof body.model !== 'string' || body.model.length === 0) {
      sendError(response, 400, '缺少 model 字段', 'invalid_request')
      return
    }

    const { adapterProvider, model } = adapterFor(this.provider.id, body.model)
    const generate = toGenerateOptions(body, {
      provider: adapterProvider,
      model,
      sessionId: `gw-${this.provider.id}-${Date.now().toString(36)}`,
    })

    const id = `chatcmpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const created = Math.floor(Date.now() / 1000)
    const stream = body.stream === true

    let chunks: AsyncIterable<Parameters<typeof collectCompletion>[0] extends AsyncIterable<infer T> ? T : never>
    try {
      chunks = this.provider.adapter.stream(generate) as typeof chunks
    } catch (error) {
      sendError(response, 502, this.describeUpstreamError(error), 'upstream_error')
      return
    }

    if (!stream) {
      try {
        const completion = await collectCompletion(chunks, { id, model: body.model, created })
        sendJson(response, 200, completion)
      } catch (error) {
        sendError(response, 502, this.describeUpstreamError(error), 'upstream_error')
      }
      return
    }

    // ── 流式 ──
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
      'x-accel-buffering': 'no',
    })

    try {
      for await (const frame of streamChunksToSse(chunks, { id, model: body.model, created })) {
        response.write(frame)
      }
      response.write('data: [DONE]\n\n')
      response.end()
    } catch (error) {
      // 流已开始，无法改状态码；按 OpenAI 约定发一个 error 帧再结束。
      const message = this.describeUpstreamError(error)
      this.provider.gateway.logger.warn('流式中断:', message)
      response.write(`data: ${JSON.stringify({ error: { message, type: 'upstream_error' } })}\n\n`)
      response.write('data: [DONE]\n\n')
      response.end()
    }
  }

  /** 把适配器抛出的错误整理成对用户有意义的文案。 */
  private describeUpstreamError(error: unknown): string {
    const code = (error as { code?: unknown }).code
    const message = error instanceof Error ? error.message : String(error)
    if (code === 'MISSING_CREDENTIAL' || code === 'INVALID_CREDENTIAL') {
      return `供应商 ${this.provider.id} 尚未登录或凭据无效，请先在网关的 Web 界面登录（${message}）`
    }
    return `${this.provider.id}: ${message}`
  }
}

/** 供 core 复用的工具：把适配器流直接转成 SSE（总览服务用）。 */
export { streamChunksToSse, toGenerateOptions, toOpenAiModels }
export type { GenerateOptions, LlmAdapter }
