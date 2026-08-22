import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, normalize, relative, sep } from 'node:path'
import type { BuddyClientFrame, BuddyKioskFrame, BuddySnapshot } from '../contract.ts'
import {
  BUDDY_ASSET_PREFIX,
  BUDDY_CLIENT_EVENTS_PATH,
  BUDDY_EVENTS_PATH,
  BUDDY_NAVIGATE_PATH,
  BUDDY_PAGE_PATH,
} from '../contract.ts'
import type { BuddyStore } from '../core/store.ts'

export interface WebServerService {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>
  }): () => void
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

export interface BuddyHub {
  broadcastKiosk(frame: BuddyKioskFrame): void
  broadcastClient(frame: BuddyClientFrame): void
}

export function registerBuddyRoutes(
  webServer: WebServerService,
  store: BuddyStore,
  pageRoot: string,
  onNavigate: (sessionId: string) => void,
): BuddyHub {
  const kioskClients = new Set<ServerResponse>()
  const guiClients = new Set<ServerResponse>()

  const send = (response: ServerResponse, payload: unknown, bucket: Set<ServerResponse>): void => {
    try {
      response.write(`data: ${JSON.stringify(payload)}\n\n`)
    } catch {
      bucket.delete(response)
      try { response.destroy() } catch { /* already gone */ }
    }
  }

  const broadcastKiosk = (frame: BuddyKioskFrame): void => {
    for (const response of [...kioskClients]) send(response, frame, kioskClients)
  }
  const broadcastClient = (frame: BuddyClientFrame): void => {
    for (const response of [...guiClients]) send(response, frame, guiClients)
  }

  const openSse = (req: IncomingMessage, res: ServerResponse, bucket: Set<ServerResponse>, hello: unknown): void => {
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET' })
      res.end()
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(': connected\n\n')
    send(res, hello, bucket)
    bucket.add(res)
    res.on('close', () => { bucket.delete(res) })
  }

  webServer.register({
    kind: 'exact',
    path: BUDDY_PAGE_PATH,
    async handler(req, res) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' })
        res.end()
        return
      }
      const html = await readFile(join(pageRoot, 'index.html'), 'utf8')
      res.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(Buffer.byteLength(html)),
      })
      res.end(req.method === 'HEAD' ? undefined : html)
    },
  })

  webServer.register({
    kind: 'exact',
    path: BUDDY_EVENTS_PATH,
    handler(req, res) {
      openSse(req, res, kioskClients, { type: 'snapshot', snapshot: store.snapshot() } satisfies BuddyKioskFrame)
    },
  })

  webServer.register({
    kind: 'exact',
    path: BUDDY_CLIENT_EVENTS_PATH,
    handler(req, res) {
      openSse(req, res, guiClients, { type: 'hello' } satisfies BuddyClientFrame)
    },
  })

  webServer.register({
    kind: 'exact',
    path: BUDDY_NAVIGATE_PATH,
    async handler(req, res) {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      let body: unknown
      try {
        body = await readJson(req)
      } catch {
        res.writeHead(400)
        res.end('invalid json')
        return
      }
      const sessionId = typeof (body as { sessionId?: unknown })?.sessionId === 'string'
        ? (body as { sessionId: string }).sessionId.trim()
        : ''
      if (sessionId === '') {
        res.writeHead(400)
        res.end('missing sessionId')
        return
      }
      onNavigate(sessionId)
      broadcastClient({ type: 'navigate', sessionId })
      res.writeHead(204)
      res.end()
    },
  })

  webServer.register({
    kind: 'prefix',
    path: BUDDY_ASSET_PREFIX,
    handler(req, res) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' })
        res.end()
        return
      }
      const url = new URL(req.url ?? '/', 'http://buddy.local')
      const relativeUrl = decodeURIComponent(url.pathname.slice(BUDDY_ASSET_PREFIX.length)).replace(/^\/+/, '')
      const resolved = normalize(join(pageRoot, relativeUrl))
      const rel = relative(pageRoot, resolved)
      if (rel.startsWith('..') || rel.split(sep).includes('..')) {
        res.writeHead(404)
        res.end()
        return
      }
      const type = MIME[extname(resolved)] ?? 'application/octet-stream'
      res.writeHead(200, {
        'content-type': type,
        'cache-control': 'no-store',
      })
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      const stream = createReadStream(resolved)
      stream.on('error', () => {
        if (!res.headersSent) res.writeHead(404)
        res.end()
      })
      stream.pipe(res)
    },
  })

  store.subscribe((snapshot: BuddySnapshot) => {
    broadcastKiosk({ type: 'snapshot', snapshot })
  })

  return { broadcastKiosk, broadcastClient }
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text === '' ? {} : JSON.parse(text) as unknown)
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}
