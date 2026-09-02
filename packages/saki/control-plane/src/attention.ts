/** Principal-scoped My Work and Attention derivation. @module @breakfastdapaidang/saki-control-plane/attention */

import type {
  SakiAgentRunId,
  SakiActionRecommendation,
  SakiAttentionItemProjection,
  SakiAttentionProjection,
  SakiBoardRemoteFingerprint,
  SakiBoardStatus,
  SakiBoardWorkItemId,
  SakiDevelopmentProjectId,
  SakiExecutionDispatchId,
  SakiInterventionRequestProjection,
  SakiMyWorkItemProjection,
  SakiMyWorkProjection,
  SakiPrincipalId,
  SakiReturnAddress,
  SakiWorkAssignmentId,
  SakiWorkSessionId,
} from './types.ts'
import type { InterventionRequestRecord } from './spec.ts'

/** Authority facts admitted into one Principal-scoped projection read. */
export type SakiProjectionAction = 'work-item:give-to-agent' | 'intervention:answer'

/** Current operation fact preventing a Ready Work Item from being given to an Agent. */
export type SakiGiveToAgentUnavailableReason =
  | 'action-denied'
  | 'automation-policy-unavailable'
  | 'binding-unavailable'
  | 'budget-unavailable'
  | 'git-unavailable'
  | 'operation-conditions-unavailable'
  | 'production-credential-unavailable'
  | 'synchronization-unavailable'

/** Current Give-to-Agent operation eligibility supplied by its authoritative owner. */
export type SakiGiveToAgentAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: SakiGiveToAgentUnavailableReason }

interface ProjectSource {
  readonly id: SakiDevelopmentProjectId
  readonly revision: number
  readonly projectTitle: string
}

interface BoardWorkItemSource {
  readonly id: SakiBoardWorkItemId
  readonly title: string
  readonly issueNumber: number
  readonly status: SakiBoardStatus
  readonly updatedAt: number
  readonly archived: boolean
  readonly notInProject: boolean
  readonly remoteFingerprint: SakiBoardRemoteFingerprint
}

interface GitHubProjectSyncSource {
  readonly id: SakiDevelopmentProjectId
  readonly confirmedBoard?: { readonly items: readonly BoardWorkItemSource[] } | undefined
}

interface WorkAssignmentSource {
  readonly id: SakiWorkAssignmentId
  readonly revision: number
  readonly projectId: SakiDevelopmentProjectId
  readonly workItemId: SakiBoardWorkItemId
  readonly ownerPrincipalId: SakiPrincipalId
  readonly primaryWorkSessionId: SakiWorkSessionId
  readonly agentRunId: SakiAgentRunId
  readonly state: 'assigned' | 'active' | 'canceled' | 'reconciliation-required'
  readonly createdAt: number
  readonly updatedAt: number
}

interface AgentRunSource {
  readonly id: SakiAgentRunId
  readonly revision: number
  readonly assignmentId: SakiWorkAssignmentId
  readonly workSessionId: SakiWorkSessionId
  readonly projectId: SakiDevelopmentProjectId
  readonly workItemId: SakiBoardWorkItemId
  readonly state:
    | 'allocated'
    | 'starting'
    | 'running'
    | 'waiting'
    | 'resume-pending'
    | 'canceled'
    | 'reconciliation-required'
  readonly updatedAt: number
}

interface ExecutionDispatchSource {
  readonly id: SakiExecutionDispatchId
  readonly revision: number
  readonly agentRunId: SakiAgentRunId
  readonly workSessionId: SakiWorkSessionId
  readonly state: 'pending' | 'claimed' | 'accepted' | 'canceled' | 'reconciliation-required'
  readonly terminalReason?: 'authority-revoked' | 'effect-unknown' | 'evidence-conflict' | 'protocol' | undefined
  readonly createdAt: number
  readonly updatedAt: number
}

type AttentionInterventionSource = Extract<
  InterventionRequestRecord,
  { readonly state: 'open' | 'reconciliation-required' }
>

interface WorkItemContext {
  readonly sources: SakiPrincipalWorkProjectionSources
  readonly project: ProjectSource
  readonly item: BoardWorkItemSource
  readonly assignment: WorkAssignmentSource | undefined
  readonly run: AgentRunSource | undefined
  readonly intervention: AttentionInterventionSource | undefined
}

function projectWorkItemKey(
  projectId: SakiDevelopmentProjectId,
  workItemId: SakiBoardWorkItemId,
): string {
  return `${projectId}\0${workItemId}`
}

