// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { SAKI_AGENT_RUN_VIEW_PROJECTION_FIXTURE as run, SAKI_PROJECT_SESSIONS_PROJECTION_FIXTURE as sessions } from '@breakfastdapaidang/saki-control-plane/fixtures'
import { sakiAgentRunViewResultSchema } from '@breakfastdapaidang/saki-host-api/wire'
import { SessionPage, type SessionPageProps } from '../src/client/components/SessionPage.tsx'
import { SessionReturn } from '../src/client/components/SessionReturn.tsx'
import { NS, zh } from '../src/client/locales.ts'
import { planningFixture } from './planning-fixture.client.ts'
import type { PlanningController } from '../src/client/planning-controller.ts'

const owners = new Set<PlanningController>()
beforeEach(() => { localStorage.clear() })
afterEach(() => { cleanup(); for (const owner of owners) owner.dispose(); owners.clear() })
const t = ((key: string, values?: Record<string, string | number>) => Object.entries(values ?? {}).reduce((copy, [name, value]) => copy.replaceAll(`{${name}}`, String(value)), (zh as Record<string, string>)[key] ?? key)) as TranslateNS<typeof NS>
const click = async (name: string) => { await act(async () => { fireEvent.click(screen.getByRole('button', { name })) }) }
async function bench(view: 'run' | 'sessions' = 'run') {
  const f = planningFixture(); owners.add(f.controller)
  f.api.queryProjectSessions.mockResolvedValue({ ok: true, projection: sessions })
  f.api.queryAgentRunView.mockResolvedValue({ ok: true, projection: run })
  await f.start()
  f.controller.navigate({ view, agentRunId: run.run.id, workItemId: run.workSession.workItem.id })
  await vi.waitFor(() => { expect(view === 'run' ? f.controller.getSnapshot().project?.run.value : f.controller.getSnapshot().project?.sessions.value).not.toBeNull() })
  const openSession = vi.fn(); const openWork = vi.fn()
  function View() {
    const state = useSyncExternalStore(f.controller.subscribe, f.controller.getSnapshot)
    return <SessionPage project={state.project!} actions={f.controller} offline={state.offline}
      openSession={openSession} openWork={openWork} t={t} />
  }
  const rendered = render(<View />)
  return { ...f, rendered, openSession, openWork }
}
it('records failed execution separately from delivered input and readable history after restart', async () => {
  const f = await bench()
  expect(screen.getByText(zh['runs.state.failed'])).toBeTruthy()
  expect(screen.getByText(zh['runs.historyAvailable'])).toBeTruthy()
  expect(screen.getByText(zh['runs.terminal.owner-not-live'])).toBeTruthy()
  expect({ headings: screen.getAllByRole('heading').map(element => element.textContent),
    actions: screen.getAllByRole('button').map(element => element.textContent),
    status: screen.getByRole('status').textContent,
    history: screen.getByText(zh['runs.historyAvailable']).textContent,
    terminal: screen.getByText(zh['runs.terminal.owner-not-live']).textContent,
  }).toMatchSnapshot()
  await click(zh['runs.tab.trace'])
  expect(screen.getByText((_text, element) => element?.tagName === 'P' && element.textContent.endsWith(` · ${zh['runs.dispatch.accepted']}`))).toBeTruthy()
  expect(screen.getByText(`${zh['runs.operation']} · ${zh['runs.inputDelivered']}`)).toBeTruthy()
  await click(zh['planning.openSession'])
  expect(f.openSession).toHaveBeenCalledWith(run.run.sessionId)
  await click(zh['changes.title'])
  expect(f.controller.getSnapshot().project?.address).toMatchObject({ view: 'changes', changesRunId: run.run.id, executionReturnView: 'run', runTab: 'trace' })
  expect(f.api.moveWorkItem).not.toHaveBeenCalled()
})
it('opens the current Run from a retained Work Session and returns to its Session page', async () => {
  const f = await bench('sessions')
  await click(zh['runs.current'])
  await vi.waitFor(() => { expect(screen.getByText(zh['runs.state.failed'])).toBeTruthy() })
  expect(f.controller.getSnapshot().project?.address).toMatchObject({ view: 'run', runReturnView: 'sessions', agentRunId: run.run.id })
  await click(zh['sessions.title'])
  expect(f.controller.getSnapshot().project?.address.view).toBe('sessions')
})
it('shows process state independently and reads older output with an exact Terminal selection', async () => {
  const f = await bench()
  const terminalId = 'terminal-11111111-1111-4111-8111-111111111111:pty-1'
  const result = sakiAgentRunViewResultSchema.parse({ ok: true, projection: { ...run, observation: { ...run.observation,
    terminals: { state: 'confirmed', items: [{ id: terminalId, name: 'Check output', type: 'bash', process: { state: 'running' } }], more: false,
      selected: { state: 'confirmed', id: terminalId, text: 'Current output\n', totalLines: 120, lineBegin: 0, lineEnd: 80, truncated: true } },
  } } })
  f.api.queryAgentRunView.mockResolvedValue(result)
  await act(async () => { await f.controller.refresh() })
  await click(zh['runs.tab.terminal'])
  expect(screen.getByText(zh['runs.terminal.running'])).toBeTruthy()
  expect(screen.getByText(zh['runs.state.failed'])).toBeTruthy()
  expect(screen.getByText('Current output')).toBeTruthy()
  expect(screen.getByText(zh['runs.terminal.truncated'])).toBeTruthy()
  await click('Check output')
  await click(zh['runs.nextPage'])
  await vi.waitFor(() => { expect(f.api.queryAgentRunView.mock.lastCall?.[0].terminal).toEqual({ id: terminalId, offset: 80 }) })
  f.api.queryAgentRunView.mockResolvedValue(sakiAgentRunViewResultSchema.parse({ ok: true, projection: { ...run,
    observation: { ...run.observation, terminals: { state: 'confirmed', items: [], more: false, selected: { state: 'missing', id: terminalId } } },
  } }))
  await act(async () => { await f.controller.refresh() })
  expect(screen.getByRole('alert').textContent).toBe(zh['runs.terminal.missing'])
})
it('keeps waiting intervention recovery in My Work and displays all Run identities in the overview', async () => {
  const f = await bench()
  const waiting = sakiAgentRunViewResultSchema.parse({ ok: true, projection: { ...run,
    status: 'waiting', run: { ...run.run, state: 'waiting' }, workSession: { ...run.workSession, runs: [{ ...run.workSession.runs[0], state: 'waiting' }] },
    interventions: [{ id: 'intervention-11111111-1111-4111-8111-111111111111', revision: 0, kind: 'text-input', state: 'open',
      targetPrincipalId: run.run.source.principalId, requiredAnswer: { kind: 'text', prompt: 'Choose the release scope.', maxLength: 100 },
      createdAt: run.run.createdAt, updatedAt: run.run.updatedAt,
      returnAddress: { kind: 'agent-run', projectId: run.projectId, workItemId: run.workSession.workItem.id, workSessionId: run.workSession.id, agentRunId: run.run.id },
    }],
  } })
  f.api.queryAgentRunView.mockResolvedValue(waiting)
  await act(async () => { await f.controller.refresh() })
  expect(screen.getByText(zh['runs.state.waiting'])).toBeTruthy()
  const references = screen.getByText(zh['planning.reference']).closest('details')!
  await act(async () => { references.open = true; fireEvent(references, new Event('toggle')) })
  expect(f.controller.getSnapshot().project?.address.runReferencesOpen).toBe(true)
  expect(screen.getByText(run.workSession.id)).toBeTruthy()
  expect(screen.getByText(run.run.sessionId)).toBeTruthy()
  await click(zh['runs.tab.trace'])
  await click(zh['runs.answer'])
  expect(f.openWork).toHaveBeenCalledOnce()
})
it('offers a Project return only on the exact Conversation address owned by the authenticated Principal', async () => {
  const f = planningFixture(); owners.add(f.controller); await f.start()
  f.controller.navigate({ view: 'run', agentRunId: run.run.id, conversationSessionId: run.run.sessionId })
  const openProject = vi.fn()
  const usePlanning = <T,>(select: (value: ReturnType<typeof f.controller.getSnapshot>) => T) =>
    select(useSyncExternalStore(f.controller.subscribe, f.controller.getSnapshot))
  const props = { sessionId: run.run.sessionId, usePlanning, openProject, t } as Parameters<typeof SessionReturn>[0]
  const rendered = render(<SessionReturn {...props} />)
  await click(zh['runs.back']); expect(openProject).toHaveBeenCalledOnce()
  await act(async () => { f.controller.navigate({ view: 'detail' }) })
  await click(zh['runs.returnProject']); expect(openProject).toHaveBeenCalledTimes(2)
  rendered.rerender(<SessionReturn {...props} sessionId={'session-unrelated' as typeof props.sessionId} />)
  expect(screen.queryByRole('button')).toBeNull()
  f.api.readAccess.mockResolvedValue({ kind: 'session-required', message: 'A local browser session is required.' })
  await act(async () => { await f.controller.reloadAccess() })
  rendered.rerender(<SessionReturn {...props} />)
  expect(screen.queryByRole('button')).toBeNull()
})

