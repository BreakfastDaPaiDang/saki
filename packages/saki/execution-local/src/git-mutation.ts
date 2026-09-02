/** Recoverable structured Git mutation engine for the Local Host. @module @breakfastdapaidang/saki-execution-local/git-mutation */

import { createHash, randomBytes } from 'node:crypto'
import { constants as bufferConstants } from 'node:buffer'
import { constants as fsConstants, type BigIntStats } from 'node:fs'
import {
  chmod,
  lstat,
  link,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readlink,
  rename,
  rmdir,
  rm,
  unlink,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { copyFileDaclWin32, replaceFileWin32 } from '@deepseek-ai/dsh-fs-local'
import {
  canonicalDigest,
  type AppliedProjectGitChange,
  type HostOperationCancellationReason,
  type HostOperationFailure,
  type HostGitMutationPrecondition,
  type HostOperationRequest,
  type HostOperationSnapshot,
  type ProjectGitChange,
  type ProjectGitCommitSignature,
  type ProjectGitStatusObservation,
} from '@breakfastdapaidang/saki-execution'
import type {
  WorkspaceIndex,
  AdministrativeDirectoryIdentityReader,
  InspectionConfig,
  StableLocalProjectSelectionFailureReason,
} from './inspection.ts'
import {
  BoundProjectResourceMismatchError,
  inspectStableLocalProjectSelection,
} from './inspection.ts'
import { GitCommandError, type GitRunner } from './git-runner.ts'
import type {
  CapturedInventoryGitObject,
  CapturedRepositoryInventory,
  CapturedRepositoryInventoryEntry,
} from './baseline.ts'
import { buildProjectGitStatusObservation, ProjectGitStatusProjectionError } from './status.ts'
import { exactBytesDigest } from './canonical.ts'
import { gitAlternatePath } from './safe-repository.ts'
import {
  hostOperationSnapshotCore,
  localHostOperationIndexLockMarker,
  type LocalHostCommitPlan,
  type LocalHostIndexFileEvidence,
  type LocalHostIndexPinEvidence,
  type LocalHostGitOperationEffectPlan as LocalHostOperationEffectPlan,
  type LocalHostGitOperationRecord as LocalHostOperationRecord,
  type LocalHostOperationScratch,
  type LocalHostStageFilesPlan,
  type LocalHostUnstageFilesPlan,
} from './operation-state.ts'

const UTF8 = new TextDecoder('utf-8', { fatal: true })
interface BoundedReadOpenConstants {
  readonly O_RDONLY: number
  readonly O_NOFOLLOW?: number
  readonly O_NONBLOCK?: number
}

/**
 * Resolve the platform-supported flags for one bounded, non-following read.
 * @param constants - required read flag plus optional POSIX safety flags.
 * @returns the bitmask accepted by Node's `open` primitive.
 * @internal
 */
export function resolveBoundedReadOpenFlags(constants: BoundedReadOpenConstants): number {
  return constants.O_RDONLY
    | (constants.O_NOFOLLOW ?? 0)
    | (constants.O_NONBLOCK ?? 0)
}

const BOUNDED_READ_OPEN_FLAGS = resolveBoundedReadOpenFlags(fsConstants)

/**
 * Largest valid `git update-index --index-info` stdin for one bounded selection.
 * @param maxPathBytes - aggregate path-byte budget already enforced by inventory capture.
 * @param changeCount - selected change count already enforced by the Host request schema.
 * @param objectIdWidth - repository object-id width.
 * @returns a Buffer-safe upper bound including mode, separators, and NUL terminators.
 */
export function gitIndexInstructionByteLimit(
  maxPathBytes: number,
  changeCount: number,
  objectIdWidth: 40 | 64,
): number {
  return Math.min(
    bufferConstants.MAX_LENGTH,
    maxPathBytes + changeCount * (objectIdWidth + 9),
  )
}

/**
 * Add one encoded index-info record without exceeding Node's Buffer limit.
 * @param currentBytes - bytes already retained for the instruction stream.
 * @param recordBytes - bytes in the next complete record.
 * @returns the new total, or `undefined` when concatenation would overflow.
 * @internal
 */
export function addGitIndexInstructionBytes(
  currentBytes: number,
  recordBytes: number,
): number | undefined {
  return recordBytes > bufferConstants.MAX_LENGTH - currentBytes
    ? undefined
    : currentBytes + recordBytes
}

/**
 * Add one path-byte contribution to a loose-object count bound.
 * @param currentLimit - object-count bound accumulated before this path.
 * @param pathBytes - bytes in the next captured repository path.
 * @returns the new safe-integer bound, or `undefined` when addition would overflow.
 * @internal
 */
export function addOwnedLooseObjectCount(
  currentLimit: number,
  pathBytes: number,
): number | undefined {
  return pathBytes > Number.MAX_SAFE_INTEGER - currentLimit
    ? undefined
    : currentLimit + pathBytes
}

/** Mutation-only bounds in addition to the stable-inspection limits. */
export interface LocalGitMutationConfig extends InspectionConfig {
  readonly operationMaxIndexBytes: number
  readonly operationMaxReflogBytes: number
}

/** Dependencies that share the Local Host execution world. */
export interface LocalGitMutationDependencies {
  readonly fs: FileSystem
  readonly workspaces: WorkspaceIndex
  readonly git: GitRunner
  readonly config: LocalGitMutationConfig
  readonly identityReader: AdministrativeDirectoryIdentityReader
  readonly isOperationDurable: (record: LocalHostOperationRecord) => boolean
  /** Provider-private adapters used to exercise host failure boundaries. @internal */
  readonly internals?: LocalGitMutationInternals
}

/** Read-only Local Host capabilities needed to revalidate one frozen writable world. */
export type LocalHostWorldVerificationDependencies = Pick<
  LocalGitMutationDependencies,
  'fs' | 'workspaces' | 'git' | 'config' | 'identityReader'
>

/** File handle surface used by the mutation engine's Node adapter. @internal */
export interface LocalGitMutationFileHandle {
  readonly stat: () => Promise<BigIntStats>
  readonly read: (
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ) => Promise<{ readonly bytesRead: number }>
  readonly writeFile: (bytes: Uint8Array) => Promise<void>
  readonly chmod: (mode: number) => Promise<void>
  readonly sync: () => Promise<void>
  readonly close: () => Promise<void>
}

/** Node filesystem primitives below Git mutation ownership decisions. @internal */
export interface LocalGitMutationNodeAdapter {
  /** Platform whose file-publication semantics the adapter implements. */
  readonly platform: NodeJS.Platform
  /** Copy and protect one existing Windows file DACL before staged bytes are written. */
  readonly copyFileDacl: (source: string, destination: string) => Promise<void>
  /** Replace one existing Windows file without discarding its security descriptor. */
  readonly replaceFile: (replaced: string, replacement: string) => Promise<void>
  readonly lstat: (path: string) => Promise<BigIntStats>
  readonly readlink: (path: string) => Promise<Buffer>
  readonly open: (
    path: string,
    flags: 'r' | 'r+' | 'wx',
    mode?: number,
  ) => Promise<LocalGitMutationFileHandle>
  readonly rm: (
    path: string,
    options: { readonly recursive?: boolean; readonly force: boolean },
  ) => Promise<void>
  readonly link: (from: string, to: string) => Promise<void>
  readonly readdir: (path: string) => Promise<readonly string[]>
  readonly rename: (from: string, to: string) => Promise<void>
  readonly rmdir: (path: string) => Promise<void>
  readonly syncDirectory: (path: string) => Promise<void>
  readonly unlink: (path: string) => Promise<void>
}

/** Optional provider-private mutation internals; supplied adapters are complete. @internal */
export interface LocalGitMutationInternals {
  readonly node: LocalGitMutationNodeAdapter
}

/** Production Node primitives for the mutation engine's internal failure seam. @internal */
export const localGitMutationNodeAdapter: LocalGitMutationNodeAdapter = {
  platform: process.platform,
  copyFileDacl: copyFileDaclWin32,
  replaceFile: replaceFileWin32,
  async lstat(path) {
    return await lstat(path, { bigint: true })
  },
  readlink: async path => await readlink(path, { encoding: 'buffer' }),
  async open(path, flags, mode) {
    // Windows omits the POSIX-only flags, reducing bounded reads to ordinary O_RDONLY files.
    const handle = await open(path, flags === 'r' ? BOUNDED_READ_OPEN_FLAGS : flags, mode)
    return {
      stat: async () => await handle.stat({ bigint: true }),
      read: async (buffer, offset, length, position) => await handle.read(buffer, offset, length, position),
      writeFile: async (bytes) => { await handle.writeFile(bytes) },
      chmod: async (nextMode) => { await handle.chmod(nextMode) },
      sync: async () => { await handle.sync() },
      close: async () => { await handle.close() },
    }
  },
  rm: async (path, options) => { await rm(path, options) },
  link: async (from, to) => { await link(from, to) },
  readdir: async path => await readdir(path),
  rename: async (from, to) => { await rename(from, to) },
  rmdir: async (path) => { await rmdir(path) },
  syncDirectory,
  unlink: async (path) => { await unlink(path) },
}

function mutationNodeAdapter(dependencies: LocalGitMutationDependencies): LocalGitMutationNodeAdapter {
  return dependencies.internals?.node ?? localGitMutationNodeAdapter
}

/** Run every cleanup, then throw the exact caller abort or first cleanup failure. */
async function cleanupBeforeRethrow(
  signal: AbortSignal,
  ...cleanup: readonly (() => Promise<void>)[]
): Promise<void> {
  const results = await Promise.allSettled(cleanup.map(action => action()))
  signal.throwIfAborted()
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (rejected !== undefined) throw rejected.reason
}

/**
 * Require a prepared publication attempt to remain active before it becomes durable.
 * @param signal - current attempt lifetime checked after private preparation completes.
 * @param discard - cleanup for every private artifact created during preparation.
 * @returns after confirming the attempt remains active.
 * @throws {unknown} the caller's exact abort reason after cleanup completes.
 * @internal
 */
export async function requirePreparedMutationActive(
  signal: AbortSignal,
  discard: () => Promise<void>,
): Promise<void> {
  try {
    signal.throwIfAborted()
  } catch (error) {
    await cleanupBeforeRethrow(signal, discard)
    /* v8 ignore next -- cleanupBeforeRethrow rethrows the already-observed abort before it can return here. */
    throw error
  }
}

/** One durable record replacement performed before notifying observers. */
export type PersistLocalHostOperation = (record: LocalHostOperationRecord) => Promise<void>

/** Result of one admitted start/resume attempt. */
export type LocalGitMutationAdvanceResult =
  | { readonly kind: 'advanced'; readonly record: LocalHostOperationRecord }
  | { readonly kind: 'retryable'; readonly reason: 'busy' | 'unavailable'; readonly record: LocalHostOperationRecord }

/** Evidence sufficient to decide recovery without performing Git or filesystem effects. @internal */
export type GitPublicationRecoveryEvidence =
  | {
    readonly kind: 'index'
    readonly actual: LocalHostIndexFileEvidence
    readonly expected: LocalHostIndexFileEvidence
    readonly target: LocalHostIndexFileEvidence
    readonly publication: LocalHostOperationEffectPlan['publication']
    readonly allowResume: boolean
  }
  | {
    readonly kind: 'commit'
    readonly current: string | undefined
    readonly expectedOldObjectId: string
    readonly resultCommitId: string
    readonly publication: LocalHostOperationEffectPlan['publication']
    readonly reflog: CommitReflogInspection
    readonly allowResume: boolean
    readonly detachedExpectedHead: boolean
  }

/** Pure recovery outcome applied by the mutation engine after evidence collection. @internal */
export type GitPublicationRecoveryDecision =
  | { readonly kind: 'succeeded' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'retryable'; readonly reason: 'unavailable' }
  | { readonly kind: 'no-effect'; readonly reason: 'observation-stale' | 'unsupported-state' }
  | { readonly kind: 'reconciliation'; readonly reason: 'effect-unknown' | 'evidence-conflict' }

/** Pure recovery action for one failed shared-index evidence read. @internal */
export type GitIndexRecoveryReadFailureDecision =
  | { readonly kind: 'aborted'; readonly reason: unknown }
  | { readonly kind: 'retryable'; readonly reason: 'unavailable' }
  | { readonly kind: 'no-effect'; readonly reason: HostOperationFailure['reason'] }
  | { readonly kind: 'reconciliation'; readonly reason: 'evidence-conflict' }
  | { readonly kind: 'unexpected'; readonly error: unknown }

/** Pure cancellation action for one failed shared-index evidence read. @internal */
export type CancelIndexEvidenceFailureDecision =
  | { readonly kind: 'aborted'; readonly reason: unknown }
  | { readonly kind: 'retain' }
  | { readonly kind: 'unexpected'; readonly error: unknown }

/** Pure cancellation action for one failed Commit target read. @internal */
export type CancelTargetReadFailureDecision =
  | { readonly kind: 'aborted'; readonly reason: unknown }
  | { readonly kind: 'retain' }
  | { readonly kind: 'unexpected'; readonly error: unknown }

/** Pure classification of one caught mutation error. @internal */
export type GitMutationErrorDecision =
  | { readonly kind: 'aborted'; readonly reason: unknown }
  | { readonly kind: 'retryable'; readonly reason: 'busy' | 'unavailable' }
  | { readonly kind: 'no-effect'; readonly reason: HostOperationFailure['reason'] }
  | { readonly kind: 'unexpected'; readonly error: unknown }

/** Pure classification of one failed owned-file observation. @internal */
export type OwnedFileReadFailureDecision =
  | { readonly kind: 'aborted'; readonly reason: unknown }
  | { readonly kind: 'state'; readonly state: 'missing' | 'unavailable' }

/** Pure classification of one failed symbolic-link target read. @internal */
export type WorktreeSymlinkReadFailureDecision =
  | { readonly kind: 'aborted'; readonly reason: unknown }
  | { readonly kind: 'retryable'; readonly reason: 'unavailable' }
  | { readonly kind: 'unexpected'; readonly error: unknown }

type CapturedWorktree = Extract<CapturedRepositoryInventoryEntry['current'], { readonly kind: 'captured' }>
type HashableWorktreeEvidence = Extract<
  CapturedWorktree['evidence'],
  { readonly kind: 'regular' | 'symlink' }
>
type HashableWorktreeMode = Exclude<CapturedInventoryGitObject['mode'], '160000'>
type CommitRequest = Extract<HostOperationRequest, { readonly type: 'commit' }>
type IndexRequest = Extract<HostOperationRequest, { readonly type: 'stage-files' | 'unstage-files' }>
type AttachedCommitRequest = CommitRequest & {
  readonly expected: CommitRequest['expected'] & {
    readonly head: CommitRequest['expected']['head'] & { readonly symbolicRef: string }
  }
}

/** Pure index update selected from one validated status and inventory row. @internal */
export type GitIndexSelectionDecision =
  | { readonly kind: 'reject'; readonly reason: 'invalid-selection' | 'unsupported-state' }
  | { readonly kind: 'remove' }
  | {
    readonly kind: 'use-object'
    readonly mode: CapturedInventoryGitObject['mode']
    readonly objectId: string
  }
  | {
    readonly kind: 'hash-worktree'
    readonly current: CapturedWorktree
    readonly evidence: HashableWorktreeEvidence
    readonly expectedObjectId: string
    readonly mode: HashableWorktreeMode
  }

/** Filesystem metadata retained by the pure owned-file classifier. @internal */
export interface OwnedFileStatObservation {
  readonly device: string
  readonly inode: string
  readonly byteLength: bigint
  readonly mode: number
  readonly kind: 'file' | 'symlink' | 'other'
  readonly modifiedNanoseconds: bigint
  readonly changedNanoseconds: bigint
}

/** One ordered observation checkpoint while proving file ownership. @internal */
export type OwnedFileObservation =
  | { readonly kind: 'path'; readonly stat: OwnedFileStatObservation }
  | {
    readonly kind: 'opened'
    readonly path: OwnedFileStatObservation
    readonly opened: OwnedFileStatObservation
  }
  | { readonly kind: 'contents'; readonly digest: string | undefined }
  | {
    readonly kind: 'post-read'
    readonly before: OwnedFileStatObservation
    readonly after: OwnedFileStatObservation
  }
  | {
    readonly kind: 'current'
    readonly before: OwnedFileStatObservation
    readonly current: OwnedFileStatObservation
  }

/** Pure intermediate or terminal result of one owned-file checkpoint. @internal */
export type OwnedFileObservationDecision = OwnedFileState | 'continue'

/** Stable metadata compared before and after reading one scratch owner marker. @internal */
export type ScratchMarkerStatObservation = Pick<
  OwnedFileStatObservation,
  'device' | 'inode' | 'byteLength' | 'modifiedNanoseconds' | 'changedNanoseconds'
>

/** Evidence retained after reading one scratch owner marker. @internal */
export interface ScratchMarkerConfirmationObservation {
  readonly before: ScratchMarkerStatObservation
  readonly confirmed: ScratchMarkerStatObservation
  readonly digestMatches: boolean
  readonly markerMatches: boolean
}

/** One bounded topology or membership observation from an owned loose-object store. @internal */
export type OwnedLooseObjectManifestObservation =
  | { readonly kind: 'root'; readonly directory: boolean; readonly symlink: boolean }
  | { readonly kind: 'root-entries'; readonly entryCount: number; readonly hasInfo: boolean }
  | {
    readonly kind: 'owned-directory'
    readonly directory: boolean
    readonly symlink: boolean
    readonly sameDevice: boolean
  }
  | { readonly kind: 'fanout-name'; readonly name: string }
  | {
    readonly kind: 'object-count'
    readonly retainedCount: number
    readonly candidateCount: number
    readonly maxObjectCount: number
  }
  | { readonly kind: 'object-suffix'; readonly suffix: string; readonly objectIdWidth: 40 | 64 }
  | {
    readonly kind: 'owned-file'
    readonly file: boolean
    readonly symlink: boolean
    readonly sameDevice: boolean
  }

/**
 * Decide one durable publication outcome from already collected evidence.
 * @param evidence - exact index or Commit evidence and caller resume authority.
 * @returns the effect-free recovery action for the engine to apply.
 * @internal
 */
export function decideGitPublicationRecovery(
  evidence: GitPublicationRecoveryEvidence,
): GitPublicationRecoveryDecision {
  if (evidence.kind === 'index') {
    if (sameIndexEvidence(evidence.actual, evidence.target)) return { kind: 'succeeded' }
    if (evidence.publication === 'not-started' && sameIndexEvidence(evidence.actual, evidence.expected)) {
      return evidence.allowResume ? { kind: 'resume' } : { kind: 'retryable', reason: 'unavailable' }
    }
    return evidence.publication === 'not-started'
      ? { kind: 'no-effect', reason: 'observation-stale' }
      : { kind: 'reconciliation', reason: 'evidence-conflict' }
  }

  if (evidence.detachedExpectedHead && evidence.publication === 'not-started') {
    return { kind: 'no-effect', reason: 'unsupported-state' }
  }
  if (!evidence.detachedExpectedHead && evidence.current === evidence.resultCommitId) {
    return { kind: 'succeeded' }
  }
  if (evidence.reflog === 'unavailable') return { kind: 'retryable', reason: 'unavailable' }
  if (evidence.reflog === 'found') return { kind: 'succeeded' }
  const expected = expectedCommitTargetObjectId(evidence.expectedOldObjectId)
  if (evidence.publication === 'not-started' && evidence.current === expected) {
    return evidence.allowResume ? { kind: 'resume' } : { kind: 'retryable', reason: 'unavailable' }
  }
  if (evidence.publication === 'not-started') return { kind: 'no-effect', reason: 'observation-stale' }
  return {
    kind: 'reconciliation',
    reason: evidence.reflog === 'limit' ? 'effect-unknown' : 'evidence-conflict',
  }
}

/**
 * Decide how an index publication recovers when its shared-index evidence cannot be read.
 * @param error - exact failure from the index evidence reader.
 * @param publication - durable index publication checkpoint.
 * @param interruption - caller cancellation state observed at the catch boundary.
 * @returns the effect-free recovery action for the engine to apply.
 * @internal
 */
export function decideGitIndexRecoveryReadFailure(
  error: unknown,
  publication: (LocalHostStageFilesPlan | LocalHostUnstageFilesPlan)['publication'],
  interruption: { readonly aborted: boolean; readonly reason: unknown },
): GitIndexRecoveryReadFailureDecision {
  if (interruption.aborted) return { kind: 'aborted', reason: interruption.reason }
  if (error instanceof NoEffectMutationError) {
    return publication === 'not-started'
      ? { kind: 'no-effect', reason: error.reason }
      : { kind: 'reconciliation', reason: 'evidence-conflict' }
  }
  if (error instanceof RetryableMutationError || isNodeSystemError(error)) {
    return { kind: 'retryable', reason: 'unavailable' }
  }
  return { kind: 'unexpected', error }
}

/**
 * Decide how cancellation handles one failed shared-index evidence read.
 * @param error - exact failure from the index evidence reader.
 * @param interruption - caller cancellation state observed at the catch boundary.
 * @returns the effect-free cancellation action for the engine to apply.
 * @internal
 */
export function decideCancelIndexEvidenceFailure(
  error: unknown,
  interruption: { readonly aborted: boolean; readonly reason: unknown },
): CancelIndexEvidenceFailureDecision {
  if (interruption.aborted) return { kind: 'aborted', reason: interruption.reason }
  if (error instanceof RetryableMutationError || error instanceof NoEffectMutationError) {
    return { kind: 'retain' }
  }
  return { kind: 'unexpected', error }
}

/**
 * Decide how cancellation handles one failed Commit target read.
 * @param error - exact failure from the target reader.
 * @param interruption - caller cancellation state observed at the catch boundary.
 * @returns the effect-free cancellation action for the engine to apply.
 * @internal
 */
export function decideCancelTargetReadFailure(
  error: unknown,
  interruption: { readonly aborted: boolean; readonly reason: unknown },
): CancelTargetReadFailureDecision {
  if (interruption.aborted) return { kind: 'aborted', reason: interruption.reason }
  if (error instanceof GitCommandError) return { kind: 'retain' }
  return { kind: 'unexpected', error }
}

/**
 * Classify a caught mutation failure before the engine performs recovery effects.
 * @param error - exact value caught at the mutation boundary.
 * @param interruption - caller cancellation state observed at the catch boundary.
 * @returns the effect-free error action for the engine to apply.
 * @internal
 */
export function classifyGitMutationError(
  error: unknown,
  interruption: { readonly aborted: boolean; readonly reason: unknown },
): GitMutationErrorDecision {
  if (interruption.aborted) return { kind: 'aborted', reason: interruption.reason }
  if (error instanceof RetryableMutationError) return { kind: 'retryable', reason: error.reason }
  if (error instanceof GitCommandError) return { kind: 'retryable', reason: 'unavailable' }
  if (error instanceof NoEffectMutationError) return { kind: 'no-effect', reason: error.reason }
  return { kind: 'unexpected', error }
}

/**
 * Decide how an owned-file observation handles one caught read failure.
 * @param error - exact failure from a Node path or file-handle operation.
 * @param interruption - caller cancellation state observed at the catch boundary.
 * @returns caller cancellation or the stable owned-file state.
 * @internal
 */
export function decideOwnedFileReadFailure(
  error: unknown,
  interruption: { readonly aborted: boolean; readonly reason: unknown },
): OwnedFileReadFailureDecision {
  if (interruption.aborted) return { kind: 'aborted', reason: interruption.reason }
  return { kind: 'state', state: isNodeError(error, 'ENOENT') ? 'missing' : 'unavailable' }
}

/**
 * Classify a failed exact symbolic-link target read.
 * @param error - value rejected by the Node adapter.
 * @param interruption - caller cancellation observed at the catch boundary.
 * @returns abort, retryable filesystem unavailability, or the original unexpected value.
 * @internal
 */
export function decideWorktreeSymlinkReadFailure(
  error: unknown,
  interruption: { readonly aborted: boolean; readonly reason: unknown },
): WorktreeSymlinkReadFailureDecision {
  if (interruption.aborted) return { kind: 'aborted', reason: interruption.reason }
  if (isNodeSystemError(error)) return { kind: 'retryable', reason: 'unavailable' }
  return { kind: 'unexpected', error }
}

/**
 * Reject one failed stable project selection with its mutation-domain reason.
 * @param reason - exact stable selection failure returned by inspection.
 * @returns never; every selection failure throws its classified mutation error.
 * @throws {NoEffectMutationError} when the failure proves an unsupported state or stale binding.
 * @throws {RetryableMutationError} when the selection is temporarily unavailable.
 * @internal
 */
export function rejectStableSelectionFailure(reason: StableLocalProjectSelectionFailureReason): never {
  switch (reason) {
    case 'unsupported-index-state':
      throw new NoEffectMutationError('unsupported-state')
    case 'missing':
    case 'not-directory':
    case 'not-git':
    case 'bare':
    case 'prunable':
      throw new NoEffectMutationError('binding-stale')
    case 'ambiguous':
    case 'malformed':
    case 'unavailable':
    case 'limit':
      throw new RetryableMutationError('unavailable')
  }
}

/**
 * Select the index update for one exact status and inventory row.
 * @param operation - requested StageFiles or UnstageFiles operation.
 * @param change - exact public status row selected by fingerprint.
 * @param entry - corresponding private raw-byte inventory row.
 * @returns a rejection, direct index update, or bounded worktree-hash request.
 * @internal
 */
export function decideGitIndexSelection(
  operation: 'stage-files' | 'unstage-files',
  change: ProjectGitChange,
  entry: CapturedRepositoryInventoryEntry,
): GitIndexSelectionDecision {
  if (operation === 'unstage-files') {
    if (change.kind === 'untracked' || change.kind === 'unmerged'
      || change.indexStatus === 'unchanged') {
      return { kind: 'reject', reason: 'invalid-selection' }
    }
    return entry.head === undefined
      ? { kind: 'remove' }
      : { kind: 'use-object', mode: entry.head.mode, objectId: entry.head.objectId }
  }
  if (change.kind === 'unmerged' || entry.conversion.executableFilter) {
    return { kind: 'reject', reason: 'unsupported-state' }
  }
  if (change.kind === 'ordinary' && change.worktreeStatus === 'unchanged') {
    return { kind: 'reject', reason: 'invalid-selection' }
  }
  if (entry.current.kind !== 'captured') return { kind: 'reject', reason: 'unsupported-state' }
  const evidence = entry.current.evidence
  if (evidence.kind === 'missing') return { kind: 'remove' }
  if (evidence.kind === 'submodule') {
    return { kind: 'use-object', mode: '160000', objectId: evidence.objectId }
  }
  if (entry.current.rawObjectId === undefined) return { kind: 'reject', reason: 'unsupported-state' }
  return {
    kind: 'hash-worktree',
    current: entry.current,
    evidence,
    expectedObjectId: entry.current.rawObjectId,
    mode: evidence.kind === 'regular' ? evidence.mode : '120000',
  }
}

/**
 * Classify one ordered owned-file checkpoint without reading or mutating the filesystem.
 * @param observation - metadata or digest captured at the current checkpoint.
 * @param evidence - durable identity, size, digest, and mode evidence.
 * @param maxBytes - maximum owned-file size the caller may read.
 * @returns a terminal ownership state or `continue` for the next checkpoint.
 * @internal
 */
export function classifyOwnedFileObservation(
  observation: Extract<OwnedFileObservation, { readonly kind: 'current' }>,
  evidence: LocalHostIndexPinEvidence,
  maxBytes: number,
): 'foreign' | 'owned' | 'owned-corrupt'
/**
 * Classify any ordered owned-file checkpoint without reading or mutating the filesystem.
 * @param observation - metadata or digest captured at the current checkpoint.
 * @param evidence - durable identity, size, digest, and mode evidence.
 * @param maxBytes - maximum owned-file size the caller may read.
 * @returns a terminal ownership state or `continue` for the next checkpoint.
 * @internal
 */
export function classifyOwnedFileObservation(
  observation: OwnedFileObservation,
  evidence: LocalHostIndexPinEvidence,
  maxBytes: number,
): OwnedFileObservationDecision
export function classifyOwnedFileObservation(
  observation: OwnedFileObservation,
  evidence: LocalHostIndexPinEvidence,
  maxBytes: number,
): OwnedFileObservationDecision {
  switch (observation.kind) {
    case 'path':
      return observation.stat.device !== evidence.identity.device
        || observation.stat.inode !== evidence.identity.inode ? 'foreign' : 'continue'
    case 'opened': {
      if (observation.opened.device !== evidence.identity.device
        || observation.opened.inode !== evidence.identity.inode) return 'unavailable'
      if (evidence.byteLength > maxBytes) return 'owned-corrupt'
      const expectedSize = BigInt(evidence.byteLength)
      return observation.path.kind !== 'file' || observation.opened.kind !== 'file'
        || observation.path.byteLength !== expectedSize || observation.opened.byteLength !== expectedSize
        || observation.path.mode !== evidence.mode || observation.opened.mode !== evidence.mode
        ? 'owned-corrupt'
        : 'continue'
    }
    case 'contents':
      return observation.digest === evidence.digest ? 'continue' : 'owned-corrupt'
    case 'post-read':
      return observation.after.device !== observation.before.device
        || observation.after.inode !== observation.before.inode
        || observation.after.byteLength !== observation.before.byteLength
        || observation.after.modifiedNanoseconds !== observation.before.modifiedNanoseconds
        || observation.after.changedNanoseconds !== observation.before.changedNanoseconds
        ? 'unavailable'
        : 'continue'
    case 'current':
      if (observation.current.device !== observation.before.device
        || observation.current.inode !== observation.before.inode) return 'foreign'
      return observation.current.kind === 'file'
        && observation.current.byteLength === observation.before.byteLength
        && observation.current.mode === evidence.mode ? 'owned' : 'owned-corrupt'
  }
}

/**
 * Classify one scratch owner marker after its bounded read.
 * @param observation - stable metadata and exact marker comparisons.
 * @returns `owned` only when every retained ownership fact still matches.
 * @internal
 */
export function classifyScratchMarkerConfirmation(
  observation: ScratchMarkerConfirmationObservation,
): 'foreign' | 'owned' {
  const { before, confirmed } = observation
  return confirmed.device === before.device
    && confirmed.inode === before.inode
    && confirmed.byteLength === before.byteLength
    && confirmed.modifiedNanoseconds === before.modifiedNanoseconds
    && confirmed.changedNanoseconds === before.changedNanoseconds
    && observation.digestMatches
    && observation.markerMatches
    ? 'owned'
    : 'foreign'
}

const LOOSE_OBJECT_FANOUT_NAME = /^[0-9a-f]{2}$/u
const SHA1_LOOSE_OBJECT_SUFFIX = /^[0-9a-f]{38}$/u
const SHA256_LOOSE_OBJECT_SUFFIX = /^[0-9a-f]{62}$/u

/**
 * Classify one already captured loose-object manifest observation.
 * @param observation - bounded name, count, or same-device topology evidence.
 * @returns `continue` when the observation remains inside the owned manifest, otherwise `unavailable`.
 * @internal
 */
function classifyOwnedLooseObjectManifestObservation(
  observation: OwnedLooseObjectManifestObservation,
): 'continue' | 'unavailable' {
  switch (observation.kind) {
    case 'root':
      return observation.directory && !observation.symlink ? 'continue' : 'unavailable'
    case 'root-entries':
      return observation.entryCount <= 257 && observation.hasInfo ? 'continue' : 'unavailable'
    case 'owned-directory':
      return observation.directory && !observation.symlink && observation.sameDevice
        ? 'continue'
        : 'unavailable'
    case 'fanout-name':
      return LOOSE_OBJECT_FANOUT_NAME.test(observation.name) ? 'continue' : 'unavailable'
    case 'object-count':
      return observation.candidateCount <= observation.maxObjectCount - observation.retainedCount
        ? 'continue'
        : 'unavailable'
    case 'object-suffix':
      return (observation.objectIdWidth === 40
        ? SHA1_LOOSE_OBJECT_SUFFIX
        : SHA256_LOOSE_OBJECT_SUFFIX).test(observation.suffix)
        ? 'continue'
        : 'unavailable'
    case 'owned-file':
      return observation.file && !observation.symlink && observation.sameDevice
        ? 'continue'
        : 'unavailable'
  }
}

/**
 * Require one captured loose-object manifest observation to remain owned and bounded.
 * @param observation - bounded name, count, or same-device topology evidence.
 * @throws {RetryableMutationError} when the observation cannot prove the scratch manifest remains owned.
 * @internal
 */
export function requireOwnedLooseObjectManifestObservation(
  observation: OwnedLooseObjectManifestObservation,
): void {
  if (classifyOwnedLooseObjectManifestObservation(observation) !== 'continue') {
    throw new RetryableMutationError('unavailable')
  }
}

/**
 * Advance one accepted or recoverable operation without inventing a second effect.
 * @param dependencies - Local Host observation and Git execution dependencies.
 * @param initial - current durable operation record.
 * @param persist - durable replacement callback.
 * @param signal - current attempt lifetime; cancellation is never persisted.
 * @returns terminal/recovered state or a retryable non-terminal state.
 */
export async function advanceLocalGitMutation(
  dependencies: LocalGitMutationDependencies,
  initial: LocalHostOperationRecord,
  persist: PersistLocalHostOperation,
  signal: AbortSignal,
): Promise<LocalGitMutationAdvanceResult> {
  signal.throwIfAborted()
  let record = initial
  if (isTerminal(record.snapshot)) {
    await cleanupTerminalGitMutation(dependencies, record)
    return { kind: 'advanced', record }
  }
  if (record.snapshot.state === 'publishing') {
    return await recoverPublishingOperation(dependencies, record, persist, signal, true)
  }
  if (record.snapshot.state === 'accepted') {
    record = transitionToPlanning(record, record.snapshot)
    await persist(record)
  }
  /* v8 ignore next -- the provider admits prepared records and routes publishing/terminal records above. */
  if (record.snapshot.state !== 'planning') {
    return { kind: 'retryable', reason: 'unavailable', record }
  }

  try {
    const prepared = record.request.type === 'commit'
      ? await prepareCommitPublication(dependencies, record, signal)
      : await prepareIndexPublication(dependencies, record, record.request, signal)
    await requirePreparedMutationActive(signal, prepared.discard)
    record = transitionToPublishing(record, record.snapshot, prepared.plan)
    try {
      await persist(record)
    } catch (error) {
      await cleanupBeforeRethrow(
        signal,
        dependencies.isOperationDurable(record) ? prepared.release : prepared.discard,
      )
      throw error
    }
    try {
      await prepared.prepareAttempt()
      signal.throwIfAborted()
    } catch (error) {
      await cleanupBeforeRethrow(signal, prepared.release)
      throw error
    }
    record = withPublication(record, prepared.plan, 'attempting')
    try {
      await persist(record)
    } catch (error) {
      await cleanupBeforeRethrow(signal, prepared.release)
      throw error
    }
    try {
      await prepared.publish()
    } catch {
      await cleanupBeforeRethrow(signal, prepared.release)
      signal.throwIfAborted()
    }
    return await recoverPublishingOperation(dependencies, record, persist, signal, true)
  } catch (error) {
    return await mapGitMutationError(dependencies, record, persist, signal, error)
  }
}

/**
 * Recover from Git evidence, resuming a proven not-started plan only when allowed.
 * Historical detached Commit plans never create or replay an effect.
 * @param dependencies - Local Host Git execution dependencies.
 * @param initial - durable publishing record.
 * @param persist - durable replacement callback.
 * @param signal - inspection lifetime.
 * @param allowResume - whether a caller-authorized start may resume a proven not-started plan.
 * @returns recovered terminal state or a retryable not-started state.
 */
export async function recoverPublishingOperation(
  dependencies: LocalGitMutationDependencies,
  initial: LocalHostOperationRecord,
  persist: PersistLocalHostOperation,
  signal: AbortSignal,
  allowResume = false,
): Promise<LocalGitMutationAdvanceResult> {
  const plan = initial.effectPlan
  /* v8 ignore next -- durable schema validation requires every publishing record to carry an effect plan. */
  if (initial.snapshot.state !== 'publishing' || plan === undefined) {
    return { kind: 'retryable', reason: 'unavailable', record: initial }
  }
  if (plan.kind === 'commit') {
    return await recoverCommitPublication(dependencies, initial, plan, persist, signal, allowResume)
  }
  const indexPath = boundIndexPath(initial)
  let actual: LocalHostIndexFileEvidence
  try {
    actual = await readIndexEvidence(
      mutationNodeAdapter(dependencies),
      indexPath,
      plan.indexReadLimit,
      signal,
    )
  } catch (error) {
    const decision = decideGitIndexRecoveryReadFailure(
      error,
      plan.publication,
      { aborted: signal.aborted, reason: signal.reason },
    )
    switch (decision.kind) {
      case 'aborted':
        throw decision.reason
      case 'retryable':
        return { kind: 'retryable', reason: decision.reason, record: initial }
      case 'no-effect': {
        return await finalizeGitRecoveryDecision(dependencies, initial, persist, decision)
      }
      case 'reconciliation': {
        return await finalizeGitRecoveryDecision(dependencies, initial, persist, decision)
      }
      case 'unexpected':
        throw decision.error
    }
  }
  const decision = decideGitPublicationRecovery({
    kind: 'index',
    actual,
    expected: plan.expectedIndexFile,
    target: plan.targetIndexFile,
    publication: plan.publication,
    allowResume,
  })
  switch (decision.kind) {
    case 'succeeded': {
      const succeeded = transitionToSuccess(initial, plan)
      await persistTerminalOperation(dependencies, succeeded, persist)
      return { kind: 'advanced', record: succeeded }
    }
    case 'resume':
      return await resumeNotStartedIndexPublication(dependencies, initial, plan, persist, signal)
    case 'retryable':
      return { kind: 'retryable', reason: decision.reason, record: initial }
    case 'no-effect': {
      return await finalizeGitRecoveryDecision(dependencies, initial, persist, decision)
    }
    case 'reconciliation': {
      return await finalizeGitRecoveryDecision(dependencies, initial, persist, decision)
    }
  }
}

async function finalizeGitRecoveryDecision(
  dependencies: LocalGitMutationDependencies,
  record: LocalHostOperationRecord,
  persist: PersistLocalHostOperation,
  decision:
    | { readonly kind: 'no-effect'; readonly reason: HostOperationFailure['reason'] }
    | { readonly kind: 'reconciliation'; readonly reason: 'effect-unknown' | 'evidence-conflict' },
): Promise<LocalGitMutationAdvanceResult> {
  if (decision.kind === 'no-effect') {
    const failed = await persistNoEffectFailure(dependencies, record, persist, decision.reason)
    return { kind: 'advanced', record: failed }
  }
  const reconciled = transitionToReconciliation(record, decision.reason)
  await persistTerminalOperation(dependencies, reconciled, persist)
  return { kind: 'advanced', record: reconciled }
}

/**
 * Cancel one publishing operation only after evidence proves that no semantic
 * effect was published.
 * @param dependencies - Local Host Git execution dependencies.
 * @param initial - current durable publishing record.
 * @param reason - durable control-plane cancellation reason.
 * @param persist - durable replacement callback.
 * @param signal - cancellation inspection lifetime.
 * @returns recovered terminal state or the unchanged publishing state.
 */
export async function cancelPublishingOperation(
  dependencies: LocalGitMutationDependencies,
  initial: LocalHostOperationRecord,
  reason: HostOperationCancellationReason,
  persist: PersistLocalHostOperation,
  signal: AbortSignal,
): Promise<LocalHostOperationRecord> {
  const recovered = await recoverPublishingOperation(dependencies, initial, persist, signal)
  if (recovered.record.snapshot.state !== 'publishing') return recovered.record
  const plan = recovered.record.effectPlan
  if (plan?.kind === 'commit') {
    if (plan.publication !== 'not-started') return recovered.record
    let current: string | undefined
    try {
      current = await readCurrentTarget(dependencies.git, recovered.record, plan.targetRef, signal)
    } catch (error) {
      const decision = decideCancelTargetReadFailure(
        error,
        { aborted: signal.aborted, reason: signal.reason },
      )
      switch (decision.kind) {
        case 'aborted': throw decision.reason
        case 'retain': return recovered.record
        case 'unexpected': throw decision.error
      }
    }
    if (current !== expectedCommitTargetObjectId(plan.expectedOldObjectId)) return recovered.record
    const canceled = transitionToCancellation(recovered.record, reason)
    await persistTerminalOperation(dependencies, canceled, persist)
    return canceled
  }
  /* v8 ignore next -- publishing schema requires a plan; Commit returned above, so the remaining plan is Index. */
  if (plan?.kind !== 'index') return recovered.record
  if (plan.publication !== 'not-started') return recovered.record
  let actual: LocalHostIndexFileEvidence
  try {
    actual = await readIndexEvidence(
      mutationNodeAdapter(dependencies),
      boundIndexPath(recovered.record),
      plan.indexReadLimit,
      signal,
    )
  } catch (error) {
    const decision = decideCancelIndexEvidenceFailure(
      error,
      { aborted: signal.aborted, reason: signal.reason },
    )
    switch (decision.kind) {
      case 'aborted': throw decision.reason
      case 'retain': return recovered.record
      case 'unexpected': throw decision.error
    }
  }
  if (!sameIndexEvidence(actual, plan.expectedIndexFile)) return recovered.record
  const canceled = transitionToCancellation(
    { ...recovered.record, effectPlan: { ...plan, publication: 'not-started' } },
    reason,
  )
  await persistTerminalOperation(dependencies, canceled, persist)
  return canceled
}

async function recoverCommitPublication(
  dependencies: LocalGitMutationDependencies,
  record: LocalHostOperationRecord,
  plan: LocalHostCommitPlan,
  persist: PersistLocalHostOperation,
  signal: AbortSignal,
  allowResume: boolean,
): Promise<LocalGitMutationAdvanceResult> {
  let current: string | undefined
  try {
    current = await readCurrentTarget(dependencies.git, record, plan.targetRef, signal)
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof GitCommandError) {
      return { kind: 'retryable', reason: 'unavailable', record }
    }
    throw error
  }
  const expectedHead = record.request.expected.head
  const detachedExpectedHead = expectedHead.kind === 'commit' && expectedHead.symbolicRef === undefined
  const reflog = plan.publication === 'not-started'
      || current === plan.result.commitId && !detachedExpectedHead
    ? 'absent'
    : await inspectCommitReflog(dependencies, record, plan, signal)
  const decision = decideGitPublicationRecovery({
    kind: 'commit',
    current,
    expectedOldObjectId: plan.expectedOldObjectId,
    resultCommitId: plan.result.commitId,
    publication: plan.publication,
    reflog,
    allowResume,
    detachedExpectedHead,
  })
  switch (decision.kind) {
    case 'succeeded': {
      try {
        await durabilizeCommitPublication(dependencies, record, plan, signal)
      } catch (error) {
        signal.throwIfAborted()
        if (error instanceof RetryableMutationError) {
          return { kind: 'retryable', reason: error.reason, record }
        }
        throw error
      }
      const succeeded = transitionToSuccess(record, plan)
      await persistTerminalOperation(dependencies, succeeded, persist)
      return { kind: 'advanced', record: succeeded }
    }
    case 'resume':
      return await resumeNotStartedCommitPublication(dependencies, record, plan, persist, signal)
    case 'retryable':
      return { kind: 'retryable', reason: decision.reason, record }
    case 'no-effect':
      return {
        kind: 'advanced',
        record: await persistNoEffectFailure(dependencies, record, persist, decision.reason),
      }
    case 'reconciliation': {
      const reconciled = transitionToReconciliation(record, decision.reason)
      await persistTerminalOperation(dependencies, reconciled, persist)
      return { kind: 'advanced', record: reconciled }
    }
  }
}

