/**
 * Closed, source-preserving reads of complete Saki product state.
 * @module @breakfastdapaidang/saki-installation-maintenance/closed-state
 */

import type { KvClosedUnitInspection, KvUnitSnapshot } from '@deepseek-ai/dsh-storage'
import {
  descriptorOf,
  type Domain,
  type DomainSpec,
  type KvTable,
} from '@deepseek-ai/dsh-storage-domain'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import {
  sakiControlPlaneV2DomainSpec,
  sakiStateCapability,
  sakiStorageGenerationDomainSpec,
  STORAGE_GENERATION_KEY,
  storageGenerationSealRecordSchema,
  validateCurrentSakiState,
  type SakiBuildId,
  type SakiInstallationId,
  type SakiStorageGenerationId,
} from '@breakfastdapaidang/saki-control-plane'
import {
  assertSqliteArtifactSetUnchanged,
  captureSqliteArtifactSet,
  type SqliteArtifactSet,
} from './artifacts.ts'
import { SakiMaintenanceError } from './error.ts'

const currentControlSpec = sakiStateCapability.writable.controlPlane

/** Manifest-selected identities that a current generation must repeat in durable state. */
export interface ClosedCurrentSakiStateExpectation {
  /** Installation selected by installation.json and generation.json. */
  readonly installationId: SakiInstallationId
  /** Physical storage generation selected by installation.json and generation.json. */
  readonly storageGenerationId: SakiStorageGenerationId
  /** Build provenance recorded by generation.json. */
  readonly createdByBuildId: SakiBuildId
}

/** Manifest-selected identities required while a current generation is still provisioning. */
export interface ClosedProvisioningSakiStateExpectation extends ClosedCurrentSakiStateExpectation {
  /** Exact product-state version repeated by the storage-generation seal. */
  readonly stateVersion: number
}

/** Validated, detached current Saki state read from a closed SQLite generation. */
export interface ClosedCurrentSakiState {
  /** Current product-state version. */
  readonly stateVersion: 3
  /** Read-only facade over schema-validated `saki_control_plane@3` data. */
  readonly controlPlane: Domain<typeof currentControlSpec>
  /** Read-only facade over schema-validated `saki_storage_generation@1` data. */
  readonly storageGeneration: Domain<typeof sakiStorageGenerationDomainSpec>
  /** Detached, schema-validated control-plane data. */
  readonly controlPlaneSnapshot: KvUnitSnapshot
  /** Detached, schema-validated storage-generation seal data. */
  readonly storageGenerationSnapshot: KvUnitSnapshot
  /** Exact source evidence proved unchanged after reading and validation. */
  readonly sourceArtifacts: SqliteArtifactSet
}

/** Structurally valid current-format state whose product provisioning may be incomplete. */
export interface ClosedProvisioningSakiState {
  /** Current product-state version. */
  readonly stateVersion: 3
  /** Read-only facade over schema-valid, possibly incomplete `saki_control_plane@3` data. */
  readonly controlPlane: Domain<typeof currentControlSpec>
  /** Read-only facade over the exact selected `saki_storage_generation@1` seal. */
  readonly storageGeneration: Domain<typeof sakiStorageGenerationDomainSpec>
  /** Detached, schema-validated control-plane data. */
  readonly controlPlaneSnapshot: KvUnitSnapshot
  /** Detached, schema-validated storage-generation seal data. */
  readonly storageGenerationSnapshot: KvUnitSnapshot
  /** Exact source evidence proved unchanged after reading and seal validation. */
  readonly sourceArtifacts: SqliteArtifactSet
}

/** Structurally validated historical state retained for separate relationship validation and migration. */
export interface ClosedSakiV2State {
  /** Historical product-state version. */
  readonly stateVersion: 2
  /** Read-only facade over schema-validated exact `saki_control_plane@2` data. */
  readonly controlPlane: Domain<typeof sakiControlPlaneV2DomainSpec>
  /** Detached, schema-validated historical data suitable for the pure migration plan. */
  readonly controlPlaneSnapshot: KvUnitSnapshot
  /** Exact source evidence proved unchanged after reading. */
  readonly sourceArtifacts: SqliteArtifactSet
}

