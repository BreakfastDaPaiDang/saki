import { Context } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it } from 'vitest'
import { canonicalDigest } from '@breakfastdapaidang/saki-execution'
import {
  GitHubProviderError,
  SakiGitHub,
  githubIssueCreateEntryId,
  githubIssueCreateInspectionHintSchema,
  githubIssueCreateInspectionSchema,
  githubIssueId,
  githubIssueStateSetInspectionSchema,
  githubProjectFieldId,
  githubProjectId,
  githubProjectItemAddInspectionSchema,
  githubProjectItemId,
  githubProjectItemPositionSetInspectionSchema,
  githubProjectItemStatusSetInspectionSchema,
  githubProjectOptionId,
  githubRepositoryDatabaseId,
  type GitHubMutationMap,
  type GitHubFailure,
  type GitHubIssueCreateInspectionOutcome,
  type GitHubProjectOptionId,
  type GitHubReadMap,
  type GitHubScanMap,
  type GitHubTargetedWorkItemSnapshot,
} from '@breakfastdapaidang/saki-github'
import type { GitHubWorkItemIntentRecord, GitHubWorkItemRecoveryRecord } from '../src/spec.ts'
import {
  controlIntentActorSchema,
  githubSynchronizationConfigurationSchema,
  githubWorkItemIntentRecordSchema,
  githubWorkItemRecoveryId,
  githubWorkItemRecoveryRecordSchema,
  githubWorkItemStageMutationId,
} from '../src/spec.ts'
import {
  sakiControlIntentIdSchema,
  sakiDevelopmentProjectIdSchema,
  sakiIntentReceiptIdSchema,
} from '../src/ids.ts'
import type {
  GitHubWorkItemMutationContext,
  GitHubWorkItemMutationContextResult,
} from '../src/github-sync.ts'
import type {
  CreateWorkItemIntent,
  MoveWorkItemIntent,
  SakiBoardMutationOverlayProjection,
  SakiBoardMutationAvailabilityProjection,
  SakiControlIntentId,
  SakiDevelopmentProjectId,
  SakiWorkItemIntentReceipt,
  SakiWorkItemMutationStageKind,
  SakiWorkItemRecoveryId,
} from '../src/types.ts'
import {
  GitHubWorkItemOperations,
} from '../src/work-item-operations.ts'
import { boardWorkItemId, targetedBoardRemoteFingerprint } from '../src/work-item-mapping.ts'
import { renderGitHubWorkItemIssueBody } from '../src/work-item-issue.ts'

const PROJECT_ID = sakiDevelopmentProjectIdSchema.parse('project-00000000-0000-4000-8000-000000000101')
const SECOND_PROJECT_ID = sakiDevelopmentProjectIdSchema.parse('project-00000000-0000-4000-8000-000000000109')
const INTENT_ID = sakiControlIntentIdSchema.parse('intent-00000000-0000-4000-8000-000000000102')
const SECOND_INTENT_ID = sakiControlIntentIdSchema.parse('intent-00000000-0000-4000-8000-000000000108')
const THIRD_INTENT_ID = sakiControlIntentIdSchema.parse('intent-00000000-0000-4000-8000-000000000109')
const ISSUE_ID = githubIssueId('I_issue_27')
const CREATED_ISSUE_ID = githubIssueId('I_issue_28')
const ITEM_ID = githubProjectItemId('PVTI_item_27')
const ANCHOR_ISSUE_ID = githubIssueId('I_issue_26')
const ANCHOR_ITEM_ID = githubProjectItemId('PVTI_item_26')
const DUPLICATE_ITEM_ID = githubProjectItemId('PVTI_item_27_duplicate')
const POSITION_DUPLICATE_ITEM_ID = githubProjectItemId('PVTI_duplicate')
const REPLACEMENT_ITEM_ID = githubProjectItemId('PVTI_replacement')
const WORK_ITEM_ID = boardWorkItemId('R_repo', ISSUE_ID)
const ANCHOR_WORK_ITEM_ID = boardWorkItemId('R_repo', ANCHOR_ISSUE_ID)
const RECOVERY_ID = githubWorkItemRecoveryId(PROJECT_ID, WORK_ITEM_ID)

const ACTOR = controlIntentActorSchema.parse({
  installationId: 'installation-00000000-0000-4000-8000-000000000103',
  storageGenerationId: 'storage-generation-00000000-0000-4000-8000-000000000104',
  hostId: 'host-00000000-0000-4000-8000-000000000105',
  principalId: 'principal-00000000-0000-4000-8000-000000000106',
  principalRevision: 1,
  grantId: 'grant-00000000-0000-4000-8000-000000000107',
  grantRevision: 2,
})

const CONFIGURATION = githubSynchronizationConfigurationSchema.parse({
  appId: '10',
  githubInstallationId: '11',
  accountNodeId: 'A_account',
  repositoryNodeId: 'R_repo',
  repositoryDatabaseId: '12',
  projectNodeId: 'P_project',
  credentialRef: credentialRef('SAKI_GITHUB_PRIVATE_KEY'),
  statusFieldNodeId: 'F_status',
  statusOptionNodeIds: {
    inbox: 'O_inbox',
    backlog: 'O_backlog',
    ready: 'O_ready',
    inProgress: 'O_in_progress',
    inReview: 'O_in_review',
    done: 'O_done',
    canceled: 'O_canceled',
  },
  activePollIntervalMs: 30_000,
  backgroundPollIntervalMs: 300_000,
  rateLimitReserve: 500,
})

function snapshot(
  statusOptionId: GitHubProjectOptionId,
  issueState: 'open' | 'closed' = 'open',
): GitHubTargetedWorkItemSnapshot {
  return {
    repositoryId: CONFIGURATION.repositoryNodeId,
    repositoryDatabaseId: CONFIGURATION.repositoryDatabaseId,
    projectId: CONFIGURATION.projectNodeId,
    statusFieldId: CONFIGURATION.statusFieldNodeId,
    issue: {
      id: ISSUE_ID,
      repositoryId: CONFIGURATION.repositoryNodeId,
      repositoryDatabaseId: CONFIGURATION.repositoryDatabaseId,
      number: 27,
      state: issueState,
      title: 'Move through a durable saga',
      url: 'https://github.com/example/repo/issues/27',
      updatedAt: 100,
    },
    membership: {
      state: 'present',
      item: {
        id: ITEM_ID,
        projectId: CONFIGURATION.projectNodeId,
        issueId: ISSUE_ID,
        statusOptionId,
        archived: false,
        apiOrder: 0,
        totalCount: 1,
        previousItemId: null,
        nextItemId: null,
        updatedAt: 100,
      },
    },
  }
}

function positionTargetSnapshot(
  statusOptionId: GitHubProjectOptionId,
  positionedAfter: boolean,
  issueState: 'open' | 'closed' = 'open',
): GitHubTargetedWorkItemSnapshot {
  const current = snapshot(statusOptionId, issueState)
  if (current.membership.state !== 'present') throw new Error('position target fixture lacks membership')
  return {
    ...current,
    membership: {
      state: 'present',
      item: {
        ...current.membership.item,
        apiOrder: positionedAfter ? 1 : 0,
        totalCount: 2,
        previousItemId: positionedAfter ? ANCHOR_ITEM_ID : null,
        nextItemId: positionedAfter ? null : ANCHOR_ITEM_ID,
      },
    },
  }
}

function positionAnchorSnapshot(
  positionedBeforeTarget: boolean,
  statusOptionId: GitHubProjectOptionId = CONFIGURATION.statusOptionNodeIds.inProgress,
): GitHubTargetedWorkItemSnapshot {
  return {
    repositoryId: CONFIGURATION.repositoryNodeId,
    repositoryDatabaseId: CONFIGURATION.repositoryDatabaseId,
    projectId: CONFIGURATION.projectNodeId,
    statusFieldId: CONFIGURATION.statusFieldNodeId,
    issue: {
      id: ANCHOR_ISSUE_ID,
      repositoryId: CONFIGURATION.repositoryNodeId,
      repositoryDatabaseId: CONFIGURATION.repositoryDatabaseId,
      number: 26,
      state: 'open',
      title: 'Stable predecessor',
      url: 'https://github.com/example/repo/issues/26',
      updatedAt: 100,
    },
    membership: {
      state: 'present',
      item: {
        id: ANCHOR_ITEM_ID,
        projectId: CONFIGURATION.projectNodeId,
        issueId: ANCHOR_ISSUE_ID,
        statusOptionId,
        archived: false,
        apiOrder: positionedBeforeTarget ? 0 : 1,
        totalCount: 2,
        previousItemId: positionedBeforeTarget ? null : ITEM_ID,
        nextItemId: positionedBeforeTarget ? ITEM_ID : null,
        updatedAt: 100,
      },
    },
  }
}

const INITIAL_SNAPSHOT = snapshot(CONFIGURATION.statusOptionNodeIds.ready)
const EXPECTED_REMOTE_FINGERPRINT = targetedBoardRemoteFingerprint(INITIAL_SNAPSHOT)
const UNJOINED_SNAPSHOT = {
  ...INITIAL_SNAPSHOT,
  membership: { state: 'absent' as const },
}
const UNJOINED_REMOTE_FINGERPRINT = targetedBoardRemoteFingerprint(UNJOINED_SNAPSHOT)
const INITIAL_POSITION_SNAPSHOT = positionTargetSnapshot(CONFIGURATION.statusOptionNodeIds.ready, false)
const INITIAL_POSITION_REMOTE_FINGERPRINT = targetedBoardRemoteFingerprint(INITIAL_POSITION_SNAPSHOT)
const ANCHOR_POSITION_SNAPSHOT = positionAnchorSnapshot(false)
const ANCHOR_REMOTE_FINGERPRINT = targetedBoardRemoteFingerprint(ANCHOR_POSITION_SNAPSHOT)
const TERMINAL_ANCHOR_POSITION_SNAPSHOT = positionAnchorSnapshot(false, CONFIGURATION.statusOptionNodeIds.done)
const TERMINAL_ANCHOR_REMOTE_FINGERPRINT = targetedBoardRemoteFingerprint(TERMINAL_ANCHOR_POSITION_SNAPSHOT)

const CONTEXT: GitHubWorkItemMutationContext = {
  projectId: PROJECT_ID,
  synchronizationRevision: 3,
  mappingRevision: 3,
  boardGeneration: 7,
  checkpointObservedAt: 100,
  configuration: CONFIGURATION,
  confirmedBoard: {
    generation: 7,
    configurationRevision: 3,
    repository: {
      id: CONFIGURATION.repositoryNodeId,
      nameWithOwner: 'example/repo',
      url: 'https://github.com/example/repo',
    },
    project: {
      id: CONFIGURATION.projectNodeId,
      title: 'Example Project',
      url: 'https://github.com/orgs/example/projects/1',
    },
    items: [{
      id: WORK_ITEM_ID,
      title: INITIAL_SNAPSHOT.issue.title,
      issueNumber: INITIAL_SNAPSHOT.issue.number,
      url: INITIAL_SNAPSHOT.issue.url,
      issueState: 'open',
      status: 'ready',
      latestNonTerminalStatus: 'ready',
      order: 0,
      archived: false,
      notInProject: false,
      updatedAt: 100,
      source: {
        kind: 'github-issue',
        repositoryId: CONFIGURATION.repositoryNodeId,
        issueId: ISSUE_ID,
        projectItemId: ITEM_ID,
        apiOrder: 0,
      },
      remoteFingerprint: EXPECTED_REMOTE_FINGERPRINT,
    }],
  },
}

const UNJOINED_CONTEXT: GitHubWorkItemMutationContext = {
  ...CONTEXT,
  confirmedBoard: {
    ...CONTEXT.confirmedBoard,
    items: [{
      ...CONTEXT.confirmedBoard.items[0]!,
      status: 'inbox',
      latestNonTerminalStatus: 'inbox',
      notInProject: true,
      source: {
        kind: 'github-issue',
        repositoryId: CONFIGURATION.repositoryNodeId,
        issueId: ISSUE_ID,
      },
      remoteFingerprint: UNJOINED_REMOTE_FINGERPRINT,
    }],
  },
}

const POSITION_CONTEXT: GitHubWorkItemMutationContext = {
  ...CONTEXT,
  confirmedBoard: {
    ...CONTEXT.confirmedBoard,
    items: [
      {
        ...CONTEXT.confirmedBoard.items[0]!,
        order: 0,
        source: {
          ...CONTEXT.confirmedBoard.items[0]!.source,
          apiOrder: 0,
        },
        remoteFingerprint: INITIAL_POSITION_REMOTE_FINGERPRINT,
      },
      {
        id: ANCHOR_WORK_ITEM_ID,
        title: ANCHOR_POSITION_SNAPSHOT.issue.title,
        issueNumber: ANCHOR_POSITION_SNAPSHOT.issue.number,
        url: ANCHOR_POSITION_SNAPSHOT.issue.url,
        issueState: 'open',
        status: 'in-progress',
        latestNonTerminalStatus: 'in-progress',
        order: 1,
        archived: false,
        notInProject: false,
        updatedAt: 100,
        source: {
          kind: 'github-issue',
          repositoryId: CONFIGURATION.repositoryNodeId,
          issueId: ANCHOR_ISSUE_ID,
          projectItemId: ANCHOR_ITEM_ID,
          apiOrder: 1,
        },
        remoteFingerprint: ANCHOR_REMOTE_FINGERPRINT,
      },
    ],
  },
}

const UNJOINED_POSITION_CONTEXT: GitHubWorkItemMutationContext = {
  ...POSITION_CONTEXT,
  confirmedBoard: {
    ...POSITION_CONTEXT.confirmedBoard,
    items: [
      UNJOINED_CONTEXT.confirmedBoard.items[0]!,
      POSITION_CONTEXT.confirmedBoard.items[1]!,
    ],
  },
}

const TERMINAL_POSITION_CONTEXT: GitHubWorkItemMutationContext = {
  ...POSITION_CONTEXT,
  confirmedBoard: {
    ...POSITION_CONTEXT.confirmedBoard,
    items: POSITION_CONTEXT.confirmedBoard.items.map(item => item.id === ANCHOR_WORK_ITEM_ID
      ? {
        ...item,
        status: 'done' as const,
        remoteFingerprint: TERMINAL_ANCHOR_REMOTE_FINGERPRINT,
      }
      : item),
  },
}

function membershipSnapshot(
  inProject: boolean,
  duplicate = false,
): GitHubMutationMap['project-item-add']['inspection']['snapshot'] {
  const current = snapshot(CONFIGURATION.statusOptionNodeIds.ready)
  const firstItem = {
    id: ITEM_ID,
    projectId: current.projectId,
    issueId: current.issue.id,
    archived: false,
    apiOrder: 0,
    totalCount: duplicate ? 2 : 1,
    previousItemId: null,
    nextItemId: duplicate ? DUPLICATE_ITEM_ID : null,
    updatedAt: 100,
  }
  return {
    repositoryId: current.repositoryId,
    repositoryDatabaseId: current.repositoryDatabaseId,
    projectId: current.projectId,
    issue: current.issue,
    membership: duplicate
      ? {
        state: 'duplicate-conflict',
        items: [firstItem, {
          ...firstItem,
          id: DUPLICATE_ITEM_ID,
          apiOrder: 1,
          previousItemId: ITEM_ID,
          nextItemId: null,
        }],
      }
      : inProject
        ? {
          state: 'present',
          item: firstItem,
        }
        : { state: 'absent' },
  }
}

const AVAILABLE = { available: true, reasons: [] } as const satisfies SakiBoardMutationAvailabilityProjection
const ALLOWED = { 'work-item:create': true, 'work-item:move': true } as const

class SimulatedProcessCrash extends Error {}

class MemoryTable<K extends string, V> implements KvTable<K, V> {
  readonly values = new Map<K, V>()
  failNextPut: Error | undefined
  failNextUpdate: Error | undefined
  failNextPutAfterCommit: Error | undefined
  failNextUpdateAfterCommit: Error | undefined
  afterUpdate: ((value: V) => void) | undefined
  get size(): number { return this.values.size }
  get(key: K): V | undefined { return this.values.get(key) }
  entries(): IterableIterator<[K, V]> { return new Map(this.values).entries() }
  keys(): IterableIterator<K> { return new Map(this.values).keys() }
  async put(key: K, value: V): Promise<void> {
    if (this.failNextPut !== undefined) {
      const failure = this.failNextPut
      this.failNextPut = undefined
      throw failure
    }
    this.values.set(key, value)
    if (this.failNextPutAfterCommit !== undefined) {
      const failure = this.failNextPutAfterCommit
      this.failNextPutAfterCommit = undefined
      throw failure
    }
  }
  async delete(key: K): Promise<boolean> { return this.values.delete(key) }
  async update(key: K, operation: (current: V) => V): Promise<V> {
    if (this.failNextUpdate !== undefined) {
      const failure = this.failNextUpdate
      this.failNextUpdate = undefined
      throw failure
    }
    const current = this.values.get(key)
    if (current === undefined) throw new Error('missing key')
    const next = operation(current)
    this.values.set(key, next)
    this.afterUpdate?.(next)
    if (this.failNextUpdateAfterCommit !== undefined) {
      const failure = this.failNextUpdateAfterCommit
      this.failNextUpdateAfterCommit = undefined
      throw failure
    }
    return next
  }
}

class StatusGitHub extends SakiGitHub {
  issueId = ISSUE_ID
  issueNumber = 27
  issueTitle = 'Move through a durable saga'
  issueUrl = 'https://github.com/example/repo/issues/27'
  statusOptionId: GitHubProjectOptionId = CONFIGURATION.statusOptionNodeIds.ready
  issueState: 'open' | 'closed' = 'open'
  archived = false
  statusOptionMissing = false
  issueCreated = false
  inProject = true
  duplicateMembership = false
  positionScenario = false
  positionedAfter = false
  positionDuplicateMembership = false
  positionNeighborDrift = false
  anchorStatusOptionId: GitHubProjectOptionId = CONFIGURATION.statusOptionNodeIds.inProgress
  addDispatchMode: 'success' | 'fail-before-effect' | 'mutate-then-fail' = 'success'
  createDispatchMode: 'success' | 'fail-before-effect' | 'mutate-then-fail' | 'effect-then-process-crash' = 'success'
  positionDispatchMode: 'success' | 'fail-before-effect' | 'mutate-then-fail' | 'effect-then-process-crash' = 'success'
  positionDispatchHasEffect = true
  readonly calls: string[] = []
  readonly createInspectionHints: Array<GitHubMutationMap['issue-create']['request']['inspectionHint']> = []
  createInspectionOutcomeOverride: GitHubIssueCreateInspectionOutcome | undefined
  beforeDispatch: ((kind: keyof GitHubMutationMap) => void) | undefined
  dispatchMode: 'success' | 'fail-before-effect' | 'mutate-then-fail' = 'success'
  dispatchFailure: GitHubFailure = { code: 'transient-transport' }
  inspectFailures = 0
  inspectionFailure: GitHubFailure | undefined
  afterInspect: ((kind: keyof GitHubMutationMap) => void) | undefined

  override async read<K extends keyof GitHubReadMap>(request: GitHubReadMap[K]['request']): Promise<GitHubReadMap[K]['result']> {
    throw new GitHubProviderError({ code: 'not-found', resource: request.kind })
  }

  override async scan<K extends keyof GitHubScanMap>(): Promise<GitHubScanMap[K]['result']> {
    throw new Error('status mutation must not run a complete scan')
  }

  override async dispatch<K extends keyof GitHubMutationMap>(
    request: GitHubMutationMap[K]['request'],
  ): Promise<GitHubMutationMap[K]['result']> {
    if (request.kind === 'issue-create') {
      this.calls.push('dispatch:create')
      this.beforeDispatch?.(request.kind)
      if (this.createDispatchMode === 'fail-before-effect') {
        throw new GitHubProviderError({ code: 'transient-transport' })
      }
      this.issueCreated = true
      this.issueId = CREATED_ISSUE_ID
      this.issueNumber = 28
      this.issueTitle = request.title
      this.issueUrl = 'https://github.com/example/repo/issues/28'
      this.inProject = false
      this.statusOptionId = CONFIGURATION.statusOptionNodeIds.ready
      if (this.createDispatchMode === 'effect-then-process-crash') {
        throw new SimulatedProcessCrash('process stopped after the Issue-create effect landed')
      }
      if (this.createDispatchMode === 'mutate-then-fail') {
        throw new GitHubProviderError({ code: 'transient-transport' })
      }
      return githubIssueCreateInspectionHintSchema.parse({
        issueId: CREATED_ISSUE_ID,
        issueNumber: 28,
      })
    }
    if (request.kind === 'project-item-add') {
      this.calls.push('dispatch:add')
      this.beforeDispatch?.(request.kind)
      if (this.addDispatchMode === 'fail-before-effect') {
        throw new GitHubProviderError({ code: 'transient-transport' })
      }
      this.inProject = true
      if (this.addDispatchMode === 'mutate-then-fail') {
        throw new GitHubProviderError({ code: 'transient-transport' })
      }
      return undefined
    }
    if (request.kind === 'project-item-position-set') {
      this.calls.push('dispatch:position')
      this.beforeDispatch?.(request.kind)
      if (this.positionDispatchMode === 'fail-before-effect') {
        throw new GitHubProviderError({ code: 'transient-transport' })
      }
      if (this.positionDispatchHasEffect) this.positionedAfter = request.afterItemId !== null
      if (this.positionDispatchMode === 'effect-then-process-crash') {
        throw new SimulatedProcessCrash('process stopped after the position effect landed')
      }
      if (this.positionDispatchMode === 'mutate-then-fail') {
        throw new GitHubProviderError({ code: 'transient-transport' })
      }
      return undefined
    }
    if (request.kind === 'issue-state-set') {
      this.calls.push('dispatch:issue-state')
      this.beforeDispatch?.(request.kind)
      if (this.dispatchMode === 'fail-before-effect') {
        throw new GitHubProviderError(this.dispatchFailure)
      }
      this.issueState = request.desiredState
      if (this.dispatchMode === 'mutate-then-fail') {
        throw new GitHubProviderError(this.dispatchFailure)
      }
      return undefined
    }
    if (request.kind !== 'project-item-status-set') throw new Error('unexpected mutation kind')
    this.calls.push('dispatch')
    this.beforeDispatch?.(request.kind)
    if (this.dispatchMode === 'fail-before-effect') {
      throw new GitHubProviderError(this.dispatchFailure)
    }
    this.statusOptionId = request.desiredStatusOptionId
    if (this.dispatchMode === 'mutate-then-fail') {
      throw new GitHubProviderError(this.dispatchFailure)
    }
    return undefined
  }

  override async inspectMutation<K extends keyof GitHubMutationMap>(
    request: GitHubMutationMap[K]['request'],
  ): Promise<GitHubMutationMap[K]['inspection']> {
    if (request.kind === 'issue-create') {
      this.calls.push('inspect:create')
      this.createInspectionHints.push(request.inspectionHint)
      if (this.inspectionFailure !== undefined) {
        const failure = this.inspectionFailure
        this.inspectionFailure = undefined
        throw new GitHubProviderError(failure)
      }
      if (this.inspectFailures > 0) {
        this.inspectFailures -= 1
        throw new GitHubProviderError({ code: 'transient-transport' })
      }
      const issue = this.currentSnapshot().issue
      const outcome = this.createInspectionOutcomeOverride ?? (this.issueCreated
        ? { state: 'unique-issue' as const, issue }
        : { state: 'absent-complete' as const })
      const current = {
        repositoryId: CONFIGURATION.repositoryNodeId,
        repositoryDatabaseId: CONFIGURATION.repositoryDatabaseId,
        outcome,
      }
      this.afterInspect?.(request.kind)
      return githubIssueCreateInspectionSchema.parse({
        snapshot: current,
        observedAt: 111,
      })
    }
    if (request.kind === 'project-item-add') {
      this.calls.push('inspect:add')
      if (this.inspectionFailure !== undefined) {
        const failure = this.inspectionFailure
        this.inspectionFailure = undefined
        throw new GitHubProviderError(failure)
      }
      if (this.inspectFailures > 0) {
        this.inspectFailures -= 1
        throw new GitHubProviderError({ code: 'transient-transport' })
      }
      const current = this.currentMembershipSnapshot()
      this.afterInspect?.(request.kind)
      return githubProjectItemAddInspectionSchema.parse({
        snapshot: current,
        observedAt: 111,
      })
    }
    if (request.kind === 'project-item-position-set') {
      this.calls.push('inspect:position')
      if (this.inspectionFailure !== undefined) {
        const failure = this.inspectionFailure
        this.inspectionFailure = undefined
        throw new GitHubProviderError(failure)
      }
      if (this.inspectFailures > 0) {
        this.inspectFailures -= 1
        throw new GitHubProviderError({ code: 'transient-transport' })
      }
      const current = this.currentPositionSnapshot(request)
      this.afterInspect?.(request.kind)
      return githubProjectItemPositionSetInspectionSchema.parse({
        snapshot: current,
        observedAt: 111,
      })
    }
    if (request.kind === 'issue-state-set') {
      this.calls.push('inspect:issue-state')
      if (this.inspectionFailure !== undefined) {
        const failure = this.inspectionFailure
        this.inspectionFailure = undefined
        throw new GitHubProviderError(failure)
      }
      if (this.inspectFailures > 0) {
        this.inspectFailures -= 1
        throw new GitHubProviderError({ code: 'transient-transport' })
      }
      const current = { issue: this.currentSnapshot().issue }
      this.afterInspect?.(request.kind)
      return githubIssueStateSetInspectionSchema.parse({
        snapshot: current,
        observedAt: 111,
      })
    }
    if (request.kind !== 'project-item-status-set') throw new Error('unexpected inspection kind')
    this.calls.push('inspect')
    if (this.inspectionFailure !== undefined) {
      const failure = this.inspectionFailure
      this.inspectionFailure = undefined
      throw new GitHubProviderError(failure)
    }
    if (this.inspectFailures > 0) {
      this.inspectFailures -= 1
      throw new GitHubProviderError({ code: 'transient-transport' })
    }
    const current = this.currentSnapshot()
    this.afterInspect?.(request.kind)
    return githubProjectItemStatusSetInspectionSchema.parse({
      snapshot: current,
      observedAt: 111,
    })
  }

  private currentSnapshot(): GitHubTargetedWorkItemSnapshot {
    const current = this.positionScenario
      ? positionTargetSnapshot(this.statusOptionId, this.positionedAfter, this.issueState)
      : snapshot(this.statusOptionId, this.issueState)
    const issue = {
      ...current.issue,
      id: this.issueId,
      number: this.issueNumber,
      title: this.issueTitle,
      url: this.issueUrl,
    }
    const membership = !this.inProject
      ? { state: 'absent' as const }
      : current.membership.state === 'present'
        ? {
          state: 'present' as const,
          item: { ...current.membership.item, issueId: this.issueId, archived: this.archived },
        }
        : current.membership
    if (membership.state === 'present' && this.statusOptionMissing) {
      const { statusOptionId: _statusOptionId, ...item } = membership.item
      return { ...current, issue, membership: { state: 'present', item } }
    }
    return {
      ...current,
      issue,
      membership,
    }
  }

  private currentPositionSnapshot(
    request: GitHubMutationMap['project-item-position-set']['request'],
  ): GitHubMutationMap['project-item-position-set']['inspection']['snapshot'] {
    const current = this.currentSnapshot()
    const anchor = positionAnchorSnapshot(this.positionedAfter, this.anchorStatusOptionId)
    if (anchor.membership.state !== 'present') {
      throw new Error('position inspection fixture lacks anchor membership')
    }
    const membership = current.membership.state === 'present' && this.positionNeighborDrift
      ? {
        state: 'present' as const,
        item: { ...current.membership.item, nextItemId: POSITION_DUPLICATE_ITEM_ID },
      }
      : current.membership
    return {
      repositoryId: current.repositoryId,
      repositoryDatabaseId: current.repositoryDatabaseId,
      projectId: current.projectId,
      statusFieldId: current.statusFieldId,
      issue: current.issue,
      membership: membership.state === 'present' && this.positionDuplicateMembership
        ? {
          state: 'duplicate-conflict',
          items: [
            { ...membership.item, apiOrder: 0, totalCount: 2, previousItemId: null, nextItemId: POSITION_DUPLICATE_ITEM_ID },
            {
              ...membership.item,
              id: POSITION_DUPLICATE_ITEM_ID,
              apiOrder: 1,
              totalCount: 2,
              previousItemId: membership.item.id,
              nextItemId: null,
            },
          ],
        }
        : membership,
      after: request.afterItemId === null
        ? { state: 'top' }
        : {
          state: 'present',
          item: {
            id: anchor.membership.item.id,
            projectId: anchor.membership.item.projectId,
            issue: anchor.issue,
            statusOptionId: anchor.membership.item.statusOptionId,
            archived: anchor.membership.item.archived,
            apiOrder: anchor.membership.item.apiOrder,
            totalCount: anchor.membership.item.totalCount,
            previousItemId: anchor.membership.item.previousItemId,
            nextItemId: anchor.membership.item.nextItemId,
            updatedAt: anchor.membership.item.updatedAt,
          },
        },
    }
  }

