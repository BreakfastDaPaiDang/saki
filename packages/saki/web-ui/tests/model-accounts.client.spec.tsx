// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { sakiSwitchWorkSessionModelIntentSchema, sakiSwitchWorkSessionModelResultSchema, sakiModelSupplyResultSchema, sakiProjectModelRouteResultSchema, sakiConfigureProjectModelRouteIntentSchema, sakiConfigureProjectModelRouteResultSchema } from '@breakfastdapaidang/saki-host-api/wire'
import { ModelAccountsController } from '../src/client/model-accounts-controller.ts'
import { ModelAccountsPage } from '../src/client/components/ModelAccountsPage.tsx'
import { ProjectModelSelection } from '../src/client/components/ProjectModelSelection.tsx'
import { NS, zh } from '../src/client/locales.ts'
import { planningFixture, PROJECT_ID } from './planning-fixture.client.ts'

const owners: Array<{ dispose(): void }> = []
beforeEach(() => { localStorage.clear() })
afterEach(() => { cleanup(); for (const owner of owners.splice(0)) owner.dispose() })
const t = ((key: keyof typeof zh) => zh[key]) as TranslateNS<typeof NS>
const result = sakiModelSupplyResultSchema.parse({ ok: true, projection: {
  type: 'model-supply', profiles: [], authorizations: [],
  providers: [{ id: 'codex', implementation: { name: 'fixture', version: '1' }, methods: [{ id: 'device_code', kind: 'device-code' }] }],
} })

async function setup() {
  const planning = planningFixture()
  owners.push(planning.controller)
  await planning.start()
  type Api = ConstructorParameters<typeof ModelAccountsController>[0]
  const api = {
    queryProjectModelRoute: vi.fn<Api['queryProjectModelRoute']>().mockResolvedValue(sakiProjectModelRouteResultSchema.parse({ ok: true, projection: {
      type: 'project-model-route', projectId: PROJECT_ID, projectRevision: 0, profile: {
        id: 'agent-profile-00000000-0000-4000-8000-000000000001', version: 1, agentPresetId: 'development',
        provider: null, model: null, account: null } } })),
    switchWorkSessionModel: vi.fn<Api['switchWorkSessionModel']>().mockResolvedValue({ ok: false, reason: 'unavailable' }),
    configureProjectModelRoute: vi.fn<Api['configureProjectModelRoute']>().mockResolvedValue({ ok: false, reason: 'unavailable' }),
    queryModelSupply: vi.fn<Api['queryModelSupply']>().mockResolvedValue(result),
    submitModelAccount: vi.fn<Api['submitModelAccount']>().mockImplementation(async intent => ({ ok: true,
      receipt: { intentId: intent.intentId, state: 'accepted', profileId: null } })),
    watchProjections: planning.api.watchProjections,
  }
  const controller = new ModelAccountsController(api, planning.controller)
  owners.push(controller)
  controller.start()
  await controller.refresh()
  return { api, controller, planning }
}

it('retains the exact unacknowledged authorization and clears it only after a receipt', async () => {
  const h = await setup()
  h.api.submitModelAccount.mockRejectedValueOnce(new Error('connection lost'))
  const provider = result.ok ? result.projection.providers[0] : undefined
  if (provider === undefined) throw new Error('missing fixture Provider')
  await h.controller.submit({ type: 'authorize-model-account', providerId: provider.id, name: 'Subscription', method: 'device_code' })
  const pending = h.controller.getSnapshot().pending[0]
  if (pending === undefined) throw new Error('missing unacknowledged Intent')
  expect(h.controller.getSnapshot().failure).toBe('unavailable')
  h.api.submitModelAccount.mockResolvedValueOnce({ ok: false, reason: 'denied' })
  await h.controller.retry(pending)
  expect(h.controller.getSnapshot().pending).toEqual([pending])
  await h.controller.retry(pending)
  expect(h.api.submitModelAccount.mock.calls.map(call => call[0])).toEqual([pending, pending, pending])
  expect(h.controller.getSnapshot().pending).toEqual([])
})

it('restarts projection watching after a successful explicit refresh', async () => {
  const h = await setup()
  h.planning.failWatch()
  await vi.waitFor(() => { expect(h.controller.getSnapshot().failure).toBe('unavailable') })
  const before = h.api.watchProjections.mock.calls.length
  await h.controller.refresh()
  expect(h.api.watchProjections.mock.calls.length).toBeGreaterThan(before)
  expect(h.controller.getSnapshot().failure).toBeNull()
})

it('submits the advertised authorization method from the account page', async () => {
  const h = await setup()
  const page = render(<ModelAccountsPage state={h.controller.getSnapshot()} actions={h.controller} t={t} />)
  expect(page.asFragment()).toMatchSnapshot('available subscription authorization')
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Subscription' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /设备码/ })) })
  expect(h.api.submitModelAccount.mock.calls[0]?.[0]).toMatchObject({ type: 'authorize-model-account',
    providerId: 'codex', method: 'device_code' })
})

