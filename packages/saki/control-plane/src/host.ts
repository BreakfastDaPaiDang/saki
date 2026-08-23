/** Trusted Host-only access helpers excluded from browser entrypoints. @module @breakfastdapaidang/saki-control-plane/host */

import type { SakiAuthenticationRequest, SakiAuthenticationResolution } from './authentication.ts'
import type { SakiControlPlaneModule } from './service.ts'
import type { SakiAccessExchangeResult, SakiAccessLogoutResult } from './types.ts'
import { SakiControlPlaneService } from './service.ts'
import { takeCookieHeader } from './secrets.ts'

export type {
  SakiAuthenticationContext,
  SakiAuthenticationRequest,
  SakiAuthenticationResolution,
} from './authentication.ts'

/**
 * Resolve raw cookie and trusted transport metadata into a non-wire AuthenticationContext.
 * @param controlPlane - active Saki control-plane module.
 * @param presentedSession - raw cookie credential extracted by the Host adapter.
 * @param request - trusted Origin, mutation, and request-token metadata.
 * @param signal - caller cancellation.
 * @returns trusted authentication or a generic unavailable result.
 */
export function resolveSakiAuthentication(
  controlPlane: SakiControlPlaneModule,
  presentedSession: string | undefined,
  request: SakiAuthenticationRequest,
  signal: AbortSignal,
): Promise<SakiAuthenticationResolution> {
  if (!(controlPlane instanceof SakiControlPlaneService)) {
    return Promise.reject(new Error('saki host authentication requires the active control-plane implementation'))
  }
  return controlPlane.resolveAuthentication(presentedSession, request, signal)
}

/**
 * Consume the post-commit Set-Cookie handoff without serializing it into the business result.
 * @param result - completed exchange or logout result.
 * @returns one Set-Cookie header, or `undefined` after prior consumption or failure.
 */
export function takeSakiCookieHeader(
  result: SakiAccessExchangeResult | SakiAccessLogoutResult,
): string | undefined {
  return takeCookieHeader(result)
}

/**
 * Read the session-cookie name from the active access implementation.
 * @param controlPlane - active Saki control-plane module.
 * @returns configured cookie name used only for trusted Cookie extraction.
 */
export function sakiSessionCookieName(controlPlane: SakiControlPlaneModule): string {
  if (!(controlPlane instanceof SakiControlPlaneService)) {
    throw new Error('saki host cookie extraction requires the active control-plane implementation')
  }
  return controlPlane.sessionCookieName()
}
