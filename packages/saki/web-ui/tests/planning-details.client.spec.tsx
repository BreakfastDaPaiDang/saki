// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SAKI_AGENT_RUN_PROJECTION_FIXTURES } from '@breakfastdapaidang/saki-control-plane/fixtures'
import { sakiConfigureGitHubSynchronizationResultSchema } from '@breakfastdapaidang/saki-host-api/wire'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { MappingView, MilestoneView, WorkItemView } from '../src/client/components/PlanningDetails.tsx'
import type { PlanningProject } from '../src/client/planning-controller.ts'
import { BOARD_STATUSES } from '../src/client/planning-cards.ts'
import { NS, zh } from '../src/client/locales.ts'
import { AUTH, ITEM, MAPPING, MAPPING_PATCH, PROJECT_ID, planningFixture } from './planning-fixture.client.ts'
import { BRANCH, MILESTONE, MILESTONE_SUMMARY, RELEASED_MILESTONE } from './planning-evidence.client.ts'

const t = ((key: string) => (zh as Record<string, string>)[key] ?? key) as TranslateNS<typeof NS>
beforeEach(() => { localStorage.clear() })
afterEach(() => { cleanup() })
async function fixture() {
  const instance = planningFixture()
  try {
    await instance.start()
    const result = await instance.api.queryWorkItemView(PROJECT_ID, ITEM.id)
    if (!result.ok || !MAPPING.ok) throw new Error('Planning presentation fixture unavailable')
    const project: PlanningProject = { ...instance.controller.getSnapshot().project!,
      detail: { value: result.projection, loading: false, failure: null },
      mapping: { value: MAPPING.projection, loading: false, failure: null },
    }
    const actions = instance.controller
    vi.spyOn(actions, 'navigate').mockImplementation(() => {})
    vi.spyOn(actions, 'repairMapping').mockResolvedValue(undefined)
    vi.spyOn(actions, 'retryMapping').mockResolvedValue(undefined)
    vi.spyOn(actions, 'beginMove').mockImplementation(() => {})
    return { project, actions, t }
  } finally { instance.controller.dispose() }
}

it('requires seven distinct discovered options and submits only the selected mapping patch', async () => {
  const props = await fixture()
  const view = render(<MappingView {...props} />)
  const save = screen.getByRole('button', { name: t('planning.saveMapping') })
  expect(save.hasAttribute('disabled')).toBe(true)
  fireEvent.submit(save.closest('form')!)
  expect(props.actions.repairMapping).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText(t('planning.field'), { exact: true }), { target: { value: 'FIELD_status' } })
  expect(props.actions.navigate).toHaveBeenCalledWith({ mappingDraft: { fieldId: 'FIELD_status', options: {} } })
  const options = Object.fromEntries(BOARD_STATUSES.map(status => [status, `option-${status}`]))
  const project = { ...props.project, address: { ...props.project.address, mappingDraft: { fieldId: 'FIELD_status', options } } }
  view.rerender(<MappingView {...props} project={project} />)
  expect(save.hasAttribute('disabled')).toBe(false)
  fireEvent.change(screen.getByLabelText(t('planning.status.ready'), { exact: true }), { target: { value: 'option-backlog' } })
  expect(props.actions.navigate).toHaveBeenLastCalledWith({ mappingDraft: {
    fieldId: 'FIELD_status', options: { ...options, ready: 'option-backlog' },
  } })
  fireEvent.click(save)
  expect(props.actions.repairMapping).toHaveBeenCalledWith(MAPPING_PATCH)
  view.rerender(<MappingView {...props} project={{ ...project, address: { ...project.address, mappingDraft: {
    fieldId: 'FIELD_status', options: { ...options, ready: 'option-backlog' },
  } } }} />)
  expect(save.hasAttribute('disabled')).toBe(true)
  expect(screen.getByText(t('planning.mappingInvalid'))).toBeTruthy()
  fireEvent.change(screen.getByLabelText(t('planning.field'), { exact: true }), { target: { value: '' } })
  expect(props.actions.navigate).toHaveBeenLastCalledWith({ mappingDraft: { fieldId: null, options: {} } })
})

