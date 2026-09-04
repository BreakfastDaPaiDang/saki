import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import type { KvUnitSnapshot } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import {
  sakiControlPlaneV2DomainSpec,
  sakiControlPlaneV3DomainSpec,
  sakiControlPlaneV4DomainSpec,
  sakiStorageGenerationV1DomainSpec,
  sakiStorageGenerationV2DomainSpec,
  STORAGE_GENERATION_KEY,
  storageGenerationV1SealRecordSchema,
  storageGenerationV2SealRecordSchema,
  type SakiBuildId,
  type SakiInstallationId,
  type SakiStorageGenerationId,
} from '@breakfastdapaidang/saki-control-plane'
import {
  materializeFreshSakiGeneration,
  migrateSakiGeneration,
  readClosedProvisioningSakiState,
} from '../src/index.ts'
import { sakiStateHostExecutionMigrationPlan } from '../src/state-version.ts'

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'saki-generation-'))
  roots.push(value)
  return value
}

const identity = {
  installationId: 'installation-00000000-0000-4000-8000-000000000001' as SakiInstallationId,
  storageGenerationId: 'storage-generation-00000000-0000-4000-8000-000000000002' as SakiStorageGenerationId,
  createdByBuildId: 'saki-build-generation-test' as SakiBuildId,
}

