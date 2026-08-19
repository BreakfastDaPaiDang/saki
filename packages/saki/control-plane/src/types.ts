/** Public Saki control-plane value types. @module @breakfastdapaidang/saki-control-plane/types */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable identity of one Saki Installation. */
export type SakiInstallationId = Branded<'SakiInstallationId'>
/** Stable identity of one enrolled Saki Host. */
export type SakiHostId = Branded<'SakiHostId'>
/** Stable identity of one Installation State Generation. */
export type SakiInstallationGenerationId = Branded<'SakiInstallationGenerationId'>
/** Stable identity of one security Principal. */
export type SakiPrincipalId = Branded<'SakiPrincipalId'>
/** Stable identity of one authorization Grant. */
export type SakiGrantId = Branded<'SakiGrantId'>
/** Stable identity of the Installation Access aggregate. */
export type SakiInstallationAccessId = Branded<'SakiInstallationAccessId'>
/** Stable identity of one one-time Bootstrap Challenge. */
export type SakiBootstrapChallengeId = Branded<'SakiBootstrapChallengeId'>
/** Stable identity of one server-owned Browser Session. */
export type SakiBrowserSessionId = Branded<'SakiBrowserSessionId'>

/** Why one local launcher credential was issued. */
export type SakiBootstrapChallengePurpose = 'initial-bootstrap' | 'local-reauthentication'

/** Display-safe stable identities for local maintenance and startup diagnostics. */
export interface SakiInstallationIdentity {
  /** Product Installation identity, retained across Host replacement. */
  readonly installationId: SakiInstallationId
  /** Independently enrolled Local Host identity. */
  readonly hostId: SakiHostId
}

/** Trusted transport facts used by the local bootstrap exchange. */
export interface SakiBootstrapTransportContext {
  /** Exact browser Origin header, or absence when the carrier supplied none. */
  readonly origin: string | undefined
}

/** Bootstrap secret submitted only in the exchange request body. */
export interface SakiBootstrapExchangeRequest {
  /** Clear one-time secret from the local launcher handoff. */
  readonly secret: string
}

/** Closed unauthenticated Access state that reveals no Installation facts. */
export interface SakiUnauthenticatedAccessProjection {
  /** Required local recovery step. */
  readonly kind: 'bootstrap-required' | 'session-required' | 'unavailable'
  /** Generic operator-facing guidance. */
  readonly message: string
}

/** Authenticated Access state derived from the presented HttpOnly cookie. */
export interface SakiAuthenticatedAccessProjection {
  /** Authenticated Access discriminant. */
  readonly kind: 'authenticated'
  /** Display-safe Principal facts. */
  readonly principal: {
    /** Stable authenticated Principal identity. */
    readonly id: SakiPrincipalId
    /** Local display name. */
    readonly displayName: string
  }
  /** Server-clock Browser Session expiry as epoch milliseconds. */
  readonly expiresAt: number
  /** Session-derived request-forgery token for later mutations. */
  readonly requestToken: string
}

/** Access response returned before or after local authentication. */
export type AccessProjection = SakiUnauthenticatedAccessProjection | SakiAuthenticatedAccessProjection

/** Bootstrap exchange result; cookie material is carried out-of-band by the trusted Host adapter. */
export type SakiAccessExchangeResult =
  | { readonly ok: true; readonly access: SakiAuthenticatedAccessProjection }
  | { readonly ok: false; readonly reason: 'unavailable' }

/** Logout result; cookie expiration is carried out-of-band by the trusted Host adapter. */
export type SakiAccessLogoutResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'unavailable' }

/** The only Projection query admitted in B01. */
export interface SakiProjectIndexQuery {
  /** Query discriminant. */
  readonly type: 'project-index'
}

/** Closed B01 query map. */
export interface SakiQueryMap {
  /** Empty Development Project index. */
  readonly 'project-index': {
    readonly request: SakiProjectIndexQuery
    readonly projection: SakiProjectIndexProjection
  }
}

/** Query request union derived from {@link SakiQueryMap}. */
export type SakiQuery = SakiQueryMap[keyof SakiQueryMap]['request']

/** Empty Project-index Projection before project registration lands in B03. */
export interface SakiProjectIndexProjection {
  /** Projection discriminant. */
  readonly type: 'project-index'
  /** Control-plane Projection revision. */
  readonly revision: 0
  /** Authorized Development Projects; B01 owns no Project records. */
  readonly projects: readonly []
}

/** Result of a protected Projection query. */
export type SakiQueryResult =
  | { readonly ok: true; readonly projection: SakiProjectIndexProjection }
  | { readonly ok: false; readonly reason: 'denied' | 'unavailable' }

/**
 * Merge target for Saki Control Intents. B01 deliberately declares no members;
 * B03 owns the first successful Intent.
 */
export interface SakiIntentMap {}

/** Closed B01 Control Intent union. */
export type SakiIntent = SakiIntentMap[keyof SakiIntentMap]

/**
 * Control-plane submission argument. It is `undefined` only while the
 * merge-extensible Intent map has no members; it does not add a wire Intent.
 */
export type SakiIntentInput = [keyof SakiIntentMap] extends [never] ? undefined : SakiIntent

/** Stable rejection returned while the B01 Intent map is empty. */
export type SakiIntentReceipt =
  | { readonly ok: false; readonly reason: 'intent-unavailable' | 'denied' | 'unavailable' }

/** Projection key invalidated after a committed access or authority change. */
export type SakiProjectionKey = 'access' | 'project-index'

/** Disposer for a contained post-commit Projection invalidation listener. */
export type SakiChangedDisposer = () => void
