/** Recoverable manual Work Item assignment, Dispatch, and Agent Run ownership. */

import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SakiGitHub, GitHubBranchSafetyFact, GitHubIssueDetailFact } from '@breakfastdapaidang/saki-github'
import {
  canonicalDigest,
  computeStartAgentRunPayloadDigest,
  hostOperationSnapshotSchema,
} from '@breakfastdapaidang/saki-execution'
import type {
  HostOperationAdmissionDecision,
  HostOperationAdmissionExpectation,
  HostOperationAdmissionSource,
  HostOperationChange,
  HostOperationPreparation,
  HostOperationReceipt,
  HostOperationReference,
  HostOperationSnapshot,
  InterventionOpeningEvidence,
  SakiAgentRunId,
  SakiExecutionDispatchId,
  SakiHostExecution,
  SakiWorkSessionId,
  StartAgentRunInputMessage,
  StartAgentRunHostOperationRequest,
  StartAgentRunHostOperationResult,
} from '@breakfastdapaidang/saki-execution'
import type { GitHubWorkItemMutationContextResult } from './github-sync.ts'
import type { BindingWriteAdmissionTable } from './git-operations.ts'
import { enqueueKeyedOperation } from './keyed-operation.ts'
import type { DevelopmentProjects } from './projects.ts'
import {
  agentOperationIntentRecordSchema,
  agentRunRecordSchema,
  bindingWriteAdmissionRecordSchema,
  executionDispatchRecordSchema,
  workAssignmentRecordSchema,
  workSessionRecordSchema,
  interventionRequestRecordSchema,
  MAX_AGENT_RUN_DISPATCHES,
  MAX_INTERVENTION_ANSWER_CHARS,
} from './spec.ts'
import type {
  AgentOperationIntentRecord,
  AgentProfileRecord,
  AgentRunRecord,
  BindingWriteAdmissionRecord,
  ControlIntentActor,
  DevelopmentProjectRegistryRecord,
  ExecutionDispatchRecord,
  WorkAssignmentRecord,
  WorkSessionRecord,
  InterventionRequestRecord,
} from './spec.ts'
import type {
  AnswerInterventionIntent,
  GiveWorkItemToAgentIntent,
  MoveWorkItemIntent,
  SakiBoardWorkItemProjection,
  SakiControlIntentId,
  SakiDispatchClaimId,
  SakiGiveWorkItemToAgentIntentReceipt,
  SakiGiveWorkItemToAgentReceipt,
  SakiAnswerInterventionReceipt,
  SakiIntentReceiptId,
  SakiInterventionRequestId,
  SakiAnswerInterventionIntentReceipt,
  SakiResourceBindingId,
  SakiWorkAssignmentId,
  SakiWorkItemIntentReceipt,
} from './types.ts'

/** Stable Development Agent request admitted from the model-facing tool. */
export interface SakiAgentInterventionRequest {
  readonly sessionId: StartAgentRunHostOperationRequest['run']['sessionId']
  readonly toolCallId: ToolCallId
  readonly prompt: string
}

/** Result of durably opening or replaying one Agent-requested Intervention. */
export type SakiAgentInterventionRequestResult =
  | { readonly ok: true; readonly interventionId: SakiInterventionRequestId }
  | { readonly ok: false; readonly reason: 'conflict' | 'unavailable' }

/** Durable accepted manual-Agent Intent table. */
export type AgentOperationIntentTable = KvTable<SakiControlIntentId, AgentOperationIntentRecord>
/** Durable Work Assignment table. */
export type WorkAssignmentTable = KvTable<SakiWorkAssignmentId, WorkAssignmentRecord>
/** Durable Work Session table. */
export type WorkSessionTable = KvTable<SakiWorkSessionId, WorkSessionRecord>
/** Durable Agent Run table. */
export type AgentRunTable = KvTable<SakiAgentRunId, AgentRunRecord>
/** Durable Execution Dispatch table. */
export type ExecutionDispatchTable = KvTable<SakiExecutionDispatchId, ExecutionDispatchRecord>
/** Durable Intervention Request table; Attention and My Work remain projections. */
export type InterventionRequestTable = KvTable<SakiInterventionRequestId, InterventionRequestRecord>

type AgentAction = 'work-item:give-to-agent' | 'intervention:answer'
type GitHubReader = Pick<SakiGitHub, 'read'>
type AgentResult = SakiGiveWorkItemToAgentIntentReceipt
type InterventionAnswerResult = SakiAnswerInterventionIntentReceipt
type AgentConflictReason = Extract<
  SakiGiveWorkItemToAgentReceipt,
  { readonly state: 'conflict' }
>['reason']
type ClaimedExecutionDispatch = ExecutionDispatchRecord & {
  readonly state: 'claimed'
  readonly claim: NonNullable<ExecutionDispatchRecord['claim']>
}

interface AgentOperationsOptions {
  readonly intentTable: AgentOperationIntentTable
  readonly assignmentTable: WorkAssignmentTable
  readonly workSessionTable: WorkSessionTable
  readonly agentRunTable: AgentRunTable
  readonly dispatchTable: ExecutionDispatchTable
  readonly interventionTable: InterventionRequestTable
  readonly admissionTable: BindingWriteAdmissionTable
  readonly execution: SakiHostExecution
  readonly projects: DevelopmentProjects
  readonly mutationContext: (projectId: GiveWorkItemToAgentIntent['projectId']) => GitHubWorkItemMutationContextResult
  readonly authorityCurrent: (actor: ControlIntentActor, action: AgentAction) => boolean
  readonly validateActorReference: (actor: ControlIntentActor) => void
  readonly resolveModelRoute: (
    route: NonNullable<AgentProfileRecord['modelRouteRequest']>,
    signal: AbortSignal,
  ) => Promise<void>
  readonly moveWorkItem: (
    intent: MoveWorkItemIntent,
    actor: ControlIntentActor,
    signal: AbortSignal,
  ) => Promise<SakiWorkItemIntentReceipt<'move-work-item'>>
  readonly claimTtlMs: number
  readonly notifyChanged: () => void
  readonly lifetime: AbortSignal
}

/** Fully cross-validated manual Agent operation state in recovery order. */
export interface ValidatedAgentOperationsState {
  readonly intents: readonly AgentOperationIntentRecord[]
  readonly interventions: readonly InterventionRequestRecord[]
  readonly runningAgentRuns: readonly {
    readonly operation: HostOperationReference<'start-agent-run'>
    readonly request: StartAgentRunHostOperationRequest
  }[]
  readonly openingInterventionIds: readonly SakiInterventionRequestId[]
  readonly answerPendingInterventionIds: readonly SakiInterventionRequestId[]
}

type ReadonlyTable<K extends string, V> = Pick<KvTable<K, V>, 'entries' | 'get' | 'size'>

class AdmissionBusy extends Error {}
class AdmissionUnavailable extends Error {}
class DispatchClaimLost extends Error {}
class RecordCasConflict extends Error {}

/** Durable Consumer that hides the complete manual assignment and Dispatch state machine. */
export class AgentOperations {
  private readonly intentTails = new Map<SakiControlIntentId, Promise<void>>()
  private readonly bindingTails = new Map<SakiResourceBindingId, Promise<void>>()
  private readonly runInterventionTails = new Map<SakiAgentRunId, Promise<void>>()
  private readonly interventionTails = new Map<SakiInterventionRequestId, Promise<void>>()
  private readonly active = new Set<Promise<void>>()
  private readonly admitOperation: HostOperationAdmissionSource = (expectation, signal) => (
    this.admit(expectation, signal)
  )
  private github: GitHubReader | undefined

  constructor(private readonly options: AgentOperationsOptions) {}

  /**
   * Attach the optional provider-neutral GitHub reader used only for fresh eligibility.
   * @param github - reader for current Issue detail and branch-safety facts.
   * @returns a disposer that detaches this exact reader.
   */
  attachGitHub(github: GitHubReader): () => void {
    if (this.github !== undefined) throw new Error('Saki Agent operations already have a GitHub reader')
    this.github = github
    return () => {
      if (this.github === github) this.github = undefined
    }
  }

  /**
   * Parse and cross-check every retained record without writes or external calls.
   * @param otherIntentIds - Control Intent ids already owned by other durable families.
   * @param registry - validated Project Registry, or absence before provisioning.
   * @returns accepted Intents and validated running Agent recoveries in deterministic order.
   */
  validateDurableState(
    otherIntentIds: ReadonlySet<SakiControlIntentId>,
    registry: DevelopmentProjectRegistryRecord | undefined,
  ): ValidatedAgentOperationsState {
    return validateAgentOperationsDurableState(
      this.options.intentTable,
      this.options.assignmentTable,
      this.options.workSessionTable,
      this.options.agentRunTable,
      this.options.dispatchTable,
      this.options.interventionTable,
      this.options.admissionTable,
      registry,
      otherIntentIds,
      this.options.validateActorReference,
    )
  }

  /**
   * Restore every validated running Agent before reconciling retained accepted
   * Intents; any recovery failure prevents startup readiness.
   * @param state - fully cross-validated recovery inventory.
   */
  async initializeValidated(state: ValidatedAgentOperationsState): Promise<void> {
    for (const running of state.runningAgentRuns) {
      this.options.lifetime.throwIfAborted()
      await this.options.execution.resumeAgentRun(running.operation, running.request, this.options.lifetime)
    }
    for (const intent of state.intents) {
      this.options.lifetime.throwIfAborted()
      await this.enqueueIntent(intent.id, () => this.resume(intent.id, this.options.lifetime))
    }
    for (const interventionId of state.answerPendingInterventionIds) {
      this.options.lifetime.throwIfAborted()
      await enqueueKeyedOperation(this.interventionTails, interventionId, async () => {
        await this.resumeInterventionAnswer(
          this.requireIntervention(interventionId) as AnsweredIntervention,
          this.options.lifetime,
        )
      })
    }
    for (const interventionId of state.openingInterventionIds) {
      this.options.lifetime.throwIfAborted()
      await this.finalizeInterventionOpening(interventionId, this.options.lifetime, 'startup')
    }
  }

  /** Wait for every notification-driven recovery attempt to settle. */
  async dispose(): Promise<void> {
    await Promise.all([
      ...this.active,
      ...this.intentTails.values(),
      ...this.bindingTails.values(),
      ...this.runInterventionTails.values(),
      ...this.interventionTails.values(),
    ])
  }

  /**
   * Treat Host notifications as wake-ups and re-read durable state before acting.
   * @param change - changed Host Operation reference used only to locate its Dispatch.
   */
  hostChanged(change: HostOperationChange): void {
    const dispatch = [...this.options.dispatchTable.entries()]
      .map(([, value]) => executionDispatchRecordSchema.parse(value))
      .find(candidate => candidate.preparation?.operation.id === change.operation.id)
    if (dispatch === undefined) return
    const intent = this.options.intentTable.get(dispatch.intentId)
    const work = intent === undefined
      ? this.resumeChangedInterventionDispatch(dispatch)
      : terminal(agentOperationIntentRecordSchema.parse(intent).phase)
        ? undefined
        : this.enqueueIntent(dispatch.intentId, () => this.resume(dispatch.intentId, this.options.lifetime))
    if (work === undefined) return
    const settled = work.then(() => undefined, () => undefined)
    this.active.add(settled)
    void settled.finally(() => { this.active.delete(settled) })
  }

  private resumeChangedInterventionDispatch(dispatch: ExecutionDispatchRecord): Promise<unknown> | undefined {
    const intervention = [...this.options.interventionTable.entries()]
      .map(([, value]) => interventionRequestRecordSchema.parse(value))
      .find(candidate => 'answer' in candidate
        && candidate.answer !== undefined
        && candidate.answer.dispatchId === dispatch.id
        && candidate.answer.payload.intent.intentId === dispatch.intentId)
    if (intervention?.state !== 'answered') return undefined
    return enqueueKeyedOperation(this.interventionTails, intervention.id, () => (
      this.resumeInterventionAnswer(
        this.requireIntervention(intervention.id) as AnsweredIntervention,
        this.options.lifetime,
      )
    ))
  }

  /**
   * Submit or replay one explicit manual Give-to-Agent Intent.
   * @param intent - authority-free requested Work Item and expected revisions.
   * @param actor - trusted immutable attribution derived by the control plane.
   * @param signal - cancellation for this submission attempt only.
   * @returns the durable started, retryable, canceled, conflict, or reconciliation receipt.
   */
  async submit(
    intent: GiveWorkItemToAgentIntent,
    actor: ControlIntentActor,
    signal: AbortSignal,
  ): Promise<AgentResult> {
    return await this.enqueueIntent(intent.intentId, async () => {
      const existingValue = this.options.intentTable.get(intent.intentId)
      if (existingValue !== undefined) {
        const existing = agentOperationIntentRecordSchema.parse(existingValue)
        if (!isDeepStrictEqual(existing.payload.intent, intent)) return { ok: false, reason: 'conflict' }
        return await this.resume(existing.id, signal)
      }
      if (!this.options.authorityCurrent(actor, 'work-item:give-to-agent')) {
        return { ok: false, reason: 'denied' }
      }
      const eligibility = await this.resolveEligibility(intent, signal)
      if (!eligibility.ok) return eligibility.result
      try {
        await this.options.resolveModelRoute(eligibility.profile.modelRouteRequest, signal)
      } catch {
        signal.throwIfAborted()
        return { ok: false, reason: 'unavailable', detail: 'model-route-unavailable' }
      }
      signal.throwIfAborted()
      if (!this.options.authorityCurrent(actor, 'work-item:give-to-agent')) {
        return { ok: false, reason: 'denied' }
      }
      const record = this.buildIntent(intent, actor, eligibility)
      if (record === undefined) {
        return { ok: false, reason: 'unavailable', detail: 'work-item-detail-unavailable' }
      }
      await this.putExact(this.options.intentTable, record.id, record, agentOperationIntentRecordSchema)
      return await this.resume(record.id, signal)
    })
  }

  /**
   * Persist or replay one Agent-requested Intervention before the tool returns.
   * @param request - exact calling Session, Tool Call, and operator question.
   * @param signal - caller cancellation before the durable write.
   * @returns stable request identity or a bounded rejection.
   */
  async requestIntervention(
    request: SakiAgentInterventionRequest,
    signal: AbortSignal,
  ): Promise<SakiAgentInterventionRequestResult> {
    signal.throwIfAborted()
    const runs = [...this.options.agentRunTable.entries()]
      .map(([, value]) => agentRunRecordSchema.parse(value))
      .filter(run => run.sessionId === request.sessionId)
    if (runs.length !== 1) return { ok: false, reason: 'unavailable' }
    const matchedRun = runs[0] as AgentRunRecord
    const interventionId = (
      `intervention-${derivedUuid(matchedRun.id, `intervention:${request.toolCallId}`)}`
    ) as SakiInterventionRequestId
    return await enqueueKeyedOperation(this.runInterventionTails, matchedRun.id, () => (
      enqueueKeyedOperation(this.interventionTails, interventionId, async () => {
        const run = this.requireRun(matchedRun.id)
        const existingValue = this.options.interventionTable.get(interventionId)
        if (existingValue !== undefined) {
          const existing = interventionRequestRecordSchema.parse(existingValue)
          return existing.state === 'opening'
          && existing.cause.agentRunId === run.id
          && existing.cause.workSessionId === run.workSessionId
          && existing.cause.sessionId === request.sessionId
          && existing.cause.toolCallId === request.toolCallId
          && existing.requiredAnswer.prompt === request.prompt
            ? { ok: true, interventionId }
            : { ok: false, reason: 'conflict' }
        }
        if (run.dispatchIds.length >= MAX_AGENT_RUN_DISPATCHES) {
          return { ok: false, reason: 'conflict' }
        }
        if (run.state !== 'starting' && run.state !== 'running' && run.state !== 'resume-pending') {
          return { ok: false, reason: 'conflict' }
        }
        const assignment = this.requireAssignment(run.assignmentId)
        const workSession = this.requireWorkSession(run.workSessionId)
        const origin = this.requireIntent(run.intentId)
        const initialDispatchId = run.dispatchIds[0] as SakiExecutionDispatchId
        const latestDispatchId = run.dispatchIds.at(-1) as SakiExecutionDispatchId
        const admissionValue = this.options.admissionTable.get(run.bindingId)
        if (admissionValue === undefined || workSession.state !== 'open' || assignment.agentRunId !== run.id
        || assignment.primaryWorkSessionId !== run.workSessionId) {
          return { ok: false, reason: 'unavailable' }
        }
        const initialDispatch = this.requireDispatch(initialDispatchId)
        const latestDispatch = this.requireDispatch(latestDispatchId)
        const admission = bindingWriteAdmissionRecordSchema.parse(admissionValue)
        const exactAcceptedOwner = admissionMatchesAgentOperation(admission, origin)
        && admission.phase === 'accepted'
        const acceptedInitialPublication = run.state === 'starting'
        && assignment.state === 'assigned'
        && origin.phase === 'dispatching'
        && run.dispatchIds.length === 1
        && initialDispatch.state === 'accepted'
        && dispatchMatchesIntent(initialDispatch, origin)
        const deliveredRun = run.state === 'running'
        && (((assignment.state === 'assigned' || assignment.state === 'active')
          && origin.phase === 'dispatching')
          || (assignment.state === 'active' && origin.phase === 'started'))
        && dispatchHasExactSucceededRun(latestDispatch, run)
        const interventions = [...this.options.interventionTable.entries()]
          .map(([, value]) => interventionRequestRecordSchema.parse(value))
        const predecessor = interventions.find((candidate): candidate is Extract<
          InterventionRequestRecord,
          { readonly state: 'answered' }
        > => candidate.state === 'answered'
        && candidate.owner.agentRunId === run.id
        && candidate.answer.dispatchId === latestDispatch.id)
        const acceptedAnswerPublication = predecessor !== undefined
        && assignment.state === 'active'
        && origin.phase === 'started'
        && latestDispatch.state === 'accepted'
        && isDeepStrictEqual(run.inputPlan, predecessor.answer.inputPlan)
        && interventionAnswerDispatchMatches(latestDispatch, predecessor, run)
        && ((run.state === 'resume-pending' && run.blockingInterventionId === predecessor.id)
          || (run.state === 'running' && run.blockingInterventionId === undefined
            && dispatchHasExactSucceededRun(latestDispatch, run)))
        if (!exactAcceptedOwner
        || (!acceptedInitialPublication && !deliveredRun && !acceptedAnswerPublication)) {
          return { ok: false, reason: 'unavailable' }
        }
        const ignoredPredecessorId = acceptedAnswerPublication
          ? predecessor.id
          : undefined
        const alreadyBlocking = interventions
          .some(candidate => candidate.owner.agentRunId === run.id
          && candidate.id !== ignoredPredecessorId
          && candidate.state !== 'resolved' && candidate.state !== 'reconciliation-required')
        if (alreadyBlocking) return { ok: false, reason: 'conflict' }
        const now = Date.now()
        const candidate = interventionRequestRecordSchema.safeParse({
          id: interventionId,
          schemaVersion: 1,
          revision: 0,
          kind: 'text-input',
          projectId: run.projectId,
          owner: { kind: 'agent-run', agentRunId: run.id, workSessionId: run.workSessionId },
          subject: { kind: 'agent-run', agentRunId: run.id },
          targetPrincipalId: assignment.ownerPrincipalId,
          requiredAnswer: {
            kind: 'text',
            prompt: request.prompt,
            maxLength: MAX_INTERVENTION_ANSWER_CHARS,
          },
          blockingScope: { kind: 'agent-run', agentRunId: run.id },
          cause: {
            kind: 'agent-request',
            agentRunId: run.id,
            workSessionId: run.workSessionId,
            sessionId: request.sessionId,
            toolCallId: request.toolCallId,
          },
          returnAddress: {
            kind: 'agent-run',
            projectId: run.projectId,
            workItemId: run.workItemId,
            workSessionId: run.workSessionId,
            agentRunId: run.id,
          },
          state: 'opening',
          createdAt: now,
          updatedAt: now,
        })
        if (!candidate.success) return { ok: false, reason: 'conflict' }
        await this.putExact(
          this.options.interventionTable,
          interventionId,
          candidate.data,
          interventionRequestRecordSchema,
        )
        return { ok: true, interventionId }
      })
    ))
  }

