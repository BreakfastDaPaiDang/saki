/** Secret derivation and opaque transport handoffs owned by Saki access. @module @breakfastdapaidang/saki-control-plane/src/secrets */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type {
  SakiAccessExchangeResult,
  SakiAccessLogoutResult,
  SakiBootstrapChallengeId,
  SakiBootstrapChallengePurpose,
  SakiBrowserSessionId,
} from './types.ts'

const cookieHeaders = new WeakMap<object, string>()

/**
 * Generate a URL-safe 256-bit credential.
 * @returns a fresh base64url credential.
 */
export function generateCredential(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * Compute a one-way Bootstrap Challenge verifier.
 * @param challengeId - stable challenge identity that owns this verifier.
 * @param secret - clear one-time bootstrap secret.
 * @returns the domain-separated verifier digest.
 */
export function bootstrapDigest(challengeId: SakiBootstrapChallengeId, secret: string): string {
  return createHash('sha256')
    .update('saki/bootstrap-secret/v1\0')
    .update(challengeId)
    .update('\0')
    .update(secret)
    .digest('hex')
}

/**
 * Compute a one-way Browser Session cookie verifier.
 * @param sessionId - stable Browser Session identity that owns this verifier.
 * @param cookie - clear browser cookie credential.
 * @returns the domain-separated verifier digest.
 */
export function cookieDigest(sessionId: SakiBrowserSessionId, cookie: string): string {
  return createHash('sha256')
    .update('saki/browser-cookie/v1\0')
    .update(sessionId)
    .update('\0')
    .update(cookie)
    .digest('hex')
}

/**
 * Derive the request-forgery token without persisted verifier material.
 * @param sessionId - authenticated Browser Session identity.
 * @param cookie - clear browser cookie credential.
 * @param domain - versioned derivation domain from Installation Access.
 * @returns a base64url request token bound to the cookie.
 */
export function deriveRequestToken(
  sessionId: SakiBrowserSessionId,
  cookie: string,
  domain: string,
): string {
  return createHmac('sha256', cookie)
    .update(`saki/request-token/v1\0${domain}\0${sessionId}`)
    .digest('base64url')
}

/**
 * Compare two same-domain textual authenticators in constant time for the expected length.
 * @param left - authoritative authenticator.
 * @param right - presented authenticator.
 * @returns whether the authenticators match.
 */
export function constantTimeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  if (leftBytes.byteLength !== rightBytes.byteLength) {
    timingSafeEqual(leftBytes, Buffer.alloc(leftBytes.byteLength))
    return false
  }
  return timingSafeEqual(leftBytes, rightBytes)
}

/**
 * Attach a one-shot Set-Cookie header outside the serializable business result.
 * @param result - successful access mutation result.
 * @param header - trusted Set-Cookie value.
 */
export function registerCookieHeader(
  result: SakiAccessExchangeResult | SakiAccessLogoutResult,
  header: string,
): void {
  cookieHeaders.set(result, header)
}

/**
 * Consume a trusted one-shot Set-Cookie header for a completed access mutation.
 * @param result - completed access mutation result.
 * @returns the trusted header, or `undefined` after prior consumption or failure.
 */
export function takeCookieHeader(result: SakiAccessExchangeResult | SakiAccessLogoutResult): string | undefined {
  const header = cookieHeaders.get(result)
  if (header !== undefined) cookieHeaders.delete(result)
  return header
}

/** Opaque launcher handoff whose clear secret can be consumed exactly once. */
export class SakiBootstrapHandoff {
  #secret: string | undefined

  /**
   * @param purpose - initial enrollment or later local reauthentication.
   * @param secret - clear secret retained only until the launcher consumes it.
   */
  constructor(readonly purpose: SakiBootstrapChallengePurpose, secret: string) {
    this.#secret = secret
  }

  /**
   * Consume the clear secret for local display.
   * @returns the clear bootstrap secret exactly once.
   */
  consume(): string {
    const secret = this.#secret
    if (secret === undefined) throw new Error('saki bootstrap handoff was already consumed')
    this.#secret = undefined
    return secret
  }

  /**
   * Serialize only the handoff kind, never the secret.
   * @returns a redacted JSON representation.
   */
  toJSON(): { readonly kind: 'saki-bootstrap-handoff'; readonly purpose: SakiBootstrapChallengePurpose } {
    return { kind: 'saki-bootstrap-handoff', purpose: this.purpose }
  }

  /**
   * Render a fixed label without the secret.
   * @returns a redacted string representation.
   */
  toString(): string {
    return '[SakiBootstrapHandoff]'
  }
}
