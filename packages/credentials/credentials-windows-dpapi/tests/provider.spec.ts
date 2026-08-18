import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CREDENTIAL_PROTECTION_LOCAL_USER_TRUST,
  credentialRef,
} from '@deepseek-ai/dsh-credentials'
import WindowsDpapiCredentialProvider, { resolveSpec } from '../src/index.ts'

const dpapiHarness = vi.hoisted(() => ({ protectError: undefined as string | undefined }))
vi.mock('../src/dpapi.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/dpapi.ts')>()
  return {
    ...actual,
    protectCurrentUser: (value: string): string => {
      if (dpapiHarness.protectError !== undefined) throw new Error(dpapiHarness.protectError)
      return actual.protectCurrentUser(value)
    },
  }
})

const REF = credentialRef('DSH_DPAPI_TEST')
const OTHER = credentialRef('DSH_DPAPI_OTHER')
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  dpapiHarness.protectError = undefined
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempStore(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-dpapi-credentials-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return join(directory, 'credentials.dpapi.json')
}

async function boot(path: string): Promise<Context> {
  const ctx = new Context()
  const fiber = ctx.plugin(WindowsDpapiCredentialProvider, { path })
  cleanups.push(async () => { await fiber.dispose() })
  await fiber
  return ctx
}

describe.runIf(process.platform !== 'win32')('Windows current-user DPAPI credentials', () => {
  it('rejects activation on every non-Windows host', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(WindowsDpapiCredentialProvider, { path: '/tmp/credentials.dpapi.json' }))
      .rejects.toThrow(/requires Windows/)
  })
})

