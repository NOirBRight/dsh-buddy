import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { BuddyStore, type HostSession } from '../core/store.ts'
import { registerBuddyRoutes } from './routes.ts'
import { BuddyInteractionBroker } from '../core/interactions.ts'
import { BUDDY_PAGE_PATH, BUDDY_EVENTS_PATH, BUDDY_CLIENT_EVENTS_PATH, BUDDY_NAVIGATE_PATH, BUDDY_RESPOND_PATH, BUDDY_ASSET_PREFIX } from '../contract.ts'

type RequestListener = (...args: unknown[]) => void

type MockResponse = {
  body: string
  calls: string[]
  destroyed: boolean
  writable: boolean
  writableEnded: boolean
  headersSent: boolean
  status: number | undefined
  headers: Record<string, string> | undefined
  writeHead: (status: number, headers?: Record<string, string>) => void
  write: (chunk: string) => boolean
  end: (chunk?: string) => void
  destroy: () => void
  on: (event: string, listener: () => void) => MockResponse
  once: (event: string, listener: () => void) => MockResponse
  removeListener: (event: string, listener: () => void) => MockResponse
  emit: (event: string) => boolean
  emitClose: () => void
}

type MockRequest = {
  on: (event: string, listener: RequestListener) => MockRequest
  removeListener: (event: string, listener: RequestListener) => MockRequest
  destroy: () => MockRequest
  destroyed: boolean
}

function mockRes(options: { endError?: unknown; destroyError?: unknown } = {}): ServerResponse & MockResponse {
  const listeners = new Map<string, Set<() => void>>()
  const addListener = (event: string, listener: () => void): void => {
    const callbacks = listeners.get(event) ?? new Set<() => void>()
    callbacks.add(listener)
    listeners.set(event, callbacks)
  }
  const removeListener = (event: string, listener: () => void): void => {
    listeners.get(event)?.delete(listener)
  }
  const emit = (event: string): boolean => {
    const callbacks = [...(listeners.get(event) ?? [])]
    for (const listener of callbacks) listener()
    return callbacks.length > 0
  }
  const response: MockResponse = {
    body: '',
    calls: [],
    destroyed: false,
    writable: true,
    writableEnded: false,
    headersSent: false,
    status: undefined,
    headers: undefined,
    writeHead(status, headers) {
      response.status = status
      response.headers = headers
      response.headersSent = true
    },
    write(chunk) { response.body += String(chunk); return true },
    end(chunk) {
      response.calls.push('end')
      if (options.endError !== undefined) throw options.endError
      if (chunk) response.body += String(chunk)
      response.headersSent = true
      response.writableEnded = true
      response.writable = false
      emit('finish')
    },
    destroy() {
      response.calls.push('destroy')
      if (options.destroyError !== undefined) throw options.destroyError
      response.destroyed = true
    },
    on(event, listener) {
      addListener(event, listener)
      return response
    },
    once(event, listener) {
      addListener(event, listener)
      return response
    },
    removeListener(event, listener) {
      removeListener(event, listener)
      return response
    },
    emit,
    emitClose() { emit('close') },
  }
  return response as unknown as ServerResponse & MockResponse
}

function mockReq(partial: Partial<IncomingMessage> & { url?: string; method?: string; headers?: Record<string, string> }): IncomingMessage {
  return {
    method: partial.method ?? 'GET',
    url: partial.url ?? '/',
    headers: partial.headers ?? {},
    on: (_event: string, _listener: RequestListener) => {},
  } as unknown as IncomingMessage
}

function mutableRequest(request: IncomingMessage): MockRequest {
  return request as unknown as MockRequest
}

class MockWebServer {
  readonly routes = new Map<string, WebRoute>()
  readonly unregisterAttempts: string[] = []
  readonly unregisterFailures = new Map<string, unknown>()
  register(route: WebRoute): () => void {
    const key = `${route.kind}:${route.path}`
    if (this.routes.has(key)) throw new Error(`duplicate ${route.kind} route "${route.path}"`)
    this.routes.set(key, route)
    return () => {
      this.unregisterAttempts.push(key)
      const failure = this.unregisterFailures.get(key)
      if (failure !== undefined) throw failure
      this.routes.delete(key)
    }
  }
  get size(): number { return this.routes.size }
}

function hostSession(id: string): HostSession {
  const sessionId = id as unknown as SessionId
  // The fixture only exercises the store's id lookup; production headers are not relevant here.
  return { id: sessionId, header: { version: 0, id: sessionId, createdAt: 1 } as unknown as HostSession['header'], events: [] }
}

class MockConnection {
  readonly validToken = 'valid-token'
  readonly cookieValue = 'dsh-auth-valid'
  authenticatedUrl(base: string) {
    const url = new URL(base)
    url.searchParams.set('token', this.validToken)
    return url.href
  }
  // Honest alpha.1 semantics: authorizeIndex only accepts token on "/"
  authorizeIndex(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? '/', 'http://x')
    const tokens = url.searchParams.getAll('token')
    const cookie = (req.headers as Record<string,string>)['cookie'] ?? ''
    const hasCookie = cookie.includes(this.cookieValue)
    if (tokens.length > 0) {
      if (tokens.length === 1 && tokens[0] === this.validToken && req.method === 'GET' && url.pathname === '/') {
        res.writeHead(303, { 'set-cookie': `${this.cookieValue}=v1.payload.sig; Path=/` })
        res.end()
        return false
      }
      if (hasCookie && req.method === 'GET' && url.pathname === '/') {
        res.writeHead(303)
        res.end()
        return false
      }
      res.writeHead(401)
      res.end('unauthorized')
      return false
    }
    if (hasCookie) return true
    res.writeHead(401)
    res.end('unauthorized')
    return false
  }
  requestRejection(req: { headers: Record<string,string> }): 401 | 403 | undefined {
    const host = req.headers['host']
    if (!host || host.includes('evil.com')) return 403
    if (req.headers['sec-fetch-site'] === 'cross-site') return 403
    const origin = req.headers['origin']
    if (origin) {
      try {
        const originHost = new URL(origin).host
        const hostHost = new URL(`http://${host}`).host
        if (originHost !== hostHost) return 403
      } catch { return 403 }
    }
    const cookie = req.headers['cookie'] ?? ''
    if (cookie.includes(this.cookieValue)) return undefined
    return 401
  }
}

async function invoke(server: MockWebServer, kind: string, path: string, req: IncomingMessage, res: ServerResponse) {
  const key = `${kind}:${path}`
  const route = server.routes.get(key)
  if (!route) throw new Error(`route ${key} not found`)
  await route.handler(req, res)
}

