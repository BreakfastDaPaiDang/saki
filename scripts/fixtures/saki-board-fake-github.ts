/** Deterministic keyless GitHub Provider for the assembled Saki Board snapshot. */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  GitHubProviderError,
  SakiGitHub,
  computeGitHubProjectBoardFingerprint,
  githubAccountId,
  githubCommitId,
  githubCommitStatusId,
  githubInstallationId,
  githubIssueId,
  githubMilestoneId,
  githubProjectBoardScanCandidateSchema,
  githubProjectFieldId,
  githubProjectId,
  githubProjectItemId,
  githubProjectOptionId,
  githubPullRequestId,
  githubPullRequestReviewId,
  githubReleaseId,
  githubReleaseTagName,
  githubRepositoryDatabaseId,
  githubRepositoryId,
  githubWorkflowId,
  githubWorkflowRunId,
} from '@breakfastdapaidang/saki-github'
import type {
  GitHubCommitCiFact,
  GitHubInstallationFact,
  GitHubInstallationProfile,
  GitHubIssueFact,
  GitHubIssueStateSetRequest,
  GitHubMutationMap,
  GitHubProjectBoardFingerprintSource,
  GitHubProjectBoardScanRequest,
  GitHubProjectItemStatusSetInspection,
  GitHubProjectItemStatusSetRequest,
  GitHubProjectFact,
  GitHubProjectOptionId,
  GitHubPullRequestCreateRequest,
  GitHubPullRequestFact,
  GitHubPullRequestReviewsFact,
  GitHubReadMap,
  GitHubRepositoryFact,
  GitHubScanMap,
} from '@breakfastdapaidang/saki-github'
import { SAKI_BOARD_WORK_ITEM_LIMIT } from '@breakfastdapaidang/saki-control-plane/constants'
import type { LocalGitPushTransport } from '../../packages/saki/execution-local/src/git-push.ts'

const REVISION_AT = 1_700_000_000_000
const ACCOUNT_ID = githubAccountId('O_saki_account')
const INSTALLATION_ID = githubInstallationId('12345678')
const REPOSITORY_ID = githubRepositoryId('R_saki_repository')
const REPOSITORY_DATABASE_ID = githubRepositoryDatabaseId('87654321')
const PROJECT_ID = githubProjectId('PVT_saki_project')
const STATUS_FIELD_ID = githubProjectFieldId('PVTSSF_saki_status')
const PULL_REQUEST_ID = githubPullRequestId('PR_saki_delivery')
const PULL_REQUEST_NUMBER = 72
const PULL_REQUEST_UPDATED_AT = REVISION_AT + PULL_REQUEST_NUMBER
const PULL_REQUEST_REVIEW_ID = githubPullRequestReviewId('PRR_saki_delivery_approved')
const PULL_REQUEST_REVIEWER_ID = githubAccountId('U_saki_delivery_reviewer')
const MILESTONE_ID = githubMilestoneId('MI_saki_0_1_0')
const RELEASE_TAG_NAME = githubReleaseTagName('saki-v0.1.0')
const RELEASE_ID = githubReleaseId('RE_saki_0_1_0')
const UPSTREAM_REPOSITORY_ID = githubRepositoryId('R_saki_upstream')
const UPSTREAM_REPOSITORY_DATABASE_ID = githubRepositoryDatabaseId('24681357')
const STATUS_OPTIONS = {
  inbox: githubProjectOptionId('option-inbox'),
  backlog: githubProjectOptionId('option-backlog'),
  ready: githubProjectOptionId('option-ready'),
  inProgress: githubProjectOptionId('option-in-progress'),
  inReview: githubProjectOptionId('option-in-review'),
  done: githubProjectOptionId('option-done'),
  canceled: githubProjectOptionId('option-canceled'),
} as const

interface SakiBoardSnapshotMutationState {
  readonly statusOptionId: GitHubProjectOptionId
  readonly issueState: 'open' | 'closed'
  readonly dispatchCount: number
  readonly issueStateDispatchCount: number
  readonly pullRequestCreateCount: number
  readonly baseCommitId?: string
  readonly pushedCommitId?: string
  readonly pushCount: number
}

const initialMutationState = (): SakiBoardSnapshotMutationState => ({
  statusOptionId: STATUS_OPTIONS.ready,
  issueState: 'open',
  dispatchCount: 0,
  issueStateDispatchCount: 0,
  pullRequestCreateCount: 0,
  pushCount: 0,
})
let inMemoryMutationState = initialMutationState()

function mutationStatePath(providerStatePath: string): string {
  return `${providerStatePath}.mutation.json`
}

async function writeMutationStateFile(
  providerStatePath: string,
  state: SakiBoardSnapshotMutationState,
): Promise<void> {
  const target = mutationStatePath(providerStatePath)
  const temporary = `${target}.next`
  await writeFile(temporary, `${JSON.stringify(state)}\n`)
  await rename(temporary, target)
}

/**
 * Seed the fake remote with the exact Commit currently at local `main`.
 * @param providerStatePath - scan-admission path whose sidecar owns mutation state.
 * @param baseCommitId - exact initial local Commit represented by the remote base branch.
 * @returns when the cross-process mutation state is durable.
 */