  /**
   * Advance one opening only after the exact successful tool result and its
   * completed turn are durable in the owning Session.
   * @param interventionId - durable request to inspect and recover.
   * @param signal - recovery lifetime and cancellation.
   * @param recovery - live handoff waits for the turn; startup classifies an abandoned partial turn.
   * @returns current opening outcome.
   */
  async finalizeInterventionOpening(
    interventionId: SakiInterventionRequestId,
    signal: AbortSignal,
    recovery: 'live' | 'startup' = 'live',
  ): Promise<'open' | 'pending' | 'reconciliation-required'> {
    return await enqueueKeyedOperation(this.interventionTails, interventionId, async () => {
      signal.throwIfAborted()
      const intervention = this.requireIntervention(interventionId)
      if (intervention.state === 'reconciliation-required') return 'reconciliation-required'
      if (intervention.state !== 'opening') return 'open'
      let run = this.requireRun(intervention.owner.agentRunId)
      const evidence: InterventionOpeningEvidence = await this.options.execution.inspectInterventionOpening({
        hostId: this.requireDispatch(run.dispatchIds[0] as SakiExecutionDispatchId).hostId,
        sessionId: intervention.cause.sessionId as StartAgentRunHostOperationRequest['run']['sessionId'],
        callId: intervention.cause.toolCallId,
        interventionId,
        expectedQuestion: intervention.requiredAnswer.prompt,
        expectedToolResult: {
          content: [{ type: 'text', text: JSON.stringify({ interventionId }) }],
        },
      }, signal)
      signal.throwIfAborted()
      if (evidence.kind === 'absent' || evidence.kind === 'pending') {
        if (recovery === 'live') return 'pending'
        await this.reconcileIntervention(
          intervention,
          evidence.kind === 'absent' ? 'protocol' : 'effect-unknown',
        )
        return 'reconciliation-required'
      }
      if (evidence.kind === 'conflict') {
        await this.reconcileIntervention(intervention, 'evidence-conflict')
        return 'reconciliation-required'
      }
      run = this.requireRun(intervention.owner.agentRunId)
      if (run.state === 'starting' || run.state === 'resume-pending') return 'pending'
      if (run.state === 'running') {
        const assignment = this.requireAssignment(run.assignmentId)
        const origin = this.requireIntent(run.intentId)
        const otherActive = [...this.options.interventionTable.entries()]
          .map(([, value]) => interventionRequestRecordSchema.parse(value))
          .some(candidate => candidate.id !== intervention.id
            && candidate.owner.agentRunId === run.id
            && candidate.state !== 'resolved' && candidate.state !== 'reconciliation-required')
        if ((assignment.state === 'assigned' || assignment.state === 'active')
          && origin.phase === 'dispatching') return 'pending'
        if (assignment.state !== 'active' || origin.phase !== 'started') {
          await this.reconcileIntervention(intervention, 'protocol')
          return 'reconciliation-required'
        }
        if (otherActive) return 'pending'
        run = await this.updateRun(run, {
          state: 'waiting',
          blockingInterventionId: intervention.id,
        })
      } else if (run.state !== 'waiting' || run.blockingInterventionId !== intervention.id) {
        await this.reconcileIntervention(intervention, 'protocol')
        return 'reconciliation-required'
      }
      const openedAt = Math.max(intervention.updatedAt, Date.now())
      await this.updateIntervention(intervention, { state: 'open', openedAt })
      this.options.notifyChanged()
      return 'open'
    })
  }

  private async finalizeRunOpenings(runId: SakiAgentRunId, signal: AbortSignal): Promise<void> {
    for (const interventionId of this.openingInterventionIdsForRun(runId)) {
      await this.finalizeInterventionOpening(interventionId, signal)
    }
  }

  private async reconcileRunOpenings(
    runId: SakiAgentRunId,
    reason: 'effect-unknown' | 'evidence-conflict' | 'protocol',
  ): Promise<void> {
    for (const interventionId of this.openingInterventionIdsForRun(runId)) {
      await enqueueKeyedOperation(this.interventionTails, interventionId, async () => {
        const current = this.requireIntervention(interventionId)
        if (current.state === 'opening') await this.reconcileIntervention(current, reason)
      })
    }
  }

  private openingInterventionIdsForRun(runId: SakiAgentRunId): SakiInterventionRequestId[] {
    return [...this.options.interventionTable.entries()]
      .map(([, value]) => interventionRequestRecordSchema.parse(value))
      .filter(intervention => intervention.state === 'opening'
        && intervention.owner.agentRunId === runId)
      .map(intervention => intervention.id)
      .sort()
  }

  /**
   * Accept or replay the first authorized expected-revision answer and deliver
   * it through a new Dispatch to the same Agent Run and Session.
   * @param intent - authority-free browser answer and expected request revision.
   * @param actor - trusted current Principal and Grant attribution.
   * @param signal - submission and delivery-attempt cancellation.
   * @returns durable answer acceptance, delivery, conflict, or recovery state.
   */
  async answerIntervention(
    intent: AnswerInterventionIntent,
    actor: ControlIntentActor,
    signal: AbortSignal,
  ): Promise<InterventionAnswerResult> {
    return await enqueueKeyedOperation(this.interventionTails, intent.interventionId, async () => {
      signal.throwIfAborted()
      let intervention = this.requireIntervention(intent.interventionId)
      if (hasInterventionAnswer(intervention)) {
        if (!isDeepStrictEqual(intervention.answer.payload.intent, intent)) {
          return answerConflict(intervention, intent, 'already-answered')
        }
        return await this.resumeInterventionAnswer(intervention, signal)
      }
      if (intervention.state !== 'open') {
        return answerConflict(intervention, intent, 'owner-unavailable')
      }
      if (intervention.revision !== intent.expectedInterventionRevision) {
        return answerConflict(intervention, intent, 'expected-revision')
      }
      if (intent.answer.text.length > intervention.requiredAnswer.maxLength) {
        return answerConflict(intervention, intent, 'invalid-answer')
      }
      if (actor.principalId !== intervention.targetPrincipalId
        || !this.options.authorityCurrent(actor, 'intervention:answer')) {
        return { ok: false, reason: 'denied' }
      }
      const owner = intervention.owner
      const run = this.requireRun(owner.agentRunId)
      const assignment = this.requireAssignment(run.assignmentId)
      const workSession = this.requireWorkSession(owner.workSessionId)
      const original = this.requireIntent(run.intentId)
      const admissionValue = this.options.admissionTable.get(run.bindingId)
      const admission = admissionValue === undefined
        ? undefined
        : bindingWriteAdmissionRecordSchema.parse(admissionValue)
      const currentBinding = this.options.projects.currentActiveBinding(run.projectId)
      if (run.state !== 'waiting' || run.blockingInterventionId !== intervention.id
        || run.workSessionId !== owner.workSessionId
        || assignment.ownerPrincipalId !== actor.principalId || assignment.state !== 'active'
        || workSession.state !== 'open'
        || admission === undefined || admission.state !== 'agent-run' || admission.phase !== 'accepted'
        || !admissionMatchesAgentOperation(admission, original)
        || typeof currentBinding === 'string'
        || currentBinding.binding.id !== run.bindingId
        || currentBinding.binding.revision !== admission.bindingRevision) {
        return answerConflict(intervention, intent, 'owner-unavailable')
      }
      signal.throwIfAborted()
      const input = interventionAnswerInput(intervention, intent, actor)
      const acceptedAt = Math.max(intervention.updatedAt, Date.now())
      try {
        intervention = await this.updateIntervention(intervention, {
          state: 'answered',
          answer: {
            receiptId: receiptId(intent.intentId),
            payloadDigest: canonicalDigest('saki/answer-intervention/v1', { intent, actor }),
            payload: { intent, actor },
            acceptedAt,
            dispatchId: input.source.dispatchId,
            inputPlan: {
              messageId: input.id,
              payloadDigest: computeStartAgentRunPayloadDigest(input),
            },
          },
        })
      } catch (error) {
        if (!(error instanceof RecordCasConflict)) throw error
        const winner = this.requireIntervention(intent.interventionId)
        if (hasInterventionAnswer(winner)
          && isDeepStrictEqual(winner.answer.payload.intent, intent)) {
          return await this.resumeInterventionAnswer(winner, signal)
        }
        return answerConflict(winner, intent, 'already-answered')
      }
      this.options.notifyChanged()
      return await this.resumeInterventionAnswer(intervention as AnsweredIntervention, signal)
    })
  }

  private async resumeInterventionAnswer(
    initial: AnswerBearingIntervention,
    signal: AbortSignal,
  ): Promise<InterventionAnswerResult> {
    let intervention = this.requireIntervention(initial.id) as AnswerBearingIntervention
    if (intervention.state === 'resolved') {
      await this.finalizeRunOpenings(intervention.owner.agentRunId, this.options.lifetime)
      return { ok: true, receipt: answerReceipt(intervention) }
    }
    if (intervention.state === 'reconciliation-required') {
      return { ok: false, reason: 'reconciliation-required', receipt: answerReceipt(intervention) }
    }
    const materialized = await this.materializeInterventionAnswer(intervention, signal)
    if (!materialized.ok) return materialized.result
    intervention = materialized.intervention
    const dispatch = materialized.dispatch
    if (dispatch.state === 'reconciliation-required') {
      return await this.reconcileInterventionAnswer(
        intervention,
        dispatch,
        dispatch.terminalReason === 'effect-unknown' || dispatch.terminalReason === 'evidence-conflict'
          ? dispatch.terminalReason
          : 'protocol',
      )
    }
    if (dispatch.state === 'canceled') {
      return await this.reconcileInterventionAnswer(intervention, dispatch, 'protocol')
    }
    if (dispatch.state !== 'accepted') {
      const claimed = await this.claim(dispatch)
      if (claimed === undefined) return answerUnavailable(intervention)
      const interrupted = await this.prepareAndAcceptInterventionAnswer(intervention, claimed, signal)
      if (interrupted !== undefined) return interrupted
      return await this.resumeInterventionAnswer(
        this.requireIntervention(intervention.id) as AnsweredIntervention,
        signal,
      )
    }
    return await this.driveAcceptedInterventionAnswer(intervention, dispatch, signal)
  }

  private async materializeInterventionAnswer(
    intervention: Extract<InterventionRequestRecord, { readonly state: 'answered' }>,
    signal: AbortSignal,
  ): Promise<
    | {
      readonly ok: true
      readonly intervention: Extract<InterventionRequestRecord, { readonly state: 'answered' }>
      readonly dispatch: ExecutionDispatchRecord
    }
    | { readonly ok: false; readonly result: InterventionAnswerResult }
  > {
    const { answer } = intervention
    let run = this.requireRun(intervention.owner.agentRunId)
    let dispatchValue = this.options.dispatchTable.get(answer.dispatchId)
    if (dispatchValue === undefined) {
      const waiting = run.state === 'waiting' && run.blockingInterventionId === intervention.id
      const alreadyResumePending = run.state === 'resume-pending'
        && run.blockingInterventionId === intervention.id
        && isDeepStrictEqual(run.inputPlan, answer.inputPlan)
        && run.dispatchIds.at(-1) === answer.dispatchId
      if (!waiting && !alreadyResumePending) {
        return { ok: false, result: await this.reconcileInterventionAnswer(intervention, undefined, 'protocol') }
      }
      const current = this.options.projects.currentActiveBinding(intervention.projectId)
      if (typeof current === 'string' || current.binding.id !== run.bindingId) {
        return { ok: false, result: await this.reconcileInterventionAnswer(intervention, undefined, 'protocol') }
      }
      let inspected: Awaited<ReturnType<SakiHostExecution['inspectProject']>>
      try {
        inspected = await this.options.execution.inspectProject({ binding: current.binding }, signal)
      } catch {
        signal.throwIfAborted()
        return { ok: false, result: answerUnavailable(intervention) }
      }
      signal.throwIfAborted()
      if (!inspected.ok) {
        return inspected.reason === 'unavailable'
          ? { ok: false, result: answerUnavailable(intervention) }
          : { ok: false, result: await this.reconcileInterventionAnswer(intervention, undefined, 'protocol') }
      }
      if (inspected.observation.index.kind !== 'tree'
        || inspected.preEffectBaseline.kind !== 'complete'
        || !inspected.observation.structuredMutation.available) {
        return { ok: false, result: answerUnavailable(intervention) }
      }
      const input = interventionAnswerInput(
        intervention,
        answer.payload.intent,
        answer.payload.actor,
      )
      if (input.id !== answer.inputPlan.messageId
        || computeStartAgentRunPayloadDigest(input) !== answer.inputPlan.payloadDigest) {
        return { ok: false, result: await this.reconcileInterventionAnswer(intervention, undefined, 'evidence-conflict') }
      }
      const request: StartAgentRunHostOperationRequest = {
        type: 'start-agent-run',
        source: {
          kind: 'execution-dispatch',
          dispatchId: answer.dispatchId,
          payloadDigest: answer.inputPlan.payloadDigest,
        },
        expected: {
          binding: current.binding,
          status: inspected.observation.fingerprint,
          head: inspected.observation.head,
          index: inspected.observation.index,
          worktree: inspected.observation.worktree,
          preEffectBaseline: inspected.preEffectBaseline,
        },
        run: {
          agentRunId: run.id,
          workSessionId: run.workSessionId,
          sessionId: run.sessionId as StartAgentRunHostOperationRequest['run']['sessionId'],
          profile: run.profile,
          input,
        },
      }
      const now = Date.now()
      const dispatch = executionDispatchRecordSchema.parse({
        id: answer.dispatchId,
        schemaVersion: 1,
        revision: 0,
        intentId: answer.payload.intent.intentId,
        agentRunId: run.id,
        workSessionId: run.workSessionId,
        hostId: current.binding.hostId,
        bindingId: run.bindingId,
        payloadDigest: answer.inputPlan.payloadDigest,
        hostRequest: request,
        state: 'pending',
        latestFencingToken: 0,
        createdAt: now,
        updatedAt: now,
      })
      if (waiting) {
        run = await this.updateRun(run, {
          state: 'resume-pending',
          inputPlan: answer.inputPlan,
          dispatchIds: [...run.dispatchIds, answer.dispatchId],
          hostResult: undefined,
        })
      }
      await this.putExact(this.options.dispatchTable, dispatch.id, dispatch, executionDispatchRecordSchema)
      dispatchValue = dispatch
    }
    const dispatch = executionDispatchRecordSchema.parse(dispatchValue)
    if (!interventionAnswerDispatchMatches(dispatch, intervention, run)) {
      return { ok: false, result: await this.reconcileInterventionAnswer(intervention, dispatch, 'evidence-conflict') }
    }
    const deliveredPrefix = run.state === 'running'
      && run.blockingInterventionId === undefined
      && isDeepStrictEqual(run.inputPlan, answer.inputPlan)
      && run.dispatchIds.at(-1) === answer.dispatchId
      && dispatchHasExactSucceededRun(dispatch, run)
    const reconciliationPrefix = interventionAnswerReconciliationPrefixMatches(dispatch, intervention, run)
    if (!deliveredPrefix && !reconciliationPrefix && (run.state !== 'resume-pending'
      || run.blockingInterventionId !== intervention.id
      || !isDeepStrictEqual(run.inputPlan, answer.inputPlan)
      || run.dispatchIds.at(-1) !== answer.dispatchId)) {
      return { ok: false, result: await this.reconcileInterventionAnswer(intervention, dispatch, 'protocol') }
    }
    return { ok: true, intervention, dispatch }
  }

