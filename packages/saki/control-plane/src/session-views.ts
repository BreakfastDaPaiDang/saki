/** Bounded Session destinations and safe Run evidence joined from durable control-plane records. */
import type {
  AgentRunObservation, AgentRunTerminalSelection, HostOperationId, SessionId,
  SakiAgentRunId, SakiControlIntentId, SakiExecutionDispatchId, SakiWorkSessionId,
} from '@breakfastdapaidang/saki-execution'
import type {
  AgentOperationIntentRecord, AgentRunRecord, ExecutionDispatchRecord, InterventionRequestRecord,
  WorkAssignmentRecord, WorkSessionRecord,
} from './spec.ts'
import type {
  SakiBoardProjection, SakiBoardStatus, SakiBoardWorkItemId, SakiDevelopmentProjectId,
  SakiInterventionRequestProjection, SakiPrincipalId, SakiWorkAssignmentId,
} from './types.ts'
import { planningWorkItem, SAKI_PLANNING_REFERENCE_LIMIT } from './planning-views.ts'

/** One Project's stable-id-ordered Session page, optionally restricted to a Work Item. */
export interface SakiProjectSessionsQuery {
  readonly type: 'project-sessions'
  readonly projectId: SakiDevelopmentProjectId
  readonly workItemId: SakiBoardWorkItemId | null
  readonly after: SakiWorkSessionId | null
}

/** One Run's local observation and a bounded Dispatch page. */
export interface SakiAgentRunViewQuery {
  readonly type: 'agent-run-view'
  readonly projectId: SakiDevelopmentProjectId
  readonly agentRunId: SakiAgentRunId
  readonly afterDispatch: SakiExecutionDispatchId | null
  readonly terminal: AgentRunTerminalSelection | null
}

/** Work Item label survives removal from the current Board without inventing a current status. */
export interface SakiSessionWorkItem {
  readonly id: SakiBoardWorkItemId
  readonly title: string
  readonly issueNumber: number
  readonly status: SakiBoardStatus | null
}

/** One retained Work Session and its ordered Run references, separate from DSH Session identities. */
export interface SakiWorkSessionSummary {
  readonly id: SakiWorkSessionId
  readonly revision: number
  readonly state: WorkSessionRecord['state']
  readonly primary: true
  readonly workItem: SakiSessionWorkItem
  readonly assignment: {
    readonly id: SakiWorkAssignmentId
    readonly state: WorkAssignmentRecord['state']
    readonly ownerPrincipalId: SakiPrincipalId
    readonly currentAgentRunId: SakiAgentRunId
  }
  readonly runs: readonly {
    readonly id: SakiAgentRunId
    readonly sessionId: SessionId
    readonly state: AgentRunRecord['state']
    readonly createdAt: number
    readonly updatedAt: number
  }[]
  readonly createdAt: number
  readonly updatedAt: number
}

/** Complete bounded page of retained Session destinations. */
export interface SakiProjectSessionsProjection {
  readonly type: 'project-sessions'
  readonly projectId: SakiDevelopmentProjectId
  readonly workItemId: SakiBoardWorkItemId | null
  readonly items: readonly SakiWorkSessionSummary[]
  readonly next: SakiWorkSessionId | null
}

/** A Dispatch is admission evidence; a succeeded operation confirms input delivery, not model completion. */
export interface SakiRunDispatchSummary {
  readonly id: SakiExecutionDispatchId
  readonly revision: number
  readonly intentId: SakiControlIntentId
  readonly state: ExecutionDispatchRecord['state']
  readonly reason: NonNullable<ExecutionDispatchRecord['terminalReason']> | null
  readonly operation: null | {
    readonly id: HostOperationId
    readonly revision: number
    readonly state: NonNullable<ExecutionDispatchRecord['operationSnapshot']>['state']
  }
  readonly createdAt: number
  readonly updatedAt: number
}

/** Selected Run, retained identities, local observation, and independently derived delivery links. */
export interface SakiAgentRunViewProjection {
  readonly type: 'agent-run-view'
  readonly projectId: SakiDevelopmentProjectId
  readonly workSession: SakiWorkSessionSummary
  readonly run: {
    readonly id: SakiAgentRunId
    readonly revision: number
    readonly sessionId: SessionId
    readonly state: AgentRunRecord['state']
    readonly source: { readonly kind: 'manual-give-to-agent'; readonly intentId: SakiControlIntentId; readonly principalId: SakiPrincipalId }
    readonly profile: AgentRunRecord['profile']
    readonly createdAt: number
    readonly updatedAt: number
  }
  readonly observation: AgentRunObservation
  readonly dispatches: readonly SakiRunDispatchSummary[]
  readonly nextDispatch: SakiExecutionDispatchId | null
  readonly interventions: readonly SakiInterventionRequestProjection[]
  readonly earlierInterventions: boolean
  readonly status: AgentRunRecord['state'] | 'succeeded' | 'failed' | 'interrupted' | 'blocked' | 'limited' | 'idle' | 'unavailable'
}

type Table<K, V> = Pick<ReadonlyMap<K, V>, 'get' | 'entries'>
/** Validated tables sampled together when a protected query assembles its response. */
export interface SessionViewRecords {
  readonly sessions: Table<SakiWorkSessionId, WorkSessionRecord>
  readonly assignments: Table<SakiWorkAssignmentId, WorkAssignmentRecord>
  readonly runs: Table<SakiAgentRunId, AgentRunRecord>
  readonly intents: Table<SakiControlIntentId, AgentOperationIntentRecord>
  readonly dispatches: Table<SakiExecutionDispatchId, ExecutionDispatchRecord>
  readonly interventions: Table<SakiInterventionRequestProjection['id'], InterventionRequestRecord>
}