function currentAssignmentsByProjectWorkItem(
  assignments: readonly WorkAssignmentSource[],
  runById: ReadonlyMap<SakiAgentRunId, AgentRunSource>,
  dispatches: readonly ExecutionDispatchSource[],
): ReadonlyMap<string, WorkAssignmentSource> {
  const dispatchPriorityByRun = new Map<SakiAgentRunId, number>()
  for (const dispatch of dispatches) {
    const priority = dispatch.state === 'reconciliation-required'
      ? 2
      : dispatch.state === 'claimed' || dispatch.state === 'accepted' ? 1 : undefined
    if (priority !== undefined && priority > (dispatchPriorityByRun.get(dispatch.agentRunId) ?? -1)) {
      dispatchPriorityByRun.set(dispatch.agentRunId, priority)
    }
  }
  const currentByWorkItem = new Map<string, {
    readonly assignment: WorkAssignmentSource
    readonly priority: number
  }>()
  for (const candidate of assignments) {
    const key = projectWorkItemKey(candidate.projectId, candidate.workItemId)
    const candidatePriority = assignmentSelectionPriority(
      candidate,
      runById.get(candidate.agentRunId),
      dispatchPriorityByRun.get(candidate.agentRunId),
    )
    if (candidatePriority === undefined) continue
    const current = currentByWorkItem.get(key)
    if (current === undefined
      || candidatePriority > current.priority
      || (candidatePriority === current.priority && candidate.createdAt > current.assignment.createdAt)
      || (candidatePriority === current.priority
        && candidate.createdAt === current.assignment.createdAt && candidate.id > current.assignment.id)) {
      currentByWorkItem.set(key, { assignment: candidate, priority: candidatePriority })
    }
  }
  return new Map([...currentByWorkItem].map(([key, current]) => [key, current.assignment]))
}

function assignmentSelectionPriority(
  assignment: WorkAssignmentSource,
  run: AgentRunSource | undefined,
  dispatchPriority: number | undefined,
): number | undefined {
  if (assignment.state === 'reconciliation-required'
    || run?.state === 'reconciliation-required'
    || assignment.state === 'active'
    || run?.state === 'starting'
    || run?.state === 'running'
    || run?.state === 'waiting'
    || run?.state === 'resume-pending') return 2
  if (assignment.state === 'assigned' && run?.state === 'allocated') return dispatchPriority
  return assignment.state === 'canceled' ? 0 : undefined
}

function cloneRequiredAnswer(
  answer: AttentionInterventionSource['requiredAnswer'],
): AttentionInterventionSource['requiredAnswer'] {
  return { ...answer }
}

function cloneReturnAddress<T extends SakiReturnAddress>(address: T): T {
  return { ...address }
}

/** Complete authoritative inputs used to derive one Principal's work surfaces. */
export interface SakiPrincipalWorkProjectionSources {
  readonly principalId: SakiPrincipalId
  readonly allowedActions: ReadonlySet<SakiProjectionAction>
  readonly projects: readonly ProjectSource[]
  readonly githubProjectSyncs: readonly GitHubProjectSyncSource[]
  readonly workAssignments: readonly WorkAssignmentSource[]
  readonly agentRuns: readonly AgentRunSource[]
  readonly executionDispatches: readonly ExecutionDispatchSource[]
  readonly interventions: readonly InterventionRequestRecord[]
  readonly giveToAgentAvailability: ReadonlyMap<
    SakiDevelopmentProjectId,
    ReadonlyMap<SakiBoardWorkItemId, SakiGiveToAgentAvailability>
  >
}

/** Both views derived from one immutable source snapshot. */
export interface SakiPrincipalWorkProjections {
  readonly myWork: SakiMyWorkProjection
  readonly attention: SakiAttentionProjection
}

function projectIntervention(
  intervention: AttentionInterventionSource,
): SakiInterventionRequestProjection {
  return {
    id: intervention.id,
    revision: intervention.revision,
    kind: intervention.kind,
    state: intervention.state,
    targetPrincipalId: intervention.targetPrincipalId,
    requiredAnswer: cloneRequiredAnswer(intervention.requiredAnswer),
    createdAt: intervention.createdAt,
    updatedAt: intervention.updatedAt,
    returnAddress: cloneReturnAddress(intervention.returnAddress),
  }
}

