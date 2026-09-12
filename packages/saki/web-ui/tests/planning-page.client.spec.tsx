// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { PlanningPage, type PlanningPageProps } from '../src/client/components/PlanningPage.tsx'
import { zh, NS } from '../src/client/locales.ts'
import { BOARD, ITEM, planningFixture, successfulMove } from './planning-fixture.client.ts'
import { SAKI_BOARD_PROJECTION_FIXTURES, SAKI_PROJECT_SETTINGS_PROJECTION_FIXTURES, SAKI_WORK_ITEM_RESULT_FIXTURES } from '@breakfastdapaidang/saki-control-plane/fixtures'
import { sakiBoardMutationOverlaySchema } from '@breakfastdapaidang/saki-host-api/wire'
import type { PlanningItem, PlanningMove } from '../src/client/planning-controller.ts'
import { MILESTONE, MILESTONE_SUMMARY } from './planning-evidence.client.ts'

const t = ((key: string, values?: Record<string, string | number>) => {
  let text = (zh as Record<string, string>)[key] ?? key
  for (const [name, value] of Object.entries(values ?? {})) text = text.replaceAll(`{${name}}`, String(value))
  return text
}) as TranslateNS<typeof NS>
const nativeDialogMethods = ['showModal', 'close'].map(name => ({
  name, descriptor: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name),
}))
beforeEach(() => {
  localStorage.clear()
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.removeAttribute('open') }
})
afterEach(() => {
  cleanup()
  for (const { name, descriptor } of nativeDialogMethods) {
    if (descriptor === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, name)
    else Object.defineProperty(HTMLDialogElement.prototype, name, descriptor)
  }
})
async function props(): Promise<PlanningPageProps> {
  const fixture = planningFixture()
  try {
    await fixture.start()
    for (const name of ['navigate', 'beginMove', 'closeMove', 'openItem', 'backToBoard', 'closeDetail'] as const) vi.spyOn(fixture.controller, name).mockImplementation(() => {})
    for (const name of ['move', 'drop', 'retryMove', 'refresh'] as const) vi.spyOn(fixture.controller, name).mockResolvedValue(undefined)
    vi.spyOn(fixture.navigation.actions, 'clearProject').mockImplementation(() => {})
    vi.spyOn(fixture.navigation.actions, 'showWork').mockImplementation(() => {})
    return {
      project: fixture.controller.getSnapshot().project!, offline: false,
      actions: fixture.controller, nav: fixture.navigation.actions, openSession: vi.fn(), t,
    }
  } finally { fixture.controller.dispose() }
}

it('accepts a refresh gesture while watch invalidation rereads the cached Board', async () => {
  const fixture = planningFixture()
  const cached = Promise.withResolvers<Awaited<ReturnType<typeof fixture.api.queryBoard>>>()
  function View() {
    const snapshot = useSyncExternalStore(fixture.controller.subscribe, fixture.controller.getSnapshot)
    return <PlanningPage project={snapshot.project!} offline={snapshot.offline} actions={fixture.controller}
      nav={fixture.navigation.actions} openSession={vi.fn()} t={t} />
  }
  try {
    await fixture.start()
    render(<View />)
    const refresh = screen.getByRole('button', { name: t('planning.refresh') })
    fireEvent.mouseDown(refresh)
    fixture.api.queryBoard.mockImplementationOnce(() => cached.promise)
    await act(async () => { fixture.invalidate() })
    await vi.waitFor(() => { expect(fixture.controller.getSnapshot().project!.board.loading).toBe(true) })
    await act(async () => {
      fireEvent.mouseUp(refresh)
      fireEvent.click(refresh)
    })
    expect(fixture.api.queryBoard.mock.calls.some(([, refresh]) => refresh === 'interactive')).toBe(true)
  } finally {
    await act(async () => {
      cached.resolve({ ok: true, projection: BOARD })
      fixture.controller.dispose()
    })
  }
})

