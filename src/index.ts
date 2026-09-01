import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import type { AskUserQuestionRequestEvent } from '@deepseek-ai/dsh-user-questions/types'
import type {} from '@deepseek-ai/dsh-session-title'

import { BuddyInteractionBroker } from './core/interactions.ts'
import { BuddyStore } from './core/store.ts'
import { registerBuddyRoutes } from './host/routes.ts'

export const name = 'dsh-buddy'
export const inject = ['webServer', 'connection', 'sessions', 'agents', 'workspaceRegistry']

export { BUDDY_PAGE_PATH, BUDDY_EVENTS_PATH, BUDDY_NAVIGATE_PATH, BUDDY_RESPOND_PATH, BUDDY_CLIENT_EVENTS_PATH, BUDDY_ASSET_PREFIX } from './contract.ts'
export type { BuddyInteraction, BuddyKioskFrame, BuddyQuestion, BuddySnapshot, BuddyMood, BuddySessionView } from './contract.ts'
export { buildSnapshot, classifyStatus, aggregateMood } from './core/buddy.ts'
export { BuddyStore } from './core/store.ts'
export type { BuddyHub } from './host/routes.ts'

const MAX_ARCHIVE_POLL_MS = 2_147_483_647

/** Configuration for archive refreshes and the Buddy browser origin. */
export interface Config {
  archivePollMs: number
  publicBaseUrl: string
}

/** Schema for validating Buddy configuration. */
export const Config: z<Config> = z.object({
  archivePollMs: z.natural().min(1).max(MAX_ARCHIVE_POLL_MS).default(4000),
  publicBaseUrl: z.string().default(''),
})

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1'
}

function validatePublicBaseUrl(raw: string): URL | undefined {
  if (raw === '') return undefined
  if (raw.includes('?')) {
    throw new Error('dsh-buddy: Config.publicBaseUrl must not contain a query')
  }
  if (raw.includes('#')) {
    throw new Error('dsh-buddy: Config.publicBaseUrl must not contain a hash')
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch (_error) {
    throw new Error('dsh-buddy: Config.publicBaseUrl must be an absolute URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('dsh-buddy: Config.publicBaseUrl must be http or https')
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('dsh-buddy: Config.publicBaseUrl must not contain credentials')
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error('dsh-buddy: Config.publicBaseUrl must not contain query or hash')
  }
  if (raw !== url.origin) {
    throw new Error('dsh-buddy: Config.publicBaseUrl must be the canonical origin without path')
  }
  return url
}

/**
 * Build the root authentication URL and the authenticated Buddy URL.
 * @param connection - official Host Connection service.
 * @param config - Buddy configuration containing the public browser origin.
 * @param webServer - bound Host web-server address.
 * @returns the two URLs that must be opened in order.
 */
export function kioskLaunchUrls(
  connection: HostConnectionHandle,
  config: Pick<Config, 'publicBaseUrl'>,
  webServer: Pick<WebServer, 'host' | 'port'>,
): { authenticateUrl: string; kioskUrl: string } {
  const validated = validatePublicBaseUrl(config.publicBaseUrl)
  if (validated === undefined && !isLoopbackHost(webServer.host)) {
    throw new Error('dsh-buddy: publicBaseUrl is required when webServer.host is "' + webServer.host + '"')
  }
  const origin = validated?.origin ?? 'http://127.0.0.1:' + String(webServer.port)
  const authenticateUrl = connection.authenticatedUrl(origin)
  const kioskUrl = origin + '/buddy'
  return { authenticateUrl, kioskUrl }
}

/**
 * Build only the root authentication URL for callers using their own follow-up navigation.
 * @param connection - official Host Connection service.
 * @param config - Buddy configuration containing the public browser origin.
 * @param webServer - bound Host web-server address.
 * @returns the root token-exchange URL.
 */
export function kioskLaunchUrl(
  connection: HostConnectionHandle,
  config: Pick<Config, 'publicBaseUrl'>,
  webServer: Pick<WebServer, 'host' | 'port'>,
): string {
  return kioskLaunchUrls(connection, config, webServer).authenticateUrl
}

function log(line: string): void {
  process.stderr.write('[dsh-buddy] ' + line + '\n')
}

function pageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '..', 'page')
}