function recommendationFor(context: WorkItemContext): SakiActionRecommendation {
  const { assignment, intervention, item, project, run, sources } = context
  if (intervention !== undefined) {
    if (intervention.state === 'reconciliation-required') {
      return { available: false, reason: 'reconciliation-required' }
    }
    if (!sources.allowedActions.has('intervention:answer')) {
      return { available: false, reason: 'response-action-denied' }
    }
    return {
      available: true,
      offer: {
        type: 'answer-intervention',
        reason: 'response-required',
        interventionId: intervention.id,
        expectedInterventionRevision: intervention.revision,
        requiredAnswer: cloneRequiredAnswer(intervention.requiredAnswer),
      },
    }
  }
  if (item.status === 'in-review') return { available: false, reason: 'acceptance-not-available' }
  if (item.status === 'done' || item.status === 'canceled') {
    return { available: false, reason: 'terminal-work-item' }
  }
  if (assignment?.state === 'reconciliation-required' || run?.state === 'reconciliation-required') {
    return { available: false, reason: 'reconciliation-required' }
  }
  if (assignment !== undefined) return { available: false, reason: 'active-work' }
  if (!sources.allowedActions.has('work-item:give-to-agent')) {
    return { available: false, reason: 'action-denied' }
  }
  const availability = sources.giveToAgentAvailability.get(project.id)?.get(item.id)
  if (availability?.available !== true) {
    return { available: false, reason: availability?.reason ?? 'operation-conditions-unavailable' }
  }
  return {
    available: true,
    offer: {
      type: 'give-work-item-to-agent',
      reason: 'ready-for-agent',
      projectId: project.id,
      workItemId: item.id,
      expectedProjectRevision: project.revision,
      expectedRemoteFingerprint: item.remoteFingerprint,
    },
  }
}

function groupFor(context: WorkItemContext): SakiMyWorkItemProjection['group'] {
  const { assignment, intervention, item, run } = context
  if (intervention !== undefined || item.status === 'in-review'
    || assignment?.state === 'reconciliation-required' || run?.state === 'reconciliation-required') {
    return 'waiting-for-operator'
  }
  if (item.status === 'done' || item.status === 'canceled') return 'recently-finished'
  return assignment === undefined ? 'ready-to-start' : 'active'
}

function returnAddressFor(context: WorkItemContext): SakiMyWorkItemProjection['returnAddress'] {
  const { intervention, item, project, run } = context
  if (intervention !== undefined) return cloneReturnAddress(intervention.returnAddress)
  if (run === undefined) return { kind: 'work-item', projectId: project.id, workItemId: item.id }
  return {
    kind: 'agent-run',
    projectId: project.id,
    workItemId: item.id,
    workSessionId: run.workSessionId,
    agentRunId: run.id,
  }
}

/**
 * Derive My Work and Attention from one immutable authoritative snapshot.
 *
 * @param sources - Current Principal, authority, and product records.
 * @returns Detached Principal-scoped projections with no persisted view state.
 */
