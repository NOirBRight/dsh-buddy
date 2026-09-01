import { constants as fsConstants, createReadStream } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, relative, resolve, sep, win32 } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { isValidSessionId } from '../contract.ts'
import type { BuddyClientFrame, BuddyInteraction, BuddyKioskFrame, BuddySnapshot } from '../contract.ts'
import {
  BUDDY_ASSET_PREFIX,
  BUDDY_CLIENT_EVENTS_PATH,
  BUDDY_EVENTS_PATH,
  BUDDY_NAVIGATE_PATH,
  BUDDY_PAGE_PATH,
  BUDDY_RESPOND_PATH,
} from '../contract.ts'
import { parseInteractionResponse, type InteractionResponseResult } from '../core/interactions.ts'
import type { BuddyStore } from '../core/store.ts'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

const MAX_NAVIGATE_BYTES = 8 * 1024
const MAX_INTERACTION_RESPONSE_BYTES = 512 * 1024
const MAX_PEER_QUEUE_ITEMS = 64
const MAX_PEER_QUEUE_BYTES = 512 * 1024
const READ_ONLY_NOFOLLOW = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
const READ_ONLY_DIRECTORY_NOFOLLOW = READ_ONLY_NOFOLLOW | (fsConstants.O_DIRECTORY ?? 0)

/** Brand a validated wire id before passing it to an official session API. */
function brandSessionId(raw: string): SessionId {
  return raw as SessionId
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

type OwnedCleanup = {
  active: boolean
  cleanup: () => void
}

type OwnedCleanupHandle = {
  deactivate: () => void
}

type PeerWriteQueue = {
  tail: Promise<void>
  items: number
  bytes: number
}

function isJsonValue(value: unknown): value is JsonValue {
  const pending: unknown[] = [value]
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === null || typeof current === 'boolean' || typeof current === 'number' || typeof current === 'string') continue
    if (Array.isArray(current)) {
      pending.push(...current)
      continue
    }
    if (typeof current !== 'object') return false
    pending.push(...Object.values(current))
  }
  return true
}

function isWithin(root: string, candidate: string): boolean {
  const windows = isWindowsPath(root) || isWindowsPath(candidate)
  const outside = windows
    ? win32.relative(win32.resolve(root), win32.resolve(candidate))
    : relative(root, candidate)
  return outside === '' || (outside !== '..' && !outside.startsWith('..' + (windows ? '\\' : sep)) && !outside.startsWith(sep) && !win32.isAbsolute(outside))
}

function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:/.test(value) || value.startsWith('//') || value.startsWith('\\')
}

async function resolvePageFile(pageRoot: string, relativeName: string): Promise<{ path: string; size: number; handle: FileHandle }> {
  if (isWindowsPath(relativeName)) throw new AssetNotFoundError()
  const rootPath = resolve(pageRoot)
  const rootMetadata = await lstat(rootPath)
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new AssetNotFoundError()
  const rootRealPath = await realpath(rootPath)
  const candidate = resolve(rootPath, relativeName)
  if (!isWithin(rootPath, candidate)) throw new AssetNotFoundError()
  const candidateMetadata = await lstat(candidate)
  if (candidateMetadata.isSymbolicLink()) throw new AssetNotFoundError()
  const candidateRealPath = await realpath(candidate)
  if (!isWithin(rootRealPath, candidateRealPath)) throw new AssetNotFoundError()
  const handle = await openPageFile(rootPath, rootRealPath, relativeName, candidate)
  const metadata = await handle.stat()
  if (!metadata.isFile()) {
    await handle.close()
    throw new AssetNotFoundError()
  }
  return { path: candidateRealPath, size: metadata.size, handle }
}