it('displays confirmed status alongside optimistic position and an independent refresh failure', async () => {
  const initial = await props()
  const move = {
    state: 'pending' as const, result: null, intent: {
      type: 'move-work-item' as const,
      intentId: 'intent-00000000-0000-4000-8000-000000000001' as PlanningPageProps['project']['moves'][number]['intent']['intentId'],
      projectId: initial.project.id, workItemId: ITEM.id,
      expectedRemoteFingerprint: ITEM.remoteFingerprint, targetStatus: 'in-review' as const,
    },
  }
  render(<PlanningPage {...initial} project={{ ...initial.project, moves: [move], board: {
    value: BOARD, loading: true, failure: 'offline',
  } }} />)
  const column = screen.getByRole('region', { name: t('planning.status.in-review') })
  expect(within(column).getByRole('button', { name: `#${ITEM.issueNumber} ${ITEM.title}` })).toBeTruthy()
  expect(within(column).getByText('可开始 · 待确认 → 评审中')).toBeTruthy()
  expect(screen.getByRole('alert').textContent).toBe(t('planning.offline'))
  expect(screen.queryByRole('region', { name: t('planning.status.canceled') })).toBeNull()
  expect(within(column).getByRole('button', { name: t('planning.move') }).hasAttribute('disabled')).toBe(true)
})

function move(initial: PlanningPageProps): PlanningMove {
  return { state: 'pending', result: null, intent: {
    type: 'move-work-item', intentId: 'intent-00000000-0000-4000-8000-000000000001' as PlanningMove['intent']['intentId'],
    projectId: initial.project.id, workItemId: ITEM.id, expectedRemoteFingerprint: ITEM.remoteFingerprint, targetStatus: 'in-review',
  } }
}
function withItems(initial: PlanningPageProps, items: readonly PlanningItem[]): PlanningPageProps {
  return { ...initial, project: { ...initial.project, board: { ...initial.project.board, value: {
    ...BOARD, effectiveMutationAvailability: { available: true, reasons: [] }, confirmed: { ...BOARD.confirmed!, items },
  } } } }
}

it('routes navigation and filters through the planning actions', async () => {
  const initial = withItems(await props(), [ITEM])
  const view = render(<PlanningPage {...initial} />)
  fireEvent.click(screen.getByRole('button', { name: t('planning.selectProject') }))
  expect(initial.nav.clearProject).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: t('planning.refresh') }))
  expect(initial.actions.refresh).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: t('planning.board') }))
  expect(initial.actions.backToBoard).toHaveBeenCalledOnce()
  for (const [key, destination] of [['milestones', 'milestone'], ['workspace', 'workspace'], ['mapping', 'mapping']] as const) {
    fireEvent.click(screen.getByRole('button', { name: t(`planning.${key}`) }))
    expect(initial.actions.navigate).toHaveBeenLastCalledWith({ view: destination })
  }
  fireEvent.change(screen.getByRole('textbox', { name: t('planning.search') }), { target: { value: 'nothing matches' } })
  expect(initial.actions.navigate).toHaveBeenLastCalledWith({ filter: 'nothing matches' })
  fireEvent.click(screen.getByRole('checkbox'))
  expect(initial.actions.navigate).toHaveBeenLastCalledWith({ includeCanceled: true })
  fireEvent.click(screen.getByRole('button', { name: `#${ITEM.issueNumber} ${ITEM.title}` }))
  expect(initial.actions.openItem).toHaveBeenCalledWith(ITEM.id)
  fireEvent.click(screen.getByRole('button', { name: t('planning.move') }))
  expect(initial.actions.beginMove).toHaveBeenCalledWith(ITEM)
  view.rerender(<PlanningPage {...initial} project={{ ...initial.project, address: {
    ...initial.project.address, filter: 'nothing matches', includeCanceled: true,
  } }} />)
  expect(screen.queryByRole('article')).toBeNull()
  expect(screen.getByRole('region', { name: t('planning.status.canceled') })).toBeTruthy()
})