interface DetachedDomain<S extends DomainSpec> {
  readonly domain: Domain<S>
  readonly snapshot: KvUnitSnapshot
}

interface ClosedRead<T> {
  readonly value: T
  readonly sourceArtifacts: SqliteArtifactSet
}

/**
 * Read and validate exact current Saki domains through SQLite frozen private copies.
 * The source database and all extant sidecars must retain the same identities and bytes
 * throughout the operation. The returned Domain facades have no live backend handles and
 * reject every mutation method.
 * @param databasePath - manifest-selected real SQLite database path.
 * @param expected - identities and build provenance selected by trusted manifests.
 * @param signal - caller cancellation observed during capture and every closed read.
 * @returns detached current state after schema and product-relationship validation.
 */
export async function readClosedCurrentSakiState(
  databasePath: string,
  expected: ClosedCurrentSakiStateExpectation,
  signal: AbortSignal,
): Promise<ClosedCurrentSakiState> {
  const result = await withSourcePreservingBackend(databasePath, signal, async (backend) => {
    try {
      const { controlPlane, storageGeneration } = await readDetachedCurrentDomains(backend, signal)
      validateCurrentSakiState(
        controlPlane.domain,
        storageGeneration.domain,
        expected.installationId,
        expected.storageGenerationId,
        expected.createdByBuildId,
      )
      return {
        controlPlane: controlPlane.domain,
        storageGeneration: storageGeneration.domain,
        controlPlaneSnapshot: controlPlane.snapshot,
        storageGenerationSnapshot: storageGeneration.snapshot,
      }
    } catch (error) {
      preserveCancellation(signal, error)
      throw recoveryFailure('selected current Saki generation is missing, malformed, or inconsistent', error)
    }
  })
  return {
    stateVersion: 3,
    ...result.value,
    sourceArtifacts: result.sourceArtifacts,
  }
}

/**
 * Read a current-format generation that has not yet reached its ready commit point.
 * Both exact domains and every stored record are structurally validated through frozen
 * private SQLite copies. Only the required seal singleton is validated relationally, so an
 * empty control plane or schema-valid partial provisioning state remains recoverable by the
 * ordinary provisioning service. The operation never opens the selected path as a writer.
 * @param databasePath - provisioning manifest's selected real SQLite database path.
 * @param expected - identities, state version, and build provenance fixed before provisioning.
 * @param signal - caller cancellation observed during capture and every closed read.
 * @returns detached current-format provisioning state with read-only Domain facades.
 */
export async function readClosedProvisioningSakiState(
  databasePath: string,
  expected: ClosedProvisioningSakiStateExpectation,
  signal: AbortSignal,
): Promise<ClosedProvisioningSakiState> {
  const result = await withSourcePreservingBackend(databasePath, signal, async (backend) => {
    try {
      const { controlPlane, storageGeneration } = await readDetachedCurrentDomains(backend, signal)
      validateExpectedStorageGenerationSeal(storageGeneration.domain, expected)
      return {
        controlPlane: controlPlane.domain,
        storageGeneration: storageGeneration.domain,
        controlPlaneSnapshot: controlPlane.snapshot,
        storageGenerationSnapshot: storageGeneration.snapshot,
      }
    } catch (error) {
      preserveCancellation(signal, error)
      throw recoveryFailure('selected provisioning Saki generation is missing, malformed, or inconsistent', error)
    }
  })
  return {
    stateVersion: 3,
    ...result.value,
    sourceArtifacts: result.sourceArtifacts,
  }
}

/**
 * Read exact historical `saki_control_plane@2` data through SQLite frozen private copies.
 * This structural operation deliberately does not decide historical product relationships;
 * the caller supplies the returned facade to the dedicated v2 relationship validator before
 * migration. Any storage-generation seal makes the source an invalid v2/v3 hybrid.
 * @param databasePath - exact selected legacy or backup SQLite database path.
 * @param signal - caller cancellation observed during capture and every closed read.
 * @returns detached v2 state and a read-only Domain facade.
 */
