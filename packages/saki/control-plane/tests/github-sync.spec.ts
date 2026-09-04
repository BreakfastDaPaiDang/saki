import { Context } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { ZodSafeParseResult } from 'zod'
import { canonicalDigest } from '@breakfastdapaidang/saki-execution'
import {
  computeGitHubProjectBoardFingerprint,
  GITHUB_PROJECT_BOARD_SCAN_COLLECTION_LIMIT,
  GitHubProviderError,
  githubAppId,
  githubInstallationId,
  githubIssueId,
  githubProjectFieldId,
  githubProjectId,
  githubProjectOptionId,
  githubPullRequestId,
  githubRepositoryDatabaseId,
  githubRepositoryId,
  SakiGitHub,
  type GitHubIssueFact,
  type GitHubIssueId,
  type GitHubMutationMap,
  type GitHubProjectBoardFingerprintSource,
  type GitHubProjectBoardScanCandidate,
  type GitHubProjectItemId,
  type GitHubProjectOptionId,
  type GitHubReadMap,
  type GitHubScanMap,
} from '@breakfastdapaidang/saki-github'
import { describe, expect, it, vi } from 'vitest'
import type {
  ConfigureGitHubSynchronizationIntent,
  SakiBoardWorkItemId,
  GitHubSynchronizationConfiguration,
  SakiControlIntentId,
  SakiDevelopmentProjectId,
} from '../src/index.ts'
import {
  SAKI_BOARD_WORK_ITEM_LIMIT,
  SAKI_GITHUB_CAPACITY_OBSERVED_LIMIT,
  SAKI_GITHUB_MAPPING_ISSUE_LIMIT,
} from '../src/index.ts'
import {
  GitHubProjectSynchronization,
  type GitHubWorkItemRecoveryMemory,
  GitHubSynchronizationConsumer,
  type GitHubProjectSyncTable,
  type GitHubSynchronizationConfigurationIntentTable,
} from '../src/github-sync.ts'
import {
  githubProjectSyncRecordSchema as currentGitHubProjectSyncRecordSchema,
  githubSynchronizationConfigurationIntentRecordSchema as currentGitHubSynchronizationConfigurationIntentRecordSchema,
  sakiGitHubScanFailureSchema as currentSakiGitHubScanFailureSchema,
  type GitHubProjectSyncRecord,
  type RegistrationActor,
} from '../src/spec.ts'
import {
  sakiGitHubScanFailureSchema as v4SakiGitHubScanFailureSchema,
  v4GitHubConfigurationIntentRecordSchema,
  v4GitHubProjectSyncRecordSchema,
} from '../src/migration-v4-github.ts'
import {
  sakiBoardWorkItemIdSchema,
  sakiGitHubScanAttemptIdSchema,
  sakiInstallationIdSchema,
  sakiIntentReceiptIdSchema,
} from '../src/ids.ts'
import { TEST_SAKI_INSTALLATION_STATE } from './installation-state.ts'

const PROJECT_A = 'project-00000000-0000-4000-8000-000000000101' as SakiDevelopmentProjectId
const PROJECT_B = 'project-00000000-0000-4000-8000-000000000105' as SakiDevelopmentProjectId

const ACTOR = {
  installationId: TEST_SAKI_INSTALLATION_STATE.installationId,
  storageGenerationId: TEST_SAKI_INSTALLATION_STATE.storageGenerationId,
  hostId: 'host-00000000-0000-4000-8000-000000000102',
  principalId: 'principal-00000000-0000-4000-8000-000000000103',
  principalRevision: 0,
  grantId: 'grant-00000000-0000-4000-8000-000000000104',
  grantRevision: 0,
} as RegistrationActor

class MemoryTable<K extends string, V> implements KvTable<K, V> {
  private readonly values = new Map<K, V>()
  afterNextCommit: (() => void) | undefined
  beforeNextPut: (() => Promise<void>) | undefined
  beforeNextUpdate: (() => Promise<void>) | undefined
  putCalls = 0

  get size(): number {
    return this.values.size
  }

  get(key: K): V | undefined {
    return this.values.get(key)
  }

  entries(): IterableIterator<[K, V]> {
    return new Map(this.values).entries()
  }

  keys(): IterableIterator<K> {
    return new Map(this.values).keys()
  }

  async put(key: K, value: V): Promise<void> {
    this.putCalls += 1
    const before = this.beforeNextPut
    this.beforeNextPut = undefined
    await before?.()
    this.values.set(key, value)
    this.afterCommit()
  }

  async delete(key: K): Promise<boolean> {
    return this.values.delete(key)
  }

  async update(key: K, operation: (current: V) => V): Promise<V> {
    const before = this.beforeNextUpdate
    this.beforeNextUpdate = undefined
    await before?.()
    const current = this.values.get(key)
    if (current === undefined) throw new Error(`missing key '${key}'`)
    const next = operation(current)
    this.values.set(key, next)
    this.afterCommit()
    return next
  }

  replace(key: K, value: V): void {
    this.values.set(key, value)
  }

  private afterCommit(): void {
    const callback = this.afterNextCommit
    this.afterNextCommit = undefined
    callback?.()
  }
}

interface SynchronizationHarness {
  readonly synchronization: GitHubProjectSynchronization
  readonly syncTable: MemoryTable<
    SakiDevelopmentProjectId,
    NonNullable<ReturnType<GitHubProjectSyncTable['get']>>
  >
  readonly intentTable: MemoryTable<
    SakiControlIntentId,
    NonNullable<ReturnType<GitHubSynchronizationConfigurationIntentTable['get']>>
  >
}

type Mutable<T> = T extends string
  ? T
  : T extends readonly (infer V)[]
    ? Mutable<V>[]
    : T extends object
      ? { -readonly [K in keyof T]: Mutable<T[K]> }
      : T

interface SafeParser<T> {
  parse(value: unknown): T
  safeParse(value: unknown): ZodSafeParseResult<T>
}

function withHistoricalSchemaParity<T>(
  current: SafeParser<T>,
  historical: SafeParser<unknown>,
  projectHistorical: (value: unknown) => unknown = value => value,
): SafeParser<T> {
  return {
    parse(value) {
      const currentValue = current.parse(value)
      const projected = projectHistorical(currentValue)
      expect(historical.parse(projected)).toEqual(projected)
      return currentValue
    },
    safeParse(value) {
      const currentResult = current.safeParse(value)
      const historicalResult = historical.safeParse(projectHistorical(value))
      expect(historicalResult.success).toBe(currentResult.success)
      if (currentResult.success) {
        if (historicalResult.success) {
          expect(historicalResult.data).toEqual(projectHistorical(currentResult.data))
        }
      }
      return currentResult
    },
  }
}

function projectGitHubProjectSyncRecordToV4(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const sourceBoard = (value as Record<string, unknown>)['confirmedBoard']
  if (typeof sourceBoard === 'object' && sourceBoard !== null && !Array.isArray(sourceBoard)) {
    const sourceItems = (sourceBoard as Record<string, unknown>)['items']
    if (Array.isArray(sourceItems) && sourceItems.length > SAKI_BOARD_WORK_ITEM_LIMIT) {
      const projected = { ...(value as Record<string, unknown>) }
      if (projected['schemaVersion'] === 2) projected['schemaVersion'] = 1
      return {
        ...projected,
        confirmedBoard: { ...(sourceBoard as Record<string, unknown>), items: sourceItems },
      }
    }
  }
  const projected = structuredClone(value as Record<string, unknown>)
  if (projected['schemaVersion'] === 2) projected['schemaVersion'] = 1
  const confirmedBoard = projected['confirmedBoard']
  if (typeof confirmedBoard !== 'object' || confirmedBoard === null || Array.isArray(confirmedBoard)) {
    return projected
  }
  const historicalBoard = confirmedBoard as Record<string, unknown>
  const items = historicalBoard['items']
  if (!Array.isArray(items)) return projected
  historicalBoard['items'] = (items as unknown[]).map((item: unknown) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return item
    const historicalItem = { ...item } as Record<string, unknown>
    Reflect.deleteProperty(historicalItem, 'latestNonTerminalStatus')
    return historicalItem
  })
  return projected
}

const githubProjectSyncRecordSchema = withHistoricalSchemaParity(
  currentGitHubProjectSyncRecordSchema,
  v4GitHubProjectSyncRecordSchema,
  projectGitHubProjectSyncRecordToV4,
)
const githubSynchronizationConfigurationIntentRecordSchema = withHistoricalSchemaParity(
  currentGitHubSynchronizationConfigurationIntentRecordSchema,
  v4GitHubConfigurationIntentRecordSchema,
)
const sakiGitHubScanFailureSchema = withHistoricalSchemaParity(
  currentSakiGitHubScanFailureSchema,
  v4SakiGitHubScanFailureSchema,
)

function synchronizationHarness(
  projects: readonly SakiDevelopmentProjectId[] = [PROJECT_A],
  authorityCurrent: (actor: RegistrationActor) => boolean = () => true,
  workItemRecovery: (
    projectId: SakiDevelopmentProjectId,
    workItemId: SakiBoardWorkItemId,
  ) => GitHubWorkItemRecoveryMemory | undefined = () => undefined,
): SynchronizationHarness {
  const syncTable = new MemoryTable<
    SakiDevelopmentProjectId,
    NonNullable<ReturnType<GitHubProjectSyncTable['get']>>
  >()
  const intentTable = new MemoryTable<
    SakiControlIntentId,
    NonNullable<ReturnType<GitHubSynchronizationConfigurationIntentTable['get']>>
  >()
  const projectIds = new Set(projects)
  return {
    syncTable,
    intentTable,
    synchronization: new GitHubProjectSynchronization({
      syncTable,
      intentTable,
      workItemRecovery,
      installationId: TEST_SAKI_INSTALLATION_STATE.installationId,
      projectExists: projectId => projectIds.has(projectId),
      authorityCurrent,
      validateActorReference: () => {},
    }),
  }
}

function configuration(): GitHubSynchronizationConfiguration {
  return {
    appId: githubAppId('12345'),
    githubInstallationId: '12345678',
    accountNodeId: 'O_saki_test_account',
    repositoryNodeId: 'R_saki_test_repository',
    repositoryDatabaseId: '87654321',
    projectNodeId: 'PVT_saki_test_project',
    credentialRef: 'SAKI_GITHUB_APP_PRIVATE_KEY',
    statusFieldNodeId: 'PVTSSF_saki_test_status',
    statusOptionNodeIds: {
      inbox: 'option-inbox',
      backlog: 'option-backlog',
      ready: 'option-ready',
      inProgress: 'option-in-progress',
      inReview: 'option-in-review',
      done: 'option-done',
      canceled: 'option-canceled',
    },
    activePollIntervalMs: 30_000,
    backgroundPollIntervalMs: 300_000,
    rateLimitReserve: 500,
  } as GitHubSynchronizationConfiguration
}

function intentId(ordinal: number): SakiControlIntentId {
  return `intent-00000000-0000-4000-8000-${ordinal.toString().padStart(12, '0')}` as SakiControlIntentId
}

function issue(
  value: number,
  githubConfiguration: GitHubSynchronizationConfiguration = configuration(),
  state: 'open' | 'closed' = 'open',
): GitHubIssueFact {
  return {
    id: `I_saki_test_issue_${value}` as GitHubIssueId,
    repositoryId: githubConfiguration.repositoryNodeId,
    repositoryDatabaseId: githubConfiguration.repositoryDatabaseId,
    number: value,
    state,
    title: `Issue ${value}`,
    url: `https://github.example.invalid/saki/issues/${value}`,
    updatedAt: 9_000,
  }
}

function boardCandidate(
  githubConfiguration: GitHubSynchronizationConfiguration = configuration(),
): GitHubProjectBoardScanCandidate {
  const statusOptions = [
    githubConfiguration.statusOptionNodeIds.inbox,
    githubConfiguration.statusOptionNodeIds.backlog,
    githubConfiguration.statusOptionNodeIds.ready,
    githubConfiguration.statusOptionNodeIds.inProgress,
    githubConfiguration.statusOptionNodeIds.inReview,
    githubConfiguration.statusOptionNodeIds.done,
    githubConfiguration.statusOptionNodeIds.canceled,
  ] satisfies readonly GitHubProjectOptionId[]
  const joinedIssue = issue(27, githubConfiguration)
  const source: GitHubProjectBoardFingerprintSource = {
    kind: 'project-board',
    formatVersion: 1,
    installation: {
      installationId: githubConfiguration.githubInstallationId,
      account: { id: githubConfiguration.accountNodeId, login: 'saki', type: 'organization' },
      repositorySelection: 'all',
      permissions: { repository: [], organization: [] },
      accessibleRepositoryIds: [],
      tokenExpiresAt: 70_000,
      observedAt: 10_000,
    },
    repository: {
      id: githubConfiguration.repositoryNodeId,
      databaseId: githubConfiguration.repositoryDatabaseId,
      ownerAccountId: githubConfiguration.accountNodeId,
      nameWithOwner: 'BreakfastDaPaiDang/saki',
      visibility: 'public',
      url: 'https://github.example.invalid/BreakfastDaPaiDang/saki',
      updatedAt: 9_000,
      observedAt: 10_000,
    },
    project: {
      id: githubConfiguration.projectNodeId,
      ownerAccountId: githubConfiguration.accountNodeId,
      number: 1,
      title: 'Saki',
      closed: false,
      url: 'https://github.example.invalid/orgs/BreakfastDaPaiDang/projects/1',
      updatedAt: 9_000,
      observedAt: 10_000,
    },
    statusFieldId: githubConfiguration.statusFieldNodeId,
    fields: [{
      kind: 'single-select',
      id: githubConfiguration.statusFieldNodeId,
      name: 'Status',
      options: statusOptions.map((id, index) => ({ id, name: `Status ${index}` })),
    }],
    items: [{
      id: 'PVTI_saki_test_item_27' as GitHubProjectItemId,
      projectId: githubConfiguration.projectNodeId,
      content: { kind: 'issue', issue: joinedIssue },
      statusOptionId: githubConfiguration.statusOptionNodeIds.ready,
      archived: false,
      apiOrder: 0,
      updatedAt: 9_000,
    }],
    openIssues: [joinedIssue],
    fences: {
      before: { projectUpdatedAt: 9_000, repositoryUpdatedAt: 9_000, projectItemCount: 1, openIssueCount: 1 },
      after: { projectUpdatedAt: 9_000, repositoryUpdatedAt: 9_000, projectItemCount: 1, openIssueCount: 1 },
    },
    rateObservations: [{
      kind: 'graphql',
      cost: 10,
      limit: 5_000,
      used: 100,
      remaining: 4_900,
      resetAt: 60_000,
      observedAt: 10_000,
    }],
    observedAt: 10_000,
  }
  return { ...source, fingerprint: computeGitHubProjectBoardFingerprint(source) }
}

function boardCandidateWithIssues(options: {
  readonly joined: number
  readonly unjoined?: number
  readonly statusOptionId?: GitHubProjectOptionId | null
  readonly configuration?: GitHubSynchronizationConfiguration
}): GitHubProjectBoardScanCandidate {
  const githubConfiguration = options.configuration ?? configuration()
  const base = boardCandidate(githubConfiguration)
  const statusOptionId = options.statusOptionId === undefined
    ? githubConfiguration.statusOptionNodeIds.ready
    : options.statusOptionId
  const items = Array.from({ length: options.joined }, (_, index) => {
    const number = index + 1
    return {
      id: `PVTI_saki_capacity_${number}` as GitHubProjectItemId,
      projectId: githubConfiguration.projectNodeId,
      content: { kind: 'issue' as const, issue: issue(number, githubConfiguration, 'closed') },
      ...(statusOptionId === null ? {} : { statusOptionId }),
      archived: false,
      apiOrder: index,
      updatedAt: 9_000,
    }
  })
  const unjoined = options.unjoined ?? 0
  const openIssues = Array.from({ length: unjoined }, (_, index) => (
    issue(options.joined + index + 1, githubConfiguration)
  ))
  return refingerprintCandidate(base, {
    items,
    openIssues,
    fences: {
      before: {
        ...base.fences.before,
        projectItemCount: items.length,
        openIssueCount: openIssues.length,
      },
      after: {
        ...base.fences.after,
        projectItemCount: items.length,
        openIssueCount: openIssues.length,
      },
    },
  })
}

function refingerprintCandidate(
  candidate: GitHubProjectBoardScanCandidate,
  patch: Partial<GitHubProjectBoardFingerprintSource>,
): GitHubProjectBoardScanCandidate {
  const { fingerprint: _fingerprint, ...source } = candidate
  const revised = { ...source, ...patch }
  return { ...revised, fingerprint: computeGitHubProjectBoardFingerprint(revised) }
}

async function begin(
  harness: SynchronizationHarness,
  projectId: SakiDevelopmentProjectId = PROJECT_A,
  priority: 'interactive' | 'background' = 'background',
) {
  const result = await harness.synchronization.beginScan(
    projectId,
    priority,
    Date.now() + 60_000,
    new AbortController().signal,
  )
  if (!result.ok) throw new Error(`scan did not begin: ${result.reason}`)
  return result.lease
}

async function confirmedHarness(): Promise<SynchronizationHarness> {
  const harness = synchronizationHarness()
  await saveConfiguration(harness)
  const lease = await begin(harness)
  const published = await harness.synchronization.publishScan(
    PROJECT_A,
    lease.attemptId,
    boardCandidate(),
    new AbortController().signal,
  )
  if (published.state !== 'published') throw new Error('test Board was not published')
  return harness
}

function mutableRecord(record: GitHubProjectSyncRecord): Mutable<GitHubProjectSyncRecord> {
  return structuredClone(record) as Mutable<GitHubProjectSyncRecord>
}

function emptySyncRecord(projectId: SakiDevelopmentProjectId = PROJECT_A): GitHubProjectSyncRecord {
  return githubProjectSyncRecordSchema.parse({
    id: projectId,
    schemaVersion: 2,
    revision: 0,
    installationId: TEST_SAKI_INSTALLATION_STATE.installationId,
    nextCandidateRevision: 1,
    nextBoardGeneration: 1,
  })
}

function issuePaths<T>(result: ZodSafeParseResult<T>): string[][] {
  return result.success ? [] : result.error.issues.map(value => value.path.map(String))
}

function issueMessages<T>(result: ZodSafeParseResult<T>): string[] {
  return result.success ? [] : result.error.issues.map(value => value.message)
}

function unreadableArray(length: number): { readonly value: unknown[]; readonly elementReads: () => number } {
  let elementReads = 0
  const value = new Proxy(new Array<unknown>(length), {
    get(target, property, receiver): unknown {
      if (typeof property === 'string' && /^(?:0|[1-9]\d*)$/u.test(property)) {
        elementReads += 1
        throw new Error('bounded array preflight read an element')
      }
      const result: unknown = Reflect.get(target, property, receiver)
      return result
    },
  })
  return { value, elementReads: () => elementReads }
}

async function saveConfiguration(
  harness: SynchronizationHarness,
  options: {
    readonly projectId?: SakiDevelopmentProjectId
    readonly expectedRevision?: number
    readonly patch?: ConfigureGitHubSynchronizationIntent['patch']
    readonly ordinal?: number
  } = {},
): Promise<void> {
  const result = await harness.synchronization.configure({
    type: 'configure-github-synchronization',
    intentId: intentId(options.ordinal ?? 1),
    projectId: options.projectId ?? PROJECT_A,
    expectedSynchronizationRevision: options.expectedRevision ?? 0,
    patch: options.patch ?? configuration(),
  }, ACTOR, new AbortController().signal)
  expect(result.ok).toBe(true)
}

