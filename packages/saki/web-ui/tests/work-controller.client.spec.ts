// @vitest-environment jsdom
/** Work request identity, independent reads, and Principal isolation. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkController } from '../src/client/work-controller.ts'
import { createWorkStore } from '../src/client/work-state.ts'
import { workFixture, MY_WORK, WORK_INDEX } from './work-fixture.client.ts'
import { AUTH, ITEM, PROJECT_ID } from './planning-fixture.client.ts'

const owners = new Set<WorkController>()
beforeEach(() => { localStorage.clear() })
afterEach(() => { for (const owner of owners) owner.dispose(); owners.clear() })
function bench(interaction?: ReturnType<ReturnType<typeof createWorkStore>['create']>) { const fixture = workFixture(interaction); owners.add(fixture.controller); return fixture }
const draft = { title: 'One durable requirement', intendedOutcome: 'Create exactly one Issue.', acceptanceCriteria: 'One Issue exists\nIt appears in Inbox' }

it('requires an explicit Project and sends the displayed revision fences', async () => {
  const f = bench(); await f.start()
  await f.controller.create(); expect(f.api.createWorkItem).not.toHaveBeenCalled()
  f.controller.selectProject(PROJECT_ID); f.controller.editDraft(draft)
  await f.controller.create(); await f.controller.create()
  expect(f.api.createWorkItem).toHaveBeenCalledTimes(1)
  expect(f.api.createWorkItem.mock.calls[0]?.[0]).toMatchObject({ projectId: PROJECT_ID, expected: { projectRevision: 2, synchronizationRevision: 1, mappingRevision: 3 }, acceptanceCriteria: ['One Issue exists', 'It appears in Inbox'] })
  const operation = f.controller.getSnapshot().operations[0]!
  expect(operation.result?.ok).toBe(true)
  expect(f.api.queryBoard).toHaveBeenLastCalledWith(PROJECT_ID, 'interactive', expect.any(AbortSignal))
  f.controller.dismiss(operation.intent.intentId)
  expect(f.controller.getSnapshot().operations).toHaveLength(0)
})

it('replays the exact unacknowledged creation across owner disposal and hydration', async () => {
  const f = bench(); await f.start()
  f.controller.selectProject(PROJECT_ID); f.controller.editDraft(draft)
  f.api.createWorkItem.mockRejectedValueOnce(new Error('response lost'))
  await f.controller.create()
  const intent = f.api.createWorkItem.mock.calls[0]![0]
  expect(f.controller.getSnapshot().operations[0]?.state).toBe('unacknowledged')
  f.controller.dismiss(intent.intentId)
  expect(f.controller.getSnapshot().operations).toHaveLength(1)
  const restoredStore = createWorkStore().create(); restoredStore.actions.hydrate(f.interaction.store.getSnapshot())
  f.controller.dispose()
  const restored = bench(restoredStore); await restored.start()
  expect(restored.controller.getSnapshot().scope.drafts[PROJECT_ID]).toEqual(draft)
  await restored.controller.create()
  expect(restored.api.createWorkItem).not.toHaveBeenCalled()
  await restored.controller.retry(intent.intentId)
  expect(restored.api.createWorkItem.mock.calls[0]?.[0]).toEqual(intent)
})

it('retains confirmed cards on transport failure and clears them on denied reads', async () => {
  const f = bench(); await f.start()
  f.api.queryMyWork.mockRejectedValueOnce(new Error('offline'))
  await f.controller.refresh()
  expect(f.controller.getSnapshot().items.value).toEqual(MY_WORK.ok ? MY_WORK.projection.items : [])
  expect(f.controller.getSnapshot().offline).toBe(true)
  f.api.queryMyWork.mockResolvedValueOnce({ ok: false, reason: 'denied' })
  await f.controller.refresh()
  expect(f.controller.getSnapshot().items.value).toBeNull()
})

it('preserves other Projects when one Board read fails', async () => {
  const f = bench()
  if (!WORK_INDEX.ok) throw new Error('fixture index denied')
  const second = { ...WORK_INDEX.projection.projects[0]!, id: 'project-0a1b2c3d-0000-4000-8000-000000000002' as typeof PROJECT_ID }
  f.api.queryProjectIndex.mockResolvedValue({
    ok: true, projection: { ...WORK_INDEX.projection, projects: [...WORK_INDEX.projection.projects, second] },
  })
  f.api.queryBoard.mockRejectedValueOnce(new Error('mapping offline'))
  await f.start()
  expect(f.controller.getSnapshot().projects.value?.map(value => value.board.failure)).toEqual(['unavailable', null])
})

it('requires explicit confirmation and preserves the shown offer despite later reads', async () => {
  const f = bench(); await f.start()
  if (!MY_WORK.ok || !MY_WORK.projection.items[0]?.recommendation.available) throw new Error('missing fixture offer')
  const offer = MY_WORK.projection.items[0].recommendation.offer
  await f.controller.submitOffer(); expect(f.api.giveWorkItemToAgent).not.toHaveBeenCalled()
  f.controller.confirm(offer)
  f.api.queryMyWork.mockResolvedValue({ ok: true, projection: { type: 'my-work', principalId: AUTH.principal.id, items: [] } })
  await f.controller.refresh(); await f.controller.submitOffer()
  expect(f.api.giveWorkItemToAgent.mock.calls[0]?.[0]).toMatchObject({
    projectId: PROJECT_ID, workItemId: ITEM.id,
    expectedProjectRevision: 2, expectedRemoteFingerprint: ITEM.remoteFingerprint,
  })
})

it('aborts the previous Principal and hides their drafts and late results', async () => {
  const f = bench(); await f.start()
  f.controller.selectProject(PROJECT_ID); f.controller.editDraft(draft)
  const held = Promise.withResolvers<Awaited<ReturnType<typeof f.api.createWorkItem>>>()
  f.api.createWorkItem.mockReturnValueOnce(held.promise)
  const pending = f.controller.create()
  f.authority.set({ access: { kind: 'bootstrap-required', message: 'Local bootstrap is required.' }, offline: false, project: null })
  await vi.waitFor(() => { expect(f.controller.getSnapshot().scope.projectId).toBeNull() })
  held.resolve({ ok: false, reason: 'denied' }); await pending
  expect(f.controller.getSnapshot().operations).toHaveLength(0)
  expect(f.api.createWorkItem.mock.calls[0]?.[2]?.aborted).toBe(true)
})

it('rejects invalid persisted Intents and ignores editing gestures without authority', async () => {
  const store = createWorkStore().create()
  store.actions.hydrate({ scopes: { [AUTH.principal.id]: { projectId: PROJECT_ID, drafts: {}, answers: {}, pending: { bad: { type: 'create-work-item' } } } } })
  expect(store.store.getSnapshot()).toEqual({ scopes: {} })
  const f = bench(store)
  f.authority.set({ access: null, offline: false, project: null }); f.controller.start()
  f.controller.selectProject(PROJECT_ID); f.controller.editDraft(draft)
  await f.controller.create(); await f.controller.refresh(); await f.controller.retry('intent-00000000-0000-4000-8000-000000000099' as Parameters<typeof f.controller.retry>[0])
  expect(f.api.queryMyWork).not.toHaveBeenCalled()
  expect(f.controller.getSnapshot().scope.projectId).toBeNull()
  f.authority.set({ access: AUTH, offline: false, project: null }); await f.start()
  f.controller.editDraft(draft)
  expect(f.controller.getSnapshot().scope.drafts).toEqual({})
  f.controller.selectProject(PROJECT_ID); await f.controller.create()
  expect(f.controller.getSnapshot().inputError).toBe(true)
  expect(f.api.createWorkItem).not.toHaveBeenCalled()
})

it('retains a failed Project index but refuses to create against that old read', async () => {
  const f = bench(); await f.start(); f.controller.selectProject(PROJECT_ID); f.controller.editDraft(draft)
  f.api.queryProjectIndex.mockRejectedValueOnce(new Error('index offline'))
  await f.controller.refresh(); await f.controller.create()
  expect(f.controller.getSnapshot().projects.value).toHaveLength(1)
  expect(f.controller.getSnapshot().projects.failure).toBe('unavailable')
  expect(f.api.createWorkItem).not.toHaveBeenCalled()
  f.api.queryProjectIndex.mockResolvedValueOnce({ ok: false, reason: 'denied' })
  await f.controller.refresh()
  expect(f.controller.getSnapshot().projects.value).toBeNull()
})

it('drops an independently denied Board and preserves an earlier Board on transport loss', async () => {
  const f = bench(); await f.start()
  const board = f.controller.getSnapshot().projects.value?.[0]?.board.value
  f.api.queryBoard.mockRejectedValueOnce(new Error('Board offline')); await f.controller.refresh()
  expect(f.controller.getSnapshot().projects.value?.[0]?.board).toMatchObject({ value: board, failure: 'unavailable' })
  f.api.queryBoard.mockResolvedValueOnce({ ok: false, reason: 'denied' }); await f.controller.refresh()
  expect(f.controller.getSnapshot().projects.value?.[0]?.board).toEqual({ value: null, loading: false, failure: 'denied' })
})

it('discards superseded successful and failed reads at both Project read stages', async () => {
  const f = bench(); await f.start()
  const items = Promise.withResolvers<Awaited<ReturnType<typeof f.api.queryMyWork>>>()
  const index = Promise.withResolvers<Awaited<ReturnType<typeof f.api.queryProjectIndex>>>()
  f.api.queryMyWork.mockReturnValueOnce(items.promise); f.api.queryProjectIndex.mockReturnValueOnce(index.promise)
  const superseded = f.controller.refresh(); await f.controller.refresh()
  items.resolve({ ok: false, reason: 'denied' }); index.resolve({ ok: false, reason: 'denied' }); await superseded
  expect(f.controller.getSnapshot().items.value).not.toBeNull(); expect(f.controller.getSnapshot().projects.value).not.toBeNull()
  const board = Promise.withResolvers<Awaited<ReturnType<typeof f.api.queryBoard>>>()
  f.api.queryBoard.mockReturnValueOnce(board.promise)
  const olderBoard = f.controller.refresh()
  await vi.waitFor(() => { expect(f.api.queryBoard.mock.results.at(-1)?.value).toBe(board.promise) })
  await f.controller.refresh(); board.resolve({ ok: false, reason: 'denied' }); await olderBoard
  expect(f.controller.getSnapshot().projects.value?.[0]?.board.failure).toBeNull()
  const failedItems = Promise.withResolvers<Awaited<ReturnType<typeof f.api.queryMyWork>>>()
  const failedIndex = Promise.withResolvers<Awaited<ReturnType<typeof f.api.queryProjectIndex>>>()
  f.api.queryMyWork.mockReturnValueOnce(failedItems.promise); f.api.queryProjectIndex.mockReturnValueOnce(failedIndex.promise)
  const discardedFailure = f.controller.refresh(); await f.controller.refresh()
  failedItems.reject(new Error('old items')); failedIndex.reject(new Error('old index')); await discardedFailure
  expect(f.controller.getSnapshot().offline).toBe(false)
})

it('refreshes changed watch cursors, skips unchanged heartbeats, and reauthenticates denial', async () => {
  const f = bench()
  type Watch = Awaited<ReturnType<typeof f.api.watchProjections>>
  const first = Promise.withResolvers<Watch>()
  const heartbeat = Promise.withResolvers<Watch>(); const denied = Promise.withResolvers<Watch>()
  f.api.watchProjections.mockReturnValueOnce(first.promise).mockReturnValueOnce(heartbeat.promise).mockReturnValueOnce(denied.promise)
  await f.start()
  const cursor = '11111111-1111-4111-8111-111111111111' as Extract<Watch, { ok: true }>['cursor']
  first.resolve({ ok: true, cursor })
  await vi.waitFor(() => { expect(f.api.watchProjections).toHaveBeenCalledTimes(2) })
  const reads = f.api.queryMyWork.mock.calls.length
  heartbeat.resolve({ ok: true, cursor })
  await vi.waitFor(() => { expect(f.api.watchProjections).toHaveBeenCalledTimes(3) })
  expect(f.api.queryMyWork).toHaveBeenCalledTimes(reads)
  denied.resolve({ ok: false, reason: 'unavailable' })
  await vi.waitFor(() => { expect(f.access.reloadAccess).toHaveBeenCalledOnce() })
})

it('exposes watch failure and resumes polling only on refresh', async () => {
  const f = bench(); const failure = Promise.withResolvers<Awaited<ReturnType<typeof f.api.watchProjections>>>()
  f.api.watchProjections.mockReturnValueOnce(failure.promise); await f.start()
  failure.reject(new Error('watch disconnected'))
  await vi.waitFor(() => { expect(f.controller.getSnapshot().offline).toBe(true) })
  expect(f.api.watchProjections).toHaveBeenCalledOnce()
  await f.controller.refresh(); expect(f.api.watchProjections).toHaveBeenCalledTimes(2)
})

it('ignores watch completion after identity replacement and late operation rejection after disposal', async () => {
  const f = bench(); const watch = Promise.withResolvers<Awaited<ReturnType<typeof f.api.watchProjections>>>()
  f.api.watchProjections.mockReturnValueOnce(watch.promise); await f.start()
  f.authority.set({ access: { ...AUTH, requestToken: 'replacement-token' }, offline: false, project: null })
  watch.resolve({ ok: false, reason: 'unavailable' })
  await vi.waitFor(() => { expect(f.api.watchProjections).toHaveBeenCalledTimes(2) })
  expect(f.access.reloadAccess).not.toHaveBeenCalled()
  f.controller.selectProject(PROJECT_ID); f.controller.editDraft(draft)
  const lost = Promise.withResolvers<Awaited<ReturnType<typeof f.api.createWorkItem>>>()
  f.api.createWorkItem.mockReturnValueOnce(lost.promise)
  await vi.waitFor(() => { expect(f.controller.getSnapshot().projects.loading).toBe(false) })
  const submitting = f.controller.create(); f.controller.dispose(); lost.reject(new Error('late rejection')); await submitting
  expect(f.controller.getSnapshot().operations[0]?.state).toBe('pending')
})

it('does not resubmit a pending offer and allows a later independent Intervention', async () => {
  const f = bench(); await f.start()
  if (!MY_WORK.ok || !MY_WORK.projection.items[0]?.recommendation.available) throw new Error('missing fixture offer')
  const offer = MY_WORK.projection.items[0].recommendation.offer
  const held = Promise.withResolvers<Awaited<ReturnType<typeof f.api.giveWorkItemToAgent>>>()
  f.api.giveWorkItemToAgent.mockReturnValueOnce(held.promise)
  f.controller.confirm(offer); const submitted = f.controller.submitOffer()
  const id = f.controller.getSnapshot().operations[0]!.intent.intentId
  await f.controller.retry(id); f.controller.confirm(offer); await f.controller.submitOffer()
  expect(f.api.giveWorkItemToAgent).toHaveBeenCalledOnce()
  held.resolve({ ok: false, reason: 'conflict' }); await submitted
  f.controller.dismiss(id)
  expect(f.controller.getSnapshot().operations).toHaveLength(0)
  const answerOffer = { type: 'answer-intervention' as const, interventionId: 'intervention-0a1b2c3d-0000-4000-8000-000000000001' as Parameters<typeof f.controller.editAnswer>[0], expectedInterventionRevision: 2, requiredAnswer: { kind: 'text' as const, prompt: 'Continue?', maxLength: 100 }, reason: 'response-required' }
  f.controller.confirm(answerOffer); await f.controller.submitOffer()
  expect(f.controller.getSnapshot().inputError).toBe(true)
  f.controller.editAnswer(answerOffer.interventionId, 'Continue.'); await f.controller.submitOffer()
  f.controller.confirm(answerOffer); await f.controller.submitOffer()
  expect(f.api.answerIntervention).toHaveBeenCalledOnce()
  const answerId = f.controller.getSnapshot().operations[0]!.intent.intentId
  f.controller.dismiss(answerId); expect(f.controller.getSnapshot().operations).toHaveLength(1)
  f.api.answerIntervention.mockResolvedValueOnce({ ok: false, reason: 'denied' }); await f.controller.retry(answerId)
  f.controller.dismiss(answerId); expect(f.controller.getSnapshot().operations).toHaveLength(0)
})