export async function readClosedSakiV2State(
  databasePath: string,
  signal: AbortSignal,
): Promise<ClosedSakiV2State> {
  const result = await withSourcePreservingBackend(databasePath, signal, async (backend) => {
    try {
      const controlPlaneSnapshot = await readExactDomain(backend, sakiControlPlaneV2DomainSpec, signal)
      await assertDomainMissing(backend, sakiStorageGenerationDomainSpec.name, signal)
      const controlPlane = detachDomain(sakiControlPlaneV2DomainSpec, controlPlaneSnapshot)
      return {
        controlPlane: controlPlane.domain,
        controlPlaneSnapshot: controlPlane.snapshot,
      }
    } catch (error) {
      preserveCancellation(signal, error)
      throw recoveryFailure('selected historical Saki generation is missing, malformed, or hybrid', error)
    }
  })
  return {
    stateVersion: 2,
    ...result.value,
    sourceArtifacts: result.sourceArtifacts,
  }
}

async function readDetachedCurrentDomains(
  backend: SqliteStorageBackend,
  signal: AbortSignal,
): Promise<{
  readonly controlPlane: DetachedDomain<typeof currentControlSpec>
  readonly storageGeneration: DetachedDomain<typeof sakiStorageGenerationDomainSpec>
}> {
  const controlPlaneSnapshot = await readExactDomain(backend, currentControlSpec, signal)
  const storageGenerationSnapshot = await readExactDomain(
    backend,
    sakiStorageGenerationDomainSpec,
    signal,
  )
  return {
    controlPlane: detachDomain(currentControlSpec, controlPlaneSnapshot),
    storageGeneration: detachDomain(sakiStorageGenerationDomainSpec, storageGenerationSnapshot),
  }
}

async function withSourcePreservingBackend<T>(
  databasePath: string,
  signal: AbortSignal,
  operation: (backend: SqliteStorageBackend) => Promise<T>,
): Promise<ClosedRead<T>> {
  let sourceArtifacts: SqliteArtifactSet
  try {
    sourceArtifacts = await captureSqliteArtifactSet(databasePath, signal)
  } catch (error) {
    preserveCancellation(signal, error)
    throw recoveryFailure('selected Saki database is missing, malformed, or unreadable', error)
  }
  let backend: SqliteStorageBackend | undefined
  let outcome: { readonly status: 'fulfilled'; readonly value: T }
    | { readonly status: 'rejected'; readonly reason: unknown }
  try {
    signal.throwIfAborted()
    backend = new SqliteStorageBackend({ path: databasePath, journalMode: 'delete' })
    outcome = { status: 'fulfilled', value: await operation(backend) }
  } catch (error) {
    outcome = { status: 'rejected', reason: error }
  }
  const cleanupFailures: unknown[] = []
  if (backend !== undefined) {
    try {
      await backend.close()
    } catch (error) {
      cleanupFailures.push(error)
    }
  }
  try {
    await assertSqliteArtifactSetUnchanged(sourceArtifacts, new AbortController().signal)
  } catch (error) {
    cleanupFailures.push(error)
  }
  if (outcome.status === 'rejected') {
    if (cleanupFailures.length === 0) throw outcome.reason
    throw new AggregateError(
      [outcome.reason, ...cleanupFailures],
      'closed Saki state read, backend cleanup, and source verification failed',
    )
  }
  throwFailures(cleanupFailures, 'closed Saki state backend cleanup and source verification failed')
  return { value: outcome.value, sourceArtifacts }
}

async function readExactDomain(
  backend: SqliteStorageBackend,
  spec: DomainSpec,
  signal: AbortSignal,
): Promise<KvUnitSnapshot> {
  const closed = backend.kv.closed
  if (closed === undefined) throw new Error('SQLite backend does not provide closed-unit operations')
  const descriptor = descriptorOf(spec)
  return await closed.withReservedUnit(spec.name, signal, async (lease) => {
    const inspection = await lease.inspect()
    assertExactInspection(inspection, descriptor)
    return await lease.read(descriptor)
  })
}

