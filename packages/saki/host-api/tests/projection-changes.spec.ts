import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectionChanges } from '../src/projection-changes.ts'

afterEach(() => { vi.useRealTimers() })

describe('Saki projection invalidation cursor', () => {
  it('wakes every observer and reports changes that precede a subscription', async () => {
    const changes = new ProjectionChanges()
    const signal = new AbortController().signal
    const initial = await changes.wait(null, 30_000, signal)
    const first = changes.wait(initial, 30_000, signal)
    const second = changes.wait(initial, 30_000, signal)
    changes.invalidate()
    const current = await first
    expect(current).not.toBe(initial)
    expect(await second).toBe(current)
    expect(await changes.wait(initial, 30_000, signal)).toBe(current)
    changes.dispose()
  })

  it('returns the same cursor at a heartbeat and releases its timer', async () => {
    vi.useFakeTimers()
    const changes = new ProjectionChanges()
    const signal = new AbortController().signal
    const initial = await changes.wait(null, 30_000, signal)
    const waiting = changes.wait(initial, 30_000, signal)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await waiting).toBe(initial)
    expect(vi.getTimerCount()).toBe(0)
    changes.dispose()
  })

  it('releases waits on caller cancellation and Host disposal', async () => {
    vi.useFakeTimers()
    const changes = new ProjectionChanges()
    const caller = new AbortController()
    const initial = await changes.wait(null, 30_000, caller.signal)
    const canceled = expect(changes.wait(initial, 30_000, caller.signal)).rejects.toThrow('caller canceled')
    caller.abort(new Error('caller canceled'))
    await canceled
    expect(vi.getTimerCount()).toBe(0)
    expect(() => changes.wait(initial, 30_000, caller.signal)).toThrow('caller canceled')
    const disposed = expect(changes.wait(initial, 30_000, new AbortController().signal)).rejects.toThrow('disposed')
    changes.dispose()
    await disposed
    expect(vi.getTimerCount()).toBe(0)
  })
  it('preserves a non-Error cancellation reason as the rejection cause', async () => {
    const changes = new ProjectionChanges()
    const caller = new AbortController()
    const initial = await changes.wait(null, 30_000, caller.signal)
    const canceled = expect(changes.wait(initial, 30_000, caller.signal)).rejects.toMatchObject({ cause: 'closed' })
    caller.abort('closed')
    await canceled
    changes.dispose()
  })
})
