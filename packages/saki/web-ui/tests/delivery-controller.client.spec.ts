// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { sakiBranchDeliveryIntentResultSchema } from '@breakfastdapaidang/saki-host-api/wire'
import { deliverySettled } from '../src/client/delivery-controller.ts'
import { createDeliveryStore, deliveryIntentSchema } from '../src/client/delivery-state.ts'
import { AUTH, ITEM, OTHER_PROJECT_ID } from './planning-fixture.client.ts'
import { DELIVERY, DELIVERY_PROJECT, DELIVERY_WORKSPACE, deliveryFixture, deliveryResult } from './delivery-fixture.client.ts'

const owners = new Set<{ dispose: () => void }>()
beforeEach(() => { localStorage.clear() })
afterEach(() => { for (const owner of owners) owner.dispose(); owners.clear() })
function bench(interaction = createDeliveryStore().create()) { const f = deliveryFixture(interaction); owners.add(f.controller); return f }

it('freezes all six gestures before dispatch and preserves their exact revisions and text', async () => {
  const f = bench(); await f.start()
  f.controller.editDraft({ headRef: 'feature/delivery', baseRef: 'master', title: 'Deliver this change', body: 'Refs #46\n\nReviewed content.' })
  const pairs = [
    ['save', f.api.saveBranchDelivery], ['push', f.api.pushBranchDelivery], ['create', f.api.createBranchDeliveryPullRequest],
    ['associate', f.api.associateBranchDeliveryPullRequest], ['review', f.api.markBranchDeliveryInReview], ['accept', f.api.acceptBranchDelivery],
  ] as const
  for (const [gesture, api] of pairs) {
    f.controller.prepare(gesture)
    const confirmation = f.controller.getSnapshot().confirmation
    expect(confirmation).not.toBeNull(); expect(api).not.toHaveBeenCalled()
    expect(confirmation?.summary.repository).toBe('BreakfastDaPaiDang/saki')
    await f.controller.confirm()
    expect(api.mock.calls[0]?.[0]).toEqual(confirmation?.request)
    expect(api.mock.calls[0]?.[1]).toBe(AUTH.requestToken)
    expect(f.controller.getSnapshot().operation?.result).toMatchObject({ receipt: { state: 'succeeded' } })
    f.controller.dismiss()
  }
  expect(f.api.saveBranchDelivery.mock.calls[0]?.[0]).toMatchObject({ headRef: 'refs/heads/feature/delivery', baseRef: 'refs/heads/master', expected: DELIVERY_WORKSPACE.selection?.expected })
  expect(f.api.createBranchDeliveryPullRequest.mock.calls[0]?.[0]).toMatchObject({ title: 'Deliver this change', body: 'Refs #46\n\nReviewed content.' })
  expect(f.planning.refresh).toHaveBeenCalledTimes(2)
})

it.each(['push', 'create'] as const)('retains %s after response loss and replays the original payload after reload', async (gesture) => {
  const store = createDeliveryStore().create(); const f = bench(store); await f.start()
  const api = gesture === 'push' ? f.api.pushBranchDelivery : f.api.createBranchDeliveryPullRequest
  api.mockRejectedValueOnce(new Error('response lost'))
  f.controller.editDraft({ title: 'Original title', body: 'Original body' }); f.controller.prepare(gesture)
  const original = f.controller.getSnapshot().confirmation
  await f.controller.confirm()
  f.controller.dismiss(); f.controller.editDraft({ title: 'Changed text' }); f.controller.prepare('save')
  expect(f.controller.getSnapshot().operation?.result).toBeNull()
  expect(f.controller.getSnapshot().confirmation).toBeNull()
  expect(f.controller.getSnapshot().draft.title).toBe('Original title')
  f.controller.dispose()
  const restored = bench(store); await restored.start()
  await restored.controller.retry()
  const replay = gesture === 'push' ? restored.api.pushBranchDelivery : restored.api.createBranchDeliveryPullRequest
  expect(replay.mock.calls[0]?.[0]).toEqual(original?.request)
  expect(restored.controller.getSnapshot().operation?.confirmation.summary).toEqual(original?.summary)
  restored.controller.dismiss(); expect(restored.controller.getSnapshot().operation).toBeNull()
})

