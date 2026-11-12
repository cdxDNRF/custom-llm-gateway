/* dsh-llm-gateway 控制台前端（原生 JS，无构建步骤、无外部依赖） */
'use strict'

const $ = (sel) => document.querySelector(sel)

/**
 * 访问令牌（局域网访问时必需）。
 *
 * 三种来源，优先级从高到低：
 *   1. URL 的 `?token=xxx`（手机首次打开控制台时用，省去手输）
 *   2. localStorage（之后每次自动带上）
 *   3. 用户在页面上手动输入
 *
 * 命中来源 1 时会立刻转存到 localStorage 并把 URL 里的令牌抹掉——
 * 避免它留在浏览器历史/收藏里。
 *
 * 本机 127.0.0.1 访问时服务端会豁免校验，这里带不带都不影响。
 */
const TOKEN_KEY = 'dsh-gateway-token'

function readToken() {
  try {
    const fromUrl = new URLSearchParams(location.search).get('token')
    if (fromUrl) {
      localStorage.setItem(TOKEN_KEY, fromUrl)
      // 抹掉地址栏里的令牌，保持 URL 干净（刷新后从 localStorage 读）。
      const clean = location.pathname + location.hash
      history.replaceState(null, '', clean)
      return fromUrl
    }
    return localStorage.getItem(TOKEN_KEY) || ''
  } catch {
    return ''
  }
}

let accessToken = readToken()

/**
 * 后端返回的访问令牌（来自 `/api/overview` 的 `lan.accessToken`）。
 *
 * ⚠️ 为什么需要它：本机 127.0.0.1 访问时服务端**豁免令牌校验**，所以前端
 * 从不设置 `accessToken`，它是空串。但 Build 渠道的 App 是**外部客户端**
 * （从浏览器页面连过来，虽然也是 127.0.0.1 但走的是 WebSocket 独立校验），
 * 必须带真令牌。故从后端取一份用于展示/复制。
 */
let lanTokenCache = ''

function setToken(value) {
  accessToken = String(value || '').trim()
  try {
    if (accessToken) localStorage.setItem(TOKEN_KEY, accessToken)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    // 隐私模式下 localStorage 可能不可用：退化为仅本次会话有效。
  }
}

/** 弹窗让用户输入令牌；返回是否拿到了非空值。 */
function promptForToken(message) {
  const current = accessToken
  const value = window.prompt(
    message || '请输入访问令牌（局域网访问需要；本机 127.0.0.1 可留空）',
    current,
  )
  if (value === null) return false
  setToken(value)
  return accessToken.length > 0
}

function toast(message, kind = '') {
  const el = $('#toast')
  el.textContent = message
  el.className = `toast ${kind}`
  el.hidden = false
  clearTimeout(toast._timer)
  // 多行内容（批量操作逐条汇报）多留一会儿，否则来不及看；最多 12 秒。
  const lines = String(message).split('\n').length
  const ms = Math.min(4200 + Math.max(0, lines - 1) * 700, 12000)
  toast._timer = setTimeout(() => { el.hidden = true }, ms)
}

async function api(path, options = {}) {
  const headers = { 'content-type': 'application/json', ...(options.headers || {}) }
  if (accessToken) headers.authorization = `Bearer ${accessToken}`

  let response = await fetch(path, { ...options, headers })

  // 401：令牌缺失/错误。提示用户输入一次并重试，避免页面直接显示报错。
  if (response.status === 401) {
    const retry = promptForToken('访问令牌无效或缺失，请重新输入（令牌见网关启动日志或 config.json）')
    if (retry) {
      response = await fetch(path, {
        ...options,
        headers: { ...headers, authorization: `Bearer ${accessToken}` },
      })
    }
  }

  const text = await response.text()
  let body
  try { body = text ? JSON.parse(text) : {} } catch { body = { raw: text } }
  if (!response.ok) {
    const message = body.error?.message || body.error || body.message || `HTTP ${response.status}`
    throw new Error(typeof message === 'string' ? message : JSON.stringify(message))
  }
  return body
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ))
}

