/** Maintained Codex authorization, account inspection and SSE routing. @module @breakfastdapaidang/saki-model-account-codex */

import type { Context } from '@deepseek-ai/cordis'
import { createModels } from '@earendil-works/pi-ai'
import type { AuthEvent, AuthPrompt, OAuthCredential } from '@earendil-works/pi-ai'
import { AuthorizationDeclinedError } from '@deepseek-ai/dsh-authorization'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-session'
import { modelAccountProviderId } from '@breakfastdapaidang/saki-model-account'
import type {
  ModelAccountAuthorizationProgress, ModelAccountBinding, ModelAccountProvider, ModelAccountSnapshot,
} from '@breakfastdapaidang/saki-model-account'
import { accountProvider, CodexAccountAdapter, codexConfigurationSchema } from './adapter.ts'
import { accountCredentialStore, codexAccountIdentity } from './credentials.ts'
import { CodexTurnState } from './turn-state.ts'
import { readUsage } from './usage.ts'

export const name = 'saki-model-account-codex'
export const inject = ['sakiModelAccounts', 'credentials', 'authorization', 'sessions']

/** Only the maintained Codex authorization authority may appear in a login challenge. */
function verificationUri(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com' || url.username !== '' || url.password !== '') {
    throw new Error('Codex authorization returned an unsupported verification URI')
  }
  return url.href
}

/** Convert supported library notices without projecting their free-form message fields. */
function progressOf(event: AuthEvent): ModelAccountAuthorizationProgress {
  if (event.type === 'auth_url') return { kind: 'browser', verificationUri: verificationUri(event.url) }
  if (event.type === 'device_code') {
    if (event.expiresInSeconds === undefined || event.intervalSeconds === undefined) {
      throw new Error('Codex device authorization omitted timing')
    }
    const now = Date.now()
    return { kind: 'device-code', verificationUri: verificationUri(event.verificationUri),
      userCode: event.userCode, expiresAt: now + event.expiresInSeconds * 1000,
      nextPollAt: now + event.intervalSeconds * 1000 }
  }
  return { kind: 'waiting' }
}

/** Browser callback completion cancels pi-ai's optional manual-code prompt. */
function waitForCallback(prompt: AuthPrompt, signal: AbortSignal): Promise<string> {
  const lifetime = prompt.signal === undefined ? signal : AbortSignal.any([signal, prompt.signal])
  if (lifetime.aborted) return Promise.reject(new AuthorizationDeclinedError())
  return new Promise((_resolve, reject) => {
    lifetime.addEventListener('abort', () => { reject(new AuthorizationDeclinedError()) }, { once: true })
  })
}

/**
 * Register the complete Codex account Provider on the shared registry.
 * @param ctx - Host services owning protected records, login, sessions and LLM routes.
 */
