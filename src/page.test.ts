import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../page/buddy.js', import.meta.url), 'utf8')
type MessageEventLike = { data: string }
type MessageHandler = ((event: MessageEventLike) => void) | null

class TestEventSource {
  static readonly OPEN = 1
  static readonly CLOSED = 2
  static instances: TestEventSource[] = []

  readonly url: string
  readyState = TestEventSource.OPEN
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: MessageHandler = null

  constructor(url: string) {
    this.url = url
    TestEventSource.instances.push(this)
  }

  emit(data: string): void {
    this.onmessage?.({ data })
  }

  close(): void {
    this.readyState = TestEventSource.CLOSED
  }
}

class TestElement {
  readonly dataset: Record<string, string>

  constructor(dataset: Record<string, string> = {}) {
    this.dataset = dataset
  }

  closest(): TestElement {
    return this
  }

  hasAttribute(): boolean {
    return false
  }
}

function boot(search = '', fetchImpl: (...args: unknown[]) => Promise<unknown> = async () => ({})): { root: { innerHTML: string }; stream: TestEventSource; click: (target: TestElement) => void } {
  TestEventSource.instances = []
  const root = { innerHTML: '' }
  const offline = { hidden: true }
  const listeners = new Map<string, unknown>()
  const body = {
    addEventListener(name: string, listener: unknown): void {
      listeners.set(name, listener)
    },
    appendChild(): void {},
  }
  const document = {
    body,
    createElement(): { className: string; style: Record<string, string>; remove: () => void } {
      return { className: '', style: {}, remove() {} }
    },
    getElementById(id: string): typeof root | typeof offline {
      return id === 'root' ? root : offline
    },
    querySelectorAll(): never[] {
      return []
    },
  }
  const window = { setTimeout(): number { return 0 } }
  const sandbox: Record<string, unknown> = {
    document,
    Element: TestElement,
    HTMLElement: TestElement,
    EventSource: TestEventSource,
    fetch: fetchImpl,
    JSON,
    Map,
    Number,
    Set,
    String,
    URLSearchParams,
    TextEncoder,
    Date,
    location: { search },
    setInterval(): number { return 0 },
    setTimeout(): number { return 0 },
    window,
  }
  new Script(source).runInNewContext(sandbox)
  const stream = TestEventSource.instances[0]
  if (!stream) throw new Error('Buddy page did not open its event stream')
  return {
    root,
    stream,
    click(target) {
      const listener = listeners.get('click')
      if (typeof listener === 'function') listener({ target })
    },
  }
}

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mood: 'working',
    counts: { attention: 0, error: 0, running: 1, done: 0, idle: 0 },
    sessions: [{ id: 'session-1', title: 'running', status: 'running', reason: 'working', updatedAt: 1 }],
    revision: 1,
    ...overrides,
  }
}

