/** Keyless source-and-artifact snapshot for Saki Project registration and Git operations over real `/saki` transport. */

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  CreateCommitIntent,
  SakiGitOperationIntent,
  SakiGitOperationIntentReceipt,
  SakiProjectChangesProjection,
  SakiProjectDiffProjection,
  StageFilesIntent,
  UnstageFilesIntent,
} from '@breakfastdapaidang/saki-control-plane'
import {
  sakiControlIntentIdSchema,
  type ProjectGitChange,
  type ProjectGitHead,
  type ProjectGitStatusObservation,
  type SelectedProjectGitChange,
} from '@breakfastdapaidang/saki-execution'
import {
  cleanupSnapshot,
  createRepository,
  dropRpcResponse,
  fixtureGitEnvironment,
  freePort,
  inspectSnapshotRepositoryGitState,
  mutationExpectation,
  rawRequest,
  registerSnapshotProject,
  rpc,
  runWithCleanup,
  serializeSnapshotRecords,
  startSaki,
  verifySnapshotOutput,
  type SnapshotRepositoryGitState,
  type StartedSaki,
} from './fixtures/saki-host-snapshot.ts'
import { sakiSnapshotEnvironment } from './saki-snapshot-environment.ts'

const root = resolve(import.meta.dirname, '..')
const sourceBin = join(root, 'packages/saki/bundle/src/bin.ts')
const builtBin = join(root, 'packages/saki/bundle/lib/bin.js')
const expected = join(root, 'scripts/tests/expected/saki-bootstrap/access.expected.jsonl')
const refreshing = process.env.DSH_SNAPSHOT === 'record' || process.env.DSH_SNAPSHOT === 'refresh'
const nullConfig = process.platform === 'win32' ? 'NUL' : '/dev/null'
const stageOnceIntentId = sakiControlIntentIdSchema.parse('intent-22222222-2222-4222-8222-222222222222')
const unstageIntentId = sakiControlIntentIdSchema.parse('intent-33333333-3333-4333-8333-333333333333')
const stageAgainIntentId = sakiControlIntentIdSchema.parse('intent-44444444-4444-4444-8444-444444444444')
const commitIntentId = sakiControlIntentIdSchema.parse('intent-55555555-5555-4555-8555-555555555555')

interface SnapshotGitHeadSummary {
  readonly state: 'attached' | 'detached' | 'unborn'
  readonly objectId: 'present' | 'absent'
  readonly symbolicRef: 'present' | 'absent'
}

function summarizeGitHead(head: ProjectGitHead): SnapshotGitHeadSummary {
  switch (head.kind) {
    case 'commit':
      return {
        state: head.symbolicRef === undefined ? 'detached' : 'attached',
        objectId: 'present',
        symbolicRef: head.symbolicRef === undefined ? 'absent' : 'present',
      }
    case 'unborn':
      return { state: 'unborn', objectId: 'absent', symbolicRef: 'present' }
    default:
      return assertNever(head)
  }
}

function assertNever(_value: never): never {
  throw new Error('Unexpected ProjectGitHead kind')
}

type SuccessfulProjectChangesProjection = Omit<SakiProjectChangesProjection, 'result'> & {
  readonly result: Extract<SakiProjectChangesProjection['result'], { readonly ok: true }>
}

type SuccessfulProjectDiffProjection = Omit<SakiProjectDiffProjection, 'result'> & {
  readonly result: Extract<SakiProjectDiffProjection['result'], { readonly ok: true }>
}

type GitOperationIntentType = SakiGitOperationIntent['type']

type SuccessfulGitOperationReceipt<T extends GitOperationIntentType> =
  Extract<SakiGitOperationIntentReceipt<T>, { readonly ok: true }>

async function queryProjectChanges(
  port: number,
  cookie: string,
  projectId: string,
  expectedRegistryRevision: number,
): Promise<SuccessfulProjectChangesProjection> {
  const response = await rpc(port, 'control/query', {
    type: 'project-changes',
    projectId,
    expectedRegistryRevision,
  }, { cookie })
  const value = response.value as {
    readonly ok: boolean
    readonly projection?: SakiProjectChangesProjection
  }
  expect(value.ok, JSON.stringify(value)).toBe(true)
  if (!value.ok || value.projection === undefined) throw new Error('Saki snapshot Project Changes query failed')
  expect(value.projection.result.ok).toBe(true)
  if (!value.projection.result.ok) throw new Error('Saki snapshot Project Changes observation failed')
  return value.projection as SuccessfulProjectChangesProjection
}

