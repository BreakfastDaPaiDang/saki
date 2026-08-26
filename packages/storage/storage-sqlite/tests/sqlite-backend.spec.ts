import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createReadStream } from 'node:fs'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import Storage, { StorageError, storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { KvClosedUnitLease, KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import { runKvBackendContract, runKvClosedUnitContract } from '../../storage/tests/contract.ts'
import * as StorageSqlite from '../src/index.ts'
import { Config, SqliteStorageBackend, STORAGE_SQLITE_SCHEMA_VERSION } from '../src/index.ts'
import {
  SqliteClosedUnitOperations,
  inspectExistingDatabase,
  materializeV2,
  readExistingDatabase,
  validateDescriptor,
} from '../src/closed.ts'
import type { SqliteDatabaseAccess } from '../src/closed.ts'
import { encodeRecordKey } from '../src/key.ts'
import {
  legacyRecordTableName,
  listUserSchemaObjects,
  openDatabase,
  openExistingDatabaseReadonly,
  recordTableName,
  validateLegacyV1Database,
  validateRecordTable,
  validateV2Database,
} from '../src/schema.ts'
import type { SqliteSchemaEffects } from '../src/schema.ts'

/** Mirror the loader: resolve schemastery defaults before construction. */
function backendAt(
  path: string,
  journalMode?: 'wal' | 'delete' | 'truncate' | 'persist',
): SqliteStorageBackend {
  return new SqliteStorageBackend(new Config({ path, ...(journalMode === undefined ? {} : { journalMode }) }))
}

const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

async function freshDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-storage-sqlite-'))
  dirs.push(dir)
  return join(dir, 'storage.db')
}

interface DirectoryEntrySnapshot {
  name: string
  kind: 'file' | 'directory' | 'symlink' | 'other'
  mode: number
  content?: Buffer | string
}

async function snapshotDirectory(path: string): Promise<DirectoryEntrySnapshot[]> {
  const snapshot: DirectoryEntrySnapshot[] = []
  for (const name of (await readdir(path)).sort()) {
    const entry = await lstat(join(path, name))
    const kind = entry.isFile()
      ? 'file'
      : entry.isDirectory()
        ? 'directory'
        : entry.isSymbolicLink()
          ? 'symlink'
          : 'other'
    snapshot.push({
      name,
      kind,
      mode: entry.mode,
      ...(kind === 'file'
        ? { content: await readFile(join(path, name)) }
        : kind === 'symlink'
          ? { content: await readlink(join(path, name)) }
          : {}),
    })
  }
  return snapshot
}

// The contract suite's reopen() needs a surviving medium, so the harness binds
// a real file; :memory: gets its own cases below.
async function sqliteHarness() {
  const path = await freshDbPath()
  return {
    backend: backendAt(path),
    reopen: async () => backendAt(path),
  }
}

runKvBackendContract('sqlite', sqliteHarness)
runKvClosedUnitContract('sqlite', sqliteHarness)

const DESCRIPTOR: KvUnitDescriptor = {
  name: 'specimen',
  version: 1,
  tables: ['records'],
  hasGlobal: true,
}

const NONEXACT_STORED_JSON = [
  ['nested duplicate keys', '{"nested":{"same":1,"same":2}}'],
  ['an unsafe integer', '9007199254740993'],
  ['numeric underflow', '1e-4000'],
  ['numeric overflow', '1e400'],
  ['trailing bytes after NUL', '{"ok":1}\0junk'],
  ['a byte-order mark', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"ok":1}')])],
  ['invalid UTF-8 in a quoted string', Buffer.from([0x22, 0x80, 0x22])],
] as const

type DefensiveDatabase = DatabaseSync & {
  enableDefensive?: (enabled: boolean) => void
}

function setDefensive(db: DatabaseSync, enabled: boolean): void {
  const enableDefensive = (db as DefensiveDatabase).enableDefensive
  enableDefensive?.call(db, enabled)
}

function createV2Schema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE units (
      name TEXT PRIMARY KEY,
      version INTEGER NOT NULL CHECK (version >= 0 AND version <= 9007199254740991),
      has_global INTEGER NOT NULL CHECK (has_global IN (0, 1))
    ) STRICT;
    CREATE TABLE unit_tables (
      unit TEXT NOT NULL REFERENCES units(name),
      table_name TEXT NOT NULL,
      PRIMARY KEY (unit, table_name)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE unit_globals (
      unit TEXT PRIMARY KEY REFERENCES units(name),
      value TEXT NOT NULL
    ) STRICT;
    PRAGMA user_version = ${STORAGE_SQLITE_SCHEMA_VERSION};
  `)
}

function insertV2Unit(db: DatabaseSync, descriptor: KvUnitDescriptor): void {
  db.prepare('INSERT INTO units (name, version, has_global) VALUES (?, ?, ?)')
    .run(descriptor.name, descriptor.version, Number(descriptor.hasGlobal))
  for (const table of descriptor.tables) {
    db.prepare('INSERT INTO unit_tables (unit, table_name) VALUES (?, ?)').run(descriptor.name, table)
    db.exec(`CREATE TABLE "${recordTableName(descriptor.name, table)}" (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT`)
  }
}

function createStoredRawValue(
  path: string,
  layout: 'current' | 'legacy',
  descriptor: KvUnitDescriptor,
  raw: string | Uint8Array,
): void {
  const db = new DatabaseSync(path)
  db.prepare('PRAGMA journal_mode = PERSIST').get()
  if (layout === 'current') {
    createV2Schema(db)
    insertV2Unit(db, descriptor)
  } else {
    const physical = legacyRecordTableName(descriptor.name, 'records')
    db.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE units (name TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT;
      CREATE TABLE unit_globals (unit TEXT PRIMARY KEY REFERENCES units(name), value TEXT NOT NULL) STRICT;
      CREATE TABLE "${physical}" (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
    `)
    db.prepare('INSERT INTO units (name, version) VALUES (?, ?)').run(descriptor.name, descriptor.version)
  }
  const physical = layout === 'current'
    ? recordTableName(descriptor.name, 'records')
    : legacyRecordTableName(descriptor.name, 'records')
  db.exec('BEGIN IMMEDIATE')
  db.prepare(`INSERT INTO "${physical}" (key, value) VALUES (?, CAST(? AS TEXT))`).run(
    layout === 'current' ? encodeRecordKey('raw') : 'raw',
    raw,
  )
  db.exec('COMMIT')
  db.close()
}

function replaceRawSchemaCell(
  db: DatabaseSync,
  objectName: string,
  column: 'type' | 'name' | 'tbl_name' | 'sql',
  value: Uint8Array,
): void {
  setDefensive(db, false)
  db.exec('PRAGMA writable_schema = ON')
  try {
    db.prepare(`UPDATE sqlite_schema SET ${column} = CAST(? AS TEXT) WHERE name = ?`)
      .run(value, objectName)
  } finally {
    db.exec('PRAGMA writable_schema = OFF')
    setDefensive(db, true)
  }
}

function rewriteRawSchemaSql(
  path: string,
  table: string,
  prefix: Uint8Array,
  suffix: Uint8Array,
): void {
  const db = new DatabaseSync(path)
  try {
    const row = db.prepare(`
      SELECT CAST(sql AS BLOB) AS sql_bytes
      FROM sqlite_schema
      WHERE type = 'table' AND name = ?
    `).get(table) as { sql_bytes: Uint8Array } | undefined
    if (row === undefined) throw new Error(`missing schema row for '${table}'`)
    replaceRawSchemaCell(db, table, 'sql', Buffer.concat([
      Buffer.from(prefix),
      Buffer.from(row.sql_bytes),
      Buffer.from(suffix),
    ]))
  } finally {
    db.close()
  }
}

function withReserved<T>(
  backend: SqliteStorageBackend,
  name: string,
  operation: (lease: KvClosedUnitLease) => Promise<T>,
): Promise<T> {
  return backend.kv.closed!.withReservedUnit(name, new AbortController().signal, operation)
}

async function expectOrphanSidecarRejected(path: string): Promise<void> {
  const directory = dirname(path)
  const before = await snapshotDirectory(directory)

  const closedReader = backendAt(path, 'delete')
  await expect(withReserved(closedReader, DESCRIPTOR.name, lease => lease.inspect()))
    .rejects.toMatchObject({ code: 'malformed-medium' })
  await closedReader.close()
  expect(await snapshotDirectory(directory)).toEqual(before)

  const ordinary = backendAt(path, 'delete')
  await expect(ordinary.kv.open(DESCRIPTOR)).rejects.toMatchObject({ code: 'malformed-medium' })
  await ordinary.close()
  expect(await snapshotDirectory(directory)).toEqual(before)

  const materializer = backendAt(path, 'delete')
  await expect(withReserved(materializer, DESCRIPTOR.name, lease => lease.materializeMissing(DESCRIPTOR, {
    tables: { records: {} },
    global: null,
  }))).rejects.toMatchObject({ code: 'malformed-medium' })
  await materializer.close()
  expect(await snapshotDirectory(directory)).toEqual(before)
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
}

async function leaveHotRollbackJournal(path: string, physicalTable: string, value: string): Promise<void> {
  const childSource = `
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(${JSON.stringify(path)})
    db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA cache_size = 1; PRAGMA cache_spill = ON; BEGIN IMMEDIATE')
    db.prepare(${JSON.stringify(`UPDATE "${physicalTable}" SET value = ?`)}).run(${JSON.stringify(value)})
    process.stdout.write('ready\\n')
    setInterval(() => {}, 1_000)
  `
  const child = spawn(process.execPath, ['-e', childSource], { stdio: ['ignore', 'pipe', 'pipe'] })
  const stderr: Buffer[] = []
  child.stderr.on('data', chunk => stderr.push(chunk as Buffer))
  const exited = once(child, 'exit')
  await new Promise<void>((resolve, reject) => {
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
      if (output.includes('ready\n')) resolve()
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      reject(new Error(
        `hot-journal writer exited before readiness (${String(code)}/${String(signal)}): ${Buffer.concat(stderr).toString('utf8')}`,
      ))
    })
  })
  child.kill('SIGKILL')
  await exited
}

function withCommitFault(
  database: DatabaseSync,
  outcome: 'active' | 'committed' | 'auto-rollback',
  commitFailure: Error,
  rollbackFailure?: Error,
  afterCommit?: () => void,
): DatabaseSync {
  let commitArmed = true
  let rollbackArmed = rollbackFailure !== undefined
  return new Proxy(database, {
    get(target, property) {
      if (property === 'exec') {
        return (sql: string): void => {
          if (sql === 'COMMIT' && commitArmed) {
            commitArmed = false
            if (outcome === 'committed') {
              target.exec(sql)
              afterCommit?.()
            }
            if (outcome === 'auto-rollback') target.exec('ROLLBACK')
            throw commitFailure
          }
          if (sql === 'ROLLBACK' && rollbackArmed) {
            rollbackArmed = false
            throw rollbackFailure ?? new Error('missing rollback fault')
          }
          target.exec(sql)
        }
      }
      return bindMethod(Reflect.get(target, property, target) as unknown, target)
    },
  })
}

function withActiveBeginFault(database: DatabaseSync, failure: Error): DatabaseSync {
  let armed = true
  return new Proxy(database, {
    get(target, property) {
      if (property === 'exec') {
        return (sql: string): void => {
          if (sql === 'BEGIN IMMEDIATE' && armed) {
            armed = false
            target.exec(sql)
            throw failure
          }
          target.exec(sql)
        }
      }
      return bindMethod(Reflect.get(target, property, target) as unknown, target)
    },
  })
}

function withStatementRunFault(
  database: DatabaseSync,
  sqlPattern: RegExp,
  failure: unknown,
  afterRun?: (database: DatabaseSync) => void,
): DatabaseSync {
  let armed = true
  return new Proxy(database, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) => {
          const statement = target.prepare(sql)
          if (!sqlPattern.test(sql)) return statement
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              if (statementProperty === 'run') {
                return (...args: unknown[]) => {
                  const run = Reflect.get(statementTarget, 'run', statementTarget) as
                    (...parameters: unknown[]) => unknown
                  const result = Reflect.apply(run, statementTarget, args)
                  if (armed) {
                    armed = false
                    afterRun?.(target)
                    throw failure
                  }
                  return result
                }
              }
              return bindMethod(
                Reflect.get(statementTarget, statementProperty, statementTarget) as unknown,
                statementTarget,
              )
            },
          })
        }
      }
      return bindMethod(Reflect.get(target, property, target) as unknown, target)
    },
  })
}

function withTransactionStateFault(database: DatabaseSync, failure: unknown): DatabaseSync {
  return new Proxy(database, {
    get(target, property) {
      if (property === 'isTransaction') throw failure
      return bindMethod(Reflect.get(target, property, target) as unknown, target)
    },
  })
}

function withInactiveBeginFault(database: DatabaseSync, failure: unknown): DatabaseSync {
  let armed = true
  return new Proxy(database, {
    get(target, property) {
      if (property === 'exec') {
        return (sql: string): void => {
          if (sql === 'BEGIN IMMEDIATE' && armed) {
            armed = false
            throw failure
          }
          target.exec(sql)
        }
      }
      return bindMethod(Reflect.get(target, property, target) as unknown, target)
    },
  })
}

function withArmedStatementFault(
  database: DatabaseSync,
  sqlPattern: RegExp,
  method: 'all' | 'run',
  failure: unknown,
): { database: DatabaseSync; arm(): void } {
  let armed = false
  return {
    arm: () => { armed = true },
    database: new Proxy(database, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql: string) => {
            const statement = target.prepare(sql)
            if (!sqlPattern.test(sql)) return statement
            return new Proxy(statement, {
              get(statementTarget, statementProperty) {
                if (statementProperty === method) {
                  return (...args: unknown[]) => {
                    if (armed) throw failure
                    const operation = Reflect.get(statementTarget, method, statementTarget) as
                      (...parameters: unknown[]) => unknown
                    return Reflect.apply(operation, statementTarget, args)
                  }
                }
                return bindMethod(
                  Reflect.get(statementTarget, statementProperty, statementTarget) as unknown,
                  statementTarget,
                )
              },
            })
          }
        }
        return bindMethod(Reflect.get(target, property, target) as unknown, target)
      },
    }),
  }
}

function bindMethod(value: unknown, receiver: object): unknown {
  if (typeof value !== 'function') return value
  const operation = value as (...args: unknown[]) => unknown
  return (...args: unknown[]): unknown => Reflect.apply(operation, receiver, args)
}

function backendWithReadyDatabase(database: DatabaseSync, path = ':memory:'): SqliteStorageBackend {
  const backend = backendAt(path, 'delete')
  const internalBackend = backend as unknown as { ready: Promise<DatabaseSync> }
  internalBackend.ready = Promise.resolve(database)
  return backend
}

const TEST_SCHEMA_EFFECTS: SqliteSchemaEffects = {
  chmod,
  copyFile,
  createDatabase: (path, options) => options === undefined
    ? new DatabaseSync(path)
    : new DatabaseSync(path, options),
  createReadStream,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rm,
}

function schemaEffects(overrides: Partial<SqliteSchemaEffects>): SqliteSchemaEffects {
  return { ...TEST_SCHEMA_EFFECTS, ...overrides }
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`injected ${code}`), { code })
}

