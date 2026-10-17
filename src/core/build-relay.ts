/**
 * Build 渠道中继：一个 **WebSocket 服务端**，让 AI Studio「Build App」把请求转发给我们。
 *
 * ## 为什么长这样（与其它 16 家供应商的根本差异）
 *
 * 其它供应商都是**我们主动出网**（`fetch` 到上游）。Build 渠道反过来：
 * 上游是一个**跑在 Google Cloud Run 上的 App**，它主动连回我们。
 *
 * ```
 * 你的 Chrome（App 页面）
 *    ↕ ws://127.0.0.1:<port>/v1/ws        ← 本模块（服务端）
 * 本网关 → 酒馆/客户端
 * ```
 *
 * 为什么必须由浏览器发起连接：App 的**服务端代码**跑在 Google 云上，
 * 它连不到你的 `127.0.0.1`；而**页内 JS** 跑在你的浏览器里，可以。
 * （实测：HTTPS 页面连 `ws://127.0.0.1` **不受混合内容限制** ——
 *  Chrome 对 localhost 有豁免。故无需 HTTPS、无需公网 IP、无需隧道。）
 *
 * ## 与社区方案的关键区别：把难的部分留给 AI Studio 宿主页
 *
 * 社区（AIStudio2API / CLIProxyAPI / AIStudioBuildWS）要跑**无头浏览器 +
 * Cookie**，甚至**重实现 BotGuard/WAA proof**，因为它们追求"服务端全自动"。
 *
 * 我们不需要，因为**用户的浏览器本来就在 AI Studio 页面里** ——
 * 宿主页会给 iframe 装上 shim，接管匹配 `generativelanguage.googleapis.com`
 * 的 `fetch`，由它完成 WAA proof 并走 **MakerSuite 代理 RPC**（Build 独立额度）：
 *
 *   · 不需要无头浏览器（用日常 Chrome 开一个标签页即可）
 *   · 不需要提取/解密 Cookie（Chrome 的 Cookie 是 DPAPI 加密且运行时锁定）
 *   · **不需要实现 WAA**（宿主页代劳）—— 这是本方案最大的省力点
 *   · 不需要公网入口
 *
 * ⚠️ **前提是请求必须由浏览器端 fetch 发出**（不带 API Key）。
 *    若改由 App 服务端带 key 直连，就退回 API Key 额度了 —— 详见
 *    `build-adapter.ts` 模块头的决定性实验。
 *
 * ⚠️ 另一个前提：宿主页只在**用户激活后**转发（约 30 次 mousemove + 5 次
 *    keydown，且 `navigator.userActivation.hasBeenActive`）。故用户需在
 *    App 页面上动一动鼠标/敲几下键。
 *
 * 代价是**用户要开着那个标签页** —— 这正是「手动连接」设计的由来。
 *
 * ## 协议（实测得出，与社区实现一致）
 *
 * 文本帧，JSON：`{id, type, payload}`
 *
 * | type | 方向 | payload |
 * |---|---|---|
 * | `ping` / `pong` | 双向 | —（App 每 20 秒发一次 ping） |
 * | `http_request` | **我们 → App** | `{url, method, headers, body}` |
 * | `stream_start` | App → 我们 | `{status, headers}` |
 * | `stream_chunk` | App → 我们 | `{data}`（文本分片） |
 * | `stream_end` | App → 我们 | — |
 * | `error` | App → 我们 | `{message}` |
 *
 * ⚠️ App 侧有 **host 白名单**（只放行 `*.googleapis.com`）—— 这是它的安全设计，
 * 我们无法也不应绕过。
 */
import { createHash, randomUUID } from 'node:crypto'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'

