/** Generic unary RPC contracts shared by the Host and Client Connection halves. */

import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'

/** Trust fence applied before a Host RPC channel reaches its handler. */
export type ConnectionRpcAuthority = 'trusted-host' | 'loopback'

/** Registration policy for one logical RPC channel. */
export interface ConnectionRpcHandlerOptions {
  /** Browser authority accepted by every endpoint in this channel. */
  readonly authority: ConnectionRpcAuthority
}

/** Read-only header access from the request received by the Host transport. */
export interface ConnectionRpcRequestHeaders {
  /**
   * Read one header value using case-insensitive HTTP matching.
   * @param name - HTTP header name.
   * @returns the joined header value, or null when absent.
   */
  get(name: string): string | null

  /**
   * Test whether one header is present using case-insensitive HTTP matching.
   * @param name - HTTP header name.
   * @returns whether the header is present.
   */
  has(name: string): boolean
}

/** Trusted HTTP metadata supplied separately from a channel-owned JSON payload. */
export interface ConnectionRpcRequestMetadata {
  /** Absolute URL reconstructed by the active Host transport. */
  readonly url: string
  /** Read-only request headers. */
  readonly headers: ConnectionRpcRequestHeaders
}

/** Complete Host reply before Connection adds correlation and JSON framing. */
export interface ConnectionRpcReply {
  /** Channel-owned RPC outcome. */
  readonly result: RpcResult<unknown>
  /** HTTP response headers carried outside the JSON envelope; Connection replaces Content-Type. */
  readonly headers?: Readonly<Record<string, string>>
}

/**
 * Handle one decoded request after Connection has enforced the channel trust policy.
 * @param endpoint - channel-relative endpoint selected from the request URL.
 * @param payload - channel-owned JSON payload.
 * @param signal - transport cancellation signal.
 * @param request - trusted URL and read-only headers kept outside the payload.
 * @returns RPC result and optional HTTP response headers.
 */
export type ConnectionRpcHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
  request: ConnectionRpcRequestMetadata,
) => Promise<ConnectionRpcReply>

/** Synchronous ownership test for one endpoint on a shared RPC channel. */
export type ConnectionRpcEndpointMatcher = (endpoint: string) => boolean

/** Host registry for logical RPC channels carried by the current transport. */
export interface HostConnectionRpc {
  /**
   * Register one absolute channel prefix and its trust policy.
   * @param channel - absolute logical channel such as `/rpc`.
   * @param handler - decoded endpoint handler returning the channel reply.
   * @param options - channel trust policy.
   * @returns asynchronous disposer removing the channel and its physical route.
   */
  handle(
    channel: string,
    handler: ConnectionRpcHandler,
    options: ConnectionRpcHandlerOptions,
  ): () => Promise<void>

  /**
   * Intercept owned endpoints on the shared `/api` channel before its fallback.
   * @param channel - reserved shared channel; currently `/api`.
   * @param matches - synchronous endpoint ownership test.
   * @param handler - decoded endpoint handler returning the channel reply.
   * @param options - trust policy for every endpoint claimed by this interceptor.
   * @returns asynchronous disposer removing the interceptor.
   */
  intercept(
    channel: '/api',
    matches: ConnectionRpcEndpointMatcher,
    handler: ConnectionRpcHandler,
    options: ConnectionRpcHandlerOptions,
  ): () => Promise<void>
}

/** Host `ctx.connection` shape consumed by transport-independent adapters. */
export interface HostConnectionHandle {
  /** Generic RPC channel registry. */
  readonly rpc: HostConnectionRpc
}

/** Client caller for logical RPC channels carried by the current transport. */
export interface ClientConnectionRpc {
  /**
   * Call one endpoint through an already registered logical channel.
   * @param channel - absolute logical channel such as `/api`.
   * @param endpoint - channel-relative endpoint such as `goals/create`.
   * @param payload - channel-owned request payload.
   * @param options - optional cancellation, credential policy, and operation headers.
   * @returns the existing RPC success/error result; correlation stays inside Connection.
   */
  call(
    channel: string,
    endpoint: string,
    payload: unknown,
    options?: ConnectionRpcCallOptions,
  ): Promise<RpcResult<unknown>>
}

/** Browser transport options for one generic Connection RPC call. */
export interface ConnectionRpcCallOptions {
  /** Optional caller cancellation. */
  readonly signal?: AbortSignal
  /** Browser credential policy; same-origin is the default. */
  readonly credentials?: RequestCredentials
  /** Operation-specific headers; Connection always owns JSON Content-Type. */
  readonly headers?: Readonly<Record<string, string>>
}
