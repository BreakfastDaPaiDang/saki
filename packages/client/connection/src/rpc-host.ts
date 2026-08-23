/** Host registry and HTTP adapter for generic Connection RPC channels. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  clientRequestSchema,
  RpcId,
  type ClientRequest,
  type RpcError,
  type RpcErrorDetailsMap,
  type RpcId as RpcIdType,
  type ServerResponse as RpcServerResponse,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { bridge, type FetchHandler } from './http-bridge.ts'
import { isTrustedApiRequest } from './api-request-trust.ts'
import { API_PATH } from './api-path.ts'
import type {
  ConnectionRpcEndpointMatcher,
  ConnectionRpcHandler,
  ConnectionRpcHandlerOptions,
  ConnectionRpcRequestMetadata,
  HostConnectionHandle,
  HostConnectionRpc,
} from './rpc.ts'

const INVALID_REQUEST_RPC_ID = RpcId('invalid-request')
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

interface ConnectionRpcInterceptor {
  readonly matches: ConnectionRpcEndpointMatcher
  readonly fetchHandler: FetchHandler
  readonly options: ConnectionRpcHandlerOptions
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Connection transport and RPC registrations. */
    connection: HostConnectionHandle
  }
}

/** Host Connection service whose channel registrations belong to the caller fiber. */
export class HostConnectionService extends Service implements HostConnectionHandle {
  private readonly interceptors = new Map<string, ConnectionRpcInterceptor>()

  /**
   * Provide the Host half over the active HTTP server.
   * @param ctx - owning Connection plugin context.
   * @param trustedHosts - deployment authorities accepted by trusted-host channels.
   */
  constructor(ctx: Context, private readonly trustedHosts: readonly string[]) {
    super(ctx, 'connection')
  }

  /** Generic channel registry scoped to the Context reading this service. */
  get rpc(): HostConnectionRpc {
    const owner = this.ctx
    return {
      handle: (channel, handler, options) => this.register(owner, channel, handler, options),
      intercept: (channel, matches, handler, options) =>
        this.registerInterceptor(owner, channel, matches, handler, options),
    }
  }

  /**
   * Compose one shared-channel Fetch handler from its interceptor and fallback.
   * @param channel - shared channel mounted by Connection.
   * @param fallback - handler for endpoints not claimed by the interceptor.
   * @returns Fetch handler that selects exactly one target for each request.
   */
  createSharedFetchHandler(
    channel: '/api',
    fallback: FetchHandler,
  ): FetchHandler {
    return {
      fetch: (request) => {
        const endpoint = endpointFromPath(channel, new URL(request.url).pathname)
        const interceptor = this.interceptors.get(channel)
        if (endpoint === undefined || interceptor === undefined || !interceptor.matches(endpoint)) {
          return fallback.fetch(request)
        }
        if (interceptor.options.authority === 'loopback' && !isTrustedApiRequest(request, [])) {
          return Promise.resolve(failureResponse(403, 'forbidden', interceptor.options))
        }
        return interceptor.fetchHandler.fetch(request)
      },
    }
  }

  private register(
    owner: Context,
    channel: string,
    handler: ConnectionRpcHandler,
    options: ConnectionRpcHandlerOptions,
  ): () => Promise<void> {
    assertChannel(channel)
    const trustedHosts = options.authority === 'loopback' ? [] : this.trustedHosts
    const fetchHandler = rpcFetchHandler(channel, handler, options)
    const route: WebRoute = {
      kind: 'prefix',
      path: channel,
      handler: async (req, res) => {
        if (!isTrustedApiRequest(req, trustedHosts)) {
          const headers = responseHeaders(options.requiredResponseHeaders)
          res.writeHead(403, Object.fromEntries(headers.entries()))
          res.end(failureMessage('forbidden', options))
          return
        }
        await bridge(req, res, fetchHandler, undefined, {
          ...(options.requiredResponseHeaders === undefined
            ? {}
            : { headers: options.requiredResponseHeaders }),
          ...(options.opaqueError === undefined ? {} : { body: options.opaqueError.message }),
        })
      },
    }
    return owner.effect(
      () => owner.webServer.register(route),
      `client-connection: ${channel} rpc channel`,
    )
  }

  private registerInterceptor(
    owner: Context,
    channel: string,
    matches: ConnectionRpcEndpointMatcher,
    handler: ConnectionRpcHandler,
    options: ConnectionRpcHandlerOptions,
  ): () => Promise<void> {
    if (channel !== API_PATH) {
      throw new Error(`connection: invalid shared RPC channel ${JSON.stringify(channel)}`)
    }
    const interceptor: ConnectionRpcInterceptor = {
      matches,
      fetchHandler: rpcFetchHandler(channel, handler, options),
      options,
    }
    return owner.effect(() => {
      if (this.interceptors.has(channel)) {
        throw new Error(`connection: shared RPC channel ${JSON.stringify(channel)} already has an interceptor`)
      }
      this.interceptors.set(channel, interceptor)
      return () => {
        this.interceptors.delete(channel)
      }
    }, `client-connection: ${channel} rpc interceptor`)
  }
}

