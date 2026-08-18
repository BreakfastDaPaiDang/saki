import { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { describe, expect, it, vi } from 'vitest'
import SakiHostClientService from '../src/client/index.ts'

describe('Saki browser Host client', () => {
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
})