describe('Buddy page SSE validation', () => {
  it('does not store incomplete or invalid interactions', () => {
    const { root, stream } = boot()
    const initial = root.innerHTML
    stream.emit(JSON.stringify({
      type: 'interaction-requested',
      interaction: { kind: 'approval', requestId: 'bad', sessionId: 'session-1' },
    }))
    stream.emit(JSON.stringify({
      type: 'interaction-requested',
      interaction: { kind: 'unknown', requestId: 'bad', sessionId: 'session-1', questions: [] },
    }))
    expect(root.innerHTML).toBe(initial)
  })

  it('bounds interaction questions and options before storing them', () => {
    const { root, stream } = boot()
    const initial = root.innerHTML
    stream.emit(JSON.stringify({
      type: 'interaction-requested',
      interaction: {
        kind: 'question',
        requestId: 'too-many-questions',
        sessionId: 'session-1',
        questions: Array.from({ length: 33 }, (_item, index) => ({ id: 'q-' + String(index), question: 'question', options: [{ label: 'yes' }] })),
      },
    }))
    stream.emit(JSON.stringify({
      type: 'interaction-requested',
      interaction: {
        kind: 'question',
        requestId: 'too-many-options',
        sessionId: 'session-1',
        questions: [{ id: 'q', question: 'question', options: Array.from({ length: 65 }, (_item, index) => ({ label: 'option-' + String(index) })) }],
      },
    }))
    expect(root.innerHTML).toBe(initial)
  })

  it('caps SSE data and rejects inconsistent snapshots and duplicate IDs', () => {
    const { root, stream } = boot()
    const initial = root.innerHTML
    stream.emit('x'.repeat(512 * 1024 + 1))
    stream.emit('界'.repeat(Math.floor(512 * 1024 / 3) + 1))
    stream.emit(JSON.stringify({
      type: 'snapshot',
      snapshot: snapshot({
        mood: 'working',
        counts: { attention: 0, error: 0, running: 0, done: 0, idle: 0 },
      }),
    }))
    stream.emit(JSON.stringify({
      type: 'snapshot',
      snapshot: snapshot({
        mood: 'working',
        counts: { attention: 0, error: 0, running: 2, done: 0, idle: 0 },
        sessions: [
          { id: 'duplicate', title: 'one', status: 'running', reason: 'working', updatedAt: 1 },
          { id: 'duplicate', title: 'two', status: 'running', reason: 'working', updatedAt: 2 },
        ],
      }),
    }))
    stream.emit(JSON.stringify({
      type: 'interaction-requested',
      interaction: {
        kind: 'question',
        requestId: 'duplicate-question',
        sessionId: 'session-1',
        questions: [
          { id: 'same', question: 'one', options: [{ label: 'yes' }] },
          { id: 'same', question: 'two', options: [{ label: 'no' }] },
        ],
      },
    }))
    expect(root.innerHTML).toBe(initial)
  })

  it('validates nested interaction fields and escapes rendered text', () => {
    const { root, stream } = boot()
    stream.emit(JSON.stringify({
      type: 'interaction-requested',
      interaction: {
        kind: 'question',
        requestId: 'request-1',
        sessionId: 'session-1',
        questions: [{
          id: 'question-1',
          header: '<header>',
          question: '<question>',
          options: [{ label: '<option>', description: '& description' }],
        }],
      },
    }))
    expect(root.innerHTML).toContain('&lt;header&gt;')
    expect(root.innerHTML).toContain('&lt;question&gt;')
    expect(root.innerHTML).toContain('&lt;option&gt;')
    expect(root.innerHTML).toContain('&amp; description')
    expect(root.innerHTML).not.toContain('<header>')
    expect(root.innerHTML).not.toContain('<option>')
  })

  it('rejects unlisted snapshot enums before class rendering', () => {
    const { root, stream } = boot()
    const initial = root.innerHTML
    stream.emit(JSON.stringify({
      type: 'snapshot',
      snapshot: snapshot({
        mood: 'idle\" onmouseover=\"alert(1)',
        sessions: [{ id: 'session-1', title: 'title', status: 'running\" onmouseover=\"alert(1)', reason: 'reason', updatedAt: 1 }],
      }),
    }))
    expect(root.innerHTML).toBe(initial)
    expect(root.innerHTML).not.toContain('onmouseover')
  })

  it('navigates live sessions with mock-like IDs', async () => {
    const calls: unknown[][] = []
    const { stream, click } = boot('', async (...args: unknown[]) => {
      calls.push(args)
      return {}
    })
    stream.emit(JSON.stringify({
      type: 'snapshot',
      snapshot: snapshot({
        sessions: [{ id: 'mock-live', title: 'live', status: 'running', reason: 'working', updatedAt: 1 }],
      }),
    }))
    click(new TestElement({ nav: 'mock-live' }))
    await Promise.resolve()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]).toBe('/buddy/navigate')
    expect((calls[0]?.[1] as { body: string }).body).toBe(JSON.stringify({ sessionId: 'mock-live' }))
    expect(source).not.toContain('mock=1')
  })

  it('escapes valid snapshot text while using only whitelisted classes', () => {
    const { root, stream } = boot()
    stream.emit(JSON.stringify({
      type: 'snapshot',
      snapshot: snapshot({
        sessions: [{ id: 'session-1', title: '<title>', status: 'running', reason: '<reason>', updatedAt: 1 }],
      }),
    }))
    expect(root.innerHTML).toContain('class="chip running"')
    expect(root.innerHTML).toContain('class="dot running"')
    expect(root.innerHTML).toContain('class="app mood-working"')
    expect(root.innerHTML).toContain('&lt;title&gt;')
    expect(root.innerHTML).not.toContain('<title>')
  })
})