it('keeps accepted delivery evidence and confirmed CI links when its current read fails', async () => {
  const props = await fixture()
  const detail = props.project.detail.value!
  const value = { ...detail, branchDelivery: BRANCH }
  const view = render(<WorkItemView {...props} openSession={vi.fn()} openMilestone={vi.fn()}
    project={{ ...props.project, detail: { value, loading: false, failure: null } }} />)
  expect(screen.getByRole('link', { name: '#45 Confirmed planning views' }).getAttribute('href')).toBe('https://example.test/pull/45')
  expect(screen.getByRole('link', { name: 'Workflow CI' }).getAttribute('href')).toBe('https://example.test/actions/101')
  expect(screen.getByRole('link', { name: 'Required check' }).getAttribute('href')).toBe('https://example.test/checks/201')
  expect(screen.getByText('e'.repeat(64))).toBeTruthy()
  expect(screen.getByText(`${t('planning.state.successful')} · ${t('planning.state.failure')}`)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: t('planning.move') }))
  expect(props.actions.beginMove).toHaveBeenCalledWith(detail.workItem)
  view.rerender(<WorkItemView {...props} openSession={vi.fn()} openMilestone={vi.fn()} project={{ ...props.project,
    detail: { value: { ...value, branchDelivery: { ...BRANCH, delivery: { ...BRANCH.delivery, phase: 'draft', acceptance: undefined },
      ci: { current: { state: 'unobserved' } }, pullRequest: { current: { state: 'unobserved' } },
    } }, loading: false, failure: null },
  }} />)
  expect(screen.queryByRole('link', { name: 'Workflow CI' })).toBeNull()
  expect(screen.queryByText('e'.repeat(64))).toBeNull()
})

it.each([
  ['pending', 'planning.loading'], ['unacknowledged', 'planning.mappingPending'],
  [{ ok: false, reason: 'conflict' }, 'planning.mappingConflict'],
  [{ ok: false, reason: 'unavailable' }, 'planning.unavailable'],
] as const)('renders mapping outcome %j without inferring successful activation', async (mappingResult, key) => {
  const props = await fixture()
  render(<MappingView {...props} project={{ ...props.project, mappingResult }} />)
  expect(screen.getByText(t(key))).toBeTruthy()
  if (mappingResult === 'unacknowledged') {
    fireEvent.click(screen.getByRole('button', { name: t('planning.retryMapping') }))
    expect(props.actions.retryMapping).toHaveBeenCalledOnce()
  }
})

it('keeps discovery failure and absent fields distinct from a selectable mapping', async () => {
  const props = await fixture()
  const view = render(<MappingView {...props} project={{ ...props.project,
    mapping: { value: null, loading: true, failure: 'offline' },
  }} />)
  expect(screen.getByRole('alert').textContent).toBe(t('planning.offline'))
  expect(screen.queryByText(t('planning.noFields'))).toBeNull()
  const mapping = props.project.mapping.value!
  view.rerender(<MappingView {...props} project={{ ...props.project,
    mapping: { value: { ...mapping, canConfigure: false, choices: { ...mapping.choices, fields: [] } }, loading: false, failure: null },
  }} />)
  expect(screen.getByText(t('planning.noFields'))).toBeTruthy()
  expect(screen.getByRole('button', { name: t('planning.saveMapping') }).closest('fieldset')?.disabled).toBe(true)
})

