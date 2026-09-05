import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { cloneLosslessJsonValue } from '@deepseek-ai/dsh-storage'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  canonicalDigest,
  computeProjectInspectionFingerprint,
  sakiExecutionDispatchIdSchema,
  type ActiveHostProjectBinding,
  type HostOperationAdmissionSource,
  type HostOperationCancellationReason,
  type HostOperationId,
  type HostOperationSnapshot,
  type InheritedChangeBaseline,
  type PushBranchHostOperationRequest,
  type SakiHostExecution,
} from '@breakfastdapaidang/saki-execution'
import {
  GITHUB_PULL_REQUEST_CREATE_BODY_UTF8_LIMIT,
  GITHUB_PULL_REQUEST_CREATE_TITLE_UTF8_LIMIT,
  GitHubProviderError,
  SakiGitHub,
  githubCommitId,
  githubCommitStatusId,
  githubIssueId,
  githubPullRequestCreateMarkerId,
  githubPullRequestId,
  githubPullRequestReviewId,
  githubRepositoryDatabaseId,
  githubRepositoryId,
  githubWorkflowId,
  githubWorkflowRunId,
  type GitHubCommitCiFact,
  type GitHubFailure,
  type GitHubMutationMap,
  type GitHubPullRequestCreateRequest,
  type GitHubPullRequestCreateInspectionOutcome,
  type GitHubReadMap,
  type GitHubScanMap,
  type GitHubInstallationProfile,
} from '@breakfastdapaidang/saki-github'
import { bindingWriteAdmissionRecordSchema, controlIntentActorSchema, type BindingWriteAdmissionRecord } from '../src/spec.ts'
import {
  sakiBoardRemoteFingerprintSchema,
  sakiBoardWorkItemIdSchema,
  sakiControlIntentIdSchema,
  sakiDevelopmentProjectIdSchema,
  sakiResourceBindingIdSchema,
} from '../src/ids.ts'
import {
  BranchDeliveryOperations,
  branchDeliveryId,
  branchDeliveryIntentSchema,
  branchDeliveryIntentRecordSchema,
  branchDeliveryRecordSchema,
  type BranchDeliveryAcceptIntent,
  type BranchDeliveryAssociatePullRequestIntent,
  type BranchDeliveryCurrentContext,
  type BranchDeliveryIntentRecord,
  type BranchDeliveryRecord,
  type BranchDeliveryCreatePullRequestIntent,
  type BranchDeliveryInReviewIntent,
  type BranchDeliveryMoveWorkItemRequest,
  type BranchDeliveryOperationsOptions,
  type BranchDeliveryPushIntent,
  type BranchDeliverySaveIntent,
} from '../src/branch-delivery.ts'

const PROJECT_ID = sakiDevelopmentProjectIdSchema.parse('project-00000000-0000-4000-8000-000000000201')
const WORK_ITEM_ID = sakiBoardWorkItemIdSchema.parse(`work-item-${'1'.repeat(64)}`)
const SECOND_WORK_ITEM_ID = sakiBoardWorkItemIdSchema.parse(`work-item-${'7'.repeat(64)}`)
const BINDING_ID = sakiResourceBindingIdSchema.parse('binding-00000000-0000-4000-8000-000000000202')
const SAVE_INTENT_ID = sakiControlIntentIdSchema.parse('intent-00000000-0000-4000-8000-000000000203')
const UPDATE_INTENT_ID = sakiControlIntentIdSchema.parse('intent-00000000-0000-4000-8000-000000000204')
const PULL_REQUEST_INTENT_ID = sakiControlIntentIdSchema.parse('intent-00000000-0000-4000-8000-000000000210')
const PUSH_INTENT_ID = sakiControlIntentIdSchema.parse('intent-00000000-0000-4000-8000-000000000211')
const REVIEW_INTENT_ID = sakiControlIntentIdSchema.parse('intent-00000000-0000-4000-8000-000000000213')
const ACCEPT_INTENT_ID = sakiControlIntentIdSchema.parse('intent-00000000-0000-4000-8000-000000000214')
const IMMUTABLE_INTENT_ID = sakiControlIntentIdSchema.parse('intent-00000000-0000-4000-8000-000000000215')
const ASSOCIATE_INTENT_ID = sakiControlIntentIdSchema.parse('intent-00000000-0000-4000-8000-000000000216')
const SECOND_SAVE_INTENT_ID = sakiControlIntentIdSchema.parse('intent-00000000-0000-4000-8000-000000000217')
const SECOND_PULL_REQUEST_INTENT_ID = sakiControlIntentIdSchema.parse(
  'intent-00000000-0000-4000-8000-000000000218',
)
const COMMIT_ID = githubCommitId('1'.repeat(40))
const UPDATED_COMMIT_ID = githubCommitId('2'.repeat(40))
const REPOSITORY_ID = githubRepositoryId('R_repo')
const REPOSITORY_DATABASE_ID = githubRepositoryDatabaseId('12')
const ISSUE_ID = githubIssueId('I_issue_32')
const REMOTE_FINGERPRINT = sakiBoardRemoteFingerprintSchema.parse(`remote-fingerprint-${'3'.repeat(64)}`)
const REVIEW_FINGERPRINT = sakiBoardRemoteFingerprintSchema.parse(`remote-fingerprint-${'5'.repeat(64)}`)
const DONE_FINGERPRINT = sakiBoardRemoteFingerprintSchema.parse(`remote-fingerprint-${'6'.repeat(64)}`)

const ACTOR = controlIntentActorSchema.parse({
  installationId: 'installation-00000000-0000-4000-8000-000000000205',
  storageGenerationId: 'storage-generation-00000000-0000-4000-8000-000000000206',
  hostId: 'host-00000000-0000-4000-8000-000000000207',
  principalId: 'principal-00000000-0000-4000-8000-000000000208',
  principalRevision: 1,
  grantId: 'grant-00000000-0000-4000-8000-000000000209',
  grantRevision: 2,
})

const INSTALLATION = {
  appId: '10',
  installationId: '11',
  accountId: 'A_account',
  privateKeyRef: credentialRef('SAKI_GITHUB_PRIVATE_KEY'),
} as GitHubInstallationProfile

function assertPullRequestCreateRequest(
  request: GitHubMutationMap[keyof GitHubMutationMap]['request'],
): asserts request is GitHubPullRequestCreateRequest {
  if (request.kind !== 'pull-request-create') throw new Error(`unexpected mutation ${request.kind}`)
}

class MemoryTable<K extends string, V> implements KvTable<K, V> {
  readonly values = new Map<K, V>()
  beforeUpdate: ((key: K, current: V, next: V) => void) | undefined
  get size(): number { return this.values.size }
  get(key: K): V | undefined { return this.values.get(key) }
  entries(): IterableIterator<[K, V]> { return new Map(this.values).entries() }
  keys(): IterableIterator<K> { return new Map(this.values).keys() }
  async put(key: K, value: V): Promise<void> { this.values.set(key, cloneLosslessJsonValue(value)) }
  async delete(key: K): Promise<boolean> { return this.values.delete(key) }
  async update(key: K, operation: (current: V) => V): Promise<V> {
    const current = this.values.get(key)
    if (current === undefined) throw new Error('missing key')
    const next = cloneLosslessJsonValue(operation(structuredClone(current)))
    this.beforeUpdate?.(key, structuredClone(current), structuredClone(next))
    this.values.set(key, next)
    return structuredClone(next)
  }
}

interface Harness {
  readonly operations: BranchDeliveryOperations
  readonly deliveries: MemoryTable<ReturnType<typeof branchDeliveryId>, BranchDeliveryRecord>
  readonly intents: MemoryTable<ReturnType<typeof sakiControlIntentIdSchema.parse>, BranchDeliveryIntentRecord>
  readonly admissions: MemoryTable<ReturnType<typeof sakiResourceBindingIdSchema.parse>, BindingWriteAdmissionRecord>
  readonly context: { current: BranchDeliveryCurrentContext }
  readonly localHead: { current: ReturnType<typeof githubCommitId> }
  readonly projectPresent: { current: boolean }
  readonly authority: { current: boolean }
  readonly validatedActors: (typeof ACTOR)[]
  readonly moveAttempts: BranchDeliveryMoveWorkItemRequest[]
  readonly moveUnavailableOnce: Set<'in-review' | 'done'>
  readonly additionalContexts: Map<ReturnType<typeof sakiBoardWorkItemIdSchema.parse>, BranchDeliveryCurrentContext>
  readonly unexpectedFailures: unknown[]
  readonly github: DeliveryGitHub
  readonly execution: PushExecution
  readonly detachOperations: () => Promise<void>
  readonly createDetachedOperations: () => BranchDeliveryOperations
  readonly createOperations: () => BranchDeliveryOperations
}

function harness(overrides: Partial<Pick<BranchDeliveryOperationsOptions, 'currentLocalHead' | 'moveWorkItem' | 'resolveContext'>> = {}): Harness {
  const deliveries = new MemoryTable<ReturnType<typeof branchDeliveryId>, BranchDeliveryRecord>()
  const intents = new MemoryTable<ReturnType<typeof sakiControlIntentIdSchema.parse>, BranchDeliveryIntentRecord>()
  const admissions = new MemoryTable<
    ReturnType<typeof sakiResourceBindingIdSchema.parse>,
    BindingWriteAdmissionRecord
  >()
  void admissions.put(BINDING_ID, {
    id: BINDING_ID,
    schemaVersion: 1,
    revision: 0,
    state: 'available',
    updatedAt: 1,
  })
  const context = { current: deliveryContext() }
  const localHead = { current: COMMIT_ID }
  const projectPresent = { current: true }
  const authority = { current: true }
  const validatedActors: (typeof ACTOR)[] = []
  const moveAttempts: BranchDeliveryMoveWorkItemRequest[] = []
  const moveUnavailableOnce = new Set<'in-review' | 'done'>()
  const additionalContexts = new Map<
    ReturnType<typeof sakiBoardWorkItemIdSchema.parse>,
    BranchDeliveryCurrentContext
  >()
  const unexpectedFailures: unknown[] = []
  const github = new DeliveryGitHub(new Context())
  const execution = new PushExecution()
  const options: BranchDeliveryOperationsOptions = {
    deliveryTable: deliveries,
    intentTable: intents,
    admissionTable: admissions,
    execution: execution as unknown as SakiHostExecution,
    projectExists: projectId => projectId === PROJECT_ID && projectPresent.current,
    resolveContext: (projectId, workItemId) => {
      if (projectId !== PROJECT_ID) return { ok: false, reason: 'not-found' }
      if (workItemId === WORK_ITEM_ID) return { ok: true, context: structuredClone(context.current) }
      const additional = additionalContexts.get(workItemId)
      return additional === undefined
        ? { ok: false, reason: 'not-found' }
        : { ok: true, context: structuredClone(additional) }
    },
    currentLocalHead: async () => ({ ok: true, commitId: localHead.current }),
    authorityCurrent: () => authority.current,
    validateActorReference: (actor) => { validatedActors.push(structuredClone(actor)) },
    moveWorkItem: async (request) => {
      moveAttempts.push(structuredClone(request))
      if (moveUnavailableOnce.delete(request.targetStatus)) return { state: 'unavailable' }
      const remoteFingerprint = request.targetStatus === 'in-review' ? REVIEW_FINGERPRINT : DONE_FINGERPRINT
      context.current = {
        ...context.current,
        workItem: { ...context.current.workItem, remoteFingerprint },
      }
      return { state: 'succeeded', remoteFingerprint }
    },
    observationFreshForMs: 60_000,
    notifyChanged: () => {},
    reportUnexpectedFailure: (error) => { unexpectedFailures.push(error) },
    lifetime: new AbortController().signal,
    ...overrides,
  }
  const createDetachedOperations = () => new BranchDeliveryOperations(options)
  const createOperations = () => {
    const operations = createDetachedOperations()
    operations.attach(github)
    return operations
  }
  const operations = createDetachedOperations()
  const detachOperations = operations.attach(github)
  return {
    operations,
    deliveries,
    intents,
    admissions,
    context,
    localHead,
    projectPresent,
    authority,
    validatedActors,
    moveAttempts,
    moveUnavailableOnce,
    additionalContexts,
    unexpectedFailures,
    github,
    execution,
    detachOperations,
    createDetachedOperations,
    createOperations,
  }
}

class PushExecution {
  request: PushBranchHostOperationRequest | undefined
  admissionSource: HostOperationAdmissionSource | undefined
  starts = 0
  readonly cancellations: HostOperationCancellationReason[] = []
  snapshot: HostOperationSnapshot<'push-branch'> | undefined
  unavailable = false
  crashBeforePrepareOnce = false
  beforeAdmission: (() => void) | undefined
  afterStart: ((snapshot: Extract<HostOperationSnapshot<'push-branch'>, { state: 'succeeded' }>) => HostOperationSnapshot<'push-branch'>) | undefined

  async prepareOperation(
    request: PushBranchHostOperationRequest,
    admissionSource: HostOperationAdmissionSource,
  ) {
    if (this.crashBeforePrepareOnce) {
      this.crashBeforePrepareOnce = false
      throw new SimulatedProcessCrash()
    }
    if (this.unavailable) throw new Error('Host execution is unavailable')
    this.request = structuredClone(request)
    this.admissionSource = admissionSource
    const preparation = {
      operation: {
        id: 'host-operation-00000000-0000-4000-8000-000000000212' as HostOperationId,
        hostId: request.expected.binding.hostId,
        type: 'push-branch' as const,
      },
      preparationRevision: 0,
      requestFingerprint: { version: 1 as const, digest: canonicalDigest('test/push-request/v1', request) },
    }
    this.snapshot ??= {
      operation: preparation.operation,
      revision: 0,
      source: request.source,
      requestFingerprint: preparation.requestFingerprint,
      bindingId: request.expected.binding.id,
      bindingRevision: request.expected.binding.revision,
      preparedAt: 10,
      updatedAt: 10,
      state: 'prepared',
      admission: { kind: 'not-accepted' },
    }
    return {
      ok: true as const,
      preparation,
      snapshot: structuredClone(this.snapshot),
      acceptance: {} as never,
    }
  }

  async inspectOperation() {
    if (this.snapshot === undefined) throw new Error('missing Push operation')
    return structuredClone(this.snapshot)
  }

  async startOperation() {
    if (this.snapshot === undefined || this.request === undefined || this.admissionSource === undefined) {
      throw new Error('missing Push preparation')
    }
    const preparation = (await this.prepareOperation(this.request, this.admissionSource)).preparation
    this.beforeAdmission?.()
    const admission = await this.admissionSource({
      bindingId: this.request.expected.binding.id,
      bindingRevision: this.request.expected.binding.revision,
      preparation,
      source: this.request.source,
    }, new AbortController().signal)
    if (admission.kind !== 'accepted') {
      return {
        ok: false as const,
        reason: admission.kind === 'unavailable' ? 'unavailable' as const : admission.reason,
        snapshot: structuredClone(this.snapshot),
      }
    }
    this.starts += 1
    this.snapshot = {
      ...this.snapshot,
      revision: 1,
      state: 'succeeded',
      admission: { kind: 'accepted', revision: admission.admissionRevision, acceptedAt: 11 },
      completedAt: 12,
      updatedAt: 12,
      result: {
        type: 'push-branch',
        repository: this.request.expected.repository,
        targetRef: this.request.targetRef,
        commitId: this.request.expected.commitId,
        previous: { kind: 'absent' },
        credential: { helperId: 'git-credential-manager' },
      },
    }
    if (this.afterStart !== undefined) this.snapshot = this.afterStart(this.snapshot)
    return { ok: true as const, snapshot: structuredClone(this.snapshot) }
  }

  async cancelOperation(_operation: unknown, reason: HostOperationCancellationReason): Promise<HostOperationSnapshot<'push-branch'>> {
    if (this.snapshot === undefined) throw new Error('missing Push operation')
    if (this.snapshot.state !== 'succeeded' && this.snapshot.state !== 'failed'
      && this.snapshot.state !== 'canceled' && this.snapshot.state !== 'reconciliation-required') {
      this.cancellations.push(reason)
      this.snapshot = {
        ...this.snapshot,
        revision: this.snapshot.revision + 1,
        state: 'canceled',
        completedAt: 13,
        updatedAt: 13,
        reason,
        effect: 'none',
      }
    }
    return structuredClone(this.snapshot)
  }
}

class SimulatedProcessCrash extends Error {}

class DeliveryGitHub extends SakiGitHub {
  inspectionOutcome: GitHubPullRequestCreateInspectionOutcome | undefined
  inspectionFailure: Error | undefined
  dispatchFailure: Error | undefined
  pullRequestCreated = false
  crashAfterCreate = false
  dispatches = 0
  lastCreateRequest: GitHubPullRequestCreateRequest | undefined
  observedAt = 100
  pullRequestInspectionObservedAt = 20
  pullRequestId = githubPullRequestId('PR_delivery')
  pullRequestNumber = 72
  remoteCommit = COMMIT_ID
  reviewRepositoryId = REPOSITORY_ID
  reviewPullRequestId = githubPullRequestId('PR_delivery')
  reviewPullRequestNumber = 72
  reviewHeadCommitId = COMMIT_ID
  reviewPullRequestUpdatedAt: number | undefined
  ciSuccessful = true
  readonly reads: (keyof GitHubReadMap)[] = []
  readonly failures = new Map<keyof GitHubReadMap, GitHubFailure>()

  async read<K extends keyof GitHubReadMap>(
    request: GitHubReadMap[K]['request'],
    _signal: AbortSignal,
  ): Promise<GitHubReadMap[K]['result']> {
    this.reads.push(request.kind)
    const failure = this.failures.get(request.kind)
    if (failure !== undefined) throw new GitHubProviderError(failure)
    switch (request.kind) {
      case 'branch-head':
        return {
          state: 'present',
          repositoryId: request.repositoryId,
          branch: request.branch,
          commitId: this.remoteCommit,
          observedAt: this.observedAt,
        } as GitHubReadMap[K]['result']
      case 'pull-request':
        if (!this.pullRequestCreated) throw new GitHubProviderError({ code: 'not-found', resource: 'pull-request' })
        return this.pullRequestFact(
          'feature/delivery',
          'master',
          this.remoteCommit,
          this.observedAt,
        )
      case 'pull-request-reviews': {
        const pullRequest = pullRequestFact('feature/delivery', 'master', this.remoteCommit, this.observedAt)
        return {
          repositoryId: this.reviewRepositoryId,
          pullRequestId: this.reviewPullRequestId,
          pullRequestNumber: this.reviewPullRequestNumber,
          headCommitId: this.reviewHeadCommitId,
          pullRequestUpdatedAt: this.reviewPullRequestUpdatedAt ?? pullRequest.updatedAt,
          reviews: [{
            id: githubPullRequestReviewId('PRR_delivery'),
            state: 'approved',
            url: 'https://github.com/BreakfastDaPaiDang/saki/pull/72#pullrequestreview-1',
            submittedAt: this.observedAt - 2,
            updatedAt: this.observedAt - 1,
          }],
          observedAt: this.observedAt,
        } as GitHubReadMap[K]['result']
      }
      case 'pull-request-association':
        return (this.pullRequestCreated
          ? {
            state: 'unique',
            pullRequest: this.pullRequestFact(
              request.headRef,
              request.baseRef,
              request.expectedHeadCommitId,
              this.observedAt,
            ),
            observedAt: this.observedAt,
          }
          : {
            state: 'absent',
            repositoryId: request.repositoryId,
            headRef: request.headRef,
            baseRef: request.baseRef,
            expectedHeadCommitId: request.expectedHeadCommitId,
            observedAt: this.observedAt,
          }) as GitHubReadMap[K]['result']
      case 'commit-ci':
        return (this.ciSuccessful
          ? successfulCi(request.commitId, this.observedAt)
          : failedCi(request.commitId, this.observedAt))
      default:
        throw new GitHubProviderError({ code: 'not-found', resource: `test-${request.kind}` })
    }
  }

  async scan<K extends keyof GitHubScanMap>(
    _request: GitHubScanMap[K]['request'],
    _signal: AbortSignal,
  ): Promise<GitHubScanMap[K]['result']> {
    throw new GitHubProviderError({ code: 'not-found', resource: 'test-scan' })
  }

  async dispatch<K extends keyof GitHubMutationMap>(
    request: GitHubMutationMap[K]['request'],
    _signal: AbortSignal,
  ): Promise<GitHubMutationMap[K]['result']> {
    assertPullRequestCreateRequest(request)
    this.dispatches += 1
    this.lastCreateRequest = structuredClone(request)
    this.pullRequestCreated = true
    if (this.dispatchFailure !== undefined) throw this.dispatchFailure
    if (this.crashAfterCreate) throw new SimulatedProcessCrash('process stopped after GitHub accepted the PR')
    return {
      pullRequestId: this.pullRequestId,
      pullRequestNumber: this.pullRequestNumber,
    } as GitHubMutationMap[K]['result']
  }

  async inspectMutation<K extends keyof GitHubMutationMap>(
    request: GitHubMutationMap[K]['request'],
    _signal: AbortSignal,
  ): Promise<GitHubMutationMap[K]['inspection']> {
    if (request.kind !== 'pull-request-create') throw new Error(`unexpected inspection ${request.kind}`)
    if (this.inspectionFailure !== undefined) throw this.inspectionFailure
    return {
      snapshot: {
        repositoryId: request.repositoryId,
        repositoryDatabaseId: request.repositoryDatabaseId,
        outcome: this.inspectionOutcome ?? (this.pullRequestCreated
          ? {
            state: 'unique-pull-request',
            pullRequest: this.pullRequestFact(
              request.headRef,
              request.baseRef,
              request.expectedHeadCommitId,
              this.pullRequestInspectionObservedAt,
            ),
          }
          : { state: 'absent-complete' }),
      },
      observedAt: this.pullRequestInspectionObservedAt,
    } as GitHubMutationMap[K]['inspection']
  }

  private pullRequestFact(
    headRef: string,
    baseRef: string,
    headCommitId: ReturnType<typeof githubCommitId>,
    observedAt: number,
  ) {
    return {
      ...pullRequestFact(headRef, baseRef, headCommitId, observedAt),
      id: this.pullRequestId,
      number: this.pullRequestNumber,
      url: `https://github.com/BreakfastDaPaiDang/saki/pull/${this.pullRequestNumber}`,
    }
  }
}

class BlockingInspectionGitHub extends DeliveryGitHub {
  readonly inspectionStarted = Promise.withResolvers<undefined>()
  readonly releaseInspection = Promise.withResolvers<undefined>()
  inspectionSignal: AbortSignal | undefined

  override async inspectMutation<K extends keyof GitHubMutationMap>(
    request: GitHubMutationMap[K]['request'],
    signal: AbortSignal,
  ): Promise<GitHubMutationMap[K]['inspection']> {
    this.inspectionSignal = signal
    this.inspectionStarted.resolve(undefined)
    await this.releaseInspection.promise
    return await super.inspectMutation(request, signal)
  }
}

class FirstInspectionFailsGitHub extends DeliveryGitHub {
  override async inspectMutation<K extends keyof GitHubMutationMap>(
    request: GitHubMutationMap[K]['request'],
    signal: AbortSignal,
  ): Promise<GitHubMutationMap[K]['inspection']> {
    if (request.operationId.includes(PULL_REQUEST_INTENT_ID)) {
      throw new Error('first recovery failed unexpectedly')
    }
    return await super.inspectMutation(request, signal)
  }
}

function pullRequestFact(
  headRef: string,
  baseRef: string,
  headCommitId = COMMIT_ID,
  observedAt = 20,
) {
  return {
    id: githubPullRequestId('PR_delivery'),
    repositoryId: REPOSITORY_ID,
    number: 72,
    state: 'open' as const,
    merged: false,
    draft: true,
    title: 'Deliver B10',
    url: 'https://github.com/BreakfastDaPaiDang/saki/pull/72',
    head: { repositoryId: REPOSITORY_ID, ref: headRef, commitId: headCommitId },
    base: { repositoryId: REPOSITORY_ID, ref: baseRef, commitId: githubCommitId('4'.repeat(40)) },
    updatedAt: observedAt - 1,
    observedAt,
  }
}

function successfulCi(commitId = COMMIT_ID, observedAt = 100): GitHubCommitCiFact {
  return {
    repositoryId: REPOSITORY_ID,
    commitId,
    workflowRuns: [{
      id: githubWorkflowRunId('101'),
      workflowId: githubWorkflowId('11'),
      name: 'CI',
      event: 'pull_request',
      runNumber: 32,
      runAttempt: 1,
      status: 'completed',
      conclusion: 'success',
      url: 'https://github.com/BreakfastDaPaiDang/saki/actions/runs/101',
      createdAt: observedAt - 2,
      updatedAt: observedAt - 1,
    }],
    checkRuns: [],
    commitStatuses: [{
      id: githubCommitStatusId('301'),
      context: 'required/ci',
      state: 'success',
      targetUrl: 'https://ci.example.test/build/301',
      createdAt: observedAt - 2,
      updatedAt: observedAt - 1,
    }],
    observedAt,
  }
}

