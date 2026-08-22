/** Shared host/kiosk/client contract for the sub-screen mascot. */

export const BUDDY_PAGE_PATH = '/buddy'
export const BUDDY_EVENTS_PATH = '/buddy/events'
export const BUDDY_CLIENT_EVENTS_PATH = '/buddy/client-events'
export const BUDDY_NAVIGATE_PATH = '/buddy/navigate'
export const BUDDY_ASSET_PREFIX = '/buddy/assets'

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

export type BuddyKioskFrame =
  | { readonly type: 'snapshot'; readonly snapshot: BuddySnapshot }
  | { readonly type: 'navigate-ack'; readonly sessionId: string }

export type BuddyClientFrame =
  | { readonly type: 'hello' }
  | { readonly type: 'navigate'; readonly sessionId: string }