async function assertDomainMissing(
  backend: SqliteStorageBackend,
  name: string,
  signal: AbortSignal,
): Promise<void> {
  const closed = backend.kv.closed
  if (closed === undefined) throw new Error('SQLite backend does not provide closed-unit operations')
  await closed.withReservedUnit(name, signal, async (lease) => {
    if (await lease.inspect() !== undefined) {
      throw new Error(`historical Saki state contains forbidden domain '${name}'`)
    }
  })
}

function assertExactInspection(
  inspection: KvClosedUnitInspection | undefined,
  expected: ReturnType<typeof descriptorOf>,
): void {
  if (inspection === undefined) throw new Error(`required Saki domain '${expected.name}' is missing`)
  const expectedTables = [...expected.tables].sort()
  if (inspection.name !== expected.name
    || inspection.version !== expected.version
    || inspection.hasGlobal !== expected.hasGlobal
    || inspection.tables.length !== expectedTables.length
    || inspection.tables.some((table, index) => table !== expectedTables[index])) {
    throw new Error(`stored Saki domain '${expected.name}' does not match its exact version and table set`)
  }
}

function detachDomain<S extends DomainSpec>(spec: S, source: KvUnitSnapshot): DetachedDomain<S> {
  const parsedTables: Record<string, Record<string, unknown>> = {}
  const handles = new Map<string, KvTable<string, unknown>>()
  for (const [tableName, tableSpec] of Object.entries(spec.tables)) {
    const parsedRecords: Record<string, unknown> = {}
    const sourceRecords = source.tables[tableName] as Record<string, unknown>
    for (const [key, value] of Object.entries(sourceRecords)) {
      parsedRecords[key] = tableSpec.valueSchema.parse(value)
    }
    parsedTables[tableName] = parsedRecords
    handles.set(tableName, readonlyTable(new Map(Object.entries(parsedRecords))))
  }
  const snapshot: KvUnitSnapshot = { tables: parsedTables, global: source.global }
  const facade = {
    name: spec.name,
    get global(): never {
      throw new Error(`domain '${spec.name}' declares no global`)
    },
    table: (name: string): KvTable<string, unknown> => {
      const table = handles.get(name)
      /* v8 ignore next -- Domain<S> admits only table keys declared by the exact parsed spec. */
      if (table === undefined) throw new Error(`domain '${spec.name}' declares no table '${name}'`)
      return table
    },
    close: () => Promise.resolve(),
  }
  return { domain: facade as unknown as Domain<S>, snapshot }
}

function validateExpectedStorageGenerationSeal(
  domain: Domain<typeof sakiStorageGenerationDomainSpec>,
  expected: ClosedProvisioningSakiStateExpectation,
): void {
  const entries = [...domain.table('storage_generation').entries()]
  if (entries.length !== 1 || entries[0]?.[0] !== STORAGE_GENERATION_KEY) {
    throw new Error('provisioning Saki storage-generation seal is not the required singleton')
  }
  const seal = storageGenerationSealRecordSchema.parse(entries[0][1])
  if (seal.installationId !== expected.installationId
    || seal.storageGenerationId !== expected.storageGenerationId
    || seal.stateVersion !== expected.stateVersion
    || seal.createdByBuildId !== expected.createdByBuildId) {
    throw new Error('provisioning Saki storage-generation seal disagrees with selected generation metadata')
  }
}

function readonlyTable(records: ReadonlyMap<string, unknown>): KvTable<string, unknown> {
  return {
    get: key => records.get(key),
    entries: () => [...records.entries()][Symbol.iterator](),
    keys: () => [...records.keys()][Symbol.iterator](),
    get size() { return records.size },
    put: () => rejectMutation(),
    delete: () => rejectMutation(),
    update: () => rejectMutation(),
  }
}

function rejectMutation<T>(): Promise<T> {
  return Promise.reject(new Error('closed Saki state facade is read-only'))
}

function recoveryFailure(message: string, cause: unknown): SakiMaintenanceError {
  if (cause instanceof SakiMaintenanceError) return cause
  return new SakiMaintenanceError('recovery-required', message, { cause: asError(cause) })
}

function preserveCancellation(signal: AbortSignal, error: unknown): void {
  if (signal.aborted && error === signal.reason) throw error
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function throwFailures(failures: readonly unknown[], message: string): void {
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, message)
}
