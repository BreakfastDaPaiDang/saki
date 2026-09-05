import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserAuth } from '../src/browser-auth.ts'
import type { ConnectionRpcHandler } from '../src/rpc.ts'
import { HostConnectionService } from '../src/rpc-host.ts'

async function mounted(): Promise<{
  readonly connection: HostConnectionService
  readonly dispose: () => Promise<void>
}> {
  const ctx = new Context()
  const fiber = ctx.plugin((pluginCtx) => {
    new HostConnectionService(pluginCtx, [], {} as BrowserAuth)
  })
  await fiber.await()
  return {
    connection: ctx.get('connection') as HostConnectionService,
    dispose: () => fiber.dispose(),
  }
}

describe('Connection exact Fetch routes', () => {
  it('dispatches owned methods and returns 404 for unclaimed requests', async () => {
    const { connection, dispose: disposeFiber } = await mounted()
    const route = vi.fn(async (request: Request) =>
      Response.json({ query: new URL(request.url).searchParams.get('sessionId') }))
    const dispose = connection.fetch.register({
      path: '/api/session.export',
      methods: ['GET', 'HEAD', 'POST'],
      requestBody: 'streaming',
      fetch: route,
    })
    const shared = connection.createSharedFetchHandler('/api')

    const response = await shared.fetch(new Request(
      'http://host/api/session.export?sessionId=session-1',
    ))
    expect(shared.requestBodyMode({
      method: 'POST', url: new URL('http://host/api/session.export'),
    })).toBe('streaming')
    expect(shared.requestBodyMode({
      method: 'DELETE', url: new URL('http://host/api/session.export'),
    })).toBe('buffered')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ query: 'session-1' })
    expect(route).toHaveBeenCalledOnce()
    const post = await shared.fetch(new Request('http://host/api/session.export', { method: 'POST' }))
    expect(post.status).toBe(200)
    expect(route).toHaveBeenCalledTimes(2)

    await dispose()
    const withdrawn = await shared.fetch(new Request('http://host/api/session.export'))
    expect(withdrawn.status).toBe(404)
    await disposeFiber()
  })

  it('rejects invalid and duplicate registrations', async () => {
    const { connection, dispose: disposeFiber } = await mounted()
    const fetch = async (): Promise<Response> => new Response()

    expect(() => connection.fetch.register({ path: '/outside', methods: ['GET'], requestBody: 'buffered', fetch }))
      .toThrow('invalid exact Fetch route')
    expect(() => connection.fetch.register({ path: '/api/session.export', methods: [], requestBody: 'buffered', fetch }))
      .toThrow('declares no methods')
    expect(() => connection.fetch.register({
      path: '/api/session.export', methods: ['GET', 'GET'], fetch,
      requestBody: 'buffered',
    })).toThrow('repeats a method')
    const dispose = connection.fetch.register({
      path: '/api/session.export', methods: ['GET'], fetch,
      requestBody: 'buffered',
    })
    expect(() => connection.fetch.register({
      path: '/api/session.export', methods: ['HEAD'], fetch,
      requestBody: 'buffered',
    })).toThrow('already registered')
    await dispose()
    expect(() => connection.fetch.register({
      path: '/api/session.export', methods: ['HEAD'], fetch,
      requestBody: 'buffered',
    })).not.toThrow()
    await disposeFiber()
  })

  it('selects exact-route authority before a shared interceptor and fences loopback requests', async () => {
    const { connection, dispose: disposeFiber } = await mounted()
    const intercepted = vi.fn<ConnectionRpcHandler>(async () => ({ result: { ok: true, value: 'intercepted' } }))
    connection.rpc.intercept('/api', endpoint => endpoint === 'goals/create', intercepted, {
      authority: 'loopback',
      requiredResponseHeaders: { 'cache-control': 'no-store' },
    })
    connection.fetch.register({
      path: '/api/goals/create',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => new Response('exact route'),
    })
    const shared = connection.createSharedFetchHandler('/api')

    expect(connection.sharedRequestOptions('GET', '/api/goals/create'))
      .toEqual({ authority: 'trusted-host' })
    expect(connection.sharedRequestOptions('POST', '/api/goals/create'))
      .toMatchObject({ authority: 'loopback' })
    expect(await (await shared.fetch(new Request('http://remote.example/api/goals/create'))).text())
      .toBe('exact route')
    const denied = await shared.fetch(new Request('http://remote.example/api/goals/create', {
      method: 'POST', headers: { host: 'remote.example' },
    }))
    expect(denied.status).toBe(403)
    expect(denied.headers.get('cache-control')).toBe('no-store')
    expect(intercepted).not.toHaveBeenCalled()

    const accepted = await shared.fetch(new Request('http://localhost/api/goals/create', {
      method: 'POST',
      headers: { host: 'localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'goals-1', method: 'goals/create', payload: {} }),
    }))
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toMatchObject({ result: { ok: true, value: 'intercepted' } })
    expect(intercepted).toHaveBeenCalledOnce()
    for (const path of ['/api/unclaimed', '/outside']) {
      expect((await shared.fetch(new Request(`http://localhost${path}`))).status).toBe(404)
    }
    await disposeFiber()
  })
})
