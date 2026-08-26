/**
 * Crash-durable create-only publication for complete Saki directories.
 * @module @breakfastdapaidang/saki-installation-maintenance/durable-directories
 */

import type { BigIntStats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { dirname, isAbsolute, resolve, toNamespacedPath } from 'node:path'
import type {
  DurableFileFinalState,
  DurableFilePlatform,
  DurableFileResult,
} from './durable-files.ts'

const MOVEFILE_WRITE_THROUGH = 0x00000008
const MOVEFILE_REPLACE_EXISTING = 0x00000001
const ERROR_FILE_NOT_FOUND = 2
const ERROR_PATH_NOT_FOUND = 3
const ERROR_ACCESS_DENIED = 5
const ERROR_NOT_SAME_DEVICE = 17
const ERROR_FILE_EXISTS = 80
const ERROR_INVALID_NAME = 123
const ERROR_ALREADY_EXISTS = 183
const AT_FDCWD = -100
const RENAME_NOREPLACE = 0x00000001
const RENAME_EXCL = 0x00000004

type MoveFileExW = (existing: string, replacement: string, flags: number) => number
type GetLastError = () => number

interface Win32Bindings {
  readonly moveFileExW: MoveFileExW
  readonly getLastError: GetLastError
}

interface KoffiLibrary {
  func(name: string, result: string, args: string[]): unknown
  func(convention: string, name: string, result: string, args: string[]): unknown
}

interface Koffi {
  load(path: string | null): KoffiLibrary
  errno(): number
  readonly os: {
    readonly errno: Readonly<Record<string, number>>
  }
}

interface Win32ErrnoException extends NodeJS.ErrnoException {
  readonly win32Code: number
  readonly dest: string
}

let win32Bindings: Win32Bindings | undefined
let posixBindings: PosixBindings | undefined

interface PosixBindings {
  moveNoReplace(existing: string, target: string): void
}

/** A directory commit may have occurred, but exact final identity cannot prove it. */
export class DurableDirectoryOutcomeUnknownError extends Error {
  /** Stable machine-readable failure class. */
  readonly code = 'publication-outcome-unknown' as const
  /** Recovery must assume the final directory may have been published. */
  readonly publicationPossible = true as const
  /** Final-path evidence that prevented exact commit confirmation. */
  readonly finalState: DurableFileFinalState

  /**
   * @param path - final directory whose publication could not be confirmed.
   * @param finalState - exact final-path classification.
   * @param cause - commit-adjacent or identity-inspection failure.
   */
  constructor(path: string, finalState: DurableFileFinalState, cause: Error) {
    super(`durable directory publication at '${path}' has an unknown outcome`, { cause })
    this.name = 'DurableDirectoryOutcomeUnknownError'
    this.finalState = finalState
  }
}

/** Injectable commit-adjacent effects for directory publication fault tests. */
export interface DurableDirectoryEffects {
  /** Override the Host publication family. */
  readonly platform?: DurableFilePlatform
  /** Observe or fail after validation and immediately before the namespace commit. */
  readonly beforePublish?: (partialDirectory: string, finalDirectory: string) => Promise<void>
  /** Observe or fail immediately after the namespace commit. */
  readonly afterPublish?: (partialDirectory: string, finalDirectory: string) => Promise<void>
  /** Override the POSIX parent-directory synchronization. */
  readonly syncDirectory?: (directory: string) => Promise<void>
  /** Override the POSIX create-only directory rename. */
  readonly moveDirectoryPosix?: (
    partialDirectory: string,
    finalDirectory: string,
  ) => Promise<void>
  /** Override the Windows native move while retaining production flags. */
  readonly moveDirectoryWin32?: (
    partialDirectory: string,
    finalDirectory: string,
    flags: number,
  ) => Promise<void>
  /** Override final-path identity inspection after the commit. */
  readonly inspectFinal?: (finalDirectory: string) => Promise<BigIntStats>
}

/** Bound complete-directory publication. */
export interface DurableDirectoryPublisher {
  /**
   * Publish one complete real directory at a missing sibling path.
   * @param partialDirectory - absolute normalized owned source directory.
   * @param finalDirectory - absolute normalized missing sibling target.
   * @param signal - cancellation observed until the namespace commit starts.
   * @returns durable publication evidence.
   */
  publishMissingDirectory(
    partialDirectory: string,
    finalDirectory: string,
    signal: AbortSignal,
  ): Promise<DurableFileResult>
}

/**
 * Bind durable directory publication to optional fault-test effects.
 * @param effects - platform and commit-adjacent effects.
 * @returns bound directory publisher.
 */
export function createDurableDirectoryPublisher(
  effects: DurableDirectoryEffects = {},
): DurableDirectoryPublisher {
  const platform = effects.platform ?? (process.platform === 'win32' ? 'win32' : 'posix')
  return {
    publishMissingDirectory: async (partialPath, finalPath, signal) => {
      signal.throwIfAborted()
      const paths = strictSiblingPaths(partialPath, finalPath)
      const [parentInfo, partialInfo] = await Promise.all([
        lstat(paths.parent, { bigint: true }),
        lstat(paths.partial, { bigint: true }),
      ])
      requireRealDirectory(paths.parent, parentInfo, 'parent')
      requireRealDirectory(paths.partial, partialInfo, 'partial')
      await requireMissing(paths.final)
      const move = await prepareDirectoryMove(paths, platform, effects)
      signal.throwIfAborted()
      await effects.beforePublish?.(paths.partial, paths.final)
      signal.throwIfAborted()
      let commitFailure: Error | undefined
      try {
        await move()
      } catch (error) {
        commitFailure = asError(error, 'directory namespace commit failed')
      }
      if (commitFailure !== undefined) {
        return await classifyFailedCommit(
          paths,
          partialInfo,
          commitFailure,
          platform,
          effects,
        )
      }
      const failures: Error[] = []
      try {
        await effects.afterPublish?.(paths.partial, paths.final)
      } catch (error) {
        failures.push(asError(error, 'post-publication directory effect failed'))
      }
      if (platform === 'posix') {
        try {
          await (effects.syncDirectory ?? syncDirectory)(paths.parent)
        } catch (error) {
          failures.push(asError(error, 'parent-directory sync failed'))
        }
      }
      const readback = await readFinal(paths.final, partialInfo, effects.inspectFinal)
      if (readback.state === 'exact') {
        return failures.length === 0
          ? { outcome: 'durable' }
          : { outcome: 'published', cause: combineFailures(failures) }
      }
      throw new DurableDirectoryOutcomeUnknownError(
        paths.final,
        readback.state,
        combineFailures([...failures, readback.cause]),
      )
    },
  }
}

const defaultPublisher = createDurableDirectoryPublisher()

/**
 * Publish one complete real directory at a missing sibling path.
 * @param partialDirectory - absolute normalized owned source directory.
 * @param finalDirectory - absolute normalized missing sibling target.
 * @param signal - cancellation observed until the namespace commit starts.
 * @returns durable or exact visible publication evidence.
 */
export async function publishMissingDirectory(
  partialDirectory: string,
  finalDirectory: string,
  signal: AbortSignal,
): Promise<DurableFileResult> {
  return await defaultPublisher.publishMissingDirectory(partialDirectory, finalDirectory, signal)
}

async function prepareDirectoryMove(
  paths: StrictSiblingPaths,
  platform: DurableFilePlatform,
  effects: DurableDirectoryEffects,
): Promise<() => Promise<void>> {
  if (platform === 'win32') {
    const injected = effects.moveDirectoryWin32
    if (injected !== undefined) {
      return async () => {
        await injected(paths.partial, paths.final, MOVEFILE_WRITE_THROUGH)
      }
    }
    if (process.platform !== 'win32') throw unsupportedPublication('win32')
    const api = await loadWin32Bindings()
    return () => {
      movePathWin32WithBindings(api, paths.partial, paths.final, false)
      return Promise.resolve()
    }
  }
  const injected = effects.moveDirectoryPosix
  if (injected !== undefined) {
    return async () => {
      await injected(paths.partial, paths.final)
    }
  }
  const api = await loadPosixBindings()
  return () => {
    api.moveNoReplace(paths.partial, paths.final)
    return Promise.resolve()
  }
}

async function classifyFailedCommit(
  paths: StrictSiblingPaths,
  partialInfo: BigIntStats,
  commitFailure: Error,
  platform: DurableFilePlatform,
  effects: DurableDirectoryEffects,
): Promise<DurableFileResult> {
  const finalReadback = await readFinal(paths.final, partialInfo, effects.inspectFinal)
  if (finalReadback.state === 'exact') {
    const failures = [commitFailure]
    if (platform === 'posix') {
      try {
        await (effects.syncDirectory ?? syncDirectory)(paths.parent)
      } catch (error) {
        failures.push(asError(error, 'parent-directory sync failed'))
      }
    }
    return { outcome: 'published', cause: combineFailures(failures) }
  }
  const partialReadback = await readFinal(paths.partial, partialInfo, undefined)
  if (partialReadback.state === 'exact') throw commitFailure
  const evidenceFailures = [commitFailure, finalReadback.cause, partialReadback.cause]
  throw new DurableDirectoryOutcomeUnknownError(
    paths.final,
    finalReadback.state,
    combineFailures(evidenceFailures),
  )
}

/**
 * Atomically move one Windows path with write-through durability.
 *
 * This internal maintenance primitive never enables cross-volume copy fallback. The caller owns
 * Installation-root containment and must explicitly choose whether an existing target is replaced.
 * @param existingPath - absolute normalized source file or directory.
 * @param targetPath - absolute normalized target on the same Windows volume.
 * @param replaceExisting - whether to add `MOVEFILE_REPLACE_EXISTING`.
 * @param signal - cancellation checked before and after native binding discovery.
 * @returns after the native move reports success.
 */
export async function movePathWin32WriteThrough(
  existingPath: string,
  targetPath: string,
  replaceExisting: boolean,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  const paths = strictAbsoluteMovePaths(existingPath, targetPath)
  if (process.platform !== 'win32') throw unsupportedPublication('win32')
  const api = await loadWin32Bindings()
  signal.throwIfAborted()
  movePathWin32WithBindings(api, paths.existing, paths.target, replaceExisting)
}

/**
 * Atomically move one POSIX path only when the target is missing.
 * @param existingPath - absolute normalized source file or directory.
 * @param targetPath - absolute normalized missing target on the same filesystem.
 * @returns after the native no-replace rename reports success.
 */
export async function movePathPosixNoReplace(
  existingPath: string,
  targetPath: string,
): Promise<void> {
  const paths = strictAbsoluteMovePaths(existingPath, targetPath)
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw unsupportedPublication('posix')
  }
  const api = await loadPosixBindings()
  api.moveNoReplace(paths.existing, paths.target)
}

