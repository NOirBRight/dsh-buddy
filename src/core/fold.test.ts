import { describe, expect, it } from 'vitest'
import { foldEvents } from './fold.ts'

describe('foldEvents', () => {
  it('tracks title, blank, approval, error, and completedUnseen', () => {
    const folded = foldEvents([
      { type: 'user/message', time: 10, data: { content: [{ type: 'text', text: 'Please ship it' }] } },
      { type: 'session/title', time: 11, data: { title: 'Ship it' } },
      { type: 'turn/start', time: 12, data: { turn: 1 } },
      { type: 'approval/asked', time: 13, data: { id: 'a1', toolName: 'bash' } },
      { type: 'approval/decided', time: 14, data: { id: 'a1', outcome: 'allowed-once' } },
      { type: 'turn/end', time: 15, data: { turn: 1, reason: { kind: 'completed' } } },
    ], 1)
    expect(folded.title).toBe('Ship it')
    expect(folded.blank).toBe(false)
    expect(folded.pendingKind).toBeUndefined()
    expect(folded.completedUnseen).toBe(true)
    expect(folded.lastError).toBeUndefined()
    expect(folded.updatedAt).toBe(15)
  })

  it('keeps a pending approval and records turn errors', () => {
    const folded = foldEvents([
      { type: 'user/message', time: 1, data: { content: [{ type: 'text', text: 'hi' }] } },
      { type: 'approval/asked', time: 2, data: { id: 'a1', toolName: 'bash' } },
      { type: 'turn/end', time: 3, data: { turn: 1, reason: { kind: 'error', error: { message: 'rate limited' } } } },
    ])
    expect(folded.pendingKind).toBeUndefined()
    expect(folded.lastError).toBe('rate limited')
    expect(folded.completedUnseen).toBe(false)
  })

  it('clears completedUnseen on the next turn start', () => {
    const folded = foldEvents([
      { type: 'turn/end', time: 1, data: { reason: { kind: 'completed' } } },
      { type: 'turn/start', time: 2, data: { turn: 2 } },
    ])
    expect(folded.completedUnseen).toBe(false)
    expect(folded.lastError).toBeUndefined()
  })
})
