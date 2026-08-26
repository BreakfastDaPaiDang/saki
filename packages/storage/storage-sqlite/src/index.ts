/** SQLite `kv` backend with current-format serving and closed-unit migration access. @module */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { ClosedUnitReservations, StorageError, storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { KvFacet, KvUnit, KvUnitDescriptor, KvUnitSnapshot, StorageBackend } from '@deepseek-ai/dsh-storage'
import {
  SqliteClosedUnitOperations,
  SqliteWriterPoisoningError,
  assertMatchingInspection,
  inspectExistingDatabase,
  materializeV2,
  readCurrentDatabaseIfPresent,
  readExistingDatabase,
  validateDescriptor,
  validateUnitName,
} from './closed.ts'
import type { SqliteDatabaseAccess } from './closed.ts'
import type { SqliteMaterializationResult } from './closed.ts'
import {
  openDatabase,
  openExistingDatabaseReadonly,
  STORAGE_SQLITE_SCHEMA_VERSION,
  type JournalMode,
} from './schema.ts'
import { SqliteKvUnit } from './unit.ts'

export { STORAGE_SQLITE_SCHEMA_VERSION, type JournalMode } from './schema.ts'

/** Cordis plugin name. */
export const name = 'storage-sqlite'
/** The backend registers on the storage hub. */
export const inject = ['storage']

/** Plugin configuration. */
export interface Config {
  /** Storage registry name; defaults to `sqlite`. */
  backend?: string
  /**
   * Filesystem path to the SQLite database file. The special value `:memory:`
   * opens an in-process database. Relative paths resolve at backend
   * construction. Missing directories and files are created owner-only where
   * POSIX modes apply; existing path modes are preserved.
   */
  path: string
  /**
   * Durable SQLite `journal_mode`. `wal` is the default for local disks;
   * `delete`, `truncate`, and `persist` support filesystems where WAL shared
   * memory is unsuitable. `memory` and `off` are excluded because they do not
   * meet the backend durability guarantee.
   */
  journalMode?: JournalMode
}

/** Schemastery validator for {@link Config}. */
export const Config: z<Config> = z.object({
  backend: z.string().default('sqlite'),
  path: z.string().required(),
  journalMode: z.union(['wal', 'delete', 'truncate', 'persist'] as const).default('wal'),
})

/** SQLite storage backend over one lazily opened writer connection. */
export class SqliteStorageBackend implements StorageBackend {
  /** Key-value serving plus callback-scoped cold operations. */
  readonly kv: KvFacet

  private readonly path: string
  private readonly journalMode: JournalMode
  private ready: Promise<DatabaseSync> | undefined
  private readonly units = new Map<string, Promise<SqliteKvUnit>>()
  private readonly liveUnits = new Map<string, SqliteKvUnit>()
  private readonly cold = new ClosedUnitReservations()
  private writerPoison: Error | undefined
  private closeStarted = false
  private closing: Promise<void> | undefined

  /** @param config - Validated backend configuration. */
  constructor(config: Config) {
    this.path = config.path === ':memory:' ? config.path : resolve(config.path)
    this.journalMode = (config as Required<Config>).journalMode
    this.kv = {
      closed: new SqliteClosedUnitOperations(
        (unit, signal) => this.reserveClosedUnit(unit, signal),
        signal => this.acquireClosedRead(signal),
        signal => this.acquireClosedWrite(signal),
        (cause) => { this.poisonWriter(cause) },
      ),
      open: descriptor => this.openUnit(descriptor),
    }
  }

  private reserveClosedUnit(name: string, signal: AbortSignal): () => void {
    this.assertBackendOpen()
    signal.throwIfAborted()
    validateUnitName(name)
    if (this.units.has(name) || this.cold.has(name)) {
      throw new StorageError('unit-open', `kv unit '${name}' has a live, opening, or reserved handle`)
    }
    return this.cold.reserve(name)
  }

  private async acquireClosedRead(signal: AbortSignal): Promise<SqliteDatabaseAccess> {
    signal.throwIfAborted()
    if (this.path === ':memory:') {
      this.assertWriterHealthy()
      const ready = this.ready
      if (ready === undefined) {
        return { database: undefined, version: undefined, release: () => {} }
      }
      const database = await ready
      signal.throwIfAborted()
      this.assertWriterHealthy()
      return {
        database,
        version: STORAGE_SQLITE_SCHEMA_VERSION,
        release: () => {},
      }
    }
    const view = await openExistingDatabaseReadonly(this.path, signal)
    try {
      signal.throwIfAborted()
    } catch (error) {
      await view.close()
      throw error
    }
    return { database: view.database, version: view.version, release: () => view.close() }
  }

  private async acquireClosedWrite(signal: AbortSignal): Promise<SqliteDatabaseAccess> {
    signal.throwIfAborted()
    this.assertWriterHealthy()
    const database = await this.writableDatabase()
    signal.throwIfAborted()
    this.assertWriterHealthy()
    return {
      database,
      version: STORAGE_SQLITE_SCHEMA_VERSION,
      release: () => {},
    }
  }

  private writableDatabase(): Promise<DatabaseSync> {
    this.assertWriterHealthy()
    this.ready ??= openDatabase(this.path, this.journalMode)
    this.ready.catch(() => {})
    return this.ready
  }

  private openUnit(descriptor: KvUnitDescriptor): Promise<KvUnit> {
    try {
      this.assertBackendOpen()
      this.assertWriterHealthy()
      validateDescriptor(descriptor)
      if (this.cold.has(descriptor.name)) {
        throw new StorageError('unit-open', `kv unit '${descriptor.name}' is reserved by a closed-unit operation`)
      }
      if (this.units.has(descriptor.name)) {
        throw new Error(`kv unit '${descriptor.name}' is already open (double-open is a caller bug)`)
      }
      const pending = this.openCurrentUnit(descriptor)
      this.units.set(descriptor.name, pending)
      pending.catch(() => {
        // Double-open prevention keeps this promise as the sole slot owner
        // until it either publishes a unit or rejects here.
        this.units.delete(descriptor.name)
      })
      return pending
    } catch (error) {
      return Promise.reject(asError(error))
    }
  }

  private async openCurrentUnit(descriptor: KvUnitDescriptor): Promise<SqliteKvUnit> {
    const db = await this.writableDatabase()
    this.assertWriterHealthy()
    const snapshot = readCurrentDatabaseIfPresent(db, descriptor)
    if (snapshot === undefined) {
      let result: SqliteMaterializationResult
      try {
        result = materializeV2(db, descriptor, emptySnapshot(descriptor), new AbortController().signal)
      } catch (error) {
        if (error instanceof SqliteWriterPoisoningError) this.poisonWriter(error)
        throw error
      }
      if (result.outcome === 'uncertain') await this.rejectUncertainInitialization(descriptor, result.cause)
    }
    const unit = new SqliteKvUnit(db, descriptor, () => {
      this.units.delete(descriptor.name)
      this.liveUnits.delete(descriptor.name)
    }, () => { this.assertWriterHealthy() }, error => this.failOrdinaryWrite(error))
    if (this.closeStarted) {
      await unit.close()
      throw new StorageError('closed', 'sqlite storage backend closed while the unit was opening')
    }
    this.liveUnits.set(descriptor.name, unit)
    return unit
  }

  private async rejectUncertainInitialization(descriptor: KvUnitDescriptor, cause: Error): Promise<never> {
    this.poisonWriter(cause)
    const signal = new AbortController().signal
    let access: SqliteDatabaseAccess | undefined
    let result: Error
    try {
      access = await this.acquireClosedRead(signal)
      const inspection = inspectExistingDatabase(access.database, descriptor.name)
      if (inspection === undefined) {
        result = cause
      } else {
        assertMatchingInspection(descriptor, inspection)
        const snapshot = readExistingDatabase(access.database, descriptor)
        if (!isEmptySnapshot(snapshot)) {
          throw new Error(`kv unit '${descriptor.name}' differs from its attempted empty initialization`)
        }
        result = new StorageError(
          'durability-uncertain',
          `kv unit '${descriptor.name}' is visible but its SQLite COMMIT did not report success`,
          { cause },
        )
      }
    } catch (inspectionError) {
      result = new StorageError(
        'commit-outcome-unknown',
        `sqlite could not determine whether kv unit '${descriptor.name}' was initialized`,
        { cause: new AggregateError([cause, asError(inspectionError)], 'COMMIT and readback both failed') },
      )
    }
    try {
      await access?.release()
    } catch (cleanupError) {
      throw preserveCommitEvidenceAfterCleanup(result, cleanupError)
    }
    throw result
  }

  private failOrdinaryWrite(cause: Error): Error {
    const failure = new StorageError(
      'commit-outcome-unknown',
      'sqlite write statement failed after execution began',
      { cause },
    )
    this.poisonWriter(failure)
    return failure
  }

  private poisonWriter(cause: Error): void {
    this.writerPoison ??= new Error(
      'sqlite writer has indeterminate state and cannot be reused',
      { cause },
    )
  }

  private assertWriterHealthy(): void {
    if (this.writerPoison !== undefined) throw this.writerPoison
  }

  private assertBackendOpen(): void {
    if (this.closeStarted) throw new StorageError('closed', 'sqlite storage backend is closed')
  }

  /**
   * Drain admitted cold operations and open units, then close the writer.
   * @returns resolution after the backend reaches quiescence.
   */
  close(): Promise<void> {
    if (this.closing === undefined) {
      this.closeStarted = true
      this.closing = this.doClose()
    }
    return this.closing
  }

  private async doClose(): Promise<void> {
    const pendingUnits = [...this.units.values()]
    // SqliteKvUnit.close() marks each live unit closed synchronously.
    const unitClosures = [...this.liveUnits.values()].map(unit => unit.close())
    await Promise.allSettled(this.cold.settlements())
    await Promise.allSettled(pendingUnits)
    await Promise.allSettled(unitClosures)
    const ready = this.ready
    if (ready === undefined) return
    let db: DatabaseSync
    try {
      db = await ready
    } catch {
      // The failed writer never produced a resource to close.
      return
    }
    db.close()
  }
}

/**
 * Register one named SQLite backend; disposal unregisters before closing the medium.
 * @param ctx - Plugin context with the storage hub.
 * @param config - Validated backend configuration.
 */
export function apply(ctx: Context, config: Config) {
  const backend = new SqliteStorageBackend(config)
  const backendName = (config as Required<Config>).backend
  ctx.effect(() => {
    const dispose = ctx.storage.backend.register(backendName, backend)
    return async () => {
      dispose()
      await backend.close()
    }
  }, 'storage-sqlite.registerBackend')
  ctx.provide(storageBackendServiceKey(backendName), backend)
}

function emptySnapshot(descriptor: KvUnitDescriptor): KvUnitSnapshot {
  return {
    tables: Object.fromEntries(descriptor.tables.map(table => [table, {}])),
    global: null,
  }
}

function isEmptySnapshot(snapshot: KvUnitSnapshot): boolean {
  // readExistingDatabase constructs every table named by the same descriptor.
  return snapshot.global === null
    && Object.values(snapshot.tables).every(records => Object.keys(records).length === 0)
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function preserveCommitEvidenceAfterCleanup(primary: Error, cleanup: unknown): Error {
  const cause = new AggregateError([primary, asError(cleanup)], 'sqlite readback and cleanup both failed')
  if (primary instanceof StorageError
    && (primary.code === 'durability-uncertain' || primary.code === 'commit-outcome-unknown')) {
    return new StorageError(primary.code, primary.message, { cause })
  }
  return cause
}