it('retains drag identity and distinguishes card anchors from empty column destinations', async () => {
  const initial = withItems(await props(), [ITEM])
  const view = render(<PlanningPage {...initial} />)
  const transfer = { setData: vi.fn(), getData: vi.fn(() => 'exact-drag-identity'), effectAllowed: '' }
  const card = screen.getByRole('article')
  fireEvent.dragStart(card, { dataTransfer: transfer })
  expect(transfer.setData).toHaveBeenCalledWith('text/plain', `${ITEM.id} ${ITEM.remoteFingerprint}`)
  expect(transfer.effectAllowed).toBe('move')
  for (const target of [card, screen.getByRole('region', { name: t('planning.status.ready') })]) {
    expect(fireEvent.dragOver(target)).toBe(false)
    fireEvent.drop(target, { dataTransfer: transfer })
    expect(initial.actions.drop).toHaveBeenLastCalledWith('exact-drag-identity', 'ready', ITEM)
  }
  fireEvent.drop(screen.getByRole('region', { name: t('planning.status.backlog') }), { dataTransfer: transfer })
  expect(initial.actions.drop).toHaveBeenLastCalledWith('exact-drag-identity', 'backlog', null)
  vi.mocked(initial.actions.drop).mockClear()
  view.rerender(<PlanningPage {...initial} offline />)
  for (const target of [card, screen.getByRole('region', { name: t('planning.status.ready') })]) {
    expect(fireEvent.dragOver(target)).toBe(true)
    fireEvent.drop(target, { dataTransfer: transfer })
  }
  expect(initial.actions.drop).not.toHaveBeenCalled()
  expect(card.getAttribute('draggable')).toBe('false')
})

it.each(['keep', 'top', 'anchor', 'missing-fingerprint'] as const)('submits keyboard ordering with %s and closes the dialog', async (position) => {
  const anchor = { ...ITEM, id: `${ITEM.id}-anchor` as PlanningItem['id'], issueNumber: 42, title: 'Position anchor' }
  const initial = withItems(await props(), [ITEM, anchor])
  const draft = {
    workItemId: ITEM.id, expectedRemoteFingerprint: ITEM.remoteFingerprint, targetStatus: 'ready' as const,
    position: position === 'anchor' || position === 'missing-fingerprint' ? anchor.id : position,
    afterFingerprint: position === 'anchor' ? anchor.remoteFingerprint : null,
  }
  render(<PlanningPage {...initial} project={{ ...initial.project, address: { ...initial.project.address, moveDraft: draft } }} />)
  const dialog = screen.getByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: t('planning.confirmMove') }))
  expect(initial.actions.move).toHaveBeenCalledWith(ITEM.id, ITEM.remoteFingerprint, 'ready', position === 'top' ? null : position === 'anchor' ? { id: anchor.id, fingerprint: anchor.remoteFingerprint } : undefined)
  expect(initial.actions.closeMove).toHaveBeenCalledOnce()
  expect(screen.getByRole('status').textContent).toContain(t('planning.status.ready'))
})

