import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEventView } from './core/fold.ts'
import { BuddyStore, type HostAgentLike, type HostSessionLike } from './core/store.ts'
import { registerBuddyRoutes, type WebServerService } from './host/routes.ts'

export const name = 'dsh-buddy'
export const inject = ['sessions', 'agents', 'webServer']

export { BUDDY_PAGE_PATH, BUDDY_EVENTS_PATH, BUDDY_NAVIGATE_PATH } from './contract.ts'
export type { BuddySnapshot, BuddyMood, BuddySessionView } from './contract.ts'
export { buildSnapshot, classifyStatus, aggregateMood } from './core/buddy.ts'
export { BuddyStore } from './core/store.ts'

interface SessionLike extends HostSessionLike {
  readonly id: string
}

interface AgentLike extends HostAgentLike {
  readonly session?: SessionLike
}

interface SessionsService {
  list(): SessionLike[]
}

interface AgentsService {
  list(): AgentLike[]
  get?(id: string): AgentLike | undefined
}

interface WorkspaceRegistry {
  readonly archivedSessionIds: readonly string[]
}

interface Loader {
  await(): Promise<void>
}

function log(line: string): void {
  process.stderr.write(`[dsh-buddy] ${line}\n`)
}

function asEvent(event: unknown): SessionEventView {
  const value = event as { type?: unknown; seq?: unknown; time?: unknown; data?: unknown }
  return {
    type: typeof value.type === 'string' ? value.type : 'unknown',
    ...(typeof value.seq === 'number' ? { seq: value.seq } : {}),
    ...(typeof value.time === 'number' ? { time: value.time } : {}),
    data: typeof value.data === 'object' && value.data !== null && !Array.isArray(value.data)
      ? value.data as Record<string, unknown>
      : {},
  }
}

function pageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '..', 'page')
}

export function apply(ctx: Context): void {
  const store = new BuddyStore()
  const webServer = ctx.get('webServer') as WebServerService | undefined
  if (webServer === undefined) {
    log('FATAL webServer missing')
    return
  }

  registerBuddyRoutes(webServer, store, pageRoot(), (sessionId) => {
    store.markSeen(sessionId)
  })

  const on = ctx.on.bind(ctx) as unknown as (
    name: string,
    listener: (...args: never[]) => void,
    options?: { global?: boolean },
  ) => unknown

  on('session/created', ((session: SessionLike) => {
    try { store.onCreated(session) } catch (error) { log(`session/created failed: ${String(error)}`) }
  }) as never, { global: true })

  on('session/disposed', ((session: SessionLike) => {
    try { store.onDisposed(session.id) } catch (error) { log(`session/disposed failed: ${String(error)}`) }
  }) as never, { global: true })

  on('session/event', ((session: SessionLike, event: unknown) => {
    try { store.onEvent(session.id, asEvent(event), session.header) } catch (error) { log(`session/event failed: ${String(error)}`) }
  }) as never, { global: true })

  on('agent/status', ((payload: { agent: AgentLike; status: 'idle' | 'running' }) => {
    try {
      store.onAgentStatus(payload.agent.id, payload.status, payload.agent.session?.header)
    } catch (error) {
      log(`agent/status failed: ${String(error)}`)
    }
  }) as never, { global: true })

  seedFrom(ctx, store, 'immediate')
  void boot(ctx, store)
}

function seedFrom(ctx: Context, store: BuddyStore, reason: string): void {
  const sessions = ctx.get('sessions') as SessionsService | undefined
  const agents = ctx.get('agents') as AgentsService | undefined
  const workspace = ctx.get('workspaceRegistry') as WorkspaceRegistry | undefined
  if (sessions === undefined || agents === undefined) {
    log(`WARN ${reason}: sessions/agents missing`)
    return
  }
  try {
    const listed = sessions.list()
    store.seed(listed, agents.list(), workspace?.archivedSessionIds ?? [])
    const snap = store.snapshot()
    log(`${reason} seed listed=${listed.length} visible=${snap.sessions.length} mood=${snap.mood}`)
  } catch (error) {
    log(`${reason} seed failed: ${String(error)}`)
  }
}

async function boot(ctx: Context, store: BuddyStore): Promise<void> {
  try {
    await (ctx.get('loader') as Loader | undefined)?.await()
  } catch (error) {
    log(`WARN loader await failed: ${String(error)}`)
  }
  seedFrom(ctx, store, 'boot')
  ctx.effect(() => {
    const timer = setInterval(() => {
      try {
        const current = ctx.get('workspaceRegistry') as WorkspaceRegistry | undefined
        store.setArchived(current?.archivedSessionIds ?? [])
      } catch {
        // ignore a single poll failure
      }
    }, 4000)
    return () => { clearInterval(timer) }
  })
}
