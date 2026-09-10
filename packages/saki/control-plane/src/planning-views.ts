/** Read-only planning views assembled from confirmed GitHub and durable Saki records. */
import type { GitHubIssueDetailFact, GitHubMilestoneId } from '@breakfastdapaidang/saki-github'
import type { SessionId, SakiAgentRunId, SakiWorkSessionId, SakiControlIntentId } from '@breakfastdapaidang/saki-execution'
import type { BranchDeliveryProjection } from './branch-delivery.ts'
import { projectMilestoneDelivery, type MilestoneDeliveryProjection, type MilestoneDeliveryRecord } from './milestone-delivery.ts'
import type { AgentRunRecord, GitHubWorkItemIntentRecord, InterventionRequestRecord, WorkAssignmentRecord } from './spec.ts'
import type {
  SakiBoardProjection,
  SakiBoardWorkItemId,
  SakiBoardWorkItemProjection,
  SakiDevelopmentProjectId,
  SakiInterventionRequestProjection,
  SakiWorkAssignmentId,
} from './types.ts'

/** Fixed maximum number of recent planning references carried by one wire response. */
export const SAKI_PLANNING_REFERENCE_LIMIT = 32

/** A Milestone's last-confirmed GitHub identity and independently owned delivery phase. */
export interface SakiMilestoneSummary {
  readonly id: GitHubMilestoneId
  readonly number: number
  readonly title: string | null
  readonly url: string | null
  readonly dueAt: number | null
  readonly issueState: 'open' | 'closed' | null
  readonly observedAt: number | null
  readonly phase: MilestoneDeliveryProjection['phase']
  readonly repairRequired: boolean
  readonly tagName: string
}

/** One bounded page of Project-owned Milestone destinations. */
export interface SakiProjectMilestonesProjection {
  readonly type: 'project-milestones'
  readonly projectId: SakiDevelopmentProjectId
  readonly items: readonly SakiMilestoneSummary[]
  readonly next: GitHubMilestoneId | null
}

/** Current body with Saki's hidden recovery marker omitted, or an independent read failure. */
export type SakiWorkItemBodyProjection =
  | {
    readonly state: 'confirmed'
    readonly markdown: string
    readonly issueUpdatedAt: number
    readonly observedAt: number
    readonly matchesBoard: boolean
  }
  | { readonly state: 'unavailable'; readonly reason: 'provider-unavailable' | 'mapping-unavailable' | 'read-failed' | 'stale-remote' }

/** One durable Run reference without its input, Dispatch authority, or Host operation handles. */
export interface SakiPlanningRunProjection {
  readonly id: SakiAgentRunId
  readonly assignmentId: SakiWorkAssignmentId
  readonly workSessionId: SakiWorkSessionId
  readonly sessionId: SessionId
  readonly state: AgentRunRecord['state']
  readonly createdAt: number
  readonly updatedAt: number
}

/** A Work Item's specification, execution, delivery, and bounded activity references. */
export interface SakiWorkItemViewProjection {
  readonly type: 'work-item-view'
  readonly projectId: SakiDevelopmentProjectId
  readonly workItem: SakiBoardWorkItemProjection
  readonly body: SakiWorkItemBodyProjection
  readonly assignments: readonly {
    readonly id: SakiWorkAssignmentId
    readonly state: WorkAssignmentRecord['state']
    readonly primaryWorkSessionId: SakiWorkSessionId
  }[]
  readonly runs: readonly SakiPlanningRunProjection[]
  readonly interventions: readonly SakiInterventionRequestProjection[]
  readonly branchDelivery: BranchDeliveryProjection | null
  readonly milestones: readonly SakiMilestoneSummary[]
  readonly activity: readonly {
    readonly intentId: SakiControlIntentId
    readonly type: 'create-work-item' | 'move-work-item'
    readonly state: GitHubWorkItemIntentRecord['phase']
    readonly createdAt: number
    readonly updatedAt: number
  }[]
  readonly earlierActivity: boolean
}

