/** Global concurrency admission for complete GitHub scans. @module @breakfastdapaidang/saki-github-app/scan-gate */

interface PendingScan<T> {
  readonly signal: AbortSignal
  readonly task: () => Promise<T>
  readonly resolve: (value: T | PromiseLike<T>) => void
  readonly reject: (reason?: unknown) => void
  readonly onAbort: () => void
}

/** FIFO semaphore whose permits cover whole complete scans, not individual pages. */
export class ScanConcurrencyGate {
  private readonly pending: PendingScan<unknown>[] = []
  private active = 0

  /** @param limit - positive maximum number of active complete scans. */
  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('scan concurrency limit must be a positive integer')
  }

  /**
   * Run one complete scan after global admission.
   * @param signal - caller lifetime; cancellation removes pending work.
   * @param task - complete scan whose lifetime owns one permit.
   * @returns the scan result.
   */
  run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    if (signal.aborted) return Promise.reject(cancellationError())
    return new Promise<T>((resolve, reject) => {
      const entry: PendingScan<T> = {
        signal,
        task,
        resolve,
        reject,
        onAbort: () => {
          const index = this.pending.indexOf(entry as PendingScan<unknown>)
          this.pending.splice(index, 1)
          reject(cancellationError())
        },
      }
      signal.addEventListener('abort', entry.onAbort, { once: true })
      this.pending.push(entry as PendingScan<unknown>)
      this.drain()
    })
  }

  private drain(): void {
    while (this.active < this.limit) {
      const entry = this.pending.shift()
      if (entry === undefined) return
      entry.signal.removeEventListener('abort', entry.onAbort)
      this.active += 1
      void Promise.resolve().then(async () => {
        entry.signal.throwIfAborted()
        return await entry.task()
      }).then(entry.resolve, entry.reject).finally(() => {
        this.active -= 1
        this.drain()
      })
    }
  }
}

function cancellationError(): Error {
  return new Error('GitHub operation cancelled')
}
