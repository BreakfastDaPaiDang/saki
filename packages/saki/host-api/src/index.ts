/** Host half of the typed Saki `/saki` Connection channel. @module @breakfastdapaidang/saki-host-api */

import type { Context } from '@deepseek-ai/cordis'
import type {
  ConnectionRpcReply,
  ConnectionRpcRequestMetadata,
} from '@deepseek-ai/dsh-client-connection'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import {
  resolveSakiAuthentication,
  sakiSessionCookieName,
  takeSakiCookieHeader,
} from '@breakfastdapaidang/saki-control-plane/host'
import type { SakiControlPlaneModule, SakiIntentInput } from '@breakfastdapaidang/saki-control-plane'
import {
  sakiAccessExchangeResultSchema,
  sakiAccessLogoutResultSchema,
  sakiAccessProjectionSchema,
  sakiBoardResultSchema,
  sakiBootstrapExchangeRequestSchema,
  sakiConfigureGitHubSynchronizationResultSchema,
  sakiCreateCommitResultSchema,
  sakiCreateWorkItemResultSchema,
  sakiGiveWorkItemToAgentResultSchema,
  sakiDevelopmentWorkspaceResultSchema,
  sakiEmptyRequestSchema,
  sakiInspectProjectSelectionResultSchema,
  sakiIntentRequestSchema,
  sakiRegisterDevelopmentProjectResultSchema,
  sakiProjectIndexResultSchema,
  sakiProjectDiffResultSchema,
  sakiProjectChangesResultSchema,
  sakiProjectSettingsResultSchema,
  sakiQueryRequestSchema,
  sakiMoveWorkItemResultSchema,
  sakiStageFilesResultSchema,
  sakiUnstageFilesResultSchema,
} from './wire.ts'

export * from './wire.ts'

/** Stable logical Connection channel owned by Saki. */
export const SAKI_CONNECTION_CHANNEL = '/saki'
/** Stable request-forgery header read only from trusted transport metadata. */
export const SAKI_REQUEST_TOKEN_HEADER = 'x-saki-request-token'
const SAKI_UNAVAILABLE_ERROR = {
  code: 'internal',
  message: 'Saki request is unavailable',
  details: {},
} as const
/** Stable Cordis plugin name. */
export const name = 'saki-host-api'
/** Host transport and control-plane services required by this adapter. */
export const inject = ['connection', 'sakiControlPlane']

/**
 * Register the Access, protected query, and Control Intent endpoints over the shared Connection carrier.
 * @param ctx - Host context carrying Connection and the Saki control plane.
 */
export function apply(ctx: Context): void {
  ctx.connection.rpc.handle(
    SAKI_CONNECTION_CHANNEL,
    (endpoint, payload, signal, request) => dispatch(ctx.sakiControlPlane, endpoint, payload, signal, request),
    {
      authority: 'loopback',
      requiredResponseHeaders: { 'cache-control': 'no-store' },
      opaqueError: SAKI_UNAVAILABLE_ERROR,
    },
  )
}

async function dispatch(
  controlPlane: SakiControlPlaneModule,
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
  request: ConnectionRpcRequestMetadata,
): Promise<ConnectionRpcReply> {
  try {
    if (new URL(request.url).search !== '') return reply(badRequest())
    switch (endpoint) {
      case 'access/read': return await readAccess(controlPlane, payload, signal, request)
      case 'access/exchange': return await exchangeBootstrap(controlPlane, payload, signal, request)
      case 'access/logout': return await authenticatedMutation(controlPlane, 'logout', payload, signal, request)
      case 'control/query': return await query(controlPlane, payload, signal, request)
      case 'control/submit': return await authenticatedMutation(controlPlane, 'submit', payload, signal, request)
      default: return reply(badRequest())
    }
  } catch {
    // The Host boundary converts implementation failures to one fixed result;
    // transport diagnostics must not serialize request or credential material.
    return reply({
      ok: false,
      error: SAKI_UNAVAILABLE_ERROR,
    })
  }
}

