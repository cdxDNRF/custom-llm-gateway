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

  card.innerHTML = `
    <div class="card-head">
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
        <button class="btn btn-sm btn-danger-ghost" data-act="disableProvider"
                title="停用后立即释放端口。已登录的账号仍保存在本地，随时可再启用。">停用</button>
      </div>
    </div>
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

/** 渲染展开区（积分 / 模型管理）。 */
async function renderExtra(provider, box, kind) {
  box.innerHTML = '<div class="empty">加载中…</div>'
  try {
    if (kind === 'balance') {
      const { balance } = await api(`/api/p/${provider.id}/balance`)
      box.innerHTML = renderBalance(balance)
      return
    }
    const { models } = await api(`/api/p/${provider.id}/models`)
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
    const box = $('#providers')
    box.innerHTML = ''
    for (const provider of providers) box.appendChild(renderProvider(provider))

    renderEndpoints(providers, lan)

    $('#conn').className = 'pill pill-ok'
    $('#conn').textContent = `正常 · ${providers.length} 个供应商`
  } catch {
    $('#conn').className = 'pill pill-err'
    $('#conn').textContent = '网关无响应'
  }
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

  // ── 供应商独立端点（OpenAI 与 Anthropic 同端口、不同路径）──
  html += providers.map((p) => {
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
  const fmtDur = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms ?? 0}ms`)
  const failRate = calls > 0 ? ((failures / calls) * 100).toFixed(1) : '0.0'
  const scope = days <= 0 ? '全部时间' : days === 1 ? '今日' : `近 ${days} 天`

  box.innerHTML = `
    <div class="usage-card">
      <div class="usage-num">${fmtNum(calls)}</div>
      <div class="usage-label">${scope}调用次数</div>
    </div>
    <div class="usage-card">
      <div class="usage-num">${fmtNum(inputTokens + outputTokens)}</div>
      <div class="usage-label">总 token（入 ${fmtNum(inputTokens)} / 出 ${fmtNum(outputTokens)}）</div>
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

    box.innerHTML = `
      <div class="usage-summary" style="margin-bottom:0">
        <div class="usage-card">
          <div class="usage-num">${dot} ${label}</div>
          <div class="usage-label">连接状态</div>
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