describe.runIf(process.platform === 'win32')('Windows current-user DPAPI credentials', () => {
  it('resolves the fixed document name beneath an explicit Harness home', async () => {
    const path = await tempStore()
    expect(resolveSpec({ path })).toEqual({ filename: path })
    expect(resolveSpec({ dshHome: join(path, '..') })).toEqual({
      filename: join(path, '..', '.credentials.dpapi.json'),
    })
  })

  it('persists only a versioned current-user ciphertext record and resolves it for this user', async () => {
    const path = await tempStore()
    const secret = 'refresh-token-that-must-not-land-in-the-document'
    const ctx = await boot(path)

    await ctx.credentials.set(REF, secret)

    const text = await readFile(path, 'utf8')
    const document = JSON.parse(text) as {
      version: number
      records: Record<string, { kind: string; ciphertext: string }>
    }
    const ciphertext = document.records[REF]?.ciphertext
    expect(typeof ciphertext).toBe('string')
    expect(document).toEqual({
      version: 1,
      records: {
        [REF]: {
          kind: 'dpapi-current-user',
          ciphertext,
        },
      },
    })
    expect(text).not.toContain(secret)

    await expect(ctx.credentials.resolveRequired(REF, CREDENTIAL_PROTECTION_LOCAL_USER_TRUST)).resolves.toEqual({
      value: secret,
      source: 'windows-dpapi-current-user',
      protectionLevel: CREDENTIAL_PROTECTION_LOCAL_USER_TRUST,
    })
  })

  it('describes availability without exposing plaintext or ciphertext', async () => {
    const path = await tempStore()
    const secret = 'description-must-never-return-this-value'
    const ctx = await boot(path)
    await ctx.credentials.set(REF, secret)
    const document = JSON.parse(await readFile(path, 'utf8')) as {
      records: Record<string, { ciphertext: string }>
    }

    const info = await ctx.credentials.describe(REF)
    expect(info.observedAt).toBeGreaterThan(0)
    expect(info).toEqual({
      ref: REF,
      configured: true,
      source: 'windows-dpapi-current-user',
      protectionLevel: CREDENTIAL_PROTECTION_LOCAL_USER_TRUST,
      writable: true,
      health: 'available',
      observedAt: info.observedAt,
    })
    const serialized = JSON.stringify(info)
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain(document.records[REF]!.ciphertext)
  })

  it('reports a copied or corrupt ciphertext as unavailable and fails resolve without echoing it', async () => {
    const path = await tempStore()
    const ciphertext = Buffer.from('not-a-dpapi-blob').toString('base64')
    await writeFile(path, `${JSON.stringify({
      version: 1,
      records: { [REF]: { kind: 'dpapi-current-user', ciphertext } },
    }, null, 2)}\n`)
    const ctx = await boot(path)

    const info = await ctx.credentials.describe(REF)
    expect(info.observedAt).toBeGreaterThan(0)
    expect(info).toEqual({
      ref: REF,
      configured: true,
      source: 'windows-dpapi-current-user',
      protectionLevel: CREDENTIAL_PROTECTION_LOCAL_USER_TRUST,
      writable: true,
      health: 'unavailable',
      observedAt: info.observedAt,
    })
    const failure = await ctx.credentials.resolveRequired(REF, CREDENTIAL_PROTECTION_LOCAL_USER_TRUST)
      .then(() => undefined, (error: unknown) => error as Error)
    expect(failure?.message).toContain(`cannot decrypt "${REF}" for the current Windows user`)
    expect(failure?.message).not.toContain(ciphertext)
    expect(failure?.cause).toBeUndefined()
  })

  it('sanitizes a protection failure without creating a record', async () => {
    const path = await tempStore()
    const secret = 'native-protection-error-must-not-escape'
    const ctx = await boot(path)
    dpapiHarness.protectError = secret

    const failure = await ctx.credentials.set(REF, secret)
      .then(() => undefined, (error: unknown) => error as Error)
    expect(failure?.message).toBe(`credentials-windows-dpapi: cannot protect "${REF}" for the current Windows user`)
    expect(JSON.stringify(failure)).not.toContain(secret)
    expect(failure?.cause).toBeUndefined()
    await expect(ctx.credentials.resolve(REF)).resolves.toBeUndefined()
  })

  it('publishes committed writes, survives a provider restart, and keeps absent removal silent', async () => {
    const path = await tempStore()
    const first = await boot(path)
    const updates: string[] = []
    first.on('credentials/updated', ref => void updates.push(ref))
    const info = await first.credentials.describe(REF)
    expect(info.observedAt).toBeGreaterThan(0)
    expect(info).toEqual({
      ref: REF,
      configured: false,
      protectionLevel: CREDENTIAL_PROTECTION_LOCAL_USER_TRUST,
      writable: true,
      health: 'missing',
      observedAt: info.observedAt,
    })

    await first.credentials.set(REF, 'restart-value')
    const restarted = await boot(path)
    await expect(restarted.credentials.resolve(REF)).resolves.toEqual({
      value: 'restart-value',
      source: 'windows-dpapi-current-user',
      protectionLevel: CREDENTIAL_PROTECTION_LOCAL_USER_TRUST,
    })
    await first.credentials.unset(REF)
    await first.credentials.unset(REF)

    expect(updates).toEqual([REF, REF])
    await expect(restarted.credentials.resolve(REF)).resolves.toBeUndefined()
  })

  it('rejects every unsupported document form without echoing record data', async () => {
    const secret = 'raw-value-that-must-not-reach-the-diagnostic'
    const cases = [
      `{ "version": 1, "records": { "${REF}": "${secret}" }`,
      JSON.stringify({ version: 2, records: {} }),
      JSON.stringify({ version: 1, records: {}, extra: true }),
      JSON.stringify({ version: 1, records: [] }),
      JSON.stringify({ version: 1, records: { [secret]: { kind: 'dpapi-current-user', ciphertext: 'YQ==' } } }),
      JSON.stringify({ version: 1, records: { [REF]: null } }),
      JSON.stringify({ version: 1, records: { [REF]: { kind: 'dpapi-local-machine', ciphertext: 'YQ==' } } }),
      JSON.stringify({ version: 1, records: { [REF]: { kind: 'dpapi-current-user', ciphertext: '' } } }),
      JSON.stringify({ version: 1, records: { [REF]: { kind: 'dpapi-current-user', ciphertext: 'not base64' } } }),
      JSON.stringify({
        version: 1,
        records: { [REF]: { kind: 'dpapi-current-user', ciphertext: 'YQ==', plaintext: secret } },
      }),
    ]

    for (const text of cases) {
      const path = await tempStore()
      await writeFile(path, text)
      const failure = await boot(path).then(() => undefined, (error: unknown) => error as Error)
      expect(failure).toBeInstanceOf(Error)
      expect(failure?.message).not.toContain(secret)
    }
  })

  it('serializes concurrent writes and rejects empty values', async () => {
    const path = await tempStore()
    const ctx = await boot(path)

    await expect(ctx.credentials.set(REF, '')).rejects.toThrow(/empty value/)
    await Promise.all([
      ctx.credentials.set(REF, 'one'),
      ctx.credentials.set(OTHER, 'two'),
    ])

    await expect(ctx.credentials.resolve(REF)).resolves.toEqual({
      value: 'one',
      source: 'windows-dpapi-current-user',
      protectionLevel: CREDENTIAL_PROTECTION_LOCAL_USER_TRUST,
    })
    await expect(ctx.credentials.resolve(OTHER)).resolves.toEqual({
      value: 'two',
      source: 'windows-dpapi-current-user',
      protectionLevel: CREDENTIAL_PROTECTION_LOCAL_USER_TRUST,
    })
  })

  it('surfaces document read failures and recovers after a rejected queued write', async () => {
    const path = await tempStore()
    const ctx = await boot(path)
    await mkdir(path)

    await expect(ctx.credentials.set(REF, 'blocked')).rejects.toBeInstanceOf(Error)
    await rm(path, { recursive: true, force: true })
    await ctx.credentials.set(OTHER, 'after-failure')
    await expect(ctx.credentials.resolve(OTHER)).resolves.toEqual({
      value: 'after-failure',
      source: 'windows-dpapi-current-user',
      protectionLevel: CREDENTIAL_PROTECTION_LOCAL_USER_TRUST,
    })
  })

  it('refuses writes through a captured service after disposal', async () => {
    const path = await tempStore()
    const ctx = new Context()
    const fiber = ctx.plugin(WindowsDpapiCredentialProvider, { path })
    await fiber
    const service = ctx.credentials
    await fiber.dispose()

    expect(ctx.get('credentials')).toBeUndefined()
    await expect(service.set(REF, 'late')).rejects.toThrow(/disposed/)
    await expect(service.unset(REF)).rejects.toThrow(/disposed/)
  })

  it('rejects a queued write when disposal starts behind an in-flight commit', async () => {
    const path = await tempStore()
    const ctx = new Context()
    const fiber = ctx.plugin(WindowsDpapiCredentialProvider, { path })
    await fiber
    const service = ctx.credentials
    await writeFile(`${path}.lock`, 'test lock\n')

    const first = service.set(REF, 'first')
    await new Promise(resolveImmediate => setImmediate(resolveImmediate))
    const queued = service.set(OTHER, 'queued')
    const disposal = fiber.dispose()
    await new Promise(resolveImmediate => setImmediate(resolveImmediate))
    await rm(`${path}.lock`, { force: true })

    await expect(first).resolves.toBeUndefined()
    await expect(queued).rejects.toThrow(/disposed before the queued/)
    await disposal
  })
})
