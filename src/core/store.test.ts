import { describe, expect, it } from 'vitest'
import { BuddyStore } from './store.ts'

describe('BuddyStore', () => {
  it('seeds live agents and folds history into a snapshot', () => {
    const store = new BuddyStore()
    store.seed([
      {
        id: 's1',
        header: { cwd: '/tmp/alpha', createdAt: 1 },
        events: [
          { type: 'user/message', time: 2, data: { content: [{ type: 'text', text: 'hello world' }] } },
          { type: 'session/title', time: 3, data: { title: 'Hello' } },
          { type: 'turn/end', time: 4, data: { reason: { kind: 'completed' } } },
        ],
      },
      {
        id: 's2',
        header: { origin: 'subagent' },
        events: [{ type: 'user/message', time: 2, data: { content: [{ type: 'text', text: 'child' }] } }],
      },
    ], [{ id: 's1', status: 'running' }])
    const snap = store.snapshot()
    expect(snap.mood).toBe('working')
    expect(snap.sessions).toHaveLength(1)
    expect(snap.sessions[0]?.title).toBe('Hello')
  })

  it('promotes approvals, then errors, then unseen completions', () => {
    const store = new BuddyStore()
    store.seed([{
      id: 's1',
      header: {},
      events: [{ type: 'user/message', time: 1, data: { content: [{ type: 'text', text: 'go' }] } }],
    }], [{ id: 's1', status: 'running' }])
    store.onEvent('s1', { type: 'approval/asked', time: 2, data: { id: 'a', toolName: 'bash' } })
    expect(store.snapshot().mood).toBe('needs-you')
    store.onEvent('s1', { type: 'approval/decided', time: 3, data: { id: 'a', outcome: 'allowed-once' } })
    store.onAgentStatus('s1', 'idle')
    store.onEvent('s1', { type: 'turn/end', time: 4, data: { reason: { kind: 'error', error: { message: 'nope' } } } })
    expect(store.snapshot().mood).toBe('error')
    store.onEvent('s1', { type: 'turn/start', time: 5, data: {} })
    store.onEvent('s1', { type: 'turn/end', time: 6, data: { reason: { kind: 'completed' } } })
    expect(store.snapshot().mood).toBe('done-unseen')
    store.markSeen('s1')
    expect(store.snapshot().mood).toBe('idle')
  })

  it('hides archived sessions and drops disposed ones', () => {
    const store = new BuddyStore()
    store.seed([
      { id: 'keep', header: {}, events: [{ type: 'user/message', time: 1, data: { content: [{ type: 'text', text: 'a' }] } }] },
      { id: 'gone', header: {}, events: [{ type: 'user/message', time: 1, data: { content: [{ type: 'text', text: 'b' }] } }] },
    ], [])
    store.setArchived(['gone'])
    expect(store.snapshot().sessions.map((row) => row.id)).toEqual(['keep'])
    store.onDisposed('keep')
    expect(store.snapshot().sessions).toEqual([])
  })
})
