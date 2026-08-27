import { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { describe, expect, it, vi } from 'vitest'
import SakiHostClientService from '../src/client/index.ts'
import {
  sakiConfigureGitHubSynchronizationIntentSchema,
  sakiQueryRequestSchema,
  sakiRegisterDevelopmentProjectIntentSchema,
} from '../src/wire.ts'

const HOST_ID = 'host-11111111-1111-4111-8111-111111111111'
const parsedProjectQuery = sakiQueryRequestSchema.parse({
  type: 'project-settings',
  projectId: 'project-22222222-2222-4222-8222-222222222222',
})
if (parsedProjectQuery.type !== 'project-settings') {
  throw new Error('expected Project Settings query fixture')
}
const PROJECT_ID = parsedProjectQuery.projectId

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
          ? { ok: false, reason: 'unavailable' }
          : endpoint === 'control/submit'
            ? { ok: false, reason: 'unavailable' }
            : { ok: true },
    }))
    const ctx = new Context()
    ctx.provide('connection', { rpc: { call } } as unknown as ConnectionHandle)
    const fiber = await ctx.plugin(SakiHostClientService)
    const workspaceQuery = sakiQueryRequestSchema.parse({
      type: 'development-workspace',
      projectId: PROJECT_ID,
      expectedRegistryRevision: 7,
    })
    if (workspaceQuery.type !== 'development-workspace') {
      throw new Error('expected Development Workspace query fixture')
    }
    const intent = sakiRegisterDevelopmentProjectIntentSchema.parse({
      type: 'register-development-project',
      intentId: 'intent-33333333-3333-4333-8333-333333333333',
      projectTitle: 'Client project',
      hostId: HOST_ID,
      directoryLocator: 'D:/repository',
      expectedRegistryRevision: 7,
      confirmedFingerprint: { version: 1, digest: '3'.repeat(64) },
      confirmedBaseline: {
        kind: 'unavailable',
        reason: 'io-failure',
        observed: { entries: 0, pathBytes: 0, gitOutputBytes: 0, hashedBytes: 0, elapsedMs: 0 },
      },
    })
    const githubIntent = sakiConfigureGitHubSynchronizationIntentSchema.parse({
      type: 'configure-github-synchronization',
      intentId: 'intent-44444444-4444-4444-8444-444444444444',
      projectId: PROJECT_ID,
      expectedSynchronizationRevision: 0,
      patch: { activePollIntervalMs: 45_000 },
    })

    await ctx.sakiHostClient.readAccess()
    await ctx.sakiHostClient.queryProjectIndex()
    await ctx.sakiHostClient.inspectProjectSelection(intent.hostId, 'D:/repository')
    await ctx.sakiHostClient.queryDevelopmentWorkspace(workspaceQuery.projectId, 7)
    await ctx.sakiHostClient.queryProjectSettings(PROJECT_ID)
    await ctx.sakiHostClient.queryBoard(PROJECT_ID, 'cached')
    await ctx.sakiHostClient.queryBoard(PROJECT_ID, 'interactive')
    await ctx.sakiHostClient.logout('request-token')
    await ctx.sakiHostClient.registerDevelopmentProject(intent, 'request-token')
    await ctx.sakiHostClient.configureGitHubSynchronization(githubIntent, 'request-token')

    expect(call.mock.calls).toEqual([
      ['/saki', 'access/read', {}, { credentials: 'same-origin' }],
      ['/saki', 'control/query', { type: 'project-index' }, { credentials: 'same-origin' }],
      ['/saki', 'control/query', {
        type: 'inspect-project-selection',
        hostId: HOST_ID,
        directoryLocator: 'D:/repository',
      }, { credentials: 'same-origin' }],
      ['/saki', 'control/query', {
        type: 'development-workspace',
        projectId: PROJECT_ID,
        expectedRegistryRevision: 7,
      }, { credentials: 'same-origin' }],
      ['/saki', 'control/query', {
        type: 'project-settings',
        projectId: PROJECT_ID,
      }, { credentials: 'same-origin' }],
      ['/saki', 'control/query', {
        type: 'board',
        projectId: PROJECT_ID,
        refresh: 'cached',
      }, { credentials: 'same-origin' }],
      ['/saki', 'control/query', {
        type: 'board',
        projectId: PROJECT_ID,
        refresh: 'interactive',
      }, { credentials: 'same-origin' }],
      ['/saki', 'access/logout', {}, {
        credentials: 'same-origin',
        headers: { 'x-saki-request-token': 'request-token' },
      }],
      ['/saki', 'control/submit', intent, {
        credentials: 'same-origin',
        headers: { 'x-saki-request-token': 'request-token' },
      }],
      ['/saki', 'control/submit', githubIntent, {
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

  it('rejects a result for a different protected query or Control Intent kind', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        value: {
          ok: true,
          projection: {
            type: 'inspect-project-selection',
            result: { ok: false, reason: 'missing' },
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          ok: true,
          projection: {
            type: 'project-index',
            revision: 0,
            hosts: [],
            projects: [],
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          ok: true,
          receipt: {
            id: 'receipt-55555555-5555-4555-8555-555555555555',
            intentId: 'intent-55555555-5555-4555-8555-555555555555',
            state: 'confirmed',
            projectId: PROJECT_ID,
            resourceBindingId: 'binding-66666666-6666-4666-8666-666666666666',
            registryRevision: 1,
          },
        },
      })
    const ctx = new Context()
    ctx.provide('connection', { rpc: { call } } as unknown as ConnectionHandle)
    const fiber = await ctx.plugin(SakiHostClientService)

    await expect(ctx.sakiHostClient.queryProjectIndex()).rejects.toThrow()
    await expect(ctx.sakiHostClient.queryBoard(PROJECT_ID, 'cached')).rejects.toThrow()
    const githubIntent = sakiConfigureGitHubSynchronizationIntentSchema.parse({
      type: 'configure-github-synchronization',
      intentId: 'intent-55555555-5555-4555-8555-555555555555',
      projectId: PROJECT_ID,
      expectedSynchronizationRevision: 0,
      patch: { activePollIntervalMs: 45_000 },
    })
    await expect(ctx.sakiHostClient.configureGitHubSynchronization(githubIntent, 'request-token')).rejects.toThrow()

    await fiber.dispose()
  })
})
