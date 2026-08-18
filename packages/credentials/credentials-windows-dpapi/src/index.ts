/**
 * Windows CNG DPAPI `LOCAL=user` Credential Provider. The provider persists a
 * versioned JSON document containing only opaque DPAPI-NG ciphertext records,
 * resolves each value at its operation boundary, and never falls back to an
 * ambient, plaintext, or machine-scoped source.
 * @module @deepseek-ai/dsh-credentials-windows-dpapi
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  CREDENTIAL_PROTECTION_LOCAL_USER_TRUST,
  CredentialProvider,
  credentialRef,
} from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { probeCurrentUser, protectCurrentUser, unprotectCurrentUser } from './dpapi.ts'

/** Basename of the encrypted credentials document inside the Harness home. */
export const WINDOWS_DPAPI_CREDENTIALS_FILENAME = '.credentials.dpapi.json'

const DOCUMENT_VERSION = 1
const RECORD_KIND = 'dpapi-ng-local-user'
const SOURCE = 'windows-dpapi-current-user'
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/** Plugin config: the Host-local encrypted document location. */
export interface Config {
  /** Encrypted document path; defaults under the Harness home. */
  path?: string
  /** Harness home used when `path` is omitted; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
}

/** Fully resolved provider parameters. */
interface ResolvedSpec {
  filename: string
}

interface StoredRecord {
  kind: typeof RECORD_KIND
  ciphertext: string
}

/**
 * Resolve an explicit path or the fixed document beneath the Harness home.
 * @param config - provider path configuration.
 * @returns absolute ciphertext document filename.
 */
export function resolveSpec(config: Config): ResolvedSpec {
  return {
    filename: resolve(config.path ?? join(resolveDshHome(config.dshHome), WINDOWS_DPAPI_CREDENTIALS_FILENAME)),
  }
}

/** Whether an I/O failure means the document is absent. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Require an object with exactly the named keys. */
function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

/** Parse the versioned ciphertext document without ever quoting its contents in an error. */
function parseCredentialDocument(text: string, filename: string): Map<CredentialRef, StoredRecord> {
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch {
    throw new Error(`credentials-windows-dpapi: invalid JSON document at ${filename}`)
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)
    || !hasExactKeys(root, ['records', 'version'])) {
    throw new Error(`credentials-windows-dpapi: ${filename} must contain only version and records`)
  }
  const document = root as { version?: unknown; records?: unknown }
  if (document.version !== DOCUMENT_VERSION) {
    throw new Error(`credentials-windows-dpapi: unsupported document version at ${filename}`)
  }
  if (typeof document.records !== 'object' || document.records === null || Array.isArray(document.records)) {
    throw new Error(`credentials-windows-dpapi: records in ${filename} must be an object`)
  }
  const records = new Map<CredentialRef, StoredRecord>()
  for (const [rawRef, rawRecord] of Object.entries(document.records as Record<string, unknown>)) {
    let ref: CredentialRef
    try {
      ref = credentialRef(rawRef)
    } catch {
      throw new Error(`credentials-windows-dpapi: ${filename} contains an invalid credential reference`)
    }
    if (typeof rawRecord !== 'object' || rawRecord === null || Array.isArray(rawRecord)
      || !hasExactKeys(rawRecord, ['ciphertext', 'kind'])) {
      throw new Error(`credentials-windows-dpapi: record "${ref}" in ${filename} is invalid`)
    }
    const record = rawRecord as { kind?: unknown; ciphertext?: unknown }
    if (record.kind !== RECORD_KIND) {
      throw new Error(`credentials-windows-dpapi: record "${ref}" in ${filename} is not CNG DPAPI LOCAL=user`)
    }
    if (typeof record.ciphertext !== 'string' || record.ciphertext.length === 0
      || !BASE64_PATTERN.test(record.ciphertext)
      || Buffer.from(record.ciphertext, 'base64').toString('base64') !== record.ciphertext) {
      throw new Error(`credentials-windows-dpapi: record "${ref}" in ${filename} has invalid ciphertext`)
    }
    records.set(ref, { kind: RECORD_KIND, ciphertext: record.ciphertext })
  }
  return records
}

/** Render a deterministic version-1 document. */
function renderCredentialDocument(records: ReadonlyMap<CredentialRef, StoredRecord>): string {
  return `${JSON.stringify({
    version: DOCUMENT_VERSION,
    records: Object.fromEntries([...records.entries()].sort(([left], [right]) => left.localeCompare(right))),
  }, null, 2)}\n`
}

