/** Delivery reads and exact mutation recovery survive component, Project, and Work Item switches. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { SakiHostClient } from '@breakfastdapaidang/saki-host-api/client'
import type { SakiWireAccessProjection, SakiWireBranchDeliveryIntentResult, SakiWireDeliveryWorkspaceResult } from '@breakfastdapaidang/saki-host-api/wire'
import type { ChangesController } from './changes-controller.ts'
import type { PlanningController, PlanningProject, PlanningRead } from './planning-controller.ts'
import { completedPlanningRead } from './planning-controller.ts'
import { createDeliveryStore, deliveryIntentSchema } from './delivery-state.ts'
import type { DeliveryConfirmation, DeliveryDraft, DeliveryIntent, DeliveryProjectState } from './delivery-state.ts'

/** Current Host-owned controls and GitHub evidence. */
export type DeliveryWorkspace = Extract<SakiWireDeliveryWorkspaceResult, { ok: true }>['projection']
/** Explicit delivery gesture, independent of its wire Intent spelling. */
export type DeliveryGesture = keyof DeliveryWorkspace['actions']
type Auth = Extract<SakiWireAccessProjection, { kind: 'authenticated' }>
type Result = SakiWireBranchDeliveryIntentResult
type Api = Pick<SakiHostClient, 'queryDeliveryWorkspace' | 'saveBranchDelivery' | 'pushBranchDelivery' | 'createBranchDeliveryPullRequest' | 'associateBranchDeliveryPullRequest' | 'markBranchDeliveryInReview' | 'acceptBranchDelivery'>
type Interaction = ReturnType<ReturnType<typeof createDeliveryStore>['create']>
/** Transport progress remains separate from the durable receipt. */
export interface DeliveryOperation {
  readonly confirmation: DeliveryConfirmation
  readonly pending: boolean
  readonly result: Result | null
}
/** Stable pure render state for the selected delivery destination. */
export interface DeliverySnapshot {
  readonly read: PlanningRead<DeliveryWorkspace>
  readonly draft: DeliveryDraft
  readonly confirmation: DeliveryConfirmation | null
  readonly operation: DeliveryOperation | null
  readonly inputError: 'invalid' | 'local-stale' | null
}
const emptyDraft = (): DeliveryDraft => ({ headRef: null, baseRef: null, title: null, body: '' })
const emptyRead = (): PlanningRead<DeliveryWorkspace> => ({ value: null, loading: false, failure: null })

/**
 * Identify a proven terminal outcome; pending and reconciliation never unlock a new gesture.
 * @param result - last received result, or null after response loss.
 * @returns whether the user may acknowledge this exact request.
 */
export function deliverySettled(result: Result | null): boolean {
  return result !== null && 'receipt' in result
    && ['succeeded', 'conflict', 'denied', 'failure'].includes(result.receipt.state)
}

/** One owner for selected reads, frozen confirmations, and outstanding Project mutations. */
export class DeliveryController {
  private readonly lifetime = new AbortController()
  private authority = new AbortController()
  private read: { controller: AbortController; interactive: boolean } | undefined
  private auth: Auth | undefined
  private project: PlanningProject | undefined
  private previousDetail: PlanningProject['detail']['value'] = null
  private readonly operations = new Map<string, DeliveryOperation>()
  private readonly disposers: (() => void)[] = []
  private readonly view = createSnapshotStore<DeliverySnapshot>({
    read: emptyRead(), draft: emptyDraft(), confirmation: null, operation: null, inputError: null,
  })
  private get snapshot(): DeliverySnapshot { return this.view.getSnapshot() }

