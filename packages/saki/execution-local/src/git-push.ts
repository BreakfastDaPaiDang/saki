/** Recoverable exact-lease Push engine for the Local Host. @module @breakfastdapaidang/saki-execution-local/git-push */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  GitHubRepositoryCoordinates,
  GitRemoteBranchState,
  HostOperationCancellationReason,
  HostOperationFailure,
  HostOperationSnapshot,
} from '@breakfastdapaidang/saki-execution'
import { openLocalProjectCommit, type LocalCommitInspectionDependencies } from './commit-inspection.ts'
import {
  GitCommandError,
  type GitCredentialHelperAdapter,
  type GitRunner,
} from './git-runner.ts'
import {
  hostOperationSnapshotCore,
  type LocalHostPushBranchOperationRecord,
  type LocalHostPushBranchPlan,
} from './operation-state.ts'
import {
  createOwnedPrivateGitDirectory,
  type OwnedPrivateGitDirectory,
} from './owned-private-git-directory.ts'
import type { SafeRepositoryView } from './safe-repository.ts'

/** Exact repository and private Git context for one remote branch read. */
export interface PushTransportReadRequest {
  readonly repository: GitHubRepositoryCoordinates
  readonly targetRef: string
  readonly objectFormat: 'sha1' | 'sha256'
  readonly credential: GitCredentialHelperAdapter
  readonly privateGitDirectory: OwnedPrivateGitDirectory
}

/** Exact Commit and lease premise for one remote branch publication. */
export interface PushTransportWriteRequest extends PushTransportReadRequest {
  readonly commitId: string
  readonly previous: GitRemoteBranchState
}

/** Closed external Git transport boundary used by the Push engine. */
export interface LocalGitPushTransport {
  readBranch(request: PushTransportReadRequest, signal: AbortSignal): Promise<GitRemoteBranchState>
  pushBranch(request: PushTransportWriteRequest, signal: AbortSignal): Promise<void>
}

/** Minimal trusted Git runner surface used by the fixed GitHub transport. @internal */
export type GitHubTransportGit = Pick<GitRunner, 'runGitHubTransport'>

/** Provider-private adapters used only to exercise external Push failure boundaries. */
export interface LocalGitPushInternals {
  readonly transport: LocalGitPushTransport
  /** Test-only recovery directory construction override. */
  readonly createTransportGitDirectory?: typeof createTransportGitDirectory
}

/** Push engine dependencies in one Local Host execution world. */
export interface LocalGitPushDependencies extends LocalCommitInspectionDependencies {
  readonly git: GitRunner
  readonly credential: GitCredentialHelperAdapter
  readonly transport: LocalGitPushTransport
  readonly createTransportGitDirectory: typeof createTransportGitDirectory
}

type PersistPushOperation = (record: LocalHostPushBranchOperationRecord) => Promise<void>

/** Result of advancing one durable Push operation. */
export type LocalGitPushAdvanceResult =
  | { readonly kind: 'advanced'; readonly record: LocalHostPushBranchOperationRecord }
  | { readonly kind: 'retryable'; readonly reason: 'unavailable'; readonly record: LocalHostPushBranchOperationRecord }

/**
 * Advance one nonterminal Push or reconcile one publishing Push without a second attempt.
 * @param dependencies - Trusted local Commit inspection and GitHub transport adapters.
 * @param initial - Durable Push operation to advance.
 * @param persist - Durable compare-and-replace sink for each lifecycle transition.
 * @param signal - Cancellation shared with the Host Operation call.
 * @returns A terminal advance or a retryable unchanged operation.
 */
