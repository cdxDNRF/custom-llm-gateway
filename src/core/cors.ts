/**
 * CORS 响应头：让**浏览器里的网页 / 扩展**能直接调用本网关。
 *
 * ## 为什么需要单独一个模块
 *
 * 网关有两个 HTTP 服务（总览 8790、各供应商 3901…），两处都必须返回
 * **完全一致**的 CORS 头。早先各自硬编码，结果两个问题同时存在：
 *
 * 1. `access-control-allow-headers` 写死成 `authorization, content-type`。
 *    浏览器发现请求带了白名单外的头（如沉浸式翻译的 `x-api-key`、
 *    某些客户端的 `x-requested-with`）时，**预检直接失败、请求根本不会
 *    发到网关**，前端只看到 `TypeError: Failed to fetch`（用户报障
 *    2026-10-03「沉浸式翻译里报网络连接失败」）。
 *    curl / opencode / zcode 这类非浏览器客户端不受 CORS 约束，所以
 *    它们一直正常 —— 这正是该缺陷只在浏览器里暴露的原因。
 *
 * 2. 缺少 `Access-Control-Allow-Private-Network`。Chrome 的 Private
 *    Network Access 策略要求：**公网页面（https 网站）向内网/本机发起
 *    请求时**，预检响应必须显式允许，否则同样被拦。
 *
 * ## 修法：回显请求声明的头，而不是维护白名单
 *
 * `Access-Control-Request-Headers` 是浏览器在预检里声明的"我这次要带哪些
 * 头"。把它原样回显给浏览器即可 —— 不必维护白名单，将来客户端加新头
 * 也不会再踩同一个坑。安全性不降低：真正的鉴权是 Bearer 令牌
 * （见 `authorized()`），CORS 只决定"浏览器允不允许把响应交给页面"，
 * 它从来不是访问控制手段（非浏览器客户端可无视它）。
 */

/** 允许的 HTTP 方法（含 DELETE：控制台要删账号）。 */
const ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS'

/** 预检里没声明任何头时的兜底（保持旧行为，覆盖最常见组合）。 */
const FALLBACK_HEADERS = 'authorization, content-type, accept'

/**
 * 生成 CORS 响应头。
 *
 * @param request 原始请求（读 `Origin` 与 `Access-Control-Request-Headers`）
 */
export function corsHeaders(request: { headers: Record<string, unknown> }): Record<string, string> {
  const raw = request.headers['access-control-request-headers']
  const requested = Array.isArray(raw)
    ? raw.join(',')
    : (typeof raw === 'string' ? raw : '')
  const headers = requested.trim().length > 0 ? requested : FALLBACK_HEADERS

  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': ALLOW_METHODS,
    // 回显浏览器声明的头（不维护白名单，见文件头说明）。
    'access-control-allow-headers': headers,
    // 预检结果缓存 24 小时，减少往返（浏览器上限即 86400）。
    'access-control-max-age': '86400',
    // Chrome Private Network Access：公网页面 → 本机/内网时必须显式允许，
    // 否则被拦（且报错同样是「网络错误」，极易误判为网关故障）。
    'access-control-allow-private-network': 'true',
    // 让中间代理/浏览器知道响应随 Origin 与请求头变化，避免错缓存。
    vary: 'Origin, Access-Control-Request-Headers',
  }
}