export async function initializeSakiBoardSnapshotMutationState(
  providerStatePath: string,
  baseCommitId: string,
): Promise<void> {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(baseCommitId)) {
    throw new TypeError('Saki Board snapshot base Commit id is invalid')
  }
  await writeMutationStateFile(providerStatePath, { ...initialMutationState(), baseCommitId })
}

/**
 * Read fake-remote evidence without relying on one child process's memory.
 * @param providerStatePath - scan-admission path whose sidecar owns mutation state.
 * @returns validated Board, Issue, Pull Request, Push, and dispatch evidence retained across restarts.
 */
export async function readSakiBoardSnapshotMutationState(
  providerStatePath: string,
): Promise<SakiBoardSnapshotMutationState> {
  let raw: string
  try {
    raw = await readFile(mutationStatePath(providerStatePath), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return initialMutationState()
    throw error
  }
  const value = JSON.parse(raw) as Record<string, unknown>
  const statusOptionId = value.statusOptionId
  const issueState = value.issueState ?? 'open'
  const dispatchCount = value.dispatchCount
  const issueStateDispatchCount = value.issueStateDispatchCount ?? 0
  const pullRequestCreateCount = value.pullRequestCreateCount ?? 0
  const baseCommitId = value.baseCommitId
  const pushedCommitId = value.pushedCommitId
  const pushCount = value.pushCount ?? 0
  if (typeof statusOptionId !== 'string'
    || !Object.values(STATUS_OPTIONS).some(option => option === statusOptionId)
    || (issueState !== 'open' && issueState !== 'closed')
    || typeof dispatchCount !== 'number' || !Number.isSafeInteger(dispatchCount) || dispatchCount < 0
    || typeof issueStateDispatchCount !== 'number' || !Number.isSafeInteger(issueStateDispatchCount)
    || issueStateDispatchCount < 0
    || typeof pullRequestCreateCount !== 'number' || !Number.isSafeInteger(pullRequestCreateCount)
    || pullRequestCreateCount < 0
    || (baseCommitId !== undefined && (typeof baseCommitId !== 'string'
      || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(baseCommitId)))
    || (pushedCommitId !== undefined && (typeof pushedCommitId !== 'string'
      || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(pushedCommitId)))
    || typeof pushCount !== 'number' || !Number.isSafeInteger(pushCount) || pushCount < 0) {
    throw new Error('Saki Board snapshot mutation state is invalid')
  }
  return {
    statusOptionId: githubProjectOptionId(statusOptionId),
    issueState,
    dispatchCount,
    issueStateDispatchCount,
    pullRequestCreateCount,
    ...(baseCommitId === undefined ? {} : { baseCommitId }),
    ...(pushedCommitId === undefined ? {} : { pushedCommitId }),
    pushCount,
  }
}

async function readProviderMutationState(): Promise<SakiBoardSnapshotMutationState> {
  const path = process.env.SAKI_BOARD_SNAPSHOT_PROVIDER_STATE
  return path === undefined
    ? structuredClone(inMemoryMutationState)
    : await readSakiBoardSnapshotMutationState(path)
}

async function writeProviderMutationState(state: SakiBoardSnapshotMutationState): Promise<void> {
  const path = process.env.SAKI_BOARD_SNAPSHOT_PROVIDER_STATE
  if (path === undefined) {
    inMemoryMutationState = structuredClone(state)
    return
  }
  await writeMutationStateFile(path, state)
}

function assertDeliveryPushTarget(
  request: Parameters<LocalGitPushTransport['readBranch']>[0],
): void {
  if (request.repository.nameWithOwner !== 'BreakfastDaPaiDang/saki'
    || request.targetRef !== 'refs/heads/saki/snapshot-delivery') {
    throw new Error('Saki Delivery snapshot received an unexpected Push target')
  }
}

/** Keyless Git transport whose exact remote branch is shared with the fake GitHub Provider. */
export const sakiBoardSnapshotGitPushTransport: LocalGitPushTransport = {
  async readBranch(request, signal) {
    signal.throwIfAborted()
    assertDeliveryPushTarget(request)
    const state = await readProviderMutationState()
    return state.pushedCommitId === undefined
      ? { kind: 'absent' }
      : { kind: 'commit', objectId: state.pushedCommitId }
  },
  async pushBranch(request, signal) {
    signal.throwIfAborted()
    assertDeliveryPushTarget(request)
    const expectedLength = request.objectFormat === 'sha1' ? 40 : 64
    if (!new RegExp(`^[0-9a-f]{${String(expectedLength)}}$`, 'u').test(request.commitId)) {
      throw new Error('Saki Delivery snapshot received an invalid Push Commit')
    }
    const state = await readProviderMutationState()
    const current = state.pushedCommitId === undefined
      ? { kind: 'absent' as const }
      : { kind: 'commit' as const, objectId: state.pushedCommitId }
    const leaseMatches = current.kind === request.previous.kind
      && (current.kind === 'absent'
        || (request.previous.kind === 'commit' && current.objectId === request.previous.objectId))
    if (!leaseMatches) {
      throw new Error('Saki Delivery snapshot received a stale Push lease')
    }
    await writeProviderMutationState({
      ...state,
      pushedCommitId: request.commitId,
      pushCount: state.pushCount + 1,
    })
  },
}

/** Credential-value-free synchronization Intent fields shared with the Board snapshot runner. */
export const SAKI_BOARD_SNAPSHOT_CONFIGURATION = Object.freeze({
  appId: '123456',
  githubInstallationId: INSTALLATION_ID,
  accountNodeId: ACCOUNT_ID,
  repositoryNodeId: REPOSITORY_ID,
  repositoryDatabaseId: REPOSITORY_DATABASE_ID,
  projectNodeId: PROJECT_ID,
  credentialRef: credentialRef('SAKI_GITHUB_APP_PRIVATE_KEY'),
  statusFieldNodeId: STATUS_FIELD_ID,
  statusOptionNodeIds: STATUS_OPTIONS,
  activePollIntervalMs: 30_000,
  backgroundPollIntervalMs: 300_000,
  rateLimitReserve: 500,
} as const)

/** Fixed public release identities used by the assembled Delivery snapshot. */
export const SAKI_DELIVERY_SNAPSHOT_RELEASE_TARGET = Object.freeze({
  milestoneId: MILESTONE_ID,
  milestoneNumber: 1,
  tagName: RELEASE_TAG_NAME,
  upstreamRepositoryId: UPSTREAM_REPOSITORY_ID,
  upstreamRepositoryDatabaseId: UPSTREAM_REPOSITORY_DATABASE_ID,
  upstreamRepositoryNameWithOwner: 'deepseek-ai/deepseek-harness',
} as const)

function installationFact(observedAt: number): GitHubInstallationFact {
  return {
    installationId: INSTALLATION_ID,
    account: { id: ACCOUNT_ID, login: 'BreakfastDaPaiDang', type: 'organization' },
    repositorySelection: 'selected',
    permissions: {
      repository: [
        { name: 'actions', access: 'read' },
        { name: 'checks', access: 'read' },
        { name: 'contents', access: 'read' },
        { name: 'issues', access: 'write' },
        { name: 'metadata', access: 'read' },
        { name: 'pull_requests', access: 'write' },
        { name: 'statuses', access: 'read' },
      ],
      organization: [{ name: 'organization_projects', access: 'write' }],
    },
    accessibleRepositoryIds: [REPOSITORY_ID],
    tokenExpiresAt: observedAt + 3_600_000,
    observedAt,
  }
}

function repositoryFact(observedAt: number): GitHubRepositoryFact {
  return {
    id: REPOSITORY_ID,
    databaseId: REPOSITORY_DATABASE_ID,
    ownerAccountId: ACCOUNT_ID,
    nameWithOwner: 'BreakfastDaPaiDang/saki',
    visibility: 'public',
    url: 'https://github.com/BreakfastDaPaiDang/saki',
    updatedAt: REVISION_AT,
    observedAt,
  }
}

function projectFact(observedAt: number): GitHubProjectFact {
  return {
    id: PROJECT_ID,
    ownerAccountId: ACCOUNT_ID,
    number: 1,
    title: 'Saki 0.1.0',
    closed: false,
    url: 'https://github.com/orgs/BreakfastDaPaiDang/projects/1',
    updatedAt: REVISION_AT,
    observedAt,
  }
}

function issue(number: number, state: 'open' | 'closed', title: string): GitHubIssueFact {
  return {
    id: githubIssueId(`I_saki_${String(number)}`),
    repositoryId: REPOSITORY_ID,
    repositoryDatabaseId: REPOSITORY_DATABASE_ID,
    number,
    state,
    title,
    url: `https://github.com/BreakfastDaPaiDang/saki/issues/${String(number)}`,
    updatedAt: REVISION_AT + number,
  }
}

function deliveryIssue(state: 'open' | 'closed', stateTransitions = 0): GitHubIssueFact {
  return {
    ...issue(27, state, 'Publish a read-only GitHub Board Projection'),
    updatedAt: REVISION_AT + 27 + stateTransitions,
  }
}

const CANCELED_ISSUE = issue(29, 'closed', 'Retired synchronization experiment')
const INBOX_ISSUE = issue(30, 'open', 'Unplanned repository issue')

/** Complete Ready Issue body used by the assembled Agent Run snapshot. */
export const SAKI_AGENT_RUN_SNAPSHOT_ISSUE_BODY = [
  '# Intended outcome',
  'Ship the assembled manual Agent Run path.',
  '# Acceptance criteria',
  '- Deliver this exact frozen Work Item input once',
  '- Reopen the same durable Run after restart',
  '# Blocked by',
  'None',
].join('\n')

function scanSource(state: SakiBoardSnapshotMutationState = initialMutationState()): GitHubProjectBoardFingerprintSource {
  const observedAt = Date.now()
  const installation = installationFact(observedAt)
  const repository = repositoryFact(observedAt)
  const project = projectFact(observedAt)
  const readyIssue = deliveryIssue(state.issueState, state.issueStateDispatchCount)
  const openIssues = state.issueState === 'open' ? [readyIssue, INBOX_ISSUE] : [INBOX_ISSUE]
  return {
    kind: 'project-board',
    formatVersion: 1,
    installation,
    repository,
    project,
    statusFieldId: STATUS_FIELD_ID,
    fields: [{
      kind: 'single-select',
      id: STATUS_FIELD_ID,
      name: 'Workflow Status',
      options: Object.entries(STATUS_OPTIONS).map(([name, id]) => ({ id, name })),
    }],
    items: [
      {
        id: githubProjectItemId('PVTI_saki_ready'),
        projectId: PROJECT_ID,
        content: { kind: 'issue', issue: readyIssue },
        statusOptionId: state.statusOptionId,
        archived: false,
        apiOrder: 0,
        updatedAt: REVISION_AT + 27 + state.dispatchCount,
      },
      {
        id: githubProjectItemId('PVTI_saki_canceled'),
        projectId: PROJECT_ID,
        content: { kind: 'issue', issue: CANCELED_ISSUE },
        statusOptionId: STATUS_OPTIONS.inProgress,
        archived: true,
        apiOrder: 1,
        updatedAt: REVISION_AT + 29,
      },
    ],
    openIssues,
    fences: {
      before: {
        projectUpdatedAt: project.updatedAt,
        repositoryUpdatedAt: repository.updatedAt,
        projectItemCount: 2,
        openIssueCount: openIssues.length,
      },
      after: {
        projectUpdatedAt: project.updatedAt,
        repositoryUpdatedAt: repository.updatedAt,
        projectItemCount: 2,
        openIssueCount: openIssues.length,
      },
    },
    rateObservations: [{
      kind: 'graphql',
      cost: 7,
      limit: 5_000,
      used: 107,
      remaining: 4_893,
      resetAt: observedAt + 3_600_000,
      observedAt,
    }],
    observedAt,
  }
}

function capacityScanSource(): GitHubProjectBoardFingerprintSource {
  const source = scanSource()
  const openIssues = Array.from({ length: SAKI_BOARD_WORK_ITEM_LIMIT + 1 }, (_, index) => (
    issue(index + 1, 'open', `Capacity fixture ${String(index + 1)}`)
  ))
  return {
    ...source,
    items: [],
    openIssues,
    fences: {
      before: {
        projectUpdatedAt: source.project.updatedAt,
        repositoryUpdatedAt: source.repository.updatedAt,
        projectItemCount: 0,
        openIssueCount: openIssues.length,
      },
      after: {
        projectUpdatedAt: source.project.updatedAt,
        repositoryUpdatedAt: source.repository.updatedAt,
        projectItemCount: 0,
        openIssueCount: openIssues.length,
      },
    },
  }
}

function targetedStatusInspection(state: SakiBoardSnapshotMutationState): GitHubProjectItemStatusSetInspection {
  const observedAt = Date.now()
  const readyIssue = deliveryIssue(state.issueState, state.issueStateDispatchCount)
  const snapshot = {
    repositoryId: REPOSITORY_ID,
    repositoryDatabaseId: REPOSITORY_DATABASE_ID,
    projectId: PROJECT_ID,
    statusFieldId: STATUS_FIELD_ID,
    issue: readyIssue,
    membership: {
      state: 'present' as const,
      item: {
        id: githubProjectItemId('PVTI_saki_ready'),
        projectId: PROJECT_ID,
        issueId: readyIssue.id,
        statusOptionId: state.statusOptionId,
        archived: false,
        apiOrder: 0,
        totalCount: 2,
        previousItemId: null,
        nextItemId: githubProjectItemId('PVTI_saki_canceled'),
        updatedAt: REVISION_AT + 27 + state.dispatchCount,
      },
    },
  }
  return {
    snapshot,
    observedAt,
  }
}

function pullRequestFact(state: SakiBoardSnapshotMutationState, observedAt: number): GitHubPullRequestFact {
  if (state.pushedCommitId === undefined || state.baseCommitId === undefined) {
    throw new GitHubProviderError({
      code: 'invalid-external-response',
      operation: 'saki-delivery-snapshot-pull-request-state',
    })
  }
  return {
    id: PULL_REQUEST_ID,
    repositoryId: REPOSITORY_ID,
    number: PULL_REQUEST_NUMBER,
    state: 'open',
    merged: false,
    draft: false,
    title: 'Deliver snapshot Work Item',
    url: `https://github.com/BreakfastDaPaiDang/saki/pull/${String(PULL_REQUEST_NUMBER)}`,
    head: {
      repositoryId: REPOSITORY_ID,
      ref: 'saki/snapshot-delivery',
      commitId: githubCommitId(state.pushedCommitId),
    },
    base: { repositoryId: REPOSITORY_ID, ref: 'main', commitId: githubCommitId(state.baseCommitId) },
    authorAccountId: ACCOUNT_ID,
    updatedAt: PULL_REQUEST_UPDATED_AT,
    observedAt,
  }
}

function pullRequestReviewsFact(
  state: SakiBoardSnapshotMutationState,
  observedAt: number,
): GitHubPullRequestReviewsFact {
  const pullRequest = pullRequestFact(state, observedAt)
  return {
    repositoryId: REPOSITORY_ID,
    pullRequestId: PULL_REQUEST_ID,
    pullRequestNumber: PULL_REQUEST_NUMBER,
    headCommitId: pullRequest.head.commitId,
    pullRequestUpdatedAt: PULL_REQUEST_UPDATED_AT,
    reviews: [{
      id: PULL_REQUEST_REVIEW_ID,
      authorAccountId: PULL_REQUEST_REVIEWER_ID,
      state: 'approved',
      commitId: pullRequest.head.commitId,
      url: `https://github.com/BreakfastDaPaiDang/saki/pull/${String(PULL_REQUEST_NUMBER)}#pullrequestreview-501`,
      submittedAt: REVISION_AT + PULL_REQUEST_NUMBER - 1,
      updatedAt: REVISION_AT + PULL_REQUEST_NUMBER - 1,
    }],
    observedAt,
  }
}

function successfulCi(commitId: string, observedAt: number): GitHubCommitCiFact {
  return {
    repositoryId: REPOSITORY_ID,
    commitId: githubCommitId(commitId),
    workflowRuns: [{
      id: githubWorkflowRunId('101'),
      workflowId: githubWorkflowId('11'),
      name: 'Saki CI',
      event: 'pull_request',
      runNumber: 32,
      runAttempt: 1,
      status: 'completed',
      conclusion: 'success',
      url: 'https://github.com/BreakfastDaPaiDang/saki/actions/runs/101',
      createdAt: REVISION_AT + 101,
      updatedAt: REVISION_AT + 101,
    }],
    checkRuns: [],
    commitStatuses: [{
      id: githubCommitStatusId('301'),
      context: 'required/ci',
      state: 'success',
      targetUrl: 'https://ci.example.test/build/301',
      createdAt: REVISION_AT + 301,
      updatedAt: REVISION_AT + 301,
    }],
    observedAt,
  }
}

function assertProductInstallation(installation: GitHubInstallationProfile): void {
  const expected = SAKI_BOARD_SNAPSHOT_CONFIGURATION
  if (installation.appId !== expected.appId
    || installation.installationId !== expected.githubInstallationId
    || installation.accountId !== expected.accountNodeId
    || installation.privateKeyRef !== expected.credentialRef) {
    throw new GitHubProviderError({
      code: 'invalid-external-response',
      operation: 'saki-delivery-snapshot-installation-request',
    })
  }
}

function assertProductRepositoryRequest(request: {
  readonly installation: GitHubInstallationProfile
  readonly repositoryId: unknown
  readonly repositoryDatabaseId: unknown
}): void {
  assertProductInstallation(request.installation)
  if (request.repositoryId !== REPOSITORY_ID || request.repositoryDatabaseId !== REPOSITORY_DATABASE_ID) {
    throw new GitHubProviderError({
      code: 'invalid-external-response',
      operation: 'saki-delivery-snapshot-repository-request',
    })
  }
}

function assertPullRequestCreateRequest(
  request: GitHubPullRequestCreateRequest,
  state: SakiBoardSnapshotMutationState,
): void {
  assertProductRepositoryRequest(request)
  const matches = request.headRef === 'saki/snapshot-delivery'
    && request.baseRef === 'main'
    && request.expectedHeadCommitId === state.pushedCommitId
    && request.operationId === 'branch-delivery:intent-77777777-7777-4777-8777-777777777777:pull-request'
    && request.title === 'Deliver snapshot Work Item'
    && request.body === `Carries the selected Commit through human acceptance.\n<!-- saki-pull-request:${request.markerId} -->\n`
    && request.body.split('<!-- saki-pull-request:').length === 2
    && (request.inspectionHint === undefined
      || (request.inspectionHint.pullRequestId === PULL_REQUEST_ID
        && request.inspectionHint.pullRequestNumber === PULL_REQUEST_NUMBER))
  if (!matches) {
    throw new GitHubProviderError({
      code: 'invalid-external-response',
      operation: 'saki-delivery-snapshot-pull-request-create',
    })
  }
}

function assertIssueStateMutationRequest(request: GitHubIssueStateSetRequest): void {
  assertProductRepositoryRequest(request)
  if (request.issueId !== deliveryIssue('open').id || request.desiredState !== 'closed') {
    throw new GitHubProviderError({
      code: 'invalid-external-response',
      operation: 'saki-delivery-snapshot-issue-state-mutation',
    })
  }
}

function cancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new GitHubProviderError({ code: 'cancelled' })
}

