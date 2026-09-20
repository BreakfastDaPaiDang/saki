/** Account-bound composition of the published DSH and pi-ai adapters. @module @breakfastdapaidang/saki-model-account-codex/adapter */

import { z } from 'zod'
import { LlmAdapter, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { CredentialStore, Model, Provider } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import type { ModelAccountBinding } from '@breakfastdapaidang/saki-model-account'
import type { CodexTurnState } from './turn-state.ts'

/** Deployment fields admitted to one immutable Codex Profile revision. */
export const codexConfigurationSchema = z.object({
  baseURL: z.url().refine((value) => {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.username === '' && url.password === ''
      && url.search === '' && url.hash === ''
  }).default('https://chatgpt.com/backend-api'),
  models: z.array(z.string().min(1)).min(1).optional(),
  streamIdleTimeoutMs: z.number().int().min(1).max(2_147_483_647).default(300_000),
  timeoutMs: z.number().int().min(1).max(2_147_483_647).default(120_000),
  usageTimeoutMs: z.number().int().min(1).max(2_147_483_647).default(15_000),
}).strict()

/**
 * Resolve the selected maintained catalog without claiming endpoint entitlement.
 * @param binding - exact Profile configuration revision.
 * @returns pi Provider with an account-specific registry identity.
 */
export function accountProvider(binding: ModelAccountBinding): Provider<'openai-codex-responses'> {
  const config = codexConfigurationSchema.parse(binding.configuration)
  const base = openaiCodexProvider()
  const catalog = base.getModels()
  const selected = config.models === undefined ? catalog : config.models.map((id) => {
    const model = catalog.find(item => item.id === id)
    if (model === undefined) throw new LlmError('Codex model is absent from the selected catalog', 'UNKNOWN_MODEL')
    return model
  })
  const models: Model<'openai-codex-responses'>[] = selected.map(model => ({
    ...model, provider: binding.routeId, baseUrl: config.baseURL, input: ['text'],
  }))
  return {
    id: binding.routeId,
    name: 'Codex',
    auth: base.auth,
    getModels: () => models,
    stream: (model, context, options) => base.stream(model, context, options),
    streamSimple: (model, context, options) => base.streamSimple(model, context, options),
  }
}

/** One route owns metadata, credentials and turn state across its short-lived request adapters. */
export class CodexAccountAdapter extends LlmAdapter {
  private readonly provider: Provider<'openai-codex-responses'>
  private readonly profile: ResolvedPiAiProviderProfile
  private readonly metadata: PiAiAdapter

  constructor(
    private readonly binding: ModelAccountBinding,
    private readonly credentials: CredentialStore,
    private readonly turns: CodexTurnState,
  ) {
    super()
    const config = codexConfigurationSchema.parse(binding.configuration)
    this.provider = accountProvider(binding)
    this.profile = {
      provider: binding.routeId, displayName: 'Codex', piProvider: this.provider,
      streamIdleTimeoutMs: config.streamIdleTimeoutMs,
      timeoutMs: config.timeoutMs,
      // This text-only route does not project attachments. Image routing has a separate product owner.
      maxRequestImageBytes: 1, requestImageMaxBytes: 1, requestImagePixelBudget: 1,
      retryPolicy: resolveRetryPolicy(undefined, 'saki-model-account-codex.retryPolicy'),
      configuredMaxTokens: new Map(), modelErrors: new Map(), transport: 'sse',
    }
    this.metadata = this.adapter(this.provider)
  }

  override providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: 'Codex' }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return this.metadata.listModels(provider)
  }

  override resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return this.metadata.resolveModel(provider, model, signal)
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const hooks = this.turns.prepare(options)
    const base = this.provider
    const bound: Provider<'openai-codex-responses'> = {
      ...base,
      stream: (model, context, input) => base.stream(model, context, Object.assign({}, input, hooks)),
      streamSimple: (model, context, input) => base.streamSimple(model, context, { ...input, ...hooks }),
    }
    return this.safeStream(this.adapter(bound).stream(options), options.signal)
  }

  private adapter(provider: Provider): PiAiAdapter {
    const profiles = new Map([[this.binding.routeId, { ...this.profile, piProvider: provider }]])
    return new PiAiAdapter({
      profiles: () => profiles,
      resolveApiKey: () => Promise.resolve(undefined),
      auth: { credentials: this.credentials, authContext: {
        env: () => Promise.resolve(undefined), fileExists: () => Promise.resolve(false),
      } },
    })
  }

  private async * safeStream(chunks: AsyncIterable<StreamChunk>, signal?: AbortSignal): AsyncIterable<StreamChunk> {
    try {
      for await (const chunk of chunks) {
        if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
          yield { ...chunk, reason: { ...chunk.reason, failure: {
            ...chunk.reason.failure, message: 'Codex model request failed',
          } } }
        } else yield chunk
      }
    } catch {
      // Provider and credential exceptions can contain response bodies; cancellation keeps its own signal.
      signal?.throwIfAborted()
      throw new LlmError('Codex model request is unavailable', 'ACCOUNT_UNAVAILABLE')
    }
  }
}
