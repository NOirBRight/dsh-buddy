import { describe, expect, it } from 'vitest'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { BuddyStore } from './store.ts'

function sid(id: string) {
  return id as SessionId
}

function header(partial: Partial<SessionHeader> & { cwd?: string; origin?: 'subagent' }): SessionHeader {
  return {
    version: 0,
    id: sid('x'),
    createdAt: partial.createdAt ?? 1,
    ...partial,
  } as unknown as SessionHeader
}

function event(partial: Omit<SessionEvent, 'seq'> & Partial<Pick<SessionEvent, 'seq'>>): SessionEvent {
  return { seq: 0, ...partial } as unknown as SessionEvent
}

function user(text: string, time: number): SessionEvent {
  return event({
    type: 'user/message',
    time,
    data: {
      id: 'message-1' as never,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    } as never,
  })
}

describe('BuddyStore', () => {
  it('seeds live agents and folds history into a snapshot', () => {
    const store = new BuddyStore()
    store.seed([
      {
        id: sid('s1'),
        header: header({ cwd: '/tmp/alpha', createdAt: 1 }),
        events: [
          user('hello world', 2),
          event({ type: 'session/title', time: 3, data: { title: 'Hello', messageSeqs: [], source: { kind: 'user' } } as never }),
          event({ type: 'turn/end', time: 4, data: { turn: 1, reason: { kind: 'completed' } } as never }),
        ],
      },
      {
        id: sid('s2'),
        header: header({ origin: 'subagent', createdAt: 1 }),
        events: [user('child', 2)],
      },
    ], [{ id: sid('s1'), status: 'running' } as never])
    const snap = store.snapshot()
    expect(snap.mood).toBe('working')
    expect(snap.sessions).toHaveLength(1)
    expect(snap.sessions[0]?.title).toBe('Hello')
  })

  it('promotes mux attention, then errors, then unseen completions', () => {
    const store = new BuddyStore()
    store.seed([{
      id: sid('s1'),
      header: header({ createdAt: 1 }),
      events: [user('go', 1)],
    }], [{ id: sid('s1'), status: 'running' } as never])
    store.setMuxPending(sid('s1'), 'approval')
    expect(store.snapshot().mood).toBe('needs-you')
    store.setMuxPending(sid('s1'), undefined)
    expect(store.snapshot().sessions[0]).not.toHaveProperty('pendingKind')
    store.onAgentStatus(sid('s1'), 'idle')
    store.onEvent(sid('s1'), event({ type: 'turn/end', time: 4, data: { turn: 1, reason: { kind: 'error', error: { message: 'nope', code: 'UNKNOWN' } } } as never }))
    expect(store.snapshot().mood).toBe('error')
    store.onEvent(sid('s1'), event({ type: 'turn/start', time: 5, data: { turn: 2 } as never }))
    store.onEvent(sid('s1'), event({ type: 'turn/end', time: 6, data: { turn: 1, reason: { kind: 'completed' } } as never }))
    expect(store.snapshot().mood).toBe('done-unseen')
    store.markSeen(sid('s1'))
    expect(store.snapshot().mood).toBe('idle')
  })


  it('keeps a completed turn unseen while the agent settles to idle', () => {
    const store = new BuddyStore()
    store.seed([{ id: sid('s1'), header: header({ createdAt: 1 }), events: [user('go', 1)] }], [{ id: sid('s1'), status: 'running' } as never])
    store.onEvent(sid('s1'), event({ type: 'turn/end', time: 2, data: { turn: 1, reason: { kind: 'completed' } } as never }))
    expect(store.snapshot().mood).toBe('working')
    store.onAgentStatus(sid('s1'), 'idle')
    expect(store.snapshot().mood).toBe('done-unseen')
  })

  it('fans out to every subscriber and aggregates callback failures', () => {
    const store = new BuddyStore()
    const first = new Error('first subscriber failed')
    const second = new Error('second subscriber failed')
    let healthyCalls = 0
    store.subscribe(() => { throw first })
    store.subscribe(() => { healthyCalls += 1 })
    store.subscribe(() => { throw second })

    let thrown: unknown
    try {
      store.setArchived([sid('gone')])
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors).toEqual([first, second])
    expect(healthyCalls).toBe(1)
  })

  it('ignores unknown events and statuses without resurrecting sessions', () => {
    const store = new BuddyStore()
    const before = store.snapshot().revision
    store.onEvent(sid('ghost'), user('late event', 2), header({ createdAt: 1 }))
    store.onAgentStatus(sid('ghost'), 'running', header({ createdAt: 1 }))
    expect(store.snapshot().sessions).toEqual([])
    expect(store.snapshot().revision).toBe(before)

    store.seed([{ id: sid('gone'), header: header({ createdAt: 1 }), events: [user('known', 1)] }], [])
    store.onDisposed(sid('gone'))
    const disposedRevision = store.snapshot().revision
    store.onEvent(sid('gone'), user('resurrection', 3), header({ createdAt: 1 }))
    store.onAgentStatus(sid('gone'), 'running', header({ createdAt: 1 }))
    expect(store.snapshot().sessions).toEqual([])
    expect(store.snapshot().revision).toBe(disposedRevision)
  })

  it('hides archived sessions and drops disposed ones', () => {
    const store = new BuddyStore()
    store.seed([
      { id: sid('keep'), header: header({ createdAt: 1 }), events: [user('a', 1)] },
      { id: sid('gone'), header: header({ createdAt: 1 }), events: [user('b', 1)] },
    ], [])
    store.setArchived([sid('gone')])
    expect(store.snapshot().sessions.map((row) => row.id)).toEqual(['keep'])
    store.onDisposed(sid('keep'))
    expect(store.snapshot().sessions).toEqual([])
  })

  it('ignores redundant archive updates (no bump)', () => {
    const store = new BuddyStore()
    store.seed([{ id: sid('keep'), header: header({ createdAt: 1 }), events: [user('a', 1)] }], [])
    const before = store.snapshot().revision
    store.setArchived([])
    store.setArchived([sid('gone')])
    const afterFirst = store.snapshot().revision
    store.setArchived([sid('gone')])
    expect(store.snapshot().revision).toBe(afterFirst)
    expect(afterFirst).toBeGreaterThan(before)
  })
})
