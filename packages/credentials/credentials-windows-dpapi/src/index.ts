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
  parseCredentialKey,
} from '@deepseek-ai/dsh-credentials'
import { normalizeCredentialRecord } from '@deepseek-ai/dsh-credentials/record-normalization'
import type {
  CredentialInfo,
  CredentialKey,
  CredentialRecord,
  CredentialRecordEntry,
  CredentialRecordInfo,
  CredentialRef,
  ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { probeCurrentUser, protectCurrentUser, unprotectCurrentUser } from './dpapi.ts'

/** Basename of the encrypted credentials document inside the Harness home. */
export const WINDOWS_DPAPI_CREDENTIALS_FILENAME = '.credentials.dpapi.json'

const DOCUMENT_VERSION = 2
const RECORD_KIND = 'dpapi-ng-local-user'
const SOURCE = 'windows-dpapi-current-user'
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/**
 * Record mutations may hold the shared document lock across one provider
 * refresh request. Every writer uses the same wait bound so a reference write
 * or record delete does not fail merely because it met that valid holder.
 */
const DOCUMENT_LOCK_WAIT_MS = 30_000

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

interface StoredCiphertext {
  kind: typeof RECORD_KIND
  ciphertext: string
}

interface StoredCredentialRecord extends StoredCiphertext {
  recordKind: CredentialRecord['kind']
}

interface CredentialDocument {
  refs: Map<CredentialRef, StoredCiphertext>
  records: Map<CredentialKey, StoredCredentialRecord>
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

/** Admit one ciphertext entry without ever quoting its ciphertext. */
function parseCiphertext(
  rawRecord: unknown,
  expectedKeys: readonly string[],
  subject: string,
  filename: string,
): StoredCiphertext {
  if (typeof rawRecord !== 'object' || rawRecord === null || Array.isArray(rawRecord)
    || !hasExactKeys(rawRecord, expectedKeys)) {
    throw new Error(`credentials-windows-dpapi: ${subject} in ${filename} is invalid`)
  }
  const record = rawRecord as { kind?: unknown; ciphertext?: unknown }
  if (record.kind !== RECORD_KIND) {
    throw new Error(`credentials-windows-dpapi: ${subject} in ${filename} is not CNG DPAPI LOCAL=user`)
  }
  if (typeof record.ciphertext !== 'string' || record.ciphertext.length === 0
    || !BASE64_PATTERN.test(record.ciphertext)
    || Buffer.from(record.ciphertext, 'base64').toString('base64') !== record.ciphertext) {
    throw new Error(`credentials-windows-dpapi: ${subject} in ${filename} has invalid ciphertext`)
  }
  return { kind: RECORD_KIND, ciphertext: record.ciphertext }
}

/** Require one document section to be an object mapping. */
function parseSection(section: unknown, name: string, filename: string): Record<string, unknown> {
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    throw new Error(`credentials-windows-dpapi: ${name} in ${filename} must be an object`)
  }
  return section as Record<string, unknown>
}

/** Parse the versioned ciphertext document without ever quoting credential data in an error. */
function parseCredentialDocument(text: string, filename: string): CredentialDocument {
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch {
    throw new Error(`credentials-windows-dpapi: invalid JSON document at ${filename}`)
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)
    || !hasExactKeys(root, ['records', 'refs', 'version'])) {
    throw new Error(`credentials-windows-dpapi: ${filename} must contain only version, refs, and records`)
  }
  const document = root as { version?: unknown; refs?: unknown; records?: unknown }
  if (document.version !== DOCUMENT_VERSION) {
    throw new Error(`credentials-windows-dpapi: unsupported document version at ${filename}`)
  }
  const refs = new Map<CredentialRef, StoredCiphertext>()
  for (const [rawRef, rawRecord] of Object.entries(parseSection(document.refs, 'refs', filename))) {
    let ref: CredentialRef
    try {
      ref = credentialRef(rawRef)
    } catch {
      throw new Error(`credentials-windows-dpapi: ${filename} contains an invalid credential reference`)
    }
    refs.set(ref, parseCiphertext(rawRecord, ['ciphertext', 'kind'], `reference "${ref}"`, filename))
  }
  const records = new Map<CredentialKey, StoredCredentialRecord>()
  for (const [rawKey, rawRecord] of Object.entries(parseSection(document.records, 'records', filename))) {
    let key: CredentialKey
    try {
      key = parseCredentialKey(rawKey)
    } catch {
      throw new Error(`credentials-windows-dpapi: ${filename} contains an invalid credential key`)
    }
    const encrypted = parseCiphertext(
      rawRecord,
      ['ciphertext', 'kind', 'recordKind'],
      `record "${key}"`,
      filename,
    )
    const recordKind = (rawRecord as { recordKind?: unknown }).recordKind
    if (recordKind !== 'api-key' && recordKind !== 'grant') {
      throw new Error(`credentials-windows-dpapi: record "${key}" in ${filename} has an invalid credential kind`)
    }
    records.set(key, { ...encrypted, recordKind })
  }
  return { refs, records }
}

