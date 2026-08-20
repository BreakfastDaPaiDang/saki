import type { IntentReceipt, IntentOutcome, ProjectionEnvelope, SakiIntent } from '../contract/types'

/**
 * Fixture control plane: simulates the Saki control plane's three public
 * operations (submit / query / onChanged) over named, documented fixtures.
 * It exists so the prototype can exercise the frontend contract without a
 * backend. Latency is simulated so refreshing/optimistic states are visible.
 *
 * The protocol is real, not decorative: every Intent carries the expected
 * revision of the Projection it decided from, a stale revision is rejected
 * with a conflict, and one Intent keeps one stable receipt id from pending
 * to its terminal outcome.
 */

export type ProjectionKey = string

export interface ProjectionSlot<T = unknown> {
  key: ProjectionKey
  revision: number
  confirmedAt: string
  data: T
}

export type IntentHandler = (
  intent: SakiIntent,
  api: EngineMutator,
) => IntentOutcome | Promise<IntentOutcome>

export interface EngineMutator {
  /** Replace a projection's data and bump its revision. */
  update<T>(key: ProjectionKey, mutate: (current: T) => T): void
  /** Read the current projection slot. */
  read<T>(key: ProjectionKey): ProjectionSlot<T> | undefined
  /** All projection keys, for handlers that must resolve an owning record. */
  keys(): ProjectionKey[]
  /** Monotonic clock label for fabricated confirmation times. */
  now(): string
}

/** Result of a submit call: the stable receipt id is known synchronously. */
export interface SubmitHandle {
  receiptId: string
  done: Promise<IntentReceipt>
}

type Listener = (keys: ProjectionKey[]) => void

const BASE_LATENCY_MS = 260

export class FixtureControlPlane {
  private slots = new Map<ProjectionKey, ProjectionSlot>()
  private handlers = new Map<SakiIntent['kind'], IntentHandler>()
  private listeners = new Set<Listener>()
  private pending = new Map<string, string>()
  private clock = 0
  private receiptSeq = 0
  /** When true, every query reports simulated latency as a slow refresh. */
  latencyMultiplier = 1

  define<T>(key: ProjectionKey, data: T, confirmedAt?: string): void {
    this.slots.set(key, { key, revision: 1, confirmedAt: confirmedAt ?? this.now(), data })
  }

  onIntent(kind: SakiIntent['kind'], handler: IntentHandler): void {
    this.handlers.set(kind, handler)
  }

  async query<T>(key: ProjectionKey): Promise<ProjectionEnvelope<T>> {
    await this.delay()
    const slot = this.slots.get(key)
    if (!slot) throw new Error(`fixture has no projection ${key}`)
    return { revision: slot.revision, confirmedAt: slot.confirmedAt, data: structuredClone(slot.data) as T }
  }

  /**
   * Submit a typed Intent. `subject` is the Projection whose revision the
   * caller based its decision on; a stale expected revision is a conflict
   * and the handler never runs. An identical in-flight Intent returns its
   * pending receipt instead of executing twice.
   */
  submit(intent: SakiIntent, options: { expectedRevision: number; subject: ProjectionKey }): SubmitHandle {
    const receiptId = `rcpt-${++this.receiptSeq}`
    const pendingReceipt: IntentReceipt = { receiptId, intent, submittedAt: this.now(), outcome: null }

    const fingerprint = JSON.stringify(intent)
    const inFlight = this.pending.get(fingerprint)
    if (inFlight) {
      // Duplicate submission of an in-flight Intent reuses its receipt.
      return { receiptId: inFlight, done: this.waitFor(inFlight) }
    }
    this.pending.set(fingerprint, receiptId)
    this.pending.set(receiptId, receiptId)

    const done = (async (): Promise<IntentReceipt> => {
      await this.delay()
      const subject = this.slots.get(options.subject)
      if (!subject) {
        return this.settle(receiptId, fingerprint, pendingReceipt, {
          type: 'failed',
          message: `fixture 未定义 Projection ${options.subject}`,
        })
      }
      if (subject.revision !== options.expectedRevision) {
        return this.settle(receiptId, fingerprint, pendingReceipt, {
          type: 'conflict',
          message: `提交基于已过时的 Projection（期望 revision ${options.expectedRevision}，当前 ${subject.revision}）；请刷新后重试`,
        })
      }
      const handler = this.handlers.get(intent.kind)
      if (!handler) {
        return this.settle(receiptId, fingerprint, pendingReceipt, { type: 'failed', message: `fixture 未定义 Intent ${intent.kind}` })
      }
      const dirty = new Set<ProjectionKey>()
      const api: EngineMutator = {
        update: <T,>(key: ProjectionKey, mutate: (current: T) => T) => {
          const slot = this.slots.get(key)
          if (!slot) return
          slot.data = mutate(structuredClone(slot.data) as T)
          slot.revision += 1
          slot.confirmedAt = this.now()
          dirty.add(key)
        },
        read: <T,>(key: ProjectionKey) => this.slots.get(key) as ProjectionSlot<T> | undefined,
        keys: () => [...this.slots.keys()],
        now: () => this.now(),
      }
      const outcome = await handler(intent, api)
      if (dirty.size) this.emit([...dirty])
      return this.settle(receiptId, fingerprint, { ...pendingReceipt, submittedAt: this.now() }, outcome)
    })()

    return { receiptId, done }
  }

  /** Outcomes of already-settled receipts, keyed by receipt id. */
  private settled = new Map<string, IntentReceipt>()

  private waitFor(receiptId: string): Promise<IntentReceipt> {
    const settled = this.settled.get(receiptId)
    if (settled) return Promise.resolve(settled)
    return new Promise((resolve) => {
      const poll = () => {
        const receipt = this.settled.get(receiptId)
        if (receipt) resolve(receipt)
        else setTimeout(poll, 40)
      }
      poll()
    })
  }

  private settle(receiptId: string, fingerprint: string, receipt: IntentReceipt, outcome: IntentOutcome): IntentReceipt {
    const final = { ...receipt, outcome }
    this.settled.set(receiptId, final)
    this.pending.delete(fingerprint)
    this.pending.delete(receiptId)
    return final
  }

  /** External change injection (e.g. a scan completing) without an Intent. */
  poke<T>(key: ProjectionKey, mutate: (current: T) => T): void {
    const slot = this.slots.get(key)
    if (!slot) return
    slot.data = mutate(structuredClone(slot.data) as T)
    slot.revision += 1
    slot.confirmedAt = this.now()
    this.emit([key])
  }

  onChanged(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(keys: ProjectionKey[]): void {
    for (const listener of this.listeners) listener(keys)
  }

  private now(): string {
    // Fabricated confirmation clock: deterministic per fixture run.
    const base = new Date('2026-08-18T09:12:00')
    base.setMinutes(base.getMinutes() + this.clock++)
    return `${String(base.getHours()).padStart(2, '0')}:${String(base.getMinutes()).padStart(2, '0')}`
  }

  private delay(): Promise<void> {
    const ms = (BASE_LATENCY_MS + Math.random() * 240) * this.latencyMultiplier
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