function cleanupErrors(error: unknown): readonly unknown[] {
  return error instanceof AggregateError ? error.errors : [error]
}

function cleanupFailure(errors: readonly unknown[]): AggregateError {
  return new AggregateError(errors, 'dsh-buddy cleanup failed')
}

function combineStartupFailure(startupError: unknown, cleanupError: unknown): AggregateError {
  return new AggregateError(
    [startupError, ...cleanupErrors(cleanupError)],
    'dsh-buddy startup failed and cleanup also failed',
    { cause: startupError },
  )
}

/**
 * Install Buddy routes, lifecycle listeners, archive polling, and interaction answerers.
 * @param ctx - Host plugin context with the required alpha.1 services.
 * @param rawConfig - optional validated Buddy configuration values.
 */
export function apply(ctx: Context, rawConfig?: Partial<Config>): void {
  const config: Config = {
    archivePollMs: 4000,
    publicBaseUrl: '',
    ...rawConfig,
  }
  if (typeof config.archivePollMs !== 'number' || !Number.isSafeInteger(config.archivePollMs) || config.archivePollMs < 1 || config.archivePollMs > MAX_ARCHIVE_POLL_MS) {
    throw new Error('dsh-buddy: Config.archivePollMs must be a positive safe integer no greater than ' + String(MAX_ARCHIVE_POLL_MS))
  }
  if (typeof config.publicBaseUrl !== 'string') {
    throw new Error('dsh-buddy: Config.publicBaseUrl must be a string')
  }
  validatePublicBaseUrl(config.publicBaseUrl)

  const webServer = ctx.webServer
  const connection = ctx.connection
  const sessions = ctx.sessions
  const agents = ctx.agents
  const workspaceRegistry: WorkspaceRegistry = ctx.workspaceRegistry
  if (!webServer) throw new Error('dsh-buddy: required service "webServer" is missing')
  if (!connection) throw new Error('dsh-buddy: required service "connection" is missing')
  if (!sessions) throw new Error('dsh-buddy: required service "sessions" is missing')
  if (!agents) throw new Error('dsh-buddy: required service "agents" is missing')
  if (!workspaceRegistry) throw new Error('dsh-buddy: required service "workspaceRegistry" is missing')
  if (!isLoopbackHost(webServer.host) && config.publicBaseUrl === '') {
    throw new Error('dsh-buddy: publicBaseUrl is required when webServer.host is "' + webServer.host + '" (wildcard/non-loopback)')
  }

  const store = new BuddyStore()
  const seedFromStore = (reason: string): void => {
    const listed = sessions.list()
    const liveAgents = agents.list()
    store.seed(listed, liveAgents, workspaceRegistry.archivedSessionIds)
    const snapshot = store.snapshot()
    log(reason + ' seed listed=' + String(listed.length) + ' visible=' + String(snapshot.sessions.length) + ' mood=' + snapshot.mood)
  }

  try {
    seedFromStore('immediate')
  } catch (error) {
    throw new Error('dsh-buddy: initial seed failed: ' + String(error), { cause: error })
  }

  let effectDisposer: (() => void) | undefined
  try {
    ctx.effect(() => {
      let hub: ReturnType<typeof registerBuddyRoutes> | undefined
      let broker: BuddyInteractionBroker | undefined
      let pollTimer: ReturnType<typeof setInterval> | undefined
      let disposed = false
      let pollFailures = 0
      let diagnosticWindowStarted = 0
      let diagnosticCount = 0
      const owned: Array<() => void> = []

      const dispose = (): void => {
        if (disposed) return
        disposed = true
        const failures: unknown[] = []
        if (pollTimer !== undefined) {
          try {
            clearInterval(pollTimer)
          } catch (error) {
            failures.push(error)
          }
          pollTimer = undefined
        }
        for (const cleanup of owned.splice(0).reverse()) {
          try {
            cleanup()
          } catch (error) {
            failures.push(error)
          }
        }
        if (failures.length > 0) throw cleanupFailure(failures)
      }

      try {
        broker = new BuddyInteractionBroker(
          store,
          () => hub !== undefined && hub.kioskClients.size > 0,
          (frame) => {
            const current = hub
            if (current === undefined || current.kioskClients.size === 0) return
            current.broadcastKiosk(frame)
          },
        )
        owned.push(() => { broker?.dispose() })
        hub = registerBuddyRoutes(
          webServer,
          store,
          pageRoot(),
          connection,
          (sessionId) => { store.markSeen(sessionId) },
          (raw) => broker?.respond(raw) ?? 'unknown',
          () => broker?.pending() ?? [],
          () => { broker?.delegateAll() },
        )
        owned.push(() => { hub?.dispose() })

        pollTimer = setInterval(() => {
          if (disposed) return
          try {
            store.setArchived(workspaceRegistry.archivedSessionIds)
            pollFailures = 0
            diagnosticWindowStarted = 0
            diagnosticCount = 0
          } catch (error) {
            pollFailures = Math.min(pollFailures + 1, Number.MAX_SAFE_INTEGER)
            const now = Date.now()
            if (diagnosticWindowStarted === 0 || now < diagnosticWindowStarted || now - diagnosticWindowStarted >= 60_000) {
              diagnosticWindowStarted = now
              diagnosticCount = 0
            }
            if (diagnosticCount < 3) {
              diagnosticCount += 1
              const detail = error instanceof Error ? error.message : String(error)
              log('archive poll failed (' + String(pollFailures) + '): ' + detail.slice(0, 240))
            }
          }
        }, config.archivePollMs)
        owned.push(() => {
          if (pollTimer !== undefined) clearInterval(pollTimer)
          pollTimer = undefined
        })

        const offCreated = ctx.on('session/created', (session) => {
          store.onCreated(session)
        })
        owned.push(offCreated)
        const offDisposed = ctx.on('session/disposed', (session) => {
          const failures: unknown[] = []
          try {
            broker?.sessionDisposed(session.id)
          } catch (error) {
            failures.push(...cleanupErrors(error))
          }
          try {
            store.onDisposed(session.id)
          } catch (error) {
            failures.push(...cleanupErrors(error))
          }
          if (failures.length > 0) throw cleanupFailure(failures)
        })
        owned.push(offDisposed)
        const offEvent = ctx.on('session/event', (session, event: SessionEvent) => {
          store.onEvent(session.id, event, session.header)
        })
        owned.push(offEvent)
        const offAgent = ctx.on('agent/status', ({ agent, status }) => {
          store.onAgentStatus(agent.id, status, agent.session.header)
        })
        owned.push(offAgent)
        const offApproval = ctx.on('approval/request', (request: ApprovalRequestEvent, next) => {
          const current = broker
          return current === undefined ? next() : current.handleApproval(request, next)
        }, { prepend: true })
        owned.push(offApproval)
        const offQuestion = ctx.on('user-questions/request', (request: AskUserQuestionRequestEvent, next) => {
          const current = broker
          return current === undefined ? next() : current.handleQuestion(request, next)
        }, { prepend: true })
        owned.push(offQuestion)

        const urls = kioskLaunchUrls(connection, config, webServer)
        log('kiosk authentication URL is provided to the launcher through DSH_BUDDY_AUTHENTICATE_URL')
        log('kiosk kioskUrl (open after cookie): ' + urls.kioskUrl)
        log('alpha.1 authentication requires the root exchange before kioskUrl')

        effectDisposer = dispose
        return dispose
      } catch (error) {
        try {
          dispose()
        } catch (cleanupError) {
          throw combineStartupFailure(error, cleanupError)
        }
        throw error
      }
    }, 'dsh-buddy: transport')
  } catch (error) {
    try {
      effectDisposer?.()
    } catch (cleanupError) {
      throw combineStartupFailure(error, cleanupError)
    }
    throw error
  }
}
