/** Provider-neutral account, authorization and usage observations. @module @breakfastdapaidang/saki-model-account/types */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { CredentialKey, CredentialProtectionLevel } from '@deepseek-ai/dsh-credentials'
import type { LlmAdapter, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'

/** Durable product identity, independent of the provider implementation and its account names. */
export type ModelAccountProfileId = Branded<'ModelAccountProfileId'>
/** Registry identity of one account implementation. */
export type ModelAccountProviderId = Branded<'ModelAccountProviderId'>
/** Immutable account-specific LLM registration identity. */
export type ModelAccountRouteId = Branded<'ModelAccountRouteId'>
/** Provider-confirmed identity used to reject account substitution. */
export type ModelAccountIdentity = Branded<'ModelAccountIdentity'>

/** Selected integration artifact recorded with a route revision. */
export interface ModelAccountImplementation {
  readonly name: string
  readonly version: string
}

/** Immutable inputs captured before authorization, inspection or activation. */
export interface ModelAccountBinding {
  readonly profileId: ModelAccountProfileId
  readonly providerId: ModelAccountProviderId
  readonly routeId: ModelAccountRouteId
  readonly revision: number
  readonly credentialKey: CredentialKey
  readonly requiredProtection: CredentialProtectionLevel
  readonly accountIdentity: ModelAccountIdentity | null
  readonly configuration: Readonly<Record<string, unknown>>
}

/** A provider's supported interactive authorization method. */
export interface ModelAccountAuthorizationMethod {
  readonly id: string
  readonly kind: 'browser' | 'device-code'
}

/** Safe progress; provider error text and credentials never enter these values. */
export type ModelAccountAuthorizationProgress =
  | { readonly kind: 'waiting' }
  | { readonly kind: 'browser'; readonly verificationUri: string }
  | {
    readonly kind: 'device-code'
    readonly verificationUri: string
    readonly userCode: string
    readonly expiresAt: number
    readonly nextPollAt: number
  }

/** Non-secret allowance fact, retaining the provider's unit and observation time. */
export interface ModelAccountUsageWindow {
  readonly id: string
  readonly unit: 'percent' | 'tokens' | 'requests' | 'currency'
  readonly remaining: number
  readonly limit: number | null
  readonly resetsAt: number | null
  /** Whether an exhausted window prevents requests on this account route. */
  readonly blocksRequests: boolean
}

/** Missing or failed allowance reads are distinct from an observed zero. */
export type ModelAccountUsage =
  | {
    readonly state: 'available'
    readonly observedAt: number
    readonly source: string
    readonly windows: readonly ModelAccountUsageWindow[]
  }
  | {
    readonly state: 'temporarily-unavailable' | 'unsupported'
    readonly observedAt: number
    readonly source: string
  }

/** Independently observed account facts, safe to persist and project to an operator. */
export interface ModelAccountSnapshot {
  readonly authentication: 'authorized' | 'missing' | 'reauthorization-required'
  readonly health: 'available' | 'unavailable' | 'unknown'
  readonly entitlement: 'unknown' | 'denied'
  readonly identity: ModelAccountIdentity | null
  readonly protectionLevel: CredentialProtectionLevel | null
  readonly observedAt: number
  readonly usage: ModelAccountUsage
  readonly models: readonly Pick<LlmResolvedModelInfo, 'provider' | 'id' | 'name' | 'description' | 'inputModalities' | 'context' | 'reasoning' | 'defaultMaxTokens'>[]
}

/** Complete Provider role; the control plane owns durable authorization Intents and Profiles. */
export interface ModelAccountProvider {
  readonly id: ModelAccountProviderId
  readonly implementation: ModelAccountImplementation
  readonly methods: readonly ModelAccountAuthorizationMethod[]
  /**
   * Validate deployment and stored configuration before any provider effect.
   * @param configuration - parsed product record or new operator input.
   * @returns detached normalized configuration.
   */
  resolveConfiguration(configuration: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>
  /**
   * Obtain and commit a protected credential through the DSH authorization and credential services.
   * @param binding - immutable account and credential destination.
   * @param method - an advertised authorization method.
   * @param progress - publishes safe progress while the durable Intent remains active.
   * @param signal - Intent lifetime, independent of a browser subscription.
   */
  authorize(
    binding: ModelAccountBinding,
    method: string,
    progress: (progress: ModelAccountAuthorizationProgress) => void,
    signal: AbortSignal,
  ): Promise<void>
  /**
   * Observe one captured account without selecting an alternative.
   * @param binding - account and configuration revision to inspect.
   * @param signal - inspection cancellation.
   * @returns typed account, model and allowance facts.
   */
  inspect(binding: ModelAccountBinding, signal: AbortSignal): Promise<ModelAccountSnapshot>
  /**
   * Construct the adapter for exactly this account and configuration revision.
   * @param binding - immutable account route inputs.
   * @returns an adapter and its lifecycle disposer; registration belongs to the service.
   */
  createAdapter(binding: ModelAccountBinding): { readonly adapter: LlmAdapter; readonly dispose: () => void }
}
