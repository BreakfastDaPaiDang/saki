import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import koffi from 'koffi'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CREDENTIAL_PROTECTION_LOCAL_USER_TRUST,
  credentialKey,
  credentialRef,
} from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import WindowsDpapiCredentialProvider, { resolveSpec } from '../src/index.ts'
import { protectCurrentUser } from '../src/dpapi.ts'

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
const CODEX = credentialKey('llm-pi-ai', 'openai-codex')
const BEDROCK = credentialKey('llm-pi-ai', 'amazon-bedrock')
const cleanups: Array<() => Promise<void>> = []

type NativePtr = bigint

/** Create the counterexample that classic DPAPI lets every local user decrypt. */
function protectClassicLocalMachine(value: string): string {
  const pbyte = koffi.pointer('uint8')
  const pvoid = koffi.pointer('void')
  const blob = koffi.struct('DSH_TEST_LOCAL_MACHINE_DATA_BLOB', {
    cbData: 'uint32',
    pbData: pbyte,
  })
  const crypt32 = koffi.load('crypt32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  const protect = crypt32.func('__stdcall', 'CryptProtectData', 'int', [
    koffi.pointer(blob), 'str16', koffi.pointer(blob), pvoid, pvoid, 'uint32', koffi.out(koffi.pointer(blob)),
  ]) as unknown as (
    input: { cbData: number; pbData: Buffer }, description: null, entropy: null,
    reserved: null, prompt: null, flags: number, output: { cbData: number; pbData: NativePtr | null },
  ) => number
  const localFree = kernel32.func('__stdcall', 'LocalFree', pvoid, [pvoid]) as unknown as
    (pointer: NativePtr) => NativePtr | null
  const clear = Buffer.from(value, 'utf8')
  const output: { cbData: number; pbData: NativePtr | null } = { cbData: 0, pbData: null }
  try {
    const succeeded = protect(
      { cbData: clear.length, pbData: clear },
      null,
      null,
      null,
      null,
      0x1 | 0x4,
      output,
    )
    if (succeeded === 0 || output.pbData === null || output.pbData === 0n || output.cbData === 0) {
      throw new Error('test could not create a machine-scoped DPAPI blob')
    }
    return Buffer.from(koffi.view(output.pbData, output.cbData)).toString('base64')
  } finally {
    clear.fill(0)
    if (output.pbData !== null && output.pbData !== 0n) localFree(output.pbData)
  }
}

/** Create a CNG DPAPI blob whose authenticated descriptor is `LOCAL=machine`. */
function protectCngLocalMachine(value: string): string {
  const pbyte = koffi.pointer('uint8')
  const pvoid = koffi.pointer('void')
  const ncrypt = koffi.load('ncrypt.dll')
  const kernel32 = koffi.load('kernel32.dll')
  const createDescriptor = ncrypt.func('__stdcall', 'NCryptCreateProtectionDescriptor', 'int32', [
    'str16', 'uint32', koffi.out(koffi.pointer('void', 2)),
  ]) as unknown as (rule: string, flags: number, output: [NativePtr | null]) => number
  const protect = ncrypt.func('__stdcall', 'NCryptProtectSecret', 'int32', [
    pvoid, 'uint32', pbyte, 'uint32', pvoid, pvoid,
    koffi.out(koffi.pointer('uint8', 2)), koffi.out(koffi.pointer('uint32')),
  ]) as unknown as (
    descriptor: NativePtr, flags: number, input: Buffer, length: number,
    allocation: null, window: null, output: [NativePtr | null], outputLength: [number],
  ) => number
  const closeDescriptor = ncrypt.func('__stdcall', 'NCryptCloseProtectionDescriptor', 'int32', [pvoid]) as unknown as
    (descriptor: NativePtr) => number
  const localFree = kernel32.func('__stdcall', 'LocalFree', pvoid, [pvoid]) as unknown as
    (pointer: NativePtr) => NativePtr | null
  const descriptor: [NativePtr | null] = [null]
  const clear = Buffer.from(value, 'utf8')
  const output: [NativePtr | null] = [null]
  const length: [number] = [0]
  try {
    if (createDescriptor('LOCAL=machine', 0, descriptor) !== 0 || descriptor[0] === null || descriptor[0] === 0n) {
      throw new Error('test could not create a machine protection descriptor')
    }
    if (protect(descriptor[0], 0x40, clear, clear.length, null, null, output, length) !== 0
      || output[0] === null || output[0] === 0n || length[0] === 0) {
      throw new Error('test could not create a CNG machine-scoped DPAPI blob')
    }
    return Buffer.from(koffi.view(output[0], length[0])).toString('base64')
  } finally {
    clear.fill(0)
    if (output[0] !== null && output[0] !== 0n) localFree(output[0])
    if (descriptor[0] !== null && descriptor[0] !== 0n) closeDescriptor(descriptor[0])
  }
}

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