  private currentMembershipSnapshot(): GitHubMutationMap['project-item-add']['inspection']['snapshot'] {
    const current = membershipSnapshot(this.inProject, this.duplicateMembership)
    const issue = this.currentSnapshot().issue
    return {
      ...current,
      issue,
      membership: current.membership.state === 'present'
        ? {
          state: 'present',
          item: { ...current.membership.item, issueId: this.issueId, archived: this.archived },
        }
        : current.membership.state === 'duplicate-conflict'
          ? {
            state: 'duplicate-conflict',
            items: current.membership.items.map(item => ({ ...item, issueId: this.issueId })),
          }
          : current.membership,
    }
  }
}

interface Harness {
  readonly operations: GitHubWorkItemOperations
  readonly intentTable: MemoryTable<SakiControlIntentId, GitHubWorkItemIntentRecord>
  readonly recoveryTable: MemoryTable<SakiWorkItemRecoveryId, GitHubWorkItemRecoveryRecord>
  readonly github: StatusGitHub
  readonly scans: string[]
  readonly changes: number[]
  readonly authority: { current: boolean }
}

interface HarnessDependencies {
  readonly intentTable?: MemoryTable<SakiControlIntentId, GitHubWorkItemIntentRecord> | undefined
  readonly recoveryTable?: MemoryTable<SakiWorkItemRecoveryId, GitHubWorkItemRecoveryRecord> | undefined
  readonly github?: StatusGitHub | undefined
  readonly projectIds?: readonly SakiDevelopmentProjectId[] | undefined
  readonly mutationContext?: (() => GitHubWorkItemMutationContextResult) | undefined
  readonly authorityCurrent?: ((action: keyof typeof ALLOWED) => boolean) | undefined
  readonly validateActorReference?: (() => void) | undefined
}

function harness(
  context: GitHubWorkItemMutationContextResult = { ok: true, context: CONTEXT },
  attach = true,
  dependencies: HarnessDependencies = {},
): Harness {
  const intentTable = dependencies.intentTable
    ?? new MemoryTable<SakiControlIntentId, GitHubWorkItemIntentRecord>()
  const recoveryTable = dependencies.recoveryTable
    ?? new MemoryTable<SakiWorkItemRecoveryId, GitHubWorkItemRecoveryRecord>()
  const github = dependencies.github ?? new StatusGitHub(new Context())
  const projectIds = dependencies.projectIds ?? [PROJECT_ID]
  const scans: string[] = []
  const changes: number[] = []
  const authority = { current: true }
  const operations = new GitHubWorkItemOperations({
    intentTable: intentTable,
    recoveryTable: recoveryTable,
    mutationContext: dependencies.mutationContext ?? (() => structuredClone(context)),
    projectRevision: projectId => projectIds.includes(projectId) ? 4 : 'not-found',
    authorityCurrent: (_actor, action) => dependencies.authorityCurrent?.(action) ?? authority.current,
    validateActorReference: dependencies.validateActorReference ?? (() => {}),
    requestScan: async (projectId) => { scans.push(projectId) },
    notifyChanged: () => { changes.push(changes.length + 1) },
    reportUnexpectedFailure: (error) => { throw error },
    lifetime: new AbortController().signal,
  })
  if (attach) operations.attach(github)
  return { operations, intentTable, recoveryTable, github, scans, changes, authority }
}

interface MutableMutationContext {
  readonly resolve: () => GitHubWorkItemMutationContextResult
  readonly replace: (context: GitHubWorkItemMutationContext) => void
}

function mutableMutationContext(initial: GitHubWorkItemMutationContext): MutableMutationContext {
  let current = initial
  return {
    resolve: () => ({ ok: true, context: structuredClone(current) }),
    replace: (context) => { current = context },
  }
}

function moveIntent(): MoveWorkItemIntent {
  return {
    type: 'move-work-item',
    intentId: INTENT_ID,
    projectId: PROJECT_ID,
    workItemId: WORK_ITEM_ID,
    expectedRemoteFingerprint: EXPECTED_REMOTE_FINGERPRINT,
    targetStatus: 'in-progress',
  }
}

function positionMoveIntent(): MoveWorkItemIntent {
  return {
    ...moveIntent(),
    expectedRemoteFingerprint: INITIAL_POSITION_REMOTE_FINGERPRINT,
    position: {
      afterWorkItemId: ANCHOR_WORK_ITEM_ID,
      expectedAfterRemoteFingerprint: ANCHOR_REMOTE_FINGERPRINT,
    },
  }
}

function unjoinedPositionMoveIntent(): MoveWorkItemIntent {
  return {
    ...positionMoveIntent(),
    expectedRemoteFingerprint: UNJOINED_REMOTE_FINGERPRINT,
  }
}

function terminalMoveIntent(): MoveWorkItemIntent {
  return {
    ...moveIntent(),
    targetStatus: 'done',
  }
}

function terminalPositionMoveIntent(): MoveWorkItemIntent {
  return {
    ...positionMoveIntent(),
    targetStatus: 'done',
    position: {
      afterWorkItemId: ANCHOR_WORK_ITEM_ID,
      expectedAfterRemoteFingerprint: TERMINAL_ANCHOR_REMOTE_FINGERPRINT,
    },
  }
}

function topPositionMoveIntent(): MoveWorkItemIntent {
  return {
    ...moveIntent(),
    expectedRemoteFingerprint: INITIAL_POSITION_REMOTE_FINGERPRINT,
    position: { afterWorkItemId: null },
  }
}

function unjoinedMoveIntent(): MoveWorkItemIntent {
  return {
    ...moveIntent(),
    expectedRemoteFingerprint: UNJOINED_REMOTE_FINGERPRINT,
  }
}

function createIntent(): CreateWorkItemIntent {
  return {
    type: 'create-work-item',
    intentId: INTENT_ID,
    projectId: PROJECT_ID,
    expected: {
      projectRevision: 4,
      synchronizationRevision: CONTEXT.synchronizationRevision,
      mappingRevision: CONTEXT.mappingRevision,
    },
    title: 'Create through a durable marker saga',
    intendedOutcome: 'One Issue exists and can be recovered after restart.',
    acceptanceCriteria: ['The marker is persisted before dispatch', 'The Issue is added exactly once'],
  }
}

function requiredIntent(state: Harness, intentId = INTENT_ID): GitHubWorkItemIntentRecord {
  const record = state.intentTable.get(intentId)
  if (record === undefined) throw new Error('Work Item Intent fixture is missing')
  return record
}

function requiredRecovery(state: Harness): GitHubWorkItemRecoveryRecord {
  const record = state.recoveryTable.get(RECOVERY_ID)
  if (record === undefined) throw new Error('Work Item recovery fixture is missing')
  return record
}

async function retainedPreparedMove(): Promise<Harness> {
  const state = harness({ ok: true, context: CONTEXT }, false)
  await state.operations.submit(moveIntent(), ACTOR, new AbortController().signal)
  return state
}

async function retainedSucceededMove(): Promise<Harness> {
  const state = harness()
  await state.operations.submit(moveIntent(), ACTOR, new AbortController().signal)
  return state
}

async function retainedEffectPossiblePosition(dependencies: HarnessDependencies = {}): Promise<Harness> {
  const state = harness({ ok: true, context: POSITION_CONTEXT }, true, dependencies)
  state.github.positionScenario = true
  state.github.positionDispatchMode = 'fail-before-effect'
  const result = await state.operations.submit(positionMoveIntent(), ACTOR, new AbortController().signal)
  expect(result).toMatchObject({
    ok: false,
    receipt: {
      state: 'partial-failure',
      stage: 'project-item-position-set',
      recoveryAction: { kind: 'inspect-before-retry' },
    },
  })
  state.github.positionDispatchMode = 'success'
  return state
}

interface DurableValidationRejection {
  readonly name: string
  readonly expected: string
  readonly arrange: () => Promise<{
    readonly state: Harness
    readonly otherIntentIds?: ReadonlySet<SakiControlIntentId> | undefined
  }>
}

const durableValidationRejections: readonly DurableValidationRejection[] = [
  {
    name: 'an Intent stored under another table key',
    expected: 'GitHub Work Item Intent id disagrees with its table key',
    arrange: async () => {
      const state = await retainedPreparedMove()
      const record = requiredIntent(state)
      state.intentTable.values.clear()
      state.intentTable.values.set(SECOND_INTENT_ID, record)
      return { state }
    },
  },
  {
    name: 'an Intent id already owned by another Intent kind',
    expected: `Saki Control Intent '${INTENT_ID}' is retained by multiple Intent kinds`,
    arrange: async () => ({
      state: await retainedPreparedMove(),
      otherIntentIds: new Set([INTENT_ID]),
    }),
  },
  {
    name: 'an Actor reference rejected by the Foundation owner',
    expected: 'invalid Work Item Actor reference',
    arrange: async () => {
      const prepared = await retainedPreparedMove()
      return {
        state: harness({ ok: true, context: CONTEXT }, false, {
          intentTable: prepared.intentTable,
          recoveryTable: prepared.recoveryTable,
          validateActorReference: () => { throw new Error('invalid Work Item Actor reference') },
        }),
      }
    },
  },
  {
    name: 'an Intent whose Development Project is missing',
    expected: 'GitHub Work Item Intent targets a missing Development Project',
    arrange: async () => {
      const prepared = await retainedPreparedMove()
      return {
        state: harness({ ok: true, context: CONTEXT }, false, {
          intentTable: prepared.intentTable,
          recoveryTable: prepared.recoveryTable,
          projectIds: [],
        }),
      }
    },
  },
  {
    name: 'a move target bound to another GitHub Issue',
    expected: 'GitHub Work Item move target disagrees with its Saki Work Item identity',
    arrange: async () => {
      const state = await retainedPreparedMove()
      const record = requiredIntent(state)
      if (record.target.kind !== 'move-work-item') throw new Error('move target fixture is missing')
      const otherIssueId = githubIssueId('I_other_issue')
      state.intentTable.values.set(INTENT_ID, githubWorkItemIntentRecordSchema.parse({
        ...record,
        target: { ...record.target, issueId: otherIssueId },
        stages: record.stages.map(stage => ({
          ...stage,
          resolvedTarget: stage.resolvedTarget?.kind === 'project-item-status-set'
            ? { ...stage.resolvedTarget, issueId: otherIssueId }
            : stage.resolvedTarget,
        })),
      }))
      return { state }
    },
  },
  {
    name: 'a recovery stored under another table key',
    expected: 'GitHub Work Item recovery id disagrees with its table key',
    arrange: async () => {
      const state = await retainedSucceededMove()
      const recovery = requiredRecovery(state)
      state.recoveryTable.values.clear()
      state.recoveryTable.values.set(
        githubWorkItemRecoveryId(SECOND_PROJECT_ID, WORK_ITEM_ID),
        recovery,
      )
      return { state }
    },
  },
  {
    name: 'a recovery whose Development Project is missing',
    expected: 'GitHub Work Item recovery targets a missing Development Project',
    arrange: async () => {
      const state = await retainedSucceededMove()
      const recovery = requiredRecovery(state)
      const id = githubWorkItemRecoveryId(SECOND_PROJECT_ID, WORK_ITEM_ID)
      state.recoveryTable.values.clear()
      state.recoveryTable.values.set(id, githubWorkItemRecoveryRecordSchema.parse({
        ...recovery,
        id,
        projectId: SECOND_PROJECT_ID,
      }))
      return { state }
    },
  },
  {
    name: 'a recovery whose source Intent is missing',
    expected: 'GitHub Work Item recovery source Intent disagrees with its scoped Work Item',
    arrange: async () => {
      const state = await retainedSucceededMove()
      state.intentTable.values.clear()
      return { state }
    },
  },
  {
    name: 'a recovery whose source Intent belongs to another Development Project',
    expected: 'GitHub Work Item recovery source Intent disagrees with its scoped Work Item',
    arrange: async () => {
      const succeeded = await retainedSucceededMove()
      const recovery = requiredRecovery(succeeded)
      const id = githubWorkItemRecoveryId(SECOND_PROJECT_ID, WORK_ITEM_ID)
      succeeded.recoveryTable.values.clear()
      succeeded.recoveryTable.values.set(id, githubWorkItemRecoveryRecordSchema.parse({
        ...recovery,
        id,
        projectId: SECOND_PROJECT_ID,
      }))
      return {
        state: harness({ ok: true, context: CONTEXT }, false, {
          intentTable: succeeded.intentTable,
          recoveryTable: succeeded.recoveryTable,
          projectIds: [PROJECT_ID, SECOND_PROJECT_ID],
        }),
      }
    },
  },
  {
    name: 'a recovery whose source Intent has not materialized that Work Item',
    expected: 'GitHub Work Item recovery source Intent disagrees with its scoped Work Item',
    arrange: async () => {
      const succeeded = await retainedSucceededMove()
      succeeded.intentTable.values.clear()
      const state = harness({ ok: true, context: CONTEXT }, false, {
        intentTable: succeeded.intentTable,
        recoveryTable: succeeded.recoveryTable,
      })
      await state.operations.submit(createIntent(), ACTOR, new AbortController().signal)
      return { state }
    },
  },
  {
    name: 'an effect-bearing Intent without targeted recovery',
    expected: 'effect-bearing GitHub Work Item Intent has no targeted recovery observation',
    arrange: async () => {
      const state = await retainedSucceededMove()
      state.recoveryTable.values.clear()
      return { state }
    },
  },
  {
    name: 'a no-effect terminal observation without targeted recovery',
    expected: 'effect-bearing GitHub Work Item Intent has no targeted recovery observation',
    arrange: async () => {
      const state = harness()
      state.github.statusOptionId = CONFIGURATION.statusOptionNodeIds.inProgress
      await state.operations.submit(moveIntent(), ACTOR, new AbortController().signal)
      state.recoveryTable.values.clear()
      return { state }
    },
  },
  {
    name: 'an active effect-bearing Intent whose recovery belongs to its predecessor',
    expected: 'active effect-bearing GitHub Work Item Intent does not own targeted recovery',
    arrange: async () => {
      const succeeded = await retainedSucceededMove()
      const expectedRemoteFingerprint = targetedBoardRemoteFingerprint(snapshot(
        CONFIGURATION.statusOptionNodeIds.inProgress,
      ))
      const state = harness({ ok: true, context: CONTEXT }, false, {
        intentTable: succeeded.intentTable,
        recoveryTable: succeeded.recoveryTable,
      })
      await state.operations.submit({
        ...moveIntent(),
        intentId: SECOND_INTENT_ID,
        expectedRemoteFingerprint,
        targetStatus: 'in-review',
      }, ACTOR, new AbortController().signal)
      const successor = requiredIntent(state, SECOND_INTENT_ID)
      state.intentTable.values.set(SECOND_INTENT_ID, githubWorkItemIntentRecordSchema.parse({
        ...successor,
        phase: 'running',
        stages: successor.stages.map((stage, index) => index === 0
          ? { ...stage, state: 'dispatching', effectPossible: true }
          : stage),
      }))
      return { state }
    },
  },
  {
    name: 'terminal recovery superseded by a chronologically older Intent',
    expected: 'terminal GitHub Work Item recovery was superseded by a non-successor Intent',
    arrange: async () => {
      const state = await retainedSucceededMove()
      const predecessor = requiredIntent(state)
      if (predecessor.terminalEvidence?.kind !== 'succeeded') {
        throw new Error('terminal predecessor fixture is missing')
      }
      const expectedRemoteFingerprint = targetedBoardRemoteFingerprint(snapshot(
        CONFIGURATION.statusOptionNodeIds.inProgress,
      ))
      await state.operations.submit({
        ...moveIntent(),
        intentId: SECOND_INTENT_ID,
        expectedRemoteFingerprint,
        targetStatus: 'in-review',
      }, ACTOR, new AbortController().signal)
      const successor = requiredIntent(state, SECOND_INTENT_ID)
      state.intentTable.values.set(SECOND_INTENT_ID, githubWorkItemIntentRecordSchema.parse({
        ...successor,
        createdAt: predecessor.terminalEvidence.confirmedAt - 1,
      }))
      return { state }
    },
  },
]

type WorkItemSubmitResult = SakiWorkItemIntentReceipt<
  CreateWorkItemIntent['type'] | MoveWorkItemIntent['type']
>

interface ProviderRecoveryExercise {
  readonly state: Harness
  readonly first: WorkItemSubmitResult
  readonly terminal: WorkItemSubmitResult
  readonly replay: () => Promise<WorkItemSubmitResult>
  readonly dispatchCall: string
  readonly expectedDispatchCount: number
  readonly expectedCreateInspectionHints?: readonly GitHubMutationMap['issue-create']['request']['inspectionHint'][]
}

interface ProviderRecoveryScenario {
  readonly name: string
  readonly exercise: () => Promise<ProviderRecoveryExercise>
  readonly assertFirst: (result: WorkItemSubmitResult) => void
  readonly assertTerminal: (result: WorkItemSubmitResult) => void
}

const providerRecoveryScenarios: readonly ProviderRecoveryScenario[] = [
  {
    name: 'a Create post-dispatch inspection failure through marker replay',
    exercise: async () => {
      const state = harness()
      const intent = createIntent()
      state.github.beforeDispatch = () => {
        if (state.github.calls.at(-1) === 'dispatch:create') state.github.inspectFailures = 1
      }
      const first = await state.operations.submit(intent, ACTOR, new AbortController().signal)
      const overlay = state.operations.project(PROJECT_ID, CONTEXT.confirmedBoard, AVAILABLE, ALLOWED)
        .mutationOverlays[0]
      expect(overlay).toEqual({
        state: 'partial-failure',
        intentId: INTENT_ID,
        type: 'create-work-item',
        stage: 'issue-create',
        recoveryAction: { kind: 'inspect-before-retry' },
      })
      expect(overlay).not.toHaveProperty('workItemId')
      state.github.beforeDispatch = undefined
      const terminal = await state.operations.submit(intent, ACTOR, new AbortController().signal)
      return {
        state,
        first,
        terminal,
        replay: async () => await state.operations.submit(intent, ACTOR, new AbortController().signal),
        dispatchCall: 'dispatch:create',
        expectedDispatchCount: 1,
        expectedCreateInspectionHints: [
          undefined,
          { issueId: CREATED_ISSUE_ID, issueNumber: 28 },
          undefined,
        ],
      }
    },
    assertFirst: (result) => {
      expect(result).toMatchObject({
        ok: false,
        reason: 'unavailable',
        receipt: {
          state: 'partial-failure',
          stage: 'issue-create',
          recoveryAction: { kind: 'inspect-before-retry' },
        },
      })
    },
    assertTerminal: (result) => {
      expect(result).toMatchObject({
        ok: true,
        receipt: { state: 'succeeded', type: 'create-work-item', issueNumber: 28 },
      })
    },
  },
  {
    name: 'a failed membership dispatch with complete absence as effect-unknown',
    exercise: async () => {
      const state = harness({ ok: true, context: UNJOINED_CONTEXT })
      const intent = unjoinedMoveIntent()
      state.github.inProject = false
      state.github.addDispatchMode = 'fail-before-effect'
      const terminal = await state.operations.submit(intent, ACTOR, new AbortController().signal)
      return {
        state,
        first: terminal,
        terminal,
        replay: async () => await state.operations.submit(intent, ACTOR, new AbortController().signal),
        dispatchCall: 'dispatch:add',
        expectedDispatchCount: 1,
      }
    },
    assertFirst: (result) => {
      expect(result).toMatchObject({
        ok: false,
        reason: 'reconciliation-required',
        receipt: {
          state: 'reconciliation-required',
          stage: 'project-item-add',
          reason: 'effect-unknown',
        },
      })
    },
    assertTerminal: (result) => {
      expect(result).toMatchObject({
        ok: false,
        reason: 'reconciliation-required',
      })
    },
  },
  {
    name: 'a duplicate membership found while recovering an effect-possible add',
    exercise: async () => {
      const state = harness({ ok: true, context: UNJOINED_CONTEXT })
      const intent = unjoinedMoveIntent()
      state.github.inProject = false
      state.github.addDispatchMode = 'fail-before-effect'
      state.github.beforeDispatch = () => {
        if (state.github.calls.at(-1) === 'dispatch:add') state.github.inspectFailures = 1
      }
      const first = await state.operations.submit(intent, ACTOR, new AbortController().signal)
      state.github.beforeDispatch = undefined
      state.github.inProject = true
      state.github.duplicateMembership = true
      const terminal = await state.operations.submit(intent, ACTOR, new AbortController().signal)
      return {
        state,
        first,
        terminal,
        replay: async () => await state.operations.submit(intent, ACTOR, new AbortController().signal),
        dispatchCall: 'dispatch:add',
        expectedDispatchCount: 1,
      }
    },
    assertFirst: (result) => {
      expect(result).toMatchObject({
        ok: false,
        reason: 'unavailable',
        receipt: {
          state: 'partial-failure',
          stage: 'project-item-add',
          recoveryAction: { kind: 'inspect-before-retry' },
        },
      })
    },
    assertTerminal: (result) => {
      expect(result).toMatchObject({
        ok: false,
        reason: 'reconciliation-required',
        receipt: {
          state: 'reconciliation-required',
          stage: 'project-item-add',
          reason: 'evidence-conflict',
        },
      })
    },
  },
  {
    name: 'a terminal Issue-state dispatch that failed before its effect',
    exercise: async () => {
      const state = harness()
      const intent = terminalMoveIntent()
      state.github.beforeDispatch = () => {
        if (state.github.calls.at(-1) === 'dispatch:issue-state') {
          state.github.dispatchMode = 'fail-before-effect'
        }
      }
      const first = await state.operations.submit(intent, ACTOR, new AbortController().signal)
      state.github.beforeDispatch = undefined
      state.github.dispatchMode = 'success'
      const terminal = await state.operations.submit(intent, ACTOR, new AbortController().signal)
      return {
        state,
        first,
        terminal,
        replay: async () => await state.operations.submit(intent, ACTOR, new AbortController().signal),
        dispatchCall: 'dispatch:issue-state',
        expectedDispatchCount: 2,
      }
    },
    assertFirst: (result) => {
      expect(result).toMatchObject({
        ok: false,
        reason: 'unavailable',
        receipt: {
          state: 'partial-failure',
          stage: 'issue-state-set',
          recoveryAction: { kind: 'inspect-before-retry' },
        },
      })
    },
    assertTerminal: (result) => {
      expect(result).toMatchObject({
        ok: true,
        receipt: { state: 'succeeded', type: 'move-work-item', workItemId: WORK_ITEM_ID },
      })
    },
  },
  {
    name: 'a landed terminal Issue-state effect whose acknowledgement was lost',
    exercise: async () => {
      const state = harness()
      const intent = terminalMoveIntent()
      state.github.beforeDispatch = () => {
        if (state.github.calls.at(-1) === 'dispatch:issue-state') {
          state.github.dispatchMode = 'mutate-then-fail'
        }
      }
      const terminal = await state.operations.submit(intent, ACTOR, new AbortController().signal)
      state.github.beforeDispatch = undefined
      return {
        state,
        first: terminal,
        terminal,
        replay: async () => await state.operations.submit(intent, ACTOR, new AbortController().signal),
        dispatchCall: 'dispatch:issue-state',
        expectedDispatchCount: 1,
      }
    },
    assertFirst: (result) => {
      expect(result).toMatchObject({
        ok: true,
        receipt: { state: 'succeeded', type: 'move-work-item', workItemId: WORK_ITEM_ID },
      })
    },
    assertTerminal: (result) => {
      expect(result).toMatchObject({
        ok: true,
        receipt: { state: 'succeeded' },
      })
    },
  },
]

const createEffectPossibleMarkerOutcomes = [
  {
    name: 'an Issue identity conflict',
    reason: 'evidence-conflict',
    outcome: {
      state: 'identity-conflict',
      hint: { issueId: CREATED_ISSUE_ID, issueNumber: 28 },
      observed: {
        kind: 'issue',
        issue: snapshot(CONFIGURATION.statusOptionNodeIds.ready).issue,
        markerOccurrences: 1,
      },
    },
  },
  {
    name: 'a Pull Request marker match',
    reason: 'marker-ambiguous',
    outcome: {
      state: 'pull-request-marker-match',
      pullRequest: {
        id: githubIssueCreateEntryId('PR_marker_28'),
        repositoryId: CONFIGURATION.repositoryNodeId,
        repositoryDatabaseId: CONFIGURATION.repositoryDatabaseId,
        number: 28,
        state: 'open',
        title: 'Marker-bearing Pull Request',
        url: 'https://github.com/example/repo/pull/28',
        updatedAt: 100,
      },
    },
  },
] as const satisfies readonly {
  readonly name: string
  readonly reason: 'evidence-conflict' | 'marker-ambiguous'
  readonly outcome: GitHubIssueCreateInspectionOutcome
}[]

interface DispatchContradictionScenario {
  readonly name: string
  readonly stage: SakiWorkItemMutationStageKind
  readonly dispatchCall: string
  readonly inspectionCall: string
  readonly resultReason: 'conflict' | 'reconciliation-required'
  readonly receiptReason: 'stale-remote' | 'mapping-repair-required' | 'evidence-conflict'
  readonly arrange: () => {
    readonly state: Harness
    readonly intent: MoveWorkItemIntent
  }
  readonly assertEvidence: (state: Harness, record: GitHubWorkItemIntentRecord) => void
}

