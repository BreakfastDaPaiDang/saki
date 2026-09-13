// @vitest-environment jsdom
/** Changes gestures through the real controller, with bounded Host Diff pages. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { sakiProjectDiffResultSchema, sakiStageFilesResultSchema, sakiUnstageFilesResultSchema } from '@breakfastdapaidang/saki-host-api/wire'
import { ChangesPage } from '../src/client/components/ChangesPage.tsx'
import type { ChangesController, ChangesSnapshot, ChangesRow } from '../src/client/changes-controller.ts'
import { SAKI_AGENT_RUN_PROJECTION_FIXTURES } from '@breakfastdapaidang/saki-control-plane/fixtures'
import { changesReasonKey } from '../src/client/changes-feedback.ts'
import { NS, zh } from '../src/client/locales.ts'
import { changesFixture, CHANGES_PROJECT, CHANGES, gitSuccess } from './changes-fixture.client.ts'
import { planningFixture, ITEM, PROJECT_ID } from './planning-fixture.client.ts'

const owners = new Set<{ dispose: () => void }>()
const showModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
const close = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')
beforeEach(() => {
  localStorage.clear()
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false }
})
afterEach(() => {
  cleanup(); for (const owner of owners) owner.dispose(); owners.clear()
  for (const [key, descriptor] of [['showModal', showModal], ['close', close]] as const) {
    if (descriptor === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, key)
    else Object.defineProperty(HTMLDialogElement.prototype, key, descriptor)
  }
})
const t = ((key: string, values?: Record<string, string | number>) => Object.entries(values ?? {}).reduce((copy, [name, value]) => copy.replace(`{${name}}`, String(value)), (zh as Record<string, string>)[key] ?? key)) as TranslateNS<typeof NS>
const click = async (...args: Parameters<typeof fireEvent.click>) => { await act(async () => { fireEvent.click(...args) }) }
async function bench() {
  const f = changesFixture(); owners.add(f.controller); await f.start()
  const planning = planningFixture().controller; owners.add(planning)
  const props = { project: CHANGES_PROJECT, actions: f.controller, planning, openSession: vi.fn(), t }
  function View() { return <ChangesPage {...props} state={useSyncExternalStore(f.controller.subscribe, f.controller.getSnapshot)} /> }
  render(<View />)
  return { ...f, props }
}
function diffResult(request: Parameters<ChangesController['selectDiff']>[0], last = false) {
  const lines = last ? ['+new'] : ['--- a/src/example.ts', '+++ b/src/example.ts', '@@ -1 +1 @@', '-old']
  const totalBytes = new TextEncoder().encode('--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n').byteLength
  return sakiProjectDiffResultSchema.parse({ ok: true, projection: { type: 'project-diff', registryRevision: 1, projectId: CHANGES_PROJECT.id, projectRevision: 2, result: { ok: true, page: {
    pageVersion: 1, observation: request.expectedStatus, changeId: request.changeId, layer: request.layer, patchFingerprint: { version: 1, digest: 'a'.repeat(64) },
    range: { startLine: last ? 4 : 0, endLineExclusive: last ? 5 : 4, totalLines: 5 }, lines,
    pageUtf8Bytes: new TextEncoder().encode(`${lines.join('\n')}\n`).byteLength, totalUtf8Bytes: totalBytes,
    omittedBeforeLines: last ? 4 : 0, omittedAfterLines: last ? 0 : 1, truncated: true, ...(last ? {} : { nextCursor: 'next_page' }),
  } } } })
}

it('shows Project-wide attribution and replaces bounded Diff pages without accumulating hidden lines', async () => {
  const f = await bench()
  f.api.readProjectDiff.mockImplementation(async (_project, _revision, request) => diffResult(request, request.cursor !== undefined))
  expect(screen.getByText(zh['changes.scope'])).toBeTruthy()
  expect(screen.getByText(zh['changes.attribution.not-inherited'])).toBeTruthy()
  await click(screen.getByRole('button', { name: '暂存区 Diff' }))
  await screen.findByText('补丁第 1–4 行，共 5 行')
  expect(screen.getByText('当前仅显示一页：前方省略 0 行，后方还有 1 行。')).toBeTruthy()
  await click(screen.getByRole('button', { name: '下一页' }))
  await screen.findByText('补丁第 5–5 行，共 5 行')
  expect(screen.queryByText(/--- a\/src\/example.ts/u)).toBeNull()
  await click(screen.getByRole('button', { name: '返回第一页' }))
  await screen.findByText('补丁第 1–4 行，共 5 行')
  await click(screen.getByRole('button', { name: '刷新 Git 状态' }))
  await screen.findByText(zh['changes.chooseFile'])
})

it('stages and unstages only the clicked file and requires acknowledgement between requests', async () => {
  const f = await bench()
  f.api.stageFiles.mockImplementation(async intent => sakiStageFilesResultSchema.parse(gitSuccess(intent)))
  f.api.unstageFiles.mockImplementation(async intent => sakiUnstageFilesResultSchema.parse(gitSuccess(intent)))
  await click(screen.getByRole('button', { name: '暂存文件' }))
  await screen.findByText('操作已完成。')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '取消暂存' }).disabled).toBe(true)
  await click(screen.getByRole('button', { name: '确认结果' }))
  await click(screen.getByRole('button', { name: '取消暂存' }))
  await screen.findByText('操作已完成。')
  expect(f.api.stageFiles).toHaveBeenCalledOnce(); expect(f.api.unstageFiles).toHaveBeenCalledOnce()
})

it('reviews all staged paths and the exact message before a local commit', async () => {
  const f = await bench()
  await click(screen.getByRole('button', { name: '检查并提交…' }))
  expect(screen.getByText('请输入有效的提交说明。')).toBeTruthy()
  await act(async () => { fireEvent.change(screen.getByLabelText('提交说明'), { target: { value: 'Reviewed message' } }) })
  await click(screen.getByRole('button', { name: '检查并提交…' }))
  const dialog = screen.getByRole('dialog', { name: '确认本地提交' })
  expect(within(dialog).getByText('Reviewed message')).toBeTruthy()
  expect(within(dialog).getByText('src/example.ts')).toBeTruthy()
  expect(f.api.createCommit).not.toHaveBeenCalled()
  await act(async () => { fireEvent(dialog, new Event('cancel', { bubbles: true, cancelable: true })) })
  expect(screen.queryByRole('dialog')).toBeNull()
  await click(screen.getByRole('button', { name: '检查并提交…' }))
  await click(screen.getByRole('button', { name: '创建本地提交' }))
  await screen.findByText('e'.repeat(40))
  expect(f.api.createCommit).toHaveBeenCalledOnce()
  await click(screen.getByRole('button', { name: '确认结果' }))
  expect(screen.getByLabelText<HTMLTextAreaElement>('提交说明').value).toBe('')
})

it('offers recovery after transport loss and translates unsupported Diff and unknown Host reasons', async () => {
  const f = await bench()
  f.api.stageFiles.mockRejectedValueOnce(new Error('response lost'))
  await click(screen.getByRole('button', { name: '暂存文件' }))
  await screen.findByText(zh['changes.unknown'])
  expect(screen.queryByRole('button', { name: '确认结果' })).toBeNull()
  await click(screen.getByRole('button', { name: '核对 / 重试原操作' }))
  expect(f.api.stageFiles).toHaveBeenCalledTimes(2)
  f.api.readProjectDiff.mockImplementation(async (projectId, registryRevision) => ({ ok: true, projection: { type: 'project-diff', projectId, projectRevision: 2, registryRevision, result: { ok: false, reason: 'binary' } } }))
  await click(screen.getByRole('button', { name: '未暂存 Diff' }))
  await screen.findByText(/二进制文件不显示文本 Diff/u)
  expect(changesReasonKey('future-host-reason')).toBe('changes.reason.unavailable')
})

it('keeps the Work Item and Run return addresses available while Git reads are unavailable', async () => {
  const f = changesFixture(); owners.add(f.controller)
  const planning = planningFixture(); owners.add(planning.controller)
  const result = await planning.api.queryWorkItemView(PROJECT_ID, ITEM.id)
  if (!result.ok) throw new Error('missing Work Item')
  const run = SAKI_AGENT_RUN_PROJECTION_FIXTURES.running
  const project = { ...CHANGES_PROJECT, address: { ...CHANGES_PROJECT.address, workItemId: ITEM.id, changesRunId: run.id }, detail: {
    value: { ...result.projection, runs: [run] }, loading: false, failure: null,
  } }
  const openSession = vi.fn(); const navigate = vi.spyOn(planning.controller, 'navigate').mockImplementation(() => {})
  const props = { project, actions: f.controller, planning: planning.controller, openSession, t }
  const state = f.controller.getSnapshot()
  const view = render(<ChangesPage {...props} state={state} />)
  await click(screen.getByRole('button', { name: '返回工作项' })); expect(navigate).toHaveBeenCalledWith({ view: 'detail' })
  await click(screen.getByRole('button', { name: '打开 Session' })); expect(openSession).toHaveBeenCalledWith(run.sessionId)
  view.rerender(<ChangesPage {...props} project={CHANGES_PROJECT}
    state={{ ...state, read: { value: null, loading: true, failure: null } }} />)
  await click(screen.getByRole('button', { name: '返回看板' })); expect(navigate).toHaveBeenCalledWith({ view: 'board' })
  expect(screen.getByText('正在读取 Git 状态…')).toBeTruthy()
  if (!CHANGES.ok) throw new Error('missing changes')
  view.rerender(<ChangesPage {...props} state={{ ...state, read: { value: { ...CHANGES.projection, result: { ok: false, reason: 'binding-stale' } }, loading: false, failure: null } }} />)
  expect(screen.getByRole('alert').textContent).toContain('状态已变化')
})

it('renders clean, detached, unborn, untracked, and conflicted repositories with explicit write blockers', async () => {
  const f = changesFixture(); owners.add(f.controller); await f.start()
  const planning = planningFixture().controller; owners.add(planning)
  if (!CHANGES.ok || !CHANGES.projection.result.ok) throw new Error('missing changes')
  const projection = CHANGES.projection; const observation = CHANGES.projection.result.observation
  const row = observation.changes[0]!
  if (row.kind !== 'ordinary') throw new Error('ordinary row required')
  const state = f.controller.getSnapshot()
  const props = { project: CHANGES_PROJECT, actions: f.controller, planning, openSession: vi.fn(), t }
  const renderObservation = (changes: readonly ChangesRow[], patch: Partial<typeof observation> = {}): ChangesSnapshot => ({
    ...state, read: { value: { ...projection, result: { ok: true, observation: { ...observation, ...patch, changes } }, gitOperations: {
      stageFiles: { available: false, reasons: ['unmerged'] }, unstageFiles: { available: false, reasons: ['unmerged'] },
      createCommit: { available: false, reasons: ['no-staged-changes'] },
    } }, loading: false, failure: null },
  })
  const view = render(<ChangesPage {...props} state={renderObservation([], { branch: { kind: 'detached' } })} />)
  expect(screen.getByText('工作区没有变更。')).toBeTruthy(); expect(screen.getByText('分离的 HEAD')).toBeTruthy()
  const untracked: ChangesRow = { ...row, kind: 'untracked', indexStatus: 'absent', worktreeStatus: 'untracked', attribution: 'inherited', submodule: { kind: 'not-submodule' }, worktreeMode: '100644' }
  view.rerender(<ChangesPage {...props} state={renderObservation([untracked], { head: { kind: 'unborn', symbolicRef: 'refs/heads/main' } })} />)
  expect(screen.getByText('尚无提交')).toBeTruthy()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '暂存文件' }).disabled).toBe(true)
  const conflicted: ChangesRow = { ...row, kind: 'unmerged', indexStatus: 'unmerged', worktreeStatus: 'present', conflict: 'both-modified', stages: { base: row.head, ours: row.index, theirs: row.head }, attribution: 'unattributed' }
  view.rerender(<ChangesPage {...props} state={renderObservation([conflicted])} />)
  await click(screen.getByRole('button', { name: '冲突 Diff' }))
  expect(f.api.readProjectDiff.mock.calls[0]?.[2].layer).toBe('conflict')
  const request = f.api.readProjectDiff.mock.calls[0]![2]
  const complete = diffResult(request)
  if (!complete.ok || !complete.projection.result.ok) throw new Error('missing Diff')
  const patch = complete.projection.result.page
  view.rerender(<ChangesPage {...props} state={{ ...renderObservation([conflicted]), selection: request,
    diff: { loading: true, value: null, failure: null } }} />)
  expect(screen.getByText('正在读取 Git 状态…')).toBeTruthy()
  const { nextCursor: _cursor, ...first } = patch
  view.rerender(<ChangesPage {...props} state={{ ...renderObservation([{ ...row, indexStatus: 'unchanged', worktreeStatus: 'unchanged' }]), selection: request,
    diff: { loading: false, failure: null, value: { ok: true, page: { ...first,
      range: { startLine: 0, endLineExclusive: 4, totalLines: 4 }, omittedAfterLines: 0,
      totalUtf8Bytes: first.pageUtf8Bytes, truncated: false,
    } } } }} />)
  expect(screen.queryByRole('button', { name: '下一页' })).toBeNull()
  expect(screen.queryByText(/当前仅显示一页/u)).toBeNull()
})

it('keeps a denial without a receipt unconfirmed before accepted and reconciliation results arrive', async () => {
  const f = await bench()
  const held = Promise.withResolvers<Awaited<ReturnType<typeof f.api.stageFiles>>>()
  f.api.stageFiles.mockReturnValueOnce(held.promise)
  await click(screen.getByRole('button', { name: '暂存文件' }))
  expect(screen.getByText('正在处理操作…')).toBeTruthy()
  await act(async () => { held.resolve({ ok: false, reason: 'denied' }) })
  await screen.findByText(zh['changes.unknown'])
  expect(screen.queryByText(zh['changes.rejected'])).toBeNull()
  const intent = f.api.stageFiles.mock.calls[0]![0]
  const identity = { id: `receipt-${intent.intentId.slice(7)}`, intentId: intent.intentId, type: 'stage-files', projectId: PROJECT_ID }
  const operation = { id: 'host-operation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', type: 'stage-files', state: 'reconciliation-required', revision: 1 }
  f.api.stageFiles.mockResolvedValueOnce(sakiStageFilesResultSchema.parse({ ok: false, reason: 'unavailable', receipt: {
    ...identity, state: 'accepted', operation: { ...operation, state: 'accepted' },
  } }))
  await click(screen.getByRole('button', { name: '核对 / 重试原操作' }))
  await screen.findByText(zh['changes.accepted'])
  f.api.stageFiles.mockResolvedValueOnce(sakiStageFilesResultSchema.parse({ ok: false, reason: 'reconciliation-required', receipt: {
    ...identity, state: 'reconciliation-required', reason: 'evidence-conflict', operation,
  } }))
  if (!CHANGES.ok) throw new Error('missing Changes')
  f.api.queryProjectChanges.mockResolvedValueOnce({ ...CHANGES, projection: { ...CHANGES.projection, gitOperations: {
    ...CHANGES.projection.gitOperations, current: { intentId: intent.intentId, type: 'stage-files', state: 'admission-reserved' },
  } } })
  await click(screen.getByRole('button', { name: '核对 / 重试原操作' }))
  await screen.findByText('操作效果尚不确定，需要核对；不能发起替代操作。')
  expect(screen.queryByRole('button', { name: '确认结果' })).toBeNull()
  expect(screen.getByText(/工作区存在尚未结束的写入操作/u)).toBeTruthy()
})

it('offers acknowledgement for a durable rejection without suggesting another request', async () => {
  const f = await bench()
  f.api.stageFiles.mockImplementationOnce(async intent => sakiStageFilesResultSchema.parse({ ok: false, reason: 'conflict', receipt: {
    id: `receipt-${intent.intentId.slice(7)}`, intentId: intent.intentId, type: 'stage-files', projectId: PROJECT_ID,
    state: 'conflict', reason: 'expected-evidence',
  } }))
  await click(screen.getByRole('button', { name: '暂存文件' }))
  await screen.findByText(zh['changes.rejected'])
  expect(screen.getByRole('button', { name: '确认结果' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '核对 / 重试原操作' })).toBeNull()
})