it('keeps the confirmed Issue link and evidence sections readable when its body fails independently', async () => {
  const props = await fixture()
  const detail = props.project.detail.value!
  const callbacks = { openSession: vi.fn(), openMilestone: vi.fn() }
  const view = render(<WorkItemView {...props} {...callbacks} />)
  expect(screen.getByText('Keep confirmed facts.')).toBeTruthy()
  expect(screen.getByRole('link', { name: t('planning.openIssue') }).getAttribute('href')).toBe(ITEM.url)
  const missingBody = { ...detail, body: { state: 'unavailable' as const, reason: 'read-failed' as const } }
  view.rerender(<WorkItemView {...props} {...callbacks} project={{ ...props.project,
    detail: { value: missingBody, loading: false, failure: null },
  }} />)
  expect(screen.getByText(t('planning.bodyUnavailable'))).toBeTruthy()
  expect(screen.getByText(t('planning.noDelivery'))).toBeTruthy()
  expect(screen.getByText(t('planning.noExecution'))).toBeTruthy()
  view.rerender(<WorkItemView {...props} {...callbacks} project={{ ...props.project,
    address: { ...props.project.address, returnView: 'milestone' },
    detail: { value: null, loading: false, failure: 'not-found' },
  }} />)
  expect(screen.getByRole('alert').textContent).toBe(t('planning.not-found'))
  expect(screen.getByRole('button', { name: t('planning.milestones') })).toBeTruthy()
})

it('links recorded Runs and Blockages to their Session and preserves Milestone and activity references', async () => {
  const props = await fixture()
  const detail = props.project.detail.value!
  if (detail.body.state !== 'confirmed') throw new Error('Fixture body missing')
  const run = SAKI_AGENT_RUN_PROJECTION_FIXTURES.running
  const intervention: NonNullable<PlanningProject['detail']['value']>['interventions'][number] = {
    id: 'intervention-00000000-0000-4000-8000-000000000001' as NonNullable<PlanningProject['detail']['value']>['interventions'][number]['id'],
    revision: 0, kind: 'text-input', state: 'open', targetPrincipalId: AUTH.principal.id,
    requiredAnswer: { kind: 'text', prompt: 'Confirm the release scope.', maxLength: 200 }, createdAt: 1, updatedAt: 2,
    returnAddress: { kind: 'agent-run', projectId: PROJECT_ID, workItemId: ITEM.id, workSessionId: run.workSessionId, agentRunId: run.id },
  }
  const value = { ...detail, workItem: { ...detail.workItem, notInProject: true },
    body: { ...detail.body, matchesBoard: false },
    runs: [{ id: run.id, assignmentId: run.assignmentId, workSessionId: run.workSessionId, sessionId: run.sessionId,
      state: run.state, createdAt: run.createdAt, updatedAt: run.updatedAt }],
    interventions: [intervention], milestones: [MILESTONE_SUMMARY],
    activity: [{ intentId: run.source.intentId, type: 'create-work-item' as const, state: 'succeeded' as const, createdAt: 1, updatedAt: 2 }],
    earlierActivity: true,
  }
  const openSession = vi.fn()
  const openMilestone = vi.fn()
  const view = render(<WorkItemView {...props} openSession={openSession} openMilestone={openMilestone}
    project={{ ...props.project, detail: { value, loading: false, failure: null } }} />)
  expect(screen.getByText(t('planning.bodyMismatch'))).toBeTruthy()
  expect(screen.getByText(t('planning.inboxMark'))).toBeTruthy()
  expect(screen.getByText(/Confirm the release scope/)).toBeTruthy()
  for (const button of screen.getAllByRole('button', { name: t('planning.openSession') })) fireEvent.click(button)
  expect(openSession.mock.calls).toEqual([[run.sessionId], [run.sessionId]])
  const changes = screen.getAllByRole('button', { name: t('changes.title') })
  fireEvent.click(changes[0]!)
  expect(props.actions.navigate).toHaveBeenLastCalledWith({ view: 'changes', changesRunId: null })
  fireEvent.click(changes[1]!)
  expect(props.actions.navigate).toHaveBeenLastCalledWith({ view: 'changes', changesRunId: run.id })
  fireEvent.click(screen.getByRole('button', { name: 'saki-v0.1.0' }))
  expect(openMilestone).toHaveBeenCalledWith(MILESTONE_SUMMARY.id)
  expect(screen.getByText(run.source.intentId)).toBeTruthy()
  expect(screen.getByText(t('planning.earlierActivity'))).toBeTruthy()
  view.rerender(<WorkItemView {...props} openSession={openSession} openMilestone={openMilestone}
    project={{ ...props.project, detail: { value: { ...value, runs: [], milestones: [{ ...MILESTONE_SUMMARY, title: 'Named release' }] }, loading: false, failure: null } }} />)
  expect(screen.queryByRole('button', { name: t('planning.openSession') })).toBeNull()
  expect(screen.getByRole('button', { name: 'Named release' })).toBeTruthy()
})