async function presentation() {
  const f = planningFixture(); owners.add(f.controller); await f.start()
  const navigate = vi.spyOn(f.controller, 'navigate').mockImplementation(() => {})
  const openItem = vi.spyOn(f.controller, 'openItem').mockImplementation(() => {})
  const refresh = vi.spyOn(f.controller, 'refresh').mockResolvedValue(undefined)
  const project = f.controller.getSnapshot().project!
  const props: SessionPageProps = { project: { ...project, address: { ...project.address, view: 'run', agentRunId: run.run.id },
    run: { value: run, failure: null, loading: false } },
  actions: f.controller, openSession: vi.fn(), openWork: vi.fn(), offline: false, t }
  const view = render(<SessionPage {...props} />)
  const show = (patch: Partial<SessionPageProps['project']>, offline = false) => {
    props.project = { ...props.project, ...patch }
    view.rerender(<SessionPage {...props} offline={offline} />)
  }
  return { props, show, navigate, openItem, refresh }
}

it('keeps empty and unavailable reads distinct and preserves Work Item and Delivery destinations', async () => {
  const f = await presentation()
  await click(zh['runs.refresh']); expect(f.refresh).toHaveBeenCalledOnce()
  await click(zh['changes.backItem']); expect(f.openItem).toHaveBeenCalledWith(run.workSession.workItem.id)
  await click(zh['delivery.title'])
  expect(f.navigate).toHaveBeenLastCalledWith({ view: 'delivery', workItemId: run.workSession.workItem.id, changesRunId: run.run.id, executionReturnView: 'run' })
  f.show({ address: { ...f.props.project.address, runReturnView: 'detail' } })
  await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: zh['changes.backItem'] })[0]!) })
  expect(f.navigate).toHaveBeenLastCalledWith({ view: 'detail' })
  f.show({ run: { value: null, failure: 'not-found', loading: false } }, true)
  expect(screen.getByText(zh['planning.offline'])).toBeTruthy()
  expect(screen.queryByText(zh['runs.state.failed'])).toBeNull()
  f.show({ address: { ...f.props.project.address, view: 'sessions' }, sessions: { value: null, failure: null, loading: true } })
  expect(screen.queryByText(zh['sessions.empty'])).toBeNull()
  f.show({ sessions: { value: { ...sessions, items: [] }, failure: null, loading: false } })
  expect(screen.getByText(zh['sessions.empty'])).toBeTruthy()
})