/**
 * Resolve a Work Item after applying its authoritative targeted-confirmation overlays.
 * @param board - complete Board plus durable mutation overlays.
 * @param workItemId - selected stable Work Item identity.
 * @returns current item, including a creation confirmed before the next complete scan.
 */
export function planningWorkItem(board: SakiBoardProjection, workItemId: SakiBoardWorkItemId): SakiBoardWorkItemProjection | undefined {
  let item = board.confirmed?.items.find(candidate => candidate.id === workItemId)
  for (const overlay of board.mutationOverlays) {
    if ((overlay.state === 'targeted-confirmed' || overlay.state === 'conflict')
      && overlay.workItem?.id === workItemId) item = overlay.workItem
  }
  return item
}

/**
 * Project one configured Milestone without inferring phase from its GitHub state.
 * @param record - validated durable delivery and retained source facts.
 * @returns a safe destination summary with nulls for unobserved GitHub fields.
 */
export function planningMilestone(record: MilestoneDeliveryRecord): SakiMilestoneSummary {
  const milestone = record.sources.milestone.confirmed
  const delivery = projectMilestoneDelivery(record, record.sources.milestone)
  return {
    id: record.release.milestoneId,
    number: record.release.milestoneNumber,
    title: milestone?.value.title ?? null,
    url: milestone?.value.url ?? null,
    dueAt: milestone?.value.dueOn ?? null,
    issueState: milestone?.value.state ?? null,
    observedAt: milestone?.observedAt ?? null,
    phase: delivery.phase,
    repairRequired: delivery.repair !== undefined,
    tagName: record.release.tagName,
  }
}

type Entries<T> = Iterable<readonly [string, T]>
type Assignment = Pick<WorkAssignmentRecord, 'id' | 'projectId' | 'workItemId' | 'state' | 'primaryWorkSessionId'>
type Run = Pick<AgentRunRecord, 'id' | 'projectId' | 'workItemId' | 'assignmentId' | 'workSessionId'
  | 'sessionId' | 'state' | 'createdAt' | 'updatedAt'>
type Intervention = Pick<InterventionRequestRecord, 'id' | 'revision' | 'projectId' | 'kind' | 'state'
  | 'targetPrincipalId' | 'requiredAnswer' | 'createdAt' | 'updatedAt' | 'returnAddress'> & {
    readonly owner: Pick<InterventionRequestRecord['owner'], 'agentRunId'>
  }
type Activity = Pick<GitHubWorkItemIntentRecord, 'id' | 'phase' | 'createdAt' | 'updatedAt'> & {
  readonly payload: Pick<GitHubWorkItemIntentRecord['payload'], 'intent'>
  readonly observedPrefix: readonly { readonly workItemId?: SakiBoardWorkItemId }[]
}
type Records = {
  readonly assignments: Entries<Assignment>
  readonly runs: Entries<Run>
  readonly interventions: Entries<Intervention>
  readonly activity: Entries<Activity>
  readonly milestones: Entries<MilestoneDeliveryRecord>
}

/**
 * Page Project-owned Milestone records by their stable GitHub identity.
 * @param records - all retained delivery records.
 * @param projectId - selected authorized Project.
 * @param after - last identity from the previous page, or null for the first page.
 * @returns a bounded sorted page with an exact continuation cursor.
 */
export function planningMilestones(
  records: Entries<MilestoneDeliveryRecord>, projectId: SakiDevelopmentProjectId, after: GitHubMilestoneId | null,
): SakiProjectMilestonesProjection {
  const matching = [...records].map(([, record]) => record)
    .filter(record => record.projectId === projectId && (after === null || record.release.milestoneId > after))
    .sort((left, right) => left.release.milestoneId < right.release.milestoneId ? -1 : 1)
  const items: SakiMilestoneSummary[] = []
  let next: GitHubMilestoneId | null = null
  for (const record of matching) {
    if (items.length === SAKI_PLANNING_REFERENCE_LIMIT) return { type: 'project-milestones', projectId, items, next }
    items.push(planningMilestone(record))
    next = record.release.milestoneId
  }
  return { type: 'project-milestones', projectId, items, next: null }
}