function fmtTime(ms) {
  if (!ms) return '—'
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fmtExpiry(ms) {
  if (!ms) return '—'
  const diff = ms - Date.now()
  if (diff <= 0) return `已过期（${fmtTime(ms)}）`
  const days = Math.floor(diff / 86400000)
  const hours = Math.floor((diff % 86400000) / 3600000)
  return days >= 1 ? `${days} 天后续期（${fmtTime(ms)}）` : `${hours} 小时后（${fmtTime(ms)}）`
}

/* 模型管理面板的搜索词（provider id → 关键词）。重渲染后要保留，否则
   每勾一个模型就丢失搜索状态，批量操作时很难用。 */
const modelFilter = new Map()

/* 每个供应商卡片上「展开区」的当前视图：'' | 'models' | 'balance' */
const expandedView = new Map()

/**
 * 每个供应商卡片的**折叠状态**（true = 只显示线场 + 标题）。
 *
 * ⚠️ 与 `expandedView` 是两套独立状态，见 renderProvider 里的注释。
 * Map 里没有 = 默认折叠（new Map 不预填，省一次循环）。
 */
const collapsedCards = new Map()

/**
 * 取供应商图标（`window.PROVIDER_ICONS` 由 `/static/icons.js` 提供）。
 *
 * 返回 `<img>` 的 HTML；没有图标时返回空串（**不占位** —— 空 `<img>` 会显示
 * 破图图标，比不显示更难看）。
 *
 * ⚠️ 图标是 data URI，`<img src>` 不会产生网络请求，符合本项目「零外部资源」约束。
 */
/**
 * 在供应商卡片上挂线条动效。
 *
 * ## 为什么是「按需跑帧」
 *
 * 见 `line-field.js` 文件头的性能表：本项目最多 18 张卡同屏、且控制台常开。
 * 若每张都跑满帧，18 × 800 段 × 60fps ≈ 每秒 86 万次线段绘制 —— 浏览器会卡。
 *
 * 故：
 * - **静止**：只画一帧（`requestIdleCallback` 后），不排帧
 * - **悬停/聚焦**：该卡独占一个 rAF 循环，跑满帧
 * - 离开即停，回到静态一帧
 *
 * 观感上仍是「鼠标靠近时标志开始呼吸」，与示例一致；区别只是没交互的卡不动。
 */
function attachLineField(card, provider) {
  const canvas = card.querySelector('.card-field')
  const IconApi = window.LineField
  if (canvas === null || IconApi === undefined) return

  // ── 主题色：线色取卡片前景色，检测色固定蓝（与示例的 detection 同源） ──
  /**
   * 线色按主题取：**亮色用深灰、暗色用浅灰**。
   *
   * ⚠️ 亮色下原来的 `.55` 透明度几乎看不见（用户反馈「在亮色里几乎等于没有」）——
   * 根因不是透明度，而是**亮色卡片表面是白色**，而线场透明度还要再乘一层 CSS
   * `opacity`（亮色我设了 .55），两层一乘只剩 .3，等于没有。
   * 现在：亮色用更深的不透明线（.92），CSS 层给 .75，净效果与暗色可比。
   */
  /**
   * 线色：**用图标自己的品牌主色**（用户要求「改成彩色的，跟图标一致」）。
   *
   * ⚠️ 这里的初始值只是「采样完成前的占位」：`field.loadIcon()` 采完会把
   *    `field.ink` 覆盖成从图标算出来的实际主色（见 line-field.js 的
   *    `sampleIcon`）。故占位色用中性灰即可，不必按主题区分。
   */
  const field = new IconApi.LineFieldCard(card, {
    canvas,
    seed: IconApi.seedOf(provider.id),
    ink: 'rgba(160,163,168,.9)',
  })

  /**
   * 帧循环策略（2026-11-12 第三轮调整）。
   *
   * 上一版：只在悬停的卡上跑满帧，其余静止 —— 用户觉得「粒子不够活」。
   * 现在：**所有卡都持续缓慢流动**，但用**降帧**控制成本：
   *
   * | 状态 | 目标帧率 |
   * |---|---|
   * | 空闲（默认） | ~20 fps（噪声本身很慢，20fps 看不出卡顿） |
   * | 悬停 / 聚焦 | 满帧 60 fps（指针脉冲要跟手） |
   *
   * 成本对比：7 卡 × 3456 段 × 20fps ≈ 48 万次/秒（空闲）
   *           单卡 × 3456 × 60fps ≈ 20 万次/秒（悬停时只 1 张卡满帧）
   * 远低于「全部满帧」的 145 万次/秒。
   */
  let raf = 0
  let last = 0
  let active = false
  let hovered = false
  /** 空闲时的最小帧间隔（毫秒）。1000/20 = 50ms。 */
  const IDLE_FRAME_MS = 50
  let lastDraw = 0

  const tick = (now) => {
    if (!active) { raf = 0; return }
    const dt = last === 0 ? 1 / 60 : Math.min(1 / 30, (now - last) / 1000)
    last = now
    // 空闲降帧：没到下一帧的时间点就跳过（不绘制，但仍保持 rAF 循环）
    const interval = hovered ? 0 : IDLE_FRAME_MS
    if (now - lastDraw >= interval) {
      lastDraw = now
      field.renderFrame(dt)
    }
    raf = requestAnimationFrame(tick)
  }

  const start = () => {
    if (active) return
    active = true
    last = 0
    if (raf === 0) raf = requestAnimationFrame(tick)
  }
  /** 只停指针脉冲效果，**不停帧循环**（卡片要一直缓慢流动）。 */
  const stop = () => {
    hovered = false
    field.clearPointer()
    field.focused = false
  }

  // ── 尺寸 / DPR 同步（DPR 单独变化 ResizeObserver 不触发，故也监听 matchMedia）──
  const sync = (redraw) => {
    const changed = field.syncSize()
    if (changed || redraw) field.renderFrame(1 / 60)
  }
  const observer = new ResizeObserver(() => sync(true))
  observer.observe(canvas)

  /**
   * 折叠/展开切换后画布尺寸变了（CSS 按 `.is-collapsed` 切 inset），
   * ResizeObserver 会在下一帧自动触发 —— 但折叠动画有 300ms 过渡，
   * 期间连续变化会让 observer 反复回调（可接受，`syncSize` 有去重）。
   * 这里额外监听一次自定义事件，保证「动画结束那一刻」也有一次精确重绘。
   */
  card.addEventListener('card-field-resize', () => {
    requestAnimationFrame(() => sync(true))
  })

  /**
   * 主题切换：**线色不再需要换**（它是图标主色，两个主题下都成立），
   * 只需要重绘一帧 —— 亮度/透明度的差异由 CSS 的 `[data-theme]` 规则处理。
   */
  card.addEventListener('theme-changed', () => sync(true))

  const dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
  const onDpr = () => { sync(true); dprQuery.removeEventListener('change', onDpr) }
  dprQuery.addEventListener('change', onDpr)

  // ── 指针 / 焦点 ──
  card.addEventListener('pointerenter', () => { hovered = true })
  card.addEventListener('pointermove', (event) => {
    hovered = true
    const rect = canvas.getBoundingClientRect()
    field.movePointer(event.clientX - rect.left, event.clientY - rect.top)
    start()
  })
  card.addEventListener('pointerleave', () => stop())
  card.addEventListener('focusin', () => { hovered = true; field.focused = true; start() })
  card.addEventListener('focusout', () => stop())

  // ── 静态首帧：等图标采样完（只读一次像素）──
  const src = window.PROVIDER_ICONS?.[provider.id]
    ?? window.PROVIDER_ICONS?.[ICON_FALLBACK[provider.id]]
  const paint = () => sync(true)
  if (typeof src === 'string' && src !== '') {
    // 采样是异步解图，画一帧占位（纯噪声），采样完再画一次
    paint()
    void field.loadIcon(src).then(() => paint())
  } else {
    paint()
  }
  // 所有卡片都持续缓慢流动（不只在悬停时）
  start()
}

/**
 * 图标回退表：上游 `PROVIDER_ICONS` 里**没有**这几个 id 的图标。
 *
 * - `aistudio` / `build`：都是 Google AI Studio 体系（一个走 API Key、
 *   一个走 App 反代），上游图标表没收录 ⇒ 回落到 Gemini 的图标
 *   （用户反馈「另外两个谷歌相关的空着很不协调」，回落到同品牌图标最自然）
 */
const ICON_FALLBACK = {
  aistudio: 'gemini',
  build: 'gemini',
  // Vertex AI 也是 Google 系（同一朵四色云），上游图标表没有它的 id
  vertex: 'gemini',
}

function providerIcon(id, cls) {
  const src = window.PROVIDER_ICONS?.[id] ?? window.PROVIDER_ICONS?.[ICON_FALLBACK[id]]
  if (typeof src !== 'string' || src === '') return ''
  return `<img class="provider-icon ${cls || ''}" src="${src}" alt="" aria-hidden="true" loading="lazy">`
}

function renderProvider(provider) {
  const card = document.createElement('div')
  card.className = 'card'

  // 未启用的供应商：只有名称/说明/开关，点开关写配置并提示重启
  if (provider.running === false) {
    card.innerHTML = `
      <div class="card-head">
        <div>
          <div class="card-title">${escapeHtml(provider.displayName)}</div>
          <div class="card-id">${escapeHtml(provider.id)} · 端口 ${provider.port}（未启用）</div>
        </div>
      </div>
      <div class="empty">${escapeHtml(provider.note || '')}</div>
      <div class="card-actions">
        <button class="btn btn-sm btn-primary" data-act="enableProvider">启用</button>
      </div>
      <div class="empty">点击即启用并开始监听，无需重启；随后在此登录账号。</div>
    `
    card.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-act="enableProvider"]')
      if (!button) return
      button.disabled = true
      try {
        const result = await api('/api/config/enable', {
          method: 'POST',
          body: JSON.stringify({ id: provider.id, enabled: true }),
        })
        toast(`${provider.displayName} ${result.note || '已启用'}`, 'ok')
        await refresh()
      } catch (error) {
        toast(String(error.message || error), 'err')
      } finally {
        button.disabled = false
      }
    })
    return card
  }

  const caps = provider.capabilities
  const tags = [
    caps.login && 'OAuth 登录',
    caps.multiAccount && '多账号',
    caps.dailyCheckin && '每日签到',
    caps.balance && '积分查询',
    caps.permanentLock && '锁定永久积分',
    caps.refresh && '自动续期',
  ].filter(Boolean).map((t) => `<span class="tag tag-on">${t}</span>`).join('')

  const view = expandedView.get(provider.id) || ''

  /**
   * **卡片折叠态**（2026-11-12 用户要求，重做交互）。
   *
   * 用户原话：「卡片本身就做成这种动态交互的，加一个小箭头，点击小箭头就
   * 丝滑的出现目前直接就用的文字按钮和功能，这样美观很多」。
   *
   * 结构：
   * - **折叠**（默认）：整张卡就是一块线场画布 + 品牌图标 + 名称 + 箭头
   * - **展开**：控制区（标签、按钮、账号列表）从下方滑出，线场缩到底部当背景
   *
   * ⚠️ 折叠状态存 `expandedView`（与「模型管理/查积分」是**两套**状态：
   *    这里管「卡片是否展开控制区」，那边管「展开区显示哪个子视图」）。
   *    合成一个会让「点了查积分」意外把卡片撑开。
   */
  const collapsed = collapsedCards.get(provider.id) ?? true
  if (collapsed) card.classList.add('is-collapsed')

  card.innerHTML = `
    <canvas class="card-field" aria-hidden="true"></canvas>
    <div class="card-head">
      ${providerIcon(provider.id, 'provider-icon-lg')}
      <div>
        <div class="card-title">${escapeHtml(provider.displayName)}</div>
        <div class="card-id">${escapeHtml(provider.id)} · 端口 ${provider.port ?? '—'}</div>
      </div>
      <div class="card-head-right">
        ${caps.permanentLock ? `
        <label class="switch" title="锁定永久积分：只使用不会过期的积分，避免浪费即将作废的额度">
          <input type="checkbox" data-act="lock" ${provider.permanentLocked ? 'checked' : ''}>
          <span>锁定永久积分</span>
        </label>` : ''}
      </div>
    </div>
    <div class="card-body"><div class="card-body-inner">
    <div class="tags">${tags}</div>
    <div class="card-actions">
      ${/* ⚠️ Build 渠道没有「账号」概念：它不登录、无凭据、无积分、无限流标记。
             故只给两个真正有意义的动作：模型管理 + 去「Build 渠道」页连接。
             照搬其它家的按钮会让用户看到一堆点了没用的东西
             （用户报障：'供应商这里加个模块好像没什么用吧'）。 */''}
      ${provider.id === 'build' ? `
        <button class="btn btn-sm btn-primary" data-act="gotoBuild">连接 / 管理</button>
        <button class="btn btn-sm" data-act="models">模型管理</button>
      ` : `
      <button class="btn btn-sm btn-primary" data-act="login">＋ 新建账号</button>
      ${caps.balance ? '<button class="btn btn-sm" data-act="balance">查积分</button>' : ''}
      ${caps.dailyCheckin ? '<button class="btn btn-sm" data-act="checkin">一键签到</button>' : ''}
      <button class="btn btn-sm" data-act="models">模型管理</button>
      <button class="btn btn-sm" data-act="refresh">续期</button>
      <button class="btn btn-sm" data-act="more">更多 ▾</button>
      `}
    </div>
    <div class="more" data-role="more" hidden>
      <button class="btn btn-sm" data-act="refreshModels">重拉模型目录</button>
      <button class="btn btn-sm" data-act="retest">重测账号</button>
      <button class="btn btn-sm" data-act="reset" title="只清本地限流标记：秒级完成、不耗额度。若上游仍在限流，下次调用会自动重新标记——想确认真实状态请用「重测账号」">重置限流标记</button>
      <button class="btn btn-sm" data-act="enableAllModels">全部模型启用</button>
      <button class="btn btn-sm" data-act="disableAllModels">全部模型停用</button>
    </div>
    <div class="accounts" data-role="accounts"></div>
    <div data-role="extra" class="${view ? 'extra-open' : ''}"></div>
    </div></div>
    <button class="card-expand" data-act="toggleCollapse" aria-expanded="${collapsed ? 'false' : 'true'}"
            title="${collapsed ? '展开控制区' : '收起'}" aria-label="${collapsed ? '展开控制区' : '收起控制区'}">
      <span class="card-expand-arrow" aria-hidden="true"></span>
    </button>
  `

  const accountsBox = card.querySelector('[data-role="accounts"]')
  const extraBox = card.querySelector('[data-role="extra"]')
  const moreBox = card.querySelector('[data-role="more"]')

  // ⚠️ Build 渠道没有账号列表 —— 说「尚未登录任何账号」是**误导**
  //    （它不需要登录，连接状态在「Build 渠道」页看）。
  if (provider.id === 'build') {
    const box = card.querySelector('[data-role="accounts"]')
    if (box !== null) {
      box.innerHTML = '<div class="empty">无需账号 —— 在「Build 渠道」页连接你的 AI Studio App</div>'
    }
  } else if (!provider.accounts || provider.accounts.length === 0) {
    accountsBox.innerHTML = '<div class="empty">尚未登录任何账号</div>'
  } else {
    for (const [index, account] of provider.accounts.entries()) {
      const row = document.createElement('div')
      row.className = 'account'
      const limited = account.modelRateLimits && Object.keys(account.modelRateLimits).length > 0
      const limitList = limited
        ? Object.entries(account.modelRateLimits)
            .filter(([, at]) => at > Date.now())
            .map(([m, at]) => `${escapeHtml(m)}（至 ${fmtTime(at)}）`)
            .join('、')
        : ''
      row.innerHTML = `
        <div class="account-main">
          <div class="account-name">
            <span class="order">${index + 1}</span>${escapeHtml(account.nickname || account.id)}
          </div>
          <div class="account-sub">
            ${escapeHtml(account.credentialRef)} ·
            ${account.enabled ? '已启用' : '已停用'} ·
            ${account.refreshable ? escapeHtml(fmtExpiry(account.expiresAt)) : '不可续期'}
          </div>
          ${limited ? `<div class="account-sub log-warn">限流：${limitList || '（标记已过期，可重置）'}</div>` : ''}
        </div>
        <div class="account-actions">
          <button class="btn btn-sm" data-act="up" data-id="${escapeHtml(account.id)}" ${index === 0 ? 'disabled' : ''} title="上移（提高选号优先级）">↑</button>
          <button class="btn btn-sm" data-act="down" data-id="${escapeHtml(account.id)}" ${index === provider.accounts.length - 1 ? 'disabled' : ''} title="下移">↓</button>
          <button class="btn btn-sm" data-act="toggle" data-id="${escapeHtml(account.id)}" data-enabled="${account.enabled}">
            ${account.enabled ? '停用' : '启用'}
          </button>
          <button class="btn btn-sm btn-danger" data-act="delete" data-id="${escapeHtml(account.id)}">删除</button>
        </div>
      `
      accountsBox.appendChild(row)
    }
  }

  /**
   * 折叠态下**点卡片任意处也能展开**（不只点小箭头）。
   *
   * 理由：折叠时卡片整个是一块「展示面」，用户直觉是点它；只让 30px 的箭头
   * 可点会让触屏用户很难命中（用户强调过「适合触控」）。
   * 展开态则**不**这样 —— 那时卡片里全是按钮，点空白就收起会很烦。
   */
  card.addEventListener('click', (event) => {
    if (!card.classList.contains('is-collapsed')) return
    // 别劫持卡片内真实控件（折叠态理论上没有，但防御性判断）
    if (event.target.closest('button, a, input, label, select')) return
    card.querySelector('.card-expand')?.click()
  })

  // ── 线条动效（2026-11-12）──
  //
  // 只在**悬停 / 聚焦**时跑满帧，其余时候画一帧静态（见 line-field.js 文件头的
  // 性能取舍）。这样 18 张卡同屏也不会持续吃 CPU。
  attachLineField(card, provider)

  // 恢复展开视图
  if (view) void renderExtra(provider, extraBox, view)

  card.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-act]')
    if (!button) return
    const act = button.dataset.act
    const id = button.dataset.id
    button.disabled = true
    try {
      switch (act) {
        case 'disableProvider': {
          // 停用：立即释放端口、停止该供应商（不必重启网关）。
          // 用 confirm 明确一点：账号数据不会被删，随时可再启用。
          const okToDisable = confirm(
            `停用 ${provider.displayName}？\n\n` +
            `• 立即停止监听并释放端口 ${provider.port ?? ''}\n` +
            `• 已登录的账号仍保存在本地，重新启用后可直接使用\n` +
            `• 已接入该端点的客户端会连不上，直到重新启用`,
          )
          if (!okToDisable) break
          const result = await api('/api/config/enable', {
            method: 'POST',
            body: JSON.stringify({ id: provider.id, enabled: false }),
          })
          toast(`${provider.displayName} ${result.note || '已停用'}`, 'ok')
          await load()
          break
        }
        case 'login': await startLogin(provider); break
        case 'toggleCollapse': {
          const nowCollapsed = !(collapsedCards.get(provider.id) ?? true)
          collapsedCards.set(provider.id, nowCollapsed)
          card.classList.toggle('is-collapsed', nowCollapsed)
          button.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true')
          const label = nowCollapsed ? '展开控制区' : '收起控制区'
          button.title = label
          button.setAttribute('aria-label', label)
          // 展开后线场缩到底部（CSS 里按 is-collapsed 切尺寸），要重算 backing store
          card.dispatchEvent(new CustomEvent('card-field-resize', { bubbles: false }))
          break
        }
        case 'balance':
          expandedView.set(provider.id, 'balance')
          await renderExtra(provider, extraBox, 'balance')
          break
        case 'models':
          expandedView.set(provider.id, 'models')
          await renderExtra(provider, extraBox, 'models')
          break
        case 'checkin': {
          const { result } = await api(`/api/p/${provider.id}/checkin`, { method: 'POST', body: '{}' })
          toast(result.message || '签到完成', result.ok ? 'ok' : 'err')
          await load()
          break
        }
        case 'refresh':
          await api(`/api/p/${provider.id}/refresh`, { method: 'POST', body: '{}' })
          toast('已触发续期', 'ok')
          break
        case 'more':
          moreBox.hidden = !moreBox.hidden
          break
        case 'refreshModels': {
          button.disabled = true
          try {
            const { count } = await api(`/api/p/${provider.id}/models/refresh`, { method: 'POST', body: '{}' })
            toast(`已从上游重拉模型目录：${count} 个`, 'ok')
            expandedView.set(provider.id, 'models')
            await load()   // 重渲染卡片，模型列表随新目录刷新
          } catch (error) {
            toast(String(error.message || error), 'err')
          } finally {
            button.disabled = false
          }
          break
        }
        case 'retest': {
          toast('重测中（会对有限流标记的模型真实发一次请求）…')
          const { result } = await api(`/api/p/${provider.id}/accounts/retest`, { method: 'POST', body: '{}' })
          toast(`重测完成：解除 ${result.clearedCount} 个，仍受限 ${result.stillLimitedCount} 个`, 'ok')
          await load()
          break
        }
        // Build 渠道：跳到「Build 渠道」页（连接控制台在那儿）。
        case 'gotoBuild':
          showPage('build')
          break
        case 'reset': {
          const { result } = await api(`/api/p/${provider.id}/accounts/reset`, { method: 'POST', body: '{}' })
          const cleared = result.clearedCount ?? 0
          if (cleared === 0) {
            toast('没有需要重置的限流标记', 'ok')
          } else {
            // ⚠️ 如实说明：这只是清了本地记录，上游的限流状态没变。
            // 若上游确实仍在限流，下次调用会自动重新标记 —— 那是正常行为，
            // 不是重置失败。想让上游裁决请用「重测账号」。
            toast(
              `已清除 ${cleared} 条本地限流标记（不影响上游状态）\n`
              + '若上游仍在限流，下次调用会自动重新标记；'
              + '想确认真实是否解禁请点「重测账号」',
              'ok',
            )
          }
          await load()
          break
        }
        case 'enableAllModels':
          await api(`/api/p/${provider.id}/model/enableAll`, { method: 'POST', body: '{}' })
          toast('已全部启用', 'ok')
          await renderExtra(provider, extraBox, 'models')
          break
        case 'disableAllModels':
          if (!confirm('确定停用全部模型？停用后该供应商将没有可用模型。')) break
          await api(`/api/p/${provider.id}/model/toggleMany`, {
            method: 'POST',
            body: JSON.stringify({ ids: (await api(`/api/p/${provider.id}/models`)).models.map((m) => m.id), disabled: true }),
          })
          toast('已全部停用', 'ok')
          await renderExtra(provider, extraBox, 'models')
          break
        case 'modelToggle': {
          const modelId = button.dataset.model
          const nowDisabled = button.dataset.enabled === 'true'
          await api(`/api/p/${provider.id}/model/toggle`, {
            method: 'POST',
            body: JSON.stringify({ id: modelId, disabled: nowDisabled }),
          })
          await renderExtra(provider, extraBox, 'models')
          break
        }
        case 'toggle':
          await api(`/api/p/${provider.id}/enable`, {
            method: 'POST',
            body: JSON.stringify({ id, enabled: button.dataset.enabled !== 'true' }),
          })
          await load()
          break
        case 'delete':
          if (!confirm(`确定删除账号 ${id}？（同时删除其本地凭据）`)) return
          await api(`/api/p/${provider.id}/accounts?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
          await load()
          break
        case 'up':
        case 'down': {
          const ids = provider.accounts.map((a) => a.id)
          const i = ids.indexOf(id)
          const j = act === 'up' ? i - 1 : i + 1
          if (j < 0 || j >= ids.length) break
          ;[ids[i], ids[j]] = [ids[j], ids[i]]
          await api(`/api/p/${provider.id}/accounts/reorder`, {
            method: 'POST',
            body: JSON.stringify({ ids }),
          })
          await load()
          break
        }
        default: break
      }
    } catch (error) {
      toast(String(error.message || error), 'err')
    } finally {
      button.disabled = false
    }
  })

  // 永久积分锁开关
  const lockBox = card.querySelector('input[data-act="lock"]')
  if (lockBox) {
    lockBox.addEventListener('change', async () => {
      try {
        const { locked } = await api(`/api/p/${provider.id}/permanentLock`, {
          method: 'POST',
          body: JSON.stringify({ locked: lockBox.checked }),
        })
        toast(`锁定永久积分：${locked ? '已开启' : '已关闭'}`, 'ok')
      } catch (error) {
        lockBox.checked = !lockBox.checked
        toast(String(error.message || error), 'err')
      }
    })
  }

  return card
}

/**
 * 展开区并发令牌：**最后一次发起的渲染胜出**（真实缺陷，2026-11-09）。
 *
 * ## 修的是什么（用户实测报障）
 *
 * 「点『查积分』后再点『模型管理』，列表又变回积分了」。
 *
 * 根因是 `renderProvider()` 末尾那句 `if (view) void renderExtra(...)`
 * —— **不等待**的异步调用。于是同一张卡片上可能同时有两次
 * `renderExtra` 在飞（一次是重渲染后恢复上一次视图，一次是用户刚点的新视图）。
 * 而它们是**各自 await 网络、然后各自写 `box.innerHTML`** ⇒
 * 先发起的如果后返回，就会把用户真正想看的那份覆盖掉。
 *
 * 网络越慢越容易复现（查积分要打上游、比查本地模型列表慢得多，
 * 所以「积分回来得晚」正好盖掉「模型列表」）。
 *
 * 修法：每个 box 记一个自增令牌，异步返回后比对 —— 不是最新那次就丢弃。
 */
const renderTokens = new Map()

/** 渲染展开区（积分 / 模型管理）。 */
async function renderExtra(provider, box, kind) {
  /**
   * ⚠️ 令牌按 **provider.id**（不是 DOM 节点）：`load()` 会把整张卡片重建，
   * 节点换了但「同一家供应商的展开区」语义没变。按节点记会让重建后的
   * 旧请求认为自己是「最新」，反而更糟。
   */
  const token = (renderTokens.get(provider.id) ?? 0) + 1
  renderTokens.set(provider.id, token)
  /** 本次渲染是否仍是「最新那次」——离开 await 后必须重新确认。 */
  const stale = () => renderTokens.get(provider.id) !== token
  box.innerHTML = '<div class="empty">加载中…</div>'
  try {
    if (kind === 'balance') {
      const { balance } = await api(`/api/p/${provider.id}/balance`)
      if (stale()) return
      box.innerHTML = renderBalance(balance)
      return
    }
    const { models } = await api(`/api/p/${provider.id}/models`)
    if (stale()) return
    if (models.length === 0) {
      box.innerHTML = '<div class="empty">没有模型（未登录，或上游目录为空）</div>'
      return
    }
    const enabledCount = models.filter((m) => m.enabled).length
    // 保留上一个搜索词（重渲染后不丢）—— 用模型列表的 provider id 做键。
    const query = modelFilter.get(provider.id) ?? ''
    /**
     * 倍率与"免费"判据。
     *
     * ⚠️ **倍率藏在 `name` 里**（真实发现，2026-10-14）：`LlmModelInfo` 本身
     * 没有价格字段，但 vendor 适配器把它**拼进了展示名**，实测形如
     * `"Hy4 preview · x0.29"` / `"Step-5-Preview · x0.00→免费"`。
     * 故这里从 `name` 解析，并把倍率单独显示（`name` 里那份仍保留 ——
     * 它是 vendor 的原始展示口径，不擅自改写）。
     */
    const priceOf = (m) => {
      const name = String(m.name ?? '')
      if (/免费/.test(name)) return { free: true, text: '免费' }
      const x = /x(\d+(?:\.\d+)?)/i.exec(name)
      if (x !== null) return { free: false, text: `x${x[1]}` }
      // 兜底：id 命名线索（如 `space-bunny-free`）。
      return /-free$/i.test(String(m.id ?? '')) ? { free: true, text: '免费' } : undefined
    }
    const isFree = (m) => priceOf(m)?.free === true

    /**
     * 展示名里剥掉倍率后缀（`"Hy4 preview · x0.29"` → `"Hy4 preview"`）。
     *
     * ⚠️ vendor 把倍率拼进了 `name`，而我们**另外**用标签呈现倍率 ⇒
     * 不剥就会显示两次（实测截图：`DeepSeek-V3... x0.29` + 右侧 `x0.29` 标签）。
     * 标签比内联更易扫读（右对齐一列），故保留标签、剥掉内联那份。
     */
    const bareName = (m) => {
      const name = String(m.name ?? m.id ?? '')
      return name
        .replace(/\s*·\s*x\d+(?:\.\d+)?(?:→免费)?\s*$/i, '')
        .replace(/\s*·\s*免费\s*$/i, '')
        .trim() || String(m.id ?? '')
    }
    const sorted = [...models].sort((a, b) => {
      const fa = isFree(a) ? 0 : 1
      const fb = isFree(b) ? 0 : 1
      if (fa !== fb) return fa - fb
      return bareName(a).localeCompare(bareName(b), 'zh-CN')
    })
    box.innerHTML = `
      <div class="extra-head">
        <span>模型管理</span>
        <span class="endpoint-note">
          启用 ${enabledCount} / 共 ${models.length}
          <button class="btn btn-sm" data-act="refreshModels" style="margin-left:8px">↻ 重拉</button>
        </span>
      </div>
      <div class="model-toolbar">
        <input class="model-search" type="search" placeholder="搜索模型名或 id…"
               value="${escapeHtml(query)}" data-role="model-search"
               autocomplete="off" spellcheck="false">
        <button class="btn btn-sm" data-role="only-free">只看免费</button>
        <button class="btn btn-sm" data-role="only-disabled">只看停用</button>
        <span class="model-count" data-role="model-count"></span>
      </div>
      <div class="model-list" data-role="model-list">
        ${sorted.map((m) => `
          <label class="model-row ${m.enabled ? '' : 'is-off'}"
                 data-model="${escapeHtml(m.id)}"
                 data-search="${escapeHtml((bareName(m) + ' ' + m.id).toLowerCase())}"
                 data-free="${isFree(m) ? '1' : '0'}"
                 data-enabled="${m.enabled ? '1' : '0'}">
            <input type="checkbox" class="model-check" ${m.enabled ? 'checked' : ''}
                   data-act="modelToggle" data-model="${escapeHtml(m.id)}">
            <span class="model-main">
              <span class="model-name">${escapeHtml(bareName(m))}</span>
              <span class="model-id">${escapeHtml(m.id)}</span>
            </span>
            ${(() => {
              const price = priceOf(m)
              if (price === undefined) return ''
              return `<span class="tag ${price.free ? 'tag-ok' : ''}">${escapeHtml(price.text)}</span>`
            })()}
          </label>
        `).join('')}
      </div>
    `

    /**
     * 按搜索词 + 两个筛选开关刷新可见性。
     *
     * ⚠️ 用 `hidden` 属性隐藏行（CSS 已确保 `.model-row[hidden]` 生效）：
     * 直接 `display:none` 内联样式会在下次重渲染时丢失，而重渲染很频繁
     * （每次切换模型都会）。
     */
    const applyFilter = () => {
      const list = box.querySelector('[data-role="model-list"]')
      if (list === null) return
      const q = (box.querySelector('[data-role="model-search"]')?.value ?? '').trim().toLowerCase()
      const onlyFree = box.querySelector('[data-role="only-free"]')?.classList.contains('is-active') === true
      const onlyOff = box.querySelector('[data-role="only-disabled"]')?.classList.contains('is-active') === true
      let shown = 0
      for (const row of list.querySelectorAll('.model-row')) {
        let ok = true
        if (q.length > 0 && !(row.dataset.search ?? '').includes(q)) ok = false
        if (onlyFree && row.dataset.free !== '1') ok = false
        if (onlyOff && row.dataset.enabled !== '0') ok = false
        row.hidden = !ok
        if (ok) shown++
      }
      const counter = box.querySelector('[data-role="model-count"]')
      if (counter !== null) counter.textContent = `显示 ${shown} / ${sorted.length}`
    }

    const search = box.querySelector('[data-role="model-search"]')
    search?.addEventListener('input', () => {
      modelFilter.set(provider.id, search.value)
      applyFilter()
    })
    for (const role of ['only-free', 'only-disabled']) {
      box.querySelector(`[data-role="${role}"]`)?.addEventListener('click', (e) => {
        e.currentTarget.classList.toggle('is-active')
        applyFilter()
      })
    }
    applyFilter()
    // 复选框的 click 会冒泡到卡片的 data-act 处理；这里直接复用同一处理路径。
    box.querySelectorAll('input[data-act="modelToggle"]').forEach((input) => {
      input.addEventListener('click', (e) => e.stopPropagation())
      input.addEventListener('change', async () => {
        const modelId = input.dataset.model
        const wantEnabled = input.checked
        input.disabled = true
        try {
          await api(`/api/p/${provider.id}/model/toggle`, {
            method: 'POST',
            body: JSON.stringify({ id: modelId, disabled: !wantEnabled }),
          })
          await renderExtra(provider, box, 'models')
        } catch (error) {
          input.checked = !input.checked
          toast(String(error.message || error), 'err')
        } finally {
          input.disabled = false
        }
      })
    })
  } catch (error) {
    box.innerHTML = `<div class="empty log-error">${escapeHtml(String(error.message || error))}</div>`
  }
}

function renderBalance(balance) {
  if (!balance) return '<div class="empty">查不到余额（未登录、账号未开通，或上游接口变动）</div>'
  // ⚠️ 三态如实标注：百分比不能显示成「积分」（Gemini 的额度就是百分比）。
  const unit = balance.unit === 'tokens' ? 'tokens' : balance.unit === 'percent' ? '%' : '积分'
  const items = (balance.items || []).map((item) => {
    // 失效时刻（有则显示，说明"这批额度什么时候作废"）。
    const exp = item.expireAt
      ? ` <span class="endpoint-note">（至 ${new Date(item.expireAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}）</span>`
      : ''
    // `note: true` = 纯说明行（账号规格 / 未授权），不显示数量。
    const amount = item.note === true ? '' : `<code>${item.remain} ${unit}</code>`
    return `
    <div class="endpoint">
      <span class="endpoint-label">${escapeHtml(item.name)}${exp}</span>
      ${amount}
    </div>`
  }).join('')
  const header = balance.unit === 'percent'
    ? `<div class="endpoint" style="margin-bottom:6px">
         <span class="endpoint-label"><b>合计</b> <span class="endpoint-note">（两个窗口剩余百分比的均值）</span></span>
         <code>${balance.total} %</code>
       </div>`
    : `<div class="endpoint" style="margin-bottom:6px">
         <span class="endpoint-label"><b>合计</b></span>
         <code>${balance.total} ${unit}</code>
       </div>`
  return header + items
}

/**
 * 弹一个「填文本」对话框（返回 null 表示用户取消）。
 *
 * ⚠️ 用自建 DOM 而不是原生 `prompt()`：原生 prompt 在部分浏览器/内嵌 WebView 里
 * 被禁用或样式不可控，且无法展示 hint 的换行说明。
 */
function promptForValue(provider, input) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h3>${escapeHtml(provider.displayName)} · 添加账号</h3>
        <input class="modal-input" type="text" autocomplete="off" spellcheck="false"
               placeholder="${escapeHtml(input.placeholder || '粘贴凭据')}">
        ${input.hint ? `<p class="modal-hint">${escapeHtml(input.hint)}</p>` : ''}
        <div class="modal-actions">
          <button class="btn btn-sm" data-role="cancel">取消</button>
          <button class="btn btn-sm btn-primary" data-role="ok">确定</button>
        </div>
      </div>`
    document.body.appendChild(overlay)
    const field = overlay.querySelector('.modal-input')
    const done = (value) => { overlay.remove(); resolve(value) }
    overlay.querySelector('[data-role="ok"]').addEventListener('click', () => done(field.value))
    overlay.querySelector('[data-role="cancel"]').addEventListener('click', () => done(null))
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null) })
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(field.value)
      if (e.key === 'Escape') done(null)
    })
    field.focus()
  })
}

