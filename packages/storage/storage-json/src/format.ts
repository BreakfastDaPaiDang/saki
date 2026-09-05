/**
 * Versioned JSON documents for whole-unit and per-record storage layouts.
 * @module @deepseek-ai/dsh-storage-json/src/format
 */

import {
  isKvUnitVersion,
  parseLosslessJsonValue,
  StorageError,
  UNIT_NAME_RE,
  stringifyLosslessJsonValue,
} from '@deepseek-ai/dsh-storage'
import type { KvUnitDescriptor, KvUnitSnapshot } from '@deepseek-ai/dsh-storage'

/** Current JSON document format, independent from a unit's domain-owned version. */
export const JSON_FORMAT_VERSION = 1

/** In-memory authoritative state of one unit. `global` is `null` until first written. */
export interface UnitState {
  /** Stored global value, or the `null` never-written sentinel. */
  global: unknown
  /** Complete record maps keyed by declared table name. */
  tables: Map<string, Map<string, unknown>>
}

/** Strictly parsed stored unit before comparison with a caller descriptor. */
export interface StoredJsonUnit {
  /** Unit name stamped in the document header. */
  readonly name: string
  /** Domain-owned unit version stamped in the document header. */
  readonly version: number
  /** Stored global-slot declaration. */
  readonly hasGlobal: boolean
  /** Complete parsed unit state. */
  readonly state: UnitState
}

/**
 * Serialize the complete current JSON format.
 * @param descriptor - Unit identity and declared layout stamped into the header.
 * @param state - Authoritative in-memory state.
 * @returns pretty-printed JSON document with a trailing newline.
 * @throws TypeError when the state contains a value JSON cannot preserve exactly.
 */
export function serialize(descriptor: KvUnitDescriptor, state: UnitState): string {
  const tables: Record<string, Record<string, unknown>> = {}
  for (const [table, records] of state.tables) {
    tables[table] = Object.fromEntries(records)
  }
  const document = {
    unit: {
      name: descriptor.name,
      version: descriptor.version,
      formatVersion: JSON_FORMAT_VERSION,
      hasGlobal: descriptor.hasGlobal,
    },
    global: state.global,
    tables,
  }
  return `${stringifyLosslessJsonValue(document, `unit '${descriptor.name}' JSON document`, 2)}\n`
}

/**
 * Parse a current-format document and compare its complete layout with a descriptor.
 * @param text - Raw file content.
 * @param descriptor - Expected identity and layout.
 * @returns the parsed state.
 */
export function parse(text: string, descriptor: KvUnitDescriptor): UnitState {
  const stored = parseStoredJsonUnit(text, descriptor.name)
  validateStoredDescriptor(stored, descriptor)
  return stored.state
}

/**
 * Parse and validate a current-format document without supplying its expected domain version.
 * @param text - Raw file content.
 * @param expectedName - Unit name derived from the selected medium entry.
 * @returns stored identity, layout, and state.
 * @throws StorageError with `malformed-medium` when the document is not exact physical v1.
 */
export function parseStoredJsonUnit(text: string, expectedName: string): StoredJsonUnit {
  let document: unknown
  try {
    document = parseLosslessJsonValue(text, `unit '${expectedName}' JSON document`)
  } catch (error) {
    throw malformed(expectedName, 'file is not strict lossless JSON', error)
  }
  if (!isRecord(document)) throw malformed(expectedName, 'file is not a JSON object')
  if (!hasExactOwnKeys(document, ['unit', 'global', 'tables'])) {
    throw malformed(expectedName, 'file is not a complete JSON unit document')
  }

  const unit = document['unit']
  if (!isRecord(unit)
    || !hasExactOwnKeys(unit, ['name', 'version', 'formatVersion', 'hasGlobal'])
    || unit['name'] !== expectedName
    || !isKvUnitVersion(unit['version'])
    || unit['formatVersion'] !== JSON_FORMAT_VERSION
    || typeof unit['hasGlobal'] !== 'boolean') {
    throw malformed(expectedName, 'missing, foreign, or unsupported unit header')
  }
  const tablesValue = document['tables']
  if (!isRecord(tablesValue)) throw malformed(expectedName, 'tables is not an object')

  const tables = new Map<string, Map<string, unknown>>()
  for (const [table, records] of Object.entries(tablesValue)) {
    if (!UNIT_NAME_RE.test(table) || !isRecord(records)) {
      throw malformed(expectedName, `table '${table}' is not a record object`)
    }
    tables.set(table, new Map(Object.entries(records)))
  }
  const hasGlobal = unit['hasGlobal']
  const global = document['global']
  if (!hasGlobal && global !== null) {
    throw malformed(expectedName, 'stored global is present without a declared global slot')
  }
  return {
    name: expectedName,
    version: unit['version'],
    hasGlobal,
    state: { global, tables },
  }
}