it('keeps pending and reconciliation receipts locked while allowing exact recovery', async () => {
  const f = bench(); await f.start(); f.controller.prepare('push')
  const request = f.controller.getSnapshot().confirmation!.request
  f.api.pushBranchDelivery.mockResolvedValueOnce(deliveryResult(request, 'pending'))
  await f.controller.confirm(); f.controller.dismiss()
  expect(f.controller.getSnapshot().operation).not.toBeNull()
  f.api.pushBranchDelivery.mockResolvedValueOnce(sakiBranchDeliveryIntentResultSchema.parse({ ok: false, reason: 'reconciliation-required', receipt: { intentId: request.intentId, deliveryId: DELIVERY.delivery.id, state: 'reconciliation-required' } }))
  await f.controller.retry(); f.controller.dismiss()
  expect(f.controller.getSnapshot().operation?.result).toMatchObject({ reason: 'reconciliation-required' })
  await f.controller.retry()
  expect(f.api.pushBranchDelivery.mock.calls.every(call => JSON.stringify(call[0]) === JSON.stringify(request))).toBe(true)
  f.controller.dismiss(); expect(f.controller.getSnapshot().operation).toBeNull()
})

it('retains one Project request while navigating Work Items and never attaches it to another Project', async () => {
  const f = bench(); await f.start()
  const held = Promise.withResolvers<Awaited<ReturnType<typeof f.api.pushBranchDelivery>>>()
  f.api.pushBranchDelivery.mockReturnValueOnce(held.promise)
  f.controller.prepare('push'); const pending = f.controller.confirm()
  const otherItem = `work-item-${'9'.repeat(64)}` as typeof ITEM.id
  f.authority.set({ access: AUTH, offline: false, project: {
    ...DELIVERY_PROJECT, address: { ...DELIVERY_PROJECT.address, workItemId: otherItem },
  } })
  expect(f.controller.getSnapshot().operation?.confirmation.workItemId).toBe(ITEM.id)
  f.controller.prepare('create'); expect(f.controller.getSnapshot().confirmation).toBeNull()
  f.authority.set({ access: AUTH, offline: false, project: { ...DELIVERY_PROJECT, id: OTHER_PROJECT_ID } })
  held.resolve({ ok: false, reason: 'unavailable' }); await pending
  expect(f.api.pushBranchDelivery.mock.calls[0]?.[2]?.aborted).toBe(false)
  expect(f.controller.getSnapshot().operation).toBeNull()
  f.authority.set({ access: AUTH, offline: false, project: DELIVERY_PROJECT })
  expect(f.controller.getSnapshot().operation?.result).toEqual({ ok: false, reason: 'unavailable' })
})

it('hides prior Principal drafts and ignores their late mutation response after authority changes', async () => {
  const f = bench(); await f.start()
  const held = Promise.withResolvers<Awaited<ReturnType<typeof f.api.createBranchDeliveryPullRequest>>>()
  f.api.createBranchDeliveryPullRequest.mockReturnValueOnce(held.promise)
  f.controller.editDraft({ title: 'Private draft' }); f.controller.prepare('create'); const pending = f.controller.confirm()
  f.authority.set({ access: { kind: 'session-required', message: 'A local browser session is required.' }, offline: false, project: null })
  held.resolve({ ok: false, reason: 'denied' }); await pending
  expect(f.controller.getSnapshot().draft.title).toBeNull(); expect(f.controller.getSnapshot().operation).toBeNull()
  expect(f.api.createBranchDeliveryPullRequest.mock.calls[0]?.[2]?.aborted).toBe(true)
  f.authority.set({ access: { ...AUTH, requestToken: 'new-token' }, offline: false, project: DELIVERY_PROJECT })
  await f.controller.retry()
  expect(f.api.createBranchDeliveryPullRequest.mock.calls[1]?.[1]).toBe('new-token')
  expect(f.controller.getSnapshot().draft.title).toBe('Private draft')
})

