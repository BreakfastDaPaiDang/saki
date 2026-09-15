// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SAKI_AGENT_RUN_VIEW_PROJECTION_FIXTURE as run, SAKI_PROJECT_SESSIONS_PROJECTION_FIXTURE as sessions } from '@breakfastdapaidang/saki-control-plane/fixtures'
import { PlanningController } from '../src/client/planning-controller.ts'
import { AUTH, MAPPING, OTHER_PROJECT_ID, PROJECT_ID, planningFixture } from './planning-fixture.client.ts'
import { MILESTONE, MILESTONE_SUMMARY } from './planning-evidence.client.ts'
import type { SakiWireAgentRunViewResult } from '@breakfastdapaidang/saki-host-api/wire'

const live = new Set<PlanningController>()
beforeEach(() => { localStorage.clear() })
afterEach(() => { for (const owner of live) owner.dispose(); live.clear() })
async function fixture() {
  const f = planningFixture(); live.add(f.controller)
  f.api.queryAgentRunView.mockResolvedValue({ ok: true, projection: run })
  f.api.queryProjectSessions.mockResolvedValue({ ok: true, projection: sessions })
  await f.start()
  return f
}
const selected = { view: 'run' as const, agentRunId: run.run.id, workItemId: run.workSession.workItem.id, runTab: 'trace' as const,
  runReferencesOpen: true, conversationSessionId: run.run.sessionId }

it('retains the exact Run and details through Conversation, reconnect, reload and Principal changes', async () => {
  const f = await fixture()
  f.controller.navigate(selected)
  await vi.waitFor(() => { expect(f.controller.getSnapshot().project?.run.value).toEqual(run) })
  f.navigation.actions.clearSurface()
  f.invalidate()
  await vi.waitFor(() => { expect(f.api.watchProjections).toHaveBeenCalledTimes(2) })
  const reads = f.api.queryAgentRunView.mock.calls.length
  f.controller.dispose()
  const restored = new PlanningController(f.api, f.navigation); live.add(restored)
  await restored.reloadAccess()
  expect(restored.getSnapshot().project?.address).toMatchObject(selected)
  expect(f.api.queryAgentRunView).toHaveBeenCalledTimes(reads)
  f.navigation.actions.showProject()
  await vi.waitFor(() => { expect(restored.getSnapshot().project?.run.value).toEqual(run) })
  f.api.readAccess.mockResolvedValue({ ...AUTH, principal: { ...AUTH.principal, id: 'principal-11111111-1111-4111-8111-111111111111' as typeof AUTH.principal.id } })
  await restored.reloadAccess()
  expect(restored.getSnapshot().project?.address).toMatchObject({ view: 'board', agentRunId: null, conversationSessionId: null })
  expect(restored.getSnapshot().project?.run.value).toBeNull()
  f.api.readAccess.mockResolvedValue(AUTH)
  await restored.reloadAccess()
  expect(restored.getSnapshot().project?.address).toMatchObject(selected)
})
it('rereads selected DSH execution after an unchanged watch heartbeat', async () => {
  const f = await fixture()
  f.controller.navigate(selected)
  await vi.waitFor(() => { expect(f.controller.getSnapshot().project?.run.value).toEqual(run) })
  f.invalidate('11111111-1111-4111-8111-111111111111')
  await vi.waitFor(() => { expect(f.api.watchProjections).toHaveBeenCalledTimes(2) })
  const succeeded = { ...run, status: 'succeeded' as const, observation: { ...run.observation,
    session: { state: 'confirmed' as const, runtime: 'idle' as const, activity: { state: 'succeeded' as const, turn: 2, endedAt: 200 } } } }
  f.api.queryAgentRunView.mockResolvedValue({ ok: true, projection: succeeded })
  f.invalidate('11111111-1111-4111-8111-111111111111')
  await vi.waitFor(() => { expect(f.controller.getSnapshot().project?.run.value?.status).toBe('succeeded') })
  expect(f.api.moveWorkItem).not.toHaveBeenCalled()
})
it('refreshes cached execution references when returning from Work after an off-page invalidation', async () => {
  const f = await fixture()
  f.controller.openItem(run.workSession.workItem.id)
  await vi.waitFor(() => { expect(f.controller.getSnapshot().project?.detail.value).not.toBeNull() })
  const detail = f.controller.getSnapshot().project!.detail.value!
  f.navigation.actions.showWork()
  f.invalidate()
  await vi.waitFor(() => { expect(f.api.watchProjections).toHaveBeenCalledTimes(2) })
  const refreshed = { ...detail, runs: [{
    id: run.run.id, state: run.run.state, sessionId: run.run.sessionId, updatedAt: run.run.updatedAt,
    assignmentId: run.workSession.assignment.id, workSessionId: run.workSession.id, createdAt: run.run.createdAt,
  }] }
  f.api.queryWorkItemView.mockResolvedValue({ ok: true, projection: refreshed })
  f.navigation.actions.showProject()
  f.controller.openItem(run.workSession.workItem.id)
  await vi.waitFor(() => { expect(f.controller.getSnapshot().project?.detail.value?.runs).toEqual(refreshed.runs) })
})
it('keeps paged Session and Terminal addresses isolated and ignores late reads after access loss', async () => {
  const f = await fixture()
  f.controller.navigate({ view: 'sessions', sessionsWorkItemId: run.workSession.workItem.id, sessionsAfter: run.workSession.id })
  await vi.waitFor(() => { expect(f.api.queryProjectSessions).toHaveBeenCalled() })
  expect(f.api.queryProjectSessions.mock.lastCall?.[0]).toEqual({ type: 'project-sessions', projectId: PROJECT_ID, workItemId: run.workSession.workItem.id, after: run.workSession.id })
  const held = Promise.withResolvers<SakiWireAgentRunViewResult>()
  f.api.queryAgentRunView.mockImplementationOnce(() => held.promise)
  f.controller.navigate({ ...selected, dispatchAfter: run.dispatches[0]!.id, runTab: 'terminal', terminal: { id: 'terminal-current:pty-1' as NonNullable<Parameters<typeof f.api.queryAgentRunView>[0]['terminal']>['id'], offset: 80 } })
  await vi.waitFor(() => { expect(f.api.queryAgentRunView).toHaveBeenCalledOnce() })
  const query = f.api.queryAgentRunView.mock.lastCall![0]
  expect(query).toMatchObject({ afterDispatch: run.dispatches[0]!.id, terminal: { id: 'terminal-current:pty-1', offset: 80 } })
  f.navigation.actions.selectProject(OTHER_PROJECT_ID)
  expect(f.controller.getSnapshot().project?.run.value).toBeNull()
  f.api.readAccess.mockResolvedValue({ kind: 'session-required', message: 'A local browser session is required.' })
  await f.controller.reloadAccess()
  expect(f.api.queryAgentRunView.mock.lastCall![1]?.aborted).toBe(true)
  held.resolve({ ok: true, projection: run })
  await held.promise
  expect(f.controller.getSnapshot().project).toBeNull()
})
it('retains a failed read with its age and clears it on a denied or missing Run response', async () => {
  const f = await fixture(); f.controller.navigate(selected)
  await vi.waitFor(() => { expect(f.controller.getSnapshot().project?.run.value).toEqual(run) })
  f.api.queryAgentRunView.mockRejectedValueOnce(new Error('transport lost'))
  await f.controller.refresh()
  expect(f.controller.getSnapshot().project?.run).toMatchObject({ value: run, failure: 'offline', loading: false })
  f.api.queryAgentRunView.mockResolvedValue({ ok: false, reason: 'not-found' })
  await f.controller.refresh()
  expect(f.controller.getSnapshot().project?.run).toEqual({ value: null, failure: 'not-found', loading: false })
})

