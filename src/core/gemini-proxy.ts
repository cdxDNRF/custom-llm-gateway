/**
 * Gemini 专用出口：**只对 Google 域名走代理**，其余一切直连。
 *
 * ## 为什么需要它（用户报障，2026-10-14）
 *
 * 用户开着 TUN 时 Gemini 可用、**关掉 TUN 后无法回应**。真·直连实测：
 *
 * | 路径 | 结果 |
 * |---|---|
 * | 直连 `daily-cloudcode-pa.googleapis.com` | ✗ 超时（HTTP 000，15s） |
 * | 走 `http://127.0.0.1:7897`（Clash） | ✓ HTTP 404，0.8s |
 *
 * ⇒ **Gemini 必须走代理**（Google 域名在此网络环境下不可直连）。
 *
 * ⚠️ **教训**：我最初的结论是"直连即可、不需要代理" —— 那是**错的**。
 * 当时用户开着 TUN，而 TUN 是**网络层**拦截；我用的
 * `curl --noproxy '*'` 只能绕开**代理环境变量**，**绕不过 TUN**。
 * 于是测出来的"通"其实是经隧道的，不是真直连。判定网络可达性时，
 * 必须先确认链路层（TUN/VPN）状态，光看代理变量不够。
 *
 * ## 为什么不做成全局 `HTTPS_PROXY`
 *
 * 本项目其余 15 家（deepseek / buddy / trae / qoder …）都**直连更快**
 * （用户全局规则明确写着"LLM API 调用期间绝不挂代理"）。
 * 更关键的是：Gemini 适配器的推理请求用的是**裸全局 `fetch`**
 * （`gemini-adapter.ts` 的 `response = await fetch(url, …)`，无注入点），
 * 所以只能从**全局 dispatcher** 下手 —— 但全局 dispatcher 一改就是进程级，
 * 会波及所有供应商。故用本模块的**按 host 路由**把影响收敛到 Google 域名。
 *
 * ## 实现
 *
 * `undici.setGlobalDispatcher()` 装一个路由器：命中 {@link PROXIED_HOST_PATTERN}
 * 的请求交给 `ProxyAgent`（走系统代理），其余交给裸 `Agent`（直连）。
 *
 * ⚠️ **只在 Node 原生 `fetch` 上生效**（它底层就是 undici）。
 * `node:https` 的请求（如 qoder 的传输层）**不受影响**，这正是我们想要的
 * —— qoder 那条链路有它自己的 TLS 处理，不能混进来。
 *
 * ⚠️ 代理地址从**环境变量或本地文件**读，不硬编码：
 *   1. `GATEWAY_GEMINI_PROXY`（最明确）
 *   2. `HTTPS_PROXY` / `HTTP_PROXY`（若用户本来就用）
 *   3. `<数据目录>/gemini.env` 里的 `PROXY=...` 行
 * 都没有时**不装路由器**（保持全局默认行为，与改动前一致）。
 */
import { Agent, ProxyAgent, setGlobalDispatcher, type Dispatcher } from 'undici'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** 需要走代理的 host（Google 域名）。其余一律直连。 */
const PROXIED_HOST_PATTERN = /(^|\.)googleapis\.com$|(^|\.)google\.com$|(^|\.)googleusercontent\.com$/i

/**
 * 按 host 分流的拦截器。
 *
 * ⚠️ 用 undici 官方的 `Dispatcher.compose()` 扩展点，而不是自己实现 `Dispatcher`
 * 接口 —— 后者是个带十几个方法（`request` / `pipeline` / `connect` / `upgrade` …）
 * 的完整类，手写实现必然漏掉某个方法，且上游加方法时会静默失配。
 * `compose` 只要求我们提供「`dispatch` → `dispatch`」的包装函数。
 */
function makeRoutingInterceptor(
  direct: Dispatcher,
  proxied: Dispatcher,
  pattern: RegExp,
): Dispatcher.DispatcherComposeInterceptor {
  return (dispatch) => (options, handler) => {
    const origin = String(options.origin ?? '')
    let host = origin
    try { host = new URL(origin).hostname } catch { /* origin 不是 URL 时按原串匹配 */ }
    const target = pattern.test(host) ? proxied : direct
    return target.dispatch(options as never, handler as never)
  }
}

/** 已装的路由器句柄（仅用于幂等与卸载）。 */
let installed: { close: () => Promise<void> } | undefined

/** 归一化代理地址：裸 `host:port` 补 `http://`。 */
function normalizeProxyUrl(raw: string): string | undefined {
  const value = raw.trim()
  if (value.length === 0) return undefined
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value) ? value : `http://${value}`
  try {
    new URL(withScheme)
    return withScheme
  } catch {
    return undefined
  }
}

/**
 * 解析代理地址（按优先级，先到先用）。
 *
 * `gemini.env` 的格式与 loomy.env 一致（`KEY=VALUE` 行，`#` 注释）。
 */
export function resolveGeminiProxy(dataDir: string): string | undefined {
  const fromDedicated = process.env.GATEWAY_GEMINI_PROXY
  if (fromDedicated !== undefined && fromDedicated.trim().length > 0) {
    return normalizeProxyUrl(fromDedicated)
  }
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    const value = process.env[key]
    if (value !== undefined && value.trim().length > 0) return normalizeProxyUrl(value)
  }
  try {
    for (const line of readFileSync(resolve(dataDir, 'gemini.env'), 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq <= 0) continue
      if (trimmed.slice(0, eq).trim().toUpperCase() !== 'PROXY') continue
      return normalizeProxyUrl(trimmed.slice(eq + 1).replace(/^["']|["']$/g, ''))
    }
  } catch {
    // 文件不存在：视为未配置。
  }
  return undefined
}

/**
 * 装上按 host 分流的路由器（**幂等**，重复调用只生效一次）。
 *
 * @returns 实际使用的代理地址；未配置或不合法时返回 `undefined`（此时不装）。
 */
export function installGeminiProxyRouting(dataDir: string): string | undefined {
  if (installed !== undefined) return installGeminiProxyRouting.lastUrlValue
  const proxyUrl = resolveGeminiProxy(dataDir)
  if (proxyUrl === undefined) return undefined

  const direct = new Agent()
  const proxied = new ProxyAgent({ uri: proxyUrl, keepAliveTimeout: 1, keepAliveMaxTimeout: 1 })
  // ⚠️ 基座用 `direct`：未命中 Google 域名的请求走它（直连），命中者由拦截器改投代理。
  const routing = direct.compose(makeRoutingInterceptor(direct, proxied, PROXIED_HOST_PATTERN))
  setGlobalDispatcher(routing)
  installed = { close: () => Promise.all([direct.close(), proxied.close()]).then(() => undefined) }
  installGeminiProxyRouting.lastUrlValue = proxyUrl
  return proxyUrl
}
/** 记录实际生效的代理地址（供幂等分支复用）。 */
installGeminiProxyRouting.lastUrlValue = undefined as string | undefined

/** 测试/退出用：卸下路由器并恢复默认（仅用于单测）。 */
export async function uninstallGeminiProxyRouting(): Promise<void> {
  const current = installed
  installed = undefined
  installGeminiProxyRouting.lastUrlValue = undefined
  if (current !== undefined) await current.close().catch(() => {})
  setGlobalDispatcher(new Agent())
}