function failedCi(commitId = COMMIT_ID, observedAt = 100): GitHubCommitCiFact {
  const fact = successfulCi(commitId, observedAt)
  return {
    ...fact,
    workflowRuns: fact.workflowRuns.map(run => ({ ...run, conclusion: 'failure' })),
    commitStatuses: fact.commitStatuses.map(status => ({ ...status, state: 'failure' })),
  }
}

function saveIntent(
  intentId = SAVE_INTENT_ID,
  commitId = COMMIT_ID,
  expectedDeliveryRevision: number | null = null,
): BranchDeliverySaveIntent {
  return {
    type: 'save-branch-delivery',
    intentId,
    projectId: PROJECT_ID,
    workItemId: WORK_ITEM_ID,
    expected: {
      deliveryRevision: expectedDeliveryRevision,
      registryRevision: 7,
      projectRevision: 3,
      binding: { id: BINDING_ID, revision: 2 },
      synchronizationRevision: 5,
      mappingRevision: 4,
      workItemRemoteFingerprint: REMOTE_FINGERPRINT,
    },
    commitId,
    headRef: 'refs/heads/feature/delivery',
    baseRef: 'refs/heads/master',
  }
}

function createPullRequestIntent(expectedDeliveryRevision = 0): BranchDeliveryCreatePullRequestIntent {
  return {
    type: 'create-branch-delivery-pull-request',
    intentId: PULL_REQUEST_INTENT_ID,
    deliveryId: branchDeliveryId(PROJECT_ID, WORK_ITEM_ID),
    expectedDeliveryRevision,
    title: 'Deliver B10',
    body: 'Completes the branch delivery slice.',
  }
}

function pushIntent(expectedDeliveryRevision = 0): BranchDeliveryPushIntent {
  return {
    type: 'push-branch-delivery',
    intentId: PUSH_INTENT_ID,
    deliveryId: branchDeliveryId(PROJECT_ID, WORK_ITEM_ID),
    expectedDeliveryRevision,
  }
}

function associatePullRequestIntent(expectedDeliveryRevision = 0): BranchDeliveryAssociatePullRequestIntent {
  return {
    type: 'associate-branch-delivery-pull-request',
    intentId: ASSOCIATE_INTENT_ID,
    deliveryId: branchDeliveryId(PROJECT_ID, WORK_ITEM_ID),
    expectedDeliveryRevision,
    pullRequestId: githubPullRequestId('PR_delivery'),
    pullRequestNumber: 72,
  }
}

function inReviewIntent(expectedDeliveryRevision: number): BranchDeliveryInReviewIntent {
  return {
    type: 'mark-branch-delivery-in-review',
    intentId: REVIEW_INTENT_ID,
    deliveryId: branchDeliveryId(PROJECT_ID, WORK_ITEM_ID),
    expectedDeliveryRevision,
    expectedWorkItemRemoteFingerprint: REMOTE_FINGERPRINT,
  }
}

function acceptIntent(expectedDeliveryRevision: number): BranchDeliveryAcceptIntent {
  return {
    type: 'accept-branch-delivery',
    intentId: ACCEPT_INTENT_ID,
    deliveryId: branchDeliveryId(PROJECT_ID, WORK_ITEM_ID),
    expectedDeliveryRevision,
    expectedWorkItemRemoteFingerprint: REVIEW_FINGERPRINT,
  }
}

function deliveryContext(): BranchDeliveryCurrentContext {
  return {
    registryRevision: 7,
    projectRevision: 3,
    binding: activeBinding(),
    synchronizationRevision: 5,
    mappingRevision: 4,
    installation: INSTALLATION,
    repository: {
      id: REPOSITORY_ID,
      databaseId: REPOSITORY_DATABASE_ID,
      nameWithOwner: 'BreakfastDaPaiDang/saki',
    },
    workItem: {
      id: WORK_ITEM_ID,
      remoteFingerprint: REMOTE_FINGERPRINT,
      issueId: ISSUE_ID,
    },
  }
}

function activeBinding(): ActiveHostProjectBinding {
  const baselineMaterial = {
    kind: 'complete' as const,
    formatVersion: 1 as const,
    capturedAt: 1,
    bounds: {
      maxEntries: 2,
      maxPathBytes: 20,
      maxGitOutputBytes: 20,
      maxFileBytes: 20,
      maxTotalFileBytes: 20,
      maxCaptureMs: 20,
    },
    observed: { entries: 0, pathBytes: 0, gitOutputBytes: 1, hashedBytes: 0, elapsedMs: 1 },
    entries: [],
  }
  const baseline = {
    ...baselineMaterial,
    digest: canonicalDigest('saki/inherited-baseline/v1', {
      formatVersion: baselineMaterial.formatVersion,
      bounds: baselineMaterial.bounds,
      observed: { ...baselineMaterial.observed, elapsedMs: 0 },
      entries: baselineMaterial.entries,
    }),
  } satisfies InheritedChangeBaseline
  const trusted = {
    canonicalWorktreePath: 'C:\\repo',
    canonicalGitDirectory: 'C:\\repo\\.git',
    canonicalCommonGitDirectory: 'C:\\repo\\.git',
    gitDirectoryIdentity: { version: 1 as const, digest: '4'.repeat(64) },
    commonGitDirectoryIdentity: { version: 1 as const, digest: '4'.repeat(64) },
    comparison: { fileMode: false, symlinks: false, autocrlf: true },
  }
  const projectionMaterial = {
    observationVersion: 2 as const,
    hostId: ACTOR.hostId,
    displayLocation: 'repo',
    objectFormat: 'sha1' as const,
    head: { kind: 'commit' as const, objectId: COMMIT_ID, symbolicRef: 'refs/heads/feature/delivery' },
    locked: false,
    inheritedChangeEntryCount: 0,
    conversionAmbiguous: false,
    remotes: [],
    automaticMutationEligible: true,
    blockingReasons: [],
    baseline,
  }
  const expectedInspection = {
    projection: {
      ...projectionMaterial,
      fingerprint: computeProjectInspectionFingerprint(projectionMaterial, trusted),
    },
    trusted,
  }
  return {
    id: BINDING_ID,
    revision: 2,
    health: 'active',
    hostId: ACTOR.hostId,
    workspaceId: WorkspaceId('workspace-delivery'),
    expectedInspection,
    inheritedChangeBaseline: baseline,
  }
}

async function seedPreSealAcceptancePrefix(test: Harness): Promise<void> {
  const signal = new AbortController().signal
  await test.operations.submit(saveIntent(), ACTOR, signal)
  await test.operations.submit(pushIntent(), ACTOR, signal)
  await test.operations.submit(createPullRequestIntent(2), ACTOR, signal)
  await test.operations.submit(inReviewIntent(4), ACTOR, signal)
  const id = branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)
  const beforeAcceptance = structuredClone(test.deliveries.get(id))
  expect(beforeAcceptance).toMatchObject({ phase: 'in-review', revision: 6 })
  test.moveUnavailableOnce.add('done')
  await test.operations.submit(acceptIntent(6), ACTOR, signal)
  expect(test.intents.get(ACCEPT_INTENT_ID)).toMatchObject({
    checkpoint: { state: 'child-pending', deliveryRevision: 7 },
  })
  test.deliveries.values.set(id, {
    ...beforeAcceptance!,
    revision: 7,
    activeIntentId: ACCEPT_INTENT_ID,
    updatedAt: Math.max(beforeAcceptance!.updatedAt, Date.now()),
  })
  test.moveAttempts.length = 0
}