async function openPageFile(
  rootPath: string,
  rootRealPath: string,
  relativeName: string,
  candidate: string,
): Promise<FileHandle> {
  const fdPrefix = process.platform === 'linux' ? '/proc/self/fd' : process.platform === 'darwin' ? '/dev/fd' : undefined
  if (fdPrefix === undefined) {
    const handle = await open(candidate, READ_ONLY_NOFOLLOW)
    try {
      const openedPath = await realpath(candidate)
      if (!isWithin(rootRealPath, openedPath)) throw new AssetNotFoundError()
      return handle
    } catch (error) {
      await handle.close()
      throw error
    }
  }
  let directory: FileHandle | undefined
  try {
    directory = await open(rootPath, READ_ONLY_DIRECTORY_NOFOLLOW)
    const openedRootPath = await realpath(fdPrefix + '/' + String(directory.fd))
    if (openedRootPath !== rootRealPath) throw new AssetNotFoundError()
    const parts = relativeName.split(/[\\/]/).filter((part) => part !== '' && part !== '.')
    if (parts.length === 0) throw new AssetNotFoundError()
    for (const [index, part] of parts.entries()) {
      if (part === '..') throw new AssetNotFoundError()
      const target = fdPrefix + '/' + String(directory.fd) + '/' + part
      let next: FileHandle | undefined
      try {
        try {
          next = await open(target, index === parts.length - 1 ? READ_ONLY_NOFOLLOW : READ_ONLY_DIRECTORY_NOFOLLOW)
        } catch (error) {
          if (isLinkTraversalError(error)) throw new AssetNotFoundError()
          throw error
        }
        if (index === parts.length - 1) {
          await directory.close()
          directory = undefined
          return next
        }
        const metadata = await next.stat()
        if (!metadata.isDirectory()) throw new AssetNotFoundError()
        const previous = directory
        await previous.close()
        directory = next
        next = undefined
      } catch (error) {
        if (next !== undefined) await next.close()
        throw error
      }
    }
    throw new AssetNotFoundError()
  } finally {
    if (directory !== undefined) await directory.close()
  }
}

function isLinkTraversalError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ELOOP' || error.code === 'ENOTDIR')
}

export interface BuddyHub {
  broadcastKiosk(frame: BuddyKioskFrame): void
  broadcastClient(frame: BuddyClientFrame): void
  readonly kioskClients: Set<ServerResponse>
  readonly guiClients: Set<ServerResponse>
  dispose(): void
}

/**
 * Register authenticated Buddy HTTP routes and own their SSE and asset resources.
 * @param webServer - Host web-server route registry.
 * @param store - Buddy session projection.
 * @param pageRoot - directory containing the shipped page and assets.
 * @param connection - official Host Connection authentication service.
 * @param onNavigate - callback for a validated session navigation.
 * @param onInteractionResponse - callback for a validated page response body; callback failures return HTTP 500.
 * @param pendingInteractions - callback used to replay pending interactions on SSE connect.
 * @param onKioskAvailabilityChanged - callback after the last kiosk response is removed.
 * @returns the route hub and its lifecycle controls.
 */
