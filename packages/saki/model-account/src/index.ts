/** Registry and activation of account-specific Model Routes. @module @breakfastdapaidang/saki-model-account */

import { Context, Service } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-llm'
import type { ModelAccountBinding, ModelAccountProvider } from './types.ts'

export type * from './types.ts'

/**
 * Construct a product Profile identity from its persisted UUID.
 * @param value - UUID allocated by the control plane.
 * @returns validated opaque Profile identity.
 */
export function modelAccountProfileId(value: string): import('./types.ts').ModelAccountProfileId {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    throw new TypeError('invalid Model Account Profile id')
  }
  return brandString<import('./types.ts').ModelAccountProfileId>(value)
}

/**
 * Construct an account implementation's registry id.
 * @param value - lowercase provider identifier.
 * @returns validated provider identity.
 */
export function modelAccountProviderId(value: string): import('./types.ts').ModelAccountProviderId {
  if (!/^[a-z][a-z0-9-]*$/.test(value)) throw new TypeError('invalid Model Account Provider id')
  return brandString<import('./types.ts').ModelAccountProviderId>(value)
}

/**
 * Derive an immutable route from a Profile and configuration revision.
 * @param profileId - durable Profile identity.
 * @param revision - positive configuration revision.
 * @returns account-specific LLM route identity.
 */
export function modelAccountRouteId(
  profileId: import('./types.ts').ModelAccountProfileId,
  revision: number,
): import('./types.ts').ModelAccountRouteId {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new TypeError('invalid Model Account revision')
  return brandString<import('./types.ts').ModelAccountRouteId>(`saki-account-${profileId}-${revision}`)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sakiModelAccounts: ModelAccountService
  }
  interface Events {
    /**
     * Account implementations or their available connection methods changed.
     * @mode emit
     */
    'saki-model-accounts/changed'(): void
  }
}

/** The provider registry owns reversible route registrations, never product selection. */
export class ModelAccountService extends Service {
  static inject = ['llm']
  private readonly providers = new Map<string, ModelAccountProvider>()
  private readonly routes = new Map<ModelAccountProvider, Set<() => Promise<void>>>()
  private readonly activeRoutes = new Set<import('./types.ts').ModelAccountRouteId>()

  constructor(ctx: Context) {
    super(ctx, 'sakiModelAccounts')
  }

  /**
   * Register a provider for this plugin lifetime.
   * @param provider - complete account implementation.
   * @returns disposer that withdraws the implementation.
   */
  register(provider: ModelAccountProvider): () => Promise<void> {
    return this.ctx.effect(() => {
      if (this.providers.has(provider.id)) throw new Error('Model Account Provider already registered')
      this.providers.set(provider.id, provider)
      this.ctx.emit('saki-model-accounts/changed')
      return async () => {
        this.providers.delete(provider.id)
        await Promise.all([...this.routes.get(provider) ?? []].map(dispose => dispose()))
        this.routes.delete(provider)
        this.ctx.emit('saki-model-accounts/changed')
      }
    })
  }

  /**
   * List available account implementations.
   * @returns the currently registered implementations in registration order.
   */
  list(): readonly ModelAccountProvider[] {
    return [...this.providers.values()]
  }

  /**
   * Resolve an implementation without falling back to another provider.
   * @param id - exact registered provider identity.
   * @returns provider or undefined while its plugin is absent.
   */
  get(id: import('./types.ts').ModelAccountProviderId): ModelAccountProvider | undefined {
    return this.providers.get(id)
  }

  /**
   * Observe whether an owned route still belongs to a live Provider registration.
   * @param routeId - immutable account route identity.
   * @returns true until the route or its Provider is disposed.
   */
  isActive(routeId: import('./types.ts').ModelAccountRouteId): boolean {
    return this.activeRoutes.has(routeId)
  }

  /**
   * Activate one immutable account route after verifying its current credential ownership.
   * @param binding - exact account and configuration revision.
   * @param signal - activation cancellation.
   * @returns disposer withdrawing this route from new requests.
   */
  async activate(binding: ModelAccountBinding, signal: AbortSignal): Promise<() => Promise<void>> {
    const provider = this.providers.get(binding.providerId)
    if (provider === undefined) throw new Error('Model Account Provider unavailable')
    const snapshot = await provider.inspect(binding, signal)
    signal.throwIfAborted()
    if (snapshot.authentication !== 'authorized' || snapshot.health === 'unavailable'
      || snapshot.entitlement === 'denied' || snapshot.protectionLevel !== binding.requiredProtection
      || (snapshot.usage.state === 'available' && snapshot.usage.windows.some(window => window.blocksRequests && window.remaining === 0))
      || (binding.accountIdentity !== null && binding.accountIdentity !== snapshot.identity)) {
      throw new Error('Model Account is not eligible for activation')
    }
    if (this.providers.get(binding.providerId) !== provider) throw new Error('Model Account Provider changed')
    const activation = provider.createAdapter(binding)
    try {
      const unregister = this.ctx.llm.registerAdapter([binding.routeId], activation.adapter)
      this.activeRoutes.add(binding.routeId)
      const owned = this.routes.get(provider) ?? new Set<() => Promise<void>>()
      this.routes.set(provider, owned)
      const dispose = this.ctx.effect(() => () => {
        this.activeRoutes.delete(binding.routeId)
        owned.delete(dispose)
        try { unregister() } finally { activation.dispose() }
      })
      owned.add(dispose)
      return dispose
    } catch (error) {
      activation.dispose()
      throw error
    }
  }
}

export default ModelAccountService
