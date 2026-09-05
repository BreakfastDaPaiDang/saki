/**
 * Backend-facing vocabulary of the storage hub: a backend owns one medium
 * (a file-tree root, a database file) and exposes operation groups over it.
 * This module defines the normative contract text for backend implementers; the shared
 * conformance suite in `tests/contract.ts` checks every rule.
 * @module @deepseek-ai/dsh-storage/src/backend
 */

/** Allowed format for unit and table names: safe as a file name and as a SQL identifier segment without escaping. */
export const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/

/**
 * Test whether a value is a losslessly representable KV unit version.
 * @param value - Candidate version from a descriptor or stored header.
 * @returns `true` for non-negative safe integers other than negative zero.
 */
export function isKvUnitVersion(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && !Object.is(value, -0)
}

interface ClosedUnitReservation {
  readonly settled: Promise<void>
  readonly release: () => void
}

/** Tracks exclusive closed-unit reservations and their teardown settlement. */
export class ClosedUnitReservations {
  private readonly reservations = new Map<string, ClosedUnitReservation>()

  /**
   * Test whether one unit is currently reserved.
   * @param name - KV unit name.
   * @returns whether an unreleased reservation exists.
   */
  has(name: string): boolean {
    return this.reservations.has(name)
  }

  /**
   * Reserve one unit until the returned disposer runs.
   * @param name - KV unit name.
   * @returns idempotent release function for this reservation.
   */
  reserve(name: string): () => void {
    if (this.reservations.has(name)) throw new Error(`kv unit '${name}' is already reserved`)
    const completion = Promise.withResolvers<void>()
    const reservation: ClosedUnitReservation = {
      settled: completion.promise,
      release: () => {
        if (this.reservations.get(name) === reservation) this.reservations.delete(name)
        completion.resolve()
      },
    }
    this.reservations.set(name, reservation)
    return reservation.release
  }

  /**
   * Snapshot the settlements that backend teardown must await after closing admission.
   * @returns promises resolved by the currently held reservations.
   */
  settlements(): readonly Promise<void>[] {
    return [...this.reservations.values()].map(reservation => reservation.settled)
  }
}

/**
 * One registered backend. A backend owns exactly one medium and shares its
 * lifecycle across all facets; facets are optional members — a backend that
 * cannot serve a data kind simply omits it, and resolution fails loud instead.
 */
export interface StorageBackend {
  /** Key-value operations; absent when this backend cannot serve them. */
  readonly kv?: KvFacet

  /**
   * Reject new backend and live-unit work as soon as close begins, drain every
   * admitted live-unit operation and closed-unit callback plus every lease
   * method admitted before that callback settled, then release the medium.
   * Idempotent; concurrent and repeated calls resolve once teardown finishes.
   * @returns resolution after the medium is released.
   */
  close(): Promise<void>
}

/** The key-value data shape: whole-unit snapshots plus per-record durable writes. */
export interface KvFacet {
  /**
   * Operations over units that have no live handle. Optional because a
   * backend may support ordinary serving without supporting cold migration.
   */
  readonly closed?: KvClosedUnitOperations

  /**
   * Open one unit, creating it when the medium holds no trace of it yet
   * (materialization may defer to the first write, but {@link KvUnit.loadAll}
   * must immediately serve the empty shape). A version already stamped on the
   * medium that differs from `descriptor.version` rejects with
   * `version-mismatch`; a medium that cannot be parsed as this unit rejects
   * with `malformed-medium`. Opening the same unit name twice without closing
   * is a caller bug and rejects.
   * @param descriptor - Static identity and shape of the unit to open.
   * @returns the opened unit.
   */
  open(descriptor: KvUnitDescriptor): Promise<KvUnit>
}

/** Full detached contents of one KV unit. */
export interface KvUnitSnapshot {
  /** Records grouped by their declared table name and keyed by record id. */
  readonly tables: Record<string, Record<string, unknown>>
  /** Stored global singleton, or `null` when absent or never written. */
  readonly global: unknown
}

