/**
 * Private Git control-plane snapshots for untrusted Local Host repositories.
 * @module @breakfastdapaidang/saki-execution-local/safe-repository
 */

import { createHash } from 'node:crypto'
import { lstat as nativeLstat, mkdir, utimes, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, relative, resolve as resolvePath, sep, win32 } from 'node:path'
import type { FileSystem, FsVersion } from '@deepseek-ai/dsh-fs'
import {
  canonicalDigest,
  isGitObjectId,
  isSafeGitBranchName,
  isSafeGitRef,
  MAX_GIT_REF_CHARS,
  MAX_TRUSTED_PATH_CHARS,
} from '@breakfastdapaidang/saki-execution'
import { isSafeProjectDiffQuery } from './diff-query.ts'
import { GitCommandError } from './git-runner.ts'
import {
  isGitConfigIncludeName,
  type RepositoryInventoryGit,
} from './inventory.ts'
import { isSafeProjectStatusQuery } from './status-query.ts'
import {
  createOwnedPrivateGitDirectory,
  type OwnedPrivateGitDirectory,
  type OwnedPrivateGitDirectoryDraft,
} from './owned-private-git-directory.ts'

const UTF8 = new TextDecoder('utf-8', { fatal: true })
const NANOSECONDS_PER_SECOND = 1_000_000_000n
const BOOLEAN_CONFIG_KEYS = new Set(['core.autocrlf', 'core.fileMode', 'core.symlinks'])
const SCOPED_BOOLEAN_CONFIG_KEYS = new Set(['core.fsmonitor', 'extensions.worktreeConfig'])

/** Canonical source paths and the isolated Git runner for one observation round. */
export interface SafeRepositoryView extends AsyncDisposable {
  readonly topLevelPath: string
  readonly gitDirectoryPath: string
  readonly commonDirectoryPath: string
  /** Provider-private isolated Git directory admitted for this observation round. */
  readonly privateGitDirectory: OwnedPrivateGitDirectory
  readonly locked: boolean
  /** Whether admitted repository-local configuration enables sparse index semantics. */
  readonly sparseIndexEnabled: boolean
  readonly git: RepositoryInventoryGit
  /** Reject if this round's source control files or administrative identities changed. */
  assertSourceControlUnchanged(signal: AbortSignal): Promise<void>
  /** Opaque exact-source identity used only to compare independent admissions. */
  readonly sourceControlIdentity: string
}

/** Closed result of filesystem-only repository admission. */
export type SafeRepositoryOpenResult =
  | { readonly kind: 'repository'; readonly view: SafeRepositoryView }
  | { readonly kind: 'not-git' | 'bare' | 'prunable' | 'ambiguous' | 'malformed' | 'unavailable' }

/** Optional containment required before a nested repository's config may be read. */
export interface SafeRepositoryScope {
  readonly expectedTopLevelPath: string
  readonly allowedAdministrativeRoots: readonly string[]
}

class SafeRepositoryError extends Error {
  constructor(readonly kind: Exclude<SafeRepositoryOpenResult['kind'], 'repository'>) {
    super(`Saki safe repository admission failed: ${kind}`)
  }
}

/** The admitted source control files changed before their evidence was committed. */
export class RepositoryControlChangedError extends Error {
  constructor() {
    super('Saki repository control files changed during inspection')
  }
}

interface StableFile {
  readonly bytes: Uint8Array
  readonly version: FsVersion
}

interface StableIndexFile extends StableFile {
  readonly mtimeNs: bigint
}

interface StableDirectory {
  readonly path: string
  readonly version: FsVersion
}

interface RepositoryTopology {
  readonly layout: 'ordinary' | 'linked' | 'separate'
  readonly topLevel: StableDirectory
  readonly gitDirectory: StableDirectory
  readonly commonDirectory: StableDirectory
  readonly locked: boolean
  readonly markerFile?: StableFile
  readonly commonFile?: StableFile
  readonly backlink?: StableFile
  readonly lockedEntry?: { readonly type: string; readonly version: FsVersion; readonly size?: number }
}

/**
 * Admit a selected directory and bind repository-aware Git to a private copy
 * of its control files.
 * @param fs - Local Host filesystem sharing the Git execution world.
 * @param rawGit - bounded Git runner that has not discovered a repository.
 * @param selectedPath - canonical selected directory.
 * @param maxControlFileBytes - maximum bytes copied from any control file.
 * @param signal - observation lifetime.
 * @param scope - optional nested repository containment checked before config capture.
 * @returns an isolated repository view or a bounded rejection.
 */
