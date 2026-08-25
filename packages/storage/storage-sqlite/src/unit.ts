/**
 * One opened SQLite KV unit: prepared per-table statements over the
 * collision-free physical record tables plus this unit's row in the shared
 * `unit_globals` table. Each primitive is a single statement, so atomicity
 * comes from SQLite itself — no explicit transactions, and no write queue
 * (write ordering is the caller's responsibility per the KV contract).
 * @module @deepseek-ai/dsh-storage-sqlite/unit
 */

import type { DatabaseSync, StatementSync } from 'node:sqlite'
import {
  parseLosslessJsonValue,
  StorageError,
  stringifyLosslessJsonValue,
} from '@deepseek-ai/dsh-storage'
import type { KvUnit, KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import { decodeRecordKey, decodeSqliteText, encodeRecordKey } from './key.ts'
import { recordTableName } from './schema.ts'

/** Prepared statements for one declared table. */
interface TableStatements {
  upsert: StatementSync
  remove: StatementSync
  selectAll: StatementSync
}

/**
 * The SQLite {@link KvUnit}. Constructed by the backend AFTER the unit's
 * record tables exist; statements are prepared once here and reused for every
 * primitive. Values are stored as JSON text in the `value` column.
 */
export class SqliteKvUnit implements KvUnit {
  private readonly tables = new Map<string, TableStatements>()
  private readonly globalUpsert: StatementSync | undefined
  private readonly globalSelect: StatementSync | undefined
  private closed = false

  /**
   * @param db - Open database handle owned by the backend (never closed here).
   * @param descriptor - Validated descriptor whose record tables already exist.
   * @param onClose - Backend callback releasing this unit's open-name slot.
   * @param ensureHealthy - Backend poison guard checked before shared-connection access.
   * @param onWriteFailure - Maps an entered statement failure and poisons the writer.
   */
  constructor(
    db: DatabaseSync,
    private readonly descriptor: KvUnitDescriptor,
    private readonly onClose: () => void,
    private readonly ensureHealthy: () => void,
    private readonly onWriteFailure: (cause: Error) => Error,
  ) {
    for (const table of descriptor.tables) {
      // recordTableName emits only a fixed prefix and hexadecimal text, so the
      // physical identifier is safe to interpolate into statement text.
      const physical = recordTableName(descriptor.name, table)
      this.tables.set(table, {
        upsert: db.prepare(
          `INSERT INTO "${physical}" (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        ),
        remove: db.prepare(`DELETE FROM "${physical}" WHERE key = ?`),
        selectAll: db.prepare(
          `SELECT CAST(key AS BLOB) AS key_bytes, CAST(value AS BLOB) AS value_bytes FROM "${physical}" ORDER BY key`,
        ),
      })
    }
    this.globalUpsert = descriptor.hasGlobal
      ? db.prepare(
        'INSERT INTO unit_globals (unit, value) VALUES (?, ?) ON CONFLICT(unit) DO UPDATE SET value = excluded.value',
      )
      : undefined
    this.globalSelect = descriptor.hasGlobal
      ? db.prepare('SELECT CAST(value AS BLOB) AS value_bytes FROM unit_globals WHERE unit = ?')
      : undefined
  }

  loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    return this.settle(() => {
      this.ensureHealthy()
      const tables: Record<string, Record<string, unknown>> = {}
      for (const [name, statements] of this.tables) {
        // Null prototype: record keys are arbitrary strings, so '__proto__'
        // must land as an own property instead of mutating the prototype.
        const records: Record<string, unknown> = Object.create(null) as Record<string, unknown>
        for (const row of statements.selectAll.all() as unknown as Array<{
          key_bytes: Uint8Array
          value_bytes: Uint8Array
        }>) {
          const key = this.parseKey(row.key_bytes, name)
          records[key] = this.parseValue(row.value_bytes, `table '${name}' key '${key}'`)
        }
        tables[name] = records
      }
      let global: unknown = null
      if (this.globalSelect !== undefined) {
        const row = this.globalSelect.get(this.descriptor.name) as { value_bytes: Uint8Array } | undefined
        if (row !== undefined) global = this.parseValue(row.value_bytes, 'global slot')
      }
      return { tables, global }
    })
  }

  /** Parse one stored value column, mapping invalid JSON data to `malformed-medium`. */
  private parseValue(bytes: Uint8Array, slot: string): unknown {
    try {
      const text = decodeSqliteText(bytes)
      return parseLosslessJsonValue(text, `kv unit '${this.descriptor.name}' ${slot}`)
    } catch (error) {
      throw new StorageError(
        'malformed-medium',
        `kv unit '${this.descriptor.name}' holds invalid JSON data at ${slot}`,
        { cause: error },
      )
    }
  }

  /** Decode one canonical physical-v2 key, mapping corruption to `malformed-medium`. */
  private parseKey(bytes: Uint8Array, table: string): string {
    try {
      return decodeRecordKey(bytes)
    } catch (error) {
      throw new StorageError(
        'malformed-medium',
        `kv unit '${this.descriptor.name}' holds an invalid encoded key in table '${table}'`,
        { cause: error },
      )
    }
  }

  putRecord(table: string, key: string, value: unknown): Promise<void> {
    return this.settle(() => {
      this.ensureHealthy()
      const statement = this.statementsFor(table).upsert
      const serialized = stringifyLosslessJsonValue(
        value,
        `kv unit '${this.descriptor.name}' table '${table}' key '${key}'`,
      )
      this.executeWrite(() => statement.run(encodeRecordKey(key), serialized))
    })
  }

  deleteRecord(table: string, key: string): Promise<void> {
    return this.settle(() => {
      this.ensureHealthy()
      const statement = this.statementsFor(table).remove
      this.executeWrite(() => statement.run(encodeRecordKey(key)))
    })
  }

  setGlobal(value: unknown): Promise<void> {
    return this.settle(() => {
      this.ensureHealthy()
      const statement = this.globalUpsert
      if (statement === undefined) {
        throw new Error(`kv unit '${this.descriptor.name}' declared no global slot`)
      }
      const serialized = stringifyLosslessJsonValue(value, `kv unit '${this.descriptor.name}' global slot`)
      this.executeWrite(() => statement.run(this.descriptor.name, serialized))
    })
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true
      this.onClose()
    }
    return Promise.resolve()
  }

  /**
   * Run one synchronous primitive behind the closed guard, mapping a throw to
   * a rejection so the Promise-returning contract never throws synchronously.
   */
  private settle<T>(operation: () => T): Promise<T> {
    try {
      this.ensureOpen()
      return Promise.resolve(operation())
    } catch (error) {
      // Preserve Error diagnostics and keep the Promise API stable if a
      // dependency or platform API throws a non-Error value.
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new StorageError('closed', `kv unit '${this.descriptor.name}' is closed`)
    }
  }

  private executeWrite(operation: () => unknown): void {
    try {
      operation()
    } catch (error) {
      throw this.onWriteFailure(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private statementsFor(table: string): TableStatements {
    const statements = this.tables.get(table)
    if (statements === undefined) {
      throw new Error(`kv unit '${this.descriptor.name}' declared no table '${table}'`)
    }
    return statements
  }
}