async function readCurrentTarget(
  git: GitRunner,
  record: LocalHostOperationRecord,
  targetRef: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await git.run(
      boundWorktree(record),
      ['rev-parse', '--verify', '--end-of-options', targetRef],
      signal,
    )
    signal.throwIfAborted()
    return parseObjectId(stdout, stderr, record)
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof GitCommandError && error.code === 'nonzero'
      && (error.exitCode === 1 || error.exitCode === 128)) return undefined
    throw error
  }
}

function expectedCommitTargetObjectId(expectedOldObjectId: string): string | undefined {
  return /^0+$/u.test(expectedOldObjectId) ? undefined : expectedOldObjectId
}

type CommitReflogInspection = 'found' | 'absent' | 'limit' | 'unavailable'

async function inspectCommitReflog(
  dependencies: LocalGitMutationDependencies,
  record: LocalHostOperationRecord,
  plan: LocalHostCommitPlan,
  signal: AbortSignal,
  expectedIdentity?: BigIntStats,
): Promise<CommitReflogInspection> {
  signal.throwIfAborted()
  const path = commitReflogPath(record, plan)
  const node = mutationNodeAdapter(dependencies)
  const maxBytes = plan.reflogReadLimit
  let pathBefore: BigIntStats
  try {
    pathBefore = await node.lstat(path)
  } catch (error) {
    signal.throwIfAborted()
    return isNodeError(error, 'ENOENT') ? 'absent' : 'unavailable'
  }
  signal.throwIfAborted()
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) return 'unavailable'
  if (expectedIdentity !== undefined && !sameReflogFile(expectedIdentity, pathBefore)) return 'unavailable'
  if (pathBefore.size > BigInt(maxBytes)) return 'limit'
  let handle: LocalGitMutationFileHandle | undefined
  let inspection: CommitReflogInspection
  try {
    handle = await node.open(path, 'r')
    const openedBefore = await handle.stat()
    signal.throwIfAborted()
    if (openedBefore.isFile() && !openedBefore.isSymbolicLink()
      && openedBefore.size > BigInt(maxBytes)) {
      inspection = 'limit'
    } else if (!sameReflogFile(pathBefore, openedBefore)) {
      inspection = 'unavailable'
    } else {
      const bytes = await readExactReflogHandle(handle, Number(openedBefore.size), maxBytes, signal)
      const openedAfter = await handle.stat()
      const pathAfter = await node.lstat(path)
      signal.throwIfAborted()
      if (openedAfter.size > BigInt(maxBytes) || pathAfter.size > BigInt(maxBytes)) {
        inspection = 'limit'
      } else if (bytes === undefined
        || !sameReflogFile(openedBefore, openedAfter)
        || !sameReflogFile(openedAfter, pathAfter)) {
        inspection = 'unavailable'
      } else {
        inspection = findCommitReflogEntry(bytes, plan)
      }
    }
  } catch (_error) {
    inspection = 'unavailable'
  } finally {
    await handle?.close().catch(() => undefined)
  }
  signal.throwIfAborted()
  return inspection
}

