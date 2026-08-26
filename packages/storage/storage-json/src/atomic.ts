/**
 * Atomic whole-file replacement for the JSON backend.
 *
 * Publish protocol: write a same-directory temp file, fsync it, then
 * `rename()` over the target. Rename is an atomic replace on POSIX and on
 * Windows (libuv maps it to `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)`),
 * and replacement is the intended semantic here — unlike the session-log
 * backend's link()+unlink() no-clobber protocol, a unit file has exactly one
 * writer per process and last-write-wins is correct. After the rename the
 * parent directory is fsynced on POSIX so the new entry is crash-durable.
 * @module @deepseek-ai/dsh-storage-json/src/atomic
 */

import { link, open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isCommitOutcomeUnknownStorageError, StorageError } from '@deepseek-ai/dsh-storage'

/** Root-identity check run immediately around path-based namespace publication. */
export interface AtomicPublicationGuard {
  /** Reject when the configured publication root no longer names the observed directory. */
  readonly verify: () => Promise<void>
}

/** Internal filesystem effects whose failure stage changes publication evidence. */
export interface AtomicWriteEffects {
  /** Confirm durability of a completed namespace publication. */
  readonly syncDirectory: (path: string) => Promise<void>
  /** Remove one same-directory temporary entry without following it. */
  readonly removeTemporary: (path: string) => Promise<void>
}

/** Atomic replace and create-only operations sharing one effect implementation. */
export interface AtomicWriter {
  /** Replace a path and confirm parent-directory durability. */
  readonly writeAtomic: (
    path: string,
    data: string,
    guard?: AtomicPublicationGuard,
  ) => Promise<void>
  /** Create one missing path and report its durability or commit uncertainty. */
  readonly writeAtomicCreate: (
    path: string,
    data: string,
    signal: AbortSignal,
    guard?: AtomicPublicationGuard,
  ) => Promise<AtomicCreateOutcome>
}

/** Commit evidence after create-only publication reaches or may have reached its final path. */
export type AtomicCreateOutcome =
  | { readonly outcome: 'durable' }
  | { readonly outcome: 'uncertain'; readonly cause: Error }

/**
 * Bind atomic publication to filesystem effects. Production uses real
 * directory sync and unlink operations; package tests inject only those
 * post-publication facts while retaining real namespace operations.
 * @param effects - Directory durability and temporary-entry removal effects.
 * @returns bound replace and create-only publication functions.
 */
export function createAtomicWriter(effects: AtomicWriteEffects): AtomicWriter {
  return {
    writeAtomic: (path, data, guard) => writeAtomicWithEffects(path, data, effects, guard),
    writeAtomicCreate: (path, data, signal, guard) =>
      writeAtomicCreateWithEffects(path, data, signal, effects, guard),
  }
}

const defaultWriter = createAtomicWriter({
  syncDirectory: fsyncDirectory,
  removeTemporary: path => rm(path, { force: true }),
})

/**
 * Durably replace `path` with `data`.
 * @param path - Absolute target file path.
 * @param data - Full new file content.
 * @param guard - Optional persistent root-identity check.
 * @returns resolution after the replacement is crash-durable.
 */
export async function writeAtomic(
  path: string,
  data: string,
  guard?: AtomicPublicationGuard,
): Promise<void> {
  await defaultWriter.writeAtomic(path, data, guard)
}

