/** SQLite physical schema, validation, and nonmutating closed-medium snapshots. @module */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseLosslessJsonValue, StorageError, UNIT_NAME_RE } from '@deepseek-ai/dsh-storage'
import { decodeRecordKey, decodeSqliteText } from './key.ts'

/** Current physical SQLite layout. Domain versions remain independent. */
export const STORAGE_SQLITE_SCHEMA_VERSION = 2
/** Read-only compatibility floor for the dedicated legacy B03 database. */
export const LEGACY_STORAGE_SQLITE_SCHEMA_VERSION = 1

/** Durable SQLite journal modes supported by the writer. */
export type JournalMode = 'wal' | 'delete' | 'truncate' | 'persist'

interface SourceFile {
  readonly path: string
  readonly size: number
  readonly digest: string
}

interface CreatedDatabaseFile {
  readonly handle: FileHandle
  readonly identity: FileIdentity
}

interface FileIdentity {
  readonly dev: number
  readonly ino: number
}

interface TableColumn {
  readonly cid: number
  readonly name: string
  readonly type: string
  readonly notnull: number
  readonly dflt_value: unknown
  readonly pk: number
  readonly hidden: number
}

interface ExpectedColumn {
  readonly name: string
  readonly type: string
  readonly notnull: number
  readonly pk: number
}

interface ForeignKeyRow {
  readonly id: number
  readonly seq: number
  readonly table: string
  readonly from: string
  readonly to: string
  readonly on_update: string
  readonly on_delete: string
  readonly match: string
}

interface StoredUnitTable {
  readonly unit: string
  readonly table: string
}

interface StoredGlobal {
  readonly unit: string
  readonly value: Uint8Array
}

const V2_UNITS_TABLE_SQL = `CREATE TABLE units (
  name       TEXT PRIMARY KEY,
  version    INTEGER NOT NULL CHECK (version >= 0 AND version <= ${Number.MAX_SAFE_INTEGER}),
  has_global INTEGER NOT NULL CHECK (has_global IN (0, 1))
) STRICT`

const V2_UNIT_TABLES_SQL = `CREATE TABLE unit_tables (
  unit       TEXT NOT NULL REFERENCES units(name),
  table_name TEXT NOT NULL,
  PRIMARY KEY (unit, table_name)
) STRICT, WITHOUT ROWID`

const UNIT_GLOBALS_TABLE_SQL = `CREATE TABLE unit_globals (
  unit  TEXT PRIMARY KEY REFERENCES units(name),
  value TEXT NOT NULL
) STRICT`

const LEGACY_UNITS_TABLE_SQL = `CREATE TABLE units (
  name    TEXT PRIMARY KEY,
  version INTEGER NOT NULL
) STRICT`

const SQLITE_SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const

/** Platform effects for deterministic schema fault injection. @internal */
export interface SqliteSchemaEffects {
  /** Restrict a copied database file to its private owner. */
  readonly chmod: typeof chmod
  /** Copy one database or sidecar into a frozen view. */
  readonly copyFile: typeof copyFile
  /** Open one SQLite connection. */
  readonly createDatabase: (
    path: string,
    options?: ConstructorParameters<typeof DatabaseSync>[1],
  ) => DatabaseSync
  /** Stream one source file for identity hashing. */
  readonly createReadStream: typeof createReadStream
  /** Inspect one path without following symbolic links. */
  readonly lstat: typeof lstat
  /** Create the writable database parent directory. */
  readonly mkdir: typeof mkdir
  /** Create a private frozen-view directory. */
  readonly mkdtemp: typeof mkdtemp
  /** Exclusively create a writable database file. */
  readonly open: typeof open
  /** Remove an owned database file or private frozen-view directory. */
  readonly rm: typeof rm
}

const nodeSqliteSchemaEffects: SqliteSchemaEffects = {
  chmod,
  copyFile,
  createDatabase: (
    path: string,
    options?: ConstructorParameters<typeof DatabaseSync>[1],
  ): DatabaseSync => options === undefined
    ? new DatabaseSync(path)
    : new DatabaseSync(path, options),
  createReadStream,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rm,
}

/** A private database view whose close operation also removes its frozen files. */
export interface ExistingDatabaseView {
  /** Existing database, or `undefined` when the source path is absent. */
  readonly database: DatabaseSync | undefined
  /** Physical version read from the recovered view. */
  readonly version: number | undefined
  /** Close the recovered database and remove its private directory. */
  close(): Promise<void>
}