async function startLogin(provider) {
  const popup = window.open('', '_blank')
  try {
    const { loginUrl, accountId, input } = await api(`/api/p/${provider.id}/login`, {
      method: 'POST',
      body: JSON.stringify({}),
    })
    // 「填文本」型登录（如 OpenCode API Key）：不开窗口，弹输入框。
    // ⚠️ 必须先关掉为 OAuth 预开的空白窗口，否则会留一个空白标签页。
    if (input !== undefined && input !== null) {
      if (popup) popup.close()
      const value = await promptForValue(provider, input)
      if (value === null) return
      const r = await api(`/api/p/${provider.id}/login/submit`, {
        method: 'POST',
        body: JSON.stringify({ value }),
      })
      if (r.ok === false) { toast(r.error || '提交失败', 'err'); await load(); return }
      toast('账号已添加', 'ok')
      await load()
      return
    }
    if (popup) popup.location.href = loginUrl
    else window.open(loginUrl, '_blank')
    toast('已打开授权页面，请在浏览器中完成登录…', 'ok')

    for (let i = 0; i < 100; i += 1) {
      await new Promise((r) => setTimeout(r, 2000))
      let accounts = []
      try { accounts = (await api(`/api/p/${provider.id}/accounts`)).accounts || [] } catch { continue }
      const account = accounts.find((a) => a.id === accountId)
      if (!account) { toast('登录失败：账号已被移除', 'err'); await load(); return }
      if (account.refreshable || account.nickname !== accountId) {
        toast(`登录成功：${account.nickname}`, 'ok')
        await load()
        return
      }
    }
    toast('等待授权超时，可稍后刷新查看', 'err')
    await load()
  } catch (error) {
    if (popup) popup.close()
    toast(String(error.message || error), 'err')
  }
}

