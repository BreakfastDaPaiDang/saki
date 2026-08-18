/**
 * Service Definition for the credential-reference capability seam (`ctx.credentials`). Settings and composition files carry
 * *references* to secrets — environment-variable names — while providers own
 * the actual values and their storage. Consumers resolve a reference once per
 * operation, so a changed credential reaches the next operation without any
 * plugin restart, and configuration surfaces describe a reference without
 * ever seeing its value.
 * @module @deepseek-ai/dsh-credentials
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { CredentialHealth, CredentialProtectionLevel, CredentialRef } from './types.ts'

export type { CredentialHealth, CredentialProtectionLevel, CredentialRef } from './types.ts'

const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const PROTECTION_LEVEL_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/**
 * Brand a raw string as a {@link CredentialRef}.
 * @param value - candidate reference; a POSIX shell identifier such as `DEEPSEEK_API_KEY`.
 * @returns the branded reference.
 */
export function credentialRef(value: string): CredentialRef {
  if (!REF_PATTERN.test(value)) {
    throw new TypeError(`credential ref "${value}" must match ${String(REF_PATTERN)}`)
  }
  return value as CredentialRef
}

/**
 * Brand a provider-defined credential protection identifier.
 * @param value - lowercase kebab-case identifier describing one recovery trust model.
 * @returns the branded protection identifier.
 */
export function credentialProtectionLevel(value: string): CredentialProtectionLevel {
  if (!PROTECTION_LEVEL_PATTERN.test(value)) {
    throw new TypeError(`credential protection level "${value}" must match ${String(PROTECTION_LEVEL_PATTERN)}`)
  }
  return value as CredentialProtectionLevel
}

/** Plaintext value in an ambient source or provider-managed document. */
export const CREDENTIAL_PROTECTION_PLAINTEXT = credentialProtectionLevel('plaintext')
/** Process-local value that has no persisted recovery path. */
export const CREDENTIAL_PROTECTION_EPHEMERAL = credentialProtectionLevel('ephemeral')
/** Windows current-user protection; same-user processes remain trusted. */
export const CREDENTIAL_PROTECTION_LOCAL_USER_TRUST = credentialProtectionLevel('local-user-trust')

/** One resolved credential value and the source layer that supplied it. */
export interface ResolvedCredential {
  /** The non-empty secret value. */
  value: string
  /** Provider-defined source layer id (the local provider uses `env`, `file`, `project-env`, and `user-env`). */
  source: string
  /** Provider-defined recovery trust model for this exact resolved value. */
  protectionLevel: CredentialProtectionLevel
}

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
  interface Context {
    credentials: CredentialProvider
  }
}

/**
 * Abstract credential service. Providers implement the four operations over
 * their source layers; one seam-wide rule binds them all: an empty stored
 * value is absent everywhere — `resolve` skips it, `describe` reports it
 * unconfigured — so a blank never masquerades as a configured secret.
 */
export abstract class CredentialProvider extends Service {
  constructor(ctx: Context) {
    super(ctx, 'credentials')
  }

  /**
   * Resolve one reference to its current value. Resolution is per call:
   * consumers re-resolve at each operation and must not cache across
   * operations — that per-operation read is what makes a changed credential
   * reach the next operation without a restart.
   * @param ref - the reference to resolve.
   * @returns the value and its source, or `undefined` while unconfigured.
   */
  abstract resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>

  /**
   * Resolve one reference and require an exact provider-defined protection
   * level on the same typed result. Missing values and every non-matching level
   * fail before the caller receives the value. Protection identifiers are
   * descriptive, not an ordered scale.
   * @param ref - the reference to resolve.
   * @param required - the exact protection level the consumer accepts.
   * @returns the resolved credential after its metadata satisfies the requirement.
   */
  async resolveRequired(ref: CredentialRef, required: CredentialProtectionLevel): Promise<ResolvedCredential> {
    const resolved = await this.resolve(ref)
    if (resolved === undefined) {
      throw new Error(`credential "${ref}" requires protection level "${required}" but is not configured`)
    }
    if (resolved.protectionLevel !== required) {
      throw new Error(
        `credential "${ref}" requires protection level "${required}" but source "${resolved.source}" reported "${resolved.protectionLevel}"`,
      )
    }
    return resolved
  }

  /**
   * Describe one reference for configuration surfaces without exposing the
   * value.
   * @param ref - the reference to describe.
   * @returns safe source, protection, health, and writability metadata observed at call time.
   */
  abstract describe(ref: CredentialRef): Promise<CredentialInfo>

  /**
   * Durably store one value in the provider-managed writable source. Rejects
   * while a read-only source shadows the reference — the write would appear
   * to succeed while resolution keeps returning the shadowing value — and
   * rejects an empty value (use {@link unset}).
   * @param ref - the reference to store.
   * @param value - the non-empty secret value.
   */
  abstract set(ref: CredentialRef, value: string): Promise<void>

  /**
   * Remove one reference from the provider-managed writable source; removing
   * an absent reference is a no-op. Rejects while a read-only source shadows
   * the reference, like {@link set}.
   * @param ref - the reference to remove.
   */
  abstract unset(ref: CredentialRef): Promise<void>

  /* jscpd:ignore-start -- deliberate symmetry with the settings seam's commit
     fan-out: the contained-dispatch shape is the reviewed listener-lifecycle
     contract, and extracting it would couple the two seams' event semantics. */
  /**
   * Fan `credentials/updated` out with contained listener failures: every
   * listener runs, and a sync throw or async rejection is logged without
   * changing the committed operation's outcome — except `INVARIANT`-coded
   * failures, which rethrow after every listener ran (the rethrow reaches the
   * caller only from synchronous listeners, so invariant checks on this event
   * must not be async functions). Providers call this only after the write or
   * reload actually committed, so a broken observer can never make a durable
   * change look failed.
   * @param ref - the reference whose stored value changed.
   */
  protected notifyUpdated(ref: CredentialRef): void {
    let invariantFailure: unknown
    const args = ['credentials/updated', ref]
    for (const listener of this.ctx.events.dispatch('emit', args) as Array<(...listenerArgs: unknown[]) => unknown>) {
      try {
        const returned = listener(ref)
        if (returned != null && typeof (returned as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(returned as PromiseLike<unknown>).then(undefined, (error: unknown) => {
            this.warnListenerFailure(ref, error)
          })
        }
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 'INVARIANT') {
          invariantFailure ??= error
          continue
        }
        this.warnListenerFailure(ref, error)
      }
    }
    if (invariantFailure !== undefined) throw invariantFailure as Error
  }
  /* jscpd:ignore-end */

  /** Contained-listener diagnostic shared by the sync and async failure paths. */
  private warnListenerFailure(ref: CredentialRef, error: unknown): void {
    this.ctx.logger.warn('credentials: a credentials/updated listener for "%s" failed', ref)
    this.ctx.logger.warn(error)
  }
}

export default CredentialProvider
