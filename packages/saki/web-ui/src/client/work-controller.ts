/** React-free Work reads and explicit, durable user gestures sharing the planning access owner. */
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { SakiHostClient } from '@breakfastdapaidang/saki-host-api/client'
import { sakiCreateWorkItemIntentSchema, sakiGiveWorkItemToAgentIntentSchema, sakiAnswerInterventionIntentSchema } from '@breakfastdapaidang/saki-host-api/wire'
import type { SakiWireAccessProjection, SakiWireMyWorkResult, SakiWireProjectIndexResult, SakiWireProjectId, SakiWireCreateWorkItemResult, SakiWireGiveWorkItemToAgentResult, SakiWireAnswerInterventionResult, SakiWireProjectionCursor } from '@breakfastdapaidang/saki-host-api/wire'
import type { PlanningBoard, PlanningController, PlanningRead } from './planning-controller.ts'
import { createWorkStore, emptyWorkDraft, emptyWorkScope } from './work-state.ts'
import type { WorkDraft, WorkIntent, WorkScope } from './work-state.ts'

/** One backend-classified cross-Project card. */
export type WorkItem = Extract<SakiWireMyWorkResult, { ok: true }>['projection']['items'][number]
/** The single currently recommended gesture for a card. */
export type WorkOffer = Extract<WorkItem['recommendation'], { available: true }>['offer']
type Project = Extract<SakiWireProjectIndexResult, { ok: true }>['projection']['projects'][number]
type Result = SakiWireCreateWorkItemResult | SakiWireGiveWorkItemToAgentResult | SakiWireAnswerInterventionResult
type Auth = Extract<SakiWireAccessProjection, { kind: 'authenticated' }>
type Api = Pick<SakiHostClient, 'queryMyWork' | 'queryProjectIndex' | 'queryBoard' | 'watchProjections' | 'createWorkItem' | 'giveWorkItemToAgent' | 'answerIntervention'>
type Interaction = ReturnType<ReturnType<typeof createWorkStore>['create']>
/** Last read of one server-selected Project and its independent mapping health. */
export interface WorkProject { readonly project: Project; readonly board: PlanningRead<PlanningBoard> }
/** One submitted gesture never acquires a replacement id during recovery. */
export interface WorkOperation { readonly intent: WorkIntent; readonly state: 'pending' | 'unacknowledged' | 'settled'; readonly result: Result | null }
/** Work rendering facts and draft state for the current Principal. */
export interface WorkSnapshot {
  readonly items: PlanningRead<readonly WorkItem[]>
  readonly projects: PlanningRead<readonly WorkProject[]>
  readonly scope: WorkScope
  readonly operations: readonly WorkOperation[]
  readonly confirmation: WorkOffer | null
  readonly inputError: boolean
  readonly offline: boolean
}
const emptyRead = <T>(): PlanningRead<T> => ({ value: null, loading: false, failure: null })

/** Owns Work reads, request replay, and authority cancellation independently of React mounts. */
export class WorkController {
  private readonly listeners = new Set<() => void>()
  private readonly lifetime = new AbortController()
  private authority = new AbortController()
  private auth: Auth | undefined
  private readonly operations = new Map<string, WorkOperation>()
  private readonly disposers: (() => void)[] = []
  private watch: AbortController | undefined
  private read: AbortController | undefined
  private queued = false
  private snapshot: WorkSnapshot = {
    items: emptyRead(), projects: emptyRead(), scope: emptyWorkScope(),
    operations: [], confirmation: null, inputError: false, offline: false,
  }

