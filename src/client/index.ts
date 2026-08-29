import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { BUDDY_CLIENT_EVENTS_PATH } from '../contract.ts'

export const name = 'dsh-buddy-client'
export const inject = ['sessions']

type SessionOpener = { open(sessionId: string): void }

export function apply(ctx: ClientContext): void {
  const sessions = (ctx as ClientContext & { sessions?: SessionOpener }).sessions
  const open = (sessionId: string): void => {
    try {
      sessions?.open(sessionId)
    } catch {
      // Session may have disappeared between the tap and the host fan-out.
    }
  }

  const connect = (): EventSource => {
    const stream = new EventSource(BUDDY_CLIENT_EVENTS_PATH)
    stream.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data) as { type?: unknown; sessionId?: unknown }
        if (frame.type === 'navigate' && typeof frame.sessionId === 'string' && frame.sessionId !== '') {
          open(frame.sessionId)
        }
      } catch {
        // Ignore one malformed frame; EventSource keeps the stream.
      }
    }
    return stream
  }

  let stream = connect()
  ctx.effect(() => () => {
    stream.close()
  })

  const timer = setInterval(() => {
    if (stream.readyState === EventSource.CLOSED) stream = connect()
  }, 4000)
  ctx.effect(() => () => { clearInterval(timer) })
}
