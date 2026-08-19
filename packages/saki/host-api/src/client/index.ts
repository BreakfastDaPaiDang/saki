/** Browser client for the typed Saki Connection channel. @module @breakfastdapaidang/saki-host-api/client */

import { Context, Service } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import {
  sakiAccessExchangeResultSchema,
  sakiAccessLogoutResultSchema,
  sakiAccessProjectionSchema,
  sakiQueryResultSchema,
} from '../wire.ts'
import type {
  SakiWireAccessExchangeResult,
  SakiWireAccessLogoutResult,
  SakiWireAccessProjection,
  SakiWireQueryResult,
} from '../wire.ts'

const CHANNEL = '/saki'
const REQUEST_TOKEN_HEADER = 'x-saki-request-token'

/** Browser operations exposed by the B01 Host API. */
export interface SakiHostClient {
  /** @param signal - optional cancellation. @returns current display-safe Access state. */
  readAccess(signal?: AbortSignal): Promise<SakiWireAccessProjection>
  /** @param secret - clear one-time launcher secret. @param signal - optional cancellation. @returns exchange outcome. */
  exchangeBootstrap(secret: string, signal?: AbortSignal): Promise<SakiWireAccessExchangeResult>
  /** @param requestToken - current session-derived request token. @param signal - optional cancellation. @returns logout outcome. */
  logout(requestToken: string, signal?: AbortSignal): Promise<SakiWireAccessLogoutResult>
  /** @param signal - optional cancellation. @returns authorized empty Project index or denial. */
  queryProjectIndex(signal?: AbortSignal): Promise<SakiWireQueryResult>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Typed browser client for Saki Access and Projections. */
    sakiHostClient: SakiHostClient
  }
}

/** Required Client Connection carrier. */
export const inject = ['connection']

/** Browser Saki client backed by same-origin Connection calls. */
export class SakiHostClientService extends Service implements SakiHostClient {
  private readonly connection: ConnectionHandle

  /** @param ctx - Client context carrying Connection. */
  constructor(ctx: Context) {
    super(ctx, 'sakiHostClient')
    const connection = ctx.get('connection') as ConnectionHandle | undefined
    if (connection === undefined) throw new Error('saki Host client requires the active Connection carrier')
    this.connection = connection
  }

  /** @inheritdoc */
  async readAccess(signal?: AbortSignal): Promise<SakiWireAccessProjection> {
    return sakiAccessProjectionSchema.parse(await this.call('access/read', {}, signal))
  }

  /** @inheritdoc */
  async exchangeBootstrap(secret: string, signal?: AbortSignal): Promise<SakiWireAccessExchangeResult> {
    return sakiAccessExchangeResultSchema.parse(await this.call('access/exchange', { secret }, signal))
  }

  /** @inheritdoc */
  async logout(requestToken: string, signal?: AbortSignal): Promise<SakiWireAccessLogoutResult> {
    return sakiAccessLogoutResultSchema.parse(await this.call(
      'access/logout',
      {},
      signal,
      { [REQUEST_TOKEN_HEADER]: requestToken },
    ))
  }

  /** @inheritdoc */
  async queryProjectIndex(signal?: AbortSignal): Promise<SakiWireQueryResult> {
    return sakiQueryResultSchema.parse(await this.call('control/query', { type: 'project-index' }, signal))
  }

  private async call(
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
    headers?: Readonly<Record<string, string>>,
  ): Promise<unknown> {
    const result = await this.connection.rpc.call(CHANNEL, endpoint, payload, {
      credentials: 'same-origin',
      ...(signal === undefined ? {} : { signal }),
      ...(headers === undefined ? {} : { headers }),
    })
    if (!result.ok) throw new Error(`Saki Host request failed: ${result.error.code}`)
    return result.value
  }
}

export default SakiHostClientService