export function deriveSakiPrincipalWork(
  sources: SakiPrincipalWorkProjectionSources,
): SakiPrincipalWorkProjections {
  const projectById = new Map(sources.projects.map(project => [project.id, project]))
  const targetAttentionInterventions = sources.interventions.filter(
    (intervention): intervention is AttentionInterventionSource =>
      intervention.targetPrincipalId === sources.principalId
      && projectById.has(intervention.projectId)
      && (intervention.state === 'open' || intervention.state === 'reconciliation-required'),
  )
  const interventionByWorkItem = new Map<string, AttentionInterventionSource>()
  for (const intervention of targetAttentionInterventions) {
    const key = projectWorkItemKey(intervention.projectId, intervention.returnAddress.workItemId)
    const current = interventionByWorkItem.get(key)
    if (current?.state === 'open' && intervention.state !== 'open') continue
    interventionByWorkItem.set(key, intervention)
  }
  const runById = new Map(sources.agentRuns.map(run => [run.id, run]))
  const currentAssignmentByWorkItem = currentAssignmentsByProjectWorkItem(
    sources.workAssignments,
    runById,
    sources.executionDispatches,
  )
  const assignmentById = new Map(sources.workAssignments.map(assignment => [assignment.id, assignment]))
  const items: SakiMyWorkItemProjection[] = []

  for (const sync of sources.githubProjectSyncs) {
    const project = projectById.get(sync.id)
    if (project === undefined) continue
    for (const item of sync.confirmedBoard?.items ?? []) {
      if (item.archived || item.notInProject) continue
      const key = projectWorkItemKey(project.id, item.id)
      const intervention = interventionByWorkItem.get(key)
      const selectedAssignment = currentAssignmentByWorkItem.get(key)
      if (intervention === undefined
        && selectedAssignment !== undefined
        && selectedAssignment.state !== 'canceled'
        && selectedAssignment.ownerPrincipalId !== sources.principalId) continue
      const terminal = item.status === 'done' || item.status === 'canceled'
      const assignment = selectedAssignment?.ownerPrincipalId === sources.principalId
        && (selectedAssignment.state !== 'canceled' || terminal)
        ? selectedAssignment
        : undefined
      if (item.status !== 'ready' && intervention === undefined && assignment === undefined) continue
      const run = assignment === undefined ? undefined : runById.get(assignment.agentRunId)
      const context = { sources, project, item, assignment, run, intervention }
      items.push({
        project: { id: project.id, title: project.projectTitle },
        workItem: {
          id: item.id,
          title: item.title,
          issueNumber: item.issueNumber,
          status: item.status,
          updatedAt: item.updatedAt,
        },
        group: groupFor(context),
        assignment: assignment === undefined
          ? undefined
          : {
            id: assignment.id,
            revision: assignment.revision,
            ownerPrincipalId: assignment.ownerPrincipalId,
            state: assignment.state,
          },
        run: run === undefined ? undefined : { id: run.id, revision: run.revision, state: run.state },
        intervention: intervention === undefined ? undefined : projectIntervention(intervention),
        returnAddress: returnAddressFor(context),
        recommendation: recommendationFor(context),
      })
    }
  }

  return {
    myWork: { type: 'my-work', principalId: sources.principalId, items },
    attention: {
      type: 'attention',
      principalId: sources.principalId,
      items: [
        ...targetAttentionInterventions.flatMap((intervention): SakiAttentionItemProjection[] => {
          return [{
            source: { kind: 'intervention', id: intervention.id, revision: intervention.revision },
            projectId: intervention.projectId,
            targetPrincipalId: intervention.targetPrincipalId,
            severity: intervention.state === 'open' ? 'action-required' : 'warning',
            ...(intervention.state === 'open'
              ? { requiredResponse: cloneRequiredAnswer(intervention.requiredAnswer) }
              : {}),
            openedAt: intervention.openedAt,
            returnAddress: cloneReturnAddress(intervention.returnAddress),
          }]
        }),
        ...sources.workAssignments.flatMap((assignment): SakiAttentionItemProjection[] => {
          if (assignment.ownerPrincipalId !== sources.principalId
            || assignment.state !== 'reconciliation-required'
            || currentAssignmentByWorkItem.get(projectWorkItemKey(
              assignment.projectId,
              assignment.workItemId,
            ))?.id !== assignment.id
            || !projectById.has(assignment.projectId)) return []
          return [{
            source: { kind: 'work-assignment', id: assignment.id, revision: assignment.revision },
            projectId: assignment.projectId,
            targetPrincipalId: assignment.ownerPrincipalId,
            severity: 'warning',
            openedAt: assignment.updatedAt,
            returnAddress: {
              kind: 'agent-run',
              projectId: assignment.projectId,
              workItemId: assignment.workItemId,
              workSessionId: assignment.primaryWorkSessionId,
              agentRunId: assignment.agentRunId,
            },
          }]
        }),
        ...sources.executionDispatches.flatMap((dispatch): SakiAttentionItemProjection[] => {
          if (dispatch.state !== 'reconciliation-required') return []
          const run = runById.get(dispatch.agentRunId)
          const assignment = run === undefined ? undefined : assignmentById.get(run.assignmentId)
          if (run === undefined || assignment?.ownerPrincipalId !== sources.principalId
            || currentAssignmentByWorkItem.get(projectWorkItemKey(run.projectId, run.workItemId))?.id !== assignment.id
            || !projectById.has(run.projectId)) return []
          return [{
            source: { kind: 'execution-dispatch', id: dispatch.id, revision: dispatch.revision },
            projectId: run.projectId,
            targetPrincipalId: assignment.ownerPrincipalId,
            severity: 'action-required',
            openedAt: dispatch.updatedAt,
            returnAddress: {
              kind: 'agent-run',
              projectId: run.projectId,
              workItemId: run.workItemId,
              workSessionId: run.workSessionId,
              agentRunId: run.id,
            },
          }]
        }),
      ],
    },
  }
}

/**
 * Derive the Principal-scoped My Work view.
 *
 * @param sources - Current Principal, authority, and product records.
 * @returns Detached My Work projection.
 */
export function deriveSakiMyWork(
  sources: SakiPrincipalWorkProjectionSources,
): SakiMyWorkProjection {
  return deriveSakiPrincipalWork(sources).myWork
}

/**
 * Derive the Principal-scoped Attention view.
 *
 * @param sources - Current Principal, authority, and product records.
 * @returns Detached Attention projection.
 */
export function deriveSakiAttention(
  sources: SakiPrincipalWorkProjectionSources,
): SakiAttentionProjection {
  return deriveSakiPrincipalWork(sources).attention
}
