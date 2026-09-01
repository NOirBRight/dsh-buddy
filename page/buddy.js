// Theater layout: whale centered, sessions as a ticker. Tap a chip or a
// pending confirmation slides the whale left and opens a speech bubble.
// ?open=<id> pre-opens a bubble.
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
  const MOODS = new Set(Object.keys(MOOD_LABEL))
  const STATUSES = new Set(Object.keys(STATUS_LABEL))
  const PENDING_KINDS = new Set(Object.keys(REASON))
  const COUNT_KEYS = ['attention', 'error', 'running', 'done', 'idle']
  const MAX_TEXT = 8 * 1024
  const MAX_ID = 256
  const MAX_QUESTIONS = 32
  const MAX_OPTIONS = 64
  const MAX_SESSIONS = 1024
  const MAX_SSE_EVENT_DATA = 512 * 1024
  const UTF8_ENCODER = new TextEncoder()
  const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/
  const FRAMES = 8
  const SHEET_COLS = 8
  const SHEET_ROWS = 6

  const params = new URLSearchParams(location.search)

  const state = {
    snapshot: { mood: 'idle', counts: { attention: 0, error: 0, running: 0, done: 0, idle: 0 }, sessions: [], revision: 0 },
    pending: new Map(),
    titles: new Map(),
    petUntil: 0,
    frame: 0,
    buddyLive: false,
    selected: new Map(),
    openId: params.get('open') || null,
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

  function removePending(requestId) {
    for (const [key, pending] of state.pending) {
      if (pending.requestId === requestId) state.pending.delete(key)
    }
    state.selected.clear()
  }

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  }

  function exactKeys(value, required, optional = []) {
    if (!isRecord(value)) return false
    const allowed = new Set([...required, ...optional])
    return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key))
  }

  function boundedString(value, limit = MAX_TEXT) {
    return typeof value === 'string' && value.length <= limit
  }

  function nonEmptyString(value, limit = MAX_TEXT) {
    return typeof value === 'string' && value.length > 0 && value.length <= limit
  }

  function validId(value) {
    return nonEmptyString(value, MAX_ID) && !CONTROL_CHARACTERS.test(value)
  }

  function optionalString(value, limit = MAX_TEXT) {
    return value === undefined || boundedString(value, limit)
  }

  function validQuestionOption(value) {
    return exactKeys(value, ['label'], ['description']) && nonEmptyString(value.label) && optionalString(value.description)
  }

  function validQuestion(value) {
    if (!exactKeys(value, ['id', 'question'], ['detail', 'header', 'options', 'multiSelect', 'intent']) || !validId(value.id) || !boundedString(value.question) || !optionalString(value.detail) || !optionalString(value.header, MAX_ID)) return false
    if (value.options !== undefined && (!Array.isArray(value.options) || value.options.length === 0 || value.options.length > MAX_OPTIONS || !value.options.every(validQuestionOption))) return false
    if (value.multiSelect !== undefined && typeof value.multiSelect !== 'boolean') return false
    if (value.intent !== undefined && (!exactKeys(value.intent, ['kind'], ['approve']) || !nonEmptyString(value.intent.kind, MAX_ID) || !optionalString(value.intent.approve))) return false
    return true
  }

  function validInteraction(value) {
    if (!isRecord(value) || !validId(value.requestId) || !validId(value.sessionId) || !PENDING_KINDS.has(value.kind)) return false
    if (value.kind === 'approval') return exactKeys(value, ['kind', 'requestId', 'sessionId', 'toolName'], ['callId', 'reason']) && nonEmptyString(value.toolName) && optionalString(value.callId, MAX_ID) && optionalString(value.reason)
    if (!exactKeys(value, ['kind', 'requestId', 'sessionId', 'questions'])) return false
    if (!Array.isArray(value.questions) || value.questions.length === 0 || value.questions.length > MAX_QUESTIONS) return false
    const ids = new Set()
    return value.questions.every((question) => {
      if (!validQuestion(question) || ids.has(question.id)) return false
      ids.add(question.id)
      return true
    })
  }

  function validSession(value) {
    if (!exactKeys(value, ['id', 'title', 'status', 'reason', 'updatedAt'], ['pendingKind', 'lastError']) || !validId(value.id) || !boundedString(value.title) || !STATUSES.has(value.status) || !boundedString(value.reason) || !optionalString(value.lastError) || !Number.isFinite(value.updatedAt)) return false
    const hasPending = value.pendingKind !== undefined
    return (!hasPending || PENDING_KINDS.has(value.pendingKind)) && (value.status === 'attention') === hasPending
  }

  function moodForCounts(counts) {
    if (counts.attention > 0) return 'needs-you'
    if (counts.error > 0) return 'error'
    if (counts.running > 0) return 'working'
    if (counts.done > 0) return 'done-unseen'
    return 'idle'
  }

  function validSnapshot(value) {
    if (!exactKeys(value, ['mood', 'counts', 'sessions', 'revision']) || !MOODS.has(value.mood) || !Number.isSafeInteger(value.revision) || value.revision < 0 || !exactKeys(value.counts, COUNT_KEYS) || !COUNT_KEYS.every((key) => Number.isSafeInteger(value.counts[key]) && value.counts[key] >= 0) || !Array.isArray(value.sessions) || value.sessions.length > MAX_SESSIONS) return false
    const ids = new Set()
    const actualCounts = { attention: 0, error: 0, running: 0, done: 0, idle: 0 }
    for (const row of value.sessions) {
      if (!validSession(row) || ids.has(row.id)) return false
      ids.add(row.id)
      actualCounts[row.status] += 1
    }
    return COUNT_KEYS.every((key) => value.counts[key] === actualCounts[key]) && moodForCounts(actualCounts) === value.mood
  }

  function validFrame(value) {
    if (!isRecord(value) || typeof value.type !== 'string') return false
    if (value.type === 'snapshot') return exactKeys(value, ['type', 'snapshot']) && validSnapshot(value.snapshot)
    if (value.type === 'interaction-requested') return exactKeys(value, ['type', 'interaction']) && validInteraction(value.interaction)
    if (value.type === 'interaction-resolved' || value.type === 'interaction-cancelled') return exactKeys(value, ['type', 'requestId']) && validId(value.requestId)
    if (value.type === 'navigate-ack') return exactKeys(value, ['type', 'sessionId']) && validId(value.sessionId)
    return false
  }
  function safeStatus(value) {
    return STATUSES.has(value) ? value : 'idle'
  }

  function safeMood(value) {
    return MOODS.has(value) ? value : 'idle'
  }

  function prunePending(snapshot) {
    const activeSessions = new Set((snapshot.sessions ?? []).filter((row) => row.pendingKind).map((row) => row.id))
    let changed = false
    for (const [key, pending] of state.pending) {
      if (!activeSessions.has(pending.sessionId)) {
        state.pending.delete(key)
        changed = true
      }
    }
    if (changed) state.selected.clear()
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
    try {
      await fetch('/buddy/navigate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
    } catch { /* host will retry on next tap */ }
  }

  async function respond(pending, body) {
    try {
      const response = await fetch('/buddy/respond', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) throw new Error('interaction response rejected')
      removePending(pending.requestId)
      render()
    } catch { /* the pending frame remains visible for a retry */ }
  }

  function approvalBody(pending, outcome) {
    return { requestId: pending.requestId, action: 'approval', outcome }
  }

  function questionBody(pending, answers) {
    return { requestId: pending.requestId, action: 'question', answers }
  }

  function questionAnswers(pending) {
    return (pending.questions ?? []).map((question) => ({
      id: question.id,
      selected: [...(state.selected.get(question.id) ?? new Set())],
    }))
  }

  function hasAllQuestionAnswers(pending) {
    return (pending.questions ?? []).length > 0 && (pending.questions ?? []).every((question) => {
      if ((question.options ?? []).length === 0) return false
      return (state.selected.get(question.id)?.size ?? 0) > 0
    })
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
      return `<button class='btn' data-nav='${esc(pending.sessionId)}'>去主屏看</button>`
    }
    if (pending.kind === 'approval') {
      return `
        <button class='btn' data-approve='allowed-once'>批准</button>
        <button class='btn danger' data-approve='rejected'>拒绝</button>`
    }
    const questions = pending.questions ?? []
    return questions.map((question) => {
      const options = question.options ?? []
      if (options.length === 0) return `<button class='btn' data-nav='${esc(pending.sessionId)}'>去主屏回答</button>`
      const selected = state.selected.get(question.id) ?? new Set()
      const picks = options.map((option, index) => `
        <button class='btn pick${selected.has(option.label) ? ' on' : ''}' data-opt='${index}' data-question='${esc(question.id)}'>
          ${esc(option.label)}${option.description ? `<small>${esc(option.description)}</small>` : ''}
        </button>`).join('')
      const confirm = question.multiSelect ? `<button class='btn' data-confirm='${esc(question.id)}'>确认</button>` : ''
      return `<div class='question-actions'>${picks}${confirm}</div>`
    }).join('')
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
    const openKey = manual ? `s:${manual.id}` : pending ? `p:${pending.requestId ?? pending.sessionId}` : ''
    const settled = openKey === prevOpenKey
    prevOpenKey = openKey
    const activeId = manual?.id ?? pending?.sessionId

    const chips = snap.sessions.slice(0, 8).map((row) => {
      const status = safeStatus(row.status)
      return `
      <button class="chip ${esc(status)}${row.id === activeId ? ' active' : ''}" data-open="${esc(row.id)}">
        <span class="dot ${esc(status)}"></span>${esc(row.title)}
      </button>`
    }).join('')

    let bubble = ''
    if (manual && !(pending && pending.sessionId === manual.id)) {
      const status = safeStatus(manual.status)
      bubble = `
        <div class="bubble ${esc(status)}">
          <button class="close" data-close>×</button>
          <div class="bubble-head ${esc(status)}">${esc(STATUS_LABEL[status])} · ${esc(manual.reason)}</div>
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
    const mood = safeMood(snap.mood)
    const moodText = Date.now() < state.petUntil ? '嘿嘿' : MOOD_LABEL[mood]
    const stage = `
      <div class="stage" data-pet>
        <div class="sprite" data-size="${open ? 190 : 230}"></div>
        ${open ? `<div class="mood-mini">${esc(moodText)}</div>` : ''}
      </div>`
    const side = open ? bubble : `
      <div class="side">
        <div class="word ${esc(mood)}">${esc(moodText)}</div>
        <div class="sub">${esc(summaryText(snap.counts))}</div>
      </div>`

    return `
      <div class="app mood-${esc(mood)}">
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
    offlineEl.hidden = state.buddyLive
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
    if (target.dataset.approve && 'requestId' in pending && pending.kind === 'approval') {
      void respond(pending, approvalBody(pending, target.dataset.approve))
      return
    }
    const item = pending.kind !== 'approval' && 'questions' in pending ? pending : undefined
    if (!item) return
    if (target.dataset.opt !== undefined) {
      const question = item.questions.find((candidate) => candidate.id === target.dataset.question) ?? item.questions[0]
      const option = question?.options?.[Number(target.dataset.opt)]
      if (!question || !option) return
      const selected = state.selected.get(question.id) ?? new Set()
      if (question.multiSelect) {
        if (selected.has(option.label)) selected.delete(option.label)
        else selected.add(option.label)
        state.selected.set(question.id, selected)
        render()
        return
      }
      selected.clear()
      selected.add(option.label)
      state.selected.set(question.id, selected)
      if (hasAllQuestionAnswers(item)) void respond(item, questionBody(item, questionAnswers(item)))
      else render()
      return
    }
    if (target.dataset.confirm) {
      const question = item.questions.find((candidate) => candidate.id === target.dataset.confirm)
      if (!question || !question.multiSelect || !hasAllQuestionAnswers(item)) return
      void respond(item, questionBody(item, questionAnswers(item)))
    }
  })

  function openSse(url, onMessage, onStatus) {
    const stream = new EventSource(url)
    stream.onopen = () => onStatus(true)
    stream.onerror = () => {
      window.setTimeout(() => {
        if (stream.readyState !== EventSource.OPEN) onStatus(false)
      }, 1200)
    }
    stream.onmessage = (event) => {
      if (typeof event.data !== 'string' || UTF8_ENCODER.encode(event.data).byteLength > MAX_SSE_EVENT_DATA) return
      onMessage(event.data)
    }
    return stream
  }

  openSse('/buddy/events', (data) => {
      try {
        const frame = JSON.parse(data)
        if (!validFrame(frame)) return
        if (frame.type === 'snapshot') {
          state.snapshot = frame.snapshot
          prunePending(frame.snapshot)
          state.buddyLive = true
          render()
        } else if (frame.type === 'interaction-requested') {
          if (state.pending.has(frame.interaction.requestId)) return
          state.pending.set(frame.interaction.requestId, frame.interaction)
          state.selected.clear()
          render()
        } else if (frame.type === 'interaction-resolved' || frame.type === 'interaction-cancelled') {
          removePending(frame.requestId)
          render()
        }
      } catch { /* keep the last valid frame */ }
    }, (live) => {
      state.buddyLive = live
      render()
  })

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