it('shows Milestone phase separately from unavailable scope and lets the user retain its destination', async () => {
  const props = await fixture()
  const openMilestone = vi.fn()
  const view = render(<MilestoneView {...props} openMilestone={openMilestone} />)
  expect(screen.getByText(t('planning.noMilestones'))).toBeTruthy()
  expect(screen.getByText(t('planning.chooseMilestone'))).toBeTruthy()
  const project = { ...props.project,
    address: { ...props.project.address, milestoneId: MILESTONE_SUMMARY.id },
    milestones: { value: { type: 'project-milestones' as const, projectId: PROJECT_ID, items: [MILESTONE_SUMMARY], next: null }, loading: false, failure: null },
    milestone: { value: MILESTONE, loading: false, failure: null },
  }
  view.rerender(<MilestoneView {...props} project={project} openMilestone={openMilestone} />)
  const destination = screen.getByRole('button', { name: 'saki-v0.1.0 · 推进中' })
  expect(destination.getAttribute('aria-current')).toBe('page')
  fireEvent.click(destination)
  expect(openMilestone).toHaveBeenCalledWith(MILESTONE_SUMMARY.id)
  expect(screen.getByText(t('planning.scopeUnavailable'))).toBeTruthy()
  expect(screen.getByText('a'.repeat(40))).toBeTruthy()
  expect(screen.getByText('b'.repeat(40))).toBeTruthy()
  expect(screen.getByRole('alert').textContent).toContain(t('planning.blockage.view-source'))
})

it('renders complete Milestone scope, source health, and individual repair reasons', async () => {
  const props = await fixture()
  const openMilestone = vi.fn()
  const openItem = vi.spyOn(props.actions, 'openItem').mockImplementation(() => {})
  const value = MILESTONE.milestoneView
  const milestone = value.delivery.release
  const observedMilestone = { current: { state: 'confirmed' as const, observedAt: 5 }, confirmed: { observedAt: 5, value: {
    id: milestone.milestoneId, repositoryId: milestone.repositoryId, number: 1,
    state: 'closed' as const, title: 'September release', url: 'https://example.test/milestone/1',
    updatedAt: 4, observedAt: 5, dueOn: 10, issues: [],
  } } }
  const scope = {
    scopeFingerprint: 'c'.repeat(64), boardGeneration: 2, boardFingerprint: { version: 1 as const, digest: 'd'.repeat(64) },
    total: 2, mapped: 1, unmapped: 1, unsupported: 0, complete: false,
    statusCounts: { inbox: 0, backlog: 0, ready: 1, 'in-progress': 0, 'in-review': 0, done: 0, canceled: 0 },
    items: [
      { issueId: ITEM.source.issueId, number: ITEM.issueNumber, state: ITEM.issueState,
        title: ITEM.title, url: ITEM.url, workItemId: ITEM.id, status: ITEM.status },
      { issueId: 'I_unmapped' as typeof ITEM.source.issueId, number: 28, state: 'open' as const, title: 'Unmapped issue', url: 'https://example.test/issues/28' },
    ],
  }
  const projection = { ...MILESTONE, milestoneView: { ...value, scope,
    sources: { ...value.sources, milestone: observedMilestone },
    blockages: [{ kind: 'scope-unmapped' as const, issueId: ITEM.source.issueId }],
    delivery: { ...value.delivery, repair: {
      reason: 'external-milestone-closed' as const, source: 'current-milestone' as const, observedAt: 5,
      blockages: [{ kind: 'work-item-nonterminal' as const, workItemId: ITEM.id }],
    } },
  } }
  render(<MilestoneView {...props} openMilestone={openMilestone} project={{ ...props.project,
    milestone: { value: projection, loading: false, failure: null },
    milestones: { value: { type: 'project-milestones', projectId: PROJECT_ID, items: [{ ...MILESTONE_SUMMARY, title: 'September release' }], next: null }, loading: false, failure: null },
    address: { ...props.project.address, milestoneId: MILESTONE_SUMMARY.id },
  }} />)
  expect(screen.getByRole('heading', { name: 'September release' })).toBeTruthy()
  expect(screen.getByRole('link', { name: '#28 Unmapped issue' }).getAttribute('href')).toBe('https://example.test/issues/28')
  fireEvent.click(screen.getByRole('button', { name: `#${ITEM.issueNumber} ${ITEM.title}` }))
  expect(openItem).toHaveBeenCalledWith(ITEM.id)
  expect(screen.getByRole('alert').textContent).toContain(t('planning.blockage.scope-unmapped'))
  fireEvent.click(screen.getByRole('button', { name: ITEM.title }))
  expect(openItem).toHaveBeenLastCalledWith(ITEM.id)
})

