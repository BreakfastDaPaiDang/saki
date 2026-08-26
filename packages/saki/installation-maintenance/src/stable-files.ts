/** Stable path-and-handle reads for exact Installation-maintenance file evidence. */

import { createHash } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { asError, isMissingPathError } from './error.ts'

/** Exact content and identity evidence from one stable regular-file read. */
export interface StableRegularFileEvidence {
  /** Exact number of bytes hashed. */
  readonly byteLength: number
  /** Lowercase SHA-256 of the exact bytes. */
  readonly sha256: string
  /** Filesystem device identity when supplied by the platform. */
  readonly device: bigint
  /** Filesystem inode identity when supplied by the platform. */
  readonly inode: bigint
  /** Nanosecond modification time. */
  readonly modifiedNs: bigint
  /** Nanosecond metadata-change time. */
  readonly changedNs: bigint
}

/** Caller-owned failure classification for a stable digest read. */
export interface StableRegularFileFailures {
  /**
   * Classify a rejected stable-file invariant.
   * @param path - exact path being read.
   * @param reason - invariant that failed.
   * @returns failure carrying the caller's domain-specific code and diagnostic.
   */
  invalid(
    path: string,
    reason: 'not-regular' | 'changed-opening' | 'changed-reading',
  ): Error
}

/** Parameters that retain a caller's error code while sharing bounded-read mechanics. */
export interface StableBoundedRegularFileOptions {
  /** Maximum accepted complete byte length. */
  readonly byteLimit: number
  /** Human-readable file role including the exact path. */
  readonly description: string
  /**
   * Classify an invalid stable-file observation.
   * @param message - complete diagnostic for the rejected observation.
   * @returns failure carrying the caller's domain-specific code.
   */
  invalid(message: string): Error
}

/**
 * Compare all identity and mutation evidence used by stable file reads.
 * @param left - earlier file evidence.
 * @param right - later file evidence.
 * @returns whether both observations identify the same unchanged bytes.
 */
function sameFileEvidence(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

async function lstatInitialPath(
  path: string,
  allowInitiallyMissing: boolean,
): Promise<BigIntStats | undefined> {
  try {
    return await lstat(path, { bigint: true })
  } catch (error) {
    if (allowInitiallyMissing && isMissingPathError(error)) return undefined
    throw error
  }
}

type AsyncOutcome<T> =
  | { readonly status: 'fulfilled'; readonly value: T }
  | { readonly status: 'rejected'; readonly reason: unknown }

async function readAndClose<T>(
  handle: FileHandle,
  description: string,
  operation: () => Promise<T>,
): Promise<T> {
  let operationOutcome: AsyncOutcome<T>
  try {
    operationOutcome = { status: 'fulfilled', value: await operation() }
  } catch (error) {
    operationOutcome = { status: 'rejected', reason: error }
  }
  let closeOutcome: AsyncOutcome<void>
  try {
    await handle.close()
    closeOutcome = { status: 'fulfilled', value: undefined }
  } catch (error) {
    closeOutcome = { status: 'rejected', reason: error }
  }
  if (operationOutcome.status === 'rejected' && closeOutcome.status === 'rejected') {
    throw new AggregateError(
      [operationOutcome.reason, closeOutcome.reason],
      `reading ${description} and closing it failed`,
    )
  }
  if (operationOutcome.status === 'rejected') {
    throw asError(operationOutcome.reason, `reading ${description} failed`)
  }
  if (closeOutcome.status === 'rejected') {
    throw asError(closeOutcome.reason, `closing ${description} failed`)
  }
  return operationOutcome.value
}

/**
 * Hash one regular file and require its path, handle, identity, and size to stay fixed.
 * @param path - exact file path to observe.
 * @param signal - cancellation observed before and throughout hashing.
 * @param failures - caller-owned failure classification.
 * @returns exact digest and filesystem identity evidence.
 */
export function readStableRegularFileEvidence(
  path: string,
  signal: AbortSignal,
  failures: StableRegularFileFailures,
): Promise<StableRegularFileEvidence>
/**
 * Hash an optional regular file while distinguishing initial absence from later disappearance.
 * @param path - exact file path to observe.
 * @param signal - cancellation observed before and throughout hashing.
 * @param failures - caller-owned failure classification.
 * @param allowInitiallyMissing - literal opt-in for an initial `ENOENT` to return undefined.
 * @returns exact evidence, or undefined only when the first path observation is missing.
 */
export function readStableRegularFileEvidence(
  path: string,
  signal: AbortSignal,
  failures: StableRegularFileFailures,
  allowInitiallyMissing: true,
): Promise<StableRegularFileEvidence | undefined>
export async function readStableRegularFileEvidence(
  path: string,
  signal: AbortSignal,
  failures: StableRegularFileFailures,
  allowInitiallyMissing = false,
): Promise<StableRegularFileEvidence | undefined> {
  signal.throwIfAborted()
  const pathBefore = await lstatInitialPath(path, allowInitiallyMissing)
  if (pathBefore === undefined) return undefined
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
    throw failures.invalid(path, 'not-regular')
  }
  let handle: FileHandle
  try {
    handle = await open(path, 'r')
  } catch (error) {
    if (isMissingPathError(error)) throw failures.invalid(path, 'changed-opening')
    throw error
  }
  return await readAndClose(handle, `stable regular file '${path}'`, async () => {
    let opened: BigIntStats
    try {
      opened = await handle.stat({ bigint: true })
    } catch (error) {
      if (isMissingPathError(error)) throw failures.invalid(path, 'changed-opening')
      throw error
    }
    try {
      if (!sameFileEvidence(pathBefore, opened)) {
        throw failures.invalid(path, 'changed-opening')
      }
      const digest = createHash('sha256')
      const buffer = Buffer.allocUnsafe(64 * 1_024)
      let byteLength = 0
      for (;;) {
        signal.throwIfAborted()
        const result = await handle.read(buffer, 0, buffer.byteLength, byteLength)
        if (result.bytesRead === 0) break
        digest.update(buffer.subarray(0, result.bytesRead))
        byteLength += result.bytesRead
      }
      const after = await handle.stat({ bigint: true })
      const pathAfter = await lstat(path, { bigint: true })
      if (!sameFileEvidence(opened, after) || !sameFileEvidence(after, pathAfter)
        || BigInt(byteLength) !== after.size) {
        throw failures.invalid(path, 'changed-reading')
      }
      signal.throwIfAborted()
      return {
        byteLength,
        sha256: digest.digest('hex'),
        device: after.dev,
        inode: after.ino,
        modifiedNs: after.mtimeNs,
        changedNs: after.ctimeNs,
      }
    } catch (error) {
      if (isMissingPathError(error)) throw failures.invalid(path, 'changed-reading')
      throw error
    }
  })
}