/** 一次待完成的转发请求。 */
interface PendingRequest {
  /** 收到的响应头（`stream_start` 时填）。 */
  status?: number
  headers?: Record<string, string>
  /** 已收到的正文分片。 */
  chunks: string[]
  /** 收到 `error` 帧时的错误信息。 */
  error?: string
  resolve: (value: RelayResponse) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** 一次转发的完整结果。 */
export interface RelayResponse {
  status: number
  headers: Record<string, string>
  /** 正文（字符串；Build App 转发的是文本响应，含 SSE）。 */
  body: string
}

/** 连接状态（给 Web UI 展示）。 */
export interface BuildRelayStatus {
  /** 服务端是否在监听（网关跑着就一直在监听 upgrade）。 */
  listening: boolean
  /** 是否接受 App 连接（Web UI 的开关）。 */
  accepting: boolean
  /** 已连接（App 已握手）的次数/是否存在活跃连接。 */
  connected: boolean
  /** 累计完成的转发请求数。 */
  relays: number
  /** 累计失败数。 */
  failures: number
  /** 最近一次收到心跳的时刻。 */
  lastPingAt?: number
  /** 最近一次错误信息。 */
  lastError?: string
}

export interface BuildRelayOptions {
  /** 监听端口（与网关同端口，路径区分）。 */
  port: number
  /** 访问令牌：App 用 `?auth_token=` 传入。 */
  token: string
  /** 诊断日志出口。 */
  warn?: (message: string) => void
  /** 每个转发请求的超时（毫秒）。 */
  timeoutMs?: number
}

/** 转发默认超时：LLM 推理可能较慢，给足 5 分钟。 */
const DEFAULT_TIMEOUT_MS = 5 * 60_000

/** WebSocket 握手用的固定 GUID（RFC 6455）。 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/**
 * Build 渠道中继服务端。
 *
 * ⚠️ 它**自己处理 HTTP upgrade**（不挂在网关的 `http.Server` 上）：
 * 网关的请求处理是「路径 → handler」模型，而 WebSocket 需要在 `upgrade`
 * 事件上接管 socket。两者共存只需给同一个 server 加一个 `upgrade` 监听器
 * （见 {@link attach}），无需第二个端口。
 */
export class BuildRelay {
  private readonly options: BuildRelayOptions
  private socket: Duplex | undefined
  private pending = new Map<string, PendingRequest>()
  private relays = 0
  private failures = 0
  private lastPingAt: number | undefined
  private lastError: string | undefined
  /** 收到的 WS 帧缓冲（TCP 分片可能把一个帧切开）。 */
  private frameBuffer = Buffer.alloc(0)

  constructor(options: BuildRelayOptions) {
    this.options = options
  }

  /** 挂到已有的 HTTP server 上（复用网关端口，路径 `/v1/ws`）。 */
  attach(server: Server): void {
    server.on('upgrade', (request, socket, head) => {
      void this.handleUpgrade(request, socket as Duplex, head)
    })
  }

  /** 当前状态（给 Web UI）。 */
  status(): BuildRelayStatus {
    return {
      listening: true,
      accepting: this.accepting,
      connected: this.socket !== undefined && !this.socket.destroyed,
      relays: this.relays,
      failures: this.failures,
      ...(this.lastPingAt !== undefined ? { lastPingAt: this.lastPingAt } : {}),
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
    }
  }

  /** 断开当前连接（App 侧会按自己的退避重连）。 */
  disconnect(): boolean {
    const socket = this.socket
    if (socket === undefined) return false
    // 主动发 close 帧（1000 = 正常关闭），再销毁。
    try { socket.write(encodeFrame(JSON.stringify({ type: 'close' }), 0x8)) } catch { /* 忽略 */ }
    socket.destroy()
    return true
  }

  /**
   * 是否接受 App 连接。
   *
   * ⚠️ 用户在 Web UI 上「断开」时置 false —— 此时 upgrade 请求会被 403 拒绝，
   * App 会显示 Disconnected。这不是"关端口"（端口是共享的），而是**拒绝 build 的
   * 连接**，与其它供应商的"停用"语义一致。
   */
  /**
   * 是否接受 App 连接。
   *
   * ⚠️⚠️ **默认 `true`**（真实缺陷，2026-10-17 用户报障："每次都要人手动点 connect"）。
   *
   * 起初默认 `false`，要求用户先在 Web UI 点「连接」。但那样有个致命体验问题：
   * **网关一重启，这个内存状态就回到 false，App 再连就被 403 拒绝** ——
   * 用户看到的现象是"自动重连没用，每次都得手动点"。
   *
   * 而 App 侧的自动重连（每 3 秒）**本来是完全正常的**（实测：杀服务端后它
   * 连试 5 次）。真正卡住它的是**我们在拒绝**。
   *
   * 故语义改为：**供应商启用（`enabled: true`）就意味着接受连接**。
   * 「断开」按钮是**显式的临时拒绝**（用于你想主动停用而不改配置的场景）。
   */
  private accepting = true

