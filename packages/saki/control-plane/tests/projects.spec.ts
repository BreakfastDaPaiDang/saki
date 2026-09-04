import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import WorkspaceRegistry, {
  WorkspaceId,
  workspaceDomainSpec,
} from '@deepseek-ai/dsh-workspace'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LlmRuntime, { CallId } from '@deepseek-ai/dsh-llm'
import LocalSakiHostExecution from '@breakfastdapaidang/saki-execution-local'
import {
  computeGitHubProjectBoardFingerprint,
  GitHubProviderError,
  githubAppId,
  githubCommitId,
  githubMilestoneId,
  githubPullRequestId,
  githubProjectItemStatusSetInspectionSchema,
  githubReleaseTagName,
  githubRepositoryDatabaseId,
  githubRepositoryId,
  SakiGitHub,
  type GitHubIssueId,
  type GitHubMutationMap,
  type GitHubReadMap,
  type GitHubProjectBoardScanCandidate,
  type GitHubProjectBoardFingerprintSource,
  type GitHubProjectItemId,
  type GitHubProjectOptionId,
  type GitHubScanMap,
  type GitHubTargetedWorkItemSnapshot,
} from '@breakfastdapaidang/saki-github'
import {
  canonicalDigest,
  computeProjectInspectionFingerprint,
  HostOperationAcceptance,
  startAgentRunHostOperationRequestSchema,
} from '@breakfastdapaidang/saki-execution'
import type {
  HostOperationAdmissionSource,
  HostOperationPreparation,
  HostOperationReference,
  HostOperationSnapshot,
  InspectProjectSelectionResult,
  ProjectSelectionInspection,
  ProjectSelectionProjection,
  SakiHostExecution,
  SakiHostId,
  StartAgentRunHostOperationRequest,
  TrustedProjectSelectionObservation,
} from '@breakfastdapaidang/saki-execution'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import SakiControlPlane, {
  type AnswerInterventionIntent,
  type Config,
  type ConfigureGitHubSynchronizationIntent,
  type GitHubSynchronizationConfiguration,
  type RegisterDevelopmentProjectIntent,
  type SakiAuthenticationContext,
  type SakiBoardProjection,
  type SakiControlIntentId,
  type SakiControlPlaneModule,
  type SakiDevelopmentProjectId,
  type SakiInterventionRequestId,
} from '../src/index.ts'
import { SAKI_GIT_REQUEST_FIXTURES, SAKI_PROJECT_PROJECTION_FIXTURES } from '../src/fixtures.ts'
import { resolveSakiAuthentication, takeSakiCookieHeader } from '../src/host.ts'
import { DevelopmentProjects } from '../src/projects.ts'
import { GitHubProjectSynchronization } from '../src/github-sync.ts'
import { BranchDeliveryOperations, branchDeliveryId } from '../src/branch-delivery.ts'
import {
  MilestoneDeliveryOperations,
  milestoneDeliveryIntentRecordSchema,
  milestoneDeliveryRecordSchema,
} from '../src/milestone-delivery.ts'
import {
  githubSynchronizationConfigurationIntentRecordSchema,
  registrationIntentRecordSchema,
  resourceBindingRecordSchema,
} from '../src/spec.ts'
import { sakiControlPlaneDomainSpec } from '../src/domain-spec.ts'
import type {
  DevelopmentProjectRegistryRecord,
  GrantRecord,
  RegistrationIntentRecord,
  ResourceBindingRecord,
} from '../src/spec.ts'
import {
  HISTORICAL_STORAGE_GENERATION_ID,
  provideSakiInstallationState,
  TEST_SAKI_INSTALLATION_STATE,
  type TestSakiInstallationState,
} from './installation-state.ts'

const run = promisify(execFile)
const roots: string[] = []
const openHarnesses = new Set<Harness>()
const ORIGIN = 'http://127.0.0.1:43119'
const CONTROL_CONFIG = {
  origin: ORIGIN,
  challengeTtlMs: 60_000,
  sessionTtlMs: 3_600_000,
  terminalRetentionMs: 86_400_000,
  cookieName: 'saki_session',
} as const
const DEFAULT_AGENT_PROFILE_TEMPLATE = {
  agentPresetId: 'standard',
  modelRouteRequest: { provider: 'test-provider', model: 'test-model' },
} as const
const AGENT_CONTROL_CONFIG = {
  ...CONTROL_CONFIG,
  defaultAgentProfile: DEFAULT_AGENT_PROFILE_TEMPLATE,
} as const

interface DurablePaths {
  readonly root: string
  readonly json: string
  readonly sqlite: string
}

class FakeBoardGitHub extends SakiGitHub {
  readonly requests: GitHubScanMap['project-board']['request'][] = []
  nextFailure: Error | undefined
  nextMutationFailure: Error | undefined
  agentIssueBody: string | undefined

  constructor(ctx: Context, private candidate: GitHubProjectBoardScanCandidate) {
    super(ctx)
  }

  override async read<K extends keyof GitHubReadMap>(
    request: GitHubReadMap[K]['request'],
  ): Promise<GitHubReadMap[K]['result']> {
    if (this.agentIssueBody !== undefined && request.kind === 'issue-detail') {
      const item = this.candidate.items.find(candidate => candidate.content.kind === 'issue'
        && candidate.content.issue.id === request.issueId)
      if (item?.content.kind !== 'issue') throw new GitHubProviderError({ code: 'not-found', resource: request.kind })
      return structuredClone({ ...item.content.issue, body: this.agentIssueBody })
    }
    if (this.agentIssueBody !== undefined && request.kind === 'branch-safety') {
      return { kind: 'safe', branchExists: true, observedAt: this.candidate.observedAt }
    }
    throw new GitHubProviderError({ code: 'not-found', resource: request.kind })
  }

  override async scan<K extends keyof GitHubScanMap>(
    request: GitHubScanMap[K]['request'],
    signal: AbortSignal,
  ): Promise<GitHubScanMap[K]['result']> {
    signal.throwIfAborted()
    this.requests.push(structuredClone(request))
    if (this.nextFailure !== undefined) {
      const failure = this.nextFailure
      this.nextFailure = undefined
      throw failure
    }
    return structuredClone(this.candidate)
  }

  override async dispatch<K extends keyof GitHubMutationMap>(
    request: GitHubMutationMap[K]['request'],
    signal: AbortSignal,
  ): Promise<GitHubMutationMap[K]['result']> {
    signal.throwIfAborted()
    if (request.kind !== 'project-item-status-set') throw new Error(`unexpected mutation ${request.kind}`)
    if (this.nextMutationFailure !== undefined) {
      const failure = this.nextMutationFailure
      this.nextMutationFailure = undefined
      throw failure
    }
    this.setStatusOption(request.desiredStatusOptionId)
    return undefined
  }

  setStatusOption(statusOptionId: GitHubProjectOptionId): void {
    const { fingerprint: _fingerprint, ...source } = this.candidate
    const revised: GitHubProjectBoardFingerprintSource = {
      ...source,
      observedAt: Math.max(Date.now(), source.observedAt + 1),
      items: source.items.map((item, index) => index === 0
        ? { ...item, statusOptionId }
        : item),
    }
    this.candidate = { ...revised, fingerprint: computeGitHubProjectBoardFingerprint(revised) }
  }

  override async inspectMutation<K extends keyof GitHubMutationMap>(
    request: GitHubMutationMap[K]['request'],
    signal: AbortSignal,
  ): Promise<GitHubMutationMap[K]['inspection']> {
    signal.throwIfAborted()
    if (request.kind !== 'project-item-status-set') throw new Error(`unexpected inspection ${request.kind}`)
    return githubProjectItemStatusSetInspectionSchema.parse({
      snapshot: this.targetedSnapshot(request.projectItemId),
      observedAt: Date.now(),
    })
  }

  private targetedSnapshot(projectItemId: GitHubProjectItemId): GitHubTargetedWorkItemSnapshot {
    const itemIndex = this.candidate.items.findIndex(candidate => candidate.id === projectItemId)
    const item = this.candidate.items[itemIndex]
    if (item === undefined || item.content.kind !== 'issue') throw new Error('targeted Issue fixture is missing')
    return {
      repositoryId: this.candidate.repository.id,
      repositoryDatabaseId: this.candidate.repository.databaseId,
      projectId: this.candidate.project.id,
      statusFieldId: this.candidate.statusFieldId,
      issue: item.content.issue,
      membership: {
        state: 'present',
        item: {
          id: item.id,
          projectId: item.projectId,
          issueId: item.content.issue.id,
          ...(item.statusOptionId === undefined ? {} : { statusOptionId: item.statusOptionId }),
          archived: item.archived,
          apiOrder: item.apiOrder,
          totalCount: this.candidate.items.length,
          previousItemId: this.candidate.items[itemIndex - 1]?.id ?? null,
          nextItemId: this.candidate.items[itemIndex + 1]?.id ?? null,
          updatedAt: item.updatedAt,
        },
      },
    }
  }
}

class BlockingBoardGitHub extends FakeBoardGitHub {
  readonly started: Promise<void>
  aborted = false
  private resolveStarted!: () => void

  constructor(ctx: Context, candidate: GitHubProjectBoardScanCandidate) {
    super(ctx, candidate)
    this.started = new Promise((resolve) => { this.resolveStarted = resolve })
  }

  override async scan<K extends keyof GitHubScanMap>(
    _request: GitHubScanMap[K]['request'],
    signal: AbortSignal,
  ): Promise<GitHubScanMap[K]['result']> {
    signal.throwIfAborted()
    this.resolveStarted()
    return await new Promise<GitHubScanMap[K]['result']>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        this.aborted = true
        reject(signal.reason instanceof Error
          ? signal.reason
          : new Error('blocking GitHub scan aborted', { cause: signal.reason }))
      }, { once: true })
    })
  }
}

interface Harness {
  readonly ctx: Context
  readonly control: SakiControlPlaneModule
  readonly authentication: SakiAuthenticationContext
  readonly close: () => Promise<void>
}

type SakiDomain = Domain<typeof sakiControlPlaneDomainSpec>

afterEach(async () => {
  await Promise.all([...openHarnesses].map(harness => harness.close()))
  await Promise.all(roots.splice(0).map(async (root) => { await rm(root, { recursive: true, force: true }) }))
  vi.useRealTimers()
})

async function paths(): Promise<DurablePaths> {
  const root = await mkdtemp(join(tmpdir(), 'saki-projects-'))
  roots.push(root)
  return { root, json: join(root, 'storages'), sqlite: join(root, 'saki.sqlite') }
}

async function repository(parent: string, name: string): Promise<string> {
  const root = join(parent, name)
  await run('git', ['init', root], { windowsHide: true })
  await run('git', ['config', 'user.name', 'Saki Test'], { cwd: root, windowsHide: true })
  await run('git', ['config', 'user.email', 'saki@example.invalid'], { cwd: root, windowsHide: true })
  await run('git', ['config', 'core.autocrlf', 'false'], { cwd: root, windowsHide: true })
  await run('git', ['config', 'commit.gpgSign', 'false'], { cwd: root, windowsHide: true })
  await writeFile(join(root, 'tracked.txt'), 'initial\n')
  await run('git', ['add', 'tracked.txt'], { cwd: root, windowsHide: true })
  await run('git', ['commit', '-m', 'initial'], { cwd: root, windowsHide: true })
  return root
}

async function context(
  durable: DurablePaths,
  baselineMaxFileBytes = 1024 * 1024,
  state?: TestSakiInstallationState,
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: durable.json })
  await ctx.plugin(StorageSqlite, { path: durable.sqlite, journalMode: 'delete' })
  await ctx.plugin(StorageDomain, {
    backend: 'json',
    routes: {
      saki_control_plane: 'sqlite',
      saki_host_execution: 'sqlite',
      saki_storage_generation: 'sqlite',
    },
  })
  await provideSakiInstallationState(ctx, state)
  ctx.provide('sessionPersistence', {
    list: () => Promise.resolve([]),
    load: () => Promise.reject(new Error('no sessions')),
    inspect: () => Promise.reject(new Error('no sessions')),
  } as never)
  ctx.provide('agentPresets', {} as never)
  ctx.provide('agents', {} as never)
  ctx.provide('sessions', { list: () => [] } as never)
  await ctx.plugin(WorkspaceRegistry)
  await ctx.plugin(LocalFileSystem, { cwd: durable.root })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalSakiHostExecution, {
    gitCommandTimeoutMs: 10_000,
    gitTerminationGraceMs: 100,
    maxGitStdoutBytes: 1024 * 1024,
    maxGitStderrBytes: 64 * 1024,
    baselineMaxEntries: 1_000,
    baselineMaxPathBytes: 1024 * 1024,
    baselineMaxFileBytes,
    baselineMaxTotalFileBytes: 4 * 1024 * 1024,
    baselineMaxCaptureMs: 10_000,
  })
  return ctx
}

async function seedWorkspace(durable: DurablePaths, id: string, path: string): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: durable.json })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  const domain = await ctx.storageDomain.open(workspaceDomainSpec)
  const workspaceId = WorkspaceId(id)
  const timestamp = '2026-08-20T00:00:00.000Z'
  try {
    await domain.table('workspaces').put(workspaceId, {
      path: await realpath(path),
      title: 'Pre-existing Workspace',
      sessionIds: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    await domain.global.set({
      initialized: true,
      workspaceIds: [workspaceId],
      archivedSessionIds: [],
    })
  } finally {
    await domain.close()
    await ctx.fiber.dispose()
  }
}

async function start(
  durable: DurablePaths,
  baselineMaxFileBytes = 1024 * 1024,
  state?: TestSakiInstallationState,
): Promise<Harness> {
  const ctx = await context(durable, baselineMaxFileBytes, state)
  return await mountControlPlane(ctx)
}

async function mountControlPlane(ctx: Context, config: Config = CONTROL_CONFIG): Promise<Harness> {
  const controlFiber = await ctx.plugin(SakiControlPlane, config)
  const secret = ctx.sakiControlPlane.bootstrap.take()!.consume()
  const exchange = await ctx.sakiControlPlane.access.exchangeBootstrap(
    { origin: ORIGIN }, { secret }, new AbortController().signal,
  )
  if (!exchange.ok) throw new Error('bootstrap failed')
  const cookieHeader = takeSakiCookieHeader(exchange)
  const cookie = cookieHeader?.split(';', 1)[0]?.split('=', 2)[1]
  if (cookie === undefined) throw new Error('bootstrap returned no cookie')
  const resolution = await resolveSakiAuthentication(ctx.sakiControlPlane, cookie, {
    origin: ORIGIN,
    mutation: false,
  }, new AbortController().signal)
  if (!resolution.ok) throw new Error('authentication failed')
  let closed = false
  const harness: Harness = {
    ctx,
    control: ctx.sakiControlPlane,
    authentication: resolution.authentication,
    close: async () => {
      if (closed) return
      closed = true
      openHarnesses.delete(harness)
      await controlFiber.dispose()
      await ctx.fiber.dispose()
    },
  }
  openHarnesses.add(harness)
  return harness
}

function liveSakiDomain(ctx: Context): SakiDomain {
  const domain = ctx.storageDomain.get(sakiControlPlaneDomainSpec.name)
  if (domain === undefined) throw new Error('Saki durable domain is not open')
  return domain as unknown as SakiDomain
}

async function setGrantActions(
  harness: Harness,
  actions: readonly GrantRecord['actions'][number][],
): Promise<void> {
  const table = liveSakiDomain(harness.ctx).table('grants')
  const entries = [...table.entries()]
  if (entries.length !== 1 || entries[0] === undefined) throw new Error('Grant fixture is not a singleton')
  await table.update(entries[0][0], current => ({
    ...current,
    revision: current.revision + 1,
    actions: [...actions],
  }))
}

function githubSynchronization(harness: Harness): GitHubProjectSynchronization {
  const domain = liveSakiDomain(harness.ctx)
  return new GitHubProjectSynchronization({
    syncTable: domain.table('github_project_sync'),
    intentTable: domain.table('github_sync_configuration_intents'),
    workItemRecovery: () => undefined,
    installationId: harness.control.identity().installationId,
    projectExists: () => true,
    authorityCurrent: () => true,
    validateActorReference: () => {},
  })
}

async function waitForConfirmedBoard(
  harness: Harness,
  projectId: SakiDevelopmentProjectId,
  minimumGeneration = 1,
): Promise<SakiBoardProjection> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await harness.control.query<'board'>(harness.authentication, {
      type: 'board',
      projectId,
      refresh: 'cached',
    }, new AbortController().signal)
    if (result.ok && result.projection.state === 'confirmed'
      && (result.projection.confirmed?.generation ?? 0) >= minimumGeneration) return result.projection
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
  throw new Error('GitHub synchronization Consumer did not publish a confirmed Board')
}

async function editSaki(durable: DurablePaths, operation: (domain: SakiDomain) => Promise<void>): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageSqlite, { path: durable.sqlite, journalMode: 'delete' })
  await ctx.plugin(StorageDomain, { backend: 'sqlite' })
  const domain = await ctx.storageDomain.open(sakiControlPlaneDomainSpec)
  try {
    await operation(domain)
  } finally {
    await domain.close()
    await ctx.fiber.dispose()
  }
}

async function inspected(harness: Harness, directoryLocator: string) {
  const identity = harness.control.identity()
  const result = await harness.control.query(harness.authentication, {
    type: 'inspect-project-selection',
    hostId: identity.hostId,
    directoryLocator,
  }, new AbortController().signal)
  expect(result.ok).toBe(true)
  if (!result.ok || result.projection.type !== 'inspect-project-selection' || !result.projection.result.ok) {
    throw new Error('inspection failed')
  }
  return result.projection.result.selection
}

function intent(
  id: string,
  title: string,
  directoryLocator: string,
  expectedRegistryRevision: number,
  selection: Awaited<ReturnType<typeof inspected>>,
): RegisterDevelopmentProjectIntent {
  return {
    type: 'register-development-project',
    intentId: id as SakiControlIntentId,
    projectTitle: title,
    hostId: selection.hostId,
    directoryLocator,
    expectedRegistryRevision,
    confirmedFingerprint: selection.fingerprint,
    confirmedBaseline: selection.baseline,
  }
}

