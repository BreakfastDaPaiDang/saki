/**
 * Client-safe type surface of the credential seam: the two key brands, the
 * stored-record union, protection metadata, Remote reference view, and
 * Cordis event declarations. Types only; no Host runtime imports.
 *
 * @module @deepseek-ai/dsh-credentials/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Nominal reference to one credential: a POSIX-style environment-variable name. */
export type CredentialRef = Branded<'CredentialRef'>

/**
 * Nominal address of one stored credential record: `<scope>/<id>`, where
 * `scope` is the registered name of the plugin that owns the record and `id`
 * is that plugin's own addressing unit (an LLM adapter uses its provider route
 * key).
 *
 * The scope is the owner rather than the domain because a record's payload is
 * written in its owner's format: two plugins serving the same provider name
 * would otherwise read each other's payload, and a record left behind by an
 * uninstalled plugin could not be told apart from a live one. The `/` also
 * keeps this grammar disjoint from {@link CredentialRef}, so the two key
 * spaces can never collide.
 */
export type CredentialKey = Branded<'CredentialKey'>

/**
 * A credential the harness itself understands: an api key, provider
 * environment values, or both. Either field may be absent — a record carrying
 * neither states that the owner confirmed this route authenticates from its
 * own ambient discovery, which is a different fact from having no record.
 */
export interface ApiKeyRecord {
  /** Discriminant. */
  readonly kind: 'api-key'
  /** The non-empty secret value, when this credential is a key at all. */
  readonly key?: string
  /** Provider environment values such as `AWS_PROFILE`; names are POSIX identifiers. */
  readonly env?: Readonly<Record<string, string>>
}

/**
 * The product of one authorization grant, kept verbatim for its owner. The
 * seam never reads, validates, or reshapes {@link payload}: it is written in
 * the owning plugin's format and only that plugin can interpret it. The single
 * constraint is that it survives a JSON round trip.
 */
export interface GrantRecord {
  /** Discriminant. */
  readonly kind: 'grant'
  /** Owner-defined JSON value; opaque to the seam and to every other plugin. */
  readonly payload: unknown
}

/** One durable credential record, tagged by what the seam may do with it. */
export type CredentialRecord = ApiKeyRecord | GrantRecord

/** Provider-defined description of the identities and processes that may recover a credential value. */
export type CredentialProtectionLevel = Branded<'CredentialProtectionLevel'>

/** Safe observation of whether a credential can be used without exposing its value. */
export type CredentialHealth = 'available' | 'missing' | 'unavailable'

/** Safe observation for one reference, including its recovery trust model but never its value. */
export interface CredentialInfo {
  /** Reference this observation describes. */
  ref: CredentialRef
  /** Whether the provider has a record or effective source assigned to this reference. */
  configured: boolean
  /** Source layer currently supplying the value; absent while unconfigured. */
  source?: string
  /** Recovery trust model of the effective source, or the provider's writable source while missing. */
  protectionLevel: CredentialProtectionLevel
  /** Whether {@link CredentialProvider.set} would currently succeed for this reference. */
  writable: boolean
  /** Whether the value is available, absent, or present but unusable. */
  health: CredentialHealth
  /** Unix epoch milliseconds at which the provider made this observation. */
  observedAt: number
}


declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Committed change to a provider-managed credential source: a `set`, an
     * `unset`, or an external edit observed in storage. Ambient
     * process-environment changes are not observable and never emit. Listener
     * failures are contained and logged — a sync throw and an async rejection
     * alike — without changing the committed operation's outcome, except
     * `INVARIANT`-coded failures, which rethrow after every listener ran;
     * that rethrow reaches the emitter only from synchronous listeners, so
     * invariant checks on this event must not be async functions.
     * @param ref - the reference whose stored value changed.
     * @mode emit
     */
    'credentials/reference-updated'(ref: CredentialRef): void

    /**
     * Committed change to a stored credential record: a `modifyRecord` that
     * wrote, a `deleteRecord` that removed, or an external edit observed in
     * storage. Separate from `credentials/reference-updated` because the two key
     * grammars are disjoint — a listener that received both on one event could
     * not tell which space a subject belongs to. Listener failures are
     * contained on the same terms as `credentials/reference-updated`.
     * @param key - the record whose stored value changed.
     * @mode emit
     */
    'credentials/record-updated'(key: CredentialKey): void
  }
}
