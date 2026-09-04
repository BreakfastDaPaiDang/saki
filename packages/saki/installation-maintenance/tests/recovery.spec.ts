import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { KvUnitSnapshot } from '@deepseek-ai/dsh-storage'
import { descriptorOf, type DomainSpec } from '@deepseek-ai/dsh-storage-domain'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import {
  sakiHostExecutionV1DomainSpec,
  sakiHostExecutionV3DomainSpec,
} from '@breakfastdapaidang/saki-execution-local'
import type {
  SakiBuildId,
  SakiInstallationId,
  SakiStorageGenerationId,
} from '@breakfastdapaidang/saki-control-plane'

type Lstat = typeof import('node:fs/promises')['lstat']
type Rmdir = typeof import('node:fs/promises')['rmdir']

const filesystem = vi.hoisted(() => ({
  lstat: vi.fn<Lstat>(),
  rmdir: vi.fn<Rmdir>(),
  lstatFailure: undefined as { readonly path: string; readonly error: Error } | undefined,
  rmdirFailure: undefined as { readonly path: string; readonly error: Error } | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  filesystem.lstat.mockImplementation(async (...arguments_) => {
    if (filesystem.lstatFailure?.path === arguments_[0]) throw filesystem.lstatFailure.error
    return await original.lstat(...arguments_)
  })
  filesystem.rmdir.mockImplementation(async (...arguments_) => {
    if (filesystem.rmdirFailure?.path === arguments_[0]) throw filesystem.rmdirFailure.error
    await original.rmdir(...arguments_)
  })
  return { ...original, lstat: filesystem.lstat, rmdir: filesystem.rmdir }
})

import {
  sakiControlPlaneMigrationPlan,
  sakiControlPlaneV2DomainSpec,
  sakiControlPlaneV3DomainSpec,
  sakiControlPlaneV4DomainSpec,
  sakiControlPlaneV5DomainSpec,
  sakiControlPlaneV6DomainSpec,
  sakiControlPlaneV8DomainSpec,
  sakiStorageGenerationV1DomainSpec,
  sakiStorageGenerationV2DomainSpec,
  sakiStorageGenerationV3DomainSpec,
  sakiStorageGenerationV4DomainSpec,
  sakiStorageGenerationV6DomainSpec,
  STORAGE_GENERATION_KEY,
  storageGenerationV1SealRecordSchema,
  storageGenerationV2SealRecordSchema,
  storageGenerationV3SealRecordSchema,
  storageGenerationV4SealRecordSchema,
  storageGenerationV6SealRecordSchema,
} from '@breakfastdapaidang/saki-control-plane'
import {
  captureSqliteArtifactSet,
  createRecoveryBackup,
  createOperationJournal,
  createSakiMaintenanceOperationId,
  createSakiRecoveryBackupId,
  durableFileTemporaryPath,
  generationManifestReference,
  LEGACY_B03_BUILD_ID,
  materializeFreshSakiGeneration,
  migrateSakiGeneration,
  publishSakiGenerationCandidate,
  operationJournalReference,
  PENDING_OPERATION_LEAF,
  publishActiveOperation,
  readActiveOperation,
  readInstallationManifest,
  readPendingOperation,
  recoverActiveSakiOperation,
  renderGenerationManifest,
  renderInstallationManifest,
  renderOperationJournal,
  renderPendingOperationIntent,
  sakiStateCapability,
  verifyRecoveryBackup,
  withMissingRecoveryBackupTarget,
  withPreparedSakiServingState,
} from '../src/index.ts'

const INSTALLATION_ID = 'installation-00000000-0000-4000-8000-000000000001' as SakiInstallationId
const OTHER_INSTALLATION_ID =
  'installation-00000000-0000-4000-8000-000000000098' as SakiInstallationId
const CANDIDATE_ID =
  'storage-generation-00000000-0000-4000-8000-000000000002' as SakiStorageGenerationId
const OTHER_GENERATION_ID =
  'storage-generation-00000000-0000-4000-8000-000000000099' as SakiStorageGenerationId
const BUILD_ID = 'saki-build-recovery-test' as SakiBuildId
const PREVIOUS_WRITABLE_BUILD_ID = 'saki-build-0.1.0-b09' as SakiBuildId
const OLD_BUILD_ID = LEGACY_B03_BUILD_ID
const HISTORICAL_GENERATION_ID =
  'installation-generation-00000000-0000-4000-8000-000000000009'
const OLD_STORAGE_GENERATION_ID =
  'storage-generation-00000000-0000-4000-8000-000000000009' as SakiStorageGenerationId
const V2_UPGRADE_SOURCE = {
  sourceStateVersion: 2,
  sourceStorageGenerationId: OLD_STORAGE_GENERATION_ID,
  sourceBuildId: OLD_BUILD_ID,
} as const
const V3_UPGRADE_SOURCE = { ...V2_UPGRADE_SOURCE, sourceStateVersion: 3 } as const
const V4_UPGRADE_SOURCE = { ...V2_UPGRADE_SOURCE, sourceStateVersion: 4 } as const
const V5_UPGRADE_SOURCE = { ...V2_UPGRADE_SOURCE, sourceStateVersion: 5 } as const
const V6_UPGRADE_SOURCE = { ...V2_UPGRADE_SOURCE, sourceStateVersion: 6 } as const
const HOST_ID = 'host-00000000-0000-4000-8000-000000000003'
const PRINCIPAL_ID = 'principal-00000000-0000-4000-8000-000000000004'
const GRANT_ID = 'grant-00000000-0000-4000-8000-000000000005'
const ACCESS_ID = 'access-00000000-0000-4000-8000-000000000006'
const roots: string[] = []

async function createRoot(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'saki-recovery-'))
  roots.push(value)
  return value
}