describe('Buddy transport registration', () => {
  it('registers six routes and disposes them idempotently', async () => {
    const server = new MockWebServer() as unknown as WebServer & MockWebServer
    const store = new BuddyStore()
    const conn = new MockConnection() as unknown as HostConnectionHandle & MockConnection
    const hub = registerBuddyRoutes(server, store, '/tmp', conn, () => {})
    expect(server.size).toBe(6)
    expect(hub.kioskClients.size).toBe(0)
    hub.dispose()
    expect(server.size).toBe(0)
    hub.dispose()
    expect(server.size).toBe(0)
  })

  it('rolls back prior routes on partial registration failure', async () => {
    const server = new MockWebServer() as unknown as WebServer & MockWebServer
    server.register({ kind: 'exact', path: BUDDY_EVENTS_PATH, handler: () => {} })
    const store = new BuddyStore()
    const conn = new MockConnection() as unknown as HostConnectionHandle & MockConnection
    expect(() => registerBuddyRoutes(server, store, '/tmp', conn, () => {})).toThrow(/duplicate/)
    expect(server.size).toBe(1)
  })

  it('exposes rollback failures together with the route registration error', () => {
    const server = new MockWebServer() as unknown as WebServer & MockWebServer
    server.register({ kind: 'exact', path: BUDDY_EVENTS_PATH, handler: () => {} })
    const cleanupFailure = new Error('page rollback failed')
    server.unregisterFailures.set(`exact:${BUDDY_PAGE_PATH}`, cleanupFailure)
    const store = new BuddyStore()
    const conn = new MockConnection() as unknown as HostConnectionHandle & MockConnection

    let thrown: unknown
    try {
      registerBuddyRoutes(server, store, '/tmp', conn, () => {})
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors).toHaveLength(2)
    expect((thrown as AggregateError).errors[0]).toMatchObject({ message: expect.stringMatching(/duplicate/) })
    expect((thrown as AggregateError).errors[1]).toBe(cleanupFailure)
    expect((thrown as AggregateError).cause).toMatchObject({ message: expect.stringMatching(/duplicate/) })
  })

  it('disposes routes, store subscription, and peers in reverse order and exposes every failure', async () => {
    const server = new MockWebServer() as unknown as WebServer & MockWebServer
    const routeFailure = new Error('asset route cleanup failed')
    const pageRouteFailure = new Error('page route cleanup failed')
    server.unregisterFailures.set(`${'prefix:' + BUDDY_ASSET_PREFIX}`, routeFailure)
    server.unregisterFailures.set(`${'exact:' + BUDDY_PAGE_PATH}`, pageRouteFailure)
    const store = new BuddyStore()
    const storeFailure = new Error('store subscription cleanup failed')
    let storeCleanupAttempts = 0
    const subscribe = store.subscribe.bind(store)
    const subscribedStore = store as unknown as { subscribe: typeof store.subscribe }
    subscribedStore.subscribe = (listener) => {
      subscribe(listener)
      return () => {
        storeCleanupAttempts += 1
        throw storeFailure
      }
    }
    const conn = new MockConnection() as unknown as HostConnectionHandle & MockConnection
    const hub = registerBuddyRoutes(server, store, '/tmp', conn, () => {})
    const req = mockReq({ method: 'GET', url: BUDDY_EVENTS_PATH, headers: { host: '127.0.0.1:3082', cookie: 'dsh-auth-valid=v1.payload.sig' } })
    const endFailure = new Error('peer end failed')
    const destroyFailure = new Error('peer destroy failed')
    const response = mockRes({ endError: endFailure, destroyError: destroyFailure })
    await invoke(server, 'exact', BUDDY_EVENTS_PATH, req, response)

    let thrown: unknown
    try {
      hub.dispose()
    } catch (error) {
      thrown = error
    }

    expect(server.unregisterAttempts).toEqual([
      `prefix:${BUDDY_ASSET_PREFIX}`,
      `exact:${BUDDY_RESPOND_PATH}`,
      `exact:${BUDDY_NAVIGATE_PATH}`,
      `exact:${BUDDY_CLIENT_EVENTS_PATH}`,
      `exact:${BUDDY_EVENTS_PATH}`,
      `exact:${BUDDY_PAGE_PATH}`,
    ])
    expect(storeCleanupAttempts).toBe(1)
    expect(response.calls).toEqual(['end', 'destroy'])
    expect(hub.kioskClients.size).toBe(0)
    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors).toEqual([endFailure, destroyFailure, routeFailure, pageRouteFailure, storeFailure])

    hub.dispose()
    expect(server.unregisterAttempts).toHaveLength(6)
    expect(storeCleanupAttempts).toBe(1)
    expect(response.calls).toEqual(['end', 'destroy'])
  })

  it('logs final-client delegation failures without throwing from close dispatch', async () => {
    const server = new MockWebServer() as unknown as WebServer & MockWebServer
    const store = new BuddyStore()
    const conn = new MockConnection() as unknown as HostConnectionHandle & MockConnection
    const delegationFailure = new Error('delegation failed')
    let delegationAttempts = 0
    const hub = registerBuddyRoutes(server, store, '/tmp', conn, () => {}, () => 'unknown', () => [], () => {
      delegationAttempts += 1
      throw delegationFailure
    })
    const req = mockReq({ method: 'GET', url: BUDDY_EVENTS_PATH, headers: { host: '127.0.0.1:3082', cookie: 'dsh-auth-valid=v1.payload.sig' } })
    const response = mockRes()
    await invoke(server, 'exact', BUDDY_EVENTS_PATH, req, response)

    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => response.emitClose()).not.toThrow()
      expect(report).toHaveBeenCalledTimes(1)
      expect(report.mock.calls[0]?.[0]).toBeInstanceOf(AggregateError)
      expect((report.mock.calls[0]?.[0] as AggregateError).errors).toEqual([delegationFailure])
    } finally {
      report.mockRestore()
    }
    expect(delegationAttempts).toBe(1)
    expect(hub.kioskClients.size).toBe(0)

    const second = mockRes()
    await invoke(server, 'exact', BUDDY_EVENTS_PATH, req, second)
    hub.dispose()
    expect(delegationAttempts).toBe(1)
  })

  it('isolates failed-write cleanup and reports final-client callback failures', async () => {
    const server = new MockWebServer() as unknown as WebServer & MockWebServer
    const store = new BuddyStore()
    const conn = new MockConnection() as unknown as HostConnectionHandle & MockConnection
    const callbackFailure = new Error('final-client callback failed')
    const endFailure = new Error('peer end failed')
    const destroyFailure = new Error('peer destroy failed')
    const hub = registerBuddyRoutes(server, store, '/tmp', conn, () => {}, () => 'unknown', () => [], () => {
      throw callbackFailure
    })
    const req = mockReq({ method: 'GET', url: BUDDY_EVENTS_PATH, headers: { host: '127.0.0.1:3082', cookie: 'dsh-auth-valid=v1.payload.sig' } })
    const response = mockRes({ endError: endFailure, destroyError: destroyFailure })
    await invoke(server, 'exact', BUDDY_EVENTS_PATH, req, response)
    ;(response as unknown as MockResponse).write = () => { throw new Error('peer write failed') }

    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    let thrown: unknown
    try {
      try {
        hub.broadcastKiosk({ type: 'snapshot', snapshot: store.snapshot() })
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeUndefined()
      expect(report).toHaveBeenCalledTimes(1)
      const failure = report.mock.calls[0]?.[0]
      expect(failure).toBeInstanceOf(AggregateError)
      expect((failure as AggregateError).errors).toEqual([callbackFailure, endFailure, destroyFailure])
    } finally {
      report.mockRestore()
    }
    expect(response.calls).toEqual(['end', 'destroy'])
    expect(hub.kioskClients.size).toBe(0)
    hub.dispose()
  })

  it('continues broadcasting when one peer write fails', async () => {
    const server = new MockWebServer() as unknown as WebServer & MockWebServer
    const store = new BuddyStore()
    const conn = new MockConnection() as unknown as HostConnectionHandle & MockConnection
    const hub = registerBuddyRoutes(server, store, '/tmp', conn, () => {})
    const request = mockReq({ method: 'GET', url: BUDDY_EVENTS_PATH, headers: { host: '127.0.0.1:3082', cookie: 'dsh-auth-valid=v1.payload.sig' } })
    const first = mockRes()
    const second = mockRes()
    await invoke(server, 'exact', BUDDY_EVENTS_PATH, request, first)
    await invoke(server, 'exact', BUDDY_EVENTS_PATH, request, second)
    ;(first as unknown as MockResponse).write = () => { throw new Error('first peer write failed') }

    expect(() => hub.broadcastKiosk({ type: 'snapshot', snapshot: store.snapshot() })).not.toThrow()
    expect(hub.kioskClients.size).toBe(1)
    expect(second.body).toContain('"type":"snapshot"')
    hub.dispose()
  })

  it('waits for drain before writing later frames to a backpressured peer', async () => {
    const server = new MockWebServer() as unknown as WebServer & MockWebServer
    const store = new BuddyStore()
    const conn = new MockConnection() as unknown as HostConnectionHandle & MockConnection
    const hub = registerBuddyRoutes(server, store, '/tmp', conn, () => {})
    const request = mockReq({ method: 'GET', url: BUDDY_EVENTS_PATH, headers: { host: '127.0.0.1:3082', cookie: 'dsh-auth-valid=v1.payload.sig' } })
    const response = mockRes()
    await invoke(server, 'exact', BUDDY_EVENTS_PATH, request, response)
    const writes: string[] = []
    let blocked = true
    ;(response as unknown as MockResponse).write = (chunk) => {
      writes.push(String(chunk))
      return !blocked
    }

    hub.broadcastKiosk({ type: 'snapshot', snapshot: store.snapshot() })
    hub.broadcastKiosk({ type: 'snapshot', snapshot: store.snapshot() })
    expect(writes).toHaveLength(1)
    blocked = false
    response.emit('drain')
    await Promise.resolve()
    await Promise.resolve()
    expect(writes).toHaveLength(2)
    hub.dispose()
  })

  it('evicts peers whose queued SSE items or bytes exceed bounds', async () => {
    const server = new MockWebServer() as unknown as WebServer & MockWebServer
    const store = new BuddyStore()
    const conn = new MockConnection() as unknown as HostConnectionHandle & MockConnection
    const hub = registerBuddyRoutes(server, store, '/tmp', conn, () => {})
    const request = mockReq({ method: 'GET', url: BUDDY_EVENTS_PATH, headers: { host: '127.0.0.1:3082', cookie: 'dsh-auth-valid=v1.payload.sig' } })
    const response = mockRes()
    await invoke(server, 'exact', BUDDY_EVENTS_PATH, request, response)
    ;(response as unknown as MockResponse).write = () => false
    for (let index = 0; index < 70; index += 1) hub.broadcastKiosk({ type: 'snapshot', snapshot: store.snapshot() })
    expect(hub.kioskClients.size).toBe(0)
    expect(response.calls).toEqual(['end', 'destroy'])

    const second = mockRes()
    await invoke(server, 'exact', BUDDY_EVENTS_PATH, request, second)
    ;(second as unknown as MockResponse).write = () => false
    hub.broadcastKiosk({
      type: 'interaction-requested',
      interaction: { kind: 'approval', requestId: 'request-1', sessionId: 'session-1', toolName: 'bash', reason: 'x'.repeat(512 * 1024) },
    } as never)
    expect(hub.kioskClients.size).toBe(0)
    expect(second.calls).toEqual(['end', 'destroy'])
    hub.dispose()
  })

  it('handles peer response errors by removing and closing the peer', async () => {
    const server = new MockWebServer() as unknown as WebServer & MockWebServer
    const store = new BuddyStore()
    const conn = new MockConnection() as unknown as HostConnectionHandle & MockConnection
    const hub = registerBuddyRoutes(server, store, '/tmp', conn, () => {})
    const request = mockReq({ method: 'GET', url: BUDDY_EVENTS_PATH, headers: { host: '127.0.0.1:3082', cookie: 'dsh-auth-valid=v1.payload.sig' } })
    const response = mockRes()
    await invoke(server, 'exact', BUDDY_EVENTS_PATH, request, response)

    expect(() => response.emit('error')).not.toThrow()
    expect(hub.kioskClients.size).toBe(0)
    expect(response.calls).toEqual(['end', 'destroy'])
    hub.dispose()
  })

  it('closes open SSE responses on dispose (kiosk and gui)', async () => {
    const server = new MockWebServer() as unknown as WebServer & MockWebServer
    const store = new BuddyStore()
    const conn = new MockConnection() as unknown as HostConnectionHandle & MockConnection
    const hub = registerBuddyRoutes(server, store, '/tmp', conn, () => {})
    const req = mockReq({ method: 'GET', url: BUDDY_EVENTS_PATH, headers: { host: '127.0.0.1:3082', cookie: 'dsh-auth-valid=v1.payload.sig' } })
    const res = mockRes()
    await invoke(server, 'exact', BUDDY_EVENTS_PATH, req, res)
    expect(res.status).toBe(200)
    expect(hub.kioskClients.size).toBe(1)
    const req2 = mockReq({ method: 'GET', url: BUDDY_CLIENT_EVENTS_PATH, headers: { host: '127.0.0.1:3082', cookie: 'dsh-auth-valid=v1.payload.sig' } })
    const res2 = mockRes()
    await invoke(server, 'exact', BUDDY_CLIENT_EVENTS_PATH, req2, res2)
    expect(hub.guiClients.size).toBe(1)
    hub.dispose()
    expect(hub.kioskClients.size).toBe(0)
    expect(hub.guiClients.size).toBe(0)
  })

  it('delegates pending requests only after the last kiosk disconnects', async () => {
    const server = new MockWebServer() as unknown as WebServer & MockWebServer
    const store = new BuddyStore()
    store.seed([hostSession('session-1')], [], [])
    const conn = new MockConnection() as unknown as HostConnectionHandle & MockConnection
    let hub: ReturnType<typeof registerBuddyRoutes> | undefined
    const broker = new BuddyInteractionBroker(
      store,
      () => hub !== undefined && hub.kioskClients.size > 0,
      (frame) => { hub?.broadcastKiosk(frame) },
    )
    let delegateCalls = 0
    hub = registerBuddyRoutes(server, store, '/tmp', conn, () => {}, () => 'unknown', () => broker.pending(), (available) => {
      if (!available) {
        delegateCalls += 1
        broker.delegateAll()
      }
    })
    const request = mockReq({ method: 'GET', url: BUDDY_EVENTS_PATH, headers: { host: '127.0.0.1:3082', cookie: 'dsh-auth-valid=v1.payload.sig' } })
    const first = mockRes()
    const second = mockRes()
    await invoke(server, 'exact', BUDDY_EVENTS_PATH, request, first)
    await invoke(server, 'exact', BUDDY_EVENTS_PATH, request, second)
    expect(hub.kioskClients.size).toBe(2)
    let nextCalls = 0
    let resolveCalls = 0
    let rejectCalls = 0
    const pending = broker.handleApproval({ agent: { id: 'session-1' }, toolName: 'bash' } as never, async () => {
      nextCalls += 1
      return 'rejected'
    })
    const settled = pending.then(() => { resolveCalls += 1 }, () => { rejectCalls += 1 })
    first.emitClose()
    expect(nextCalls).toBe(0)
    expect(delegateCalls).toBe(0)
    expect(hub.kioskClients.size).toBe(1)
    second.emitClose()
    await expect(pending).resolves.toBe('rejected')
    await settled
    expect(delegateCalls).toBe(1)
    expect(nextCalls).toBe(1)
    expect(resolveCalls).toBe(1)
    expect(rejectCalls).toBe(0)
    expect(hub.kioskClients.size).toBe(0)
    second.emitClose()
    await Promise.resolve()
    expect(delegateCalls).toBe(1)
    expect(nextCalls).toBe(1)
    expect(resolveCalls).toBe(1)
    expect(rejectCalls).toBe(0)
    broker.dispose()
    hub.dispose()
  })

  it('requires official browser authentication on page via two-step (root token then cookie for /buddy)', async () => {
    const server = new MockWebServer() as unknown as WebServer & MockWebServer
    const store = new BuddyStore()
    const conn = new MockConnection() as unknown as HostConnectionHandle & MockConnection
    const hub = registerBuddyRoutes(server, store, '/tmp', conn, () => {})
    // Unauthenticated without cookie -> 401 (before reading file)
    const reqUnauth = mockReq({ method: 'GET', url: BUDDY_PAGE_PATH, headers: { host: '127.0.0.1:3082' } })
    const resUnauth = mockRes()
    await invoke(server, 'exact', BUDDY_PAGE_PATH, reqUnauth, resUnauth)
    expect(resUnauth.status).toBe(401)
    // Token on /buddy is NOT valid in honest semantics (only /) -> 401
    const reqTokenBuddy = mockReq({ method: 'GET', url: `${BUDDY_PAGE_PATH}?token=valid-token`, headers: { host: '127.0.0.1:3082' } })
    const resTokenBuddy = mockRes()
    await invoke(server, 'exact', BUDDY_PAGE_PATH, reqTokenBuddy, resTokenBuddy)
    expect(resTokenBuddy.status).toBe(401)
    // Honest two-step: first open authenticateUrl (root token URL) to mint cookie
    const { kioskLaunchUrls } = await import('../index.ts')
    const urls = kioskLaunchUrls(conn as unknown as HostConnectionHandle, { publicBaseUrl: '' }, { host: '127.0.0.1', port: 3082 })
    expect(urls.authenticateUrl).toContain('/?token=valid-token')
    expect(urls.kioskUrl).toBe('http://127.0.0.1:3082/buddy')
    // Simulate that authenticateUrl was visited and cookie set
    const reqCookie = mockReq({ method: 'GET', url: BUDDY_PAGE_PATH, headers: { host: '127.0.0.1:3082', cookie: 'dsh-auth-valid=v1.payload.sig' } })
    const resCookie = mockRes()
    await invoke(server, 'exact', BUDDY_PAGE_PATH, reqCookie, resCookie)
    expect(resCookie.status).toBe(404) // 404 because /tmp/index.html missing, but not 401
    hub.dispose()
  })

  it('disposes requests before early GET-route rejections', async () => {
    const server = new MockWebServer() as unknown as WebServer & MockWebServer
    const store = new BuddyStore()
    const conn = new MockConnection() as unknown as HostConnectionHandle & MockConnection
    const hub = registerBuddyRoutes(server, store, '/tmp', conn, () => {})
    const headers = { host: '127.0.0.1:3082', cookie: 'dsh-auth-valid=v1.payload.sig' }
    const cases = [
      { kind: 'exact', path: BUDDY_PAGE_PATH, url: BUDDY_PAGE_PATH, method: 'POST', status: 405 },
      { kind: 'exact', path: BUDDY_EVENTS_PATH, url: BUDDY_EVENTS_PATH, method: 'POST', status: 405 },
      { kind: 'exact', path: BUDDY_CLIENT_EVENTS_PATH, url: BUDDY_CLIENT_EVENTS_PATH, method: 'POST', status: 405 },
      { kind: 'prefix', path: BUDDY_ASSET_PREFIX, url: BUDDY_ASSET_PREFIX + '/buddy.css', method: 'POST', status: 405 },
      { kind: 'exact', path: BUDDY_PAGE_PATH, url: BUDDY_PAGE_PATH, method: 'GET', headers: { host: '127.0.0.1:3082' }, status: 401 },
    ]
    for (const testCase of cases) {
      const request = mockReq({ method: testCase.method, url: testCase.url, headers: testCase.headers ?? headers })
      const requestEvents = mutableRequest(request)
      requestEvents.destroyed = false
      const order: string[] = []
      requestEvents.destroy = () => {
        order.push('destroy')
        requestEvents.destroyed = true
        return requestEvents
      }
      const response = mockRes()
      const responseForOrder = response as unknown as { writeHead: (status: number, headers?: Record<string, string>) => void }
      const writeHead = responseForOrder.writeHead
      responseForOrder.writeHead = (status, responseHeaders) => {
        order.push('status:' + String(status))
        writeHead(status, responseHeaders)
      }
      await invoke(server, testCase.kind, testCase.path, request, response)
      expect(response.status).toBe(testCase.status)
      expect(order).toEqual(['destroy', 'status:' + String(testCase.status)])
    }
    hub.dispose()
  })

  it('authenticates assets, SSE and navigate via requestRejection, returning exact status before data', async () => {
    const server = new MockWebServer() as unknown as WebServer & MockWebServer
    const store = new BuddyStore()
    const conn = new MockConnection() as unknown as HostConnectionHandle & MockConnection
    const hub = registerBuddyRoutes(server, store, '/tmp', conn, () => {})
    const reqAssetUnauth = mockReq({ method: 'GET', url: `${BUDDY_ASSET_PREFIX}/buddy.css`, headers: { host: '127.0.0.1:3082' } })
    const resAssetUnauth = mockRes()
    await invoke(server, 'prefix', BUDDY_ASSET_PREFIX, reqAssetUnauth, resAssetUnauth)
    expect(resAssetUnauth.status).toBe(401)
    const reqAssetEvil = mockReq({ method: 'GET', url: `${BUDDY_ASSET_PREFIX}/buddy.css`, headers: { host: 'evil.com', cookie: 'dsh-auth-valid=v1.payload.sig' } })
    const resAssetEvil = mockRes()
    await invoke(server, 'prefix', BUDDY_ASSET_PREFIX, reqAssetEvil, resAssetEvil)
    expect(resAssetEvil.status).toBe(403)
    const reqSseUnauth = mockReq({ method: 'GET', url: BUDDY_EVENTS_PATH, headers: { host: '127.0.0.1:3082' } })
    const resSseUnauth = mockRes()
    await invoke(server, 'exact', BUDDY_EVENTS_PATH, reqSseUnauth, resSseUnauth)
    expect(resSseUnauth.status).toBe(401)
    const reqSseCross = mockReq({ method: 'GET', url: BUDDY_EVENTS_PATH, headers: { host: '127.0.0.1:3082', 'sec-fetch-site': 'cross-site', cookie: 'dsh-auth-valid=v1.payload.sig' } })
    const resSseCross = mockRes()
    await invoke(server, 'exact', BUDDY_EVENTS_PATH, reqSseCross, resSseCross)
    expect(resSseCross.status).toBe(403)
    const reqNavUnauth = mockReq({ method: 'POST', url: BUDDY_NAVIGATE_PATH, headers: { host: '127.0.0.1:3082', 'content-type': 'application/json' } })
    const resNavUnauth = mockRes()
    await invoke(server, 'exact', BUDDY_NAVIGATE_PATH, reqNavUnauth, resNavUnauth)
    expect(resNavUnauth.status).toBe(401)
    hub.dispose()
  })

  it('validates methods and Content-Type before data', async () => {
    const server = new MockWebServer() as unknown as WebServer & MockWebServer
    const store = new BuddyStore()
    const conn = new MockConnection() as unknown as HostConnectionHandle & MockConnection
    const hub = registerBuddyRoutes(server, store, '/tmp', conn, () => {})
    const reqSsePost = mockReq({ method: 'POST', url: BUDDY_EVENTS_PATH, headers: { host: '127.0.0.1:3082', cookie: 'dsh-auth-valid=v1.payload.sig' } })
    const resSsePost = mockRes()
    await invoke(server, 'exact', BUDDY_EVENTS_PATH, reqSsePost, resSsePost)
    expect(resSsePost.status).toBe(405)
    const reqNavGet = mockReq({ method: 'GET', url: BUDDY_NAVIGATE_PATH, headers: { host: '127.0.0.1:3082', cookie: 'dsh-auth-valid=v1.payload.sig' } })
    const resNavGet = mockRes()
    await invoke(server, 'exact', BUDDY_NAVIGATE_PATH, reqNavGet, resNavGet)
    expect(resNavGet.status).toBe(405)
    const reqNavBadCT = mockReq({ method: 'POST', url: BUDDY_NAVIGATE_PATH, headers: { host: '127.0.0.1:3082', cookie: 'dsh-auth-valid=v1.payload.sig', 'content-type': 'text/plain' } })
    const resNavBadCT = mockRes()
    await invoke(server, 'exact', BUDDY_NAVIGATE_PATH, reqNavBadCT, resNavBadCT)
    expect(resNavBadCT.status).toBe(415)
    const reqAssetPost = mockReq({ method: 'POST', url: `${BUDDY_ASSET_PREFIX}/buddy.css`, headers: { host: '127.0.0.1:3082', cookie: 'dsh-auth-valid=v1.payload.sig' } })
    const resAssetPost = mockRes()
    await invoke(server, 'prefix', BUDDY_ASSET_PREFIX, reqAssetPost, resAssetPost)
    expect(resAssetPost.status).toBe(405)
    hub.dispose()
  })

  it('provides honest kiosk URLs without hardcoding', async () => {
    const server = new MockWebServer() as unknown as WebServer & MockWebServer
    const store = new BuddyStore()
    const conn = new MockConnection() as unknown as HostConnectionHandle & MockConnection
    const hub = registerBuddyRoutes(server, store, '/tmp', conn, () => {})
    const { kioskLaunchUrls } = await import('../index.ts')
    const urls = kioskLaunchUrls(conn as unknown as HostConnectionHandle, { publicBaseUrl: 'http://192.168.1.10:3082' }, { host: '0.0.0.0', port: 3082 })
    expect(urls.authenticateUrl).toContain('valid-token')
    expect(urls.authenticateUrl).toContain('192.168.1.10')
    expect(urls.kioskUrl).toBe('http://192.168.1.10:3082/buddy')
    const urls2 = kioskLaunchUrls(conn as unknown as HostConnectionHandle, { publicBaseUrl: '' }, { host: '127.0.0.1', port: 3082 })
    expect(urls2.authenticateUrl).toContain('127.0.0.1:3082')
    expect(urls2.kioskUrl).toBe('http://127.0.0.1:3082/buddy')
    hub.dispose()
  })

  it('supports HMR reload: dispose then re-register same routes', async () => {
    const server = new MockWebServer() as unknown as WebServer & MockWebServer
    const store = new BuddyStore()
    const conn = new MockConnection() as unknown as HostConnectionHandle & MockConnection
    const hub1 = registerBuddyRoutes(server, store, '/tmp', conn, () => {})
    expect(server.size).toBe(6)
    hub1.dispose()
    expect(server.size).toBe(0)
    const store2 = new BuddyStore()
    const hub2 = registerBuddyRoutes(server, store2, '/tmp', conn, () => {})
    expect(server.size).toBe(6)
    const req = mockReq({ method: 'GET', url: BUDDY_EVENTS_PATH, headers: { host: '127.0.0.1:3082', cookie: 'dsh-auth-valid=v1.payload.sig' } })
    const res = mockRes()
    await invoke(server, 'exact', BUDDY_EVENTS_PATH, req, res)
    expect(res.status).toBe(200)
    expect(hub2.kioskClients.size).toBe(1)
    hub2.dispose()
    expect(server.size).toBe(0)
  })

  it('dispatches authenticated interaction responses', async () => {
    const server = new MockWebServer() as unknown as WebServer & MockWebServer
    const store = new BuddyStore()
    const conn = new MockConnection() as unknown as HostConnectionHandle & MockConnection
    const received: unknown[] = []
    const hub = registerBuddyRoutes(server, store, '/tmp', conn, () => {}, (body) => { received.push(body); return 'accepted' })
    const body = JSON.stringify({ requestId: 'request-1', action: 'delegate' })
    const req = mockReq({ method: 'POST', url: BUDDY_RESPOND_PATH, headers: { host: '127.0.0.1:3082', cookie: 'dsh-auth-valid=v1.payload.sig', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } })
    let dataCb: RequestListener | undefined
    let endCb: RequestListener | undefined
    const requestEvents = mutableRequest(req)
    requestEvents.on = (event, callback) => {
      if (event === 'data') dataCb = callback
      if (event === 'end') endCb = callback
      return requestEvents
    }
    requestEvents.removeListener = () => requestEvents
    requestEvents.destroy = () => requestEvents
    const res = mockRes()
    const pending = invoke(server, 'exact', BUDDY_RESPOND_PATH, req, res)
    dataCb!(Buffer.from(body))
    endCb!()
    await pending
    expect(res.status).toBe(204)
    expect(received).toEqual([{ requestId: 'request-1', action: 'delegate' }])
    hub.dispose()
  })
  it('returns 400 for invalid response JSON or body without invoking the broker', async () => {
    for (const body of ['{', '{}']) {
      const server = new MockWebServer() as unknown as WebServer & MockWebServer
      const store = new BuddyStore()
      const conn = new MockConnection() as unknown as HostConnectionHandle & MockConnection
      let callbackCalls = 0
      const hub = registerBuddyRoutes(server, store, '/tmp', conn, () => {}, () => {
        callbackCalls += 1
        return 'accepted'
      })
      const req = mockReq({ method: 'POST', url: BUDDY_RESPOND_PATH, headers: { host: '127.0.0.1:3082', cookie: 'dsh-auth-valid=v1.payload.sig', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } })
      let dataCb: RequestListener | undefined
      let endCb: RequestListener | undefined
      const requestEvents = mutableRequest(req)
      requestEvents.on = (event, callback) => {
        if (event === 'data') dataCb = callback
        if (event === 'end') endCb = callback
        return requestEvents
      }
      requestEvents.removeListener = () => requestEvents
      requestEvents.destroy = () => requestEvents
      const response = mockRes()
      const pending = invoke(server, 'exact', BUDDY_RESPOND_PATH, req, response)
      dataCb!(Buffer.from(body))
      endCb!()
      await pending
      expect(response.status).toBe(400)
      expect(callbackCalls).toBe(0)
      hub.dispose()
    }
  })

  it('returns 500 when the response broker callback fails', async () => {
    const server = new MockWebServer() as unknown as WebServer & MockWebServer
    const store = new BuddyStore()
    const conn = new MockConnection() as unknown as HostConnectionHandle & MockConnection
    const hostFailure = new Error('broker failed')
    const hub = registerBuddyRoutes(server, store, '/tmp', conn, () => {}, () => { throw hostFailure })
    const body = JSON.stringify({ requestId: 'request-1', action: 'delegate' })
    const req = mockReq({ method: 'POST', url: BUDDY_RESPOND_PATH, headers: { host: '127.0.0.1:3082', cookie: 'dsh-auth-valid=v1.payload.sig', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } })
    let dataCb: RequestListener | undefined
    let endCb: RequestListener | undefined
    const requestEvents = mutableRequest(req)
    requestEvents.on = (event, callback) => {
      if (event === 'data') dataCb = callback
      if (event === 'end') endCb = callback
      return requestEvents
    }
    requestEvents.removeListener = () => requestEvents
    requestEvents.destroy = () => requestEvents
    const response = mockRes()
    const pending = invoke(server, 'exact', BUDDY_RESPOND_PATH, req, response)
    dataCb!(Buffer.from(body))
    endCb!()
    await pending
    expect(response.status).toBe(500)
    expect(response.body).toBe('interaction response failed')
    hub.dispose()
  })

  it('rejects unknown sessionId on navigate', async () => {
    const server = new MockWebServer() as unknown as WebServer & MockWebServer
    const store = new BuddyStore()
    // Seed with one known session
    store.seed([hostSession('known')], [], [])
    const conn = new MockConnection() as unknown as HostConnectionHandle & MockConnection
    const hub = registerBuddyRoutes(server, store, '/tmp', conn, () => {})
    const body = JSON.stringify({ sessionId: 'unknown-id' })
    const req = mockReq({ method: 'POST', url: BUDDY_NAVIGATE_PATH, headers: { host: '127.0.0.1:3082', cookie: 'dsh-auth-valid=v1.payload.sig', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } })
    let dataCb: RequestListener | undefined
    let endCb: RequestListener | undefined
    const requestEvents = mutableRequest(req)
    requestEvents.on = (event, callback) => {
      if (event === 'data') dataCb = callback
      if (event === 'end') endCb = callback
      return requestEvents
    }
    requestEvents.removeListener = () => requestEvents
    requestEvents.destroy = () => requestEvents
    const res = mockRes()
    const _p = invoke(server, 'exact', BUDDY_NAVIGATE_PATH, req, res)
    dataCb!(Buffer.from(body))
    endCb!()
    await _p
    expect(res.status).toBe(404)
    hub.dispose()
  })

  it('rejects oversized and control session IDs before branding', async () => {
    for (const sessionId of ['x'.repeat(257), 'bad\nid', 'bad\u0085id']) {
      const server = new MockWebServer() as unknown as WebServer & MockWebServer
      const store = new BuddyStore()
      store.seed([hostSession(sessionId)], [], [])
      const conn = new MockConnection() as unknown as HostConnectionHandle & MockConnection
      let navigated = false
      const hub = registerBuddyRoutes(server, store, '/tmp', conn, () => { navigated = true })
      const body = JSON.stringify({ sessionId })
      const req = mockReq({ method: 'POST', url: BUDDY_NAVIGATE_PATH, headers: { host: '127.0.0.1:3082', cookie: 'dsh-auth-valid=v1.payload.sig', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } })
      let dataCb: RequestListener | undefined
      let endCb: RequestListener | undefined
      const requestEvents = mutableRequest(req)
      requestEvents.on = (event, callback) => {
        if (event === 'data') dataCb = callback
        if (event === 'end') endCb = callback
        return requestEvents
      }
      requestEvents.removeListener = () => requestEvents
      requestEvents.destroy = () => requestEvents
      const response = mockRes()
      const pending = invoke(server, 'exact', BUDDY_NAVIGATE_PATH, req, response)
      dataCb!(Buffer.from(body))
      endCb!()
      await pending
      expect(response.status).toBe(400)
      expect(navigated).toBe(false)
      hub.dispose()
    }
  })

  it('disposes body requests before every pre-body validation response', async () => {
    const server = new MockWebServer() as unknown as WebServer & MockWebServer
    const store = new BuddyStore()
    const conn = new MockConnection() as unknown as HostConnectionHandle & MockConnection
    const hub = registerBuddyRoutes(server, store, '/tmp', conn, () => {})
    const baseHeaders = { host: '127.0.0.1:3082', cookie: 'dsh-auth-valid=v1.payload.sig' }
    const cases = [
      ...[BUDDY_NAVIGATE_PATH, BUDDY_RESPOND_PATH].map((path) => ({ path, maxBytes: path === BUDDY_NAVIGATE_PATH ? 8 * 1024 : 512 * 1024 })),
    ].flatMap(({ path, maxBytes }) => [
      { path, method: 'GET', headers: baseHeaders, status: 405 },
      { path, method: 'POST', headers: { ...baseHeaders, 'content-type': 'text/plain' }, status: 415 },
      { path, method: 'POST', headers: { ...baseHeaders, 'content-type': 'application/json', 'content-length': 'not-a-number' }, status: 400 },
      { path, method: 'POST', headers: { ...baseHeaders, 'content-type': 'application/json', 'content-length': String(maxBytes + 1) }, status: 413 },
    ])
    for (const testCase of cases) {
      const req = mockReq({ method: testCase.method, url: testCase.path, headers: testCase.headers })
      const requestEvents = mutableRequest(req)
      requestEvents.destroyed = false
      const order: string[] = []
      requestEvents.destroy = () => {
        order.push('destroy')
        requestEvents.destroyed = true
        return requestEvents
      }
      const response = mockRes()
      const responseForOrder = response as unknown as { writeHead: (status: number, headers?: Record<string, string>) => void }
      const writeHead = responseForOrder.writeHead
      responseForOrder.writeHead = (status, headers) => {
        order.push('status:' + String(status))
        writeHead(status, headers)
      }
      await invoke(server, 'exact', testCase.path, req, response)
      expect(response.status).toBe(testCase.status)
      expect(order).toEqual(['destroy', 'status:' + String(testCase.status)])
    }
    hub.dispose()
  })

  it('bounds navigate body and returns 413 for oversized', async () => {
    const server = new MockWebServer() as unknown as WebServer & MockWebServer
    const store = new BuddyStore()
    const conn = new MockConnection() as unknown as HostConnectionHandle & MockConnection
    const hub = registerBuddyRoutes(server, store, '/tmp', conn, () => {})
    const req = mockReq({ method: 'POST', url: BUDDY_NAVIGATE_PATH, headers: { host: '127.0.0.1:3082', cookie: 'dsh-auth-valid=v1.payload.sig', 'content-type': 'application/json' } })
    let dataCb: RequestListener | undefined
    const requestEvents = mutableRequest(req)
    requestEvents.on = (event, callback) => {
      if (event === 'data') dataCb = callback
      return requestEvents
    }
    requestEvents.destroy = () => requestEvents
    requestEvents.removeListener = () => requestEvents
    const res = mockRes()
    const pending = invoke(server, 'exact', BUDDY_NAVIGATE_PATH, req, res)
    // Send in chunks to exceed limit.
    dataCb!(Buffer.alloc(5000))
    dataCb!(Buffer.alloc(5000))
    await pending
    expect(res.status).toBe(413)
    hub.dispose()
  })

  it('settles incomplete POSTs on abort or close, removes listeners, and keeps the first error', async () => {
    const eventPairs: readonly (readonly [string, string])[] = [['aborted', 'error'], ['close', 'error'], ['error', 'close']]
    for (const [firstEvent, secondEvent] of eventPairs) {
      const server = new MockWebServer() as unknown as WebServer & MockWebServer
      const store = new BuddyStore()
      const conn = new MockConnection() as unknown as HostConnectionHandle & MockConnection
      const hub = registerBuddyRoutes(server, store, '/tmp', conn, () => {})
      const request = mockReq({ method: 'POST', url: BUDDY_RESPOND_PATH, headers: { host: '127.0.0.1:3082', cookie: 'dsh-auth-valid=v1.payload.sig', 'content-type': 'application/json' } })
      const requestEvents = mutableRequest(request)
      const listeners = new Map<string, Set<RequestListener>>()
      const callbackInvocations = new Map<string, number>()
      requestEvents.on = (event, listener) => {
        const callbacks = listeners.get(event) ?? new Set<RequestListener>()
        callbacks.add(listener)
        listeners.set(event, callbacks)
        return requestEvents
      }
      requestEvents.removeListener = (event, listener) => {
        listeners.get(event)?.delete(listener)
        return requestEvents
      }
      requestEvents.destroy = () => { requestEvents.destroyed = true; return requestEvents }
      const emit = (event: string, ...args: unknown[]) => {
        const callbacks = [...(listeners.get(event) ?? [])]
        callbackInvocations.set(event, (callbackInvocations.get(event) ?? 0) + callbacks.length)
        for (const listener of callbacks) listener(...args)
      }
      const response = mockRes()
      const pending = invoke(server, 'exact', BUDDY_RESPOND_PATH, request, response)
      emit('data', Buffer.from('{'))
      emit(firstEvent, firstEvent === 'error' ? new Error('first request error') : undefined)
      emit(secondEvent, new Error('later request error'))
      const settled = await Promise.race([pending.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50))])
      expect(settled).toBe(true)
      expect(response.status).toBe(400)
      expect(callbackInvocations.get(firstEvent)).toBe(1)
      expect(callbackInvocations.get(secondEvent) ?? 0).toBe(0)
      expect([...listeners.values()].every((callbacks) => callbacks.size === 0)).toBe(true)
      hub.dispose()
    }
  })

  it('settles POSTs already aborted or closed before listeners attach', async () => {
    for (const state of [{ aborted: true, destroyed: false }, { aborted: false, destroyed: true }]) {
      const server = new MockWebServer() as unknown as WebServer & MockWebServer
      const store = new BuddyStore()
      const conn = new MockConnection() as unknown as HostConnectionHandle & MockConnection
      const hub = registerBuddyRoutes(server, store, '/tmp', conn, () => {})
      const request = mutableRequest(mockReq({ method: 'POST', url: BUDDY_RESPOND_PATH, headers: { host: '127.0.0.1:3082', cookie: 'dsh-auth-valid=v1.payload.sig', 'content-type': 'application/json' } }))
      request.destroyed = state.destroyed
      const statefulRequest = request as unknown as { aborted: boolean }
      statefulRequest.aborted = state.aborted
      const response = mockRes()
      await invoke(server, 'exact', BUDDY_RESPOND_PATH, request as unknown as IncomingMessage, response)
      expect(response.status).toBe(400)
      hub.dispose()
    }
  })

  it('returns 400 for malformed percent encoding in asset URL', async () => {
    const server = new MockWebServer() as unknown as WebServer & MockWebServer
    const store = new BuddyStore()
    const conn = new MockConnection() as unknown as HostConnectionHandle & MockConnection
    const hub = registerBuddyRoutes(server, store, '/tmp', conn, () => {})
    const req = mockReq({ method: 'GET', url: `${BUDDY_ASSET_PREFIX}/%ZZ`, headers: { host: '127.0.0.1:3082', cookie: 'dsh-auth-valid=v1.payload.sig' } })
    const res = mockRes()
    await invoke(server, 'prefix', BUDDY_ASSET_PREFIX, req, res)
    expect(res.status).toBe(400)
    hub.dispose()
  })

  it('serves authenticated assets with private no-store caching', async () => {
    const pageRoot = mkdtempSync(join(tmpdir(), 'dsh-buddy-page-'))
    try {
      writeFileSync(join(pageRoot, 'index.html'), '<!doctype html>')
      writeFileSync(join(pageRoot, 'buddy.css'), 'body {}')
      const server = new MockWebServer() as unknown as WebServer & MockWebServer
      const store = new BuddyStore()
      const conn = new MockConnection() as unknown as HostConnectionHandle & MockConnection
      const hub = registerBuddyRoutes(server, store, pageRoot, conn, () => {})
      const headers = { host: '127.0.0.1:3082', cookie: 'dsh-auth-valid=v1.payload.sig' }
      const pageResponse = mockRes()
      await invoke(server, 'exact', BUDDY_PAGE_PATH, mockReq({ method: 'GET', url: BUDDY_PAGE_PATH, headers }), pageResponse)
      expect(pageResponse.status).toBe(200)
      expect(pageResponse.headers?.['cache-control']).toBe('private, no-store')
      for (const method of ['GET', 'HEAD'] as const) {
        const response = mockRes()
        const finished = method === 'GET' ? new Promise<void>((resolve) => { response.once('finish', resolve) }) : undefined
        await invoke(server, 'prefix', BUDDY_ASSET_PREFIX, mockReq({ method, url: BUDDY_ASSET_PREFIX + '/buddy.css', headers }), response)
        if (finished !== undefined) await finished
        expect(response.status).toBe(200)
        expect(response.headers?.['cache-control']).toBe('private, no-store')
      }
      hub.dispose()
    } finally {
      rmSync(pageRoot, { recursive: true, force: true })
    }
  })

  it('rejects page and asset symlink escapes outside pageRoot', async () => {
    const pageRoot = mkdtempSync(join(tmpdir(), 'dsh-buddy-page-'))
    const outsideRoot = mkdtempSync(join(tmpdir(), 'dsh-buddy-outside-'))
    try {
      writeFileSync(join(outsideRoot, 'index.html'), 'outside page')
      writeFileSync(join(outsideRoot, 'secret.js'), 'outside asset')
      mkdirSync(join(outsideRoot, 'nested'))
      writeFileSync(join(outsideRoot, 'nested', 'secret.js'), 'outside nested asset')
      symlinkSync(join(outsideRoot, 'index.html'), join(pageRoot, 'index.html'))
      symlinkSync(join(outsideRoot, 'secret.js'), join(pageRoot, 'secret.js'))
      symlinkSync(join(outsideRoot, 'nested'), join(pageRoot, 'nested'), 'dir')

      const server = new MockWebServer() as unknown as WebServer & MockWebServer
      const store = new BuddyStore()
      const conn = new MockConnection() as unknown as HostConnectionHandle & MockConnection
      const hub = registerBuddyRoutes(server, store, pageRoot, conn, () => {})
      const headers = { host: '127.0.0.1:3082', cookie: 'dsh-auth-valid=v1.payload.sig' }

      const pageResponse = mockRes()
      await invoke(server, 'exact', BUDDY_PAGE_PATH, mockReq({ method: 'GET', url: BUDDY_PAGE_PATH, headers }), pageResponse)
      expect(pageResponse.status).toBe(404)

      const assetResponse = mockRes()
      await invoke(server, 'prefix', BUDDY_ASSET_PREFIX, mockReq({ method: 'GET', url: BUDDY_ASSET_PREFIX + '/secret.js', headers }), assetResponse)
      expect(assetResponse.status).toBe(404)

      const nestedAssetResponse = mockRes()
      await invoke(server, 'prefix', BUDDY_ASSET_PREFIX, mockReq({ method: 'GET', url: BUDDY_ASSET_PREFIX + '/nested/secret.js', headers }), nestedAssetResponse)
      expect(nestedAssetResponse.status).toBe(404)
      hub.dispose()
    } finally {
      rmSync(pageRoot, { recursive: true, force: true })
      rmSync(outsideRoot, { recursive: true, force: true })
    }
  })

  it('rejects Windows drive, UNC, and rooted asset paths', async () => {
    const server = new MockWebServer() as unknown as WebServer & MockWebServer
    const store = new BuddyStore()
    const conn = new MockConnection() as unknown as HostConnectionHandle & MockConnection
    const hub = registerBuddyRoutes(server, store, '/tmp', conn, () => {})
    const headers = { host: '127.0.0.1:3082', cookie: 'dsh-auth-valid=v1.payload.sig' }
    for (const suffix of ['C:%2Fetc%2Fpasswd', '%5C%5Cserver%5Cshare%5Csecret.js', '%2Fetc%2Fpasswd']) {
      const response = mockRes()
      await invoke(server, 'prefix', BUDDY_ASSET_PREFIX, mockReq({ method: 'GET', url: BUDDY_ASSET_PREFIX + '/' + suffix, headers }), response)
      expect(response.status).toBe(404)
    }
    hub.dispose()
  })

  it('returns 404 for missing asset', async () => {
    const server = new MockWebServer() as unknown as WebServer & MockWebServer
    const store = new BuddyStore()
    const conn = new MockConnection() as unknown as HostConnectionHandle & MockConnection
    const hub = registerBuddyRoutes(server, store, '/tmp', conn, () => {})
    const req = mockReq({ method: 'GET', url: `${BUDDY_ASSET_PREFIX}/nope.css`, headers: { host: '127.0.0.1:3082', cookie: 'dsh-auth-valid=v1.payload.sig' } })
    const res = mockRes()
    await invoke(server, 'prefix', BUDDY_ASSET_PREFIX, req, res)
    expect(res.status).toBe(404)
    hub.dispose()
  })
})