describe('BranchDeliveryOperations', () => {
  it('keeps association pending when its targeted provider read fails', async () => {
    const h = harness()
    const signal = new AbortController().signal
    await h.operations.submit(saveIntent(), ACTOR, signal)
    h.github.failures.set('pull-request-association', { code: 'transient-transport' })
    expect(await h.operations.submit(associatePullRequestIntent(), ACTOR, signal))
      .toMatchObject({ ok: false, reason: 'unavailable' })
    expect(h.intents.get(ASSOCIATE_INTENT_ID)?.checkpoint.state).toBe('active')
  })

  it('reports a pending recovery failure after attempting the polling batch', async () => {
    const h = harness()
    const signal = new AbortController().signal
    await h.operations.submit(saveIntent(), ACTOR, signal)
    h.github.inspectionOutcome = { state: 'incomplete' }
    await h.operations.submit(createPullRequestIntent(), ACTOR, signal)
    const failure = new Error('pending PR inspection failed unexpectedly')
    h.github.inspectionFailure = failure
    await expect(h.operations.pollPending(signal)).rejects.toBe(failure)
    expect(h.intents.get(PULL_REQUEST_INTENT_ID)?.checkpoint.state).toBe('active')
  })

  it.each([false, true])('only confirms a closed PR if it was merged (merged: %s)', async (merged) => {
    const h = harness()
    const signal = new AbortController().signal
    await h.operations.submit(saveIntent(), ACTOR, signal)
    h.github.inspectionOutcome = { state: 'unique-pull-request', pullRequest: {
      ...pullRequestFact('feature/delivery', 'master'), state: 'closed', merged,
    } }
    expect(await h.operations.submit(createPullRequestIntent(), ACTOR, signal)).toMatchObject({ ok: merged })
    expect(h.github.dispatches).toBe(0)
  })

  it('rejects late PR confirmation after a cancellation cleared its Delivery ownership', async () => {
    const h = harness()
    const signal = new AbortController().signal
    await h.operations.submit(saveIntent(), ACTOR, signal)
    const inspect = h.github.inspectMutation.bind(h.github)
    vi.spyOn(h.github, 'inspectMutation').mockImplementationOnce(async (request, lifetime) => {
      const fact = await inspect(request, lifetime)
      h.authority.current = false
      return fact
    })
    h.intents.beforeUpdate = (id, _current, next) => {
      if (id === PULL_REQUEST_INTENT_ID && next.checkpoint.state === 'terminal') throw new Error('cancellation checkpoint lost')
    }
    await expect(h.operations.submit(createPullRequestIntent(), ACTOR, signal)).rejects.toThrow('cancellation checkpoint lost')
    h.intents.beforeUpdate = undefined
    h.authority.current = true
    h.github.pullRequestCreated = true
    await expect(h.operations.submit(createPullRequestIntent(), ACTOR, signal)).rejects.toThrow('lost its Branch Delivery ownership')
    expect(h.github.dispatches).toBe(0)
  })

  it('does not resume a prepared Push after a later Intent seals acceptance', async () => {
    const h = harness()
    const signal = new AbortController().signal
    await h.operations.submit(saveIntent(), ACTOR, signal)
    const delayed = { ...pushIntent(), intentId: IMMUTABLE_INTENT_ID }
    h.deliveries.beforeUpdate = (_id, _current, next) => {
      if (next.activeIntentId === delayed.intentId) throw new Error('ownership not committed')
    }
    await expect(h.operations.submit(delayed, ACTOR, signal)).rejects.toThrow('ownership not committed')
    h.deliveries.beforeUpdate = undefined
    await h.operations.submit(pushIntent(), ACTOR, signal)
    await h.operations.submit(createPullRequestIntent(2), ACTOR, signal)
    await h.operations.submit(inReviewIntent(4), ACTOR, signal)
    await h.operations.submit(acceptIntent(6), ACTOR, signal)
    expect(await h.operations.submit(delayed, ACTOR, signal)).toMatchObject({ ok: false, reason: 'conflict' })
    expect(h.intents.get(delayed.intentId)?.checkpoint).toMatchObject({ state: 'terminal', reason: 'immutable' })
    expect(h.execution.starts).toBe(1)
  })

  it('recovers an updated Save whose terminal write was not committed', async () => {
    const h = harness()
    const signal = new AbortController().signal
    await h.operations.submit(saveIntent(), ACTOR, signal)
    h.intents.beforeUpdate = (id, _current, next) => {
      if (id === UPDATE_INTENT_ID && next.checkpoint.state === 'terminal') throw new Error('updated Save terminal lost')
    }
    const update = saveIntent(UPDATE_INTENT_ID, COMMIT_ID, 0)
    await expect(h.operations.submit(update, ACTOR, signal)).rejects.toThrow('updated Save terminal lost')
    h.intents.beforeUpdate = undefined
    expect(await h.operations.submit(update, ACTOR, signal)).toMatchObject({ ok: true, receipt: { deliveryRevision: 1 } })
  })

  it.each(['revision', 'accepted'] as const)('rejects a queued Save when stored %s changed', async (changed) => {
    const h = harness()
    const signal = new AbortController().signal
    await h.operations.submit(saveIntent(), ACTOR, signal)
    let replacement: BranchDeliveryRecord
    if (changed === 'accepted') {
      const accepted = harness()
      await seedPreSealAcceptancePrefix(accepted)
      await accepted.operations.submit(acceptIntent(6), ACTOR, signal)
      replacement = branchDeliveryRecordSchema.parse({
        ...accepted.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)), revision: 0,
      })
    } else replacement = branchDeliveryRecordSchema.parse({
      ...h.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)), revision: 1,
    })
    const update = h.deliveries.update.bind(h.deliveries)
    vi.spyOn(h.deliveries, 'update').mockImplementationOnce(async (id, operation) => {
      h.deliveries.values.set(id, replacement)
      return await update(id, operation)
    })
    await expect(h.operations.submit(saveIntent(UPDATE_INTENT_ID, COMMIT_ID, 0), ACTOR, signal)).rejects.toThrow()
    expect(h.deliveries.get(replacement.id)).toEqual(replacement)
  })

  it('rejects In Review against another Work Item revision', async () => {
    const h = harness()
    const signal = new AbortController().signal
    await h.operations.submit(saveIntent(), ACTOR, signal)
    await h.operations.submit(pushIntent(), ACTOR, signal)
    await h.operations.submit(createPullRequestIntent(2), ACTOR, signal)
    expect(await h.operations.submit({ ...inReviewIntent(4), expectedWorkItemRemoteFingerprint: REVIEW_FINGERPRINT }, ACTOR, signal))
      .toMatchObject({ ok: false, reason: 'conflict' })
    expect(h.moveAttempts).toEqual([])
  })

  it.each(['authority', 'context'] as const)(
    'rechecks %s before preparing the In Review child', async (changed) => {
      const h = harness()
      const signal = new AbortController().signal
      await h.operations.submit(saveIntent(), ACTOR, signal)
      await h.operations.submit(pushIntent(), ACTOR, signal)
      await h.operations.submit(createPullRequestIntent(2), ACTOR, signal)
      h.intents.beforeUpdate = (id, _current, next) => {
        if (id !== REVIEW_INTENT_ID || next.checkpoint.state !== 'active') return
        if (changed === 'authority') h.authority.current = false
        else h.context.current = { ...h.context.current, projectRevision: 4 }
      }
      expect(await h.operations.submit(inReviewIntent(4), ACTOR, signal)).toMatchObject({ ok: false,
        reason: changed === 'authority' ? 'denied' : 'conflict' })
      expect(h.moveAttempts).toEqual([])
    },
  )

  it('recovers In Review when the aggregate committed before its terminal Intent', async () => {
    const h = harness()
    const signal = new AbortController().signal
    await h.operations.submit(saveIntent(), ACTOR, signal)
    await h.operations.submit(pushIntent(), ACTOR, signal)
    await h.operations.submit(createPullRequestIntent(2), ACTOR, signal)
    h.intents.beforeUpdate = (id, _current, next) => {
      if (id === REVIEW_INTENT_ID && next.checkpoint.state === 'terminal') throw new Error('terminal write failed')
    }
    await expect(h.operations.submit(inReviewIntent(4), ACTOR, signal)).rejects.toThrow('terminal write failed')
    expect(h.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID))?.phase).toBe('in-review')
    expect(await h.operations.submit(saveIntent(UPDATE_INTENT_ID, COMMIT_ID, 6), ACTOR, signal))
      .toEqual({ ok: false, reason: 'unavailable' })
    h.intents.beforeUpdate = undefined
    expect(await h.operations.submit(inReviewIntent(4), ACTOR, signal)).toMatchObject({ ok: true })
    expect(h.moveAttempts).toHaveLength(1)
  })

  it('retains a confirmed remote ref when a complete read reports that ref absent', async () => {
    const h = harness()
    const signal = new AbortController().signal
    await h.operations.submit(saveIntent(), ACTOR, signal)
    await h.operations.refresh(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID), signal)
    const read = h.github.read.bind(h.github)
    vi.spyOn(h.github, 'read').mockImplementation(async (request, lifetime) => request.kind === 'branch-head'
      ? { state: 'absent', repositoryId: request.repositoryId, branch: request.branch, observedAt: 101 }
      : await read(request, lifetime))
    await h.operations.refresh(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID), signal)
    expect(h.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID))?.remoteRef).toMatchObject({
      confirmed: { fact: { state: 'present', commitId: COMMIT_ID } },
      current: { state: 'invalidated', reason: 'target-absent' },
    })
  })

  it.each(['authority', 'context-before-read', 'context-after-read'] as const)(
    'does not apply a prepared Save after losing %s', async (changed) => {
      let missing = false
      const h = harness({
        resolveContext: () => missing ? { ok: false, reason: 'unavailable' } : { ok: true, context: deliveryContext() },
        currentLocalHead: async () => {
          if (changed === 'context-after-read') missing = true
          return { ok: true, commitId: COMMIT_ID }
        },
      })
      const put = h.intents.put.bind(h.intents)
      vi.spyOn(h.intents, 'put').mockImplementationOnce(async (id, value) => {
        await put(id, value)
        if (changed === 'authority') h.authority.current = false
        if (changed === 'context-before-read') missing = true
      })
      expect(await h.operations.submit(saveIntent(), ACTOR, new AbortController().signal)).toMatchObject({ ok: false,
        reason: changed === 'authority' ? 'denied' : 'unavailable' })
      expect(h.deliveries.size).toBe(0)
    },
  )

  it.each([null, 4])('rejects Save revision %s against an existing revision zero Delivery', async (expected) => {
    const h = harness()
    const signal = new AbortController().signal
    await h.operations.submit(saveIntent(), ACTOR, signal)
    expect(await h.operations.submit(saveIntent(UPDATE_INTENT_ID, COMMIT_ID, expected), ACTOR, signal))
      .toMatchObject({ ok: false, reason: 'conflict' })
    expect(h.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID))?.revision).toBe(0)
  })

  it('rejects an update-only Save when the Delivery does not exist', async () => {
    const h = harness()
    expect(await h.operations.submit(saveIntent(SAVE_INTENT_ID, COMMIT_ID, 0), ACTOR, new AbortController().signal))
      .toMatchObject({ ok: false, reason: 'conflict' })
    expect(h.deliveries.size).toBe(0)
  })

  it.each(['pending', 'repair', 'accepted'] as const)('does not replace a %s Delivery with Save', async (state) => {
    const h = harness()
    const signal = new AbortController().signal
    if (state === 'accepted') {
      await seedPreSealAcceptancePrefix(h)
      await h.operations.submit(acceptIntent(6), ACTOR, signal)
    } else {
      await h.operations.submit(saveIntent(), ACTOR, signal)
      h.github.inspectionOutcome = state === 'pending'
        ? { state: 'incomplete' } : { state: 'known-pull-request-absent' }
      await h.operations.submit(createPullRequestIntent(), ACTOR, signal)
    }
    const before = structuredClone(h.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID))!)
    const intent = saveIntent(UPDATE_INTENT_ID, COMMIT_ID, before.revision)
    expect(await h.operations.submit({ ...intent, expected: { ...intent.expected,
      workItemRemoteFingerprint: h.context.current.workItem.remoteFingerprint } }, ACTOR, signal))
      .toMatchObject({ ok: false, reason: 'conflict' })
    expect(h.deliveries.get(before.id)).toEqual(before)
  })

  it.each([false, true])('polls every eligible Delivery despite read failures (all fail: %s)', async (allFail) => {
    const h = harness()
    const signal = new AbortController().signal
    h.additionalContexts.set(SECOND_WORK_ITEM_ID, {
      ...deliveryContext(), workItem: { id: SECOND_WORK_ITEM_ID, remoteFingerprint: REMOTE_FINGERPRINT,
        issueId: githubIssueId('I_issue_33') },
    })
    await h.operations.submit(saveIntent(), ACTOR, signal)
    await h.operations.submit({ ...saveIntent(SECOND_SAVE_INTENT_ID), workItemId: SECOND_WORK_ITEM_ID }, ACTOR, signal)
    const before = [...h.deliveries.values.values()].map(record => record.revision)
    const read = h.github.read.bind(h.github)
    const firstFailure = new Error('first repository read failed unexpectedly')
    let branchReads = 0
    vi.spyOn(h.github, 'read').mockImplementation(async (request, lifetime) => {
      if (request.kind === 'branch-head') {
        branchReads += 1
        if (branchReads === 1 || allFail) throw firstFailure
      }
      return await read(request, lifetime)
    })
    await expect(h.operations.pollPending(signal)).rejects.toBe(firstFailure)
    expect(branchReads).toBe(2)
    expect([...h.deliveries.values.values()].map(record => record.revision))
      .toEqual(allFail ? before : [before[0], before[1]! + 1])
  })

  it('rejects a second provider attachment and makes disposal repeatable', async () => {
    const h = harness()
    expect(() => h.operations.attach(h.github)).toThrow('already attached')
    await h.detachOperations()
    await h.detachOperations()
    const detach = h.operations.attach(h.github)
    await detach()
  })

  it.each(['accepted', 'pending', 'detached'] as const)(
    'does not refresh a Delivery that is %s', async (state) => {
      const h = harness()
      const signal = new AbortController().signal
      if (state === 'accepted') {
        await seedPreSealAcceptancePrefix(h)
        await h.operations.submit(acceptIntent(6), ACTOR, signal)
      } else {
        await h.operations.submit(saveIntent(), ACTOR, signal)
        if (state === 'pending') {
          h.github.inspectionOutcome = { state: 'incomplete' }
          await h.operations.submit(createPullRequestIntent(), ACTOR, signal)
        } else await h.detachOperations()
      }
      const before = h.github.reads.length
      expect(await h.operations.refresh(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID), signal)).toEqual({
        ok: false, reason: state === 'accepted' ? 'immutable' : 'unavailable',
      })
      expect(h.github.reads).toHaveLength(before)
      expect(h.operations.project(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID), Date.now())).toBeDefined()
    },
  )

  it.each(['prepare', 'seal'] as const)(
    'leaves %s acceptance pending while its provider is detached', async (stage) => {
      const h = harness()
      const signal = new AbortController().signal
      if (stage === 'seal') await seedPreSealAcceptancePrefix(h)
      else {
        await h.operations.submit(saveIntent(), ACTOR, signal)
        await h.operations.submit(pushIntent(), ACTOR, signal)
        await h.operations.submit(createPullRequestIntent(2), ACTOR, signal)
        await h.operations.submit(inReviewIntent(4), ACTOR, signal)
      }
      await h.detachOperations()
      expect(await h.operations.submit(acceptIntent(6), ACTOR, signal)).toMatchObject({ ok: false, reason: 'unavailable' })
      expect(h.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID))?.phase).toBe('in-review')
      expect(h.moveAttempts.some(move => move.targetStatus === 'done')).toBe(false)
    },
  )

  it.each(['prepare', 'seal'] as const)(
    'rechecks acceptance authority after %s evidence reads', async (stage) => {
      let revoke = false
      const h = harness({ currentLocalHead: async () => {
        if (revoke) h.authority.current = false
        return { ok: true, commitId: COMMIT_ID, observedAt: Date.now() }
      } })
      const signal = new AbortController().signal
      if (stage === 'seal') await seedPreSealAcceptancePrefix(h)
      else {
        await h.operations.submit(saveIntent(), ACTOR, signal)
        await h.operations.submit(pushIntent(), ACTOR, signal)
        await h.operations.submit(createPullRequestIntent(2), ACTOR, signal)
        await h.operations.submit(inReviewIntent(4), ACTOR, signal)
      }
      revoke = true
      expect(await h.operations.submit(acceptIntent(6), ACTOR, signal)).toMatchObject({ ok: false, reason: 'denied' })
      expect(h.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID))?.phase).toBe('in-review')
      expect(h.moveAttempts.some(move => move.targetStatus === 'done')).toBe(false)
    },
  )

  it.each(['prepare', 'seal'] as const)(
    'rejects %s acceptance when the local Commit cannot be observed', async (stage) => {
      let unavailable = false
      const h = harness({ currentLocalHead: async () => unavailable
        ? { ok: false, reason: 'unavailable' } : { ok: true, commitId: COMMIT_ID } })
      const signal = new AbortController().signal
      if (stage === 'seal') await seedPreSealAcceptancePrefix(h)
      else {
        await h.operations.submit(saveIntent(), ACTOR, signal)
        await h.operations.submit(pushIntent(), ACTOR, signal)
        await h.operations.submit(createPullRequestIntent(2), ACTOR, signal)
        await h.operations.submit(inReviewIntent(4), ACTOR, signal)
      }
      unavailable = true
      expect(await h.operations.submit(acceptIntent(6), ACTOR, signal)).toMatchObject({ ok: false })
      expect(h.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID))?.phase).toBe('in-review')
      expect(h.moveAttempts.some(move => move.targetStatus === 'done')).toBe(false)
    },
  )

  it.each(['before-inspection', 'after-effect-checkpoint'] as const)(
    'does not create a PR after its context changes %s', async (point) => {
      const h = harness()
      const signal = new AbortController().signal
      await h.operations.submit(saveIntent(), ACTOR, signal)
      const changeContext = () => { h.context.current = { ...h.context.current, projectRevision: 4 } }
      if (point === 'before-inspection') {
        const inspect = h.github.inspectMutation.bind(h.github)
        vi.spyOn(h.github, 'inspectMutation').mockImplementationOnce(async (request, lifetime) => {
          const fact = await inspect(request, lifetime)
          changeContext()
          return fact
        })
      } else {
        h.intents.beforeUpdate = (_key, _current, next) => {
          if (next.checkpoint.state === 'pull-request-effect-possible') changeContext()
        }
      }
      expect(await h.operations.submit(createPullRequestIntent(), ACTOR, signal)).toMatchObject({ ok: false,
        reason: point === 'before-inspection' ? 'conflict' : 'reconciliation-required' })
      expect(h.github.dispatches).toBe(0)
    },
  )

  it('does not associate a PR after its authorization changes during the targeted read', async () => {
    const h = harness()
    const signal = new AbortController().signal
    await h.operations.submit(saveIntent(), ACTOR, signal)
    h.github.pullRequestCreated = true
    const read = h.github.read.bind(h.github)
    vi.spyOn(h.github, 'read').mockImplementationOnce(async (request, lifetime) => {
      const fact = await read(request, lifetime)
      h.authority.current = false
      return fact
    })
    expect(await h.operations.submit(associatePullRequestIntent(), ACTOR, signal)).toMatchObject({ ok: false, reason: 'conflict' })
    expect(h.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID))?.pullRequest.confirmed).toBeUndefined()
  })

  it('retains association pending without the Product App provider', async () => {
    const h = harness()
    const signal = new AbortController().signal
    await h.operations.submit(saveIntent(), ACTOR, signal)
    await h.detachOperations()
    expect(await h.operations.submit(associatePullRequestIntent(), ACTOR, signal)).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(h.intents.get(ASSOCIATE_INTENT_ID)?.checkpoint.state).toBe('active')
  })

  it.each(['intent-put', 'delivery-put', 'intent-update', 'delivery-update', 'save-update'] as const)(
    'recovers a committed %s write whose acknowledgement is lost', async (write) => {
      const h = harness()
      const signal = new AbortController().signal
      if (write === 'delivery-update' || write === 'save-update') {
        await h.operations.submit(saveIntent(), ACTOR, signal)
      }
      const fault = new Error('storage acknowledgement lost')
      if (write === 'intent-put') {
        const put = h.intents.put.bind(h.intents)
        vi.spyOn(h.intents, 'put').mockImplementationOnce(async (id, value) => { await put(id, value); throw fault })
      } else if (write === 'delivery-put') {
        const put = h.deliveries.put.bind(h.deliveries)
        vi.spyOn(h.deliveries, 'put').mockImplementationOnce(async (id, value) => { await put(id, value); throw fault })
      } else if (write === 'intent-update') {
        const update = h.intents.update.bind(h.intents)
        vi.spyOn(h.intents, 'update').mockImplementationOnce(async (id, operation) => { await update(id, operation); throw fault })
      } else {
        const update = h.deliveries.update.bind(h.deliveries)
        vi.spyOn(h.deliveries, 'update').mockImplementationOnce(async (id, operation) => { await update(id, operation); throw fault })
      }
      const intent = write === 'delivery-update' ? createPullRequestIntent()
        : write === 'save-update' ? saveIntent(UPDATE_INTENT_ID, COMMIT_ID, 0) : saveIntent()
      expect(await h.operations.submit(intent, ACTOR, signal)).toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
      h.operations.validateDurableState(new Set())
      expect(await h.operations.submit(intent, ACTOR, signal)).toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
      expect(h.github.dispatches).toBe(write === 'delivery-update' ? 1 : 0)
    },
  )

  it.each(['intent-put', 'delivery-put', 'save-update'] as const)(
    'does not acknowledge an uncommitted %s write', async (write) => {
      const h = harness()
      const signal = new AbortController().signal
      if (write === 'save-update') await h.operations.submit(saveIntent(), ACTOR, signal)
      const fault = new Error('storage write failed')
      if (write === 'intent-put') vi.spyOn(h.intents, 'put').mockRejectedValueOnce(fault)
      else if (write === 'delivery-put') vi.spyOn(h.deliveries, 'put').mockRejectedValueOnce(fault)
      else vi.spyOn(h.deliveries, 'update').mockRejectedValueOnce(fault)
      const intent = write === 'save-update' ? saveIntent(UPDATE_INTENT_ID, COMMIT_ID, 0) : saveIntent()
      await expect(h.operations.submit(intent, ACTOR, signal)).rejects.toBe(fault)
      expect(await h.operations.submit(intent, ACTOR, signal)).toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
      h.operations.validateDurableState(new Set())
    },
  )

  it.each(['reserve', 'accept', 'release'] as const)(
    'recovers a committed Push admission %s write whose acknowledgement is lost', async (phase) => {
      const h = harness()
      const signal = new AbortController().signal
      await h.operations.submit(saveIntent(), ACTOR, signal)
      const update = h.admissions.update.bind(h.admissions)
      let writes = 0
      vi.spyOn(h.admissions, 'update').mockImplementation(async (id, operation) => {
        const saved = await update(id, operation)
        writes += 1
        if (writes === ({ reserve: 1, accept: 2, release: 3 })[phase]) throw new Error('admission acknowledgement lost')
        return saved
      })
      expect(await h.operations.submit(pushIntent(), ACTOR, signal)).toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
      expect(h.admissions.get(BINDING_ID)).toMatchObject({ state: 'available', revision: 3 })
      expect(h.execution.starts).toBe(1)
      h.operations.validateDurableState(new Set())
    },
  )

  it.each(['branch-head', 'pull-request', 'commit-ci'] as const)(
    'rejects acceptance when required %s evidence cannot be read', async (kind) => {
      const h = harness()
      const signal = new AbortController().signal
      await h.operations.submit(saveIntent(), ACTOR, signal)
      await h.operations.submit(pushIntent(), ACTOR, signal)
      await h.operations.submit(createPullRequestIntent(2), ACTOR, signal)
      await h.operations.submit(inReviewIntent(4), ACTOR, signal)
      h.github.failures.set(kind, { code: 'transient-transport' })
      expect(await h.operations.submit(acceptIntent(6), ACTOR, signal)).toMatchObject({ ok: false })
      expect(h.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID))).toMatchObject({ phase: 'in-review' })
      expect(h.moveAttempts.map(move => move.targetStatus)).toEqual(['in-review'])
      h.operations.validateDurableState(new Set())
    },
  )

  it.each(['branch-head', 'pull-request', 'commit-ci'] as const)(
    'does not seal prepared acceptance when its repeated %s read fails', async (kind) => {
      const h = harness()
      await seedPreSealAcceptancePrefix(h)
      h.github.failures.set(kind, { code: 'transient-transport' })
      expect(await h.operations.submit(acceptIntent(6), ACTOR, new AbortController().signal)).toMatchObject({ ok: false })
      expect(h.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID))).toMatchObject({ phase: 'in-review' })
      expect(h.moveAttempts).toEqual([])
      h.operations.validateDurableState(new Set())
    },
  )

  it.each(['failed', 'effect-unknown', 'evidence-conflict'] as const)(
    'retains the Host %s outcome without claiming a successful Push', async (state) => {
      const h = harness()
      const signal = new AbortController().signal
      await h.operations.submit(saveIntent(), ACTOR, signal)
      h.execution.afterStart = (snapshot) => {
        const { result: _result, completedAt, ...base } = snapshot
        return state === 'failed'
          ? { ...base, state: 'failed', completedAt, failure: { reason: 'binding-stale' }, effect: 'none' }
          : { ...base, state: 'reconciliation-required', observedAt: completedAt, reason: state }
      }
      expect(await h.operations.submit(pushIntent(), ACTOR, signal)).toMatchObject({
        ok: false, reason: state === 'failed' ? 'unavailable' : 'reconciliation-required',
      })
      const record = branchDeliveryRecordSchema.parse(h.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)))
      expect(record.push).toBeUndefined()
      expect(record.activeIntentId).toBeUndefined()
      expect(h.admissions.get(BINDING_ID)?.state).toBe(state === 'failed' ? 'available' : 'manual-host-operation')
      expect(() => h.operations.validateDurableState(new Set())).not.toThrow()
      await h.operations.submit(pushIntent(), ACTOR, signal)
      expect(h.execution.starts).toBe(1)
    },
  )

  it('wakes a pending Push from a Host notification and retains its exact terminal snapshot', async () => {
    const h = harness()
    const signal = new AbortController().signal
    await h.operations.submit(saveIntent(), ACTOR, signal)
    let completed: Extract<HostOperationSnapshot<'push-branch'>, { state: 'succeeded' }> | undefined
    h.execution.afterStart = (snapshot) => {
      completed = snapshot
      const { result: _result, completedAt: _completedAt, ...base } = snapshot
      return { ...base, state: 'accepted' }
    }
    expect(await h.operations.submit(pushIntent(), ACTOR, signal)).toMatchObject({ ok: false, reason: 'unavailable' })
    if (completed === undefined) throw new Error('Host did not accept the Push')
    h.execution.snapshot = completed
    h.operations.hostChanged({ operation: completed.operation, revision: completed.revision })
    await h.operations.dispose()
    expect(h.intents.get(PUSH_INTENT_ID)?.checkpoint).toMatchObject({
      state: 'terminal', outcome: 'succeeded', host: { snapshot: completed },
    })
    expect(h.execution.starts).toBe(1)
    expect(h.admissions.get(BINDING_ID)?.state).toBe('available')
    h.operations.hostChanged({ operation: completed.operation, revision: completed.revision })
    await h.operations.dispose()
    expect(h.execution.starts).toBe(1)
  })

  it('ignores a Host notification that has no retained Push owner', async () => {
    const h = harness()
    h.operations.hostChanged({
      operation: { id: 'host-operation-00000000-0000-4000-8000-000000000212' as HostOperationId, hostId: ACTOR.hostId, type: 'push-branch' },
      revision: 0,
    })
    await h.operations.dispose()
    expect(h.intents.size).toBe(0)
    expect(h.execution.starts).toBe(0)
  })

  it.each(['incomplete', 'multiple-matches', 'marker-removed', 'known-pull-request-absent', 'identity-conflict'] as const)(
    'does not create a PR when complete-marker inspection reports %s', async (state) => {
      const h = harness()
      const signal = new AbortController().signal
      await h.operations.submit(saveIntent(), ACTOR, signal)
      h.github.inspectionOutcome = { state }
      expect(await h.operations.submit(createPullRequestIntent(), ACTOR, signal)).toMatchObject({
        ok: false, reason: state === 'incomplete' ? 'unavailable' : 'reconciliation-required',
      })
      expect(h.github.dispatches).toBe(0)
      const record = branchDeliveryRecordSchema.parse(h.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)))
      if (state !== 'incomplete') {
        expect(record.repair?.reason).toBe(state === 'multiple-matches' ? 'marker-ambiguous' : 'evidence-conflict')
        expect(h.operations.project(record.id, Date.now())?.delivery.repair).toEqual(record.repair)
      }
      expect(() => h.operations.validateDurableState(new Set())).not.toThrow()
    },
  )

  it.each(['incomplete', 'absent-complete', 'multiple-matches', 'known-pull-request-absent', 'marker-removed'] as const)(
    'does not redispatch an uncertain PR effect whose recovery reports %s', async (state) => {
      const h = harness()
      const signal = new AbortController().signal
      await h.operations.submit(saveIntent(), ACTOR, signal)
      h.github.crashAfterCreate = true
      await expect(h.operations.submit(createPullRequestIntent(), ACTOR, signal)).rejects.toThrow(SimulatedProcessCrash)
      h.github.inspectionOutcome = { state }
      expect(await h.operations.submit(createPullRequestIntent(), ACTOR, signal)).toMatchObject({
        ok: false, reason: state === 'incomplete' ? 'unavailable' : 'reconciliation-required',
      })
      expect(h.github.dispatches).toBe(1)
      expect(() => h.operations.validateDurableState(new Set())).not.toThrow()
    },
  )

  it.each(['before-dispatch', 'after-dispatch'] as const)('keeps PR recovery pending when inspection fails %s', async (when) => {
    const h = harness()
    const signal = new AbortController().signal
    await h.operations.submit(saveIntent(), ACTOR, signal)
    if (when === 'after-dispatch') {
      h.github.crashAfterCreate = true
      await expect(h.operations.submit(createPullRequestIntent(), ACTOR, signal)).rejects.toThrow(SimulatedProcessCrash)
    }
    h.github.inspectionFailure = new GitHubProviderError({ code: 'transient-transport' })
    expect(await h.operations.submit(createPullRequestIntent(), ACTOR, signal)).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(h.intents.get(PULL_REQUEST_INTENT_ID)?.checkpoint.state)
      .toBe(when === 'before-dispatch' ? 'active' : 'pull-request-effect-possible')
    h.github.inspectionFailure = undefined
    h.github.crashAfterCreate = false
    expect(await h.operations.submit(createPullRequestIntent(), ACTOR, signal)).toMatchObject({ ok: true })
    expect(h.github.dispatches).toBe(1)
  })

  it('confirms a PR accepted by GitHub even when its HTTP response is lost', async () => {
    const h = harness()
    const signal = new AbortController().signal
    await h.operations.submit(saveIntent(), ACTOR, signal)
    h.github.dispatchFailure = new GitHubProviderError({ code: 'transient-transport' })
    expect(await h.operations.submit(createPullRequestIntent(), ACTOR, signal))
      .toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
    expect(h.github.dispatches).toBe(1)
    expect(h.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID))?.pullRequest.confirmed?.fact.id)
      .toBe(h.github.pullRequestId)
  })

  it('rejects a matching marker whose Pull Request targets another Commit', async () => {
    const h = harness()
    const signal = new AbortController().signal
    await h.operations.submit(saveIntent(), ACTOR, signal)
    h.github.inspectionOutcome = {
      state: 'unique-pull-request', pullRequest: pullRequestFact('feature/delivery', 'master', UPDATED_COMMIT_ID, 100),
    }
    expect(await h.operations.submit(createPullRequestIntent(), ACTOR, signal))
      .toMatchObject({ ok: false, reason: 'reconciliation-required' })
    expect(h.github.dispatches).toBe(0)
    expect(h.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID))?.repair?.reason).toBe('evidence-conflict')
  })

  it.each(['missing', 'authority', 'revision', 'context', 'head-unavailable', 'head-conflict', 'late-authority', 'late-context'] as const)(
    'recovers a prepared Push after %s changes without sending stale Git work', async (changed) => {
      let resumed = false
      const h = harness({ currentLocalHead: async () => {
        if (resumed && changed === 'head-unavailable') return { ok: false, reason: 'unavailable' }
        if (resumed && changed === 'head-conflict') return { ok: false, reason: 'conflict' }
        if (resumed && changed === 'late-authority') h.authority.current = false
        if (resumed && changed === 'late-context') h.context.current.projectRevision += 1
        return { ok: true, commitId: COMMIT_ID }
      } })
      const signal = new AbortController().signal
      await h.operations.submit(saveIntent(), ACTOR, signal)
      h.deliveries.beforeUpdate = (_key, _current, next) => {
        if (next.activeIntentId === PUSH_INTENT_ID) throw new SimulatedProcessCrash('before Push ownership write')
      }
      await expect(h.operations.submit(pushIntent(), ACTOR, signal)).rejects.toThrow('before Push ownership write')
      h.deliveries.beforeUpdate = undefined
      expect(h.intents.get(PUSH_INTENT_ID)?.checkpoint).toEqual({ state: 'prepared' })
      expect(() => h.operations.validateDurableState(new Set())).not.toThrow()
      if (changed === 'missing') h.deliveries.values.clear()
      if (changed === 'authority') h.authority.current = false
      if (changed === 'revision') await h.operations.submit(saveIntent(UPDATE_INTENT_ID, COMMIT_ID, 0), ACTOR, signal)
      if (changed === 'context') h.context.current.projectRevision += 1
      resumed = true
      const result = await h.operations.submit(pushIntent(), ACTOR, signal)
      expect(result).toMatchObject(changed === 'head-unavailable'
        ? { ok: true, receipt: { state: 'pending' } }
        : { ok: false, reason: changed === 'authority' || changed === 'late-authority' ? 'denied' : 'conflict' })
      expect(h.execution.starts).toBe(0)
      expect(h.intents.get(PUSH_INTENT_ID)?.checkpoint.state).toBe(changed === 'head-unavailable' ? 'prepared' : 'terminal')
      expect(() => h.operations.validateDurableState(new Set())).not.toThrow()
    },
  )

  it('recovers a Push ownership write whose active checkpoint was not acknowledged', async () => {
    const h = harness()
    const signal = new AbortController().signal
    await h.operations.submit(saveIntent(), ACTOR, signal)
    h.intents.beforeUpdate = (key, _current, next) => {
      if (key === PUSH_INTENT_ID && next.checkpoint.state === 'active') throw new SimulatedProcessCrash('before active checkpoint')
    }
    await expect(h.operations.submit(pushIntent(), ACTOR, signal)).rejects.toThrow('before active checkpoint')
    h.intents.beforeUpdate = undefined
    expect(h.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID))).toMatchObject({ activeIntentId: PUSH_INTENT_ID })
    expect(h.intents.get(PUSH_INTENT_ID)?.checkpoint.state).toBe('prepared')
    const restart = h.createDetachedOperations()
    await restart.initializeValidated(restart.validateDurableState(new Set()))
    expect(h.intents.get(PUSH_INTENT_ID)?.checkpoint).toMatchObject({ state: 'terminal', outcome: 'succeeded' })
    expect(h.execution.starts).toBe(1)
    expect(h.admissions.get(BINDING_ID)).toMatchObject({ state: 'available' })
  })

  it.each(['before-read', 'after-read'] as const)('keeps a prepared Push pending when its context disappears %s', async (when) => {
    let resumed = false
    let available = true
    const h = harness({
      resolveContext: () => available ? { ok: true, context: h.context.current } : { ok: false, reason: 'unavailable' },
      currentLocalHead: async () => {
        if (resumed && when === 'after-read') available = false
        return { ok: true, commitId: COMMIT_ID }
      },
    })
    const signal = new AbortController().signal
    await h.operations.submit(saveIntent(), ACTOR, signal)
    h.deliveries.beforeUpdate = () => { throw new SimulatedProcessCrash('before Push ownership write') }
    await expect(h.operations.submit(pushIntent(), ACTOR, signal)).rejects.toThrow('before Push ownership write')
    h.deliveries.beforeUpdate = undefined
    resumed = true
    if (when === 'before-read') available = false
    expect(await h.operations.submit(pushIntent(), ACTOR, signal)).toMatchObject({ ok: true, receipt: { state: 'pending' } })
    expect(h.intents.get(PUSH_INTENT_ID)?.checkpoint.state).toBe('prepared')
    expect(h.execution.starts).toBe(0)
  })

  it.each<readonly [string, (record: BranchDeliveryIntentRecord) => unknown, string]>([
    ['another id', record => ({ ...record, id: UPDATE_INTENT_ID }), 'id disagrees with its payload'],
    ['backward time', record => ({ ...record, updatedAt: record.createdAt - 1 }), 'timestamps are not monotonic'],
    ['another operation', record => ({ ...record, operation: { kind: 'save' } }), 'operation disagrees'],
    ['missing terminal revision', record => ({
      ...record, checkpoint: { state: 'terminal', outcome: 'succeeded' },
    }), 'terminal checkpoint lacks its result evidence'],
    ['missing failure reason', record => ({
      ...record, checkpoint: { state: 'terminal', outcome: 'failure', deliveryRevision: 2 },
    }), 'terminal checkpoint lacks its result evidence'],
    ['a success with a failure reason', record => ({
      ...record, checkpoint: { state: 'terminal', outcome: 'succeeded', deliveryRevision: 2, reason: 'authority' },
    }), 'terminal checkpoint lacks its result evidence'],
    ['a PR checkpoint for a Push', record => ({
      ...record, checkpoint: { state: 'pull-request-effect-possible', deliveryRevision: 1 },
    }), 'checkpoint disagrees with its operation'],
    ['a substituted Push source', record => ({
      ...record,
      operation: record.operation.kind === 'push' ? {
        ...record.operation, request: {
          ...record.operation.request, source: { ...record.operation.request.source, intentId: UPDATE_INTENT_ID },
        },
      } : record.operation,
    }), 'Push source is not its admitting Intent'],
    ['a terminal Host from another Binding', record => ({
      ...record, checkpoint: record.checkpoint.state === 'terminal' && record.checkpoint.host !== undefined ? {
        ...record.checkpoint,
        host: {
          ...record.checkpoint.host,
          snapshot: { ...record.checkpoint.host.snapshot, bindingRevision: 99 },
        },
      } : record.checkpoint,
    }), 'terminal Host evidence changed identity'],
  ])('rejects a persisted Push Intent with %s', async (_name, corrupt, message) => {
    const h = harness()
    const signal = new AbortController().signal
    await h.operations.submit(saveIntent(), ACTOR, signal)
    await h.operations.submit(pushIntent(0), ACTOR, signal)
    const record = branchDeliveryIntentRecordSchema.parse(h.intents.get(PUSH_INTENT_ID))
    const parsed = branchDeliveryIntentRecordSchema.safeParse(corrupt(record))
    expect(parsed.success).toBe(false)
    if (parsed.success) throw new Error('inconsistent Push Intent was accepted')
    expect(parsed.error.issues.map(issue => issue.message)).toContainEqual(expect.stringContaining(message))
  })

  it.each(['move-id', 'status', 'fingerprint', 'ci', 'digest'] as const)(
    'rejects a persisted acceptance child checkpoint with changed %s', async (changed) => {
      const h = harness()
      const signal = new AbortController().signal
      await h.operations.submit(saveIntent(), ACTOR, signal)
      await h.operations.submit(pushIntent(0), ACTOR, signal)
      await h.operations.submit(createPullRequestIntent(2), ACTOR, signal)
      await h.operations.submit(inReviewIntent(4), ACTOR, signal)
      h.moveUnavailableOnce.add('done')
      await h.operations.submit(acceptIntent(6), ACTOR, signal)
      const record = branchDeliveryIntentRecordSchema.parse(h.intents.get(ACCEPT_INTENT_ID))
      const checkpoint = record.checkpoint
      if (checkpoint.state !== 'child-pending') throw new Error('acceptance did not retain its child checkpoint')
      const parsed = branchDeliveryIntentRecordSchema.safeParse({
        ...record,
        checkpoint: {
          ...checkpoint,
          move: {
            ...checkpoint.move,
            ...(changed === 'move-id' ? { intentId: SAVE_INTENT_ID } : {}),
            ...(changed === 'status' ? { targetStatus: 'in-review' } : {}),
            ...(changed === 'fingerprint' ? { expectedRemoteFingerprint: REMOTE_FINGERPRINT } : {}),
          },
          evidence: {
            ...checkpoint.evidence,
            ...(changed === 'ci' ? { ci: undefined } : {}),
            ...(changed === 'digest' ? { digest: '0'.repeat(64) } : {}),
          },
        },
      })
      expect(parsed.success).toBe(false)
      if (parsed.success) throw new Error('inconsistent acceptance checkpoint was accepted')
      expect(parsed.error.issues.map(issue => issue.message)).toContain(changed === 'digest'
        ? 'Branch Delivery transition evidence digest is inconsistent' : 'Branch Delivery child checkpoint is not replayable')
    },
  )

  it.each(['delivery-key', 'intent-key', 'duplicate-kind', 'save-target', 'missing-last', 'missing-project'] as const)(
    'rejects %s corruption before restarting Branch Delivery work', async (changed) => {
      const h = harness()
      await h.operations.submit(saveIntent(), ACTOR, new AbortController().signal)
      const id = branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)
      const otherId = branchDeliveryId(PROJECT_ID, SECOND_WORK_ITEM_ID)
      const delivery = branchDeliveryRecordSchema.parse(h.deliveries.get(id))
      const intent = branchDeliveryIntentRecordSchema.parse(h.intents.get(SAVE_INTENT_ID))
      expect(() => h.operations.validateDurableState(new Set())).not.toThrow()
      const messages = {
        'delivery-key': 'Branch Delivery id disagrees with its table key',
        'intent-key': 'Branch Delivery Intent id disagrees with its table key',
        'duplicate-kind': 'is retained by multiple Intent kinds',
        'save-target': 'Branch Delivery save Intent targets another aggregate',
        'missing-last': 'Branch Delivery last Intent reference is inconsistent',
        'missing-project': 'Branch Delivery save Intent targets a missing Development Project',
      }
      if (changed === 'delivery-key') {
        h.deliveries.values.delete(id)
        h.deliveries.values.set(otherId, delivery)
      } else if (changed === 'intent-key') {
        h.intents.values.delete(SAVE_INTENT_ID)
        h.intents.values.set(UPDATE_INTENT_ID, intent)
      } else if (changed === 'save-target') {
        h.intents.values.set(SAVE_INTENT_ID, { ...intent, deliveryId: otherId })
      } else if (changed === 'missing-last') {
        h.intents.values.delete(SAVE_INTENT_ID)
      } else if (changed === 'missing-project') {
        h.deliveries.values.clear()
        h.projectPresent.current = false
      }
      expect(() => h.operations.validateDurableState(new Set(changed === 'duplicate-kind' ? [SAVE_INTENT_ID] : [])))
        .toThrow(messages[changed])
      expect(h.github.reads).toEqual([])
      expect(h.execution.starts).toBe(0)
    },
  )

  it.each(['save', 'push', 'create', 'associate', 'review', 'accept'] as const)(
    'rejects unauthorized %s without retaining an Intent or invoking providers', async (kind) => {
      const h = harness()
      h.authority.current = false
      const intents = {
        save: saveIntent(), push: pushIntent(), create: createPullRequestIntent(),
        associate: associatePullRequestIntent(), review: inReviewIntent(0), accept: acceptIntent(0),
      }
      expect(await h.operations.submit(intents[kind], ACTOR, new AbortController().signal))
        .toEqual({ ok: false, reason: 'denied' })
      expect(h.intents.size).toBe(0)
      expect(h.deliveries.size).toBe(0)
      expect(h.github.reads).toEqual([])
      expect(h.execution.starts).toBe(0)
    },
  )

  it('rejects a missing delivery without creating an orphan operation', async () => {
    const h = harness()
    expect(await h.operations.submit(pushIntent(), ACTOR, new AbortController().signal))
      .toEqual({ ok: false, reason: 'unavailable' })
    expect(h.intents.size).toBe(0)
    expect(h.operations.project(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID), 100)).toBeUndefined()
    expect(await h.operations.refresh(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID), new AbortController().signal))
      .toEqual({ ok: false, reason: 'not-found' })
    await h.operations.dispose()
  })

  it('rejects a Save for an unresolved Work Item without retaining it', async () => {
    const h = harness()
    expect(await h.operations.submit({ ...saveIntent(), workItemId: SECOND_WORK_ITEM_ID }, ACTOR, new AbortController().signal))
      .toEqual({ ok: false, reason: 'unavailable' })
    expect(h.intents.size).toBe(0)
  })

  it.each(['unavailable', 'conflict'] as const)('retains the correct Save outcome when local HEAD is %s', async (reason) => {
    const h = harness({ currentLocalHead: async () => ({ ok: false, reason }) })
    const intent = saveIntent()
    expect(await h.operations.submit(intent, ACTOR, new AbortController().signal))
      .toMatchObject({ ok: false, reason: reason === 'unavailable' ? 'unavailable' : 'conflict' })
    expect(h.deliveries.size).toBe(0)
    expect(h.intents.get(SAVE_INTENT_ID)?.checkpoint).toMatchObject(reason === 'unavailable'
      ? { state: 'prepared' } : { state: 'terminal', outcome: 'conflict', reason: 'expected-evidence' })
  })

  it.each(['registryRevision', 'projectRevision', 'synchronizationRevision', 'mappingRevision'] as const)(
    'rejects Save evidence after %s advances', async (field) => {
      const h = harness()
      h.context.current = { ...h.context.current, [field]: h.context.current[field] + 1 }
      expect(await h.operations.submit(saveIntent(), ACTOR, new AbortController().signal))
        .toMatchObject({ ok: false, reason: 'conflict' })
      expect(h.deliveries.size).toBe(0)
    },
  )

  it('rejects replaying a Save id with a different selected Commit', async () => {
    const h = harness()
    const signal = new AbortController().signal
    await h.operations.submit(saveIntent(), ACTOR, signal)
    expect(await h.operations.submit(saveIntent(SAVE_INTENT_ID, UPDATED_COMMIT_ID), ACTOR, signal))
      .toEqual({ ok: false, reason: 'conflict' })
    expect(h.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID))).toMatchObject({ commitId: COMMIT_ID, revision: 0 })
  })

  it.each(['revision', 'context', 'head'] as const)('rejects a Push whose selected %s changed', async (changed) => {
    const h = harness()
    const signal = new AbortController().signal
    await h.operations.submit(saveIntent(), ACTOR, signal)
    if (changed === 'context') h.context.current.projectRevision += 1
    if (changed === 'head') h.localHead.current = UPDATED_COMMIT_ID
    expect(await h.operations.submit(pushIntent(changed === 'revision' ? 1 : 0), ACTOR, signal))
      .toMatchObject({ ok: false, reason: 'conflict' })
    expect(h.execution.starts).toBe(0)
    expect(h.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID))).not.toHaveProperty('activeIntentId')
  })

  it.each(['in-review', 'done'] as const)('preserves delivery evidence when the %s child cannot complete', async (status) => {
    for (const outcome of ['pending', 'conflict', 'reconciliation-required'] as const) {
      const h = harness({ moveWorkItem: async (request) => {
        if (request.targetStatus === status) return { state: outcome }
        h.context.current.workItem.remoteFingerprint = REVIEW_FINGERPRINT
        return { state: 'succeeded', remoteFingerprint: REVIEW_FINGERPRINT }
      } })
      const signal = new AbortController().signal
      await h.operations.submit(saveIntent(), ACTOR, signal)
      await h.operations.submit(pushIntent(0), ACTOR, signal)
      await h.operations.submit(createPullRequestIntent(2), ACTOR, signal)
      if (status === 'done') await h.operations.submit(inReviewIntent(4), ACTOR, signal)
      const intent = status === 'in-review' ? inReviewIntent(4) : acceptIntent(6)
      const result = await h.operations.submit(intent, ACTOR, signal)
      expect(result).toMatchObject({
        ok: false,
        reason: outcome === 'pending' ? 'unavailable'
          : status === 'done' || outcome === 'reconciliation-required' ? 'reconciliation-required' : 'conflict',
      })
      const record = branchDeliveryRecordSchema.parse(h.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)))
      expect(record.phase).toBe(status === 'done' ? 'accepted' : 'draft')
      expect(() => h.operations.validateDurableState(new Set())).not.toThrow()
      const dispatches = h.github.dispatches
      await h.operations.submit(intent, ACTOR, signal)
      expect(h.github.dispatches).toBe(dispatches)
      await h.operations.dispose()
    }
  })

  it.each<readonly [string, (record: BranchDeliveryRecord) => unknown, string]>([
    ['Work Item identity', record => ({ ...record, workItemId: SECOND_WORK_ITEM_ID }),
      'Branch Delivery target Work Item disagrees with its identity'],
    ['creation time', record => ({ ...record, updatedAt: record.createdAt - 1 }),
      'Branch Delivery contains invalid relationship evidence'],
    ['missing acceptance', record => ({ ...record, acceptance: undefined }),
      'Branch Delivery acceptance disagrees with its phase'],
    ['unaccepted phase', record => ({ ...record, phase: 'in-review' }),
      'Branch Delivery acceptance disagrees with its phase'],
    ['mutable accepted owner', record => ({ ...record, activeIntentId: ACCEPT_INTENT_ID }),
      'accepted Branch Delivery retains a mutable Intent owner'],
    ['equal refs', record => ({ ...record, headRef: record.baseRef }),
      'Branch Delivery contains inconsistent GitHub identities'],
    ['active repair', record => ({ ...record, phase: 'draft', acceptance: undefined,
      activeIntentId: PUSH_INTENT_ID,
      repair: { intentId: PUSH_INTENT_ID, reason: 'effect-unknown', recordedAt: record.updatedAt } }),
    'Branch Delivery cannot be active and awaiting repair'],
    ['Push Commit', record => ({ ...record, push: { ...record.push,
      result: { ...record.push?.result, commitId: UPDATED_COMMIT_ID } } }),
    'Branch Delivery Push result targets another Commit or ref'],
    ['remote Commit', record => ({ ...record, remoteRef: { ...record.remoteRef,
      confirmed: { ...record.remoteRef.confirmed,
        fact: { ...record.remoteRef.confirmed?.fact, commitId: UPDATED_COMMIT_ID } } } }),
    'Branch Delivery remote-ref confirmation targets another Commit'],
    ['Pull Request base', record => ({ ...record, pullRequest: { ...record.pullRequest,
      confirmed: { ...record.pullRequest.confirmed,
        fact: { ...record.pullRequest.confirmed?.fact,
          base: { ...record.pullRequest.confirmed?.fact.base, ref: 'other-base' } } } } }),
    'Branch Delivery Pull Request confirmation targets another delivery'],
    ['CI Commit', record => ({ ...record, ci: { ...record.ci,
      confirmed: { ...record.ci.confirmed,
        fact: { ...record.ci.confirmed?.fact, commitId: UPDATED_COMMIT_ID } } } }),
    'Branch Delivery CI confirmation targets another Commit'],
    ['missing Push', record => ({ ...record, push: undefined }),
      'advanced Branch Delivery lacks confirmed Push and Pull Request evidence'],
    ['missing Pull Request', record => ({ ...record,
      pullRequest: { current: { state: 'unobserved' } } }),
    'advanced Branch Delivery lacks confirmed Push and Pull Request evidence'],
    ['acceptance digest', record => ({ ...record, acceptance: { ...record.acceptance,
      evidence: { ...record.acceptance?.evidence, digest: '0'.repeat(64) } } }),
    'Branch Delivery acceptance evidence is inconsistent'],
    ['confirmation before observation', record => ({ ...record, ci: { ...record.ci,
      confirmed: { ...record.ci.confirmed, confirmedAt: 0 } } }),
    'source confirmation predates its observation'],
    ['missing confirmed fact', record => ({ ...record, ci: {
      current: { state: 'confirmed', observedAt: 100 } } }),
    'current source confirmation lacks the same exact fact'],
    ['different confirmed observation', record => ({ ...record, ci: { ...record.ci,
      current: { state: 'confirmed', observedAt: 0 } } }),
    'current source confirmation lacks the same exact fact'],
  ])('rejects durable accepted Delivery corruption: %s', async (_name, corrupt, message) => {
    const test = harness()
    const signal = new AbortController().signal
    await test.operations.submit(saveIntent(), ACTOR, signal)
    await test.operations.submit(pushIntent(), ACTOR, signal)
    await test.operations.submit(createPullRequestIntent(2), ACTOR, signal)
    await test.operations.submit(inReviewIntent(4), ACTOR, signal)
    await test.operations.submit(acceptIntent(6), ACTOR, signal)
    const record = branchDeliveryRecordSchema.parse(test.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)))
    expect(record.phase).toBe('accepted')
    const parsed = branchDeliveryRecordSchema.safeParse(corrupt(record))
    expect(parsed.success).toBe(false)
    if (parsed.success) throw new Error('corrupt durable Delivery was accepted')
    expect(parsed.error.issues.map(issue => issue.message)).toContain(message)
  })

  it('does not request reviews before an exact Pull Request is known', async () => {
    const test = harness()
    await test.operations.submit(saveIntent(), ACTOR, new AbortController().signal)

    await test.operations.refresh(
      branchDeliveryId(PROJECT_ID, WORK_ITEM_ID),
      new AbortController().signal,
    )

    expect(test.github.reads).not.toContain('pull-request-reviews')
    expect(test.operations.project(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID), 100)?.reviews.current)
      .toEqual({ state: 'unobserved' })
  })

  it('polls eligible durable deliveries in one aggregate-owned pass', async () => {
    const test = harness()
    await test.operations.submit(saveIntent(), ACTOR, new AbortController().signal)
    const id = branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)
    expect(test.operations.project(id, 0)?.remoteRef.current).toEqual({ state: 'unobserved' })

    await test.operations.pollPending(new AbortController().signal)

    expect(test.operations.project(id, 100)?.remoteRef.current).toMatchObject({ state: 'confirmed' })
    await test.detachOperations()
  })

  it('validates the submitted Actor reference before admitting an Intent', async () => {
    const test = harness()

    await test.operations.submit(saveIntent(), ACTOR, new AbortController().signal)

    expect(test.validatedActors).toEqual([ACTOR])
  })

  it('rejects equal head and base refs before persisting a Save Intent', async () => {
    const test = harness()
    const invalid = { ...saveIntent(), baseRef: saveIntent().headRef }

    expect(branchDeliveryIntentSchema.safeParse(invalid).success).toBe(false)
    await expect(test.operations.submit(invalid, ACTOR, new AbortController().signal)).rejects.toThrow()
    expect(test.intents.size).toBe(0)
    expect(test.deliveries.size).toBe(0)
  })

  it('validates complete Pull Request text before persisting its Intent', async () => {
    const test = harness()
    const signal = new AbortController().signal
    await test.operations.submit(saveIntent(), ACTOR, signal)
    const deliveryId = branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)
    const markerId = `pull-request-marker-${canonicalDigest(
      'saki/branch-delivery/pull-request-marker/v1',
      { deliveryId },
    )}`
    const markerSuffix = `\n<!-- saki-pull-request:${markerId} -->\n`
    const sourceBytes = GITHUB_PULL_REQUEST_CREATE_BODY_UTF8_LIMIT - Buffer.byteLength(markerSuffix, 'utf8')
    const exactBody = 'x'.repeat(sourceBytes)
    const exactMultibyteBody = `${exactBody.slice(0, -3)}界`
    const exactTitle = 'x'.repeat(GITHUB_PULL_REQUEST_CREATE_TITLE_UTF8_LIMIT)
    const exactMultibyteTitle = `${'界'.repeat(341)}x`

    for (const [title, body] of [
      [exactTitle, exactBody],
      [exactMultibyteTitle, exactMultibyteBody],
    ]) {
      const parsed = branchDeliveryIntentSchema.safeParse({ ...createPullRequestIntent(), title, body })
      expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true)
    }

    const invalid = [
      { title: `${exactTitle}x`, body: 'Body' },
      { title: 'Title\ncontinued', body: 'Body' },
      { title: 'Title\ud800', body: 'Body' },
      { title: 'Title', body: `${exactBody}x` },
      { title: 'Title', body: 'Body\rcontinued' },
      { title: 'Title', body: 'Body\0continued' },
      { title: 'Title', body: 'Body\x7fcontinued' },
      { title: 'Title', body: 'Body\ud800' },
      { title: 'Title', body: `Body\n<!-- saki-pull-request:${markerId} -->` },
    ]
    for (const text of invalid) {
      const intent = { ...createPullRequestIntent(), ...text }
      expect(branchDeliveryIntentSchema.safeParse(intent).success).toBe(false)
      await expect(test.operations.submit(intent, ACTOR, signal)).rejects.toThrow()
    }
    expect(test.intents.size).toBe(1)
    expect(test.deliveries.get(deliveryId)).toMatchObject({ revision: 0 })
    expect(test.deliveries.get(deliveryId)).not.toHaveProperty('activeIntentId')
  })

  it('dispatches the trimmed Pull Request body with the current Delivery marker', async () => {
    const test = harness()
    const signal = new AbortController().signal
    await test.operations.submit(saveIntent(), ACTOR, signal)
    const deliveryId = branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)
    const markerId = `pull-request-marker-${canonicalDigest(
      'saki/branch-delivery/pull-request-marker/v1',
      { deliveryId },
    )}`

    await test.operations.submit({
      ...createPullRequestIntent(),
      body: 'Prepared body. \r\n\t',
    }, ACTOR, signal)

    expect(test.github.lastCreateRequest).toMatchObject({
      markerId,
      title: 'Deliver B10',
      body: `Prepared body.\n<!-- saki-pull-request:${markerId} -->\n`,
    })
  })

  it('projects an explicit browser-safe Delivery without credential references or local paths', async () => {
    const test = harness()
    await test.operations.submit(saveIntent(), ACTOR, new AbortController().signal)

    const projected = test.operations.project(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID), 1)

    expect(projected).toMatchObject({
      delivery: {
        projectId: PROJECT_ID,
        workItemId: WORK_ITEM_ID,
        commitId: COMMIT_ID,
        target: {
          binding: { id: BINDING_ID, revision: 2, hostId: ACTOR.hostId },
          installation: { appId: '10', installationId: '11', accountId: 'A_account' },
          repository: { nameWithOwner: 'BreakfastDaPaiDang/saki' },
        },
      },
    })
    expect(projected).not.toHaveProperty('record')
    const durable = test.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID))
    if (durable === undefined) throw new Error('expected one saved Branch Delivery')
    const { reviews, ...withoutReviews } = durable
    expect(reviews.current).toEqual({ state: 'unobserved' })
    expect(branchDeliveryRecordSchema.safeParse(withoutReviews).success).toBe(false)
    const serialized = JSON.stringify(projected)
    expect(serialized).not.toContain('privateKeyRef')
    expect(serialized).not.toContain('canonicalWorktreePath')
    expect(serialized).not.toContain('canonicalGitDirectory')
  })

  it('omits an authentication credential reference from a source failure projection', async () => {
    const test = harness()
    const id = branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)
    await test.operations.submit(saveIntent(), ACTOR, new AbortController().signal)
    test.github.failures.set('branch-head', {
      code: 'auth-unavailable',
      credentialRef: INSTALLATION.privateKeyRef,
    })

    await expect(test.operations.refresh(id, new AbortController().signal)).resolves.toMatchObject({ ok: true })
    const durableFailure = test.deliveries.get(id)?.remoteRef.current
    expect(durableFailure?.state).toBe('failure')
    if (durableFailure?.state !== 'failure') throw new Error('expected a durable source failure')
    expect(typeof durableFailure.failedAt).toBe('number')
    expect(durableFailure.failure).toEqual({
      code: 'auth-unavailable',
      credentialRef: INSTALLATION.privateKeyRef,
    })

    const projectedFailure = test.operations.project(id, Date.now())?.remoteRef.current
    expect(projectedFailure?.state).toBe('failure')
    if (projectedFailure?.state !== 'failure') throw new Error('expected a projected source failure')
    expect(typeof projectedFailure.failedAt).toBe('number')
    expect(projectedFailure.failure).toEqual({ code: 'auth-unavailable' })
  })

  it('rejects a durable Intent whose payload no longer matches its canonical digest', async () => {
    const test = harness()
    await test.operations.submit(saveIntent(), ACTOR, new AbortController().signal)
    const stored = test.intents.get(SAVE_INTENT_ID)
    expect(stored).toBeDefined()

    expect(branchDeliveryIntentRecordSchema.safeParse({
      ...stored,
      payload: {
        ...stored?.payload,
        intent: { ...stored?.payload.intent, commitId: UPDATED_COMMIT_ID },
      },
    }).success).toBe(false)
  })

  it('rejects an existing-delivery Intent whose durable aggregate id differs from its payload', async () => {
    const test = harness()
    const signal = new AbortController().signal
    await test.operations.submit(saveIntent(), ACTOR, signal)
    await test.operations.submit(pushIntent(), ACTOR, signal)
    const stored = test.intents.get(PUSH_INTENT_ID)
    expect(stored).toBeDefined()

    expect(branchDeliveryIntentRecordSchema.safeParse({
      ...stored,
      deliveryId: branchDeliveryId(PROJECT_ID, SECOND_WORK_ITEM_ID),
    }).success).toBe(false)
  })

  it('rejects a durable Pull Request request whose authorized credential or text changed', async () => {
    const test = harness()
    const signal = new AbortController().signal
    await test.operations.submit(saveIntent(), ACTOR, signal)
    await test.operations.submit(createPullRequestIntent(), ACTOR, signal)
    const stored = test.intents.get(PULL_REQUEST_INTENT_ID)
    if (stored?.operation.kind !== 'pull-request-create') {
      throw new Error('test Pull Request Intent retained another operation')
    }
    const requests = [
      {
        ...stored.operation.request,
        installation: {
          ...stored.operation.request.installation,
          privateKeyRef: credentialRef('SAKI_GITHUB_PRIVATE_KEY_ALTERNATE'),
        },
      },
      { ...stored.operation.request, title: 'Altered durable title' },
      {
        ...stored.operation.request,
        body: `Altered durable body.\n<!-- saki-pull-request:${stored.operation.request.markerId} -->\n`,
      },
    ]

    for (const request of requests) {
      test.intents.values.set(PULL_REQUEST_INTENT_ID, branchDeliveryIntentRecordSchema.parse({
        ...stored,
        operation: { kind: 'pull-request-create', request },
      }))
      expect(() => test.createDetachedOperations().validateDurableState(new Set())).toThrow(
        'Branch Delivery last Intent reference is inconsistent',
      )
    }
  })

  it('rejects a durable Push request whose exact Binding changed', async () => {
    const test = harness()
    const signal = new AbortController().signal
    await test.operations.submit(saveIntent(), ACTOR, signal)
    await test.operations.submit(pushIntent(), ACTOR, signal)
    const stored = test.intents.get(PUSH_INTENT_ID)
    if (stored?.operation.kind !== 'push') throw new Error('test Push Intent retained another operation')
    test.intents.values.set(PUSH_INTENT_ID, branchDeliveryIntentRecordSchema.parse({
      ...stored,
      operation: {
        kind: 'push',
        request: {
          ...stored.operation.request,
          expected: {
            ...stored.operation.request.expected,
            binding: {
              ...stored.operation.request.expected.binding,
              workspaceId: WorkspaceId('workspace-altered'),
            },
          },
        },
      },
    }))

    expect(() => test.createDetachedOperations().validateDurableState(new Set())).toThrow(
      'Branch Delivery last Intent reference is inconsistent',
    )
  })

  it.each(['checkpoint-only', 'delivery-and-checkpoint'] as const)(
    'rejects an active Intent after its optimistic revision fence changes: %s',
    async (mutation) => {
      const test = harness()
      const signal = new AbortController().signal
      await test.operations.submit(saveIntent(), ACTOR, signal)
      await test.detachOperations()
      await expect(test.operations.submit(createPullRequestIntent(), ACTOR, signal)).resolves.toMatchObject({
        ok: false,
        reason: 'unavailable',
      })
      const deliveryId = branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)
      const delivery = test.deliveries.get(deliveryId)
      const intent = test.intents.get(PULL_REQUEST_INTENT_ID)
      if (delivery === undefined || intent?.checkpoint.state !== 'active') {
        throw new Error('test did not retain an active Pull Request Intent')
      }
      const changedRevision = delivery.revision + 1
      test.deliveries.values.set(deliveryId, branchDeliveryRecordSchema.parse({
        ...delivery,
        ...(mutation === 'delivery-and-checkpoint' ? { revision: changedRevision } : {}),
      }))
      test.intents.values.set(PULL_REQUEST_INTENT_ID, branchDeliveryIntentRecordSchema.parse({
        ...intent,
        checkpoint: { ...intent.checkpoint, deliveryRevision: changedRevision },
      }))

      expect(() => test.createDetachedOperations().validateDurableState(new Set())).toThrow(
        'Branch Delivery active Intent revision fence is inconsistent',
      )
    },
  )

  it('keeps one expected-revision Branch Delivery for each Project and Work Item', async () => {
    const test = harness()

    const created = await test.operations.submit(saveIntent(), ACTOR, new AbortController().signal)

    expect(created).toMatchObject({ ok: true, receipt: { state: 'succeeded', deliveryRevision: 0 } })
    expect(test.deliveries.size).toBe(1)
    const id = branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)
    expect(test.deliveries.get(id)).toMatchObject({ id, revision: 0, commitId: COMMIT_ID })

    test.localHead.current = UPDATED_COMMIT_ID
    const updated = await test.operations.submit(
      saveIntent(UPDATE_INTENT_ID, UPDATED_COMMIT_ID, 0),
      ACTOR,
      new AbortController().signal,
    )

    expect(updated).toMatchObject({ ok: true, receipt: { state: 'succeeded', deliveryRevision: 1 } })
    expect(test.deliveries.size).toBe(1)
    expect(test.deliveries.get(id)).toMatchObject({ id, revision: 1, commitId: UPDATED_COMMIT_ID })
  })

  it('resets review observations when Save selects a new delivery Commit', async () => {
    const test = harness()
    const signal = new AbortController().signal
    await test.operations.submit(saveIntent(), ACTOR, signal)
    await test.operations.submit(createPullRequestIntent(), ACTOR, signal)
    const id = branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)
    await test.operations.refresh(id, signal)
    expect(test.deliveries.get(id)?.reviews.current).toMatchObject({ state: 'confirmed' })
    const revision = test.deliveries.get(id)?.revision
    if (revision === undefined) throw new Error('expected one saved Branch Delivery')
    test.localHead.current = UPDATED_COMMIT_ID

    await test.operations.submit(saveIntent(UPDATE_INTENT_ID, UPDATED_COMMIT_ID, revision), ACTOR, signal)

    expect(test.deliveries.get(id)).toMatchObject({
      commitId: UPDATED_COMMIT_ID,
      reviews: { current: { state: 'unobserved' } },
    })
    expect(test.deliveries.get(id)?.reviews).not.toHaveProperty('confirmed')
  })

  it('finishes a locally applied Save before consulting changed authority on restart', async () => {
    const test = harness()
    await test.operations.submit(saveIntent(), ACTOR, new AbortController().signal)
    const terminal = test.intents.get(SAVE_INTENT_ID)
    expect(terminal).toBeDefined()
    test.intents.values.set(SAVE_INTENT_ID, {
      ...structuredClone(terminal!),
      revision: 0,
      checkpoint: { state: 'prepared' },
      updatedAt: terminal!.createdAt,
    })
    test.authority.current = false

    const restarted = test.createOperations()
    await restarted.initializeValidated(restarted.validateDurableState(new Set()))

    expect(test.intents.get(SAVE_INTENT_ID)).toMatchObject({
      checkpoint: { state: 'terminal', outcome: 'succeeded', deliveryRevision: 0 },
    })
    expect(test.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID))).toMatchObject({
      lastIntentId: SAVE_INTENT_ID,
      commitId: COMMIT_ID,
    })
  })

  it('rejects a retained Branch Delivery after its Development Project disappears', async () => {
    const test = harness()
    await test.operations.submit(saveIntent(), ACTOR, new AbortController().signal)
    test.projectPresent.current = false

    expect(() => test.createDetachedOperations().validateDurableState(new Set())).toThrow(
      'Branch Delivery targets a missing Development Project',
    )
  })

  it('recovers a lost Pull Request acknowledgement by marker inspection without a second create', async () => {
    const test = harness()
    await test.operations.submit(saveIntent(), ACTOR, new AbortController().signal)
    test.github.crashAfterCreate = true

    await expect(test.operations.submit(createPullRequestIntent(), ACTOR, new AbortController().signal))
      .rejects.toThrow(SimulatedProcessCrash)
    expect(test.github.dispatches).toBe(1)
    expect(test.intents.get(PULL_REQUEST_INTENT_ID)).toMatchObject({
      checkpoint: { state: 'pull-request-effect-possible' },
    })

    test.github.crashAfterCreate = false
    const restarted = test.createOperations()
    const validated = restarted.validateDurableState(new Set())
    await restarted.initializeValidated(validated)

    expect(test.github.dispatches).toBe(1)
    expect(test.intents.get(PULL_REQUEST_INTENT_ID)).toMatchObject({
      checkpoint: { state: 'terminal', outcome: 'succeeded' },
    })
    const recovered = test.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID))
    expect(recovered).toMatchObject({
      pullRequest: {
        current: { state: 'confirmed' },
        confirmed: { fact: { number: 72, head: { commitId: COMMIT_ID } } },
      },
    })
    expect(recovered?.activeIntentId).toBeUndefined()
  })

  it('recovers a persisted PR repair before completing its Intent', async () => {
    const test = harness()
    const signal = new AbortController().signal
    await test.operations.submit(saveIntent(), ACTOR, signal)
    test.github.crashAfterCreate = true
    await expect(test.operations.submit(createPullRequestIntent(), ACTOR, signal)).rejects.toThrow(SimulatedProcessCrash)
    test.github.crashAfterCreate = false
    test.github.pullRequestCreated = false
    test.intents.beforeUpdate = (_key, _current, next) => {
      if (next.id !== PULL_REQUEST_INTENT_ID || next.checkpoint.state !== 'terminal') return
      test.intents.beforeUpdate = undefined
      throw new SimulatedProcessCrash('process stopped after repair publication')
    }
    await expect(test.operations.submit(createPullRequestIntent(), ACTOR, signal)).rejects.toThrow(SimulatedProcessCrash)
    const id = branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)
    expect(test.deliveries.get(id)?.repair).toMatchObject({ intentId: PULL_REQUEST_INTENT_ID, reason: 'effect-unknown' })
    const restarted = test.createDetachedOperations()
    await restarted.initializeValidated(restarted.validateDurableState(new Set()))
    expect(test.intents.get(PULL_REQUEST_INTENT_ID)?.checkpoint).toMatchObject({
      state: 'terminal', outcome: 'reconciliation-required', reason: 'effect-unknown',
    })
    expect(test.github.dispatches).toBe(1)
    const delivery = test.deliveries.get(id)!
    test.deliveries.values.set(id, branchDeliveryRecordSchema.parse({
      ...delivery, repair: { ...delivery.repair, reason: 'marker-ambiguous' },
    }))
    expect(() => restarted.validateDurableState(new Set())).toThrow('Branch Delivery repair Intent reference is inconsistent')
  })

  it('rejects a sealed acceptance paired with a rejected Intent', async () => {
    const test = harness()
    const signal = new AbortController().signal
    await test.operations.submit(saveIntent(), ACTOR, signal)
    await test.operations.submit(pushIntent(), ACTOR, signal)
    await test.operations.submit(createPullRequestIntent(2), ACTOR, signal)
    await test.operations.submit(inReviewIntent(4), ACTOR, signal)
    await test.operations.submit(acceptIntent(6), ACTOR, signal)
    const record = test.intents.get(ACCEPT_INTENT_ID)!
    for (const outcome of ['denied', 'conflict', 'failure'] as const) {
      test.intents.values.set(record.id, branchDeliveryIntentRecordSchema.parse({
        ...record, checkpoint: { state: 'terminal', outcome, reason: 'authority', deliveryRevision: 8 },
      }))
      expect(() => test.createDetachedOperations().validateDurableState(new Set()))
        .toThrow('Branch Delivery acceptance Intent reference is inconsistent')
    }
  })

  it('finishes a locally confirmed Pull Request without requiring the provider on restart', async () => {
    const test = harness()
    const signal = new AbortController().signal
    await test.operations.submit(saveIntent(), ACTOR, signal)
    await test.operations.submit(createPullRequestIntent(), ACTOR, signal)
    const terminal = test.intents.get(PULL_REQUEST_INTENT_ID)
    expect(terminal).toBeDefined()
    test.intents.values.set(PULL_REQUEST_INTENT_ID, {
      ...structuredClone(terminal!),
      revision: terminal!.revision - 1,
      checkpoint: { state: 'pull-request-effect-possible', deliveryRevision: 1 },
    })

    const restarted = test.createDetachedOperations()
    await restarted.initializeValidated(restarted.validateDurableState(new Set()))

    expect(test.intents.get(PULL_REQUEST_INTENT_ID)).toMatchObject({
      checkpoint: { state: 'terminal', outcome: 'succeeded', deliveryRevision: 2 },
    })
    expect(test.github.dispatches).toBe(1)
  })

  it('does not admit a new delivery operation past an unfinished last Intent', async () => {
    const test = harness()
    const signal = new AbortController().signal
    await test.operations.submit(saveIntent(), ACTOR, signal)
    await test.operations.submit(createPullRequestIntent(), ACTOR, signal)
    const terminal = test.intents.get(PULL_REQUEST_INTENT_ID)
    expect(terminal).toBeDefined()
    test.intents.values.set(PULL_REQUEST_INTENT_ID, {
      ...structuredClone(terminal!),
      revision: terminal!.revision - 1,
      checkpoint: { state: 'pull-request-effect-possible', deliveryRevision: 1 },
    })

    const result = await test.operations.submit(pushIntent(2), ACTOR, signal)

    expect(result).toEqual({ ok: false, reason: 'unavailable' })
    expect(test.intents.get(PUSH_INTENT_ID)).toBeUndefined()
    const delivery = test.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID))
    expect(delivery).toMatchObject({
      lastIntentId: PULL_REQUEST_INTENT_ID,
    })
    expect(delivery?.activeIntentId).toBeUndefined()
  })

  it('wakes provider-dependent pending Intents when GitHub attaches', async () => {
    const test = harness()
    const signal = new AbortController().signal
    await test.operations.submit(saveIntent(), ACTOR, signal)
    const detached = test.createDetachedOperations()

    const pending = await detached.submit(createPullRequestIntent(), ACTOR, signal)
    expect(pending).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(test.intents.get(PULL_REQUEST_INTENT_ID)).toMatchObject({ checkpoint: { state: 'active' } })

    const detach = detached.attach(test.github)
    await vi.waitFor(() => {
      expect(test.intents.get(PULL_REQUEST_INTENT_ID)).toMatchObject({ checkpoint: { state: 'terminal' } })
    })
    await detach()

    expect(test.intents.get(PULL_REQUEST_INTENT_ID)).toMatchObject({
      checkpoint: { state: 'terminal', outcome: 'succeeded' },
    })
    expect(test.github.dispatches).toBe(1)
  })

  it('aborts and drains provider recovery before a detached provider can persist evidence', async () => {
    const test = harness()
    const signal = new AbortController().signal
    await test.operations.submit(saveIntent(), ACTOR, signal)
    const detached = test.createDetachedOperations()
    await detached.submit(createPullRequestIntent(), ACTOR, signal)
    const beforeIntent = structuredClone(test.intents.get(PULL_REQUEST_INTENT_ID))
    const beforeDelivery = structuredClone(test.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)))
    const oldProvider = new BlockingInspectionGitHub(new Context())

    const detach = detached.attach(oldProvider)
    await oldProvider.inspectionStarted.promise
    const draining = detach()
    expect(draining).toBeInstanceOf(Promise)
    expect(oldProvider.inspectionSignal?.aborted).toBe(true)
    oldProvider.releaseInspection.resolve(undefined)
    await draining

    expect(test.intents.get(PULL_REQUEST_INTENT_ID)).toEqual(beforeIntent)
    expect(test.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID))).toEqual(beforeDelivery)
    expect(test.unexpectedFailures).toEqual([])

    const detachReplacement = detached.attach(test.github)
    await vi.waitFor(() => {
      expect(test.intents.get(PULL_REQUEST_INTENT_ID)).toMatchObject({ checkpoint: { state: 'terminal' } })
    })
    await detachReplacement()
    expect(test.intents.get(PULL_REQUEST_INTENT_ID)).toMatchObject({
      checkpoint: { state: 'terminal', outcome: 'succeeded' },
    })
  })

  it('isolates provider recovery records and reports the first unexpected failure after the batch', async () => {
    const test = harness()
    const signal = new AbortController().signal
    const detached = test.createDetachedOperations()
    test.additionalContexts.set(SECOND_WORK_ITEM_ID, {
      ...deliveryContext(),
      workItem: {
        id: SECOND_WORK_ITEM_ID,
        remoteFingerprint: REMOTE_FINGERPRINT,
        issueId: githubIssueId('I_issue_33'),
      },
    })
    await detached.submit(saveIntent(), ACTOR, signal)
    await detached.submit({
      ...saveIntent(SECOND_SAVE_INTENT_ID),
      workItemId: SECOND_WORK_ITEM_ID,
    }, ACTOR, signal)
    await detached.submit(createPullRequestIntent(), ACTOR, signal)
    await detached.submit({
      ...createPullRequestIntent(),
      intentId: SECOND_PULL_REQUEST_INTENT_ID,
      deliveryId: branchDeliveryId(PROJECT_ID, SECOND_WORK_ITEM_ID),
    }, ACTOR, signal)

    const provider = new FirstInspectionFailsGitHub(new Context())
    const detach = detached.attach(provider)
    await vi.waitFor(() => {
      expect(test.intents.get(SECOND_PULL_REQUEST_INTENT_ID)).toMatchObject({ checkpoint: { state: 'terminal' } })
    })
    await detach()

    expect(test.intents.get(PULL_REQUEST_INTENT_ID)).toMatchObject({ checkpoint: { state: 'active' } })
    expect(test.intents.get(SECOND_PULL_REQUEST_INTENT_ID)).toMatchObject({
      checkpoint: { state: 'terminal', outcome: 'succeeded' },
    })
    expect(test.unexpectedFailures).toEqual([expect.objectContaining({
      message: 'first recovery failed unexpectedly',
    })])
  })

  it('publishes the exact selected Commit through the shared Binding write admission', async () => {
    const test = harness()
    await test.operations.submit(saveIntent(), ACTOR, new AbortController().signal)

    const result = await test.operations.submit(pushIntent(), ACTOR, new AbortController().signal)

    expect(result).toMatchObject({ ok: true, receipt: { state: 'succeeded', deliveryRevision: 2 } })
    expect(test.execution.starts).toBe(1)
    expect(test.execution.request).toMatchObject({
      type: 'push-branch',
      expected: {
        binding: { id: BINDING_ID, revision: 2 },
        commitId: COMMIT_ID,
        repository: { nameWithOwner: 'BreakfastDaPaiDang/saki' },
      },
      targetRef: 'refs/heads/feature/delivery',
    })
    expect(test.admissions.get(BINDING_ID)).toMatchObject({ state: 'available', revision: 3 })
    const delivery = test.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID))
    expect(delivery).toMatchObject({
      push: {
        intentId: PUSH_INTENT_ID,
        result: { commitId: COMMIT_ID, previous: { kind: 'absent' } },
      },
    })
    expect(Object.hasOwn(delivery!, 'activeIntentId')).toBe(false)
    expect(Object.hasOwn(delivery!, 'repair')).toBe(false)
  })

  it('durably cancels and releases a Push whose authority is revoked at Host start', async () => {
    const test = harness()
    const signal = new AbortController().signal
    await test.operations.submit(saveIntent(), ACTOR, signal)
    test.execution.beforeAdmission = () => { test.authority.current = false }

    const result = await test.operations.submit(pushIntent(), ACTOR, signal)

    expect(result).toMatchObject({ ok: false, reason: 'denied', receipt: { state: 'denied' } })
    expect(test.execution.starts).toBe(0)
    expect(test.execution.cancellations).toEqual(['authority-revoked'])
    expect(test.intents.get(PUSH_INTENT_ID)).toMatchObject({
      checkpoint: {
        state: 'terminal',
        outcome: 'denied',
        reason: 'authority',
        host: { snapshot: { state: 'canceled', reason: 'authority-revoked', effect: 'none' } },
      },
    })
    expect(test.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID))?.activeIntentId).toBeUndefined()
    expect(test.admissions.get(BINDING_ID)).toMatchObject({ state: 'available', revision: 3 })

    await expect(test.operations.submit(pushIntent(), ACTOR, signal)).resolves.toEqual(result)
    expect(test.execution.cancellations).toEqual(['authority-revoked'])
  })

  it('durably cancels and releases a Push whose target changes at Host start', async () => {
    const test = harness()
    const signal = new AbortController().signal
    await test.operations.submit(saveIntent(), ACTOR, signal)
    test.execution.beforeAdmission = () => {
      test.context.current = { ...test.context.current, mappingRevision: 5 }
    }

    const result = await test.operations.submit(pushIntent(), ACTOR, signal)

    expect(result).toMatchObject({ ok: false, reason: 'unavailable', receipt: { state: 'failure' } })
    expect(test.execution.starts).toBe(0)
    expect(test.execution.cancellations).toEqual(['source-canceled'])
    expect(test.intents.get(PUSH_INTENT_ID)).toMatchObject({
      checkpoint: {
        state: 'terminal',
        outcome: 'failure',
        reason: 'host-operation',
        host: { snapshot: { state: 'canceled', reason: 'source-canceled', effect: 'none' } },
      },
    })
    expect(test.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID))?.activeIntentId).toBeUndefined()
    expect(test.admissions.get(BINDING_ID)).toMatchObject({ state: 'available', revision: 3 })
  })

  it('recovers an owned Push reservation before canceling a target that changed after a crash', async () => {
    const test = harness()
    const signal = new AbortController().signal
    await test.operations.submit(saveIntent(), ACTOR, signal)
    test.execution.crashBeforePrepareOnce = true
    await expect(test.operations.submit(pushIntent(), ACTOR, signal)).rejects.toBeInstanceOf(SimulatedProcessCrash)
    expect(test.intents.get(PUSH_INTENT_ID)).toMatchObject({ checkpoint: { state: 'active' } })
    expect(test.admissions.get(BINDING_ID)).toMatchObject({
      state: 'manual-host-operation',
      phase: 'reserved',
    })
    test.context.current = { ...test.context.current, mappingRevision: 5 }

    const restarted = test.createDetachedOperations()
    await restarted.initializeValidated(restarted.validateDurableState(new Set()))

    expect(test.execution.cancellations).toEqual(['source-canceled'])
    expect(test.intents.get(PUSH_INTENT_ID)).toMatchObject({
      checkpoint: { state: 'terminal', outcome: 'failure', reason: 'host-operation' },
    })
    expect(test.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID))?.activeIntentId).toBeUndefined()
    expect(test.admissions.get(BINDING_ID)).toMatchObject({ state: 'available', revision: 3 })
    expect(() => restarted.validateDurableState(new Set())).not.toThrow()
  })

  it('finishes a locally confirmed Push from its Host snapshot without preparing another effect', async () => {
    const test = harness()
    const signal = new AbortController().signal
    await test.operations.submit(saveIntent(), ACTOR, signal)
    await test.operations.submit(pushIntent(), ACTOR, signal)
    const terminal = test.intents.get(PUSH_INTENT_ID)
    if (terminal?.operation.kind !== 'push' || terminal.checkpoint.state !== 'terminal'
      || terminal.checkpoint.host === undefined) throw new Error('test Push did not retain terminal Host evidence')
    const preparation = terminal.checkpoint.host.preparation
    test.intents.values.set(PUSH_INTENT_ID, {
      ...structuredClone(terminal),
      revision: terminal.revision - 1,
      checkpoint: {
        state: 'push-host-accepted',
        deliveryRevision: 1,
        preparation,
        admissionRevision: 2,
      },
    })
    test.admissions.values.set(BINDING_ID, {
      id: BINDING_ID,
      schemaVersion: 1,
      revision: 2,
      state: 'manual-host-operation',
      phase: 'accepted',
      bindingRevision: 2,
      source: terminal.operation.request.source,
      action: 'project-branch:push',
      reservedAt: 10,
      preparation,
      acceptedAt: 11,
      updatedAt: 11,
    })
    test.execution.unavailable = true

    const restarted = test.createDetachedOperations()
    const acceptedAdmission = test.admissions.get(BINDING_ID)
    if (acceptedAdmission?.state !== 'manual-host-operation' || acceptedAdmission.phase !== 'accepted') {
      throw new Error('test Push did not retain accepted write admission')
    }
    test.admissions.values.set(BINDING_ID, { ...acceptedAdmission, revision: 3 })
    expect(() => restarted.validateDurableState(new Set())).toThrow(
      'Branch Delivery Push admission has no matching recovery checkpoint',
    )
    test.admissions.values.set(BINDING_ID, acceptedAdmission)
    await restarted.initializeValidated(restarted.validateDurableState(new Set()))

    expect(test.intents.get(PUSH_INTENT_ID)).toMatchObject({
      checkpoint: { state: 'terminal', outcome: 'succeeded', deliveryRevision: 2 },
    })
    expect(test.admissions.get(BINDING_ID)).toMatchObject({ state: 'available', revision: 3 })
  })

  it('checkpoints an applied Push terminal before releasing its admission on replay', async () => {
    const test = harness()
    const signal = new AbortController().signal
    await test.operations.submit(saveIntent(), ACTOR, signal)
    await test.operations.submit(pushIntent(), ACTOR, signal)
    const terminal = test.intents.get(PUSH_INTENT_ID)
    if (terminal?.operation.kind !== 'push' || terminal.checkpoint.state !== 'terminal'
      || terminal.checkpoint.host === undefined) throw new Error('test Push did not retain terminal Host evidence')
    const preparation = terminal.checkpoint.host.preparation
    test.intents.values.set(PUSH_INTENT_ID, branchDeliveryIntentRecordSchema.parse({
      ...terminal,
      revision: terminal.revision - 1,
      checkpoint: {
        state: 'push-host-accepted',
        deliveryRevision: 1,
        preparation,
        admissionRevision: 2,
      },
    }))
    test.admissions.values.set(BINDING_ID, {
      id: BINDING_ID,
      schemaVersion: 1,
      revision: 2,
      state: 'manual-host-operation',
      phase: 'accepted',
      bindingRevision: 2,
      source: terminal.operation.request.source,
      action: 'project-branch:push',
      reservedAt: 10,
      preparation,
      acceptedAt: 11,
      updatedAt: 11,
    })
    test.admissions.beforeUpdate = (_key, _current, next) => {
      if (next.state !== 'available') return
      test.admissions.beforeUpdate = undefined
      throw new SimulatedProcessCrash('process stopped before admission release')
    }

    const interrupted = test.createDetachedOperations()
    await expect(interrupted.initializeValidated(interrupted.validateDurableState(new Set())))
      .rejects.toThrow(SimulatedProcessCrash)
    expect(test.intents.get(PUSH_INTENT_ID)).toMatchObject({
      checkpoint: { state: 'terminal', outcome: 'succeeded', deliveryRevision: 2 },
    })
    expect(test.admissions.get(BINDING_ID)).toMatchObject({
      state: 'manual-host-operation',
      phase: 'accepted',
      revision: 2,
    })

    const restarted = test.createDetachedOperations()
    await restarted.initializeValidated(restarted.validateDurableState(new Set()))
    expect(test.admissions.get(BINDING_ID)).toMatchObject({ state: 'available', revision: 3 })
  })

  it('associates an existing Pull Request only through a complete targeted read', async () => {
    const test = harness()
    await test.operations.submit(saveIntent(), ACTOR, new AbortController().signal)
    test.github.pullRequestCreated = true

    const result = await test.operations.submit(
      associatePullRequestIntent(),
      ACTOR,
      new AbortController().signal,
    )

    expect(result).toMatchObject({ ok: true, receipt: { state: 'succeeded', deliveryRevision: 2 } })
    expect(test.github.dispatches).toBe(0)
    expect(test.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID))).toMatchObject({
      pullRequest: {
        current: { state: 'confirmed', observedAt: 100 },
        confirmed: { fact: { id: githubPullRequestId('PR_delivery'), number: 72 } },
      },
    })
  })

  it('recovers a rejected Pull Request association between aggregate cleanup and Intent completion', async () => {
    const test = harness()
    const signal = new AbortController().signal
    await test.operations.submit(saveIntent(), ACTOR, signal)
    test.intents.beforeUpdate = (_key, _current, next) => {
      if (next.id !== ASSOCIATE_INTENT_ID || next.checkpoint.state !== 'terminal') return
      test.intents.beforeUpdate = undefined
      throw new SimulatedProcessCrash('process stopped before the terminal Intent write')
    }

    await expect(test.operations.submit(associatePullRequestIntent(), ACTOR, signal))
      .rejects.toThrow(SimulatedProcessCrash)

    const deliveryId = branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)
    expect(test.deliveries.get(deliveryId)).toMatchObject({ lastIntentId: ASSOCIATE_INTENT_ID })
    expect(test.deliveries.get(deliveryId)?.activeIntentId).toBeUndefined()
    const active = test.intents.get(ASSOCIATE_INTENT_ID)
    expect(active).toMatchObject({ checkpoint: { state: 'active' } })
    if (active === undefined) throw new Error('expected the interrupted association Intent')
    const deliveryRevision = test.deliveries.get(deliveryId)?.revision
    if (deliveryRevision === undefined) throw new Error('expected the interrupted Branch Delivery')
    for (const [outcome, reason] of [
      ['conflict', 'expected-evidence'],
      ['denied', 'authority'],
      ['failure', 'expected-evidence'],
    ] as const) {
      test.intents.values.set(ASSOCIATE_INTENT_ID, branchDeliveryIntentRecordSchema.parse({
        ...active,
        revision: active.revision + 1,
        checkpoint: { state: 'terminal', outcome, reason, deliveryRevision },
      }))
      expect(() => test.createDetachedOperations().validateDurableState(new Set())).not.toThrow()
    }
    test.intents.values.set(ASSOCIATE_INTENT_ID, branchDeliveryIntentRecordSchema.parse({
      ...active,
      revision: active.revision + 1,
      checkpoint: { state: 'terminal', outcome: 'succeeded', deliveryRevision },
    }))
    expect(() => test.createDetachedOperations().validateDurableState(new Set())).toThrow(
      'Branch Delivery last Intent reference is inconsistent',
    )
    test.intents.values.set(ASSOCIATE_INTENT_ID, active)

    const restarted = test.createOperations()
    await restarted.initializeValidated(restarted.validateDurableState(new Set()))

    expect(test.intents.get(ASSOCIATE_INTENT_ID)).toMatchObject({
      checkpoint: { state: 'terminal', outcome: 'conflict', reason: 'expected-evidence' },
    })
    expect(() => restarted.validateDurableState(new Set())).not.toThrow()
  })

  it('clears prior review evidence when association confirms another Pull Request', async () => {
    const test = harness()
    const signal = new AbortController().signal
    const id = branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)
    await test.operations.submit(saveIntent(), ACTOR, signal)
    await test.operations.submit(createPullRequestIntent(), ACTOR, signal)
    await test.operations.refresh(id, signal)
    expect(test.deliveries.get(id)?.reviews.current).toMatchObject({ state: 'confirmed' })
    test.github.pullRequestId = githubPullRequestId('PR_replacement')
    test.github.pullRequestNumber = 73
    test.github.observedAt = 200

    const result = await test.operations.submit({
      ...associatePullRequestIntent(3),
      pullRequestId: test.github.pullRequestId,
      pullRequestNumber: test.github.pullRequestNumber,
    }, ACTOR, signal)

    expect(result).toMatchObject({ ok: true, receipt: { state: 'succeeded', deliveryRevision: 5 } })
    expect(test.deliveries.get(id)).toMatchObject({
      pullRequest: { confirmed: { fact: { id: 'PR_replacement', number: 73 } } },
      reviews: { current: { state: 'unobserved' } },
    })
    expect(test.deliveries.get(id)?.reviews).not.toHaveProperty('confirmed')
  })

  it('invalidates prior review evidence when Pull Request creation confirms a newer revision', async () => {
    const test = harness()
    const signal = new AbortController().signal
    const id = branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)
    await test.operations.submit(saveIntent(), ACTOR, signal)
    await test.operations.submit(createPullRequestIntent(), ACTOR, signal)
    await test.operations.refresh(id, signal)
    expect(test.deliveries.get(id)?.reviews).toMatchObject({
      confirmed: { fact: { pullRequestUpdatedAt: 99, observedAt: 100 } },
      current: { state: 'confirmed', observedAt: 100 },
    })
    test.github.pullRequestInspectionObservedAt = 200

    const result = await test.operations.submit({
      ...createPullRequestIntent(3),
      intentId: SECOND_PULL_REQUEST_INTENT_ID,
    }, ACTOR, signal)

    expect(result).toMatchObject({ ok: true, receipt: { state: 'succeeded', deliveryRevision: 5 } })
    expect(test.deliveries.get(id)).toMatchObject({
      pullRequest: { confirmed: { fact: { updatedAt: 199, observedAt: 200 } } },
      reviews: {
        confirmed: { fact: { pullRequestUpdatedAt: 99, observedAt: 100 } },
        current: { state: 'invalidated', reason: 'target-changed', invalidatedAt: 200 },
      },
    })
  })

  it('finishes a locally applied Pull Request association without the provider on restart', async () => {
    const test = harness()
    const signal = new AbortController().signal
    await test.operations.submit(saveIntent(), ACTOR, signal)
    test.github.pullRequestCreated = true
    await test.operations.submit(associatePullRequestIntent(), ACTOR, signal)
    const terminal = test.intents.get(ASSOCIATE_INTENT_ID)
    expect(terminal).toBeDefined()
    test.intents.values.set(ASSOCIATE_INTENT_ID, {
      ...structuredClone(terminal!),
      revision: terminal!.revision - 1,
      checkpoint: { state: 'active', deliveryRevision: 1 },
    })

    const restarted = test.createDetachedOperations()
    await restarted.initializeValidated(restarted.validateDurableState(new Set()))

    expect(test.intents.get(ASSOCIATE_INTENT_ID)).toMatchObject({
      checkpoint: { state: 'terminal', outcome: 'succeeded', deliveryRevision: 2 },
    })
  })

  it('projects staleness and preserves confirmed facts across independent invalidation and failure', async () => {
    const test = harness()
    await test.operations.submit(saveIntent(), ACTOR, new AbortController().signal)
    await test.operations.submit(createPullRequestIntent(), ACTOR, new AbortController().signal)
    const id = branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)

    const refreshed = await test.operations.refresh(id, new AbortController().signal)
    expect(refreshed).toMatchObject({ ok: true })
    expect(test.operations.project(id, 60_101)).toMatchObject({
      remoteRef: { current: { state: 'stale', observedAt: 100, staleAt: 60_100 } },
      pullRequest: { current: { state: 'stale', observedAt: 100, staleAt: 60_100 } },
      reviews: { current: { state: 'stale', observedAt: 100, staleAt: 60_100 } },
      ci: {
        confirmedSummary: { state: 'successful', signalCount: 2, observedAt: 100 },
        current: { state: 'stale', observedAt: 100, staleAt: 60_100 },
      },
    })

    test.github.observedAt = 200
    test.github.remoteCommit = UPDATED_COMMIT_ID
    test.github.failures.set('commit-ci', { code: 'transient-transport', retryAfterMs: 500 })
    const degraded = await test.operations.refresh(id, new AbortController().signal)

    expect(degraded).toMatchObject({
      ok: true,
      record: {
        remoteRef: {
          confirmed: { fact: { commitId: COMMIT_ID } },
          current: { state: 'invalidated', reason: 'target-changed', invalidatedAt: 200 },
        },
        pullRequest: { current: { state: 'invalidated', reason: 'target-changed', invalidatedAt: 200 } },
        reviews: {
          confirmed: { fact: { headCommitId: COMMIT_ID, observedAt: 100 } },
          current: { state: 'invalidated', reason: 'target-changed', invalidatedAt: 200 },
        },
        ci: {
          confirmed: { fact: { commitId: COMMIT_ID, observedAt: 100 } },
          current: { state: 'failure', failure: { code: 'transient-transport', retryAfterMs: 500 } },
        },
      },
    })
    expect(test.operations.project(id, 200)).toMatchObject({
      ci: {
        confirmedSummary: { state: 'successful', signalCount: 2, observedAt: 100 },
        current: { state: 'failure', failure: { code: 'transient-transport', retryAfterMs: 500 } },
      },
    })
  })

  it('refreshes complete exact-Pull-Request reviews as an independent source', async () => {
    const test = harness()
    await test.operations.submit(saveIntent(), ACTOR, new AbortController().signal)
    await test.operations.submit(createPullRequestIntent(), ACTOR, new AbortController().signal)
    const id = branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)

    await expect(test.operations.refresh(id, new AbortController().signal)).resolves.toMatchObject({ ok: true })

    expect(test.operations.project(id, 100)).toMatchObject({
      reviews: {
        current: { state: 'confirmed', observedAt: 100 },
        confirmed: {
          fact: {
            repositoryId: REPOSITORY_ID,
            pullRequestId: 'PR_delivery',
            pullRequestNumber: 72,
            headCommitId: COMMIT_ID,
            reviews: [{ state: 'approved' }],
          },
        },
      },
    })
  })

  it('rejects a current review confirmation from another Pull Request revision', async () => {
    const test = harness()
    const id = branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)
    await test.operations.submit(saveIntent(), ACTOR, new AbortController().signal)
    await test.operations.submit(createPullRequestIntent(), ACTOR, new AbortController().signal)
    await test.operations.refresh(id, new AbortController().signal)
    const delivery = test.deliveries.get(id)
    const confirmedPullRequest = delivery?.pullRequest.confirmed
    if (delivery === undefined || confirmedPullRequest === undefined) {
      throw new Error('expected confirmed Pull Request evidence')
    }

    expect(branchDeliveryRecordSchema.safeParse({
      ...delivery,
      pullRequest: {
        ...delivery.pullRequest,
        confirmed: {
          ...confirmedPullRequest,
          fact: {
            ...confirmedPullRequest.fact,
            updatedAt: confirmedPullRequest.fact.updatedAt + 1,
          },
        },
      },
    }).success).toBe(false)
  })

  it.each([
    ['Repository', (github: DeliveryGitHub) => { github.reviewRepositoryId = githubRepositoryId('R_foreign') }],
    ['Pull Request id', (github: DeliveryGitHub) => { github.reviewPullRequestId = githubPullRequestId('PR_foreign') }],
    ['Pull Request number', (github: DeliveryGitHub) => { github.reviewPullRequestNumber = 73 }],
    ['head Commit', (github: DeliveryGitHub) => { github.reviewHeadCommitId = UPDATED_COMMIT_ID }],
    ['Pull Request update', (github: DeliveryGitHub) => { github.reviewPullRequestUpdatedAt = 98 }],
  ] as const)('invalidates review facts for a mismatched %s while retaining the last confirmation', async (_, alter) => {
    const test = harness()
    await test.operations.submit(saveIntent(), ACTOR, new AbortController().signal)
    await test.operations.submit(createPullRequestIntent(), ACTOR, new AbortController().signal)
    const id = branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)
    await test.operations.refresh(id, new AbortController().signal)
    alter(test.github)
    test.github.observedAt = 200

    const refreshed = await test.operations.refresh(id, new AbortController().signal)

    expect(refreshed).toMatchObject({
      ok: true,
      record: {
        reviews: {
          confirmed: { fact: { observedAt: 100 } },
          current: { state: 'invalidated', reason: 'target-changed', invalidatedAt: 200 },
        },
      },
    })
  })

  it('invalidates prior review evidence when In Review confirms a newer Pull Request revision', async () => {
    const test = harness()
    const signal = new AbortController().signal
    const id = branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)
    await test.operations.submit(saveIntent(), ACTOR, signal)
    await test.operations.submit(pushIntent(), ACTOR, signal)
    await test.operations.submit(createPullRequestIntent(2), ACTOR, signal)
    await test.operations.refresh(id, signal)
    expect(test.deliveries.get(id)?.reviews.current).toMatchObject({ state: 'confirmed', observedAt: 100 })
    test.github.observedAt = 200

    const result = await test.operations.submit(inReviewIntent(5), ACTOR, signal)

    expect(result).toMatchObject({ ok: true, receipt: { state: 'succeeded', deliveryRevision: 7 } })
    expect(test.deliveries.get(id)).toMatchObject({
      phase: 'in-review',
      pullRequest: { confirmed: { fact: { updatedAt: 199, observedAt: 200 } } },
      reviews: {
        confirmed: { fact: { pullRequestUpdatedAt: 99, observedAt: 100 } },
        current: { state: 'invalidated', reason: 'target-changed', invalidatedAt: 200 },
      },
    })
  })

  it('preserves current review evidence when In Review confirms the same Pull Request revision', async () => {
    const test = harness()
    const signal = new AbortController().signal
    const id = branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)
    await test.operations.submit(saveIntent(), ACTOR, signal)
    await test.operations.submit(pushIntent(), ACTOR, signal)
    await test.operations.submit(createPullRequestIntent(2), ACTOR, signal)
    await test.operations.refresh(id, signal)
    const reviews = structuredClone(test.deliveries.get(id)?.reviews)

    const result = await test.operations.submit(inReviewIntent(5), ACTOR, signal)

    expect(result).toMatchObject({ ok: true, receipt: { state: 'succeeded', deliveryRevision: 7 } })
    expect(test.deliveries.get(id)?.reviews).toEqual(reviews)
  })

  it('recovers evidence rejection when the Delivery write commits before the Intent terminal write', async () => {
    const test = harness()
    const signal = new AbortController().signal
    await test.operations.submit(saveIntent(), ACTOR, signal)
    await test.operations.submit(pushIntent(), ACTOR, signal)
    await test.operations.submit(createPullRequestIntent(2), ACTOR, signal)
    test.github.remoteCommit = UPDATED_COMMIT_ID
    test.intents.beforeUpdate = (_key, _current, next) => {
      if (next.id !== REVIEW_INTENT_ID || next.checkpoint.state !== 'terminal') return
      test.intents.beforeUpdate = undefined
      throw new SimulatedProcessCrash('process stopped before the terminal Intent write')
    }

    await expect(test.operations.submit(inReviewIntent(4), ACTOR, signal))
      .rejects.toThrow(SimulatedProcessCrash)

    const deliveryId = branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)
    expect(test.deliveries.get(deliveryId)).toMatchObject({
      lastIntentId: REVIEW_INTENT_ID,
      remoteRef: { current: { state: 'invalidated', reason: 'target-changed' } },
    })
    expect(test.deliveries.get(deliveryId)?.activeIntentId).toBeUndefined()
    expect(test.intents.get(REVIEW_INTENT_ID)).toMatchObject({ checkpoint: { state: 'active' } })

    const restarted = test.createDetachedOperations()
    const validated = restarted.validateDurableState(new Set())
    await restarted.initializeValidated(validated)

    expect(test.intents.get(REVIEW_INTENT_ID)).toMatchObject({
      checkpoint: { state: 'terminal', outcome: 'conflict', reason: 'expected-evidence' },
    })
    expect(() => restarted.validateDurableState(new Set())).not.toThrow()
  })

  it('seals human acceptance before exactly replaying its recoverable Done child', async () => {
    const test = harness()
    const signal = new AbortController().signal
    await test.operations.submit(saveIntent(), ACTOR, signal)
    await test.operations.submit(pushIntent(), ACTOR, signal)
    await test.operations.submit(createPullRequestIntent(2), ACTOR, signal)

    const review = await test.operations.submit(inReviewIntent(4), ACTOR, signal)
    expect(review).toMatchObject({ ok: true, receipt: { state: 'succeeded', deliveryRevision: 6 } })
    expect(test.context.current.workItem).toMatchObject({ remoteFingerprint: REVIEW_FINGERPRINT })

    test.moveUnavailableOnce.add('done')
    const firstAcceptance = await test.operations.submit(acceptIntent(6), ACTOR, signal)
    expect(firstAcceptance).toMatchObject({ ok: false, reason: 'unavailable' })
    const id = branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)
    const sealed = structuredClone(test.deliveries.get(id))
    expect(sealed).toMatchObject({
      phase: 'accepted',
      revision: 8,
      acceptance: {
        intentId: ACCEPT_INTENT_ID,
        actor: ACTOR,
        evidence: {
          remoteRef: { commitId: COMMIT_ID },
          pullRequest: { head: { commitId: COMMIT_ID } },
          ci: { commitId: COMMIT_ID },
        },
      },
    })
    expect(sealed?.activeIntentId).toBeUndefined()

    const restarted = test.createOperations()
    await restarted.initializeValidated(restarted.validateDurableState(new Set()))
    const accepted = await restarted.submit(acceptIntent(6), ACTOR, signal)
    expect(accepted).toMatchObject({ ok: true, receipt: { state: 'succeeded', deliveryRevision: 8 } })
    expect(test.moveAttempts.map(attempt => attempt.targetStatus)).toEqual(['in-review', 'done', 'done'])
    expect(test.moveAttempts[1]).toEqual(test.moveAttempts[2])
    expect(test.moveAttempts[0]?.intentId).not.toBe(test.moveAttempts[1]?.intentId)
    expect(test.context.current.workItem).toMatchObject({ remoteFingerprint: DONE_FINGERPRINT })
    expect(test.deliveries.get(id)).toEqual(sealed)

    const immutable = await test.operations.submit({
      ...pushIntent(8),
      intentId: IMMUTABLE_INTENT_ID,
    }, ACTOR, signal)
    expect(immutable).toEqual({ ok: false, reason: 'conflict' })
    expect(test.deliveries.get(id)).toEqual(sealed)
  })

  it('accepts exact ref, Pull Request, and successful CI while retaining a review-read failure independently', async () => {
    const test = harness()
    const signal = new AbortController().signal
    await test.operations.submit(saveIntent(), ACTOR, signal)
    await test.operations.submit(pushIntent(), ACTOR, signal)
    await test.operations.submit(createPullRequestIntent(2), ACTOR, signal)
    await test.operations.submit(inReviewIntent(4), ACTOR, signal)
    test.github.failures.set('pull-request-reviews', { code: 'transient-transport', retryAfterMs: 250 })

    const result = await test.operations.submit(acceptIntent(6), ACTOR, signal)

    expect(result).toMatchObject({ ok: true, receipt: { state: 'succeeded' } })
    const delivery = test.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID))
    expect(delivery).toMatchObject({
      phase: 'accepted',
      reviews: {
        current: {
          state: 'failure',
          failure: { code: 'transient-transport', retryAfterMs: 250 },
        },
      },
    })
    expect(delivery?.acceptance?.evidence).not.toHaveProperty('reviews')
  })

  it('rejects acceptance when CI fails even when the exact Pull Request has an approved review', async () => {
    const test = harness()
    const signal = new AbortController().signal
    await test.operations.submit(saveIntent(), ACTOR, signal)
    await test.operations.submit(pushIntent(), ACTOR, signal)
    await test.operations.submit(createPullRequestIntent(2), ACTOR, signal)
    await test.operations.submit(inReviewIntent(4), ACTOR, signal)
    test.github.ciSuccessful = false

    const result = await test.operations.submit(acceptIntent(6), ACTOR, signal)

    expect(result).toMatchObject({ ok: false, reason: 'conflict', receipt: { state: 'conflict' } })
    expect(test.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID))).toMatchObject({
      phase: 'in-review',
      reviews: { confirmed: { fact: { reviews: [{ state: 'approved' }] } } },
    })
  })

  it('seals a persisted acceptance checkpoint before replaying its Done child', async () => {
    const test = harness()
    await seedPreSealAcceptancePrefix(test)

    const restarted = test.createOperations()
    await restarted.initializeValidated(restarted.validateDurableState(new Set()))

    expect(test.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID))).toMatchObject({
      phase: 'accepted',
      acceptance: { intentId: ACCEPT_INTENT_ID },
    })
    expect(test.intents.get(ACCEPT_INTENT_ID)).toMatchObject({
      checkpoint: { state: 'terminal', outcome: 'succeeded' },
    })
    expect(test.moveAttempts).toHaveLength(1)
    expect(test.moveAttempts[0]).toMatchObject({ targetStatus: 'done' })
  })

  it('does not seal or move Done when acceptance authority changed after its checkpoint', async () => {
    const test = harness()
    await seedPreSealAcceptancePrefix(test)
    test.authority.current = false

    const restarted = test.createOperations()
    await restarted.initializeValidated(restarted.validateDurableState(new Set()))

    const delivery = test.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID))
    expect(delivery).toMatchObject({
      phase: 'in-review',
    })
    expect(delivery?.activeIntentId).toBeUndefined()
    expect(delivery?.acceptance).toBeUndefined()
    expect(test.intents.get(ACCEPT_INTENT_ID)).toMatchObject({
      checkpoint: { state: 'terminal', outcome: 'denied', reason: 'authority' },
    })
    expect(test.moveAttempts).toEqual([])
  })

  it('recovers cancellation when the Delivery owner write commits before the Intent terminal write', async () => {
    const test = harness()
    await seedPreSealAcceptancePrefix(test)
    test.authority.current = false
    test.intents.beforeUpdate = (_key, _current, next) => {
      if (next.id !== ACCEPT_INTENT_ID || next.checkpoint.state !== 'terminal') return
      test.intents.beforeUpdate = undefined
      throw new SimulatedProcessCrash('process stopped before the terminal Intent write')
    }

    const interrupted = test.createDetachedOperations()
    await expect(interrupted.initializeValidated(interrupted.validateDurableState(new Set())))
      .rejects.toThrow(SimulatedProcessCrash)

    const deliveryId = branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)
    expect(test.deliveries.get(deliveryId)).toMatchObject({ lastIntentId: ACCEPT_INTENT_ID })
    expect(test.deliveries.get(deliveryId)?.activeIntentId).toBeUndefined()
    expect(test.intents.get(ACCEPT_INTENT_ID)).toMatchObject({ checkpoint: { state: 'child-pending' } })

    const restarted = test.createDetachedOperations()
    const validated = restarted.validateDurableState(new Set())
    await restarted.initializeValidated(validated)

    expect(test.intents.get(ACCEPT_INTENT_ID)).toMatchObject({
      checkpoint: { state: 'terminal', outcome: 'conflict', reason: 'expected-evidence' },
    })
    expect(test.moveAttempts).toEqual([])
    expect(() => restarted.validateDurableState(new Set())).not.toThrow()
  })

  it('does not seal or move Done when the mapped context changed after its checkpoint', async () => {
    const test = harness()
    await seedPreSealAcceptancePrefix(test)
    test.context.current = { ...test.context.current, mappingRevision: 5 }

    const restarted = test.createOperations()
    await restarted.initializeValidated(restarted.validateDurableState(new Set()))

    const delivery = test.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID))
    expect(delivery).toMatchObject({ phase: 'in-review' })
    expect(delivery?.activeIntentId).toBeUndefined()
    expect(delivery?.acceptance).toBeUndefined()
    expect(test.intents.get(ACCEPT_INTENT_ID)).toMatchObject({
      checkpoint: { state: 'terminal', outcome: 'conflict', reason: 'expected-evidence' },
    })
    expect(test.moveAttempts).toEqual([])
  })

  it('does not seal or move Done when exact remote evidence changed after its checkpoint', async () => {
    const test = harness()
    await seedPreSealAcceptancePrefix(test)
    test.github.remoteCommit = UPDATED_COMMIT_ID

    const restarted = test.createOperations()
    await restarted.initializeValidated(restarted.validateDurableState(new Set()))

    const delivery = test.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID))
    expect(delivery).toMatchObject({
      phase: 'in-review',
      remoteRef: { current: { state: 'invalidated', reason: 'target-changed' } },
    })
    expect(delivery?.activeIntentId).toBeUndefined()
    expect(delivery?.acceptance).toBeUndefined()
    expect(test.intents.get(ACCEPT_INTENT_ID)).toMatchObject({
      checkpoint: { state: 'terminal', outcome: 'conflict', reason: 'expected-evidence' },
    })
    expect(test.moveAttempts).toEqual([])
  })
})