export async function advanceLocalGitPush(
  dependencies: LocalGitPushDependencies,
  initial: LocalHostPushBranchOperationRecord,
  persist: PersistPushOperation,
  signal: AbortSignal,
): Promise<LocalGitPushAdvanceResult> {
  signal.throwIfAborted()
  let record = initial
  if (record.snapshot.state === 'publishing') {
    return await recoverLocalGitPush(dependencies, record, persist, signal, true)
  }
  if (record.snapshot.state === 'accepted') {
    record = toPlanning(record)
    await persist(record)
  }

  const opened = await openLocalProjectCommit(
    dependencies,
    record.request.expected.binding,
    record.request.expected.commitId,
    signal,
  )
  if (!opened.ok) {
    const reason = opened.result.reason
    return reason === 'unavailable'
      ? { kind: 'retryable', reason, record }
      : { kind: 'advanced', record: await failNoEffect(record, persist,
        reason === 'binding-stale' ? 'binding-stale' : 'unsupported-state') }
  }
  await using repository = opened.repository
  const transport = dependencies.transport
  let previous: GitRemoteBranchState
  try {
    previous = await transport.readBranch(transportRequest(record, repository.privateGitDirectory, dependencies), signal)
    await proveFastForward(repository, previous, record.request.expected.commitId, signal)
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof NonFastForwardPushError) {
      return { kind: 'advanced', record: await failNoEffect(record, persist, 'unsupported-state') }
    }
    return { kind: 'retryable', reason: 'unavailable', record }
  }
  const plan = {
    kind: 'push-branch' as const,
    publication: 'not-started' as const,
    result: {
      type: 'push-branch' as const,
      repository: record.request.expected.repository,
      targetRef: record.request.targetRef,
      commitId: record.request.expected.commitId,
      previous,
      credential: { helperId: dependencies.credential },
    },
  }
  record = toPublishing(record, plan)
  await persist(record)
  return await resumeNotStartedPush(dependencies, record, persist, repository, signal)
}

/**
 * Inspect one publishing Push; an attempting plan is never pushed again.
 * @param dependencies - Trusted local Commit inspection and GitHub transport adapters.
 * @param record - Durable publishing Push operation to recover.
 * @param persist - Durable compare-and-replace sink for recovery transitions.
 * @param signal - Cancellation shared with the Host Operation call.
 * @param allowResume - Whether a proven not-started operation may begin its single attempt.
 * @returns A terminal advance or a retryable unchanged operation.
 */
export async function recoverLocalGitPush(
  dependencies: LocalGitPushDependencies,
  record: LocalHostPushBranchOperationRecord,
  persist: PersistPushOperation,
  signal: AbortSignal,
  allowResume = false,
): Promise<LocalGitPushAdvanceResult> {
  const plan = record.effectPlan as LocalHostPushBranchPlan
  if (plan.result.credential.helperId !== dependencies.credential) {
    return { kind: 'retryable', reason: 'unavailable', record }
  }
  if (plan.publication !== 'not-started') {
    return await inspectAttemptedPush(dependencies, record, persist, signal)
  }
  /* Recovery acquires and owns a fresh repository view independently of the
   * first-attempt path so replay cannot inherit an earlier process resource. */
  /* jscpd:ignore-start */
  const opened = await openLocalProjectCommit(
    dependencies,
    record.request.expected.binding,
    record.request.expected.commitId,
    signal,
  )
  if (!opened.ok) {
    const reason = opened.result.reason
    return reason === 'unavailable'
      ? { kind: 'retryable', reason, record }
      : { kind: 'advanced', record: await failNoEffect(record, persist,
        reason === 'binding-stale' ? 'binding-stale' : 'unsupported-state') }
  }
  /* jscpd:ignore-end */
  await using repository = opened.repository
  if (allowResume) {
    return await resumeNotStartedPush(dependencies, record, persist, repository, signal)
  }
  let current: GitRemoteBranchState
  try {
    current = await dependencies.transport.readBranch(
      transportRequest(record, repository.privateGitDirectory, dependencies),
      signal,
    )
  } catch {
    signal.throwIfAborted()
    return { kind: 'retryable', reason: 'unavailable', record }
  }
  return sameRemote(current, plan.result.previous)
    ? { kind: 'retryable', reason: 'unavailable', record }
    : { kind: 'advanced', record: await failNoEffect(record, persist, 'observation-stale') }
}

