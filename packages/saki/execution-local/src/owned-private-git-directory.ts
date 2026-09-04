/** Owned private Git directories with sealed executable-control inputs. @module */

import type { BigIntStats } from 'node:fs'
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rmdir,
  unlink,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

interface NodeIdentity {
  readonly device: string
  readonly inode: string
}

interface SealedFile {
  readonly identity: NodeIdentity
  readonly bytes: Buffer
}

interface DirectorySeal {
  readonly config: SealedFile
  readonly objects: NodeIdentity
  readonly objectInfo: NodeIdentity
  readonly alternates: SealedFile | undefined
}

/** Explicit object-alternate shape admitted when a private Git directory is sealed. */
export interface OwnedPrivateGitDirectorySealOptions {
  /** Exact config bytes constructed for this directory. */
  readonly config: Uint8Array
  readonly objectAlternates:
    | { readonly kind: 'absent' }
    | { readonly kind: 'exact'; readonly bytes: Uint8Array }
}

/** Private Git directory after its executable-control inputs have been sealed. */
export interface OwnedPrivateGitDirectory extends AsyncDisposable {
  readonly path: string
  /** @returns A promise that rejects when an executable-control input no longer matches its seal. */
  assertIntegrity(): Promise<void>
}

/** Private Git directory while its caller is constructing the isolated control tree. */
export interface OwnedPrivateGitDirectoryDraft extends AsyncDisposable {
  readonly path: string
  /**
   * Close the construction phase and capture the exact executable-control inputs.
   * @param options - Builder-owned exact config and object-alternate expectation.
   * @returns The sealed lifecycle owner.
   */
  seal(options: OwnedPrivateGitDirectorySealOptions): Promise<OwnedPrivateGitDirectory>
}

class PrivateGitDirectoryOwner implements OwnedPrivateGitDirectory, OwnedPrivateGitDirectoryDraft {
  private sealed: DirectorySeal | undefined
  private disposed = false

  constructor(
    readonly path: string,
    private readonly rootIdentity: NodeIdentity,
  ) {}

  async seal(options: OwnedPrivateGitDirectorySealOptions): Promise<OwnedPrivateGitDirectory> {
    if (this.sealed !== undefined || this.disposed) throw integrityChanged()
    const expectedConfig = Buffer.from(options.config)
    const expectedAlternate = options.objectAlternates.kind === 'exact'
      ? Buffer.from(options.objectAlternates.bytes)
      : undefined
    await assertOwnedDirectory(this.path, this.rootIdentity)
    const config = await captureExpectedFile(join(this.path, 'config'), expectedConfig)
    await assertAbsent(join(this.path, 'config.worktree'))
    await assertAbsent(join(this.path, 'commondir'))
    await assertAbsent(join(this.path, 'info', 'grafts'))
    const objectsPath = join(this.path, 'objects')
    const objectInfoPath = join(objectsPath, 'info')
    const objects = await captureDirectory(objectsPath)
    const objectInfo = await captureDirectory(objectInfoPath)
    const alternatesPath = join(objectInfoPath, 'alternates')
    let alternates: SealedFile | undefined
    if (expectedAlternate !== undefined) {
      alternates = await captureExpectedFile(alternatesPath, expectedAlternate)
    }
    else await assertAbsent(alternatesPath)
    await assertOwnedDirectory(this.path, this.rootIdentity)
    this.sealed = { config, objects, objectInfo, alternates }
    return this
  }

  async assertIntegrity(): Promise<void> {
    const sealed = this.sealed
    if (sealed === undefined || this.disposed) throw integrityChanged()
    await assertOwnedDirectory(this.path, this.rootIdentity)
    await assertFile(join(this.path, 'config'), sealed.config)
    await assertAbsent(join(this.path, 'config.worktree'))
    await assertAbsent(join(this.path, 'commondir'))
    await assertAbsent(join(this.path, 'info', 'grafts'))
    const objectsPath = join(this.path, 'objects')
    const objectInfoPath = join(objectsPath, 'info')
    await assertOwnedDirectory(objectsPath, sealed.objects)
    await assertOwnedDirectory(objectInfoPath, sealed.objectInfo)
    const alternatesPath = join(objectInfoPath, 'alternates')
    if (sealed.alternates === undefined) await assertAbsent(alternatesPath)
    else await assertFile(alternatesPath, sealed.alternates)
    await assertOwnedDirectory(this.path, this.rootIdentity)
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.disposed) return
    await removeOwnedDirectory(this.path, this.rootIdentity)
    this.disposed = true
  }
}

/**
 * Create one private Git directory, retain its creation identity, and own its lifecycle.
 * @param use - Fixed use that selects the private temporary-path prefix.
 * @returns An owned draft that must be sealed before it reaches Git.
 */
export async function createOwnedPrivateGitDirectory(
  use: 'repository-view' | 'transport',
): Promise<OwnedPrivateGitDirectoryDraft> {
  const path = await mkdtemp(join(tmpdir(), use === 'repository-view' ? 'saki-git-view-' : 'saki-git-transport-'))
  const info = await lstat(path, { bigint: true })
  if (!isRealDirectory(info)) throw integrityChanged()
  const owner = new PrivateGitDirectoryOwner(path, nodeIdentity(info))
  try {
    await chmod(path, 0o700)
    return owner
  } catch (error) {
    await owner[Symbol.asyncDispose]()
    throw error
  }
}

async function captureDirectory(path: string): Promise<NodeIdentity> {
  const info = await lstat(path, { bigint: true })
  if (!isRealDirectory(info)) throw integrityChanged()
  return nodeIdentity(info)
}

