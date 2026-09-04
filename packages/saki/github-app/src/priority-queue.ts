/** Per-authority API-call serialization with stable interactive priority. @module @breakfastdapaidang/saki-github-app/priority-queue */

/** Priorities for Product App requests and scan pages. */
export type GitHubRequestPriority = 'interactive' | 'background'

interface QueueEntry<T> {
  readonly ordinal: number
  readonly priority: GitHubRequestPriority
  readonly signal: AbortSignal
  readonly task: () => Promise<T>
  readonly resolve: (value: T | PromiseLike<T>) => void
  readonly reject: (reason?: unknown) => void
  readonly onAbort: () => void
}

const priorityRank = (priority: GitHubRequestPriority): number => priority === 'interactive' ? 0 : 1

/**
 * Concurrency-one queue for requests sharing one GitHub rate-limit authority.
 * The provider owns one queue per installation and one separate anonymous queue.
 * A scan releases the queue after every page, so an interactive request can
 * overtake background pages that have not started.
 */
export class InstallationPriorityQueue {
  private readonly pending: QueueEntry<unknown>[] = []
  private nextOrdinal = 0
  private active = false

  /**
   * Schedule one API call.
   * @param priority - interactive work sorts before queued background work.
   * @param signal - caller lifetime; cancellation removes work that has not started.
   * @param task - one bounded API call, never a complete multi-page scan.
   * @returns the task result after this authority's earlier selected call settles.
   */
  run<T>(priority: GitHubRequestPriority, signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    if (signal.aborted) return Promise.reject(cancellationError())
    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry<T> = {
        ordinal: this.nextOrdinal++,
        priority,
        signal,
        task,
        resolve,
        reject,
        onAbort: () => {
          const index = this.pending.indexOf(entry as QueueEntry<unknown>)
          this.pending.splice(index, 1)
          reject(cancellationError())
        },
      }
      signal.addEventListener('abort', entry.onAbort, { once: true })
      this.pending.push(entry as QueueEntry<unknown>)
      this.drain()
    })
  }

  private drain(): void {
    if (this.active || this.pending.length === 0) return
    this.pending.sort((left, right) =>
      priorityRank(left.priority) - priorityRank(right.priority) || left.ordinal - right.ordinal)
    const entry = this.pending.shift() as QueueEntry<unknown>
    entry.signal.removeEventListener('abort', entry.onAbort)
    this.active = true
    void Promise.resolve().then(async () => {
      entry.signal.throwIfAborted()
      return await entry.task()
    }).then(entry.resolve, entry.reject).finally(() => {
      this.active = false
      this.drain()
    })
  }
}

function cancellationError(): Error {
  return new Error('GitHub operation cancelled')
}
