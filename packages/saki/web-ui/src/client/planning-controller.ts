/** React-free owner of authenticated planning reads, invalidation, and durable gesture replay. */
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { sakiMoveWorkItemIntentSchema } from '@breakfastdapaidang/saki-host-api/wire'
import type { SakiHostClient } from '@breakfastdapaidang/saki-host-api/client'
import type {
  SakiWireAccessProjection, SakiWireBoardResult, SakiWireConfigureGitHubSynchronizationIntent,
  SakiWireConfigureGitHubSynchronizationResult, SakiWireMilestoneViewResult, SakiWireMoveWorkItemIntent,
  SakiWireMoveWorkItemResult, SakiWireProjectId, SakiWireProjectMappingResult,
  SakiWireProjectMilestonesResult, SakiWireProjectionCursor, SakiWireWorkItemViewResult,
} from '@breakfastdapaidang/saki-host-api/wire'
import { createPlanningStore, initialPlanningAddress } from './planning-state.ts'
import type { BoardStatus, MilestoneId, PlanningAddress, WorkItemId } from './planning-state.ts'
import type { createSakiNavigationStore } from './navigation.ts'

type Projection<R> = Extract<R, { ok: true }> extends { projection: infer P } ? P : never
/** Last confirmed Board including server-owned mutation overlays. */
export type PlanningBoard = Projection<SakiWireBoardResult>
/** A confirmed or targeted-confirmed Work Item. */
export type PlanningItem = NonNullable<PlanningBoard['confirmed']>['items'][number]
/** A read can fail independently while retaining its prior confirmed value. */
export interface PlanningRead<T> { readonly value: T | null; readonly loading: boolean; readonly failure: string | null }
/** One exact user move with its latest transport or durable receipt state. */
export interface PlanningMove {
  readonly intent: SakiWireMoveWorkItemIntent
  readonly state: 'pending' | 'unacknowledged' | 'settled'
  readonly result: SakiWireMoveWorkItemResult | null
}
/** All visible planning facts belong to the currently addressed Project. */
export interface PlanningProject {
  readonly id: SakiWireProjectId
  readonly address: PlanningAddress
  readonly board: PlanningRead<PlanningBoard>
  readonly detail: PlanningRead<Projection<SakiWireWorkItemViewResult>>
  readonly milestone: PlanningRead<Projection<SakiWireMilestoneViewResult>>
  readonly milestones: PlanningRead<Projection<SakiWireProjectMilestonesResult>>
  readonly mapping: PlanningRead<Projection<SakiWireProjectMappingResult>>
  readonly mappingResult: SakiWireConfigureGitHubSynchronizationResult | 'unacknowledged' | 'pending' | null
  readonly moves: readonly PlanningMove[]
  readonly focusVersion: number
}
/** Stable observable snapshot injected through the renderer's reserved hooks compartment. */
export interface PlanningSnapshot {
  readonly access: SakiWireAccessProjection | 'unavailable' | null
  readonly offline: boolean
  readonly project: PlanningProject | null
}

type Navigation = ReturnType<ReturnType<typeof createSakiNavigationStore>['create']>
type Interaction = ReturnType<ReturnType<typeof createPlanningStore>['create']>
type PlanningApi = Pick<SakiHostClient, 'readAccess' | 'exchangeBootstrap' | 'watchProjections' | 'queryBoard' | 'queryProjectMilestones' | 'queryWorkItemView' | 'queryMilestoneView' | 'queryProjectMapping' | 'moveWorkItem' | 'configureGitHubSynchronization'>
type Authenticated = Extract<SakiWireAccessProjection, { kind: 'authenticated' }>
type ReadResult<T> = { readonly ok: true; readonly projection: T } | { readonly ok: false; readonly reason: string }
type ProjectCache = Omit<PlanningProject, 'address' | 'moves' | 'detail' | 'milestone'> & {
  details: Map<WorkItemId, PlanningRead<Projection<SakiWireWorkItemViewResult>>>
  milestoneViews: Map<MilestoneId, PlanningRead<Projection<SakiWireMilestoneViewResult>>>
}
const emptyRead = <T>(): PlanningRead<T> => ({ value: null, loading: false, failure: null })