function sameReflogFile(left: BigIntStats, right: BigIntStats): boolean {
  return right.isFile() && !right.isSymbolicLink()
    && right.dev === left.dev
    && right.ino === left.ino
    && right.size === left.size
    && right.mtimeNs === left.mtimeNs
    && right.ctimeNs === left.ctimeNs
}

async function readExactReflogHandle(
  handle: LocalGitMutationFileHandle,
  byteLength: number,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer | undefined> {
  signal.throwIfAborted()
  /* v8 ignore next -- fstat and the configured Buffer-safe reflog limit bound this private caller's byte length. */
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > maxBytes) return undefined
  const bytes = Buffer.alloc(byteLength)
  let offset = 0
  while (offset < byteLength) {
    const read = await handle.read(bytes, offset, byteLength - offset, offset)
    signal.throwIfAborted()
    if (read.bytesRead === 0) return undefined
    offset += read.bytesRead
  }
  return bytes
}

function findCommitReflogEntry(bytes: Buffer, plan: LocalHostCommitPlan): CommitReflogInspection {
  const prefix = Buffer.from(`${plan.expectedOldObjectId} ${plan.result.commitId} `, 'ascii')
  const suffix = Buffer.from(`\t${plan.reflogMarker}`, 'utf8')
  let start = 0
  while (start < bytes.byteLength) {
    const end = bytes.indexOf(0x0a, start)
    if (end < 0) return 'unavailable'
    const line = bytes.subarray(start, end)
    if (line.subarray(0, prefix.byteLength).equals(prefix)
      && line.subarray(Math.max(0, line.byteLength - suffix.byteLength)).equals(suffix)) return 'found'
    start = end + 1
  }
  return 'absent'
}

function commitReflogPath(record: LocalHostOperationRecord, plan: LocalHostCommitPlan): string {
  const trusted = record.request.expected.binding.expectedInspection.trusted
  return resolveCommitReflogPath(
    trusted.canonicalGitDirectory,
    trusted.canonicalCommonGitDirectory,
    plan.targetRef,
  )
}

/**
 * Resolve one durable Commit target to its repository-owned reflog path.
 * @param canonicalGitDirectory - canonical worktree-specific Git directory.
 * @param canonicalCommonGitDirectory - canonical common Git directory.
 * @param targetRef - exact durable Commit publication target.
 * @returns the target reflog path within the owning Git directory.
 * @throws {Error} when a non-HEAD target is empty, absolute, or does not resolve strictly within the common reflog directory.
 * @internal
 */
export function resolveCommitReflogPath(
  canonicalGitDirectory: string,
  canonicalCommonGitDirectory: string,
  targetRef: string,
): string {
  if (targetRef === 'HEAD') return join(canonicalGitDirectory, 'logs', 'HEAD')
  if (targetRef === '' || isAbsolute(targetRef)) throw new Error('unsafe durable Commit reflog target')
  const logsRoot = resolve(canonicalCommonGitDirectory, 'logs')
  const target = resolve(logsRoot, ...targetRef.split('/'))
  const within = relative(logsRoot, target)
  if (within === '' || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    throw new Error('unsafe durable Commit reflog target')
  }
  return target
}

async function resumeNotStartedCommitPublication(
  dependencies: LocalGitMutationDependencies,
  record: LocalHostOperationRecord,
  plan: LocalHostCommitPlan,
  persist: PersistLocalHostOperation,
  signal: AbortSignal,
): Promise<LocalGitMutationAdvanceResult> {
  if (!await scratchRuntimeOwnershipMatches(
    mutationNodeAdapter(dependencies),
    plan.scratch,
    record,
    signal,
  )) {
    return { kind: 'retryable', reason: 'unavailable', record }
  }
  let latest = record
  try {
    assertCommitHasStagedChange(await observeAndValidate(dependencies, record, signal))
    if (!await indexPinMatches(
      record,
      plan.pin,
      plan.indexReadLimit,
      signal,
      mutationNodeAdapter(dependencies),
    )) {
      return { kind: 'retryable', reason: 'unavailable', record }
    }
    const privateCommitId = await createCommitObject(
      dependencies,
      record,
      plan.scratch,
      plan.result.committer,
      true,
      signal,
    )
    if (privateCommitId !== plan.result.commitId) {
      throw new NoEffectMutationError('unsupported-state')
    }
    await prepareCommitAttempt(dependencies, record, plan, signal)
    signal.throwIfAborted()
    const next = withPublication(record, plan, 'attempting')
    await persist(next)
    latest = next
    try {
      await publishCommitPlan(dependencies, next, next.effectPlan as LocalHostCommitPlan, signal)
    } catch {
      await cleanupBeforeRethrow(
        signal,
        async () => { await removeCommitLocks(dependencies, next, next.effectPlan as LocalHostCommitPlan) },
      )
      signal.throwIfAborted()
    }
    return await recoverPublishingOperation(dependencies, next, persist, signal, true)
  } catch (error) {
    await cleanupBeforeRethrow(
      signal,
      async () => {
        await removeOwnedIndexLock(
          record,
          plan.pin,
          plan.indexReadLimit,
          mutationNodeAdapter(dependencies),
        )
      },
    )
    const decision = classifyGitMutationError(
      error,
      { aborted: signal.aborted, reason: signal.reason },
    )
    switch (decision.kind) {
      /* v8 ignore next 2 -- cleanupBeforeRethrow returns only while this monotonic signal remains un-aborted. */
      case 'aborted':
        throw decision.reason
      case 'retryable':
        return { kind: 'retryable', reason: decision.reason, record: latest }
      case 'no-effect': {
        const failed = await persistNoEffectFailure(dependencies, latest, persist, decision.reason)
        return { kind: 'advanced', record: failed }
      }
      case 'unexpected':
        throw decision.error
    }
  }
}

async function commitLocksMatch(
  record: LocalHostOperationRecord,
  plan: LocalHostCommitPlan,
  maxBytes: number,
  signal: AbortSignal,
  node: LocalGitMutationNodeAdapter,
): Promise<boolean> {
  return await indexPinAndLockMatch(record, plan.pin, maxBytes, signal, node)
}

/**
 * Retry idempotent cleanup for resources that cannot block Git after a
 * semantic terminal record is durable.
 * @param dependencies - Local Host operation dependencies and configured bounds.
 * @param record - durable terminal operation record.
 */
export async function cleanupTerminalGitMutation(
  dependencies: LocalGitMutationDependencies,
  record: LocalHostOperationRecord,
): Promise<void> {
  if (!isTerminal(record.snapshot) || record.effectPlan === undefined) return
  await Promise.allSettled([
    removeOwnedIndexPin(
      record,
      record.effectPlan.pin,
      record.effectPlan.indexReadLimit,
      mutationNodeAdapter(dependencies),
    ),
    removeOwnedScratch(mutationNodeAdapter(dependencies), record.effectPlan.scratch, record),
  ])
}

async function removeCommitLocks(
  dependencies: LocalGitMutationDependencies,
  record: LocalHostOperationRecord,
  plan: LocalHostCommitPlan,
): Promise<void> {
  await removeOwnedIndexLock(
    record,
    plan.pin,
    plan.indexReadLimit,
    mutationNodeAdapter(dependencies),
  )
}

interface StableMutationObservation {
  readonly inventory: CapturedRepositoryInventory
  readonly status: ProjectGitStatusObservation
}

interface PreparedCommitPublication {
  readonly plan: LocalHostCommitPlan
  readonly prepareAttempt: () => Promise<void>
  readonly publish: () => Promise<void>
  readonly release: () => Promise<void>
  readonly discard: () => Promise<void>
}

interface PreparedIndexPublication {
  readonly plan: LocalHostStageFilesPlan | LocalHostUnstageFilesPlan
  readonly prepareAttempt: () => Promise<void>
  readonly publish: () => Promise<void>
  readonly release: () => Promise<void>
  readonly discard: () => Promise<void>
}

interface PreparedIndexPinReference {
  value?: LocalHostIndexPinEvidence
}

function preparedIndexLockRelease(
  dependencies: LocalGitMutationDependencies,
  record: LocalHostOperationRecord,
  pin: PreparedIndexPinReference,
  indexReadLimit: number,
): () => Promise<void> {
  return async () => {
    if (pin.value !== undefined) {
      await removeOwnedIndexLock(
        record,
        pin.value,
        indexReadLimit,
        mutationNodeAdapter(dependencies),
      )
    }
  }
}

async function prepareCommitPublication(
  dependencies: LocalGitMutationDependencies,
  record: LocalHostOperationRecord,
  signal: AbortSignal,
): Promise<PreparedCommitPublication> {
  assertAttachedCommit(record)
  const indexReadLimit = dependencies.config.operationMaxIndexBytes
  const reflogReadLimit = dependencies.config.operationMaxReflogBytes
  assertCommitHasStagedChange(await observeAndValidate(dependencies, record, signal))
  const scratch = await createOwnedGitScratch(mutationNodeAdapter(dependencies), record, signal)
  const indexMarker = operationLockMarker(record)
  const head = record.request.expected.head
  const symbolicRef = head.symbolicRef
  let signature: ProjectGitCommitSignature
  let expectedOldObjectId: string
  let parent: LocalHostCommitPlan['result']['parent']
  let commitId: string
  let pin: LocalHostIndexPinEvidence
  const pinReference: PreparedIndexPinReference = {}
  const release = preparedIndexLockRelease(dependencies, record, pinReference, indexReadLimit)
  const discard = async (): Promise<void> => {
    const cleanup = [
      release(),
      removeOwnedScratch(mutationNodeAdapter(dependencies), scratch, record),
    ]
    if (pinReference.value !== undefined) {
      cleanup.push(removeOwnedIndexPin(
        record,
        pinReference.value,
        indexReadLimit,
        mutationNodeAdapter(dependencies),
      ))
    }
    const results = await Promise.allSettled(cleanup)
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (rejected !== undefined) throw rejected.reason
  }
  try {
    await assertIndexLockAvailable(`${boundIndexPath(record)}.lock`, mutationNodeAdapter(dependencies))
    const stable = await observeAndValidate(dependencies, record, signal)
    assertCommitHasStagedChange(stable)
    const commitIndexBytes = await readFileBounded(
      mutationNodeAdapter(dependencies),
      boundIndexPath(record),
      indexReadLimit,
      signal,
    )
    const commitIndex = await requireOperationScratchRuntimePaths(
      mutationNodeAdapter(dependencies),
      scratch,
      record,
      signal,
    )
    await writePrivateFile(commitIndex.commitIndexPath, commitIndexBytes)
    signature = await readCommitSignature(dependencies, record, scratch, signal)
    const objectWidth = objectIdWidth(record)
    expectedOldObjectId = head.kind === 'unborn' ? '0'.repeat(objectWidth) : head.objectId
    parent = head.kind === 'unborn'
      ? { kind: 'none' as const }
      : { kind: 'commit' as const, objectId: head.objectId }
    commitId = await createCommitObject(
      dependencies,
      record,
      scratch,
      signature,
      true,
      signal,
    )
    await observeAndValidate(dependencies, record, signal)
    pin = await createIndexPin(mutationNodeAdapter(dependencies), record, indexMarker, undefined)
    pinReference.value = pin
    await durabilizeOwnedGitScratch(
      mutationNodeAdapter(dependencies),
      scratch,
      record,
      ownedLooseObjectCountLimit(stable.inventory, 1),
      signal,
    )
  } catch (error) {
    await cleanupBeforeRethrow(signal, discard)
    throw error
  }
  const plan: LocalHostCommitPlan = {
    kind: 'commit',
    scratch,
    indexReadLimit,
    reflogReadLimit,
    publication: 'not-started',
    targetRef: symbolicRef,
    expectedOldObjectId,
    reflogMarker: `saki host-operation ${record.snapshot.operation.id}`,
    pin,
    result: {
      type: 'commit',
      commitId,
      treeId: record.request.expected.index.treeId,
      parent,
      target: { kind: 'symbolic-ref', ref: symbolicRef },
      author: signature,
      committer: signature,
    },
  }
  return {
    plan,
    prepareAttempt: async () => {
      await prepareCommitAttempt(dependencies, record, plan, signal)
    },
    publish: async () => {
      try {
        await publishCommitPlan(dependencies, record, plan, signal)
      } catch (error) {
        await cleanupBeforeRethrow(signal, release)
        throw error
      }
      await release()
    },
    release,
    discard,
  }
}