function required<K, V>(table: Table<K, V>, id: K): V {
  const value = table.get(id)
  if (value === undefined) throw new Error('Saki Session view is missing a validated durable relationship')
  return value
}

function sessionSummary(session: WorkSessionRecord, records: SessionViewRecords, board: SakiBoardProjection): SakiWorkSessionSummary {
  const assignment = required(records.assignments, session.assignmentId)
  const intent = required(records.intents, session.intentId)
  const item = planningWorkItem(board, session.workItemId)
  return {
    id: session.id, revision: session.revision, state: session.state, primary: session.primary,
    workItem: { id: session.workItemId, title: item?.title ?? intent.workItemDefinition.title,
      issueNumber: item?.issueNumber ?? intent.workItemDefinition.issueNumber, status: item?.status ?? null },
    assignment: { id: assignment.id, state: assignment.state,
      ownerPrincipalId: assignment.ownerPrincipalId, currentAgentRunId: assignment.agentRunId,
    },
    runs: session.agentRunIds.map((id) => {
      const run = required(records.runs, id)
      return { id: run.id, sessionId: run.sessionId as SessionId, state: run.state, createdAt: run.createdAt, updatedAt: run.updatedAt }
    }),
    createdAt: session.createdAt, updatedAt: session.updatedAt,
  }
}

/**
 * Page durable Sessions without inspecting local history or starting work.
 * @param query - authorized Project, optional Work Item, and stable continuation.
 * @param records - validated durable execution tables.
 * @param board - latest Board used only for current labels and status.
 * @returns a bounded page retaining historical destinations when Board items disappear.
 */
export function projectSessions(
  query: SakiProjectSessionsQuery, records: SessionViewRecords, board: SakiBoardProjection,
): SakiProjectSessionsProjection {
  const matching = [...records.sessions.entries()].map(([, session]) => session)
    .filter(session => session.projectId === query.projectId && (query.workItemId === null || session.workItemId === query.workItemId)
      && (query.after === null || session.id > query.after))
    .sort((left, right) => left.id < right.id ? -1 : 1)
  const page = matching.slice(0, SAKI_PLANNING_REFERENCE_LIMIT)
  return { type: 'project-sessions', projectId: query.projectId, workItemId: query.workItemId,
    items: page.map(session => sessionSummary(session, records, board)),
    // oxlint-disable-next-line typescript/no-non-null-assertion -- A continuation requires a full positive-capacity page.
    next: matching.length > page.length ? page.at(-1)!.id : null }
}

/**
 * Join one retained Run with a current local observation and bounded Dispatch evidence.
 * @param query - selected authorized Run and Dispatch continuation.
 * @param records - freshly sampled validated durable records.
 * @param board - current Board labels, independent of execution outcomes.
 * @param observation - local Session/Terminal read, or explicit unavailability.
 * @returns the selected Run view, or null for a missing or foreign Run.
 */
export function agentRunView(
  query: SakiAgentRunViewQuery, records: SessionViewRecords, board: SakiBoardProjection, observation: AgentRunObservation,
): SakiAgentRunViewProjection | null {
  const run = records.runs.get(query.agentRunId)
  if (run === undefined || run.projectId !== query.projectId) return null
  const session = required(records.sessions, run.workSessionId)
  const intent = required(records.intents, run.intentId)
  const start = query.afterDispatch === null ? 0 : run.dispatchIds.indexOf(query.afterDispatch) + 1
  if (query.afterDispatch !== null && start === 0) return null
  const ids = run.dispatchIds.slice(start, start + SAKI_PLANNING_REFERENCE_LIMIT)
  const dispatches = ids.map((id) => {
    const dispatch = required(records.dispatches, id)
    const snapshot = dispatch.operationSnapshot
    return { id: dispatch.id, revision: dispatch.revision, intentId: dispatch.intentId, state: dispatch.state,
      reason: dispatch.terminalReason ?? null, operation: snapshot === undefined ? null : {
        id: snapshot.operation.id, revision: snapshot.revision, state: snapshot.state,
      }, createdAt: dispatch.createdAt, updatedAt: dispatch.updatedAt }
  })
  const matchingInterventions = [...records.interventions.entries()].map(([, value]) => value)
    .filter(value => value.projectId === query.projectId && value.owner.agentRunId === run.id && value.state !== 'opening')
    .sort((left, right) => Number(right.id === run.blockingInterventionId) - Number(left.id === run.blockingInterventionId)
      || right.createdAt - left.createdAt || left.id.localeCompare(right.id))
  const interventions = matchingInterventions
    .slice(0, SAKI_PLANNING_REFERENCE_LIMIT)
    .map(({ id, revision, kind, state, targetPrincipalId, requiredAnswer, createdAt, updatedAt, returnAddress }) =>
      ({ id, revision, kind, state: state as SakiInterventionRequestProjection['state'], targetPrincipalId, requiredAnswer, createdAt, updatedAt, returnAddress }))
  return { type: 'agent-run-view', projectId: query.projectId, workSession: sessionSummary(session, records, board),
    run: { id: run.id, revision: run.revision, sessionId: run.sessionId as SessionId, state: run.state,
      source: { kind: 'manual-give-to-agent', intentId: run.intentId, principalId: intent.payload.actor.principalId },
      profile: run.profile, createdAt: run.createdAt, updatedAt: run.updatedAt },
    observation, dispatches, interventions, earlierInterventions: matchingInterventions.length > interventions.length,
    // oxlint-disable-next-line typescript/no-non-null-assertion -- A continuation requires a full positive-capacity page.
    nextDispatch: start + ids.length < run.dispatchIds.length ? ids.at(-1)! : null,
    status: run.state !== 'running' ? run.state
      : observation.session.state === 'confirmed' ? observation.session.activity.state : 'unavailable',
  }
}
