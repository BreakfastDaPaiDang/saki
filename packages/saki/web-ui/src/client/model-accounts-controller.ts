/** Account reads and replayable browser gestures under the shared access owner. */
import { z } from 'zod'
import { defineStore, notifySubscribers } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { SakiHostClient } from '@breakfastdapaidang/saki-host-api/client'
import { sakiModelAccountIntentSchema } from '@breakfastdapaidang/saki-host-api/wire'
import type { SakiWireModelAccountIntent, SakiWireModelSupplyResult, SakiWireProjectionCursor } from '@breakfastdapaidang/saki-host-api/wire'
import type { PlanningController } from './planning-controller.ts'

type Supply = Extract<SakiWireModelSupplyResult, { ok: true }>['projection']
type Draft = SakiWireModelAccountIntent extends infer I ? I extends SakiWireModelAccountIntent ? Omit<I, 'intentId'> : never : never
type Pending = Record<string, Record<string, SakiWireModelAccountIntent>>
const pendingSchema = z.record(z.string(), z.record(z.string(), sakiModelAccountIntentSchema))

/** Projected inventory plus local transport state; credentials are never browser state. */
export interface ModelAccountsSnapshot {
  readonly supply: Supply | null
  readonly loading: boolean
  readonly failure: 'denied' | 'unavailable' | 'conflict' | null
  readonly pending: readonly SakiWireModelAccountIntent[]
}

/** Explicit account gestures exposed to the pure page. */
export interface ModelAccountsActions {
  /** Reload the current inventory. */
  refresh(): Promise<void>
  /** @param draft - user-selected account operation without an allocated Intent id. */
  submit(draft: Draft): Promise<void>
  /** @param intent - exact unacknowledged request retained before its first send. */
  retry(intent: SakiWireModelAccountIntent): Promise<void>
}

/** One browser's account inventory; the Host owns accepted authorization lifetimes. */
export class ModelAccountsController implements ModelAccountsActions {
  private readonly lifetime = new AbortController()
  private authority = new AbortController()
  private readonly listeners = new Set<() => void>()
  private readonly pending = defineStore({
    init: (): { byPrincipal: Pending } => ({ byPrincipal: {} }), persist: 'saki.model-accounts',
    actions: {
      hydrate: (state: { byPrincipal: Pending }, input: unknown) => {
        const parsed = z.object({ byPrincipal: pendingSchema }).strict().safeParse(input)
        state.byPrincipal = parsed.success ? parsed.data.byPrincipal : {}
      },
      save: (state: { byPrincipal: Pending }, principal: string, value: Record<string, SakiWireModelAccountIntent>) => {
        state.byPrincipal[principal] = value
      },
    },
  }).create()
  private snapshot: ModelAccountsSnapshot = { supply: null, loading: false, failure: null, pending: [] }
  private principal: string | undefined
  private token: string | undefined
  private unsubscribe: (() => void) | undefined
  private read: AbortController | undefined
  private watching: AbortSignal | undefined
  private readonly sending = new Set<string>()

  constructor(
    private readonly api: Pick<SakiHostClient, 'queryModelSupply' | 'submitModelAccount' | 'watchProjections'>,
    private readonly access: Pick<PlanningController, 'getSnapshot' | 'subscribe' | 'reloadAccess'>,
  ) {
    this.pending.actions.hydrate(this.pending.store.getSnapshot())
  }

  /** Read account rendering state. @returns the current immutable snapshot. */
  getSnapshot = (): ModelAccountsSnapshot => this.snapshot
  /** Observe rendering changes. @param listener - rendering subscriber. @returns its disposer. */
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  /** Begin observing authenticated access. */
  start = (): void => { this.unsubscribe = this.access.subscribe(this.syncAccess); this.syncAccess() }
  /** Cancel browser work without cancelling accepted Host authorizations. */
  dispose = (): void => { this.lifetime.abort(); this.authority.abort(); this.unsubscribe?.(); this.listeners.clear() }

  private syncAccess = (): void => {
    const access = this.access.getSnapshot().access
    const auth = access !== null && access !== 'unavailable' && access.kind === 'authenticated' ? access : undefined
    if (this.principal === auth?.principal.id && this.token === auth?.requestToken) return
    this.authority.abort(); this.authority = new AbortController()
    this.watching = undefined
    this.principal = auth?.principal.id; this.token = auth?.requestToken
    this.publish({ supply: null, failure: null, loading: false })
    if (auth !== undefined) this.startWatch()
  }

  private publish(patch: Partial<ModelAccountsSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch, pending: Object.values(this.principal === undefined ? {}
      : this.pending.store.getSnapshot().byPrincipal[this.principal] ?? {}) }
    notifySubscribers(this.listeners, '[saki-model-accounts]')
  }

  /** @inheritdoc */
  refresh = async (): Promise<void> => {
    if (this.principal === undefined) return
    this.read?.abort(); const read = new AbortController(); this.read = read
    const signal = AbortSignal.any([read.signal, this.authority.signal, this.lifetime.signal])
    this.publish({ loading: true })
    try {
      const result = await this.api.queryModelSupply(signal)
      if (!signal.aborted) this.publish(result.ok ? { supply: result.projection, loading: false, failure: null }
        : { supply: null, loading: false, failure: result.reason })
      if (!signal.aborted && result.ok) this.startWatch()
    } catch {
      if (!signal.aborted) this.publish({ loading: false, failure: 'unavailable' })
    }
  }

  private startWatch(): void {
    if (this.watching !== undefined || this.lifetime.signal.aborted) return
    const signal = AbortSignal.any([this.authority.signal, this.lifetime.signal])
    this.watching = signal
    void this.watch(signal)
  }

  private async watch(signal: AbortSignal): Promise<void> {
    let cursor: SakiWireProjectionCursor | null = null
    try {
      while (!signal.aborted) {
        const result = await this.api.watchProjections(cursor, signal)
        signal.throwIfAborted()
        if (!result.ok) { await this.access.reloadAccess(); return }
        if (cursor !== result.cursor) { cursor = result.cursor; await this.refresh() }
      }
    } catch {
      if (!signal.aborted) this.publish({ failure: 'unavailable' })
    } finally {
      if (this.watching === signal) this.watching = undefined
    }
  }

  /** @inheritdoc */
  submit = async (draft: Draft): Promise<void> => {
    const intent = sakiModelAccountIntentSchema.parse({ ...draft, intentId: `intent-${randomUUID()}` })
    await this.retry(intent)
  }

  /** @inheritdoc */
  retry = async (intent: SakiWireModelAccountIntent): Promise<void> => {
    const principal = this.principal; const token = this.token
    if (principal === undefined || token === undefined || this.sending.has(intent.intentId)) return
    const signal = AbortSignal.any([this.authority.signal, this.lifetime.signal])
    const pending = this.pending.store.getSnapshot().byPrincipal[principal] ?? {}
    this.pending.actions.save(principal, { ...pending, [intent.intentId]: intent })
    this.sending.add(intent.intentId); this.publish({ failure: null })
    try {
      const result = await this.api.submitModelAccount(intent, token, signal)
      if (signal.aborted) return
      if (result.ok) {
        const remaining = Object.fromEntries(Object.entries(this.pending.store.getSnapshot().byPrincipal[principal] ?? {})
          .filter(([id]) => id !== intent.intentId))
        this.pending.actions.save(principal, remaining)
      }
      await this.refresh()
      this.publish({ failure: result.ok ? null : result.reason })
    } catch {
      if (!signal.aborted) this.publish({ failure: 'unavailable' })
    } finally { this.sending.delete(intent.intentId) }
  }
}
