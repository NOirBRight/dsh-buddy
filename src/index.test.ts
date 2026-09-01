import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { apply, kioskLaunchUrl, kioskLaunchUrls } from './index.ts'

type Route = Parameters<WebServer['register']>[0]

type FakeWebServer = {
  host: string
  port: number
  register: (route: Route) => () => void
}

type FakeConnection = {
  authenticatedUrl: (base: string) => string
  requestRejection: () => undefined
  authorizeIndex: () => boolean
}

type FakeContextOptions = {
  webServer?: FakeWebServer
  connection?: FakeConnection
  sessions?: { list: () => never[] }
  agents?: { list: () => never[] }
  workspaceRegistry?: { archivedSessionIds: never[] } | undefined
}

function fakeContext(options: FakeContextOptions = {}): Context {
  const context = {
    webServer: {
      host: '127.0.0.1',
      port: 3082,
      register: (_route: Route) => () => {},
    },
    connection: {
      authenticatedUrl: (base: string) => base,
      requestRejection: () => undefined,
      authorizeIndex: () => true,
    },
    sessions: { list: () => [] },
    agents: { list: () => [] },
    workspaceRegistry: { archivedSessionIds: [] },
    effect: (fn: () => unknown) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanup()
      return () => {}
    },
    on: () => () => {},
    ...options,
  }
  // The fake context intentionally supplies only the services consumed by apply().
  return context as unknown as Context
}

describe('kioskLaunchUrls honest pair', () => {
  it('returns authenticateUrl (root token) and kioskUrl (/buddy) as pair', () => {
    const conn = { authenticatedUrl: (base: string) => base + '/?token=tok' } as unknown as HostConnectionHandle
    const urls = kioskLaunchUrls(conn, { publicBaseUrl: 'http://192.168.1.20:3082' }, { host: '0.0.0.0', port: 3082 })
    expect(urls.authenticateUrl).toBe('http://192.168.1.20:3082/?token=tok')
    expect(urls.kioskUrl).toBe('http://192.168.1.20:3082/buddy')
    expect(kioskLaunchUrl(conn, { publicBaseUrl: '' }, { host: '127.0.0.1', port: 3082 })).toContain('/?token=')
  })

  it('documents upstream redirect-target gap: authenticateUrl is always /', () => {
    const conn = { authenticatedUrl: (base: string) => new URL(base).origin + '/?token=tok' } as unknown as HostConnectionHandle
    const urls = kioskLaunchUrls(conn, { publicBaseUrl: '' }, { host: '127.0.0.1', port: 3082 })
    expect(new URL(urls.authenticateUrl).pathname).toBe('/')
    expect(new URL(urls.kioskUrl).pathname).toBe('/buddy')
  })
})

describe('Config validation', () => {
  it('rejects non-origin publicBaseUrl (credentials/path/query/hash)', () => {
    const ctx = fakeContext()
    expect(() => apply(ctx, { publicBaseUrl: 'http://user:pass@host:3082' })).toThrow(/credentials/)
    expect(() => apply(ctx, { publicBaseUrl: 'http://host:3082/path' })).toThrow(/origin without path/)
    expect(() => apply(ctx, { publicBaseUrl: 'http://host:3082?x=1' })).toThrow(/query/)
    expect(() => apply(ctx, { publicBaseUrl: 'http://host:3082?' })).toThrow(/query/)
    expect(() => apply(ctx, { publicBaseUrl: 'http://host:3082#hash' })).toThrow(/hash/)
    expect(() => apply(ctx, { publicBaseUrl: 'http://host:3082#' })).toThrow(/hash/)
    expect(() => apply(ctx, { publicBaseUrl: 'ftp://host:3082' })).toThrow(/http or https/)
  })

  it('fails when host is wildcard/non-loopback and publicBaseUrl is empty', () => {
    const wildcardCtx = fakeContext({ webServer: { host: '0.0.0.0', port: 3082, register: (_route: Route) => () => {} } })
    expect(() => apply(wildcardCtx, { publicBaseUrl: '' })).toThrow(/publicBaseUrl is required when webServer.host is "0.0.0.0"/)
    const lanCtx = fakeContext({ webServer: { host: '192.168.1.20', port: 3082, register: (_route: Route) => () => {} } })
    expect(() => apply(lanCtx, { publicBaseUrl: '' })).toThrow(/publicBaseUrl is required/)
    const loopbackCtx = fakeContext()
    expect(() => apply(loopbackCtx, { publicBaseUrl: '' })).not.toThrow()
  })

  it('requires positive archivePollMs and workspaceRegistry', () => {
    const base = fakeContext()
    expect(() => apply(base, { archivePollMs: 0 })).toThrow(/positive/)
    expect(() => apply(base, { archivePollMs: -1 })).toThrow()
    expect(() => apply(base, { archivePollMs: 2_147_483_648 })).toThrow(/no greater than 2147483647/)
    const noWorkspace = fakeContext({ workspaceRegistry: undefined })
    expect(() => apply(noWorkspace, {})).toThrow(/workspaceRegistry/)
  })

  it('fails initial seed before routes', () => {
    const ctx = fakeContext({
      webServer: { host: '127.0.0.1', port: 3082, register: () => { throw new Error('should not reach') } },
      sessions: { list: () => { throw new Error('seed fail') } },
    })
    expect(() => apply(ctx, {})).toThrow(/initial seed failed/)
  })
})