async function waitForFixtureAdmission(signal: AbortSignal): Promise<'capacity' | 'complete'> {
  const path = process.env.SAKI_BOARD_SNAPSHOT_PROVIDER_STATE
  if (path === undefined) return 'complete'
  while (true) {
    cancelled(signal)
    let state: string
    try {
      state = (await readFile(path, 'utf8')).trim()
    } catch {
      throw new GitHubProviderError({
        code: 'invalid-external-response',
        operation: 'saki-board-snapshot-provider-state',
      })
    }
    if (state === 'complete' || state === 'capacity') return state
    if (state === 'transient-transport') {
      throw new GitHubProviderError({ code: 'transient-transport', retryAfterMs: 300_000 })
    }
    if (state !== 'hold') {
      throw new GitHubProviderError({
        code: 'invalid-external-response',
        operation: 'saki-board-snapshot-provider-state',
      })
    }
    try {
      await delay(10, undefined, { signal })
    } catch {
      throw new GitHubProviderError({ code: 'cancelled' })
    }
  }
}

function assertScanRequest(request: GitHubProjectBoardScanRequest): void {
  assertProductRepositoryRequest(request)
  const expectedOptions = Object.values(SAKI_BOARD_SNAPSHOT_CONFIGURATION.statusOptionNodeIds)
  const matches = request.projectId === SAKI_BOARD_SNAPSHOT_CONFIGURATION.projectNodeId
    && request.statusFieldId === SAKI_BOARD_SNAPSHOT_CONFIGURATION.statusFieldNodeId
    && request.rateLimitReserve === SAKI_BOARD_SNAPSHOT_CONFIGURATION.rateLimitReserve
    && request.requiredStatusOptionIds.length === expectedOptions.length
    && request.requiredStatusOptionIds.every(option => expectedOptions.includes(option))
  if (!matches) {
    throw new GitHubProviderError({
      code: 'invalid-external-response',
      operation: 'saki-board-snapshot-request',
    })
  }
}