/**
 * Compare stored identity and layout with an exact caller descriptor.
 * @param stored - Strictly parsed current-format unit.
 * @param descriptor - Expected identity and layout.
 * @returns nothing after successful validation.
 */
export function validateStoredDescriptor(stored: StoredJsonUnit, descriptor: KvUnitDescriptor): void {
  if (stored.version !== descriptor.version) {
    throw new StorageError(
      'version-mismatch',
      `unit '${descriptor.name}': stored version ${stored.version} != expected ${descriptor.version}`,
    )
  }
  const declared = [...descriptor.tables].sort()
  const actual = [...stored.state.tables.keys()].sort()
  if (stored.hasGlobal !== descriptor.hasGlobal
    || declared.length !== actual.length
    || declared.some((table, index) => table !== actual[index])) {
    throw malformed(descriptor.name, 'stored layout differs from its descriptor')
  }
}

/**
 * Validate a caller-supplied unit descriptor before filesystem access.
 * @param descriptor - Descriptor to validate.
 * @returns nothing after successful validation.
 */
export function validateDescriptor(descriptor: KvUnitDescriptor): void {
  validateUnitName(descriptor.name)
  if (!isKvUnitVersion(descriptor.version)) {
    throw malformed(descriptor.name, 'version must be a non-negative safe integer')
  }
  if (new Set(descriptor.tables).size !== descriptor.tables.length) {
    throw malformed(descriptor.name, 'descriptor repeats a table name')
  }
  for (const table of descriptor.tables) {
    if (!UNIT_NAME_RE.test(table)) {
      throw malformed(descriptor.name, `invalid table name '${table}'`)
    }
  }
}

/**
 * Validate a unit name before deriving its medium path.
 * @param name - Unit name to validate.
 * @returns nothing after successful validation.
 */
export function validateUnitName(name: string): void {
  if (!UNIT_NAME_RE.test(name)) throw malformed(name, 'invalid unit name')
}

/**
 * Convert internal stored state into a detached snapshot.
 * @param state - Parsed or materialized internal state.
 * @returns a detached snapshot with null-prototype record maps.
 */
export function snapshotOf(state: UnitState): KvUnitSnapshot {
  const tables: Record<string, Record<string, unknown>> = Object.create(null) as Record<
    string,
    Record<string, unknown>
  >
  for (const [table, records] of state.tables) {
    tables[table] = Object.assign(
      Object.create(null) as Record<string, unknown>,
      Object.fromEntries(records),
    )
  }
  return { tables, global: state.global }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactOwnKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === expected.length && expected.every(key => Object.hasOwn(value, key))
}

function malformed(name: string, detail: string, cause?: unknown): StorageError {
  return new StorageError(
    'malformed-medium',
    `unit '${name}': ${detail}`,
    cause === undefined ? undefined : { cause },
  )
}

/**
 * Serialize one per-record document: the unit's version stamp plus the
 * record value, pretty-printed like the whole-unit document.
 * @param version - Unit format version, stamped into the header.
 * @param value - The record value (or the global singleton value).
 * @returns pretty-printed JSON document with a trailing newline.
 */
export function serializeRecord(version: number, value: unknown): string {
  return `${JSON.stringify({ version, record: value }, null, 2)}\n`
}

/**
 * Parse one per-record document, validating its version stamp. A document
 * that is malformed or stamped with an unaccepted version is FOREIGN and
 * reads as absent — the per-record contract: one bad or stale record file
 * must not brick the whole unit, and an unaccepted version stamp discards the
 * record instead of migrating it (the whole-unit format rejects instead,
 * because there is exactly one document).
 * @param text - Raw per-record document content.
 * @param versions - Accepted unit versions (the current one plus the
 * descriptor's compatibleVersions); any other stamp discards the
 * document.
 * @returns the record value, or `undefined` for a foreign document.
 */
export function parseRecord(text: string, versions: readonly number[]): unknown {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof document !== 'object' || document === null) return undefined
  const { version: stamped, record } = document as Record<string, unknown>
  if (typeof stamped !== 'number' || !versions.includes(stamped)) return undefined
  return record
}
