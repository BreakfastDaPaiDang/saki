/** Cancellable long-poll cursor over committed control-plane invalidations. */
import { randomUUID } from 'node:crypto'
import type { SakiWireProjectionCursor } from './wire.ts'

/** One Host instance's disposable invalidation cursor; it carries no product data. */
export class ProjectionChanges {
  private cursor = randomUUID() as SakiWireProjectionCursor
  private readonly listeners = new Set<() => void>()
  private readonly lifetime = new AbortController()

  /** Publish a different cursor after a committed change. */
  invalidate(): void {
    this.cursor = randomUUID() as SakiWireProjectionCursor
    for (const listener of this.listeners) listener()
  }

  /** Cancel every outstanding wait before the Host contribution leaves. */
  dispose(): void {
    this.lifetime.abort(new Error('Saki projection watch disposed'))
  }

  /**
   * Wait until the supplied cursor differs or its bounded heartbeat expires.
   * @param previous - last observed cursor, or null for initial synchronization.
   * @param waitMs - validated deployment heartbeat interval.
   * @param signal - caller cancellation.
   * @returns current cursor; cancellation rejects after releasing the timer and listener.
   */
  wait(previous: SakiWireProjectionCursor | null, waitMs: number, signal: AbortSignal): Promise<SakiWireProjectionCursor> {
    const active = AbortSignal.any([signal, this.lifetime.signal])
    active.throwIfAborted()
    if (previous !== this.cursor) return Promise.resolve(this.cursor)
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        this.listeners.delete(changed)
        active.removeEventListener('abort', aborted)
      }
      const changed = () => { cleanup(); resolve(this.cursor) }
      const aborted = () => {
        cleanup()
        const reason: unknown = active.reason
        reject(reason instanceof Error ? reason : new Error('Saki projection watch canceled', { cause: reason }))
      }
      const timer = setTimeout(changed, waitMs)
      this.listeners.add(changed)
      active.addEventListener('abort', aborted, { once: true })
    })
  }
}
