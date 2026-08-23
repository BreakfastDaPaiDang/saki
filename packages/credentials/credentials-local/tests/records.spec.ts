// The record half of the seam: the store keeps an owner's payload verbatim,
// presence rather than content answers "configured", and every write goes
// through one serialized read-modify-write so a rotating credential cannot be
// lost between processes.
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CREDENTIAL_PROTECTION_PLAINTEXT,
  credentialKey,
  credentialKeyScope,
  credentialRef,
  parseCredentialKey,
} from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider } from '../src/index.ts'

/** Credential documents are seeded owner-only, exactly as the provider creates them. */
function writeCredentials(file: string, text: string): Promise<void> {
  return writeFile(file, text, { mode: 0o600 })
}

const CODEX = credentialKey('llm-pi-ai', 'openai-codex')
const BEDROCK = credentialKey('llm-pi-ai', 'amazon-bedrock')
const OTHER_OWNER = credentialKey('llm-kimi', 'openai-codex')

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cred-records-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function boot(config: ConstructorParameters<typeof LocalCredentialProvider>[1]): Promise<Context> {
  const ctx = new Context()
  const fiber = ctx.plugin(LocalCredentialProvider, config)
  cleanups.push(async () => { await fiber.dispose() })
  await fiber
  return ctx
}

/** Store one record outright; the seam offers only the read-modify-write path. */
function put(ctx: Context, key: CredentialKey, record: CredentialRecord): Promise<CredentialRecord | undefined> {
  return ctx.credentials.modifyRecord(key, () => Promise.resolve(record))
}

function recordUpdates(ctx: Context): CredentialKey[] {
  const seen: CredentialKey[] = []
  ctx.on('credentials/record-updated', (key) => { seen.push(key) })
  return seen
}

describe('credential keys', () => {
  it('rejects a segment that is not a lowercase hyphenated identifier', () => {
    expect(() => credentialKey('llm-pi-ai', 'OpenAI')).toThrow(/credential key segment/)
    expect(() => credentialKey('', 'codex')).toThrow(/credential key segment/)
  })

  it('stays disjoint from the reference grammar', () => {
    // The `/` is what makes the two key spaces incapable of colliding, so a
    // record address can never be mistaken for an environment-variable name.
    expect(() => credentialRef(CODEX)).toThrow(/credential ref/)
  })

  it('reads back the owning plugin, which is what makes an orphan recognizable', () => {
    expect(credentialKeyScope(CODEX)).toBe('llm-pi-ai')
    expect(credentialKeyScope(OTHER_OWNER)).toBe('llm-kimi')
  })

  it('admits a stored key and refuses one that is not two segments', () => {
    expect(parseCredentialKey('llm-pi-ai/openai-codex')).toBe(CODEX)
    expect(() => parseCredentialKey('openai-codex')).toThrow(/must be "<scope>\/<id>"/)
    expect(() => parseCredentialKey('a/b/c')).toThrow(/must be "<scope>\/<id>"/)
  })
})