/**
 * Open the writable current-format database. Existing non-current media reject
 * before the original file is opened by SQLite; orphan sidecars reject before
 * a missing database is created, and physical upgrades are never in place.
 * @param path - Database path or `:memory:`.
 * @param journalMode - Validated writer journal mode.
 * @param effects - Internal platform effects; production callers use Node defaults.
 * @returns the current-format writable connection.
 */
export async function openDatabase(
  path: string,
  journalMode: JournalMode,
  effects: SqliteSchemaEffects = nodeSqliteSchemaEffects,
): Promise<DatabaseSync> {
  if (path === ':memory:') {
    const memory = effects.createDatabase(path)
    try {
      validateEmptyV0Database(memory, path)
      configureWriter(memory, path, journalMode)
      initializeV2(memory, path)
      return memory
    } catch (error) {
      closeAfterFailure(memory, error)
    }
  }

  const actual = resolve(path)
  await effects.mkdir(dirname(actual), { recursive: true, mode: 0o700 })
  const created = await createDatabaseFile(actual, effects)
  if (created === undefined) {
    const view = await openExistingDatabaseReadonly(actual, new AbortController().signal, effects)
    let primary: unknown
    try {
      const db = view.database
      if (db === undefined) throw new Error(`storage database at "${actual}" disappeared during open`)
      if (view.version === 0) {
        validateEmptyV0Database(db, actual)
      } else if (view.version === STORAGE_SQLITE_SCHEMA_VERSION) {
        validateV2Database(db, actual)
      } else {
        throw physicalVersionError(actual, view.version)
      }
    } catch (error) {
      primary = error
      throw error
    } finally {
      try {
        await view.close()
      } catch (closeError) {
        if (primary !== undefined) {
          throw new AggregateError([primary, closeError], 'sqlite preflight and frozen-view cleanup both failed')
        }
        throw closeError
      }
    }
  }

  let db: DatabaseSync
  try {
    db = effects.createDatabase(actual)
  } catch (error) {
    if (created !== undefined) await discardCreatedDatabaseFile(actual, created, error, effects)
    throw error
  }
  if (created !== undefined) {
    try {
      await created.handle.close()
    } catch (error) {
      closeAfterFailure(db, error)
    }
  }
  try {
    const version = physicalVersion(db)
    if (version !== 0 && version !== STORAGE_SQLITE_SCHEMA_VERSION) {
      throw physicalVersionError(actual, version)
    }
    if (version === 0) validateEmptyV0Database(db, actual)
    else validateV2Database(db, actual)
    configureWriter(db, actual, journalMode)
    if (version === 0) initializeV2(db, actual)
    return db
  } catch (error) {
    closeAfterFailure(db, error)
  }
}

/**
 * Freeze an existing file database into a private directory before SQLite
 * opens it. The copy includes committed WAL frames and rollback recovery data
 * but never copies `-shm`.
 * @param path - Existing database file path.
 * @param signal - Cancellation observed before each pre-commit phase.
 * @param effects - Internal platform effects; production callers use Node defaults.
 * @returns a scoped recovered view, or an empty view when the database and sidecars are absent.
 */
export async function openExistingDatabaseReadonly(
  path: string,
  signal: AbortSignal,
  effects: SqliteSchemaEffects = nodeSqliteSchemaEffects,
): Promise<ExistingDatabaseView> {
  signal.throwIfAborted()
  const actual = resolve(path)
  if (await statRegularFile(actual, effects) === undefined) {
    assertNoOrphanSidecars(actual, await existingSidecars(actual, signal, effects))
    signal.throwIfAborted()
    if (await statRegularFile(actual, effects) === undefined) {
      assertNoOrphanSidecars(actual, await existingSidecars(actual, signal, effects))
      signal.throwIfAborted()
      if (await statRegularFile(actual, effects) === undefined) {
        return { database: undefined, version: undefined, close: async () => {} }
      }
    }
  }
  return await openFrozenCopy(actual, signal, effects)
}