describe('Branch Delivery durable graph validation', () => {
  it('restores an In Review child repair without repeating its uncertain Work Item transition', async () => {
    const moveWorkItem = vi.fn(async () => ({ state: 'reconciliation-required' as const }))
    const test = harness({ moveWorkItem })
    const signal = new AbortController().signal
    await test.operations.submit(saveIntent(), ACTOR, signal)
    await test.operations.submit(pushIntent(), ACTOR, signal)
    await test.operations.submit(createPullRequestIntent(2), ACTOR, signal)
    test.intents.beforeUpdate = (id, _current, next) => {
      if (id === REVIEW_INTENT_ID && next.checkpoint.state === 'terminal') {
        throw new SimulatedProcessCrash('before In Review repair acknowledgement')
      }
    }
    await expect(test.operations.submit(inReviewIntent(4), ACTOR, signal))
      .rejects.toThrow('before In Review repair acknowledgement')
    test.intents.beforeUpdate = undefined
    expect(test.intents.get(REVIEW_INTENT_ID)?.checkpoint.state).toBe('child-pending')
    expect(test.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID))).toMatchObject({
      lastIntentId: REVIEW_INTENT_ID, repair: { intentId: REVIEW_INTENT_ID, reason: 'evidence-conflict' },
    })
    const restarted = test.createDetachedOperations()
    await restarted.initializeValidated(restarted.validateDurableState(new Set()))
    expect(test.intents.get(REVIEW_INTENT_ID)?.checkpoint).toMatchObject({
      state: 'terminal', outcome: 'reconciliation-required', reason: 'child-transition',
    })
    expect(moveWorkItem).toHaveBeenCalledTimes(1)
  })

  it('restores an accepted Push admission whose active Intent has not acknowledged Host preparation', async () => {
    const test = harness()
    const signal = new AbortController().signal
    await test.operations.submit(saveIntent(), ACTOR, signal)
    test.intents.beforeUpdate = (id, _current, next) => {
      if (id === PUSH_INTENT_ID && next.checkpoint.state === 'push-host-accepted') {
        throw new SimulatedProcessCrash('before accepted Host checkpoint')
      }
    }
    await expect(test.operations.submit(pushIntent(), ACTOR, signal)).rejects.toThrow('before accepted Host checkpoint')
    test.intents.beforeUpdate = undefined
    expect(test.admissions.get(BINDING_ID)).toMatchObject({ state: 'manual-host-operation', phase: 'accepted' })
    expect(test.intents.get(PUSH_INTENT_ID)?.checkpoint.state).toBe('active')
    expect(test.execution.starts).toBe(0)
    const restarted = test.createDetachedOperations()
    await restarted.initializeValidated(restarted.validateDurableState(new Set()))
    expect(test.intents.get(PUSH_INTENT_ID)?.checkpoint).toMatchObject({ state: 'terminal', outcome: 'succeeded' })
    expect(test.execution.starts).toBe(1)
  })

  it.each(['storage-error', 'next-revision', 'later-revision'] as const)(
    'does not acknowledge a Delivery ownership write after %s without its requested fields', async (race) => {
      const test = harness()
      const signal = new AbortController().signal
      await test.operations.submit(saveIntent(), ACTOR, signal)
      const update = test.deliveries.update.bind(test.deliveries)
      const failure = new Error('Delivery storage write failed')
      vi.spyOn(test.deliveries, 'update').mockImplementationOnce(async (id, operation) => {
        if (race === 'storage-error') throw failure
        const current = branchDeliveryRecordSchema.parse(test.deliveries.get(id))
        test.deliveries.values.set(id, branchDeliveryRecordSchema.parse({
          ...current, revision: current.revision + (race === 'next-revision' ? 1 : 2),
        }))
        return await update(id, operation)
      })
      const submitted = test.operations.submit(associatePullRequestIntent(), ACTOR, signal)
      if (race === 'storage-error') await expect(submitted).rejects.toBe(failure)
      else await expect(submitted).rejects.toBeInstanceOf(Error)
      expect(test.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID))?.activeIntentId).toBeUndefined()
      expect(test.intents.get(ASSOCIATE_INTENT_ID)?.checkpoint).toEqual({ state: 'prepared' })
      expect(test.github.reads).toEqual([])
    },
  )

  it.each(['storage-error', 'next-revision', 'later-revision', 'changed-payload'] as const)(
    'does not acknowledge a terminal Intent write after %s without its exact checkpoint', async (race) => {
      const test = harness()
      const update = test.intents.update.bind(test.intents)
      const failure = new Error('Intent storage write failed')
      vi.spyOn(test.intents, 'update').mockImplementationOnce(async (id, operation) => {
        if (race === 'storage-error') throw failure
        const current = branchDeliveryIntentRecordSchema.parse(test.intents.get(id))
        const payload = race === 'changed-payload'
          ? { ...current.payload, actor: { ...current.payload.actor, grantRevision: ACTOR.grantRevision + 1 } }
          : current.payload
        test.intents.values.set(id, branchDeliveryIntentRecordSchema.parse({
          ...current, payload, payloadDigest: canonicalDigest('saki/branch-delivery-intent/v1', payload),
          revision: current.revision + (race === 'changed-payload' ? 0 : race === 'next-revision' ? 1 : 2),
        }))
        return await update(id, operation)
      })
      const submitted = test.operations.submit(saveIntent(), ACTOR, new AbortController().signal)
      if (race === 'storage-error') await expect(submitted).rejects.toBe(failure)
      else await expect(submitted).rejects.toBeInstanceOf(Error)
      expect(test.intents.get(SAVE_INTENT_ID)?.checkpoint).toEqual({ state: 'prepared' })
      expect(test.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID))?.lastIntentId).toBe(SAVE_INTENT_ID)
    },
  )

  it.each(['active', 'push-host-accepted', 'changed-host-reason', 'changed-host-state'] as const)(
    'reconciles retained Push repair against its %s recovery evidence', async (scenario) => {
      const state = scenario === 'active' ? 'active' : 'push-host-accepted'
      const test = harness()
      const signal = new AbortController().signal
      await test.operations.submit(saveIntent(), ACTOR, signal)
      if (state === 'active') {
        const host = test.execution as unknown as SakiHostExecution
        vi.spyOn(host, 'prepareOperation').mockResolvedValueOnce({ ok: false, reason: 'source-conflict' })
      } else {
        test.execution.afterStart = (snapshot) => {
          const { result: _result, completedAt, ...base } = snapshot
          return { ...base, state: 'reconciliation-required', observedAt: completedAt, reason: 'effect-unknown' }
        }
      }
      test.intents.beforeUpdate = (id, _current, next) => {
        if (id === PUSH_INTENT_ID && next.checkpoint.state === 'terminal') {
          throw new SimulatedProcessCrash('before Push repair acknowledgement')
        }
      }
      await expect(test.operations.submit(pushIntent(), ACTOR, signal)).rejects.toThrow('before Push repair acknowledgement')
      test.intents.beforeUpdate = undefined
      expect(test.intents.get(PUSH_INTENT_ID)?.checkpoint.state).toBe(state)
      const delivery = test.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID))
      expect(delivery).toMatchObject({ lastIntentId: PUSH_INTENT_ID, repair: { intentId: PUSH_INTENT_ID } })
      expect(delivery?.activeIntentId).toBeUndefined()
      const restarted = test.createDetachedOperations()
      const retained = restarted.validateDurableState(new Set())
      if (scenario === 'changed-host-reason' || scenario === 'changed-host-state') {
        const snapshot = test.execution.snapshot
        if (snapshot?.state !== 'reconciliation-required') throw new Error('expected retained Host reconciliation')
        if (scenario === 'changed-host-reason') test.execution.snapshot = { ...snapshot, reason: 'evidence-conflict' }
        else {
          const { reason: _reason, observedAt: _observedAt, ...base } = snapshot
          test.execution.snapshot = { ...base, state: 'accepted' }
        }
        await expect(restarted.initializeValidated(retained)).rejects.toThrow('Branch Delivery repair disagrees with its Host snapshot')
        expect(test.intents.get(PUSH_INTENT_ID)?.checkpoint.state).toBe(state)
      } else {
        await restarted.initializeValidated(retained)
        expect(test.intents.get(PUSH_INTENT_ID)?.checkpoint).toMatchObject({
          state: 'terminal', outcome: 'reconciliation-required', reason: state === 'active' ? 'evidence-conflict' : 'effect-unknown',
        })
        expect(() => restarted.validateDurableState(new Set())).not.toThrow()
      }
      expect(test.execution.starts).toBe(state === 'active' ? 0 : 1)
    },
  )

  it('keeps a prepared Push pending while a later Save has not acknowledged its aggregate write', async () => {
    const test = harness()
    const signal = new AbortController().signal
    await test.operations.submit(saveIntent(), ACTOR, signal)
    test.deliveries.beforeUpdate = () => { throw new SimulatedProcessCrash('before Push ownership') }
    await expect(test.operations.submit(pushIntent(), ACTOR, signal)).rejects.toThrow('before Push ownership')
    test.deliveries.beforeUpdate = undefined
    test.intents.beforeUpdate = (id, _current, next) => {
      if (id === SECOND_SAVE_INTENT_ID && next.checkpoint.state === 'terminal') {
        throw new SimulatedProcessCrash('before Save acknowledgement')
      }
    }
    await expect(test.operations.submit(saveIntent(SECOND_SAVE_INTENT_ID, COMMIT_ID, 0), ACTOR, signal))
      .rejects.toThrow('before Save acknowledgement')
    test.intents.beforeUpdate = undefined
    expect(() => test.operations.validateDurableState(new Set())).not.toThrow()
    expect(await test.operations.submit(pushIntent(), ACTOR, signal)).toMatchObject({
      ok: true, receipt: { state: 'pending' },
    })
    expect(test.intents.get(PUSH_INTENT_ID)?.checkpoint).toEqual({ state: 'prepared' })
    expect(test.execution.starts).toBe(0)
  })

  it('orders simultaneously created durable aggregates and Intents by their stable ids', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
    try {
      const test = harness()
      const signal = new AbortController().signal
      test.additionalContexts.set(SECOND_WORK_ITEM_ID, {
        ...deliveryContext(), workItem: { id: SECOND_WORK_ITEM_ID, remoteFingerprint: REMOTE_FINGERPRINT,
          issueId: githubIssueId('I_issue_33') },
      })
      await test.operations.submit({ ...saveIntent(SECOND_SAVE_INTENT_ID), workItemId: SECOND_WORK_ITEM_ID }, ACTOR, signal)
      await test.operations.submit(saveIntent(), ACTOR, signal)
      const retained = test.operations.validateDurableState(new Set())
      expect(new Set(retained.deliveries.map(record => record.createdAt)).size).toBe(1)
      expect(new Set(retained.intents.map(record => record.createdAt)).size).toBe(1)
      expect(retained.deliveries.map(record => record.id)).toEqual([
        branchDeliveryId(PROJECT_ID, WORK_ITEM_ID), branchDeliveryId(PROJECT_ID, SECOND_WORK_ITEM_ID),
      ].sort((left, right) => left.localeCompare(right)))
      expect(retained.intents.map(record => record.id)).toEqual([
        SAVE_INTENT_ID, SECOND_SAVE_INTENT_ID,
      ].sort((left, right) => left.localeCompare(right)))
    } finally {
      now.mockRestore()
    }
  })

  it('rejects a persisted Save carrying another Intent\'s child-transition checkpoint', async () => {
    const test = harness()
    await seedPreSealAcceptancePrefix(test)
    const save = branchDeliveryIntentRecordSchema.parse(test.intents.get(SAVE_INTENT_ID))
    const accept = branchDeliveryIntentRecordSchema.parse(test.intents.get(ACCEPT_INTENT_ID))
    test.intents.values.set(save.id, { ...save, checkpoint: accept.checkpoint })
    expect(() => test.operations.validateDurableState(new Set())).toThrow('Branch Delivery child checkpoint is not replayable')
  })

  it('retains an unavailable association with its active owner separate from the last completed Save', async () => {
    const test = harness()
    const signal = new AbortController().signal
    await test.operations.submit(saveIntent(), ACTOR, signal)
    await test.detachOperations()
    expect(await test.operations.submit(associatePullRequestIntent(), ACTOR, signal))
      .toMatchObject({ ok: false, reason: 'unavailable' })
    const id = branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)
    expect(test.deliveries.get(id)).toMatchObject({
      revision: 1, activeIntentId: ASSOCIATE_INTENT_ID, lastIntentId: SAVE_INTENT_ID,
    })
    const restarted = test.createDetachedOperations()
    const retained = restarted.validateDurableState(new Set())
    expect(retained.intents).toContainEqual(expect.objectContaining({
      id: ASSOCIATE_INTENT_ID, checkpoint: { state: 'active', deliveryRevision: 1 },
    }))
    expect(test.github.reads).toEqual([])
    expect(test.execution.starts).toBe(0)
  })

  it('rejects Push evidence borrowing a terminal Intent from another aggregate', async () => {
    const test = harness()
    const signal = new AbortController().signal
    await test.operations.submit(saveIntent(), ACTOR, signal)
    await test.operations.submit(pushIntent(), ACTOR, signal)
    await test.operations.submit(createPullRequestIntent(2), ACTOR, signal)
    const intent = branchDeliveryIntentRecordSchema.parse(test.intents.get(PUSH_INTENT_ID))
    if (intent.operation.kind !== 'push' || intent.payload.intent.type !== 'push-branch-delivery') {
      throw new Error('expected retained Push Intent')
    }
    const deliveryId = branchDeliveryId(PROJECT_ID, SECOND_WORK_ITEM_ID)
    const payload = { ...intent.payload, intent: { ...intent.payload.intent, deliveryId } }
    const payloadDigest = canonicalDigest('saki/branch-delivery-intent/v1', payload)
    test.intents.values.set(intent.id, branchDeliveryIntentRecordSchema.parse({
      ...intent, deliveryId, payload, payloadDigest,
      operation: {
        ...intent.operation,
        request: { ...intent.operation.request, source: { ...intent.operation.request.source, payloadDigest } },
      },
      checkpoint: { state: 'terminal', outcome: 'conflict', reason: 'expected-evidence' },
    }))
    expect(() => test.operations.validateDurableState(new Set()))
      .toThrow('Branch Delivery Push Intent reference is inconsistent')
  })

  it('rejects a PR repair attached to an Intent that has not become active', async () => {
    const test = harness()
    const signal = new AbortController().signal
    await test.operations.submit(saveIntent(), ACTOR, signal)
    await test.operations.submit(pushIntent(), ACTOR, signal)
    await test.operations.submit(createPullRequestIntent(2), ACTOR, signal)
    const id = branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)
    const delivery = branchDeliveryRecordSchema.parse(test.deliveries.get(id))
    const intent = branchDeliveryIntentRecordSchema.parse(test.intents.get(PULL_REQUEST_INTENT_ID))
    test.intents.values.set(intent.id, { ...intent, checkpoint: { state: 'prepared' } })
    test.deliveries.values.set(id, {
      ...delivery, repair: { intentId: intent.id, reason: 'marker-ambiguous', recordedAt: delivery.updatedAt },
    })
    expect(() => test.operations.validateDurableState(new Set()))
      .toThrow('Branch Delivery repair Intent reference is inconsistent')
  })

  it.each(['save', 'push', 'accept'] as const)('rejects a repair reason unavailable to its %s owner', async (kind) => {
    const test = harness()
    const signal = new AbortController().signal
    if (kind === 'accept') await seedPreSealAcceptancePrefix(test)
    else {
      await test.operations.submit(saveIntent(), ACTOR, signal)
      if (kind === 'push') await test.operations.submit(pushIntent(), ACTOR, signal)
    }
    const id = branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)
    const delivery = branchDeliveryRecordSchema.parse(test.deliveries.get(id))
    const intentId = kind === 'save' ? SAVE_INTENT_ID : kind === 'push' ? PUSH_INTENT_ID : ACCEPT_INTENT_ID
    test.deliveries.values.set(id, {
      ...delivery, activeIntentId: undefined, lastIntentId: intentId,
      repair: { intentId, reason: kind === 'push' ? 'marker-ambiguous' : 'effect-unknown', recordedAt: delivery.updatedAt },
    })
    expect(() => test.operations.validateDurableState(new Set()))
      .toThrow('Branch Delivery repair Intent reference is inconsistent')
  })

  it.each(['active', 'pull-request-effect-possible'] as const)(
    'accepts the PR repair write before its %s Intent acknowledges reconciliation', async (state) => {
      const test = harness()
      const signal = new AbortController().signal
      await test.operations.submit(saveIntent(), ACTOR, signal)
      await test.operations.submit(pushIntent(), ACTOR, signal)
      await test.operations.submit(createPullRequestIntent(2), ACTOR, signal)
      const id = branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)
      const delivery = branchDeliveryRecordSchema.parse(test.deliveries.get(id))
      const intent = branchDeliveryIntentRecordSchema.parse(test.intents.get(PULL_REQUEST_INTENT_ID))
      test.intents.values.set(intent.id, { ...intent, checkpoint: { state, deliveryRevision: delivery.revision - 1 } })
      test.deliveries.values.set(id, {
        ...delivery, repair: { intentId: intent.id, reason: 'marker-ambiguous', recordedAt: delivery.updatedAt },
      })
      expect(() => test.operations.validateDurableState(new Set())).not.toThrow()
      test.intents.values.set(intent.id, { ...intent, checkpoint: { state, deliveryRevision: delivery.revision } })
      expect(() => test.operations.validateDurableState(new Set()))
        .toThrow('Branch Delivery repair Intent reference is inconsistent')
    },
  )

  it('accepts child-transition repair publication before acknowledgement without replaying Done', async () => {
    const test = harness()
    await seedPreSealAcceptancePrefix(test)
    const id = branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)
    const delivery = branchDeliveryRecordSchema.parse(test.deliveries.get(id))
    test.deliveries.values.set(id, {
      ...delivery, revision: 8, activeIntentId: undefined, lastIntentId: ACCEPT_INTENT_ID,
      repair: { intentId: ACCEPT_INTENT_ID, reason: 'evidence-conflict', recordedAt: delivery.updatedAt },
    })
    const restarted = test.createDetachedOperations()
    await restarted.initializeValidated(restarted.validateDurableState(new Set()))
    expect(test.intents.get(ACCEPT_INTENT_ID)?.checkpoint).toMatchObject({
      state: 'terminal', outcome: 'reconciliation-required', reason: 'child-transition',
    })
    expect(test.moveAttempts).toEqual([])
  })

  it('rejects an active transition whose Work Item fingerprint differs from its aggregate', async () => {
    const test = harness()
    await seedPreSealAcceptancePrefix(test)
    const id = branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)
    const delivery = branchDeliveryRecordSchema.parse(test.deliveries.get(id))
    test.deliveries.values.set(id, {
      ...delivery, lastIntentId: ACCEPT_INTENT_ID,
      target: { ...delivery.target, workItem: { ...delivery.target.workItem, remoteFingerprint: REMOTE_FINGERPRINT } },
    })
    expect(() => test.operations.validateDurableState(new Set()))
      .toThrow('Branch Delivery last Intent reference is inconsistent')
  })

  it('rejects accepted Delivery attribution that differs from its accepting Intent', async () => {
    const test = harness()
    const signal = new AbortController().signal
    await test.operations.submit(saveIntent(), ACTOR, signal)
    await test.operations.submit(pushIntent(), ACTOR, signal)
    await test.operations.submit(createPullRequestIntent(2), ACTOR, signal)
    await test.operations.submit(inReviewIntent(4), ACTOR, signal)
    await test.operations.submit(acceptIntent(6), ACTOR, signal)
    const id = branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)
    const delivery = branchDeliveryRecordSchema.parse(test.deliveries.get(id))
    if (delivery.acceptance === undefined) throw new Error('expected accepted Delivery evidence')
    test.deliveries.values.set(id, {
      ...delivery,
      acceptance: { ...delivery.acceptance, actor: { ...ACTOR, grantRevision: ACTOR.grantRevision + 1 } },
    })
    expect(() => test.operations.validateDurableState(new Set()))
      .toThrow('Branch Delivery last Intent reference is inconsistent')
  })

  it('rejects an aggregate identity derived from another Work Item', async () => {
    const test = harness()
    await test.operations.submit(saveIntent(), ACTOR, new AbortController().signal)
    const id = branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)
    const otherId = branchDeliveryId(PROJECT_ID, SECOND_WORK_ITEM_ID)
    const delivery = branchDeliveryRecordSchema.parse(test.deliveries.get(id))
    test.deliveries.values.delete(id)
    test.deliveries.values.set(otherId, {
      ...delivery, id: otherId,
      markerId: githubPullRequestCreateMarkerId(`pull-request-marker-${canonicalDigest(
        'saki/branch-delivery/pull-request-marker/v1', { deliveryId: otherId },
      )}`),
    })
    expect(() => test.operations.validateDurableState(new Set()))
      .toThrow('Branch Delivery id disagrees with its Project and Work Item')
  })

  it('rejects an active owner that points to a completed Save Intent', async () => {
    const test = harness()
    await test.operations.submit(saveIntent(), ACTOR, new AbortController().signal)
    const id = branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)
    const delivery = branchDeliveryRecordSchema.parse(test.deliveries.get(id))
    test.deliveries.values.set(id, { ...delivery, activeIntentId: SAVE_INTENT_ID })
    expect(() => test.operations.validateDurableState(new Set()))
      .toThrow('Branch Delivery active Intent owner is inconsistent')
  })

  it('rejects two different recoverable owners for one Delivery', async () => {
    const test = harness()
    await seedPreSealAcceptancePrefix(test)
    const id = branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)
    const delivery = branchDeliveryRecordSchema.parse(test.deliveries.get(id))
    test.deliveries.values.set(id, { ...delivery, activeIntentId: REVIEW_INTENT_ID, lastIntentId: ACCEPT_INTENT_ID })
    expect(() => test.operations.validateDurableState(new Set()))
      .toThrow('Branch Delivery has two recoverable Intent owners')
  })

  it.each(['prepared', 'active', 'succeeded'] as const)(
    'rejects a %s non-Save Intent whose aggregate disappeared', async (state) => {
      const test = harness()
      const signal = new AbortController().signal
      await test.operations.submit(saveIntent(), ACTOR, signal)
      await test.operations.submit(pushIntent(), ACTOR, signal)
      await test.operations.submit(createPullRequestIntent(2), ACTOR, signal)
      const intent = branchDeliveryIntentRecordSchema.parse(test.intents.get(PULL_REQUEST_INTENT_ID))
      test.deliveries.values.clear()
      test.intents.values.clear()
      test.intents.values.set(intent.id, {
        ...intent,
        checkpoint: state === 'succeeded' ? intent.checkpoint
          : state === 'prepared' ? { state } : { state, deliveryRevision: 3 },
      })
      expect(() => test.operations.validateDurableState(new Set()))
        .toThrow('Branch Delivery Intent targets a missing aggregate')
    },
  )

  it('rejects a nonterminal Intent after both aggregate ownership references disappear', async () => {
    const test = harness()
    await seedPreSealAcceptancePrefix(test)
    const id = branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)
    const delivery = branchDeliveryRecordSchema.parse(test.deliveries.get(id))
    test.deliveries.values.set(id, { ...delivery, activeIntentId: undefined, lastIntentId: REVIEW_INTENT_ID })
    expect(() => test.operations.validateDurableState(new Set()))
      .toThrow('recoverable Branch Delivery Intent has no matching aggregate owner')
  })

  it('rejects an active PR Intent whose retained request targets another branch', async () => {
    const test = harness()
    await seedPreSealAcceptancePrefix(test)
    const id = branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)
    const delivery = branchDeliveryRecordSchema.parse(test.deliveries.get(id))
    const intent = branchDeliveryIntentRecordSchema.parse(test.intents.get(PULL_REQUEST_INTENT_ID))
    test.intents.values.delete(ACCEPT_INTENT_ID)
    test.intents.values.set(intent.id, { ...intent, checkpoint: { state: 'active', deliveryRevision: 3 } })
    test.deliveries.values.set(id, {
      ...delivery, phase: 'draft', revision: 3, activeIntentId: intent.id, lastIntentId: REVIEW_INTENT_ID,
      headRef: 'refs/heads/another-branch', push: undefined,
      remoteRef: { current: { state: 'unobserved' } }, pullRequest: { current: { state: 'unobserved' } },
      reviews: { current: { state: 'unobserved' } }, ci: { current: { state: 'unobserved' } },
    })
    expect(() => test.operations.validateDurableState(new Set()))
      .toThrow('recoverable Branch Delivery Intent changed its exact target')
  })

  it('rejects Push evidence whose Intent was deleted after a later Delivery operation', async () => {
    const test = harness()
    const signal = new AbortController().signal
    await test.operations.submit(saveIntent(), ACTOR, signal)
    await test.operations.submit(pushIntent(), ACTOR, signal)
    await test.operations.submit(createPullRequestIntent(2), ACTOR, signal)
    test.intents.values.delete(PUSH_INTENT_ID)
    expect(() => test.operations.validateDurableState(new Set()))
      .toThrow('Branch Delivery Push Intent reference is inconsistent')
  })

  it.each(['operation-id', 'marker-id'] as const)('rejects changed PR recovery %s before durable graph admission', async (field) => {
    const test = harness()
    const signal = new AbortController().signal
    await test.operations.submit(saveIntent(), ACTOR, signal)
    await test.operations.submit(pushIntent(), ACTOR, signal)
    await test.operations.submit(createPullRequestIntent(2), ACTOR, signal)
    const intent = branchDeliveryIntentRecordSchema.parse(test.intents.get(PULL_REQUEST_INTENT_ID))
    if (intent.operation.kind !== 'pull-request-create') throw new Error('expected retained PR create operation')
    const request = intent.operation.request
    const markerId = githubPullRequestCreateMarkerId(`pull-request-marker-${'f'.repeat(64)}`)
    const parsed = branchDeliveryIntentRecordSchema.safeParse({
      ...intent,
      operation: {
        ...intent.operation,
        request: field === 'operation-id' ? { ...request, operationId: 'another-operation' } : {
          ...request, markerId, body: request.body.replaceAll(request.markerId, markerId),
        },
      },
    })
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(parsed.error.issues).toContainEqual(expect.objectContaining({
      message: 'Branch Delivery Pull Request request lacks stable recovery identity',
    }))
  })
})