/** Stored identity discovered without opening or changing a KV unit. */
export interface KvClosedUnitInspection {
  /** Stored unit name. */
  readonly name: string
  /** Stored unit format version. */
  readonly version: number
  /** Whether the stored layout declares a global singleton slot. */
  readonly hasGlobal: boolean
  /** Actual stored table names in stable lexical order. */
  readonly tables: readonly string[]
}

/**
 * Optional entry point for reserving units that have no live handle. A scope
 * reserves the name synchronously before returning its promise and rejects
 * with `unit-open` instead of waiting. Once the scope observes callback
 * settlement it stops method admission; release waits for the callback and
 * every method admitted before that observation, including methods the
 * callback did not await.
 */
export interface KvClosedUnitOperations {
  /**
   * Run one sequence while exclusively reserving a unit name.
   * @param name - Valid unit name to reserve.
   * @param signal - Caller cancellation used by every pre-commit operation.
   * @param operation - Work admitted under the reservation.
   * @returns the callback result after its admitted methods drain and the reservation is released.
   */
  withReservedUnit<T>(
    name: string,
    signal: AbortSignal,
    operation: (lease: KvClosedUnitLease) => Promise<T>,
  ): Promise<T>
}

/**
 * One callback-scoped cold-unit lease. Methods operate only on {@link name};
 * once the scope observes callback settlement, new method calls reject with
 * `closed`, while methods admitted earlier retain the reservation until they finish.
 */
export interface KvClosedUnitLease {
  /** Reserved unit name. */
  readonly name: string

  /**
   * Inspect the reserved unit without creating, stamping, repairing, or
   * opening it.
   * @returns stored identity, or `undefined` when the unit does not exist.
   */
  inspect(): Promise<KvClosedUnitInspection | undefined>

  /**
   * Read a detached snapshot through an exact descriptor. Missing units
   * reject with `unit-not-found`; identity differences reject with the same
   * `version-mismatch` or `malformed-medium` classes as ordinary open.
   * @param descriptor - Exact stored identity and declared record layout.
   * @returns the complete detached snapshot.
   */
  read(descriptor: KvUnitDescriptor): Promise<KvUnitSnapshot>

  /**
   * Atomically create one missing unit from a complete detached snapshot.
   * Existing targets reject with `target-exists` and are never overwritten;
   * a failed call must not leave a unit that inspection reports as complete.
   * @param descriptor - Identity and layout to stamp on the new unit.
   * @param snapshot - Complete initial contents.
   * @returns a callback-scoped token carrying durable or uncertain commit evidence.
   */
  materializeMissing(
    descriptor: KvUnitDescriptor,
    snapshot: KvUnitSnapshot,
  ): Promise<KvClosedUnitMaterialization>
}

/**
 * Outcome of one create-only materialization protected by its originating
 * lease. An uncertain outcome does not claim that a target exists;
 * `readBack()` returns `undefined` only after confirming that it is absent.
 */
export type KvClosedUnitMaterialization =
  | {
    /** Commit durability was confirmed. */
    readonly outcome: 'durable'
    /** Read the published snapshot; rejects with `closed` after the callback settles. */
    readBack(): Promise<KvUnitSnapshot>
  }
  | {
    /** The backend cannot fully confirm publication and commit durability. */
    readonly outcome: 'uncertain'
    /** Failure that made the commit outcome uncertain. */
    readonly cause: Error
    /** Read the target, or return `undefined` after confirming that it is absent. */
    readBack(): Promise<KvUnitSnapshot | undefined>
  }