export function registerBuddyRoutes(
  webServer: WebServer,
  store: BuddyStore,
  pageRoot: string,
  connection: HostConnectionHandle,
  onNavigate: (sessionId: SessionId) => void | Promise<void>,
  onInteractionResponse: (raw: unknown) => InteractionResponseResult = () => 'unknown',
  pendingInteractions: () => readonly BuddyInteraction[] = () => [],
  onKioskAvailabilityChanged: (available: boolean) => void = () => {},
): BuddyHub {
  const kioskClients = new Set<ServerResponse>()
  const guiClients = new Set<ServerResponse>()
  const assetStreams = new Set<ReturnType<typeof createReadStream>>()
  const assetResponses = new Set<ServerResponse>()
  const owned = new Set<OwnedCleanup>()
  const peerCleanups = new Map<ServerResponse, OwnedCleanupHandle>()
  const peerErrorListeners = new Map<ServerResponse, (error: Error) => void>()
  const peerWriteQueues = new Map<ServerResponse, PeerWriteQueue>()
  const root = resolve(pageRoot)
  let disposed = false

  const own = (cleanup: () => void): OwnedCleanupHandle => {
    const entry: OwnedCleanup = { active: true, cleanup }
    owned.add(entry)
    return {
      deactivate: () => {
        if (!entry.active) return
        entry.active = false
        owned.delete(entry)
      },
    }
  }

  const forgetPeer = (response: ServerResponse): void => {
    const cleanup = peerCleanups.get(response)
    cleanup?.deactivate()
    peerCleanups.delete(response)
    peerWriteQueues.delete(response)
    const errorListener = peerErrorListeners.get(response)
    peerErrorListeners.delete(response)
    if (errorListener !== undefined) response.removeListener('error', errorListener)
  }

  const removeClient = (bucket: Set<ServerResponse>, response: ServerResponse): void => {
    const removed = bucket.delete(response)
    forgetPeer(response)
    if (removed && bucket === kioskClients && kioskClients.size === 0) onKioskAvailabilityChanged(false)
  }

  const closeResponse = (response: ServerResponse): void => {
    const failures: unknown[] = []
    if (!response.writableEnded && !response.destroyed) {
      try {
        response.end()
      } catch (error) {
        failures.push(error)
      }
    }
    if (!response.destroyed) {
      try {
        response.destroy()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'dsh-buddy response cleanup failed')
  }

  const destroyStream = (stream: ReturnType<typeof createReadStream>): void => {
    if (stream.destroyed) return
    stream.destroy()
  }

  const failPeer = (response: ServerResponse, bucket: Set<ServerResponse>): void => {
    const failures: unknown[] = []
    try {
      removeClient(bucket, response)
    } catch (error) {
      appendCleanupErrors(failures, error)
    }
    try {
      closeResponse(response)
    } catch (error) {
      appendCleanupErrors(failures, error)
    }
    reportAsyncCleanupFailures('dsh-buddy peer cleanup failed', failures)
  }

  const waitForDrain = (response: ServerResponse): Promise<void> => new Promise((resolveWait, rejectWait) => {
    let settled = false
    const cleanup = (): void => {
      for (const [event, listener] of [['drain', onDrain], ['error', onError], ['close', onClose]] as const) {
        try {
          response.removeListener(event, listener)
        } catch (_error) {
          // Waiter cleanup must not escape the response event callback.
        }
      }
    }
    const settle = (error?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error === undefined) resolveWait()
      else rejectWait(error)
    }
    const onDrain = (): void => settle()
    const onError = (error: Error): void => settle(error)
    const onClose = (): void => settle(new Error('peer closed before drain'))
    try {
      response.once('drain', onDrain)
      response.once('error', onError)
      response.once('close', onClose)
    } catch (error) {
      settle(error instanceof Error ? error : new Error(String(error)))
      return
    }
    if (response.destroyed || response.writableEnded) onClose()
  })

  const trackWrite = (
    response: ServerResponse,
    bucket: Set<ServerResponse>,
    queue: PeerWriteQueue,
    lineBytes: number,
    operation: Promise<void>,
  ): void => {
    queue.items += 1
    queue.bytes += lineBytes
    const handled = operation.catch(() => {
      failPeer(response, bucket)
    })
    queue.tail = handled
    peerWriteQueues.set(response, queue)
    void handled.then(() => {
      queue.items -= 1
      queue.bytes -= lineBytes
      if (queue.items === 0 && peerWriteQueues.get(response) === queue) peerWriteQueues.delete(response)
    })
  }

  const queueWrite = (response: ServerResponse, bucket: Set<ServerResponse>, line: string): void => {
    if (!bucket.has(response)) return
    const lineBytes = Buffer.byteLength(line, 'utf8')
    const previous = peerWriteQueues.get(response)
    if (previous === undefined) {
      try {
        if (response.write(line)) return
      } catch (_error) {
        failPeer(response, bucket)
        return
      }
      if (lineBytes > MAX_PEER_QUEUE_BYTES) {
        failPeer(response, bucket)
        return
      }
      trackWrite(response, bucket, { tail: Promise.resolve(), items: 0, bytes: 0 }, lineBytes, waitForDrain(response))
      return
    }
    if (previous.items >= MAX_PEER_QUEUE_ITEMS || previous.bytes + lineBytes > MAX_PEER_QUEUE_BYTES) {
      failPeer(response, bucket)
      return
    }
    trackWrite(response, bucket, previous, lineBytes, previous.tail.then(async () => {
      if (!bucket.has(response)) return
      if (!response.write(line)) await waitForDrain(response)
    }))
  }

  const send = (response: ServerResponse, payload: BuddyKioskFrame | BuddyClientFrame, bucket: Set<ServerResponse>): void => {
    let encoded: string | undefined
    try {
      encoded = JSON.stringify(payload)
    } catch (_error) {
      failPeer(response, bucket)
      return
    }
    if (encoded === undefined) {
      failPeer(response, bucket)
      return
    }
    queueWrite(response, bucket, 'data: ' + encoded + '\n\n')
  }

  const broadcastKiosk = (frame: BuddyKioskFrame): void => {
    for (const response of [...kioskClients]) send(response, frame, kioskClients)
  }

  const broadcastClient = (frame: BuddyClientFrame): void => {
    for (const response of [...guiClients]) send(response, frame, guiClients)
  }

  const openSse = (
    response: ServerResponse,
    bucket: Set<ServerResponse>,
    hello: BuddyKioskFrame | BuddyClientFrame,
    initialFrames: readonly BuddyKioskFrame[] = [],
  ): void => {
    bucket.add(response)
    const peerCleanup = own(() => {
      bucket.delete(response)
      forgetPeer(response)
      closeResponse(response)
    })
    peerCleanups.set(response, peerCleanup)
    const onError = (_error: Error): void => {
      failPeer(response, bucket)
    }
    peerErrorListeners.set(response, onError)
    try {
      response.on('close', () => {
        const failures: unknown[] = []
        try {
          removeClient(bucket, response)
        } catch (error) {
          appendCleanupErrors(failures, error)
        }
        reportAsyncCleanupFailures('dsh-buddy peer cleanup failed', failures)
      })
      response.on('error', onError)
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      queueWrite(response, bucket, ': connected\n\n')
      send(response, hello, bucket)
      for (const frame of initialFrames) send(response, frame, bucket)
    } catch (error) {
      const failures: unknown[] = []
      appendCleanupErrors(failures, error)
      try {
        removeClient(bucket, response)
      } catch (cleanupError) {
        appendCleanupErrors(failures, cleanupError)
      }
      try {
        closeResponse(response)
      } catch (cleanupError) {
        appendCleanupErrors(failures, cleanupError)
      }
      throw new AggregateError(failures, 'dsh-buddy peer setup failed', { cause: error })
    }
  }

  const safeRegister = (route: Parameters<WebServer['register']>[0]): void => {
    own(webServer.register(route))
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    const failures: unknown[] = []
    const entries = [...owned].reverse()
    owned.clear()
    for (const entry of entries) {
      if (!entry.active) continue
      entry.active = false
      try {
        entry.cleanup()
      } catch (error) {
        appendCleanupErrors(failures, error)
      }
    }
    peerCleanups.clear()
    assetStreams.clear()
    assetResponses.clear()
    if (failures.length > 0) throw new AggregateError(failures, 'dsh-buddy route cleanup failed')
  }

  const unauthenticated = (req: IncomingMessage, res: ServerResponse): boolean => {
    const rejection = connection.requestRejection({ headers: req.headers })
    if (rejection === undefined) return false
    rejectRequest(req, res, rejection, rejection === 401 ? 'unauthorized' : 'forbidden')
    return true
  }

  const pageHandler = (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (unauthenticated(req, res)) return Promise.resolve()
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      rejectRequest(req, res, 405, undefined, { allow: 'GET, HEAD' })
      return Promise.resolve()
    }
    return resolvePageFile(root, 'index.html').then(async ({ handle }) => {
      try {
        return await handle.readFile({ encoding: 'utf8' })
      } finally {
        await handle.close()
      }
    }).then((html) => {
      if (res.destroyed) return
      const length = Buffer.byteLength(html)
      if (!res.headersSent) {
        res.writeHead(200, {
          'cache-control': 'private, no-store',
          'content-type': 'text/html; charset=utf-8',
          'content-length': String(length),
        })
      }
      if (req.method === 'HEAD') res.end()
      else res.end(html)
    }).catch((_error) => {
      rejectRequest(req, res, 404)
    })
  }

  const eventsHandler = (req: IncomingMessage, res: ServerResponse): void => {
    if (unauthenticated(req, res)) return
    if (req.method !== 'GET') {
      rejectRequest(req, res, 405, undefined, { allow: 'GET' })
      return
    }
    openSse(
      res,
      kioskClients,
      { type: 'snapshot', snapshot: store.snapshot() },
      pendingInteractions().map((interaction) => ({ type: 'interaction-requested', interaction })),
    )
  }

  const clientEventsHandler = (req: IncomingMessage, res: ServerResponse): void => {
    if (unauthenticated(req, res)) return
    if (req.method !== 'GET') {
      rejectRequest(req, res, 405, undefined, { allow: 'GET' })
      return
    }
    openSse(res, guiClients, { type: 'hello' })
  }

  const navigateHandler = (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (unauthenticated(req, res)) return Promise.resolve()
    if (req.method !== 'POST') {
      rejectBodyRequest(req, res, 405, undefined, { allow: 'POST' })
      return Promise.resolve()
    }
    const contentType = (req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase()
    if (contentType !== 'application/json') {
      rejectBodyRequest(req, res, 415, 'content type must be application/json')
      return Promise.resolve()
    }
    const length = declaredLength(req)
    if (length === 'invalid') {
      rejectBodyRequest(req, res, 400, 'invalid content length')
      return Promise.resolve()
    }
    if (length > MAX_NAVIGATE_BYTES) {
      rejectBodyRequest(req, res, 413, 'payload too large')
      return Promise.resolve()
    }
    return readJsonBounded(req, MAX_NAVIGATE_BYTES).then((body) => {
      if (!isJsonObject(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'sessionId')) {
        finishResponse(res, 400, 'invalid body')
        return
      }
      const raw = body.sessionId
      if (!isValidSessionId(raw)) {
        finishResponse(res, 400, 'invalid sessionId')
        return
      }
      if (!store.hasSession(raw)) {
        finishResponse(res, 404, 'unknown sessionId')
        return
      }
      const sessionId = brandSessionId(raw)
      return Promise.resolve().then(() => onNavigate(sessionId)).then(() => {
        broadcastClient({ type: 'navigate', sessionId: raw })
        finishResponse(res, 204)
      }).catch((_error) => {
        finishResponse(res, 500, 'navigation failed')
      })
    }).catch((error) => {
      if (error instanceof PayloadTooLargeError) finishResponse(res, 413, 'payload too large')
      else finishResponse(res, 400, 'invalid json')
    })
  }

  const respondHandler = (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (unauthenticated(req, res)) return Promise.resolve()
    if (req.method !== 'POST') {
      rejectBodyRequest(req, res, 405, undefined, { allow: 'POST' })
      return Promise.resolve()
    }
    const contentType = (req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase()
    if (contentType !== 'application/json') {
      rejectBodyRequest(req, res, 415, 'content type must be application/json')
      return Promise.resolve()
    }
    const length = declaredLength(req)
    if (length === 'invalid') {
      rejectBodyRequest(req, res, 400, 'invalid content length')
      return Promise.resolve()
    }
    if (length > MAX_INTERACTION_RESPONSE_BYTES) {
      rejectBodyRequest(req, res, 413, 'payload too large')
      return Promise.resolve()
    }
    return readJsonBounded(req, MAX_INTERACTION_RESPONSE_BYTES).then((body) => {
      try {
        parseInteractionResponse(body)
      } catch (_error) {
        finishResponse(res, 400, 'invalid body')
        return
      }
      let result: InteractionResponseResult
      try {
        result = onInteractionResponse(body)
      } catch (_error) {
        finishResponse(res, 500, 'interaction response failed')
        return
      }
      finishResponse(res, result === 'accepted' ? 204 : 404, result === 'accepted' ? undefined : 'unknown interaction')
    }, (error) => {
      if (error instanceof PayloadTooLargeError) finishResponse(res, 413, 'payload too large')
      else finishResponse(res, 400, 'invalid json')
    })
  }

  const assetHandler = (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (unauthenticated(req, res)) return Promise.resolve()
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      rejectRequest(req, res, 405, undefined, { allow: 'GET, HEAD' })
      return Promise.resolve()
    }
    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', 'http://dsh-buddy.invalid').pathname
    } catch (_error) {
      rejectRequest(req, res, 400)
      return Promise.resolve()
    }
    const encodedRelative = pathname.slice(BUDDY_ASSET_PREFIX.length)
    if (!encodedRelative.startsWith('/')) {
      rejectRequest(req, res, 404)
      return Promise.resolve()
    }
    let decoded: string
    try {
      decoded = decodeURIComponent(encodedRelative.slice(1))
    } catch (_error) {
      rejectRequest(req, res, 400)
      return Promise.resolve()
    }
    if (decoded === '' || isWindowsPath(decoded) || decoded.startsWith('/') || decoded.split(/[\\/]/).some((part) => part === '..')) {
      rejectRequest(req, res, 404)
      return Promise.resolve()
    }
    const relativeName = decoded
    const candidate = resolve(root, relativeName)
    if (!isWithin(root, candidate)) {
      rejectRequest(req, res, 404)
      return Promise.resolve()
    }
    return resolvePageFile(root, relativeName).then(async ({ path, size, handle }) => {
      const contentType = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
      if (req.method === 'HEAD') {
        await handle.close()
        res.writeHead(200, { 'cache-control': 'private, no-store', 'content-type': contentType, 'content-length': String(size) })
        res.end()
        return
      }
      let stream: ReturnType<typeof createReadStream>
      let handleClosed = false
      const closeHandle = (): void => {
        if (handleClosed) return
        handleClosed = true
        void handle.close().catch((error: unknown) => {
          if (!isBadFileDescriptorError(error)) reportAsyncCleanupFailures('dsh-buddy asset handle cleanup failed', [error])
        })
      }
      try {
        stream = createReadStream(path, { fd: handle.fd, autoClose: false })
        stream.once('close', closeHandle)
      } catch (error) {
        try {
          await handle.close()
        } catch (closeError) {
          throw new AggregateError([error, closeError], 'dsh-buddy asset open cleanup failed', { cause: error })
        }
        throw error
      }
      assetStreams.add(stream)
      assetResponses.add(res)
      const peerCleanup = own(() => {
        peerCleanups.delete(res)
        assetStreams.delete(stream)
        assetResponses.delete(res)
        const failures: unknown[] = []
        try {
          closeResponse(res)
        } catch (error) {
          appendCleanupErrors(failures, error)
        }
        try {
          stream.destroy()
        } catch (error) {
          appendCleanupErrors(failures, error)
        }
        if (failures.length > 0) throw new AggregateError(failures, 'dsh-buddy asset cleanup failed')
      })
      peerCleanups.set(res, peerCleanup)
      const remove = (): void => {
        assetStreams.delete(stream)
        assetResponses.delete(res)
        forgetPeer(res)
      }
      stream.on('close', remove)
      stream.on('error', () => {
        const failures: unknown[] = []
        remove()
        try {
          if (!res.headersSent) rejectRequest(req, res, 404)
          else if (!res.writableEnded) closeResponse(res)
        } catch (error) {
          appendCleanupErrors(failures, error)
        }
        reportAsyncCleanupFailures('dsh-buddy asset peer cleanup failed', failures)
      })
      res.on('close', () => {
        const failures: unknown[] = []
        remove()
        try {
          destroyStream(stream)
        } catch (error) {
          appendCleanupErrors(failures, error)
        }
        reportAsyncCleanupFailures('dsh-buddy asset peer cleanup failed', failures)
      })
      if (disposed || res.destroyed) {
        stream.destroy()
        return
      }
      res.writeHead(200, { 'cache-control': 'private, no-store', 'content-type': contentType, 'content-length': String(size) })
      stream.pipe(res)
    }).catch((error) => {
      if (isMissingAssetError(error)) {
        rejectRequest(req, res, 404)
        return
      }
      throw error
    })
  }

  try {
    own(store.subscribe((snapshot: BuddySnapshot) => {
      broadcastKiosk({ type: 'snapshot', snapshot })
    }))
    safeRegister({ kind: 'exact', path: BUDDY_PAGE_PATH, handler: pageHandler })
    safeRegister({ kind: 'exact', path: BUDDY_EVENTS_PATH, handler: eventsHandler })
    safeRegister({ kind: 'exact', path: BUDDY_CLIENT_EVENTS_PATH, handler: clientEventsHandler })
    safeRegister({ kind: 'exact', path: BUDDY_NAVIGATE_PATH, handler: navigateHandler })
    safeRegister({ kind: 'exact', path: BUDDY_RESPOND_PATH, handler: respondHandler })
    safeRegister({ kind: 'prefix', path: BUDDY_ASSET_PREFIX, handler: assetHandler })
  } catch (error) {
    try {
      dispose()
    } catch (cleanupError) {
      const failures: unknown[] = [error]
      appendCleanupErrors(failures, cleanupError)
      throw new AggregateError(failures, 'dsh-buddy route registration failed', { cause: error })
    }
    throw error
  }

  return { broadcastKiosk, broadcastClient, kioskClients, guiClients, dispose }
}