function assertCommitHasStagedChange(observation: StableMutationObservation): void {
  if (!observation.status.changes.some(change => change.kind === 'ordinary'
    && change.indexStatus !== 'unchanged')) {
    throw new NoEffectMutationError('unsupported-state')
  }
}

function assertAttachedCommit(
  record: LocalHostOperationRecord,
): asserts record is LocalHostOperationRecord & {
  readonly request: AttachedCommitRequest
} {
  const head = record.request.expected.head
  if (record.request.type !== 'commit'
    || head.kind === 'commit' && head.symbolicRef === undefined) {
    throw new NoEffectMutationError('unsupported-state')
  }
}

async function readCommitSignature(
  dependencies: LocalGitMutationDependencies,
  record: LocalHostOperationRecord,
  scratch: LocalHostOperationScratch,
  signal: AbortSignal,
): Promise<ProjectGitCommitSignature> {
  const cwd = boundWorktree(record)
  const name = await readLocalGitConfigValue(dependencies.git, cwd, 'user.name', signal)
  const email = await readLocalGitConfigValue(dependencies.git, cwd, 'user.email', signal)
  if (name === undefined || email === undefined || !validCommitIdentity(name) || !validCommitIdentity(email)) {
    throw new NoEffectMutationError('unsupported-state')
  }
  const now = Date.now()
  const timestamp = Math.floor(now / 1_000)
  const timezone = formatGitTimezone(-new Date(now).getTimezoneOffset())
  const paths = await requireOperationScratchRuntimePaths(
    mutationNodeAdapter(dependencies),
    scratch,
    record,
    signal,
  )
  let output: Awaited<ReturnType<GitRunner['runMutation']>>
  try {
    output = await dependencies.git.runMutation(
      cwd,
      ['var', 'GIT_AUTHOR_IDENT'],
      signal,
      {
        hooksDirectory: paths.hooksDirectory,
        author: { name, email, date: `${timestamp} ${timezone}` },
      },
    )
  } catch (error) {
    if (error instanceof GitCommandError && error.code === 'nonzero') {
      throw new NoEffectMutationError('unsupported-state')
    }
    throw error
  }
  return parseCanonicalCommitIdentity(output.stdout, output.stderr, timestamp, timezone)
}

async function readLocalGitConfigValue(
  git: GitRunner,
  cwd: string,
  key: 'user.name' | 'user.email',
  signal: AbortSignal,
): Promise<string | undefined> {
  for (const scope of ['--worktree', '--local'] as const) {
    let output: Awaited<ReturnType<GitRunner['run']>>
    try {
      output = await git.run(
        cwd,
        ['config', '--no-includes', scope, '--get', key],
        signal,
      )
    } catch (error) {
      if (error instanceof GitCommandError && error.code === 'nonzero' && error.exitCode === 1) continue
      throw error
    }
    return parseLocalGitConfigValue(output.stdout, output.stderr)
  }
  return undefined
}

/**
 * Parse one repository-local Git config query result.
 * @param stdout - bounded raw standard output bytes.
 * @param stderr - bounded raw standard error bytes.
 * @returns the exact value from one newline-terminated output line.
 * @throws {GitCommandError} when standard error is nonempty.
 * @throws {NoEffectMutationError} when standard output is invalid UTF-8 or not exactly one newline-terminated line.
 * @internal
 */
export function parseLocalGitConfigValue(stdout: Uint8Array, stderr: Uint8Array): string {
  if (stderr.byteLength !== 0) throw new GitCommandError('stream-failure')
  let text: string
  try {
    text = UTF8.decode(stdout)
  } catch {
    throw new NoEffectMutationError('unsupported-state')
  }
  const match = /^([^\r\n]*)\r?\n$/u.exec(text)
  if (match?.[1] === undefined) throw new NoEffectMutationError('unsupported-state')
  return match[1]
}

function validCommitIdentity(value: string): boolean {
  return value.length > 0 && value.length <= 1_024 && !/[\0\r\n]/u.test(value)
}

/**
 * Parse the exact identity canonicalized by Git for a frozen author date.
 * @param stdout - bounded `git var GIT_AUTHOR_IDENT` standard output.
 * @param stderr - bounded standard error, which must remain empty.
 * @param timestamp - frozen seconds since the Unix epoch supplied to Git.
 * @param timezone - frozen numeric timezone supplied to Git.
 * @returns canonical nonempty name and email evidence for both Commit roles.
 * @throws {GitCommandError} when standard error is nonempty.
 * @throws {NoEffectMutationError} when Git returns malformed or inconsistent identity evidence.
 * @internal
 */
export function parseCanonicalCommitIdentity(
  stdout: Uint8Array,
  stderr: Uint8Array,
  timestamp: number,
  timezone: string,
): ProjectGitCommitSignature {
  if (stderr.byteLength !== 0) throw new GitCommandError('stream-failure')
  let text: string
  try {
    text = UTF8.decode(stdout)
  } catch {
    throw new NoEffectMutationError('unsupported-state')
  }
  const match = /^(.+) <([^<>]+)> ([0-9]+) ([+-][0-9]{4})\r?\n$/u.exec(text)
  if (match?.[1] === undefined || match[2] === undefined
    || match[3] !== String(timestamp) || match[4] !== timezone
    || !validCommitIdentity(match[1]) || !validCommitIdentity(match[2])) {
    throw new NoEffectMutationError('unsupported-state')
  }
  return {
    name: match[1],
    email: match[2],
    timestamp,
    timezone,
    source: 'git-config',
  }
}

/**
 * Format one safe UTC offset for Git commit identity fields.
 * @param offsetMinutes - signed minutes east of UTC.
 * @returns Git's signed four-digit timezone form.
 * @throws {NoEffectMutationError} when the offset is not a safe integer or its absolute hour component exceeds 14.
 * @internal
 */
export function formatGitTimezone(offsetMinutes: number): string {
  const absolute = Math.abs(offsetMinutes)
  const hours = Math.floor(absolute / 60)
  const minutes = absolute % 60
  if (!Number.isSafeInteger(offsetMinutes) || hours > 14) {
    throw new NoEffectMutationError('unsupported-state')
  }
  return `${offsetMinutes < 0 ? '-' : '+'}${String(hours).padStart(2, '0')}${String(minutes).padStart(2, '0')}`
}

async function writeCommitTreeObject(
  dependencies: LocalGitMutationDependencies,
  record: LocalHostOperationRecord,
  scratch: LocalHostOperationScratch,
  usePrivateObjectDirectory: boolean,
  signal: AbortSignal,
): Promise<void> {
  const paths = await requireOperationScratchRuntimePaths(
    mutationNodeAdapter(dependencies),
    scratch,
    record,
    signal,
  )
  const { stdout, stderr } = await dependencies.git.runMutation(
    boundWorktree(record),
    ['write-tree'],
    signal,
    {
      hooksDirectory: paths.hooksDirectory,
      indexFile: paths.commitIndexPath,
      ...(usePrivateObjectDirectory ? { objectDirectory: paths.objectDirectory } : {}),
    },
  )
  if (parseObjectId(stdout, stderr, record) !== record.request.expected.index.treeId) {
    throw new NoEffectMutationError('observation-stale')
  }
}

async function createCommitObject(
  dependencies: LocalGitMutationDependencies,
  record: LocalHostOperationRecord,
  scratch: LocalHostOperationScratch,
  signature: ProjectGitCommitSignature,
  usePrivateObjectDirectory: boolean,
  signal: AbortSignal,
): Promise<string> {
  assertAttachedCommit(record)
  await writeCommitTreeObject(
    dependencies,
    record,
    scratch,
    usePrivateObjectDirectory,
    signal,
  )
  const parentArguments = record.request.expected.head.kind === 'commit'
    ? ['-p', record.request.expected.head.objectId]
    : []
  const message = Buffer.from(record.request.message, 'utf8')
  const gitDate = `${signature.timestamp} ${signature.timezone}`
  const paths = await requireOperationScratchRuntimePaths(
    mutationNodeAdapter(dependencies),
    scratch,
    record,
    signal,
  )
  const { stdout, stderr } = await dependencies.git.runMutation(
    boundWorktree(record),
    ['commit-tree', record.request.expected.index.treeId, ...parentArguments, '-F', '-'],
    signal,
    {
      hooksDirectory: paths.hooksDirectory,
      indexFile: paths.commitIndexPath,
      ...(usePrivateObjectDirectory ? { objectDirectory: paths.objectDirectory } : {}),
      author: { name: signature.name, email: signature.email, date: gitDate },
      committer: { name: signature.name, email: signature.email, date: gitDate },
    },
    { bytes: message, maxBytes: Math.max(1, message.byteLength) },
  )
  return parseObjectId(stdout, stderr, record)
}

async function publishCommitPlan(
  dependencies: LocalGitMutationDependencies,
  record: LocalHostOperationRecord,
  plan: LocalHostCommitPlan,
  signal: AbortSignal,
): Promise<void> {
  assertAttachedCommit(record)
  if (!await commitLocksMatch(
    record,
    plan,
    plan.indexReadLimit,
    signal,
    mutationNodeAdapter(dependencies),
  )) {
    throw new RetryableMutationError('busy')
  }
  const paths = await requireOperationScratchRuntimePaths(
    mutationNodeAdapter(dependencies),
    plan.scratch,
    record,
    signal,
  )
  const { stdout, stderr } = await dependencies.git.runMutation(
    boundWorktree(record),
    [
      'update-ref',
      '--no-deref',
      '--create-reflog',
      '-m',
      plan.reflogMarker,
      plan.targetRef,
      plan.result.commitId,
      plan.expectedOldObjectId,
    ],
    signal,
    {
      hooksDirectory: paths.hooksDirectory,
      committer: {
        name: plan.result.committer.name,
        email: plan.result.committer.email,
        date: `${plan.result.committer.timestamp} ${plan.result.committer.timezone}`,
      },
    },
  )
  if (stdout.byteLength !== 0 || stderr.byteLength !== 0) throw new GitCommandError('stream-failure')
  await durabilizeCommitPublication(dependencies, record, plan, signal)
}

async function durabilizeCommitPublication(
  dependencies: LocalGitMutationDependencies,
  record: LocalHostOperationRecord,
  plan: LocalHostCommitPlan,
  signal: AbortSignal,
): Promise<void> {
  const node = mutationNodeAdapter(dependencies)
  const trusted = record.request.expected.binding.expectedInspection.trusted
  const commonGitDirectory = trusted.canonicalCommonGitDirectory
  const refPath = resolveCommitRefPath(
    trusted.canonicalGitDirectory,
    commonGitDirectory,
    plan.targetRef,
  )
  const reflogPath = commitReflogPath(record, plan)
  const syncedReflog = await syncStableReflogFile(node, reflogPath, signal)
  const refParents = parentDirectoryChain(refPath, commonGitDirectory)
  const reflogParents = parentDirectoryChain(reflogPath, commonGitDirectory)
  for (const directory of [
    ...refParents.slice(0, -1),
    ...reflogParents.slice(0, -1),
    commonGitDirectory,
  ]) {
    await syncStableDirectory(node, directory, signal)
  }
  const current = await readCurrentTarget(dependencies.git, record, plan.targetRef, signal)
  await requireReflogIdentity(node, reflogPath, syncedReflog, signal)
  const expectedHead = record.request.expected.head
  const detachedExpectedHead = expectedHead.kind === 'commit' && expectedHead.symbolicRef === undefined
  if ((detachedExpectedHead || current !== plan.result.commitId)
    && await inspectCommitReflog(dependencies, record, plan, signal, syncedReflog) !== 'found') {
    throw new RetryableMutationError('unavailable')
  }
}