  private async prepareAndAcceptInterventionAnswer(
    intervention: Extract<InterventionRequestRecord, { readonly state: 'answered' }>,
    claimed: ClaimedExecutionDispatch,
    signal: AbortSignal,
  ): Promise<InterventionAnswerResult | undefined> {
    const prepared = await this.options.execution.prepareOperation<'start-agent-run'>(
      claimed.hostRequest,
      this.admitOperation,
      signal,
    )
    signal.throwIfAborted()
    if (!prepared.ok) {
      return prepared.reason === 'unavailable'
        ? answerUnavailable(intervention)
        : await this.reconcileInterventionAnswer(intervention, claimed, 'protocol')
    }
    assertDispatchPrepared(claimed, prepared.preparation, prepared.snapshot)
    if (prepared.snapshot.state !== 'prepared') {
      return await this.reconcileInterventionAnswer(intervention, claimed, 'protocol')
    }
    const currentValue = this.options.dispatchTable.get(claimed.id)
    if (currentValue === undefined) return answerUnavailable(intervention)
    const current = executionDispatchRecordSchema.parse(currentValue)
    if (!sameDispatchClaimOwner(current, claimed)) return answerUnavailable(intervention)
    let dispatch: ExecutionDispatchRecord
    try {
      dispatch = await this.updateDispatch(claimed, {
        preparation: prepared.preparation,
        operationSnapshot: prepared.snapshot,
      })
    } catch (error) {
      if (error instanceof RecordCasConflict) return answerUnavailable(intervention)
      throw error
    }
    const retainedClaim = dispatch as ClaimedExecutionDispatch
    if (retainedClaim.claim.expiresAt <= Date.now()) return answerUnavailable(intervention)
    if (this.currentInterventionAnswerAdmission(intervention, retainedClaim) === undefined) {
      return await this.reconcileInterventionAnswer(intervention, retainedClaim, 'protocol')
    }
    const accepted = await this.acceptClaimedDispatch(
      retainedClaim,
      prepared.preparation,
      prepared.snapshot,
      current => this.currentInterventionAnswerAdmission(intervention, current) !== undefined,
    )
    return accepted === undefined ? answerUnavailable(intervention) : undefined
  }

  private async acceptClaimedDispatch(
    claimed: ClaimedExecutionDispatch,
    preparation: HostOperationPreparation<'start-agent-run'>,
    snapshot: HostOperationSnapshot<'start-agent-run'>,
    claimRemainsAdmissible: (current: ClaimedExecutionDispatch) => boolean,
  ): Promise<ExecutionDispatchRecord | undefined> {
    try {
      return await this.options.dispatchTable.update(claimed.id, (value) => {
        const current = executionDispatchRecordSchema.parse(value)
        if (!sameDispatchClaim(current, claimed) || current.claim.expiresAt <= Date.now()
          || !claimRemainsAdmissible(current)) {
          throw new DispatchClaimLost()
        }
        return executionDispatchRecordSchema.parse(Object.fromEntries(Object.entries({
          ...current,
          revision: current.revision + 1,
          state: 'accepted',
          claim: undefined,
          acceptedFencingToken: claimed.claim.fencingToken,
          preparation,
          operationSnapshot: snapshot,
          updatedAt: Math.max(current.updatedAt, Date.now()),
        }).filter(([, value]) => value !== undefined)))
      })
    } catch (error) {
      const replayValue = this.options.dispatchTable.get(claimed.id)
      if (replayValue !== undefined) {
        const replay = executionDispatchRecordSchema.parse(replayValue)
        if (replay.revision === claimed.revision + 1
          && replay.state === 'accepted'
          && replay.acceptedFencingToken === claimed.claim.fencingToken
          && isDeepStrictEqual(replay.preparation, preparation)
          && isDeepStrictEqual(replay.operationSnapshot, snapshot)) return replay
      }
      if (error instanceof DispatchClaimLost) return undefined
      throw error
    }
  }

  private currentInterventionAnswerAdmission(
    intervention: Extract<InterventionRequestRecord, { readonly state: 'answered' }>,
    dispatch: ExecutionDispatchRecord,
  ): Extract<BindingWriteAdmissionRecord, { readonly state: 'agent-run' }> | undefined {
    const parsedRun = this.requireRun(intervention.owner.agentRunId)
    const assignment = this.requireAssignment(parsedRun.assignmentId)
    const origin = this.requireIntent(parsedRun.intentId)
    const admission = bindingWriteAdmissionRecordSchema.parse(this.options.admissionTable.get(parsedRun.bindingId))
    const actor = intervention.answer.payload.actor
    const current = this.options.projects.currentActiveBinding(intervention.projectId)
    return parsedRun.state === 'resume-pending'
      && parsedRun.blockingInterventionId === intervention.id
      && parsedRun.dispatchIds.at(-1) === dispatch.id
      && isDeepStrictEqual(parsedRun.inputPlan, intervention.answer.inputPlan)
      && assignment.state === 'active'
      && assignment.ownerPrincipalId === intervention.targetPrincipalId
      && actor.principalId === intervention.targetPrincipalId
      && this.options.authorityCurrent(actor, 'intervention:answer')
      && interventionAnswerDispatchMatches(dispatch, intervention, parsedRun)
      && admissionMatchesAgentOperation(admission, origin)
      && admission.phase === 'accepted'
      && typeof current !== 'string'
      && current.binding.id === parsedRun.bindingId
      && current.binding.revision === admission.bindingRevision
      && isDeepStrictEqual(current.binding, dispatch.hostRequest.expected.binding)
      ? admission
      : undefined
  }

  private async driveAcceptedInterventionAnswer(
    intervention: Extract<InterventionRequestRecord, { readonly state: 'answered' }>,
    dispatch: ExecutionDispatchRecord,
    signal: AbortSignal,
  ): Promise<InterventionAnswerResult> {
    const preparation = dispatch.preparation as NonNullable<ExecutionDispatchRecord['preparation']>
    let inspected = await this.options.execution.inspectOperation(preparation.operation, signal)
    signal.throwIfAborted()
    assertDispatchSnapshot(dispatch, inspected)
    const inspectedResult = await this.resolveInterventionAnswerSnapshot(intervention, dispatch, inspected)
    if (inspectedResult !== undefined) return inspectedResult
    dispatch = await this.updateDispatch(dispatch, { operationSnapshot: inspected })
    const replay = await this.options.execution.prepareOperation<'start-agent-run'>(
      dispatch.hostRequest,
      this.admitOperation,
      signal,
    )
    signal.throwIfAborted()
    if (!replay.ok) {
      return replay.reason === 'unavailable'
        ? answerUnavailable(intervention)
        : await this.reconcileInterventionAnswer(intervention, dispatch, 'protocol')
    }
    assertDispatchPrepared(dispatch, replay.preparation, replay.snapshot)
    const started = await this.options.execution.startOperation(replay.preparation.operation, replay.acceptance, signal)
    signal.throwIfAborted()
    assertDispatchSnapshot(dispatch, started.snapshot)
    inspected = started.snapshot
    dispatch = await this.updateDispatch(dispatch, { operationSnapshot: inspected })
    return await this.resolveInterventionAnswerSnapshot(intervention, dispatch, inspected)
      ?? answerUnavailable(intervention)
  }

  private async resolveInterventionAnswerSnapshot(
    intervention: Extract<InterventionRequestRecord, { readonly state: 'answered' }>,
    dispatch: ExecutionDispatchRecord,
    snapshot: HostOperationSnapshot<'start-agent-run'>,
  ): Promise<InterventionAnswerResult | undefined> {
    if (snapshot.state === 'succeeded') {
      return await this.finishInterventionAnswer(intervention, dispatch, snapshot.result, snapshot)
    }
    if (snapshot.state === 'reconciliation-required') {
      return await this.reconcileInterventionAnswer(intervention, dispatch, snapshot.reason)
    }
    if (snapshot.state === 'failed' || snapshot.state === 'canceled') {
      return await this.reconcileInterventionAnswer(intervention, dispatch, 'protocol')
    }
    return undefined
  }

  private async finishInterventionAnswer(
    intervention: Extract<InterventionRequestRecord, { readonly state: 'answered' }>,
    dispatch: ExecutionDispatchRecord,
    result: StartAgentRunHostOperationResult,
    snapshot: HostOperationSnapshot<'start-agent-run'>,
  ): Promise<InterventionAnswerResult> {
    if (result.agentRunId !== intervention.owner.agentRunId
      || result.workSessionId !== intervention.owner.workSessionId
      || result.sessionId !== dispatch.hostRequest.run.sessionId
      || result.inputMessageId !== intervention.answer.inputPlan.messageId) {
      return await this.reconcileInterventionAnswer(intervention, dispatch, 'evidence-conflict')
    }
    if (!isDeepStrictEqual(dispatch.operationSnapshot, snapshot)) {
      dispatch = await this.updateDispatch(dispatch, { operationSnapshot: snapshot })
    }
    let run = this.requireRun(intervention.owner.agentRunId)
    if (run.state === 'resume-pending') {
      run = await this.updateRun(run, {
        state: 'running',
        blockingInterventionId: undefined,
        hostResult: result,
      })
    }
    const resolvedAt = Math.max(intervention.updatedAt, Date.now())
    const resolved = await this.updateIntervention(intervention, { state: 'resolved', resolvedAt }) as ResolvedIntervention
    await this.finalizeRunOpenings(run.id, this.options.lifetime)
    this.options.notifyChanged()
    return { ok: true, receipt: answerReceipt(resolved) }
  }

  private async reconcileInterventionAnswer(
    intervention: Extract<InterventionRequestRecord, { readonly state: 'answered' }>,
    dispatch: ExecutionDispatchRecord | undefined,
    reason: 'effect-unknown' | 'evidence-conflict' | 'protocol',
  ): Promise<InterventionAnswerResult> {
    await this.reconcileRunOpenings(intervention.owner.agentRunId, reason)
    if (dispatch !== undefined && dispatch.state !== 'reconciliation-required') {
      await this.updateDispatch(dispatch, {
        state: 'reconciliation-required',
        claim: undefined,
        terminalReason: reason,
      })
    }
    const run = this.requireRun(intervention.owner.agentRunId)
    if (run.state === 'resume-pending') {
      await this.updateRun(run, { state: 'reconciliation-required' })
    }
    const reconciled = await this.reconcileIntervention(intervention, reason) as ReconciledAnsweredIntervention
    return { ok: false, reason: 'reconciliation-required', receipt: answerReceipt(reconciled) }
  }

  private async resolveEligibility(
    intent: GiveWorkItemToAgentIntent,
    signal: AbortSignal,
  ): Promise<
    | { readonly ok: false; readonly result: AgentResult }
    | {
      readonly ok: true
      readonly project: DevelopmentProjectRegistryRecord['projects'][number]
      readonly profile: AgentProfileRecord & { readonly modelRouteRequest: NonNullable<AgentProfileRecord['modelRouteRequest']> }
      readonly item: SakiBoardWorkItemProjection
      readonly detail: GitHubIssueDetailFact
      readonly definition: ParsedDefinition
      readonly binding: ReturnType<DevelopmentProjects['currentActiveBinding']> & object
      readonly inspected: Extract<Awaited<ReturnType<SakiHostExecution['inspectProject']>>, { readonly ok: true }>
      readonly branchName: string
    }
  > {
    const registry = this.options.projects.registry()
    const project = registry.projects.find(candidate => candidate.id === intent.projectId)
    if (project === undefined || project.revision !== intent.expectedProjectRevision) {
      return { ok: false, result: conflict(intent, 'expected-revision') }
    }
    const profile = registry.agentProfiles.find(candidate => candidate.id === project.defaultAgentProfileId)
    if (profile === undefined) {
      return { ok: false, result: { ok: false, reason: 'unavailable', detail: 'agent-profile-unavailable' } }
    }
    const modelRouteRequest = profile.modelRouteRequest
    if (modelRouteRequest === null) {
      return { ok: false, result: { ok: false, reason: 'unavailable', detail: 'model-route-unavailable' } }
    }
    const resolvedProfile = { ...profile, modelRouteRequest }
    const mutation = this.options.mutationContext(intent.projectId)
    if (!mutation.ok) {
      return { ok: false, result: { ok: false, reason: 'unavailable', detail: 'work-item-detail-unavailable' } }
    }
    const item = mutation.context.confirmedBoard.items.find(candidate => candidate.id === intent.workItemId)
    if (item === undefined || item.remoteFingerprint !== intent.expectedRemoteFingerprint) {
      return { ok: false, result: conflict(intent, 'stale-remote') }
    }
    if (item.status !== 'ready' || item.issueState !== 'open' || item.archived || item.notInProject) {
      return { ok: false, result: conflict(intent, 'work-item-not-ready') }
    }
    const binding = this.options.projects.currentActiveBinding(intent.projectId)
    if (typeof binding === 'string' || binding.projectRevision !== intent.expectedProjectRevision) {
      return { ok: false, result: conflict(intent, 'binding-unavailable') }
    }
    const admissionValue = this.options.admissionTable.get(binding.binding.id)
    if (admissionValue === undefined) {
      return { ok: false, result: conflict(intent, 'binding-unavailable') }
    }
    if (bindingWriteAdmissionRecordSchema.parse(admissionValue).state !== 'available') {
      return { ok: false, result: conflict(intent, 'writable-run-active') }
    }
    const inspected = await this.options.execution.inspectProject({ binding: binding.binding }, signal)
    signal.throwIfAborted()
    if (!inspected.ok) {
      return inspected.reason === 'unavailable'
        ? { ok: false, result: { ok: false, reason: 'unavailable', detail: 'host-unavailable' } }
        : { ok: false, result: conflict(intent, 'binding-unavailable') }
    }
    if (inspected.preEffectBaseline.kind !== 'complete'
      || !inspected.observation.structuredMutation.available
      || inspected.observation.index.kind !== 'tree') {
      return { ok: false, result: conflict(intent, 'inherited-changes-unsafe') }
    }
    if (inspected.observation.branch.kind !== 'attached') {
      return { ok: false, result: conflict(intent, 'binding-unavailable') }
    }
    const github = this.github
    if (github === undefined) {
      return { ok: false, result: { ok: false, reason: 'unavailable', detail: 'work-item-detail-unavailable' } }
    }
    const installation = {
      appId: mutation.context.configuration.appId,
      installationId: mutation.context.configuration.githubInstallationId,
      accountId: mutation.context.configuration.accountNodeId,
      privateKeyRef: mutation.context.configuration.credentialRef,
    }
    let detail: GitHubIssueDetailFact
    try {
      detail = await github.read<'issue-detail'>({
        kind: 'issue-detail',
        installation,
        repositoryId: mutation.context.configuration.repositoryNodeId,
        repositoryDatabaseId: mutation.context.configuration.repositoryDatabaseId,
        issueId: item.source.issueId,
      }, signal)
    } catch {
      signal.throwIfAborted()
      return { ok: false, result: { ok: false, reason: 'unavailable', detail: 'work-item-detail-unavailable' } }
    }
    signal.throwIfAborted()
    if (detail.id !== item.source.issueId
      || detail.repositoryId !== mutation.context.configuration.repositoryNodeId
      || detail.repositoryDatabaseId !== mutation.context.configuration.repositoryDatabaseId
      || detail.number !== item.issueNumber
      || detail.title !== item.title
      || detail.url !== item.url
      || detail.state !== item.issueState
      || detail.updatedAt > item.updatedAt) {
      return { ok: false, result: conflict(intent, 'stale-remote') }
    }
    const definition = parseDefinition(detail.body)
    if (definition.acceptanceCriteria.length === 0) {
      return { ok: false, result: conflict(intent, 'acceptance-criteria-missing') }
    }
    if (definition.blockage.length > 0) {
      return { ok: false, result: conflict(intent, 'work-item-blocked') }
    }
    let branch: GitHubBranchSafetyFact
    try {
      branch = await github.read<'branch-safety'>({
        kind: 'branch-safety',
        installation,
        repositoryId: mutation.context.configuration.repositoryNodeId,
        repositoryDatabaseId: mutation.context.configuration.repositoryDatabaseId,
        branch: inspected.observation.branch.name,
      }, signal)
    } catch {
      signal.throwIfAborted()
      return { ok: false, result: { ok: false, reason: 'unavailable', detail: 'branch-safety-unavailable' } }
    }
    signal.throwIfAborted()
    if (branch.kind === 'protected') return { ok: false, result: conflict(intent, 'branch-protected') }
    if (branch.kind === 'legacy-protection-unknown') {
      return { ok: false, result: conflict(intent, 'legacy-protection-unknown') }
    }
    return {
      ok: true,
      project,
      profile: resolvedProfile,
      item,
      detail,
      definition,
      binding,
      inspected,
      branchName: inspected.observation.branch.name,
    }
  }

