/** Recoverable GitHub-backed Work Item creation and movement sagas. */

import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { canonicalDigest } from '@breakfastdapaidang/saki-execution'
import {
  GitHubProviderError,
  githubIssueCreateMarkerId,
  githubFailureSchema,
  type GitHubFailure,
  type GitHubIssueCreateInspection,
  type GitHubIssueCreateRequest,
  type GitHubIssueStateSetInspection,
  type GitHubIssueStateSetRequest,
  type GitHubProjectItemAddInspection,
  type GitHubProjectItemAddRequest,
  type GitHubProjectOptionId,
  type GitHubProjectItemPositionSetInspection,
  type GitHubProjectItemPositionSetRequest,
  type GitHubProjectItemStatusSetInspection,
  type GitHubProjectItemStatusSetRequest,
  type SakiGitHub,
} from '@breakfastdapaidang/saki-github'
import { enqueueKeyedOperation } from './keyed-operation.ts'
import type {
  GitHubWorkItemMutationContext,
  GitHubWorkItemMutationContextResult,
} from './github-sync.ts'
import {
  createWorkItemIntentSchema,
  githubWorkItemRecoveryId,
  githubWorkItemStageMutationId,
  githubWorkItemIntentRecordSchema,
  githubWorkItemRecoveryRecordSchema,
  moveWorkItemIntentSchema,
} from './spec.ts'
import type {
  ControlIntentActor,
  GitHubWorkItemIntentRecord,
  GitHubWorkItemBoardObservation,
  GitHubWorkItemPositionObservation,
  GitHubWorkItemRecoveryRecord,
  GitHubWorkItemTargetedObservation,
  SakiWorkItemMarkerId,
} from './spec.ts'
import type {
  CreateWorkItemIntent,
  MoveWorkItemIntent,
  SakiBoardMutationAvailabilityProjection,
  SakiBoardMutationOverlayProjection,
  SakiBoardStatus,
  SakiConfirmedBoardProjection,
  SakiBoardWorkItemId,
  SakiControlIntentId,
  SakiDevelopmentProjectId,
  SakiIntentReceiptId,
  SakiWorkItemMutationStageKind,
  SakiWorkItemRecoveryAction,
  GitHubStatusOptionMapping,
  SakiWorkItemRecoveryId,
  SakiWorkItemIntentReceipt,
} from './types.ts'
import {
  boardWorkItemId,
  targetedBoardRemoteFingerprint,
} from './work-item-mapping.ts'
import { renderGitHubWorkItemIssueBody } from './work-item-issue.ts'

type SakiWorkItemIntent = CreateWorkItemIntent | MoveWorkItemIntent

/** Durable create/move Work Item Intent table keyed by caller idempotency identity. */
export type GitHubWorkItemIntentTable = KvTable<SakiControlIntentId, GitHubWorkItemIntentRecord>
/** Durable targeted recovery table keyed by Development Project and Work Item identity. */
export type GitHubWorkItemRecoveryTable = KvTable<SakiWorkItemRecoveryId, GitHubWorkItemRecoveryRecord>

type WorkItemAction = 'work-item:create' | 'work-item:move'
type WorkItemActionAvailability = Readonly<Record<WorkItemAction, boolean>>

/** Work Item state layered over the synchronization-owned confirmed Board. */
interface GitHubWorkItemOperationsProjection {
  readonly effectiveMutationAvailability: SakiBoardMutationAvailabilityProjection
  readonly mutationOverlays: readonly SakiBoardMutationOverlayProjection[]
}

interface GitHubWorkItemOperationsOptions {
  readonly intentTable: GitHubWorkItemIntentTable
  readonly recoveryTable: GitHubWorkItemRecoveryTable
  readonly mutationContext: (projectId: SakiDevelopmentProjectId) => GitHubWorkItemMutationContextResult
  readonly projectRevision: (projectId: SakiDevelopmentProjectId) => number | 'not-found'
  readonly authorityCurrent: (actor: ControlIntentActor, action: WorkItemAction) => boolean
  readonly validateActorReference: (actor: ControlIntentActor) => void
  readonly requestScan: (projectId: SakiDevelopmentProjectId) => Promise<void>
  readonly notifyChanged: () => void
  readonly reportUnexpectedFailure: (error: unknown) => void
  readonly lifetime: AbortSignal
}

/** Fully parsed Work Item saga state after targeted-recovery validation. */
export interface ValidatedGitHubWorkItemState {
  readonly intents: readonly GitHubWorkItemIntentRecord[]
}

class IntentCasConflict extends Error {}

type GitHubWorkItemObservation = GitHubWorkItemIntentRecord['observedPrefix'][number]
type GitHubWorkItemBoardView = Pick<
  GitHubWorkItemTargetedObservation,
  'workItemId' | 'remoteFingerprint' | 'facts' | 'observedAt'
>
type GitHubWorkItemMembershipObservation = Extract<GitHubWorkItemObservation, { stageKind: 'project-item-add' }>
type GitHubWorkItemIssueCreateObservation = Extract<GitHubWorkItemObservation, { stageKind: 'issue-create' }>
type GitHubIssueCreateReconciliationState = Exclude<
  GitHubIssueCreateInspection['snapshot']['outcome']['state'],
  'unique-issue'
>
type GitHubIssueCreateReconciliationReason = 'effect-unknown' | 'evidence-conflict' | 'marker-ambiguous'
type GitHubWorkItemIssueStateObservation = Extract<GitHubWorkItemObservation, { stageKind: 'issue-state-set' }>
type GitHubWorkItemFailure = NonNullable<GitHubWorkItemIntentRecord['stages'][number]['failure']>
type GitHubWorkItemStage = GitHubWorkItemIntentRecord['stages'][number]
type GitHubWorkItemFailedStage = GitHubWorkItemStage & {
  state: 'failed'
  failure: GitHubWorkItemFailure
}
type GitHubWorkItemMembershipItem = Extract<
  GitHubWorkItemMembershipObservation['facts']['membership'],
  { state: 'present' }
>['item']
type GitHubWorkItemPositionItem = Extract<
  GitHubWorkItemPositionObservation['facts']['membership'],
  { state: 'present' }
>['item']
type GitHubWorkItemMoveTarget = Extract<GitHubWorkItemIntentRecord['target'], { kind: 'move-work-item' }>
type GitHubWorkItemResolvedTarget = NonNullable<GitHubWorkItemIntentRecord['stages'][number]['resolvedTarget']>
type GitHubWorkItemCreateStageKind = Extract<
  SakiWorkItemMutationStageKind,
  'issue-create' | 'project-item-add' | 'project-item-status-set'
>
type GitHubWorkItemMoveStageKind = Exclude<SakiWorkItemMutationStageKind, 'issue-create'>

const CREATE_RECONCILIATION_REASONS = {
  'absent-complete': 'effect-unknown',
  incomplete: 'effect-unknown',
  'known-issue-absent': 'effect-unknown',
  'marker-removed': 'evidence-conflict',
  'identity-conflict': 'evidence-conflict',
  'pull-request-marker-match': 'marker-ambiguous',
  'multiple-matches': 'marker-ambiguous',
} as const satisfies Readonly<Record<
  GitHubIssueCreateReconciliationState,
  GitHubIssueCreateReconciliationReason
>>

const STATUS_OPTION_FIELD_BY_STATUS = {
  inbox: 'inbox',
  backlog: 'backlog',
  ready: 'ready',
  'in-progress': 'inProgress',
  'in-review': 'inReview',
  done: 'done',
  canceled: 'canceled',
} as const satisfies Readonly<Record<SakiBoardStatus, keyof GitHubStatusOptionMapping>>

type ReadonlyTable<K extends string, V> = Pick<KvTable<K, V>, 'entries' | 'get' | 'size'>

/**
 * Validate the complete Work Item Intent/recovery relation without provider calls or writes.
 * @param intentTable - opened Work Item Intent table.
 * @param recoveryTable - opened targeted Work Item recovery table.
 * @param projectRevision - current Project revision lookup, including absence.
 * @param otherIntentIds - ids already retained by earlier Control Intent families.
 * @param validateActorReference - Foundation relationship validator for immutable attribution.
 * @returns detached Intents in deterministic recovery order.
 */
export function validateGitHubWorkItemOperationsDurableState(
  intentTable: ReadonlyTable<SakiControlIntentId, GitHubWorkItemIntentRecord>,
  recoveryTable: ReadonlyTable<SakiWorkItemRecoveryId, GitHubWorkItemRecoveryRecord>,
  projectRevision: (projectId: SakiDevelopmentProjectId) => number | 'not-found',
  otherIntentIds: ReadonlySet<SakiControlIntentId>,
  validateActorReference: (actor: ControlIntentActor) => void,
): ValidatedGitHubWorkItemState {
  const intents = [...intentTable.entries()].map(([key, value]) => {
    const record = githubWorkItemIntentRecordSchema.parse(value)
    if (record.id !== key) throw new Error('GitHub Work Item Intent id disagrees with its table key')
    if (otherIntentIds.has(key)) {
      throw new Error(`Saki Control Intent '${key}' is retained by multiple Intent kinds`)
    }
    validateActorReference(record.payload.actor)
    if (projectRevision(record.payload.intent.projectId) === 'not-found') {
      throw new Error('GitHub Work Item Intent targets a missing Development Project')
    }
    if (record.payload.intent.type === 'move-work-item') {
      if (record.target.kind !== 'move-work-item'
        || record.payload.intent.workItemId !== boardWorkItemId(record.target.repositoryId, record.target.issueId)) {
        throw new Error('GitHub Work Item move target disagrees with its Saki Work Item identity')
      }
    }
    return record
  })
  const recoveries = [...recoveryTable.entries()].map(([key, value]) => {
    const record = githubWorkItemRecoveryRecordSchema.parse(value)
    if (record.id !== key) throw new Error('GitHub Work Item recovery id disagrees with its table key')
    if (projectRevision(record.projectId) === 'not-found') {
      throw new Error('GitHub Work Item recovery targets a missing Development Project')
    }
    return record
  })
  const intentById = new Map(intents.map(record => [record.id, record] as const))
  const recoveryById = new Map(recoveries.map(record => [record.id, record] as const))
  const activeIntentWorkItems = new Map<SakiDevelopmentProjectId, Set<SakiBoardWorkItemId>>()
  for (const intent of intents) {
    if (terminalPhase(intent.phase)) continue
    const workItemId = intentWorkItemId(intent)
    if (workItemId === undefined) continue
    const projectId = intent.payload.intent.projectId
    const activeWorkItems = activeIntentWorkItems.get(projectId) ?? new Set<SakiBoardWorkItemId>()
    if (activeWorkItems.has(workItemId)) {
      throw new Error('multiple active GitHub Work Item Intents target one Work Item')
    }
    activeWorkItems.add(workItemId)
    activeIntentWorkItems.set(projectId, activeWorkItems)
  }
  for (const recovery of recoveries) {
    const sourceIntent = intentById.get(recovery.confirmed.sourceIntentId)
    if (sourceIntent === undefined
      || sourceIntent.payload.intent.projectId !== recovery.projectId
      || intentWorkItemId(sourceIntent) !== recovery.workItemId
      || !recoveryObservationMatchesSource(recovery, sourceIntent)) {
      throw new Error('GitHub Work Item recovery source Intent disagrees with its scoped Work Item')
    }
  }
  for (const intent of intents) {
    if (intent.payload.intent.type !== 'move-work-item') continue
    const hasPossibleTargetedEffect = intent.stages.some(stage => stage.effectPossible
      && (stage.kind === 'project-item-status-set'
        || stage.kind === 'project-item-position-set'
        || stage.kind === 'issue-state-set'))
    const recovery = recoveryById.get(githubWorkItemRecoveryId(
      intent.payload.intent.projectId,
      intent.payload.intent.workItemId,
    ))
    const terminalObservation = intent.terminalEvidence?.kind === 'succeeded'
      ? intent.terminalEvidence.confirmedObservation
      : intent.terminalEvidence?.kind === 'conflict'
        ? intent.terminalEvidence.confirmedObservation
        : undefined
    const terminalConfirmedAt = intent.terminalEvidence?.kind === 'succeeded'
      || intent.terminalEvidence?.kind === 'conflict'
      ? intent.terminalEvidence.confirmedAt
      : undefined
    if ((hasPossibleTargetedEffect || (terminalObservation !== undefined
      && boardObservationView(terminalObservation) !== undefined)) && recovery?.confirmed === undefined) {
      throw new Error('effect-bearing GitHub Work Item Intent has no targeted recovery observation')
    }
    if (hasPossibleTargetedEffect && !terminalPhase(intent.phase)
      && recovery?.confirmed.sourceIntentId !== intent.id) {
      throw new Error('active effect-bearing GitHub Work Item Intent does not own targeted recovery')
    }
    if (terminalObservation !== undefined && recovery?.confirmed.sourceIntentId === intent.id
      && !isDeepStrictEqual(recovery.confirmed.observation, terminalObservation)) {
      throw new Error('terminal GitHub Work Item evidence disagrees with targeted recovery')
    }
    if (terminalObservation !== undefined && recovery?.confirmed !== undefined
      && recovery.confirmed.sourceIntentId !== intent.id) {
      const successor = intentById.get(recovery.confirmed.sourceIntentId)
      if (terminalConfirmedAt === undefined || successor === undefined
        || successor.createdAt < terminalConfirmedAt) {
        throw new Error('terminal GitHub Work Item recovery was superseded by a non-successor Intent')
      }
    }
  }
  return {
    intents: intents.toSorted(compareIntentOrder),
  }
}

/** Owns durable staged CreateWorkItem and MoveWorkItem execution and recovery. */
export class GitHubWorkItemOperations {
  private readonly intentTails = new Map<SakiControlIntentId, Promise<void>>()
  private readonly projectTails = new Map<SakiDevelopmentProjectId, Promise<void>>()
  private readonly scanRequestedThrough = new Map<SakiDevelopmentProjectId, number>()
  private readonly active = new Set<Promise<void>>()
  private provider: SakiGitHub | undefined

  /** @param options - durable tables, trusted resolvers, and projection notifications. */
  constructor(private readonly options: GitHubWorkItemOperationsOptions) {}

  /**
   * Validate every durable record and owned cross-table relationship without effects.
   * @param otherIntentIds - ids already retained by other Control Intent kinds.
   * @returns detached Intents in deterministic recovery order.
   */
  validateDurableState(otherIntentIds: ReadonlySet<SakiControlIntentId>): ValidatedGitHubWorkItemState {
    return validateGitHubWorkItemOperationsDurableState(
      this.options.intentTable,
      this.options.recoveryTable,
      this.options.projectRevision,
      otherIntentIds,
      this.options.validateActorReference,
    )
  }

  /**
   * Resume retained non-terminal sagas after complete current-state validation.
   * @param state - records returned by {@link validateDurableState}.
   */
  async initializeValidated(state: ValidatedGitHubWorkItemState): Promise<void> {
    const scanProjects = new Map<SakiDevelopmentProjectId, number>()
    for (const intent of state.intents) {
      this.options.lifetime.throwIfAborted()
      if (terminalPhase(intent.phase)) {
        const confirmedAt = terminalObservationConfirmedAt(intent)
        if (confirmedAt !== undefined && !this.completeCheckpointCovers(intent, confirmedAt)) {
          const projectId = intent.payload.intent.projectId
          scanProjects.set(projectId, Math.max(scanProjects.get(projectId) ?? 0, confirmedAt))
        }
        continue
      }
      await this.enqueueIntent(intent.id, () => this.enqueueProject(
        intent.payload.intent.projectId,
        () => this.resume(intent.id, this.options.lifetime),
      ))
    }
    for (const [projectId, confirmedAt] of scanProjects) {
      await this.requestProjectScan(projectId, confirmedAt)
    }
  }

