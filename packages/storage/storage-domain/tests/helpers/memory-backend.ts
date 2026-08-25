/**
 * In-memory {@link StorageBackend} test double implementing the full KvUnit
 * primitive set. Shared test infrastructure: the domain suite uses it to
 * exercise open/route/write semantics without touching disk, and the
 * workspace package's tests import it by relative path (it lives under
 * `tests/`, never `src/`, so it stays out of the published surface).
 *
 * Fidelity to the backend contract (`dsh-storage` `src/backend.ts`): version
 * stamping and `version-mismatch` on reopen, `malformed` never (memory cannot
 * corrupt), per-call atomicity trivially, `closed` after close, delete
 * idempotence. Media survive across backends through the shared `media` map
 * passed into the constructor, which simulates process restarts; stamp
 * `versions` directly to fabricate an on-medium version and force a
 * `version-mismatch` without a prior open.
 * @module
 */

import { StorageError } from '@deepseek-ai/dsh-storage'
import type {
  KvClosedUnitLease,
  KvClosedUnitMaterialization,
  KvClosedUnitOperations,
  KvFacet,
  KvUnit,
  KvUnitDescriptor,
  KvUnitSnapshot,
  StorageBackend,
} from '@deepseek-ai/dsh-storage'

/** One unit's medium: tables of records plus the global slot (`null` = never written). */
export interface MemoryMedium {
  tables: Map<string, Map<string, unknown>>
  global: unknown
}

/**
 * Shared media pool. Construct one and hand it to several
 * {@link MemoryStorageBackend} instances to simulate reopening the same
 * medium after a restart; `versions` holds the stamped unit versions and is
 * writable by tests to inject a mismatching on-medium version, and
 * `failNextWrites` injects write-primitive failures.
 */
export class MemoryMediaPool {
  /** Unit name → its records; a missing entry is a never-materialized unit. */
  readonly media = new Map<string, MemoryMedium>()
  /** Unit name → stamped version; tests may pre-stamp to force `version-mismatch`. */
  readonly versions = new Map<string, number>()
  /** Unit name → persisted global-slot capability. */
  readonly hasGlobals = new Map<string, boolean>()
  /**
   * When positive, that many subsequent write primitives (putRecord /
   * deleteRecord / setGlobal) reject without touching the medium, decrementing
   * per rejection. Negative path: callers assert their state is
   * untouched after a durability failure.
   */
  failNextWrites = 0
  /** Subsequent writes that mutate the medium and then report uncertain durability. */
  publishedFailureNextWrites = 0
  /** Subsequent writes that mutate the medium before reporting an unknown commit outcome. */
  unknownOutcomeNextWrites = 0

  /** Consume one injected failure, throwing in a rejected write's place. */
  consumeInjectedFailure(): void {
    if (this.failNextWrites > 0) {
      this.failNextWrites -= 1
      throw new Error('injected write failure')
    }
  }

  /** Report one injected post-publication failure after a write mutates the medium. */
  finishInjectedWrite(): void {
    if (this.publishedFailureNextWrites > 0) {
      this.publishedFailureNextWrites -= 1
      throw new StorageError(
        'durability-uncertain',
        'injected published write with uncertain durability',
      )
    }
    if (this.unknownOutcomeNextWrites > 0) {
      this.unknownOutcomeNextWrites -= 1
      throw new StorageError(
        'commit-outcome-unknown',
        'injected write with an unknown commit outcome',
      )
    }
  }
}

/** In-memory KV unit over one pooled medium. */
class MemoryKvUnit implements KvUnit {
  private closed = false

  constructor(
    private readonly pool: MemoryMediaPool,
    private readonly medium: MemoryMedium,
    private readonly descriptor: KvUnitDescriptor,
    private readonly onClose: () => void,
  ) {}

  private assertOpen(): void {
    if (this.closed) {
      throw new StorageError('closed', `memory unit '${this.descriptor.name}' is closed`)
    }
  }

  async loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    this.assertOpen()
    const tables: Record<string, Record<string, unknown>> = {}
    for (const table of this.descriptor.tables) {
      tables[table] = Object.fromEntries(this.medium.tables.get(table) ?? [])
    }
    return { tables, global: this.medium.global }
  }

  async putRecord(table: string, key: string, value: unknown): Promise<void> {
    this.assertOpen()
    this.pool.consumeInjectedFailure()
    let records = this.medium.tables.get(table)
    if (records === undefined) {
      records = new Map()
      this.medium.tables.set(table, records)
    }
    records.set(key, value)
    this.pool.finishInjectedWrite()
  }

  async deleteRecord(table: string, key: string): Promise<void> {
    this.assertOpen()
    this.pool.consumeInjectedFailure()
    this.medium.tables.get(table)?.delete(key)
    this.pool.finishInjectedWrite()
  }

  async setGlobal(value: unknown): Promise<void> {
    this.assertOpen()
    this.pool.consumeInjectedFailure()
    this.medium.global = value
    this.pool.finishInjectedWrite()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.onClose()
  }
}