  private buildIntent(
    intent: GiveWorkItemToAgentIntent,
    actor: ControlIntentActor,
    eligible: Extract<Awaited<ReturnType<AgentOperations['resolveEligibility']>>, { readonly ok: true }>,
  ): AgentOperationIntentRecord | undefined {
    const ids = childIds(intent)
    const profile = {
      id: eligible.profile.id,
      version: eligible.profile.version,
      agentPresetId: eligible.profile.agentPresetId,
      modelRoute: eligible.profile.modelRouteRequest,
    }
    const input: StartAgentRunInputMessage = {
      id: ids.messageId,
      role: 'user' as const,
      content: [{
        type: 'text' as const,
        text: renderRunInput({
          projectTitle: eligible.project.projectTitle,
          item: eligible.item,
          detail: eligible.detail,
          definition: eligible.definition,
          profile,
          branch: eligible.branchName,
        }),
      }],
      source: {
        kind: 'saki-agent-run' as const,
        dispatchId: ids.dispatchId,
        agentRunId: ids.agentRunId,
        workSessionId: ids.workSessionId,
      },
    }
    const runPayloadDigest = computeStartAgentRunPayloadDigest(input)
    const hostRequest = {
      type: 'start-agent-run',
      source: { kind: 'execution-dispatch', dispatchId: ids.dispatchId, payloadDigest: runPayloadDigest },
      expected: {
        binding: eligible.binding.binding,
        status: eligible.inspected.observation.fingerprint,
        head: eligible.inspected.observation.head,
        index: eligible.inspected.observation.index,
        worktree: eligible.inspected.observation.worktree,
        preEffectBaseline: eligible.inspected.preEffectBaseline,
      },
      run: {
        agentRunId: ids.agentRunId,
        workSessionId: ids.workSessionId,
        sessionId: ids.sessionId,
        profile,
        input,
      },
    } as const
    const payload = { intent, actor }
    const now = Date.now()
    const workItemDefinition = {
      repositoryId: eligible.detail.repositoryId,
      repositoryDatabaseId: eligible.detail.repositoryDatabaseId,
      issueId: eligible.detail.id,
      issueNumber: eligible.detail.number,
      issueState: eligible.detail.state,
      title: eligible.detail.title,
      url: eligible.detail.url,
      body: eligible.detail.body,
      updatedAt: eligible.detail.updatedAt,
      remoteFingerprint: intent.expectedRemoteFingerprint,
      intendedOutcome: eligible.definition.intendedOutcome,
      acceptanceCriteria: eligible.definition.acceptanceCriteria,
      blockage: eligible.definition.blockage,
    }
    const projectContext = {
      projectId: eligible.project.id,
      projectRevision: eligible.project.revision,
      projectTitle: eligible.project.projectTitle,
      resourceBindingId: eligible.binding.binding.id,
      bindingRevision: eligible.binding.binding.revision,
    }
    const candidate = agentOperationIntentRecordSchema.safeParse({
      id: intent.intentId,
      schemaVersion: 1,
      revision: 0,
      receiptId: receiptId(intent.intentId),
      payloadDigest: canonicalDigest('saki/agent-operation-intent/v1', payload),
      payload,
      phase: 'prepared',
      assignmentId: ids.assignmentId,
      workSessionId: ids.workSessionId,
      agentRunId: ids.agentRunId,
      dispatchId: ids.dispatchId,
      inProgressIntentId: ids.inProgressIntentId,
      workItemDefinition,
      projectContext,
      profile,
      contextDigest: canonicalDigest('saki/agent-operation-context/v1', {
        workItemDefinition,
        projectContext,
        profile,
      }),
      hostRequest,
      createdAt: now,
      updatedAt: now,
    })
    return candidate.success ? candidate.data : undefined
  }

  private async resume(intentId: SakiControlIntentId, signal: AbortSignal): Promise<AgentResult> {
    while (true) {
      signal.throwIfAborted()
      let record = this.requireIntent(intentId)
      if (terminal(record.phase)) {
        if (record.phase === 'started') {
          await this.finalizeRunOpenings(record.agentRunId, this.options.lifetime)
        }
        return resultFor(record)
      }
      await this.materializeChildren(record)
      record = this.requireIntent(intentId)
      const dispatch = this.requireDispatch(record.dispatchId)
      const recoveredTerminal = await this.recoverTerminalPrefix(record, dispatch)
      if (recoveredTerminal !== undefined) return recoveredTerminal
      if (!this.options.authorityCurrent(record.payload.actor, 'work-item:give-to-agent')) {
        return await this.cancelForRevocation(record, signal)
      }
      if (record.phase === 'prepared') {
        try {
          await this.reserve(record)
        } catch (error) {
          if (error instanceof AdmissionBusy || error instanceof AdmissionUnavailable) return unavailable(record)
          throw error
        }
        record = await this.updateIntent(record, { phase: 'admission-reserved' })
      }
      if (dispatch.state !== 'accepted') {
        const claimed = await this.claim(dispatch)
        if (claimed === undefined) return unavailable(record)
        if (record.phase !== 'dispatching') record = await this.updateIntent(record, { phase: 'dispatching' })
        const admitted = await this.prepareAndAccept(record, claimed, signal)
        if (!admitted.ok) return admitted.result
        continue
      }
      return await this.driveAccepted(record, dispatch, signal)
    }
  }

  private async materializeChildren(record: AgentOperationIntentRecord): Promise<void> {
    const now = record.createdAt
    const request = record.hostRequest
    const assignment = workAssignmentRecordSchema.parse({
      id: record.assignmentId,
      schemaVersion: 2,
      revision: 0,
      intentId: record.id,
      projectId: record.payload.intent.projectId,
      workItemId: record.payload.intent.workItemId,
      ownerPrincipalId: record.payload.actor.principalId,
      primaryWorkSessionId: record.workSessionId,
      agentRunId: record.agentRunId,
      state: 'assigned',
      createdAt: now,
      updatedAt: now,
    })
    const session = workSessionRecordSchema.parse({
      id: record.workSessionId,
      schemaVersion: 1,
      revision: 0,
      intentId: record.id,
      assignmentId: record.assignmentId,
      projectId: record.payload.intent.projectId,
      workItemId: record.payload.intent.workItemId,
      primary: true,
      agentRunIds: [record.agentRunId],
      state: 'open',
      createdAt: now,
      updatedAt: now,
    })
    const run = agentRunRecordSchema.parse({
      id: record.agentRunId,
      schemaVersion: 2,
      revision: 0,
      intentId: record.id,
      assignmentId: record.assignmentId,
      workSessionId: record.workSessionId,
      projectId: record.payload.intent.projectId,
      workItemId: record.payload.intent.workItemId,
      bindingId: record.projectContext.resourceBindingId,
      profile: record.profile,
      sessionId: request.run.sessionId,
      inputPlan: { messageId: request.run.input.id, payloadDigest: request.source.payloadDigest },
      dispatchIds: [record.dispatchId],
      state: 'allocated',
      createdAt: now,
      updatedAt: now,
    })
    const dispatch = executionDispatchRecordSchema.parse({
      id: record.dispatchId,
      schemaVersion: 1,
      revision: 0,
      intentId: record.id,
      agentRunId: record.agentRunId,
      workSessionId: record.workSessionId,
      hostId: request.expected.binding.hostId,
      bindingId: record.projectContext.resourceBindingId,
      payloadDigest: request.source.payloadDigest,
      hostRequest: request,
      state: 'pending',
      latestFencingToken: 0,
      createdAt: now,
      updatedAt: now,
    })
    await this.putInitial(
      this.options.assignmentTable,
      assignment.id,
      assignment,
      workAssignmentRecordSchema,
      ['revision', 'state', 'updatedAt'],
    )
    await this.putInitial(
      this.options.workSessionTable,
      session.id,
      session,
      workSessionRecordSchema,
      ['revision', 'state', 'updatedAt'],
    )
    await this.putInitial(
      this.options.agentRunTable,
      run.id,
      run,
      agentRunRecordSchema,
      ['revision', 'state', 'hostResult', 'blockingInterventionId', 'inputPlan', 'dispatchIds', 'updatedAt'],
    )
    await this.putInitial(
      this.options.dispatchTable,
      dispatch.id,
      dispatch,
      executionDispatchRecordSchema,
      [
        'revision',
        'state',
        'latestFencingToken',
        'claim',
        'acceptedFencingToken',
        'preparation',
        'operationSnapshot',
        'terminalReason',
        'updatedAt',
      ],
    )
  }

  private async reserve(
    record: AgentOperationIntentRecord,
  ): Promise<Extract<BindingWriteAdmissionRecord, { readonly state: 'agent-run' }>> {
    return await enqueueKeyedOperation(this.bindingTails, record.projectContext.resourceBindingId, async () => {
      const bindingId = record.projectContext.resourceBindingId
      const value = this.options.admissionTable.get(bindingId)
      if (value === undefined) throw new AdmissionUnavailable()
      try {
        const next = await this.options.admissionTable.update(bindingId, (currentValue) => {
          const current = bindingWriteAdmissionRecordSchema.parse(currentValue)
          if (current.state === 'agent-run') {
            if (admissionMatchesAgentOperation(current, record)) return current
            throw new AdmissionBusy()
          }
          if (current.state === 'manual-host-operation') throw new AdmissionBusy()
          const now = Math.max(current.updatedAt, Date.now())
          return bindingWriteAdmissionRecordSchema.parse({
            id: bindingId,
            schemaVersion: 1,
            revision: current.revision + 1,
            state: 'agent-run',
            phase: 'reserved',
            bindingRevision: record.projectContext.bindingRevision,
            originIntentId: record.id,
            agentRunId: record.agentRunId,
            payloadDigest: record.hostRequest.source.payloadDigest,
            reservedAt: now,
            updatedAt: now,
          })
        })
        return next as Extract<BindingWriteAdmissionRecord, { readonly state: 'agent-run' }>
      } catch (error) {
        if (error instanceof AdmissionBusy || error instanceof AdmissionUnavailable) throw error
        const replay = this.options.admissionTable.get(bindingId)
        /* v8 ignore else -- an active Binding admission row is provisioned once and has no deletion path. */
        if (replay !== undefined) {
          const parsed = bindingWriteAdmissionRecordSchema.parse(replay)
          if (admissionMatchesAgentOperation(parsed, record)) return parsed
        }
        throw error
      }
    })
  }

  private async claim(dispatch: ExecutionDispatchRecord): Promise<ClaimedExecutionDispatch | undefined> {
    const now = Date.now()
    if (dispatch.state === 'claimed') {
      const claimed = dispatch as ClaimedExecutionDispatch
      const { claim } = claimed
      if (claim.expiresAt > now) {
        return claim.executorHostId === dispatch.hostId
          ? await this.renewClaim(claimed, now)
          : undefined
      }
    }
    const token = dispatch.latestFencingToken + 1
    const claimed = await this.updateDispatch(dispatch, {
      state: 'claimed',
      latestFencingToken: token,
      claim: {
        id: `dispatch-claim-${randomUUID()}` as SakiDispatchClaimId,
        executorHostId: dispatch.hostId,
        fencingToken: token,
        issuedAt: now,
        expiresAt: now + this.options.claimTtlMs,
      },
    })
    return claimed as ClaimedExecutionDispatch
  }

  private async renewClaim(
    claimed: ClaimedExecutionDispatch,
    now: number,
  ): Promise<ClaimedExecutionDispatch | undefined> {
    const expiresAt = now + this.options.claimTtlMs
    if (expiresAt <= claimed.claim.expiresAt) return claimed
    try {
      const renewed = await this.options.dispatchTable.update(claimed.id, (value) => {
        const current = executionDispatchRecordSchema.parse(value)
        if (!sameDispatchClaim(current, claimed) || current.claim.expiresAt <= now) {
          throw new DispatchClaimLost()
        }
        return executionDispatchRecordSchema.parse({
          ...current,
          revision: current.revision + 1,
          claim: { ...current.claim, expiresAt },
          updatedAt: Math.max(current.updatedAt, now),
        })
      })
      return renewed as ClaimedExecutionDispatch
    } catch (error) {
      const replayValue = this.options.dispatchTable.get(claimed.id)
      /* v8 ignore else -- an owned Execution Dispatch is never deleted during claim renewal. */
      if (replayValue !== undefined) {
        const replay = executionDispatchRecordSchema.parse(replayValue)
        if (replay.revision === claimed.revision + 1
          && replay.state === 'claimed'
          && replay.claim !== undefined
          && replay.claim.id === claimed.claim.id
          && replay.claim.executorHostId === claimed.claim.executorHostId
          && replay.claim.fencingToken === claimed.claim.fencingToken
          && replay.claim.issuedAt === claimed.claim.issuedAt
          && replay.claim.expiresAt === expiresAt) return replay as ClaimedExecutionDispatch
      }
      if (error instanceof DispatchClaimLost) return undefined
      throw error
    }
  }

  private async prepareExactHostOperation(
    record: AgentOperationIntentRecord,
    signal: AbortSignal,
  ): Promise<HostOperationReceipt<'start-agent-run'>> {
    const prepared = await this.options.execution.prepareOperation<'start-agent-run'>(
      record.hostRequest,
      this.admitOperation,
      signal,
    )
    signal.throwIfAborted()
    if (prepared.ok) assertPrepared(record, prepared.preparation, prepared.snapshot)
    return prepared
  }

  private async prepareAndAccept(
    record: AgentOperationIntentRecord,
    claimed: ClaimedExecutionDispatch,
    signal: AbortSignal,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly result: AgentResult }> {
    const prepared = await this.prepareExactHostOperation(record, signal)
    if (!prepared.ok) {
      if (prepared.reason === 'unavailable') return { ok: false, result: unavailable(record) }
      await this.acceptAdmission(record)
      const reconciled = await this.reconcile(record, 'protocol')
      return { ok: false, result: resultFor(reconciled) }
    }
    assertSnapshot(record, prepared.snapshot)
    if (prepared.snapshot.state !== 'prepared') {
      await this.acceptAdmission(record)
      const reconciled = await this.reconcile(record, 'protocol')
      return { ok: false, result: resultFor(reconciled) }
    }
    const currentValue = this.options.dispatchTable.get(claimed.id)
    if (currentValue === undefined) return { ok: false, result: unavailable(record) }
    const current = executionDispatchRecordSchema.parse(currentValue)
    if (!sameDispatchClaimOwner(current, claimed)) return { ok: false, result: unavailable(record) }
    let dispatch: ExecutionDispatchRecord
    try {
      dispatch = await this.updateDispatch(claimed, {
        preparation: prepared.preparation,
        operationSnapshot: prepared.snapshot,
      })
    } catch (error) {
      const replay = this.options.dispatchTable.get(claimed.id)
      if (replay === undefined || !sameDispatchClaimOwner(executionDispatchRecordSchema.parse(replay), claimed)) {
        return { ok: false, result: unavailable(record) }
      }
      throw error
    }
    const retainedClaim = dispatch as ClaimedExecutionDispatch
    const acceptedCandidate = this.options.dispatchTable.get(dispatch.id)
    if (acceptedCandidate === undefined) return { ok: false, result: unavailable(record) }
    const currentCandidate = executionDispatchRecordSchema.parse(acceptedCandidate)
    if (!sameDispatchClaim(currentCandidate, retainedClaim) || currentCandidate.claim.expiresAt <= Date.now()) {
      return { ok: false, result: unavailable(record) }
    }
    if (!this.acceptanceAuthorityIsCurrent(record)) {
      return { ok: false, result: unavailable(record) }
    }
    await this.acceptAdmission(record)
    const accepted = await this.acceptClaimedDispatch(
      retainedClaim,
      prepared.preparation,
      prepared.snapshot,
      () => this.acceptanceAuthorityIsCurrent(record),
    )
    if (accepted === undefined) return { ok: false, result: unavailable(record) }
    return { ok: true }
  }

  private acceptanceAuthorityIsCurrent(record: AgentOperationIntentRecord): boolean {
    if (!this.options.authorityCurrent(record.payload.actor, 'work-item:give-to-agent')) return false
    const current = this.options.projects.currentActiveBinding(record.payload.intent.projectId)
    return typeof current !== 'string'
      && current.projectRevision === record.projectContext.projectRevision
      && isDeepStrictEqual(current.binding, record.hostRequest.expected.binding)
  }

