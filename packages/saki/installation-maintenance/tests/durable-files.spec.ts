import { existsSync, renameSync } from 'node:fs'
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDurableFileWriter,
  discardDurableFileTemporary,
  durableFileTemporaryPath,
  DurableFileOutcomeUnknownError,
  publishMissingFile,
  replaceFileDurably,
} from '../src/durable-files.ts'

const roots: string[] = []
const processPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
if (processPlatformDescriptor === undefined) throw new Error('process.platform descriptor is missing')

function setProcessPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...processPlatformDescriptor, value: platform })
}

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'saki-durable-files-'))
  roots.push(value)
  return value
}

afterEach(async () => {
  Object.defineProperty(process, 'platform', processPlatformDescriptor)
  vi.doUnmock('koffi')
  vi.doUnmock('node:fs/promises')
  vi.doUnmock('../src/durable-directories.ts')
  vi.resetModules()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function stripNamespace(path: string): string {
  if (path.startsWith('\\\\?\\UNC\\')) return `\\\\${path.slice('\\\\?\\UNC\\'.length)}`
  if (path.startsWith('\\\\?\\')) return path.slice('\\\\?\\'.length)
  return path
}

async function importWithNativeMove(
  move: (existing: string, replacement: string, flags: number) => number,
  getLastError: () => number = () => 0,
): Promise<typeof import('../src/durable-files.ts')> {
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
  return await import('../src/durable-files.ts')
}

async function importWithTemporaryFault(
  writeFailure: Error | undefined,
  closeFailure: Error | undefined,
): Promise<typeof import('../src/durable-files.ts')> {
  vi.resetModules()
  vi.doMock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>()
    return {
      ...actual,
      async open(...args: Parameters<typeof actual.open>): ReturnType<typeof actual.open> {
        const handle = await actual.open(...args)
        if (args[1] !== 'wx') return handle
        return {
          writeFile: async (...writeArgs: Parameters<typeof handle.writeFile>) => {
            await handle.writeFile(...writeArgs)
            if (writeFailure !== undefined) throw writeFailure
          },
          sync: () => handle.sync(),
          close: async () => {
            await handle.close()
            if (closeFailure !== undefined) throw closeFailure
          },
        } as Awaited<ReturnType<typeof actual.open>>
      },
    }
  })
  return await import('../src/durable-files.ts')
}