/** Convert a sorted map to the object spelling used by the ciphertext document. */
function sortedEntries<T>(entries: ReadonlyMap<string, T>): Record<string, T> {
  return Object.fromEntries([...entries.entries()].sort(([left], [right]) => left.localeCompare(right)))
}

/** Render a deterministic version-2 document. */
function renderCredentialDocument(document: CredentialDocument): string {
  return `${JSON.stringify({
    version: DOCUMENT_VERSION,
    refs: sortedEntries(document.refs),
    records: sortedEntries(document.records),
  }, null, 2)}\n`
}

/** Read and validate the document; absence is an empty store. */
async function readCredentialDocument(filename: string): Promise<CredentialDocument> {
  let text: string
  try {
    text = await readFile(filename, 'utf8')
  } catch (error) {
    if (isENOENT(error)) return { refs: new Map(), records: new Map() }
    throw error
  }
  return parseCredentialDocument(text, filename)
}

interface SerializedCredentialRecord {
  normalized: CredentialRecord
  plaintext: string
}

/** Validate and serialize a record before it crosses the durable ciphertext boundary. */
function serializeCredentialRecord(key: CredentialKey, record: CredentialRecord): SerializedCredentialRecord {
  const normalized = normalizeCredentialRecord(record, `credentials-windows-dpapi: record "${key}"`)
  return { normalized, plaintext: JSON.stringify(normalized) }
}

