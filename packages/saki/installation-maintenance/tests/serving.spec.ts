import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { KvUnitSnapshot } from '@deepseek-ai/dsh-storage'
import { descriptorOf, type DomainSpec } from '@deepseek-ai/dsh-storage-domain'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import {
  sakiHostExecutionV1DomainSpec,
  sakiHostExecutionV2DomainSpec,
} from '@breakfastdapaidang/saki-execution-local'
import {
  sakiControlPlaneMigrationPlan,
  sakiControlPlaneV3DomainSpec,
  sakiControlPlaneV4DomainSpec,
  sakiControlPlaneV5DomainSpec,
  sakiControlPlaneV6DomainSpec,
  sakiControlPlaneV7DomainSpec,
  sakiStorageGenerationV1DomainSpec,
  sakiStorageGenerationV2DomainSpec,
  sakiStorageGenerationV3DomainSpec,
  sakiStorageGenerationV4DomainSpec,
  sakiStorageGenerationV5DomainSpec,
  STORAGE_GENERATION_KEY,
  storageGenerationV1SealRecordSchema,
  storageGenerationV2SealRecordSchema,
  storageGenerationV3SealRecordSchema,
  storageGenerationV4SealRecordSchema,
  storageGenerationV5SealRecordSchema,
} from '@breakfastdapaidang/saki-control-plane'
import type {
  SakiBuildId,
  SakiInstallationId,
  SakiStorageGenerationId,
} from '@breakfastdapaidang/saki-control-plane'

type PublishMissingFile = typeof import('../src/durable-files.ts')['publishMissingFile']
type ReplaceFileDurably = typeof import('../src/durable-files.ts')['replaceFileDurably']
type ReadInstallationManifest = typeof import('../src/manifest.ts')['readInstallationManifest']

const durability = vi.hoisted(() => ({
  publishMissingFile: vi.fn<PublishMissingFile>(),
  replaceFileDurably: vi.fn<ReplaceFileDurably>(),
  failedPublishTarget: undefined as string | undefined,
  failedReplaceTarget: undefined as string | undefined,
  failure: undefined as Error | undefined,
}))

const manifestIo = vi.hoisted(() => ({
  readInstallationManifest: vi.fn<ReadInstallationManifest>(),
  originalReadInstallationManifest: undefined as unknown as ReadInstallationManifest,
}))

vi.mock('../src/durable-files.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/durable-files.ts')>()
  durability.publishMissingFile.mockImplementation(async (...arguments_) => {
    if (durability.failedPublishTarget === arguments_[0]) {
      return { outcome: 'published', cause: durability.failure ?? new Error('publish failed') }
    }
    return await original.publishMissingFile(...arguments_)
  })
  durability.replaceFileDurably.mockImplementation(async (...arguments_) => {
    if (durability.failedReplaceTarget === arguments_[0]) {
      return { outcome: 'published', cause: durability.failure ?? new Error('replace failed') }
    }
    return await original.replaceFileDurably(...arguments_)
  })
  return {
    ...original,
    publishMissingFile: durability.publishMissingFile,
    replaceFileDurably: durability.replaceFileDurably,
  }
})

vi.mock('../src/manifest.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/manifest.ts')>()
  manifestIo.originalReadInstallationManifest = original.readInstallationManifest
  manifestIo.readInstallationManifest.mockImplementation(original.readInstallationManifest)
  return { ...original, readInstallationManifest: manifestIo.readInstallationManifest }
})

import {
  generationManifestReference,
  materializeFreshSakiGeneration,
  migrateSakiGeneration,
  readClosedSakiV2State,
  readInstallationManifest,
  renderGenerationManifest,
  renderInstallationManifest,
  withInstallationLease,
  withPreparedSakiServingState,
} from '../src/index.ts'
import {
  B03_INSTALLATION_ID,
  B03_STORAGE_GENERATION_ID,
  writeB03Database,
} from './b03-fixture.ts'

const roots: string[] = []

afterEach(async () => {
  durability.failedPublishTarget = undefined
  durability.failedReplaceTarget = undefined
  durability.failure = undefined
  vi.clearAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'saki-serving-'))
  roots.push(value)
  return value
}