it('pages retained Sessions, clears the Work Item filter, and opens historical Runs explicitly', async () => {
  const f = await presentation()
  const currentId = 'agent-run-11111111-1111-4111-8111-111111111111' as typeof run.run.id
  const item = { ...run.workSession, workItem: { ...run.workSession.workItem, status: null },
    assignment: { ...run.workSession.assignment, currentAgentRunId: currentId },
    runs: [...run.workSession.runs, { ...run.workSession.runs[0]!, id: currentId }] }
  f.show({ address: { ...f.props.project.address, view: 'sessions', sessionsWorkItemId: item.workItem.id, sessionsAfter: item.id },
    sessions: { value: { ...sessions, items: [item], next: item.id }, failure: null, loading: false } })
  expect(screen.getByText(`${zh['delivery.workItemStatus']} ${zh['planning.unavailable']}`)).toBeTruthy()
  await click(zh['sessions.all']); expect(f.navigate).toHaveBeenLastCalledWith({ sessionsWorkItemId: null, sessionsAfter: null })
  await click(`#${item.workItem.issueNumber} ${item.workItem.title}`); expect(f.openItem).toHaveBeenCalledWith(item.workItem.id)
  await click(zh['runs.firstPage']); expect(f.navigate).toHaveBeenLastCalledWith({ sessionsAfter: null })
  await click(zh['runs.nextPage']); expect(f.navigate).toHaveBeenLastCalledWith({ sessionsAfter: item.id })
  await click(zh['runs.history']); expect(f.navigate).toHaveBeenLastCalledWith(expect.objectContaining({ view: 'run', agentRunId: run.run.id, runReturnView: 'sessions' }))
})

