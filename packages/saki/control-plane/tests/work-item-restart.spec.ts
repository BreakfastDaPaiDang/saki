import { Context } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it } from 'vitest'
import {
  GitHubProviderError,
  SakiGitHub,
  githubIssueId,
  githubProjectItemAddInspectionSchema,
  githubProjectItemId,
  githubProjectItemStatusSetInspectionSchema,
  type GitHubMutationMap,
  type GitHubProjectOptionId,
  type GitHubReadMap,
  type GitHubScanMap,
  type GitHubTargetedWorkItemSnapshot,
} from '@breakfastdapaidang/saki-github'
import type {
  GitHubWorkItemIntentRecord,
  GitHubWorkItemRecoveryRecord,
} from '../src/spec.ts'
import {
  controlIntentActorSchema,
  githubSynchronizationConfigurationSchema,
} from '../src/spec.ts'
import {
  sakiControlIntentIdSchema,
  sakiDevelopmentProjectIdSchema,
} from '../src/ids.ts'
import type {
  GitHubWorkItemMutationContext,
  GitHubWorkItemMutationContextResult,
} from '../src/github-sync.ts'
import type {
  MoveWorkItemIntent,
  SakiControlIntentId,
  SakiDevelopmentProjectId,
  SakiWorkItemRecoveryId,
} from '../src/types.ts'
import {
  GitHubWorkItemOperations,
} from '../src/work-item-operations.ts'
import { boardWorkItemId, targetedBoardRemoteFingerprint } from '../src/work-item-mapping.ts'

const PROJECT_ID = sakiDevelopmentProjectIdSchema.parse('project-00000000-0000-4000-8000-000000000201')
const INTENT_ID = sakiControlIntentIdSchema.parse('intent-00000000-0000-4000-8000-000000000202')
const ISSUE_ID = githubIssueId('I_restart_issue')
const ITEM_ID = githubProjectItemId('PVTI_restart_item')
const WORK_ITEM_ID = boardWorkItemId('R_restart_repo', ISSUE_ID)

const ACTOR = controlIntentActorSchema.parse({
  installationId: 'installation-00000000-0000-4000-8000-000000000203',
  storageGenerationId: 'storage-generation-00000000-0000-4000-8000-000000000204',
  hostId: 'host-00000000-0000-4000-8000-000000000205',
  principalId: 'principal-00000000-0000-4000-8000-000000000206',
  principalRevision: 1,
  grantId: 'grant-00000000-0000-4000-8000-000000000207',
  grantRevision: 2,
})

const CONFIGURATION = githubSynchronizationConfigurationSchema.parse({
  appId: '20',
  githubInstallationId: '21',
  accountNodeId: 'A_restart_account',
  repositoryNodeId: 'R_restart_repo',
  repositoryDatabaseId: '22',
  projectNodeId: 'P_restart_project',
  credentialRef: credentialRef('SAKI_GITHUB_PRIVATE_KEY'),
  statusFieldNodeId: 'F_restart_status',
  statusOptionNodeIds: {
    inbox: 'O_restart_inbox',
    backlog: 'O_restart_backlog',
    ready: 'O_restart_ready',
    inProgress: 'O_restart_in_progress',
    inReview: 'O_restart_in_review',
    done: 'O_restart_done',
    canceled: 'O_restart_canceled',
  },
  activePollIntervalMs: 30_000,
  backgroundPollIntervalMs: 300_000,
  rateLimitReserve: 500,
})