async function openFrozenCopy(
  sourceDatabase: string,
  signal: AbortSignal,
  effects: SqliteSchemaEffects,
): Promise<ExistingDatabaseView> {
  const root = await effects.mkdtemp(join(tmpdir(), 'dsh-storage-sqlite-read-'))
  const databasePath = join(root, 'storage.db')
  let database: DatabaseSync | undefined
  try {
    const before = await snapshotSource(sourceDatabase, signal, effects)
    await copyPrivateFile(sourceDatabase, databasePath, effects)
    signal.throwIfAborted()
    const wal = before.find(file => file.path === `${sourceDatabase}-wal`)
    if (wal !== undefined && wal.size > 0) {
      await copyPrivateFile(wal.path, `${databasePath}-wal`, effects)
      signal.throwIfAborted()
    }
    const rollbackJournal = before.find(file => file.path === `${sourceDatabase}-journal`)
    if (rollbackJournal !== undefined && rollbackJournal.size > 0) {
      await copyPrivateFile(rollbackJournal.path, `${databasePath}-journal`, effects)
      signal.throwIfAborted()
    }
    const copiedDatabase = await digestFile(databasePath, signal, effects)
    const copiedWal = wal === undefined || wal.size === 0
      ? undefined
      : await digestFile(`${databasePath}-wal`, signal, effects)
    const copiedRollbackJournal = rollbackJournal === undefined || rollbackJournal.size === 0
      ? undefined
      : await digestFile(`${databasePath}-journal`, signal, effects)
    const after = await snapshotSource(sourceDatabase, signal, effects)
    if (!sameSourceSnapshot(before, after)
      || copiedDatabase !== before[0]?.digest
      || (wal !== undefined && wal.size > 0 && copiedWal !== wal.digest)
      || (rollbackJournal !== undefined
        && rollbackJournal.size > 0
        && copiedRollbackJournal !== rollbackJournal.digest)) {
      throw new StorageError(
        'malformed-medium',
        `storage database at "${sourceDatabase}" changed while its closed snapshot was copied`,
      )
    }

    let version: number
    try {
      database = effects.createDatabase(databasePath, { enableForeignKeyConstraints: false })
      version = physicalVersion(database)
    } catch (error) {
      throw new StorageError(
        'malformed-medium',
        `storage database at "${sourceDatabase}" is not a readable SQLite medium`,
        { cause: error },
      )
    }
    let closed = false
    return {
      database,
      version,
      close: async () => {
        if (closed) return
        closed = true
        const failures: unknown[] = []
        try {
          database?.close()
        } catch (error) {
          failures.push(error)
        }
        try {
          await effects.rm(root, { recursive: true, force: true })
        } catch (error) {
          failures.push(error)
        }
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1) throw new AggregateError(failures, 'failed to close frozen sqlite view')
      },
    }
  } catch (error) {
    const failures = [error]
    if (database !== undefined) {
      try {
        database.close()
      } catch (closeError) {
        failures.push(closeError)
      }
    }
    try {
      await effects.rm(root, { recursive: true, force: true })
    } catch (cleanupError) {
      failures.push(cleanupError)
    }
    if (failures.length > 1) throw new AggregateError(failures, 'failed to open frozen sqlite view')
    throw error
  }
}

/**
 * Validate the fixed metadata tables for physical v2.
 * @param db - Database to validate.
 * @param path - Medium label used in diagnostics.
 */