afterEach(async () => {
  filesystem.lstatFailure = undefined
  filesystem.rmdirFailure = undefined
  vi.clearAllMocks()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function historicalSnapshot(): KvUnitSnapshot {
  return {
    global: null,
    tables: {
      control_state: {
        'control-state': {
          schemaVersion: 1,
          revision: 1,
          phase: 'ready',
          installationId: INSTALLATION_ID,
          initialInstallationGenerationId: HISTORICAL_GENERATION_ID,
          initialHostId: HOST_ID,
          hostOperatorPrincipalId: PRINCIPAL_ID,
          hostOperatorGrantId: GRANT_ID,
          installationAccessId: ACCESS_ID,
        },
      },
      installations: {
        [INSTALLATION_ID]: {
          id: INSTALLATION_ID,
          revision: 1,
          state: 'active',
          currentInstallationGenerationId: HISTORICAL_GENERATION_ID,
          currentHostId: HOST_ID,
        },
      },
      hosts: {
        [HOST_ID]: {
          id: HOST_ID,
          revision: 1,
          installationId: INSTALLATION_ID,
          state: 'enrolled',
        },
      },
      principals: {
        [PRINCIPAL_ID]: {
          id: PRINCIPAL_ID,
          revision: 1,
          kind: 'human',
          displayName: 'Host Operator',
          state: 'active',
        },
      },
      grants: {
        [GRANT_ID]: {
          id: GRANT_ID,
          revision: 1,
          installationId: INSTALLATION_ID,
          principalId: PRINCIPAL_ID,
          state: 'active',
          actions: ['development-project:register'],
          scope: { kind: 'installation', installationId: INSTALLATION_ID },
        },
      },
      installation_access: {
        [ACCESS_ID]: {
          id: ACCESS_ID,
          schemaVersion: 1,
          revision: 0,
          installationId: INSTALLATION_ID,
          nextChallengeOrdinal: 0,
          nextSessionOrdinal: 0,
          requestTokenDerivation: { version: 1, domain: 'saki/browser-request-token' },
          challenges: [],
          sessions: [],
        },
      },
      development_project_registry: {
        'development-project-registry': {
          id: 'development-project-registry',
          schemaVersion: 1,
          revision: 0,
          projects: [],
          resourceBindings: [],
          canonicalWorktreeIndex: [],
          gitDirectoryIndex: [],
          intentMappings: [],
        },
      },
      registration_intents: {},
    },
  }
}

async function materializeHistorical(databasePath: string, signal: AbortSignal): Promise<void> {
  const backend = new SqliteStorageBackend({ path: databasePath, journalMode: 'delete' })
  try {
    const closed = backend.kv.closed
    if (closed === undefined) throw new Error('test SQLite backend has no closed operations')
    await closed.withReservedUnit(sakiControlPlaneV2DomainSpec.name, signal, async (lease) => {
      const result = await lease.materializeMissing(
        descriptorOf(sakiControlPlaneV2DomainSpec),
        historicalSnapshot(),
      )
      if (result.outcome !== 'durable') throw result.cause
    })
  } finally {
    await backend.close()
  }
}

async function materializeHistoricalSealedGeneration(
  databasePath: string,
  stateVersion: 3 | 4 | 5 | 6,
  signal: AbortSignal,
): Promise<void> {
  const v3Snapshot = sakiControlPlaneMigrationPlan.steps[0]!.migrate(historicalSnapshot())
  const v4Snapshot = sakiControlPlaneMigrationPlan.steps[1]!.migrate(v3Snapshot)
  const v5Snapshot = sakiControlPlaneMigrationPlan.steps[2]!.migrate(v4Snapshot)
  const v6Snapshot = sakiControlPlaneMigrationPlan.steps[3]!.migrate(v5Snapshot)
  const units: readonly { readonly spec: DomainSpec; readonly snapshot: KvUnitSnapshot }[] = [
    stateVersion === 3
      ? { spec: sakiControlPlaneV3DomainSpec, snapshot: v3Snapshot }
      : stateVersion === 4
        ? {
          spec: sakiControlPlaneV4DomainSpec,
          snapshot: v4Snapshot,
        }
        : stateVersion === 5
          ? { spec: sakiControlPlaneV5DomainSpec, snapshot: v5Snapshot }
          : { spec: sakiControlPlaneV6DomainSpec, snapshot: v6Snapshot },
    stateVersion === 3
      ? {
        spec: sakiStorageGenerationV1DomainSpec,
        snapshot: {
          global: null,
          tables: {
            storage_generation: {
              [STORAGE_GENERATION_KEY]: storageGenerationV1SealRecordSchema.parse({
                schemaVersion: 1,
                installationId: INSTALLATION_ID,
                storageGenerationId: OLD_STORAGE_GENERATION_ID,
                stateVersion: 3,
                createdByBuildId: OLD_BUILD_ID,
              }),
            },
          },
        },
      }
      : stateVersion === 4
        ? {
          spec: sakiStorageGenerationV2DomainSpec,
          snapshot: {
            global: null,
            tables: {
              storage_generation: {
                [STORAGE_GENERATION_KEY]: storageGenerationV2SealRecordSchema.parse({
                  schemaVersion: 2,
                  installationId: INSTALLATION_ID,
                  storageGenerationId: OLD_STORAGE_GENERATION_ID,
                  stateVersion: 4,
                  createdByBuildId: OLD_BUILD_ID,
                }),
              },
            },
          },
        }
        : stateVersion === 5
          ? {
            spec: sakiStorageGenerationV3DomainSpec,
            snapshot: {
              global: null,
              tables: {
                storage_generation: {
                  [STORAGE_GENERATION_KEY]: storageGenerationV3SealRecordSchema.parse({
                    schemaVersion: 3,
                    installationId: INSTALLATION_ID,
                    storageGenerationId: OLD_STORAGE_GENERATION_ID,
                    stateVersion: 5,
                    createdByBuildId: OLD_BUILD_ID,
                  }),
                },
              },
            },
          }
          : {
            spec: sakiStorageGenerationV4DomainSpec,
            snapshot: {
              global: null,
              tables: {
                storage_generation: {
                  [STORAGE_GENERATION_KEY]: storageGenerationV4SealRecordSchema.parse({
                    schemaVersion: 4,
                    installationId: INSTALLATION_ID,
                    storageGenerationId: OLD_STORAGE_GENERATION_ID,
                    stateVersion: 6,
                    createdByBuildId: OLD_BUILD_ID,
                  }),
                },
              },
            },
          },
    ...(stateVersion === 5 || stateVersion === 6
      ? [{
        spec: sakiHostExecutionV1DomainSpec,
        snapshot: {
          global: null,
          tables: Object.fromEntries(Object.keys(sakiHostExecutionV1DomainSpec.tables).map(table => [table, {}])),
        },
      }]
      : []),
  ]
  const backend = new SqliteStorageBackend({ path: databasePath, journalMode: 'delete' })
  try {
    const closed = backend.kv.closed
    if (closed === undefined) throw new Error('test SQLite backend has no closed operations')
    for (const unit of units) {
      await closed.withReservedUnit(unit.spec.name, signal, async (lease) => {
        const result = await lease.materializeMissing(descriptorOf(unit.spec), unit.snapshot)
        if (result.outcome !== 'durable') throw result.cause
      })
    }
  } finally {
    await backend.close()
  }
}

async function materializePreviousWritableGeneration(
  databasePath: string,
  storageGenerationId: SakiStorageGenerationId,
  controlPlaneSnapshot: KvUnitSnapshot,
  signal: AbortSignal,
): Promise<void> {
  const units: readonly { readonly spec: DomainSpec; readonly snapshot: KvUnitSnapshot }[] = [
    { spec: sakiControlPlaneV8DomainSpec, snapshot: controlPlaneSnapshot },
    {
      spec: sakiHostExecutionV3DomainSpec,
      snapshot: {
        global: null,
        tables: Object.fromEntries(
          Object.keys(sakiHostExecutionV3DomainSpec.tables).map(table => [table, {}]),
        ),
      },
    },
    {
      spec: sakiStorageGenerationV6DomainSpec,
      snapshot: {
        global: null,
        tables: {
          storage_generation: {
            [STORAGE_GENERATION_KEY]: storageGenerationV6SealRecordSchema.parse({
              schemaVersion: 6,
              installationId: INSTALLATION_ID,
              storageGenerationId,
              stateVersion: 8,
              createdByBuildId: PREVIOUS_WRITABLE_BUILD_ID,
            }),
          },
        },
      },
    },
  ]
  const backend = new SqliteStorageBackend({ path: databasePath, journalMode: 'delete' })
  try {
    const closed = backend.kv.closed
    if (closed === undefined) throw new Error('test SQLite backend has no closed operations')
    for (const unit of units) {
      await closed.withReservedUnit(unit.spec.name, signal, async (lease) => {
        const result = await lease.materializeMissing(descriptorOf(unit.spec), unit.snapshot)
        if (result.outcome !== 'durable') throw result.cause
      })
    }
  } finally {
    await backend.close()
  }
}

function previousWritableControlPlaneSnapshot(source: 'fresh' | 'upgrade'): KvUnitSnapshot {
  if (source === 'fresh') {
    return {
      global: null,
      tables: Object.fromEntries(
        Object.keys(sakiControlPlaneV8DomainSpec.tables).map(table => [table, {}]),
      ),
    }
  }
  const v3Snapshot = sakiControlPlaneMigrationPlan.steps[0]!.migrate(historicalSnapshot())
  const v4Snapshot = sakiControlPlaneMigrationPlan.steps[1]!.migrate(v3Snapshot)
  const v5Snapshot = sakiControlPlaneMigrationPlan.steps[2]!.migrate(v4Snapshot)
  const v6Snapshot = sakiControlPlaneMigrationPlan.steps[3]!.migrate(v5Snapshot)
  const v7Snapshot = sakiControlPlaneMigrationPlan.steps[4]!.migrate(v6Snapshot)
  return sakiControlPlaneMigrationPlan.steps[5]!.migrate(v7Snapshot)
}

async function publishPreviousWritableCandidate(
  root: string,
  phase: 'provisioning' | 'ready' | undefined,
  source: 'fresh' | 'upgrade',
  signal: AbortSignal,
): Promise<string> {
  const generationDirectory = join(root, 'generations', CANDIDATE_ID)
  await mkdir(generationDirectory, { recursive: true })
  const databasePath = join(generationDirectory, 'state.sqlite')
  await materializePreviousWritableGeneration(
    databasePath,
    CANDIDATE_ID,
    previousWritableControlPlaneSnapshot(source),
    signal,
  )
  const generationBytes = renderGenerationManifest(
    INSTALLATION_ID,
    CANDIDATE_ID,
    8,
    PREVIOUS_WRITABLE_BUILD_ID,
  )
  await writeFile(join(generationDirectory, 'generation.json'), generationBytes)
  const generation = JSON.parse(generationBytes.toString('utf8')) as Parameters<
    typeof renderInstallationManifest
  >[1]
  if (phase !== undefined) {
    await writeFile(
      join(root, 'installation.json'),
      renderInstallationManifest(
        phase,
        generation,
        generationManifestReference(CANDIDATE_ID, generationBytes),
      ),
    )
  }
  return databasePath
}

async function createJournalBackup(
  root: string,
  journal: Extract<ReturnType<typeof createOperationJournal>, { kind: 'upgrade' }>,
  sourcePath: string,
  signal: AbortSignal,
  metadata: {
    readonly installationId?: SakiInstallationId
    readonly storageGenerationId?: SakiStorageGenerationId
    readonly stateVersion?: 2 | 3
    readonly sourceBuildId?: SakiBuildId
  } = {},
): Promise<string> {
  const source = await captureSqliteArtifactSet(sourcePath, signal)
  const publication = await withMissingRecoveryBackupTarget(
    root,
    journal.backupId,
    signal,
    async reservation => await createRecoveryBackup(
      reservation,
      source,
      {
        installationId: metadata.installationId ?? INSTALLATION_ID,
        storageGenerationId: metadata.storageGenerationId ?? OLD_STORAGE_GENERATION_ID,
        stateVersion: metadata.stateVersion ?? 2,
        sourceBuildId: metadata.sourceBuildId ?? OLD_BUILD_ID,
      },
      sakiStateCapability,
      signal,
    ),
  )
  return publication.backup.directory
}

async function publishHistoricalGeneration(
  root: string,
  signal: AbortSignal,
): Promise<{ readonly databasePath: string; readonly generationBytes: Buffer }> {
  const generationDirectory = join(root, 'generations', OLD_STORAGE_GENERATION_ID)
  await mkdir(generationDirectory, { recursive: true })
  const databasePath = join(generationDirectory, 'state.sqlite')
  await materializeHistorical(databasePath, signal)
  const generationBytes = renderGenerationManifest(
    INSTALLATION_ID,
    OLD_STORAGE_GENERATION_ID,
    2,
    OLD_BUILD_ID,
  )
  await writeFile(join(generationDirectory, 'generation.json'), generationBytes)
  const generation = JSON.parse(generationBytes.toString('utf8')) as Parameters<
    typeof renderInstallationManifest
  >[1]
  await writeFile(
    join(root, 'installation.json'),
    renderInstallationManifest(
      'ready',
      generation,
      generationManifestReference(OLD_STORAGE_GENERATION_ID, generationBytes),
    ),
  )
  return { databasePath, generationBytes }
}

async function publishHistoricalSealedGeneration(
  root: string,
  stateVersion: 3 | 4 | 5 | 6,
  signal: AbortSignal,
): Promise<{ readonly databasePath: string; readonly generationBytes: Buffer }> {
  const generationDirectory = join(root, 'generations', OLD_STORAGE_GENERATION_ID)
  await mkdir(generationDirectory, { recursive: true })
  const databasePath = join(generationDirectory, 'state.sqlite')
  await materializeHistoricalSealedGeneration(databasePath, stateVersion, signal)
  const generationBytes = renderGenerationManifest(
    INSTALLATION_ID,
    OLD_STORAGE_GENERATION_ID,
    stateVersion,
    OLD_BUILD_ID,
  )
  await writeFile(join(generationDirectory, 'generation.json'), generationBytes)
  const generation = JSON.parse(generationBytes.toString('utf8')) as Parameters<
    typeof renderInstallationManifest
  >[1]
  await writeFile(
    join(root, 'installation.json'),
    renderInstallationManifest(
      'ready',
      generation,
      generationManifestReference(OLD_STORAGE_GENERATION_ID, generationBytes),
    ),
  )
  return { databasePath, generationBytes }
}

async function publishAuthority(
  root: string,
  phase: 'provisioning' | 'ready',
  installationId: SakiInstallationId,
  storageGenerationId: SakiStorageGenerationId,
  stateVersion: number,
): Promise<void> {
  const generationBytes = renderGenerationManifest(
    installationId,
    storageGenerationId,
    stateVersion,
    BUILD_ID,
  )
  const generation = JSON.parse(generationBytes.toString('utf8')) as Parameters<
    typeof renderInstallationManifest
  >[1]
  await writeFile(
    join(root, 'installation.json'),
    renderInstallationManifest(
      phase,
      generation,
      generationManifestReference(storageGenerationId, generationBytes),
    ),
  )
}

async function prepareInterruptedUpgrade(
  root: string,
  publishAuthority: boolean,
  signal: AbortSignal,
  sourceIdentity: typeof V2_UPGRADE_SOURCE | typeof V3_UPGRADE_SOURCE = V2_UPGRADE_SOURCE,
): Promise<{
  readonly legacyPath: string
  readonly candidatePath: string
  readonly backupPath: string
}> {
  const legacyPath = join(root, 'legacy.sqlite')
  await materializeHistorical(legacyPath, signal)
  const journalValue = createOperationJournal({
    kind: 'upgrade',
    operationId: createSakiMaintenanceOperationId(),
    installationId: INSTALLATION_ID,
    ...sourceIdentity,
    backupId: createSakiRecoveryBackupId(),
    candidateStorageGenerationId: CANDIDATE_ID,
  })
  if (journalValue.kind !== 'upgrade') throw new Error('test journal changed kind')
  const active = await publishActiveOperation(root, journalValue, signal)
  if (active.journal.kind !== 'upgrade') throw new Error('selected test journal changed kind')
  const backupPath = await createJournalBackup(root, active.journal, legacyPath, signal)
  const candidate = await publishSakiGenerationCandidate(
    root,
    active.journal,
    {
      installationId: INSTALLATION_ID,
      storageGenerationId: CANDIDATE_ID,
      createdByBuildId: BUILD_ID,
    },
    signal,
    async (databasePath) => {
      await migrateSakiGeneration(
        legacyPath,
        databasePath,
        {
          installationId: INSTALLATION_ID,
          storageGenerationId: CANDIDATE_ID,
          createdByBuildId: BUILD_ID,
        },
        signal,
        undefined,
      )
    },
  )
  if (publishAuthority) {
    await writeFile(
      join(root, 'installation.json'),
      renderInstallationManifest(
        'ready',
        candidate.generation,
        candidate.installation.generationJson,
      ),
    )
  }
  return {
    legacyPath,
    candidatePath: dirname(candidate.databasePath),
    backupPath,
  }
}

describe('active Saki operation recovery', () => {
  it('rejects non-filesystem Installation and legacy paths before recovery', async () => {
    const root = await createRoot()
    const signal = AbortSignal.timeout(2_000)

    await expect(recoverActiveSakiOperation(
      ':memory:',
      join(root, 'legacy.sqlite'),
      signal,
    )).rejects.toThrow('Saki Installation root must be an absolute filesystem path')
    await expect(recoverActiveSakiOperation(
      root,
      'legacy.sqlite',
      signal,
    )).rejects.toThrow('legacy Saki database path must be an absolute filesystem path')
  })

  it('requires recovery for an unselected journal beside ready manifest state', async () => {
    const root = await createRoot()
    const signal = AbortSignal.timeout(5_000)
    const generationDirectory = join(root, 'generations', CANDIDATE_ID)
    await mkdir(generationDirectory, { recursive: true })
    await materializeFreshSakiGeneration(
      join(generationDirectory, 'state.sqlite'),
      {
        installationId: INSTALLATION_ID,
        storageGenerationId: CANDIDATE_ID,
        createdByBuildId: BUILD_ID,
      },
      signal,
    )
    const generationBytes = renderGenerationManifest(
      INSTALLATION_ID,
      CANDIDATE_ID,
      3,
      BUILD_ID,
    )
    await writeFile(join(generationDirectory, 'generation.json'), generationBytes)
    const generation = JSON.parse(generationBytes.toString('utf8')) as Parameters<
      typeof renderInstallationManifest
    >[1]
    await writeFile(
      join(root, 'installation.json'),
      renderInstallationManifest(
        'ready',
        generation,
        generationManifestReference(CANDIDATE_ID, generationBytes),
      ),
    )
    const orphan = createOperationJournal({
      kind: 'fresh',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: OTHER_GENERATION_ID,
    })
    const orphanBytes = renderOperationJournal(orphan)
    const orphanPath = join(root, ...operationJournalReference(
      orphan.operationId,
      orphanBytes,
    ).leaf.split('/'))
    await mkdir(dirname(orphanPath), { recursive: true })
    await writeFile(orphanPath, orphanBytes)

    await expect(recoverActiveSakiOperation(root, join(root, 'legacy.sqlite'), signal))
      .rejects.toMatchObject({ code: 'recovery-required' })
    await expect(readInstallationManifest(root, signal)).resolves.toMatchObject({
      value: { phase: 'ready', storageGenerationId: CANDIDATE_ID },
    })
  })

  it('reconciles a pre-activation crash before selecting an operation to recover', async () => {
    const root = await createRoot()
    const signal = AbortSignal.timeout(2_000)
    const journal = createOperationJournal({
      kind: 'fresh',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: CANDIDATE_ID,
    })
    const journalBytes = renderOperationJournal(journal)
    await writeFile(
      join(root, PENDING_OPERATION_LEAF),
      renderPendingOperationIntent(
        journal.operationId,
        operationJournalReference(journal.operationId, journalBytes),
      ),
    )
    const installationManifestPath = join(root, 'installation.json')
    await writeFile(
      durableFileTemporaryPath(installationManifestPath),
      'interrupted manifest publication',
    )

    await recoverActiveSakiOperation(root, join(root, 'legacy.sqlite'), signal)

    await expect(readFile(durableFileTemporaryPath(installationManifestPath)))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readPendingOperation(root, signal)).resolves.toMatchObject({
      state: { status: 'cleared' },
    })
  })

  it('rolls back only the exact fresh candidate when no manifest was published', async () => {
    const root = await createRoot()
    const signal = AbortSignal.timeout(2_000)
    const journal = createOperationJournal({
      kind: 'fresh',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: CANDIDATE_ID,
    })
    if (journal.kind !== 'fresh') throw new Error('test journal changed kind')
    const partial = join(root, ...journal.candidate.partialLeaf.split('/'))
    const final = join(root, ...journal.candidate.finalLeaf.split('/'))
    await mkdir(partial, { recursive: true })
    await writeFile(join(partial, 'partial.txt'), 'partial')
    await mkdir(dirname(final), { recursive: true })
    await mkdir(final)
    await writeFile(join(final, 'candidate.txt'), 'candidate')
    await publishActiveOperation(root, journal, signal)

    await recoverActiveSakiOperation(root, join(root, 'legacy.sqlite'), signal)

    expect(await exists(partial)).toBe(false)
    expect(await exists(final)).toBe(false)
    await expect(readActiveOperation(root, signal)).resolves.toBeUndefined()
  })

  it('refuses to remove a candidate through a Windows junction or POSIX symlink', async () => {
    const root = await createRoot()
    const external = await createRoot()
    const signal = AbortSignal.timeout(2_000)
    const journal = createOperationJournal({
      kind: 'fresh',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: CANDIDATE_ID,
    })
    if (journal.kind !== 'fresh') throw new Error('test journal changed kind')
    await publishActiveOperation(root, journal, signal)
    const externalCandidate = join(external, CANDIDATE_ID)
    await mkdir(externalCandidate)
    const valuable = join(externalCandidate, 'valuable.txt')
    await writeFile(valuable, 'outside')
    const generations = join(root, 'generations')
    await symlink(external, generations, process.platform === 'win32' ? 'junction' : 'dir')

    try {
      await expect(recoverActiveSakiOperation(root, join(root, 'legacy.sqlite'), signal))
        .rejects.toMatchObject({ code: 'recovery-required' })

      await expect(readFile(valuable, 'utf8')).resolves.toBe('outside')
      await expect(readActiveOperation(root, signal)).resolves.toMatchObject({
        journal: { operationId: journal.operationId },
      })
    } finally {
      try {
        await unlink(generations)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  })

  it('accepts the exact fresh candidate selected by a provisioning manifest', async () => {
    const root = await createRoot()
    const signal = AbortSignal.timeout(5_000)
    const journal = createOperationJournal({
      kind: 'fresh',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: CANDIDATE_ID,
    })
    const active = await publishActiveOperation(root, journal, signal)
    if (active.journal.kind !== 'fresh') throw new Error('test journal changed kind')
    const candidate = await publishSakiGenerationCandidate(
      root,
      active.journal,
      {
        installationId: INSTALLATION_ID,
        storageGenerationId: CANDIDATE_ID,
        createdByBuildId: BUILD_ID,
      },
      signal,
      async (databasePath) => {
        await materializeFreshSakiGeneration(databasePath, {
          installationId: INSTALLATION_ID,
          storageGenerationId: CANDIDATE_ID,
          createdByBuildId: BUILD_ID,
        }, signal)
      },
    )
    await writeFile(
      join(root, 'installation.json'),
      renderInstallationManifest(
        'provisioning',
        candidate.generation,
        candidate.installation.generationJson,
      ),
    )

    await recoverActiveSakiOperation(root, join(root, 'legacy.sqlite'), signal)

    await expect(readActiveOperation(root, signal)).resolves.toBeUndefined()
    expect((await readInstallationManifest(root, signal))?.value).toMatchObject({
      phase: 'provisioning',
      storageGenerationId: CANDIDATE_ID,
    })
    await expect(readFile(candidate.databasePath)).resolves.not.toHaveLength(0)
  })

  it('settles a previous writable build fresh journal after its v8 manifest was published', async () => {
    const root = await createRoot()
    const signal = AbortSignal.timeout(5_000)
    const journal = createOperationJournal({
      kind: 'fresh',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: CANDIDATE_ID,
    })
    await publishActiveOperation(root, journal, signal)
    const databasePath = await publishPreviousWritableCandidate(
      root,
      'provisioning',
      'fresh',
      signal,
    )

    await recoverActiveSakiOperation(root, join(root, 'legacy.sqlite'), signal)

    await expect(readActiveOperation(root, signal)).resolves.toBeUndefined()
    await expect(readInstallationManifest(root, signal)).resolves.toMatchObject({
      value: {
        phase: 'provisioning',
        stateVersion: 8,
        storageGenerationId: CANDIDATE_ID,
      },
    })
    await expect(readFile(databasePath)).resolves.not.toHaveLength(0)
  })

  it('refuses to clean a fresh candidate when another manifest authority exists', async () => {
    const root = await createRoot()
    const signal = AbortSignal.timeout(2_000)
    const journal = createOperationJournal({
      kind: 'fresh',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: CANDIDATE_ID,
    })
    if (journal.kind !== 'fresh') throw new Error('test journal changed kind')
    const candidatePath = join(root, ...journal.candidate.finalLeaf.split('/'))
    await mkdir(candidatePath, { recursive: true })
    const otherGenerationBytes = renderGenerationManifest(
      INSTALLATION_ID,
      OTHER_GENERATION_ID,
      3,
      BUILD_ID,
    )
    const otherGeneration = JSON.parse(otherGenerationBytes.toString('utf8')) as Parameters<
      typeof renderInstallationManifest
    >[1]
    await writeFile(
      join(root, 'installation.json'),
      renderInstallationManifest(
        'ready',
        otherGeneration,
        generationManifestReference(OTHER_GENERATION_ID, otherGenerationBytes),
      ),
    )
    await publishActiveOperation(root, journal, signal)

    await expect(recoverActiveSakiOperation(root, join(root, 'legacy.sqlite'), signal))
      .rejects.toMatchObject({ code: 'recovery-required' })

    expect(await exists(candidatePath)).toBe(true)
    await expect(readActiveOperation(root, signal)).resolves.toMatchObject({
      journal: { operationId: journal.operationId },
    })
  })

  it('finishes an interrupted backup after exact final verification and retains it', async () => {
    const root = await createRoot()
    const signal = AbortSignal.timeout(5_000)
    const sourcePath = join(root, 'source.sqlite')
    await materializeFreshSakiGeneration(sourcePath, {
      installationId: INSTALLATION_ID,
      storageGenerationId: CANDIDATE_ID,
      createdByBuildId: BUILD_ID,
    }, signal)
    const source = await captureSqliteArtifactSet(sourcePath, signal)
    const journal = createOperationJournal({
      kind: 'backup',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      backupId: createSakiRecoveryBackupId(),
    })
    if (journal.kind !== 'backup') throw new Error('test journal changed kind')
    await publishActiveOperation(root, journal, signal)
    const publication = await withMissingRecoveryBackupTarget(
      root,
      journal.backupId,
      signal,
      async reservation => await createRecoveryBackup(
        reservation,
        source,
        {
          installationId: INSTALLATION_ID,
          storageGenerationId: CANDIDATE_ID,
          stateVersion: 3,
          sourceBuildId: BUILD_ID,
        },
        sakiStateCapability,
        signal,
      ),
    )
    const partial = join(root, ...journal.backup.partialLeaf.split('/'))
    await mkdir(partial)
    await writeFile(join(partial, 'interrupted.txt'), 'partial')

    await recoverActiveSakiOperation(root, sourcePath, signal)

    expect(publication.backup.directory).toBe(join(root, ...journal.backup.finalLeaf.split('/')))
    expect(await exists(partial)).toBe(false)
    await expect(verifyRecoveryBackup(root, journal.backupId, sakiStateCapability, signal))
      .resolves.toMatchObject({ manifest: { installationId: INSTALLATION_ID } })
    await expect(readActiveOperation(root, signal)).resolves.toBeUndefined()
  })

  it('clears an interrupted backup before its final directory exists', async () => {
    const root = await createRoot()
    const signal = AbortSignal.timeout(2_000)
    const journal = createOperationJournal({
      kind: 'backup',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      backupId: createSakiRecoveryBackupId(),
    })
    if (journal.kind !== 'backup') throw new Error('test journal changed kind')
    await publishActiveOperation(root, journal, signal)
    const partial = join(root, ...journal.backup.partialLeaf.split('/'))
    await mkdir(partial, { recursive: true })
    await writeFile(join(partial, 'interrupted.txt'), 'partial')

    await recoverActiveSakiOperation(root, join(root, 'legacy.sqlite'), signal)

    expect(await exists(partial)).toBe(false)
    await expect(readActiveOperation(root, signal)).resolves.toBeUndefined()
  })

  it('retains a Recovery Backup whose manifest belongs to another Installation', async () => {
    const root = await createRoot()
    const signal = AbortSignal.timeout(5_000)
    const sourcePath = join(root, 'source.sqlite')
    await materializeFreshSakiGeneration(sourcePath, {
      installationId: INSTALLATION_ID,
      storageGenerationId: CANDIDATE_ID,
      createdByBuildId: BUILD_ID,
    }, signal)
    const source = await captureSqliteArtifactSet(sourcePath, signal)
    const journal = createOperationJournal({
      kind: 'backup',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      backupId: createSakiRecoveryBackupId(),
    })
    if (journal.kind !== 'backup') throw new Error('test journal changed kind')
    await publishActiveOperation(root, journal, signal)
    await withMissingRecoveryBackupTarget(root, journal.backupId, signal, async (reservation) => {
      await createRecoveryBackup(
        reservation,
        source,
        {
          installationId: OTHER_INSTALLATION_ID,
          storageGenerationId: CANDIDATE_ID,
          stateVersion: 3,
          sourceBuildId: BUILD_ID,
        },
        sakiStateCapability,
        signal,
      )
    })

    await expect(recoverActiveSakiOperation(root, sourcePath, signal))
      .rejects.toMatchObject({ code: 'recovery-required' })

    expect(await exists(join(root, ...journal.backup.finalLeaf.split('/')))).toBe(true)
    await expect(readActiveOperation(root, signal)).resolves.toMatchObject({
      journal: { operationId: journal.operationId },
    })
  })

  it('refuses to remove a backup through a Windows junction or POSIX symlink', async () => {
    const root = await createRoot()
    const external = await createRoot()
    const signal = AbortSignal.timeout(2_000)
    const journal = createOperationJournal({
      kind: 'backup',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      backupId: createSakiRecoveryBackupId(),
    })
    if (journal.kind !== 'backup') throw new Error('test journal changed kind')
    await publishActiveOperation(root, journal, signal)
    const externalPartial = join(external, `${journal.backupId}.partial`)
    await mkdir(externalPartial)
    const valuable = join(externalPartial, 'valuable.txt')
    await writeFile(valuable, 'outside')
    const backups = join(root, 'backups')
    await symlink(external, backups, process.platform === 'win32' ? 'junction' : 'dir')

    try {
      await expect(recoverActiveSakiOperation(root, join(root, 'legacy.sqlite'), signal))
        .rejects.toMatchObject({ code: 'recovery-required' })

      await expect(readFile(valuable, 'utf8')).resolves.toBe('outside')
      await expect(readActiveOperation(root, signal)).resolves.toMatchObject({
        journal: { operationId: journal.operationId },
      })
    } finally {
      await unlink(backups)
    }
  })

  it('rolls back a fully built upgrade candidate while the exact B03 source is still authoritative', async () => {
    const root = await createRoot()
    const signal = AbortSignal.timeout(10_000)
    const prepared = await prepareInterruptedUpgrade(root, false, signal)
    const before = await readFile(prepared.legacyPath)

    await recoverActiveSakiOperation(root, prepared.legacyPath, signal)

    expect(await exists(prepared.candidatePath)).toBe(false)
    expect(await exists(prepared.backupPath)).toBe(false)
    expect(await readFile(prepared.legacyPath)).toEqual(before)
    await expect(readActiveOperation(root, signal)).resolves.toBeUndefined()
    await expect(withPreparedSakiServingState({
      installationRoot: root,
      legacyDatabasePath: prepared.legacyPath,
      currentBuildId: BUILD_ID,
    }, signal, async () => undefined)).rejects.toMatchObject({ code: 'upgrade-required' })
  })

  it('rolls back a previous writable build v8 candidate before its authority commit', async () => {
    const root = await createRoot()
    const signal = AbortSignal.timeout(10_000)
    const legacyPath = join(root, 'legacy.sqlite')
    await materializeHistorical(legacyPath, signal)
    const journal = createOperationJournal({
      kind: 'upgrade',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      ...V2_UPGRADE_SOURCE,
      backupId: createSakiRecoveryBackupId(),
      candidateStorageGenerationId: CANDIDATE_ID,
    })
    if (journal.kind !== 'upgrade') throw new Error('test journal changed kind')
    await publishActiveOperation(root, journal, signal)
    const backupPath = await createJournalBackup(root, journal, legacyPath, signal)
    const databasePath = await publishPreviousWritableCandidate(
      root,
      undefined,
      'upgrade',
      signal,
    )
    const candidatePath = dirname(databasePath)

    await recoverActiveSakiOperation(root, legacyPath, signal)

    await expect(readActiveOperation(root, signal)).resolves.toBeUndefined()
    expect(await exists(candidatePath)).toBe(false)
    expect(await exists(backupPath)).toBe(false)
    await expect(readFile(legacyPath)).resolves.not.toHaveLength(0)
  })

  it('settles an interrupted upgrade while an exact selected v3 source remains authoritative', async () => {
    const root = await createRoot()
    const signal = AbortSignal.timeout(10_000)
    const selected = await publishHistoricalSealedGeneration(root, 3, signal)
    const before = await readFile(selected.databasePath)
    const journal = createOperationJournal({
      kind: 'upgrade',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      ...V3_UPGRADE_SOURCE,
      backupId: createSakiRecoveryBackupId(),
      candidateStorageGenerationId: CANDIDATE_ID,
    })
    if (journal.kind !== 'upgrade') throw new Error('test journal changed kind')
    await publishActiveOperation(root, journal, signal)

    await recoverActiveSakiOperation(root, join(root, 'unused-legacy.sqlite'), signal)

    expect(await readFile(selected.databasePath)).toEqual(before)
    await expect(readInstallationManifest(root, signal)).resolves.toMatchObject({
      value: {
        phase: 'ready',
        stateVersion: 3,
        storageGenerationId: OLD_STORAGE_GENERATION_ID,
      },
    })
    await expect(readActiveOperation(root, signal)).resolves.toBeUndefined()
  })

  it('settles an interrupted upgrade while an exact selected v4 source remains authoritative', async () => {
    const root = await createRoot()
    const signal = AbortSignal.timeout(10_000)
    const selected = await publishHistoricalSealedGeneration(root, 4, signal)
    const before = await readFile(selected.databasePath)
    const authorityBefore = await readFile(join(root, 'installation.json'))
    const journal = createOperationJournal({
      kind: 'upgrade',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      ...V4_UPGRADE_SOURCE,
      backupId: createSakiRecoveryBackupId(),
      candidateStorageGenerationId: CANDIDATE_ID,
    })
    if (journal.kind !== 'upgrade') throw new Error('test journal changed kind')
    await publishActiveOperation(root, journal, signal)

    await recoverActiveSakiOperation(root, join(root, 'unused-legacy.sqlite'), signal)

    expect(await readFile(selected.databasePath)).toEqual(before)
    expect(await readFile(join(root, 'installation.json'))).toEqual(authorityBefore)
    await expect(readInstallationManifest(root, signal)).resolves.toMatchObject({
      value: {
        phase: 'ready',
        stateVersion: 4,
        storageGenerationId: OLD_STORAGE_GENERATION_ID,
      },
    })
    await expect(readActiveOperation(root, signal)).resolves.toBeUndefined()
  })

  it('settles an interrupted upgrade while an exact selected v5 source remains authoritative', async () => {
    const root = await createRoot()
    const signal = AbortSignal.timeout(10_000)
    const selected = await publishHistoricalSealedGeneration(root, 5, signal)
    const before = await readFile(selected.databasePath)
    const authorityBefore = await readFile(join(root, 'installation.json'))
    const journal = createOperationJournal({
      kind: 'upgrade',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      ...V5_UPGRADE_SOURCE,
      backupId: createSakiRecoveryBackupId(),
      candidateStorageGenerationId: CANDIDATE_ID,
    })
    if (journal.kind !== 'upgrade') throw new Error('test journal changed kind')
    await publishActiveOperation(root, journal, signal)

    await recoverActiveSakiOperation(root, join(root, 'unused-legacy.sqlite'), signal)

    expect(await readFile(selected.databasePath)).toEqual(before)
    expect(await readFile(join(root, 'installation.json'))).toEqual(authorityBefore)
    await expect(readInstallationManifest(root, signal)).resolves.toMatchObject({
      value: {
        phase: 'ready',
        stateVersion: 5,
        storageGenerationId: OLD_STORAGE_GENERATION_ID,
      },
    })
    await expect(readActiveOperation(root, signal)).resolves.toBeUndefined()
  })

  it('settles an interrupted upgrade while an exact selected v6 source remains authoritative', async () => {
    const root = await createRoot()
    const signal = AbortSignal.timeout(10_000)
    const selected = await publishHistoricalSealedGeneration(root, 6, signal)
    const before = await readFile(selected.databasePath)
    const authorityBefore = await readFile(join(root, 'installation.json'))
    const journal = createOperationJournal({
      kind: 'upgrade',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      ...V6_UPGRADE_SOURCE,
      backupId: createSakiRecoveryBackupId(),
      candidateStorageGenerationId: CANDIDATE_ID,
    })
    if (journal.kind !== 'upgrade') throw new Error('test journal changed kind')
    await publishActiveOperation(root, journal, signal)

    await recoverActiveSakiOperation(root, join(root, 'unused-legacy.sqlite'), signal)

    expect(await readFile(selected.databasePath)).toEqual(before)
    expect(await readFile(join(root, 'installation.json'))).toEqual(authorityBefore)
    await expect(readInstallationManifest(root, signal)).resolves.toMatchObject({
      value: {
        phase: 'ready',
        stateVersion: 6,
        storageGenerationId: OLD_STORAGE_GENERATION_ID,
      },
    })
    await expect(readActiveOperation(root, signal)).resolves.toBeUndefined()
  })

  it('rolls back an upgrade interrupted before its backup and candidate exist', async () => {
    const root = await createRoot()
    const signal = AbortSignal.timeout(5_000)
    const legacyPath = join(root, 'legacy.sqlite')
    await materializeHistorical(legacyPath, signal)
    const journal = createOperationJournal({
      kind: 'upgrade',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      ...V2_UPGRADE_SOURCE,
      backupId: createSakiRecoveryBackupId(),
      candidateStorageGenerationId: CANDIDATE_ID,
    })
    if (journal.kind !== 'upgrade') throw new Error('test journal changed kind')
    await publishActiveOperation(root, journal, signal)

    await recoverActiveSakiOperation(root, legacyPath, signal)

    await expect(readActiveOperation(root, signal)).resolves.toBeUndefined()
    expect(await exists(join(root, ...journal.backup.finalLeaf.split('/')))).toBe(false)
    expect(await exists(join(root, ...journal.candidate.finalLeaf.split('/')))).toBe(false)
  })

  it.each([
    ['state version', { ...V2_UPGRADE_SOURCE, sourceStateVersion: 3 as const }],
    ['storage generation', {
      ...V2_UPGRADE_SOURCE,
      sourceStorageGenerationId: OTHER_GENERATION_ID,
    }],
    ['build provenance', { ...V2_UPGRADE_SOURCE, sourceBuildId: BUILD_ID }],
  ])('retains a pre-commit manifest-less upgrade whose journal has the wrong source %s', async (
    _subject,
    sourceIdentity,
  ) => {
    const root = await createRoot()
    const signal = AbortSignal.timeout(5_000)
    const legacyPath = join(root, 'legacy.sqlite')
    await materializeHistorical(legacyPath, signal)
    const journal = createOperationJournal({
      kind: 'upgrade',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      ...sourceIdentity,
      backupId: createSakiRecoveryBackupId(),
      candidateStorageGenerationId: CANDIDATE_ID,
    })
    if (journal.kind !== 'upgrade') throw new Error('test journal changed kind')
    await publishActiveOperation(root, journal, signal)

    await expect(recoverActiveSakiOperation(root, legacyPath, signal))
      .rejects.toMatchObject({ code: 'recovery-required' })

    await expect(readActiveOperation(root, signal)).resolves.toMatchObject({
      journal: { operationId: journal.operationId },
    })
  })

  it('propagates an unexpected error while checking for the journal backup', async () => {
    const root = await createRoot()
    const signal = AbortSignal.timeout(5_000)
    const legacyPath = join(root, 'legacy.sqlite')
    await materializeHistorical(legacyPath, signal)
    const journal = createOperationJournal({
      kind: 'upgrade',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      ...V2_UPGRADE_SOURCE,
      backupId: createSakiRecoveryBackupId(),
      candidateStorageGenerationId: CANDIDATE_ID,
    })
    if (journal.kind !== 'upgrade') throw new Error('test journal changed kind')
    await publishActiveOperation(root, journal, signal)
    const failure = Object.assign(new Error('backup entry cannot be inspected'), { code: 'EACCES' })
    filesystem.lstatFailure = {
      path: join(root, ...journal.backup.finalLeaf.split('/')),
      error: failure,
    }

    await expect(recoverActiveSakiOperation(root, legacyPath, signal)).rejects.toBe(failure)
  })

  it('propagates an unexpected failure pruning settled operation metadata', async () => {
    const root = await createRoot()
    const signal = AbortSignal.timeout(5_000)
    const journal = createOperationJournal({
      kind: 'backup',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      backupId: createSakiRecoveryBackupId(),
    })
    if (journal.kind !== 'backup') throw new Error('test journal changed kind')
    await publishActiveOperation(root, journal, signal)
    const failure = Object.assign(new Error('operations directory cannot be pruned'), {
      code: 'EACCES',
    })
    filesystem.rmdirFailure = { path: join(root, 'operations'), error: failure }

    await expect(recoverActiveSakiOperation(
      root,
      join(root, 'legacy.sqlite'),
      signal,
    )).rejects.toBe(failure)

    await expect(readActiveOperation(root, signal)).resolves.toBeUndefined()
  })

  it('rolls back against an exact manifest-selected B03 generation', async () => {
    const root = await createRoot()
    const signal = AbortSignal.timeout(5_000)
    const selected = await publishHistoricalGeneration(root, signal)
    const journal = createOperationJournal({
      kind: 'upgrade',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      ...V2_UPGRADE_SOURCE,
      backupId: createSakiRecoveryBackupId(),
      candidateStorageGenerationId: CANDIDATE_ID,
    })
    if (journal.kind !== 'upgrade') throw new Error('test journal changed kind')
    await publishActiveOperation(root, journal, signal)

    await recoverActiveSakiOperation(root, join(root, 'unused-legacy.sqlite'), signal)

    await expect(readActiveOperation(root, signal)).resolves.toBeUndefined()
    await expect(readFile(selected.databasePath)).resolves.not.toHaveLength(0)
  })

  it('retains a pre-commit manifest-selected upgrade whose journal has the wrong source build', async () => {
    const root = await createRoot()
    const signal = AbortSignal.timeout(5_000)
    await publishHistoricalGeneration(root, signal)
    const journal = createOperationJournal({
      kind: 'upgrade',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      ...V2_UPGRADE_SOURCE,
      sourceBuildId: BUILD_ID,
      backupId: createSakiRecoveryBackupId(),
      candidateStorageGenerationId: CANDIDATE_ID,
    })
    if (journal.kind !== 'upgrade') throw new Error('test journal changed kind')
    await publishActiveOperation(root, journal, signal)

    await expect(recoverActiveSakiOperation(
      root,
      join(root, 'unused-legacy.sqlite'),
      signal,
    )).rejects.toMatchObject({ code: 'recovery-required' })

    await expect(readActiveOperation(root, signal)).resolves.toMatchObject({
      journal: { operationId: journal.operationId },
    })
  })

  it.each([
    ['provisioning', 'provisioning', INSTALLATION_ID, OLD_STORAGE_GENERATION_ID, 2],
    ['another Installation', 'ready', OTHER_INSTALLATION_ID, OLD_STORAGE_GENERATION_ID, 2],
    ['a non-historical state version', 'ready', INSTALLATION_ID, OLD_STORAGE_GENERATION_ID, 9],
    ['the candidate generation', 'ready', INSTALLATION_ID, CANDIDATE_ID, 2],
  ] as const)(
    'retains an upgrade when published authority selects %s',
    async (_subject, phase, installationId, storageGenerationId, stateVersion) => {
      const root = await createRoot()
      const signal = AbortSignal.timeout(5_000)
      const journal = createOperationJournal({
        kind: 'upgrade',
        operationId: createSakiMaintenanceOperationId(),
        installationId: INSTALLATION_ID,
        ...V2_UPGRADE_SOURCE,
        backupId: createSakiRecoveryBackupId(),
        candidateStorageGenerationId: CANDIDATE_ID,
      })
      if (journal.kind !== 'upgrade') throw new Error('test journal changed kind')
      await publishAuthority(
        root,
        phase,
        installationId,
        storageGenerationId,
        stateVersion,
      )
      await publishActiveOperation(root, journal, signal)

      await expect(recoverActiveSakiOperation(
        root,
        join(root, 'legacy.sqlite'),
        signal,
      )).rejects.toMatchObject({ code: 'recovery-required' })

      await expect(readActiveOperation(root, signal)).resolves.toMatchObject({
        journal: { operationId: journal.operationId },
      })
    },
  )

  it('rejects a non-current upgrade candidate before journal-owned cleanup', async () => {
    const root = await createRoot()
    const signal = AbortSignal.timeout(5_000)
    const legacyPath = join(root, 'legacy.sqlite')
    await materializeHistorical(legacyPath, signal)
    const journal = createOperationJournal({
      kind: 'upgrade',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      ...V2_UPGRADE_SOURCE,
      backupId: createSakiRecoveryBackupId(),
      candidateStorageGenerationId: CANDIDATE_ID,
    })
    if (journal.kind !== 'upgrade') throw new Error('test journal changed kind')
    await publishActiveOperation(root, journal, signal)
    const candidatePath = join(root, ...journal.candidate.finalLeaf.split('/'))
    await mkdir(candidatePath, { recursive: true })
    await writeFile(
      join(candidatePath, 'generation.json'),
      renderGenerationManifest(INSTALLATION_ID, CANDIDATE_ID, 2, BUILD_ID),
    )

    await expect(recoverActiveSakiOperation(root, legacyPath, signal))
      .rejects.toMatchObject({ code: 'recovery-required' })

    expect(await exists(candidatePath)).toBe(true)
    await expect(readActiveOperation(root, signal)).resolves.toMatchObject({
      journal: { operationId: journal.operationId },
    })
  })

  it.each([
    ['state version', 3, OLD_STORAGE_GENERATION_ID],
    ['storage generation', 2, OTHER_GENERATION_ID],
  ] as const)(
    'retains an upgrade Recovery Backup with the wrong %s',
    async (_subject, stateVersion, storageGenerationId) => {
      const root = await createRoot()
      const signal = AbortSignal.timeout(5_000)
      const legacyPath = join(root, 'legacy.sqlite')
      await materializeHistorical(legacyPath, signal)
      const journal = createOperationJournal({
        kind: 'upgrade',
        operationId: createSakiMaintenanceOperationId(),
        installationId: INSTALLATION_ID,
        ...V2_UPGRADE_SOURCE,
        backupId: createSakiRecoveryBackupId(),
        candidateStorageGenerationId: CANDIDATE_ID,
      })
      if (journal.kind !== 'upgrade') throw new Error('test journal changed kind')
      await publishActiveOperation(root, journal, signal)
      const backupPath = await createJournalBackup(root, journal, legacyPath, signal, {
        stateVersion,
        storageGenerationId,
      })

      await expect(recoverActiveSakiOperation(root, legacyPath, signal))
        .rejects.toMatchObject({ code: 'recovery-required' })

      expect(await exists(backupPath)).toBe(true)
      await expect(readActiveOperation(root, signal)).resolves.toMatchObject({
        journal: { operationId: journal.operationId },
      })
    },
  )

  it('retains recovery when the backup destination parent is not a directory', async () => {
    const root = await createRoot()
    const signal = AbortSignal.timeout(5_000)
    const legacyPath = join(root, 'legacy.sqlite')
    await materializeHistorical(legacyPath, signal)
    const journal = createOperationJournal({
      kind: 'upgrade',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      ...V2_UPGRADE_SOURCE,
      backupId: createSakiRecoveryBackupId(),
      candidateStorageGenerationId: CANDIDATE_ID,
    })
    if (journal.kind !== 'upgrade') throw new Error('test journal changed kind')
    await publishActiveOperation(root, journal, signal)
    await writeFile(join(root, 'backups'), 'not a directory')
    const failure = Object.assign(new Error('backup parent is not a directory'), { code: 'ENOTDIR' })
    filesystem.lstatFailure = {
      path: join(root, ...journal.backup.finalLeaf.split('/')),
      error: failure,
    }

    await expect(recoverActiveSakiOperation(root, legacyPath, signal))
      .rejects.toMatchObject({ code: 'recovery-required', cause: failure })
  })

  it('retains a committed upgrade whose exact historical backup is missing', async () => {
    const root = await createRoot()
    const signal = AbortSignal.timeout(10_000)
    const prepared = await prepareInterruptedUpgrade(root, true, signal)
    await rm(prepared.backupPath, { recursive: true })

    await expect(recoverActiveSakiOperation(root, prepared.legacyPath, signal))
      .rejects.toMatchObject({ code: 'recovery-required' })

    expect(await exists(prepared.candidatePath)).toBe(true)
    await expect(readActiveOperation(root, signal)).resolves.toBeDefined()
  })

  it.each([
    ['state version', { stateVersion: 3 as const }],
    ['storage generation', { storageGenerationId: OTHER_GENERATION_ID }],
    ['source build', { sourceBuildId: BUILD_ID }],
  ])('retains a committed v2 upgrade whose Recovery Backup has the wrong %s', async (_subject, metadata) => {
    const root = await createRoot()
    const signal = AbortSignal.timeout(10_000)
    const prepared = await prepareInterruptedUpgrade(root, true, signal)
    const active = await readActiveOperation(root, signal)
    if (active?.journal.kind !== 'upgrade') throw new Error('test upgrade journal is missing')
    await rm(prepared.backupPath, { recursive: true })
    await createJournalBackup(root, active.journal, prepared.legacyPath, signal, metadata)

    await expect(recoverActiveSakiOperation(root, prepared.legacyPath, signal))
      .rejects.toMatchObject({ code: 'recovery-required' })

    expect(await exists(prepared.candidatePath)).toBe(true)
    expect(await exists(prepared.backupPath)).toBe(true)
    await expect(readActiveOperation(root, signal)).resolves.toBeDefined()
  })

  it('retains a committed upgrade whose v3 journal has a v2 Recovery Backup', async () => {
    const root = await createRoot()
    const signal = AbortSignal.timeout(10_000)
    const prepared = await prepareInterruptedUpgrade(root, true, signal, V3_UPGRADE_SOURCE)

    await expect(recoverActiveSakiOperation(root, prepared.legacyPath, signal))
      .rejects.toMatchObject({ code: 'recovery-required' })

    expect(await exists(prepared.candidatePath)).toBe(true)
    expect(await exists(prepared.backupPath)).toBe(true)
    await expect(readActiveOperation(root, signal)).resolves.toBeDefined()
  })

  it('finishes a committed upgrade only after exact backup and current-state verification', async () => {
    const root = await createRoot()
    const signal = AbortSignal.timeout(10_000)
    const prepared = await prepareInterruptedUpgrade(root, true, signal)

    await recoverActiveSakiOperation(root, prepared.legacyPath, signal)

    expect(await exists(prepared.candidatePath)).toBe(true)
    expect(await exists(prepared.backupPath)).toBe(true)
    await expect(readActiveOperation(root, signal)).resolves.toBeUndefined()
    await withPreparedSakiServingState({
      installationRoot: root,
      legacyDatabasePath: prepared.legacyPath,
      currentBuildId: BUILD_ID,
    }, signal, async (preparedState) => {
      expect(preparedState).toMatchObject({
        phase: 'ready',
        installationId: INSTALLATION_ID,
        storageGenerationId: CANDIDATE_ID,
      })
    })
  })

  it('settles a previous writable build upgrade journal after its v8 authority commit', async () => {
    const root = await createRoot()
    const signal = AbortSignal.timeout(10_000)
    const legacyPath = join(root, 'legacy.sqlite')
    await materializeHistorical(legacyPath, signal)
    const journal = createOperationJournal({
      kind: 'upgrade',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      ...V2_UPGRADE_SOURCE,
      backupId: createSakiRecoveryBackupId(),
      candidateStorageGenerationId: CANDIDATE_ID,
    })
    if (journal.kind !== 'upgrade') throw new Error('test journal changed kind')
    await publishActiveOperation(root, journal, signal)
    const backupPath = await createJournalBackup(root, journal, legacyPath, signal)
    const databasePath = await publishPreviousWritableCandidate(
      root,
      'ready',
      'upgrade',
      signal,
    )

    await recoverActiveSakiOperation(root, legacyPath, signal)

    await expect(readActiveOperation(root, signal)).resolves.toBeUndefined()
    await expect(readInstallationManifest(root, signal)).resolves.toMatchObject({
      value: {
        phase: 'ready',
        stateVersion: 8,
        storageGenerationId: CANDIDATE_ID,
      },
    })
    await expect(readFile(databasePath)).resolves.not.toHaveLength(0)
    expect(await exists(backupPath)).toBe(true)
  })
})
