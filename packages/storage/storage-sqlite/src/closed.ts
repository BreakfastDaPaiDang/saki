/** Callback-scoped closed-unit operations for current and legacy SQLite media. @module */

import type { DatabaseSync } from 'node:sqlite'
import {
  cloneLosslessJsonValue,
  isKvUnitVersion,
  parseLosslessJsonValue,
  StorageError,
  stringifyLosslessJsonValue,
  UNIT_NAME_RE,
} from '@deepseek-ai/dsh-storage'
import type {
  KvClosedUnitMaterialization,
  KvClosedUnitInspection,
  KvClosedUnitLease,
  KvClosedUnitOperations,
  KvUnitDescriptor,
  KvUnitSnapshot,
} from '@deepseek-ai/dsh-storage'
import {
  decodeLegacyRecordKey,
  decodeRecordKey,
  decodeSqliteText,
  encodeRecordKey,
} from './key.ts'
import {
  LEGACY_STORAGE_SQLITE_SCHEMA_VERSION,
  STORAGE_SQLITE_SCHEMA_VERSION,
  createRecordTable,
  legacyRecordTableName,
  listUserSchemaObjects,
  recordTableName,
  validateLegacyV1Database,
  validateRecordTable,
  validateV2Database,
} from './schema.ts'

/** One operation-local database access handle. */
export interface SqliteDatabaseAccess {
  /** Existing database, or `undefined` for a missing read-only medium. */
  readonly database: DatabaseSync | undefined
  /** Physical version of the opened medium. */
  readonly version: number | undefined
  /** Close private read state; writable connections use a no-op. */
  release(): void | Promise<void>
}

type AcquireDatabase = (signal: AbortSignal) => Promise<SqliteDatabaseAccess>
type ReserveUnit = (name: string, signal: AbortSignal) => () => void
type PoisonWriter = (cause: Error) => void

/** Internal result of the explicit SQLite COMMIT decision. */
export type SqliteMaterializationResult =
  | { readonly outcome: 'durable' }
  | { readonly outcome: 'uncertain'; readonly cause: Error }

/** Failure proving that the current writer connection cannot be reused safely. */
export class SqliteWriterPoisoningError extends AggregateError {
  override readonly name = 'SqliteWriterPoisoningError'
}

/** SQLite implementation of the optional callback-scoped cold KV group. */
export class SqliteClosedUnitOperations implements KvClosedUnitOperations {
  /**
   * @param reserve - Synchronous backend lifecycle and same-unit reservation.
   * @param acquireRead - Frozen, source-preserving database acquisition.
   * @param acquireWrite - Current-format writable database acquisition.
   * @param poisonWriter - Permanently reject shared-connection access after indeterminate state.
   */
  constructor(
    private readonly reserve: ReserveUnit,
    private readonly acquireRead: AcquireDatabase,
    private readonly acquireWrite: AcquireDatabase,
    private readonly poisonWriter: PoisonWriter,
  ) {}