async function load() {
  try {
    const { providers, lan } = await api('/api/overview')
    // 缓存后端令牌，供 Build 页拼 WebSocket 地址用（见 lanTokenCache 注释）。
    if (lan && typeof lan.accessToken === 'string') lanTokenCache = lan.accessToken
    /**
     * **主界面只显示已启用的供应商**（2026-11-12 用户要求）。
     *
     * 之前 18 家全铺在主界面上，其中 11 家是「未启用」的空壳卡片 —— 主界面
     * 又长又空（用户原话「太空虚，利用区域太少」）。现在：
     *   · 已启用 → 主界面完整卡片（账号、账号池、操作按钮）
     *   · 未启用 → 收进「供应商开关」面板，一处统一管理
     *
     * ⚠️ `running`（进程在监听）与 `enabledInConfig`（配置里开启）不是一回事：
     *    刚改完配置还没重启时二者会不一致。判据用 **running** —— 卡片上的按钮
     *    （登录/查积分/模型管理）都依赖进程真的在跑，否则点了只会报错。
     */
    const runningProviders = providers.filter((p) => p.running === true)
    const box = $('#providers')
    box.innerHTML = ''
    for (const provider of runningProviders) box.appendChild(renderProvider(provider))
    if (runningProviders.length === 0) {
      box.innerHTML = '<div class="empty">还没有启用任何供应商 —— 点右上角「供应商开关」开启。</div>'
    }

    renderProviderSwitches(providers)
    renderEndpoints(providers, lan)

    $('#conn').className = 'pill pill-ok'
    $('#conn').textContent = `正常 · ${runningProviders.length}/${providers.length} 家已启用`
  } catch {
    $('#conn').className = 'pill pill-err'
    $('#conn').textContent = '网关无响应'
  }
}

/**
 * 渲染「供应商开关」面板（2026-11-12 新增，用户要求）。
 *
 * ## 为什么要有它
 *
 * 主界面现在只显示**已启用**的供应商，未启用的必须有个地方能开 ——
 * 否则用户永远看不到它们。这个面板就是那个入口：
 * 全部 18 家一行一个，右边开关，已开/未开自动分组排序。
 *
 * ## 交互
 *
 * 开关走 `/api/config/enable`（与原来卡片上的「启用」按钮**同一个接口**），
 * 写配置后**无需重启**（注册表支持热启用）。切换后刷新整个页面数据。
 *
 * ⚠️ 开关的 `checked` 用 **running** 而不是 enabledInConfig：二者不一致时
 *    （配置刚改、进程还没起来）以「实际在跑」为准，否则开关显示开着但卡片没了。
 */
function renderProviderSwitches(providers) {
  const body = $('#switches-body')
  const count = $('#switches-count')
  const dialog = $('#switches-dialog')
  if (body === null) return

  const running = providers.filter((p) => p.running === true)
  const stopped = providers.filter((p) => p.running !== true)
  // 已开的排前面；未开的排后面（两组内部保持后端给的顺序 = 端口顺序）
  const ordered = [...running, ...stopped]

  if (count !== null) count.textContent = `${running.length} 开 · ${stopped.length} 关`

  body.innerHTML = ordered.map((provider) => {
    const on = provider.running === true
    const accounts = Array.isArray(provider.accounts) ? provider.accounts.length : 0
    return `
      <div class="switch-row ${on ? '' : 'is-off'}" data-provider="${escapeHtml(provider.id)}">
        <span class="switch-grip" aria-hidden="true">⠿</span>
        ${providerIcon(provider.id, 'provider-icon-sm')}
        <span class="switch-name">${escapeHtml(provider.displayName)}</span>
        <span class="switch-meta">账号 ${accounts}</span>
        <span class="switch-port">${provider.port ?? '—'}</span>
        <label class="switch switch-mini" title="${on ? '关闭' : '开启'} ${escapeHtml(provider.displayName)}">
          <input type="checkbox" data-act="toggleProvider" data-id="${escapeHtml(provider.id)}" ${on ? 'checked' : ''}>
          <span class="switch-track" aria-hidden="true"></span>
        </label>
      </div>
    `
  }).join('')

  // 事件只绑一次（面板 DOM 在每次 load 时重建 innerHTML，故用委托）
  if (body.dataset.bound === '1') return
  body.dataset.bound = '1'
  body.addEventListener('change', async (event) => {
    const input = event.target.closest('input[data-act="toggleProvider"]')
    if (input === null) return
    const providerId = input.dataset.id
    const enabled = input.checked
    input.disabled = true
    try {
      const result = await api('/api/config/enable', {
        method: 'POST',
        body: JSON.stringify({ id: providerId, enabled }),
      })
      toast(result.note || (enabled ? '已启用' : '已停用'), 'ok')
      await load()
    } catch (error) {
      toast(String(error.message || error), 'err')
      // 失败时回滚开关外观（否则界面与实际不一致）
      input.checked = !enabled
    } finally {
      input.disabled = false
    }
  })
  void dialog
}

/** 小工具：把文本放进可点击复制的 <code>（点击即复制，手机上尤其好用）。 */
function copyable(text, title) {
  return `<code class="copyable" data-copy="${escapeHtml(text)}" title="${escapeHtml(title || '点击复制')}">${escapeHtml(text)}</code>`
}

/**
 * 渲染「接入方式」面板。
 *
 * ## 为什么 IP 要从服务端拿
 *
 * 浏览器**无法得知运行网关那台电脑的网卡 IP**——`location.hostname` 只是
 * "当前访问用的地址"。手机通过 `10.198.81.112` 打开时它是局域网 IP，但
 * 本机用 `127.0.0.1` 打开时它又是回环地址，而手机恰恰需要的是前者。
 *
 * 所以地址由服务端 `/api/overview` 实时探测下发（手机不能自己猜）。
 * 校园网 IP 会变，服务端每次请求都重新读网卡，前端 20 秒轮询一次，
 * **IP 一变这里就自动更新**，不需要重启网关。
 */
