// @vitest-environment jsdom
/** Work page gestures through the real interaction owner and controlled Host responses. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { WorkPage } from '../src/client/components/WorkPage.tsx'
import type { WorkController } from '../src/client/work-controller.ts'
import { zh, NS } from '../src/client/locales.ts'
import { workFixture, MY_WORK } from './work-fixture.client.ts'
import { AUTH, ITEM, PROJECT_ID } from './planning-fixture.client.ts'

const owners = new Set<WorkController>()
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
beforeEach(() => { localStorage.clear(); HTMLDialogElement.prototype.showModal = function () { this.open = true } })
afterEach(() => { cleanup(); for (const owner of owners) owner.dispose(); owners.clear(); vi.restoreAllMocks(); if (originalShowModal === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal'); else Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal) })
const t = ((key: string, values?: Record<string, string | number>) => Object.entries(values ?? {}).reduce((copy, [name, value]) => copy.replace(`{${name}}`, String(value)), (zh as Record<string, string>)[key] ?? key)) as TranslateNS<typeof NS>
const click = async (...args: Parameters<typeof fireEvent.click>) => { await act(async () => { fireEvent.click(...args) }) }
const change = async (...args: Parameters<typeof fireEvent.change>) => { await act(async () => { fireEvent.change(...args) }) }
async function bench() {
  const fixture = workFixture(); owners.add(fixture.controller); await fixture.start()
  const props = { actions: fixture.controller, openProject: vi.fn(), openBoard: vi.fn(), openItem: vi.fn(), t }
  function View() {
    const state = useSyncExternalStore(fixture.controller.subscribe, fixture.controller.getSnapshot)
    return <WorkPage state={state} {...props} />
  }
  render(<View />)
  return { ...fixture, props }
}

it('renders backend groups and keeps Project and Work Item navigation explicit', async () => {
  const f = await bench()
  expect(screen.getByRole('heading', { name: '我的工作' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: '等待我处理' })).toBeTruthy()
  await click(screen.getByRole('button', { name: '打开项目' })); expect(f.props.openProject).toHaveBeenCalledOnce()
  await click(screen.getByRole('button', { name: '查看工作项与结果' })); expect(f.props.openItem).toHaveBeenCalledWith(PROJECT_ID, ITEM.id)
  await click(screen.getByRole('button', { name: '打开项目看板' })); expect(f.props.openBoard).toHaveBeenCalledWith(PROJECT_ID)
})

it('creates from an explicit Project draft and locks it while its result remains visible', async () => {
  const f = await bench()
  expect(screen.queryByRole('textbox', { name: '标题' })).toBeNull()
  await change(screen.getByLabelText('目标项目'), { target: { value: PROJECT_ID } })
  await change(screen.getByLabelText('标题'), { target: { value: '浏览器需求' } })
  await change(screen.getByLabelText('预期结果'), { target: { value: '保留创建结果' } })
  await change(screen.getByLabelText('验收标准（每行一项）'), { target: { value: '只创建一次' } })
  await click(screen.getByRole('button', { name: '创建 Issue 并加入收件箱' }))
  await screen.findByText('已完成')
  expect(f.api.createWorkItem).toHaveBeenCalledOnce()
  expect(screen.getByLabelText<HTMLInputElement>('标题').disabled).toBe(true)
  await click(screen.getByRole('button', { name: '关闭结果' }))
  await waitFor(() => { expect(screen.getByLabelText<HTMLInputElement>('标题').disabled).toBe(false) })
})

it('shows the backend launch summary and makes no assignment before confirmation', async () => {
  const f = await bench()
  await click(screen.getByRole('button', { name: '交给 Agent' }))
  const dialog = screen.getByRole('dialog', { name: '交给 Agent' })
  expect(within(dialog).getByText('模型：deepseek / deepseek-chat')).toBeTruthy()
  expect(within(dialog).getByText('继承变更：2 项')).toBeTruthy()
  expect(f.api.giveWorkItemToAgent).not.toHaveBeenCalled()
  await click(within(dialog).getByRole('button', { name: '取消' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  await click(screen.getByRole('button', { name: '交给 Agent' }))
  await click(screen.getByRole('button', { name: '确认执行' }))
  await waitFor(() => { expect(f.api.giveWorkItemToAgent).toHaveBeenCalledOnce() })
})

it('keeps a displayed offer actionable while its next Projection is pending', async () => {
  const f = await bench()
  const held = Promise.withResolvers<Awaited<ReturnType<typeof f.api.queryMyWork>>>()
  f.api.queryMyWork.mockReturnValueOnce(held.promise)
  let refreshing: Promise<void> | undefined
  await act(async () => { refreshing = f.controller.refresh() })
  try {
    expect(f.controller.getSnapshot().items.loading).toBe(true)
    const action = screen.getByRole<HTMLButtonElement>('button', { name: '交给 Agent' })
    expect(action.disabled).toBe(false)
    await click(action)
    expect(screen.getByRole('dialog', { name: '交给 Agent' })).toBeTruthy()
    expect(f.api.giveWorkItemToAgent).not.toHaveBeenCalled()
  } finally {
    await act(async () => { held.resolve(MY_WORK); await refreshing })
  }
})

it('answers the exact Intervention revision and preserves its text through cancellation', async () => {
  const f = await bench()
  if (!MY_WORK.ok) throw new Error('fixture denied')
  const interventionId = 'intervention-0a1b2c3d-0000-4000-8000-000000000001' as Extract<Parameters<typeof f.controller.editAnswer>[0], string>
  f.api.queryMyWork.mockResolvedValue({ ok: true, projection: { type: 'my-work', principalId: AUTH.principal.id, items: [{ ...MY_WORK.projection.items[0]!, group: 'waiting-for-operator', recommendation: { available: true, offer: { type: 'answer-intervention', interventionId, expectedInterventionRevision: 3, requiredAnswer: { kind: 'text', prompt: '保留现有修改吗？', maxLength: 80 }, reason: 'response-required' } } }] } })
  await act(async () => { await f.controller.refresh() })
  await click(screen.getByRole('button', { name: '回答问题' }))
  await change(screen.getByLabelText('保留现有修改吗？'), { target: { value: '保留现有修改。' } })
  await click(screen.getByRole('button', { name: '取消' }))
  await click(screen.getByRole('button', { name: '回答问题' }))
  expect(screen.getByLabelText<HTMLTextAreaElement>('保留现有修改吗？').value).toBe('保留现有修改。')
  await click(screen.getByRole('button', { name: '确认执行' }))
  await waitFor(() => { expect(f.api.answerIntervention).toHaveBeenCalledOnce() })
  expect(f.api.answerIntervention.mock.calls[0]?.[0]).toMatchObject({ interventionId, expectedInterventionRevision: 3, answer: { kind: 'text', text: '保留现有修改。' } })
})

it('offers exact replay after a lost response and never replaces the original request', async () => {
  const f = await bench()
  f.api.giveWorkItemToAgent.mockRejectedValueOnce(new Error('lost response'))
  await click(screen.getByRole('button', { name: '交给 Agent' }))
  await click(screen.getByRole('button', { name: '确认执行' }))
  await screen.findByText(zh['work.unknown'])
  const original = f.api.giveWorkItemToAgent.mock.calls[0]![0]
  await click(screen.getByRole('button', { name: '查询或继续原请求' }))
  await waitFor(() => { expect(f.api.giveWorkItemToAgent).toHaveBeenCalledTimes(2) })
  expect(f.api.giveWorkItemToAgent.mock.calls[1]?.[0]).toEqual(original)
})

it('refreshes failed reads, shows unavailable recommendations, and clears the explicit Project selection', async () => {
  const f = await bench()
  f.api.queryMyWork.mockRejectedValueOnce(new Error('read failed'))
  await click(screen.getByRole('button', { name: '刷新' }))
  expect(screen.getByText(zh['work.failedRead'])).toBeTruthy()
  if (!MY_WORK.ok) throw new Error('fixture denied')
  f.api.queryMyWork.mockResolvedValue({ ok: true, projection: { ...MY_WORK.projection, items: [{ ...MY_WORK.projection.items[0]!, recommendation: { available: false, reason: 'active-work' } }] } })
  await click(screen.getByRole('button', { name: '刷新' }))
  expect(screen.getByText(zh['work.reason.active'])).toBeTruthy()
  await change(screen.getByLabelText('目标项目'), { target: { value: PROJECT_ID } })
  const createSection = screen.getByRole('region', { name: '提交新需求' })
  await click(within(createSection).getByRole('button', { name: '打开项目看板' }))
  expect(f.props.openBoard).toHaveBeenCalledWith(PROJECT_ID)
  f.api.queryBoard.mockResolvedValueOnce({ ok: false, reason: 'unavailable' })
  await click(screen.getByRole('button', { name: '刷新' }))
  expect(screen.getByText(zh['work.mappingBlocked'])).toBeTruthy()
  await change(screen.getByLabelText('目标项目'), { target: { value: '' } })
  expect(screen.queryByLabelText('标题')).toBeNull()
})

it('reports invalid answers and dismisses the native dialog on Escape', async () => {
  const f = await bench()
  const offer = { type: 'answer-intervention' as const, interventionId: 'intervention-0a1b2c3d-0000-4000-8000-000000000001' as Parameters<typeof f.controller.editAnswer>[0], expectedInterventionRevision: 3, requiredAnswer: { kind: 'text' as const, prompt: 'Continue?', maxLength: 80 }, reason: 'response-required' }
  await act(async () => { f.controller.confirm(offer) })
  await click(screen.getByRole('button', { name: '确认执行' }))
  expect(screen.getByRole('alert').textContent).toBe(zh['work.invalid'])
  await act(async () => { fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: true })) })
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each(['resume-intent', 'repair-mapping', 'inspect-before-retry'] as const)('preserves a partially created Issue with the backend %s recovery path', async (recovery) => {
  const f = await bench()
  f.api.createWorkItem.mockImplementationOnce(async intent => ({ ok: false, reason: 'unavailable', receipt: {
    id: intent.intentId.replace('intent-', 'receipt-') as Extract<Awaited<ReturnType<typeof f.api.createWorkItem>>, { ok: true }>['receipt']['id'],
    type: 'create-work-item', intentId: intent.intentId, projectId: intent.projectId, state: 'partial-failure', workItemId: ITEM.id,
    stage: 'project-item-status-set', recoveryAction: recovery === 'repair-mapping' ? { kind: recovery, reason: 'mapping-unavailable' } : { kind: recovery },
  } }))
  await act(async () => { f.controller.selectProject(PROJECT_ID); f.controller.editDraft({ title: 'Partial creation', intendedOutcome: 'Complete the original requirement.', acceptanceCriteria: 'One Issue' }); await f.controller.create() })
  const results = screen.getByRole('region', { name: '提交结果与恢复' })
  expect(within(results).getByText(zh['work.partial'])).toBeTruthy()
  await click(within(results).getByRole('button', { name: '查看工作项与结果' }))
  expect(f.props.openItem).toHaveBeenCalledWith(PROJECT_ID, ITEM.id)
  await click(within(results).getByRole('button', { name: '打开项目看板' }))
  expect(f.props.openBoard).toHaveBeenCalledWith(PROJECT_ID)
  expect(within(results).queryByRole('button', { name: '关闭结果' })).toBeNull()
  if (recovery === 'resume-intent') {
    const original = f.api.createWorkItem.mock.calls[0]![0]
    await click(within(results).getByRole('button', { name: '查询或继续原请求' }))
    expect(f.api.createWorkItem.mock.calls[1]?.[0]).toEqual(original)
  } else expect(within(results).queryByRole('button', { name: '查询或继续原请求' })).toBeNull()
})

it('keeps reconciliation results inspectable without a second creation or automatic retry', async () => {
  const f = await bench()
  f.api.createWorkItem.mockImplementationOnce(async intent => ({ ok: false, reason: 'reconciliation-required', receipt: {
    id: intent.intentId.replace('intent-', 'receipt-') as Extract<Awaited<ReturnType<typeof f.api.createWorkItem>>, { ok: true }>['receipt']['id'], type: 'create-work-item', intentId: intent.intentId, projectId: intent.projectId,
    state: 'reconciliation-required', reason: 'effect-unknown', stage: 'issue-create',
  } }))
  await act(async () => { f.controller.selectProject(PROJECT_ID); f.controller.editDraft({ title: 'Unknown creation', intendedOutcome: 'Inspect the original effect.', acceptanceCriteria: 'One Issue' }); await f.controller.create() })
  const results = screen.getByRole('region', { name: '提交结果与恢复' })
  expect(within(results).getByText(zh['work.reconcile'])).toBeTruthy()
  expect(within(results).queryByRole('button', { name: '查询或继续原请求' })).toBeNull()
  expect(within(results).getByRole('button', { name: '打开项目看板' })).toBeTruthy()
})

it('shows conflict outcomes and lets the operator acknowledge them', async () => {
  const f = await bench(); f.api.giveWorkItemToAgent.mockResolvedValueOnce({ ok: false, reason: 'conflict' })
  await click(screen.getByRole('button', { name: '交给 Agent' })); await click(screen.getByRole('button', { name: '确认执行' }))
  expect(screen.getByText(zh['work.conflict'])).toBeTruthy()
  await click(screen.getByRole('button', { name: '关闭结果' }))
  expect(screen.queryByText(zh['work.conflict'])).toBeNull()
})

it('shows a pending assignment and prevents a second click before acknowledgement', async () => {
  const f = await bench()
  const held = Promise.withResolvers<Awaited<ReturnType<typeof f.api.giveWorkItemToAgent>>>()
  f.api.giveWorkItemToAgent.mockReturnValueOnce(held.promise)
  await click(screen.getByRole('button', { name: '交给 Agent' }))
  await click(screen.getByRole('button', { name: '确认执行' }))
  expect(screen.getByText(zh['work.pending'])).toBeTruthy()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '交给 Agent' }).disabled).toBe(true)
  await act(async () => { held.resolve({ ok: false, reason: 'unavailable' }) })
  await screen.findByText(zh['work.unavailable'])
})

it('keeps unfamiliar backend recommendation reasons readable without inventing an action', async () => {
  const f = await bench()
  if (!MY_WORK.ok) throw new Error('fixture denied')
  f.api.queryMyWork.mockResolvedValueOnce({ ok: true, projection: { ...MY_WORK.projection, items: [{ ...MY_WORK.projection.items[0]!, recommendation: { available: false, reason: 'new-server-condition' } }] } })
  await click(screen.getByRole('button', { name: '刷新' }))
  expect(screen.getByText(zh['work.noAction'])).toBeTruthy()
  expect(screen.queryByRole('button', { name: '交给 Agent' })).toBeNull()
})
