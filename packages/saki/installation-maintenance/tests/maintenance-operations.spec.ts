import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import {
  sakiControlPlaneMigrationPlan,
  sakiControlPlaneV3DomainSpec,
  sakiControlPlaneV4DomainSpec,
  sakiControlPlaneV5DomainSpec,
  sakiControlPlaneV6DomainSpec,
  sakiStorageGenerationV1DomainSpec,
  sakiStorageGenerationV2DomainSpec,
  sakiStorageGenerationV3DomainSpec,
  sakiStorageGenerationV4DomainSpec,
  STORAGE_GENERATION_KEY,
  storageGenerationV1SealRecordSchema,
  storageGenerationV2SealRecordSchema,
  storageGenerationV3SealRecordSchema,
  storageGenerationV4SealRecordSchema,
  type SakiBuildId,
} from '@breakfastdapaidang/saki-control-plane'
import { sakiHostExecutionV1DomainSpec } from '@breakfastdapaidang/saki-execution-local'
import {
  readActiveOperation,
  readClosedCurrentSakiState,
  readClosedSakiV2State,
  readInstallationManifest,
  backupSakiInstallation,
  createSakiMaintenanceOperations,
  generationManifestReference,
  LEGACY_B03_BUILD_ID,
  renderGenerationManifest,
  renderInstallationManifest,
  upgradeSakiInstallation,
  verifySakiInstallationBackup,
  withPreparedSakiServingState,
} from '../src/index.ts'
import type { SakiMaintenanceEffects, SakiMaintenanceOptions } from '../src/index.ts'
import {
  B03_INSTALLATION_ID,
  B03_RETIRED_INSTALLATION_ID,
  B03_REGISTRY_REVISION,
  B03_STORAGE_GENERATION_ID,
  b03Snapshot,
  writeB03Database,
} from './b03-fixture.ts'

const roots: string[] = []
const V3_SOURCE_BUILD_ID = 'saki-build-0.1.0-b18-test' as SakiBuildId
const V4_SOURCE_BUILD_ID = 'saki-build-0.1.0-b29-test' as SakiBuildId
const V5_SOURCE_BUILD_ID = 'saki-build-0.1.0-b05-test' as SakiBuildId
const V6_SOURCE_BUILD_ID = 'saki-build-0.1.0-b30-test' as SakiBuildId

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true })
  }))
})

async function fixture(): Promise<{ readonly options: SakiMaintenanceOptions; readonly legacy: string }> {
  const installationRoot = await mkdtemp(join(tmpdir(), 'saki-maintenance-operations-'))
  roots.push(installationRoot)
  const legacy = join(installationRoot, 'control.sqlite')
  writeB03Database(legacy)
  return {
    legacy,
    options: {
      installationRoot,
      legacyDatabasePath: legacy,
      currentBuildId: 'saki-build-0.1.0-b05-test' as SakiBuildId,
      legacyBuildId: LEGACY_B03_BUILD_ID,
    },
  }
}