function renderEndpoints(providers, lan) {
  const box = $('#endpoints')
  const port = (lan && lan.port) || location.port || '8790'
  const addresses = (lan && Array.isArray(lan.addresses)) ? lan.addresses : []
  const exposed = Boolean(lan && lan.exposed)
  const token = (lan && lan.accessToken) || accessToken || ''

  // 当前这个页面是用哪个地址打开的？若是局域网 IP，把它排到最前
  // （手机打开时，最该填的就是它自己正在用的这个地址）。
  const currentHost = location.hostname
  const sorted = [...addresses].sort((a, b) => {
    if (a.address === currentHost) return -1
    if (b.address === currentHost) return 1
    return 0
  })

  let html = ''

  // ── 局域网接入卡片（核心）──
  if (!exposed) {
    html += `
      <div class="endpoint endpoint-warn">
        <div>
          <div class="endpoint-label">局域网接入 <span class="endpoint-note">（当前未开放）</span></div>
          <div class="endpoint-note">
            网关正监听 <code style="font-size:11px">${escapeHtml((lan && lan.host) || '127.0.0.1')}</code>，
            手机等局域网设备无法访问。要在 <code style="font-size:11px">config.json</code>
            里设置 <code style="font-size:11px">"host": "0.0.0.0"</code> 后重启网关。
          </div>
        </div>
      </div>`
  } else if (sorted.length === 0) {
    html += `
      <div class="endpoint endpoint-warn">
        <div>
          <div class="endpoint-label">局域网接入 <span class="endpoint-note">（未找到可用地址）</span></div>
          <div class="endpoint-note">已开放局域网监听，但没探测到非回环 IPv4 地址。请检查网卡是否已连接。</div>
        </div>
      </div>`
  } else {
    for (const entry of sorted) {
      const isCurrent = entry.address === currentHost
      const base = `http://${entry.address}:${port}`
      html += `
        <div class="endpoint endpoint-lan${isCurrent ? ' endpoint-current' : ''}">
          <div>
            <div class="endpoint-label">
              🌐 局域网接入 <span class="endpoint-note">（${escapeHtml(entry.iface || '网卡')}${isCurrent ? ' · 你正在用它' : ''}）</span>
            </div>
            <div class="endpoint-note">
              控制台 ${copyable(`${base}/`, '点击复制控制台地址')}
              &nbsp;·&nbsp;
              OpenAI ${copyable(`${base}/v1`, '点击复制 OpenAI 基址')}
              &nbsp;·&nbsp;
              Anthropic ${copyable(`${base}/v1/messages`, '点击复制 Anthropic 地址')}
            </div>
            <div class="endpoint-note">
              模型 id 写成 <code style="font-size:11px">供应商/模型</code>，例如 <code style="font-size:11px">trae/deepseek-v4.1-flash</code>
              （Anthropic 客户端把 Base URL 填 <code style="font-size:11px">${escapeHtml(base)}</code>）
            </div>
            ${token ? `<div class="endpoint-note">API Key 填令牌 ${copyable(token, '点击复制访问令牌')}</div>` : ''}
          </div>
        </div>`
    }
  }

  /**
   * ── 供应商独立端点（OpenAI 与 Anthropic 同端口、不同路径）──
   *
   * ⚠️ **只列已启用的**（2026-11-12 用户要求「没有启用的没必要显示」）。
   * 之前 18 家全列，其中 11 家是「未启动 / —」的空条目 —— 把真正能用的地址
   * 埋在噪音里。未启用的现在只出现在「供应商开关」面板。
   */
  const runningForEndpoints = providers.filter((p) => p.running === true)
  html += runningForEndpoints.map((p) => {
    const base = p.baseUrl || ''
    // ⚠️ 独立端口的 Anthropic 地址由 OpenAI 地址推导（同 host:port，换路径）：
    // 网关在这两个路径上挂了同一套管线，模型都写裸名。
    const anth = base.replace(/\/v1$/, '/v1/messages')
    return `
    <div class="endpoint">
      <div>
        <div class="endpoint-label">${escapeHtml(p.displayName)} <span class="endpoint-note">（独立端点）</span></div>
        <div class="endpoint-note">
          <b>OpenAI</b> ${p.baseUrl ? copyable(base, '点击复制 OpenAI 地址') : '未启动'}
          &nbsp;·&nbsp;
          <b>Anthropic</b> ${p.baseUrl ? copyable(anth, '点击复制 Anthropic 地址') : '—'}
        </div>
        <div class="endpoint-note">模型 id 用裸名，例如 <code style="font-size:11px">glm-5.3</code></div>
      </div>
    </div>`
  }).join('')

  // ── 聚合端点：两种协议都列出来（用户要求：Anthropic 地址放前端）──
  const aggBase = `http://127.0.0.1:${escapeHtml(String(port))}`
  html += `
    <div class="endpoint endpoint-lan">
      <div>
        <div class="endpoint-label">聚合端点 · OpenAI <span class="endpoint-note">（本机，一次接入全部）</span></div>
        <div class="endpoint-note">
          Base URL ${copyable(`${aggBase}/v1`, '点击复制')}
          &nbsp;·&nbsp; 完整地址 ${copyable(`${aggBase}/v1/chat/completions`, '点击复制')}
        </div>
        <div class="endpoint-note">模型 id 写成 <code style="font-size:11px">供应商/模型</code>，例如 <code style="font-size:11px">buddy/glm-5.3</code></div>
      </div>
    </div>
    <div class="endpoint endpoint-lan">
      <div>
        <div class="endpoint-label">聚合端点 · Anthropic <span class="endpoint-note">（Claude Code / Cline 等）</span></div>
        <div class="endpoint-note">
          Base URL（填在 <code style="font-size:11px">ANTHROPIC_BASE_URL</code>）${copyable(aggBase, '点击复制')}
          &nbsp;·&nbsp; 完整地址 ${copyable(`${aggBase}/v1/messages`, '点击复制')}
        </div>
        <div class="endpoint-note">
          模型同样写 <code style="font-size:11px">供应商/模型</code>；
          API Key 填访问令牌（客户端若要求 <code style="font-size:11px">x-api-key</code> 同样用它）
        </div>
      </div>
    </div>
    <!--
      **决策端点**（2026-11-12 新增）。

      ⚠️ 它**不是聊天端点**：请求体是「材料 + 问题集」，返回的是概率/置信度，
      不是文字。所以单独列一张卡，并把「为什么不在模型列表里」写清楚 ——
      否则用户会去 /v1/models 里找 gemini-decision-1 然后找不到。
    -->
    <div class="endpoint endpoint-decision">
      <div>
        <div class="endpoint-label">
          🧭 决策端点 · Gemini Decisions <span class="endpoint-note">（打分接口，不是聊天模型）</span>
        </div>
        <div class="endpoint-note">
          ${copyable(`${aggBase}/v1/decisions`, '点击复制决策端点')}
          <span class="endpoint-note">（<code style="font-size:11px">gemini-decision-1</code>，零输出 token）</span>
        </div>
        <div class="endpoint-note">
          请求体是 <code style="font-size:11px">input</code> + <code style="font-size:11px">questions</code>，
          <b>不是</b> <code style="font-size:11px">messages</code>；支持 noul（是/否）、choice（多选）、score（评分），
          一次最多 1000 个问题共用同一份材料。
        </div>
        <div class="endpoint-note">
          ⚠️ 故它**不在模型列表里** —— 选中后发 <code style="font-size:11px">messages</code> 必然 400。
          需要 <b>AI Studio (API Key)</b> 渠道有启用账号。
          详见 <code style="font-size:11px">docs/gemini-decisions.md</code>。
        </div>
      </div>
    </div>`

  box.innerHTML = html

  // 刷新时间戳：让用户知道地址是实时的（IP 变了会在下一轮自动更新）。
  const stamp = $('#lan-updated')
  if (stamp) {
    stamp.textContent = `地址实时探测 · 更新于 ${new Date().toLocaleTimeString()}`
  }
}

async function loadLogs() {
  try {
    const { logs } = await api('/api/logs')
    const box = $('#logs')
    box.innerHTML = logs.slice(-200).map((line) => {
      const cls = line.level === 'error' ? 'log-error' : line.level === 'warn' ? 'log-warn' : ''
      const time = new Date(line.at).toTimeString().slice(0, 8)
      return `<span class="${cls}">${time} [${escapeHtml(line.providerId)}] ${escapeHtml(line.text)}</span>`
    }).join('\n')
    box.scrollTop = box.scrollHeight
  } catch {
    // 日志失败不影响主界面。
  }
}

$('#refresh-models-all').addEventListener('click', async () => {
  const button = $('#refresh-models-all')
  button.disabled = true
  try {
    const { results } = await api('/api/models/refresh-all', { method: 'POST', body: '{}' })
    const parts = Object.entries(results).map(([id, r]) =>
      r && typeof r === 'object' && 'count' in r ? `${id}=${r.count}` : `${id}=失败`)
    toast(`模型目录已刷新：${parts.join('  ')}`, 'ok')
    await load()
  } catch (error) {
    toast(String(error.message || error), 'err')
  } finally {
    button.disabled = false
  }
})

$('#checkin-all').addEventListener('click', async () => {
  const button = $('#checkin-all')
  button.disabled = true
  const original = button.textContent
  button.textContent = '签到中…'
  try {
    const { total, claimed, results } = await api('/api/checkin-all', { method: 'POST', body: '{}' })
    if (total === 0) {
      toast('没有可签到的供应商（需已启用且支持签到）', 'err')
      return
    }
    // 逐条展示，让「今天已领」「不支持」「失败」一目了然，而不是一个笼统的“完成”。
    const lines = results.map((r) => {
      const mark = r.ok ? '✓' : '✗'
      const what = r.status === 'already-claimed' ? '今天已领' : (r.message || r.status)
      const amount = r.amount !== undefined ? `（+${r.amount}）` : ''
      return `${mark} ${r.displayName}${amount}: ${what}`
    })
    const failed = results.filter((r) => !r.ok).length
    toast(`签到完成：${claimed}/${total} 成功\n${lines.join('\n')}`, failed === 0 ? 'ok' : 'err')
    await load()
  } catch (error) {
    toast(String(error.message || error), 'err')
  } finally {
    button.disabled = false
    button.textContent = original
  }
})

// ── 亮色 / 暗色主题（2026-11-12 用户要求）──
//
// 三态：`dark`（默认）/ `light` / 跟随系统。跟随系统时监听
// `prefers-color-scheme`，系统切了就跟着切（不需要刷页面）。
//
// ⚠️ 主题存在 **localStorage**（不是服务端配置）：这是纯浏览器偏好，
//    同一台机器用手机/电脑打开可以各用各的。首屏闪白的规避见 index.html
//    里的内联脚本（在 CSS 加载前就把 data-theme 定好）。
const THEME_KEY = 'dsh-gateway-theme'
const themeMedia = window.matchMedia('(prefers-color-scheme: light)')

/** 解析当前生效的主题：显式设置优先，否则跟系统。 */
function resolvedTheme() {
  const saved = localStorage.getItem(THEME_KEY)
  if (saved === 'light' || saved === 'dark') return saved
  return themeMedia.matches ? 'light' : 'dark'
}

function applyTheme() {
  const theme = resolvedTheme()
  document.documentElement.dataset.theme = theme
  const button = $('#theme-toggle')
  const label = $('#theme-label')
  const icon = $('#theme-icon')
  if (button !== null) {
    // aria-pressed 语义：true = 亮色（当前是「亮色开关」按下去的状态）
    button.setAttribute('aria-pressed', theme === 'light' ? 'true' : 'false')
    button.title = theme === 'light' ? '当前亮色，点击切到暗色' : '当前暗色，点击切到亮色'
  }
  if (label !== null) label.textContent = theme === 'light' ? '亮色' : '暗色'
  if (icon !== null) icon.textContent = theme === 'light' ? '☀' : '☾'
  /**
   * 通知所有卡片「主题变了，线色要重取」。
   *
   * ⚠️ 线色是构造时确定的常量（不是 CSS 变量），主题切换不会自动生效 ——
   * 不重新挂载就会「切到亮色后线场还是浅灰的，看不见」。
   * 这里不重挂整个卡片（会丢展开状态），只让 attachLineField 更新 ink 并重绘。
   */
  for (const card of document.querySelectorAll('#providers .card')) {
    card.dispatchEvent(new CustomEvent('theme-changed', { bubbles: false }))
  }
}

$('#theme-toggle')?.addEventListener('click', () => {
  const next = resolvedTheme() === 'light' ? 'dark' : 'light'
  localStorage.setItem(THEME_KEY, next)
  applyTheme()
})

// 系统主题变化时：只有「没显式设置过」才跟着变（用户明确选过就尊重用户）
themeMedia.addEventListener('change', () => {
  if (localStorage.getItem(THEME_KEY) === null) applyTheme()
})

applyTheme()

// ── 供应商开关面板（2026-11-12）──
// 用原生 <dialog>：键盘可操作、Esc 自动关闭、焦点管理由浏览器负责。
for (const id of ['open-switches', 'open-switches-2']) {
  document.getElementById(id)?.addEventListener('click', () => {
    document.getElementById('switches-dialog')?.showModal()
  })
}
document.getElementById('switches-close')?.addEventListener('click', () => {
  document.getElementById('switches-dialog')?.close()
})

