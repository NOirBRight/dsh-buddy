/** Shared host/kiosk/client contract for the sub-screen mascot. */

export const BUDDY_PAGE_PATH = '/buddy'
export const BUDDY_EVENTS_PATH = '/buddy/events'
export const BUDDY_CLIENT_EVENTS_PATH = '/buddy/client-events'
export const BUDDY_NAVIGATE_PATH = '/buddy/navigate'
/** HTTP endpoint for authenticated interaction responses. */
export const BUDDY_RESPOND_PATH = '/buddy/respond'
export const BUDDY_ASSET_PREFIX = '/buddy/assets'

/** Maximum UTF-16 code units allowed in a session identifier received over HTTP or SSE. */
export const MAX_SESSION_ID_LENGTH = 256

/** Fixed GUI EventSource retry interval in milliseconds. */
export const BUDDY_CLIENT_RECONNECT_INTERVAL_MS = 4_000

const SESSION_ID_CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/

/**
 * Return whether an untrusted wire value is safe to brand as a SessionId.
 * @param value - Candidate session identifier received from a wire event.
 * @returns Whether the candidate is nonempty, bounded, and free of control characters.
 */
export function isValidSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SESSION_ID_LENGTH && !SESSION_ID_CONTROL_CHARACTERS.test(value)
}

export type BuddyMood = 'needs-you' | 'error' | 'working' | 'done-unseen' | 'idle'

export type PendingKind = 'approval' | 'plan-review' | 'question'

export type SessionStatus = 'attention' | 'error' | 'running' | 'done' | 'idle'

export interface BuddySessionView {
  readonly id: string
  readonly title: string
  readonly status: SessionStatus
  readonly reason: string
  readonly pendingKind?: PendingKind
  readonly lastError?: string
  readonly updatedAt: number
}

export interface BuddyCounts {
  readonly attention: number
  readonly error: number
  readonly running: number
  readonly done: number
  readonly idle: number
}

export interface BuddySnapshot {
  readonly mood: BuddyMood
  readonly counts: BuddyCounts
  readonly sessions: readonly BuddySessionView[]
  readonly revision: number
}

/** One selectable option shown by a remote question. */
export interface BuddyQuestionOption {
  readonly label: string
  readonly description?: string
}

/** Wire-safe question details rendered by the Buddy kiosk. */
export interface BuddyQuestion {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly options?: readonly BuddyQuestionOption[]
  readonly multiSelect?: boolean
  readonly intent?: { readonly kind: string; readonly approve?: string }
}

/** Pending approval or user-question request shown by the Buddy kiosk. */
export type BuddyInteraction =
  | {
    readonly kind: 'approval'
    readonly requestId: string
    readonly sessionId: string
    readonly toolName: string
    readonly callId?: string
    readonly reason?: string
  }
  | {
    readonly kind: 'question' | 'plan-review'
    readonly requestId: string
    readonly sessionId: string
    readonly questions: readonly BuddyQuestion[]
  }

/** Server-sent frame delivered to the authenticated Buddy kiosk. */
export type BuddyKioskFrame =
  | { readonly type: 'snapshot'; readonly snapshot: BuddySnapshot }
  | { readonly type: 'interaction-requested'; readonly interaction: BuddyInteraction }
  | { readonly type: 'interaction-resolved'; readonly requestId: string }
  | { readonly type: 'interaction-cancelled'; readonly requestId: string }
  | { readonly type: 'navigate-ack'; readonly sessionId: string }

export type BuddyClientFrame =
  | { readonly type: 'hello' }
  | { readonly type: 'navigate'; readonly sessionId: string }