function movePathWin32WithBindings(
  api: Win32Bindings,
  existingPath: string,
  targetPath: string,
  replaceExisting: boolean,
): void {
  const ok = api.moveFileExW(
    toNamespacedPath(existingPath),
    toNamespacedPath(targetPath),
    MOVEFILE_WRITE_THROUGH | (replaceExisting ? MOVEFILE_REPLACE_EXISTING : 0),
  )
  if (ok === 0) {
    throw win32Error(
      'MoveFileExW',
      api.getLastError(),
      existingPath,
      targetPath,
    )
  }
}

interface StrictSiblingPaths {
  readonly partial: string
  readonly final: string
  readonly parent: string
}

interface StrictAbsoluteMovePaths {
  readonly existing: string
  readonly target: string
}

function strictSiblingPaths(partialPath: string, finalPath: string): StrictSiblingPaths {
  if (!isAbsolute(partialPath) || resolve(partialPath) !== partialPath) {
    throw new TypeError('partial directory path must be absolute and normalized')
  }
  if (!isAbsolute(finalPath) || resolve(finalPath) !== finalPath) {
    throw new TypeError('final directory path must be absolute and normalized')
  }
  const parent = dirname(partialPath)
  if (dirname(finalPath) !== parent || finalPath === partialPath) {
    throw new TypeError('partial and final directory paths must be distinct siblings')
  }
  return { partial: partialPath, final: finalPath, parent }
}

