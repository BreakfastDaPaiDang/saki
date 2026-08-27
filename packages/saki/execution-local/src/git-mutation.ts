/** Recoverable structured Git mutation engine for the Local Host. @module @breakfastdapaidang/saki-execution-local/git-mutation */

import { createHash, randomBytes } from 'node:crypto'
import {
  chmod,
  lstat,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import {
  canonicalDigest,
  type AppliedProjectGitChange,
  type HostOperationCancellationReason,
  type HostOperationFailure,
  type HostOperationSnapshot,
  type ProjectGitChange,
  type ProjectGitCommitSignature,
  type ProjectGitStatusObservation,
} from '@breakfastdapaidang/saki-execution'
import type { WorkspaceIndex, AdministrativeDirectoryIdentityReader, InspectionConfig } from './inspection.ts'
import {
  BoundProjectResourceMismatchError,
  inspectStableLocalProjectSelection,
} from './inspection.ts'
import { GitCommandError, type GitRunner } from './git-runner.ts'
import type { CapturedRepositoryInventory, CapturedRepositoryInventoryEntry } from './baseline.ts'
import { buildProjectGitStatusObservation, ProjectGitStatusProjectionError } from './status.ts'
import { exactBytesDigest } from './canonical.ts'
import { gitAlternatePath } from './safe-repository.ts'
import type {
  LocalHostIndexFileEvidence,
  LocalHostIndexPinEvidence,
  LocalHostCommitPlan,
  LocalHostOperationEffectPlan,
  LocalHostOperationRecord,
  LocalHostStageFilesPlan,
  LocalHostUnstageFilesPlan,
} from './operation-state.ts'

const UTF8 = new TextDecoder('utf-8', { fatal: true })
const INDEX_LOCK_MARKER_PREFIX = 'saki-host-operation-index-lock/v1\0'

function indexLockMarker(operationId: string, requestFingerprint: string): Buffer {
  return Buffer.from(`${INDEX_LOCK_MARKER_PREFIX}${operationId}\0${requestFingerprint}\0`, 'utf8')
}

/** Smallest index-byte bound that can retain every valid Commit lock marker. */
export const MIN_OPERATION_MAX_INDEX_BYTES = indexLockMarker(
  'host-operation-00000000-0000-4000-8000-000000000000',
  '0'.repeat(64),
).byteLength

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
}

/** One durable record replacement performed before notifying observers. */
export type PersistLocalHostOperation = (record: LocalHostOperationRecord) => Promise<void>

/** Result of one admitted start/resume attempt. */
export type LocalGitMutationAdvanceResult =
  | { readonly kind: 'advanced'; readonly record: LocalHostOperationRecord }
  | { readonly kind: 'retryable'; readonly reason: 'busy' | 'unavailable'; readonly record: LocalHostOperationRecord }

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
    record = transitionToPlanning(record)
    await persist(record)
  }
  if (record.snapshot.state !== 'planning') {
    return { kind: 'retryable', reason: 'unavailable', record }
  }

  try {
    const prepared = record.request.type === 'commit'
      ? await prepareCommitPublication(dependencies, record, signal)
      : await prepareIndexPublication(dependencies, record, signal)
    record = transitionToPublishing(record, prepared.plan)
    try {
      await persist(record)
    } catch (error) {
      if (dependencies.isOperationDurable(record)) await prepared.release()
      else await prepared.discard()
      throw error
    }
    try {
      await prepared.prepareAttempt()
    } catch (error) {
      await prepared.release()
      throw error
    }
    record = withPublication(record, 'attempting')
    try {
      await persist(record)
    } catch (error) {
      await prepared.release()
      throw error
    }
    try {
      await prepared.publish()
    } catch {
      await prepared.release()
    }
    return await recoverPublishingOperation(dependencies, record, persist, signal, true)
  } catch (error) {
    if (signal.aborted) throw signal.reason
    if (error instanceof RetryableMutationError) {
      return { kind: 'retryable', reason: error.reason, record }
    }
    if (error instanceof NoEffectMutationError) {
      const failed = await persistNoEffectFailure(dependencies, record, persist, error.reason)
      return { kind: 'advanced', record: failed }
    }
    if (error instanceof GitCommandError) {
      return { kind: 'retryable', reason: 'unavailable', record }
    }
    throw error
  }
}