const dispatchContradictionScenarios: readonly DispatchContradictionScenario[] = [
  {
    name: 'a membership add that reveals duplicate Project items',
    stage: 'project-item-add',
    dispatchCall: 'dispatch:add',
    inspectionCall: 'inspect:add',
    resultReason: 'reconciliation-required',
    receiptReason: 'evidence-conflict',
    arrange: () => {
      const state = harness({ ok: true, context: UNJOINED_CONTEXT })
      state.github.inProject = false
      state.github.addDispatchMode = 'fail-before-effect'
      state.github.beforeDispatch = () => {
        if (state.github.calls.at(-1) !== 'dispatch:add') return
        state.github.inProject = true
        state.github.duplicateMembership = true
      }
      return { state, intent: unjoinedMoveIntent() }
    },
    assertEvidence: (state, record) => {
      expect(record.terminalEvidence).toEqual({
        kind: 'reconciliation-required',
        reason: 'evidence-conflict',
        stageMutationId: githubWorkItemStageMutationId(INTENT_ID, 'project-item-add'),
      })
      expect(state.recoveryTable.size).toBe(0)
      expect(state.scans).toEqual([])
      expect(state.operations.project(
        PROJECT_ID,
        UNJOINED_CONTEXT.confirmedBoard,
        AVAILABLE,
        ALLOWED,
      ).mutationOverlays).toEqual([{
        state: 'reconciliation-required',
        intentId: INTENT_ID,
        type: 'move-work-item',
        workItemId: WORK_ITEM_ID,
        stage: 'project-item-add',
        reason: 'evidence-conflict',
      }])
    },
  },
  {
    name: 'a Status set that finds the Work Item moved elsewhere',
    stage: 'project-item-status-set',
    dispatchCall: 'dispatch',
    inspectionCall: 'inspect',
    resultReason: 'conflict',
    receiptReason: 'stale-remote',
    arrange: () => {
      const state = harness()
      state.github.dispatchMode = 'fail-before-effect'
      state.github.beforeDispatch = () => {
        if (state.github.calls.at(-1) === 'dispatch') {
          state.github.statusOptionId = CONFIGURATION.statusOptionNodeIds.backlog
        }
      }
      return { state, intent: moveIntent() }
    },
    assertEvidence: (state, record) => {
      const remoteFingerprint = targetedBoardRemoteFingerprint(snapshot(
        CONFIGURATION.statusOptionNodeIds.backlog,
      ))
      expect(record.terminalEvidence).toMatchObject({
        kind: 'conflict',
        reason: 'stale-remote',
        confirmedObservation: {
          stageKind: 'project-item-status-set',
          remoteFingerprint,
          facts: {
            issue: { state: 'open' },
            membership: { item: { statusOptionId: CONFIGURATION.statusOptionNodeIds.backlog } },
          },
        },
      })
      expect(requiredRecovery(state)).toMatchObject({
        confirmed: {
          sourceIntentId: INTENT_ID,
          observation: { stageKind: 'project-item-status-set', remoteFingerprint },
        },
        latestNonTerminalStatus: 'backlog',
      })
      expect(state.scans).toEqual([PROJECT_ID])
      expect(state.operations.project(
        PROJECT_ID,
        CONTEXT.confirmedBoard,
        AVAILABLE,
        ALLOWED,
      ).mutationOverlays).toMatchObject([{
        state: 'conflict',
        intentId: INTENT_ID,
        type: 'move-work-item',
        reason: 'stale-remote',
        workItem: {
          id: WORK_ITEM_ID,
          issueState: 'open',
          status: 'backlog',
          latestNonTerminalStatus: 'backlog',
          remoteFingerprint,
        },
      }])
    },
  },
  {
    name: 'a position set that finds its predecessor in another Status',
    stage: 'project-item-position-set',
    dispatchCall: 'dispatch:position',
    inspectionCall: 'inspect:position',
    resultReason: 'conflict',
    receiptReason: 'stale-remote',
    arrange: () => {
      const state = harness({ ok: true, context: POSITION_CONTEXT })
      state.github.positionScenario = true
      state.github.positionDispatchMode = 'fail-before-effect'
      state.github.beforeDispatch = () => {
        if (state.github.calls.at(-1) === 'dispatch:position') {
          state.github.anchorStatusOptionId = CONFIGURATION.statusOptionNodeIds.backlog
        }
      }
      return { state, intent: positionMoveIntent() }
    },
    assertEvidence: (state, record) => {
      const remoteFingerprint = targetedBoardRemoteFingerprint(positionTargetSnapshot(
        CONFIGURATION.statusOptionNodeIds.inProgress,
        false,
      ))
      expect(record.terminalEvidence).toMatchObject({
        kind: 'conflict',
        reason: 'stale-remote',
        confirmedObservation: {
          stageKind: 'project-item-position-set',
          facts: {
            membership: { item: { statusOptionId: CONFIGURATION.statusOptionNodeIds.inProgress } },
            after: { item: { statusOptionId: CONFIGURATION.statusOptionNodeIds.backlog } },
          },
        },
      })
      expect(requiredRecovery(state)).toMatchObject({
        confirmed: {
          sourceIntentId: INTENT_ID,
          observation: { stageKind: 'project-item-position-set' },
        },
        latestNonTerminalStatus: 'in-progress',
      })
      expect(state.scans).toEqual([PROJECT_ID])
      expect(state.operations.project(
        PROJECT_ID,
        POSITION_CONTEXT.confirmedBoard,
        AVAILABLE,
        ALLOWED,
      ).mutationOverlays).toMatchObject([{
        state: 'conflict',
        intentId: INTENT_ID,
        type: 'move-work-item',
        reason: 'stale-remote',
        workItem: {
          id: WORK_ITEM_ID,
          issueState: 'open',
          status: 'in-progress',
          latestNonTerminalStatus: 'in-progress',
          remoteFingerprint,
        },
      }])
    },
  },
  {
    name: 'an Issue-state set whose desired Issue state contradicts the Board Status',
    stage: 'issue-state-set',
    dispatchCall: 'dispatch:issue-state',
    inspectionCall: 'inspect:issue-state',
    resultReason: 'conflict',
    receiptReason: 'stale-remote',
    arrange: () => {
      const state = harness()
      state.github.beforeDispatch = () => {
        if (state.github.calls.at(-1) !== 'dispatch:issue-state') return
        state.github.dispatchMode = 'fail-before-effect'
        state.github.issueState = 'closed'
        state.github.statusOptionId = CONFIGURATION.statusOptionNodeIds.backlog
      }
      return { state, intent: terminalMoveIntent() }
    },
    assertEvidence: (state, record) => {
      const remoteFingerprint = targetedBoardRemoteFingerprint(snapshot(
        CONFIGURATION.statusOptionNodeIds.backlog,
        'closed',
      ))
      expect(record.terminalEvidence).toMatchObject({
        kind: 'conflict',
        reason: 'stale-remote',
        confirmedObservation: {
          stageKind: 'project-item-status-set',
          remoteFingerprint,
          facts: {
            issue: { state: 'closed' },
            membership: { item: { statusOptionId: CONFIGURATION.statusOptionNodeIds.backlog } },
          },
        },
      })
      expect(requiredRecovery(state)).toMatchObject({
        confirmed: {
          sourceIntentId: INTENT_ID,
          observation: { stageKind: 'project-item-status-set', remoteFingerprint },
        },
        latestNonTerminalStatus: 'backlog',
      })
      expect(state.scans).toEqual([PROJECT_ID])
      expect(state.operations.project(
        PROJECT_ID,
        CONTEXT.confirmedBoard,
        AVAILABLE,
        ALLOWED,
      ).mutationOverlays).toMatchObject([{
        state: 'conflict',
        intentId: INTENT_ID,
        type: 'move-work-item',
        reason: 'stale-remote',
        workItem: {
          id: WORK_ITEM_ID,
          issueState: 'closed',
          status: 'backlog',
          latestNonTerminalStatus: 'backlog',
          remoteFingerprint,
        },
      }])
    },
  },
  {
    name: 'a successful membership add followed by a closed Issue',
    stage: 'project-item-add',
    dispatchCall: 'dispatch:add',
    inspectionCall: 'inspect:add',
    resultReason: 'conflict',
    receiptReason: 'mapping-repair-required',
    arrange: () => {
      const state = harness({ ok: true, context: UNJOINED_CONTEXT })
      state.github.inProject = false
      state.github.beforeDispatch = () => {
        if (state.github.calls.at(-1) === 'dispatch:add') state.github.issueState = 'closed'
      }
      return { state, intent: unjoinedMoveIntent() }
    },
    assertEvidence: (state, record) => {
      expect(record.terminalEvidence).toMatchObject({
        kind: 'conflict',
        reason: 'mapping-repair-required',
        confirmedObservation: {
          stageKind: 'project-item-add',
          workItemId: WORK_ITEM_ID,
          facts: {
            issue: { state: 'closed' },
            membership: { state: 'present', item: { id: ITEM_ID } },
          },
        },
      })
      expect(state.recoveryTable.size).toBe(0)
      expect(state.scans).toEqual([PROJECT_ID])
      const overlays = state.operations.project(
        PROJECT_ID,
        UNJOINED_CONTEXT.confirmedBoard,
        AVAILABLE,
        ALLOWED,
      ).mutationOverlays
      expect(overlays).toMatchObject([{
        state: 'conflict',
        intentId: INTENT_ID,
        type: 'move-work-item',
        reason: 'mapping-repair-required',
      }])
      expect(overlays[0]).not.toHaveProperty('workItem')
    },
  },
  {
    name: 'a successful Status set followed by an externally closed Issue',
    stage: 'project-item-status-set',
    dispatchCall: 'dispatch',
    inspectionCall: 'inspect',
    resultReason: 'conflict',
    receiptReason: 'stale-remote',
    arrange: () => {
      const state = harness()
      state.github.beforeDispatch = () => {
        if (state.github.calls.at(-1) === 'dispatch') state.github.issueState = 'closed'
      }
      return { state, intent: moveIntent() }
    },
    assertEvidence: (state, record) => {
      const remoteFingerprint = targetedBoardRemoteFingerprint(snapshot(
        CONFIGURATION.statusOptionNodeIds.inProgress,
        'closed',
      ))
      expect(record.terminalEvidence).toMatchObject({
        kind: 'conflict',
        reason: 'stale-remote',
        confirmedObservation: {
          stageKind: 'project-item-status-set',
          remoteFingerprint,
          facts: {
            issue: { state: 'closed' },
            membership: { item: { statusOptionId: CONFIGURATION.statusOptionNodeIds.inProgress } },
          },
        },
      })
      expect(requiredRecovery(state)).toMatchObject({
        confirmed: {
          sourceIntentId: INTENT_ID,
          observation: { stageKind: 'project-item-status-set', remoteFingerprint },
        },
        latestNonTerminalStatus: 'in-progress',
      })
      expect(state.scans).toEqual([PROJECT_ID])
      expect(state.operations.project(
        PROJECT_ID,
        CONTEXT.confirmedBoard,
        AVAILABLE,
        ALLOWED,
      ).mutationOverlays).toMatchObject([{
        state: 'conflict',
        intentId: INTENT_ID,
        type: 'move-work-item',
        reason: 'stale-remote',
        workItem: {
          id: WORK_ITEM_ID,
          issueState: 'closed',
          status: 'in-progress',
          latestNonTerminalStatus: 'in-progress',
          remoteFingerprint,
        },
      }])
    },
  },
  {
    name: 'a successful position set followed by predecessor Status drift',
    stage: 'project-item-position-set',
    dispatchCall: 'dispatch:position',
    inspectionCall: 'inspect:position',
    resultReason: 'conflict',
    receiptReason: 'stale-remote',
    arrange: () => {
      const state = harness({ ok: true, context: POSITION_CONTEXT })
      state.github.positionScenario = true
      state.github.beforeDispatch = () => {
        if (state.github.calls.at(-1) === 'dispatch:position') {
          state.github.anchorStatusOptionId = CONFIGURATION.statusOptionNodeIds.backlog
        }
      }
      return { state, intent: positionMoveIntent() }
    },
    assertEvidence: (state, record) => {
      const remoteFingerprint = targetedBoardRemoteFingerprint(positionTargetSnapshot(
        CONFIGURATION.statusOptionNodeIds.inProgress,
        true,
      ))
      expect(record.terminalEvidence).toMatchObject({
        kind: 'conflict',
        reason: 'stale-remote',
        confirmedObservation: {
          stageKind: 'project-item-position-set',
          facts: {
            membership: {
              item: {
                statusOptionId: CONFIGURATION.statusOptionNodeIds.inProgress,
                previousItemId: ANCHOR_ITEM_ID,
              },
            },
            after: { item: { statusOptionId: CONFIGURATION.statusOptionNodeIds.backlog } },
          },
        },
      })
      expect(requiredRecovery(state)).toMatchObject({
        confirmed: {
          sourceIntentId: INTENT_ID,
          observation: { stageKind: 'project-item-position-set' },
        },
        latestNonTerminalStatus: 'in-progress',
      })
      expect(state.scans).toEqual([PROJECT_ID])
      expect(state.operations.project(
        PROJECT_ID,
        POSITION_CONTEXT.confirmedBoard,
        AVAILABLE,
        ALLOWED,
      ).mutationOverlays).toMatchObject([{
        state: 'conflict',
        intentId: INTENT_ID,
        type: 'move-work-item',
        reason: 'stale-remote',
        workItem: {
          id: WORK_ITEM_ID,
          issueState: 'open',
          status: 'in-progress',
          latestNonTerminalStatus: 'in-progress',
          remoteFingerprint,
        },
      }])
    },
  },
]

interface PostAdmissionStageSetup {
  readonly state: Harness
  readonly intent: CreateWorkItemIntent | MoveWorkItemIntent
  readonly stageKind: SakiWorkItemMutationStageKind
  readonly dispatchCall: string
}

interface PostAdmissionExercise {
  readonly state: Harness
  readonly result: WorkItemSubmitResult
  readonly admissionObserved: boolean
  readonly dispatchCall: string
}

interface PostAdmissionRecheckScenario {
  readonly name: string
  readonly expectedResultReason: 'canceled' | 'conflict'
  readonly expectedReceiptReason: 'authority-revoked' | 'expected-revision' | 'mapping-repair-required'
  readonly exercise: () => Promise<PostAdmissionExercise>
}

async function exercisePostAdmissionChange(
  setup: PostAdmissionStageSetup,
  change: () => void,
): Promise<PostAdmissionExercise> {
  let admissionObserved = false
  setup.state.intentTable.afterUpdate = (record) => {
    const stage = record.stages[record.observedPrefix.length]
    if (record.phase !== 'running' || stage?.kind !== setup.stageKind || !stage.effectPossible) return
    admissionObserved = true
    setup.state.intentTable.afterUpdate = undefined
    change()
  }
  const result = await setup.state.operations.submit(
    setup.intent,
    ACTOR,
    new AbortController().signal,
  )
  return {
    state: setup.state,
    result,
    admissionObserved,
    dispatchCall: setup.dispatchCall,
  }
}

const postAdmissionStageSetups: readonly {
  readonly name: string
  readonly create: () => PostAdmissionStageSetup
}[] = [
  {
    name: 'Issue creation authority revocation',
    create: () => ({
      state: harness(),
      intent: createIntent(),
      stageKind: 'issue-create',
      dispatchCall: 'dispatch:create',
    }),
  },
  {
    name: 'Project membership authority revocation',
    create: () => {
      const state = harness({ ok: true, context: UNJOINED_CONTEXT })
      state.github.inProject = false
      return {
        state,
        intent: unjoinedMoveIntent(),
        stageKind: 'project-item-add',
        dispatchCall: 'dispatch:add',
      }
    },
  },
  {
    name: 'Status authority revocation',
    create: () => ({
      state: harness(),
      intent: moveIntent(),
      stageKind: 'project-item-status-set',
      dispatchCall: 'dispatch',
    }),
  },
  {
    name: 'position authority revocation',
    create: () => {
      const state = harness({ ok: true, context: POSITION_CONTEXT })
      state.github.positionScenario = true
      return {
        state,
        intent: positionMoveIntent(),
        stageKind: 'project-item-position-set',
        dispatchCall: 'dispatch:position',
      }
    },
  },
  {
    name: 'terminal Issue-state authority revocation',
    create: () => ({
      state: harness(),
      intent: terminalMoveIntent(),
      stageKind: 'issue-state-set',
      dispatchCall: 'dispatch:issue-state',
    }),
  },
]

const postAdmissionAuthorityScenarios: readonly PostAdmissionRecheckScenario[] =
  postAdmissionStageSetups.map(stage => ({
    name: stage.name,
    expectedResultReason: 'canceled',
    expectedReceiptReason: 'authority-revoked',
    exercise: async () => {
      const setup = stage.create()
      return await exercisePostAdmissionChange(setup, () => { setup.state.authority.current = false })
    },
  }))

const postAdmissionTargetScenarios: readonly PostAdmissionRecheckScenario[] = [
  {
    name: 'Issue creation mapping revision drift',
    expectedResultReason: 'conflict',
    expectedReceiptReason: 'expected-revision',
    exercise: async () => {
      const context = mutableMutationContext(CONTEXT)
      const state = harness({ ok: true, context: CONTEXT }, true, { mutationContext: context.resolve })
      return await exercisePostAdmissionChange({
        state,
        intent: createIntent(),
        stageKind: 'issue-create',
        dispatchCall: 'dispatch:create',
      }, () => {
        context.replace({
          ...CONTEXT,
          mappingRevision: CONTEXT.mappingRevision + 1,
          confirmedBoard: {
            ...CONTEXT.confirmedBoard,
            configurationRevision: CONTEXT.confirmedBoard.configurationRevision + 1,
          },
        })
      })
    },
  },
  {
    name: 'Project membership replacement',
    expectedResultReason: 'conflict',
    expectedReceiptReason: 'mapping-repair-required',
    exercise: async () => {
      const context = mutableMutationContext(UNJOINED_CONTEXT)
      const state = harness(
        { ok: true, context: UNJOINED_CONTEXT },
        true,
        { mutationContext: context.resolve },
      )
      state.github.inProject = false
      return await exercisePostAdmissionChange({
        state,
        intent: unjoinedMoveIntent(),
        stageKind: 'project-item-add',
        dispatchCall: 'dispatch:add',
      }, () => {
        const item = UNJOINED_CONTEXT.confirmedBoard.items[0]!
        context.replace({
          ...UNJOINED_CONTEXT,
          confirmedBoard: {
            ...UNJOINED_CONTEXT.confirmedBoard,
            items: [{
              ...item,
              notInProject: false,
              source: {
                ...item.source,
                projectItemId: ITEM_ID,
                apiOrder: 0,
              },
            }],
          },
        })
      })
    },
  },
  {
    name: 'Status option mapping drift',
    expectedResultReason: 'conflict',
    expectedReceiptReason: 'mapping-repair-required',
    exercise: async () => {
      const context = mutableMutationContext(CONTEXT)
      const state = harness({ ok: true, context: CONTEXT }, true, { mutationContext: context.resolve })
      return await exercisePostAdmissionChange({
        state,
        intent: moveIntent(),
        stageKind: 'project-item-status-set',
        dispatchCall: 'dispatch',
      }, () => {
        context.replace({
          ...CONTEXT,
          mappingRevision: CONTEXT.mappingRevision + 1,
          configuration: githubSynchronizationConfigurationSchema.parse({
            ...CONFIGURATION,
            statusOptionNodeIds: {
              ...CONFIGURATION.statusOptionNodeIds,
              inProgress: 'O_in_progress_rebound',
            },
          }),
          confirmedBoard: {
            ...CONTEXT.confirmedBoard,
            configurationRevision: CONTEXT.confirmedBoard.configurationRevision + 1,
          },
        })
      })
    },
  },
  {
    name: 'position predecessor drift',
    expectedResultReason: 'conflict',
    expectedReceiptReason: 'mapping-repair-required',
    exercise: async () => {
      const context = mutableMutationContext(POSITION_CONTEXT)
      const state = harness(
        { ok: true, context: POSITION_CONTEXT },
        true,
        { mutationContext: context.resolve },
      )
      state.github.positionScenario = true
      return await exercisePostAdmissionChange({
        state,
        intent: positionMoveIntent(),
        stageKind: 'project-item-position-set',
        dispatchCall: 'dispatch:position',
      }, () => {
        if (ANCHOR_POSITION_SNAPSHOT.membership.state !== 'present') {
          throw new Error('position predecessor fixture lacks membership')
        }
        const changedAnchorFingerprint = targetedBoardRemoteFingerprint({
          ...ANCHOR_POSITION_SNAPSHOT,
          membership: {
            state: 'present',
            item: { ...ANCHOR_POSITION_SNAPSHOT.membership.item, apiOrder: 2 },
          },
        })
        context.replace({
          ...POSITION_CONTEXT,
          confirmedBoard: {
            ...POSITION_CONTEXT.confirmedBoard,
            items: POSITION_CONTEXT.confirmedBoard.items.map(item => item.id === ANCHOR_WORK_ITEM_ID
              ? {
                ...item,
                order: 2,
                source: { ...item.source, apiOrder: 2 },
                remoteFingerprint: changedAnchorFingerprint,
              }
              : item),
          },
        })
      })
    },
  },
  {
    name: 'terminal Issue-state Project binding drift',
    expectedResultReason: 'conflict',
    expectedReceiptReason: 'mapping-repair-required',
    exercise: async () => {
      const context = mutableMutationContext(CONTEXT)
      const state = harness({ ok: true, context: CONTEXT }, true, { mutationContext: context.resolve })
      return await exercisePostAdmissionChange({
        state,
        intent: terminalMoveIntent(),
        stageKind: 'issue-state-set',
        dispatchCall: 'dispatch:issue-state',
      }, () => {
        const projectId = githubProjectId('P_project_rebound')
        context.replace({
          ...CONTEXT,
          mappingRevision: CONTEXT.mappingRevision + 1,
          configuration: githubSynchronizationConfigurationSchema.parse({
            ...CONFIGURATION,
            projectNodeId: projectId,
          }),
          confirmedBoard: {
            ...CONTEXT.confirmedBoard,
            configurationRevision: CONTEXT.confirmedBoard.configurationRevision + 1,
            project: { ...CONTEXT.confirmedBoard.project, id: projectId },
          },
        })
      })
    },
  },
]

const postAdmissionRecheckScenarios: readonly PostAdmissionRecheckScenario[] = [
  ...postAdmissionAuthorityScenarios,
  ...postAdmissionTargetScenarios,
]

interface PreparedPhaseAlignmentScenario {
  readonly name: string
  readonly context: GitHubWorkItemMutationContextResult
  readonly intent: () => CreateWorkItemIntent | MoveWorkItemIntent
  readonly expectedWorkItemId: typeof WORK_ITEM_ID | undefined
  readonly expectedOverlay: SakiBoardMutationOverlayProjection
}

const preparedPhaseAlignmentScenarios: readonly PreparedPhaseAlignmentScenario[] = [
  {
    name: 'Create Intent',
    context: { ok: true, context: CONTEXT },
    intent: createIntent,
    expectedWorkItemId: undefined,
    expectedOverlay: {
      state: 'optimistic',
      intentId: INTENT_ID,
      type: 'create-work-item',
      title: createIntent().title,
      targetStatus: 'inbox',
    },
  },
  {
    name: 'positioned Move Intent',
    context: { ok: true, context: POSITION_CONTEXT },
    intent: positionMoveIntent,
    expectedWorkItemId: WORK_ITEM_ID,
    expectedOverlay: {
      state: 'optimistic',
      intentId: INTENT_ID,
      type: 'move-work-item',
      workItemId: WORK_ITEM_ID,
      targetStatus: 'in-progress',
      position: {
        afterWorkItemId: ANCHOR_WORK_ITEM_ID,
        expectedAfterRemoteFingerprint: ANCHOR_REMOTE_FINGERPRINT,
      },
    },
  },
]

function targetedJoinedFingerprint(
  statusOptionId: GitHubProjectOptionId,
  issueState: 'open' | 'closed',
  archived = false,
) {
  const current = snapshot(statusOptionId, issueState)
  if (current.membership.state !== 'present') throw new Error('joined fingerprint fixture lacks membership')
  return targetedBoardRemoteFingerprint({
    ...current,
    membership: {
      state: 'present',
      item: { ...current.membership.item, archived },
    },
  })
}

function contextWithItem(
  transform: (
    item: GitHubWorkItemMutationContext['confirmedBoard']['items'][number],
  ) => GitHubWorkItemMutationContext['confirmedBoard']['items'][number],
): GitHubWorkItemMutationContext {
  const item = CONTEXT.confirmedBoard.items[0]
  if (item === undefined) throw new Error('mutation context fixture lacks a Work Item')
  return {
    ...CONTEXT,
    confirmedBoard: {
      ...CONTEXT.confirmedBoard,
      items: [transform(item)],
    },
  }
}

interface PreparationDenialExercise {
  readonly state: Harness
  readonly intent: CreateWorkItemIntent | MoveWorkItemIntent
}

interface PreparationDenialScenario {
  readonly name: string
  readonly expectedReason: 'denied' | 'unavailable'
  readonly arrange: () => Promise<PreparationDenialExercise>
}

const preparationDenialScenarios: readonly PreparationDenialScenario[] = [
  {
    name: 'Create permission is absent while Move remains allowed',
    expectedReason: 'denied',
    arrange: async () => ({
      state: harness({ ok: true, context: CONTEXT }, true, {
        authorityCurrent: action => action !== 'work-item:create',
      }),
      intent: createIntent(),
    }),
  },
  {
    name: 'Move permission is absent while Create remains allowed',
    expectedReason: 'denied',
    arrange: async () => ({
      state: harness({ ok: true, context: CONTEXT }, true, {
        authorityCurrent: action => action !== 'work-item:move',
      }),
      intent: moveIntent(),
    }),
  },
  {
    name: 'Create mapping requires revalidation',
    expectedReason: 'unavailable',
    arrange: async () => ({
      state: harness({
        ok: false,
        reason: 'unavailable',
        reasons: ['mapping-revalidation-required'],
      }),
      intent: createIntent(),
    }),
  },
  {
    name: 'Move project context is missing',
    expectedReason: 'unavailable',
    arrange: async () => ({
      state: harness({ ok: false, reason: 'not-found' }),
      intent: moveIntent(),
    }),
  },
  {
    name: 'Create project was removed before preparation',
    expectedReason: 'unavailable',
    arrange: async () => ({
      state: harness({ ok: true, context: CONTEXT }, true, { projectIds: [] }),
      intent: createIntent(),
    }),
  },
  {
    name: 'Move Work Item is absent from the confirmed Board',
    expectedReason: 'unavailable',
    arrange: async () => ({
      state: harness({
        ok: true,
        context: {
          ...CONTEXT,
          confirmedBoard: { ...CONTEXT.confirmedBoard, items: [] },
        },
      }),
      intent: moveIntent(),
    }),
  },
  {
    name: 'Move Work Item is archived',
    expectedReason: 'unavailable',
    arrange: async () => ({
      state: harness({
        ok: true,
        context: contextWithItem(item => ({
          ...item,
          status: 'canceled',
          archived: true,
          remoteFingerprint: targetedJoinedFingerprint(
            CONFIGURATION.statusOptionNodeIds.ready,
            'open',
            true,
          ),
        })),
      }),
      intent: moveIntent(),
    }),
  },
  {
    name: 'unjoined Issue is already represented by Inbox',
    expectedReason: 'unavailable',
    arrange: async () => ({
      state: harness({ ok: true, context: UNJOINED_CONTEXT }),
      intent: { ...unjoinedMoveIntent(), targetStatus: 'inbox' },
    }),
  },
  {
    name: 'closed Issue has a non-terminal Board status',
    expectedReason: 'unavailable',
    arrange: async () => {
      const remoteFingerprint = targetedJoinedFingerprint(
        CONFIGURATION.statusOptionNodeIds.ready,
        'closed',
      )
      return {
        state: harness({
          ok: true,
          context: contextWithItem(item => ({ ...item, issueState: 'closed', remoteFingerprint })),
        }),
        intent: { ...moveIntent(), expectedRemoteFingerprint: remoteFingerprint, targetStatus: 'backlog' },
      }
    },
  },
  {
    name: 'terminal Work Item is reopened to a status other than its retained restore status',
    expectedReason: 'unavailable',
    arrange: async () => {
      const remoteFingerprint = targetedJoinedFingerprint(
        CONFIGURATION.statusOptionNodeIds.done,
        'closed',
      )
      return {
        state: harness({
          ok: true,
          context: contextWithItem(item => ({
            ...item,
            issueState: 'closed',
            status: 'done',
            latestNonTerminalStatus: 'ready',
            remoteFingerprint,
          })),
        }),
        intent: { ...moveIntent(), expectedRemoteFingerprint: remoteFingerprint, targetStatus: 'backlog' },
      }
    },
  },
  {
    name: 'position predecessor fingerprint is stale',
    expectedReason: 'unavailable',
    arrange: async () => ({
      state: harness({ ok: true, context: POSITION_CONTEXT }),
      intent: {
        ...positionMoveIntent(),
        position: {
          afterWorkItemId: ANCHOR_WORK_ITEM_ID,
          expectedAfterRemoteFingerprint: TERMINAL_ANCHOR_REMOTE_FINGERPRINT,
        },
      },
    }),
  },
  {
    name: 'retained targeted recovery uses an option removed from the active mapping',
    expectedReason: 'unavailable',
    arrange: async () => {
      const seeded = harness()
      await seeded.operations.submit(moveIntent(), ACTOR, new AbortController().signal)
      const configuration = githubSynchronizationConfigurationSchema.parse({
        ...CONFIGURATION,
        statusOptionNodeIds: {
          ...CONFIGURATION.statusOptionNodeIds,
          inProgress: 'O_in_progress_rebound',
        },
      })
      const context = {
        ...CONTEXT,
        mappingRevision: CONTEXT.mappingRevision + 1,
        configuration,
        confirmedBoard: {
          ...CONTEXT.confirmedBoard,
          configurationRevision: CONTEXT.confirmedBoard.configurationRevision + 1,
        },
      }
      return {
        state: harness({ ok: true, context }, true, {
          intentTable: seeded.intentTable,
          recoveryTable: seeded.recoveryTable,
        }),
        intent: { ...moveIntent(), intentId: SECOND_INTENT_ID },
      }
    },
  },
]

const kvAcknowledgementLossScenarios: readonly {
  readonly name: string
  readonly arm: (table: MemoryTable<SakiControlIntentId, GitHubWorkItemIntentRecord>) => void
}[] = [
  {
    name: 'the initial Intent put',
    arm: (table) => {
      table.failNextPutAfterCommit = new Error('Intent put acknowledgement was lost')
    },
  },
  {
    name: 'a durable transition update',
    arm: (table) => {
      table.failNextUpdateAfterCommit = new Error('Intent update acknowledgement was lost')
    },
  },
]

const mappingRepairFailureScenarios: readonly {
  readonly name: string
  readonly failure: GitHubFailure
  readonly reason: string
}[] = [
  {
    name: 'a permission mismatch',
    failure: {
      code: 'permission-mismatch',
      permission: 'issues',
      required: 'write',
      observed: 'read',
    },
    reason: 'permission-mismatch:issues',
  },
  {
    name: 'a Status option mapping mismatch',
    failure: {
      code: 'mapping-mismatch',
      reason: 'required-options-missing',
      statusFieldId: CONFIGURATION.statusFieldNodeId,
      missingRequiredStatusOptionIds: [CONFIGURATION.statusOptionNodeIds.inProgress],
    },
    reason: 'mapping-mismatch:required-options-missing',
  },
  {
    name: 'an invalid external response',
    failure: {
      code: 'invalid-external-response',
      operation: 'project-item-status-set',
    },
    reason: 'invalid-external-response:project-item-status-set',
  },
  {
    name: 'a permanent provider rejection',
    failure: { code: 'permanent-rejection', status: 422 },
    reason: 'permanent-rejection:422',
  },
  {
    name: 'a permanent provider rejection without an HTTP status',
    failure: { code: 'permanent-rejection' },
    reason: 'permanent-rejection:unknown',
  },
]

