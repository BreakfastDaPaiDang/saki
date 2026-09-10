import { describe, expect, it } from 'vitest'
import { githubIssueId, githubRepositoryId, githubRepositoryDatabaseId, type GitHubIssueDetailFact } from '@breakfastdapaidang/saki-github'
import { SAKI_BOARD_PROJECTION_FIXTURES, SAKI_BOARD_MUTATION_OVERLAY_FIXTURES as overlays, SAKI_AGENT_RUN_PROJECTION_FIXTURES } from '../src/fixtures.ts'
import { planningBody, planningReferences, planningWorkItem, SAKI_PLANNING_REFERENCE_LIMIT } from '../src/planning-views.ts'
import { createWorkItemIntentSchema, moveWorkItemIntentSchema, type AgentRunRecord } from '../src/spec.ts'
import { sakiBoardWorkItemIdSchema, sakiDevelopmentProjectIdSchema, sakiInterventionRequestIdSchema, sakiPrincipalIdSchema } from '../src/ids.ts'

const board = SAKI_BOARD_PROJECTION_FIXTURES.confirmedStaleFailure
const item = board.confirmed.items[0]
const detail: GitHubIssueDetailFact = {
  id: item.source.issueId, repositoryId: item.source.repositoryId,
  repositoryDatabaseId: githubRepositoryDatabaseId('123'), number: item.issueNumber,
  title: item.title, url: item.url, state: item.issueState, updatedAt: item.updatedAt,
  body: '## Acceptance criteria\n- Preserve confirmed facts.',
}

function entries<T>(values: readonly T[]): Iterable<readonly [string, T]> {
  return values.map((value, index) => [String(index), value] as const)
}

it('joins only the selected Work Item and Project, hides opening interventions, and bounds activity', () => {
  const projectId = board.projectId
  const otherProject = sakiDevelopmentProjectIdSchema.parse('project-11111111-1111-4111-8111-111111111111')
  const otherItem = sakiBoardWorkItemIdSchema.parse(`work-item-${'9'.repeat(64)}`)
  const current = SAKI_AGENT_RUN_PROJECTION_FIXTURES.running
  const canceled = SAKI_AGENT_RUN_PROJECTION_FIXTURES.canceled
  const reconciliation = SAKI_AGENT_RUN_PROJECTION_FIXTURES.reconciliationRequired
  const run = { ...current, projectId, workItemId: item.id, sessionId: current.sessionId as AgentRunRecord['sessionId'], createdAt: 20 }
  const assignment = { id: run.assignmentId, projectId, workItemId: item.id, state: 'active' as const, primaryWorkSessionId: run.workSessionId }
  const intervention = {
    id: sakiInterventionRequestIdSchema.parse('intervention-11111111-1111-4111-8111-111111111111'),
    revision: 0, projectId, kind: 'text-input' as const, state: 'open' as const,
    targetPrincipalId: sakiPrincipalIdSchema.parse('principal-11111111-1111-4111-8111-111111111111'),
    owner: { agentRunId: run.id }, requiredAnswer: { kind: 'text' as const, prompt: 'Choose the release scope.', maxLength: 100 },
    createdAt: 20, updatedAt: 20,
    returnAddress: { kind: 'agent-run' as const, projectId, workItemId: item.id, workSessionId: run.workSessionId, agentRunId: run.id },
  }
  const move = moveWorkItemIntentSchema.parse({ type: 'move-work-item', intentId: current.source.intentId, projectId,
    workItemId: item.id, expectedRemoteFingerprint: item.remoteFingerprint, targetStatus: 'done' })
  const create = createWorkItemIntentSchema.parse({ type: 'create-work-item', intentId: canceled.source.intentId, projectId,
    expected: { projectRevision: 0, synchronizationRevision: 1, mappingRevision: 1 }, title: 'Selected Issue',
    intendedOutcome: 'A confirmed Issue.', acceptanceCriteria: ['Preserve the Project identity.'] })
  const moves = Array.from({ length: SAKI_PLANNING_REFERENCE_LIMIT + 2 }, (_, index) => {
    const intent = moveWorkItemIntentSchema.parse({ ...move,
      intentId: `intent-00000000-0000-4000-8000-${String(index).padStart(12, '0')}` })
    return { id: intent.intentId, payload: { intent }, phase: 'succeeded' as const,
      observedPrefix: [], createdAt: index < 2 ? 90 : 100, updatedAt: 100 }
  })
  const created = { id: create.intentId, payload: { intent: create }, phase: 'succeeded' as const,
    observedPrefix: [{ workItemId: otherItem }, { workItemId: item.id }], createdAt: 150, updatedAt: 150 }
  const references = planningReferences(projectId, item, {
    assignments: entries([assignment, { ...assignment, projectId: otherProject }, { ...assignment, workItemId: otherItem }]),
    runs: entries([
      { ...run, id: reconciliation.id, createdAt: 20 }, { ...run, id: canceled.id, createdAt: 10 }, run,
      { ...run, projectId: otherProject }, { ...run, workItemId: otherItem },
    ]),
    interventions: entries([
      intervention, { ...intervention, state: 'opening' }, { ...intervention, projectId: otherProject },
      { ...intervention, owner: { agentRunId: 'agent-run-11111111-1111-4111-8111-111111111111' as typeof run.id } },
    ]),
    activity: entries([
      ...moves, created, { ...created, observedPrefix: [{ workItemId: otherItem }] },
      { ...created, payload: { intent: { ...create, projectId: otherProject } } },
      { ...moves[0]!, payload: { intent: { ...move, workItemId: otherItem } } },
    ]),
    milestones: [],
  })
  expect(references.assignments).toEqual([{ id: assignment.id, state: 'active', primaryWorkSessionId: run.workSessionId }])
  expect(references.runs.map(run => run.id)).toEqual([current.id, reconciliation.id, canceled.id])
  expect(references.runs[0]).not.toHaveProperty('profile')
  const { projectId: _project, owner: _owner, ...visibleIntervention } = intervention
  expect(references.interventions).toEqual([visibleIntervention])
  expect(references.activity).toHaveLength(SAKI_PLANNING_REFERENCE_LIMIT)
  expect(references.activity[0]).toEqual({ intentId: create.intentId, type: 'create-work-item', state: 'succeeded', createdAt: 150, updatedAt: 150 })
  expect(references.earlierActivity).toBe(true)
  expect(references.activity[1]?.intentId).toBe(moves[2]?.id)
})