  /** 允许/禁止 App 连接（Web UI 的「连接 / 断开」按钮）。 */
  setAccepting(value: boolean): void {
    this.accepting = value
    if (!value) this.disconnect()
  }

  get isAccepting(): boolean {
    return this.accepting
  }

  /** 关掉所有待处理请求（如停用 provider 时）。 */
  dispose(): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('Build 渠道已断开'))
    }
    this.pending.clear()
    this.socket?.destroy()
    this.socket = undefined
  }

  /**
   * 向 App 发一个 HTTP 请求并等结果。
   *
   * @throws 未连接 / 超时 / App 回 error 帧时抛错。
   */
  async fetch(input: {
    url: string
    method: string
    headers?: Record<string, string>
    body?: string
  }): Promise<RelayResponse> {
    const socket = this.socket
    if (socket === undefined || socket.destroyed) {
      throw new Error('Build 渠道未连接：请先打开 AI Studio App 页面并点 Connect')
    }
    const id = randomUUID()
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS

    return await new Promise<RelayResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.failures++
        reject(new Error(`Build 渠道转发超时（${timeoutMs}ms）：${input.url}`))
      }, timeoutMs)
      // ⚠️ 不让这个定时器拖住进程退出。
      timer.unref?.()

      this.pending.set(id, { chunks: [], resolve, reject, timer })
      const frame = encodeFrame(JSON.stringify({
        id,
        type: 'http_request',
        payload: {
          url: input.url,
          method: input.method,
          headers: input.headers ?? {},
          body: input.body ?? '',
        },
      }), 0x1)
      try {
        socket.write(frame)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        this.failures++
        reject(new Error(`Build 渠道发送失败：${String(error)}`))
      }
    })
  }

  // ─────────────────────────── WebSocket 实现 ───────────────────────────

  private async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/v1/ws') {
      // 不是我们的路径：交给别的 upgrade 监听器（若有）。
      return
    }
    if (!this.accepting) {
      this.options.warn?.('[build] 拒绝连接：渠道未启用（请在 Web UI 点「连接」）')
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }
    const token = url.searchParams.get('auth_token') ?? ''
    if (token !== this.options.token) {
      this.lastError = 'App 握手失败：auth_token 不匹配'
      this.options.warn?.(`[build] 握手被拒：auth_token 不匹配（收到 ${token.length} 字符）`)
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    const key = request.headers['sec-websocket-key']
    if (typeof key !== 'string') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }

    const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    // 同一时刻只保留一条连接（App 重连时旧的会被替换）。
    this.socket?.destroy()
    this.socket = socket
    this.frameBuffer = Buffer.alloc(0)
    this.options.warn?.(`[build] App 已连接（origin=${request.headers.origin ?? '?'}）`)
    if (head.length > 0) this.onData(head)

    socket.on('data', (chunk: Buffer) => this.onData(chunk))
    socket.on('close', () => {
      if (this.socket === socket) {
        this.socket = undefined
        this.options.warn?.('[build] App 连接已断开')
      }
    })
    socket.on('error', (error: Error) => {
      this.lastError = `连接错误：${error.message}`
      if (this.socket === socket) this.socket = undefined
    })
  }

  /**
   * 解析 WebSocket 帧。
   *
   * ⚠️ 必须处理**分片与粘包**：TCP 不保证一个 `data` 事件对应一个完整帧。
   * 故用 `frameBuffer` 累积，只在凑够一整帧时才消费（否则长响应会被截断，
   * 表现为"模型回答中断"这类极难定位的问题）。
   */
  private onData(chunk: Buffer): void {
    this.frameBuffer = Buffer.concat([this.frameBuffer, chunk])
    for (;;) {
      const frame = decodeFrame(this.frameBuffer)
      if (frame === undefined) return
      this.frameBuffer = this.frameBuffer.subarray(frame.consumed)
      if (frame.opcode === 0x8) { this.socket?.destroy(); return }   // close
      if (frame.opcode === 0x9) {                                     // ping → pong
        try { this.socket?.write(encodeFrame(frame.text, 0xA)) } catch { /* 忽略 */ }
        continue
      }
      if (frame.opcode !== 0x1) continue                              // 只处理文本
      this.onMessage(frame.text)
    }
  }

  private onMessage(text: string): void {
    let message: { id?: string; type?: string; payload?: Record<string, unknown> }
    try {
      message = JSON.parse(text) as typeof message
    } catch {
      // ⚠️ 实测：收到过二进制乱码（App 对 gzip 响应的处理），静默忽略即可。
      return
    }
    if (message.type === 'ping') {
      this.lastPingAt = Date.now()
      try { this.socket?.write(encodeFrame(JSON.stringify({ type: 'pong', id: message.id }), 0x1)) } catch { /* 忽略 */ }
      return
    }
    const id = typeof message.id === 'string' ? message.id : ''
    const pending = this.pending.get(id)
    if (pending === undefined) return
    const payload = message.payload ?? {}

    switch (message.type) {
      case 'stream_start':
        pending.status = typeof payload.status === 'number' ? payload.status : 200
        pending.headers = (payload.headers ?? {}) as Record<string, string>
        break
      case 'stream_chunk':
        if (typeof payload.data === 'string') pending.chunks.push(payload.data)
        break
      case 'stream_end': {
        this.pending.delete(id)
        clearTimeout(pending.timer)
        this.relays++
        pending.resolve({
          status: pending.status ?? 200,
          headers: pending.headers ?? {},
          body: pending.chunks.join(''),
        })
        break
      }
      case 'error': {
        this.pending.delete(id)
        clearTimeout(pending.timer)
        this.failures++
        const messageText = typeof payload.message === 'string' ? payload.message : '未知错误'
        this.lastError = messageText
        pending.reject(new Error(`Build 渠道转发失败：${messageText}`))
        break
      }
      default:
        break
    }
  }
}

