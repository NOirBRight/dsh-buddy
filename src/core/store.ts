import type { BuddySnapshot, PendingKind } from '../contract.ts'
import { buildSnapshot, type BuddySession } from './buddy.ts'
import { emptyFold, foldEvent, foldEvents, type SessionEventView } from './fold.ts'

export interface HostSessionLike {
  readonly id: string
  readonly header: {
    readonly cwd?: string
    readonly origin?: 'subagent'
    readonly createdAt?: number
  }
  readonly events: readonly SessionEventView[]
}

export interface HostAgentLike {
  readonly id: string
  readonly status: 'idle' | 'running'
}

export class BuddyStore {
  readonly #sessions = new Map<string, BuddySession>()
  readonly #archived = new Set<string>()
  #revision = 0
  readonly #listeners = new Set<(snapshot: BuddySnapshot) => void>()

  snapshot(): BuddySnapshot {
    return buildSnapshot([...this.#sessions.values()].filter((session) => !this.#archived.has(session.id)), this.#revision)
  }

  subscribe(listener: (snapshot: BuddySnapshot) => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  seed(sessions: readonly HostSessionLike[], agents: readonly HostAgentLike[], archivedIds: readonly string[] = []): void {
    this.#sessions.clear()
    this.#archived.clear()
    for (const id of archivedIds) this.#archived.add(id)
    const running = new Set(agents.filter((agent) => agent.status === 'running').map((agent) => agent.id))
    for (const session of sessions) {
      const folded = foldEvents(session.events, session.header.createdAt ?? 0)
      this.#sessions.set(session.id, {
        id: session.id,
        title: folded.title,
        ...(session.header.origin === 'subagent' ? { origin: 'subagent' as const } : {}),
        ...(session.header.cwd !== undefined ? { cwd: session.header.cwd } : {}),
        blank: folded.blank,
        running: running.has(session.id),
        ...optionalPending(folded.pendingKind),
        ...optionalError(folded.lastError),
        completedUnseen: folded.completedUnseen && !running.has(session.id),
        updatedAt: folded.updatedAt,
      })
    }
    this.#bump()
  }

  setArchived(ids: readonly string[]): void {
    const next = new Set(ids)
    if (next.size === this.#archived.size && [...next].every((id) => this.#archived.has(id))) return
    this.#archived.clear()
    for (const id of ids) this.#archived.add(id)
    this.#bump()
  }

  onCreated(session: HostSessionLike): void {
    const folded = foldEvents(session.events, session.header.createdAt ?? 0)
    this.#sessions.set(session.id, {
      id: session.id,
      title: folded.title,
      ...(session.header.origin === 'subagent' ? { origin: 'subagent' as const } : {}),
      ...(session.header.cwd !== undefined ? { cwd: session.header.cwd } : {}),
      blank: folded.blank,
      running: false,
      completedUnseen: false,
      updatedAt: folded.updatedAt,
    })
    this.#bump()
  }

  onDisposed(id: string): void {
    if (!this.#sessions.delete(id)) return
    this.#archived.delete(id)
    this.#bump()
  }

  onEvent(sessionId: string, event: SessionEventView, header?: HostSessionLike['header']): void {
    const current = this.#sessions.get(sessionId) ?? this.#blank(sessionId, header)
    const folded = foldEvent({
      title: current.title,
      blank: current.blank,
      ...optionalPending(current.pendingKind),
      ...optionalError(current.lastError),
      completedUnseen: current.completedUnseen,
      updatedAt: current.updatedAt,
    }, event)
    this.#sessions.set(sessionId, {
      id: current.id,
      title: folded.title,
      ...(current.origin !== undefined ? { origin: current.origin } : {}),
      ...(current.cwd !== undefined ? { cwd: current.cwd } : {}),
      blank: folded.blank,
      running: current.running,
      ...optionalPending(folded.pendingKind),
      ...optionalError(folded.lastError),
      completedUnseen: current.running ? false : folded.completedUnseen,
      updatedAt: folded.updatedAt,
    })
    this.#bump()
  }

  onAgentStatus(sessionId: string, status: 'idle' | 'running', header?: HostSessionLike['header']): void {
    const current = this.#sessions.get(sessionId) ?? this.#blank(sessionId, header)
    const running = status === 'running'
    this.#sessions.set(sessionId, {
      ...current,
      running,
      completedUnseen: running ? false : current.completedUnseen,
      updatedAt: Date.now(),
    })
    this.#bump()
  }

  setMuxPending(sessionId: string, pendingKind: PendingKind | undefined): void {
    const current = this.#sessions.get(sessionId)
    if (current === undefined) return
    if (current.pendingKind === pendingKind) return
    this.#sessions.set(sessionId, {
      id: current.id,
      title: current.title,
      ...(current.origin !== undefined ? { origin: current.origin } : {}),
      ...(current.cwd !== undefined ? { cwd: current.cwd } : {}),
      blank: current.blank,
      running: current.running,
      ...optionalPending(pendingKind),
      ...optionalError(current.lastError),
      completedUnseen: current.completedUnseen,
      updatedAt: Date.now(),
    })
    this.#bump()
  }

  markSeen(sessionId: string): void {
    const current = this.#sessions.get(sessionId)
    if (current === undefined || !current.completedUnseen) return
    this.#sessions.set(sessionId, { ...current, completedUnseen: false })
    this.#bump()
  }

  #blank(id: string, header?: HostSessionLike['header']): BuddySession {
    const created = emptyFold(header?.createdAt ?? Date.now())
    const session: BuddySession = {
      id,
      title: created.title,
      ...(header?.origin === 'subagent' ? { origin: 'subagent' as const } : {}),
      ...(header?.cwd !== undefined ? { cwd: header.cwd } : {}),
      blank: true,
      running: false,
      completedUnseen: false,
      updatedAt: created.updatedAt,
    }
    this.#sessions.set(id, session)
    return session
  }

  #bump(): void {
    this.#revision += 1
    const snapshot = this.snapshot()
    for (const listener of this.#listeners) listener(snapshot)
  }
}

function optionalPending(pendingKind: PendingKind | undefined): { pendingKind: PendingKind } | Record<string, never> {
  return pendingKind !== undefined ? { pendingKind } : {}
}

function optionalError(lastError: string | undefined): { lastError: string } | Record<string, never> {
  return lastError !== undefined ? { lastError } : {}
}