async function readAccess(
  controlPlane: SakiControlPlaneModule,
  payload: unknown,
  signal: AbortSignal,
  request: ConnectionRpcRequestMetadata,
): Promise<ConnectionRpcReply> {
  if (!sakiEmptyRequestSchema.safeParse(payload).success) return reply(badRequest())
  const cookie = sessionCookie(request, sakiSessionCookieName(controlPlane))
  const access = sakiAccessProjectionSchema.parse(await controlPlane.access.readAccess(cookie, signal))
  return reply({ ok: true, value: access })
}

async function exchangeBootstrap(
  controlPlane: SakiControlPlaneModule,
  payload: unknown,
  signal: AbortSignal,
  request: ConnectionRpcRequestMetadata,
): Promise<ConnectionRpcReply> {
  const parsed = sakiBootstrapExchangeRequestSchema.safeParse(payload)
  if (!parsed.success) return reply(badRequest())
  const result = await controlPlane.access.exchangeBootstrap(
    { origin: request.headers.get('origin') ?? undefined },
    parsed.data,
    signal,
  )
  const cookieHeader = takeSakiCookieHeader(result)
  const wireResult = sakiAccessExchangeResultSchema.parse(result)
  return reply({ ok: true, value: wireResult }, cookieHeader === undefined ? undefined : { 'set-cookie': cookieHeader })
}

async function query(
  controlPlane: SakiControlPlaneModule,
  payload: unknown,
  signal: AbortSignal,
  request: ConnectionRpcRequestMetadata,
): Promise<ConnectionRpcReply> {
  const parsed = sakiQueryRequestSchema.safeParse(payload)
  if (!parsed.success) return reply(badRequest())
  const resolution = await resolveSakiAuthentication(
    controlPlane,
    sessionCookie(request, sakiSessionCookieName(controlPlane)),
    { origin: request.headers.get('origin') ?? undefined, mutation: false },
    signal,
  )
  if (!resolution.ok) return reply({ ok: true, value: { ok: false, reason: 'unavailable' } })
  const result = await controlPlane.query(resolution.authentication, parsed.data, signal)
  switch (parsed.data.type) {
    case 'inspect-project-selection': {
      return reply({ ok: true, value: sakiInspectProjectSelectionResultSchema.parse(result) })
    }
    case 'project-index': {
      return reply({ ok: true, value: sakiProjectIndexResultSchema.parse(result) })
    }
    case 'development-workspace': {
      return reply({ ok: true, value: sakiDevelopmentWorkspaceResultSchema.parse(result) })
    }
    case 'project-changes': {
      return reply({ ok: true, value: sakiProjectChangesResultSchema.parse(result) })
    }
    case 'project-diff': {
      return reply({ ok: true, value: sakiProjectDiffResultSchema.parse(result) })
    }
    case 'project-settings': {
      return reply({ ok: true, value: sakiProjectSettingsResultSchema.parse(result) })
    }
    case 'board': {
      return reply({ ok: true, value: sakiBoardResultSchema.parse(result) })
    }
    /* v8 ignore next 2 -- SakiQuery is closed and strict Host parsing rejects unknown tags before dispatch. */
    default: return assertNever(parsed.data)
  }
}

