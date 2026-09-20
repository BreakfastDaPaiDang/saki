import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Llm, { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { CredentialProvider, credentialRef, credentialKey, CREDENTIAL_PROTECTION_LOCAL_USER_TRUST,
  CREDENTIAL_PROTECTION_PLAINTEXT } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialRecord, CredentialRef, CredentialProtectionLevel } from '@deepseek-ai/dsh-credentials'
import Accounts, { modelAccountProfileId, modelAccountProviderId, modelAccountRouteId } from '@breakfastdapaidang/saki-model-account'
import type { ModelAccountBinding } from '@breakfastdapaidang/saki-model-account'
import { afterEach, expect, it, vi } from 'vitest'
import * as Api from '../src/index.ts'

/** In-memory protection observations for adapter contract tests, never a production store. */
class FixtureCredentials extends CredentialProvider {
  readonly refs = new Map<CredentialRef, string>()
  readonly records = new Map<CredentialKey, CredentialRecord>()
  protection = CREDENTIAL_PROTECTION_LOCAL_USER_TRUST
  override async resolve(ref: CredentialRef) {
    const value = this.refs.get(ref)
    return value === undefined ? undefined : { value, source: 'fixture', protectionLevel: this.protection }
  }
  override async describe(): Promise<never> { throw new Error('Unused credential description') }
  override async set(ref: CredentialRef, value: string) { this.refs.set(ref, value) }
  override async unset(ref: CredentialRef) { this.refs.delete(ref) }
  override async readRecord(key: CredentialKey) { return this.records.get(key) }
  override async describeRecord(key: CredentialKey) {
    return { configured: this.records.has(key), writable: true, protectionLevel: this.protection }
  }
  override async listRecords() { return [...this.records].map(([key, record]) => ({ key, kind: record.kind })) }
  override async modifyRecord(key: CredentialKey, mutate: (value: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
    const next = await mutate(this.records.get(key))
    if (next !== undefined) this.records.set(key, next)
    return this.records.get(key)
  }
  override async deleteRecord(key: CredentialKey) { this.records.delete(key) }
  override readRecordProtected(key: CredentialKey, required: CredentialProtectionLevel) {
    if (required !== this.protection) throw new Error('Fixture protection mismatch')
    return this.readRecord(key)
  }
  override modifyRecordProtected(key: CredentialKey, required: CredentialProtectionLevel,
    mutate: (value: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
    if (required !== this.protection) throw new Error('Fixture protection mismatch')
    return this.modifyRecord(key, mutate)
  }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  while (cleanups.length) await cleanups.pop()!()
})

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'saki-api-account-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(Llm)
  await ctx.plugin(FixtureCredentials)
  await ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.json'), watch: false })
  await ctx.plugin(PiAi, { providers: { relay: { apiKeyEnv: 'FIXTURE_KEY', displayName: 'Relay',
    api: 'openai-completions', baseURL: 'https://relay.invalid/v1', models: [{ id: 'fixture-model', contextWindow: 4096, maxTokens: 128 }] } } })
  await ctx.plugin(Accounts)
  const apiFiber = await ctx.plugin(Api)
  const provider = ctx.sakiModelAccounts.get(modelAccountProviderId('api'))
  if (provider === undefined) throw new Error('API Provider missing')
  const profileId = modelAccountProfileId('00000000-0000-4000-8000-000000000001')
  const binding: ModelAccountBinding = { profileId, providerId: provider.id, routeId: modelAccountRouteId(profileId, 1), revision: 1,
    credentialKey: credentialKey('saki-model-account-api', 'fixture'), accountIdentity: null,
    requiredProtection: CREDENTIAL_PROTECTION_LOCAL_USER_TRUST, configuration: provider.resolveConfiguration({ connection: 'relay' }) }
  await ctx.credentials.set(credentialRef('FIXTURE_KEY'), 'fixture-original')
  return { ctx, provider, binding, apiFiber, signal: new AbortController().signal }
}