$('#refresh-all').addEventListener('click', async () => {
  try {
    const { providers } = await api('/api/overview')
    for (const provider of providers) {
      await api(`/api/p/${provider.id}/refresh`, { method: 'POST', body: '{}' }).catch(() => {})
    }
    toast('已触发全部供应商续期', 'ok')
  } catch (error) {
    toast(String(error.message || error), 'err')
  }
})

// ── 点击复制（手机上尤其好用，不用长按选中）──
document.addEventListener('click', async (event) => {
  const el = event.target.closest('.copyable')
  if (!el) return
  const text = el.dataset.copy || el.textContent || ''
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // clipboard API 在非 HTTPS（如 http://10.x.x.x）下常被浏览器禁用。
    // 退回到 selection + execCommand，仍能在手机上工作。
    try {
      const range = document.createRange()
      range.selectNodeContents(el)
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      document.execCommand('copy')
      selection.removeAllRanges()
    } catch {
      toast('复制失败，请手动长按选中', 'err')
      return
    }
  }
  toast('已复制：' + text, 'ok')
})

// ── 令牌设置（局域网访问时必需）──
//
// 留空表示清除。清除后重新载入，让"连接中…"如实反映当前是否还被拦。
$('#set-token').addEventListener('click', async () => {
  const current = accessToken
  const value = window.prompt(
    '访问令牌（局域网访问需要；本机 127.0.0.1 访问可留空）\n'
    + '令牌见网关启动日志，或 config.json 的 accessToken 字段。\n\n'
    + '留空并确定 = 清除已保存的令牌。',
    current,
  )
  if (value === null) return
  setToken(value)
  toast(accessToken ? '令牌已保存' : '令牌已清除', 'ok')
  await load().catch(() => {})
})

// ── 用量统计 ──
//
// 只展示元数据（模型/token/耗时），不含对话内容。数据源是网关侧的
// usage.jsonl（见 src/core/usage.ts），本面板只读不写。
/**
 * 数据页的当前时间范围（天）。0 = 全部。默认近 30 天（与按钮初始态一致）。
 */
let usageRangeDays = 30

/** 当前拉到的最近一次报表（切范围时复用，避免重复请求）。 */
let usageData = null

/**
 * 取某条记录是否落在当前范围内。
 *
 * ⚠️ 用**本地日**（UTC+8）比较，与 usage.ts 的 `dayKey` 同口径 ——
 * 否则"今日"会把晚上 8 点后的调用算到昨天。
 */
function withinRange(at, days, nowMs = Date.now()) {
  if (days <= 0) return true
  const day = 86400000
  const todayStart = Math.floor((nowMs + 8 * 3600000) / day) * day - 8 * 3600000
  return at >= todayStart - (days - 1) * day
}