async function publishSelectedHistorical(
  options: SakiMaintenanceOptions,
  stateVersion: 3 | 4 | 5 | 6,
): Promise<string> {
  const signal = new AbortController().signal
  const sourceBuildId = stateVersion === 3
    ? V3_SOURCE_BUILD_ID
    : stateVersion === 4
      ? V4_SOURCE_BUILD_ID
      : stateVersion === 5 ? V5_SOURCE_BUILD_ID : V6_SOURCE_BUILD_ID
  const historical = await readClosedSakiV2State(options.legacyDatabasePath, signal)
  const v3Snapshot = sakiControlPlaneMigrationPlan.steps[0]!.migrate(
    historical.controlPlaneSnapshot,
  )
  const directory = resolve(
    options.installationRoot,
    'generations',
    B03_STORAGE_GENERATION_ID,
  )
  await mkdir(directory, { recursive: true })
  const databasePath = join(directory, 'state.sqlite')
  const context = new Context()
  await context.plugin(Storage)
  const backend = new SqliteStorageBackend({ path: databasePath, journalMode: 'delete' })
  const sourceBackend = `source-v${stateVersion}`
  context.storage.backend.register(sourceBackend, backend)
  const facility = new DomainFacility(context, { backend: sourceBackend })
  try {
    if (stateVersion === 3) {
      await facility.materialize(
        sakiControlPlaneV3DomainSpec,
        v3Snapshot,
        { targetBackend: sourceBackend, signal },
      )
      await facility.materialize(
        sakiStorageGenerationV1DomainSpec,
        {
          tables: {
            storage_generation: {
              [STORAGE_GENERATION_KEY]: storageGenerationV1SealRecordSchema.parse({
                schemaVersion: 1,
                installationId: B03_INSTALLATION_ID,
                storageGenerationId: B03_STORAGE_GENERATION_ID,
                stateVersion,
                createdByBuildId: sourceBuildId,
              }),
            },
          },
          global: null,
        },
        { targetBackend: sourceBackend, signal },
      )
    } else if (stateVersion === 4) {
      await facility.materialize(
        sakiControlPlaneV4DomainSpec,
        sakiControlPlaneMigrationPlan.steps[1]!.migrate(v3Snapshot),
        { targetBackend: sourceBackend, signal },
      )
      await facility.materialize(
        sakiStorageGenerationV2DomainSpec,
        {
          tables: {
            storage_generation: {
              [STORAGE_GENERATION_KEY]: storageGenerationV2SealRecordSchema.parse({
                schemaVersion: 2,
                installationId: B03_INSTALLATION_ID,
                storageGenerationId: B03_STORAGE_GENERATION_ID,
                stateVersion,
                createdByBuildId: sourceBuildId,
              }),
            },
          },
          global: null,
        },
        { targetBackend: sourceBackend, signal },
      )
    } else if (stateVersion === 5) {
      const v4Snapshot = sakiControlPlaneMigrationPlan.steps[1]!.migrate(v3Snapshot)
      await facility.materialize(
        sakiControlPlaneV5DomainSpec,
        sakiControlPlaneMigrationPlan.steps[2]!.migrate(v4Snapshot),
        { targetBackend: sourceBackend, signal },
      )
      await facility.materialize(
        sakiHostExecutionV1DomainSpec,
        { tables: { operations: {} }, global: null },
        { targetBackend: sourceBackend, signal },
      )
      await facility.materialize(
        sakiStorageGenerationV3DomainSpec,
        {
          tables: {
            storage_generation: {
              [STORAGE_GENERATION_KEY]: storageGenerationV3SealRecordSchema.parse({
                schemaVersion: 3,
                installationId: B03_INSTALLATION_ID,
                storageGenerationId: B03_STORAGE_GENERATION_ID,
                stateVersion,
                createdByBuildId: sourceBuildId,
              }),
            },
          },
          global: null,
        },
        { targetBackend: sourceBackend, signal },
      )
    } else {
      const v4Snapshot = sakiControlPlaneMigrationPlan.steps[1]!.migrate(v3Snapshot)
      const v5Snapshot = sakiControlPlaneMigrationPlan.steps[2]!.migrate(v4Snapshot)
      await facility.materialize(
        sakiControlPlaneV6DomainSpec,
        sakiControlPlaneMigrationPlan.steps[3]!.migrate(v5Snapshot),
        { targetBackend: sourceBackend, signal },
      )
      await facility.materialize(
        sakiHostExecutionV1DomainSpec,
        { tables: { operations: {} }, global: null },
        { targetBackend: sourceBackend, signal },
      )
      await facility.materialize(
        sakiStorageGenerationV4DomainSpec,
        {
          tables: {
            storage_generation: {
              [STORAGE_GENERATION_KEY]: storageGenerationV4SealRecordSchema.parse({
                schemaVersion: 4,
                installationId: B03_INSTALLATION_ID,
                storageGenerationId: B03_STORAGE_GENERATION_ID,
                stateVersion,
                createdByBuildId: sourceBuildId,
              }),
            },
          },
          global: null,
        },
        { targetBackend: sourceBackend, signal },
      )
    }
  } finally {
    await facility.closeAll()
    await backend.close()
    await context.fiber.dispose()
  }
  const generationBytes = renderGenerationManifest(
    B03_INSTALLATION_ID,
    B03_STORAGE_GENERATION_ID,
    stateVersion,
    sourceBuildId,
  )
  await writeFile(join(directory, 'generation.json'), generationBytes)
  const generation = JSON.parse(generationBytes.toString('utf8')) as Parameters<
    typeof renderInstallationManifest
  >[1]
  await writeFile(
    join(options.installationRoot, 'installation.json'),
    renderInstallationManifest(
      'ready',
      generation,
      generationManifestReference(B03_STORAGE_GENERATION_ID, generationBytes),
    ),
  )
  return databasePath
}

