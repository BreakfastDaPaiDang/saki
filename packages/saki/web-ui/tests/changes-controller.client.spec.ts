// @vitest-environment jsdom
/** Exact Git request replay, revision fences, and independent read/authority lifetimes. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ChangesController, changesSettled } from '../src/client/changes-controller.ts'
import { sakiStageFilesResultSchema } from '@breakfastdapaidang/saki-host-api/wire'
import { createChangesStore } from '../src/client/changes-state.ts'
import { changesFixture, CHANGES, CHANGES_PROJECT } from './changes-fixture.client.ts'
import { AUTH, OTHER_PROJECT_ID, PROJECT_ID } from './planning-fixture.client.ts'

const owners = new Set<ChangesController>()
beforeEach(() => { localStorage.clear() })
afterEach(() => { for (const owner of owners) owner.dispose(); owners.clear() })
function bench(interaction?: ReturnType<ReturnType<typeof createChangesStore>['create']>) { const f = changesFixture(interaction); owners.add(f.controller); return f }
function row() { if (!CHANGES.ok || !CHANGES.projection.result.ok) throw new Error('status fixture unavailable'); return CHANGES.projection.result.observation.changes[0]! }

it('requires explicit confirmation of the displayed index and preserves the commit message', async () => {
  const f = bench(); await f.start()
  await f.controller.confirmCommit(); expect(f.api.createCommit).not.toHaveBeenCalled()
  f.controller.prepareCommit(); expect(f.controller.getSnapshot().inputError).toBe(true)
  f.controller.editMessage('Reviewed local changes'); f.controller.prepareCommit()
  const intent = f.controller.getSnapshot().confirmation!
  expect(intent.expected).toMatchObject({ projectId: PROJECT_ID, expectedRegistryRevision: 1, expectedProjectRevision: 2, expectedBinding: { revision: 1 }, expectedIndex: { kind: 'tree', treeId: 'b'.repeat(40) } })
  f.controller.cancelCommit(); await f.controller.confirmCommit(); expect(f.api.createCommit).not.toHaveBeenCalled()
  f.controller.prepareCommit(); await f.controller.confirmCommit()
  expect(f.api.createCommit.mock.calls[0]?.[0]).toMatchObject({ message: 'Reviewed local changes', expected: intent.expected })
  f.controller.editMessage('replacement'); expect(f.controller.getSnapshot().draft.message).toBe('Reviewed local changes')
  f.controller.prepareCommit(); expect(f.controller.getSnapshot().confirmation).toBeNull()
  f.controller.dismiss(); expect(f.controller.getSnapshot().draft).toEqual({ message: '', pending: null })
})

it('replays a lost commit response across reload and denied recovery without replacing the request', async () => {
  const f = bench(); await f.start()
  f.api.createCommit.mockRejectedValueOnce(new Error('response lost'))
  f.controller.editMessage('Only one commit'); f.controller.prepareCommit(); await f.controller.confirmCommit()
  const intent = f.api.createCommit.mock.calls[0]![0]
  f.controller.dismiss(); expect(f.controller.getSnapshot().draft.pending).toEqual(intent)
  const store = createChangesStore().create(); store.actions.hydrate(f.interaction.store.getSnapshot()); f.controller.dispose()
  const restored = bench(store); await restored.start()
  restored.api.createCommit.mockResolvedValueOnce({ ok: false, reason: 'denied' })
  await restored.controller.retry(); restored.controller.dismiss()
  expect(restored.controller.getSnapshot().draft.pending).toEqual(intent)
  restored.controller.prepareCommit(); await restored.controller.confirmCommit()
  expect(restored.api.createCommit).toHaveBeenCalledTimes(1)
  await restored.controller.retry()
  expect(restored.api.createCommit.mock.calls.map(call => call[0])).toEqual([intent, intent])
  await restored.controller.retry(); expect(restored.api.createCommit).toHaveBeenCalledTimes(2)
  restored.controller.dismiss(); expect(restored.controller.getSnapshot().draft.pending).toBeNull()
})

it('sends only observed change ids and fingerprints and serializes index gestures', async () => {
  const f = bench(); await f.start()
  const held = Promise.withResolvers<Awaited<ReturnType<typeof f.api.stageFiles>>>()
  f.api.stageFiles.mockReturnValueOnce(held.promise)
  const first = f.controller.changeIndex(row(), 'stage-files')
  await f.controller.changeIndex(row(), 'unstage-files'); await f.controller.retry()
  expect(f.api.unstageFiles).not.toHaveBeenCalled(); expect(f.api.stageFiles).toHaveBeenCalledTimes(1)
  expect(f.api.stageFiles.mock.calls[0]?.[0].changes).toEqual([{ id: row().id, fingerprint: row().fingerprint }])
  held.resolve({ ok: false, reason: 'unavailable' }); await first
  await f.controller.retry(); expect(f.api.stageFiles.mock.calls[1]?.[0]).toEqual(f.api.stageFiles.mock.calls[0]?.[0])
})

it('ignores late reads and hides prior Principal inputs and mutation results', async () => {
  const f = bench(); await f.start()
  const held = Promise.withResolvers<Awaited<ReturnType<typeof f.api.createCommit>>>()
  f.api.createCommit.mockReturnValueOnce(held.promise)
  f.controller.editMessage('Private draft'); f.controller.prepareCommit(); const pending = f.controller.confirmCommit()
  f.authority.set({ access: { kind: 'bootstrap-required', message: 'Local bootstrap is required.' }, offline: false, project: null })
  await vi.waitFor(() => { expect(f.controller.getSnapshot().read.value).toBeNull() })
  held.resolve({ ok: false, reason: 'denied' }); await pending
  expect(f.api.createCommit.mock.calls[0]?.[2]?.aborted).toBe(true)
  expect(f.controller.getSnapshot().draft.pending).toBeNull()
  expect(f.controller.getSnapshot().draft.message).toBe('')
  f.authority.set({ access: AUTH, offline: false, project: CHANGES_PROJECT })
  await vi.waitFor(() => { expect(f.controller.getSnapshot().draft.message).toBe('Private draft') })
})

it('keeps a Project mutation alive during navigation and never attaches its result to another Project', async () => {
  const f = bench(); await f.start()
  const held = Promise.withResolvers<Awaited<ReturnType<typeof f.api.stageFiles>>>()
  f.api.stageFiles.mockReturnValueOnce(held.promise)
  const pending = f.controller.changeIndex(row(), 'stage-files')
  f.authority.set({ access: AUTH, offline: false, project: { ...CHANGES_PROJECT, id: OTHER_PROJECT_ID } })
  await vi.waitFor(() => { expect(f.controller.getSnapshot().draft.pending).toBeNull() })
  held.resolve({ ok: false, reason: 'unavailable' }); await pending
  expect(f.controller.getSnapshot().operation).toBeNull()
  f.authority.set({ access: AUTH, offline: false, project: CHANGES_PROJECT })
  await vi.waitFor(() => { expect(f.controller.getSnapshot().operation?.result).toEqual({ ok: false, reason: 'unavailable' }) })
})

it('retains stale read evidence but blocks new writes, and erases facts on a denied read', async () => {
  const f = bench(); await f.start()
  f.api.queryProjectChanges.mockRejectedValueOnce(new Error('offline')); await f.controller.refresh()
  expect(f.controller.getSnapshot().read.value).not.toBeNull()
  await f.controller.changeIndex(row(), 'stage-files'); expect(f.api.stageFiles).not.toHaveBeenCalled()
  f.api.queryProjectIndex.mockResolvedValueOnce({ ok: false, reason: 'denied' }); await f.controller.refresh()
  expect(f.controller.getSnapshot().read.value).toBeNull()
})

it('cancels obsolete Diff requests on selection, refresh, and Project navigation', async () => {
  const f = bench(); await f.start()
  const observation = CHANGES.ok && CHANGES.projection.result.ok ? CHANGES.projection.result.observation : null
  if (observation === null) throw new Error('status missing')
  const request = { expectedStatus: observation.fingerprint, changeId: row().id, layer: 'staged' as const }
  const held = Promise.withResolvers<Awaited<ReturnType<typeof f.api.readProjectDiff>>>()
  f.api.readProjectDiff.mockReturnValueOnce(held.promise)
  const first = f.controller.selectDiff(request)
  await f.controller.selectDiff({ ...request, layer: 'unstaged' })
  held.resolve({ ok: false, reason: 'denied' }); await first
  expect(f.controller.getSnapshot().diff.failure).toBe('unavailable')
  expect(f.api.readProjectDiff.mock.calls[0]?.[3]?.aborted).toBe(true)
  await f.controller.refresh(); expect(f.controller.getSnapshot().selection).toBeNull()
})

it('invalidates confirmation on refresh and ignores unrelated planning notifications', async () => {
  const f = bench(); await f.start()
  f.controller.editMessage('frozen index'); f.controller.prepareCommit()
  f.authority.set({ ...f.authority.getSnapshot(), offline: true })
  expect(f.api.queryProjectChanges).toHaveBeenCalledTimes(1)
  await f.controller.refresh(); await f.controller.confirmCommit()
  expect(f.api.createCommit).not.toHaveBeenCalled()
})

it('validates browser persistence and refuses to settle acknowledgements without durable receipts', () => {
  const store = createChangesStore().create(); store.actions.hydrate({ scopes: { bad: { project: { pending: { type: 'create-commit' } } } } })
  expect(store.store.getSnapshot()).toEqual({ scopes: {} })
  expect(changesSettled(null)).toBe(false)
  expect(changesSettled({ ok: false, reason: 'denied' })).toBe(false)
  expect(changesSettled({ ok: false, reason: 'conflict' })).toBe(false)
})

it('keeps accepted and reconciliation receipts pending and permits acknowledgement only of terminal receipts', async () => {
  const f = bench(); await f.start()
  await f.controller.changeIndex(row(), 'stage-files')
  const intent = f.api.stageFiles.mock.calls[0]![0]
  const identity = { id: `receipt-${intent.intentId.slice(7)}`, intentId: intent.intentId, type: 'stage-files', projectId: PROJECT_ID }
  const operation = { id: 'host-operation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', type: 'stage-files', revision: 1 }
  const accepted = sakiStageFilesResultSchema.parse({ ok: false, reason: 'unavailable', receipt: { ...identity, state: 'accepted', operation: { ...operation, state: 'accepted' } } })
  const reconciliation = sakiStageFilesResultSchema.parse({ ok: false, reason: 'reconciliation-required', receipt: { ...identity, state: 'reconciliation-required', reason: 'effect-unknown', operation: { ...operation, state: 'reconciliation-required' } } })
  for (const result of [accepted, reconciliation]) {
    f.api.stageFiles.mockResolvedValueOnce(result); await f.controller.retry(); f.controller.dismiss()
    expect(f.controller.getSnapshot().draft.pending).toEqual(intent)
  }
  for (const result of [
    { ok: false, reason: 'conflict', receipt: { ...identity, state: 'conflict', reason: 'expected-evidence' } },
    { ok: false, reason: 'failure', receipt: { ...identity, state: 'failed', reason: 'observation-stale', operation: { ...operation, state: 'failed' } } },
    { ok: false, reason: 'canceled', receipt: { ...identity, state: 'canceled', reason: 'source-canceled' } },
  ]) expect(changesSettled(sakiStageFilesResultSchema.parse(result))).toBe(true)
})

it('does not write without a selected authority, usable index, or successful current observation', async () => {
  const f = bench()
  f.controller.editMessage('No authority'); await f.controller.refresh()
  await f.controller.changeIndex(row(), 'stage-files'); await f.controller.confirmCommit(); await f.controller.retry()
  await f.controller.selectDiff({ expectedStatus: { version: 1, digest: 'a'.repeat(64) }, changeId: row().id, layer: 'staged' })
  expect(f.api.queryProjectIndex).not.toHaveBeenCalled(); expect(f.api.readProjectDiff).not.toHaveBeenCalled()
  await f.start()
  if (!CHANGES.ok || !CHANGES.projection.result.ok) throw new Error('missing changes')
  f.api.queryProjectChanges.mockResolvedValueOnce({ ...CHANGES, projection: { ...CHANGES.projection, result: { ok: true, observation: {
    ...CHANGES.projection.result.observation, index: { kind: 'unmerged', stagesDigest: { version: 1, digest: 'a'.repeat(64) } },
  } } } })
  await f.controller.refresh(); await f.controller.changeIndex(row(), 'stage-files')
  expect(f.api.stageFiles).not.toHaveBeenCalled()
  f.api.queryProjectChanges.mockResolvedValueOnce({ ok: false, reason: 'denied' }); await f.controller.refresh()
  expect(f.controller.getSnapshot().read.failure).toBe('denied')
})

it('aborts superseded status reads and exposes a Diff transport failure separately', async () => {
  const f = bench(); await f.start()
  const held = Promise.withResolvers<Awaited<ReturnType<typeof f.api.queryProjectChanges>>>()
  f.api.queryProjectChanges.mockReturnValueOnce(held.promise)
  const old = f.controller.refresh()
  await vi.waitFor(() => { expect(f.api.queryProjectChanges).toHaveBeenCalledTimes(2) })
  await f.controller.refresh(); held.resolve({ ok: false, reason: 'denied' }); await old
  expect(f.controller.getSnapshot().read.failure).toBeNull()
  f.api.readProjectDiff.mockRejectedValueOnce(new Error('Diff unavailable'))
  await f.controller.selectDiff({ expectedStatus: { version: 1, digest: 'a'.repeat(64) }, changeId: row().id, layer: 'staged' })
  expect(f.controller.getSnapshot().diff.failure).toBe('unavailable')
})