/**
 * In-memory storage backend with a `kv` facet. Pass a shared
 * {@link MemoryMediaPool} to let a second instance reopen the same media;
 * omit it for a throwaway isolated pool.
 */
export class MemoryStorageBackend implements StorageBackend {
  readonly kv: KvFacet
  /** Optional test barrier invoked immediately after cold publication commits. */
  onMaterializeCommit?: () => void
  /** Cause returned with the next cold materialization's uncertain outcome. */
  materializationUncertainCause?: Error
  /** Make an uncertain materialization's stable readback report target absence. */
  materializationReadBackMissing = false
  /** Make materialization readback reject with an indeterminate medium failure. */
  materializationReadBackFailure?: Error
  private readonly openUnits = new Set<string>()
  private readonly reservedUnits = new Set<string>()
  private readonly coldOperations = new Set<Promise<unknown>>()
  private closed = false

  /**
   * @param pool - Media shared across instances; a fresh private pool when omitted.
   */
  constructor(readonly pool: MemoryMediaPool = new MemoryMediaPool()) {
    const closed: KvClosedUnitOperations = {
      withReservedUnit: <T>(name: string, signal: AbortSignal, operation: (lease: KvClosedUnitLease) => Promise<T>) => {
        try {
          signal.throwIfAborted()
          this.assertReservationAvailable(name)
        } catch (error) {
          return Promise.reject(asError(error))
        }
        this.reservedUnits.add(name)
        const completion = Promise.withResolvers<undefined>()
        this.coldOperations.add(completion.promise)
        let active = true
        const assertActive = (): void => {
          if (!active) throw new StorageError('closed', `memory unit '${name}' reservation is closed`)
        }
        const inspect = async (observeCancellation: boolean) => {
          assertActive()
          if (observeCancellation) signal.throwIfAborted()
          const version = this.pool.versions.get(name)
          if (version === undefined) return undefined
          const medium = this.pool.media.get(name)
          if (medium === undefined) {
            throw new StorageError('malformed-medium', `memory unit '${name}' has no contents`)
          }
          const hasGlobal = this.pool.hasGlobals.get(name)
          if (hasGlobal === undefined) {
            throw new StorageError('malformed-medium', `memory unit '${name}' has no global-layout metadata`)
          }
          return {
            name,
            version,
            hasGlobal,
            tables: [...medium.tables.keys()].sort(),
          }
        }
        const read = async (descriptor: KvUnitDescriptor, observeCancellation: boolean): Promise<KvUnitSnapshot> => {
          assertLeaseName(name, descriptor)
          const inspection = await inspect(observeCancellation)
          if (inspection === undefined) {
            throw new StorageError('unit-not-found', `memory unit '${descriptor.name}' does not exist`)
          }
          assertExactDescriptor(descriptor, inspection)
          return snapshotFromMemory(this.pool, descriptor)
        }
        const lease: KvClosedUnitLease = {
          name,
          inspect: () => inspect(true),
          read: descriptor => read(descriptor, true),
          materializeMissing: async (descriptor, snapshot): Promise<KvClosedUnitMaterialization> => {
            assertActive()
            signal.throwIfAborted()
            assertLeaseName(name, descriptor)
            if (this.pool.versions.has(name) || this.pool.media.has(name)) {
              throw new StorageError('target-exists', `memory unit '${name}' already exists`)
            }
            const medium = snapshotToMemory(descriptor, snapshot)
            signal.throwIfAborted()
            this.pool.versions.set(name, descriptor.version)
            this.pool.hasGlobals.set(name, descriptor.hasGlobal)
            this.pool.media.set(name, medium)
            this.onMaterializeCommit?.()
            const readBack = async (): Promise<KvUnitSnapshot | undefined> => {
              assertActive()
              if (this.materializationReadBackFailure !== undefined) {
                throw this.materializationReadBackFailure
              }
              if (this.materializationReadBackMissing) return undefined
              return await read(descriptor, false)
            }
            if (this.materializationUncertainCause !== undefined) {
              return {
                outcome: 'uncertain',
                cause: this.materializationUncertainCause,
                readBack,
              }
            }
            return {
              outcome: 'durable',
              readBack: async () => {
                const value = await readBack()
                if (value === undefined) {
                  throw new StorageError('unit-not-found', `memory unit '${descriptor.name}' does not exist`)
                }
                return value
              },
            }
          },
        }
        const running = (async () => {
          try {
            return await operation(lease)
          } finally {
            active = false
            this.reservedUnits.delete(name)
            this.coldOperations.delete(completion.promise)
            completion.resolve(undefined)
          }
        })()
        return running
      },
    }
    this.kv = {
      closed,
      open: async (descriptor: KvUnitDescriptor): Promise<KvUnit> => {
        if (this.closed) {
          throw new StorageError('closed', 'memory backend is closed')
        }
        // Double-open is a caller bug per the backend contract; no dedicated
        // StorageError code exists for it, so a plain Error is correct.
        if (this.reservedUnits.has(descriptor.name)) {
          throw new StorageError('unit-open', `memory unit '${descriptor.name}' is reserved by a closed operation`)
        }
        if (this.openUnits.has(descriptor.name)) {
          throw new Error(`memory unit '${descriptor.name}' is already open (double-open is a caller bug)`)
        }
        const stamped = this.pool.versions.get(descriptor.name)
        if (stamped === undefined) {
          this.pool.versions.set(descriptor.name, descriptor.version)
          this.pool.hasGlobals.set(descriptor.name, descriptor.hasGlobal)
        } else if (stamped !== descriptor.version) {
          throw new StorageError(
            'version-mismatch',
            `memory unit '${descriptor.name}' is stamped v${stamped}, descriptor wants v${descriptor.version}`,
          )
        } else if (this.pool.hasGlobals.get(descriptor.name) !== descriptor.hasGlobal) {
          throw new StorageError('malformed-medium', `memory unit '${descriptor.name}' has a different global layout`)
        }
        let medium = this.pool.media.get(descriptor.name)
        if (medium === undefined) {
          medium = {
            tables: new Map(descriptor.tables.map(table => [table, new Map<string, unknown>()])),
            global: null,
          }
          this.pool.media.set(descriptor.name, medium)
        } else {
          assertExactTables(descriptor.name, descriptor.tables, [...medium.tables.keys()])
        }
        this.openUnits.add(descriptor.name)
        return new MemoryKvUnit(this.pool, medium, descriptor, () => this.openUnits.delete(descriptor.name))
      },
    }
  }

  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.coldOperations])
    this.openUnits.clear()
  }

  private assertReservationAvailable(name: string): void {
    if (this.closed) throw new StorageError('closed', 'memory backend is closed')
    if (this.openUnits.has(name) || this.reservedUnits.has(name)) {
      throw new StorageError('unit-open', `memory unit '${name}' has a live handle or reservation`)
    }
  }
}