export function validateV2Database(db: DatabaseSync, path: string): void {
  wrapMalformed(path, () => {
    assertUtf8Database(db)
    if (physicalVersion(db) !== STORAGE_SQLITE_SCHEMA_VERSION) {
      throw physicalVersionError(path, physicalVersion(db))
    }
    assertTable(db, 'units', [
      { name: 'name', type: 'TEXT', notnull: 1, pk: 1 },
      { name: 'version', type: 'INTEGER', notnull: 1, pk: 0 },
      { name: 'has_global', type: 'INTEGER', notnull: 1, pk: 0 },
    ], false, V2_UNITS_TABLE_SQL)
    assertTable(db, 'unit_tables', [
      { name: 'unit', type: 'TEXT', notnull: 1, pk: 1 },
      { name: 'table_name', type: 'TEXT', notnull: 1, pk: 2 },
    ], true, V2_UNIT_TABLES_SQL)
    assertTable(db, 'unit_globals', [
      { name: 'unit', type: 'TEXT', notnull: 1, pk: 1 },
      { name: 'value', type: 'TEXT', notnull: 1, pk: 0 },
    ], false, UNIT_GLOBALS_TABLE_SQL)
    assertForeignKey(db, 'unit_tables', 'unit', 'units', 'name')
    assertForeignKey(db, 'unit_globals', 'unit', 'units', 'name')
    const badUnit = db.prepare(`
      SELECT name FROM units
      WHERE version < 0
        OR version > ${Number.MAX_SAFE_INTEGER}
        OR typeof(version) <> 'integer'
        OR has_global NOT IN (0, 1)
      LIMIT 1
    `).get()
    if (badUnit !== undefined) throw new Error('units contains an invalid identity row')
    for (const row of db.prepare('SELECT CAST(name AS BLOB) AS name_bytes FROM units').all() as unknown as Array<{
      name_bytes: Uint8Array
    }>) {
      assertStoredName(row.name_bytes, 'units.name')
    }
    const storedTables: StoredUnitTable[] = []
    for (const row of db.prepare(`
      SELECT CAST(unit AS BLOB) AS unit_bytes, CAST(table_name AS BLOB) AS table_name_bytes
      FROM unit_tables
    `).all() as unknown as Array<{ unit_bytes: Uint8Array; table_name_bytes: Uint8Array }>) {
      storedTables.push({
        unit: assertStoredName(row.unit_bytes, 'unit_tables.unit'),
        table: assertStoredName(row.table_name_bytes, 'unit_tables.table_name'),
      })
    }
    const storedGlobals: StoredGlobal[] = []
    for (const row of db.prepare(`
      SELECT CAST(unit AS BLOB) AS unit_bytes, CAST(value AS BLOB) AS value_bytes
      FROM unit_globals
    `).all() as unknown as Array<{ unit_bytes: Uint8Array; value_bytes: Uint8Array }>) {
      storedGlobals.push({
        unit: assertStoredName(row.unit_bytes, 'unit_globals.unit'),
        value: row.value_bytes,
      })
    }
    const forbiddenGlobal = db.prepare(`
      SELECT unit_globals.unit FROM unit_globals
      JOIN units ON units.name = unit_globals.unit
      WHERE units.has_global = 0 LIMIT 1
    `).get()
    if (forbiddenGlobal !== undefined) throw new Error('a unit without a global slot stores a global row')
    if (db.prepare('PRAGMA foreign_key_check').get() !== undefined) {
      throw new Error('metadata foreign keys are inconsistent')
    }
    assertV2PhysicalLayout(db, path, storedTables)
    assertV2StoredData(db, storedTables, storedGlobals)
  })
}

/**
 * Validate the fixed metadata tables of the legacy physical v1 reader.
 * @param db - Database to validate.
 * @param path - Medium label used in diagnostics.
 */
export function validateLegacyV1Database(db: DatabaseSync, path: string): void {
  wrapMalformed(path, () => {
    assertUtf8Database(db)
    if (physicalVersion(db) !== LEGACY_STORAGE_SQLITE_SCHEMA_VERSION) {
      throw physicalVersionError(path, physicalVersion(db))
    }
    assertTable(db, 'units', [
      { name: 'name', type: 'TEXT', notnull: 1, pk: 1 },
      { name: 'version', type: 'INTEGER', notnull: 1, pk: 0 },
    ], false, LEGACY_UNITS_TABLE_SQL)
    assertTable(db, 'unit_globals', [
      { name: 'unit', type: 'TEXT', notnull: 1, pk: 1 },
      { name: 'value', type: 'TEXT', notnull: 1, pk: 0 },
    ], false, UNIT_GLOBALS_TABLE_SQL)
    assertForeignKey(db, 'unit_globals', 'unit', 'units', 'name')
    const badUnit = db.prepare(`
      SELECT name FROM units
      WHERE version < 0 OR version > ${Number.MAX_SAFE_INTEGER} OR typeof(version) <> 'integer'
      LIMIT 1
    `).get()
    if (badUnit !== undefined) throw new Error('legacy units contains an invalid identity row')
    for (const row of db.prepare('SELECT CAST(name AS BLOB) AS name_bytes FROM units').all() as unknown as Array<{
      name_bytes: Uint8Array
    }>) {
      assertStoredName(row.name_bytes, 'legacy units.name')
    }
    for (const row of db.prepare('SELECT CAST(unit AS BLOB) AS unit_bytes FROM unit_globals').all() as unknown as Array<{
      unit_bytes: Uint8Array
    }>) {
      assertStoredName(row.unit_bytes, 'legacy unit_globals.unit')
    }
  })
}

/**
 * Validate one v2 or legacy record table's fixed key/value schema.
 * @param db - Database containing the table.
 * @param table - Physical table name.
 * @param path - Medium label used in diagnostics.
 */
