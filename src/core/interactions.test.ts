import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { BuddyInteractionBroker, parseInteractionResponse } from './interactions.ts'

const sessionId = 'session-1' as SessionId
const otherSessionId = 'session-2' as SessionId

function testStore(setMuxPending?: (_id: SessionId, kind: string | undefined) => void, sessionIds: readonly SessionId[] = [sessionId]) {
  const pending: string[] = []
  return {
    pending,
    hasSession: (id: string) => sessionIds.some((session) => id === String(session)),
    setMuxPending: (id: SessionId, kind: string | undefined) => {
      if (setMuxPending !== undefined) {
        setMuxPending(id, kind)
        return
      }
      if (kind === undefined) pending.splice(0)
      else pending.splice(0, pending.length, kind)
    },
  }
}

describe('BuddyInteractionBroker', () => {
  it('resolves an official approval request from an authenticated response', async () => {
    const store = testStore()
    const frames: unknown[] = []
    const broker = new BuddyInteractionBroker(store as never, () => true, (frame) => frames.push(frame))
    const promise = broker.handleApproval({ agent: { id: sessionId }, toolName: 'bash', callId: 'call-1', reason: 'needs access' } as never, async () => 'unavailable')
    const requested = frames[0] as { type: string; interaction: { requestId: string } }
    expect(requested.type).toBe('interaction-requested')
    expect(store.pending).toEqual(['approval'])
    expect(broker.respond({ requestId: requested.interaction.requestId, action: 'approval', outcome: 'allowed-once' })).toBe('accepted')
    expect(await promise).toBe('allowed-once')
    expect(store.pending).toEqual([])
    expect((frames[1] as { type: string }).type).toBe('interaction-resolved')
  })

  it('validates question ids and option labels before resolving', async () => {
    const store = testStore()
    const frames: unknown[] = []
    const broker = new BuddyInteractionBroker(store as never, () => true, (frame) => frames.push(frame))
    const promise = broker.handleQuestion({
      agent: { id: sessionId },
      questions: [{ id: 'plan', question: 'Ship?', options: [{ label: 'yes' }, { label: 'no' }] }],
    } as never, async () => ({ answers: [] }))
    const requested = frames[0] as { interaction: { requestId: string } }
    expect(() => broker.respond({ requestId: requested.interaction.requestId, action: 'question', answers: [{ id: 'plan', selected: ['maybe'] }] })).toThrow(/unknown option/)
    expect(broker.respond({ requestId: requested.interaction.requestId, action: 'question', answers: [{ id: 'plan', selected: ['yes'] }] })).toBe('accepted')
    expect(await promise).toEqual({ answers: [{ id: 'plan', selected: ['yes'] }] })
  })

  it('delegates when the page asks the next official answerer', async () => {
    const store = testStore()
    const frames: unknown[] = []
    const broker = new BuddyInteractionBroker(store as never, () => true, (frame) => frames.push(frame))
    let delegated = false
    const promise = broker.handleApproval({ agent: { id: sessionId }, toolName: 'bash' } as never, async () => {
      delegated = true
      return 'rejected'
    })
    const requested = frames[0] as { interaction: { requestId: string } }
    broker.respond({ requestId: requested.interaction.requestId, action: 'delegate' })
    expect(await promise).toBe('rejected')
    expect(delegated).toBe(true)
  })

  it('delegates when the authenticated kiosk disconnects', async () => {
    const store = testStore()
    const frames: unknown[] = []
    const broker = new BuddyInteractionBroker(store as never, () => true, (frame) => frames.push(frame))
    const promise = broker.handleApproval({ agent: { id: sessionId }, toolName: 'bash' } as never, async () => 'rejected')
    broker.kioskAvailabilityChanged(false)
    expect(await promise).toBe('rejected')
    expect(store.pending).toEqual([])
    expect((frames.at(-1) as { type: string }).type).toBe('interaction-cancelled')
  })

  it('cancels pending entries when their session is disposed without an AbortSignal', async () => {
    const store = testStore(undefined, [sessionId, otherSessionId])
    const frames: unknown[] = []
    const broker = new BuddyInteractionBroker(store as never, () => true, (frame) => frames.push(frame))
    const approval = broker.handleApproval({ agent: { id: sessionId }, toolName: 'bash' } as never, async () => 'rejected')
    const question = broker.handleQuestion({
      agent: { id: otherSessionId },
      questions: [{ id: 'plan', question: 'Ship?', options: [{ label: 'yes' }] }],
    } as never, async () => ({ answers: [] }))

    broker.sessionDisposed(sessionId)
    broker.sessionDisposed(otherSessionId)

    await expect(approval).resolves.toBe('cancelled')
    await expect(question).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    expect(broker.pending()).toEqual([])
    expect(store.pending).toEqual([])
    expect(frames.filter((frame) => (frame as { type?: string }).type === 'interaction-cancelled')).toHaveLength(2)
  })

  it.each([
    ['free-text', { id: 'name', question: 'What is your name?' }],
    ['zero-option', { id: 'name', question: 'Choose?', options: [] }],
  ])('delegates %s questions without capturing them', async (_label, question) => {
    const store = testStore()
    const frames: unknown[] = []
    const broker = new BuddyInteractionBroker(store as never, () => true, (frame) => frames.push(frame))
    let nextCalls = 0
    let resolveCalls = 0
    let rejectCalls = 0
    const promise = broker.handleQuestion({
      agent: { id: sessionId },
      questions: [question],
    } as never, async () => {
      nextCalls += 1
      return { answers: [] }
    })
    const settled = promise.then(() => { resolveCalls += 1 }, () => { rejectCalls += 1 })
    await expect(promise).resolves.toEqual({ answers: [] })
    await settled
    expect(nextCalls).toBe(1)
    expect(resolveCalls).toBe(1)
    expect(rejectCalls).toBe(0)
    expect(frames).toEqual([])
    expect(store.pending).toEqual([])
  })

  it('keeps one bounded pending interaction per session', async () => {
    const sessionIds = Array.from({ length: 1025 }, (_item, index) => ('session-' + String(index)) as SessionId)
    const store = testStore(undefined, sessionIds)
    const broker = new BuddyInteractionBroker(store as never, () => true, () => {})
    const nextCalls: string[] = []
    const next = async () => {
      nextCalls.push('delegated')
      return 'rejected' as const
    }
    const pending = sessionIds.map((id) => broker.handleApproval({ agent: { id }, toolName: 'bash' } as never, next))
    expect(broker.pending()).toHaveLength(1024)
    const duplicate = broker.handleApproval({ agent: { id: sessionIds[0] }, toolName: 'bash' } as never, next)
    await expect(duplicate).resolves.toBe('rejected')
    expect(nextCalls).toHaveLength(2)
    broker.dispose()
    await Promise.all(pending)
    expect(broker.pending()).toEqual([])
  })

  it('removes an entry before mux synchronization blocks reentrant response and disposal', async () => {
    const frames: unknown[] = []
    let broker: BuddyInteractionBroker
    let requestId = ''
    const store = testStore((_id, kind) => {
      if (kind !== undefined || requestId === '') return
      expect(broker.respond({ requestId, action: 'approval', outcome: 'rejected' })).toBe('unknown')
      broker.dispose()
    })
    broker = new BuddyInteractionBroker(store as never, () => true, (frame) => frames.push(frame))
    const promise = broker.handleApproval({ agent: { id: sessionId }, toolName: 'bash' } as never, async () => 'allowed-once')
    requestId = (frames[0] as { interaction: { requestId: string } }).interaction.requestId

    expect(broker.respond({ requestId, action: 'approval', outcome: 'allowed-once' })).toBe('accepted')
    await expect(promise).resolves.toBe('allowed-once')
    expect(broker.pending()).toEqual([])
  })

  it('rolls back insertion through synchronization before invoking next', async () => {
    const syncStates: Array<{ kind: string | undefined; pending: number }> = []
    let broker: BuddyInteractionBroker
    const store = testStore((_id, kind) => {
      syncStates.push({ kind, pending: broker.pending().length })
      if (kind === 'approval') throw new Error('initial mux sync failed')
    })
    broker = new BuddyInteractionBroker(store as never, () => true, () => {})
    const promise = broker.handleApproval({ agent: { id: sessionId }, toolName: 'bash' } as never, async () => 'rejected')
    await expect(promise).resolves.toBe('rejected')
    expect(syncStates).toEqual([
      { kind: 'approval', pending: 1 },
      { kind: undefined, pending: 1 },
    ])
    expect(broker.pending()).toEqual([])
  })

  it('rolls back and invokes next once when publication throws', async () => {
    const store = testStore()
    const broker = new BuddyInteractionBroker(store as never, () => true, () => {
      throw new Error('publish failed')
    })
    let nextCalls = 0
    let resolveCalls = 0
    let rejectCalls = 0
    const promise = broker.handleApproval({ agent: { id: sessionId }, toolName: 'bash' } as never, async () => {
      nextCalls += 1
      return 'rejected'
    })
    const settled = promise.then(() => { resolveCalls += 1 }, () => { rejectCalls += 1 })
    await expect(promise).resolves.toBe('rejected')
    await settled
    expect(nextCalls).toBe(1)
    expect(resolveCalls).toBe(1)
    expect(rejectCalls).toBe(0)
    expect(broker.pending()).toEqual([])
    expect(store.pending).toEqual([])
  })

  it('rejects once when a question publication throws and next rejects', async () => {
    const store = testStore()
    const broker = new BuddyInteractionBroker(store as never, () => true, () => {
      throw new Error('publish failed')
    })
    let nextCalls = 0
    let resolveCalls = 0
    let rejectCalls = 0
    const promise = broker.handleQuestion({
      agent: { id: sessionId },
      questions: [{ id: 'plan', question: 'Ship?', options: [{ label: 'yes' }] }],
    } as never, async () => {
      nextCalls += 1
      throw new Error('official answerer failed')
    })
    const settled = promise.then(() => { resolveCalls += 1 }, () => { rejectCalls += 1 })
    await expect(promise).rejects.toThrow('official answerer failed')
    await settled
    expect(nextCalls).toBe(1)
    expect(resolveCalls).toBe(0)
    expect(rejectCalls).toBe(1)
    expect(broker.pending()).toEqual([])
    expect(store.pending).toEqual([])
  })

  it('delegates questions with too many options without capturing them', async () => {
    const store = testStore()
    const frames: unknown[] = []
    const broker = new BuddyInteractionBroker(store as never, () => true, (frame) => frames.push(frame))
    const options = Array.from({ length: 65 }, (_value, index) => ({ label: 'option-' + String(index) }))
    const promise = broker.handleQuestion({
      agent: { id: sessionId },
      questions: [{ id: 'options', question: 'Choose?', options }],
    } as never, async () => ({ answers: [] }))
    await expect(promise).resolves.toEqual({ answers: [] })
    expect(frames).toEqual([])
    expect(broker.pending()).toEqual([])
  })

  it('delegates questions whose total display exceeds the bound', async () => {
    const store = testStore()
    const frames: unknown[] = []
    const broker = new BuddyInteractionBroker(store as never, () => true, (frame) => frames.push(frame))
    const options = Array.from({ length: 9 }, () => ({ label: 'x'.repeat(8 * 1024) }))
    const promise = broker.handleQuestion({
      agent: { id: sessionId },
      questions: [{ id: 'display', question: 'Choose?', options }],
    } as never, async () => ({ answers: [] }))
    await expect(promise).resolves.toEqual({ answers: [] })
    expect(frames).toEqual([])
    expect(broker.pending()).toEqual([])
  })

  it('delegates an already-aborted request once without capturing it', async () => {
    const store = testStore()
    const frames: unknown[] = []
    const broker = new BuddyInteractionBroker(store as never, () => true, (frame) => frames.push(frame))
    const controller = new AbortController()
    controller.abort()
    let nextCalls = 0
    let resolveCalls = 0
    let rejectCalls = 0
    const promise = broker.handleApproval({ agent: { id: sessionId }, toolName: 'bash', signal: controller.signal } as never, async () => {
      nextCalls += 1
      return 'allowed-once'
    })
    const settled = promise.then(() => { resolveCalls += 1 }, () => { rejectCalls += 1 })
    await expect(promise).resolves.toBe('allowed-once')
    await settled
    expect(nextCalls).toBe(1)
    expect(resolveCalls).toBe(1)
    expect(rejectCalls).toBe(0)
    expect(frames).toEqual([])
    expect(broker.pending()).toEqual([])
  })

  it('cancels a request when abort races publication without invoking next', async () => {
    const store = testStore()
    const controller = new AbortController()
    const broker = new BuddyInteractionBroker(store as never, () => true, () => {
      controller.abort()
    })
    let nextCalls = 0
    let resolveCalls = 0
    let rejectCalls = 0
    const promise = broker.handleQuestion({
      agent: { id: sessionId },
      signal: controller.signal,
      questions: [{ id: 'plan', question: 'Ship?', options: [{ label: 'yes' }] }],
    } as never, async () => {
      nextCalls += 1
      return { answers: [] }
    })
    const settled = promise.then(() => { resolveCalls += 1 }, () => { rejectCalls += 1 })
    await expect(promise).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    await settled
    expect(nextCalls).toBe(0)
    expect(resolveCalls).toBe(0)
    expect(rejectCalls).toBe(1)
    expect(broker.pending()).toEqual([])
  })

  it('settles a response even when final mux synchronization fails', async () => {
    const syncFailures: Error[] = []
    const store = testStore((_id, kind) => {
      if (kind === undefined) {
        const failure = new Error('final mux sync failed')
        syncFailures.push(failure)
        throw failure
      }
    })
    const frames: unknown[] = []
    const broker = new BuddyInteractionBroker(store as never, () => true, (frame) => frames.push(frame))
    const promise = broker.handleApproval({ agent: { id: sessionId }, toolName: 'bash' } as never, async () => 'rejected')
    const requested = frames[0] as { interaction: { requestId: string } }
    let thrown: unknown
    try {
      broker.respond({ requestId: requested.interaction.requestId, action: 'approval', outcome: 'allowed-once' })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors).toEqual([syncFailures[0]])
    await expect(promise).resolves.toBe('allowed-once')
    expect(broker.pending()).toEqual([])
  })

  it('attempts every delegated request when mux synchronization fails', async () => {
    let syncCalls = 0
    const store = testStore((_id, _kind) => {
      syncCalls += 1
      if (syncCalls > 2) throw new Error('mux sync failed ' + String(syncCalls))
    }, [sessionId, otherSessionId])
    const broker = new BuddyInteractionBroker(store as never, () => true, () => {})
    let approvalNextCalls = 0
    let questionNextCalls = 0
    const approval = broker.handleApproval({ agent: { id: sessionId }, toolName: 'bash' } as never, async () => {
      approvalNextCalls += 1
      return 'rejected'
    })
    const question = broker.handleQuestion({
      agent: { id: otherSessionId },
      questions: [{ id: 'plan', question: 'Ship?', options: [{ label: 'yes' }] }],
    } as never, async () => {
      questionNextCalls += 1
      return { answers: [{ id: 'plan', selected: ['yes'] }] }
    })
    let thrown: unknown
    try {
      broker.delegateAll()
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors).toHaveLength(2)
    await expect(approval).resolves.toBe('rejected')
    await expect(question).resolves.toEqual({ answers: [{ id: 'plan', selected: ['yes'] }] })
    expect(approvalNextCalls).toBe(1)
    expect(questionNextCalls).toBe(1)
    expect(broker.pending()).toEqual([])
  })

  it('attempts every session cancellation when cancellation publication fails', async () => {
    const store = testStore(undefined, [sessionId, otherSessionId])
    const broker = new BuddyInteractionBroker(store as never, () => true, (frame) => {
      if (frame.type === 'interaction-cancelled') throw new Error('cancellation publication failed')
    })
    const approval = broker.handleApproval({ agent: { id: sessionId }, toolName: 'bash' } as never, async () => 'rejected')
    const question = broker.handleQuestion({
      agent: { id: otherSessionId },
      questions: [{ id: 'plan', question: 'Ship?', options: [{ label: 'yes' }] }],
    } as never, async () => ({ answers: [] }))

    let thrown: unknown
    try {
      broker.sessionDisposed(sessionId)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors).toHaveLength(1)
    thrown = undefined
    try {
      broker.sessionDisposed(otherSessionId)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors).toHaveLength(1)
    await expect(approval).resolves.toBe('cancelled')
    await expect(question).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    expect(broker.pending()).toEqual([])
  })

  it('attempts every cancellation during dispose when mux synchronization fails', async () => {
    let syncCalls = 0
    const store = testStore((_id, _kind) => {
      syncCalls += 1
      if (syncCalls > 2) throw new Error('mux sync failed ' + String(syncCalls))
    }, [sessionId, otherSessionId])
    const broker = new BuddyInteractionBroker(store as never, () => true, () => {})
    const approval = broker.handleApproval({ agent: { id: sessionId }, toolName: 'bash' } as never, async () => 'rejected')
    const question = broker.handleQuestion({
      agent: { id: otherSessionId },
      questions: [{ id: 'plan', question: 'Ship?', options: [{ label: 'yes' }] }],
    } as never, async () => ({ answers: [] }))
    let thrown: unknown
    try {
      broker.dispose()
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors).toHaveLength(2)
    await expect(approval).resolves.toBe('cancelled')
    await expect(question).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    expect(broker.pending()).toEqual([])
  })

  it('attempts every cancellation publication during dispose', async () => {
    const store = testStore(undefined, [sessionId, otherSessionId])
    const broker = new BuddyInteractionBroker(store as never, () => true, (frame) => {
      if (frame.type === 'interaction-cancelled') throw new Error('cancellation publication failed')
    })
    const approval = broker.handleApproval({ agent: { id: sessionId }, toolName: 'bash' } as never, async () => 'rejected')
    const question = broker.handleQuestion({
      agent: { id: otherSessionId },
      questions: [{ id: 'plan', question: 'Ship?', options: [{ label: 'yes' }] }],
    } as never, async () => ({ answers: [] }))

    let thrown: unknown
    try {
      broker.dispose()
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors).toHaveLength(2)
    await expect(approval).resolves.toBe('cancelled')
    await expect(question).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    expect(broker.pending()).toEqual([])
  })

  it('settles each pending request once on dispose', async () => {
    const store = testStore(undefined, [sessionId, otherSessionId])
    const broker = new BuddyInteractionBroker(store as never, () => true, () => {})
    let nextCalls = 0
    let approvalResolves = 0
    let approvalRejects = 0
    let questionResolves = 0
    let questionRejects = 0
    const approval = broker.handleApproval({ agent: { id: sessionId }, toolName: 'bash' } as never, async () => {
      nextCalls += 1
      return 'rejected'
    })
    const question = broker.handleQuestion({
      agent: { id: otherSessionId },
      questions: [{ id: 'plan', question: 'Ship?', options: [{ label: 'yes' }] }],
    } as never, async () => {
      nextCalls += 1
      return { answers: [] }
    })
    void approval.then(() => { approvalResolves += 1 }, () => { approvalRejects += 1 })
    void question.then(() => { questionResolves += 1 }, () => { questionRejects += 1 })
    broker.dispose()
    broker.dispose()
    await expect(approval).resolves.toBe('cancelled')
    await expect(question).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    expect(nextCalls).toBe(0)
    expect(approvalResolves).toBe(1)
    expect(approvalRejects).toBe(0)
    expect(questionResolves).toBe(0)
    expect(questionRejects).toBe(1)
    expect(broker.pending()).toEqual([])
  })

  it('delegates every pending request through the kiosk failover API once', async () => {
    const store = testStore()
    const broker = new BuddyInteractionBroker(store as never, () => true, () => {})
    let nextCalls = 0
    const promise = broker.handleApproval({ agent: { id: sessionId }, toolName: 'bash' } as never, async () => {
      nextCalls += 1
      return 'rejected'
    })
    broker.delegateAll()
    broker.delegateAll()
    await expect(promise).resolves.toBe('rejected')
    expect(nextCalls).toBe(1)
    expect(broker.pending()).toEqual([])
  })

})

describe('parseInteractionResponse', () => {
  it('rejects unknown actions and unbounded request ids', () => {
    expect(() => parseInteractionResponse({ requestId: '', action: 'delegate' })).toThrow()
    expect(() => parseInteractionResponse({ requestId: 'r', action: 'unknown' })).toThrow()
  })
  it('bounds answer and selection counts', () => {
    expect(() => parseInteractionResponse({ requestId: 'r', action: 'question', answers: Array.from({ length: 33 }, () => ({ id: 'q', selected: [] })) })).toThrow(/bounded array/)
    expect(() => parseInteractionResponse({ requestId: 'r', action: 'question', answers: [{ id: 'q', selected: Array.from({ length: 65 }, (_item, index) => 'option-' + String(index)) }] })).toThrow(/selections are invalid/)
    expect(() => parseInteractionResponse({ requestId: 'r', action: 'question', answers: [{ id: 'q', selected: ['same', 'same'] }] })).toThrow(/selections are invalid/)
  })
})