async function syncStableReflogFile(
  node: LocalGitMutationNodeAdapter,
  path: string,
  signal: AbortSignal,
): Promise<BigIntStats> {
  signal.throwIfAborted()
  const pathBefore = await node.lstat(path)
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
    throw new RetryableMutationError('unavailable')
  }
  let handle: LocalGitMutationFileHandle | undefined
  try {
    handle = await node.open(path, 'r+')
    const openedBefore = await handle.stat()
    if (!sameReflogFile(pathBefore, openedBefore)) throw new RetryableMutationError('unavailable')
    await handle.sync()
    const openedAfter = await handle.stat()
    const pathAfter = await node.lstat(path)
    signal.throwIfAborted()
    if (!sameReflogFile(openedBefore, openedAfter)
      || !sameReflogFile(openedAfter, pathAfter)) {
      throw new RetryableMutationError('unavailable')
    }
    return pathAfter
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function requireReflogIdentity(
  node: LocalGitMutationNodeAdapter,
  path: string,
  expected: BigIntStats,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  let current: BigIntStats
  try {
    current = await node.lstat(path)
  } catch (error) {
    signal.throwIfAborted()
    if (isNodeError(error, 'ENOENT')) throw new RetryableMutationError('unavailable')
    throw error
  }
  signal.throwIfAborted()
  if (!sameReflogFile(expected, current)) throw new RetryableMutationError('unavailable')
}

async function syncStableDirectory(
  node: LocalGitMutationNodeAdapter,
  path: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  const before = await node.lstat(path)
  if (!before.isDirectory() || before.isSymbolicLink()) throw new RetryableMutationError('unavailable')
  // The production Windows adapter deliberately cannot fsync directories; file data is still synced above.
  await node.syncDirectory(path)
  const after = await node.lstat(path)
  signal.throwIfAborted()
  if (!after.isDirectory() || after.isSymbolicLink()
    || after.dev !== before.dev || after.ino !== before.ino) {
    throw new RetryableMutationError('unavailable')
  }
}

/**
 * List a durable publication path's parents through its trusted root.
 * @param path - publication path already resolved within `root`.
 * @param root - trusted common Git directory terminating the walk.
 * @returns parent directories ordered from the leaf toward `root`, inclusive.
 * @throws {Error} when the parent walk reaches the filesystem root first.
 * @internal
 */
export function parentDirectoryChain(path: string, root: string): readonly string[] {
  const chain: string[] = []
  let current = dirname(path)
  while (true) {
    chain.push(current)
    if (current === root) return chain
    const parent = dirname(current)
    if (parent === current) throw new Error('Git publication path escaped its common directory')
    current = parent
  }
}

/**
 * Resolve one durable Commit ref target inside its owning Git directory.
 * @param canonicalGitDirectory - canonical worktree-specific Git directory used for HEAD.
 * @param canonicalCommonGitDirectory - canonical common Git directory used for named refs.
 * @param targetRef - frozen HEAD or `refs/` target accepted by Commit planning.
 * @returns the target ref path within the owning Git directory.
 * @throws {Error} when a non-HEAD target is not a named ref or escapes the common Git directory.
 * @internal
 */
export function resolveCommitRefPath(
  canonicalGitDirectory: string,
  canonicalCommonGitDirectory: string,
  targetRef: string,
): string {
  if (targetRef === 'HEAD') return join(canonicalGitDirectory, 'HEAD')
  if (!targetRef.startsWith('refs/')) {
    throw new Error('unsafe durable Commit ref target')
  }
  const target = resolve(canonicalCommonGitDirectory, ...targetRef.split('/'))
  const within = relative(canonicalCommonGitDirectory, target)
  if (within === '' || within === '..' || within.startsWith(`..${sep}`)) {
    throw new Error('unsafe durable Commit ref target')
  }
  /* v8 ignore next -- the Commit target schema excludes drive, UNC, and backslash components from named refs. */
  if (isAbsolute(within)) {
    throw new Error('unsafe durable Commit ref target')
  }
  return target
}

async function prepareCommitAttempt(
  dependencies: LocalGitMutationDependencies,
  record: LocalHostOperationRecord,
  plan: LocalHostCommitPlan,
  signal: AbortSignal,
): Promise<void> {
  assertAttachedCommit(record)
  await requireOperationScratchRuntimePaths(
    mutationNodeAdapter(dependencies),
    plan.scratch,
    record,
    signal,
  )
  if (!await indexPinMatches(
    record,
    plan.pin,
    plan.indexReadLimit,
    signal,
    mutationNodeAdapter(dependencies),
  )) {
    throw new RetryableMutationError('unavailable')
  }
  await acquireIndexPublicationLock(
    record,
    plan.pin,
    plan.indexReadLimit,
    signal,
    mutationNodeAdapter(dependencies),
  )
  if (!await commitLocksMatch(
    record,
    plan,
    plan.indexReadLimit,
    signal,
    mutationNodeAdapter(dependencies),
  )) {
    throw new RetryableMutationError('busy')
  }
  const stable = await observeAndValidate(dependencies, record, signal)
  assertCommitHasStagedChange(stable)
  const manifest = await durabilizeOwnedGitScratch(
    mutationNodeAdapter(dependencies),
    plan.scratch,
    record,
    ownedLooseObjectCountLimit(stable.inventory, 1),
    signal,
  )
  const commitId = await createCommitObject(
    dependencies,
    record,
    plan.scratch,
    plan.result.committer,
    false,
    signal,
  )
  // The private candidate froze every commit input; omitting its object directory changes storage only.
  /* v8 ignore next -- identical frozen inputs make Git commit-tree deterministic within one object format. */
  if (commitId !== plan.result.commitId) throw new Error('deterministic Commit candidate changed')
  await durabilizeExactSourceLooseObjects(
    dependencies,
    record,
    [...manifest.objectIds, plan.result.treeId, plan.result.commitId],
    signal,
  )
}

async function prepareIndexPublication(
  dependencies: LocalGitMutationDependencies,
  record: LocalHostOperationRecord,
  request: IndexRequest,
  signal: AbortSignal,
): Promise<PreparedIndexPublication> {
  const indexReadLimit = dependencies.config.operationMaxIndexBytes
  await observeAndValidate(dependencies, record, signal)
  const indexPath = boundIndexPath(record)
  const lockPath = `${indexPath}.lock`
  const node = mutationNodeAdapter(dependencies)
  await assertIndexLockAvailable(lockPath, node)
  const scratch = await createOwnedGitScratch(node, record, signal)
  let pin: LocalHostStageFilesPlan['pin'] | undefined
  const pinReference: PreparedIndexPinReference = {}
  const release = preparedIndexLockRelease(dependencies, record, pinReference, indexReadLimit)
  const discard = async (): Promise<void> => {
    const cleanup = [
      release(),
      removeOwnedScratch(node, scratch, record),
    ]
    if (pin !== undefined) {
      cleanup.push(removeOwnedIndexPin(
        record,
        pin,
        indexReadLimit,
        mutationNodeAdapter(dependencies),
      ))
    }
    const results = await Promise.allSettled(cleanup)
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (rejected !== undefined) throw rejected.reason
  }
  try {
    const stable = await observeAndValidate(dependencies, record, signal)
    const expectedIndexFile = await readIndexEvidence(
      node,
      indexPath,
      indexReadLimit,
      signal,
    )
    if (expectedIndexFile.kind === 'file') {
      const targetBytes = await readFileBounded(
        node,
        indexPath,
        indexReadLimit,
        signal,
      )
      const paths = await requireOperationScratchRuntimePaths(node, scratch, record, signal)
      await writePrivateFile(paths.targetIndexPath, targetBytes)
    } else {
      const paths = await requireOperationScratchRuntimePaths(node, scratch, record, signal)
      await dependencies.git.runMutation(
        boundWorktree(record),
        ['read-tree', '--empty'],
        signal,
        {
          hooksDirectory: paths.hooksDirectory,
          indexFile: paths.targetIndexPath,
          objectDirectory: paths.objectDirectory,
        },
      )
    }
    const changes = await applyIndexSelection(
      dependencies,
      record,
      request,
      stable,
      scratch,
      signal,
    )
    const treePaths = await requireOperationScratchRuntimePaths(node, scratch, record, signal)
    const { stdout: treeOutput, stderr: treeError } = await dependencies.git.runMutation(
      boundWorktree(record),
      ['write-tree'],
      signal,
      {
        hooksDirectory: treePaths.hooksDirectory,
        indexFile: treePaths.targetIndexPath,
        objectDirectory: treePaths.objectDirectory,
      },
    )
    const treeId = parseObjectId(treeOutput, treeError, record)
    const targetEvidencePaths = await requireOperationScratchRuntimePaths(node, scratch, record, signal)
    const targetIndexArtifact = await readIndexEvidence(
      node,
      targetEvidencePaths.targetIndexPath,
      indexReadLimit,
      signal,
    )
    if (targetIndexArtifact.kind !== 'file') throw new RetryableMutationError('unavailable')
    await observeAndValidate(dependencies, record, signal)
    if (!sameIndexEvidence(
      await readIndexEvidence(
        node,
        indexPath,
        indexReadLimit,
        signal,
      ),
      expectedIndexFile,
    )) {
      throw new NoEffectMutationError('observation-stale')
    }
    const targetPinPaths = await requireOperationScratchRuntimePaths(node, scratch, record, signal)
    pin = await createIndexPin(
      node,
      record,
      await readFileBounded(
        node,
        targetPinPaths.targetIndexPath,
        indexReadLimit,
        signal,
      ),
      expectedIndexFile.kind === 'file' ? expectedIndexFile.mode : undefined,
    )
    pinReference.value = pin
    await durabilizeOwnedGitScratch(
      node,
      scratch,
      record,
      ownedLooseObjectCountLimit(stable.inventory, request.changes.length),
      signal,
    )
    const targetIndexFile = { ...targetIndexArtifact, mode: pin.mode }
    const publicChanges = changes.map(({ pathBytesBase64: _pathBytesBase64, ...change }) => change)
    const plan = request.type === 'stage-files'
      ? {
        kind: 'index' as const,
        operation: 'stage-files' as const,
        scratch,
        indexReadLimit,
        expectedIndexFile,
        targetIndexFile,
        pin,
        publication: 'not-started' as const,
        changes,
        result: {
          type: 'stage-files' as const,
          changes: publicChanges,
          resultingIndex: { kind: 'tree' as const, treeId },
        },
      }
      : {
        kind: 'index' as const,
        operation: 'unstage-files' as const,
        scratch,
        indexReadLimit,
        expectedIndexFile,
        targetIndexFile,
        pin,
        publication: 'not-started' as const,
        changes,
        result: {
          type: 'unstage-files' as const,
          changes: publicChanges,
          resultingIndex: { kind: 'tree' as const, treeId },
        },
      }
    const prepareAttempt = async (): Promise<void> => {
      const attempt = await observeAndValidate(dependencies, record, signal)
      if (!sameIndexEvidence(
        await readIndexEvidence(
          mutationNodeAdapter(dependencies),
          indexPath,
          plan.indexReadLimit,
          signal,
        ),
        expectedIndexFile,
      )) {
        throw new NoEffectMutationError('observation-stale')
      }
      await materializeStageObjects(dependencies, record, attempt, plan, plan.scratch, signal)
      if (!await indexPinMatches(
        record,
        plan.pin,
        plan.indexReadLimit,
        signal,
        node,
      )) {
        throw new RetryableMutationError('unavailable')
      }
      await acquireIndexPublicationLock(
        record,
        plan.pin,
        plan.indexReadLimit,
        signal,
        node,
      )
      await requireExpectedIndexAfterLock(
        record,
        plan.expectedIndexFile,
        plan.indexReadLimit,
        signal,
        node,
      )
      await requireOperationScratchRuntimePaths(node, plan.scratch, record, signal)
    }
    const publish = async (): Promise<void> => {
      const node = mutationNodeAdapter(dependencies)
      await publishOwnedIndexLock(
        node,
        record,
        plan.expectedIndexFile,
        plan.pin,
        plan.indexReadLimit,
        signal,
      )
    }
    return {
      plan,
      prepareAttempt,
      publish,
      release,
      discard,
    }
  } catch (error) {
    await cleanupBeforeRethrow(signal, discard)
    throw error
  }
}

async function applyIndexSelection(
  dependencies: LocalGitMutationDependencies,
  record: LocalHostOperationRecord,
  request: IndexRequest,
  stable: StableMutationObservation,
  scratch: LocalHostOperationScratch,
  signal: AbortSignal,
): Promise<readonly (AppliedProjectGitChange & { readonly pathBytesBase64: string })[]> {
  const statusById = new Map(stable.status.changes.map(change => [change.id, change]))
  const inventoryByPath = inventoryPathMap(stable.inventory)
  const instructions: Buffer[] = []
  let instructionBytes = 0
  const applied: Array<AppliedProjectGitChange & { readonly pathBytesBase64: string }> = []
  for (const selected of request.changes) {
    signal.throwIfAborted()
    const change = statusById.get(selected.id)
    if (change === undefined || change.fingerprint.digest !== selected.fingerprint.digest) {
      throw new NoEffectMutationError('invalid-selection')
    }
    const pathBytes = Buffer.from(change.path, 'utf8')
    const inventory = inventoryByPath.get(pathBytes.toString('hex'))
    /* v8 ignore next -- stable status changes and inventory rows come from the same captured repository inventory. */
    if (inventory === undefined) throw new NoEffectMutationError('invalid-selection')
    const update = await applyIndexSelectionUpdate(
      dependencies,
      record,
      request.type,
      change,
      inventory,
      scratch,
      true,
      signal,
    )
    const zero = '0'.repeat(record.request.expected.binding.expectedInspection.projection.objectFormat === 'sha1' ? 40 : 64)
    const prefix = update.mode === undefined || update.objectId === undefined
      ? `0 ${zero}\t`
      : `${update.mode} ${update.objectId}\t`
    const prefixBytes = Buffer.from(prefix, 'ascii')
    const recordBytes = prefixBytes.byteLength + pathBytes.byteLength + 1
    const nextInstructionBytes = addGitIndexInstructionBytes(instructionBytes, recordBytes)
    /* v8 ignore next -- selected status paths and request counts cap the complete stream below Buffer.MAX_LENGTH. */
    if (nextInstructionBytes === undefined) {
      throw new NoEffectMutationError('unsupported-state')
    }
    instructions.push(prefixBytes, pathBytes, Buffer.from([0]))
    instructionBytes = nextInstructionBytes
    applied.push({ ...selected, path: change.path, pathBytesBase64: pathBytes.toString('base64') })
  }
  const stdin = Buffer.concat(instructions, instructionBytes)
  const paths = await requireOperationScratchRuntimePaths(
    mutationNodeAdapter(dependencies),
    scratch,
    record,
    signal,
  )
  await dependencies.git.runMutation(
    boundWorktree(record),
    ['update-index', '-z', '--index-info'],
    signal,
    {
      hooksDirectory: paths.hooksDirectory,
      indexFile: paths.targetIndexPath,
      objectDirectory: paths.objectDirectory,
    },
    {
      bytes: stdin,
      maxBytes: gitIndexInstructionByteLimit(
        dependencies.config.inventoryMaxPathBytes,
        request.changes.length,
        objectIdWidth(record),
      ),
    },
  )
  return applied
}

async function materializeStageObjects(
  dependencies: LocalGitMutationDependencies,
  record: LocalHostOperationRecord,
  stable: StableMutationObservation,
  plan: LocalHostStageFilesPlan | LocalHostUnstageFilesPlan,
  scratch: LocalHostOperationScratch,
  signal: AbortSignal,
): Promise<void> {
  if (plan.operation !== 'stage-files') return
  const statusById = new Map(stable.status.changes.map(change => [change.id, change]))
  const inventoryByPath = inventoryPathMap(stable.inventory)
  const objectIds: string[] = []
  for (const planned of plan.changes) {
    signal.throwIfAborted()
    const change = statusById.get(planned.id)
    const inventory = inventoryByPath.get(Buffer.from(planned.pathBytesBase64, 'base64').toString('hex'))
    if (change === undefined || change.fingerprint.digest !== planned.fingerprint.digest
      || change.path !== planned.path || inventory === undefined) {
      throw new NoEffectMutationError('observation-stale')
    }
    const update = await applyIndexSelectionUpdate(
      dependencies,
      record,
      plan.operation,
      change,
      inventory,
      scratch,
      false,
      signal,
    )
    if (update.hashedWorktree && update.objectId !== undefined) objectIds.push(update.objectId)
  }
  await durabilizeExactSourceLooseObjects(dependencies, record, objectIds, signal)
}

async function applyIndexSelectionUpdate(
  dependencies: LocalGitMutationDependencies,
  record: LocalHostOperationRecord,
  operation: 'stage-files' | 'unstage-files',
  change: ProjectGitChange,
  entry: CapturedRepositoryInventoryEntry,
  scratch: LocalHostOperationScratch,
  usePrivateObjectDirectory: boolean,
  signal: AbortSignal,
): Promise<{
  readonly mode?: string
  readonly objectId?: string
  readonly hashedWorktree?: true
}> {
  const decision = decideGitIndexSelection(operation, change, entry)
  switch (decision.kind) {
    case 'reject':
      throw new NoEffectMutationError(decision.reason)
    case 'remove':
      return {}
    case 'use-object':
      return { mode: decision.mode, objectId: decision.objectId }
    case 'hash-worktree':
      break
  }
  const bytes = await readExactWorktreeBytes(
    mutationNodeAdapter(dependencies),
    boundWorktree(record),
    change.path,
    decision.evidence,
    signal,
  )
  const expectedObjectId = decision.expectedObjectId
  const paths = await requireOperationScratchRuntimePaths(
    mutationNodeAdapter(dependencies),
    scratch,
    record,
    signal,
  )
  const { stdout, stderr } = await dependencies.git.runMutation(
    boundWorktree(record),
    ['hash-object', '-w', '--stdin', '--no-filters'],
    signal,
    {
      hooksDirectory: paths.hooksDirectory,
      ...(usePrivateObjectDirectory ? { objectDirectory: paths.objectDirectory } : {}),
    },
    { bytes, maxBytes: Math.max(1, dependencies.config.inventoryMaxFileBytes) },
  )
  const objectId = parseObjectId(stdout, stderr, record)
  if (objectId !== expectedObjectId) throw new NoEffectMutationError('observation-stale')
  return { mode: decision.mode, objectId, hashedWorktree: true }
}

async function observeAndValidate(
  dependencies: LocalGitMutationDependencies,
  record: LocalHostOperationRecord,
  signal: AbortSignal,
): Promise<StableMutationObservation> {
  return await observeAndValidateExpected(dependencies, record.request.expected, signal)
}

/**
 * Reobserve one frozen Host Git precondition without performing a repository effect.
 * @param dependencies - Local Host inspection capabilities.
 * @param expected - complete frozen writable-world evidence.
 * @param signal - observation cancellation.
 * @returns nothing after exact evidence matches.
 * @throws {NoEffectMutationError} when current durable evidence disproves the precondition.
 * @throws {RetryableMutationError} when no complete bounded observation is available.
 */
export async function verifyFrozenHostOperationWorld(
  dependencies: LocalHostWorldVerificationDependencies,
  expected: HostGitMutationPrecondition,
  signal: AbortSignal,
): Promise<void> {
  await observeAndValidateExpected(dependencies, expected, signal)
}

async function observeAndValidateExpected(
  dependencies: LocalHostWorldVerificationDependencies,
  expected: HostGitMutationPrecondition,
  signal: AbortSignal,
): Promise<StableMutationObservation> {
  const binding = expected.binding
  let selected
  try {
    selected = await inspectStableLocalProjectSelection(
      dependencies.fs,
      dependencies.workspaces,
      dependencies.git,
      dependencies.config,
      { hostId: binding.hostId, directoryLocator: binding.expectedInspection.trusted.canonicalWorktreePath },
      signal,
      dependencies.identityReader,
      {
        boundResource: { workspaceId: binding.workspaceId, trusted: binding.expectedInspection.trusted },
        rejectUnsupportedIndexState: true,
      },
    )
  } catch (error) {
    if (error instanceof BoundProjectResourceMismatchError) throw new NoEffectMutationError('binding-stale')
    throw error
  }
  if (!selected.ok) rejectStableSelectionFailure(selected.reason)
  const preEffectBaseline = selected.inspection.projection.baseline
  signal.throwIfAborted()
  let status: ProjectGitStatusObservation
  try {
    status = buildProjectGitStatusObservation(
      selected.inventory,
      selected.inspection,
      binding,
      signal,
      selected.status,
      preEffectBaseline,
      selected.unsupportedIndexState,
    )
  } catch (error) {
    /* v8 ignore start -- parsed Git evidence and durable schema values expose no reentrant code;
     * every explicit synchronous projection failure uses ProjectGitStatusProjectionError. */
    if (!(error instanceof ProjectGitStatusProjectionError)) throw error
    /* v8 ignore stop */
    throw new RetryableMutationError('unavailable')
  }
  if (preEffectBaseline.kind !== 'complete') throw new RetryableMutationError('unavailable')
  if (status.fingerprint.digest !== expected.status.digest
    || canonicalDigest('saki/host-operation-head/v1', status.head)
      !== canonicalDigest('saki/host-operation-head/v1', expected.head)
    || status.index.kind !== 'tree'
    || status.index.treeId !== expected.index.treeId
    || status.worktree.digest !== expected.worktree.digest
    || preEffectBaseline.digest !== expected.preEffectBaseline.digest) {
    throw new NoEffectMutationError('observation-stale')
  }
  if (!status.structuredMutation.available) throw new NoEffectMutationError('unsupported-state')
  return { inventory: selected.inventory, status }
}

async function resumeNotStartedIndexPublication(
  dependencies: LocalGitMutationDependencies,
  record: LocalHostOperationRecord,
  plan: LocalHostStageFilesPlan | LocalHostUnstageFilesPlan,
  persist: PersistLocalHostOperation,
  signal: AbortSignal,
): Promise<LocalGitMutationAdvanceResult> {
  const node = mutationNodeAdapter(dependencies)
  try {
    if (!await indexPinMatches(
      record,
      plan.pin,
      plan.indexReadLimit,
      signal,
      node,
    )) {
      return { kind: 'retryable', reason: 'unavailable', record }
    }
    const paths = await requireOperationScratchRuntimePaths(node, plan.scratch, record, signal)
    const target = await readIndexEvidence(
      node,
      paths.targetIndexPath,
      plan.indexReadLimit,
      signal,
    )
    if (!sameIndexContents(target, plan.targetIndexFile)) {
      return { kind: 'retryable', reason: 'unavailable', record }
    }
  } catch (error) {
    return await mapGitMutationError(dependencies, record, persist, signal, error)
  }
  const indexPath = boundIndexPath(record)
  try {
    const stable = await observeAndValidate(dependencies, record, signal)
    if (!sameIndexEvidence(
      await readIndexEvidence(
        node,
        indexPath,
        plan.indexReadLimit,
        signal,
      ),
      plan.expectedIndexFile,
    )) {
      throw new NoEffectMutationError('observation-stale')
    }
    await materializeStageObjects(
      dependencies,
      record,
      stable,
      plan,
      plan.scratch,
      signal,
    )
    await acquireIndexPublicationLock(
      record,
      plan.pin,
      plan.indexReadLimit,
      signal,
      node,
    )
    await requireExpectedIndexAfterLock(
      record,
      plan.expectedIndexFile,
      plan.indexReadLimit,
      signal,
      node,
    )
    await requireOperationScratchRuntimePaths(node, plan.scratch, record, signal)
  } catch (error) {
    await cleanupBeforeRethrow(
      signal,
      async () => {
        await removeOwnedIndexLock(
          record,
          plan.pin,
          plan.indexReadLimit,
          node,
        )
      },
    )
    return await mapGitMutationError(dependencies, record, persist, signal, error)
  }
  const next = withPublication(record, plan, 'attempting')
  try {
    await persist(next)
  } catch (error) {
    await cleanupBeforeRethrow(
      signal,
      async () => {
        await removeOwnedIndexLock(
          record,
          plan.pin,
          plan.indexReadLimit,
          node,
        )
      },
    )
    throw error
  }
  try {
    await publishOwnedIndexLock(
      node,
      record,
      plan.expectedIndexFile,
      plan.pin,
      plan.indexReadLimit,
      signal,
    )
  } catch {
    await cleanupBeforeRethrow(
      signal,
      async () => {
        await removeOwnedIndexLock(
          record,
          plan.pin,
          plan.indexReadLimit,
          mutationNodeAdapter(dependencies),
        )
      },
    )
  }
  return await recoverPublishingOperation(dependencies, next, persist, signal, true)
}

async function mapGitMutationError(
  dependencies: LocalGitMutationDependencies,
  record: LocalHostOperationRecord,
  persist: PersistLocalHostOperation,
  signal: AbortSignal,
  error: unknown,
): Promise<LocalGitMutationAdvanceResult> {
  const decision = classifyGitMutationError(error, { aborted: signal.aborted, reason: signal.reason })
  switch (decision.kind) {
    case 'aborted':
      throw decision.reason
    case 'retryable':
      return { kind: 'retryable', reason: decision.reason, record }
    case 'no-effect': {
      const failed = await persistNoEffectFailure(dependencies, record, persist, decision.reason)
      return { kind: 'advanced', record: failed }
    }
    case 'unexpected':
      throw decision.error
  }
}

function transitionToPlanning(
  record: LocalHostOperationRecord,
  snapshot: Extract<HostOperationSnapshot, { readonly state: 'accepted' }>,
): LocalHostOperationRecord {
  const plannedAt = Date.now()
  return {
    ...record,
    snapshot: {
      ...snapshot,
      state: 'planning',
      revision: snapshot.revision + 1,
      plannedAt,
      updatedAt: plannedAt,
    },
  }
}

function transitionToPublishing(
  record: LocalHostOperationRecord,
  snapshot: Extract<HostOperationSnapshot, { readonly state: 'planning' }>,
  plan: LocalHostOperationEffectPlan,
): LocalHostOperationRecord {
  const publishingAt = Date.now()
  return {
    ...record,
    effectPlan: plan,
    snapshot: {
      ...snapshot,
      state: 'publishing',
      revision: snapshot.revision + 1,
      plannedAt: snapshot.plannedAt,
      effectPlannedAt: publishingAt,
      publishingAt,
      updatedAt: publishingAt,
    },
  }
}

function withPublication(
  record: LocalHostOperationRecord,
  plan: LocalHostOperationEffectPlan,
  publication: LocalHostOperationEffectPlan['publication'],
): LocalHostOperationRecord {
  return withPlan(record, { ...plan, publication })
}

function withPlan(
  record: LocalHostOperationRecord,
  plan: LocalHostOperationEffectPlan,
): LocalHostOperationRecord {
  const updatedAt = Date.now()
  return {
    ...record,
    effectPlan: plan,
    snapshot: { ...record.snapshot, revision: record.snapshot.revision + 1, updatedAt },
  }
}

function transitionToSuccess(
  record: LocalHostOperationRecord,
  plan: LocalHostOperationEffectPlan,
): LocalHostOperationRecord {
  const completedAt = Date.now()
  return {
    ...record,
    effectPlan: { ...plan, publication: 'applied-recorded' },
    snapshot: {
      ...hostOperationSnapshotCore(record.snapshot),
      state: 'succeeded',
      revision: record.snapshot.revision + 1,
      updatedAt: completedAt,
      completedAt,
      result: plan.result,
    } as HostOperationSnapshot,
  }
}

function transitionToReconciliation(
  record: LocalHostOperationRecord,
  reason: 'effect-unknown' | 'evidence-conflict',
): LocalHostOperationRecord {
  const observedAt = Date.now()
  return {
    ...record,
    snapshot: {
      ...hostOperationSnapshotCore(record.snapshot),
      state: 'reconciliation-required',
      revision: record.snapshot.revision + 1,
      updatedAt: observedAt,
      observedAt,
      reason,
    } as HostOperationSnapshot,
  }
}

function transitionToCancellation(
  record: LocalHostOperationRecord,
  reason: HostOperationCancellationReason,
): LocalHostOperationRecord {
  const completedAt = Date.now()
  return {
    ...record,
    snapshot: {
      ...hostOperationSnapshotCore(record.snapshot),
      state: 'canceled',
      revision: record.snapshot.revision + 1,
      updatedAt: completedAt,
      completedAt,
      reason,
      effect: 'none',
    } as HostOperationSnapshot,
  }
}

async function persistNoEffectFailure(
  dependencies: LocalGitMutationDependencies,
  record: LocalHostOperationRecord,
  persist: PersistLocalHostOperation,
  reason: HostOperationFailure['reason'],
): Promise<LocalHostOperationRecord> {
  const completedAt = Date.now()
  const failed: LocalHostOperationRecord = {
    ...record,
    snapshot: {
      ...hostOperationSnapshotCore(record.snapshot),
      state: 'failed',
      revision: record.snapshot.revision + 1,
      updatedAt: completedAt,
      completedAt,
      failure: { reason },
      effect: 'none',
    } as HostOperationSnapshot,
  }
  await persistTerminalOperation(dependencies, failed, persist)
  return failed
}

async function persistTerminalOperation(
  dependencies: LocalGitMutationDependencies,
  record: LocalHostOperationRecord,
  persist: PersistLocalHostOperation,
): Promise<void> {
  /* v8 ignore next -- private callers pass only records returned by terminal transition helpers. */
  if (!isTerminal(record.snapshot)) throw new Error('cannot persist a non-terminal operation as terminal')
  if (record.effectPlan !== undefined) {
    await removeOwnedIndexLock(
      record,
      record.effectPlan.pin,
      record.effectPlan.indexReadLimit,
      mutationNodeAdapter(dependencies),
    )
  }
  await persist(record)
  await cleanupTerminalGitMutation(dependencies, record)
}

async function createOwnedScratch(
  node: LocalGitMutationNodeAdapter,
  record: LocalHostOperationRecord,
): Promise<LocalHostOperationScratch> {
  const path = await mkdtemp(join(tmpdir(), 'saki-host-operation-'))
  const directory = await node.lstat(path)
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new RetryableMutationError('unavailable')
  }
  const identity = { device: directory.dev.toString(), inode: directory.ino.toString() }
  const marker = operationScratchMarker(record)
  const ownerPath = join(path, 'owner')
  const payloadPath = join(path, 'payload')
  let owner: LocalGitMutationFileHandle | undefined
  let ownerIdentity: { readonly device: string; readonly inode: string } | undefined
  let payloadIdentity: { readonly device: string; readonly inode: string } | undefined
  try {
    await chmod(path, 0o700)
    owner = await node.open(ownerPath, 'wx', 0o600)
    const initialOwner = await owner.stat()
    ownerIdentity = { device: initialOwner.dev.toString(), inode: initialOwner.ino.toString() }
    /* v8 ignore start -- a successful Node `wx` open returns a regular file, never a symlink. */
    if (!initialOwner.isFile() || initialOwner.isSymbolicLink()) {
      throw new RetryableMutationError('unavailable')
    }
    /* v8 ignore stop */
    if (initialOwner.dev !== directory.dev) throw new RetryableMutationError('unavailable')
    await owner.writeFile(marker)
    await owner.chmod(0o600)
    await owner.sync()
    const completeOwner = await owner.stat()
    /* v8 ignore start -- metadata identity cannot change for the same open Node file handle. */
    if (completeOwner.dev !== initialOwner.dev || completeOwner.ino !== initialOwner.ino) {
      throw new RetryableMutationError('unavailable')
    }
    /* v8 ignore stop */
    if (completeOwner.size !== BigInt(marker.byteLength)) {
      throw new RetryableMutationError('unavailable')
    }
    await owner.close()
    owner = undefined
    await mkdir(payloadPath, { mode: 0o700 })
    const payload = await node.lstat(payloadPath)
    if (!payload.isDirectory() || payload.isSymbolicLink() || payload.dev !== directory.dev) {
      throw new RetryableMutationError('unavailable')
    }
    payloadIdentity = { device: payload.dev.toString(), inode: payload.ino.toString() }
    await node.syncDirectory(path)
    const confirmed = await node.lstat(path)
    if (!confirmed.isDirectory() || confirmed.isSymbolicLink()
      || confirmed.dev !== directory.dev || confirmed.ino !== directory.ino) {
      throw new RetryableMutationError('unavailable')
    }
    const confirmedPayload = await node.lstat(payloadPath)
    if (!confirmedPayload.isDirectory() || confirmedPayload.isSymbolicLink()
      || confirmedPayload.dev !== payload.dev || confirmedPayload.ino !== payload.ino) {
      throw new RetryableMutationError('unavailable')
    }
  } catch (error) {
    await owner?.close().catch(() => undefined)
    if (payloadIdentity !== undefined) {
      await removeEmptyScratchDirectoryByIdentity(node, payloadPath, payloadIdentity).catch(() => undefined)
    }
    if (ownerIdentity !== undefined) {
      await unlinkOwnedLockByIdentity(node, ownerPath, ownerIdentity).catch(() => undefined)
    }
    await removeEmptyScratchDirectoryByIdentity(node, path, identity).catch(() => undefined)
    throw error
  }
  return {
    path,
    markerDigest: byteDigest(marker),
    identity,
    payloadIdentity,
    ownerIdentity,
  }
}