/**
 * Join durable execution and delivery references for one confirmed Work Item.
 * @param projectId - selected authorized Project.
 * @param workItem - latest complete or targeted-confirmed Work Item.
 * @param records - durable tables read in the same synchronous projection step.
 * @returns scoped references with only the newest bounded activity window.
 */
export function planningReferences(
  projectId: SakiDevelopmentProjectId, workItem: SakiBoardWorkItemProjection, records: Records,
): Pick<SakiWorkItemViewProjection, 'assignments' | 'runs' | 'interventions' | 'milestones' | 'activity' | 'earlierActivity'> {
  const assignments = [...records.assignments].map(([, record]) => record)
    .filter(record => record.projectId === projectId && record.workItemId === workItem.id)
    .map(({ id, state, primaryWorkSessionId }) => ({ id, state, primaryWorkSessionId }))
  const runs = [...records.runs].map(([, record]) => record)
    .filter(record => record.projectId === projectId && record.workItemId === workItem.id)
    .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
    .map(({ id, assignmentId, workSessionId, sessionId, state, createdAt, updatedAt }) =>
      ({ id, assignmentId, workSessionId, sessionId: sessionId as SessionId, state, createdAt, updatedAt }))
  const interventions = [...records.interventions].map(([, record]) => record)
    .filter(record => record.projectId === projectId && runs.some(run => run.id === record.owner.agentRunId))
    .flatMap(({ id, revision, kind, state, targetPrincipalId, requiredAnswer, createdAt, updatedAt, returnAddress }) =>
      state === 'opening' ? [] : [{ id, revision, kind, state, targetPrincipalId, requiredAnswer, createdAt, updatedAt, returnAddress }])
  const activity = [...records.activity].map(([, record]) => record)
    .filter(record => record.payload.intent.projectId === projectId
      && (record.payload.intent.type === 'move-work-item' ? record.payload.intent.workItemId === workItem.id
        : record.observedPrefix.some(observation => observation.workItemId === workItem.id)))
    .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
    .map(record => ({ intentId: record.id, type: record.payload.intent.type, state: record.phase,
      createdAt: record.createdAt, updatedAt: record.updatedAt }))
  const milestones = [...records.milestones].map(([, record]) => record)
    .filter(record => record.projectId === projectId
      && record.sources.milestone.confirmed?.value.issues.some(issue => issue.id === workItem.source.issueId))
    .map(planningMilestone)
  return { assignments, runs, interventions, milestones, activity: activity.slice(0, SAKI_PLANNING_REFERENCE_LIMIT),
    earlierActivity: activity.length > SAKI_PLANNING_REFERENCE_LIMIT }
}

/**
 * Admit a body only when its exact Repository and Issue identity matches the selected Work Item.
 * @param item - confirmed Board identity.
 * @param detail - complete Provider observation.
 * @param observedAt - completed read time.
 * @returns a body observation with explicit disagreement against the retained Board revision.
 */
export function planningBody(
  item: SakiBoardWorkItemProjection, detail: GitHubIssueDetailFact, observedAt: number,
): SakiWorkItemBodyProjection {
  if (detail.id !== item.source.issueId || detail.repositoryId !== item.source.repositoryId
    || detail.number !== item.issueNumber || detail.url !== item.url) {
    return { state: 'unavailable', reason: 'stale-remote' }
  }
  return {
    state: 'confirmed',
    markdown: detail.body.replace(/\n*<!-- saki-work-item:work-item-marker-[0-9a-f]{64} -->\s*$/u, ''),
    issueUpdatedAt: detail.updatedAt,
    observedAt,
    matchesBoard: detail.updatedAt <= item.updatedAt && detail.title === item.title && detail.state === item.issueState,
  }
}