/** 编码一个 WebSocket 帧（服务端 → 客户端，**不掩码**）。 */
function encodeFrame(text: string, opcode: number): Buffer {
  const payload = Buffer.from(text, 'utf8')
  const len = payload.length
  let header: Buffer
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len])
  } else if (len < 65_536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payload])
}

/** 解码一个帧；不足一帧时返回 `undefined`。 */
function decodeFrame(buffer: Buffer): { opcode: number; text: string; consumed: number } | undefined {
  if (buffer.length < 2) return undefined
  const opcode = buffer[0]! & 0x0f
  const masked = (buffer[1]! & 0x80) !== 0
  let len = buffer[1]! & 0x7f
  let offset = 2
  if (len === 126) {
    if (buffer.length < offset + 2) return undefined
    len = buffer.readUInt16BE(offset)
    offset += 2
  } else if (len === 127) {
    if (buffer.length < offset + 8) return undefined
    const big = buffer.readBigUInt64BE(offset)
    // 超过 64MB 的帧按协议异常处理（App 的响应不会这么大）。
    if (big > 64n * 1024n * 1024n) return undefined
    len = Number(big)
    offset += 8
  }
  let mask: Buffer | undefined
  if (masked) {
    if (buffer.length < offset + 4) return undefined
    mask = buffer.subarray(offset, offset + 4)
    offset += 4
  }
  if (buffer.length < offset + len) return undefined
  const payload = Buffer.from(buffer.subarray(offset, offset + len))
  if (mask !== undefined) {
    for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!
  }
  return { opcode, text: payload.toString('utf8'), consumed: offset + len }
}