it('hydrates bounded cursors and Terminal offsets from the same Principal address', async () => {
  const f = await fixture()
  const address = { ...selected, sessionsAfter: run.workSession.id, dispatchAfter: run.dispatches[0]!.id,
    terminal: { id: 'terminal-current:pty-1' as NonNullable<Parameters<typeof f.api.queryAgentRunView>[0]['terminal']>['id'], offset: 80 } }
  f.controller.navigate(address); f.controller.dispose()
  const restored = new PlanningController(f.api, f.navigation); live.add(restored)
  await restored.reloadAccess()
  expect(restored.getSnapshot().project?.address).toMatchObject(address)
})

it('reuses cached detail reads for same-page display gestures and refreshes after reentry', async () => {
  const f = await fixture()
  f.api.queryMilestoneView.mockResolvedValue({ ok: true, projection: MILESTONE })
  f.api.queryProjectMapping.mockResolvedValue(MAPPING)
  const cases = [
    { address: { view: 'detail' as const, workItemId: run.workSession.workItem.id }, read: f.api.queryWorkItemView },
    { address: { view: 'milestone' as const, milestoneId: MILESTONE_SUMMARY.id }, read: f.api.queryMilestoneView },
    { address: { view: 'sessions' as const }, read: f.api.queryProjectSessions },
    { address: { view: 'mapping' as const }, read: f.api.queryProjectMapping },
  ]
  for (const { address, read } of cases) {
    f.controller.navigate(address)
    await vi.waitFor(() => { expect(read).toHaveBeenCalledOnce() })
    f.controller.navigate({ runReferencesOpen: true })
    expect(read).toHaveBeenCalledOnce()
    f.controller.navigate({ view: 'board' })
    f.controller.navigate(address)
    await vi.waitFor(() => { expect(read).toHaveBeenCalledTimes(2) })
  }
})