async function publishSelectedV3(options: SakiMaintenanceOptions): Promise<string> {
  return await publishSelectedHistorical(options, 3)
}

async function publishSelectedV4(options: SakiMaintenanceOptions): Promise<string> {
  return await publishSelectedHistorical(options, 4)
}

async function publishSelectedV5(options: SakiMaintenanceOptions): Promise<string> {
  return await publishSelectedHistorical(options, 5)
}

async function publishSelectedV6(options: SakiMaintenanceOptions): Promise<string> {
  return await publishSelectedHistorical(options, 6)
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return false
    throw error
  }
}

async function publishSelectedB03(
  options: SakiMaintenanceOptions,
  phase: 'provisioning' | 'ready' = 'ready',
  stateVersion = 2,
): Promise<string> {
  const directory = resolve(
    options.installationRoot,
    'generations',
    B03_STORAGE_GENERATION_ID,
  )
  await mkdir(directory, { recursive: true })
  const databasePath = join(directory, 'state.sqlite')
  writeB03Database(databasePath)
  const generationBytes = renderGenerationManifest(
    B03_INSTALLATION_ID,
    B03_STORAGE_GENERATION_ID,
    stateVersion,
    options.legacyBuildId,
  )
  await writeFile(join(directory, 'generation.json'), generationBytes)
  const generation = JSON.parse(generationBytes.toString('utf8')) as Parameters<
    typeof renderInstallationManifest
  >[1]
  await writeFile(
    join(options.installationRoot, 'installation.json'),
    renderInstallationManifest(
      phase,
      generation,
      generationManifestReference(B03_STORAGE_GENERATION_ID, generationBytes),
    ),
  )
  return databasePath
}

async function rewriteAuthorityPhase(
  installationRoot: string,
  phase: 'provisioning' | 'ready',
): Promise<void> {
  const signal = new AbortController().signal
  const authority = await readInstallationManifest(installationRoot, signal)
  if (authority === undefined) throw new Error('test Installation authority is missing')
  const generationBytes = await readFile(resolve(
    installationRoot,
    ...authority.value.generationJson.leaf.split('/'),
  ))
  const generation = JSON.parse(generationBytes.toString('utf8')) as Parameters<
    typeof renderInstallationManifest
  >[1]
  await writeFile(
    join(installationRoot, 'installation.json'),
    renderInstallationManifest(phase, generation, authority.value.generationJson),
  )
}

async function publishActiveCandidateAuthority(
  installationRoot: string,
  signal: AbortSignal,
): Promise<void> {
  const active = await readActiveOperation(installationRoot, signal)
  if (active?.journal.kind !== 'upgrade') throw new Error('active candidate journal is missing')
  const generationBytes = await readFile(resolve(
    installationRoot,
    'generations',
    active.journal.candidateStorageGenerationId,
    'generation.json',
  ))
  const generation = JSON.parse(generationBytes.toString('utf8')) as Parameters<
    typeof renderInstallationManifest
  >[1]
  await writeFile(
    join(installationRoot, 'installation.json'),
    renderInstallationManifest(
      'ready',
      generation,
      generationManifestReference(active.journal.candidateStorageGenerationId, generationBytes),
    ),
  )
}

const PRE_MANIFEST_CRASH_PHASES = [
  'afterJournalPublication',
  'afterBackupVerification',
  'afterCandidatePartialCreation',
  'afterCandidateMaterialization',
  'afterCandidateManifestPublication',
  'afterCandidatePublication',
  'afterCandidateValidation',
  'beforeManifestPublication',
] as const satisfies readonly (keyof SakiMaintenanceEffects)[]