/** Parse and validate one decrypted durable record without quoting any of its values. */
function parseDecryptedRecord(key: CredentialKey, text: string, expectedKind: CredentialRecord['kind']): CredentialRecord {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`credentials-windows-dpapi: decrypted record "${key}" is not valid JSON`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`credentials-windows-dpapi: decrypted record "${key}" must be an object`)
  }
  const normalized = normalizeCredentialRecord(value, `credentials-windows-dpapi: record "${key}"`)
  if (normalized.kind !== expectedKind) {
    throw new Error(`credentials-windows-dpapi: decrypted record "${key}" does not match its stored kind`)
  }
  return normalized
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
    const record = (await readCredentialDocument(this.spec.filename)).refs.get(ref)
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
    const record = (await readCredentialDocument(this.spec.filename)).refs.get(ref)
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
    await this.writeReference(ref, { kind: RECORD_KIND, ciphertext })
  }

  override async unset(ref: CredentialRef): Promise<void> {
    await this.writeReference(ref, undefined)
  }

  override async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    const stored = (await readCredentialDocument(this.spec.filename)).records.get(key)
    if (stored === undefined) return undefined
    return this.decryptRecord(key, stored)
  }

  override async describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const stored = (await readCredentialDocument(this.spec.filename)).records.get(key)
    if (stored === undefined) return { configured: false, writable: !this.closed }
    return { configured: true, kind: stored.recordKind, writable: !this.closed }
  }

  override async listRecords(): Promise<readonly CredentialRecordEntry[]> {
    const { records } = await readCredentialDocument(this.spec.filename)
    return [...records].map(([key, record]) => ({ key, kind: record.recordKind }))
  }

  override async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    if (this.closed) throw new Error(`credentials-windows-dpapi is disposed: cannot modify "${key}"`)
    return this.enqueue(async () => {
      if (this.closed) {
        throw new Error(`credentials-windows-dpapi was disposed before the queued "${key}" modify ran`)
      }
      await mkdir(dirname(this.spec.filename), { recursive: true, mode: 0o700 })
      return withFileLock(this.spec.filename, async () => {
        const document = await readCredentialDocument(this.spec.filename)
        const stored = document.records.get(key)
        const current = stored === undefined ? undefined : this.decryptRecord(key, stored)
        const mutationInput = current === undefined
          ? undefined
          : normalizeCredentialRecord(current, `credentials-windows-dpapi: record "${key}"`)
        const next = await mutate(mutationInput)
        if (next === undefined) {
          return current === undefined
            ? undefined
            : normalizeCredentialRecord(current, `credentials-windows-dpapi: record "${key}"`)
        }
        const { normalized, plaintext } = serializeCredentialRecord(key, next)
        let ciphertext: string
        try {
          ciphertext = protectCurrentUser(plaintext)
        } catch {
          throw new Error(`credentials-windows-dpapi: cannot protect record "${key}" for the current Windows user`)
        }
        document.records.set(key, { kind: RECORD_KIND, recordKind: normalized.kind, ciphertext })
        await writeFileAtomic(this.spec.filename, renderCredentialDocument(document), { mode: 0o600, dirMode: 0o700 })
        this.notifyRecordUpdated(key)
        return normalized
      }, { waitMs: DOCUMENT_LOCK_WAIT_MS })
    })
  }

  override async deleteRecord(key: CredentialKey): Promise<void> {
    if (this.closed) throw new Error(`credentials-windows-dpapi is disposed: cannot delete "${key}"`)
    await this.enqueue(async () => {
      if (this.closed) {
        throw new Error(`credentials-windows-dpapi was disposed before the queued "${key}" delete ran`)
      }
      await mkdir(dirname(this.spec.filename), { recursive: true, mode: 0o700 })
      await withFileLock(this.spec.filename, async () => {
        const document = await readCredentialDocument(this.spec.filename)
        if (!document.records.delete(key)) return
        await writeFileAtomic(this.spec.filename, renderCredentialDocument(document), { mode: 0o600, dirMode: 0o700 })
        this.notifyRecordUpdated(key)
      }, { waitMs: DOCUMENT_LOCK_WAIT_MS })
    })
  }

  /** Queue one exclusive document write behind every earlier write. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operations.then(operation)
    this.operations = task.then(() => undefined, () => undefined)
    return task
  }

  /** Decrypt and validate one durable record while discarding native failure details. */
  private decryptRecord(key: CredentialKey, stored: StoredCredentialRecord): CredentialRecord {
    let plaintext: string
    try {
      plaintext = unprotectCurrentUser(stored.ciphertext)
    } catch {
      throw new Error(`credentials-windows-dpapi: cannot decrypt record "${key}" for the current Windows user`)
    }
    return parseDecryptedRecord(key, plaintext, stored.recordKind)
  }

  /** Commit one reference replacement or deletion under the cross-process writer lock. */
  private async writeReference(ref: CredentialRef, record: StoredCiphertext | undefined): Promise<void> {
    const verb = record === undefined ? 'unset' : 'set'
    if (this.closed) throw new Error(`credentials-windows-dpapi is disposed: cannot ${verb} "${ref}"`)
    await this.enqueue(async () => {
      if (this.closed) {
        throw new Error(`credentials-windows-dpapi was disposed before the queued "${ref}" ${verb} ran`)
      }
      await mkdir(dirname(this.spec.filename), { recursive: true, mode: 0o700 })
      await withFileLock(this.spec.filename, async () => {
        const document = await readCredentialDocument(this.spec.filename)
        if (record === undefined) {
          if (!document.refs.delete(ref)) return
        } else {
          document.refs.set(ref, record)
        }
        await writeFileAtomic(this.spec.filename, renderCredentialDocument(document), { mode: 0o600, dirMode: 0o700 })
        this.notifyUpdated(ref)
      }, { waitMs: DOCUMENT_LOCK_WAIT_MS })
    })
  }
}

export default WindowsDpapiCredentialProvider
