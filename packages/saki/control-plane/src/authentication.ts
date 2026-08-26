/** Trusted in-process Saki authentication context. @module @breakfastdapaidang/saki-control-plane/src/authentication */

import type {
  SakiBrowserSessionId,
  SakiPrincipalId,
  SakiStorageGenerationId,
} from './types.ts'
import { constantTimeTextEqual } from './secrets.ts'

const AUTHENTICATION_MARKER = Symbol('saki-authentication-context')
const requestTokens = new WeakMap<SakiAuthenticationContext, string>()

/** Authentication facts derived by SakiAccess and never accepted from browser JSON. */
export class SakiAuthenticationContext {
  readonly #marker = AUTHENTICATION_MARKER

  /**
   * @param sessionId - authenticated Browser Session identity.
   * @param principalId - authenticated Principal identity.
   * @param storageGenerationId - physical storage generation bound to the session.
   * @param requestToken - token freshly derived from the presented raw cookie.
   */
  constructor(
    readonly sessionId: SakiBrowserSessionId,
    readonly principalId: SakiPrincipalId,
    readonly storageGenerationId: SakiStorageGenerationId,
    requestToken: string,
  ) {
    requestTokens.set(this, requestToken)
  }

  /**
   * Confirm that the trusted access implementation created this context.
   * @returns whether this value carries the private authentication marker.
   */
  isAuthentic(): boolean {
    return this.#marker === AUTHENTICATION_MARKER
  }

  /**
   * Compare a presented mutation token without exposing the derived value.
   * @param presented - request-token header value.
   * @returns whether the token matches this authentication context.
   */
  matchesRequestToken(presented: string): boolean {
    return constantTimeTextEqual(this.requireRequestToken(), presented)
  }

  /**
   * Reveal the derived token only for the authenticated Access Projection.
   * @returns the request token associated with this context.
   */
  projectRequestToken(): string {
    return this.requireRequestToken()
  }

  /**
   * Produce a diagnostic representation without authentication material.
   * @returns the fixed redacted representation.
   */
  toJSON(): { readonly kind: 'saki-authentication-context' } {
    return { kind: 'saki-authentication-context' }
  }

  private requireRequestToken(): string {
    const token = requestTokens.get(this)
    if (token === undefined) throw new Error('saki AuthenticationContext has no request token')
    return token
  }
}

/** Trusted authentication resolution used only by the Host adapter. */
export type SakiAuthenticationResolution =
  | { readonly ok: true; readonly authentication: SakiAuthenticationContext }
  | { readonly ok: false; readonly reason: 'unavailable' }

/** Trusted request metadata needed to resolve a protected operation. */
export interface SakiAuthenticationRequest {
  /** Exact Origin header supplied by the carrier. */
  readonly origin: string | undefined
  /** Whether Origin and request-token checks are mandatory. */
  readonly mutation: boolean
  /** Session-derived request token supplied for a mutation. */
  readonly requestToken?: string
}