it('edits and cancels a movement draft, then rejects submission when its item disappears or writes stop', async () => {
  const anchor = { ...ITEM, id: `${ITEM.id}-anchor` as PlanningItem['id'], issueNumber: 42 }
  const initial = withItems(await props(), [ITEM, anchor])
  const draft = { workItemId: ITEM.id, expectedRemoteFingerprint: ITEM.remoteFingerprint, targetStatus: 'ready' as const, position: 'keep' as const, afterFingerprint: null }
  const project = { ...initial.project, address: { ...initial.project.address, moveDraft: draft } }
  const view = render(<PlanningPage {...initial} project={project} />)
  const dialog = screen.getByRole('dialog')
  fireEvent.change(within(dialog).getByLabelText(t('planning.moveTarget')), { target: { value: 'done' } })
  expect(initial.actions.navigate).toHaveBeenLastCalledWith({ moveDraft: { ...draft, targetStatus: 'done' } })
  const position = within(dialog).getByLabelText(t('planning.movePosition'))
  for (const value of ['top', 'keep', anchor.id]) {
    fireEvent.change(position, { target: { value } })
    expect(initial.actions.navigate).toHaveBeenLastCalledWith({ moveDraft: {
      ...draft, position: value, afterFingerprint: value === anchor.id ? anchor.remoteFingerprint : null,
    } })
  }
  const navigations = vi.mocked(initial.actions.navigate).mock.calls.length
  fireEvent.change(position, { target: { value: '' } })
  expect(initial.actions.navigate).toHaveBeenCalledTimes(navigations)
  fireEvent(dialog, new Event('cancel', { bubbles: false, cancelable: true }))
  fireEvent.click(within(dialog).getByRole('button', { name: t('planning.cancel') }))
  expect(initial.actions.closeMove).toHaveBeenCalledTimes(2)
  view.rerender(<PlanningPage {...initial} offline project={project} />)
  fireEvent.submit(dialog.querySelector('form')!)
  expect(initial.actions.move).not.toHaveBeenCalled()
  view.rerender(<PlanningPage {...initial} project={{ ...project, board: { ...project.board, value: null } }} />)
  fireEvent.submit(dialog.querySelector('form')!)
  expect(initial.actions.move).not.toHaveBeenCalled()
  expect(within(dialog).getByRole('button', { name: t('planning.confirmMove') }).hasAttribute('disabled')).toBe(true)
})

it('retains an explicitly chosen anchor fingerprint when that card leaves the visible candidates', async () => {
  const initial = withItems(await props(), [ITEM])
  render(<PlanningPage {...initial} project={{ ...initial.project, address: { ...initial.project.address, moveDraft: {
    workItemId: ITEM.id, expectedRemoteFingerprint: ITEM.remoteFingerprint, targetStatus: 'ready',
    position: `work-item-${'9'.repeat(64)}` as typeof ITEM.id, afterFingerprint: ITEM.remoteFingerprint,
  } } }} />)
  fireEvent.click(screen.getByRole('button', { name: t('planning.confirmMove') }))
  expect(initial.actions.move).toHaveBeenCalledWith(ITEM.id, ITEM.remoteFingerprint, 'ready', {
    id: `work-item-${'9'.repeat(64)}`, fingerprint: ITEM.remoteFingerprint,
  })
})

it('reopens terminal Issues to their recorded nonterminal state or Backlog', async () => {
  const initial = withItems(await props(), [{ ...ITEM, status: 'done', issueState: 'closed', latestNonTerminalStatus: 'in-review', archived: true, notInProject: true }])
  const view = render(<PlanningPage {...initial} />)
  expect(screen.getByText(t('planning.archived'))).toBeTruthy()
  expect(screen.getByText(t('planning.inboxMark'))).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: t('planning.reopen') }))
  expect(initial.actions.move).toHaveBeenLastCalledWith(ITEM.id, ITEM.remoteFingerprint, 'in-review')
  view.rerender(<PlanningPage {...withItems(initial, [{ ...ITEM, status: 'canceled', issueState: 'closed', latestNonTerminalStatus: null }])} project={{ ...withItems(initial, [{ ...ITEM, status: 'canceled', issueState: 'closed', latestNonTerminalStatus: null }]).project, address: { ...initial.project.address, includeCanceled: true } }} />)
  fireEvent.click(screen.getByRole('button', { name: t('planning.reopen') }))
  expect(initial.actions.move).toHaveBeenLastCalledWith(ITEM.id, ITEM.remoteFingerprint, 'backlog')
})