  private async acceptAdmission(
    record: AgentOperationIntentRecord,
  ): Promise<Extract<BindingWriteAdmissionRecord, { readonly state: 'agent-run'; readonly phase: 'accepted' }>> {
    const bindingId = record.projectContext.resourceBindingId
    const next = await this.options.admissionTable.update(bindingId, (value) => {
      const current = bindingWriteAdmissionRecordSchema.parse(value)
      if (!admissionMatchesAgentOperation(current, record)) throw new AdmissionBusy()
      if (current.phase === 'accepted') return current
      const now = Math.max(current.updatedAt, Date.now())
      return bindingWriteAdmissionRecordSchema.parse({
        ...current,
        revision: current.revision + 1,
        phase: 'accepted',
        acceptedAt: now,
        updatedAt: now,
      })
    })
    return next as Extract<BindingWriteAdmissionRecord, { readonly state: 'agent-run'; readonly phase: 'accepted' }>
  }

  private async driveAccepted(
    record: AgentOperationIntentRecord,
    dispatch: ExecutionDispatchRecord,
    signal: AbortSignal,
  ): Promise<AgentResult> {
    const allocatedRun = this.requireRun(record.agentRunId)
    if (allocatedRun.state === 'allocated') await this.updateRun(allocatedRun, { state: 'starting' })
    else if (allocatedRun.state !== 'starting' && allocatedRun.state !== 'running') {
      return resultFor(await this.reconcile(record, 'protocol'))
    }
    const preparation = (dispatch as ExecutionDispatchRecord & {
      readonly preparation: HostOperationPreparation<'start-agent-run'>
    }).preparation
    const inspected = await this.options.execution.inspectOperation(preparation.operation, signal)
    signal.throwIfAborted()
    assertSnapshot(record, inspected)
    if (inspected.state === 'succeeded') return await this.finishStarted(record, dispatch, inspected.result, inspected, signal)
    if (inspected.state === 'reconciliation-required') return resultFor(await this.reconcile(record, inspected.reason))
    if (inspected.state === 'failed' || inspected.state === 'canceled') {
      return await this.finishNoEffect(record, dispatch, inspected, signal)
    }
    dispatch = await this.updateDispatch(dispatch, { operationSnapshot: inspected })
    const replay = await this.prepareExactHostOperation(record, signal)
    if (!replay.ok) {
      return replay.reason === 'unavailable'
        ? unavailable(record)
        : resultFor(await this.reconcile(record, 'protocol'))
    }
    const started = await this.options.execution.startOperation(replay.preparation.operation, replay.acceptance, signal)
    signal.throwIfAborted()
    assertSnapshot(record, started.snapshot)
    dispatch = await this.updateDispatch(dispatch, { operationSnapshot: started.snapshot })
    if (started.snapshot.state === 'succeeded') {
      return await this.finishStarted(record, dispatch, started.snapshot.result, started.snapshot, signal)
    }
    if (started.snapshot.state === 'reconciliation-required') {
      return resultFor(await this.reconcile(record, started.snapshot.reason))
    }
    if (started.snapshot.state === 'failed' || started.snapshot.state === 'canceled') {
      return await this.finishNoEffect(record, dispatch, started.snapshot, signal)
    }
    if (!started.ok && started.reason !== 'busy' && started.reason !== 'unavailable') {
      const reason = started.reason === 'authority-revoked' ? 'authority-revoked' : 'source-canceled'
      const canceled = await this.options.execution.cancelOperation(preparation.operation, reason, signal)
      assertSnapshot(record, canceled)
      if (canceled.state === 'succeeded') {
        return await this.finishStarted(record, dispatch, canceled.result, canceled, signal)
      }
      if (canceled.state === 'failed' || canceled.state === 'canceled') {
        return await this.finishNoEffect(record, dispatch, canceled, signal)
      }
      if (canceled.state === 'reconciliation-required') {
        return resultFor(await this.reconcile(record, canceled.reason))
      }
    }
    return unavailable(record)
  }

  private async finishStarted(
    record: AgentOperationIntentRecord,
    dispatch: ExecutionDispatchRecord,
    result: StartAgentRunHostOperationResult,
    snapshot: HostOperationSnapshot<'start-agent-run'>,
    signal: AbortSignal,
  ): Promise<AgentResult> {
    if (result.agentRunId !== record.agentRunId
      || result.workSessionId !== record.workSessionId
      || result.sessionId !== record.hostRequest.run.sessionId
      || result.inputMessageId !== record.hostRequest.run.input.id) {
      return resultFor(await this.reconcile(record, 'evidence-conflict'))
    }
    await this.updateDispatch(dispatch, { operationSnapshot: snapshot })
    const run = this.requireRun(record.agentRunId)
    if (run.state !== 'running') {
      await this.updateRun(run, { state: 'running', hostResult: result })
    }
    const move: MoveWorkItemIntent = {
      type: 'move-work-item',
      intentId: record.inProgressIntentId,
      projectId: record.payload.intent.projectId,
      workItemId: record.payload.intent.workItemId,
      expectedRemoteFingerprint: record.payload.intent.expectedRemoteFingerprint,
      targetStatus: 'in-progress',
    }
    const moved = await this.options.moveWorkItem(move, record.payload.actor, signal)
    if (!moved.ok) {
      if (moved.reason === 'unavailable') return unavailable(record)
      return resultFor(await this.reconcile(record, moved.reason === 'reconciliation-required'
        ? moved.receipt.reason === 'evidence-conflict' ? 'evidence-conflict' : 'effect-unknown'
        : 'protocol'))
    }
    const assignment = this.requireAssignment(record.assignmentId)
    if (assignment.state !== 'active') await this.updateAssignment(assignment, { state: 'active' })
    record = await this.updateIntent(record, { phase: 'started' })
    await this.finalizeRunOpenings(record.agentRunId, this.options.lifetime)
    this.options.notifyChanged()
    return resultFor(record)
  }

  private async finishNoEffect(
    record: AgentOperationIntentRecord,
    dispatch: ExecutionDispatchRecord,
    snapshot: Extract<HostOperationSnapshot<'start-agent-run'>, { readonly state: 'failed' | 'canceled' }>,
    _signal: AbortSignal,
  ): Promise<AgentResult> {
    dispatch = await this.updateDispatch(dispatch, { operationSnapshot: snapshot })
    const reason = snapshot.state === 'canceled' && snapshot.reason === 'authority-revoked'
      ? 'authority-revoked'
      : 'protocol'
    if (reason === 'protocol') return resultFor(await this.reconcile(record, reason))
    return await this.completeCanceled(record)
  }

  private async cancelForRevocation(record: AgentOperationIntentRecord, signal: AbortSignal): Promise<AgentResult> {
    let dispatch = this.requireDispatch(record.dispatchId)
    if (dispatch.preparation === undefined) {
      const replay = await this.prepareExactHostOperation(record, signal)
      if (!replay.ok) {
        if (replay.reason === 'unavailable') return unavailable(record)
        await this.acceptAdmission(record)
        return resultFor(await this.reconcile(record, 'protocol'))
      }
      dispatch = await this.updateDispatch(dispatch, {
        preparation: replay.preparation,
        operationSnapshot: replay.snapshot,
      })
    }
    const preparation = (dispatch as ExecutionDispatchRecord & {
      readonly preparation: HostOperationPreparation<'start-agent-run'>
    }).preparation
    const snapshot = await this.options.execution.cancelOperation(
      preparation.operation,
      'authority-revoked',
      signal,
    )
    assertSnapshot(record, snapshot)
    if (snapshot.state === 'succeeded') return await this.finishStarted(record, dispatch, snapshot.result, snapshot, signal)
    if (snapshot.state === 'reconciliation-required') return resultFor(await this.reconcile(record, snapshot.reason))
    if (snapshot.state !== 'failed' && snapshot.state !== 'canceled') return unavailable(record)
    const terminalSnapshot = snapshot
    if (dispatch.state === 'accepted') {
      await this.updateDispatch(dispatch, { operationSnapshot: terminalSnapshot })
    } else {
      await this.updateDispatch(dispatch, {
        state: 'canceled',
        claim: undefined,
        terminalReason: 'authority-revoked',
        operationSnapshot: terminalSnapshot,
      })
    }
    return await this.completeCanceled(record)
  }

  private async recoverTerminalPrefix(
    record: AgentOperationIntentRecord,
    dispatch: ExecutionDispatchRecord,
  ): Promise<AgentResult | undefined> {
    if (dispatch.state === 'reconciliation-required') {
      const reason = dispatch.terminalReason as Exclude<
        NonNullable<ExecutionDispatchRecord['terminalReason']>,
        'authority-revoked'
      >
      return resultFor(await this.reconcile(record, reason))
    }
    if (dispatch.state === 'canceled') return await this.completeCanceled(record)
    const snapshot = dispatch.operationSnapshot
    if (dispatch.state === 'accepted'
      && (snapshot?.state === 'failed' || snapshot?.state === 'canceled')
      && !this.options.authorityCurrent(record.payload.actor, 'work-item:give-to-agent')) {
      return await this.completeCanceled(record)
    }
    return undefined
  }

  private async completeCanceled(record: AgentOperationIntentRecord): Promise<AgentResult> {
    await this.cancelChildren(record)
    await this.release(record)
    const current = this.requireIntent(record.id)
    const canceled = await this.updateIntent(current, { phase: 'canceled', terminalReason: 'authority-revoked' })
    this.options.notifyChanged()
    return resultFor(canceled)
  }

  private admit(
    expectation: HostOperationAdmissionExpectation,
    signal: AbortSignal,
  ): Promise<HostOperationAdmissionDecision> {
    signal.throwIfAborted()
    if (expectation.source.kind !== 'execution-dispatch') {
      return Promise.resolve({ kind: 'denied', reason: 'not-current' })
    }
    const dispatchValue = this.options.dispatchTable.get(expectation.source.dispatchId)
    if (dispatchValue === undefined) return Promise.resolve({ kind: 'denied', reason: 'not-current' })
    const dispatch = executionDispatchRecordSchema.parse(dispatchValue)
    const intentValue = this.options.intentTable.get(dispatch.intentId)
    if (intentValue === undefined) {
      return Promise.resolve(this.admitInterventionAnswer(expectation, dispatch))
    }
    const intent = agentOperationIntentRecordSchema.parse(intentValue)
    if (intent.phase !== 'dispatching' || !dispatchMatchesAdmissionExpectation(dispatch, expectation)) {
      return Promise.resolve({ kind: 'denied', reason: 'not-current' })
    }
    const admissionValue = this.options.admissionTable.get(dispatch.bindingId)
    if (admissionValue === undefined) return Promise.resolve({ kind: 'unavailable' })
    const admission = bindingWriteAdmissionRecordSchema.safeParse(admissionValue)
    if (!admission.success) return Promise.resolve({ kind: 'unavailable' })
    if (!admissionMatchesAgentOperation(admission.data, intent) || admission.data.phase !== 'accepted') {
      return Promise.resolve({ kind: 'denied', reason: 'not-current' })
    }
    const current = this.options.projects.currentActiveBinding(intent.payload.intent.projectId)
    if (typeof current === 'string' || current.projectRevision !== intent.projectContext.projectRevision
      || !isDeepStrictEqual(current.binding, dispatch.hostRequest.expected.binding)) {
      return Promise.resolve({ kind: 'denied', reason: 'not-current' })
    }
    if (!this.options.authorityCurrent(intent.payload.actor, 'work-item:give-to-agent')) {
      return Promise.resolve({ kind: 'denied', reason: 'authority-revoked' })
    }
    return Promise.resolve({ kind: 'accepted', admissionRevision: admission.data.revision })
  }

  private admitInterventionAnswer(
    expectation: HostOperationAdmissionExpectation,
    dispatch: ExecutionDispatchRecord,
  ): HostOperationAdmissionDecision {
    const intervention = [...this.options.interventionTable.entries()]
      .map(([, value]) => interventionRequestRecordSchema.parse(value))
      .find(candidate => candidate.state === 'answered'
        && candidate.answer.dispatchId === dispatch.id
        && candidate.answer.payload.intent.intentId === dispatch.intentId)
    if (intervention?.state !== 'answered') return { kind: 'denied', reason: 'not-current' }
    if (!dispatchMatchesAdmissionExpectation(dispatch, expectation)) {
      return { kind: 'denied', reason: 'not-current' }
    }
    if (!this.options.authorityCurrent(intervention.answer.payload.actor, 'intervention:answer')) {
      return { kind: 'denied', reason: 'authority-revoked' }
    }
    const admission = this.currentInterventionAnswerAdmission(intervention, dispatch)
    return admission === undefined
      ? { kind: 'denied', reason: 'not-current' }
      : { kind: 'accepted', admissionRevision: admission.revision }
  }

  private async reconcile(
    record: AgentOperationIntentRecord,
    reason: 'effect-unknown' | 'evidence-conflict' | 'protocol',
  ): Promise<AgentOperationIntentRecord> {
    await this.reconcileRunOpenings(record.agentRunId, reason)
    const dispatch = this.requireDispatch(record.dispatchId)
    if (dispatch.state !== 'reconciliation-required') {
      await this.updateDispatch(dispatch, {
        state: 'reconciliation-required',
        claim: undefined,
        terminalReason: reason,
      })
    }
    const assignment = this.requireAssignment(record.assignmentId)
    if (assignment.state !== 'reconciliation-required') {
      await this.updateAssignment(assignment, { state: 'reconciliation-required' })
    }
    const session = this.requireWorkSession(record.workSessionId)
    if (session.state !== 'reconciliation-required') {
      await this.updateWorkSession(session, { state: 'reconciliation-required' })
    }
    const run = this.requireRun(record.agentRunId)
    if (run.state !== 'running' && run.state !== 'reconciliation-required') {
      await this.updateRun(run, { state: 'reconciliation-required' })
    }
    const next = await this.updateIntent(record, { phase: 'reconciliation-required', terminalReason: reason })
    this.options.notifyChanged()
    return next
  }

  private async cancelChildren(record: AgentOperationIntentRecord): Promise<void> {
    const assignment = this.requireAssignment(record.assignmentId)
    if (assignment.state !== 'canceled') await this.updateAssignment(assignment, { state: 'canceled' })
    const session = this.requireWorkSession(record.workSessionId)
    if (session.state !== 'canceled') await this.updateWorkSession(session, { state: 'canceled' })
    const run = this.requireRun(record.agentRunId)
    if (run.state !== 'canceled') await this.updateRun(run, { state: 'canceled' })
  }

  private async release(record: AgentOperationIntentRecord): Promise<void> {
    const bindingId = record.projectContext.resourceBindingId
    const currentValue = this.options.admissionTable.get(bindingId)
    if (currentValue === undefined) throw new AdmissionUnavailable()
    const current = bindingWriteAdmissionRecordSchema.parse(currentValue)
    if (current.state === 'available') return
    if (!admissionMatchesAgentOperation(current, record)) return
    await this.options.admissionTable.update(bindingId, (value) => {
      const stored = bindingWriteAdmissionRecordSchema.parse(value)
      if (stored.state === 'available') return stored
      if (!admissionMatchesAgentOperation(stored, record)) throw new AdmissionBusy()
      return bindingWriteAdmissionRecordSchema.parse({
        id: bindingId,
        schemaVersion: 1,
        revision: stored.revision + 1,
        state: 'available',
        updatedAt: Math.max(stored.updatedAt, Date.now()),
      })
    })
  }

  private requireIntent(id: SakiControlIntentId): AgentOperationIntentRecord {
    return agentOperationIntentRecordSchema.parse(this.options.intentTable.get(id))
  }

  private requireDispatch(id: SakiExecutionDispatchId): ExecutionDispatchRecord {
    return executionDispatchRecordSchema.parse(this.options.dispatchTable.get(id))
  }

  private requireAssignment(id: SakiWorkAssignmentId): WorkAssignmentRecord {
    return workAssignmentRecordSchema.parse(this.options.assignmentTable.get(id))
  }

  private requireWorkSession(id: SakiWorkSessionId): WorkSessionRecord {
    return workSessionRecordSchema.parse(this.options.workSessionTable.get(id))
  }

  private requireRun(id: SakiAgentRunId): AgentRunRecord {
    return agentRunRecordSchema.parse(this.options.agentRunTable.get(id))
  }

  private requireIntervention(id: SakiInterventionRequestId): InterventionRequestRecord {
    return interventionRequestRecordSchema.parse(this.options.interventionTable.get(id))
  }

  private async updateIntent(
    current: AgentOperationIntentRecord,
    patch: Partial<Pick<AgentOperationIntentRecord, 'phase' | 'terminalReason'>>,
  ): Promise<AgentOperationIntentRecord> {
    return await updateRecord(this.options.intentTable, current.id, current, patch, agentOperationIntentRecordSchema)
  }

  private async updateDispatch(
    current: ExecutionDispatchRecord,
    patch: Partial<Pick<ExecutionDispatchRecord,
    | 'state'
    | 'latestFencingToken'
    | 'claim'
    | 'acceptedFencingToken'
    | 'preparation'
    | 'operationSnapshot'
    | 'terminalReason'>>,
  ): Promise<ExecutionDispatchRecord> {
    return await updateRecord(this.options.dispatchTable, current.id, current, patch, executionDispatchRecordSchema)
  }

