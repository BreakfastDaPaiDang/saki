/** Account reads and replayable browser gestures under the shared access owner. */
import { z } from 'zod'
import { defineStore, notifySubscribers } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { SakiHostClient } from '@breakfastdapaidang/saki-host-api/client'
import { sakiModelAccountIntentSchema, sakiSwitchWorkSessionModelIntentSchema, sakiConfigureProjectModelRouteIntentSchema } from '@breakfastdapaidang/saki-host-api/wire'
import type { SakiWireSwitchWorkSessionModelIntent, SakiWireModelAccountIntent, SakiWireModelSupplyResult, SakiWireProjectionCursor, SakiWireConfigureProjectModelRouteIntent, SakiWireProjectModelRouteResult, SakiWireProjectId } from '@breakfastdapaidang/saki-host-api/wire'
import type { PlanningController } from './planning-controller.ts'

type Supply = Extract<SakiWireModelSupplyResult, { ok: true }>['projection']
type SelectionIntent = SakiWireSwitchWorkSessionModelIntent | SakiWireModelAccountIntent | SakiWireConfigureProjectModelRouteIntent
const selectionIntentSchema = z.union([
  sakiSwitchWorkSessionModelIntentSchema, sakiModelAccountIntentSchema, sakiConfigureProjectModelRouteIntentSchema,
])
type Draft = SelectionIntent extends infer I ? I extends SelectionIntent ? Omit<I, 'intentId'> : never : never
type Pending = Record<string, Record<string, SelectionIntent>>
const pendingSchema = z.record(z.string(), z.record(z.string(), selectionIntentSchema))

/** Projected inventory plus local transport state; credentials are never browser state. */
export interface ModelAccountsSnapshot {
  readonly supply: Supply | null
  readonly loading: boolean
  readonly failure: 'denied' | 'unavailable' | 'conflict' | null
  readonly pending: readonly SelectionIntent[]
  readonly projectRoute: Extract<SakiWireProjectModelRouteResult, { ok: true }>['projection'] | null
}

/** Explicit account gestures exposed to the pure page. */
export interface ModelAccountsActions {
  /** Reload the current inventory. */
  refresh(): Promise<void>
  /** @param draft - user-selected account operation without an allocated Intent id. */
  submit(draft: Draft): Promise<void>
  /** @param intent - exact unacknowledged request retained before its first send. */
  retry(intent: SelectionIntent): Promise<void>
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
      save: (state: { byPrincipal: Pending }, principal: string, value: Record<string, SelectionIntent>) => {
        state.byPrincipal[principal] = value
      },
    },
  }).create()
  private snapshot: ModelAccountsSnapshot = { supply: null, loading: false, failure: null, pending: [], projectRoute: null }
  private projectId: SakiWireProjectId | undefined
  private principal: string | undefined
  private token: string | undefined
  private unsubscribe: (() => void) | undefined
  private read: AbortController | undefined
  private watching: AbortSignal | undefined
  private readonly sending = new Set<string>()

  constructor(
    private readonly api: Pick<SakiHostClient, 'queryModelSupply' | 'submitModelAccount' | 'watchProjections' | 'queryProjectModelRoute' | 'configureProjectModelRoute' | 'switchWorkSessionModel'>,
    private readonly access: Pick<PlanningController, 'getSnapshot' | 'subscribe' | 'reloadAccess' | 'navigate'>,
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
    const snapshot = this.access.getSnapshot()
    const access = snapshot.access
    const projectId = snapshot.project?.id
    const auth = access !== null && access !== 'unavailable' && access.kind === 'authenticated' ? access : undefined
    if (this.principal === auth?.principal.id && this.token === auth?.requestToken) {
      if (this.projectId !== projectId) {
        this.projectId = projectId
        this.publish({ projectRoute: null })
        void this.refresh()
      }
      return
    }
    this.projectId = projectId
    this.authority.abort(); this.authority = new AbortController()
    this.watching = undefined
    this.principal = auth?.principal.id; this.token = auth?.requestToken
    this.publish({ supply: null, projectRoute: null, failure: null, loading: false })
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
      const projectId = this.projectId
      const [result, route] = await Promise.all([
        this.api.queryModelSupply(signal),
        projectId === undefined ? undefined : this.api.queryProjectModelRoute(projectId, signal),
      ])
      if (!signal.aborted) this.publish({ projectRoute: route?.ok ? route.projection : null })
      if (!signal.aborted) this.publish(result.ok ? { supply: result.projection, loading: false, failure: route !== undefined && !route.ok
        ? route.reason === 'denied' ? 'denied' : 'unavailable' : null }
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
    const intent = selectionIntentSchema.parse({ ...draft, intentId: `intent-${randomUUID()}` })
    await this.retry(intent)
  }

  /** @inheritdoc */
  retry = async (intent: SelectionIntent): Promise<void> => {
    const principal = this.principal; const token = this.token
    if (principal === undefined || token === undefined || this.sending.has(intent.intentId)) return
    const signal = AbortSignal.any([this.authority.signal, this.lifetime.signal])
    const pending = this.pending.store.getSnapshot().byPrincipal[principal] ?? {}
    this.pending.actions.save(principal, { ...pending, [intent.intentId]: intent })
    this.sending.add(intent.intentId); this.publish({ failure: null })
    try {
      const result = intent.type === 'switch-work-session-model'
        ? await this.api.switchWorkSessionModel(intent, token, signal)
        : intent.type === 'configure-project-model-route'
          ? await this.api.configureProjectModelRoute(intent, token, signal)
          : await this.api.submitModelAccount(intent, token, signal)
      if (signal.aborted) return
      if ((!result.ok && result.reason === 'conflict') || (result.ok && (intent.type !== 'switch-work-session-model'
        || result.receipt.state !== 'reconciliation-required' && result.receipt.state !== 'accepted'))) {
        const remaining = Object.fromEntries(Object.entries(this.pending.store.getSnapshot().byPrincipal[principal] ?? {})
          .filter(([id]) => id !== intent.intentId))
        this.pending.actions.save(principal, remaining)
      }
      if (intent.type === 'switch-work-session-model' && result.ok && result.receipt.state === 'completed'
        && 'agentRunId' in result.receipt && this.access.getSnapshot().project?.id === intent.projectId) {
        this.access.navigate({ view: 'run', agentRunId: result.receipt.agentRunId, dispatchAfter: null, terminal: null })
      }
      await this.refresh()
      this.publish({ failure: result.ok ? result.receipt.state === 'failed' || result.receipt.state === 'reconciliation-required' ? 'unavailable' : null : result.reason })
    } catch {
      if (!signal.aborted) this.publish({ failure: 'unavailable' })
    } finally { this.sending.delete(intent.intentId) }
  }
}
