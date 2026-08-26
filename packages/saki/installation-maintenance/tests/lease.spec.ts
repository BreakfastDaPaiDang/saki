import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  INSTALLATION_LOCK_LEAF,
  SakiMaintenanceError,
  withInstallationLease,
} from '../src/index.ts'
import type { InstallationLeaseEffects } from '../src/index.ts'

const roots: string[] = []
// oxlint-disable-next-line typescript/unbound-method -- fault tests invoke it with the database receiver.
const realExec = DatabaseSync.prototype.exec
// oxlint-disable-next-line typescript/unbound-method -- fault tests invoke it with the database receiver.
const realClose = DatabaseSync.prototype.close

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'saki-installation-lease-'))
  roots.push(value)
  return value
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Saki Installation lease', () => {
  it('excludes a second participant and releases without deleting the lock database', async () => {
    const installationRoot = await root()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const first = withInstallationLease(installationRoot, AbortSignal.timeout(2_000), async (path) => {
      expect(path).toBe(join(installationRoot, INSTALLATION_LOCK_LEAF))
      entered.resolve(undefined)
      await release.promise
      return 'first'
    })
    await entered.promise

    await expect(withInstallationLease(
      installationRoot,
      AbortSignal.timeout(2_000),
      async () => 'second',
    )).rejects.toMatchObject({ code: 'lease-busy' } satisfies Partial<SakiMaintenanceError>)

    release.resolve(undefined)
    await expect(first).resolves.toBe('first')
    await expect(withInstallationLease(
      installationRoot,
      AbortSignal.timeout(2_000),
      async path => path,
    )).resolves.toBe(join(installationRoot, INSTALLATION_LOCK_LEAF))
  })

  it('releases after a callback failure', async () => {
    const installationRoot = await root()
    await expect(withInstallationLease(
      installationRoot,
      AbortSignal.timeout(2_000),
      async () => { throw new Error('operation failed') },
    )).rejects.toThrow('operation failed')
    await expect(withInstallationLease(
      installationRoot,
      AbortSignal.timeout(2_000),
      async () => 'recovered',
    )).resolves.toBe('recovered')
  })

  it('honors cancellation before creating the root', async () => {
    const installationRoot = join(await root(), 'not-created')
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(withInstallationLease(
      installationRoot,
      controller.signal,
      async () => undefined,
    )).rejects.toThrow('cancelled')
  })

  it('checkpoints the existing ancestor and each new directory before entering SQLite work', async () => {
    const base = await root()
    const first = join(base, 'first')
    const installationRoot = join(first, 'installation')
    const events: string[] = []

    await withInstallationLease(
      installationRoot,
      AbortSignal.timeout(2_000),
      async () => { events.push('operation') },
      {
        platform: 'posix',
        createDirectory: async (path) => {
          events.push(`mkdir:${path}`)
          await mkdir(path, { mode: 0o700 })
        },
        syncDirectory: async (path) => { events.push(`sync:${path}`) },
      },
    )

    expect(events).toEqual([
      `sync:${base}`,
      `sync:${join(base, '..')}`,
      `mkdir:${first}`,
      `sync:${first}`,
      `sync:${base}`,
      `mkdir:${installationRoot}`,
      `sync:${installationRoot}`,
      `sync:${first}`,
      'operation',
    ])
  })

  it('treats the deepest pre-existing directory as a retry checkpoint', async () => {
    const base = await root()
    const checkpoint = join(base, 'checkpoint')
    const installationRoot = join(checkpoint, 'installation')
    await mkdir(checkpoint)
    const events: string[] = []

    await withInstallationLease(
      installationRoot,
      AbortSignal.timeout(2_000),
      async () => { events.push('operation') },
      {
        platform: 'posix',
        createDirectory: async (path) => {
          events.push(`mkdir:${path}`)
          await mkdir(path, { mode: 0o700 })
        },
        syncDirectory: async (path) => { events.push(`sync:${path}`) },
      },
    )

    expect(events).toEqual([
      `sync:${checkpoint}`,
      `sync:${base}`,
      `mkdir:${installationRoot}`,
      `sync:${installationRoot}`,
      `sync:${checkpoint}`,
      'operation',
    ])
  })

  it('does not recreate an existing root but re-checkpoints it before opening the lease', async () => {
    const installationRoot = await root()
    const createDirectory = vi.fn<NonNullable<InstallationLeaseEffects['createDirectory']>>()
    const syncDirectory = vi.fn<NonNullable<InstallationLeaseEffects['syncDirectory']>>()

    await withInstallationLease(
      installationRoot,
      AbortSignal.timeout(2_000),
      async () => undefined,
      { platform: 'posix', createDirectory, syncDirectory },
    )

    expect(createDirectory).not.toHaveBeenCalled()
    expect(syncDirectory.mock.calls).toEqual([
      [installationRoot],
      [join(installationRoot, '..')],
    ])
  })

  it('does not open SQLite or enter the operation after a directory sync failure', async () => {
    const base = await root()
    const installationRoot = join(base, 'installation')
    const failure = new Error('directory sync failed')
    const operation = vi.fn<() => Promise<void>>()
    const syncDirectory = vi.fn<(path: string) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(failure)

    await expect(withInstallationLease(
      installationRoot,
      AbortSignal.timeout(2_000),
      operation,
      { platform: 'posix', syncDirectory },
    )).rejects.toMatchObject({ code: 'recovery-required', cause: failure })
    expect(operation).not.toHaveBeenCalled()
    await expect(lstat(join(installationRoot, INSTALLATION_LOCK_LEAF)))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('accepts a concurrent EEXIST only after the path is a real directory', async () => {
    const installationRoot = join(await root(), 'installation')
    const syncDirectory = vi.fn<NonNullable<InstallationLeaseEffects['syncDirectory']>>()

    await expect(withInstallationLease(
      installationRoot,
      AbortSignal.timeout(2_000),
      async () => 'entered',
      {
        platform: 'win32',
        syncDirectory,
        createDirectory: async (path) => {
          await mkdir(path)
          throw Object.assign(new Error('created concurrently'), { code: 'EEXIST' })
        },
      },
    )).resolves.toBe('entered')
    expect(syncDirectory).not.toHaveBeenCalled()
  })

  it('rejects an existing regular file or directory link as the Installation root', async () => {
    const base = await root()
    const file = join(base, 'file-root')
    await writeFile(file, 'not a directory')
    await expect(withInstallationLease(
      file,
      AbortSignal.timeout(2_000),
      async () => undefined,
      { platform: 'win32' },
    )).rejects.toMatchObject({ code: 'recovery-required' })

    const external = await root()
    const link = join(base, 'linked-root')
    await symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(withInstallationLease(
      link,
      AbortSignal.timeout(2_000),
      async () => undefined,
      { platform: 'win32' },
    )).rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('classifies a non-absence inspection failure as recovery-required', async () => {
    await expect(withInstallationLease(
      join(await root(), '\0'),
      AbortSignal.timeout(2_000),
      async () => undefined,
      { platform: 'win32' },
    )).rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('propagates a directory creation failure that is not EEXIST', async () => {
    const failure = new Error('directory creation failed')
    const operation = vi.fn<() => Promise<void>>()
    await expect(withInstallationLease(
      join(await root(), 'installation'),
      AbortSignal.timeout(2_000),
      operation,
      { platform: 'win32', createDirectory: async () => { throw failure } },
    )).rejects.toBe(failure)
    expect(operation).not.toHaveBeenCalled()
  })

  it('requires recovery when creation returns without a real directory', async () => {
    const operation = vi.fn<() => Promise<void>>()
    await expect(withInstallationLease(
      join(await root(), 'installation'),
      AbortSignal.timeout(2_000),
      operation,
      { platform: 'win32', createDirectory: async () => undefined },
    )).rejects.toMatchObject({ code: 'recovery-required' })
    expect(operation).not.toHaveBeenCalled()
  })

  it('requires recovery when inspection cannot find a filesystem root', async () => {
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' })
    await expect(withInstallationLease(
      join(await root(), 'installation'),
      AbortSignal.timeout(2_000),
      async () => undefined,
      { platform: 'win32', inspectDirectory: async () => { throw missing } },
    )).rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('propagates a non-contention failure while acquiring the lease', async () => {
    const failure = new Error('lock database failed')
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementationOnce(() => { throw failure })

    await expect(withInstallationLease(
      await root(),
      AbortSignal.timeout(2_000),
      async () => undefined,
    )).rejects.toBe(failure)
  })

  it('reports a primitive rollback failure after the operation succeeds', async () => {
    vi.spyOn(DatabaseSync.prototype, 'exec')
      .mockImplementationOnce(function (this: DatabaseSync, sql: string) {
        realExec.call(this, sql)
      })
      .mockImplementationOnce(() => { throw 'rollback failed' })

    await expect(withInstallationLease(
      await root(),
      AbortSignal.timeout(2_000),
      async () => 'complete',
    )).rejects.toMatchObject({ message: 'Saki Installation lease release failed', cause: 'rollback failed' })
  })

  it('reports a primitive close failure and then closes the still-open database', async () => {
    vi.spyOn(DatabaseSync.prototype, 'close')
      .mockImplementationOnce(() => { throw 'close failed' })
      .mockImplementationOnce(function (this: DatabaseSync) {
        realClose.call(this)
      })

    await expect(withInstallationLease(
      await root(),
      AbortSignal.timeout(2_000),
      async () => 'complete',
    )).rejects.toMatchObject({ message: 'Saki Installation lease release failed', cause: 'close failed' })
  })

  it('retains operation, rollback, and close failures together', async () => {
    const operationFailure = new Error('operation failed')
    const rollbackFailure = new Error('rollback failed')
    const closeFailure = new Error('close failed')
    vi.spyOn(DatabaseSync.prototype, 'exec')
      .mockImplementationOnce(function (this: DatabaseSync, sql: string) {
        realExec.call(this, sql)
      })
      .mockImplementationOnce(() => { throw rollbackFailure })
    vi.spyOn(DatabaseSync.prototype, 'close')
      .mockImplementationOnce(() => { throw closeFailure })
      .mockImplementationOnce(function (this: DatabaseSync) {
        realClose.call(this)
      })

    const result = withInstallationLease(
      await root(),
      AbortSignal.timeout(2_000),
      async () => { throw operationFailure },
    )
    await expect(result).rejects.toBeInstanceOf(AggregateError)
    await expect(result).rejects.toMatchObject({
      errors: [
        operationFailure,
        { errors: [rollbackFailure, closeFailure] },
      ],
    })
  })
})