  private async updateAssignment(
    current: WorkAssignmentRecord,
    patch: Partial<Pick<WorkAssignmentRecord, 'state'>>,
  ): Promise<WorkAssignmentRecord> {
    return await updateRecord(this.options.assignmentTable, current.id, current, patch, workAssignmentRecordSchema)
  }

  private async updateWorkSession(
    current: WorkSessionRecord,
    patch: Partial<Pick<WorkSessionRecord, 'state'>>,
  ): Promise<WorkSessionRecord> {
    return await updateRecord(this.options.workSessionTable, current.id, current, patch, workSessionRecordSchema)
  }

  private async updateRun(
    current: AgentRunRecord,
    patch: Partial<Pick<
      AgentRunRecord,
      'state' | 'hostResult' | 'blockingInterventionId' | 'inputPlan' | 'dispatchIds'
    >>,
  ): Promise<AgentRunRecord> {
    return await updateRecord(this.options.agentRunTable, current.id, current, patch, agentRunRecordSchema)
  }

  private async updateIntervention(
    current: InterventionRequestRecord,
    patch: Partial<InterventionRequestRecord>,
  ): Promise<InterventionRequestRecord> {
    return await updateRecord(
      this.options.interventionTable,
      current.id,
      current,
      patch,
      interventionRequestRecordSchema,
    )
  }

  private async reconcileIntervention(
    intervention: InterventionRequestRecord,
    reason: 'effect-unknown' | 'evidence-conflict' | 'protocol',
  ): Promise<InterventionRequestRecord> {
    const now = Math.max(intervention.updatedAt, Date.now())
    const next = await this.updateIntervention(intervention, {
      state: 'reconciliation-required',
      openedAt: 'openedAt' in intervention ? intervention.openedAt : now,
      reason,
      reconciliationRequiredAt: now,
    })
    this.options.notifyChanged()
    return next
  }

  private async putExact<K extends string, V>(
    table: KvTable<K, V>,
    key: K,
    record: V,
    schema: { parse(value: unknown): V },
  ): Promise<void> {
    try {
      await table.put(key, record)
    } catch (error) {
      const replay = table.get(key)
      if (replay !== undefined && isDeepStrictEqual(schema.parse(replay), record)) return
      throw error
    }
  }

  private async putInitial<K extends string, V extends object>(
    table: KvTable<K, V>,
    key: K,
    record: V,
    schema: { parse(value: unknown): V },
    mutableKeys: readonly (keyof V)[],
  ): Promise<void> {
    const compatible = (value: unknown): boolean => {
      const parsed = schema.parse(value)
      const mutable = new Set<keyof V>(mutableKeys)
      return Object.entries(record).every(([name, expected]) => {
        const keyName = name as keyof V
        return mutable.has(keyName) || isDeepStrictEqual(parsed[keyName], expected)
      })
    }
    const existing = table.get(key)
    if (existing !== undefined) {
      if (!compatible(existing)) throw new Error(`Saki child '${key}' conflicts`)
      return
    }
    try {
      await table.put(key, record)
    } catch (error) {
      const replay = table.get(key)
      if (replay !== undefined && compatible(replay)) return
      throw error
    }
  }

  private enqueueIntent<T>(id: SakiControlIntentId, operation: () => Promise<T>): Promise<T> {
    return enqueueKeyedOperation(this.intentTails, id, operation)
  }
}

function sameDispatchClaim(
  current: ExecutionDispatchRecord,
  expected: ClaimedExecutionDispatch,
): current is ClaimedExecutionDispatch {
  return current.revision === expected.revision
    && current.state === 'claimed'
    && current.claim !== undefined
    && isDeepStrictEqual(current.claim, expected.claim)
}

function sameDispatchClaimOwner(
  current: ExecutionDispatchRecord,
  expected: ClaimedExecutionDispatch,
): current is ClaimedExecutionDispatch {
  return current.revision === expected.revision
    && current.state === 'claimed'
    && current.claim !== undefined
    && current.claim.id === expected.claim.id
    && current.claim.fencingToken === expected.claim.fencingToken
    && current.claim.executorHostId === expected.claim.executorHostId
}

function dispatchMatchesAdmissionExpectation(
  dispatch: ExecutionDispatchRecord,
  expectation: HostOperationAdmissionExpectation,
): boolean {
  return dispatch.state === 'accepted'
    && dispatch.acceptedFencingToken !== undefined
    && dispatch.preparation !== undefined
    && isDeepStrictEqual(expectation.source, dispatch.hostRequest.source)
    && isDeepStrictEqual(expectation.preparation, dispatch.preparation)
    && expectation.bindingId === dispatch.bindingId
    && expectation.bindingRevision === dispatch.hostRequest.expected.binding.revision
}

function admissionMatchesAgentOperation(
  admission: BindingWriteAdmissionRecord,
  record: AgentOperationIntentRecord,
): admission is Extract<BindingWriteAdmissionRecord, { readonly state: 'agent-run' }> {
  if (admission.state !== 'agent-run') return false
  return isDeepStrictEqual({
    originIntentId: admission.originIntentId,
    agentRunId: admission.agentRunId,
    payloadDigest: admission.payloadDigest,
    bindingRevision: admission.bindingRevision,
  }, {
    originIntentId: record.id,
    agentRunId: record.agentRunId,
    payloadDigest: record.hostRequest.source.payloadDigest,
    bindingRevision: record.projectContext.bindingRevision,
  })
}

/**
 * Validate the complete durable relation graph owned by manual Agent operations.
 * @param intentTable - accepted manual-Agent Intent records.
 * @param assignmentTable - preallocated Work Assignments.
 * @param workSessionTable - preallocated primary Work Sessions.
 * @param agentRunTable - preallocated Agent Runs and Host results.
 * @param dispatchTable - preallocated Execution Dispatches and Host evidence.
 * @param interventionTable - independently revisioned operator requests and answer winners.
 * @param admissionTable - shared Resource Binding write-admission rows.
 * @param registry - validated Project Registry, or absence before provisioning.
 * @param otherIntentIds - Control Intent ids already owned by other durable families.
 * @param validateActorReference - validator for retained Actor attribution.
 * @returns the accepted Intents in deterministic recovery order.
 */
export function validateAgentOperationsDurableState(
  intentTable: ReadonlyTable<SakiControlIntentId, AgentOperationIntentRecord>,
  assignmentTable: ReadonlyTable<SakiWorkAssignmentId, WorkAssignmentRecord>,
  workSessionTable: ReadonlyTable<SakiWorkSessionId, WorkSessionRecord>,
  agentRunTable: ReadonlyTable<SakiAgentRunId, AgentRunRecord>,
  dispatchTable: ReadonlyTable<SakiExecutionDispatchId, ExecutionDispatchRecord>,
  interventionTable: ReadonlyTable<SakiInterventionRequestId, InterventionRequestRecord>,
  admissionTable: ReadonlyTable<SakiResourceBindingId, BindingWriteAdmissionRecord>,
  registry: DevelopmentProjectRegistryRecord | undefined,
  otherIntentIds: ReadonlySet<SakiControlIntentId>,
  validateActorReference: (actor: ControlIntentActor) => void,
): ValidatedAgentOperationsState {
  const intents = [...intentTable.entries()].map(([key, value]) => {
    const intent = agentOperationIntentRecordSchema.parse(value)
    if (intent.id !== key) throw new Error('Saki Agent operation Intent id disagrees with its table key')
    if (otherIntentIds.has(key)) throw new Error(`Saki Control Intent '${key}' is retained by multiple Intent kinds`)
    validateActorReference(intent.payload.actor)
    return intent
  })
  const interventions = parseTable(interventionTable, interventionRequestRecordSchema, 'Intervention Request')
  const intentIds = new Set<SakiControlIntentId>(intents.map(intent => intent.id))
  const answerIntentIds = new Set<SakiControlIntentId>()
  const answerDispatchIds = new Set<SakiExecutionDispatchId>()
  for (const intervention of interventions) {
    if (!hasInterventionAnswer(intervention)) continue
    const { intent, actor } = intervention.answer.payload
    if (intentIds.has(intent.intentId)
      || otherIntentIds.has(intent.intentId)
      || answerIntentIds.has(intent.intentId)) {
      throw new Error(`Saki Control Intent '${intent.intentId}' is retained by multiple Intent kinds`)
    }
    answerIntentIds.add(intent.intentId)
    if (answerDispatchIds.has(intervention.answer.dispatchId)) {
      throw new Error(`Saki Execution Dispatch '${intervention.answer.dispatchId}' is retained by multiple Interventions`)
    }
    answerDispatchIds.add(intervention.answer.dispatchId)
    validateActorReference(actor)
  }
  if (registry === undefined) {
    if (intents.length + assignmentTable.size + workSessionTable.size + agentRunTable.size
      + dispatchTable.size + interventions.length > 0) {
      throw new Error('Saki Agent operation state exists without the Project Registry')
    }
    return {
      intents: [],
      interventions: [],
      runningAgentRuns: [],
      openingInterventionIds: [],
      answerPendingInterventionIds: [],
    }
  }
  const intentById = new Map(intents.map(intent => [intent.id, intent]))
  const assignments = parseTable(assignmentTable, workAssignmentRecordSchema, 'Work Assignment')
  const sessions = parseTable(workSessionTable, workSessionRecordSchema, 'Work Session')
  const runs = parseTable(agentRunTable, agentRunRecordSchema, 'Agent Run')
  const dispatches = parseTable(dispatchTable, executionDispatchRecordSchema, 'Execution Dispatch')
  const assignmentById = new Map(assignments.map(value => [value.id, value]))
  const sessionById = new Map(sessions.map(value => [value.id, value]))
  const runById = new Map(runs.map(value => [value.id, value]))
  const dispatchById = new Map(dispatches.map(value => [value.id, value]))
  const interventionById = new Map(interventions.map(value => [value.id, value]))
  const answeredInterventionByIntentId = new Map(interventions.flatMap(intervention => (
    hasInterventionAnswer(intervention)
      ? [[intervention.answer.payload.intent.intentId, intervention] as const]
      : []
  )))
  const answeredInterventionByDispatchId = new Map(interventions.flatMap(intervention => (
    hasInterventionAnswer(intervention)
      ? [[intervention.answer.dispatchId, intervention] as const]
      : []
  )))
  const admissions = parseTable(admissionTable, bindingWriteAdmissionRecordSchema, 'Binding write admission')
  const admissionById = new Map(admissions.map(value => [value.id, value]))
  for (const intent of intents) {
    const project = registry.projects.find(candidate => candidate.id === intent.payload.intent.projectId)
    const profile = registry.agentProfiles.find(candidate => candidate.id === intent.profile.id)
    if (project === undefined || profile === undefined || profile.projectId !== project.id) {
      throw new Error('Saki Agent operation Intent has inconsistent Project or Agent Profile')
    }
    const children = [
      assignmentById.get(intent.assignmentId),
      sessionById.get(intent.workSessionId),
      runById.get(intent.agentRunId),
      dispatchById.get(intent.dispatchId),
    ]
    if (intent.phase !== 'prepared' && children.some(value => value === undefined)) {
      throw new Error('Saki Agent operation Intent lacks a preallocated child')
    }
    const assignment = children[0] as WorkAssignmentRecord | undefined
    const session = children[1] as WorkSessionRecord | undefined
    const run = children[2] as AgentRunRecord | undefined
    const dispatch = children[3] as ExecutionDispatchRecord | undefined
    if (assignment !== undefined && !assignmentMatchesIntent(assignment, intent)) {
      throw new Error('Saki Work Assignment disagrees with its Agent operation Intent')
    }
    if (session !== undefined && !workSessionMatchesIntent(session, intent)) {
      throw new Error('Saki Work Session disagrees with its Agent operation Intent')
    }
    if (run !== undefined && !agentRunMatchesIntent(run, intent)) {
      throw new Error('Saki Agent Run disagrees with its Agent operation Intent')
    }
    if (dispatch !== undefined && !dispatchMatchesIntent(dispatch, intent)) {
      throw new Error('Saki Execution Dispatch disagrees with its Agent operation Intent')
    }
    const reconciliationPrefix = !terminal(intent.phase) && dispatch?.state === 'reconciliation-required'
    const cancellationPrefix = !terminal(intent.phase) && dispatchProvesCanceledDelivery(dispatch)
    if ((reconciliationPrefix || cancellationPrefix)
      && !terminalPrefixChildrenAreMonotonic(
        reconciliationPrefix ? 'reconciliation-required' : 'canceled',
        assignment as WorkAssignmentRecord,
        session as WorkSessionRecord,
        run as AgentRunRecord,
        dispatch as ExecutionDispatchRecord,
      )) {
      throw new Error('nonterminal Saki Agent operation has an inconsistent terminal write prefix')
    }
    const startedRunState = run?.state === 'running'
      || run?.state === 'waiting'
      || run?.state === 'resume-pending'
      || run?.state === 'reconciliation-required'
    if (intent.phase === 'started' && (assignment?.state !== 'active'
      || session?.state !== 'open'
      || !startedRunState
      || !initialDispatchProvesStartedIntent(dispatch, intent))) {
      throw new Error('started Saki Agent operation has an inconsistent child lifecycle')
    }
    if (intent.phase === 'reconciliation-required' && (assignment?.state !== 'reconciliation-required'
      || session?.state !== 'reconciliation-required'
      || dispatch?.state !== 'reconciliation-required'
      || dispatch.terminalReason !== intent.terminalReason
      || (run?.state !== 'reconciliation-required' && !dispatchHasExactSucceededRun(dispatch, run)))) {
      throw new Error('reconciling Saki Agent operation has an inconsistent child lifecycle')
    }
    if (intent.phase === 'canceled' && (assignment?.state !== 'canceled'
      || session?.state !== 'canceled' || run?.state !== 'canceled'
      || !dispatchProvesCanceledDelivery(dispatch))) {
      throw new Error('canceled Saki Agent operation retains a nonterminal child or possible-effect Host snapshot')
    }
    const admission = admissionById.get(intent.projectContext.resourceBindingId)
    const ownedAdmission = admission?.state === 'agent-run'
      && admission.originIntentId === intent.id && admission.agentRunId === intent.agentRunId
      ? admission
      : undefined
    const exactOwner = ownedAdmission !== undefined
      && ownedAdmission.bindingRevision === intent.projectContext.bindingRevision
      && ownedAdmission.payloadDigest === intent.hostRequest.source.payloadDigest
    if (intent.phase === 'canceled') {
      if (ownedAdmission !== undefined) throw new Error('canceled Saki Agent operation retains its write admission')
    } else if (intent.phase === 'admission-reserved') {
      if (!exactOwner || ownedAdmission.phase !== 'reserved') {
        throw new Error('admission-reserved Saki Agent operation lacks its exact reserved write admission')
      }
    } else if (intent.phase === 'dispatching') {
      const terminalAdmissionIsValid = reconciliationPrefix
        ? exactOwner
        : cancellationPrefix
          ? ownedAdmission === undefined
            || exactOwner
          : undefined
      const activeAdmissionIsValid = exactOwner
        && (dispatch?.state === 'claimed'
          || (dispatch?.state === 'accepted'
            ? ownedAdmission.phase === 'accepted'
            : dispatch?.state === 'pending' && ownedAdmission.phase === 'reserved'))
      if (terminalAdmissionIsValid === false
        || (terminalAdmissionIsValid === undefined && !activeAdmissionIsValid)) {
        throw new Error('dispatching Saki Agent operation has incompatible write admission')
      }
    } else if (intent.phase === 'started' || intent.phase === 'reconciliation-required') {
      if (!exactOwner || ownedAdmission.phase !== 'accepted') {
        throw new Error('started or reconciling Saki Agent operation lacks its exact accepted write admission')
      }
    }
  }
  for (const assignment of assignments) {
    const intent = intentById.get(assignment.intentId)
    if (intent === undefined || !assignmentMatchesIntent(assignment, intent)) {
      throw new Error('orphan or mismatched Work Assignment')
    }
  }
  for (const session of sessions) {
    const intent = intentById.get(session.intentId)
    if (intent === undefined || !workSessionMatchesIntent(session, intent)) {
      throw new Error('orphan or mismatched Work Session')
    }
  }
  for (const run of runs) {
    const intent = intentById.get(run.intentId)
    if (intent === undefined || !agentRunMatchesIntent(run, intent)) {
      throw new Error('orphan or mismatched Agent Run')
    }
  }
  const activeInterventionsByRun = new Map<SakiAgentRunId, InterventionRequestRecord[]>()
  for (const intervention of interventions) {
    const run = runById.get(intervention.owner.agentRunId)
    const assignment = run === undefined ? undefined : assignmentById.get(run.assignmentId)
    const session = run === undefined ? undefined : sessionById.get(run.workSessionId)
    if (run === undefined || assignment === undefined || session === undefined
      || intervention.owner.workSessionId !== run.workSessionId
      || intervention.projectId !== run.projectId
      || intervention.targetPrincipalId !== assignment.ownerPrincipalId
      || intervention.cause.agentRunId !== run.id
      || intervention.cause.workSessionId !== run.workSessionId
      || intervention.cause.sessionId !== run.sessionId
      || !interventionSubjectMatchesRun(intervention, run)
      || intervention.blockingScope.agentRunId !== run.id
      || !interventionReturnAddressMatchesRun(intervention, run)) {
      throw new Error('Saki Intervention Request has inconsistent ownership')
    }
    const blocksThisRun = run.blockingInterventionId === intervention.id
    const answerDispatch = hasInterventionAnswer(intervention)
      ? dispatchById.get(intervention.answer.dispatchId)
      : undefined
    const exactAnswerCompletionPrefix = intervention.state === 'answered'
      && answerDispatch?.state === 'accepted'
      && run.state === 'running'
      && run.blockingInterventionId === undefined
      && run.dispatchIds.at(-1) === answerDispatch.id
      && isDeepStrictEqual(run.inputPlan, intervention.answer.inputPlan)
      && interventionAnswerDispatchMatches(answerDispatch, intervention, run)
      && dispatchHasExactSucceededRun(answerDispatch, run)
    const exactAnswerReconciliationPrefix = intervention.state === 'answered'
      && interventionAnswerReconciliationPrefixMatches(answerDispatch, intervention, run)
    const origin = intentById.get(run.intentId)
    const initialDispatch = dispatchById.get(run.dispatchIds[0] as SakiExecutionDispatchId)
    const blockingIntervention = run.blockingInterventionId === undefined
      ? undefined
      : interventionById.get(run.blockingInterventionId)
    const blockingAnswerDispatch = blockingIntervention?.state === 'answered'
      ? dispatchById.get(blockingIntervention.answer.dispatchId)
      : undefined
    const exactAnswerPublicationSuccessor = !blocksThisRun
      && run.state === 'resume-pending'
      && blockingIntervention?.state === 'answered'
      && blockingAnswerDispatch?.state === 'accepted'
      && blockingIntervention.answer.dispatchId === run.dispatchIds.at(-1)
    if (intervention.state === 'opening') {
      const exactInitialPublicationOpening = !blocksThisRun
        && initialDispatch?.state === 'accepted'
        && (run.state === 'starting' || run.state === 'running')
        && (assignment.state === 'assigned' || (run.state === 'running' && assignment.state === 'active'))
        && origin?.phase === 'dispatching'
      const exactStableOpening = !blocksThisRun
        && run.state === 'running'
        && assignment.state === 'active'
        && origin?.phase === 'started'
      if ((!blocksThisRun
        && !exactInitialPublicationOpening && !exactStableOpening && !exactAnswerPublicationSuccessor)
        || (blocksThisRun && run.state !== 'waiting')) {
        throw new Error('opening Saki Intervention disagrees with its Agent Run')
      }
    } else if (intervention.state === 'open') {
      if (!blocksThisRun || run.state !== 'waiting') {
        throw new Error('open Saki Intervention lacks its waiting Agent Run')
      }
    } else if (intervention.state === 'answered') {
      if ((!blocksThisRun || (run.state !== 'waiting' && run.state !== 'resume-pending'))
        && !exactAnswerCompletionPrefix && !exactAnswerReconciliationPrefix) {
        throw new Error('answered Saki Intervention has an inconsistent Agent Run prefix')
      }
    } else if (intervention.state === 'resolved' && blocksThisRun) {
      throw new Error('resolved Saki Intervention still blocks its Agent Run')
    }
    if (intervention.state === 'opening' || intervention.state === 'open' || intervention.state === 'answered') {
      const active = activeInterventionsByRun.get(run.id) ?? []
      active.push(intervention)
      activeInterventionsByRun.set(run.id, active)
    }
    if (!hasInterventionAnswer(intervention)) continue
    if (answerDispatch === undefined) {
      if (intervention.state !== 'answered' && intervention.state !== 'reconciliation-required') {
        throw new Error('resolved Saki Intervention lacks its answer Dispatch')
      }
      continue
    }
    if (!interventionAnswerDispatchMatches(answerDispatch, intervention, run)) {
      throw new Error('Saki Intervention answer Dispatch disagrees with its owner')
    }
    if (intervention.state === 'resolved' && !run.dispatchIds.includes(answerDispatch.id)) {
      throw new Error('resolved Saki Intervention answer is absent from its Agent Run')
    }
    if (intervention.state === 'resolved'
      && !dispatchHasExactSucceededInterventionAnswer(answerDispatch, intervention, run)) {
      throw new Error('resolved Saki Intervention lacks exact succeeded answer Dispatch evidence')
    }
  }
  for (const [runId, active] of activeInterventionsByRun) {
    if (active.length <= 1) continue
    const run = runById.get(runId)
    const predecessor = active.find(intervention => intervention.state === 'answered')
    const successor = active.find(intervention => intervention.state === 'opening')
    const answerDispatch = predecessor?.state === 'answered'
      ? dispatchById.get(predecessor.answer.dispatchId)
      : undefined
    const exactAnswerPublicationHandoff = active.length === 2
      && run !== undefined
      && predecessor?.state === 'answered'
      && successor?.state === 'opening'
      && answerDispatch?.state === 'accepted'
      && answerDispatch.id === run.dispatchIds.at(-1)
      && interventionAnswerDispatchMatches(answerDispatch, predecessor, run)
      && ((run.state === 'resume-pending' && run.blockingInterventionId === predecessor.id)
        || (run.state === 'running' && run.blockingInterventionId === undefined
          && dispatchHasExactSucceededRun(answerDispatch, run)))
    if (!exactAnswerPublicationHandoff) {
      throw new Error('Saki Agent Run has multiple active Intervention Requests')
    }
  }
  for (const run of runs) {
    const intent = intentById.get(run.intentId) as AgentOperationIntentRecord
    const missingDispatchIds = run.dispatchIds.filter(id => !dispatchById.has(id))
    const missingResumeDispatch = missingDispatchIds.length === 1
      ? answeredInterventionByDispatchId.get(missingDispatchIds[0] as SakiExecutionDispatchId)
      : undefined
    const exactMissingResumePrefix = missingResumeDispatch?.state === 'answered'
      && run.state === 'resume-pending'
      && run.dispatchIds.at(-1) === missingDispatchIds[0]
      && run.blockingInterventionId === missingResumeDispatch.id
      && isDeepStrictEqual(run.inputPlan, missingResumeDispatch.answer.inputPlan)
    if (missingDispatchIds.length > 0 && !exactMissingResumePrefix) {
      throw new Error('Saki Agent Run has a mismatched or absent Execution Dispatch')
    }
    const dispatchSequence = run.dispatchIds.map(id => dispatchById.get(id))
    for (const dispatch of dispatchSequence.slice(1)) {
      if (dispatch === undefined) continue
      const intervention = answeredInterventionByDispatchId.get(dispatch.id)
      if (intervention === undefined) {
        throw new Error('Saki Agent Run has an unattributed resume Dispatch')
      }
    }
    const latestDispatchId = run.dispatchIds.at(-1) as SakiExecutionDispatchId
    const latestDispatch = dispatchSequence.at(-1)
    const latestAnswer = answeredInterventionByDispatchId.get(latestDispatchId)
    const expectedInputPlan = latestAnswer !== undefined
      ? latestAnswer.answer.inputPlan
      : {
        messageId: intent.hostRequest.run.input.id,
        payloadDigest: intent.hostRequest.source.payloadDigest,
      }
    if (!isDeepStrictEqual(run.inputPlan, expectedInputPlan)) {
      throw new Error('Saki Agent Run current input plan disagrees with its ordered Dispatches')
    }
    if ((run.state === 'running' || run.state === 'waiting')
      && !dispatchHasExactSucceededRun(latestDispatch, run)) {
      throw new Error('running Saki Agent Run lacks its exact succeeded Dispatch evidence')
    }
    if (run.state === 'resume-pending') {
      const intervention = answeredInterventionByDispatchId.get(latestDispatchId)
      if (intervention?.state !== 'answered' || run.blockingInterventionId !== intervention.id) {
        throw new Error('resume-pending Saki Agent Run lacks its answered Intervention')
      }
    }
    if (run.blockingInterventionId !== undefined) {
      const blocking = interventionById.get(run.blockingInterventionId)
      if (blocking === undefined || blocking.owner.agentRunId !== run.id
        || blocking.state === 'resolved') {
        throw new Error('Saki Agent Run has an invalid blocking Intervention')
      }
    }
  }
  for (const dispatch of dispatches) {
    const intent = intentById.get(dispatch.intentId)
    if (intent !== undefined) {
      if (!dispatchMatchesIntent(dispatch, intent)) {
        throw new Error('orphan or mismatched Execution Dispatch')
      }
      continue
    }
    const intervention = answeredInterventionByIntentId.get(dispatch.intentId)
    const run = intervention === undefined ? undefined : runById.get(intervention.owner.agentRunId)
    if (intervention === undefined || run === undefined) {
      throw new Error('orphan or mismatched Execution Dispatch')
    }
    if (!interventionAnswerDispatchMatches(dispatch, intervention, run)) {
      throw new Error('orphan or mismatched Execution Dispatch')
    }
  }
  const bindingById = new Map(registry.resourceBindings.map(binding => [binding.id, binding]))
  for (const admission of admissions) {
    if (admission.state !== 'agent-run') continue
    const binding = bindingById.get(admission.id)
    const intent = intentById.get(admission.originIntentId)
    const run = runById.get(admission.agentRunId)
    if (binding === undefined || intent === undefined || run === undefined
      || run.intentId !== intent.id || intent.projectContext.resourceBindingId !== admission.id
      || admission.bindingRevision > binding.revision
      || admission.payloadDigest !== intent.hostRequest.source.payloadDigest) {
      throw new Error('Saki Agent Run write admission has inconsistent ownership')
    }
  }
  const runningAgentRuns = runs
    .filter(run => run.state === 'running')
    .toSorted(byCreatedAtThenId)
    .map((run) => {
      const dispatchId = run.dispatchIds.at(-1) as SakiExecutionDispatchId
      const dispatch = dispatchById.get(dispatchId) as ExecutionDispatchRecord
      const preparation = dispatch.preparation as HostOperationPreparation<'start-agent-run'>
      const { operation } = preparation
      return {
        operation: { id: operation.id, hostId: operation.hostId, type: 'start-agent-run' as const },
        request: dispatch.hostRequest,
      }
    })
  return {
    intents: intents.toSorted(byCreatedAtThenId),
    interventions: interventions.toSorted(byCreatedAtThenId),
    runningAgentRuns,
    openingInterventionIds: interventions
      .filter(intervention => intervention.state === 'opening')
      .toSorted(byCreatedAtThenId)
      .map(intervention => intervention.id),
    answerPendingInterventionIds: interventions
      .filter(intervention => intervention.state === 'answered')
      .toSorted(byCreatedAtThenId)
      .map(intervention => intervention.id),
  }
}

