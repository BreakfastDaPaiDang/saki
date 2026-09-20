/** Protected snapshots of DSH Models connections. @module @breakfastdapaidang/saki-model-account-api */

import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Config as PiConfig, PiAiAdapter, resolveProfiles } from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { z } from 'zod'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'
import { modelAccountProviderId } from '@breakfastdapaidang/saki-model-account'
import type { ModelAccountBinding, ModelAccountIdentity, ModelAccountProvider, ModelAccountSnapshot } from '@breakfastdapaidang/saki-model-account'

export const name = 'saki-model-account-api'
export const inject = ['sakiModelAccounts', 'credentials', 'settings']

const configuration = z.object({ connection: z.string().min(1), profile: z.record(z.string(), z.json()) }).strict()

/** Validate a captured connection using the existing DSH provider schema. */
function profileOf(value: unknown, route: string): PiAiProviderProfile {
  const parsed = Schema.resolve({ providers: { [route]: structuredClone(value) } }, PiConfig, {})[0] as PiConfig
  const profiles = parsed.providers
  const profile = profiles?.[route]
  if (profile?.apiKeyEnv === undefined || profile.api === undefined || profile.baseURL === undefined
    || profile.models === undefined || profile.models.length === 0) throw new Error('API connection requires a key reference, protocol, endpoint and models')
  const url = new URL(profile.baseURL)
  if (!['https:', 'http:'].includes(url.protocol) || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== ''
    || Object.keys(profile.headers ?? {}).length > 0) throw new Error('API connection must keep credentials in the credential service')
  if (profile.models.some(model => model.input?.some(input => input !== 'text'))
    || profile.defaultInput?.some(input => input !== 'text')) throw new Error('API account imports currently support text input only')
  profile.models = profile.models.map(model => ({ ...model, input: ['text'] }))
  resolveProfiles({ [route]: profile })
  return profile
}

/** Protected material is re-read for every request without consulting the source connection. */
async function readKey(
  credentials: CredentialProvider, binding: ModelAccountBinding,
): Promise<{ value: string; identity: ModelAccountIdentity } | undefined> {
  const record = await credentials.readRecordProtected(binding.credentialKey, binding.requiredProtection)
  if (record === undefined) return undefined
  const identity = brandString<ModelAccountIdentity>(`api-profile:${binding.profileId}`)
  if (record.kind !== 'api-key' || record.key === undefined || record.key.length === 0
    || (binding.accountIdentity !== null && identity !== binding.accountIdentity)) {
    throw new Error('API credential identity mismatch')
  }
  return { value: record.key, identity }
}

/** An immutable connection revision whose transport and model conversion remain DSH-owned. */
class ApiAccountAdapter extends LlmAdapter {
  private readonly delegate: PiAiAdapter
  private readonly connection: string

  constructor(binding: ModelAccountBinding, credentials: CredentialProvider) {
    super()
    const captured = configuration.parse(binding.configuration)
    this.connection = captured.connection
    const profile = profileOf(captured.profile, this.connection)
    const profiles = resolveProfiles({ [this.connection]: profile })
    this.delegate = new PiAiAdapter({ profiles: () => profiles,
      resolveApiKey: async () => {
        const key = await readKey(credentials, binding)
        if (key === undefined) throw new LlmError('API account credential is missing', 'MISSING_CREDENTIAL')
        return key.value
      },
      auth: { credentials: new InMemoryCredentialStore(), authContext: {
        env: () => Promise.resolve(undefined), fileExists: () => Promise.resolve(false),
      } },
    })
  }

  override providerInfo(provider: string) { return { ...this.delegate.providerInfo(this.connection), id: provider } }
  override providerRetryPolicy() { return this.delegate.providerRetryPolicy(this.connection) }
  override async listModels(provider: string) {
    return (await this.delegate.listModels(this.connection)).map(model => ({ ...model, provider }))
  }
  override async resolveModel(provider: string, model: string, signal?: AbortSignal) {
    return { ...await this.delegate.resolveModel(this.connection, model, signal), provider }
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    try {
      for await (const chunk of this.delegate.stream({ ...options, provider: this.connection })) {
        if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
          yield { ...chunk, reason: { ...chunk.reason, failure: { ...chunk.reason.failure, message: 'API account request failed' } } }
        } else yield chunk
      }
    } catch {
      // Transport and credential errors may contain key material or response bodies.
      options.signal?.throwIfAborted()
      throw new LlmError('API account request is unavailable', 'ACCOUNT_UNAVAILABLE')
    }
  }
}