export function validateRecordTable(db: DatabaseSync, table: string, path: string): void {
  wrapMalformed(path, () => {
    assertTable(db, table, [
      { name: 'key', type: 'TEXT', notnull: 1, pk: 1 },
      { name: 'value', type: 'TEXT', notnull: 1, pk: 0 },
    ], false, recordTableSql(table))
  })
}

/**
 * List all non-SQLite schema objects for exact-layout validation.
 * @param db - Database to inspect.
 * @returns schema object type, name, and owning table in stable order.
 */
export function listUserSchemaObjects(db: DatabaseSync): Array<{ type: string; name: string; owner: string }> {
  const rows = db.prepare(`
    SELECT
      CAST(type AS BLOB) AS type_bytes,
      CAST(name AS BLOB) AS name_bytes,
      CAST(tbl_name AS BLOB) AS owner_bytes,
      sql IS NULL AS sql_is_null
    FROM sqlite_schema
    ORDER BY type, name
  `).all() as unknown as Array<{
    type_bytes: Uint8Array | null
    name_bytes: Uint8Array | null
    owner_bytes: Uint8Array | null
    sql_is_null: number
  }>
  const decoded = rows.map(row => ({
    object: {
      type: decodeSchemaText(row.type_bytes, 'sqlite_schema.type'),
      name: decodeSchemaText(row.name_bytes, 'sqlite_schema.name'),
      owner: decodeSchemaText(row.owner_bytes, 'sqlite_schema.tbl_name'),
    },
    sqlIsNull: row.sql_is_null === 1,
  }))
  const tableNames = new Set(decoded
    .filter(({ object }) => object.type === 'table')
    .map(({ object }) => object.name))
  const objects: Array<{ type: string; name: string; owner: string }> = []
  for (const { object, sqlIsNull } of decoded) {
    if (sqlIsNull
      && object.type === 'index'
      && object.name === `sqlite_autoindex_${object.owner}_1`
      && tableNames.has(object.owner)) {
      continue
    }
    objects.push(object)
  }
  return objects
}

/**
 * Build a current collision-free physical record-table name.
 * @param unit - Validated logical unit name.
 * @param table - Validated logical table name.
 * @returns an ASCII identifier containing unambiguous UTF-8 hex segments.
 */
export function recordTableName(unit: string, table: string): string {
  return `u2_${Buffer.from(unit, 'utf8').toString('hex')}_${Buffer.from(table, 'utf8').toString('hex')}`
}

/**
 * Create one canonical physical-v2 record table on a writer transaction.
 * @param db - Current-format writable database.
 * @param table - Collision-free physical table name.
 */
export function createRecordTable(db: DatabaseSync, table: string): void {
  db.exec(recordTableSql(table))
}

/**
 * Build a legacy physical-v1 record-table name for compatibility reads.
 * @param unit - Validated logical unit name.
 * @param table - Validated logical table name.
 * @returns the legacy underscore-delimited identifier.
 */
export function legacyRecordTableName(unit: string, table: string): string {
  return `u_${unit}_${table}`
}

/**
 * Read the physical version without mutating the database.
 * @param db - Open SQLite database.
 * @returns the `PRAGMA user_version` integer.
 */
export function physicalVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

function assertUtf8Database(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA encoding').get() as { encoding: string }
  if (row.encoding !== 'UTF-8') throw new Error(`database encoding '${row.encoding}' is not UTF-8`)
}

function assertStoredName(bytes: Uint8Array, column: string): string {
  const name = decodeSqliteText(bytes)
  if (!UNIT_NAME_RE.test(name)) throw new Error(`${column} contains invalid name '${name}'`)
  return name
}

function assertV2PhysicalLayout(
  db: DatabaseSync,
  path: string,
  storedTables: readonly StoredUnitTable[],
): void {
  const expectedTables = new Set(['units', 'unit_tables', 'unit_globals'])
  for (const stored of storedTables) {
    const physical = recordTableName(stored.unit, stored.table)
    validateRecordTable(db, physical, path)
    expectedTables.add(physical)
  }
  for (const object of listUserSchemaObjects(db)) {
    if (object.type !== 'table'
      || object.owner !== object.name
      || !expectedTables.delete(object.name)) {
      throw new Error(`sqlite medium contains unknown object '${object.name}'`)
    }
  }
  if (expectedTables.size !== 0) throw new Error('sqlite medium omits a declared physical table')
}

