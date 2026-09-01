import { randomUUID } from 'node:crypto'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionRequestEvent,
} from '@deepseek-ai/dsh-user-questions/types'
import type {
  BuddyInteraction,
  BuddyKioskFrame,
  BuddyQuestion,
} from '../contract.ts'
import type { BuddyStore } from './store.ts'

const DISPLAY_LIMIT = 8 * 1024
const MAX_QUESTIONS = 32
const MAX_QUESTION_OPTIONS = 64
const MAX_QUESTION_DISPLAY_BYTES = 64 * 1024
const MAX_ANSWER_SELECTIONS = 64
const MAX_PENDING = 1024

type ApprovalNext = () => Promise<ApprovalOutcome>
type QuestionNext = () => Promise<AskUserQuestionAnswer>
type InteractionFrame = Extract<
  BuddyKioskFrame,
  { readonly type: 'interaction-requested' | 'interaction-resolved' | 'interaction-cancelled' }
>
type InteractionPublisher = (frame: InteractionFrame) => void

/** JSON response accepted by the authenticated Buddy interaction endpoint. */
export type InteractionResponse =
  | { readonly requestId: string; readonly action: 'approval'; readonly outcome: 'allowed-once' | 'rejected' }
  | { readonly requestId: string; readonly action: 'question'; readonly answers: readonly AskUserQuestionAnswerItem[] }
  | { readonly requestId: string; readonly action: 'delegate' }

/** Result of applying an interaction response to pending state. */
export type InteractionResponseResult = 'accepted' | 'unknown'

interface PendingEntry {
  readonly requestId: string
  readonly sessionId: SessionId
  readonly interaction: BuddyInteraction
  readonly kind: 'approval' | 'question' | 'plan-review'
  readonly next: (() => Promise<unknown>)
  readonly resolve: (value: unknown) => void
  readonly reject: (reason: unknown) => void
  readonly cancelValue: unknown
  readonly signal?: AbortSignal
  onAbort?: () => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: string, limit = DISPLAY_LIMIT): string {
  return value.length > limit ? value.slice(0, limit) : value
}

function abortError(): Error & { code: string } {
  const error = new Error('Buddy interaction was cancelled') as Error & { code: string }
  error.code = 'ASK_ABORTED'
  return error
}

function appendFailures(target: unknown[], error: unknown): void {
  if (error instanceof AggregateError) {
    for (const nested of error.errors) appendFailures(target, nested)
    return
  }
  target.push(error)
}

function parseRequestId(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.length > 256) throw new Error('requestId must be a bounded string')
  return value
}

function parseAnswerItem(value: unknown): AskUserQuestionAnswerItem {
  if (!isRecord(value)) throw new Error('question answer must be an object')
  const keys = Object.keys(value)
  if (keys.some((key) => key !== 'id' && key !== 'selected' && key !== 'custom')) throw new Error('question answer contains unknown fields')
  const id = value.id
  const selected = value.selected
  if (typeof id !== 'string' || id === '' || id.length > 256) throw new Error('question answer id is invalid')
  if (!Array.isArray(selected) || selected.length > MAX_ANSWER_SELECTIONS || selected.some((item) => typeof item !== 'string' || item.length === 0 || item.length > DISPLAY_LIMIT) || new Set(selected).size !== selected.length) throw new Error('question answer selections are invalid')
  const custom = value.custom
  if (custom !== undefined && (typeof custom !== 'string' || custom.length > DISPLAY_LIMIT)) throw new Error('question custom answer is invalid')
  return { id, selected, ...(custom === undefined ? {} : { custom }) }
}

/**
 * Parse one bounded response from the authenticated Buddy page.
 * @param raw - JSON value received from the response endpoint.
 * @returns the validated response fields.
 */