/**
 * Resolve the latest server-confirmed item; optimistic gestures never become read authority.
 * @param board - retained complete Board and server overlays.
 * @param id - selected stable Work Item id.
 * @returns latest independently confirmed item, or undefined.
 */
export function confirmedPlanningItem(board: PlanningBoard | null, id: WorkItemId): PlanningItem | undefined {
  let item = board?.confirmed?.items.find(candidate => candidate.id === id)
  for (const overlay of board?.mutationOverlays ?? []) {
    if ((overlay.state === 'targeted-confirmed' || overlay.state === 'conflict') && overlay.workItem?.id === id) item = overlay.workItem
  }
  return item
}

/** Owns read generations and pending Intents across component and Project switches. */
export class PlanningController {
  private readonly lifetime = new AbortController()
  private authority = new AbortController()
  private readonly listeners = new Set<() => void>()
  private readonly cache = new Map<SakiWireProjectId, ProjectCache>()
  private readonly moves = new Map<string, PlanningMove>()
  private readonly reads = new Map<string, { controller: AbortController; interactive: boolean }>()
  private readonly interaction: Interaction
  private snapshot: PlanningSnapshot = { access: null, offline: false, project: null }
  private access: PlanningSnapshot['access'] = null
  private offline = false
  private queued = false
  private watch: AbortController | undefined
  private accessGeneration = 0
  private readonly disposers: (() => void)[] = []

  /**
   * @param api - injected typed Host API operations.
   * @param navigation - shared Project and top-level surface addresses.
   * @param interaction - persisted user interaction store; omitted creates the normal store.
   */
  constructor(private readonly api: PlanningApi, private readonly navigation: Navigation, interaction = createPlanningStore().create()) {
    this.interaction = interaction
    interaction.actions.hydrate(interaction.store.getSnapshot())
    this.disposers.push(interaction.store.subscribe(() =>{  this.publish() }))
    this.disposers.push(navigation.store.subscribe(() => { this.publish(); void this.loadSelected(false) }))
  }

  /**
   * Read the current planning snapshot.
   * @returns the same snapshot reference until an owned fact changes.
   */
  getSnapshot = (): PlanningSnapshot => this.snapshot
  /**
   * Subscribe to confirmed reads and gesture state changes.
   * @param listener - renderer notification callback.
   * @returns unsubscribe callback.
   */
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  /** Begin authenticated reads for the restored address. */
  start = (): void => { void this.reloadAccess() }
  /** Release watchers and all operation lifetimes without forgetting pending user Intents. */
  dispose = (): void => {
    this.lifetime.abort(); this.authority.abort(); this.watch?.abort()
    for (const dispose of this.disposers) dispose()
    this.listeners.clear()
  }

  /** Reauthenticate and resume protected reads after a transport failure or cookie change. */
  reloadAccess = async (): Promise<void> => {
    const generation = ++this.accessGeneration
    try {
      const access = await this.api.readAccess(this.lifetime.signal)
      if (generation !== this.accessGeneration || this.lifetime.signal.aborted) return
      this.setAccess(access)
      if (access.kind === 'authenticated') { this.startWatch(); await this.loadSelected(true) }
    } catch {
      if (generation !== this.accessGeneration || this.lifetime.signal.aborted) return
      this.offline = true
      if (this.access === null) this.access = 'unavailable'
      this.publish()
    }
  }

