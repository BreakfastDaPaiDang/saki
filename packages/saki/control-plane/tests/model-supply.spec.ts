import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { CREDENTIAL_PROTECTION_LOCAL_USER_TRUST } from '@deepseek-ai/dsh-credentials'
import ModelAccountService, { modelAccountProviderId } from '@breakfastdapaidang/saki-model-account'
import type { ModelAccountBinding, ModelAccountIdentity, ModelAccountProvider, ModelAccountSnapshot } from '@breakfastdapaidang/saki-model-account'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelSupply } from '../src/model-supply.ts'
import { modelAccountIntentSchema } from '../src/model-supply-spec.ts'
import type { ModelAccountIntentRecord, ModelAccountRecord } from '../src/model-supply-spec.ts'
import { controlIntentActorSchema } from '../src/spec.ts'
import { validateModelSupplyRecords } from '../src/model-supply-validation.ts'

class MemoryTable<K extends string, V> implements KvTable<K, V> {
  readonly records = new Map<K, V>()
  get size(): number { return this.records.size }
  get(key: K): V | undefined { return this.records.get(key) }
  entries(): IterableIterator<[K, V]> { return new Map(this.records).entries() }
  keys(): IterableIterator<K> { return new Map(this.records).keys() }
  async put(key: K, value: V): Promise<void> { this.records.set(key, structuredClone(value)) }
  async delete(key: K): Promise<boolean> { return this.records.delete(key) }
  async update(key: K, update: (current: V) => V): Promise<V> {
    const current = this.records.get(key)
    if (current === undefined) throw new Error('missing record')
    const next = update(current)
    await this.put(key, next)
    return next
  }
}

class FixtureAdapter extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { throw new Error('not used by inventory tests') }
}

const uuid = '00000000-0000-4000-8000-000000000001'
const actor = controlIntentActorSchema.parse({
  installationId: `installation-${uuid}`, storageGenerationId: `storage-generation-${uuid}`,
  hostId: `host-${uuid}`, principalId: `principal-${uuid}`, principalRevision: 1,
  grantId: `grant-${uuid}`, grantRevision: 1,
})
const request = modelAccountIntentSchema.parse({ type: 'authorize-model-account', intentId: `intent-${uuid}`,
  providerId: 'fixture', name: 'Account', method: 'device_code', configuration: {} })
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

async function setup() {
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(ModelAccountService)
  const profiles = new MemoryTable<ModelAccountRecord['id'], ModelAccountRecord>()
  const intents = new MemoryTable<ModelAccountIntentRecord['id'], ModelAccountIntentRecord>()
  const records = new Set<string>()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const changed = new Set<() => void>()
  let authorized = true
  const observed = (binding: ModelAccountBinding): ModelAccountSnapshot => ({
    authentication: records.has(binding.credentialKey) ? 'authorized' : 'missing', health: 'unknown', entitlement: 'unknown',
    identity: records.has(binding.credentialKey) ? brandString<ModelAccountIdentity>('fixture-account') : null,
    protectionLevel: CREDENTIAL_PROTECTION_LOCAL_USER_TRUST, observedAt: 1,
    usage: { state: 'unsupported', source: 'fixture', observedAt: 1 }, models: [],
  })
  const login = vi.fn(async (binding: ModelAccountBinding, _method: string, _progress: unknown, signal: AbortSignal) => {
    entered.resolve(undefined)
    await Promise.race([release.promise, new Promise<void>((resolve) => {
      if (signal.aborted) resolve()
      else signal.addEventListener('abort', () => { resolve() }, { once: true })
    })])
    signal.throwIfAborted()
    records.add(binding.credentialKey)
  })
  const provider: ModelAccountProvider = {
    id: modelAccountProviderId('fixture'), implementation: { name: 'fixture', version: '1' },
    methods: [{ id: 'device_code', kind: 'device-code' }], resolveConfiguration: value => ({ ...value }),
    authorize: login, inspect: vi.fn((binding: ModelAccountBinding) => Promise.resolve(observed(binding))),
    createAdapter: () => ({ adapter: new FixtureAdapter(), dispose: () => {} }),
  }
  const unregister = ctx.sakiModelAccounts.register(provider)
  const lifetime = new AbortController()
  const supply = new ModelSupply({ profiles, intents, accounts: () => ctx.sakiModelAccounts,
    credentials: () => undefined, authorityCurrent: () => authorized, lifetime: lifetime.signal,
    notifyChanged: () => { for (const listener of changed) listener() },
  })
  cleanups.push(async () => { lifetime.abort(); release.resolve(undefined); await supply.dispose() })
  const terminal = (): Promise<void> => new Promise((resolve) => {
    const check = (): void => {
      const state = intents.get(request.intentId)?.state
      if (state !== undefined && state !== 'accepted' && state !== 'authorizing') { changed.delete(check); resolve() }
    }
    changed.add(check)
    check()
  })
  return { supply, profiles, intents, records, entered, release, login, terminal, provider, unregister,
    accounts: ctx.sakiModelAccounts, revoke: () => { authorized = false } }
}