it('captures the configured endpoint and protected key independently of later settings changes', async () => {
  const h = await setup()
  expect(h.provider.methods).toEqual([{ id: 'relay', name: 'Relay', kind: 'stored-credential' }])
  await h.provider.authorize(h.binding, 'relay', () => {}, h.signal)
  const snapshot = await h.provider.inspect(h.binding, h.signal)
  expect(snapshot).toMatchObject({ authentication: 'authorized', health: 'unknown', entitlement: 'unknown', usage: { state: 'unsupported' } })
  expect(snapshot.models.map(model => model.id)).toEqual(['fixture-model'])
  expect(JSON.stringify(snapshot)).not.toContain('fixture-original')
  await h.ctx.credentials.set(credentialRef('FIXTURE_KEY'), 'fixture-replacement')
  await h.ctx.settings.update('llm-pi-ai', { providers: { relay: { baseURL: 'https://changed.invalid/v1' } } })
  const dispose = await h.ctx.sakiModelAccounts.activate({ ...h.binding, accountIdentity: snapshot.identity }, h.signal)
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    expect(input instanceof Request ? input.url : input.toString()).toBe('https://relay.invalid/v1/chat/completions')
    expect(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get('authorization')).toBe('Bearer fixture-original')
    return new Response('data: {"id":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}\n\ndata: {"id":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  })
  const result = new BlockAssembler()
  for await (const chunk of h.ctx.llm.stream({ provider: h.binding.routeId, model: 'fixture-model', signal: h.signal,
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Reply OK' }], source: { kind: 'plugin', plugin: 'fixture' } })] })) result.push(chunk)
  expect(result.finish.kind).toBe('stop')
  expect(result.blocks()).toContainEqual({ type: 'text', text: 'OK' })
  expect(fetch).toHaveBeenCalledTimes(1)
  await dispose()
  expect(h.ctx.sakiModelAccounts.isActive(h.binding.routeId)).toBe(false)
})

it('rejects a plaintext source before copying a credential', async () => {
  const h = await setup()
  vi.spyOn(h.ctx.credentials, 'resolve').mockResolvedValue({ value: 'fixture-unprotected', source: 'fixture',
    protectionLevel: CREDENTIAL_PROTECTION_PLAINTEXT })
  await expect(h.provider.authorize(h.binding, 'relay', () => {}, h.signal)).rejects.toThrow('protection')
  expect(await h.ctx.credentials.readRecord(h.binding.credentialKey)).toBeUndefined()
})

it('keeps missing credentials and mismatched import methods unavailable', async () => {
  const h = await setup()
  expect(await h.provider.inspect(h.binding, h.signal)).toMatchObject({ authentication: 'missing' })
  await expect(h.provider.authorize(h.binding, 'another-connection', () => {}, h.signal)).rejects.toThrow('does not match')
  await expect(h.ctx.sakiModelAccounts.activate(h.binding, h.signal)).rejects.toThrow('not eligible')
})

it('retains a captured route after its source connection is removed and the Provider restarts', async () => {
  const h = await setup()
  await h.provider.authorize(h.binding, 'relay', () => {}, h.signal)
  const first = await h.provider.inspect(h.binding, h.signal)
  const persisted = JSON.parse(JSON.stringify({ ...h.binding, accountIdentity: first.identity })) as ModelAccountBinding
  await h.ctx.settings.replace('llm-pi-ai', { providers: {} })
  expect(await h.provider.inspect(persisted, h.signal)).toEqual(expect.objectContaining({
    identity: first.identity, authentication: 'authorized', models: first.models,
  }))
  await h.apiFiber.dispose()
  await h.ctx.plugin(Api)
  const next = h.ctx.sakiModelAccounts.get(modelAccountProviderId('api'))
  expect(await next?.inspect(persisted, h.signal)).toMatchObject({ identity: first.identity, authentication: 'authorized' })
})

it('uses DSH discovery without replacing confirmed manual models when the endpoint fails', async () => {
  const h = await setup()
  const before = h.provider.resolveConfiguration({ connection: 'relay' })
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ data: [{ id: 'discovered-model' }] }))
  const request = { baseURL: 'https://relay.invalid/v1', api: 'openai-completions', apiKey: 'fixture-discovery' }
  expect(await h.ctx.llm.discoverModels('llm-pi-ai', request, h.signal)).toEqual([{ id: 'discovered-model', name: 'discovered-model' }])
  fetch.mockResolvedValueOnce(new Response('', { status: 503 }))
  await expect(h.ctx.llm.discoverModels('llm-pi-ai', request, h.signal)).rejects.toThrow()
  expect(h.provider.resolveConfiguration({ connection: 'relay' })).toEqual(before)
})

it('does not expose credential-bearing provider failures in stream results', async () => {
  const h = await setup()
  await h.provider.authorize(h.binding, 'relay', () => {}, h.signal)
  await h.ctx.sakiModelAccounts.activate(h.binding, h.signal)
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: {
    message: 'Invalid key fixture-original', type: 'authentication_error', code: 'invalid_api_key',
  } }, { status: 401 }))
  const result = new BlockAssembler()
  for await (const chunk of h.ctx.llm.stream({ provider: h.binding.routeId, model: 'fixture-model', signal: h.signal,
    messages: [createUserMessage({ content: [{ type: 'text', text: 'Reply OK' }], source: { kind: 'plugin', plugin: 'fixture' } })] })) result.push(chunk)
  expect(result.finish.kind).toBe('error')
  expect(JSON.stringify(result.finish)).not.toContain('fixture-original')
})

it.each([
  { headers: { authorization: 'Bearer fixture-secret' } },
  { baseURL: 'https://relay.invalid/v1?api_key=fixture-secret' },
  { defaultInput: ['text', 'image'] },
])('refuses connection facts that cannot be imported: %j', async (patch) => {
  const h = await setup()
  await h.ctx.settings.update('llm-pi-ai', { providers: { relay: patch } })
  expect(() => h.provider.resolveConfiguration({ connection: 'relay' })).toThrow()
})
