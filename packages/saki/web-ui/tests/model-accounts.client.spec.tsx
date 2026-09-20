// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { sakiModelSupplyResultSchema } from '@breakfastdapaidang/saki-host-api/wire'
import { ModelAccountsController } from '../src/client/model-accounts-controller.ts'
import { ModelAccountsPage } from '../src/client/components/ModelAccountsPage.tsx'
import { NS, zh } from '../src/client/locales.ts'
import { planningFixture } from './planning-fixture.client.ts'

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