async function createOwnedGitScratch(
  node: LocalGitMutationNodeAdapter,
  record: LocalHostOperationRecord,
  signal: AbortSignal,
): Promise<LocalHostOperationScratch> {
  const scratch = await createOwnedScratch(node, record)
  try {
    let paths = await requireOperationScratchRuntimePaths(
      node,
      scratch,
      record,
      signal,
    )
    await mkdir(paths.hooksDirectory, { mode: 0o700 })
    paths = await requireOperationScratchRuntimePaths(
      node,
      scratch,
      record,
      signal,
    )
    await mkdir(paths.objectDirectory, { mode: 0o700 })
    paths = await requireOperationScratchRuntimePaths(
      node,
      scratch,
      record,
      signal,
    )
    await mkdir(join(paths.objectDirectory, 'info'), { mode: 0o700 })
    paths = await requireOperationScratchRuntimePaths(
      node,
      scratch,
      record,
      signal,
    )
    await writePrivateFile(
      join(paths.objectDirectory, 'info', 'alternates'),
      Buffer.from(`${gitAlternatePath(join(
        record.request.expected.binding.expectedInspection.trusted.canonicalCommonGitDirectory,
        'objects',
      ))}\n`, 'utf8'),
    )
    await requireOperationScratchRuntimePaths(
      node,
      scratch,
      record,
      signal,
    )
  } catch (error) {
    await removeOwnedScratch(node, scratch, record)
    throw error
  }
  return scratch
}

async function durabilizeOwnedGitScratch(
  node: LocalGitMutationNodeAdapter,
  scratch: LocalHostOperationScratch,
  record: LocalHostOperationRecord,
  maxObjectCount: number,
  signal: AbortSignal,
): Promise<OwnedLooseObjectManifest> {
  const paths = await requireOperationScratchRuntimePaths(node, scratch, record, signal)
  const manifest = await readOwnedLooseObjectManifest(
    node,
    paths.objectDirectory,
    objectIdWidth(record),
    maxObjectCount,
    signal,
  )
  await node.syncDirectory(join(paths.objectDirectory, 'info'))
  signal.throwIfAborted()
  for (const fanoutDirectory of manifest.fanoutDirectories) {
    await node.syncDirectory(fanoutDirectory)
    signal.throwIfAborted()
  }
  await node.syncDirectory(paths.objectDirectory)
  signal.throwIfAborted()
  await node.syncDirectory(dirname(paths.hooksDirectory))
  signal.throwIfAborted()
  await node.syncDirectory(scratch.path)
  signal.throwIfAborted()
  await node.syncDirectory(dirname(scratch.path))
  signal.throwIfAborted()
  await requireOperationScratchRuntimePaths(node, scratch, record, signal)
  return manifest
}

function ownedLooseObjectCountLimit(
  inventory: CapturedRepositoryInventory,
  additionalObjects: number,
): number {
  let limit = additionalObjects + 1
  for (const entry of inventory.entries) {
    const nextLimit = addOwnedLooseObjectCount(limit, entry.path.byteLength)
    /* v8 ignore next -- inventory capture bounds path bytes to Buffer.MAX_LENGTH and requests select at most 100,000 changes. */
    if (nextLimit === undefined) {
      throw new NoEffectMutationError('unsupported-state')
    }
    limit = nextLimit
  }
  return limit
}

/**
 * Group validated loose-object ids by their source fanout directory.
 * @param objectDirectory - canonical source object directory.
 * @param objectIds - validated object ids that still exist in the loose namespace.
 * @returns insertion-ordered fanout paths and their insertion-ordered object ids.
 * @internal
 */
export function groupLooseObjectIdsByFanout(
  objectDirectory: string,
  objectIds: readonly string[],
): ReadonlyMap<string, readonly string[]> {
  const grouped = new Map<string, string[]>()
  for (const objectId of objectIds) {
    const fanoutDirectory = join(objectDirectory, objectId.slice(0, 2))
    const fanoutIds = grouped.get(fanoutDirectory)
    if (fanoutIds === undefined) grouped.set(fanoutDirectory, [objectId])
    else fanoutIds.push(objectId)
  }
  return grouped
}

async function durabilizeExactSourceLooseObjects(
  dependencies: LocalGitMutationDependencies,
  record: LocalHostOperationRecord,
  objectIds: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  const width = objectIdWidth(record)
  const exactObjectId = new RegExp(`^[0-9a-f]{${width}}$`, 'u')
  const ids = [...new Set(objectIds)].sort()
  /* v8 ignore next -- callers supply ids from bounded manifest names, Git object-id parsers, or schema-validated durable results. */
  if (ids.some(objectId => !exactObjectId.test(objectId) || /^0+$/u.test(objectId))) {
    throw new NoEffectMutationError('unsupported-state')
  }
  if (ids.length === 0) return
  const node = mutationNodeAdapter(dependencies)
  const objectDirectory = join(
    record.request.expected.binding.expectedInspection.trusted.canonicalCommonGitDirectory,
    'objects',
  )
  const root = await node.lstat(objectDirectory)
  signal.throwIfAborted()
  if (!root.isDirectory() || root.isSymbolicLink()) throw new RetryableMutationError('unavailable')
  const looseObjectIds: string[] = []
  for (const objectId of ids) {
    signal.throwIfAborted()
    const fanoutDirectory = join(objectDirectory, objectId.slice(0, 2))
    const objectPath = join(fanoutDirectory, objectId.slice(2))
    let object: BigIntStats
    try {
      object = await node.lstat(objectPath)
      signal.throwIfAborted()
    } catch (error) {
      signal.throwIfAborted()
      if (!isNodeError(error, 'ENOENT')) throw error
      // Git just accepted this exact OID; absence from the loose namespace means it was already packed.
      continue
    }
    const fanout = await node.lstat(fanoutDirectory)
    signal.throwIfAborted()
    if (!fanout.isDirectory() || fanout.isSymbolicLink() || fanout.dev !== root.dev
      || !object.isFile() || object.isSymbolicLink() || object.dev !== root.dev) {
      throw new RetryableMutationError('unavailable')
    }
    looseObjectIds.push(objectId)
  }
  const idsByFanout = groupLooseObjectIdsByFanout(objectDirectory, looseObjectIds)
  for (const fanoutDirectory of [...idsByFanout.keys()].sort()) {
    try {
      await node.syncDirectory(fanoutDirectory)
      signal.throwIfAborted()
    } catch (error) {
      signal.throwIfAborted()
      if (isNodeError(error, 'ENOENT')) throw new RetryableMutationError('unavailable')
      throw error
    }
  }
  if (idsByFanout.size !== 0) {
    await node.syncDirectory(objectDirectory)
    signal.throwIfAborted()
  }
  for (const looseObjectIds of idsByFanout.values()) {
    for (const objectId of looseObjectIds) {
      const objectPath = join(objectDirectory, objectId.slice(0, 2), objectId.slice(2))
      try {
        const object = await node.lstat(objectPath)
        signal.throwIfAborted()
        if (!object.isFile() || object.isSymbolicLink() || object.dev !== root.dev) {
          throw new RetryableMutationError('unavailable')
        }
      } catch (error) {
        signal.throwIfAborted()
        if (isNodeError(error, 'ENOENT')) throw new RetryableMutationError('unavailable')
        throw error
      }
    }
  }
}

interface OwnedLooseObjectManifest {
  readonly objectIds: readonly string[]
  readonly fanoutDirectories: readonly string[]
}

async function readOwnedLooseObjectManifest(
  node: LocalGitMutationNodeAdapter,
  objectDirectory: string,
  objectIdWidth: 40 | 64,
  maxObjectCount: number,
  signal: AbortSignal,
): Promise<OwnedLooseObjectManifest> {
  signal.throwIfAborted()
  const root = await node.lstat(objectDirectory)
  signal.throwIfAborted()
  requireOwnedLooseObjectManifestObservation({
    kind: 'root',
    directory: root.isDirectory(),
    symlink: root.isSymbolicLink(),
  })
  const rootEntries = [...await node.readdir(objectDirectory)].sort()
  signal.throwIfAborted()
  requireOwnedLooseObjectManifestObservation({
    kind: 'root-entries',
    entryCount: rootEntries.length,
    hasInfo: rootEntries.includes('info'),
  })
  const info = await node.lstat(join(objectDirectory, 'info'))
  signal.throwIfAborted()
  requireOwnedLooseObjectManifestObservation({
    kind: 'owned-directory',
    directory: info.isDirectory(),
    symlink: info.isSymbolicLink(),
    sameDevice: info.dev === root.dev,
  })
  const objectIds: string[] = []
  const fanoutDirectories: string[] = []
  for (const name of rootEntries) {
    signal.throwIfAborted()
    if (name === 'info') continue
    requireOwnedLooseObjectManifestObservation({
      kind: 'fanout-name',
      name,
    })
    const fanoutDirectory = join(objectDirectory, name)
    const fanout = await node.lstat(fanoutDirectory)
    signal.throwIfAborted()
    requireOwnedLooseObjectManifestObservation({
      kind: 'owned-directory',
      directory: fanout.isDirectory(),
      symlink: fanout.isSymbolicLink(),
      sameDevice: fanout.dev === root.dev,
    })
    const entries = [...await node.readdir(fanoutDirectory)].sort()
    signal.throwIfAborted()
    requireOwnedLooseObjectManifestObservation({
      kind: 'object-count',
      retainedCount: objectIds.length,
      candidateCount: entries.length,
      maxObjectCount,
    })
    for (const suffix of entries) {
      signal.throwIfAborted()
      requireOwnedLooseObjectManifestObservation({
        kind: 'object-suffix',
        suffix,
        objectIdWidth,
      })
      const object = await node.lstat(join(fanoutDirectory, suffix))
      signal.throwIfAborted()
      requireOwnedLooseObjectManifestObservation({
        kind: 'owned-file',
        file: object.isFile(),
        symlink: object.isSymbolicLink(),
        sameDevice: object.dev === root.dev,
      })
      objectIds.push(`${name}${suffix}`)
    }
    fanoutDirectories.push(fanoutDirectory)
  }
  return { objectIds, fanoutDirectories }
}

async function removeOwnedScratch(
  node: LocalGitMutationNodeAdapter,
  scratch: LocalHostOperationScratch,
  record: LocalHostOperationRecord,
): Promise<void> {
  const signal = new AbortController().signal
  const quarantineScratch = { ...scratch, path: operationScratchQuarantinePath(scratch) }
  const retained = await quarantineScratchState(node, quarantineScratch, record, signal)
  if (retained.kind === 'owned' || retained.kind === 'witness-only') {
    await removeQuarantinedScratch(node, quarantineScratch, scratch, record, signal, retained)
    return
  }
  if (retained.kind !== 'missing') return
  if (!await scratchOwnershipMatches(node, scratch, record, signal)) return
  try {
    await node.rename(scratch.path, quarantineScratch.path)
  } catch {
    // The post-rename observations distinguish a collision from acknowledgement loss.
  }
  const sourceState = await scratchOwnershipState(node, scratch, record, signal)
  const quarantineState = await quarantineScratchState(node, quarantineScratch, record, signal)
  if (quarantineState.kind === 'owned' || quarantineState.kind === 'witness-only') {
    await removeQuarantinedScratch(node, quarantineScratch, scratch, record, signal, quarantineState)
    return
  }
  if (sourceState === 'missing' && quarantineState.kind !== 'missing') {
    await restoreQuarantinedScratch(node, quarantineScratch, scratch, record, signal)
  }
}

function operationScratchQuarantinePath(scratch: LocalHostOperationScratch): string {
  return `${scratch.path}.cleanup-${scratch.markerDigest.slice(0, 32)}`
}

function operationScratchQuarantineWitnessPath(scratch: LocalHostOperationScratch): string {
  return `${scratch.path}.owner`
}

function operationScratchPayloadPath(scratch: LocalHostOperationScratch): string {
  return join(scratch.path, 'payload')
}

async function scratchOwnershipMatches(
  node: LocalGitMutationNodeAdapter,
  scratch: LocalHostOperationScratch,
  record: LocalHostOperationRecord,
  signal: AbortSignal,
): Promise<boolean> {
  return await scratchOwnershipState(node, scratch, record, signal) === 'owned'
}

