import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Llm from '@deepseek-ai/dsh-llm'
import Sessions from '@deepseek-ai/dsh-session'
import Authorization from '@deepseek-ai/dsh-authorization'
import { credentialKey, CREDENTIAL_PROTECTION_LOCAL_USER_TRUST } from '@deepseek-ai/dsh-credentials'
import ModelAccounts, { modelAccountProfileId, modelAccountProviderId, modelAccountRouteId } from '@breakfastdapaidang/saki-model-account'
import type { ModelAccountBinding, ModelAccountAuthorizationProgress } from '@breakfastdapaidang/saki-model-account'
import * as Codex from '@breakfastdapaidang/saki-model-account-codex'
import { afterEach, describe, expect, it, vi } from 'vitest'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  while (cleanups.length) await cleanups.pop()!()
})

function token(account: string): string {
  return `fixture.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url')}.fixture`
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'saki-account-codex-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  const { default: Dpapi } = await import('@deepseek-ai/dsh-credentials-windows-dpapi')
  const path = join(root, 'credentials.json')
  await ctx.plugin(Dpapi, { path })
  await ctx.plugin(Llm)
  await ctx.plugin(Sessions)
  await ctx.plugin(Authorization)
  await ctx.plugin(ModelAccounts)
  await ctx.plugin(Codex)
  const provider = ctx.sakiModelAccounts.get(modelAccountProviderId('codex'))
  if (provider === undefined) throw new Error('Codex Provider did not register')
  const profileId = modelAccountProfileId('00000000-0000-4000-8000-000000000001')
  const binding: ModelAccountBinding = {
    profileId, providerId: provider.id, revision: 1, routeId: modelAccountRouteId(profileId, 1),
    accountIdentity: null, credentialKey: credentialKey('saki-model-account-codex', 'fixture'),
    requiredProtection: CREDENTIAL_PROTECTION_LOCAL_USER_TRUST, configuration: provider.resolveConfiguration({}),
  }
  return { ctx, path, provider, binding }
}

describe.skipIf(process.platform !== 'win32')('Codex authorization with protected Host records', () => {
  it('runs maintained device login, reloads the encrypted grant, and refreshes once across concurrent inspections', async () => {
    const h = await setup()
    const access = token('fixture-account')
    const refreshRequests: URLSearchParams[] = []
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = (input instanceof Request ? input.url : input.toString())
      if (url === 'https://auth.openai.com/api/accounts/deviceauth/usercode') {
        return Response.json({ device_auth_id: 'fixture-device', user_code: 'fixture-code', interval: 0 })
      }
      if (url === 'https://auth.openai.com/api/accounts/deviceauth/token') {
        return Response.json({ authorization_code: 'fixture-authorization', code_verifier: 'fixture-verifier' })
      }
      if (url === 'https://auth.openai.com/oauth/token') {
        const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : '')
        if (body.get('grant_type') === 'refresh_token') refreshRequests.push(body)
        return Response.json({ access_token: access, refresh_token: 'fixture-refresh', expires_in: 3600 })
      }
      if (url === 'https://chatgpt.com/backend-api/wham/usage') {
        expect(new Headers(init?.headers).get('chatgpt-account-id')).toBe('fixture-account')
        return Response.json({ rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18000 } } })
      }
      throw new Error('Unexpected fixture endpoint')
    })
    try {
      const progress: ModelAccountAuthorizationProgress[] = []
      const signal = new AbortController().signal
      await h.provider.authorize(h.binding, 'device_code', (event) => { progress.push(event) }, signal)
      expect(progress).toContainEqual(expect.objectContaining({ kind: 'device-code', userCode: 'fixture-code' }))
      expect(await readFile(h.path, 'utf8')).not.toMatch(/fixture-refresh|fixture-account/)
      const snapshot = await h.provider.inspect(h.binding, signal)
      expect(snapshot).toMatchObject({ authentication: 'authorized', identity: 'fixture-account', health: 'unknown',
        usage: { state: 'available', windows: [expect.objectContaining({ remaining: 80 })] } })
      expect(snapshot.models.length).toBeGreaterThan(0)
      await h.ctx.credentials.modifyRecordProtected(h.binding.credentialKey, h.binding.requiredProtection,
        async () => ({ kind: 'grant', payload: { type: 'oauth', access, refresh: 'fixture-refresh', expires: 1 } }))
      const results = await Promise.all([h.provider.inspect(h.binding, signal), h.provider.inspect(h.binding, signal)])
      expect(results.map(result => result.authentication)).toEqual(['authorized', 'authorized'])
      expect(refreshRequests).toHaveLength(1)
      expect(refreshRequests[0]?.get('refresh_token')).toBe('fixture-refresh')
      expect(JSON.stringify(results)).not.toContain('fixture-refresh')
    } finally { fetch.mockRestore() }
  })
})
