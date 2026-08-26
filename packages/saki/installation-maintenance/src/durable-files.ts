/**
 * Durable create-only and replacement publication for Saki maintenance files.
 * @module @breakfastdapaidang/saki-installation-maintenance/durable-files
 */

import { link, lstat, open, readFile, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import {
  movePathPosixNoReplace,
  movePathWin32WriteThrough,
} from './durable-directories.ts'
import { SakiMaintenanceError } from './error.ts'

const MOVEFILE_REPLACE_EXISTING = 0x00000001
const MOVEFILE_WRITE_THROUGH = 0x00000008

/** Filesystem publication family selected by the running Host or a platform test. */
export type DurableFilePlatform = 'posix' | 'win32'

/** Successful namespace-publication evidence. */
export type DurableFileResult =
  | {
    /** The final namespace entry and its bytes are crash-durable. */
    readonly outcome: 'durable'
  }
  | {
    /** Exact final bytes are visible, but namespace durability was not confirmed. */
    readonly outcome: 'published'
    /** Failure after the namespace commit. */
    readonly cause: Error
  }

/** Exact final-path state observed after a failed post-publication effect. */
export type DurableFileFinalState = 'different' | 'missing' | 'unreadable'

/** A namespace commit may have occurred, but exact final bytes cannot prove it. */
export class DurableFileOutcomeUnknownError extends Error {
  /** Stable machine-readable failure class. */
  readonly code = 'publication-outcome-unknown' as const
  /** Recovery must assume the target may have been published. */
  readonly publicationPossible = true as const
  /** Final-path evidence that prevented exact commit confirmation. */
  readonly finalState: DurableFileFinalState

  /**
   * @param path - target whose commit could not be confirmed.
   * @param finalState - exact final-path classification.
   * @param cause - post-publication or readback failure.
   */
  constructor(path: string, finalState: DurableFileFinalState, cause: Error) {
    super(`durable file publication at '${path}' has an unknown outcome`, { cause })
    this.name = 'DurableFileOutcomeUnknownError'
    this.finalState = finalState
  }
}

/** Injectable effects around the actual namespace commit. */
export interface DurableFileEffects {
  /** Override the Host publication family. */
  readonly platform?: DurableFilePlatform
  /** Observe or fail immediately before the namespace commit. */
  readonly beforePublish?: (temporaryPath: string, targetPath: string) => Promise<void>
  /** Observe or fail immediately after the namespace commit. */
  readonly afterPublish?: (temporaryPath: string, targetPath: string) => Promise<void>
  /** Override POSIX parent-directory synchronization. */
  readonly syncDirectory?: (path: string) => Promise<void>
  /** Override final-path readback after a post-publication failure. */
  readonly readFinal?: (path: string) => Promise<Uint8Array>
  /** Override owner-temp cleanup. */
  readonly removeTemporary?: (path: string) => Promise<void>
  /** Override the POSIX create-only atomic move. */
  readonly moveFilePosix?: (temporaryPath: string, targetPath: string) => Promise<void>
  /** Override the native Windows namespace move while retaining production flags. */
  readonly moveFileWin32?: (temporaryPath: string, targetPath: string, flags: number) => Promise<void>
}

/** Bound durable-file operations. */
export interface DurableFileWriter {
  /**
   * Publish a complete file only when the target is missing.
   * @param path - absolute missing target path.
   * @param bytes - complete bytes copied before the first await.
   * @param signal - cancellation observed through the namespace commit.
   * @returns durable or exact visible publication evidence.
   */
  publishMissingFile(
    path: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<DurableFileResult>
  /**
   * Atomically replace a target with a complete file.
   * @param path - absolute target path.
   * @param bytes - complete bytes copied before the first await.
   * @param signal - cancellation observed through the namespace commit.
   * @returns durable or exact visible publication evidence.
   */
  replaceFileDurably(
    path: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<DurableFileResult>
}

/** Injectable effects for exact startup cleanup of one deterministic temp. */
export interface DurableFileTemporaryEffects {
  /** Override the Host publication family. */
  readonly platform?: DurableFilePlatform
  /** Override exact temp removal. */
  readonly removeTemporary?: (path: string) => Promise<void>
  /** Override POSIX parent-directory synchronization. */
  readonly syncDirectory?: (path: string) => Promise<void>
}

/**
 * Derive the sole recoverable sibling temp for one durable-file target.
 * @param path - final file path.
 * @returns absolute deterministic temp path that never selects state.
 */
export function durableFileTemporaryPath(path: string): string {
  const target = resolve(path)
  return join(dirname(target), `.${basename(target)}.saki-tmp`)
}

/**
 * Remove one exact non-authoritative durable-file temp during startup recovery.
 * @param targetPath - final target whose deterministic sibling temp is owned by recovery.
 * @param signal - cancellation observed before cleanup begins.
 * @param effects - optional platform effects for failure-path tests.
 * @returns after the current namespace no longer contains the temp.
 */
export async function discardDurableFileTemporary(
  targetPath: string,
  signal: AbortSignal,
  effects: DurableFileTemporaryEffects = {},
): Promise<void> {
  signal.throwIfAborted()
  const temporary = durableFileTemporaryPath(targetPath)
  let info
  try {
    info = await lstat(temporary)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return
    throw new SakiMaintenanceError(
      'recovery-required',
      `Saki durable-file temp '${temporary}' cannot be inspected`,
      { cause: asError(error, 'durable-file temp inspection failed') },
    )
  }
  if (!info.isFile() && !info.isSymbolicLink()) {
    throw new SakiMaintenanceError(
      'recovery-required',
      `Saki durable-file temp '${temporary}' is not a removable file entry`,
    )
  }
  try {
    await (effects.removeTemporary ?? unlink)(temporary)
    /* v8 ignore next -- process.platform is Host-invariant; Windows cleanup tests cover the Win32 default. */
    const platform = effects.platform ?? (process.platform === 'win32' ? 'win32' : 'posix')
    if (platform === 'posix') {
      await (effects.syncDirectory ?? syncDirectory)(dirname(temporary))
    }
  } catch (error) {
    throw new SakiMaintenanceError(
      'recovery-required',
      `Saki durable-file temp '${temporary}' cannot be removed`,
      { cause: asError(error, 'durable-file temp cleanup failed') },
    )
  }
}

/**
 * Bind Saki durable-file operations to optional fault-test effects.
 * @param effects - platform and commit-adjacent test effects.
 * @returns bound durable-file operations.
 */
export function createDurableFileWriter(effects: DurableFileEffects = {}): DurableFileWriter {
  const platform = effects.platform ?? (process.platform === 'win32' ? 'win32' : 'posix')
  const publish = async (
    operation: 'missing' | 'replace',
    path: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<DurableFileResult> => {
    signal.throwIfAborted()
    const snapshot = Buffer.from(bytes)
    const target = resolve(path)
    const temporary = durableFileTemporaryPath(target)
    const handle = await open(temporary, 'wx', 0o600)
    let preparationFailure: Error | undefined
    try {
      await handle.writeFile(snapshot, { signal })
      await handle.sync()
    } catch (error) {
      preparationFailure = asError(error, 'temporary file preparation failed')
    }
    try {
      await handle.close()
    } catch (error) {
      preparationFailure = preparationFailure === undefined
        ? asError(error, 'temporary file close failed')
        : combineFailures(
          preparationFailure,
          asError(error, 'temporary file close failed'),
        )
    }
    if (preparationFailure !== undefined) {
      await cleanupTemporary(temporary, effects.removeTemporary)
      throw preparationFailure
    }
    let postPublicationFailure: Error | undefined
    try {
      let commit: (temporaryPath: string, targetPath: string) => void | Promise<void>
      if (platform === 'win32') {
        const flags = MOVEFILE_WRITE_THROUGH
          | (operation === 'replace' ? MOVEFILE_REPLACE_EXISTING : 0)
        const injectedMove = effects.moveFileWin32
        if (injectedMove !== undefined) {
          commit = (temporaryPath, targetPath) => injectedMove(temporaryPath, targetPath, flags)
        } else {
          commit = (temporaryPath, targetPath) => movePathWin32WriteThrough(
            temporaryPath,
            targetPath,
            operation === 'replace',
            signal,
          )
        }
      } else if (operation === 'missing') {
        const injectedMove = effects.moveFilePosix
        if (injectedMove !== undefined) {
          commit = injectedMove
        /* v8 ignore start -- process.platform is Host-invariant; native Windows tests cover this fallback. */
        } else if (process.platform === 'win32') {
          commit = async (temporaryPath, targetPath) => {
            await link(temporaryPath, targetPath)
            await unlink(temporaryPath)
          }
        /* v8 ignore stop */
        } else {
          commit = movePathPosixNoReplace
        }
      } else {
        commit = (temporaryPath, targetPath) => rename(temporaryPath, targetPath)
      }
      signal.throwIfAborted()
      await effects.beforePublish?.(temporary, target)
      signal.throwIfAborted()
      await commit(temporary, target)
      try {
        await effects.afterPublish?.(temporary, target)
        if (platform === 'posix') {
          await (effects.syncDirectory ?? syncDirectory)(dirname(target))
        }
      } catch (error) {
        postPublicationFailure = asError(error, 'post-publication durability confirmation failed')
      }
    } catch (error) {
      await cleanupTemporary(temporary, effects.removeTemporary)
      throw asError(error, 'namespace publication failed')
    }

    const cleanup = await cleanupTemporary(temporary, effects.removeTemporary)
    let cleanupFailure = cleanup.failure
    if (platform === 'posix' && cleanup.removed) {
      try {
        await (effects.syncDirectory ?? syncDirectory)(dirname(target))
      } catch (error) {
        cleanupFailure = asError(error, 'temporary-cleanup directory sync failed')
      }
    }
    let primaryFailure: Error
    let secondaryCleanupFailure: Error | undefined
    if (postPublicationFailure === undefined) {
      if (cleanupFailure === undefined) return { outcome: 'durable' }
      primaryFailure = cleanupFailure
      secondaryCleanupFailure = undefined
    } else {
      primaryFailure = postPublicationFailure
      secondaryCleanupFailure = cleanupFailure
    }

    const readback = await readFinal(target, snapshot, effects.readFinal)
    const readbackFailure = readback.state === 'unreadable' ? readback.cause : undefined
    const cause = combineFailures(
      primaryFailure,
      secondaryCleanupFailure,
      readbackFailure,
    )
    if (readback.state === 'exact') return { outcome: 'published', cause }
    throw new DurableFileOutcomeUnknownError(target, readback.state, cause)
  }
  return {
    publishMissingFile: (path, bytes, signal) => publish('missing', path, bytes, signal),
    replaceFileDurably: (path, bytes, signal) => publish('replace', path, bytes, signal),
  }
}

const defaultWriter = createDurableFileWriter()

/**
 * Publish a synced complete file without replacing an existing target.
 * @param path - absolute missing target path.
 * @param bytes - complete file bytes copied before the first await.
 * @param signal - cancellation observed through the namespace commit.
 * @returns durable publication evidence.
 */
export async function publishMissingFile(
  path: string,
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<DurableFileResult> {
  return await defaultWriter.publishMissingFile(path, bytes, signal)
}

/**
 * Replace a target with synced complete bytes and a durable namespace commit.
 * @param path - absolute target path.
 * @param bytes - complete file bytes copied before the first await.
 * @param signal - cancellation observed through the namespace commit.
 * @returns durable publication evidence.
 */
export async function replaceFileDurably(
  path: string,
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<DurableFileResult> {
  return await defaultWriter.replaceFileDurably(path, bytes, signal)
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function cleanupTemporary(
  path: string,
  remove: ((path: string) => Promise<void>) | undefined,
): Promise<{ readonly removed: boolean; readonly failure?: Error }> {
  try {
    await (remove ?? unlink)(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return { removed: false }
    try {
      await lstat(path)
    } catch (inspectionError) {
      /* v8 ignore else -- a failed cleanup normally leaves the fixed path readable or absent. */
      if ((inspectionError as NodeJS.ErrnoException | null)?.code === 'ENOENT') return { removed: false }
      /* v8 ignore next 7 -- requires cleanup and the immediate fixed-path lstat to fail differently. */
      return {
        removed: false,
        failure: combineFailures(
          asError(error, 'temporary cleanup failed'),
          asError(inspectionError, 'temporary cleanup readback failed'),
        ),
      }
    }
    return { removed: false, failure: asError(error, 'temporary cleanup failed') }
  }
  return { removed: true }
}

type FinalReadback =
  | { readonly state: 'exact' | 'different' | 'missing' }
  | { readonly state: 'unreadable'; readonly cause: Error }

async function readFinal(
  path: string,
  expected: Buffer,
  read: ((path: string) => Promise<Uint8Array>) | undefined,
): Promise<FinalReadback> {
  try {
    const actual = Buffer.from(await (read ?? readFile)(path))
    return { state: actual.equals(expected) ? 'exact' : 'different' }
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return { state: 'missing' }
    return { state: 'unreadable', cause: asError(error, 'final readback failed') }
  }
}

function combineFailures(primary: Error, ...secondary: Array<Error | undefined>): Error {
  const failures = [primary, ...secondary.filter(value => value !== undefined)]
  return failures.length === 1
    ? primary
    : new AggregateError(failures, 'durable publication and cleanup or readback failed')
}

function asError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message, { cause: value })
}
