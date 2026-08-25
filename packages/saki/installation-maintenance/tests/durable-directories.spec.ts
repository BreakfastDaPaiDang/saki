import { existsSync, renameSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDurableDirectoryPublisher,
  DurableDirectoryOutcomeUnknownError,
} from '../src/durable-directories.ts'

const roots: string[] = []
const processPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
if (processPlatformDescriptor === undefined) throw new Error('process.platform descriptor is missing')

function setProcessPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...processPlatformDescriptor, value: platform })
}

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'saki-durable-directories-'))
  roots.push(value)
  return value
}

afterEach(async () => {
  Object.defineProperty(process, 'platform', processPlatformDescriptor)
  vi.doUnmock('koffi')
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
): Promise<typeof import('../src/durable-directories.ts')> {
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
  return await import('../src/durable-directories.ts')
}

describe('Saki durable directory publication', () => {
  it('publishes one complete sibling directory with durable identity', async () => {
    const parent = await root()
    const partial = join(parent, 'generation.partial')
    const final = join(parent, 'generation')
    await mkdir(partial)
    await writeFile(join(partial, 'generation.json'), 'complete\n')
    const before = await lstat(partial, { bigint: true })
    const publisher = createDurableDirectoryPublisher({
      platform: 'posix',
      moveDirectoryPosix: async (from, to) => {
        await rename(from, to)
      },
      syncDirectory: async (path) => {
        expect(path).toBe(parent)
        const after = await lstat(final, { bigint: true })
        expect([after.dev, after.ino]).toEqual([before.dev, before.ino])
      },
    })

    await expect(publisher.publishMissingDirectory(
      partial,
      final,
      AbortSignal.timeout(2_000),
    )).resolves.toEqual({ outcome: 'durable' })

    await expect(readFile(join(final, 'generation.json'), 'utf8')).resolves.toBe('complete\n')
    await expect(lstat(partial)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns exact visible publication when post-commit durability confirmation fails', async () => {
    const parent = await root()
    const partial = join(parent, 'candidate.partial')
    const final = join(parent, 'candidate')
    await mkdir(partial)
    const afterFailure = new Error('crash after commit')
    const syncFailure = new Error('parent sync failed')
    const publisher = createDurableDirectoryPublisher({
      platform: 'posix',
      moveDirectoryPosix: async (from, to) => {
        await rename(from, to)
      },
      afterPublish: async () => {
        throw afterFailure
      },
      syncDirectory: async () => {
        throw syncFailure
      },
    })

    const result = await publisher.publishMissingDirectory(
      partial,
      final,
      AbortSignal.timeout(2_000),
    )

    expect(result.outcome).toBe('published')
    if (result.outcome !== 'published') throw new Error('faulted publication reported durable')
    expect(result.cause).toBeInstanceOf(AggregateError)
    expect((result.cause as AggregateError).errors).toEqual([afterFailure, syncFailure])

    const nonErrorParent = await root()
    const nonErrorPartial = join(nonErrorParent, 'non-error.partial')
    const nonErrorFinal = join(nonErrorParent, 'non-error')
    await mkdir(nonErrorPartial)
    const nonErrorResult = await createDurableDirectoryPublisher({
      platform: 'posix',
      moveDirectoryPosix: async (from, to) => {
        await rename(from, to)
      },
      afterPublish: async () => {
        throw 'non-Error effect failure'
      },
      syncDirectory: async () => {},
    }).publishMissingDirectory(
      nonErrorPartial,
      nonErrorFinal,
      AbortSignal.timeout(2_000),
    )
    expect(nonErrorResult).toMatchObject({
      outcome: 'published',
      cause: { message: 'post-publication directory effect failed', cause: 'non-Error effect failure' },
    })
  })

  it('classifies an exact final identity when a move reports failure after committing', async () => {
    const parent = await root()
    const partial = join(parent, 'ambiguous.partial')
    const final = join(parent, 'ambiguous')
    await mkdir(partial)
    const commitFailure = new Error('move wrapper failed after commit')
    let synced = false
    const publisher = createDurableDirectoryPublisher({
      platform: 'posix',
      moveDirectoryPosix: async (from, to) => {
        await rename(from, to)
        throw commitFailure
      },
      syncDirectory: async () => {
        synced = true
      },
    })

    await expect(publisher.publishMissingDirectory(
      partial,
      final,
      AbortSignal.timeout(2_000),
    )).resolves.toEqual({ outcome: 'published', cause: commitFailure })
    expect(synced).toBe(true)

    const syncParent = await root()
    const syncPartial = join(syncParent, 'sync-failure.partial')
    const syncFinal = join(syncParent, 'sync-failure')
    await mkdir(syncPartial)
    const syncFailure = new Error('failed to sync committed parent')
    const syncResult = await createDurableDirectoryPublisher({
      platform: 'posix',
      moveDirectoryPosix: async (from, to) => {
        await rename(from, to)
        throw commitFailure
      },
      syncDirectory: async () => {
        throw syncFailure
      },
    }).publishMissingDirectory(
      syncPartial,
      syncFinal,
      AbortSignal.timeout(2_000),
    )
    expect(syncResult.outcome).toBe('published')
    if (syncResult.outcome !== 'published') throw new Error('faulted publication reported durable')
    expect(syncResult.cause).toBeInstanceOf(AggregateError)
    expect((syncResult.cause as AggregateError).errors).toEqual([commitFailure, syncFailure])
  })

  it('reports unknown publication for missing, different, and unreadable final identity', async () => {
    const missingParent = await root()
    const missingPartial = join(missingParent, 'missing.partial')
    const missingFinal = join(missingParent, 'missing')
    await mkdir(missingPartial)
    const missingFailure = await createDurableDirectoryPublisher({
      platform: 'posix',
      moveDirectoryPosix: async (from) => {
        await rm(from, { recursive: true })
        throw new Error('source lost during commit')
      },
      syncDirectory: async () => {},
    }).publishMissingDirectory(
      missingPartial,
      missingFinal,
      AbortSignal.timeout(2_000),
    ).catch((error: unknown) => error)
    expect(missingFailure).toBeInstanceOf(DurableDirectoryOutcomeUnknownError)
    expect(missingFailure).toMatchObject({
      code: 'publication-outcome-unknown',
      publicationPossible: true,
      finalState: 'missing',
    })

    const differentParent = await root()
    const differentPartial = join(differentParent, 'different.partial')
    const differentFinal = join(differentParent, 'different')
    await mkdir(differentPartial)
    const differentIdentity = await lstat(differentParent, { bigint: true })
    const differentFailure = await createDurableDirectoryPublisher({
      platform: 'posix',
      moveDirectoryPosix: async (from, to) => {
        await rename(from, to)
      },
      afterPublish: async (_from, to) => {
        await rm(to, { recursive: true })
        await mkdir(to)
      },
      syncDirectory: async () => {},
      inspectFinal: async () => differentIdentity,
    }).publishMissingDirectory(
      differentPartial,
      differentFinal,
      AbortSignal.timeout(2_000),
    ).catch((error: unknown) => error)
    expect(differentFailure).toMatchObject({
      code: 'publication-outcome-unknown',
      finalState: 'different',
    })

    const unreadableParent = await root()
    const unreadablePartial = join(unreadableParent, 'unreadable.partial')
    const unreadableFinal = join(unreadableParent, 'unreadable')
    await mkdir(unreadablePartial)
    const readFailure = new Error('lstat unavailable')
    const unreadableFailure = await createDurableDirectoryPublisher({
      platform: 'posix',
      moveDirectoryPosix: async (from, to) => {
        await rename(from, to)
      },
      syncDirectory: async () => {},
      inspectFinal: async () => {
        throw readFailure
      },
    }).publishMissingDirectory(
      unreadablePartial,
      unreadableFinal,
      AbortSignal.timeout(2_000),
    ).catch((error: unknown) => error)
    expect(unreadableFailure).toMatchObject({
      code: 'publication-outcome-unknown',
      finalState: 'unreadable',
      cause: readFailure,
    })
  })

  it('rejects non-normalized paths, non-siblings, non-directories, and existing targets', async () => {
    const parent = await root()
    const otherParent = await root()
    const partial = join(parent, 'strict.partial')
    const final = join(parent, 'strict')
    await mkdir(partial)
    const publisher = createDurableDirectoryPublisher({
      platform: 'posix',
      moveDirectoryPosix: async (from, to) => {
        await rename(from, to)
      },
      syncDirectory: async () => {},
    })

    await expect(publisher.publishMissingDirectory(
      `.${sep}strict.partial`,
      final,
      AbortSignal.timeout(2_000),
    )).rejects.toBeInstanceOf(TypeError)
    await expect(publisher.publishMissingDirectory(
      partial,
      `.${sep}strict`,
      AbortSignal.timeout(2_000),
    )).rejects.toBeInstanceOf(TypeError)
    await expect(publisher.publishMissingDirectory(
      `${parent}${sep}nested${sep}..${sep}strict.partial`,
      final,
      AbortSignal.timeout(2_000),
    )).rejects.toBeInstanceOf(TypeError)
    await expect(publisher.publishMissingDirectory(
      partial,
      join(otherParent, 'strict'),
      AbortSignal.timeout(2_000),
    )).rejects.toBeInstanceOf(TypeError)
    await expect(publisher.publishMissingDirectory(
      partial,
      partial,
      AbortSignal.timeout(2_000),
    )).rejects.toBeInstanceOf(TypeError)

    const fileSource = join(parent, 'file.partial')
    await writeFile(fileSource, 'not a directory')
    await expect(publisher.publishMissingDirectory(
      fileSource,
      join(parent, 'file'),
      AbortSignal.timeout(2_000),
    )).rejects.toBeInstanceOf(TypeError)

    await mkdir(final)
    await expect(publisher.publishMissingDirectory(
      partial,
      final,
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(lstat(partial)).resolves.toMatchObject({})
  })

  it('cancels before commit but ignores cancellation after the namespace move', async () => {
    const beforeParent = await root()
    const beforePartial = join(beforeParent, 'before.partial')
    const beforeFinal = join(beforeParent, 'before')
    await mkdir(beforePartial)
    const beforeController = new AbortController()
    const beforeReason = new Error('stop before commit')
    let beforeMoves = 0
    const beforePublisher = createDurableDirectoryPublisher({
      platform: 'posix',
      beforePublish: async () => {
        beforeController.abort(beforeReason)
      },
      moveDirectoryPosix: async () => {
        beforeMoves += 1
      },
      syncDirectory: async () => {},
    })

    await expect(beforePublisher.publishMissingDirectory(
      beforePartial,
      beforeFinal,
      beforeController.signal,
    )).rejects.toBe(beforeReason)
    expect(beforeMoves).toBe(0)
    await expect(lstat(beforePartial)).resolves.toMatchObject({})
    await expect(lstat(beforeFinal)).rejects.toMatchObject({ code: 'ENOENT' })

    const afterParent = await root()
    const afterPartial = join(afterParent, 'after.partial')
    const afterFinal = join(afterParent, 'after')
    await mkdir(afterPartial)
    const afterController = new AbortController()
    let synced = false
    const afterPublisher = createDurableDirectoryPublisher({
      platform: 'posix',
      moveDirectoryPosix: async (from, to) => {
        await rename(from, to)
      },
      afterPublish: async () => {
        afterController.abort(new Error('too late'))
      },
      syncDirectory: async () => {
        synced = true
      },
    })

    await expect(afterPublisher.publishMissingDirectory(
      afterPartial,
      afterFinal,
      afterController.signal,
    )).resolves.toEqual({ outcome: 'durable' })
    expect(synced).toBe(true)
  })

  it('uses the real POSIX parent-directory synchronization effect', async () => {
    const parent = await root()
    const partial = join(parent, 'real-sync.partial')
    const final = join(parent, 'real-sync')
    await mkdir(partial)

    const result = await createDurableDirectoryPublisher({
      platform: 'posix',
      moveDirectoryPosix: async (from, to) => {
        await rename(from, to)
      },
    }).publishMissingDirectory(
      partial,
      final,
      AbortSignal.timeout(2_000),
    )

    expect(['durable', 'published']).toContain(result.outcome)
    await expect(lstat(final)).resolves.toMatchObject({})

    const failedPartial = join(parent, 'real-sync-failed.partial')
    const failedFinal = join(parent, 'real-sync-failed')
    await mkdir(failedPartial)
    const commitFailure = new Error('move failed after commit')
    const failedResult = await createDurableDirectoryPublisher({
      platform: 'posix',
      moveDirectoryPosix: async (from, to) => {
        await rename(from, to)
        throw commitFailure
      },
    }).publishMissingDirectory(
      failedPartial,
      failedFinal,
      AbortSignal.timeout(2_000),
    )
    expect(failedResult.outcome).toBe('published')
  })

  it('uses Windows write-through without replace or copy flags and skips POSIX fsync', async () => {
    const parent = await root()
    const partial = join(parent, 'backup.partial')
    const final = join(parent, 'backup')
    await mkdir(partial)
    const moves: Array<{ readonly from: string; readonly to: string; readonly flags: number }> = []
    const publisher = createDurableDirectoryPublisher({
      platform: 'win32',
      moveDirectoryWin32: async (from, to, flags) => {
        moves.push({ from, to, flags })
        await rename(from, to)
      },
      syncDirectory: async () => {
        throw new Error('Windows must not use POSIX directory fsync')
      },
    })

    await expect(publisher.publishMissingDirectory(
      partial,
      final,
      AbortSignal.timeout(2_000),
    )).resolves.toEqual({ outcome: 'durable' })

    expect(moves).toEqual([{ from: partial, to: final, flags: 0x00000008 }])
    expect((moves[0]?.flags ?? 0) & 0x00000003).toBe(0)

    const failedPartial = join(parent, 'failed.partial')
    const failedFinal = join(parent, 'failed')
    await mkdir(failedPartial)
    const commitFailure = new Error('Windows wrapper failed after move')
    await expect(createDurableDirectoryPublisher({
      platform: 'win32',
      moveDirectoryWin32: async (from, to) => {
        await rename(from, to)
        throw commitFailure
      },
      syncDirectory: async () => {
        throw new Error('Windows failed-commit classification must not use POSIX fsync')
      },
    }).publishMissingDirectory(
      failedPartial,
      failedFinal,
      AbortSignal.timeout(2_000),
    )).resolves.toEqual({ outcome: 'published', cause: commitFailure })
  })

  it('binds reusable Windows no-replace and replace moves to exact write-through flags', async () => {
    const moves: Array<{
      readonly existing: string
      readonly replacement: string
      readonly flags: number
    }> = []
    const module = await importWithNativeMove((existing, replacement, flags) => {
      const from = stripNamespace(existing)
      const to = stripNamespace(replacement)
      moves.push({
        existing: from,
        replacement: to,
        flags,
      })
      if (existsSync(from)) renameSync(from, to)
      return 1
    })
    const installationRoot = await root()
    const existing = join(installationRoot, 'active-operation.json')
    const settled = join(installationRoot, 'operations', 'operation.json')
    const replacement = join(installationRoot, 'installation.json.next')
    const manifest = join(installationRoot, 'installation.json')

    await module.movePathWin32WriteThrough(
      existing,
      settled,
      false,
      AbortSignal.timeout(2_000),
    )
    await module.movePathWin32WriteThrough(
      replacement,
      manifest,
      true,
      AbortSignal.timeout(2_000),
    )

    const partial = join(installationRoot, 'generation.partial')
    const final = join(installationRoot, 'generation')
    await mkdir(partial)
    await expect(module.publishMissingDirectory(
      partial,
      final,
      AbortSignal.timeout(2_000),
    )).resolves.toEqual({ outcome: 'durable' })

    expect(moves).toEqual([
      { existing, replacement: settled, flags: 0x00000008 },
      { existing: replacement, replacement: manifest, flags: 0x00000009 },
      { existing: partial, replacement: final, flags: 0x00000008 },
    ])
  })

  it('validates reusable Windows paths and maps native failures without copy fallback', async () => {
    let nativeCode = 0
    const module = await importWithNativeMove(() => 0, () => nativeCode)
    const installationRoot = await root()
    const existing = join(installationRoot, 'source')
    const target = join(installationRoot, 'target')

    await expect(module.movePathWin32WriteThrough(
      `.${sep}source`,
      target,
      false,
      AbortSignal.timeout(2_000),
    )).rejects.toBeInstanceOf(TypeError)
    await expect(module.movePathWin32WriteThrough(
      existing,
      `.${sep}target`,
      false,
      AbortSignal.timeout(2_000),
    )).rejects.toBeInstanceOf(TypeError)
    await expect(module.movePathWin32WriteThrough(
      existing,
      existing,
      false,
      AbortSignal.timeout(2_000),
    )).rejects.toBeInstanceOf(TypeError)

    const cases = [
      [2, 'ENOENT'],
      [3, 'ENOENT'],
      [5, 'EACCES'],
      [17, 'EXDEV'],
      [80, 'EEXIST'],
      [183, 'EEXIST'],
      [123, 'EINVAL'],
      [9_999, 'EIO'],
    ] as const
    for (const [code, expected] of cases) {
      nativeCode = code
      await expect(module.movePathWin32WriteThrough(
        existing,
        target,
        false,
        AbortSignal.timeout(2_000),
      )).rejects.toMatchObject({
        code: expected,
        win32Code: code,
        syscall: 'MoveFileExW',
        path: existing,
        dest: target,
      })
    }

    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    if (descriptor === undefined) throw new Error('process.platform descriptor is missing')
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'linux' })
    try {
      await expect(module.movePathWin32WriteThrough(
        existing,
        target,
        false,
        AbortSignal.timeout(2_000),
      )).rejects.toMatchObject({ code: 'ENOTSUP' })
      const partial = join(installationRoot, 'unsupported.partial')
      await mkdir(partial)
      await expect(module.createDurableDirectoryPublisher({ platform: 'win32' })
        .publishMissingDirectory(
          partial,
          join(installationRoot, 'unsupported'),
          AbortSignal.timeout(2_000),
        )).rejects.toMatchObject({ code: 'ENOTSUP' })
    } finally {
      Object.defineProperty(process, 'platform', descriptor)
    }
  })

  it('honors cancellation while the native binding loads before committing', async () => {
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
              ? () => {
                moves += 1
                return 1
              }
              : () => 0,
          }),
        },
      }
    })
    const module = await import('../src/durable-directories.ts')
    const parent = await root()
    const partial = join(parent, 'cancel.partial')
    const final = join(parent, 'cancel')
    await mkdir(partial)
    const controller = new AbortController()
    const reason = new Error('cancel while loading native binding')

    const publication = module.createDurableDirectoryPublisher({ platform: 'win32' })
      .publishMissingDirectory(partial, final, controller.signal)
    const publicationResult = publication.catch((error: unknown) => error)
    await bindingStarted.promise
    controller.abort(reason)
    releaseBinding.resolve(undefined)

    await expect(publicationResult).resolves.toBe(reason)
    expect(moves).toBe(0)
    await expect(lstat(partial)).resolves.toMatchObject({})
    await expect(lstat(final)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('uses native exclusive rename flags on Linux and macOS', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    if (descriptor === undefined) throw new Error('process.platform descriptor is missing')
    const cases = [
      {
        platform: 'linux',
        library: 'libc.so.6',
        functionName: 'renameat2',
        types: ['int', 'str', 'int', 'str', 'uint'],
        expectedCall: (partial: string, final: string) => [-100, partial, -100, final, 1],
      },
      {
        platform: 'darwin',
        library: '/usr/lib/libSystem.B.dylib',
        functionName: 'renamex_np',
        types: ['str', 'str', 'uint'],
        expectedCall: (partial: string, final: string) => [partial, final, 4],
      },
    ] as const

    try {
      for (const testCase of cases) {
        vi.doUnmock('koffi')
        vi.resetModules()
        Object.defineProperty(process, 'platform', { ...descriptor, value: testCase.platform })
        const calls: unknown[][] = []
        let failMove = false
        vi.doMock('koffi', () => ({
          default: {
            errno: () => 9_999,
            os: { errno: {} },
            load: (library: string) => {
              expect(library).toBe(testCase.library)
              return {
                func: (name: string, result: string, args: string[]) => {
                  expect([name, result, args]).toEqual([
                    testCase.functionName,
                    'int',
                    testCase.types,
                  ])
                  return (...values: unknown[]) => {
                    calls.push(values)
                    if (failMove) return -1
                    const paths = values.filter(value => typeof value === 'string')
                    renameSync(paths[0] ?? '', paths[1] ?? '')
                    return 0
                  }
                },
              }
            },
          },
        }))
        const module = await import('../src/durable-directories.ts')
        const parent = await root()
        const partial = join(parent, `${testCase.platform}.partial`)
        const final = join(parent, testCase.platform)
        await mkdir(partial)

        await expect(module.createDurableDirectoryPublisher({
          syncDirectory: async () => {},
        }).publishMissingDirectory(
          partial,
          final,
          AbortSignal.timeout(2_000),
        )).resolves.toEqual({ outcome: 'durable' })

        const cachedPartial = join(parent, `${testCase.platform}-cached.partial`)
        const cachedFinal = join(parent, `${testCase.platform}-cached`)
        await mkdir(cachedPartial)
        await expect(module.createDurableDirectoryPublisher({
          platform: 'posix',
          syncDirectory: async () => {},
        }).publishMissingDirectory(
          cachedPartial,
          cachedFinal,
          AbortSignal.timeout(2_000),
        )).resolves.toEqual({ outcome: 'durable' })

        const helperPartial = join(parent, `${testCase.platform}-helper.partial`)
        const helperFinal = join(parent, `${testCase.platform}-helper`)
        await writeFile(helperPartial, 'candidate\n')
        await expect(module.movePathPosixNoReplace(helperPartial, helperFinal)).resolves.toBeUndefined()
        await expect(readFile(helperFinal, 'utf8')).resolves.toBe('candidate\n')

        const failedPartial = join(parent, `${testCase.platform}-failed.partial`)
        const failedFinal = join(parent, `${testCase.platform}-failed`)
        await mkdir(failedPartial)
        failMove = true
        await expect(module.createDurableDirectoryPublisher({
          platform: 'posix',
          syncDirectory: async () => {},
        }).publishMissingDirectory(
          failedPartial,
          failedFinal,
          AbortSignal.timeout(2_000),
        )).rejects.toMatchObject({ code: 'EIO', syscall: testCase.functionName })

        expect(calls).toEqual([
          testCase.expectedCall(partial, final),
          testCase.expectedCall(cachedPartial, cachedFinal),
          testCase.expectedCall(helperPartial, helperFinal),
          testCase.expectedCall(failedPartial, failedFinal),
        ])
      }

      vi.doUnmock('koffi')
      vi.resetModules()
      Object.defineProperty(process, 'platform', { ...descriptor, value: 'freebsd' })
      vi.doMock('koffi', () => ({
        default: {
          errno: () => 0,
          os: { errno: {} },
          load: () => ({ func: () => () => 0 }),
        },
      }))
      const module = await import('../src/durable-directories.ts')
      const parent = await root()
      const partial = join(parent, 'unsupported.partial')
      await mkdir(partial)
      await expect(module.createDurableDirectoryPublisher({ platform: 'posix' })
        .publishMissingDirectory(
          partial,
          join(parent, 'unsupported'),
          AbortSignal.timeout(2_000),
        )).rejects.toMatchObject({ code: 'ENOTSUP' })
      await expect(module.movePathPosixNoReplace(
        join(parent, 'unsupported-source'),
        join(parent, 'unsupported-target'),
      )).rejects.toMatchObject({ code: 'ENOTSUP' })
    } finally {
      Object.defineProperty(process, 'platform', descriptor)
    }
  })

  it('never replaces a target created in the POSIX pre-commit race window', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    if (descriptor === undefined) throw new Error('process.platform descriptor is missing')
    vi.resetModules()
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'linux' })
    vi.doMock('koffi', () => ({
      default: {
        errno: () => 17,
        os: { errno: { EEXIST: 17 } },
        load: () => ({
          func: () => (
            _oldDirectory: number,
            existing: string,
            _newDirectory: number,
            target: string,
            flags: number,
          ) => {
            expect(flags).toBe(1)
            if (existsSync(target)) return -1
            renameSync(existing, target)
            return 0
          },
        }),
      },
    }))
    try {
      const module = await import('../src/durable-directories.ts')
      const parent = await root()
      const partial = join(parent, 'raced.partial')
      const final = join(parent, 'raced')
      await mkdir(partial)
      await writeFile(join(partial, 'candidate'), 'candidate\n')
      const publisher = module.createDurableDirectoryPublisher({
        platform: 'posix',
        beforePublish: async () => {
          await mkdir(final)
          await writeFile(join(final, 'winner'), 'winner\n')
        },
        syncDirectory: async () => {},
      })

      await expect(publisher.publishMissingDirectory(
        partial,
        final,
        AbortSignal.timeout(2_000),
      )).rejects.toMatchObject({ code: 'EEXIST', syscall: 'renameat2' })

      await expect(readFile(join(partial, 'candidate'), 'utf8')).resolves.toBe('candidate\n')
      await expect(readFile(join(final, 'winner'), 'utf8')).resolves.toBe('winner\n')
    } finally {
      Object.defineProperty(process, 'platform', descriptor)
    }
  })
})