  /**
   * @param api - browser-safe Host operations.
   * @param access - the shared authenticated planning owner.
   * @param interaction - persisted Principal-scoped user inputs.
   */
  constructor(private readonly api: Api, private readonly access: Pick<PlanningController, 'getSnapshot' | 'subscribe' | 'reloadAccess'>, private readonly interaction: Interaction = createWorkStore().create()) {
    interaction.actions.hydrate(interaction.store.getSnapshot())
    this.disposers.push(access.subscribe(this.syncAccess), interaction.store.subscribe(() => { this.publish() }))
  }
  /**
   * Read the stable rendering snapshot.
   * @returns the current snapshot.
   */
  getSnapshot = (): WorkSnapshot => this.snapshot
  /**
   * Subscribe to Work changes.
   * @param listener - renderer callback.
   * @returns unsubscribe callback.
   */
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  /** Start reads using the access owner's current identity. */
  start = (): void => { this.syncAccess() }
  /** Cancel reads and requests without erasing unacknowledged Intents. */
  dispose = (): void => {
    this.lifetime.abort(); this.authority.abort()
    for (const dispose of this.disposers) dispose()
    this.listeners.clear()
  }

  private syncAccess = (): void => {
    const access = this.access.getSnapshot().access
    const auth = access !== null && access !== 'unavailable' && access.kind === 'authenticated' ? access : undefined
    const changed = auth?.principal.id !== this.auth?.principal.id || auth?.requestToken !== this.auth?.requestToken
    this.auth = auth
    if (!changed) return
    this.authority.abort(); this.authority = new AbortController()
    this.watch = undefined; this.read = undefined; this.operations.clear()
    this.snapshot = {
      items: emptyRead(), projects: emptyRead(), scope: emptyWorkScope(),
      operations: [], confirmation: null, inputError: false, offline: false,
    }
    this.publish()
    if (auth !== undefined) { void this.reload(false); this.startWatch() }
  }
  private scope(): WorkScope {
    return this.auth === undefined
      ? emptyWorkScope()
      : this.interaction.store.getSnapshot().scopes[this.auth.principal.id] ?? emptyWorkScope()
  }
  private save(scope: WorkScope): void { if (this.auth !== undefined) this.interaction.actions.scope(this.auth.principal.id, scope) }
  private publish(patch: Partial<WorkSnapshot> = {}): void {
    const scope = this.scope()
    this.snapshot = { ...this.snapshot, ...patch, scope, operations: Object.values(scope.pending).map(intent => this.operations.get(intent.intentId) ?? { intent, state: 'unacknowledged', result: null }) }
    if (this.queued) return
    this.queued = true
    queueMicrotask(() => { this.queued = false; if (!this.lifetime.signal.aborted) notifySubscribers(this.listeners, '[saki-work]') })
  }
  /**
   * Select an explicit creation destination, retaining every Project's draft.
   * @param projectId - server-projected Project identity, or no selection.
   */
  selectProject = (projectId: SakiWireProjectId | null): void => {
    this.save({ ...this.scope(), projectId }); this.publish({ inputError: false })
  }
  /**
   * Persist editable requirement fields for the selected Project.
   * @param patch - changed input fields.
   */
  editDraft = (patch: Partial<WorkDraft>): void => {
    const scope = this.scope()
    if (scope.projectId === null) return
    this.save({ ...scope, drafts: {
      ...scope.drafts, [scope.projectId]: { ...(scope.drafts[scope.projectId] ?? emptyWorkDraft()), ...patch },
    } })
    this.publish({ inputError: false })
  }
  /**
   * Persist an Intervention answer until the operator submits it.
   * @param id - server-projected Intervention id.
   * @param text - inert answer text.
   */
  editAnswer = (id: Extract<WorkOffer, { type: 'answer-intervention' }>['interventionId'], text: string): void => { const scope = this.scope(); this.save({ ...scope, answers: { ...scope.answers, [id]: text } }); this.publish({ inputError: false }) }
  /**
   * Retain the shown offer's exact revision for explicit confirmation.
   * @param offer - backend recommendation, or null to dismiss.
   */
  confirm = (offer: WorkOffer | null): void => { this.publish({ confirmation: offer, inputError: false }) }