class UnusedGitHub extends SakiGitHub {
  override async read<K extends keyof GitHubReadMap>(
    request: GitHubReadMap[K]['request'],
  ): Promise<GitHubReadMap[K]['result']> {
    throw new GitHubProviderError({ code: 'not-found', resource: request.kind })
  }

  override async scan<K extends keyof GitHubScanMap>(): Promise<GitHubScanMap[K]['result']> {
    throw new Error('future synchronization work must not call the Provider')
  }

  override async dispatch<K extends keyof GitHubMutationMap>(): Promise<GitHubMutationMap[K]['result']> {
    throw new Error('future synchronization work must not call the Provider')
  }

  override async inspectMutation<K extends keyof GitHubMutationMap>(): Promise<GitHubMutationMap[K]['inspection']> {
    throw new Error('future synchronization work must not call the Provider')
  }
}

type ScanOutcome = GitHubProjectBoardScanCandidate | Error | ((signal: AbortSignal) => Promise<GitHubProjectBoardScanCandidate>)

class ScriptedGitHub extends SakiGitHub {
  readonly requests: GitHubScanMap['project-board']['request'][] = []

  constructor(ctx: Context, private readonly outcomes: ScanOutcome[]) {
    super(ctx)
  }

  override async read<K extends keyof GitHubReadMap>(
    request: GitHubReadMap[K]['request'],
  ): Promise<GitHubReadMap[K]['result']> {
    throw new GitHubProviderError({ code: 'not-found', resource: request.kind })
  }

  override async scan<K extends keyof GitHubScanMap>(
    request: GitHubScanMap[K]['request'],
    signal: AbortSignal,
  ): Promise<GitHubScanMap[K]['result']> {
    this.requests.push(structuredClone(request))
    const outcome = this.outcomes.shift()
    if (outcome === undefined) throw new Error('scripted Provider has no scan outcome')
    if (typeof outcome === 'function') return await outcome(signal)
    if (outcome instanceof Error) throw outcome
    return structuredClone(outcome)
  }

  override async dispatch<K extends keyof GitHubMutationMap>(): Promise<GitHubMutationMap[K]['result']> {
    throw new Error('scan-only fake must not dispatch a GitHub mutation')
  }

  override async inspectMutation<K extends keyof GitHubMutationMap>(): Promise<GitHubMutationMap[K]['inspection']> {
    throw new Error('scan-only fake must not inspect a GitHub mutation')
  }
}

async function flushConsumer(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve()
}

async function idleSynchronizationHarness(): Promise<SynchronizationHarness> {
  const harness = synchronizationHarness()
  await saveConfiguration(harness)
  await harness.syncTable.update(PROJECT_A, (current) => {
    const { nextScanAttempt: _scheduled, ...idle } = current
    return idle
  })
  return harness
}

