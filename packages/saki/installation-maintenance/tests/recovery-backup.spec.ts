import { existsSync, renameSync } from 'node:fs'
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  SakiBuildId,
  SakiInstallationId,
  SakiStorageGenerationId,
} from '@breakfastdapaidang/saki-control-plane'
import { captureSqliteArtifactSet } from '../src/artifacts.ts'
import type { SakiRecoveryBackupId } from '../src/journal.ts'
import {
  createRecoveryBackup,
  createRecoveryBackupStore,
  MissingTargetReservationError,
  recoveryBackupManifestSchema,
  RecoveryBackupOutcomeUnknownError,
  renderRecoveryBackupManifest,
  verifyRecoveryBackup,
  withMissingRecoveryBackupTarget,
} from '../src/recovery-backup.ts'
import type {
  MissingTargetReservation,
  RecoveryBackupCreateRequest,
  RecoveryBackupStore,
  RecoveryBackupWindowsAcl,
} from '../src/recovery-backup.ts'
import { sakiStateCapability, type SakiStateCapability } from '../src/state-version.ts'
import {
  protectRecoveryBackupPathWin32,
  requireRecoveryBackupPathOwnerOnlyWin32,
} from '../src/recovery-backup-win32.ts'

const INSTALLATION_ID = 'installation-00000000-0000-4000-8000-000000000001' as SakiInstallationId
const STORAGE_GENERATION_ID = 'storage-generation-00000000-0000-4000-8000-000000000002' as SakiStorageGenerationId
const BACKUP_ID = 'backup-00000000-0000-4000-8000-000000000003' as SakiRecoveryBackupId
const OTHER_BACKUP_ID = 'backup-00000000-0000-4000-8000-000000000004' as SakiRecoveryBackupId
const SOURCE_BUILD_ID = 'saki-source-test+42' as SakiBuildId
const roots: string[] = []
const processPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
if (processPlatformDescriptor === undefined) throw new Error('process.platform descriptor is missing')

function setProcessPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...processPlatformDescriptor, value: platform })
}

const v2 = sakiStateCapability.resolveReadable(2)
if (v2 === undefined) throw new Error('test requires readable Saki state v2')
const v2Capability: SakiStateCapability = Object.freeze({
  readable: Object.freeze([v2]),
  writable: sakiStateCapability.writable,
  resolveReadable: (version: number) => version === 2 ? v2 : undefined,
})

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'saki-recovery-backup-'))
  roots.push(value)
  return value
}