async function captureFile(path: string): Promise<SealedFile> {
  const initial = await lstat(path, { bigint: true })
  if (!initial.isFile() || initial.isSymbolicLink()) throw integrityChanged()
  const bytes = await readFile(path)
  const confirmed = await lstat(path, { bigint: true })
  if (!sameNode(initial, confirmed)
    || !confirmed.isFile()
    || confirmed.isSymbolicLink()
    || initial.size !== confirmed.size
    || initial.mtimeNs !== confirmed.mtimeNs
    || initial.ctimeNs !== confirmed.ctimeNs
    || BigInt(bytes.byteLength) !== confirmed.size) {
    throw integrityChanged()
  }
  return { identity: nodeIdentity(confirmed), bytes: Buffer.from(bytes) }
}

async function captureExpectedFile(path: string, expected: Uint8Array): Promise<SealedFile> {
  const captured = await captureFile(path)
  if (!captured.bytes.equals(expected)) throw integrityChanged()
  return captured
}

async function assertFile(path: string, expected: SealedFile): Promise<void> {
  let initial: BigIntStats
  try {
    initial = await lstat(path, { bigint: true })
  } catch {
    throw integrityChanged()
  }
  if (!initial.isFile() || initial.isSymbolicLink() || !nodeIdentityMatches(initial, expected.identity)) {
    throw integrityChanged()
  }
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch {
    throw integrityChanged()
  }
  let confirmed: BigIntStats
  try {
    confirmed = await lstat(path, { bigint: true })
  } catch {
    throw integrityChanged()
  }
  if (!sameNode(initial, confirmed)
    || !confirmed.isFile()
    || confirmed.isSymbolicLink()
    || !nodeIdentityMatches(confirmed, expected.identity)
    || initial.size !== confirmed.size
    || initial.mtimeNs !== confirmed.mtimeNs
    || initial.ctimeNs !== confirmed.ctimeNs
    || BigInt(bytes.byteLength) !== confirmed.size
    || !bytes.equals(expected.bytes)) {
    throw integrityChanged()
  }
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await lstat(path, { bigint: true })
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return
    throw integrityChanged()
  }
  throw integrityChanged()
}

async function assertOwnedDirectory(path: string, identity: NodeIdentity): Promise<void> {
  let info: BigIntStats
  try {
    info = await lstat(path, { bigint: true })
  } catch {
    throw integrityChanged()
  }
  if (!isRealDirectory(info) || !nodeIdentityMatches(info, identity)) throw integrityChanged()
}

type OwnedDirectoryState = 'owned' | 'missing' | 'foreign'

async function removeOwnedDirectory(path: string, identity: NodeIdentity): Promise<void> {
  const initial = await ownedDirectoryState(path, identity)
  if (initial === 'missing') return
  if (initial === 'foreign') throw new Error('Private Git directory ownership changed')
  let entries: readonly string[]
  try {
    entries = await readdir(path)
  } catch (error) {
    if (await ownedDirectoryState(path, identity) === 'missing') return
    throw error
  }
  if (await ownedDirectoryState(path, identity) !== 'owned') {
    throw new Error('Private Git directory ownership changed')
  }
  for (const entry of entries) {
    if (await ownedDirectoryState(path, identity) !== 'owned') {
      throw new Error('Private Git directory ownership changed')
    }
    await removeOwnedEntry(join(path, entry))
  }
  const beforeRemoval = await ownedDirectoryState(path, identity)
  if (beforeRemoval === 'missing') return
  if (beforeRemoval === 'foreign') throw new Error('Private Git directory ownership changed')
  try {
    await rmdir(path)
  } catch (error) {
    if (await ownedDirectoryState(path, identity) !== 'missing') throw error
  }
}

async function removeOwnedEntry(path: string): Promise<void> {
  let initial: BigIntStats
  try {
    initial = await lstat(path, { bigint: true })
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return
    throw error
  }
  const identity = nodeIdentity(initial)
  if (isRealDirectory(initial)) {
    await removeOwnedDirectory(path, identity)
    return
  }
  let confirmed: BigIntStats
  try {
    confirmed = await lstat(path, { bigint: true })
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return
    throw error
  }
  if (!sameNode(initial, confirmed)) throw new Error('Private Git directory entry ownership changed')
  try {
    await unlink(path)
  } catch (error) {
    if (!await nodePathMissing(path)) throw error
  }
}

async function ownedDirectoryState(path: string, identity: NodeIdentity): Promise<OwnedDirectoryState> {
  try {
    const info = await lstat(path, { bigint: true })
    return isRealDirectory(info) && nodeIdentityMatches(info, identity) ? 'owned' : 'foreign'
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return 'missing'
    throw error
  }
}

async function nodePathMissing(path: string): Promise<boolean> {
  try {
    await lstat(path, { bigint: true })
    return false
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return true
    throw error
  }
}

function isRealDirectory(info: BigIntStats): boolean {
  return info.isDirectory() && !info.isSymbolicLink()
}

function nodeIdentity(info: BigIntStats): NodeIdentity {
  return { device: info.dev.toString(), inode: info.ino.toString() }
}

function nodeIdentityMatches(info: BigIntStats, identity: NodeIdentity): boolean {
  return info.dev.toString() === identity.device && info.ino.toString() === identity.inode
}

function sameNode(left: BigIntStats, right: BigIntStats): boolean {
  return left.isDirectory() === right.isDirectory()
    && left.isFile() === right.isFile()
    && left.isSymbolicLink() === right.isSymbolicLink()
    && nodeIdentityMatches(left, nodeIdentity(right))
}

function integrityChanged(): Error {
  return new Error('Private Git directory integrity changed')
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
