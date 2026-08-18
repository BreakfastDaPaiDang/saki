# User Credentials

English | [中文](credentials.zh.md)

The credential seam of [dsh-credentials](../../packages/credentials/credentials) keeps secrets out of configuration: settings sections and `cordis.yml` entries carry *references* (environment-variable names), providers such as [dsh-credentials-local](../../packages/credentials/credentials-local) and [dsh-credentials-windows-dpapi](../../packages/credentials/credentials-windows-dpapi) own the values, and consumers resolve a reference once per operation — the LLM adapters resolve once per model request, so a rotated credential reaches the very next request without any restart. One seam-wide rule binds every provider: an empty stored value is absent everywhere.

Source: [`packages/credentials/credentials/src/index.ts`](../../packages/credentials/credentials/src/index.ts)

## Identity

A reference names one credential as a POSIX-style environment-variable name. The brand prevents callers from mixing credential references with other strings passed between packages or processes; construction validates the shell-identifier syntax.

```ts type-equiv
/** Nominal reference to one credential: a POSIX-style environment-variable name. */
type CredentialRef = Branded<'CredentialRef'>
```

A protection level is the provider-defined recovery trust model for one effective source. Identifiers are descriptive rather than ordered: policy accepts an exact identifier instead of treating every storage mechanism as universally stronger or weaker. Health distinguishes an absent value from a configured record that the current Host cannot use.

```ts type-equiv
/** Provider-defined description of the identities and processes that may recover a credential value. */
type CredentialProtectionLevel = Branded<'CredentialProtectionLevel'>
```

```ts type-equiv
/** Safe observation of whether a credential can be used without exposing its value. */
type CredentialHealth = 'available' | 'missing' | 'unavailable'
```

## Resolution

`resolve(ref)` returns the value with the provider-defined source layer and protection level that supplied it, or `undefined` while unconfigured. Consumers re-resolve at each operation and never cache across operations — that per-operation read is the hot-update mechanism. The typed Provider interface requires the protection field; parsers validate it when constructing results from untyped input. `resolveRequired(ref, level)` enforces one exact protection identifier on the same result and fails closed for a missing value or non-matching level before the caller receives the value.

```ts type-equiv
/** One resolved credential value and the source layer that supplied it. */
interface ResolvedCredential {
  /** The non-empty secret value. */
  value: string
  /** Provider-defined source layer id (the local provider uses `env`, `file`, `project-env`, and `user-env`). */
  source: string
  /** Provider-defined recovery trust model for this exact resolved value. */
  protectionLevel: CredentialProtectionLevel
}
```

## Description

`describe(ref)` answers configuration surfaces without ever exposing a value: the reference, whether it is configured, its source and protection level, whether `set` would currently succeed, its health, and when the provider observed those facts. The local provider reports a reference supplied by the live process environment as `writable: false` — a write would appear to succeed while resolution kept returning the shadowing value, so the seam rejects it and the UI can render the reference read-only up front. The Windows DPAPI provider reports a copied, corrupt, or differently scoped record as configured but unavailable without returning its ciphertext.

```ts type-equiv
/** Safe observation for one reference, including its recovery trust model but never its value. */
interface CredentialInfo {
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
```

`plaintext`, `ephemeral`, and `local-user-trust` are the built-in identifiers. `local-user-trust` means Windows current-user DPAPI storage: it protects persisted values without claiming isolation from deliberate processes running as the same Windows user. A separately isolated broker or external secret manager is required for that stronger boundary.

## Change commits

`credentials/updated (ref)` fires after a committed change to a provider-managed source — a `set`, an `unset`, or an external edit observed in storage. Ambient process-environment changes are not observable and never emit. Consumers do not need the event (they re-resolve per operation); it exists for configuration surfaces refreshing a "configured" badge.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcredentials--credentialprovider-abstract-seam"></a>

### `ctx.credentials` — `CredentialProvider` (abstract seam)

Abstract credential service. Providers implement the four operations over their source layers; one seam-wide rule binds them all: an empty stored value is absent everywhere — `resolve` skips it, `describe` reports it unconfigured — so a blank never masquerades as a configured secret.

```ts cordis-catalog
/**
 * Resolve one reference to its current value. Resolution is per call:
 * consumers re-resolve at each operation and must not cache across
 * operations — that per-operation read is what makes a changed credential
 * reach the next operation without a restart.
 * @param ref - the reference to resolve.
 * @returns the value, source, and protection level, or `undefined` while unconfigured.
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
async resolveRequired(ref: CredentialRef, required: CredentialProtectionLevel): Promise<ResolvedCredential>

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
```

Source: [`packages/credentials/credentials/src/index.ts:90`](../../packages/credentials/credentials/src/index.ts)

<a id="credentials-events"></a>

### `credentials/*` events

<a id="credentialsupdated--emit"></a>

#### `credentials/updated` — emit

Committed change to a provider-managed credential source: a `set`, an `unset`, or an external edit observed in storage. Ambient process-environment changes are not observable and never emit. Listener failures are contained and logged — a sync throw and an async rejection alike — without changing the committed operation's outcome, except `INVARIANT`-coded failures, which rethrow after every listener ran; that rethrow reaches the emitter only from synchronous listeners, so invariant checks on this event must not be async functions.

```ts cordis-catalog
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
'credentials/updated'(ref: CredentialRef): void
```

Source: [`packages/credentials/credentials/src/types.ts:35`](../../packages/credentials/credentials/src/types.ts)
<!-- END GENERATED cordis-surface -->