async function queryProjectDiff(
  port: number,
  cookie: string,
  changes: SuccessfulProjectChangesProjection,
  change: SelectedProjectGitChange,
): Promise<SuccessfulProjectDiffProjection> {
  const response = await rpc(port, 'control/query', {
    type: 'project-diff',
    projectId: changes.projectId,
    expectedRegistryRevision: changes.registryRevision,
    request: {
      expectedStatus: changes.result.observation.fingerprint,
      changeId: change.id,
      layer: 'unstaged',
    },
  }, { cookie })
  const value = response.value as {
    readonly ok: boolean
    readonly projection?: SakiProjectDiffProjection
  }
  expect(value.ok, JSON.stringify(value)).toBe(true)
  if (!value.ok || value.projection === undefined) throw new Error('Saki snapshot Project Diff query failed')
  expect(value.projection.result.ok).toBe(true)
  if (!value.projection.result.ok) throw new Error('Saki snapshot Project Diff observation failed')
  return value.projection as SuccessfulProjectDiffProjection
}

function selectChanges(
  observation: ProjectGitStatusObservation,
  mode: 'stage' | 'unstage',
): readonly SelectedProjectGitChange[] {
  const selected = observation.changes.filter((change) => {
    if (mode === 'stage') {
      return change.kind === 'untracked'
        || (change.kind === 'ordinary' && change.worktreeStatus !== 'unchanged')
    }
    return change.kind === 'ordinary' && change.indexStatus !== 'unchanged'
  }).map(change => ({ id: change.id, fingerprint: change.fingerprint }))
  if (selected.length === 0) throw new Error(`Saki snapshot found no ${mode}able Project change`)
  return selected
}

function successfulGitOperation<T extends GitOperationIntentType>(
  value: unknown,
): SuccessfulGitOperationReceipt<T> {
  const result = value as SakiGitOperationIntentReceipt<T>
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(`Saki snapshot Git operation failed: ${result.reason}`)
  return result
}

function summarizeChange(change: ProjectGitChange): {
  readonly path: string
  readonly kind: ProjectGitChange['kind']
  readonly attribution: ProjectGitChange['attribution']
  readonly index: ProjectGitChange['indexStatus']
  readonly worktree: ProjectGitChange['worktreeStatus']
} {
  return {
    path: change.path,
    kind: change.kind,
    attribution: change.attribution,
    index: change.indexStatus,
    worktree: change.worktreeStatus,
  }
}

function summarizeProjectChanges(projection: SuccessfulProjectChangesProjection) {
  const observation = projection.result.observation
  return {
    changes: observation.changes.map(summarizeChange),
    head: summarizeGitHead(observation.head),
    branch: observation.branch.kind,
    index: observation.index.kind,
    operations: {
      stageFiles: projection.gitOperations.stageFiles.available,
      unstageFiles: projection.gitOperations.unstageFiles.available,
      createCommit: projection.gitOperations.createCommit.available,
      current: projection.gitOperations.current?.state ?? 'absent',
    },
  }
}

function summarizeProjectDiff(projection: SuccessfulProjectDiffProjection) {
  const page = projection.result.page
  return {
    layer: page.layer,
    range: page.range,
    pageUtf8Bytes: page.pageUtf8Bytes,
    totalUtf8Bytes: page.totalUtf8Bytes,
    truncated: page.truncated,
    continuation: page.nextCursor === undefined ? 'absent' : 'present',
    lines: page.lines.map(line => /^index [0-9a-f]+\.\.[0-9a-f]+ 100644$/.test(line)
      ? 'index <object-ids> 100644'
      : line),
  }
}

function summarizeExternalGitState(
  state: SnapshotRepositoryGitState,
  initial: SnapshotRepositoryGitState,
) {
  return {
    head: state.headObjectId === initial.headObjectId ? 'original' : 'advanced',
    commitCount: state.commitCount,
    indexMatchesHead: state.indexBlobObjectId === state.headBlobObjectId,
    indexMatchesWorktree: state.indexBlobObjectId === state.worktreeBlobObjectId,
    worktreeMatchesHead: state.worktreeBlobObjectId === state.headBlobObjectId,
    stagedPaths: state.stagedPaths,
    unstagedPaths: state.unstagedPaths,
  }
}

