/**
 * Qoder 专用传输层：**只用 TLS 1.2** 的 fetch。
 *
 * ## 为什么需要它（真实故障，2026-10-13）
 *
 * **症状**：qoder 全部模型在 Windows 网关上报
 * `qoder: transport error: fetch failed`，耗时约 10.5s（连接超时）。
 *
 * **实测诊断**（同一台 Windows、同一时刻，逐层隔离）：
 *
 * | 测试 | 结果 |
 * |---|---|
 * | Node `fetch`（默认 TLS 1.3） | ✗ `UND_ERR_CONNECT_TIMEOUT` 10.8s |
 * | Node `fetch` + `--tls-max-v1.2` | ✓ HTTP 404，461ms |
 * | `curl` 直连 | ✓ 404，0.43s |
 * | Node 原生 `net.connect` | ✓ TCP 48ms |
 * | Node `tls.connect`（TLS 1.3） | ✗ 握手超时 8s |
 * | 经 Clash 代理 | ✓ 404，1.9s |
 *
 * **结论**：TCP 可达、DNS 正常、其它主机默认 TLS 1.3 也正常 —— 只有**到 qoder
 * 主机的 TLS 1.3 握手被中断**，TLS 1.2 正常。最可能是 TLS 1.3 的 ClientHello
 * 体积更大（含后量子密钥共享等扩展），在这条链路上被丢弃。
 *
 * ## ⚠️⚠️ 为什么最终用 `node:https` 而不是 undici（第二处实测结论）
 *
 * 起初用 undici（`Agent` + `maxVersion:'TLSv1.2'`）。独立测 `GET /` 时 4/4 全通，
 * 但测**真实的加密推理端点（POST）**时出现**严格交替**失败：
 *
 * ```
 * 第 1 次 → HTTP 200 (296ms)
 * 第 2 次 → 超时 20s        ← 同一 URL、同一进程
 * 第 3 次 → HTTP 200 (306ms)
 * 第 4 次 → 超时 20s
 * ```
 *
 * 与请求间隔无关（3s / 8s / 20s 均同样交替），换全新 `Agent`（强制新连接）
 * 也一样。而**同样请求换 `node:https` + `maxVersion:'TLSv1.2'` → 3/3 全部 200**。
 *
 * ⇒ 交替失败是 **undici 在这条链路上的问题**（不是网络、不是服务端限流、也不是
 * 连接复用）。故改用 `node:https`，它没有 undici 的那套连接池/调度逻辑。
 *
 * ⚠️ 该结论是**实测得出**，若将来 undici 修好或 qoder 恢复 TLS 1.3，应重新评估
 * 并优先简化本模块。
 *
 * ## 为什么只给 qoder 用（不做全局降级）
 *
 * 全局 `NODE_OPTIONS=--tls-max-v1.2` 会降低**所有**供应商的安全等级，而实测显示
 * buddy / trae / zcode 等用 TLS 1.3 完全正常。故只对 qoder 走本模块。
 * 若 qoder 恢复正常，把 {@link QODER_TLS_MAX_VERSION} 置空即可回到默认。
 */
import { request as httpsRequest, type RequestOptions } from 'node:https'
import { Readable } from 'node:stream'

/**
 * Qoder 握手可用的最高 TLS 版本。
 *
 * ⚠️ 置为 `undefined` 即回到默认（TLS 1.3）。若上游恢复正常，应优先删除本模块
 * 而不是长期钉在 1.2（1.2 的安全性弱于 1.3）。
 */
export const QODER_TLS_MAX_VERSION: 'TLSv1.2' | undefined = 'TLSv1.2'

/** 建连超时。qoder 正常响应在 400ms 内，给 20s 足够且不掩盖真正的故障。 */
const CONNECT_TIMEOUT_MS = 20_000
/** 空闲超时：流式推理在思考期间可能几十秒没有数据，不能太短。 */
const IDLE_TIMEOUT_MS = 120_000