/** Store one record outright through the seam's serialized mutation path. */
function put(ctx: Context, key: CredentialKey, record: CredentialRecord): Promise<CredentialRecord | undefined> {
  return ctx.credentials.modifyRecord(key, () => Promise.resolve(record))
}

function recordUpdates(ctx: Context): CredentialKey[] {
  const seen: CredentialKey[] = []
  ctx.on('credentials/record-updated', (key) => { seen.push(key) })
  return seen
}

/** Render one strict version-2 document around an explicitly chosen plaintext record. */
function encryptedRecordDocument(
  key: CredentialKey,
  recordKind: CredentialRecord['kind'],
  plaintext: string,
): string {
  return `${JSON.stringify({
    version: 2,
    refs: {},
    records: {
      [key]: { kind: 'dpapi-ng-local-user', recordKind, ciphertext: protectCurrentUser(plaintext) },
    },
  }, null, 2)}\n`
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
      refs: Record<string, { kind: string; ciphertext: string }>
      records: Record<string, unknown>
    }
    const ciphertext = document.refs[REF]?.ciphertext
    expect(typeof ciphertext).toBe('string')
    expect(document).toEqual({
      version: 2,
      refs: {
        [REF]: {
          kind: 'dpapi-ng-local-user',
          ciphertext,
        },
      },
      records: {},
    })
    expect(text).not.toContain(secret)

    await expect(ctx.credentials.resolveRequired(REF, CREDENTIAL_PROTECTION_LOCAL_USER_TRUST)).resolves.toEqual({
      value: secret,
      source: 'windows-dpapi-current-user',
      protectionLevel: CREDENTIAL_PROTECTION_LOCAL_USER_TRUST,
    })
  })

  it('encrypts a durable credential record and reads it after restart', async () => {
    const path = await tempStore()
    const secret = 'record-refresh-token-that-must-stay-encrypted'
    const first = await boot(path)

    await put(first, CODEX, { kind: 'grant', payload: { refresh: secret, expires: 1786000000000 } })

    const text = await readFile(path, 'utf8')
    expect(text).not.toContain(secret)
    const restarted = await boot(path)
    await expect(restarted.credentials.readRecord(CODEX)).resolves.toEqual({
      kind: 'grant',
      payload: { refresh: secret, expires: 1786000000000 },
    })
  })

  it('describes and lists durable records without exposing their values', async () => {
    const path = await tempStore()
    const ctx = await boot(path)
    await ctx.credentials.set(REF, 'reference-secret')
    await put(ctx, CODEX, { kind: 'grant', payload: { refresh: 'grant-secret' } })
    await put(ctx, BEDROCK, { kind: 'api-key', key: 'api-key-secret', env: { AWS_PROFILE: 'prod' } })

    await expect(ctx.credentials.describeRecord(CODEX)).resolves.toEqual({
      configured: true,
      kind: 'grant',
      writable: true,
    })
    await expect(ctx.credentials.describeRecord(credentialKey('llm-pi-ai', 'missing'))).resolves.toEqual({
      configured: false,
      writable: true,
    })
    const listed = await ctx.credentials.listRecords()
    expect(listed).toEqual([
      { key: BEDROCK, kind: 'api-key' },
      { key: CODEX, kind: 'grant' },
    ])
    expect(JSON.stringify(listed)).not.toMatch(/reference-secret|grant-secret|api-key-secret/)

    const text = await readFile(path, 'utf8')
    expect(text).not.toMatch(/reference-secret|grant-secret|api-key-secret/)
    const document = JSON.parse(text) as { refs: Record<string, unknown>; records: Record<string, unknown> }
    expect(Object.keys(document.refs)).toEqual([REF])
    expect(Object.keys(document.records)).toEqual([BEDROCK, CODEX])
  })

  it('round-trips every api-key record form', async () => {
    const path = await tempStore()
    const ctx = await boot(path)
    const records = [
      [credentialKey('llm-pi-ai', 'ambient'), { kind: 'api-key' }],
      [credentialKey('llm-pi-ai', 'key-only'), { kind: 'api-key', key: 'sk-key' }],
      [credentialKey('llm-pi-ai', 'env-only'), { kind: 'api-key', env: { AWS_PROFILE: 'prod' } }],
      [credentialKey('llm-pi-ai', 'both'), { kind: 'api-key', key: 'sk-both', env: { REGION: 'eu' } }],
    ] as const satisfies ReadonlyArray<readonly [CredentialKey, CredentialRecord]>

    for (const [key, record] of records) {
      await put(ctx, key, record)
      await expect(ctx.credentials.readRecord(key)).resolves.toEqual(record)
    }
  })

  it('round-trips __proto__ as an api-key environment name', async () => {
    const path = await tempStore()
    const ctx = await boot(path)
    const record = {
      kind: 'api-key',
      env: Object.fromEntries([['__proto__', 'profile']]),
    } as const satisfies CredentialRecord

    await put(ctx, CODEX, record)

    const restarted = await boot(path)
    await expect(restarted.credentials.readRecord(CODEX)).resolves.toEqual(record)
  })

  it('mutates and deletes records atomically while publishing only committed changes', async () => {
    const path = await tempStore()
    const ctx = await boot(path)
    const updates = recordUpdates(ctx)
    await put(ctx, CODEX, { kind: 'grant', payload: { expires: 1 } })
    const seen: Array<CredentialRecord | undefined> = []

    await expect(ctx.credentials.modifyRecord(CODEX, (current) => {
      seen.push(current)
      return Promise.resolve({ kind: 'grant', payload: { expires: 2 } })
    })).resolves.toEqual({ kind: 'grant', payload: { expires: 2 } })
    const beforeDecline = await readFile(path, 'utf8')
    await expect(ctx.credentials.modifyRecord(CODEX, () => Promise.resolve(undefined)))
      .resolves.toEqual({ kind: 'grant', payload: { expires: 2 } })
    expect(await readFile(path, 'utf8')).toBe(beforeDecline)
    await ctx.credentials.deleteRecord(CODEX)
    await ctx.credentials.deleteRecord(CODEX)

    expect(seen).toEqual([{ kind: 'grant', payload: { expires: 1 } }])
    expect(updates).toEqual([CODEX, CODEX, CODEX])
    await expect(ctx.credentials.readRecord(CODEX)).resolves.toBeUndefined()
  })

  it('isolates record mutation inputs and results from durable state', async () => {
    const path = await tempStore()
    const ctx = await boot(path)
    const payload = { nested: { expires: 1 } }
    const written = await put(ctx, CODEX, { kind: 'grant', payload })
    payload.nested.expires = 2
    if (written?.kind === 'grant') {
      (written.payload as { nested: { expires: number } }).nested.expires = 3
    }

    const declined = await ctx.credentials.modifyRecord(CODEX, (current) => {
      if (current?.kind === 'grant') {
        (current.payload as { nested: { expires: number } }).nested.expires = 4
      }
      return Promise.resolve(undefined)
    })

    expect(declined).toEqual({ kind: 'grant', payload: { nested: { expires: 1 } } })
    await expect(ctx.credentials.readRecord(CODEX))
      .resolves.toEqual({ kind: 'grant', payload: { nested: { expires: 1 } } })
  })

  it('rejects record and api-key env accessors without invoking them', async () => {
    const path = await tempStore()
    const ctx = await boot(path)
    const secret = 'LEAKED_SECRET_FROM_RECORD_ACCESSOR'
    let recordReads = 0
    let envReads = 0
    let recordProxyReads = 0
    let envProxyReads = 0
    const record = {}
    Object.defineProperty(record, 'kind', {
      enumerable: true,
      get: () => {
        recordReads++
        throw new Error(secret)
      },
    })
    const env = {}
    Object.defineProperty(env, 'AWS_PROFILE', {
      enumerable: true,
      get: () => {
        envReads++
        throw new Error(secret)
      },
    })
    const recordProxy = new Proxy({ kind: 'grant', payload: {} } as const, {
      get: (_target, property) => {
        if (property === 'then') return undefined
        recordProxyReads++
        throw new Error(secret)
      },
    })
    const envProxy = new Proxy({ AWS_PROFILE: 'prod' }, {
      ownKeys: () => {
        envProxyReads++
        throw new Error(secret)
      },
    })

    const failures = await Promise.all([
      put(ctx, CODEX, record as CredentialRecord).then(() => undefined, (error: unknown) => error as Error),
      put(ctx, BEDROCK, { kind: 'api-key', env })
        .then(() => undefined, (error: unknown) => error as Error),
      put(ctx, CODEX, recordProxy).then(() => undefined, (error: unknown) => error as Error),
      put(ctx, BEDROCK, { kind: 'api-key', env: envProxy })
        .then(() => undefined, (error: unknown) => error as Error),
    ])

    expect([recordReads, envReads, recordProxyReads, envProxyReads]).toEqual([0, 0, 0, 0])
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(TypeError)
      expect(failure?.message).not.toContain(secret)
      expect(failure?.cause).toBeUndefined()
    }
    await expect(ctx.credentials.readRecord(CODEX)).resolves.toBeUndefined()
    await expect(ctx.credentials.readRecord(BEDROCK)).resolves.toBeUndefined()
  })

  it('rejects malformed record roots before protecting plaintext', async () => {
    const path = await tempStore()
    const ctx = await boot(path)
    const records = [
      { kind: 'grant', payload: {}, extra: 'dropped' },
      { kind: 'api-key', key: 1 },
      { kind: 'unknown', payload: {} },
    ]

    for (const record of records) {
      await expect(put(ctx, CODEX, record as unknown as CredentialRecord)).rejects.toBeInstanceOf(TypeError)
    }
    await expect(ctx.credentials.readRecord(CODEX)).resolves.toBeUndefined()
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps records written concurrently by separate provider instances', async () => {
    const path = await tempStore()
    const first = await boot(path)
    const second = await boot(path)

    await Promise.all([
      put(first, CODEX, { kind: 'grant', payload: { owner: 'codex' } }),
      put(second, BEDROCK, { kind: 'api-key', env: { AWS_PROFILE: 'prod' } }),
    ])

    const restarted = await boot(path)
    await expect(restarted.credentials.readRecord(CODEX))
      .resolves.toEqual({ kind: 'grant', payload: { owner: 'codex' } })
    await expect(restarted.credentials.readRecord(BEDROCK))
      .resolves.toEqual({ kind: 'api-key', env: { AWS_PROFILE: 'prod' } })
  })

  it('refuses records the encrypted document could not reproduce', async () => {
    const path = await tempStore()
    const ctx = await boot(path)
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic

    for (const payload of [{ at: new Date(0) }, { size: 1n }, { run: () => undefined }, { ratio: Number.NaN }, cyclic]) {
      await expect(put(ctx, CODEX, { kind: 'grant', payload })).rejects.toThrow(/record "llm-pi-ai\/openai-codex" payload/)
    }
    await expect(put(ctx, CODEX, { kind: 'api-key', key: '' })).rejects.toThrow(/empty key.*non-string key/)
    await expect(put(ctx, CODEX, { kind: 'api-key', env: { 'not a name': 'value' } })).rejects.toThrow(/invalid name/)
    await expect(put(ctx, CODEX, { kind: 'api-key', env: { AWS_PROFILE: '' } }))
      .rejects.toThrow(/not a non-empty string/)

    await expect(ctx.credentials.readRecord(CODEX)).resolves.toBeUndefined()
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a sparse grant payload that JSON would fill with null', async () => {
    const path = await tempStore()
    const ctx = await boot(path)
    const payload: unknown[] = []
    payload.length = 1

    await expect(put(ctx, CODEX, { kind: 'grant', payload })).rejects.toThrow(/payload/)
    await expect(ctx.credentials.readRecord(CODEX)).resolves.toBeUndefined()
  })

  it('refuses an enumerable array property that JSON would omit', async () => {
    const path = await tempStore()
    const ctx = await boot(path)
    const payload: unknown[] = ['kept']
    Object.assign(payload, { omitted: 'value' })

    await expect(put(ctx, CODEX, { kind: 'grant', payload })).rejects.toThrow(/payload/)
    await expect(ctx.credentials.readRecord(CODEX)).resolves.toBeUndefined()
  })

  it('rejects enumerable payload getters without invoking them', async () => {
    const path = await tempStore()
    const ctx = await boot(path)
    const secret = 'LEAKED_SECRET'
    let throwingReads = 0
    let changingReads = 0
    const throwing = {}
    const changing = {}
    Object.defineProperty(throwing, 'value', {
      enumerable: true,
      get: () => {
        throwingReads++
        throw new Error(secret)
      },
    })
    Object.defineProperty(changing, 'value', {
      enumerable: true,
      get: () => ++changingReads,
    })

    const throwingFailure = await put(ctx, CODEX, { kind: 'grant', payload: throwing })
      .then(() => undefined, (error: unknown) => error as Error)
    const changingFailure = await put(ctx, BEDROCK, { kind: 'grant', payload: changing })
      .then(() => undefined, (error: unknown) => error as Error)

    expect([throwingReads, changingReads]).toEqual([0, 0])
    expect(throwingFailure).toBeInstanceOf(TypeError)
    expect(changingFailure).toBeInstanceOf(TypeError)
    expect(throwingFailure?.message).not.toContain(secret)
    const restarted = await boot(path)
    await expect(restarted.credentials.readRecord(CODEX)).resolves.toBeUndefined()
    await expect(restarted.credentials.readRecord(BEDROCK)).resolves.toBeUndefined()
  })

  it('rejects an own non-enumerable toJSON without invoking it', async () => {
    const path = await tempStore()
    const ctx = await boot(path)
    const secret = 'LEAKED_SECRET_FROM_TOJSON'
    let calls = 0
    const payload = { value: 'kept' }
    Object.defineProperty(payload, 'toJSON', {
      value: () => {
        calls++
        throw new Error(secret)
      },
    })

    const failure = await put(ctx, CODEX, { kind: 'grant', payload })
      .then(() => undefined, (error: unknown) => error as Error)

    expect(calls).toBe(0)
    expect(failure).toBeInstanceOf(TypeError)
    expect(failure?.message).not.toContain(secret)
    const restarted = await boot(path)
    await expect(restarted.credentials.readRecord(CODEX)).resolves.toBeUndefined()
  })

  it('rejects an inherited toJSON without invoking it', async () => {
    const path = await tempStore()
    const ctx = await boot(path)
    const secret = 'LEAKED_SECRET_FROM_TOJSON'
    let calls = 0
    const payload: unknown[] = ['kept']
    const prototype = Object.create(Array.prototype) as object
    Object.defineProperty(prototype, 'toJSON', {
      value: () => {
        calls++
        throw new Error(secret)
      },
    })
    Object.setPrototypeOf(payload, prototype)

    const failure = await put(ctx, CODEX, { kind: 'grant', payload })
      .then(() => undefined, (error: unknown) => error as Error)

    expect(calls).toBe(0)
    expect(failure).toBeInstanceOf(TypeError)
    expect(failure?.message).not.toContain(secret)
    const restarted = await boot(path)
    await expect(restarted.credentials.readRecord(CODEX)).resolves.toBeUndefined()
  })

  it('does not invoke a global toJSON hook while storing an api-key record', async () => {
    const path = await tempStore()
    const ctx = await boot(path)
    const secret = 'LEAKED_SECRET_FROM_GLOBAL_TOJSON'
    const original = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON')
    let calls = 0
    try {
      Object.defineProperty(Object.prototype, 'toJSON', {
        configurable: true,
        value: () => {
          calls++
          throw new Error(secret)
        },
      })

      const failure = await put(ctx, CODEX, { kind: 'api-key', env: { AWS_PROFILE: 'prod' } })
        .then(() => undefined, (error: unknown) => error as Error)

      expect(calls).toBe(0)
      expect(failure).toBeInstanceOf(TypeError)
      expect(failure?.message).not.toContain(secret)
    } finally {
      if (original === undefined) delete (Object.prototype as { toJSON?: unknown }).toJSON
      else Object.defineProperty(Object.prototype, 'toJSON', original)
    }
    await expect(ctx.credentials.readRecord(CODEX)).resolves.toBeUndefined()
  })

  it('rejects an array subclass that a JSON round trip would flatten', async () => {
    const path = await tempStore()
    const ctx = await boot(path)
    const payload = new (class extends Array<unknown> {})()
    payload.push('kept')

    await expect(put(ctx, CODEX, { kind: 'grant', payload })).rejects.toThrow(/payload/)
    await expect(ctx.credentials.readRecord(CODEX)).resolves.toBeUndefined()
  })

  it('round-trips a non-callable toJSON data field', async () => {
    const path = await tempStore()
    const ctx = await boot(path)
    const record = { kind: 'grant', payload: { toJSON: 'literal', value: 'kept' } } as const

    await put(ctx, CODEX, record)

    const restarted = await boot(path)
    await expect(restarted.credentials.readRecord(CODEX)).resolves.toEqual(record)
  })

  it('refuses a symbol-keyed payload property that JSON would omit', async () => {
    const path = await tempStore()
    const ctx = await boot(path)
    const payload = { visible: 'kept', [Symbol('omitted')]: 'value' }

    await expect(put(ctx, CODEX, { kind: 'grant', payload })).rejects.toThrow(/payload/)

    const restarted = await boot(path)
    await expect(restarted.credentials.readRecord(CODEX)).resolves.toBeUndefined()
  })

  it('refuses a non-enumerable payload data property that JSON would omit', async () => {
    const path = await tempStore()
    const ctx = await boot(path)
    const payload = { visible: 'kept' }
    Object.defineProperty(payload, 'omitted', { value: 'value' })

    await expect(put(ctx, CODEX, { kind: 'grant', payload })).rejects.toThrow(/payload/)

    const restarted = await boot(path)
    await expect(restarted.credentials.readRecord(CODEX)).resolves.toBeUndefined()
  })

  it('sanitizes payload reflection trap failures without committing', async () => {
    const path = await tempStore()
    const ctx = await boot(path)
    const secret = 'LEAKED_SECRET_FROM_REFLECTION'
    const calls = [0, 0, 0]
    const payloads = [
      new Proxy({ value: 'kept' }, { ownKeys: () => { calls[0] = (calls[0] ?? 0) + 1; throw new Error(secret) } }),
      new Proxy({ value: 'kept' }, { getOwnPropertyDescriptor: () => { calls[1] = (calls[1] ?? 0) + 1; throw new Error(secret) } }),
      new Proxy({ value: 'kept' }, { getPrototypeOf: () => { calls[2] = (calls[2] ?? 0) + 1; throw new Error(secret) } }),
    ]

    for (const payload of payloads) {
      const failure = await put(ctx, CODEX, { kind: 'grant', payload })
        .then(() => undefined, (error: unknown) => error as Error)
      expect(failure).toBeInstanceOf(TypeError)
      expect(failure?.message).not.toContain(secret)
      expect(failure?.cause).toBeUndefined()
    }
    expect(calls).toEqual([0, 0, 0])

    const restarted = await boot(path)
    await expect(restarted.credentials.readRecord(CODEX)).resolves.toBeUndefined()
  })

  it('refuses -0 rather than persisting it as 0', async () => {
    const path = await tempStore()
    const ctx = await boot(path)

    await expect(put(ctx, CODEX, { kind: 'grant', payload: { offset: -0 } })).rejects.toThrow(/payload/)

    const restarted = await boot(path)
    await expect(restarted.credentials.readRecord(CODEX)).resolves.toBeUndefined()
  })

  it('sanitizes a record protection failure without committing it', async () => {
    const path = await tempStore()
    const secret = 'record-native-protection-error-must-not-escape'
    const ctx = await boot(path)
    dpapiHarness.protectError = secret

    const failure = await put(ctx, CODEX, { kind: 'grant', payload: { refresh: secret } })
      .then(() => undefined, (error: unknown) => error as Error)

    expect(failure?.message).toBe(
      `credentials-windows-dpapi: cannot protect record "${CODEX}" for the current Windows user`,
    )
    expect(JSON.stringify(failure)).not.toContain(secret)
    expect(failure?.cause).toBeUndefined()
    await expect(ctx.credentials.readRecord(CODEX)).resolves.toBeUndefined()
  })

  it('describes availability without exposing plaintext or ciphertext', async () => {
    const path = await tempStore()
    const secret = 'description-must-never-return-this-value'
    const ctx = await boot(path)
    await ctx.credentials.set(REF, secret)
    const document = JSON.parse(await readFile(path, 'utf8')) as {
      refs: Record<string, { ciphertext: string }>
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
    expect(serialized).not.toContain(document.refs[REF]!.ciphertext)
  })

  it('reports a copied or corrupt ciphertext as unavailable and fails resolve without echoing it', async () => {
    const path = await tempStore()
    const ciphertext = Buffer.from('not-a-dpapi-blob').toString('base64')
    await writeFile(path, `${JSON.stringify({
      version: 2,
      refs: { [REF]: { kind: 'dpapi-ng-local-user', ciphertext } },
      records: {},
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

  it('lists a copied durable record but refuses to decrypt it without echoing ciphertext', async () => {
    const path = await tempStore()
    const ciphertext = Buffer.from('not-a-dpapi-record').toString('base64')
    await writeFile(path, `${JSON.stringify({
      version: 2,
      refs: {},
      records: {
        [CODEX]: { kind: 'dpapi-ng-local-user', recordKind: 'grant', ciphertext },
      },
    }, null, 2)}\n`)
    const ctx = await boot(path)

    await expect(ctx.credentials.describeRecord(CODEX)).resolves.toEqual({
      configured: true,
      kind: 'grant',
      writable: true,
    })
    await expect(ctx.credentials.listRecords()).resolves.toEqual([{ key: CODEX, kind: 'grant' }])
    const failure = await ctx.credentials.readRecord(CODEX)
      .then(() => undefined, (error: unknown) => error as Error)
    expect(failure?.message).toBe(
      `credentials-windows-dpapi: cannot decrypt record "${CODEX}" for the current Windows user`,
    )
    expect(failure?.message).not.toContain(ciphertext)
    expect(failure?.cause).toBeUndefined()
  })

  it('rejects invalid decrypted records without echoing their plaintext', async () => {
    const secret = 'decrypted-record-data-must-not-reach-the-diagnostic'
    const cases: ReadonlyArray<readonly [CredentialRecord['kind'], string]> = [
      ['grant', secret],
      ['grant', 'null'],
      ['grant', '[]'],
      ['grant', JSON.stringify({ kind: 'api-key', key: secret })],
      ['grant', JSON.stringify({ kind: 'grant' })],
      ['grant', JSON.stringify({ kind: 'grant', payload: 1, extra: secret })],
      ['api-key', JSON.stringify({ kind: 'api-key', key: 1 })],
      ['api-key', JSON.stringify({ kind: 'api-key', env: [] })],
      ['api-key', JSON.stringify({ kind: 'api-key', env: { [secret]: 'value' } })],
      ['api-key', JSON.stringify({ kind: 'api-key', env: { AWS_PROFILE: 1 } })],
    ]

    for (const [recordKind, plaintext] of cases) {
      const path = await tempStore()
      await writeFile(path, encryptedRecordDocument(CODEX, recordKind, plaintext))
      const ctx = await boot(path)
      const failure = await ctx.credentials.readRecord(CODEX)
        .then(() => undefined, (error: unknown) => error as Error)
      expect(failure).toBeInstanceOf(Error)
      expect(failure?.message).not.toContain(secret)
      expect(failure?.cause).toBeUndefined()
    }
  })

  it('rejects real classic and CNG machine-scoped blobs even when their kind claims current user', async () => {
    const secret = 'machine-scope-must-not-satisfy-local-user-trust'
    for (const ciphertext of [protectClassicLocalMachine(secret), protectCngLocalMachine(secret)]) {
      const path = await tempStore()
      await writeFile(path, `${JSON.stringify({
        version: 2,
        refs: { [REF]: { kind: 'dpapi-ng-local-user', ciphertext } },
        records: {},
      }, null, 2)}\n`)
      const ctx = await boot(path)

      const info = await ctx.credentials.describe(REF)
      expect(info.health).toBe('unavailable')
      await expect(ctx.credentials.resolveRequired(REF, CREDENTIAL_PROTECTION_LOCAL_USER_TRUST))
        .rejects.toThrow(/cannot decrypt/)
    }
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
    first.on('credentials/reference-updated', ref => void updates.push(ref))
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
      `{ "version": 2, "refs": { "${REF}": "${secret}" }`,
      JSON.stringify({ version: 1, refs: {}, records: {} }),
      JSON.stringify({ version: 2, refs: {}, records: {}, extra: true }),
      JSON.stringify({ version: 2, refs: [], records: {} }),
      JSON.stringify({
        version: 2,
        refs: { [secret]: { kind: 'dpapi-ng-local-user', ciphertext: 'YQ==' } },
        records: {},
      }),
      JSON.stringify({ version: 2, refs: { [REF]: null }, records: {} }),
      JSON.stringify({
        version: 2,
        refs: { [REF]: { kind: 'dpapi-local-machine', ciphertext: 'YQ==' } },
        records: {},
      }),
      JSON.stringify({
        version: 2,
        refs: { [REF]: { kind: 'dpapi-ng-local-user', ciphertext: '' } },
        records: {},
      }),
      JSON.stringify({
        version: 2,
        refs: { [REF]: { kind: 'dpapi-ng-local-user', ciphertext: 'not base64' } },
        records: {},
      }),
      JSON.stringify({
        version: 2,
        refs: { [REF]: { kind: 'dpapi-ng-local-user', ciphertext: 'YQ==', plaintext: secret } },
        records: {},
      }),
      JSON.stringify({
        version: 2,
        refs: {},
        records: { [secret]: { kind: 'dpapi-ng-local-user', recordKind: 'grant', ciphertext: 'YQ==' } },
      }),
      JSON.stringify({ version: 2, refs: {}, records: { [CODEX]: null } }),
      JSON.stringify({
        version: 2,
        refs: {},
        records: { [CODEX]: { kind: 'dpapi-local-machine', recordKind: 'grant', ciphertext: 'YQ==' } },
      }),
      JSON.stringify({
        version: 2,
        refs: {},
        records: { [CODEX]: { kind: 'dpapi-ng-local-user', recordKind: 'grant', ciphertext: '' } },
      }),
      JSON.stringify({
        version: 2,
        refs: {},
        records: { [CODEX]: { kind: 'dpapi-ng-local-user', recordKind: 'unknown', ciphertext: 'YQ==' } },
      }),
      JSON.stringify({
        version: 2,
        refs: {},
        records: {
          [CODEX]: { kind: 'dpapi-ng-local-user', recordKind: 'grant', ciphertext: 'YQ==', plaintext: secret },
        },
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
    await put(ctx, CODEX, { kind: 'grant', payload: { expires: 1 } })
    await fiber.dispose()

    expect(ctx.get('credentials')).toBeUndefined()
    await expect(service.describeRecord(CODEX)).resolves.toEqual({ configured: true, kind: 'grant', writable: false })
    await expect(service.set(REF, 'late')).rejects.toThrow(/disposed/)
    await expect(service.unset(REF)).rejects.toThrow(/disposed/)
    await expect(service.modifyRecord(CODEX, () => Promise.resolve({ kind: 'grant', payload: { expires: 2 } })))
      .rejects.toThrow(/disposed/)
    await expect(service.deleteRecord(CODEX)).rejects.toThrow(/disposed/)
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

  it('rejects queued record mutations and deletes when disposal starts behind a commit', async () => {
    const path = await tempStore()
    const ctx = new Context()
    const fiber = ctx.plugin(WindowsDpapiCredentialProvider, { path })
    await fiber
    const service = ctx.credentials
    await writeFile(`${path}.lock`, 'test lock\n')

    const first = put(ctx, CODEX, { kind: 'grant', payload: { expires: 1 } })
    await new Promise(resolveImmediate => setImmediate(resolveImmediate))
    const queuedModify = put(ctx, BEDROCK, { kind: 'api-key' })
    const queuedDelete = service.deleteRecord(CODEX)
    const disposal = fiber.dispose()
    await new Promise(resolveImmediate => setImmediate(resolveImmediate))
    await rm(`${path}.lock`, { force: true })

    await expect(first).resolves.toEqual({ kind: 'grant', payload: { expires: 1 } })
    await expect(queuedModify).rejects.toThrow(/disposed before the queued/)
    await expect(queuedDelete).rejects.toThrow(/disposed before the queued/)
    await disposal
  })
})
