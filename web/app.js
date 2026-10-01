/* dsh-llm-gateway 控制台前端（原生 JS，无构建步骤、无外部依赖） */
'use strict'

const $ = (sel) => document.querySelector(sel)

function toast(message, kind = '') {
  const el = $('#toast')
  el.textContent = message
  el.className = `toast ${kind}`
  el.hidden = false
  clearTimeout(toast._timer)
  toast._timer = setTimeout(() => { el.hidden = true }, 4200)
}

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options })
  const text = await response.text()
  let body
  try { body = text ? JSON.parse(text) : {} } catch { body = { raw: text } }
  if (!response.ok) throw new Error(body.error || body.message || `HTTP ${response.status}`)
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
        <button class="btn btn-sm btn-primary" data-act="enableProvider">启用（写配置）</button>
      </div>
      <div class="empty">启用后需重启网关生效；随后在此登录账号。</div>
    `
    card.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-act="enableProvider"]')
      if (!button) return
      button.disabled = true
      try {
        await api('/api/config/enable', {
          method: 'POST',
          body: JSON.stringify({ id: provider.id, enabled: true }),
        })
        toast(`${provider.displayName} 已写入配置。请重启网关（Win 端：停止(Win) 后再点 (Win)；WSL 端：stop.sh 后 start.sh）`, 'ok')
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
      ${caps.permanentLock ? `
        <label class="switch" title="锁定永久积分：只使用不会过期的积分，避免浪费即将作废的额度">
          <input type="checkbox" data-act="lock" ${provider.permanentLocked ? 'checked' : ''}>
          <span>锁定永久积分</span>
        </label>` : ''}
    </div>
    <div class="tags">${tags}</div>
    <div class="card-actions">
      <button class="btn btn-sm btn-primary" data-act="login">＋ 新建账号</button>
      ${caps.balance ? '<button class="btn btn-sm" data-act="balance">查积分</button>' : ''}
      ${caps.dailyCheckin ? '<button class="btn btn-sm" data-act="checkin">一键签到</button>' : ''}
      <button class="btn btn-sm" data-act="models">模型管理</button>
      <button class="btn btn-sm" data-act="refresh">续期</button>
      <button class="btn btn-sm" data-act="more">更多 ▾</button>
    </div>
    <div class="more" data-role="more" hidden>
      <button class="btn btn-sm" data-act="refreshModels">重拉模型目录</button>
      <button class="btn btn-sm" data-act="retest">重测账号</button>
      <button class="btn btn-sm" data-act="reset">重置限流标记</button>
      <button class="btn btn-sm" data-act="enableAllModels">全部模型启用</button>
      <button class="btn btn-sm" data-act="disableAllModels">全部模型停用</button>
    </div>
    <div class="accounts" data-role="accounts"></div>
    <div data-role="extra" class="${view ? 'extra-open' : ''}"></div>
  `

  const accountsBox = card.querySelector('[data-role="accounts"]')
  const extraBox = card.querySelector('[data-role="extra"]')
  const moreBox = card.querySelector('[data-role="more"]')

  if (!provider.accounts || provider.accounts.length === 0) {
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
        case 'reset': {
          const { result } = await api(`/api/p/${provider.id}/accounts/reset`, { method: 'POST', body: '{}' })
          toast(`已重置 ${result.clearedCount} 条限流标记`, 'ok')
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
    box.innerHTML = `
      <div class="extra-head">
        <span>模型管理</span>
        <span class="endpoint-note">
          启用 ${enabledCount} / 共 ${models.length}
          <button class="btn btn-sm" data-act="refreshModels" style="margin-left:8px">↻ 重拉</button>
        </span>
      </div>
      <div class="model-list">
        ${models.map((m) => `
          <label class="model-row ${m.enabled ? '' : 'model-off'}">
            <input type="checkbox" ${m.enabled ? 'checked' : ''}
                   data-act="modelToggle" data-model="${escapeHtml(m.id)}" data-enabled="${m.enabled}">
            <span class="model-name">${escapeHtml(m.name || m.id)}</span>
            <span class="model-id">${escapeHtml(m.id)}</span>
            ${m.credits ? `<span class="tag">${escapeHtml(m.credits)}</span>` : ''}
          </label>
        `).join('')}
      </div>
    `
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
  const unit = balance.unit === 'tokens' ? 'tokens' : '积分'
  const items = (balance.items || []).map((item) => `
    <div class="endpoint">
      <span class="endpoint-label">${escapeHtml(item.name)}</span>
      <code>${item.remain} ${unit}</code>
    </div>
  `).join('')
  return `
    <div class="endpoint" style="margin-bottom:6px">
      <span class="endpoint-label"><b>合计</b></span>
      <code>${balance.total} ${unit}</code>
    </div>
    ${items}
  `
}

async function startLogin(provider) {
  const popup = window.open('', '_blank')
  try {
    const { loginUrl, accountId } = await api(`/api/p/${provider.id}/login`, {
      method: 'POST',
      body: JSON.stringify({}),
    })
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
    const { providers } = await api('/api/overview')
    const box = $('#providers')
    box.innerHTML = ''
    for (const provider of providers) box.appendChild(renderProvider(provider))

    const endpoints = $('#endpoints')
    endpoints.innerHTML = providers.map((p) => `
      <div class="endpoint">
        <div>
          <div class="endpoint-label">${escapeHtml(p.displayName)} <span class="endpoint-note">（独立端点）</span></div>
          <div class="endpoint-note">模型 id 用裸名，例如 <code style="font-size:11px">glm-5.3</code></div>
        </div>
        <code>${escapeHtml(p.baseUrl || '未启动')}</code>
      </div>
    `).join('') + `
      <div class="endpoint">
        <div>
          <div class="endpoint-label">聚合端点 <span class="endpoint-note">（一次接入全部）</span></div>
          <div class="endpoint-note">模型 id 写成 <code style="font-size:11px">供应商/模型</code>，例如 buddy/glm-5.3</div>
        </div>
        <code>http://127.0.0.1:${location.port || 8790}/v1</code>
      </div>
    `

    $('#conn').className = 'pill pill-ok'
    $('#conn').textContent = `正常 · ${providers.length} 个供应商`
  } catch {
    $('#conn').className = 'pill pill-err'
    $('#conn').textContent = '网关无响应'
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

load()
loadLogs()
setInterval(loadLogs, 4000)
setInterval(load, 20000)