it('imports the named settings connection without accepting credential material from the page', async () => {
  const h = await setup()
  h.api.queryModelSupply.mockResolvedValue(sakiModelSupplyResultSchema.parse({ ok: true, projection: {
    type: 'model-supply', profiles: [], authorizations: [],
    providers: [{ id: 'api', implementation: { name: 'fixture', version: '1' },
      methods: [{ id: 'relay', kind: 'stored-credential', name: 'Relay' }] }],
  } }))
  await h.controller.refresh()
  render(<ModelAccountsPage state={h.controller.getSnapshot()} actions={h.controller} t={t} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'My relay' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Relay/ })) })
  expect(h.api.submitModelAccount.mock.calls[0]?.[0]).toMatchObject({ type: 'authorize-model-account',
    providerId: 'api', method: 'relay', name: 'My relay', configuration: { connection: 'relay' } })
})

it('retains the selected account revision when a Project default acknowledgement is lost', async () => {
  const h = await setup()
  const intent = sakiConfigureProjectModelRouteIntentSchema.parse({ type: 'configure-project-model-route',
    intentId: 'intent-00000000-0000-4000-8000-000000000005', projectId: PROJECT_ID, expectedProjectRevision: 0,
    selection: { accountProfileId: '00000000-0000-4000-8000-000000000006', configurationRevision: 2, model: 'chosen-model' } })
  h.api.configureProjectModelRoute.mockRejectedValueOnce(new Error('acknowledgement lost'))
  await h.controller.retry(intent)
  expect(h.controller.getSnapshot().pending).toEqual([intent])
  const page = render(<ProjectModelSelection projectId={PROJECT_ID} state={h.controller.getSnapshot()} actions={h.controller} t={t} />)
  expect(page.asFragment()).toMatchSnapshot('pending Project model selection')
  expect(screen.getByRole('button', { name: zh['modelRoute.save'] }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByText(zh['modelRoute.noAccounts'])).toBeTruthy()
  h.api.configureProjectModelRoute.mockResolvedValueOnce(sakiConfigureProjectModelRouteResultSchema.parse({ ok: true,
    receipt: { intentId: intent.intentId, state: 'completed', profileId: 'agent-profile-00000000-0000-4000-8000-000000000005' } }))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['accounts.retry'] })) })
  expect(h.api.configureProjectModelRoute.mock.calls.map(call => call[0])).toEqual([intent, intent])
  expect(h.api.submitModelAccount).not.toHaveBeenCalled()
  expect(h.controller.getSnapshot().pending).toEqual([])
})


it('retains a pending switch through reconciliation and navigates only after exact completion', async () => {
  const h = await setup()
  const intent = sakiSwitchWorkSessionModelIntentSchema.parse({ type: 'switch-work-session-model',
    intentId: 'intent-00000000-0000-4000-8000-000000000007', projectId: PROJECT_ID,
    workSessionId: 'work-session-00000000-0000-4000-8000-000000000008', expectedWorkSessionRevision: 2,
    expectedAgentRunId: 'agent-run-00000000-0000-4000-8000-000000000009',
    selection: { accountProfileId: '00000000-0000-4000-8000-000000000006', configurationRevision: 2, model: 'chosen-model' } })
  const receipt = sakiSwitchWorkSessionModelResultSchema.parse({ ok: true, receipt: { intentId: intent.intentId,
    state: 'reconciliation-required', agentRunId: 'agent-run-00000000-0000-4000-8000-000000000007',
    sessionId: 'session-00000000-0000-4000-8000-000000000007' } })
  const navigate = vi.spyOn(h.planning.controller, 'navigate')
  h.api.switchWorkSessionModel.mockRejectedValueOnce(new Error('ack lost')).mockResolvedValueOnce(receipt)
  await h.controller.retry(intent)
  await h.controller.retry(intent)
  expect(h.controller.getSnapshot().pending).toEqual([intent])
  expect(navigate).not.toHaveBeenCalled()
  const page = render(<ProjectModelSelection projectId={PROJECT_ID} workSession={intent}
    state={h.controller.getSnapshot()} actions={h.controller} t={t} />)
  expect(page.asFragment()).toMatchSnapshot('pending Work Session model switch')
  expect(screen.getByRole('button', { name: zh['modelSwitch.save'] }).hasAttribute('disabled')).toBe(true)
  if (!receipt.ok) throw new Error('missing receipt')
  h.api.switchWorkSessionModel.mockResolvedValueOnce({ ok: true, receipt: { ...receipt.receipt, state: 'completed' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['accounts.retry'] })) })
  expect(h.api.switchWorkSessionModel.mock.calls.map(call => call[0])).toEqual([intent, intent, intent])
  expect(h.controller.getSnapshot().pending).toEqual([])
  expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ view: 'run', agentRunId: receipt.receipt.agentRunId }))
})


it('releases a rejected stale revision so the operator can select again', async () => {
  const h = await setup()
  h.api.configureProjectModelRoute.mockResolvedValueOnce({ ok: false, reason: 'conflict' })
  await h.controller.retry(sakiConfigureProjectModelRouteIntentSchema.parse({ type: 'configure-project-model-route',
    intentId: 'intent-00000000-0000-4000-8000-000000000005', projectId: PROJECT_ID, expectedProjectRevision: 0,
    selection: { accountProfileId: '00000000-0000-4000-8000-000000000006', configurationRevision: 1, model: 'chosen-model' } }))
  expect(h.controller.getSnapshot().pending).toEqual([])
  expect(h.controller.getSnapshot().failure).toBe('conflict')
})
