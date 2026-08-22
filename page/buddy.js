// PROTOTYPE — /buddy 上的三个 UI 变体，?variant=A|B|C 切换（底部悬浮条 / ←→ 键）。
// ?mock=1 注入假会话方便看满状态。数据层共享，渲染层每个变体独立重写。
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
  const VARIANTS = ['A', 'B', 'C']
  let variant = VARIANTS.includes(params.get('variant')) ? params.get('variant') : 'B'

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

  // ---------- shared data layer ----------

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

  // ---------- actions ----------

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

  // ---------- sprite ----------

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

  // ---------- pending card fragments (each variant styles its own) ----------

  function pendingActionsHtml(pending, cls) {
    if (pending.hostOnly) {
      return `<button class="${cls}" data-nav="${esc(pending.sessionId)}">去主屏看</button>`
    }
    if (pending.kind === 'approval') {
      return `
        <button class="${cls}" data-approve="allowed-once">批准</button>
        <button class="${cls} danger" data-approve="rejected">拒绝</button>`
    }
    const question = pending.questions[0]
    const options = question.options ?? []
    if (options.length === 0) {
      return `<button class="${cls}" data-nav="${esc(pending.sessionId)}">去主屏回答</button>`
    }
    const picks = options.map((option, index) => `
      <button class="${cls} pick${state.selected.has(option.label) ? ' on' : ''}" data-opt="${index}">
        ${esc(option.label)}${option.description ? `<small>${esc(option.description)}</small>` : ''}
      </button>`).join('')
    const confirm = question.multiSelect ? `<button class="${cls}" data-confirm="1">确认</button>` : ''
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

  // ---------- variant A 驾驶舱 ----------

  const VariantA = {
    key: 'A',
    name: '驾驶舱',
    render(snap, pending) {
      const chips = ['attention', 'error', 'running', 'done'].filter((k) => snap.counts[k])
        .map((k) => `<span class="va-chip ${k}">${snap.counts[k]} ${STATUS_LABEL[k]}</span>`).join('')
      const rows = snap.sessions.slice(0, pending ? 3 : 5).map((row) => `
        <div class="va-row ${row.status}" data-nav="${esc(row.id)}">
          <span class="va-bar-mark ${row.status}"></span>
          <span class="va-title">${esc(row.title)}</span>
          <span class="va-reason">${esc(row.reason)}</span>
        </div>`).join('')
      const card = pending ? `
        <div class="va-card">
          <div class="va-card-head">${esc(pendingTitle(pending))}</div>
          <div class="va-card-detail">${esc(pendingDetail(pending))}</div>
          <div class="va-actions">${pendingActionsHtml(pending, 'va-btn')}</div>
        </div>` : ''
      return `
        <div class="va mood-${snap.mood}">
          <aside class="va-stage" data-pet>
            <div class="sprite" data-size="200"></div>
            <div class="va-mood">${esc(Date.now() < state.petUntil ? '嘿嘿' : MOOD_LABEL[snap.mood])}</div>
            <div class="va-clock js-clock">${clockText()}</div>
          </aside>
          <section class="va-main">
            <header class="va-head">
              <span class="va-brand">DSH BUDDY</span>
              <span class="va-chips">${chips || '<span class="va-chip idle">全部空闲</span>'}</span>
            </header>
            ${card}
            <div class="va-list">${rows || '<div class="va-empty">还没有任务，摸摸左边的小鲸鱼吧</div>'}</div>
          </section>
        </div>`
    },
  }

  // ---------- variant B 剧场 ----------
  // 平时鲸鱼居中、任务在底部走马灯；点任务或有待确认时，
  // 鲸鱼滑到左边，右边展开气泡（会话详情 / 审批答题按钮）。

  let prevOpenKeyB = ''

  const VariantB = {
    key: 'B',
    name: '剧场',
    render(snap, pending) {
      const manual = state.openId ? snap.sessions.find((row) => row.id === state.openId) : undefined
      const openKey = manual ? `s:${manual.id}` : pending ? `p:${pending.rpcId ?? pending.sessionId}` : ''
      const settled = openKey === prevOpenKeyB
      prevOpenKeyB = openKey
      const activeId = manual?.id ?? pending?.sessionId

      const chips = snap.sessions.slice(0, 8).map((row) => `
        <button class="vb-chip ${row.status}${row.id === activeId ? ' active' : ''}" data-open="${esc(row.id)}">
          <span class="vb-dot ${row.status}"></span>${esc(row.title)}
        </button>`).join('')

      let bubble = ''
      if (manual && !(pending && pending.sessionId === manual.id)) {
        bubble = `
          <div class="vb-bubble ${manual.status}">
            <button class="vb-close" data-close>×</button>
            <div class="vb-bubble-head ${manual.status}">${esc(STATUS_LABEL[manual.status])} · ${esc(manual.reason)}</div>
            <div class="vb-bubble-title">${esc(manual.title)}</div>
            <div class="vb-bubble-actions">
              <button class="vb-btn" data-nav="${esc(manual.id)}">去主屏看</button>
            </div>
          </div>`
      } else if (pending) {
        const session = snap.sessions.find((row) => row.id === pending.sessionId)
        bubble = `
          <div class="vb-bubble need">
            <div class="vb-bubble-head need">${esc(pendingTitle(pending))}</div>
            ${session ? `<div class="vb-bubble-title">${esc(session.title)}</div>` : ''}
            <div class="vb-bubble-detail">${esc(pendingDetail(pending))}</div>
            <div class="vb-bubble-actions">${pendingActionsHtml(pending, 'vb-btn')}</div>
          </div>`
      }
      const open = Boolean(bubble)

      const stage = `
        <div class="vb-stage" data-pet>
          <div class="sprite" data-size="${open ? 190 : 230}"></div>
          ${open ? `<div class="vb-mood-mini">${esc(Date.now() < state.petUntil ? '嘿嘿' : MOOD_LABEL[snap.mood])}</div>` : ''}
        </div>`
      const side = open ? bubble : `
        <div class="vb-side">
          <div class="vb-word ${snap.mood}">${esc(Date.now() < state.petUntil ? '嘿嘿' : MOOD_LABEL[snap.mood])}</div>
          <div class="vb-sub">${esc(summaryText(snap.counts))}</div>
        </div>`

      return `
        <div class="vb mood-${snap.mood}">
          <header class="vb-top">
            <span class="vb-brand">DSH BUDDY</span>
            <span class="vb-clock js-clock">${clockText()}</span>
          </header>
          <div class="vb-center${open ? ' open' : ''}${settled ? ' settled' : ''}">
            ${stage}
            ${side}
          </div>
          <footer class="vb-ticker">${chips || '<span class="vb-none">没有任务</span>'}</footer>
        </div>`
    },
  }

  // ---------- variant C 指挥板 ----------

  const VariantC = {
    key: 'C',
    name: '指挥板',
    render(snap, pending) {
      const counts = ['attention', 'error', 'running', 'done'].map((k) => `
        <span class="vc-count ${k}${snap.counts[k] ? '' : ' zero'}">
          <b>${snap.counts[k]}</b>${STATUS_LABEL[k]}
        </span>`).join('')
      const rows = snap.sessions.slice(0, pending ? 4 : 4).map((row) => {
        const isPending = pending && pending.sessionId === row.id
        const expand = isPending ? `
          <div class="vc-expand">
            <div class="vc-expand-detail">${esc(pendingDetail(pending))}</div>
            <div class="vc-expand-actions">${pendingActionsHtml(pending, 'vc-btn')}</div>
          </div>` : ''
        return `
          <div class="vc-row ${row.status}${isPending ? ' open' : ''}">
            <div class="vc-row-main" data-nav="${esc(row.id)}">
              <span class="vc-glyph ${row.status}"></span>
              <span class="vc-title">${esc(row.title)}</span>
              <span class="vc-reason">${esc(row.reason)}</span>
            </div>
            ${expand}
          </div>`
      }).join('')
      return `
        <div class="vc mood-${snap.mood}">
          <header class="vc-head">
            <div class="vc-mascot" data-pet>
              <div class="sprite" data-size="84"></div>
            </div>
            <div class="vc-counts">${counts}</div>
            <div class="vc-clock js-clock">${clockText()}</div>
          </header>
          <div class="vc-rows">${rows || '<div class="vc-empty">没有任务 · 鲸鱼在上面打盹</div>'}</div>
        </div>`
    },
  }

  const REGISTRY = { A: VariantA, B: VariantB, C: VariantC }

  // ---------- render + switcher ----------

  let lastHtml = ''

  function render() {
    const snap = mergeSnapshot()
    const pending = firstPending(snap)
    if (state.openId && !snap.sessions.some((row) => row.id === state.openId)) state.openId = null
    const html = REGISTRY[variant].render(snap, pending)
    if (html !== lastHtml) {
      root.innerHTML = html
      lastHtml = html
    }
    offlineEl.hidden = state.buddyLive || MOCK
    renderSwitcher()
    tickSprites()
  }

  function renderSwitcher() {
    let bar = document.getElementById('proto-switcher')
    if (!bar) {
      bar = document.createElement('div')
      bar.id = 'proto-switcher'
      document.body.appendChild(bar)
    }
    const v = REGISTRY[variant]
    bar.innerHTML = `
      <button data-cycle="-1">‹</button>
      <span>${v.key} — ${v.name}${MOCK ? ' · mock' : ''}</span>
      <button data-cycle="1">›</button>`
  }

  function cycle(delta) {
    const index = (VARIANTS.indexOf(variant) + delta + VARIANTS.length) % VARIANTS.length
    variant = VARIANTS[index]
    const next = new URLSearchParams(location.search)
    next.set('variant', variant)
    history.replaceState(null, '', `${location.pathname}?${next}`)
    render()
  }

  // ---------- events ----------

  document.body.addEventListener('pointerdown', (event) => {
    const petTarget = event.target instanceof Element ? event.target.closest('[data-pet]') : null
    if (petTarget) pet(event)
  })

  document.body.addEventListener('click', (event) => {
    const target = event.target instanceof Element
      ? event.target.closest('[data-nav],[data-approve],[data-opt],[data-confirm],[data-cycle],[data-open],[data-close]')
      : null
    if (!(target instanceof HTMLElement)) return
    if (target.dataset.cycle) {
      cycle(Number(target.dataset.cycle))
      return
    }
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

  document.addEventListener('keydown', (event) => {
    const el = document.activeElement
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
    if (event.key === 'ArrowLeft') cycle(-1)
    if (event.key === 'ArrowRight') cycle(1)
  })

  // ---------- SSE ----------

  function parseFrame(raw) {
    try {
      const value = JSON.parse(raw)
      if (!value || value.type !== 'server-request' || typeof value.payload !== 'object') return undefined
      return value
    } catch {
      return undefined
    }
  }

  function onMux(envelope) {
    const payload = envelope.payload
    if (payload.type === 'session/projection' && payload.key === 'title' && typeof payload.sessionId === 'string' && typeof payload.value === 'string') {
      state.titles.set(payload.sessionId, payload.value)
      render()
      return
    }
    if (payload.type === 'approval/requested') {
      state.pending.set(`a:${payload.approvalId}`, {
        kind: 'approval',
        rpcId: envelope.rpcId,
        sessionId: payload.sessionId,
        approvalId: payload.approvalId,
        toolName: payload.toolName,
        reason: payload.reason,
      })
      state.selected.clear()
      render()
      return
    }
    if (payload.type === 'approval/resolved') {
      state.pending.delete(`a:${payload.approvalId}`)
      render()
      return
    }
    if (payload.type === 'question/requested') {
      const questions = Array.isArray(payload.questions) ? payload.questions : []
      const kind = questions.some((item) => item?.intent?.kind === 'plan-review') ? 'plan-review' : 'question'
      state.pending.set(`q:${envelope.rpcId}`, {
        kind,
        rpcId: envelope.rpcId,
        sessionId: payload.sessionId,
        questions,
      })
      state.selected.clear()
      render()
      return
    }
    if (payload.type === 'question/resolved') {
      state.pending.delete(`q:${payload.questionRpcId}`)
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

    openSse('/api/events.mux', (data) => {
      const envelope = parseFrame(data)
      if (envelope) onMux(envelope)
    }, () => {})
  }

  // ---------- loops ----------

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