it('shows immutable release evidence and the exact Release link independently of the active Milestone', async () => {
  const props = await fixture()
  render(<MilestoneView {...props} openMilestone={vi.fn()} project={{ ...props.project,
    milestone: { value: RELEASED_MILESTONE, loading: false, failure: null },
    milestones: { value: { type: 'project-milestones', projectId: PROJECT_ID, items: [MILESTONE_SUMMARY], next: null }, loading: false, failure: null },
  }} />)
  expect(screen.getByText(t('planning.released'))).toBeTruthy()
  expect(screen.getByRole('link', { name: 'saki-v0.1.0' }).getAttribute('href')).toBe('https://example.test/releases/september')
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('button', { name: 'saki-v0.1.0 · 推进中' }).hasAttribute('aria-current')).toBe(false)
})

it('links a blocked Work Item even when the complete scope has not arrived', async () => {
  const props = await fixture()
  vi.spyOn(props.actions, 'openItem').mockImplementation(() => {})
  render(<MilestoneView {...props} openMilestone={vi.fn()} project={{ ...props.project,
    milestone: { value: { ...MILESTONE, milestoneView: { ...MILESTONE.milestoneView,
      blockages: [{ kind: 'view-source', source: 'milestone', state: 'failure' }],
      delivery: { ...MILESTONE.milestoneView.delivery, repair: {
        reason: 'external-milestone-closed', source: 'current-milestone', observedAt: 5,
        blockages: [{ kind: 'work-item-nonterminal', workItemId: ITEM.id }],
      } },
    } }, loading: false, failure: null },
  }} />)
  fireEvent.click(screen.getByRole('button', { name: t('planning.reference') }))
  expect(props.actions.openItem).toHaveBeenCalledWith(ITEM.id)
  expect(screen.getByRole('alert').textContent).toContain(t('planning.milestones'))
})

it('reports a saved mapping receipt without changing its retained Board facts', async () => {
  const props = await fixture()
  const mappingResult = sakiConfigureGitHubSynchronizationResultSchema.parse({ ok: true, receipt: {
    id: 'receipt-11111111-1111-4111-8111-111111111111', intentId: 'intent-11111111-1111-4111-8111-111111111111',
    state: 'saved', projectId: PROJECT_ID, synchronizationRevision: 2, candidateRevision: 2,
  } })
  render(<MappingView {...props} project={{ ...props.project, mappingResult }} />)
  expect(screen.getByRole('status').textContent).toBe(t('planning.mappingSaved'))
  expect(props.project.board.value?.synchronizationRevision).toBe(1)
})