function snapshotFromMemory(pool: MemoryMediaPool, descriptor: KvUnitDescriptor): KvUnitSnapshot {
  const medium = pool.media.get(descriptor.name)
  if (medium === undefined) {
    throw new StorageError('malformed-medium', `memory unit '${descriptor.name}' has no contents`)
  }
  const tables: Record<string, Record<string, unknown>> = {}
  for (const table of descriptor.tables) {
    tables[table] = Object.fromEntries(
      [...(medium.tables.get(table) ?? [])].map(([key, value]) => [key, structuredClone(value)]),
    )
  }
  return { tables, global: structuredClone(medium.global) }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error('memory backend operation failed', { cause: value })
}

function assertLeaseName(name: string, descriptor: KvUnitDescriptor): void {
  if (descriptor.name !== name) {
    throw new StorageError('malformed-medium', `reservation for '${name}' cannot access unit '${descriptor.name}'`)
  }
}

function assertExactDescriptor(
  descriptor: KvUnitDescriptor,
  inspection: { version: number; hasGlobal: boolean; tables: readonly string[] },
): void {
  if (inspection.version !== descriptor.version) {
    throw new StorageError(
      'version-mismatch',
      `memory unit '${descriptor.name}' is stamped v${inspection.version}, descriptor wants v${descriptor.version}`,
    )
  }
  if (inspection.hasGlobal !== descriptor.hasGlobal) {
    throw new StorageError('malformed-medium', `memory unit '${descriptor.name}' has a different global layout`)
  }
  assertExactTables(descriptor.name, descriptor.tables, inspection.tables)
}

function assertExactTables(name: string, expected: readonly string[], actual: readonly string[]): void {
  const left = [...actual].sort()
  const right = [...expected].sort()
  if (left.length !== right.length || left.some((table, index) => table !== right[index])) {
    throw new StorageError('malformed-medium', `memory unit '${name}' has unexpected tables`)
  }
}

function snapshotToMemory(descriptor: KvUnitDescriptor, snapshot: KvUnitSnapshot): MemoryMedium {
  const actualTables = Object.keys(snapshot.tables).sort()
  const expectedTables = [...descriptor.tables].sort()
  if (JSON.stringify(actualTables) !== JSON.stringify(expectedTables)) {
    throw new StorageError('malformed-medium', `memory unit '${descriptor.name}' snapshot has unexpected tables`)
  }
  if (!descriptor.hasGlobal && snapshot.global !== null) {
    throw new StorageError('malformed-medium', `memory unit '${descriptor.name}' snapshot has an undeclared global`)
  }
  return {
    tables: new Map(descriptor.tables.map(table => [
      table,
      new Map(Object.entries(structuredClone(snapshot.tables[table] ?? {}))),
    ])),
    global: structuredClone(snapshot.global),
  }
}