  /**
   * Attach the current optional GitHub provider and wake retained work.
   * @param provider - live provider instance.
   * @returns disposer that detaches only this provider instance.
   */
  attach(provider: SakiGitHub): () => void {
    this.provider = provider
    this.options.notifyChanged()
    const recovery = this.recoverPending()
    this.track(recovery)
    return () => {
      if (this.provider === provider) {
        this.provider = undefined
        this.options.notifyChanged()
      }
    }
  }

  /** Wait for contained notification-driven recovery attempts. */
  async dispose(): Promise<void> {
    await Promise.all([...this.active, ...this.intentTails.values(), ...this.projectTails.values()])
  }

  /**
   * Project provider/authority availability and durable saga overlays without
   * replacing the last complete synchronization checkpoint.
   * @param projectId - selected Development Project.
   * @param confirmedBoard - last complete synchronization generation, when available.
   * @param synchronizationAvailability - mapping and checkpoint availability from synchronization.
   * @param allowed - current request authority for both Work Item actions.
   * @param completeObservedAt - observation time of the latest complete Board checkpoint.
   * @returns effective availability and local overlays for the Board response.
   */
  project(
    projectId: SakiDevelopmentProjectId,
    confirmedBoard: SakiConfirmedBoardProjection | undefined,
    synchronizationAvailability: SakiBoardMutationAvailabilityProjection,
    allowed: WorkItemActionAvailability,
    completeObservedAt?: number,
  ): GitHubWorkItemOperationsProjection {
    const reasons = [
      ...synchronizationAvailability.reasons,
      ...(this.provider === undefined ? ['provider-unavailable' as const] : []),
      ...(!allowed['work-item:create'] || !allowed['work-item:move'] ? ['action-denied' as const] : []),
    ]
    const effectiveMutationAvailability = reasons.length === 0
      ? { available: true as const, reasons: [] as const }
      : { available: false as const, reasons: [...new Set(reasons)] }
    return {
      effectiveMutationAvailability,
      mutationOverlays: this.projectOverlays(projectId, confirmedBoard, completeObservedAt),
    }
  }

  private projectOverlays(
    projectId: SakiDevelopmentProjectId,
    confirmedBoard: SakiConfirmedBoardProjection | undefined,
    completeObservedAt: number | undefined,
  ): readonly SakiBoardMutationOverlayProjection[] {
    const context = this.options.mutationContext(projectId)
    const intents = [...this.options.intentTable.entries()]
      .map(([, value]) => githubWorkItemIntentRecordSchema.parse(value))
      .filter(record => record.payload.intent.projectId === projectId)
      .toSorted(compareIntentOrder)
    const intentOverlays = intents.flatMap((intent) => {
      const workItemId = intentWorkItemId(intent)
      const recovery = workItemId === undefined
        ? undefined
        : this.currentRecovery(projectId, workItemId, context)
      const observation = terminalObservation(intent)
      const latestNonTerminalStatus = recovery !== undefined
        && observation !== undefined
        && recovery.record.confirmed.sourceIntentId === intent.id
        && isDeepStrictEqual(recovery.record.confirmed.observation, observation)
        ? recovery.record.latestNonTerminalStatus
        : undefined
      return projectIntentOverlay(
        intent,
        confirmedBoard,
        completeObservedAt,
        context,
        latestNonTerminalStatus,
      ).map(overlay => ({ key: workItemId, overlay }))
    })
    const boardRepairs = confirmedBoard?.items.flatMap((item) => {
      const overlay = externalStateRepairOverlay(item)
      return overlay === undefined ? [] : [{ key: item.id, overlay }]
    }) ?? []
    const candidates = [...boardRepairs, ...intentOverlays]
    const latestByWorkItem = new Map<SakiBoardWorkItemId, number>()
    candidates.forEach((candidate, index) => {
      if (candidate.key !== undefined) latestByWorkItem.set(candidate.key, index)
    })
    return candidates.flatMap((candidate, index) => candidate.key === undefined
      || latestByWorkItem.get(candidate.key) === index
      ? [candidate.overlay]
      : [])
  }

  private currentRecovery(
    projectId: SakiDevelopmentProjectId,
    workItemId: SakiBoardWorkItemId,
    context: GitHubWorkItemMutationContextResult,
  ): { readonly record: GitHubWorkItemRecoveryRecord; readonly view: GitHubWorkItemBoardView } | undefined {
    if (!context.ok) return undefined
    const value = this.options.recoveryTable.get(githubWorkItemRecoveryId(projectId, workItemId))
    if (value === undefined) return undefined
    const record = githubWorkItemRecoveryRecordSchema.parse(value)
    const view = boardObservationView(record.confirmed.observation)
    const configuration = context.context.configuration
    return view !== undefined
      && view.observedAt >= context.context.checkpointObservedAt
      && view.facts.repositoryId === configuration.repositoryNodeId
      && view.facts.repositoryDatabaseId === configuration.repositoryDatabaseId
      && view.facts.projectId === configuration.projectNodeId
      && view.facts.statusFieldId === configuration.statusFieldNodeId
      ? { record, view }
      : undefined
  }

  private intentRecoveryView(intent: MoveWorkItemIntent): GitHubWorkItemBoardView | undefined {
    const value = this.options.recoveryTable.get(githubWorkItemRecoveryId(intent.projectId, intent.workItemId))
    if (value === undefined) return undefined
    const recovery = githubWorkItemRecoveryRecordSchema.parse(value)
    return recovery.confirmed.sourceIntentId === intent.intentId
      ? boardObservationView(recovery.confirmed.observation)
      : undefined
  }

  /**
   * Submit or replay one attributed Work Item Intent.
   * @param intent - strict browser-safe create or move request.
   * @param actor - server-derived current authority attribution.
   * @param signal - caller lifetime for this recovery attempt.
   * @returns stable terminal or recoverable receipt.
   */
  async submit<I extends SakiWorkItemIntent>(
    intent: I,
    actor: ControlIntentActor,
    signal: AbortSignal,
  ): Promise<SakiWorkItemIntentReceipt<I['type']>> {
    const parsed = (intent.type === 'create-work-item'
      ? createWorkItemIntentSchema.parse(intent)
      : moveWorkItemIntentSchema.parse(intent)) as I
    return await this.enqueueIntent(parsed.intentId, () => this.enqueueProject(parsed.projectId, async () => {
      signal.throwIfAborted()
      const existing = this.options.intentTable.get(parsed.intentId)
      if (existing !== undefined) {
        const record = githubWorkItemIntentRecordSchema.parse(existing)
        if (!isDeepStrictEqual(record.payload.intent, parsed)) return conflictWithoutReceipt()
        return await this.resume(record.id, signal)
      }
      if (parsed.type === 'move-work-item' && this.workItemBusy(parsed.projectId, parsed.workItemId)) {
        return conflictWithoutReceipt()
      }
      const action = parsed.type === 'create-work-item' ? 'work-item:create' : 'work-item:move'
      if (!this.options.authorityCurrent(actor, action)) return { ok: false, reason: 'denied' }
      const record = parsed.type === 'create-work-item'
        ? this.prepareCreate(parsed, actor)
        : this.prepareMove(parsed, actor)
      if (record === undefined) return { ok: false, reason: 'unavailable' }
      await this.putIntent(record)
      this.options.notifyChanged()
      return await this.resume(record.id, signal)
    }))
  }

  private workItemBusy(projectId: SakiDevelopmentProjectId, workItemId: SakiBoardWorkItemId): boolean {
    return [...this.options.intentTable.entries()].some(([, value]) => {
      const record = githubWorkItemIntentRecordSchema.parse(value)
      return record.payload.intent.projectId === projectId
        && !terminalPhase(record.phase)
        && intentWorkItemId(record) === workItemId
    })
  }

  private prepareCreate(
    intent: CreateWorkItemIntent,
    actor: ControlIntentActor,
  ): GitHubWorkItemIntentRecord | undefined {
    const contextResult = this.options.mutationContext(intent.projectId)
    if (!contextResult.ok) return undefined
    const { context } = contextResult
    const projectRevision = this.options.projectRevision(intent.projectId)
    if (projectRevision === 'not-found') return undefined
    const markerId = `work-item-marker-${randomBytes(32).toString('hex')}` as SakiWorkItemMarkerId
    const installation = {
      appId: context.configuration.appId,
      installationId: context.configuration.githubInstallationId,
      accountId: context.configuration.accountNodeId,
      privateKeyRef: context.configuration.credentialRef,
    }
    const target = {
      kind: 'create-work-item' as const,
      installation,
      repositoryId: context.configuration.repositoryNodeId,
      repositoryDatabaseId: context.configuration.repositoryDatabaseId,
      projectId: context.configuration.projectNodeId,
      statusFieldId: context.configuration.statusFieldNodeId,
      desiredStatusOptionId: context.configuration.statusOptionNodeIds.inbox,
      markerId,
    }
    const issueTarget = {
      kind: 'issue-create' as const,
      installation,
      repositoryId: target.repositoryId,
      repositoryDatabaseId: target.repositoryDatabaseId,
      markerId,
      titleDigest: canonicalDigest('saki/work-item-issue-title/v1', { title: intent.title }),
      bodyDigest: canonicalDigest('saki/work-item-issue-body/v1', { body: renderGitHubWorkItemIssueBody({
        intendedOutcome: intent.intendedOutcome,
        acceptanceCriteria: intent.acceptanceCriteria,
        markerId,
      }) }),
    }
    const now = Date.now()
    const payload = { intent, actor }
    const revisionsCurrent = intent.expected.projectRevision === projectRevision
      && intent.expected.synchronizationRevision === context.synchronizationRevision
      && intent.expected.mappingRevision === context.mappingRevision
    return githubWorkItemIntentRecordSchema.parse({
      id: intent.intentId,
      schemaVersion: 1,
      revision: 0,
      receiptId: receiptId(intent.intentId),
      payloadDigest: canonicalDigest('saki/github-work-item-intent/v1', payload),
      payload,
      target,
      phase: revisionsCurrent ? 'prepared' : 'conflict',
      stages: [{
        mutationId: githubWorkItemStageMutationId(intent.intentId, 'issue-create'),
        kind: 'issue-create',
        resolvedTarget: issueTarget,
        state: 'prepared',
        effectPossible: false,
      }, {
        mutationId: githubWorkItemStageMutationId(intent.intentId, 'project-item-add'),
        kind: 'project-item-add',
        state: 'prepared',
        effectPossible: false,
      }, {
        mutationId: githubWorkItemStageMutationId(intent.intentId, 'project-item-status-set'),
        kind: 'project-item-status-set',
        state: 'prepared',
        effectPossible: false,
      }],
      observedPrefix: [],
      ...(revisionsCurrent
        ? {}
        : { terminalEvidence: { kind: 'conflict', reason: 'expected-revision' } }),
      createdAt: now,
      updatedAt: now,
    })
  }

  private prepareMove(
    intent: MoveWorkItemIntent,
    actor: ControlIntentActor,
  ): GitHubWorkItemIntentRecord | undefined {
    const contextResult = this.options.mutationContext(intent.projectId)
    if (!contextResult.ok) return undefined
    const { context } = contextResult
    const item = context.confirmedBoard.items.find(candidate => candidate.id === intent.workItemId)
    if (item === undefined) return undefined
    const currentRecovery = this.currentRecovery(intent.projectId, intent.workItemId, contextResult)
    const recovery = currentRecovery?.record
    const recovered = currentRecovery?.view
    const recoveredMembership = recovered?.facts.membership.state === 'present'
      ? recovered.facts.membership.item
      : undefined
    const recoveredStatus = recovered === undefined ? undefined : observedStatus(recovered, contextResult)
    if (recovered !== undefined && recoveredStatus === undefined) return undefined
    const sourceProjectItemId = recovered === undefined ? item.source.projectItemId : recoveredMembership?.id
    const sourceMembership = recovered === undefined
      ? item.notInProject ? 'absent' as const : 'present' as const
      : recovered.facts.membership.state
    const sourceIssueState = recovered?.facts.issue.state ?? item.issueState
    const sourceStatus = recoveredStatus ?? item.status
    const sourceArchived = recoveredMembership?.archived ?? item.archived
    const unjoined = sourceMembership === 'absent' && sourceProjectItemId === undefined
    const joined = sourceMembership === 'present' && sourceProjectItemId !== undefined
    if (sourceArchived || (!unjoined && !joined)
      || (unjoined && (sourceIssueState !== 'open' || sourceStatus !== 'inbox'
        || intent.targetStatus === 'inbox'))) return undefined
    const sourceTerminal = terminalStatus(sourceStatus)
    const targetTerminal = terminalStatus(intent.targetStatus)
    if ((sourceIssueState === 'closed' && !sourceTerminal && !targetTerminal)
      || (sourceIssueState === 'open' && sourceTerminal && targetTerminal)) return undefined
    const restoreStatus = recovery?.latestNonTerminalStatus ?? item.latestNonTerminalStatus ?? 'backlog'
    if (sourceTerminal && !targetTerminal && intent.targetStatus !== restoreStatus) return undefined
    const desiredStatusOptionId = statusOptionId(context.configuration.statusOptionNodeIds, intent.targetStatus)
    const installation = {
      appId: context.configuration.appId,
      installationId: context.configuration.githubInstallationId,
      accountId: context.configuration.accountNodeId,
      privateKeyRef: context.configuration.credentialRef,
    }
    const target = {
      kind: 'move-work-item' as const,
      installation,
      repositoryId: context.configuration.repositoryNodeId,
      repositoryDatabaseId: context.configuration.repositoryDatabaseId,
      projectId: context.configuration.projectNodeId,
      issueId: item.source.issueId,
      ...(joined ? { projectItemId: sourceProjectItemId } : {}),
      source: joined
        ? {
          membership: 'present' as const,
          issueState: sourceIssueState,
          status: sourceStatus,
          projectItemId: sourceProjectItemId,
          archived: sourceArchived,
        }
        : {
          membership: 'absent' as const,
          issueState: 'open' as const,
          status: 'inbox' as const,
        },
      statusFieldId: context.configuration.statusFieldNodeId,
      desiredStatusOptionId,
      ...(resolveMovePosition(intent, context.confirmedBoard) ?? {}),
    }
    if (intent.position !== undefined && target.position === undefined) return undefined
    const desiredIssueState = targetTerminal ? 'closed' as const : 'open' as const
    const stageKinds: GitHubWorkItemMoveStageKind[] = []
    if (unjoined) stageKinds.push('project-item-add')
    if (sourceIssueState === 'closed' && desiredIssueState === 'open') stageKinds.push('issue-state-set')
    stageKinds.push('project-item-status-set')
    if (target.position !== undefined) stageKinds.push('project-item-position-set')
    if (sourceIssueState === 'open' && desiredIssueState === 'closed') stageKinds.push('issue-state-set')
    const now = Date.now()
    const payload = { intent, actor }
    const stages: GitHubWorkItemIntentRecord['stages'] = stageKinds.map((kind) => {
      const resolvedTarget = resolvedMoveStageTarget(target, kind, desiredIssueState)
      return {
        mutationId: githubWorkItemStageMutationId(intent.intentId, kind),
        kind,
        ...(resolvedTarget === undefined ? {} : {
          resolvedTarget,
        }),
        state: 'prepared',
        effectPossible: false,
      }
    })
    return githubWorkItemIntentRecordSchema.parse({
      id: intent.intentId,
      schemaVersion: 1,
      revision: 0,
      receiptId: receiptId(intent.intentId),
      payloadDigest: canonicalDigest('saki/github-work-item-intent/v1', payload),
      payload,
      target,
      phase: 'prepared',
      stages,
      observedPrefix: [],
      createdAt: now,
      updatedAt: now,
    })
  }

