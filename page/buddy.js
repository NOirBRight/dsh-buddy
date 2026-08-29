// Theater layout: whale centered, sessions as a ticker. Tap a chip or a
// pending confirmation slides the whale left and opens a speech bubble.
// Debug: ?mock=1 injects fake sessions; ?open=<id> pre-opens a bubble.
(() => {
  const MOOD_LABEL = {
    'needs-you': '等你点一下',
    error: '出错了',
    working: '干活中',
    'done-unseen': '搞定啦',
    idle: '闲着',
  }
  const REASON = {
    approval: '等待审批',
    'plan-review': '计划待审',
    question: '等待回答',
  }
  const STATUS_LABEL = { attention: '等你', error: '出错', running: '干活', done: '完成', idle: '空闲' }
  const MOOD_ROW = { idle: 0, working: 1, 'needs-you': 2, 'done-unseen': 3, error: 4, pet: 5 }
  const FRAMES = 8
  const SHEET_COLS = 8
  const SHEET_ROWS = 6

  const params = new URLSearchParams(location.search)
  const MOCK = params.get('mock') === '1'

  const state = {
    snapshot: { mood: 'idle', counts: { attention: 0, error: 0, running: 0, done: 0, idle: 0 }, sessions: [], revision: 0 },
    pending: new Map(),
    titles: new Map(),
    petUntil: 0,
    frame: 0,
    buddyLive: false,
    selected: new Set(),
    openId: params.get('open') || null,
  }

  if (MOCK) {
    const now = Date.now()
    state.snapshot = {
      mood: 'needs-you',
      counts: { attention: 1, error: 1, running: 2, done: 1, idle: 1 },
      revision: 1,
      sessions: [
        { id: 'mock-1', title: '重构支付回调的重试逻辑', status: 'attention', reason: '等待回答', pendingKind: 'question', updatedAt: now },
        { id: 'mock-2', title: '给 dsh-buddy 写单元测试', status: 'running', reason: '正在跑 vitest', updatedAt: now - 60_000 },
        { id: 'mock-3', title: '爬取季报并生成摘要', status: 'error', reason: 'fetch 超时 3 次', updatedAt: now - 120_000 },
        { id: 'mock-4', title: '整理 obsidian 周记', status: 'running', reason: '工具调用中', updatedAt: now - 30_000 },
        { id: 'mock-5', title: '用 Grok 生成清晨窗台静物图', status: 'done', reason: '完成，未查看', updatedAt: now - 300_000 },
        { id: 'mock-6', title: '600519贵州茅台投资分析', status: 'idle', reason: '空闲', updatedAt: now - 900_000 },
      ],
    }
    state.pending.set('q:mock', {
      kind: 'question',
      rpcId: 'mock',
      sessionId: 'mock-1',
      questions: [{
        id: 'q1',
        header: '部署确认',
        question: '构建通过了，把这次改动发到哪个环境？',
        options: [
          { label: '只发 lab', description: '3082 试验面' },
          { label: '发 production', description: '需要先打 tag' },
        ],
      }],
    })
  }

  const root = document.getElementById('root')
  const offlineEl = document.getElementById('offline')

  function mergeSnapshot() {
    const host = state.snapshot
    const byId = new Map(host.sessions.map((row) => [row.id, { ...row }]))
    for (const pending of state.pending.values()) {
      const current = byId.get(pending.sessionId)
      const title = state.titles.get(pending.sessionId) ?? current?.title ?? '未命名会话'
      byId.set(pending.sessionId, {
        id: pending.sessionId,
        title,
        status: 'attention',
        reason: REASON[pending.kind] ?? '需要处理',
        pendingKind: pending.kind,
        updatedAt: current?.updatedAt ?? Date.now(),
      })
    }
    for (const [id, title] of state.titles) {
      const current = byId.get(id)
      if (current && title) current.title = title
    }
    const order = { attention: 0, error: 1, running: 2, done: 3, idle: 4 }
    const sessions = [...byId.values()].sort((a, b) => (order[a.status] - order[b.status]) || (b.updatedAt - a.updatedAt))
    const counts = { attention: 0, error: 0, running: 0, done: 0, idle: 0 }
    for (const row of sessions) counts[row.status] += 1
    let mood = 'idle'
    if (counts.attention) mood = 'needs-you'
    else if (counts.error) mood = 'error'
    else if (counts.running) mood = 'working'
    else if (counts.done) mood = 'done-unseen'
    return { mood, counts, sessions, revision: host.revision }
  }

  function firstPending(snap) {
    const attention = snap.sessions.find((row) => row.status === 'attention')
    if (!attention) return undefined
    for (const pending of state.pending.values()) {
      if (pending.sessionId === attention.id) return pending
    }
    return { kind: attention.pendingKind ?? 'question', sessionId: attention.id, hostOnly: true }
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
  }
  const esc = escapeHtml

  function clockText() {
    const now = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    return `${pad(now.getHours())}:${pad(now.getMinutes())}`
  }

  function summaryText(counts) {
    const bits = []
    if (counts.attention) bits.push(`${counts.attention} 等你`)
    if (counts.error) bits.push(`${counts.error} 出错`)
    if (counts.running) bits.push(`${counts.running} 干活`)
    if (counts.done) bits.push(`${counts.done} 完成`)
    return bits.length ? bits.join(' · ') : '全部空闲'
  }

  async function navigate(sessionId) {
    if (sessionId.startsWith('mock-')) return
    try {
      await fetch('/buddy/navigate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
    } catch { /* host will retry on next tap */ }
  }

  async function respond(pending, body) {
    if (pending.rpcId === 'mock') {
      state.pending.delete('q:mock')
      const row = state.snapshot.sessions.find((r) => r.id === pending.sessionId)
      if (row) { row.status = 'running'; row.reason = '收到回答，继续干' }
      state.selected.clear()
      render()
      return
    }
    try {
      await fetch('/api/respond', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      state.selected.clear()
    } catch { /* mux resolved frame will catch up */ }
  }

  function approvalBody(pending, outcome) {
    return {
      type: 'client-response',
      rpcId: pending.rpcId,
      result: { ok: true, value: { sessionId: pending.sessionId, approvalId: pending.approvalId, outcome } },
    }
  }

  function questionBody(pending, answers) {
    return {
      type: 'client-response',
      rpcId: pending.rpcId,
      result: { ok: true, value: { sessionId: pending.sessionId, answer: { answers } } },
    }
  }

  function moodNow() {
    if (Date.now() < state.petUntil) return 'pet'
    return mergeSnapshot().mood
  }

  function tickSprites() {
    const row = MOOD_ROW[moodNow()] ?? 0
    const col = state.frame % FRAMES
    for (const el of document.querySelectorAll('.sprite')) {
      const size = Number(el.dataset.size) || 192
      el.style.width = `${size}px`
      el.style.height = `${size}px`
      el.style.backgroundSize = `${SHEET_COLS * size}px ${SHEET_ROWS * size}px`
      el.style.backgroundPosition = `${-col * size}px ${-row * size}px`
    }
  }

  function pet(event) {
    state.petUntil = Date.now() + 1600
    const heart = document.createElement('div')
    heart.className = 'heart-pop'
    heart.textContent = '❤'
    heart.style.left = `${event.clientX - 10}px`
    heart.style.top = `${event.clientY - 30}px`
    document.body.appendChild(heart)
    setTimeout(() => heart.remove(), 900)
    render()
  }

  function pendingActionsHtml(pending) {
    if (pending.hostOnly) {
      return `<button class="btn" data-nav="${esc(pending.sessionId)}">去主屏看</button>`
    }
    if (pending.kind === 'approval') {
      return `
        <button class="btn" data-approve="allowed-once">批准</button>
        <button class="btn danger" data-approve="rejected">拒绝</button>`
    }
    const question = pending.questions[0]
    const options = question.options ?? []
    if (options.length === 0) {
      return `<button class="btn" data-nav="${esc(pending.sessionId)}">去主屏回答</button>`
    }
    const picks = options.map((option, index) => `
      <button class="btn pick${state.selected.has(option.label) ? ' on' : ''}" data-opt="${index}">
        ${esc(option.label)}${option.description ? `<small>${esc(option.description)}</small>` : ''}
      </button>`).join('')
    const confirm = question.multiSelect ? '<button class="btn" data-confirm="1">确认</button>' : ''
    return picks + confirm
  }

  function pendingTitle(pending) {
    if (pending.hostOnly) return REASON[pending.kind] ?? '需要处理'
    if (pending.kind === 'approval') return `批准 ${pending.toolName ?? '工具调用'}`
    const question = pending.questions[0]
    return question.header || (pending.kind === 'plan-review' ? '计划待审' : '问你一件事')
  }

  function pendingDetail(pending) {
    if (pending.hostOnly) return '详情在主屏，点会话行可以切过去。'
    if (pending.kind === 'approval') return pending.reason || '工具调用需要确认'
    const question = pending.questions[0]
    return question.question + (question.detail ? ` · ${String(question.detail).slice(0, 80)}` : '')
  }

  let prevOpenKey = ''
  let lastHtml = ''

  function layoutHtml(snap, pending) {
    const manual = state.openId ? snap.sessions.find((row) => row.id === state.openId) : undefined
    const openKey = manual ? `s:${manual.id}` : pending ? `p:${pending.rpcId ?? pending.sessionId}` : ''
    const settled = openKey === prevOpenKey
    prevOpenKey = openKey
    const activeId = manual?.id ?? pending?.sessionId

    const chips = snap.sessions.slice(0, 8).map((row) => `
      <button class="chip ${row.status}${row.id === activeId ? ' active' : ''}" data-open="${esc(row.id)}">
        <span class="dot ${row.status}"></span>${esc(row.title)}
      </button>`).join('')

    let bubble = ''
    if (manual && !(pending && pending.sessionId === manual.id)) {
      bubble = `
        <div class="bubble ${manual.status}">
          <button class="close" data-close>×</button>
          <div class="bubble-head ${manual.status}">${esc(STATUS_LABEL[manual.status])} · ${esc(manual.reason)}</div>
          <div class="bubble-title">${esc(manual.title)}</div>
          <div class="bubble-actions">
            <button class="btn" data-nav="${esc(manual.id)}">去主屏看</button>
          </div>
        </div>`
    } else if (pending) {
      const session = snap.sessions.find((row) => row.id === pending.sessionId)
      bubble = `
        <div class="bubble need">
          <div class="bubble-head need">${esc(pendingTitle(pending))}</div>
          ${session ? `<div class="bubble-title">${esc(session.title)}</div>` : ''}
          <div class="bubble-detail">${esc(pendingDetail(pending))}</div>
          <div class="bubble-actions">${pendingActionsHtml(pending)}</div>
        </div>`
    }
    const open = Boolean(bubble)
    const moodText = Date.now() < state.petUntil ? '嘿嘿' : MOOD_LABEL[snap.mood]
    const stage = `
      <div class="stage" data-pet>
        <div class="sprite" data-size="${open ? 190 : 230}"></div>
        ${open ? `<div class="mood-mini">${esc(moodText)}</div>` : ''}
      </div>`
    const side = open ? bubble : `
      <div class="side">
        <div class="word ${snap.mood}">${esc(moodText)}</div>
        <div class="sub">${esc(summaryText(snap.counts))}</div>
      </div>`

    return `
      <div class="app mood-${snap.mood}">
        <header class="top">
          <span class="brand">DSH BUDDY</span>
          <span class="clock js-clock">${clockText()}</span>
        </header>
        <div class="center${open ? ' open' : ''}${settled ? ' settled' : ''}">
          ${stage}
          ${side}
        </div>
        <footer class="ticker">${chips || '<span class="none">没有任务</span>'}</footer>
      </div>`
  }

  function render() {
    const snap = mergeSnapshot()
    const pending = firstPending(snap)
    if (state.openId && !snap.sessions.some((row) => row.id === state.openId)) state.openId = null
    const html = layoutHtml(snap, pending)
    if (html !== lastHtml) {
      root.innerHTML = html
      lastHtml = html
    }
    offlineEl.hidden = state.buddyLive || MOCK
    tickSprites()
  }

  document.body.addEventListener('pointerdown', (event) => {
    const petTarget = event.target instanceof Element ? event.target.closest('[data-pet]') : null
    if (petTarget) pet(event)
  })

  document.body.addEventListener('click', (event) => {
    const target = event.target instanceof Element
      ? event.target.closest('[data-nav],[data-approve],[data-opt],[data-confirm],[data-open],[data-close]')
      : null
    if (!(target instanceof HTMLElement)) return
    if (target.hasAttribute('data-close')) {
      state.openId = null
      render()
      return
    }
    if (target.dataset.open) {
      state.openId = state.openId === target.dataset.open ? null : target.dataset.open
      render()
      return
    }
    if (target.dataset.nav) {
      void navigate(target.dataset.nav)
      return
    }
    const pending = firstPending(mergeSnapshot())
    if (!pending) return
    if (target.dataset.approve && 'rpcId' in pending && pending.kind === 'approval') {
      void respond(pending, approvalBody(pending, target.dataset.approve))
      return
    }
    if (target.dataset.opt !== undefined) {
      const item = pending.kind !== 'approval' && 'questions' in pending ? pending : undefined
      const question = item?.questions?.[0]
      const option = question?.options?.[Number(target.dataset.opt)]
      if (!item || !question || !option) return
      if (question.multiSelect) {
        if (state.selected.has(option.label)) state.selected.delete(option.label)
        else state.selected.add(option.label)
        render()
        return
      }
      void respond(item, questionBody(item, [{ id: question.id, selected: [option.label] }]))
      return
    }
    if (target.dataset.confirm) {
      const item = pending.kind !== 'approval' && 'questions' in pending ? pending : undefined
      const question = item?.questions?.[0]
      if (!item || !question) return
      void respond(item, questionBody(item, [{ id: question.id, selected: [...state.selected] }]))
    }
  })

  // alpha.1 /api/remote.mux downlink items: {type:'emit'|'waterfall'|'cancel', event, args|request}
  function parseFrame(raw) {
    try {
      const value = JSON.parse(raw)
      if (!value || (value.type !== 'emit' && value.type !== 'waterfall')) return undefined
      if (typeof value.event !== 'string') return undefined
      const payload = value.type === 'waterfall' ? value.request : (Array.isArray(value.args) ? value.args[0] : undefined)
      if (typeof payload !== 'object' || payload === null) return undefined
      return { event: value.event, payload }
    } catch {
      return undefined
    }
  }

  function onMux(envelope) {
    const payload = envelope.payload
    // Titles: alpha.1 carries them on the session list snapshot, not as
    // projection broadcasts; the kiosk refetches the list on each event.
    if (envelope.event === 'session-title/updated' && typeof payload?.sessionId === 'string' && typeof payload?.title === 'string') {
      state.titles.set(payload.sessionId, payload.title)
      render()
      return
    }
    if (envelope.event === 'approval/request') {
      const approvalId = payload.callId ?? payload.toolName
      state.pending.set(`a:${approvalId}`, {
        kind: 'approval',
        rpcId: envelope.eventId,
        sessionId: undefined,
        approvalId,
        toolName: payload.toolName,
        reason: payload.reason,
      })
      state.selected.clear()
      render()
      return
    }
    if (envelope.event === 'user-questions/request') {
      const questions = Array.isArray(payload.questions) ? payload.questions : []
      const key = `q:${payload.key ?? Date.now()}`
      const kind = questions.some((item) => item?.intent?.kind === 'plan-review') ? 'plan-review' : 'question'
      state.pending.set(key, {
        kind,
        rpcId: envelope.eventId,
        sessionId: undefined,
        questions,
      })
      state.selected.clear()
      render()
      return
    }
    if (envelope.event === 'approval/outcome' || envelope.event === 'user-questions/answered') {
      const id = payload?.callId ?? payload?.key
      if (typeof id === 'string') {
        state.pending.delete(id.startsWith('a:') || id.startsWith('q:') ? id : `a:${id}`)
      }
      render()
    }
  }

  function openSse(url, onMessage, onStatus) {
    const stream = new EventSource(url)
    stream.onopen = () => onStatus(true)
    stream.onerror = () => {
      window.setTimeout(() => {
        if (stream.readyState !== EventSource.OPEN) onStatus(false)
      }, 1200)
    }
    stream.onmessage = (event) => onMessage(event.data)
    return stream
  }

  if (!MOCK) {
    openSse('/buddy/events', (data) => {
      try {
        const frame = JSON.parse(data)
        if (frame.type === 'snapshot' && frame.snapshot) {
          state.snapshot = frame.snapshot
          state.buddyLive = true
          render()
        }
      } catch { /* keep last snapshot */ }
    }, (live) => {
      state.buddyLive = live
      render()
    })

    openSse('/api/remote.mux', (data) => {
      const envelope = parseFrame(data)
      if (envelope) onMux(envelope)
    }, () => {})
  }

  setInterval(() => {
    state.frame += 1
    tickSprites()
    if (state.petUntil && Date.now() >= state.petUntil) {
      state.petUntil = 0
      render()
    }
  }, 260)

  setInterval(() => {
    for (const el of document.querySelectorAll('.js-clock')) el.textContent = clockText()
  }, 1000)

  render()
})()