/** 按 UTC+8 取 `YYYY-MM-DD`（与后端 dayKey 一致）。 */
function dayKeyOf(at) {
  const d = new Date(at + 8 * 3600000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

/**
 * 渲染活动方块热力图（Claude Code / GitHub 风格）。
 *
 * 布局：按**周为列、星期为行**（GitHub 的读法），最多显示 `maxWeeks` 周。
 * 用纯 CSS grid + div，不用 canvas —— 便于 hover 提示与无障碍。
 */
function renderHeatmap(buckets, days) {
  const box = $('#heatmap')
  const note = $('#heat-note')
  if (box === null) return
  if (buckets.length === 0) {
    box.innerHTML = '<div class="empty">该范围内暂无调用</div>'
    if (note) note.textContent = ''
    return
  }

  const day = 86400000
  const now = Date.now()
  // 以「今天」为最后一列的最后一天（UTC+8）。
  const todayStart = Math.floor((now + 8 * 3600000) / day) * day - 8 * 3600000
  const span = days > 0 ? days : Math.max(7, Math.ceil((now - Math.min(...buckets.map(b => Date.parse(b.key)))) / day))
  // ⚠️ 列数用 `ceil(span / 7)`（**不 +1**）：+1 会多画一整周的空格子
  //    （真实缺陷：30 天范围显示成 6 列 42 格，末列整列无数据）。
  //    对齐到整周是为了让「同一列 = 同一星期几」，与 GitHub 的读法一致。
  const maxWeeks = Math.min(53, Math.max(1, Math.ceil(span / 7)))
  const totalDays = maxWeeks * 7

  // 日期 → 调用数
  const byDay = new Map(buckets.map(b => [b.key, b.calls]))
  const max = Math.max(1, ...buckets.map(b => b.calls))

  // 分级：0 / ≤25% / ≤50% / ≤75% / 更高 —— 与图例的 5 档对应。
  const level = (n) => n === 0 ? 0 : n <= max * 0.25 ? 1 : n <= max * 0.5 ? 2 : n <= max * 0.75 ? 3 : 4

  // 生成 totalDays 个格子，末格 = 今天；每 7 个一列。
  const cells = []
  for (let i = totalDays - 1; i >= 0; i--) {
    const at = todayStart - i * day
    const key = dayKeyOf(at)
    cells.push({ key, calls: byDay.get(key) ?? 0 })
  }
  const cols = []
  for (let i = 0; i < cells.length; i += 7) cols.push(cells.slice(i, i + 7))

  const activeDays = buckets.length
  const totalCalls = buckets.reduce((s, b) => s + b.calls, 0)
  if (note) note.textContent = `${activeDays} 天有调用 · 共 ${totalCalls.toLocaleString('zh-CN')} 次`

  box.innerHTML = `<div class="heat-weeks">${cols.map((col) => `
    <div class="heat-col">${col.map((c) => `
      <i class="heat-cell lv${level(c.calls)}" title="${c.key}：${c.calls} 次"></i>`).join('')}
    </div>`).join('')}
  </div>`
}

/**
 * 柱状图（每日调用量）。手绘 SVG，不引第三方图表库（保证离线可用）。
 */
function renderBarChart(buckets, days) {
  const box = $('#chart-bars')
  const note = $('#bar-note')
  if (box === null) return
  if (buckets.length === 0) { box.innerHTML = '<div class="empty">暂无数据</div>'; if (note) note.textContent = ''; return }

  // 按日期升序，且补全区间内的空日（否则柱子会被"跳过"的空日压缩，趋势失真）。
  const day = 86400000
  const now = Date.now()
  const todayStart = Math.floor((now + 8 * 3600000) / day) * day - 8 * 3600000
  const span = days > 0 ? days : Math.max(7, Math.ceil((now - Date.parse(buckets[0].key)) / day) + 1)
  const byDay = new Map(buckets.map(b => [b.key, b]))
  const series = []
  for (let i = span - 1; i >= 0; i--) {
    const key = dayKeyOf(todayStart - i * day)
    const b = byDay.get(key)
    series.push({ key, calls: b?.calls ?? 0, okCalls: b?.okCalls ?? 0, failures: b?.failures ?? 0 })
  }

  const W = 760, H = 190, padL = 34, padB = 22, padT = 8, padR = 6
  const max = Math.max(1, ...series.map(s => s.calls))
  const bw = Math.max(2, (W - padL - padR) / series.length - 2)

  const bars = series.map((s, i) => {
    const x = padL + i * ((W - padL - padR) / series.length)
    const h = (s.calls / max) * (H - padT - padB)
    const y = H - padB - h
    // 失败次数用红色叠在柱子顶部，一眼看出"这天有多少失败"。
    const fh = s.calls > 0 ? (s.failures / max) * (H - padT - padB) : 0
    return `${fh > 0 ? `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${fh.toFixed(1)}" fill="#f4635b" rx="1.5"><title>${s.key} 失败 ${s.failures} 次</title></rect>` : ''}`
      + `<rect class="bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="2"><title>${s.key}：${s.calls} 次（失败 ${s.failures}）</title></rect>`
  }).join('')

  // Y 轴 3 条参考线
  const grid = [0, 0.5, 1].map((r) => {
    const y = H - padB - r * (H - padT - padB)
    return `<line class="grid-line" x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}"/>`
      + `<text class="axis-text" x="${padL - 6}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${Math.round(r * max)}</text>`
  }).join('')

  // X 轴：只标首/中/尾，避免挤成一团
  const labelIdx = [0, Math.floor(series.length / 2), series.length - 1]
  const xlabels = labelIdx.map((i) => {
    const s = series[i]
    if (s === undefined) return ''
    const x = padL + i * ((W - padL - padR) / series.length) + bw / 2
    return `<text class="axis-text" x="${x.toFixed(1)}" y="${H - 6}" text-anchor="middle">${s.key.slice(5)}</text>`
  }).join('')

  const total = series.reduce((s, x) => s + x.calls, 0)
  if (note) note.textContent = `共 ${total.toLocaleString('zh-CN')} 次 · 峰值 ${max} 次/天`

  box.innerHTML = `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="每日调用量柱状图">
    <defs><linearGradient id="barGrad" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0%" stop-color="#4569c4"/><stop offset="100%" stop-color="#8fa6ff"/>
    </linearGradient></defs>
    ${grid}${bars}${xlabels}
  </svg>`
}

/**
 * 折线图（平均耗时趋势）。手绘 SVG。
 */
function renderLineChart(buckets, days) {
  const box = $('#chart-line')
  const note = $('#line-note')
  if (box === null) return
  if (buckets.length === 0) { box.innerHTML = '<div class="empty">暂无数据</div>'; if (note) note.textContent = ''; return }

  const day = 86400000
  const now = Date.now()
  const todayStart = Math.floor((now + 8 * 3600000) / day) * day - 8 * 3600000
  const span = days > 0 ? days : Math.max(7, Math.ceil((now - Date.parse(buckets[0].key)) / day) + 1)
  const byDay = new Map(buckets.map(b => [b.key, b]))
  const series = []
  for (let i = span - 1; i >= 0; i--) {
    const key = dayKeyOf(todayStart - i * day)
    const b = byDay.get(key)
    // ⚠️ 没调用的日子**不连线**（用 null 断开），否则会把"断档"画成一条
    //    虚假的平滑下滑，读图的人会以为耗时真的在下降。
    //    注意：`avgMs` 为 0 的合法值也要显示（极快的本地响应），
    //    故判据用 `calls > 0` 而不是 `avgMs > 0`。
    series.push({ key, avgMs: b !== undefined && b.calls > 0 ? b.avgMs : null })
  }

  const W = 760, H = 190, padL = 44, padB = 22, padT = 10, padR = 8
  const vals = series.map(s => s.avgMs).filter(v => v !== null)
  const max = Math.max(1000, ...vals)
  const stepX = (W - padL - padR) / Math.max(1, series.length - 1)
  const yOf = (v) => H - padB - (v / max) * (H - padT - padB)
  const xOf = (i) => padL + i * stepX

  // 分段（null 处断开）
  const segs = []
  let cur = []
  series.forEach((s, i) => {
    if (s.avgMs === null) { if (cur.length > 0) segs.push(cur); cur = [] }
    else cur.push({ i, v: s.avgMs })
  })
  if (cur.length > 0) segs.push(cur)

  const paths = segs.map((seg) => {
    const d = seg.map((p, k) => `${k === 0 ? 'M' : 'L'}${xOf(p.i).toFixed(1)},${yOf(p.v).toFixed(1)}`).join(' ')
    // 面积只在连续段 ≥2 点时画（单点没有面积语义）
    const area = seg.length >= 2
      ? `<path class="area-path" d="${d} L${xOf(seg[seg.length - 1].i).toFixed(1)},${H - padB} L${xOf(seg[0].i).toFixed(1)},${H - padB} Z"/>`
      : ''
    return area + `<path class="line-path" d="${d}"/>`
  }).join('')

  const dots = segs.flatMap(seg => seg.map(p =>
    `<circle class="dot" cx="${xOf(p.i).toFixed(1)}" cy="${yOf(p.v).toFixed(1)}" r="3.2"><title>${series[p.i].key}：平均 ${(p.v / 1000).toFixed(2)}s</title></circle>`
  )).join('')

  const grid = [0, 0.5, 1].map((r) => {
    const y = H - padB - r * (H - padT - padB)
    return `<line class="grid-line" x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}"/>`
      + `<text class="axis-text" x="${padL - 6}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${(r * max / 1000).toFixed(1)}s</text>`
  }).join('')

  const labelIdx = [0, Math.floor(series.length / 2), series.length - 1]
  const xlabels = labelIdx.map((i) => {
    const s = series[i]
    if (s === undefined) return ''
    return `<text class="axis-text" x="${xOf(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">${s.key.slice(5)}</text>`
  }).join('')

  if (vals.length === 0) {
    box.innerHTML = '<div class="empty">该范围内没有成功调用的耗时数据</div>'
    if (note) note.textContent = ''
    return
  }
  const avg = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)
  if (note) note.textContent = `有数据 ${vals.length} 天 · 平均 ${(avg / 1000).toFixed(2)}s`

  box.innerHTML = `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="平均耗时折线图">
    <defs>
      <linearGradient id="lineGrad" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#6b8afd"/><stop offset="100%" stop-color="#a06bfd"/>
      </linearGradient>
      <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#6b8afd33"/><stop offset="100%" stop-color="#6b8afd00"/>
      </linearGradient>
    </defs>
    ${grid}${paths}${dots}${xlabels}
  </svg>`
}

/** 把概览卡片 + 三张图表 + 三张表整体渲染出来。 */
function renderUsage(data) {
  const box = $('#usage-summary')
  const tables = $('#usage-tables')
  if (box === null || tables === null) return

  const all = data.byDay ?? []
  const days = usageRangeDays
  // 范围过滤在**客户端**做：后端一次给全量（最多 5000 条内存索引），
  // 切「今日/7 天/30 天/全部」无需重新请求，切换无延迟。
  const inRange = all.filter((b) => withinRange(Date.parse(b.key) + 12 * 3600000, days))

  const calls = inRange.reduce((s, b) => s + b.calls, 0)
  const okCalls = inRange.reduce((s, b) => s + (b.okCalls ?? 0), 0)
  const failures = inRange.reduce((s, b) => s + (b.failures ?? 0), 0)
  const inputTokens = inRange.reduce((s, b) => s + (b.inputTokens ?? 0), 0)
  const outputTokens = inRange.reduce((s, b) => s + (b.outputTokens ?? 0), 0)
  // 均耗时按**调用数加权**（不能对日均值再取平均 —— 那会让低流量日的均值权重过大）。
  const totalMs = inRange.reduce((s, b) => s + (b.avgMs ?? 0) * b.calls, 0)
  const avgMs = calls > 0 ? Math.round(totalMs / calls) : 0

  const fmtNum = (n) => (n ?? 0).toLocaleString('zh-CN')
  /** 紧凑数字（圆环中心用）：72,522,728 → 72.5M。 */
  const fmtShort = (n) => {
    const v = n ?? 0
    if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`
    if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`
    return String(v)
  }
  const fmtDur = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms ?? 0}ms`)
  const failRate = calls > 0 ? ((failures / calls) * 100).toFixed(1) : '0.0'
  const scope = days <= 0 ? '全部时间' : days === 1 ? '今日' : `近 ${days} 天`

  /**
   * **token 圆盘图**（2026-11-12 用户要求「数据里面目前只有调用次数统计，
   * 看是否可以加 token 统计，使用圆盘图」）。
   *
   * 用**内联 SVG 手绘**（本项目零外部依赖，见 style.css 文件头「双击即用」约束）：
   * 两个同心环 —— 内环 = 输入 token 占比，外环 = 输出 token 占比（各自占自己的
   * 100%？不：那样看不出量级差）。改为**同一把尺子**：两段弧长按「输入 : 输出」
   * 的真实比例分配，中心显示总量。
   *
   * ⚠️ 弧长用 `stroke-dasharray` + `stroke-dashoffset` 实现，不用 path 算角度
   *    （避免三角函数和浮点误差，也让 hover 动画只需改 CSS 变量）。
   */
  const tokenTotal = inputTokens + outputTokens
  const inputPct = tokenTotal > 0 ? (inputTokens / tokenTotal) * 100 : 0
  const outputPct = tokenTotal > 0 ? (outputTokens / tokenTotal) * 100 : 0
  /** 圆环周长（r=42）：2πr ≈ 263.9。两段圆弧共用一条描边，靠 dashoffset 错开。 */
  const RING_C = 2 * Math.PI * 42

  box.innerHTML = `
    <div class="usage-card">
      <div class="usage-num">${fmtNum(calls)}</div>
      <div class="usage-label">${scope}调用次数</div>
    </div>
    <div class="usage-card usage-card-token">
      <div class="token-ring-wrap">
        <svg class="token-ring" viewBox="0 0 110 110" role="img"
             aria-label="token 构成：输入 ${fmtNum(inputTokens)}，输出 ${fmtNum(outputTokens)}">
          <!-- 底环 -->
          <circle cx="55" cy="55" r="42" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="9"/>
          ${tokenTotal > 0 ? `
          <!-- 输入（占起始段） -->
          <circle cx="55" cy="55" r="42" fill="none" stroke="url(#gradTokenIn)" stroke-width="9"
                  stroke-linecap="butt"
                  stroke-dasharray="${(RING_C * inputPct / 100).toFixed(2)} ${RING_C.toFixed(2)}"
                  stroke-dashoffset="0"
                  transform="rotate(-90 55 55)"/>
          <!-- 输出（接在输入之后） -->
          <circle cx="55" cy="55" r="42" fill="none" stroke="url(#gradTokenOut)" stroke-width="9"
                  stroke-linecap="butt"
                  stroke-dasharray="${(RING_C * outputPct / 100).toFixed(2)} ${RING_C.toFixed(2)}"
                  stroke-dashoffset="${(-RING_C * inputPct / 100).toFixed(2)}"
                  transform="rotate(-90 55 55)"/>
          ` : ''}
          <defs>
            <linearGradient id="gradTokenIn" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#6b8afd"/>
              <stop offset="100%" stop-color="#8fa8ff"/>
            </linearGradient>
            <linearGradient id="gradTokenOut" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#a06bfd"/>
              <stop offset="100%" stop-color="#e07bb0"/>
            </linearGradient>
          </defs>
          <text x="55" y="52" text-anchor="middle" class="token-ring-num">${tokenTotal > 0 ? fmtShort(tokenTotal) : '0'}</text>
          <text x="55" y="67" text-anchor="middle" class="token-ring-unit">token</text>
        </svg>
      </div>
      <div class="token-legend">
        <span class="token-key token-key-in">
          <i></i>输入 ${fmtNum(inputTokens)}<em>${inputPct.toFixed(1)}%</em>
        </span>
        <span class="token-key token-key-out">
          <i></i>输出 ${fmtNum(outputTokens)}<em>${outputPct.toFixed(1)}%</em>
        </span>
      </div>
    </div>
    <div class="usage-card">
      <div class="usage-num">${fmtDur(avgMs)}</div>
      <div class="usage-label">平均耗时（按调用数加权）</div>
    </div>
    <div class="usage-card${failures > 0 ? ' usage-card-warn' : ''}">
      <div class="usage-num">${fmtNum(failures)} <span class="usage-sub">(${failRate}%)</span></div>
      <div class="usage-label">失败次数（成功 ${fmtNum(okCalls)}）</div>
    </div>
    <div class="usage-card">
      <div class="usage-num">${fmtNum(data.size ?? 0)}</div>
      <div class="usage-label">累计记录（本次统计 ${fmtNum(data.sampled ?? 0)} 条）</div>
    </div>`

  renderHeatmap(inRange, days)
  renderBarChart(inRange, days)
  renderLineChart(inRange, days)

  // 表格：供应商 / 模型（按范围重算，与卡片同口径）
  //
  // ⚠️ 后端的 byProvider/byModel 是**全量**口径（无时间维度），范围过滤只覆盖
  //    byDay。故这里在范围内时用 `recent` 记录重算，保证与卡片一致；全量范围
  //    则直接用后端的聚合结果（更准，`recent` 只有最近 50 条）。
  const rowsSource = days <= 0
    ? {
        byProvider: data.byProvider ?? [],
        byModel: data.byModel ?? [],
      }
    : (() => {
        const recent = (data.recent ?? []).filter((r) => withinRange(r.at, days))
        const agg = (keyOf) => {
          const m = new Map()
          for (const r of recent) {
            const k = keyOf(r)
            const cur = m.get(k) ?? { key: k, calls: 0, okCalls: 0, failures: 0, inputTokens: 0, outputTokens: 0, _ms: 0 }
            cur.calls++
            if (r.ok) cur.okCalls++; else cur.failures++
            cur.inputTokens += r.inputTokens ?? 0
            cur.outputTokens += r.outputTokens ?? 0
            cur._ms += r.ms ?? 0
            m.set(k, cur)
          }
          return [...m.values()].map((v) => ({ ...v, avgMs: v.calls > 0 ? Math.round(v._ms / v.calls) : 0 }))
            .sort((a, b) => b.calls - a.calls)
        }
        return {
          byProvider: agg((r) => r.provider),
          byModel: agg((r) => `${r.provider}/${r.model}`),
        }
      })()

  const table = (title, rows, keyLabel) => {
    if (rows.length === 0) return `<div class="usage-block"><h4>${title}</h4><div class="empty">暂无数据</div></div>`
    const body = rows.slice(0, 15).map((r) => `
        <tr>
          <td class="usage-key">${escapeHtml(r.key)}</td>
          <td>${(r.calls ?? 0).toLocaleString('zh-CN')}</td>
          <td>${((r.inputTokens ?? 0) + (r.outputTokens ?? 0)).toLocaleString('zh-CN')}</td>
          <td>${r.avgMs >= 1000 ? (r.avgMs / 1000).toFixed(1) + 's' : r.avgMs + 'ms'}</td>
          <td class="${r.failures > 0 ? 'usage-fail' : ''}">${r.failures ?? 0}</td>
        </tr>`).join('')
    return `
      <div class="usage-block">
        <h4>${title}</h4>
        <table class="usage-table">
          <thead><tr><th>${keyLabel}</th><th>次数</th><th>token</th><th>均耗时</th><th>失败</th></tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>`
  }

  tables.innerHTML =
    table('按供应商', rowsSource.byProvider, '供应商') +
    table('按模型', rowsSource.byModel, '模型')

  const stamp = $('#usage-updated')
  if (stamp) stamp.textContent = `更新于 ${new Date().toLocaleTimeString()}`
}

async function loadUsage() {
  const box = $('#usage-summary')
  const tables = $('#usage-tables')
  if (box === null || tables === null) return
  try {
    // `recent=200`：范围过滤时要用它重算供应商/模型维度（后端聚合无时间维度）。
    const data = await api('/api/usage?recent=200')
    if (data.enabled === false) {
      box.innerHTML = '<div class="empty">用量统计未启用</div>'
      tables.innerHTML = ''
      return
    }
    usageData = data
    renderUsage(data)
  } catch {
    box.innerHTML = '<div class="empty">读取用量失败</div>'
  }
}

// 时间范围按钮
for (const btn of document.querySelectorAll('.range')) {
  btn.addEventListener('click', () => {
    usageRangeDays = Number(btn.dataset.range) || 0
    for (const other of document.querySelectorAll('.range')) {
      other.classList.toggle('is-active', other === btn)
    }
    if (usageData !== null) renderUsage(usageData)
    else void loadUsage()
  })
}

$('#usage-refresh')?.addEventListener('click', () => { void loadUsage() })
$('#usage-clear')?.addEventListener('click', async () => {
  if (!confirm('清空用量统计？\n\n原文件会被重命名备份（usage.jsonl.bak-<时间戳>），不会直接删除。')) return
  try {
    const r = await api('/api/usage/clear', { method: 'POST', body: '{}' })
    toast(`已清空 ${r.removed ?? 0} 条统计${r.backup ? '（已备份）' : ''}`, 'ok')
    await loadUsage()
  } catch (error) {
    toast(String(error.message || error), 'err')
  }
})

// ── 渠道原生搜索开关 ──
//
// 开启后：客户端声明的 web_search 工具由**渠道自带后端**真实执行
// （buddy/workbuddy → 腾讯、qoder → Qoder），结果注入上下文给模型。
async function loadNativeSearch() {
  const toggle = $('#native-search-toggle')
  const note = $('#native-search-note')
  const detail = $('#native-search-detail')
  if (toggle === null) return
  try {
    const r = await api('/api/native-search')
    toggle.checked = r.enabled === true
    if (note !== null) note.textContent = r.enabled === true ? '已开启' : '已关闭'
    if (detail !== null) detail.textContent = `支持 ${r.providers?.length ?? 0} 家：${(r.providers ?? []).join(' / ')}`
  } catch (error) {
    if (detail !== null) detail.textContent = `读取失败：${error.message || error}`
  }
}

$('#native-search-toggle')?.addEventListener('change', async (event) => {
  const enabled = event.target.checked === true
  try {
    const r = await api('/api/native-search', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    })
    toast(r.enabled === true ? '渠道原生搜索已开启' : '渠道原生搜索已关闭', 'ok')
    await loadNativeSearch()
  } catch (error) {
    event.target.checked = !enabled
    toast(String(error.message || error), 'err')
  }
})

// ── Build 渠道页 ──
//
// 这个渠道与其它 17 家的形态不同：上游是跑在 Google Cloud Run 上的 AI Studio App，
// 由**用户浏览器里的页面**主动连回本网关。故本页是「连接控制台」而非配置表单。
async function loadBuild() {
  const box = $('#build-status')
  if (box === null) return
  try {
    const [status, modelsResp] = await Promise.all([
      api('/api/build/status'),
      api('/api/p/build/models').catch(() => ({ models: [] })),
    ])
    const enabled = status.enabled !== false
    const accepting = status.accepting === true
    const connected = status.connected === true
    const dot = connected ? '🟢' : accepting ? '🟡' : '⚫'
    const label = connected ? '已连接' : accepting ? '等待 App 连接' : '已断开'
    const lastPing = status.lastPingAt
      ? new Date(status.lastPingAt).toLocaleTimeString('zh-CN')
      : '—'

    // 用户激活状态（本渠道最易误判的失败前提）。
    // ⚠️ App 未上报时显示"未上报"，**不假装 false** —— 那会误导用户去乱动鼠标。
    const act = status.activation
    const actText = act === undefined
      ? { dot: '⚪', text: '未上报', cls: '' }
      : act.active
        ? { dot: '🟢', text: `已激活 (${act.moves} 移动 / ${act.keys} 按键)`, cls: '' }
        : { dot: '🔴', text: `未激活 (${act.moves}/30 移动 · ${act.keys}/5 按键)`, cls: ' usage-card-warn' }

    box.innerHTML = `
      <div class="usage-summary" style="margin-bottom:0">
        <div class="usage-card">
          <div class="usage-num">${dot} ${label}</div>
          <div class="usage-label">连接状态</div>
        </div>
        <div class="usage-card${actText.cls}">
          <div class="usage-num" style="font-size:15px">${actText.dot} ${escapeHtml(actText.text)}</div>
          <div class="usage-label">用户激活（转发前提）</div>
        </div>
        <div class="usage-card">
          <div class="usage-num">${status.relays ?? 0}</div>
          <div class="usage-label">成功转发</div>
        </div>
        <div class="usage-card${(status.failures ?? 0) > 0 ? ' usage-card-warn' : ''}">
          <div class="usage-num">${status.failures ?? 0}</div>
          <div class="usage-label">失败次数</div>
        </div>
        <div class="usage-card">
          <div class="usage-num" style="font-size:15px">${lastPing}</div>
          <div class="usage-label">最后心跳</div>
        </div>
      </div>
      ${status.hungRequest ? `
        <p class="build-alert">
          ⏳ 有请求已等待 ${Math.round((status.hungRequest.waitedMs || 0) / 1000)} 秒未回应，
          疑似被宿主页挂起。<b>请到 App 页面移动鼠标 / 按几下键</b>（宿主页只在用户激活后
          才转发浏览器端 fetch；未满足时 fetch 会一直挂起，表现为超时而非报错）。
        </p>` : ''}
      ${act !== undefined && act.active === false && !status.hungRequest ? `
        <p class="build-alert">
          ⚠️ 用户激活**尚未满足** —— 转发会被挂起。请到 App 页面移动鼠标（约 30 次）
          并按几下键（约 5 次），或改用手机/触屏设备。
        </p>` : ''}
      ${status.lastError ? `<p class="hint" style="margin:10px 0 0">最近错误：${escapeHtml(status.lastError)}</p>` : ''}
      ${!enabled ? '<p class="hint" style="margin:10px 0 0">⚠️ 该供应商未启用，请到「供应商」页启用它。</p>' : ''}`

    // App 链接输入框（只填一次，之后自动跳转）。
    const appInput = $('#build-app-url')
    if (appInput !== null && appInput.value !== (status.appUrl ?? '') && document.activeElement !== appInput) {
      appInput.value = status.appUrl ?? ''
    }

    // WebSocket 地址：用当前页面 host + 令牌（令牌从我们自己的 token 逻辑取）。
    // 令牌来源：优先前端 accessToken（用户手动设过）；本机访问时它是空的
    // （回环豁免，前端从不设置），故回落到后端返回的 `lan.accessToken`。
    // ⚠️ App 是**外部客户端**，不受回环豁免 —— 必须带真令牌，否则握手 401。
    const token = accessToken.length > 0 ? accessToken : (lanTokenCache ?? '')
    const wsUrl = token.length > 0
      ? `ws://${location.hostname}:${location.port}/v1/ws?auth_token=${token}`
      : `ws://${location.hostname}:${location.port}/v1/ws?auth_token=<访问令牌>`
    const code = $('#build-ws-url')
    if (code !== null) {
      code.textContent = wsUrl
      code.onclick = () => { void navigator.clipboard.writeText(wsUrl).then(() => toast('已复制 WebSocket 地址', 'ok')) }
    }

    // **当日用量**（本地记账；上游查不到 Build 的额度 —— 见 build-relay.ts 注释）
    const usageArr = Array.isArray(status.usage) ? status.usage : []
    const usageBox = $('#build-usage')
    if (usageBox !== null) {
      usageBox.innerHTML = usageArr.length === 0
        ? '<div class="empty">今日尚无调用记录</div>'
        : usageArr.map((u) => `
            <div class="build-usage-row">
              <span class="model-id">${escapeHtml(u.model)}</span>
              <span class="tag">今日 ${u.count} 次</span>
            </div>`).join('')
    }

    // 模型清单
    const models = modelsResp.models ?? []
    const list = $('#build-models')
    const note = $('#build-models-note')
    if (note !== null) note.textContent = `${models.filter((m) => m.enabled).length} / ${models.length} 已启用`
    if (list !== null) {
      list.innerHTML = models.length === 0
        ? '<div class="empty">没有模型（供应商可能未启用）</div>'
        : models.map((m) => `
            <label class="model-row ${m.enabled ? '' : 'is-off'}">
              <span class="model-main">
                <span class="model-name">${escapeHtml(m.name || m.id)}</span>
                <span class="model-id">${escapeHtml(m.id)}</span>
              </span>
              <span class="tag ${m.enabled ? 'tag-ok' : ''}">${m.enabled ? '可用' : '停用'}</span>
            </label>`).join('')
    }

    const stamp = $('#build-updated')
    if (stamp !== null) stamp.textContent = `更新于 ${new Date().toLocaleTimeString()}`
  } catch (error) {
    box.innerHTML = `<div class="empty log-error">${escapeHtml(String(error.message || error))}</div>`
  }
}