  private async resume(
    intentId: SakiControlIntentId,
    signal: AbortSignal,
  ): Promise<SakiWorkItemIntentReceipt<SakiWorkItemIntent['type']>> {
    signal.throwIfAborted()
    const record = this.requireIntent(intentId)
    if (terminalPhase(record.phase)) {
      const confirmedAt = terminalObservationConfirmedAt(record)
      if (confirmedAt !== undefined && !this.completeCheckpointCovers(record, confirmedAt)) {
        await this.requestProjectScan(record.payload.intent.projectId, confirmedAt)
      }
      return receiptFor(record)
    }
    if (partialFailureState(record)?.recoveryAction.kind === 'repair-mapping') {
      return receiptFor(record)
    }
    const action = record.payload.intent.type === 'create-work-item' ? 'work-item:create' : 'work-item:move'
    const authorityCurrent = this.options.authorityCurrent(record.payload.actor, action)
    if (!authorityCurrent && !record.stages.some(stage => stage.effectPossible)) {
      return await this.cancelForRevocation(record)
    }
    const provider = this.provider
    if (provider === undefined) return receiptFor(record)
    const stage = frontierStage(record)
    if (stage.kind === 'issue-create') {
      const request = issueCreateRequest(record, stage)
      if (record.phase === 'prepared' || !stage.effectPossible) {
        try {
          const inspected = await provider.inspectMutation<'issue-create'>(request, signal)
          return await this.acceptCreatePreInspection(record, request, inspected, provider, signal)
        } catch (error) {
          return await this.partialFailure(record, providerFailure(error))
        }
      }
      return await this.recoverCreateEffectPossible(record, request, provider, signal)
    }
    if (stage.kind === 'project-item-add') {
      const request = membershipRequest(record, stage)
      if (record.phase === 'prepared' || !stage.effectPossible) {
        try {
          const inspected = await provider.inspectMutation<'project-item-add'>(request, signal)
          return await this.acceptMembershipPreInspection(record, request, inspected, provider, signal)
        } catch (error) {
          return await this.partialFailure(record, providerFailure(error))
        }
      }
      return await this.recoverMembershipEffectPossible(record, request, provider, signal)
    }
    if (stage.kind === 'issue-state-set') {
      const request = issueStateRequest(record, stage)
      if (record.phase === 'prepared' || !stage.effectPossible) {
        try {
          const inspected = await provider.inspectMutation<'issue-state-set'>(request, signal)
          return await this.acceptIssueStatePreInspection(record, request, inspected, provider, signal)
        } catch (error) {
          return await this.partialFailure(record, providerFailure(error))
        }
      }
      return await this.recoverIssueStateEffectPossible(
        record,
        request,
        provider,
        signal,
        authorityCurrent,
      )
    }
    if (stage.kind === 'project-item-position-set') {
      const request = positionRequest(record, stage)
      if (record.phase === 'prepared' || !stage.effectPossible) {
        try {
          const inspected = await provider.inspectMutation<'project-item-position-set'>(request, signal)
          return await this.acceptPositionPreInspection(record, request, inspected, provider, signal)
        } catch (error) {
          return await this.partialFailure(record, providerFailure(error))
        }
      }
      return await this.recoverPositionEffectPossible(
        record,
        request,
        provider,
        signal,
        authorityCurrent,
      )
    }
    const request = statusRequest(record, stage)
    if (record.phase === 'prepared' || !stage.effectPossible) {
      try {
        const inspected = await provider.inspectMutation<'project-item-status-set'>(request, signal)
        return await this.acceptPreInspection(record, request, inspected, provider, signal)
      } catch (error) {
        return await this.partialFailure(record, providerFailure(error))
      }
    }
    return await this.recoverEffectPossible(record, request, provider, signal, authorityCurrent)
  }

  private async acceptCreatePreInspection(
    record: GitHubWorkItemIntentRecord,
    request: GitHubIssueCreateRequest,
    inspection: GitHubIssueCreateInspection,
    provider: SakiGitHub,
    signal: AbortSignal,
  ): Promise<SakiWorkItemIntentReceipt<SakiWorkItemIntent['type']>> {
    const outcome = inspection.snapshot.outcome
    if (outcome.state !== 'absent-complete') {
      if (outcome.state === 'incomplete') return receiptFor(record)
      return await this.reconciliationRequired(record, 'marker-ambiguous')
    }
    if (!this.options.authorityCurrent(record.payload.actor, 'work-item:create')) {
      return await this.cancelForRevocation(record)
    }
    if (!this.createTargetCurrent(record)) {
      return await this.conflictWithoutObservation(record, 'expected-revision')
    }
    const now = Math.max(Date.now(), inspection.observedAt)
    record = await this.markFrontierDispatching(record, now)
    if (!this.options.authorityCurrent(record.payload.actor, 'work-item:create')) {
      return await this.cancelForRevocation(record)
    }
    if (!this.createTargetCurrent(record)) {
      return await this.conflictWithoutObservation(record, 'expected-revision')
    }
    return await this.dispatchCreateAndConfirm(record, request, provider, signal)
  }

  private async recoverCreateEffectPossible(
    record: GitHubWorkItemIntentRecord,
    request: GitHubIssueCreateRequest,
    provider: SakiGitHub,
    signal: AbortSignal,
  ): Promise<SakiWorkItemIntentReceipt<SakiWorkItemIntent['type']>> {
    let inspection: GitHubIssueCreateInspection
    try {
      inspection = await provider.inspectMutation<'issue-create'>(request, signal)
    } catch (error) {
      return await this.partialFailure(record, providerFailure(error))
    }
    return await this.acceptCreatePossibleEffectInspection(record, request, inspection, signal)
  }

  private async dispatchCreateAndConfirm(
    record: GitHubWorkItemIntentRecord,
    request: GitHubIssueCreateRequest,
    provider: SakiGitHub,
    signal: AbortSignal,
  ): Promise<SakiWorkItemIntentReceipt<SakiWorkItemIntent['type']>> {
    let inspectionHint: GitHubIssueCreateRequest['inspectionHint']
    try {
      inspectionHint = await provider.dispatch<'issue-create'>(request, signal)
    } catch (error) {
      providerFailure(error)
      try {
        const inspection = await provider.inspectMutation<'issue-create'>(request, signal)
        return await this.acceptCreatePossibleEffectInspection(record, request, inspection, signal)
      } catch (inspectionError) {
        return await this.partialFailure(record, providerFailure(inspectionError))
      }
    }
    const inspectionRequest = issueCreateRequest(
      record,
      frontierStage(record),
      inspectionHint,
    )
    try {
      const inspection = await provider.inspectMutation<'issue-create'>(inspectionRequest, signal)
      return await this.acceptCreatePossibleEffectInspection(record, inspectionRequest, inspection, signal)
    } catch (error) {
      return await this.partialFailure(record, providerFailure(error))
    }
  }

  private async acceptCreatePossibleEffectInspection(
    record: GitHubWorkItemIntentRecord,
    request: GitHubIssueCreateRequest,
    inspection: GitHubIssueCreateInspection,
    signal: AbortSignal,
  ): Promise<SakiWorkItemIntentReceipt<SakiWorkItemIntent['type']>> {
    const outcome = inspection.snapshot.outcome
    if (outcome.state === 'unique-issue') {
      return await this.confirmCreate(record, issueCreateObservation(record, request, inspection), signal)
    }
    return await this.reconciliationRequired(record, createReconciliationReason(outcome.state))
  }

  private async confirmCreate(
    record: GitHubWorkItemIntentRecord,
    observation: GitHubWorkItemIssueCreateObservation,
    signal: AbortSignal,
  ): Promise<SakiWorkItemIntentReceipt<SakiWorkItemIntent['type']>> {
    const stageIndex = record.observedPrefix.length
    const stage = frontierStage(record)
    if (observation.issue.state !== 'open') {
      return await this.reconciliationRequired(record, 'evidence-conflict')
    }
    const now = Math.max(Date.now(), observation.observedAt)
    let stages = replaceStage(record, stageIndex, {
      ...stage,
      state: 'confirmed',
      effectPossible: true,
      failure: undefined,
    })
    const observedPrefix = [...record.observedPrefix, observation]
    stages = materializeKnownStageTargets({ ...record, stages, observedPrefix })
    record = await this.transition(record, {
      phase: 'prepared',
      stages,
      observedPrefix,
    }, now)
    this.options.notifyChanged()
    return await this.resume(record.id, signal)
  }

  private async acceptMembershipPreInspection(
    record: GitHubWorkItemIntentRecord,
    request: GitHubProjectItemAddRequest,
    inspection: GitHubProjectItemAddInspection,
    provider: SakiGitHub,
    signal: AbortSignal,
  ): Promise<SakiWorkItemIntentReceipt<SakiWorkItemIntent['type']>> {
    const observation = membershipObservation(request, inspection)
    const membership = observation.facts.membership
    if (membership.state === 'present') {
      if (observation.facts.issue.state !== 'open' || membership.item.archived) {
        return await this.conflict(record, observation, 'mapping-repair-required')
      }
      return await this.confirmMembership(record, observation, membership.item, false, signal)
    }
    if (membership.state === 'duplicate-conflict') {
      return await this.conflict(record, observation, 'mapping-repair-required')
    }
    if (!membershipAbsenceMatchesExpected(record, observation)) {
      return await this.conflict(record, observation, 'stale-remote')
    }
    if (!this.options.authorityCurrent(record.payload.actor, workItemAction(record))) {
      return await this.cancelForRevocation(record)
    }
    if (!this.workItemTargetCurrent(record)) {
      return await this.conflict(record, observation, 'mapping-repair-required')
    }
    const observedAt = Math.max(Date.now(), observation.observedAt)
    record = await this.markFrontierDispatching(record, observedAt)
    if (!this.options.authorityCurrent(record.payload.actor, workItemAction(record))) {
      return await this.cancelForRevocation(record)
    }
    if (!this.workItemTargetCurrent(record)) {
      return await this.conflict(record, observation, 'mapping-repair-required')
    }
    return await this.dispatchMembershipAndConfirm(record, request, provider, signal)
  }

  private async recoverMembershipEffectPossible(
    record: GitHubWorkItemIntentRecord,
    request: GitHubProjectItemAddRequest,
    provider: SakiGitHub,
    signal: AbortSignal,
  ): Promise<SakiWorkItemIntentReceipt<SakiWorkItemIntent['type']>> {
    let inspection: GitHubProjectItemAddInspection
    try {
      inspection = await provider.inspectMutation<'project-item-add'>(request, signal)
    } catch (error) {
      return await this.partialFailure(record, providerFailure(error))
    }
    return await this.acceptMembershipPossibleEffectInspection(
      record,
      request,
      inspection,
      'effect-unknown',
      signal,
    )
  }

  private async acceptMembershipPossibleEffectInspection(
    record: GitHubWorkItemIntentRecord,
    request: GitHubProjectItemAddRequest,
    inspection: GitHubProjectItemAddInspection,
    absenceReason: 'effect-unknown' | 'evidence-conflict',
    signal: AbortSignal,
  ): Promise<SakiWorkItemIntentReceipt<SakiWorkItemIntent['type']>> {
    const observation = membershipObservation(request, inspection)
    const membership = observation.facts.membership
    if (membership.state === 'present' && observation.facts.issue.state === 'open'
      && !membership.item.archived) {
      return await this.confirmMembership(record, observation, membership.item, true, signal)
    }
    if (membership.state === 'duplicate-conflict') {
      return await this.reconciliationRequired(record, 'evidence-conflict')
    }
    if (membership.state === 'present') {
      return await this.conflict(record, observation, 'mapping-repair-required')
    }
    return await this.reconciliationRequired(record, absenceReason)
  }

  private async dispatchMembershipAndConfirm(
    record: GitHubWorkItemIntentRecord,
    request: GitHubProjectItemAddRequest,
    provider: SakiGitHub,
    signal: AbortSignal,
  ): Promise<SakiWorkItemIntentReceipt<SakiWorkItemIntent['type']>> {
    try {
      await provider.dispatch<'project-item-add'>(request, signal)
    } catch (error) {
      providerFailure(error)
      try {
        const inspection = await provider.inspectMutation<'project-item-add'>(request, signal)
        return await this.acceptMembershipPossibleEffectInspection(
          record,
          request,
          inspection,
          'effect-unknown',
          signal,
        )
      } catch (inspectionError) {
        return await this.partialFailure(record, providerFailure(inspectionError))
      }
    }
    try {
      const inspection = await provider.inspectMutation<'project-item-add'>(request, signal)
      return await this.acceptMembershipPossibleEffectInspection(
        record,
        request,
        inspection,
        'evidence-conflict',
        signal,
      )
    } catch (error) {
      return await this.partialFailure(record, providerFailure(error))
    }
  }

  private async confirmMembership(
    record: GitHubWorkItemIntentRecord,
    observation: GitHubWorkItemMembershipObservation,
    item: GitHubWorkItemMembershipItem,
    effectPossible: boolean,
    signal: AbortSignal,
  ): Promise<SakiWorkItemIntentReceipt<SakiWorkItemIntent['type']>> {
    const stageIndex = record.observedPrefix.length
    const stage = frontierStage(record)
    const now = Math.max(Date.now(), observation.observedAt)
    const target = record.target.kind === 'move-work-item'
      ? { ...record.target, projectItemId: item.id }
      : record.target
    let stages = replaceStage(record, stageIndex, {
      ...stage,
      state: 'confirmed',
      effectPossible: effectPossible || stage.effectPossible,
      failure: undefined,
    })
    const observedPrefix = [...record.observedPrefix, observation]
    stages = materializeKnownStageTargets({ ...record, target, stages, observedPrefix })
    record = await this.transition(record, {
      target,
      phase: 'prepared',
      stages,
      observedPrefix,
    }, now)
    this.options.notifyChanged()
    return await this.resume(record.id, signal)
  }

  private async reconciliationRequired(
    record: GitHubWorkItemIntentRecord,
    reason: 'effect-unknown' | 'evidence-conflict' | 'marker-ambiguous',
  ): Promise<SakiWorkItemIntentReceipt<SakiWorkItemIntent['type']>> {
    const stage = frontierStage(record)
    record = await this.transition(record, {
      phase: 'reconciliation-required',
      terminalEvidence: { kind: 'reconciliation-required', reason, stageMutationId: stage.mutationId },
    })
    this.options.notifyChanged()
    return receiptFor(record)
  }

  private async acceptIssueStatePreInspection(
    record: GitHubWorkItemIntentRecord,
    request: GitHubIssueStateSetRequest,
    inspection: GitHubIssueStateSetInspection,
    provider: SakiGitHub,
    signal: AbortSignal,
  ): Promise<SakiWorkItemIntentReceipt<SakiWorkItemIntent['type']>> {
    const observation = issueStateObservation(request, inspection)
    if (issueStateIsDesired(request, inspection)) {
      return await this.confirmIssueState(record, observation, false, provider, signal)
    }
    if (!issueStateMatchesExpected(record, observation)) {
      return await this.conflict(record, observation, 'stale-remote')
    }
    return await this.admitIssueStateDispatch(record, request, provider, signal, true)
  }