export function parseInteractionResponse(raw: unknown): InteractionResponse {
  if (!isRecord(raw)) throw new Error('interaction response must be an object')
  const requestId = parseRequestId(raw.requestId)
  const action = raw.action
  if (action === 'delegate') {
    if (Object.keys(raw).some((key) => key !== 'requestId' && key !== 'action')) throw new Error('delegate response contains unknown fields')
    return { requestId, action }
  }
  if (action === 'approval') {
    if (Object.keys(raw).some((key) => key !== 'requestId' && key !== 'action' && key !== 'outcome')) throw new Error('approval response contains unknown fields')
    if (raw.outcome !== 'allowed-once' && raw.outcome !== 'rejected') throw new Error('approval outcome is invalid')
    return { requestId, action, outcome: raw.outcome }
  }
  if (action === 'question') {
    if (Object.keys(raw).some((key) => key !== 'requestId' && key !== 'action' && key !== 'answers')) throw new Error('question response contains unknown fields')
    if (!Array.isArray(raw.answers) || raw.answers.length > MAX_QUESTIONS) throw new Error('question answers must be a bounded array')
    return { requestId, action, answers: raw.answers.map(parseAnswerItem) }
  }
  throw new Error('interaction action is invalid')
}

function questionWire(question: AskUserQuestionRequestEvent['questions'][number]): BuddyQuestion {
  if (question.id.length === 0 || question.id.length > 256) throw new Error('question id must be a bounded string')
  const options = question.options?.map((option) => ({
    label: text(option.label),
    ...(option.description === undefined ? {} : { description: text(option.description) }),
  }))
  const intent = question.intent
  return {
    id: question.id,
    question: text(question.question),
    ...(question.detail === undefined ? {} : { detail: text(question.detail) }),
    ...(question.header === undefined ? {} : { header: text(question.header, 256) }),
    ...(options === undefined ? {} : { options }),
    ...(question.multiSelect === true ? { multiSelect: true } : {}),
    ...(intent === undefined ? {} : { intent: { kind: text(intent.kind, 256), approve: text(intent.approve) } }),
  }
}

/**
 * Answerer bridge that exposes official approval and question waterfalls to the
 * authenticated Buddy page and resolves them with validated responses.
 */
export class BuddyInteractionBroker {
  readonly #store: BuddyStore
  readonly #canOffer: () => boolean
  readonly #publish: InteractionPublisher
  readonly #pending = new Map<string, PendingEntry>()
  #disposed = false

  constructor(
    store: BuddyStore,
    canOffer: () => boolean,
    publish: InteractionPublisher,
  ) {
    this.#store = store
    this.#canOffer = canOffer
    this.#publish = publish
  }