function assertV2StoredData(
  db: DatabaseSync,
  storedTables: readonly StoredUnitTable[],
  storedGlobals: readonly StoredGlobal[],
): void {
  for (const stored of storedGlobals) {
    assertStoredJson(stored.value, `kv unit '${stored.unit}' global slot`)
  }
  for (const stored of storedTables) {
    const physical = recordTableName(stored.unit, stored.table)
    const rows = db.prepare(`
      SELECT CAST(key AS BLOB) AS key_bytes, CAST(value AS BLOB) AS value_bytes
      FROM "${physical}"
      ORDER BY key
    `).all() as unknown as Array<{ key_bytes: Uint8Array; value_bytes: Uint8Array }>
    for (const row of rows) {
      const key = decodeRecordKey(row.key_bytes)
      assertStoredJson(row.value_bytes, `kv unit '${stored.unit}' table '${stored.table}' key '${key}'`)
    }
  }
}

function assertStoredJson(bytes: Uint8Array, subject: string): void {
  parseLosslessJsonValue(decodeSqliteText(bytes), subject)
}

function configureWriter(db: DatabaseSync, path: string, journalMode: JournalMode): void {
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`PRAGMA journal_mode = ${journalMode.toUpperCase()}`)
  const version = physicalVersion(db)
  if (version !== 0 && version !== STORAGE_SQLITE_SCHEMA_VERSION) throw physicalVersionError(path, version)
}

function initializeV2(db: DatabaseSync, path: string): void {
  validateEmptyV0Database(db, path)
  let started = false
  try {
    db.exec('BEGIN IMMEDIATE')
    started = true
    db.exec(`
      ${V2_UNITS_TABLE_SQL};
      ${V2_UNIT_TABLES_SQL};
      ${UNIT_GLOBALS_TABLE_SQL};
      PRAGMA user_version = ${STORAGE_SQLITE_SCHEMA_VERSION};
    `)
    db.exec('COMMIT')
    started = false
  } catch (error) {
    if (started) rollbackOrAggregate(db, error)
    throw error
  }
}

function validateEmptyV0Database(db: DatabaseSync, path: string): void {
  wrapMalformed(path, () => {
    assertUtf8Database(db)
    if (physicalVersion(db) !== 0 || listUserSchemaObjects(db).length !== 0) {
      throw new Error('unstamped database is not empty')
    }
  })
}