/**
 * Recover a publishing operation using Git evidence only; it never creates a
 * new commit, index target, or ref transition.
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
  if (initial.snapshot.state !== 'publishing' || plan === undefined) {
    return { kind: 'retryable', reason: 'unavailable', record: initial }
  }
  if (plan.kind === 'commit') {
    return await recoverCommitPublication(dependencies, initial, plan, persist, signal, allowResume)
  }
  const indexPath = boundIndexPath(initial)
  const actual = await readIndexEvidence(indexPath, dependencies.config.operationMaxIndexBytes, signal)
  if (sameIndexEvidence(actual, plan.targetIndexFile)) {
    const succeeded = transitionToSuccess(initial, plan)
    await persistTerminalOperation(dependencies, succeeded, persist)
    return { kind: 'advanced', record: succeeded }
  }
  if (plan.publication === 'not-started' && sameIndexEvidence(actual, plan.expectedIndexFile)) {
    return allowResume
      ? await resumeNotStartedIndexPublication(dependencies, initial, plan, persist, signal)
      : { kind: 'retryable', reason: 'unavailable', record: initial }
  }
  if (plan.publication === 'not-started') {
    const failed = await persistNoEffectFailure(dependencies, initial, persist, 'observation-stale')
    return { kind: 'advanced', record: failed }
  }
  const reconciled = transitionToReconciliation(initial, 'evidence-conflict')
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
    const canceled = transitionToCancellation(recovered.record, reason)
    await persistTerminalOperation(dependencies, canceled, persist)
    return canceled
  }
  if (plan?.kind !== 'index') return recovered.record
  if (plan.publication !== 'not-started') return recovered.record
  const actual = await readIndexEvidence(
    boundIndexPath(recovered.record),
    dependencies.config.operationMaxIndexBytes,
    signal,
  )
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
    if (error instanceof GitCommandError) {
      return { kind: 'retryable', reason: 'unavailable', record }
    }
    throw error
  }
  if (current === plan.result.commitId) {
    const succeeded = transitionToSuccess(record, plan)
    await persistTerminalOperation(dependencies, succeeded, persist)
    return { kind: 'advanced', record: succeeded }
  }
  const reflog = plan.publication === 'not-started'
    ? 'absent'
    : await inspectCommitReflog(dependencies, record, plan, signal)
  if (reflog === 'unavailable') return { kind: 'retryable', reason: 'unavailable', record }
  if (reflog === 'found') {
    const succeeded = transitionToSuccess(record, plan)
    await persistTerminalOperation(dependencies, succeeded, persist)
    return { kind: 'advanced', record: succeeded }
  }
  const expected = /^0+$/u.test(plan.expectedOldObjectId) ? undefined : plan.expectedOldObjectId
  if (plan.publication === 'not-started' && current === expected) {
    const expectedHead = record.request.expected.head
    if (expectedHead.kind === 'commit' && expectedHead.symbolicRef === undefined) {
      const failed = await persistNoEffectFailure(dependencies, record, persist, 'unsupported-state')
      return { kind: 'advanced', record: failed }
    }
    return allowResume
      ? await resumeNotStartedCommitPublication(dependencies, record, plan, persist, signal)
      : { kind: 'retryable', reason: 'unavailable', record }
  }
  if (plan.publication === 'not-started') {
    return {
      kind: 'advanced',
      record: await persistNoEffectFailure(dependencies, record, persist, 'observation-stale'),
    }
  }
  const reconciled = transitionToReconciliation(
    record,
    reflog === 'limit' ? 'effect-unknown' : 'evidence-conflict',
  )
  await persistTerminalOperation(dependencies, reconciled, persist)
  return { kind: 'advanced', record: reconciled }
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
    return parseObjectId(stdout, stderr, record)
  } catch (error) {
    if (error instanceof GitCommandError && error.code === 'nonzero'
      && (error.exitCode === 1 || error.exitCode === 128)) return undefined
    throw error
  }
}

type CommitReflogInspection = 'found' | 'absent' | 'limit' | 'unavailable'

async function inspectCommitReflog(
  dependencies: LocalGitMutationDependencies,
  record: LocalHostOperationRecord,
  plan: LocalHostCommitPlan,
  signal: AbortSignal,
): Promise<CommitReflogInspection> {
  signal.throwIfAborted()
  const path = commitReflogPath(record, plan)
  let before
  try {
    before = await lstat(path, { bigint: true })
  } catch (error) {
    return isNodeError(error, 'ENOENT') ? 'absent' : 'unavailable'
  }
  if (!before.isFile() || before.isSymbolicLink()) return 'unavailable'
  if (before.size > BigInt(dependencies.config.operationMaxReflogBytes)) return 'limit'
  let bytes: Buffer
  try {
    bytes = await readFile(path)
    const after = await lstat(path, { bigint: true })
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) return 'unavailable'
  } catch {
    return 'unavailable'
  }
  if (bytes.byteLength > dependencies.config.operationMaxReflogBytes) return 'limit'
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
  if (plan.targetRef === 'HEAD') return join(trusted.canonicalGitDirectory, 'logs', 'HEAD')
  const logsRoot = resolve(trusted.canonicalCommonGitDirectory, 'logs')
  const target = resolve(logsRoot, ...plan.targetRef.split('/'))
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
  if (!await scratchOwnershipMatches(plan.scratch, record, signal)) {
    return { kind: 'retryable', reason: 'unavailable', record }
  }
  assertCommitHasStagedChange(await observeAndValidate(dependencies, record, signal))
  try {
    if (!await indexPinMatches(record, plan.pin, dependencies.config.operationMaxIndexBytes, signal)) {
      return { kind: 'retryable', reason: 'unavailable', record }
    }
  } catch (error) {
    if (error instanceof RetryableMutationError) {
      return { kind: 'retryable', reason: error.reason, record }
    }
    throw error
  }
  let latest = record
  try {
    const privateCommitId = await createCommitObject(
      dependencies,
      record,
      join(plan.scratch.path, 'hooks'),
      plan.result.committer,
      {
        objectDirectory: join(plan.scratch.path, 'objects'),
        indexFile: join(plan.scratch.path, 'commit.index'),
      },
      signal,
    )
    if (privateCommitId !== plan.result.commitId) {
      throw new NoEffectMutationError('unsupported-state')
    }
    await prepareCommitAttempt(dependencies, record, plan, signal)
    const next = withPublication(record, 'attempting')
    await persist(next)
    latest = next
    try {
      await publishCommitPlan(dependencies, next, next.effectPlan as LocalHostCommitPlan, signal)
    } catch {
      await removeCommitLocks(dependencies, next, next.effectPlan as LocalHostCommitPlan)
    }
    return await recoverPublishingOperation(dependencies, next, persist, signal, true)
  } catch (error) {
    await removeOwnedIndexLock(record, plan.pin, dependencies.config.operationMaxIndexBytes)
    if (error instanceof RetryableMutationError) {
      return { kind: 'retryable', reason: error.reason, record: latest }
    }
    if (error instanceof GitCommandError) {
      return { kind: 'retryable', reason: 'unavailable', record: latest }
    }
    if (error instanceof NoEffectMutationError) {
      const failed = await persistNoEffectFailure(dependencies, latest, persist, error.reason)
      return { kind: 'advanced', record: failed }
    }
    throw error
  }
}

async function commitLocksMatch(
  record: LocalHostOperationRecord,
  plan: LocalHostCommitPlan,
  maxBytes: number,
  signal: AbortSignal,
): Promise<boolean> {
  return await indexPinAndLockMatch(record, plan.pin, maxBytes, signal)
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
    removeOwnedIndexPin(record, record.effectPlan.pin, dependencies.config.operationMaxIndexBytes),
    removeOwnedScratch(record.effectPlan.scratch, record),
  ])
}

async function removeCommitLocks(
  dependencies: LocalGitMutationDependencies,
  record: LocalHostOperationRecord,
  plan: LocalHostCommitPlan,
): Promise<void> {
  await removeOwnedIndexLock(record, plan.pin, dependencies.config.operationMaxIndexBytes)
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
): () => Promise<void> {
  return async () => {
    if (pin.value !== undefined) {
      await removeOwnedIndexLock(record, pin.value, dependencies.config.operationMaxIndexBytes)
    }
  }
}

async function prepareCommitPublication(
  dependencies: LocalGitMutationDependencies,
  record: LocalHostOperationRecord,
  signal: AbortSignal,
): Promise<PreparedCommitPublication> {
  if (record.request.type !== 'commit') throw new NoEffectMutationError('unsupported-state')
  assertAttachedCommit(record)
  assertCommitHasStagedChange(await observeAndValidate(dependencies, record, signal))
  const scratch = await createOwnedScratch(record)
  const hooksDirectory = join(scratch.path, 'hooks')
  const objectDirectory = join(scratch.path, 'objects')
  const commitIndexPath = join(scratch.path, 'commit.index')
  await mkdir(hooksDirectory, { mode: 0o700 })
  await mkdir(objectDirectory, { mode: 0o700 })
  await mkdir(join(objectDirectory, 'info'), { mode: 0o700 })
  await writePrivateFile(
    join(objectDirectory, 'info', 'alternates'),
    Buffer.from(`${gitAlternatePath(join(
      record.request.expected.binding.expectedInspection.trusted.canonicalCommonGitDirectory,
      'objects',
    ))}\n`, 'utf8'),
  )
  const indexMarker = operationLockMarker(record)
  const head = record.request.expected.head
  const symbolicRef = head.symbolicRef
  let pin: LocalHostIndexPinEvidence | undefined
  const pinReference: PreparedIndexPinReference = {}
  const release = preparedIndexLockRelease(dependencies, record, pinReference)
  try {
    await assertIndexLockAvailable(`${boundIndexPath(record)}.lock`)
    const stable = await observeAndValidate(dependencies, record, signal)
    assertCommitHasStagedChange(stable)
    await writePrivateFile(commitIndexPath, await readFileBounded(
      boundIndexPath(record),
      dependencies.config.operationMaxIndexBytes,
      signal,
    ))
    const signature = await readCommitSignature(dependencies.git, boundWorktree(record), signal)
    const resultTarget = symbolicRef !== undefined
      ? { kind: 'symbolic-ref' as const, ref: symbolicRef }
      : { kind: 'detached-head' as const }
    const objectWidth = objectIdWidth(record)
    const expectedOldObjectId = head.kind === 'unborn' ? '0'.repeat(objectWidth) : head.objectId
    const parent = head.kind === 'unborn'
      ? { kind: 'none' as const }
      : { kind: 'commit' as const, objectId: head.objectId }
    const commitId = await createCommitObject(
      dependencies,
      record,
      hooksDirectory,
      signature,
      { objectDirectory, indexFile: commitIndexPath },
      signal,
    )
    await observeAndValidate(dependencies, record, signal)
    pin = await createIndexPin(record, indexMarker, undefined)
    pinReference.value = pin
    const targetRef = resultTarget.kind === 'symbolic-ref' ? resultTarget.ref : 'HEAD'
    const plan: LocalHostCommitPlan = {
      kind: 'commit',
      scratch,
      publication: 'not-started',
      targetRef,
      expectedOldObjectId,
      reflogMarker: `saki host-operation ${record.snapshot.operation.id}`,
      pin,
      result: {
        type: 'commit',
        commitId,
        treeId: record.request.expected.index.treeId,
        parent,
        target: resultTarget,
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
        } finally {
          await release()
        }
      },
      release,
      discard: async () => {
        await release()
        await removeOwnedIndexPin(record, plan.pin, dependencies.config.operationMaxIndexBytes)
        await removeOwnedScratch(scratch, record)
      },
    }
  } catch (error) {
    await release()
    if (pin !== undefined) {
      await removeOwnedIndexPin(record, pin, dependencies.config.operationMaxIndexBytes)
    }
    await removeOwnedScratch(scratch, record)
    throw error
  }
}

function assertCommitHasStagedChange(observation: StableMutationObservation): void {
  if (!observation.status.changes.some(change => change.kind === 'ordinary'
    && change.indexStatus !== 'unchanged')) {
    throw new NoEffectMutationError('unsupported-state')
  }
}

function assertAttachedCommit(record: LocalHostOperationRecord): void {
  const head = record.request.expected.head
  if (record.request.type !== 'commit'
    || head.kind === 'commit' && head.symbolicRef === undefined) {
    throw new NoEffectMutationError('unsupported-state')
  }
}

async function readCommitSignature(
  git: GitRunner,
  cwd: string,
  signal: AbortSignal,
): Promise<ProjectGitCommitSignature> {
  const name = await readLocalGitConfigValue(git, cwd, 'user.name', signal)
  const email = await readLocalGitConfigValue(git, cwd, 'user.email', signal)
  if (name === undefined || email === undefined || !validCommitIdentity(name) || !validCommitIdentity(email)) {
    throw new NoEffectMutationError('unsupported-state')
  }
  const now = Date.now()
  const timestamp = Math.floor(now / 1_000)
  const timezone = formatGitTimezone(-new Date(now).getTimezoneOffset())
  return { name, email, timestamp, timezone, source: 'git-config' }
}

async function readLocalGitConfigValue(
  git: GitRunner,
  cwd: string,
  key: 'user.name' | 'user.email',
  signal: AbortSignal,
): Promise<string | undefined> {
  for (const scope of ['--worktree', '--local'] as const) {
    try {
      const { stdout, stderr } = await git.run(
        cwd,
        ['config', '--no-includes', scope, '--get', key],
        signal,
      )
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
    } catch (error) {
      if (error instanceof GitCommandError && error.code === 'nonzero' && error.exitCode === 1) continue
      throw error
    }
  }
  return undefined
}

function validCommitIdentity(value: string): boolean {
  return value.length > 0 && value.length <= 1_024 && value.trim() !== '' && !/[\0\r\n<>]/u.test(value)
}

function formatGitTimezone(offsetMinutes: number): string {
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
  hooksDirectory: string,
  objectDirectory: string | undefined,
  indexFile: string,
  signal: AbortSignal,
): Promise<void> {
  const { stdout, stderr } = await dependencies.git.runMutation(
    boundWorktree(record),
    ['write-tree'],
    signal,
    {
      hooksDirectory,
      indexFile,
      ...(objectDirectory === undefined ? {} : { objectDirectory }),
    },
  )
  if (parseObjectId(stdout, stderr, record) !== record.request.expected.index.treeId) {
    throw new NoEffectMutationError('observation-stale')
  }
}

async function createCommitObject(
  dependencies: LocalGitMutationDependencies,
  record: LocalHostOperationRecord,
  hooksDirectory: string,
  signature: ProjectGitCommitSignature,
  objects: { readonly objectDirectory?: string; readonly indexFile: string },
  signal: AbortSignal,
): Promise<string> {
  if (record.request.type !== 'commit') throw new NoEffectMutationError('unsupported-state')
  assertAttachedCommit(record)
  await writeCommitTreeObject(
    dependencies,
    record,
    hooksDirectory,
    objects.objectDirectory,
    objects.indexFile,
    signal,
  )
  const parentArguments = record.request.expected.head.kind === 'commit'
    ? ['-p', record.request.expected.head.objectId]
    : []
  const message = Buffer.from(record.request.message, 'utf8')
  const gitDate = `${signature.timestamp} ${signature.timezone}`
  const { stdout, stderr } = await dependencies.git.runMutation(
    boundWorktree(record),
    ['commit-tree', record.request.expected.index.treeId, ...parentArguments, '-F', '-'],
    signal,
    {
      hooksDirectory,
      ...objects,
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
  if (!await commitLocksMatch(record, plan, dependencies.config.operationMaxIndexBytes, signal)) {
    throw new RetryableMutationError('busy')
  }
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
      hooksDirectory: join(plan.scratch.path, 'hooks'),
      committer: {
        name: plan.result.committer.name,
        email: plan.result.committer.email,
        date: `${plan.result.committer.timestamp} ${plan.result.committer.timezone}`,
      },
    },
  )
  if (stdout.byteLength !== 0 || stderr.byteLength !== 0) throw new GitCommandError('stream-failure')
}

async function prepareCommitAttempt(
  dependencies: LocalGitMutationDependencies,
  record: LocalHostOperationRecord,
  plan: LocalHostCommitPlan,
  signal: AbortSignal,
): Promise<void> {
  assertAttachedCommit(record)
  if (!await scratchOwnershipMatches(plan.scratch, record, signal)) {
    throw new RetryableMutationError('unavailable')
  }
  if (!await indexPinMatches(record, plan.pin, dependencies.config.operationMaxIndexBytes, signal)) {
    throw new RetryableMutationError('unavailable')
  }
  await acquireIndexPublicationLock(record, plan.pin, dependencies.config.operationMaxIndexBytes, signal)
  if (!await commitLocksMatch(record, plan, dependencies.config.operationMaxIndexBytes, signal)) {
    throw new RetryableMutationError('busy')
  }
  assertCommitHasStagedChange(await observeAndValidate(dependencies, record, signal))
  const commitId = await createCommitObject(
    dependencies,
    record,
    join(plan.scratch.path, 'hooks'),
    plan.result.committer,
    { indexFile: join(plan.scratch.path, 'commit.index') },
    signal,
  )
  if (commitId !== plan.result.commitId) throw new Error('deterministic Commit candidate changed')
}

async function prepareIndexPublication(
  dependencies: LocalGitMutationDependencies,
  record: LocalHostOperationRecord,
  signal: AbortSignal,
): Promise<PreparedIndexPublication> {
  if (record.request.type === 'commit') throw new NoEffectMutationError('unsupported-state')
  await observeAndValidate(dependencies, record, signal)
  const indexPath = boundIndexPath(record)
  const lockPath = `${indexPath}.lock`
  await assertIndexLockAvailable(lockPath)
  const scratch = await createOwnedScratch(record)
  const hooksDirectory = join(scratch.path, 'hooks')
  const objectDirectory = join(scratch.path, 'objects')
  const targetIndexPath = join(scratch.path, 'target.index')
  await mkdir(hooksDirectory, { mode: 0o700 })
  await mkdir(objectDirectory, { mode: 0o700 })
  await mkdir(join(objectDirectory, 'info'), { mode: 0o700 })
  await writePrivateFile(
    join(objectDirectory, 'info', 'alternates'),
    Buffer.from(`${gitAlternatePath(join(
      record.request.expected.binding.expectedInspection.trusted.canonicalCommonGitDirectory,
      'objects',
    ))}\n`, 'utf8'),
  )
  let pin: LocalHostStageFilesPlan['pin'] | undefined
  const pinReference: PreparedIndexPinReference = {}
  const release = preparedIndexLockRelease(dependencies, record, pinReference)
  const discard = async (): Promise<void> => {
    await release()
    if (pin !== undefined) {
      await removeOwnedIndexPin(record, pin, dependencies.config.operationMaxIndexBytes)
    }
    await removeOwnedScratch(scratch, record)
  }
  try {
    const stable = await observeAndValidate(dependencies, record, signal)
    const expectedIndexFile = await readIndexEvidence(
      indexPath,
      dependencies.config.operationMaxIndexBytes,
      signal,
    )
    if (expectedIndexFile.kind === 'file') {
      await writePrivateFile(targetIndexPath, await readFileBounded(
        indexPath,
        dependencies.config.operationMaxIndexBytes,
        signal,
      ))
    } else {
      await dependencies.git.runMutation(
        boundWorktree(record),
        ['read-tree', '--empty'],
        signal,
        { hooksDirectory, indexFile: targetIndexPath, objectDirectory },
      )
    }
    const changes = await applyIndexSelection(
      dependencies,
      record,
      stable,
      targetIndexPath,
      hooksDirectory,
      objectDirectory,
      signal,
    )
    const { stdout: treeOutput, stderr: treeError } = await dependencies.git.runMutation(
      boundWorktree(record),
      ['write-tree'],
      signal,
      { hooksDirectory, indexFile: targetIndexPath, objectDirectory },
    )
    const treeId = parseObjectId(treeOutput, treeError, record)
    const targetIndexFile = await readIndexEvidence(
      targetIndexPath,
      dependencies.config.operationMaxIndexBytes,
      signal,
    )
    if (targetIndexFile.kind !== 'file') throw new RetryableMutationError('unavailable')
    await observeAndValidate(dependencies, record, signal)
    if (!sameIndexEvidence(
      await readIndexEvidence(indexPath, dependencies.config.operationMaxIndexBytes, signal),
      expectedIndexFile,
    )) {
      throw new NoEffectMutationError('observation-stale')
    }
    pin = await createIndexPin(
      record,
      await readFileBounded(targetIndexPath, dependencies.config.operationMaxIndexBytes, signal),
      await indexPublicationMode(indexPath, expectedIndexFile),
    )
    pinReference.value = pin
    const publicChanges = changes.map(({ pathBytesBase64: _pathBytesBase64, ...change }) => change)
    const plan = record.request.type === 'stage-files'
      ? {
        kind: 'index' as const,
        operation: 'stage-files' as const,
        scratch,
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
        await readIndexEvidence(indexPath, dependencies.config.operationMaxIndexBytes, signal),
        expectedIndexFile,
      )) {
        throw new NoEffectMutationError('observation-stale')
      }
      await materializeStageObjects(dependencies, record, attempt, plan, hooksDirectory, signal)
      if (!await indexPinMatches(record, plan.pin, dependencies.config.operationMaxIndexBytes, signal)) {
        throw new RetryableMutationError('unavailable')
      }
      await acquireIndexPublicationLock(record, plan.pin, dependencies.config.operationMaxIndexBytes, signal)
    }
    const publish = async (): Promise<void> => {
      if (!await indexPinAndLockMatch(record, plan.pin, dependencies.config.operationMaxIndexBytes, signal)) {
        throw new Error('owned Git index lock changed before publication')
      }
      await rename(lockPath, indexPath)
      await syncDirectory(dirname(indexPath))
    }
    return {
      plan,
      prepareAttempt,
      publish,
      release,
      discard,
    }
  } catch (error) {
    await discard()
    throw error
  }
}

async function applyIndexSelection(
  dependencies: LocalGitMutationDependencies,
  record: LocalHostOperationRecord,
  stable: StableMutationObservation,
  targetIndexPath: string,
  hooksDirectory: string,
  objectDirectory: string,
  signal: AbortSignal,
): Promise<readonly (AppliedProjectGitChange & { readonly pathBytesBase64: string })[]> {
  if (record.request.type === 'commit') throw new NoEffectMutationError('invalid-selection')
  const statusById = new Map(stable.status.changes.map(change => [change.id, change]))
  const inventoryByPath = inventoryPathMap(stable.inventory)
  const instructions: Buffer[] = []
  const applied: Array<AppliedProjectGitChange & { readonly pathBytesBase64: string }> = []
  for (const selected of record.request.changes) {
    signal.throwIfAborted()
    const change = statusById.get(selected.id)
    if (change === undefined || change.fingerprint.digest !== selected.fingerprint.digest) {
      throw new NoEffectMutationError('invalid-selection')
    }
    const pathBytes = Buffer.from(change.path, 'utf8')
    const inventory = inventoryByPath.get(pathBytes.toString('hex'))
    if (inventory === undefined) throw new NoEffectMutationError('invalid-selection')
    let update: { readonly mode?: string; readonly objectId?: string }
    if (record.request.type === 'stage-files') {
      update = await stageUpdate(
        dependencies,
        record,
        change,
        inventory,
        hooksDirectory,
        objectDirectory,
        signal,
      )
    } else {
      update = unstageUpdate(record, change, inventory)
    }
    const zero = '0'.repeat(record.request.expected.binding.expectedInspection.projection.objectFormat === 'sha1' ? 40 : 64)
    const prefix = update.mode === undefined || update.objectId === undefined
      ? `0 ${zero}\t`
      : `${update.mode} ${update.objectId}\t`
    instructions.push(Buffer.from(prefix, 'ascii'), pathBytes, Buffer.from([0]))
    applied.push({ ...selected, path: change.path, pathBytesBase64: pathBytes.toString('base64') })
  }
  const stdin = Buffer.concat(instructions)
  await dependencies.git.runMutation(
    boundWorktree(record),
    ['update-index', '-z', '--index-info'],
    signal,
    { hooksDirectory, indexFile: targetIndexPath, objectDirectory },
    { bytes: stdin, maxBytes: Math.max(1, dependencies.config.inventoryMaxPathBytes * 2) },
  )
  return applied
}

async function materializeStageObjects(
  dependencies: LocalGitMutationDependencies,
  record: LocalHostOperationRecord,
  stable: StableMutationObservation,
  plan: LocalHostStageFilesPlan | LocalHostUnstageFilesPlan,
  hooksDirectory: string,
  signal: AbortSignal,
): Promise<void> {
  if (plan.operation !== 'stage-files') return
  const statusById = new Map(stable.status.changes.map(change => [change.id, change]))
  const inventoryByPath = inventoryPathMap(stable.inventory)
  for (const planned of plan.changes) {
    signal.throwIfAborted()
    const change = statusById.get(planned.id)
    const inventory = inventoryByPath.get(Buffer.from(planned.pathBytesBase64, 'base64').toString('hex'))
    if (change === undefined || change.fingerprint.digest !== planned.fingerprint.digest
      || change.path !== planned.path || inventory === undefined) {
      throw new NoEffectMutationError('observation-stale')
    }
    await stageUpdate(dependencies, record, change, inventory, hooksDirectory, undefined, signal)
  }
}

async function stageUpdate(
  dependencies: LocalGitMutationDependencies,
  record: LocalHostOperationRecord,
  change: ProjectGitChange,
  entry: CapturedRepositoryInventoryEntry,
  hooksDirectory: string,
  objectDirectory: string | undefined,
  signal: AbortSignal,
): Promise<{ readonly mode?: string; readonly objectId?: string }> {
  if (change.kind === 'unmerged' || entry.conversion.executableFilter) {
    throw new NoEffectMutationError('unsupported-state')
  }
  if (change.kind === 'ordinary' && change.worktreeStatus === 'unchanged') {
    throw new NoEffectMutationError('invalid-selection')
  }
  if (entry.current.kind !== 'captured') throw new NoEffectMutationError('unsupported-state')
  const evidence = entry.current.evidence
  if (evidence.kind === 'missing') return {}
  if (evidence.kind === 'submodule') return { mode: '160000', objectId: evidence.objectId }
  const bytes = await readExactWorktreeBytes(boundWorktree(record), change.path, evidence, signal)
  const expectedObjectId = entry.current.rawObjectId
  if (expectedObjectId === undefined) throw new NoEffectMutationError('unsupported-state')
  const { stdout, stderr } = await dependencies.git.runMutation(
    boundWorktree(record),
    ['hash-object', '-w', '--stdin', '--no-filters'],
    signal,
    { hooksDirectory, ...(objectDirectory === undefined ? {} : { objectDirectory }) },
    { bytes, maxBytes: Math.max(1, dependencies.config.inventoryMaxFileBytes) },
  )
  const objectId = parseObjectId(stdout, stderr, record)
  if (objectId !== expectedObjectId) throw new NoEffectMutationError('observation-stale')
  const mode = change.worktreeMode
  if (mode === 'unknown' || mode === '000000') throw new NoEffectMutationError('unsupported-state')
  return { mode, objectId }
}

function unstageUpdate(
  _record: LocalHostOperationRecord,
  change: ProjectGitChange,
  entry: CapturedRepositoryInventoryEntry,
): { readonly mode?: string; readonly objectId?: string } {
  if (change.kind === 'untracked' || change.kind === 'unmerged'
    || change.indexStatus === 'unchanged') {
    throw new NoEffectMutationError('invalid-selection')
  }
  return entry.head === undefined ? {} : { mode: entry.head.mode, objectId: entry.head.objectId }
}

async function observeAndValidate(
  dependencies: LocalGitMutationDependencies,
  record: LocalHostOperationRecord,
  signal: AbortSignal,
): Promise<StableMutationObservation> {
  const binding = record.request.expected.binding
  let selected
  try {
    selected = await inspectStableLocalProjectSelection(
      dependencies.fs,
      dependencies.workspaces,
      dependencies.git,
      dependencies.config,
      { hostId: binding.hostId, directoryLocator: boundWorktree(record) },
      signal,
      dependencies.identityReader,
      { workspaceId: binding.workspaceId, trusted: binding.expectedInspection.trusted },
    )
  } catch (error) {
    if (error instanceof BoundProjectResourceMismatchError) throw new NoEffectMutationError('binding-stale')
    throw error
  }
  if (!selected.ok) {
    if (selected.reason === 'missing' || selected.reason === 'not-directory'
      || selected.reason === 'not-git' || selected.reason === 'bare' || selected.reason === 'prunable') {
      throw new NoEffectMutationError('binding-stale')
    }
    throw new RetryableMutationError('unavailable')
  }
  const preEffectBaseline = selected.inspection.projection.baseline
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
    if (error instanceof ProjectGitStatusProjectionError) throw new RetryableMutationError('unavailable')
    throw error
  }
  if (selected.unsupportedIndexState) throw new NoEffectMutationError('unsupported-state')
  const expected = record.request.expected
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
  const targetPath = join(plan.scratch.path, 'target.index')
  try {
    if (!await scratchOwnershipMatches(plan.scratch, record, signal)) {
      return { kind: 'retryable', reason: 'unavailable', record }
    }
    if (!await indexPinMatches(record, plan.pin, dependencies.config.operationMaxIndexBytes, signal)) {
      return { kind: 'retryable', reason: 'unavailable', record }
    }
    const target = await readIndexEvidence(targetPath, dependencies.config.operationMaxIndexBytes, signal)
    if (!sameIndexEvidence(target, plan.targetIndexFile)) {
      return { kind: 'retryable', reason: 'unavailable', record }
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason
    if (error instanceof RetryableMutationError || error instanceof GitCommandError) {
      return {
        kind: 'retryable',
        reason: error instanceof RetryableMutationError ? error.reason : 'unavailable',
        record,
      }
    }
    if (error instanceof NoEffectMutationError) {
      const failed = await persistNoEffectFailure(dependencies, record, persist, error.reason)
      return { kind: 'advanced', record: failed }
    }
    throw error
  }
  const indexPath = boundIndexPath(record)
  try {
    const stable = await observeAndValidate(dependencies, record, signal)
    if (!sameIndexEvidence(
      await readIndexEvidence(indexPath, dependencies.config.operationMaxIndexBytes, signal),
      plan.expectedIndexFile,
    )) {
      throw new NoEffectMutationError('observation-stale')
    }
    await materializeStageObjects(
      dependencies,
      record,
      stable,
      plan,
      join(plan.scratch.path, 'hooks'),
      signal,
    )
    await acquireIndexPublicationLock(record, plan.pin, dependencies.config.operationMaxIndexBytes, signal)
  } catch (error) {
    await removeOwnedIndexLock(record, plan.pin, dependencies.config.operationMaxIndexBytes)
    if (signal.aborted) throw signal.reason
    if (error instanceof RetryableMutationError || error instanceof GitCommandError) {
      return {
        kind: 'retryable',
        reason: error instanceof RetryableMutationError ? error.reason : 'unavailable',
        record,
      }
    }
    if (error instanceof NoEffectMutationError) {
      const failed = await persistNoEffectFailure(dependencies, record, persist, error.reason)
      return { kind: 'advanced', record: failed }
    }
    throw error
  }
  const next = withPublication(record, 'attempting')
  try {
    await persist(next)
  } catch (error) {
    await removeOwnedIndexLock(record, plan.pin, dependencies.config.operationMaxIndexBytes)
    throw error
  }
  try {
    if (!await indexPinAndLockMatch(record, plan.pin, dependencies.config.operationMaxIndexBytes, signal)) {
      throw new Error('owned Git index lock changed before recovered publication')
    }
    await rename(`${indexPath}.lock`, indexPath)
    await syncDirectory(dirname(indexPath))
  } catch {
    await removeOwnedIndexLock(record, plan.pin, dependencies.config.operationMaxIndexBytes)
  }
  return await recoverPublishingOperation(dependencies, next, persist, signal, true)
}

function transitionToPlanning(record: LocalHostOperationRecord): LocalHostOperationRecord {
  if (record.snapshot.state !== 'accepted') return record
  const plannedAt = Date.now()
  return {
    ...record,
    snapshot: {
      ...record.snapshot,
      state: 'planning',
      revision: record.snapshot.revision + 1,
      plannedAt,
      updatedAt: plannedAt,
    },
  }
}

function transitionToPublishing(
  record: LocalHostOperationRecord,
  plan: LocalHostOperationEffectPlan,
): LocalHostOperationRecord {
  if (record.snapshot.state !== 'planning') return record
  const publishingAt = Date.now()
  return {
    ...record,
    effectPlan: plan,
    snapshot: {
      ...record.snapshot,
      state: 'publishing',
      revision: record.snapshot.revision + 1,
      plannedAt: record.snapshot.plannedAt,
      effectPlannedAt: publishingAt,
      publishingAt,
      updatedAt: publishingAt,
    },
  }
}

function withPublication(
  record: LocalHostOperationRecord,
  publication: LocalHostOperationEffectPlan['publication'],
): LocalHostOperationRecord {
  if (record.effectPlan === undefined) return record
  return withPlan(record, { ...record.effectPlan, publication })
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
      ...snapshotCore(record.snapshot),
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
      ...snapshotCore(record.snapshot),
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
      ...snapshotCore(record.snapshot),
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
      ...snapshotCore(record.snapshot),
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
  if (!isTerminal(record.snapshot)) throw new Error('cannot persist a non-terminal operation as terminal')
  if (record.effectPlan !== undefined) {
    await removeOwnedIndexLock(
      record,
      record.effectPlan.pin,
      dependencies.config.operationMaxIndexBytes,
    )
  }
  await persist(record)
  await cleanupTerminalGitMutation(dependencies, record)
}

function snapshotCore(snapshot: HostOperationSnapshot) {
  return {
    operation: snapshot.operation,
    revision: snapshot.revision,
    source: snapshot.source,
    requestFingerprint: snapshot.requestFingerprint,
    bindingId: snapshot.bindingId,
    bindingRevision: snapshot.bindingRevision,
    preparedAt: snapshot.preparedAt,
    updatedAt: snapshot.updatedAt,
    admission: snapshot.admission,
  }
}

async function createOwnedScratch(record: LocalHostOperationRecord) {
  const path = await mkdtemp(join(tmpdir(), 'saki-host-operation-'))
  await chmod(path, 0o700)
  const marker = operationScratchMarker(record)
  await writeFile(join(path, 'owner'), marker, { flag: 'wx', mode: 0o600 })
  return { path, markerDigest: byteDigest(marker) }
}

async function removeOwnedScratch(
  scratch: { readonly path: string; readonly markerDigest: string },
  record: LocalHostOperationRecord,
): Promise<void> {
  if (!await scratchOwnershipMatches(scratch, record, new AbortController().signal)) return
  await rm(resolve(scratch.path), { recursive: true, force: false })
}

async function scratchOwnershipMatches(
  scratch: { readonly path: string; readonly markerDigest: string },
  record: LocalHostOperationRecord,
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted()
  if (!isOperationScratchPath(scratch.path)) return false
  try {
    const directory = await lstat(scratch.path, { bigint: true })
    if (!directory.isDirectory() || directory.isSymbolicLink()) return false
    const ownerPath = join(scratch.path, 'owner')
    const owner = await lstat(ownerPath, { bigint: true })
    if (!owner.isFile() || owner.isSymbolicLink() || owner.size > 4_096n) return false
    const marker = await readFileBounded(ownerPath, 4_096, signal)
    const confirmedOwner = await lstat(ownerPath, { bigint: true })
    const confirmedDirectory = await lstat(scratch.path, { bigint: true })
    if (confirmedOwner.dev !== owner.dev || confirmedOwner.ino !== owner.ino
      || confirmedOwner.size !== owner.size || confirmedOwner.mtimeNs !== owner.mtimeNs
      || confirmedOwner.ctimeNs !== owner.ctimeNs || confirmedDirectory.dev !== directory.dev
      || confirmedDirectory.ino !== directory.ino) return false
    return byteDigest(marker) === scratch.markerDigest
      && marker.equals(operationScratchMarker(record))
  } catch {
    return false
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
  return indexLockMarker(record.snapshot.operation.id, record.snapshot.requestFingerprint.digest)
}

async function assertIndexLockAvailable(path: string): Promise<void> {
  try {
    await lstat(path)
    throw new RetryableMutationError('busy')
  } catch (error) {
    if (error instanceof RetryableMutationError) throw error
    if (!isNodeError(error, 'ENOENT')) throw new RetryableMutationError('unavailable')
  }
}

async function indexPublicationMode(
  indexPath: string,
  expected: LocalHostIndexFileEvidence,
): Promise<number | undefined> {
  if (expected.kind === 'missing') return undefined
  try {
    const info = await lstat(indexPath, { bigint: true })
    if (!info.isFile() || info.isSymbolicLink()) throw new RetryableMutationError('unavailable')
    return Number(info.mode & 0o777n)
  } catch (error) {
    if (error instanceof RetryableMutationError) throw error
    throw new RetryableMutationError('unavailable')
  }
}

async function createIndexPin(
  record: LocalHostOperationRecord,
  bytes: Uint8Array,
  mode: number | undefined,
): Promise<LocalHostIndexPinEvidence> {
  const indexPath = boundIndexPath(record)
  const directory = dirname(indexPath)
  const prefix = `${basename(indexPath)}.saki-${record.snapshot.operation.id}-`
  const directoryInfo = await lstat(directory, { bigint: true })
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const path = join(directory, `${prefix}${randomBytes(16).toString('hex')}.pin`)
    let handle: FileHandle
    try {
      handle = await open(path, 'wx', mode ?? 0o666)
    } catch (error) {
      if (isNodeError(error, 'EEXIST')) continue
      throw new RetryableMutationError('unavailable')
    }
    const initial = await handle.stat({ bigint: true })
    const identity = { device: initial.dev.toString(), inode: initial.ino.toString() }
    try {
      if (!initial.isFile() || initial.isSymbolicLink() || initial.dev !== directoryInfo.dev) {
        throw new RetryableMutationError('unavailable')
      }
      await handle.writeFile(bytes)
      if (mode !== undefined) await handle.chmod(mode)
      await handle.sync()
      const complete = await handle.stat({ bigint: true })
      const completeMode = Number(complete.mode & 0o777n)
      if (complete.dev !== initial.dev || complete.ino !== initial.ino
        || complete.size !== BigInt(bytes.byteLength)
        || (mode !== undefined && completeMode !== mode)) {
        throw new RetryableMutationError('unavailable')
      }
      await handle.close()
      await syncDirectory(directory)
      return { path, digest: byteDigest(bytes), byteLength: bytes.byteLength, identity, mode: completeMode }
    } catch (error) {
      await Promise.allSettled([handle.close(), unlinkOwnedLockByIdentity(path, identity)])
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
): Promise<boolean> {
  if (!isOperationIndexPinPath(record, pin.path)) return false
  try {
    const directory = await lstat(dirname(pin.path), { bigint: true })
    const info = await lstat(pin.path, { bigint: true })
    if (info.dev !== directory.dev || Number(info.mode & 0o777n) !== pin.mode) return false
  } catch {
    return false
  }
  return await ownedFileMatches(pin.path, pin, maxBytes, signal)
}

async function indexPinAndLockMatch(
  record: LocalHostOperationRecord,
  pin: LocalHostIndexPinEvidence,
  maxBytes: number,
  signal: AbortSignal,
): Promise<boolean> {
  if (!await indexPinMatches(record, pin, maxBytes, signal)) return false
  return await ownedFileMatches(`${boundIndexPath(record)}.lock`, pin, maxBytes, signal)
}

async function acquireIndexPublicationLock(
  record: LocalHostOperationRecord,
  pin: LocalHostIndexPinEvidence,
  maxBytes: number,
  signal: AbortSignal,
): Promise<void> {
  if (!await indexPinMatches(record, pin, maxBytes, signal)) throw new RetryableMutationError('unavailable')
  const lockPath = `${boundIndexPath(record)}.lock`
  try {
    await link(pin.path, lockPath)
    await syncDirectory(dirname(lockPath))
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) throw new RetryableMutationError('unavailable')
    if (!await indexPinAndLockMatch(record, pin, maxBytes, signal)) throw new RetryableMutationError('busy')
    return
  }
  if (!await indexPinAndLockMatch(record, pin, maxBytes, signal)) {
    throw new RetryableMutationError('unavailable')
  }
}

async function removeOwnedIndexLock(
  record: LocalHostOperationRecord,
  pin: LocalHostIndexPinEvidence,
  maxBytes: number,
): Promise<void> {
  const signal = new AbortController().signal
  const lockPath = `${boundIndexPath(record)}.lock`
  const before = await ownedFileState(lockPath, pin, maxBytes, signal)
  if (before === 'unavailable' || before === 'owned-corrupt') {
    throw new RetryableMutationError('unavailable')
  }
  if (before === 'owned') await unlinkOwnedLock(lockPath, pin, maxBytes, signal)
  await syncDirectory(dirname(lockPath))
  const after = await ownedFileState(lockPath, pin, maxBytes, signal)
  if (after === 'owned' || after === 'owned-corrupt' || after === 'unavailable') {
    throw new RetryableMutationError('unavailable')
  }
}

async function removeOwnedIndexPin(
  record: LocalHostOperationRecord,
  pin: LocalHostIndexPinEvidence,
  maxBytes: number,
): Promise<void> {
  if (!isOperationIndexPinPath(record, pin.path)) return
  await unlinkOwnedLock(pin.path, pin, maxBytes, new AbortController().signal)
  await syncDirectory(dirname(pin.path))
}

async function unlinkOwnedLock(
  path: string,
  evidence: LocalHostIndexPinEvidence,
  maxBytes: number,
  signal: AbortSignal,
): Promise<void> {
  try {
    if (!await ownedFileMatches(path, evidence, maxBytes, signal)) return
    const info = await lstat(path, { bigint: true })
    if (!info.isFile() || info.isSymbolicLink()
      || info.dev.toString() !== evidence.identity.device || info.ino.toString() !== evidence.identity.inode
      || info.size !== BigInt(evidence.byteLength) || Number(info.mode & 0o777n) !== evidence.mode) return
    await unlink(path)
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error
  }
}

async function unlinkOwnedLockByIdentity(
  path: string,
  identity: { readonly device: string; readonly inode: string },
): Promise<void> {
  try {
    const info = await lstat(path, { bigint: true })
    if (!info.isFile() || info.isSymbolicLink()
      || info.dev.toString() !== identity.device || info.ino.toString() !== identity.inode) return
    await rm(path, { force: false })
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error
  }
}

async function ownedFileMatches(
  path: string,
  evidence: LocalHostIndexPinEvidence,
  maxBytes: number,
  signal: AbortSignal,
): Promise<boolean> {
  return await ownedFileState(path, evidence, maxBytes, signal) === 'owned'
}

type OwnedFileState = 'missing' | 'foreign' | 'owned' | 'owned-corrupt' | 'unavailable'

async function ownedFileState(
  path: string,
  evidence: LocalHostIndexPinEvidence,
  maxBytes: number,
  signal: AbortSignal,
): Promise<OwnedFileState> {
  signal.throwIfAborted()
  let pathInfo: Awaited<ReturnType<typeof lstat>>
  try {
    pathInfo = await lstat(path, { bigint: true })
  } catch (error) {
    if (signal.aborted) throw signal.reason
    return isNodeError(error, 'ENOENT') ? 'missing' : 'unavailable'
  }
  if (pathInfo.dev.toString() !== evidence.identity.device || pathInfo.ino.toString() !== evidence.identity.inode) {
    return 'foreign'
  }
  let handle: FileHandle | undefined
  try {
    handle = await open(path, 'r')
    const before = await handle.stat({ bigint: true })
    if (before.dev.toString() !== evidence.identity.device || before.ino.toString() !== evidence.identity.inode) {
      return 'unavailable'
    }
    if (evidence.byteLength > maxBytes) return 'owned-corrupt'
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || !before.isFile() || before.isSymbolicLink()
      || pathInfo.size !== BigInt(evidence.byteLength) || before.size !== BigInt(evidence.byteLength)
      || Number(pathInfo.mode & 0o777n) !== evidence.mode
      || Number(before.mode & 0o777n) !== evidence.mode) return 'owned-corrupt'
    const bytes = await readExactHandle(handle, evidence.byteLength, signal)
    if (bytes === undefined || byteDigest(bytes) !== evidence.digest) return 'owned-corrupt'
    const after = await handle.stat({ bigint: true })
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) return 'unavailable'
    const current = await lstat(path, { bigint: true })
    if (current.dev !== before.dev || current.ino !== before.ino) return 'foreign'
    return current.isFile() && !current.isSymbolicLink() && current.size === before.size
      && Number(current.mode & 0o777n) === evidence.mode ? 'owned' : 'owned-corrupt'
  } catch (error) {
    if (signal.aborted) throw signal.reason
    return isNodeError(error, 'ENOENT') ? 'missing' : 'unavailable'
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function readExactHandle(
  handle: FileHandle,
  byteLength: number,
  signal: AbortSignal,
): Promise<Buffer | undefined> {
  signal.throwIfAborted()
  const bytes = Buffer.alloc(byteLength)
  let offset = 0
  while (offset < byteLength) {
    const read = await handle.read(bytes, offset, byteLength - offset, offset)
    if (read.bytesRead === 0) return undefined
    offset += read.bytesRead
  }
  const extra = Buffer.allocUnsafe(1)
  if ((await handle.read(extra, 0, 1, byteLength)).bytesRead !== 0) return undefined
  signal.throwIfAborted()
  return bytes
}

async function readIndexEvidence(
  path: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<LocalHostIndexFileEvidence> {
  signal.throwIfAborted()
  try {
    const info = await lstat(path, { bigint: true })
    if (!info.isFile() || info.isSymbolicLink() || info.size > BigInt(maxBytes)) {
      throw new NoEffectMutationError('unsupported-state')
    }
    const bytes = await readFileBounded(path, maxBytes, signal)
    const after = await lstat(path, { bigint: true })
    if (after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size
      || after.mtimeNs !== info.mtimeNs || after.ctimeNs !== info.ctimeNs) {
      throw new RetryableMutationError('unavailable')
    }
    return { kind: 'file', digest: byteDigest(bytes), byteLength: bytes.byteLength }
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return { kind: 'missing' }
    throw error
  }
}

async function readFileBounded(path: string, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted()
  const info = await stat(path, { bigint: true })
  if (!info.isFile() || info.size > BigInt(maxBytes)) throw new NoEffectMutationError('unsupported-state')
  const bytes = await readFile(path)
  signal.throwIfAborted()
  if (bytes.byteLength > maxBytes || BigInt(bytes.byteLength) !== info.size) {
    throw new RetryableMutationError('unavailable')
  }
  return bytes
}

async function readExactWorktreeBytes(
  root: string,
  path: string,
  evidence: Extract<CapturedRepositoryInventoryEntry['current'], { readonly kind: 'captured' }>['evidence'],
  signal: AbortSignal,
): Promise<Buffer> {
  const absolute = resolve(root, ...path.split('/'))
  const within = relative(root, absolute)
  if (within === '' || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    throw new NoEffectMutationError('invalid-selection')
  }
  signal.throwIfAborted()
  if (evidence.kind === 'regular') {
    const bytes = await readFileBounded(absolute, evidence.byteLength, signal)
    if (bytes.byteLength !== evidence.byteLength
      || createHash('sha256').update(bytes).digest('hex') !== evidence.contentDigest) {
      throw new NoEffectMutationError('observation-stale')
    }
    return bytes
  }
  if (evidence.kind === 'symlink') {
    const bytes = await readlink(absolute, { encoding: 'buffer' })
    if (exactBytesDigest('saki/inherited-symlink/v1', bytes) !== evidence.targetDigest) {
      throw new NoEffectMutationError('observation-stale')
    }
    return bytes
  }
  throw new NoEffectMutationError('unsupported-state')
}

function inventoryPathMap(
  inventory: CapturedRepositoryInventory,
): ReadonlyMap<string, CapturedRepositoryInventoryEntry> {
  return new Map(inventory.entries.map(entry => [Buffer.from(entry.path).toString('hex'), entry]))
}

function parseObjectId(stdout: Uint8Array, stderr: Uint8Array, record: LocalHostOperationRecord): string {
  if (stderr.byteLength !== 0) throw new GitCommandError('stream-failure')
  let text: string
  try {
    text = UTF8.decode(stdout)
  } catch {
    throw new GitCommandError('stream-failure')
  }
  const width = record.request.expected.binding.expectedInspection.projection.objectFormat === 'sha1' ? 40 : 64
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
  return error instanceof Error && 'code' in error && error.code === code
}

class RetryableMutationError extends Error {
  constructor(readonly reason: 'busy' | 'unavailable') {
    super(`Saki Git mutation is temporarily ${reason}`)
  }
}

class NoEffectMutationError extends Error {
  constructor(readonly reason: HostOperationFailure['reason']) {
    super(`Saki Git mutation failed before effect: ${reason}`)
  }
}