describe('Saki durable namespace files', () => {
  it('publishes and replaces through the Host defaults', async () => {
    const directory = await root()
    const target = join(directory, 'installation.json')

    await expect(publishMissingFile(
      target,
      Buffer.from('provisioning\n'),
      new AbortController().signal,
    )).resolves.toEqual({ outcome: 'durable' })
    await expect(replaceFileDurably(
      target,
      Buffer.from('ready\n'),
      new AbortController().signal,
    )).resolves.toEqual({ outcome: 'durable' })

    await expect(readFile(target, 'utf8')).resolves.toBe('ready\n')
  })

  it('selects both Host-platform defaults without changing publication flags', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    if (descriptor === undefined) throw new Error('process.platform descriptor is missing')
    const directory = await root()
    const target = join(directory, 'generation.json')
    const opposite = process.platform === 'win32' ? 'linux' : 'win32'
    Object.defineProperty(process, 'platform', { ...descriptor, value: opposite })
    try {
      const writer = createDurableFileWriter({
        moveFilePosix: async (from, to) => {
          await link(from, to)
          await rm(from)
        },
        moveFileWin32: async (from, to, flags) => {
          expect(flags).toBe(0x00000008)
          await rename(from, to)
        },
        syncDirectory: async () => {},
      })
      await expect(writer.publishMissingFile(
        target,
        Buffer.from('generation\n'),
        new AbortController().signal,
      )).resolves.toEqual({ outcome: 'durable' })
    } finally {
      Object.defineProperty(process, 'platform', descriptor)
    }
  })

  it('publishes a missing file from a synced owner-only sibling', async () => {
    const directory = await root()
    const target = join(directory, 'active-operation.json')
    const bytes = Buffer.from('journal\n')
    let temporary = ''
    let temporaryIdentity: readonly [number, number] | undefined
    let parent = ''
    const writer = createDurableFileWriter({
      platform: 'posix',
      beforePublish: async (path, destination) => {
        temporary = path
        expect(dirname(path)).toBe(directory)
        expect(destination).toBe(target)
        expect(await readFile(path)).toEqual(bytes)
        const info = await stat(path)
        temporaryIdentity = [info.dev, info.ino]
        if (process.platform !== 'win32') {
          expect((await stat(path)).mode & 0o777).toBe(0o600)
        }
      },
      syncDirectory: async (path) => {
        parent = path
        expect(await readFile(target)).toEqual(bytes)
        const targetInfo = await stat(target)
        expect([targetInfo.dev, targetInfo.ino]).toEqual(temporaryIdentity)
        await expect(stat(temporary)).rejects.toMatchObject({ code: 'ENOENT' })
      },
    })

    await expect(writer.publishMissingFile(
      target,
      bytes,
      new AbortController().signal,
    )).resolves.toEqual({ outcome: 'durable' })

    expect(parent).toBe(directory)
    await expect(readFile(target)).resolves.toEqual(bytes)
    await expect(stat(temporary)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('uses the real POSIX directory-sync effect', async () => {
    const directory = await root()
    const target = join(directory, 'generation.json')

    const result = await createDurableFileWriter({ platform: 'posix' }).publishMissingFile(
      target,
      Buffer.from('generation\n'),
      new AbortController().signal,
    )

    expect(result.outcome).toBe(process.platform === 'win32' ? 'published' : 'durable')
    await expect(readFile(target, 'utf8')).resolves.toBe('generation\n')
  })

  it('never replaces an existing target', async () => {
    const directory = await root()
    const target = join(directory, 'active-operation.json')
    await writeFile(target, 'winner\n')
    const writer = createDurableFileWriter({
      platform: 'posix',
      syncDirectory: async () => {},
    })

    await expect(writer.publishMissingFile(
      target,
      Buffer.from('loser\n'),
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'EEXIST' })

    await expect(readFile(target, 'utf8')).resolves.toBe('winner\n')
    await expect(readdir(directory)).resolves.toEqual(['active-operation.json'])
  })

  it('honors cancellation immediately before publication and removes only its temp', async () => {
    const directory = await root()
    const target = join(directory, 'generation.json')
    const controller = new AbortController()
    const reason = new Error('stop before publication')
    const writer = createDurableFileWriter({
      platform: 'posix',
      beforePublish: async () => {
        controller.abort(reason)
      },
      syncDirectory: async () => {},
    })

    await expect(writer.publishMissingFile(
      target,
      Buffer.from('candidate\n'),
      controller.signal,
    )).rejects.toBe(reason)

    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readdir(directory)).resolves.toEqual([])
  })

  it('creates no temp for an already-aborted operation', async () => {
    const directory = await root()
    const controller = new AbortController()
    const reason = new Error('already cancelled')
    controller.abort(reason)

    await expect(createDurableFileWriter({ platform: 'posix' }).publishMissingFile(
      join(directory, 'generation.json'),
      Buffer.from('generation\n'),
      controller.signal,
    )).rejects.toBe(reason)
    await expect(readdir(directory)).resolves.toEqual([])
  })

  it('reconciles the exact deterministic temp left before namespace publication', async () => {
    const directory = await root()
    const target = join(directory, 'installation.json')
    const commitFailure = new Error('process stopped before commit')
    const writer = createDurableFileWriter({
      platform: 'posix',
      beforePublish: async (temporary) => {
        expect(temporary).toBe(durableFileTemporaryPath(target))
        throw commitFailure
      },
      removeTemporary: async () => {
        throw new Error('simulated process death skipped cleanup')
      },
      syncDirectory: async () => {},
    })

    await expect(writer.publishMissingFile(
      target,
      Buffer.from('ready\n'),
      new AbortController().signal,
    )).rejects.toBe(commitFailure)
    await expect(readFile(durableFileTemporaryPath(target), 'utf8')).resolves.toBe('ready\n')

    await discardDurableFileTemporary(target, new AbortController().signal)
    await expect(readFile(durableFileTemporaryPath(target))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(discardDurableFileTemporary(
      target,
      new AbortController().signal,
    )).resolves.toBeUndefined()
    await expect(createDurableFileWriter({
      platform: 'posix',
      syncDirectory: async () => {},
    }).publishMissingFile(
      target,
      Buffer.from('ready\n'),
      new AbortController().signal,
    )).resolves.toEqual({ outcome: 'durable' })
  })

  it('rejects an invalid or non-file deterministic temp during reconciliation', async () => {
    const directory = await root()
    const target = join(directory, 'installation.json')
    await mkdir(durableFileTemporaryPath(target))

    await expect(discardDurableFileTemporary(
      target,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'recovery-required' })
    await expect(discardDurableFileTemporary(
      join(directory, 'invalid\0target'),
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('rejects deterministic-temp removal and cleanup-sync failures', async () => {
    const directory = await root()
    const removalTarget = join(directory, 'removal.json')
    const removalTemporary = durableFileTemporaryPath(removalTarget)
    const removalFailure = new Error('remove failed')
    await writeFile(removalTemporary, 'temp\n')
    await expect(discardDurableFileTemporary(
      removalTarget,
      new AbortController().signal,
      { removeTemporary: async () => { throw removalFailure } },
    )).rejects.toMatchObject({ code: 'recovery-required', cause: removalFailure })

    const syncTarget = join(directory, 'sync.json')
    const syncTemporary = durableFileTemporaryPath(syncTarget)
    const syncFailure = new Error('sync failed')
    await writeFile(syncTemporary, 'temp\n')
    await expect(discardDurableFileTemporary(
      syncTarget,
      new AbortController().signal,
      {
        platform: 'posix',
        syncDirectory: async () => { throw syncFailure },
      },
    )).rejects.toMatchObject({ code: 'recovery-required', cause: syncFailure })
  })

  it('selects the default POSIX cleanup family and directory sync', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    if (descriptor === undefined) throw new Error('process.platform descriptor is missing')
    const hostPlatform = process.platform
    const directory = await root()
    const target = join(directory, 'default-sync.json')
    await writeFile(durableFileTemporaryPath(target), 'temp\n')
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'linux' })
    try {
      const cleanup = discardDurableFileTemporary(target, new AbortController().signal)
      if (hostPlatform === 'win32') {
        await expect(cleanup).rejects.toMatchObject({ code: 'recovery-required' })
      } else {
        await expect(cleanup).resolves.toBeUndefined()
      }
      await expect(readFile(durableFileTemporaryPath(target))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      Object.defineProperty(process, 'platform', descriptor)
    }
  })

  it('selects the native POSIX no-replace move when no test move is supplied', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    if (descriptor === undefined) throw new Error('process.platform descriptor is missing')
    vi.resetModules()
    vi.doMock('../src/durable-directories.ts', () => ({
      movePathPosixNoReplace: async (from: string, to: string) => {
        await rename(from, to)
      },
    }))
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'linux' })
    try {
      const module = await import('../src/durable-files.ts')
      const directory = await root()
      const target = join(directory, 'native.json')
      await expect(module.createDurableFileWriter({
        platform: 'posix',
        syncDirectory: async () => {},
      }).publishMissingFile(
        target,
        Buffer.from('native\n'),
        new AbortController().signal,
      )).resolves.toEqual({ outcome: 'durable' })
      await expect(readFile(target, 'utf8')).resolves.toBe('native\n')
    } finally {
      Object.defineProperty(process, 'platform', descriptor)
    }
  })

  it('preserves a pre-publication failure when temp cleanup also fails', async () => {
    const directory = await root()
    const target = join(directory, 'generation.json')
    const commitFailure = new Error('stop before commit')
    const writer = createDurableFileWriter({
      platform: 'posix',
      beforePublish: async () => {
        throw commitFailure
      },
      removeTemporary: async () => {
        throw new Error('cleanup failed')
      },
      syncDirectory: async () => {},
    })

    await expect(writer.publishMissingFile(
      target,
      Buffer.from('generation\n'),
      new AbortController().signal,
    )).rejects.toBe(commitFailure)
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('normalizes non-Error pre-publication failures', async () => {
    const directory = await root()
    const writer = createDurableFileWriter({
      platform: 'posix',
      beforePublish: async () => {
        throw 'non-error failure'
      },
      syncDirectory: async () => {},
    })

    await expect(writer.publishMissingFile(
      join(directory, 'generation.json'),
      Buffer.from('generation\n'),
      new AbortController().signal,
    )).rejects.toMatchObject({
      message: 'namespace publication failed',
      cause: 'non-error failure',
    })
    await expect(readdir(directory)).resolves.toEqual([])
  })

  it('cleans a temp when preparation or descriptor close fails', async () => {
    const cases = [
      [new Error('write failed'), undefined],
      [undefined, new Error('close failed')],
      [new Error('write failed'), new Error('close failed')],
    ] as const
    for (const [writeFailure, closeFailure] of cases) {
      const module = await importWithTemporaryFault(writeFailure, closeFailure)
      const directory = await root()
      const failure = await module.createDurableFileWriter({
        platform: 'posix',
        syncDirectory: async () => {},
      }).publishMissingFile(
        join(directory, 'generation.json'),
        Buffer.from('generation\n'),
        new AbortController().signal,
      ).catch((error: unknown) => error)

      if (writeFailure !== undefined && closeFailure !== undefined) {
        expect(failure).toBeInstanceOf(AggregateError)
        expect((failure as AggregateError).errors).toEqual([writeFailure, closeFailure])
      } else {
        expect(failure).toBe(writeFailure ?? closeFailure)
      }
      await expect(readdir(directory)).resolves.toEqual([])
    }
  })

  it('copies caller bytes before the first filesystem await', async () => {
    const directory = await root()
    const target = join(directory, 'generation.json')
    const bytes = Buffer.from('before\n')
    const writer = createDurableFileWriter({
      platform: 'posix',
      syncDirectory: async () => {},
    })

    const publication = writer.publishMissingFile(
      target,
      bytes,
      new AbortController().signal,
    )
    bytes.fill(0)

    await expect(publication).resolves.toEqual({ outcome: 'durable' })
    await expect(readFile(target, 'utf8')).resolves.toBe('before\n')
  })

  it('durably replaces one existing file through a same-directory temp', async () => {
    const directory = await root()
    const target = join(directory, 'installation.json')
    await writeFile(target, 'old\n')
    const writer = createDurableFileWriter({
      platform: 'posix',
      syncDirectory: async (path) => {
        expect(path).toBe(directory)
        await expect(readFile(target, 'utf8')).resolves.toBe('new\n')
      },
    })

    await expect(writer.replaceFileDurably(
      target,
      Buffer.from('new\n'),
      new AbortController().signal,
    )).resolves.toEqual({ outcome: 'durable' })

    await expect(readFile(target, 'utf8')).resolves.toBe('new\n')
    await expect(readdir(directory)).resolves.toEqual(['installation.json'])
  })

  it('ignores a late abort and classifies an exact post-publication readback', async () => {
    const directory = await root()
    const target = join(directory, 'installation.json')
    await writeFile(target, 'old\n')
    const controller = new AbortController()
    const postPublicationFailure = new Error('injected after publication')
    const writer = createDurableFileWriter({
      platform: 'posix',
      afterPublish: async () => {
        controller.abort(new Error('late abort'))
        throw postPublicationFailure
      },
      syncDirectory: async () => {
        throw new Error('directory sync must not follow the injected failure')
      },
    })

    await expect(writer.replaceFileDurably(
      target,
      Buffer.from('new\n'),
      controller.signal,
    )).resolves.toEqual({
      outcome: 'published',
      cause: postPublicationFailure,
    })
    await expect(readFile(target, 'utf8')).resolves.toBe('new\n')
  })

  it('reports unknown publication when post-publication readback is not exact', async () => {
    const directory = await root()
    const target = join(directory, 'installation.json')
    await writeFile(target, 'old\n')
    const postPublicationFailure = new Error('injected after publication')
    const writer = createDurableFileWriter({
      platform: 'posix',
      afterPublish: async () => {
        await writeFile(target, 'different\n')
        throw postPublicationFailure
      },
      syncDirectory: async () => {},
    })

    const failure = await writer.replaceFileDurably(
      target,
      Buffer.from('new\n'),
      new AbortController().signal,
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(DurableFileOutcomeUnknownError)
    expect(failure).toMatchObject({
      code: 'publication-outcome-unknown',
      publicationPossible: true,
      finalState: 'different',
      cause: postPublicationFailure,
    })
  })

  it('does not let a late abort cancel durability confirmation', async () => {
    const directory = await root()
    const target = join(directory, 'generation.json')
    const controller = new AbortController()
    let synced = false
    const writer = createDurableFileWriter({
      platform: 'posix',
      afterPublish: async () => {
        controller.abort(new Error('too late'))
      },
      syncDirectory: async () => {
        synced = true
      },
    })

    await expect(writer.publishMissingFile(
      target,
      Buffer.from('generation\n'),
      controller.signal,
    )).resolves.toEqual({ outcome: 'durable' })
    expect(synced).toBe(true)
  })

  it('keeps exact publication evidence when temp cleanup also fails', async () => {
    const directory = await root()
    const target = join(directory, 'generation.json')
    const postPublicationFailure = new Error('directory sync failed')
    const cleanupFailure = new Error('temp cleanup failed')
    const writer = createDurableFileWriter({
      platform: 'posix',
      moveFilePosix: async (from, to) => {
        await link(from, to)
      },
      syncDirectory: async () => {
        throw postPublicationFailure
      },
      removeTemporary: async () => {
        throw cleanupFailure
      },
    })

    const result = await writer.publishMissingFile(
      target,
      Buffer.from('generation\n'),
      new AbortController().signal,
    )

    expect(result.outcome).toBe('published')
    if (result.outcome === 'published') {
      expect(result.cause).toBeInstanceOf(AggregateError)
      expect((result.cause as AggregateError).errors).toEqual([
        postPublicationFailure,
        cleanupFailure,
      ])
    }
    await expect(readFile(target, 'utf8')).resolves.toBe('generation\n')
  })

  it('syncs the parent again after removing a POSIX owner-temp link', async () => {
    const directory = await root()
    const target = join(directory, 'generation.json')
    const syncDirectory = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const writer = createDurableFileWriter({
      platform: 'posix',
      moveFilePosix: async (from, to) => {
        await link(from, to)
      },
      syncDirectory,
    })

    await expect(writer.publishMissingFile(
      target,
      Buffer.from('generation\n'),
      new AbortController().signal,
    )).resolves.toEqual({ outcome: 'durable' })
    expect(syncDirectory).toHaveBeenCalledTimes(2)
    expect(syncDirectory).toHaveBeenNthCalledWith(1, directory)
    expect(syncDirectory).toHaveBeenNthCalledWith(2, directory)
    await expect(readdir(directory)).resolves.toEqual(['generation.json'])
  })

  it('uses the default POSIX sync after removing an injected owner-temp link', async () => {
    const directory = await root()
    const target = join(directory, 'default-generation.json')
    const writer = createDurableFileWriter({
      platform: 'posix',
      moveFilePosix: async (from, to) => {
        await link(from, to)
      },
    })

    const result = await writer.publishMissingFile(
      target,
      Buffer.from('generation\n'),
      new AbortController().signal,
    )
    expect(result.outcome).toBe(process.platform === 'win32' ? 'published' : 'durable')
    await expect(readdir(directory)).resolves.toEqual(['default-generation.json'])
  })

  it('does not report durable when the owner-temp removal sync fails', async () => {
    const directory = await root()
    const target = join(directory, 'generation.json')
    const cleanupSyncFailure = new Error('owner-temp removal sync failed')
    let syncCount = 0
    const writer = createDurableFileWriter({
      platform: 'posix',
      moveFilePosix: async (from, to) => {
        await link(from, to)
      },
      syncDirectory: async () => {
        syncCount += 1
        if (syncCount === 2) throw cleanupSyncFailure
      },
    })

    await expect(writer.publishMissingFile(
      target,
      Buffer.from('generation\n'),
      new AbortController().signal,
    )).resolves.toEqual({ outcome: 'published', cause: cleanupSyncFailure })
    await expect(readdir(directory)).resolves.toEqual(['generation.json'])
  })

  it('does not turn durable publication into failure when redundant cleanup fails', async () => {
    const directory = await root()
    const target = join(directory, 'generation.json')
    const writer = createDurableFileWriter({
      platform: 'posix',
      syncDirectory: async () => {},
      removeTemporary: async () => {
        throw new Error('temp cleanup failed')
      },
    })

    await expect(writer.publishMissingFile(
      target,
      Buffer.from('generation\n'),
      new AbortController().signal,
    )).resolves.toEqual({ outcome: 'durable' })
    await expect(readFile(target, 'utf8')).resolves.toBe('generation\n')
  })

  it('distinguishes missing and unreadable final paths after publication', async () => {
    const directory = await root()
    const missingTarget = join(directory, 'missing.json')
    const unreadableTarget = join(directory, 'unreadable.json')
    const postFailure = new Error('post-publication failure')
    const readFailure = new Error('readback unavailable')
    const missingWriter = createDurableFileWriter({
      platform: 'posix',
      afterPublish: async (_temporary, target) => {
        await rm(target)
        throw postFailure
      },
      syncDirectory: async () => {},
    })
    const unreadableWriter = createDurableFileWriter({
      platform: 'posix',
      afterPublish: async () => {
        throw postFailure
      },
      syncDirectory: async () => {},
      readFinal: async () => {
        throw readFailure
      },
    })

    await expect(missingWriter.publishMissingFile(
      missingTarget,
      Buffer.from('missing\n'),
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: 'publication-outcome-unknown',
      finalState: 'missing',
      cause: postFailure,
    })
    const unreadable = await unreadableWriter.publishMissingFile(
      unreadableTarget,
      Buffer.from('unreadable\n'),
      new AbortController().signal,
    ).catch((error: unknown) => error)
    expect(unreadable).toMatchObject({
      code: 'publication-outcome-unknown',
      finalState: 'unreadable',
    })
    if (!(unreadable instanceof DurableFileOutcomeUnknownError)) {
      throw new Error('expected an unknown durable-file publication outcome')
    }
    expect(unreadable.cause).toBeInstanceOf(AggregateError)
    if (!(unreadable.cause instanceof AggregateError)) {
      throw new Error('expected aggregated post-publication and readback failures')
    }
    expect(unreadable.cause.errors).toEqual([postFailure, readFailure])
  })

  it('uses write-through no-replace and replace flags without copy fallback on Windows', async () => {
    const directory = await root()
    const missing = join(directory, 'generation.json')
    const existing = join(directory, 'installation.json')
    await writeFile(existing, 'old\n')
    const moves: Array<{ from: string; to: string; flags: number }> = []
    const writer = createDurableFileWriter({
      platform: 'win32',
      moveFileWin32: async (from, to, flags) => {
        moves.push({ from, to, flags })
        await rename(from, to)
      },
      syncDirectory: async () => {
        throw new Error('Windows publication must not use POSIX directory fsync')
      },
    })

    await expect(writer.publishMissingFile(
      missing,
      Buffer.from('created\n'),
      new AbortController().signal,
    )).resolves.toEqual({ outcome: 'durable' })
    await expect(writer.replaceFileDurably(
      existing,
      Buffer.from('replaced\n'),
      new AbortController().signal,
    )).resolves.toEqual({ outcome: 'durable' })

    expect(moves.map(move => move.flags)).toEqual([0x00000008, 0x00000009])
    expect(moves.every(move => (move.flags & 0x00000002) === 0)).toBe(true)
    expect(moves.every(move => dirname(move.from) === dirname(move.to))).toBe(true)
    await expect(readFile(missing, 'utf8')).resolves.toBe('created\n')
    await expect(readFile(existing, 'utf8')).resolves.toBe('replaced\n')
  })

  it('binds MoveFileExW with exact write-through flags', async () => {
    const directory = await root()
    const missing = join(directory, 'generation.json')
    const existing = join(directory, 'installation.json')
    await writeFile(existing, 'old\n')
    const moves: Array<{ from: string; to: string; flags: number }> = []
    const module = await importWithNativeMove((existingPath, replacementPath, flags) => {
      const from = stripNamespace(existingPath)
      const to = stripNamespace(replacementPath)
      moves.push({ from, to, flags })
      if (!existsSync(from) || ((flags & 1) === 0 && existsSync(to))) return 0
      renameSync(from, to)
      return 1
    })
    const writer = module.createDurableFileWriter({ platform: 'win32' })

    await writer.publishMissingFile(missing, Buffer.from('created\n'), new AbortController().signal)
    await writer.replaceFileDurably(existing, Buffer.from('replaced\n'), new AbortController().signal)

    expect(moves).toMatchObject([
      { to: missing, flags: 0x00000008 },
      { to: existing, flags: 0x00000009 },
    ])
    expect(moves.every(move => dirname(move.from) === dirname(move.to))).toBe(true)
    await expect(readFile(missing, 'utf8')).resolves.toBe('created\n')
    await expect(readFile(existing, 'utf8')).resolves.toBe('replaced\n')
  })

  it('maps native Windows move failures without adding copy fallback', async () => {
    const cases = [
      [2, 'ENOENT'],
      [3, 'ENOENT'],
      [5, 'EACCES'],
      [17, 'EXDEV'],
      [80, 'EEXIST'],
      [183, 'EEXIST'],
      [123, 'EINVAL'],
      [9999, 'EIO'],
    ] as const
    let lastError = 0
    const module = await importWithNativeMove((_existing, _replacement, flags) => {
      expect(flags).toBe(0x00000008)
      return 0
    }, () => lastError)
    const writer = module.createDurableFileWriter({ platform: 'win32' })
    const directory = await root()

    for (const [nativeCode, code] of cases) {
      lastError = nativeCode
      await expect(writer.publishMissingFile(
        join(directory, `${nativeCode}.json`),
        Buffer.from('not published\n'),
        new AbortController().signal,
      )).rejects.toMatchObject({
        code,
        errno: nativeCode,
        syscall: 'MoveFileExW',
        win32Code: nativeCode,
      })
    }
    await expect(readdir(directory)).resolves.toEqual([])
  })

  it('honors an abort while the Windows binding loads before the native commit', async () => {
    setProcessPlatform('win32')
    vi.resetModules()
    const bindingStarted = Promise.withResolvers<undefined>()
    const releaseBinding = Promise.withResolvers<undefined>()
    let moves = 0
    vi.doMock('koffi', async () => {
      bindingStarted.resolve(undefined)
      await releaseBinding.promise
      return {
        default: {
          load: () => ({
            func: (_convention: string, name: string) => name === 'MoveFileExW'
              ? (existing: string, replacement: string) => {
                moves += 1
                renameSync(stripNamespace(existing), stripNamespace(replacement))
                return 1
              }
              : () => 0,
          }),
        },
      }
    })
    const module = await import('../src/durable-files.ts')
    const directory = await root()
    const target = join(directory, 'generation.json')
    const controller = new AbortController()
    const reason = new Error('cancel while loading native binding')

    const publication = module.createDurableFileWriter({ platform: 'win32' })
      .publishMissingFile(target, Buffer.from('generation\n'), controller.signal)
    const publicationResult = publication.catch((error: unknown) => error)
    await bindingStarted.promise
    controller.abort(reason)
    releaseBinding.resolve(undefined)

    await expect(publicationResult).resolves.toBe(reason)
    expect(moves).toBe(0)
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readdir(directory)).resolves.toEqual([])
  })
})