describe('record storage', () => {
  it('returns a grant payload exactly as its owner wrote it', async () => {
    const dir = await tempDir()
    const ctx = await boot({ path: join(dir, '.credentials.yaml'), watch: false })
    // Fields the seam has never heard of ride along: an owner's SDK gains them
    // between releases, and a whitelist here would silently eat the new ones.
    const payload = { type: 'oauth', access: 'at', refresh: 'rt', expires: 1786000000000, accountId: 'acct_1' }
    await put(ctx, CODEX, { kind: 'grant', payload })

    expect(await ctx.credentials.readRecord(CODEX)).toEqual({ kind: 'grant', payload })
    const reread = await boot({ path: join(dir, '.credentials.yaml'), watch: false })
    expect(await reread.credentials.readRecord(CODEX)).toEqual({ kind: 'grant', payload })
  })

  it('treats a record carrying no key and no environment as configured', async () => {
    const dir = await tempDir()
    const ctx = await boot({ path: join(dir, '.credentials.yaml'), watch: false })
    // The owner confirmed this route authenticates from its own ambient
    // discovery. That is a stored decision, not a blank — the opposite reading
    // of the empty-value rule the reference half follows.
    await put(ctx, BEDROCK, { kind: 'api-key' })

    expect(await ctx.credentials.describeRecord(BEDROCK)).toEqual({ configured: true, kind: 'api-key', writable: true })
  })

  it('describes an absent record as unconfigured but writable', async () => {
    const dir = await tempDir()
    const ctx = await boot({ path: join(dir, '.credentials.yaml'), watch: false })

    expect(await ctx.credentials.describeRecord(CODEX)).toEqual({ configured: false, writable: true })
    expect(await ctx.credentials.readRecord(CODEX)).toBeUndefined()
  })

  it('stores provider environment values beside or instead of a key', async () => {
    const dir = await tempDir()
    const ctx = await boot({ path: join(dir, '.credentials.yaml'), watch: false })
    await put(ctx, BEDROCK, { kind: 'api-key', env: { AWS_PROFILE: 'prod' } })

    expect(await ctx.credentials.readRecord(BEDROCK)).toEqual({ kind: 'api-key', env: { AWS_PROFILE: 'prod' } })
  })

  it('round-trips __proto__ as an api-key environment name', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false })
    const record = {
      kind: 'api-key',
      env: Object.fromEntries([['__proto__', 'profile']]),
    } as const satisfies CredentialRecord

    await put(ctx, CODEX, record)

    const restarted = await boot({ path, watch: false })
    await expect(restarted.credentials.readRecord(CODEX)).resolves.toEqual(record)
  })

  it('does not expose unsupported document metadata in diagnostics', async () => {
    const dir = await tempDir()
    const secret = 'LEAKED_SECRET_FROM_DOCUMENT_METADATA'
    const cases = [
      `version: ${secret}\nrefs: {}\nrecords: {}\n`,
      `version: 1\nrecords:\n  ${CODEX}:\n    kind: ${secret}\n`,
    ]

    for (const [index, text] of cases.entries()) {
      const path = join(dir, `.credentials-${String(index)}.yaml`)
      await writeCredentials(path, text)
      const failure = await boot({ path, watch: false })
        .then(() => undefined, (error: unknown) => error as Error)

      expect(failure).toBeInstanceOf(Error)
      expect(failure?.message).not.toContain(secret)
      expect(failure?.cause).toBeUndefined()
      expect(JSON.stringify(failure)).not.toContain(secret)
    }
  })

  it('keeps references and records in one document without either disturbing the other', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false })
    await ctx.credentials.set(credentialRef('DSH_RECORDS_KEY'), 'sk-live')
    await put(ctx, CODEX, { kind: 'grant', payload: { token: 't' } })

    const text = await readFile(path, 'utf8')
    expect(text).toBe(
      'version: 1\nrefs:\n  DSH_RECORDS_KEY: sk-live\nrecords:\n'
      + '  llm-pi-ai/openai-codex:\n    kind: grant\n    payload:\n      token: t\n',
    )
    expect(await ctx.credentials.resolve(credentialRef('DSH_RECORDS_KEY'))).toEqual({
      value: 'sk-live', source: 'file', protectionLevel: CREDENTIAL_PROTECTION_PLAINTEXT,
    })
  })

  it('reads every record shape back off disk', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    // Written by hand rather than through the API: this is the parse path, and
    // an api-key record is legal with a key, with environment values, with
    // both, or with neither.
    await writeCredentials(path, 'version: 1\nrecords:\n'
      + '  llm-pi-ai/openai-codex:\n    kind: grant\n    payload:\n      access: at\n'
      + '  llm-pi-ai/amazon-bedrock:\n    kind: api-key\n    env:\n      AWS_PROFILE: prod\n'
      + '  llm-pi-ai/azure:\n    kind: api-key\n    key: sk-azure\n'
      + '  llm-pi-ai/both:\n    kind: api-key\n    key: sk-both\n    env:\n      REGION: eu\n'
      + '  llm-pi-ai/ambient:\n    kind: api-key\n')
    const ctx = await boot({ path, watch: false })

    expect(await ctx.credentials.readRecord(CODEX)).toEqual({ kind: 'grant', payload: { access: 'at' } })
    expect(await ctx.credentials.readRecord(BEDROCK)).toEqual({ kind: 'api-key', env: { AWS_PROFILE: 'prod' } })
    expect(await ctx.credentials.readRecord(credentialKey('llm-pi-ai', 'azure')))
      .toEqual({ kind: 'api-key', key: 'sk-azure' })
    expect(await ctx.credentials.readRecord(credentialKey('llm-pi-ai', 'both')))
      .toEqual({ kind: 'api-key', key: 'sk-both', env: { REGION: 'eu' } })
    expect(await ctx.credentials.readRecord(credentialKey('llm-pi-ai', 'ambient'))).toEqual({ kind: 'api-key' })
  })

  it('publishes a record an external edit reshaped, whatever shape it took', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false })
    await put(ctx, CODEX, { kind: 'grant', payload: { scopes: ['a'] } })
    const seen = recordUpdates(ctx)

    // A sequence where a mapping stood, then a mapping that gained a field:
    // neither is caught by an identity check, and reporting them as unchanged
    // would leave a stale credential on every configuration surface.
    for (const payload of ['[1]', '{a: 1}', '{a: 1, b: 2}']) {
      await writeCredentials(path, 'version: 1\nrecords:\n  llm-pi-ai/openai-codex:\n'
        + `    kind: grant\n    payload: ${payload}\n`)
      // Any write folds the unobserved document in before committing its own.
      await put(ctx, BEDROCK, { kind: 'api-key' })
    }

    expect(seen.filter(key => key === CODEX)).toHaveLength(3)
    expect(await ctx.credentials.readRecord(CODEX)).toEqual({ kind: 'grant', payload: { a: 1, b: 2 } })
  })

  it('publishes an external edit that replaces an own __proto__ payload field', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    await writeCredentials(path, `version: 1\nrecords:\n  ${CODEX}:\n    kind: grant\n    payload:\n      __proto__: {}\n`)
    const ctx = await boot({ path, watch: false })
    const seen = recordUpdates(ctx)
    await writeCredentials(path, `version: 1\nrecords:\n  ${CODEX}:\n    kind: grant\n    payload:\n      x: 1\n`)

    await put(ctx, BEDROCK, { kind: 'api-key' })

    expect(seen).toContain(CODEX)
    await expect(ctx.credentials.readRecord(CODEX)).resolves.toEqual({ kind: 'grant', payload: { x: 1 } })
  })

  it('keeps two owners of the same provider id apart', async () => {
    const dir = await tempDir()
    const ctx = await boot({ path: join(dir, '.credentials.yaml'), watch: false })
    await put(ctx, CODEX, { kind: 'grant', payload: { owner: 'pi-ai' } })
    await put(ctx, OTHER_OWNER, { kind: 'grant', payload: { owner: 'kimi' } })

    expect(await ctx.credentials.readRecord(CODEX)).toEqual({ kind: 'grant', payload: { owner: 'pi-ai' } })
    expect(await ctx.credentials.readRecord(OTHER_OWNER)).toEqual({ kind: 'grant', payload: { owner: 'kimi' } })
  })
})

