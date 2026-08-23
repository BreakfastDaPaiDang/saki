/** Local Git worktree inspection orchestration. @module @breakfastdapaidang/saki-execution-local/inspection */

import { basename, isAbsolute, join, normalize } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { FsError, type FileSystem, type FsTarget } from '@deepseek-ai/dsh-fs'
import {
  compareSafeGitRemoteObservations,
  canonicalDigest,
  computeProjectInspectionFingerprint,
  deriveGitHubRepositoryCandidates,
  inheritedChangeBaselineIdentityMaterial,
  isGitObjectId,
  isNormalizedRemoteCoordinate,
  isSafeDisplayLocation,
  isSafeGitBranchName,
  isSafeGitRef,
  MAX_GIT_REF_CHARS,
  MAX_SAFE_REMOTES,
  MAX_TRUSTED_PATH_CHARS,
  projectSelectionInspectionSchema,
  safeGitRemoteObservationKey,
} from '@breakfastdapaidang/saki-execution'
import type {
  InspectProjectSelectionRequest,
  InspectProjectSelectionResult,
  ProjectSelectionInspection,
  ProjectSelectionProjection,
  RepositoryAdministrativeIdentity,
  SafeGitRemoteObservation,
  TrustedProjectSelectionObservation,
  WorkspaceId,
} from '@breakfastdapaidang/saki-execution'
import { buildInheritedChangeBaseline, type CapturedRepositoryInventory } from './baseline.ts'
import { GitCommandError, type GitRunner } from './git-runner.ts'
import { parseWorktreeList, type ParsedWorktreeRecord } from './git-observation.ts'
import {
  captureRepositoryInventory,
  createRepositoryObservationRound,
  isGitConfigIncludeName,
  RepositoryInventoryError,
  type RepositoryInventoryGit,
  type SubmoduleObjectObservation,
} from './inventory.ts'
import {
  isSafeLocalRepositoryPath,
  openSafeRepositoryView,
  RepositoryControlChangedError,
} from './safe-repository.ts'

const UTF8 = new TextDecoder('utf-8', { fatal: true })
class MalformedObservationError extends Error {}

/** Applied inspection and baseline limits. */
export interface InspectionConfig {
  readonly maxGitStdoutBytes: number
  readonly inventoryMaxEntries: number
  readonly inventoryMaxPathBytes: number
  readonly inventoryMaxGitOutputBytes: number
  readonly inventoryMaxFileBytes: number
  readonly inventoryMaxTotalFileBytes: number
  readonly inventoryMaxCaptureMs: number
  readonly baselineMaxEntries: number
  readonly baselineMaxPathBytes: number
  readonly baselineMaxGitOutputBytes: number
  readonly baselineMaxFileBytes: number
  readonly baselineMaxTotalFileBytes: number
  readonly baselineMaxCaptureMs: number
}

/** Minimal Workspace registry read face needed by inspection. */
export interface WorkspaceIndex {
  list(): readonly { readonly id: WorkspaceId; readonly path: string }[]
}

/**
 * Same-Host reader for one stable Git administrative-directory identity.
 * @param path - canonical Git administrative-directory path.
 * @param signal - caller lifetime.
 * @returns opaque identity of the directory object at that path.
 */
export type AdministrativeDirectoryIdentityReader = (
  path: string,
  signal: AbortSignal,
) => Promise<RepositoryAdministrativeIdentity>

/**
 * Resolve and inspect one caller selection without changing Git, Workspace, or
 * product state.
 * @param fs - filesystem provider sharing the Git execution world.
 * @param workspaces - current DSH Workspace index.
 * @param git - bounded structured Git runner.
 * @param config - applied Git and baseline limits.
 * @param request - selected Host and untrusted directory locator.
 * @param signal - required caller lifetime.
 * @param identityReader - optional Local Host filesystem-object identity reader.
 * @returns detached safe/trusted evidence or a bounded rejection.
 */