$('#build-connect')?.addEventListener('click', async () => {
  try {
    const status = await api('/api/build/status').catch(() => ({}))
    const appUrl = (status.appUrl ?? '').trim()
    await api('/api/build/connect', { method: 'POST', body: JSON.stringify({ connected: true }) })
    if (appUrl.length === 0) {
      // 没配链接：明确告诉用户去填，而不是静默什么也没发生。
      toast('已开启服务端。请先在上面填入你的 App 链接，之后点这里会自动打开它。', 'err')
      $('#build-app-url')?.focus()
      await loadBuild()
      return
    }
    // ⚠️ 必须在**点击的同步上下文**里调用 window.open，否则浏览器按
    //    "非用户手势"拦截弹窗。上面的 await 之后仍算用户手势（Chrome 容忍
    //    短异步），但为稳妥起见先开窗口再导航。
    const opened = window.open(appUrl, '_blank', 'noopener')
    if (opened === null) {
      toast('弹窗被浏览器拦截了。请允许本站弹窗，或手动打开你的 App 链接。', 'err')
    } else {
      toast('已打开 App 页面 —— 请在那边点 Connect 完成握手', 'ok')
    }
    await loadBuild()
  } catch (error) { toast(String(error.message || error), 'err') }
})

// 保存 App 链接
$('#build-save-url')?.addEventListener('click', async () => {
  const input = $('#build-app-url')
  const hint = $('#build-appurl-hint')
  if (input === null) return
  try {
    await api('/api/build/app-url', {
      method: 'POST',
      body: JSON.stringify({ url: input.value }),
    })
    if (hint !== null) hint.textContent = input.value.trim().length > 0 ? '✓ 已保存（点「连接并打开 App」即自动跳转）' : '已清空'
    toast('App 链接已保存', 'ok')
    await loadBuild()
  } catch (error) {
    // ⚠️ `api()` 对非 2xx **抛错**，所以校验失败走这里（而不是判返回值）——
    //    最初写成判 `r.ok === false`，那条分支永远不会命中（实测：后端返回
    //    400 + reason，但前端 hint 一直是空的）。
    //
    // ⚠️ 且**不调 loadBuild()**：那会用服务端的旧值覆盖用户刚输入的非法值，
    //    用户就看不到自己填了什么、也不知道错在哪。
    const reason = String(error.message || error)
    if (hint !== null) hint.innerHTML = `<span class="log-error">✗ ${escapeHtml(reason)}</span>`
    toast(reason, 'err')
  }
})
$('#build-disconnect')?.addEventListener('click', async () => {
  try {
    await api('/api/build/connect', { method: 'POST', body: JSON.stringify({ connected: false }) })
    toast('已断开：App 现在连不上（再点「连接」即可恢复）', 'ok')
    await loadBuild()
  } catch (error) { toast(String(error.message || error), 'err') }
})
$('#build-refresh')?.addEventListener('click', () => { void loadBuild() })

// ── 分页切换 ──
//
// 三页：供应商 / 网关 / 数据。用 `hidden` 属性切换（CSS 里已确保 [hidden] 生效）。
// 选择记在 localStorage，刷新后停在原页；URL hash 也同步，便于分享直链。
function showPage(name) {
  const target = ['providers', 'gateway', 'data', 'build'].includes(name) ? name : 'providers'
  for (const section of document.querySelectorAll('.page')) {
    section.hidden = section.dataset.page !== target
  }
  for (const tab of document.querySelectorAll('.tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.page === target))
  }
  try { localStorage.setItem('dsh-gateway-page', target) } catch { /* 隐私模式忽略 */ }
  if (location.hash.slice(1) !== target) location.hash = target
  // 切到数据页时刷新一次（否则可能显示的是很久前的数据）。
  if (target === 'data') void loadUsage()
  // 切到 Build 页同理：连接状态变化很快，进来就该拉最新的。
  if (target === 'build') void loadBuild()
  // 网关页的「原生搜索」开关状态（可能被别处改动，进来就重读一次）。
  if (target === 'gateway') void loadNativeSearch()
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => showPage(tab.dataset.page))
}
window.addEventListener('hashchange', () => {
  const want = location.hash.slice(1)
  if (want.length > 0) showPage(want)
})

let initialPage = 'providers'
try { initialPage = location.hash.slice(1) || localStorage.getItem('dsh-gateway-page') || 'providers' } catch { /* 忽略 */ }
showPage(initialPage)

load()
loadLogs()
loadUsage()
setInterval(loadLogs, 4000)
setInterval(load, 20000)
setInterval(() => {
  // 只在数据页可见时轮询，避免后台页白刷（也省 CPU）。
  const dataPage = document.querySelector('.page[data-page="data"]')
  if (dataPage !== null && dataPage.hidden === false) void loadUsage()
  // Build 页：连接状态变化快，5 秒一次（同样只在可见时）。
  const buildPage = document.querySelector('.page[data-page="build"]')
  if (buildPage !== null && buildPage.hidden === false) void loadBuild()
}, 30000)

// Build 页专用快轮询（30 秒太慢，连接状态需要更实时）
setInterval(() => {
  const buildPage = document.querySelector('.page[data-page="build"]')
  if (buildPage !== null && buildPage.hidden === false) void loadBuild()
}, 5000)