describe('GitHub synchronization coordinator regressions', () => {
  it('returns typed misses and projects every unconfigured scan state', async () => {
    const harness = synchronizationHarness()
    const signal = new AbortController().signal
    const missingAttempt = 'scan-attempt-00000000-0000-4000-8000-000000000999' as never

    expect(await harness.synchronization.requestScan(PROJECT_B, 'background', 'poll', 1, signal))
      .toBe('not-found')
    expect(await harness.synchronization.requestScan(PROJECT_A, 'background', 'poll', 1, signal))
      .toBe('unconfigured')
    expect(await harness.synchronization.beginScan(PROJECT_B, 'background', 10_000, signal))
      .toEqual({ ok: false, reason: 'not-found' })
    expect(await harness.synchronization.beginScan(PROJECT_A, 'background', 10_000, signal))
      .toEqual({ ok: false, reason: 'unconfigured' })
    expect(await harness.synchronization.publishScan(PROJECT_A, missingAttempt, boardCandidate(), signal))
      .toEqual({ state: 'stale' })
    expect(await harness.synchronization.failScan(
      PROJECT_A,
      missingAttempt,
      { kind: 'attempt', reason: 'expired' },
      signal,
    )).toEqual({ state: 'stale' })
    expect(harness.synchronization.board(PROJECT_B)).toBe('not-found')
    expect(harness.synchronization.projectSettings(PROJECT_B)).toBe('not-found')
    expect(harness.synchronization.board(PROJECT_A)).toMatchObject({
      state: 'unconfigured',
      synchronizationRevision: 0,
      scan: { state: 'idle' },
      mapping: { state: 'unconfigured' },
    })
    expect(harness.synchronization.projectSettings(PROJECT_A)).toMatchObject({
      synchronization: { revision: 0, state: 'unconfigured', scan: { state: 'idle' } },
    })
    expect(harness.synchronization.nextScanAt()).toBeUndefined()

    await harness.syncTable.put(PROJECT_A, emptySyncRecord())
    expect(await harness.synchronization.requestScan(PROJECT_A, 'background', 'poll', 1, signal))
      .toBe('unconfigured')
    expect(await harness.synchronization.beginScan(PROJECT_A, 'background', 10_000, signal))
      .toEqual({ ok: false, reason: 'unconfigured' })
    expect(harness.synchronization.projectSettings(PROJECT_A)).toMatchObject({
      synchronization: { revision: 0, state: 'unconfigured', scan: { state: 'idle' } },
    })
    expect(harness.synchronization.board(PROJECT_A)).toMatchObject({
      state: 'unconfigured',
      synchronizationRevision: 0,
      mapping: { state: 'unconfigured' },
    })
    expect(harness.synchronization.nextScanAt()).toBeUndefined()
    await harness.synchronization.initializeValidated(
      harness.synchronization.validateDurableState(),
      signal,
    )
  })

  it('rejects invalid scan admission and returns stale attempt outcomes', async () => {
    const now = 20_000
    const date = vi.spyOn(Date, 'now').mockReturnValue(now)
    const harness = synchronizationHarness()
    try {
      await saveConfiguration(harness)
      await expect(harness.synchronization.beginScan(
        PROJECT_A,
        'background',
        Number.MAX_SAFE_INTEGER + 1,
        new AbortController().signal,
      )).rejects.toThrow('future safe-integer timestamp')
      await expect(harness.synchronization.beginScan(
        PROJECT_A,
        'background',
        now,
        new AbortController().signal,
      )).rejects.toThrow('future safe-integer timestamp')

      const lease = await harness.synchronization.beginScan(
        PROJECT_A,
        'background',
        now + 1_000,
        new AbortController().signal,
      )
      if (!lease.ok) throw new Error('scan did not begin')
      expect(await harness.synchronization.beginScan(
        PROJECT_A,
        'interactive',
        now + 2_000,
        new AbortController().signal,
      )).toEqual({ ok: false, reason: 'in-flight' })
      const wrongAttempt = 'scan-attempt-00000000-0000-4000-8000-000000000998' as never
      expect(await harness.synchronization.publishScan(
        PROJECT_A,
        wrongAttempt,
        boardCandidate(),
        new AbortController().signal,
      )).toEqual({ state: 'stale' })
      expect(await harness.synchronization.failScan(
        PROJECT_A,
        wrongAttempt,
        { kind: 'attempt', reason: 'expired' },
        new AbortController().signal,
      )).toEqual({ state: 'stale' })

      date.mockReturnValue(now + 1_000)
      expect(await harness.synchronization.publishScan(
        PROJECT_A,
        lease.lease.attemptId,
        boardCandidate(),
        new AbortController().signal,
      )).toEqual({ state: 'failed', failure: { kind: 'attempt', reason: 'expired' } })
    } finally {
      date.mockRestore()
    }
  })

  it('selects the earliest durable wake across configured Projects', async () => {
    const harness = synchronizationHarness([PROJECT_A, PROJECT_B])
    await saveConfiguration(harness)
    await saveConfiguration(harness, { projectId: PROJECT_B, ordinal: 2 })
    await harness.syncTable.update(PROJECT_A, current => ({
      ...current,
      nextScanAttempt: { priority: 'background', reason: 'poll', attemptAt: 5_000 },
    }))
    await harness.syncTable.update(PROJECT_B, current => ({
      ...current,
      nextScanAttempt: { priority: 'background', reason: 'poll', attemptAt: 3_000 },
    }))

    expect(harness.synchronization.nextScanAt()).toBe(3_000)
  })

  it('fails loud when scan admission observes a different durable configuration', async () => {
    const harness = synchronizationHarness()
    await saveConfiguration(harness)
    harness.syncTable.beforeNextUpdate = async () => {
      const current = harness.syncTable.get(PROJECT_A)
      if (current?.pending === undefined) throw new Error('pending fixture is unavailable')
      harness.syncTable.replace(PROJECT_A, githubProjectSyncRecordSchema.parse({
        ...current,
        revision: 2,
        nextCandidateRevision: 3,
        pending: { ...current.pending, revision: 2 },
      }))
    }

    await expect(harness.synchronization.beginScan(
      PROJECT_A,
      'background',
      Date.now() + 60_000,
      new AbortController().signal,
    )).rejects.toThrow(`GitHub Project sync '${PROJECT_A}' changed before scan admission`)
  })

  it('returns exact terminal receipts for missing, incomplete, and unauthorized configuration', async () => {
    const missing = synchronizationHarness()
    expect(await missing.synchronization.configure({
      type: 'configure-github-synchronization',
      intentId: intentId(90),
      projectId: PROJECT_B,
      expectedSynchronizationRevision: 0,
      patch: configuration(),
    }, ACTOR, new AbortController().signal)).toMatchObject({
      ok: false,
      receipt: { state: 'conflict', reason: 'project-not-found' },
    })
    expect(() => missing.synchronization.validateDurableState()).not.toThrow()

    const incomplete = synchronizationHarness()
    expect(await incomplete.synchronization.configure({
      type: 'configure-github-synchronization',
      intentId: intentId(91),
      projectId: PROJECT_A,
      expectedSynchronizationRevision: 0,
      patch: { appId: configuration().appId },
    }, ACTOR, new AbortController().signal)).toMatchObject({
      ok: false,
      receipt: { state: 'conflict', reason: 'configuration-incomplete' },
    })

    const unauthorized = synchronizationHarness([PROJECT_A], () => false)
    expect(await unauthorized.synchronization.configure({
      type: 'configure-github-synchronization',
      intentId: intentId(92),
      projectId: PROJECT_A,
      expectedSynchronizationRevision: 0,
      patch: configuration(),
    }, ACTOR, new AbortController().signal)).toMatchObject({
      ok: false,
      reason: 'failure',
      receipt: { state: 'failure', reason: 'authority' },
    })
  })

  it('stabilizes an atomic replay and rejects a competing synchronization revision', async () => {
    const replayHarness = synchronizationHarness()
    await saveConfiguration(replayHarness)
    const replayIntentId = intentId(93)
    replayHarness.syncTable.beforeNextUpdate = async () => {
      const current = replayHarness.syncTable.get(PROJECT_A)
      if (current?.pending === undefined) throw new Error('pending fixture is unavailable')
      replayHarness.syncTable.replace(PROJECT_A, githubProjectSyncRecordSchema.parse({
        ...current,
        revision: 2,
        nextCandidateRevision: 3,
        pending: {
          ...current.pending,
          revision: 2,
          configuration: { ...current.pending.configuration, activePollIntervalMs: 45_000 },
          acceptedIntentId: replayIntentId,
          receiptId: replayIntentId.replace(/^intent-/u, 'receipt-'),
        },
      }))
    }
    expect(await replayHarness.synchronization.configure({
      type: 'configure-github-synchronization',
      intentId: replayIntentId,
      projectId: PROJECT_A,
      expectedSynchronizationRevision: 1,
      patch: { activePollIntervalMs: 45_000 },
    }, ACTOR, new AbortController().signal)).toMatchObject({
      ok: true,
      receipt: { candidateRevision: 2, synchronizationRevision: 2 },
    })

    const conflictHarness = synchronizationHarness()
    await saveConfiguration(conflictHarness)
    conflictHarness.syncTable.beforeNextUpdate = async () => {
      const current = conflictHarness.syncTable.get(PROJECT_A)
      if (current?.pending === undefined) throw new Error('pending sync fixture is unavailable')
      conflictHarness.syncTable.replace(PROJECT_A, githubProjectSyncRecordSchema.parse({
        ...current,
        revision: 2,
        nextCandidateRevision: 3,
        pending: { ...current.pending, revision: 2 },
      }))
    }
    expect(await conflictHarness.synchronization.configure({
      type: 'configure-github-synchronization',
      intentId: intentId(94),
      projectId: PROJECT_A,
      expectedSynchronizationRevision: 1,
      patch: { activePollIntervalMs: 45_000 },
    }, ACTOR, new AbortController().signal)).toMatchObject({
      ok: false,
      receipt: { state: 'conflict', reason: 'expected-revision' },
    })
  })

  it('fails loud when an Intent changes during its terminal transition', async () => {
    const harness = synchronizationHarness()
    const changedIntentId = intentId(95)
    harness.intentTable.beforeNextUpdate = async () => {
      const current = harness.intentTable.get(changedIntentId)
      if (current === undefined) throw new Error('prepared fixture is unavailable')
      harness.intentTable.replace(changedIntentId, githubSynchronizationConfigurationIntentRecordSchema.parse({
        ...current,
        revision: current.revision + 1,
        updatedAt: current.updatedAt + 1,
      }))
    }

    await expect(harness.synchronization.configure({
      type: 'configure-github-synchronization',
      intentId: changedIntentId,
      projectId: PROJECT_A,
      expectedSynchronizationRevision: 0,
      patch: configuration(),
    }, ACTOR, new AbortController().signal)).rejects.toThrow(
      `GitHub synchronization Intent '${changedIntentId}' changed during transition`,
    )
  })

  it('fails loud when validated startup records disappear before recovery', async () => {
    const syncHarness = synchronizationHarness()
    await saveConfiguration(syncHarness)
    const syncState = syncHarness.synchronization.validateDurableState()
    await syncHarness.syncTable.delete(PROJECT_A)
    await expect(syncHarness.synchronization.initializeValidated(
      syncState,
      new AbortController().signal,
    )).rejects.toThrow('has no aggregate mapping')

    const intentHarness = synchronizationHarness()
    intentHarness.intentTable.afterNextCommit = () => { throw new Error('simulated crash after prepared Intent') }
    await expect(intentHarness.synchronization.configure({
      type: 'configure-github-synchronization',
      intentId: intentId(96),
      projectId: PROJECT_A,
      expectedSynchronizationRevision: 0,
      patch: configuration(),
    }, ACTOR, new AbortController().signal)).rejects.toThrow('simulated crash after prepared Intent')
    const intentState = intentHarness.synchronization.validateDurableState()
    await intentHarness.intentTable.delete(intentId(96))
    await expect(intentHarness.synchronization.initializeValidated(
      intentState,
      new AbortController().signal,
    )).rejects.toThrow(`GitHub synchronization Intent '${intentId(96)}' is missing`)
  })

  it('rejects malformed and wrong-target candidates while retaining retry evidence', async () => {
    const malformedHarness = synchronizationHarness()
    await saveConfiguration(malformedHarness)
    const malformedLease = await begin(malformedHarness)
    const malformed = { ...boardCandidate(), observedAt: -1 } as GitHubProjectBoardScanCandidate
    expect(await malformedHarness.synchronization.publishScan(
      PROJECT_A,
      malformedLease.attemptId,
      malformed,
      new AbortController().signal,
    )).toEqual({ state: 'failed', failure: { kind: 'candidate', reason: 'invalid-candidate' } })

    const targetHarness = synchronizationHarness()
    await saveConfiguration(targetHarness)
    const targetLease = await begin(targetHarness)
    const complete = boardCandidate()
    const wrongTarget = refingerprintCandidate(complete, {
      installation: { ...complete.installation, installationId: githubInstallationId('99999999') },
    })
    expect(await targetHarness.synchronization.publishScan(
      PROJECT_A,
      targetLease.attemptId,
      wrongTarget,
      new AbortController().signal,
    )).toEqual({ state: 'failed', failure: { kind: 'candidate', reason: 'target-mismatch' } })
  })

  it('projects scheduled, in-flight, fresh, and stale synchronization states', async () => {
    const pending = synchronizationHarness()
    await saveConfiguration(pending)
    expect(pending.synchronization.board(PROJECT_A)).toMatchObject({
      state: 'awaiting-first-checkpoint',
      scan: { state: 'scheduled', reason: 'configuration' },
      effectiveMutationAvailability: {
        reasons: [
          'configuration-not-activated',
          'mapping-revalidation-required',
          'checkpoint-unavailable',
        ],
      },
    })
    await begin(pending)
    expect(pending.synchronization.projectSettings(PROJECT_A)).toMatchObject({
      synchronization: { scan: { state: 'in-flight' } },
    })

    const confirmed = await confirmedHarness()
    const checkpoint = confirmed.syncTable.get(PROJECT_A)?.checkpoint
    if (checkpoint === undefined) throw new Error('confirmed checkpoint is missing')
    const date = vi.spyOn(Date, 'now')
    try {
      date.mockReturnValue(checkpoint.confirmedAt + 1)
      expect(confirmed.synchronization.board(PROJECT_A)).toMatchObject({
        state: 'confirmed',
        freshness: { state: 'fresh', ageMs: 1 },
        scan: { state: 'scheduled' },
        effectiveMutationAvailability: { available: true, reasons: [] },
        mutationOverlays: [],
      })
      expect(confirmed.synchronization.projectSettings(PROJECT_A)).toMatchObject({
        synchronization: { state: 'activated' },
      })
      date.mockReturnValue(checkpoint.confirmedAt + configuration().activePollIntervalMs)
      expect(confirmed.synchronization.board(PROJECT_A)).toMatchObject({
        freshness: { state: 'stale' },
      })
    } finally {
      date.mockRestore()
    }
  })

  it('resolves one detached mutation context only from an active confirmed mapping', async () => {
    const unconfigured = synchronizationHarness()
    expect(unconfigured.synchronization.mutationContext(PROJECT_A)).toEqual({
      ok: false,
      reason: 'unavailable',
      reasons: ['synchronization-unconfigured', 'checkpoint-unavailable'],
    })
    expect(unconfigured.synchronization.mutationContext(PROJECT_B)).toEqual({
      ok: false,
      reason: 'not-found',
    })

    const confirmed = await confirmedHarness()
    const result = confirmed.synchronization.mutationContext(PROJECT_A)
    expect(result).toMatchObject({
      ok: true,
      context: {
        synchronizationRevision: 1,
        mappingRevision: 1,
        checkpointObservedAt: 10_000,
        configuration: configuration(),
        confirmedBoard: { generation: 1, configurationRevision: 1 },
      },
    })
    if (!result.ok) throw new Error('confirmed mutation context is unavailable')
    const second = confirmed.synchronization.mutationContext(PROJECT_A)
    if (!second.ok) throw new Error('second confirmed mutation context is unavailable')
    expect(result.context.confirmedBoard.items).not.toBe(second.context.confirmedBoard.items)
    expect(confirmed.synchronization.board(PROJECT_A)).toMatchObject({
      confirmed: { items: [{ issueNumber: 27 }] },
    })
  })

  it('sleeps in bounded timer segments for a durable wake far beyond the Node timer limit', async () => {
    const now = 1_000
    const date = vi.spyOn(Date, 'now').mockReturnValue(now)
    const harness = synchronizationHarness()
    await saveConfiguration(harness)
    await harness.syncTable.update(PROJECT_A, current => ({
      ...current,
      nextScanAttempt: {
        priority: 'background',
        reason: 'retry',
        attemptAt: now + MAX_TIMER_DELAY_MS + 10_000,
      },
    }))
    const ctx = new Context()
    const timer = vi.spyOn(globalThis, 'setTimeout')
    const consumer = new GitHubSynchronizationConsumer({
      synchronization: harness.synchronization,
      github: new UnusedGitHub(ctx),
      attemptTtlMs: 60_000,
      reportUnexpectedFailure: vi.fn(),
    })
    try {
      expect(timer).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_DELAY_MS)
    } finally {
      await consumer.dispose()
      await ctx.fiber.dispose()
      timer.mockRestore()
      date.mockRestore()
    }
  })

  it('saturates a secondary-rate-limit reset at the safe timestamp maximum', async () => {
    const harness = synchronizationHarness()
    await saveConfiguration(harness)
    const lease = await begin(harness)
    const candidate = refingerprintCandidate(boardCandidate(), {
      rateObservations: [{
        kind: 'secondary-limit',
        observedAt: Number.MAX_SAFE_INTEGER - 5,
        retryAfterMs: 10,
      }],
    })

    await expect(harness.synchronization.publishScan(
      PROJECT_A,
      lease.attemptId,
      candidate,
      new AbortController().signal,
    )).resolves.toMatchObject({ state: 'published' })
    expect(harness.syncTable.get(PROJECT_A)?.checkpoint?.rateLimit).toEqual({
      state: 'limited',
      observedAt: Number.MAX_SAFE_INTEGER - 5,
      resetAt: Number.MAX_SAFE_INTEGER,
    })
  })

  it('defers the next successful background scan until the observed rate reserve resets', async () => {
    const now = 100_000
    const resetAt = now + 600_000
    const date = vi.spyOn(Date, 'now').mockReturnValue(now)
    const harness = synchronizationHarness()
    try {
      await saveConfiguration(harness)
      const lease = await begin(harness)
      const candidate = refingerprintCandidate(boardCandidate(), {
        rateObservations: [{
          kind: 'graphql',
          cost: 10,
          limit: 5_000,
          used: 4_500,
          remaining: 500,
          resetAt,
          observedAt: now,
        }],
      })

      await expect(harness.synchronization.publishScan(
        PROJECT_A,
        lease.attemptId,
        candidate,
        new AbortController().signal,
      )).resolves.toMatchObject({ state: 'published' })
      expect(harness.syncTable.get(PROJECT_A)).toMatchObject({
        checkpoint: { rateLimit: { state: 'available', minimumRemaining: 500, resetAt } },
        nextScanAttempt: { reason: 'poll', attemptAt: resetAt },
      })
    } finally {
      date.mockRestore()
    }
  })

  it('treats a successful REST Retry-After observation as scheduling throttle evidence', async () => {
    const now = 100_000
    const retryAfterMs = 600_000
    const date = vi.spyOn(Date, 'now').mockReturnValue(now)
    const harness = synchronizationHarness()
    try {
      await saveConfiguration(harness)
      const lease = await begin(harness)
      const candidate = refingerprintCandidate(boardCandidate(), {
        rateObservations: [{
          kind: 'rest',
          resource: 'core',
          limit: 5_000,
          used: 1_000,
          remaining: 4_000,
          resetAt: now + 60_000,
          retryAfterMs,
          observedAt: now,
        }],
      })

      await expect(harness.synchronization.publishScan(
        PROJECT_A,
        lease.attemptId,
        candidate,
        new AbortController().signal,
      )).resolves.toMatchObject({ state: 'published' })
      expect(harness.syncTable.get(PROJECT_A)).toMatchObject({
        checkpoint: { rateLimit: { state: 'limited', resetAt: now + retryAfterMs } },
        nextScanAttempt: { reason: 'poll', attemptAt: now + retryAfterMs },
      })
    } finally {
      date.mockRestore()
    }
  })

  it.each([
    ['no observations', [], { state: 'unobserved' }, 400_000],
    ['secondary limit without reset', [{ kind: 'secondary-limit', observedAt: 100_000 }], {
      state: 'limited',
      observedAt: 100_000,
    }, 400_000],
    ['exhausted GraphQL primary limit', [{
      kind: 'graphql',
      cost: 10,
      limit: 5_000,
      used: 5_000,
      remaining: 0,
      resetAt: 800_000,
      observedAt: 100_000,
    }], { state: 'limited', resetAt: 800_000 }, 800_000],
    ['exhausted REST limit with Retry-After', [{
      kind: 'rest',
      resource: 'core',
      limit: 5_000,
      used: 5_000,
      remaining: 0,
      resetAt: 700_000,
      retryAfterMs: 800_000,
      observedAt: 100_000,
    }], { state: 'limited', resetAt: 900_000 }, 900_000],
    ['capacity above reserve', [{
      kind: 'graphql',
      cost: 10,
      limit: 5_000,
      used: 4_499,
      remaining: 501,
      resetAt: 800_000,
      observedAt: 100_000,
    }], { state: 'available', minimumRemaining: 501 }, 400_000],
  ] as const)('summarizes %s and chooses its successful poll time', async (
    _label,
    rateObservations,
    rateLimit,
    attemptAt,
  ) => {
    const date = vi.spyOn(Date, 'now').mockReturnValue(100_000)
    const harness = synchronizationHarness()
    try {
      await saveConfiguration(harness)
      const lease = await begin(harness)
      const candidate = refingerprintCandidate(boardCandidate(), { rateObservations })
      expect(await harness.synchronization.publishScan(
        PROJECT_A,
        lease.attemptId,
        candidate,
        new AbortController().signal,
      )).toMatchObject({ state: 'published' })
      expect(harness.syncTable.get(PROJECT_A)).toMatchObject({
        checkpoint: { rateLimit },
        nextScanAttempt: { attemptAt },
      })
    } finally {
      date.mockRestore()
    }
  })

  it.each([
    ['primary reset', { code: 'primary-rate-limit', resetAt: 800_000 }, 800_000],
    ['secondary Retry-After', { code: 'secondary-rate-limit', retryAfterMs: 700_000 }, 800_000],
    ['transport Retry-After', { code: 'transient-transport', retryAfterMs: 700_000 }, 800_000],
  ] as const)('defers a failed scan through its Provider %s', async (_label, failure, attemptAt) => {
    const date = vi.spyOn(Date, 'now').mockReturnValue(100_000)
    const harness = synchronizationHarness()
    try {
      await saveConfiguration(harness)
      const lease = await begin(harness)
      expect(await harness.synchronization.failScan(
        PROJECT_A,
        lease.attemptId,
        { kind: 'provider', failure },
        new AbortController().signal,
      )).toEqual({ state: 'failed' })
      expect(harness.syncTable.get(PROJECT_A)?.nextScanAttempt).toMatchObject({ attemptAt })
    } finally {
      date.mockRestore()
    }
  })

  it('omits an authentication credential reference from Board and Settings failure projections', async () => {
    const harness = synchronizationHarness()
    const credentialRef = configuration().credentialRef
    await saveConfiguration(harness)
    const lease = await begin(harness)

    expect(await harness.synchronization.failScan(
      PROJECT_A,
      lease.attemptId,
      { kind: 'provider', failure: { code: 'auth-unavailable', credentialRef } },
      new AbortController().signal,
    )).toEqual({ state: 'failed' })
    expect(harness.syncTable.get(PROJECT_A)?.currentFailure?.failure).toEqual({
      kind: 'provider',
      failure: { code: 'auth-unavailable', credentialRef },
    })

    const board = harness.synchronization.board(PROJECT_A)
    const settings = harness.synchronization.projectSettings(PROJECT_A)
    if (board === 'not-found' || settings === 'not-found') throw new Error('Project projections are missing')
    expect(board.failure?.failure).toEqual({
      kind: 'provider',
      failure: { code: 'auth-unavailable' },
    })
    expect(settings.synchronization.failure?.failure).toEqual({
      kind: 'provider',
      failure: { code: 'auth-unavailable' },
    })
  })

  it('preserves an interactive refresh that arrives while a background lease expires', async () => {
    const now = 10_000
    const date = vi.spyOn(Date, 'now').mockReturnValue(now)
    const harness = synchronizationHarness()
    try {
      await saveConfiguration(harness)
      const first = await harness.synchronization.beginScan(
        PROJECT_A,
        'background',
        now + 1_000,
        new AbortController().signal,
      )
      expect(first.ok).toBe(true)
      expect(await harness.synchronization.requestScan(
        PROJECT_A,
        'interactive',
        'interactive',
        now + 500,
        new AbortController().signal,
      )).toBe('scheduled')

      date.mockReturnValue(now + 1_000)
      const due = harness.synchronization.listDueScans(now + 1_000)[0]
      expect(due).toEqual({
        projectId: PROJECT_A,
        priority: 'interactive',
        reason: 'interactive',
        attemptAt: now + 500,
      })
      if (due === undefined) throw new Error('expired scan was not due')
      const retried = await harness.synchronization.beginScan(
        due.projectId,
        due.priority,
        now + 2_000,
        new AbortController().signal,
      )
      expect(retried).toMatchObject({ ok: true, lease: { request: { priority: 'interactive' } } })
    } finally {
      date.mockRestore()
    }
  })

  it('returns the committed begin, publish, and failure outcome when cancellation follows each write', async () => {
    const harness = synchronizationHarness()
    await saveConfiguration(harness)

    const beginCancellation = new AbortController()
    harness.syncTable.afterNextCommit = () => { beginCancellation.abort() }
    const begun = await harness.synchronization.beginScan(
      PROJECT_A,
      'background',
      Date.now() + 60_000,
      beginCancellation.signal,
    )
    expect(beginCancellation.signal.aborted).toBe(true)
    expect(begun.ok).toBe(true)
    if (!begun.ok) throw new Error('scan did not begin')

    const publishCancellation = new AbortController()
    harness.syncTable.afterNextCommit = () => { publishCancellation.abort() }
    expect(await harness.synchronization.publishScan(
      PROJECT_A,
      begun.lease.attemptId,
      boardCandidate(),
      publishCancellation.signal,
    )).toMatchObject({ state: 'published', generation: 1 })
    expect(publishCancellation.signal.aborted).toBe(true)

    const next = await begin(harness)
    const failureCancellation = new AbortController()
    harness.syncTable.afterNextCommit = () => { failureCancellation.abort() }
    expect(await harness.synchronization.failScan(
      PROJECT_A,
      next.attemptId,
      { kind: 'provider', failure: { code: 'transient-transport' } },
      failureCancellation.signal,
    )).toEqual({ state: 'failed' })
    expect(failureCancellation.signal.aborted).toBe(true)
  })

  it('orders due interactive scans ahead of earlier background work', async () => {
    const date = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const harness = synchronizationHarness([PROJECT_A, PROJECT_B])
    try {
      await saveConfiguration(harness)
      date.mockReturnValue(1_100)
      await saveConfiguration(harness, { projectId: PROJECT_B, ordinal: 2 })
      expect(await harness.synchronization.requestScan(
        PROJECT_B,
        'interactive',
        'interactive',
        1_100,
        new AbortController().signal,
      )).toBe('scheduled')

      expect(harness.synchronization.listDueScans(1_100).map(scan => scan.projectId))
        .toEqual([PROJECT_B, PROJECT_A])
    } finally {
      date.mockRestore()
    }
  })

  it('keeps an earlier interactive wake requested during a successful scan', async () => {
    const now = 20_000
    const date = vi.spyOn(Date, 'now').mockReturnValue(now)
    const harness = synchronizationHarness()
    try {
      await saveConfiguration(harness)
      const lease = await begin(harness)
      expect(await harness.synchronization.requestScan(
        PROJECT_A,
        'interactive',
        'interactive',
        now + 100,
        new AbortController().signal,
      )).toBe('scheduled')
      expect(await harness.synchronization.publishScan(
        PROJECT_A,
        lease.attemptId,
        boardCandidate(),
        new AbortController().signal,
      )).toMatchObject({ state: 'published' })

      expect(harness.syncTable.get(PROJECT_A)?.nextScanAttempt).toEqual({
        priority: 'interactive',
        reason: 'interactive',
        attemptAt: now + 100,
      })
    } finally {
      date.mockRestore()
    }
  })

  it('pairs minimum remaining capacity with the conservative reset across tied buckets', async () => {
    const harness = synchronizationHarness()
    await saveConfiguration(harness)
    const lease = await begin(harness)
    const candidate = refingerprintCandidate(boardCandidate(), {
      rateObservations: [
        {
          kind: 'graphql',
          cost: 1,
          limit: 500,
          used: 300,
          remaining: 200,
          resetAt: 50_000,
          observedAt: 9_000,
        },
        {
          kind: 'rest',
          resource: 'core',
          limit: 500,
          used: 400,
          remaining: 100,
          resetAt: 60_000,
          observedAt: 10_000,
        },
        {
          kind: 'rest',
          resource: 'search',
          limit: 500,
          used: 400,
          remaining: 100,
          resetAt: 70_000,
          observedAt: 11_000,
        },
      ],
    })

    expect(await harness.synchronization.publishScan(
      PROJECT_A,
      lease.attemptId,
      candidate,
      new AbortController().signal,
    )).toMatchObject({ state: 'published' })
    expect(harness.syncTable.get(PROJECT_A)?.checkpoint?.rateLimit).toEqual({
      state: 'available',
      minimumRemaining: 100,
      resetAt: 70_000,
      observedAt: 11_000,
    })
  })

  it('rejects hostile mapping-mismatch identities before projecting repair guidance', async () => {
    const harness = synchronizationHarness()
    const githubConfiguration = configuration()
    await saveConfiguration(harness)

    const wrongField = await begin(harness)
    await harness.synchronization.failScan(PROJECT_A, wrongField.attemptId, {
      kind: 'provider',
      failure: {
        code: 'mapping-mismatch',
        reason: 'field-missing-or-not-single-select',
        statusFieldId: githubProjectFieldId('PVTSSF_hostile_field'),
      },
    }, new AbortController().signal)
    expect(harness.syncTable.get(PROJECT_A)?.currentFailure?.failure).toEqual({
      kind: 'candidate',
      reason: 'invalid-candidate',
    })
    expect(harness.synchronization.projectSettings(PROJECT_A)).toMatchObject({
      synchronization: { mapping: { state: 'revalidation-required' } },
    })

    const wrongOption = await begin(harness)
    await harness.synchronization.failScan(PROJECT_A, wrongOption.attemptId, {
      kind: 'provider',
      failure: {
        code: 'mapping-mismatch',
        reason: 'required-options-missing',
        statusFieldId: githubConfiguration.statusFieldNodeId,
        missingRequiredStatusOptionIds: [githubProjectOptionId('option-hostile')],
      },
    }, new AbortController().signal)
    expect(harness.syncTable.get(PROJECT_A)?.currentFailure?.failure).toEqual({
      kind: 'candidate',
      reason: 'invalid-candidate',
    })

    const admitted = await begin(harness)
    await harness.synchronization.failScan(PROJECT_A, admitted.attemptId, {
      kind: 'provider',
      failure: {
        code: 'mapping-mismatch',
        reason: 'required-options-missing',
        statusFieldId: githubConfiguration.statusFieldNodeId,
        missingRequiredStatusOptionIds: [githubConfiguration.statusOptionNodeIds.ready],
      },
    }, new AbortController().signal)
    expect(harness.synchronization.projectSettings(PROJECT_A)).toMatchObject({
      synchronization: {
        mapping: {
          state: 'repair-required',
          issues: [{
            reason: 'status-option-missing',
            status: 'ready',
            statusOptionId: githubConfiguration.statusOptionNodeIds.ready,
          }],
        },
      },
    })
  })

  it('rejects an invalid candidate and projects exact unknown-option mapping defects', async () => {
    const fieldHarness = synchronizationHarness()
    await saveConfiguration(fieldHarness)
    const fieldLease = await begin(fieldHarness)
    const withoutField = refingerprintCandidate(boardCandidate(), { fields: [] })
    const fieldResult = await fieldHarness.synchronization.publishScan(
      PROJECT_A,
      fieldLease.attemptId,
      withoutField,
      new AbortController().signal,
    )
    expect(fieldResult).toEqual({
      state: 'failed',
      failure: { kind: 'candidate', reason: 'invalid-candidate' },
    })

    const unknownHarness = synchronizationHarness()
    await saveConfiguration(unknownHarness)
    const unknownLease = await begin(unknownHarness)
    const complete = boardCandidate()
    const first = complete.items[0]
    if (first === undefined) throw new Error('candidate item is missing')
    const unknown = refingerprintCandidate(complete, {
      items: [{ ...first, statusOptionId: 'option-unknown' as GitHubProjectOptionId }],
    })
    expect(await unknownHarness.synchronization.publishScan(
      PROJECT_A,
      unknownLease.attemptId,
      unknown,
      new AbortController().signal,
    )).toMatchObject({
      state: 'activation-failed',
      issues: [{ reason: 'work-item-status-unknown', statusOptionId: 'option-unknown' }],
    })

    const providerHarness = synchronizationHarness()
    await saveConfiguration(providerHarness)
    const providerLease = await begin(providerHarness)
    await providerHarness.synchronization.failScan(PROJECT_A, providerLease.attemptId, {
      kind: 'provider',
      failure: {
        code: 'mapping-mismatch',
        reason: 'field-missing-or-not-single-select',
        statusFieldId: configuration().statusFieldNodeId,
      },
    }, new AbortController().signal)
    expect(providerHarness.synchronization.projectSettings(PROJECT_A)).toMatchObject({
      synchronization: {
        mapping: { state: 'repair-required', issues: [{ reason: 'status-field-missing' }] },
      },
    })
  })

  it('expires a retained startup lease and makes its retry immediately due', async () => {
    const date = vi.spyOn(Date, 'now').mockReturnValue(30_000)
    const harness = synchronizationHarness([PROJECT_A, PROJECT_B])
    try {
      await saveConfiguration(harness)
      await saveConfiguration(harness, { projectId: PROJECT_B, ordinal: 2 })
      await harness.syncTable.update(PROJECT_B, current => ({
        ...current,
        nextScanAttempt: { priority: 'background', reason: 'poll', attemptAt: 90_000 },
      }))
      const retained = await harness.synchronization.beginScan(
        PROJECT_A,
        'background',
        90_000,
        new AbortController().signal,
      )
      expect(retained.ok).toBe(true)

      date.mockReturnValue(40_000)
      await harness.synchronization.initializeValidated(
        harness.synchronization.validateDurableState(),
        new AbortController().signal,
      )

      expect(harness.syncTable.get(PROJECT_A)).toMatchObject({
        pending: { state: 'activation-failed' },
        currentFailure: {
          failedAt: 40_000,
          failure: { kind: 'attempt', reason: 'expired' },
        },
        nextScanAttempt: { attemptAt: 40_000, reason: 'retry' },
      })
      expect(harness.syncTable.get(PROJECT_B)).toMatchObject({
        nextScanAttempt: { attemptAt: 40_000, reason: 'startup' },
      })
      expect(harness.synchronization.listDueScans(40_000)).toHaveLength(2)
    } finally {
      date.mockRestore()
    }
  })

  it('reports pending changed fields cumulatively against the active configuration', async () => {
    const harness = synchronizationHarness()
    await saveConfiguration(harness)
    const lease = await begin(harness)
    expect(await harness.synchronization.publishScan(
      PROJECT_A,
      lease.attemptId,
      boardCandidate(),
      new AbortController().signal,
    )).toMatchObject({ state: 'published' })

    await saveConfiguration(harness, {
      expectedRevision: 1,
      ordinal: 2,
      patch: { activePollIntervalMs: 45_000 },
    })
    await saveConfiguration(harness, {
      expectedRevision: 2,
      ordinal: 3,
      patch: { rateLimitReserve: 750 },
    })

    expect(harness.synchronization.projectSettings(PROJECT_A)).toMatchObject({
      synchronization: {
        active: { revision: 1 },
        pending: {
          revision: 3,
          changedFields: ['activePollIntervalMs', 'rateLimitReserve'],
          configuration: { activePollIntervalMs: 45_000, rateLimitReserve: 750 },
        },
      },
    })
  })

  it('returns an ordinary failure for active-only mapping damage and retains the checkpoint', async () => {
    const harness = synchronizationHarness()
    await saveConfiguration(harness)
    const firstLease = await begin(harness)
    expect(await harness.synchronization.publishScan(
      PROJECT_A,
      firstLease.attemptId,
      boardCandidate(),
      new AbortController().signal,
    )).toMatchObject({ state: 'published' })
    const before = structuredClone(harness.synchronization.board(PROJECT_A))

    const nextLease = await begin(harness)
    const complete = boardCandidate()
    const firstItem = complete.items[0]
    if (firstItem === undefined) throw new Error('candidate has no joined Issue')
    const { statusOptionId: _statusOptionId, ...missingStatus } = firstItem
    const failed = await harness.synchronization.publishScan(
      PROJECT_A,
      nextLease.attemptId,
      refingerprintCandidate(complete, { items: [missingStatus] }),
      new AbortController().signal,
    )

    expect(failed).toMatchObject({ state: 'failed', failure: { kind: 'mapping' } })
    expect(harness.synchronization.board(PROJECT_A)).toMatchObject({
      state: 'confirmed',
      confirmed: (before as { readonly confirmed?: unknown }).confirmed,
      checkpoint: (before as { readonly checkpoint?: unknown }).checkpoint,
      failure: { configurationRevision: 1, failure: { kind: 'mapping' } },
    })
  })

  it('rejects distinct Project items that repeat one configured-repository Issue', async () => {
    const harness = synchronizationHarness()
    await saveConfiguration(harness)
    const firstLease = await begin(harness)
    expect(await harness.synchronization.publishScan(
      PROJECT_A,
      firstLease.attemptId,
      boardCandidate(),
      new AbortController().signal,
    )).toMatchObject({ state: 'published' })
    const before = harness.syncTable.get(PROJECT_A)
    const nextLease = await begin(harness)
    const complete = boardCandidate()
    const firstItem = complete.items[0]
    if (firstItem === undefined) throw new Error('candidate has no Project item')
    const duplicate = refingerprintCandidate(complete, {
      items: [firstItem, {
        ...firstItem,
        id: 'PVTI_saki_test_item_duplicate' as GitHubProjectItemId,
        apiOrder: 1,
      }],
      fences: {
        before: { ...complete.fences.before, projectItemCount: 2 },
        after: { ...complete.fences.after, projectItemCount: 2 },
      },
    })

    expect(await harness.synchronization.publishScan(
      PROJECT_A,
      nextLease.attemptId,
      duplicate,
      new AbortController().signal,
    )).toEqual({ state: 'failed', failure: { kind: 'candidate', reason: 'invalid-candidate' } })
    expect(harness.syncTable.get(PROJECT_A)).toMatchObject({
      confirmedBoard: before?.confirmedBoard,
      checkpoint: before?.checkpoint,
      currentFailure: { failure: { kind: 'candidate', reason: 'invalid-candidate' } },
    })
  })

  it('maps only configured-repository Issues and atomically removes absent work', async () => {
    const harness = synchronizationHarness()
    const githubConfiguration = configuration()
    await saveConfiguration(harness)
    const base = boardCandidate(githubConfiguration)
    const joined = issue(27, githubConfiguration)
    const archived = issue(28, githubConfiguration, 'closed')
    const unjoined = issue(29, githubConfiguration)
    const otherRepository = {
      ...issue(30, githubConfiguration),
      id: githubIssueId('I_saki_other_repository_issue'),
      repositoryId: githubRepositoryId('R_saki_other_repository'),
      repositoryDatabaseId: githubRepositoryDatabaseId('99999999'),
    }
    const items: GitHubProjectBoardScanCandidate['items'] = [
      {
        ...base.items[0]!,
        content: { kind: 'issue' as const, issue: joined },
      },
      {
        id: 'PVTI_saki_test_item_28' as GitHubProjectItemId,
        projectId: githubConfiguration.projectNodeId,
        content: { kind: 'issue' as const, issue: archived },
        archived: true,
        apiOrder: 1,
        updatedAt: 9_000,
      },
      {
        id: 'PVTI_saki_test_item_other_repository' as GitHubProjectItemId,
        projectId: githubConfiguration.projectNodeId,
        content: { kind: 'issue' as const, issue: otherRepository },
        statusOptionId: githubConfiguration.statusOptionNodeIds.done,
        archived: false,
        apiOrder: 2,
        updatedAt: 9_000,
      },
      {
        id: 'PVTI_saki_test_item_pull_request' as GitHubProjectItemId,
        projectId: githubConfiguration.projectNodeId,
        content: {
          kind: 'pull-request' as const,
          id: githubPullRequestId('PR_saki_test_pull_request'),
          repositoryId: githubConfiguration.repositoryNodeId,
          url: 'https://github.example.invalid/saki/pull/31',
        },
        archived: false,
        apiOrder: 3,
        updatedAt: 9_000,
      },
      {
        id: 'PVTI_saki_test_item_draft' as GitHubProjectItemId,
        projectId: githubConfiguration.projectNodeId,
        content: { kind: 'draft-issue' as const, title: 'Private draft' },
        archived: false,
        apiOrder: 4,
        updatedAt: 9_000,
      },
      {
        id: 'PVTI_saki_test_item_redacted' as GitHubProjectItemId,
        projectId: githubConfiguration.projectNodeId,
        content: { kind: 'redacted' as const },
        archived: false,
        apiOrder: 5,
        updatedAt: 9_000,
      },
    ]
    const matrix = refingerprintCandidate(base, {
      items,
      openIssues: [joined, unjoined],
      fences: {
        before: { ...base.fences.before, projectItemCount: items.length, openIssueCount: 2 },
        after: { ...base.fences.after, projectItemCount: items.length, openIssueCount: 2 },
      },
    })
    const firstLease = await begin(harness)
    expect(await harness.synchronization.publishScan(
      PROJECT_A,
      firstLease.attemptId,
      matrix,
      new AbortController().signal,
    )).toMatchObject({ state: 'published', generation: 1 })
    expect(harness.syncTable.get(PROJECT_A)?.confirmedBoard?.items).toMatchObject([
      { issueNumber: 27, status: 'ready', archived: false, notInProject: false, order: 0 },
      { issueNumber: 28, status: 'canceled', archived: true, notInProject: false, order: 1 },
      { issueNumber: 29, status: 'inbox', archived: false, notInProject: true, order: 6 },
    ])

    const empty = refingerprintCandidate(base, {
      items: [],
      openIssues: [],
      fences: {
        before: { ...base.fences.before, projectItemCount: 0, openIssueCount: 0 },
        after: { ...base.fences.after, projectItemCount: 0, openIssueCount: 0 },
      },
    })
    const secondLease = await begin(harness)
    expect(await harness.synchronization.publishScan(
      PROJECT_A,
      secondLease.attemptId,
      empty,
      new AbortController().signal,
    )).toMatchObject({ state: 'published', generation: 2 })
    expect(harness.syncTable.get(PROJECT_A)?.confirmedBoard?.items).toEqual([])
  })

  it('retains the latest non-terminal Status across complete Board generations', async () => {
    const recoveries: GitHubWorkItemRecoveryMemory[] = []
    const harness = synchronizationHarness([PROJECT_A], () => true, () => recoveries.at(-1))
    const githubConfiguration = configuration()
    await saveConfiguration(harness)

    const firstLease = await begin(harness)
    expect(await harness.synchronization.publishScan(
      PROJECT_A,
      firstLease.attemptId,
      boardCandidate(githubConfiguration),
      new AbortController().signal,
    )).toMatchObject({ state: 'published', generation: 1 })
    expect(harness.syncTable.get(PROJECT_A)?.confirmedBoard?.items[0])
      .toMatchObject({ status: 'ready', latestNonTerminalStatus: 'ready' })

    const base = boardCandidate(githubConfiguration)
    const closedIssue = issue(27, githubConfiguration, 'closed')
    const terminal = refingerprintCandidate(base, {
      items: [{
        ...base.items[0]!,
        content: { kind: 'issue', issue: closedIssue },
        statusOptionId: githubConfiguration.statusOptionNodeIds.done,
        updatedAt: 10_000,
      }],
      openIssues: [],
      fences: {
        before: { ...base.fences.before, openIssueCount: 0 },
        after: { ...base.fences.after, openIssueCount: 0 },
      },
    })
    const secondLease = await begin(harness)
    expect(await harness.synchronization.publishScan(
      PROJECT_A,
      secondLease.attemptId,
      terminal,
      new AbortController().signal,
    )).toMatchObject({ state: 'published', generation: 2 })
    expect(harness.syncTable.get(PROJECT_A)?.confirmedBoard?.items[0])
      .toMatchObject({ status: 'done', latestNonTerminalStatus: 'ready' })

    recoveries.push({
      latestNonTerminalStatus: 'in-review',
      observedAt: 10_001,
      repositoryId: githubConfiguration.repositoryNodeId,
      repositoryDatabaseId: githubConfiguration.repositoryDatabaseId,
      projectId: githubConfiguration.projectNodeId,
      statusFieldId: githubConfiguration.statusFieldNodeId,
    })
    const thirdLease = await begin(harness)
    expect(await harness.synchronization.publishScan(
      PROJECT_A,
      thirdLease.attemptId,
      refingerprintCandidate(terminal, { observedAt: 10_002 }),
      new AbortController().signal,
    )).toMatchObject({ state: 'published', generation: 3 })
    expect(harness.syncTable.get(PROJECT_A)?.confirmedBoard?.items[0])
      .toMatchObject({ status: 'done', latestNonTerminalStatus: 'in-review' })
  })

  it('ignores stale, future, or differently bound targeted Status memory during a complete scan', async () => {
    let recovery: GitHubWorkItemRecoveryMemory | undefined
    const harness = synchronizationHarness([PROJECT_A], () => true, () => recovery)
    const githubConfiguration = configuration()
    await saveConfiguration(harness)

    const firstLease = await begin(harness)
    await harness.synchronization.publishScan(
      PROJECT_A,
      firstLease.attemptId,
      boardCandidate(githubConfiguration),
      new AbortController().signal,
    )
    const workItemId = harness.syncTable.get(PROJECT_A)?.confirmedBoard?.items[0]?.id
    if (workItemId === undefined) throw new Error('confirmed Work Item fixture is missing')
    const base = boardCandidate(githubConfiguration)
    const terminal = refingerprintCandidate(base, {
      items: [{
        ...base.items[0]!,
        content: { kind: 'issue', issue: issue(27, githubConfiguration, 'closed') },
        statusOptionId: githubConfiguration.statusOptionNodeIds.done,
      }],
      openIssues: [],
      fences: {
        before: { ...base.fences.before, openIssueCount: 0 },
        after: { ...base.fences.after, openIssueCount: 0 },
      },
    })
    const memory = {
      latestNonTerminalStatus: 'in-review',
      repositoryId: githubConfiguration.repositoryNodeId,
      repositoryDatabaseId: githubConfiguration.repositoryDatabaseId,
      projectId: githubConfiguration.projectNodeId,
      statusFieldId: githubConfiguration.statusFieldNodeId,
    } as const

    recovery = { ...memory, observedAt: 9_999 }
    const staleLease = await begin(harness)
    await harness.synchronization.publishScan(
      PROJECT_A,
      staleLease.attemptId,
      refingerprintCandidate(terminal, { observedAt: 10_002 }),
      new AbortController().signal,
    )
    expect(harness.syncTable.get(PROJECT_A)?.confirmedBoard?.items.find(item => item.id === workItemId))
      .toMatchObject({ latestNonTerminalStatus: 'ready' })

    recovery = { ...memory, observedAt: 10_005 }
    const futureLease = await begin(harness)
    await harness.synchronization.publishScan(
      PROJECT_A,
      futureLease.attemptId,
      refingerprintCandidate(terminal, { observedAt: 10_004 }),
      new AbortController().signal,
    )
    expect(harness.syncTable.get(PROJECT_A)?.confirmedBoard?.items.find(item => item.id === workItemId))
      .toMatchObject({ latestNonTerminalStatus: 'ready' })

    recovery = { ...memory, observedAt: 10_005, projectId: githubProjectId('PVT_saki_other_project') }
    const reboundLease = await begin(harness)
    await harness.synchronization.publishScan(
      PROJECT_A,
      reboundLease.attemptId,
      refingerprintCandidate(terminal, { observedAt: 10_006 }),
      new AbortController().signal,
    )
    expect(harness.syncTable.get(PROJECT_A)?.confirmedBoard?.items.find(item => item.id === workItemId))
      .toMatchObject({ latestNonTerminalStatus: 'ready' })
  })

  it('records no invented non-terminal Status for a terminal first observation', async () => {
    const harness = synchronizationHarness()
    const githubConfiguration = configuration()
    await saveConfiguration(harness)
    const base = boardCandidate(githubConfiguration)
    const terminal = refingerprintCandidate(base, {
      items: [{
        ...base.items[0]!,
        statusOptionId: githubConfiguration.statusOptionNodeIds.canceled,
      }],
    })

    const lease = await begin(harness)
    expect(await harness.synchronization.publishScan(
      PROJECT_A,
      lease.attemptId,
      terminal,
      new AbortController().signal,
    )).toMatchObject({ state: 'published', generation: 1 })
    expect(harness.syncTable.get(PROJECT_A)?.confirmedBoard?.items[0])
      .toMatchObject({ status: 'canceled', latestNonTerminalStatus: null })
  })

  it('rejects invalid aggregate revisions and empty pending changes at the owning schemas', async () => {
    const revisedEmpty = mutableRecord(emptySyncRecord())
    revisedEmpty.revision = 1
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(revisedEmpty)))
      .toContain('synchronization revision disagrees with its current configuration')

    const pendingHarness = synchronizationHarness()
    await saveConfiguration(pendingHarness)
    const pending = pendingHarness.syncTable.get(PROJECT_A)
    const savedIntent = pendingHarness.intentTable.get(intentId(1))
    if (pending?.pending === undefined || savedIntent === undefined) throw new Error('pending fixture is incomplete')

    const zeroPending = mutableRecord(pending)
    zeroPending.pending!.revision = 0
    expect(issuePaths(githubProjectSyncRecordSchema.safeParse(zeroPending)))
      .toContainEqual(['pending', 'revision'])

    const emptyChanges = mutableRecord(pending)
    emptyChanges.pending!.changedFields = []
    expect(issuePaths(githubProjectSyncRecordSchema.safeParse(emptyChanges)))
      .toContainEqual(['pending', 'changedFields'])

    const repeatedChanges = mutableRecord(pending)
    repeatedChanges.pending!.changedFields = ['rateLimitReserve', 'rateLimitReserve']
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(repeatedChanges)))
      .toContain('pending configuration repeats changed fields')

    const repeatedStatusOption = mutableRecord(pending)
    repeatedStatusOption.pending!.configuration.statusOptionNodeIds.done
      = repeatedStatusOption.pending!.configuration.statusOptionNodeIds.ready
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(repeatedStatusOption)))
      .toContain('GitHub Status option ids must be distinct')

    const mismatchedRevision = mutableRecord(pending)
    mismatchedRevision.revision = 0
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(mismatchedRevision)))
      .toContain('synchronization revision disagrees with its current configuration')

    const skippedCandidateRevision = mutableRecord(pending)
    skippedCandidateRevision.nextCandidateRevision += 1
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(skippedCandidateRevision)))
      .toContain('next candidate revision does not immediately follow the current configuration')

    const activeHarness = await confirmedHarness()
    const active = activeHarness.syncTable.get(PROJECT_A)
    if (active?.active === undefined) throw new Error('active fixture is incomplete')
    const zeroActive = mutableRecord(active)
    zeroActive.active!.revision = 0
    expect(issuePaths(githubProjectSyncRecordSchema.safeParse(zeroActive)))
      .toContainEqual(['active', 'revision'])

    for (const field of ['candidateRevision', 'synchronizationRevision'] as const) {
      const malformed = structuredClone(savedIntent)
      malformed[field] = 0
      const result = githubSynchronizationConfigurationIntentRecordSchema.safeParse(malformed)
      expect(result.success ? [] : result.error.issues.map(value => value.path.map(String)))
        .toContainEqual([field])
    }

    const intentIssue = (
      mutate: (candidate: Mutable<NonNullable<typeof savedIntent>>) => void,
      message: string,
    ): void => {
      const candidate = structuredClone(savedIntent)
      mutate(candidate)
      expect(issueMessages(githubSynchronizationConfigurationIntentRecordSchema.safeParse(candidate)))
        .toContain(message)
    }
    intentIssue((candidate) => {
      candidate.id = intentId(98)
    }, 'Intent id disagrees with immutable payload')
    intentIssue((candidate) => {
      candidate.receiptId = sakiIntentReceiptIdSchema.parse('receipt-00000000-0000-4000-8000-000000000098')
    }, 'receipt id disagrees with Intent id')
    intentIssue((candidate) => {
      candidate.payloadDigest = '0'.repeat(64)
    }, 'Intent payload digest is stale')
    intentIssue((candidate) => {
      candidate.updatedAt = candidate.createdAt - 1
    }, 'Intent update predates creation')
    intentIssue((candidate) => {
      delete candidate.candidateRevision
    }, 'saved Intent evidence is incomplete')
    intentIssue((candidate) => {
      candidate.phase = 'prepared'
    }, 'non-saved Intent retains candidate evidence')
    intentIssue((candidate) => {
      candidate.phase = 'prepared'
      delete candidate.candidateRevision
      delete candidate.synchronizationRevision
      candidate.terminalReason = 'expected-revision'
    }, 'Intent terminal reason disagrees with phase')
    intentIssue((candidate) => {
      candidate.phase = 'failure'
      delete candidate.candidateRevision
      delete candidate.synchronizationRevision
      candidate.terminalReason = 'expected-revision'
    }, 'failure phase has an invalid terminal reason')
    intentIssue((candidate) => {
      candidate.phase = 'conflict'
      delete candidate.candidateRevision
      delete candidate.synchronizationRevision
      candidate.terminalReason = 'authority'
    }, 'conflict phase has an invalid terminal reason')
  })

  it('rejects inconsistent Board, checkpoint, failure, and scheduling relationships durably', async () => {
    const harness = await confirmedHarness()
    const record = harness.syncTable.get(PROJECT_A)
    if (record?.active === undefined || record.confirmedBoard === undefined || record.checkpoint === undefined) {
      throw new Error('confirmed fixture is incomplete')
    }

    const checkpointTargets: Array<(candidate: Mutable<GitHubProjectSyncRecord>) => void> = [
      (candidate) => { candidate.checkpoint!.installationId = githubInstallationId('99999999') },
      (candidate) => { candidate.checkpoint!.repositoryId = githubRepositoryId('R_saki_wrong_repository') },
      (candidate) => { candidate.checkpoint!.projectId = githubProjectId('PVT_saki_wrong_project') },
      (candidate) => { candidate.checkpoint!.statusFieldId = githubProjectFieldId('PVTSSF_saki_wrong_status') },
    ]
    for (const mutate of checkpointTargets) {
      const candidate = mutableRecord(record)
      mutate(candidate)
      expect(issueMessages(githubProjectSyncRecordSchema.safeParse(candidate)))
        .toContain('checkpoint target disagrees with active configuration')
    }

    const boardRepository = mutableRecord(record)
    boardRepository.confirmedBoard!.repository.id = githubRepositoryId('R_saki_wrong_repository')
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(boardRepository)))
      .toContain('confirmed Board target disagrees with its checkpoint')

    const boardProject = mutableRecord(record)
    boardProject.confirmedBoard!.project.id = githubProjectId('PVT_saki_wrong_project')
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(boardProject)))
      .toContain('confirmed Board target disagrees with its checkpoint')

    const sourceRepository = mutableRecord(record)
    sourceRepository.confirmedBoard!.items[0]!.source.repositoryId = githubRepositoryId('R_saki_wrong_repository')
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(sourceRepository)))
      .toContain('confirmed Board contains a Work Item from another Repository')

    const derivedId = mutableRecord(record)
    derivedId.confirmedBoard!.items[0]!.id = sakiBoardWorkItemIdSchema.parse(`work-item-${'a'.repeat(64)}`)
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(derivedId)))
      .toContain('Work Item id disagrees with its GitHub Issue identity')

    const repeatedIssue = mutableRecord(record)
    const firstItem = repeatedIssue.confirmedBoard!.items[0]!
    repeatedIssue.confirmedBoard!.items.push({
      ...structuredClone(firstItem),
      order: firstItem.order + 1,
    })
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(repeatedIssue)))
      .toContain('confirmed Board repeats a GitHub Issue identity')

    const repeatedIssueNumber = mutableRecord(record)
    const numberedItem = structuredClone(repeatedIssueNumber.confirmedBoard!.items[0]!)
    numberedItem.source.issueId = 'I_saki_test_distinct_issue' as GitHubIssueId
    numberedItem.id = sakiBoardWorkItemIdSchema.parse(`work-item-${canonicalDigest('saki/board-work-item/v1', {
      repositoryId: numberedItem.source.repositoryId,
      issueId: numberedItem.source.issueId,
    })}`)
    numberedItem.order += 1
    numberedItem.source.apiOrder = numberedItem.order
    numberedItem.source.projectItemId = 'PVTI_saki_test_distinct_item' as GitHubProjectItemId
    repeatedIssueNumber.confirmedBoard!.items.push(numberedItem)
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(repeatedIssueNumber)))
      .toContain('confirmed Board repeats a GitHub Issue number')

    const repeatedProjectItem = mutableRecord(record)
    const repeatedProjectItemValue = structuredClone(numberedItem)
    repeatedProjectItemValue.issueNumber += 1
    repeatedProjectItemValue.source.projectItemId = repeatedProjectItem.confirmedBoard!.items[0]!.source.projectItemId
    repeatedProjectItem.confirmedBoard!.items.push(repeatedProjectItemValue)
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(repeatedProjectItem)))
      .toContain('confirmed Board repeats a GitHub Project Item identity')

    const joinedOrder = mutableRecord(record)
    joinedOrder.confirmedBoard!.items[0]!.order += 1
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(joinedOrder)))
      .toContain('joined Work Item order disagrees with its Project API order')

    const projectItemOnly = mutableRecord(record)
    delete projectItemOnly.confirmedBoard!.items[0]!.source.apiOrder
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(projectItemOnly)))
      .toContain('joined Work Item source evidence is incomplete')

    const apiOrderOnly = mutableRecord(record)
    delete apiOrderOnly.confirmedBoard!.items[0]!.source.projectItemId
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(apiOrderOnly)))
      .toContain('joined Work Item source evidence is incomplete')

    const joinedMarkedAbsent = mutableRecord(record)
    joinedMarkedAbsent.confirmedBoard!.items[0]!.notInProject = true
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(joinedMarkedAbsent)))
      .toContain('Work Item membership disagrees with its source evidence')

    const unjoinedWrongStatus = mutableRecord(record)
    delete unjoinedWrongStatus.confirmedBoard!.items[0]!.source.projectItemId
    delete unjoinedWrongStatus.confirmedBoard!.items[0]!.source.apiOrder
    unjoinedWrongStatus.confirmedBoard!.items[0]!.notInProject = true
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(unjoinedWrongStatus)))
      .toContain('unjoined Work Item must be an unarchived Inbox card')

    const unjoinedArchived = mutableRecord(record)
    delete unjoinedArchived.confirmedBoard!.items[0]!.source.projectItemId
    delete unjoinedArchived.confirmedBoard!.items[0]!.source.apiOrder
    unjoinedArchived.confirmedBoard!.items[0]!.notInProject = true
    unjoinedArchived.confirmedBoard!.items[0]!.status = 'inbox'
    unjoinedArchived.confirmedBoard!.items[0]!.archived = true
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(unjoinedArchived)))
      .toContain('unjoined Work Item must be an unarchived Inbox card')

    const archivedNotCanceled = mutableRecord(record)
    archivedNotCanceled.confirmedBoard!.items[0]!.archived = true
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(archivedNotCanceled)))
      .toContain('archived Work Item must be Canceled')

    const staleLatestStatus = mutableRecord(record)
    staleLatestStatus.confirmedBoard!.items[0]!.latestNonTerminalStatus = 'backlog'
    expect(issueMessages(currentGitHubProjectSyncRecordSchema.safeParse(staleLatestStatus)))
      .toContain('non-terminal Work Item must remember its current Status')

    const { latestNonTerminalStatus: _latestNonTerminalStatus, ...itemWithoutLatestStatus }
      = structuredClone(record.confirmedBoard.items[0]!)
    const missingLatestStatus = currentGitHubProjectSyncRecordSchema.safeParse({
      ...record,
      confirmedBoard: { ...record.confirmedBoard, items: [itemWithoutLatestStatus] },
    })
    expect(issuePaths(missingLatestStatus)).toContainEqual([
      'confirmedBoard', 'items', '0', 'latestNonTerminalStatus',
    ])

    const closedUnjoined = mutableRecord(record)
    const closedItem = closedUnjoined.confirmedBoard!.items[0]!
    delete closedItem.source.projectItemId
    delete closedItem.source.apiOrder
    closedItem.notInProject = true
    closedItem.status = 'inbox'
    closedItem.issueState = 'closed'
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(closedUnjoined)))
      .toContain('unjoined Work Item must retain an open Issue')

    const unordered = mutableRecord(record)
    const unorderedItem = structuredClone(numberedItem)
    unorderedItem.issueNumber += 1
    unorderedItem.order = unordered.confirmedBoard!.items[0]!.order
    unorderedItem.source.apiOrder = unorderedItem.order
    unordered.confirmedBoard!.items.push(unorderedItem)
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(unordered)))
      .toContain('confirmed Board Work Item order must be strictly increasing')

    const joinedAfterUnjoined = mutableRecord(record)
    const unjoinedItem = joinedAfterUnjoined.confirmedBoard!.items[0]!
    delete unjoinedItem.source.projectItemId
    delete unjoinedItem.source.apiOrder
    unjoinedItem.notInProject = true
    unjoinedItem.status = 'inbox'
    const lateJoined = structuredClone(numberedItem)
    lateJoined.issueNumber += 1
    lateJoined.order = unjoinedItem.order + 1
    lateJoined.source.apiOrder = lateJoined.order
    joinedAfterUnjoined.confirmedBoard!.items.push(lateJoined)
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(joinedAfterUnjoined)))
      .toContain('confirmed Board must order joined Work Items before unjoined Work Items')

    const reversedCheckpointTime = mutableRecord(record)
    reversedCheckpointTime.checkpoint!.confirmedAt = reversedCheckpointTime.checkpoint!.observedAt - 1
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(reversedCheckpointTime)))
      .toContain('checkpoint confirmation cannot precede its observation')

    const boardWithoutCheckpoint = mutableRecord(record)
    delete boardWithoutCheckpoint.checkpoint
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(boardWithoutCheckpoint)))
      .toContain('confirmed Board and checkpoint must be retained together')

    const checkpointWithoutBoard = mutableRecord(record)
    delete checkpointWithoutBoard.confirmedBoard
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(checkpointWithoutBoard)))
      .toContain('confirmed Board and checkpoint must be retained together')

    const boardWithoutActive = mutableRecord(record)
    delete boardWithoutActive.active
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(boardWithoutActive)))
      .toContain('active configuration and confirmed Board must be retained together')

    const activeWithoutBoard = mutableRecord(record)
    delete activeWithoutBoard.confirmedBoard
    delete activeWithoutBoard.checkpoint
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(activeWithoutBoard)))
      .toContain('active configuration and confirmed Board must be retained together')

    const staleBoardGeneration = mutableRecord(record)
    staleBoardGeneration.nextBoardGeneration = staleBoardGeneration.confirmedBoard!.generation
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(staleBoardGeneration)))
      .toContain('next Board generation is not monotonic')

    const advancedEmptyBoard = mutableRecord(emptySyncRecord())
    advancedEmptyBoard.nextBoardGeneration = 2
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(advancedEmptyBoard)))
      .toContain('Board generation advanced without a confirmed Board')

    const activatingHarness = synchronizationHarness()
    await saveConfiguration(activatingHarness)
    await begin(activatingHarness)
    const activating = activatingHarness.syncTable.get(PROJECT_A)
    if (activating?.pending === undefined || activating.inFlightAttempt === undefined) {
      throw new Error('activating fixture is incomplete')
    }
    const stalePending = mutableRecord(record)
    stalePending.pending = structuredClone(activating.pending)
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(stalePending)))
      .toContain('pending configuration does not follow active configuration')

    const wrongAttemptRevision = mutableRecord(activating)
    wrongAttemptRevision.inFlightAttempt!.configurationRevision += 1
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(wrongAttemptRevision)))
      .toContain('in-flight scan does not target the current configuration')

    const activatingWithoutAttempt = mutableRecord(activating)
    delete activatingWithoutAttempt.inFlightAttempt
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(activatingWithoutAttempt)))
      .toContain('activating configuration has no matching in-flight scan')

    const failedWithoutFailure = mutableRecord(activating)
    failedWithoutFailure.pending!.state = 'activation-failed'
    delete failedWithoutFailure.inFlightAttempt
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(failedWithoutFailure)))
      .toContain('failed configuration has no matching current failure')

    const directWrongField = mutableRecord(record)
    directWrongField.currentFailure = {
      attemptId: sakiGitHubScanAttemptIdSchema.parse('scan-attempt-00000000-0000-4000-8000-000000000110'),
      configurationRevision: record.active.revision,
      failedAt: 10_001,
      failure: {
        kind: 'mapping',
        issues: [{
          reason: 'status-field-missing',
          statusFieldId: githubProjectFieldId('PVTSSF_saki_wrong_status'),
        }],
      },
    }
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(directWrongField)))
      .toContain('current mapping failure disagrees with the current Status field')

    const directWrongOption = mutableRecord(record)
    directWrongOption.currentFailure = {
      attemptId: sakiGitHubScanAttemptIdSchema.parse('scan-attempt-00000000-0000-4000-8000-000000000111'),
      configurationRevision: record.active.revision,
      failedAt: 10_001,
      failure: {
        kind: 'mapping',
        issues: [{
          reason: 'status-option-missing',
          status: 'ready',
          statusOptionId: record.active.configuration.statusOptionNodeIds.done,
        }],
      },
    }
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(directWrongOption)))
      .toContain('current mapping failure disagrees with the current Status options')

    const configuredUnknownWorkItemOption = mutableRecord(record)
    configuredUnknownWorkItemOption.currentFailure = {
      attemptId: sakiGitHubScanAttemptIdSchema.parse('scan-attempt-00000000-0000-4000-8000-000000000113'),
      configurationRevision: record.active.revision,
      failedAt: 10_001,
      failure: {
        kind: 'mapping',
        issues: [{
          reason: 'work-item-status-unknown',
          issueId: githubIssueId('I_saki_configured_mapping_option'),
          statusOptionId: record.active.configuration.statusOptionNodeIds.ready,
        }],
      },
    }
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(configuredUnknownWorkItemOption)))
      .toContain('current mapping failure treats a configured Status option as unknown')

    const unknownWorkItemOption = mutableRecord(record)
    unknownWorkItemOption.currentFailure = {
      attemptId: sakiGitHubScanAttemptIdSchema.parse('scan-attempt-00000000-0000-4000-8000-000000000112'),
      configurationRevision: record.active.revision,
      failedAt: 10_001,
      failure: {
        kind: 'mapping',
        issues: [{
          reason: 'work-item-status-unknown',
          issueId: githubIssueId('I_saki_unknown_mapping_option'),
          statusOptionId: githubProjectOptionId('option-not-configured'),
        }],
      },
    }
    expect(githubProjectSyncRecordSchema.safeParse(unknownWorkItemOption).success).toBe(true)

    const mismatchedMappingFailure = mutableRecord(record)
    mismatchedMappingFailure.currentFailure = {
      attemptId: sakiGitHubScanAttemptIdSchema.parse('scan-attempt-00000000-0000-4000-8000-000000000107'),
      configurationRevision: record.active.revision,
      failedAt: 10_001,
      failure: {
        kind: 'provider',
        failure: {
          code: 'mapping-mismatch',
          reason: 'field-missing-or-not-single-select',
          statusFieldId: githubProjectFieldId('PVTSSF_saki_wrong_status'),
        },
      },
    }
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(mismatchedMappingFailure)))
      .toContain('current mapping failure disagrees with the checkpoint Status field')

    const unconfiguredMappingOption = mutableRecord(record)
    unconfiguredMappingOption.currentFailure = {
      attemptId: sakiGitHubScanAttemptIdSchema.parse('scan-attempt-00000000-0000-4000-8000-000000000109'),
      configurationRevision: record.active.revision,
      failedAt: 10_001,
      failure: {
        kind: 'provider',
        failure: {
          code: 'mapping-mismatch',
          reason: 'required-options-missing',
          statusFieldId: record.active.configuration.statusFieldNodeId,
          missingRequiredStatusOptionIds: [githubProjectOptionId('option-hostile')],
        },
      },
    }
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(unconfiguredMappingOption)))
      .toContain('current mapping failure names an unconfigured Status option')

    const configuredMissingOption = mutableRecord(record)
    configuredMissingOption.currentFailure = {
      attemptId: sakiGitHubScanAttemptIdSchema.parse('scan-attempt-00000000-0000-4000-8000-000000000114'),
      configurationRevision: record.active.revision,
      failedAt: 10_001,
      failure: {
        kind: 'provider',
        failure: {
          code: 'mapping-mismatch',
          reason: 'required-options-missing',
          statusFieldId: record.active.configuration.statusFieldNodeId,
          missingRequiredStatusOptionIds: [record.active.configuration.statusOptionNodeIds.ready],
        },
      },
    }
    expect(githubProjectSyncRecordSchema.safeParse(configuredMissingOption).success).toBe(true)

    const newerMappingFailure = mutableRecord(record)
    newerMappingFailure.revision += 1
    newerMappingFailure.nextCandidateRevision += 1
    newerMappingFailure.pending = {
      revision: record.active.revision + 1,
      state: 'activation-failed',
      configuration: {
        ...structuredClone(record.active.configuration),
        statusFieldNodeId: githubProjectFieldId('PVTSSF_saki_new_status'),
      },
      changedFields: ['statusFieldNodeId'],
      acceptedIntentId: intentId(108),
      receiptId: sakiIntentReceiptIdSchema.parse('receipt-00000000-0000-4000-8000-000000000108'),
      savedAt: 10_001,
    }
    newerMappingFailure.currentFailure = {
      attemptId: sakiGitHubScanAttemptIdSchema.parse('scan-attempt-00000000-0000-4000-8000-000000000108'),
      configurationRevision: record.active.revision + 1,
      failedAt: 10_002,
      failure: {
        kind: 'provider',
        failure: {
          code: 'mapping-mismatch',
          reason: 'field-missing-or-not-single-select',
          statusFieldId: githubProjectFieldId('PVTSSF_saki_new_status'),
        },
      },
    }
    expect(githubProjectSyncRecordSchema.safeParse(newerMappingFailure).success).toBe(true)

    const wrongFailureRevision = mutableRecord(record)
    wrongFailureRevision.currentFailure = {
      attemptId: sakiGitHubScanAttemptIdSchema.parse('scan-attempt-00000000-0000-4000-8000-000000000106'),
      configurationRevision: 2,
      failedAt: 10_000,
      failure: { kind: 'candidate', reason: 'invalid-candidate' },
    }
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(wrongFailureRevision)))
      .toContain('current failure does not target the current configuration')

    const pendingHarness = synchronizationHarness()
    await saveConfiguration(pendingHarness)
    const pendingRecord = pendingHarness.syncTable.get(PROJECT_A)
    if (pendingRecord === undefined) throw new Error('pending fixture is unavailable')
    const unconfiguredSchedule = mutableRecord(pendingRecord)
    delete unconfiguredSchedule.pending
    expect(issueMessages(githubProjectSyncRecordSchema.safeParse(unconfiguredSchedule)))
      .toContain('scan is scheduled without a synchronization configuration')
  })

  it('rejects Board text and URL values that the browser-safe Host wire cannot project', async () => {
    const harness = await confirmedHarness()
    const record = harness.syncTable.get(PROJECT_A)
    if (record?.confirmedBoard === undefined) throw new Error('confirmed fixture is incomplete')
    const invalidValues: Array<(candidate: Mutable<GitHubProjectSyncRecord>) => void> = [
      (candidate) => { candidate.confirmedBoard!.items[0]!.title = `x${String.fromCharCode(0)}` },
      (candidate) => { candidate.confirmedBoard!.items[0]!.title = 'x'.repeat(4_097) },
      (candidate) => { candidate.confirmedBoard!.project.title = `x${String.fromCharCode(127)}` },
      (candidate) => { candidate.confirmedBoard!.repository.nameWithOwner = 'missing-slash' },
      (candidate) => { candidate.confirmedBoard!.repository.nameWithOwner = `${'o'.repeat(101)}/${'r'.repeat(101)}` },
      (candidate) => { candidate.confirmedBoard!.repository.nameWithOwner = `owner/repo${String.fromCharCode(31)}` },
      (candidate) => { candidate.confirmedBoard!.items[0]!.url = 'javascript:alert(1)' },
      (candidate) => { candidate.confirmedBoard!.items[0]!.url = 'http://github.example.invalid/saki/issues/27' },
      (candidate) => { candidate.confirmedBoard!.repository.url = 'https://user:pass@github.example.invalid/saki' },
      (candidate) => { candidate.confirmedBoard!.project.url = 'https://github.example.invalid/project#fragment' },
      (candidate) => { candidate.confirmedBoard!.project.url = `https://github.example.invalid/${'x'.repeat(2_100)}` },
    ]

    for (const mutate of invalidValues) {
      const candidate = mutableRecord(record)
      mutate(candidate)
      expect(githubProjectSyncRecordSchema.safeParse(candidate).success).toBe(false)
    }
  })

  it('rejects durable integers after JavaScript loses exact identity', async () => {
    const harness = await confirmedHarness()
    const record = harness.syncTable.get(PROJECT_A)
    if (record?.confirmedBoard === undefined || record.checkpoint === undefined) {
      throw new Error('confirmed fixture is incomplete')
    }
    const unsafe = Number.MAX_SAFE_INTEGER + 1
    const invalidIntegers: Array<(candidate: Mutable<GitHubProjectSyncRecord>) => void> = [
      (candidate) => { candidate.revision = unsafe },
      (candidate) => { candidate.nextCandidateRevision = unsafe },
      (candidate) => { candidate.nextBoardGeneration = unsafe },
      (candidate) => { candidate.confirmedBoard!.items[0]!.order = unsafe },
      (candidate) => { candidate.confirmedBoard!.items[0]!.issueNumber = unsafe },
      (candidate) => { candidate.confirmedBoard!.items[0]!.source.apiOrder = unsafe },
      (candidate) => { candidate.checkpoint!.confirmedAt = unsafe },
      (candidate) => {
        candidate.checkpoint!.rateLimit = {
          state: 'available',
          observedAt: 10_000,
          minimumRemaining: unsafe,
          resetAt: 60_000,
        }
      },
    ]

    for (const mutate of invalidIntegers) {
      const candidate = mutableRecord(record)
      mutate(candidate)
      expect(githubProjectSyncRecordSchema.safeParse(candidate).success).toBe(false)
    }
  })

  it('rejects mismatched durable table ownership and referents before recovery', async () => {
    const syncKey = synchronizationHarness([PROJECT_A, PROJECT_B])
    await syncKey.syncTable.put(PROJECT_B, emptySyncRecord(PROJECT_A))
    expect(() => syncKey.synchronization.validateDurableState())
      .toThrow(`GitHub Project sync '${PROJECT_B}' disagrees with its table key`)

    const syncInstallation = synchronizationHarness()
    await syncInstallation.syncTable.put(PROJECT_A, {
      ...emptySyncRecord(),
      installationId: sakiInstallationIdSchema.parse('installation-00000000-0000-4000-8000-000000000101'),
    })
    expect(() => syncInstallation.synchronization.validateDurableState())
      .toThrow(`GitHub Project sync '${PROJECT_A}' belongs to another Installation`)

    const syncProject = synchronizationHarness()
    await syncProject.syncTable.put(PROJECT_B, emptySyncRecord(PROJECT_B))
    expect(() => syncProject.synchronization.validateDurableState())
      .toThrow(`GitHub Project sync '${PROJECT_B}' has no Development Project`)

    const intentKey = synchronizationHarness()
    await saveConfiguration(intentKey)
    const keyedIntent = intentKey.intentTable.get(intentId(1))
    if (keyedIntent === undefined) throw new Error('saved Intent fixture is unavailable')
    await intentKey.intentTable.delete(intentId(1))
    await intentKey.intentTable.put(intentId(97), keyedIntent)
    expect(() => intentKey.synchronization.validateDurableState())
      .toThrow(`GitHub synchronization Intent '${intentId(97)}' disagrees with its table key`)

    const intentInstallation = synchronizationHarness()
    await saveConfiguration(intentInstallation)
    const installedIntent = intentInstallation.intentTable.get(intentId(1))
    if (installedIntent === undefined) throw new Error('saved Intent fixture is unavailable')
    const foreignPayload = {
      ...installedIntent.payload,
      actor: {
        ...installedIntent.payload.actor,
        installationId: 'installation-00000000-0000-4000-8000-000000000101',
      },
    }
    intentInstallation.intentTable.replace(intentId(1),
      githubSynchronizationConfigurationIntentRecordSchema.parse({
        ...installedIntent,
        payload: foreignPayload,
        payloadDigest: canonicalDigest('saki/configure-github-synchronization/v1', foreignPayload),
      }))
    expect(() => intentInstallation.synchronization.validateDurableState())
      .toThrow(`GitHub synchronization Intent '${intentId(1)}' belongs to another Installation`)

    const intentProject = synchronizationHarness()
    await saveConfiguration(intentProject)
    const projectIntent = intentProject.intentTable.get(intentId(1))
    if (projectIntent === undefined) throw new Error('saved Intent fixture is unavailable')
    const {
      candidateRevision: _candidateRevision,
      synchronizationRevision: _synchronizationRevision,
      ...withoutSavedEvidence
    } = projectIntent
    const missingProjectPayload = {
      ...projectIntent.payload,
      intent: { ...projectIntent.payload.intent, projectId: PROJECT_B },
    }
    intentProject.intentTable.replace(intentId(1),
      githubSynchronizationConfigurationIntentRecordSchema.parse({
        ...withoutSavedEvidence,
        payload: missingProjectPayload,
        payloadDigest: canonicalDigest('saki/configure-github-synchronization/v1', missingProjectPayload),
        phase: 'conflict',
        terminalReason: 'expected-revision',
      }))
    expect(() => intentProject.synchronization.validateDurableState())
      .toThrow(`GitHub synchronization Intent '${intentId(1)}' has no Development Project`)
  })

  it('rejects hostile committed-Intent history and accepted mappings', async () => {
    const duplicateAccepted = await confirmedHarness()
    await saveConfiguration(duplicateAccepted, {
      expectedRevision: 1,
      ordinal: 98,
      patch: { activePollIntervalMs: 45_000 },
    })
    const duplicateRecord = duplicateAccepted.syncTable.get(PROJECT_A)
    if (duplicateRecord?.active === undefined || duplicateRecord.pending === undefined) {
      throw new Error('active and pending fixture is unavailable')
    }
    duplicateAccepted.syncTable.replace(PROJECT_A, githubProjectSyncRecordSchema.parse({
      ...duplicateRecord,
      pending: {
        ...duplicateRecord.pending,
        acceptedIntentId: duplicateRecord.active.acceptedIntentId,
        receiptId: duplicateRecord.active.receiptId,
      },
    }))
    expect(() => duplicateAccepted.synchronization.validateDurableState())
      .toThrow(`GitHub Project sync '${PROJECT_A}' has an invalid accepted Intent mapping`)

    const incompleteHistory = synchronizationHarness()
    await saveConfiguration(incompleteHistory)
    const incompleteIntent = incompleteHistory.intentTable.get(intentId(1))
    if (incompleteIntent === undefined) throw new Error('saved Intent fixture is unavailable')
    const incompletePayload = {
      ...incompleteIntent.payload,
      intent: {
        ...incompleteIntent.payload.intent,
        patch: { activePollIntervalMs: 45_000 },
      },
    }
    incompleteHistory.intentTable.replace(intentId(1),
      githubSynchronizationConfigurationIntentRecordSchema.parse({
        ...incompleteIntent,
        payload: incompletePayload,
        payloadDigest: canonicalDigest('saki/configure-github-synchronization/v1', incompletePayload),
      }))
    expect(() => incompleteHistory.synchronization.validateDurableState())
      .toThrow(`GitHub Project sync '${PROJECT_A}' has invalid saved Intent revisions`)

    const rejectedOwner = synchronizationHarness()
    await saveConfiguration(rejectedOwner)
    const original = rejectedOwner.intentTable.get(intentId(1))
    if (original === undefined) throw new Error('saved Intent fixture is unavailable')
    const replacementId = intentId(99)
    const replacementPayload = {
      ...original.payload,
      intent: { ...original.payload.intent, intentId: replacementId },
    }
    const replacement = githubSynchronizationConfigurationIntentRecordSchema.parse({
      ...original,
      id: replacementId,
      receiptId: replacementId.replace(/^intent-/u, 'receipt-'),
      payload: replacementPayload,
      payloadDigest: canonicalDigest('saki/configure-github-synchronization/v1', replacementPayload),
    })
    const {
      candidateRevision: _candidateRevision,
      synchronizationRevision: _synchronizationRevision,
      ...originalWithoutSavedEvidence
    } = original
    rejectedOwner.intentTable.replace(intentId(1),
      githubSynchronizationConfigurationIntentRecordSchema.parse({
        ...originalWithoutSavedEvidence,
        phase: 'conflict',
        terminalReason: 'expected-revision',
      }))
    await rejectedOwner.intentTable.put(replacementId, replacement)
    expect(() => rejectedOwner.synchronization.validateDurableState())
      .toThrow(`GitHub Project sync '${PROJECT_A}' has an invalid accepted Intent mapping`)

    const changedFieldsHistory = synchronizationHarness()
    await saveConfiguration(changedFieldsHistory)
    const changedRecord = changedFieldsHistory.syncTable.get(PROJECT_A)
    if (changedRecord?.pending === undefined) throw new Error('pending fixture is unavailable')
    changedFieldsHistory.syncTable.replace(PROJECT_A, githubProjectSyncRecordSchema.parse({
      ...changedRecord,
      pending: { ...changedRecord.pending, changedFields: ['rateLimitReserve'] },
    }))
    expect(() => changedFieldsHistory.synchronization.validateDurableState())
      .toThrow(`GitHub Project sync '${PROJECT_A}' has an invalid accepted Intent mapping`)
  })

  it('assigns one global Intent id to exactly one Project under concurrent submission', async () => {
    const harness = synchronizationHarness([PROJECT_A, PROJECT_B])
    let entered: (() => void) | undefined
    let release: (() => void) | undefined
    const enteredPut = new Promise<void>((resolve) => { entered = resolve })
    const releasePut = new Promise<void>((resolve) => { release = resolve })
    harness.intentTable.beforeNextPut = async () => {
      entered?.()
      await releasePut
    }
    const sharedIntentId = intentId(50)
    const submit = (projectId: SakiDevelopmentProjectId) => harness.synchronization.configure({
      type: 'configure-github-synchronization',
      intentId: sharedIntentId,
      projectId,
      expectedSynchronizationRevision: 0,
      patch: configuration(),
    }, ACTOR, new AbortController().signal)

    const left = submit(PROJECT_A)
    await enteredPut
    const right = submit(PROJECT_B)
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    release?.()
    const results = await Promise.all([left, right])

    expect(results.filter(result => result.ok)).toHaveLength(1)
    expect(results.filter(result => !result.ok)).toEqual([{ ok: false, reason: 'conflict' }])
    expect(harness.intentTable.putCalls).toBe(1)
    const owner = harness.intentTable.get(sharedIntentId)?.payload.intent.projectId
    expect(owner === PROJECT_A || owner === PROJECT_B).toBe(true)
    expect([...harness.syncTable.keys()]).toEqual([owner])
  })

  it('replays one concurrent identical Intent after its single durable allocation', async () => {
    const harness = synchronizationHarness()
    let entered: (() => void) | undefined
    let release: (() => void) | undefined
    const enteredPut = new Promise<void>((resolve) => { entered = resolve })
    const releasePut = new Promise<void>((resolve) => { release = resolve })
    harness.intentTable.beforeNextPut = async () => {
      entered?.()
      await releasePut
    }
    const request: ConfigureGitHubSynchronizationIntent = {
      type: 'configure-github-synchronization',
      intentId: intentId(51),
      projectId: PROJECT_A,
      expectedSynchronizationRevision: 0,
      patch: configuration(),
    }
    const submit = () => harness.synchronization.configure(request, ACTOR, new AbortController().signal)

    const first = submit()
    await enteredPut
    const replay = submit()
    release?.()

    const [firstResult, replayResult] = await Promise.all([first, replay])
    expect(replayResult).toEqual(firstResult)
    expect(firstResult.ok).toBe(true)
    expect(harness.intentTable.putCalls).toBe(1)
    expect(harness.syncTable.size).toBe(1)
  })

  it('serializes different concurrent Intents for one Project', async () => {
    const harness = synchronizationHarness()
    const submit = (ordinal: number) => harness.synchronization.configure({
      type: 'configure-github-synchronization',
      intentId: intentId(ordinal),
      projectId: PROJECT_A,
      expectedSynchronizationRevision: 0,
      patch: configuration(),
    }, ACTOR, new AbortController().signal)

    const results = await Promise.all([submit(56), submit(57)])
    expect(results.filter(result => result.ok)).toHaveLength(1)
    expect(results.filter(result => !result.ok)).toMatchObject([{
      receipt: { state: 'conflict', reason: 'expected-revision' },
    }])
  })

  it('rejects multiple prepared Intents for one Project before startup mutation', async () => {
    const harness = synchronizationHarness()
    harness.intentTable.afterNextCommit = () => { throw new Error('simulated crash after prepared Intent') }
    await expect(harness.synchronization.configure({
      type: 'configure-github-synchronization',
      intentId: intentId(52),
      projectId: PROJECT_A,
      expectedSynchronizationRevision: 0,
      patch: configuration(),
    }, ACTOR, new AbortController().signal)).rejects.toThrow('simulated crash after prepared Intent')
    const retained = harness.intentTable.get(intentId(52))
    if (retained === undefined) throw new Error('prepared fixture is missing')
    const secondId = intentId(53)
    const payload = {
      ...retained.payload,
      intent: { ...retained.payload.intent, intentId: secondId },
    }
    await harness.intentTable.put(secondId, githubSynchronizationConfigurationIntentRecordSchema.parse({
      ...retained,
      id: secondId,
      receiptId: secondId.replace(/^intent-/u, 'receipt-'),
      payload,
      payloadDigest: canonicalDigest('saki/configure-github-synchronization/v1', payload),
    }))
    const beforeIntents = structuredClone([...harness.intentTable.entries()])
    const beforeSync = structuredClone([...harness.syncTable.entries()])

    expect(() => harness.synchronization.validateDurableState())
      .toThrow(`GitHub Project sync '${PROJECT_A}' retains multiple prepared Intents`)
    expect([...harness.intentTable.entries()]).toEqual(beforeIntents)
    expect([...harness.syncTable.entries()]).toEqual(beforeSync)
  })

  it('settles one retained prepared Intent before admitting another for its Project', async () => {
    const harness = synchronizationHarness()
    harness.intentTable.afterNextCommit = () => { throw new Error('simulated crash after prepared Intent') }
    await expect(harness.synchronization.configure({
      type: 'configure-github-synchronization',
      intentId: intentId(54),
      projectId: PROJECT_A,
      expectedSynchronizationRevision: 0,
      patch: configuration(),
    }, ACTOR, new AbortController().signal)).rejects.toThrow('simulated crash after prepared Intent')

    expect(await harness.synchronization.configure({
      type: 'configure-github-synchronization',
      intentId: intentId(55),
      projectId: PROJECT_A,
      expectedSynchronizationRevision: 0,
      patch: configuration(),
    }, ACTOR, new AbortController().signal)).toMatchObject({
      ok: false,
      receipt: { state: 'conflict', reason: 'expected-revision' },
    })
    expect(harness.intentTable.get(intentId(54))).toMatchObject({ phase: 'saved' })
    expect(harness.intentTable.get(intentId(55))).toMatchObject({ phase: 'conflict' })
    expect([...harness.intentTable.entries()].filter(([, value]) => value.phase === 'prepared'))
      .toEqual([])
    expect(() => harness.synchronization.validateDurableState()).not.toThrow()
  })

  it('rejects duplicate or missing historical saved-Intent revision allocations', async () => {
    const harness = await confirmedHarness()
    await saveConfiguration(harness, {
      expectedRevision: 1,
      ordinal: 2,
      patch: { activePollIntervalMs: 45_000 },
    })
    await saveConfiguration(harness, {
      expectedRevision: 2,
      ordinal: 3,
      patch: { rateLimitReserve: 750 },
    })
    await harness.intentTable.update(intentId(2), current => ({
      ...current,
      candidateRevision: 1,
      synchronizationRevision: 1,
    }))

    expect(() => harness.synchronization.validateDurableState())
      .toThrow("GitHub Project sync 'project-00000000-0000-4000-8000-000000000101' has invalid saved Intent revisions")
  })

  it.each([
    ['the first candidate', 'initial'],
    ['a replacement for a pending candidate', 'pending'],
    ['a replacement after activation', 'active'],
  ] as const)('recovers %s when the aggregate commit precedes its saved receipt', async (_label, setup) => {
    const harness = setup === 'active' ? await confirmedHarness() : synchronizationHarness()
    if (setup === 'pending') await saveConfiguration(harness)
    const expectedRevision = setup === 'initial' ? 0 : 1
    const ordinal = setup === 'initial' ? 60 : 61
    harness.syncTable.afterNextCommit = () => { throw new Error('simulated crash after aggregate commit') }

    await expect(harness.synchronization.configure({
      type: 'configure-github-synchronization',
      intentId: intentId(ordinal),
      projectId: PROJECT_A,
      expectedSynchronizationRevision: expectedRevision,
      patch: setup === 'initial' ? configuration() : { activePollIntervalMs: 45_000 },
    }, ACTOR, new AbortController().signal)).rejects.toThrow('simulated crash after aggregate commit')

    const committed = harness.syncTable.get(PROJECT_A)
    expect(committed).toMatchObject({
      revision: expectedRevision + 1,
      nextCandidateRevision: expectedRevision + 2,
      pending: {
        revision: expectedRevision + 1,
        acceptedIntentId: intentId(ordinal),
        receiptId: intentId(ordinal).replace(/^intent-/u, 'receipt-'),
      },
    })
    expect(harness.intentTable.get(intentId(ordinal))).toMatchObject({ phase: 'prepared' })

    const validated = harness.synchronization.validateDurableState()
    await harness.synchronization.initializeValidated(validated, new AbortController().signal)

    expect(harness.intentTable.get(intentId(ordinal))).toMatchObject({
      phase: 'saved',
      candidateRevision: expectedRevision + 1,
      synchronizationRevision: expectedRevision + 1,
    })
    expect(harness.syncTable.get(PROJECT_A)).toMatchObject({
      revision: committed?.revision,
      nextCandidateRevision: committed?.nextCandidateRevision,
      pending: { revision: committed?.pending?.revision },
    })
    expect(() => harness.synchronization.validateDurableState()).not.toThrow()
  })

  it('finalizes an already-activated prepared commit without rechecking revoked authority', async () => {
    let authority = true
    const harness = synchronizationHarness([PROJECT_A], () => authority)
    await saveConfiguration(harness)
    const lease = await begin(harness)
    expect(await harness.synchronization.publishScan(
      PROJECT_A,
      lease.attemptId,
      boardCandidate(),
      new AbortController().signal,
    )).toMatchObject({ state: 'published' })
    await harness.intentTable.update(intentId(1), (current) => {
      const {
        candidateRevision: _candidateRevision,
        synchronizationRevision: _synchronizationRevision,
        ...prepared
      } = current
      return { ...prepared, phase: 'prepared' }
    })
    authority = false

    const validated = harness.synchronization.validateDurableState()
    await harness.synchronization.initializeValidated(validated, new AbortController().signal)

    expect(harness.intentTable.get(intentId(1))).toMatchObject({
      phase: 'saved',
      candidateRevision: 1,
      synchronizationRevision: 1,
    })
    expect(harness.syncTable.get(PROJECT_A)).toMatchObject({
      revision: 1,
      active: { revision: 1, acceptedIntentId: intentId(1) },
    })
  })

  it.each([
    ['configuration', (sync: Mutable<GitHubProjectSyncRecord>) => {
      sync.pending!.configuration.activePollIntervalMs = 45_000
    }, undefined],
    ['candidate revision', (sync: Mutable<GitHubProjectSyncRecord>) => {
      sync.pending!.revision = 2
      sync.nextCandidateRevision = 3
      sync.revision = 2
    }, undefined],
    ['receipt', (sync: Mutable<GitHubProjectSyncRecord>) => {
      sync.pending!.receiptId = sakiIntentReceiptIdSchema.parse(
        'receipt-00000000-0000-4000-8000-000000000999',
      )
    }, undefined],
    ['expected synchronization revision', undefined, (
      intent: Mutable<NonNullable<ReturnType<GitHubSynchronizationConfigurationIntentTable['get']>>>,
    ) => {
      intent.payload.intent.expectedSynchronizationRevision = 1
      intent.payloadDigest = canonicalDigest('saki/configure-github-synchronization/v1', intent.payload)
    }],
  ] as const)('rejects a prepared aggregate commit with mismatched %s evidence', async (
    _label,
    mutateSync,
    mutateIntent,
  ) => {
    const harness = synchronizationHarness()
    harness.syncTable.afterNextCommit = () => { throw new Error('simulated crash after aggregate commit') }
    await expect(harness.synchronization.configure({
      type: 'configure-github-synchronization',
      intentId: intentId(70),
      projectId: PROJECT_A,
      expectedSynchronizationRevision: 0,
      patch: configuration(),
    }, ACTOR, new AbortController().signal)).rejects.toThrow('simulated crash after aggregate commit')
    if (mutateSync !== undefined) {
      await harness.syncTable.update(PROJECT_A, (current) => {
        const candidate = mutableRecord(current)
        mutateSync(candidate)
        return candidate
      })
    }
    if (mutateIntent !== undefined) {
      await harness.intentTable.update(intentId(70), (current) => {
        const candidate = structuredClone(current)
        mutateIntent(candidate)
        return candidate
      })
    }

    expect(() => harness.synchronization.validateDurableState())
      .toThrow(/invalid (?:saved Intent revisions|accepted Intent mapping)/u)
  })

  it('terminates configuration patches that cannot produce a changed candidate', async () => {
    const activeHarness = await confirmedHarness()
    const activeNoop = await activeHarness.synchronization.configure({
      type: 'configure-github-synchronization',
      intentId: intentId(80),
      projectId: PROJECT_A,
      expectedSynchronizationRevision: 1,
      patch: { activePollIntervalMs: configuration().activePollIntervalMs },
    }, ACTOR, new AbortController().signal)
    expect(activeNoop).toMatchObject({
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'configuration-unchanged' },
    })
    expect(activeHarness.syncTable.get(PROJECT_A)).toMatchObject({ revision: 1, active: { revision: 1 } })
    expect(activeHarness.syncTable.get(PROJECT_A)?.pending).toBeUndefined()

    const pendingHarness = await confirmedHarness()
    await saveConfiguration(pendingHarness, {
      expectedRevision: 1,
      ordinal: 81,
      patch: { activePollIntervalMs: 45_000 },
    })
    const pendingNoop = await pendingHarness.synchronization.configure({
      type: 'configure-github-synchronization',
      intentId: intentId(82),
      projectId: PROJECT_A,
      expectedSynchronizationRevision: 2,
      patch: { activePollIntervalMs: configuration().activePollIntervalMs },
    }, ACTOR, new AbortController().signal)
    expect(pendingNoop).toMatchObject({
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'configuration-unchanged' },
    })
    expect(pendingHarness.syncTable.get(PROJECT_A)).toMatchObject({
      revision: 2,
      active: { revision: 1, configuration: { activePollIntervalMs: 30_000 } },
      pending: { revision: 2, configuration: { activePollIntervalMs: 45_000 } },
    })
  })

  it('admits the complete worst-case mapping issue list without widening it further', () => {
    const githubConfiguration = configuration()
    const optionIssues = [
      { status: 'inbox', statusOptionId: githubConfiguration.statusOptionNodeIds.inbox },
      { status: 'backlog', statusOptionId: githubConfiguration.statusOptionNodeIds.backlog },
      { status: 'ready', statusOptionId: githubConfiguration.statusOptionNodeIds.ready },
      { status: 'in-progress', statusOptionId: githubConfiguration.statusOptionNodeIds.inProgress },
      { status: 'in-review', statusOptionId: githubConfiguration.statusOptionNodeIds.inReview },
      { status: 'done', statusOptionId: githubConfiguration.statusOptionNodeIds.done },
      { status: 'canceled', statusOptionId: githubConfiguration.statusOptionNodeIds.canceled },
    ].map(issue => ({ reason: 'status-option-missing' as const, ...issue }))
    const itemIssues = Array.from({ length: SAKI_BOARD_WORK_ITEM_LIMIT }, (_, index) => ({
      reason: 'work-item-status-missing' as const,
      issueId: `I_saki_mapping_limit_issue_${index}` as GitHubIssueId,
    }))
    const mappingIssues = [...optionIssues, ...itemIssues]
    const firstOptionIssue = optionIssues.at(0)
    const firstItemIssue = itemIssues.at(0)
    if (firstOptionIssue === undefined || firstItemIssue === undefined) {
      throw new Error('mapping issue fixtures are incomplete')
    }
    expect(mappingIssues).toHaveLength(SAKI_GITHUB_MAPPING_ISSUE_LIMIT)
    expect(SAKI_GITHUB_CAPACITY_OBSERVED_LIMIT).toBe(GITHUB_PROJECT_BOARD_SCAN_COLLECTION_LIMIT * 2)
    expect(sakiGitHubScanFailureSchema.safeParse({
      kind: 'mapping',
      issues: mappingIssues,
    }).success).toBe(true)
    expect(issueMessages(sakiGitHubScanFailureSchema.safeParse({
      kind: 'mapping',
      issues: [...itemIssues, {
        reason: 'work-item-status-missing',
        issueId: 'I_saki_mapping_limit_overflow' as GitHubIssueId,
      }],
    }))).toContain('GitHub mapping failure exceeds the Board Work Item limit')
    expect(issueMessages(sakiGitHubScanFailureSchema.safeParse({
      kind: 'mapping',
      issues: [{
        reason: 'work-item-status-missing',
        issueId: 'I_saki_repeated_mapping_issue' as GitHubIssueId,
      }, {
        reason: 'work-item-status-unknown',
        issueId: 'I_saki_repeated_mapping_issue' as GitHubIssueId,
        statusOptionId: githubConfiguration.statusOptionNodeIds.ready,
      }],
    }))).toContain('GitHub mapping failure repeats a Work Item Issue identity')

    const eightOptions = [...optionIssues, {
      ...firstOptionIssue,
      statusOptionId: 'option-capacity-7' as GitHubProjectOptionId,
    }]
    expect(issueMessages(sakiGitHubScanFailureSchema.safeParse({
      kind: 'mapping',
      issues: eightOptions,
    }))).toContain('GitHub mapping failure exceeds the Saki status count')
    expect(issueMessages(sakiGitHubScanFailureSchema.safeParse({
      kind: 'mapping',
      issues: [{
        reason: 'status-option-missing',
        status: 'ready',
        statusOptionId: 'option-repeat-status-a',
      }, {
        reason: 'status-option-missing',
        status: 'ready',
        statusOptionId: 'option-repeat-status-b',
      }],
    }))).toContain('GitHub mapping failure repeats a Saki status')
    expect(issueMessages(sakiGitHubScanFailureSchema.safeParse({
      kind: 'mapping',
      issues: [{
        reason: 'status-option-missing',
        status: 'ready',
        statusOptionId: 'option-repeat-id',
      }, {
        reason: 'status-option-missing',
        status: 'done',
        statusOptionId: 'option-repeat-id',
      }],
    }))).toContain('GitHub mapping failure repeats a Status option id')
    expect(issueMessages(sakiGitHubScanFailureSchema.safeParse({
      kind: 'mapping',
      issues: [{
        reason: 'status-field-missing',
        statusFieldId: githubConfiguration.statusFieldNodeId,
      }, firstItemIssue],
    }))).toContain('missing Status field must be the only mapping issue')
    expect(sakiGitHubScanFailureSchema.safeParse({
      kind: 'mapping',
      issues: [{
        reason: 'status-field-missing',
        statusFieldId: githubConfiguration.statusFieldNodeId,
      }],
    }).success).toBe(true)
    expect(sakiGitHubScanFailureSchema.safeParse({
      kind: 'capacity',
      resource: 'board-work-items',
      limit: SAKI_BOARD_WORK_ITEM_LIMIT - 1,
      observed: SAKI_BOARD_WORK_ITEM_LIMIT + 1,
    }).success).toBe(false)
    expect(sakiGitHubScanFailureSchema.safeParse({
      kind: 'capacity',
      resource: 'board-work-items',
      limit: SAKI_BOARD_WORK_ITEM_LIMIT,
      observed: SAKI_BOARD_WORK_ITEM_LIMIT,
    }).success).toBe(false)
    expect(sakiGitHubScanFailureSchema.safeParse({
      kind: 'capacity',
      resource: 'board-work-items',
      limit: SAKI_BOARD_WORK_ITEM_LIMIT,
      observed: SAKI_GITHUB_CAPACITY_OBSERVED_LIMIT,
    }).success).toBe(true)
    for (const observed of [SAKI_GITHUB_CAPACITY_OBSERVED_LIMIT + 1, Number.MAX_SAFE_INTEGER]) {
      expect(sakiGitHubScanFailureSchema.safeParse({
        kind: 'capacity',
        resource: 'board-work-items',
        limit: SAKI_BOARD_WORK_ITEM_LIMIT,
        observed,
      }).success).toBe(false)
    }
  })

  it('rejects oversized durable arrays before reading their elements', async () => {
    const harness = await confirmedHarness()
    const record = harness.syncTable.get(PROJECT_A)
    if (record?.confirmedBoard === undefined) throw new Error('confirmed fixture is incomplete')

    const boardItems = unreadableArray(SAKI_BOARD_WORK_ITEM_LIMIT + 1)
    const oversizedRecord = {
      ...record,
      confirmedBoard: {
        ...record.confirmedBoard,
        items: boardItems.value,
      },
    }
    const boardResult = githubProjectSyncRecordSchema.safeParse(oversizedRecord)
    const historicalBoardResult = v4GitHubProjectSyncRecordSchema.safeParse(
      projectGitHubProjectSyncRecordToV4(oversizedRecord),
    )
    expect(boardResult.success).toBe(false)
    expect(historicalBoardResult.success).toBe(false)
    if (boardResult.success || historicalBoardResult.success) throw new Error('oversized Board fixture was accepted')
    expect(boardResult.error.issues).toContainEqual(expect.objectContaining({ path: ['confirmedBoard', 'items'] }))
    expect(historicalBoardResult.error.issues)
      .toContainEqual(expect.objectContaining({ path: ['confirmedBoard', 'items'] }))
    expect(boardItems.elementReads()).toBe(0)

    const mappingIssues = unreadableArray(SAKI_GITHUB_MAPPING_ISSUE_LIMIT + 1)
    const mappingResult = sakiGitHubScanFailureSchema.safeParse({
      kind: 'mapping',
      issues: mappingIssues.value,
    })
    expect(mappingResult.success).toBe(false)
    expect(mappingIssues.elementReads()).toBe(0)
    expect(issueMessages(sakiGitHubScanFailureSchema.safeParse({ kind: 'mapping', issues: {} })))
      .toContain('value must be an array')
  })

  it('publishes exactly the Board limit and rejects an oversized Board during restart validation', {
    timeout: 60_000,
  }, async () => {
    const harness = synchronizationHarness()
    await saveConfiguration(harness)
    const lease = await begin(harness)
    expect(await harness.synchronization.publishScan(
      PROJECT_A,
      lease.attemptId,
      boardCandidateWithIssues({ joined: SAKI_BOARD_WORK_ITEM_LIMIT - 1, unjoined: 1 }),
      new AbortController().signal,
    )).toMatchObject({ state: 'published', generation: 1 })
    const record = harness.syncTable.get(PROJECT_A)
    if (record?.confirmedBoard === undefined) throw new Error('limit Board fixture is unavailable')
    expect(record.confirmedBoard.items).toHaveLength(SAKI_BOARD_WORK_ITEM_LIMIT)

    const oversized = mutableRecord(record)
    const source = oversized.confirmedBoard!.items.at(-1)
    if (source === undefined) throw new Error('limit Board has no Work Item')
    const issueId = 'I_saki_capacity_restart_overflow' as GitHubIssueId
    oversized.confirmedBoard!.items.push({
      ...structuredClone(source),
      id: sakiBoardWorkItemIdSchema.parse(`work-item-${canonicalDigest('saki/board-work-item/v1', {
        repositoryId: source.source.repositoryId,
        issueId,
      })}`),
      issueNumber: SAKI_BOARD_WORK_ITEM_LIMIT + 1,
      order: source.order + 1,
      source: { ...structuredClone(source.source), issueId },
    })
    harness.syncTable.replace(PROJECT_A, oversized)
    expect(() => harness.synchronization.validateDurableState()).toThrow()
  })

  it('retains the prior publication and generation when Board capacity is exceeded', {
    timeout: 60_000,
  }, async () => {
    const candidate = boardCandidateWithIssues({ joined: SAKI_BOARD_WORK_ITEM_LIMIT - 1, unjoined: 2 })
    const activeHarness = await confirmedHarness()
    const before = activeHarness.syncTable.get(PROJECT_A)
    if (before?.confirmedBoard === undefined || before.checkpoint === undefined) {
      throw new Error('confirmed fixture is unavailable')
    }
    const lease = await begin(activeHarness)
    const failure = {
      kind: 'capacity' as const,
      resource: 'board-work-items' as const,
      limit: SAKI_BOARD_WORK_ITEM_LIMIT,
      observed: SAKI_BOARD_WORK_ITEM_LIMIT + 1,
    }
    expect(await activeHarness.synchronization.publishScan(
      PROJECT_A,
      lease.attemptId,
      candidate,
      new AbortController().signal,
    )).toEqual({ state: 'failed', failure })
    const retained = activeHarness.syncTable.get(PROJECT_A)
    expect(retained?.confirmedBoard).toEqual(before.confirmedBoard)
    expect(retained?.checkpoint).toEqual(before.checkpoint)
    expect(retained?.nextBoardGeneration).toBe(before.nextBoardGeneration)
    expect(retained).toMatchObject({ currentFailure: { failure } })
    expect(activeHarness.synchronization.board(PROJECT_A)).toMatchObject({
      state: 'confirmed',
      confirmed: { generation: 1 },
    })

    const initialHarness = synchronizationHarness()
    await saveConfiguration(initialHarness)
    const initialLease = await begin(initialHarness)
    expect(await initialHarness.synchronization.publishScan(
      PROJECT_A,
      initialLease.attemptId,
      candidate,
      new AbortController().signal,
    )).toEqual({ state: 'failed', failure })
    expect(initialHarness.syncTable.get(PROJECT_A)).toMatchObject({
      nextBoardGeneration: 1,
      currentFailure: { failure },
    })
    expect(initialHarness.syncTable.get(PROJECT_A)?.confirmedBoard).toBeUndefined()
    expect(initialHarness.syncTable.get(PROJECT_A)?.checkpoint).toBeUndefined()
    expect(initialHarness.synchronization.board(PROJECT_A)).toMatchObject({
      state: 'awaiting-first-checkpoint',
    })
  })

  it('durably completes the maximum legal candidate when every Issue needs mapping repair', { timeout: 60_000 }, async () => {
    const harness = synchronizationHarness()
    const githubConfiguration = configuration()
    await saveConfiguration(harness)
    const lease = await begin(harness)
    const base = boardCandidateWithIssues({
      joined: SAKI_BOARD_WORK_ITEM_LIMIT,
      statusOptionId: null,
      configuration: githubConfiguration,
    })
    const candidate = refingerprintCandidate(base, {
      fields: [{
        kind: 'single-select',
        id: githubConfiguration.statusFieldNodeId,
        name: 'Status',
        options: [],
      }],
    })

    const result = await harness.synchronization.publishScan(
      PROJECT_A,
      lease.attemptId,
      candidate,
      new AbortController().signal,
    )
    expect(result).toMatchObject({ state: 'activation-failed' })
    if (result.state !== 'activation-failed') throw new Error('maximum candidate did not reach mapping')
    expect(result.issues).toHaveLength(SAKI_BOARD_WORK_ITEM_LIMIT + 7)
    expect(harness.syncTable.get(PROJECT_A)).toMatchObject({
      pending: { state: 'activation-failed' },
      currentFailure: { failure: { kind: 'mapping', issues: result.issues } },
    })
    expect(harness.syncTable.get(PROJECT_A)?.inFlightAttempt).toBeUndefined()
  })

  it('waits past an existing scan and lets one newly begun attempt satisfy concurrent requests', async () => {
    const harness = synchronizationHarness()
    const githubConfiguration = configuration()
    await saveConfiguration(harness, { patch: githubConfiguration })
    const ctx = new Context()
    let startFirst: (() => void) | undefined
    let finishFirst: ((candidate: GitHubProjectBoardScanCandidate) => void) | undefined
    const firstStarted = new Promise<void>((resolve) => { startFirst = resolve })
    const firstFinished = new Promise<GitHubProjectBoardScanCandidate>((resolve) => { finishFirst = resolve })
    let startSecond: (() => void) | undefined
    let finishSecond: ((candidate: GitHubProjectBoardScanCandidate) => void) | undefined
    const secondStarted = new Promise<void>((resolve) => { startSecond = resolve })
    const secondFinished = new Promise<GitHubProjectBoardScanCandidate>((resolve) => { finishSecond = resolve })
    const requestAfterCurrent = harness.synchronization.requestScanAfterCurrent.bind(harness.synchronization)
    let scheduledCount = 0
    let markBothScheduled: (() => void) | undefined
    const bothScheduled = new Promise<void>((resolve) => { markBothScheduled = resolve })
    let releaseFences: (() => void) | undefined
    const fencesReleased = new Promise<void>((resolve) => { releaseFences = resolve })
    const requestSpy = vi.spyOn(harness.synchronization, 'requestScanAfterCurrent')
      .mockImplementation(async (projectId, signal) => {
        const result = await requestAfterCurrent(projectId, signal)
        scheduledCount += 1
        if (scheduledCount === 2) markBothScheduled?.()
        await fencesReleased
        return result
      })
    const provider = new ScriptedGitHub(ctx, [
      async () => {
        startFirst?.()
        return await firstFinished
      },
      async () => {
        startSecond?.()
        return await secondFinished
      },
    ])
    const consumer = new GitHubSynchronizationConsumer({
      synchronization: harness.synchronization,
      github: provider,
      attemptTtlMs: 60_000,
      reportUnexpectedFailure: vi.fn(),
    })
    try {
      await firstStarted
      let firstSettled = false
      let secondSettled = false
      const first = consumer.requestFreshBoardScan(PROJECT_A, new AbortController().signal)
        .then((result) => {
          firstSettled = true
          return result
        })
      const second = consumer.requestFreshBoardScan(PROJECT_A, new AbortController().signal)
        .then((result) => {
          secondSettled = true
          return result
        })
      await bothScheduled
      expect(harness.syncTable.get(PROJECT_A)?.nextScanAttempt).toMatchObject({
        priority: 'interactive',
        reason: 'interactive',
      })

      finishFirst?.(boardCandidate(githubConfiguration))
      await secondStarted
      expect(firstSettled).toBe(false)
      expect(secondSettled).toBe(false)
      releaseFences?.()
      await flushConsumer()
      expect(firstSettled).toBe(false)
      expect(secondSettled).toBe(false)

      finishSecond?.(boardCandidate(githubConfiguration))
      await expect(Promise.all([first, second])).resolves.toEqual([
        { state: 'published', generation: 2, configurationRevision: 1 },
        { state: 'published', generation: 2, configurationRevision: 1 },
      ])
      expect(provider.requests).toHaveLength(2)
    } finally {
      releaseFences?.()
      finishFirst?.(boardCandidate(githubConfiguration))
      finishSecond?.(boardCandidate(githubConfiguration))
      await consumer.dispose()
      await ctx.fiber.dispose()
      requestSpy.mockRestore()
    }
  })

  it('returns a safe typed Provider failure from the newly requested attempt', async () => {
    const harness = await idleSynchronizationHarness()
    const ctx = new Context()
    const provider = new ScriptedGitHub(ctx, [
      new GitHubProviderError({ code: 'transient-transport', retryAfterMs: 1_000 }),
    ])
    const consumer = new GitHubSynchronizationConsumer({
      synchronization: harness.synchronization,
      github: provider,
      attemptTtlMs: 60_000,
      reportUnexpectedFailure: vi.fn(),
    })
    try {
      await expect(consumer.requestFreshBoardScan(PROJECT_A, new AbortController().signal))
        .resolves.toEqual({
          state: 'failed',
          failure: {
            kind: 'provider',
            failure: { code: 'transient-transport', retryAfterMs: 1_000 },
          },
        })
    } finally {
      await consumer.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('returns stale when the requested Provider failure loses its durable attempt fence', async () => {
    const harness = await idleSynchronizationHarness()
    const failScan = vi.spyOn(harness.synchronization, 'failScan').mockResolvedValue({ state: 'stale' })
    const ctx = new Context()
    const consumer = new GitHubSynchronizationConsumer({
      synchronization: harness.synchronization,
      github: new ScriptedGitHub(ctx, [new GitHubProviderError({ code: 'transient-transport' })]),
      attemptTtlMs: 60_000,
      reportUnexpectedFailure: vi.fn(),
    })
    try {
      await expect(consumer.requestFreshBoardScan(PROJECT_A, new AbortController().signal))
        .resolves.toEqual({ state: 'stale' })
    } finally {
      await consumer.dispose()
      await ctx.fiber.dispose()
      failScan.mockRestore()
    }
  })

  it('contains an unexpected Provider throw as a safe fresh-scan availability outcome', async () => {
    const harness = await idleSynchronizationHarness()
    const ctx = new Context()
    const report = vi.fn()
    const consumer = new GitHubSynchronizationConsumer({
      synchronization: harness.synchronization,
      github: new ScriptedGitHub(ctx, [new Error('unsafe provider detail')]),
      attemptTtlMs: 60_000,
      reportUnexpectedFailure: report,
    })
    try {
      await expect(consumer.requestFreshBoardScan(PROJECT_A, new AbortController().signal))
        .resolves.toEqual({ state: 'unavailable', reason: 'provider-failed' })
      expect(report).toHaveBeenCalledWith('provider')
    } finally {
      await consumer.dispose()
      await ctx.fiber.dispose()
    }
  })

  it.each([
    ['mapping', {
      state: 'activation-failed',
      issues: [{ reason: 'status-field-missing', statusFieldId: configuration().statusFieldNodeId }],
    }],
    ['candidate', {
      state: 'failed',
      failure: { kind: 'candidate', reason: 'target-mismatch' },
    }],
    ['capacity', {
      state: 'failed',
      failure: {
        kind: 'capacity',
        resource: 'board-work-items',
        limit: SAKI_BOARD_WORK_ITEM_LIMIT,
        observed: SAKI_BOARD_WORK_ITEM_LIMIT + 1,
      },
    }],
    ['stale', { state: 'stale' }],
  ] as const)('returns the newly requested attempt\'s %s publication outcome', async (_label, outcome) => {
    const harness = await idleSynchronizationHarness()
    const publish = vi.spyOn(harness.synchronization, 'publishScan').mockResolvedValue(outcome)
    const ctx = new Context()
    const consumer = new GitHubSynchronizationConsumer({
      synchronization: harness.synchronization,
      github: new ScriptedGitHub(ctx, [boardCandidate()]),
      attemptTtlMs: 60_000,
      reportUnexpectedFailure: vi.fn(),
    })
    try {
      await expect(consumer.requestFreshBoardScan(PROJECT_A, new AbortController().signal))
        .resolves.toEqual(outcome)
      expect(publish).toHaveBeenCalledTimes(1)
    } finally {
      await consumer.dispose()
      await ctx.fiber.dispose()
      publish.mockRestore()
    }
  })

  it('terminates fresh-scan requests for unknown and unconfigured Projects', async () => {
    const harness = synchronizationHarness()
    const ctx = new Context()
    const consumer = new GitHubSynchronizationConsumer({
      synchronization: harness.synchronization,
      github: new UnusedGitHub(ctx),
      attemptTtlMs: 60_000,
      reportUnexpectedFailure: vi.fn(),
    })
    try {
      await expect(consumer.requestFreshBoardScan(PROJECT_B, new AbortController().signal))
        .resolves.toEqual({ state: 'unavailable', reason: 'not-found' })
      await expect(consumer.requestFreshBoardScan(PROJECT_A, new AbortController().signal))
        .resolves.toEqual({ state: 'unavailable', reason: 'unconfigured' })
    } finally {
      await consumer.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('terminates when synchronization becomes unconfigured before the requested scan is admitted', async () => {
    const harness = await idleSynchronizationHarness()
    const beginScan = vi.spyOn(harness.synchronization, 'beginScan')
      .mockImplementationOnce(async () => {
        await harness.syncTable.update(PROJECT_A, (current) => {
          const { nextScanAttempt: _scheduled, ...idle } = current
          return idle
        })
        return { ok: false, reason: 'unconfigured' }
      })
    const ctx = new Context()
    const consumer = new GitHubSynchronizationConsumer({
      synchronization: harness.synchronization,
      github: new UnusedGitHub(ctx),
      attemptTtlMs: 60_000,
      reportUnexpectedFailure: vi.fn(),
    })
    try {
      await expect(consumer.requestFreshBoardScan(PROJECT_A, new AbortController().signal))
        .resolves.toEqual({ state: 'unavailable', reason: 'unconfigured' })
    } finally {
      await consumer.dispose()
      await ctx.fiber.dispose()
      beginScan.mockRestore()
    }
  })

  it('settles active and later fresh-scan requests when the Provider-bound Consumer is disposed', async () => {
    const harness = await idleSynchronizationHarness()
    const ctx = new Context()
    let started: (() => void) | undefined
    const scanStarted = new Promise<void>((resolve) => { started = resolve })
    const provider = new ScriptedGitHub(ctx, [async (signal) => {
      started?.()
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error('scan aborted'))
        }, { once: true })
      })
      throw new Error('unreachable scan completion')
    }])
    const consumer = new GitHubSynchronizationConsumer({
      synchronization: harness.synchronization,
      github: provider,
      attemptTtlMs: 60_000,
      reportUnexpectedFailure: vi.fn(),
    })
    try {
      const pending = consumer.requestFreshBoardScan(PROJECT_A, new AbortController().signal)
      await scanStarted
      const disposing = consumer.dispose()
      await expect(pending).resolves.toEqual({ state: 'unavailable', reason: 'provider-detached' })
      await disposing
      await expect(consumer.requestFreshBoardScan(PROJECT_A, new AbortController().signal))
        .resolves.toEqual({ state: 'unavailable', reason: 'provider-detached' })
    } finally {
      await consumer.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('removes a fresh-scan waiter immediately when its caller aborts', async () => {
    const harness = await idleSynchronizationHarness()
    const ctx = new Context()
    const provider = new ScriptedGitHub(ctx, [async (signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error('scan aborted'))
        }, { once: true })
      })
      throw new Error('unreachable scan completion')
    }])
    const consumer = new GitHubSynchronizationConsumer({
      synchronization: harness.synchronization,
      github: provider,
      attemptTtlMs: 60_000,
      reportUnexpectedFailure: vi.fn(),
    })
    const caller = new AbortController()
    const reason = new Error('finalization canceled')
    try {
      const pending = consumer.requestFreshBoardScan(PROJECT_A, caller.signal)
      caller.abort(reason)
      await expect(pending).rejects.toBe(reason)
    } finally {
      await consumer.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('keeps a committed interactive scan wake after cancellation removes its waiter', async () => {
    const harness = await idleSynchronizationHarness()
    const ctx = new Context()
    const provider = new ScriptedGitHub(ctx, [boardCandidate()])
    const consumer = new GitHubSynchronizationConsumer({
      synchronization: harness.synchronization,
      github: provider,
      attemptTtlMs: 60_000,
      reportUnexpectedFailure: vi.fn(),
    })
    const caller = new AbortController()
    const reason = new Error('canceled after durable scheduling')
    harness.syncTable.afterNextCommit = () => { caller.abort(reason) }
    try {
      await expect(consumer.requestFreshBoardScan(PROJECT_A, caller.signal)).rejects.toBe(reason)
      await flushConsumer()
      expect(provider.requests).toHaveLength(1)
      expect(harness.synchronization.board(PROJECT_A)).toMatchObject({ state: 'confirmed' })
    } finally {
      await consumer.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('rejects a fresh-scan request whose signal was already aborted', async () => {
    const harness = synchronizationHarness()
    const ctx = new Context()
    const consumer = new GitHubSynchronizationConsumer({
      synchronization: harness.synchronization,
      github: new UnusedGitHub(ctx),
      attemptTtlMs: 60_000,
      reportUnexpectedFailure: vi.fn(),
    })
    const errorSignal = new AbortController()
    const reason = new Error('finalization already canceled')
    errorSignal.abort(reason)
    const valueSignal = new AbortController()
    valueSignal.abort('canceled')
    try {
      await expect(consumer.requestFreshBoardScan(PROJECT_A, errorSignal.signal)).rejects.toBe(reason)
      await expect(consumer.requestFreshBoardScan(PROJECT_A, valueSignal.signal))
        .rejects.toBe('canceled')
    } finally {
      await consumer.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('rejects a fresh-scan request when durable scheduling itself fails', async () => {
    const harness = synchronizationHarness()
    const failure = new Error('storage unavailable')
    const request = vi.spyOn(harness.synchronization, 'requestScanAfterCurrent').mockRejectedValue(failure)
    const ctx = new Context()
    const consumer = new GitHubSynchronizationConsumer({
      synchronization: harness.synchronization,
      github: new UnusedGitHub(ctx),
      attemptTtlMs: 60_000,
      reportUnexpectedFailure: vi.fn(),
    })
    try {
      await expect(consumer.requestFreshBoardScan(PROJECT_A, new AbortController().signal))
        .rejects.toBe(failure)
    } finally {
      await consumer.dispose()
      await ctx.fiber.dispose()
      request.mockRestore()
    }
  })

  it('records typed Provider failure and recovers through its durable retry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    const harness = synchronizationHarness()
    const githubConfiguration = {
      ...configuration(),
      activePollIntervalMs: 1_000,
      backgroundPollIntervalMs: 1_000,
    }
    await saveConfiguration(harness, { patch: githubConfiguration })
    const ctx = new Context()
    const provider = new ScriptedGitHub(ctx, [
      new GitHubProviderError({ code: 'transient-transport' }),
      boardCandidate(githubConfiguration),
    ])
    const report = vi.fn()
    const consumer = new GitHubSynchronizationConsumer({
      synchronization: harness.synchronization,
      github: provider,
      attemptTtlMs: 1_000,
      reportUnexpectedFailure: report,
    })
    try {
      await flushConsumer()
      expect(provider.requests).toHaveLength(1)
      expect(harness.syncTable.get(PROJECT_A)).toMatchObject({
        currentFailure: { failure: { kind: 'provider', failure: { code: 'transient-transport' } } },
        nextScanAttempt: { reason: 'retry', attemptAt: 101_000 },
      })

      await vi.advanceTimersByTimeAsync(1_000)
      await flushConsumer()
      expect(provider.requests).toHaveLength(2)
      expect(harness.synchronization.board(PROJECT_A)).toMatchObject({ state: 'confirmed' })
      expect(report).not.toHaveBeenCalled()
    } finally {
      await consumer.dispose()
      await ctx.fiber.dispose()
      vi.useRealTimers()
    }
  })

  it('reports a contained Consumer failure and continues after a stale due admission', async () => {
    const idleHarness = synchronizationHarness()
    const idleContext = new Context()
    const idleReport = vi.fn()
    const idleConsumer = new GitHubSynchronizationConsumer({
      synchronization: idleHarness.synchronization,
      github: new UnusedGitHub(idleContext),
      attemptTtlMs: 1_000,
      reportUnexpectedFailure: idleReport,
    })
    await idleConsumer.dispose()
    expect(idleReport).not.toHaveBeenCalled()
    await idleContext.fiber.dispose()

    const malformedHarness = synchronizationHarness()
    malformedHarness.syncTable.replace(PROJECT_A, {
      ...emptySyncRecord(),
      revision: -1,
    })
    const malformedContext = new Context()
    const malformedReport = vi.fn()
    const malformedConsumer = new GitHubSynchronizationConsumer({
      synchronization: malformedHarness.synchronization,
      github: new UnusedGitHub(malformedContext),
      attemptTtlMs: 1_000,
      reportUnexpectedFailure: malformedReport,
    })
    try {
      await flushConsumer()
      expect(malformedReport).toHaveBeenCalledWith('consumer')
      await expect(malformedConsumer.requestFreshBoardScan(PROJECT_A, new AbortController().signal))
        .resolves.toEqual({ state: 'unavailable', reason: 'consumer-failed' })
    } finally {
      await malformedConsumer.dispose()
      await malformedContext.fiber.dispose()
    }

    const staleHarness = synchronizationHarness()
    await saveConfiguration(staleHarness)
    const due = {
      projectId: PROJECT_A,
      priority: 'background' as const,
      reason: 'poll' as const,
      attemptAt: 1,
    }
    const dueSpy = vi.spyOn(staleHarness.synchronization, 'listDueScans')
      .mockReturnValueOnce([due])
      .mockReturnValue([])
    const beginSpy = vi.spyOn(staleHarness.synchronization, 'beginScan')
      .mockResolvedValueOnce({ ok: false, reason: 'in-flight' })
    const staleContext = new Context()
    const staleReport = vi.fn()
    const staleConsumer = new GitHubSynchronizationConsumer({
      synchronization: staleHarness.synchronization,
      github: new UnusedGitHub(staleContext),
      attemptTtlMs: 1_000,
      reportUnexpectedFailure: staleReport,
    })
    try {
      await flushConsumer()
      expect(beginSpy).toHaveBeenCalledWith(
        PROJECT_A,
        'background',
        expect.any(Number),
        expect.any(AbortSignal),
      )
      dueSpy.mockReturnValueOnce([due])
      beginSpy.mockResolvedValueOnce({ ok: false, reason: 'unconfigured' })
      staleConsumer.wake()
      await flushConsumer()
      expect(beginSpy).toHaveBeenCalledTimes(2)
      expect(staleReport).not.toHaveBeenCalled()
    } finally {
      await staleConsumer.dispose()
      await staleContext.fiber.dispose()
      dueSpy.mockRestore()
      beginSpy.mockRestore()
    }
  })

  it('recovers an unexpected Provider throw only after the durable lease expires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(200_000)
    const harness = synchronizationHarness()
    const githubConfiguration = {
      ...configuration(),
      activePollIntervalMs: 1_000,
      backgroundPollIntervalMs: 1_000,
    }
    await saveConfiguration(harness, { patch: githubConfiguration })
    const ctx = new Context()
    const provider = new ScriptedGitHub(ctx, [
      new Error('raw provider failure must not become durable data'),
      boardCandidate(githubConfiguration),
    ])
    const report = vi.fn()
    const consumer = new GitHubSynchronizationConsumer({
      synchronization: harness.synchronization,
      github: provider,
      attemptTtlMs: 1_000,
      reportUnexpectedFailure: report,
    })
    try {
      await flushConsumer()
      expect(provider.requests).toHaveLength(1)
      expect(report).toHaveBeenCalledWith('provider')
      expect(harness.syncTable.get(PROJECT_A)).toMatchObject({
        inFlightAttempt: { expiresAt: 201_000 },
      })
      expect(harness.syncTable.get(PROJECT_A)?.currentFailure).toBeUndefined()

      await vi.advanceTimersByTimeAsync(1_000)
      await flushConsumer()
      expect(provider.requests).toHaveLength(2)
      expect(harness.synchronization.board(PROJECT_A)).toMatchObject({ state: 'confirmed' })
    } finally {
      await consumer.dispose()
      await ctx.fiber.dispose()
      vi.useRealTimers()
    }
  })

  it('aborts and drains the active Provider scan before Consumer disposal resolves', async () => {
    const harness = synchronizationHarness()
    await saveConfiguration(harness)
    const ctx = new Context()
    let started: (() => void) | undefined
    const scanStarted = new Promise<void>((resolve) => { started = resolve })
    let cleaned = false
    const provider = new ScriptedGitHub(ctx, [async (signal) => {
      started?.()
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { queueMicrotask(resolve) }, { once: true })
      })
      cleaned = true
      throw signal.reason
    }])
    const report = vi.fn()
    const consumer = new GitHubSynchronizationConsumer({
      synchronization: harness.synchronization,
      github: provider,
      attemptTtlMs: 1_000,
      reportUnexpectedFailure: report,
    })
    try {
      await scanStarted
      await consumer.dispose()
      expect(cleaned).toBe(true)
      expect(report).not.toHaveBeenCalled()
      expect(harness.syncTable.get(PROJECT_A)?.inFlightAttempt).toBeDefined()
    } finally {
      await consumer.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('saturates the next poll and Consumer lease expiry at the safe timestamp maximum', async () => {
    const now = Number.MAX_SAFE_INTEGER - 500
    const date = vi.spyOn(Date, 'now').mockReturnValue(now)
    const publishedHarness = synchronizationHarness()
    try {
      await saveConfiguration(publishedHarness)
      const lease = await publishedHarness.synchronization.beginScan(
        PROJECT_A,
        'background',
        Number.MAX_SAFE_INTEGER,
        new AbortController().signal,
      )
      if (!lease.ok) throw new Error('safe-maximum scan did not begin')
      await expect(publishedHarness.synchronization.publishScan(
        PROJECT_A,
        lease.lease.attemptId,
        boardCandidate(),
        new AbortController().signal,
      )).resolves.toMatchObject({ state: 'published' })
      expect(publishedHarness.syncTable.get(PROJECT_A)?.nextScanAttempt?.attemptAt)
        .toBe(Number.MAX_SAFE_INTEGER)

      const consumerHarness = synchronizationHarness()
      await saveConfiguration(consumerHarness, { ordinal: 2 })
      let started: (() => void) | undefined
      const scanStarted = new Promise<void>((resolve) => { started = resolve })
      const ctx = new Context()
      const provider = new ScriptedGitHub(ctx, [async (signal) => {
        started?.()
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
        throw signal.reason
      }])
      const report = vi.fn()
      const consumer = new GitHubSynchronizationConsumer({
        synchronization: consumerHarness.synchronization,
        github: provider,
        attemptTtlMs: 1_000,
        reportUnexpectedFailure: report,
      })
      try {
        await scanStarted
        expect(consumerHarness.syncTable.get(PROJECT_A)?.inFlightAttempt?.expiresAt)
          .toBe(Number.MAX_SAFE_INTEGER)
        expect(report).not.toHaveBeenCalled()
      } finally {
        await consumer.dispose()
        await ctx.fiber.dispose()
      }
    } finally {
      date.mockRestore()
    }
  })
})
