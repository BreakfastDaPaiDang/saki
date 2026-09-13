/** Project Git observations and exact mutation replay owned independently of React mounts. */
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { SakiHostClient } from '@breakfastdapaidang/saki-host-api/client'
import type { SakiWireAccessProjection, SakiWireProjectChangesResult, SakiWireProjectDiffResult, SakiWireProjectDiffRequest, SakiWireStageFilesResult, SakiWireUnstageFilesResult, SakiWireCreateCommitResult } from '@breakfastdapaidang/saki-host-api/wire'
import type { PlanningController, PlanningRead } from './planning-controller.ts'
import { changesIntentSchema, createChangesStore } from './changes-state.ts'
import type { ChangesDraft, ChangesIntent } from './changes-state.ts'

/** Complete Project-bound Git facts. */
export type ChangesProjection = Extract<SakiWireProjectChangesResult, { ok: true }>['projection']
/** One observed path, with independent index and worktree evidence. */
export type ChangesRow = Extract<ChangesProjection['result'], { ok: true }>['observation']['changes'][number]
type Diff = Extract<SakiWireProjectDiffResult, { ok: true }>['projection']['result']
type Result = SakiWireStageFilesResult | SakiWireUnstageFilesResult | SakiWireCreateCommitResult
type Auth = Extract<SakiWireAccessProjection, { kind: 'authenticated' }>
type Api = Pick<SakiHostClient, 'queryProjectIndex' | 'queryProjectChanges' | 'readProjectDiff' | 'stageFiles' | 'unstageFiles' | 'createCommit'>
type Interaction = ReturnType<ReturnType<typeof createChangesStore>['create']>
/** Transport progress and the last authoritative receipt for an exact request. */
export interface ChangesOperation { readonly intent: ChangesIntent; readonly pending: boolean; readonly result: Result | null }
/** Pure render state for the currently selected Project. */
export interface ChangesSnapshot {
  readonly read: PlanningRead<ChangesProjection>
  readonly diff: PlanningRead<Diff>
  readonly selection: SakiWireProjectDiffRequest | null
  readonly draft: ChangesDraft
  readonly operation: ChangesOperation | null
  readonly confirmation: ChangesIntent | null
  readonly inputError: boolean
}
const emptyRead = <T>(): PlanningRead<T> => ({ value: null, loading: false, failure: null })
const emptyDraft = (): ChangesDraft => ({ message: '', pending: null })

/**
 * Whether a receipt proves the request has finished; unknown effects remain recoverable.
 * @param result - last response, or transport loss.
 * @returns whether the user may acknowledge and clear this request.
 */
export function changesSettled(result: Result | null): boolean {
  return result !== null && 'receipt' in result && (result.ok || result.reason === 'conflict' || result.reason === 'failure' || result.reason === 'canceled')
}

/** Owns revision-fenced Git reads and one durable outstanding gesture per Project. */
export class ChangesController {
  private readonly listeners = new Set<() => void>()
  private readonly lifetime = new AbortController()
  private authority = new AbortController()
  private read: AbortController | undefined
  private diffRead: AbortController | undefined
  private auth: Auth | undefined
  private projectId: ChangesProjection['projectId'] | undefined
  private readonly operations = new Map<string, ChangesOperation>()
  private readonly disposers: (() => void)[] = []
  private snapshot: ChangesSnapshot = {
    read: emptyRead(), diff: emptyRead(), selection: null, draft: emptyDraft(), operation: null, confirmation: null, inputError: false,
  }

