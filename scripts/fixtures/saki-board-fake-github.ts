/** Deterministic keyless GitHub Provider for the assembled Saki Board snapshot. */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  GitHubProviderError,
  SakiGitHub,
  computeGitHubProjectBoardFingerprint,
  githubAccountId,
  githubInstallationId,
  githubIssueId,
  githubProjectBoardScanCandidateSchema,
  githubProjectFieldId,
  githubProjectId,
  githubProjectItemId,
  githubProjectOptionId,
  githubRepositoryDatabaseId,
  githubRepositoryId,
} from '@breakfastdapaidang/saki-github'
import type {
  GitHubInstallationFact,
  GitHubIssueFact,
  GitHubMutationMap,
  GitHubProjectBoardFingerprintSource,
  GitHubProjectBoardScanRequest,
  GitHubProjectItemStatusSetInspection,
  GitHubProjectItemStatusSetRequest,
  GitHubProjectFact,
  GitHubProjectOptionId,
  GitHubReadMap,
  GitHubRepositoryFact,
  GitHubScanMap,
} from '@breakfastdapaidang/saki-github'
import { SAKI_BOARD_WORK_ITEM_LIMIT } from '@breakfastdapaidang/saki-control-plane/constants'

const REVISION_AT = 1_700_000_000_000
const ACCOUNT_ID = githubAccountId('O_saki_account')
const INSTALLATION_ID = githubInstallationId('12345678')
const REPOSITORY_ID = githubRepositoryId('R_saki_repository')
const REPOSITORY_DATABASE_ID = githubRepositoryDatabaseId('87654321')
const PROJECT_ID = githubProjectId('PVT_saki_project')
const STATUS_FIELD_ID = githubProjectFieldId('PVTSSF_saki_status')
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
  readonly dispatchCount: number
}

const initialMutationState = (): SakiBoardSnapshotMutationState => ({
  statusOptionId: STATUS_OPTIONS.ready,
  dispatchCount: 0,
})
let inMemoryMutationState = initialMutationState()

function mutationStatePath(providerStatePath: string): string {
  return `${providerStatePath}.mutation.json`
}

