export interface ServerRequestEnvelope {
  readonly type: 'server-request'
  readonly rpcId: string
  readonly method: string
  readonly payload: Record<string, unknown>
}

export interface ApprovalPending {
  readonly kind: 'approval'
  readonly rpcId: string
  readonly sessionId: string
  readonly approvalId: string
  readonly toolName: string
  readonly reason?: string
}

export interface QuestionPending {
  readonly kind: 'question' | 'plan-review'
  readonly rpcId: string
  readonly sessionId: string
  readonly questions: readonly QuestionItem[]
}

export interface QuestionItem {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly options?: readonly { readonly label: string; readonly description?: string }[]
  readonly multiSelect?: boolean
  readonly intent?: { readonly kind: string; readonly approve?: string }
}

export type MuxPending = ApprovalPending | QuestionPending

export function parseServerRequest(raw: unknown): ServerRequestEnvelope | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const value = raw as Record<string, unknown>
  if (value.type !== 'server-request') return undefined
  if (typeof value.rpcId !== 'string' || value.rpcId === '') return undefined
  if (typeof value.method !== 'string') return undefined
  if (typeof value.payload !== 'object' || value.payload === null || Array.isArray(value.payload)) return undefined
  return {
    type: 'server-request',
    rpcId: value.rpcId,
    method: value.method,
    payload: value.payload as Record<string, unknown>,
  }
}

export function pendingFromMux(envelope: ServerRequestEnvelope): MuxPending | undefined {
  const payload = envelope.payload
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : undefined
  if (sessionId === undefined) return undefined
  if (payload.type === 'approval/requested') {
    if (typeof payload.approvalId !== 'string' || typeof payload.toolName !== 'string') return undefined
    return {
      kind: 'approval',
      rpcId: envelope.rpcId,
      sessionId,
      approvalId: payload.approvalId,
      toolName: payload.toolName,
      ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
    }
  }
  if (payload.type === 'question/requested') {
    if (!Array.isArray(payload.questions) || payload.questions.length === 0) return undefined
    const questions = payload.questions.map(readQuestion).filter((item): item is QuestionItem => item !== undefined)
    if (questions.length === 0) return undefined
    const kind = questions.some((item) => item.intent?.kind === 'plan-review') ? 'plan-review' : 'question'
    return { kind, rpcId: envelope.rpcId, sessionId, questions }
  }
  return undefined
}

export function resolvedMuxKey(payload: Record<string, unknown>): string | undefined {
  if (payload.type === 'approval/resolved' && typeof payload.approvalId === 'string') return `a:${payload.approvalId}`
  if (payload.type === 'question/resolved' && typeof payload.questionRpcId === 'string') return `q:${payload.questionRpcId}`
  return undefined
}

export function pendingKey(pending: MuxPending): string {
  if (pending.kind === 'approval') return `a:${pending.approvalId}`
  return `q:${pending.rpcId}`
}

export function applyMuxFrame(
  pending: Map<string, MuxPending>,
  envelope: ServerRequestEnvelope,
): Map<string, MuxPending> {
  const next = new Map(pending)
  const requested = pendingFromMux(envelope)
  if (requested !== undefined) {
    next.set(pendingKey(requested), requested)
    return next
  }
  const resolved = resolvedMuxKey(envelope.payload)
  if (resolved !== undefined) next.delete(resolved)
  return next
}

export function approvalResponse(pending: ApprovalPending, outcome: 'allowed-once' | 'rejected') {
  return {
    type: 'client-response' as const,
    rpcId: pending.rpcId,
    result: {
      ok: true as const,
      value: {
        sessionId: pending.sessionId,
        approvalId: pending.approvalId,
        outcome,
      },
    },
  }
}

export function questionResponse(pending: QuestionPending, answers: readonly { id: string; selected: string[] }[]) {
  return {
    type: 'client-response' as const,
    rpcId: pending.rpcId,
    result: {
      ok: true as const,
      value: {
        sessionId: pending.sessionId,
        answer: { answers },
      },
    },
  }
}

function readQuestion(raw: unknown): QuestionItem | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const value = raw as Record<string, unknown>
  if (typeof value.id !== 'string' || typeof value.question !== 'string') return undefined
  const options = Array.isArray(value.options)
    ? value.options.flatMap((option) => {
      if (typeof option !== 'object' || option === null) return []
      const row = option as Record<string, unknown>
      if (typeof row.label !== 'string') return []
      return [{
        label: row.label,
        ...(typeof row.description === 'string' ? { description: row.description } : {}),
      }]
    })
    : undefined
  const intent = typeof value.intent === 'object' && value.intent !== null && !Array.isArray(value.intent)
    ? value.intent as Record<string, unknown>
    : undefined
  return {
    id: value.id,
    question: value.question,
    ...(typeof value.detail === 'string' ? { detail: value.detail } : {}),
    ...(typeof value.header === 'string' ? { header: value.header } : {}),
    ...(options !== undefined ? { options } : {}),
    ...(value.multiSelect === true ? { multiSelect: true } : {}),
    ...(typeof intent?.kind === 'string'
      ? { intent: { kind: intent.kind, ...(typeof intent.approve === 'string' ? { approve: intent.approve } : {}) } }
      : {}),
  }
}
