/** Closed creation of fresh and migrated Saki SQLite generations. */

import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import type { KvUnitSnapshot, StorageBackend } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { DomainSpec } from '@deepseek-ai/dsh-storage-domain'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import {
  createStorageGenerationSeal,
  sakiStorageGenerationDomainSpec,
  STORAGE_GENERATION_KEY,
} from '@breakfastdapaidang/saki-control-plane'
import type {
  SakiBuildId,
  SakiInstallationId,
  SakiStorageGenerationId,
} from '@breakfastdapaidang/saki-control-plane'
import {
  sakiStateCapability,
  sakiStateControlPlaneMigrationPlan,
  sakiStateHostExecutionMigrationPlan,
} from './state-version.ts'

/** Identity materialized in one new current Saki generation. */
export interface NewSakiGenerationIdentity {
  /** Stable product Installation retained across upgrades. */
  readonly installationId: SakiInstallationId
  /** Fresh physical generation identity. */
  readonly storageGenerationId: SakiStorageGenerationId
  /** Creator provenance recorded in the generation seal. */
  readonly createdByBuildId: SakiBuildId
}

function emptySnapshot(spec: DomainSpec): KvUnitSnapshot {
  return {
    tables: Object.fromEntries(Object.keys(spec.tables).map(table => [table, {}])),
    global: null,
  }
}

function sealSnapshot(identity: NewSakiGenerationIdentity): KvUnitSnapshot {
  return {
    tables: {
      storage_generation: {
        [STORAGE_GENERATION_KEY]: createStorageGenerationSeal(
          identity.installationId,
          identity.storageGenerationId,
          identity.createdByBuildId,
        ),
      },
    },
    global: null,
  }
}

async function closeResources(
  context: Context,
  facility: DomainFacility,
  backends: readonly StorageBackend[],
  operationFailure: unknown,
): Promise<void> {
  const outcomes = await Promise.allSettled([
    facility.closeAll(),
    ...backends.map(backend => backend.close()),
    context.fiber.dispose(),
  ])
  const failures: unknown[] = operationFailure === undefined ? [] : [operationFailure]
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') failures.push(outcome.reason as unknown)
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Saki generation operation and resource cleanup failed')
  }
}

async function materializeHostExecutionAndSeal(
  facility: DomainFacility,
  identity: NewSakiGenerationIdentity,
  signal: AbortSignal,
  retainedHostExecution?: KvUnitSnapshot,
): Promise<void> {
  const hostExecution = sakiStateCapability.writable.hostExecution
  if (retainedHostExecution === undefined) {
    await facility.materialize(
      hostExecution,
      emptySnapshot(hostExecution),
      { targetBackend: 'candidate', signal },
    )
  } else {
    await facility.migrate(sakiStateHostExecutionMigrationPlan, {
      sourceBackend: 'source',
      targetBackend: 'candidate',
      signal,
    })
  }
  await facility.materialize(
    sakiStorageGenerationDomainSpec,
    sealSnapshot(identity),
    { targetBackend: 'candidate', signal },
  )
}

/**
 * Materialize empty current control state and its required seal in a missing SQLite database.
 * @param databasePath - missing candidate `state.sqlite` path.
 * @param identity - Installation, generation, and build identities fixed before effects.
 * @param signal - cancellation through both create-only domain commits.
 */
export async function materializeFreshSakiGeneration(
  databasePath: string,
  identity: NewSakiGenerationIdentity,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  const context = new Context()
  await context.plugin(Storage)
  const target = new SqliteStorageBackend({ path: databasePath, journalMode: 'wal' })
  context.storage.backend.register('candidate', target)
  const facility = new DomainFacility(context, { backend: 'candidate' })
  let operationFailure: unknown
  try {
    const controlPlane = sakiStateCapability.writable.controlPlane
    await facility.materialize(
      controlPlane,
      emptySnapshot(controlPlane),
      { targetBackend: 'candidate', signal },
    )
    await materializeHostExecutionAndSeal(facility, identity, signal)
  } catch (error) {
    operationFailure = error
  }
  await closeResources(context, facility, [target], operationFailure)
}

/**
 * Migrate exact retained v2-v7 control state into a missing current SQLite database and add its seal.
 * Product relationships must be validated before this generic transformation is called and
 * are validated again against the complete current candidate by the outer operation.
 * @param sourceDatabasePath - exact closed retained source selected by manifest or legacy config.
 * @param targetDatabasePath - missing candidate `state.sqlite` path on different media.
 * @param identity - retained Installation plus fresh generation and build provenance.
 * @param signal - cancellation through migration and seal materialization.
 * @param retainedHostExecution - exact v5-v7 Host Operation snapshot, absent for pre-v5 sources.
 */
export async function migrateSakiGeneration(
  sourceDatabasePath: string,
  targetDatabasePath: string,
  identity: NewSakiGenerationIdentity,
  signal: AbortSignal,
  retainedHostExecution: KvUnitSnapshot | undefined,
): Promise<void> {
  signal.throwIfAborted()
  const context = new Context()
  await context.plugin(Storage)
  const source = new SqliteStorageBackend({ path: sourceDatabasePath, journalMode: 'delete' })
  const target = new SqliteStorageBackend({ path: targetDatabasePath, journalMode: 'wal' })
  context.storage.backend.register('source', source)
  context.storage.backend.register('candidate', target)
  const facility = new DomainFacility(context, { backend: 'source' })
  let operationFailure: unknown
  try {
    await facility.migrate(sakiStateControlPlaneMigrationPlan, {
      sourceBackend: 'source',
      targetBackend: 'candidate',
      signal,
    })
    await materializeHostExecutionAndSeal(facility, identity, signal, retainedHostExecution)
  } catch (error) {
    operationFailure = error
  }
  await closeResources(context, facility, [source, target], operationFailure)
}
