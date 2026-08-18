import type { IntentReceipt, ProjectionEnvelope, SakiIntent } from '../contract/types'

/**
 * Fixture control plane: simulates the Saki control plane's three public
 * operations (submit / query / onChanged) over named, documented fixtures.
 * It exists so the prototype can exercise the frontend contract without a
 * backend. Latency is simulated so refreshing/optimistic states are visible.
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
) => IntentReceipt['outcome'] | Promise<IntentReceipt['outcome']>

export interface EngineMutator {
  /** Replace a projection's data and bump its revision. */
  update<T>(key: ProjectionKey, mutate: (current: T) => T): void
  /** Read the current projection slot. */
  read<T>(key: ProjectionKey): ProjectionSlot<T> | undefined
  /** Monotonic clock label for fabricated confirmation times. */
  now(): string
}

type Listener = (keys: ProjectionKey[]) => void

const BASE_LATENCY_MS = 260

export class FixtureControlPlane {
  private slots = new Map<ProjectionKey, ProjectionSlot>()
  private handlers = new Map<SakiIntent['kind'], IntentHandler>()
  private listeners = new Set<Listener>()
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

  async submit(intent: SakiIntent, _expectedRevision: number): Promise<IntentReceipt> {
    await this.delay()
    const receipt: IntentReceipt = {
      receiptId: `rcpt-${++this.receiptSeq}`,
      intent,
      submittedAt: this.now(),
      outcome: null,
    }
    const handler = this.handlers.get(intent.kind)
    if (!handler) {
      receipt.outcome = { type: 'failed', message: `fixture 未定义 Intent ${intent.kind}` }
      return receipt
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
      now: () => this.now(),
    }
    receipt.outcome = await handler(intent, api)
    if (dirty.size) this.emit([...dirty])
    return receipt
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