function assertStatusMutationRequest(request: GitHubProjectItemStatusSetRequest): void {
  assertProductRepositoryRequest(request)
  const matches = request.projectId === PROJECT_ID
    && request.issueId === deliveryIssue('open').id
    && request.projectItemId === githubProjectItemId('PVTI_saki_ready')
    && request.statusFieldId === STATUS_FIELD_ID
    && Object.values(STATUS_OPTIONS).includes(request.desiredStatusOptionId)
  if (!matches) {
    throw new GitHubProviderError({
      code: 'invalid-external-response',
      operation: 'saki-board-snapshot-status-mutation-request',
    })
  }
}

/** Loader-mounted deterministic Provider that replaces only the external GitHub boundary. */
export class SakiBoardSnapshotGitHub extends SakiGitHub {
  /** @inheritdoc */
  override async read<K extends keyof GitHubReadMap>(
    request: GitHubReadMap[K]['request'],
    signal: AbortSignal,
  ): Promise<GitHubReadMap[K]['result']> {
    cancelled(signal)
    const observedAt = Date.now()
    const state = await readProviderMutationState()
    const readyIssue = deliveryIssue(state.issueState, state.issueStateDispatchCount)
    if (request.kind === 'installation') {
      assertProductInstallation(request.installation)
      return installationFact(observedAt)
    }
    if (request.kind === 'repository') {
      assertProductRepositoryRequest(request)
      return repositoryFact(observedAt)
    }
    if (request.kind === 'project') {
      assertProductInstallation(request.installation)
      if (request.projectId !== PROJECT_ID) {
        throw new GitHubProviderError({ code: 'not-found', resource: 'saki-board-snapshot-project' })
      }
      return projectFact(observedAt)
    }
    if (request.kind === 'issue') {
      assertProductRepositoryRequest(request)
      const found = [readyIssue, CANCELED_ISSUE, INBOX_ISSUE].find(candidate => candidate.id === request.issueId)
      if (found !== undefined) return structuredClone(found)
    }
    if (request.kind === 'issue-detail') {
      assertProductRepositoryRequest(request)
      const found = [readyIssue, CANCELED_ISSUE, INBOX_ISSUE].find(candidate => candidate.id === request.issueId)
      if (found !== undefined) {
        return {
          ...structuredClone(found),
          body: found.id === readyIssue.id ? SAKI_AGENT_RUN_SNAPSHOT_ISSUE_BODY : '',
        } as GitHubReadMap[K]['result']
      }
    }
    if (request.kind === 'branch-safety') {
      assertProductRepositoryRequest(request)
      const matches = request.branch === 'main'
      if (!matches) {
        throw new GitHubProviderError({
          code: 'invalid-external-response',
          operation: 'saki-board-snapshot-branch-safety-request',
        })
      }
      return { kind: 'safe', branchExists: true, observedAt } as GitHubReadMap[K]['result']
    }
    if (request.kind === 'branch-head') {
      assertProductRepositoryRequest(request)
      if (request.branch !== 'saki/snapshot-delivery') {
        throw new GitHubProviderError({ code: 'not-found', resource: 'saki-delivery-snapshot-branch' })
      }
      return (state.pushedCommitId === undefined
        ? { state: 'absent', repositoryId: REPOSITORY_ID, branch: request.branch, observedAt }
        : {
          state: 'present',
          repositoryId: REPOSITORY_ID,
          branch: request.branch,
          commitId: githubCommitId(state.pushedCommitId),
          observedAt,
        }) as GitHubReadMap[K]['result']
    }
    if (request.kind === 'pull-request') {
      assertProductRepositoryRequest(request)
      if (state.pullRequestCreateCount !== 1 || state.pushedCommitId === undefined
        || state.baseCommitId === undefined || request.pullRequestId !== PULL_REQUEST_ID
        || request.pullRequestNumber !== PULL_REQUEST_NUMBER) {
        throw new GitHubProviderError({ code: 'not-found', resource: 'saki-delivery-snapshot-pull-request' })
      }
      return pullRequestFact(state, observedAt)
    }
    if (request.kind === 'pull-request-reviews') {
      assertProductRepositoryRequest(request)
      if (state.pullRequestCreateCount !== 1 || state.pushedCommitId === undefined
        || state.baseCommitId === undefined || request.pullRequestId !== PULL_REQUEST_ID
        || request.pullRequestNumber !== PULL_REQUEST_NUMBER) {
        throw new GitHubProviderError({ code: 'not-found', resource: 'saki-delivery-snapshot-pull-request-reviews' })
      }
      return pullRequestReviewsFact(state, observedAt)
    }
    if (request.kind === 'pull-request-association') {
      assertProductRepositoryRequest(request)
      if (request.headRef !== 'saki/snapshot-delivery' || request.baseRef !== 'main'
        || request.expectedHeadCommitId !== state.pushedCommitId) {
        throw new GitHubProviderError({
          code: 'invalid-external-response',
          operation: 'saki-delivery-snapshot-pull-request-association',
        })
      }
      if (state.pullRequestCreateCount === 1 && state.baseCommitId !== undefined) {
        return {
          state: 'unique',
          pullRequest: pullRequestFact(state, observedAt),
          observedAt,
        } as GitHubReadMap[K]['result']
      }
      return {
        state: 'absent',
        repositoryId: REPOSITORY_ID,
        headRef: request.headRef,
        baseRef: request.baseRef,
        expectedHeadCommitId: request.expectedHeadCommitId,
        observedAt,
      } as GitHubReadMap[K]['result']
    }
    if (request.kind === 'commit-ci') {
      assertProductRepositoryRequest(request)
      if (request.commitId !== state.pushedCommitId) {
        throw new GitHubProviderError({ code: 'not-found', resource: 'saki-delivery-snapshot-ci' })
      }
      return successfulCi(request.commitId, observedAt)
    }
    if (request.kind === 'milestone') {
      assertProductRepositoryRequest(request)
      if (request.milestoneId !== MILESTONE_ID || request.milestoneNumber !== 1) {
        throw new GitHubProviderError({ code: 'not-found', resource: 'saki-delivery-snapshot-milestone' })
      }
      return {
        id: MILESTONE_ID,
        repositoryId: REPOSITORY_ID,
        number: 1,
        state: 'open',
        title: 'Saki 0.1.0',
        description: 'Keyless assembled Delivery snapshot.',
        url: 'https://github.com/BreakfastDaPaiDang/saki/milestone/1',
        updatedAt: REVISION_AT,
        issues: [readyIssue],
        observedAt,
      } as GitHubReadMap[K]['result']
    }
    if (request.kind === 'tag-reference') {
      assertProductRepositoryRequest(request)
      if (request.tagName !== RELEASE_TAG_NAME || state.pushedCommitId === undefined) {
        throw new GitHubProviderError({ code: 'not-found', resource: 'saki-delivery-snapshot-tag' })
      }
      return {
        repositoryId: REPOSITORY_ID,
        tagName: RELEASE_TAG_NAME,
        ref: `refs/tags/${RELEASE_TAG_NAME}`,
        target: { kind: 'commit', id: githubCommitId(state.pushedCommitId) },
        observedAt,
      } as GitHubReadMap[K]['result']
    }
    if (request.kind === 'tag-object') {
      assertProductRepositoryRequest(request)
      if (request.target.kind !== 'commit' || request.target.id !== state.pushedCommitId) {
        throw new GitHubProviderError({ code: 'not-found', resource: 'saki-delivery-snapshot-tag-object' })
      }
      return {
        repositoryId: REPOSITORY_ID,
        tagObjects: [],
        commitId: request.target.id,
        observedAt,
      } as GitHubReadMap[K]['result']
    }
    if (request.kind === 'release-by-tag') {
      assertProductRepositoryRequest(request)
      if (request.tagName !== RELEASE_TAG_NAME) {
        throw new GitHubProviderError({ code: 'not-found', resource: 'saki-delivery-snapshot-release' })
      }
      return {
        kind: 'present',
        release: {
          id: RELEASE_ID,
          repositoryId: REPOSITORY_ID,
          tagName: RELEASE_TAG_NAME,
          targetCommitish: RELEASE_TAG_NAME,
          draft: false,
          prerelease: false,
          url: `https://github.com/BreakfastDaPaiDang/saki/releases/tag/${RELEASE_TAG_NAME}`,
          publishedAt: REVISION_AT + 1_000,
          observedAt,
        },
      } as GitHubReadMap[K]['result']
    }
    if (request.kind === 'commit') {
      assertProductRepositoryRequest(request)
      if (request.commitId !== state.pushedCommitId) {
        throw new GitHubProviderError({ code: 'not-found', resource: 'saki-delivery-snapshot-commit' })
      }
      return {
        id: request.commitId,
        repositoryId: REPOSITORY_ID,
        url: `https://github.com/BreakfastDaPaiDang/saki/commit/${request.commitId}`,
        committedAt: REVISION_AT,
        observedAt,
      } as GitHubReadMap[K]['result']
    }
    if (request.kind === 'public-commit') {
      const matches = request.repositoryId === UPSTREAM_REPOSITORY_ID
        && request.repositoryDatabaseId === UPSTREAM_REPOSITORY_DATABASE_ID
        && request.repositoryNameWithOwner === SAKI_DELIVERY_SNAPSHOT_RELEASE_TARGET.upstreamRepositoryNameWithOwner
        && request.commitId === state.pushedCommitId
      if (!matches) {
        throw new GitHubProviderError({ code: 'not-found', resource: 'saki-delivery-snapshot-upstream-commit' })
      }
      return {
        id: request.commitId,
        repositoryId: UPSTREAM_REPOSITORY_ID,
        url: `https://github.com/deepseek-ai/deepseek-harness/commit/${request.commitId}`,
        committedAt: REVISION_AT,
        observedAt,
      } as GitHubReadMap[K]['result']
    }
    if (request.kind === 'compare-commits') {
      assertProductRepositoryRequest(request)
      if (request.baseCommitId !== state.pushedCommitId || request.headCommitId !== state.pushedCommitId) {
        throw new GitHubProviderError({ code: 'not-found', resource: 'saki-delivery-snapshot-comparison' })
      }
      return {
        repositoryId: REPOSITORY_ID,
        baseCommitId: request.baseCommitId,
        headCommitId: request.headCommitId,
        status: 'identical',
        aheadBy: 0,
        behindBy: 0,
        mergeBaseCommitId: request.baseCommitId,
        observedAt,
      } as GitHubReadMap[K]['result']
    }
    throw new GitHubProviderError({ code: 'not-found', resource: request.kind })
  }