function byCreatedAtThenId<T extends { readonly id: string; readonly createdAt: number }>(left: T, right: T): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id)
}

function assignmentMatchesIntent(
  assignment: WorkAssignmentRecord,
  intent: AgentOperationIntentRecord,
): boolean {
  return assignment.id === intent.assignmentId
    && assignment.intentId === intent.id
    && assignment.projectId === intent.payload.intent.projectId
    && assignment.workItemId === intent.payload.intent.workItemId
    && assignment.ownerPrincipalId === intent.payload.actor.principalId
    && assignment.primaryWorkSessionId === intent.workSessionId
    && assignment.agentRunId === intent.agentRunId
    && assignment.createdAt === intent.createdAt
}

function workSessionMatchesIntent(
  session: WorkSessionRecord,
  intent: AgentOperationIntentRecord,
): boolean {
  return session.id === intent.workSessionId
    && session.intentId === intent.id
    && session.assignmentId === intent.assignmentId
    && session.projectId === intent.payload.intent.projectId
    && session.workItemId === intent.payload.intent.workItemId
    && isDeepStrictEqual(session.agentRunIds, [intent.agentRunId])
    && session.createdAt === intent.createdAt
}

function agentRunMatchesIntent(run: AgentRunRecord, intent: AgentOperationIntentRecord): boolean {
  return run.id === intent.agentRunId
    && run.intentId === intent.id
    && run.assignmentId === intent.assignmentId
    && run.workSessionId === intent.workSessionId
    && run.projectId === intent.payload.intent.projectId
    && run.workItemId === intent.payload.intent.workItemId
    && run.bindingId === intent.projectContext.resourceBindingId
    && isDeepStrictEqual(run.profile, intent.profile)
    && run.sessionId === intent.hostRequest.run.sessionId
    && run.dispatchIds[0] === intent.dispatchId
    && run.createdAt === intent.createdAt
}

function interventionSubjectMatchesRun(
  intervention: InterventionRequestRecord,
  run: AgentRunRecord,
): boolean {
  return intervention.subject.agentRunId === run.id
}

function interventionReturnAddressMatchesRun(
  intervention: InterventionRequestRecord,
  run: AgentRunRecord,
): boolean {
  return intervention.returnAddress.projectId === run.projectId
    && intervention.returnAddress.workItemId === run.workItemId
    && intervention.returnAddress.workSessionId === run.workSessionId
    && intervention.returnAddress.agentRunId === run.id
}

function dispatchMatchesIntent(
  dispatch: ExecutionDispatchRecord,
  intent: AgentOperationIntentRecord,
): boolean {
  return dispatch.id === intent.dispatchId
    && dispatch.intentId === intent.id
    && dispatch.agentRunId === intent.agentRunId
    && dispatch.workSessionId === intent.workSessionId
    && dispatch.hostId === intent.hostRequest.expected.binding.hostId
    && dispatch.bindingId === intent.projectContext.resourceBindingId
    && dispatch.payloadDigest === intent.hostRequest.source.payloadDigest
    && isDeepStrictEqual(dispatch.hostRequest, intent.hostRequest)
    && dispatch.createdAt === intent.createdAt
}

function initialDispatchProvesStartedIntent(
  dispatch: ExecutionDispatchRecord | undefined,
  intent: AgentOperationIntentRecord,
): boolean {
  const snapshot = dispatch?.operationSnapshot
  return dispatch?.state === 'accepted'
    && dispatchMatchesIntent(dispatch, intent)
    && snapshot?.state === 'succeeded'
    && snapshot.result.type === 'start-agent-run'
    && snapshot.result.agentRunId === intent.agentRunId
    && snapshot.result.workSessionId === intent.workSessionId
    && snapshot.result.sessionId === intent.hostRequest.run.sessionId
    && snapshot.result.inputMessageId === intent.hostRequest.run.input.id
}

function dispatchHasExactSucceededRun(
  dispatch: ExecutionDispatchRecord | undefined,
  run: AgentRunRecord | undefined,
): boolean {
  return dispatch?.preparation !== undefined
    && dispatch.operationSnapshot?.state === 'succeeded'
    && (run?.state === 'running' || run?.state === 'waiting')
    && isDeepStrictEqual(dispatch.operationSnapshot.result, run.hostResult)
}

function dispatchHasExactSucceededInterventionAnswer(
  dispatch: ExecutionDispatchRecord,
  intervention: ResolvedIntervention,
  run: AgentRunRecord,
): boolean {
  const snapshot = dispatch.operationSnapshot
  return dispatch.state === 'accepted'
    && dispatch.preparation !== undefined
    && snapshot?.state === 'succeeded'
    && snapshot.result.type === 'start-agent-run'
    && snapshot.result.agentRunId === run.id
    && snapshot.result.workSessionId === run.workSessionId
    && snapshot.result.sessionId === run.sessionId
    && snapshot.result.inputMessageId === intervention.answer.inputPlan.messageId
}

function interventionAnswerReconciliationPrefixMatches(
  dispatch: ExecutionDispatchRecord | undefined,
  intervention: AnsweredIntervention,
  run: AgentRunRecord,
): boolean {
  return dispatch?.state === 'reconciliation-required'
    && run.state === 'reconciliation-required'
    && run.blockingInterventionId === intervention.id
    && run.hostResult === undefined
    && run.dispatchIds.at(-1) === dispatch.id
    && isDeepStrictEqual(run.inputPlan, intervention.answer.inputPlan)
    && interventionAnswerDispatchMatches(dispatch, intervention, run)
}

function dispatchProvesCanceledDelivery(dispatch: ExecutionDispatchRecord | undefined): boolean {
  if (dispatch?.state === 'accepted') {
    return dispatch.operationSnapshot?.state === 'failed'
      || dispatch.operationSnapshot?.state === 'canceled'
  }
  return dispatch?.state === 'canceled'
    && dispatch.terminalReason === 'authority-revoked'
    && (dispatch.operationSnapshot === undefined
      || dispatch.operationSnapshot.state === 'failed'
      || dispatch.operationSnapshot.state === 'canceled')
}

function terminalPrefixChildrenAreMonotonic(
  terminal: 'reconciliation-required' | 'canceled',
  assignment: WorkAssignmentRecord,
  session: WorkSessionRecord,
  run: AgentRunRecord,
  dispatch: ExecutionDispatchRecord,
): boolean {
  if (terminal === 'reconciliation-required') {
    if ((assignment.state !== 'assigned' && assignment.state !== 'reconciliation-required')
      || (session.state !== 'open' && session.state !== 'reconciliation-required')
      || (run.state !== 'allocated' && run.state !== 'starting' && run.state !== 'reconciliation-required'
        && !dispatchHasExactSucceededRun(dispatch, run))) return false
    if (assignment.state === 'assigned'
      && (session.state !== 'open' || run.state === 'reconciliation-required')) return false
    return session.state !== 'open' || run.state !== 'reconciliation-required'
  }
  if ((assignment.state !== 'assigned' && assignment.state !== 'canceled')
    || (session.state !== 'open' && session.state !== 'canceled')
    || (run.state !== 'allocated' && run.state !== 'starting' && run.state !== 'canceled')) return false
  if (assignment.state === 'assigned' && (session.state !== 'open' || run.state === 'canceled')) return false
  return session.state !== 'open' || run.state !== 'canceled'
}