it('protects an interactive read from invalidation and cancels superseded reads', async () => {
  const f = bench(); await f.start()
  const held = Promise.withResolvers<Awaited<ReturnType<typeof f.api.queryDeliveryWorkspace>>>()
  f.api.queryDeliveryWorkspace.mockReturnValueOnce(held.promise)
  const pending = f.controller.refresh()
  const count = f.api.queryDeliveryWorkspace.mock.calls.length
  await f.controller.refresh('cached'); expect(f.api.queryDeliveryWorkspace.mock.calls).toHaveLength(count)
  await f.controller.refresh()
  held.resolve({ ok: false, reason: 'denied' }); await pending
  expect(f.api.queryDeliveryWorkspace.mock.calls[1]?.[3]?.aborted).toBe(true)
  expect(f.controller.getSnapshot().read.value).toEqual(DELIVERY_WORKSPACE)
  f.api.queryDeliveryWorkspace.mockRejectedValueOnce(new Error('offline')); await f.controller.refresh()
  f.controller.prepare('push'); expect(f.controller.getSnapshot().confirmation).toBeNull()
  expect(f.controller.getSnapshot().read.value).toEqual(DELIVERY_WORKSPACE)
  f.api.queryDeliveryWorkspace.mockResolvedValueOnce({ ok: false, reason: 'denied' }); await f.controller.refresh()
  expect(f.controller.getSnapshot().read.value).toBeNull()
})

it('rejects invalid refs and stale local binding observations before confirmation', async () => {
  const f = bench(); await f.start()
  f.controller.editDraft({ baseRef: 'bad..branch' }); f.controller.prepare('save')
  expect(f.controller.getSnapshot().inputError).toBe('invalid')
  const git = f.changes.getSnapshot()
  f.changes.set({ ...git, read: { ...git.read, loading: true } }); f.controller.prepare('save')
  expect(f.controller.getSnapshot().inputError).toBe('local-stale')
  f.changes.set(git); f.controller.editDraft({ baseRef: 'master' }); f.controller.prepare('save')
  expect(f.controller.getSnapshot().confirmation).not.toBeNull()
  f.controller.cancel(); await f.controller.confirm()
  expect(f.api.saveBranchDelivery).not.toHaveBeenCalled()
})

it('does not reclassify a successful mutation when its follow-up read fails', async () => {
  const f = bench(); await f.start(); f.controller.prepare('push')
  f.api.queryDeliveryWorkspace.mockRejectedValueOnce(new Error('refresh unavailable'))
  await f.controller.confirm()
  expect(f.controller.getSnapshot().operation?.result).toMatchObject({ receipt: { state: 'succeeded' } })
  f.controller.dismiss(); expect(f.controller.getSnapshot().operation).toBeNull()
})

it('requires a terminal receipt rather than transport success, including retryable unavailability', () => {
  const intent = deliveryIntentSchema.parse({ type: 'push-branch-delivery', intentId: 'intent-11111111-1111-4111-8111-111111111111', deliveryId: DELIVERY.delivery.id, expectedDeliveryRevision: 1 })
  for (const state of ['pending', 'succeeded', 'failure'] as const) {
    expect(deliverySettled(sakiBranchDeliveryIntentResultSchema.parse({ ...deliveryResult(intent, state), ...(state === 'pending' ? { ok: false, reason: 'unavailable' } : {}) }))).toBe(state !== 'pending')
  }
  expect(deliverySettled(null)).toBe(false); expect(deliverySettled({ ok: false, reason: 'denied' })).toBe(false)
})

it('ignores inactive gestures and re-reads changed Work Item evidence in the background', async () => {
  const f = bench()
  await f.controller.refresh(); await f.controller.retry(); f.controller.dismiss(); f.controller.editDraft({ body: 'inactive' })
  expect(f.api.queryDeliveryWorkspace).not.toHaveBeenCalled()
  await f.start()
  const reads = f.api.queryDeliveryWorkspace.mock.calls.length
  f.authority.set({ access: AUTH, offline: true, project: DELIVERY_PROJECT })
  expect(f.api.queryDeliveryWorkspace.mock.calls).toHaveLength(reads)
  f.authority.set({ access: AUTH, offline: false, project: {
    ...DELIVERY_PROJECT, detail: { ...DELIVERY_PROJECT.detail, value: { ...DELIVERY_PROJECT.detail.value! } },
  } })
  await vi.waitFor(() => { expect(f.api.queryDeliveryWorkspace.mock.calls.at(-1)?.[2]).toBe('cached') })
  f.api.queryDeliveryWorkspace.mockResolvedValueOnce({ ok: true, projection: { ...DELIVERY_WORKSPACE, selection: null } })
  await f.controller.refresh(); f.controller.prepare('push')
  expect(f.controller.getSnapshot().confirmation?.summary.repository)
    .toBe(DELIVERY_WORKSPACE.branchDelivery?.delivery.target.repository.nameWithOwner)
  f.controller.cancel()
  f.api.queryDeliveryWorkspace.mockResolvedValueOnce({ ok: true, projection: {
    ...DELIVERY_WORKSPACE, selection: null, branchDelivery: null,
  } })
  await f.controller.refresh(); f.controller.prepare('save')
  expect(f.controller.getSnapshot().confirmation).toBeNull()
  f.authority.set({ access: AUTH, offline: false, project: { ...DELIVERY_PROJECT, address: { ...DELIVERY_PROJECT.address, view: 'detail' } } })
  await f.controller.retry(); f.controller.dismiss()
  expect(f.controller.getSnapshot().read.value).toBeNull()
})