/**
 * Offer explicit imports of configured DSH Models connections.
 * @param ctx - account registry, protected credential provider and DSH settings.
 */
export function apply(ctx: Context): void {
  const connections = (): Record<string, PiAiProviderProfile> => {
    const descriptor = ctx.settings.describe().find(section => section.ns === 'llm-pi-ai')
    if (descriptor === undefined) return {}
    const parsed = Schema.resolve(structuredClone(descriptor.value), PiConfig, {})[0] as PiConfig
    return parsed.providers ?? {}
  }
  const provider: ModelAccountProvider = {
    id: modelAccountProviderId('api'),
    implementation: { name: '@breakfastdapaidang/saki-model-account-api', version: '0.1.0+pi-ai.0.85.1' },
    get methods() {
      return Object.entries(connections()).filter(([, profile]) => profile.apiKeyEnv !== undefined
        && profile.api !== undefined && profile.baseURL !== undefined && (profile.models?.length ?? 0) > 0)
        .map(([id, profile]) => ({ id, kind: 'stored-credential' as const, name: profile.displayName ?? id }))
    },
    resolveConfiguration(input) {
      const connection = z.string().min(1).parse(input.connection)
      const profile = profileOf(connections()[connection], connection)
      return configuration.parse({ connection, profile: JSON.parse(JSON.stringify(profile)) as unknown })
    },
    async authorize(binding, method, _progress, signal) {
      const captured = configuration.parse(binding.configuration)
      if (method !== captured.connection) throw new Error('API connection does not match the import method')
      const profile = profileOf(captured.profile, captured.connection)
      if (profile.apiKeyEnv === undefined) throw new Error('API connection has no credential reference')
      signal.throwIfAborted()
      const resolved = await ctx.credentials.resolveRequired(credentialRef(profile.apiKeyEnv), binding.requiredProtection)
      signal.throwIfAborted()
      await ctx.credentials.modifyRecordProtected(binding.credentialKey, binding.requiredProtection, (current) => {
        signal.throwIfAborted()
        return Promise.resolve(current ?? { kind: 'api-key', key: resolved.value })
      })
    },
    async inspect(binding, signal): Promise<ModelAccountSnapshot> {
      const observedAt = Date.now()
      const missing: ModelAccountSnapshot = { authentication: 'missing', health: 'unknown', entitlement: 'unknown',
        identity: null, protectionLevel: null, observedAt, models: [],
        usage: { state: 'unsupported', source: 'configured-api-connection', observedAt } }
      try {
        const key = await readKey(ctx.credentials, binding)
        signal.throwIfAborted()
        if (key === undefined) return missing
        const adapter = new ApiAccountAdapter(binding, ctx.credentials)
        const catalog = await adapter.listModels(binding.routeId)
        const models = await Promise.all(catalog.map(async (model) => {
          const info = await adapter.resolveModel(binding.routeId, model.id, signal)
          return { provider: binding.routeId, id: info.id, name: info.name,
            ...info.description === undefined ? {} : { description: info.description },
            ...info.inputModalities === undefined ? {} : { inputModalities: info.inputModalities },
            ...info.context === undefined ? {} : { context: info.context },
            ...info.reasoning === undefined ? {} : { reasoning: info.reasoning },
            ...info.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: info.defaultMaxTokens } }
        }))
        return { ...missing, authentication: 'authorized', identity: brandString<ModelAccountIdentity>(key.identity),
          protectionLevel: binding.requiredProtection, models }
      } catch {
        // Configuration, protected record and adapter failures are reduced to fixed product states.
        signal.throwIfAborted()
        return { ...missing, authentication: 'reauthorization-required', health: 'unavailable' }
      }
    },
    createAdapter(binding) { return { adapter: new ApiAccountAdapter(binding, ctx.credentials), dispose: () => {} } },
  }
  ctx.effect(() => ctx.sakiModelAccounts.register(provider))
  ctx.on('settings/updated', (namespace) => {
    if (namespace === 'llm-pi-ai') ctx.emit('saki-model-accounts/changed')
  })
}