  /** Request fresh Project scans; a failed Project read does not discard its neighbors. */
  refresh = async (): Promise<void> => { await this.reload(true) }
  private async reload(remote: boolean): Promise<void> {
    if (this.auth === undefined) return
    this.read?.abort()
    const owned = new AbortController(); this.read = owned
    const signal = AbortSignal.any([owned.signal, this.authority.signal, this.lifetime.signal])
    this.publish({ items: { ...this.snapshot.items, loading: true }, projects: { ...this.snapshot.projects, loading: true } })
    await Promise.all([this.readItems(signal), this.readProjects(signal, remote)])
    if (!signal.aborted) this.startWatch()
  }
  private async readItems(signal: AbortSignal): Promise<void> {
    try {
      const result = await this.api.queryMyWork(signal)
      if (signal.aborted) return
      this.publish({ items: result.ok
        ? { value: result.projection.items, loading: false, failure: null }
        : { value: null, loading: false, failure: result.reason }, offline: false })
    } catch {
      if (!signal.aborted) this.publish({ items: { ...this.snapshot.items, loading: false, failure: 'unavailable' }, offline: true })
    }
  }
  private async readProjects(signal: AbortSignal, remote: boolean): Promise<void> {
    try {
      const result = await this.api.queryProjectIndex(signal)
      if (signal.aborted) return
      if (!result.ok) { this.publish({ projects: { value: null, loading: false, failure: result.reason } }); return }
      const projects = await Promise.all(result.projection.projects.map(async (project): Promise<WorkProject> => {
        const prior = this.snapshot.projects.value?.find(value => value.project.id === project.id)?.board ?? emptyRead<PlanningBoard>()
        try {
          const board = await this.api.queryBoard(project.id, remote ? 'interactive' : 'cached', signal)
          return { project, board: board.ok
            ? { value: board.projection, loading: false, failure: null }
            : { value: null, loading: false, failure: board.reason } }
        } catch { return { project, board: { ...prior, loading: false, failure: 'unavailable' } } }
      }))
      // eslint-disable-next-line typescript/no-unnecessary-condition -- AbortSignal can change during the awaited Board reads.
      if (!signal.aborted) this.publish({ projects: { value: projects, loading: false, failure: null } })
    } catch {
      if (!signal.aborted) this.publish({ projects: { ...this.snapshot.projects, loading: false, failure: 'unavailable' }, offline: true })
    }
  }
  private startWatch(): void {
    if (this.watch !== undefined || this.auth === undefined) return
    const owned = new AbortController(); this.watch = owned
    const signal = AbortSignal.any([owned.signal, this.authority.signal, this.lifetime.signal])
    void this.watchChanges(signal).finally(() => { if (this.watch === owned) this.watch = undefined })
  }
  private async watchChanges(signal: AbortSignal): Promise<void> {
    let cursor: SakiWireProjectionCursor | null = null
    try {
      while (!signal.aborted) {
        const result = await this.api.watchProjections(cursor, signal)
        signal.throwIfAborted()
        if (!result.ok) { await this.access.reloadAccess(); return }
        const changed = cursor !== result.cursor; cursor = result.cursor
        if (changed) await this.reload(false)
      }
    } catch { if (!signal.aborted) this.publish({ offline: true }) }
  }
  /** Create one Issue using the displayed Project and mapping revisions. */
  create = async (): Promise<void> => {
    const scope = this.scope()
    const candidate = this.snapshot.projects.value?.find(value => value.project.id === scope.projectId)
    const board = candidate?.board.value
    if (candidate === undefined || this.snapshot.projects.loading || this.snapshot.projects.failure !== null || candidate.board.failure !== null || board?.mapping.state !== 'valid' || !board.effectiveMutationAvailability.available || this.snapshot.offline) return
    if (Object.values(scope.pending).some(intent => intent.type === 'create-work-item' && intent.projectId === candidate.project.id)) return
    const draft = scope.drafts[candidate.project.id] ?? emptyWorkDraft()
    const parsed = sakiCreateWorkItemIntentSchema.safeParse({ type: 'create-work-item', intentId: `intent-${randomUUID()}`, projectId: candidate.project.id, expected: { projectRevision: candidate.project.revision, synchronizationRevision: board.synchronizationRevision, mappingRevision: board.mapping.configurationRevision }, ...draft, acceptanceCriteria: draft.acceptanceCriteria.split('\n').map(line => line.trim()).filter(Boolean) })
    if (!parsed.success) { this.publish({ inputError: true }); return }
    await this.submit(parsed.data)
  }
  /** Submit only the offer explicitly retained by the confirmation dialog. */
  submitOffer = async (): Promise<void> => {
    const offer = this.snapshot.confirmation
    if (offer === null || this.snapshot.offline) return
    if (Object.values(this.scope().pending).some(intent => offer.type === 'give-work-item-to-agent'
      ? intent.type === offer.type && intent.projectId === offer.projectId && intent.workItemId === offer.workItemId
      : intent.type === offer.type && intent.interventionId === offer.interventionId)) return
    const identity = { type: offer.type, intentId: `intent-${randomUUID()}` }
    const parsed = offer.type === 'give-work-item-to-agent'
      ? sakiGiveWorkItemToAgentIntentSchema.safeParse({
        ...identity, projectId: offer.projectId, workItemId: offer.workItemId,
        expectedProjectRevision: offer.expectedProjectRevision, expectedRemoteFingerprint: offer.expectedRemoteFingerprint,
      })
      : sakiAnswerInterventionIntentSchema.safeParse({ ...identity, interventionId: offer.interventionId, expectedInterventionRevision: offer.expectedInterventionRevision, answer: { kind: 'text', text: this.scope().answers[offer.interventionId] ?? '' } })
    if (!parsed.success) { this.publish({ inputError: true }); return }
    this.publish({ confirmation: null })
    await this.submit(parsed.data)
  }
  /**
   * Replay a persisted exact request after transport loss or backend-authorized recovery.
   * @param intentId - original request identity.
   */
  retry = async (intentId: WorkIntent['intentId']): Promise<void> => { const intent = this.scope().pending[intentId]; if (intent !== undefined) await this.submit(intent) }
  /**
   * Dismiss a settled result so another independent gesture may begin.
   * @param intentId - acknowledged terminal request identity.
   */
  dismiss = (intentId: WorkIntent['intentId']): void => {
    const operation = this.operations.get(intentId)
    if (operation?.result == null || (!operation.result.ok && operation.result.reason !== 'conflict' && operation.result.reason !== 'denied' && operation.result.reason !== 'canceled')) return
    const scope = this.scope(); const pending = { ...scope.pending }; Reflect.deleteProperty(pending, intentId)
    const drafts = { ...scope.drafts }
    if (operation.result.ok && operation.intent.type === 'create-work-item') Reflect.deleteProperty(drafts, operation.intent.projectId)
    this.operations.delete(intentId); this.save({ ...scope, drafts, pending }); this.publish()
  }
  private async submit(intent: WorkIntent): Promise<void> {
    const auth = this.auth
    if (auth === undefined || this.operations.get(intent.intentId)?.state === 'pending') return
    const signal = AbortSignal.any([this.authority.signal, this.lifetime.signal])
    const scope = this.scope(); this.save({ ...scope, pending: { ...scope.pending, [intent.intentId]: intent } })
    this.operations.set(intent.intentId, { intent, state: 'pending', result: null }); this.publish()
    try {
      const result = await this.dispatch(intent, auth.requestToken, signal)
      if (signal.aborted) return
      this.operations.set(intent.intentId, { intent, state: 'settled', result }); this.publish()
      await this.reload(intent.type === 'create-work-item')
    } catch {
      if (!signal.aborted) { this.operations.set(intent.intentId, { intent, state: 'unacknowledged', result: null }); this.publish({ offline: true }) }
    }
  }
  private dispatch(intent: WorkIntent, token: string, signal: AbortSignal): Promise<Result> {
    switch (intent.type) {
      case 'create-work-item': return this.api.createWorkItem(intent, token, signal)
      case 'give-work-item-to-agent': return this.api.giveWorkItemToAgent(intent, token, signal)
      case 'answer-intervention': return this.api.answerIntervention(intent, token, signal)
      /* v8 ignore next -- The closed wire union is parsed at creation and hydration. */
      default: return assertNever(intent)
    }
  }
}

/** Actions available to pure Work presentation components. */
export type WorkActions = Pick<WorkController, 'refresh' | 'selectProject' | 'editDraft' | 'editAnswer' | 'confirm' | 'create' | 'submitOffer' | 'retry' | 'dismiss'>