it('selects the first delivery from local HEAD and requires a branch and PR title', async () => {
  const f = bench()
  f.api.queryDeliveryWorkspace.mockResolvedValue({ ok: true, projection: { ...DELIVERY_WORKSPACE, branchDelivery: null,
    selection: { ...DELIVERY_WORKSPACE.selection!, expected: { ...DELIVERY_WORKSPACE.selection!.expected, deliveryRevision: null } },
  } })
  await f.start(); f.controller.prepare('save')
  expect(f.controller.getSnapshot().inputError).toBe('invalid')
  f.controller.editDraft({ baseRef: 'refs/heads/master' }); f.controller.prepare('save')
  expect(f.controller.getSnapshot().confirmation?.request).toMatchObject({ baseRef: 'refs/heads/master', expected: { deliveryRevision: null } })
  f.controller.cancel()
  const git = f.changes.getSnapshot()
  f.changes.set({ ...git, read: { value: null, loading: false, failure: null } }); f.controller.prepare('save')
  expect(f.controller.getSnapshot().inputError).toBe('local-stale')
  f.changes.set(git)
  if (git.read.value?.result.ok !== true) throw new Error('Expected local HEAD')
  f.changes.set({ ...git, read: { ...git.read, value: { ...git.read.value, result: { ok: true, observation: { ...git.read.value.result.observation, branch: { kind: 'detached' } } } } } })
  f.controller.prepare('save'); expect(f.controller.getSnapshot().inputError).toBe('invalid')
  f.controller.editDraft({ headRef: 'refs/heads/topic' }); f.controller.prepare('save')
  expect(f.controller.getSnapshot().confirmation?.request).toMatchObject({ headRef: 'refs/heads/topic' })
  f.api.queryDeliveryWorkspace.mockResolvedValue({ ok: true, projection: { ...DELIVERY_WORKSPACE, association: { state: 'absent', repositoryId: DELIVERY.delivery.target.repository.id, headRef: 'topic', baseRef: 'master', expectedHeadCommitId: DELIVERY.delivery.commitId, observedAt: 1 } } })
  await f.controller.refresh(); f.controller.cancel(); f.controller.prepare('associate')
  expect(f.controller.getSnapshot().confirmation).toBeNull()
  f.controller.prepare('create'); expect(f.controller.getSnapshot().confirmation?.request).toMatchObject({ title: ITEM.title })
  f.controller.cancel()
  f.authority.set({ access: AUTH, offline: false, project: { ...DELIVERY_PROJECT, detail: { loading: true, failure: null, value: null } } })
  await vi.waitFor(() => { expect(f.controller.getSnapshot().read.loading).toBe(false) })
  f.controller.prepare('create'); expect(f.controller.getSnapshot().inputError).toBe('invalid')
})

it('discards invalid persisted data and cannot submit two copies while a request is pending', async () => {
  const store = createDeliveryStore().create()
  store.actions.hydrate({ scopes: { malformed: 'invalid' } })
  expect(store.store.getSnapshot()).toEqual({ scopes: {} })
  const f = bench(store); await f.start(); f.controller.prepare('push')
  const held = Promise.withResolvers<Awaited<ReturnType<typeof f.api.pushBranchDelivery>>>()
  f.api.pushBranchDelivery.mockReturnValueOnce(held.promise)
  const pending = f.controller.confirm()
  await f.controller.retry(); await f.controller.confirm(); f.controller.dismiss()
  expect(f.api.pushBranchDelivery).toHaveBeenCalledOnce()
  held.resolve(deliveryResult(f.api.pushBranchDelivery.mock.calls[0]![0])); await pending
  await f.controller.retry(); expect(f.api.pushBranchDelivery).toHaveBeenCalledOnce()
})