async function inspectAttemptedPush(
  dependencies: LocalGitPushDependencies,
  record: LocalHostPushBranchOperationRecord,
  persist: PersistPushOperation,
  signal: AbortSignal,
): Promise<LocalGitPushAdvanceResult> {
  const plan = record.effectPlan as LocalHostPushBranchPlan & { readonly publication: 'attempting' }
  let privateGitDirectory: OwnedPrivateGitDirectory
  try {
    privateGitDirectory = await dependencies.createTransportGitDirectory()
  } catch {
    signal.throwIfAborted()
    return { kind: 'retryable', reason: 'unavailable', record }
  }
  try {
    let current: GitRemoteBranchState
    try {
      current = await dependencies.transport.readBranch(
        transportRequest(record, privateGitDirectory, dependencies),
        signal,
      )
    } catch {
      signal.throwIfAborted()
      return { kind: 'retryable', reason: 'unavailable', record }
    }
    if (sameRemote(current, { kind: 'commit', objectId: plan.result.commitId })) {
      const succeeded = toSuccess(record)
      await persist(succeeded)
      return { kind: 'advanced', record: succeeded }
    }
    const reconciled = toReconciliation(record, sameRemote(current, plan.result.previous)
      ? 'effect-unknown'
      : 'evidence-conflict')
    await persist(reconciled)
    return { kind: 'advanced', record: reconciled }
  } finally {
    await privateGitDirectory[Symbol.asyncDispose]()
  }
}

/**
 * Cancel a Push only while its durable marker proves publication has not begun.
 * @param record - Durable publishing Push operation to cancel.
 * @param reason - Caller-owned cancellation reason recorded in the terminal snapshot.
 * @param persist - Durable compare-and-replace sink for the cancellation.
 * @returns The canceled record, or the unchanged record once an attempt might have begun.
 */
export async function cancelLocalGitPush(
  record: LocalHostPushBranchOperationRecord,
  reason: HostOperationCancellationReason,
  persist: PersistPushOperation,
): Promise<LocalHostPushBranchOperationRecord> {
  const plan = record.effectPlan as LocalHostPushBranchPlan
  if (plan.publication !== 'not-started') return record
  const canceled = toCancellation(record, reason)
  await persist(canceled)
  return canceled
}

async function resumeNotStartedPush(
  dependencies: LocalGitPushDependencies,
  record: LocalHostPushBranchOperationRecord,
  persist: PersistPushOperation,
  repository: SafeRepositoryView,
  signal: AbortSignal,
): Promise<LocalGitPushAdvanceResult> {
  const plan = record.effectPlan as LocalHostPushBranchPlan & { readonly publication: 'not-started' }
  const transport = dependencies.transport
  try {
    const current = await transport.readBranch(
      transportRequest(record, repository.privateGitDirectory, dependencies),
      signal,
    )
    if (!sameRemote(current, plan.result.previous)) {
      const failed = await failNoEffect(record, persist, 'observation-stale')
      return { kind: 'advanced', record: failed }
    }
    await repository.assertSourceControlUnchanged(signal)
  } catch {
    signal.throwIfAborted()
    return { kind: 'retryable', reason: 'unavailable', record }
  }
  const attempting: LocalHostPushBranchOperationRecord = {
    ...record,
    effectPlan: { ...plan, publication: 'attempting' },
    snapshot: { ...record.snapshot, revision: record.snapshot.revision + 1, updatedAt: Date.now() },
  }
  await persist(attempting)
  try {
    await transport.pushBranch({
      ...transportRequest(attempting, repository.privateGitDirectory, dependencies),
      commitId: plan.result.commitId,
      previous: plan.result.previous,
    }, signal)
  } catch {
    signal.throwIfAborted()
  }
  return await recoverLocalGitPush(dependencies, attempting, persist, signal)
}

function transportRequest(
  record: LocalHostPushBranchOperationRecord,
  privateGitDirectory: OwnedPrivateGitDirectory,
  dependencies: LocalGitPushDependencies,
): PushTransportReadRequest {
  return {
    repository: record.request.expected.repository,
    targetRef: record.request.targetRef,
    objectFormat: record.request.expected.binding.expectedInspection.projection.objectFormat,
    credential: dependencies.credential,
    privateGitDirectory,
  }
}

class GitHubPushTransport implements LocalGitPushTransport {
  constructor(private readonly git: GitHubTransportGit) {}

