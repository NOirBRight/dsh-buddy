import { describe, expect, it } from 'vitest'
import { apply } from './index.ts'

type Cleanup = () => void

type LifecycleOptions = {
  readonly failures?: ReadonlyMap<string, unknown>
  readonly effectError?: unknown
}

type LifecycleHarness = {
  readonly ctx: Parameters<typeof apply>[0]
  readonly cleanupAttempts: string[]
  readonly cleanup: Cleanup
}

const cleanupOrder = [
  'user-questions/request',
  'approval/request',
  'agent/status',
  'session/event',
  'session/disposed',
  'session/created',
]

function makeLifecycleHarness(options: LifecycleOptions = {}): LifecycleHarness {
  const cleanupAttempts: string[] = []
  let cleanup: Cleanup | undefined
  const failures = options.failures ?? new Map<string, unknown>()

  const context = {
    webServer: {
      host: '127.0.0.1',
      port: 3082,
      register: (_route: unknown): Cleanup => () => {},
    },
    connection: {
      authenticatedUrl: (origin: string): string => origin,
      requestRejection: (): undefined => undefined,
    },
    sessions: { list: (): never[] => [] },
    agents: { list: (): never[] => [] },
    workspaceRegistry: { archivedSessionIds: [] },
    effect: (setup: () => Cleanup): Cleanup => {
      const effectCleanup = setup()
      cleanup = effectCleanup
      if (options.effectError !== undefined) throw options.effectError
      return effectCleanup
    },
    on: (name: string): Cleanup => () => {
      cleanupAttempts.push(name)
      const failure = failures.get(name)
      if (failure !== undefined) throw failure
    },
  }

  return {
    ctx: context as unknown as Parameters<typeof apply>[0],
    cleanupAttempts,
    cleanup: () => {
      if (cleanup === undefined) throw new Error('lifecycle effect did not install cleanup')
      cleanup()
    },
  }
}

function thrownBy(action: () => void): unknown {
  try {
    action()
  } catch (error) {
    return error
  }
  throw new Error('expected action to throw')
}

describe('apply lifecycle cleanup', () => {
  it('runs registered cleanup in reverse registration order', () => {
    const harness = makeLifecycleHarness()

    apply(harness.ctx)
    harness.cleanup()

    expect(harness.cleanupAttempts).toEqual(cleanupOrder)
  })

  it('attempts every cleanup after the first cleanup failure', () => {
    const failure = new Error('question cleanup failed')
    const harness = makeLifecycleHarness({
      failures: new Map([['user-questions/request', failure]]),
    })

    apply(harness.ctx)
    const thrown = thrownBy(harness.cleanup)

    expect(harness.cleanupAttempts).toEqual(cleanupOrder)
    expect(thrown).toBeInstanceOf(AggregateError)
  })

  it('is idempotent after cleanup fails', () => {
    const harness = makeLifecycleHarness({
      failures: new Map([['user-questions/request', new Error('question cleanup failed')]]),
    })

    apply(harness.ctx)
    expect(() => harness.cleanup()).toThrow(AggregateError)
    expect(() => harness.cleanup()).not.toThrow()

    expect(harness.cleanupAttempts).toEqual(cleanupOrder)
  })

  it('exposes every cleanup failure through AggregateError.errors', () => {
    const questionFailure = new Error('question cleanup failed')
    const eventFailure = new Error('event cleanup failed')
    const harness = makeLifecycleHarness({
      failures: new Map([
        ['user-questions/request', questionFailure],
        ['session/event', eventFailure],
      ]),
    })

    apply(harness.ctx)
    const thrown = thrownBy(harness.cleanup)

    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors).toEqual([questionFailure, eventFailure])
  })

  it('keeps startup failure as the primary error and cause when cleanup also fails', () => {
    const startupFailure = new Error('effect startup failed')
    const cleanupFailure = new Error('question cleanup failed')
    const harness = makeLifecycleHarness({
      effectError: startupFailure,
      failures: new Map([['user-questions/request', cleanupFailure]]),
    })

    const thrown = thrownBy(() => apply(harness.ctx))

    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors).toEqual([startupFailure, cleanupFailure])
    expect((thrown as AggregateError).cause).toBe(startupFailure)
    expect(harness.cleanupAttempts).toEqual(cleanupOrder)
  })
})