  /**
   * Exchange bootstrap authority and load the restored address.
   * @param secret - one-time bootstrap input.
   * @param signal - optional caller cancellation.
   * @returns the Host exchange outcome.
   */
  exchangeBootstrap = async (secret: string, signal?: AbortSignal) => {
    const result = await this.api.exchangeBootstrap(
      secret, signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal]),
    )
    if (result.ok) { this.setAccess(result.access); this.startWatch(); await this.loadSelected(true) }
    return result
  }

  /**
   * Save the current Project viewing choices.
   * @param patch - viewing choices for the current Project.
   */
  navigate = (patch: Partial<PlanningAddress>): void => {
    const selected = this.selected()
    if (selected === undefined) return
    this.interaction.actions.address(selected.auth.principal.id, selected.id, { ...selected.address, ...patch })
    this.publish(); void this.loadSelected(false)
  }
  /**
   * Open a Work Item and preserve its return destination.
   * @param id - selected confirmed Work Item.
   */
  openItem = (id: WorkItemId): void => {
    const selected = this.selected()
    if (selected === undefined) return
    this.navigate({ view: 'detail', workItemId: id, returnView: selected.address.view === 'milestone' ? 'milestone' : 'board' })
  }
  /**
   * Retain the shown Work Item revision for keyboard movement.
   * @param item - confirmed card revision shown when the keyboard gesture began.
   */
  beginMove = (item: PlanningItem): void => {
    const selected = this.selected()
    if (selected === undefined) return
    this.navigate({ workItemId: item.id, moveDraft: { workItemId: item.id, expectedRemoteFingerprint: item.remoteFingerprint, afterFingerprint: null, targetStatus: item.status, position: 'keep' } })
  }
  /** Close the move controls and return focus to their originating card. */
  closeMove = (): void => {
    const selected = this.selected()
    if (selected === undefined) return
    const cache = this.projectCache(selected.id)
    this.cache.set(selected.id, { ...cache, focusVersion: cache.focusVersion + 1 })
    this.navigate({ moveDraft: null })
  }
  /** Return from detail to its saved Board or Milestone address and request focus restoration. */
  closeDetail = (): void => {
    const selected = this.selected()
    if (selected === undefined) return
    const cache = this.projectCache(selected.id)
    this.cache.set(selected.id, { ...cache, focusVersion: cache.focusVersion + 1 })
    this.navigate({ view: selected.address.returnView })
  }
  /** Refresh the complete Board and currently selected read-only destination. */
  refresh = async (): Promise<void> => {
    if (this.authenticated() === undefined || this.offline) { await this.reloadAccess(); return }
    this.startWatch()
    const selected = this.selected()
    if (selected !== undefined) {
      await this.readBoard(selected.id, 'interactive')
      await this.loadSelected(true)
      if (selected.address.view === 'milestone' && selected.address.milestoneId !== null) await this.readMilestone(selected.id, selected.address.milestoneId, 'interactive')
    }
  }

  /**
   * Build one fingerprint-fenced move for both keyboard and drag gestures.
   * @param id - confirmed selected Work Item.
   * @param expectedRemoteFingerprint - revision shown when the gesture began.
   * @param targetStatus - server-mapped destination Status.
   * @param after - exact predecessor, null for top, or undefined to retain API position.
   */
  move = async (id: WorkItemId, expectedRemoteFingerprint: SakiWireMoveWorkItemIntent['expectedRemoteFingerprint'], targetStatus: BoardStatus, after?: { id: WorkItemId; fingerprint: SakiWireMoveWorkItemIntent['expectedRemoteFingerprint'] } | null): Promise<void> => {
    const selected = this.selected()
    if (selected === undefined || after?.id === id) return
    const board = this.projectCache(selected.id).board.value
    const item = confirmedPlanningItem(board, id)
    if (item === undefined || !board?.effectiveMutationAvailability.available || this.projectMoves(selected.id, selected.auth).some(move => move.intent.workItemId === id && move.state !== 'settled')) return
    const predecessor = after == null ? undefined : confirmedPlanningItem(board, after.id)
    if (after != null && predecessor === undefined) return
    const intent: SakiWireMoveWorkItemIntent = {
      type: 'move-work-item', intentId: `intent-${randomUUID()}` as SakiWireMoveWorkItemIntent['intentId'],
      projectId: selected.id, workItemId: id, expectedRemoteFingerprint, targetStatus,
      ...(after === undefined ? {} : { position: after === null
        ? { afterWorkItemId: null }
        : { afterWorkItemId: after.id, expectedAfterRemoteFingerprint: after.fingerprint } }),
    }
    this.interaction.actions.move(selected.auth.principal.id, intent)
    await this.submitMove(intent, selected.auth)
  }
  /**
   * Decode a browser drag without replacing the revision captured at drag start.
   * @param payload - serialized Work Item id and fingerprint from the dragged card.
   * @param status - mapped destination column.
   * @param after - predecessor shown at the drop position, or null for the column top.
   */
  drop = async (payload: string, status: BoardStatus, after: PlanningItem | null): Promise<void> => {
    const [rawId, rawFingerprint, extra] = payload.split(' ')
    const id = sakiMoveWorkItemIntentSchema.shape.workItemId.safeParse(rawId)
    const fingerprint = sakiMoveWorkItemIntentSchema.shape.expectedRemoteFingerprint.safeParse(rawFingerprint)
    if (!id.success || !fingerprint.success || extra !== undefined) return
    await this.move(id.data, fingerprint.data, status, after === null ? null : { id: after.id, fingerprint: after.remoteFingerprint })
  }
  /** Return to the selected Board card from another planning destination. */
  backToBoard = (): void => {
    const selected = this.selected()
    if (selected === undefined) return
    const cache = this.projectCache(selected.id)
    this.cache.set(selected.id, { ...cache, focusVersion: cache.focusVersion + 1 })
    this.navigate({ view: 'board' })
  }
  /**
   * Resume a retained move with current browser authority.
   * @param intentId - exact retained gesture to inspect and resume on the Host.
   */
  retryMove = async (intentId: string): Promise<void> => {
    const auth = this.authenticated()
    const intent = auth === undefined ? undefined : this.interaction.store.getSnapshot().scopes[auth.principal.id]?.pendingMoves[intentId]
    if (auth !== undefined && intent !== undefined && this.moves.get(intentId)?.state !== 'pending') await this.submitMove(intent, auth)
  }
  /**
   * Persist and submit only the selected field/options at the exact discovery revision.
   * @param patch - explicit Status field and seven option choices.
   */
  repairMapping = async (patch: Pick<SakiWireConfigureGitHubSynchronizationIntent['patch'], 'statusFieldNodeId' | 'statusOptionNodeIds'>): Promise<void> => {
    const selected = this.selected()
    if (selected === undefined) return
    const choices = this.projectCache(selected.id).mapping.value
    const pending = this.interaction.store.getSnapshot().scopes[selected.auth.principal.id]?.pendingMapping[selected.id]
    if (choices?.canConfigure !== true || pending !== undefined) return
    const intent: SakiWireConfigureGitHubSynchronizationIntent = {
      type: 'configure-github-synchronization',
      intentId: `intent-${randomUUID()}` as SakiWireConfigureGitHubSynchronizationIntent['intentId'],
      projectId: selected.id, expectedSynchronizationRevision: choices.synchronizationRevision, patch,
    }
    this.interaction.actions.mapping(selected.auth.principal.id, intent)
    await this.submitMapping(intent, selected.auth)
  }
  /** Retry the exact unacknowledged mapping Intent for the current Project. */
  retryMapping = async (): Promise<void> => {
    const selected = this.selected()
    if (selected === undefined) return
    const intent = this.interaction.store.getSnapshot().scopes[selected.auth.principal.id]?.pendingMapping[selected.id]
    if (intent !== undefined && this.projectCache(selected.id).mappingResult !== 'pending') await this.submitMapping(intent, selected.auth)
  }

  private authenticated(): Authenticated | undefined {
    return this.access !== null && this.access !== 'unavailable' && this.access.kind === 'authenticated' ? this.access : undefined
  }
  private selected() {
    const auth = this.authenticated()
    const id = this.navigation.store.getSnapshot().projectId
    if (auth === undefined || id === null) return undefined
    const address = this.interaction.store.getSnapshot().scopes[auth.principal.id]?.addresses[id] ?? initialPlanningAddress()
    return { auth, id, address }
  }
  private setAccess(access: SakiWireAccessProjection): void {
    const prior = this.authenticated()?.principal.id
    const next = access.kind === 'authenticated' ? access.principal.id : undefined
    if (prior !== next) {
      this.authority.abort(); this.authority = new AbortController(); this.watch?.abort(); this.watch = undefined
      this.cache.clear(); this.moves.clear(); this.reads.clear()
    }
    this.access = access; this.offline = false; this.publish()
  }
  private projectCache(id: SakiWireProjectId): ProjectCache {
    let cache = this.cache.get(id)
    if (cache === undefined) {
      cache = {
        id, board: emptyRead(), milestones: emptyRead(), mapping: emptyRead(), details: new Map(),
        milestoneViews: new Map(), mappingResult: null, focusVersion: 0,
      }
      this.cache.set(id, cache)
    }
    return cache
  }
  private projectMoves(id: SakiWireProjectId, auth: Authenticated): PlanningMove[] {
    const restored = Object.values(this.interaction.store.getSnapshot().scopes[auth.principal.id]?.pendingMoves ?? {})
      .filter(intent => intent.projectId === id).map(intent => this.moves.get(intent.intentId) ?? { intent, state: 'unacknowledged' as const, result: null })
    return [...restored, ...[...this.moves.values()].filter(move => move.intent.projectId === id
      && !restored.some(candidate => candidate.intent.intentId === move.intent.intentId))]
  }
  private publish(): void {
    const selected = this.selected()
    let project: PlanningProject | null = null
    if (selected !== undefined) {
      const cache = this.projectCache(selected.id)
      const pendingMapping = this.interaction.store.getSnapshot().scopes[selected.auth.principal.id]?.pendingMapping[selected.id]
      project = { id: cache.id, address: selected.address, board: cache.board, milestones: cache.milestones, mapping: cache.mapping,
        detail: selected.address.workItemId === null ? emptyRead() : cache.details.get(selected.address.workItemId) ?? emptyRead(),
        milestone: selected.address.milestoneId === null
          ? emptyRead() : cache.milestoneViews.get(selected.address.milestoneId) ?? emptyRead(),
        mappingResult: cache.mappingResult ?? (pendingMapping === undefined ? null : 'unacknowledged'),
        moves: this.projectMoves(selected.id, selected.auth), focusVersion: cache.focusVersion,
      }
    }
    this.snapshot = { access: this.access, offline: this.offline, project }
    if (this.queued) return
    this.queued = true
    queueMicrotask(() => { this.queued = false; if (!this.lifetime.signal.aborted) notifySubscribers(this.listeners, '[saki-planning]') })
  }

  private startWatch(): void {
    if (this.watch !== undefined && !this.watch.signal.aborted) return
    const owned = new AbortController()
    this.watch = owned
    const signal = AbortSignal.any([owned.signal, this.authority.signal, this.lifetime.signal])
    void (async () => {
      let cursor: SakiWireProjectionCursor | null = null
      try {
        while (!signal.aborted) {
          const result = await this.api.watchProjections(cursor, signal)
          signal.throwIfAborted()
          if (!result.ok) { await this.reloadAccess(); return }
          const changed = cursor !== result.cursor
          cursor = result.cursor
          this.offline = false
          await this.loadSelected(changed, true)
          for (const move of this.projectMovesForPrincipal()) {
            if (this.selected()?.id !== move.intent.projectId) await this.readBoard(move.intent.projectId, 'cached')
          }
        }
      } catch {
        if (!signal.aborted) { this.offline = true; this.publish() }
      } finally {
        if (this.watch === owned) this.watch = undefined
      }
    })()
  }
  private projectMovesForPrincipal(): readonly PlanningMove[] {
    const auth = this.authenticated()
    if (auth === undefined) return []
    return Object.values(this.interaction.store.getSnapshot().scopes[auth.principal.id]?.pendingMoves ?? {}).map(intent => this.moves.get(intent.intentId) ?? { intent, state: 'unacknowledged', result: null })
  }
  private async loadSelected(refresh: boolean, heartbeat = false): Promise<void> {
    if (this.navigation.store.getSnapshot().surface !== 'project') return
    const selected = this.selected()
    if (selected === undefined) return
    const cache = this.projectCache(selected.id)
    const tasks: Promise<void>[] = []
    if (refresh || heartbeat || cache.board.value === null) tasks.push(this.readBoard(selected.id, 'cached'))
    if (refresh || cache.milestones.value === null) tasks.push(this.readMilestones(selected.id))
    if ((selected.address.view === 'detail' || selected.address.view === 'changes') && selected.address.workItemId !== null) {
      const id = selected.address.workItemId
      if (refresh || !cache.details.has(id)) tasks.push(this.readDetail(selected.id, id))
    }
    if (selected.address.view === 'milestone' && selected.address.milestoneId !== null) {
      const id = selected.address.milestoneId
      if (refresh || !cache.milestoneViews.has(id)) tasks.push(this.readMilestone(selected.id, id))
    }
    if (selected.address.view === 'mapping' && (refresh || cache.mapping.value === null)) tasks.push(this.readMapping(selected.id))
    await Promise.all(tasks)
  }
  private async read<T>(
    key: string, get: () => PlanningRead<T>, set: (value: PlanningRead<T>) => void,
    request: (signal: AbortSignal) => Promise<ReadResult<T>>,
    interactive = false,
  ): Promise<void> {
    const current = this.reads.get(key)
    // Cached invalidation reads must not cancel a user-requested remote refresh.
    if (current?.interactive && !interactive) return
    current?.controller.abort()
    const owned = new AbortController(); this.reads.set(key, { controller: owned, interactive })
    const signal = AbortSignal.any([owned.signal, this.authority.signal, this.lifetime.signal])
    set({ ...get(), loading: true, failure: null }); this.publish()
    try {
      const result = await request(signal)
      if (signal.aborted) return
      set(result.ok ? { value: result.projection, loading: false, failure: null }
        : { value: result.reason === 'denied' || result.reason === 'not-found' ? null : get().value, loading: false, failure: result.reason })
    } catch {
      if (signal.aborted) return
      set({ ...get(), loading: false, failure: 'offline' }); this.offline = true
    } finally {
      if (this.reads.get(key)?.controller === owned) this.reads.delete(key)
      if (!signal.aborted) this.publish()
    }
  }
  private readBoard(id: SakiWireProjectId, refresh: 'cached' | 'interactive') {
    return this.read(`board:${id}`, () => this.projectCache(id).board, (board) => { this.cache.set(id, { ...this.projectCache(id), board }) }, signal => this.api.queryBoard(id, refresh, signal), refresh === 'interactive')
  }
  private readMilestones(id: SakiWireProjectId) {
    return this.read(`milestones:${id}`, () => this.projectCache(id).milestones, (milestones) => { this.cache.set(id, { ...this.projectCache(id), milestones }) }, async (signal) => {
      let after: MilestoneId | null = null
      let combined: Projection<SakiWireProjectMilestonesResult> = { type: 'project-milestones', projectId: id, items: [], next: null }
      do {
        const result = await this.api.queryProjectMilestones(id, after, signal)
        if (!result.ok) return result
        combined = { ...result.projection, items: [...combined.items, ...result.projection.items] }
        after = result.projection.next
      } while (after !== null)
      return { ok: true, projection: combined }
    })
  }
  private readDetail(projectId: SakiWireProjectId, id: WorkItemId) {
    return this.read<Projection<SakiWireWorkItemViewResult>>(`detail:${projectId}:${id}`, () => this.projectCache(projectId).details.get(id) ?? emptyRead(), value => this.projectCache(projectId).details.set(id, value), signal => this.api.queryWorkItemView(projectId, id, signal))
  }
  private readMilestone(projectId: SakiWireProjectId, id: MilestoneId, refresh: 'cached' | 'interactive' = 'cached') {
    return this.read<Projection<SakiWireMilestoneViewResult>>(`milestone:${projectId}:${id}`, () => this.projectCache(projectId).milestoneViews.get(id) ?? emptyRead(), value => this.projectCache(projectId).milestoneViews.set(id, value), signal => this.api.queryMilestoneView(projectId, id, refresh, signal), refresh === 'interactive')
  }
  private readMapping(id: SakiWireProjectId) {
    return this.read(`mapping:${id}`, () => this.projectCache(id).mapping, (mapping) => { this.cache.set(id, { ...this.projectCache(id), mapping }) }, signal => this.api.queryProjectMapping(id, signal))
  }
  private async submitMove(intent: SakiWireMoveWorkItemIntent, auth: Authenticated): Promise<void> {
    const signal = AbortSignal.any([this.authority.signal, this.lifetime.signal])
    this.moves.set(intent.intentId, { intent, state: 'pending', result: null }); this.publish()
    try {
      const result = await this.api.moveWorkItem(intent, auth.requestToken, signal)
      if (signal.aborted) return
      const receipt = 'receipt' in result ? result.receipt : undefined
      const settled = result.ok || receipt?.state === 'conflict' || receipt?.state === 'canceled'
        || result.reason === 'denied' || result.reason === 'conflict'
      this.moves.set(intent.intentId, { intent, state: settled ? 'settled' : 'unacknowledged', result })
      if (settled) this.interaction.actions.forgetMove(auth.principal.id, intent.intentId)
      await this.readBoard(intent.projectId, 'cached')
      const selected = this.selected()
      if (selected?.id === intent.projectId && selected.address.workItemId === intent.workItemId) {
        await this.readDetail(intent.projectId, intent.workItemId)
      }
    } catch {
      if (!signal.aborted) { this.moves.set(intent.intentId, { intent, state: 'unacknowledged', result: null }); this.offline = true }
    } finally { if (!signal.aborted) this.publish() }
  }
  private async submitMapping(intent: SakiWireConfigureGitHubSynchronizationIntent, auth: Authenticated): Promise<void> {
    const signal = AbortSignal.any([this.authority.signal, this.lifetime.signal])
    this.cache.set(intent.projectId, { ...this.projectCache(intent.projectId), mappingResult: 'pending' }); this.publish()
    try {
      const result = await this.api.configureGitHubSynchronization(intent, auth.requestToken, signal)
      if (signal.aborted) return
      this.cache.set(intent.projectId, { ...this.projectCache(intent.projectId), mappingResult: result })
      this.interaction.actions.forgetMapping(auth.principal.id, intent.projectId)
      await this.readBoard(intent.projectId, 'interactive')
      await this.readMapping(intent.projectId)
    } catch {
      if (!signal.aborted) this.cache.set(intent.projectId, { ...this.projectCache(intent.projectId), mappingResult: 'unacknowledged' })
    } finally { if (!signal.aborted) this.publish() }
  }
}

/** Plain callbacks available to presentation components. */
export type PlanningActions = Pick<PlanningController, 'reloadAccess' | 'refresh' | 'navigate' | 'openItem' | 'closeDetail' | 'beginMove' | 'closeMove' | 'move' | 'drop' | 'backToBoard' | 'retryMove' | 'repairMapping' | 'retryMapping'>