async function writeAtomicWithEffects(
  path: string,
  data: string,
  effects: AtomicWriteEffects,
  guard?: AtomicPublicationGuard,
): Promise<void> {
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`)
  let published = false
  try {
    const handle = await open(tmp, 'wx', 0o600)
    try {
      await handle.writeFile(data, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await guard?.verify()
    await rename(tmp, path)
    published = true
    await verifyPublishedRoot(path, guard)
    let durabilityFailure: unknown
    try {
      await effects.syncDirectory(dirname(path))
    } catch (error) {
      durabilityFailure = error
    }
    await verifyPublishedRoot(path, guard, durabilityFailure)
    if (durabilityFailure !== undefined) {
      throw asError(durabilityFailure, 'directory durability confirmation failed')
    }
  } catch (error) {
    if (published) {
      if (isCommitOutcomeUnknownStorageError(error)) throw error
      throw new StorageError(
        'durability-uncertain',
        `JSON value at '${path}' is visible but parent-directory durability is uncertain`,
        { cause: asError(error, 'directory durability confirmation failed') },
      )
    }
    // Cleanup failure can leave only the private temp entry. Preserve the
    // original failure, which alone classifies final-path publication.
    await removeTemporaryIfCurrent(tmp, effects, guard)
    throw error
  }
}

/**
 * Durably publish a complete new file without replacing an existing target.
 * @param path - Absolute target file path.
 * @param data - Full new file content.
 * @param signal - Caller cancellation, observed before the atomic publish.
 * @param guard - Optional persistent root-identity check.
 * @returns whether parent-directory durability was confirmed after linking.
 */
export async function writeAtomicCreate(
  path: string,
  data: string,
  signal: AbortSignal,
  guard?: AtomicPublicationGuard,
): Promise<AtomicCreateOutcome> {
  return await defaultWriter.writeAtomicCreate(path, data, signal, guard)
}

async function writeAtomicCreateWithEffects(
  path: string,
  data: string,
  signal: AbortSignal,
  effects: AtomicWriteEffects,
  guard?: AtomicPublicationGuard,
): Promise<AtomicCreateOutcome> {
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`)
  let publication: AtomicCreateOutcome | undefined
  let prePublicationFailure: unknown
  try {
    signal.throwIfAborted()
    const handle = await open(tmp, 'wx', 0o600)
    try {
      await handle.writeFile(data, { encoding: 'utf8', signal })
      await handle.sync()
    } finally {
      await handle.close()
    }
    signal.throwIfAborted()
    // Temp and target share a directory. link() therefore publishes the
    // already-synced bytes atomically and fails with EEXIST instead of
    // replacing a target created by another process.
    await guard?.verify()
    signal.throwIfAborted()
    await link(tmp, path)
    try {
      await verifyPublishedRoot(path, guard)
      let durabilityFailure: unknown
      try {
        await effects.syncDirectory(dirname(path))
      } catch (error) {
        durabilityFailure = error
      }
      await verifyPublishedRoot(path, guard, durabilityFailure)
      publication = durabilityFailure === undefined
        ? { outcome: 'durable' }
        : {
          outcome: 'uncertain',
          cause: asError(durabilityFailure, 'directory durability confirmation failed'),
        }
    } catch (error) {
      publication = {
        outcome: 'uncertain',
        cause: asError(error, 'publication outcome confirmation failed'),
      }
    }
  } catch (error) {
    prePublicationFailure = error
  }

  const cleanupFailure = await removeTemporaryIfCurrent(tmp, effects, guard)

  if (publication === undefined) {
    throw prePublicationFailure
  }
  if (cleanupFailure !== undefined) {
    if (isCommitOutcomeUnknownStorageError(cleanupFailure)
      || (publication.outcome === 'uncertain'
        && isCommitOutcomeUnknownStorageError(publication.cause))) {
      return {
        outcome: 'uncertain',
        cause: new StorageError(
          'commit-outcome-unknown',
          `JSON target '${path}' may be published and temporary cleanup also failed`,
          {
            cause: new AggregateError([
              ...(publication.outcome === 'uncertain' ? [publication.cause] : []),
              cleanupFailure,
            ]),
          },
        ),
      }
    }
    if (publication.outcome === 'uncertain') {
      return {
        outcome: 'uncertain',
        cause: new AggregateError(
          [publication.cause, cleanupFailure],
          `JSON target '${path}' is visible but durability and temporary cleanup are uncertain`,
        ),
      }
    }
  }
  return publication
}

async function removeTemporaryIfCurrent(
  path: string,
  effects: AtomicWriteEffects,
  guard: AtomicPublicationGuard | undefined,
): Promise<Error | undefined> {
  try {
    await guard?.verify()
  } catch (error) {
    return new StorageError(
      'commit-outcome-unknown',
      `JSON temporary entry at '${path}' cannot be safely located after root identity changed`,
      { cause: asError(error, 'temporary cleanup root identity check failed') },
    )
  }
  try {
    await effects.removeTemporary(path)
  } catch (error) {
    return asError(error, 'temporary entry cleanup failed')
  }
  return undefined
}

async function verifyPublishedRoot(
  path: string,
  guard: AtomicPublicationGuard | undefined,
  priorFailure?: unknown,
): Promise<void> {
  try {
    await guard?.verify()
  } catch (error) {
    const rootFailure = asError(error, 'publication root identity check failed')
    const cause = priorFailure === undefined
      ? rootFailure
      : new AggregateError([
        asError(priorFailure, 'directory durability confirmation failed'),
        rootFailure,
      ])
    throw new StorageError(
      'commit-outcome-unknown',
      `JSON publication at '${path}' cannot be attributed to the observed storage root`,
      { cause },
    )
  }
}

function asError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message, { cause: value })
}

/** fsync a POSIX directory so a just-renamed entry is crash-durable. */
/* v8 ignore start -- Windows rejects O_RDONLY directory opens; POSIX coverage exercises this. */
async function fsyncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
/* v8 ignore stop */