  /** @inheritdoc */
  withReservedUnit<T>(
    name: string,
    signal: AbortSignal,
    operation: (lease: KvClosedUnitLease) => Promise<T>,
  ): Promise<T> {
    let release: () => void
    try {
      release = this.reserve(name, signal)
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
    let active = true
    const inFlight = new Set<Promise<unknown>>()
    const admit = <T>(start: () => Promise<T>): Promise<T> => {
      if (!active) {
        return Promise.reject(new StorageError('closed', `closed-unit lease for '${name}' has ended`))
      }
      // Every lease entry passes an async closure, so invocation always returns
      // a Promise and reports setup failures through its rejection channel.
      const admitted = start()
      inFlight.add(admitted)
      void admitted.then(
        () => { inFlight.delete(admitted) },
        () => { inFlight.delete(admitted) },
      )
      return admitted
    }
    const lease: KvClosedUnitLease = {
      name,
      inspect: () => admit(async () => {
        signal.throwIfAborted()
        return await this.withReadAccess(signal, db => inspectExistingDatabase(db, name))
      }),
      read: descriptor => admit(async () => {
        signal.throwIfAborted()
        const ownedDescriptor = assertReservedDescriptor(name, descriptor)
        return await this.withReadAccess(signal, db => readExistingDatabase(db, ownedDescriptor))
      }),
      materializeMissing: (descriptor, snapshot) => admit(async () => {
        signal.throwIfAborted()
        const ownedDescriptor = assertReservedDescriptor(name, descriptor)
        const ownedSnapshot = validateSnapshot(ownedDescriptor, snapshot)
        const access = await this.acquireWrite(signal)
        let primary: unknown
        let result: SqliteMaterializationResult
        try {
          const db = access.database
          if (db === undefined || access.version !== STORAGE_SQLITE_SCHEMA_VERSION) {
            throw new StorageError('version-mismatch', 'writable sqlite access is not physical v2')
          }
          result = materializeV2(db, ownedDescriptor, ownedSnapshot, signal)
          if (result.outcome === 'uncertain') this.poisonWriter(result.cause)
        } catch (error) {
          if (error instanceof SqliteWriterPoisoningError) this.poisonWriter(error)
          primary = error
          throw error
        } finally {
          try {
            await access.release()
          } catch (releaseError) {
            if (primary !== undefined) {
              throw new AggregateError([primary, releaseError], 'sqlite materialization and release both failed')
            }
            throw releaseError
          }
        }
        const readbackSignal = new AbortController().signal
        const materialization: KvClosedUnitMaterialization = result.outcome === 'durable'
          ? {
            outcome: 'durable',
            readBack: () => admit(async () =>
              await this.withReadAccess(readbackSignal, db => readExistingDatabase(db, ownedDescriptor))),
          }
          : {
            outcome: 'uncertain',
            cause: result.cause,
            readBack: () => admit(async () =>
              await this.withReadAccess(readbackSignal, db => readDatabaseIfPresent(db, ownedDescriptor))),
          }
        return materialization
      }),
    }

    return (async () => {
      let primary: unknown
      try {
        return await operation(lease)
      } catch (error) {
        primary = error
        throw error
      } finally {
        active = false
        await Promise.allSettled([...inFlight])
        try {
          release()
        } catch (releaseError) {
          if (primary !== undefined) {
            throw new AggregateError([primary, releaseError], `closed-unit operation for '${name}' and release failed`)
          }
          throw releaseError
        }
      }
    })()
  }

  private async withReadAccess<T>(signal: AbortSignal, read: (db: DatabaseSync | undefined) => T): Promise<T> {
    const access = await this.acquireRead(signal)
    let primary: unknown
    try {
      return read(access.database)
    } catch (error) {
      primary = error
      throw error
    } finally {
      try {
        await access.release()
      } catch (releaseError) {
        if (primary !== undefined) {
          throw new AggregateError([primary, releaseError], 'sqlite read and cleanup both failed')
        }
        throw releaseError
      }
    }
  }
}

/**
 * Read a current unit through the same exact-layout and JSON rules as a
 * frozen closed-medium read.
 * @param db - Validated current-format writer.
 * @param descriptor - Exact identity and layout expected at the target.
 * @returns the detached stored snapshot, or `undefined` when absent.
 */
export function readCurrentDatabaseIfPresent(
  db: DatabaseSync,
  descriptor: KvUnitDescriptor,
): KvUnitSnapshot | undefined {
  validateDescriptor(descriptor)
  return readV2DatabaseIfPresent(db, descriptor, 'current sqlite medium')
}

/**
 * Inspect an existing or missing read view through current and legacy validation.
 * @param db - Frozen database view, or `undefined` after stable absence was confirmed.
 * @param name - Logical unit name.
 * @returns the stored descriptor fields, or `undefined` when absent.
 */
export function inspectExistingDatabase(
  db: DatabaseSync | undefined,
  name: string,
): KvClosedUnitInspection | undefined {
  if (db === undefined) return undefined
  const version = malformed('closed sqlite medium', () => physicalVersionOf(db))
  if (version === STORAGE_SQLITE_SCHEMA_VERSION) {
    validateV2Database(db, 'closed sqlite medium')
    return inspectV2(db, name, 'closed sqlite medium')
  }
  if (version === LEGACY_STORAGE_SQLITE_SCHEMA_VERSION) {
    validateLegacyV1Database(db, 'closed legacy sqlite medium')
    return inspectLegacyV1(db, name)
  }
  throw new StorageError(
    'version-mismatch',
    `closed sqlite medium has unsupported physical version ${version}`,
  )
}

/**
 * Read one exact unit from an existing or missing read view.
 * @param db - Frozen database view, or `undefined` after stable absence was confirmed.
 * @param descriptor - Exact identity and layout expected at the target.
 * @returns the detached stored snapshot.
 */
export function readExistingDatabase(
  db: DatabaseSync | undefined,
  descriptor: KvUnitDescriptor,
): KvUnitSnapshot {
  validateDescriptor(descriptor)
  if (db === undefined) {
    throw new StorageError('unit-not-found', `kv unit '${descriptor.name}' does not exist`)
  }
  const version = malformed('closed sqlite medium', () => physicalVersionOf(db))
  if (version === STORAGE_SQLITE_SCHEMA_VERSION) {
    const snapshot = readV2DatabaseIfPresent(db, descriptor, 'closed sqlite medium')
    if (snapshot === undefined) {
      throw new StorageError('unit-not-found', `kv unit '${descriptor.name}' does not exist`)
    }
    return snapshot
  }
  if (version === LEGACY_STORAGE_SQLITE_SCHEMA_VERSION) {
    validateLegacyV1Database(db, 'closed legacy sqlite medium')
    if (descriptor.hasGlobal) {
      throw new StorageError(
        'malformed-medium',
        `legacy physical v1 cannot prove a global slot for unit '${descriptor.name}'`,
      )
    }
    const inspection = inspectLegacyV1(db, descriptor.name)
    assertMatchingInspection(descriptor, inspection)
    return readSnapshot(db, descriptor, legacyRecordTableName, decodeLegacyRecordKey)
  }
  throw new StorageError('version-mismatch', `closed sqlite medium has unsupported physical version ${version}`)
}

function readV2DatabaseIfPresent(
  db: DatabaseSync,
  descriptor: KvUnitDescriptor,
  path: string,
): KvUnitSnapshot | undefined {
  validateV2Database(db, path)
  const inspection = inspectV2(db, descriptor.name, path)
  if (inspection === undefined) return undefined
  assertMatchingInspection(descriptor, inspection)
  return readSnapshot(db, descriptor, recordTableName, decodeRecordKey)
}

function readDatabaseIfPresent(
  db: DatabaseSync | undefined,
  descriptor: KvUnitDescriptor,
): KvUnitSnapshot | undefined {
  const inspection = inspectExistingDatabase(db, descriptor.name)
  if (inspection === undefined) return undefined
  assertMatchingInspection(descriptor, inspection)
  return readExistingDatabase(db, descriptor)
}

function inspectV2(db: DatabaseSync, name: string, path: string): KvClosedUnitInspection | undefined {
  return malformed(path, () => {
    const units = db.prepare('SELECT name, version, has_global FROM units ORDER BY name').all() as unknown as Array<{
      name: string
      version: number
      has_global: number
    }>
    const layout = db.prepare('SELECT unit, table_name FROM unit_tables ORDER BY unit, table_name').all() as unknown as
      Array<{ unit: string; table_name: string }>
    // validateV2Database already proved every stored name and metadata foreign
    // key before inspectV2 derives this per-unit view.
    const unit = units.find(row => row.name === name)
    if (unit === undefined) return undefined
    return {
      name,
      version: unit.version,
      hasGlobal: unit.has_global === 1,
      tables: layout.filter(row => row.unit === name).map(row => row.table_name),
    }
  })
}

function inspectLegacyV1(db: DatabaseSync, name: string): KvClosedUnitInspection | undefined {
  return malformed('closed legacy sqlite medium', () => {
    const units = db.prepare('SELECT name, version FROM units ORDER BY name').all() as unknown as Array<{
      name: string
      version: number
    }>
    const unit = units[0]
    if (units.length !== 1 || unit === undefined || !UNIT_NAME_RE.test(unit.name)) {
      throw new Error('legacy physical v1 requires exactly one valid unit')
    }
    if (db.prepare('SELECT unit FROM unit_globals LIMIT 1').get() !== undefined) {
      throw new Error('legacy physical v1 compatibility requires no global row')
    }
    const prefix = `u_${unit.name}_`
    const objects = listUserSchemaObjects(db)
    const tables: string[] = []
    for (const object of objects) {
      if (object.name === 'units' || object.name === 'unit_globals') continue
      if (object.type !== 'table' || !object.name.startsWith(prefix)) {
        throw new Error(`legacy physical v1 contains unknown object '${object.name}'`)
      }
      const table = object.name.slice(prefix.length)
      if (!UNIT_NAME_RE.test(table) || legacyRecordTableName(unit.name, table) !== object.name) {
        throw new Error(`legacy physical v1 contains invalid record table '${object.name}'`)
      }
      validateRecordTable(db, object.name, 'closed legacy sqlite medium')
      tables.push(table)
    }
    tables.sort()
    if (unit.name !== name) return undefined
    return { name, version: unit.version, hasGlobal: false, tables }
  })
}

function readSnapshot(
  db: DatabaseSync,
  descriptor: KvUnitDescriptor,
  physicalName: (unit: string, table: string) => string,
  decodeKey: (bytes: Uint8Array) => string,
): KvUnitSnapshot {
  return malformed(`kv unit '${descriptor.name}'`, () => {
    const tables: Record<string, Record<string, unknown>> = {}
    for (const table of descriptor.tables) {
      const records: Record<string, unknown> = Object.create(null) as Record<string, unknown>
      const rows = (db
        .prepare(
          `SELECT CAST(key AS BLOB) AS key_bytes, CAST(value AS BLOB) AS value_bytes FROM "${physicalName(descriptor.name, table)}" ORDER BY key`,
        )
        .all()) as unknown as Array<{ key_bytes: Uint8Array; value_bytes: Uint8Array }>
      for (const row of rows) {
        const key = decodeKey(row.key_bytes)
        records[key] = parseStoredValue(descriptor.name, row.value_bytes, `table '${table}' key '${key}'`)
      }
      tables[table] = records
    }
    const globalRow = db
      .prepare('SELECT CAST(value AS BLOB) AS value_bytes FROM unit_globals WHERE unit = ?')
      .get(descriptor.name) as
      | { value_bytes: Uint8Array }
      | undefined
    return {
      tables,
      global: globalRow === undefined
        ? null
        : parseStoredValue(descriptor.name, globalRow.value_bytes, 'global slot'),
    }
  })
}

/**
 * Materialize one physical-v2 unit transactionally on a validated writer.
 * @param db - Current-format writable database.
 * @param descriptor - Validated identity and persistent layout.
 * @param snapshot - Complete initial state matching the descriptor.
 * @param signal - Cancellation observed until the commit decision.
 * @returns a durable result or a token whose commit outcome requires readback.
 */
export function materializeV2(
  db: DatabaseSync,
  descriptor: KvUnitDescriptor,
  snapshot: KvUnitSnapshot,
  signal: AbortSignal,
): SqliteMaterializationResult {
  const serializedTables = Object.entries(snapshot.tables).map(([table, tableSnapshot]) => {
    signal.throwIfAborted()
    return {
      table,
      records: Object.entries(tableSnapshot).map(([key, value]) => [
        encodeRecordKey(key),
        stringifyLosslessJsonValue(value, `kv unit '${descriptor.name}' table '${table}' key '${key}'`),
      ] as const),
    }
  })
  const serializedGlobal = snapshot.global === null
    ? undefined
    : stringifyLosslessJsonValue(snapshot.global, `kv unit '${descriptor.name}' global slot`)

  try {
    db.exec('BEGIN IMMEDIATE')
  } catch (error) {
    recoverFailedBeginOrPoison(db, error)
  }
  try {
    signal.throwIfAborted()
    if (hasV2UnitTrace(db, descriptor.name)) {
      throw new StorageError('target-exists', `kv unit '${descriptor.name}' already has physical state`)
    }
    db.prepare('INSERT INTO units (name, version, has_global) VALUES (?, ?, ?)')
      .run(descriptor.name, descriptor.version, Number(descriptor.hasGlobal))
    for (const { table, records } of serializedTables) {
      signal.throwIfAborted()
      db.prepare('INSERT INTO unit_tables (unit, table_name) VALUES (?, ?)').run(descriptor.name, table)
      const physical = recordTableName(descriptor.name, table)
      createRecordTable(db, physical)
      const insert = db.prepare(`INSERT INTO "${physical}" (key, value) VALUES (?, ?)`)
      for (const [key, value] of records) {
        signal.throwIfAborted()
        insert.run(key, value)
      }
    }
    if (serializedGlobal !== undefined) {
      db.prepare('INSERT INTO unit_globals (unit, value) VALUES (?, ?)').run(descriptor.name, serializedGlobal)
    }
    signal.throwIfAborted()
  } catch (error) {
    rollbackBeforeCommitOrPoison(db, error)
  }

  try {
    db.exec('COMMIT')
    return { outcome: 'durable' }
  } catch (error) {
    const commitFailure = asError(error)
    let transactionActive: boolean
    try {
      transactionActive = db.isTransaction
    } catch (stateError) {
      return {
        outcome: 'uncertain',
        cause: new AggregateError(
          [commitFailure, asError(stateError)],
          'sqlite COMMIT failed and transaction state could not be inspected',
        ),
      }
    }
    if (!transactionActive) return { outcome: 'uncertain', cause: commitFailure }
    try {
      db.exec('ROLLBACK')
    } catch (rollbackError) {
      throw new SqliteWriterPoisoningError(
        [commitFailure, asError(rollbackError)],
        'sqlite COMMIT and rollback both failed',
      )
    }
    throw commitFailure
  }
}

function hasV2UnitTrace(db: DatabaseSync, name: string): boolean {
  if (db.prepare('SELECT 1 FROM units WHERE name = ?').get(name) !== undefined) return true
  if (db.prepare('SELECT 1 FROM unit_tables WHERE unit = ?').get(name) !== undefined) return true
  if (db.prepare('SELECT 1 FROM unit_globals WHERE unit = ?').get(name) !== undefined) return true
  const prefix = recordTableName(name, '')
  return db.prepare(
    'SELECT 1 FROM sqlite_schema WHERE substr(name, 1, ?) = ? LIMIT 1',
  ).get(prefix.length, prefix) !== undefined
}

/**
 * Assert that persisted identity and layout exactly match a descriptor.
 * @param descriptor - Validated caller descriptor.
 * @param inspection - Persisted fields, or absence of the requested unit.
 * @returns an assertion that inspection is present and matches the descriptor.
 */
export function assertMatchingInspection(
  descriptor: KvUnitDescriptor,
  inspection: KvClosedUnitInspection | undefined,
): asserts inspection is KvClosedUnitInspection {
  if (inspection === undefined) {
    throw new StorageError('unit-not-found', `kv unit '${descriptor.name}' does not exist`)
  }
  if (inspection.version !== descriptor.version) {
    throw new StorageError(
      'version-mismatch',
      `kv unit '${descriptor.name}' is version ${inspection.version}, expected ${descriptor.version}`,
    )
  }
  if (inspection.hasGlobal !== descriptor.hasGlobal
    || !sameTables(inspection.tables, [...descriptor.tables].sort())) {
    throw new StorageError('malformed-medium', `kv unit '${descriptor.name}' layout differs from its descriptor`)
  }
}

function validateSnapshot(descriptor: KvUnitDescriptor, snapshot: KvUnitSnapshot): KvUnitSnapshot {
  validateDescriptor(descriptor)
  let ownedSnapshot: KvUnitSnapshot
  try {
    ownedSnapshot = cloneLosslessJsonValue(snapshot, `kv unit '${descriptor.name}' materialization snapshot`)
  } catch (error) {
    throw new StorageError(
      'malformed-medium',
      `kv unit '${descriptor.name}' materialization snapshot is not exact JSON data`,
      { cause: error },
    )
  }
  if (!sameTables(Object.keys(ownedSnapshot.tables).sort(), [...descriptor.tables].sort())) {
    throw new StorageError('malformed-medium', `kv unit '${descriptor.name}' snapshot tables differ from descriptor`)
  }
  if (!descriptor.hasGlobal && ownedSnapshot.global !== null) {
    throw new StorageError('malformed-medium', `kv unit '${descriptor.name}' snapshot supplies an undeclared global`)
  }
  return ownedSnapshot
}

function assertReservedDescriptor(name: string, descriptor: KvUnitDescriptor): KvUnitDescriptor {
  validateDescriptor(descriptor)
  if (descriptor.name !== name) {
    throw new Error(`closed-unit lease for '${name}' cannot operate on '${descriptor.name}'`)
  }
  return {
    name: descriptor.name,
    version: descriptor.version,
    tables: [...descriptor.tables],
    hasGlobal: descriptor.hasGlobal,
  }
}

/**
 * Validate a descriptor before it reaches physical naming or persistence.
 * @param descriptor - Descriptor supplied by a storage consumer.
 */
export function validateDescriptor(descriptor: KvUnitDescriptor): void {
  validateUnitName(descriptor.name)
  if (!isKvUnitVersion(descriptor.version)) {
    throw new Error(`kv unit '${descriptor.name}' version must be a non-negative safe integer`)
  }
  if (new Set(descriptor.tables).size !== descriptor.tables.length) {
    throw new Error(`kv unit '${descriptor.name}' repeats a table name`)
  }
  for (const table of descriptor.tables) {
    if (!UNIT_NAME_RE.test(table)) {
      throw new Error(`kv table name '${table}' in unit '${descriptor.name}' violates ${UNIT_NAME_RE}`)
    }
  }
}

/**
 * Validate a unit name before lifecycle reservation.
 * @param name - Logical unit name supplied by a storage consumer.
 */
export function validateUnitName(name: string): void {
  if (!UNIT_NAME_RE.test(name)) throw new Error(`kv unit name '${name}' violates ${UNIT_NAME_RE}`)
}

function physicalVersionOf(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

function parseStoredValue(name: string, bytes: Uint8Array, slot: string): unknown {
  try {
    const text = decodeSqliteText(bytes)
    return parseLosslessJsonValue(text, `kv unit '${name}' ${slot}`)
  } catch (error) {
    throw new StorageError('malformed-medium', `kv unit '${name}' holds invalid JSON data at ${slot}`, { cause: error })
  }
}

function malformed<T>(subject: string, operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    if (error instanceof StorageError) throw error
    throw new StorageError('malformed-medium', `${subject} has invalid SQLite state`, { cause: error })
  }
}

function rollbackBeforeCommitOrPoison(db: DatabaseSync, primary: unknown): never {
  const failure = asError(primary)
  let transactionActive: boolean
  try {
    transactionActive = db.isTransaction
  } catch (stateError) {
    throw new SqliteWriterPoisoningError(
      [failure, asError(stateError)],
      'sqlite materialization failed and transaction state could not be inspected',
    )
  }
  if (!transactionActive) {
    throw new SqliteWriterPoisoningError(
      [failure],
      'sqlite materialization transaction ended before COMMIT',
    )
  }
  try {
    db.exec('ROLLBACK')
  } catch (rollbackError) {
    throw new SqliteWriterPoisoningError(
      [failure, asError(rollbackError)],
      'sqlite materialization and rollback both failed',
    )
  }
  throw failure
}

function recoverFailedBeginOrPoison(db: DatabaseSync, primary: unknown): never {
  const failure = asError(primary)
  let transactionActive: boolean
  try {
    transactionActive = db.isTransaction
  } catch (stateError) {
    throw new SqliteWriterPoisoningError(
      [failure, asError(stateError)],
      'sqlite BEGIN failed and transaction state could not be inspected',
    )
  }
  if (!transactionActive) throw failure
  try {
    db.exec('ROLLBACK')
  } catch (rollbackError) {
    throw new SqliteWriterPoisoningError(
      [failure, asError(rollbackError)],
      'sqlite BEGIN and rollback both failed',
    )
  }
  throw failure
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function sameTables(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((table, index) => table === right[index])
}