describe('Branch Delivery Push admission', () => {
  const signal = new AbortController().signal

  async function saved() {
    const test = harness()
    await test.operations.submit(saveIntent(), ACTOR, signal)
    return test
  }

  async function reserved() {
    const test = await saved()
    test.execution.crashBeforePrepareOnce = true
    await expect(test.operations.submit(pushIntent(), ACTOR, signal)).rejects.toBeInstanceOf(SimulatedProcessCrash)
    return test
  }

  it('keeps a Push pending until its Binding admission exists', async () => {
    const test = await saved()
    const available = test.admissions.get(BINDING_ID)!
    await test.admissions.delete(BINDING_ID)
    expect(await test.operations.submit(pushIntent(), ACTOR, signal)).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(test.execution.starts).toBe(0)
    await test.admissions.put(BINDING_ID, available)
    expect(await test.operations.submit(pushIntent(), ACTOR, signal)).toMatchObject({ ok: true })
    expect(test.execution.starts).toBe(1)
  })

  it.each(['other-push', 'manual-commit'] as const)('does not steal a reservation held by %s', async (owner) => {
    const test = await reserved()
    const own = test.admissions.get(BINDING_ID)
    if (own?.state !== 'manual-host-operation') throw new Error('missing reservation')
    const foreign = {
      ...own,
      action: owner === 'other-push' ? 'project-branch:push' as const : 'project-commit:create' as const,
      source: { ...own.source, intentId: SECOND_SAVE_INTENT_ID },
    }
    await test.admissions.put(BINDING_ID, foreign)
    expect(await test.operations.submit(pushIntent(), ACTOR, signal)).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(test.admissions.get(BINDING_ID)).toEqual(foreign)
    expect(test.execution.starts).toBe(0)
  })

  it.each(['missing', 'foreign'] as const)('rechecks a changed target with %s reservation after interruption', async (state) => {
    const test = await reserved()
    test.context.current = { ...test.context.current, mappingRevision: 5 }
    const own = test.admissions.get(BINDING_ID)
    if (own?.state !== 'manual-host-operation') throw new Error('missing reservation')
    if (state === 'missing') await test.admissions.delete(BINDING_ID)
    else await test.admissions.put(BINDING_ID, { ...own, source: { ...own.source, intentId: SECOND_SAVE_INTENT_ID } })
    expect(await test.operations.submit(pushIntent(), ACTOR, signal)).toMatchObject({ ok: false })
    expect(test.intents.get(PUSH_INTENT_ID)?.checkpoint).toMatchObject(state === 'missing'
      ? { state: 'active' }
      : { state: 'terminal', outcome: 'conflict' })
    expect(test.execution.starts).toBe(0)
  })

  it.each(['unavailable', 'source-conflict'] as const)('retains the Host preparation %s result without starting', async (reason) => {
    const test = await saved()
    const host = test.execution as unknown as SakiHostExecution
    vi.spyOn(host, 'prepareOperation').mockResolvedValueOnce({ ok: false, reason })
    expect(await test.operations.submit(pushIntent(), ACTOR, signal)).toMatchObject({ ok: false })
    expect(test.intents.get(PUSH_INTENT_ID)?.checkpoint).toMatchObject(reason === 'unavailable'
      ? { state: 'active' }
      : { state: 'terminal', outcome: 'reconciliation-required' })
    expect(test.execution.starts).toBe(0)
  })

  it.each(['reserve', 'accept'] as const)('does not mask an uncommitted %s admission write', async (phase) => {
    const test = await saved()
    const failure = new Error('admission persistence unavailable')
    const update = test.admissions.update.bind(test.admissions)
    let calls = 0
    vi.spyOn(test.admissions, 'update').mockImplementation(async (id, operation) => {
      calls += 1
      if (calls === (phase === 'reserve' ? 1 : 2)) throw failure
      return await update(id, operation)
    })
    await expect(test.operations.submit(pushIntent(), ACTOR, signal)).rejects.toBe(failure)
    expect(test.execution.starts).toBe(0)
    expect(await test.operations.submit(pushIntent(), ACTOR, signal)).toMatchObject({ ok: true })
    expect(test.execution.starts).toBe(1)
  })

  it('does not accept a reservation replaced while the Host prepares', async () => {
    const test = await saved()
    const prepare = test.execution.prepareOperation.bind(test.execution)
    vi.spyOn(test.execution, 'prepareOperation').mockImplementation(async (...args) => {
      const result = await prepare(...args)
      const admission = test.admissions.get(BINDING_ID)
      if (admission?.state !== 'manual-host-operation') throw new Error('missing reservation')
      await test.admissions.put(BINDING_ID, { ...admission, source: { ...admission.source, intentId: SECOND_SAVE_INTENT_ID } })
      return result
    })
    expect(await test.operations.submit(pushIntent(), ACTOR, signal)).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(test.execution.starts).toBe(0)
    expect(test.admissions.get(BINDING_ID)).toMatchObject({ source: { intentId: SECOND_SAVE_INTENT_ID } })
  })

  it('keeps an accepted Push pending when its admission disappears before Host start', async () => {
    const test = await saved()
    let accepted: BindingWriteAdmissionRecord | undefined
    test.execution.beforeAdmission = () => {
      accepted = test.admissions.get(BINDING_ID)
      test.admissions.values.delete(BINDING_ID)
    }
    expect(await test.operations.submit(pushIntent(), ACTOR, signal)).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(test.execution.starts).toBe(0)
    expect(test.execution.cancellations).toEqual([])
    if (accepted === undefined) throw new Error('missing accepted admission')
    await test.admissions.put(BINDING_ID, accepted)
    test.execution.beforeAdmission = undefined
    expect(await test.operations.submit(pushIntent(), ACTOR, signal)).toMatchObject({ ok: true })
    expect(test.execution.starts).toBe(1)
  })

  it('rejects a Host preparation whose identity disagrees with its snapshot', async () => {
    const test = await saved()
    const prepare = test.execution.prepareOperation.bind(test.execution)
    vi.spyOn(test.execution, 'prepareOperation').mockImplementation(async (...args) => {
      const result = await prepare(...args)
      return { ...result, preparation: {
        ...result.preparation,
        operation: { ...result.preparation.operation, id: 'host-operation-00000000-0000-4000-8000-000000000299' as HostOperationId },
      } }
    })
    await expect(test.operations.submit(pushIntent(), ACTOR, signal)).rejects.toThrow('Push Host preparation disagrees')
    expect(test.execution.starts).toBe(0)
  })

  it('rejects a Host snapshot routed to another Binding revision', async () => {
    const test = await saved()
    const prepare = test.execution.prepareOperation.bind(test.execution)
    vi.spyOn(test.execution, 'prepareOperation').mockImplementation(async (...args) => {
      const result = await prepare(...args)
      return { ...result, snapshot: { ...result.snapshot, bindingRevision: result.snapshot.bindingRevision + 1 } }
    })
    await expect(test.operations.submit(pushIntent(), ACTOR, signal)).rejects.toThrow('Push Host snapshot disagrees')
    expect(test.execution.starts).toBe(0)
  })

  it('rejects a Host that changes its retained preparation revision during replay', async () => {
    const test = await saved()
    const host = test.execution as unknown as SakiHostExecution
    const start = vi.spyOn(host, 'startOperation').mockImplementationOnce(async () => ({
      ok: false, reason: 'busy', snapshot: await test.execution.inspectOperation(),
    }))
    expect(await test.operations.submit(pushIntent(), ACTOR, signal)).toMatchObject({ ok: false, reason: 'unavailable' })
    start.mockRestore()
    const prepare = test.execution.prepareOperation.bind(test.execution)
    vi.spyOn(test.execution, 'prepareOperation').mockImplementation(async (...args) => {
      const result = await prepare(...args)
      return { ...result, preparation: { ...result.preparation, preparationRevision: 1 } }
    })
    await expect(test.operations.submit(pushIntent(), ACTOR, signal)).rejects.toThrow('Push Host preparation changed during replay')
    expect(test.execution.starts).toBe(0)
  })

  async function pendingAdmission() {
    const test = await saved()
    const host = test.execution as unknown as SakiHostExecution
    const start = vi.spyOn(host, 'startOperation').mockImplementationOnce(async () => ({
      ok: false, reason: 'busy', snapshot: await test.execution.inspectOperation(),
    }))
    await test.operations.submit(pushIntent(), ACTOR, signal)
    start.mockRestore()
    const intent = test.intents.get(PUSH_INTENT_ID)
    if (intent?.checkpoint.state !== 'push-host-accepted' || intent.operation.kind !== 'push'
      || test.execution.admissionSource === undefined) throw new Error('missing pending Host admission')
    return {
      test,
      intent,
      admit: test.execution.admissionSource,
      expectation: {
        bindingId: intent.operation.request.expected.binding.id,
        bindingRevision: intent.operation.request.expected.binding.revision,
        preparation: intent.checkpoint.preparation,
        source: intent.operation.request.source,
      },
    }
  }

  it.each(['intent-missing', 'intent-active', 'non-push-intent', 'binding-revision', 'preparation-id'] as const)(
    'denies the Host admission callback for stale %s evidence', async (change) => {
      const { test, intent, admit, expectation } = await pendingAdmission()
      let stale = expectation
      if (change === 'intent-missing') test.intents.values.delete(PUSH_INTENT_ID)
      else if (change === 'intent-active') {
        test.intents.values.set(PUSH_INTENT_ID, {
          ...intent, checkpoint: { state: 'active', deliveryRevision: 1 },
        })
      }
      else if (change === 'non-push-intent') stale = {
        ...expectation, source: { ...expectation.source, intentId: SAVE_INTENT_ID },
      }
      else if (change === 'binding-revision') stale = { ...expectation, bindingRevision: expectation.bindingRevision + 1 }
      else stale = { ...expectation, preparation: {
        ...expectation.preparation,
        operation: { ...expectation.preparation.operation, id: 'host-operation-00000000-0000-4000-8000-000000000299' as HostOperationId },
      } }
      expect(await admit(stale, signal)).toEqual({ kind: 'denied', reason: 'not-current' })
      expect(test.execution.starts).toBe(0)
    },
  )

  it.each(['revision', 'reserved', 'different-source', 'other-action'] as const)(
    'denies the Host admission callback after a durable admission changes its %s', async (change) => {
      const { test, admit, expectation } = await pendingAdmission()
      const admission = test.admissions.get(BINDING_ID)
      if (admission?.state !== 'manual-host-operation' || admission.phase !== 'accepted') {
        throw new Error('missing accepted admission')
      }
      if (change === 'revision') await test.admissions.put(BINDING_ID, { ...admission, revision: admission.revision + 1 })
      else if (change === 'different-source') await test.admissions.put(BINDING_ID, {
        ...admission, source: { ...admission.source, intentId: SECOND_SAVE_INTENT_ID },
      })
      else if (change === 'other-action') await test.admissions.put(BINDING_ID, {
        ...admission, action: 'project-commit:create',
      })
      else {
        const { preparation: _preparation, acceptedAt: _acceptedAt, ...reservedAdmission } = admission
        await test.admissions.put(BINDING_ID, { ...reservedAdmission, phase: 'reserved' })
      }
      expect(await admit(expectation, signal)).toEqual({ kind: 'denied', reason: 'not-current' })
      expect(test.execution.starts).toBe(0)
    },
  )

  it.each(['missing', 'foreign'] as const)('retains successful Host evidence when its admission is %s at release', async (change) => {
    const test = await saved()
    let retained: BindingWriteAdmissionRecord | undefined
    test.execution.afterStart = (snapshot) => {
      retained = test.admissions.get(BINDING_ID)
      if (retained?.state !== 'manual-host-operation') throw new Error('missing accepted admission')
      if (change === 'missing') test.admissions.values.delete(BINDING_ID)
      else test.admissions.values.set(BINDING_ID, {
        ...retained, source: { ...retained.source, intentId: SECOND_SAVE_INTENT_ID },
      })
      return snapshot
    }
    await expect(test.operations.submit(pushIntent(), ACTOR, signal)).rejects.toThrow()
    expect(test.intents.get(PUSH_INTENT_ID)?.checkpoint).toMatchObject({ state: 'terminal', outcome: 'succeeded' })
    expect(test.execution.starts).toBe(1)
    if (retained === undefined) throw new Error('missing retained admission')
    await test.admissions.put(BINDING_ID, retained)
    expect(await test.operations.submit(pushIntent(), ACTOR, signal)).toMatchObject({ ok: true })
    expect(test.admissions.get(BINDING_ID)).toMatchObject({ state: 'available' })
    expect(test.execution.starts).toBe(1)
  })

  it('does not release another Push reservation while replaying a completed delivery', async () => {
    const test = await saved()
    await test.operations.submit(pushIntent(), ACTOR, signal)
    const available = test.admissions.get(BINDING_ID)!
    const request = test.execution.request!
    const foreign: BindingWriteAdmissionRecord = {
      ...available,
      state: 'manual-host-operation',
      phase: 'reserved',
      action: 'project-branch:push',
      bindingRevision: request.expected.binding.revision,
      source: { ...request.source, intentId: SECOND_SAVE_INTENT_ID },
      reservedAt: available.updatedAt,
    }
    await test.admissions.put(BINDING_ID, foreign)
    expect(await test.operations.submit(pushIntent(), ACTOR, signal)).toMatchObject({ ok: true })
    expect(test.admissions.get(BINDING_ID)).toEqual(foreign)
    expect(test.execution.starts).toBe(1)
    await test.admissions.delete(BINDING_ID)
    await expect(test.operations.submit(pushIntent(), ACTOR, signal)).rejects.toThrow()
    expect(test.execution.starts).toBe(1)
  })

  it('replays accepted admission after its Intent checkpoint write is interrupted', async () => {
    const test = await saved()
    test.intents.beforeUpdate = (_id, _current, next) => {
      if (next.checkpoint.state !== 'push-host-accepted') return
      test.intents.beforeUpdate = undefined
      throw new SimulatedProcessCrash()
    }
    await expect(test.operations.submit(pushIntent(), ACTOR, signal)).rejects.toBeInstanceOf(SimulatedProcessCrash)
    expect(test.admissions.get(BINDING_ID)).toMatchObject({ phase: 'accepted' })
    expect(await test.operations.submit(pushIntent(), ACTOR, signal)).toMatchObject({ ok: true })
    expect(test.execution.starts).toBe(1)
    expect(test.admissions.get(BINDING_ID)).toMatchObject({ state: 'available', revision: 3 })
  })

  it('finishes a canceled Host receipt after the Delivery release was already durable', async () => {
    const test = await saved()
    test.execution.beforeAdmission = () => { test.authority.current = false }
    test.intents.beforeUpdate = (_id, _current, next) => {
      if (next.checkpoint.state !== 'terminal') return
      test.intents.beforeUpdate = undefined
      throw new SimulatedProcessCrash()
    }
    await expect(test.operations.submit(pushIntent(), ACTOR, signal)).rejects.toBeInstanceOf(SimulatedProcessCrash)
    expect(test.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID))?.activeIntentId).toBeUndefined()
    expect(await test.operations.submit(pushIntent(), ACTOR, signal)).toMatchObject({ ok: false, reason: 'denied' })
    expect(test.admissions.get(BINDING_ID)).toMatchObject({ state: 'available' })
    expect(test.execution.starts).toBe(0)
    expect(test.execution.cancellations).toEqual(['authority-revoked'])
  })

  it('keeps waiting when the Host cannot yet finish cancellation', async () => {
    const test = await saved()
    test.execution.beforeAdmission = () => { test.authority.current = false }
    vi.spyOn(test.execution, 'cancelOperation').mockImplementationOnce(async () => await test.execution.inspectOperation())
    expect(await test.operations.submit(pushIntent(), ACTOR, signal)).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(test.intents.get(PUSH_INTENT_ID)?.checkpoint).toMatchObject({ state: 'push-host-accepted' })
    expect(test.admissions.get(BINDING_ID)).toMatchObject({ phase: 'accepted' })
    expect(test.execution.starts).toBe(0)
    expect(await test.operations.submit(pushIntent(), ACTOR, signal)).toMatchObject({ ok: false, reason: 'denied' })
  })

  it('rejects a terminal Host fact that changed after the Delivery receipt was retained', async () => {
    const test = await saved()
    await test.operations.submit(pushIntent(), ACTOR, signal)
    const snapshot = test.execution.snapshot
    if (snapshot?.state !== 'succeeded') throw new Error('missing terminal Host snapshot')
    test.execution.snapshot = { ...snapshot, completedAt: snapshot.completedAt + 1, updatedAt: snapshot.updatedAt + 1 }
    await expect(test.operations.submit(pushIntent(), ACTOR, signal)).rejects.toThrow('terminal Push snapshot disagrees')
    expect(test.execution.starts).toBe(1)
  })

  it('rejects a changed Host success when recovering an applied Delivery write prefix', async () => {
    const test = await saved()
    test.intents.beforeUpdate = (_id, _current, next) => {
      if (next.checkpoint.state !== 'terminal') return
      test.intents.beforeUpdate = undefined
      throw new SimulatedProcessCrash()
    }
    await expect(test.operations.submit(pushIntent(), ACTOR, signal)).rejects.toBeInstanceOf(SimulatedProcessCrash)
    const snapshot = test.execution.snapshot
    if (snapshot?.state !== 'succeeded') throw new Error('missing terminal Host snapshot')
    test.execution.snapshot = { ...snapshot, completedAt: snapshot.completedAt + 1, updatedAt: snapshot.updatedAt + 1 }
    await expect(test.operations.submit(pushIntent(), ACTOR, signal)).rejects.toThrow('Applied Branch Push disagrees')
    expect(test.execution.starts).toBe(1)
  })

  it('rejects an inspected Host operation whose retained preparation changed', async () => {
    const { test } = await pendingAdmission()
    const snapshot = test.execution.snapshot!
    test.execution.snapshot = {
      ...snapshot,
      requestFingerprint: { ...snapshot.requestFingerprint, digest: 'f'.repeat(64) },
    }
    const prepare = test.execution.prepareOperation.bind(test.execution)
    vi.spyOn(test.execution, 'prepareOperation').mockImplementation(async (...args) => {
      const result = await prepare(...args)
      return { ...result, preparation: {
        ...result.preparation, requestFingerprint: test.execution.snapshot!.requestFingerprint,
      } }
    })
    await expect(test.operations.submit(pushIntent(), ACTOR, signal)).rejects.toThrow('Push Host snapshot changed preparation')
    expect(test.execution.starts).toBe(0)
  })

  it('rejects a Host success that published another Commit', async () => {
    const test = await saved()
    test.execution.afterStart = snapshot => ({ ...snapshot, result: { ...snapshot.result, commitId: UPDATED_COMMIT_ID } })
    await expect(test.operations.submit(pushIntent(), ACTOR, signal)).rejects.toThrow('Push result disagrees')
    expect(test.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID))?.push).toBeUndefined()
    expect(test.admissions.get(BINDING_ID)).toMatchObject({ phase: 'accepted' })
  })

  it.each(['before-release', 'queued-release', 'queued-foreign', 'queued-missing'] as const)(
    'rechecks current admission ownership during %s', async (change) => {
      const test = await saved()
      const update = test.admissions.update.bind(test.admissions)
      let count = 0
      const release = () => {
        const current = test.admissions.get(BINDING_ID)!
        test.admissions.values.set(BINDING_ID, {
          id: BINDING_ID, schemaVersion: 1, revision: current.revision + 1,
          state: 'available', updatedAt: current.updatedAt,
        })
      }
      if (change === 'before-release') test.execution.afterStart = (snapshot) => { release(); return snapshot }
      else vi.spyOn(test.admissions, 'update').mockImplementation(async (id, operation) => {
        count += 1
        if (count === 3) {
          if (change === 'queued-release') release()
          else if (change === 'queued-missing') test.admissions.values.delete(BINDING_ID)
          else {
            const current = test.admissions.get(BINDING_ID)
            if (current?.state !== 'manual-host-operation') throw new Error('missing accepted admission')
            test.admissions.values.set(BINDING_ID, { ...current, revision: current.revision + 1 })
          }
        }
        return await update(id, operation)
      })
      const result = test.operations.submit(pushIntent(), ACTOR, signal)
      if (change === 'queued-foreign' || change === 'queued-missing') await expect(result).rejects.toThrow()
      else expect(await result).toMatchObject({ ok: true })
      expect(test.execution.starts).toBe(1)
      expect(test.intents.get(PUSH_INTENT_ID)?.checkpoint).toMatchObject({ state: 'terminal', outcome: 'succeeded' })
    },
  )

  it('denies an Agent Run dispatch presented to the Push admission callback', async () => {
    const { test, admit, expectation } = await pendingAdmission()
    expect(await admit({ ...expectation, source: {
      kind: 'execution-dispatch',
      dispatchId: sakiExecutionDispatchIdSchema.parse('dispatch-00000000-0000-4000-8000-000000000299'),
      payloadDigest: 'f'.repeat(64),
    } }, signal)).toEqual({ kind: 'denied', reason: 'not-current' })
    expect(test.execution.starts).toBe(0)
  })

  it.each(['reserve', 'accept'] as const)('reports an admission disappearing during its %s write', async (phase) => {
    const test = await saved()
    const failure = new Error('admission row removed during write')
    const update = test.admissions.update.bind(test.admissions)
    let calls = 0
    vi.spyOn(test.admissions, 'update').mockImplementation(async (id, operation) => {
      calls += 1
      if (calls === (phase === 'reserve' ? 1 : 2)) {
        await test.admissions.delete(id)
        throw failure
      }
      return await update(id, operation)
    })
    await expect(test.operations.submit(pushIntent(), ACTOR, signal)).rejects.toBe(failure)
    expect(test.execution.starts).toBe(0)
    expect(test.intents.get(PUSH_INTENT_ID)?.checkpoint).toMatchObject({ state: 'active' })
  })

  it('rejects a Host success contradicting an already-applied cancellation prefix', async () => {
    const test = await saved()
    test.execution.beforeAdmission = () => { test.authority.current = false }
    test.intents.beforeUpdate = (_id, _current, next) => {
      if (next.checkpoint.state !== 'terminal') return
      test.intents.beforeUpdate = undefined
      throw new SimulatedProcessCrash()
    }
    await expect(test.operations.submit(pushIntent(), ACTOR, signal)).rejects.toBeInstanceOf(SimulatedProcessCrash)
    const canceled = test.execution.snapshot
    if (canceled?.state !== 'canceled') throw new Error('missing canceled Host snapshot')
    const { reason: _reason, effect: _effect, ...base } = canceled
    test.execution.snapshot = {
      ...base,
      state: 'succeeded',
      admission: { kind: 'accepted', revision: 2, acceptedAt: 11 },
      result: {
        type: 'push-branch',
        repository: { nameWithOwner: 'BreakfastDaPaiDang/saki' },
        targetRef: 'refs/heads/feature/delivery',
        commitId: COMMIT_ID,
        previous: { kind: 'absent' },
        credential: { helperId: 'git-credential-manager' },
      },
    }
    await expect(test.operations.submit(pushIntent(), ACTOR, signal)).rejects.toThrow('Push success lost its Branch Delivery ownership')
    expect(test.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID))?.push).toBeUndefined()
    expect(test.execution.starts).toBe(0)
  })

  it.each(['Save', 'Pull Request'] as const)('rejects a durable Push reservation referencing a %s Intent', async (kind) => {
    const test = await saved()
    if (kind === 'Pull Request') {
      await test.operations.submit(pushIntent(), ACTOR, signal)
      await test.operations.submit(createPullRequestIntent(2), ACTOR, signal)
    }
    const referenced = branchDeliveryIntentRecordSchema.parse(test.intents.get(
      kind === 'Save' ? SAVE_INTENT_ID : PULL_REQUEST_INTENT_ID,
    ))
    const available = test.admissions.get(BINDING_ID)!
    const reservation = bindingWriteAdmissionRecordSchema.parse({
      id: BINDING_ID,
      schemaVersion: 1,
      revision: available.revision + 1,
      state: 'manual-host-operation',
      phase: 'reserved',
      action: 'project-branch:push',
      bindingRevision: test.context.current.binding.revision,
      source: {
        kind: 'control-intent',
        intentId: referenced.id,
        intentRevision: referenced.revision,
        payloadDigest: referenced.payloadDigest,
      },
      reservedAt: available.updatedAt,
      updatedAt: available.updatedAt,
    })
    await test.admissions.put(BINDING_ID, reservation)
    expect(() => test.operations.validateDurableState(new Set())).toThrow('lacks its Push request')
    expect(test.admissions.get(BINDING_ID)).toEqual(reservation)
  })

  it('rejects recovery of an applied Push whose durable Intent lost its Host preparation', async () => {
    const test = await saved()
    await test.operations.submit(pushIntent(), ACTOR, signal)
    const terminal = branchDeliveryIntentRecordSchema.parse(test.intents.get(PUSH_INTENT_ID))
    const missingPreparation = branchDeliveryIntentRecordSchema.parse({
      ...terminal,
      checkpoint: { state: 'active', deliveryRevision: 1 },
    })
    await test.intents.put(PUSH_INTENT_ID, missingPreparation)
    const restarted = test.createDetachedOperations()
    const validated = restarted.validateDurableState(new Set())

    await expect(restarted.initializeValidated(validated)).rejects.toThrow('lacks Host preparation')

    expect(test.intents.get(PUSH_INTENT_ID)).toEqual(missingPreparation)
    expect(test.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID))?.push).toMatchObject({ intentId: PUSH_INTENT_ID })
    expect(test.execution.starts).toBe(1)
  })
})

