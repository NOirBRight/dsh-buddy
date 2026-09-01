import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BuddyClientContext } from './index.ts'

type MessageEventLike = { data: string }
type TestEventSource = {
  url: string
  readyState: number
  onerror: ((event: Event) => void) | null
  close: ReturnType<typeof vi.fn>
}

describe('dsh-buddy-client transport', () => {
  let originalEventSource: typeof EventSource | undefined

  beforeEach(() => {
    originalEventSource = globalThis.EventSource
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    if (originalEventSource !== undefined) globalThis.EventSource = originalEventSource
    else Reflect.deleteProperty(globalThis, 'EventSource')
    vi.restoreAllMocks()
  })

  it('closes EventSource and timer on dispose, is idempotent, and does not leak prior stream on reconnect', async () => {
    const streams: TestEventSource[] = []
    class MockEventSource {
      static CLOSED = 2
      static CONNECTING = 0
      static OPEN = 1
      onmessage: ((event: MessageEventLike) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      readyState = 0
      close = vi.fn(() => { this.readyState = MockEventSource.CLOSED })
      url: string
      constructor(url: string) {
        this.url = url
        this.readyState = MockEventSource.OPEN
        streams.push(this)
      }
    }
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource
    const disposers: Array<() => void> = []
    const ctx = {
      sessions: { open: vi.fn() },
      effect(fn: () => (() => void) | void) {
        const dispose = fn()
        if (dispose) disposers.push(dispose)
        return () => { if (dispose) dispose() }
      },
    } as unknown as BuddyClientContext
    const { apply } = await import('./index.ts')
    apply(ctx)
    expect(streams.length).toBe(1)
    expect(streams[0]!.url).toBe('/buddy/client-events')
    streams[0]!.onerror?.({} as Event)
    expect(streams[0]!.close).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(4000)
    expect(streams.length).toBe(2)
    expect(streams[0]!.close).toHaveBeenCalled()
    for (const dispose of disposers) dispose()
    expect(streams[1]!.close).toHaveBeenCalled()
    for (const dispose of disposers) dispose()
    expect(streams.length).toBe(2)
  })

  it('forwards navigate frames to sessions.open', async () => {
    const sessionsOpen = vi.fn()
    let capturedHandler: ((event: MessageEventLike) => void) | null = null
    class MockEventSource {
      static CLOSED = 2
      onmessage: ((event: MessageEventLike) => void) | null = null
      onerror: (() => void) | null = null
      readyState = 1
      close = vi.fn()
      constructor(_url: string) {
        Object.defineProperty(this, 'onmessage', {
          get: () => capturedHandler,
          set: (value: unknown) => {
            capturedHandler = typeof value === 'function' ? value as (event: MessageEventLike) => void : null
          },
        })
      }
    }
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource
    const ctx = {
      sessions: { open: sessionsOpen },
      effect(fn: () => (() => void) | void) {
        fn()
        return () => {}
      },
    } as unknown as BuddyClientContext
    const { apply } = await import('./index.ts')
    apply(ctx)
    expect(capturedHandler).not.toBeNull()
    capturedHandler!({ data: '界'.repeat(Math.floor((512 * 1024) / 3) + 1) })
    expect(sessionsOpen).not.toHaveBeenCalled()
    capturedHandler!({ data: JSON.stringify({ type: 'navigate', sessionId: 's-123' }) })
    expect(sessionsOpen).toHaveBeenCalledWith('s-123')
    capturedHandler!({ data: JSON.stringify({ type: 'navigate', sessionId: 'x'.repeat(257) }) })
    capturedHandler!({ data: JSON.stringify({ type: 'navigate', sessionId: 'bad\nvalue' }) })
    capturedHandler!({ data: JSON.stringify({ type: 'navigate', sessionId: 'bad\u0085value' }) })
    expect(sessionsOpen).toHaveBeenCalledTimes(1)
    capturedHandler!({ data: '{ not json' })
    expect(sessionsOpen).toHaveBeenCalledTimes(1)
  })
})