async function createDatabaseFile(
  path: string,
  effects: SqliteSchemaEffects,
): Promise<CreatedDatabaseFile | undefined> {
  if (await statRegularFile(path, effects) !== undefined) return undefined
  assertNoOrphanSidecars(path, await existingSidecars(path, undefined, effects))
  let handle: FileHandle
  try {
    handle = await effects.open(path, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined
    throw error
  }
  const stat = await handle.stat()
  const created = { handle, identity: { dev: stat.dev, ino: stat.ino } }
  const sidecars = await existingSidecars(path, undefined, effects)
    .catch((error: unknown) => discardCreatedDatabaseFile(path, created, error, effects))
  if (sidecars.length !== 0) {
    await discardCreatedDatabaseFile(path, created, orphanSidecarError(path, sidecars), effects)
  }
  try {
    await assertOwnedEmptyDatabaseFile(path, created.identity, effects)
  } catch (error) {
    await discardCreatedDatabaseFile(path, created, error, effects)
  }
  return created
}

async function existingSidecars(
  database: string,
  signal: AbortSignal | undefined,
  effects: SqliteSchemaEffects,
): Promise<string[]> {
  const existing: string[] = []
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    signal?.throwIfAborted()
    const path = `${database}${suffix}`
    try {
      await effects.lstat(path)
      existing.push(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return existing
}

function assertNoOrphanSidecars(database: string, sidecars: readonly string[]): void {
  if (sidecars.length !== 0) throw orphanSidecarError(database, sidecars)
}

function orphanSidecarError(database: string, sidecars: readonly string[]): StorageError {
  return new StorageError(
    'malformed-medium',
    `storage database at "${database}" is absent but SQLite sidecar ${sidecars.map(path => `"${path}"`).join(', ')} exists`,
  )
}

async function inspectOwnedEmptyDatabaseFile(
  path: string,
  identity: FileIdentity,
  effects: SqliteSchemaEffects,
): Promise<'missing' | 'changed' | 'owned'> {
  let current: Awaited<ReturnType<typeof lstat>>
  try {
    current = await effects.lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
  return current.isFile()
    && current.dev === identity.dev
    && current.ino === identity.ino
    && current.size === 0
    ? 'owned'
    : 'changed'
}

async function assertOwnedEmptyDatabaseFile(
  path: string,
  identity: FileIdentity,
  effects: SqliteSchemaEffects,
): Promise<void> {
  const state = await inspectOwnedEmptyDatabaseFile(path, identity, effects)
  if (state === 'missing') {
    throw new StorageError('malformed-medium', `new SQLite database path "${path}" disappeared during creation`)
  }
  if (state === 'changed') {
    throw new StorageError('malformed-medium', `new SQLite database path "${path}" changed during creation`)
  }
}

async function discardCreatedDatabaseFile(
  path: string,
  created: CreatedDatabaseFile,
  primary: unknown,
  effects: SqliteSchemaEffects,
): Promise<never> {
  const failures = [primary]
  try {
    await removeOwnedEmptyDatabaseFile(path, created.identity, effects)
  } catch (cleanupError) {
    failures.push(cleanupError)
  }
  try {
    await created.handle.close()
  } catch (closeError) {
    failures.push(closeError)
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'sqlite database creation and owned-file cleanup both failed')
  }
  throw primary
}

async function removeOwnedEmptyDatabaseFile(
  path: string,
  identity: FileIdentity,
  effects: SqliteSchemaEffects,
): Promise<void> {
  const state = await inspectOwnedEmptyDatabaseFile(path, identity, effects)
  if (state === 'missing') return
  if (state === 'changed') {
    throw new StorageError('malformed-medium', `refusing to remove changed SQLite database path "${path}"`)
  }
  await effects.rm(path)
}

function assertTable(
  db: DatabaseSync,
  table: string,
  expected: readonly ExpectedColumn[],
  withoutRowid: boolean,
  expectedSql: string,
): void {
  const tableRows = db.prepare('PRAGMA table_list').all() as unknown as Array<{
    name: string
    type: string
    wr: number
    strict: number
  }>
  const found = tableRows.find(row => row.name === table && row.type === 'table')
  if (found === undefined || found.strict !== 1 || found.wr !== Number(withoutRowid)) {
    throw new Error(`table '${table}' has an incompatible physical definition`)
  }
  const columns = db.prepare(`PRAGMA table_xinfo("${table}")`).all() as unknown as TableColumn[]
  if (columns.length !== expected.length || columns.some((column, index) => {
    const wanted = expected[index]
    return wanted === undefined
      || column.cid !== index
      || column.name !== wanted.name
      || column.type !== wanted.type
      || column.notnull !== wanted.notnull
      || column.pk !== wanted.pk
      || column.hidden !== 0
      || column.dflt_value !== null
  })) {
    throw new Error(`table '${table}' has incompatible columns`)
  }
  const schema = db.prepare(`
    SELECT CAST(sql AS BLOB) AS sql_bytes FROM sqlite_schema
    WHERE type = 'table' AND name = ?
  `).get(table) as { sql_bytes: Uint8Array | null } | undefined
  if (schema?.sql_bytes === null
    || schema === undefined
    || !sameSqlTokens(decodeSqliteText(schema.sql_bytes), expectedSql)) {
    throw new Error(`table '${table}' has an incompatible physical definition`)
  }
}

function decodeSchemaText(bytes: Uint8Array | null, column: string): string {
  if (bytes === null) throw new Error(`${column} is NULL`)
  return decodeSqliteText(bytes)
}

function recordTableSql(table: string): string {
  const identifier = table.replaceAll('"', '""')
  return `CREATE TABLE "${identifier}" (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT`
}

function sameSqlTokens(actual: string, expected: string): boolean {
  const actualTokens = sqlTokens(actual)
  const expectedTokens = sqlTokens(expected)
  return actualTokens !== undefined
    && expectedTokens !== undefined
    && actualTokens.length === expectedTokens.length
    && actualTokens.every((token, index) => token === expectedTokens[index])
}

function sqlTokens(sql: string): string[] | undefined {
  const tokens: string[] = []
  let offset = 0
  while (offset < sql.length) {
    const whitespace = /^[\t\n\r ]+/.exec(sql.slice(offset))
    if (whitespace !== null) {
      offset += whitespace[0].length
      continue
    }
    if (sql[offset] === '"') {
      let identifier = ''
      let closed = false
      offset += 1
      while (offset < sql.length) {
        const character = sql.charAt(offset)
        if (character !== '"') {
          identifier += character
          offset += 1
          continue
        }
        // Owned table identifiers are fixed names or validated-name hex, so an
        // escaped quote can never match their expected SQL.
        offset += 1
        closed = true
        break
      }
      if (!closed) return undefined
      tokens.push(`word:${identifier.toLowerCase()}`)
      continue
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(offset))
    if (word !== null) {
      tokens.push(`word:${word[0].toLowerCase()}`)
      offset += word[0].length
      continue
    }
    const integer = /^\d+/.exec(sql.slice(offset))
    if (integer !== null) {
      tokens.push(`integer:${integer[0]}`)
      offset += integer[0].length
      continue
    }
    const comparison = sql.slice(offset, offset + 2)
    if (comparison === '>=' || comparison === '<=') {
      tokens.push(`symbol:${comparison}`)
      offset += 2
      continue
    }
    const symbol = sql.charAt(offset)
    if (symbol === '(' || symbol === ')' || symbol === ',') {
      tokens.push(`symbol:${symbol}`)
      offset += 1
      continue
    }
    return undefined
  }
  return tokens
}

function assertForeignKey(
  db: DatabaseSync,
  sourceTable: string,
  sourceColumn: string,
  targetTable: string,
  targetColumn: string,
): void {
  const rows = db.prepare(`PRAGMA foreign_key_list("${sourceTable}")`).all() as unknown as ForeignKeyRow[]
  const row = rows[0]
  if (rows.length !== 1
    || row === undefined
    || row.id !== 0
    || row.seq !== 0
    || row.table !== targetTable
    || row.from !== sourceColumn
    || row.to !== targetColumn
    || row.on_update !== 'NO ACTION'
    || row.on_delete !== 'NO ACTION'
    || row.match !== 'NONE') {
    throw new Error(`table '${sourceTable}' has incompatible foreign keys`)
  }
}

async function snapshotSource(
  database: string,
  signal: AbortSignal,
  effects: SqliteSchemaEffects,
): Promise<SourceFile[]> {
  const paths = [database, `${database}-wal`, `${database}-shm`, `${database}-journal`]
  const snapshot: SourceFile[] = []
  for (const path of paths) {
    signal.throwIfAborted()
    const entry = await statRegularFile(path, effects)
    if (entry !== undefined) {
      snapshot.push({ path, size: Number(entry.size), digest: await digestFile(path, signal, effects) })
    }
  }
  return snapshot
}

async function copyPrivateFile(source: string, target: string, effects: SqliteSchemaEffects): Promise<void> {
  await effects.copyFile(source, target)
  await effects.chmod(target, 0o600)
}

function sameSourceSnapshot(left: readonly SourceFile[], right: readonly SourceFile[]): boolean {
  return left.length === right.length && left.every((file, index) => {
    const other = right[index]
    return other !== undefined
      && file.path === other.path
      && file.size === other.size
      && file.digest === other.digest
  })
}

async function digestFile(path: string, signal: AbortSignal, effects: SqliteSchemaEffects): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of effects.createReadStream(path, { signal })) hash.update(chunk as Uint8Array)
  return hash.digest('hex')
}

async function statRegularFile(
  path: string,
  effects: SqliteSchemaEffects,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    const entry = await effects.lstat(path)
    if (!entry.isFile()) {
      throw new StorageError('malformed-medium', `storage medium at "${path}" is not a regular file`)
    }
    return entry
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function physicalVersionError(path: string, version: number | undefined): StorageError {
  return new StorageError(
    'version-mismatch',
    `storage database at "${path}" has physical version ${String(version)}, incompatible with writer version ${STORAGE_SQLITE_SCHEMA_VERSION}`,
  )
}

function wrapMalformed(path: string, operation: () => void): void {
  try {
    operation()
  } catch (error) {
    if (error instanceof StorageError) throw error
    throw new StorageError('malformed-medium', `storage database at "${path}" has an invalid physical layout`, {
      cause: error,
    })
  }
}

function rollbackOrAggregate(db: DatabaseSync, primary: unknown): never {
  try {
    db.exec('ROLLBACK')
  } catch (rollbackError) {
    throw new AggregateError([primary, rollbackError], 'sqlite transaction and rollback both failed')
  }
  throw primary
}

function closeAfterFailure(db: DatabaseSync, primary: unknown): never {
  try {
    db.close()
  } catch (closeError) {
    throw new AggregateError([primary, closeError], 'sqlite open and close both failed')
  }
  throw primary
}