  /** @inheritdoc */
  override async scan<K extends keyof GitHubScanMap>(
    request: GitHubScanMap[K]['request'],
    signal: AbortSignal,
  ): Promise<GitHubScanMap[K]['result']> {
    cancelled(signal)
    assertScanRequest(request)
    const admission = await waitForFixtureAdmission(signal)
    const mutationState = await readProviderMutationState()
    const source = admission === 'capacity'
      ? capacityScanSource()
      : scanSource(mutationState)
    const candidate = githubProjectBoardScanCandidateSchema.parse({
      ...source,
      fingerprint: computeGitHubProjectBoardFingerprint(source),
    })
    return structuredClone(candidate)
  }

  /** @inheritdoc */
  override async dispatch<K extends keyof GitHubMutationMap>(
    request: GitHubMutationMap[K]['request'],
    signal: AbortSignal,
  ): Promise<GitHubMutationMap[K]['result']> {
    cancelled(signal)
    const current = await readProviderMutationState()
    if (request.kind === 'project-item-status-set') {
      assertStatusMutationRequest(request)
      await writeProviderMutationState({
        ...current,
        statusOptionId: request.desiredStatusOptionId,
        dispatchCount: current.dispatchCount + 1,
      })
      return undefined
    }
    if (request.kind === 'issue-state-set') {
      assertIssueStateMutationRequest(request)
      await writeProviderMutationState({
        ...current,
        issueState: request.desiredState,
        issueStateDispatchCount: current.issueStateDispatchCount + 1,
      })
      return undefined
    }
    if (request.kind === 'pull-request-create') {
      assertPullRequestCreateRequest(request, current)
      if (current.pullRequestCreateCount !== 0) {
        throw new GitHubProviderError({
          code: 'invalid-external-response',
          operation: 'saki-delivery-snapshot-duplicate-pull-request-create',
        })
      }
      await writeProviderMutationState({ ...current, pullRequestCreateCount: 1 })
      return {
        pullRequestId: PULL_REQUEST_ID,
        pullRequestNumber: PULL_REQUEST_NUMBER,
      } as GitHubMutationMap[K]['result']
    }
    throw new GitHubProviderError({
      code: 'invalid-external-response',
      operation: 'saki-board-snapshot-unsupported-mutation',
    })
  }

