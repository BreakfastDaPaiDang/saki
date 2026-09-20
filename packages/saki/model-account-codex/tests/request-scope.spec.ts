import { createServer } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { CodexTurnState } from '../src/turn-state.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

async function endpoint() {
  const received: Array<Record<string, string | string[] | undefined>> = []
  const server = createServer((request, response) => {
    received.push(request.headers)
    response.writeHead(200, { 'x-codex-turn-state': 'response-state' })
    response.end('fixture')
  })
  cleanups.push(async () => {
    const closed = new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
    server.closeAllConnections()
    await closed
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing test listener address')
  return { url: `http://127.0.0.1:${address.port}`, received }
}

function request(turn: number, signal?: AbortSignal): GenerateOptions {
  return { provider: 'fixture', model: 'fixture', messages: [], sessionId: SessionId('session-fixture'), turn,
    ...(signal === undefined ? {} : { signal }) }
}

function capture(scope: CodexTurnState, turn: number, value: string, signal?: AbortSignal): void {
  const hooks = scope.prepare(request(turn, signal))
  hooks.onResponse({ status: 200, headers: { 'x-codex-turn-state': value } })
}

async function send(scope: CodexTurnState, options: GenerateOptions, url: string) {
  const hooks = scope.prepare(options)
  const result = await hooks.fetch(url, { headers: {
    'session-id': 'wrong-session', 'thread-id': 'wrong-thread', 'x-client-request-id': 'wrong-request',
    'x-codex-turn-state': 'wrong-state', originator: 'wrong-origin',
  } })
  await result.text()
}

describe('account-local Codex turn state', () => {
  it('replays captured state only inside its durable turn and replaces reserved HTTP headers', async () => {
    const server = await endpoint()
    const scope = new CodexTurnState()
    cleanups.push(() => { scope.dispose() })
    capture(scope, 1, 'first-state')
    capture(scope, 1, 'second-state')
    await send(scope, request(1), server.url)
    scope.end('session-fixture', 1)
    await send(scope, request(2), server.url)
    expect(server.received.map(headers => headers['x-codex-turn-state'])).toEqual(['first-state', undefined])
    for (const headers of server.received) {
      expect(headers['session-id']).toBe('session-fixture')
      expect(headers['thread-id']).toBe('session-fixture')
      expect(headers['x-client-request-id']).toBe('session-fixture')
      expect(headers['originator']).toBe('saki')
      expect(headers['user-agent']).toBe(new Headers(attributionHeaders()).get('user-agent'))
    }
  })

  it('rejects stale requests before HTTP and ignores late response state', async () => {
    const server = await endpoint()
    const scope = new CodexTurnState()
    const old = scope.prepare(request(1))
    scope.end('session-fixture', 1)
    capture(scope, 2, 'new-state')
    old.onResponse({ status: 200, headers: { 'x-codex-turn-state': 'late-state' } })
    await expect(old.fetch(server.url)).rejects.toThrow('no longer active')
    await send(scope, request(2), server.url)
    expect(server.received).toHaveLength(1)
    expect(server.received[0]?.['x-codex-turn-state']).toBe('new-state')
    expect(() => scope.prepare(request(1))).toThrow('ended turn')
    scope.dispose()
    expect(() => scope.prepare(request(3))).toThrow('unavailable')
  })

  it('keeps two account routes isolated even for the same Session and turn', async () => {
    const server = await endpoint()
    const a = new CodexTurnState()
    const b = new CodexTurnState()
    capture(a, 1, 'account-a')
    capture(b, 1, 'account-b')
    await Promise.all([send(a, request(1), server.url), send(b, request(1), server.url)])
    expect(server.received.map(headers => headers['x-codex-turn-state']).sort()).toEqual(['account-a', 'account-b'])
  })

  it('removes turn identity for auxiliary calls and aborts captured requests before HTTP', async () => {
    const server = await endpoint()
    const scope = new CodexTurnState()
    await send(scope, { provider: 'fixture', model: 'fixture', messages: [], purpose: 'compaction' }, server.url)
    expect(server.received[0]?.['session-id']).toBeUndefined()
    expect(server.received[0]?.['x-codex-turn-state']).toBeUndefined()
    const controller = new AbortController()
    const hooks = scope.prepare(request(1, controller.signal))
    controller.abort()
    await expect(hooks.fetch(server.url)).rejects.toThrow('no longer active')
    expect(server.received).toHaveLength(1)
  })
})
