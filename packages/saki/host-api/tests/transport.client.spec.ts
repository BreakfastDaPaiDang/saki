import { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { describe, expect, it, vi } from 'vitest'
import SakiHostClientService from '../src/client/index.ts'

describe('Saki browser Host client', () => {
  it('requires an active Connection carrier', () => {
    expect(() => new SakiHostClientService(new Context())).toThrow('active Connection carrier')
  })

  it('uses same-origin credentials and sends request tokens only on mutations', async () => {
    const call = vi.fn(async (_channel: string, endpoint: string) => ({
      ok: true as const,
      value: endpoint === 'access/read'
        ? { kind: 'session-required', message: 'A local browser session is required.' }
        : endpoint === 'control/query'
          ? { ok: true, projection: { type: 'project-index', revision: 0, projects: [] } }
          : { ok: true },
    }))
    const ctx = new Context()
    ctx.provide('connection', { rpc: { call } } as unknown as ConnectionHandle)
    const fiber = await ctx.plugin(SakiHostClientService)

    await ctx.sakiHostClient.readAccess()
    await ctx.sakiHostClient.queryProjectIndex()
    await ctx.sakiHostClient.logout('request-token')

    expect(call.mock.calls).toEqual([
      ['/saki', 'access/read', {}, { credentials: 'same-origin' }],
      ['/saki', 'control/query', { type: 'project-index' }, { credentials: 'same-origin' }],
      ['/saki', 'access/logout', {}, {
        credentials: 'same-origin',
        headers: { 'x-saki-request-token': 'request-token' },
      }],
    ])
    await fiber.dispose()
  })

  it('exchanges a launcher secret with caller cancellation and rejects carrier errors', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { ok: false, reason: 'unavailable' } })
      .mockResolvedValueOnce({ ok: false, error: { code: 'disconnected', message: 'offline', details: {} } })
    const ctx = new Context()
    ctx.provide('connection', { rpc: { call } } as unknown as ConnectionHandle)
    const fiber = await ctx.plugin(SakiHostClientService)
    const controller = new AbortController()

    expect(await ctx.sakiHostClient.exchangeBootstrap('launcher-secret', controller.signal))
      .toEqual({ ok: false, reason: 'unavailable' })
    expect(call).toHaveBeenNthCalledWith(1, '/saki', 'access/exchange', { secret: 'launcher-secret' }, {
      credentials: 'same-origin',
      signal: controller.signal,
    })
    await expect(ctx.sakiHostClient.queryProjectIndex()).rejects.toThrow(
      'Saki Host request failed: disconnected',
    )
    await fiber.dispose()
  })
})