export function apply(ctx: Context): void {
  const provider: ModelAccountProvider = {
    id: modelAccountProviderId('codex'),
    implementation: { name: '@breakfastdapaidang/saki-model-account-codex', version: '0.1.0+pi-ai.0.85.1.subscription.2.1.2' },
    methods: [{ id: 'device_code', kind: 'device-code' }, { id: 'browser', kind: 'browser' }],
    resolveConfiguration(configuration) {
      return codexConfigurationSchema.parse(configuration)
    },
    async authorize(binding, method, progress, signal) {
      if (!provider.methods.some(item => item.id === method)) throw new Error('Unsupported account authorization method')
      const store = accountCredentialStore(ctx.credentials, binding)
      await store.read(binding.routeId, { signal })
      const models = createModels({ credentials: store, authContext: {
        env: () => Promise.resolve(undefined), fileExists: () => Promise.resolve(false),
      } })
      models.setProvider(accountProvider(binding))
      const unregister = ctx.authorization.registerFlow({
        key: binding.credentialKey,
        label: 'Codex',
        methods: [{ id: method, label: method }],
        async run(session) {
          await models.login(binding.routeId, 'oauth', {
            signal: session.signal,
            notify: (event) => { progress(progressOf(event)) },
            prompt: (prompt) => {
              if (prompt.type === 'select' && prompt.options.some(option => option.id === method)) {
                return Promise.resolve(method)
              }
              if (prompt.type === 'manual_code' && method === 'browser') return waitForCallback(prompt, session.signal)
              return Promise.reject(new AuthorizationDeclinedError())
            },
          })
        },
      })
      try {
        await ctx.authorization.begin({ key: binding.credentialKey, method, signal,
          interaction: { notify: () => {}, prompt: () => Promise.reject(new AuthorizationDeclinedError()) } })
      } finally {
        unregister()
      }
    },
    inspect: (binding, signal) => inspect(ctx, binding, signal),
    createAdapter(binding) {
      const turns = new CodexTurnState()
      const stopEvents = ctx.on('session/event', (session, event) => {
        if (event.type === 'turn/end') turns.end(session.id, event.data.turn)
      })
      const stopDisposals = ctx.on('session/disposed', (session) => { turns.release(session.id) })
      const adapter = new CodexAccountAdapter(binding, accountCredentialStore(ctx.credentials, binding), turns)
      return { adapter, dispose: () => { turns.dispose(); stopEvents(); stopDisposals() } }
    },
  }
  ctx.effect(() => ctx.sakiModelAccounts.register(provider))
}

/** Inspect one protected account; provider/credential exceptions never become product text. */
async function inspect(ctx: Context, binding: ModelAccountBinding, signal: AbortSignal): Promise<ModelAccountSnapshot> {
  const observedAt = Date.now()
  const missing: ModelAccountSnapshot = {
    authentication: 'missing', health: 'unknown', entitlement: 'unknown', identity: null,
    protectionLevel: null, observedAt,
    usage: { state: 'temporarily-unavailable', observedAt, source: 'dsh-codex-subscription@2.1.2' },
    models: [],
  }
  try {
    const store = accountCredentialStore(ctx.credentials, binding)
    const stored = await store.read(binding.routeId, { signal })
    if (stored === undefined || stored.type !== 'oauth') return missing
    const models = createModels({ credentials: store, authContext: {
      env: () => Promise.resolve(undefined), fileExists: () => Promise.resolve(false),
    } })
    const piProvider = accountProvider(binding)
    models.setProvider(piProvider)
    const auth = await models.getAuth(binding.routeId, { signal })
    if (auth === undefined) return { ...missing, authentication: 'reauthorization-required' }
    const current = await store.read(binding.routeId, { signal })
    if (current === undefined || current.type !== 'oauth') return missing
    const identity = codexAccountIdentity(current)
    const credential: OAuthCredential = { ...current, accountId: identity }
    const usage = await readUsage(auth, credential, codexConfigurationSchema.parse(binding.configuration).usageTimeoutMs, signal)
    const turns = new CodexTurnState()
    const adapter = new CodexAccountAdapter(binding, store, turns)
    const catalog = await Promise.all(piProvider.getModels().map(async (model) => {
      const info = await adapter.resolveModel(binding.routeId, model.id, signal)
      return { provider: binding.routeId, id: model.id, name: model.name, inputModalities: ['text'] as const,
        ...(info.context === undefined ? {} : { context: info.context }),
        ...(info.reasoning === undefined ? {} : { reasoning: info.reasoning }),
        ...(info.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: info.defaultMaxTokens }),
      }
    }))
    turns.dispose()
    signal.throwIfAborted()
    return {
      authentication: 'authorized', health: 'unknown', entitlement: 'unknown', identity,
      protectionLevel: binding.requiredProtection, observedAt: Date.now(), usage,
      models: catalog,
    }
  } catch {
    // Credential, refresh and provider failures can contain tokens; only fixed observation states are returned.
    signal.throwIfAborted()
    return { ...missing, authentication: 'reauthorization-required', health: 'unavailable' }
  }
}
