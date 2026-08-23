import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalSakiHostExecution from '@breakfastdapaidang/saki-execution-local'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import { RpcId, type ClientRequest, type ServerResponse } from '@deepseek-ai/dsh-host-apiproxy/api'
import SakiControlPlane from '@breakfastdapaidang/saki-control-plane'
import type { SakiAccessExchangeResult, SakiAccessLogoutResult } from '@breakfastdapaidang/saki-control-plane'
import { takeSakiCookieHeader } from '@breakfastdapaidang/saki-control-plane/host'
import { CONTROL_STATE_KEY, sakiControlPlaneDomainSpec } from '@breakfastdapaidang/saki-control-plane/src/spec.ts'
import * as SakiHostApi from '../src/index.ts'
import { promisify } from 'node:util'

const run = promisify(execFile)

const tempDirectories: string[] = []
const activeContexts = new Set<Context>()
const OPAQUE_ERROR_RESULT = {
  ok: false,
  error: { code: 'internal', message: 'Saki request is unavailable', details: {} },
} as const

interface RunningHost {
  readonly context: Context
  readonly origin: string
  readonly directory: string
  readonly close: () => Promise<void>
}

async function start(): Promise<RunningHost> {
  const directory = await mkdtemp(join(tmpdir(), 'saki-host-api-'))
  tempDirectories.push(directory)
  const context = new Context()
  activeContexts.add(context)
  await context.plugin(Storage)
  await context.plugin(StorageJson, { root: join(directory, 'storages') })
  await context.plugin(StorageSqlite, { path: join(directory, 'saki.sqlite'), journalMode: 'delete' })
  await context.plugin(StorageDomain, { backend: 'json', routes: { saki_control_plane: 'sqlite' } })
  context.provide('sessionPersistence', { list: () => Promise.resolve([]) } as never)
  await context.plugin(WorkspaceRegistry)
  await context.plugin(LocalFileSystem, { cwd: directory })
  await context.plugin(LocalSubprocessRuntime)
  await context.plugin(LocalSakiHostExecution)
  await context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const origin = `http://127.0.0.1:${String(context.webServer.port)}`
  await context.plugin(Connection, { trustedHosts: [] })
  await context.plugin(SakiControlPlane, {
    origin,
    challengeTtlMs: 60_000,
    sessionTtlMs: 3_600_000,
    terminalRetentionMs: 86_400_000,
    cookieName: 'saki_session',
  })
  await context.plugin(SakiHostApi)
  return {
    context,
    origin,
    directory,
    close: async () => {
      activeContexts.delete(context)
      await context.fiber.dispose()
    },
  }
}

async function repository(host: RunningHost): Promise<string> {
  const path = join(host.directory, 'repository')
  await run('git', ['init', path], { windowsHide: true })
  await run('git', ['config', 'user.name', 'Saki Test'], { cwd: path, windowsHide: true })
  await run('git', ['config', 'user.email', 'saki@example.invalid'], { cwd: path, windowsHide: true })
  await writeFile(join(path, 'tracked.txt'), 'initial\n')
  await run('git', ['add', 'tracked.txt'], { cwd: path, windowsHide: true })
  await run('git', ['commit', '-m', 'initial'], { cwd: path, windowsHide: true })
  return path
}

