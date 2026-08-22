import { describe, expect, it } from 'vitest'
import {
  aggregateMood,
  buildSnapshot,
  classifyStatus,
  mergePendingKind,
  questionKindOf,
  sessionLabel,
  type BuddySession,
} from './buddy.ts'

const session = (partial: Partial<BuddySession> & Pick<BuddySession, 'id'>): BuddySession => ({
  title: partial.title ?? partial.id,
  blank: false,
  running: false,
  completedUnseen: false,
  updatedAt: 1,
  ...partial,
})

describe('classifyStatus', () => {
  it('hides idle blank sessions but still surfaces running blanks', () => {
    expect(classifyStatus(session({ id: 'a', origin: 'subagent' }))).toBeNull()
    expect(classifyStatus(session({ id: 'b', blank: true }))).toBeNull()
    expect(classifyStatus(session({ id: 'c', blank: true, running: true }))).toBe('running')
  })

  it('ranks pending above running, error, and done', () => {
    expect(classifyStatus(session({
      id: 'a',
      running: true,
      lastError: 'boom',
      completedUnseen: true,
      pendingKind: 'approval',
    }))).toBe('attention')
  })

  it('shows error only when idle after a failure', () => {
    expect(classifyStatus(session({ id: 'a', running: true, lastError: 'boom' }))).toBe('running')
    expect(classifyStatus(session({ id: 'a', lastError: 'boom' }))).toBe('error')
  })

  it('uses completedUnseen as done', () => {
    expect(classifyStatus(session({ id: 'a', completedUnseen: true }))).toBe('done')
  })
})

describe('aggregateMood', () => {
  it('picks the highest-urgency mood across sessions', () => {
    expect(aggregateMood([
      session({ id: 'idle' }),
      session({ id: 'run', running: true }),
      session({ id: 'ask', pendingKind: 'question' }),
    ])).toBe('needs-you')
    expect(aggregateMood([
      session({ id: 'idle' }),
      session({ id: 'err', lastError: 'nope' }),
      session({ id: 'run', running: true }),
    ])).toBe('error')
    expect(aggregateMood([
      session({ id: 'idle' }),
      session({ id: 'done', completedUnseen: true }),
    ])).toBe('done-unseen')
    expect(aggregateMood([session({ id: 'idle' })])).toBe('idle')
    expect(aggregateMood([])).toBe('idle')
  })
})

describe('buildSnapshot', () => {
  it('orders rows by urgency then recency and hides blank/subagent', () => {
    const snap = buildSnapshot([
      session({ id: 'idle', title: 'Idle', updatedAt: 9 }),
      session({ id: 'run', title: 'Busy', running: true, updatedAt: 3 }),
      session({ id: 'ask', title: 'Need you', pendingKind: 'approval', updatedAt: 4 }),
      session({ id: 'kid', origin: 'subagent' }),
      session({ id: 'blank', blank: true }),
    ], 7)
    expect(snap.mood).toBe('needs-you')
    expect(snap.revision).toBe(7)
    expect(snap.counts).toEqual({ attention: 1, error: 0, running: 1, done: 0, idle: 1 })
    expect(snap.sessions.map((row) => row.id)).toEqual(['ask', 'run', 'idle'])
    expect(snap.sessions[0]?.reason).toBe('等待审批')
  })
})

describe('sessionLabel', () => {
  it('falls back to cwd basename then unnamed', () => {
    expect(sessionLabel(session({ id: 'a', title: '  Hello  ' }))).toBe('Hello')
    expect(sessionLabel(session({ id: 'a', title: '', cwd: '/tmp/alpha' }))).toBe('alpha')
    expect(sessionLabel(session({ id: 'a', title: '' }))).toBe('未命名会话')
  })
})

describe('pending helpers', () => {
  it('prefers mux pending over host pending', () => {
    expect(mergePendingKind('approval', 'question')).toBe('question')
    expect(mergePendingKind('approval', undefined)).toBe('approval')
    expect(mergePendingKind(undefined, undefined)).toBeUndefined()
  })

  it('tags plan-review questions', () => {
    expect(questionKindOf([{ intent: { kind: 'plan-review' } }])).toBe('plan-review')
    expect(questionKindOf([{ intent: { kind: 'other' } }])).toBe('question')
    expect(questionKindOf([])).toBe('question')
  })
})