  /** @inheritdoc */
  override async inspectMutation<K extends keyof GitHubMutationMap>(
    request: GitHubMutationMap[K]['request'],
    signal: AbortSignal,
  ): Promise<GitHubMutationMap[K]['inspection']> {
    cancelled(signal)
    const current = await readProviderMutationState()
    if (request.kind === 'project-item-status-set') {
      assertStatusMutationRequest(request)
      return structuredClone(targetedStatusInspection(current))
    }
    if (request.kind === 'issue-state-set') {
      assertIssueStateMutationRequest(request)
      return {
        snapshot: { issue: deliveryIssue(current.issueState, current.issueStateDispatchCount) },
        observedAt: Date.now(),
      } as GitHubMutationMap[K]['inspection']
    }
    if (request.kind === 'pull-request-create') {
      assertPullRequestCreateRequest(request, current)
      return {
        snapshot: {
          repositoryId: REPOSITORY_ID,
          repositoryDatabaseId: REPOSITORY_DATABASE_ID,
          outcome: current.pullRequestCreateCount === 1 && current.pushedCommitId !== undefined
            && current.baseCommitId !== undefined
            ? { state: 'unique-pull-request', pullRequest: pullRequestFact(current, Date.now()) }
            : { state: 'absent-complete' },
        },
        observedAt: Date.now(),
      } as GitHubMutationMap[K]['inspection']
    }
    throw new GitHubProviderError({
      code: 'invalid-external-response',
      operation: 'saki-board-snapshot-unsupported-mutation-inspection',
    })
  }
}

export default SakiBoardSnapshotGitHub