describe('closed Saki generation creation', () => {
  it('materializes a fresh current candidate with an exact seal', async () => {
    const databasePath = join(await root(), 'state.sqlite')
    const signal = new AbortController().signal

    await materializeFreshSakiGeneration(databasePath, identity, signal)

    await expect(readClosedProvisioningSakiState(databasePath, { ...identity, stateVersion: 9 }, signal))
      .resolves.toMatchObject({ stateVersion: 9 })
  })

  it('migrates a different closed v2 database and materializes the current seal', async () => {
    const directory = await root()
    const sourcePath = join(directory, 'source.sqlite')
    const targetPath = join(directory, 'target.sqlite')
    const signal = new AbortController().signal
    const context = new Context()
    await context.plugin(Storage)
    const source = new SqliteStorageBackend({ path: sourcePath, journalMode: 'delete' })
    context.storage.backend.register('source', source)
    const facility = new DomainFacility(context, { backend: 'source' })
    await facility.materialize(sakiControlPlaneV2DomainSpec, {
      tables: Object.fromEntries(Object.keys(sakiControlPlaneV2DomainSpec.tables).map(table => [table, {}])),
      global: null,
    }, { targetBackend: 'source', signal })
    await source.close()
    await context.fiber.dispose()

    await migrateSakiGeneration(sourcePath, targetPath, identity, signal, undefined)

    await expect(readClosedProvisioningSakiState(targetPath, { ...identity, stateVersion: 9 }, signal))
      .resolves.toMatchObject({ stateVersion: 9 })
  })

  it('migrates an exact retained v3 generation into current v9 state', async () => {
    const directory = await root()
    const sourcePath = join(directory, 'source-v3.sqlite')
    const targetPath = join(directory, 'target-v9.sqlite')
    const signal = new AbortController().signal
    const context = new Context()
    await context.plugin(Storage)
    const source = new SqliteStorageBackend({ path: sourcePath, journalMode: 'delete' })
    context.storage.backend.register('source', source)
    const facility = new DomainFacility(context, { backend: 'source' })
    await facility.materialize(sakiControlPlaneV3DomainSpec, {
      tables: Object.fromEntries(Object.keys(sakiControlPlaneV3DomainSpec.tables).map(table => [table, {}])),
      global: null,
    }, { targetBackend: 'source', signal })
    await facility.materialize(sakiStorageGenerationV1DomainSpec, {
      tables: {
        storage_generation: {
          [STORAGE_GENERATION_KEY]: storageGenerationV1SealRecordSchema.parse({
            schemaVersion: 1,
            installationId: identity.installationId,
            storageGenerationId: identity.storageGenerationId,
            stateVersion: 3,
            createdByBuildId: identity.createdByBuildId,
          }),
        },
      },
      global: null,
    }, { targetBackend: 'source', signal })
    await source.close()
    await context.fiber.dispose()

    await migrateSakiGeneration(sourcePath, targetPath, identity, signal, undefined)

    const current = await readClosedProvisioningSakiState(targetPath, { ...identity, stateVersion: 9 }, signal)
    expect(current.stateVersion).toBe(9)
    expect(current.controlPlane.table('github_project_sync').size).toBe(0)
    expect(current.controlPlane.table('github_sync_configuration_intents').size).toBe(0)
    expect(current.controlPlane.table('git_operation_intents').size).toBe(0)
    expect(current.controlPlane.table('binding_write_admissions').size).toBe(0)
    expect(current.hostExecution.table('operations').size).toBe(0)
  })

  it('migrates an exact retained v4 generation into current v9 state', async () => {
    const directory = await root()
    const sourcePath = join(directory, 'source-v4.sqlite')
    const targetPath = join(directory, 'target-v9.sqlite')
    const signal = new AbortController().signal
    const context = new Context()
    await context.plugin(Storage)
    const source = new SqliteStorageBackend({ path: sourcePath, journalMode: 'delete' })
    context.storage.backend.register('source', source)
    const facility = new DomainFacility(context, { backend: 'source' })
    await facility.materialize(sakiControlPlaneV4DomainSpec, {
      tables: Object.fromEntries(Object.keys(sakiControlPlaneV4DomainSpec.tables).map(table => [table, {}])),
      global: null,
    }, { targetBackend: 'source', signal })
    await facility.materialize(sakiStorageGenerationV2DomainSpec, {
      tables: {
        storage_generation: {
          [STORAGE_GENERATION_KEY]: storageGenerationV2SealRecordSchema.parse({
            schemaVersion: 2,
            installationId: identity.installationId,
            storageGenerationId: identity.storageGenerationId,
            stateVersion: 4,
            createdByBuildId: identity.createdByBuildId,
          }),
        },
      },
      global: null,
    }, { targetBackend: 'source', signal })
    await source.close()
    await context.fiber.dispose()

    await migrateSakiGeneration(sourcePath, targetPath, identity, signal, undefined)

    const current = await readClosedProvisioningSakiState(targetPath, { ...identity, stateVersion: 9 }, signal)
    expect(current.stateVersion).toBe(9)
    expect(current.hostExecution.table('operations').size).toBe(0)
  })

  it('propagates a failed fresh materialization after closing its resources', async () => {
    const failure = new Error('materialization failed')
    vi.spyOn(DomainFacility.prototype, 'materialize').mockRejectedValueOnce(failure)

    await expect(materializeFreshSakiGeneration(
      join(await root(), 'state.sqlite'),
      identity,
      AbortSignal.timeout(2_000),
    )).rejects.toBe(failure)
  })

  it('propagates a lone cleanup failure after a successful materialization', async () => {
    const failure = new Error('facility cleanup failed')
    vi.spyOn(DomainFacility.prototype, 'closeAll').mockRejectedValueOnce(failure)

    await expect(materializeFreshSakiGeneration(
      join(await root(), 'state.sqlite'),
      identity,
      AbortSignal.timeout(2_000),
    )).rejects.toBe(failure)
  })

  it('retains both an operation failure and a cleanup failure', async () => {
    const operationFailure = new Error('materialization failed')
    const cleanupFailure = new Error('facility cleanup failed')
    vi.spyOn(DomainFacility.prototype, 'materialize').mockRejectedValueOnce(operationFailure)
    vi.spyOn(DomainFacility.prototype, 'closeAll').mockRejectedValueOnce(cleanupFailure)

    const result = materializeFreshSakiGeneration(
      join(await root(), 'state.sqlite'),
      identity,
      AbortSignal.timeout(2_000),
    )
    await expect(result).rejects.toBeInstanceOf(AggregateError)
    await expect(result).rejects.toMatchObject({ errors: [operationFailure, cleanupFailure] })
  })

  it('propagates a failed migration after closing both database backends', async () => {
    const directory = await root()
    const failure = new Error('migration failed')
    vi.spyOn(DomainFacility.prototype, 'migrate').mockRejectedValueOnce(failure)

    await expect(migrateSakiGeneration(
      join(directory, 'source.sqlite'),
      join(directory, 'target.sqlite'),
      identity,
      AbortSignal.timeout(2_000),
      undefined,
    )).rejects.toBe(failure)
  })

  it('selects the Host migration chain when an adjacent v5 snapshot is retained', async () => {
    const directory = await root()
    const retainedHostExecution: KvUnitSnapshot = {
      tables: { operations: { retained: { exact: 'provider-private-evidence' } } },
      global: null,
    }
    const migrate = vi.spyOn(DomainFacility.prototype, 'migrate').mockResolvedValue(undefined as never)
    vi.spyOn(DomainFacility.prototype, 'materialize').mockResolvedValue(undefined as never)
    const signal = AbortSignal.timeout(2_000)

    await migrateSakiGeneration(
      join(directory, 'source-v5.sqlite'),
      join(directory, 'target-v9.sqlite'),
      identity,
      signal,
      retainedHostExecution,
    )

    expect(migrate).toHaveBeenNthCalledWith(2, sakiStateHostExecutionMigrationPlan, {
      sourceBackend: 'source',
      targetBackend: 'candidate',
      signal,
    })
  })
})