export async function openSafeRepositoryView(
  fs: FileSystem,
  rawGit: RepositoryInventoryGit,
  selectedPath: string,
  maxControlFileBytes: number,
  signal: AbortSignal,
  scope?: SafeRepositoryScope,
): Promise<SafeRepositoryOpenResult> {
  let directoryDraft: OwnedPrivateGitDirectoryDraft | undefined
  try {
    signal.throwIfAborted()
    if (!isSafeLocalRepositoryPath(selectedPath) || selectedPath.length > MAX_TRUSTED_PATH_CHARS) {
      return { kind: 'unavailable' }
    }
    const discovered = await discoverRepository(fs, selectedPath, maxControlFileBytes, signal)
    if (discovered.kind !== 'repository') return discovered
    if (scope !== undefined && !topologyAllowedByScope(discovered.topology, scope)) {
      return { kind: 'unavailable' }
    }
    const { topLevel, gitDirectory, commonDirectory, locked } = discovered.topology
    const config = await readStableFile(fs, join(commonDirectory.path, 'config'), maxControlFileBytes, signal, true)

    directoryDraft = await createOwnedPrivateGitDirectory('repository-view')
    const scratch = directoryDraft.path
    const configSnapshot = join(scratch, 'source.config')
    await writePrivateFile(configSnapshot, config.bytes)
    if (await configSnapshotIsUnsafe(rawGit, scratch, configSnapshot, signal)) {
      throw new SafeRepositoryError('unavailable')
    }
    const commonBare = (await explicitConfigBooleans(
      rawGit,
      scratch,
      configSnapshot,
      'core.bare',
      signal,
    ))?.at(-1)
    const commonWorktree = (await explicitConfigValues(
      rawGit,
      scratch,
      configSnapshot,
      'core.worktree',
      signal,
    ))?.at(-1)
    if (commonWorktree === '') throw new SafeRepositoryError('malformed')
    const refStorage = (await explicitConfigValues(
      rawGit,
      scratch,
      configSnapshot,
      'extensions.refStorage',
      signal,
    ))?.at(-1)
    if (refStorage !== undefined && refStorage !== 'files') throw new SafeRepositoryError('unavailable')
    const configuredObjectFormat = (await explicitConfigValues(
      rawGit,
      scratch,
      configSnapshot,
      'extensions.objectFormat',
      signal,
    ))?.at(-1) ?? 'sha1'
    if (configuredObjectFormat !== 'sha1' && configuredObjectFormat !== 'sha256') {
      throw new SafeRepositoryError('malformed')
    }
    const worktreeConfigValues = await explicitConfigBooleans(
      rawGit,
      scratch,
      configSnapshot,
      'extensions.worktreeConfig',
      signal,
    )
    const worktreeConfigEnabled = worktreeConfigValues?.at(-1)
    let worktreeConfig: StableFile | undefined
    let worktreeConfigSnapshot: string | undefined
    let activeBare: boolean | undefined
    let activeWorktree: string | undefined
    if (worktreeConfigEnabled === true) {
      worktreeConfig = await readStableFile(
        fs,
        join(gitDirectory.path, 'config.worktree'),
        maxControlFileBytes,
        signal,
        false,
      )
      if (worktreeConfig !== undefined) {
        const snapshot = join(scratch, 'source.config.worktree')
        worktreeConfigSnapshot = snapshot
        await writePrivateFile(snapshot, worktreeConfig.bytes)
        if (await configSnapshotIsUnsafe(rawGit, scratch, snapshot, signal)) {
          throw new SafeRepositoryError('unavailable')
        }
        await rejectWorktreeRepositoryIdentityOverrides(rawGit, scratch, snapshot, signal)
        activeBare = (await explicitConfigBooleans(
          rawGit,
          scratch,
          snapshot,
          'core.bare',
          signal,
        ))?.at(-1)
        activeWorktree = (await explicitConfigValues(
          rawGit,
          scratch,
          snapshot,
          'core.worktree',
          signal,
        ))?.at(-1)
        if (activeWorktree === '') throw new SafeRepositoryError('malformed')
      }
    }
    const sparseCheckout = await effectiveSnapshotBoolean(
      rawGit,
      scratch,
      configSnapshot,
      worktreeConfigSnapshot,
      'core.sparseCheckout',
      signal,
    )
    const sparseIndex = await effectiveSnapshotBoolean(
      rawGit,
      scratch,
      configSnapshot,
      worktreeConfigSnapshot,
      'index.sparse',
      signal,
    )
    const sparseIndexEnabled = sparseCheckout === true || sparseIndex === true
    const privateConfig = await writeMinimalRepositoryConfig(
      rawGit,
      scratch,
      configSnapshot,
      worktreeConfigSnapshot,
      signal,
    )
    const remoteUrlOutput = await readRemoteUrlConfig(
      rawGit,
      scratch,
      [configSnapshot, ...(worktreeConfigSnapshot === undefined ? [] : [worktreeConfigSnapshot])],
      signal,
    )
    const ignoresCommonMainWorktreeValues = discovered.topology.layout === 'linked'
      && worktreeConfigEnabled !== true
    const effectiveBare = ignoresCommonMainWorktreeValues ? undefined : activeBare ?? commonBare
    const effectiveWorktree = ignoresCommonMainWorktreeValues ? undefined : activeWorktree ?? commonWorktree
    if (effectiveBare === true) throw new SafeRepositoryError('bare')
    if (effectiveWorktree !== undefined) {
      await assertConfiguredWorktree(fs, gitDirectory.path, effectiveWorktree, topLevel.path, signal)
    }

    const head = await readStableFile(fs, join(gitDirectory.path, 'HEAD'), maxControlFileBytes, signal, true)
    const branch = parseHeadBranch(head.bytes)
    await writePrivateFile(join(scratch, 'HEAD'), head.bytes)

    const index = await readStableIndexFile(
      fs,
      join(gitDirectory.path, 'index'),
      maxControlFileBytes,
      signal,
    )
    if (index !== undefined) await writePrivateIndex(join(scratch, 'index'), index)
    const packedRefs = await readStableFile(
      fs,
      join(commonDirectory.path, 'packed-refs'),
      maxControlFileBytes,
      signal,
      false,
    )
    if (packedRefs !== undefined) await writePrivateFile(join(scratch, 'packed-refs'), packedRefs.bytes)
    let looseRef: StableFile | undefined
    if (branch !== undefined) {
      const branchComponents = branch.split('/')
      const sourceRef = join(commonDirectory.path, ...branchComponents)
      const privateRef = join(scratch, ...branchComponents)
      if (!isSafeLocalRepositoryPath(sourceRef)
        || sourceRef.length > MAX_TRUSTED_PATH_CHARS
        || !isSafeLocalRepositoryPath(privateRef)
        || privateRef.length > MAX_TRUSTED_PATH_CHARS) {
        throw new SafeRepositoryError('unavailable')
      }
      looseRef = await readStableFile(fs, sourceRef, maxControlFileBytes, signal, false)
      if (looseRef !== undefined) {
        await mkdir(dirname(privateRef), { recursive: true, mode: 0o700 })
        await writePrivateFile(privateRef, looseRef.bytes)
      }
    }

    const objectsPath = join(commonDirectory.path, 'objects')
    const objectsEntry = await fs.lstat(objectsPath, undefined, signal)
    if (objectsEntry?.type === 'symlink' || objectsEntry?.type === 'other') {
      throw new SafeRepositoryError('unavailable')
    }
    const objects = await resolveStableDirectory(fs, objectsPath, signal)
    if (objects === undefined) throw new SafeRepositoryError('malformed')
    for (const name of ['alternates', 'http-alternates']) {
      if (await fs.lstat(join(objects.path, 'info', name), undefined, signal) !== undefined) {
        throw new SafeRepositoryError('unavailable')
      }
    }
    const privateObjectInfo = join(scratch, 'objects', 'info')
    await mkdir(privateObjectInfo, { recursive: true, mode: 0o700 })
    await mkdir(join(scratch, 'refs'), { recursive: true, mode: 0o700 })
    const privateAlternate = Buffer.from(`${gitAlternatePath(objects.path)}\n`, 'utf8')
    await writePrivateFile(join(privateObjectInfo, 'alternates'), privateAlternate)
    if (index !== undefined && await hasSplitIndex(rawGit, scratch, topLevel.path, signal)) {
      throw new SafeRepositoryError('unavailable')
    }
    const exclude = await copyOptionalControlFile(
      fs,
      join(commonDirectory.path, 'info', 'exclude'),
      join(scratch, 'info', 'exclude'),
      maxControlFileBytes,
      signal,
    )
    const attributes = await copyOptionalControlFile(
      fs,
      join(commonDirectory.path, 'info', 'attributes'),
      join(scratch, 'info', 'attributes'),
      maxControlFileBytes,
      signal,
    )
    const upstream = await pinConfiguredUpstream(
      fs,
      rawGit,
      scratch,
      topLevel.path,
      commonDirectory.path,
      branch,
      configuredObjectFormat,
      maxControlFileBytes,
      signal,
    )

    const sourceControlIdentity = canonicalDigest('saki/safe-repository-source-control/v1', {
      topology: {
        layout: discovered.topology.layout,
        topLevel,
        gitDirectory,
        commonDirectory,
        locked,
        markerFile: sourceFileStamp(discovered.topology.markerFile),
        commonFile: sourceFileStamp(discovered.topology.commonFile),
        backlink: sourceFileStamp(discovered.topology.backlink),
        lockedEntry: discovered.topology.lockedEntry,
      },
      config: sourceFileStamp(config),
      worktreeConfigEnabled: worktreeConfigEnabled === true,
      worktreeConfig: sourceFileStamp(worktreeConfig),
      head: sourceFileStamp(head),
      index: sourceFileStamp(index),
      packedRefs: sourceFileStamp(packedRefs),
      looseRef: sourceFileStamp(looseRef),
      upstreamRef: upstream?.ref,
      upstreamLooseRef: sourceFileStamp(upstream?.looseRef),
      objects,
      sourceObjectAlternatesAbsent: true,
      exclude: sourceFileStamp(exclude),
      attributes: sourceFileStamp(attributes),
      sparseIndexEnabled,
    })

    const privateGitDirectory = await directoryDraft.seal({
      config: privateConfig,
      objectAlternates: { kind: 'exact', bytes: privateAlternate },
    })
    const privateGitDirectoryPath = privateGitDirectory.path
    let observedHead: string | undefined
    const git: RepositoryInventoryGit = {
      async run(_cwd, args, commandSignal, stdin, outputBudget) {
        if (argsEqual(args, ['rev-parse', '--is-bare-repository'])) return textOutput('false')
        if (argsEqual(args, ['rev-parse', '--path-format=absolute', '--show-toplevel'])) return textOutput(topLevel.path)
        if (argsEqual(args, ['rev-parse', '--path-format=absolute', '--absolute-git-dir'])) return textOutput(gitDirectory.path)
        if (argsEqual(args, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) return textOutput(commonDirectory.path)
        if (argsEqual(args, [
          'config', '--no-includes', '--null', '--get-regexp', '^remote\\..*\\.url$',
        ])) {
          return { stdout: Buffer.from(remoteUrlOutput), stderr: Buffer.alloc(0) }
        }
        if (argsEqual(args, [
          '--bare', `--git-dir=${commonDirectory.path}`, 'worktree', 'list', '--porcelain', '-z',
        ])) {
          if (observedHead === undefined) throw new SafeRepositoryError('malformed')
          return {
            stdout: Buffer.from([
              `worktree ${topLevel.path}\0`,
              `HEAD ${observedHead}\0`,
              ...(branch === undefined ? ['detached\0'] : [`branch ${branch}\0`]),
              ...(locked ? ['locked\0'] : []),
              '\0',
            ].join('')),
            stderr: Buffer.alloc(0),
          }
        }
        if (!repositoryQueryIsAllowed(args, stdin !== undefined, configuredObjectFormat)) {
          throw new SafeRepositoryError('unavailable')
        }
        const privateArgs = [`--git-dir=${privateGitDirectoryPath}`, `--work-tree=${topLevel.path}`, ...args]
        await privateGitDirectory.assertIntegrity()
        let output: Awaited<ReturnType<RepositoryInventoryGit['run']>>
        try {
          output = await rawGit.run(
            privateGitDirectoryPath,
            privateArgs,
            commandSignal,
            stdin,
            outputBudget,
          )
        } catch (error) {
          if (argsEqual(args, ['rev-parse', '--verify', 'HEAD'])
            && error instanceof GitCommandError
            && error.code === 'nonzero'
            && error.exitCode === 128
            && branch !== undefined) {
            observedHead = '0'.repeat(configuredObjectFormat === 'sha1' ? 40 : 64)
          }
          throw error
        }
        if (args[0] === 'rev-parse' && args.at(-1) === 'HEAD') {
          observedHead = oneLine(output.stdout)
        }
        return output
      },
    }
    directoryDraft = undefined
    return {
      kind: 'repository',
      view: {
        topLevelPath: topLevel.path,
        gitDirectoryPath: gitDirectory.path,
        commonDirectoryPath: commonDirectory.path,
        privateGitDirectory,
        locked,
        sparseIndexEnabled,
        git,
        sourceControlIdentity,
        async assertSourceControlUnchanged(assertSignal) {
          const currentConfig = await readStableFile(
            fs,
            join(commonDirectory.path, 'config'),
            maxControlFileBytes,
            assertSignal,
            false,
          )
          const currentWorktreeConfig = worktreeConfigEnabled === true
            ? await readStableFile(
              fs,
              join(gitDirectory.path, 'config.worktree'),
              maxControlFileBytes,
              assertSignal,
              false,
            )
            : undefined
          if (!sameStableFile(currentConfig, config)
            || !sameStableFile(currentWorktreeConfig, worktreeConfig)) {
            throw new RepositoryControlChangedError()
          }
          const confirmation = await openSafeRepositoryView(
            fs,
            rawGit,
            selectedPath,
            maxControlFileBytes,
            assertSignal,
            scope,
          )
          if (confirmation.kind !== 'repository') {
            if (confirmation.kind === 'unavailable') throw new SafeRepositoryError('unavailable')
            throw new RepositoryControlChangedError()
          }
          await using confirmed = confirmation.view
          if (confirmed.sourceControlIdentity !== sourceControlIdentity) {
            throw new RepositoryControlChangedError()
          }
        },
        async [Symbol.asyncDispose]() {
          await privateGitDirectory[Symbol.asyncDispose]()
        },
      },
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason
    if (error instanceof SafeRepositoryError) return { kind: error.kind }
    return { kind: 'unavailable' }
  } finally {
    if (directoryDraft !== undefined) await directoryDraft[Symbol.asyncDispose]()
  }
}

async function discoverRepository(
  fs: FileSystem,
  selectedPath: string,
  maxControlFileBytes: number,
  signal: AbortSignal,
): Promise<
  | { readonly kind: 'repository'; readonly topology: RepositoryTopology }
  | { readonly kind: 'not-git' | 'bare' | 'prunable' | 'ambiguous' | 'malformed' | 'unavailable' }
> {
  let candidate = selectedPath
  while (true) {
    const markerPath = join(candidate, '.git')
    const marker = await fs.lstat(markerPath, undefined, signal)
    if (marker !== undefined) {
      const topLevel = await resolveStableDirectory(fs, candidate, signal)
      if (topLevel === undefined) return { kind: 'malformed' }
      if (marker.type === 'symlink' || marker.type === 'other') return { kind: 'unavailable' }
      if (marker.type === 'directory') {
        const gitDirectory = await resolveStableDirectory(fs, markerPath, signal)
        if (gitDirectory === undefined) return { kind: 'malformed' }
        if (await fs.lstat(join(gitDirectory.path, 'commondir'), undefined, signal) !== undefined) {
          return { kind: 'unavailable' }
        }
        return {
          kind: 'repository',
          topology: {
            layout: 'ordinary', topLevel, gitDirectory, commonDirectory: gitDirectory, locked: false,
          },
        }
      }
      const markerFile = await readStableFile(fs, markerPath, maxControlFileBytes, signal, true)
      const gitDirectoryPath = resolveControlPath(
        dirname(markerPath),
        parseGitFile(markerFile.bytes),
      )
      const gitDirectoryEntry = await fs.lstat(gitDirectoryPath, undefined, signal)
      if (gitDirectoryEntry?.type === 'symlink' || gitDirectoryEntry?.type === 'other') {
        return { kind: 'unavailable' }
      }
      const gitDirectory = await resolveStableDirectory(fs, gitDirectoryPath, signal)
      if (gitDirectory === undefined) return { kind: 'malformed' }
      const commonFile = await readStableFile(
        fs,
        join(gitDirectory.path, 'commondir'),
        maxControlFileBytes,
        signal,
        false,
      )
      if (commonFile === undefined) {
        return {
          kind: 'repository',
          topology: {
            layout: 'separate',
            topLevel,
            gitDirectory,
            commonDirectory: gitDirectory,
            locked: false,
            markerFile,
          },
        }
      }
      const commonDirectoryPath = resolveControlPath(
        gitDirectory.path,
        parseControlPath(commonFile.bytes),
      )
      const commonDirectoryEntry = await fs.lstat(commonDirectoryPath, undefined, signal)
      if (commonDirectoryEntry?.type === 'symlink' || commonDirectoryEntry?.type === 'other') {
        return { kind: 'unavailable' }
      }
      const commonDirectory = await resolveStableDirectory(fs, commonDirectoryPath, signal)
      if (commonDirectory === undefined
        || !pathIsDirectChild(join(commonDirectory.path, 'worktrees'), gitDirectory.path)) {
        return { kind: 'malformed' }
      }
      const backlink = await readStableFile(
        fs,
        join(gitDirectory.path, 'gitdir'),
        maxControlFileBytes,
        signal,
        false,
      )
      if (backlink === undefined) return { kind: 'prunable' }
      const backlinkPath = resolveControlPath(gitDirectory.path, parseControlPath(backlink.bytes))
      if (normalize(backlinkPath) !== normalize(markerPath)) {
        return await fs.lstat(backlinkPath, undefined, signal) === undefined
          ? { kind: 'prunable' }
          : { kind: 'ambiguous' }
      }
      const lockedInfo = await fs.lstat(join(gitDirectory.path, 'locked'), undefined, signal)
      const lockedEntry = lockedInfo === undefined
        ? undefined
        : { type: lockedInfo.type, version: lockedInfo.version, ...(lockedInfo.size === undefined ? {} : { size: lockedInfo.size }) }
      const locked = lockedEntry !== undefined
      return {
        kind: 'repository',
        topology: {
          layout: 'linked',
          topLevel,
          gitDirectory,
          commonDirectory,
          locked,
          markerFile,
          commonFile,
          backlink,
          ...(lockedEntry === undefined ? {} : { lockedEntry }),
        },
      }
    }
    const parent = dirname(candidate)
    if (parent === candidate) break
    candidate = parent
  }
  const [head, config, objects] = await Promise.all([
    fs.lstat(join(selectedPath, 'HEAD'), undefined, signal),
    fs.lstat(join(selectedPath, 'config'), undefined, signal),
    fs.lstat(join(selectedPath, 'objects'), undefined, signal),
  ])
  return head?.type === 'file' && config?.type === 'file' && objects?.type === 'directory'
    ? { kind: 'bare' }
    : { kind: 'not-git' }
}

function parseGitFile(bytes: Uint8Array): string {
  const line = decodeControlLine(bytes)
  if (!line.startsWith('gitdir: ') || line.length === 'gitdir: '.length) {
    throw new SafeRepositoryError('malformed')
  }
  return line.slice('gitdir: '.length)
}

function parseControlPath(bytes: Uint8Array): string {
  const line = decodeControlLine(bytes)
  if (line === '') throw new SafeRepositoryError('malformed')
  return line
}

function decodeControlLine(bytes: Uint8Array): string {
  const text = decode(bytes)
  const value = text.endsWith('\r\n') ? text.slice(0, -2) : text.endsWith('\n') ? text.slice(0, -1) : undefined
  if (value === undefined || value.includes('\r') || value.includes('\n') || value.includes('\0')) {
    throw new SafeRepositoryError('malformed')
  }
  return value
}

function resolveControlPath(base: string, value: string): string {
  if (!isSafeLocalRepositoryPath(value)) throw new SafeRepositoryError('unavailable')
  const resolved = isAbsolute(value) ? normalize(value) : resolvePath(base, value)
  if (!isSafeLocalRepositoryPath(resolved) || resolved.length > MAX_TRUSTED_PATH_CHARS) {
    throw new SafeRepositoryError('unavailable')
  }
  return resolved
}

async function resolveStableDirectory(
  fs: FileSystem,
  path: string,
  signal: AbortSignal,
): Promise<StableDirectory | undefined> {
  if (!isAbsolute(path) || !isSafeLocalRepositoryPath(path)) return undefined
  const entry = await fs.lstat(path, undefined, signal)
  if (entry?.type !== 'directory') return undefined
  const first = await fs.resolve(path, { signal })
  const firstPath = fs.processPath(first)
  if (!isAbsolute(firstPath)
    || !isSafeLocalRepositoryPath(firstPath)
    || firstPath.length > MAX_TRUSTED_PATH_CHARS) {
    throw new SafeRepositoryError('unavailable')
  }
  if ((await fs.stat(first, signal))?.type !== 'directory') return undefined
  const confirmed = await fs.lstat(path, undefined, signal)
  if (confirmed?.type !== 'directory' || confirmed.version !== entry.version) return undefined
  const second = await fs.resolve(path, { signal })
  const secondPath = fs.processPath(second)
  if (!isAbsolute(secondPath)
    || !isSafeLocalRepositoryPath(secondPath)
    || secondPath.length > MAX_TRUSTED_PATH_CHARS) {
    throw new SafeRepositoryError('unavailable')
  }
  if ((await fs.stat(second, signal))?.type !== 'directory'
    || secondPath !== firstPath) return undefined
  return { path: firstPath, version: confirmed.version }
}

async function assertConfiguredWorktree(
  fs: FileSystem,
  base: string,
  configured: string,
  expected: string,
  signal: AbortSignal,
): Promise<void> {
  const configuredPath = resolveControlPath(base, configured)
  const entry = await fs.lstat(configuredPath, undefined, signal)
  if (entry?.type === 'symlink' || entry?.type === 'other') throw new SafeRepositoryError('unavailable')
  const configuredDirectory = await resolveStableDirectory(fs, configuredPath, signal)
  if (configuredDirectory === undefined) throw new SafeRepositoryError('malformed')
  if (configuredDirectory.path !== expected) throw new SafeRepositoryError('ambiguous')
}

function readStableFile(
  fs: FileSystem,
  path: string,
  maxBytes: number,
  signal: AbortSignal,
  required: true,
): Promise<StableFile>
function readStableFile(
  fs: FileSystem,
  path: string,
  maxBytes: number,
  signal: AbortSignal,
  required: false,
): Promise<StableFile | undefined>
async function readStableFile(
  fs: FileSystem,
  path: string,
  maxBytes: number,
  signal: AbortSignal,
  required: boolean,
): Promise<StableFile | undefined> {
  const entry = await fs.lstat(path, undefined, signal)
  if (entry === undefined) {
    if (required) throw new SafeRepositoryError('malformed')
    return undefined
  }
  if (entry.type !== 'file' || entry.size !== undefined && entry.size > maxBytes) {
    throw new SafeRepositoryError('unavailable')
  }
  const target = await fs.resolve(path, { signal })
  const info = await fs.stat(target, signal)
  if (info?.type !== 'file' || info.size !== undefined && info.size > maxBytes) {
    throw new SafeRepositoryError('unavailable')
  }
  const bytes = await fs.readBytes(target, signal, maxBytes)
  const confirmed = await fs.lstat(path, undefined, signal)
  if (confirmed?.type !== 'file' || confirmed.version !== entry.version) {
    throw new SafeRepositoryError('unavailable')
  }
  return { bytes, version: confirmed.version }
}

async function readStableIndexFile(
  fs: FileSystem,
  path: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<StableIndexFile | undefined> {
  const file = await readStableFile(fs, path, maxBytes, signal, false)
  if (file === undefined) return undefined
  signal.throwIfAborted()
  const nativeInfo = await nativeLstat(path, { bigint: true })
  signal.throwIfAborted()
  const confirmed = await fs.lstat(path, undefined, signal)
  if (!nativeInfo.isFile()
    || confirmed?.type !== 'file'
    || confirmed.version !== file.version) {
    throw new SafeRepositoryError('unavailable')
  }
  return { ...file, mtimeNs: nativeInfo.mtimeNs }
}

async function configSnapshotIsUnsafe(
  git: RepositoryInventoryGit,
  cwd: string,
  snapshot: string,
  signal: AbortSignal,
): Promise<boolean> {
  const output = await git.run(cwd, [
    'config', '--no-includes', '--file', snapshot, '--null', '--name-only', '--list',
  ], signal)
  if (output.stderr.byteLength !== 0) throw new SafeRepositoryError('unavailable')
  if (splitNul(output.stdout).some(raw => isGitConfigIncludeName(decode(raw)))) return true
  return (await explicitConfigBooleans(git, cwd, snapshot, 'core.fsmonitor', signal))?.some(Boolean) ?? false
}

async function explicitConfigBooleans(
  git: RepositoryInventoryGit,
  cwd: string,
  snapshot: string,
  key: string,
  signal: AbortSignal,
): Promise<readonly boolean[] | undefined> {
  const values = await explicitConfigValues(git, cwd, snapshot, key, signal, 'bool')
  if (values === undefined) return undefined
  if (values.some(value => value !== 'true' && value !== 'false')) {
    throw new SafeRepositoryError('malformed')
  }
  return values.map(value => value === 'true')
}

async function effectiveSnapshotBoolean(
  git: RepositoryInventoryGit,
  cwd: string,
  commonSnapshot: string,
  worktreeSnapshot: string | undefined,
  key: string,
  signal: AbortSignal,
): Promise<boolean | undefined> {
  const common = (await explicitConfigBooleans(git, cwd, commonSnapshot, key, signal))?.at(-1)
  if (worktreeSnapshot === undefined) return common
  return (await explicitConfigBooleans(git, cwd, worktreeSnapshot, key, signal))?.at(-1) ?? common
}

async function explicitConfigValues(
  git: RepositoryInventoryGit,
  cwd: string,
  snapshot: string,
  key: string,
  signal: AbortSignal,
  type?: 'bool',
): Promise<readonly string[] | undefined> {
  let output: Awaited<ReturnType<RepositoryInventoryGit['run']>>
  try {
    output = await git.run(cwd, [
      'config', '--no-includes', '--file', snapshot, '--null',
      ...(type === undefined ? [] : [`--type=${type}`]),
      '--get-all', key,
    ], signal)
  } catch (error) {
    if (error instanceof GitCommandError && error.code === 'nonzero' && error.exitCode === 1) return undefined
    throw new SafeRepositoryError('unavailable')
  }
  if (output.stderr.byteLength !== 0) throw new SafeRepositoryError('unavailable')
  return splitNul(output.stdout).map(raw => decode(raw))
}

async function rejectWorktreeRepositoryIdentityOverrides(
  git: RepositoryInventoryGit,
  cwd: string,
  snapshot: string,
  signal: AbortSignal,
): Promise<void> {
  for (const key of ['core.repositoryFormatVersion', 'extensions.objectFormat', 'extensions.refStorage']) {
    if (await explicitConfigValues(git, cwd, snapshot, key, signal) !== undefined) {
      throw new SafeRepositoryError('unavailable')
    }
  }
}

async function readRemoteUrlConfig(
  git: RepositoryInventoryGit,
  cwd: string,
  snapshots: readonly string[],
  signal: AbortSignal,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  for (const snapshot of snapshots) {
    try {
      const output = await git.run(cwd, [
        'config', '--no-includes', '--file', snapshot, '--null', '--get-regexp', '^remote\\..*\\.url$',
      ], signal)
      if (output.stderr.byteLength !== 0) throw new SafeRepositoryError('unavailable')
      chunks.push(output.stdout)
    } catch (error) {
      if (error instanceof GitCommandError && error.code === 'nonzero' && error.exitCode === 1) continue
      if (error instanceof SafeRepositoryError) throw error
      throw new SafeRepositoryError('unavailable')
    }
  }
  return Buffer.concat(chunks)
}

async function hasSplitIndex(
  git: RepositoryInventoryGit,
  privateGitDirectory: string,
  worktree: string,
  signal: AbortSignal,
): Promise<boolean> {
  const output = await git.run(privateGitDirectory, [
    `--git-dir=${privateGitDirectory}`,
    `--work-tree=${worktree}`,
    'rev-parse', '--shared-index-path',
  ], signal)
  if (output.stderr.byteLength !== 0) throw new SafeRepositoryError('unavailable')
  return output.stdout.byteLength !== 0 && oneLine(output.stdout) !== ''
}

interface PinnedUpstream {
  readonly ref: string
  readonly looseRef?: StableFile
}

async function pinConfiguredUpstream(
  fs: FileSystem,
  git: RepositoryInventoryGit,
  privateGitDirectory: string,
  worktree: string,
  commonGitDirectory: string,
  branch: string | undefined,
  objectFormat: 'sha1' | 'sha256',
  maxBytes: number,
  signal: AbortSignal,
): Promise<PinnedUpstream | undefined> {
  if (branch === undefined) return undefined
  const output = await git.run(privateGitDirectory, [
    `--git-dir=${privateGitDirectory}`,
    `--work-tree=${worktree}`,
    'for-each-ref', '--count=2', '--format=%(refname)%00%(upstream)%00%(upstream:short)%00', branch,
  ], signal)
  if (output.stderr.byteLength !== 0) throw new SafeRepositoryError('unavailable')
  const upstream = parseConfiguredUpstream(output.stdout, branch)
  if (upstream === undefined) return undefined
  if (upstream.ref.length > MAX_GIT_REF_CHARS || upstream.short.length > MAX_GIT_REF_CHARS) {
    throw new SafeRepositoryError('unavailable')
  }
  if (!upstream.ref.startsWith('refs/') || !isSafeGitRef(upstream.ref)
    || /[\u0000-\u0020\u007f]/u.test(upstream.short)) {
    throw new SafeRepositoryError('malformed')
  }
  if (upstream.ref === branch) return { ref: upstream.ref }
  const components = upstream.ref.split('/')
  const source = join(commonGitDirectory, ...components)
  const destination = join(privateGitDirectory, ...components)
  if (!isSafeLocalRepositoryPath(source) || source.length > MAX_TRUSTED_PATH_CHARS
    || !isSafeLocalRepositoryPath(destination) || destination.length > MAX_TRUSTED_PATH_CHARS) {
    throw new SafeRepositoryError('unavailable')
  }
  const looseRef = await readStableFile(fs, source, maxBytes, signal, false)
  if (looseRef === undefined) return { ref: upstream.ref }
  const objectId = oneLine(looseRef.bytes)
  if (!isGitObjectId(objectId, objectFormat)) throw new SafeRepositoryError('unavailable')
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await writePrivateFile(destination, looseRef.bytes)
  return { ref: upstream.ref, looseRef }
}

function parseConfiguredUpstream(
  bytes: Uint8Array,
  branch: string,
): { readonly ref: string; readonly short: string } | undefined {
  const text = decode(bytes)
  if (text === '') return undefined
  const match = /^([^\0\r\n]+)\0([^\0\r\n]*)\0([^\0\r\n]*)\0\n$/u.exec(text)
  if (match === null || match[1] !== branch || (match[2] === '') !== (match[3] === '')) {
    throw new SafeRepositoryError('malformed')
  }
  return match[2] === '' ? undefined : { ref: match[2] as string, short: match[3] as string }
}

const PRIVATE_CONFIG_KEYS = new Set([
  'core.repositoryformatversion',
  'core.filemode',
  'core.symlinks',
  'core.ignorecase',
  'core.precomposeunicode',
  'core.autocrlf',
  'core.eol',
  'core.bare',
  'core.fsmonitor',
  'core.ignorestat',
  'core.trustctime',
  'core.checkstat',
  'extensions.objectformat',
  'extensions.refstorage',
])

async function writeMinimalRepositoryConfig(
  git: RepositoryInventoryGit,
  cwd: string,
  commonSnapshot: string,
  worktreeSnapshot: string | undefined,
  signal: AbortSignal,
): Promise<Buffer> {
  const destination = join(cwd, 'config')
  const entries: PrivateConfigEntry[] = []
  const snapshots: ReadonlyArray<readonly [string, 'common' | 'worktree']> = [
    [commonSnapshot, 'common'],
    ...(worktreeSnapshot === undefined ? [] : [[worktreeSnapshot, 'worktree'] as const]),
  ]
  for (const [snapshot, scope] of snapshots) {
    const output = await git.run(cwd, [
      'config', '--no-includes', '--file', snapshot, '--null', '--list',
    ], signal)
    if (output.stderr.byteLength !== 0) throw new SafeRepositoryError('unavailable')
    for (const record of splitNul(output.stdout)) {
      const separator = record.indexOf(0x0a)
      if (separator <= 0) throw new SafeRepositoryError('malformed')
      const name = decode(record.subarray(0, separator))
      const value = decode(record.subarray(separator + 1))
      const entry = privateConfigEntry(name, value, scope)
      if (entry !== undefined) entries.push(entry)
    }
  }
  for (const [variable, value] of [
    ['bare', 'false'],
    ['fsmonitor', 'false'],
    ['ignorestat', 'false'],
    ['trustctime', 'true'],
    ['checkstat', 'default'],
  ] as const) {
    entries.push({ section: 'core', variable, value })
  }
  const bytes = Buffer.from(serializePrivateConfig(entries), 'utf8')
  await writePrivateFile(destination, bytes)
  return bytes
}

interface PrivateConfigEntry {
  readonly section: 'core' | 'extensions' | 'branch' | 'remote'
  readonly subsection?: string
  readonly variable: string
  readonly value: string
}

function privateConfigEntry(
  name: string,
  value: string,
  scope: 'common' | 'worktree',
): PrivateConfigEntry | undefined {
  const normalized = name.toLowerCase()
  if (PRIVATE_CONFIG_KEYS.has(normalized)) {
    if (scope === 'worktree' && (normalized === 'core.repositoryformatversion'
      || normalized === 'extensions.objectformat'
      || normalized === 'extensions.refstorage')) return undefined
    const separator = normalized.indexOf('.')
    const section = normalized.slice(0, separator) as 'core' | 'extensions'
    return { section, variable: normalized.slice(separator + 1), value }
  }
  if (/[\u0000-\u001f\u007f]/u.test(name)) return undefined
  return subsectionConfigEntry(name, normalized, value, 'branch.', ['remote', 'merge'])
    ?? subsectionConfigEntry(name, normalized, value, 'remote.', ['fetch'])
}

function subsectionConfigEntry(
  name: string,
  normalized: string,
  value: string,
  prefix: 'branch.' | 'remote.',
  variables: readonly string[],
): PrivateConfigEntry | undefined {
  if (!normalized.startsWith(prefix)) return undefined
  for (const variable of variables) {
    const suffix = `.${variable}`
    if (!normalized.endsWith(suffix) || normalized.length <= prefix.length + suffix.length) continue
    return {
      section: prefix === 'branch.' ? 'branch' : 'remote',
      subsection: name.slice(prefix.length, -suffix.length),
      variable,
      value,
    }
  }
  return undefined
}

function serializePrivateConfig(entries: readonly PrivateConfigEntry[]): string {
  let output = ''
  for (const entry of entries) {
    const subsection = entry.subsection === undefined ? '' : ` ${quoteConfig(entry.subsection)}`
    output += `[${entry.section}${subsection}]\n\t${entry.variable} = ${quoteConfig(entry.value)}\n`
  }
  return output
}

function quoteConfig(value: string): string {
  if (/[\u0000\u0001-\u0007\u000b-\u001f\u007f]/u.test(value)) {
    throw new SafeRepositoryError('unavailable')
  }
  return `"${value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\b', '\\b')
    .replaceAll('\t', '\\t')
    .replaceAll('\n', '\\n')}"`
}

function parseHeadBranch(bytes: Uint8Array): string | undefined {
  let text: string
  try {
    text = UTF8.decode(bytes)
  } catch {
    throw new SafeRepositoryError('malformed')
  }
  const line = text.endsWith('\r\n') ? text.slice(0, -2) : text.endsWith('\n') ? text.slice(0, -1) : undefined
  if (line === undefined || line.includes('\r') || line.includes('\n')) throw new SafeRepositoryError('malformed')
  if (!line.startsWith('ref: ')) return undefined
  const ref = line.slice('ref: '.length)
  if (!ref.startsWith('refs/heads/') || ref.length > MAX_GIT_REF_CHARS
    || !isSafeGitRef(ref) || !isSafeGitBranchName(ref.slice('refs/heads/'.length))) {
    throw new SafeRepositoryError('malformed')
  }
  return ref
}

async function copyOptionalControlFile(
  fs: FileSystem,
  source: string,
  destination: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<StableFile | undefined> {
  const file = await readStableFile(fs, source, maxBytes, signal, false)
  if (file === undefined) return undefined
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await writePrivateFile(destination, file.bytes)
  return file
}

function sourceFileStamp(file: StableFile | undefined):
  | { readonly version: FsVersion; readonly digest: string }
  | undefined {
  return file === undefined
    ? undefined
    : { version: file.version, digest: createHash('sha256').update(file.bytes).digest('hex') }
}

function sameStableFile(left: StableFile | undefined, right: StableFile | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.version === right.version
    && createHash('sha256').update(left.bytes).digest('hex')
    === createHash('sha256').update(right.bytes).digest('hex')
}

async function writePrivateFile(path: string, bytes: Uint8Array): Promise<void> {
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
}

async function writePrivateIndex(path: string, index: StableIndexFile): Promise<void> {
  await writePrivateFile(path, index.bytes)
  const backdatedNanoseconds = index.mtimeNs > NANOSECONDS_PER_SECOND
    ? index.mtimeNs - NANOSECONDS_PER_SECOND
    : 0n
  const timestampSeconds = backdatedNanoseconds / NANOSECONDS_PER_SECOND
  await utimes(path, Number(timestampSeconds), Number(timestampSeconds))
  const confirmed = await nativeLstat(path, { bigint: true })
  /* v8 ignore next -- private creation plus backdated whole-second utimes cannot yield a newer mtime; fail closed on anomalies. */
  if (confirmed.mtimeNs > index.mtimeNs) {
    throw new SafeRepositoryError('unavailable')
  }
}

function splitNul(bytes: Uint8Array): Uint8Array[] {
  if (bytes.byteLength === 0) return []
  if (bytes[bytes.byteLength - 1] !== 0) throw new SafeRepositoryError('malformed')
  const values: Uint8Array[] = []
  let start = 0
  for (let index = 0; index < bytes.byteLength; index++) {
    if (bytes[index] !== 0) continue
    values.push(bytes.subarray(start, index))
    start = index + 1
  }
  return values
}

function decode(bytes: Uint8Array): string {
  try {
    return UTF8.decode(bytes)
  } catch {
    throw new SafeRepositoryError('malformed')
  }
}

function oneLine(bytes: Uint8Array): string {
  const text = decode(bytes)
  const value = text.endsWith('\r\n') ? text.slice(0, -2) : text.endsWith('\n') ? text.slice(0, -1) : undefined
  if (value === undefined || value.includes('\r') || value.includes('\n')) throw new SafeRepositoryError('malformed')
  return value
}

function repositoryQueryIsAllowed(
  args: readonly string[],
  hasStdin: boolean,
  objectFormat: 'sha1' | 'sha256',
): boolean {
  if (argsEqual(args, ['check-attr', '--all', '-z', '--stdin'])) return hasStdin
  if (hasStdin) return false
  if (isSafeProjectDiffQuery(args, objectFormat)) return true
  if (isSafeProjectStatusQuery(args)) return true
  const exactCommit = args.length === 3
    && args[0] === 'rev-parse'
    && args[1] === '--verify'
    ? exactCommitObjectId(args[2], objectFormat)
    : undefined
  if (exactCommit !== undefined) return true
  if (args.length === 4
    && args[0] === 'merge-base'
    && args[1] === '--is-ancestor'
    && exactCommitObjectId(args[2], objectFormat) !== undefined
    && exactCommitObjectId(args[3], objectFormat) !== undefined) return true
  if (argsEqual(args, ['ls-files', '--no-sparse', '-t', '--stage', '--full-name', '-z'])
    || argsEqual(args, ['ls-files', '-v', '-z', '--'])
    || argsEqual(args, ['ls-files', '--others', '--exclude-standard', '--full-name', '-z'])
    || argsEqual(args, ['rev-parse', '--show-object-format'])
    || argsEqual(args, ['rev-parse', '--verify', 'HEAD'])
    || argsEqual(args, ['rev-parse', '--verify', 'HEAD^{commit}'])
    || argsEqual(args, ['write-tree'])
    || argsEqual(args, ['symbolic-ref', '--quiet', 'HEAD'])
    || argsEqual(args, ['config', '--no-includes', '--null', '--name-only', '--list'])
    || argsEqual(args, ['config', '--no-includes', '--local', '--null', '--name-only', '--list'])
    || argsEqual(args, ['config', '--no-includes', '--worktree', '--null', '--name-only', '--list'])
  ) {
    return true
  }
  if (args.length === 5
    && argsEqual(args.slice(0, 4), ['ls-tree', '-r', '--full-tree', '-z'])
    && args[4] !== undefined
    && (args[4] === 'HEAD' || isGitObjectId(args[4]))) {
    return true
  }
  if (args.length === 4
    && args[0] === 'for-each-ref'
    && args[1] === '--count=2'
    && args[2] === '--format=%(refname)%00%(upstream)%00%(upstream:short)%00'
    && args[3] !== undefined
    && args[3].length <= MAX_GIT_REF_CHARS
    && args[3].startsWith('refs/heads/')
    && isSafeGitRef(args[3])
    && isSafeGitBranchName(args[3].slice('refs/heads/'.length))) {
    return true
  }
  const unscopedKey = args[5]
  if (args.length === 6
    && argsEqual(args.slice(0, 5), ['config', '--no-includes', '--null', '--type=bool', '--get-all'])
    && unscopedKey !== undefined
    && BOOLEAN_CONFIG_KEYS.has(unscopedKey)) {
    return true
  }
  if (argsEqual(args, ['config', '--no-includes', '--null', '--get-all', 'core.autocrlf'])) return true
  const scopedKey = args[6]
  return args.length === 7
    && args[0] === 'config'
    && args[1] === '--no-includes'
    && (args[2] === '--local' || args[2] === '--worktree')
    && args[3] === '--null'
    && args[4] === '--type=bool'
    && args[5] === '--get-all'
    && scopedKey !== undefined
    && SCOPED_BOOLEAN_CONFIG_KEYS.has(scopedKey)
}

function exactCommitObjectId(
  expression: string | undefined,
  objectFormat: 'sha1' | 'sha256',
): string | undefined {
  if (expression?.endsWith('^{commit}') !== true) return undefined
  const objectId = expression.slice(0, -'^{commit}'.length)
  return isGitObjectId(objectId, objectFormat) ? objectId : undefined
}

function argsEqual(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

function textOutput(value: string): { readonly stdout: Buffer; readonly stderr: Buffer } {
  return { stdout: Buffer.from(`${value}\n`), stderr: Buffer.alloc(0) }
}

/**
 * Convert an admitted object-directory path to Git's alternate-file spelling.
 * @param path - canonical object-directory path.
 * @param platform - path namespace whose separators require conversion.
 * @returns path spelling accepted in an object alternate file.
 */
export function gitAlternatePath(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? path.replaceAll('\\', '/') : path
}

/**
 * Reject path spellings that can select a Windows network, device, or
 * alternate-data-stream namespace before any filesystem probe.
 * @param path - untrusted locator or repository-owned control path.
 * @param platform - path namespace whose lexical rules apply.
 * @returns whether ordinary local path resolution may inspect the spelling.
 */
export function isSafeLocalRepositoryPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (/\0|[\r\n]/u.test(path)) return false
  if (platform !== 'win32') return true
  const normalized = path.replaceAll('/', '\\')
  if (normalized.startsWith('\\\\') || normalized.startsWith('\\??\\')) return false
  if (/^[A-Za-z]:[^\\]/u.test(normalized)) return false
  if (normalized.slice(2).includes(':')) return false
  for (const component of normalized.replace(/^[A-Za-z]:\\?/u, '').split('\\')) {
    if (component === '' || component === '.' || component === '..') continue
    if (/[ .]$/u.test(component)) return false
    const deviceName = component.split('.', 1)[0]?.toUpperCase()
    if (deviceName !== undefined
      && /^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/u.test(deviceName)) {
      return false
    }
  }
  const canonical = win32.normalize(normalized)
  return canonical === normalized || canonical === normalized.replace(/\\+$/u, '')
}

function pathIsDirectChild(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`)
    && !isAbsolute(path) && !path.includes(sep)
}

function topologyAllowedByScope(topology: RepositoryTopology, scope: SafeRepositoryScope): boolean {
  if (topology.topLevel.path !== scope.expectedTopLevelPath) return false
  const ordinaryDirectory = normalize(join(scope.expectedTopLevelPath, '.git'))
  return [topology.gitDirectory.path, topology.commonDirectory.path].every(candidate =>
    normalize(candidate) === ordinaryDirectory
    || scope.allowedAdministrativeRoots.some(root => pathStrictlyWithin(root, candidate)))
}

function pathStrictlyWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}