/** Read and validate the document; absence is an empty store. */
async function readCredentialDocument(filename: string): Promise<Map<CredentialRef, StoredRecord>> {
  let text: string
  try {
    text = await readFile(filename, 'utf8')
  } catch (error) {
    if (isENOENT(error)) return new Map()
    throw error
  }
  return parseCredentialDocument(text, filename)
}

/** Windows CNG DPAPI `LOCAL=user` implementation of `ctx.credentials`. */
export class WindowsDpapiCredentialProvider extends CredentialProvider {
  static Config: z<Config> = z.object({
    path: z.string(),
    dshHome: z.string(),
  })

  private readonly spec: ResolvedSpec
  private operations: Promise<void> = Promise.resolve()
  private closed = false

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    this.spec = resolveSpec(config)
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    /* v8 ignore next 2 -- Linux executes the platform rejection peer; this Windows lane executes the Provider. */
    if (process.platform !== 'win32') {
      throw new Error('credentials-windows-dpapi requires Windows')
    }
    await readCredentialDocument(this.spec.filename)
    yield async () => {
      this.closed = true
      await this.operations
    }
  }

  override async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const record = (await readCredentialDocument(this.spec.filename)).get(ref)
    if (record === undefined) return undefined
    let value: string
    try {
      value = unprotectCurrentUser(record.ciphertext)
    } catch {
      throw new Error(`credentials-windows-dpapi: cannot decrypt "${ref}" for the current Windows user`)
    }
    return { value, source: SOURCE, protectionLevel: CREDENTIAL_PROTECTION_LOCAL_USER_TRUST }
  }

  override async describe(ref: CredentialRef): Promise<CredentialInfo> {
    const record = (await readCredentialDocument(this.spec.filename)).get(ref)
    if (record === undefined) {
      return {
        ref,
        configured: false,
        protectionLevel: CREDENTIAL_PROTECTION_LOCAL_USER_TRUST,
        writable: !this.closed,
        health: 'missing',
        observedAt: Date.now(),
      }
    }
    let available = false
    try {
      available = probeCurrentUser(record.ciphertext)
    } catch {
      // A copied, corrupted, or differently scoped blob is a safe health
      // observation. resolve() retains the exact fail-loud operation error.
    }
    return {
      ref,
      configured: true,
      source: SOURCE,
      protectionLevel: CREDENTIAL_PROTECTION_LOCAL_USER_TRUST,
      writable: !this.closed,
      health: available ? 'available' : 'unavailable',
      observedAt: Date.now(),
    }
  }

  override async set(ref: CredentialRef, value: string): Promise<void> {
    if (this.closed) throw new Error(`credentials-windows-dpapi is disposed: cannot set "${ref}"`)
    if (value.length === 0) {
      throw new Error(`credentials-windows-dpapi: an empty value cannot be stored for "${ref}"; use unset`)
    }
    let ciphertext: string
    try {
      ciphertext = protectCurrentUser(value)
    } catch {
      throw new Error(`credentials-windows-dpapi: cannot protect "${ref}" for the current Windows user`)
    }
    await this.write(ref, { kind: RECORD_KIND, ciphertext })
  }

  override async unset(ref: CredentialRef): Promise<void> {
    await this.write(ref, undefined)
  }

  /** Queue one exclusive document write behind every earlier write. */
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const task = this.operations.then(operation)
    this.operations = task.then(() => undefined, () => undefined)
    return task
  }

  /** Commit one record replacement or deletion under the cross-process writer lock. */
  private async write(ref: CredentialRef, record: StoredRecord | undefined): Promise<void> {
    const verb = record === undefined ? 'unset' : 'set'
    if (this.closed) throw new Error(`credentials-windows-dpapi is disposed: cannot ${verb} "${ref}"`)
    await this.enqueue(async () => {
      if (this.closed) {
        throw new Error(`credentials-windows-dpapi was disposed before the queued "${ref}" ${verb} ran`)
      }
      await mkdir(dirname(this.spec.filename), { recursive: true, mode: 0o700 })
      await withFileLock(this.spec.filename, async () => {
        const records = await readCredentialDocument(this.spec.filename)
        if (record === undefined) {
          if (!records.delete(ref)) return
        } else {
          records.set(ref, record)
        }
        await writeFileAtomic(this.spec.filename, renderCredentialDocument(records), { mode: 0o600, dirMode: 0o700 })
        this.notifyUpdated(ref)
      })
    })
  }
}

export default WindowsDpapiCredentialProvider