interface ParsedDefinition {
  readonly intendedOutcome: string
  readonly acceptanceCriteria: readonly string[]
  readonly blockage: readonly string[]
}

/**
 * Parse the bounded Issue body into the exact normalized definition shown to the Agent.
 * @param body - complete validated GitHub Issue body.
 * @returns intended outcome, acceptance criteria, and nonempty blockage entries.
 */
function parseDefinition(body: string): ParsedDefinition {
  const sections = new Map<string, string[]>()
  let current = ''
  for (const line of body.split(/\r?\n/u)) {
    if (/^#{1,6}\s+.+?\s*$/u.test(line)) {
      current = line.replace(/^#{1,6}\s+/u, '').trim().toLowerCase()
      if (!sections.has(current)) sections.set(current, [])
      continue
    }
    const lines = sections.get(current)
    if (lines !== undefined) lines.push(line)
  }
  const section = (...names: readonly string[]): string => names
    .flatMap(name => sections.get(name) ?? [])
    .join('\n')
    .trim()
  const intendedOutcome = section('intended outcome', 'user story / outcome', 'outcome')
  const criteria = listItems(section('acceptance criteria', 'acceptance'))
  const blockage = listItems(section('blocked by', 'blockage', 'blockers', 'blocked'))
    .filter(value => !/^(?:none|n\/a|not blocked|无|无阻塞)$/iu.test(value))
  return {
    intendedOutcome: intendedOutcome === '' ? 'Complete the Work Item as specified.' : intendedOutcome,
    acceptanceCriteria: criteria,
    blockage,
  }
}

function listItems(value: string): readonly string[] {
  return value.split(/\r?\n/u)
    .map(line => line.trim().replace(/^[-*+]\s+(?:\[[ xX]\]\s*)?/u, '').trim())
    .filter(line => line !== '')
}

function renderRunInput(input: {
  readonly projectTitle: string
  readonly item: SakiBoardWorkItemProjection
  readonly detail: GitHubIssueDetailFact
  readonly definition: ParsedDefinition
  readonly profile: AgentOperationIntentRecord['profile']
  readonly branch: string
}): string {
  return [
    `Project: ${input.projectTitle}`,
    `Work Item: #${String(input.detail.number)} ${input.detail.title}`,
    `URL: ${input.detail.url}`,
    `Current branch: ${input.branch}`,
    `Development Agent Profile: ${input.profile.id} v${String(input.profile.version)}; preset ${input.profile.agentPresetId}; route ${input.profile.modelRoute.provider}/${input.profile.modelRoute.model}`,
    '',
    'Intended outcome:',
    input.definition.intendedOutcome,
    '',
    'Acceptance criteria:',
    ...input.definition.acceptanceCriteria.map(value => `- ${value}`),
    '',
    'Implement the frozen Work Item definition in the bound repository. Preserve unrelated existing changes.',
  ].join('\n')
}

function interventionAnswerInput(
  intervention: InterventionRequestRecord,
  intent: AnswerInterventionIntent,
  actor: ControlIntentActor,
): StartAgentRunInputMessage {
  const dispatchId = (
    `dispatch-${derivedUuid(intent.intentId, 'intervention-answer-dispatch')}`
  ) as SakiExecutionDispatchId
  return {
    id: derivedUuid(intent.intentId, 'intervention-answer-message') as StartAgentRunInputMessage['id'],
    role: 'user',
    content: [{
      type: 'text',
      text: `Operator response to your intervention request:\n\n${intent.answer.text}`,
    }],
    source: {
      kind: 'saki-intervention-answer',
      interventionId: intervention.id,
      answerIntentId: intent.intentId,
      dispatchId,
      agentRunId: intervention.owner.agentRunId,
      workSessionId: intervention.owner.workSessionId,
      actor,
    },
  }
}

function interventionAnswerDispatchMatches(
  dispatch: ExecutionDispatchRecord,
  intervention: AnsweredIntervention | ResolvedIntervention | ReconciledAnsweredIntervention,
  run: AgentRunRecord,
): boolean {
  const { answer } = intervention
  const input = interventionAnswerInput(intervention, answer.payload.intent, answer.payload.actor)
  const source = dispatch.hostRequest.run.input.source
  return source.kind === 'saki-intervention-answer'
    && dispatch.id === answer.dispatchId
    && dispatch.intentId === answer.payload.intent.intentId
    && dispatch.agentRunId === run.id
    && dispatch.workSessionId === run.workSessionId
    && dispatch.bindingId === run.bindingId
    && dispatch.hostId === dispatch.hostRequest.expected.binding.hostId
    && dispatch.payloadDigest === answer.inputPlan.payloadDigest
    && dispatch.hostRequest.source.dispatchId === dispatch.id
    && dispatch.hostRequest.source.payloadDigest === dispatch.payloadDigest
    && dispatch.hostRequest.run.agentRunId === run.id
    && dispatch.hostRequest.run.workSessionId === run.workSessionId
    && dispatch.hostRequest.run.sessionId === run.sessionId
    && isDeepStrictEqual(dispatch.hostRequest.run.profile, run.profile)
    && isDeepStrictEqual(dispatch.hostRequest.run.input, input)
    && input.id === answer.inputPlan.messageId
    && computeStartAgentRunPayloadDigest(input) === answer.inputPlan.payloadDigest
    && source.interventionId === intervention.id
    && source.answerIntentId === answer.payload.intent.intentId
    && isDeepStrictEqual(source.actor, answer.payload.actor)
}

function answerConflict(
  intervention: InterventionRequestRecord,
  intent: AnswerInterventionIntent,
  reason: Extract<SakiAnswerInterventionReceipt, { readonly state: 'conflict' }>['reason'],
): InterventionAnswerResult {
  return {
    ok: false,
    reason: 'conflict',
    receipt: {
      id: receiptId(intent.intentId),
      intentId: intent.intentId,
      type: 'answer-intervention',
      interventionId: intervention.id,
      interventionRevision: intervention.revision,
      state: 'conflict',
      reason,
    },
  }
}

type AnsweredIntervention = Extract<InterventionRequestRecord, { readonly state: 'answered' }>
type ResolvedIntervention = Extract<InterventionRequestRecord, { readonly state: 'resolved' }>
type ReconciledAnsweredIntervention = Extract<
  InterventionRequestRecord,
  { readonly state: 'reconciliation-required' }
> & { readonly answer: NonNullable<Extract<
  InterventionRequestRecord,
  { readonly state: 'reconciliation-required' }
>['answer']> }
type AnswerBearingIntervention = AnsweredIntervention | ResolvedIntervention | ReconciledAnsweredIntervention

function hasInterventionAnswer(record: InterventionRequestRecord): record is AnswerBearingIntervention {
  return record.state === 'answered'
    || record.state === 'resolved'
    || isReconciledAnsweredIntervention(record)
}

function isReconciledAnsweredIntervention(
  record: InterventionRequestRecord,
): record is ReconciledAnsweredIntervention {
  return record.state === 'reconciliation-required' && record.answer !== undefined
}

function answerReceipt(record: AnsweredIntervention): Extract<
  SakiAnswerInterventionReceipt,
  { readonly state: 'answered' }
>
function answerReceipt(record: ResolvedIntervention): Extract<
  SakiAnswerInterventionReceipt,
  { readonly state: 'resolved' }
>
function answerReceipt(record: ReconciledAnsweredIntervention): Extract<
  SakiAnswerInterventionReceipt,
  { readonly state: 'reconciliation-required' }
>
function answerReceipt(
  record: AnsweredIntervention | ResolvedIntervention | ReconciledAnsweredIntervention,
): SakiAnswerInterventionReceipt {
  const base = {
    id: record.answer.receiptId,
    intentId: record.answer.payload.intent.intentId,
    type: 'answer-intervention' as const,
    interventionId: record.id,
    interventionRevision: record.revision,
  }
  if (record.state === 'answered') {
    return { ...base, state: 'answered', dispatchId: record.answer.dispatchId }
  }
  if (record.state === 'resolved') {
    return { ...base, state: 'resolved', dispatchId: record.answer.dispatchId }
  }
  return {
    ...base,
    state: 'reconciliation-required',
    reason: record.reason,
    dispatchId: record.answer.dispatchId,
  }
}

function answerUnavailable(record: AnsweredIntervention): InterventionAnswerResult {
  return { ok: false, reason: 'unavailable', receipt: answerReceipt(record) }
}

function assertDispatchPrepared(
  dispatch: ExecutionDispatchRecord,
  preparation: HostOperationPreparation,
  snapshot: HostOperationSnapshot,
): asserts preparation is HostOperationPreparation<'start-agent-run'> {
  assertDispatchSnapshot(dispatch, snapshot)
  if (preparation.operation.type !== 'start-agent-run'
    || preparation.operation.hostId !== dispatch.hostId
    || preparation.operation.id !== snapshot.operation.id
    || !isDeepStrictEqual(preparation.requestFingerprint, snapshot.requestFingerprint)) {
    throw new Error('Host preparation disagrees with its Saki Intervention answer Dispatch')
  }
}

function assertDispatchSnapshot(
  dispatch: ExecutionDispatchRecord,
  snapshot: HostOperationSnapshot,
): asserts snapshot is HostOperationSnapshot<'start-agent-run'> {
  hostOperationSnapshotSchema.parse(snapshot)
  if (snapshot.operation.type !== 'start-agent-run'
    || snapshot.operation.hostId !== dispatch.hostId
    || snapshot.source.kind !== 'execution-dispatch'
    || snapshot.source.dispatchId !== dispatch.id
    || snapshot.source.payloadDigest !== dispatch.payloadDigest
    || snapshot.bindingId !== dispatch.bindingId
    || snapshot.bindingRevision !== dispatch.hostRequest.expected.binding.revision) {
    throw new Error('Host snapshot disagrees with its Saki Intervention answer Dispatch')
  }
}

function childIds(intent: GiveWorkItemToAgentIntent) {
  const id = (kind: string) => derivedUuid(intent.intentId, kind)
  return {
    assignmentId: `assignment-${id('assignment')}` as SakiWorkAssignmentId,
    workSessionId: `work-session-${id('work-session')}` as SakiWorkSessionId,
    agentRunId: `agent-run-${id('agent-run')}` as SakiAgentRunId,
    dispatchId: `dispatch-${id('dispatch')}` as SakiExecutionDispatchId,
    sessionId: `session-${id('dsh-session')}` as StartAgentRunHostOperationRequest['run']['sessionId'],
    messageId: id('message') as StartAgentRunHostOperationRequest['run']['input']['id'],
    inProgressIntentId: `intent-${id('in-progress-intent')}` as SakiControlIntentId,
  }
}

function derivedUuid(seed: string, kind: string): string {
  const bytes = createHash('sha256').update(`${seed}\0${kind}`, 'utf8').digest().subarray(0, 16)
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x40, 6)
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8)
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function conflict(intent: GiveWorkItemToAgentIntent, reason: AgentConflictReason): AgentResult {
  const ids = childIds(intent)
  return {
    ok: false,
    reason: 'conflict',
    receipt: {
      id: receiptId(intent.intentId),
      intentId: intent.intentId,
      type: intent.type,
      projectId: intent.projectId,
      workItemId: intent.workItemId,
      assignmentId: ids.assignmentId,
      workSessionId: ids.workSessionId,
      agentRunId: ids.agentRunId,
      dispatchId: ids.dispatchId,
      state: 'conflict',
      reason,
    },
  }
}

function unavailable(record: AgentOperationIntentRecord): AgentResult {
  return { ok: false, reason: 'unavailable', receipt: receiptFor(record) as Extract<
    SakiGiveWorkItemToAgentReceipt,
    { readonly state: 'prepared' | 'admission-reserved' | 'dispatching' }
  > }
}

type DurableAgentReceipt = Exclude<SakiGiveWorkItemToAgentReceipt, { readonly state: 'conflict' }>

function resultFor(record: AgentOperationIntentRecord): AgentResult {
  const receipt = receiptFor(record)
  if (receipt.state === 'started') return { ok: true, receipt }
  if (receipt.state === 'canceled') return { ok: false, reason: 'canceled', receipt }
  /* v8 ignore else -- after the other terminal states, a resultFor caller can only be reconciling. */
  if (receipt.state === 'reconciliation-required') {
    return { ok: false, reason: 'reconciliation-required', receipt }
  }
  /* v8 ignore next -- resultFor receives only terminal records; retryable phases use unavailable(). */
  return { ok: false, reason: 'unavailable', receipt }
}

function receiptFor(record: AgentOperationIntentRecord): DurableAgentReceipt {
  const base = {
    id: record.receiptId,
    intentId: record.id,
    type: 'give-work-item-to-agent' as const,
    projectId: record.payload.intent.projectId,
    workItemId: record.payload.intent.workItemId,
    assignmentId: record.assignmentId,
    workSessionId: record.workSessionId,
    agentRunId: record.agentRunId,
    dispatchId: record.dispatchId,
  }
  switch (record.phase) {
    case 'prepared': return { ...base, state: 'prepared' }
    case 'admission-reserved': return { ...base, state: 'admission-reserved' }
    case 'dispatching': return { ...base, state: 'dispatching' }
    case 'started': return { ...base, state: 'started' }
    case 'canceled': return { ...base, state: 'canceled', reason: 'authority-revoked' }
    case 'reconciliation-required': return {
      ...base,
      state: 'reconciliation-required',
      reason: record.terminalReason === 'effect-unknown' || record.terminalReason === 'evidence-conflict'
        ? record.terminalReason
        : 'protocol',
    }
  }
}

function receiptId(intentId: SakiControlIntentId): SakiIntentReceiptId {
  return intentId.replace(/^intent-/u, 'receipt-') as SakiIntentReceiptId
}

function terminal(phase: AgentOperationIntentRecord['phase']): boolean {
  return phase === 'started' || phase === 'canceled' || phase === 'reconciliation-required'
}

function assertPrepared(
  record: AgentOperationIntentRecord,
  preparation: HostOperationPreparation,
  snapshot: HostOperationSnapshot,
): asserts preparation is HostOperationPreparation<'start-agent-run'> {
  if (preparation.operation.type !== 'start-agent-run'
    || preparation.operation.hostId !== record.hostRequest.expected.binding.hostId
    || preparation.operation.id !== snapshot.operation.id
    || !isDeepStrictEqual(preparation.requestFingerprint, snapshot.requestFingerprint)) {
    throw new Error('Host preparation disagrees with its Saki Agent operation')
  }
  assertSnapshot(record, snapshot)
}

function assertSnapshot(
  record: AgentOperationIntentRecord,
  snapshot: HostOperationSnapshot,
): asserts snapshot is HostOperationSnapshot<'start-agent-run'> {
  hostOperationSnapshotSchema.parse(snapshot)
  if (snapshot.operation.type !== 'start-agent-run'
    || snapshot.operation.hostId !== record.hostRequest.expected.binding.hostId
    || snapshot.source.kind !== 'execution-dispatch'
    || snapshot.source.dispatchId !== record.dispatchId
    || snapshot.source.payloadDigest !== record.hostRequest.source.payloadDigest
    || snapshot.bindingId !== record.projectContext.resourceBindingId
    || snapshot.bindingRevision !== record.projectContext.bindingRevision) {
    throw new Error('Host snapshot disagrees with its Saki Agent operation')
  }
}

async function updateRecord<K extends string, V extends { readonly revision: number; readonly updatedAt: number }>(
  table: KvTable<K, V>,
  key: K,
  current: V,
  patch: Partial<NoInfer<V>>,
  schema: { parse(value: unknown): V },
): Promise<V> {
  try {
    return await table.update(key, (value) => {
      const stored = schema.parse(value)
      if (stored.revision !== current.revision) throw new RecordCasConflict()
      const candidate = Object.fromEntries(Object.entries({
        ...stored,
        ...patch,
        revision: stored.revision + 1,
        updatedAt: Math.max(stored.updatedAt, Date.now()),
      }).filter(([, value]) => value !== undefined))
      return schema.parse(candidate)
    })
  } catch (error) {
    const replay = table.get(key)
    if (replay !== undefined) {
      const parsed = schema.parse(replay)
      if (parsed.revision === current.revision + 1
        && Object.entries(patch).every(([name, expected]) => isDeepStrictEqual(
          parsed[name as keyof V], expected,
        ))) return parsed
    }
    throw error
  }
}

function parseTable<K extends string, V extends { readonly id: K }>(
  table: ReadonlyTable<K, V>,
  schema: { parse(value: unknown): V },
  kind: string,
): readonly V[] {
  return [...table.entries()].map(([key, value]) => {
    const parsed = schema.parse(value)
    if (parsed.id !== key) throw new Error(`Saki ${kind} id disagrees with its table key`)
    return parsed
  })
}