  private async recoverIssueStateEffectPossible(
    record: GitHubWorkItemIntentRecord,
    request: GitHubIssueStateSetRequest,
    provider: SakiGitHub,
    signal: AbortSignal,
    authorityCurrent: boolean,
  ): Promise<SakiWorkItemIntentReceipt<SakiWorkItemIntent['type']>> {
    let inspection: GitHubIssueStateSetInspection
    try {
      inspection = await provider.inspectMutation<'issue-state-set'>(request, signal)
    } catch (error) {
      return await this.partialFailure(record, providerFailure(error))
    }
    const observation = issueStateObservation(request, inspection)
    if (issueStateIsDesired(request, inspection)) {
      try {
        return await this.confirmIssueState(record, observation, true, provider, signal)
      } catch (error) {
        return await this.partialFailure(record, providerFailure(error), observation)
      }
    }
    if (!issueStateMatchesExpected(record, observation)) {
      return await this.conflict(record, observation, 'stale-remote')
    }
    try {
      return await this.admitIssueStateDispatch(
        record,
        request,
        provider,
        signal,
        authorityCurrent,
      )
    } catch (error) {
      return await this.partialFailure(record, providerFailure(error), observation)
    }
  }

  private async admitIssueStateDispatch(
    record: GitHubWorkItemIntentRecord,
    request: GitHubIssueStateSetRequest,
    provider: SakiGitHub,
    signal: AbortSignal,
    authorityCurrent: boolean,
  ): Promise<SakiWorkItemIntentReceipt<SakiWorkItemIntent['type']>> {
    const board = await this.inspectBoardForIssueState(record, provider, signal)
    const boardView = boardObservationView(board.observation)
    if (boardView === undefined || !this.statusObservationMatchesExpected(record, boardView)) {
      return await this.conflict(record, board.observation, 'stale-remote')
    }
    if (!authorityCurrent || !this.options.authorityCurrent(record.payload.actor, 'work-item:move')) {
      await this.putRecovery(record, board.observation, Math.max(Date.now(), board.observation.observedAt))
      return await this.cancelForRevocation(record)
    }
    if (!this.moveTargetBindingCurrent(record)) {
      return await this.conflict(record, board.observation, 'mapping-repair-required')
    }
    const observedAt = Math.max(Date.now(), board.observation.observedAt)
    await this.putRecovery(record, board.observation, observedAt)
    record = await this.markFrontierDispatching(record, observedAt)
    if (!this.options.authorityCurrent(record.payload.actor, 'work-item:move')) {
      return await this.cancelForRevocation(record)
    }
    if (!this.moveTargetBindingCurrent(record)) {
      return await this.conflict(record, board.observation, 'mapping-repair-required')
    }
    return await this.dispatchIssueStateAndConfirm(record, request, provider, signal)
  }

  private async dispatchIssueStateAndConfirm(
    record: GitHubWorkItemIntentRecord,
    request: GitHubIssueStateSetRequest,
    provider: SakiGitHub,
    signal: AbortSignal,
  ): Promise<SakiWorkItemIntentReceipt<SakiWorkItemIntent['type']>> {
    try {
      await provider.dispatch<'issue-state-set'>(request, signal)
    } catch (error) {
      const dispatchFailure = providerFailure(error)
      try {
        const inspection = await provider.inspectMutation<'issue-state-set'>(request, signal)
        const observation = issueStateObservation(request, inspection)
        if (issueStateIsDesired(request, inspection)) {
          return await this.confirmIssueState(record, observation, true, provider, signal)
        }
        return await this.partialFailure(record, dispatchFailure, observation)
      } catch (inspectionError) {
        /* v8 ignore next -- A dispatch-plus-inspection outage has the same effect-possible
         * recovery as the exercised replay and sibling mutation paths. */
        return await this.partialFailure(record, providerFailure(inspectionError))
      }
    }
    try {
      const inspection = await provider.inspectMutation<'issue-state-set'>(request, signal)
      const observation = issueStateObservation(request, inspection)
      if (issueStateIsDesired(request, inspection)) {
        return await this.confirmIssueState(record, observation, true, provider, signal)
      }
      const board = await this.inspectBoardForIssueState(record, provider, signal)
      return await this.conflict(record, board.observation, 'stale-remote')
    } catch (error) {
      return await this.partialFailure(record, providerFailure(error))
    }
  }

  private async confirmIssueState(
    record: GitHubWorkItemIntentRecord,
    observation: GitHubWorkItemIssueStateObservation,
    effectPossible: boolean,
    provider: SakiGitHub,
    signal: AbortSignal,
  ): Promise<SakiWorkItemIntentReceipt<SakiWorkItemIntent['type']>> {
    const stageIndex = record.observedPrefix.length
    const board = await this.inspectBoardForIssueState(record, provider, signal)
    if (!this.fullBoardConfirmsIssueStateOutcome(record, board.observation, stageIndex)) {
      return await this.conflict(record, board.observation, 'stale-remote')
    }
    if (!this.moveTargetBindingCurrent(record)) {
      return await this.conflict(record, board.observation, 'mapping-repair-required')
    }
    const now = Math.max(Date.now(), observation.observedAt, board.observation.observedAt)
    await this.putRecovery(record, board.observation, now)
    return await this.completeConfirmedStage(
      record,
      observation,
      board.observation,
      effectPossible,
      now,
      signal,
    )
  }

  private async inspectBoardForIssueState(
    record: GitHubWorkItemIntentRecord,
    provider: SakiGitHub,
    signal: AbortSignal,
  ): Promise<{ readonly observation: GitHubWorkItemBoardObservation }> {
    const confirmedPosition = record.observedPrefix.find(
      observation => observation.stageKind === 'project-item-position-set',
    )
    if (confirmedPosition?.stageKind === 'project-item-position-set') {
      const stage = stageByKind(record, 'project-item-position-set')
      const request = positionRequest(record, stage)
      const inspection = await provider.inspectMutation<'project-item-position-set'>(request, signal)
      return { observation: positionObservation(request, inspection) }
    }
    const stage = stageByKind(record, 'project-item-status-set')
    const request = statusRequest(record, stage)
    const inspection = await provider.inspectMutation<'project-item-status-set'>(request, signal)
    return { observation: targetedObservation(request, inspection) }
  }

  private fullBoardConfirmsIssueStateOutcome(
    record: GitHubWorkItemIntentRecord,
    observation: GitHubWorkItemBoardObservation,
    issueStateStageIndex: number,
  ): boolean {
    const intent = record.payload.intent
    const target = record.target
    /* v8 ignore next -- Parsed Issue-state frontiers belong to a Move record with a materialized Project item. */
    if (intent.type !== 'move-work-item' || target.kind !== 'move-work-item'
      || target.projectItemId === undefined) return false
    const stage = record.stages[issueStateStageIndex]
    const stateTarget = stage?.resolvedTarget
    const statusStageIndex = record.stages.findIndex(candidate => candidate.kind === 'project-item-status-set')
    /* v8 ignore next -- Parsed Move topology always contains Status and correlates this Issue-state target. */
    if (stateTarget?.kind !== 'issue-state-set' || statusStageIndex < 0) return false
    const expectedStatus = statusStageIndex < issueStateStageIndex
      ? intent.targetStatus
      : target.source.status
    const context = this.options.mutationContext(intent.projectId)
    if (!context.ok) return false
    const view = completeBoardObservationView(observation)
    const facts = view.facts
    if (facts.membership.state !== 'present') return false
    const membership = facts.membership.item
    if (facts.issue.state !== stateTarget.desiredState
      || membership.id !== target.projectItemId
      || membership.archived
      || membership.statusOptionId !== statusOptionId(
        context.context.configuration.statusOptionNodeIds,
        expectedStatus,
      )) return false
    const before = this.intentRecoveryView(intent)
    if (before === undefined) return true
    return facts.issue.updatedAt >= before.facts.issue.updatedAt
      && isDeepStrictEqual(facts, {
        ...before.facts,
        issue: {
          ...before.facts.issue,
          state: stateTarget.desiredState,
          updatedAt: facts.issue.updatedAt,
        },
      })
  }

  private moveTargetBindingCurrent(
    record: GitHubWorkItemIntentRecord,
    context?: GitHubWorkItemMutationContext,
  ): boolean {
    const intent = record.payload.intent
    const target = record.target
    /* v8 ignore next -- Parsed callers select this helper only for a Move record and its correlated target. */
    if (intent.type !== 'move-work-item' || target.kind !== 'move-work-item') return false
    if (context === undefined) {
      const resolved = this.options.mutationContext(intent.projectId)
      if (!resolved.ok) return false
      context = resolved.context
    }
    const { configuration, confirmedBoard } = context
    const item = confirmedBoard.items.find(candidate => candidate.id === intent.workItemId)
    return item !== undefined
      && item.source.issueId === target.issueId
      && targetConfigurationMatches(target, configuration, statusOptionId(
        configuration.statusOptionNodeIds,
        intent.targetStatus,
      ))
  }

  private async acceptPositionPreInspection(
    record: GitHubWorkItemIntentRecord,
    request: GitHubProjectItemPositionSetRequest,
    inspection: GitHubProjectItemPositionSetInspection,
    provider: SakiGitHub,
    signal: AbortSignal,
  ): Promise<SakiWorkItemIntentReceipt<SakiWorkItemIntent['type']>> {
    const observation = positionObservation(request, inspection)
    const outcome = this.positionOutcome(record, request, observation)
    if (outcome === 'desired') return await this.confirm(record, observation, false, signal)
    if (outcome !== 'expected') return await this.conflict(record, observation, outcome)
    if (!this.options.authorityCurrent(record.payload.actor, 'work-item:move')) {
      return await this.cancelForRevocation(record)
    }
    if (!this.positionTargetCurrent(record)) {
      return await this.conflict(record, observation, 'mapping-repair-required')
    }
    const observedAt = Math.max(Date.now(), observation.observedAt)
    await this.putRecovery(record, observation, observedAt)
    record = await this.markFrontierDispatching(record, observedAt)
    if (!this.options.authorityCurrent(record.payload.actor, 'work-item:move')) {
      return await this.cancelForRevocation(record)
    }
    if (!this.positionTargetCurrent(record)) {
      return await this.conflict(record, observation, 'mapping-repair-required')
    }
    return await this.dispatchPositionAndConfirm(record, request, provider, signal)
  }

  private async recoverPositionEffectPossible(
    record: GitHubWorkItemIntentRecord,
    request: GitHubProjectItemPositionSetRequest,
    provider: SakiGitHub,
    signal: AbortSignal,
    authorityCurrent: boolean,
  ): Promise<SakiWorkItemIntentReceipt<SakiWorkItemIntent['type']>> {
    let inspection: GitHubProjectItemPositionSetInspection
    try {
      inspection = await provider.inspectMutation<'project-item-position-set'>(request, signal)
    } catch (error) {
      return await this.partialFailure(record, providerFailure(error))
    }
    const observation = positionObservation(request, inspection)
    const outcome = this.positionOutcome(record, request, observation)
    if (outcome === 'desired') return await this.confirm(record, observation, true, signal)
    if (outcome !== 'expected') return await this.conflict(record, observation, outcome)
    if (!authorityCurrent || !this.options.authorityCurrent(record.payload.actor, 'work-item:move')) {
      await this.putRecovery(record, observation, Math.max(Date.now(), observation.observedAt))
      return await this.cancelForRevocation(record)
    }
    /* v8 ignore next -- Position admission already represents this pre-persistence target recheck. */
    if (!this.positionTargetCurrent(record)) {
      return await this.conflict(record, observation, 'mapping-repair-required')
    }
    /* jscpd:ignore-start -- Position recovery rechecks its own authority and target after persisting effectPossible. */
    record = await this.markFrontierDispatching(record)
    /* v8 ignore next -- Status recovery represents the identical post-persistence authority revocation. */
    if (!this.options.authorityCurrent(record.payload.actor, 'work-item:move')) {
      return await this.cancelForRevocation(record)
    }
    if (!this.positionTargetCurrent(record)) {
      return await this.conflict(record, observation, 'mapping-repair-required')
    }
    return await this.dispatchPositionAndConfirm(record, request, provider, signal)
    /* jscpd:ignore-end */
  }

  private async dispatchPositionAndConfirm(
    record: GitHubWorkItemIntentRecord,
    request: GitHubProjectItemPositionSetRequest,
    provider: SakiGitHub,
    signal: AbortSignal,
  ): Promise<SakiWorkItemIntentReceipt<SakiWorkItemIntent['type']>> {
    try {
      await provider.dispatch<'project-item-position-set'>(request, signal)
    } catch (error) {
      const dispatchFailure = providerFailure(error)
      try {
        const inspection = await provider.inspectMutation<'project-item-position-set'>(request, signal)
        const observation = positionObservation(request, inspection)
        const outcome = this.positionOutcome(record, request, observation)
        if (outcome === 'desired') return await this.confirm(record, observation, true, signal)
        if (outcome !== 'expected') return await this.conflict(record, observation, outcome)
        return await this.partialFailure(record, dispatchFailure, observation)
      } catch (inspectionError) {
        return await this.partialFailure(record, providerFailure(inspectionError))
      }
    }
    try {
      const inspection = await provider.inspectMutation<'project-item-position-set'>(request, signal)
      const observation = positionObservation(request, inspection)
      const outcome = this.positionOutcome(record, request, observation)
      if (outcome === 'desired') return await this.confirm(record, observation, true, signal)
      return await this.conflict(record, observation, outcome === 'expected' ? 'stale-remote' : outcome)
    } catch (error) {
      return await this.partialFailure(record, providerFailure(error))
    }
  }

  private positionOutcome(
    record: GitHubWorkItemIntentRecord,
    request: GitHubProjectItemPositionSetRequest,
    observation: GitHubWorkItemPositionObservation,
  ): 'desired' | 'expected' | 'stale-remote' | 'mapping-repair-required' {
    const target = record.target
    const intent = record.payload.intent
    const snapshot = observation.facts
    const view = boardObservationView(observation)
    const item = view?.facts.membership.state === 'present' ? view.facts.membership.item : undefined
    /* v8 ignore next -- Parsed position frontiers carry their correlated Move target and materialized position. */
    if (intent.type !== 'move-work-item' || target.kind !== 'move-work-item'
      || target.projectItemId === undefined || target.position === undefined) {
      return 'mapping-repair-required'
    }
    if (view === undefined || item?.id !== request.projectItemId || item.archived) {
      return 'mapping-repair-required'
    }
    if (snapshot.issue.state !== 'open' || item.statusOptionId !== target.desiredStatusOptionId) {
      return 'stale-remote'
    }
    const position = target.position
    let anchorMatchesExpected = false
    if (position.kind === 'after') {
      if (snapshot.after.state !== 'present'
        || snapshot.after.item.id !== position.projectItemId
        || snapshot.after.item.archived
        || snapshot.after.item.statusOptionId !== target.desiredStatusOptionId
        || snapshot.after.item.issue.state !== 'open') {
        return 'stale-remote'
      }
      const anchor = positionAnchorView(snapshot, snapshot.after, target.desiredStatusOptionId)
      /* v8 ignore next -- The anchor fingerprint binds the expected Work Item identity. */
      if (anchor.workItemId !== position.workItemId) return 'stale-remote'
      anchorMatchesExpected = anchor.remoteFingerprint === position.expectedRemoteFingerprint
    }
    if (positionIsDesired(request, snapshot, item)) return 'desired'
    const recovered = this.intentRecoveryView(intent)
    if (recovered === undefined || view.remoteFingerprint !== recovered.remoteFingerprint) {
      return 'stale-remote'
    }
    if (position.kind === 'top') return 'expected'
    /* v8 ignore next -- All predecessor fingerprint mismatches share the stale outcome above. */
    if (!anchorMatchesExpected) return 'stale-remote'
    return 'expected'
  }