async function scratchRuntimeOwnershipMatches(
  node: LocalGitMutationNodeAdapter,
  scratch: LocalHostOperationScratch,
  record: LocalHostOperationRecord,
  signal: AbortSignal,
): Promise<boolean> {
  if (await scratchOwnershipState(node, scratch, record, signal) !== 'owned') return false
  if (await scratchPayloadState(node, scratch, signal) !== 'owned') return false
  return await scratchOwnershipState(node, scratch, record, signal) === 'owned'
}

interface OperationScratchRuntimePaths {
  readonly payloadDirectory: string
  readonly hooksDirectory: string
  readonly objectDirectory: string
  readonly commitIndexPath: string
  readonly targetIndexPath: string
}

async function requireOperationScratchRuntimePaths(
  node: LocalGitMutationNodeAdapter,
  scratch: LocalHostOperationScratch,
  record: LocalHostOperationRecord,
  signal: AbortSignal,
): Promise<OperationScratchRuntimePaths> {
  if (!await scratchRuntimeOwnershipMatches(node, scratch, record, signal)) {
    throw new RetryableMutationError('unavailable')
  }
  const payloadDirectory = operationScratchPayloadPath(scratch)
  return {
    payloadDirectory,
    hooksDirectory: join(payloadDirectory, 'hooks'),
    objectDirectory: join(payloadDirectory, 'objects'),
    commitIndexPath: join(payloadDirectory, 'commit.index'),
    targetIndexPath: join(payloadDirectory, 'target.index'),
  }
}

type ScratchOwnershipState = 'missing' | 'foreign' | 'owned' | 'unavailable'

type ScratchQuarantineState =
  | { readonly kind: 'missing' | 'foreign' | 'unavailable' | 'witness-only' }
  | { readonly kind: 'owned'; readonly marker: 'internal' | 'external' }

async function scratchOwnershipState(
  node: LocalGitMutationNodeAdapter,
  scratch: LocalHostOperationScratch,
  record: LocalHostOperationRecord,
  signal: AbortSignal,
): Promise<ScratchOwnershipState> {
  const directoryState = await scratchDirectoryState(node, scratch, signal)
  if (directoryState !== 'owned') return directoryState
  const ownerState = await scratchMarkerState(node, join(scratch.path, 'owner'), scratch, record, signal)
  if (ownerState !== 'owned') return ownerState === 'missing' ? 'unavailable' : ownerState
  return await scratchDirectoryState(node, scratch, signal) === 'owned' ? 'owned' : 'foreign'
}

async function scratchDirectoryState(
  node: LocalGitMutationNodeAdapter,
  scratch: LocalHostOperationScratch,
  signal: AbortSignal,
): Promise<ScratchOwnershipState> {
  signal.throwIfAborted()
  if (!isOperationScratchPath(scratch.path)) return 'foreign'
  try {
    const directory = await node.lstat(scratch.path)
    signal.throwIfAborted()
    return directory.isDirectory() && !directory.isSymbolicLink()
      && directory.dev.toString() === scratch.identity.device
      && directory.ino.toString() === scratch.identity.inode
      ? 'owned'
      : 'foreign'
  } catch (error) {
    signal.throwIfAborted()
    return isNodeError(error, 'ENOENT') ? 'missing' : 'unavailable'
  }
}

async function scratchMarkerState(
  node: LocalGitMutationNodeAdapter,
  ownerPath: string,
  scratch: LocalHostOperationScratch,
  record: LocalHostOperationRecord,
  signal: AbortSignal,
): Promise<ScratchOwnershipState> {
  signal.throwIfAborted()
  try {
    const owner = await node.lstat(ownerPath)
    signal.throwIfAborted()
    if (!owner.isFile() || owner.isSymbolicLink() || owner.size > 4_096n
      || owner.dev.toString() !== scratch.ownerIdentity.device
      || owner.ino.toString() !== scratch.ownerIdentity.inode) return 'foreign'
    const marker = await readFileBounded(node, ownerPath, 4_096, signal)
    const confirmedOwner = await node.lstat(ownerPath)
    signal.throwIfAborted()
    return classifyScratchMarkerConfirmation({
      before: ownedFileStatObservation(owner),
      confirmed: ownedFileStatObservation(confirmedOwner),
      digestMatches: byteDigest(marker) === scratch.markerDigest,
      markerMatches: marker.equals(operationScratchMarker(record)),
    })
  } catch (error) {
    signal.throwIfAborted()
    return isNodeError(error, 'ENOENT') ? 'missing' : 'unavailable'
  }
}

async function quarantineScratchState(
  node: LocalGitMutationNodeAdapter,
  quarantine: LocalHostOperationScratch,
  record: LocalHostOperationRecord,
  signal: AbortSignal,
): Promise<ScratchQuarantineState> {
  const directory = await scratchDirectoryState(node, quarantine, signal)
  const witness = await scratchMarkerState(
    node,
    operationScratchQuarantineWitnessPath(quarantine),
    quarantine,
    record,
    signal,
  )
  if (directory === 'missing') {
    if (witness === 'owned') return { kind: 'witness-only' }
    return { kind: witness }
  }
  if (directory !== 'owned') return { kind: directory }
  const internal = await scratchMarkerState(node, join(quarantine.path, 'owner'), quarantine, record, signal)
  if (await scratchDirectoryState(node, quarantine, signal) !== 'owned') return { kind: 'foreign' }
  if (internal === 'owned' && witness === 'missing') return { kind: 'owned', marker: 'internal' }
  if (internal === 'missing' && witness === 'owned') return { kind: 'owned', marker: 'external' }
  if (internal === 'unavailable' || witness === 'unavailable') return { kind: 'unavailable' }
  return { kind: 'foreign' }
}

async function removeQuarantinedScratch(
  node: LocalGitMutationNodeAdapter,
  quarantine: LocalHostOperationScratch,
  original: LocalHostOperationScratch,
  record: LocalHostOperationRecord,
  signal: AbortSignal,
  initial: ScratchQuarantineState,
): Promise<void> {
  if (initial.kind === 'witness-only') {
    await unlinkOwnedLockByIdentity(
      node,
      operationScratchQuarantineWitnessPath(quarantine),
      quarantine.ownerIdentity,
    )
    return
  }
  /* v8 ignore next -- both private callers pass only owned or witness-only states, and witness-only returns above. */
  if (initial.kind !== 'owned') return
  if (initial.marker === 'internal') {
    try {
      await node.rename(
        join(quarantine.path, 'owner'),
        operationScratchQuarantineWitnessPath(quarantine),
      )
    } catch {
      // The durable identity checks below distinguish acknowledgement loss from a collision.
    }
    const moved = await quarantineScratchState(node, quarantine, record, signal)
    if (moved.kind !== 'owned' || moved.marker !== 'external') {
      await restoreQuarantinedScratch(node, quarantine, original, record, signal)
      throw new RetryableMutationError('unavailable')
    }
  }
  try {
    await removeOwnedScratchPayload(node, quarantine, signal)
  } catch (error) {
    if (await scratchPayloadState(node, quarantine, signal) !== 'missing') {
      await restoreQuarantinedScratch(node, quarantine, original, record, signal)
      throw error
    }
  }
  const beforeWrapperRemoval = await quarantineScratchState(node, quarantine, record, signal)
  if (beforeWrapperRemoval.kind !== 'owned' || beforeWrapperRemoval.marker !== 'external') {
    throw new RetryableMutationError('unavailable')
  }
  try {
    await node.rmdir(quarantine.path)
  } catch (error) {
    if (await scratchDirectoryState(node, quarantine, signal) !== 'missing') {
      await restoreQuarantinedScratch(node, quarantine, original, record, signal)
      throw error
    }
  }
  await unlinkOwnedLockByIdentity(
    node,
    operationScratchQuarantineWitnessPath(quarantine),
    quarantine.ownerIdentity,
  )
}

type NodeIdentity = { readonly device: string; readonly inode: string }
type OwnedDirectoryState = 'missing' | 'foreign' | 'owned' | 'unavailable'

async function removeOwnedScratchPayload(
  node: LocalGitMutationNodeAdapter,
  scratch: LocalHostOperationScratch,
  signal: AbortSignal,
): Promise<void> {
  const state = await scratchPayloadState(node, scratch, signal)
  if (state === 'missing') return
  if (state !== 'owned') throw new RetryableMutationError('unavailable')
  await removeOwnedDirectoryByIdentity(
    node,
    operationScratchPayloadPath(scratch),
    scratch.payloadIdentity,
    signal,
  )
}

async function scratchPayloadState(
  node: LocalGitMutationNodeAdapter,
  scratch: LocalHostOperationScratch,
  signal: AbortSignal,
): Promise<OwnedDirectoryState> {
  return await ownedDirectoryState(
    node,
    operationScratchPayloadPath(scratch),
    scratch.payloadIdentity,
    signal,
  )
}

async function removeOwnedDirectoryByIdentity(
  node: LocalGitMutationNodeAdapter,
  path: string,
  identity: NodeIdentity,
  signal: AbortSignal,
): Promise<void> {
  const initial = await ownedDirectoryState(node, path, identity, signal)
  if (initial === 'missing') return
  if (initial !== 'owned') throw new RetryableMutationError('unavailable')
  let entries: readonly string[]
  try {
    entries = await node.readdir(path)
    signal.throwIfAborted()
  } catch (error) {
    signal.throwIfAborted()
    if (await ownedDirectoryState(node, path, identity, signal) === 'missing') return
    throw error
  }
  if (await ownedDirectoryState(node, path, identity, signal) !== 'owned') {
    throw new RetryableMutationError('unavailable')
  }
  for (const entry of entries) {
    if (await ownedDirectoryState(node, path, identity, signal) !== 'owned') {
      throw new RetryableMutationError('unavailable')
    }
    await removeOwnedScratchPayloadEntry(node, join(path, entry), signal)
  }
  const beforeRemoval = await ownedDirectoryState(node, path, identity, signal)
  if (beforeRemoval === 'missing') return
  if (beforeRemoval !== 'owned') throw new RetryableMutationError('unavailable')
  try {
    await node.rmdir(path)
  } catch (error) {
    if (await ownedDirectoryState(node, path, identity, signal) !== 'missing') throw error
  }
}

async function removeOwnedScratchPayloadEntry(
  node: LocalGitMutationNodeAdapter,
  path: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  let initial: BigIntStats
  try {
    initial = await node.lstat(path)
    signal.throwIfAborted()
  } catch (error) {
    signal.throwIfAborted()
    if (isNodeError(error, 'ENOENT')) return
    throw error
  }
  const identity = { device: initial.dev.toString(), inode: initial.ino.toString() }
  if (initial.isDirectory() && !initial.isSymbolicLink()) {
    await removeOwnedDirectoryByIdentity(node, path, identity, signal)
    return
  }
  let confirmed: BigIntStats
  try {
    confirmed = await node.lstat(path)
    signal.throwIfAborted()
  } catch (error) {
    signal.throwIfAborted()
    if (isNodeError(error, 'ENOENT')) return
    throw error
  }
  if (!nodeIdentityMatches(confirmed, identity)
    || confirmed.isDirectory() !== initial.isDirectory()
    || confirmed.isSymbolicLink() !== initial.isSymbolicLink()) {
    throw new RetryableMutationError('unavailable')
  }
  try {
    await node.unlink(path)
  } catch (error) {
    if (!await nodePathMissing(node, path, signal)) throw error
  }
}

async function ownedDirectoryState(
  node: LocalGitMutationNodeAdapter,
  path: string,
  identity: NodeIdentity,
  signal: AbortSignal,
): Promise<OwnedDirectoryState> {
  signal.throwIfAborted()
  try {
    const info = await node.lstat(path)
    signal.throwIfAborted()
    return info.isDirectory() && !info.isSymbolicLink() && nodeIdentityMatches(info, identity)
      ? 'owned'
      : 'foreign'
  } catch (error) {
    signal.throwIfAborted()
    return isNodeError(error, 'ENOENT') ? 'missing' : 'unavailable'
  }
}

function nodeIdentityMatches(info: BigIntStats, identity: NodeIdentity): boolean {
  return info.dev.toString() === identity.device && info.ino.toString() === identity.inode
}

/**
 * Probe whether one Node path is absent after a failed mutation.
 * @param node - narrow no-follow metadata probe.
 * @param path - exact path whose absence acknowledges the mutation.
 * @param signal - caller cancellation, checked after the probe settles.
 * @returns `true` only for Node's ENOENT result; all other settled outcomes return `false`.
 * @throws {unknown} the caller's abort reason when cancellation wins the probe.
 * @internal
 */
export async function nodePathMissing(
  node: { readonly lstat: (path: string) => Promise<unknown> },
  path: string,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    await node.lstat(path)
    signal.throwIfAborted()
    return false
  } catch (error) {
    signal.throwIfAborted()
    return isNodeError(error, 'ENOENT')
  }
}

async function restoreQuarantinedScratch(
  node: LocalGitMutationNodeAdapter,
  quarantine: LocalHostOperationScratch,
  original: LocalHostOperationScratch,
  record: LocalHostOperationRecord,
  signal: AbortSignal,
): Promise<void> {
  if (await scratchDirectoryState(node, original, signal) !== 'missing') return
  const state = await quarantineScratchState(node, quarantine, record, signal)
  if (state.kind === 'owned' && state.marker === 'external') {
    try {
      await node.rename(
        operationScratchQuarantineWitnessPath(quarantine),
        join(quarantine.path, 'owner'),
      )
    } catch {
      // A refused marker restore retains the deterministic quarantine evidence for replay.
    }
    const restored = await quarantineScratchState(node, quarantine, record, signal)
    if (restored.kind !== 'owned' || restored.marker !== 'internal') return
  } else if (state.kind === 'missing' || state.kind === 'witness-only' || state.kind === 'unavailable') {
    return
  }
  try {
    await node.rename(quarantine.path, original.path)
  } catch {
    // A refused best-effort restore leaves both pathnames untouched for manual cleanup.
  }
}

async function removeEmptyScratchDirectoryByIdentity(
  node: LocalGitMutationNodeAdapter,
  path: string,
  identity: { readonly device: string; readonly inode: string },
): Promise<void> {
  try {
    const info = await node.lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()
      || info.dev.toString() !== identity.device || info.ino.toString() !== identity.inode) return
    await node.rmdir(path)
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error
  }
}

function isOperationScratchPath(path: string): boolean {
  const target = resolve(path)
  return path === target
    && resolve(target, '..') === resolve(tmpdir())
    && basename(target).startsWith('saki-host-operation-')
}

function operationScratchMarker(record: LocalHostOperationRecord): Buffer {
  return Buffer.from(
    `saki-host-operation-scratch/v1\0${record.snapshot.operation.id}\0${record.snapshot.requestFingerprint.digest}\0`,
    'utf8',
  )
}

function operationLockMarker(record: LocalHostOperationRecord): Buffer {
  return localHostOperationIndexLockMarker(
    record.snapshot.operation.id,
    record.snapshot.requestFingerprint.digest,
  )
}

async function assertIndexLockAvailable(
  path: string,
  node: LocalGitMutationNodeAdapter,
): Promise<void> {
  try {
    await node.lstat(path)
    throw new RetryableMutationError('busy')
  } catch (error) {
    if (error instanceof RetryableMutationError) throw error
    if (!isNodeError(error, 'ENOENT')) throw new RetryableMutationError('unavailable')
  }
}

async function createIndexPin(
  node: LocalGitMutationNodeAdapter,
  record: LocalHostOperationRecord,
  bytes: Uint8Array,
  mode: number | undefined,
): Promise<LocalHostIndexPinEvidence> {
  const indexPath = boundIndexPath(record)
  const directory = dirname(indexPath)
  const prefix = `${basename(indexPath)}.saki-${record.snapshot.operation.id}-`
  const directoryInfo = await node.lstat(directory)
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const path = join(directory, `${prefix}${randomBytes(16).toString('hex')}.pin`)
    let handle: LocalGitMutationFileHandle
    try {
      handle = await node.open(path, 'wx', mode ?? 0o666)
    } catch (error) {
      if (isNodeError(error, 'EEXIST')) continue
      throw new RetryableMutationError('unavailable')
    }
    let identity: { readonly device: string; readonly inode: string } | undefined
    try {
      const initial = await handle.stat()
      identity = { device: initial.dev.toString(), inode: initial.ino.toString() }
      /* v8 ignore start -- a successful Node `wx` open returns a regular file, never a symlink. */
      if (!initial.isFile() || initial.isSymbolicLink()) {
        throw new RetryableMutationError('unavailable')
      }
      /* v8 ignore stop */
      if (initial.dev !== directoryInfo.dev) throw new RetryableMutationError('unavailable')
      if (node.platform === 'win32' && mode !== undefined) {
        await node.copyFileDacl(indexPath, path)
      }
      await handle.writeFile(bytes)
      if (mode !== undefined) await handle.chmod(mode)
      await handle.sync()
      const complete = await handle.stat()
      const completeMode = Number(complete.mode & 0o777n)
      /* v8 ignore start -- metadata identity cannot change for the same open Node file handle. */
      if (complete.dev !== initial.dev || complete.ino !== initial.ino) {
        throw new RetryableMutationError('unavailable')
      }
      /* v8 ignore stop */
      if (complete.size !== BigInt(bytes.byteLength)
        || (mode !== undefined && completeMode !== mode)) {
        throw new RetryableMutationError('unavailable')
      }
      await handle.close()
      await node.syncDirectory(directory)
      return { path, digest: byteDigest(bytes), byteLength: bytes.byteLength, identity, mode: completeMode }
    } catch (error) {
      await Promise.allSettled([handle.close()])
      if (identity !== undefined) {
        await Promise.allSettled([unlinkOwnedLockByIdentity(node, path, identity)])
      }
      throw error
    }
  }
  throw new RetryableMutationError('unavailable')
}

function isOperationIndexPinPath(record: LocalHostOperationRecord, path: string): boolean {
  const indexPath = boundIndexPath(record)
  const prefix = `${basename(indexPath)}.saki-${record.snapshot.operation.id}-`
  const name = basename(path)
  return dirname(path) === dirname(indexPath)
    && name.startsWith(prefix)
    && /^[0-9a-f]{32}\.pin$/u.test(name.slice(prefix.length))
}

async function indexPinMatches(
  record: LocalHostOperationRecord,
  pin: LocalHostIndexPinEvidence,
  maxBytes: number,
  signal: AbortSignal,
  node: LocalGitMutationNodeAdapter = localGitMutationNodeAdapter,
): Promise<boolean> {
  signal.throwIfAborted()
  /* v8 ignore next -- private callers pass schema-validated or newly created operation-owned pin paths. */
  if (!isOperationIndexPinPath(record, pin.path)) return false
  try {
    const directory = await node.lstat(dirname(pin.path))
    const info = await node.lstat(pin.path)
    signal.throwIfAborted()
    if (info.dev !== directory.dev || Number(info.mode & 0o777n) !== pin.mode) return false
  } catch {
    signal.throwIfAborted()
    return false
  }
  return await ownedFileMatches(pin.path, pin, maxBytes, signal, node)
}