describe('record mutation', () => {
  it('shows the mutation the record as it stands and commits its replacement', async () => {
    const dir = await tempDir()
    const ctx = await boot({ path: join(dir, '.credentials.yaml'), watch: false })
    await put(ctx, CODEX, { kind: 'grant', payload: { expires: 1 } })
    const seen: Array<CredentialRecord | undefined> = []

    const next = await ctx.credentials.modifyRecord(CODEX, (current) => {
      seen.push(current)
      return Promise.resolve({ kind: 'grant', payload: { expires: 2 } })
    })

    expect(seen).toEqual([{ kind: 'grant', payload: { expires: 1 } }])
    expect(next).toEqual({ kind: 'grant', payload: { expires: 2 } })
  })

  it('leaves the entry untouched when the mutation declines', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false })
    await put(ctx, CODEX, { kind: 'grant', payload: { expires: 1 } })
    const before = await readFile(path, 'utf8')
    const seen = recordUpdates(ctx)

    // The refresh path declines whenever a second reader finds the credential
    // already rotated; declining must not rewrite the document or announce a
    // change that did not happen.
    const result = await ctx.credentials.modifyRecord(CODEX, () => Promise.resolve(undefined))

    expect(result).toEqual({ kind: 'grant', payload: { expires: 1 } })
    expect(await readFile(path, 'utf8')).toBe(before)
    expect(seen).toEqual([])
  })

  it('isolates the cached record from caller and mutation references', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false })
    const payload = { nested: { expires: 1 } }
    const written = await put(ctx, CODEX, { kind: 'grant', payload })
    payload.nested.expires = 2
    if (written?.kind === 'grant') {
      (written.payload as { nested: { expires: number } }).nested.expires = 3
    }
    const firstRead = await ctx.credentials.readRecord(CODEX)
    if (firstRead?.kind === 'grant') {
      (firstRead.payload as { nested: { expires: number } }).nested.expires = 4
    }

    const declined = await ctx.credentials.modifyRecord(CODEX, (current) => {
      if (current?.kind === 'grant') {
        (current.payload as { nested: { expires: number } }).nested.expires = 5
      }
      return Promise.resolve(undefined)
    })

    expect(declined).toEqual({ kind: 'grant', payload: { nested: { expires: 1 } } })
    await expect(ctx.credentials.readRecord(CODEX))
      .resolves.toEqual({ kind: 'grant', payload: { nested: { expires: 1 } } })
    const restarted = await boot({ path, watch: false })
    await expect(restarted.credentials.readRecord(CODEX))
      .resolves.toEqual({ kind: 'grant', payload: { nested: { expires: 1 } } })
  })

  it('rejects record and api-key env accessors without invoking them', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false })
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

  it('rejects malformed record roots before writing a document', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false })
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

  it('announces a committed write and a committed delete, and stays silent on an absent delete', async () => {
    const dir = await tempDir()
    const ctx = await boot({ path: join(dir, '.credentials.yaml'), watch: false })
    const seen = recordUpdates(ctx)

    await put(ctx, CODEX, { kind: 'grant', payload: 1 })
    await ctx.credentials.deleteRecord(CODEX)
    await ctx.credentials.deleteRecord(CODEX)

    expect(seen).toEqual([CODEX, CODEX])
    expect(await ctx.credentials.readRecord(CODEX)).toBeUndefined()
  })

  it('removes a later record without disturbing the annotation above the first', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    // The comment sits above the section's first entry, where the parser
    // attaches it to the section rather than to the pair. Removing a *later*
    // entry must leave it exactly where it is.
    await writeCredentials(path, 'version: 1\nrecords:\n  # the one to keep\n'
      + '  llm-pi-ai/openai-codex:\n    kind: grant\n    payload: 1\n'
      + '  llm-pi-ai/amazon-bedrock:\n    kind: api-key\n')
    const ctx = await boot({ path, watch: false })

    await ctx.credentials.deleteRecord(BEDROCK)

    expect(await readFile(path, 'utf8')).toBe('version: 1\nrecords:\n  # the one to keep\n'
      + '  llm-pi-ai/openai-codex:\n    kind: grant\n    payload: 1\n')
  })

  it('folds an unobserved external record edit into a write instead of overwriting it', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false })
    await put(ctx, CODEX, { kind: 'grant', payload: { v: 1 } })
    // Landed on disk with no watcher to report it — the same blind spot as a
    // debounce window, a missed event, or another process's write.
    await writeCredentials(path, 'version: 1\nrecords:\n'
      + '  llm-pi-ai/openai-codex:\n    kind: grant\n    payload:\n      v: 1\n'
      + '  llm-pi-ai/amazon-bedrock:\n    kind: api-key\n    env:\n      AWS_PROFILE: prod\n')

    await put(ctx, CODEX, { kind: 'grant', payload: { v: 2 } })

    expect(await ctx.credentials.readRecord(BEDROCK)).toEqual({ kind: 'api-key', env: { AWS_PROFILE: 'prod' } })
    expect(await ctx.credentials.readRecord(CODEX)).toEqual({ kind: 'grant', payload: { v: 2 } })
  })

  it('keeps both records when two providers write the same document concurrently', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const first = await boot({ path, watch: false })
    const second = await boot({ path, watch: false })

    await Promise.all([
      (async () => {
        for (const v of [1, 2, 3]) await put(first, CODEX, { kind: 'grant', payload: { v } })
      })(),
      (async () => {
        for (const v of [1, 2, 3]) await put(second, BEDROCK, { kind: 'grant', payload: { v } })
      })(),
    ])

    const reread = await boot({ path, watch: false })
    expect(await reread.credentials.readRecord(CODEX)).toEqual({ kind: 'grant', payload: { v: 3 } })
    expect(await reread.credentials.readRecord(BEDROCK)).toEqual({ kind: 'grant', payload: { v: 3 } })
  })

  it('enumerates stored records by address and tag, never by value', async () => {
    const dir = await tempDir()
    const ctx = await boot({ path: join(dir, '.credentials.yaml'), watch: false })
    await put(ctx, CODEX, { kind: 'grant', payload: { secret: 'do-not-list' } })
    await put(ctx, BEDROCK, { kind: 'api-key', key: 'sk-listed' })

    const listed = await ctx.credentials.listRecords()

    expect(listed).toEqual([{ key: CODEX, kind: 'grant' }, { key: BEDROCK, kind: 'api-key' }])
    expect(JSON.stringify(listed)).not.toContain('do-not-list')
    expect(JSON.stringify(listed)).not.toContain('sk-listed')
  })

  it('refuses a payload this document could not read back', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false })

    // An owner's SDK value that YAML would either lose or re-read as another
    // type. Rejecting on the way in is what keeps the round-trip promise
    // keepable; a rejected value must also leave nothing behind.
    for (const payload of [{ at: new Date(0) }, { size: 1n }, { run: () => undefined }, { ratio: Number.NaN }]) {
      await expect(put(ctx, CODEX, { kind: 'grant', payload }))
        .rejects.toThrow(/record "llm-pi-ai\/openai-codex" payload/)
    }
    expect(await ctx.credentials.readRecord(CODEX)).toBeUndefined()
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a sparse grant payload that serialization would fill with null', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false })
    const payload: unknown[] = []
    payload.length = 1

    await expect(put(ctx, CODEX, { kind: 'grant', payload })).rejects.toThrow(/payload/)
    await expect(ctx.credentials.readRecord(CODEX)).resolves.toBeUndefined()
  })

  it('refuses an enumerable array property that serialization would omit', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false })
    const payload: unknown[] = ['kept']
    Object.assign(payload, { omitted: 'value' })

    await expect(put(ctx, CODEX, { kind: 'grant', payload })).rejects.toThrow(/payload/)
    await expect(ctx.credentials.readRecord(CODEX)).resolves.toBeUndefined()
  })

  it('rejects enumerable payload getters without invoking them', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false })
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
    const restarted = await boot({ path, watch: false })
    await expect(restarted.credentials.readRecord(CODEX)).resolves.toBeUndefined()
    await expect(restarted.credentials.readRecord(BEDROCK)).resolves.toBeUndefined()
  })

  it('rejects an own non-enumerable toJSON without invoking it', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false })
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
    const restarted = await boot({ path, watch: false })
    await expect(restarted.credentials.readRecord(CODEX)).resolves.toBeUndefined()
  })

  it('rejects an inherited toJSON without invoking it', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false })
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
    const restarted = await boot({ path, watch: false })
    await expect(restarted.credentials.readRecord(CODEX)).resolves.toBeUndefined()
  })

  it('does not invoke a global toJSON hook while storing an api-key record', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false })
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
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false })
    const payload = new (class extends Array<unknown> {})()
    payload.push('kept')

    await expect(put(ctx, CODEX, { kind: 'grant', payload })).rejects.toThrow(/payload/)
    await expect(ctx.credentials.readRecord(CODEX)).resolves.toBeUndefined()
  })

  it('round-trips a non-callable toJSON data field', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false })
    const record = { kind: 'grant', payload: { toJSON: 'literal', value: 'kept' } } as const

    await put(ctx, CODEX, record)

    const restarted = await boot({ path, watch: false })
    await expect(restarted.credentials.readRecord(CODEX)).resolves.toEqual(record)
  })

  it('refuses a symbol-keyed payload property that serialization would omit', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false })
    const payload = { visible: 'kept', [Symbol('omitted')]: 'value' }

    await expect(put(ctx, CODEX, { kind: 'grant', payload })).rejects.toThrow(/payload/)

    const restarted = await boot({ path, watch: false })
    await expect(restarted.credentials.readRecord(CODEX)).resolves.toBeUndefined()
  })

  it('refuses a non-enumerable payload data property that serialization would omit', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false })
    const payload = { visible: 'kept' }
    Object.defineProperty(payload, 'omitted', { value: 'value' })

    await expect(put(ctx, CODEX, { kind: 'grant', payload })).rejects.toThrow(/payload/)

    const restarted = await boot({ path, watch: false })
    await expect(restarted.credentials.readRecord(CODEX)).resolves.toBeUndefined()
  })

  it('sanitizes payload reflection trap failures without committing', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false })
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

    const restarted = await boot({ path, watch: false })
    await expect(restarted.credentials.readRecord(CODEX)).resolves.toBeUndefined()
  })

  it('refuses -0 rather than persisting it as 0', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false })

    await expect(put(ctx, CODEX, { kind: 'grant', payload: { offset: -0 } })).rejects.toThrow(/payload/)

    const restarted = await boot({ path, watch: false })
    await expect(restarted.credentials.readRecord(CODEX)).resolves.toBeUndefined()
  })

  it('refuses an api-key record this document could not read back', async () => {
    const dir = await tempDir()
    const path = join(dir, '.credentials.yaml')
    const ctx = await boot({ path, watch: false })

    // The same admission rule as the read path: an api-key record parseRecord
    // would reject at the next boot is refused before it is rendered, so the
    // current process can never report a success the next one refuses to load.
    await expect(put(ctx, CODEX, { kind: 'api-key', key: '' }))
      .rejects.toThrow(/empty key/)
    await expect(put(ctx, CODEX, { kind: 'api-key', env: { 'not a name': 'value' } }))
      .rejects.toThrow(/must match/)
    await expect(put(ctx, CODEX, { kind: 'api-key', env: { AWS_REGION: '' } }))
      .rejects.toThrow(/non-empty string/)
    expect(await ctx.credentials.readRecord(CODEX)).toBeUndefined()
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses record writes once disposed', async () => {
    const dir = await tempDir()
    const ctx = new Context()
    const fiber = ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
    await fiber
    await put(ctx, CODEX, { kind: 'grant', payload: { expires: 1 } })
    const credentials = ctx.credentials
    await fiber.dispose()

    await expect(credentials.describeRecord(CODEX))
      .resolves.toEqual({ configured: true, kind: 'grant', writable: false })
    await expect(credentials.describeRecord(BEDROCK)).resolves.toEqual({ configured: false, writable: false })
    await expect(credentials.modifyRecord(CODEX, () => Promise.resolve({ kind: 'grant', payload: 1 })))
      .rejects.toThrow(/disposed/)
    await expect(credentials.deleteRecord(CODEX)).rejects.toThrow(/disposed/)
  })
})
