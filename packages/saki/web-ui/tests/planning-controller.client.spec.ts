// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SakiWireAccessProjection, SakiWireBoardResult, SakiWireMoveWorkItemResult } from '@breakfastdapaidang/saki-host-api/wire'
import { SAKI_AGENT_RUN_PROJECTION_FIXTURES, SAKI_WORK_ITEM_RESULT_FIXTURES } from '@breakfastdapaidang/saki-control-plane/fixtures'
import { PlanningController } from '../src/client/planning-controller.ts'
import { createPlanningStore } from '../src/client/planning-state.ts'
import { AUTH, BOARD, ITEM, MAPPING, MAPPING_PATCH, OTHER_PROJECT_ID, PROJECT_ID, planningFixture, successfulMove } from './planning-fixture.client.ts'
import { MILESTONE, MILESTONE_SUMMARY } from './planning-evidence.client.ts'

const live = new Set<PlanningController>()
beforeEach(() => { localStorage.clear() })
afterEach(() => { for (const controller of live) controller.dispose(); live.clear() })
async function fixture() { const fixture = planningFixture(); live.add(fixture.controller); await fixture.start(); return fixture }

describe('planning object', () => {
  it('restores the Work Item and Run return context when reopening Changes', async () => {
    const { controller, api, navigation } = await fixture()
    const runId = SAKI_AGENT_RUN_PROJECTION_FIXTURES.running.id
    controller.navigate({ view: 'changes', workItemId: ITEM.id, changesRunId: runId })
    controller.dispose()
    const restored = new PlanningController(api, navigation); live.add(restored)
    await restored.reloadAccess()
    expect(restored.getSnapshot().project?.address).toMatchObject({ view: 'changes', workItemId: ITEM.id, changesRunId: runId })
    expect(restored.getSnapshot().project?.detail.value?.workItem.id).toBe(ITEM.id)
  })

  it('accepts an invalidation before the Principal has saved any planning interaction', async () => {
    const { controller, api, invalidate } = await fixture()
    invalidate()
    await vi.waitFor(() => { expect(api.watchProjections).toHaveBeenCalledTimes(2) })
    expect(controller.getSnapshot().project?.moves).toEqual([])
  })
  it('ignores rejected reads after disposal', async () => {
    const { controller, api } = await fixture()
    const held = Promise.withResolvers<SakiWireBoardResult>()
    api.queryBoard.mockImplementationOnce(() => held.promise)
    const refreshing = controller.refresh()
    controller.dispose()
    held.reject(new Error('read canceled'))
    await refreshing
    expect(controller.getSnapshot().offline).toBe(false)
  })

  it('watches a restored gesture on the selected Project without submitting it again', async () => {
    const instance = planningFixture(); live.add(instance.controller)
    const receipt = SAKI_WORK_ITEM_RESULT_FIXTURES.succeeded.receipt
    instance.interaction.actions.move(AUTH.principal.id, { type: 'move-work-item', intentId: receipt.intentId,
      projectId: PROJECT_ID, workItemId: ITEM.id, expectedRemoteFingerprint: ITEM.remoteFingerprint, targetStatus: 'done' })
    await instance.start()
    instance.invalidate()
    await vi.waitFor(() => { expect(instance.api.watchProjections).toHaveBeenCalledTimes(2) })
    expect(instance.controller.getSnapshot().project?.moves[0]?.state).toBe('unacknowledged')
    expect(instance.api.moveWorkItem).not.toHaveBeenCalled()
  })

  it('finishes an invalidation read safely when access is lost during its request', async () => {
    const { controller, api, invalidate } = await fixture()
    const held = Promise.withResolvers<SakiWireBoardResult>()
    api.queryBoard.mockImplementationOnce(() => held.promise)
    const calls = api.queryBoard.mock.calls.length
    invalidate()
    await vi.waitFor(() => { expect(api.queryBoard.mock.calls.length).toBeGreaterThan(calls) })
    api.readAccess.mockResolvedValue({ kind: 'session-required', message: 'A local browser session is required.' })
    await controller.reloadAccess()
    held.resolve({ ok: true, projection: BOARD })
    await held.promise
    expect(controller.getSnapshot().project).toBeNull()
  })
  it('discards superseded access errors and retains authenticated identity through a transport outage', async () => {
    const { controller, api } = await fixture()
    const older = Promise.withResolvers<SakiWireAccessProjection>()
    api.readAccess.mockImplementationOnce(() => older.promise)
    const pending = controller.reloadAccess()
    await controller.reloadAccess()
    older.reject(new Error('obsolete failure'))
    await pending
    expect(controller.getSnapshot().offline).toBe(false)
    api.readAccess.mockRejectedValueOnce(new Error('network failed'))
    await controller.reloadAccess()
    expect(controller.getSnapshot()).toMatchObject({ access: AUTH, offline: true })
  })

  it('captures an existing predecessor and rejects anchors that disappeared before submission', async () => {
    const { controller, api, board } = await fixture()
    const anchor = { ...ITEM, id: `work-item-${'9'.repeat(64)}` as typeof ITEM.id, issueNumber: 99 }
    await controller.move(ITEM.id, ITEM.remoteFingerprint, 'ready', { id: anchor.id, fingerprint: anchor.remoteFingerprint })
    expect(api.moveWorkItem).not.toHaveBeenCalled()
    board({ ...BOARD, confirmed: { ...BOARD.confirmed!, items: [ITEM, anchor] } })
    await controller.refresh()
    await controller.drop(`${ITEM.id} ${ITEM.remoteFingerprint}`, 'ready', anchor)
    expect(api.moveWorkItem.mock.calls.at(-1)?.[0].position).toEqual({
      afterWorkItemId: anchor.id, expectedAfterRemoteFingerprint: anchor.remoteFingerprint,
    })
  })

  it.each(['conflict', 'denied', 'canceled', 'unavailable', 'partial'] as const)('settles or retains %s move receipts according to their durable outcome', async (outcome) => {
    const { controller, api } = await fixture()
    const success = successfulMove({ type: 'move-work-item', projectId: PROJECT_ID, workItemId: ITEM.id,
      intentId: SAKI_WORK_ITEM_RESULT_FIXTURES.succeeded.receipt.intentId,
      expectedRemoteFingerprint: ITEM.remoteFingerprint, targetStatus: 'done' })
    if (!success.ok) throw new Error('Success fixture unavailable')
    const receipt = { id: success.receipt.id, intentId: success.receipt.intentId, projectId: PROJECT_ID, type: 'move-work-item' as const, workItemId: ITEM.id }
    api.moveWorkItem.mockResolvedValueOnce(outcome === 'conflict' ? SAKI_WORK_ITEM_RESULT_FIXTURES.conflict
      : outcome === 'denied' ? { ok: false, reason: 'denied' }
        : outcome === 'canceled' ? { ok: false, reason: 'canceled', receipt: { ...receipt, state: 'canceled', reason: 'authority-revoked' } }
          : outcome === 'partial' ? { ok: false, reason: 'unavailable', receipt: { ...receipt, state: 'partial-failure', stage: 'project-item-status-set', recoveryAction: { kind: 'resume-intent' } } }
            : { ok: false, reason: 'unavailable' })
    await controller.move(ITEM.id, ITEM.remoteFingerprint, 'done')
    expect(controller.getSnapshot().project?.moves[0]?.state).toBe(outcome === 'partial' || outcome === 'unavailable' ? 'unacknowledged' : 'settled')
  })

  it.each(['resolve', 'reject'] as const)('ignores a move %s after its authority is revoked', async (outcome) => {
    const { controller, api } = await fixture()
    const held = Promise.withResolvers<SakiWireMoveWorkItemResult>()
    api.moveWorkItem.mockImplementationOnce(() => held.promise)
    const pending = controller.move(ITEM.id, ITEM.remoteFingerprint, 'done')
    const intent = api.moveWorkItem.mock.calls[0]![0]
    api.readAccess.mockResolvedValue({ kind: 'session-required', message: 'A local browser session is required.' })
    await controller.reloadAccess()
    if (outcome === 'resolve') held.resolve(successfulMove(intent)); else held.reject(new Error('request aborted'))
    await pending
    expect(controller.getSnapshot().project).toBeNull()
    expect(controller.getSnapshot().offline).toBe(false)
  })

  it.each(['resolve', 'reject'] as const)('ignores a mapping %s after its authority is revoked', async (outcome) => {
    const { controller, api } = await fixture()
    api.queryProjectMapping.mockResolvedValue(MAPPING)
    controller.navigate({ view: 'mapping' })
    await vi.waitFor(() => { expect(controller.getSnapshot().project?.mapping.value).not.toBeNull() })
    const held = Promise.withResolvers<Awaited<ReturnType<typeof api.configureGitHubSynchronization>>>()
    api.configureGitHubSynchronization.mockImplementationOnce(() => held.promise)
    const pending = controller.repairMapping(MAPPING_PATCH)
    api.readAccess.mockResolvedValue({ kind: 'session-required', message: 'A local browser session is required.' })
    await controller.reloadAccess()
    if (outcome === 'resolve') held.resolve({ ok: false, reason: 'unavailable' }); else held.reject(new Error('request aborted'))
    await pending
    expect(controller.getSnapshot().project).toBeNull()
  })

  it('reads every Milestone page and retains the complete list when a later page fails', async () => {
    const { controller, api } = await fixture()
    const last = { ...MILESTONE_SUMMARY, id: 'M_second' as typeof MILESTONE_SUMMARY.id, title: 'Second milestone' }
    api.queryProjectMilestones.mockImplementation(async (projectId, after) => ({ ok: true, projection: {
      type: 'project-milestones', projectId, items: after === null ? [MILESTONE_SUMMARY] : [last], next: after === null ? MILESTONE_SUMMARY.id : null,
    } }))
    await controller.refresh()
    expect(controller.getSnapshot().project?.milestones.value?.items).toEqual([MILESTONE_SUMMARY, last])
    api.queryProjectMilestones.mockResolvedValue({ ok: false, reason: 'unavailable' })
    await controller.refresh()
    expect(controller.getSnapshot().project?.milestones).toMatchObject({ failure: 'unavailable', value: { items: [MILESTONE_SUMMARY, last] } })
  })

  it('refreshes offscreen pending Projects and reports a failed watch without losing their Intents', async () => {
    const { controller, api, navigation, invalidate, failWatch } = await fixture()
    api.moveWorkItem.mockResolvedValueOnce({ ok: false, reason: 'unavailable' })
    await controller.move(ITEM.id, ITEM.remoteFingerprint, 'done')
    navigation.actions.selectProject(OTHER_PROJECT_ID)
    api.queryBoard.mockClear()
    invalidate('00000000-0000-4000-8000-000000000001')
    await vi.waitFor(() => { expect(api.queryBoard.mock.calls.some(([id]) => id === PROJECT_ID)).toBe(true) })
    await vi.waitFor(() => { expect(api.watchProjections.mock.calls.at(-1)?.[0]).toBe('00000000-0000-4000-8000-000000000001') })
    failWatch()
    await vi.waitFor(() => { expect(controller.getSnapshot().offline).toBe(true) })
    navigation.actions.selectProject(PROJECT_ID)
    expect(controller.getSnapshot().project?.moves[0]?.state).toBe('unacknowledged')
  })

  it('finishes a remote Milestone refresh when Board invalidation requests a cached reread', async () => {
    const { controller, api, invalidate } = await fixture()
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof api.queryMilestoneView>>>()
    let refreshSignal: AbortSignal | undefined
    api.queryMilestoneView.mockImplementation(async (_project, _milestone, refresh, signal) => {
      if (refresh === 'interactive') { refreshSignal = signal; return await pending.promise }
      return { ok: true, projection: MILESTONE }
    })
    controller.navigate({ view: 'milestone', milestoneId: MILESTONE_SUMMARY.id })
    const refreshing = controller.refresh()
    await vi.waitFor(() => { expect(refreshSignal).toBeDefined() })
    const reads = api.queryBoard.mock.calls.length
    invalidate()
    await vi.waitFor(() => { expect(api.queryBoard.mock.calls.length).toBeGreaterThan(reads) })
    expect(refreshSignal?.aborted).toBe(false)
    pending.resolve({ ok: true, projection: { ...MILESTONE, refresh: { requested: 'interactive', state: 'confirmed' } } })
    await refreshing
    expect(controller.getSnapshot().project?.milestone.value?.refresh.state).toBe('confirmed')
  })
  it('retains a mapping repair across reload and replays the exact revision after a lost response', async () => {
    const { controller, api, navigation } = await fixture()
    api.queryProjectMapping.mockResolvedValue(MAPPING)
    controller.navigate({ view: 'mapping' })
    await vi.waitFor(() => { expect(controller.getSnapshot().project!.mapping.value).not.toBeNull() })
    api.configureGitHubSynchronization.mockRejectedValueOnce(new Error('response lost'))
    await controller.repairMapping(MAPPING_PATCH)
    const intent = api.configureGitHubSynchronization.mock.calls[0]![0]
    expect(controller.getSnapshot().project!.mappingResult).toBe('unacknowledged')
    await controller.repairMapping(MAPPING_PATCH)
    expect(api.configureGitHubSynchronization).toHaveBeenCalledOnce()
    controller.dispose()
    const restored = new PlanningController(api, navigation); live.add(restored)
    await restored.reloadAccess()
    expect(restored.getSnapshot().project!.mappingResult).toBe('unacknowledged')
    api.configureGitHubSynchronization.mockResolvedValueOnce({ ok: false, reason: 'conflict' })
    await restored.retryMapping()
    expect(api.configureGitHubSynchronization.mock.calls.at(-1)?.[0]).toEqual(intent)
    expect(restored.getSnapshot().project!.mappingResult).toEqual({ ok: false, reason: 'conflict' })
    await restored.retryMapping()
    expect(api.configureGitHubSynchronization).toHaveBeenCalledTimes(2)
  })

  it('ignores obsolete protected operations and makes inactive address actions harmless', async () => {
    const { controller, api, navigation } = await fixture()
    navigation.actions.clearProject()
    controller.navigate({ view: 'mapping' }); controller.openItem(ITEM.id); controller.beginMove(ITEM)
    controller.closeMove(); controller.closeDetail(); controller.backToBoard()
    await controller.refresh(); await controller.retryMapping(); await controller.repairMapping(MAPPING_PATCH)
    expect(controller.getSnapshot().project).toBeNull()
    navigation.actions.selectProject(PROJECT_ID)
    api.readAccess.mockResolvedValue({ kind: 'session-required', message: 'A local browser session is required.' })
    await controller.reloadAccess()
    await controller.retryMove('missing'); await controller.refresh()
    expect(api.moveWorkItem).not.toHaveBeenCalled()
    expect(api.configureGitHubSynchronization).not.toHaveBeenCalled()
  })

  it('reports initial access transport failure and allows an explicit retry', async () => {
    const instance = planningFixture(); live.add(instance.controller)
    instance.api.readAccess.mockRejectedValueOnce(new Error('network unavailable'))
    await instance.controller.reloadAccess()
    expect(instance.controller.getSnapshot()).toMatchObject({ access: 'unavailable', offline: true })
    await instance.controller.refresh()
    expect(instance.controller.getSnapshot()).toMatchObject({ access: AUTH, offline: false })
  })
  it('retains a complete Board across scan and transport failure and ignores superseded responses', async () => {
    const { controller, api } = await fixture()
    const retained = controller.getSnapshot().project!.board.value
    const older = Promise.withResolvers<SakiWireBoardResult>()
    api.queryBoard.mockImplementationOnce(() => older.promise)
    const first = controller.refresh()
    await vi.waitFor(() =>{  expect(controller.getSnapshot().project!.board.loading).toBe(true) })
    api.queryBoard.mockRejectedValueOnce(new Error('offline'))
    const second = controller.refresh()
    await second
    expect(controller.getSnapshot().project!.board.value).toEqual(retained)
    older.resolve({ ok: true, projection: { ...BOARD, state: 'awaiting-first-checkpoint', confirmed: undefined } })
    await first
    expect(controller.getSnapshot().project!.board.value?.confirmed).toEqual(BOARD.confirmed)
    controller.dispose()
    const snapshot = controller.getSnapshot()
    await controller.reloadAccess()
    expect(controller.getSnapshot()).toBe(snapshot)
  })

  it('captures the rendered source and predecessor fingerprints for both keyboard and drag moves', async () => {
    const { controller, api, board } = await fixture()
    controller.beginMove(ITEM)
    expect(controller.getSnapshot().project!.address.moveDraft?.expectedRemoteFingerprint).toBe(ITEM.remoteFingerprint)
    const remote = { ...ITEM, remoteFingerprint: `remote-fingerprint-${'f'.repeat(64)}` as typeof ITEM.remoteFingerprint }
    board({ ...BOARD, confirmed: { ...BOARD.confirmed!, items: [remote] } })
    await controller.refresh()
    await controller.move(ITEM.id, ITEM.remoteFingerprint, 'in-progress', null)
    expect(api.moveWorkItem.mock.calls.at(-1)?.[0]).toMatchObject({ expectedRemoteFingerprint: ITEM.remoteFingerprint, targetStatus: 'in-progress', position: { afterWorkItemId: null } })
    await controller.drop(`${ITEM.id} ${ITEM.remoteFingerprint}`, 'in-review', null)
    expect(api.moveWorkItem.mock.calls.at(-1)?.[0]).toMatchObject({ expectedRemoteFingerprint: ITEM.remoteFingerprint, targetStatus: 'in-review' })
    const count = api.moveWorkItem.mock.calls.length
    await controller.drop('not-an-item', 'done', null)
    await controller.drop(`${ITEM.id} ${ITEM.remoteFingerprint} extra`, 'done', null)
    expect(api.moveWorkItem).toHaveBeenCalledTimes(count)
    controller.closeMove()
    expect(controller.getSnapshot().project!.address.moveDraft).toBeNull()
  })

  it('keeps the exact unacknowledged move across Project switches and reload, then retries with the current token', async () => {
    const { controller, api, navigation } = await fixture()
    api.moveWorkItem.mockRejectedValueOnce(new Error('response lost'))
    await controller.move(ITEM.id, ITEM.remoteFingerprint, 'ready')
    const intent = api.moveWorkItem.mock.calls[0]![0]
    expect(controller.getSnapshot().project!.moves[0]!.state).toBe('unacknowledged')
    navigation.actions.selectProject(OTHER_PROJECT_ID)
    expect(controller.getSnapshot().project!.moves).toEqual([])
    controller.dispose()
    const restored = new PlanningController(api, navigation, createPlanningStore().create()); live.add(restored)
    api.readAccess.mockResolvedValue({ ...AUTH, requestToken: 'request-after-reload' })
    restored.start()
    await vi.waitFor(() =>{  expect(restored.getSnapshot().access).toMatchObject({ kind: 'authenticated' }) })
    navigation.actions.selectProject(PROJECT_ID)
    expect(restored.getSnapshot().project!.moves[0]!.intent).toEqual(intent)
    await restored.retryMove(intent.intentId)
    expect(api.moveWorkItem.mock.calls.at(-1)?.slice(0, 2)).toEqual([intent, 'request-after-reload'])
    expect(restored.getSnapshot().project!.moves[0]!.state).toBe('settled')
    expect(createPlanningStore().create().store.getSnapshot().scopes[AUTH.principal.id]?.pendingMoves).toEqual({})
  })

  it('keeps a pending result on its owning Project and rejects a second gesture until it settles', async () => {
    const { controller, api, navigation } = await fixture()
    const response = Promise.withResolvers<SakiWireMoveWorkItemResult>()
    api.moveWorkItem.mockImplementationOnce(() => response.promise)
    const pending = controller.move(ITEM.id, ITEM.remoteFingerprint, 'done')
    const intent = api.moveWorkItem.mock.calls[0]![0]
    await controller.move(ITEM.id, ITEM.remoteFingerprint, 'canceled')
    expect(api.moveWorkItem).toHaveBeenCalledOnce()
    navigation.actions.selectProject(OTHER_PROJECT_ID)
    response.resolve(successfulMove(intent)); await pending
    expect(controller.getSnapshot().project!.id).toBe(OTHER_PROJECT_ID)
    expect(controller.getSnapshot().project!.moves).toEqual([])
    navigation.actions.selectProject(PROJECT_ID)
    expect(controller.getSnapshot().project!.moves[0]!.result).toMatchObject({ ok: true })
  })

  it('clears protected facts on access loss and keeps another Principal away from retained Intents', async () => {
    const { controller, api, invalidate } = await fixture()
    controller.openItem(ITEM.id)
    await vi.waitFor(() =>{  expect(controller.getSnapshot().project!.detail.value).not.toBeNull() })
    api.readAccess.mockResolvedValue({ kind: 'session-required', message: 'A local browser session is required.' })
    api.watchProjections.mockResolvedValueOnce({ ok: false, reason: 'unavailable' })
    invalidate()
    await vi.waitFor(() =>{  expect(controller.getSnapshot().access).toMatchObject({ kind: 'session-required' }) })
    expect(controller.getSnapshot().project).toBeNull()
    await controller.move(ITEM.id, ITEM.remoteFingerprint, 'done')
    expect(api.moveWorkItem).not.toHaveBeenCalled()
    await controller.exchangeBootstrap('secret')
    expect(controller.getSnapshot().access).toMatchObject({ kind: 'authenticated' })
    controller.navigate({ view: 'milestone', milestoneId: 'M_fixture' as NonNullable<ReturnType<typeof controller.getSnapshot>['project']>['address']['milestoneId'] })
    await vi.waitFor(() =>{  expect(api.queryMilestoneView).toHaveBeenCalled() })
    expect(api.queryMilestoneView.mock.calls[0]?.[2]).toBe('cached')
    controller.openItem(ITEM.id); controller.closeDetail()
    expect(controller.getSnapshot().project!.address.view).toBe('milestone')
    controller.backToBoard()
    expect(controller.getSnapshot().project!.address.view).toBe('board')
  })
})
