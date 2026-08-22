import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { BUDDY_CLIENT_EVENTS_PATH } from '../contract.ts'

export const name = 'dsh-buddy-client'
export const inject = ['sessions']

export function apply(ctx: ClientContext): void {
  const open = (sessionId: string): void => {
    try {
      ctx.sessions.open(sessionId as never)
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