async function indexPinAndLockMatch(
  record: LocalHostOperationRecord,
  pin: LocalHostIndexPinEvidence,
  maxBytes: number,
  signal: AbortSignal,
  node: LocalGitMutationNodeAdapter = localGitMutationNodeAdapter,
): Promise<boolean> {
  if (!await indexPinMatches(record, pin, maxBytes, signal, node)) return false
  return await ownedFileMatches(`${boundIndexPath(record)}.lock`, pin, maxBytes, signal, node)
}

async function acquireIndexPublicationLock(
  record: LocalHostOperationRecord,
  pin: LocalHostIndexPinEvidence,
  maxBytes: number,
  signal: AbortSignal,
  node: LocalGitMutationNodeAdapter = localGitMutationNodeAdapter,
): Promise<void> {
  if (!await indexPinMatches(record, pin, maxBytes, signal, node)) {
    throw new RetryableMutationError('unavailable')
  }
  const lockPath = `${boundIndexPath(record)}.lock`
  try {
    signal.throwIfAborted()
    await node.link(pin.path, lockPath)
    await node.syncDirectory(dirname(lockPath))
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) throw new RetryableMutationError('unavailable')
    if (!await indexPinAndLockMatch(record, pin, maxBytes, signal, node)) {
      throw new RetryableMutationError('busy')
    }
    return
  }
  if (!await indexPinAndLockMatch(record, pin, maxBytes, signal, node)) {
    throw new RetryableMutationError('unavailable')
  }
}

async function requireExpectedIndexAfterLock(
  record: LocalHostOperationRecord,
  expected: LocalHostIndexFileEvidence,
  maxBytes: number,
  signal: AbortSignal,
  node: LocalGitMutationNodeAdapter,
): Promise<void> {
  const actual = await readIndexEvidence(node, boundIndexPath(record), maxBytes, signal)
  if (!sameIndexEvidence(actual, expected)) {
    throw new NoEffectMutationError('observation-stale')
  }
}

async function publishOwnedIndexLock(
  node: LocalGitMutationNodeAdapter,
  record: LocalHostOperationRecord,
  expected: LocalHostIndexFileEvidence,
  pin: LocalHostIndexPinEvidence,
  maxBytes: number,
  signal: AbortSignal,
): Promise<void> {
  if (!await indexPinAndLockMatch(record, pin, maxBytes, signal, node)) {
    throw new Error('owned Git index lock changed before publication')
  }
  signal.throwIfAborted()
  const indexPath = boundIndexPath(record)
  const lockPath = `${indexPath}.lock`
  if (expected.kind === 'missing') {
    await node.link(lockPath, indexPath)
  } else if (node.platform === 'win32') {
    await node.replaceFile(indexPath, lockPath)
  } else {
    await node.rename(lockPath, indexPath)
  }
  await node.syncDirectory(dirname(indexPath))
}

async function removeOwnedIndexLock(
  record: LocalHostOperationRecord,
  pin: LocalHostIndexPinEvidence,
  maxBytes: number,
  node: LocalGitMutationNodeAdapter,
): Promise<void> {
  const signal = new AbortController().signal
  const lockPath = `${boundIndexPath(record)}.lock`
  const before = await ownedFileState(lockPath, pin, maxBytes, signal, node)
  if (before === 'unavailable' || before === 'owned-corrupt') {
    throw new RetryableMutationError('unavailable')
  }
  if (before === 'owned') await unlinkOwnedLock(lockPath, pin, maxBytes, signal, node)
  await node.syncDirectory(dirname(lockPath))
  const after = await ownedFileState(lockPath, pin, maxBytes, signal, node)
  if (after === 'owned' || after === 'owned-corrupt' || after === 'unavailable') {
    throw new RetryableMutationError('unavailable')
  }
}

async function removeOwnedIndexPin(
  record: LocalHostOperationRecord,
  pin: LocalHostIndexPinEvidence,
  maxBytes: number,
  node: LocalGitMutationNodeAdapter,
): Promise<void> {
  /* v8 ignore next -- private callers pass schema-validated or newly created operation-owned pin paths. */
  if (!isOperationIndexPinPath(record, pin.path)) return
  await unlinkOwnedLock(pin.path, pin, maxBytes, new AbortController().signal, node)
  await node.syncDirectory(dirname(pin.path))
}

async function unlinkOwnedLock(
  path: string,
  evidence: LocalHostIndexPinEvidence,
  maxBytes: number,
  signal: AbortSignal,
  node: LocalGitMutationNodeAdapter,
): Promise<void> {
  try {
    if (!await ownedFileMatches(path, evidence, maxBytes, signal, node)) return
    const info = await node.lstat(path)
    signal.throwIfAborted()
    if (!info.isFile() || info.isSymbolicLink()
      || info.dev.toString() !== evidence.identity.device || info.ino.toString() !== evidence.identity.inode
      || info.size !== BigInt(evidence.byteLength) || Number(info.mode & 0o777n) !== evidence.mode) return
    await node.rm(path, { force: false })
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error
  }
}

async function unlinkOwnedLockByIdentity(
  node: LocalGitMutationNodeAdapter,
  path: string,
  identity: { readonly device: string; readonly inode: string },
): Promise<void> {
  try {
    const info = await node.lstat(path)
    if (!info.isFile() || info.isSymbolicLink()
      || info.dev.toString() !== identity.device || info.ino.toString() !== identity.inode) return
    await node.rm(path, { force: false })
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error
  }
}

async function ownedFileMatches(
  path: string,
  evidence: LocalHostIndexPinEvidence,
  maxBytes: number,
  signal: AbortSignal,
  node: LocalGitMutationNodeAdapter = localGitMutationNodeAdapter,
): Promise<boolean> {
  return await ownedFileState(path, evidence, maxBytes, signal, node) === 'owned'
}

type OwnedFileState = 'missing' | 'foreign' | 'owned' | 'owned-corrupt' | 'unavailable'

async function ownedFileState(
  path: string,
  evidence: LocalHostIndexPinEvidence,
  maxBytes: number,
  signal: AbortSignal,
  node: LocalGitMutationNodeAdapter = localGitMutationNodeAdapter,
): Promise<OwnedFileState> {
  signal.throwIfAborted()
  let pathInfo: BigIntStats
  try {
    pathInfo = await node.lstat(path)
    signal.throwIfAborted()
  } catch (error) {
    const failure = decideOwnedFileReadFailure(error, { aborted: signal.aborted, reason: signal.reason })
    if (failure.kind === 'aborted') throw failure.reason
    return failure.state
  }
  const pathObservation = ownedFileStatObservation(pathInfo)
  const pathState = classifyOwnedFileObservation({ kind: 'path', stat: pathObservation }, evidence, maxBytes)
  if (pathState !== 'continue') return pathState
  let handle: LocalGitMutationFileHandle | undefined
  try {
    handle = await node.open(path, 'r')
    const before = await handle.stat()
    signal.throwIfAborted()
    const beforeObservation = ownedFileStatObservation(before)
    const openedState = classifyOwnedFileObservation(
      { kind: 'opened', path: pathObservation, opened: beforeObservation },
      evidence,
      maxBytes,
    )
    if (openedState !== 'continue') return openedState
    const bytes = await readExactHandle(handle, evidence.byteLength, signal)
    const contentsState = classifyOwnedFileObservation(
      { kind: 'contents', digest: bytes === undefined ? undefined : byteDigest(bytes) },
      evidence,
      maxBytes,
    )
    if (contentsState !== 'continue') return contentsState
    const after = await handle.stat()
    signal.throwIfAborted()
    const postReadState = classifyOwnedFileObservation(
      { kind: 'post-read', before: beforeObservation, after: ownedFileStatObservation(after) },
      evidence,
      maxBytes,
    )
    if (postReadState !== 'continue') return postReadState
    const current = await node.lstat(path)
    signal.throwIfAborted()
    return classifyOwnedFileObservation(
      { kind: 'current', before: beforeObservation, current: ownedFileStatObservation(current) },
      evidence,
      maxBytes,
    )
  } catch (error) {
    const failure = decideOwnedFileReadFailure(error, { aborted: signal.aborted, reason: signal.reason })
    if (failure.kind === 'aborted') throw failure.reason
    return failure.state
  } finally {
    await handle?.close().catch(() => undefined)
    signal.throwIfAborted()
  }
}

function ownedFileStatObservation(info: BigIntStats): OwnedFileStatObservation {
  return {
    device: info.dev.toString(),
    inode: info.ino.toString(),
    byteLength: info.size,
    mode: Number(info.mode & 0o777n),
    kind: info.isSymbolicLink() ? 'symlink' : info.isFile() ? 'file' : 'other',
    modifiedNanoseconds: info.mtimeNs,
    changedNanoseconds: info.ctimeNs,
  }
}

async function readExactHandle(
  handle: LocalGitMutationFileHandle,
  byteLength: number,
  signal: AbortSignal,
): Promise<Buffer | undefined> {
  signal.throwIfAborted()
  const bytes = Buffer.alloc(byteLength)
  let offset = 0
  while (offset < byteLength) {
    const read = await handle.read(bytes, offset, byteLength - offset, offset)
    signal.throwIfAborted()
    if (read.bytesRead === 0) return undefined
    offset += read.bytesRead
  }
  const extra = Buffer.allocUnsafe(1)
  const probe = await handle.read(extra, 0, 1, byteLength)
  signal.throwIfAborted()
  return probe.bytesRead === 0 ? bytes : undefined
}

async function readIndexEvidence(
  node: LocalGitMutationNodeAdapter,
  path: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<LocalHostIndexFileEvidence> {
  signal.throwIfAborted()
  try {
    const { bytes, mode } = await readFileWithModeBounded(node, path, maxBytes, signal)
    return { kind: 'file', digest: byteDigest(bytes), byteLength: bytes.byteLength, mode }
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof InitiallyMissingBoundedFileError) return { kind: 'missing' }
    if (error instanceof NoEffectMutationError || error instanceof RetryableMutationError) throw error
    /* v8 ignore next -- readFileBounded maps every Node system error to RetryableMutationError. */
    if (isNodeSystemError(error)) throw new RetryableMutationError('unavailable')
    throw error
  }
}

async function readFileBounded(
  node: LocalGitMutationNodeAdapter,
  path: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  return (await readFileWithModeBounded(node, path, maxBytes, signal)).bytes
}

async function readFileWithModeBounded(
  node: LocalGitMutationNodeAdapter,
  path: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ readonly bytes: Buffer; readonly mode: number }> {
  signal.throwIfAborted()
  let pathBefore: BigIntStats
  try {
    pathBefore = await node.lstat(path)
  } catch (error) {
    signal.throwIfAborted()
    if (isNodeError(error, 'ENOENT')) throw new InitiallyMissingBoundedFileError()
    if (isNodeSystemError(error)) throw new RetryableMutationError('unavailable')
    throw error
  }
  signal.throwIfAborted()
  const byteLength = boundedRegularFileByteLength(pathBefore, maxBytes)
  if (byteLength === undefined) throw new NoEffectMutationError('unsupported-state')
  let handle: LocalGitMutationFileHandle | undefined
  try {
    handle = await node.open(path, 'r')
    const openedBefore = await handle.stat()
    signal.throwIfAborted()
    if (!sameBoundedRegularFile(pathBefore, openedBefore, maxBytes)) {
      throw new RetryableMutationError('unavailable')
    }
    const bytes = await readExactHandle(handle, byteLength, signal)
    if (bytes === undefined) throw new RetryableMutationError('unavailable')
    const openedAfter = await handle.stat()
    const pathAfter = await node.lstat(path)
    signal.throwIfAborted()
    if (!sameBoundedRegularFile(openedBefore, openedAfter, maxBytes)
      || !sameBoundedRegularFile(openedAfter, pathAfter, maxBytes)) {
      throw new RetryableMutationError('unavailable')
    }
    return { bytes, mode: Number(pathAfter.mode & 0o777n) }
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof NoEffectMutationError || error instanceof RetryableMutationError) throw error
    if (isNodeSystemError(error)) throw new RetryableMutationError('unavailable')
    throw error
  } finally {
    await handle?.close().catch(() => undefined)
    signal.throwIfAborted()
  }
}

function boundedRegularFileByteLength(info: BigIntStats, maxBytes: number): number | undefined {
  if (!info.isFile() || info.isSymbolicLink() || info.size < 0n
    || info.size > BigInt(Number.MAX_SAFE_INTEGER) || info.size > BigInt(maxBytes)) return undefined
  return Number(info.size)
}

function sameBoundedRegularFile(left: BigIntStats, right: BigIntStats, maxBytes: number): boolean {
  return boundedRegularFileByteLength(right, maxBytes) !== undefined
    && right.dev === left.dev
    && right.ino === left.ino
    && right.size === left.size
    && right.mode === left.mode
    && right.mtimeNs === left.mtimeNs
    && right.ctimeNs === left.ctimeNs
}

/**
 * Read and verify the exact bytes stored in one symbolic-link target.
 * @param node - narrow Node adapter used for the no-follow read.
 * @param absolutePath - already-contained worktree pathname.
 * @param targetDigest - digest captured by stable inventory inspection.
 * @param signal - caller cancellation boundary.
 * @returns the same target-byte Buffer returned by the adapter.
 * @throws {RetryableMutationError} when Node cannot read the current target.
 * @throws {NoEffectMutationError} when the target bytes changed after inspection.
 * @internal
 */
export async function readExactWorktreeSymlinkBytes(
  node: Pick<LocalGitMutationNodeAdapter, 'readlink'>,
  absolutePath: string,
  targetDigest: string,
  signal: AbortSignal,
): Promise<Buffer> {
  signal.throwIfAborted()
  let bytes: Buffer
  try {
    bytes = await node.readlink(absolutePath)
  } catch (error) {
    const decision = decideWorktreeSymlinkReadFailure(
      error,
      { aborted: signal.aborted, reason: signal.reason },
    )
    switch (decision.kind) {
      case 'aborted': throw decision.reason
      case 'retryable': throw new RetryableMutationError(decision.reason)
      case 'unexpected': throw decision.error
    }
  }
  signal.throwIfAborted()
  if (exactBytesDigest('saki/inherited-symlink/v1', bytes) !== targetDigest) {
    throw new NoEffectMutationError('observation-stale')
  }
  return bytes
}

/**
 * Read the exact regular-file or symbolic-link bytes frozen by inventory evidence.
 * @param node - no-follow Node filesystem adapter.
 * @param root - canonical worktree containing `path`.
 * @param path - validated repository-relative path.
 * @param evidence - captured worktree evidence whose digest and length must still match.
 * @param signal - current attempt lifetime.
 * @returns the exact bytes safe to hash into the private Git object store.
 * @throws {NoEffectMutationError} when the path escapes `root` or its evidence has drifted.
 * @internal
 */
export async function readExactWorktreeBytes(
  node: LocalGitMutationNodeAdapter,
  root: string,
  path: string,
  evidence: HashableWorktreeEvidence,
  signal: AbortSignal,
): Promise<Buffer> {
  const absolute = resolve(root, ...path.split('/'))
  const within = relative(root, absolute)
  /* v8 ignore next -- inventory and durable-plan schemas admit only non-empty repository-relative path components. */
  if (within === '' || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    throw new NoEffectMutationError('invalid-selection')
  }
  signal.throwIfAborted()
  if (evidence.kind === 'regular') {
    const bytes = await readFileBounded(node, absolute, evidence.byteLength, signal)
    if (bytes.byteLength !== evidence.byteLength
      || createHash('sha256').update(bytes).digest('hex') !== evidence.contentDigest) {
      throw new NoEffectMutationError('observation-stale')
    }
    return bytes
  }
  return await readExactWorktreeSymlinkBytes(node, absolute, evidence.targetDigest, signal)
}

function inventoryPathMap(
  inventory: CapturedRepositoryInventory,
): ReadonlyMap<string, CapturedRepositoryInventoryEntry> {
  return new Map(inventory.entries.map(entry => [Buffer.from(entry.path).toString('hex'), entry]))
}

function parseObjectId(stdout: Uint8Array, stderr: Uint8Array, record: LocalHostOperationRecord): string {
  return parseGitObjectId(stdout, stderr, objectIdWidth(record))
}

/**
 * Parse one Git command's exact object-id output.
 * @param stdout - bounded raw standard output bytes.
 * @param stderr - bounded raw standard error bytes.
 * @param width - repository object-id width.
 * @returns the nonzero lowercase hexadecimal object id.
 * @throws {GitCommandError} when either stream is not the exact expected form.
 * @internal
 */
export function parseGitObjectId(
  stdout: Uint8Array,
  stderr: Uint8Array,
  width: 40 | 64,
): string {
  if (stderr.byteLength !== 0) throw new GitCommandError('stream-failure')
  let text: string
  try {
    text = UTF8.decode(stdout)
  } catch {
    throw new GitCommandError('stream-failure')
  }
  const match = new RegExp(`^([0-9a-f]{${width}})\\r?\\n$`, 'u').exec(text)
  if (match?.[1] === undefined || /^0+$/u.test(match[1])) throw new GitCommandError('stream-failure')
  return match[1]
}

function boundWorktree(record: LocalHostOperationRecord): string {
  return record.request.expected.binding.expectedInspection.trusted.canonicalWorktreePath
}

function boundIndexPath(record: LocalHostOperationRecord): string {
  return join(record.request.expected.binding.expectedInspection.trusted.canonicalGitDirectory, 'index')
}

function objectIdWidth(record: LocalHostOperationRecord): 40 | 64 {
  return record.request.expected.binding.expectedInspection.projection.objectFormat === 'sha1' ? 40 : 64
}

function byteDigest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function sameIndexEvidence(left: LocalHostIndexFileEvidence, right: LocalHostIndexFileEvidence): boolean {
  return left.kind === 'missing' || right.kind === 'missing'
    ? left.kind === right.kind
    : sameIndexContents(left, right) && left.mode === right.mode
}

function sameIndexContents(left: LocalHostIndexFileEvidence, right: LocalHostIndexFileEvidence): boolean {
  return left.kind === 'missing' || right.kind === 'missing'
    ? left.kind === right.kind
    : left.digest === right.digest && left.byteLength === right.byteLength
}

async function writePrivateFile(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/* v8 ignore start -- Windows cannot open directories for fsync; POSIX Hosts exercise this effect. */
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
/* v8 ignore stop */

function isTerminal(snapshot: HostOperationSnapshot): boolean {
  return snapshot.state === 'succeeded' || snapshot.state === 'failed'
    || snapshot.state === 'canceled' || snapshot.state === 'reconciliation-required'
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return isNodeSystemError(error) && error.code === code
}

function isNodeSystemError(
  error: unknown,
): error is NodeJS.ErrnoException & {
  readonly code: string
  readonly errno: number
  readonly syscall: string
} {
  return error instanceof Error
    && 'code' in error && typeof error.code === 'string'
    && 'errno' in error && typeof error.errno === 'number' && Number.isInteger(error.errno)
    && 'syscall' in error && typeof error.syscall === 'string' && error.syscall.length > 0
}

/** Retryable engine-local failure whose durable operation remains non-terminal. @internal */
export class RetryableMutationError extends Error {
  constructor(readonly reason: 'busy' | 'unavailable') {
    super(`Saki Git mutation is temporarily ${reason}`)
  }
}

class InitiallyMissingBoundedFileError extends RetryableMutationError {
  constructor() {
    super('unavailable')
  }
}

/** Engine-local failure proven to occur before any semantic Git effect. @internal */
export class NoEffectMutationError extends Error {
  constructor(readonly reason: HostOperationFailure['reason']) {
    super(`Saki Git mutation failed before effect: ${reason}`)
  }
}