describe('sqlite backend specifics', () => {
  it('inspects a missing in-memory medium without initializing it', async () => {
    const backend = backendAt(':memory:')
    await expect(withReserved(backend, DESCRIPTOR.name, lease => lease.inspect())).resolves.toBeUndefined()
    expect((backend as unknown as { ready?: Promise<DatabaseSync> }).ready).toBeUndefined()
    await backend.close()
  })

  it('observes cancellation after awaiting in-memory read readiness', async () => {
    const backend = backendAt(':memory:', 'delete')
    const database = await openDatabase(':memory:', 'delete')
    const ready = Promise.withResolvers<DatabaseSync>()
    const internalBackend = backend as unknown as { ready: Promise<DatabaseSync> }
    internalBackend.ready = ready.promise
    const controller = new AbortController()
    const cancelled = new Error('cancelled while sqlite reader opened')
    const inspecting = backend.kv.closed!.withReservedUnit(
      DESCRIPTOR.name,
      controller.signal,
      lease => lease.inspect(),
    )
    await Promise.resolve()
    controller.abort(cancelled)
    ready.resolve(database)
    try {
      await expect(inspecting).rejects.toBe(cancelled)
    } finally {
      await backend.close()
    }
  })

  it('closes a frozen file view when cancellation arrives after acquisition', async () => {
    const path = await freshDbPath()
    const seeded = backendAt(path, 'delete')
    await (await seeded.kv.open(DESCRIPTOR)).close()
    await seeded.close()
    const backend = backendAt(path, 'delete')
    const internalBackend = backend as unknown as {
      acquireClosedRead(signal: AbortSignal): Promise<SqliteDatabaseAccess>
    }
    const baseSignal = new AbortController().signal
    let throwChecks = 0
    const countingSignal = new Proxy(baseSignal, {
      get(target, property) {
        if (property === 'throwIfAborted') return () => { throwChecks += 1 }
        return bindMethod(Reflect.get(target, property, target) as unknown, target)
      },
    })
    const acquired = await internalBackend.acquireClosedRead(countingSignal)
    await acquired.release()
    const frozenDirectoriesBeforeCancellation = (await readdir(tmpdir()))
      .filter(name => name.startsWith('dsh-storage-sqlite-read-'))
      .sort()

    const cancelled = new Error('cancelled after frozen view acquisition')
    let currentCheck = 0
    const cancellingSignal = new Proxy(baseSignal, {
      get(target, property) {
        if (property === 'throwIfAborted') {
          return () => {
            currentCheck += 1
            if (currentCheck === throwChecks) throw cancelled
          }
        }
        return bindMethod(Reflect.get(target, property, target) as unknown, target)
      },
    })
    try {
      await expect(internalBackend.acquireClosedRead(cancellingSignal)).rejects.toBe(cancelled)
      expect((await readdir(tmpdir()))
        .filter(name => name.startsWith('dsh-storage-sqlite-read-'))
        .sort()).toEqual(frozenDirectoriesBeforeCancellation)
    } finally {
      await backend.close()
    }
  })

  it('keeps an admitted unawaited lease method reserved through materialization', async () => {
    const database = await openDatabase(':memory:', 'delete')
    const entered = Promise.withResolvers<undefined>()
    const releaseWrite = Promise.withResolvers<undefined>()
    const primaryReleased = Promise.withResolvers<undefined>()
    let reserved = false
    let reservationCount = 0
    const closed = new SqliteClosedUnitOperations(
      () => {
        if (reserved) throw new StorageError('unit-open', 'unit is already reserved')
        reserved = true
        const ordinal = ++reservationCount
        return () => {
          reserved = false
          if (ordinal === 1) primaryReleased.resolve(undefined)
        }
      },
      async () => ({
        database,
        version: STORAGE_SQLITE_SCHEMA_VERSION,
        release: () => {},
      }),
      async () => {
        entered.resolve(undefined)
        await releaseWrite.promise
        return {
          database,
          version: STORAGE_SQLITE_SCHEMA_VERSION,
          release: () => {},
        }
      },
      () => {},
    )
    let escapedLease!: KvClosedUnitLease
    let materializing!: ReturnType<KvClosedUnitLease['materializeMissing']>
    let scopeSettled = false
    const scoped = closed.withReservedUnit(DESCRIPTOR.name, new AbortController().signal, async (lease) => {
      escapedLease = lease
      materializing = lease.materializeMissing(DESCRIPTOR, {
        tables: { records: { retained: true } },
        global: null,
      })
    }).then(() => { scopeSettled = true })
    await entered.promise
    let closeSettled = false
    void primaryReleased.promise.then(() => { closeSettled = true })
    let committed: Awaited<typeof materializing> | undefined
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(scopeSettled).toBe(false)
      expect(closeSettled).toBe(false)
      await expect(closed.withReservedUnit(
        DESCRIPTOR.name, new AbortController().signal, lease => lease.inspect(),
      )).rejects.toMatchObject({ code: 'unit-open' })
    } finally {
      releaseWrite.resolve(undefined)
      const [materialization] = await Promise.allSettled([materializing, scoped])
      if (materialization.status === 'fulfilled') committed = materialization.value
    }
    try {
      if (committed === undefined) throw new Error('admitted materialization did not complete')
      expect(closeSettled).toBe(true)
      await expect(escapedLease.inspect()).rejects.toMatchObject({ code: 'closed' })
      await expect(committed.readBack()).rejects.toMatchObject({ code: 'closed' })
    } finally {
      database.close()
    }
  })

  it('owns materialization inputs before waiting for writable access', async () => {
    const database = await openDatabase(':memory:', 'delete')
    const entered = Promise.withResolvers<undefined>()
    const releaseWrite = Promise.withResolvers<undefined>()
    const expectedDescriptor: KvUnitDescriptor = {
      name: 'owned',
      version: 1,
      tables: ['records'],
      hasGlobal: true,
    }
    const descriptor = { ...expectedDescriptor, tables: [...expectedDescriptor.tables] }
    const snapshot = {
      tables: { records: { retained: { state: 'validated' } } },
      global: { state: 'validated' },
    }
    const closed = new SqliteClosedUnitOperations(
      () => () => {},
      async () => ({
        database,
        version: STORAGE_SQLITE_SCHEMA_VERSION,
        release: () => {},
      }),
      async () => {
        entered.resolve(undefined)
        await releaseWrite.promise
        return {
          database,
          version: STORAGE_SQLITE_SCHEMA_VERSION,
          release: () => {},
        }
      },
      () => {},
    )
    const materializing = closed.withReservedUnit(
      expectedDescriptor.name,
      new AbortController().signal,
      lease => lease.materializeMissing(descriptor, snapshot),
    )
    await entered.promise
    descriptor.name = 'mutated'
    descriptor.version = 99
    descriptor.tables[0] = 'changed'
    descriptor.hasGlobal = false
    snapshot.tables.records.retained.state = 'mutated'
    snapshot.global.state = 'mutated'
    releaseWrite.resolve(undefined)
    try {
      await expect(materializing).resolves.toMatchObject({ outcome: 'durable' })
      expect(readExistingDatabase(database, expectedDescriptor)).toEqual({
        tables: { records: { retained: { state: 'validated' } } },
        global: { state: 'validated' },
      })
    } finally {
      releaseWrite.resolve(undefined)
      database.close()
    }
  })

  it('returns an uncertain token when COMMIT published before throwing and poisons the shared connection', async () => {
    const path = await freshDbPath()
    const database = await openDatabase(path, 'delete')
    const failure = new Error('injected post-commit failure')
    const backend = backendWithReadyDatabase(withCommitFault(database, 'committed', failure), path)
    try {
      await withReserved(backend, DESCRIPTOR.name, async (lease) => {
        const materialization = await lease.materializeMissing(DESCRIPTOR, {
          tables: { records: { committed: { visible: true } } },
          global: null,
        })
        expect(materialization).toMatchObject({ outcome: 'uncertain', cause: failure })
        await expect(materialization.readBack()).resolves.toEqual({
          tables: { records: { committed: { visible: true } } },
          global: null,
        })
      })
      await expect(backend.kv.open({ ...DESCRIPTOR, name: 'another' })).rejects.toThrow(/writer.*indeterminate/i)
      await expect(withReserved(backend, 'another', lease => lease.materializeMissing(
        { ...DESCRIPTOR, name: 'another' },
        { tables: { records: {} }, global: null },
      ))).rejects.toThrow(/writer.*indeterminate/i)
      await expect(withReserved(backend, DESCRIPTOR.name, lease => lease.read(DESCRIPTOR))).resolves.toEqual({
        tables: { records: { committed: { visible: true } } },
        global: null,
      })
    } finally {
      await backend.close()
    }
  })

  it('returns an uncertain token whose readback confirms an auto-rolled-back COMMIT is absent', async () => {
    const path = await freshDbPath()
    const database = await openDatabase(path, 'delete')
    const failure = new Error('injected post-auto-rollback failure')
    const backend = backendWithReadyDatabase(withCommitFault(database, 'auto-rollback', failure), path)
    try {
      await withReserved(backend, DESCRIPTOR.name, async (lease) => {
        const materialization = await lease.materializeMissing(DESCRIPTOR, {
          tables: { records: {} },
          global: null,
        })
        expect(materialization).toMatchObject({ outcome: 'uncertain', cause: failure })
        await expect(materialization.readBack()).resolves.toBeUndefined()
      })
      await expect(backend.kv.open(DESCRIPTOR)).rejects.toThrow(/writer.*indeterminate/i)
    } finally {
      await backend.close()
    }
  })

  it('rolls back an active transaction after COMMIT throws and keeps the writer usable', async () => {
    const database = await openDatabase(':memory:', 'delete')
    const failure = new Error('injected active commit failure')
    const backend = backendWithReadyDatabase(withCommitFault(database, 'active', failure))
    try {
      await expect(withReserved(backend, DESCRIPTOR.name, lease => lease.materializeMissing(DESCRIPTOR, {
        tables: { records: {} },
        global: null,
      }))).rejects.toBe(failure)
      await withReserved(backend, DESCRIPTOR.name, async (lease) => {
        const retry = await lease.materializeMissing(DESCRIPTOR, { tables: { records: {} }, global: null })
        expect(retry.outcome).toBe('durable')
      })
    } finally {
      await backend.close()
    }
  })

  it('rolls back a transaction left active when BEGIN itself throws', async () => {
    const database = await openDatabase(':memory:', 'delete')
    const failure = new Error('injected active begin failure')
    const backend = backendWithReadyDatabase(withActiveBeginFault(database, failure))
    try {
      await expect(withReserved(backend, DESCRIPTOR.name, lease => lease.materializeMissing(DESCRIPTOR, {
        tables: { records: {} },
        global: null,
      }))).rejects.toBe(failure)
      await withReserved(backend, DESCRIPTOR.name, async (lease) => {
        const retry = await lease.materializeMissing(DESCRIPTOR, { tables: { records: {} }, global: null })
        expect(retry.outcome).toBe('durable')
      })
    } finally {
      await backend.close()
    }
  })

  it('poisons the writer when rollback after a failed COMMIT also fails', async () => {
    const database = await openDatabase(':memory:', 'delete')
    const backend = backendWithReadyDatabase(withCommitFault(
      database,
      'active',
      new Error('injected commit failure'),
      new Error('injected rollback failure'),
    ))
    await expect(withReserved(backend, DESCRIPTOR.name, lease => lease.materializeMissing(DESCRIPTOR, {
      tables: { records: {} },
      global: null,
    }))).rejects.toThrow(/rollback/i)
    await expect(backend.kv.open(DESCRIPTOR)).rejects.toThrow(/writer.*indeterminate/i)
    await expect(withReserved(backend, DESCRIPTOR.name, lease => lease.inspect()))
      .rejects.toThrow(/writer.*indeterminate/i)
    await expect(backend.close()).resolves.toBeUndefined()
  })

  it('poisons ordinary missing-unit initialization when COMMIT rollback fails', async () => {
    const database = await openDatabase(':memory:', 'delete')
    const backend = backendWithReadyDatabase(withCommitFault(
      database,
      'active',
      new Error('injected ordinary commit failure'),
      new Error('injected ordinary rollback failure'),
    ))
    await expect(backend.kv.open(DESCRIPTOR)).rejects.toThrow(/rollback/i)
    await expect(backend.kv.open(DESCRIPTOR)).rejects.toThrow(/writer.*indeterminate/i)
    await expect(withReserved(backend, DESCRIPTOR.name, lease => lease.inspect()))
      .rejects.toThrow(/writer.*indeterminate/i)
    await expect(backend.close()).resolves.toBeUndefined()
  })

  it('does not treat an uncertain ordinary missing-unit initialization as a successful open', async () => {
    const path = await freshDbPath()
    const database = await openDatabase(path, 'delete')
    const failure = new Error('injected post-initialization commit failure')
    const backend = backendWithReadyDatabase(withCommitFault(database, 'committed', failure), path)
    try {
      await expect(backend.kv.open(DESCRIPTOR)).rejects.toMatchObject({
        code: 'durability-uncertain',
        published: true,
        cause: failure,
      })
      await expect(withReserved(backend, DESCRIPTOR.name, lease => lease.read(DESCRIPTOR))).resolves.toEqual({
        tables: { records: {} },
        global: null,
      })
      await expect(backend.kv.open(DESCRIPTOR)).rejects.toThrow(/writer.*indeterminate/i)
    } finally {
      await backend.close()
    }
  })

  it('rethrows the COMMIT cause when ordinary initialization readback confirms absence', async () => {
    const path = await freshDbPath()
    const database = await openDatabase(path, 'delete')
    const failure = new Error('injected rolled-back initialization failure')
    const backend = backendWithReadyDatabase(withCommitFault(database, 'auto-rollback', failure), path)
    try {
      await expect(backend.kv.open(DESCRIPTOR)).rejects.toBe(failure)
      await expect(withReserved(backend, DESCRIPTOR.name, lease => lease.inspect())).resolves.toBeUndefined()
      await expect(backend.kv.open(DESCRIPTOR)).rejects.toThrow(/writer.*indeterminate/i)
    } finally {
      await backend.close()
    }
  })

  it('preserves published evidence when uncertain initialization readback cleanup also fails', async () => {
    const path = await freshDbPath()
    const database = await openDatabase(path, 'delete')
    const commitFailure = new Error('injected initialization commit failure')
    const cleanupFailure = new Error('injected frozen-view cleanup failure')
    const backend = backendWithReadyDatabase(withCommitFault(database, 'committed', commitFailure), path)
    const internalBackend = backend as unknown as {
      acquireClosedRead(signal: AbortSignal): Promise<SqliteDatabaseAccess>
    }
    const acquireClosedRead = internalBackend.acquireClosedRead.bind(backend)
    internalBackend.acquireClosedRead = async (signal) => {
      const access = await acquireClosedRead(signal)
      return {
        ...access,
        release: async () => {
          await access.release()
          throw cleanupFailure
        },
      }
    }
    try {
      const error = await backend.kv.open(DESCRIPTOR).catch((failure: unknown) => failure)
      expect(error).toMatchObject({ code: 'durability-uncertain', published: true })
      expect((error as Error).cause).toBeInstanceOf(AggregateError)
    } finally {
      await backend.close()
    }
  })

  it('normalizes a non-Error uncertain-initialization readback failure', async () => {
    const path = await freshDbPath()
    const database = await openDatabase(path, 'delete')
    const backend = backendWithReadyDatabase(withCommitFault(
      database,
      'committed',
      new Error('injected initialization commit failure'),
    ), path)
    const internalBackend = backend as unknown as {
      acquireClosedRead(signal: AbortSignal): Promise<SqliteDatabaseAccess>
    }
    internalBackend.acquireClosedRead = async () => { throw 'injected readback failure' }
    try {
      const error = await backend.kv.open(DESCRIPTOR).catch((failure: unknown) => failure)
      expect(error).toMatchObject({ code: 'commit-outcome-unknown' })
      expect((error as Error).cause).toBeInstanceOf(AggregateError)
      expect(((error as Error).cause as AggregateError).errors[1]).toEqual(new Error('injected readback failure'))
    } finally {
      await backend.close()
    }
  })

  it('preserves commit-outcome-unknown when uncertain readback cleanup also fails', async () => {
    const path = await freshDbPath()
    const database = await openDatabase(path, 'delete')
    const commitFailure = new Error('injected initialization commit failure')
    const backend = backendWithReadyDatabase(withCommitFault(
      database,
      'committed',
      commitFailure,
    ), path)
    const invalidReadback = new DatabaseSync(':memory:')
    invalidReadback.exec('PRAGMA user_version = 99')
    const cleanupFailure = new Error('injected readback cleanup failure')
    const internalBackend = backend as unknown as {
      acquireClosedRead(signal: AbortSignal): Promise<SqliteDatabaseAccess>
    }
    internalBackend.acquireClosedRead = async () => ({
      database: invalidReadback,
      version: 99,
      release: () => { throw cleanupFailure },
    })
    try {
      const error = await backend.kv.open(DESCRIPTOR).catch((failure: unknown) => failure)
      expect(error).toMatchObject({ code: 'commit-outcome-unknown' })
      expect((error as Error).cause).toBeInstanceOf(AggregateError)
      const cleanupCause = (error as Error).cause as AggregateError
      expect(cleanupCause.errors[1]).toBe(cleanupFailure)
      expect(cleanupCause.errors[0]).toMatchObject({ code: 'commit-outcome-unknown' })
      const readbackCause = (cleanupCause.errors[0] as Error).cause
      expect(readbackCause).toBeInstanceOf(AggregateError)
      expect((readbackCause as AggregateError).errors).toEqual([
        commitFailure,
        expect.objectContaining({ code: 'version-mismatch' }),
      ])
    } finally {
      invalidReadback.close()
      await backend.close()
    }
  })

  it('aggregates cleanup failure when uncertain readback proves the unit absent', async () => {
    const path = await freshDbPath()
    const database = await openDatabase(path, 'delete')
    const commitFailure = new Error('injected initialization commit failure')
    const cleanupFailure = new Error('injected readback cleanup failure')
    const backend = backendWithReadyDatabase(withCommitFault(database, 'auto-rollback', commitFailure), path)
    const internalBackend = backend as unknown as {
      acquireClosedRead(signal: AbortSignal): Promise<SqliteDatabaseAccess>
    }
    internalBackend.acquireClosedRead = async () => ({
      database: undefined,
      version: undefined,
      release: () => { throw cleanupFailure },
    })
    try {
      const error = await backend.kv.open(DESCRIPTOR).catch((failure: unknown) => failure)
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors).toEqual([commitFailure, cleanupFailure])
    } finally {
      await backend.close()
    }
  })

  it('reports outcome unknown when visible initialization differs from the attempted snapshot', async () => {
    const path = await freshDbPath()
    const database = await openDatabase(path, 'delete')
    const backend = backendWithReadyDatabase(withCommitFault(
      database,
      'committed',
      new Error('injected initialization commit failure'),
      undefined,
      () => {
        database.prepare(
          `INSERT INTO "${recordTableName(DESCRIPTOR.name, 'records')}" (key, value) VALUES (?, ?)`,
        ).run(encodeRecordKey('different'), JSON.stringify({ source: 'other writer' }))
      },
    ), path)
    try {
      await expect(backend.kv.open(DESCRIPTOR)).rejects.toMatchObject({
        code: 'commit-outcome-unknown',
        publicationPossible: true,
      })
    } finally {
      await backend.close()
    }
  })

  it('reports outcome unknown when an in-memory uncertain initialization cannot use an independent read view', async () => {
    const database = await openDatabase(':memory:', 'delete')
    const backend = backendWithReadyDatabase(withCommitFault(
      database,
      'committed',
      new Error('injected in-memory initialization failure'),
    ))
    try {
      await expect(backend.kv.open(DESCRIPTOR)).rejects.toMatchObject({
        code: 'commit-outcome-unknown',
        publicationPossible: true,
      })
      await expect(withReserved(backend, DESCRIPTOR.name, lease => lease.inspect()))
        .rejects.toThrow(/writer.*indeterminate/i)
    } finally {
      await backend.close()
    }
  })

  it('reports an ordinary statement throw as commit-outcome-unknown and poisons future writes', async () => {
    const database = await openDatabase(':memory:', 'delete')
    insertV2Unit(database, DESCRIPTOR)
    const failure = new Error('injected statement completion failure')
    const backend = backendWithReadyDatabase(withStatementRunFault(database, /^INSERT INTO "u2_.*ON CONFLICT/, failure))
    const unit = await backend.kv.open(DESCRIPTOR)
    await expect(unit.putRecord('records', 'possibly-written', { n: 1 })).rejects.toMatchObject({
      code: 'commit-outcome-unknown',
      publicationPossible: true,
      cause: failure,
    })
    await expect(unit.deleteRecord('records', 'possibly-written')).rejects.toThrow(/writer.*indeterminate/i)
    await expect(backend.kv.open({ ...DESCRIPTOR, name: 'another' })).rejects.toThrow(/writer.*indeterminate/i)
    await expect(withReserved(backend, 'another', lease => lease.materializeMissing(
      { ...DESCRIPTOR, name: 'another' },
      { tables: { records: {} }, global: null },
    ))).rejects.toThrow(/writer.*indeterminate/i)
    await expect(unit.loadAll()).rejects.toThrow(/writer.*indeterminate/i)
    await expect(backend.close()).resolves.toBeUndefined()
  })

  it('keeps the ordinary writer usable after a rollback-proven initialization failure', async () => {
    const database = await openDatabase(':memory:', 'delete')
    const failure = new Error('injected initialization insert failure')
    const backend = backendWithReadyDatabase(withStatementRunFault(database, /^INSERT INTO units/, failure))
    await expect(backend.kv.open(DESCRIPTOR)).rejects.toBe(failure)
    const retry = await backend.kv.open(DESCRIPTOR)
    await expect(retry.loadAll()).resolves.toEqual({ tables: { records: {} }, global: null })
    await backend.close()
  })

  it('does not expose a poisoned in-memory writer through an uncertain readback token', async () => {
    const database = await openDatabase(':memory:', 'delete')
    const failure = new Error('injected in-memory post-commit failure')
    const backend = backendWithReadyDatabase(withCommitFault(database, 'committed', failure))
    try {
      await withReserved(backend, DESCRIPTOR.name, async (lease) => {
        const materialization = await lease.materializeMissing(DESCRIPTOR, {
          tables: { records: {} },
          global: null,
        })
        expect(materialization.outcome).toBe('uncertain')
        await expect(materialization.readBack()).rejects.toThrow(/writer.*indeterminate/i)
      })
    } finally {
      await backend.close()
    }
  })

  it('normalizes reservation failures and preserves callback/release evidence', async () => {
    const unavailable = new SqliteClosedUnitOperations(
      () => { throw 'reservation unavailable' },
      async () => ({ database: undefined, version: undefined, release: () => {} }),
      async () => ({ database: undefined, version: undefined, release: () => {} }),
      () => {},
    )
    await expect(unavailable.withReservedUnit(
      DESCRIPTOR.name,
      new AbortController().signal,
      async () => undefined,
    )).rejects.toEqual(new Error('reservation unavailable'))

    const primary = new Error('callback failed')
    const releaseFailure = new Error('reservation release failed')
    const closed = new SqliteClosedUnitOperations(
      () => () => { throw releaseFailure },
      async () => ({ database: undefined, version: undefined, release: () => {} }),
      async () => ({ database: undefined, version: undefined, release: () => {} }),
      () => {},
    )
    const aggregate = await closed.withReservedUnit(
      DESCRIPTOR.name,
      new AbortController().signal,
      async () => { throw primary },
    ).catch((error: unknown) => error)
    expect(aggregate).toBeInstanceOf(AggregateError)
    expect((aggregate as AggregateError).errors).toEqual([primary, releaseFailure])
    await expect(closed.withReservedUnit(
      DESCRIPTOR.name,
      new AbortController().signal,
      async () => undefined,
    )).rejects.toBe(releaseFailure)
  })

  it.each([
    ['a missing database', undefined, STORAGE_SQLITE_SCHEMA_VERSION],
    ['a non-current database', new DatabaseSync(':memory:'), 1],
  ] as const)('rejects %s from writable closed-unit acquisition', async (_label, database, version) => {
    const closed = new SqliteClosedUnitOperations(
      () => () => {},
      async () => ({ database: undefined, version: undefined, release: () => {} }),
      async () => ({ database, version, release: () => {} }),
      () => {},
    )
    try {
      await expect(closed.withReservedUnit(
        DESCRIPTOR.name,
        new AbortController().signal,
        lease => lease.materializeMissing(DESCRIPTOR, { tables: { records: {} }, global: null }),
      )).rejects.toMatchObject({ code: 'version-mismatch' })
    } finally {
      database?.close()
    }
  })

  it('preserves materialization and read failures when access cleanup also fails', async () => {
    const database = await openDatabase(':memory:', 'delete')
    const materializationFailure = new Error('materialization release failed')
    const readFailure = new Error('read release failed')
    const closed = new SqliteClosedUnitOperations(
      () => () => {},
      async () => ({
        database,
        version: STORAGE_SQLITE_SCHEMA_VERSION,
        release: () => { throw readFailure },
      }),
      async () => ({
        database: undefined,
        version: undefined,
        release: () => { throw materializationFailure },
      }),
      () => {},
    )
    try {
      const materialization = await closed.withReservedUnit(
        DESCRIPTOR.name,
        new AbortController().signal,
        lease => lease.materializeMissing(DESCRIPTOR, { tables: { records: {} }, global: null }),
      ).catch((error: unknown) => error)
      expect(materialization).toBeInstanceOf(AggregateError)
      expect((materialization as AggregateError).errors).toMatchObject([
        { code: 'version-mismatch' },
        materializationFailure,
      ])

      const read = await closed.withReservedUnit(
        DESCRIPTOR.name,
        new AbortController().signal,
        lease => lease.read(DESCRIPTOR),
      ).catch((error: unknown) => error)
      expect(read).toBeInstanceOf(AggregateError)
      expect((read as AggregateError).errors).toMatchObject([
        { code: 'unit-not-found' },
        readFailure,
      ])
    } finally {
      database.close()
    }
  })

  it('reports access cleanup failure after successful materialization and inspection', async () => {
    const database = await openDatabase(':memory:', 'delete')
    const writeReleaseFailure = new Error('write release failed')
    const readReleaseFailure = new Error('read release failed')
    const closed = new SqliteClosedUnitOperations(
      () => () => {},
      async () => ({ database: undefined, version: undefined, release: () => { throw readReleaseFailure } }),
      async () => ({
        database,
        version: STORAGE_SQLITE_SCHEMA_VERSION,
        release: () => { throw writeReleaseFailure },
      }),
      () => {},
    )
    try {
      await expect(closed.withReservedUnit(
        DESCRIPTOR.name,
        new AbortController().signal,
        lease => lease.materializeMissing(DESCRIPTOR, { tables: { records: {} }, global: null }),
      )).rejects.toBe(writeReleaseFailure)
      await expect(closed.withReservedUnit(
        'missing',
        new AbortController().signal,
        lease => lease.inspect(),
      )).rejects.toBe(readReleaseFailure)
    } finally {
      database.close()
    }
  })

  it.each(['unit_tables', 'unit_globals'] as const)(
    'treats an orphan %s row as occupied create-only state',
    async (metadataTable) => {
      const database = await openDatabase(':memory:', 'delete')
      database.exec('PRAGMA foreign_keys = OFF')
      if (metadataTable === 'unit_tables') {
        database.prepare('INSERT INTO unit_tables (unit, table_name) VALUES (?, ?)')
          .run(DESCRIPTOR.name, 'records')
      } else {
        database.prepare('INSERT INTO unit_globals (unit, value) VALUES (?, ?)')
          .run(DESCRIPTOR.name, '{}')
      }
      try {
        expect(() => materializeV2(
          database,
          DESCRIPTOR,
          { tables: { records: {} }, global: null },
          new AbortController().signal,
        )).toThrow(expect.objectContaining({ code: 'target-exists' }))
      } finally {
        database.close()
      }
    },
  )

  it('poisons when a pre-commit failure leaves no inspectable transaction state', async () => {
    const database = await openDatabase(':memory:', 'delete')
    const insertFailure = new Error('injected insert failure')
    const stateFailure = new Error('transaction state unavailable')
    const faulted = withTransactionStateFault(withStatementRunFault(
      database,
      /^INSERT INTO units/,
      insertFailure,
    ), stateFailure)
    try {
      const error = (() => {
        try {
          materializeV2(
            faulted,
            DESCRIPTOR,
            { tables: { records: {} }, global: null },
            new AbortController().signal,
          )
        } catch (failure) {
          return failure
        }
      })()
      expect(error).toMatchObject({ name: 'SqliteWriterPoisoningError' })
      expect((error as AggregateError).errors).toEqual([insertFailure, stateFailure])
    } finally {
      database.close()
    }
  })

  it('poisons when a pre-commit failure has already ended the transaction', async () => {
    const database = await openDatabase(':memory:', 'delete')
    const insertFailure = new Error('injected insert failure')
    const faulted = withStatementRunFault(
      database,
      /^INSERT INTO units/,
      insertFailure,
      (active) => { active.exec('ROLLBACK') },
    )
    try {
      const error = (() => {
        try {
          materializeV2(
            faulted,
            DESCRIPTOR,
            { tables: { records: {} }, global: null },
            new AbortController().signal,
          )
        } catch (failure) {
          return failure
        }
      })()
      expect(error).toMatchObject({ name: 'SqliteWriterPoisoningError' })
      expect((error as AggregateError).errors).toEqual([insertFailure])
    } finally {
      database.close()
    }
  })

  it('poisons when rollback after a pre-commit failure also fails', async () => {
    const database = await openDatabase(':memory:', 'delete')
    const insertFailure = new Error('injected insert failure')
    const rollbackFailure = new Error('injected rollback failure')
    const rollbackFault = withCommitFault(
      database,
      'active',
      new Error('unused commit failure'),
      rollbackFailure,
    )
    const faulted = withStatementRunFault(
      rollbackFault,
      /^INSERT INTO units/,
      insertFailure,
    )
    try {
      const error = (() => {
        try {
          materializeV2(
            faulted,
            DESCRIPTOR,
            { tables: { records: {} }, global: null },
            new AbortController().signal,
          )
        } catch (failure) {
          return failure
        }
      })()
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors).toEqual([insertFailure, rollbackFailure])
    } finally {
      database.close()
    }
  })

  it('returns uncertain when COMMIT state inspection fails', async () => {
    const database = await openDatabase(':memory:', 'delete')
    const commitFailure = new Error('injected commit failure')
    const stateFailure = new Error('transaction state unavailable')
    const faulted = withTransactionStateFault(
      withCommitFault(database, 'committed', commitFailure),
      stateFailure,
    )
    try {
      const result = materializeV2(
        faulted,
        DESCRIPTOR,
        { tables: { records: {} }, global: null },
        new AbortController().signal,
      )
      if (result.outcome !== 'uncertain') throw new Error('expected uncertain materialization')
      expect(result.cause).toBeInstanceOf(AggregateError)
      if (!(result.cause instanceof AggregateError)) throw new Error('expected aggregate uncertainty cause')
      expect(result.cause.errors).toEqual([commitFailure, stateFailure])
    } finally {
      database.close()
    }
  })

  it('normalizes an inactive non-Error BEGIN failure', async () => {
    const database = await openDatabase(':memory:', 'delete')
    try {
      expect(() => materializeV2(
        withInactiveBeginFault(database, 'injected begin failure'),
        DESCRIPTOR,
        { tables: { records: {} }, global: null },
        new AbortController().signal,
      )).toThrow(new Error('injected begin failure'))
    } finally {
      database.close()
    }
  })

  it('poisons when BEGIN state inspection or its rollback fails', async () => {
    const stateDatabase = await openDatabase(':memory:', 'delete')
    const beginFailure = new Error('injected active begin failure')
    const stateFailure = new Error('injected state failure')
    const stateFault = withTransactionStateFault(
      withActiveBeginFault(stateDatabase, beginFailure),
      stateFailure,
    )
    try {
      const error = (() => {
        try {
          materializeV2(
            stateFault,
            DESCRIPTOR,
            { tables: { records: {} }, global: null },
            new AbortController().signal,
          )
        } catch (failure) {
          return failure
        }
      })()
      expect(error).toMatchObject({ name: 'SqliteWriterPoisoningError' })
      expect((error as AggregateError).errors).toEqual([beginFailure, stateFailure])
    } finally {
      stateDatabase.close()
    }

    const rollbackDatabase = await openDatabase(':memory:', 'delete')
    const rollbackBeginFailure = new Error('injected active begin failure')
    const rollbackFailure = new Error('injected begin rollback failure')
    const rollbackFault = withActiveBeginFault(
      withCommitFault(
        rollbackDatabase,
        'active',
        new Error('unused commit failure'),
        rollbackFailure,
      ),
      rollbackBeginFailure,
    )
    try {
      const error = (() => {
        try {
          materializeV2(
            rollbackFault,
            DESCRIPTOR,
            { tables: { records: {} }, global: null },
            new AbortController().signal,
          )
        } catch (failure) {
          return failure
        }
      })()
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors).toEqual([rollbackBeginFailure, rollbackFailure])
    } finally {
      rollbackDatabase.close()
    }
  })

  it.each(['-wal', '-shm', '-journal'])('rejects empty and nonempty orphan %s sidecars', async (suffix) => {
    for (const content of [Buffer.alloc(0), Buffer.from('orphan-sidecar')]) {
      const path = await freshDbPath()
      await writeFile(`${path}${suffix}`, content)
      await expectOrphanSidecarRejected(path)
    }
  })

  it('rejects symlink and nonregular orphan sidecars', async () => {
    const linkedPath = await freshDbPath()
    const target = join(dirname(linkedPath), 'sidecar-target')
    await writeFile(target, 'owned elsewhere')
    await symlink(target, `${linkedPath}-wal`, 'file')
    await expectOrphanSidecarRejected(linkedPath)

    const nonregularPath = await freshDbPath()
    await mkdir(`${nonregularPath}-journal`)
    await expectOrphanSidecarRejected(nonregularPath)
  })

  it('anchors relative paths when constructed for ordinary and closed access', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-storage-sqlite-relative-'))
    dirs.push(root)
    const ownerDirectory = join(root, 'owner')
    const laterDirectory = join(root, 'later')
    await mkdir(ownerDirectory)
    await mkdir(laterDirectory)
    const originalDirectory = process.cwd()
    let seed: SqliteStorageBackend | undefined
    let ordinary: SqliteStorageBackend | undefined
    let closed: SqliteStorageBackend | undefined
    try {
      process.chdir(ownerDirectory)
      seed = backendAt('closed.db', 'delete')
      const seededUnit = await seed.kv.open(DESCRIPTOR)
      await seededUnit.putRecord('records', 'anchored', { source: 'owner' })
      await seededUnit.close()
      await seed.close()

      ordinary = backendAt('ordinary.db', 'delete')
      closed = backendAt('closed.db', 'delete')
      process.chdir(laterDirectory)

      const ordinaryUnit = await ordinary.kv.open(DESCRIPTOR)
      await ordinaryUnit.putRecord('records', 'created', { source: 'owner' })
      await ordinaryUnit.close()
      await expect(withReserved(closed, DESCRIPTOR.name, lease => lease.read(DESCRIPTOR))).resolves.toEqual({
        tables: { records: { anchored: { source: 'owner' } } },
        global: null,
      })

      expect((await stat(join(ownerDirectory, 'ordinary.db'))).size).toBeGreaterThan(0)
      await expect(readdir(laterDirectory)).resolves.toEqual([])
    } finally {
      process.chdir(originalDirectory)
      await Promise.allSettled([seed?.close(), ordinary?.close(), closed?.close()])
    }
  })

  it('constructs and reads an existing closed unit without changing its database or sidecars', async () => {
    const path = await freshDbPath()
    const setup = new DatabaseSync(path)
    createV2Schema(setup)
    insertV2Unit(setup, DESCRIPTOR)
    setup.prepare('INSERT INTO unit_globals (unit, value) VALUES (?, ?)')
      .run(DESCRIPTOR.name, JSON.stringify({ g: 2 }))
    setup.prepare(`INSERT INTO "${recordTableName(DESCRIPTOR.name, 'records')}" (key, value) VALUES (?, ?)`)
      .run(encodeRecordKey('k'), JSON.stringify({ n: 1 }))
    setup.close()
    const beforeFiles = await readdir(dirname(path))
    const beforeDatabase = await readFile(path)

    const backend = backendAt(path)
    expect(await readFile(path)).toEqual(beforeDatabase)
    expect(await readdir(dirname(path))).toEqual(beforeFiles)
    await withReserved(backend, DESCRIPTOR.name, async (lease) => {
      await expect(lease.inspect()).resolves.toEqual({
        name: DESCRIPTOR.name,
        version: DESCRIPTOR.version,
        hasGlobal: true,
        tables: ['records'],
      })
      await expect(lease.read(DESCRIPTOR)).resolves.toEqual({
        tables: { records: { k: { n: 1 } } },
        global: { g: 2 },
      })
    })
    await backend.close()
    expect(await readFile(path)).toEqual(beforeDatabase)
    expect(await readdir(dirname(path))).toEqual(beforeFiles)
  })

  it('reads committed uncheckpointed WAL data without changing the source files', async () => {
    const path = await freshDbPath()
    const writer = new DatabaseSync(path)
    let madeReadonly = false
    try {
      writer.prepare('PRAGMA journal_mode = WAL').get()
      writer.exec(`
        PRAGMA wal_autocheckpoint = 0;
      `)
      createV2Schema(writer)
      insertV2Unit(writer, DESCRIPTOR)
      writer.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
      writer.prepare(`INSERT INTO "${recordTableName(DESCRIPTOR.name, 'records')}" (key, value) VALUES (?, ?)`)
        .run(encodeRecordKey('wal-record'), JSON.stringify({ committed: true }))
      writer.prepare('INSERT INTO unit_globals (unit, value) VALUES (?, ?)')
        .run(DESCRIPTOR.name, JSON.stringify({ from: 'wal' }))

      const sourcePaths = [path, `${path}-wal`, `${path}-shm`]
      if (process.platform !== 'win32') {
        await Promise.all(sourcePaths.map(source => chmod(source, 0o444)))
        madeReadonly = true
      }
      const before = await Promise.all(sourcePaths.map(source => readFile(source)))
      const beforeModes = await Promise.all(sourcePaths.map(async source => (await stat(source)).mode))
      const backend = backendAt(path)
      await withReserved(backend, DESCRIPTOR.name, async (lease) => {
        await expect(lease.read(DESCRIPTOR)).resolves.toEqual({
          tables: { records: { 'wal-record': { committed: true } } },
          global: { from: 'wal' },
        })
      })
      await backend.close()
      const after = await Promise.all(sourcePaths.map(source => readFile(source)))
      expect(after).toEqual(before)
      await expect(Promise.all(sourcePaths.map(async source => (await stat(source)).mode))).resolves.toEqual(beforeModes)
    } finally {
      if (madeReadonly) {
        await Promise.all([path, `${path}-wal`, `${path}-shm`].map(source => chmod(source, 0o600)))
      }
      writer.close()
    }
  })

  it('recovers a hot rollback journal only in the frozen copy without changing the source files', {
    timeout: 30_000,
  }, async () => {
    const path = await freshDbPath()
    const descriptor = { ...DESCRIPTOR, hasGlobal: false }
    const physicalTable = recordTableName(descriptor.name, 'records')
    const backend = backendAt(path, 'delete')
    await (await backend.kv.open(descriptor)).close()
    await backend.close()

    const setup = new DatabaseSync(path)
    setup.exec('PRAGMA journal_mode = DELETE; BEGIN IMMEDIATE')
    const insert = setup.prepare(`INSERT INTO "${physicalTable}" (key, value) VALUES (?, ?)`)
    const oldValue = JSON.stringify(`old-${'a'.repeat(3_900)}`)
    for (let index = 0; index < 64; index++) {
      insert.run(encodeRecordKey(`k-${String(index).padStart(4, '0')}`), oldValue)
    }
    setup.exec('COMMIT')
    setup.close()

    const newValue = JSON.stringify(`new-${'b'.repeat(3_900)}`)
    await leaveHotRollbackJournal(path, physicalTable, newValue)
    expect((await stat(`${path}-journal`)).size).toBeGreaterThan(0)

    // Prove that the crash spilled uncommitted pages into the main file and
    // that SQLite needs the hot journal to recover the last committed value.
    const unrecoveredPath = await freshDbPath()
    await copyFile(path, unrecoveredPath)
    const unrecovered = new DatabaseSync(unrecoveredPath)
    expect(JSON.parse((unrecovered.prepare(`SELECT value FROM "${physicalTable}" ORDER BY key LIMIT 1`).get() as {
      value: string
    }).value) as string).toMatch(/^new-/)
    unrecovered.close()
    const recoveredPath = await freshDbPath()
    await copyFile(path, recoveredPath)
    await copyFile(`${path}-journal`, `${recoveredPath}-journal`)
    const recovered = new DatabaseSync(recoveredPath)
    expect(JSON.parse((recovered.prepare(`SELECT value FROM "${physicalTable}" ORDER BY key LIMIT 1`).get() as {
      value: string
    }).value) as string).toMatch(/^old-/)
    recovered.close()

    const sourceDirectory = dirname(path)
    await Promise.all([path, `${path}-journal`].map(source => chmod(source, 0o444)))
    const before = await snapshotDirectory(sourceDirectory)
    expect(before
      .filter(entry => entry.name === 'storage.db' || entry.name === 'storage.db-journal')
      .every(entry => (entry.mode & 0o222) === 0)).toBe(true)
    const reader = backendAt(path, 'delete')
    const snapshot = await withReserved(reader, descriptor.name, lease => lease.read(descriptor))
    expect(snapshot.tables.records?.['k-0000']).toMatch(/^old-/)
    await reader.close()
    expect(await snapshotDirectory(sourceDirectory)).toEqual(before)
  })

  it('opens a frozen copy with a nonhot persistent rollback journal without changing the source files', async () => {
    const path = await freshDbPath()
    const writer = backendAt(path, 'persist')
    const unit = await writer.kv.open(DESCRIPTOR)
    await unit.putRecord('records', 'persisted', { committed: true })
    await unit.close()
    await writer.close()
    expect((await stat(`${path}-journal`)).size).toBeGreaterThan(0)

    const sourceDirectory = dirname(path)
    const beforeFiles = (await readdir(sourceDirectory)).sort()
    const before = await Promise.all(beforeFiles.map(file => readFile(join(sourceDirectory, file))))
    const reader = backendAt(path, 'persist')
    await expect(withReserved(reader, DESCRIPTOR.name, lease => lease.read(DESCRIPTOR))).resolves.toEqual({
      tables: { records: { persisted: { committed: true } } },
      global: null,
    })
    await reader.close()
    expect((await readdir(sourceDirectory)).sort()).toEqual(beforeFiles)
    expect(await Promise.all(beforeFiles.map(file => readFile(join(sourceDirectory, file))))).toEqual(before)
  })

  it('freezes a warm backend WAL without changing its source files', async () => {
    const path = await freshDbPath()
    const backend = backendAt(path)
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.putRecord('records', 'warm', { committed: true })
    await unit.setGlobal({ from: 'warm-wal' })
    await unit.close()

    const sourcePaths = [path, `${path}-wal`, `${path}-shm`]
    const beforeFiles = await readdir(dirname(path))
    const before = await Promise.all(sourcePaths.map(source => readFile(source)))
    await expect(withReserved(backend, DESCRIPTOR.name, lease => lease.read(DESCRIPTOR))).resolves.toEqual({
      tables: { records: { warm: { committed: true } } },
      global: { from: 'warm-wal' },
    })
    expect(await Promise.all(sourcePaths.map(source => readFile(source)))).toEqual(before)
    expect(await readdir(dirname(path))).toEqual(beforeFiles)
    await backend.close()
  })

  it('rejects a foreign physical version through the read-only path without changing it', async () => {
    const path = await freshDbPath()
    const setup = new DatabaseSync(path)
    setup.exec('PRAGMA user_version = 999')
    setup.close()
    const beforeDatabase = await readFile(path)
    const beforeFiles = await readdir(dirname(path))

    const backend = backendAt(path)
    await expect(withReserved(backend, DESCRIPTOR.name, lease => lease.inspect()))
      .rejects.toMatchObject({ code: 'version-mismatch' })
    await backend.close()
    expect(await readFile(path)).toEqual(beforeDatabase)
    expect(await readdir(dirname(path))).toEqual(beforeFiles)
  })

  it('rejects missing physical metadata through the read-only path without repairing it', async () => {
    const path = await freshDbPath()
    const setup = new DatabaseSync(path)
    setup.exec(`
      PRAGMA user_version = ${STORAGE_SQLITE_SCHEMA_VERSION};
      CREATE TABLE unrelated (value TEXT) STRICT;
    `)
    setup.close()
    const beforeDatabase = await readFile(path)
    const beforeFiles = await readdir(dirname(path))

    const backend = backendAt(path)
    await expect(withReserved(backend, DESCRIPTOR.name, lease => lease.inspect()))
      .rejects.toMatchObject({ code: 'malformed-medium' })
    await backend.close()
    expect(await readFile(path)).toEqual(beforeDatabase)
    expect(await readdir(dirname(path))).toEqual(beforeFiles)
  })

  it('rejects physical-v2 metadata DDL that omits an owned constraint', async () => {
    const path = await freshDbPath()
    const setup = new DatabaseSync(path)
    setup.exec(`
      CREATE TABLE units (
        name TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        has_global INTEGER NOT NULL CHECK (has_global IN (0, 1))
      ) STRICT;
      CREATE TABLE unit_tables (
        unit TEXT NOT NULL REFERENCES units(name),
        table_name TEXT NOT NULL,
        PRIMARY KEY (unit, table_name)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE unit_globals (
        unit TEXT PRIMARY KEY REFERENCES units(name),
        value TEXT NOT NULL
      ) STRICT;
      PRAGMA user_version = ${STORAGE_SQLITE_SCHEMA_VERSION};
    `)
    setup.close()

    const backend = backendAt(path)
    await expect(backend.kv.open(DESCRIPTOR)).rejects.toMatchObject({ code: 'malformed-medium' })
    await backend.close()
  })

  describe.each([
    ['a NUL suffix', Buffer.alloc(0), Buffer.from([0x00, ...Buffer.from('ignored')])],
    ['a byte-order mark', Buffer.from([0xef, 0xbb, 0xbf]), Buffer.alloc(0)],
    ['an invalid UTF-8 tail', Buffer.alloc(0), Buffer.from([0x80])],
  ] as const)('raw schema SQL with %s', (_label, prefix, suffix) => {
    it.each([
      ['current', 'ordinary'],
      ['current', 'closed'],
      ['legacy', 'closed'],
    ] as const)('rejects the %s layout through the %s reader without changing its source', async (
      layout,
      reader,
    ) => {
      const path = await freshDbPath()
      createStoredRawValue(path, layout, DESCRIPTOR, '{}')
      rewriteRawSchemaSql(path, 'units', prefix, suffix)
      const directory = dirname(path)
      const before = await snapshotDirectory(directory)

      const backend = backendAt(path, 'persist')
      try {
        const operation = reader === 'ordinary'
          ? backend.kv.open(DESCRIPTOR)
          : withReserved(backend, DESCRIPTOR.name, lease => lease.inspect())
        await expect(operation).rejects.toMatchObject({ code: 'malformed-medium' })
      } finally {
        await backend.close()
      }
      expect(await snapshotDirectory(directory)).toEqual(before)
    })
  })

  it.each(['type', 'name', 'tbl_name'] as const)(
    'rejects invalid UTF-8 in sqlite_schema.%s instead of accepting lossy TEXT',
    (column) => {
      const db = new DatabaseSync(':memory:')
      try {
        db.exec('CREATE TABLE specimen (value TEXT) STRICT')
        replaceRawSchemaCell(db, 'specimen', column, Buffer.from([0x61, 0x80]))
        expect(() => listUserSchemaObjects(db)).toThrow(/valid UTF-8/)
      } finally {
        db.close()
      }
    },
  )

  it('does not hide a coordinated NUL-suffixed autoindex identity', () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec('CREATE TABLE specimen (key TEXT PRIMARY KEY) STRICT')
      const autoindex = 'sqlite_autoindex_specimen_1'
      const owner = 'specimen\0evil'
      replaceRawSchemaCell(db, autoindex, 'tbl_name', Buffer.from(owner))
      replaceRawSchemaCell(db, autoindex, 'name', Buffer.from(`sqlite_autoindex_${owner}_1`))
      expect(listUserSchemaObjects(db)).toContainEqual({
        type: 'index',
        name: `sqlite_autoindex_${owner}_1`,
        owner,
      })
    } finally {
      db.close()
    }
  })

  it.each(['ordinary', 'closed'] as const)(
    'rejects a writable-schema sqlite_evil table through the %s reader without changing its source',
    async (reader) => {
      const path = await freshDbPath()
      createStoredRawValue(path, 'current', DESCRIPTOR, '{}')
      const setup = new DatabaseSync(path)
      try {
        setDefensive(setup, false)
        setup.exec('PRAGMA writable_schema = ON')
        setup.prepare(`
          INSERT INTO sqlite_schema (type, name, tbl_name, rootpage, sql)
          VALUES ('table', 'sqlite_evil', 'sqlite_evil', 0, 'CREATE TABLE sqlite_evil (value TEXT) STRICT')
        `).run()
      } finally {
        setup.exec('PRAGMA writable_schema = OFF')
        setDefensive(setup, true)
        setup.close()
      }
      const directory = dirname(path)
      const before = await snapshotDirectory(directory)

      const backend = backendAt(path, 'persist')
      try {
        const operation = reader === 'ordinary'
          ? backend.kv.open(DESCRIPTOR)
          : withReserved(backend, DESCRIPTOR.name, lease => lease.inspect())
        await expect(operation).rejects.toMatchObject({ code: 'malformed-medium' })
      } finally {
        await backend.close()
      }
      expect(await snapshotDirectory(directory)).toEqual(before)
    },
  )

  it.each(['ordinary', 'closed'] as const)(
    'rejects a NUL-suffixed SQLite autoindex through the %s reader without changing its source',
    async (reader) => {
      const path = await freshDbPath()
      createStoredRawValue(path, 'current', DESCRIPTOR, '{}')
      const autoindex = 'sqlite_autoindex_unit_globals_1'
      const setup = new DatabaseSync(path)
      try {
        replaceRawSchemaCell(
          setup,
          autoindex,
          'name',
          Buffer.concat([Buffer.from(autoindex), Buffer.from([0x00]), Buffer.from('evil')]),
        )
      } finally {
        setup.close()
      }
      const directory = dirname(path)
      const before = await snapshotDirectory(directory)

      const backend = backendAt(path, 'persist')
      try {
        const operation = reader === 'ordinary'
          ? backend.kv.open(DESCRIPTOR)
          : withReserved(backend, DESCRIPTOR.name, lease => lease.inspect())
        await expect(operation).rejects.toMatchObject({ code: 'malformed-medium' })
      } finally {
        await backend.close()
      }
      expect(await snapshotDirectory(directory)).toEqual(before)
    },
  )

  describe.each([
    ['an extra schema object', (db: DatabaseSync) => {
      db.exec('CREATE TABLE foreign_table (value TEXT) STRICT')
    }],
    ['an incompatible declared record table', (db: DatabaseSync) => {
      const physical = recordTableName(DESCRIPTOR.name, 'records')
      db.exec(`
        DROP TABLE "${physical}";
        CREATE TABLE "${physical}" (
          key TEXT PRIMARY KEY,
          payload TEXT NOT NULL
        ) STRICT;
      `)
    }],
  ] as const)('DELETE-to-WAL preflight with %s', (_label, corrupt) => {
    it.each(['ordinary', 'closed'] as const)(
      'rejects through the %s reader without changing database bytes or directory inventory',
      async (reader) => {
        const path = await freshDbPath()
        const seed = backendAt(path, 'delete')
        const unit = await seed.kv.open(DESCRIPTOR)
        await unit.close()
        await seed.close()

        const setup = new DatabaseSync(path)
        try {
          corrupt(setup)
        } finally {
          setup.close()
        }
        const directory = dirname(path)
        const beforeDatabase = await readFile(path)
        const beforeDirectory = await snapshotDirectory(directory)
        expect(beforeDatabase.subarray(18, 20)).toEqual(Buffer.from([1, 1]))

        const backend = backendAt(path)
        try {
          const operation = reader === 'ordinary'
            ? backend.kv.open(DESCRIPTOR)
            : withReserved(backend, DESCRIPTOR.name, lease => lease.inspect())
          await expect(operation).rejects.toMatchObject({ code: 'malformed-medium' })
        } finally {
          await backend.close()
        }
        expect(await readFile(path)).toEqual(beforeDatabase)
        expect(await snapshotDirectory(directory)).toEqual(beforeDirectory)
      },
    )
  })

  it('classifies an unreadable SQLite file as a malformed medium without changing it', async () => {
    const path = await freshDbPath()
    await writeFile(path, Buffer.from('not a sqlite database'))
    const before = await readFile(path)

    const backend = backendAt(path)
    await expect(withReserved(backend, DESCRIPTOR.name, lease => lease.inspect()))
      .rejects.toMatchObject({ name: 'StorageError', code: 'malformed-medium' })
    await backend.close()
    expect(await readFile(path)).toEqual(before)
  })

  it('rejects an unowned physical record table without changing the database medium', async () => {
    const path = await freshDbPath()
    const backend = backendAt(path, 'delete')
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.putRecord('records', 'k', { n: 1 })
    await unit.close()

    const db = new DatabaseSync(path)
    db.exec(`CREATE TABLE "${recordTableName(DESCRIPTOR.name, 'extra')}" (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT`)
    db.close()
    const beforeFiles = await readdir(join(path, '..'))
    const beforeDatabase = await readFile(path)

    await expect(withReserved(backend, DESCRIPTOR.name, lease => lease.inspect()))
      .rejects.toMatchObject({ code: 'malformed-medium' })
    expect(await readFile(path)).toEqual(beforeDatabase)
    expect(await readdir(join(path, '..'))).toEqual(beforeFiles)
    await backend.close()
  })

  it('rejects a physical-v2 object whose name only resembles the sqlite_ reserved prefix', async () => {
    const path = await freshDbPath()
    const setup = new DatabaseSync(path)
    createV2Schema(setup)
    insertV2Unit(setup, DESCRIPTOR)
    setup.exec('CREATE TABLE sqliteXforeign (value TEXT) STRICT')
    setup.close()

    const backend = backendAt(path)
    await expect(withReserved(backend, DESCRIPTOR.name, lease => lease.inspect()))
      .rejects.toMatchObject({ code: 'malformed-medium' })
    await backend.close()
  })

  it('rejects a declared record table with an incompatible physical schema', async () => {
    const path = await freshDbPath()
    const setup = new DatabaseSync(path)
    createV2Schema(setup)
    setup.prepare('INSERT INTO units (name, version, has_global) VALUES (?, ?, ?)')
      .run(DESCRIPTOR.name, DESCRIPTOR.version, 1)
    setup.prepare('INSERT INTO unit_tables (unit, table_name) VALUES (?, ?)')
      .run(DESCRIPTOR.name, 'records')
    setup.exec(`CREATE TABLE "${recordTableName(DESCRIPTOR.name, 'records')}" (
      key TEXT PRIMARY KEY,
      payload TEXT NOT NULL
    ) STRICT`)
    setup.close()

    const backend = backendAt(path)
    await expect(withReserved(backend, DESCRIPTOR.name, lease => lease.inspect()))
      .rejects.toMatchObject({ code: 'malformed-medium' })
    await backend.close()
  })

  it('rejects a physical-v2 record table whose primary-key collation changes key identity', async () => {
    const path = await freshDbPath()
    const setup = new DatabaseSync(path)
    createV2Schema(setup)
    setup.prepare('INSERT INTO units (name, version, has_global) VALUES (?, ?, ?)')
      .run(DESCRIPTOR.name, DESCRIPTOR.version, 1)
    setup.prepare('INSERT INTO unit_tables (unit, table_name) VALUES (?, ?)')
      .run(DESCRIPTOR.name, 'records')
    setup.exec(`CREATE TABLE "${recordTableName(DESCRIPTOR.name, 'records')}" (
      key TEXT PRIMARY KEY COLLATE NOCASE,
      value TEXT NOT NULL
    ) STRICT`)
    setup.close()

    const backend = backendAt(path)
    await expect(backend.kv.open(DESCRIPTOR)).rejects.toMatchObject({ code: 'malformed-medium' })
    await backend.close()
  })

  it.each([
    ['undefined', { lost: undefined }],
    ['a non-finite number', { value: Number.POSITIVE_INFINITY }],
    ['a sparse array', { value: Array(1) }],
    ['an exotic object', { value: new Date(0) }],
  ])('rejects %s through ordinary and closed writes', async (_label, value) => {
    const backend = backendAt(':memory:')
    const unit = await backend.kv.open(DESCRIPTOR)
    await expect(unit.putRecord('records', 'lossy', value)).rejects.toThrow(TypeError)
    await expect(unit.loadAll()).resolves.toEqual({ tables: { records: {} }, global: null })
    await unit.close()

    const closedDescriptor = { ...DESCRIPTOR, name: 'closed_lossless' }
    await withReserved(backend, closedDescriptor.name, async (lease) => {
      await expect(lease.materializeMissing(closedDescriptor, {
        tables: { records: { lossy: value } },
        global: null,
      })).rejects.toMatchObject({ code: 'malformed-medium' })
      await expect(lease.inspect()).resolves.toBeUndefined()
    })
    await backend.close()
  })

  it('rejects lossy snapshot containers before opening a target database', async () => {
    const path = await freshDbPath()
    const directory = dirname(path)
    const before = await snapshotDirectory(directory)
    const backend = backendAt(path)
    const hiddenRecords: Record<string, unknown> = {}
    Object.defineProperty(hiddenRecords, 'hidden', {
      enumerable: false,
      value: { retained: true },
    })
    await expect(withReserved(backend, DESCRIPTOR.name, lease => lease.materializeMissing(DESCRIPTOR, {
      tables: { records: hiddenRecords },
      global: null,
    }))).rejects.toMatchObject({ code: 'malformed-medium' })

    let accessorRead = false
    const accessorRecords: Record<string, unknown> = {}
    Object.defineProperty(accessorRecords, 'computed', {
      enumerable: true,
      get: () => {
        accessorRead = true
        return { retained: true }
      },
    })
    await expect(withReserved(backend, DESCRIPTOR.name, lease => lease.materializeMissing(DESCRIPTOR, {
      tables: { records: accessorRecords },
      global: null,
    }))).rejects.toMatchObject({ code: 'malformed-medium' })
    expect(accessorRead).toBe(false)
    expect(await snapshotDirectory(directory)).toEqual(before)
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    await backend.close()
  })

  it('reads a detached snapshot without changing the database medium', async () => {
    const path = await freshDbPath()
    const backend = backendAt(path, 'delete')
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.putRecord('records', 'k', { n: 1 })
    await unit.setGlobal({ g: 2 })
    await unit.close()
    const beforeFiles = await readdir(join(path, '..'))
    const beforeDatabase = await readFile(path)

    await expect(withReserved(backend, DESCRIPTOR.name, lease => lease.read(DESCRIPTOR))).resolves.toEqual({
      tables: { records: { k: { n: 1 } } },
      global: { g: 2 },
    })
    expect(await readFile(path)).toEqual(beforeDatabase)
    expect(await readdir(join(path, '..'))).toEqual(beforeFiles)
    await backend.close()
  })

  it('treats an orphan physical table as an occupied create-only target', async () => {
    const path = await freshDbPath()
    const backend = backendAt(path)
    const descriptor: KvUnitDescriptor = {
      name: 'atomic',
      version: 1,
      tables: ['first', 'obstructed'],
      hasGlobal: false,
    }
    const seed = await backend.kv.open({ name: 'seed', version: 1, tables: [], hasGlobal: false })
    await seed.close()
    const db = new DatabaseSync(path)
    db.exec(`CREATE TABLE "${recordTableName(descriptor.name, 'obstructed')}" (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT`)
    db.close()

    await expect(withReserved(backend, descriptor.name, async lease => await lease.materializeMissing(descriptor, {
      tables: { first: { a: 1 }, obstructed: { b: 2 } },
      global: null,
    }))).rejects.toMatchObject({ code: 'target-exists' })

    const inspection = new DatabaseSync(path)
    try {
      expect(inspection.prepare('SELECT name FROM sqlite_schema WHERE name = ?').get(
        recordTableName(descriptor.name, 'first'),
      ))
        .toBeUndefined()
      expect(inspection.prepare('SELECT name FROM sqlite_schema WHERE name = ?').get(
        recordTableName(descriptor.name, 'obstructed'),
      )).toEqual({ name: recordTableName(descriptor.name, 'obstructed') })
      expect(inspection.prepare('SELECT name FROM units WHERE name = ?').get(descriptor.name)).toBeUndefined()
    } finally {
      inspection.close()
    }
    await backend.close()
  })

  it('accepts only null global state for a descriptor without a global slot', async () => {
    const backend = backendAt(':memory:')
    const descriptor: KvUnitDescriptor = {
      name: 'without_global',
      version: 1,
      tables: ['records'],
      hasGlobal: false,
    }
    await expect(withReserved(backend, descriptor.name, async lease => await lease.materializeMissing(descriptor, {
      tables: { records: {} },
      global: { unexpected: true },
    }))).rejects.toMatchObject({ code: 'malformed-medium' })

    await withReserved(backend, descriptor.name, async (lease) => {
      await expect(lease.inspect()).resolves.toBeUndefined()
      const committed = await lease.materializeMissing(descriptor, {
        tables: { records: {} },
        global: null,
      })
      await expect(committed.readBack()).resolves.toEqual({ tables: { records: {} }, global: null })
    })
    await backend.close()
  })

  it('lets a committed token read back after a late reservation abort', async () => {
    const backend = backendAt(':memory:')
    const controller = new AbortController()
    await backend.kv.closed!.withReservedUnit(DESCRIPTOR.name, controller.signal, async (lease) => {
      const committed = await lease.materializeMissing(DESCRIPTOR, {
        tables: { records: { retained: true } },
        global: null,
      })
      controller.abort(new Error('too late to cancel the commit'))
      await expect(committed.readBack()).resolves.toEqual({
        tables: { records: { retained: true } },
        global: null,
      })
    })
    await backend.close()
  })

  it('rejects closed operations while an ordinary open is still pending', async () => {
    const path = await freshDbPath()
    const backend = backendAt(path)
    const opening = backend.kv.open(DESCRIPTOR)
    await expect(withReserved(backend, DESCRIPTOR.name, lease => lease.inspect()))
      .rejects.toMatchObject({ code: 'unit-open' })
    await (await opening).close()
    await backend.close()
  })

  it('reserves a closed unit against an ordinary open until the read settles', async () => {
    const path = await freshDbPath()
    const setup = backendAt(path)
    const unit = await setup.kv.open(DESCRIPTOR)
    await unit.close()
    await setup.close()

    const backend = backendAt(path)
    let continueRead!: () => void
    const hold = new Promise<void>((resolve) => { continueRead = resolve })
    const reading = withReserved(backend, DESCRIPTOR.name, async (lease) => {
      await hold
      return await lease.read(DESCRIPTOR)
    })
    await expect(backend.kv.open(DESCRIPTOR)).rejects.toMatchObject({ code: 'unit-open' })
    continueRead()
    await expect(reading).resolves.toEqual({ tables: { records: {} }, global: null })
    await backend.close()
  })

  it('expires a closed-unit lease when its callback settles', async () => {
    const backend = backendAt(':memory:')
    let escaped!: KvClosedUnitLease
    await withReserved(backend, DESCRIPTOR.name, async (lease) => {
      escaped = lease
      await expect(lease.inspect()).resolves.toBeUndefined()
    })

    await expect(escaped.inspect()).rejects.toMatchObject({ code: 'closed' })
    await expect(escaped.read(DESCRIPTOR)).rejects.toMatchObject({ code: 'closed' })
    await backend.close()
  })

  it('waits for an admitted closed-unit callback before closing', async () => {
    const backend = backendAt(':memory:')
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const admitted = new Promise<void>((resolve) => { entered = resolve })
    const running = withReserved(backend, DESCRIPTOR.name, async (lease) => {
      entered()
      await gate
      return await lease.inspect()
    })
    await admitted

    let closeSettled = false
    const closing = backend.close().then(() => { closeSettled = true })
    await Promise.resolve()
    expect(closeSettled).toBe(false)
    release()
    await expect(running).resolves.toBeUndefined()
    await closing
  })

  it('registers callback completion before a reentrant backend close', async () => {
    const backend = backendAt(':memory:')
    let closing!: Promise<void>
    await withReserved(backend, DESCRIPTOR.name, async () => {
      let closeSettled = false
      closing = backend.close().then(() => { closeSettled = true })
      await Promise.resolve()
      expect(closeSettled).toBe(false)
    })
    await closing
  })

  it('keeps underscore-bearing unit and table names physically independent', async () => {
    const backend = backendAt(':memory:')
    const first = await backend.kv.open({ name: 'a', version: 1, tables: ['b_c'], hasGlobal: false })
    await first.putRecord('b_c', 'first', 1)
    await first.close()
    const second = await backend.kv.open({ name: 'a_b', version: 1, tables: ['c'], hasGlobal: false })
    await expect(second.loadAll()).resolves.toEqual({ tables: { c: {} }, global: null })
    await second.putRecord('c', 'second', 2)
    await second.close()
    const reopenedFirst = await backend.kv.open({ name: 'a', version: 1, tables: ['b_c'], hasGlobal: false })
    await expect(reopenedFirst.loadAll()).resolves.toEqual({ tables: { b_c: { first: 1 } }, global: null })
    await backend.close()
  })

  it('rejects an exact-descriptor global capability mismatch', async () => {
    const backend = backendAt(':memory:')
    await withReserved(backend, DESCRIPTOR.name, async (lease) => {
      await lease.materializeMissing(DESCRIPTOR, { tables: { records: {} }, global: null })
    })
    await expect(withReserved(backend, DESCRIPTOR.name, lease => lease.read({
      ...DESCRIPTOR,
      hasGlobal: false,
    }))).rejects.toMatchObject({ code: 'malformed-medium' })
    await backend.close()
  })

  it('rejects an exact-descriptor table-set mismatch', async () => {
    const backend = backendAt(':memory:')
    await withReserved(backend, DESCRIPTOR.name, async (lease) => {
      await lease.materializeMissing(DESCRIPTOR, { tables: { records: {} }, global: null })
    })
    await expect(withReserved(backend, DESCRIPTOR.name, lease => lease.read({
      ...DESCRIPTOR,
      tables: ['other'],
    }))).rejects.toMatchObject({ code: 'malformed-medium' })
    await backend.close()
  })

  it('rejects missing and unsupported media through the exact closed reader', async () => {
    expect(() => readExistingDatabase(undefined, DESCRIPTOR)).toThrow(
      expect.objectContaining({ code: 'unit-not-found' }),
    )

    const current = await openDatabase(':memory:', 'delete')
    try {
      expect(() => readExistingDatabase(current, DESCRIPTOR)).toThrow(
        expect.objectContaining({ code: 'unit-not-found' }),
      )
    } finally {
      current.close()
    }

    const unsupported = new DatabaseSync(':memory:')
    unsupported.exec('PRAGMA user_version = 99')
    try {
      expect(() => readExistingDatabase(unsupported, DESCRIPTOR)).toThrow(
        expect.objectContaining({ code: 'version-mismatch' }),
      )
    } finally {
      unsupported.close()
    }
  })

  it('rejects a global descriptor for the legacy physical format', () => {
    const database = new DatabaseSync(':memory:')
    database.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE units (name TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT;
      CREATE TABLE unit_globals (unit TEXT PRIMARY KEY REFERENCES units(name), value TEXT NOT NULL) STRICT;
      CREATE TABLE "${legacyRecordTableName(DESCRIPTOR.name, 'records')}" (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
    `)
    database.prepare('INSERT INTO units (name, version) VALUES (?, ?)')
      .run(DESCRIPTOR.name, DESCRIPTOR.version)
    try {
      expect(() => readExistingDatabase(database, DESCRIPTOR)).toThrow(
        expect.objectContaining({ code: 'malformed-medium' }),
      )
    } finally {
      database.close()
    }
  })

  it('rejects legacy media without exactly one unit or with retained global data', () => {
    const empty = new DatabaseSync(':memory:')
    empty.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE units (name TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT;
      CREATE TABLE unit_globals (unit TEXT PRIMARY KEY REFERENCES units(name), value TEXT NOT NULL) STRICT;
    `)
    try {
      expect(() => inspectExistingDatabase(empty, DESCRIPTOR.name)).toThrow(
        expect.objectContaining({ code: 'malformed-medium' }),
      )
    } finally {
      empty.close()
    }

    const global = new DatabaseSync(':memory:')
    global.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE units (name TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT;
      CREATE TABLE unit_globals (unit TEXT PRIMARY KEY REFERENCES units(name), value TEXT NOT NULL) STRICT;
    `)
    global.prepare('INSERT INTO units (name, version) VALUES (?, ?)').run(DESCRIPTOR.name, DESCRIPTOR.version)
    global.prepare('INSERT INTO unit_globals (unit, value) VALUES (?, ?)').run(DESCRIPTOR.name, '{}')
    try {
      expect(() => inspectExistingDatabase(global, DESCRIPTOR.name)).toThrow(
        expect.objectContaining({ code: 'malformed-medium' }),
      )
    } finally {
      global.close()
    }
  })

  it('rejects an invalid legacy record name and reports a different valid unit as absent', () => {
    const invalid = new DatabaseSync(':memory:')
    invalid.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE units (name TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT;
      CREATE TABLE unit_globals (unit TEXT PRIMARY KEY REFERENCES units(name), value TEXT NOT NULL) STRICT;
      CREATE TABLE "u_${DESCRIPTOR.name}_Bad-Name" (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    `)
    invalid.prepare('INSERT INTO units (name, version) VALUES (?, ?)').run(DESCRIPTOR.name, DESCRIPTOR.version)
    try {
      expect(() => inspectExistingDatabase(invalid, DESCRIPTOR.name)).toThrow(
        expect.objectContaining({ code: 'malformed-medium' }),
      )
    } finally {
      invalid.close()
    }

    const valid = new DatabaseSync(':memory:')
    valid.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE units (name TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT;
      CREATE TABLE unit_globals (unit TEXT PRIMARY KEY REFERENCES units(name), value TEXT NOT NULL) STRICT;
      CREATE TABLE "${legacyRecordTableName(DESCRIPTOR.name, 'records')}" (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
    `)
    valid.prepare('INSERT INTO units (name, version) VALUES (?, ?)').run(DESCRIPTOR.name, DESCRIPTOR.version)
    try {
      expect(inspectExistingDatabase(valid, 'other')).toBeUndefined()
      expect(() => readExistingDatabase(valid, {
        ...DESCRIPTOR,
        name: 'other',
        hasGlobal: false,
      })).toThrow(expect.objectContaining({ code: 'unit-not-found' }))
    } finally {
      valid.close()
    }
  })

  it('rejects a reserved-name mismatch and snapshot table mismatch before write acquisition', async () => {
    const backend = backendAt(':memory:')
    await expect(withReserved(backend, DESCRIPTOR.name, lease => lease.read({
      ...DESCRIPTOR,
      name: 'other',
    }))).rejects.toThrow(/cannot operate on 'other'/)
    await expect(withReserved(backend, DESCRIPTOR.name, lease => lease.materializeMissing(DESCRIPTOR, {
      tables: { other: {} },
      global: null,
    }))).rejects.toMatchObject({ code: 'malformed-medium' })
    await backend.close()
  })

  it('rejects duplicate and invalid table names in descriptors', () => {
    expect(() => {
      validateDescriptor({
        ...DESCRIPTOR,
        tables: ['records', 'records'],
      })
    }).toThrow(/repeats a table name/)
    expect(() => {
      validateDescriptor({
        ...DESCRIPTOR,
        tables: ['Bad-Name'],
      })
    }).toThrow(/violates/)
  })

  it('reads the exact sole-unit legacy physical v1 format only while closed', async () => {
    const path = await freshDbPath()
    const legacyDescriptor = { ...DESCRIPTOR, hasGlobal: false }
    const setup = new DatabaseSync(path)
    setup.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE units (name TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT;
      CREATE TABLE unit_globals (unit TEXT PRIMARY KEY REFERENCES units(name), value TEXT NOT NULL) STRICT;
      CREATE TABLE "${legacyRecordTableName(legacyDescriptor.name, 'records')}" (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
    `)
    setup.prepare('INSERT INTO units (name, version) VALUES (?, ?)')
      .run(legacyDescriptor.name, legacyDescriptor.version)
    setup.prepare(`INSERT INTO "${legacyRecordTableName(legacyDescriptor.name, 'records')}" (key, value) VALUES (?, ?)`)
      .run('legacy', JSON.stringify({ retained: true }))
    setup.close()
    const before = await readFile(path)

    const backend = backendAt(path)
    await expect(withReserved(backend, legacyDescriptor.name, lease => lease.read(legacyDescriptor))).resolves.toEqual({
      tables: { records: { legacy: { retained: true } } },
      global: null,
    })
    await expect(backend.kv.open(legacyDescriptor)).rejects.toMatchObject({ code: 'version-mismatch' })
    await backend.close()
    expect(await readFile(path)).toEqual(before)
  })

  it.each(['current', 'legacy'] as const)(
    'rejects an unsafe unit version stored in the %s layout',
    async (layout) => {
      const path = await freshDbPath()
      const setup = new DatabaseSync(path)
      if (layout === 'current') {
        createV2Schema(setup)
        setup.exec('PRAGMA ignore_check_constraints = ON')
        setup.exec(`
          INSERT INTO units (name, version, has_global)
          VALUES ('${DESCRIPTOR.name}', 9007199254740992, 1)
        `)
        setup.exec('PRAGMA ignore_check_constraints = OFF')
      } else {
        setup.exec(`
          PRAGMA user_version = 1;
          CREATE TABLE units (name TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT;
          CREATE TABLE unit_globals (
            unit TEXT PRIMARY KEY REFERENCES units(name),
            value TEXT NOT NULL
          ) STRICT;
          INSERT INTO units (name, version) VALUES ('${DESCRIPTOR.name}', 9007199254740992);
        `)
      }
      setup.close()
      const before = await readFile(path)

      const backend = backendAt(path)
      await expect(withReserved(backend, DESCRIPTOR.name, lease => lease.inspect()))
        .rejects.toMatchObject({ code: 'malformed-medium' })
      await expect(backend.kv.open(DESCRIPTOR)).rejects.toMatchObject({
        code: layout === 'current' ? 'malformed-medium' : 'version-mismatch',
      })
      await backend.close()
      expect(await readFile(path)).toEqual(before)
    },
  )

  it('rejects a legacy-v1 object whose name only resembles the sqlite_ reserved prefix', async () => {
    const path = await freshDbPath()
    const descriptor = { ...DESCRIPTOR, hasGlobal: false }
    const setup = new DatabaseSync(path)
    setup.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE units (name TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT;
      CREATE TABLE unit_globals (unit TEXT PRIMARY KEY REFERENCES units(name), value TEXT NOT NULL) STRICT;
      CREATE TABLE "${legacyRecordTableName(descriptor.name, 'records')}" (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE sqliteXforeign (value TEXT) STRICT;
    `)
    setup.prepare('INSERT INTO units (name, version) VALUES (?, ?)').run(descriptor.name, descriptor.version)
    setup.close()

    const backend = backendAt(path)
    await expect(withReserved(backend, descriptor.name, lease => lease.read(descriptor)))
      .rejects.toMatchObject({ code: 'malformed-medium' })
    await backend.close()
  })

  it('rejects a legacy-v1 record table whose primary-key collation changes key identity', async () => {
    const path = await freshDbPath()
    const descriptor = { ...DESCRIPTOR, hasGlobal: false }
    const setup = new DatabaseSync(path)
    setup.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE units (name TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT;
      CREATE TABLE unit_globals (unit TEXT PRIMARY KEY REFERENCES units(name), value TEXT NOT NULL) STRICT;
      CREATE TABLE "${legacyRecordTableName(descriptor.name, 'records')}" (
        key TEXT PRIMARY KEY COLLATE NOCASE,
        value TEXT NOT NULL
      ) STRICT;
    `)
    setup.prepare('INSERT INTO units (name, version) VALUES (?, ?)').run(descriptor.name, descriptor.version)
    setup.close()

    const backend = backendAt(path)
    await expect(withReserved(backend, descriptor.name, lease => lease.read(descriptor)))
      .rejects.toMatchObject({ code: 'malformed-medium' })
    await backend.close()
  })

  it('opens an in-memory database', async () => {
    const backend = backendAt(':memory:')
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.putRecord('records', 'k', { n: 1 })
    expect((await unit.loadAll()).tables['records']).toEqual({ k: { n: 1 } })
    await backend.close()
  })

  it('materializes STRICT record tables and stamps the schema version', async () => {
    const path = await freshDbPath()
    const backend = backendAt(path)
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.putRecord('records', 'k', { n: 1 })
    await backend.close()

    const db = new DatabaseSync(path)
    try {
      const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
      expect(version).toBe(STORAGE_SQLITE_SCHEMA_VERSION)
      const table = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(recordTableName(DESCRIPTOR.name, 'records')) as { sql: string } | undefined
      expect(table?.sql).toContain('STRICT')
      const unitRow = db.prepare('SELECT version, has_global FROM units WHERE name = ?')
        .get('specimen') as { version: number; has_global: number }
      expect(unitRow).toEqual({ version: DESCRIPTOR.version, has_global: 1 })
      expect(db.prepare('SELECT table_name FROM unit_tables WHERE unit = ?').all('specimen'))
        .toEqual([{ table_name: 'records' }])
    } finally {
      db.close()
    }
  })

  it('rejects a mismatched database schema version', async () => {
    const path = await freshDbPath()
    const db = new DatabaseSync(path)
    db.exec('PRAGMA user_version = 999')
    db.close()

    const backend = backendAt(path)
    await expect(backend.kv.open(DESCRIPTOR)).rejects.toMatchObject({
      name: 'StorageError',
      code: 'version-mismatch',
    })
    await backend.close()
  })

  it('rejects invalid unit and table names before touching the medium', async () => {
    const backend = backendAt(':memory:')
    await expect(backend.kv.open({ ...DESCRIPTOR, name: 'Bad-Name' })).rejects.toThrow(/violates/)
    await expect(backend.kv.open({ ...DESCRIPTOR, tables: ['ok', '1bad'] })).rejects.toThrow(/violates/)
    await backend.close()
  })

  it('rejects a second open of the same unit name', async () => {
    const backend = backendAt(':memory:')
    await backend.kv.open(DESCRIPTOR)
    await expect(backend.kv.open(DESCRIPTOR)).rejects.toThrow(/already open/)
    await backend.close()
  })

  it('allows re-open after unit close, and rejects open on a closed backend', async () => {
    const backend = backendAt(':memory:')
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.close()
    const again = await backend.kv.open(DESCRIPTOR)
    await again.putRecord('records', 'k', 1)
    await backend.close()
    await expect(backend.kv.open(DESCRIPTOR)).rejects.toMatchObject({ code: 'closed' })
  })

  it('round-trips prototype-polluting keys as own properties', async () => {
    const backend = backendAt(':memory:')
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.putRecord('records', '__proto__', { evil: true })
    await unit.putRecord('records', 'constructor', { n: 1 })
    const { tables } = await unit.loadAll()
    const records = tables['records']!
    expect(Object.hasOwn(records, '__proto__')).toBe(true)
    expect(records['__proto__']).toEqual({ evil: true })
    expect(records['constructor']).toEqual({ n: 1 })
    expect(Object.getPrototypeOf({})).not.toHaveProperty('evil')
    await backend.close()
  })

  it('rejects an unstamped nonempty database without repairing it', async () => {
    const path = await freshDbPath()
    const setup = new DatabaseSync(path)
    setup.exec('CREATE TABLE squatter (x TEXT)')
    setup.exec('CREATE INDEX unit_globals ON squatter(x)')
    setup.close()
    const before = await readFile(path)

    const broken = backendAt(path)
    await expect(broken.kv.open(DESCRIPTOR)).rejects.toMatchObject({ code: 'malformed-medium' })
    await broken.close()
    expect(await readFile(path)).toEqual(before)
  })

  it('rejects unparsable stored JSON with malformed-medium', async () => {
    const path = await freshDbPath()
    const backend = backendAt(path)
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.putRecord('records', 'good', { n: 1 })
    await unit.setGlobal({ g: 1 })
    await backend.close()

    const db = new DatabaseSync(path)
    db.prepare(`UPDATE "${recordTableName(DESCRIPTOR.name, 'records')}" SET value = ? WHERE key = ?`)
      .run('{not json', encodeRecordKey('good'))
    db.close()

    const reopened = backendAt(path)
    await expect(reopened.kv.open(DESCRIPTOR)).rejects.toMatchObject({
      name: 'StorageError',
      code: 'malformed-medium',
    })
    await reopened.close()
  })

  it('rejects stored JSON whose parsed value cannot round-trip exactly', async () => {
    const path = await freshDbPath()
    const backend = backendAt(path)
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.putRecord('records', 'changed', 1)
    await unit.close()
    await backend.close()

    const db = new DatabaseSync(path)
    db.prepare(`UPDATE "${recordTableName(DESCRIPTOR.name, 'records')}" SET value = ? WHERE key = ?`)
      .run('1e400', encodeRecordKey('changed'))
    db.close()

    const reopened = backendAt(path)
    await expect(withReserved(reopened, DESCRIPTOR.name, lease => lease.read(DESCRIPTOR)))
      .rejects.toMatchObject({ name: 'StorageError', code: 'malformed-medium' })
    await reopened.close()
  })

  it.each(NONEXACT_STORED_JSON)('rejects current stored JSON with %s through the ordinary reader', async (
    _label,
    raw,
  ) => {
    const descriptor = { ...DESCRIPTOR, hasGlobal: false }
    const database = await openDatabase(':memory:', 'delete')
    insertV2Unit(database, descriptor)
    database.prepare(
      `INSERT INTO "${recordTableName(descriptor.name, 'records')}" (key, value) VALUES (?, CAST(? AS TEXT))`,
    )
      .run(encodeRecordKey('raw'), raw)
    const backend = backendWithReadyDatabase(database)
    try {
      await expect(backend.kv.open(descriptor)).rejects.toMatchObject({ code: 'malformed-medium' })
    } finally {
      await backend.close()
    }
  })

  describe.each(['current', 'legacy'] as const)('%s closed stored JSON exactness', (layout) => {
    it.each(NONEXACT_STORED_JSON)('rejects %s without changing source files', async (_label, raw) => {
      const path = await freshDbPath()
      const descriptor = { ...DESCRIPTOR, hasGlobal: false }
      createStoredRawValue(path, layout, descriptor, raw)
      const directory = dirname(path)
      const before = await snapshotDirectory(directory)

      const backend = backendAt(path, 'persist')
      await expect(withReserved(backend, descriptor.name, lease => lease.read(descriptor)))
        .rejects.toMatchObject({ code: 'malformed-medium' })
      await backend.close()
      expect(await snapshotDirectory(directory)).toEqual(before)
    })
  })

  it.each(['current', 'legacy'] as const)(
    'rejects a UTF-16 %s database without changing its files',
    async (layout) => {
      const path = await freshDbPath()
      const descriptor = { ...DESCRIPTOR, hasGlobal: false }
      const database = new DatabaseSync(path)
      database.exec("PRAGMA encoding = 'UTF-16le'")
      if (layout === 'current') {
        createV2Schema(database)
        insertV2Unit(database, descriptor)
      } else {
        database.exec(`
          PRAGMA user_version = 1;
          CREATE TABLE units (name TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT;
          CREATE TABLE unit_globals (unit TEXT PRIMARY KEY REFERENCES units(name), value TEXT NOT NULL) STRICT;
          CREATE TABLE "${legacyRecordTableName(descriptor.name, 'records')}" (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          ) STRICT;
        `)
        database.prepare('INSERT INTO units (name, version) VALUES (?, ?)')
          .run(descriptor.name, descriptor.version)
      }
      database.close()
      const directory = dirname(path)
      const before = await snapshotDirectory(directory)

      const closed = backendAt(path, 'persist')
      await expect(withReserved(closed, descriptor.name, lease => lease.inspect()))
        .rejects.toMatchObject({ code: 'malformed-medium' })
      await closed.close()
      if (layout === 'current') {
        const ordinary = backendAt(path, 'persist')
        await expect(ordinary.kv.open(descriptor)).rejects.toMatchObject({ code: 'malformed-medium' })
        await ordinary.close()
      }
      expect(await snapshotDirectory(directory)).toEqual(before)
    },
  )

  it.each(['ordinary', 'closed'] as const)(
    'rejects an empty unstamped UTF-16 database before %s initialization changes it',
    async (operation) => {
      const path = await freshDbPath()
      const descriptor = { ...DESCRIPTOR, hasGlobal: false }
      const seed = new DatabaseSync(path)
      seed.exec(`
        PRAGMA encoding = 'UTF-16le';
        CREATE TABLE transient (value TEXT);
        DROP TABLE transient;
      `)
      expect(seed.prepare('PRAGMA encoding').get()).toEqual({ encoding: 'UTF-16le' })
      expect(seed.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 })
      seed.close()
      const directory = dirname(path)
      const before = await snapshotDirectory(directory)

      const backend = backendAt(path, 'persist')
      if (operation === 'ordinary') {
        await expect(backend.kv.open(descriptor)).rejects.toMatchObject({ code: 'malformed-medium' })
      } else {
        await expect(withReserved(backend, descriptor.name, lease => lease.materializeMissing(descriptor, {
          tables: { records: {} },
          global: null,
        }))).rejects.toMatchObject({ code: 'malformed-medium' })
      }
      await backend.close()
      expect(await snapshotDirectory(directory)).toEqual(before)

      const unchanged = new DatabaseSync(path, { readOnly: true })
      expect(unchanged.prepare('PRAGMA encoding').get()).toEqual({ encoding: 'UTF-16le' })
      expect(unchanged.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 })
      expect(unchanged.prepare(`
        SELECT name FROM sqlite_schema WHERE instr(name, 'sqlite_') <> 1
      `).all()).toEqual([])
      unchanged.close()
    },
  )

  describe.each(['ordinary', 'closed'] as const)('%s current key exactness', (reader) => {
    it.each([
      ['unencoded text', Buffer.from('raw')],
      ['a noncanonical JSON escape', Buffer.from([0x22, 0x5c, 0x75, 0x30, 0x30, 0x37, 0x32, 0x61, 0x77, 0x22])],
      [
        'canonical prefix followed by NUL bytes',
        Buffer.concat([Buffer.from(encodeRecordKey('raw')), Buffer.from([0]), Buffer.from('suffix')]),
      ],
      [
        'byte-order mark before a canonical key',
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(encodeRecordKey('raw'))]),
      ],
      ['invalid UTF-8', Buffer.from([0x22, 0x80, 0x22])],
    ] as const)('rejects %s as malformed-medium', async (_label, rawKey) => {
      const descriptor = { ...DESCRIPTOR, hasGlobal: false }
      const database = await openDatabase(':memory:', 'delete')
      insertV2Unit(database, descriptor)
      database.prepare(
        `INSERT INTO "${recordTableName(descriptor.name, 'records')}" (key, value) VALUES (CAST(? AS TEXT), ?)`,
      ).run(rawKey, '{}')
      const backend = backendWithReadyDatabase(database)
      try {
        if (reader === 'ordinary') {
          await expect(backend.kv.open(descriptor)).rejects.toMatchObject({ code: 'malformed-medium' })
        } else {
          await expect(withReserved(backend, descriptor.name, lease => lease.read(descriptor)))
            .rejects.toMatchObject({ code: 'malformed-medium' })
        }
      } finally {
        await backend.close()
      }
    })
  })

  describe.each([
    ['invalid stored JSON', (db: DatabaseSync, physical: string) => {
      db.prepare(`UPDATE "${physical}" SET value = CAST(? AS TEXT)`).run('{bad json')
    }],
    ['a noncanonical stored key', (db: DatabaseSync, physical: string) => {
      db.prepare(`UPDATE "${physical}" SET key = CAST(? AS TEXT)`).run('raw')
    }],
  ] as const)('ordinary open with %s', (_label, corrupt) => {
    it('rejects before publishing a writable handle and leaves the source unchanged', async () => {
      const path = await freshDbPath()
      const descriptor = { ...DESCRIPTOR, hasGlobal: false }
      const seed = backendAt(path, 'delete')
      const seededUnit = await seed.kv.open(descriptor)
      await seededUnit.putRecord('records', 'raw', {})
      await seededUnit.close()
      await seed.close()
      const setup = new DatabaseSync(path)
      try {
        corrupt(setup, recordTableName(descriptor.name, 'records'))
      } finally {
        setup.close()
      }
      const directory = dirname(path)
      const before = await snapshotDirectory(directory)

      const backend = backendAt(path)
      try {
        const outcome = await backend.kv.open(descriptor).then(
          () => ({ status: 'resolved' as const }),
          (error: unknown) => ({ status: 'rejected' as const, error }),
        )
        expect(outcome).toMatchObject({
          status: 'rejected',
          error: { code: 'malformed-medium' },
        })
      } finally {
        await backend.close()
      }
      expect(await snapshotDirectory(directory)).toEqual(before)
    })
  })

  it('rejects executable serialization hooks without invoking them', async () => {
    const backend = backendAt(':memory:')
    const unit = await backend.kv.open(DESCRIPTOR)
    let invoked = false
    const hostile = { toJSON: () => { invoked = true } }
    await expect(unit.putRecord('records', 'k', hostile)).rejects.toThrow(/not a JSON value/)
    expect(invoked).toBe(false)
    await backend.close()
  })

  it.each([
    ['stored values', 'value', '{not json'],
    ['stored keys', 'key', 'raw'],
  ] as const)('fails closed when %s become malformed after an ordinary handle opens', async (
    _label,
    column,
    raw,
  ) => {
    const database = await openDatabase(':memory:', 'delete')
    insertV2Unit(database, { ...DESCRIPTOR, hasGlobal: false })
    const backend = backendWithReadyDatabase(database)
    const unit = await backend.kv.open({ ...DESCRIPTOR, hasGlobal: false })
    database.prepare(
      `INSERT INTO "${recordTableName(DESCRIPTOR.name, 'records')}" (key, value) VALUES (?, ?)`,
    ).run(encodeRecordKey('corrupted'), '{}')
    database.prepare(
      `UPDATE "${recordTableName(DESCRIPTOR.name, 'records')}" SET ${column} = CAST(? AS TEXT)`,
    ).run(raw)

    await expect(unit.loadAll()).rejects.toMatchObject({ code: 'malformed-medium' })
    await backend.close()
  })

  it('normalizes a non-Error read failure behind the Promise interface', async () => {
    const database = await openDatabase(':memory:', 'delete')
    const descriptor = { ...DESCRIPTOR, hasGlobal: false }
    insertV2Unit(database, descriptor)
    const fault = withArmedStatementFault(database, /SELECT CAST\(key AS BLOB\)/, 'all', 'injected read failure')
    const backend = backendWithReadyDatabase(fault.database)
    const unit = await backend.kv.open(descriptor)
    fault.arm()

    await expect(unit.loadAll()).rejects.toEqual(new Error('injected read failure'))
    await backend.close()
  })

  it('normalizes a non-Error statement failure before poisoning ordinary writes', async () => {
    const database = await openDatabase(':memory:', 'delete')
    insertV2Unit(database, DESCRIPTOR)
    const backend = backendWithReadyDatabase(withStatementRunFault(
      database,
      /^INSERT INTO "u2_.*ON CONFLICT/,
      'injected write failure',
    ))
    const unit = await backend.kv.open(DESCRIPTOR)

    await expect(unit.putRecord('records', 'possibly-written', 1)).rejects.toMatchObject({
      code: 'commit-outcome-unknown',
      cause: new Error('injected write failure'),
    })
    await backend.close()
  })

  it('rejects setGlobal on a unit without a global slot and writes to undeclared tables', async () => {
    const backend = backendAt(':memory:')
    const unit = await backend.kv.open({ ...DESCRIPTOR, hasGlobal: false })
    await expect(unit.setGlobal({ g: 1 })).rejects.toThrow(/declared no global slot/)
    await expect(unit.putRecord('undeclared', 'k', 1)).rejects.toThrow(/declared no table/)
    expect((await unit.loadAll()).global).toBeNull()
    await backend.close()
  })

  it('drains a still-pending failed open during close', async () => {
    const path = await freshDbPath()
    const first = backendAt(path)
    await (await first.kv.open(DESCRIPTOR)).close()
    await first.close()

    const backend = backendAt(path)
    // Do not await: close() must tolerate an in-flight open that will reject
    // (version mismatch) while its name is still reserved in the unit table.
    const pending = backend.kv.open({ ...DESCRIPTOR, version: 99 })
    const closed = backend.close()
    await expect(pending).rejects.toMatchObject({ code: 'version-mismatch' })
    await closed
  })

  it('rejects an opening unit when backend close wins the readiness race', async () => {
    const database = await openDatabase(':memory:', 'delete')
    const ready = Promise.withResolvers<DatabaseSync>()
    const backend = backendAt(':memory:', 'delete')
    const internalBackend = backend as unknown as { ready: Promise<DatabaseSync> }
    internalBackend.ready = ready.promise
    const opening = backend.kv.open(DESCRIPTOR)
    const closing = backend.close()
    ready.resolve(database)

    await expect(opening).rejects.toMatchObject({ code: 'closed' })
    await closing
  })

  it('propagates filesystem errors other than an existing database file', async () => {
    if (process.platform === 'win32') return
    const dir = await mkdtemp(join(tmpdir(), 'dsh-storage-sqlite-'))
    dirs.push(dir)
    await chmod(dir, 0o500)
    const backend = backendAt(join(dir, 'storage.db'))
    await expect(backend.kv.open(DESCRIPTOR)).rejects.toMatchObject({ code: 'EACCES' })
    await backend.close()
    await chmod(dir, 0o700)
  })

  it('propagates an invalid database filename before opening SQLite', async () => {
    const path = await freshDbPath()
    const backend = backendAt(`${path}\0invalid`)
    await expect(backend.kv.open(DESCRIPTOR)).rejects.toThrow(/null bytes/i)
    await backend.close()
  })

  it('preserves the mode of an existing database file', async () => {
    if (process.platform === 'win32') return
    const path = await freshDbPath()
    await writeFile(path, '', { mode: 0o644 })
    await chmod(path, 0o644)
    const backend = backendAt(path)
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.putRecord('records', 'k', 1)
    await backend.close()
  })

  it('registers on the storage hub as backend sqlite and closes on dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    const fiber = await ctx.plugin(StorageSqlite, { path: ':memory:' })
    const backend = ctx.storage.backend.get('sqlite')
    expect(ctx.get(storageBackendServiceKey('sqlite'))).toBe(backend)
    const unit = await backend.kv!.open(DESCRIPTOR)
    await unit.putRecord('records', 'k', { n: 1 })

    await fiber.dispose()
    expect(ctx.storage.backend.names()).toEqual([])
    expect(ctx.get(storageBackendServiceKey('sqlite'))).toBeUndefined()
    await expect(backend.kv!.open(DESCRIPTOR)).rejects.toMatchObject({ code: 'closed' })
  })

  it('registers and provides a configured backend name', async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    const fiber = await ctx.plugin(StorageSqlite, { backend: 'candidate-sqlite', path: ':memory:' })
    const backend = ctx.storage.backend.get('candidate-sqlite')
    expect(ctx.storage.backend.names()).toEqual(['candidate-sqlite'])
    expect(ctx.get(storageBackendServiceKey('candidate-sqlite'))).toBe(backend)

    await fiber.dispose()
    expect(ctx.storage.backend.names()).toEqual([])
    expect(ctx.get(storageBackendServiceKey('candidate-sqlite'))).toBeUndefined()
  })

  it('rejects an unparsable global slot with malformed-medium', async () => {
    const path = await freshDbPath()
    const backend = backendAt(path)
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.setGlobal({ g: 1 })
    await backend.close()

    const db = new DatabaseSync(path)
    db.prepare('UPDATE unit_globals SET value = ? WHERE unit = ?').run('][', 'specimen')
    db.close()

    const reopened = backendAt(path)
    await expect(reopened.kv.open(DESCRIPTOR)).rejects.toMatchObject({
      name: 'StorageError',
      code: 'malformed-medium',
    })
    await reopened.close()
  })

  it('closes memory and file writers after configuration failure', async () => {
    const failure = new Error('injected writer configuration failure')
    let closeCalls = 0
    const effects = schemaEffects({
      createDatabase: (path, options) => {
        const database = TEST_SCHEMA_EFFECTS.createDatabase(path, options)
        return new Proxy(database, {
          get(target, property) {
            if (property === 'close') {
              return () => {
                closeCalls += 1
                target.close()
              }
            }
            if (property === 'exec') {
              return (sql: string): void => {
                if (sql === 'PRAGMA foreign_keys = ON') throw failure
                target.exec(sql)
              }
            }
            return bindMethod(Reflect.get(target, property, target) as unknown, target)
          },
        })
      },
    })
    await expect(openDatabase(':memory:', 'delete', effects)).rejects.toBe(failure)
    expect(closeCalls).toBe(1)
    const path = await freshDbPath()
    await expect(openDatabase(path, 'delete', effects)).rejects.toBe(failure)
    expect(closeCalls).toBe(2)
  })

  it('validates version, identity, globals, foreign keys, and declared tables independently', async () => {
    const wrongCurrent = new DatabaseSync(':memory:')
    createV2Schema(wrongCurrent)
    wrongCurrent.exec('PRAGMA user_version = 1')
    expect(() => { validateV2Database(wrongCurrent, 'wrong-current') }).toThrow(
      expect.objectContaining({ code: 'version-mismatch' }),
    )
    wrongCurrent.close()

    const wrongLegacy = new DatabaseSync(':memory:')
    wrongLegacy.exec(`
      PRAGMA user_version = 2;
      CREATE TABLE units (name TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT;
      CREATE TABLE unit_globals (unit TEXT PRIMARY KEY REFERENCES units(name), value TEXT NOT NULL) STRICT;
    `)
    expect(() => { validateLegacyV1Database(wrongLegacy, 'wrong-legacy') }).toThrow(
      expect.objectContaining({ code: 'version-mismatch' }),
    )
    wrongLegacy.close()

    const invalidName = new DatabaseSync(':memory:')
    createV2Schema(invalidName)
    invalidName.prepare('INSERT INTO units (name, version, has_global) VALUES (?, ?, ?)')
      .run('Bad-Name', 1, 0)
    expect(() => { validateV2Database(invalidName, 'invalid-name') }).toThrow(
      expect.objectContaining({ code: 'malformed-medium' }),
    )
    invalidName.close()

    const forbiddenGlobal = new DatabaseSync(':memory:')
    createV2Schema(forbiddenGlobal)
    forbiddenGlobal.prepare('INSERT INTO units (name, version, has_global) VALUES (?, ?, ?)')
      .run(DESCRIPTOR.name, 1, 0)
    forbiddenGlobal.prepare('INSERT INTO unit_globals (unit, value) VALUES (?, ?)')
      .run(DESCRIPTOR.name, '{}')
    expect(() => { validateV2Database(forbiddenGlobal, 'forbidden-global') }).toThrow(
      expect.objectContaining({ code: 'malformed-medium' }),
    )
    forbiddenGlobal.close()

    const orphan = new DatabaseSync(':memory:')
    createV2Schema(orphan)
    orphan.exec('PRAGMA foreign_keys = OFF')
    orphan.prepare('INSERT INTO unit_tables (unit, table_name) VALUES (?, ?)').run('orphan', 'records')
    expect(() => { validateV2Database(orphan, 'orphan') }).toThrow(
      expect.objectContaining({ code: 'malformed-medium' }),
    )
    orphan.close()

    const missingTable = new DatabaseSync(':memory:')
    createV2Schema(missingTable)
    missingTable.prepare('INSERT INTO units (name, version, has_global) VALUES (?, ?, ?)')
      .run(DESCRIPTOR.name, 1, 0)
    missingTable.prepare('INSERT INTO unit_tables (unit, table_name) VALUES (?, ?)')
      .run(DESCRIPTOR.name, 'records')
    expect(() => { validateV2Database(missingTable, 'missing-table') }).toThrow(
      expect.objectContaining({ code: 'malformed-medium' }),
    )
    missingTable.close()
  })

  it('rechecks declared physical tables after validating each table', async () => {
    const database = await openDatabase(':memory:', 'delete')
    const descriptor = { ...DESCRIPTOR, hasGlobal: false }
    insertV2Unit(database, descriptor)
    const physical = recordTableName(descriptor.name, 'records')
    const faulted = new Proxy(database, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql: string) => {
            const statement = target.prepare(sql)
            if (!sql.includes('FROM sqlite_schema') || !sql.includes('ORDER BY type, name')) return statement
            return new Proxy(statement, {
              get(statementTarget, statementProperty) {
                if (statementProperty === 'all') {
                  return () => (statementTarget.all() as unknown as Array<{ name_bytes: Uint8Array }>)
                    .filter((row) => {
                      const name = Buffer.from(row.name_bytes).toString('utf8')
                      return name !== physical && name !== `sqlite_autoindex_${physical}_1`
                    })
                }
                return bindMethod(
                  Reflect.get(statementTarget, statementProperty, statementTarget) as unknown,
                  statementTarget,
                )
              },
            })
          }
        }
        return bindMethod(Reflect.get(target, property, target) as unknown, target)
      },
    })
    try {
      expect(() => { validateV2Database(faulted, 'inventory-race') }).toThrow(
        expect.objectContaining({ code: 'malformed-medium' }),
      )
    } finally {
      database.close()
    }
  })

  it('rechecks physical version after writer PRAGMAs', async () => {
    const effects = schemaEffects({
      createDatabase: (path, options) => {
        const database = TEST_SCHEMA_EFFECTS.createDatabase(path, options)
        return new Proxy(database, {
          get(target, property) {
            if (property === 'exec') {
              return (sql: string): void => {
                target.exec(sql)
                if (sql.startsWith('PRAGMA journal_mode')) target.exec('PRAGMA user_version = 99')
              }
            }
            return bindMethod(Reflect.get(target, property, target) as unknown, target)
          },
        })
      },
    })
    await expect(openDatabase(':memory:', 'delete', effects)).rejects.toMatchObject({ code: 'version-mismatch' })
  })

  it('rejects a physical version change before writer configuration', async () => {
    const path = await freshDbPath()
    const seeded = await openDatabase(path, 'delete')
    seeded.close()
    const effects = schemaEffects({
      createDatabase: (databasePath, options) => {
        const database = TEST_SCHEMA_EFFECTS.createDatabase(databasePath, options)
        if (options === undefined) database.exec('PRAGMA user_version = 99')
        return database
      },
    })
    await expect(openDatabase(path, 'delete', effects)).rejects.toMatchObject({ code: 'version-mismatch' })
  })

  it('rejects an invalid legacy global owner name', () => {
    const database = new DatabaseSync(':memory:')
    database.exec(`
      PRAGMA user_version = 1;
      PRAGMA foreign_keys = OFF;
      CREATE TABLE units (name TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT;
      CREATE TABLE unit_globals (unit TEXT PRIMARY KEY REFERENCES units(name), value TEXT NOT NULL) STRICT;
    `)
    database.prepare('INSERT INTO units (name, version) VALUES (?, ?)').run(DESCRIPTOR.name, 1)
    database.prepare('INSERT INTO unit_globals (unit, value) VALUES (?, ?)').run('Bad-Name', '{}')
    try {
      expect(() => inspectExistingDatabase(database, DESCRIPTOR.name)).toThrow(
        expect.objectContaining({ code: 'malformed-medium' }),
      )
    } finally {
      database.close()
    }
  })

  it('rejects unterminated quoted schema SQL', () => {
    const malformed = new DatabaseSync(':memory:')
    malformed.exec('CREATE TABLE specimen (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT')
    setDefensive(malformed, false)
    malformed.exec('PRAGMA writable_schema = ON')
    malformed.prepare('UPDATE sqlite_schema SET sql = ? WHERE name = ?')
      .run('CREATE TABLE "unterminated', 'specimen')
    malformed.exec('PRAGMA writable_schema = OFF')
    setDefensive(malformed, true)
    try {
      expect(() => { validateRecordTable(malformed, 'specimen', 'unterminated') }).toThrow(
        expect.objectContaining({ code: 'malformed-medium' }),
      )
    } finally {
      malformed.close()
    }
  })

  it('rejects NULL schema identity text and incompatible foreign-key metadata', async () => {
    const nullSchema = new DatabaseSync(':memory:')
    nullSchema.exec('CREATE TABLE specimen (value TEXT) STRICT')
    setDefensive(nullSchema, false)
    nullSchema.exec('PRAGMA writable_schema = ON')
    nullSchema.exec("UPDATE sqlite_schema SET tbl_name = NULL WHERE name = 'specimen'")
    nullSchema.exec('PRAGMA writable_schema = OFF')
    setDefensive(nullSchema, true)
    try {
      expect(() => listUserSchemaObjects(nullSchema)).toThrow(/is NULL/)
    } finally {
      nullSchema.close()
    }

    const valid = await openDatabase(':memory:', 'delete')
    const faulted = new Proxy(valid, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql: string) => {
            if (sql.startsWith('PRAGMA foreign_key_list')) {
              return { all: () => [] }
            }
            return target.prepare(sql)
          }
        }
        return bindMethod(Reflect.get(target, property, target) as unknown, target)
      },
    })
    try {
      expect(() => { validateV2Database(faulted, 'foreign-key-fault') }).toThrow(
        expect.objectContaining({ code: 'malformed-medium' }),
      )
    } finally {
      valid.close()
    }
  })

  it('rejects a directory where a regular SQLite file is required', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-storage-sqlite-directory-'))
    dirs.push(directory)
    await expect(openDatabase(directory, 'delete')).rejects.toMatchObject({ code: 'malformed-medium' })
  })

  it('fails closed when an EEXIST creation race leaves no readable database', async () => {
    const path = await freshDbPath()
    const effects = schemaEffects({
      lstat: async () => { throw errno('ENOENT') },
      open: async () => { throw errno('EEXIST') },
    })
    await expect(openDatabase(path, 'delete', effects)).rejects.toThrow(/disappeared during open/)
  })

  it('opens a database that appears after the final absent-sidecar scan', async () => {
    const path = await freshDbPath()
    const seeded = await openDatabase(path, 'delete')
    seeded.close()
    let databaseStats = 0
    const effects = schemaEffects({
      lstat: (async (target) => {
        if (String(target) === path && ++databaseStats <= 2) throw errno('ENOENT')
        return await TEST_SCHEMA_EFFECTS.lstat(target)
      }) as typeof TEST_SCHEMA_EFFECTS.lstat,
    })
    const view = await openExistingDatabaseReadonly(path, new AbortController().signal, effects)
    expect(view.database).toBeDefined()
    await view.close()
  })

  it('preserves preflight and frozen-view cleanup failures', async () => {
    const invalidPath = await freshDbPath()
    const invalid = new DatabaseSync(invalidPath)
    invalid.exec('PRAGMA user_version = 99')
    invalid.close()
    const cleanupFailure = new Error('injected frozen cleanup failure')
    const failingCleanup = schemaEffects({
      rm: async (path, options) => {
        if (String(path).includes('dsh-storage-sqlite-read-')) throw cleanupFailure
        await TEST_SCHEMA_EFFECTS.rm(path, options)
      },
    })
    const aggregate = await openDatabase(invalidPath, 'delete', failingCleanup).catch((error: unknown) => error)
    expect(aggregate).toBeInstanceOf(AggregateError)
    expect((aggregate as AggregateError).errors[1]).toBe(cleanupFailure)

    const validPath = await freshDbPath()
    const seeded = await openDatabase(validPath, 'delete')
    seeded.close()
    await expect(openDatabase(validPath, 'delete', failingCleanup)).rejects.toBe(cleanupFailure)
  })

  it('removes an owned empty file when writer construction fails', async () => {
    const path = await freshDbPath()
    const constructionFailure = new Error('injected writer construction failure')
    const effects = schemaEffects({
      createDatabase: () => { throw constructionFailure },
    })
    await expect(openDatabase(path, 'delete', effects)).rejects.toBe(constructionFailure)
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not remove an existing database when writer construction fails', async () => {
    const path = await freshDbPath()
    const seeded = await openDatabase(path, 'delete')
    seeded.close()
    const before = await readFile(path)
    const constructionFailure = new Error('injected existing writer construction failure')
    const effects = schemaEffects({
      createDatabase: (databasePath, options) => {
        if (options === undefined) throw constructionFailure
        return TEST_SCHEMA_EFFECTS.createDatabase(databasePath, options)
      },
    })
    await expect(openDatabase(path, 'delete', effects)).rejects.toBe(constructionFailure)
    expect(await readFile(path)).toEqual(before)
  })

  it('closes a newly created file handle before surfacing its close failure', async () => {
    const path = await freshDbPath()
    const closeFailure = new Error('injected created handle close failure')
    const effects = schemaEffects({
      open: async (file, flags, mode) => {
        const handle = await TEST_SCHEMA_EFFECTS.open(file, flags, mode)
        let armed = true
        return new Proxy(handle, {
          get(target, property) {
            if (property === 'close') {
              return async () => {
                await target.close()
                if (armed) {
                  armed = false
                  throw closeFailure
                }
              }
            }
            return bindMethod(Reflect.get(target, property, target) as unknown, target)
          },
        })
      },
    })
    await expect(openDatabase(path, 'delete', effects)).rejects.toBe(closeFailure)
  })

  it('rejects a source that changes while its frozen copy is made', async () => {
    const path = await freshDbPath()
    const seeded = await openDatabase(path, 'delete')
    seeded.close()
    let changed = false
    const effects = schemaEffects({
      copyFile: async (source, destination, mode) => {
        await TEST_SCHEMA_EFFECTS.copyFile(source, destination, mode)
        if (!changed && String(source) === path) {
          changed = true
          await writeFile(path, Buffer.from('changed during copy'))
        }
      },
    })
    await expect(openExistingDatabaseReadonly(path, new AbortController().signal, effects))
      .rejects.toMatchObject({ code: 'malformed-medium' })
  })

  it.each([
    ['database close', true, false],
    ['temporary removal', false, true],
    ['both cleanup operations', true, true],
  ] as const)('reports frozen-view %s failure', async (_label, failClose, failRemove) => {
    const path = await freshDbPath()
    const seeded = await openDatabase(path, 'delete')
    seeded.close()
    const closeFailure = new Error('injected frozen database close failure')
    const removeFailure = new Error('injected frozen directory removal failure')
    const effects = schemaEffects({
      createDatabase: (databasePath, options) => {
        const database = TEST_SCHEMA_EFFECTS.createDatabase(databasePath, options)
        if (options === undefined || !failClose) return database
        return new Proxy(database, {
          get(target, property) {
            if (property === 'close') {
              return () => {
                target.close()
                throw closeFailure
              }
            }
            return bindMethod(Reflect.get(target, property, target) as unknown, target)
          },
        })
      },
      rm: async (target, options) => {
        await TEST_SCHEMA_EFFECTS.rm(target, options)
        if (failRemove && String(target).includes('dsh-storage-sqlite-read-')) throw removeFailure
      },
    })
    const view = await openExistingDatabaseReadonly(path, new AbortController().signal, effects)
    const error = await view.close().catch((failure: unknown) => failure)
    if (failClose && failRemove) {
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors).toEqual([closeFailure, removeFailure])
    } else {
      expect(error).toBe(failClose ? closeFailure : removeFailure)
    }
    await expect(view.close()).resolves.toBeUndefined()
  })

  it('aggregates frozen database validation, close, and cleanup failures', async () => {
    const path = await freshDbPath()
    const seeded = await openDatabase(path, 'delete')
    seeded.close()
    const validationFailure = new Error('injected frozen validation failure')
    const closeFailure = new Error('injected frozen close failure')
    const cleanupFailure = new Error('injected frozen cleanup failure')
    const effects = schemaEffects({
      createDatabase: (databasePath, options) => {
        const database = TEST_SCHEMA_EFFECTS.createDatabase(databasePath, options)
        if (options === undefined) return database
        return new Proxy(database, {
          get(target, property) {
            if (property === 'prepare') return () => { throw validationFailure }
            if (property === 'close') {
              return () => {
                target.close()
                throw closeFailure
              }
            }
            return bindMethod(Reflect.get(target, property, target) as unknown, target)
          },
        })
      },
      rm: async (target, options) => {
        await TEST_SCHEMA_EFFECTS.rm(target, options)
        if (String(target).includes('dsh-storage-sqlite-read-')) throw cleanupFailure
      },
    })
    const error = await openExistingDatabaseReadonly(path, new AbortController().signal, effects)
      .catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ code: 'malformed-medium', cause: validationFailure }),
      closeFailure,
      cleanupFailure,
    ])
  })

  it.each([
    ['disappears', 'missing'],
    ['becomes non-file', 'kind'],
    ['changes device', 'dev'],
    ['changes inode', 'ino'],
    ['gains content', 'size'],
  ] as const)('rejects a newly created database that %s before ownership confirmation', async (_label, mutation) => {
    const path = await freshDbPath()
    let created = false
    const effects = schemaEffects({
      open: async (file, flags, mode) => {
        const handle = await TEST_SCHEMA_EFFECTS.open(file, flags, mode)
        created = true
        return handle
      },
      lstat: (async (target) => {
        if (!created || String(target) !== path) return await TEST_SCHEMA_EFFECTS.lstat(target)
        if (mutation === 'missing') throw errno('ENOENT')
        const entry = await TEST_SCHEMA_EFFECTS.lstat(target)
        return new Proxy(entry, {
          get(statTarget, property) {
            if (mutation === 'kind' && property === 'isFile') return () => false
            if (property === mutation) {
              const value = Number(Reflect.get(statTarget, property, statTarget))
              return mutation === 'size' ? value + 1 : value === 0 ? 1 : 0
            }
            return bindMethod(Reflect.get(statTarget, property, statTarget) as unknown, statTarget)
          },
        })
      }) as typeof TEST_SCHEMA_EFFECTS.lstat,
    })
    const error = await openDatabase(path, 'delete', effects).catch((failure: unknown) => failure)
    if (mutation === 'missing') {
      expect(error).toMatchObject({ code: 'malformed-medium' })
    } else {
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors).toMatchObject([
        { code: 'malformed-medium' },
        { code: 'malformed-medium' },
      ])
    }
    await rm(path, { force: true })
  })

  it('preserves sidecar inspection and cleanup failures after creating the database file', async () => {
    const path = await freshDbPath()
    let created = false
    const sidecarFailure = errno('EACCES')
    const effects = schemaEffects({
      open: async (file, flags, mode) => {
        const handle = await TEST_SCHEMA_EFFECTS.open(file, flags, mode)
        created = true
        return handle
      },
      lstat: (async (target) => {
        if (created && String(target).endsWith('-wal')) throw sidecarFailure
        return await TEST_SCHEMA_EFFECTS.lstat(target)
      }) as typeof TEST_SCHEMA_EFFECTS.lstat,
    })
    await expect(openDatabase(path, 'delete', effects)).rejects.toBe(sidecarFailure)
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })

    const cleanupPath = await freshDbPath()
    const constructionFailure = new Error('injected writer construction failure')
    const cleanupFailure = new Error('injected owned-file removal failure')
    const cleanupEffects = schemaEffects({
      createDatabase: () => { throw constructionFailure },
      rm: async (target, options) => {
        if (String(target) === cleanupPath) throw cleanupFailure
        await TEST_SCHEMA_EFFECTS.rm(target, options)
      },
    })
    const aggregate = await openDatabase(cleanupPath, 'delete', cleanupEffects).catch((error: unknown) => error)
    expect(aggregate).toBeInstanceOf(AggregateError)
    expect((aggregate as AggregateError).errors).toEqual([constructionFailure, cleanupFailure])
    await rm(cleanupPath, { force: true })
  })

  it('rejects non-EEXIST creation failure and a sidecar that appears after creation', async () => {
    const failedPath = await freshDbPath()
    const openFailure = errno('EACCES')
    await expect(openDatabase(failedPath, 'delete', schemaEffects({
      open: async () => { throw openFailure },
    }))).rejects.toBe(openFailure)

    const sidecarPath = await freshDbPath()
    const effects = schemaEffects({
      open: async (file, flags, mode) => {
        const handle = await TEST_SCHEMA_EFFECTS.open(file, flags, mode)
        await writeFile(`${String(file)}-wal`, 'appeared')
        return handle
      },
    })
    await expect(openDatabase(sidecarPath, 'delete', effects)).rejects.toMatchObject({ code: 'malformed-medium' })
    await rm(`${sidecarPath}-wal`, { force: true })
  })

  it('aggregates non-ENOENT ownership inspection and created-handle close failure', async () => {
    const inspectionPath = await freshDbPath()
    let created = false
    const inspectionFailure = errno('EACCES')
    const inspectionEffects = schemaEffects({
      open: async (file, flags, mode) => {
        const handle = await TEST_SCHEMA_EFFECTS.open(file, flags, mode)
        created = true
        return handle
      },
      lstat: (async (target) => {
        if (created && String(target) === inspectionPath) throw inspectionFailure
        return await TEST_SCHEMA_EFFECTS.lstat(target)
      }) as typeof TEST_SCHEMA_EFFECTS.lstat,
    })
    const inspectionError = await openDatabase(inspectionPath, 'delete', inspectionEffects)
      .catch((error: unknown) => error)
    expect(inspectionError).toBeInstanceOf(AggregateError)
    expect((inspectionError as AggregateError).errors).toEqual([inspectionFailure, inspectionFailure])
    await rm(inspectionPath, { force: true })

    const closePath = await freshDbPath()
    const constructionFailure = new Error('injected writer construction failure')
    const closeFailure = new Error('injected created-handle close failure')
    const closeEffects = schemaEffects({
      createDatabase: () => { throw constructionFailure },
      open: async (file, flags, mode) => {
        const handle = await TEST_SCHEMA_EFFECTS.open(file, flags, mode)
        return new Proxy(handle, {
          get(target, property) {
            if (property === 'close') {
              return async () => {
                await target.close()
                throw closeFailure
              }
            }
            return bindMethod(Reflect.get(target, property, target) as unknown, target)
          },
        })
      },
    })
    const closeError = await openDatabase(closePath, 'delete', closeEffects).catch((error: unknown) => error)
    expect(closeError).toBeInstanceOf(AggregateError)
    expect((closeError as AggregateError).errors).toEqual([constructionFailure, closeFailure])
  })

  it('rolls back failed schema initialization and aggregates rollback failure', async () => {
    const primary = new Error('injected schema initialization failure')
    const createFaultedEffects = (rollbackFailure?: Error) => schemaEffects({
      createDatabase: (path, options) => {
        const database = TEST_SCHEMA_EFFECTS.createDatabase(path, options)
        return new Proxy(database, {
          get(target, property) {
            if (property === 'exec') {
              return (sql: string): void => {
                if (sql.includes('CREATE TABLE units')) throw primary
                if (sql === 'ROLLBACK' && rollbackFailure !== undefined) throw rollbackFailure
                target.exec(sql)
              }
            }
            return bindMethod(Reflect.get(target, property, target) as unknown, target)
          },
        })
      },
    })
    await expect(openDatabase(':memory:', 'delete', createFaultedEffects())).rejects.toBe(primary)
    const rollbackFailure = new Error('injected schema rollback failure')
    const aggregate = await openDatabase(':memory:', 'delete', createFaultedEffects(rollbackFailure))
      .catch((error: unknown) => error)
    expect(aggregate).toBeInstanceOf(AggregateError)
    expect((aggregate as AggregateError).errors).toEqual([primary, rollbackFailure])
  })

  it('reports schema initialization failure before a transaction starts', async () => {
    const beginFailure = new Error('injected schema BEGIN failure')
    const effects = schemaEffects({
      createDatabase: (path, options) => {
        const database = TEST_SCHEMA_EFFECTS.createDatabase(path, options)
        return new Proxy(database, {
          get(target, property) {
            if (property === 'exec') {
              return (sql: string): void => {
                if (sql === 'BEGIN IMMEDIATE') throw beginFailure
                target.exec(sql)
              }
            }
            return bindMethod(Reflect.get(target, property, target) as unknown, target)
          },
        })
      },
    })
    await expect(openDatabase(':memory:', 'delete', effects)).rejects.toBe(beginFailure)
  })

  it('aggregates an open failure with database close failure', async () => {
    const primary = new Error('injected writer configuration failure')
    const closeFailure = new Error('injected database close failure')
    const effects = schemaEffects({
      createDatabase: (path, options) => {
        const database = TEST_SCHEMA_EFFECTS.createDatabase(path, options)
        return new Proxy(database, {
          get(target, property) {
            if (property === 'exec') {
              return (sql: string): void => {
                if (sql === 'PRAGMA foreign_keys = ON') throw primary
                target.exec(sql)
              }
            }
            if (property === 'close') {
              return () => {
                target.close()
                throw closeFailure
              }
            }
            return bindMethod(Reflect.get(target, property, target) as unknown, target)
          },
        })
      },
    })
    const error = await openDatabase(':memory:', 'delete', effects).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([primary, closeFailure])
  })
})
