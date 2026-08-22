import { describe, expect, it } from 'vitest'
import {
  applyMuxFrame,
  approvalResponse,
  parseServerRequest,
  pendingKey,
  questionResponse,
} from './mux.ts'

describe('mux pending', () => {
  it('parses approval requested/resolved frames', () => {
    const asked = parseServerRequest({
      type: 'server-request',
      rpcId: 'r1',
      method: 'approval/requested',
      payload: { type: 'approval/requested', sessionId: 's1', approvalId: 'a1', toolName: 'bash', reason: 'rm -rf' },
    })
    expect(asked).toBeDefined()
    let pending = applyMuxFrame(new Map(), asked!)
    expect([...pending.values()][0]).toMatchObject({ kind: 'approval', approvalId: 'a1', toolName: 'bash' })
    const resolved = parseServerRequest({
      type: 'server-request',
      rpcId: 'r2',
      method: 'approval/resolved',
      payload: { type: 'approval/resolved', sessionId: 's1', approvalId: 'a1', outcome: 'allowed-once' },
    })
    pending = applyMuxFrame(pending, resolved!)
    expect(pending.size).toBe(0)
  })

  it('parses plan-review questions and builds respond envelopes', () => {
    const asked = parseServerRequest({
      type: 'server-request',
      rpcId: 'q1',
      method: 'question/requested',
      payload: {
        type: 'question/requested',
        sessionId: 's1',
        questions: [{
          id: 'plan',
          question: 'Approve this plan?',
          options: [{ label: 'Yes' }, { label: 'No' }],
          intent: { kind: 'plan-review', approve: 'Yes' },
        }],
      },
    })
    const pending = applyMuxFrame(new Map(), asked!)
    const item = [...pending.values()][0]
    expect(item?.kind).toBe('plan-review')
    expect(pendingKey(item!)).toBe('q:q1')
    expect(questionResponse(item as never, [{ id: 'plan', selected: ['Yes'] }])).toMatchObject({
      type: 'client-response',
      rpcId: 'q1',
      result: { ok: true, value: { sessionId: 's1', answer: { answers: [{ id: 'plan', selected: ['Yes'] }] } } },
    })
    expect(approvalResponse({
      kind: 'approval',
      rpcId: 'r1',
      sessionId: 's1',
      approvalId: 'a1',
      toolName: 'bash',
    }, 'rejected').result.value.outcome).toBe('rejected')
  })
})