  /**
   * @param api - typed Host API with server-owned Git authorization.
   * @param planning - shared authenticated Project selection.
   * @param interaction - persisted original requests and editable drafts.
   */
  constructor(private readonly api: Api, private readonly planning: Pick<PlanningController, 'getSnapshot' | 'subscribe'>, private readonly interaction: Interaction = createChangesStore().create()) {
    interaction.actions.hydrate(interaction.store.getSnapshot())
    this.disposers.push(planning.subscribe(this.sync), interaction.store.subscribe(() => { this.publish() }))
  }
  /**
   * Read the stable Changes rendering state.
   * @returns the current stable rendering snapshot.
   */
  getSnapshot = (): ChangesSnapshot => this.snapshot
  /**
   * Observe Changes state updates.
   * @param listener - rendering notification callback.
   * @returns unsubscribe callback.
   */
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  /** Read the restored Changes destination after access resolves. */
  start = (): void => { this.sync() }
  /** Abort owned requests while retaining every unacknowledged mutation. */
  dispose = (): void => {
    this.lifetime.abort(); this.authority.abort(); this.read?.abort(); this.diffRead?.abort()
    for (const dispose of this.disposers) dispose()
    this.listeners.clear()
  }
  private sync = (): void => {
    const { access, project } = this.planning.getSnapshot()
    const auth = access !== null && access !== 'unavailable' && access.kind === 'authenticated' ? access : undefined
    const changed = auth?.principal.id !== this.auth?.principal.id || auth?.requestToken !== this.auth?.requestToken
    const projectId = auth !== undefined && project?.address.view === 'changes' ? project.id : undefined
    if (!changed && projectId === this.projectId) return
    if (changed) { this.authority.abort(); this.authority = new AbortController(); this.operations.clear() }
    this.auth = auth; this.projectId = projectId
    this.read?.abort(); this.diffRead?.abort()
    this.publish({ read: emptyRead(), diff: emptyRead(), selection: null, confirmation: null, inputError: false })
    if (projectId !== undefined) void this.refresh()
  }
  private draft(): ChangesDraft {
    return this.auth === undefined || this.projectId === undefined ? emptyDraft()
      : this.interaction.store.getSnapshot().scopes[this.auth.principal.id]?.[this.projectId] ?? emptyDraft()
  }
  private save(value: ChangesDraft): void {
    if (this.auth !== undefined && this.projectId !== undefined) {
      this.interaction.actions.project(this.auth.principal.id, this.projectId, value)
    }
  }
  private publish(patch: Partial<ChangesSnapshot> = {}): void {
    const draft = this.draft()
    const operation = draft.pending === null ? null : this.operations.get(draft.pending.intentId)
      ?? { intent: draft.pending, pending: false, result: null }
    this.snapshot = { ...this.snapshot, ...patch, draft, operation }
    notifySubscribers(this.listeners, '[saki-changes]')
  }
  /** Read a fresh registry revision and complete Git observation, invalidating any selected Diff. */
  refresh = async (): Promise<void> => {
    const projectId = this.projectId
    if (projectId === undefined || this.auth === undefined) return
    this.read?.abort(); this.diffRead?.abort()
    const owned = new AbortController(); this.read = owned
    const signal = AbortSignal.any([owned.signal, this.authority.signal, this.lifetime.signal])
    this.publish({ read: { ...this.snapshot.read, loading: true }, diff: emptyRead(), selection: null, confirmation: null })
    try {
      const index = await this.api.queryProjectIndex(signal)
      signal.throwIfAborted()
      if (!index.ok) { this.publish({ read: { value: null, loading: false, failure: index.reason } }); return }
      const result = await this.api.queryProjectChanges(projectId, index.projection.revision, signal)
      signal.throwIfAborted()
      this.publish({ read: result.ok
        ? { value: result.projection, loading: false, failure: null }
        : { value: null, loading: false, failure: result.reason } })
    } catch { if (!signal.aborted) this.publish({ read: { ...this.snapshot.read, loading: false, failure: 'unavailable' } }) }
  }
  /**
   * Read one bounded page; a new selection cancels and replaces the previous page.
   * @param request - exact observed change and optional continuation cursor.
   */
  selectDiff = async (request: SakiWireProjectDiffRequest): Promise<void> => {
    const projection = this.snapshot.read.value
    if (projection === null || this.snapshot.read.loading || this.snapshot.read.failure !== null) return
    this.diffRead?.abort(); const owned = new AbortController(); this.diffRead = owned
    const signal = AbortSignal.any([owned.signal, this.authority.signal, this.lifetime.signal])
    this.publish({ selection: request, diff: { value: null, loading: true, failure: null } })
    try {
      const result = await this.api.readProjectDiff(projection.projectId, projection.registryRevision, request, signal)
      signal.throwIfAborted()
      this.publish({ diff: result.ok
        ? { value: result.projection.result, loading: false, failure: null }
        : { value: null, loading: false, failure: result.reason } })
    } catch { if (!signal.aborted) this.publish({ diff: { value: null, loading: false, failure: 'unavailable' } }) }
  }
  /**
   * Update the unsent commit draft.
   * @param message - editable commit message before submission.
   */
  editMessage = (message: string): void => {
    if (this.draft().pending === null) { this.save({ ...this.draft(), message }); this.publish({ inputError: false }) }
  }
  private expected() {
    const read = this.snapshot.read; const projection = read.value
    if (projection === null || !projection.result.ok || read.loading || read.failure !== null || this.draft().pending !== null) return null
    const observation = projection.result.observation
    if (observation.index.kind !== 'tree') return null
    return { projectId: projection.projectId, expectedRegistryRevision: projection.registryRevision,
      expectedProjectRevision: projection.projectRevision,
      expectedBinding: { id: observation.bindingId, revision: observation.bindingRevision }, expectedStatus: observation.fingerprint,
      expectedHead: observation.head, expectedIndex: observation.index, expectedWorktree: observation.worktree }
  }
  /**
   * Submit a single observed path using its original content fingerprint.
   * @param row - displayed status row.
   * @param type - explicit index mutation.
   */
  changeIndex = async (row: ChangesRow, type: 'stage-files' | 'unstage-files'): Promise<void> => {
    const auth = this.auth
    if (auth === undefined) return
    const expected = this.expected(); const operations = this.snapshot.read.value?.gitOperations
    if (expected === null || !(type === 'stage-files' ? operations?.stageFiles.available : operations?.unstageFiles.available)) return
    const intent = changesIntentSchema.parse({ type, intentId: `intent-${randomUUID()}`, expected, changes: [{ id: row.id, fingerprint: row.fingerprint }] })
    await this.submit(intent, auth)
  }
  /** Retain the displayed index and message for explicit commit confirmation. */
  prepareCommit = (): void => {
    const expected = this.expected()
    if (expected === null || !this.snapshot.read.value?.gitOperations.createCommit.available) return
    const parsed = changesIntentSchema.safeParse({ type: 'create-commit', intentId: `intent-${randomUUID()}`, expected, message: this.draft().message })
    this.publish(parsed.success ? { confirmation: parsed.data, inputError: false } : { inputError: true })
  }
  /** Close the unsubmitted commit confirmation. */
  cancelCommit = (): void => { this.publish({ confirmation: null }) }
  /** Submit the exact index and message shown in the confirmation. */
  confirmCommit = async (): Promise<void> => {
    const auth = this.auth
    if (auth === undefined) return
    const intent = this.snapshot.confirmation
    if (intent === null || this.draft().pending !== null) return
    this.publish({ confirmation: null }); await this.submit(intent, auth)
  }
  /** Replay the original request, including all original revision fences. */
  retry = async (): Promise<void> => {
    const auth = this.auth
    if (auth === undefined) return
    const operation = this.snapshot.operation
    if (operation === null || operation.pending || changesSettled(operation.result)) return
    await this.submit(operation.intent, auth)
  }
  /** Acknowledge only a terminal result; unresolved effects continue to block new gestures. */
  dismiss = (): void => {
    const operation = this.snapshot.operation
    if (operation === null || !changesSettled(operation.result)) return
    this.operations.delete(operation.intent.intentId)
    this.save({ message: operation.result?.ok === true && operation.intent.type === 'create-commit' ? '' : this.draft().message, pending: null }); this.publish()
  }
  private async submit(intent: ChangesIntent, auth: Auth): Promise<void> {
    const signal = AbortSignal.any([this.authority.signal, this.lifetime.signal])
    this.save({ ...this.draft(), pending: intent })
    this.operations.set(intent.intentId, { intent, pending: true, result: null }); this.publish()
    try {
      const result = await this.dispatch(intent, auth.requestToken, signal)
      signal.throwIfAborted()
      this.operations.set(intent.intentId, { intent, pending: false, result }); this.publish()
      if (this.projectId === intent.expected.projectId) await this.refresh()
    } catch {
      if (!signal.aborted) { this.operations.set(intent.intentId, { intent, pending: false, result: null }); this.publish() }
    }
  }
  private dispatch(intent: ChangesIntent, token: string, signal: AbortSignal): Promise<Result> {
    switch (intent.type) {
      case 'stage-files': return this.api.stageFiles(intent, token, signal)
      case 'unstage-files': return this.api.unstageFiles(intent, token, signal)
      case 'create-commit': return this.api.createCommit(intent, token, signal)
      /* v8 ignore next -- The closed union is parsed at creation and hydration. */
      default: return assertNever(intent)
    }
  }
}

/** Plain gestures available to the Changes page. */
export type ChangesActions = Pick<ChangesController, 'refresh' | 'selectDiff' | 'editMessage' | 'changeIndex' | 'prepareCommit' | 'cancelCommit' | 'confirmCommit' | 'retry' | 'dismiss'>
