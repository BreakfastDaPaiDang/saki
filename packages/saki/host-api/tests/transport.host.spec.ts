import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import { RpcId, type ClientRequest, type ServerResponse } from '@deepseek-ai/dsh-host-apiproxy/api'
import SakiControlPlane from '@breakfastdapaidang/saki-control-plane'
import * as SakiHostApi from '../src/index.ts'

const tempDirectories: string[] = []
const OPAQUE_ERROR_RESULT = {
  ok: false,
  error: { code: 'internal', message: 'Saki request is unavailable', details: {} },
} as const

interface RunningHost {
  readonly context: Context
  readonly origin: string
  readonly close: () => Promise<void>
}

async function start(): Promise<RunningHost> {
  const directory = await mkdtemp(join(tmpdir(), 'saki-host-api-'))
  tempDirectories.push(directory)
  const context = new Context()
  await context.plugin(Storage)
  await context.plugin(StorageSqlite, { path: join(directory, 'saki.sqlite'), journalMode: 'delete' })
  await context.plugin(StorageDomain, { backend: 'sqlite' })
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
  return { context, origin, close: () => context.fiber.dispose() }
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

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Saki /saki Host transport', () => {
  it('bootstraps, queries the empty Project index, and logs out over the real Connection route', async () => {
    const host = await start()
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
    expect(query.message.result).toEqual({
      ok: true,
      value: { ok: true, projection: { type: 'project-index', revision: 0, projects: [] } },
    })
    expect(query.response.headers.get('cache-control')).toBe('no-store')

    const unavailableIntent = await rpc(host, 'control/submit', {}, {
      cookie,
      'x-saki-request-token': access.requestToken,
    })
    expect(unavailableIntent.message.result).toEqual({
      ok: true,
      value: { ok: false, reason: 'intent-unavailable' },
    })
    expect(unavailableIntent.response.headers.get('cache-control')).toBe('no-store')

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
  })

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
      .toEqual({ ok: true, value: { ok: false, reason: 'unavailable' } })
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
    for (const endpoint of ['access/logout', 'control/submit'] as const) {
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