it.each(['success', 'lost', 'conflict', 'reconciliation-required', 'denied', 'canceled', 'unavailable'] as const)('announces a %s receipt and exposes only retryable acknowledgments', async (outcome) => {
  const initial = withItems(await props(), [ITEM])
  const attempt = move(initial)
  const successful = successfulMove(attempt.intent)
  if (!successful.ok) throw new Error('Success fixture unavailable')
  const result: PlanningMove['result'] = outcome === 'lost' ? null : outcome === 'success' ? successful
    : outcome === 'conflict' ? SAKI_WORK_ITEM_RESULT_FIXTURES.conflict
      : outcome === 'reconciliation-required' ? { ok: false, reason: outcome, receipt: { ...successful.receipt, state: 'reconciliation-required', reason: 'effect-unknown', stage: 'project-item-status-set' } }
        : outcome === 'canceled' ? { ok: false, reason: outcome, receipt: { ...successful.receipt, state: 'canceled', reason: 'authority-revoked' } }
          : outcome === 'denied' ? { ok: false, reason: 'denied' } : { ok: false, reason: 'unavailable' }
  const settled: PlanningMove = { ...attempt, state: 'unacknowledged', result }
  render(<PlanningPage {...initial} project={{ ...initial.project, moves: [settled] }} />)
  const retry = screen.queryByRole('button', { name: t('planning.retryMove') })
  expect(retry !== null).toBe(outcome !== 'reconciliation-required')
  if (retry !== null) {
    fireEvent.click(retry)
    expect(initial.actions.retryMove).toHaveBeenCalledWith(attempt.intent.intentId)
  }
  const key = outcome === 'success' ? 'planning.succeeded' : outcome === 'conflict' ? 'planning.conflict' : outcome === 'reconciliation-required' ? 'planning.reconciliation' : outcome === 'denied' || outcome === 'canceled' ? 'planning.state.canceled' : 'planning.unacknowledged'
  expect(screen.getByRole('status').textContent).toContain(t(key))
  expect(screen.getByText(`${t('planning.moveTargetLabel', { status: t(`planning.status.${attempt.intent.targetStatus}`) })} · ${t(key)}`)).toBeTruthy()
})