  private positionTargetCurrent(record: GitHubWorkItemIntentRecord): boolean {
    const intent = record.payload.intent
    const target = record.target
    /* v8 ignore next -- Parsed position frontiers carry their correlated Move target and materialized position. */
    if (intent.type !== 'move-work-item' || target.kind !== 'move-work-item'
      || target.projectItemId === undefined || target.position === undefined) return false
    const context = this.options.mutationContext(intent.projectId)
    if (!context.ok || !this.moveTargetBindingCurrent(record, context.context)) return false
    const recovered = this.intentRecoveryView(intent)
    /* v8 ignore next -- A materialized Position frontier has validated present recovery membership. */
    if (recovered === undefined || recovered.facts.membership.state !== 'present') return false
    const membership = recovered.facts.membership.item
    /* v8 ignore next -- Position recovery validates these durable target fields before materializing the frontier. */
    if (membership.id !== target.projectItemId || membership.archived
      || recovered.facts.issue.state !== 'open'
      || membership.statusOptionId !== target.desiredStatusOptionId) return false
    const position = target.position
    if (position.kind === 'top') return true
    const predecessor = context.context.confirmedBoard.items.find(
      item => item.id === position.workItemId,
    )
    return predecessor !== undefined
      && predecessor.source.projectItemId === position.projectItemId
      && predecessor.remoteFingerprint === position.expectedRemoteFingerprint
      && predecessor.status === intent.targetStatus
      && !predecessor.notInProject
      && !predecessor.archived
  }

  private async acceptPreInspection(
    record: GitHubWorkItemIntentRecord,
    request: GitHubProjectItemStatusSetRequest,
    inspection: GitHubProjectItemStatusSetInspection,
    provider: SakiGitHub,
    signal: AbortSignal,
  ): Promise<SakiWorkItemIntentReceipt<SakiWorkItemIntent['type']>> {
    const observation = targetedObservation(request, inspection)
    if (statusIsDesired(record, request, inspection)) {
      return await this.confirm(record, observation, false, signal)
    }
    /* jscpd:ignore-start -- Status admission keeps its own state proof and pre/post-persistence rechecks adjacent to dispatch. */
    if (!this.statusObservationMatchesExpected(record, observation)) {
      return await this.conflict(record, observation, 'stale-remote')
    }
    if (!this.options.authorityCurrent(record.payload.actor, workItemAction(record))) {
      return await this.cancelForRevocation(record)
    }
    if (!this.workItemTargetCurrent(record)) {
      return await this.conflict(record, observation, 'mapping-repair-required')
    }
    const observedAt = Math.max(Date.now(), observation.observedAt)
    await this.putRecovery(record, observation, observedAt)
    record = await this.markFrontierDispatching(record, observedAt)
    if (!this.options.authorityCurrent(record.payload.actor, workItemAction(record))) {
      return await this.cancelForRevocation(record)
    }
    if (!this.workItemTargetCurrent(record)) {
      return await this.conflict(record, observation, 'mapping-repair-required')
    }
    return await this.dispatchAndConfirm(record, request, provider, signal)
    /* jscpd:ignore-end */
  }

  private async recoverEffectPossible(
    record: GitHubWorkItemIntentRecord,
    request: GitHubProjectItemStatusSetRequest,
    provider: SakiGitHub,
    signal: AbortSignal,
    authorityCurrent: boolean,
  ): Promise<SakiWorkItemIntentReceipt<SakiWorkItemIntent['type']>> {
    let inspection: GitHubProjectItemStatusSetInspection
    try {
      inspection = await provider.inspectMutation<'project-item-status-set'>(request, signal)
    } catch (error) {
      return await this.partialFailure(record, providerFailure(error))
    }
    const observation = targetedObservation(request, inspection)
    if (statusIsDesired(record, request, inspection)) {
      return await this.confirm(record, observation, true, signal)
    }
    if (!this.statusObservationMatchesExpected(record, observation)) {
      return await this.conflict(record, observation, 'stale-remote')
    }
    if (!authorityCurrent || !this.options.authorityCurrent(record.payload.actor, workItemAction(record))) {
      await this.putRecovery(record, observation, Math.max(Date.now(), observation.observedAt))
      return await this.cancelForRevocation(record)
    }
    if (!this.workItemTargetCurrent(record)) {
      return await this.conflict(record, observation, 'mapping-repair-required')
    }
    /* jscpd:ignore-start -- Status recovery rechecks its own authority and target after persisting effectPossible. */
    record = await this.markFrontierDispatching(record)
    if (!this.options.authorityCurrent(record.payload.actor, workItemAction(record))) {
      return await this.cancelForRevocation(record)
    }
    /* v8 ignore next -- Position recovery represents the identical post-persistence target recheck. */
    if (!this.workItemTargetCurrent(record)) {
      return await this.conflict(record, observation, 'mapping-repair-required')
    }
    return await this.dispatchAndConfirm(record, request, provider, signal)
    /* jscpd:ignore-end */
  }

  private workItemTargetCurrent(record: GitHubWorkItemIntentRecord): boolean {
    return record.payload.intent.type === 'create-work-item'
      ? this.createTargetCurrent(record)
      : this.moveTargetCurrent(record)
  }

  private createTargetCurrent(record: GitHubWorkItemIntentRecord): boolean {
    const intent = record.payload.intent
    const target = record.target
    /* v8 ignore next -- Parsed Create records select this method and carry a schema-correlated Create target. */
    if (intent.type !== 'create-work-item' || target.kind !== 'create-work-item') return false
    const resolved = this.options.mutationContext(intent.projectId)
    /* v8 ignore next -- Create admission already represents unavailable mutation context at this target check. */
    if (!resolved.ok) return false
    const { configuration } = resolved.context
    return this.options.projectRevision(intent.projectId) === intent.expected.projectRevision
      && resolved.context.synchronizationRevision === intent.expected.synchronizationRevision
      && resolved.context.mappingRevision === intent.expected.mappingRevision
      && targetConfigurationMatches(target, configuration, configuration.statusOptionNodeIds.inbox)
  }

  private moveTargetCurrent(record: GitHubWorkItemIntentRecord): boolean {
    const intent = record.payload.intent
    /* v8 ignore next -- Parsed Move records select this method and carry a schema-correlated Move target. */
    if (intent.type !== 'move-work-item' || record.target.kind !== 'move-work-item') return false
    const resolved = this.options.mutationContext(intent.projectId)
    if (!resolved.ok) return false
    const { configuration, confirmedBoard } = resolved.context
    const item = confirmedBoard.items.find(candidate => candidate.id === intent.workItemId)
    /* v8 ignore next -- Move admission already validates the same Work Item-to-Issue binding. */
    if (item === undefined || item.source.issueId !== record.target.issueId) return false
    const target = record.target
    if (!targetConfigurationMatches(
      target,
      configuration,
      statusOptionId(configuration.statusOptionNodeIds, intent.targetStatus),
    )) return false
    const stage = record.stages[record.observedPrefix.length]
    if (stage?.kind === 'project-item-add') {
      return target.source.membership === 'absent'
        && target.projectItemId === undefined
        && item.notInProject
        && item.source.projectItemId === undefined
        && item.issueState === 'open'
        && item.status === 'inbox'
        && !item.archived
        && item.remoteFingerprint === intent.expectedRemoteFingerprint
    }
    /* v8 ignore next -- A non-membership Move frontier is its parsed, materialized Status stage. */
    if (stage?.kind !== 'project-item-status-set' || target.projectItemId === undefined) return false
    const currentRecovery = this.currentRecovery(intent.projectId, intent.workItemId, resolved)
    const recovery = currentRecovery?.record
    const recovered = currentRecovery?.view
    const recoveredMembership = recovered?.facts.membership.state === 'present'
      ? recovered.facts.membership.item
      : undefined
    const currentIssueId = recovered?.facts.issue.id ?? item.source.issueId
    const currentProjectItemId = recovered === undefined
      ? item.source.projectItemId
      : recoveredMembership?.id
    if (target.source.membership === 'absent' && recovered === undefined) {
      const membershipObservation = record.observedPrefix.find(
        observation => observation.stageKind === 'project-item-add',
      ) as GitHubWorkItemMembershipObservation
      const membership = membershipObservation.facts.membership
      /* v8 ignore next -- A parsed unjoined Move Status frontier follows confirmed, present membership evidence. */
      if (membership.state !== 'present') return false
      return membership.item.id === target.projectItemId
        && !membership.item.archived
        && membershipObservation.facts.issue.state === 'open'
    }
    const currentRemoteFingerprint = recovered?.remoteFingerprint ?? item.remoteFingerprint
    /* v8 ignore next -- These durable target invalidations share the represented mapping-repair outcome. */
    if ((target.source.membership === 'present'
      && recovery?.confirmed.sourceIntentId !== record.id
      && currentRemoteFingerprint !== intent.expectedRemoteFingerprint)
      || (recovered?.facts.issue.state ?? item.issueState) === 'closed'
      || recoveredMembership?.archived === true
      || currentProjectItemId === undefined) return false
    return target.issueId === currentIssueId
      && target.projectItemId === currentProjectItemId
  }

  private statusObservationMatchesExpected(
    record: GitHubWorkItemIntentRecord,
    observation: GitHubWorkItemBoardView,
  ): boolean {
    const intent = record.payload.intent
    if (intent.type === 'create-work-item' && record.target.kind === 'create-work-item') {
      const membershipObservation = record.observedPrefix.find(
        candidate => candidate.stageKind === 'project-item-add',
      ) as GitHubWorkItemMembershipObservation
      const membership = membershipObservation.facts.membership
      const observedMembership = observation.facts.membership
      /* v8 ignore next -- A parsed Create Status frontier follows one confirmed, present membership observation. */
      if (membership.state !== 'present') return false
      return observation.facts.issue.state === 'open'
        && observedMembership.state === 'present'
        && observedMembership.item.id === membership.item.id
        && !observedMembership.item.archived
    }
    /* v8 ignore next -- The remaining parsed Status frontier belongs to its correlated Move record. */
    if (intent.type !== 'move-work-item' || record.target.kind !== 'move-work-item') return false
    const recovered = this.intentRecoveryView(intent)
    if (recovered !== undefined) return observation.remoteFingerprint === recovered.remoteFingerprint
    if (record.target.source.membership === 'present') {
      return observation.remoteFingerprint === intent.expectedRemoteFingerprint
    }
    const target = record.target
    const observedMembership = observation.facts.membership
    return observedMembership.state === 'present'
      && observation.facts.issue.state === 'open'
      && observedMembership.item.id === target.projectItemId
      && !observedMembership.item.archived
  }

  private completeCheckpointCovers(record: GitHubWorkItemIntentRecord, confirmedAt: number): boolean {
    const context = this.options.mutationContext(record.payload.intent.projectId)
    if (!context.ok || context.context.checkpointObservedAt < confirmedAt) return false
    if (context.context.checkpointObservedAt > confirmedAt) return true
    const observation = terminalObservation(record)
    /* v8 ignore next -- A terminal observation timestamp exists only when the terminal evidence carries an observation. */
    if (observation === undefined) return false
    const view = boardObservationView(observation)
    return view !== undefined
      && context.context.confirmedBoard.items.some(item => (
        item.id === view.workItemId && item.remoteFingerprint === view.remoteFingerprint
      ))
  }

  private async cancelForRevocation(
    record: GitHubWorkItemIntentRecord,
  ): Promise<SakiWorkItemIntentReceipt<SakiWorkItemIntent['type']>> {
    const canceled = await this.transition(record, {
      phase: 'canceled',
      terminalEvidence: { kind: 'canceled', reason: 'authority-revoked' },
    })
    this.options.notifyChanged()
    return receiptFor(canceled)
  }

  private async dispatchAndConfirm(
    record: GitHubWorkItemIntentRecord,
    request: GitHubProjectItemStatusSetRequest,
    provider: SakiGitHub,
    signal: AbortSignal,
  ): Promise<SakiWorkItemIntentReceipt<SakiWorkItemIntent['type']>> {
    try {
      await provider.dispatch<'project-item-status-set'>(request, signal)
    } catch (error) {
      const dispatchFailure = providerFailure(error)
      let knownObservation: GitHubWorkItemTargetedObservation | undefined
      try {
        const inspection = await provider.inspectMutation<'project-item-status-set'>(request, signal)
        const observation = targetedObservation(request, inspection)
        knownObservation = observation
        if (statusIsDesired(record, request, inspection)) {
          return await this.confirm(record, observation, true, signal)
        }
        const intent = record.payload.intent
        if (intent.type === 'move-work-item'
          && !this.statusObservationMatchesExpected(record, observation)) {
          return await this.conflict(record, observation, 'stale-remote')
        }
      } catch (inspectionError) {
        providerFailure(inspectionError)
      }
      return await this.partialFailure(record, dispatchFailure, knownObservation)
    }
    try {
      const inspection = await provider.inspectMutation<'project-item-status-set'>(request, signal)
      const observation = targetedObservation(request, inspection)
      if (statusIsDesired(record, request, inspection)) {
        return await this.confirm(record, observation, true, signal)
      }
      return await this.conflict(record, observation, 'stale-remote')
    } catch (error) {
      return await this.partialFailure(record, providerFailure(error))
    }
  }

  private async confirm(
    record: GitHubWorkItemIntentRecord,
    observation: GitHubWorkItemBoardObservation,
    effectPossible: boolean,
    signal: AbortSignal,
  ): Promise<SakiWorkItemIntentReceipt<SakiWorkItemIntent['type']>> {
    const now = Math.max(Date.now(), observation.observedAt)
    const intent = record.payload.intent
    await this.putRecovery(
      record,
      observation,
      now,
      intent.type === 'move-work-item' && !terminalStatus(intent.targetStatus) ? intent.targetStatus : undefined,
    )
    return await this.completeConfirmedStage(record, observation, observation, effectPossible, now, signal)
  }

  private async completeConfirmedStage(
    record: GitHubWorkItemIntentRecord,
    observation: GitHubWorkItemObservation,
    terminalObservation: GitHubWorkItemBoardObservation,
    effectPossible: boolean,
    now: number,
    signal: AbortSignal,
  ): Promise<SakiWorkItemIntentReceipt<SakiWorkItemIntent['type']>> {
    const stageIndex = record.observedPrefix.length
    const stage = frontierStage(record)
    let stages = replaceStage(record, stageIndex, {
      ...stage,
      state: 'confirmed',
      effectPossible: effectPossible || stage.effectPossible,
      failure: undefined,
    })
    const observedPrefix = [...record.observedPrefix, observation]
    if (observedPrefix.length < stages.length) {
      stages = materializeKnownStageTargets({ ...record, stages, observedPrefix })
      record = await this.transition(record, {
        phase: 'prepared',
        stages,
        observedPrefix,
      }, now)
      this.options.notifyChanged()
      return await this.resume(record.id, signal)
    }
    record = await this.transition(record, {
      phase: 'succeeded',
      stages,
      observedPrefix,
      terminalEvidence: { kind: 'succeeded', confirmedObservation: terminalObservation, confirmedAt: now },
    }, now)
    await this.requestProjectScan(record.payload.intent.projectId, now)
    this.options.notifyChanged()
    return receiptFor(record)
  }