function summarizeIndexOperation(
  result: SuccessfulGitOperationReceipt<'stage-files'> | SuccessfulGitOperationReceipt<'unstage-files'>,
) {
  return {
    state: result.receipt.state,
    operation: { type: result.receipt.operation.type, state: result.receipt.operation.state },
    result: {
      type: result.receipt.result.type,
      paths: result.receipt.result.changes.map(change => change.path),
      resultingIndex: result.receipt.result.resultingIndex.kind,
    },
  }
}

function summarizeCommitOperation(result: SuccessfulGitOperationReceipt<'create-commit'>) {
  expect(result.receipt.result.author).toEqual(result.receipt.result.committer)
  return {
    state: result.receipt.state,
    operation: { type: result.receipt.operation.type, state: result.receipt.operation.state },
    result: {
      type: result.receipt.result.type,
      commitId: 'present',
      treeId: 'present',
      parent: result.receipt.result.parent.kind,
      target: result.receipt.result.target.kind,
      identitySource: result.receipt.result.author.source,
      authorEqualsCommitter: true,
    },
  }
}

async function transcript(entry: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'saki-bootstrap-snapshot-'))
  let first: StartedSaki | undefined
  let second: StartedSaki | undefined
  return await runWithCleanup(async () => {
    const runtimeRoot = join(directory, 'runtime')
    await mkdir(runtimeRoot, { recursive: true })
    const repository = await createRepository(directory)
    await writeFile(join(repository, 'tracked.txt'), 'inherited change\n')
    const inheritedGitState = await inspectSnapshotRepositoryGitState(repository)
    expect(inheritedGitState).toMatchObject({
      commitCount: 1,
      stagedPaths: [],
      unstagedPaths: ['tracked.txt'],
    })
    expect(inheritedGitState.indexBlobObjectId).toBe(inheritedGitState.headBlobObjectId)
    expect(inheritedGitState.worktreeBlobObjectId).not.toBe(inheritedGitState.headBlobObjectId)
    const databasePath = join(directory, 'control.sqlite')
    const port = await freePort()
    first = await startSaki(entry, databasePath, port, true, runtimeRoot)
    const bootstrapSecret = first.bootstrapSecret
    const {
      initial,
      exchangeValue,
      cookie,
      initialIndex,
      inspection,
      selection,
      registrationIntent,
      confirmed,
    } = await registerSnapshotProject(port, bootstrapSecret, repository)
    const registeredIndexResponse = await rpc(port, 'control/query', { type: 'project-index' }, { cookie })
    const registeredIndex = registeredIndexResponse.value as {
      ok: true
      projection: {
        revision: number
        hosts: readonly unknown[]
        projects: [{
          id: string
          projectTitle: string
          binding: {
            id: string
            health: string
            displayLocation: string
            objectFormat: 'sha1' | 'sha256'
            head: ProjectGitHead
            inheritedChangeEntryCount: number
            baseline: string
            automaticMutationEligible: boolean
            configurationGaps: readonly string[]
          }
        }]
      }
    }
    const developmentResponse = await rpc(port, 'control/query', {
      type: 'development-workspace',
      projectId: confirmed.receipt.projectId,
      expectedRegistryRevision: confirmed.receipt.registryRevision,
    }, { cookie })
    const development = developmentResponse.value as {
      ok: true
      projection: {
        registryRevision: number
        project: { projectTitle: string }
        currentSelection?: { inheritedChangeEntryCount: number; workspaceId?: string }
        recovery: { state: string; reasons: readonly string[] }
      }
    }
    const registeredProject = registeredIndex.projection.projects[0]
    const summarizeBinding = (binding: typeof registeredProject.binding) => ({
      health: binding.health,
      displayLocation: binding.displayLocation,
      objectFormat: binding.objectFormat,
      head: summarizeGitHead(binding.head),
      inheritedChangeEntryCount: binding.inheritedChangeEntryCount,
      baseline: binding.baseline,
      automaticMutationEligible: binding.automaticMutationEligible,
      configurationGaps: binding.configurationGaps,
    })
    const records: unknown[] = [
      { step: 'first-launcher', purpose: first.bootstrapPurpose },
      { step: 'first-access', access: initial.value },
      { step: 'bootstrap-exchange', ok: exchangeValue.ok, cookie: 'set' },
      {
        step: 'initial-project-index',
        result: {
          ok: initialIndex.ok,
          revision: initialIndex.projection.revision,
          hosts: initialIndex.projection.hosts.length,
          projects: initialIndex.projection.projects.length,
        },
      },
      {
        step: 'project-inspection',
        result: {
          ok: inspection.ok,
          displayLocation: selection.displayLocation,
          objectFormat: selection.objectFormat,
          head: summarizeGitHead(selection.head),
          inheritedChangeEntryCount: selection.inheritedChangeEntryCount,
          baseline: selection.baseline.kind,
          automaticMutationEligible: selection.automaticMutationEligible,
          workspace: selection.workspaceId === undefined ? 'absent' : 'present',
        },
      },
      {
        step: 'project-registration',
        result: {
          ok: confirmed.ok,
          state: confirmed.receipt.state,
          registryRevision: confirmed.receipt.registryRevision,
        },
      },
      {
        step: 'registered-project-index',
        result: {
          revision: registeredIndex.projection.revision,
          hosts: registeredIndex.projection.hosts.length,
          projects: registeredIndex.projection.projects.length,
          projectTitle: registeredProject.projectTitle,
          binding: summarizeBinding(registeredProject.binding),
        },
      },
      {
        step: 'development-workspace',
        result: {
          revision: development.projection.registryRevision,
          projectTitle: development.projection.project.projectTitle,
          recovery: development.projection.recovery,
          current: {
            inheritedChangeEntryCount: development.projection.currentSelection?.inheritedChangeEntryCount,
            workspace: development.projection.currentSelection?.workspaceId === undefined ? 'absent' : 'present',
          },
        },
      },
    ]

    const workingTreeStatus = await queryProjectChanges(
      port,
      cookie,
      confirmed.receipt.projectId,
      confirmed.receipt.registryRevision,
    )
    expect(workingTreeStatus.result.observation.changes).toHaveLength(1)
    const inheritedChange = workingTreeStatus.result.observation.changes[0]
    if (inheritedChange === undefined) throw new Error('Saki snapshot lost its inherited Git change')
    expect(inheritedChange.attribution).toBe('inherited')
    records.push({
      step: 'git-status',
      result: summarizeProjectChanges(workingTreeStatus),
      externalGit: summarizeExternalGitState(inheritedGitState, inheritedGitState),
    })

    const stageOnceChanges = selectChanges(workingTreeStatus.result.observation, 'stage')
    const stageOnceChange = stageOnceChanges[0]
    if (stageOnceChange === undefined) throw new Error('Saki snapshot lost its selected StageFiles change')
    const unstagedDiff = await queryProjectDiff(port, cookie, workingTreeStatus, stageOnceChange)
    expect(unstagedDiff.result.page.observation).toEqual(workingTreeStatus.result.observation.fingerprint)
    expect(unstagedDiff.result.page.changeId).toBe(stageOnceChange.id)
    records.push({ step: 'git-unstaged-diff', result: summarizeProjectDiff(unstagedDiff) })

    const stageOnceIntent: StageFilesIntent = {
      type: 'stage-files',
      intentId: stageOnceIntentId,
      expected: mutationExpectation(workingTreeStatus),
      changes: stageOnceChanges,
    }
    const stagedOnceResponse = await rpc(port, 'control/submit', stageOnceIntent, {
      cookie,
      requestToken: exchangeValue.access.requestToken,
    })
    const stagedOnce = successfulGitOperation<'stage-files'>(stagedOnceResponse.value)
    const stagedOnceGitState = await inspectSnapshotRepositoryGitState(repository)
    expect(stagedOnceGitState).toMatchObject({
      headObjectId: inheritedGitState.headObjectId,
      commitCount: inheritedGitState.commitCount,
      stagedPaths: ['tracked.txt'],
      unstagedPaths: [],
    })
    expect(stagedOnceGitState.indexBlobObjectId).toBe(stagedOnceGitState.worktreeBlobObjectId)
    expect(stagedOnceGitState.indexBlobObjectId).not.toBe(stagedOnceGitState.headBlobObjectId)
    records.push({
      step: 'git-stage',
      result: summarizeIndexOperation(stagedOnce),
      externalGit: summarizeExternalGitState(stagedOnceGitState, inheritedGitState),
    })

    const stagedStatus = await queryProjectChanges(
      port,
      cookie,
      confirmed.receipt.projectId,
      confirmed.receipt.registryRevision,
    )
    records.push({ step: 'git-staged-status', result: summarizeProjectChanges(stagedStatus) })

    const unstageIntent: UnstageFilesIntent = {
      type: 'unstage-files',
      intentId: unstageIntentId,
      expected: mutationExpectation(stagedStatus),
      changes: selectChanges(stagedStatus.result.observation, 'unstage'),
    }
    const unstagedResponse = await rpc(port, 'control/submit', unstageIntent, {
      cookie,
      requestToken: exchangeValue.access.requestToken,
    })
    const unstaged = successfulGitOperation<'unstage-files'>(unstagedResponse.value)
    const unstagedGitState = await inspectSnapshotRepositoryGitState(repository)
    expect(unstagedGitState).toMatchObject({
      headObjectId: inheritedGitState.headObjectId,
      commitCount: inheritedGitState.commitCount,
      stagedPaths: [],
      unstagedPaths: ['tracked.txt'],
    })
    expect(unstagedGitState.indexBlobObjectId).toBe(unstagedGitState.headBlobObjectId)
    expect(unstagedGitState.worktreeBlobObjectId).not.toBe(unstagedGitState.headBlobObjectId)
    records.push({
      step: 'git-unstage',
      result: summarizeIndexOperation(unstaged),
      externalGit: summarizeExternalGitState(unstagedGitState, inheritedGitState),
    })

    const unstagedStatus = await queryProjectChanges(
      port,
      cookie,
      confirmed.receipt.projectId,
      confirmed.receipt.registryRevision,
    )
    records.push({ step: 'git-unstaged-status', result: summarizeProjectChanges(unstagedStatus) })

    const stageAgainIntent: StageFilesIntent = {
      type: 'stage-files',
      intentId: stageAgainIntentId,
      expected: mutationExpectation(unstagedStatus),
      changes: selectChanges(unstagedStatus.result.observation, 'stage'),
    }
    const stagedAgainResponse = await rpc(port, 'control/submit', stageAgainIntent, {
      cookie,
      requestToken: exchangeValue.access.requestToken,
    })
    const stagedAgain = successfulGitOperation<'stage-files'>(stagedAgainResponse.value)
    const stagedAgainGitState = await inspectSnapshotRepositoryGitState(repository)
    expect(stagedAgainGitState).toMatchObject({
      headObjectId: inheritedGitState.headObjectId,
      commitCount: inheritedGitState.commitCount,
      stagedPaths: ['tracked.txt'],
      unstagedPaths: [],
    })
    expect(stagedAgainGitState.indexBlobObjectId).toBe(stagedAgainGitState.worktreeBlobObjectId)
    expect(stagedAgainGitState.indexBlobObjectId).not.toBe(stagedAgainGitState.headBlobObjectId)
    records.push({
      step: 'git-stage-again',
      result: summarizeIndexOperation(stagedAgain),
      externalGit: summarizeExternalGitState(stagedAgainGitState, inheritedGitState),
    })

    const commitReadyStatus = await queryProjectChanges(
      port,
      cookie,
      confirmed.receipt.projectId,
      confirmed.receipt.registryRevision,
    )
    records.push({ step: 'git-commit-ready-status', result: summarizeProjectChanges(commitReadyStatus) })
    const preCommitHead = commitReadyStatus.result.observation.head
    const commitIntent: CreateCommitIntent = {
      type: 'create-commit',
      intentId: commitIntentId,
      expected: mutationExpectation(commitReadyStatus),
      message: 'snapshot commit',
    }
    const discardedCommitResponse = await dropRpcResponse(port, 'control/submit', commitIntent, {
      cookie,
      requestToken: exchangeValue.access.requestToken,
    })
    records.push({ step: 'git-commit-response-loss', transport: discardedCommitResponse })
    await first.stop()
    first = undefined

    second = await startSaki(entry, databasePath, port, true, runtimeRoot)
    const restoredAccess = await rpc(port, 'access/read', {}, { cookie })
    const safeAccess = restoredAccess.value as {
      kind: string
      principal?: { displayName?: string }
      expiresAt?: number
      requestToken?: string
    }
    if (safeAccess.requestToken === undefined) throw new Error('Saki snapshot restored no request token')
    const replay = await rpc(port, 'control/submit', registrationIntent, {
      cookie,
      requestToken: safeAccess.requestToken,
    })
    const replayed = replay.value as typeof confirmed
    expect(replayed.receipt).toEqual(confirmed.receipt)
    const restoredQuery = await rpc(port, 'control/query', { type: 'project-index' }, { cookie })
    const restoredIndex = restoredQuery.value as typeof registeredIndex
    const replayedCommitResponse = await rpc(port, 'control/submit', commitIntent, {
      cookie,
      requestToken: safeAccess.requestToken,
    })
    const replayedCommit = successfulGitOperation<'create-commit'>(replayedCommitResponse.value)
    const finalChanges = await queryProjectChanges(
      port,
      cookie,
      confirmed.receipt.projectId,
      restoredIndex.projection.revision,
    )
    const finalHead = finalChanges.result.observation.head
    expect(finalChanges.result.observation.changes).toEqual([])
    expect(finalHead.kind).toBe('commit')
    if (finalHead.kind !== 'commit') throw new Error('Saki snapshot Commit left an unborn HEAD')
    expect(finalHead.objectId).toBe(replayedCommit.receipt.result.commitId)
    if (preCommitHead.kind === 'commit') expect(finalHead.objectId).not.toBe(preCommitHead.objectId)
    const committedGitState = await inspectSnapshotRepositoryGitState(repository)
    expect(committedGitState).toMatchObject({
      headObjectId: replayedCommit.receipt.result.commitId,
      commitCount: inheritedGitState.commitCount + 1,
      stagedPaths: [],
      unstagedPaths: [],
    })
    expect(committedGitState.headBlobObjectId).toBe(committedGitState.indexBlobObjectId)
    expect(committedGitState.headBlobObjectId).toBe(committedGitState.worktreeBlobObjectId)
    const restoredDevelopmentResponse = await rpc(port, 'control/query', {
      type: 'development-workspace',
      projectId: confirmed.receipt.projectId,
      expectedRegistryRevision: restoredIndex.projection.revision,
    }, { cookie })
    const restoredDevelopment = restoredDevelopmentResponse.value as typeof development
    const restoredProject = restoredIndex.projection.projects[0]
    expect(restoredProject.id).toBe(confirmed.receipt.projectId)
    expect(restoredProject.binding.id).toBe(confirmed.receipt.resourceBindingId)
    expect(restoredDevelopment.projection.currentSelection?.workspaceId)
      .toBe(development.projection.currentSelection?.workspaceId)
    records.push(
      { step: 'restart-launcher', purpose: second.bootstrapPurpose },
      {
        step: 'restart-access',
        access: {
          kind: safeAccess.kind,
          principal: safeAccess.principal?.displayName,
          session: safeAccess.expiresAt === undefined ? 'absent' : 'restored',
          requestToken: 'derived',
        },
      },
      {
        step: 'restart-registration-replay',
        result: { state: replayed.receipt.state, sameReceipt: true },
      },
      {
        step: 'restart-git-commit-replay',
        result: summarizeCommitOperation(replayedCommit),
      },
      {
        step: 'restart-git-status',
        result: {
          ...summarizeProjectChanges(finalChanges),
          headAdvanced: true,
          headMatchesReceipt: true,
        },
        externalGit: summarizeExternalGitState(committedGitState, inheritedGitState),
      },
      {
        step: 'restart-project-index',
        result: {
          revision: restoredIndex.projection.revision,
          hosts: restoredIndex.projection.hosts.length,
          projects: restoredIndex.projection.projects.length,
          projectTitle: restoredProject.projectTitle,
          stableProjectId: true,
          stableBindingId: true,
          binding: summarizeBinding(restoredProject.binding),
        },
      },
      {
        step: 'restart-development-workspace',
        result: {
          revision: restoredDevelopment.projection.registryRevision,
          projectTitle: restoredDevelopment.projection.project.projectTitle,
          recovery: restoredDevelopment.projection.recovery,
          current: {
            inheritedChangeEntryCount: restoredDevelopment.projection.currentSelection?.inheritedChangeEntryCount,
            workspace: restoredDevelopment.projection.currentSelection?.workspaceId === undefined ? 'absent' : 'present',
            stableWorkspaceId: true,
          },
        },
      },
    )
    const output = serializeSnapshotRecords(
      records,
      [directory, repository, bootstrapSecret, cookie, exchangeValue.access.requestToken],
    )
    await second.stop()
    second = undefined
    return output
  }, async () => { await cleanupSnapshot(directory, first, second) })
}