/**
 * Read fake-remote evidence without relying on one child process's memory.
 * @param providerStatePath - scan-admission path whose sidecar owns mutation state.
 * @returns validated status and dispatch evidence retained across restarts.
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
  const value = JSON.parse(raw) as Partial<SakiBoardSnapshotMutationState>
  const statusOptionId = value.statusOptionId
  const dispatchCount = value.dispatchCount
  if (typeof statusOptionId !== 'string'
    || !Object.values(STATUS_OPTIONS).some(option => option === statusOptionId)
    || typeof dispatchCount !== 'number' || !Number.isSafeInteger(dispatchCount) || dispatchCount < 0) {
    throw new Error('Saki Board snapshot mutation state is invalid')
  }
  return {
    statusOptionId: githubProjectOptionId(statusOptionId),
    dispatchCount,
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
  const target = mutationStatePath(path)
  const temporary = `${target}.next`
  await writeFile(temporary, `${JSON.stringify(state)}\n`)
  await rename(temporary, target)
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

const READY_ISSUE = issue(27, 'open', 'Publish a read-only GitHub Board Projection')
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

function scanSource(statusOptionId: GitHubProjectOptionId = STATUS_OPTIONS.ready): GitHubProjectBoardFingerprintSource {
  const observedAt = Date.now()
  const installation = installationFact(observedAt)
  const repository = repositoryFact(observedAt)
  const project = projectFact(observedAt)
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
        content: { kind: 'issue', issue: READY_ISSUE },
        statusOptionId,
        archived: false,
        apiOrder: 0,
        updatedAt: REVISION_AT + 27,
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
    openIssues: [READY_ISSUE, INBOX_ISSUE],
    fences: {
      before: {
        projectUpdatedAt: project.updatedAt,
        repositoryUpdatedAt: repository.updatedAt,
        projectItemCount: 2,
        openIssueCount: 2,
      },
      after: {
        projectUpdatedAt: project.updatedAt,
        repositoryUpdatedAt: repository.updatedAt,
        projectItemCount: 2,
        openIssueCount: 2,
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

function targetedStatusInspection(
  statusOptionId: GitHubProjectOptionId,
): GitHubProjectItemStatusSetInspection {
  const observedAt = Date.now()
  const snapshot = {
    repositoryId: REPOSITORY_ID,
    repositoryDatabaseId: REPOSITORY_DATABASE_ID,
    projectId: PROJECT_ID,
    statusFieldId: STATUS_FIELD_ID,
    issue: READY_ISSUE,
    membership: {
      state: 'present' as const,
      item: {
        id: githubProjectItemId('PVTI_saki_ready'),
        projectId: PROJECT_ID,
        issueId: READY_ISSUE.id,
        statusOptionId,
        archived: false,
        apiOrder: 0,
        totalCount: 2,
        previousItemId: null,
        nextItemId: githubProjectItemId('PVTI_saki_canceled'),
        updatedAt: REVISION_AT + 27,
      },
    },
  }
  return {
    snapshot,
    observedAt,
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
  const expectedOptions = Object.values(SAKI_BOARD_SNAPSHOT_CONFIGURATION.statusOptionNodeIds)
  const matches = request.installation.appId === SAKI_BOARD_SNAPSHOT_CONFIGURATION.appId
    && request.installation.installationId === SAKI_BOARD_SNAPSHOT_CONFIGURATION.githubInstallationId
    && request.installation.accountId === SAKI_BOARD_SNAPSHOT_CONFIGURATION.accountNodeId
    && request.installation.privateKeyRef === SAKI_BOARD_SNAPSHOT_CONFIGURATION.credentialRef
    && request.projectId === SAKI_BOARD_SNAPSHOT_CONFIGURATION.projectNodeId
    && request.repositoryId === SAKI_BOARD_SNAPSHOT_CONFIGURATION.repositoryNodeId
    && request.repositoryDatabaseId === SAKI_BOARD_SNAPSHOT_CONFIGURATION.repositoryDatabaseId
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
  const matches = request.installation.appId === SAKI_BOARD_SNAPSHOT_CONFIGURATION.appId
    && request.installation.installationId === SAKI_BOARD_SNAPSHOT_CONFIGURATION.githubInstallationId
    && request.installation.accountId === SAKI_BOARD_SNAPSHOT_CONFIGURATION.accountNodeId
    && request.installation.privateKeyRef === SAKI_BOARD_SNAPSHOT_CONFIGURATION.credentialRef
    && request.repositoryId === REPOSITORY_ID
    && request.repositoryDatabaseId === REPOSITORY_DATABASE_ID
    && request.projectId === PROJECT_ID
    && request.issueId === READY_ISSUE.id
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
  override read<K extends keyof GitHubReadMap>(
    request: GitHubReadMap[K]['request'],
    signal: AbortSignal,
  ): Promise<GitHubReadMap[K]['result']> {
    cancelled(signal)
    const observedAt = Date.now()
    if (request.kind === 'installation') return Promise.resolve(installationFact(observedAt))
    if (request.kind === 'repository') return Promise.resolve(repositoryFact(observedAt))
    if (request.kind === 'project') return Promise.resolve(projectFact(observedAt))
    if (request.kind === 'issue') {
      const found = [READY_ISSUE, CANCELED_ISSUE, INBOX_ISSUE].find(candidate => candidate.id === request.issueId)
      if (found !== undefined) return Promise.resolve(structuredClone(found))
    }
    if (request.kind === 'issue-detail') {
      const found = [READY_ISSUE, CANCELED_ISSUE, INBOX_ISSUE].find(candidate => candidate.id === request.issueId)
      if (found !== undefined) {
        return Promise.resolve({
          ...structuredClone(found),
          body: found.id === READY_ISSUE.id ? SAKI_AGENT_RUN_SNAPSHOT_ISSUE_BODY : '',
        })
      }
    }
    if (request.kind === 'branch-safety') {
      const matches = request.repositoryId === REPOSITORY_ID
        && request.repositoryDatabaseId === REPOSITORY_DATABASE_ID
        && request.branch === 'main'
      if (!matches) {
        throw new GitHubProviderError({
          code: 'invalid-external-response',
          operation: 'saki-board-snapshot-branch-safety-request',
        })
      }
      return Promise.resolve({ kind: 'safe', branchExists: true, observedAt })
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
      : scanSource(mutationState.statusOptionId)
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
    if (request.kind !== 'project-item-status-set') {
      throw new GitHubProviderError({
        code: 'invalid-external-response',
        operation: 'saki-board-snapshot-unsupported-mutation',
      })
    }
    assertStatusMutationRequest(request)
    const current = await readProviderMutationState()
    await writeProviderMutationState({
      statusOptionId: request.desiredStatusOptionId,
      dispatchCount: current.dispatchCount + 1,
    })
    return undefined
  }

  /** @inheritdoc */
  override async inspectMutation<K extends keyof GitHubMutationMap>(
    request: GitHubMutationMap[K]['request'],
    signal: AbortSignal,
  ): Promise<GitHubMutationMap[K]['inspection']> {
    cancelled(signal)
    if (request.kind !== 'project-item-status-set') {
      throw new GitHubProviderError({
        code: 'invalid-external-response',
        operation: 'saki-board-snapshot-unsupported-mutation-inspection',
      })
    }
    assertStatusMutationRequest(request)
    const current = await readProviderMutationState()
    return structuredClone(
      targetedStatusInspection(current.statusOptionId),
    )
  }
}

export default SakiBoardSnapshotGitHub