export async function inspectLocalProjectSelection(
  fs: FileSystem,
  workspaces: WorkspaceIndex,
  git: GitRunner,
  config: InspectionConfig,
  request: InspectProjectSelectionRequest,
  signal: AbortSignal,
  identityReader?: AdministrativeDirectoryIdentityReader,
): Promise<InspectProjectSelectionResult> {
  signal.throwIfAborted()
  if (!isSafeLocalRepositoryPath(request.directoryLocator)) return { ok: false, reason: 'unavailable' }
  const inventoryBounds = {
    maxEntries: config.inventoryMaxEntries,
    maxPathBytes: config.inventoryMaxPathBytes,
    maxGitOutputBytes: config.inventoryMaxGitOutputBytes,
    maxFileBytes: config.inventoryMaxFileBytes,
    maxTotalFileBytes: config.inventoryMaxTotalFileBytes,
    maxCaptureMs: config.inventoryMaxCaptureMs,
  }
  using firstObservation = createRepositoryObservationRound(git, inventoryBounds, signal)
  const firstRawGit = firstObservation.git
  const firstSignal = firstObservation.signal
  let selectionPath: SelectedDirectory
  try {
    selectionPath = await resolveSelectedDirectory(fs, request.directoryLocator, firstSignal)
    firstObservation.check()
  } catch {
    if (signal.aborted) throw signal.reason
    return { ok: false, reason: 'unavailable' }
  }
  if (selectionPath.kind !== 'directory') return { ok: false, reason: selectionPath.kind }

  try {
    const firstOpen = await openSafeRepositoryView(
      fs,
      firstRawGit,
      selectionPath.path,
      config.inventoryMaxFileBytes,
      firstSignal,
    )
    if (firstOpen.kind !== 'repository') return { ok: false, reason: firstOpen.kind }
    await using firstRepository = firstOpen.view
    const firstGit = firstRepository.git

    let bare: string
    try {
      bare = await gitText(firstGit, selectionPath.path, ['rev-parse', '--is-bare-repository'], firstSignal)
    } catch (error) {
      if (error instanceof GitCommandError && error.code === 'nonzero') return { ok: false, reason: 'not-git' }
      if (signal.aborted) throw signal.reason
      return { ok: false, reason: 'unavailable' }
    }
    if (bare === 'true') return { ok: false, reason: 'bare' }
    if (bare !== 'false') return { ok: false, reason: 'malformed' }

    if (await repositoryConfigIsUnsafe(firstGit, selectionPath.path, firstSignal)) {
      return { ok: false, reason: 'unavailable' }
    }
    const topLevelReported = await gitText(firstGit, selectionPath.path, [
      'rev-parse', '--path-format=absolute', '--show-toplevel',
    ], firstSignal)
    const gitDirectoryReported = await gitText(firstGit, selectionPath.path, [
      'rev-parse', '--path-format=absolute', '--absolute-git-dir',
    ], firstSignal)
    const commonDirectoryReported = await gitText(firstGit, selectionPath.path, [
      'rev-parse', '--path-format=absolute', '--git-common-dir',
    ], firstSignal)
    const objectFormat = await gitText(firstGit, selectionPath.path, ['rev-parse', '--show-object-format'], firstSignal)
    const head = await gitText(firstGit, selectionPath.path, ['rev-parse', '--verify', 'HEAD'], firstSignal)
    if ((objectFormat !== 'sha1' && objectFormat !== 'sha256')
      || !isGitObjectId(head, objectFormat)) {
      return { ok: false, reason: 'malformed' }
    }

    const topLevel = await resolveStableDirectory(fs, topLevelReported, false, firstSignal)
    const gitDirectory = await resolveStableDirectory(fs, gitDirectoryReported, true, firstSignal)
    const commonDirectory = await resolveStableDirectory(fs, commonDirectoryReported, true, firstSignal)
    if (topLevel === undefined || gitDirectory === undefined || commonDirectory === undefined) {
      return { ok: false, reason: 'malformed' }
    }
    if ([topLevel.path, gitDirectory.path, commonDirectory.path]
      .some(path => path.length > MAX_TRUSTED_PATH_CHARS)) return { ok: false, reason: 'unavailable' }
    if (!fs.contains(topLevel.target, selectionPath.target)
      || !fs.contains(commonDirectory.target, gitDirectory.target)) {
      return { ok: false, reason: 'ambiguous' }
    }
    const gitDirectoryIdentity = await administrativeDirectoryIdentity(
      gitDirectory,
      identityReader,
      firstSignal,
    )
    const commonGitDirectoryIdentity = commonDirectory.path === gitDirectory.path
      ? gitDirectoryIdentity
      : await administrativeDirectoryIdentity(commonDirectory, identityReader, firstSignal)

    const worktreeOutput = await firstGit.run(commonDirectory.path, [
      '--bare', `--git-dir=${commonDirectory.path}`, 'worktree', 'list', '--porcelain', '-z',
    ], firstSignal)
    let records: ParsedWorktreeRecord[]
    try {
      records = parseWorktreeList(worktreeOutput.stdout)
    } catch {
      return { ok: false, reason: 'malformed' }
    }
    if (records.some(record => record.head !== undefined && !objectMatchesFormat(record.head, objectFormat))) {
      return { ok: false, reason: 'malformed' }
    }
    const selected = await selectWorktreeRecord(fs, records, topLevel.path, firstSignal)
    if (selected.kind !== 'selected') return { ok: false, reason: selected.kind }
    if (selected.record.bare) return { ok: false, reason: 'bare' }
    if (selected.record.prunable) return { ok: false, reason: 'prunable' }
    const branch = await inspectBranch(firstGit, topLevel.path, firstSignal)
    if (!headAndBranchMatch(selected.record, branch, head)) return { ok: false, reason: 'ambiguous' }
    const inventory = await captureRepositoryInventory(
      topLevel.path,
      firstGit,
      objectFormat,
      inventoryBounds,
      firstSignal,
      async (path, childSignal) => await readSubmoduleObject(
        fs,
        firstRawGit,
        path,
        gitDirectory.path,
        commonDirectory.path,
        objectFormat,
        config.inventoryMaxFileBytes,
        childSignal,
      ),
    )
    const baselineFacts = buildInheritedChangeBaseline(inventory, {
      maxEntries: config.baselineMaxEntries,
      maxPathBytes: config.baselineMaxPathBytes,
      maxGitOutputBytes: config.baselineMaxGitOutputBytes,
      maxFileBytes: config.baselineMaxFileBytes,
      maxTotalFileBytes: config.baselineMaxTotalFileBytes,
      maxCaptureMs: config.baselineMaxCaptureMs,
    }, Date.now(), firstSignal)
    const baseline = baselineFacts.baseline
    const remotes = await inspectRemotes(firstGit, topLevel.path, firstSignal)
    const githubRepositoryCandidates = deriveGitHubRepositoryCandidates(remotes)
    const workspaceId = workspaceForPath(workspaces, topLevel.path)
    const workspace = workspaceObservation(workspaceId)
    const blockingReasons = [
      ...(baselineFacts.inheritedChangeEntryCount > 0 ? ['dirty' as const] : []),
      ...(baseline.kind === 'unavailable' ? ['baseline-unavailable' as const] : []),
      ...(baselineFacts.conversionAmbiguous ? ['conversion-ambiguous' as const] : []),
      ...(selected.record.locked ? ['locked' as const] : []),
    ]
    const location = basename(topLevel.path)
    const projection: Omit<ProjectSelectionProjection, 'fingerprint'> = {
      observationVersion: 1,
      hostId: request.hostId,
      displayLocation: location === ''
        ? 'filesystem root'
        : isSafeDisplayLocation(location) ? location : 'repository',
      objectFormat,
      head,
      ...(selected.record.branch !== undefined
        ? { branch: selected.record.branch.replace(/^refs\/heads\//u, '') }
        : {}),
      detached: selected.record.detached,
      ...(branch.upstream !== undefined ? { upstream: branch.upstream } : {}),
      locked: selected.record.locked,
      inheritedChangeEntryCount: baselineFacts.inheritedChangeEntryCount,
      conversionAmbiguous: baselineFacts.conversionAmbiguous,
      remotes,
      ...(githubRepositoryCandidates.length === 0 ? {} : { githubRepositoryCandidates }),
      ...(workspaceId !== undefined ? { workspaceId } : {}),
      automaticMutationEligible: blockingReasons.length === 0,
      blockingReasons,
      baseline,
    }
    const trusted: TrustedProjectSelectionObservation = {
      canonicalWorktreePath: topLevel.path,
      canonicalGitDirectory: gitDirectory.path,
      canonicalCommonGitDirectory: commonDirectory.path,
      gitDirectoryIdentity,
      commonGitDirectoryIdentity,
      comparison: inventory.comparison,
    }
    const inspection: ProjectSelectionInspection = {
      projection: {
        ...projection,
        fingerprint: computeProjectInspectionFingerprint(projection, trusted),
      },
      trusted,
    }
    await firstRepository.assertSourceControlUnchanged(firstSignal)
    firstObservation.check()
    using finalObservation = createRepositoryObservationRound(git, inventoryBounds, signal)
    const finalOpen = await openSafeRepositoryView(
      fs,
      finalObservation.git,
      selectionPath.path,
      config.inventoryMaxFileBytes,
      finalObservation.signal,
    )
    if (finalOpen.kind !== 'repository') {
      if (finalOpen.kind === 'malformed') return { ok: false, reason: 'malformed' }
      if (finalOpen.kind === 'unavailable') return { ok: false, reason: 'unavailable' }
      return { ok: false, reason: 'ambiguous' }
    }
    await using finalRepository = finalOpen.view
    const finalGit = finalRepository.git
    const finalSignal = finalObservation.signal
    if (await repositoryConfigIsUnsafe(finalGit, selectionPath.path, finalSignal)) {
      return { ok: false, reason: 'unavailable' }
    }
    const finalBare = await gitText(finalGit, selectionPath.path, ['rev-parse', '--is-bare-repository'], finalSignal)
    const finalTopLevelReported = await gitText(finalGit, selectionPath.path, [
      'rev-parse', '--path-format=absolute', '--show-toplevel',
    ], finalSignal)
    const finalGitDirectoryReported = await gitText(finalGit, selectionPath.path, [
      'rev-parse', '--path-format=absolute', '--absolute-git-dir',
    ], finalSignal)
    const finalCommonDirectoryReported = await gitText(finalGit, selectionPath.path, [
      'rev-parse', '--path-format=absolute', '--git-common-dir',
    ], finalSignal)
    const finalObjectFormat = await gitText(finalGit, selectionPath.path, ['rev-parse', '--show-object-format'], finalSignal)
    const finalHead = await gitText(finalGit, selectionPath.path, ['rev-parse', '--verify', 'HEAD'], finalSignal)
    if ((finalBare !== 'true' && finalBare !== 'false')
      || !isAbsolute(finalTopLevelReported)
      || !isAbsolute(finalGitDirectoryReported)
      || !isAbsolute(finalCommonDirectoryReported)
      || (finalObjectFormat !== 'sha1' && finalObjectFormat !== 'sha256')
      || !isGitObjectId(finalHead, finalObjectFormat)) {
      return { ok: false, reason: 'malformed' }
    }
    const finalTopLevel = await resolveStableDirectory(fs, finalTopLevelReported, false, finalSignal)
    const finalGitDirectory = await resolveStableDirectory(fs, finalGitDirectoryReported, true, finalSignal)
    const finalCommonDirectory = await resolveStableDirectory(fs, finalCommonDirectoryReported, true, finalSignal)
    if (finalTopLevel === undefined || finalGitDirectory === undefined || finalCommonDirectory === undefined) {
      return { ok: false, reason: 'malformed' }
    }
    if ([finalTopLevel.path, finalGitDirectory.path, finalCommonDirectory.path]
      .some(path => path.length > MAX_TRUSTED_PATH_CHARS)) return { ok: false, reason: 'unavailable' }
    if (!fs.contains(finalCommonDirectory.target, finalGitDirectory.target)) {
      return { ok: false, reason: 'ambiguous' }
    }
    const finalWorktreeOutput = await finalGit.run(
      finalCommonDirectory.path,
      ['--bare', `--git-dir=${finalCommonDirectory.path}`, 'worktree', 'list', '--porcelain', '-z'],
      finalSignal,
    )
    let finalRecords: ParsedWorktreeRecord[]
    try {
      finalRecords = parseWorktreeList(finalWorktreeOutput.stdout)
    } catch {
      return { ok: false, reason: 'malformed' }
    }
    if (finalRecords.some(record => record.head !== undefined && !objectMatchesFormat(record.head, finalObjectFormat))) {
      return { ok: false, reason: 'malformed' }
    }
    const finalSelected = await selectWorktreeRecord(fs, finalRecords, finalTopLevel.path, finalSignal)
    const finalBranch = await inspectBranch(finalGit, finalTopLevel.path, finalSignal)
    if (finalSelected.kind === 'malformed') return { ok: false, reason: 'malformed' }
    if (finalSelected.kind !== 'selected' || !headAndBranchMatch(finalSelected.record, finalBranch, finalHead)) {
      return { ok: false, reason: 'ambiguous' }
    }
    const finalInventory = await captureRepositoryInventory(
      finalTopLevel.path,
      finalGit,
      finalObjectFormat,
      inventoryBounds,
      finalSignal,
      async (path, childSignal) => await readSubmoduleObject(
        fs,
        finalObservation.git,
        path,
        finalGitDirectory.path,
        finalCommonDirectory.path,
        finalObjectFormat,
        config.inventoryMaxFileBytes,
        childSignal,
      ),
    )
    const finalBaselineFacts = buildInheritedChangeBaseline(finalInventory, {
      maxEntries: config.baselineMaxEntries,
      maxPathBytes: config.baselineMaxPathBytes,
      maxGitOutputBytes: config.baselineMaxGitOutputBytes,
      maxFileBytes: config.baselineMaxFileBytes,
      maxTotalFileBytes: config.baselineMaxTotalFileBytes,
      maxCaptureMs: config.baselineMaxCaptureMs,
    }, Date.now(), finalSignal)
    const finalRemotes = await inspectRemotes(finalGit, finalTopLevel.path, finalSignal)
    const finalWorkspaceId = workspaceForPath(workspaces, finalTopLevel.path)
    const finalGitDirectoryIdentity = await administrativeDirectoryIdentity(
      finalGitDirectory,
      identityReader,
      finalSignal,
    )
    const finalCommonGitDirectoryIdentity = finalCommonDirectory.path === finalGitDirectory.path
      ? finalGitDirectoryIdentity
      : await administrativeDirectoryIdentity(finalCommonDirectory, identityReader, finalSignal)
    await finalRepository.assertSourceControlUnchanged(finalSignal)
    if (finalBare !== 'false'
      || finalTopLevel.path !== topLevel.path
      || finalGitDirectory.path !== gitDirectory.path
      || finalCommonDirectory.path !== commonDirectory.path
      || finalRepository.sourceControlIdentity !== firstRepository.sourceControlIdentity
      || !isDeepStrictEqual(finalGitDirectoryIdentity, gitDirectoryIdentity)
      || !isDeepStrictEqual(finalCommonGitDirectoryIdentity, commonGitDirectoryIdentity)
      || finalObjectFormat !== objectFormat
      || finalHead !== head
      || !isDeepStrictEqual(finalSelected.record, selected.record)
      || !isDeepStrictEqual(finalBranch, branch)
      || !sameInventoryEvidence(finalInventory, inventory)
      || finalBaselineFacts.inheritedChangeEntryCount !== baselineFacts.inheritedChangeEntryCount
      || finalBaselineFacts.conversionAmbiguous !== baselineFacts.conversionAmbiguous
      || !sameBaselineEvidence(finalBaselineFacts.baseline, baseline)
      || !isDeepStrictEqual(finalRemotes, remotes)
      || !isDeepStrictEqual(workspaceObservation(finalWorkspaceId), workspace)) {
      return { ok: false, reason: 'ambiguous' }
    }
    const confirmed = projectSelectionInspectionSchema.parse(inspection)
    finalObservation.check()
    return { ok: true, inspection: confirmed }
  } catch (error) {
    if (signal.aborted) throw signal.reason
    if (error instanceof RepositoryControlChangedError) return { ok: false, reason: 'ambiguous' }
    if (error instanceof GitCommandError) return { ok: false, reason: 'unavailable' }
    if (error instanceof RepositoryInventoryError) return { ok: false, reason: error.kind }
    if (error instanceof MalformedObservationError) return { ok: false, reason: 'malformed' }
    return { ok: false, reason: 'unavailable' }
  }
}

async function repositoryConfigIsUnsafe(
  git: RepositoryInventoryGit,
  cwd: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (await scopedRepositoryConfigIsUnsafe(git, cwd, '--local', signal)) return true
  const worktreeConfig = await readScopedBooleanConfig(
    git,
    cwd,
    '--local',
    'extensions.worktreeConfig',
    signal,
  )
  if (!worktreeConfig.ok) return true
  return worktreeConfig.value === true
    && await scopedRepositoryConfigIsUnsafe(git, cwd, '--worktree', signal)
}

async function scopedRepositoryConfigIsUnsafe(
  git: RepositoryInventoryGit,
  cwd: string,
  scope: '--local' | '--worktree',
  signal: AbortSignal,
): Promise<boolean> {
  const names = await git.run(cwd, [
    'config', '--no-includes', scope, '--null', '--name-only', '--list',
  ], signal)
  if (names.stderr.byteLength !== 0
    || splitNul(names.stdout).some(raw => isGitConfigIncludeName(decode(raw)))) return true
  const fsmonitor = await readScopedBooleanConfig(git, cwd, scope, 'core.fsmonitor', signal)
  return !fsmonitor.ok || fsmonitor.value === true
}

async function readScopedBooleanConfig(
  git: RepositoryInventoryGit,
  cwd: string,
  scope: '--local' | '--worktree',
  key: string,
  signal: AbortSignal,
): Promise<{ readonly ok: true; readonly value: boolean | undefined } | { readonly ok: false }> {
  let output: Awaited<ReturnType<RepositoryInventoryGit['run']>>
  try {
    output = await git.run(cwd, [
      'config', '--no-includes', scope, '--null', '--type=bool', '--get-all', key,
    ], signal)
  } catch (error) {
    if (error instanceof GitCommandError && error.code === 'nonzero') {
      return error.exitCode === 1 ? { ok: true, value: undefined } : { ok: false }
    }
    throw error
  }
  if (output.stderr.byteLength !== 0) return { ok: false }
  const last = splitNul(output.stdout).at(-1)
  if (last === undefined) return { ok: false }
  const value = decode(last)
  if (value === 'true') return { ok: true, value: true }
  if (value === 'false') return { ok: true, value: false }
  return { ok: false }
}

async function readSubmoduleObject(
  fs: FileSystem,
  rawGit: RepositoryInventoryGit,
  path: string,
  selectedGitDirectory: string,
  selectedCommonDirectory: string,
  objectFormat: 'sha1' | 'sha256',
  maxControlFileBytes: number,
  signal: AbortSignal,
): Promise<SubmoduleObjectObservation | undefined> {
  try {
    const expected = await resolveStableDirectory(fs, path, true, signal)
    if (expected === undefined) return undefined
    const opened = await openSafeRepositoryView(
      fs,
      rawGit,
      expected.path,
      maxControlFileBytes,
      signal,
      {
        expectedTopLevelPath: expected.path,
        allowedAdministrativeRoots: [
          join(selectedGitDirectory, 'modules'),
          join(selectedCommonDirectory, 'modules'),
        ],
      },
    )
    if (opened.kind !== 'repository') return undefined
    await using repository = opened.view
    const git = repository.git
    const read = async (args: readonly string[]): Promise<string> => {
      const value = await gitTextWithBytes(git, path, args, signal)
      return value.text
    }
    const nestedFormat = await read(['rev-parse', '--show-object-format'])
    const object = await gitTextWithBytes(git, path, ['rev-parse', '--verify', 'HEAD^{commit}'], signal)
    const objectId = object.text
    if (nestedFormat !== 'sha1' && nestedFormat !== 'sha256') {
      throw new RepositoryInventoryError('malformed')
    }
    if (!isGitObjectId(objectId, nestedFormat)) {
      throw new RepositoryInventoryError('malformed')
    }
    await repository.assertSourceControlUnchanged(signal)
    if (nestedFormat !== objectFormat) return undefined
    return { objectId, semanticGitOutputBytes: object.bytes }
  } catch (error) {
    if (error instanceof MalformedObservationError) throw new RepositoryInventoryError('malformed')
    if (error instanceof GitCommandError && error.code === 'nonzero') return undefined
    throw error
  }
}

function objectMatchesFormat(objectId: string, objectFormat: 'sha1' | 'sha256'): boolean {
  return isGitObjectId(objectId, objectFormat)
}

interface ObservedBranch {
  readonly ref?: string
  readonly upstream?: string
}

async function inspectBranch(
  git: RepositoryInventoryGit,
  cwd: string,
  signal: AbortSignal,
): Promise<ObservedBranch> {
  let ref: string | undefined
  try {
    ref = await gitText(git, cwd, ['symbolic-ref', '--quiet', 'HEAD'], signal)
  } catch (error) {
    if (!(error instanceof GitCommandError && error.code === 'nonzero' && error.exitCode === 1)) throw error
  }
  if (ref === undefined) return {}
  if (!ref.startsWith('refs/heads/')) throw new MalformedObservationError()
  if (ref.length > MAX_GIT_REF_CHARS) throw new RepositoryInventoryError('unavailable')
  if (!isSafeGitRef(ref) || !isSafeGitBranchName(ref.slice('refs/heads/'.length))) {
    throw new MalformedObservationError()
  }
  const upstream = await inspectUpstream(git, cwd, ref, signal)
  if (upstream !== undefined && upstream.length > MAX_GIT_REF_CHARS) {
    throw new RepositoryInventoryError('unavailable')
  }
  if (upstream !== undefined && (!upstream.startsWith('refs/') || !isSafeGitRef(upstream))) {
    throw new MalformedObservationError()
  }
  return { ref, ...(upstream === undefined ? {} : { upstream }) }
}

async function inspectUpstream(
  git: RepositoryInventoryGit,
  cwd: string,
  ref: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const { stdout } = await git.run(cwd, [
    'for-each-ref', '--count=2', '--format=%(refname)%00%(upstream)%00', ref,
  ], signal)
  let text: string
  try {
    text = UTF8.decode(stdout)
  } catch {
    throw new MalformedObservationError()
  }
  const match = /^([^\0\r\n]+)\0([^\0\r\n]*)\0\n$/u.exec(text)
  if (match === null || match[1] !== ref) throw new MalformedObservationError()
  return match[2] === '' ? undefined : match[2]
}

function headAndBranchMatch(
  record: ParsedWorktreeRecord,
  branch: ObservedBranch,
  head: string,
): boolean {
  if (record.head !== head) return false
  if (record.detached) return record.branch === undefined && branch.ref === undefined
  return record.branch !== undefined && record.branch === branch.ref
}

function sameBaselineEvidence(
  left: ProjectSelectionProjection['baseline'],
  right: ProjectSelectionProjection['baseline'],
): boolean {
  if (left.kind !== right.kind) return false
  return isDeepStrictEqual(
    inheritedChangeBaselineIdentityMaterial(left),
    inheritedChangeBaselineIdentityMaterial(right),
  )
}

function sameInventoryEvidence(
  left: CapturedRepositoryInventory,
  right: CapturedRepositoryInventory,
): boolean {
  const { elapsedMs: _leftElapsed, ...leftCapture } = left.capture
  const { elapsedMs: _rightElapsed, ...rightCapture } = right.capture
  return isDeepStrictEqual({ ...left, capture: leftCapture }, { ...right, capture: rightCapture })
}

type SelectedDirectory =
  | { readonly kind: 'directory'; readonly path: string; readonly target: FsTarget }
  | { readonly kind: 'missing' | 'not-directory' | 'unavailable' }

async function resolveSelectedDirectory(
  fs: FileSystem,
  locator: string,
  signal: AbortSignal,
): Promise<SelectedDirectory> {
  const pathInfo = await fs.lstat(locator, undefined, signal)
  if (pathInfo === undefined) return { kind: 'missing' }
  if (pathInfo.type === 'symlink') return { kind: 'unavailable' }
  let target: FsTarget
  try {
    target = await fs.resolve(locator, { signal })
  } catch (error) {
    if (signal.aborted) throw signal.reason
    if (error instanceof FsError && error.code === 'FS_NOT_FOUND') return { kind: 'missing' }
    throw error
  }
  const info = await fs.stat(target, signal)
  if (info?.type !== 'directory') return { kind: 'not-directory' }
  const second = await fs.resolve(locator, { signal })
  const secondInfo = await fs.stat(second, signal)
  if (secondInfo?.type !== 'directory' || fs.processPath(second) !== fs.processPath(target)) {
    return { kind: 'missing' }
  }
  return { kind: 'directory', path: fs.processPath(second), target: second }
}

interface StableDirectory {
  readonly path: string
  readonly target: FsTarget
  readonly version: string
}

async function resolveStableDirectory(
  fs: FileSystem,
  path: string,
  rejectSymlink: boolean,
  signal: AbortSignal,
): Promise<StableDirectory | undefined> {
  if (!isAbsolute(path)) return undefined
  const entry = await fs.lstat(path, undefined, signal)
  if (entry === undefined || (rejectSymlink && entry.type === 'symlink')) return undefined
  const first = await fs.resolve(path, { signal })
  if ((await fs.stat(first, signal))?.type !== 'directory') return undefined
  const secondEntry = await fs.lstat(path, undefined, signal)
  if (secondEntry === undefined || secondEntry.version !== entry.version || (rejectSymlink && secondEntry.type === 'symlink')) {
    return undefined
  }
  const second = await fs.resolve(path, { signal })
  if ((await fs.stat(second, signal))?.type !== 'directory' || fs.processPath(second) !== fs.processPath(first)) return undefined
  return { path: fs.processPath(first), target: first, version: secondEntry.version }
}

async function administrativeDirectoryIdentity(
  directory: StableDirectory,
  reader: AdministrativeDirectoryIdentityReader | undefined,
  signal: AbortSignal,
): Promise<RepositoryAdministrativeIdentity> {
  signal.throwIfAborted()
  if (reader !== undefined) return await reader(directory.path, signal)
  return {
    version: 1,
    digest: canonicalDigest('saki/provider-administrative-directory-identity/v1', { version: directory.version }),
  }
}

type WorktreeSelection =
  | { readonly kind: 'selected'; readonly record: ParsedWorktreeRecord }
  | { readonly kind: 'ambiguous' | 'malformed' }

async function selectWorktreeRecord(
  fs: FileSystem,
  records: readonly ParsedWorktreeRecord[],
  selectedPath: string,
  signal: AbortSignal,
): Promise<WorktreeSelection> {
  const matches: ParsedWorktreeRecord[] = []
  const selectedSpelling = normalize(selectedPath)
  for (const record of records) {
    if (!isAbsolute(record.path)) return { kind: 'malformed' }
    if (normalize(record.path) !== selectedSpelling) continue
    if (record.bare || record.prunable) {
      matches.push(record)
      continue
    }
    const resolved = await resolveStableDirectory(fs, record.path, false, signal)
    if (resolved?.path !== selectedPath) return { kind: 'malformed' }
    matches.push(record)
  }
  const [record, ...duplicates] = matches
  if (record === undefined || duplicates.length > 0) return { kind: 'ambiguous' }
  return { kind: 'selected', record }
}

async function gitText(
  git: RepositoryInventoryGit,
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<string> {
  return (await gitTextWithBytes(git, cwd, args, signal)).text
}

async function gitTextWithBytes(
  git: RepositoryInventoryGit,
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<{ readonly text: string; readonly bytes: number }> {
  const { stdout } = await git.run(cwd, args, signal)
  let text: string
  try {
    text = UTF8.decode(stdout)
  } catch {
    throw new MalformedObservationError()
  }
  const value = text.endsWith('\r\n') ? text.slice(0, -2) : text.endsWith('\n') ? text.slice(0, -1) : undefined
  if (value === undefined || value.includes('\r') || value.includes('\n')) throw new MalformedObservationError()
  return { text: value, bytes: stdout.byteLength }
}

async function inspectRemotes(
  git: RepositoryInventoryGit,
  cwd: string,
  signal: AbortSignal,
): Promise<SafeGitRemoteObservation[]> {
  let output: Buffer
  try {
    output = (await git.run(cwd, [
      'config', '--no-includes', '--null', '--get-regexp', '^remote\\..*\\.url$',
    ], signal)).stdout
  } catch (error) {
    if (error instanceof GitCommandError && error.code === 'nonzero' && error.exitCode === 1) return []
    throw error
  }
  const unique = new Map<string, SafeGitRemoteObservation>()
  for (const record of splitNul(output)) {
    const newline = record.indexOf(0x0a)
    if (newline <= 0) throw new MalformedObservationError()
    const observation = sanitizeRemote(decode(record.subarray(newline + 1)))
    const key = safeGitRemoteObservationKey(observation)
    if (!unique.has(key) && unique.size >= MAX_SAFE_REMOTES) throw new RepositoryInventoryError('unavailable')
    unique.set(key, observation)
  }
  return [...unique.values()].sort(compareSafeGitRemoteObservations)
}

/**
 * Strip credentials and ambiguous URL components from one Git remote value.
 * @param value - complete remote URL read from local Git config.
 * @returns transport class and an optional unambiguous normalized coordinate.
 */
export function sanitizeRemote(value: string): SafeGitRemoteObservation {
  if (value === '') return { transport: 'other' }
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//u.exec(value)?.[1]?.toLowerCase()
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    if (/^[A-Za-z]:/u.test(value) || value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) {
      return { transport: 'file' }
    }
    return { transport: scheme === undefined ? 'other' : transportForScheme(scheme) }
  }
  if (/^[A-Za-z]:/u.test(value) || value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) {
    return { transport: 'file' }
  }
  const authority = scheme === undefined ? undefined : value.slice(value.indexOf('//') + 2).split('/', 1)[0]
  if (scheme !== undefined && authority !== undefined && authority.split('@').length > 2) {
    return { transport: transportForScheme(scheme) }
  }
  if (scheme === undefined) {
    const scp = /^(?:[^@/:\s]+@)?([^@/:\s]+):([^@/:\s?#][^@:\s?#]*(?:\/[^@:\s?#]+)*)$/u.exec(value)
    if (scp !== null) {
      const normalized = coordinate(scp[1] as string, scp[2] as string)
      return normalized === undefined ? { transport: 'ssh' } : { transport: 'ssh', coordinate: normalized }
    }
  }
  try {
    const url = new URL(value)
    if (url.protocol === 'http:') return { transport: 'other' }
    if (url.protocol === 'https:') {
      const normalized = coordinate(url.host, url.pathname)
      return normalized === undefined ? { transport: 'https' } : { transport: 'https', coordinate: normalized }
    }
    if (url.protocol === 'ssh:' || url.protocol === 'git+ssh:') {
      if (url.hostname === '' || url.pathname === '') return { transport: 'ssh' }
      const normalized = coordinate(url.host, url.pathname)
      return normalized === undefined ? { transport: 'ssh' } : { transport: 'ssh', coordinate: normalized }
    }
    if (url.protocol === 'file:') return { transport: 'file' }
    return { transport: 'other' }
  } catch {
    if (scheme !== undefined) return { transport: transportForScheme(scheme) }
    return { transport: value.includes(':') ? 'other' : 'file' }
  }
}

function transportForScheme(scheme: string): SafeGitRemoteObservation['transport'] {
  if (scheme === 'https') return 'https'
  if (scheme === 'ssh' || scheme === 'git+ssh') return 'ssh'
  if (scheme === 'file') return 'file'
  return 'other'
}

function coordinate(host: string, path: string): string | undefined {
  const normalized = path.replace(/^\/+|\/+$/gu, '').replace(/\.git$/u, '')
    .replace(/%[0-9a-f]{2}/gu, value => value.toUpperCase())
  if (normalized === '') return undefined
  const value = `${host.toLowerCase()}/${normalized}`
  return isNormalizedRemoteCoordinate(value) ? value : undefined
}

function splitNul(bytes: Uint8Array): Uint8Array[] {
  const records: Uint8Array[] = []
  let start = 0
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue
    if (index === start) throw new MalformedObservationError()
    records.push(bytes.subarray(start, index))
    start = index + 1
  }
  if (start !== bytes.length) throw new MalformedObservationError()
  return records
}

function decode(bytes: Uint8Array): string {
  try {
    return UTF8.decode(bytes)
  } catch {
    throw new MalformedObservationError()
  }
}

function workspaceForPath(workspaces: WorkspaceIndex, path: string): WorkspaceId | undefined {
  const matches = workspaces.list().filter(workspace => workspace.path === path)
  if (matches.length > 1) throw new Error('Workspace index contains duplicate canonical paths')
  return matches[0]?.id
}

function workspaceObservation(workspaceId: WorkspaceId | undefined):
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly workspaceId: WorkspaceId } {
  return workspaceId === undefined ? { kind: 'absent' } : { kind: 'present', workspaceId }
}