function strictAbsoluteMovePaths(
  existingPath: string,
  targetPath: string,
): StrictAbsoluteMovePaths {
  if (!isAbsolute(existingPath) || resolve(existingPath) !== existingPath) {
    throw new TypeError('existing path must be absolute and normalized')
  }
  if (!isAbsolute(targetPath) || resolve(targetPath) !== targetPath) {
    throw new TypeError('target path must be absolute and normalized')
  }
  if (existingPath === targetPath) throw new TypeError('existing and target paths must be distinct')
  return { existing: existingPath, target: targetPath }
}

function requireRealDirectory(path: string, info: BigIntStats, role: string): void {
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new TypeError(`${role} path '${path}' must be a real directory`)
  }
}

async function requireMissing(path: string): Promise<void> {
  try {
    await lstat(path)
  } catch (error) {
    /* v8 ignore else -- the fixed target probe reaches this catch normally only when missing. */
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return
    /* v8 ignore next -- requires a Host lstat failure other than a missing fixed target. */
    throw error
  }
  const error = new Error(`directory publication target '${path}' already exists`) as NodeJS.ErrnoException
  error.code = 'EEXIST'
  error.path = path
  throw error
}

function sameDirectory(before: BigIntStats, after: BigIntStats): boolean {
  return after.isDirectory()
    && !after.isSymbolicLink()
    && before.dev === after.dev
    && before.ino === after.ino
}

type FinalReadback =
  | { readonly state: 'exact' }
  | { readonly state: DurableFileFinalState; readonly cause: Error }

async function readFinal(
  path: string,
  expected: BigIntStats,
  inspect: ((path: string) => Promise<BigIntStats>) | undefined,
): Promise<FinalReadback> {
  let actual: BigIntStats
  try {
    actual = await (inspect ?? inspectFinal)(path)
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
      ? { state: 'missing', cause: asError(error, 'final directory is missing') }
      : { state: 'unreadable', cause: asError(error, 'final directory inspection failed') }
  }
  return sameDirectory(expected, actual)
    ? { state: 'exact' }
    : {
      state: 'different',
      cause: new Error(`final path '${path}' is not the published source directory`),
    }
}

