import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import type { BuddySnapshot, PendingKind } from '../contract.ts'
import { buildSnapshot, type BuddySession } from './buddy.ts'
import { emptyFold, foldEvent, foldEvents } from './fold.ts'

export type HostSession = Pick<Session, 'id' | 'header' | 'events'>
export type HostAgent = Agent

export class BuddyStore {
  readonly #sessions = new Map<string, BuddySession>()
  readonly #archived = new Set<string>()
  #revision = 0
  readonly #listeners = new Set<(snapshot: BuddySnapshot) => void>()

  snapshot(): BuddySnapshot {
    const visible = [...this.#sessions.values()].filter((session) => !this.#archived.has(String(session.id)))
    return buildSnapshot(visible, this.#revision)
  }

  subscribe(listener: (snapshot: BuddySnapshot) => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  seed(sessions: readonly HostSession[], agents: readonly HostAgent[], archivedIds: readonly SessionId[] = []): void {
    const running = new Set(agents.filter((agent) => agent.status === 'running').map((agent) => String(agent.id)))
    const nextSessions = new Map<string, BuddySession>()
    const nextArchived = new Set(archivedIds.map((id) => String(id)))

    for (const session of sessions) {
      const folded = foldEvents(session.events, session.header.createdAt)
      nextSessions.set(String(session.id), projectSession(session, folded, running.has(String(session.id))))
    }

    this.#sessions.clear()
    for (const [id, session] of nextSessions) this.#sessions.set(id, session)
    this.#archived.clear()
    for (const id of nextArchived) this.#archived.add(id)
    this.#bump()
  }

  setArchived(ids: readonly SessionId[]): void {
    const next = new Set(ids.map((id) => String(id)))
    if (next.size === this.#archived.size && [...next].every((id) => this.#archived.has(id))) return
    this.#archived.clear()
    for (const id of next) this.#archived.add(id)
    this.#bump()
  }

  onCreated(session: HostSession): void {
    const folded = foldEvents(session.events, session.header.createdAt)
    this.#sessions.set(String(session.id), projectSession(session, folded, false))
    this.#bump()
  }

  onDisposed(id: SessionId): void {
    const key = String(id)
    if (!this.#sessions.delete(key)) return
    this.#archived.delete(key)
    this.#bump()
  }

  onEvent(sessionId: SessionId, event: SessionEvent, _header?: SessionHeader): void {
    const key = String(sessionId)
    const current = this.#sessions.get(key)
    if (current === undefined) return
    const base = current
    const folded = foldEvent({
      title: base.title,
      blank: base.blank,
      ...optionalPending(base.pendingKind),
      ...optionalError(base.lastError),
      completedUnseen: base.completedUnseen,
      updatedAt: base.updatedAt,
    }, event)
    this.#sessions.set(key, {
      id: base.id,
      title: folded.title,
      ...(base.origin !== undefined ? { origin: base.origin } : {}),
      ...(base.cwd !== undefined ? { cwd: base.cwd } : {}),
      blank: folded.blank,
      running: base.running,
      ...optionalPending(folded.pendingKind),
      ...optionalError(folded.lastError),
      completedUnseen: folded.completedUnseen,
      updatedAt: folded.updatedAt,
    })
    this.#bump()
  }

  onAgentStatus(sessionId: SessionId, status: AgentStatus, _header?: SessionHeader): void {
    const key = String(sessionId)
    const current = this.#sessions.get(key)
    if (current === undefined) return
    const running = status === 'running'
    this.#sessions.set(key, {
      ...current,
      running,
      completedUnseen: running ? false : current.completedUnseen,
      updatedAt: Date.now(),
    })
    this.#bump()
  }

  setMuxPending(sessionId: SessionId, pendingKind: PendingKind | undefined): void {
    const key = String(sessionId)
    const current = this.#sessions.get(key)
    if (current === undefined) return
    const hasPendingKind = Object.prototype.hasOwnProperty.call(current, 'pendingKind')
    if (pendingKind === undefined ? !hasPendingKind : current.pendingKind === pendingKind) return
    const next = { ...current, updatedAt: Date.now() }
    if (pendingKind === undefined) delete next.pendingKind
    else next.pendingKind = pendingKind
    this.#sessions.set(key, next)
    this.#bump()
  }

  hasSession(sessionId: string): boolean {
    return this.#sessions.has(sessionId)
  }

  markSeen(sessionId: SessionId): void {
    const key = String(sessionId)
    const current = this.#sessions.get(key)
    if (current === undefined || !current.completedUnseen) return
    this.#sessions.set(key, { ...current, completedUnseen: false })
    this.#bump()
  }

  #bump(): void {
    this.#revision += 1
    const snapshot = this.snapshot()
    const failures: unknown[] = []
    for (const listener of [...this.#listeners]) {
      try {
        listener(snapshot)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Buddy store subscriber notification failed')
  }
}

function projectSession(session: HostSession, folded: ReturnType<typeof emptyFold>, running: boolean): BuddySession {
  return {
    id: session.id,
    title: folded.title,
    ...(session.header.origin !== undefined ? { origin: session.header.origin } : {}),
    ...(session.header.cwd !== undefined ? { cwd: session.header.cwd } : {}),
    blank: folded.blank,
    running,
    ...optionalPending(folded.pendingKind),
    ...optionalError(folded.lastError),
    completedUnseen: folded.completedUnseen,
    updatedAt: folded.updatedAt,
  }
}

function optionalPending(pendingKind: PendingKind | undefined): { pendingKind: PendingKind } | Record<string, never> {
  return pendingKind !== undefined ? { pendingKind } : {}
}

function optionalError(lastError: string | undefined): { lastError: string } | Record<string, never> {
  return lastError !== undefined ? { lastError } : {}
}