  private async conflict(
    record: GitHubWorkItemIntentRecord,
    observation: GitHubWorkItemObservation,
    reason: 'stale-remote' | 'mapping-repair-required',
  ): Promise<SakiWorkItemIntentReceipt<SakiWorkItemIntent['type']>> {
    const now = Math.max(Date.now(), observation.observedAt)
    if (isBoardObservation(observation) && boardObservationView(observation) !== undefined) {
      await this.putRecovery(record, observation, now)
    }
    record = await this.transition(record, {
      phase: 'conflict',
      terminalEvidence: { kind: 'conflict', reason, confirmedObservation: observation, confirmedAt: now },
    }, now)
    await this.requestProjectScan(record.payload.intent.projectId, now)
    this.options.notifyChanged()
    return receiptFor(record)
  }

  private async conflictWithoutObservation(
    record: GitHubWorkItemIntentRecord,
    reason: 'expected-revision',
  ): Promise<SakiWorkItemIntentReceipt<SakiWorkItemIntent['type']>> {
    record = await this.transition(record, {
      phase: 'conflict',
      terminalEvidence: { kind: 'conflict', reason },
    })
    this.options.notifyChanged()
    return receiptFor(record)
  }

  private async partialFailure(
    record: GitHubWorkItemIntentRecord,
    failure: GitHubFailure,
    knownObservation?: GitHubWorkItemObservation,
  ): Promise<SakiWorkItemIntentReceipt<SakiWorkItemIntent['type']>> {
    const now = Date.now()
    const stageIndex = record.observedPrefix.length
    const stage = frontierStage(record)
    const admittedFailure = githubFailureSchema.parse(failure)
    if (stage.effectPossible && knownObservation !== undefined
      && isBoardObservation(knownObservation) && boardObservationView(knownObservation) !== undefined) {
      await this.putRecovery(record, knownObservation, now)
    }
    record = await this.transition(record, {
      phase: 'partial-failure',
      stages: replaceStage(record, stageIndex, {
        ...stage,
        state: 'failed',
        failure: admittedFailure,
      }),
    }, now)
    this.options.notifyChanged()
    return receiptFor(record)
  }

  private async putRecovery(
    record: GitHubWorkItemIntentRecord,
    observation: GitHubWorkItemBoardObservation,
    now: number,
    latestNonTerminalStatus?: Exclude<SakiBoardStatus, 'done' | 'canceled'>,
  ): Promise<void> {
    const workItemId = observation.workItemId
    const recoveryId = githubWorkItemRecoveryId(record.payload.intent.projectId, workItemId)
    const existingValue = this.options.recoveryTable.get(recoveryId)
    const existing = existingValue === undefined ? undefined : githubWorkItemRecoveryRecordSchema.parse(existingValue)
    const intent = record.payload.intent
    const view = completeBoardObservationView(observation)
    const observedStatusValue = observedStatus(view, this.options.mutationContext(intent.projectId))
    const observedNonTerminalStatus = observedStatusValue !== undefined && !terminalStatus(observedStatusValue)
      ? observedStatusValue
      : undefined
    const retainedLatestNonTerminalStatus = latestNonTerminalStatus
      ?? observedNonTerminalStatus
      ?? existing?.latestNonTerminalStatus
      ?? null
    const next = githubWorkItemRecoveryRecordSchema.parse({
      id: recoveryId,
      workItemId,
      schemaVersion: 1,
      revision: (existing?.revision ?? -1) + 1,
      projectId: intent.projectId,
      latestNonTerminalStatus: retainedLatestNonTerminalStatus,
      confirmed: { sourceIntentId: record.id, observation, confirmedAt: now },
      updatedAt: now,
    })
    if (existing === undefined) await this.options.recoveryTable.put(recoveryId, next)
    else await this.options.recoveryTable.update(recoveryId, (current) => {
      const parsed = githubWorkItemRecoveryRecordSchema.parse(current)
      /* v8 ignore next -- The project queue is the sole recovery writer between this read and update. */
      if (parsed.revision !== existing.revision) throw new IntentCasConflict()
      return next
    })
  }

  private async markFrontierDispatching(
    record: GitHubWorkItemIntentRecord,
    now?: number,
  ): Promise<GitHubWorkItemIntentRecord> {
    const stageIndex = record.observedPrefix.length
    const stage = frontierStage(record)
    return await this.transition(record, {
      phase: 'running',
      stages: replaceStage(record, stageIndex, {
        ...stage,
        state: 'dispatching',
        effectPossible: true,
        failure: undefined,
      }),
    }, now)
  }

  private async putIntent(record: GitHubWorkItemIntentRecord): Promise<void> {
    try {
      await this.options.intentTable.put(record.id, record)
    } catch (error) {
      const replay = this.options.intentTable.get(record.id)
      if (replay !== undefined && isDeepStrictEqual(githubWorkItemIntentRecordSchema.parse(replay), record)) return
      throw error
    }
  }

  private async transition(
    record: GitHubWorkItemIntentRecord,
    patch: Partial<GitHubWorkItemIntentRecord>,
    now: number = Date.now(),
  ): Promise<GitHubWorkItemIntentRecord> {
    const next = githubWorkItemIntentRecordSchema.parse(withoutUndefinedProperties({
      ...record,
      ...patch,
      id: record.id,
      revision: record.revision + 1,
      updatedAt: now,
    }))
    try {
      return await this.options.intentTable.update(record.id, (current) => {
        const parsed = githubWorkItemIntentRecordSchema.parse(current)
        /* v8 ignore next -- The Intent queue is the sole Intent writer between this read and update. */
        if (parsed.revision !== record.revision) throw new IntentCasConflict()
        return next
      })
    } catch (error) {
      const replay = this.options.intentTable.get(record.id)
      if (replay !== undefined && isDeepStrictEqual(githubWorkItemIntentRecordSchema.parse(replay), next)) return next
      throw error
    }
  }

  private requireIntent(intentId: SakiControlIntentId): GitHubWorkItemIntentRecord {
    const value = this.options.intentTable.get(intentId)
    /* v8 ignore next -- Resume receives ids inserted by submit or read from this owned table during recovery. */
    if (value === undefined) throw new Error(`missing GitHub Work Item Intent '${intentId}'`)
    return githubWorkItemIntentRecordSchema.parse(value)
  }

  private async recoverPending(): Promise<void> {
    for (const [, value] of this.options.intentTable.entries()) {
      const record = githubWorkItemIntentRecordSchema.parse(value)
      if (terminalPhase(record.phase)) continue
      await this.enqueueIntent(record.id, () => this.enqueueProject(
        record.payload.intent.projectId,
        () => this.resume(record.id, this.options.lifetime),
      ))
    }
  }

  private async enqueueIntent<T>(intentId: SakiControlIntentId, operation: () => Promise<T>): Promise<T> {
    return await enqueueKeyedOperation(this.intentTails, intentId, operation)
  }

  private async enqueueProject<T>(projectId: SakiDevelopmentProjectId, operation: () => Promise<T>): Promise<T> {
    return await enqueueKeyedOperation(this.projectTails, projectId, operation)
  }

  private async requestProjectScan(projectId: SakiDevelopmentProjectId, requiredThrough: number): Promise<void> {
    if ((this.scanRequestedThrough.get(projectId) ?? -1) >= requiredThrough) return
    await this.options.requestScan(projectId)
    this.scanRequestedThrough.set(
      projectId,
      Math.max(this.scanRequestedThrough.get(projectId) ?? -1, requiredThrough),
    )
  }

  private track(task: Promise<void>): void {
    const settled = task.catch((error: unknown) => { this.options.reportUnexpectedFailure(error) })
    this.active.add(settled)
    void settled.finally(() => this.active.delete(settled))
  }
}

function externalStateRepairOverlay(
  item: SakiConfirmedBoardProjection['items'][number],
): SakiBoardMutationOverlayProjection | undefined {
  if (item.archived) return undefined
  if (item.issueState === 'closed' && !terminalStatus(item.status)) {
    return {
      state: 'repair-required',
      workItemId: item.id,
      reason: 'external-close',
      action: 'move-with-actor',
      suggestedStatus: 'done',
    }
  }
  if (item.issueState === 'open' && terminalStatus(item.status)) {
    return {
      state: 'repair-required',
      workItemId: item.id,
      reason: 'external-reopen',
      action: 'move-with-actor',
      suggestedStatus: item.latestNonTerminalStatus ?? 'backlog',
    }
  }
  return undefined
}

function projectIntentOverlay(
  record: GitHubWorkItemIntentRecord,
  confirmedBoard: SakiConfirmedBoardProjection | undefined,
  completeObservedAt: number | undefined,
  context: GitHubWorkItemMutationContextResult,
  latestNonTerminalStatus: Exclude<SakiBoardStatus, 'done' | 'canceled'> | null | undefined,
): readonly SakiBoardMutationOverlayProjection[] {
  const intent = record.payload.intent
  const type = intent.type
  const workItemId = type === 'move-work-item' ? intent.workItemId : undefined
  if (record.phase === 'prepared' || record.phase === 'running') {
    return type === 'create-work-item'
      ? [{
        state: 'optimistic',
        intentId: record.id,
        type,
        title: intent.title,
        targetStatus: 'inbox',
      }]
      : [{
        state: 'optimistic',
        intentId: record.id,
        type,
        workItemId: intent.workItemId,
        targetStatus: intent.targetStatus,
        ...(intent.position === undefined ? {} : { position: intent.position }),
      }]
  }
  const partialFailure = partialFailureState(record)
  if (partialFailure !== undefined) {
    return [{
      state: 'partial-failure',
      intentId: record.id,
      type,
      ...(workItemId === undefined ? {} : { workItemId }),
      stage: partialFailure.stage.kind,
      recoveryAction: partialFailure.recoveryAction,
    }]
  }
  if (record.phase === 'succeeded' && record.terminalEvidence?.kind === 'succeeded') {
    const observation = record.terminalEvidence.confirmedObservation
    const view = completeBoardObservationView(observation)
    if (confirmedBoard?.items.some(item => item.id === view.workItemId
      && item.remoteFingerprint === view.remoteFingerprint)) return []
    if (completeObservedAt !== undefined && completeObservedAt > record.terminalEvidence.confirmedAt) return []
    const status = type === 'create-work-item' ? 'inbox' : intent.targetStatus
    const workItem = projectedObservationWorkItem(view, status, confirmedBoard, latestNonTerminalStatus)
    return [{
      state: 'targeted-confirmed',
      intentId: record.id,
      type,
      workItem,
      confirmedAt: record.terminalEvidence.confirmedAt,
    }]
  }
  if (record.phase === 'conflict' && record.terminalEvidence?.kind === 'conflict') {
    if (record.terminalEvidence.confirmedAt !== undefined
      && completeObservedAt !== undefined
      && completeObservedAt > record.terminalEvidence.confirmedAt) return []
    const observation = record.terminalEvidence.confirmedObservation
    const view = observation === undefined ? undefined : boardObservationView(observation)
    const status = view === undefined ? undefined : observedStatus(view, context)
    const workItem = view === undefined || status === undefined
      ? undefined
      : projectedObservationWorkItem(view, status, confirmedBoard, latestNonTerminalStatus)
    return [{
      state: 'conflict',
      intentId: record.id,
      type,
      reason: record.terminalEvidence.reason,
      ...(workItem === undefined ? {} : { workItem }),
      ...(record.terminalEvidence.confirmedAt === undefined
        ? {}
        : { confirmedAt: record.terminalEvidence.confirmedAt }),
    }]
  }
  if (record.phase === 'reconciliation-required'
    && record.terminalEvidence?.kind === 'reconciliation-required') {
    const evidence = record.terminalEvidence
    const stage = stageByMutationId(record, evidence.stageMutationId)
    return [{
      state: 'reconciliation-required',
      intentId: record.id,
      type,
      ...(workItemId === undefined ? {} : { workItemId }),
      stage: stage.kind,
      reason: evidence.reason,
    }]
  }
  return []
}

function projectedObservationWorkItem(
  observation: GitHubWorkItemBoardView,
  status: SakiBoardStatus,
  confirmedBoard: SakiConfirmedBoardProjection | undefined,
  latestNonTerminalStatus: Exclude<SakiBoardStatus, 'done' | 'canceled'> | null | undefined,
): SakiConfirmedBoardProjection['items'][number] {
  const facts = observation.facts
  const existing = confirmedBoard?.items.find(item => item.id === observation.workItemId)
  if (facts.membership.state === 'absent') {
    return {
      id: observation.workItemId,
      title: facts.issue.title,
      issueNumber: facts.issue.number,
      url: facts.issue.url,
      issueState: facts.issue.state,
      status: 'inbox',
      latestNonTerminalStatus: 'inbox',
      order: existing?.order ?? confirmedBoard?.items.length ?? 0,
      archived: false,
      notInProject: true,
      updatedAt: facts.issue.updatedAt,
      source: {
        kind: 'github-issue',
        repositoryId: facts.repositoryId,
        issueId: facts.issue.id,
      },
      remoteFingerprint: observation.remoteFingerprint,
    }
  }
  const item = facts.membership.item
  return {
    id: observation.workItemId,
    title: facts.issue.title,
    issueNumber: facts.issue.number,
    url: facts.issue.url,
    issueState: facts.issue.state,
    status,
    latestNonTerminalStatus: terminalStatus(status)
      ? latestNonTerminalStatus === undefined
        ? existing?.latestNonTerminalStatus ?? null
        : latestNonTerminalStatus
      : status,
    order: item.apiOrder,
    archived: item.archived,
    notInProject: false,
    updatedAt: Math.max(facts.issue.updatedAt, item.updatedAt),
    source: {
      kind: 'github-issue',
      repositoryId: facts.repositoryId,
      issueId: facts.issue.id,
      projectItemId: item.id,
      apiOrder: item.apiOrder,
    },
    remoteFingerprint: observation.remoteFingerprint,
  }
}

function observedStatus(
  observation: GitHubWorkItemBoardView,
  context: GitHubWorkItemMutationContextResult,
): SakiBoardStatus | undefined {
  if (observation.facts.membership.state === 'absent') return 'inbox'
  if (observation.facts.membership.item.archived) return 'canceled'
  const optionId = observation.facts.membership.item.statusOptionId
  if (optionId === undefined) return undefined
  if (!context.ok) return undefined
  const mapping = context.context.configuration.statusOptionNodeIds
  if (optionId === mapping.inbox) return 'inbox'
  if (optionId === mapping.backlog) return 'backlog'
  if (optionId === mapping.ready) return 'ready'
  if (optionId === mapping.inProgress) return 'in-progress'
  if (optionId === mapping.inReview) return 'in-review'
  if (optionId === mapping.done) return 'done'
  if (optionId === mapping.canceled) return 'canceled'
  return undefined
}

function resolveMovePosition(
  intent: MoveWorkItemIntent,
  board: SakiConfirmedBoardProjection,
): { readonly position: NonNullable<GitHubWorkItemMoveTarget['position']> } | undefined {
  const requested = intent.position
  if (requested === undefined) return undefined
  if (requested.afterWorkItemId === null) return { position: { kind: 'top' } }
  const predecessor = board.items.find(item => item.id === requested.afterWorkItemId)
  const projectItemId = predecessor?.source.projectItemId
  if (predecessor === undefined || projectItemId === undefined || predecessor.notInProject
    || predecessor.archived || predecessor.status !== intent.targetStatus
    || predecessor.remoteFingerprint !== requested.expectedAfterRemoteFingerprint) return undefined
  return {
    position: {
      kind: 'after',
      workItemId: predecessor.id,
      projectItemId,
      expectedRemoteFingerprint: predecessor.remoteFingerprint,
    },
  }
}