async function rpc(
  host: RunningHost,
  endpoint: string,
  payload: unknown,
  headers: Readonly<Record<string, string>> = {},
): Promise<{ readonly response: Response; readonly message: ServerResponse }> {
  const request: ClientRequest = {
    type: 'client-request',
    rpcId: RpcId(`test-${endpoint}`),
    method: endpoint,
    payload,
  }
  const response = await fetch(`${host.origin}/saki/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: host.origin, ...headers },
    body: JSON.stringify(request),
  })
  return { response, message: await response.json() as ServerResponse }
}

function cookiePair(setCookie: string): string {
  return setCookie.split(';', 1)[0]!
}

function controlDomain(host: RunningHost): Domain<typeof sakiControlPlaneDomainSpec> {
  return host.context.storageDomain.get(sakiControlPlaneDomainSpec.name) as unknown as
    Domain<typeof sakiControlPlaneDomainSpec>
}

afterEach(async () => {
  await Promise.all([...activeContexts].map(async (context) => { await context.fiber.dispose() }))
  activeContexts.clear()
  await Promise.all(tempDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Saki /saki Host transport', () => {
  it('bootstraps, inspects, registers, queries the Project, and logs out over the real Connection route', async () => {
    const host = await start()
    const repo = await repository(host)
    await run('git', [
      'remote', 'add', 'origin', 'https://remote-user:remote-secret@example.com/org/repo.git?token=x#fragment',
    ], { cwd: repo, windowsHide: true })
    const initial = await rpc(host, 'access/read', {})
    expect(initial.response.headers.get('cache-control')).toBe('no-store')
    expect(initial.message.result).toEqual({
      ok: true,
      value: { kind: 'bootstrap-required', message: 'Local bootstrap is required.' },
    })

    const secret = host.context.sakiControlPlane.bootstrap.take()!.consume()
    const exchange = await rpc(host, 'access/exchange', { secret })
    expect(exchange.message.result).toMatchObject({ ok: true, value: { ok: true, access: { kind: 'authenticated' } } })
    expect(exchange.response.headers.get('cache-control')).toBe('no-store')
    expect(JSON.stringify(exchange.message)).not.toContain(secret)
    const setCookie = exchange.response.headers.get('set-cookie')!
    expect(setCookie).toContain('HttpOnly')
    const cookie = cookiePair(setCookie)
    const access = (exchange.message.result as { value: { access: { requestToken: string } } }).value.access

    const query = await rpc(host, 'control/query', { type: 'project-index' }, { cookie })
    expect(query.message.result).toMatchObject({
      ok: true,
      value: { ok: true, projection: { type: 'project-index', revision: 0, projects: [], hosts: [{ state: 'enrolled' }] } },
    })
    expect(query.response.headers.get('cache-control')).toBe('no-store')

    const hostId = (query.message.result as { value: { projection: { hosts: [{ id: string }] } } }).value.projection.hosts[0].id
    const inspected = await rpc(host, 'control/query', {
      type: 'inspect-project-selection', hostId, directoryLocator: repo,
    }, { cookie })
    expect(inspected.message.result).toMatchObject({
      ok: true,
      value: { ok: true, projection: { type: 'inspect-project-selection', result: { ok: true } } },
    })
    const inspectedBody = JSON.stringify(inspected.message)
    expect(inspectedBody).toContain('example.com/org/repo')
    expect(inspectedBody).not.toContain(repo)
    expect(inspectedBody).not.toMatch(/tracked\.txt|remote-user|remote-secret|token|fragment/u)
    const selection = (inspected.message.result as {
      value: { projection: { result: { selection: { fingerprint: unknown; baseline: unknown } } } }
    }).value.projection.result.selection
    const registered = await rpc(host, 'control/submit', {
      type: 'register-development-project',
      intentId: 'intent-11111111-1111-4111-8111-111111111111',
      projectTitle: 'Transport project',
      hostId,
      directoryLocator: repo,
      expectedRegistryRevision: 0,
      confirmedFingerprint: selection.fingerprint,
      confirmedBaseline: selection.baseline,
    }, {
      cookie,
      'x-saki-request-token': access.requestToken,
    })
    expect(registered.message.result).toMatchObject({ ok: true, value: { ok: true, receipt: { state: 'confirmed' } } })
    expect(registered.response.headers.get('cache-control')).toBe('no-store')
    const after = await rpc(host, 'control/query', { type: 'project-index' }, { cookie })
    expect(after.message.result).toMatchObject({
      ok: true,
      value: { ok: true, projection: { revision: 1, projects: [{ projectTitle: 'Transport project' }] } },
    })
    const projectId = (after.message.result as {
      value: { projection: { projects: [{ id: string }] } }
    }).value.projection.projects[0].id
    const workspace = await rpc(host, 'control/query', {
      type: 'development-workspace',
      projectId,
      expectedRegistryRevision: 1,
    }, { cookie })
    expect(workspace.message.result).toMatchObject({
      ok: true,
      value: { ok: true, projection: { type: 'development-workspace', registryRevision: 1 } },
    })

    const logout = await rpc(host, 'access/logout', {}, {
      cookie,
      'x-saki-request-token': access.requestToken,
    })
    expect(logout.message.result).toEqual({ ok: true, value: { ok: true } })
    expect(logout.response.headers.get('cache-control')).toBe('no-store')
    expect(logout.response.headers.get('set-cookie')).toContain('Max-Age=0')
    expect((await rpc(host, 'control/query', { type: 'project-index' }, { cookie })).message.result)
      .toEqual({ ok: true, value: { ok: false, reason: 'unavailable' } })
    await host.close()
  }, 20_000)

  it('denies inspection and registration after the current Grant narrows or is revoked', async () => {
    const host = await start()
    const repo = await repository(host)
    const secret = host.context.sakiControlPlane.bootstrap.take()!.consume()
    const exchange = await rpc(host, 'access/exchange', { secret })
    const cookie = cookiePair(exchange.response.headers.get('set-cookie')!)
    const access = (exchange.message.result as { value: { access: { requestToken: string } } }).value.access
    const index = await rpc(host, 'control/query', { type: 'project-index' }, { cookie })
    const hostId = (index.message.result as {
      value: { projection: { hosts: [{ id: string }] } }
    }).value.projection.hosts[0].id
    const inspected = await rpc(host, 'control/query', {
      type: 'inspect-project-selection', hostId, directoryLocator: repo,
    }, { cookie })
    const selection = (inspected.message.result as {
      value: { projection: { result: { selection: { fingerprint: unknown; baseline: unknown } } } }
    }).value.projection.result.selection
    const domain = controlDomain(host)
    const control = domain.table('control_state').get(CONTROL_STATE_KEY)!
    const intent = {
      type: 'register-development-project',
      intentId: 'intent-77777777-7777-4777-8777-777777777777',
      projectTitle: 'Denied transport project',
      hostId,
      directoryLocator: repo,
      expectedRegistryRevision: 0,
      confirmedFingerprint: selection.fingerprint,
      confirmedBaseline: selection.baseline,
    } as const

    await domain.table('grants').update(control.hostOperatorGrantId, current => ({
      ...current,
      revision: current.revision + 1,
      actions: ['project-index:read'],
    }))
    expect((await rpc(host, 'control/query', {
      type: 'inspect-project-selection', hostId, directoryLocator: repo,
    }, { cookie })).message.result).toEqual({ ok: true, value: { ok: false, reason: 'denied' } })
    expect((await rpc(host, 'control/submit', intent, {
      cookie,
      'x-saki-request-token': access.requestToken,
    })).message.result).toEqual({ ok: true, value: { ok: false, reason: 'denied' } })
    expect((await rpc(host, 'control/query', { type: 'project-index' }, { cookie })).message.result)
      .toMatchObject({ ok: true, value: { ok: true } })
    expect((await rpc(host, 'access/read', {}, { cookie })).message.result)
      .toMatchObject({ ok: true, value: { kind: 'authenticated' } })

    await domain.table('grants').update(control.hostOperatorGrantId, current => ({
      ...current,
      revision: current.revision + 1,
      state: 'revoked',
    }))
    expect((await rpc(host, 'control/query', {
      type: 'inspect-project-selection', hostId, directoryLocator: repo,
    }, { cookie })).message.result).toEqual({ ok: true, value: { ok: false, reason: 'denied' } })
    expect((await rpc(host, 'control/submit', intent, {
      cookie,
      'x-saki-request-token': access.requestToken,
    })).message.result).toEqual({ ok: true, value: { ok: false, reason: 'denied' } })
    expect((await rpc(host, 'access/read', {}, { cookie })).message.result)
      .toMatchObject({ ok: true, value: { kind: 'authenticated' } })
    await host.close()
  }, 20_000)

  it('rejects query strings before dispatch and marks denied and internal replies no-store', async () => {
    const host = await start()
    const readAccess = vi.spyOn(host.context.sakiControlPlane.access, 'readAccess')
    const searched = await fetch(`${host.origin}/saki/access/read?unexpected=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: host.origin },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'query-string',
        method: 'access/read',
        payload: {},
      }),
    })
    expect((await searched.json() as ServerResponse).result).toEqual(OPAQUE_ERROR_RESULT)
    expect(searched.headers.get('cache-control')).toBe('no-store')
    expect(readAccess).not.toHaveBeenCalled()

    const denied = await rpc(host, 'control/query', { type: 'project-index' })
    expect(denied.message.result).toEqual({ ok: true, value: { ok: false, reason: 'unavailable' } })
    expect(denied.response.headers.get('cache-control')).toBe('no-store')

    readAccess.mockRejectedValueOnce(new Error('selected internal failure'))
    const internal = await rpc(host, 'access/read', {})
    expect(internal.message.result).toEqual({
      ok: false,
      error: { code: 'internal', message: 'Saki request is unavailable', details: {} },
    })
    expect(internal.response.headers.get('cache-control')).toBe('no-store')
    await host.close()
  })

  it('rejects uncorrelated or authority-bearing control results before serialization', async () => {
    const host = await start()
    const authoritySentinel = 'C:/private/authority-sentinel'
    vi.spyOn(host.context.sakiControlPlane.access, 'readAccess').mockResolvedValueOnce({
      kind: 'session-required',
      message: authoritySentinel,
    } as never)
    const hostileAccess = await rpc(host, 'access/read', {})
    expect(hostileAccess.message.result).toEqual(OPAQUE_ERROR_RESULT)
    expect(JSON.stringify(hostileAccess.message)).not.toContain(authoritySentinel)

    const secret = host.context.sakiControlPlane.bootstrap.take()!.consume()
    const exchange = await rpc(host, 'access/exchange', { secret })
    const cookie = cookiePair(exchange.response.headers.get('set-cookie')!)
    const token = (exchange.message.result as { value: { access: { requestToken: string } } }).value.access.requestToken
    const query = vi.spyOn(host.context.sakiControlPlane, 'query')
    query.mockResolvedValueOnce({
      ok: true,
      projection: {
        type: 'inspect-project-selection',
        result: { ok: false, reason: 'missing' },
      },
    } as never)
    const uncorrelated = await rpc(host, 'control/query', { type: 'project-index' }, { cookie })
    expect(uncorrelated.message.result).toEqual(OPAQUE_ERROR_RESULT)

    query.mockResolvedValueOnce({
      ok: true,
      projection: {
        type: 'project-index',
        revision: 0,
        hosts: [],
        projects: [],
        canonicalWorktreePath: authoritySentinel,
      },
    } as never)
    const authority = await rpc(host, 'control/query', { type: 'project-index' }, { cookie })
    expect(authority.message.result).toEqual(OPAQUE_ERROR_RESULT)
    expect(JSON.stringify(authority.message)).not.toContain(authoritySentinel)

    vi.spyOn(host.context.sakiControlPlane, 'submit').mockResolvedValueOnce({
      ok: true,
      receipt: {
        id: 'receipt-11111111-1111-4111-8111-111111111111',
        intentId: 'intent-11111111-1111-4111-8111-111111111111',
        state: 'confirmed',
        projectId: 'project-22222222-2222-4222-8222-222222222222',
        resourceBindingId: 'binding-33333333-3333-4333-8333-333333333333',
        registryRevision: 1,
        actor: { canonicalWorktreePath: authoritySentinel },
      },
    } as never)
    const hostileSubmit = await rpc(host, 'control/submit', {
      type: 'register-development-project',
      intentId: 'intent-11111111-1111-4111-8111-111111111111',
      projectTitle: 'Transport project',
      hostId: host.context.sakiControlPlane.identity().hostId,
      directoryLocator: authoritySentinel,
      expectedRegistryRevision: 0,
      confirmedFingerprint: { version: 1, digest: '1'.repeat(64) },
      confirmedBaseline: {
        kind: 'unavailable',
        reason: 'io-failure',
        observed: { entries: 0, pathBytes: 0, gitOutputBytes: 0, hashedBytes: 0, elapsedMs: 0 },
      },
    }, { cookie, 'x-saki-request-token': token })
    expect(hostileSubmit.message.result).toEqual(OPAQUE_ERROR_RESULT)
    expect(JSON.stringify(hostileSubmit.message)).not.toContain(authoritySentinel)
    expect([
      hostileAccess.response.headers.get('cache-control'),
      uncorrelated.response.headers.get('cache-control'),
      authority.response.headers.get('cache-control'),
      hostileSubmit.response.headers.get('cache-control'),
    ]).toEqual(['no-store', 'no-store', 'no-store', 'no-store'])
    await host.close()
  })

  it('consumes cookie handoffs even when strict outbound parsing fails', async () => {
    const host = await start()
    const exchangeOperation = host.context.sakiControlPlane.access.exchangeBootstrap.bind(
      host.context.sakiControlPlane.access,
    )
    let capturedExchange: SakiAccessExchangeResult | undefined
    vi.spyOn(host.context.sakiControlPlane.access, 'exchangeBootstrap').mockImplementationOnce(async (...args) => {
      const result = await exchangeOperation(...args)
      capturedExchange = Object.assign(result, { authoritySentinel: 'exchange-secret' })
      return capturedExchange
    })
    const secret = host.context.sakiControlPlane.bootstrap.take()!.consume()
    const failedExchange = await rpc(host, 'access/exchange', { secret })
    expect(failedExchange.message.result).toEqual(OPAQUE_ERROR_RESULT)
    expect(failedExchange.response.headers.get('set-cookie')).toBeNull()
    expect(capturedExchange).toBeDefined()
    expect(takeSakiCookieHeader(capturedExchange!)).toBeUndefined()
    await host.close()

    const logoutHost = await start()
    const nextSecret = logoutHost.context.sakiControlPlane.bootstrap.take()!.consume()
    const exchange = await rpc(logoutHost, 'access/exchange', { secret: nextSecret })
    const cookie = cookiePair(exchange.response.headers.get('set-cookie')!)
    const token = (exchange.message.result as { value: { access: { requestToken: string } } }).value.access.requestToken
    const logoutOperation = logoutHost.context.sakiControlPlane.access.logoutCurrentSession.bind(
      logoutHost.context.sakiControlPlane.access,
    )
    let capturedLogout: SakiAccessLogoutResult | undefined
    vi.spyOn(logoutHost.context.sakiControlPlane.access, 'logoutCurrentSession').mockImplementationOnce(async (...args) => {
      const result = await logoutOperation(...args)
      capturedLogout = Object.assign(result, { authoritySentinel: 'logout-secret' })
      return capturedLogout
    })
    const failedLogout = await rpc(logoutHost, 'access/logout', {}, {
      cookie,
      'x-saki-request-token': token,
    })
    expect(failedLogout.message.result).toEqual(OPAQUE_ERROR_RESULT)
    expect(failedLogout.response.headers.get('set-cookie')).toBeNull()
    expect(capturedLogout).toBeDefined()
    expect(takeSakiCookieHeader(capturedLogout!)).toBeUndefined()
    await logoutHost.close()
  })

  it('makes pre-handler, handler, and normal Saki errors opaque and non-cacheable', async () => {
    const host = await start()
    for (const [request, status] of [
      [new Request(`${host.origin}/saki/access/read`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          host: 'other.example',
          origin: 'http://other.example',
        },
        body: '{}',
      }), 403],
      [new Request(`${host.origin}/saki/access/read`, { method: 'GET' }), 404],
      [new Request(`${host.origin}/saki/access/read`, { method: 'POST', body: '{}' }), 415],
      [new Request(`${host.origin}/saki/access/read`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
      }), 400],
    ] as const) {
      const response = await fetch(request)
      expect([response.status, response.headers.get('cache-control'), await response.text()])
        .toEqual([status, 'no-store', 'Saki request is unavailable'])
    }

    for (const body of [
      { rpcId: 'invalid-envelope', parserSentinel: true },
      {
        type: 'client-request',
        rpcId: 'method-mismatch',
        method: 'method-sentinel',
        payload: {},
      },
    ]) {
      const response = await fetch(`${host.origin}/saki/access/read`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: host.origin },
        body: JSON.stringify(body),
      })
      const text = await response.text()
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect((JSON.parse(text) as ServerResponse).result).toEqual(OPAQUE_ERROR_RESULT)
      expect(text).not.toMatch(/parserSentinel|method-sentinel|issues/)
    }

    const invalidPayload = await rpc(host, 'access/read', { payloadSentinel: true })
    expect(invalidPayload.response.headers.get('cache-control')).toBe('no-store')
    expect(invalidPayload.message.result).toEqual(OPAQUE_ERROR_RESULT)
    expect(JSON.stringify(invalidPayload.message)).not.toContain('payloadSentinel')
    await host.close()
  })

  it('rejects missing origin, request-token mismatch, and caller-supplied authority without leaks', async () => {
    const host = await start()
    const secret = host.context.sakiControlPlane.bootstrap.take()!.consume()
    const wrongOrigin = await fetch(`${host.origin}/saki/access/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:1' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'wrong-origin',
        method: 'access/exchange',
        payload: { secret },
      }),
    })
    expect([wrongOrigin.status, wrongOrigin.headers.get('cache-control'), await wrongOrigin.text()])
      .toEqual([403, 'no-store', 'Saki request is unavailable'])
    const missingOrigin = await fetch(`${host.origin}/saki/access/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'missing-origin',
        method: 'access/exchange',
        payload: { secret },
      }),
    })
    expect((await missingOrigin.json() as ServerResponse).result)
      .toEqual({ ok: true, value: { ok: false, reason: 'unavailable' } })
    const exchange = await rpc(host, 'access/exchange', { secret })
    const cookie = cookiePair(exchange.response.headers.get('set-cookie')!)
    const token = (exchange.message.result as { value: { access: { requestToken: string } } }).value.access.requestToken

    expect((await rpc(host, 'access/logout', {}, { cookie, 'x-saki-request-token': `${token}x` })).message.result)
      .toEqual({ ok: true, value: { ok: false, reason: 'unavailable' } })
    expect((await rpc(host, 'control/query', { type: 'project-index' }, {
      cookie: `${cookie}; ${cookie}`,
    })).message.result).toEqual({ ok: true, value: { ok: false, reason: 'unavailable' } })
    const spoofed = await rpc(host, 'control/query', {
      type: 'project-index',
      principalId: 'caller-principal',
      grant: { actions: ['project-index:read'] },
      actor: { kind: 'human' },
    }, { cookie })
    expect(spoofed.message.result).toEqual(OPAQUE_ERROR_RESULT)
    expect(JSON.stringify(spoofed.message)).not.toContain(secret)

    const submit = vi.spyOn(host.context.sakiControlPlane, 'submit')
    const intent = {
      type: 'register-development-project',
      intentId: 'intent-99999999-9999-4999-8999-999999999999',
      projectTitle: 'Caller authority rejection',
      hostId: host.context.sakiControlPlane.identity().hostId,
      directoryLocator: 'D:/selected-repository',
      expectedRegistryRevision: 0,
      confirmedFingerprint: { version: 1, digest: '9'.repeat(64) },
      confirmedBaseline: {
        kind: 'unavailable',
        reason: 'io-failure',
        observed: { entries: 0, pathBytes: 0, gitOutputBytes: 0, hashedBytes: 0, elapsedMs: 0 },
      },
    } as const
    for (const reserved of [
      { principalId: 'principal-authority-sentinel' },
      { grant: { revision: 7, authoritySentinel: true } },
      { actor: { kind: 'human', authoritySentinel: true } },
      { authenticationContext: { authoritySentinel: true } },
      { canonicalWorktreePath: 'D:/authority-sentinel' },
      { workspaceId: 'workspace-authority-sentinel' },
      { resourceBindingId: 'binding-authority-sentinel' },
    ]) {
      const rejected = await rpc(host, 'control/submit', { ...intent, ...reserved }, {
        cookie,
        'x-saki-request-token': token,
      })
      expect(rejected.message.result).toEqual(OPAQUE_ERROR_RESULT)
      expect(JSON.stringify(rejected.message)).not.toContain('authority-sentinel')
    }
    expect(submit).not.toHaveBeenCalled()
    await host.close()
  })

  it('closes every endpoint schema and treats absent transport credentials as unavailable', async () => {
    const host = await start()
    for (const [endpoint, payload] of [
      ['unknown/operation', {}],
      ['access/read', { extra: true }],
      ['access/exchange', {}],
      ['access/logout', { extra: true }],
      ['control/query', {}],
      ['control/submit', { extra: true }],
    ] as const) {
      expect((await rpc(host, endpoint, payload)).message.result).toEqual(OPAQUE_ERROR_RESULT)
    }
    expect((await rpc(host, 'access/logout', {})).message.result)
      .toEqual({ ok: true, value: { ok: false, reason: 'unavailable' } })
    expect((await rpc(host, 'control/submit', {})).message.result)
      .toEqual(OPAQUE_ERROR_RESULT)
    expect((await rpc(host, 'control/query', { type: 'project-index' }, { cookie: 'saki_session=' })).message.result)
      .toEqual({ ok: true, value: { ok: false, reason: 'unavailable' } })

    const missingOrigin = await fetch(`${host.origin}/saki/control/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'missing-query-origin',
        method: 'control/query',
        payload: { type: 'project-index' },
      }),
    })
    expect((await missingOrigin.json() as ServerResponse).result)
      .toEqual({ ok: true, value: { ok: false, reason: 'unavailable' } })
    for (const endpoint of ['access/logout'] as const) {
      const response = await fetch(`${host.origin}/saki/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: `missing-origin-${endpoint}`,
          method: endpoint,
          payload: {},
        }),
      })
      expect((await response.json() as ServerResponse).result)
        .toEqual({ ok: true, value: { ok: false, reason: 'unavailable' } })
    }

    const secret = host.context.sakiControlPlane.bootstrap.take()!.consume()
    const exchange = await rpc(host, 'access/exchange', { secret })
    const cookie = cookiePair(exchange.response.headers.get('set-cookie')!)
    const token = (exchange.message.result as { value: { access: { requestToken: string } } }).value.access.requestToken
    vi.spyOn(host.context.sakiControlPlane.access, 'logoutCurrentSession')
      .mockResolvedValueOnce({ ok: false, reason: 'unavailable' })
    const failedLogout = await rpc(host, 'access/logout', {}, {
      cookie,
      'x-saki-request-token': token,
    })
    expect(failedLogout.message.result).toEqual({ ok: true, value: { ok: false, reason: 'unavailable' } })
    expect(failedLogout.response.headers.get('set-cookie')).toBeNull()
    await host.close()
  })
})