function githubSynchronizationConfiguration(): GitHubSynchronizationConfiguration {
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

function githubBoardCandidate(
  configuration: GitHubSynchronizationConfiguration,
  statusOptionId = configuration.statusOptionNodeIds.ready,
): GitHubProjectBoardScanCandidate {
  const statusOptions = [
    configuration.statusOptionNodeIds.inbox,
    configuration.statusOptionNodeIds.backlog,
    configuration.statusOptionNodeIds.ready,
    configuration.statusOptionNodeIds.inProgress,
    configuration.statusOptionNodeIds.inReview,
    configuration.statusOptionNodeIds.done,
    configuration.statusOptionNodeIds.canceled,
  ] satisfies readonly GitHubProjectOptionId[]
  const issue = {
    id: 'I_saki_test_issue' as GitHubIssueId,
    repositoryId: configuration.repositoryNodeId,
    repositoryDatabaseId: configuration.repositoryDatabaseId,
    number: 27,
    state: 'open' as const,
    title: 'Publish a read-only Board',
    url: 'https://github.example.invalid/saki/issues/27',
    updatedAt: 9_000,
  }
  const source: GitHubProjectBoardFingerprintSource = {
    kind: 'project-board',
    formatVersion: 1,
    installation: {
      installationId: configuration.githubInstallationId,
      account: { id: configuration.accountNodeId, login: 'saki', type: 'organization' },
      repositorySelection: 'all',
      permissions: { repository: [], organization: [] },
      accessibleRepositoryIds: [],
      tokenExpiresAt: 70_000,
      observedAt: 10_000,
    },
    repository: {
      id: configuration.repositoryNodeId,
      databaseId: configuration.repositoryDatabaseId,
      ownerAccountId: configuration.accountNodeId,
      nameWithOwner: 'BreakfastDaPaiDang/saki',
      visibility: 'public',
      url: 'https://github.example.invalid/BreakfastDaPaiDang/saki',
      updatedAt: 9_000,
      observedAt: 10_000,
    },
    project: {
      id: configuration.projectNodeId,
      ownerAccountId: configuration.accountNodeId,
      number: 1,
      title: 'Saki',
      closed: false,
      url: 'https://github.example.invalid/orgs/BreakfastDaPaiDang/projects/1',
      updatedAt: 9_000,
      observedAt: 10_000,
    },
    statusFieldId: configuration.statusFieldNodeId,
    fields: [{
      kind: 'single-select',
      id: configuration.statusFieldNodeId,
      name: 'Status',
      options: statusOptions.map((id, index) => ({ id, name: `Status ${index}` })),
    }],
    items: [{
      id: 'PVTI_saki_test_item' as GitHubProjectItemId,
      projectId: configuration.projectNodeId,
      content: { kind: 'issue', issue },
      statusOptionId,
      archived: false,
      apiOrder: 0,
      updatedAt: 9_000,
    }],
    openIssues: [issue],
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

function refingerprintCandidate(
  candidate: GitHubProjectBoardScanCandidate,
  patch: Partial<GitHubProjectBoardFingerprintSource>,
): GitHubProjectBoardScanCandidate {
  const { fingerprint: _fingerprint, ...source } = candidate
  const revised = { ...source, ...patch }
  return { ...revised, fingerprint: computeGitHubProjectBoardFingerprint(revised) }
}

function signedInspection(
  projection: Omit<ProjectSelectionProjection, 'fingerprint'>,
  trusted: TrustedProjectSelectionObservation,
): ProjectSelectionInspection {
  return {
    trusted,
    projection: {
      ...projection,
      fingerprint: computeProjectInspectionFingerprint(projection, trusted),
    },
  }
}

function fixtureInspection(
  hostId: SakiHostId,
  canonicalWorktreePath: string,
  identityDigit: string,
  workspaceId?: WorkspaceId,
): ProjectSelectionInspection {
  const { fingerprint, ...projection } = SAKI_PROJECT_PROJECTION_FIXTURES.cleanSelection
  void fingerprint
  const canonicalGitDirectory = join(canonicalWorktreePath, '.git')
  return signedInspection({
    ...projection,
    hostId,
    ...(workspaceId === undefined ? {} : { workspaceId }),
  }, {
    canonicalWorktreePath,
    canonicalGitDirectory,
    canonicalCommonGitDirectory: canonicalGitDirectory,
    gitDirectoryIdentity: { version: 1, digest: identityDigit.repeat(64) },
    commonGitDirectoryIdentity: { version: 1, digest: identityDigit.repeat(64) },
    comparison: { fileMode: true, symlinks: true, autocrlf: false },
  })
}

function clearRegistrationCommit(candidate: RegistrationIntentRecord): void {
  delete candidate.projectId
  delete candidate.resourceBindingId
  delete candidate.registryRevision
}

function clearRegistrationWorkspace(candidate: RegistrationIntentRecord): void {
  delete candidate.workspaceId
  delete candidate.workspaceInspection
}

async function disposeDuringDispatchInspection(
  harness: Harness,
  request: RegisterDevelopmentProjectIntent,
): Promise<void> {
  const originalInspect = harness.ctx.sakiHostExecution.inspectProjectSelection
    .bind(harness.ctx.sakiHostExecution)
  const started = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  let inspectionCount = 0
  vi.spyOn(harness.ctx.sakiHostExecution, 'inspectProjectSelection')
    .mockImplementation(async (input, signal) => {
      inspectionCount += 1
      if (inspectionCount === 2) {
        started.resolve(undefined)
        await release.promise
      }
      return await originalInspect(input, signal)
    })
  const submission = harness.control.submit(
    harness.authentication,
    request,
    new AbortController().signal,
  )
  await started.promise
  const closing = harness.close()
  release.resolve(undefined)
  await expect(submission).rejects.toThrow()
  await closing
}

class TestAgentRunAcceptance extends HostOperationAcceptance {
  constructor(readonly operationId: string) { super() }
}

interface AgentRunHostFixture {
  readonly requests: StartAgentRunHostOperationRequest[]
  readonly startCount: number
  beforeSuccess: (() => Promise<void>) | undefined
  beginNextOperation(): void
}

function installAgentRunHostFixture(execution: SakiHostExecution): AgentRunHostFixture {
  let pending: {
    readonly request: StartAgentRunHostOperationRequest
    readonly admission: HostOperationAdmissionSource
    readonly preparation: HostOperationPreparation<'start-agent-run'>
    readonly snapshot: HostOperationSnapshot<'start-agent-run'>
    readonly acceptance: TestAgentRunAcceptance
  } | undefined
  let completed: HostOperationSnapshot<'start-agent-run'> | undefined
  const state = {
    requests: [] as StartAgentRunHostOperationRequest[],
    startCount: 0,
    beforeSuccess: undefined as (() => Promise<void>) | undefined,
    beginNextOperation: () => {
      pending = undefined
      completed = undefined
    },
  }
  const prepareOperation = execution.prepareOperation.bind(execution)
  const startOperation = execution.startOperation.bind(execution)
  const inspectOperation = execution.inspectOperation.bind(execution)
  vi.spyOn(execution, 'prepareOperation').mockImplementation(async (request, admission, signal) => {
    if (request.type !== 'start-agent-run') return await prepareOperation(request, admission, signal)
    signal.throwIfAborted()
    const parsed = startAgentRunHostOperationRequestSchema.parse(request)
    state.requests.push(parsed)
    const operation = {
      id: parsed.source.dispatchId.replace(/^dispatch-/u, 'host-operation-'),
      hostId: parsed.expected.binding.hostId,
      type: 'start-agent-run',
    } as HostOperationReference<'start-agent-run'>
    const preparation = {
      operation,
      preparationRevision: 0,
      requestFingerprint: {
        version: 1 as const,
        digest: canonicalDigest('saki/test-service-agent-host-request/v1', parsed),
      },
    }
    const snapshot = {
      operation,
      revision: 0,
      source: parsed.source,
      requestFingerprint: preparation.requestFingerprint,
      bindingId: parsed.expected.binding.id,
      bindingRevision: parsed.expected.binding.revision,
      preparedAt: 1,
      updatedAt: 1,
      state: 'prepared',
      admission: { kind: 'not-accepted' },
    } as const
    const acceptance = new TestAgentRunAcceptance(operation.id)
    pending = { request: parsed, admission, preparation, snapshot, acceptance }
    return { ok: true, preparation, snapshot, acceptance } as never
  })
  vi.spyOn(execution, 'startOperation').mockImplementation(async (operation, acceptance, signal) => {
    if (operation.type !== 'start-agent-run') return await startOperation(operation, acceptance, signal)
    signal.throwIfAborted()
    if (pending?.preparation.operation.id !== operation.id || pending.acceptance !== acceptance
      || pending.acceptance.operationId !== operation.id) {
      throw new Error('Agent Run Host fixture received mismatched start authority')
    }
    state.startCount += 1
    const decision = await pending.admission({
      bindingId: pending.request.expected.binding.id,
      bindingRevision: pending.request.expected.binding.revision,
      preparation: pending.preparation,
      source: pending.request.source,
    }, signal)
    if (decision.kind !== 'accepted') throw new Error('Agent Run Host fixture was not admitted')
    await state.beforeSuccess?.()
    completed = {
      ...pending.snapshot,
      revision: 1,
      updatedAt: 3,
      state: 'succeeded',
      admission: { kind: 'accepted', revision: decision.admissionRevision, acceptedAt: 2 },
      completedAt: 3,
      result: {
        type: 'start-agent-run',
        agentRunId: pending.request.run.agentRunId,
        workSessionId: pending.request.run.workSessionId,
        sessionId: pending.request.run.sessionId,
        inputMessageId: pending.request.run.input.id,
      },
    }
    return { ok: true, snapshot: completed } as never
  })
  vi.spyOn(execution, 'inspectOperation').mockImplementation(async (operation, signal) => {
    if (operation.type !== 'start-agent-run') return await inspectOperation(operation, signal)
    signal.throwIfAborted()
    if (pending?.preparation.operation.id !== operation.id) {
      throw new Error('Agent Run Host fixture received an unknown inspection')
    }
    return completed ?? pending.snapshot
  })
  return state
}

describe('Development Project registration', { timeout: 60_000 }, () => {
  it('bounds the independent durable-pending targeted polling interval', () => {
    expect(SakiControlPlane.Config(CONTROL_CONFIG).targetedPendingPollIntervalMs).toBe(300_000)
    expect(SakiControlPlane.Config({ ...CONTROL_CONFIG, targetedPendingPollIntervalMs: 1_000 })
      .targetedPendingPollIntervalMs).toBe(1_000)
    expect(() => SakiControlPlane.Config({ ...CONTROL_CONFIG, targetedPendingPollIntervalMs: 999 })).toThrow()
    expect(() => SakiControlPlane.Config({
      ...CONTROL_CONFIG,
      targetedPendingPollIntervalMs: 86_400_001,
    })).toThrow()
  })

  it('owns one non-overlapping targeted-pending loop for each Provider lifetime', async () => {
    vi.useFakeTimers()
    const branchFailure = new Error('injected Branch polling failure')
    const branchPolling = vi.spyOn(BranchDeliveryOperations.prototype, 'pollPending')
      .mockRejectedValueOnce(branchFailure)
      .mockResolvedValue(undefined)
    let releaseMilestone!: () => void
    const milestoneBlocked = new Promise<void>((resolve) => { releaseMilestone = resolve })
    let milestoneCalls = 0
    const milestonePolling = vi.spyOn(MilestoneDeliveryOperations.prototype, 'pollPending')
      .mockImplementation(async (signal) => {
        milestoneCalls++
        if (milestoneCalls === 1) await milestoneBlocked
        signal.throwIfAborted()
      })
    onTestFinished(() => {
      branchPolling.mockRestore()
      milestonePolling.mockRestore()
    })
    const durable = await paths()
    const configuration = githubSynchronizationConfiguration()
    const ctx = await context(durable)
    const diagnostic = vi.spyOn(ctx.logger, 'error').mockImplementation(() => ctx.logger)
    const providerFiber = await ctx.plugin((providerContext: Context) => {
      new FakeBoardGitHub(providerContext, githubBoardCandidate(configuration))
    })
    const harness = await mountControlPlane(ctx, {
      ...CONTROL_CONFIG,
      targetedPendingPollIntervalMs: 1_000,
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(branchPolling).toHaveBeenCalledOnce()
    expect(milestonePolling).toHaveBeenCalledOnce()
    expect(diagnostic).toHaveBeenCalledWith(`Saki Branch Delivery polling failed: ${String(branchFailure)}`)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(branchPolling).toHaveBeenCalledOnce()
    expect(milestonePolling).toHaveBeenCalledOnce()

    releaseMilestone()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(999)
    expect(branchPolling).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(branchPolling).toHaveBeenCalledTimes(2)
    expect(milestonePolling).toHaveBeenCalledTimes(2)

    await providerFiber.dispose()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(branchPolling).toHaveBeenCalledTimes(2)
    expect(milestonePolling).toHaveBeenCalledTimes(2)
    await harness.close()
  })

  it('reads Project changes and Diff through the exact trusted active binding while stale reads avoid Host calls', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'read-only-changes')
    const harness = await start(durable)
    const selection = await inspected(harness, repo)
    const registered = await harness.control.submit(harness.authentication, intent(
      'intent-10101010-1010-4010-8010-101010101010',
      'Read-only changes',
      repo,
      0,
      selection,
    ), new AbortController().signal)
    if (!registered.ok) throw new Error('registration failed')
    await writeFile(join(repo, 'tracked.txt'), 'initial\nchanged\n')

    const inspect = vi.spyOn(harness.ctx.sakiHostExecution, 'inspectProject')
    const stale = await harness.control.query<'project-changes'>(harness.authentication, {
      type: 'project-changes',
      projectId: registered.receipt.projectId,
      expectedRegistryRevision: 0,
    }, new AbortController().signal)
    expect(stale).toEqual({ ok: false, reason: 'stale' })
    expect(inspect).not.toHaveBeenCalled()

    const changes = await harness.control.query<'project-changes'>(harness.authentication, {
      type: 'project-changes',
      projectId: registered.receipt.projectId,
      expectedRegistryRevision: 1,
    }, new AbortController().signal)
    expect(changes).toMatchObject({
      ok: true,
      projection: { type: 'project-changes', registryRevision: 1, projectRevision: 0, result: { ok: true } },
    })
    if (!changes.ok || !changes.projection.result.ok) throw new Error('changes unavailable')
    expect('preEffectBaseline' in changes.projection.result).toBe(false)
    expect(inspect).toHaveBeenCalledOnce()
    const inspectedRequest = inspect.mock.calls[0]?.[0]
    expect(inspectedRequest?.binding.health).toBe('active')
    expect(inspectedRequest?.binding.expectedInspection.trusted.canonicalWorktreePath).toBe(await realpath(repo))

    const change = changes.projection.result.observation.changes.find(candidate => candidate.path === 'tracked.txt')
    if (change === undefined) throw new Error('tracked change absent')
    inspect.mockResolvedValueOnce({ ok: false, reason: 'unavailable' })
    expect(await harness.control.query<'project-changes'>(harness.authentication, {
      type: 'project-changes',
      projectId: registered.receipt.projectId,
      expectedRegistryRevision: 1,
    }, new AbortController().signal)).toMatchObject({
      ok: true,
      projection: { result: { ok: false, reason: 'unavailable' } },
    })
    const diff = await harness.control.query<'project-diff'>(harness.authentication, {
      type: 'project-diff',
      projectId: registered.receipt.projectId,
      expectedRegistryRevision: 1,
      request: {
        expectedStatus: changes.projection.result.observation.fingerprint,
        changeId: change.id,
        layer: 'unstaged',
      },
    }, new AbortController().signal)
    expect(diff).toMatchObject({
      ok: true,
      projection: { type: 'project-diff', registryRevision: 1, result: { ok: true } },
    })
  })

  it('suppresses a completed Host changes result when the current Grant drifts during the call', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'changes-grant-drift')
    const harness = await start(durable)
    const selection = await inspected(harness, repo)
    const registered = await harness.control.submit(harness.authentication, intent(
      'intent-20202020-2020-4020-8020-202020202020', 'Grant drift', repo, 0, selection,
    ), new AbortController().signal)
    if (!registered.ok) throw new Error('registration failed')
    const original = harness.ctx.sakiHostExecution.inspectProject.bind(harness.ctx.sakiHostExecution)
    let release!: () => void
    let started!: () => void
    const startedPromise = new Promise<void>((resolve) => { started = resolve })
    const releasePromise = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(harness.ctx.sakiHostExecution, 'inspectProject').mockImplementation(async (request, signal) => {
      const result = await original(request, signal)
      started()
      await releasePromise
      return result
    })
    const pending = harness.control.query<'project-changes'>(harness.authentication, {
      type: 'project-changes', projectId: registered.receipt.projectId, expectedRegistryRevision: 1,
    }, new AbortController().signal)
    await startedPromise
    await setGrantActions(harness, ['project-index:read'])
    release()
    await expect(pending).resolves.toEqual({ ok: false, reason: 'denied' })
  })

  it('suppresses a completed Host changes result when the Registry drifts during the call', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'changes-registry-drift')
    const harness = await start(durable)
    const selection = await inspected(harness, repo)
    const registered = await harness.control.submit(harness.authentication, intent(
      'intent-30303030-3030-4030-8030-303030303030', 'Registry drift', repo, 0, selection,
    ), new AbortController().signal)
    if (!registered.ok) throw new Error('registration failed')
    const original = harness.ctx.sakiHostExecution.inspectProject.bind(harness.ctx.sakiHostExecution)
    let release!: () => void
    let started!: () => void
    const startedPromise = new Promise<void>((resolve) => { started = resolve })
    const releasePromise = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(harness.ctx.sakiHostExecution, 'inspectProject').mockImplementation(async (request, signal) => {
      const result = await original(request, signal)
      started()
      await releasePromise
      return result
    })
    const pending = harness.control.query<'project-changes'>(harness.authentication, {
      type: 'project-changes', projectId: registered.receipt.projectId, expectedRegistryRevision: 1,
    }, new AbortController().signal)
    await startedPromise
    const table = liveSakiDomain(harness.ctx).table('development_project_registry')
    const entry = [...table.entries()][0]
    if (entry === undefined) throw new Error('registry absent')
    await table.update(entry[0], current => ({ ...current, revision: current.revision + 1 }))
    release()
    await expect(pending).resolves.toEqual({ ok: false, reason: 'stale' })
  })

  it.each([
    ['Grant', 'denied'],
    ['Registry', 'stale'],
  ] as const)('suppresses a completed Host Diff when the current %s drifts during the call', async (drift, reason) => {
    const durable = await paths()
    const repo = await repository(durable.root, `diff-${drift.toLowerCase()}-drift`)
    const harness = await start(durable)
    const selection = await inspected(harness, repo)
    const registered = await harness.control.submit(harness.authentication, intent(
      drift === 'Grant'
        ? 'intent-40404040-4040-4040-8040-404040404040'
        : 'intent-41414141-4141-4141-8141-414141414141',
      `${drift} Diff drift`,
      repo,
      0,
      selection,
    ), new AbortController().signal)
    if (!registered.ok) throw new Error('registration failed')
    await writeFile(join(repo, 'tracked.txt'), 'initial\nchanged\n')
    const changes = await harness.control.query<'project-changes'>(harness.authentication, {
      type: 'project-changes',
      projectId: registered.receipt.projectId,
      expectedRegistryRevision: 1,
    }, new AbortController().signal)
    if (!changes.ok || !changes.projection.result.ok) throw new Error('changes unavailable')
    const change = changes.projection.result.observation.changes.find(candidate => candidate.path === 'tracked.txt')
    if (change === undefined) throw new Error('tracked change absent')
    const original = harness.ctx.sakiHostExecution.readDiff.bind(harness.ctx.sakiHostExecution)
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(harness.ctx.sakiHostExecution, 'readDiff').mockImplementation(async (binding, request, signal) => {
      const result = await original(binding, request, signal)
      started.resolve(undefined)
      await release.promise
      return result
    })
    const pending = harness.control.query<'project-diff'>(harness.authentication, {
      type: 'project-diff',
      projectId: registered.receipt.projectId,
      expectedRegistryRevision: 1,
      request: {
        expectedStatus: changes.projection.result.observation.fingerprint,
        changeId: change.id,
        layer: 'unstaged',
      },
    }, new AbortController().signal)
    await started.promise
    if (drift === 'Grant') {
      await setGrantActions(harness, ['project-index:read'])
    } else {
      const table = liveSakiDomain(harness.ctx).table('development_project_registry')
      await table.update('development-project-registry', current => ({ ...current, revision: current.revision + 1 }))
    }
    release.resolve(undefined)
    await expect(pending).resolves.toEqual({ ok: false, reason })
  })

  it('persists one real Git/Workspace/SQLite registration and replays stable ids after restart', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'ordinary')
    let harness = await start(durable)
    const selection = await inspected(harness, repo)
    const request = intent('intent-11111111-1111-4111-8111-111111111111', 'Ordinary project', repo, 0, selection)

    const first = await harness.control.submit(harness.authentication, request, new AbortController().signal)
    expect(first).toMatchObject({ ok: true, receipt: { state: 'confirmed', registryRevision: 1 } })
    const replay = await harness.control.submit(harness.authentication, request, new AbortController().signal)
    expect(replay).toEqual(first)
    const index = await harness.control.query(harness.authentication, { type: 'project-index' }, new AbortController().signal)
    expect(index).toMatchObject({
      ok: true,
      projection: {
        type: 'project-index',
        revision: 1,
        projects: [{ projectTitle: 'Ordinary project', binding: { health: 'active', baseline: 'complete' } }],
      },
    })
    await harness.close()

    harness = await start(durable)
    const reopened = await harness.control.query(harness.authentication, { type: 'project-index' }, new AbortController().signal)
    expect(reopened).toMatchObject({
      ok: true,
      projection: { projects: [{ id: first.ok ? first.receipt.projectId : 'missing' }] },
    })
    const workspaceMedium = JSON.parse(await readFile(join(durable.json, 'workspace.json'), 'utf8')) as {
      unit: { name: string; version: number; formatVersion: number; hasGlobal: boolean }
      global: { archivedSessionIds: unknown }
    }
    expect(workspaceMedium.unit).toEqual({ name: 'workspace', version: 2, formatVersion: 1, hasGlobal: true })
    expect(workspaceMedium.global).toHaveProperty('archivedSessionIds')
    const database = new DatabaseSync(durable.sqlite)
    try {
      expect(database.prepare('SELECT name, version FROM units ORDER BY name').all()).toEqual([
        { name: 'saki_control_plane', version: 8 },
        { name: 'saki_host_execution', version: 3 },
        { name: 'saki_storage_generation', version: 6 },
      ])
      const tables = database.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
      ).all().map(row => (row as { name: string }).name)
      expect(tables.filter(name => !name.startsWith('u2_'))).toEqual([
        'unit_globals',
        'unit_tables',
        'units',
      ])
      expect(tables.filter(name => name.startsWith('u2_'))).toHaveLength(22)
      expect(database.prepare(
        'SELECT table_name FROM unit_tables WHERE unit = ? ORDER BY table_name',
      ).all('saki_control_plane')).toEqual([
        { table_name: 'agent_operation_intents' },
        { table_name: 'agent_runs' },
        { table_name: 'binding_write_admissions' },
        { table_name: 'control_state' },
        { table_name: 'development_project_registry' },
        { table_name: 'execution_dispatches' },
        { table_name: 'git_operation_intents' },
        { table_name: 'github_project_sync' },
        { table_name: 'github_sync_configuration_intents' },
        { table_name: 'github_work_item_intents' },
        { table_name: 'github_work_item_recovery' },
        { table_name: 'grants' },
        { table_name: 'hosts' },
        { table_name: 'installation_access' },
        { table_name: 'installations' },
        { table_name: 'intervention_requests' },
        { table_name: 'principals' },
        { table_name: 'registration_intents' },
        { table_name: 'work_assignments' },
        { table_name: 'work_sessions' },
      ])
      expect(database.prepare(
        'SELECT table_name FROM unit_tables WHERE unit = ? ORDER BY table_name',
      ).all('saki_host_execution')).toEqual([
        { table_name: 'operations' },
      ])
      expect(database.prepare(
        'SELECT table_name FROM unit_tables WHERE unit = ? ORDER BY table_name',
      ).all('saki_storage_generation')).toEqual([
        { table_name: 'storage_generation' },
      ])
    } finally {
      database.close()
    }
    await harness.close()
  })

  it('saves a pending GitHub synchronization configuration without activating it', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'github-sync-save')
    const harness = await start(durable)
    const selection = await inspected(harness, repo)
    const registered = await harness.control.submit(harness.authentication, intent(
      'intent-12121212-1212-4212-8212-121212121212',
      'GitHub synchronization',
      repo,
      0,
      selection,
    ), new AbortController().signal)
    if (!registered.ok) throw new Error('registration failed')
    const configuration = githubSynchronizationConfiguration()
    const request = {
      type: 'configure-github-synchronization',
      intentId: 'intent-13131313-1313-4313-8313-131313131313',
      projectId: registered.receipt.projectId,
      expectedSynchronizationRevision: 0,
      patch: configuration,
    } as unknown as ConfigureGitHubSynchronizationIntent

    const saved = await harness.control.submit(harness.authentication, request, new AbortController().signal)
    expect(saved).toMatchObject({
      ok: true,
      receipt: {
        id: 'receipt-13131313-1313-4313-8313-131313131313',
        intentId: request.intentId,
        state: 'saved',
        projectId: registered.receipt.projectId,
        synchronizationRevision: 1,
        candidateRevision: 1,
      },
    })
    const settings = await harness.control.query(harness.authentication, {
      type: 'project-settings',
      projectId: registered.receipt.projectId,
    }, new AbortController().signal)
    expect(settings).toMatchObject({
      ok: true,
      projection: {
        type: 'project-settings',
        projectId: registered.receipt.projectId,
        synchronization: {
          revision: 1,
          state: 'saved',
          pending: {
            revision: 1,
            changedFields: Object.keys(configuration),
            configuration,
          },
        },
      },
    })
    expect(settings).not.toHaveProperty('projection.synchronization.active')
    await harness.close()
  })

  it('uses the GitHub configuration action for submission and prepared-Intent recovery', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'github-sync-authority')
    let harness = await start(durable)
    const registered = await harness.control.submit(harness.authentication, intent(
      'intent-12131313-1213-4213-8213-121313131213',
      'GitHub synchronization authority',
      repo,
      0,
      await inspected(harness, repo),
    ), new AbortController().signal)
    if (!registered.ok) throw new Error('registration failed')
    await setGrantActions(harness, ['github-synchronization:configure'])

    expect(await harness.control.submit(harness.authentication, {
      type: 'configure-github-synchronization',
      intentId: 'intent-13141414-1314-4314-8314-131414141314' as SakiControlIntentId,
      projectId: registered.receipt.projectId,
      expectedSynchronizationRevision: 0,
      patch: githubSynchronizationConfiguration(),
    }, new AbortController().signal)).toMatchObject({ ok: true, receipt: { state: 'saved' } })

    const recoveringId = 'intent-14151515-1415-4415-8415-141515151415' as SakiControlIntentId
    const intents = liveSakiDomain(harness.ctx).table('github_sync_configuration_intents')
    const put = intents.put.bind(intents)
    vi.spyOn(intents, 'put').mockImplementationOnce(async (key, value) => {
      await put(key, value)
      throw new Error('simulated crash after prepared GitHub Intent')
    })
    await expect(harness.control.submit(harness.authentication, {
      type: 'configure-github-synchronization',
      intentId: recoveringId,
      projectId: registered.receipt.projectId,
      expectedSynchronizationRevision: 1,
      patch: { rateLimitReserve: 750 },
    }, new AbortController().signal)).rejects.toThrow('simulated crash after prepared GitHub Intent')
    expect(intents.get(recoveringId)).toMatchObject({ phase: 'prepared' })
    await harness.close()

    harness = await start(durable)
    expect(liveSakiDomain(harness.ctx).table('github_sync_configuration_intents').get(recoveringId))
      .toMatchObject({ phase: 'saved', synchronizationRevision: 2, candidateRevision: 2 })
    expect(liveSakiDomain(harness.ctx).table('github_project_sync').get(registered.receipt.projectId))
      .toMatchObject({ revision: 2, pending: { revision: 2 } })

    const revokedRecoveryId = 'intent-15161616-1516-4516-8516-151616161516' as SakiControlIntentId
    const restartedIntents = liveSakiDomain(harness.ctx).table('github_sync_configuration_intents')
    const restartedPut = restartedIntents.put.bind(restartedIntents)
    vi.spyOn(restartedIntents, 'put').mockImplementationOnce(async (key, value) => {
      await restartedPut(key, value)
      throw new Error('simulated crash before revoked GitHub recovery')
    })
    await expect(harness.control.submit(harness.authentication, {
      type: 'configure-github-synchronization',
      intentId: revokedRecoveryId,
      projectId: registered.receipt.projectId,
      expectedSynchronizationRevision: 2,
      patch: { rateLimitReserve: 900 },
    }, new AbortController().signal)).rejects.toThrow('simulated crash before revoked GitHub recovery')
    await setGrantActions(harness, ['development-project:register'])
    await harness.close()

    harness = await start(durable)
    expect(liveSakiDomain(harness.ctx).table('github_sync_configuration_intents').get(revokedRecoveryId))
      .toMatchObject({ phase: 'failure', terminalReason: 'authority' })
    const deniedId = 'intent-16171717-1617-4617-8617-161717171617' as SakiControlIntentId
    expect(await harness.control.submit(harness.authentication, {
      type: 'configure-github-synchronization',
      intentId: deniedId,
      projectId: registered.receipt.projectId,
      expectedSynchronizationRevision: 2,
      patch: { rateLimitReserve: 950 },
    }, new AbortController().signal)).toEqual({ ok: false, reason: 'denied' })
    expect(liveSakiDomain(harness.ctx).table('github_sync_configuration_intents').get(deniedId)).toBeUndefined()
    await harness.close()
  })

  it('reserves each Control Intent id across registration, GitHub configuration, and Git operations', async () => {
    const durable = await paths()
    const firstRepository = await repository(durable.root, 'cross-intent-first')
    const secondRepository = await repository(durable.root, 'cross-intent-second')
    const harness = await start(durable)
    const firstSelection = await inspected(harness, firstRepository)
    const firstRegistration = await harness.control.submit(harness.authentication, intent(
      'intent-14141414-1414-4414-8414-141414141414',
      'First Project',
      firstRepository,
      0,
      firstSelection,
    ), new AbortController().signal)
    if (!firstRegistration.ok) throw new Error('first registration failed')

    const configureFirstId = 'intent-15151515-1515-4515-8515-151515151515' as SakiControlIntentId
    expect(await harness.control.submit(harness.authentication, {
      type: 'configure-github-synchronization',
      intentId: configureFirstId,
      projectId: firstRegistration.receipt.projectId,
      expectedSynchronizationRevision: 0,
      patch: githubSynchronizationConfiguration(),
    }, new AbortController().signal)).toMatchObject({ ok: true })
    expect(await harness.control.submit(harness.authentication, intent(
      configureFirstId,
      'Conflicting registration',
      firstRepository,
      1,
      firstSelection,
    ), new AbortController().signal)).toEqual({ ok: false, reason: 'conflict' })
    expect(await harness.control.submit(harness.authentication, {
      ...SAKI_GIT_REQUEST_FIXTURES.unstage,
      intentId: configureFirstId,
    }, new AbortController().signal)).toEqual({ ok: false, reason: 'conflict' })
    expect(await harness.control.submit(harness.authentication, {
      ...SAKI_GIT_REQUEST_FIXTURES.commit,
      intentId: configureFirstId,
    }, new AbortController().signal)).toEqual({ ok: false, reason: 'conflict' })

    const secondSelection = await inspected(harness, secondRepository)
    const registerFirstId = 'intent-16161616-1616-4616-8616-161616161616' as SakiControlIntentId
    const secondRegistration = await harness.control.submit(harness.authentication, intent(
      registerFirstId,
      'Second Project',
      secondRepository,
      1,
      secondSelection,
    ), new AbortController().signal)
    if (!secondRegistration.ok) throw new Error('second registration failed')
    expect(await harness.control.submit(harness.authentication, {
      type: 'configure-github-synchronization',
      intentId: registerFirstId,
      projectId: secondRegistration.receipt.projectId,
      expectedSynchronizationRevision: 0,
      patch: githubSynchronizationConfiguration(),
    }, new AbortController().signal)).toEqual({ ok: false, reason: 'conflict' })

    const domain = liveSakiDomain(harness.ctx)
    expect(domain.table('registration_intents').get(configureFirstId)).toBeUndefined()
    expect(domain.table('github_sync_configuration_intents').get(registerFirstId)).toBeUndefined()
    await harness.close()

    await editSaki(durable, async (editable) => {
      const table = editable.table('github_sync_configuration_intents')
      const source = table.get(configureFirstId)
      if (source === undefined) throw new Error('GitHub configuration fixture is unavailable')
      const payload = {
        ...source.payload,
        intent: {
          ...source.payload.intent,
          intentId: registerFirstId,
          projectId: secondRegistration.receipt.projectId,
        },
      }
      const {
        candidateRevision: _candidateRevision,
        synchronizationRevision: _synchronizationRevision,
        ...withoutSavedEvidence
      } = source
      await table.put(registerFirstId, githubSynchronizationConfigurationIntentRecordSchema.parse({
        ...withoutSavedEvidence,
        id: registerFirstId,
        receiptId: registerFirstId.replace(/^intent-/u, 'receipt-'),
        payload,
        payloadDigest: canonicalDigest('saki/configure-github-synchronization/v1', payload),
        phase: 'conflict',
        terminalReason: 'expected-revision',
      }))
    })

    const restarted = await context(durable)
    try {
      await expect(restarted.plugin(SakiControlPlane, CONTROL_CONFIG))
        .rejects.toThrow(`Saki Control Intent '${registerFirstId}' is retained by multiple Intent kinds`)
    } finally {
      await restarted.fiber.dispose()
    }
  })

  it('drives durable configuration work through an optional GitHub Provider', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'github-sync-consumer')
    const configuration = githubSynchronizationConfiguration()
    const ctx = await context(durable)
    let github: FakeBoardGitHub | undefined
    const providerFiber = await ctx.plugin((providerContext: Context) => {
      github = new FakeBoardGitHub(providerContext, githubBoardCandidate(configuration))
    })
    const harness = await mountControlPlane(ctx)
    const registered = await harness.control.submit(harness.authentication, intent(
      'intent-20202020-2020-4020-8020-202020202020',
      'GitHub synchronization Consumer',
      repo,
      0,
      await inspected(harness, repo),
    ), new AbortController().signal)
    if (!registered.ok) throw new Error('registration failed')

    expect(await harness.control.submit(harness.authentication, {
      type: 'configure-github-synchronization',
      intentId: 'intent-21202020-2020-4120-8120-212020202020' as SakiControlIntentId,
      projectId: registered.receipt.projectId,
      expectedSynchronizationRevision: 0,
      patch: configuration,
    }, new AbortController().signal)).toMatchObject({ ok: true, receipt: { state: 'saved' } })

    const board = await waitForConfirmedBoard(harness, registered.receipt.projectId)
    if (github === undefined) throw new Error('GitHub Provider fixture did not start')
    expect(github.requests).toHaveLength(1)
    expect(github.requests[0]).toMatchObject({
      installation: { appId: configuration.appId },
      projectId: configuration.projectNodeId,
      statusFieldId: configuration.statusFieldNodeId,
      priority: 'background',
    })
    expect(board).toMatchObject({
      synchronizationRevision: 1,
      confirmed: { generation: 1, configurationRevision: 1 },
      checkpoint: { generation: 1, configurationRevision: 1 },
    })
    const diagnostic = vi.spyOn(ctx.logger, 'error').mockImplementation(() => ctx.logger)
    github.nextFailure = new Error('provider escaped its typed failure interface')
    expect(await harness.control.query(harness.authentication, {
      type: 'board',
      projectId: registered.receipt.projectId,
      refresh: 'interactive',
    }, new AbortController().signal)).toMatchObject({ ok: true })
    for (let attempt = 0; attempt < 200 && diagnostic.mock.calls.length === 0; attempt++) {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    expect(github.requests).toHaveLength(2)
    expect(github.requests[1]).toMatchObject({ priority: 'interactive' })
    expect(diagnostic).toHaveBeenCalledWith(
      'Saki GitHub synchronization provider failed outside its typed failure interface',
    )
    await providerFiber.dispose()
    await harness.close()
  })

  it('routes Branch Delivery intents and preserves a safe cached projection when refresh is unavailable', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'branch-delivery-control-route')
    const configuration = githubSynchronizationConfiguration()
    const ctx = await context(durable)
    const providerFiber = await ctx.plugin((providerContext: Context) => {
      new FakeBoardGitHub(providerContext, githubBoardCandidate(configuration))
    })
    const harness = await mountControlPlane(ctx)
    const registered = await harness.control.submit(harness.authentication, intent(
      'intent-22202020-2020-4020-8020-202020202020',
      'Branch Delivery control route',
      repo,
      0,
      await inspected(harness, repo),
    ), new AbortController().signal)
    if (!registered.ok) throw new Error('registration failed')
    expect(await harness.control.submit(harness.authentication, {
      type: 'configure-github-synchronization',
      intentId: 'intent-22212020-2020-4120-8120-202020202020' as SakiControlIntentId,
      projectId: registered.receipt.projectId,
      expectedSynchronizationRevision: 0,
      patch: configuration,
    }, new AbortController().signal)).toMatchObject({ ok: true })
    const board = await waitForConfirmedBoard(harness, registered.receipt.projectId)
    const item = board.confirmed?.items[0]
    const mappingRevision = board.mapping.state === 'valid' ? board.mapping.configurationRevision : undefined
    const registry = liveSakiDomain(harness.ctx).table('development_project_registry')
      .get('development-project-registry')
    const project = registry?.projects.find(candidate => candidate.id === registered.receipt.projectId)
    const binding = registry?.resourceBindings.find(candidate => candidate.projectId === project?.id)
    if (item === undefined || mappingRevision === undefined || registry === undefined
      || project === undefined || binding === undefined) throw new Error('Branch Delivery fixture is incomplete')
    const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: repo, windowsHide: true })
    const changedKeys: string[][] = []
    const disposeChanged = harness.control.onChanged((keys) => { changedKeys.push([...keys]) })

    const saved = await harness.control.submit(harness.authentication, {
      type: 'save-branch-delivery',
      intentId: 'intent-22222020-2020-4220-8220-202020202020' as SakiControlIntentId,
      projectId: project.id,
      workItemId: item.id,
      expected: {
        deliveryRevision: null,
        registryRevision: registry.revision,
        projectRevision: project.revision,
        binding: { id: binding.id, revision: binding.revision },
        synchronizationRevision: board.synchronizationRevision,
        mappingRevision,
        workItemRemoteFingerprint: item.remoteFingerprint,
      },
      commitId: githubCommitId(stdout.trim()),
      headRef: 'refs/heads/saki/branch-delivery-control-route',
      baseRef: 'refs/heads/master',
    }, new AbortController().signal)
    expect(saved).toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
    if (!saved.ok) throw new Error('Branch Delivery save failed')
    expect(changedKeys).toContainEqual(['branch-delivery', 'milestone-view'])

    const deliveryId = branchDeliveryId(project.id, item.id)
    const existing = { deliveryId, expectedDeliveryRevision: 99 }
    const routed = [
      {
        type: 'push-branch-delivery' as const,
        intentId: 'intent-22232020-2020-4320-8320-202020202020' as SakiControlIntentId,
        ...existing,
      },
      {
        type: 'create-branch-delivery-pull-request' as const,
        intentId: 'intent-22242020-2020-4420-8420-202020202020' as SakiControlIntentId,
        ...existing,
        title: 'Route Pull Request creation',
        body: 'The Branch Delivery module owns the external effect.',
      },
      {
        type: 'associate-branch-delivery-pull-request' as const,
        intentId: 'intent-22252020-2020-4520-8520-202020202020' as SakiControlIntentId,
        ...existing,
        pullRequestId: githubPullRequestId('PR_branch_delivery_control_route'),
        pullRequestNumber: 32,
      },
      {
        type: 'mark-branch-delivery-in-review' as const,
        intentId: 'intent-22262020-2020-4620-8620-202020202020' as SakiControlIntentId,
        ...existing,
        expectedWorkItemRemoteFingerprint: item.remoteFingerprint,
      },
      {
        type: 'accept-branch-delivery' as const,
        intentId: 'intent-22272020-2020-4720-8720-202020202020' as SakiControlIntentId,
        ...existing,
        expectedWorkItemRemoteFingerprint: item.remoteFingerprint,
      },
    ]
    for (const request of routed) {
      expect(await harness.control.submit(
        harness.authentication,
        request,
        new AbortController().signal,
      )).toMatchObject({ ok: false, reason: 'conflict' })
    }
    expect(await harness.control.submit(harness.authentication, {
      type: 'push-branch-delivery',
      intentId: registered.receipt.intentId,
      deliveryId,
      expectedDeliveryRevision: 0,
    }, new AbortController().signal)).toEqual({ ok: false, reason: 'conflict' })

    const cached = await harness.control.query(harness.authentication, {
      type: 'branch-delivery',
      projectId: project.id,
      workItemId: item.id,
      refresh: 'cached',
    }, new AbortController().signal)
    expect(cached).toMatchObject({
      ok: true,
      projection: {
        type: 'branch-delivery',
        refresh: { requested: 'cached', state: 'cached' },
        branchDelivery: { delivery: { projectId: project.id, workItemId: item.id } },
      },
    })
    expect(JSON.stringify(cached)).not.toContain(configuration.credentialRef)
    expect(JSON.stringify(cached)).not.toContain('saki-projects-')

    expect(await harness.control.query(harness.authentication, {
      type: 'branch-delivery',
      projectId: project.id,
      workItemId: item.id,
      refresh: 'interactive',
    }, new AbortController().signal)).toMatchObject({
      ok: true,
      projection: {
        refresh: { requested: 'interactive', state: 'confirmed' },
        branchDelivery: { delivery: { revision: 1 } },
      },
    })
    await providerFiber.dispose()
    expect(await harness.control.query(harness.authentication, {
      type: 'branch-delivery',
      projectId: project.id,
      workItemId: item.id,
      refresh: 'interactive',
    }, new AbortController().signal)).toMatchObject({
      ok: true,
      projection: {
        refresh: { requested: 'interactive', state: 'unavailable' },
        branchDelivery: { delivery: { revision: 1 } },
      },
    })
    disposeChanged()
    await harness.close()
  })

  it('routes Milestone Delivery metadata, fresh View reads, and fail-closed finalization', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'milestone-delivery-control-route')
    const configuration = githubSynchronizationConfiguration()
    const ctx = await context(durable)
    let github!: FakeBoardGitHub
    const providerFiber = await ctx.plugin((providerContext: Context) => {
      github = new FakeBoardGitHub(providerContext, githubBoardCandidate(configuration))
    })
    const harness = await mountControlPlane(ctx)
    const registered = await harness.control.submit(harness.authentication, intent(
      'intent-23202020-2020-4020-8020-202020202020',
      'Milestone Delivery control route',
      repo,
      0,
      await inspected(harness, repo),
    ), new AbortController().signal)
    if (!registered.ok) throw new Error('registration failed')
    expect(await harness.control.submit(harness.authentication, {
      type: 'configure-github-synchronization',
      intentId: 'intent-23212020-2020-4120-8120-202020202020' as SakiControlIntentId,
      projectId: registered.receipt.projectId,
      expectedSynchronizationRevision: 0,
      patch: configuration,
    }, new AbortController().signal)).toMatchObject({ ok: true })
    await waitForConfirmedBoard(harness, registered.receipt.projectId)
    const registry = liveSakiDomain(harness.ctx).table('development_project_registry')
      .get('development-project-registry')
    const project = registry?.projects.find(candidate => candidate.id === registered.receipt.projectId)
    if (registry === undefined || project === undefined) throw new Error('Milestone Delivery fixture is incomplete')
    const milestoneId = githubMilestoneId('M_milestone_delivery_control_route')
    const release = {
      repositoryId: configuration.repositoryNodeId,
      projectId: configuration.projectNodeId,
      milestoneId,
      milestoneNumber: 1,
      tagName: githubReleaseTagName('saki-v0.1.0'),
      releaseCommitId: githubCommitId('a'.repeat(40)),
      upstreamRepositoryId: githubRepositoryId('R_saki_upstream'),
      upstreamRepositoryDatabaseId: githubRepositoryDatabaseId('87654322'),
      upstreamRepositoryNameWithOwner: 'deepseek-ai/deepseek-harness',
      upstreamCommitId: githubCommitId('b'.repeat(40)),
    }
    const changedKeys: string[][] = []
    const disposeChanged = harness.control.onChanged((keys) => { changedKeys.push([...keys]) })

    const saved = await harness.control.submit(harness.authentication, {
      type: 'save-milestone-delivery',
      intentId: 'intent-23222020-2020-4220-8220-202020202020' as SakiControlIntentId,
      projectId: project.id,
      expectedDeliveryRevision: null,
      expectedRegistryRevision: registry.revision,
      expectedProjectRevision: project.revision,
      phase: 'ready-to-release',
      release,
    }, new AbortController().signal)
    expect(saved).toMatchObject({ ok: true, receipt: { state: 'succeeded', deliveryRevision: 0 } })
    if (!saved.ok) throw new Error('Milestone Delivery save failed')
    expect(changedKeys).toContainEqual(['milestone-view'])

    const scansBeforeView = github.requests.length
    expect(await harness.control.query(harness.authentication, {
      type: 'milestone-view',
      projectId: project.id,
      milestoneId,
      refresh: 'cached',
    }, new AbortController().signal)).toMatchObject({
      ok: true,
      projection: {
        type: 'milestone-view',
        refresh: { requested: 'cached', state: 'cached' },
        milestoneView: {
          delivery: { phase: 'ready-to-release', revision: 0 },
          sources: { milestone: { current: { state: 'unobserved' } } },
        },
      },
    })
    expect(github.requests).toHaveLength(scansBeforeView)

    expect(await harness.control.query(harness.authentication, {
      type: 'milestone-view',
      projectId: project.id,
      milestoneId,
      refresh: 'interactive',
    }, new AbortController().signal)).toMatchObject({
      ok: true,
      projection: {
        refresh: { requested: 'interactive', state: 'confirmed' },
        milestoneView: { sources: { milestone: { current: { state: 'failure' } } } },
      },
    })
    expect(github.requests).toHaveLength(scansBeforeView)

    const finalizeIntent = {
      type: 'finalize-milestone-delivery',
      intentId: 'intent-23232020-2020-4320-8320-202020202020' as SakiControlIntentId,
      deliveryId: saved.receipt.deliveryId,
      expectedDeliveryRevision: 0,
      release,
    } as const
    expect(await harness.control.submit(
      harness.authentication,
      finalizeIntent,
      new AbortController().signal,
    )).toMatchObject({
      ok: false,
      reason: 'unavailable',
      receipt: { state: 'blocked' },
    })
    expect(github.requests.length).toBeGreaterThan(scansBeforeView)

    await providerFiber.dispose()
    expect(await harness.control.submit(
      harness.authentication,
      finalizeIntent,
      new AbortController().signal,
    )).toMatchObject({
      ok: false,
      reason: 'unavailable',
      receipt: { state: 'blocked' },
    })
    expect(await harness.control.query(harness.authentication, {
      type: 'milestone-view',
      projectId: project.id,
      milestoneId,
      refresh: 'interactive',
    }, new AbortController().signal)).toMatchObject({
      ok: true,
      projection: { refresh: { requested: 'interactive', state: 'unavailable' } },
    })

    const domain = liveSakiDomain(harness.ctx)
    const recordedAt = Date.now()
    await domain.table('milestone_deliveries').update(finalizeIntent.deliveryId, value => (
      milestoneDeliveryRecordSchema.parse({
        ...value,
        revision: value.revision + 1,
        repair: {
          intentId: finalizeIntent.intentId,
          priorRevision: finalizeIntent.expectedDeliveryRevision,
          reason: 'concurrent-github-change',
          blockages: [{ kind: 'final-reread-mismatch' }],
          recordedAt,
        },
        lastIntentId: finalizeIntent.intentId,
        updatedAt: Math.max(value.updatedAt, recordedAt),
      })
    ))
    await domain.table('milestone_delivery_intents').update(finalizeIntent.intentId, (value) => {
      const { blockages: _blockages, resultDeliveryRevision: _resultDeliveryRevision, ...pending } = value
      return milestoneDeliveryIntentRecordSchema.parse({
        ...pending,
        revision: value.revision + 1,
        phase: 'prepared',
        updatedAt: Math.max(value.updatedAt, recordedAt),
      })
    })
    disposeChanged()
    await harness.close()

    const restartedContext = await context(durable)
    const restarted = await mountControlPlane(restartedContext, {
      ...CONTROL_CONFIG,
      githubScanAttemptTtlMs: 1_000,
    })
    expect(liveSakiDomain(restarted.ctx).table('milestone_delivery_intents').get(finalizeIntent.intentId))
      .toMatchObject({
        phase: 'reconciliation-required',
        resultDeliveryRevision: 1,
        blockages: [{ kind: 'final-reread-mismatch' }],
      })

    let blockingProvider!: BlockingBoardGitHub
    const blockingFiber = await restarted.ctx.plugin((providerContext: Context) => {
      blockingProvider = new BlockingBoardGitHub(providerContext, githubBoardCandidate(configuration))
    })
    const replacementIntent = {
      ...finalizeIntent,
      intentId: 'intent-23242020-2020-4420-8420-202020202020' as SakiControlIntentId,
      expectedDeliveryRevision: 1,
    }
    const interrupted = restarted.control.submit(
      restarted.authentication,
      replacementIntent,
      new AbortController().signal,
    )
    await blockingProvider.started
    await blockingFiber.dispose()
    expect(blockingProvider.aborted).toBe(true)
    await expect(interrupted).resolves.toEqual({ ok: false, reason: 'unavailable' })
    expect(liveSakiDomain(restarted.ctx).table('milestone_delivery_intents').get(replacementIntent.intentId))
      .toMatchObject({ phase: 'prepared' })

    const replacementFiber = await restarted.ctx.plugin((providerContext: Context) => {
      new FakeBoardGitHub(providerContext, githubBoardCandidate(configuration))
    })
    await vi.waitFor(() => {
      expect(liveSakiDomain(restarted.ctx).table('milestone_delivery_intents').get(replacementIntent.intentId))
        .toMatchObject({ phase: 'blocked' })
    }, { timeout: 5_000 })
    await replacementFiber.dispose()
    await restarted.close()
  })

  it('wires Work Item mutation, projection, and retained-startup callbacks through the durable control plane', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'work-item-control-route')
    const configuration = githubSynchronizationConfiguration()
    const ctx = await context(durable)
    let github: FakeBoardGitHub | undefined
    const providerFiber = await ctx.plugin((providerContext: Context) => {
      github = new FakeBoardGitHub(
        providerContext,
        githubBoardCandidate(configuration, configuration.statusOptionNodeIds.done),
      )
    })
    const harness = await mountControlPlane(ctx)
    const registrationIntentId = 'intent-30303030-3030-4030-8030-303030303030' as SakiControlIntentId
    const registered = await harness.control.submit(harness.authentication, intent(
      registrationIntentId,
      'Work Item control route',
      repo,
      0,
      await inspected(harness, repo),
    ), new AbortController().signal)
    if (!registered.ok) throw new Error('registration failed')
    const configurationIntentId = 'intent-31313131-3131-4131-8131-313131313131' as SakiControlIntentId
    expect(await harness.control.submit(harness.authentication, {
      type: 'configure-github-synchronization',
      intentId: configurationIntentId,
      projectId: registered.receipt.projectId,
      expectedSynchronizationRevision: 0,
      patch: configuration,
    }, new AbortController().signal)).toMatchObject({ ok: true, receipt: { state: 'saved' } })

    const firstBoard = await waitForConfirmedBoard(harness, registered.receipt.projectId)
    expect(firstBoard.confirmed?.items[0]).toMatchObject({ status: 'done', latestNonTerminalStatus: null })
    if (github === undefined) throw new Error('GitHub Provider fixture did not start')
    github.setStatusOption(configuration.statusOptionNodeIds.ready)
    expect(await harness.control.query(harness.authentication, {
      type: 'board',
      projectId: registered.receipt.projectId,
      refresh: 'interactive',
    }, new AbortController().signal)).toMatchObject({ ok: true })
    const board = await waitForConfirmedBoard(harness, registered.receipt.projectId, 2)
    const item = board.confirmed?.items[0]
    if (item === undefined || board.mapping.state !== 'valid') throw new Error('confirmed Work Item fixture is missing')
    const changedKeys: string[][] = []
    const disposeChanged = harness.control.onChanged((keys) => { changedKeys.push([...keys]) })
    await setGrantActions(harness, ['board:read', 'work-item:move'])
    const expected = {
      projectRevision: 0,
      synchronizationRevision: board.synchronizationRevision,
      mappingRevision: board.mapping.configurationRevision,
    }
    const deniedCreateId = 'intent-32323232-3232-4232-8232-323232323232' as SakiControlIntentId
    expect(await harness.control.submit(harness.authentication, {
      type: 'create-work-item',
      intentId: deniedCreateId,
      projectId: registered.receipt.projectId,
      expected,
      title: 'Denied Work Item',
      intendedOutcome: 'The denied request leaves no durable mutation.',
      acceptanceCriteria: ['No GitHub write is attempted.'],
    }, new AbortController().signal)).toEqual({ ok: false, reason: 'denied' })
    expect(liveSakiDomain(harness.ctx).table('github_work_item_intents').get(deniedCreateId)).toBeUndefined()

    const move = {
      type: 'move-work-item' as const,
      projectId: registered.receipt.projectId,
      workItemId: item.id,
      expectedRemoteFingerprint: item.remoteFingerprint,
      targetStatus: 'in-progress' as const,
    }
    expect(await harness.control.submit(harness.authentication, {
      ...move,
      intentId: registrationIntentId,
    }, new AbortController().signal)).toEqual({ ok: false, reason: 'conflict' })
    const moveIntentId = 'intent-33333333-3333-4333-8333-333333333333' as SakiControlIntentId
    expect(await harness.control.submit(harness.authentication, {
      ...move,
      intentId: moveIntentId,
    }, new AbortController().signal)).toMatchObject({
      ok: true,
      receipt: { state: 'succeeded', type: 'move-work-item', workItemId: item.id },
    })

    const movedBoard = await waitForConfirmedBoard(harness, registered.receipt.projectId, 3)
    const movedItem = movedBoard.confirmed?.items.find(candidate => candidate.id === item.id)
    const movedGeneration = movedBoard.confirmed?.generation
    if (movedItem === undefined || movedGeneration === undefined) throw new Error('moved Work Item fixture is missing')
    expect(movedItem.status).toBe('in-progress')
    expect(changedKeys).toContainEqual(['project-settings', 'board'])

    github.setStatusOption(configuration.statusOptionNodeIds.done)
    expect(await harness.control.query<'board'>(harness.authentication, {
      type: 'board',
      projectId: registered.receipt.projectId,
      refresh: 'interactive',
    }, new AbortController().signal)).toMatchObject({ ok: true })
    const terminalBoard = await waitForConfirmedBoard(harness, registered.receipt.projectId, movedGeneration + 1)
    const terminalItem = terminalBoard.confirmed?.items[0]
    expect(terminalItem).toMatchObject({ status: 'done', latestNonTerminalStatus: 'in-progress' })
    if (terminalItem === undefined) throw new Error('terminal Work Item fixture is missing')

    await providerFiber.dispose()
    const pendingIntentId = 'intent-34343434-3434-4434-8434-343434343434' as SakiControlIntentId
    expect(await harness.control.submit(harness.authentication, {
      ...move,
      intentId: pendingIntentId,
      expectedRemoteFingerprint: terminalItem.remoteFingerprint,
      targetStatus: 'in-progress',
    }, new AbortController().signal)).toMatchObject({
      ok: false,
      reason: 'unavailable',
      receipt: { state: 'prepared', type: 'move-work-item' },
    })
    disposeChanged()
    await harness.close()

    const restarted = await context(durable)
    const diagnostic = vi.spyOn(restarted.logger, 'error').mockImplementation(() => restarted.logger)
    await restarted.plugin((providerContext: Context) => {
      const provider = new FakeBoardGitHub(
        providerContext,
        githubBoardCandidate(configuration, configuration.statusOptionNodeIds.done),
      )
      provider.nextMutationFailure = new Error('injected retained Work Item recovery failure')
    })
    const restartedHarness = await mountControlPlane(restarted)
    for (let attempt = 0; attempt < 200 && diagnostic.mock.calls.length === 0; attempt++) {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    expect(diagnostic).toHaveBeenCalledWith(
      'Saki GitHub Work Item recovery failed: Error: injected retained Work Item recovery failure',
    )
    await restartedHarness.close()

    await editSaki(durable, async (domain) => {
      const registryTable = domain.table('development_project_registry')
      const registry = registryTable.get('development-project-registry')
      if (registry === undefined) throw new Error('Development Project Registry fixture is missing')
      await registryTable.put('development-project-registry', {
        ...registry,
        revision: registry.revision + 1,
        projects: [],
        agentProfiles: [],
        resourceBindings: [],
        canonicalWorktreeIndex: [],
        gitDirectoryIndex: [],
        intentMappings: [],
      })
      for (const tableName of ['registration_intents', 'github_sync_configuration_intents', 'github_project_sync'] as const) {
        const table = domain.table(tableName)
        for (const key of [...table.keys()]) await table.delete(key)
      }
    })
    const orphaned = await context(durable)
    try {
      await expect(orphaned.plugin(SakiControlPlane, CONTROL_CONFIG))
        .rejects.toThrow('GitHub Work Item Intent targets a missing Development Project')
    } finally {
      await orphaned.fiber.dispose()
    }
  })

  it.each([
    ['successful move and stale Actor restart rejection', 'success'],
    ['derived Intent collision', 'move-conflict'],
  ] as const)('routes the assembled Agent work lifecycle: %s', async (_case, mode) => {
    const durable = await paths()
    const repo = await repository(durable.root, `agent-control-route-${mode}`)
    const configuration = githubSynchronizationConfiguration()
    const ctx = await context(durable)
    const host = installAgentRunHostFixture(ctx.sakiHostExecution)
    const installGitHubProvider = async () => await ctx.plugin((providerContext: Context) => {
      const provider = new FakeBoardGitHub(
        providerContext,
        githubBoardCandidate(configuration, configuration.statusOptionNodeIds.ready),
      )
      provider.agentIssueBody = [
        '# Intended outcome',
        'Exercise the assembled Agent dispatch route.',
        '# Acceptance criteria',
        '- The Host starts the exact frozen Run.',
      ].join('\n')
    })
    const providerFiber = await installGitHubProvider()
    const harness = await mountControlPlane(ctx, AGENT_CONTROL_CONFIG)
    const registrationIntentId = 'intent-40404040-4040-4040-8040-404040404040' as SakiControlIntentId
    const registered = await harness.control.submit(harness.authentication, intent(
      registrationIntentId,
      'Agent control route',
      repo,
      0,
      await inspected(harness, repo),
    ), new AbortController().signal)
    if (!registered.ok) throw new Error('registration failed')
    if (mode === 'success') {
      expect(await harness.control.query<'my-work'>(harness.authentication, {
        type: 'my-work',
      }, new AbortController().signal)).toMatchObject({ ok: true, projection: { items: [] } })
    }
    expect(await harness.control.submit(harness.authentication, {
      type: 'configure-github-synchronization',
      intentId: 'intent-41414141-4141-4141-8141-414141414141' as SakiControlIntentId,
      projectId: registered.receipt.projectId,
      expectedSynchronizationRevision: 0,
      patch: configuration,
    }, new AbortController().signal)).toMatchObject({ ok: true })
    const board = await waitForConfirmedBoard(harness, registered.receipt.projectId)
    const item = board.confirmed?.items[0]
    if (item === undefined) throw new Error('Agent Work Item fixture is missing')
    const agentIntent = {
      type: 'give-work-item-to-agent' as const,
      intentId: 'intent-42424242-4242-4242-8242-424242424242' as SakiControlIntentId,
      projectId: registered.receipt.projectId,
      workItemId: item.id,
      expectedProjectRevision: 0,
      expectedRemoteFingerprint: item.remoteFingerprint,
    }

    if (mode === 'success') {
      await setGrantActions(harness, ['work-item:move'])
      expect(await harness.control.query(harness.authentication, {
        type: 'my-work',
      }, new AbortController().signal)).toEqual({ ok: false, reason: 'denied' })
      expect(await harness.control.query(harness.authentication, {
        type: 'attention',
      }, new AbortController().signal)).toEqual({ ok: false, reason: 'denied' })
      await setGrantActions(harness, ['my-work:read', 'attention:read', 'work-item:move'])
      expect(await harness.control.query<'my-work'>(harness.authentication, {
        type: 'my-work',
      }, new AbortController().signal)).toMatchObject({
        ok: true,
        projection: {
          items: [{ recommendation: { available: false, reason: 'action-denied' } }],
        },
      })
      expect(await harness.control.query<'attention'>(harness.authentication, {
        type: 'attention',
      }, new AbortController().signal)).toMatchObject({ ok: true, projection: { items: [] } })
      expect(await harness.control.submit(harness.authentication, {
        ...agentIntent,
        intentId: 'intent-43434343-4343-4343-8343-434343434343' as SakiControlIntentId,
      }, new AbortController().signal)).toEqual({ ok: false, reason: 'denied' })
      expect(await harness.control.submit(harness.authentication, {
        type: 'answer-intervention',
        intentId: 'intent-44434343-4343-4343-8343-434343434343' as SakiControlIntentId,
        interventionId: 'intervention-44434343-4343-4343-8343-434343434343' as SakiInterventionRequestId,
        expectedInterventionRevision: 0,
        answer: { kind: 'text', text: 'Denied before the Intervention is inspected.' },
      }, new AbortController().signal)).toEqual({ ok: false, reason: 'denied' })
    }
    await setGrantActions(harness, [
      'board:read',
      'my-work:read',
      'attention:read',
      'work-item:give-to-agent',
      'intervention:answer',
      'work-item:move',
      ...(mode === 'move-conflict' ? ['github-synchronization:configure' as const] : []),
    ])
    if (mode === 'success') {
      const recommendation = async () => {
        const result = await harness.control.query<'my-work'>(harness.authentication, {
          type: 'my-work',
        }, new AbortController().signal)
        if (!result.ok) throw new Error('My Work availability fixture is unavailable')
        return result.projection.items[0]?.recommendation
      }
      const domain = liveSakiDomain(harness.ctx)
      const registration = domain.table('registration_intents').get(registrationIntentId)
      if (registration === undefined) throw new Error('registration fixture is absent')
      await providerFiber.dispose()
      const synchronization = githubSynchronization(harness)
      const revisedConfiguration = { ...configuration, activePollIntervalMs: 45_000 }
      expect(await synchronization.configure({
        type: 'configure-github-synchronization',
        intentId: 'intent-44444444-4444-4444-8444-444444444444' as SakiControlIntentId,
        projectId: registered.receipt.projectId,
        expectedSynchronizationRevision: 1,
        patch: { activePollIntervalMs: revisedConfiguration.activePollIntervalMs },
      }, registration.payload.actor, new AbortController().signal)).toMatchObject({ ok: true })
      expect(await recommendation()).toEqual({ available: false, reason: 'synchronization-unavailable' })
      const begun = await synchronization.beginScan(
        registered.receipt.projectId,
        'interactive',
        Date.now() + 60_000,
        new AbortController().signal,
      )
      if (!begun.ok) throw new Error(`revised scan did not begin: ${begun.reason}`)
      expect(await synchronization.publishScan(
        registered.receipt.projectId,
        begun.lease.attemptId,
        githubBoardCandidate(revisedConfiguration),
        new AbortController().signal,
      )).toMatchObject({ state: 'published', configurationRevision: 2 })
      await installGitHubProvider()

      const registryTable = domain.table('development_project_registry')
      const originalRegistry = registryTable.get('development-project-registry')
      if (originalRegistry === undefined) throw new Error('Project Registry fixture is absent')
      await registryTable.update('development-project-registry', (current) => {
        const candidate = structuredClone(current)
        const profile = candidate.agentProfiles.find(value => value.id === candidate.projects[0]?.defaultAgentProfileId)
        if (profile === undefined) throw new Error('Agent Profile fixture is absent')
        profile.modelRouteRequest = null
        return candidate
      })
      expect(await recommendation()).toEqual({ available: false, reason: 'operation-conditions-unavailable' })
      await registryTable.put('development-project-registry', originalRegistry)

      await registryTable.update('development-project-registry', (current) => {
        const candidate = structuredClone(current)
        const binding = candidate.resourceBindings[0]
        if (binding === undefined) throw new Error('Resource Binding fixture is absent')
        binding.health = 'missing'
        delete binding.currentInspection
        return candidate
      })
      expect(await recommendation()).toEqual({ available: false, reason: 'binding-unavailable' })
      await registryTable.put('development-project-registry', originalRegistry)

      const bindingId = originalRegistry.resourceBindings[0]?.id
      if (bindingId === undefined) throw new Error('Resource Binding fixture is absent')
      const admissions = domain.table('binding_write_admissions')
      const admission = admissions.get(bindingId)
      if (admission === undefined) throw new Error('Binding admission fixture is absent')
      await admissions.delete(bindingId)
      expect(await recommendation()).toEqual({ available: false, reason: 'binding-unavailable' })
      await admissions.put(bindingId, admission)
    }
    expect(await harness.control.query<'my-work'>(harness.authentication, {
      type: 'my-work',
    }, new AbortController().signal)).toMatchObject({
      ok: true,
      projection: {
        items: [{
          recommendation: {
            available: true,
            offer: {
              type: 'give-work-item-to-agent',
              expectedProjectRevision: 0,
              expectedRemoteFingerprint: item.remoteFingerprint,
            },
          },
        }],
      },
    })
    if (mode === 'success') {
      expect(await harness.control.submit(harness.authentication, agentIntent, new AbortController().signal)).toEqual({
        ok: false,
        reason: 'unavailable',
        detail: 'model-route-unavailable',
      })
    }
    await ctx.plugin(LlmRuntime)
    const resolveModelInfo = vi.spyOn(ctx.llm, 'resolveModelInfo').mockResolvedValue({
      provider: 'test-provider',
      id: 'test-model',
      name: 'Test model',
    })
    if (mode === 'success') {
      expect(await harness.control.submit(harness.authentication, {
        ...agentIntent,
        intentId: registrationIntentId,
      }, new AbortController().signal)).toEqual({ ok: false, reason: 'conflict' })
    }
    if (mode === 'move-conflict') {
      host.beforeSuccess = async () => {
        const record = liveSakiDomain(harness.ctx).table('agent_operation_intents').get(agentIntent.intentId)
        if (record === undefined) throw new Error('Agent operation was not retained before Host success')
        expect(await harness.control.submit(harness.authentication, {
          type: 'configure-github-synchronization',
          intentId: record.inProgressIntentId,
          projectId: registered.receipt.projectId,
          expectedSynchronizationRevision: board.synchronizationRevision,
          patch: configuration,
        }, new AbortController().signal)).toMatchObject({ ok: false, reason: 'conflict' })
      }
    }
    const changedKeys: string[][] = []
    const disposeChanged = harness.control.onChanged((keys) => { changedKeys.push([...keys]) })
    const submission = harness.control.submit(harness.authentication, agentIntent, new AbortController().signal)
    if (mode === 'success') {
      await expect(submission).resolves.toMatchObject({ ok: true, receipt: { state: 'started' } })
      expect(await harness.control.query<'board'>(harness.authentication, {
        type: 'board',
        projectId: registered.receipt.projectId,
        refresh: 'interactive',
      }, new AbortController().signal)).toMatchObject({ ok: true })
      const moved = await waitForConfirmedBoard(
        harness,
        registered.receipt.projectId,
        (board.confirmed?.generation ?? 0) + 1,
      )
      expect(moved.confirmed?.items[0]?.status).toBe('in-progress')
    } else {
      await expect(submission).resolves.toMatchObject({
        ok: false,
        reason: 'reconciliation-required',
        receipt: { state: 'reconciliation-required', reason: 'protocol' },
      })
    }
    expect(resolveModelInfo).toHaveBeenCalledWith('test-provider', 'test-model', expect.any(AbortSignal))
    expect(host.requests).toHaveLength(2)
    expect(host.requests[1]).toEqual(host.requests[0])
    expect(host.startCount).toBe(1)
    expect(changedKeys).toContainEqual(['my-work', 'attention', 'project-changes', 'board'])
    disposeChanged()

    if (mode === 'success') {
      expect(await harness.control.query<'my-work'>(harness.authentication, {
        type: 'my-work',
      }, new AbortController().signal)).toMatchObject({
        ok: true,
        projection: {
          items: [{ recommendation: { available: false, reason: 'active-work' } }],
        },
      })
      vi.spyOn(harness.ctx.sakiHostExecution, 'inspectInterventionOpening')
        .mockResolvedValue({ kind: 'confirmed', turn: 1, step: 1 })
      const sessionId = host.requests[0]?.run.sessionId
      if (sessionId === undefined) throw new Error('Agent Run Session fixture is absent')
      const openIntervention = async (toolCallId: string) => {
        const requested = await harness.control.agentInterventions.request({
          sessionId,
          toolCallId: CallId(toolCallId),
          prompt: 'Which exact path should this assembled Agent Run take?',
        }, new AbortController().signal)
        if (!requested.ok) throw new Error('assembled Intervention was not created')
        expect(await harness.control.agentInterventions.finalizeOpening(
          requested.interventionId,
          new AbortController().signal,
        )).toBe('open')
        const work = await harness.control.query<'my-work'>(harness.authentication, {
          type: 'my-work',
        }, new AbortController().signal)
        if (!work.ok) throw new Error('assembled Intervention is absent from My Work')
        const intervention = work.projection.items[0]?.intervention
        if (intervention?.id !== requested.interventionId || intervention.state !== 'open') {
          throw new Error('assembled Intervention did not open')
        }
        return intervention
      }
      const answerIntervention = async (
        intervention: Awaited<ReturnType<typeof openIntervention>>,
        answer: AnswerInterventionIntent,
      ) => {
        const priorDispatchIds = new Set(host.requests.map(request => request.source.dispatchId))
        const hostStartCount = host.startCount
        host.beginNextOperation()
        expect(await harness.control.submit(
          harness.authentication,
          answer,
          new AbortController().signal,
        )).toMatchObject({ ok: true, receipt: { state: 'resolved' } })

        const resolved = liveSakiDomain(harness.ctx).table('intervention_requests').get(intervention.id)
        if (resolved === undefined || !('answer' in resolved) || resolved.answer === undefined) {
          throw new Error('assembled Intervention answer is absent')
        }
        const newRequests = host.requests.filter(request => !priorDispatchIds.has(request.source.dispatchId))
        const newDispatchIds = new Set(newRequests.map(request => request.source.dispatchId))
        expect(host.startCount).toBe(hostStartCount + 1)
        expect(newDispatchIds).toEqual(new Set([resolved.answer.dispatchId]))
        const resumed = newRequests[0]
        if (resumed === undefined) throw new Error('Intervention answer Host request is absent')
        for (const request of newRequests) expect(request).toEqual(resumed)
        expect(resumed.run.agentRunId).toBe(intervention.returnAddress.agentRunId)
        expect(resumed.run.workSessionId).toBe(intervention.returnAddress.workSessionId)
        expect(resumed.run.sessionId).toBe(sessionId)
        expect(resumed.source).toEqual({
          kind: 'execution-dispatch',
          dispatchId: resolved.answer.dispatchId,
          payloadDigest: resolved.answer.inputPlan.payloadDigest,
        })
        expect(resumed.run.input).toEqual({
          id: resolved.answer.inputPlan.messageId,
          role: 'user',
          content: [{
            type: 'text',
            text: `Operator response to your intervention request:\n\n${answer.answer.text}`,
          }],
          source: {
            kind: 'saki-intervention-answer',
            interventionId: intervention.id,
            answerIntentId: answer.intentId,
            dispatchId: resolved.answer.dispatchId,
            agentRunId: intervention.returnAddress.agentRunId,
            workSessionId: intervention.returnAddress.workSessionId,
            actor: resolved.answer.payload.actor,
          },
        })
      }

      const firstIntervention = await openIntervention('call_service_intervention_first')
      const firstAnswer = {
        type: 'answer-intervention' as const,
        intentId: 'intent-45454545-4545-4545-8545-454545454545' as SakiControlIntentId,
        interventionId: firstIntervention.id,
        expectedInterventionRevision: firstIntervention.revision,
        answer: { kind: 'text' as const, text: 'Use the exact assembled path.' },
      }
      await answerIntervention(firstIntervention, firstAnswer)
      expect(await harness.control.submit(harness.authentication, {
        ...agentIntent,
        intentId: firstAnswer.intentId,
      }, new AbortController().signal)).toEqual({ ok: false, reason: 'conflict' })
      expect(await harness.control.submit(harness.authentication, {
        ...firstAnswer,
        interventionId: 'intervention-48484848-4848-4848-8848-484848484848' as SakiInterventionRequestId,
      }, new AbortController().signal)).toEqual({ ok: false, reason: 'conflict' })
      expect(await harness.control.submit(harness.authentication, {
        ...agentIntent,
        intentId: 'intent-46464646-4646-4646-8646-464646464646' as SakiControlIntentId,
      }, new AbortController().signal)).toMatchObject({ ok: false, reason: 'conflict' })

      const opening = await harness.control.agentInterventions.request({
        sessionId,
        toolCallId: CallId('call_service_intervention_opening'),
        prompt: 'Leave this exact Intervention opening for recovery.',
      }, new AbortController().signal)
      if (!opening.ok) throw new Error('recovery Intervention was not created')
      const openingRecord = liveSakiDomain(harness.ctx).table('intervention_requests').get(opening.interventionId)
      if (openingRecord === undefined) throw new Error('recovery Intervention record is absent')
      expect(await harness.control.submit(harness.authentication, {
        ...agentIntent,
        intentId: 'intent-49494949-4949-4949-8949-494949494949' as SakiControlIntentId,
      }, new AbortController().signal)).toMatchObject({ ok: false, reason: 'conflict' })
      expect(await harness.control.query<'my-work'>(harness.authentication, {
        type: 'my-work',
      }, new AbortController().signal)).toMatchObject({
        ok: true,
        projection: { items: [{ assignment: {}, run: {} }] },
      })

      await harness.close()
      const recoveredContext = await context(durable)
      vi.spyOn(recoveredContext.sakiHostExecution, 'resumeAgentRun').mockResolvedValue()
      vi.spyOn(recoveredContext.sakiHostExecution, 'inspectInterventionOpening')
        .mockResolvedValue({ kind: 'absent' })
      const recovered = await mountControlPlane(recoveredContext, AGENT_CONTROL_CONFIG)
      const recoveredDomain = liveSakiDomain(recovered.ctx)
      expect(recoveredDomain.table('intervention_requests').get(opening.interventionId)).toMatchObject({
        id: opening.interventionId,
        revision: 1,
        state: 'reconciliation-required',
        reason: 'protocol',
      })
      const recoveredRun = recoveredDomain.table('agent_runs').get(openingRecord.owner.agentRunId)
      expect(recoveredRun).toMatchObject({
        id: openingRecord.owner.agentRunId,
        state: 'running',
      })
      expect(recoveredRun).not.toHaveProperty('blockingInterventionId')
      await recovered.close()
      await editSaki(durable, async (domain) => {
        const table = domain.table('agent_operation_intents')
        await table.update(agentIntent.intentId, (current) => {
          const payload = {
            ...current.payload,
            actor: { ...current.payload.actor, grantRevision: current.payload.actor.grantRevision + 1 },
          }
          return {
            ...current,
            payload,
            payloadDigest: canonicalDigest('saki/agent-operation-intent/v1', payload),
          }
        })
      })
      const restarted = await context(durable)
      try {
        await expect(restarted.plugin(SakiControlPlane, AGENT_CONTROL_CONFIG))
          .rejects.toThrow('Saki registration Intent actor reference is inconsistent')
      } finally {
        await restarted.fiber.dispose()
      }
    }
  })

  it('atomically publishes one confirmed Board checkpoint and activates its saved configuration', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'github-board-publish')
    const harness = await start(durable)
    const registered = await harness.control.submit(harness.authentication, intent(
      'intent-21212121-2121-4121-8121-212121212121',
      'GitHub Board publication',
      repo,
      0,
      await inspected(harness, repo),
    ), new AbortController().signal)
    if (!registered.ok) throw new Error('registration failed')
    const configuration = githubSynchronizationConfiguration()
    const saved = await harness.control.submit(harness.authentication, {
      type: 'configure-github-synchronization',
      intentId: 'intent-22222222-2222-4222-8222-222222222222' as SakiControlIntentId,
      projectId: registered.receipt.projectId,
      expectedSynchronizationRevision: 0,
      patch: configuration,
    }, new AbortController().signal)
    expect(saved).toMatchObject({ ok: true, receipt: { state: 'saved' } })

    const synchronization = githubSynchronization(harness)
    const begun = await synchronization.beginScan(
      registered.receipt.projectId,
      'interactive',
      Date.now() + 60_000,
      new AbortController().signal,
    )
    if (!begun.ok) throw new Error(`scan did not begin: ${begun.reason}`)
    expect(await harness.control.query(harness.authentication, {
      type: 'project-settings',
      projectId: registered.receipt.projectId,
    }, new AbortController().signal)).toMatchObject({
      ok: true,
      projection: { synchronization: { revision: 1, state: 'activating', scan: { state: 'in-flight' } } },
    })

    expect(await synchronization.publishScan(
      registered.receipt.projectId,
      begun.lease.attemptId,
      githubBoardCandidate(configuration),
      new AbortController().signal,
    )).toEqual({ state: 'published', generation: 1, configurationRevision: 1 })
    expect(await harness.control.query(harness.authentication, {
      type: 'board',
      projectId: registered.receipt.projectId,
      refresh: 'cached',
    }, new AbortController().signal)).toMatchObject({
      ok: true,
      projection: {
        state: 'confirmed',
        synchronizationRevision: 1,
        confirmed: {
          generation: 1,
          configurationRevision: 1,
          items: [{ issueNumber: 27, status: 'ready', order: 0, notInProject: false }],
        },
        checkpoint: { generation: 1, configurationRevision: 1 },
        mapping: { state: 'valid', configurationRevision: 1 },
        effectiveMutationAvailability: { available: false, reasons: ['provider-unavailable'] },
        mutationOverlays: [],
      },
    })
    await harness.close()
  })

  it('retains the prior confirmed Board when one joined Issue has no mapped Status', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'github-board-mapping-failure')
    const harness = await start(durable)
    const registered = await harness.control.submit(harness.authentication, intent(
      'intent-23232323-2323-4323-8323-232323232323',
      'GitHub Board mapping failure',
      repo,
      0,
      await inspected(harness, repo),
    ), new AbortController().signal)
    if (!registered.ok) throw new Error('registration failed')
    const configuration = githubSynchronizationConfiguration()
    await harness.control.submit(harness.authentication, {
      type: 'configure-github-synchronization',
      intentId: 'intent-24242424-2424-4424-8424-242424242424' as SakiControlIntentId,
      projectId: registered.receipt.projectId,
      expectedSynchronizationRevision: 0,
      patch: configuration,
    }, new AbortController().signal)
    const synchronization = githubSynchronization(harness)
    const first = await synchronization.beginScan(
      registered.receipt.projectId,
      'interactive',
      Date.now() + 60_000,
      new AbortController().signal,
    )
    if (!first.ok) throw new Error('first scan did not begin')
    expect(await synchronization.publishScan(
      registered.receipt.projectId,
      first.lease.attemptId,
      githubBoardCandidate(configuration),
      new AbortController().signal,
    )).toMatchObject({ state: 'published', generation: 1 })
    const before = await harness.control.query<'board'>(harness.authentication, {
      type: 'board',
      projectId: registered.receipt.projectId,
      refresh: 'cached',
    }, new AbortController().signal)
    if (!before.ok) throw new Error('confirmed Board is unavailable')

    await harness.control.submit(harness.authentication, {
      type: 'configure-github-synchronization',
      intentId: 'intent-25252525-2525-4525-8525-252525252525' as SakiControlIntentId,
      projectId: registered.receipt.projectId,
      expectedSynchronizationRevision: 1,
      patch: { activePollIntervalMs: 45_000 },
    }, new AbortController().signal)
    const second = await synchronization.beginScan(
      registered.receipt.projectId,
      'interactive',
      Date.now() + 60_000,
      new AbortController().signal,
    )
    if (!second.ok) throw new Error('second scan did not begin')
    const complete = githubBoardCandidate({ ...configuration, activePollIntervalMs: 45_000 })
    const joined = complete.items[0]
    if (joined === undefined) throw new Error('joined Issue fixture is absent')
    const { statusOptionId: _statusOptionId, ...missingStatus } = joined
    const mappingFailure = refingerprintCandidate(complete, { items: [missingStatus] })
    expect(await synchronization.publishScan(
      registered.receipt.projectId,
      second.lease.attemptId,
      mappingFailure,
      new AbortController().signal,
    )).toEqual({
      state: 'activation-failed',
      issues: [{ reason: 'work-item-status-missing', issueId: 'I_saki_test_issue' }],
    })
    expect(await synchronization.publishScan(
      registered.receipt.projectId,
      second.lease.attemptId,
      complete,
      new AbortController().signal,
    )).toEqual({ state: 'stale' })
    const after = await harness.control.query<'board'>(harness.authentication, {
      type: 'board',
      projectId: registered.receipt.projectId,
      refresh: 'cached',
    }, new AbortController().signal)
    if (!after.ok) throw new Error('retained Board is unavailable')
    expect(after.projection.synchronizationRevision).toBe(2)
    expect(after.projection.confirmed).toEqual(before.projection.confirmed)
    expect(after.projection.checkpoint).toEqual(before.projection.checkpoint)
    expect(after.projection.mapping).toEqual({
      state: 'repair-required',
      configurationRevision: 2,
      issues: [{ reason: 'work-item-status-missing', issueId: 'I_saki_test_issue' }],
    })
    expect(after.projection.failure).toMatchObject({
      configurationRevision: 2,
      failure: { kind: 'mapping' },
    })
    expect(after.projection.effectiveMutationAvailability).toEqual({
      available: false,
      reasons: ['configuration-not-activated', 'mapping-repair-required', 'provider-unavailable'],
    })
    expect(await harness.control.query(harness.authentication, {
      type: 'project-settings',
      projectId: registered.receipt.projectId,
    }, new AbortController().signal)).toMatchObject({
      ok: true,
      projection: {
        synchronization: {
          revision: 2,
          state: 'activation-failed',
          active: { revision: 1 },
          pending: { revision: 2, state: 'activation-failed' },
          checkpoint: { generation: 1, configurationRevision: 1 },
        },
      },
    })
    await harness.close()
  })

  it('replays exact synchronization saves, rejects changed replay, and applies later patches by CAS', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'github-sync-replay')
    const harness = await start(durable)
    const selection = await inspected(harness, repo)
    const registered = await harness.control.submit(harness.authentication, intent(
      'intent-14141414-1414-4414-8414-141414141414',
      'GitHub synchronization replay',
      repo,
      0,
      selection,
    ), new AbortController().signal)
    if (!registered.ok) throw new Error('registration failed')
    const first: ConfigureGitHubSynchronizationIntent = {
      type: 'configure-github-synchronization',
      intentId: 'intent-15151515-1515-4515-8515-151515151515' as SakiControlIntentId,
      projectId: registered.receipt.projectId,
      expectedSynchronizationRevision: 0,
      patch: githubSynchronizationConfiguration(),
    }
    const saved = await harness.control.submit(harness.authentication, first, new AbortController().signal)
    expect(await harness.control.submit(harness.authentication, first, new AbortController().signal)).toEqual(saved)
    expect(await harness.control.submit(harness.authentication, {
      ...first,
      patch: { ...first.patch, activePollIntervalMs: 45_000 },
    }, new AbortController().signal)).toEqual({ ok: false, reason: 'conflict' })

    const stale: ConfigureGitHubSynchronizationIntent = {
      type: 'configure-github-synchronization',
      intentId: 'intent-16161616-1616-4616-8616-161616161616' as SakiControlIntentId,
      projectId: registered.receipt.projectId,
      expectedSynchronizationRevision: 0,
      patch: { activePollIntervalMs: 45_000 },
    }
    expect(await harness.control.submit(harness.authentication, stale, new AbortController().signal)).toMatchObject({
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'expected-revision' },
    })

    const next: ConfigureGitHubSynchronizationIntent = {
      ...stale,
      intentId: 'intent-17171717-1717-4717-8717-171717171717' as SakiControlIntentId,
      expectedSynchronizationRevision: 1,
    }
    expect(await harness.control.submit(harness.authentication, next, new AbortController().signal)).toMatchObject({
      ok: true,
      receipt: { state: 'saved', synchronizationRevision: 2, candidateRevision: 2 },
    })
    expect(await harness.control.query(harness.authentication, {
      type: 'project-settings',
      projectId: registered.receipt.projectId,
    }, new AbortController().signal)).toMatchObject({
      ok: true,
      projection: {
        synchronization: {
          revision: 2,
          state: 'saved',
          pending: {
            revision: 2,
            changedFields: Object.keys(first.patch),
            configuration: {
              appId: first.patch.appId,
              activePollIntervalMs: 45_000,
            },
          },
        },
      },
    })
    await harness.close()
  })

  it('reopens superseded saved synchronization Intents and preserves their replay receipts', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'github-sync-restart')
    let harness = await start(durable)
    const selection = await inspected(harness, repo)
    const registered = await harness.control.submit(harness.authentication, intent(
      'intent-18181818-1818-4818-8818-181818181818',
      'GitHub synchronization restart',
      repo,
      0,
      selection,
    ), new AbortController().signal)
    if (!registered.ok) throw new Error('registration failed')
    const first: ConfigureGitHubSynchronizationIntent = {
      type: 'configure-github-synchronization',
      intentId: 'intent-19191919-1919-4919-8919-191919191919' as SakiControlIntentId,
      projectId: registered.receipt.projectId,
      expectedSynchronizationRevision: 0,
      patch: githubSynchronizationConfiguration(),
    }
    const second: ConfigureGitHubSynchronizationIntent = {
      type: 'configure-github-synchronization',
      intentId: 'intent-20202020-2020-4020-8020-202020202020' as SakiControlIntentId,
      projectId: registered.receipt.projectId,
      expectedSynchronizationRevision: 1,
      patch: { rateLimitReserve: 750 },
    }
    const firstSaved = await harness.control.submit(harness.authentication, first, new AbortController().signal)
    const secondSaved = await harness.control.submit(harness.authentication, second, new AbortController().signal)
    await harness.close()

    harness = await start(durable)
    expect(await harness.control.submit(harness.authentication, first, new AbortController().signal)).toEqual(firstSaved)
    expect(await harness.control.submit(harness.authentication, second, new AbortController().signal)).toEqual(secondSaved)
    expect(await harness.control.query(harness.authentication, {
      type: 'project-settings',
      projectId: registered.receipt.projectId,
    }, new AbortController().signal)).toMatchObject({
      ok: true,
      projection: {
        synchronization: {
          revision: 2,
          pending: {
            revision: 2,
            configuration: { rateLimitReserve: 750 },
          },
        },
      },
    })
    await harness.close()
  })

  it('returns typed Project and selection misses without changing the registered aggregate', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'typed-misses')
    const harness = await start(durable)
    const selection = await inspected(harness, repo)
    const request = intent(
      'intent-18181818-1818-4818-8818-181818181818',
      'Typed misses',
      repo,
      0,
      selection,
    )
    const registered = await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )
    if (!registered.ok) throw new Error('registration failed')
    const missingProjectId = 'project-18181818-1818-4818-8818-181818181819' as SakiDevelopmentProjectId

    expect(await harness.control.query(harness.authentication, {
      type: 'development-workspace',
      projectId: registered.receipt.projectId,
      expectedRegistryRevision: 0,
    }, new AbortController().signal)).toEqual({ ok: false, reason: 'stale' })
    expect(await harness.control.query(harness.authentication, {
      type: 'development-workspace',
      projectId: missingProjectId,
      expectedRegistryRevision: 1,
    }, new AbortController().signal)).toEqual({ ok: false, reason: 'not-found' })
    expect(await harness.control.query(harness.authentication, {
      type: 'project-settings',
      projectId: missingProjectId,
    }, new AbortController().signal)).toEqual({ ok: false, reason: 'not-found' })
    expect(await harness.control.query(harness.authentication, {
      type: 'board',
      projectId: missingProjectId,
      refresh: 'cached',
    }, new AbortController().signal)).toEqual({ ok: false, reason: 'not-found' })
    expect(await harness.control.query(harness.authentication, {
      type: 'board',
      projectId: missingProjectId,
      refresh: 'interactive',
    }, new AbortController().signal)).toEqual({ ok: false, reason: 'not-found' })
    expect(await harness.control.query(harness.authentication, {
      type: 'project-changes',
      projectId: missingProjectId,
      expectedRegistryRevision: 1,
    }, new AbortController().signal)).toEqual({ ok: false, reason: 'not-found' })
    expect(await harness.control.query(harness.authentication, {
      ...SAKI_GIT_REQUEST_FIXTURES.diff,
      projectId: missingProjectId,
      expectedRegistryRevision: 1,
    }, new AbortController().signal)).toEqual({ ok: false, reason: 'not-found' })
    expect(await harness.control.query(harness.authentication, {
      type: 'inspect-project-selection',
      hostId: harness.control.identity().hostId,
      directoryLocator: join(durable.root, 'missing-selection'),
    }, new AbortController().signal)).toEqual({
      ok: true,
      projection: {
        type: 'inspect-project-selection',
        result: { ok: false, reason: 'missing' },
      },
    })
    expect(await harness.control.query(harness.authentication, {
      type: 'inspect-project-selection',
      hostId: 'host-18181818-1818-4818-8818-181818181818' as SakiHostId,
      directoryLocator: repo,
    }, new AbortController().signal)).toEqual({ ok: false, reason: 'denied' })
    expect(await harness.control.submit(harness.authentication, {
      ...request,
      intentId: 'intent-18181818-1818-4818-8818-18181818181a' as SakiControlIntentId,
      directoryLocator: join(durable.root, 'missing-registration'),
      expectedRegistryRevision: 1,
    }, new AbortController().signal)).toEqual({ ok: false, reason: 'conflict' })
    expect(await harness.control.submit(harness.authentication, {
      ...request,
      intentId: 'intent-18181818-1818-4818-8818-18181818181b' as SakiControlIntentId,
      hostId: 'host-18181818-1818-4818-8818-181818181818' as SakiHostId,
      expectedRegistryRevision: 1,
    }, new AbortController().signal)).toEqual({ ok: false, reason: 'denied' })
    await setGrantActions(harness, ['development-project:register'])
    expect(await harness.control.query(harness.authentication, {
      type: 'inspect-project-selection',
      hostId: harness.control.identity().hostId,
      directoryLocator: repo,
    }, new AbortController().signal)).toEqual({ ok: false, reason: 'denied' })
    expect(await harness.control.query(harness.authentication, {
      type: 'project-settings',
      projectId: registered.receipt.projectId,
    }, new AbortController().signal)).toEqual({ ok: false, reason: 'denied' })
    expect(await harness.control.query(harness.authentication, {
      type: 'board',
      projectId: registered.receipt.projectId,
      refresh: 'cached',
    }, new AbortController().signal)).toEqual({ ok: false, reason: 'denied' })
    expect(await harness.control.query(harness.authentication, {
      type: 'project-changes',
      projectId: registered.receipt.projectId,
      expectedRegistryRevision: 1,
    }, new AbortController().signal)).toEqual({ ok: false, reason: 'denied' })
    expect(await harness.control.query(harness.authentication, {
      ...SAKI_GIT_REQUEST_FIXTURES.diff,
      projectId: registered.receipt.projectId,
      expectedRegistryRevision: 1,
    }, new AbortController().signal)).toEqual({ ok: false, reason: 'denied' })
    expect(await harness.control.submit(harness.authentication, {
      ...SAKI_GIT_REQUEST_FIXTURES.stage,
      intentId: 'intent-18181818-1818-4818-8818-18181818181c' as SakiControlIntentId,
    }, new AbortController().signal)).toEqual({ ok: false, reason: 'denied' })
    expect(liveSakiDomain(harness.ctx).table('development_project_registry')
      .get('development-project-registry')?.projects).toHaveLength(1)
    await harness.close()
  })

  it('rejects changed replay payload and duplicate aliases without creating a second Project', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'duplicate')
    const harness = await start(durable)
    const selection = await inspected(harness, repo)
    const accepted = intent('intent-22222222-2222-4222-8222-222222222222', 'First title', repo, 0, selection)
    expect((await harness.control.submit(harness.authentication, accepted, new AbortController().signal)).ok).toBe(true)

    const changed = await harness.control.submit(harness.authentication, { ...accepted, projectTitle: 'Changed title' }, new AbortController().signal)
    expect(changed).toEqual({ ok: false, reason: 'conflict' })
    const alias = `${repo}/`
    const aliasSelection = await inspected(harness, alias)
    const duplicate = intent(
      'intent-33333333-3333-4333-8333-333333333333',
      'Alias',
      alias,
      1,
      aliasSelection,
    )
    const duplicateResult = await harness.control.submit(harness.authentication, duplicate, new AbortController().signal)
    expect(duplicateResult).toMatchObject({ ok: false, reason: 'conflict', receipt: { reason: 'duplicate-binding' } })
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(1)
    const index = await harness.control.query(harness.authentication, { type: 'project-index' }, new AbortController().signal)
    expect(index.ok && index.projection.type === 'project-index' ? index.projection.projects : []).toHaveLength(1)
    await harness.close()
  })

  it('scopes canonical-path duplicate identities to their owning Host', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'cross-host-path')
    const harness = await start(durable)
    const firstRequest = intent(
      'intent-28282828-2828-4828-8828-282828282828',
      'First Host project',
      repo,
      0,
      await inspected(harness, repo),
    )
    expect(await harness.control.submit(
      harness.authentication,
      firstRequest,
      new AbortController().signal,
    )).toMatchObject({ ok: true })

    const registryTable = liveSakiDomain(harness.ctx).table('development_project_registry')
    const intentTable = liveSakiDomain(harness.ctx).table('registration_intents')
    const firstIntent = intentTable.get(firstRequest.intentId)
    const registry = registryTable.get('development-project-registry')
    const firstInspection = registry?.resourceBindings[0]?.currentInspection
    if (firstIntent === undefined || firstInspection === undefined) {
      throw new Error('first Host registration fixture is incomplete')
    }
    const otherHostId = 'host-29292929-2929-4929-8929-292929292929' as SakiHostId
    const otherWorkspaceId = WorkspaceId('workspace-other-host')
    const { fingerprint: _fingerprint, ...projection } = firstInspection.projection
    const otherInspection = signedInspection({
      ...projection,
      hostId: otherHostId,
      workspaceId: otherWorkspaceId,
    }, firstInspection.trusted)
    const otherRequest = intent(
      'intent-29292929-2929-4929-8929-292929292929',
      'Other Host project',
      repo,
      1,
      otherInspection.projection,
    )
    const execution = {
      inspectProjectSelection: () => Promise.resolve({ ok: true, inspection: otherInspection }),
    } as unknown as SakiHostExecution
    const projects = new DevelopmentProjects({
      registryTable,
      intentTable,
      execution,
      workspaces: {
        list: () => [{ id: otherWorkspaceId, path: firstInspection.trusted.canonicalWorktreePath }],
        create: vi.fn(),
      } as never,
      authorityCurrent: () => true,
      validateActorReference: () => {},
      defaultAgentProfileTemplate: DEFAULT_AGENT_PROFILE_TEMPLATE,
    })

    const registration = await projects.register(
      otherRequest,
      { ...firstIntent.payload.actor, hostId: otherHostId },
      otherInspection,
      new AbortController().signal,
    )
    expect(registration).toMatchObject({ ok: true, receipt: { state: 'confirmed', registryRevision: 2 } })
    if (!registration.ok) throw new Error('second Host registration failed')
    const receipt = registration.receipt
    if (receipt.state !== 'confirmed' || !('projectId' in receipt)) {
      throw new Error('second Host registration failed')
    }
    const committed = projects.registry()
    const otherProject = committed.projects.find(project => project.id === receipt.projectId)
    const otherProfile = committed.agentProfiles.find(profile => profile.id === otherProject?.defaultAgentProfileId)
    expect(otherProfile).toMatchObject({
      projectId: receipt.projectId,
      version: 1,
      agentPresetId: 'standard',
      modelRouteRequest: { provider: 'test-provider', model: 'test-model' },
    })
    expect(committed.resourceBindings.map(binding => binding.hostId)).toEqual([
      firstIntent.payload.actor.hostId,
      otherHostId,
    ])
    expect(new Set(committed.canonicalWorktreeIndex.map(entry => entry.path))).toEqual(new Set([
      firstInspection.trusted.canonicalWorktreePath,
    ]))
    expect(new Set(committed.canonicalWorktreeIndex.map(entry => entry.hostId))).toEqual(new Set([
      firstIntent.payload.actor.hostId,
      otherHostId,
    ]))
    await harness.close()
  })

  it('registers linked worktrees independently while sharing their common Git directory', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'linked-main')
    const linked = join(durable.root, 'linked-secondary')
    await run('git', ['worktree', 'add', '-b', 'linked-fixture', linked], {
      cwd: repo,
      windowsHide: true,
    })
    const harness = await start(durable)
    const hostId = harness.control.identity().hostId
    const mainObservation = await harness.ctx.sakiHostExecution.inspectProjectSelection({
      hostId,
      directoryLocator: repo,
    }, new AbortController().signal)
    const linkedObservation = await harness.ctx.sakiHostExecution.inspectProjectSelection({
      hostId,
      directoryLocator: linked,
    }, new AbortController().signal)
    if (!mainObservation.ok) {
      throw new Error(`main linked-worktree fixture inspection failed: ${mainObservation.reason}`)
    }
    if (!linkedObservation.ok) {
      throw new Error(`secondary linked-worktree fixture inspection failed: ${linkedObservation.reason}`)
    }
    expect(mainObservation.inspection.trusted.canonicalCommonGitDirectory)
      .toBe(linkedObservation.inspection.trusted.canonicalCommonGitDirectory)
    expect(mainObservation.inspection.trusted.canonicalGitDirectory)
      .not.toBe(linkedObservation.inspection.trusted.canonicalGitDirectory)

    const first = await harness.control.submit(harness.authentication, intent(
      'intent-34343434-3434-4434-8434-343434343434',
      'Main worktree',
      repo,
      0,
      mainObservation.inspection.projection,
    ), new AbortController().signal)
    const secondSelection = await inspected(harness, linked)
    const second = await harness.control.submit(harness.authentication, intent(
      'intent-35353535-3535-4535-8535-353535353535',
      'Linked worktree',
      linked,
      1,
      secondSelection,
    ), new AbortController().signal)

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(first.ok && second.ok ? first.receipt.projectId : undefined)
      .not.toBe(second.ok ? second.receipt.projectId : undefined)
    const index = await harness.control.query(
      harness.authentication,
      { type: 'project-index' },
      new AbortController().signal,
    )
    expect(index.ok && index.projection.type === 'project-index'
      ? index.projection.projects
      : []).toHaveLength(2)
    await harness.close()
  })

  it.each([
    { label: 'empty', workspaceId: '' },
    { label: 'non-UUID', workspaceId: 'workspace-sentinel' },
  ])('adopts and reopens a pre-existing $label Workspace identity', async ({ workspaceId }) => {
    const durable = await paths()
    const repo = await repository(durable.root, `workspace-id-${workspaceId === '' ? 'empty' : 'opaque'}`)
    await seedWorkspace(durable, workspaceId, repo)
    let harness = await start(durable)
    const selection = await inspected(harness, repo)
    expect(Object.hasOwn(selection, 'workspaceId')).toBe(true)
    expect(selection.workspaceId).toBe(workspaceId)
    const request = intent(
      workspaceId === ''
        ? 'intent-36363636-3636-4636-8636-363636363636'
        : 'intent-37373737-3737-4737-8737-373737373737',
      'Opaque Workspace identity',
      repo,
      0,
      selection,
    )
    const create = vi.spyOn(harness.ctx.workspaceRegistry, 'create')
    const first = await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )
    expect(first).toMatchObject({ ok: true, receipt: { state: 'confirmed' } })
    expect(create).not.toHaveBeenCalled()
    if (!first.ok) throw new Error('pre-existing Workspace registration failed')
    const detail = await harness.control.query(harness.authentication, {
      type: 'development-workspace',
      projectId: first.receipt.projectId,
      expectedRegistryRevision: first.receipt.registryRevision,
    }, new AbortController().signal)
    expect(detail.ok && detail.projection.type === 'development-workspace'
      ? detail.projection.currentSelection?.workspaceId
      : undefined).toBe(workspaceId)
    await harness.close()

    harness = await start(durable)
    expect(harness.ctx.workspaceRegistry.list().map(workspace => workspace.id)).toEqual([workspaceId])
    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toEqual(first)
    await harness.close()
  })

  it('registers an explicit unavailable baseline but disables automatic mutation', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'bounded')
    await writeFile(join(repo, 'tracked.txt'), 'content beyond bound\n')
    const harness = await start(durable, 4)
    const selection = await inspected(harness, repo)
    expect(selection.baseline).toMatchObject({ kind: 'unavailable', reason: 'file-limit' })
    expect(selection.baseline).not.toHaveProperty('digest')
    const request = intent('intent-44444444-4444-4444-8444-444444444444', 'Bounded', repo, 0, selection)
    const registered = await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )
    if (!registered.ok) throw new Error('registration failed')
    const index = await harness.control.query(harness.authentication, { type: 'project-index' }, new AbortController().signal)
    expect(index).toMatchObject({
      ok: true,
      projection: { projects: [{ binding: {
        baseline: 'unavailable',
        automaticMutationEligible: false,
        configurationGaps: ['baseline-unavailable'],
      } }] },
    })
    expect(await harness.control.query(harness.authentication, {
      type: 'development-workspace',
      projectId: registered.receipt.projectId,
      expectedRegistryRevision: registered.receipt.registryRevision,
    }, new AbortController().signal)).toMatchObject({
      ok: true,
      projection: {
        recovery: { state: 'blocked', reasons: ['baseline-unavailable', 'dirty'] },
      },
    })
    await harness.close()
  })

  it('marks a missing registered binding on restart without changing stable ids', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'movable')
    const canonicalRepo = await realpath(repo)
    let harness = await start(durable)
    const selection = await inspected(harness, repo)
    const registered = await harness.control.submit(harness.authentication,
      intent('intent-55555555-5555-4555-8555-555555555555', 'Movable', repo, 0, selection),
      new AbortController().signal)
    if (!registered.ok) throw new Error('registration failed')
    await harness.close()

    const restartMissing = async () => {
      const restarted = await context(durable)
      const inspect = vi.spyOn(restarted.sakiHostExecution, 'inspectProjectSelection')
        .mockResolvedValue({ ok: false, reason: 'missing' })
      return { harness: await mountControlPlane(restarted), inspect }
    }
    let missing = await restartMissing()
    harness = missing.harness
    expect(missing.inspect).toHaveBeenCalled()
    expect(missing.inspect.mock.calls.every(([input]) => input.directoryLocator === canonicalRepo)).toBe(true)
    const index = await harness.control.query(harness.authentication, { type: 'project-index' }, new AbortController().signal)
    expect(index).toMatchObject({
      ok: true,
      projection: { projects: [{
        id: registered.receipt.projectId,
        binding: { health: 'missing', automaticMutationEligible: false, configurationGaps: ['binding-missing'] },
      }] },
    })
    expect(await harness.control.query(harness.authentication, {
      type: 'development-workspace',
      projectId: registered.receipt.projectId,
      expectedRegistryRevision: index.ok && index.projection.type === 'project-index'
        ? index.projection.revision
        : -1,
    }, new AbortController().signal)).toMatchObject({
      ok: true,
      projection: {
        recovery: { state: 'blocked', reasons: ['binding-missing'] },
      },
    })
    const firstMissingRevision = index.ok && index.projection.type === 'project-index'
      ? index.projection.revision
      : -1
    expect(await harness.control.query(harness.authentication, {
      type: 'project-changes',
      projectId: registered.receipt.projectId,
      expectedRegistryRevision: firstMissingRevision,
    }, new AbortController().signal)).toEqual({ ok: false, reason: 'binding-unavailable' })
    await harness.close()

    missing = await restartMissing()
    harness = missing.harness
    expect(missing.inspect.mock.calls.every(([input]) => input.directoryLocator === canonicalRepo)).toBe(true)
    expect(await harness.control.query(
      harness.authentication,
      { type: 'project-index' },
      new AbortController().signal,
    )).toMatchObject({ ok: true, projection: { revision: firstMissingRevision } })
    await harness.close()
  })

  it('requires repair when Git administration is rebuilt at the registered path', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'replacement-clone')
    let harness = await start(durable)
    const request = intent(
      'intent-57575757-5757-4757-8757-575757575757',
      'Replacement clone',
      repo,
      0,
      await inspected(harness, repo),
    )
    const registered = await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )
    if (!registered.ok) throw new Error('registration failed')
    const retained = liveSakiDomain(harness.ctx).table('development_project_registry')
      .get('development-project-registry')?.resourceBindings[0]?.registrationInspection.trusted
    if (retained === undefined) throw new Error('registration identity fixture is absent')
    await harness.close()

    await rename(join(repo, '.git'), join(durable.root, 'replacement-prior-git'))
    await run('git', ['init'], { cwd: repo, windowsHide: true })
    await run('git', ['config', 'user.name', 'Saki Test'], { cwd: repo, windowsHide: true })
    await run('git', ['config', 'user.email', 'saki@example.invalid'], { cwd: repo, windowsHide: true })
    await run('git', ['add', 'tracked.txt'], { cwd: repo, windowsHide: true })
    await run('git', ['commit', '-m', 'replacement'], { cwd: repo, windowsHide: true })

    harness = await start(durable)
    const registry = liveSakiDomain(harness.ctx).table('development_project_registry')
      .get('development-project-registry')
    const binding = registry?.resourceBindings[0]
    expect(binding).toMatchObject({
      id: registered.receipt.resourceBindingId,
      health: 'repair-required',
    })
    expect(binding?.currentInspection).toBeUndefined()
    const fresh = await harness.ctx.sakiHostExecution.inspectProjectSelection({
      hostId: harness.control.identity().hostId,
      directoryLocator: repo,
    }, new AbortController().signal)
    if (!fresh.ok) throw new Error('replacement clone inspection failed')
    expect(fresh.inspection.trusted.canonicalWorktreePath).toBe(retained.canonicalWorktreePath)
    expect(fresh.inspection.trusted.canonicalGitDirectory).toBe(retained.canonicalGitDirectory)
    expect(fresh.inspection.trusted.gitDirectoryIdentity).not.toEqual(retained.gitDirectoryIdentity)
    expect(await harness.control.query(
      harness.authentication,
      { type: 'project-index' },
      new AbortController().signal,
    )).toMatchObject({
      ok: true,
      projection: { projects: [{ binding: {
        health: 'repair-required',
        automaticMutationEligible: false,
        configurationGaps: ['binding-repair-required'],
      } }] },
    })
    await harness.close()
  })

  it('projects repair, dirty, ambiguous, and locked recovery evidence', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'projection-recovery')
    let harness = await start(durable)
    const request = intent(
      'intent-19191919-1919-4919-8919-191919191919',
      'Projection recovery',
      repo,
      0,
      await inspected(harness, repo),
    )
    const registered = await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )
    if (!registered.ok) throw new Error('registration failed')
    const workspaceId = harness.ctx.workspaceRegistry.list()[0]?.id
    if (workspaceId === undefined) throw new Error('Workspace fixture is absent')
    expect(await harness.ctx.workspaceRegistry.delete(workspaceId)).toBe(true)
    await harness.close()

    harness = await start(durable)
    const repairedIndex = await harness.control.query(
      harness.authentication,
      { type: 'project-index' },
      new AbortController().signal,
    )
    expect(repairedIndex).toMatchObject({
      ok: true,
      projection: { projects: [{ binding: {
        health: 'repair-required',
        configurationGaps: ['binding-repair-required'],
      } }] },
    })
    const repairRevision = repairedIndex.ok && repairedIndex.projection.type === 'project-index'
      ? repairedIndex.projection.revision
      : -1
    expect(await harness.control.query(harness.authentication, {
      type: 'development-workspace',
      projectId: registered.receipt.projectId,
      expectedRegistryRevision: repairRevision,
    }, new AbortController().signal)).toMatchObject({
      ok: true,
      projection: {
        recovery: { state: 'blocked', reasons: ['binding-repair-required'] },
      },
    })

    const registryTable = liveSakiDomain(harness.ctx).table('development_project_registry')
    await registryTable.update('development-project-registry', (registry) => {
      const binding = registry.resourceBindings[0]
      if (binding === undefined) throw new Error('Binding fixture is absent')
      const current = binding.registrationInspection
      const {
        fingerprint: _fingerprint,
        upstream: _upstream,
        ...projection
      } = current.projection
      if (current.projection.head.kind !== 'commit') throw new Error('Expected committed registration fixture')
      const baseline = SAKI_PROJECT_PROJECTION_FIXTURES.dirtySelection.baseline
      binding.health = 'active'
      binding.currentInspection = signedInspection({
        ...projection,
        workspaceId,
        head: { kind: 'commit', objectId: current.projection.head.objectId },
        locked: true,
        inheritedChangeEntryCount: baseline.observed.entries,
        conversionAmbiguous: true,
        automaticMutationEligible: false,
        blockingReasons: ['dirty', 'conversion-ambiguous', 'locked'],
        baseline,
      }, current.trusted)
      registry.revision += 1
      binding.revision += 1
      return registry
    })
    const blockedIndex = await harness.control.query(
      harness.authentication,
      { type: 'project-index' },
      new AbortController().signal,
    )
    expect(blockedIndex).toMatchObject({
      ok: true,
      projection: { projects: [{ binding: {
        health: 'active',
        head: { kind: 'commit' },
        automaticMutationEligible: false,
        configurationGaps: ['conversion-ambiguous'],
      } }] },
    })
    if (!blockedIndex.ok || blockedIndex.projection.type !== 'project-index') {
      throw new Error('Project index fixture failed')
    }
    expect(blockedIndex.projection.projects[0]?.binding.head).not.toHaveProperty('symbolicRef')
    expect(await harness.control.query(harness.authentication, {
      type: 'development-workspace',
      projectId: registered.receipt.projectId,
      expectedRegistryRevision: blockedIndex.projection.revision,
    }, new AbortController().signal)).toMatchObject({
      ok: true,
      projection: {
        recovery: {
          state: 'blocked',
          reasons: ['conversion-ambiguous', 'dirty', 'locked'],
        },
      },
    })
    await harness.close()
  })

  it('serializes exact replays by Intent id and performs the Workspace effect once', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'single-flight')
    const harness = await start(durable)
    const selection = await inspected(harness, repo)
    const request = intent(
      'intent-66666666-6666-4666-8666-666666666666',
      'Single flight',
      repo,
      0,
      selection,
    )
    const create = vi.spyOn(harness.ctx.workspaceRegistry, 'create')

    const [left, right] = await Promise.all([
      harness.control.submit(harness.authentication, request, new AbortController().signal),
      harness.control.submit(harness.authentication, request, new AbortController().signal),
    ])

    expect(left).toEqual(right)
    expect(left).toMatchObject({ ok: true, receipt: { state: 'confirmed', registryRevision: 1 } })
    expect(create).toHaveBeenCalledTimes(1)
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(1)
    await harness.close()
  })

  it('recovers a Workspace durable before its identity is retained by the Intent', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'create-recovery')
    let harness = await start(durable)
    const selection = await inspected(harness, repo)
    const request = intent(
      'intent-77777777-7777-4777-8777-777777777777',
      'Create recovery',
      repo,
      0,
      selection,
    )
    const originalCreate = harness.ctx.workspaceRegistry.create.bind(harness.ctx.workspaceRegistry)
    const create = vi.spyOn(harness.ctx.workspaceRegistry, 'create')
      .mockImplementationOnce(async (path, title) => {
        await originalCreate(path, title)
        throw new Error('durable Workspace survived an unknown create outcome')
      })

    const first = await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )
    expect(first).toMatchObject({ ok: false, reason: 'unavailable', receipt: { state: 'prepared' } })
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(1)
    await harness.close()

    harness = await start(durable)
    const replay = await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )
    expect(replay).toMatchObject({ ok: true, receipt: { state: 'confirmed', registryRevision: 1 } })
    expect(create).toHaveBeenCalledTimes(1)
    await harness.close()
  })

  it('recovers after the prepared Intent is durable but its first response is lost', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'prepared-cut')
    let harness = await start(durable)
    const request = intent(
      'intent-73737373-7373-4373-8373-737373737373',
      'Prepared cut',
      repo,
      0,
      await inspected(harness, repo),
    )
    const intents = liveSakiDomain(harness.ctx).table('registration_intents')
    const put = intents.put.bind(intents)
    vi.spyOn(intents, 'put').mockImplementationOnce(async (key, value) => {
      await put(key, value)
      throw new Error('simulated response loss after prepared Intent')
    })

    await expect(harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).rejects.toThrow('simulated response loss')
    expect(intents.get(request.intentId)).toMatchObject({ phase: 'prepared' })
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(0)
    await harness.close()

    harness = await start(durable)
    const recovered = await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )
    expect(recovered).toMatchObject({ ok: true, receipt: { state: 'confirmed' } })
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(1)
    await harness.close()
  })

  it('recovers after dispatch is durable before the first Workspace effect', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'dispatch-cut')
    let harness = await start(durable)
    const request = intent(
      'intent-74747474-7474-4474-8474-747474747474',
      'Dispatch cut',
      repo,
      0,
      await inspected(harness, repo),
    )
    const originalInspect = harness.ctx.sakiHostExecution.inspectProjectSelection
      .bind(harness.ctx.sakiHostExecution)
    let inspections = 0
    vi.spyOn(harness.ctx.sakiHostExecution, 'inspectProjectSelection')
      .mockImplementation(async (input, signal) => {
        inspections += 1
        if (inspections === 2) {
          expect(liveSakiDomain(harness.ctx).table('registration_intents').get(request.intentId))
            .toMatchObject({ phase: 'workspace-dispatching' })
          throw new Error('simulated crash after dispatch')
        }
        return await originalInspect(input, signal)
      })

    await expect(harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).rejects.toThrow('simulated crash after dispatch')
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(0)
    await harness.close()

    harness = await start(durable)
    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toMatchObject({ ok: true, receipt: { state: 'confirmed' } })
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(1)
    await harness.close()
  })

  it('recovers through the retained canonical locator after the submitted alias disappears', async () => {
    const durable = await paths()
    const repo = join(durable.root, 'alias-disappears-repository')
    await mkdir(repo)
    const canonicalRepo = await realpath(repo)
    const alias = join(durable.root, 'alias-disappears-selection')
    let harness = await start(durable)
    const inspection = fixtureInspection(harness.control.identity().hostId, canonicalRepo, '4')
    const request = intent(
      'intent-74707070-7470-4470-8470-747070707470',
      'Alias disappears',
      alias,
      0,
      inspection.projection,
    )
    let inspections = 0
    vi.spyOn(harness.ctx.sakiHostExecution, 'inspectProjectSelection')
      .mockImplementation(async () => {
        inspections += 1
        if (inspections === 2) return { ok: false, reason: 'unavailable' }
        return { ok: true, inspection }
      })
    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toMatchObject({ ok: false, reason: 'unavailable', receipt: { state: 'prepared' } })
    expect(liveSakiDomain(harness.ctx).table('registration_intents').get(request.intentId))
      .toMatchObject({ phase: 'workspace-dispatching' })
    await harness.close()

    const restarted = await context(durable)
    const inspect = vi.spyOn(restarted.sakiHostExecution, 'inspectProjectSelection')
      .mockImplementation(async (input) => {
        if (input.directoryLocator === canonicalRepo) return { ok: true, inspection: fixtureInspection(
          inspection.projection.hostId,
          canonicalRepo,
          '4',
          restarted.workspaceRegistry.list().find(workspace => workspace.path === canonicalRepo)?.id,
        ) }
        if (input.directoryLocator === alias) return { ok: false, reason: 'missing' }
        return { ok: false, reason: 'unavailable' }
      })
    harness = await mountControlPlane(restarted)
    expect(inspect).toHaveBeenCalled()
    expect(inspect.mock.calls.every(([input]) => input.directoryLocator === canonicalRepo)).toBe(true)
    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toMatchObject({ ok: true, receipt: { state: 'confirmed' } })
    expect(harness.ctx.workspaceRegistry.list()).toEqual([
      expect.objectContaining({ path: canonicalRepo }),
    ])
    await harness.close()
  })

  it('recovers the original repository after the submitted alias points elsewhere', async () => {
    const durable = await paths()
    const repo = join(durable.root, 'alias-retarget-original')
    const unrelated = join(durable.root, 'alias-retarget-unrelated')
    await Promise.all([mkdir(repo), mkdir(unrelated)])
    const alias = join(durable.root, 'alias-retarget-selection')
    const canonicalRepo = await realpath(repo)
    const canonicalUnrelated = await realpath(unrelated)
    const harness = await start(durable)
    const inspection = fixtureInspection(harness.control.identity().hostId, canonicalRepo, '5')
    const unrelatedInspection = fixtureInspection(harness.control.identity().hostId, canonicalUnrelated, '6')
    const request = intent(
      'intent-74717171-7471-4471-8471-747171717471',
      'Alias retarget',
      alias,
      0,
      inspection.projection,
    )
    let inspections = 0
    vi.spyOn(harness.ctx.sakiHostExecution, 'inspectProjectSelection')
      .mockImplementation(async () => {
        inspections += 1
        if (inspections === 2) return { ok: false, reason: 'unavailable' }
        return { ok: true, inspection }
      })
    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toMatchObject({ ok: false, reason: 'unavailable', receipt: { state: 'prepared' } })
    await harness.close()

    const restarted = await context(durable)
    const inspect = vi.spyOn(restarted.sakiHostExecution, 'inspectProjectSelection')
      .mockImplementation(async (input) => {
        if (input.directoryLocator === canonicalRepo) return { ok: true, inspection: fixtureInspection(
          inspection.projection.hostId,
          canonicalRepo,
          '5',
          restarted.workspaceRegistry.list().find(workspace => workspace.path === canonicalRepo)?.id,
        ) }
        if (input.directoryLocator === alias) return { ok: true, inspection: unrelatedInspection }
        return { ok: false, reason: 'unavailable' }
      })
    const create = vi.spyOn(restarted.workspaceRegistry, 'create')
    const controlFiber = await restarted.plugin(SakiControlPlane, CONTROL_CONFIG)
    try {
      expect(inspect).toHaveBeenCalled()
      expect(inspect.mock.calls.every(([input]) => input.directoryLocator === canonicalRepo)).toBe(true)
      expect(create).toHaveBeenCalledWith(canonicalRepo, 'Alias retarget')
      expect(restarted.workspaceRegistry.list()).toEqual([
        expect.objectContaining({ path: canonicalRepo }),
      ])
      const domain = liveSakiDomain(restarted)
      expect(domain.table('registration_intents').get(request.intentId)).toMatchObject({ phase: 'confirmed' })
      expect(domain.table('development_project_registry').get('development-project-registry'))
        .toMatchObject({ resourceBindings: [{ registrationInspection: {
          trusted: { canonicalWorktreePath: canonicalRepo },
        } }] })
    } finally {
      await controlFiber.dispose()
      await restarted.fiber.dispose()
    }
  })

  it('revalidates a registered Binding independently of later alias drift', async () => {
    const durable = await paths()
    const repo = join(durable.root, 'alias-revalidation-original')
    const unrelated = join(durable.root, 'alias-revalidation-unrelated')
    await Promise.all([mkdir(repo), mkdir(unrelated)])
    const alias = join(durable.root, 'alias-revalidation-selection')
    const canonicalRepo = await realpath(repo)
    const canonicalUnrelated = await realpath(unrelated)
    const harness = await start(durable)
    const inspection = fixtureInspection(harness.control.identity().hostId, canonicalRepo, '7')
    const unrelatedInspection = fixtureInspection(harness.control.identity().hostId, canonicalUnrelated, '8')
    const request = intent(
      'intent-74727272-7472-4472-8472-747272727472',
      'Alias revalidation',
      alias,
      0,
      inspection.projection,
    )
    vi.spyOn(harness.ctx.sakiHostExecution, 'inspectProjectSelection')
      .mockImplementation(async () => ({
        ok: true,
        inspection: fixtureInspection(
          inspection.projection.hostId,
          canonicalRepo,
          '7',
          harness.ctx.workspaceRegistry.list().find(workspace => workspace.path === canonicalRepo)?.id,
        ),
      }))
    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toMatchObject({ ok: true, receipt: { state: 'confirmed' } })
    await harness.close()

    const restarted = await context(durable)
    const currentInspection = fixtureInspection(
      inspection.projection.hostId,
      canonicalRepo,
      '7',
      restarted.workspaceRegistry.list().find(workspace => workspace.path === canonicalRepo)?.id,
    )
    const { fingerprint, ...currentProjection } = currentInspection.projection
    void fingerprint
    const refreshedInspection = signedInspection({
      ...currentProjection,
      displayLocation: 'repository-revalidated',
    }, currentInspection.trusted)
    const inspect = vi.spyOn(restarted.sakiHostExecution, 'inspectProjectSelection')
      .mockImplementation(async (input) => {
        if (input.directoryLocator === canonicalRepo) return { ok: true, inspection: refreshedInspection }
        if (input.directoryLocator === alias) return { ok: true, inspection: unrelatedInspection }
        return { ok: false, reason: 'unavailable' }
      })
    const controlFiber = await restarted.plugin(SakiControlPlane, CONTROL_CONFIG)
    try {
      expect(inspect).toHaveBeenCalled()
      expect(inspect.mock.calls.every(([input]) => input.directoryLocator === canonicalRepo)).toBe(true)
      expect(liveSakiDomain(restarted).table('development_project_registry')
        .get('development-project-registry')).toMatchObject({
        resourceBindings: [{
          health: 'active',
          registrationInspection: { trusted: { canonicalWorktreePath: canonicalRepo } },
          currentInspection: {
            projection: { displayLocation: 'repository-revalidated' },
            trusted: { canonicalWorktreePath: canonicalRepo },
          },
        }],
      })
    } finally {
      await controlFiber.dispose()
      await restarted.fiber.dispose()
    }
  })

  it('recovers after Workspace observation is durable before the Registry commit', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'workspace-observed-cut')
    let harness = await start(durable)
    const request = intent(
      'intent-75757575-7575-4575-8575-757575757575',
      'Workspace observed cut',
      repo,
      0,
      await inspected(harness, repo),
    )
    const registry = liveSakiDomain(harness.ctx).table('development_project_registry')
    vi.spyOn(registry, 'update').mockImplementationOnce(async () => {
      expect(liveSakiDomain(harness.ctx).table('registration_intents').get(request.intentId))
        .toMatchObject({ phase: 'workspace-observed' })
      throw new Error('simulated crash before Registry commit')
    })

    await expect(harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).rejects.toThrow('simulated crash before Registry commit')
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(1)
    expect(registry.get('development-project-registry')?.projects).toHaveLength(0)
    await harness.close()

    harness = await start(durable)
    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toMatchObject({ ok: true, receipt: { state: 'confirmed', registryRevision: 1 } })
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(1)
    await harness.close()
  })

  it('recovers a Registry CAS that commits before the Intent phase advances', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'registry-cas-cut')
    let harness = await start(durable)
    const request = intent(
      'intent-76767676-7676-4676-8676-767676767676',
      'Registry CAS cut',
      repo,
      0,
      await inspected(harness, repo),
    )
    const registry = liveSakiDomain(harness.ctx).table('development_project_registry')
    const update = registry.update.bind(registry)
    vi.spyOn(registry, 'update').mockImplementationOnce(async (key, transform) => {
      await update(key, transform)
      throw new Error('simulated response loss after Registry CAS')
    })

    await expect(harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).rejects.toThrow('simulated response loss after Registry CAS')
    expect(registry.get('development-project-registry')).toMatchObject({
      revision: 1,
      projects: [{ projectTitle: 'Registry CAS cut' }],
      intentMappings: [{ intentId: request.intentId }],
    })
    expect(liveSakiDomain(harness.ctx).table('registration_intents').get(request.intentId))
      .toMatchObject({ phase: 'workspace-observed' })
    const committed = registry.get('development-project-registry')
    const project = committed?.projects[0]
    const binding = committed?.resourceBindings[0]
    if (project === undefined || binding === undefined) throw new Error('committed Project is absent')
    await writeFile(join(repo, 'tracked.txt'), 'changed before admission recovery\n')
    const changes = await harness.control.query<'project-changes'>(harness.authentication, {
      type: 'project-changes',
      projectId: project.id,
      expectedRegistryRevision: 1,
    }, new AbortController().signal)
    if (!changes.ok || !changes.projection.result.ok) throw new Error('committed Project changes are unavailable')
    const observation = changes.projection.result.observation
    if (observation.index.kind !== 'tree') throw new Error('committed Project index is unavailable')
    const change = observation.changes.find(candidate => candidate.path === 'tracked.txt')
    if (change === undefined) throw new Error('committed Project change is absent')
    const gitIntentId = 'intent-76767676-7676-4676-8676-767676767677' as SakiControlIntentId
    expect(await harness.control.submit(harness.authentication, {
      type: 'stage-files',
      intentId: gitIntentId,
      expected: {
        projectId: project.id,
        expectedRegistryRevision: 1,
        expectedProjectRevision: project.revision,
        expectedBinding: { id: binding.id, revision: binding.revision },
        expectedStatus: observation.fingerprint,
        expectedHead: observation.head,
        expectedIndex: observation.index,
        expectedWorktree: observation.worktree,
      },
      changes: [{ id: change.id, fingerprint: change.fingerprint }],
    }, new AbortController().signal)).toMatchObject({
      ok: false,
      reason: 'unavailable',
      receipt: { state: 'prepared' },
    })
    expect(liveSakiDomain(harness.ctx).table('git_operation_intents').get(gitIntentId))
      .toMatchObject({ phase: 'prepared' })
    await harness.close()

    harness = await start(durable)
    const recovered = await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )
    expect(recovered).toMatchObject({ ok: true, receipt: { state: 'confirmed', registryRevision: 1 } })
    expect(liveSakiDomain(harness.ctx).table('git_operation_intents').get(gitIntentId))
      .toMatchObject({
        phase: 'canceled',
        terminalReason: 'source-canceled',
        operationSnapshot: {
          state: 'canceled',
          admission: { kind: 'not-accepted' },
          effect: 'none',
        },
      })
    expect(liveSakiDomain(harness.ctx).table('binding_write_admissions').get(binding.id))
      .toMatchObject({ state: 'available' })
    expect((await run('git', ['diff', '--cached', '--name-only', '--'], {
      cwd: repo,
      windowsHide: true,
    })).stdout).toBe('')
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(1)
    await harness.close()
  })

  it('replays a confirmed Intent after confirmation commits before its response', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'confirmation-cut')
    let harness = await start(durable)
    const request = intent(
      'intent-76707070-7670-4670-8670-767070707670',
      'Confirmation cut',
      repo,
      0,
      await inspected(harness, repo),
    )
    const intents = liveSakiDomain(harness.ctx).table('registration_intents')
    const update = intents.update.bind(intents)
    vi.spyOn(intents, 'update').mockImplementation(async (key, transform) => {
      let confirmationCommitted = false
      const next = await update(key, (current) => {
        const transformed = transform(current)
        confirmationCommitted = current.phase === 'registry-committed'
          && transformed.phase === 'confirmed'
        return transformed
      })
      if (confirmationCommitted) throw new Error('simulated response loss after confirmation')
      return next
    })

    await expect(harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).rejects.toThrow('simulated response loss after confirmation')
    const confirmed = intents.get(request.intentId)
    expect(confirmed).toMatchObject({ phase: 'confirmed', registryRevision: 1 })
    await harness.close()

    harness = await start(durable)
    const replay = await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )
    expect(replay).toEqual({
      ok: true,
      receipt: {
        id: confirmed?.receiptId,
        intentId: request.intentId,
        state: 'confirmed',
        projectId: confirmed?.projectId,
        resourceBindingId: confirmed?.resourceBindingId,
        registryRevision: 1,
      },
    })
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(1)
    await harness.close()
  })

  it('never treats a re-signed retained canonical locator as sufficient authority', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'trusted-original')
    const substituted = await repository(durable.root, 'trusted-substituted')
    const requestId = 'intent-77707070-7770-4770-8770-777070707770' as SakiControlIntentId
    const harness = await start(durable)
    const request = intent(requestId, 'Trusted path substitution', repo, 0, await inspected(harness, repo))
    const originalInspect = harness.ctx.sakiHostExecution.inspectProjectSelection
      .bind(harness.ctx.sakiHostExecution)
    let inspections = 0
    vi.spyOn(harness.ctx.sakiHostExecution, 'inspectProjectSelection')
      .mockImplementation(async (input, signal) => {
        inspections += 1
        if (inspections === 2) return { ok: false, reason: 'unavailable' }
        return await originalInspect(input, signal)
      })
    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toMatchObject({ ok: false, reason: 'unavailable' })
    await harness.close()

    const substitutedPath = await realpath(substituted)
    await editSaki(durable, async (domain) => {
      await domain.table('registration_intents').update(requestId, (current) => {
        const trusted = {
          ...current.inspection.trusted,
          canonicalWorktreePath: substitutedPath,
        }
        const { fingerprint: _fingerprint, ...projectionMaterial } = current.inspection.projection
        const fingerprint = computeProjectInspectionFingerprint(projectionMaterial, trusted)
        const inspection = {
          trusted,
          projection: { ...projectionMaterial, fingerprint },
        }
        const payload = {
          ...current.payload,
          intent: { ...current.payload.intent, confirmedFingerprint: fingerprint },
        }
        return registrationIntentRecordSchema.parse({
          ...current,
          revision: current.revision + 1,
          inspection,
          payload,
          payloadDigest: canonicalDigest('saki/register-development-project/v1', payload),
          updatedAt: current.updatedAt + 1,
        })
      })
    })

    const restarted = await context(durable)
    const inspect = vi.spyOn(restarted.sakiHostExecution, 'inspectProjectSelection')
    const create = vi.spyOn(restarted.workspaceRegistry, 'create')
    const controlFiber = await restarted.plugin(SakiControlPlane, CONTROL_CONFIG)
    try {
      expect(inspect).toHaveBeenCalled()
      expect(inspect.mock.calls.every(([input]) => input.directoryLocator === substitutedPath)).toBe(true)
      expect(create).not.toHaveBeenCalled()
      expect(liveSakiDomain(restarted).table('registration_intents').get(requestId)).toMatchObject({
        phase: 'reconciliation-required',
        terminalReason: 'observation',
      })
    } finally {
      await controlFiber.dispose()
      await restarted.fiber.dispose()
    }
  })

  it('returns an unavailable result without preparing an Intent when the acceptance inspection is unavailable', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'acceptance-unavailable')
    const harness = await start(durable)
    const selection = await inspected(harness, repo)
    const request = intent(
      'intent-70707070-7070-4070-8070-707070707070',
      'Acceptance unavailable',
      repo,
      0,
      selection,
    )
    vi.spyOn(harness.ctx.sakiHostExecution, 'inspectProjectSelection')
      .mockResolvedValueOnce({ ok: false, reason: 'unavailable' })

    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toEqual({ ok: false, reason: 'unavailable' })
    expect(liveSakiDomain(harness.ctx).table('registration_intents').size).toBe(0)
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(0)
    await harness.close()
  })

  it('retains a dispatching Intent when the pre-effect inspection is unavailable and resumes it', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'dispatch-unavailable')
    const harness = await start(durable)
    const selection = await inspected(harness, repo)
    const request = intent(
      'intent-71717171-7171-4171-8171-717171717171',
      'Dispatch unavailable',
      repo,
      0,
      selection,
    )
    const originalInspect = harness.ctx.sakiHostExecution.inspectProjectSelection
      .bind(harness.ctx.sakiHostExecution)
    let inspections = 0
    vi.spyOn(harness.ctx.sakiHostExecution, 'inspectProjectSelection')
      .mockImplementation(async (input, signal) => {
        inspections += 1
        if (inspections === 2) return { ok: false, reason: 'unavailable' }
        return await originalInspect(input, signal)
      })

    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toMatchObject({ ok: false, reason: 'unavailable', receipt: { state: 'prepared' } })
    expect(liveSakiDomain(harness.ctx).table('registration_intents').get(request.intentId))
      .toMatchObject({ phase: 'workspace-dispatching' })
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(0)

    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toMatchObject({ ok: true, receipt: { state: 'confirmed' } })
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(1)
    await harness.close()
  })

  it('retains a Workspace-observed Intent when reinspection is unavailable and resumes it', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'observed-unavailable')
    const harness = await start(durable)
    const selection = await inspected(harness, repo)
    const request = intent(
      'intent-72727272-7272-4272-8272-727272727272',
      'Observed unavailable',
      repo,
      0,
      selection,
    )
    const originalInspect = harness.ctx.sakiHostExecution.inspectProjectSelection
      .bind(harness.ctx.sakiHostExecution)
    let inspections = 0
    vi.spyOn(harness.ctx.sakiHostExecution, 'inspectProjectSelection')
      .mockImplementation(async (input, signal) => {
        inspections += 1
        if (inspections === 3) return { ok: false, reason: 'unavailable' }
        return await originalInspect(input, signal)
      })
    const create = vi.spyOn(harness.ctx.workspaceRegistry, 'create')

    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toMatchObject({ ok: false, reason: 'unavailable', receipt: { state: 'prepared' } })
    expect(liveSakiDomain(harness.ctx).table('registration_intents').get(request.intentId))
      .toMatchObject({ phase: 'workspace-observed' })
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(1)

    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toMatchObject({ ok: true, receipt: { state: 'confirmed' } })
    expect(create).toHaveBeenCalledTimes(1)
    await harness.close()
  })

  it('preserves non-whitespace Project titles exactly and rejects whitespace-only content', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'title')
    const harness = await start(durable)
    const selection = await inspected(harness, repo)
    const exactTitle = '  👩‍💻  '
    const request = intent(
      'intent-88888888-8888-4888-8888-888888888888',
      exactTitle,
      repo,
      0,
      selection,
    )
    const result = await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )
    expect(result.ok).toBe(true)
    expect(harness.ctx.workspaceRegistry.list()[0]?.title).toBe(exactTitle)
    const index = await harness.control.query(
      harness.authentication,
      { type: 'project-index' },
      new AbortController().signal,
    )
    expect(index.ok && index.projection.type === 'project-index'
      ? index.projection.projects[0]?.projectTitle
      : undefined).toBe(exactTitle)
    await expect(harness.control.submit(harness.authentication, {
      ...request,
      intentId: 'intent-99999999-9999-4999-8999-999999999999' as SakiControlIntentId,
      projectTitle: ' \t\n ',
      expectedRegistryRevision: 1,
    }, new AbortController().signal)).rejects.toThrow()
    await harness.close()
  })

  it('retains historical storage-generation attribution without granting it current authority', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'historical-attribution')
    const initialHarness = await start(durable)
    const request = intent(
      'intent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'Historical attribution',
      repo,
      0,
      await inspected(initialHarness, repo),
    )
    const intents = liveSakiDomain(initialHarness.ctx).table('registration_intents')
    const put = intents.put.bind(intents)
    vi.spyOn(intents, 'put').mockImplementationOnce(async (key, value) => {
      await put(key, value)
      throw new Error('simulated response loss after prepared Intent')
    })
    await expect(initialHarness.control.submit(
      initialHarness.authentication,
      request,
      new AbortController().signal,
    )).rejects.toThrow('simulated response loss')
    expect(intents.get(request.intentId)?.payload.actor.storageGenerationId)
      .toBe(TEST_SAKI_INSTALLATION_STATE.storageGenerationId)
    await initialHarness.close()

    await editSaki(durable, async (domain) => {
      await domain.table('registration_intents').update(request.intentId, (current) => {
        const payload = {
          ...current.payload,
          actor: { ...current.payload.actor, storageGenerationId: HISTORICAL_STORAGE_GENERATION_ID },
        }
        return registrationIntentRecordSchema.parse({
          ...current,
          revision: current.revision + 1,
          payload,
          payloadDigest: canonicalDigest('saki/register-development-project/v1', payload),
          updatedAt: current.updatedAt + 1,
        })
      })
    })

    const recovered = await context(durable)
    const inspect = vi.spyOn(recovered.sakiHostExecution, 'inspectProjectSelection')
    const create = vi.spyOn(recovered.workspaceRegistry, 'create')
    const fiber = await recovered.plugin(SakiControlPlane, CONTROL_CONFIG)
    try {
      expect(liveSakiDomain(recovered).table('registration_intents').get(request.intentId)).toMatchObject({
        phase: 'failure',
        terminalReason: 'authority',
        payload: { actor: { storageGenerationId: HISTORICAL_STORAGE_GENERATION_ID } },
      })
      expect(inspect).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()
    } finally {
      await fiber.dispose()
      await recovered.fiber.dispose()
    }
  })

  it('rejects each inconsistent Resource Binding relation at the durable schema', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'binding-schema-relations')
    const harness = await start(durable)
    const request = intent(
      'intent-b0b0b0b0-b0b0-40b0-80b0-b0b0b0b0b0b0',
      'Binding schema relations',
      repo,
      0,
      await inspected(harness, repo),
    )
    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toMatchObject({ ok: true })
    const binding = liveSakiDomain(harness.ctx).table('development_project_registry')
      .get('development-project-registry')?.resourceBindings[0]
    if (binding === undefined || binding.currentInspection === undefined) {
      throw new Error('registered Binding fixture is incomplete')
    }
    const otherHost = 'host-b0b0b0b0-b0b0-40b0-80b0-b0b0b0b0b0b1' as SakiHostId
    const otherWorkspace = WorkspaceId('workspace-other')
    const alternateBaseline = SAKI_PROJECT_PROJECTION_FIXTURES.dirtySelection.baseline
    const mutations: readonly [string, (candidate: ResourceBindingRecord) => void][] = [
      ['binding observation predates creation', (candidate) => { candidate.observedAt = candidate.createdAt - 1 }],
      ['binding inspection belongs to another Host', (candidate) => {
        const inspection = candidate.registrationInspection
        const { fingerprint: _fingerprint, ...projection } = inspection.projection
        candidate.registrationInspection = signedInspection({ ...projection, hostId: otherHost }, inspection.trusted)
      }],
      ['binding inspection belongs to another Host', (candidate) => {
        const inspection = candidate.currentInspection!
        const { fingerprint: _fingerprint, ...projection } = inspection.projection
        candidate.currentInspection = signedInspection({ ...projection, hostId: otherHost }, inspection.trusted)
      }],
      ['binding inherited baseline differs from registration evidence', (candidate) => {
        candidate.inheritedChangeBaseline = alternateBaseline
      }],
      ['active binding has no current inspection', (candidate) => { delete candidate.currentInspection }],
      ['missing binding retains a current inspection', (candidate) => { candidate.health = 'missing' }],
      ['binding current inspection disagrees with Workspace identity', (candidate) => {
        const inspection = candidate.currentInspection!
        const { fingerprint: _fingerprint, workspaceId: _workspaceId, ...projection } = inspection.projection
        candidate.currentInspection = signedInspection(projection, inspection.trusted)
      }],
      ['binding current inspection disagrees with Workspace identity', (candidate) => {
        const inspection = candidate.currentInspection!
        const { fingerprint: _fingerprint, ...projection } = inspection.projection
        candidate.currentInspection = signedInspection({ ...projection, workspaceId: otherWorkspace }, inspection.trusted)
      }],
      ['binding current inspection changed resource identity', (candidate) => {
        const inspection = candidate.currentInspection!
        const { fingerprint: _fingerprint, ...projection } = inspection.projection
        const trusted = { ...inspection.trusted, canonicalWorktreePath: join(durable.root, 'other-worktree') }
        candidate.currentInspection = signedInspection(projection, trusted)
      }],
      ['binding current inspection changed resource identity', (candidate) => {
        const inspection = candidate.currentInspection!
        const { fingerprint: _fingerprint, ...projection } = inspection.projection
        const trusted = { ...inspection.trusted, canonicalGitDirectory: join(durable.root, 'other-git-directory') }
        candidate.currentInspection = signedInspection(projection, trusted)
      }],
      ['binding current inspection changed resource identity', (candidate) => {
        const inspection = candidate.currentInspection!
        const { fingerprint: _fingerprint, ...projection } = inspection.projection
        const trusted = {
          ...inspection.trusted,
          gitDirectoryIdentity: { version: 1 as const, digest: 'e'.repeat(64) },
        }
        candidate.currentInspection = signedInspection(projection, trusted)
      }],
      ['binding current inspection changed resource identity', (candidate) => {
        const inspection = candidate.currentInspection!
        const { fingerprint: _fingerprint, ...projection } = inspection.projection
        const trusted = {
          ...inspection.trusted,
          commonGitDirectoryIdentity: { version: 1 as const, digest: 'f'.repeat(64) },
        }
        candidate.currentInspection = signedInspection(projection, trusted)
      }],
    ]
    for (const [message, mutate] of mutations) {
      const candidate = structuredClone(binding)
      mutate(candidate)
      const parsed = resourceBindingRecordSchema.safeParse(candidate)
      expect(parsed.success, message).toBe(false)
      if (!parsed.success) expect(parsed.error.issues.map(issue => issue.message)).toContain(message)
    }
    await harness.close()
  })

  it('rejects each inconsistent registration Intent relation at the durable schema', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'intent-schema-relations')
    const harness = await start(durable)
    const request = intent(
      'intent-b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1',
      'Intent schema relations',
      repo,
      0,
      await inspected(harness, repo),
    )
    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toMatchObject({ ok: true })
    const confirmed = liveSakiDomain(harness.ctx).table('registration_intents').get(request.intentId)
    if (confirmed === undefined || confirmed.workspaceId === undefined
      || confirmed.workspaceInspection === undefined) {
      throw new Error('confirmed Intent fixture is incomplete')
    }
    const otherHost = 'host-b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b2' as SakiHostId
    const otherWorkspace = WorkspaceId('workspace-other')
    const alternateBaseline = SAKI_PROJECT_PROJECTION_FIXTURES.dirtySelection.baseline
    const refreshPayloadDigest = (candidate: RegistrationIntentRecord): void => {
      candidate.payloadDigest = canonicalDigest('saki/register-development-project/v1', candidate.payload)
    }
    const mutations: readonly [string, (candidate: RegistrationIntentRecord) => void][] = [
      ['Intent update predates creation', (candidate) => { candidate.updatedAt = candidate.createdAt - 1 }],
      ['Intent terminal reason disagrees with phase', (candidate) => { candidate.terminalReason = 'authority' }],
      ['Intent terminal reason disagrees with phase', (candidate) => {
        candidate.phase = 'failure'
        delete candidate.terminalReason
        clearRegistrationCommit(candidate)
        clearRegistrationWorkspace(candidate)
      }],
      ['Intent id disagrees with immutable payload', (candidate) => {
        candidate.id = 'intent-b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b3' as SakiControlIntentId
      }],
      ['receipt id disagrees with Intent id', (candidate) => {
        candidate.receiptId = 'receipt-b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b3' as typeof candidate.receiptId
      }],
      ['registration actor belongs to another Host', (candidate) => {
        candidate.payload.actor.hostId = otherHost
        refreshPayloadDigest(candidate)
      }],
      ['Intent confirmation disagrees with retained inspection', (candidate) => {
        const inspection = candidate.inspection
        const { fingerprint: _fingerprint, ...projection } = inspection.projection
        candidate.inspection = signedInspection({ ...projection, hostId: otherHost }, inspection.trusted)
      }],
      ['Intent confirmation disagrees with retained inspection', (candidate) => {
        candidate.payload.intent.confirmedFingerprint = {
          version: 2,
          digest: canonicalDigest('saki/test/alternate-fingerprint/v1', { id: candidate.id }),
        }
        refreshPayloadDigest(candidate)
      }],
      ['Intent confirmation disagrees with retained inspection', (candidate) => {
        candidate.payload.intent.confirmedBaseline = alternateBaseline
        refreshPayloadDigest(candidate)
      }],
      ['Intent payload digest is stale', (candidate) => {
        candidate.payload.intent.projectTitle = 'Changed without refreshing the digest'
      }],
      ['Workspace inspection has no retained identity', (candidate) => {
        candidate.phase = 'workspace-dispatching'
        clearRegistrationCommit(candidate)
        delete candidate.workspaceId
      }],
      ['Workspace observation disagrees with retained identity', (candidate) => {
        const inspection = candidate.workspaceInspection!
        const { fingerprint: _fingerprint, ...projection } = inspection.projection
        candidate.workspaceInspection = signedInspection({ ...projection, hostId: otherHost }, inspection.trusted)
      }],
      ['Workspace observation disagrees with retained identity', (candidate) => {
        const inspection = candidate.workspaceInspection!
        const { fingerprint: _fingerprint, workspaceId: _workspaceId, ...projection } = inspection.projection
        candidate.workspaceInspection = signedInspection(projection, inspection.trusted)
      }],
      ['Workspace observation disagrees with retained identity', (candidate) => {
        const inspection = candidate.workspaceInspection!
        const { fingerprint: _fingerprint, ...projection } = inspection.projection
        candidate.workspaceInspection = signedInspection(
          { ...projection, workspaceId: otherWorkspace },
          inspection.trusted,
        )
      }],
      ['Existing Workspace identity changed during registration', (candidate) => {
        const inspection = candidate.inspection
        const { fingerprint: _fingerprint, ...projection } = inspection.projection
        candidate.inspection = signedInspection(
          { ...projection, workspaceId: otherWorkspace },
          inspection.trusted,
        )
        candidate.payload.intent.confirmedFingerprint = candidate.inspection.projection.fingerprint
        refreshPayloadDigest(candidate)
      }],
      ['Workspace observation changed repository evidence', (candidate) => {
        const inspection = candidate.workspaceInspection!
        const { fingerprint: _fingerprint, ...projection } = inspection.projection
        candidate.workspaceInspection = signedInspection(projection, {
          ...inspection.trusted,
          canonicalGitDirectory: join(durable.root, 'changed-git-directory'),
        })
      }],
      ['registry commit fields must appear together', (candidate) => { delete candidate.resourceBindingId }],
      ['early Intent phase contains later-phase evidence', (candidate) => { candidate.phase = 'prepared' }],
      ['workspace-observed phase evidence is incomplete', (candidate) => {
        candidate.phase = 'workspace-observed'
        clearRegistrationCommit(candidate)
        delete candidate.workspaceId
      }],
      ['workspace-observed phase evidence is incomplete', (candidate) => {
        candidate.phase = 'workspace-observed'
      }],
      ['committed Intent phase evidence is incomplete', (candidate) => { delete candidate.workspaceId }],
      ['committed Intent phase evidence is incomplete', (candidate) => { delete candidate.workspaceInspection }],
      ['terminal Intent contains registry commit evidence', (candidate) => {
        candidate.phase = 'conflict'
        candidate.terminalReason = 'expected-revision'
      }],
      ['Intent commit revision disagrees with expected revision', (candidate) => {
        candidate.registryRevision = candidate.payload.intent.expectedRegistryRevision + 2
      }],
      ['conflict phase has an invalid terminal reason', (candidate) => {
        candidate.phase = 'conflict'
        candidate.terminalReason = 'authority'
        clearRegistrationCommit(candidate)
      }],
      ['conflict phase has no Workspace evidence', (candidate) => {
        candidate.phase = 'conflict'
        candidate.terminalReason = 'expected-revision'
        clearRegistrationCommit(candidate)
        clearRegistrationWorkspace(candidate)
      }],
      ['failure phase has an invalid terminal reason', (candidate) => {
        candidate.phase = 'failure'
        candidate.terminalReason = 'workspace'
        clearRegistrationCommit(candidate)
        clearRegistrationWorkspace(candidate)
      }],
      ['authority failure contains Workspace evidence', (candidate) => {
        candidate.phase = 'failure'
        candidate.terminalReason = 'authority'
        clearRegistrationCommit(candidate)
      }],
      ['reconciliation phase has an invalid terminal reason', (candidate) => {
        candidate.phase = 'reconciliation-required'
        candidate.terminalReason = 'authority'
        clearRegistrationCommit(candidate)
        clearRegistrationWorkspace(candidate)
      }],
    ]
    for (const [message, mutate] of mutations) {
      const candidate = structuredClone(confirmed)
      mutate(candidate)
      const parsed = registrationIntentRecordSchema.safeParse(candidate)
      expect(parsed.success, message).toBe(false)
      if (!parsed.success) expect(parsed.error.issues.map(issue => issue.message)).toContain(message)
    }
    await harness.close()
  })

  it('rejects hostile Project Registry and Intent graph mutations before recovery or revalidation', async () => {
    const durable = await paths()
    const firstRepo = await repository(durable.root, 'registry-graph-first')
    const secondRepo = await repository(durable.root, 'registry-graph-second')
    const harness = await start(durable)
    const firstRequest = intent(
      'intent-b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2',
      'Registry graph first',
      firstRepo,
      0,
      await inspected(harness, firstRepo),
    )
    const secondRequest = intent(
      'intent-b3b3b3b3-b3b3-43b3-83b3-b3b3b3b3b3b3',
      'Registry graph second',
      secondRepo,
      1,
      await inspected(harness, secondRepo),
    )
    expect(await harness.control.submit(
      harness.authentication,
      firstRequest,
      new AbortController().signal,
    )).toMatchObject({ ok: true })
    expect(await harness.control.submit(
      harness.authentication,
      secondRequest,
      new AbortController().signal,
    )).toMatchObject({ ok: true })
    const registryTable = liveSakiDomain(harness.ctx).table('development_project_registry')
    const intentTable = liveSakiDomain(harness.ctx).table('registration_intents')
    const registry = registryTable.get('development-project-registry')
    if (registry === undefined || registry.projects.length !== 2
      || registry.resourceBindings.length !== 2 || registry.intentMappings.length !== 2) {
      throw new Error('two-Project Registry fixture is incomplete')
    }
    const firstIntent = intentTable.get(firstRequest.intentId)
    const secondIntent = intentTable.get(secondRequest.intentId)
    if (firstIntent === undefined || secondIntent === undefined) {
      throw new Error('two-Intent Registry fixture is incomplete')
    }
    const projects = new DevelopmentProjects({
      registryTable,
      intentTable,
      execution: harness.ctx.sakiHostExecution,
      workspaces: harness.ctx.workspaceRegistry,
      authorityCurrent: () => true,
      validateActorReference: () => {},
      defaultAgentProfileTemplate: DEFAULT_AGENT_PROFILE_TEMPLATE,
    })
    const missingProjectId = 'project-b4b4b4b4-b4b4-44b4-84b4-b4b4b4b4b4b4' as typeof registry.projects[number]['id']
    const missingAgentProfileId = 'agent-profile-b4b4b4b4-b4b4-44b4-84b4-b4b4b4b4b4b4' as typeof registry.agentProfiles[number]['id']
    const missingBindingId = 'binding-b4b4b4b4-b4b4-44b4-84b4-b4b4b4b4b4b4' as typeof registry.resourceBindings[number]['id']
    const missingHostId = 'host-b4b4b4b4-b4b4-44b4-84b4-b4b4b4b4b4b4' as SakiHostId
    const mutations: readonly [string, (candidate: DevelopmentProjectRegistryRecord) => void][] = [
      ['Saki registry repeats Project identity', (candidate) => {
        candidate.projects.push(structuredClone(candidate.projects[0]!))
      }],
      ['Saki registry repeats Agent Profile identity', (candidate) => {
        candidate.agentProfiles.push(structuredClone(candidate.agentProfiles[0]!))
      }],
      ['Saki registry repeats Resource Binding identity', (candidate) => {
        candidate.resourceBindings.push(structuredClone(candidate.resourceBindings[0]!))
      }],
      ['Saki registry repeats Workspace identity', (candidate) => {
        const first = candidate.resourceBindings[0]!
        const second = candidate.resourceBindings[1]!
        second.workspaceId = first.workspaceId
        const inspection = second.currentInspection!
        const { fingerprint: _fingerprint, ...projection } = inspection.projection
        second.currentInspection = signedInspection(
          { ...projection, workspaceId: first.workspaceId },
          inspection.trusted,
        )
      }],
      ['Saki registry repeats Project-to-Binding reference identity', (candidate) => {
        candidate.projects[1]!.resourceBindingId = candidate.projects[0]!.resourceBindingId
      }],
      ['Saki registry repeats Binding-to-Project reference identity', (candidate) => {
        candidate.resourceBindings[1]!.projectId = candidate.resourceBindings[0]!.projectId
      }],
      ['Saki registry repeats canonical worktree identity', (candidate) => {
        candidate.canonicalWorktreeIndex[1]!.path = candidate.canonicalWorktreeIndex[0]!.path
      }],
      ['Saki registry repeats per-worktree Git directory identity', (candidate) => {
        candidate.gitDirectoryIndex[1]!.path = candidate.gitDirectoryIndex[0]!.path
      }],
      ['Saki registry repeats registration Intent mapping identity', (candidate) => {
        candidate.intentMappings[1]!.intentId = candidate.intentMappings[0]!.intentId
      }],
      ['Saki registry repeats mapped Project identity', (candidate) => {
        candidate.intentMappings[1]!.projectId = candidate.intentMappings[0]!.projectId
      }],
      ['Saki registry repeats mapped Resource Binding identity', (candidate) => {
        candidate.intentMappings[1]!.resourceBindingId = candidate.intentMappings[0]!.resourceBindingId
      }],
      ['Saki registry repeats mapping commit revision identity', (candidate) => {
        candidate.intentMappings[1]!.registryRevision = candidate.intentMappings[0]!.registryRevision
      }],
      ['Saki Project Registry child and index cardinalities disagree', (candidate) => {
        candidate.resourceBindings.pop()
      }],
      ['Saki Project Registry child and index cardinalities disagree', (candidate) => {
        candidate.canonicalWorktreeIndex.pop()
      }],
      ['Saki Project Registry child and index cardinalities disagree', (candidate) => {
        candidate.gitDirectoryIndex.pop()
      }],
      ['Saki Project Registry child and index cardinalities disagree', (candidate) => {
        candidate.intentMappings.pop()
      }],
      ['has an inconsistent Resource Binding', (candidate) => {
        candidate.projects[0]!.resourceBindingId = missingBindingId
      }],
      ['has an inconsistent Resource Binding', (candidate) => {
        const left = candidate.projects[0]!.resourceBindingId
        candidate.projects[0]!.resourceBindingId = candidate.projects[1]!.resourceBindingId
        candidate.projects[1]!.resourceBindingId = left
      }],
      ['has an inconsistent default Agent Profile', (candidate) => {
        candidate.projects[0]!.defaultAgentProfileId = missingAgentProfileId
      }],
      ['belongs to an unknown Project', (candidate) => {
        candidate.agentProfiles.push({
          ...structuredClone(candidate.agentProfiles[0]!),
          id: missingAgentProfileId,
          projectId: missingProjectId,
        })
      }],
      ['has inconsistent path indices', (candidate) => {
        candidate.canonicalWorktreeIndex[0]!.path = join(durable.root, 'wrong-worktree')
      }],
      ['has inconsistent path indices', (candidate) => {
        candidate.gitDirectoryIndex[0]!.path = join(durable.root, 'wrong-git-directory')
      }],
      ['has inconsistent path indices', (candidate) => {
        candidate.canonicalWorktreeIndex[0]!.hostId = missingHostId
      }],
      ['has inconsistent path indices', (candidate) => {
        candidate.gitDirectoryIndex[0]!.hostId = missingHostId
      }],
      ['maps to inconsistent children', (candidate) => {
        candidate.intentMappings[0]!.projectId = missingProjectId
      }],
      ['maps to inconsistent children', (candidate) => {
        candidate.intentMappings[0]!.resourceBindingId = missingBindingId
      }],
      ['maps to inconsistent children', (candidate) => {
        const left = candidate.intentMappings[0]!.resourceBindingId
        candidate.intentMappings[0]!.resourceBindingId = candidate.intentMappings[1]!.resourceBindingId
        candidate.intentMappings[1]!.resourceBindingId = left
      }],
      ['maps to inconsistent children', (candidate) => {
        candidate.intentMappings[0]!.registryRevision = candidate.revision + 1
      }],
    ]
    for (const [message, mutate] of mutations) {
      const candidate = structuredClone(registry)
      mutate(candidate)
      await registryTable.put('development-project-registry', candidate)
      expect(() => projects.validateDurableState(), message).toThrow(message)
    }
    const otherHost = 'host-b4b4b4b4-b4b4-44b4-84b4-b4b4b4b4b4b5' as SakiHostId
    const otherWorkspace = WorkspaceId('workspace-registry-graph-other')
    const crossMutations: readonly [
      string,
      (
        candidateRegistry: DevelopmentProjectRegistryRecord,
        candidateIntents: RegistrationIntentRecord[],
      ) => void,
    ][] = [
      ['has no Intent', (_candidateRegistry, candidateIntents) => { candidateIntents.shift() }],
      ['must not retain a mapping', (_candidateRegistry, candidateIntents) => {
        const candidate = candidateIntents[0]!
        candidate.phase = 'conflict'
        candidate.terminalReason = 'expected-revision'
        clearRegistrationCommit(candidate)
      }],
      ['maps before its Workspace observation', (_candidateRegistry, candidateIntents) => {
        const candidate = candidateIntents[0]!
        candidate.phase = 'workspace-dispatching'
        clearRegistrationCommit(candidate)
        clearRegistrationWorkspace(candidate)
      }],
      ['has an invalid commit revision', (candidateRegistry) => {
        candidateRegistry.intentMappings[0]!.registryRevision = 0
      }],
      ['disagrees with its committed children', (candidateRegistry) => {
        candidateRegistry.projects[0]!.projectTitle = 'Hostile title replacement'
      }],
      ['disagrees with its committed children', (candidateRegistry) => {
        candidateRegistry.projects[0]!.revision += 1
      }],
      ['disagrees with its committed children', (candidateRegistry) => {
        const binding = candidateRegistry.resourceBindings[0]!
        binding.hostId = otherHost
        const registration = binding.registrationInspection
        const { fingerprint: _registrationFingerprint, ...registrationProjection } = registration.projection
        binding.registrationInspection = signedInspection(
          { ...registrationProjection, hostId: otherHost },
          registration.trusted,
        )
        const current = binding.currentInspection!
        const { fingerprint: _currentFingerprint, ...currentProjection } = current.projection
        binding.currentInspection = signedInspection(
          { ...currentProjection, hostId: otherHost },
          current.trusted,
        )
        candidateRegistry.canonicalWorktreeIndex.find(entry =>
          entry.resourceBindingId === binding.id)!.hostId = otherHost
        candidateRegistry.gitDirectoryIndex.find(entry =>
          entry.resourceBindingId === binding.id)!.hostId = otherHost
      }],
      ['disagrees with its committed children', (candidateRegistry) => {
        const binding = candidateRegistry.resourceBindings[0]!
        binding.workspaceId = otherWorkspace
        const current = binding.currentInspection!
        const { fingerprint: _fingerprint, ...projection } = current.projection
        binding.currentInspection = signedInspection(
          { ...projection, workspaceId: otherWorkspace },
          current.trusted,
        )
      }],
      ['disagrees with its committed children', (candidateRegistry) => {
        const binding = candidateRegistry.resourceBindings[0]!
        const registration = binding.registrationInspection
        const { fingerprint: _fingerprint, ...projection } = registration.projection
        binding.registrationInspection = signedInspection({
          ...projection,
          displayLocation: `${projection.displayLocation}-changed`,
        }, registration.trusted)
      }],
      ['disagrees with its committed children', (candidateRegistry) => {
        const binding = candidateRegistry.resourceBindings[0]!
        const baseline = binding.inheritedChangeBaseline
        if (baseline.kind !== 'complete') throw new Error('expected a complete registration baseline')
        binding.inheritedChangeBaseline = { ...baseline, capturedAt: baseline.capturedAt + 1 }
      }],
      ['has invalid initial binding evidence', (candidateRegistry, candidateIntents) => {
        candidateIntents[0]!.phase = 'registry-committed'
        candidateRegistry.resourceBindings[0]!.revision += 1
      }],
      ['has invalid initial binding evidence', (candidateRegistry, candidateIntents) => {
        candidateIntents[0]!.phase = 'registry-committed'
        const binding = candidateRegistry.resourceBindings[0]!
        binding.health = 'missing'
        delete binding.currentInspection
      }],
      ['has invalid initial binding evidence', (candidateRegistry, candidateIntents) => {
        candidateIntents[0]!.phase = 'registry-committed'
        const binding = candidateRegistry.resourceBindings[0]!
        const current = binding.currentInspection!
        const { fingerprint: _fingerprint, ...projection } = current.projection
        binding.currentInspection = signedInspection({
          ...projection,
          displayLocation: `${projection.displayLocation}-changed`,
        }, current.trusted)
      }],
      ['has invalid initial binding evidence', (_candidateRegistry, candidateIntents) => {
        const candidate = candidateIntents[0]!
        candidate.phase = 'workspace-observed'
        delete candidate.workspaceInspection
        clearRegistrationCommit(candidate)
      }],
      ['disagrees with its initial current inspection', (candidateRegistry) => {
        const binding = candidateRegistry.resourceBindings[0]!
        const current = binding.currentInspection!
        const { fingerprint: _fingerprint, ...projection } = current.projection
        binding.currentInspection = signedInspection({
          ...projection,
          displayLocation: `${projection.displayLocation}-changed`,
        }, current.trusted)
      }],
      ['has an unreachable binding revision', (candidateRegistry) => {
        candidateRegistry.resourceBindings[0]!.revision = candidateRegistry.revision
      }],
      ['disagrees with its commit mapping', (_candidateRegistry, candidateIntents) => {
        candidateIntents[0]!.projectId = missingProjectId
      }],
      ['disagrees with its commit mapping', (_candidateRegistry, candidateIntents) => {
        candidateIntents[0]!.resourceBindingId = missingBindingId
      }],
      ['has no mapping', (candidateRegistry) => {
        const mapping = candidateRegistry.intentMappings.shift()!
        candidateRegistry.projects = candidateRegistry.projects.filter(project => project.id !== mapping.projectId)
        candidateRegistry.agentProfiles = candidateRegistry.agentProfiles
          .filter(profile => profile.projectId !== mapping.projectId)
        candidateRegistry.resourceBindings = candidateRegistry.resourceBindings
          .filter(binding => binding.id !== mapping.resourceBindingId)
        candidateRegistry.canonicalWorktreeIndex = candidateRegistry.canonicalWorktreeIndex
          .filter(entry => entry.resourceBindingId !== mapping.resourceBindingId)
        candidateRegistry.gitDirectoryIndex = candidateRegistry.gitDirectoryIndex
          .filter(entry => entry.resourceBindingId !== mapping.resourceBindingId)
      }],
    ]
    for (const [message, mutate] of crossMutations) {
      const candidateRegistry = structuredClone(registry)
      const candidateIntents = structuredClone([firstIntent, secondIntent])
      mutate(candidateRegistry, candidateIntents)
      await registryTable.put('development-project-registry', candidateRegistry)
      for (const [intentId] of intentTable.entries()) await intentTable.delete(intentId)
      for (const candidate of candidateIntents) await intentTable.put(candidate.id, candidate)
      expect(() => projects.validateDurableState(), message).toThrow(message)
    }
    await registryTable.put('development-project-registry', registry)
    for (const [intentId] of intentTable.entries()) await intentTable.delete(intentId)
    await intentTable.put(firstIntent.id, firstIntent)
    await intentTable.put(secondIntent.id, secondIntent)
    const otherRegistryKey = 'other-development-project-registry' as 'development-project-registry'
    await registryTable.put(otherRegistryKey, registry)
    expect(() => projects.validateDurableState()).toThrow('invalid singleton key')
    await registryTable.delete('development-project-registry')
    expect(() => projects.validateDurableState()).toThrow('invalid singleton key')
    await registryTable.delete(otherRegistryKey)
    expect(() => projects.registry()).toThrow('Project Registry is absent')
    expect(() => projects.validateDurableState()).toThrow('Intents exist without the Project Registry')
    await registryTable.put('development-project-registry', registry)

    const otherIntentKey = 'intent-b5b5b5b5-b5b5-45b5-85b5-b5b5b5b5b5b5' as SakiControlIntentId
    await intentTable.delete(firstIntent.id)
    await intentTable.put(otherIntentKey, firstIntent)
    expect(() => projects.validateDurableState()).toThrow('Intent id disagrees with its table key')
    await intentTable.delete(otherIntentKey)
    const tiedFirst = {
      ...firstIntent,
      createdAt: secondIntent.createdAt,
      updatedAt: Math.max(firstIntent.updatedAt, secondIntent.createdAt),
    }
    const tiedSecond = { ...secondIntent, createdAt: secondIntent.createdAt }
    await intentTable.delete(secondIntent.id)
    await intentTable.put(tiedSecond.id, tiedSecond)
    await intentTable.put(tiedFirst.id, tiedFirst)
    expect(projects.validateDurableState().intents.map(candidate => candidate.id)).toEqual([
      firstIntent.id,
      secondIntent.id,
    ])
    await intentTable.put(firstIntent.id, firstIntent)
    await intentTable.put(secondIntent.id, secondIntent)

    const replayed = await projects.register(
      firstRequest,
      firstIntent.payload.actor,
      firstIntent.inspection,
      new AbortController().signal,
    )
    expect(replayed).toMatchObject({ ok: true, receipt: { intentId: firstRequest.intentId } })
    expect(await projects.register(
      { ...firstRequest, projectTitle: 'Changed replay content' },
      firstIntent.payload.actor,
      firstIntent.inspection,
      new AbortController().signal,
    )).toEqual({ ok: false, reason: 'conflict' })
    expect(projects.validateDurableState().registry).toEqual(registry)
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(2)
    await harness.close()
  })

  it('recovers every retained pre-commit phase from fresh Host and Workspace evidence', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'retained-phase-evidence')
    const harness = await start(durable)
    const request = intent(
      'intent-20202020-2020-4020-8020-202020202020',
      'Retained phase evidence',
      repo,
      0,
      await inspected(harness, repo),
    )
    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toMatchObject({ ok: true })
    const registryTable = liveSakiDomain(harness.ctx).table('development_project_registry')
    const intentTable = liveSakiDomain(harness.ctx).table('registration_intents')
    const confirmedRegistry = registryTable.get('development-project-registry')
    const confirmed = intentTable.get(request.intentId)
    if (confirmedRegistry === undefined || confirmed === undefined
      || confirmed.workspaceInspection === undefined || confirmed.workspaceId === undefined) {
      throw new Error('confirmed registration fixture is incomplete')
    }
    const emptyRegistry: DevelopmentProjectRegistryRecord = {
      ...structuredClone(confirmedRegistry),
      revision: 0,
      projects: [],
      agentProfiles: [],
      resourceBindings: [],
      canonicalWorktreeIndex: [],
      gitDirectoryIndex: [],
      intentMappings: [],
    }
    const earlyRecord = (
      phase: 'prepared' | 'workspace-dispatching',
      inspection = confirmed.inspection,
      incoming = confirmed.payload.intent,
    ): RegistrationIntentRecord => {
      const candidate = structuredClone(confirmed)
      candidate.phase = phase
      candidate.inspection = inspection
      candidate.payload = { intent: incoming, actor: candidate.payload.actor }
      candidate.payloadDigest = canonicalDigest('saki/register-development-project/v1', candidate.payload)
      delete candidate.terminalReason
      clearRegistrationWorkspace(candidate)
      clearRegistrationCommit(candidate)
      return registrationIntentRecordSchema.parse(candidate)
    }
    const workspaceObserved = (): RegistrationIntentRecord => {
      const candidate = structuredClone(confirmed)
      candidate.phase = 'workspace-observed'
      delete candidate.terminalReason
      clearRegistrationCommit(candidate)
      return registrationIntentRecordSchema.parse(candidate)
    }
    const retain = async (record: RegistrationIntentRecord): Promise<void> => {
      await registryTable.put('development-project-registry', structuredClone(emptyRegistry))
      await intentTable.put(record.id, record)
    }
    let authority = true
    const inspect = vi.spyOn(harness.ctx.sakiHostExecution, 'inspectProjectSelection')
    const projects = () => new DevelopmentProjects({
      registryTable,
      intentTable,
      execution: harness.ctx.sakiHostExecution,
      workspaces: harness.ctx.workspaceRegistry,
      authorityCurrent: () => authority,
      validateActorReference: () => {},
      defaultAgentProfileTemplate: DEFAULT_AGENT_PROFILE_TEMPLATE,
    })

    authority = false
    await retain(earlyRecord('prepared'))
    inspect.mockClear()
    expect(await projects().replayExisting(request, new AbortController().signal)).toMatchObject({
      ok: false,
      receipt: { state: 'failure', reason: 'authority' },
    })
    expect(inspect).not.toHaveBeenCalled()

    authority = true
    await retain(earlyRecord('prepared'))
    inspect.mockResolvedValueOnce({ ok: false, reason: 'unavailable' })
    expect(await projects().replayExisting(request, new AbortController().signal)).toMatchObject({
      ok: false,
      reason: 'unavailable',
      receipt: { state: 'prepared' },
    })

    await retain(earlyRecord('prepared'))
    inspect.mockResolvedValueOnce({ ok: false, reason: 'missing' })
    expect(await projects().replayExisting(request, new AbortController().signal)).toMatchObject({
      ok: false,
      receipt: { state: 'reconciliation-required', reason: 'observation' },
    })

    const { fingerprint: _fingerprint, ...projection } = confirmed.inspection.projection
    const changedInspection = signedInspection({
      ...projection,
      displayLocation: `${projection.displayLocation}-changed`,
    }, confirmed.inspection.trusted)
    await retain(earlyRecord('prepared'))
    inspect.mockResolvedValueOnce({ ok: true, inspection: changedInspection })
    expect(await projects().replayExisting(request, new AbortController().signal)).toMatchObject({
      ok: false,
      receipt: { state: 'reconciliation-required', reason: 'observation' },
    })

    await retain(earlyRecord('workspace-dispatching'))
    inspect.mockResolvedValueOnce({ ok: false, reason: 'not-git' })
    expect(await projects().replayExisting(request, new AbortController().signal)).toMatchObject({
      ok: false,
      receipt: { state: 'reconciliation-required', reason: 'observation' },
    })

    const selectedWorkspaceIntent = {
      ...confirmed.payload.intent,
      confirmedFingerprint: confirmed.workspaceInspection.projection.fingerprint,
      confirmedBaseline: confirmed.workspaceInspection.projection.baseline,
    }
    await retain(earlyRecord(
      'workspace-dispatching',
      confirmed.workspaceInspection,
      selectedWorkspaceIntent,
    ))
    inspect.mockResolvedValueOnce({ ok: true, inspection: confirmed.inspection })
    expect(await projects().replayExisting(
      selectedWorkspaceIntent,
      new AbortController().signal,
    )).toMatchObject({
      ok: false,
      receipt: { state: 'reconciliation-required', reason: 'workspace' },
    })

    const {
      fingerprint: _workspaceFingerprint,
      ...workspaceProjection
    } = confirmed.workspaceInspection.projection
    const unmatchedWorkspace = signedInspection({
      ...workspaceProjection,
      workspaceId: WorkspaceId('workspace-unmatched'),
    }, confirmed.workspaceInspection.trusted)
    await retain(earlyRecord('workspace-dispatching'))
    inspect.mockResolvedValueOnce({ ok: true, inspection: unmatchedWorkspace })
    expect(await projects().replayExisting(request, new AbortController().signal)).toMatchObject({
      ok: false,
      receipt: { state: 'reconciliation-required', reason: 'workspace' },
    })

    await retain(workspaceObserved())
    inspect.mockResolvedValueOnce({ ok: false, reason: 'malformed' })
    expect(await projects().replayExisting(request, new AbortController().signal)).toMatchObject({
      ok: false,
      receipt: { state: 'reconciliation-required', reason: 'observation' },
    })
    await harness.close()
  })

  it('fences competing Intent transitions and Binding revalidation writes', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'durable-writer-fencing')
    const harness = await start(durable)
    const request = intent(
      'intent-21212121-2121-4121-8121-212121212121',
      'Durable writer fencing',
      repo,
      0,
      await inspected(harness, repo),
    )
    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toMatchObject({ ok: true })
    const registryTable = liveSakiDomain(harness.ctx).table('development_project_registry')
    const intentTable = liveSakiDomain(harness.ctx).table('registration_intents')
    const confirmedRegistry = registryTable.get('development-project-registry')
    const confirmed = intentTable.get(request.intentId)
    if (confirmedRegistry === undefined || confirmed === undefined) {
      throw new Error('confirmed registration fixture is incomplete')
    }
    const emptyRegistry: DevelopmentProjectRegistryRecord = {
      ...structuredClone(confirmedRegistry),
      revision: 0,
      projects: [],
      resourceBindings: [],
      canonicalWorktreeIndex: [],
      gitDirectoryIndex: [],
      intentMappings: [],
    }
    const prepared = (): RegistrationIntentRecord => {
      const candidate = structuredClone(confirmed)
      candidate.phase = 'prepared'
      delete candidate.terminalReason
      clearRegistrationWorkspace(candidate)
      clearRegistrationCommit(candidate)
      return registrationIntentRecordSchema.parse(candidate)
    }
    const retainPrepared = async (): Promise<void> => {
      await registryTable.put('development-project-registry', structuredClone(emptyRegistry))
      await intentTable.put(request.intentId, prepared())
    }
    const aggregate = (execution: SakiHostExecution) => new DevelopmentProjects({
      registryTable,
      intentTable,
      execution,
      workspaces: harness.ctx.workspaceRegistry,
      authorityCurrent: () => true,
      validateActorReference: () => {},
      defaultAgentProfileTemplate: DEFAULT_AGENT_PROFILE_TEMPLATE,
    })
    const race = async (
      firstResult: InspectProjectSelectionResult,
      laterResult: InspectProjectSelectionResult,
    ): Promise<PromiseSettledResult<unknown>[]> => {
      const bothInspecting = Promise.withResolvers<undefined>()
      const release = Promise.withResolvers<undefined>()
      let calls = 0
      const execution = harness.ctx.sakiHostExecution
      vi.spyOn(execution, 'inspectProjectSelection').mockImplementation(async () => {
        calls += 1
        if (calls <= 2) {
          if (calls === 2) bothInspecting.resolve(undefined)
          await release.promise
          return firstResult
        }
        return laterResult
      })
      const results = Promise.allSettled([
        aggregate(execution).replayExisting(request, new AbortController().signal),
        aggregate(execution).replayExisting(request, new AbortController().signal),
      ])
      await bothInspecting.promise
      release.resolve(undefined)
      return await results
    }

    await retainPrepared()
    let results = await race(
      { ok: true, inspection: confirmed.inspection },
      { ok: false, reason: 'unavailable' },
    )
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({
      reason: { name: 'IntentCasConflict', message: 'registration Intent changed outside its serialized lifecycle' },
    })

    vi.restoreAllMocks()
    await retainPrepared()
    results = await race(
      { ok: false, reason: 'missing' },
      { ok: false, reason: 'unavailable' },
    )
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(results.find(result => result.status === 'fulfilled')).toMatchObject({
      value: { ok: false, receipt: { state: 'reconciliation-required' } },
    })

    vi.restoreAllMocks()
    await registryTable.put('development-project-registry', structuredClone(confirmedRegistry))
    await intentTable.put(request.intentId, structuredClone(confirmed))
    const revalidationExecution = harness.ctx.sakiHostExecution
    vi.spyOn(revalidationExecution, 'inspectProjectSelection').mockImplementationOnce(async () => {
      await registryTable.update('development-project-registry', (registry) => {
        const binding = registry.resourceBindings[0]
        if (binding === undefined) throw new Error('Binding fixture is absent')
        registry.revision += 1
        binding.revision += 1
        return registry
      })
      return { ok: false, reason: 'unavailable' }
    })
    const projects = aggregate(revalidationExecution)
    await expect(projects.initializeValidated(
      projects.validateDurableState(),
      new AbortController().signal,
    )).rejects.toThrow('Resource Binding changed during serialized startup revalidation')
    await harness.close()
  })

  it('commits and invalidates only one concurrent registration at an exact Registry revision', async () => {
    const durable = await paths()
    const leftRepo = await repository(durable.root, 'cas-left')
    const rightRepo = await repository(durable.root, 'cas-right')
    const harness = await start(durable)
    const left = intent(
      'intent-cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'CAS left',
      leftRepo,
      0,
      await inspected(harness, leftRepo),
    )
    const right = intent(
      'intent-dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      'CAS right',
      rightRepo,
      0,
      await inspected(harness, rightRepo),
    )
    const invalidations: {
      readonly keys: readonly string[]
      readonly registryRevision: number | undefined
      readonly projectIds: readonly string[]
    }[] = []
    const disposeInvalidation = harness.control.onChanged((keys) => {
      const registry = liveSakiDomain(harness.ctx).table('development_project_registry')
        .get('development-project-registry')
      invalidations.push({
        keys: [...keys],
        registryRevision: registry?.revision,
        projectIds: registry?.projects.map(project => project.id) ?? [],
      })
    })

    const results = await Promise.all([
      harness.control.submit(harness.authentication, left, new AbortController().signal),
      harness.control.submit(harness.authentication, right, new AbortController().signal),
    ])
    disposeInvalidation()

    const accepted = results.find(result => result.ok)
    expect(accepted).toMatchObject({ ok: true, receipt: { registryRevision: 1 } })
    if (accepted === undefined || !accepted.ok) throw new Error('concurrent registration produced no accepted result')
    const rejected = results.find(result => !result.ok)
    expect(rejected).toMatchObject({
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'expected-revision' },
    })
    expect(invalidations).toEqual([
      {
        keys: ['my-work', 'attention', 'project-index', 'development-workspace', 'project-changes'],
        registryRevision: 1,
        projectIds: [accepted.receipt.projectId],
      },
      {
        keys: ['my-work', 'project-changes'],
        registryRevision: 1,
        projectIds: [accepted.receipt.projectId],
      },
    ])
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(2)
    const index = await harness.control.query(
      harness.authentication,
      { type: 'project-index' },
      new AbortController().signal,
    )
    expect(index.ok && index.projection.type === 'project-index'
      ? index.projection.projects
      : []).toHaveLength(1)
    await harness.close()
  })

  it('rejects an operator-confirmed Workspace identity after it disappears or is replaced', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'workspace-confirmation')
    const harness = await start(durable)
    const original = await harness.ctx.workspaceRegistry.create(repo, 'Original Workspace')
    const selection = await inspected(harness, repo)
    const request = intent(
      'intent-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      'Workspace confirmation',
      repo,
      0,
      selection,
    )

    expect(await harness.ctx.workspaceRegistry.delete(original.id)).toBe(true)
    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toEqual({ ok: false, reason: 'conflict' })

    const replacement = await harness.ctx.workspaceRegistry.create(repo, 'Replacement Workspace')
    expect(replacement.id).not.toBe(original.id)
    const create = vi.spyOn(harness.ctx.workspaceRegistry, 'create')
    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toEqual({ ok: false, reason: 'conflict' })
    expect(create).not.toHaveBeenCalled()
    await harness.close()
  })

  it('adopts a Workspace that appears after an absent selection is durably prepared', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'concurrent-workspace')
    const harness = await start(durable)
    const selection = await inspected(harness, repo)
    const request = intent(
      'intent-ffffffff-ffff-4fff-8fff-ffffffffffff',
      'Concurrent Workspace',
      repo,
      0,
      selection,
    )
    const originalInspect = harness.ctx.sakiHostExecution.inspectProjectSelection
      .bind(harness.ctx.sakiHostExecution)
    let inspectionCount = 0
    const inspect = vi.spyOn(harness.ctx.sakiHostExecution, 'inspectProjectSelection')
      .mockImplementation(async (input, signal) => {
        inspectionCount += 1
        if (inspectionCount === 2) {
          await harness.ctx.workspaceRegistry.create(repo, 'Concurrent owner')
        }
        return await originalInspect(input, signal)
      })

    const result = await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )

    expect(result).toMatchObject({ ok: true, receipt: { state: 'confirmed', registryRevision: 1 } })
    expect(inspect).toHaveBeenCalledTimes(3)
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(1)
    await harness.close()
  })

  it('retains the Workspace identity when repository evidence changes after create', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'post-effect-change')
    const harness = await start(durable)
    const selection = await inspected(harness, repo)
    const request = intent(
      'intent-12121212-1212-4212-8212-121212121212',
      'Post-effect change',
      repo,
      0,
      selection,
    )
    const originalCreate = harness.ctx.workspaceRegistry.create.bind(harness.ctx.workspaceRegistry)
    vi.spyOn(harness.ctx.workspaceRegistry, 'create').mockImplementationOnce(async (path, title) => {
      const workspace = await originalCreate(path, title)
      await writeFile(join(repo, 'tracked.txt'), 'changed after Workspace effect\n')
      return workspace
    })

    const result = await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )
    expect(result).toMatchObject({
      ok: false,
      reason: 'reconciliation-required',
      receipt: { state: 'reconciliation-required', reason: 'observation' },
    })
    const workspaceId = harness.ctx.workspaceRegistry.list()[0]?.id
    expect(workspaceId).toBeDefined()
    await harness.close()
    await editSaki(durable, async (domain) => {
      expect(domain.table('registration_intents').get(request.intentId)).toMatchObject({
        phase: 'reconciliation-required',
        workspaceId,
        terminalReason: 'observation',
      })
      expect(domain.table('development_project_registry').get('development-project-registry')
        ?.projects).toHaveLength(0)
    })
  })

  it('aborts and drains a paused inspection before closing its durable domain', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'dispose-inspection')
    const harness = await start(durable)
    const hostId = harness.control.identity().hostId
    const observed = await harness.ctx.sakiHostExecution.inspectProjectSelection({
      hostId,
      directoryLocator: repo,
    }, new AbortController().signal)
    if (!observed.ok) throw new Error('fixture inspection failed')
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(harness.ctx.sakiHostExecution, 'inspectProjectSelection').mockImplementation(async () => {
      started.resolve(undefined)
      await release.promise
      return observed
    })
    const query = harness.control.query(harness.authentication, {
      type: 'inspect-project-selection',
      hostId,
      directoryLocator: repo,
    }, new AbortController().signal)
    await started.promise
    let disposed = false
    const closing = harness.close().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)

    release.resolve(undefined)
    await expect(query).rejects.toThrow('saki control plane is disposing')
    await closing
    expect(disposed).toBe(true)
    await expect(harness.control.query(harness.authentication, {
      type: 'project-index',
    }, new AbortController().signal)).rejects.toThrow('saki control plane is disposing')
  })

  it('persists a completed Workspace effect before disposal closes the Intent domain', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'dispose-create')
    const harness = await start(durable)
    const selection = await inspected(harness, repo)
    const request = intent(
      'intent-13131313-1313-4313-8313-131313131313',
      'Dispose create',
      repo,
      0,
      selection,
    )
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const originalCreate = harness.ctx.workspaceRegistry.create.bind(harness.ctx.workspaceRegistry)
    vi.spyOn(harness.ctx.workspaceRegistry, 'create').mockImplementationOnce(async (path, title) => {
      const workspace = await originalCreate(path, title)
      started.resolve(undefined)
      await release.promise
      return workspace
    })
    const submission = harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )
    await started.promise
    let disposed = false
    const closing = harness.close().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)

    release.resolve(undefined)
    await expect(submission).rejects.toThrow('saki control plane is disposing')
    await closing
    expect(disposed).toBe(true)
    await editSaki(durable, async (domain) => {
      expect(domain.table('registration_intents').get(request.intentId)).toMatchObject({
        phase: 'workspace-observed',
      })
    })
  })

  it('rejects an Intent admitted immediately before disposal starts its keyed operation', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'dispose-before-intent-tail')
    const harness = await start(durable)
    const request = intent(
      'intent-22222222-2222-4222-8222-222222222223',
      'Dispose before Intent tail',
      repo,
      0,
      await inspected(harness, repo),
    )

    const submission = harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )
    const closing = harness.close()

    await expect(submission).rejects.toThrow('saki control plane is disposing')
    await closing
    await editSaki(durable, async (domain) => {
      expect(domain.table('registration_intents').get(request.intentId)).toBeUndefined()
    })
  })

  it('rechecks the current Grant after initial inspection before preparing an Intent', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'grant-barrier')
    const harness = await start(durable)
    const selection = await inspected(harness, repo)
    const request = intent(
      'intent-14141414-1414-4414-8414-141414141414',
      'Grant barrier',
      repo,
      0,
      selection,
    )
    const originalInspect = harness.ctx.sakiHostExecution.inspectProjectSelection
      .bind(harness.ctx.sakiHostExecution)
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(harness.ctx.sakiHostExecution, 'inspectProjectSelection').mockImplementation(async (input, signal) => {
      started.resolve(undefined)
      await release.promise
      return await originalInspect(input, signal)
    })
    const create = vi.spyOn(harness.ctx.workspaceRegistry, 'create')
    const submission = harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )
    await started.promise
    const domain = liveSakiDomain(harness.ctx)
    const control = domain.table('control_state').get('control-state')
    if (control === undefined) throw new Error('control-state fixture is absent')
    await domain.table('grants').update(control.hostOperatorGrantId, current => ({
      ...current,
      revision: current.revision + 1,
      state: 'revoked',
    }))
    release.resolve(undefined)

    expect(await submission).toEqual({ ok: false, reason: 'denied' })
    expect(create).not.toHaveBeenCalled()
    expect(domain.table('registration_intents').size).toBe(0)
    expect(domain.table('development_project_registry').get('development-project-registry')
      ?.projects).toHaveLength(0)
    await harness.close()
  })

  it('recovers under benign Principal and Grant revision changes', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'revision-recovery')
    let harness = await start(durable)
    const request = intent(
      'intent-15151515-1515-4515-8515-151515151515',
      'Revision recovery',
      repo,
      0,
      await inspected(harness, repo),
    )
    await disposeDuringDispatchInspection(harness, request)
    await editSaki(durable, async (domain) => {
      const retained = domain.table('registration_intents').get(request.intentId)
      if (retained === undefined) throw new Error('Intent fixture is absent')
      await domain.table('principals').update(retained.payload.actor.principalId, current => ({
        ...current,
        revision: current.revision + 1,
      }))
      await domain.table('grants').update(retained.payload.actor.grantId, current => ({
        ...current,
        revision: current.revision + 1,
      }))
    })

    harness = await start(durable)
    const index = await harness.control.query(
      harness.authentication,
      { type: 'project-index' },
      new AbortController().signal,
    )
    expect(index.ok && index.projection.type === 'project-index'
      ? index.projection.projects
      : []).toHaveLength(1)
    expect(liveSakiDomain(harness.ctx).table('registration_intents').get(request.intentId))
      .toMatchObject({ phase: 'confirmed' })
    await harness.close()
  })

  it('blocks a not-yet-started Workspace effect after the retained Grant is revoked', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'revoked-recovery')
    const harness = await start(durable)
    const request = intent(
      'intent-16161616-1616-4616-8616-161616161616',
      'Revoked recovery',
      repo,
      0,
      await inspected(harness, repo),
    )
    await disposeDuringDispatchInspection(harness, request)
    await editSaki(durable, async (domain) => {
      const retained = domain.table('registration_intents').get(request.intentId)
      if (retained === undefined) throw new Error('Intent fixture is absent')
      await domain.table('grants').update(retained.payload.actor.grantId, current => ({
        ...current,
        revision: current.revision + 1,
        state: 'revoked',
      }))
    })

    const restarted = await context(durable)
    const create = vi.spyOn(restarted.workspaceRegistry, 'create')
    const controlFiber = await restarted.plugin(SakiControlPlane, CONTROL_CONFIG)
    try {
      expect(create).not.toHaveBeenCalled()
      const domain = liveSakiDomain(restarted)
      expect(domain.table('registration_intents').get(request.intentId)).toMatchObject({
        phase: 'failure',
        terminalReason: 'authority',
      })
      expect(domain.table('development_project_registry').get('development-project-registry')
        ?.projects).toHaveLength(0)
    } finally {
      await controlFiber.dispose()
      await restarted.fiber.dispose()
    }
  })

  it('adopts a possibly completed Workspace effect after the retained Grant is revoked', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'revoked-after-effect')
    const requestId = 'intent-17171717-1717-4717-8717-171717171717' as SakiControlIntentId
    const harness = await start(durable)
    const request = intent(
      requestId,
      'Revoked after effect',
      repo,
      0,
      await inspected(harness, repo),
    )
    const originalCreate = harness.ctx.workspaceRegistry.create.bind(harness.ctx.workspaceRegistry)
    vi.spyOn(harness.ctx.workspaceRegistry, 'create').mockImplementationOnce(async (path, title) => {
      await originalCreate(path, title)
      throw new Error('Workspace commit response was lost')
    })
    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toMatchObject({ ok: false, reason: 'unavailable', receipt: { state: 'prepared' } })
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(1)
    await harness.close()

    await editSaki(durable, async (domain) => {
      const retained = domain.table('registration_intents').get(requestId)
      if (retained === undefined) throw new Error('Intent fixture is absent')
      await domain.table('grants').update(retained.payload.actor.grantId, current => ({
        ...current,
        revision: current.revision + 1,
        state: 'revoked',
      }))
    })
    const restarted = await context(durable)
    const create = vi.spyOn(restarted.workspaceRegistry, 'create')
    const controlFiber = await restarted.plugin(SakiControlPlane, CONTROL_CONFIG)
    try {
      expect(create).not.toHaveBeenCalled()
      const domain = liveSakiDomain(restarted)
      expect(domain.table('registration_intents').get(requestId)).toMatchObject({ phase: 'confirmed' })
      expect(domain.table('development_project_registry').get('development-project-registry')?.projects)
        .toHaveLength(1)
    } finally {
      await controlFiber.dispose()
      await restarted.fiber.dispose()
    }
  })
})