function resolvedMoveStageTarget(
  target: GitHubWorkItemMoveTarget,
  kind: GitHubWorkItemMoveStageKind,
  desiredIssueState: 'open' | 'closed',
): GitHubWorkItemResolvedTarget | undefined {
  const common = {
    installation: target.installation,
    repositoryId: target.repositoryId,
    repositoryDatabaseId: target.repositoryDatabaseId,
  }
  switch (kind) {
    case 'project-item-add': return {
      ...common,
      kind,
      projectId: target.projectId,
      issueId: target.issueId,
    }
    case 'project-item-status-set': return target.projectItemId === undefined ? undefined : {
      ...common,
      kind,
      projectId: target.projectId,
      issueId: target.issueId,
      projectItemId: target.projectItemId,
      statusFieldId: target.statusFieldId,
      desiredStatusOptionId: target.desiredStatusOptionId,
    }
    case 'project-item-position-set': {
      if (target.projectItemId === undefined) return undefined
      const position = target.position as NonNullable<GitHubWorkItemMoveTarget['position']>
      return {
        ...common,
        kind,
        projectId: target.projectId,
        issueId: target.issueId,
        projectItemId: target.projectItemId,
        statusFieldId: target.statusFieldId,
        afterItemId: position.kind === 'after' ? position.projectItemId : null,
      }
    }
    case 'issue-state-set': return {
      ...common,
      kind,
      issueId: target.issueId,
      desiredState: desiredIssueState,
    }
    /* v8 ignore next -- GitHubWorkItemMoveStageKind is closed and every member is handled above. */
    default: return assertNever(kind)
  }
}

function materializeKnownStageTargets(
  record: GitHubWorkItemIntentRecord,
): GitHubWorkItemIntentRecord['stages'] {
  return record.stages.map((stage) => {
    if (stage.resolvedTarget !== undefined) return stage
    const resolvedTarget = resolvedStageTarget(record, stage.kind)
    return resolvedTarget === undefined ? stage : {
      ...stage,
      resolvedTarget,
    }
  })
}

function resolvedStageTarget(
  record: GitHubWorkItemIntentRecord,
  kind: SakiWorkItemMutationStageKind,
): GitHubWorkItemResolvedTarget | undefined {
  // The durable schema correlates each target kind with its Intent and stage topology.
  if (record.target.kind === 'move-work-item') {
    const intent = record.payload.intent as MoveWorkItemIntent
    return resolvedMoveStageTarget(
      record.target,
      kind as GitHubWorkItemMoveStageKind,
      /* v8 ignore next -- Deferred Move materialization only revisits membership-dependent
       * stages; the Issue-state target was fixed during preparation. */
      terminalStatus(intent.targetStatus) ? 'closed' : 'open',
    )
  }
  const issueObservation = record.observedPrefix.find(observation => observation.stageKind === 'issue-create')
  /* v8 ignore next -- Create target materialization runs only after Issue-create confirmation. */
  const issueId = issueObservation?.stageKind === 'issue-create' ? issueObservation.issue.id : undefined
  const membershipObservation = record.observedPrefix.find(
    observation => observation.stageKind === 'project-item-add',
  )
  const membership = membershipObservation?.stageKind === 'project-item-add'
    && membershipObservation.facts.membership.state === 'present'
    ? membershipObservation.facts.membership.item
    : undefined
  const projectItemId = membership?.id
  const common = {
    installation: record.target.installation,
    repositoryId: record.target.repositoryId,
    repositoryDatabaseId: record.target.repositoryDatabaseId,
  }
  const createKind = kind as GitHubWorkItemCreateStageKind
  switch (createKind) {
    /* v8 ignore next -- Issue-create receives its resolved target during preparation and is skipped above. */
    case 'issue-create': return stageByKind(record, createKind).resolvedTarget
    case 'project-item-add': {
      /* v8 ignore next -- Membership target materialization follows the confirmed Issue-create prefix. */
      if (issueId === undefined) return undefined
      return {
        ...common,
        kind: createKind,
        projectId: record.target.projectId,
        issueId,
      }
    }
    case 'project-item-status-set': return issueId === undefined || projectItemId === undefined ? undefined : {
      ...common,
      kind: createKind,
      projectId: record.target.projectId,
      issueId,
      projectItemId,
      statusFieldId: record.target.statusFieldId,
      desiredStatusOptionId: record.target.desiredStatusOptionId,
    }
    /* v8 ignore next -- Parsed Create topology narrows this switch to its three closed stage kinds. */
    default: return assertNever(createKind)
  }
}

function issueCreateRequest(
  record: GitHubWorkItemIntentRecord,
  stage: GitHubWorkItemIntentRecord['stages'][number],
  inspectionHint?: GitHubIssueCreateRequest['inspectionHint'],
): GitHubIssueCreateRequest {
  const intent = record.payload.intent
  const target = stage.resolvedTarget
  /* v8 ignore next -- Parsed Create topology correlates the Intent, frontier stage, and resolved Issue target. */
  if (intent.type !== 'create-work-item' || record.target.kind !== 'create-work-item'
    || target?.kind !== 'issue-create' || stage.kind !== 'issue-create') {
    throw new Error('Issue-create request target is incomplete')
  }
  return {
    kind: 'issue-create',
    operationId: stage.mutationId,
    installation: target.installation,
    repositoryId: target.repositoryId,
    repositoryDatabaseId: target.repositoryDatabaseId,
    title: intent.title,
    body: renderGitHubWorkItemIssueBody({
      intendedOutcome: intent.intendedOutcome,
      acceptanceCriteria: intent.acceptanceCriteria,
      markerId: target.markerId,
    }),
    markerId: githubIssueCreateMarkerId(target.markerId),
    ...(inspectionHint === undefined ? {} : { inspectionHint }),
  }
}

function issueCreateObservation(
  record: GitHubWorkItemIntentRecord,
  request: GitHubIssueCreateRequest,
  inspection: GitHubIssueCreateInspection,
): GitHubWorkItemIssueCreateObservation {
  const target = record.target
  const outcome = inspection.snapshot.outcome
  /* v8 ignore next -- Callers pass a unique Issue and the marker derived from the same parsed Create record. */
  if (target.kind !== 'create-work-item' || outcome.state !== 'unique-issue'
    || request.markerId !== githubIssueCreateMarkerId(target.markerId)) {
    throw new Error('Issue-create confirmation lacks one unique Issue')
  }
  const issue = outcome.issue
  return {
    stageMutationId: request.operationId,
    stageKind: request.kind,
    workItemId: boardWorkItemId(inspection.snapshot.repositoryId, issue.id),
    repositoryId: inspection.snapshot.repositoryId,
    repositoryDatabaseId: inspection.snapshot.repositoryDatabaseId,
    markerId: target.markerId,
    issue,
    observedAt: inspection.observedAt,
  }
}

function createReconciliationReason(
  state: GitHubIssueCreateReconciliationState,
): GitHubIssueCreateReconciliationReason {
  return CREATE_RECONCILIATION_REASONS[state]
}

function membershipRequest(
  record: GitHubWorkItemIntentRecord,
  stage: GitHubWorkItemIntentRecord['stages'][number],
): GitHubProjectItemAddRequest {
  const target = stage.resolvedTarget
  /* v8 ignore next -- Parsed stage topology correlates the frontier stage, membership target, and Repository. */
  if (target?.kind !== 'project-item-add' || target.repositoryId !== record.target.repositoryId
    || stage.kind !== 'project-item-add') {
    throw new Error('membership request target is incomplete')
  }
  return {
    kind: 'project-item-add',
    operationId: stage.mutationId,
    installation: target.installation,
    repositoryId: target.repositoryId,
    repositoryDatabaseId: target.repositoryDatabaseId,
    projectId: target.projectId,
    issueId: target.issueId,
  }
}

function membershipObservation(
  request: GitHubProjectItemAddRequest,
  inspection: GitHubProjectItemAddInspection,
): GitHubWorkItemMembershipObservation {
  const snapshot = inspection.snapshot
  const facts: GitHubWorkItemMembershipObservation['facts'] = {
    ...snapshot,
    issue: { ...snapshot.issue },
    membership: snapshot.membership.state === 'present'
      ? { state: 'present', item: { ...snapshot.membership.item } }
      : snapshot.membership.state === 'duplicate-conflict'
        ? { state: 'duplicate-conflict', items: snapshot.membership.items.map(item => ({ ...item })) }
        : { state: 'absent' },
  }
  return {
    stageMutationId: request.operationId,
    stageKind: request.kind,
    workItemId: boardWorkItemId(facts.repositoryId, facts.issue.id),
    facts,
    observedAt: inspection.observedAt,
  }
}

function membershipAbsenceMatchesExpected(
  record: GitHubWorkItemIntentRecord,
  observation: GitHubWorkItemMembershipObservation,
): boolean {
  const intent = record.payload.intent
  const target = record.target
  const facts = observation.facts
  if (intent.type === 'create-work-item' && target.kind === 'create-work-item') {
    const issueObservation = record.observedPrefix.find(
      candidate => candidate.stageKind === 'issue-create',
    )
    return issueObservation?.stageKind === 'issue-create'
      && facts.membership.state === 'absent'
      && observation.workItemId === issueObservation.workItemId
      && facts.repositoryId === target.repositoryId
      && facts.repositoryDatabaseId === target.repositoryDatabaseId
      && facts.projectId === target.projectId
      && facts.issue.id === issueObservation.issue.id
      && facts.issue.state === 'open'
  }
  /* v8 ignore next -- The parsed target kind matches the Intent kind before this private matcher runs. */
  if (intent.type !== 'move-work-item' || target.kind !== 'move-work-item') return false
  return facts.repositoryId === target.repositoryId
    && facts.repositoryDatabaseId === target.repositoryDatabaseId
    && facts.projectId === target.projectId
    && facts.issue.id === target.issueId
    && facts.issue.state === 'open'
    && targetedBoardRemoteFingerprint({
      repositoryId: facts.repositoryId,
      repositoryDatabaseId: facts.repositoryDatabaseId,
      projectId: facts.projectId,
      statusFieldId: target.statusFieldId,
      issue: facts.issue,
      membership: { state: 'absent' },
    }) === intent.expectedRemoteFingerprint
}

function replaceStage(
  record: GitHubWorkItemIntentRecord,
  index: number,
  replacement: GitHubWorkItemIntentRecord['stages'][number],
): GitHubWorkItemIntentRecord['stages'] {
  const stages = [...record.stages]
  stages[index] = replacement
  return stages
}

/** Return the stage frontier guaranteed for every parsed non-terminal Work Item Intent. */
function frontierStage(record: GitHubWorkItemIntentRecord): GitHubWorkItemStage {
  return record.stages[record.observedPrefix.length] as GitHubWorkItemStage
}

/** Return the failed frontier guaranteed by a parsed partial-failure Intent. */
function failedFrontier(record: GitHubWorkItemIntentRecord): GitHubWorkItemFailedStage {
  return frontierStage(record) as GitHubWorkItemFailedStage
}

/** Return the named stage guaranteed by the parsed Work Item mutation topology. */
function stageByKind<K extends SakiWorkItemMutationStageKind>(
  record: GitHubWorkItemIntentRecord,
  kind: K,
): GitHubWorkItemStage & { kind: K } {
  return record.stages.find(
    (stage): stage is GitHubWorkItemStage & { kind: K } => stage.kind === kind,
  ) as GitHubWorkItemStage & { kind: K }
}

/** Return the stage identified by parsed reconciliation evidence. */
function stageByMutationId(
  record: GitHubWorkItemIntentRecord,
  mutationId: GitHubWorkItemStage['mutationId'],
): GitHubWorkItemStage {
  return record.stages.find(stage => stage.mutationId === mutationId) as GitHubWorkItemStage
}

function statusRequest(
  record: GitHubWorkItemIntentRecord,
  stage: GitHubWorkItemIntentRecord['stages'][number],
): GitHubProjectItemStatusSetRequest {
  const target = stage.resolvedTarget
  /* v8 ignore next -- Parsed stage topology correlates the frontier stage, Status target, and Repository. */
  if (target?.kind !== 'project-item-status-set' || target.repositoryId !== record.target.repositoryId
    || stage.kind !== 'project-item-status-set') {
    throw new Error('Status request target is incomplete')
  }
  return {
    kind: 'project-item-status-set',
    operationId: stage.mutationId,
    installation: target.installation,
    repositoryId: target.repositoryId,
    repositoryDatabaseId: target.repositoryDatabaseId,
    projectId: target.projectId,
    issueId: target.issueId,
    projectItemId: target.projectItemId,
    statusFieldId: target.statusFieldId,
    desiredStatusOptionId: target.desiredStatusOptionId,
  }
}

function positionRequest(
  record: GitHubWorkItemIntentRecord,
  stage: GitHubWorkItemIntentRecord['stages'][number],
): GitHubProjectItemPositionSetRequest {
  const target = stage.resolvedTarget
  /* v8 ignore next -- Parsed Move topology correlates the frontier stage and resolved position target. */
  if (record.target.kind !== 'move-work-item' || target?.kind !== 'project-item-position-set'
    || stage.kind !== 'project-item-position-set') {
    throw new Error('position request target is incomplete')
  }
  return {
    kind: 'project-item-position-set',
    operationId: stage.mutationId,
    installation: target.installation,
    repositoryId: target.repositoryId,
    repositoryDatabaseId: target.repositoryDatabaseId,
    projectId: target.projectId,
    issueId: target.issueId,
    projectItemId: target.projectItemId,
    statusFieldId: target.statusFieldId,
    afterItemId: target.afterItemId,
  }
}

function positionObservation(
  request: GitHubProjectItemPositionSetRequest,
  inspection: GitHubProjectItemPositionSetInspection,
): GitHubWorkItemPositionObservation {
  const snapshot = inspection.snapshot
  const facts: GitHubWorkItemPositionObservation['facts'] = {
    ...snapshot,
    issue: { ...snapshot.issue },
    /* jscpd:ignore-start -- Position observations detach their provider-specific membership union before persistence. */
    membership: snapshot.membership.state === 'present'
      ? { state: 'present', item: { ...snapshot.membership.item } }
      : snapshot.membership.state === 'duplicate-conflict'
        ? { state: 'duplicate-conflict', items: snapshot.membership.items.map(item => ({ ...item })) }
        : { state: 'absent' },
    /* jscpd:ignore-end */
    after: snapshot.after.state === 'present'
      ? { state: 'present', item: { ...snapshot.after.item, issue: { ...snapshot.after.item.issue } } }
      : { ...snapshot.after },
  }
  return {
    stageMutationId: request.operationId,
    stageKind: request.kind,
    workItemId: boardWorkItemId(facts.repositoryId, facts.issue.id),
    facts,
    observedAt: inspection.observedAt,
  }
}

function positionIsDesired(
  request: GitHubProjectItemPositionSetRequest,
  snapshot: GitHubProjectItemPositionSetInspection['snapshot'],
  item: GitHubWorkItemPositionItem,
): boolean {
  if (request.afterItemId === null) {
    return snapshot.after.state === 'top' && item.apiOrder === 0 && item.previousItemId === null
  }
  return snapshot.after.state === 'present'
    && snapshot.after.item.id === request.afterItemId
    && item.previousItemId === snapshot.after.item.id
    && snapshot.after.item.nextItemId === item.id
    && item.apiOrder === snapshot.after.item.apiOrder + 1
    && item.totalCount === snapshot.after.item.totalCount
}

