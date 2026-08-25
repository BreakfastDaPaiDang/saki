/** Safe filesystem access for JSON unit entries. @module @deepseek-ai/dsh-storage-json/src/medium */

import { lstat, mkdir, open, readFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import type { BigIntStats, Stats } from 'node:fs'
import { join } from 'node:path'
import { StorageError } from '@deepseek-ai/dsh-storage'

interface RootIdentity {
  readonly dev: bigint
  readonly ino: bigint
}

/** Filesystem observations whose results determine medium failure classification. */
export interface JsonMediumEffects {
  /** Inspect a path without following symbolic links, using number-valued metadata. */
  readonly lstatPath: (path: string) => Promise<Stats>
  /** Inspect a path without following symbolic links, using identity-safe bigint metadata. */
  readonly lstatPathBigInt: (path: string) => Promise<BigIntStats>
  /** Open an existing path for read-only access. */
  readonly openRead: (path: string) => Promise<FileHandle>
}

const defaultEffects: JsonMediumEffects = {
  lstatPath: path => lstat(path),
  lstatPathBigInt: path => lstat(path, { bigint: true }),
  openRead: path => open(path, 'r'),
}

const strictUtf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/**
 * Pins one backend root to the first real directory it creates or observes.
 * Later operations reject if the configured path names a different directory.
 */
export class StorageRootGuard {
  private identity?: RootIdentity

  /**
   * @param root - Absolute configured backend root.
   * @param effects - Filesystem observations, overridden only by package tests.
   */
  constructor(
    private readonly root: string,
    private readonly effects: JsonMediumEffects = defaultEffects,
  ) {}

  /**
   * Create an unobserved root when absent, then pin or verify its identity.
   * @param name - Unit name used to classify identity failures.
   */
  async ensureCurrent(name: string): Promise<void> {
    if (this.identity === undefined) await ensureStorageRoot(this.root, this.effects)
    await this.observeCurrent(name)
  }

  /**
   * Pin an existing root or verify that it is still the pinned directory.
   * An initially absent root remains unpinned until a later creation.
   * @param name - Unit name used to classify identity failures.
   */
  async observeCurrent(name: string): Promise<void> {
    let stat: BigIntStats
    try {
      stat = await this.effects.lstatPathBigInt(this.root)
    } catch (error) {
      if (isMissing(error)) {
        if (this.identity !== undefined) {
          throw malformed(name, 'storage root changed after the backend observed it')
        }
        return
      }
      throw error
    }
    validateRoot(this.root, stat)
    const observed = { dev: stat.dev, ino: stat.ino }
    if (this.identity === undefined) {
      this.identity = observed
      return
    }
    if (this.identity.dev !== observed.dev || this.identity.ino !== observed.ino) {
      throw malformed(name, 'storage root changed after the backend observed it')
    }
  }
}

/**
 * Ensure the configured root exists as a real directory.
 * @param root - Configured backend root.
 * @param effects - Filesystem observations, overridden only by package tests.
 * @returns nothing after the real directory exists.
 */
export async function ensureStorageRoot(
  root: string,
  effects: JsonMediumEffects = defaultEffects,
): Promise<void> {
  try {
    validateRoot(root, await effects.lstatPath(root))
    return
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  await mkdir(root, { recursive: true, mode: 0o700 })
  validateRoot(root, await effects.lstatPath(root))
}

/**
 * Read one existing regular unit entry without accepting a symbolic-link path.
 * @param root - Configured backend root.
 * @param name - Valid unit name.
 * @param signal - Optional caller cancellation.
 * @param afterRootProbe - Optional package-test barrier after the root identity probe.
 * @param effects - Filesystem observations, overridden only by package tests.
 * @returns fatal UTF-8-decoded file text, or `undefined` only when the root or entry was initially absent.
 * @throws StorageError with `malformed-medium` when bytes are invalid UTF-8 or an entry is not regular or changes identity.
 */
export async function readUnitFile(
  root: string,
  name: string,
  signal?: AbortSignal,
  afterRootProbe?: () => Promise<void>,
  effects: JsonMediumEffects = defaultEffects,
): Promise<string | undefined> {
  let rootStat: BigIntStats
  try {
    rootStat = await effects.lstatPathBigInt(root)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
  validateRoot(root, rootStat)
  await afterRootProbe?.()

  const path = join(root, `${name}.json`)
  let before: BigIntStats
  try {
    before = await effects.lstatPathBigInt(path)
  } catch (error) {
    if (isMissing(error)) {
      await assertRootUnchanged(root, name, rootStat, effects)
      return undefined
    }
    throw error
  }
  validateUnitEntry(name, before)

  let handle: FileHandle
  try {
    handle = await effects.openRead(path)
  } catch (error) {
    if (isMissing(error)) throw malformed(name, 'unit entry changed while opening')
    throw error
  }
  try {
    const opened = await handle.stat({ bigint: true })
    if (!sameFile(before, opened) || !opened.isFile()) {
      throw malformed(name, 'unit entry changed while opening')
    }
    const bytes = signal === undefined
      ? await readFile(handle)
      : await readFile(handle, { signal })
    const read = await handle.stat({ bigint: true })
    let after: BigIntStats
    try {
      after = await effects.lstatPathBigInt(path)
    } catch (error) {
      if (isMissing(error)) throw malformed(name, 'unit entry changed while reading')
      throw error
    }
    if (!sameFile(opened, read) || !sameFile(read, after) || after.isSymbolicLink() || !after.isFile()) {
      throw malformed(name, 'unit entry changed while reading')
    }
    await assertRootUnchanged(root, name, rootStat, effects)
    try {
      return strictUtf8Decoder.decode(bytes)
    } catch (error) {
      throw malformed(name, 'unit entry is not valid UTF-8', error)
    }
  } finally {
    await handle.close()
  }
}

function validateRoot(root: string, stat: { isSymbolicLink(): boolean; isDirectory(): boolean }): void {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new StorageError('malformed-medium', `json storage root '${root}' must be a real directory`)
  }
}

function validateUnitEntry(
  name: string,
  stat: { isSymbolicLink(): boolean; isFile(): boolean },
): void {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw malformed(name, 'unit entry must be a regular file, not a symbolic link')
  }
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

async function assertRootUnchanged(
  root: string,
  name: string,
  before: BigIntStats,
  effects: JsonMediumEffects,
): Promise<void> {
  let after: BigIntStats
  try {
    after = await effects.lstatPathBigInt(root)
  } catch (error) {
    if (isMissing(error)) throw malformed(name, 'storage root changed while reading')
    throw error
  }
  if (!sameIdentity(before, after) || after.isSymbolicLink() || !after.isDirectory()) {
    throw malformed(name, 'storage root changed while reading')
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function malformed(name: string, detail: string, cause?: unknown): StorageError {
  return new StorageError(
    'malformed-medium',
    `unit '${name}': ${detail}`,
    cause === undefined ? undefined : { cause },
  )
}