describe('planning body observation', () => {
  it.each([
    { id: githubIssueId('I_other') }, { repositoryId: githubRepositoryId('R_other') },
    { number: item.issueNumber + 1 }, { url: `${item.url}/other` },
  ])('rejects an independently changed identity %j', (patch) => {
    expect(planningBody(item, { ...detail, ...patch }, 100)).toEqual({ state: 'unavailable', reason: 'stale-remote' })
  })
  it('keeps newer body facts readable while marking disagreement with the retained Board', () => {
    expect(planningBody(item, detail, 100)).toMatchObject({ state: 'confirmed', markdown: detail.body, observedAt: 100, matchesBoard: true })
    for (const patch of [{ updatedAt: item.updatedAt + 1 }, { title: 'Changed title' }, { state: 'closed' as const }]) {
      expect(planningBody(item, { ...detail, ...patch }, 100)).toMatchObject({ state: 'confirmed', matchesBoard: false })
    }
  })
  it('omits the hidden Saki recovery marker while retaining other Markdown and comments', () => {
    const markdown = `${detail.body}\n\n<!-- ordinary issue comment -->`
    const body = `${markdown}\n\n<!-- saki-work-item:work-item-marker-${'a'.repeat(64)} -->\n`
    expect(planningBody(item, { ...detail, body }, 100)).toMatchObject({ markdown })
  })
  it('resolves complete Board items and returns no item before its first confirmation', () => {
    expect(planningWorkItem(board, item.id)).toBe(item)
    expect(planningWorkItem({ ...board, confirmed: undefined }, item.id)).toBeUndefined()
    expect(planningWorkItem({ ...board, mutationOverlays: Object.values(overlays) }, item.id)).toEqual(overlays.conflict.workItem)
    expect(planningWorkItem({ ...board, mutationOverlays: [{ ...overlays.conflict, workItem: undefined }] }, item.id)).toBe(item)
  })
})
