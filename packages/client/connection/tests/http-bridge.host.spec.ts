import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { bridge } from '../src/http-bridge.ts'

describe('HTTP bridge abort', () => {
  it('destroys a declared-oversize request instead of draining it', async () => {
    const destroyed: true[] = []
    const request = Readable.from([]) as unknown as IncomingMessage
    Object.assign(request, {
      url: '/api/session.prompt',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '999999' },
      destroy: () => { destroyed.push(true) },
    })
    let status: number | undefined
    let headers: unknown
    const response = Object.assign(new EventEmitter(), {
      writableEnded: false,
      writeHead(code: number, values?: unknown) { status = code; headers = values; return this },
      write() { return true },
      end(this: { writableEnded: boolean }) { this.writableEnded = true; return this },
    }) as unknown as ServerResponse

    await bridge(request, response, {
      fetch: () => { throw new Error('a rejected request must never reach the handler') },
    }, 1000)
    // The socket must not stay parked draining a body the client can trickle
    // at will after the rejection — same discipline as the chunked overrun.
    expect(status).toBe(413)
    expect(headers).toMatchObject({ connection: 'close' })
    expect(destroyed).toHaveLength(1)
  })

  it('applies declared rejection fields to an oversize request', async () => {
    const request = Readable.from([]) as unknown as IncomingMessage
    Object.assign(request, {
      url: '/saki/access/read',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '1001' },
      destroy: () => {},
    })
    let status: number | undefined
    let headers: unknown
    let body: unknown
    const response = Object.assign(new EventEmitter(), {
      writableEnded: false,
      writeHead(code: number, values?: unknown) { status = code; headers = values; return this },
      write() { return true },
      end(this: { writableEnded: boolean }, value?: unknown) {
        this.writableEnded = true
        body = value
        return this
      },
    }) as unknown as ServerResponse

    await bridge(request, response, {
      fetch: () => { throw new Error('a rejected request must never reach the handler') },
    }, 1000, {
      headers: { 'cache-control': 'no-store', connection: 'keep-alive' },
      body: 'operation unavailable',
    })
    expect(status).toBe(413)
    expect(headers).toEqual({ 'cache-control': 'no-store', connection: 'close' })
    expect(body).toBe('operation unavailable')
  })

  it.each(['GET', 'HEAD'] as const)('rejects a %s body through the channel policy', async (method) => {
    const sentinel = 'credential-sentinel'
    const request = Readable.from([Buffer.from(sentinel)]) as unknown as IncomingMessage
    Object.assign(request, {
      url: '/saki/access/read',
      method,
      headers: method === 'GET' ? { 'content-length': String(Buffer.byteLength(sentinel)) } : {},
    })
    let status: number | undefined
    let headers: unknown
    let body: unknown
    const response = Object.assign(new EventEmitter(), {
      writableEnded: false,
      writeHead(code: number, values?: unknown) { status = code; headers = values; return this },
      write() { return true },
      end(this: { writableEnded: boolean }, value?: unknown) {
        this.writableEnded = true
        body = value
        return this
      },
    }) as unknown as ServerResponse

    await bridge(request, response, {
      fetch: () => { throw new Error(`${sentinel}: rejected requests must not reach the handler`) },
    }, Number.MAX_SAFE_INTEGER, {
      headers: { 'cache-control': 'no-store' },
      body: 'Saki request is unavailable',
    })

    expect(status).toBe(400)
    expect(headers).toEqual({ 'cache-control': 'no-store', connection: 'close' })
    expect(body).toBe('Saki request is unavailable')
  })

  it('preserves the generic empty rejection for a GET body', async () => {
    const request = Readable.from([Buffer.from('body')]) as unknown as IncomingMessage
    Object.assign(request, {
      url: '/api/session.prompt',
      method: 'GET',
      headers: { 'content-length': '4' },
    })
    let status: number | undefined
    let headers: unknown
    let body: unknown
    const response = Object.assign(new EventEmitter(), {
      writableEnded: false,
      writeHead(code: number, values?: unknown) { status = code; headers = values; return this },
      write() { return true },
      end(this: { writableEnded: boolean }, value?: unknown) {
        this.writableEnded = true
        body = value
        return this
      },
    }) as unknown as ServerResponse

    await bridge(request, response, {
      fetch: () => { throw new Error('a rejected request must never reach the handler') },
    })

    expect(status).toBe(400)
    expect(headers).toEqual({ connection: 'close' })
    expect(body).toBeUndefined()
  })

  it('applies the channel policy to a pre-dispatch request conversion failure', async () => {
    const request = Readable.from([]) as unknown as IncomingMessage
    Object.assign(request, {
      url: '/saki/access/read',
      method: 'TRACE',
      headers: { host: '127.0.0.1' },
    })
    let status: number | undefined
    let headers: unknown
    let body: unknown
    const response = Object.assign(new EventEmitter(), {
      writableEnded: false,
      writeHead(code: number, values?: unknown) { status = code; headers = values; return this },
      write() { return true },
      end(this: { writableEnded: boolean }, value?: unknown) {
        this.writableEnded = true
        body = value
        return this
      },
    }) as unknown as ServerResponse

    await bridge(request, response, {
      fetch: () => { throw new Error('a rejected request must never reach the handler') },
    }, Number.MAX_SAFE_INTEGER, {
      headers: { 'cache-control': 'no-store' },
      body: 'Saki request is unavailable',
    })

    expect(status).toBe(400)
    expect(headers).toEqual({ 'cache-control': 'no-store', connection: 'close' })
    expect(body).toBe('Saki request is unavailable')
  })

  it('aborts a pending native picker request when the browser disconnects', async () => {
    const body = JSON.stringify({
      type: 'client-request', rpcId: 'picker-1', method: 'host.pickDirectory', payload: {},
    })
    const request = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage
    Object.assign(request, {
      url: '/api/host.pickDirectory',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })

    const response = Object.assign(new EventEmitter(), {
      writableEnded: false,
      writeHead() { return this },
      write() { return true },
      end() { this.writableEnded = true; return this },
    }) as unknown as ServerResponse

    let resolveStarted!: () => void
    const started = new Promise<void>((resolve) => { resolveStarted = resolve })
    let carrierSignal: AbortSignal | undefined
    const pending = bridge(request, response, {
      fetch: async (input) => {
        const fetchRequest = input
        carrierSignal = fetchRequest.signal
        resolveStarted()
        if (!fetchRequest.signal.aborted) {
          await new Promise<void>((resolve) => {
            fetchRequest.signal.addEventListener('abort', () => { resolve() }, { once: true })
          })
        }
        return Response.json({ aborted: fetchRequest.signal.aborted })
      },
    }, Number.MAX_SAFE_INTEGER)
    await started
    response.emit('close')
    await pending
    expect(carrierSignal?.aborted).toBe(true)
  })
})