  async readBranch(request: PushTransportReadRequest, signal: AbortSignal): Promise<GitRemoteBranchState> {
    const args = gitHubRemoteReadArguments(request)
    await request.privateGitDirectory.assertIntegrity()
    const output = await this.git.runGitHubTransport(
      request.privateGitDirectory.path,
      args,
      signal,
      request.credential,
    )
    if (output.stderr.byteLength !== 0) throw new GitCommandError('stream-failure')
    if (output.stdout.byteLength === 0) return { kind: 'absent' }
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(output.stdout)
    } catch {
      throw new GitCommandError('stream-failure')
    }
    const match = /^([0-9a-f]+)\t([^\r\n]+)\r?\n$/u.exec(text)
    const width = request.objectFormat === 'sha1' ? 40 : 64
    if (match?.[1]?.length !== width || match[2] !== request.targetRef) throw new GitCommandError('stream-failure')
    return { kind: 'commit', objectId: match[1] }
  }

  async pushBranch(request: PushTransportWriteRequest, signal: AbortSignal): Promise<void> {
    const args = gitHubPushArguments(request)
    await request.privateGitDirectory.assertIntegrity()
    await this.git.runGitHubTransport(
      request.privateGitDirectory.path,
      args,
      signal,
      request.credential,
    )
  }
}

/**
 * Bind the fixed GitHub HTTPS transport to one trusted Git runner.
 * @param git - Runner that owns the closed credential and process environment.
 * @returns A transport limited to exact GitHub HTTPS reads and Pushes.
 * @internal
 */
export function createGitHubPushTransport(git: GitHubTransportGit): LocalGitPushTransport {
  return new GitHubPushTransport(git)
}

/**
 * Build the fixed exact-ref remote inspection argv.
 * @param request - Validated repository coordinates and target ref.
 * @returns Closed Git arguments for one exact remote-ref read.
 * @internal
 */
export function gitHubRemoteReadArguments(request: Pick<
  PushTransportReadRequest,
  'repository' | 'targetRef'
>): readonly string[] {
  return ['ls-remote', '--refs', repositoryUrl(request.repository), request.targetRef]
}

/**
 * Build the fixed exact-lease Push argv without accepting caller transport authority.
 * @param request - Validated repository, ref, Commit, and previous remote state.
 * @returns Closed Git arguments for one exact force-with-lease Push.
 * @internal
 */
export function gitHubPushArguments(request: Pick<
  PushTransportWriteRequest,
  'repository' | 'targetRef' | 'commitId' | 'previous'
>): readonly string[] {
  const expected = request.previous.kind === 'absent' ? '' : request.previous.objectId
  return [
    'push', '--porcelain', '--no-progress', '--no-verify', '--recurse-submodules=no',
    `--force-with-lease=${request.targetRef}:${expected}`,
    repositoryUrl(request.repository),
    `${request.commitId}^{commit}:${request.targetRef}`,
  ]
}

async function proveFastForward(
  repository: SafeRepositoryView,
  previous: GitRemoteBranchState,
  commitId: string,
  signal: AbortSignal,
): Promise<void> {
  if (previous.kind === 'absent') return
  try {
    await repository.git.run(repository.topLevelPath, ['rev-parse', '--verify', `${previous.objectId}^{commit}`], signal)
    await repository.git.run(repository.topLevelPath, [
      'merge-base', '--is-ancestor', `${previous.objectId}^{commit}`, `${commitId}^{commit}`,
    ], signal)
  } catch (error) {
    if (error instanceof GitCommandError && error.code === 'nonzero') throw new NonFastForwardPushError()
    throw error
  }
}

class NonFastForwardPushError extends Error {}

const TRANSPORT_CONFIG = Buffer.from('[core]\n\trepositoryformatversion = 0\n\tbare = true\n')

function repositoryUrl(repository: GitHubRepositoryCoordinates): string {
  return `https://github.com/${repository.nameWithOwner}.git`
}

/**
 * Create one privately constructed Git directory used solely for remote observation.
 * @returns A sealed owner for the exact private directory.
 * @internal
 */
