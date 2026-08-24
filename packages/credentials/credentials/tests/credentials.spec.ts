import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  CREDENTIAL_PROTECTION_EPHEMERAL,
  CREDENTIAL_PROTECTION_LOCAL_USER_TRUST,
  credentialProtectionLevel,
  credentialRef,
  isCredentialKeySegment,
} from '../src/index.ts'
import type { CredentialRef } from '../src/index.ts'
import { MemoryCredentials } from './memory.ts'

const REF = credentialRef('DEEPSEEK_API_KEY')

async function boot(seed: Record<string, string> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials, seed)
  return ctx
}

describe('credentialRef', () => {
  it('brands POSIX shell identifiers', () => {
    expect(credentialRef('DEEPSEEK_API_KEY')).toBe('DEEPSEEK_API_KEY')
    expect(credentialRef('_private')).toBe('_private')
    expect(credentialRef('lower_case9')).toBe('lower_case9')
  })

  it('rejects every other shape', () => {
    for (const invalid of ['', '9LEADING', 'WITH-DASH', 'WITH SPACE', 'ns:key']) {
      expect(() => credentialRef(invalid)).toThrow(TypeError)
    }
  })
})

describe('isCredentialKeySegment', () => {
  it('answers whether credentialKey would accept the segment', () => {
    for (const valid of ['llm-pi-ai', 'openai-codex', 'a', 'z9']) {
      expect(isCredentialKeySegment(valid)).toBe(true)
    }
    // The shapes an arbitrary settings dict key can take that a record id
    // cannot: a consumer asks here instead of learning it from a throw.
    for (const invalid of ['', 'My_Proxy', 'z.ai', 'UPPER', '9leading', 'a/b']) {
      expect(isCredentialKeySegment(invalid)).toBe(false)
    }
  })
})

describe('credentialProtectionLevel', () => {
  it('accepts descriptive identifiers and rejects every other shape', () => {
    expect(credentialProtectionLevel('external-secret-manager')).toBe('external-secret-manager')
    for (const invalid of ['', 'LOCAL_USER', 'local_user', '-local', 'local-']) {
      expect(() => credentialProtectionLevel(invalid)).toThrow(TypeError)
    }
  })
})

describe('the credentials seam through the memory provider', () => {
  it('requires the resolved value to carry the requested protection level', async () => {
    const ctx = await boot({ DEEPSEEK_API_KEY: 'sk-seeded' })

    await expect(ctx.credentials.resolveRequired(REF, CREDENTIAL_PROTECTION_EPHEMERAL)).resolves.toEqual({
      value: 'sk-seeded',
      source: 'memory',
      protectionLevel: CREDENTIAL_PROTECTION_EPHEMERAL,
    })
    await expect(ctx.credentials.resolveRequired(REF, CREDENTIAL_PROTECTION_LOCAL_USER_TRUST))
      .rejects.toThrow(/requires protection level "local-user-trust".*reported "ephemeral"/)
  })

  it('fails a protection requirement for a missing value', async () => {
    const ctx = await boot()
    await expect(ctx.credentials.resolveRequired(REF, CREDENTIAL_PROTECTION_LOCAL_USER_TRUST))
      .rejects.toThrow(/is not configured/)
  })

  it('mounts as ctx.credentials and resolves a seeded reference with its source', async () => {
    const ctx = await boot({ DEEPSEEK_API_KEY: 'sk-seeded' })
    expect(await ctx.credentials.resolve(REF)).toEqual({
      value: 'sk-seeded',
      source: 'memory',
      protectionLevel: CREDENTIAL_PROTECTION_EPHEMERAL,
    })
    const info = await ctx.credentials.describe(REF)
    expect(info.observedAt).toBeGreaterThan(0)
    expect(info).toEqual({
      ref: REF,
      configured: true,
      source: 'memory',
      protectionLevel: CREDENTIAL_PROTECTION_EPHEMERAL,
      writable: true,
      health: 'available',
      observedAt: info.observedAt,
    })
  })

  it('treats an empty stored value as absent everywhere', async () => {
    const ctx = await boot({ DEEPSEEK_API_KEY: '' })
    expect(await ctx.credentials.resolve(REF)).toBeUndefined()
    const info = await ctx.credentials.describe(REF)
    expect(info.observedAt).toBeGreaterThan(0)
    expect(info).toEqual({
      ref: REF,
      configured: false,
      protectionLevel: CREDENTIAL_PROTECTION_EPHEMERAL,
      writable: true,
      health: 'missing',
      observedAt: info.observedAt,
    })
  })

  it('stores through set, removes through unset, and emits the committed change', async () => {
    const ctx = await boot()
    const events: CredentialRef[] = []
    ctx.on('credentials/reference-updated', ref => void events.push(ref))

    await ctx.credentials.set(REF, 'sk-live')
    expect(await ctx.credentials.resolve(REF)).toEqual({
      value: 'sk-live',
      source: 'memory',
      protectionLevel: CREDENTIAL_PROTECTION_EPHEMERAL,
    })
    await ctx.credentials.unset(REF)
    expect(await ctx.credentials.resolve(REF)).toBeUndefined()
    expect(events).toEqual([REF, REF])
  })

  it('rejects an empty set and keeps an absent unset silent', async () => {
    const ctx = await boot()
    const events: CredentialRef[] = []
    ctx.on('credentials/reference-updated', ref => void events.push(ref))

    await expect(ctx.credentials.set(REF, '')).rejects.toThrow(/empty value/)
    await ctx.credentials.unset(REF)
    expect(events).toEqual([])
  })

  it('removes the service with its fiber', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(MemoryCredentials)
    expect(ctx.get('credentials')).toBeDefined()
    await fiber.dispose()
    expect(ctx.get('credentials')).toBeUndefined()
  })
})