it('keeps partial creation recovery distinct from move reconciliation and external Issue repairs', async () => {
  const initial = withItems(await props(), [ITEM])
  const attempt = move(initial)
  const base = SAKI_WORK_ITEM_RESULT_FIXTURES.partialFailure
  const local: PlanningMove = { ...attempt, state: 'unacknowledged', result: { ...base, receipt: { ...base.receipt, type: 'move-work-item' } } }
  const overlay = (value: object, n: number) => sakiBoardMutationOverlaySchema.parse({ intentId: `intent-00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, ...value })
  const overlays = [
    overlay({ state: 'optimistic', type: 'create-work-item', title: 'Creation pending', targetStatus: 'inbox' }, 2),
    overlay({ state: 'partial-failure', type: 'create-work-item', stage: 'project-item-add', recoveryAction: { kind: 'resume-intent' } }, 3),
    overlay({ state: 'reconciliation-required', type: 'move-work-item', workItemId: ITEM.id, stage: 'issue-state-set', reason: 'effect-unknown' }, 4),
    overlay({ state: 'optimistic', type: 'move-work-item', workItemId: ITEM.id, targetStatus: 'ready' }, 5),
    overlay({ state: 'targeted-confirmed', type: 'move-work-item', workItem: ITEM, confirmedAt: 10 }, 6),
    overlay({ state: 'conflict', type: 'move-work-item', reason: 'stale-remote', intentId: attempt.intent.intentId }, 1),
    sakiBoardMutationOverlaySchema.parse({ state: 'repair-required', workItemId: ITEM.id, reason: 'external-close', action: 'move-with-actor', suggestedStatus: 'done' }),
  ]
  const view = render(<PlanningPage {...initial} project={{ ...initial.project, moves: [local],
    board: { ...initial.project.board, value: { ...initial.project.board.value!, mutationOverlays: overlays } },
  }} />)
  expect(screen.getByText(t('planning.classifyClose'))).toBeTruthy()
  expect(screen.getAllByRole('button', { name: t('planning.workRecovery') })).toHaveLength(2)
  fireEvent.click(screen.getAllByRole('button', { name: t('planning.workRecovery') })[0]!)
  expect(initial.nav.showWork).toHaveBeenCalledOnce()
  expect(screen.getByRole('status').textContent).toContain(t('planning.state.partial-failure'))
  view.rerender(<PlanningPage {...initial} project={{ ...initial.project, moves: [{ ...attempt, state: 'settled', result: successfulMove(attempt.intent) }], board: { ...initial.project.board, value: {
    ...initial.project.board.value!, mutationOverlays: [sakiBoardMutationOverlaySchema.parse({ state: 'repair-required', workItemId: ITEM.id, reason: 'external-reopen', action: 'move-with-actor', suggestedStatus: 'backlog' })],
  } } }} />)
  expect(screen.getByText(t('planning.repairReopen'))).toBeTruthy()
  expect(screen.queryByRole('button', { name: t('planning.retryMove') })).toBeNull()
})

it('opens each planning destination and restores focus only to a retained Board item', async () => {
  const initial = withItems(await props(), [ITEM])
  const project = { ...initial.project, address: { ...initial.project.address, workItemId: ITEM.id },
    milestones: { value: { type: 'project-milestones' as const, projectId: initial.project.id, items: [MILESTONE_SUMMARY], next: null }, loading: false, failure: null },
    milestone: { value: MILESTONE, loading: false, failure: null },
  }
  const view = render(<PlanningPage {...initial} project={project} />)
  expect(document.activeElement).toBe(screen.getByRole('button', { name: `#${ITEM.issueNumber} ${ITEM.title}` }))
  for (const destination of ['mapping', 'detail', 'milestone'] as const) {
    view.rerender(<PlanningPage {...initial} project={{ ...project, address: { ...project.address, view: destination } }} />)
    expect(screen.queryByRole('article')).toBeNull()
  }
  fireEvent.click(screen.getByRole('button', { name: 'saki-v0.1.0 · 推进中' }))
  expect(initial.actions.navigate).toHaveBeenLastCalledWith({ view: 'milestone', milestoneId: MILESTONE_SUMMARY.id })
  view.rerender(<PlanningPage {...initial} project={{ ...project, address: { ...project.address, workItemId: null } }} />)
  expect(screen.getByRole('article')).toBeTruthy()
})

it('shows initial synchronization and retained scan failure without replacing confirmed cards', async () => {
  const initial = await props()
  const view = render(<PlanningPage {...initial} project={{ ...initial.project, board: { value: null, loading: true, failure: null } }} />)
  expect(screen.getByText(t('planning.noBoard'))).toBeTruthy()
  view.rerender(<PlanningPage {...initial} project={{ ...initial.project,
    board: { value: SAKI_BOARD_PROJECTION_FIXTURES.awaitingFirstCheckpoint, loading: false, failure: null },
  }} />)
  expect(screen.queryByText(t('planning.retained'))).toBeNull()
  view.rerender(<PlanningPage {...initial} project={{ ...initial.project,
    board: { value: { ...BOARD, scan: SAKI_PROJECT_SETTINGS_PROJECTION_FIXTURES.activating.synchronization.scan },
      loading: false, failure: null },
  }} />)
  expect(screen.getByText(t('planning.retained'))).toBeTruthy()
  view.rerender(<PlanningPage {...initial} project={{ ...initial.project,
    board: { value: SAKI_BOARD_PROJECTION_FIXTURES.confirmedStaleFailure, loading: false, failure: null },
  }} />)
  expect(screen.getByRole('article')).toBeTruthy()
  expect(screen.getByRole('alert').textContent).toContain(t('planning.failure.provider'))
})

it('hides protected card facts and an open movement draft when Project access is denied', async () => {
  const initial = await props()
  render(<PlanningPage {...initial} project={{ ...initial.project,
    board: { value: null, loading: false, failure: 'denied' },
    address: { ...initial.project.address, moveDraft: {
      workItemId: ITEM.id, expectedRemoteFingerprint: ITEM.remoteFingerprint,
      targetStatus: 'ready', position: 'keep', afterFingerprint: null,
    } },
  }} />)
  expect(screen.getByRole('alert').textContent).toBe(t('planning.denied'))
  expect(screen.queryByRole('article')).toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('button', { name: t('planning.workspace') })).toBeTruthy()
})