function positionAnchorView(
  snapshot: GitHubProjectItemPositionSetInspection['snapshot'],
  after: Extract<GitHubProjectItemPositionSetInspection['snapshot']['after'], { state: 'present' }>,
  statusOptionId: GitHubProjectOptionId,
): GitHubWorkItemBoardView {
  const anchor = after.item
  const facts: GitHubWorkItemTargetedObservation['facts'] = {
    repositoryId: snapshot.repositoryId,
    repositoryDatabaseId: snapshot.repositoryDatabaseId,
    projectId: snapshot.projectId,
    statusFieldId: snapshot.statusFieldId,
    issue: anchor.issue,
    membership: {
      state: 'present',
      item: {
        id: anchor.id,
        projectId: anchor.projectId,
        issueId: anchor.issue.id,
        statusOptionId,
        archived: anchor.archived,
        apiOrder: anchor.apiOrder,
        totalCount: anchor.totalCount,
        previousItemId: anchor.previousItemId,
        nextItemId: anchor.nextItemId,
        updatedAt: anchor.updatedAt,
      },
    },
  }
  return {
    workItemId: boardWorkItemId(snapshot.repositoryId, anchor.issue.id),
    remoteFingerprint: targetedBoardRemoteFingerprint(facts),
    facts,
    observedAt: anchor.updatedAt,
  }
}

function issueStateRequest(
  record: GitHubWorkItemIntentRecord,
  stage: GitHubWorkItemIntentRecord['stages'][number],
): GitHubIssueStateSetRequest {
  const target = stage.resolvedTarget
  /* v8 ignore next -- Parsed Move topology correlates the frontier stage and resolved Issue-state target. */
  if (record.target.kind !== 'move-work-item' || target?.kind !== 'issue-state-set'
    || stage.kind !== 'issue-state-set') {
    throw new Error('Issue-state request target is incomplete')
  }
  return {
    kind: 'issue-state-set',
    operationId: stage.mutationId,
    installation: target.installation,
    repositoryId: target.repositoryId,
    repositoryDatabaseId: target.repositoryDatabaseId,
    issueId: target.issueId,
    desiredState: target.desiredState,
  }
}

function issueStateObservation(
  request: GitHubIssueStateSetRequest,
  inspection: GitHubIssueStateSetInspection,
): GitHubWorkItemIssueStateObservation {
  const facts = inspection.snapshot
  return {
    stageMutationId: request.operationId,
    stageKind: request.kind,
    workItemId: boardWorkItemId(facts.issue.repositoryId, facts.issue.id),
    facts,
    observedAt: inspection.observedAt,
  }
}

function issueStateIsDesired(
  request: GitHubIssueStateSetRequest,
  inspection: GitHubIssueStateSetInspection,
): boolean {
  const issue = inspection.snapshot.issue
  return issue.repositoryId === request.repositoryId
    && issue.repositoryDatabaseId === request.repositoryDatabaseId
    && issue.id === request.issueId
    && issue.state === request.desiredState
}

function issueStateMatchesExpected(
  record: GitHubWorkItemIntentRecord,
  observation: GitHubWorkItemIssueStateObservation,
): boolean {
  const target = record.target
  const intent = record.payload.intent
  const stage = record.stages[record.observedPrefix.length]
  const resolved = stage?.resolvedTarget
  /* v8 ignore next -- Parsed Move topology supplies the Issue-state frontier and its correlated target. */
  if (intent.type !== 'move-work-item' || target.kind !== 'move-work-item'
    || resolved?.kind !== 'issue-state-set') return false
  const expectedState = resolved.desiredState === 'open' ? 'closed' : 'open'
  const issue = observation.facts.issue
  return observation.workItemId === intent.workItemId
    && issue.repositoryId === target.repositoryId
    && issue.repositoryDatabaseId === target.repositoryDatabaseId
    && issue.id === target.issueId
    && issue.state === expectedState
}

function targetedObservation(
  request: GitHubProjectItemStatusSetRequest,
  inspection: GitHubProjectItemStatusSetInspection,
): GitHubWorkItemTargetedObservation {
  const facts = inspection.snapshot
  return {
    stageMutationId: request.operationId,
    stageKind: request.kind,
    workItemId: boardWorkItemId(facts.repositoryId, facts.issue.id),
    remoteFingerprint: targetedBoardRemoteFingerprint(facts),
    facts,
    observedAt: inspection.observedAt,
  }
}

function statusIsDesired(
  record: GitHubWorkItemIntentRecord,
  request: GitHubProjectItemStatusSetRequest,
  inspection: GitHubProjectItemStatusSetInspection,
): boolean {
  const snapshot = inspection.snapshot
  const precedingIssueState = record.stages.slice(0, record.observedPrefix.length)
    .find(stage => stage.resolvedTarget?.kind === 'issue-state-set')
    ?.resolvedTarget
  const expectedIssueState = precedingIssueState?.kind === 'issue-state-set'
    ? precedingIssueState.desiredState
    : record.target.kind === 'move-work-item'
      ? record.target.source.issueState
      : 'open'
  return snapshot.repositoryId === request.repositoryId
    && snapshot.repositoryDatabaseId === request.repositoryDatabaseId
    && snapshot.projectId === request.projectId
    && snapshot.statusFieldId === request.statusFieldId
    && snapshot.issue.id === request.issueId
    && snapshot.membership.state === 'present'
    && snapshot.membership.item.id === request.projectItemId
    && snapshot.membership.item.statusOptionId === request.desiredStatusOptionId
    && !snapshot.membership.item.archived
    && snapshot.issue.state === expectedIssueState
}

function targetConfigurationMatches(
  target: GitHubWorkItemIntentRecord['target'],
  configuration: GitHubWorkItemMutationContext['configuration'],
  desiredStatusOptionId: GitHubProjectOptionId,
): boolean {
  return target.installation.appId === configuration.appId
    && target.installation.installationId === configuration.githubInstallationId
    && target.installation.accountId === configuration.accountNodeId
    && target.installation.privateKeyRef === configuration.credentialRef
    && target.repositoryId === configuration.repositoryNodeId
    && target.repositoryDatabaseId === configuration.repositoryDatabaseId
    && target.projectId === configuration.projectNodeId
    && target.statusFieldId === configuration.statusFieldNodeId
    && target.desiredStatusOptionId === desiredStatusOptionId
}

function statusOptionId(
  mapping: GitHubStatusOptionMapping,
  status: SakiBoardStatus,
): GitHubProjectOptionId {
  return mapping[STATUS_OPTION_FIELD_BY_STATUS[status]]
}

function terminalStatus(status: SakiBoardStatus): status is 'done' | 'canceled' {
  return status === 'done' || status === 'canceled'
}

function compareIntentOrder(
  left: GitHubWorkItemIntentRecord,
  right: GitHubWorkItemIntentRecord,
): number {
  return left.createdAt - right.createdAt || String(left.id).localeCompare(String(right.id))
}

function providerFailure(error: unknown): GitHubFailure {
  if (error instanceof GitHubProviderError) return error.failure
  throw error
}

function workItemAction(record: GitHubWorkItemIntentRecord): WorkItemAction {
  return record.payload.intent.type === 'create-work-item' ? 'work-item:create' : 'work-item:move'
}

function mappingRepairReason(failure: GitHubWorkItemFailure): string | undefined {
  switch (failure.code) {
    case 'not-found': return `not-found:${failure.resource}`
    case 'permission-mismatch': return `permission-mismatch:${failure.permission}`
    case 'mapping-mismatch': return `mapping-mismatch:${failure.reason}`
    case 'invalid-external-response': return `invalid-external-response:${failure.operation}`
    case 'permanent-rejection': return `permanent-rejection:${failure.status ?? 'unknown'}`
    case 'transient-transport': return undefined
    /* v8 ignore start -- These non-repair failures share the resume behavior covered by transient transport. */
    case 'cancelled':
    case 'auth-unavailable':
    case 'primary-rate-limit':
    case 'secondary-rate-limit':
      return undefined
    /* v8 ignore stop */
    /* v8 ignore next -- GitHubFailureCode is closed and every member is handled above. */
    default: return assertNever(failure)
  }
}

function partialFailureState(record: GitHubWorkItemIntentRecord): {
  readonly stage: GitHubWorkItemIntentRecord['stages'][number]
  readonly recoveryAction: SakiWorkItemRecoveryAction
} | undefined {
  if (record.phase !== 'partial-failure') return undefined
  const stage = failedFrontier(record)
  if (stage.effectPossible) return { stage, recoveryAction: { kind: 'inspect-before-retry' } }
  const repairReason = mappingRepairReason(stage.failure)
  return {
    stage,
    recoveryAction: repairReason === undefined
      ? { kind: 'resume-intent' }
      : { kind: 'repair-mapping', reason: repairReason },
  }
}

function receiptFor(record: GitHubWorkItemIntentRecord): SakiWorkItemIntentReceipt<SakiWorkItemIntent['type']> {
  const intent = record.payload.intent
  const base = {
    id: record.receiptId,
    intentId: record.id,
    type: intent.type,
    projectId: intent.projectId,
  }
  const workItemId = intent.type === 'move-work-item'
    ? intent.workItemId
    : record.observedPrefix.at(-1)?.workItemId
  if (record.phase === 'succeeded' && record.terminalEvidence?.kind === 'succeeded') {
    const observation = record.terminalEvidence.confirmedObservation
    const view = completeBoardObservationView(observation)
    return {
      ok: true,
      receipt: {
        ...base,
        state: 'succeeded',
        workItemId: view.workItemId,
        issueNumber: view.facts.issue.number,
        url: view.facts.issue.url,
        remoteFingerprint: view.remoteFingerprint,
      },
    }
  }
  if (record.phase === 'conflict' && record.terminalEvidence?.kind === 'conflict') {
    const view = record.terminalEvidence.confirmedObservation === undefined
      ? undefined
      : boardObservationView(record.terminalEvidence.confirmedObservation)
    return {
      ok: false,
      reason: 'conflict',
      receipt: {
        ...base,
        state: 'conflict',
        reason: record.terminalEvidence.reason,
        ...(workItemId === undefined ? {} : { workItemId }),
        ...(view === undefined ? {} : { remoteFingerprint: view.remoteFingerprint }),
      },
    }
  }
  if (record.phase === 'reconciliation-required'
    && record.terminalEvidence?.kind === 'reconciliation-required') {
    const evidence = record.terminalEvidence
    const stage = stageByMutationId(record, evidence.stageMutationId)
    return {
      ok: false,
      reason: 'reconciliation-required',
      receipt: {
        ...base,
        state: 'reconciliation-required',
        reason: evidence.reason,
        stage: stage.kind,
        ...(workItemId === undefined ? {} : { workItemId }),
      },
    }
  }
  if (record.phase === 'canceled') {
    return {
      ok: false,
      reason: 'canceled',
      receipt: { ...base, state: 'canceled', reason: 'authority-revoked', ...(workItemId === undefined ? {} : { workItemId }) },
    }
  }
  const partialFailure = partialFailureState(record)
  if (partialFailure !== undefined) {
    return {
      ok: false,
      reason: 'unavailable',
      receipt: {
        ...base,
        state: 'partial-failure',
        stage: partialFailure.stage.kind,
        recoveryAction: partialFailure.recoveryAction,
        ...(workItemId === undefined ? {} : { workItemId }),
      },
    }
  }
  return {
    ok: false,
    reason: 'unavailable',
    receipt: {
      ...base,
      state: record.phase === 'running' ? 'running' : 'prepared',
      ...(workItemId === undefined ? {} : { workItemId }),
    },
  }
}

function conflictWithoutReceipt(): SakiWorkItemIntentReceipt<SakiWorkItemIntent['type']> {
  return { ok: false, reason: 'conflict' }
}

function terminalPhase(phase: GitHubWorkItemIntentRecord['phase']): boolean {
  return phase === 'succeeded' || phase === 'conflict'
    || phase === 'reconciliation-required' || phase === 'canceled'
}

function terminalObservationConfirmedAt(record: GitHubWorkItemIntentRecord): number | undefined {
  if (record.terminalEvidence?.kind === 'succeeded') return record.terminalEvidence.confirmedAt
  if (record.terminalEvidence?.kind === 'conflict'
    && record.terminalEvidence.confirmedObservation !== undefined) {
    return record.terminalEvidence.confirmedAt
  }
  return undefined
}

function terminalObservation(
  record: GitHubWorkItemIntentRecord,
): GitHubWorkItemIntentRecord['observedPrefix'][number] | undefined {
  if (record.terminalEvidence?.kind === 'succeeded') return record.terminalEvidence.confirmedObservation
  if (record.terminalEvidence?.kind === 'conflict') return record.terminalEvidence.confirmedObservation
  return undefined
}

function isBoardObservation(
  observation: GitHubWorkItemIntentRecord['observedPrefix'][number],
): observation is GitHubWorkItemBoardObservation {
  return observation.stageKind === 'project-item-status-set'
    || observation.stageKind === 'project-item-position-set'
}

function boardObservationView(
  observation: GitHubWorkItemObservation,
): GitHubWorkItemBoardView | undefined {
  if (!isBoardObservation(observation)) return undefined
  if (observation.stageKind === 'project-item-status-set') return observation
  const snapshot = observation.facts
  if (snapshot.membership.state === 'duplicate-conflict') return undefined
  const facts: GitHubWorkItemTargetedObservation['facts'] = {
    repositoryId: snapshot.repositoryId,
    repositoryDatabaseId: snapshot.repositoryDatabaseId,
    projectId: snapshot.projectId,
    statusFieldId: snapshot.statusFieldId,
    issue: snapshot.issue,
    membership: snapshot.membership,
  }
  return {
    workItemId: observation.workItemId,
    remoteFingerprint: targetedBoardRemoteFingerprint(facts),
    facts,
    observedAt: observation.observedAt,
  }
}

/** Project complete Board evidence already admitted by the Work Item saga. */
function completeBoardObservationView(
  observation: GitHubWorkItemBoardObservation,
): GitHubWorkItemBoardView {
  return boardObservationView(observation) as GitHubWorkItemBoardView
}

function intentWorkItemId(record: GitHubWorkItemIntentRecord): SakiBoardWorkItemId | undefined {
  if (record.payload.intent.type === 'move-work-item') return record.payload.intent.workItemId
  return record.observedPrefix.at(-1)?.workItemId ?? terminalObservation(record)?.workItemId
}

function recoveryObservationMatchesSource(
  recovery: GitHubWorkItemRecoveryRecord,
  source: GitHubWorkItemIntentRecord,
): boolean {
  const observation = recovery.confirmed.observation
  const view = completeBoardObservationView(observation)
  const facts = view.facts
  const stage = source.stages.find(candidate => (
    candidate.mutationId === observation.stageMutationId
      && candidate.kind === observation.stageKind
  ))
  const target = stage?.resolvedTarget
  if (target?.kind !== 'project-item-status-set' && target?.kind !== 'project-item-position-set') return false
  const commonMatches = facts.repositoryId === target.repositoryId
    && facts.repositoryDatabaseId === target.repositoryDatabaseId
    && facts.projectId === target.projectId
    && facts.statusFieldId === target.statusFieldId
    && facts.issue.id === target.issueId
  if (!commonMatches) return false
  return target.kind === 'project-item-status-set'
    || (observation.stageKind === 'project-item-position-set'
      && observation.facts.membership.state === 'present'
      && observation.facts.membership.item.id === target.projectItemId)
}

function receiptId(intentId: SakiControlIntentId): SakiIntentReceiptId {
  return intentId.replace(/^intent-/u, 'receipt-') as SakiIntentReceiptId
}

/* v8 ignore next 3 -- Only ignored closed-union defaults call this exhaustiveness backstop. */
function assertNever(value: never): never {
  throw new TypeError(`unexpected Work Item discriminant: ${JSON.stringify(value)}`)
}

function withoutUndefinedProperties(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefinedProperties)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value)
    .filter(([, member]) => member !== undefined)
    .map(([key, member]) => [key, withoutUndefinedProperties(member)]))
}