class PayloadTooLargeError extends Error {}
class AssetNotFoundError extends Error {}

function isBadFileDescriptorError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EBADF'
}

function isMissingAssetError(error: unknown): boolean {
  if (error instanceof AssetNotFoundError) return true
  if (error instanceof AggregateError) return error.errors.length > 0 && error.errors.every((nested) => isMissingAssetError(nested))
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function appendCleanupErrors(target: unknown[], error: unknown): void {
  if (error instanceof AggregateError) {
    for (const nested of error.errors) appendCleanupErrors(target, nested)
    return
  }
  target.push(error)
}

function reportAsyncCleanupFailures(label: string, failures: readonly unknown[]): void {
  if (failures.length === 0) return
  try {
    console.error(new AggregateError([...failures], label))
  } catch (_error) {
    // Logging must not escape an asynchronous Node event callback.
  }
}

function finishResponse(
  response: ServerResponse,
  status: number,
  body?: string,
  headers?: Record<string, string>,
): void {
  if (response.destroyed || response.writableEnded) return
  if (!response.headersSent) response.writeHead(status, headers)
  response.end(body)
}

function destroyRequest(req: IncomingMessage): void {
  if (req.destroyed) return
  req.destroy()
}

function discardRequest(req: IncomingMessage): void {
  try {
    destroyRequest(req)
  } catch (_error) {
    // Request disposal is best effort; preserve the validation response.
  }
}

function rejectRequest(
  req: IncomingMessage,
  response: ServerResponse,
  status: number,
  body?: string,
  headers?: Record<string, string>,
): void {
  discardRequest(req)
  finishResponse(response, status, body, headers)
}

function rejectBodyRequest(
  req: IncomingMessage,
  response: ServerResponse,
  status: number,
  body?: string,
  headers?: Record<string, string>,
): void {
  rejectRequest(req, response, status, body, headers)
}

function declaredLength(req: IncomingMessage): number | 'invalid' {
  const value = req.headers['content-length']
  if (value === undefined) return 0
  const length = Number(value)
  if (!Number.isSafeInteger(length) || length < 0) return 'invalid'
  return length
}

function readJsonBounded(req: IncomingMessage, maxBytes: number): Promise<JsonValue> {
  return new Promise((resolveJson, rejectJson) => {
    const length = declaredLength(req)
    if (length === 'invalid') {
      discardRequest(req)
      rejectJson(new Error('invalid content length'))
      return
    }
    if (length > maxBytes) {
      discardRequest(req)
      rejectJson(new PayloadTooLargeError())
      return
    }
    if (req.aborted || req.destroyed) {
      discardRequest(req)
      rejectJson(new Error(req.aborted ? 'request aborted before body read' : 'request closed before body read'))
      return
    }
    let received = 0
    const chunks: Buffer[] = []
    let finished = false
    const cleanup = (): void => {
      for (const [event, listener] of [
        ['data', onData],
        ['end', onEnd],
        ['error', onError],
        ['aborted', onAborted],
        ['close', onClose],
      ] as const) {
        try {
          req.removeListener(event, listener)
        } catch (_error) {
          // Listener cleanup must not replace or prevent the first request error.
        }
      }
    }
    const settleError = (error: unknown): void => {
      if (finished) return
      finished = true
      cleanup()
      rejectJson(error)
    }
    const onData = (chunk: Buffer | string): void => {
      if (finished) return
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      received += bytes.byteLength
      if (received > maxBytes) {
        settleError(new PayloadTooLargeError())
        discardRequest(req)
        return
      }
      chunks.push(bytes)
    }
    const onEnd = (): void => {
      if (finished) return
      finished = true
      cleanup()
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        if (text === '') {
          resolveJson({})
          return
        }
        const value: unknown = JSON.parse(text)
        if (!isJsonValue(value)) throw new Error('invalid json value')
        resolveJson(value)
      } catch (error) {
        rejectJson(error)
      }
    }
    const onError = (error: Error): void => {
      settleError(error)
    }
    const onAborted = (): void => {
      settleError(new Error('request aborted'))
    }
    const onClose = (): void => {
      settleError(new Error('request closed before request body completed'))
    }
    try {
      req.on('data', onData)
      req.on('end', onEnd)
      req.on('error', onError)
      req.on('aborted', onAborted)
      req.on('close', onClose)
    } catch (error) {
      discardRequest(req)
      settleError(error)
      return
    }
    if (req.aborted) onAborted()
    else if (req.destroyed) onClose()
  })
}

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