describe('offline Saki Installation operations', () => {
  it('upgrades an exact physical-v1 B03 database with a registered Project and reopenable backup', async () => {
    const { options, legacy } = await fixture()
    const before = await readFile(legacy)
    const signal = new AbortController().signal

    const result = await upgradeSakiInstallation(options, signal)

    expect(result).toMatchObject({ sourceVersion: 2, targetVersion: 7 })
    expect(await readFile(legacy)).toEqual(before)
    expect(result.selected.installation).toMatchObject({
      phase: 'ready',
      installationId: B03_INSTALLATION_ID,
      stateVersion: 7,
    })
    const current = await readClosedCurrentSakiState(
      result.selected.databasePath,
      {
        installationId: result.selected.generation.installationId,
        storageGenerationId: result.selected.generation.storageGenerationId,
        createdByBuildId: result.selected.generation.createdByBuildId,
      },
      signal,
    )
    const registry = current.controlPlane.table('development_project_registry')
      .get('development-project-registry')
    if (registry === undefined) throw new Error('migrated Registry is missing')
    expect(registry).toMatchObject({
      revision: B03_REGISTRY_REVISION,
      projects: [{ state: 'active', projectTitle: 'Fixture project' }],
      resourceBindings: [{ health: 'active' }],
      intentMappings: [{ registryRevision: B03_REGISTRY_REVISION }],
    })
    const project = registry.projects[0]
    const binding = registry.resourceBindings[0]
    const mapping = registry.intentMappings[0]
    if (project === undefined || binding === undefined || mapping === undefined) {
      throw new Error('migrated registered Project aggregate is incomplete')
    }
    expect(project.resourceBindingId).toBe(binding.id)
    expect(binding.projectId).toBe(project.id)
    expect(mapping).toMatchObject({ projectId: project.id, resourceBindingId: binding.id })
    expect(current.controlPlane.table('registration_intents').get(mapping.intentId)).toMatchObject({
      phase: 'confirmed',
      projectId: project.id,
      resourceBindingId: binding.id,
      payload: { actor: { storageGenerationId: B03_STORAGE_GENERATION_ID } },
    })
    const access = [...current.controlPlane.table('installation_access').entries()][0]?.[1]
    expect(access).toMatchObject({
      challenges: [{
        storageGenerationId: B03_STORAGE_GENERATION_ID,
        browserSessionId: 'access-00000000-0000-4000-8000-000000000005:session:0',
      }],
      sessions: [{ storageGenerationId: B03_STORAGE_GENERATION_ID }],
    })
    expect(current.controlPlane.table('installations').get(B03_RETIRED_INSTALLATION_ID))
      .toMatchObject({ state: 'retired' })
    const verifiedBackup = await verifySakiInstallationBackup(
      options,
      result.backup.manifest.backupId,
      signal,
    )
    expect(verifiedBackup).toMatchObject({
      manifest: {
        installationId: B03_INSTALLATION_ID,
        stateVersion: 2,
        sourceBuildId: options.legacyBuildId,
      },
    })
    const reopenedBackup = await readClosedSakiV2State(verifiedBackup.databasePath, signal)
    expect(reopenedBackup.controlPlane.table('development_project_registry')
      .get('development-project-registry')).toEqual(
      b03Snapshot().tables.development_project_registry?.['development-project-registry'],
    )
    await expect(readActiveOperation(options.installationRoot, signal)).resolves.toBeUndefined()
    await expect(readInstallationManifest(options.installationRoot, signal)).resolves.toMatchObject({
      value: { phase: 'ready', stateVersion: 7 },
    })

    const currentBackup = await backupSakiInstallation(options, signal)
    expect(currentBackup.manifest).toMatchObject({
      installationId: B03_INSTALLATION_ID,
      stateVersion: 7,
      sourceBuildId: options.currentBuildId,
    })
    await expect(upgradeSakiInstallation(options, signal)).rejects.toMatchObject({
      code: 'state-unsupported',
      message: 'selected Saki state is already current',
    })
  }, 20_000)

  it('creates and clears an explicit Recovery Backup for manifest-less B03 state', async () => {
    const { options } = await fixture()
    const signal = new AbortController().signal

    const backup = await backupSakiInstallation(options, signal)

    expect(backup.manifest).toMatchObject({
      installationId: B03_INSTALLATION_ID,
      storageGenerationId: B03_STORAGE_GENERATION_ID,
      stateVersion: 2,
      sourceBuildId: options.legacyBuildId,
    })
    await expect(readActiveOperation(options.installationRoot, signal)).resolves.toBeUndefined()
  })

  it('rejects invalid maintenance options before taking the Installation lease', async () => {
    const { options } = await fixture()
    const signal = new AbortController().signal

    await expect(backupSakiInstallation({
      ...options,
      installationRoot: ':memory:',
    }, signal)).rejects.toThrow('Saki Installation root must be an absolute filesystem path')
    await expect(backupSakiInstallation({
      ...options,
      legacyDatabasePath: 'control.sqlite',
    }, signal)).rejects.toThrow('legacy Saki database path must be an absolute filesystem path')
    await expect(backupSakiInstallation({
      ...options,
      legacyBuildId: 'saki-build-not-b03' as SakiBuildId,
    }, signal)).rejects.toThrow(`legacy Saki build provenance must be '${LEGACY_B03_BUILD_ID}'`)
  })

  it('rejects maintenance when neither an Installation manifest nor B03 source exists', async () => {
    const { options, legacy } = await fixture()
    await rm(legacy)

    await expect(backupSakiInstallation(
      options,
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: 'state-unsupported',
      message: 'fresh Saki state has nothing to maintain',
    })
  })

  it('upgrades a manifest-selected exact v2 generation without mutating it', async () => {
    const { options } = await fixture()
    const selectedDatabasePath = await publishSelectedB03(options)
    const before = await readFile(selectedDatabasePath)

    const result = await upgradeSakiInstallation(options, new AbortController().signal)

    expect(result).toMatchObject({ sourceVersion: 2, targetVersion: 7 })
    expect(result.backup.manifest).toMatchObject({
      stateVersion: 2,
      sourceBuildId: options.legacyBuildId,
    })
    expect(await readFile(selectedDatabasePath)).toEqual(before)
    await expect(readInstallationManifest(
      options.installationRoot,
      new AbortController().signal,
    )).resolves.toMatchObject({ value: { phase: 'ready', stateVersion: 7 } })
  })

  it('upgrades a manifest-selected exact v3 generation without mutating it', async () => {
    const { options } = await fixture()
    const selectedDatabasePath = await publishSelectedV3(options)
    const before = await readFile(selectedDatabasePath)
    const signal = new AbortController().signal

    const result = await upgradeSakiInstallation(options, signal)

    expect(result).toMatchObject({ sourceVersion: 3, targetVersion: 7 })
    expect(result.backup.manifest).toMatchObject({
      installationId: B03_INSTALLATION_ID,
      storageGenerationId: B03_STORAGE_GENERATION_ID,
      stateVersion: 3,
      sourceBuildId: V3_SOURCE_BUILD_ID,
    })
    expect(await readFile(selectedDatabasePath)).toEqual(before)
    const current = await readClosedCurrentSakiState(
      result.selected.databasePath,
      {
        installationId: result.selected.generation.installationId,
        storageGenerationId: result.selected.generation.storageGenerationId,
        createdByBuildId: result.selected.generation.createdByBuildId,
      },
      signal,
    )
    expect(current.controlPlane.table('github_project_sync').size).toBe(0)
    expect(current.controlPlane.table('github_sync_configuration_intents').size).toBe(0)
    await expect(readActiveOperation(options.installationRoot, signal)).resolves.toBeUndefined()
  })

  it('upgrades a nonempty manifest-selected v4 generation and derives current write admission', async () => {
    const { options } = await fixture()
    const selectedDatabasePath = await publishSelectedV4(options)
    const before = await readFile(selectedDatabasePath)
    const signal = new AbortController().signal

    const result = await upgradeSakiInstallation(options, signal)

    expect(result).toMatchObject({ sourceVersion: 4, targetVersion: 7 })
    expect(result.backup.manifest).toMatchObject({
      installationId: B03_INSTALLATION_ID,
      storageGenerationId: B03_STORAGE_GENERATION_ID,
      stateVersion: 4,
      sourceBuildId: V4_SOURCE_BUILD_ID,
    })
    expect(await readFile(selectedDatabasePath)).toEqual(before)
    await expect(readInstallationManifest(options.installationRoot, signal)).resolves.toMatchObject({
      value: { phase: 'ready', stateVersion: 7 },
    })
    await expect(readActiveOperation(options.installationRoot, signal)).resolves.toBeUndefined()

    const current = await readClosedCurrentSakiState(
      result.selected.databasePath,
      {
        installationId: result.selected.generation.installationId,
        storageGenerationId: result.selected.generation.storageGenerationId,
        createdByBuildId: result.selected.generation.createdByBuildId,
      },
      signal,
    )
    const registry = current.controlPlane.table('development_project_registry')
      .get('development-project-registry')
    if (registry === undefined) throw new Error('migrated v7 Registry is missing')
    const project = registry.projects[0]
    const binding = registry.resourceBindings[0]
    const mapping = registry.intentMappings[0]
    if (project === undefined || binding === undefined || mapping === undefined) {
      throw new Error('migrated v7 registered Project aggregate is incomplete')
    }
    expect(project.resourceBindingId).toBe(binding.id)
    expect(binding.projectId).toBe(project.id)
    expect(mapping).toMatchObject({ projectId: project.id, resourceBindingId: binding.id })
    const registration = current.controlPlane.table('registration_intents').get(mapping.intentId)
    expect(registration).toMatchObject({
      phase: 'confirmed',
      projectId: project.id,
      resourceBindingId: binding.id,
    })
    expect(current.controlPlane.table('binding_write_admissions').get(binding.id)).toEqual({
      id: binding.id,
      schemaVersion: 1,
      revision: 0,
      state: 'available',
      updatedAt: binding.observedAt,
    })
    if (registration === undefined) throw new Error('migrated v7 registration Intent is missing')
    expect(current.controlPlane.table('grants').get(registration.payload.actor.grantId)?.actions)
      .toEqual(expect.arrayContaining([
        'project-changes:read',
        'project-diff:read',
        'project-changes:stage',
        'project-changes:unstage',
        'project-commit:create',
      ]))
  })

  it('upgrades an exact v5 generation into reopenable v7 state without mutating the source', async () => {
    const { options } = await fixture()
    const selectedDatabasePath = await publishSelectedV5(options)
    const before = await readFile(selectedDatabasePath)
    const signal = new AbortController().signal

    const result = await upgradeSakiInstallation(options, signal)

    expect(result).toMatchObject({ sourceVersion: 5, targetVersion: 7 })
    expect(result.backup.manifest).toMatchObject({
      installationId: B03_INSTALLATION_ID,
      storageGenerationId: B03_STORAGE_GENERATION_ID,
      stateVersion: 5,
      sourceBuildId: V5_SOURCE_BUILD_ID,
    })
    expect(await readFile(selectedDatabasePath)).toEqual(before)
    const current = await readClosedCurrentSakiState(
      result.selected.databasePath,
      {
        installationId: result.selected.generation.installationId,
        storageGenerationId: result.selected.generation.storageGenerationId,
        createdByBuildId: result.selected.generation.createdByBuildId,
      },
      signal,
    )
    expect(current.controlPlane.table('github_work_item_intents').size).toBe(0)
    expect(current.controlPlane.table('github_work_item_recovery').size).toBe(0)
    expect(current.hostExecution.table('operations').size).toBe(0)
    expect([...current.controlPlane.table('grants').entries()][0]?.[1].actions).toEqual(
      expect.arrayContaining(['work-item:create', 'work-item:move']),
    )
  })

  it('upgrades an exact v6 generation with an unavailable default Agent Profile', async () => {
    const { options } = await fixture()
    const selectedDatabasePath = await publishSelectedV6(options)
    const before = await readFile(selectedDatabasePath)
    const signal = new AbortController().signal

    const result = await upgradeSakiInstallation(options, signal)

    expect(result).toMatchObject({ sourceVersion: 6, targetVersion: 7 })
    expect(result.backup.manifest).toMatchObject({
      installationId: B03_INSTALLATION_ID,
      storageGenerationId: B03_STORAGE_GENERATION_ID,
      stateVersion: 6,
      sourceBuildId: V6_SOURCE_BUILD_ID,
    })
    expect(await readFile(selectedDatabasePath)).toEqual(before)
    const current = await readClosedCurrentSakiState(
      result.selected.databasePath,
      {
        installationId: result.selected.generation.installationId,
        storageGenerationId: result.selected.generation.storageGenerationId,
        createdByBuildId: result.selected.generation.createdByBuildId,
      },
      signal,
    )
    const registry = current.controlPlane.table('development_project_registry')
      .get('development-project-registry')
    if (registry === undefined) throw new Error('migrated v7 Registry is missing')
    const project = registry.projects[0]
    if (project === undefined) throw new Error('migrated v7 Project is missing')
    expect(registry.agentProfiles).toContainEqual({
      id: project.defaultAgentProfileId,
      projectId: project.id,
      version: 1,
      agentPresetId: 'standard',
      modelRouteRequest: null,
      createdAt: project.createdAt,
    })
    expect([...current.controlPlane.table('grants').entries()][0]?.[1].actions).toContain(
      'work-item:give-to-agent',
    )
    expect(current.hostExecution.table('operations').size).toBe(0)
  })

  it('requires a ready selected Installation before offline maintenance', async () => {
    const { options } = await fixture()
    await publishSelectedB03(options, 'provisioning')

    await expect(backupSakiInstallation(
      options,
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: 'recovery-required',
      message: 'offline maintenance requires a ready Installation; finish provisioning first',
    })
  })

  it('rejects a selected state version that this build cannot read', async () => {
    const { options } = await fixture()
    await publishSelectedB03(options, 'ready', 99)

    await expect(backupSakiInstallation(
      options,
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: 'state-unsupported',
      message: 'Saki state version 99 is not readable by this build',
    })
  })

  it('rejects an Installation authority that appears during a manifest-less upgrade', async () => {
    const { options } = await fixture()
    const signal = new AbortController().signal
    const operations = createSakiMaintenanceOperations({
      beforeManifestPublication: async () => {
        await publishActiveCandidateAuthority(options.installationRoot, signal)
      },
    })

    await expect(operations.upgrade(options, signal)).rejects.toMatchObject({
      code: 'recovery-required',
      message: 'Installation authority appeared during legacy upgrade',
    })
  })

  it.each(['removed', 'changed'] as const)(
    'rejects a selected source authority that is %s during upgrade',
    async (change) => {
      const { options } = await fixture()
      await publishSelectedB03(options)
      const operations = createSakiMaintenanceOperations({
        beforeManifestPublication: async () => {
          if (change === 'removed') {
            await rm(join(options.installationRoot, 'installation.json'))
          } else {
            await rewriteAuthorityPhase(options.installationRoot, 'provisioning')
          }
        },
      })

      await expect(operations.upgrade(
        options,
        new AbortController().signal,
      )).rejects.toMatchObject({
        code: 'recovery-required',
        message: 'source Installation authority changed during upgrade',
      })
    },
  )

  it.each(['removed', 'changed'] as const)(
    'rejects upgraded Installation authority readback when it is %s',
    async (change) => {
      const { options } = await fixture()
      const operations = createSakiMaintenanceOperations({
        afterManifestPublication: async () => {
          if (change === 'removed') {
            await rm(join(options.installationRoot, 'installation.json'))
          } else {
            await rewriteAuthorityPhase(options.installationRoot, 'provisioning')
          }
        },
      })

      await expect(operations.upgrade(
        options,
        new AbortController().signal,
      )).rejects.toMatchObject({
        code: 'recovery-required',
        message: 'upgraded Installation authority changed before operation cleanup',
      })
    },
  )

  it.each(PRE_MANIFEST_CRASH_PHASES)(
    'reopens only the unchanged B03 source after a crash at %s',
    async (phase) => {
      const { options, legacy } = await fixture()
      const before = await readFile(legacy)
      const crash = new Error(`crash at ${phase}`)
      const operations = createSakiMaintenanceOperations({
        [phase]: async () => { throw crash },
      })
      const signal = new AbortController().signal

      await expect(operations.upgrade(options, signal)).rejects.toBe(crash)
      const active = await readActiveOperation(options.installationRoot, signal)
      if (active?.journal.kind !== 'upgrade') throw new Error('crashed upgrade journal is not selected')

      let served = false
      await expect(withPreparedSakiServingState({
        installationRoot: options.installationRoot,
        legacyDatabasePath: options.legacyDatabasePath,
        currentBuildId: options.currentBuildId,
      }, signal, async () => {
        served = true
      })).rejects.toMatchObject({ code: 'upgrade-required' })

      expect(served).toBe(false)
      expect(await readFile(legacy)).toEqual(before)
      await expect(readInstallationManifest(options.installationRoot, signal)).resolves.toBeUndefined()
      await expect(readActiveOperation(options.installationRoot, signal)).resolves.toBeUndefined()
      for (const leaf of [
        active.journal.backup.partialLeaf,
        active.journal.backup.finalLeaf,
        active.journal.candidate.partialLeaf,
        active.journal.candidate.finalLeaf,
      ]) {
        expect(await exists(resolve(options.installationRoot, ...leaf.split('/')))).toBe(false)
      }
    },
  )

  it('reopens only the new generation after a crash immediately after manifest publication', async () => {
    const { options, legacy } = await fixture()
    const before = await readFile(legacy)
    const crash = new Error('crash after manifest publication')
    const operations = createSakiMaintenanceOperations({
      afterManifestPublication: async () => { throw crash },
    })
    const signal = new AbortController().signal

    await expect(operations.upgrade(options, signal)).rejects.toBe(crash)
    const active = await readActiveOperation(options.installationRoot, signal)
    if (active?.journal.kind !== 'upgrade') throw new Error('committed upgrade journal is not selected')
    const candidateStorageGenerationId = active.journal.candidateStorageGenerationId

    await withPreparedSakiServingState({
      installationRoot: options.installationRoot,
      legacyDatabasePath: options.legacyDatabasePath,
      currentBuildId: options.currentBuildId,
    }, signal, async (prepared) => {
      expect(prepared).toMatchObject({
        phase: 'ready',
        installationId: B03_INSTALLATION_ID,
        storageGenerationId: candidateStorageGenerationId,
      })
    })

    expect(await readFile(legacy)).toEqual(before)
    await expect(readActiveOperation(options.installationRoot, signal)).resolves.toBeUndefined()
    await expect(readInstallationManifest(options.installationRoot, signal)).resolves.toMatchObject({
      value: {
        phase: 'ready',
        storageGenerationId: candidateStorageGenerationId,
      },
    })
    expect(await exists(resolve(
      options.installationRoot,
      ...active.journal.backup.finalLeaf.split('/'),
    ))).toBe(true)
    expect(await exists(resolve(
      options.installationRoot,
      ...active.journal.candidate.finalLeaf.split('/'),
    ))).toBe(true)
  })

  it('settles an interrupted pre-publication upgrade before a maintenance-command retry', async () => {
    const { options, legacy } = await fixture()
    const before = await readFile(legacy)
    const crash = new Error('crash with a complete unselected candidate')
    const interrupted = createSakiMaintenanceOperations({
      afterCandidatePublication: async () => { throw crash },
    })
    const signal = new AbortController().signal

    await expect(interrupted.upgrade(options, signal)).rejects.toBe(crash)
    const first = await readActiveOperation(options.installationRoot, signal)
    if (first?.journal.kind !== 'upgrade') throw new Error('interrupted upgrade journal is not selected')

    const result = await upgradeSakiInstallation(options, signal)

    expect(result.selected.generation.storageGenerationId)
      .not.toBe(first.journal.candidateStorageGenerationId)
    expect(await readFile(legacy)).toEqual(before)
    await expect(readActiveOperation(options.installationRoot, signal)).resolves.toBeUndefined()
    for (const leaf of [
      first.journal.backup.partialLeaf,
      first.journal.backup.finalLeaf,
      first.journal.candidate.partialLeaf,
      first.journal.candidate.finalLeaf,
    ]) {
      expect(await exists(resolve(options.installationRoot, ...leaf.split('/')))).toBe(false)
    }
  })
})
