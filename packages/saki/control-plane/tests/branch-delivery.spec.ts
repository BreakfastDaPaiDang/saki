import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { cloneLosslessJsonValue } from '@deepseek-ai/dsh-storage'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  canonicalDigest,
  computeProjectInspectionFingerprint,
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
  type GitHubReadMap,
  type GitHubScanMap,
  type GitHubInstallationProfile,
} from '@breakfastdapaidang/saki-github'
import { controlIntentActorSchema, type BindingWriteAdmissionRecord } from '../src/spec.ts'
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

function harness(): Harness {
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
    return { ok: true as const, snapshot: structuredClone(this.snapshot) }
  }

  async cancelOperation(_operation: unknown, reason: HostOperationCancellationReason) {
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
        ) as GitHubReadMap[K]['result']
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
    return {
      snapshot: {
        repositoryId: request.repositoryId,
        repositoryDatabaseId: request.repositoryDatabaseId,
        outcome: this.pullRequestCreated
          ? {
            state: 'unique-pull-request',
            pullRequest: this.pullRequestFact(
              request.headRef,
              request.baseRef,
              request.expectedHeadCommitId,
              this.pullRequestInspectionObservedAt,
            ),
          }
          : { state: 'absent-complete' },
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
    base: { repositoryId: REPOSITORY_ID, ref: baseRef, commitId: '4'.repeat(40) },
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