describe('GitHub Work Item operations', () => {
  it.each(durableValidationRejections)(
    'rejects $name during durable Work Item validation',
    async ({ arrange, expected }) => {
      const { state, otherIntentIds = new Set<SakiControlIntentId>() } = await arrange()

      expect(() => state.operations.validateDurableState(otherIntentIds)).toThrow(expected)
    },
  )

  it.each(preparationDenialScenarios)(
    'rejects $name before any durable or provider-side mutation',
    async ({ arrange, expectedReason }) => {
      const { state, intent } = await arrange()
      const intentsBefore = structuredClone([...state.intentTable.entries()])
      const recoveriesBefore = structuredClone([...state.recoveryTable.entries()])
      const callsBefore = [...state.github.calls]
      const scansBefore = [...state.scans]
      const changesBefore = [...state.changes]

      const result = await state.operations.submit(
        intent,
        ACTOR,
        new AbortController().signal,
      )

      expect(result).toEqual({ ok: false, reason: expectedReason })
      expect([...state.intentTable.entries()]).toEqual(intentsBefore)
      expect([...state.recoveryTable.entries()]).toEqual(recoveriesBefore)
      expect(state.github.calls).toEqual(callsBefore)
      expect(state.scans).toEqual(scansBefore)
      expect(state.changes).toEqual(changesBefore)
    },
  )

  it.each(kvAcknowledgementLossScenarios)(
    'reads back $name after commit when its storage acknowledgement is lost',
    async ({ arm }) => {
      const state = harness()
      arm(state.intentTable)

      const result = await state.operations.submit(
        moveIntent(),
        ACTOR,
        new AbortController().signal,
      )

      expect(result).toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
      expect(requiredIntent(state)).toMatchObject({
        phase: 'succeeded',
        stages: [{ kind: 'project-item-status-set', state: 'confirmed', effectPossible: true }],
      })
      expect(requiredRecovery(state)).toMatchObject({
        confirmed: { sourceIntentId: INTENT_ID, observation: { workItemId: WORK_ITEM_ID } },
      })
      expect(state.github.calls).toEqual(['inspect', 'dispatch', 'inspect'])
      expect(() => state.operations.validateDurableState(new Set())).not.toThrow()

      expect(await state.operations.submit(
        moveIntent(),
        ACTOR,
        new AbortController().signal,
      )).toEqual(result)
      expect(state.github.calls).toEqual(['inspect', 'dispatch', 'inspect'])
    },
  )

  it('leaves no effect after a pre-commit Intent put failure and succeeds on exact retry', async () => {
    const state = harness()
    const intent = moveIntent()
    state.intentTable.failNextPut = new Error('Intent put failed before commit')
    const changesBefore = [...state.changes]

    await expect(state.operations.submit(
      intent,
      ACTOR,
      new AbortController().signal,
    )).rejects.toThrow('Intent put failed before commit')

    expect(state.intentTable.size).toBe(0)
    expect(state.recoveryTable.size).toBe(0)
    expect(state.github.calls).toEqual([])
    expect(state.changes).toEqual(changesBefore)
    expect(state.scans).toEqual([])

    const result = await state.operations.submit(intent, ACTOR, new AbortController().signal)

    expect(result).toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
    expect(requiredIntent(state)).toMatchObject({
      phase: 'succeeded',
      stages: [{ kind: 'project-item-status-set', state: 'confirmed', effectPossible: true }],
    })
    expect(requiredRecovery(state)).toMatchObject({
      confirmed: { sourceIntentId: INTENT_ID, observation: { workItemId: WORK_ITEM_ID } },
    })
    expect(state.github.calls).toEqual(['inspect', 'dispatch', 'inspect'])
    expect(state.github.calls.filter(call => call === 'dispatch')).toHaveLength(1)
    expect(state.scans).toEqual([PROJECT_ID])
    expect(() => state.operations.validateDurableState(new Set())).not.toThrow()
  })

  it('uses the terminal fingerprint to resolve equal-millisecond checkpoint scan coverage', async () => {
    const seeded = harness()
    const terminalResult = await seeded.operations.submit(
      moveIntent(),
      ACTOR,
      new AbortController().signal,
    )
    const record = requiredIntent(seeded)
    const recovery = requiredRecovery(seeded)
    if (record.terminalEvidence?.kind !== 'succeeded') {
      throw new Error('terminal checkpoint fixture is missing')
    }
    const observation = recovery.confirmed.observation
    if (observation.stageKind !== 'project-item-status-set') {
      throw new Error('terminal checkpoint recovery has the wrong observation kind')
    }
    const item = CONTEXT.confirmedBoard.items[0]
    if (item === undefined) throw new Error('terminal checkpoint Board fixture is missing')
    expect(item.remoteFingerprint).not.toBe(observation.remoteFingerprint)
    const matchingContext: GitHubWorkItemMutationContext = {
      ...CONTEXT,
      checkpointObservedAt: record.terminalEvidence.confirmedAt,
      confirmedBoard: {
        ...CONTEXT.confirmedBoard,
        items: [{
          ...item,
          status: 'in-progress',
          latestNonTerminalStatus: 'in-progress',
          remoteFingerprint: observation.remoteFingerprint,
        }],
      },
    }
    const mismatchingContext: GitHubWorkItemMutationContext = {
      ...CONTEXT,
      checkpointObservedAt: record.terminalEvidence.confirmedAt,
    }

    const matching = harness({ ok: true, context: matchingContext }, false, {
      intentTable: seeded.intentTable,
      recoveryTable: seeded.recoveryTable,
    })
    expect(await matching.operations.submit(
      moveIntent(),
      ACTOR,
      new AbortController().signal,
    )).toEqual(terminalResult)
    expect(matching.scans).toEqual([])
    expect(matching.github.calls).toEqual([])

    const mismatching = harness({ ok: true, context: mismatchingContext }, false, {
      intentTable: seeded.intentTable,
      recoveryTable: seeded.recoveryTable,
    })
    expect(await mismatching.operations.submit(
      moveIntent(),
      ACTOR,
      new AbortController().signal,
    )).toEqual(terminalResult)
    expect(await mismatching.operations.submit(
      moveIntent(),
      ACTOR,
      new AbortController().signal,
    )).toEqual(terminalResult)
    expect(mismatching.scans).toEqual([PROJECT_ID])
    expect(mismatching.github.calls).toEqual([])
  })

  it.each(providerRecoveryScenarios)(
    'handles $name without dispatching after its terminal receipt',
    async ({ exercise, assertFirst, assertTerminal }) => {
      const result = await exercise()
      assertFirst(result.first)
      assertTerminal(result.terminal)
      const callsAtTerminal = [...result.state.github.calls]

      expect(await result.replay()).toEqual(result.terminal)
      expect(result.state.github.calls).toEqual(callsAtTerminal)
      expect(result.state.github.calls.filter(call => call === result.dispatchCall))
        .toHaveLength(result.expectedDispatchCount)
      if (result.expectedCreateInspectionHints !== undefined) {
        expect(result.state.github.createInspectionHints).toEqual(result.expectedCreateInspectionHints)
      }
    },
  )

  it.each(dispatchContradictionScenarios)(
    'does not retry $name after targeted inspection proves a contradiction',
    async ({
      arrange,
      stage,
      dispatchCall,
      inspectionCall,
      resultReason,
      receiptReason,
      assertEvidence,
    }) => {
      const { state, intent } = arrange()
      const result = await state.operations.submit(intent, ACTOR, new AbortController().signal)
      const record = requiredIntent(state)

      expect(result).toMatchObject({
        ok: false,
        reason: resultReason,
        receipt: {
          state: resultReason,
          reason: receiptReason,
          ...(resultReason === 'reconciliation-required' ? { stage } : {}),
        },
      })
      expect(record).toMatchObject({
        phase: resultReason,
        terminalEvidence: { kind: resultReason, reason: receiptReason },
      })
      expect(record.stages.find(candidate => candidate.kind === stage)).toMatchObject({
        state: 'dispatching',
        effectPossible: true,
      })
      const dispatchIndex = state.github.calls.lastIndexOf(dispatchCall)
      expect(dispatchIndex).toBeGreaterThanOrEqual(0)
      expect(state.github.calls.slice(dispatchIndex + 1)).toContain(inspectionCall)
      expect(state.github.calls.filter(call => call === dispatchCall)).toHaveLength(1)
      expect(() => state.operations.validateDurableState(new Set())).not.toThrow()
      assertEvidence(state, record)
      const callsAtTerminal = [...state.github.calls]

      expect(await state.operations.submit(intent, ACTOR, new AbortController().signal)).toEqual(result)
      expect(state.github.calls).toEqual(callsAtTerminal)
    },
  )

  it.each(postAdmissionRecheckScenarios)(
    'blocks $name after durable admission and before provider dispatch',
    async ({ exercise, expectedResultReason, expectedReceiptReason }) => {
      const result = await exercise()

      expect(result.admissionObserved).toBe(true)
      expect(result.result).toMatchObject({
        ok: false,
        reason: expectedResultReason,
        receipt: {
          state: expectedResultReason,
          reason: expectedReceiptReason,
        },
      })
      expect(result.state.github.calls).not.toContain(result.dispatchCall)
      expect(() => result.state.operations.validateDurableState(new Set())).not.toThrow()
    },
  )

  it.each(preparedPhaseAlignmentScenarios)(
    'aligns a prepared $name receipt, optimistic overlay, and effect-free durable state',
    async ({ context, intent: makeIntent, expectedWorkItemId, expectedOverlay }) => {
      const state = harness(context, false)
      const intent = makeIntent()
      const result = await state.operations.submit(intent, ACTOR, new AbortController().signal)
      const record = requiredIntent(state)

      expect(result).toEqual({
        ok: false,
        reason: 'unavailable',
        receipt: {
          id: record.receiptId,
          intentId: intent.intentId,
          type: intent.type,
          projectId: intent.projectId,
          state: 'prepared',
          ...(expectedWorkItemId === undefined ? {} : { workItemId: expectedWorkItemId }),
        },
      })
      expect(record).toMatchObject({
        phase: 'prepared',
        observedPrefix: [],
      })
      expect(record.stages.every(stage => stage.state === 'prepared' && !stage.effectPossible)).toBe(true)
      expect(state.recoveryTable.size).toBe(0)
      expect(state.operations.project(
        intent.projectId,
        context.ok ? context.context.confirmedBoard : undefined,
        AVAILABLE,
        ALLOWED,
      ).mutationOverlays).toEqual([expectedOverlay])
      expect(() => state.operations.validateDurableState(new Set())).not.toThrow()
    },
  )

  it('aligns a running receipt and optimistic overlay after process loss at durable dispatch admission', async () => {
    const state = harness()
    state.github.beforeDispatch = () => {
      throw new SimulatedProcessCrash('process stopped after durable Status dispatch admission')
    }

    await expect(state.operations.submit(
      moveIntent(),
      ACTOR,
      new AbortController().signal,
    )).rejects.toThrow(SimulatedProcessCrash)
    state.github.beforeDispatch = undefined
    expect(state.github.calls).toEqual(['inspect', 'dispatch'])
    const persisted = requiredIntent(state)
    const recovery = requiredRecovery(state)
    expect(persisted).toMatchObject({
      phase: 'running',
      stages: [{ kind: 'project-item-status-set', state: 'dispatching', effectPossible: true }],
    })
    expect(recovery).toMatchObject({
      confirmed: { sourceIntentId: INTENT_ID, observation: { workItemId: WORK_ITEM_ID } },
    })

    const restarted = harness({ ok: true, context: CONTEXT }, false, {
      intentTable: state.intentTable,
      recoveryTable: state.recoveryTable,
      github: state.github,
    })
    await restarted.operations.initializeValidated(restarted.operations.validateDurableState(new Set()))
    const result = await restarted.operations.submit(
      moveIntent(),
      ACTOR,
      new AbortController().signal,
    )

    expect(result).toEqual({
      ok: false,
      reason: 'unavailable',
      receipt: {
        id: persisted.receiptId,
        intentId: INTENT_ID,
        type: 'move-work-item',
        projectId: PROJECT_ID,
        state: 'running',
        workItemId: WORK_ITEM_ID,
      },
    })
    expect(requiredIntent(restarted)).toEqual(persisted)
    expect(requiredRecovery(restarted)).toEqual(recovery)
    expect(restarted.operations.project(
      PROJECT_ID,
      CONTEXT.confirmedBoard,
      AVAILABLE,
      ALLOWED,
    ).mutationOverlays).toEqual([{
      state: 'optimistic',
      intentId: INTENT_ID,
      type: 'move-work-item',
      workItemId: WORK_ITEM_ID,
      targetStatus: 'in-progress',
    }])
  })

  it('persists one high-entropy create marker and replays it before Issue dispatch is available', async () => {
    const state = harness({ ok: true, context: CONTEXT }, false)

    const first = await state.operations.submit(createIntent(), ACTOR, new AbortController().signal)

    expect(first).toMatchObject({ ok: false, reason: 'unavailable', receipt: { state: 'prepared' } })
    const retained = state.intentTable.get(INTENT_ID)
    expect(retained).toMatchObject({
      phase: 'prepared',
      target: { kind: 'create-work-item', desiredStatusOptionId: CONFIGURATION.statusOptionNodeIds.inbox },
      stages: [
        { kind: 'issue-create', state: 'prepared', effectPossible: false },
        { kind: 'project-item-add', state: 'prepared', effectPossible: false },
        { kind: 'project-item-status-set', state: 'prepared', effectPossible: false },
      ],
    })
    expect(retained?.target.kind === 'create-work-item' ? retained.target.markerId : undefined)
      .toMatch(/^work-item-marker-[0-9a-f]{64}$/u)
    if (retained?.target.kind !== 'create-work-item') throw new Error('create target is missing')
    expect(retained.stages[0]?.resolvedTarget).toMatchObject({
      bodyDigest: canonicalDigest('saki/work-item-issue-body/v1', {
        body: renderGitHubWorkItemIssueBody({
          intendedOutcome: createIntent().intendedOutcome,
          acceptanceCriteria: createIntent().acceptanceCriteria,
          markerId: retained.target.markerId,
        }),
      }),
    })
    expect(retained?.stages[1]?.resolvedTarget).toBeUndefined()
    expect(retained?.stages[2]?.resolvedTarget).toBeUndefined()

    expect(await state.operations.submit(createIntent(), ACTOR, new AbortController().signal)).toEqual(first)
    expect(state.intentTable.get(INTENT_ID)).toEqual(retained)
    expect(await state.operations.submit(
      { ...createIntent(), title: 'Changed immutable title' },
      ACTOR,
      new AbortController().signal,
    )).toEqual({ ok: false, reason: 'conflict' })
  })

  it('creates one marked Issue, joins it to the Project, and confirms Inbox as one durable saga', async () => {
    const state = harness()
    const createdWorkItemId = boardWorkItemId(CONFIGURATION.repositoryNodeId, CREATED_ISSUE_ID)
    state.github.beforeDispatch = () => {
      if (state.github.calls.at(-1) !== 'dispatch:create') return
      expect(state.intentTable.get(INTENT_ID)).toMatchObject({
        phase: 'running',
        stages: [
          { kind: 'issue-create', state: 'dispatching', effectPossible: true },
          { kind: 'project-item-add', state: 'prepared', effectPossible: false },
          { kind: 'project-item-status-set', state: 'prepared', effectPossible: false },
        ],
      })
    }

    const result = await state.operations.submit(
      createIntent(),
      ACTOR,
      new AbortController().signal,
    )

    expect(result).toMatchObject({
      ok: true,
      receipt: {
        state: 'succeeded',
        type: 'create-work-item',
        workItemId: createdWorkItemId,
        issueNumber: 28,
        url: 'https://github.com/example/repo/issues/28',
      },
    })
    expect(state.github.calls).toEqual([
      'inspect:create',
      'dispatch:create',
      'inspect:create',
      'inspect:add',
      'dispatch:add',
      'inspect:add',
      'inspect',
      'dispatch',
      'inspect',
    ])
    expect(state.github.createInspectionHints).toEqual([
      undefined,
      { issueId: CREATED_ISSUE_ID, issueNumber: 28 },
    ])
    expect(state.intentTable.get(INTENT_ID)).toMatchObject({
      phase: 'succeeded',
      stages: [
        { kind: 'issue-create', state: 'confirmed', effectPossible: true },
        { kind: 'project-item-add', state: 'confirmed', effectPossible: true },
        { kind: 'project-item-status-set', state: 'confirmed', effectPossible: true },
      ],
      observedPrefix: [
        { stageKind: 'issue-create', issue: { id: CREATED_ISSUE_ID, number: 28 } },
        { stageKind: 'project-item-add', workItemId: createdWorkItemId },
        {
          stageKind: 'project-item-status-set',
          facts: { membership: { item: { statusOptionId: CONFIGURATION.statusOptionNodeIds.inbox } } },
        },
      ],
    })
    const recovery = state.recoveryTable.get(githubWorkItemRecoveryId(PROJECT_ID, createdWorkItemId))
    expect(recovery).toMatchObject({
      workItemId: createdWorkItemId,
      latestNonTerminalStatus: 'inbox',
    })
    const record = requiredIntent(state)
    if (record.terminalEvidence?.kind !== 'succeeded' || recovery === undefined) {
      throw new Error('created Work Item terminal projection fixture is missing')
    }
    const recoveryObservation = recovery.confirmed.observation
    if (recoveryObservation.stageKind !== 'project-item-status-set') {
      throw new Error('created Work Item recovery fixture has the wrong observation kind')
    }
    const overlays = state.operations.project(
      PROJECT_ID,
      CONTEXT.confirmedBoard,
      AVAILABLE,
      ALLOWED,
    ).mutationOverlays
    expect(overlays).toMatchObject([{
      state: 'targeted-confirmed',
      intentId: INTENT_ID,
      type: 'create-work-item',
      confirmedAt: record.terminalEvidence.confirmedAt,
      workItem: {
        id: createdWorkItemId,
        status: 'inbox',
        latestNonTerminalStatus: 'inbox',
        remoteFingerprint: recoveryObservation.remoteFingerprint,
      },
    }])
  })

  it('recovers a created Issue after a lost acknowledgement without dispatching create twice', async () => {
    const state = harness()
    state.github.createDispatchMode = 'mutate-then-fail'

    const first = await state.operations.submit(
      createIntent(),
      ACTOR,
      new AbortController().signal,
    )
    const callsAfterFirst = [...state.github.calls]
    const replay = await state.operations.submit(
      createIntent(),
      ACTOR,
      new AbortController().signal,
    )

    expect(first).toMatchObject({ ok: true, receipt: { state: 'succeeded', issueNumber: 28 } })
    expect(callsAfterFirst.filter(call => call === 'dispatch:create')).toHaveLength(1)
    expect(callsAfterFirst).toEqual([
      'inspect:create',
      'dispatch:create',
      'inspect:create',
      'inspect:add',
      'dispatch:add',
      'inspect:add',
      'inspect',
      'dispatch',
      'inspect',
    ])
    expect(replay).toEqual(first)
    expect(state.github.calls).toEqual(callsAfterFirst)
  })

  it('finds a marked Issue after process loss without persisting or replaying its acknowledgement', async () => {
    const state = harness()
    state.github.createDispatchMode = 'effect-then-process-crash'

    await expect(state.operations.submit(
      createIntent(),
      ACTOR,
      new AbortController().signal,
    )).rejects.toThrow(SimulatedProcessCrash)
    expect(state.intentTable.get(INTENT_ID)).toMatchObject({
      phase: 'running',
      stages: [
        { kind: 'issue-create', state: 'dispatching', effectPossible: true },
        { kind: 'project-item-add', state: 'prepared', effectPossible: false },
        { kind: 'project-item-status-set', state: 'prepared', effectPossible: false },
      ],
      observedPrefix: [],
    })
    expect(state.github.calls.filter(call => call === 'dispatch:create')).toHaveLength(1)

    const restarted = harness({ ok: true, context: CONTEXT }, false, {
      intentTable: state.intentTable,
      recoveryTable: state.recoveryTable,
      github: state.github,
    })
    await restarted.operations.initializeValidated(restarted.operations.validateDurableState(new Set()))
    restarted.operations.attach(state.github)
    await restarted.operations.dispose()

    expect(restarted.intentTable.get(INTENT_ID)).toMatchObject({ phase: 'succeeded' })
    expect(state.github.calls.filter(call => call === 'dispatch:create')).toHaveLength(1)
    expect(state.github.createInspectionHints).toEqual([undefined, undefined])
  })

  it.each(createEffectPossibleMarkerOutcomes)(
    'classifies $name after Create became effect-possible',
    async ({ outcome, reason }) => {
      const state = harness()
      const intent = createIntent()
      state.github.beforeDispatch = () => {
        if (state.github.calls.at(-1) === 'dispatch:create') {
          state.github.createInspectionOutcomeOverride = outcome
        }
      }

      const result = await state.operations.submit(intent, ACTOR, new AbortController().signal)
      const record = requiredIntent(state)

      expect(result).toMatchObject({
        ok: false,
        reason: 'reconciliation-required',
        receipt: {
          state: 'reconciliation-required',
          stage: 'issue-create',
          reason,
        },
      })
      expect(state.github.calls).toEqual(['inspect:create', 'dispatch:create', 'inspect:create'])
      expect(state.github.createInspectionHints).toEqual([
        undefined,
        { issueId: CREATED_ISSUE_ID, issueNumber: 28 },
      ])
      expect(record).toMatchObject({
        phase: 'reconciliation-required',
        terminalEvidence: {
          kind: 'reconciliation-required',
          reason,
          stageMutationId: githubWorkItemStageMutationId(INTENT_ID, 'issue-create'),
        },
      })
      expect(record.stages[0]).toMatchObject({
        kind: 'issue-create',
        state: 'dispatching',
        effectPossible: true,
      })
      expect(state.recoveryTable.size).toBe(0)
      expect(state.scans).toEqual([])
      expect(state.operations.project(
        PROJECT_ID,
        CONTEXT.confirmedBoard,
        AVAILABLE,
        ALLOWED,
      ).mutationOverlays).toEqual([{
        state: 'reconciliation-required',
        intentId: INTENT_ID,
        type: 'create-work-item',
        stage: 'issue-create',
        reason,
      }])
      expect(() => state.operations.validateDurableState(new Set())).not.toThrow()
      const callsAtTerminal = [...state.github.calls]

      expect(await state.operations.submit(intent, ACTOR, new AbortController().signal)).toEqual(result)
      expect(state.github.calls).toEqual(callsAtTerminal)
      expect(state.github.calls.filter(call => call === 'dispatch:create')).toHaveLength(1)
    },
  )

  it('keeps incomplete pre-effect marker evidence prepared and succeeds on replay after it clears', async () => {
    const state = harness()
    const intent = createIntent()
    state.github.createInspectionOutcomeOverride = {
      state: 'incomplete',
      reason: 'page-limit',
      observedMatchCount: 0,
      observedMatches: [],
    }

    const first = await state.operations.submit(intent, ACTOR, new AbortController().signal)
    const prepared = requiredIntent(state)

    expect(first).toMatchObject({
      ok: false,
      reason: 'unavailable',
      receipt: { state: 'prepared', type: 'create-work-item' },
    })
    expect(state.github.calls).toEqual(['inspect:create'])
    expect(state.github.calls).not.toContain('dispatch:create')
    expect(prepared).toMatchObject({
      phase: 'prepared',
      observedPrefix: [],
    })
    expect(prepared.stages[0]).toMatchObject({
      kind: 'issue-create',
      state: 'prepared',
      effectPossible: false,
    })
    expect(state.recoveryTable.size).toBe(0)
    expect(state.operations.project(
      PROJECT_ID,
      CONTEXT.confirmedBoard,
      AVAILABLE,
      ALLOWED,
    ).mutationOverlays).toEqual([{
      state: 'optimistic',
      intentId: INTENT_ID,
      type: 'create-work-item',
      title: intent.title,
      targetStatus: 'inbox',
    }])
    expect(() => state.operations.validateDurableState(new Set())).not.toThrow()

    state.github.createInspectionOutcomeOverride = undefined
    const terminal = await state.operations.submit(intent, ACTOR, new AbortController().signal)
    const record = requiredIntent(state)
    const createdWorkItemId = boardWorkItemId(CONFIGURATION.repositoryNodeId, CREATED_ISSUE_ID)
    const recovery = state.recoveryTable.get(githubWorkItemRecoveryId(PROJECT_ID, createdWorkItemId))

    expect(terminal).toMatchObject({
      ok: true,
      receipt: {
        state: 'succeeded',
        type: 'create-work-item',
        workItemId: createdWorkItemId,
        issueNumber: 28,
      },
    })
    expect(record).toMatchObject({
      phase: 'succeeded',
      stages: [
        { kind: 'issue-create', state: 'confirmed', effectPossible: true },
        { kind: 'project-item-add', state: 'confirmed', effectPossible: true },
        { kind: 'project-item-status-set', state: 'confirmed', effectPossible: true },
      ],
      terminalEvidence: {
        kind: 'succeeded',
        confirmedObservation: { stageKind: 'project-item-status-set', workItemId: createdWorkItemId },
      },
    })
    expect(recovery).toMatchObject({
      workItemId: createdWorkItemId,
      latestNonTerminalStatus: 'inbox',
      confirmed: {
        sourceIntentId: INTENT_ID,
        observation: { stageKind: 'project-item-status-set', workItemId: createdWorkItemId },
      },
    })
    expect(state.scans).toEqual([PROJECT_ID])
    expect(state.operations.project(
      PROJECT_ID,
      CONTEXT.confirmedBoard,
      AVAILABLE,
      ALLOWED,
    ).mutationOverlays).toMatchObject([{
      state: 'targeted-confirmed',
      intentId: INTENT_ID,
      type: 'create-work-item',
      workItem: { id: createdWorkItemId, status: 'inbox', latestNonTerminalStatus: 'inbox' },
    }])
    expect(state.github.createInspectionHints).toEqual([
      undefined,
      undefined,
      { issueId: CREATED_ISSUE_ID, issueNumber: 28 },
    ])
    expect(state.github.calls.filter(call => call === 'dispatch:create')).toHaveLength(1)
    expect(() => state.operations.validateDurableState(new Set())).not.toThrow()
    const callsAtTerminal = [...state.github.calls]

    expect(await state.operations.submit(intent, ACTOR, new AbortController().signal)).toEqual(terminal)
    expect(state.github.calls).toEqual(callsAtTerminal)
  })

  it('never claims an existing marker before its own create effect became possible', async () => {
    const state = harness()
    state.github.issueCreated = true

    expect(await state.operations.submit(
      createIntent(),
      ACTOR,
      new AbortController().signal,
    )).toMatchObject({
      ok: false,
      reason: 'reconciliation-required',
      receipt: {
        state: 'reconciliation-required',
        stage: 'issue-create',
        reason: 'marker-ambiguous',
      },
    })
    expect(state.github.calls).toEqual(['inspect:create'])
    const record = requiredIntent(state)
    expect(record).toMatchObject({
      phase: 'reconciliation-required',
      terminalEvidence: {
        kind: 'reconciliation-required',
        reason: 'marker-ambiguous',
        stageMutationId: githubWorkItemStageMutationId(INTENT_ID, 'issue-create'),
      },
    })
    expect(record.stages[0]).toMatchObject({
      kind: 'issue-create',
      state: 'prepared',
      effectPossible: false,
    })
    expect(state.recoveryTable.size).toBe(0)
    expect(state.operations.project(
      PROJECT_ID,
      CONTEXT.confirmedBoard,
      AVAILABLE,
      ALLOWED,
    ).mutationOverlays).toEqual([{
      state: 'reconciliation-required',
      intentId: INTENT_ID,
      type: 'create-work-item',
      stage: 'issue-create',
      reason: 'marker-ambiguous',
    }])
  })

  it('keeps an uncertain Create recoverable until complete inspection proves the effect absent', async () => {
    const state = harness()
    const intent = createIntent()
    state.github.createDispatchMode = 'fail-before-effect'
    state.github.beforeDispatch = () => {
      if (state.github.calls.at(-1) === 'dispatch:create') state.github.inspectFailures = 2
    }

    const first = await state.operations.submit(intent, ACTOR, new AbortController().signal)

    expect(first).toMatchObject({
      ok: false,
      reason: 'unavailable',
      receipt: {
        state: 'partial-failure',
        stage: 'issue-create',
        recoveryAction: { kind: 'inspect-before-retry' },
      },
    })
    expect(requiredIntent(state).stages[0]).toMatchObject({
      kind: 'issue-create',
      state: 'failed',
      effectPossible: true,
    })
    expect(state.github.calls.filter(call => call === 'dispatch:create')).toHaveLength(1)
    state.github.beforeDispatch = undefined

    const unavailableReplay = await state.operations.submit(intent, ACTOR, new AbortController().signal)

    expect(unavailableReplay).toMatchObject({
      ok: false,
      reason: 'unavailable',
      receipt: {
        state: 'partial-failure',
        stage: 'issue-create',
        recoveryAction: { kind: 'inspect-before-retry' },
      },
    })
    expect(requiredIntent(state).stages[0]).toMatchObject({
      kind: 'issue-create',
      state: 'failed',
      effectPossible: true,
    })
    expect(state.github.calls.filter(call => call === 'dispatch:create')).toHaveLength(1)

    const terminal = await state.operations.submit(intent, ACTOR, new AbortController().signal)

    expect(terminal).toMatchObject({
      ok: false,
      reason: 'reconciliation-required',
      receipt: {
        state: 'reconciliation-required',
        stage: 'issue-create',
        reason: 'effect-unknown',
      },
    })
    expect(state.github.calls).toEqual([
      'inspect:create',
      'dispatch:create',
      'inspect:create',
      'inspect:create',
      'inspect:create',
    ])
    expect(state.github.calls.filter(call => call === 'dispatch:create')).toHaveLength(1)
  })

  it.each([
    {
      name: 'authority revocation',
      arrange: () => {
        const state = harness()
        state.github.afterInspect = () => { state.authority.current = false }
        return state
      },
      expected: {
        ok: false,
        reason: 'canceled',
        receipt: { state: 'canceled', reason: 'authority-revoked' },
      },
      dispatches: 0,
    },
    {
      name: 'mapping revision drift',
      arrange: () => {
        const context = mutableMutationContext(CONTEXT)
        const state = harness(
          { ok: true, context: CONTEXT },
          true,
          { mutationContext: context.resolve },
        )
        state.github.afterInspect = () => {
          context.replace({
            ...CONTEXT,
            mappingRevision: CONTEXT.mappingRevision + 1,
            confirmedBoard: {
              ...CONTEXT.confirmedBoard,
              configurationRevision: CONTEXT.confirmedBoard.configurationRevision + 1,
            },
          })
        }
        return state
      },
      expected: {
        ok: false,
        reason: 'conflict',
        receipt: { state: 'conflict', reason: 'expected-revision' },
      },
      dispatches: 0,
    },
    {
      name: 'a uniquely created marker Issue that is already closed',
      arrange: () => {
        const state = harness()
        state.github.beforeDispatch = () => {
          if (state.github.calls.at(-1) === 'dispatch:create') state.github.issueState = 'closed'
        }
        return state
      },
      expected: {
        ok: false,
        reason: 'reconciliation-required',
        receipt: {
          state: 'reconciliation-required',
          stage: 'issue-create',
          reason: 'evidence-conflict',
        },
      },
      dispatches: 1,
    },
  ])('handles Create admission after inspection: $name', async ({ arrange, expected, dispatches }) => {
    const state = arrange()

    const result = await state.operations.submit(
      createIntent(),
      ACTOR,
      new AbortController().signal,
    )

    expect(result).toMatchObject(expected)
    expect(state.github.calls.filter(call => call === 'dispatch:create')).toHaveLength(dispatches)
  })

  it('durably rejects stale create revisions before any GitHub effect is possible', async () => {
    const state = harness()
    const stale = {
      ...createIntent(),
      expected: { ...createIntent().expected, mappingRevision: CONTEXT.mappingRevision - 1 },
    } as const satisfies CreateWorkItemIntent

    expect(await state.operations.submit(stale, ACTOR, new AbortController().signal)).toMatchObject({
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'expected-revision' },
    })
    const retained = state.intentTable.get(INTENT_ID)
    expect(retained).toMatchObject({
      phase: 'conflict',
      terminalEvidence: { kind: 'conflict', reason: 'expected-revision' },
    })
    expect(retained?.stages.every(stage => !stage.effectPossible)).toBe(true)
    expect(state.recoveryTable.size).toBe(0)
    expect(state.github.calls).toEqual([])
    expect(state.operations.project(
      PROJECT_ID,
      CONTEXT.confirmedBoard,
      AVAILABLE,
      ALLOWED,
    ).mutationOverlays).toEqual([{
      state: 'conflict',
      intentId: INTENT_ID,
      type: 'create-work-item',
      reason: 'expected-revision',
    }])
  })

  it('persists membership evidence before moving an unjoined Inbox Issue through Status', async () => {
    const state = harness({ ok: true, context: UNJOINED_CONTEXT })
    state.github.inProject = false
    let membershipDispatchChecked = false
    state.github.beforeDispatch = () => {
      if (state.github.calls.at(-1) !== 'dispatch:add') return
      membershipDispatchChecked = true
      expect(state.intentTable.get(INTENT_ID)).toMatchObject({
        phase: 'running',
        target: {
          source: { membership: 'absent', issueState: 'open', status: 'inbox' },
        },
        stages: [
          { kind: 'project-item-add', state: 'dispatching', effectPossible: true },
          { kind: 'project-item-status-set', state: 'prepared', effectPossible: false },
        ],
        observedPrefix: [],
      })
      expect(state.intentTable.get(INTENT_ID)?.stages[1]?.resolvedTarget).toBeUndefined()
    }

    const result = await state.operations.submit(
      unjoinedMoveIntent(),
      ACTOR,
      new AbortController().signal,
    )

    expect(result).toMatchObject({ ok: true, receipt: { state: 'succeeded', workItemId: WORK_ITEM_ID } })
    expect(membershipDispatchChecked).toBe(true)
    expect(state.github.calls).toEqual([
      'inspect:add',
      'dispatch:add',
      'inspect:add',
      'inspect',
      'dispatch',
      'inspect',
    ])
    expect(state.intentTable.get(INTENT_ID)).toMatchObject({
      phase: 'succeeded',
      target: { projectItemId: ITEM_ID },
      stages: [
        { kind: 'project-item-add', state: 'confirmed' },
        { kind: 'project-item-status-set', state: 'confirmed' },
      ],
      observedPrefix: [
        { stageKind: 'project-item-add', facts: { membership: { state: 'present' } } },
        { stageKind: 'project-item-status-set', facts: { membership: { state: 'present' } } },
      ],
    })
    expect(() => state.operations.validateDurableState(new Set())).not.toThrow()
  })

  it('recovers an unjoined membership effect after a lost acknowledgement without dispatching add twice', async () => {
    const state = harness({ ok: true, context: UNJOINED_CONTEXT })
    state.github.inProject = false
    state.github.addDispatchMode = 'mutate-then-fail'
    let inspectedInitialAbsence = false
    state.github.afterInspect = () => {
      if (inspectedInitialAbsence) return
      inspectedInitialAbsence = true
      state.github.inspectFailures = 1
    }

    const first = await state.operations.submit(
      unjoinedMoveIntent(),
      ACTOR,
      new AbortController().signal,
    )

    expect(first).toMatchObject({
      ok: false,
      reason: 'unavailable',
      receipt: {
        state: 'partial-failure',
        stage: 'project-item-add',
        recoveryAction: { kind: 'inspect-before-retry' },
      },
    })
    expect(state.github.calls.filter(call => call === 'dispatch:add')).toHaveLength(1)

    state.github.inspectFailures = 1
    const failedReplay = await state.operations.submit(
      unjoinedMoveIntent(),
      ACTOR,
      new AbortController().signal,
    )

    expect(failedReplay).toMatchObject({
      ok: false,
      reason: 'unavailable',
      receipt: {
        state: 'partial-failure',
        stage: 'project-item-add',
        recoveryAction: { kind: 'inspect-before-retry' },
      },
    })
    expect(requiredIntent(state)).toMatchObject({
      phase: 'partial-failure',
      stages: [{
        kind: 'project-item-add',
        state: 'failed',
        effectPossible: true,
      }, {
        kind: 'project-item-status-set',
        state: 'prepared',
        effectPossible: false,
      }],
    })
    expect(state.github.calls.filter(call => call === 'dispatch:add')).toHaveLength(1)

    const restarted = harness({ ok: true, context: UNJOINED_CONTEXT }, false, {
      intentTable: state.intentTable,
      recoveryTable: state.recoveryTable,
      github: state.github,
    })
    await restarted.operations.initializeValidated(restarted.operations.validateDurableState(new Set()))
    restarted.operations.attach(state.github)
    await restarted.operations.dispose()

    expect(restarted.intentTable.get(INTENT_ID)).toMatchObject({ phase: 'succeeded' })
    expect(state.github.calls.filter(call => call === 'dispatch:add')).toHaveLength(1)
    expect(state.github.calls.filter(call => call === 'dispatch')).toHaveLength(1)
  })

  it('accepts an externally added unique membership without admitting an add effect', async () => {
    const state = harness({ ok: true, context: UNJOINED_CONTEXT })
    state.github.inProject = true

    expect(await state.operations.submit(
      unjoinedMoveIntent(),
      ACTOR,
      new AbortController().signal,
    )).toMatchObject({ ok: true, receipt: { state: 'succeeded' } })

    expect(state.github.calls).not.toContain('dispatch:add')
    expect(state.intentTable.get(INTENT_ID)).toMatchObject({
      stages: [
        { kind: 'project-item-add', state: 'confirmed', effectPossible: false },
        { kind: 'project-item-status-set', state: 'confirmed', effectPossible: true },
      ],
    })
  })

  it('surfaces duplicate Project memberships as a mapping conflict without dispatch', async () => {
    const state = harness({ ok: true, context: UNJOINED_CONTEXT })
    state.github.inProject = true
    state.github.duplicateMembership = true

    expect(await state.operations.submit(
      unjoinedMoveIntent(),
      ACTOR,
      new AbortController().signal,
    )).toMatchObject({
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'mapping-repair-required' },
    })

    expect(state.github.calls).toEqual(['inspect:add'])
    expect(state.intentTable.get(INTENT_ID)).toMatchObject({
      phase: 'conflict',
      terminalEvidence: {
        kind: 'conflict',
        confirmedObservation: { facts: { membership: { state: 'duplicate-conflict' } } },
      },
    })
  })

  it.each([
    {
      name: 'a present membership whose Issue is closed',
      arrange: () => {
        const state = harness({ ok: true, context: UNJOINED_CONTEXT })
        state.github.issueState = 'closed'
        return { state, intent: unjoinedMoveIntent() }
      },
      receiptReason: 'mapping-repair-required',
      resultReason: 'conflict',
    },
    {
      name: 'an archived present membership',
      arrange: () => {
        const state = harness({ ok: true, context: UNJOINED_CONTEXT })
        state.github.archived = true
        return { state, intent: unjoinedMoveIntent() }
      },
      receiptReason: 'mapping-repair-required',
      resultReason: 'conflict',
    },
    {
      name: 'an absent membership with a different remote fingerprint',
      arrange: () => {
        const context = contextWithItem(item => ({
          ...item,
          status: 'inbox',
          latestNonTerminalStatus: 'inbox',
          notInProject: true,
          source: {
            kind: 'github-issue',
            repositoryId: CONFIGURATION.repositoryNodeId,
            issueId: ISSUE_ID,
          },
          remoteFingerprint: EXPECTED_REMOTE_FINGERPRINT,
        }))
        const state = harness({ ok: true, context })
        state.github.inProject = false
        return {
          state,
          intent: {
            ...unjoinedMoveIntent(),
            expectedRemoteFingerprint: EXPECTED_REMOTE_FINGERPRINT,
          },
        }
      },
      receiptReason: 'stale-remote',
      resultReason: 'conflict',
    },
    {
      name: 'authority revoked after absence inspection',
      arrange: () => {
        const state = harness({ ok: true, context: UNJOINED_CONTEXT })
        state.github.inProject = false
        state.github.afterInspect = () => { state.authority.current = false }
        return { state, intent: unjoinedMoveIntent() }
      },
      receiptReason: 'authority-revoked',
      resultReason: 'canceled',
    },
    {
      name: 'a mapping rebound after absence inspection',
      arrange: () => {
        const context = mutableMutationContext(UNJOINED_CONTEXT)
        const state = harness(
          { ok: true, context: UNJOINED_CONTEXT },
          true,
          { mutationContext: context.resolve },
        )
        state.github.inProject = false
        state.github.afterInspect = () => {
          const projectId = githubProjectId('P_membership_rebound')
          context.replace({
            ...UNJOINED_CONTEXT,
            mappingRevision: UNJOINED_CONTEXT.mappingRevision + 1,
            configuration: githubSynchronizationConfigurationSchema.parse({
              ...CONFIGURATION,
              projectNodeId: projectId,
            }),
            confirmedBoard: {
              ...UNJOINED_CONTEXT.confirmedBoard,
              configurationRevision: UNJOINED_CONTEXT.confirmedBoard.configurationRevision + 1,
              project: { ...UNJOINED_CONTEXT.confirmedBoard.project, id: projectId },
            },
          })
        }
        return { state, intent: unjoinedMoveIntent() }
      },
      receiptReason: 'mapping-repair-required',
      resultReason: 'conflict',
    },
  ])('stops membership admission for $name', async ({
    arrange,
    receiptReason,
    resultReason,
  }) => {
    const { state, intent } = arrange()

    const result = await state.operations.submit(
      intent,
      ACTOR,
      new AbortController().signal,
    )

    expect(result).toMatchObject({
      ok: false,
      reason: resultReason,
      receipt: { state: resultReason, reason: receiptReason },
    })
    expect(state.github.calls.filter(call => call === 'dispatch:add')).toHaveLength(0)
    expect(state.github.calls).not.toContain('dispatch')
  })

  it('combines synchronization, provider, and authority availability without browser authority ids', () => {
    const detached = harness({ ok: true, context: CONTEXT }, false)
    const synchronizationUnavailable = {
      available: false,
      reasons: ['configuration-not-activated', 'checkpoint-unavailable'],
    } as const satisfies SakiBoardMutationAvailabilityProjection
    expect(detached.operations.project(PROJECT_ID, undefined, synchronizationUnavailable, ALLOWED)).toMatchObject({
      effectiveMutationAvailability: {
        available: false,
        reasons: ['configuration-not-activated', 'checkpoint-unavailable', 'provider-unavailable'],
      },
      mutationOverlays: [],
    })

    const attached = harness()
    expect(attached.operations.project(PROJECT_ID, CONTEXT.confirmedBoard, AVAILABLE, ALLOWED)).toMatchObject({
      effectiveMutationAvailability: { available: true, reasons: [] },
      mutationOverlays: [],
    })
    expect(attached.operations.project(PROJECT_ID, CONTEXT.confirmedBoard, AVAILABLE, {
      'work-item:create': true,
      'work-item:move': false,
    }).effectiveMutationAvailability).toEqual({ available: false, reasons: ['action-denied'] })

    const detachOriginal = detached.operations.attach(detached.github)
    const detachReplacement = detached.operations.attach(new StatusGitHub(new Context()))
    const notifications = detached.changes.length
    detachOriginal()
    expect(detached.changes).toHaveLength(notifications)
    expect(detached.operations.project(PROJECT_ID, CONTEXT.confirmedBoard, AVAILABLE, ALLOWED)
      .effectiveMutationAvailability).toEqual({ available: true, reasons: [] })
    detachReplacement()
    expect(detached.operations.project(PROJECT_ID, CONTEXT.confirmedBoard, AVAILABLE, ALLOWED)
      .effectiveMutationAvailability).toEqual({ available: false, reasons: ['provider-unavailable'] })
  })

  it('derives external close and reopen repairs from the confirmed Board only', () => {
    const state = harness()
    const item = CONTEXT.confirmedBoard.items[0]!
    const project = (patch: Partial<typeof item>) => state.operations.project(
      PROJECT_ID,
      { ...CONTEXT.confirmedBoard, items: [{ ...item, ...patch }] },
      AVAILABLE,
      ALLOWED,
    ).mutationOverlays

    expect(project({ issueState: 'closed', status: 'in-review', latestNonTerminalStatus: 'in-review' }))
      .toEqual([{
        state: 'repair-required',
        workItemId: WORK_ITEM_ID,
        reason: 'external-close',
        action: 'move-with-actor',
        suggestedStatus: 'done',
      }])
    expect(project({ issueState: 'open', status: 'done', latestNonTerminalStatus: 'in-review' }))
      .toEqual([{
        state: 'repair-required',
        workItemId: WORK_ITEM_ID,
        reason: 'external-reopen',
        action: 'move-with-actor',
        suggestedStatus: 'in-review',
      }])
    expect(project({ issueState: 'open', status: 'canceled', latestNonTerminalStatus: null }))
      .toEqual([{
        state: 'repair-required',
        workItemId: WORK_ITEM_ID,
        reason: 'external-reopen',
        action: 'move-with-actor',
        suggestedStatus: 'backlog',
      }])
    expect(project({ issueState: 'open', status: 'canceled', latestNonTerminalStatus: null, archived: true }))
      .toEqual([])
    expect(project({ issueState: 'open', status: 'ready', latestNonTerminalStatus: 'ready' })).toEqual([])
  })

  it('persists effect-possible before dispatch and confirms Status without advancing a Board checkpoint', async () => {
    const state = harness()
    state.github.beforeDispatch = () => {
      expect(state.intentTable.get(INTENT_ID)).toMatchObject({
        phase: 'running',
        stages: [{ kind: 'project-item-status-set', state: 'dispatching', effectPossible: true }],
      })
      expect(state.recoveryTable.get(RECOVERY_ID)).toMatchObject({
        confirmed: {
          observation: {
            remoteFingerprint: EXPECTED_REMOTE_FINGERPRINT,
            facts: { membership: { item: { statusOptionId: CONFIGURATION.statusOptionNodeIds.ready } } },
          },
        },
      })
      expect(state.operations.project(PROJECT_ID, CONTEXT.confirmedBoard, AVAILABLE, ALLOWED).mutationOverlays)
        .toEqual([{
          state: 'optimistic',
          intentId: INTENT_ID,
          type: 'move-work-item',
          workItemId: WORK_ITEM_ID,
          targetStatus: 'in-progress',
        }])
    }

    const result = await state.operations.submit(moveIntent(), ACTOR, new AbortController().signal)

    expect(result).toMatchObject({
      ok: true,
      receipt: {
        state: 'succeeded',
        type: 'move-work-item',
        projectId: PROJECT_ID,
        workItemId: WORK_ITEM_ID,
        issueNumber: 27,
        remoteFingerprint: targetedBoardRemoteFingerprint(snapshot(CONFIGURATION.statusOptionNodeIds.inProgress)),
      },
    })
    expect(state.github.calls).toEqual(['inspect', 'dispatch', 'inspect'])
    expect(state.intentTable.get(INTENT_ID)).toMatchObject({
      phase: 'succeeded',
      stages: [{ state: 'confirmed', effectPossible: true }],
      observedPrefix: [{ workItemId: WORK_ITEM_ID }],
      terminalEvidence: { kind: 'succeeded' },
    })
    expect(state.recoveryTable.get(RECOVERY_ID)).toMatchObject({
      id: RECOVERY_ID,
      workItemId: WORK_ITEM_ID,
      latestNonTerminalStatus: 'in-progress',
      confirmed: { observation: { facts: { membership: { state: 'present' } } } },
    })
    expect(state.scans).toEqual([PROJECT_ID])
    expect(state.changes.length).toBeGreaterThan(0)
    const projected = state.operations.project(PROJECT_ID, CONTEXT.confirmedBoard, AVAILABLE, ALLOWED)
    expect(projected.mutationOverlays).toMatchObject([{
      state: 'targeted-confirmed',
      intentId: INTENT_ID,
      type: 'move-work-item',
      workItem: { id: WORK_ITEM_ID, status: 'in-progress', latestNonTerminalStatus: 'in-progress' },
    }])
    const confirmed = {
      ...CONTEXT.confirmedBoard,
      items: [{
        ...CONTEXT.confirmedBoard.items[0]!,
        status: 'in-progress' as const,
        latestNonTerminalStatus: 'in-progress' as const,
        remoteFingerprint: projected.mutationOverlays[0]?.state === 'targeted-confirmed'
          ? projected.mutationOverlays[0].workItem.remoteFingerprint
          : EXPECTED_REMOTE_FINGERPRINT,
      }],
    }
    expect(state.operations.project(PROJECT_ID, confirmed, AVAILABLE, ALLOWED).mutationOverlays).toEqual([])
    const laterDifferentBoard = {
      ...CONTEXT.confirmedBoard,
      items: [{
        ...CONTEXT.confirmedBoard.items[0]!,
        status: 'backlog' as const,
        latestNonTerminalStatus: 'backlog' as const,
        remoteFingerprint: `remote-fingerprint-${'f'.repeat(64)}` as typeof EXPECTED_REMOTE_FINGERPRINT,
      }],
    }
    const targeted = projected.mutationOverlays[0]
    if (targeted?.state !== 'targeted-confirmed') throw new Error('targeted overlay is missing')
    expect(state.operations.project(
      PROJECT_ID,
      laterDifferentBoard,
      AVAILABLE,
      ALLOWED,
      targeted.confirmedAt + 1,
    ).mutationOverlays).toEqual([])
  })

  it('materializes add, Status, and position targets for one positioned unjoined Inbox item', async () => {
    const state = harness({ ok: true, context: UNJOINED_POSITION_CONTEXT })
    state.github.inProject = false
    state.github.positionScenario = true
    state.github.statusOptionId = CONFIGURATION.statusOptionNodeIds.inbox
    const intent = unjoinedPositionMoveIntent()

    const result = await state.operations.submit(intent, ACTOR, new AbortController().signal)
    const record = requiredIntent(state)

    expect(result).toMatchObject({ ok: true, receipt: { state: 'succeeded', workItemId: WORK_ITEM_ID } })
    expect(state.github.calls).toEqual([
      'inspect:add',
      'dispatch:add',
      'inspect:add',
      'inspect',
      'dispatch',
      'inspect',
      'inspect:position',
      'dispatch:position',
      'inspect:position',
    ])
    expect(record).toMatchObject({
      phase: 'succeeded',
      target: {
        kind: 'move-work-item',
        projectId: CONFIGURATION.projectNodeId,
        issueId: ISSUE_ID,
        projectItemId: ITEM_ID,
        statusFieldId: CONFIGURATION.statusFieldNodeId,
        desiredStatusOptionId: CONFIGURATION.statusOptionNodeIds.inProgress,
        source: { membership: 'absent', issueState: 'open', status: 'inbox' },
        position: {
          kind: 'after',
          workItemId: ANCHOR_WORK_ITEM_ID,
          projectItemId: ANCHOR_ITEM_ID,
          expectedRemoteFingerprint: ANCHOR_REMOTE_FINGERPRINT,
        },
      },
      stages: [
        {
          kind: 'project-item-add',
          state: 'confirmed',
          effectPossible: true,
          resolvedTarget: {
            kind: 'project-item-add',
            projectId: CONFIGURATION.projectNodeId,
            issueId: ISSUE_ID,
          },
        },
        {
          kind: 'project-item-status-set',
          state: 'confirmed',
          effectPossible: true,
          resolvedTarget: {
            kind: 'project-item-status-set',
            projectId: CONFIGURATION.projectNodeId,
            issueId: ISSUE_ID,
            projectItemId: ITEM_ID,
            statusFieldId: CONFIGURATION.statusFieldNodeId,
            desiredStatusOptionId: CONFIGURATION.statusOptionNodeIds.inProgress,
          },
        },
        {
          kind: 'project-item-position-set',
          state: 'confirmed',
          effectPossible: true,
          resolvedTarget: {
            kind: 'project-item-position-set',
            projectId: CONFIGURATION.projectNodeId,
            issueId: ISSUE_ID,
            projectItemId: ITEM_ID,
            statusFieldId: CONFIGURATION.statusFieldNodeId,
            afterItemId: ANCHOR_ITEM_ID,
          },
        },
      ],
      observedPrefix: [
        {
          stageKind: 'project-item-add',
          facts: { membership: { state: 'present', item: { id: ITEM_ID } } },
        },
        {
          stageKind: 'project-item-status-set',
          facts: {
            membership: { state: 'present', item: { id: ITEM_ID, statusOptionId: CONFIGURATION.statusOptionNodeIds.inProgress } },
          },
        },
        {
          stageKind: 'project-item-position-set',
          facts: {
            membership: { state: 'present', item: { id: ITEM_ID, previousItemId: ANCHOR_ITEM_ID } },
            after: { state: 'present', item: { id: ANCHOR_ITEM_ID } },
          },
        },
      ],
      terminalEvidence: {
        kind: 'succeeded',
        confirmedObservation: { stageKind: 'project-item-position-set' },
      },
    })
    expect(requiredRecovery(state)).toMatchObject({
      confirmed: {
        sourceIntentId: INTENT_ID,
        observation: { stageKind: 'project-item-position-set' },
      },
      latestNonTerminalStatus: 'in-progress',
    })
    expect(state.github.calls.filter(call => call.startsWith('dispatch'))).toHaveLength(3)
    expect(() => state.operations.validateDurableState(new Set())).not.toThrow()
  })

  it('confirms Status and then moves the Work Item after one frozen predecessor', async () => {
    const state = harness({ ok: true, context: POSITION_CONTEXT })
    state.github.positionScenario = true

    const result = await state.operations.submit(
      positionMoveIntent(),
      ACTOR,
      new AbortController().signal,
    )

    expect(result).toMatchObject({
      ok: true,
      receipt: {
        state: 'succeeded',
        remoteFingerprint: targetedBoardRemoteFingerprint(positionTargetSnapshot(
          CONFIGURATION.statusOptionNodeIds.inProgress,
          true,
        )),
      },
    })
    expect(state.github.calls).toEqual([
      'inspect',
      'dispatch',
      'inspect',
      'inspect:position',
      'dispatch:position',
      'inspect:position',
    ])
    expect(state.intentTable.get(INTENT_ID)).toMatchObject({
      phase: 'succeeded',
      stages: [
        { kind: 'project-item-status-set', state: 'confirmed', effectPossible: true },
        { kind: 'project-item-position-set', state: 'confirmed', effectPossible: true },
      ],
      observedPrefix: [
        { stageKind: 'project-item-status-set' },
        {
          stageKind: 'project-item-position-set',
          facts: {
            membership: { item: { statusOptionId: CONFIGURATION.statusOptionNodeIds.inProgress } },
            after: { state: 'present', item: { id: ANCHOR_ITEM_ID } },
          },
        },
      ],
      terminalEvidence: { kind: 'succeeded', confirmedObservation: { stageKind: 'project-item-position-set' } },
    })
    expect(state.recoveryTable.get(RECOVERY_ID)).toMatchObject({
      confirmed: {
        sourceIntentId: INTENT_ID,
        observation: {
          stageKind: 'project-item-position-set',
          facts: { membership: { item: { apiOrder: 1, previousItemId: ANCHOR_ITEM_ID } } },
        },
      },
    })
    const retained = state.intentTable.get(INTENT_ID)
    const positionStage = retained?.stages.find(stage => stage.kind === 'project-item-position-set')
    if (retained === undefined || positionStage?.resolvedTarget?.kind !== 'project-item-position-set') {
      throw new Error('position stage fixture is missing')
    }
    expect(githubWorkItemIntentRecordSchema.safeParse({
      ...retained,
      stages: retained.stages.map(stage => stage.mutationId === positionStage.mutationId
        ? {
          ...stage,
          resolvedTarget: { ...positionStage.resolvedTarget, statusFieldId: undefined },
        }
        : stage),
    }).success).toBe(false)
    const recovery = state.recoveryTable.get(RECOVERY_ID)
    if (recovery?.confirmed.observation.stageKind !== 'project-item-position-set'
      || recovery.confirmed.observation.facts.membership.state !== 'present') {
      throw new Error('position recovery fixture is missing')
    }
    const membership = recovery.confirmed.observation.facts.membership
    expect(githubWorkItemRecoveryRecordSchema.safeParse({
      ...recovery,
      confirmed: {
        ...recovery.confirmed,
        observation: {
          ...recovery.confirmed.observation,
          facts: {
            ...recovery.confirmed.observation.facts,
            membership: {
              state: 'duplicate-conflict',
              items: [membership.item, { ...membership.item, id: POSITION_DUPLICATE_ITEM_ID, apiOrder: 2 }],
            },
          },
        },
      },
    }).success).toBe(false)
  })

  it('reuses fresh position inspection before and after closing a terminal Work Item', async () => {
    const state = harness({ ok: true, context: TERMINAL_POSITION_CONTEXT })
    state.github.positionScenario = true
    state.github.anchorStatusOptionId = CONFIGURATION.statusOptionNodeIds.done

    const result = await state.operations.submit(
      terminalPositionMoveIntent(),
      ACTOR,
      new AbortController().signal,
    )

    expect(result).toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
    expect(state.github.calls).toEqual([
      'inspect',
      'dispatch',
      'inspect',
      'inspect:position',
      'dispatch:position',
      'inspect:position',
      'inspect:issue-state',
      'inspect:position',
      'dispatch:issue-state',
      'inspect:issue-state',
      'inspect:position',
    ])
    expect(state.github.calls.slice(6)).not.toContain('inspect')
    expect(state.intentTable.get(INTENT_ID)).toMatchObject({
      phase: 'succeeded',
      stages: [
        { kind: 'project-item-status-set', state: 'confirmed' },
        { kind: 'project-item-position-set', state: 'confirmed' },
        { kind: 'issue-state-set', state: 'confirmed' },
      ],
      terminalEvidence: {
        kind: 'succeeded',
        confirmedObservation: {
          stageKind: 'project-item-position-set',
          facts: {
            issue: { state: 'closed' },
            membership: {
              item: {
                statusOptionId: CONFIGURATION.statusOptionNodeIds.done,
                previousItemId: ANCHOR_ITEM_ID,
              },
            },
          },
        },
      },
    })
    expect(state.recoveryTable.get(RECOVERY_ID)).toMatchObject({
      latestNonTerminalStatus: 'ready',
      confirmed: {
        observation: {
          stageKind: 'project-item-position-set',
          facts: { issue: { state: 'closed' } },
        },
      },
    })
    const retained = state.intentTable.get(INTENT_ID)
    const confirmed = retained?.terminalEvidence?.kind === 'succeeded'
      ? retained.terminalEvidence.confirmedObservation
      : undefined
    if (retained === undefined || confirmed?.stageKind !== 'project-item-position-set') {
      throw new Error('terminal position fixture is missing')
    }
    expect(githubWorkItemIntentRecordSchema.safeParse({
      ...retained,
      terminalEvidence: {
        ...retained.terminalEvidence,
        confirmedObservation: {
          ...confirmed,
          facts: {
            ...confirmed.facts,
            issue: { ...confirmed.facts.issue, state: 'open' },
          },
        },
      },
    }).success).toBe(false)
  })

  it('accepts an externally reached predecessor position without dispatching it again', async () => {
    const state = harness({ ok: true, context: POSITION_CONTEXT })
    state.github.positionScenario = true
    let predecessorMoved = false
    state.github.afterInspect = (kind) => {
      if (predecessorMoved || kind !== 'project-item-status-set'
        || !state.github.calls.includes('dispatch')) return
      predecessorMoved = true
      state.github.positionedAfter = true
    }

    const result = await state.operations.submit(
      positionMoveIntent(),
      ACTOR,
      new AbortController().signal,
    )

    expect(result).toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
    expect(state.github.calls).toEqual([
      'inspect',
      'dispatch',
      'inspect',
      'inspect:position',
    ])
    expect(state.intentTable.get(INTENT_ID)).toMatchObject({
      stages: [
        { kind: 'project-item-status-set', effectPossible: true },
        { kind: 'project-item-position-set', effectPossible: false },
      ],
    })
  })

  it('moves a Work Item from a predecessor to the global API top', async () => {
    const moving = positionTargetSnapshot(CONFIGURATION.statusOptionNodeIds.ready, true)
    const anchor = positionAnchorSnapshot(true)
    const context: GitHubWorkItemMutationContext = {
      ...POSITION_CONTEXT,
      confirmedBoard: {
        ...POSITION_CONTEXT.confirmedBoard,
        items: POSITION_CONTEXT.confirmedBoard.items.map(item => item.id === WORK_ITEM_ID
          ? {
            ...item,
            order: 1,
            source: { ...item.source, apiOrder: 1 },
            remoteFingerprint: targetedBoardRemoteFingerprint(moving),
          }
          : {
            ...item,
            order: 0,
            source: { ...item.source, apiOrder: 0 },
            remoteFingerprint: targetedBoardRemoteFingerprint(anchor),
          }),
      },
    }
    const state = harness({ ok: true, context })
    state.github.positionScenario = true
    state.github.positionedAfter = true

    const result = await state.operations.submit(
      {
        ...topPositionMoveIntent(),
        expectedRemoteFingerprint: targetedBoardRemoteFingerprint(moving),
      },
      ACTOR,
      new AbortController().signal,
    )

    expect(result).toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
    expect(state.github.calls).toEqual([
      'inspect',
      'dispatch',
      'inspect',
      'inspect:position',
      'dispatch:position',
      'inspect:position',
    ])
    expect(state.intentTable.get(INTENT_ID)).toMatchObject({
      target: { position: { kind: 'top' } },
      stages: [
        { kind: 'project-item-status-set', effectPossible: true },
        {
          kind: 'project-item-position-set',
          effectPossible: true,
          resolvedTarget: { afterItemId: null },
        },
      ],
    })
    expect(state.github.calls.filter(call => call === 'dispatch:position')).toHaveLength(1)
  })

  it.each([
    {
      name: 'revoked authority',
      drift: (state: Harness, _context: MutableMutationContext) => { state.authority.current = false },
      expected: { ok: false, reason: 'canceled', receipt: { state: 'canceled', reason: 'authority-revoked' } },
    },
    {
      name: 'changed mapping context',
      drift: (_state: Harness, context: MutableMutationContext) => {
        context.replace({
          ...POSITION_CONTEXT,
          configuration: githubSynchronizationConfigurationSchema.parse({
            ...CONFIGURATION,
            statusOptionNodeIds: { ...CONFIGURATION.statusOptionNodeIds, inProgress: 'O_rebound' },
          }),
        })
      },
      expected: {
        ok: false,
        reason: 'conflict',
        receipt: { state: 'conflict', reason: 'mapping-repair-required' },
      },
    },
  ])('rechecks Position admission after inspection when $name', async ({ drift, expected }) => {
    const context = mutableMutationContext(POSITION_CONTEXT)
    const state = harness({ ok: true, context: POSITION_CONTEXT }, true, { mutationContext: context.resolve })
    state.github.positionScenario = true
    state.github.afterInspect = () => {
      if (state.github.calls.at(-1) === 'inspect:position') drift(state, context)
    }

    const result = await state.operations.submit(positionMoveIntent(), ACTOR, new AbortController().signal)

    expect(result).toMatchObject(expected)
    expect(state.github.calls.filter(call => call === 'dispatch:position')).toHaveLength(0)
  })

  it('confirms a position effect after acknowledgement loss without dispatching twice', async () => {
    const state = harness({ ok: true, context: POSITION_CONTEXT })
    state.github.positionScenario = true
    state.github.positionDispatchMode = 'mutate-then-fail'

    const result = await state.operations.submit(
      positionMoveIntent(),
      ACTOR,
      new AbortController().signal,
    )

    expect(result).toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
    expect(state.github.calls.filter(call => call === 'dispatch:position')).toHaveLength(1)
    expect(state.intentTable.get(INTENT_ID)).toMatchObject({
      phase: 'succeeded',
      terminalEvidence: { confirmedObservation: { stageKind: 'project-item-position-set' } },
    })
  })

  it('keeps a landed position recoverable across repeated inspection failures', async () => {
    const state = harness({ ok: true, context: POSITION_CONTEXT })
    state.github.positionScenario = true
    state.github.positionDispatchMode = 'mutate-then-fail'
    state.github.beforeDispatch = () => {
      if (state.github.calls.at(-1) === 'dispatch:position') state.github.inspectFailures = 1
    }

    const first = await state.operations.submit(
      positionMoveIntent(),
      ACTOR,
      new AbortController().signal,
    )

    expect(first).toMatchObject({
      ok: false,
      reason: 'unavailable',
      receipt: {
        state: 'partial-failure',
        stage: 'project-item-position-set',
        recoveryAction: { kind: 'inspect-before-retry' },
      },
    })
    expect(requiredIntent(state)).toMatchObject({
      phase: 'partial-failure',
      stages: [
        { kind: 'project-item-status-set', state: 'confirmed', effectPossible: true },
        { kind: 'project-item-position-set', state: 'failed', effectPossible: true },
      ],
    })

    state.github.beforeDispatch = undefined
    state.github.inspectFailures = 1
    const replay = await state.operations.submit(
      positionMoveIntent(),
      ACTOR,
      new AbortController().signal,
    )

    expect(replay).toMatchObject({
      ok: false,
      reason: 'unavailable',
      receipt: {
        state: 'partial-failure',
        stage: 'project-item-position-set',
        recoveryAction: { kind: 'inspect-before-retry' },
      },
    })

    const recovered = await state.operations.submit(
      positionMoveIntent(),
      ACTOR,
      new AbortController().signal,
    )

    expect(recovered).toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
    expect(requiredIntent(state)).toMatchObject({ phase: 'succeeded' })
    expect(state.github.calls.filter(call => call === 'dispatch:position')).toHaveLength(1)
  })

  it('recovers a landed position after process loss without dispatching it twice', async () => {
    const state = harness({ ok: true, context: POSITION_CONTEXT })
    state.github.positionScenario = true
    state.github.positionDispatchMode = 'effect-then-process-crash'

    await expect(state.operations.submit(
      positionMoveIntent(),
      ACTOR,
      new AbortController().signal,
    )).rejects.toThrow(SimulatedProcessCrash)
    expect(state.intentTable.get(INTENT_ID)).toMatchObject({
      phase: 'running',
      stages: [
        { kind: 'project-item-status-set', state: 'confirmed' },
        { kind: 'project-item-position-set', state: 'dispatching', effectPossible: true },
      ],
    })

    const restarted = harness({ ok: true, context: POSITION_CONTEXT }, false, {
      intentTable: state.intentTable,
      recoveryTable: state.recoveryTable,
      github: state.github,
    })
    await restarted.operations.initializeValidated(restarted.operations.validateDurableState(new Set()))
    restarted.operations.attach(state.github)
    await restarted.operations.dispose()

    expect(restarted.intentTable.get(INTENT_ID)).toMatchObject({ phase: 'succeeded' })
    expect(state.github.calls.filter(call => call === 'dispatch:position')).toHaveLength(1)
  })

  it('retries one unchanged position after a confirmed pre-effect transport failure', async () => {
    const state = harness({ ok: true, context: POSITION_CONTEXT })
    state.github.positionScenario = true
    state.github.positionDispatchMode = 'fail-before-effect'

    const partial = await state.operations.submit(
      positionMoveIntent(),
      ACTOR,
      new AbortController().signal,
    )

    expect(partial).toMatchObject({
      ok: false,
      receipt: {
        state: 'partial-failure',
        stage: 'project-item-position-set',
        recoveryAction: { kind: 'inspect-before-retry' },
      },
    })
    expect(state.github.calls.filter(call => call === 'dispatch:position')).toHaveLength(1)

    state.github.positionDispatchMode = 'success'
    const replay = await state.operations.submit(
      positionMoveIntent(),
      ACTOR,
      new AbortController().signal,
    )

    expect(replay).toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
    expect(state.github.calls.filter(call => call === 'dispatch:position')).toHaveLength(2)
  })

  it('rejects a retained position retry after its predecessor Status drifts', async () => {
    const state = harness({ ok: true, context: POSITION_CONTEXT })
    state.github.positionScenario = true
    state.github.positionDispatchMode = 'fail-before-effect'

    const partial = await state.operations.submit(
      positionMoveIntent(),
      ACTOR,
      new AbortController().signal,
    )

    expect(partial).toMatchObject({
      ok: false,
      receipt: {
        state: 'partial-failure',
        stage: 'project-item-position-set',
        recoveryAction: { kind: 'inspect-before-retry' },
      },
    })
    expect(requiredIntent(state)).toMatchObject({
      phase: 'partial-failure',
      stages: [
        { kind: 'project-item-status-set', state: 'confirmed' },
        { kind: 'project-item-position-set', state: 'failed', effectPossible: true },
      ],
    })
    expect(state.github.calls.filter(call => call === 'dispatch:position')).toHaveLength(1)

    state.github.anchorStatusOptionId = CONFIGURATION.statusOptionNodeIds.backlog
    const replay = await state.operations.submit(
      positionMoveIntent(),
      ACTOR,
      new AbortController().signal,
    )

    expect(replay).toMatchObject({
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'stale-remote' },
    })
    expect(state.github.calls.filter(call => call === 'dispatch:position')).toHaveLength(1)
  })

  it.each([
    {
      name: 'Position authority is revoked before recovery',
      prepare: async () => {
        const state = await retainedEffectPossiblePosition()
        state.authority.current = false
        return {
          state,
          intent: positionMoveIntent(),
          dispatchCall: 'dispatch:position',
          markerObserved: () => true,
          expected: {
            ok: false,
            reason: 'canceled',
            receipt: { state: 'canceled', reason: 'authority-revoked' },
          },
        }
      },
    },
    {
      name: 'Position predecessor drifts after its dispatch marker',
      prepare: async () => {
        const context = mutableMutationContext(POSITION_CONTEXT)
        const state = await retainedEffectPossiblePosition({ mutationContext: context.resolve })
        let markerObserved = false
        state.intentTable.afterUpdate = (record) => {
          const stage = record.stages[record.observedPrefix.length]
          if (record.phase !== 'running' || stage?.kind !== 'project-item-position-set'
            || !stage.effectPossible) return
          markerObserved = true
          state.intentTable.afterUpdate = undefined
          if (ANCHOR_POSITION_SNAPSHOT.membership.state !== 'present') {
            throw new Error('Position predecessor fixture lacks membership')
          }
          const remoteFingerprint = targetedBoardRemoteFingerprint({
            ...ANCHOR_POSITION_SNAPSHOT,
            membership: {
              state: 'present',
              item: { ...ANCHOR_POSITION_SNAPSHOT.membership.item, apiOrder: 2 },
            },
          })
          context.replace({
            ...POSITION_CONTEXT,
            confirmedBoard: {
              ...POSITION_CONTEXT.confirmedBoard,
              items: POSITION_CONTEXT.confirmedBoard.items.map(item => item.id === ANCHOR_WORK_ITEM_ID
                ? { ...item, order: 2, source: { ...item.source, apiOrder: 2 }, remoteFingerprint }
                : item),
            },
          })
        }
        return {
          state,
          intent: positionMoveIntent(),
          dispatchCall: 'dispatch:position',
          markerObserved: () => markerObserved,
          expected: {
            ok: false,
            reason: 'conflict',
            receipt: { state: 'conflict', reason: 'mapping-repair-required' },
          },
        }
      },
    },
    {
      name: 'Status authority is revoked after its dispatch marker',
      prepare: async () => {
        const state = harness()
        state.github.dispatchMode = 'fail-before-effect'
        const first = await state.operations.submit(moveIntent(), ACTOR, new AbortController().signal)
        expect(first).toMatchObject({
          ok: false,
          receipt: {
            state: 'partial-failure',
            stage: 'project-item-status-set',
            recoveryAction: { kind: 'inspect-before-retry' },
          },
        })
        state.github.dispatchMode = 'success'
        let markerObserved = false
        state.intentTable.afterUpdate = (record) => {
          const stage = record.stages[record.observedPrefix.length]
          if (record.phase !== 'running' || stage?.kind !== 'project-item-status-set'
            || !stage.effectPossible) return
          markerObserved = true
          state.intentTable.afterUpdate = undefined
          state.authority.current = false
        }
        return {
          state,
          intent: moveIntent(),
          dispatchCall: 'dispatch',
          markerObserved: () => markerObserved,
          expected: {
            ok: false,
            reason: 'canceled',
            receipt: { state: 'canceled', reason: 'authority-revoked' },
          },
        }
      },
    },
  ])('guards an effect-possible replay when $name', async ({ prepare }) => {
    const { state, intent, dispatchCall, markerObserved, expected } = await prepare()
    const dispatchesBeforeReplay = state.github.calls.filter(call => call === dispatchCall).length

    const replay = await state.operations.submit(intent, ACTOR, new AbortController().signal)

    expect(replay).toMatchObject(expected)
    expect(markerObserved()).toBe(true)
    expect(state.github.calls.filter(call => call === dispatchCall)).toHaveLength(dispatchesBeforeReplay)
  })

  it('rejects predecessor drift as stale without dispatching position', async () => {
    const state = harness({ ok: true, context: POSITION_CONTEXT })
    state.github.positionScenario = true
    state.github.anchorStatusOptionId = CONFIGURATION.statusOptionNodeIds.backlog

    const result = await state.operations.submit(
      positionMoveIntent(),
      ACTOR,
      new AbortController().signal,
    )

    expect(result).toMatchObject({
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'stale-remote' },
    })
    expect(state.github.calls).toContain('inspect:position')
    expect(state.github.calls).not.toContain('dispatch:position')
  })

  it('surfaces duplicate moving memberships as mapping repair without dispatching position', async () => {
    const state = harness({ ok: true, context: POSITION_CONTEXT })
    state.github.positionScenario = true
    state.github.positionDuplicateMembership = true

    const result = await state.operations.submit(
      positionMoveIntent(),
      ACTOR,
      new AbortController().signal,
    )

    expect(result).toMatchObject({
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'mapping-repair-required' },
    })
    expect(state.github.calls).toContain('inspect:position')
    expect(state.github.calls).not.toContain('dispatch:position')
  })

  it.each([
    {
      name: 'post-dispatch inspection is unavailable',
      configure: (state: Harness) => {
        state.github.beforeDispatch = (kind) => {
          if (kind === 'project-item-position-set') state.github.inspectFailures = 1
        }
      },
      expected: {
        ok: false,
        reason: 'unavailable',
        receipt: {
          state: 'partial-failure',
          stage: 'project-item-position-set',
          recoveryAction: { kind: 'inspect-before-retry' },
        },
      },
      replay: true,
    },
    {
      name: 'an acknowledged dispatch has no effect',
      configure: (state: Harness) => { state.github.positionDispatchHasEffect = false },
      expected: {
        ok: false,
        reason: 'conflict',
        receipt: { state: 'conflict', reason: 'stale-remote' },
      },
      replay: false,
    },
    {
      name: 'the moving Issue closes concurrently',
      configure: (state: Harness) => {
        state.github.beforeDispatch = (kind) => {
          if (kind === 'project-item-position-set') state.github.issueState = 'closed'
        }
      },
      expected: {
        ok: false,
        reason: 'conflict',
        receipt: { state: 'conflict', reason: 'stale-remote' },
      },
      replay: false,
    },
    {
      name: 'the pre-position recovery fingerprint drifts',
      configure: (state: Harness) => {
        state.github.positionDispatchHasEffect = false
        state.github.beforeDispatch = (kind) => {
          if (kind === 'project-item-position-set') state.github.positionNeighborDrift = true
        }
      },
      expected: {
        ok: false,
        reason: 'conflict',
        receipt: { state: 'conflict', reason: 'stale-remote' },
      },
      replay: false,
    },
    {
      name: 'the moving membership disappears concurrently',
      configure: (state: Harness) => {
        state.github.beforeDispatch = (kind) => {
          if (kind === 'project-item-position-set') state.github.inProject = false
        }
      },
      expected: {
        ok: false,
        reason: 'conflict',
        receipt: { state: 'conflict', reason: 'mapping-repair-required' },
      },
      replay: false,
    },
  ])('classifies a successful Position dispatch when $name', async ({ configure, expected, replay }) => {
    const state = harness({ ok: true, context: POSITION_CONTEXT })
    state.github.positionScenario = true
    configure(state)

    const result = await state.operations.submit(positionMoveIntent(), ACTOR, new AbortController().signal)

    expect(result).toMatchObject(expected)
    expect(state.github.calls).toContain('dispatch:position')
    if (!replay) return
    const dispatchesBeforeReplay = state.github.calls.filter(call => call === 'dispatch:position').length
    state.github.beforeDispatch = undefined
    expect(await state.operations.submit(positionMoveIntent(), ACTOR, new AbortController().signal))
      .toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
    expect(state.github.calls.filter(call => call === 'dispatch:position')).toHaveLength(dispatchesBeforeReplay)
  })

  it.each([
    {
      name: 'pre-inspection Issue identity drift',
      exercise: async () => {
        const state = harness()
        let issueDrifted = false
        state.github.afterInspect = (kind) => {
          if (issueDrifted || kind !== 'project-item-status-set'
            || !state.github.calls.includes('dispatch')) return
          issueDrifted = true
          state.github.issueId = CREATED_ISSUE_ID
        }
        const result = await state.operations.submit(
          terminalMoveIntent(),
          ACTOR,
          new AbortController().signal,
        )
        return { state, result, issueDispatches: 0 }
      },
      expected: {
        ok: false,
        reason: 'conflict',
        receipt: { state: 'conflict', reason: 'stale-remote' },
      },
    },
    {
      name: 'effect-possible replay observes Issue identity drift',
      exercise: async () => {
        const state = harness()
        const intent = terminalMoveIntent()
        state.github.beforeDispatch = () => {
          if (state.github.calls.at(-1) === 'dispatch:issue-state') {
            state.github.dispatchMode = 'fail-before-effect'
          }
        }
        const first = await state.operations.submit(intent, ACTOR, new AbortController().signal)
        expect(first).toMatchObject({
          ok: false,
          receipt: {
            state: 'partial-failure',
            stage: 'issue-state-set',
            recoveryAction: { kind: 'inspect-before-retry' },
          },
        })
        state.github.beforeDispatch = undefined
        state.github.issueId = CREATED_ISSUE_ID
        const result = await state.operations.submit(intent, ACTOR, new AbortController().signal)
        return { state, result, issueDispatches: 1 }
      },
      expected: {
        ok: false,
        reason: 'conflict',
        receipt: { state: 'conflict', reason: 'stale-remote' },
      },
    },
    {
      name: 'expected Issue state with a mismatched Board Status',
      exercise: async () => {
        const state = harness()
        state.github.afterInspect = () => {
          if (state.github.calls.at(-1) === 'inspect:issue-state') {
            state.github.statusOptionId = CONFIGURATION.statusOptionNodeIds.backlog
          }
        }
        const result = await state.operations.submit(
          terminalMoveIntent(),
          ACTOR,
          new AbortController().signal,
        )
        return { state, result, issueDispatches: 0 }
      },
      expected: {
        ok: false,
        reason: 'conflict',
        receipt: { state: 'conflict', reason: 'stale-remote' },
      },
    },
    {
      name: 'Project membership disappears after Issue-state dispatch',
      exercise: async () => {
        const state = harness()
        state.github.beforeDispatch = (kind) => {
          if (kind === 'issue-state-set') state.github.inProject = false
        }
        const result = await state.operations.submit(
          terminalMoveIntent(),
          ACTOR,
          new AbortController().signal,
        )
        return { state, result, issueDispatches: 1 }
      },
      expected: {
        ok: false,
        reason: 'conflict',
        receipt: { state: 'conflict', reason: 'stale-remote' },
      },
    },
    {
      name: 'mutation context is lost after Issue-state inspection',
      exercise: async () => {
        let contextUnavailable = false
        const state = harness({ ok: true, context: CONTEXT }, true, {
          mutationContext: () => contextUnavailable
            ? { ok: false, reason: 'unavailable', reasons: ['checkpoint-unavailable'] }
            : { ok: true, context: structuredClone(CONTEXT) },
        })
        let issueStateInspected = false
        state.github.afterInspect = (kind) => {
          if (kind === 'issue-state-set') issueStateInspected = true
          if (kind === 'project-item-status-set' && issueStateInspected) contextUnavailable = true
        }
        const result = await state.operations.submit(
          terminalMoveIntent(),
          ACTOR,
          new AbortController().signal,
        )
        return { state, result, issueDispatches: 0 }
      },
      expected: {
        ok: false,
        reason: 'conflict',
        receipt: { state: 'conflict', reason: 'mapping-repair-required' },
      },
    },
    {
      name: 'authority revoked after first-stage reopen inspection',
      exercise: async () => {
        const closedDone = snapshot(CONFIGURATION.statusOptionNodeIds.done, 'closed')
        const closedFingerprint = targetedBoardRemoteFingerprint(closedDone)
        const context: GitHubWorkItemMutationContext = {
          ...CONTEXT,
          confirmedBoard: {
            ...CONTEXT.confirmedBoard,
            items: [{
              ...CONTEXT.confirmedBoard.items[0]!,
              issueState: 'closed',
              status: 'done',
              latestNonTerminalStatus: null,
              remoteFingerprint: closedFingerprint,
            }],
          },
        }
        const state = harness({ ok: true, context })
        state.github.issueState = 'closed'
        state.github.statusOptionId = CONFIGURATION.statusOptionNodeIds.done
        state.github.afterInspect = () => {
          if (state.github.calls.at(-1) === 'inspect:issue-state') state.authority.current = false
        }
        const result = await state.operations.submit({
          ...moveIntent(),
          expectedRemoteFingerprint: closedFingerprint,
          targetStatus: 'backlog',
        }, ACTOR, new AbortController().signal)
        return { state, result, issueDispatches: 0 }
      },
      expected: {
        ok: false,
        reason: 'canceled',
        receipt: { state: 'canceled', reason: 'authority-revoked' },
      },
    },
    {
      name: 'Project binding rebound after Board admission inspection',
      exercise: async () => {
        const context = mutableMutationContext(CONTEXT)
        const state = harness(
          { ok: true, context: CONTEXT },
          true,
          { mutationContext: context.resolve },
        )
        let issueStateInspected = false
        let bindingRebound = false
        state.github.afterInspect = (kind) => {
          if (kind === 'issue-state-set') {
            issueStateInspected = true
            return
          }
          if (bindingRebound || kind !== 'project-item-status-set' || !issueStateInspected) return
          bindingRebound = true
          const projectId = githubProjectId('P_issue_state_rebound')
          context.replace({
            ...CONTEXT,
            configuration: githubSynchronizationConfigurationSchema.parse({
              ...CONFIGURATION,
              projectNodeId: projectId,
            }),
            confirmedBoard: {
              ...CONTEXT.confirmedBoard,
              project: { ...CONTEXT.confirmedBoard.project, id: projectId },
            },
          })
        }
        const result = await state.operations.submit(
          terminalMoveIntent(),
          ACTOR,
          new AbortController().signal,
        )
        return { state, result, issueDispatches: 0 }
      },
      expected: {
        ok: false,
        reason: 'conflict',
        receipt: { state: 'conflict', reason: 'mapping-repair-required' },
      },
    },
    {
      name: 'already-desired Issue with unavailable confirmation context',
      exercise: async () => {
        let contextUnavailable = false
        const state = harness({ ok: true, context: CONTEXT }, true, {
          mutationContext: () => contextUnavailable
            ? { ok: false, reason: 'unavailable', reasons: ['checkpoint-unavailable'] }
            : { ok: true, context: structuredClone(CONTEXT) },
        })
        let issueStateInspected = false
        state.github.afterInspect = (kind) => {
          if (kind === 'issue-state-set') {
            issueStateInspected = true
            return
          }
          if (kind !== 'project-item-status-set') return
          if (issueStateInspected) {
            contextUnavailable = true
            return
          }
          if (state.github.calls.includes('dispatch')) state.github.issueState = 'closed'
        }
        const result = await state.operations.submit(
          terminalMoveIntent(),
          ACTOR,
          new AbortController().signal,
        )
        return { state, result, issueDispatches: 0 }
      },
      expected: {
        ok: false,
        reason: 'conflict',
        receipt: { state: 'conflict', reason: 'stale-remote' },
      },
    },
    {
      name: 'final binding drift after full Board confirmation',
      exercise: async () => {
        const context = mutableMutationContext(CONTEXT)
        const state = harness(
          { ok: true, context: CONTEXT },
          true,
          { mutationContext: context.resolve },
        )
        state.github.afterInspect = () => {
          if (state.github.calls.at(-1) !== 'inspect'
            || !state.github.calls.includes('dispatch:issue-state')) return
          context.replace({
            ...CONTEXT,
            confirmedBoard: {
              ...CONTEXT.confirmedBoard,
              items: CONTEXT.confirmedBoard.items.map(item => item.id === WORK_ITEM_ID
                ? { ...item, source: { ...item.source, issueId: CREATED_ISSUE_ID } }
                : item),
            },
          })
        }
        const result = await state.operations.submit(
          terminalMoveIntent(),
          ACTOR,
          new AbortController().signal,
        )
        return { state, result, issueDispatches: 1 }
      },
      expected: {
        ok: false,
        reason: 'conflict',
        receipt: { state: 'conflict', reason: 'mapping-repair-required' },
      },
    },
  ])('resolves Issue-state admission when $name', async ({ exercise, expected }) => {
    const { state, result, issueDispatches } = await exercise()

    expect(result).toMatchObject(expected)
    expect(state.github.calls.filter(call => call === 'dispatch:issue-state'))
      .toHaveLength(issueDispatches)
    expect(requiredRecovery(state)).toMatchObject({
      confirmed: { observation: { stageKind: 'project-item-status-set' } },
    })
  })

  it('moves Status before closing a terminal Work Item and finishes from a full targeted observation', async () => {
    const state = harness()
    const terminalIntent = {
      ...moveIntent(),
      targetStatus: 'done',
    } as const satisfies MoveWorkItemIntent

    const result = await state.operations.submit(
      terminalIntent,
      ACTOR,
      new AbortController().signal,
    )

    expect(result).toMatchObject({
      ok: true,
      receipt: {
        state: 'succeeded',
        type: 'move-work-item',
        workItemId: WORK_ITEM_ID,
      },
    })
    expect(state.github.calls).toEqual([
      'inspect',
      'dispatch',
      'inspect',
      'inspect:issue-state',
      'inspect',
      'dispatch:issue-state',
      'inspect:issue-state',
      'inspect',
    ])
    expect(state.intentTable.get(INTENT_ID)).toMatchObject({
      phase: 'succeeded',
      stages: [
        { kind: 'project-item-status-set', state: 'confirmed', effectPossible: true },
        { kind: 'issue-state-set', state: 'confirmed', effectPossible: true },
      ],
      observedPrefix: [
        { stageKind: 'project-item-status-set' },
        { stageKind: 'issue-state-set', facts: { issue: { state: 'closed' } } },
      ],
      terminalEvidence: {
        kind: 'succeeded',
        confirmedObservation: {
          stageKind: 'project-item-status-set',
          facts: {
            issue: { state: 'closed' },
            membership: { item: { statusOptionId: CONFIGURATION.statusOptionNodeIds.done } },
          },
        },
      },
    })
    expect(state.recoveryTable.get(RECOVERY_ID)).toMatchObject({
      latestNonTerminalStatus: 'ready',
      confirmed: {
        observation: {
          facts: {
            issue: { state: 'closed' },
            membership: { item: { statusOptionId: CONFIGURATION.statusOptionNodeIds.done } },
          },
        },
      },
    })
    expect(state.operations.project(PROJECT_ID, CONTEXT.confirmedBoard, AVAILABLE, ALLOWED).mutationOverlays)
      .toMatchObject([{
        state: 'targeted-confirmed',
        workItem: { status: 'done', latestNonTerminalStatus: 'ready' },
      }])

    const unavailable = harness({
      ok: false,
      reason: 'unavailable',
      reasons: ['checkpoint-unavailable'],
    }, false, {
      intentTable: state.intentTable,
      recoveryTable: state.recoveryTable,
    })
    expect(unavailable.operations.project(PROJECT_ID, CONTEXT.confirmedBoard, AVAILABLE, ALLOWED)
      .mutationOverlays[0]).toMatchObject({
      workItem: { status: 'done', latestNonTerminalStatus: 'ready' },
    })
    expect(unavailable.operations.project(PROJECT_ID, undefined, AVAILABLE, ALLOWED)
      .mutationOverlays[0]).toMatchObject({
      workItem: { status: 'done', latestNonTerminalStatus: null },
    })
  })

  it('conflicts from a Board observation when Issue state reverses after dispatch returns', async () => {
    const state = harness()
    const intent = terminalMoveIntent()
    state.github.beforeDispatch = () => {
      if (state.github.calls.at(-1) !== 'dispatch:issue-state') return
      queueMicrotask(() => { state.github.issueState = 'open' })
    }

    const result = await state.operations.submit(intent, ACTOR, new AbortController().signal)
    const record = requiredIntent(state)
    const recovery = requiredRecovery(state)

    expect(result).toMatchObject({
      ok: false,
      reason: 'conflict',
      receipt: {
        state: 'conflict',
        reason: 'stale-remote',
        workItemId: WORK_ITEM_ID,
        remoteFingerprint: targetedBoardRemoteFingerprint(snapshot(
          CONFIGURATION.statusOptionNodeIds.done,
          'open',
        )),
      },
    })
    expect(state.github.calls).toEqual([
      'inspect',
      'dispatch',
      'inspect',
      'inspect:issue-state',
      'inspect',
      'dispatch:issue-state',
      'inspect:issue-state',
      'inspect',
    ])
    expect(record).toMatchObject({
      phase: 'conflict',
      stages: [
        { kind: 'project-item-status-set', state: 'confirmed', effectPossible: true },
        { kind: 'issue-state-set', state: 'dispatching', effectPossible: true },
      ],
      terminalEvidence: {
        kind: 'conflict',
        reason: 'stale-remote',
        confirmedObservation: {
          stageKind: 'project-item-status-set',
          facts: {
            issue: { state: 'open' },
            membership: { item: { statusOptionId: CONFIGURATION.statusOptionNodeIds.done } },
          },
        },
      },
    })
    if (record.terminalEvidence?.kind !== 'conflict'
      || record.terminalEvidence.confirmedObservation === undefined) {
      throw new Error('Issue-state reversal conflict fixture is missing')
    }
    expect(record.terminalEvidence.confirmedObservation).toEqual(recovery.confirmed.observation)
    expect(recovery.latestNonTerminalStatus).toBe('ready')
    expect(state.operations.project(
      PROJECT_ID,
      CONTEXT.confirmedBoard,
      AVAILABLE,
      ALLOWED,
    ).mutationOverlays).toMatchObject([{
      state: 'conflict',
      intentId: INTENT_ID,
      type: 'move-work-item',
      reason: 'stale-remote',
      workItem: {
        id: WORK_ITEM_ID,
        issueState: 'open',
        status: 'done',
        latestNonTerminalStatus: 'ready',
      },
    }])
    expect(() => state.operations.validateDurableState(new Set())).not.toThrow()
    const callsAtTerminal = [...state.github.calls]

    expect(await state.operations.submit(intent, ACTOR, new AbortController().signal)).toEqual(result)
    expect(state.github.calls).toEqual(callsAtTerminal)
  })

  it('resumes a terminal Issue-state stage after its first inspection is unavailable', async () => {
    const state = harness()
    const intent = terminalMoveIntent()
    let failureArmed = false
    state.github.afterInspect = (kind) => {
      if (failureArmed || kind !== 'project-item-status-set'
        || !state.github.calls.includes('dispatch')) return
      failureArmed = true
      state.github.inspectionFailure = { code: 'transient-transport' }
    }

    const first = await state.operations.submit(intent, ACTOR, new AbortController().signal)

    expect(first).toMatchObject({
      ok: false,
      reason: 'unavailable',
      receipt: {
        state: 'partial-failure',
        stage: 'issue-state-set',
        recoveryAction: { kind: 'resume-intent' },
      },
    })
    expect(requiredIntent(state)).toMatchObject({
      phase: 'partial-failure',
      stages: [
        { kind: 'project-item-status-set', state: 'confirmed', effectPossible: true },
        {
          kind: 'issue-state-set',
          state: 'failed',
          effectPossible: false,
          failure: { code: 'transient-transport' },
        },
      ],
    })
    expect(state.github.calls).toEqual([
      'inspect',
      'dispatch',
      'inspect',
      'inspect:issue-state',
    ])
    expect(state.github.calls).not.toContain('dispatch:issue-state')
    state.github.afterInspect = undefined

    const terminal = await state.operations.submit(intent, ACTOR, new AbortController().signal)

    expect(terminal).toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
    expect(state.github.calls.filter(call => call === 'dispatch:issue-state')).toHaveLength(1)
  })

  it('keeps an effect-possible Issue-state replay recoverable when Board admission inspection is unavailable', async () => {
    const state = harness()
    const intent = terminalMoveIntent()
    state.github.beforeDispatch = () => {
      if (state.github.calls.at(-1) !== 'dispatch:issue-state') return
      state.github.inspectFailures = 1
    }

    const first = await state.operations.submit(intent, ACTOR, new AbortController().signal)

    expect(first).toMatchObject({
      ok: false,
      reason: 'unavailable',
      receipt: {
        state: 'partial-failure',
        stage: 'issue-state-set',
        recoveryAction: { kind: 'inspect-before-retry' },
      },
    })
    expect(requiredIntent(state)).toMatchObject({
      phase: 'partial-failure',
      stages: [
        { kind: 'project-item-status-set', state: 'confirmed', effectPossible: true },
        { kind: 'issue-state-set', state: 'failed', effectPossible: true },
      ],
    })
    const recoveryBeforeReplay = structuredClone(requiredRecovery(state))
    const dispatchesBeforeReplay = state.github.calls.filter(call => call === 'dispatch:issue-state').length
    state.github.beforeDispatch = undefined
    state.github.afterInspect = () => {
      state.github.afterInspect = undefined
      state.github.inspectionFailure = { code: 'transient-transport' }
    }

    const replay = state.operations.submit(intent, ACTOR, new AbortController().signal)

    await expect(replay).resolves.toMatchObject({
      ok: false,
      reason: 'unavailable',
      receipt: {
        state: 'partial-failure',
        stage: 'issue-state-set',
        recoveryAction: { kind: 'inspect-before-retry' },
      },
    })
    expect(requiredIntent(state)).toMatchObject({
      phase: 'partial-failure',
      stages: [
        { kind: 'project-item-status-set', state: 'confirmed', effectPossible: true },
        {
          kind: 'issue-state-set',
          state: 'failed',
          effectPossible: true,
          failure: { code: 'transient-transport' },
        },
      ],
    })
    expect(requiredRecovery(state)).toEqual(recoveryBeforeReplay)
    expect(() => state.operations.validateDurableState(new Set())).not.toThrow()
    expect(state.github.calls.slice(-2)).toEqual(['inspect:issue-state', 'inspect'])
    expect(state.github.calls.filter(call => call === 'dispatch:issue-state'))
      .toHaveLength(dispatchesBeforeReplay)
  })

  it('keeps an expected Issue state recoverable when replay cannot inspect Board admission', async () => {
    const state = harness()
    const intent = terminalMoveIntent()
    state.github.beforeDispatch = () => {
      if (state.github.calls.at(-1) === 'dispatch:issue-state') {
        state.github.dispatchMode = 'fail-before-effect'
      }
    }

    const first = await state.operations.submit(intent, ACTOR, new AbortController().signal)

    expect(first).toMatchObject({
      ok: false,
      reason: 'unavailable',
      receipt: {
        state: 'partial-failure',
        stage: 'issue-state-set',
        recoveryAction: { kind: 'inspect-before-retry' },
      },
    })
    expect(state.github.calls.filter(call => call === 'dispatch:issue-state')).toHaveLength(1)
    state.github.beforeDispatch = undefined
    state.github.inspectionFailure = { code: 'transient-transport' }

    const inspectionUnavailable = await state.operations.submit(
      intent,
      ACTOR,
      new AbortController().signal,
    )

    expect(inspectionUnavailable).toMatchObject({
      ok: false,
      reason: 'unavailable',
      receipt: {
        state: 'partial-failure',
        stage: 'issue-state-set',
        recoveryAction: { kind: 'inspect-before-retry' },
      },
    })
    state.github.afterInspect = () => {
      if (state.github.calls.at(-1) !== 'inspect:issue-state') return
      state.github.afterInspect = undefined
      state.github.inspectionFailure = { code: 'transient-transport' }
    }

    const boardUnavailable = await state.operations.submit(
      intent,
      ACTOR,
      new AbortController().signal,
    )

    expect(boardUnavailable).toMatchObject({
      ok: false,
      reason: 'unavailable',
      receipt: {
        state: 'partial-failure',
        stage: 'issue-state-set',
        recoveryAction: { kind: 'inspect-before-retry' },
      },
    })
    expect(requiredIntent(state)).toMatchObject({
      phase: 'partial-failure',
      stages: [
        { kind: 'project-item-status-set', state: 'confirmed', effectPossible: true },
        { kind: 'issue-state-set', state: 'failed', effectPossible: true },
      ],
    })
    expect(state.github.calls.slice(-2)).toEqual(['inspect:issue-state', 'inspect'])
    expect(state.github.calls.filter(call => call === 'dispatch:issue-state')).toHaveLength(1)
  })

  it('reopens a terminal Work Item before restoring the backlog Status', async () => {
    const closedDone = snapshot(CONFIGURATION.statusOptionNodeIds.done, 'closed')
    const closedFingerprint = targetedBoardRemoteFingerprint(closedDone)
    const context: GitHubWorkItemMutationContext = {
      ...CONTEXT,
      confirmedBoard: {
        ...CONTEXT.confirmedBoard,
        items: [{
          ...CONTEXT.confirmedBoard.items[0]!,
          issueState: 'closed',
          status: 'done',
          latestNonTerminalStatus: null,
          remoteFingerprint: closedFingerprint,
        }],
      },
    }
    const state = harness({ ok: true, context })
    state.github.issueState = 'closed'
    state.github.statusOptionId = CONFIGURATION.statusOptionNodeIds.done
    const reopenIntent = {
      ...moveIntent(),
      expectedRemoteFingerprint: closedFingerprint,
      targetStatus: 'backlog',
    } as const satisfies MoveWorkItemIntent

    const result = await state.operations.submit(
      reopenIntent,
      ACTOR,
      new AbortController().signal,
    )

    expect(result).toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
    expect(state.github.calls).toEqual([
      'inspect:issue-state',
      'inspect',
      'dispatch:issue-state',
      'inspect:issue-state',
      'inspect',
      'inspect',
      'dispatch',
      'inspect',
    ])
    expect(state.intentTable.get(INTENT_ID)).toMatchObject({
      phase: 'succeeded',
      stages: [
        { kind: 'issue-state-set', state: 'confirmed', effectPossible: true },
        { kind: 'project-item-status-set', state: 'confirmed', effectPossible: true },
      ],
      observedPrefix: [
        { stageKind: 'issue-state-set', facts: { issue: { state: 'open' } } },
        {
          stageKind: 'project-item-status-set',
          facts: {
            issue: { state: 'open' },
            membership: { item: { statusOptionId: CONFIGURATION.statusOptionNodeIds.backlog } },
          },
        },
      ],
    })
    expect(state.recoveryTable.get(RECOVERY_ID)).toMatchObject({
      latestNonTerminalStatus: 'backlog',
      confirmed: {
        observation: {
          facts: {
            issue: { state: 'open' },
            membership: { item: { statusOptionId: CONFIGURATION.statusOptionNodeIds.backlog } },
          },
        },
      },
    })
  })

  it('continues a first-stage reopen that GitHub already completed without dispatching it again', async () => {
    const closedDone = snapshot(CONFIGURATION.statusOptionNodeIds.done, 'closed')
    const closedFingerprint = targetedBoardRemoteFingerprint(closedDone)
    const context: GitHubWorkItemMutationContext = {
      ...CONTEXT,
      confirmedBoard: {
        ...CONTEXT.confirmedBoard,
        items: [{
          ...CONTEXT.confirmedBoard.items[0]!,
          issueState: 'closed',
          status: 'done',
          latestNonTerminalStatus: null,
          remoteFingerprint: closedFingerprint,
        }],
      },
    }
    const state = harness({ ok: true, context })
    state.github.issueState = 'open'
    state.github.statusOptionId = CONFIGURATION.statusOptionNodeIds.done
    const intent = {
      ...moveIntent(),
      expectedRemoteFingerprint: closedFingerprint,
      targetStatus: 'backlog',
    } as const satisfies MoveWorkItemIntent

    const result = await state.operations.submit(intent, ACTOR, new AbortController().signal)

    expect(result).toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
    expect(state.github.calls).toEqual([
      'inspect:issue-state',
      'inspect',
      'inspect',
      'dispatch',
      'inspect',
    ])
    expect(state.github.calls).not.toContain('dispatch:issue-state')
    expect(requiredIntent(state)).toMatchObject({
      phase: 'succeeded',
      stages: [
        { kind: 'issue-state-set', state: 'confirmed', effectPossible: false },
        { kind: 'project-item-status-set', state: 'confirmed', effectPossible: true },
      ],
    })
  })

  it('restores the Board remembered Status after an external Issue reopen', async () => {
    const openDone = snapshot(CONFIGURATION.statusOptionNodeIds.done, 'open')
    const openDoneFingerprint = targetedBoardRemoteFingerprint(openDone)
    const context: GitHubWorkItemMutationContext = {
      ...CONTEXT,
      confirmedBoard: {
        ...CONTEXT.confirmedBoard,
        items: [{
          ...CONTEXT.confirmedBoard.items[0]!,
          issueState: 'open',
          status: 'done',
          latestNonTerminalStatus: 'in-review',
          remoteFingerprint: openDoneFingerprint,
        }],
      },
    }
    const state = harness({ ok: true, context })
    state.github.issueState = 'open'
    state.github.statusOptionId = CONFIGURATION.statusOptionNodeIds.done
    const restore = {
      ...moveIntent(),
      expectedRemoteFingerprint: openDoneFingerprint,
      targetStatus: 'in-review',
    } as const satisfies MoveWorkItemIntent

    expect(await state.operations.submit(
      restore,
      ACTOR,
      new AbortController().signal,
    )).toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
    expect(state.github.calls).toEqual(['inspect', 'dispatch', 'inspect'])
  })

  it('chains non-terminal and terminal moves from targeted recovery before the complete Board scan catches up', async () => {
    const state = harness()
    await state.operations.submit(moveIntent(), ACTOR, new AbortController().signal)
    const inProgressFingerprint = targetedBoardRemoteFingerprint(snapshot(
      CONFIGURATION.statusOptionNodeIds.inProgress,
    ))
    const secondIntent = {
      ...moveIntent(),
      intentId: SECOND_INTENT_ID,
      expectedRemoteFingerprint: inProgressFingerprint,
      targetStatus: 'in-review',
    } as const satisfies MoveWorkItemIntent

    const second = await state.operations.submit(secondIntent, ACTOR, new AbortController().signal)

    expect(second).toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
    const inReviewFingerprint = targetedBoardRemoteFingerprint(snapshot(
      CONFIGURATION.statusOptionNodeIds.inReview,
    ))
    const thirdIntent = {
      ...moveIntent(),
      intentId: THIRD_INTENT_ID,
      expectedRemoteFingerprint: inReviewFingerprint,
      targetStatus: 'done',
    } as const satisfies MoveWorkItemIntent
    const third = await state.operations.submit(thirdIntent, ACTOR, new AbortController().signal)

    expect(third).toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
    expect(() => state.operations.validateDurableState(new Set())).not.toThrow()
    expect(state.recoveryTable.get(RECOVERY_ID)).toMatchObject({
      latestNonTerminalStatus: 'in-review',
      confirmed: {
        sourceIntentId: THIRD_INTENT_ID,
        observation: { facts: { membership: { item: {
          statusOptionId: CONFIGURATION.statusOptionNodeIds.done,
        } } } },
      },
    })
    expect(state.operations.project(PROJECT_ID, CONTEXT.confirmedBoard, AVAILABLE, ALLOWED).mutationOverlays)
      .toMatchObject([{
        state: 'targeted-confirmed',
        intentId: THIRD_INTENT_ID,
        workItem: { id: WORK_ITEM_ID, status: 'done', latestNonTerminalStatus: 'in-review' },
      }])
    const restarted = harness({ ok: true, context: CONTEXT }, false, {
      intentTable: state.intentTable,
      recoveryTable: state.recoveryTable,
    })
    await restarted.operations.initializeValidated(restarted.operations.validateDurableState(new Set()))
    expect(restarted.scans).toEqual([PROJECT_ID])
  })

  it('ignores targeted recovery from the previously bound GitHub Project when preparing a move', async () => {
    const original = harness()
    await original.operations.submit(moveIntent(), ACTOR, new AbortController().signal)
    const reboundConfiguration = { ...CONFIGURATION, projectNodeId: githubProjectId('P_rebound') }
    const reboundContext: GitHubWorkItemMutationContext = {
      ...CONTEXT,
      configuration: reboundConfiguration,
      confirmedBoard: {
        ...CONTEXT.confirmedBoard,
        project: { ...CONTEXT.confirmedBoard.project, id: reboundConfiguration.projectNodeId },
      },
    }
    const rebound = harness({ ok: true, context: reboundContext }, false, {
      intentTable: original.intentTable,
      recoveryTable: original.recoveryTable,
    })
    const intent = {
      ...moveIntent(),
      intentId: SECOND_INTENT_ID,
      targetStatus: 'backlog',
    } as const satisfies MoveWorkItemIntent

    expect(await rebound.operations.submit(intent, ACTOR, new AbortController().signal))
      .toMatchObject({ ok: false, reason: 'unavailable', receipt: { state: 'prepared' } })
    expect(rebound.intentTable.get(SECOND_INTENT_ID)).toMatchObject({
      target: {
        projectId: reboundConfiguration.projectNodeId,
        source: { membership: 'present', status: 'ready', projectItemId: ITEM_ID },
      },
    })
  })

  it('accepts a recovery committed before its Status-stage transition and tolerates membership replacement', async () => {
    const state = harness()
    await state.operations.submit(moveIntent(), ACTOR, new AbortController().signal)
    const succeeded = state.intentTable.get(INTENT_ID)
    const recovery = state.recoveryTable.get(RECOVERY_ID)
    const statusStage = succeeded?.stages.find(stage => stage.kind === 'project-item-status-set')
    if (succeeded === undefined || recovery === undefined || statusStage === undefined) {
      throw new Error('successful Status fixtures are missing')
    }
    state.intentTable.values.set(INTENT_ID, githubWorkItemIntentRecordSchema.parse({
      ...succeeded,
      phase: 'running',
      stages: succeeded.stages.map(stage => stage.mutationId === statusStage.mutationId
        ? { ...stage, state: 'dispatching', effectPossible: true }
        : stage),
      observedPrefix: [],
      terminalEvidence: undefined,
    }))

    expect(() => state.operations.validateDurableState(new Set())).not.toThrow()
    const observation = recovery.confirmed.observation
    if (observation.stageKind !== 'project-item-status-set') {
      throw new Error('successful Status fixture has the wrong observation kind')
    }
    const absentFacts = { ...observation.facts, membership: { state: 'absent' as const } }
    state.recoveryTable.values.set(RECOVERY_ID, githubWorkItemRecoveryRecordSchema.parse({
      ...recovery,
      confirmed: {
        ...recovery.confirmed,
        observation: {
          ...observation,
          remoteFingerprint: targetedBoardRemoteFingerprint(absentFacts),
          facts: absentFacts,
        },
      },
    }))
    expect(() => state.operations.validateDurableState(new Set())).not.toThrow()

    const initial = snapshot(CONFIGURATION.statusOptionNodeIds.ready)
    if (initial.membership.state !== 'present') throw new Error('initial snapshot fixture lacks membership')
    const replacementFacts = {
      ...observation.facts,
      membership: {
        state: 'present' as const,
        item: {
          ...(observation.facts.membership.state === 'present'
            ? observation.facts.membership.item
            : initial.membership.item),
          id: REPLACEMENT_ITEM_ID,
        },
      },
    }
    state.recoveryTable.values.set(RECOVERY_ID, githubWorkItemRecoveryRecordSchema.parse({
      ...recovery,
      confirmed: {
        ...recovery.confirmed,
        observation: {
          ...observation,
          remoteFingerprint: targetedBoardRemoteFingerprint(replacementFacts),
          facts: replacementFacts,
        },
      },
    }))
    expect(() => state.operations.validateDurableState(new Set())).not.toThrow()
  })

  it('rejects recovery evidence that cannot be traced to the exact materialized Status target', async () => {
    const state = harness()
    await state.operations.submit(moveIntent(), ACTOR, new AbortController().signal)
    const source = state.intentTable.get(INTENT_ID)
    const recovery = state.recoveryTable.get(RECOVERY_ID)
    const observation = recovery?.confirmed.observation
    if (source === undefined || recovery === undefined || observation === undefined) {
      throw new Error('successful recovery fixtures are missing')
    }
    if (observation.stageKind !== 'project-item-status-set') {
      throw new Error('successful recovery fixture has the wrong observation kind')
    }
    const variants = [
      {
        ...observation,
        stageMutationId: githubWorkItemStageMutationId(SECOND_INTENT_ID, 'project-item-status-set'),
      },
      (() => {
        const facts = {
          ...observation.facts,
          repositoryDatabaseId: githubRepositoryDatabaseId('999'),
          issue: {
            ...observation.facts.issue,
            repositoryDatabaseId: githubRepositoryDatabaseId('999'),
          },
        }
        return { ...observation, facts, remoteFingerprint: targetedBoardRemoteFingerprint(facts) }
      })(),
      (() => {
        const facts = {
          ...observation.facts,
          projectId: githubProjectId('P_other'),
          membership: observation.facts.membership.state === 'present'
            ? {
              state: 'present' as const,
              item: { ...observation.facts.membership.item, projectId: githubProjectId('P_other') },
            }
            : observation.facts.membership,
        }
        return { ...observation, facts, remoteFingerprint: targetedBoardRemoteFingerprint(facts) }
      })(),
      (() => {
        const facts = { ...observation.facts, statusFieldId: githubProjectFieldId('F_other') }
        return { ...observation, facts, remoteFingerprint: targetedBoardRemoteFingerprint(facts) }
      })(),
    ]
    for (const variant of variants) {
      state.recoveryTable.values.set(RECOVERY_ID, githubWorkItemRecoveryRecordSchema.parse({
        ...recovery,
        confirmed: { ...recovery.confirmed, observation: variant },
      }))
      expect(() => state.operations.validateDurableState(new Set()))
        .toThrow('GitHub Work Item recovery source Intent disagrees with its scoped Work Item')
    }

    const statusStage = source.stages.find(stage => stage.kind === 'project-item-status-set')
    if (statusStage === undefined) throw new Error('Status stage fixture is missing')
    state.recoveryTable.values.set(RECOVERY_ID, recovery)
    state.intentTable.values.set(INTENT_ID, githubWorkItemIntentRecordSchema.parse({
      ...source,
      phase: 'prepared',
      stages: source.stages.map(stage => stage.mutationId === statusStage.mutationId
        ? {
          mutationId: stage.mutationId,
          kind: stage.kind,
          state: 'prepared',
          effectPossible: false,
        }
        : stage),
      observedPrefix: [],
      terminalEvidence: undefined,
    }))
    expect(() => state.operations.validateDurableState(new Set()))
      .toThrow('GitHub Work Item recovery source Intent disagrees with its scoped Work Item')
  })

  it('retains separate recovery rows when one GitHub Issue belongs to two Development Projects', async () => {
    const intentTable = new MemoryTable<SakiControlIntentId, GitHubWorkItemIntentRecord>()
    const recoveryTable = new MemoryTable<SakiWorkItemRecoveryId, GitHubWorkItemRecoveryRecord>()
    const projectIds = [PROJECT_ID, SECOND_PROJECT_ID]
    const first = harness({ ok: true, context: CONTEXT }, true, {
      intentTable,
      recoveryTable,
      projectIds,
    })
    await first.operations.submit(moveIntent(), ACTOR, new AbortController().signal)
    const second = harness({
      ok: true,
      context: { ...CONTEXT, projectId: SECOND_PROJECT_ID },
    }, true, {
      intentTable,
      recoveryTable,
      projectIds,
    })
    const secondProjectIntent = {
      ...moveIntent(),
      intentId: SECOND_INTENT_ID,
      projectId: SECOND_PROJECT_ID,
    } as const satisfies MoveWorkItemIntent

    expect(await second.operations.submit(
      secondProjectIntent,
      ACTOR,
      new AbortController().signal,
    )).toMatchObject({ ok: true, receipt: { state: 'succeeded' } })

    const firstRecoveryId = githubWorkItemRecoveryId(PROJECT_ID, WORK_ITEM_ID)
    const secondRecoveryId = githubWorkItemRecoveryId(SECOND_PROJECT_ID, WORK_ITEM_ID)
    expect(firstRecoveryId).not.toBe(secondRecoveryId)
    expect(recoveryTable.size).toBe(2)
    expect(recoveryTable.get(firstRecoveryId)).toMatchObject({ projectId: PROJECT_ID, workItemId: WORK_ITEM_ID })
    expect(recoveryTable.get(secondRecoveryId)).toMatchObject({
      projectId: SECOND_PROJECT_ID,
      workItemId: WORK_ITEM_ID,
    })
    expect(() => second.operations.validateDurableState(new Set())).not.toThrow()
  })

  it('conflicts from a newly confirmed remote fingerprint without dispatching', async () => {
    const state = harness()
    state.github.statusOptionId = CONFIGURATION.statusOptionNodeIds.backlog

    const result = await state.operations.submit(moveIntent(), ACTOR, new AbortController().signal)

    expect(result).toMatchObject({
      ok: false,
      reason: 'conflict',
      receipt: {
        state: 'conflict',
        reason: 'stale-remote',
        remoteFingerprint: targetedBoardRemoteFingerprint(snapshot(CONFIGURATION.statusOptionNodeIds.backlog)),
      },
    })
    expect(state.github.calls).toEqual(['inspect'])
    const record = requiredIntent(state)
    expect(record).toMatchObject({ phase: 'conflict' })
    expect(state.recoveryTable.get(RECOVERY_ID)).toMatchObject({
      latestNonTerminalStatus: 'backlog',
      confirmed: { observation: { facts: { membership: { item: { statusOptionId: CONFIGURATION.statusOptionNodeIds.backlog } } } } },
    })
    expect(() => state.operations.validateDurableState(new Set())).not.toThrow()
    expect(state.operations.project(PROJECT_ID, CONTEXT.confirmedBoard, AVAILABLE, ALLOWED).mutationOverlays)
      .toMatchObject([{
        state: 'conflict',
        intentId: INTENT_ID,
        type: 'move-work-item',
        reason: 'stale-remote',
        workItem: { id: WORK_ITEM_ID, status: 'backlog', latestNonTerminalStatus: 'backlog' },
      }])
    if (record.terminalEvidence?.kind !== 'conflict'
      || record.terminalEvidence.confirmedAt === undefined) {
      throw new Error('confirmed conflict fixture is missing')
    }
    expect(state.operations.project(
      PROJECT_ID,
      CONTEXT.confirmedBoard,
      AVAILABLE,
      ALLOWED,
      record.terminalEvidence.confirmedAt + 1,
    ).mutationOverlays).toEqual([])

    const newerCheckpoint = harness({
      ok: true,
      context: {
        ...CONTEXT,
        checkpointObservedAt: record.terminalEvidence.confirmedAt + 1,
      },
    }, false, {
      intentTable: state.intentTable,
      recoveryTable: state.recoveryTable,
    })
    await newerCheckpoint.operations.initializeValidated(
      newerCheckpoint.operations.validateDurableState(new Set()),
    )

    expect(newerCheckpoint.scans).toEqual([])
    expect(newerCheckpoint.github.calls).toEqual([])
  })

  it.each([
    {
      name: 'an absent Project membership as an Inbox Work Item',
      arrange: (state: Harness) => { state.github.inProject = false },
      projectsWorkItem: true,
      expectedStatus: 'inbox',
      expectedLatestNonTerminalStatus: 'inbox',
      notInProject: true,
    },
    {
      name: 'an unmapped Status option without a projected Work Item',
      arrange: (state: Harness) => { state.github.statusOptionId = githubProjectOptionId('O_unmapped') },
      projectsWorkItem: false,
      expectedStatus: undefined,
      expectedLatestNonTerminalStatus: undefined,
      notInProject: undefined,
    },
    {
      name: 'a missing Status option without a projected Work Item',
      arrange: (state: Harness) => { state.github.statusOptionMissing = true },
      projectsWorkItem: false,
      expectedStatus: undefined,
      expectedLatestNonTerminalStatus: undefined,
      notInProject: undefined,
    },
    {
      name: 'an unarchived canceled option as a canceled Work Item',
      arrange: (state: Harness) => {
        state.github.statusOptionId = CONFIGURATION.statusOptionNodeIds.canceled
      },
      projectsWorkItem: true,
      expectedStatus: 'canceled',
      expectedLatestNonTerminalStatus: null,
      notInProject: false,
    },
    {
      name: 'an archived membership as a canceled Work Item',
      arrange: (state: Harness) => { state.github.archived = true },
      projectsWorkItem: true,
      expectedStatus: 'canceled',
      expectedLatestNonTerminalStatus: null,
      notInProject: false,
    },
  ])('degrades $name from terminal conflict evidence without dispatching', async ({
    arrange,
    projectsWorkItem,
    expectedStatus,
    expectedLatestNonTerminalStatus,
    notInProject,
  }) => {
    const state = harness()
    arrange(state)

    expect(await state.operations.submit(moveIntent(), ACTOR, new AbortController().signal))
      .toMatchObject({ ok: false, reason: 'conflict', receipt: { reason: 'stale-remote' } })
    expect(state.github.calls).toEqual(['inspect'])
    const overlays = state.operations.project(PROJECT_ID, CONTEXT.confirmedBoard, AVAILABLE, ALLOWED)
      .mutationOverlays
    expect(overlays).toHaveLength(1)
    expect(overlays[0]).toMatchObject({
      state: 'conflict',
      intentId: INTENT_ID,
      type: 'move-work-item',
      reason: 'stale-remote',
    })
    if (!projectsWorkItem) {
      expect(overlays[0]).not.toHaveProperty('workItem')
      return
    }
    expect(overlays[0]).toMatchObject({
      workItem: {
        id: WORK_ITEM_ID,
        status: expectedStatus,
        latestNonTerminalStatus: expectedLatestNonTerminalStatus,
        order: 0,
        notInProject,
        source: { kind: 'github-issue', repositoryId: CONFIGURATION.repositoryNodeId, issueId: ISSUE_ID },
      },
    })
    if (notInProject) {
      expect(overlays[0]).not.toHaveProperty('workItem.source.projectItemId')
      const boardWithoutTarget = {
        ...POSITION_CONTEXT.confirmedBoard,
        items: [POSITION_CONTEXT.confirmedBoard.items[1]!],
      }
      expect(state.operations.project(PROJECT_ID, boardWithoutTarget, AVAILABLE, ALLOWED)
        .mutationOverlays[0]).toMatchObject({ workItem: { order: 1 } })
      expect(state.operations.project(PROJECT_ID, undefined, AVAILABLE, ALLOWED)
        .mutationOverlays[0]).toMatchObject({ workItem: { order: 0 } })
    }
  })

  it('retries a Create Status after a known pre-effect dispatch failure', async () => {
    const state = harness()
    state.github.beforeDispatch = (kind) => {
      if (kind === 'project-item-status-set') state.github.dispatchMode = 'fail-before-effect'
    }

    const partial = await state.operations.submit(createIntent(), ACTOR, new AbortController().signal)

    expect(partial).toMatchObject({
      ok: false,
      reason: 'unavailable',
      receipt: {
        state: 'partial-failure',
        stage: 'project-item-status-set',
        recoveryAction: { kind: 'inspect-before-retry' },
      },
    })
    expect(requiredIntent(state)).toMatchObject({
      phase: 'partial-failure',
      stages: [
        { kind: 'issue-create', state: 'confirmed' },
        { kind: 'project-item-add', state: 'confirmed' },
        { kind: 'project-item-status-set', state: 'failed', effectPossible: true },
      ],
    })
    expect([...state.recoveryTable.entries()].map(([, recovery]) => recovery)).toMatchObject([{
      confirmed: {
        sourceIntentId: INTENT_ID,
        observation: { stageKind: 'project-item-status-set' },
      },
    }])

    state.github.beforeDispatch = undefined
    state.github.dispatchMode = 'success'
    expect(await state.operations.submit(createIntent(), ACTOR, new AbortController().signal))
      .toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
    expect(state.github.calls.filter(call => call === 'dispatch')).toHaveLength(2)
  })

  it('accepts an externally reached desired Status as an idempotent no-effect success', async () => {
    const state = harness()
    state.github.statusOptionId = CONFIGURATION.statusOptionNodeIds.inProgress

    const result = await state.operations.submit(moveIntent(), ACTOR, new AbortController().signal)

    expect(result).toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
    expect(state.github.calls).toEqual(['inspect'])
    expect(state.intentTable.get(INTENT_ID)).toMatchObject({
      phase: 'succeeded',
      stages: [{ state: 'confirmed', effectPossible: false }],
    })
  })

  it('accepts an already-desired targeted state without admitting a possible effect', async () => {
    const desiredSnapshot = snapshot(CONFIGURATION.statusOptionNodeIds.inProgress)
    const desiredFingerprint = targetedBoardRemoteFingerprint(desiredSnapshot)
    const state = harness({
      ok: true,
      context: {
        ...CONTEXT,
        confirmedBoard: {
          ...CONTEXT.confirmedBoard,
          items: [{
            ...CONTEXT.confirmedBoard.items[0]!,
            status: 'in-progress',
            latestNonTerminalStatus: 'in-progress',
            remoteFingerprint: desiredFingerprint,
          }],
        },
      },
    })
    state.github.statusOptionId = CONFIGURATION.statusOptionNodeIds.inProgress
    const alreadyDesired = {
      ...moveIntent(),
      expectedRemoteFingerprint: desiredFingerprint,
    }

    const result = await state.operations.submit(alreadyDesired, ACTOR, new AbortController().signal)

    expect(result).toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
    expect(state.github.calls).toEqual(['inspect'])
    expect(state.intentTable.get(INTENT_ID)).toMatchObject({
      phase: 'succeeded',
      stages: [{ state: 'confirmed', effectPossible: false }],
    })
    expect(state.intentTable.get(INTENT_ID)?.stages[0]).not.toHaveProperty('receipt')
  })

  it('inspects a lost dispatch acknowledgement and never duplicates the successful effect', async () => {
    const state = harness()
    state.github.dispatchMode = 'mutate-then-fail'

    const first = await state.operations.submit(moveIntent(), ACTOR, new AbortController().signal)
    const callsAfterFirst = [...state.github.calls]
    const replay = await state.operations.submit(moveIntent(), ACTOR, new AbortController().signal)
    const changedPayload = await state.operations.submit(
      { ...moveIntent(), targetStatus: 'backlog' },
      ACTOR,
      new AbortController().signal,
    )

    expect(first).toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
    expect(callsAfterFirst).toEqual(['inspect', 'dispatch', 'inspect'])
    expect(replay).toEqual(first)
    expect(state.github.calls).toEqual(callsAfterFirst)
    expect(changedPayload).toEqual({ ok: false, reason: 'conflict' })
  })

  it('rejects a second active Intent for the same project Work Item without canceling the first', async () => {
    const state = harness({ ok: true, context: CONTEXT }, false)
    const first = await state.operations.submit(moveIntent(), ACTOR, new AbortController().signal)
    const secondIntent = { ...moveIntent(), intentId: SECOND_INTENT_ID }

    const second = await state.operations.submit(secondIntent, ACTOR, new AbortController().signal)

    expect(first).toMatchObject({ ok: false, receipt: { state: 'prepared' } })
    expect(second).toEqual({ ok: false, reason: 'conflict' })
    expect(second).not.toHaveProperty('receipt')
    expect(state.intentTable.get(INTENT_ID)).toMatchObject({ phase: 'prepared' })
    expect(state.intentTable.get(SECOND_INTENT_ID)).toBeUndefined()
  })

  it('rejects historical duplicate active Intents for one project Work Item', async () => {
    const state = harness({ ok: true, context: CONTEXT }, false)
    await state.operations.submit(moveIntent(), ACTOR, new AbortController().signal)
    const first = state.intentTable.get(INTENT_ID)
    if (first === undefined) throw new Error('prepared Work Item Intent fixture is missing')
    const intent = { ...first.payload.intent, intentId: SECOND_INTENT_ID }
    const payload = { ...first.payload, intent }
    const second = githubWorkItemIntentRecordSchema.parse({
      ...first,
      id: SECOND_INTENT_ID,
      receiptId: sakiIntentReceiptIdSchema.parse(String(SECOND_INTENT_ID).replace(/^intent-/u, 'receipt-')),
      payload,
      payloadDigest: canonicalDigest('saki/github-work-item-intent/v1', payload),
      stages: first.stages.map(stage => ({
        ...stage,
        mutationId: githubWorkItemStageMutationId(SECOND_INTENT_ID, stage.kind),
      })),
    })
    state.intentTable.values.set(SECOND_INTENT_ID, second)

    expect(() => state.operations.validateDurableState(new Set()))
      .toThrow('multiple active GitHub Work Item Intents target one Work Item')
  })

  it('orders equal-millisecond durable Create Intents and overlays by Intent id', async () => {
    const state = harness({ ok: true, context: CONTEXT }, false)
    const secondIntent = {
      ...createIntent(),
      intentId: SECOND_INTENT_ID,
      title: 'Second deterministic Create',
    } as const satisfies CreateWorkItemIntent
    await state.operations.submit(createIntent(), ACTOR, new AbortController().signal)
    await state.operations.submit(secondIntent, ACTOR, new AbortController().signal)
    const first = requiredIntent(state)
    const second = requiredIntent(state, SECOND_INTENT_ID)
    const createdAt = Math.max(first.createdAt, second.createdAt)
    const sameMillisecondFirst = githubWorkItemIntentRecordSchema.parse({ ...first, createdAt, updatedAt: createdAt })
    const sameMillisecondSecond = githubWorkItemIntentRecordSchema.parse({ ...second, createdAt, updatedAt: createdAt })
    state.intentTable.values.clear()
    state.intentTable.values.set(SECOND_INTENT_ID, sameMillisecondSecond)
    state.intentTable.values.set(INTENT_ID, sameMillisecondFirst)

    expect(state.operations.validateDurableState(new Set()).intents.map(record => record.id))
      .toEqual([INTENT_ID, SECOND_INTENT_ID])
    expect(state.operations.project(PROJECT_ID, CONTEXT.confirmedBoard, AVAILABLE, ALLOWED).mutationOverlays)
      .toMatchObject([{ intentId: INTENT_ID }, { intentId: SECOND_INTENT_ID }])
  })

  it('allows the same GitHub Issue to have active Intents in separate Development Projects', async () => {
    const intentTable = new MemoryTable<SakiControlIntentId, GitHubWorkItemIntentRecord>()
    const recoveryTable = new MemoryTable<SakiWorkItemRecoveryId, GitHubWorkItemRecoveryRecord>()
    const projectIds = [PROJECT_ID, SECOND_PROJECT_ID]
    const first = harness({ ok: true, context: CONTEXT }, false, {
      intentTable,
      recoveryTable,
      projectIds,
    })
    await first.operations.submit(moveIntent(), ACTOR, new AbortController().signal)
    const second = harness({
      ok: true,
      context: { ...CONTEXT, projectId: SECOND_PROJECT_ID },
    }, false, {
      intentTable,
      recoveryTable,
      projectIds,
    })
    const secondIntent = {
      ...moveIntent(),
      intentId: SECOND_INTENT_ID,
      projectId: SECOND_PROJECT_ID,
    }

    expect(await second.operations.submit(secondIntent, ACTOR, new AbortController().signal))
      .toMatchObject({ ok: false, receipt: { state: 'prepared' } })
    expect(intentTable.get(INTENT_ID)).toMatchObject({ phase: 'prepared' })
    expect(intentTable.get(SECOND_INTENT_ID)).toMatchObject({ phase: 'prepared' })
    expect(first.operations.project(
      PROJECT_ID,
      CONTEXT.confirmedBoard,
      AVAILABLE,
      ALLOWED,
    ).mutationOverlays).toEqual([{
      state: 'optimistic',
      intentId: INTENT_ID,
      type: 'move-work-item',
      workItemId: WORK_ITEM_ID,
      targetStatus: 'in-progress',
    }])
    expect(second.operations.project(
      SECOND_PROJECT_ID,
      CONTEXT.confirmedBoard,
      AVAILABLE,
      ALLOWED,
    ).mutationOverlays).toEqual([{
      state: 'optimistic',
      intentId: SECOND_INTENT_ID,
      type: 'move-work-item',
      workItemId: WORK_ITEM_ID,
      targetStatus: 'in-progress',
    }])
    expect(() => second.operations.validateDurableState(new Set())).not.toThrow()
  })

  it('keeps an unknown effect recoverable, then confirms it by inspection on replay', async () => {
    const state = harness()
    state.github.dispatchMode = 'mutate-then-fail'
    state.github.dispatchFailure = {
      code: 'invalid-external-response',
      operation: 'project-item-status-set',
    }
    state.github.beforeDispatch = () => { state.github.inspectFailures = 1 }

    const partial = await state.operations.submit(moveIntent(), ACTOR, new AbortController().signal)
    expect(partial).toMatchObject({
      ok: false,
      reason: 'unavailable',
      receipt: {
        state: 'partial-failure',
        stage: 'project-item-status-set',
        recoveryAction: { kind: 'inspect-before-retry' },
      },
    })
    expect(requiredIntent(state)).toMatchObject({
      phase: 'partial-failure',
      stages: [{
        kind: 'project-item-status-set',
        state: 'failed',
        effectPossible: true,
        failure: {
          code: 'invalid-external-response',
          operation: 'project-item-status-set',
        },
      }],
    })
    expect(state.recoveryTable.get(RECOVERY_ID)).toMatchObject({
      latestNonTerminalStatus: 'ready',
      confirmed: { observation: { workItemId: WORK_ITEM_ID } },
    })
    expect(state.operations.project(PROJECT_ID, CONTEXT.confirmedBoard, AVAILABLE, ALLOWED).mutationOverlays)
      .toEqual([{
        state: 'partial-failure',
        intentId: INTENT_ID,
        type: 'move-work-item',
        workItemId: WORK_ITEM_ID,
        stage: 'project-item-status-set',
        recoveryAction: { kind: 'inspect-before-retry' },
      }])
    expect(state.github.calls).toEqual(['inspect', 'dispatch', 'inspect'])

    state.github.beforeDispatch = undefined
    const recovered = await state.operations.submit(moveIntent(), ACTOR, new AbortController().signal)

    expect(recovered).toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
    expect(state.github.calls).toEqual(['inspect', 'dispatch', 'inspect', 'inspect'])
  })

  it('keeps an unknown Status effect recoverable before reporting later remote drift', async () => {
    const state = harness()
    state.github.dispatchMode = 'mutate-then-fail'
    state.github.beforeDispatch = () => { state.github.inspectFailures = 1 }

    const first = await state.operations.submit(moveIntent(), ACTOR, new AbortController().signal)

    expect(first).toMatchObject({
      ok: false,
      reason: 'unavailable',
      receipt: {
        state: 'partial-failure',
        stage: 'project-item-status-set',
        recoveryAction: { kind: 'inspect-before-retry' },
      },
    })
    expect(requiredIntent(state)).toMatchObject({
      phase: 'partial-failure',
      stages: [{
        kind: 'project-item-status-set',
        state: 'failed',
        effectPossible: true,
      }],
    })

    state.github.beforeDispatch = undefined
    state.github.inspectFailures = 1
    const replay = await state.operations.submit(moveIntent(), ACTOR, new AbortController().signal)

    expect(replay).toMatchObject({
      ok: false,
      reason: 'unavailable',
      receipt: {
        state: 'partial-failure',
        stage: 'project-item-status-set',
        recoveryAction: { kind: 'inspect-before-retry' },
      },
    })

    state.github.statusOptionId = CONFIGURATION.statusOptionNodeIds.backlog
    const drifted = await state.operations.submit(moveIntent(), ACTOR, new AbortController().signal)

    expect(drifted).toMatchObject({
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'stale-remote' },
    })
    expect(requiredIntent(state)).toMatchObject({
      phase: 'conflict',
      terminalEvidence: { kind: 'conflict', reason: 'stale-remote' },
    })
    expect(state.github.calls.filter(call => call === 'dispatch')).toHaveLength(1)
  })

  it('rejects a retained Status retry after its active option binding drifts', async () => {
    const context = mutableMutationContext(CONTEXT)
    const state = harness(
      { ok: true, context: CONTEXT },
      true,
      { mutationContext: context.resolve },
    )
    state.github.dispatchMode = 'fail-before-effect'
    state.github.beforeDispatch = () => { state.github.inspectFailures = 1 }

    const partial = await state.operations.submit(moveIntent(), ACTOR, new AbortController().signal)

    expect(partial).toMatchObject({
      ok: false,
      receipt: {
        state: 'partial-failure',
        stage: 'project-item-status-set',
        recoveryAction: { kind: 'inspect-before-retry' },
      },
    })
    expect(requiredIntent(state)).toMatchObject({
      phase: 'partial-failure',
      stages: [{
        kind: 'project-item-status-set',
        state: 'failed',
        effectPossible: true,
      }],
    })
    expect(state.github.calls.filter(call => call === 'dispatch')).toHaveLength(1)

    context.replace({
      ...CONTEXT,
      mappingRevision: CONTEXT.mappingRevision + 1,
      configuration: githubSynchronizationConfigurationSchema.parse({
        ...CONFIGURATION,
        statusOptionNodeIds: {
          ...CONFIGURATION.statusOptionNodeIds,
          inProgress: 'O_in_progress_rebound',
        },
      }),
      confirmedBoard: {
        ...CONTEXT.confirmedBoard,
        configurationRevision: CONTEXT.confirmedBoard.configurationRevision + 1,
      },
    })
    state.github.beforeDispatch = undefined
    const replay = await state.operations.submit(moveIntent(), ACTOR, new AbortController().signal)

    expect(replay).toMatchObject({
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'mapping-repair-required' },
    })
    expect(state.github.calls.filter(call => call === 'dispatch')).toHaveLength(1)
  })

  it('inspects an effect-possible stage after authority revocation before deciding its outcome', async () => {
    const effected = harness()
    effected.github.dispatchMode = 'mutate-then-fail'
    effected.github.beforeDispatch = () => { effected.github.inspectFailures = 1 }
    await effected.operations.submit(moveIntent(), ACTOR, new AbortController().signal)
    effected.authority.current = false

    expect(await effected.operations.submit(moveIntent(), ACTOR, new AbortController().signal)).toMatchObject({
      ok: true,
      receipt: { state: 'succeeded' },
    })
    expect(effected.github.calls).toEqual(['inspect', 'dispatch', 'inspect', 'inspect'])

    const untouched = harness()
    untouched.github.dispatchMode = 'fail-before-effect'
    untouched.github.beforeDispatch = () => { untouched.github.inspectFailures = 1 }
    await untouched.operations.submit(moveIntent(), ACTOR, new AbortController().signal)
    untouched.authority.current = false

    expect(await untouched.operations.submit(moveIntent(), ACTOR, new AbortController().signal)).toMatchObject({
      ok: false,
      reason: 'canceled',
      receipt: { state: 'canceled', reason: 'authority-revoked' },
    })
    expect(untouched.github.calls).toEqual(['inspect', 'dispatch', 'inspect', 'inspect'])
  })

  it('rechecks authority after targeted pre-inspection and before admitting an effect', async () => {
    const state = harness()
    state.github.afterInspect = () => { state.authority.current = false }

    const result = await state.operations.submit(moveIntent(), ACTOR, new AbortController().signal)

    expect(result).toMatchObject({
      ok: false,
      reason: 'canceled',
      receipt: { state: 'canceled', reason: 'authority-revoked' },
    })
    expect(state.github.calls).toEqual(['inspect'])
    expect(requiredIntent(state)).toMatchObject({
      phase: 'canceled',
      stages: [{ state: 'prepared', effectPossible: false }],
      terminalEvidence: { kind: 'canceled', reason: 'authority-revoked' },
    })
    expect(state.recoveryTable.size).toBe(0)
    expect(state.operations.project(
      PROJECT_ID,
      CONTEXT.confirmedBoard,
      AVAILABLE,
      ALLOWED,
    ).mutationOverlays).toEqual([])
  })

  it.each([
    {
      name: 'mapping context drifts',
      drift: (): GitHubWorkItemMutationContextResult => ({
        ok: true,
        context: {
          ...CONTEXT,
          configuration: githubSynchronizationConfigurationSchema.parse({
            ...CONFIGURATION,
            statusOptionNodeIds: { ...CONFIGURATION.statusOptionNodeIds, inProgress: 'O_rebound' },
          }),
        },
      }),
    },
    {
      name: 'mutation context becomes unavailable',
      drift: (): GitHubWorkItemMutationContextResult => ({
        ok: false,
        reason: 'unavailable',
        reasons: ['checkpoint-unavailable'],
      }),
    },
  ])('rejects Status admission when $name after inspection', async ({ drift }) => {
    let current: GitHubWorkItemMutationContextResult = { ok: true, context: CONTEXT }
    const state = harness(current, true, { mutationContext: () => structuredClone(current) })
    state.github.afterInspect = () => { current = drift() }

    const result = await state.operations.submit(moveIntent(), ACTOR, new AbortController().signal)

    expect(result).toMatchObject({
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'mapping-repair-required' },
    })
    expect(state.github.calls).toEqual(['inspect'])
  })

  it('persists final targeted recovery before a terminal Intent transition', async () => {
    const state = harness()
    let failureArmed = false
    state.github.afterInspect = (kind) => {
      if (failureArmed || kind !== 'project-item-status-set'
        || !state.github.calls.includes('dispatch')) return
      failureArmed = true
      state.intentTable.failNextUpdate = new Error('terminal transition crash')
    }

    await expect(state.operations.submit(moveIntent(), ACTOR, new AbortController().signal))
      .rejects.toThrow('terminal transition crash')
    expect(state.intentTable.get(INTENT_ID)).toMatchObject({ phase: 'running' })
    expect(state.recoveryTable.get(RECOVERY_ID)).toMatchObject({
      confirmed: { observation: { facts: { membership: { item: {
        statusOptionId: CONFIGURATION.statusOptionNodeIds.inProgress,
      } } } } },
    })

    state.github.afterInspect = undefined
    expect(await state.operations.submit(moveIntent(), ACTOR, new AbortController().signal)).toMatchObject({
      ok: true,
      receipt: { state: 'succeeded' },
    })
  })

  it('rejects terminal evidence that disagrees with targeted recovery state', async () => {
    const state = harness()
    await state.operations.submit(moveIntent(), ACTOR, new AbortController().signal)
    const recovery = state.recoveryTable.get(RECOVERY_ID)
    if (recovery === undefined) throw new Error('recovery fixture is missing')
    const staleFacts = snapshot(CONFIGURATION.statusOptionNodeIds.ready)
    const staleFingerprint = targetedBoardRemoteFingerprint(staleFacts)
    const current = recovery.confirmed?.observation
    if (current === undefined) throw new Error('confirmed recovery fixture is missing')
    if (current.stageKind !== 'project-item-status-set') {
      throw new Error('confirmed recovery fixture has the wrong observation kind')
    }
    state.recoveryTable.values.set(RECOVERY_ID, {
      ...recovery,
      confirmed: {
        ...recovery.confirmed,
        observation: {
          ...current,
          remoteFingerprint: staleFingerprint,
          facts: staleFacts,
        },
      },
    })

    expect(() => state.operations.validateDurableState(new Set()))
      .toThrow('terminal GitHub Work Item evidence disagrees with targeted recovery')
  })

  it('persists while the optional provider is absent and resumes when it attaches', async () => {
    const state = harness({ ok: true, context: CONTEXT }, false)

    const pending = await state.operations.submit(moveIntent(), ACTOR, new AbortController().signal)
    expect(pending).toMatchObject({ ok: false, reason: 'unavailable', receipt: { state: 'prepared' } })
    expect(state.intentTable.get(INTENT_ID)).toMatchObject({ phase: 'prepared' })
    expect(state.github.calls).toEqual([])

    state.operations.attach(state.github)
    await state.operations.dispose()

    expect(state.intentTable.get(INTENT_ID)).toMatchObject({ phase: 'succeeded' })
    expect(state.github.calls).toEqual(['inspect', 'dispatch', 'inspect'])
  })

  it('records a pre-effect inspection failure with a safe resume action', async () => {
    const state = harness()
    state.github.inspectFailures = 1

    const result = await state.operations.submit(moveIntent(), ACTOR, new AbortController().signal)

    expect(result).toMatchObject({
      ok: false,
      reason: 'unavailable',
      receipt: {
        state: 'partial-failure',
        stage: 'project-item-status-set',
        recoveryAction: { kind: 'resume-intent' },
      },
    })
    expect(requiredIntent(state)).toMatchObject({
      phase: 'partial-failure',
      stages: [{
        kind: 'project-item-status-set',
        state: 'failed',
        effectPossible: false,
        failure: { code: 'transient-transport' },
      }],
    })
    expect(state.recoveryTable.size).toBe(0)
    expect(state.github.calls).toEqual(['inspect'])
    expect(state.operations.project(
      PROJECT_ID,
      CONTEXT.confirmedBoard,
      AVAILABLE,
      ALLOWED,
    ).mutationOverlays).toEqual([{
      state: 'partial-failure',
      intentId: INTENT_ID,
      type: 'move-work-item',
      workItemId: WORK_ITEM_ID,
      stage: 'project-item-status-set',
      recoveryAction: { kind: 'resume-intent' },
    }])

    expect(await state.operations.submit(moveIntent(), ACTOR, new AbortController().signal))
      .toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
    expect(state.github.calls).toEqual(['inspect', 'inspect', 'dispatch', 'inspect'])
  })

  it.each(mappingRepairFailureScenarios)(
    'surfaces $name as one durable operator mapping repair reason',
    async ({ failure, reason }) => {
      const state = harness()
      const intent = moveIntent()
      state.github.inspectionFailure = failure

      const result = await state.operations.submit(intent, ACTOR, new AbortController().signal)

      expect(result).toMatchObject({
        ok: false,
        reason: 'unavailable',
        receipt: {
          state: 'partial-failure',
          stage: 'project-item-status-set',
          recoveryAction: { kind: 'repair-mapping', reason },
        },
      })
      expect(requiredIntent(state)).toMatchObject({
        phase: 'partial-failure',
        stages: [{
          kind: 'project-item-status-set',
          state: 'failed',
          effectPossible: false,
          failure,
        }],
      })
      expect(state.recoveryTable.size).toBe(0)
      expect(state.github.calls).toEqual(['inspect'])
      expect(state.operations.project(
        PROJECT_ID,
        CONTEXT.confirmedBoard,
        AVAILABLE,
        ALLOWED,
      ).mutationOverlays).toEqual([{
        state: 'partial-failure',
        intentId: INTENT_ID,
        type: 'move-work-item',
        workItemId: WORK_ITEM_ID,
        stage: 'project-item-status-set',
        recoveryAction: { kind: 'repair-mapping', reason },
      }])
      expect(() => state.operations.validateDurableState(new Set())).not.toThrow()
      const callsAtTerminal = [...state.github.calls]

      expect(await state.operations.submit(intent, ACTOR, new AbortController().signal)).toEqual(result)
      expect(state.github.calls).toEqual(callsAtTerminal)
    },
  )

  it('stops automatic retries when pre-effect inspection proves a durable mapping repair is required', async () => {
    const state = harness()
    state.github.inspectionFailure = { code: 'not-found', resource: 'project-item' }

    const result = await state.operations.submit(moveIntent(), ACTOR, new AbortController().signal)

    expect(result).toMatchObject({
      ok: false,
      reason: 'unavailable',
      receipt: {
        state: 'partial-failure',
        stage: 'project-item-status-set',
        recoveryAction: { kind: 'repair-mapping', reason: 'not-found:project-item' },
      },
    })
    expect(requiredIntent(state)).toMatchObject({
      phase: 'partial-failure',
      stages: [{
        kind: 'project-item-status-set',
        state: 'failed',
        effectPossible: false,
        failure: { code: 'not-found', resource: 'project-item' },
      }],
    })
    expect(state.recoveryTable.size).toBe(0)
    expect(state.github.calls).toEqual(['inspect'])
    expect(state.operations.project(
      PROJECT_ID,
      CONTEXT.confirmedBoard,
      AVAILABLE,
      ALLOWED,
    ).mutationOverlays).toEqual([{
      state: 'partial-failure',
      intentId: INTENT_ID,
      type: 'move-work-item',
      workItemId: WORK_ITEM_ID,
      stage: 'project-item-status-set',
      recoveryAction: { kind: 'repair-mapping', reason: 'not-found:project-item' },
    }])
    expect(await state.operations.submit(moveIntent(), ACTOR, new AbortController().signal))
      .toEqual(result)
    expect(state.github.calls).toEqual(['inspect'])
  })
})
