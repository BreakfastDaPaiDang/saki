// @vitest-environment jsdom
/** Operator confirmation, delivery recovery, and retained remote evidence. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { sakiBranchDeliveryProjectionSchema } from '@breakfastdapaidang/saki-host-api/wire'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { DeliveryPage } from '../src/client/components/DeliveryPage.tsx'
import { NS, zh } from '../src/client/locales.ts'
import { deliveryFixture, DELIVERY_PROJECT, DELIVERY_WORKSPACE } from './delivery-fixture.client.ts'
import { changesFixture } from './changes-fixture.client.ts'
import type { DeliverySnapshot } from '../src/client/delivery-controller.ts'
import { planningFixture } from './planning-fixture.client.ts'
import { BRANCH } from './planning-evidence.client.ts'

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
  const f = deliveryFixture(); owners.add(f.controller); await f.start()
  const planning = planningFixture().controller; owners.add(planning)
  const gitActions = changesFixture().controller; owners.add(gitActions)
  const props = { project: DELIVERY_PROJECT, actions: f.controller, git: f.changes.getSnapshot(), gitActions, planning, principalName: 'Delivery operator', t }
  function View() { return <DeliveryPage {...props} state={useSyncExternalStore(f.controller.subscribe, f.controller.getSnapshot)} /> }
  const view = render(<View />)
  return { ...f, props, view }
}

it('records the operator-facing delivery navigation, stages, and editable fields', async () => {
  await bench()
  expect({
    headings: screen.getAllByRole('heading').map(element => element.textContent),
    actions: screen.getAllByRole('button').map(element => element.textContent),
    fields: screen.getAllByRole('textbox').map(element => element.closest('label')?.textContent),
  }).toMatchSnapshot()
})

it('requires an explicit confirmation for every delivery gesture and shows its exact target', async () => {
  const f = await bench()
  await act(async () => {
    fireEvent.change(screen.getByLabelText(zh['delivery.headRef']), { target: { value: 'feature/delivery' } })
    fireEvent.change(screen.getByLabelText(zh['delivery.baseRef']), { target: { value: 'master' } })
    fireEvent.change(screen.getByLabelText(zh['delivery.prTitle']), { target: { value: 'Reviewed PR title' } })
    fireEvent.change(screen.getByLabelText(zh['delivery.prBody']), { target: { value: 'Reviewed PR body' } })
  })
  const pairs = [
    ['save', f.api.saveBranchDelivery], ['push', f.api.pushBranchDelivery], ['create', f.api.createBranchDeliveryPullRequest],
    ['associate', f.api.associateBranchDeliveryPullRequest], ['review', f.api.markBranchDeliveryInReview], ['accept', f.api.acceptBranchDelivery],
  ] as const
  for (const [gesture, api] of pairs) {
    await click(screen.getByRole('button', { name: zh[`delivery.action.${gesture}`] }))
    const dialog = screen.getByRole('dialog', { name: zh[`delivery.action.${gesture}`] })
    expect(within(dialog).getByText('BreakfastDaPaiDang/saki')).toBeTruthy()
    expect(within(dialog).getByText(/Delivery operator/u)).toBeTruthy()
    expect(api).not.toHaveBeenCalled()
    if (gesture === 'push') expect(within(dialog).getByText('git-credential-manager')).toBeTruthy()
    if (gesture === 'create') {
      expect(within(dialog).getByText('Reviewed PR title')).toBeTruthy()
      expect(within(dialog).getByText('Reviewed PR body')).toBeTruthy()
    }
    await click(within(dialog).getByRole('button', { name: zh['delivery.confirmButton'] }))
    expect(api).toHaveBeenCalledOnce()
    await click(screen.getByRole('button', { name: zh['changes.acknowledge'] }))
  }
  expect(screen.getByText(`${zh['delivery.workItemStatus']} ${zh[`planning.status.${DELIVERY_PROJECT.detail.value!.workItem.status}`]}`)).toBeTruthy()
  expect(screen.queryByRole('region', { name: zh['delivery.acceptance'] })).toBeNull()
})

it('cancels dialogs without dispatch and replays the same push after response loss', async () => {
  const f = await bench()
  await click(screen.getByRole('button', { name: zh['delivery.action.push'] }))
  await act(async () => { fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: true, cancelable: true })) })
  expect(screen.queryByRole('dialog')).toBeNull(); expect(f.api.pushBranchDelivery).not.toHaveBeenCalled()
  await click(screen.getByRole('button', { name: zh['delivery.action.push'] }))
  await click(screen.getByRole('button', { name: zh['common.cancel'] }))
  f.api.pushBranchDelivery.mockRejectedValueOnce(new Error('response lost'))
  await click(screen.getByRole('button', { name: zh['delivery.action.push'] }))
  await click(screen.getByRole('button', { name: zh['delivery.confirmButton'] }))
  expect(screen.getByText(zh['delivery.unknown'])).toBeTruthy()
  expect(screen.queryByRole('button', { name: zh['changes.acknowledge'] })).toBeNull()
  await click(screen.getByRole('button', { name: zh['delivery.retry'] }))
  expect(f.api.pushBranchDelivery.mock.calls[1]?.[0]).toEqual(f.api.pushBranchDelivery.mock.calls[0]?.[0])
})

it('shows retained CI success alongside current read failure and keeps acceptance disabled', async () => {
  const f = await bench()
  const { acceptance: _acceptance, ...record } = BRANCH.delivery
  const view = { ...BRANCH, delivery: { ...record, phase: 'in-review' as const } }
  f.api.queryDeliveryWorkspace.mockResolvedValue({ ok: true, projection: { ...DELIVERY_WORKSPACE, branchDelivery: view,
    actions: { ...DELIVERY_WORKSPACE.actions, accept: { available: false, reasons: ['evidence-unconfirmed'] } } } })
  await click(screen.getByRole('button', { name: zh['delivery.refresh'] }))
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['delivery.action.accept'] }).disabled).toBe(true)
  expect(screen.getByText(zh['planning.state.successful'])).toBeTruthy()
  expect(screen.getByText(zh['planning.state.failure'], { exact: false })).toBeTruthy()
  expect(screen.getByRole('link', { name: `#45 ${BRANCH.pullRequest.confirmed!.fact.title}` }).getAttribute('href')).toBe(BRANCH.pullRequest.confirmed!.fact.url)
  expect(screen.getByText(zh['delivery.blockage.evidence-unconfirmed'])).toBeTruthy()
  expect(screen.queryByRole('region', { name: zh['delivery.acceptance'] })).toBeNull()
  f.api.queryDeliveryWorkspace.mockResolvedValue({ ok: true, projection: { ...DELIVERY_WORKSPACE, branchDelivery: BRANCH } })
  await click(screen.getByRole('button', { name: zh['delivery.refresh'] }))
  expect(screen.getByRole('region', { name: zh['delivery.acceptance'] }).textContent).toContain(BRANCH.delivery.acceptance!.actor.principalId)
  expect(screen.queryByRole('button', { name: zh['delivery.action.accept'] })).toBeNull()
})

it('offers navigation and local refresh even when delivery evidence cannot be read', async () => {
  const f = await bench()
  const navigate = vi.spyOn(f.props.planning, 'navigate').mockImplementation(() => {})
  const refresh = vi.spyOn(f.props.gitActions, 'refresh').mockResolvedValue(undefined)
  f.api.queryDeliveryWorkspace.mockRejectedValue(new Error('unavailable'))
  await click(screen.getByRole('button', { name: zh['delivery.refresh'] }))
  expect(screen.getByText(zh['delivery.readFailure'])).toBeTruthy()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['delivery.action.push'] }).disabled).toBe(true)
  await click(screen.getByRole('button', { name: zh['changes.backItem'] }))
  await click(screen.getByRole('button', { name: zh['changes.title'] }))
  await click(screen.getByRole('button', { name: zh['delivery.refreshLocal'] }))
  expect(navigate.mock.calls).toEqual([[{ view: 'detail' }], [{ view: 'changes' }]])
  expect(refresh).toHaveBeenCalledOnce()
})

it('renders missing, loading, and detached local observations without suggesting a Commit', async () => {
  const f = await bench(); const state = f.controller.getSnapshot()
  const missing: DeliverySnapshot = { ...state, read: { value: null, loading: true, failure: null }, inputError: 'local-stale' }
  const project = { ...DELIVERY_PROJECT, detail: { value: null, loading: true, failure: null } }
  f.view.rerender(<DeliveryPage {...f.props} project={project} state={missing}
    git={{ ...f.props.git, read: { value: null, loading: true, failure: null } }} />)
  expect(screen.getByText(zh['planning.loading'])).toBeTruthy()
  expect(screen.getByText(zh['changes.loading'])).toBeTruthy()
  expect(screen.getByText(zh['delivery.noSelection'])).toBeTruthy()
  expect(screen.getByText(zh['planning.noDelivery'])).toBeTruthy()
  expect(screen.getByText(zh['delivery.input.local-stale'])).toBeTruthy()
  expect(screen.getByLabelText<HTMLInputElement>(zh['delivery.headRef']).value).toBe('')
  expect(screen.getByLabelText<HTMLInputElement>(zh['delivery.prTitle']).value).toBe('')
  const local = f.props.git.read.value!
  f.view.rerender(<DeliveryPage {...f.props} state={{ ...missing, read: { ...missing.read, loading: false } }} git={{ ...f.props.git, read: { value: { ...local, result: { ok: false, reason: 'binding-stale' } }, loading: false, failure: null } }} />)
  expect(screen.getByText(zh['delivery.localUnavailable'])).toBeTruthy()
  const workspace = { ...DELIVERY_WORKSPACE, branchDelivery: null, pushCredentialHelper: null, association: { state: 'unavailable' as const } }
  f.view.rerender(<DeliveryPage {...f.props} state={{ ...state, read: { value: workspace, loading: false, failure: null } }} />)
  expect(screen.getByText(zh['delivery.association.unavailable'])).toBeTruthy()
})

it('keeps a pending request attributable when another Work Item is selected', async () => {
  const f = await bench(); f.controller.prepare('push')
  const confirmation = f.controller.getSnapshot().confirmation!
  const state = f.controller.getSnapshot()
  const navigate = vi.spyOn(f.props.planning, 'navigate').mockImplementation(() => {})
  const git = changesFixture(); owners.add(git.controller); await git.start()
  const held = Promise.withResolvers<Awaited<ReturnType<typeof git.api.stageFiles>>>()
  git.api.stageFiles.mockReturnValueOnce(held.promise)
  const local = git.controller.getSnapshot().read.value!
  if (!local.result.ok) throw new Error('Expected local changes')
  const pending = git.controller.changeIndex(local.result.observation.changes[0]!, 'stage-files')
  const other = { ...DELIVERY_PROJECT, address: { ...DELIVERY_PROJECT.address, workItemId: null } }
  const operation = { confirmation, pending: true, result: null }
  f.view.rerender(<DeliveryPage {...f.props} project={other} state={{ ...state, confirmation: null, operation }}
    git={git.controller.getSnapshot()} />)
  expect(screen.getByText(zh['delivery.sending'])).toBeTruthy()
  expect(screen.getByText(zh['delivery.changesPending'])).toBeTruthy()
  await click(screen.getByRole('button', { name: zh['delivery.openPending'] }))
  expect(navigate).toHaveBeenCalledWith({ workItemId: confirmation.workItemId })
  expect(screen.queryByRole('button', { name: zh['delivery.retry'] })).toBeNull()
  held.resolve({ ok: false, reason: 'unavailable' }); await pending
  f.view.rerender(<DeliveryPage {...f.props} state={{ ...state, confirmation: null, operation: { ...operation, pending: false, result: { ok: false, reason: 'denied' } } }} />)
  expect(screen.getByText(zh['delivery.unknown'])).toBeTruthy()
})

it('shows closed PR states, pending raw CI signals, and an explicit repair requirement', async () => {
  const f = await bench(); const state = f.controller.getSnapshot()
  const fact = BRANCH.ci.confirmed!.fact
  const pr = BRANCH.pullRequest.confirmed!
  const branch = sakiBranchDeliveryProjectionSchema.parse({ type: 'branch-delivery', refresh: { requested: 'cached', state: 'cached' }, branchDelivery: {
    ...BRANCH, delivery: { ...BRANCH.delivery, push: { intentId: BRANCH.delivery.lastIntentId, confirmedAt: 2 }, repair: { intentId: BRANCH.delivery.lastIntentId, reason: 'effect-unknown', recordedAt: 10 } },
    pullRequest: { ...BRANCH.pullRequest, confirmed: { ...pr, fact: { ...pr.fact, state: 'closed', merged: true } } },
    ci: { ...BRANCH.ci, confirmed: { confirmedAt: 10, fact: { ...fact,
      workflowRuns: [{ ...fact.workflowRuns[0], conclusion: undefined, status: 'in-progress' }],
      checkRuns: [{ ...fact.checkRuns[0], conclusion: undefined, status: 'queued' }],
      commitStatuses: [{ id: '301', context: 'External CI', state: 'pending', targetUrl: 'https://example.test/status', createdAt: 1, updatedAt: 2 }, { id: '302', context: 'Manual status', state: 'failure', createdAt: 1, updatedAt: 2 }],
    } } },
  } }).branchDelivery
  f.view.rerender(<DeliveryPage {...f.props}
    state={{ ...state, read: { value: { ...DELIVERY_WORKSPACE, branchDelivery: branch }, loading: false, failure: null } }} />)
  expect(screen.getByText(zh['delivery.prMerged'])).toBeTruthy()
  expect(screen.getByText(zh['delivery.receipt.reconciliation-required'])).toBeTruthy()
  expect(screen.getByRole('link', { name: 'External CI' }).getAttribute('href')).toBe('https://example.test/status')
  expect(screen.getByText(/Manual status/u)).toBeTruthy()
  expect(screen.getByText(/运行中/u)).toBeTruthy()
  f.view.rerender(<DeliveryPage {...f.props} state={{ ...state, read: { value: { ...DELIVERY_WORKSPACE, branchDelivery: { ...branch, pullRequest: { ...branch.pullRequest, confirmed: { ...pr, fact: { ...pr.fact, state: 'closed', merged: false } } } } }, loading: false, failure: null } }} />)
  expect(screen.getByText(zh['delivery.prClosed'])).toBeTruthy()
})