  /** Return pending interactions for a newly connected Buddy page. */
  pending(): readonly BuddyInteraction[] {
    return [...this.#pending.values()].map((entry) => entry.interaction)
  }

  /** Handle an official approval waterfall request. */
  handleApproval(request: ApprovalRequestEvent, next: ApprovalNext): Promise<ApprovalOutcome> {
    const sessionId = request.agent.id
    if (this.#disposed || !this.#canOffer() || !this.#store.hasSession(String(sessionId)) || request.signal?.aborted) return next()
    const requestId = 'buddy-' + randomUUID()
    const interaction: BuddyInteraction = {
      kind: 'approval',
      requestId,
      sessionId: String(sessionId),
      toolName: text(request.toolName),
      ...(request.callId === undefined ? {} : { callId: String(request.callId) }),
      ...(request.reason === undefined ? {} : { reason: text(request.reason) }),
    }
    return new Promise<ApprovalOutcome>((resolve, reject) => {
      const entry: PendingEntry = {
        requestId,
        sessionId,
        interaction,
        kind: 'approval',
        next,
        resolve: (value) => resolve(value as ApprovalOutcome),
        reject,
        cancelValue: 'cancelled',
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }
      if (!this.#add(entry)) {
        void Promise.resolve().then(next).then(resolve, reject)
      }
    })
  }

  /** Handle an official user-question waterfall request. */
  handleQuestion(request: AskUserQuestionRequestEvent, next: QuestionNext): Promise<AskUserQuestionAnswer> {
    const agent = request.agent
    if (this.#disposed || agent === undefined || !this.#canOffer() || !this.#store.hasSession(String(agent.id)) || request.signal?.aborted || request.questions.length === 0 || request.questions.length > MAX_QUESTIONS || request.questions.some((question) => question.options === undefined || question.options.length === 0 || question.options.length > MAX_QUESTION_OPTIONS)) return next()
    const ids = new Set<string>()
    const questions: BuddyQuestion[] = []
    let displayBytes = 0
    for (const question of request.questions) {
      if (ids.has(question.id)) throw new Error('question ids must be unique')
      ids.add(question.id)
      const wire = questionWire(question)
      displayBytes += Buffer.byteLength(JSON.stringify(wire), 'utf8')
      if (displayBytes > MAX_QUESTION_DISPLAY_BYTES) return next()
      questions.push(wire)
    }
    const kind = questions.some((question) => question.intent?.kind === 'plan-review') ? 'plan-review' : 'question'
    const requestId = 'buddy-' + randomUUID()
    const interaction: BuddyInteraction = { kind, requestId, sessionId: String(agent.id), questions }
    return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      const entry: PendingEntry = {
        requestId,
        sessionId: agent.id,
        interaction,
        kind,
        next,
        resolve: (value) => resolve(value as AskUserQuestionAnswer),
        reject,
        cancelValue: abortError(),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }
      if (!this.#add(entry)) {
        void Promise.resolve().then(next).then(resolve, reject)
      }
    })
  }

  /**
   * Apply one authenticated page response to the matching pending request.
   * @param raw - response JSON received from the Buddy page.
   * @returns whether a pending interaction accepted the response.
   */
  respond(raw: unknown): InteractionResponseResult {
    const response = parseInteractionResponse(raw)
    const entry = this.#pending.get(response.requestId)
    if (entry === undefined) return 'unknown'
    if (response.action === 'delegate') {
      const result = this.#delegate(entry)
      if (result.failures.length > 0) throw new AggregateError(result.failures, 'Buddy interaction delegation cleanup failed')
      return 'accepted'
    }
    if (response.action === 'approval') {
      if (entry.kind !== 'approval') throw new Error('response kind does not match request')
      const result = this.#finish(entry, 'interaction-resolved')
      entry.resolve(response.outcome)
      if (result.failures.length > 0) throw new AggregateError(result.failures, 'Buddy interaction response cleanup failed')
      return 'accepted'
    }
    if (entry.kind !== 'question' && entry.kind !== 'plan-review') throw new Error('response kind does not match request')
    const answers = validateAnswers(entry.interaction, response.answers)
    const result = this.#finish(entry, 'interaction-resolved')
    entry.resolve({ answers })
    if (result.failures.length > 0) throw new AggregateError(result.failures, 'Buddy interaction response cleanup failed')
    return 'accepted'
  }

  /** Cancel every owned waterfall on plugin teardown; settle all entries before throwing cleanup failures. */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    const failures: unknown[] = []
    for (const entry of [...this.#pending.values()]) {
      try {
        failures.push(...this.#cancel(entry))
      } catch (error) {
        appendFailures(failures, error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Buddy interaction disposal failed')
  }

  /** Cancel every pending interaction owned by a session that is being disposed. */
  sessionDisposed(sessionId: SessionId): void {
    const failures: unknown[] = []
    for (const entry of [...this.#pending.values()]) {
      if (String(entry.sessionId) !== String(sessionId)) continue
      try {
        failures.push(...this.#cancel(entry))
      } catch (error) {
        appendFailures(failures, error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Buddy session interaction cancellation failed')
  }

  #add(entry: PendingEntry): boolean {
    if (this.#disposed || this.#pending.size >= MAX_PENDING || [...this.#pending.values()].some((candidate) => String(candidate.sessionId) === String(entry.sessionId))) return false
    this.#pending.set(entry.requestId, entry)
    try {
      this.#sync(entry.sessionId)
    } catch (syncError) {
      const failures: unknown[] = [syncError]
      try {
        this.#sync(entry.sessionId, null)
      } catch (rollbackError) {
        appendFailures(failures, rollbackError)
      }
      this.#pending.delete(entry.requestId)
      if (failures.length > 1) throw new AggregateError(failures, 'Buddy interaction insertion rollback failed', { cause: syncError })
      return false
    }
    const onAbort = (): void => {
      const failures = this.#cancel(entry)
      if (failures.length > 0) throw new AggregateError(failures, 'Buddy interaction cancellation failed')
    }
    entry.onAbort = onAbort
    try {
      entry.signal?.addEventListener('abort', onAbort, { once: true })
    } catch (error) {
      const result = this.#detach(entry)
      const failures: unknown[] = [error]
      for (const failure of result.failures) appendFailures(failures, failure)
      throw new AggregateError(failures, 'Buddy interaction abort listener setup failed', { cause: error })
    }
    if (entry.signal?.aborted) {
      const failures = this.#cancel(entry)
      if (failures.length > 0) throw new AggregateError(failures, 'Buddy interaction cancellation failed')
      return true
    }
    try {
      this.#publish({ type: 'interaction-requested', interaction: entry.interaction })
      return true
    } catch (publishError) {
      const result = this.#detach(entry)
      if (result.failures.length > 0) {
        const failures: unknown[] = [publishError]
        for (const failure of result.failures) appendFailures(failures, failure)
        throw new AggregateError(failures, 'Buddy interaction publication cleanup failed', { cause: publishError })
      }
      return !result.removed
    }
  }

  #detach(entry: PendingEntry): { removed: boolean; failures: unknown[] } {
    if (this.#pending.get(entry.requestId) !== entry) return { removed: false, failures: [] }
    this.#pending.delete(entry.requestId)
    const failures: unknown[] = []
    const remaining = [...this.#pending.values()].find((candidate) => candidate.sessionId === entry.sessionId) ?? null
    try {
      this.#sync(entry.sessionId, remaining)
    } catch (error) {
      appendFailures(failures, error)
    }
    if (entry.signal !== undefined && entry.onAbort !== undefined) {
      try {
        entry.signal.removeEventListener('abort', entry.onAbort)
      } catch (error) {
        appendFailures(failures, error)
      }
    }
    return { removed: true, failures }
  }

  #finish(entry: PendingEntry, type: 'interaction-resolved' | 'interaction-cancelled'): { removed: boolean; failures: unknown[] } {
    const result = this.#detach(entry)
    if (!result.removed) return result
    try { this.#publish({ type, requestId: entry.requestId }) } catch (error) { appendFailures(result.failures, error) }
    return result
  }

  #cancel(entry: PendingEntry): unknown[] {
    const result = this.#finish(entry, 'interaction-cancelled')
    if (!result.removed) return result.failures
    if (entry.kind === 'approval') entry.resolve(entry.cancelValue)
    else entry.reject(entry.cancelValue)
    return result.failures
  }

  #delegate(entry: PendingEntry): { failures: unknown[]; removed: boolean } {
    const result = this.#finish(entry, 'interaction-cancelled')
    if (!result.removed) return result
    void Promise.resolve().then(entry.next).then(entry.resolve, entry.reject)
    return result
  }

  /** Delegate every unresolved waterfall; attempt every entry before throwing cleanup failures. */
  delegateAll(): void {
    if (this.#disposed) return
    const failures: unknown[] = []
    for (const entry of [...this.#pending.values()]) {
      try {
        failures.push(...this.#delegate(entry).failures)
      } catch (error) {
        appendFailures(failures, error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Buddy interaction delegation failed')
  }

  /**
   * Delegate pending interactions when no authenticated kiosk remains connected.
   * @param available - true when at least one authenticated kiosk is connected.
   */
  kioskAvailabilityChanged(available: boolean): void {
    if (available) return
    this.delegateAll()
  }

  #sync(sessionId: SessionId, remaining?: PendingEntry | null): void {
    const entry = remaining === undefined
      ? [...this.#pending.values()].find((candidate) => candidate.sessionId === sessionId)
      : remaining
    this.#store.setMuxPending(sessionId, entry?.kind)
  }
}

function validateAnswers(interaction: BuddyInteraction, answers: readonly AskUserQuestionAnswerItem[]): AskUserQuestionAnswerItem[] {
  if (interaction.kind === 'approval') throw new Error('approval interaction does not accept question answers')
  if (answers.length !== interaction.questions.length) throw new Error('question answer count does not match request')
  const questions = new Map(interaction.questions.map((question) => [question.id, question]))
  const seen = new Set<string>()
  for (const answer of answers) {
    if (seen.has(answer.id)) throw new Error('question answer ids must be unique')
    seen.add(answer.id)
    const question = questions.get(answer.id)
    if (question === undefined) throw new Error('question answer id is not in request')
    if (!question.multiSelect && answer.selected.length > 1) throw new Error('single-select question has multiple selections')
    const labels = new Set(question.options?.map((option) => option.label) ?? [])
    if (answer.selected.some((label) => !labels.has(label))) throw new Error('question answer contains an unknown option')
  }
  return answers.map((answer) => ({ ...answer, selected: [...answer.selected] }))
}