describe('durable account authorization', () => {
  it('coalesces concurrent exact submissions into one login and one Profile', async () => {
    const h = await setup()
    const signal = new AbortController().signal
    const receipts = await Promise.all([h.supply.submit(request, actor, signal), h.supply.submit(request, actor, signal)])
    expect(receipts.every(result => result.ok)).toBe(true)
    await h.entered.promise
    h.release.resolve(undefined)
    await h.terminal()
    expect(h.login).toHaveBeenCalledTimes(1)
    expect(h.profiles.size).toBe(1)
    expect(h.supply.projection().profiles[0]).toMatchObject({ connected: true, desiredActive: false, effectiveActive: false })
    expect(JSON.stringify(h.supply.projection())).not.toContain('credentialKey')
  })

  it('rejects changed replay payloads without replacing the accepted authorization', async () => {
    const h = await setup()
    const signal = new AbortController().signal
    await h.supply.submit(request, actor, signal)
    expect(await h.supply.submit({ ...request, name: 'Different' } as typeof request, actor, signal))
      .toEqual({ ok: false, reason: 'conflict' })
    expect(h.intents.size).toBe(1)
  })

  it('cancels the owned login independently of the admitting browser request', async () => {
    const h = await setup()
    const admission = new AbortController()
    await h.supply.submit(request, actor, admission.signal)
    await h.entered.promise
    admission.abort()
    expect(h.intents.get(request.intentId)?.state).toBe('authorizing')
    const cancel = modelAccountIntentSchema.parse({ type: 'cancel-model-authorization',
      intentId: 'intent-00000000-0000-4000-8000-000000000002', authorizationIntentId: request.intentId })
    await h.supply.submit(cancel, actor, new AbortController().signal)
    await h.terminal()
    expect(h.intents.get(request.intentId)?.state).toBe('cancelled')
    expect(h.profiles.size).toBe(0)
  })

  it('does not publish an account after its admitting authority is revoked', async () => {
    const h = await setup()
    await h.supply.submit(request, actor, new AbortController().signal)
    await h.entered.promise
    h.revoke()
    h.release.resolve(undefined)
    await h.terminal()
    expect(h.intents.get(request.intentId)?.state).toBe('interrupted')
    expect(h.profiles.size).toBe(0)
  })

  it.each(['authorizing', 'cancelled'] as const)('recovers a committed credential after %s without repeating authorization', async (state) => {
    const h = await setup()
    await h.supply.submit(request, actor, new AbortController().signal)
    await h.entered.promise
    const accepted = { ...h.intents.get(request.intentId)!, state }
    h.records.add(accepted.binding!.credentialKey)
    await h.supply.dispose()
    await h.intents.put(accepted.id, accepted)
    const recovered = new ModelSupply({ profiles: h.profiles, intents: h.intents,
      accounts: () => h.accounts, credentials: () => undefined, authorityCurrent: () => true,
      lifetime: new AbortController().signal, notifyChanged: () => {} })
    cleanups.push(() => recovered.dispose())
    await recovered.recover()
    expect(h.login).toHaveBeenCalledTimes(1)
    expect(h.profiles.size).toBe(1)
    expect(h.intents.get(request.intentId)?.state).toBe('completed')
    expect(() => validateModelSupplyRecords(h.profiles, h.intents, () => {})).not.toThrow()
  })

  it('keeps recovered interrupted login separate from an authorized account', async () => {
    const h = await setup()
    await h.supply.submit(request, actor, new AbortController().signal)
    await h.entered.promise
    const accepted = h.intents.get(request.intentId)!
    await h.supply.dispose()
    await h.intents.put(accepted.id, accepted)
    const recovered = new ModelSupply({ profiles: h.profiles, intents: h.intents,
      accounts: () => h.accounts, credentials: () => undefined, authorityCurrent: () => true,
      lifetime: new AbortController().signal, notifyChanged: () => {} })
    cleanups.push(() => recovered.dispose())
    await recovered.recover()
    expect(h.intents.get(request.intentId)?.state).toBe('interrupted')
    expect(h.profiles.size).toBe(0)
    expect(h.login).toHaveBeenCalledTimes(1)
  })

  it('withdraws an active route when its Provider disappears', async () => {
    const h = await setup()
    const signal = new AbortController().signal
    await h.supply.submit(request, actor, signal)
    h.release.resolve(undefined)
    await h.terminal()
    const profile = h.supply.projection().profiles[0]!
    await h.supply.submit(modelAccountIntentSchema.parse({ type: 'set-model-account-active',
      intentId: 'intent-00000000-0000-4000-8000-000000000003', profileId: profile.id,
      expectedRevision: profile.revision, active: true }), actor, signal)
    expect(h.supply.projection().profiles[0]?.effectiveActive).toBe(true)
    await h.unregister()
    expect(h.supply.projection().profiles[0]).toMatchObject({ desiredActive: true, effectiveActive: false })
    await h.supply.submit(modelAccountIntentSchema.parse({ type: 'set-model-account-active',
      intentId: 'intent-00000000-0000-4000-8000-000000000004', profileId: profile.id,
      expectedRevision: profile.revision + 1, active: false }), actor, signal)
    expect(h.supply.projection().profiles[0]).toMatchObject({ desiredActive: false, effectiveActive: false })
  })

  it('refuses completion under a replacement Provider implementation', async () => {
    const h = await setup()
    await h.supply.submit(request, actor, new AbortController().signal)
    await h.entered.promise
    await h.unregister()
    h.accounts.register({ ...h.provider, implementation: { name: 'replacement', version: '2' } })
    h.release.resolve(undefined)
    await h.terminal()
    expect(h.profiles.size).toBe(0)
    expect(h.intents.get(request.intentId)?.state).toBe('interrupted')
  })

  it('does not inspect existing credentials through a replacement Provider', async () => {
    const h = await setup()
    const signal = new AbortController().signal
    await h.supply.submit(request, actor, signal)
    h.release.resolve(undefined)
    await h.terminal()
    const profile = h.supply.projection().profiles[0]!
    await h.unregister()
    const inspect = vi.fn<ModelAccountProvider['inspect']>((binding, signal) => h.provider.inspect(binding, signal))
    h.accounts.register({ ...h.provider, inspect, implementation: { name: 'replacement', version: '2' } })
    const result = await h.supply.submit(modelAccountIntentSchema.parse({ type: 'refresh-model-account',
      intentId: 'intent-00000000-0000-4000-8000-000000000003', profileId: profile.id,
      expectedRevision: profile.revision }), actor, signal)
    expect(result).toMatchObject({ ok: true, receipt: { state: 'failed' } })
    expect(inspect).not.toHaveBeenCalled()
  })

  it('rejects a foreign credential address in durable authorization records', async () => {
    const h = await setup()
    await h.supply.submit(request, actor, new AbortController().signal)
    await h.entered.promise
    const record = h.intents.get(request.intentId)!
    if (record.binding === null) throw new Error('missing fixture binding')
    const foreign = { ...record, binding: { ...record.binding,
      credentialKey: brandString<ModelAccountBinding['credentialKey']>('other:record') } }
    await h.intents.put(record.id, foreign)
    expect(() => validateModelSupplyRecords(h.profiles, h.intents, () => {})).toThrow('foreign credential address')
  })

  it('retains a confirmed exhausted allowance when refresh becomes unavailable', async () => {
    const h = await setup()
    const signal = new AbortController().signal
    await h.supply.submit(request, actor, signal)
    h.release.resolve(undefined)
    await h.terminal()
    const profile = [...h.profiles.entries()][0]![1]
    const snapshot = await h.provider.inspect(profile.binding, signal)
    const usage = { state: 'available' as const, observedAt: 10, source: 'fixture', windows: [
      { id: 'main', unit: 'percent' as const, remaining: 0, limit: 100, resetsAt: null, blocksRequests: true },
    ] }
    vi.spyOn(h.provider, 'inspect').mockResolvedValue({ ...snapshot, usage })
    await h.supply.submit(modelAccountIntentSchema.parse({ type: 'refresh-model-account',
      intentId: 'intent-00000000-0000-4000-8000-000000000003', profileId: profile.id,
      expectedRevision: profile.revision }), actor, signal)
    await h.supply.submit(modelAccountIntentSchema.parse({ type: 'set-model-account-active',
      intentId: 'intent-00000000-0000-4000-8000-000000000004', profileId: profile.id,
      expectedRevision: profile.revision, active: true }), actor, signal)
    expect(h.supply.projection().profiles[0]).toMatchObject({ desiredActive: true, effectiveActive: false })
    vi.spyOn(h.provider, 'inspect').mockResolvedValue({ ...snapshot,
      usage: { state: 'temporarily-unavailable', source: 'fixture', observedAt: 11 } })
    await h.supply.submit(modelAccountIntentSchema.parse({ type: 'refresh-model-account',
      intentId: 'intent-00000000-0000-4000-8000-000000000005', profileId: profile.id,
      expectedRevision: profile.revision + 1 }), actor, signal)
    expect(h.supply.projection().profiles[0]).toMatchObject({ lastConfirmedUsage: usage, effectiveActive: false,
      snapshot: { usage: { state: 'temporarily-unavailable' } } })
  })
})
