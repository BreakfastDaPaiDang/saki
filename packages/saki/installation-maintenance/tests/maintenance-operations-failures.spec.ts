import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SakiBuildId } from '@breakfastdapaidang/saki-control-plane'

type CreateRecoveryBackup = typeof import('../src/recovery-backup.ts')['createRecoveryBackup']
type PublishMissingFile = typeof import('../src/durable-files.ts')['publishMissingFile']
type RandomUuid = typeof import('node:crypto')['randomUUID']
type SelectSource = typeof import('../src/layout.ts')['selectSakiInstallationSource']

const failures = vi.hoisted(() => ({
  backupDirectoryPublished: false,
  cause: new Error('unconfigured maintenance failure'),
  forcedSource: undefined as Awaited<ReturnType<SelectSource>> | undefined,
  manifestPath: undefined as string | undefined,
  manifestPublication: undefined as
    | 'published'
    | 'remove-after-publication'
    | 'downgrade-after-publication'
    | undefined,
  randomUuidValues: [] as string[],
}))

vi.mock('node:crypto', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:crypto')>()
  const randomUUID = vi.fn<RandomUuid>((options) => {
    const value = failures.randomUuidValues.shift()
    return value === undefined
      ? original.randomUUID(options)
      : value as ReturnType<RandomUuid>
  })
  return { ...original, randomUUID }
})

vi.mock('../src/layout.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/layout.ts')>()
  const selectSakiInstallationSource = vi.fn<SelectSource>(async (...arguments_) => {
    return failures.forcedSource
      ?? await original.selectSakiInstallationSource(...arguments_)
  })
  return { ...original, selectSakiInstallationSource }
})

vi.mock('../src/durable-files.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/durable-files.ts')>()
  const filesystem = await import('node:fs/promises')
  const publishMissingFile = vi.fn<PublishMissingFile>(async (...arguments_) => {
    const result = await original.publishMissingFile(...arguments_)
    const path = arguments_[0]
    if (path !== failures.manifestPath) return result
    switch (failures.manifestPublication) {
      case 'published':
        return { outcome: 'published', cause: failures.cause }
      case 'remove-after-publication':
        await filesystem.rm(path)
        return result
      case 'downgrade-after-publication': {
        const value = JSON.parse(Buffer.from(arguments_[1]).toString('utf8')) as Record<string, unknown>
        await filesystem.writeFile(path, Buffer.from(`${JSON.stringify({
          ...value,
          phase: 'provisioning',
        })}\n`, 'utf8'))
        return result
      }
      default:
        return result
    }
  })
  return { ...original, publishMissingFile }
})

vi.mock('../src/recovery-backup.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/recovery-backup.ts')>()
  const createRecoveryBackup = vi.fn<CreateRecoveryBackup>(async (...arguments_) => {
    const result = await original.createRecoveryBackup(...arguments_)
    if (!failures.backupDirectoryPublished) return result
    return {
      outcome: 'published',
      backup: result.backup,
      cause: failures.cause,
    }
  })
  return { ...original, createRecoveryBackup }
})

import {
  createSakiMaintenanceOperations,
  generationManifestReference,
  readInstallationManifest,
  readSelectedGeneration,
  renderGenerationManifest,
  renderInstallationManifest,
} from '../src/index.ts'
import type { SakiMaintenanceOptions } from '../src/index.ts'
import {
  B03_INSTALLATION_ID,
  B03_STORAGE_GENERATION_ID,
  writeB03Database,
} from './b03-fixture.ts'

const roots: string[] = []

async function fixture(): Promise<{ readonly options: SakiMaintenanceOptions; readonly legacy: string }> {
  const installationRoot = await mkdtemp(join(tmpdir(), 'saki-maintenance-failures-'))
  roots.push(installationRoot)
  const legacy = join(installationRoot, 'control.sqlite')
  writeB03Database(legacy)
  return {
    legacy,
    options: {
      installationRoot,
      legacyDatabasePath: legacy,
      currentBuildId: 'saki-build-0.1.0-b18-failure-test' as SakiBuildId,
      legacyBuildId: 'saki-build-0.1.0-b03-failure-test' as SakiBuildId,
    },
  }
}