export async function createTransportGitDirectory(): Promise<OwnedPrivateGitDirectory> {
  const draft = await createOwnedPrivateGitDirectory('transport')
  try {
    await mkdir(join(draft.path, 'objects', 'info'), { recursive: true, mode: 0o700 })
    await mkdir(join(draft.path, 'objects', 'pack'), { recursive: true, mode: 0o700 })
    await mkdir(join(draft.path, 'refs', 'heads'), { recursive: true, mode: 0o700 })
    await writeFile(join(draft.path, 'HEAD'), 'ref: refs/heads/main\n', { mode: 0o600, flag: 'wx' })
    await writeFile(
      join(draft.path, 'config'),
      TRANSPORT_CONFIG,
      { mode: 0o600, flag: 'wx' },
    )
    return await draft.seal({ config: TRANSPORT_CONFIG, objectAlternates: { kind: 'absent' } })
  /* v8 ignore start -- each step uses a private mkdtemp path; Node filesystem fault injection
   * would only exercise this best-effort rollback before the original error is rethrown. */
  } catch (error) {
    await draft[Symbol.asyncDispose]()
    throw error
  }
  /* v8 ignore stop */
}

function sameRemote(left: GitRemoteBranchState, right: GitRemoteBranchState): boolean {
  return left.kind === right.kind && (left.kind === 'absent' || (right.kind === 'commit' && left.objectId === right.objectId))
}

function toPlanning(record: LocalHostPushBranchOperationRecord): LocalHostPushBranchOperationRecord {
  const plannedAt = Date.now()
  return { ...record, snapshot: { ...record.snapshot, state: 'planning', revision: record.snapshot.revision + 1,
    plannedAt, updatedAt: plannedAt } as HostOperationSnapshot }
}

function toPublishing(
  record: LocalHostPushBranchOperationRecord,
  plan: NonNullable<LocalHostPushBranchOperationRecord['effectPlan']>,
): LocalHostPushBranchOperationRecord {
  const publishingAt = Date.now()
  return { ...record, effectPlan: plan, snapshot: { ...record.snapshot, state: 'publishing',
    revision: record.snapshot.revision + 1, effectPlannedAt: publishingAt, publishingAt,
    updatedAt: publishingAt } as HostOperationSnapshot }
}

function toSuccess(record: LocalHostPushBranchOperationRecord): LocalHostPushBranchOperationRecord {
  const plan = record.effectPlan as LocalHostPushBranchPlan
  const completedAt = Date.now()
  return { ...record, effectPlan: { ...plan, publication: 'applied-recorded' }, snapshot: {
    ...hostOperationSnapshotCore(record.snapshot), state: 'succeeded', revision: record.snapshot.revision + 1,
    completedAt, updatedAt: completedAt, result: plan.result,
  } as HostOperationSnapshot }
}

async function failNoEffect(
  record: LocalHostPushBranchOperationRecord,
  persist: PersistPushOperation,
  reason: HostOperationFailure['reason'],
): Promise<LocalHostPushBranchOperationRecord> {
  const completedAt = Date.now()
  const failed: LocalHostPushBranchOperationRecord = { ...record, snapshot: {
    ...hostOperationSnapshotCore(record.snapshot), state: 'failed', revision: record.snapshot.revision + 1,
    completedAt, updatedAt: completedAt, failure: { reason }, effect: 'none',
  } as HostOperationSnapshot }
  await persist(failed)
  return failed
}

function toReconciliation(
  record: LocalHostPushBranchOperationRecord,
  reason: 'effect-unknown' | 'evidence-conflict',
): LocalHostPushBranchOperationRecord {
  const observedAt = Date.now()
  return { ...record, snapshot: { ...hostOperationSnapshotCore(record.snapshot), state: 'reconciliation-required',
    revision: record.snapshot.revision + 1, observedAt, updatedAt: observedAt, reason } as HostOperationSnapshot }
}

function toCancellation(
  record: LocalHostPushBranchOperationRecord,
  reason: HostOperationCancellationReason,
): LocalHostPushBranchOperationRecord {
  const completedAt = Date.now()
  return { ...record, snapshot: { ...hostOperationSnapshotCore(record.snapshot), state: 'canceled',
    revision: record.snapshot.revision + 1, completedAt, updatedAt: completedAt, reason, effect: 'none' } as HostOperationSnapshot }
}