const BUILD_ID = 'saki-build-serving-test' as SakiBuildId
const INSTALLATION_ID =
  'installation-00000000-0000-4000-8000-000000000071' as SakiInstallationId
const GENERATION_ID =
  'storage-generation-00000000-0000-4000-8000-000000000072' as SakiStorageGenerationId

async function publishSelectedGeneration(
  installationRoot: string,
  stateVersion: number,
  phase: 'provisioning' | 'ready',
  materialize: (databasePath: string, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
  installationId: SakiInstallationId = INSTALLATION_ID,
  storageGenerationId: SakiStorageGenerationId = GENERATION_ID,
): Promise<{
  readonly databasePath: string
  readonly generationBytes: Buffer
  readonly provisioningBytes: Buffer
}> {
  const generationDirectory = join(installationRoot, 'generations', storageGenerationId)
  await mkdir(generationDirectory, { recursive: true })
  const databasePath = join(generationDirectory, 'state.sqlite')
  await materialize(databasePath, signal)
  const generationBytes = renderGenerationManifest(
    installationId,
    storageGenerationId,
    stateVersion,
    BUILD_ID,
  )
  await writeFile(join(generationDirectory, 'generation.json'), generationBytes)
  const generation = JSON.parse(generationBytes.toString('utf8')) as Parameters<
    typeof renderInstallationManifest
  >[1]
  const reference = generationManifestReference(storageGenerationId, generationBytes)
  const installationBytes = renderInstallationManifest(phase, generation, reference)
  await writeFile(join(installationRoot, 'installation.json'), installationBytes)
  return {
    databasePath,
    generationBytes,
    provisioningBytes: renderInstallationManifest('provisioning', generation, reference),
  }
}

async function materializeHistoricalSealedGeneration(
  databasePath: string,
  legacyDatabasePath: string,
  stateVersion: 3 | 4 | 5 | 6 | 7,
  signal: AbortSignal,
): Promise<void> {
  const historical = await readClosedSakiV2State(legacyDatabasePath, signal)
  const v3Snapshot = sakiControlPlaneMigrationPlan.steps[0]!.migrate(
    historical.controlPlaneSnapshot,
  )
  const v4Snapshot = sakiControlPlaneMigrationPlan.steps[1]!.migrate(v3Snapshot)
  const v5Snapshot = sakiControlPlaneMigrationPlan.steps[2]!.migrate(v4Snapshot)
  const v6Snapshot = sakiControlPlaneMigrationPlan.steps[3]!.migrate(v5Snapshot)
  const v7Snapshot = sakiControlPlaneMigrationPlan.steps[4]!.migrate(v6Snapshot)
  const units: readonly { readonly spec: DomainSpec; readonly snapshot: KvUnitSnapshot }[] = [
    stateVersion === 3
      ? { spec: sakiControlPlaneV3DomainSpec, snapshot: v3Snapshot }
      : stateVersion === 4
        ? { spec: sakiControlPlaneV4DomainSpec, snapshot: v4Snapshot }
        : stateVersion === 5
          ? { spec: sakiControlPlaneV5DomainSpec, snapshot: v5Snapshot }
          : stateVersion === 6
            ? { spec: sakiControlPlaneV6DomainSpec, snapshot: v6Snapshot }
            : { spec: sakiControlPlaneV7DomainSpec, snapshot: v7Snapshot },
    stateVersion === 3
      ? {
        spec: sakiStorageGenerationV1DomainSpec,
        snapshot: {
          global: null,
          tables: {
            storage_generation: {
              [STORAGE_GENERATION_KEY]: storageGenerationV1SealRecordSchema.parse({
                schemaVersion: 1,
                installationId: B03_INSTALLATION_ID,
                storageGenerationId: B03_STORAGE_GENERATION_ID,
                stateVersion: 3,
                createdByBuildId: BUILD_ID,
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
                  installationId: B03_INSTALLATION_ID,
                  storageGenerationId: B03_STORAGE_GENERATION_ID,
                  stateVersion: 4,
                  createdByBuildId: BUILD_ID,
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
                    installationId: B03_INSTALLATION_ID,
                    storageGenerationId: B03_STORAGE_GENERATION_ID,
                    stateVersion: 5,
                    createdByBuildId: BUILD_ID,
                  }),
                },
              },
            },
          }
          : stateVersion === 6
            ? {
              spec: sakiStorageGenerationV4DomainSpec,
              snapshot: {
                global: null,
                tables: {
                  storage_generation: {
                    [STORAGE_GENERATION_KEY]: storageGenerationV4SealRecordSchema.parse({
                      schemaVersion: 4,
                      installationId: B03_INSTALLATION_ID,
                      storageGenerationId: B03_STORAGE_GENERATION_ID,
                      stateVersion: 6,
                      createdByBuildId: BUILD_ID,
                    }),
                  },
                },
              },
            }
            : {
              spec: sakiStorageGenerationV5DomainSpec,
              snapshot: {
                global: null,
                tables: {
                  storage_generation: {
                    [STORAGE_GENERATION_KEY]: storageGenerationV5SealRecordSchema.parse({
                      schemaVersion: 5,
                      installationId: B03_INSTALLATION_ID,
                      storageGenerationId: B03_STORAGE_GENERATION_ID,
                      stateVersion: 7,
                      createdByBuildId: BUILD_ID,
                    }),
                  },
                },
              },
            },
    ...(stateVersion === 5 || stateVersion === 6 || stateVersion === 7
      ? [{
        spec: stateVersion === 7 ? sakiHostExecutionV2DomainSpec : sakiHostExecutionV1DomainSpec,
        snapshot: {
          global: null,
          tables: { operations: {} },
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

describe('Saki serving Installation scope', () => {
  it('rejects non-filesystem Installation and legacy paths before serving', async () => {
    const installationRoot = await root()
    const signal = AbortSignal.timeout(2_000)

    await expect(withPreparedSakiServingState({
      installationRoot: ':memory:',
      legacyDatabasePath: join(installationRoot, 'control.sqlite'),
      currentBuildId: BUILD_ID,
    }, signal, async () => undefined)).rejects.toThrow(
      'Saki Installation root must be an absolute filesystem path',
    )
    await expect(withPreparedSakiServingState({
      installationRoot,
      legacyDatabasePath: 'control.sqlite',
      currentBuildId: BUILD_ID,
    }, signal, async () => undefined)).rejects.toThrow(
      'legacy Saki database path must be an absolute filesystem path',
    )
  })

  it('publishes fresh state as non-serving provisioning and resumes the exact selection', async () => {
    const installationRoot = await root()
    const options = {
      installationRoot,
      legacyDatabasePath: join(installationRoot, 'control.sqlite'),
      currentBuildId: BUILD_ID,
    }
    const signal = new AbortController().signal
    let firstDatabasePath = ''

    await withPreparedSakiServingState(options, signal, async (prepared) => {
      expect(prepared.phase).toBe('provisioning')
      firstDatabasePath = prepared.databasePath
      const contender = withInstallationLease(installationRoot, signal, async () => undefined)
      await expect(contender).rejects.toMatchObject({ code: 'lease-busy' })
    })

    const manifest = await readInstallationManifest(installationRoot, signal)
    expect(manifest?.value.phase).toBe('provisioning')
    await expect(readFile(firstDatabasePath)).resolves.not.toHaveLength(0)
    await withPreparedSakiServingState(options, signal, async (prepared) => {
      expect(prepared.phase).toBe('provisioning')
      expect(prepared.databasePath).toBe(firstDatabasePath)
    })
  })

  it('classifies a missing manifest-selected database as recovery-required', async () => {
    const installationRoot = await root()
    const options = {
      installationRoot,
      legacyDatabasePath: join(installationRoot, 'control.sqlite'),
      currentBuildId: BUILD_ID,
    }
    const signal = new AbortController().signal
    let selectedDatabasePath = ''
    await withPreparedSakiServingState(options, signal, async (prepared) => {
      selectedDatabasePath = prepared.databasePath
    })
    await rm(selectedDatabasePath)

    await expect(withPreparedSakiServingState(
      options,
      signal,
      async () => undefined,
    )).rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('promotes only the exact provisioning authority and then serves it as ready', async () => {
    const installationRoot = await root()
    const options = {
      installationRoot,
      legacyDatabasePath: join(installationRoot, 'control.sqlite'),
      currentBuildId: BUILD_ID,
    }
    const signal = AbortSignal.timeout(5_000)

    await withPreparedSakiServingState(options, signal, async (prepared) => {
      expect(prepared.phase).toBe('provisioning')
      if (prepared.phase !== 'provisioning') throw new Error('fresh state was not provisioning')
      await prepared.promoteToReady(signal)
    })

    await expect(readInstallationManifest(installationRoot, signal)).resolves.toMatchObject({
      value: { phase: 'ready', stateVersion: 8 },
    })
  })

  it('serves an exact manifest-selected current generation as ready', async () => {
    const installationRoot = await root()
    const sourceRoot = await root()
    const sourcePath = join(sourceRoot, 'legacy.sqlite')
    writeB03Database(sourcePath)
    const signal = AbortSignal.timeout(10_000)
    const published = await publishSelectedGeneration(
      installationRoot,
      8,
      'ready',
      async (databasePath, activeSignal) => {
        await migrateSakiGeneration(sourcePath, databasePath, {
          installationId: B03_INSTALLATION_ID,
          storageGenerationId: GENERATION_ID,
          createdByBuildId: BUILD_ID,
        }, activeSignal, undefined)
      },
      signal,
      B03_INSTALLATION_ID,
      GENERATION_ID,
    )

    await withPreparedSakiServingState({
      installationRoot,
      legacyDatabasePath: join(installationRoot, 'unused.sqlite'),
      currentBuildId: BUILD_ID,
    }, signal, async (prepared) => {
      expect(prepared).toMatchObject({
        phase: 'ready',
        databasePath: published.databasePath,
        installationId: B03_INSTALLATION_ID,
        storageGenerationId: GENERATION_ID,
      })
    })
  })

  it('refuses activation after the provisioning authority disappears', async () => {
    const installationRoot = await root()
    const options = {
      installationRoot,
      legacyDatabasePath: join(installationRoot, 'control.sqlite'),
      currentBuildId: BUILD_ID,
    }
    const signal = AbortSignal.timeout(5_000)
    await withPreparedSakiServingState(options, signal, async () => undefined)

    await withPreparedSakiServingState(options, signal, async (prepared) => {
      if (prepared.phase !== 'provisioning') throw new Error('test state was not provisioning')
      await unlink(join(installationRoot, 'installation.json'))
      await expect(prepared.promoteToReady(signal))
        .rejects.toMatchObject({ code: 'recovery-required' })
    })
  })

  it('refuses activation after the provisioning authority changes bytes', async () => {
    const installationRoot = await root()
    const options = {
      installationRoot,
      legacyDatabasePath: join(installationRoot, 'control.sqlite'),
      currentBuildId: BUILD_ID,
    }
    const signal = AbortSignal.timeout(5_000)
    await withPreparedSakiServingState(options, signal, async () => undefined)
    const provisioning = await manifestIo.originalReadInstallationManifest(installationRoot, signal)
    if (provisioning === undefined) throw new Error('test provisioning manifest is missing')
    const changedBytes = Buffer.from(`${JSON.stringify({
      ...provisioning.value,
      phase: 'ready',
    })}\n`, 'utf8')

    await withPreparedSakiServingState(options, signal, async (prepared) => {
      if (prepared.phase !== 'provisioning') throw new Error('test state was not provisioning')
      await writeFile(join(installationRoot, 'installation.json'), changedBytes)
      await expect(prepared.promoteToReady(signal))
        .rejects.toMatchObject({ code: 'recovery-required' })
    })
  })

  it('requires durable namespace evidence for the provisioning manifest', async () => {
    const installationRoot = await root()
    const failure = new Error('provisioning manifest parent sync failed')
    durability.failedPublishTarget = join(installationRoot, 'installation.json')
    durability.failure = failure

    await expect(withPreparedSakiServingState({
      installationRoot,
      legacyDatabasePath: join(installationRoot, 'control.sqlite'),
      currentBuildId: BUILD_ID,
    }, AbortSignal.timeout(5_000), async () => undefined)).rejects.toMatchObject({
      code: 'recovery-required',
      cause: failure,
    })
  })

  it('requires durable namespace evidence for the ready manifest', async () => {
    const installationRoot = await root()
    const options = {
      installationRoot,
      legacyDatabasePath: join(installationRoot, 'control.sqlite'),
      currentBuildId: BUILD_ID,
    }
    const signal = AbortSignal.timeout(5_000)
    await withPreparedSakiServingState(options, signal, async () => undefined)
    const failure = new Error('ready manifest parent sync failed')
    durability.failedReplaceTarget = join(installationRoot, 'installation.json')
    durability.failure = failure

    await withPreparedSakiServingState(options, signal, async (prepared) => {
      if (prepared.phase !== 'provisioning') throw new Error('test state was not provisioning')
      await expect(prepared.promoteToReady(signal)).rejects.toMatchObject({
        code: 'recovery-required',
        cause: failure,
      })
    })
  })

  it.each([
    ['missing', undefined],
    ['changed', 'provisioning'],
  ] as const)(
    'requires exact ready-manifest readback when it is %s',
    async (_subject, readbackKind) => {
      const installationRoot = await root()
      const options = {
        installationRoot,
        legacyDatabasePath: join(installationRoot, 'control.sqlite'),
        currentBuildId: BUILD_ID,
      }
      const signal = AbortSignal.timeout(5_000)
      await withPreparedSakiServingState(options, signal, async () => undefined)
      const provisioning = await manifestIo.originalReadInstallationManifest(installationRoot, signal)
      if (provisioning === undefined) throw new Error('test provisioning manifest is missing')
      manifestIo.readInstallationManifest
        .mockImplementationOnce(manifestIo.originalReadInstallationManifest)
        .mockImplementationOnce(manifestIo.originalReadInstallationManifest)
        .mockImplementationOnce(manifestIo.originalReadInstallationManifest)
        .mockResolvedValueOnce(readbackKind === undefined ? undefined : provisioning)

      await withPreparedSakiServingState(options, signal, async (prepared) => {
        if (prepared.phase !== 'provisioning') throw new Error('test state was not provisioning')
        await expect(prepared.promoteToReady(signal))
          .rejects.toMatchObject({ code: 'recovery-required' })
      })
    },
  )

  it.each([
    ['missing', undefined],
    ['different', 'other'],
  ] as const)(
    'requires exact fresh-manifest readback when it is %s',
    async (_subject, readbackKind) => {
      const installationRoot = await root()
      let different
      if (readbackKind !== undefined) {
        const otherRoot = await root()
        await publishSelectedGeneration(
          otherRoot,
          8,
          'ready',
          async (databasePath) => {
            await writeFile(databasePath, 'unsupported')
          },
          AbortSignal.timeout(2_000),
        )
        different = await manifestIo.originalReadInstallationManifest(
          otherRoot,
          AbortSignal.timeout(2_000),
        )
      }
      manifestIo.readInstallationManifest
        .mockImplementationOnce(manifestIo.originalReadInstallationManifest)
        .mockResolvedValueOnce(readbackKind === undefined ? undefined : different)

      await expect(withPreparedSakiServingState({
        installationRoot,
        legacyDatabasePath: join(installationRoot, 'control.sqlite'),
        currentBuildId: BUILD_ID,
      }, AbortSignal.timeout(5_000), async () => undefined))
        .rejects.toMatchObject({ code: 'recovery-required' })
    },
  )

  it.each([
    ['missing', undefined],
    ['ready', 'ready'],
  ] as const)(
    'requires a provisioning manifest after closed-state preflight when it is %s',
    async (_subject, rereadPhase) => {
      const installationRoot = await root()
      const signal = AbortSignal.timeout(5_000)
      const published = await publishSelectedGeneration(
        installationRoot,
        8,
        'provisioning',
        async (databasePath, activeSignal) => {
          await materializeFreshSakiGeneration(databasePath, {
            installationId: INSTALLATION_ID,
            storageGenerationId: GENERATION_ID,
            createdByBuildId: BUILD_ID,
          }, activeSignal)
        },
        signal,
      )
      const provisioning = await manifestIo.originalReadInstallationManifest(installationRoot, signal)
      if (provisioning === undefined) throw new Error('test provisioning manifest is missing')
      const readyBytes = Buffer.from(`${JSON.stringify({
        ...provisioning.value,
        phase: 'ready',
      })}\n`, 'utf8')
      const ready = {
        ...provisioning,
        value: { ...provisioning.value, phase: 'ready' as const },
        bytes: readyBytes,
        byteLength: readyBytes.byteLength,
      }
      manifestIo.readInstallationManifest
        .mockImplementationOnce(manifestIo.originalReadInstallationManifest)
        .mockResolvedValueOnce(rereadPhase === undefined ? undefined : ready)

      await expect(withPreparedSakiServingState({
        installationRoot,
        legacyDatabasePath: join(installationRoot, 'control.sqlite'),
        currentBuildId: BUILD_ID,
      }, signal, async () => undefined)).rejects.toMatchObject({ code: 'recovery-required' })
      await expect(readFile(published.databasePath)).resolves.not.toHaveLength(0)
    },
  )

  it('rejects a valid selected B03 generation until offline upgrade', async () => {
    const installationRoot = await root()
    const signal = AbortSignal.timeout(5_000)
    await publishSelectedGeneration(
      installationRoot,
      2,
      'ready',
      async (databasePath) => {
        writeB03Database(databasePath)
      },
      signal,
      B03_INSTALLATION_ID,
      B03_STORAGE_GENERATION_ID,
    )

    await expect(withPreparedSakiServingState({
      installationRoot,
      legacyDatabasePath: join(installationRoot, 'unused.sqlite'),
      currentBuildId: BUILD_ID,
    }, signal, async () => undefined)).rejects.toMatchObject({ code: 'upgrade-required' })
  })

  it('rejects a valid selected v3 generation until offline upgrade', async () => {
    const installationRoot = await root()
    const sourceRoot = await root()
    const legacyDatabasePath = join(sourceRoot, 'control.sqlite')
    writeB03Database(legacyDatabasePath)
    const signal = AbortSignal.timeout(10_000)
    await publishSelectedGeneration(
      installationRoot,
      3,
      'ready',
      async (databasePath, activeSignal) => {
        await materializeHistoricalSealedGeneration(databasePath, legacyDatabasePath, 3, activeSignal)
      },
      signal,
      B03_INSTALLATION_ID,
      B03_STORAGE_GENERATION_ID,
    )

    await expect(withPreparedSakiServingState({
      installationRoot,
      legacyDatabasePath: join(installationRoot, 'unused.sqlite'),
      currentBuildId: BUILD_ID,
    }, signal, async () => undefined)).rejects.toMatchObject({
      code: 'upgrade-required',
      message: 'Saki state version 3 is valid but requires the offline upgrade command before serving',
    })
  })

  it('rejects a valid selected v4 generation until offline upgrade without invoking the server', async () => {
    const installationRoot = await root()
    const sourceRoot = await root()
    const legacyDatabasePath = join(sourceRoot, 'control.sqlite')
    writeB03Database(legacyDatabasePath)
    const signal = AbortSignal.timeout(10_000)
    await publishSelectedGeneration(
      installationRoot,
      4,
      'ready',
      async (databasePath, activeSignal) => {
        await materializeHistoricalSealedGeneration(databasePath, legacyDatabasePath, 4, activeSignal)
      },
      signal,
      B03_INSTALLATION_ID,
      B03_STORAGE_GENERATION_ID,
    )
    const serve = vi.fn(async () => undefined)

    await expect(withPreparedSakiServingState({
      installationRoot,
      legacyDatabasePath: join(installationRoot, 'unused.sqlite'),
      currentBuildId: BUILD_ID,
    }, signal, serve)).rejects.toMatchObject({
      code: 'upgrade-required',
      message: 'Saki state version 4 is valid but requires the offline upgrade command before serving',
    })
    expect(serve).not.toHaveBeenCalled()
  })

  it('rejects a valid selected v5 generation until offline upgrade without invoking the server', async () => {
    const installationRoot = await root()
    const sourceRoot = await root()
    const legacyDatabasePath = join(sourceRoot, 'control.sqlite')
    writeB03Database(legacyDatabasePath)
    const signal = AbortSignal.timeout(10_000)
    await publishSelectedGeneration(
      installationRoot,
      5,
      'ready',
      async (databasePath, activeSignal) => {
        await materializeHistoricalSealedGeneration(databasePath, legacyDatabasePath, 5, activeSignal)
      },
      signal,
      B03_INSTALLATION_ID,
      B03_STORAGE_GENERATION_ID,
    )
    const serve = vi.fn(async () => undefined)

    await expect(withPreparedSakiServingState({
      installationRoot,
      legacyDatabasePath: join(installationRoot, 'unused.sqlite'),
      currentBuildId: BUILD_ID,
    }, signal, serve)).rejects.toMatchObject({
      code: 'upgrade-required',
      message: 'Saki state version 5 is valid but requires the offline upgrade command before serving',
    })
    expect(serve).not.toHaveBeenCalled()
  })

  it('rejects a valid selected v6 generation until offline upgrade without invoking the server', async () => {
    const installationRoot = await root()
    const sourceRoot = await root()
    const legacyDatabasePath = join(sourceRoot, 'control.sqlite')
    writeB03Database(legacyDatabasePath)
    const signal = AbortSignal.timeout(10_000)
    await publishSelectedGeneration(
      installationRoot,
      6,
      'ready',
      async (databasePath, activeSignal) => {
        await materializeHistoricalSealedGeneration(databasePath, legacyDatabasePath, 6, activeSignal)
      },
      signal,
      B03_INSTALLATION_ID,
      B03_STORAGE_GENERATION_ID,
    )
    const serve = vi.fn(async () => undefined)

    await expect(withPreparedSakiServingState({
      installationRoot,
      legacyDatabasePath: join(installationRoot, 'unused.sqlite'),
      currentBuildId: BUILD_ID,
    }, signal, serve)).rejects.toMatchObject({
      code: 'upgrade-required',
      message: 'Saki state version 6 is valid but requires the offline upgrade command before serving',
    })
    expect(serve).not.toHaveBeenCalled()
  })

  it('rejects a valid selected v7 generation until offline upgrade without invoking the server', async () => {
    const installationRoot = await root()
    const sourceRoot = await root()
    const legacyDatabasePath = join(sourceRoot, 'control.sqlite')
    writeB03Database(legacyDatabasePath)
    const signal = AbortSignal.timeout(10_000)
    await publishSelectedGeneration(
      installationRoot,
      7,
      'ready',
      async (databasePath, activeSignal) => {
        await materializeHistoricalSealedGeneration(databasePath, legacyDatabasePath, 7, activeSignal)
      },
      signal,
      B03_INSTALLATION_ID,
      B03_STORAGE_GENERATION_ID,
    )
    const serve = vi.fn(async () => undefined)

    await expect(withPreparedSakiServingState({
      installationRoot,
      legacyDatabasePath: join(installationRoot, 'unused.sqlite'),
      currentBuildId: BUILD_ID,
    }, signal, serve)).rejects.toMatchObject({
      code: 'upgrade-required',
      message: 'Saki state version 7 is valid but requires the offline upgrade command before serving',
    })
    expect(serve).not.toHaveBeenCalled()
  })

  it('rejects a manifest-selected state version this build cannot read', async () => {
    const installationRoot = await root()
    const signal = AbortSignal.timeout(5_000)
    await publishSelectedGeneration(
      installationRoot,
      9,
      'ready',
      async (databasePath) => {
        await writeFile(databasePath, 'unsupported')
      },
      signal,
    )

    await expect(withPreparedSakiServingState({
      installationRoot,
      legacyDatabasePath: join(installationRoot, 'unused.sqlite'),
      currentBuildId: BUILD_ID,
    }, signal, async () => undefined)).rejects.toMatchObject({ code: 'state-unsupported' })
  })

  it('rejects a valid manifest-less B03 source until offline upgrade', async () => {
    const installationRoot = await root()
    const legacyDatabasePath = join(installationRoot, 'control.sqlite')
    writeB03Database(legacyDatabasePath)

    await expect(withPreparedSakiServingState({
      installationRoot,
      legacyDatabasePath,
      currentBuildId: BUILD_ID,
    }, AbortSignal.timeout(5_000), async () => undefined))
      .rejects.toMatchObject({ code: 'upgrade-required' })
  })
})
