import type { PendingKind } from '../contract.ts'

export interface SessionEventView {
  readonly type: string
  readonly seq?: number
  readonly time?: number
  readonly data: Record<string, unknown>
}

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

export function foldEvent(state: FoldedSession, event: SessionEventView): FoldedSession {
  const updatedAt = typeof event.time === 'number' ? event.time : state.updatedAt
  if (event.type === 'session/title') {
    const title = typeof event.data.title === 'string' ? event.data.title.trim() : ''
    return { ...state, title, blank: title === '' ? state.blank : false, updatedAt }
  }
  if (event.type === 'user/message') {
    const nextTitle = state.title !== '' ? state.title : firstUserText(event.data)
    return { ...state, blank: false, title: nextTitle, updatedAt }
  }
  if (event.type === 'assistant/message' || event.type === 'tool/call') {
    return { ...state, blank: false, updatedAt }
  }
  if (event.type === 'approval/asked') {
    return { ...state, blank: false, pendingKind: 'approval', completedUnseen: false, updatedAt }
  }
  if (event.type === 'approval/decided') {
    return omit(state, ['pendingKind'], { updatedAt })
  }
  if (event.type === 'turn/start') {
    return omit(state, ['lastError'], { blank: false, completedUnseen: false, updatedAt })
  }
  if (event.type === 'turn/end') {
    const reason = isObject(event.data.reason) ? event.data.reason : undefined
    const kind = typeof reason?.kind === 'string' ? reason.kind : undefined
    if (kind === 'error') {
      return omit(state, ['pendingKind'], {
        lastError: errorMessage(reason ?? {}),
        completedUnseen: false,
        updatedAt,
      })
    }
    if (kind === 'completed') {
      return omit(state, ['pendingKind', 'lastError'], { completedUnseen: true, updatedAt })
    }
    return omit(state, ['pendingKind'], { completedUnseen: false, updatedAt })
  }
  return { ...state, updatedAt }
}

export function foldEvents(events: readonly SessionEventView[], createdAt = 0): FoldedSession {
  let state = emptyFold(createdAt)
  for (const event of events) state = foldEvent(state, event)
  return state
}

function firstUserText(data: Record<string, unknown>): string {
  const content = data.content
  if (!Array.isArray(content)) {
    return typeof data.text === 'string' ? clip(data.text) : ''
  }
  for (const part of content) {
    if (!isObject(part)) continue
    if (part.type === 'text' && typeof part.text === 'string') {
      const text = clip(part.text)
      if (text !== '') return text
    }
  }
  return ''
}

function errorMessage(reason: Record<string, unknown>): string {
  const error = isObject(reason.error) ? reason.error : undefined
  if (typeof error?.message === 'string' && error.message.trim() !== '') return clip(error.message)
  return '出错'
}

function clip(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= 40) return cleaned
  return `${cleaned.slice(0, 39)}…`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
