/** Fold the Host durable log into Buddy's mood state. */

import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import type { PendingKind } from '../contract.ts'

// Session/title is published by dsh-session-title. The default case remains
// intentional because SessionEventMap is merge-extensible.
import type {} from '@deepseek-ai/dsh-session-title'

const MAX_TITLE_BYTES = 40

export interface FoldedSession {
  title: string
  blank: boolean
  pendingKind?: PendingKind
  lastError?: string
  completedUnseen: boolean
  updatedAt: number
}

export function emptyFold(createdAt = 0): FoldedSession {
  return {
    title: '',
    blank: true,
    completedUnseen: false,
    updatedAt: createdAt,
  }
}

/**
 * Fold one official session event into Buddy state.
 *
 * Buddy interprets only durable events that affect its title or mood. The
 * merge-extensible default advances recency without assuming a future event's
 * payload, so adding another package event cannot corrupt the projection.
 */
export function foldEvent(state: FoldedSession, event: SessionEvent): FoldedSession {
  const updatedAt = event.time

  switch (event.type) {
    case 'session/title': {
      const title = clip(event.data.title)
      return { ...state, title, blank: title === '' ? state.blank : false, updatedAt }
    }
    case 'user/message': {
      const message = event.data
      const title = state.title === '' && message.source.kind === 'user'
        ? firstUserText(message)
        : state.title
      return { ...state, blank: false, title, updatedAt }
    }
    case 'assistant/message':
    case 'tool/call':
      return { ...state, blank: false, updatedAt }
    case 'turn/start':
      return omit(state, ['lastError'], { blank: false, completedUnseen: false, updatedAt })
    case 'turn/end': {
      const reason = event.data.reason
      if (reason.kind === 'error') {
        return omit(state, ['pendingKind'], {
          lastError: errorMessage(reason.error.message),
          completedUnseen: false,
          updatedAt,
        })
      }
      if (reason.kind === 'completed') {
        return omit(state, ['pendingKind', 'lastError'], { completedUnseen: true, updatedAt })
      }
      return omit(state, ['pendingKind'], { completedUnseen: false, updatedAt })
    }
    default:
      return { ...state, updatedAt }
  }
}

export function foldEvents(events: readonly SessionEvent[], createdAt = 0): FoldedSession {
  let state = emptyFold(createdAt)
  for (const event of events) state = foldEvent(state, event)
  return state
}

function firstUserText(message: UserMessage): string {
  for (const part of message.content) {
    if (part.type === 'text') {
      const text = clip(part.text)
      if (text !== '') return text
    }
  }
  return ''
}

function errorMessage(message: string): string {
  const text = clip(message)
  return text === '' ? '出错' : text
}

function clip(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (Buffer.byteLength(cleaned, 'utf8') <= MAX_TITLE_BYTES) return cleaned
  const suffix = '…'
  const budget = MAX_TITLE_BYTES - Buffer.byteLength(suffix, 'utf8')
  let bytes = 0
  let clipped = ''
  for (const character of cleaned) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (bytes + characterBytes > budget) break
    clipped += character
    bytes += characterBytes
  }
  return clipped + suffix
}

function omit(
  state: FoldedSession,
  keys: readonly ('pendingKind' | 'lastError')[],
  extra: Partial<FoldedSession>,
): FoldedSession {
  const next: FoldedSession = { ...state, ...extra }
  for (const key of keys) delete next[key]
  return next
}