async function authenticatedMutation(
  controlPlane: SakiControlPlaneModule,
  kind: 'logout' | 'submit',
  payload: unknown,
  signal: AbortSignal,
  request: ConnectionRpcRequestMetadata,
): Promise<ConnectionRpcReply> {
  let operation: { readonly kind: 'logout' } | { readonly kind: 'submit'; readonly intent: SakiIntentInput }
  if (kind === 'submit') {
    const parsed = sakiIntentRequestSchema.safeParse(payload)
    if (!parsed.success) return reply(badRequest())
    operation = { kind, intent: parsed.data }
  } else {
    if (!sakiEmptyRequestSchema.safeParse(payload).success) return reply(badRequest())
    operation = { kind }
  }
  const requestToken = request.headers.get(SAKI_REQUEST_TOKEN_HEADER) ?? undefined
  const resolution = await resolveSakiAuthentication(
    controlPlane,
    sessionCookie(request, sakiSessionCookieName(controlPlane)),
    {
      origin: request.headers.get('origin') ?? undefined,
      mutation: true,
      ...(requestToken === undefined ? {} : { requestToken }),
    },
    signal,
  )
  if (!resolution.ok || requestToken === undefined) {
    return reply({ ok: true, value: { ok: false, reason: 'unavailable' } })
  }
  const authentication = resolution.authentication
  if (operation.kind === 'submit') {
    switch (operation.intent.type) {
      case 'register-development-project': {
        const result = await controlPlane.submit(authentication, operation.intent, signal)
        return reply({
          ok: true,
          value: sakiRegisterDevelopmentProjectResultSchema.parse(result),
        })
      }
      case 'configure-github-synchronization': {
        const result = await controlPlane.submit(authentication, operation.intent, signal)
        return reply({
          ok: true,
          value: sakiConfigureGitHubSynchronizationResultSchema.parse(result),
        })
      }
      case 'stage-files': {
        const result = await controlPlane.submit(authentication, operation.intent, signal)
        return reply({ ok: true, value: sakiStageFilesResultSchema.parse(result) })
      }
      case 'unstage-files': {
        const result = await controlPlane.submit(authentication, operation.intent, signal)
        return reply({ ok: true, value: sakiUnstageFilesResultSchema.parse(result) })
      }
      case 'create-commit': {
        const result = await controlPlane.submit(authentication, operation.intent, signal)
        return reply({ ok: true, value: sakiCreateCommitResultSchema.parse(result) })
      }
      case 'create-work-item': {
        const result = await controlPlane.submit(authentication, operation.intent, signal)
        return reply({ ok: true, value: sakiCreateWorkItemResultSchema.parse(result) })
      }
      case 'move-work-item': {
        const result = await controlPlane.submit(authentication, operation.intent, signal)
        return reply({ ok: true, value: sakiMoveWorkItemResultSchema.parse(result) })
      }
      case 'give-work-item-to-agent': {
        const result = await controlPlane.submit(authentication, operation.intent, signal)
        return reply({ ok: true, value: sakiGiveWorkItemToAgentResultSchema.parse(result) })
      }
      /* v8 ignore next 2 -- Saki Intent input is closed and strict Host parsing rejects unknown tags before dispatch. */
      default: return assertNever(operation.intent)
    }
  }
  const result = await controlPlane.access.logoutCurrentSession(authentication, requestToken, signal)
  const cookieHeader = takeSakiCookieHeader(result)
  const wireResult = sakiAccessLogoutResultSchema.parse(result)
  return reply({ ok: true, value: wireResult }, cookieHeader === undefined ? undefined : { 'set-cookie': cookieHeader })
}

function sessionCookie(request: ConnectionRpcRequestMetadata, name: string): string | undefined {
  const header = request.headers.get('cookie')
  if (header === null) return undefined
  const matches = header.split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`))
  const [match] = matches
  if (matches.length !== 1 || match === undefined) return undefined
  const value = match.slice(name.length + 1)
  return value === '' ? undefined : value
}

function badRequest(): RpcResult<never> {
  return {
    ok: false,
    error: { code: 'bad-request', message: 'invalid Saki request', details: { issues: [] } },
  }
}

function reply(result: RpcResult<unknown>, headers?: Readonly<Record<string, string>>): ConnectionRpcReply {
  return { result, ...(headers === undefined ? {} : { headers }) }
}

/* v8 ignore start -- strict Host schemas make both closed switches exhaustive. */
function assertNever(_value: never): never {
  throw new TypeError('unexpected Saki discriminant')
}
/* v8 ignore stop */