  /**
   * @param api - exact Host delivery requests.
   * @param planning - shared authentication, address, and confirmed Work Item reads.
   * @param changes - current Project Git observation used only to select a Commit.
   * @param interaction - persisted drafts and original requests.
   */
  constructor(private readonly api: Api, private readonly planning: Pick<PlanningController, 'getSnapshot' | 'subscribe' | 'refresh'>,
    private readonly changes: Pick<ChangesController, 'getSnapshot'>, private readonly interaction: Interaction = createDeliveryStore().create()) {
    interaction.actions.hydrate(interaction.store.getSnapshot())
    this.disposers.push(planning.subscribe(this.sync), interaction.store.subscribe(() => { this.publish() }))
  }
  /**
   * Read the stable delivery rendering snapshot.
   * @returns the latest confirmed facts and interaction state.
   */
  getSnapshot = this.view.getSnapshot.bind(this.view)
  /**
   * Subscribe to owned read and interaction updates.
   * @param listener - renderer notification callback.
   * @returns unsubscribe callback.
   */
  subscribe = this.view.subscribe.bind(this.view)
  /** Resolve the restored delivery address after access becomes available. */
  start = (): void => { this.sync() }
  /** Abort owned requests without discarding unresolved persisted effects. */
  dispose = (): void => {
    this.lifetime.abort(); this.authority.abort(); this.read?.controller.abort()
    for (const dispose of this.disposers) dispose()
  }
  private sync = (): void => {
    const { access, project } = this.planning.getSnapshot()
    const auth = access !== null && access !== 'unavailable' && access.kind === 'authenticated' ? access : undefined
    const selected = auth !== undefined && project?.address.view === 'delivery' && project.address.workItemId !== null ? project : undefined
    const authorityChanged = auth?.principal.id !== this.auth?.principal.id || auth?.requestToken !== this.auth?.requestToken
    const addressChanged = selected?.id !== this.project?.id || selected?.address.workItemId !== this.project?.address.workItemId
    const detailChanged = selected !== undefined && selected.detail.value !== this.previousDetail
    this.previousDetail = selected?.detail.value ?? null
    this.auth = auth; this.project = selected
    if (authorityChanged) { this.authority.abort(); this.authority = new AbortController(); this.operations.clear() }
    if (authorityChanged || addressChanged) {
      this.read?.controller.abort()
      this.publish({ read: emptyRead(), confirmation: null, inputError: null })
      if (selected !== undefined) void this.refresh()
    } else if (detailChanged) void this.refresh('cached')
  }
  private state(): DeliveryProjectState {
    return this.auth === undefined || this.project === undefined ? { drafts: {}, pending: null }
      : this.interaction.store.getSnapshot().scopes[this.auth.principal.id]?.[this.project.id] ?? { drafts: {}, pending: null }
  }
  private save(value: DeliveryProjectState, auth: Auth, projectId: PlanningProject['id']): void {
    this.interaction.actions.project(auth.principal.id, projectId, value)
  }
  private publish(patch: Partial<DeliverySnapshot> = {}): void {
    const state = this.state(); const workItemId = this.project?.address.workItemId
    const operation = state.pending === null ? null : this.operations.get(state.pending.request.intentId)
      ?? { confirmation: state.pending, pending: false, result: null }
    this.view.set({ ...this.snapshot, ...patch, operation,
      draft: workItemId == null ? emptyDraft() : state.drafts[workItemId] ?? emptyDraft() })
  }
  /**
   * Refresh delivery evidence; invalidation reads cannot cancel an explicit GitHub refresh.
   * @param refresh - interactive targeted reads, or durable cached facts after invalidation.
   */
  refresh = async (refresh: 'cached' | 'interactive' = 'interactive'): Promise<void> => {
    const project = this.project; const workItemId = project?.address.workItemId
    if (project === undefined || workItemId == null || this.auth === undefined) return
    if (this.read?.interactive && refresh === 'cached') return
    this.read?.controller.abort()
    const controller = new AbortController(); this.read = { controller, interactive: refresh === 'interactive' }
    const signal = AbortSignal.any([controller.signal, this.authority.signal, this.lifetime.signal])
    this.publish({ read: { ...this.snapshot.read, loading: true } })
    try {
      const result = await this.api.queryDeliveryWorkspace(project.id, workItemId, refresh, signal)
      signal.throwIfAborted()
      this.publish({ read: completedPlanningRead(result) })
    } catch {
      if (!signal.aborted) this.publish({ read: { ...this.snapshot.read, loading: false, failure: 'unavailable' } })
    } finally { this.finishRead(controller) }
  }
  private finishRead(controller: AbortController): void {
    if (this.read?.controller === controller) this.read = undefined
  }
  /**
   * Update only the selected Work Item's unsent branch or PR text.
   * @param patch - explicitly edited fields.
   */
  editDraft = (patch: Partial<DeliveryDraft>): void => {
    const project = this.project; const auth = this.auth; const workspace = this.snapshot.read.value
    if (project === undefined || auth === undefined || workspace === null || this.state().pending !== null) return
    const id = workspace.workItemId
    const state = this.state()
    this.save({ ...state, drafts: { ...state.drafts, [id]: { ...this.snapshot.draft, ...patch } } }, auth, project.id)
    this.publish({ confirmation: null, inputError: null })
  }
  /**
   * Freeze a Host-offered gesture and the exact target shown in its confirmation.
   * @param gesture - operator-selected action.
   */
  prepare = (gesture: DeliveryGesture): void => {
    const { read, draft } = this.snapshot; const workspace = read.value
    const item = this.project?.detail.value?.workItem
    if (this.auth === undefined || workspace === null || read.loading || read.failure !== null || this.state().pending !== null
      || this.changes.getSnapshot().operation !== null || !workspace.actions[gesture].available) return
    const target = workspace.selection?.target ?? workspace.branchDelivery?.delivery.target
    if (target === undefined) return
    const delivery = workspace.branchDelivery?.delivery
    const reference = { intentId: `intent-${randomUUID()}`, deliveryId: delivery?.id, expectedDeliveryRevision: delivery?.revision }
    let request: unknown
    let summary: DeliveryConfirmation['summary'] = {
      repository: target.repository.nameWithOwner, commitId: delivery?.commitId ?? '', headRef: delivery?.headRef ?? '', baseRef: delivery?.baseRef ?? '',
      helper: workspace.pushCredentialHelper, appId: target.installation.appId, installationId: target.installation.installationId,
    }
    switch (gesture) {
      case 'save': {
        const git = this.changes.getSnapshot().read
        const observation = git.value?.result.ok === true ? git.value.result.observation : null
        const expected = workspace.selection?.expected
        if (git.loading || git.failure !== null || observation?.head.kind !== 'commit' || expected === undefined
          || git.value?.projectId !== workspace.projectId || observation.bindingId !== expected.binding.id
          || observation.bindingRevision !== expected.binding.revision) {
          this.publish({ inputError: 'local-stale' }); return
        }
        const head = draft.headRef ?? (observation.branch.kind === 'attached' ? observation.branch.name : '')
        const base = draft.baseRef ?? delivery?.baseRef ?? ''
        summary = { ...summary, commitId: observation.head.objectId, headRef: canonicalRef(head), baseRef: canonicalRef(base) }
        request = { type: 'save-branch-delivery', intentId: reference.intentId, projectId: workspace.projectId, workItemId: workspace.workItemId,
          expected, commitId: summary.commitId, headRef: summary.headRef, baseRef: summary.baseRef }
        break
      }
      case 'push': request = { ...reference, type: 'push-branch-delivery' }; break
      case 'create': request = { ...reference, type: 'create-branch-delivery-pull-request', title: draft.title ?? item?.title ?? '', body: draft.body }; break
      case 'associate': {
        const association = workspace.association
        if (association.state !== 'unique') return
        request = { ...reference, type: 'associate-branch-delivery-pull-request', pullRequestId: association.pullRequest.id, pullRequestNumber: association.pullRequest.number }; break
      }
      case 'review':
      case 'accept': request = { ...reference, type: gesture === 'review' ? 'mark-branch-delivery-in-review' : 'accept-branch-delivery', expectedWorkItemRemoteFingerprint: workspace.selection?.expected.workItemRemoteFingerprint }; break
      /* v8 ignore next -- Gestures are a closed typed UI union. */
      default: return assertNever(gesture)
    }
    const parsed = deliveryIntentSchema.safeParse(request)
    this.publish(parsed.success ? { confirmation: { request: parsed.data, workItemId: workspace.workItemId, summary }, inputError: null } : { inputError: 'invalid' })
  }
  /** Close the unsent confirmation; no operation has started. */
  cancel = (): void => { this.publish({ confirmation: null }) }
  /** Submit exactly the target and payload shown in the confirmation. */
  confirm = async (): Promise<void> => {
    const auth = this.auth; const project = this.project; const confirmation = this.snapshot.confirmation
    if (auth === undefined || project === undefined || confirmation === null || this.state().pending !== null) return
    this.publish({ confirmation: null }); await this.submit(confirmation, auth, project.id)
  }
  /** Replay only the retained original request after uncertain transport or pending recovery. */
  retry = async (): Promise<void> => {
    const operation = this.snapshot.operation; const auth = this.auth; const project = this.project
    if (auth === undefined || project === undefined || operation === null || operation.pending || deliverySettled(operation.result)) return
    await this.submit(operation.confirmation, auth, project.id)
  }
  /** Acknowledge a proven terminal receipt; unresolved effects remain retained. */
  dismiss = (): void => {
    const operation = this.snapshot.operation; const auth = this.auth; const project = this.project
    if (auth === undefined || project === undefined || operation === null || !deliverySettled(operation.result)) return
    this.operations.delete(operation.confirmation.request.intentId)
    this.save({ ...this.state(), pending: null }, auth, project.id); this.publish()
  }
  private async submit(confirmation: DeliveryConfirmation, auth: Auth, projectId: PlanningProject['id']): Promise<void> {
    const signal = AbortSignal.any([this.authority.signal, this.lifetime.signal])
    const request = confirmation.request
    this.save({ ...this.state(), pending: confirmation }, auth, projectId)
    this.operations.set(request.intentId, { confirmation, pending: true, result: null }); this.publish()
    try {
      const result = await this.dispatch(request, auth.requestToken, signal)
      signal.throwIfAborted()
      this.operations.set(request.intentId, { confirmation, pending: false, result }); this.publish()
    } catch {
      if (!signal.aborted) { this.operations.set(request.intentId, { confirmation, pending: false, result: null }); this.publish() }
      return
    }
    if (this.project?.id === projectId) {
      await this.refresh()
      if (request.type === 'mark-branch-delivery-in-review' || request.type === 'accept-branch-delivery') await this.planning.refresh()
    }
  }
  private dispatch(request: DeliveryIntent, token: string, signal: AbortSignal): Promise<Result> {
    switch (request.type) {
      case 'save-branch-delivery': return this.api.saveBranchDelivery(request, token, signal)
      case 'push-branch-delivery': return this.api.pushBranchDelivery(request, token, signal)
      case 'create-branch-delivery-pull-request': return this.api.createBranchDeliveryPullRequest(request, token, signal)
      case 'associate-branch-delivery-pull-request': return this.api.associateBranchDeliveryPullRequest(request, token, signal)
      case 'mark-branch-delivery-in-review': return this.api.markBranchDeliveryInReview(request, token, signal)
      case 'accept-branch-delivery': return this.api.acceptBranchDelivery(request, token, signal)
      /* v8 ignore next -- Exact requests are parsed before persistence and after hydration. */
      default: return assertNever(request)
    }
  }
}
function canonicalRef(value: string): string { const ref = value.trim(); return ref.startsWith('refs/heads/') ? ref : `refs/heads/${ref}` }
/** Plain gestures exposed to the pure delivery page. */
export type DeliveryActions = Pick<DeliveryController, 'refresh' | 'editDraft' | 'prepare' | 'cancel' | 'confirm' | 'retry' | 'dismiss'>