async function verify(entry: string): Promise<void> {
  const output = await transcript(entry)
  await verifySnapshotOutput(expected, output, refreshing)
}

describe('authenticated Saki bundle snapshot', () => {
  it('summarizes attached, detached, and unborn ProjectGitHead observations', () => {
    expect(summarizeGitHead({
      kind: 'commit',
      objectId: '1'.repeat(40),
      symbolicRef: 'refs/heads/main',
    })).toEqual({ state: 'attached', objectId: 'present', symbolicRef: 'present' })
    expect(summarizeGitHead({ kind: 'commit', objectId: '2'.repeat(40) }))
      .toEqual({ state: 'detached', objectId: 'present', symbolicRef: 'absent' })
    expect(summarizeGitHead({ kind: 'unborn', symbolicRef: 'refs/heads/initial' }))
      .toEqual({ state: 'unborn', objectId: 'absent', symbolicRef: 'present' })
  })

  it('scrubs mixed-case ambient credentials from child processes', () => {
    const key = 'sAkI_SnApShOt_CaNaRy_ToKeN'
    process.env[key] = 'secret'
    try {
      expect(sakiSnapshotEnvironment()[key]).toBeUndefined()
    } finally {
      Reflect.deleteProperty(process.env, key)
    }
  })

  it('isolates fixture Git from mixed-case ambient control variables', () => {
    const key = 'gIt_WoRk_TrEe'
    process.env[key] = 'untrusted'
    try {
      const environment = fixtureGitEnvironment()
      expect(environment[key]).toBeUndefined()
      expect(environment.GIT_CONFIG_GLOBAL).toBe(nullConfig)
      expect(environment.GIT_CONFIG_NOSYSTEM).toBe('1')
      expect(environment.GIT_TERMINAL_PROMPT).toBe('0')
    } finally {
      Reflect.deleteProperty(process.env, key)
    }
  })

  it('runs the source bundle through registration, Git operations, and restart replay', async () => {
    await verify(sourceBin)
  }, 600_000)

  it.skipIf(!existsSync(builtBin))('runs the built bundle through the same Host transport', async () => {
    await verify(builtBin)
  }, 600_000)

  it.skipIf(!existsSync(builtBin))('keeps built pre-dispatch failures inside the Saki rejection policy', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'saki-bootstrap-snapshot-'))
    let started: StartedSaki | undefined
    await runWithCleanup(async () => {
      const port = await freePort()
      const runtimeRoot = join(directory, 'runtime')
      await mkdir(runtimeRoot, { recursive: true })
      started = await startSaki(builtBin, join(directory, 'control.sqlite'), port, true, runtimeRoot)
      const sentinel = 'credential-sentinel'
      for (const method of ['GET', 'HEAD'] as const) {
        const response = await rawRequest(port, method, sentinel)
        expect(response.status).toBe(400)
        expect(response.headers['cache-control']).toBe('no-store')
        expect(response.body).toBe(method === 'HEAD' ? '' : 'Saki request is unavailable')
        expect(response.body).not.toContain(sentinel)
      }
      const trace = await rawRequest(port, 'TRACE')
      expect(trace.status).toBe(400)
      expect(trace.headers['cache-control']).toBe('no-store')
      expect(trace.body).toBe('Saki request is unavailable')
      await started.stop()
      started = undefined
    }, async () => { await cleanupSnapshot(directory, started) })
  })
})