function snapshot(statusOptionId: GitHubProjectOptionId): GitHubTargetedWorkItemSnapshot {
  return {
    repositoryId: CONFIGURATION.repositoryNodeId,
    repositoryDatabaseId: CONFIGURATION.repositoryDatabaseId,
    projectId: CONFIGURATION.projectNodeId,
    statusFieldId: CONFIGURATION.statusFieldNodeId,
    issue: {
      id: ISSUE_ID,
      repositoryId: CONFIGURATION.repositoryNodeId,
      repositoryDatabaseId: CONFIGURATION.repositoryDatabaseId,
      number: 28,
      state: 'open',
      title: 'Recover one durable Work Item move',
      url: 'https://github.com/example/restart/issues/28',
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

const INITIAL_SNAPSHOT = snapshot(CONFIGURATION.statusOptionNodeIds.ready)
const EXPECTED_REMOTE_FINGERPRINT = targetedBoardRemoteFingerprint(INITIAL_SNAPSHOT)
const UNJOINED_SNAPSHOT = {
  ...INITIAL_SNAPSHOT,
  membership: { state: 'absent' as const },
}
const UNJOINED_REMOTE_FINGERPRINT = targetedBoardRemoteFingerprint(UNJOINED_SNAPSHOT)

const CONTEXT: GitHubWorkItemMutationContext = {
  synchronizationRevision: 3,
  mappingRevision: 3,
  checkpointObservedAt: 100,
  configuration: CONFIGURATION,
  confirmedBoard: {
    generation: 7,
    configurationRevision: 3,
    repository: {
      id: CONFIGURATION.repositoryNodeId,
      nameWithOwner: 'example/restart',
      url: 'https://github.com/example/restart',
    },
    project: {
      id: CONFIGURATION.projectNodeId,
      title: 'Restart Project',
      url: 'https://github.com/orgs/example/projects/28',
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

function membershipSnapshot(inProject: boolean): GitHubMutationMap['project-item-add']['inspection']['snapshot'] {
  return {
    repositoryId: INITIAL_SNAPSHOT.repositoryId,
    repositoryDatabaseId: INITIAL_SNAPSHOT.repositoryDatabaseId,
    projectId: INITIAL_SNAPSHOT.projectId,
    issue: INITIAL_SNAPSHOT.issue,
    membership: inProject
      ? {
        state: 'present',
        item: {
          id: ITEM_ID,
          projectId: INITIAL_SNAPSHOT.projectId,
          issueId: INITIAL_SNAPSHOT.issue.id,
          archived: false,
        },
      }
      : { state: 'absent' },
  }
}

class SimulatedProcessCrash extends Error {}

class MemoryTable<K extends string, V> implements KvTable<K, V> {
  readonly values = new Map<K, V>()
  private crashAfterCommit: ((value: V) => boolean) | undefined
  private crashReads = 0
  get size(): number { return this.values.size }
  get(key: K): V | undefined {
    if (this.crashReads > 0) {
      this.crashReads -= 1
      throw new SimulatedProcessCrash('process stopped after a committed table update')
    }
    return this.values.get(key)
  }
  entries(): IterableIterator<[K, V]> { return new Map(this.values).entries() }
  keys(): IterableIterator<K> { return new Map(this.values).keys() }
  async put(key: K, value: V): Promise<void> { this.values.set(key, value) }
  async delete(key: K): Promise<boolean> { return this.values.delete(key) }
  async update(key: K, operation: (current: V) => V): Promise<V> {
    const current = this.values.get(key)
    if (current === undefined) throw new Error('missing key')
    const next = operation(current)
    this.values.set(key, next)
    if (this.crashAfterCommit?.(next) === true) {
      this.crashAfterCommit = undefined
      this.crashReads = 1
      throw new SimulatedProcessCrash('storage committed before the process stopped')
    }
    return next
  }

  simulateCrashAfterCommitWhen(predicate: (value: V) => boolean): void {
    this.crashAfterCommit = predicate
  }
}

class RestartGitHub extends SakiGitHub {
  statusOptionId: GitHubProjectOptionId = CONFIGURATION.statusOptionNodeIds.ready
  inProject = true
  addDispatchMode: 'success' | 'effect-then-lost-ack' | 'effect-then-process-crash' = 'success'
  dispatchMode: 'success' | 'effect-then-lost-ack' | 'no-effect-then-lost-ack' = 'success'
  addDispatchCalls = 0
  addEffects = 0
  addInspectCalls = 0
  addInspectFailures = 0
  dispatchCalls = 0
  effects = 0
  inspectCalls = 0
  inspectFailures = 0
  unexpectedStatusInspection: (() => Promise<never>) | undefined

  override async read<K extends keyof GitHubReadMap>(
    request: GitHubReadMap[K]['request'],
  ): Promise<GitHubReadMap[K]['result']> {
    throw new GitHubProviderError({ code: 'not-found', resource: request.kind })
  }

  override async scan<K extends keyof GitHubScanMap>(): Promise<GitHubScanMap[K]['result']> {
    throw new Error('targeted recovery must not perform a complete scan directly')
  }

  override async dispatch<K extends keyof GitHubMutationMap>(
    request: GitHubMutationMap[K]['request'],
  ): Promise<GitHubMutationMap[K]['result']> {
    if (request.kind === 'project-item-add') {
      this.addDispatchCalls += 1
      if (!this.inProject) this.addEffects += 1
      this.inProject = true
      if (this.addDispatchMode === 'effect-then-process-crash') {
        throw new SimulatedProcessCrash('process stopped after the membership effect landed')
      }
      if (this.addDispatchMode === 'effect-then-lost-ack') {
        this.addInspectFailures += 1
        throw new GitHubProviderError({ code: 'transient-transport' })
      }
      return undefined
    }
    if (request.kind !== 'project-item-status-set') throw new Error(`unexpected mutation ${request.kind}`)
    this.dispatchCalls += 1
    if (this.dispatchMode !== 'no-effect-then-lost-ack') {
      if (this.statusOptionId !== request.desiredStatusOptionId) this.effects += 1
      this.statusOptionId = request.desiredStatusOptionId
    }
    if (this.dispatchMode !== 'success') {
      this.inspectFailures += 1
      throw new GitHubProviderError({ code: 'transient-transport' })
    }
    return undefined
  }

  override async inspectMutation<K extends keyof GitHubMutationMap>(
    request: GitHubMutationMap[K]['request'],
  ): Promise<GitHubMutationMap[K]['inspection']> {
    if (request.kind === 'project-item-add') {
      this.addInspectCalls += 1
      if (this.addInspectFailures > 0) {
        this.addInspectFailures -= 1
        throw new GitHubProviderError({ code: 'transient-transport' })
      }
      const current = membershipSnapshot(this.inProject)
      return githubProjectItemAddInspectionSchema.parse({
        snapshot: current,
        observedAt: Date.now(),
      })
    }
    if (request.kind !== 'project-item-status-set') throw new Error(`unexpected inspection ${request.kind}`)
    if (this.unexpectedStatusInspection !== undefined) return await this.unexpectedStatusInspection()
    this.inspectCalls += 1
    if (this.inspectFailures > 0) {
      this.inspectFailures -= 1
      throw new GitHubProviderError({ code: 'transient-transport' })
    }
    const current = snapshot(this.statusOptionId)
    return githubProjectItemStatusSetInspectionSchema.parse({
      snapshot: current,
      observedAt: Date.now(),
    })
  }
}

interface DurableState {
  readonly intents: MemoryTable<SakiControlIntentId, GitHubWorkItemIntentRecord>
  readonly recoveries: MemoryTable<SakiWorkItemRecoveryId, GitHubWorkItemRecoveryRecord>
}

interface RuntimeOptions {
  readonly authority?: { current: boolean } | undefined
  readonly context?: GitHubWorkItemMutationContext | undefined
  readonly requestScan?: ((projectId: SakiDevelopmentProjectId) => Promise<void>) | undefined
}

function durableState(): DurableState {
  return { intents: new MemoryTable(), recoveries: new MemoryTable() }
}

function runtime(durable: DurableState, options: RuntimeOptions = {}) {
  const authority = options.authority ?? { current: true }
  const context = options.context ?? CONTEXT
  const scans: SakiDevelopmentProjectId[] = []
  const unexpected: unknown[] = []
  const operations = new GitHubWorkItemOperations({
    intentTable: durable.intents,
    recoveryTable: durable.recoveries,
    mutationContext: (): GitHubWorkItemMutationContextResult => ({ ok: true, context: structuredClone(context) }),
    projectRevision: projectId => projectId === PROJECT_ID ? 4 : 'not-found',
    authorityCurrent: () => authority.current,
    validateActorReference: () => {},
    requestScan: options.requestScan ?? (async (projectId) => { scans.push(projectId) }),
    notifyChanged: () => {},
    reportUnexpectedFailure: (error) => { unexpected.push(error) },
    lifetime: new AbortController().signal,
  })
  return { operations, scans, unexpected }
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

function unjoinedMoveIntent(): MoveWorkItemIntent {
  return {
    ...moveIntent(),
    expectedRemoteFingerprint: UNJOINED_REMOTE_FINGERPRINT,
  }
}

async function reopenAndAttach(
  durable: DurableState,
  github: RestartGitHub,
  options: RuntimeOptions = {},
) {
  const restarted = runtime(durable, options)
  const validated = restarted.operations.validateDurableState(new Set())
  await restarted.operations.initializeValidated(validated)
  restarted.operations.attach(github)
  await restarted.operations.dispose()
  expect(restarted.unexpected).toEqual([])
  return restarted
}

describe('GitHub Work Item restart recovery', () => {
  it('resumes a persisted prepared Status move in a fresh operations instance', async () => {
    const durable = durableState()
    const initial = runtime(durable)
    const pending = await initial.operations.submit(moveIntent(), ACTOR, new AbortController().signal)
    expect(pending).toMatchObject({ ok: false, receipt: { state: 'prepared' } })

    const github = new RestartGitHub(new Context())
    const restarted = await reopenAndAttach(durable, github)
    const replay = await restarted.operations.submit(moveIntent(), ACTOR, new AbortController().signal)

    expect(replay).toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
    expect(github.dispatchCalls).toBe(1)
    expect(github.effects).toBe(1)
  })

  it('reports an unexpected provider failure without rejecting disposal of retained recovery', async () => {
    const durable = durableState()
    const initial = runtime(durable)
    expect(await initial.operations.submit(moveIntent(), ACTOR, new AbortController().signal))
      .toMatchObject({ ok: false, receipt: { state: 'prepared' } })

    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const failure = new Error('unexpected provider failure during retained recovery')
    const github = new RestartGitHub(new Context())
    github.unexpectedStatusInspection = async () => {
      entered.resolve(undefined)
      await release.promise
      throw failure
    }
    const restarted = runtime(durable)
    await restarted.operations.initializeValidated(restarted.operations.validateDurableState(new Set()))
    restarted.operations.attach(github)

    let disposed = false
    const disposal = restarted.operations.dispose()
    void disposal.then(
      () => { disposed = true },
      () => { disposed = true },
    )
    await entered.promise
    const disposedBeforeRelease = disposed
    release.resolve(undefined)

    expect(disposedBeforeRelease).toBe(false)
    await expect(disposal).resolves.toBeUndefined()
    expect(restarted.unexpected).toEqual([failure])
  })

  it('recovers an effect-possible stage committed immediately before process loss', async () => {
    const durable = durableState()
    durable.intents.simulateCrashAfterCommitWhen(record => record.phase === 'running'
      && record.stages.some(stage => stage.state === 'dispatching' && stage.effectPossible))
    const github = new RestartGitHub(new Context())
    const initial = runtime(durable)
    initial.operations.attach(github)

    await expect(initial.operations.submit(moveIntent(), ACTOR, new AbortController().signal))
      .rejects.toThrow(SimulatedProcessCrash)
    expect(github.dispatchCalls).toBe(0)
    expect(durable.intents.values.get(INTENT_ID)).toMatchObject({
      phase: 'running',
      stages: [{ state: 'dispatching', effectPossible: true }],
    })

    const restarted = await reopenAndAttach(durable, github)
    const replay = await restarted.operations.submit(moveIntent(), ACTOR, new AbortController().signal)

    expect(replay).toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
    expect(github.dispatchCalls).toBe(1)
    expect(github.effects).toBe(1)
  })

  it('inspects a landed effect after acknowledgement loss without dispatching it again', async () => {
    const durable = durableState()
    const github = new RestartGitHub(new Context())
    github.dispatchMode = 'effect-then-lost-ack'
    const initial = runtime(durable)
    initial.operations.attach(github)

    const partial = await initial.operations.submit(moveIntent(), ACTOR, new AbortController().signal)
    expect(partial).toMatchObject({
      ok: false,
      receipt: { state: 'partial-failure', recoveryAction: { kind: 'inspect-before-retry' } },
    })
    expect(github.dispatchCalls).toBe(1)
    expect(github.effects).toBe(1)

    github.dispatchMode = 'success'
    const restarted = await reopenAndAttach(durable, github)
    const replay = await restarted.operations.submit(moveIntent(), ACTOR, new AbortController().signal)

    expect(replay).toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
    expect(github.dispatchCalls).toBe(1)
    expect(github.effects).toBe(1)
  })

  it('recovers a landed membership after acknowledgement and inspection loss without adding it again', async () => {
    const durable = durableState()
    const github = new RestartGitHub(new Context())
    github.inProject = false
    github.addDispatchMode = 'effect-then-lost-ack'
    const initial = runtime(durable, { context: UNJOINED_CONTEXT })
    initial.operations.attach(github)

    const partial = await initial.operations.submit(unjoinedMoveIntent(), ACTOR, new AbortController().signal)
    expect(partial).toMatchObject({
      ok: false,
      receipt: {
        state: 'partial-failure',
        stage: 'project-item-add',
        recoveryAction: { kind: 'inspect-before-retry' },
      },
    })
    expect(github.addDispatchCalls).toBe(1)
    expect(github.addEffects).toBe(1)
    expect(github.dispatchCalls).toBe(0)
    const inspectionsBeforeRestart = github.addInspectCalls

    github.addDispatchMode = 'success'
    const restarted = await reopenAndAttach(durable, github, { context: UNJOINED_CONTEXT })
    const replay = await restarted.operations.submit(unjoinedMoveIntent(), ACTOR, new AbortController().signal)

    expect(replay).toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
    expect(github.addInspectCalls).toBe(inspectionsBeforeRestart + 1)
    expect(github.addDispatchCalls).toBe(1)
    expect(github.addEffects).toBe(1)
    expect(github.dispatchCalls).toBe(1)
    expect(github.effects).toBe(1)
  })

  it('resumes after membership confirmation materializes the Status target before Status starts', async () => {
    const durable = durableState()
    durable.intents.simulateCrashAfterCommitWhen(record => record.phase === 'prepared'
      && record.observedPrefix.length === 1
      && record.stages[0]?.kind === 'project-item-add'
      && record.stages[0].state === 'confirmed'
      && record.stages[1]?.kind === 'project-item-status-set'
      && record.stages[1].state === 'prepared'
      && record.stages[1].resolvedTarget?.kind === 'project-item-status-set')
    const github = new RestartGitHub(new Context())
    github.inProject = false
    const initial = runtime(durable, { context: UNJOINED_CONTEXT })
    initial.operations.attach(github)

    await expect(initial.operations.submit(unjoinedMoveIntent(), ACTOR, new AbortController().signal))
      .rejects.toThrow(SimulatedProcessCrash)
    expect(durable.intents.values.get(INTENT_ID)).toMatchObject({
      phase: 'prepared',
      target: { projectItemId: ITEM_ID },
      stages: [
        { kind: 'project-item-add', state: 'confirmed' },
        { kind: 'project-item-status-set', state: 'prepared', resolvedTarget: { projectItemId: ITEM_ID } },
      ],
      observedPrefix: [{ stageKind: 'project-item-add' }],
    })
    expect(github.addDispatchCalls).toBe(1)
    expect(github.addEffects).toBe(1)
    expect(github.dispatchCalls).toBe(0)
    expect(github.effects).toBe(0)

    const restarted = await reopenAndAttach(durable, github, { context: UNJOINED_CONTEXT })
    const replay = await restarted.operations.submit(unjoinedMoveIntent(), ACTOR, new AbortController().signal)

    expect(replay).toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
    expect(github.addDispatchCalls).toBe(1)
    expect(github.addEffects).toBe(1)
    expect(github.dispatchCalls).toBe(1)
    expect(github.effects).toBe(1)
  })

  it('confirms a landed effect-possible membership after revocation without producing a Status effect', async () => {
    const durable = durableState()
    const github = new RestartGitHub(new Context())
    github.inProject = false
    github.addDispatchMode = 'effect-then-process-crash'
    const initial = runtime(durable, { context: UNJOINED_CONTEXT })
    initial.operations.attach(github)

    await expect(initial.operations.submit(unjoinedMoveIntent(), ACTOR, new AbortController().signal))
      .rejects.toThrow(SimulatedProcessCrash)
    expect(durable.intents.values.get(INTENT_ID)).toMatchObject({
      phase: 'running',
      stages: [
        { kind: 'project-item-add', state: 'dispatching', effectPossible: true },
        { kind: 'project-item-status-set', state: 'prepared', effectPossible: false },
      ],
      observedPrefix: [],
    })
    expect(github.addDispatchCalls).toBe(1)
    expect(github.addEffects).toBe(1)
    const membershipInspectionsBeforeRestart = github.addInspectCalls

    const restarted = await reopenAndAttach(durable, github, {
      authority: { current: false },
      context: UNJOINED_CONTEXT,
    })
    const replay = await restarted.operations.submit(unjoinedMoveIntent(), ACTOR, new AbortController().signal)

    expect(replay).toMatchObject({
      ok: false,
      reason: 'canceled',
      receipt: { state: 'canceled', reason: 'authority-revoked' },
    })
    expect(durable.intents.values.get(INTENT_ID)).toMatchObject({
      phase: 'canceled',
      target: { projectItemId: ITEM_ID },
      stages: [
        { kind: 'project-item-add', state: 'confirmed', effectPossible: true },
        { kind: 'project-item-status-set', state: 'prepared', effectPossible: false },
      ],
      observedPrefix: [{
        stageKind: 'project-item-add',
        facts: { membership: { state: 'present', item: { id: ITEM_ID } } },
      }],
    })
    expect(github.addInspectCalls).toBe(membershipInspectionsBeforeRestart + 1)
    expect(github.addDispatchCalls).toBe(1)
    expect(github.addEffects).toBe(1)
    expect(github.dispatchCalls).toBe(0)
    expect(github.effects).toBe(0)
  })

  it('safely resumes a partial failure whose first dispatch produced no effect', async () => {
    const durable = durableState()
    const github = new RestartGitHub(new Context())
    github.dispatchMode = 'no-effect-then-lost-ack'
    const initial = runtime(durable)
    initial.operations.attach(github)

    const partial = await initial.operations.submit(moveIntent(), ACTOR, new AbortController().signal)
    expect(partial).toMatchObject({
      ok: false,
      receipt: { state: 'partial-failure', recoveryAction: { kind: 'inspect-before-retry' } },
    })
    expect(github.dispatchCalls).toBe(1)
    expect(github.effects).toBe(0)

    github.dispatchMode = 'success'
    const restarted = await reopenAndAttach(durable, github)
    const replay = await restarted.operations.submit(moveIntent(), ACTOR, new AbortController().signal)

    expect(replay).toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
    expect(github.dispatchCalls).toBe(2)
    expect(github.effects).toBe(1)
  })

  it('retries failed terminal scan scheduling once and coalesces exact replay in the restarted runtime', async () => {
    const durable = durableState()
    const github = new RestartGitHub(new Context())
    let firstScanRequest = true
    const initial = runtime(durable, {
      requestScan: async () => {
        if (firstScanRequest) {
          firstScanRequest = false
          throw new Error('scan scheduling stopped after terminal persistence')
        }
      },
    })
    initial.operations.attach(github)

    await expect(initial.operations.submit(moveIntent(), ACTOR, new AbortController().signal))
      .rejects.toThrow('scan scheduling stopped after terminal persistence')
    expect(durable.intents.values.get(INTENT_ID)).toMatchObject({ phase: 'succeeded' })
    expect(github.dispatchCalls).toBe(1)
    expect(github.effects).toBe(1)

    let restartScanRequests = 0
    const restarted = runtime(durable, {
      requestScan: async () => { restartScanRequests += 1 },
    })
    const validated = restarted.operations.validateDurableState(new Set())
    await restarted.operations.initializeValidated(validated)
    expect(restartScanRequests).toBe(1)

    const replay = await restarted.operations.submit(moveIntent(), ACTOR, new AbortController().signal)
    expect(replay).toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
    expect(restartScanRequests).toBe(1)
    expect(github.dispatchCalls).toBe(1)
    expect(github.effects).toBe(1)
  })

  it('replays the exact Intent but rejects changed immutable input after restart', async () => {
    const durable = durableState()
    const github = new RestartGitHub(new Context())
    const initial = runtime(durable)
    initial.operations.attach(github)
    const succeeded = await initial.operations.submit(moveIntent(), ACTOR, new AbortController().signal)
    expect(succeeded).toMatchObject({ ok: true, receipt: { state: 'succeeded' } })

    const restarted = runtime(durable)
    const validated = restarted.operations.validateDurableState(new Set())
    await restarted.operations.initializeValidated(validated)
    const exactReplay = await restarted.operations.submit(moveIntent(), ACTOR, new AbortController().signal)
    const changedReplay = await restarted.operations.submit(
      { ...moveIntent(), targetStatus: 'backlog' },
      ACTOR,
      new AbortController().signal,
    )

    expect(exactReplay).toEqual(succeeded)
    expect(changedReplay).toEqual({ ok: false, reason: 'conflict' })
    expect(github.dispatchCalls).toBe(1)
    expect(github.effects).toBe(1)
  })

  it('cancels a prepared Intent after authority is revoked before restart', async () => {
    const durable = durableState()
    const initial = runtime(durable)
    const pending = await initial.operations.submit(moveIntent(), ACTOR, new AbortController().signal)
    expect(pending).toMatchObject({ ok: false, receipt: { state: 'prepared' } })

    const github = new RestartGitHub(new Context())
    const restarted = await reopenAndAttach(durable, github, { authority: { current: false } })
    const replay = await restarted.operations.submit(moveIntent(), ACTOR, new AbortController().signal)

    expect(replay).toMatchObject({
      ok: false,
      reason: 'canceled',
      receipt: { state: 'canceled', reason: 'authority-revoked' },
    })
    expect(github.inspectCalls).toBe(0)
    expect(github.dispatchCalls).toBe(0)
    expect(github.effects).toBe(0)
  })

  it('inspects an effect-possible stage before canceling it after authority revocation', async () => {
    const durable = durableState()
    durable.intents.simulateCrashAfterCommitWhen(record => record.phase === 'running'
      && record.stages.some(stage => stage.state === 'dispatching' && stage.effectPossible))
    const github = new RestartGitHub(new Context())
    const initial = runtime(durable)
    initial.operations.attach(github)
    await expect(initial.operations.submit(moveIntent(), ACTOR, new AbortController().signal))
      .rejects.toThrow(SimulatedProcessCrash)
    const inspectionsBeforeRestart = github.inspectCalls

    const restarted = await reopenAndAttach(durable, github, { authority: { current: false } })
    const replay = await restarted.operations.submit(moveIntent(), ACTOR, new AbortController().signal)

    expect(replay).toMatchObject({
      ok: false,
      reason: 'canceled',
      receipt: { state: 'canceled', reason: 'authority-revoked' },
    })
    expect(github.inspectCalls).toBe(inspectionsBeforeRestart + 1)
    expect(github.dispatchCalls).toBe(0)
    expect(github.effects).toBe(0)
  })
})