function rpcFetchHandler(
  channel: string,
  handler: ConnectionRpcHandler,
  options: ConnectionRpcHandlerOptions,
): FetchHandler {
  return {
    async fetch(request: Request): Promise<Response> {
      const endpoint = endpointFromPath(channel, new URL(request.url).pathname)
      if (request.method !== 'POST' || endpoint === undefined) {
        return failureResponse(404, 'not found', options)
      }

      const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') {
        return failureResponse(415, 'content type must be application/json', options)
      }

      let body: unknown
      try {
        body = await request.json()
      } catch {
        return failureResponse(400, 'body is not JSON', options)
      }

      const envelope = clientRequestSchema.safeParse(body)
      if (!envelope.success) {
        return invalidEnvelopeResponse(body, envelope.error.issues, options)
      }
      const message: ClientRequest = envelope.data
      if (message.method !== endpoint) {
        return errorResponse(message.rpcId, {
          code: 'bad-request',
          message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
          details: { issues: [] },
        }, options)
      }

      try {
        const reply = await handler(endpoint, message.payload, request.signal, requestMetadata(request))
        return fullResponse(message.rpcId, applyOpaqueError(reply.result, options), options, reply.headers)
      } catch (error) {
        return failureResponse(500, `handler failure: ${String(error)}`, options)
      }
    },
  }
}

function invalidEnvelopeResponse(
  body: unknown,
  issues: RpcErrorDetailsMap['bad-request']['issues'],
  options: ConnectionRpcHandlerOptions,
): Response {
  const rawId = (body as { rpcId?: unknown } | null)?.rpcId
  const rpcId = typeof rawId === 'string' ? RpcId(rawId) : INVALID_REQUEST_RPC_ID
  return errorResponse(rpcId, {
    code: 'bad-request',
    message: 'invalid client-request message',
    details: { issues },
  }, options)
}

function endpointFromPath(channel: string, pathname: string): string | undefined {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  const segments = endpoint.split('/')
  if (segments.some(segment =>
    segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    return undefined
  }
  return endpoint
}

function errorResponse(
  rpcId: RpcIdType,
  error: RpcError,
  options: ConnectionRpcHandlerOptions,
): Response {
  return fullResponse(rpcId, applyOpaqueError({ ok: false, error }, options), options)
}

function fullResponse(
  rpcId: RpcIdType,
  result: RpcServerResponse['result'],
  options: ConnectionRpcHandlerOptions,
  headers?: Readonly<Record<string, string>>,
): Response {
  const body: RpcServerResponse = { type: 'server-response', rpcId, result }
  const framedHeaders = responseHeaders(options.requiredResponseHeaders, headers)
  framedHeaders.set('content-type', 'application/json')
  return Response.json(body, { headers: framedHeaders })
}

function applyOpaqueError(
  result: RpcServerResponse['result'],
  options: ConnectionRpcHandlerOptions,
): RpcServerResponse['result'] {
  return !result.ok && options.opaqueError !== undefined
    ? { ok: false, error: options.opaqueError }
    : result
}

function failureResponse(
  status: number,
  fallbackMessage: string,
  options: ConnectionRpcHandlerOptions,
): Response {
  return new Response(failureMessage(fallbackMessage, options), {
    status,
    headers: responseHeaders(options.requiredResponseHeaders),
  })
}

function failureMessage(fallback: string, options: ConnectionRpcHandlerOptions): string {
  return options.opaqueError?.message ?? fallback
}

function responseHeaders(
  required?: Readonly<Record<string, string>>,
  provided?: Readonly<Record<string, string>>,
): Headers {
  const headers = new Headers(provided)
  for (const [name, value] of Object.entries(required ?? {})) headers.set(name, value)
  return headers
}

function requestMetadata(request: Request): ConnectionRpcRequestMetadata {
  return Object.freeze({
    url: request.url,
    headers: Object.freeze({
      get: (name: string) => request.headers.get(name),
      has: (name: string) => request.headers.has(name),
    }),
  })
}

function assertChannel(channel: string): void {
  if (!CHANNEL_PATTERN.test(channel) || channel === '/api') {
    throw new Error(`connection: invalid or reserved RPC channel ${JSON.stringify(channel)}`)
  }
}