/** Static identity and shape of one KV unit, projected from its owner's spec. */
export interface KvUnitDescriptor {
  /** Unit name; must match {@link UNIT_NAME_RE}. Also the file-name / SQL-identifier segment. */
  readonly name: string
  /** Unit format version; a non-negative safe integer stamped on the medium at first materialization. */
  readonly version: number
  /** Table names; each must match {@link UNIT_NAME_RE}. */
  readonly tables: readonly string[]
  /** Whether this unit carries the global singleton slot. */
  readonly hasGlobal: boolean
  /**
   * Medium layout. `single` (the default) keeps the whole unit in one
   * document; `per-record` keeps each record in its own document, so a unit
   * whose records are large or sparse never rewrites the rest on one write,
   * and an unaccepted version stamp discards only that record instead of
   * rejecting the whole unit. Backends that only serve one layout accept the
   * other's units as foreign documents.
   */
  readonly layout?: 'single' | 'per-record'
  /**
   * Older unit versions whose stored records are also readable under the
   * declaring owner's current record schemas (the owner vouches for that —
   * typically by declaring the fields old records lack as optional). Reads of
   * a `per-record` unit accept documents stamped with any listed version, and
   * the legacy whole-unit bootstrap accepts a legacy file stamped with one;
   * writes always stamp {@link version}. `single`-layout reads stay
   * exact-version.
   */
  readonly compatibleVersions?: readonly number[]
}

/**
 * One opened unit. Values are opaque exact JSON data to this layer: no schema,
 * no events, no domain meaning. Backends reject values whose JSON encoding
 * would omit or coerce data, including `undefined`, non-finite numbers,
 * negative zero, sparse arrays, cycles, accessors, and exotic objects. The
 * unit borrows write inputs only for admission and retains detached JSON data;
 * {@link KvUnit.loadAll} likewise returns a fully detached value graph. The
 * unit does NOT serialize concurrent writes —
 * write ordering is the caller's responsibility (the domain layer runs one
 * write chain per unit); the unit only guarantees that each single call is
 * atomic on the medium and durable once resolved (a crash after resolution
 * followed by a re-open observes the write). A write may instead report
 * `durability-uncertain` when publication is known but durability is not, or
 * `commit-outcome-unknown` when publication itself cannot be determined;
 * callers then stop using the live unit, close it, discard and recreate the
 * affected backend (or restart), and only then reopen for recovery. Any call
 * after {@link close} rejects with `closed`.
 */
export interface KvUnit {
  /**
   * Read the full current snapshot.
   * @returns a fully detached value graph containing every table's records
   * keyed by table name and the global singleton (`null` when never written
   * or not declared).
   */
  loadAll(): Promise<KvUnitSnapshot>

  /**
   * Upsert one record durably. Overwrite semantics: an existing key is replaced.
   * @param table - Declared table name.
   * @param key - Record key. In the `per-record` layout a key becomes a path
   * segment and must match `[a-zA-Z0-9_-]+` (an unsafe key rejects); in the
   * `single` layout keys stay opaque.
   * @param value - Opaque exact JSON record; borrowed only until admission.
   * @returns resolution after durability.
   */
  putRecord(table: string, key: string, value: unknown): Promise<void>

  /**
   * Delete one record durably. Idempotent: a missing key is a no-op.
   * @param table - Declared table name.
   * @param key - Record key.
   * @returns resolution after durability.
   */
  deleteRecord(table: string, key: string): Promise<void>

  /**
   * Move one record's stored document out of the unit's readable set,
   * preserving its bytes for inspection instead of deleting them. Backends
   * whose medium has no per-record document to move (the `single` layout, a
   * row store) omit this member, and the caller falls back to its
   * reject-loud path. Absent after the move: a later {@link loadAll} reads
   * the key as missing and a later {@link putRecord} recreates it fresh.
   * @param table - Declared table name.
   * @param key - Record key.
   * @returns the medium location the document was moved to (diagnostics).
   */
  backupRecord?(table: string, key: string): Promise<string>

  /**
   * Write the global singleton durably. Only valid when the descriptor
   * declared `hasGlobal`.
   * @param value - Opaque exact JSON value; borrowed only until admission.
   * @returns resolution after durability.
   */
  setGlobal(value: unknown): Promise<void>

  /**
   * Reject new work, drain this unit's admitted operations, and release it. Idempotent.
   * @returns resolution after the unit is released.
   */
  close(): Promise<void>
}