afterEach(async () => {
  Object.defineProperty(process, 'platform', processPlatformDescriptor)
  vi.doUnmock('koffi')
  vi.resetModules()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function request(stateVersion: 2 | 3 = 3): RecoveryBackupCreateRequest {
  return {
    installationId: INSTALLATION_ID,
    storageGenerationId: STORAGE_GENERATION_ID,
    stateVersion,
    sourceBuildId: SOURCE_BUILD_ID,
  }
}

function testStore(
  effects: Parameters<typeof createRecoveryBackupStore>[0] = {},
): RecoveryBackupStore {
  return createRecoveryBackupStore({
    platform: 'posix',
    syncDirectory: async () => {},
    ...effects,
  })
}

function testWindowsAcl(
  overrides: Partial<RecoveryBackupWindowsAcl> = {},
): RecoveryBackupWindowsAcl {
  return {
    protect: async () => {},
    require: async () => {},
    ...overrides,
  }
}

function testWindowsStore(windowsAcl: RecoveryBackupWindowsAcl): RecoveryBackupStore {
  return createRecoveryBackupStore({
    platform: 'win32',
    windowsAcl,
    moveDirectoryWin32: async (from, to) => {
      await rename(from, to)
    },
  })
}

async function sourceAt(
  installationRoot: string,
  leaf = 'selected-v2.sqlite',
): Promise<Awaited<ReturnType<typeof captureSqliteArtifactSet>>> {
  const sourceDirectory = join(installationRoot, 'source')
  await mkdir(sourceDirectory)
  const databasePath = join(sourceDirectory, leaf)
  await writeFile(databasePath, Buffer.from([0, 1, 2, 3, 4, 5]))
  await writeFile(`${databasePath}-wal`, Buffer.from([6, 7, 8]))
  await writeFile(`${databasePath}-shm`, Buffer.from([9, 10]))
  await writeFile(`${databasePath}-journal`, Buffer.from([11]))
  return await captureSqliteArtifactSet(databasePath, AbortSignal.timeout(2_000))
}

async function publish(
  installationRoot: string,
  backupId = BACKUP_ID,
  stateVersion: 2 | 3 = 3,
  capability: SakiStateCapability = sakiStateCapability,
  store: RecoveryBackupStore = testStore(),
): Promise<Awaited<ReturnType<RecoveryBackupStore['create']>>> {
  const source = await sourceAt(installationRoot)
  return await store.withMissingTarget(
    installationRoot,
    backupId,
    AbortSignal.timeout(2_000),
    async reservation => await store.create(
      reservation,
      source,
      request(stateVersion),
      capability,
      AbortSignal.timeout(2_000),
    ),
  )
}

function finalDirectory(installationRoot: string, backupId = BACKUP_ID): string {
  return join(installationRoot, 'backups', backupId)
}

async function rewriteManifest(
  installationRoot: string,
  mutate: (value: Record<string, unknown>) => void,
  backupId = BACKUP_ID,
): Promise<void> {
  const path = join(finalDirectory(installationRoot, backupId), 'backup.json')
  const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  mutate(value)
  await writeFile(path, `${JSON.stringify(value)}\n`)
}

function stripNamespace(path: string): string {
  if (path.startsWith('\\\\?\\UNC\\')) return `\\\\${path.slice('\\\\?\\UNC\\'.length)}`
  if (path.startsWith('\\\\?\\')) return path.slice('\\\\?\\'.length)
  return path
}

async function importWithNativeMove(
  move: (existing: string, replacement: string, flags: number) => number,
  getLastError: () => number = () => 0,
): Promise<typeof import('../src/recovery-backup.ts')> {
  setProcessPlatform('win32')
  vi.resetModules()
  vi.doMock('koffi', () => ({
    default: {
      load: (library: string) => {
        expect(library).toBe('kernel32.dll')
        return {
          func: (convention: string, name: string, result: string, args: string[]) => {
            expect(convention).toBe('__stdcall')
            if (name === 'MoveFileExW') {
              expect([result, args]).toEqual(['int', ['str16', 'str16', 'uint']])
              return move
            }
            expect([name, result, args]).toEqual(['GetLastError', 'uint', []])
            return getLastError
          },
        }
      },
    },
  }))
  return await import('../src/recovery-backup.ts')
}

describe('Saki Recovery Backup primitive', () => {
  it('rejects incomplete, duplicated, and out-of-order canonical inventories', () => {
    const base = {
      formatVersion: 1,
      purpose: 'recovery-backup',
      backupId: BACKUP_ID,
      installationId: INSTALLATION_ID,
      storageGenerationId: STORAGE_GENERATION_ID,
      stateVersion: 3,
      sourceBuildId: SOURCE_BUILD_ID,
      databaseLeaf: 'state.sqlite',
    } as const
    const database = {
      role: 'database',
      suffix: '',
      byteLength: 1,
      sha256: '0'.repeat(64),
    } as const
    const wal = {
      role: 'wal',
      suffix: '-wal',
      byteLength: 1,
      sha256: '1'.repeat(64),
    } as const

    expect(recoveryBackupManifestSchema.safeParse({ ...base, artifacts: [wal] }).success).toBe(false)
    expect(recoveryBackupManifestSchema.safeParse({ ...base, artifacts: [database, wal, wal] }).success)
      .toBe(false)
    expect(recoveryBackupManifestSchema.safeParse({ ...base, artifacts: [database, wal, database] }).success)
      .toBe(false)
    expect(renderRecoveryBackupManifest({ ...base, artifacts: [database] }))
      .toEqual(Buffer.from(`${JSON.stringify({ ...base, artifacts: [database] })}\n`))
  })

  it('publishes canonical owner-only artifacts and leaves the captured source unchanged', async () => {
    const installationRoot = await root()
    const source = await sourceAt(installationRoot, 'legacy.sqlite')
    const sourceBytes = await Promise.all(source.artifacts.map(async artifact => await readFile(artifact.path)))
    const store = testStore()

    const result = await store.withMissingTarget(
      installationRoot,
      BACKUP_ID,
      AbortSignal.timeout(2_000),
      async reservation => await store.create(
        reservation,
        source,
        request(),
        sakiStateCapability,
        AbortSignal.timeout(2_000),
      ),
    )

    expect(result.outcome).toBe('durable')
    expect(result.backup.manifest).toEqual({
      formatVersion: 1,
      purpose: 'recovery-backup',
      backupId: BACKUP_ID,
      installationId: INSTALLATION_ID,
      storageGenerationId: STORAGE_GENERATION_ID,
      stateVersion: 3,
      sourceBuildId: SOURCE_BUILD_ID,
      databaseLeaf: 'state.sqlite',
      artifacts: source.artifacts.map(({ role, suffix, byteLength, sha256 }) => ({
        role,
        suffix,
        byteLength,
        sha256,
      })),
    })
    const directory = finalDirectory(installationRoot)
    expect((await readdir(directory)).sort()).toEqual([
      'backup.json',
      'state.sqlite',
      'state.sqlite-journal',
      'state.sqlite-shm',
      'state.sqlite-wal',
    ])
    const metadata = await readFile(join(directory, 'backup.json'))
    expect(metadata).toEqual(Buffer.from(`${JSON.stringify(result.backup.manifest)}\n`, 'utf8'))
    if (process.platform !== 'win32') {
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
      for (const leaf of await readdir(directory)) {
        expect((await stat(join(directory, leaf))).mode & 0o777).toBe(0o600)
      }
    }
    await expect(stat(`${directory}.partial`)).rejects.toMatchObject({ code: 'ENOENT' })
    for (const [index, artifact] of source.artifacts.entries()) {
      expect(await readFile(artifact.path)).toEqual(sourceBytes[index])
    }
  })

  it('exposes the narrow default helpers and bound verifier', async () => {
    const installationRoot = await root()
    const source = await sourceAt(installationRoot)

    const publication = await withMissingRecoveryBackupTarget(
      installationRoot,
      BACKUP_ID,
      AbortSignal.timeout(2_000),
      async reservation => await createRecoveryBackup(
        reservation,
        source,
        request(),
        sakiStateCapability,
        AbortSignal.timeout(2_000),
      ),
    )

    expect(publication.outcome).toBe('durable')
    await expect(testStore().verify(
      installationRoot,
      BACKUP_ID,
      sakiStateCapability,
      AbortSignal.timeout(2_000),
    )).resolves.toMatchObject({ manifest: { backupId: BACKUP_ID } })
  })

  it('enforces owner-only modes on POSIX Hosts', async () => {
    if (process.platform === 'win32') return
    const installationRoot = await root()
    await publish(installationRoot)
    const directory = finalDirectory(installationRoot)
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    for (const leaf of await readdir(directory)) {
      expect((await stat(join(directory, leaf))).mode & 0o777).toBe(0o600)
    }
  })

  it('round-trips protected owner-plus-LocalSystem ACLs on Windows', async () => {
    if (process.platform !== 'win32') return
    const directory = await root()

    await expect(requireRecoveryBackupPathOwnerOnlyWin32(
      directory,
      'directory',
      AbortSignal.timeout(2_000),
    )).rejects.toThrow(/not protected|ambient|missing/u)
    await protectRecoveryBackupPathWin32(
      directory,
      'directory',
      AbortSignal.timeout(2_000),
    )
    await expect(requireRecoveryBackupPathOwnerOnlyWin32(
      directory,
      'directory',
      AbortSignal.timeout(2_000),
    )).resolves.toBeUndefined()

    const inheritedFile = join(directory, 'inherited')
    await writeFile(inheritedFile, 'owner-only parent, inherited child')
    await expect(requireRecoveryBackupPathOwnerOnlyWin32(
      inheritedFile,
      'file',
      AbortSignal.timeout(2_000),
    )).rejects.toThrow(/not protected|non-owner-only/u)
    await protectRecoveryBackupPathWin32(
      inheritedFile,
      'file',
      AbortSignal.timeout(2_000),
    )
    await expect(requireRecoveryBackupPathOwnerOnlyWin32(
      inheritedFile,
      'file',
      AbortSignal.timeout(2_000),
    )).resolves.toBeUndefined()

    const installationRoot = await root()
    await publish(installationRoot)
    const metadataPath = join(finalDirectory(installationRoot), 'backup.json')
    const metadata = await readFile(metadataPath)
    await rm(metadataPath)
    await writeFile(metadataPath, metadata)
    await expect(verifyRecoveryBackup(
      installationRoot,
      BACKUP_ID,
      sakiStateCapability,
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('fails closed around injected Windows ACL application and final verification faults', async () => {
    const directoryFailure = new Error('partial directory DACL failed')
    const directoryRoot = await root()
    const directoryStore = testWindowsStore(testWindowsAcl({
      protect: async (_path, kind) => {
        if (kind === 'directory') throw directoryFailure
      },
    }))
    await expect(directoryStore.withMissingTarget(
      directoryRoot,
      BACKUP_ID,
      AbortSignal.timeout(2_000),
      () => undefined,
    )).rejects.toMatchObject({ code: 'recovery-required' })

    const fileFailure = new Error('artifact DACL failed')
    const fileRoot = await root()
    const source = await sourceAt(fileRoot)
    const fileStore = testWindowsStore(testWindowsAcl({
      protect: async (path, kind) => {
        if (kind === 'file') {
          expect((await stat(path)).size).toBe(0)
          throw fileFailure
        }
      },
    }))
    await expect(fileStore.withMissingTarget(
      fileRoot,
      BACKUP_ID,
      AbortSignal.timeout(2_000),
      async reservation => await fileStore.create(
        reservation,
        source,
        request(),
        sakiStateCapability,
        AbortSignal.timeout(2_000),
      ),
    )).rejects.toMatchObject({ code: 'recovery-required' })
    await expect(readFile(join(`${finalDirectory(fileRoot)}.partial`, 'state.sqlite')))
      .resolves.toHaveLength(0)

    const publishedRoot = await root()
    const permissiveStore = testWindowsStore(testWindowsAcl())
    await publish(
      publishedRoot,
      BACKUP_ID,
      3,
      sakiStateCapability,
      permissiveStore,
    )
    const verificationFailure = new Error('final DACL is ambient')
    const rejectingStore = testWindowsStore(testWindowsAcl({
      require: async () => {
        throw verificationFailure
      },
    }))
    await expect(rejectingStore.verify(
      publishedRoot,
      BACKUP_ID,
      sakiStateCapability,
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'recovery-required' })

    const nonErrorRoot = await root()
    const nonErrorFailure = 'non-Error finalization rejection'
    const nonErrorStore = testStore({
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Exercises normalization of hostile non-Error rejections.
      beforeFinalize: () => Promise.reject(nonErrorFailure),
    })
    await expect(publish(
      nonErrorRoot,
      BACKUP_ID,
      3,
      sakiStateCapability,
      nonErrorStore,
    )).rejects.toMatchObject({ cause: nonErrorFailure })
  })

  it('rejects escaped, repeated, and foreign target reservations', async () => {
    const installationRoot = await root()
    const source = await sourceAt(installationRoot)
    const store = testStore()
    let escaped: MissingTargetReservation | undefined
    await store.withMissingTarget(
      installationRoot,
      BACKUP_ID,
      AbortSignal.timeout(2_000),
      (reservation) => {
        escaped = reservation
      },
    )
    if (escaped === undefined) throw new Error('reservation did not escape test callback')
    const escapedFailure = await store.create(
      escaped,
      source,
      request(),
      sakiStateCapability,
      AbortSignal.timeout(2_000),
    ).catch((error: unknown) => error)
    expect(escapedFailure).toBeInstanceOf(MissingTargetReservationError)
    expect(escapedFailure).toMatchObject({ reason: 'expired' })

    await store.withMissingTarget(
      installationRoot,
      OTHER_BACKUP_ID,
      AbortSignal.timeout(2_000),
      async (reservation) => {
        await store.create(
          reservation,
          source,
          request(),
          sakiStateCapability,
          AbortSignal.timeout(2_000),
        )
        await expect(store.create(
          reservation,
          source,
          request(),
          sakiStateCapability,
          AbortSignal.timeout(2_000),
        )).rejects.toMatchObject({ reason: 'consumed' })
      },
    )

    await expect(store.create(
      {} as MissingTargetReservation,
      source,
      request(),
      sakiStateCapability,
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ reason: 'foreign' })
  })

  it('stops an unawaited create after its reservation callback returns', async () => {
    const installationRoot = await root()
    const source = await sourceAt(installationRoot)
    const store = testStore()
    let pending: Promise<unknown> | undefined

    await store.withMissingTarget(
      installationRoot,
      BACKUP_ID,
      AbortSignal.timeout(2_000),
      (reservation) => {
        pending = store.create(
          reservation,
          source,
          request(),
          sakiStateCapability,
          AbortSignal.timeout(2_000),
        )
      },
    )

    if (pending === undefined) throw new Error('unawaited create did not start')
    await expect(pending).rejects.toMatchObject({ reason: 'expired' })
    await expect(stat(finalDirectory(installationRoot))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects non-directory Installation and backup namespace roots', async () => {
    const fileRoot = join(await root(), 'installation-file')
    await writeFile(fileRoot, 'not a directory')
    await expect(testStore().withMissingTarget(
      fileRoot,
      BACKUP_ID,
      AbortSignal.timeout(2_000),
      () => undefined,
    )).rejects.toMatchObject({ code: 'recovery-required' })

    const installationRoot = await root()
    await writeFile(join(installationRoot, 'backups'), 'not a namespace')
    await expect(testStore().withMissingTarget(
      installationRoot,
      BACKUP_ID,
      AbortSignal.timeout(2_000),
      () => undefined,
    )).rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('never overwrites an initial or last-moment final target collision', async () => {
    const installationRoot = await root()
    await mkdir(join(installationRoot, 'backups'), { recursive: true })
    await mkdir(finalDirectory(installationRoot))
    await writeFile(join(finalDirectory(installationRoot), 'winner'), 'initial')

    await expect(testStore().withMissingTarget(
      installationRoot,
      BACKUP_ID,
      AbortSignal.timeout(2_000),
      () => undefined,
    )).rejects.toMatchObject({ code: 'target-exists' })
    await expect(readFile(join(finalDirectory(installationRoot), 'winner'), 'utf8')).resolves.toBe('initial')

    const raceRoot = await root()
    const racingStore = testStore({
      beforeFinalize: async (_partial, final) => {
        await mkdir(final)
        await writeFile(join(final, 'winner'), 'late')
      },
    })
    await expect(publish(raceRoot, BACKUP_ID, 3, sakiStateCapability, racingStore))
      .rejects.toMatchObject({ code: 'target-exists' })
    await expect(readFile(join(finalDirectory(raceRoot), 'winner'), 'utf8')).resolves.toBe('late')
    await expect(stat(`${finalDirectory(raceRoot)}.partial`)).resolves.toMatchObject({})
  })

  it('always checks the source after success and preserves a simultaneous operation failure', async () => {
    for (const failOperation of [false, true]) {
      const installationRoot = await root()
      const source = await sourceAt(installationRoot)
      const operationFailure = new Error('injected finalization failure')
      const store = testStore({
        beforeFinalize: async () => {
          await writeFile(source.databasePath, 'source changed after copy')
          if (failOperation) throw operationFailure
        },
      })
      const failure = await store.withMissingTarget(
        installationRoot,
        BACKUP_ID,
        AbortSignal.timeout(2_000),
        async reservation => await store.create(
          reservation,
          source,
          request(),
          sakiStateCapability,
          AbortSignal.timeout(2_000),
        ),
      ).catch((error: unknown) => error)

      if (failOperation) {
        expect(failure).toBeInstanceOf(AggregateError)
        expect((failure as AggregateError).errors[0]).toBe(operationFailure)
        expect((failure as AggregateError).errors[1]).toMatchObject({ code: 'source-changed' })
      } else {
        expect(failure).toMatchObject({ code: 'source-changed' })
        await expect(stat(finalDirectory(installationRoot))).resolves.toMatchObject({})
      }
    }
  })

  it('rejects an unreadable create version before copying artifacts', async () => {
    const installationRoot = await root()
    const source = await sourceAt(installationRoot)
    const store = testStore()

    await expect(store.withMissingTarget(
      installationRoot,
      BACKUP_ID,
      AbortSignal.timeout(2_000),
      async reservation => await store.create(
        reservation,
        source,
        { ...request(), stateVersion: 10 } as unknown as RecoveryBackupCreateRequest,
        sakiStateCapability,
        AbortSignal.timeout(2_000),
      ),
    )).rejects.toMatchObject({ code: 'state-unsupported' })
    await expect(readdir(`${finalDirectory(installationRoot)}.partial`)).resolves.toEqual([])
  })

  it('preserves owned partial evidence after artifact or metadata preparation fails', async () => {
    const artifactRoot = await root()
    const artifactSource = await sourceAt(artifactRoot)
    const artifactStore = testStore()
    await artifactStore.withMissingTarget(
      artifactRoot,
      BACKUP_ID,
      AbortSignal.timeout(2_000),
      async (reservation) => {
        const partial = `${finalDirectory(artifactRoot)}.partial`
        await writeFile(join(partial, 'state.sqlite'), 'collision')
        await expect(artifactStore.create(
          reservation,
          artifactSource,
          request(),
          sakiStateCapability,
          AbortSignal.timeout(2_000),
        )).rejects.toMatchObject({ code: 'EEXIST' })
      },
    )

    const metadataRoot = await root()
    const metadataSource = await sourceAt(metadataRoot)
    const metadataFailure = new Error('metadata publication failed')
    const metadataStore = testStore({
      publishMetadata: async () => {
        throw metadataFailure
      },
    })
    await expect(metadataStore.withMissingTarget(
      metadataRoot,
      BACKUP_ID,
      AbortSignal.timeout(2_000),
      async reservation => await metadataStore.create(
        reservation,
        metadataSource,
        request(),
        sakiStateCapability,
        AbortSignal.timeout(2_000),
      ),
    )).rejects.toBe(metadataFailure)
    await expect(readdir(`${finalDirectory(metadataRoot)}.partial`).then(values => values.sort()))
      .resolves.toEqual([
        'state.sqlite',
        'state.sqlite-journal',
        'state.sqlite-shm',
        'state.sqlite-wal',
      ])
  })

  it('rejects truncated, hash-divergent, extra, and missing artifact sets', async () => {
    const cases = [
      async (directory: string) => {
        await writeFile(join(directory, 'state.sqlite'), 'x')
      },
      async (directory: string) => {
        await writeFile(join(directory, 'state.sqlite'), Buffer.alloc(6, 0xff))
      },
      async (directory: string) => {
        await writeFile(join(directory, 'extra.sqlite'), 'extra')
      },
      async (directory: string) => {
        await rm(join(directory, 'state.sqlite-wal'))
      },
    ]
    for (const [index, corrupt] of cases.entries()) {
      const installationRoot = await root()
      const backupId = `backup-00000000-0000-4000-8000-${String(index + 20).padStart(12, '0')}` as SakiRecoveryBackupId
      await publish(installationRoot, backupId)
      await corrupt(finalDirectory(installationRoot, backupId))
      await expect(verifyRecoveryBackup(
        installationRoot,
        backupId,
        sakiStateCapability,
        AbortSignal.timeout(2_000),
      )).rejects.toMatchObject({ code: 'recovery-required' })
    }
  })

  it('accepts v2 through the supplied capability and treats build id only as provenance', async () => {
    const installationRoot = await root()
    await publish(installationRoot, BACKUP_ID, 2, v2Capability)

    await expect(verifyRecoveryBackup(
      installationRoot,
      BACKUP_ID,
      v2Capability,
      AbortSignal.timeout(2_000),
    )).resolves.toMatchObject({
      manifest: {
        stateVersion: 2,
        sourceBuildId: SOURCE_BUILD_ID,
      },
    })
  })

  it('rejects unsupported, noncanonical, malformed, and oversized metadata', async () => {
    const cases: Array<(installationRoot: string) => Promise<void>> = [
      async (installationRoot) => {
        await rewriteManifest(installationRoot, (value) => { value.stateVersion = 10 })
      },
      async (installationRoot) => {
        await rewriteManifest(installationRoot, (value) => { value.purpose = 'portable-backup' })
      },
      async (installationRoot) => {
        const path = join(finalDirectory(installationRoot), 'backup.json')
        const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
        await writeFile(path, JSON.stringify(parsed, undefined, 2))
      },
      async (installationRoot) => {
        const path = join(finalDirectory(installationRoot), 'backup.json')
        const text = await readFile(path, 'utf8')
        await writeFile(path, text.replace('{"formatVersion":1,', '{"formatVersion":1,"formatVersion":1,'))
      },
      async (installationRoot) => {
        await writeFile(join(finalDirectory(installationRoot), 'backup.json'), 'null\n')
      },
      async (installationRoot) => {
        await rewriteManifest(installationRoot, (value) => { value.backupId = OTHER_BACKUP_ID })
      },
      async (installationRoot) => {
        await writeFile(
          join(finalDirectory(installationRoot), 'backup.json'),
          Buffer.from([0xc3, 0x28]),
        )
      },
      async (installationRoot) => {
        await writeFile(
          join(finalDirectory(installationRoot), 'backup.json'),
          Buffer.alloc((16 * 1_024) + 1, 0x20),
        )
      },
    ]
    for (const [index, corrupt] of cases.entries()) {
      const installationRoot = await root()
      await publish(installationRoot)
      await corrupt(installationRoot)
      const failure = await verifyRecoveryBackup(
        installationRoot,
        BACKUP_ID,
        sakiStateCapability,
        AbortSignal.timeout(2_000),
      ).catch((error: unknown) => error)
      expect(failure).toMatchObject({
        code: index === 0 ? 'state-unsupported' : 'recovery-required',
      })
    }
  })

  it('rejects non-file entries and non-owner POSIX permissions', async () => {
    const missingRoot = await root()
    await expect(verifyRecoveryBackup(
      missingRoot,
      BACKUP_ID,
      sakiStateCapability,
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'recovery-required' })

    const finalFileRoot = await root()
    await mkdir(join(finalFileRoot, 'backups'))
    await writeFile(finalDirectory(finalFileRoot), 'not a directory')
    await expect(verifyRecoveryBackup(
      finalFileRoot,
      BACKUP_ID,
      sakiStateCapability,
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'recovery-required' })

    const metadataRoot = await root()
    await publish(metadataRoot)
    const metadataPath = join(finalDirectory(metadataRoot), 'backup.json')
    await rm(metadataPath)
    await mkdir(metadataPath)
    await expect(verifyRecoveryBackup(
      metadataRoot,
      BACKUP_ID,
      sakiStateCapability,
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'recovery-required' })

    const artifactRoot = await root()
    await publish(artifactRoot)
    const artifactPath = join(finalDirectory(artifactRoot), 'state.sqlite')
    await rm(artifactPath)
    await mkdir(artifactPath)
    await expect(verifyRecoveryBackup(
      artifactRoot,
      BACKUP_ID,
      sakiStateCapability,
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'recovery-required' })

    if (process.platform !== 'win32') {
      const directoryModeRoot = await root()
      await publish(directoryModeRoot)
      await chmod(finalDirectory(directoryModeRoot), 0o755)
      await expect(verifyRecoveryBackup(
        directoryModeRoot,
        BACKUP_ID,
        sakiStateCapability,
        AbortSignal.timeout(2_000),
      )).rejects.toMatchObject({ code: 'recovery-required' })

      const fileModeRoot = await root()
      await publish(fileModeRoot)
      await chmod(join(finalDirectory(fileModeRoot), 'state.sqlite'), 0o644)
      await expect(verifyRecoveryBackup(
        fileModeRoot,
        BACKUP_ID,
        sakiStateCapability,
        AbortSignal.timeout(2_000),
      )).rejects.toMatchObject({ code: 'recovery-required' })
    }
  })

  it('honors a precommit abort and ignores a late abort after exact publication', async () => {
    const beforeRoot = await root()
    const beforeController = new AbortController()
    const beforeReason = new Error('abort before Recovery Backup commit')
    const beforeStore = testStore({
      beforeFinalize: async () => {
        beforeController.abort(beforeReason)
      },
    })
    const source = await sourceAt(beforeRoot)
    await expect(beforeStore.withMissingTarget(
      beforeRoot,
      BACKUP_ID,
      beforeController.signal,
      async reservation => await beforeStore.create(
        reservation,
        source,
        request(),
        sakiStateCapability,
        beforeController.signal,
      ),
    )).rejects.toBe(beforeReason)
    await expect(stat(finalDirectory(beforeRoot))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(`${finalDirectory(beforeRoot)}.partial`)).resolves.toMatchObject({})

    const afterRoot = await root()
    const afterController = new AbortController()
    const afterFailure = new Error('post-publication durability fault')
    const afterStore = testStore({
      afterFinalize: async () => {
        afterController.abort(new Error('too late'))
        throw afterFailure
      },
    })
    const afterSource = await sourceAt(afterRoot)
    const result = await afterStore.withMissingTarget(
      afterRoot,
      BACKUP_ID,
      afterController.signal,
      async reservation => await afterStore.create(
        reservation,
        afterSource,
        request(),
        sakiStateCapability,
        afterController.signal,
      ),
    )
    expect(result).toMatchObject({ outcome: 'published', cause: afterFailure })
    await expect(verifyRecoveryBackup(
      afterRoot,
      BACKUP_ID,
      sakiStateCapability,
      AbortSignal.timeout(2_000),
    )).resolves.toMatchObject({ manifest: { backupId: BACKUP_ID } })
  })

  it('classifies an attempted commit by uncancellable exact final readback', async () => {
    const exactRoot = await root()
    const injectedFailure = new Error('move reported failure after commit')
    const exactStore = testStore({
      moveDirectory: async (partial, final) => {
        await rename(partial, final)
        throw injectedFailure
      },
    })
    await expect(publish(exactRoot, BACKUP_ID, 3, sakiStateCapability, exactStore))
      .resolves.toMatchObject({ outcome: 'published', cause: injectedFailure })

    const missingRoot = await root()
    const missingStore = testStore({
      moveDirectory: async () => {
        throw injectedFailure
      },
    })
    const failure = await publish(
      missingRoot,
      BACKUP_ID,
      3,
      sakiStateCapability,
      missingStore,
    ).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(RecoveryBackupOutcomeUnknownError)
    expect(failure).toMatchObject({
      publicationPossible: true,
      finalState: 'missing',
    })
    expect((failure as RecoveryBackupOutcomeUnknownError).cause).toBeInstanceOf(AggregateError)
    expect(((failure as RecoveryBackupOutcomeUnknownError).cause as AggregateError).errors[0])
      .toBe(injectedFailure)
  })

  it('retains both post-commit effect and parent-sync failures after exact readback', async () => {
    const installationRoot = await root()
    const effectFailure = new Error('after-finalize failed')
    const syncFailure = new Error('final parent sync failed')
    const store = testStore({
      afterFinalize: async () => {
        throw effectFailure
      },
      syncDirectory: async () => {
        if (existsSync(finalDirectory(installationRoot))) throw syncFailure
      },
    })

    const result = await publish(installationRoot, BACKUP_ID, 3, sakiStateCapability, store)

    expect(result.outcome).toBe('published')
    if (result.outcome !== 'published') throw new Error('faulted publication reported durable')
    expect(result.cause).toBeInstanceOf(AggregateError)
    expect((result.cause as AggregateError).errors).toEqual([effectFailure, syncFailure])
  })

  it('reports different final evidence when commit succeeds with a corrupted target', async () => {
    const extraRoot = await root()
    const extraStore = testStore({
      afterFinalize: async (_partial, final) => {
        await writeFile(join(final, 'late-extra'), 'not declared')
      },
    })
    await expect(publish(extraRoot, BACKUP_ID, 3, sakiStateCapability, extraStore))
      .rejects.toMatchObject({
        code: 'publication-outcome-unknown',
        finalState: 'different',
      })

    const fileRoot = await root()
    const fileStore = testStore({
      moveDirectory: async (partial, final) => {
        await rm(partial, { recursive: true })
        await writeFile(final, 'not a directory')
      },
    })
    await expect(publish(fileRoot, BACKUP_ID, 3, sakiStateCapability, fileStore))
      .rejects.toMatchObject({
        code: 'publication-outcome-unknown',
        finalState: 'different',
      })
  })

  it('uses MoveFileExW WRITE_THROUGH without replace or copy flags for Windows directories', async () => {
    const installationRoot = await root()
    const moves: Array<{ readonly from: string; readonly to: string; readonly flags: number }> = []
    const store = createRecoveryBackupStore({
      platform: 'win32',
      moveDirectoryWin32: async (from, to, flags) => {
        moves.push({ from, to, flags })
        await rename(from, to)
      },
      syncDirectory: async () => {
        throw new Error('Windows finalize must not use POSIX directory fsync')
      },
    })

    await publish(installationRoot, BACKUP_ID, 3, sakiStateCapability, store)

    expect(moves).toEqual([{
      from: `${finalDirectory(installationRoot)}.partial`,
      to: finalDirectory(installationRoot),
      flags: 0x00000008,
    }])
    const onlyMove = moves[0]
    if (onlyMove === undefined) throw new Error('expected one native move')
    expect(onlyMove.flags & 0x00000003).toBe(0)
  })

  it('binds the native Windows move and maps every relevant no-copy failure', async () => {
    let nativeCode = 0
    let failFinal = false
    const moves: Array<{ readonly to: string; readonly flags: number }> = []
    const module = await importWithNativeMove((existingPath, replacementPath, flags) => {
      const from = stripNamespace(existingPath)
      const to = stripNamespace(replacementPath)
      const leaf = to.split(/[\\/]/u).at(-1) ?? ''
      const isFinalDirectory = leaf.startsWith('backup-') && !leaf.endsWith('.partial')
      moves.push({ to, flags })
      if (failFinal && isFinalDirectory) return 0
      if (!existsSync(from) || existsSync(to)) return 0
      renameSync(from, to)
      return 1
    }, () => nativeCode)

    const successRoot = await root()
    const successSource = await sourceAt(successRoot)
    const successStore = module.createRecoveryBackupStore({
      platform: 'win32',
      windowsAcl: testWindowsAcl(),
    })
    await successStore.withMissingTarget(
      successRoot,
      BACKUP_ID,
      AbortSignal.timeout(2_000),
      async reservation => await successStore.create(
        reservation,
        successSource,
        request(),
        sakiStateCapability,
        AbortSignal.timeout(2_000),
      ),
    )
    expect(moves.find(move => move.to === finalDirectory(successRoot))).toMatchObject({
      flags: 0x00000008,
    })

    failFinal = true
    const cases = [2, 3, 5, 17, 80, 183, 123, 9_999]
    for (const [index, code] of cases.entries()) {
      nativeCode = code
      const installationRoot = await root()
      const source = await sourceAt(installationRoot)
      const backupId = `backup-00000000-0000-4000-8000-${String(index + 60).padStart(12, '0')}` as SakiRecoveryBackupId
      const store = module.createRecoveryBackupStore({
        platform: 'win32',
        windowsAcl: testWindowsAcl(),
      })
      await store.withMissingTarget(
        installationRoot,
        backupId,
        AbortSignal.timeout(2_000),
        async reservation => await store.create(
          reservation,
          source,
          request(),
          sakiStateCapability,
          AbortSignal.timeout(2_000),
        ),
      ).catch(() => undefined)
    }
  })
})
