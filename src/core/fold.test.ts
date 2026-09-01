import { describe, expect, it } from 'vitest'
import type { SessionEvent, SessionEventType } from '@deepseek-ai/dsh-session'
import { foldEvents } from './fold.ts'

function evt<T extends SessionEventType>(type: T, time: number, data: SessionEvent<T>['data']): SessionEvent<T> {
  return { type, seq: 0, time, data } as SessionEvent<T>
}

function userData(text: string): SessionEvent<'user/message'>['data'] {
  return {
    id: 'message-1' as SessionEvent<'user/message'>['data']['id'],
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

describe('foldEvents', () => {
  it('uses the title event and completed turn state', () => {
    const folded = foldEvents([
      evt('user/message', 10, userData('Please ship it')),
      evt('session/title', 11, { title: 'Ship it', messageSeqs: [], source: { kind: 'user' } }),
      evt('turn/start', 12, { turn: 1 }),
      evt('turn/end', 15, { turn: 1, reason: { kind: 'completed' } }),
    ], 1)
    expect(folded.title).toBe('Ship it')
    expect(folded.blank).toBe(false)
    expect(folded.pendingKind).toBeUndefined()
    expect(folded.completedUnseen).toBe(true)
    expect(folded.lastError).toBeUndefined()
    expect(folded.updatedAt).toBe(15)
  })

  it('caps folded titles by UTF-8 bytes without splitting characters', () => {
    const folded = foldEvents([evt('session/title', 1, { title: '界'.repeat(30), messageSeqs: [], source: { kind: 'user' } })])
    expect(Buffer.byteLength(folded.title, 'utf8')).toBeLessThanOrEqual(40)
    expect(folded.title.endsWith('…')).toBe(true)
  })

  it('records structured turn errors from the official reason payload', () => {
    const folded = foldEvents([
      evt('user/message', 1, userData('hi')),
      evt('turn/end', 3, { turn: 1, reason: { kind: 'error', error: { message: 'rate limited', code: 'UNKNOWN' } } }),
    ])
    expect(folded.lastError).toBe('rate limited')
    expect(folded.completedUnseen).toBe(false)
  })

  it('clears completedUnseen on the next turn start', () => {
    const folded = foldEvents([
      evt('turn/end', 1, { turn: 1, reason: { kind: 'completed' } }),
      evt('turn/start', 2, { turn: 2 }),
    ])
    expect(folded.completedUnseen).toBe(false)
    expect(folded.lastError).toBeUndefined()
  })

  it('ignores the official seed boundary while updating recency', () => {
    const folded = foldEvents([
      evt('session/end-seed', 5, {}),
    ], 1)
    expect(folded.updatedAt).toBe(5)
    expect(folded.blank).toBe(true)
  })
})