async function inspectFinal(path: string): Promise<BigIntStats> {
  return await lstat(path, { bigint: true })
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function unsupportedPublication(platform: DurableFilePlatform): Error {
  const error = new Error(`durable ${platform} directory publication is unavailable`) as NodeJS.ErrnoException
  error.code = 'ENOTSUP'
  return error
}

function asError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message, { cause: value })
}

function combineFailures(failures: readonly Error[]): Error {
  return failures.length === 1
    ? (failures[0] as Error)
    : new AggregateError(failures, 'durable directory publication and confirmation failed')
}

async function loadWin32Bindings(): Promise<Win32Bindings> {
  if (win32Bindings !== undefined) return win32Bindings
  const koffi = (await import('koffi')).default as unknown as Koffi
  const kernel32 = koffi.load('kernel32.dll')
  win32Bindings = {
    moveFileExW: kernel32.func(
      '__stdcall',
      'MoveFileExW',
      'int',
      ['str16', 'str16', 'uint'],
    ) as MoveFileExW,
    getLastError: kernel32.func('__stdcall', 'GetLastError', 'uint', []) as GetLastError,
  }
  return win32Bindings
}

async function loadPosixBindings(): Promise<PosixBindings> {
  if (posixBindings !== undefined) return posixBindings
  const koffi = (await import('koffi')).default as unknown as Koffi
  if (process.platform === 'linux') {
    const libc = koffi.load('libc.so.6')
    const renameat2 = libc.func(
      'renameat2',
      'int',
      ['int', 'str', 'int', 'str', 'uint'],
    ) as (oldDirectory: number, oldPath: string, newDirectory: number, newPath: string, flags: number) => number
    posixBindings = {
      moveNoReplace: (existing, target) => {
        if (renameat2(AT_FDCWD, existing, AT_FDCWD, target, RENAME_NOREPLACE) !== 0) {
          throw posixError('renameat2', koffi.errno(), existing, target, koffi.os.errno)
        }
      },
    }
    return posixBindings
  }
  if (process.platform === 'darwin') {
    const libSystem = koffi.load('/usr/lib/libSystem.B.dylib')
    const renamex = libSystem.func(
      'renamex_np',
      'int',
      ['str', 'str', 'uint'],
    ) as (oldPath: string, newPath: string, flags: number) => number
    posixBindings = {
      moveNoReplace: (existing, target) => {
        if (renamex(existing, target, RENAME_EXCL) !== 0) {
          throw posixError('renamex_np', koffi.errno(), existing, target, koffi.os.errno)
        }
      },
    }
    return posixBindings
  }
  throw unsupportedPublication('posix')
}

function win32Error(
  syscall: string,
  win32Code: number,
  path: string,
  dest: string,
): Win32ErrnoException {
  const code = win32ErrnoCode(win32Code)
  const error = new Error(
    `${syscall} ${code} (Win32 ${win32Code}): ${path} -> ${dest}`,
  ) as Win32ErrnoException
  Object.assign(error, {
    code,
    errno: win32Code,
    syscall,
    path,
    dest,
    win32Code,
  })
  return error
}

function win32ErrnoCode(win32Code: number): string {
  switch (win32Code) {
    case ERROR_FILE_NOT_FOUND:
    case ERROR_PATH_NOT_FOUND:
      return 'ENOENT'
    case ERROR_ACCESS_DENIED:
      return 'EACCES'
    case ERROR_NOT_SAME_DEVICE:
      return 'EXDEV'
    case ERROR_FILE_EXISTS:
    case ERROR_ALREADY_EXISTS:
      return 'EEXIST'
    case ERROR_INVALID_NAME:
      return 'EINVAL'
    default:
      return 'EIO'
  }
}

function posixError(
  syscall: string,
  errno: number,
  path: string,
  dest: string,
  errorNumbers: Readonly<Record<string, number>>,
): NodeJS.ErrnoException {
  const code = posixErrnoCode(errno, errorNumbers)
  const error = new Error(
    `${syscall} ${code} (${errno}): ${path} -> ${dest}`,
  ) as NodeJS.ErrnoException & { dest: string }
  Object.assign(error, { code, errno, syscall, path, dest })
  return error
}

function posixErrnoCode(
  errno: number,
  errorNumbers: Readonly<Record<string, number>>,
): string {
  const codes = [
    'ENOENT',
    'EACCES',
    'EPERM',
    'EXDEV',
    'EEXIST',
    'ENOTEMPTY',
    'EINVAL',
    'ENOSYS',
    'ENOTSUP',
  ]
  return codes.find(code => errorNumbers[code] === errno) ?? 'EIO'
}