async function publishSelectedB03(options: SakiMaintenanceOptions): Promise<void> {
  const directory = resolve(
    options.installationRoot,
    'generations',
    B03_STORAGE_GENERATION_ID,
  )
  await mkdir(directory, { recursive: true })
  writeB03Database(join(directory, 'state.sqlite'))
  const generationBytes = renderGenerationManifest(
    B03_INSTALLATION_ID,
    B03_STORAGE_GENERATION_ID,
    2,
    options.legacyBuildId,
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
}

afterEach(async () => {
  failures.backupDirectoryPublished = false
  failures.cause = new Error('unconfigured maintenance failure')
  failures.forcedSource = undefined
  failures.manifestPath = undefined
  failures.manifestPublication = undefined
  failures.randomUuidValues.splice(0)
  vi.clearAllMocks()
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true })
  }))
})

describe('offline Saki maintenance failure boundaries', () => {
  it('rejects a legacy source selected after Installation authority appeared', async () => {
    const { options, legacy } = await fixture()
    await publishSelectedB03(options)
    failures.forcedSource = { kind: 'legacy-v2', databasePath: legacy }

    await expect(createSakiMaintenanceOperations().backup(
      options,
      AbortSignal.timeout(5_000),
    )).rejects.toMatchObject({
      code: 'recovery-required',
      message: 'legacy source was selected despite an Installation manifest',
    })
  })

  it('rejects a selected generation whose Installation authority disappeared', async () => {
    const { options } = await fixture()
    const signal = AbortSignal.timeout(5_000)
    await publishSelectedB03(options)
    const authority = await readInstallationManifest(options.installationRoot, signal)
    if (authority === undefined) throw new Error('test Installation authority is missing')
    const selected = await readSelectedGeneration(options.installationRoot, authority.value, signal)
    await rm(join(options.installationRoot, 'installation.json'))
    failures.forcedSource = { kind: 'selected-generation', selected }

    await expect(createSakiMaintenanceOperations().backup(options, signal))
      .rejects.toMatchObject({
        code: 'recovery-required',
        message: 'selected generation has no Installation manifest evidence',
      })
  })

  it('reports an exact visible Recovery Backup whose directory durability is uncertain', async () => {
    const { options } = await fixture()
    const failure = new Error('Recovery Backup parent sync failed')
    failures.backupDirectoryPublished = true
    failures.cause = failure

    await expect(createSakiMaintenanceOperations().backup(
      options,
      AbortSignal.timeout(10_000),
    )).rejects.toMatchObject({
      code: 'recovery-required',
      cause: failure,
      message: 'Recovery Backup is exact and visible but its directory durability is uncertain',
    })
  })

  it('reports an exact visible upgraded authority whose file durability is uncertain', async () => {
    const { options } = await fixture()
    const failure = new Error('Installation manifest parent sync failed')
    failures.cause = failure
    failures.manifestPath = join(options.installationRoot, 'installation.json')
    failures.manifestPublication = 'published'

    await expect(createSakiMaintenanceOperations().upgrade(
      options,
      AbortSignal.timeout(15_000),
    )).rejects.toMatchObject({
      code: 'recovery-required',
      cause: failure,
      message: 'upgraded Saki Installation manifest is visible but its namespace durability is uncertain',
    })
  })

  it.each([
    ['removed', 'remove-after-publication'],
    ['phase-downgraded', 'downgrade-after-publication'],
  ] as const)(
    'rejects initial upgraded authority readback when it is %s',
    async (_subject, publication) => {
      const { options } = await fixture()
      failures.manifestPath = join(options.installationRoot, 'installation.json')
      failures.manifestPublication = publication

      await expect(createSakiMaintenanceOperations().upgrade(
        options,
        AbortSignal.timeout(15_000),
      )).rejects.toMatchObject({
        code: 'recovery-required',
        message: 'upgraded Installation manifest failed exact readback',
      })
    },
  )

  it('retries a generated candidate identity that collides with retained history', async () => {
    const { options } = await fixture()
    failures.randomUuidValues.push(
      '00000000-0000-4000-8000-000000000011',
      '00000000-0000-4000-8000-000000000009',
      '00000000-0000-4000-8000-000000000012',
      '00000000-0000-4000-8000-000000000013',
    )

    const result = await createSakiMaintenanceOperations().upgrade(
      options,
      AbortSignal.timeout(15_000),
    )

    expect(result.selected.generation.storageGenerationId)
      .toBe('storage-generation-00000000-0000-4000-8000-000000000012')
    expect(result.selected.generation.storageGenerationId).not.toBe(B03_STORAGE_GENERATION_ID)
  })
})