it('renders unavailable Session evidence and bounded Trace history without inventing input delivery', async () => {
  const f = await presentation()
  const value = { ...run, workSession: { ...run.workSession, workItem: { ...run.workSession.workItem, status: null } },
    observation: { ...run.observation, session: { state: 'unavailable' as const, reason: 'read-failed' as const },
      terminals: { state: 'confirmed' as const, items: [], more: false, selected: null } } }
  f.show({ run: { value, failure: null, loading: false } })
  expect(screen.getByText(zh['runs.session.read-failed'])).toBeTruthy()
  expect(screen.getByText(t('runs.terminal.available', { count: 0 }))).toBeTruthy()
  f.show({ run: { value: { ...value, observation: { ...value.observation,
    session: { state: 'confirmed', runtime: 'idle', activity: { state: 'idle', turn: null, endedAt: null } } } }, failure: null, loading: false } })
  expect(screen.getByText(zh['runs.historyAvailable'])).toBeTruthy()
  f.show({ address: { ...f.props.project.address, runTab: 'trace' }, run: { value: { ...run, dispatches: [] }, failure: null, loading: false } })
  expect(screen.getAllByText(zh['planning.none'])).toHaveLength(2)
  const dispatch = run.dispatches[0]!
  f.show({ address: { ...f.props.project.address, dispatchAfter: dispatch.id }, run: { value: { ...run,
    dispatches: [{ ...dispatch, reason: 'authority-revoked', operation: null }], nextDispatch: dispatch.id, earlierInterventions: true,
    interventions: [{ id: 'intervention-11111111-1111-4111-8111-111111111111' as RunViewIntervention['id'], revision: 1,
      kind: 'text-input', state: 'resolved', targetPrincipalId: run.run.source.principalId,
      requiredAnswer: { kind: 'text', prompt: 'Confirmed release scope.', maxLength: 100 }, createdAt: 1, updatedAt: 2,
      returnAddress: { kind: 'agent-run', projectId: run.projectId, workItemId: run.workSession.workItem.id, workSessionId: run.workSession.id, agentRunId: run.run.id } }],
  }, failure: null, loading: false } })
  expect(screen.getByText(zh['runs.noOperation'])).toBeTruthy()
  expect(screen.getByText(zh['runs.earlierInterventions'])).toBeTruthy()
  expect(screen.queryByRole('button', { name: zh['runs.answer'] })).toBeNull()
  await click(zh['runs.firstPage']); expect(f.navigate).toHaveBeenLastCalledWith({ dispatchAfter: null })
  await click(zh['runs.nextPage']); expect(f.navigate).toHaveBeenLastCalledWith({ dispatchAfter: dispatch.id })
  f.show({ run: { value: { ...run, dispatches: [{ ...dispatch, operation: { ...dispatch.operation!, state: 'failed' } }] }, failure: null, loading: false } })
  expect(screen.queryByText(`${zh['runs.operation']} · ${zh['runs.inputDelivered']}`)).toBeNull()
})
type RunViewIntervention = typeof run.interventions[number]

it('distinguishes absent Terminal providers, exited processes, and the last bounded output page', async () => {
  const f = await presentation()
  f.show({ address: { ...f.props.project.address, runTab: 'terminal' } })
  expect(screen.getByText(zh['runs.terminal.owner-not-live'])).toBeTruthy()
  const id = 'terminal-current:pty-1' as NonNullable<SessionPageProps['project']['address']['terminal']>['id']
  const otherId = 'terminal-current:pty-2' as typeof id
  const terminals = { state: 'confirmed' as const, items: [
    { id, name: null, type: 'bash', process: { state: 'exited' as const, exitCode: null, signal: null } },
    { id: otherId, name: 'Completed check', type: 'bash', process: { state: 'exited' as const, exitCode: 1, signal: 'SIGTERM' } },
  ], more: true, selected: null }
  f.show({ run: { value: { ...run, observation: { ...run.observation, terminals } }, failure: null, loading: false } })
  expect(screen.getByText(zh['runs.terminal.more'])).toBeTruthy()
  expect(screen.getAllByText(zh['runs.terminal.exited'])).toHaveLength(2)
  await click('bash'); expect(f.navigate).toHaveBeenLastCalledWith({ terminal: { id, offset: 0 } })
  f.show({ address: { ...f.props.project.address, terminal: { id, offset: 80 } }, run: { value: { ...run, observation: { ...run.observation,
    terminals: { ...terminals, more: false, selected: { state: 'confirmed', id, text: 'Last output', lineBegin: 80, lineEnd: 100, totalLines: 100, truncated: false } } } }, failure: null, loading: false } })
  expect(screen.getByText('Last output')).toBeTruthy()
  expect(screen.queryByRole('button', { name: zh['runs.nextPage'] })).toBeNull()
  expect(screen.queryByText(zh['runs.terminal.truncated'])).toBeNull()
  await click(zh['runs.firstPage']); expect(f.navigate).toHaveBeenLastCalledWith({ terminal: { id, offset: 0 } })
})
