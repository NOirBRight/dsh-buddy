import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { BUDDY_CLIENT_EVENTS_PATH, BUDDY_CLIENT_RECONNECT_INTERVAL_MS, isValidSessionId } from '../contract.ts'

export const name = 'dsh-buddy-client'
export const inject = ['sessions']

const MAX_EVENT_DATA_BYTES = 512 * 1024
const UTF8_ENCODER = new TextEncoder()

type SessionOpener = {
  open(sessionId: SessionId): void
}

/** Brand a validated EventSource id before selecting a session. */
function brandSessionId(raw: string): SessionId {
  return raw as SessionId
}

export interface BuddyClientContext extends Pick<ClientContext, 'effect'> {
  readonly sessions: SessionOpener
}

/**
 * Own the GUI EventSource and reconnect timer in one effect. Navigation is
 * passed to the official session selector with a branded SessionId.
 * @param ctx - GUI context providing effect ownership and session selection.
 * @returns Nothing; the EventSource and reconnect timer are owned by the effect.
 */
export function apply(ctx: BuddyClientContext): void {
  const sessions = ctx.sessions
  let stream: EventSource | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let generation = 0
  let disposed = false

  const closeStream = (): void => {
    const current = stream
    stream = undefined
    if (current !== undefined) {
      try {
        current.close()
      } catch (_error) {
        // The browser already closed this EventSource.
      }
    }
  }

  const open = (raw: string): void => {
    if (!isValidSessionId(raw)) return
    try {
      sessions.open(brandSessionId(raw))
    } catch (_error) {
      // The Host may remove a session between the kiosk event and selection.
    }
  }

  const connect = (): void => {
    if (disposed) return
    generation += 1
    const currentGeneration = generation
    closeStream()
    try {
      const next = new EventSource(BUDDY_CLIENT_EVENTS_PATH)
      next.onmessage = (event) => {
        if (disposed || currentGeneration !== generation) return
        if (typeof event.data !== 'string' || UTF8_ENCODER.encode(event.data).byteLength > MAX_EVENT_DATA_BYTES) return
        try {
          const value: unknown = JSON.parse(event.data)
          if (!isJsonObject(value)) return
          if (value.type !== 'navigate' || !isValidSessionId(value.sessionId)) return
          open(value.sessionId)
        } catch (_error) {
          // One malformed server frame must not terminate EventSource handling.
        }
      }
      next.onerror = () => {
        if (stream === next) closeStream()
      }
      stream = next
    } catch (_error) {
      // Construction can fail under browser policy; the timer retries it.
      stream = undefined
    }
  }

  ctx.effect(() => {
    disposed = false
    try {
      connect()
      timer = setInterval(() => {
        if (disposed) return
        if (stream === undefined || stream.readyState === EventSource.CLOSED) connect()
      }, BUDDY_CLIENT_RECONNECT_INTERVAL_MS)
      return () => {
        if (disposed) return
        disposed = true
        generation += 1
        if (timer !== undefined) {
          clearInterval(timer)
          timer = undefined
        }
        closeStream()
      }
    } catch (error) {
      disposed = true
      generation += 1
      if (timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
      closeStream()
      throw error
    }
  }, 'dsh-buddy-client: transport')
}

function isJsonObject(value: unknown): value is { [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