/**
 * Read one bounded regular file and reject every identity or size change.
 * @param path - exact file path to read.
 * @param signal - cancellation observed before and throughout reading.
 * @param options - byte bound, diagnostic role, and domain failure classifier.
 * @param allowInitiallyMissing - whether an initial `ENOENT` returns undefined.
 * @returns exact bytes, or undefined only for an allowed initially missing path.
 */
export async function readStableBoundedRegularFile(
  path: string,
  signal: AbortSignal,
  options: StableBoundedRegularFileOptions,
  allowInitiallyMissing = false,
): Promise<Buffer | undefined> {
  signal.throwIfAborted()
  const before = await lstatInitialPath(path, allowInitiallyMissing)
  if (before === undefined) return undefined
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(options.byteLimit)) {
    throw options.invalid(`${options.description} is not a bounded regular file`)
  }
  const handle = await open(path, 'r')
  return await readAndClose(handle, options.description, async () => {
    const opened = await handle.stat({ bigint: true })
    /* v8 ignore next 2 -- this detects a filesystem replacement between lstat and the opened handle. */
    if (!sameFileEvidence(before, opened)) {
      throw options.invalid(`${options.description} changed while opening`)
    }
    const allocation = Buffer.alloc(options.byteLimit + 1)
    let offset = 0
    while (offset < allocation.byteLength) {
      signal.throwIfAborted()
      const result = await handle.read(
        allocation,
        offset,
        allocation.byteLength - offset,
        offset,
      )
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    /* v8 ignore next 2 -- the initial bound rejects stable oversized files; this detects growth during reading. */
    if (offset > options.byteLimit) {
      throw options.invalid(`${options.description} exceeds its byte limit`)
    }
    const after = await handle.stat({ bigint: true })
    const pathAfter = await lstat(path, { bigint: true })
    /* v8 ignore next 2 -- this detects file or path replacement during the bounded read. */
    if (!sameFileEvidence(opened, after) || !sameFileEvidence(after, pathAfter)
      || BigInt(offset) !== after.size) {
      throw options.invalid(`${options.description} changed while reading`)
    }
    signal.throwIfAborted()
    return allocation.subarray(0, offset)
  })
}
