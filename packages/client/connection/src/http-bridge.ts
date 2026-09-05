/**
 * node:http ↔ WHATWG fetch bridge for the /api transport (host side of the
 * web carrier; the fetch-shaped handler itself is transport-agnostic).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { ConnectionFetchHandler } from './rpc.ts'

/** Default carrier cap for all HTTP RPC bodies: sized for the default
 * aggregate image limit (200 MiB) after base64 expansion plus envelope
 * headroom (~267.7 MiB required), rounded up for slack. The bridge buffers
 * each body in memory, so this cap is also the per-request resident bound. */
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 300 * 1024 * 1024

/** Response fields applied when the bridge rejects a request before dispatch. */
export interface BridgeRejectionPolicy {
  /** Headers copied to a bridge-owned rejection response. */
  readonly headers?: Readonly<Record<string, string>>
  /** Optional fixed body for a bridge-owned rejection response. */
  readonly body?: string
}

/**
 * Bridge one node:http request to the fetch-shaped handler (client close
 * aborts; response bodies stream out chunk by chunk).
 * @param req - incoming node:http request.
 * @param res - node:http response the bridge writes and owns to completion.
 * @param apiHandler - fetch-shaped API carrier the request is dispatched to.
 * @param maxRequestBodyBytes - maximum bytes buffered for a buffered route.
 * @param rejection - headers and fixed body for bridge-owned rejection responses.
 */
export async function bridge(
  req: IncomingMessage,
  res: ServerResponse,
  apiHandler: ConnectionFetchHandler,
  maxRequestBodyBytes = DEFAULT_MAX_REQUEST_BODY_BYTES,
  rejection: BridgeRejectionPolicy = {},
): Promise<void> {
  const abort = new AbortController()
  // Client-disconnect detection MUST hang off the response, not the request:
  // since Node 16, IncomingMessage 'close' fires as soon as the request body is
  // fully consumed (immediately for a bodyless GET), which would abort a
  // streaming response right after open. ServerResponse 'close' fires on connection teardown;
  // writableEnded distinguishes a normal end() from the client going away.
  res.on('close', () => {
    if (!res.writableEnded) abort.abort()
  })
  /* v8 ignore next 2 -- node:http always sets url/method on server requests. */
  let url: URL
  try {
    url = new URL(req.url ?? '/', requestOrigin(req))
  } catch {
    // Invalid HTTP targets cannot reach the Fetch-shaped handler.
    rejectBeforeDispatch(req, res, 400, rejection)
    return
  }
  const method = req.method ?? 'GET'
  const headers = Object.fromEntries(
    Object.entries(req.headers).filter(([, value]) => typeof value === 'string') as [string, string][],
  )
  const bodyForbidden = /^(?:GET|HEAD)$/i.test(method)
  const bodyMode = bodyForbidden ? 'buffered' : apiHandler.requestBodyMode({ method, url })
  let init: RequestInit
  if (bodyMode === 'buffered') {
    const declaredLength = req.headers['content-length']
    if (declaredLength !== undefined && Number(declaredLength) > maxRequestBodyBytes) {
      rejectBeforeDispatch(req, res, 413, rejection)
      return
    }
    if (bodyForbidden && declaredLength !== undefined && Number(declaredLength) > 0) {
      rejectBeforeDispatch(req, res, 400, rejection)
      return
    }
    const chunks: Buffer[] = []
    let received = 0
    for await (const chunk of req) {
      const buffer = chunk as Buffer
      received += buffer.byteLength
      if (received > maxRequestBodyBytes) {
        rejectBeforeDispatch(req, res, 413, rejection)
        return
      }
      if (bodyForbidden && buffer.byteLength > 0) {
        rejectBeforeDispatch(req, res, 400, rejection)
        return
      }
      chunks.push(buffer)
    }
    init = {
      method,
      headers,
      ...chunks.length > 0 ? { body: Buffer.concat(chunks) } : {},
      signal: abort.signal,
    }
  } else {
    init = {
      method,
      headers,
      body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
      signal: abort.signal,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' }
  }
  let request: Request
  try {
    request = new Request(url, init)
  } catch {
    // WHATWG rejects some methods accepted by node:http; channel errors stay opaque.
    rejectBeforeDispatch(req, res, 400, rejection)
    return
  }
  const response = await apiHandler.fetch(request)
  const requestUnread = bodyMode === 'streaming' && !req.readableEnded
  const responseHeaders = Object.fromEntries(response.headers.entries())
  res.writeHead(response.status, requestUnread ? { ...responseHeaders, connection: 'close' } : responseHeaders)
  if (response.body === null) {
    res.end()
    if (requestUnread) req.destroy()
    return
  }
  for await (const chunk of response.body) {
    // Backpressure: a false return means the socket buffer is full — wait for drain
    // instead of buffering unboundedly (slow or suspended consumers). 'close' also
    // resolves so a mid-wait disconnect can't park this loop forever; the close
    // handler above aborts the handler stream, which then ends the iteration.
    if (!res.write(chunk)) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          res.off('drain', done)
          res.off('close', done)
          resolve()
        }
        res.once('drain', done)
        res.once('close', done)
      })
    }
  }
  res.end()
  if (requestUnread) req.destroy()
}

function rejectBeforeDispatch(
  req: IncomingMessage,
  res: ServerResponse,
  status: 400 | 413,
  policy: BridgeRejectionPolicy,
): void {
  res.writeHead(status, rejectionHeaders(policy))
  res.end(policy.body)
  req.destroy()
}

function rejectionHeaders(policy: BridgeRejectionPolicy): Record<string, string> {
  const headers = new Headers(policy.headers)
  headers.set('connection', 'close')
  return Object.fromEntries(headers.entries())
}

function requestOrigin(req: IncomingMessage): string {
  const encrypted = (req.socket as { readonly encrypted?: boolean } | undefined)?.encrypted === true
  const authority = typeof req.headers.host === 'string' ? req.headers.host : 'dsh.internal'
  return `${encrypted ? 'https' : 'http'}://${authority}`
}