/**
 * 把 `fetch` 形状的入参解析成 `node:https` 需要的要素。
 *
 * ⚠️ 只需支持 qoder 适配器实际用到的形态：URL + `method` + `headers` + `body` +
 * `signal`。**不实现完整 fetch 语义**（无 FormData / 重定向 / streaming request body），
 * 因为唯一调用方是 `qoder-adapter.ts` 的 `sendEncrypted`（见其 1125 行）。
 */
function toRequestOptions(input: unknown, init?: unknown): { options: RequestOptions; body?: string | Uint8Array } {
  const raw = typeof input === 'string'
    ? input
    : ((input as { url?: string })?.url ?? String(input))
  const url = new URL(raw)
  const i = (init ?? {}) as {
    method?: string
    headers?: Record<string, string> | Headers
    body?: unknown
  }

  // headers：兼容普通对象与 Headers 实例。
  const headers: Record<string, string> = {}
  const rawHeaders = i.headers
  if (rawHeaders !== undefined) {
    if (typeof (rawHeaders as Headers).forEach === 'function' && !Array.isArray(rawHeaders)) {
      ;(rawHeaders as Headers).forEach((value, key) => { headers[key] = value })
    } else {
      for (const [k, v] of Object.entries(rawHeaders as Record<string, string>)) headers[k] = String(v)
    }
  }

  let body: string | Uint8Array | undefined
  if (typeof i.body === 'string') body = i.body
  else if (i.body instanceof Uint8Array) body = i.body
  else if (i.body !== undefined && i.body !== null) body = String(i.body)

  return {
    options: {
      // ⚠️ **必须显式拆出 host/port/path**：只给 `method`/`headers` 会让
      //    `https.request` 走默认的 127.0.0.1:443（实测 `ECONNREFUSED 127.0.0.1:443`）。
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port.length > 0 ? url.port : undefined,
      path: `${url.pathname}${url.search}`,
      method: (i.method ?? 'GET').toUpperCase(),
      headers,
      ...(QODER_TLS_MAX_VERSION !== undefined ? { maxVersion: QODER_TLS_MAX_VERSION } : {}),
      timeout: CONNECT_TIMEOUT_MS,
    },
    ...(body !== undefined ? { body } : {}),
  }
}

/**
 * qoder 专用的 fetch（TLS 1.2，基于 `node:https`）。
 *
 * 形状与全局 `fetch` 兼容，可直接作为适配器的 `fetchImpl` 注入
 * （见 `vendor/src/qoder-adapter.ts` 的 `options.fetchImpl`）。
 *
 * 返回的是标准 `Response` —— 适配器会调 `.ok` / `.status` / `.text()` /
 * `.body`（SSE 读取），故必须提供真实的 `ReadableStream` body。
 */
export const qoderFetch: typeof fetch = (async (input: unknown, init?: unknown): Promise<Response> => {
  const { options, body } = toRequestOptions(input, init)
  const signal = (init as { signal?: AbortSignal } | undefined)?.signal

  return await new Promise<Response>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DOMException('The operation was aborted.', 'AbortError'))
      return
    }

    const req = httpsRequest(options, (res) => {
      // 把 node 的 IncomingMessage 转成 web ReadableStream（Response 需要它）。
      const stream = Readable.toWeb(res) as ReadableStream<Uint8Array>
      const headers = new Headers()
      for (const [k, v] of Object.entries(res.headers)) {
        if (v === undefined) continue
        if (Array.isArray(v)) for (const one of v) headers.append(k, one)
        else headers.set(k, v)
      }
      resolve(new Response(stream, {
        status: res.statusCode ?? 200,
        statusText: res.statusMessage ?? '',
        headers,
      }))
    })

    // 空闲超时：有数据就重置（思考期间可能长时间静默）。
    req.setTimeout(IDLE_TIMEOUT_MS, () => {
      req.destroy(new Error(`qoder: 响应空闲超时（${IDLE_TIMEOUT_MS}ms 无数据）`))
    })

    const onAbort = (): void => { req.destroy(new DOMException('The operation was aborted.', 'AbortError')) }
    signal?.addEventListener('abort', onAbort, { once: true })

    req.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
    req.on('close', () => signal?.removeEventListener('abort', onAbort))

    if (body !== undefined) req.write(body)
    req.end()
  })
}) as typeof fetch