describe('Branch Delivery child cancellation prefix', () => {
  it('rejects a successful child replay after an unrecorded conflict released its Delivery owner', async () => {
    const signal = new AbortController().signal
    // Work Item admission may reject a busy item before persisting the child Intent.
    const moveWorkItem = vi.fn<BranchDeliveryOperationsOptions['moveWorkItem']>()
      .mockResolvedValueOnce({ state: 'conflict' })
      .mockResolvedValue({ state: 'succeeded', remoteFingerprint: REVIEW_FINGERPRINT })
    const test = harness({ moveWorkItem })
    await test.operations.submit(saveIntent(), ACTOR, signal)
    await test.operations.submit(pushIntent(), ACTOR, signal)
    await test.operations.submit(createPullRequestIntent(2), ACTOR, signal)
    test.intents.beforeUpdate = (id, _current, next) => {
      if (id !== REVIEW_INTENT_ID || next.checkpoint.state !== 'terminal') return
      test.intents.beforeUpdate = undefined
      throw new SimulatedProcessCrash()
    }

    await expect(test.operations.submit(inReviewIntent(4), ACTOR, signal))
      .rejects.toBeInstanceOf(SimulatedProcessCrash)
    const canceled = branchDeliveryRecordSchema.parse(test.deliveries.get(branchDeliveryId(PROJECT_ID, WORK_ITEM_ID)))
    expect(canceled).toMatchObject({ phase: 'draft', lastIntentId: REVIEW_INTENT_ID })
    expect(canceled.activeIntentId).toBeUndefined()
    expect(test.intents.get(REVIEW_INTENT_ID)?.checkpoint).toMatchObject({ state: 'child-pending' })
    const restarted = test.createDetachedOperations()
    const validated = restarted.validateDurableState(new Set())

    await expect(restarted.initializeValidated(validated))
      .rejects.toThrow('In-review child transition lost its prepared evidence')

    expect(moveWorkItem).toHaveBeenCalledTimes(2)
    expect(test.deliveries.get(canceled.id)).toEqual(canceled)
    expect(test.intents.get(REVIEW_INTENT_ID)?.checkpoint).toMatchObject({ state: 'child-pending' })
  })
})
