/** Recoverable branch delivery from one exact local Commit to human acceptance. */

import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  activeHostProjectBindingSchema,
  canonicalDigest,
  hostOperationPreparationSchema,
  hostOperationSnapshotSchema,
  isSafeGitRef,
  MAX_GIT_REF_CHARS,
  pushBranchHostOperationRequestSchema,
  pushBranchHostOperationResultSchema,
  type ActiveHostProjectBinding,
  type HostOperationAdmissionDecision,
  type HostOperationAdmissionExpectation,
  type HostOperationChange,
  type HostOperationPreparation,
  type HostOperationSnapshot,
  type PushBranchHostOperationRequest,
  type PushBranchHostOperationResult,
  type SakiControlIntentId,
  type SakiHostExecution,
  type SakiResourceBindingId,
} from '@breakfastdapaidang/saki-execution'
import {
  GitHubProviderError,
  githubBranchHeadFactSchema,
  githubCommitCiFactSchema,
  githubCommitIdSchema,
  githubExternalOperationId,
  githubFailureSchema,
  githubInstallationProfileSchema,
  githubIssueIdSchema,
  githubPullRequestCreateMarkerIdSchema,
  githubPullRequestCreateRequestSchema,
  githubPullRequestCreateTextPreparationSchema,
  githubPullRequestFactSchema,
  githubPullRequestIdSchema,
  githubPullRequestReviewsFactSchema,
  githubRepositoryDatabaseIdSchema,
  githubRepositoryIdSchema,
  type GitHubBranchHeadFact,
  type GitHubCommitCiFact,
  type GitHubCommitId,
  type GitHubFailure,
  type GitHubPullRequestCreateInspection,
  type GitHubPullRequestCreateMarkerId,
  type GitHubPullRequestCreateRequest,
  type GitHubPullRequestFact,
  type GitHubPullRequestReviewsFact,
  type SakiGitHub,
} from '@breakfastdapaidang/saki-github'
import { enqueueKeyedOperation } from './keyed-operation.ts'
import {
  projectGitHubFailure,
  type SakiGitHubFailureProjection,
} from './github-failure-projection.ts'
import {
  bindingWriteAdmissionRecordSchema,
  controlIntentActorSchema,
  type BindingWriteAdmissionRecord,
  type ControlIntentActor,
} from './spec.ts'
import {
  sakiBoardRemoteFingerprintSchema,
  sakiBoardWorkItemIdSchema,
  sakiControlIntentIdSchema,
  sakiDevelopmentProjectIdSchema,
  sakiResourceBindingIdSchema,
} from './ids.ts'
import type {
  SakiBoardRemoteFingerprint,
  SakiBoardWorkItemId,
  SakiDevelopmentProjectId,
} from './types.ts'
import { summarizeCommitCi, type SakiCommitCiSummary } from './delivery-evidence.ts'

const revision = z.number().int().nonnegative()
const timestamp = z.number().int().nonnegative()
const digest = z.string().regex(/^[0-9a-f]{64}$/u)

/** Stable identity of the one current delivery for a Project and Work Item pair. */
export type SakiBranchDeliveryId = Branded<'SakiBranchDeliveryId'>

const branchDeliveryIdSchema = z.string()
  .regex(/^branch-delivery-[0-9a-f]{64}$/u)
  .transform(value => value as SakiBranchDeliveryId)

const canonicalBranchRefSchema = z.string()
  .min('refs/heads/a'.length)
  .max(MAX_GIT_REF_CHARS)
  .refine(value => value.startsWith('refs/heads/') && isSafeGitRef(value))

const deliveryExpectationSchema = z.object({
  deliveryRevision: revision.nullable(),
  registryRevision: revision,
  projectRevision: revision,
  binding: z.object({ id: sakiResourceBindingIdSchema, revision }).strict(),
  synchronizationRevision: revision,
  mappingRevision: revision,
  workItemRemoteFingerprint: sakiBoardRemoteFingerprintSchema,
}).strict()

/** Revisions and identities that fence one branch-delivery selection. */
export type BranchDeliveryExpectation = z.infer<typeof deliveryExpectationSchema>

const saveIntentSchema = z.object({
  type: z.literal('save-branch-delivery'),
  intentId: sakiControlIntentIdSchema,
  projectId: sakiDevelopmentProjectIdSchema,
  workItemId: sakiBoardWorkItemIdSchema,
  expected: deliveryExpectationSchema,
  commitId: githubCommitIdSchema,
  headRef: canonicalBranchRefSchema,
  baseRef: canonicalBranchRefSchema,
}).strict().superRefine((intent, context) => {
  if (intent.headRef === intent.baseRef) {
    context.addIssue({ code: 'custom', message: 'Branch Delivery head and base refs must differ' })
  }
})

const deliveryIntentReferenceShape = {
  intentId: sakiControlIntentIdSchema,
  deliveryId: branchDeliveryIdSchema,
  expectedDeliveryRevision: revision,
} as const

const pushIntentSchema = z.object({
  type: z.literal('push-branch-delivery'),
  ...deliveryIntentReferenceShape,
}).strict()

const createPullRequestIntentSchema = z.object({
  type: z.literal('create-branch-delivery-pull-request'),
  ...deliveryIntentReferenceShape,
  title: z.string(),
  body: z.string().max(65_536),
}).strict().superRefine((intent, context) => {
  // Durable validation derives the aggregate marker; wire validation checks incoming text independently.
  /* jscpd:ignore-start */
  const prepared = githubPullRequestCreateTextPreparationSchema.safeParse({
    markerId: pullRequestMarkerId(intent.deliveryId),
    title: intent.title,
    body: intent.body,
  })
  if (!prepared.success) {
    for (const textIssue of prepared.error.issues) {
      context.addIssue({
        code: 'custom',
        message: textIssue.message,
        path: textIssue.path.length === 0 ? ['body'] : textIssue.path,
      })
    }
  }
  /* jscpd:ignore-end */
})

const associatePullRequestIntentSchema = z.object({
  type: z.literal('associate-branch-delivery-pull-request'),
  ...deliveryIntentReferenceShape,
  pullRequestId: githubPullRequestIdSchema,
  pullRequestNumber: z.number().int().positive(),
}).strict()

const workItemTransitionExpectationShape = {
  ...deliveryIntentReferenceShape,
  expectedWorkItemRemoteFingerprint: sakiBoardRemoteFingerprintSchema,
} as const

const inReviewIntentSchema = z.object({
  type: z.literal('mark-branch-delivery-in-review'),
  ...workItemTransitionExpectationShape,
}).strict()

const acceptIntentSchema = z.object({
  type: z.literal('accept-branch-delivery'),
  ...workItemTransitionExpectationShape,
}).strict()

/** Strict branch-delivery Intent schema used before durable admission. */
export const branchDeliveryIntentSchema = z.discriminatedUnion('type', [
  saveIntentSchema,
  pushIntentSchema,
  createPullRequestIntentSchema,
  associatePullRequestIntentSchema,
  inReviewIntentSchema,
  acceptIntentSchema,
])

/** Select or revise the exact Commit and canonical refs of one unaccepted delivery. */
export type BranchDeliverySaveIntent = z.infer<typeof saveIntentSchema>
/** Submit the selected exact Commit through the Binding-owned Host Push operation. */
export type BranchDeliveryPushIntent = z.infer<typeof pushIntentSchema>
/** Create a marker-bound Pull Request for the exact delivery. */
export type BranchDeliveryCreatePullRequestIntent = z.infer<typeof createPullRequestIntentSchema>
/** Associate one completely and uniquely observed existing Pull Request. */
export type BranchDeliveryAssociatePullRequestIntent = z.infer<typeof associatePullRequestIntentSchema>
/** Confirm Push and Pull Request evidence before moving the Work Item to In review. */
export type BranchDeliveryInReviewIntent = z.infer<typeof inReviewIntentSchema>
/** Seal current exact evidence through an attributed human acceptance. */
export type BranchDeliveryAcceptIntent = z.infer<typeof acceptIntentSchema>
/** Closed set of concrete B10 branch-delivery Control Intents. */
export type BranchDeliveryIntent = z.infer<typeof branchDeliveryIntentSchema>

const sourceObservationStateSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unobserved') }).strict(),
  z.object({ state: z.literal('confirmed'), observedAt: timestamp }).strict(),
  z.object({ state: z.literal('failure'), failedAt: timestamp, failure: githubFailureSchema }).strict(),
  z.object({
    state: z.literal('invalidated'),
    invalidatedAt: timestamp,
    reason: z.enum(['target-absent', 'target-changed']),
  }).strict(),
])

function sourceObservationSchema<F extends z.ZodType>(fact: F) {
  return z.object({
    confirmed: z.object({ fact, confirmedAt: timestamp }).strict().optional(),
    current: sourceObservationStateSchema,
  }).strict().superRefine((observation, context) => {
    const confirmed = observation.confirmed as { readonly fact: unknown; readonly confirmedAt: number } | undefined
    if (confirmed !== undefined && confirmed.confirmedAt < observationTime(confirmed.fact)) {
      context.addIssue({ code: 'custom', message: 'source confirmation predates its observation' })
    }
    if (observation.current.state === 'confirmed'
      && (confirmed === undefined || observationTime(confirmed.fact) !== observation.current.observedAt)) {
      context.addIssue({ code: 'custom', message: 'current source confirmation lacks the same exact fact' })
    }
  })
}

/** One targeted source with last-confirmed evidence separate from current health. */
export interface BranchDeliverySourceObservation<T> {
  readonly confirmed?: { readonly fact: T; readonly confirmedAt: number } | undefined
  readonly current:
    | { readonly state: 'unobserved' }
    | { readonly state: 'confirmed'; readonly observedAt: number }
    | { readonly state: 'failure'; readonly failedAt: number; readonly failure: GitHubFailure }
    | {
      readonly state: 'invalidated'
      readonly invalidatedAt: number
      readonly reason: 'target-absent' | 'target-changed'
    }
}

/** Current source health, with staleness derived without rewriting confirmed evidence. */
export type BranchDeliverySourceProjection<T> = {
  readonly confirmed?: { readonly fact: T; readonly confirmedAt: number } | undefined
  readonly current:
    | { readonly state: 'unobserved' }
    | { readonly state: 'confirmed'; readonly observedAt: number }
    | { readonly state: 'failure'; readonly failedAt: number; readonly failure: SakiGitHubFailureProjection }
    | {
      readonly state: 'invalidated'
      readonly invalidatedAt: number
      readonly reason: 'target-absent' | 'target-changed'
    }
    | { readonly state: 'stale'; readonly observedAt: number; readonly staleAt: number }
}

/** Browser-safe Branch Delivery summary without credentials or Host-local paths. */
export interface BranchDeliveryBrowserRecord {
  readonly id: SakiBranchDeliveryId
  readonly schemaVersion: 1
  readonly revision: number
  readonly projectId: SakiDevelopmentProjectId
  readonly workItemId: SakiBoardWorkItemId
  readonly target: {
    readonly registryRevision: number
    readonly projectRevision: number
    readonly binding: {
      readonly id: BranchDeliveryCurrentContext['binding']['id']
      readonly revision: number
      readonly hostId: BranchDeliveryCurrentContext['binding']['hostId']
      readonly health: BranchDeliveryCurrentContext['binding']['health']
    }
    readonly synchronizationRevision: number
    readonly mappingRevision: number
    readonly installation: {
      readonly appId: string
      readonly installationId: string
      readonly accountId: string
    }
    readonly repository: BranchDeliveryCurrentContext['repository']
    readonly workItem: BranchDeliveryCurrentContext['workItem']
  }
  readonly commitId: GitHubCommitId
  readonly headRef: string
  readonly baseRef: string
  readonly phase: BranchDeliveryRecord['phase']
  readonly activeIntentId?: BranchDeliveryRecord['lastIntentId'] | undefined
  readonly push?: {
    readonly intentId: BranchDeliveryRecord['lastIntentId']
    readonly confirmedAt: number
  } | undefined
  readonly acceptance?: {
    readonly intentId: BranchDeliveryRecord['lastIntentId']
    readonly actor: ControlIntentActor
    readonly acceptedAt: number
    readonly evidenceDigest: string
  } | undefined
  readonly repair?: BranchDeliveryRecord['repair'] | undefined
  readonly lastIntentId: BranchDeliveryRecord['lastIntentId']
  readonly createdAt: number
  readonly updatedAt: number
}

/** Read-only browser-safe delivery with independently projected targeted sources. */
export interface BranchDeliveryProjection {
  readonly delivery: BranchDeliveryBrowserRecord
  readonly remoteRef: BranchDeliverySourceProjection<GitHubBranchHeadFact>
  readonly pullRequest: BranchDeliverySourceProjection<GitHubPullRequestFact>
  /** Raw review facts are observable context and never acceptance authority. */
  readonly reviews: BranchDeliverySourceProjection<GitHubPullRequestReviewsFact>
  readonly ci: BranchDeliverySourceProjection<GitHubCommitCiFact> & {
    /** Product state derived only from the retained last-confirmed exact-Commit fact. */
    readonly confirmedSummary?: SakiCommitCiSummary | undefined
  }
}

const branchDeliveryTargetSchema = z.object({
  registryRevision: revision,
  projectRevision: revision,
  binding: activeHostProjectBindingSchema,
  synchronizationRevision: revision,
  mappingRevision: revision,
  installation: githubInstallationProfileSchema,
  repository: z.object({
    id: githubRepositoryIdSchema,
    databaseId: githubRepositoryDatabaseIdSchema,
    nameWithOwner: z.string().min(3).max(201),
  }).strict(),
  workItem: z.object({
    id: sakiBoardWorkItemIdSchema,
    remoteFingerprint: sakiBoardRemoteFingerprintSchema,
    issueId: githubIssueIdSchema,
  }).strict(),
}).strict()

/** Current trusted Project, Binding, GitHub mapping, and Work Item relationship. */
export type BranchDeliveryCurrentContext = z.infer<typeof branchDeliveryTargetSchema>

const acceptanceEvidenceSchema = z.object({
  localCommitObservedAt: timestamp,
  remoteRef: githubBranchHeadFactSchema,
  pullRequest: githubPullRequestFactSchema,
  ci: githubCommitCiFactSchema,
  digest,
}).strict()

const transitionEvidenceSchema = z.object({
  localCommitObservedAt: timestamp,
  remoteRef: githubBranchHeadFactSchema,
  pullRequest: githubPullRequestFactSchema,
  ci: githubCommitCiFactSchema.optional(),
  digest,
}).strict()

const childMoveSchema = z.object({
  intentId: sakiControlIntentIdSchema,
  projectId: sakiDevelopmentProjectIdSchema,
  workItemId: sakiBoardWorkItemIdSchema,
  expectedRemoteFingerprint: sakiBoardRemoteFingerprintSchema,
  targetStatus: z.enum(['in-review', 'done']),
}).strict()

const acceptanceSchema = z.object({
  intentId: sakiControlIntentIdSchema,
  actor: controlIntentActorSchema,
  acceptedAt: timestamp,
  evidence: acceptanceEvidenceSchema,
}).strict()

const branchDeliveryRecordObjectSchema = z.object({
  id: branchDeliveryIdSchema,
  schemaVersion: z.literal(1),
  revision,
  projectId: sakiDevelopmentProjectIdSchema,
  workItemId: sakiBoardWorkItemIdSchema,
  target: branchDeliveryTargetSchema,
  commitId: githubCommitIdSchema,
  headRef: canonicalBranchRefSchema,
  baseRef: canonicalBranchRefSchema,
  markerId: githubPullRequestCreateMarkerIdSchema,
  phase: z.enum(['draft', 'in-review', 'accepted']),
  activeIntentId: sakiControlIntentIdSchema.optional(),
  push: z.object({
    intentId: sakiControlIntentIdSchema,
    result: pushBranchHostOperationResultSchema,
    confirmedAt: timestamp,
  }).strict().optional(),
  remoteRef: sourceObservationSchema(githubBranchHeadFactSchema),
  pullRequest: sourceObservationSchema(githubPullRequestFactSchema),
  reviews: sourceObservationSchema(githubPullRequestReviewsFactSchema),
  ci: sourceObservationSchema(githubCommitCiFactSchema),
  acceptance: acceptanceSchema.optional(),
  repair: z.object({
    intentId: sakiControlIntentIdSchema,
    reason: z.enum(['effect-unknown', 'evidence-conflict', 'marker-ambiguous']),
    recordedAt: timestamp,
  }).strict().optional(),
  lastIntentId: sakiControlIntentIdSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict()

/** Durable current Branch Delivery aggregate. */
export type BranchDeliveryRecord = z.infer<typeof branchDeliveryRecordObjectSchema>

/** Strict schema for one current Branch Delivery aggregate. */
export const branchDeliveryRecordSchema: z.ZodType<BranchDeliveryRecord> = branchDeliveryRecordObjectSchema
  .superRefine((record, context) => {
    if (record.target.workItem.id !== record.workItemId) {
      context.addIssue({ code: 'custom', message: 'Branch Delivery target Work Item disagrees with its identity' })
    }
    if (record.target.binding.id === '' || record.updatedAt < record.createdAt) {
      context.addIssue({ code: 'custom', message: 'Branch Delivery contains invalid relationship evidence' })
    }
    if (record.phase === 'accepted' ? record.acceptance === undefined : record.acceptance !== undefined) {
      context.addIssue({ code: 'custom', message: 'Branch Delivery acceptance disagrees with its phase' })
    }
    if (record.phase === 'accepted' && record.activeIntentId !== undefined) {
      context.addIssue({ code: 'custom', message: 'accepted Branch Delivery retains a mutable Intent owner' })
    }
    if (record.markerId !== pullRequestMarkerId(record.id) || record.headRef === record.baseRef) {
      context.addIssue({ code: 'custom', message: 'Branch Delivery contains inconsistent GitHub identities' })
    }
    if (record.activeIntentId !== undefined && record.repair !== undefined) {
      context.addIssue({ code: 'custom', message: 'Branch Delivery cannot be active and awaiting repair' })
    }
    if (record.push !== undefined && !pushResultMatches(record.push.result, record)) {
      context.addIssue({ code: 'custom', message: 'Branch Delivery Push result targets another Commit or ref' })
    }
    if (record.remoteRef.confirmed !== undefined
      && !remoteRefMatches(record)(record.remoteRef.confirmed.fact)) {
      context.addIssue({ code: 'custom', message: 'Branch Delivery remote-ref confirmation targets another Commit' })
    }
    if (record.pullRequest.confirmed !== undefined
      && !pullRequestMatchesDelivery(record.pullRequest.confirmed.fact, record)) {
      context.addIssue({ code: 'custom', message: 'Branch Delivery Pull Request confirmation targets another delivery' })
    }
    if (record.reviews.confirmed !== undefined
      && !reviewsTargetDelivery(record.reviews.confirmed.fact, record, record.pullRequest.confirmed?.fact)) {
      context.addIssue({ code: 'custom', message: 'Branch Delivery review confirmation targets another delivery' })
    }
    if (record.reviews.current.state === 'confirmed'
      && record.reviews.confirmed !== undefined
      && record.reviews.confirmed.fact.pullRequestUpdatedAt !== record.pullRequest.confirmed?.fact.updatedAt) {
      context.addIssue({ code: 'custom', message: 'Branch Delivery current reviews target another Pull Request revision' })
    }
    if (record.ci.confirmed !== undefined && !ciMatches(record)(record.ci.confirmed.fact)) {
      context.addIssue({ code: 'custom', message: 'Branch Delivery CI confirmation targets another Commit' })
    }
    if (record.phase !== 'draft' && (record.push === undefined || record.pullRequest.confirmed === undefined)) {
      context.addIssue({ code: 'custom', message: 'advanced Branch Delivery lacks confirmed Push and Pull Request evidence' })
    }
    if (record.acceptance !== undefined && !acceptanceMatchesDelivery(record.acceptance.evidence, record)) {
      context.addIssue({ code: 'custom', message: 'Branch Delivery acceptance evidence is inconsistent' })
    }
  })

const terminalReasonSchema = z.enum([
  'expected-revision',
  'expected-evidence',
  'immutable',
  'authority',
  'host-operation',
  'effect-unknown',
  'evidence-conflict',
  'marker-ambiguous',
  'child-transition',
])

type TerminalReason = z.infer<typeof terminalReasonSchema>

const intentOperationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('save') }).strict(),
  z.object({ kind: z.literal('push'), request: pushBranchHostOperationRequestSchema }).strict(),
  z.object({ kind: z.literal('pull-request-create'), request: githubPullRequestCreateRequestSchema }).strict(),
  z.object({ kind: z.literal('pull-request-associate') }).strict(),
  z.object({ kind: z.literal('in-review') }).strict(),
  z.object({ kind: z.literal('accept') }).strict(),
])

const intentCheckpointSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('prepared') }).strict(),
  z.object({ state: z.literal('active'), deliveryRevision: revision }).strict(),
  z.object({
    state: z.literal('push-host-accepted'),
    deliveryRevision: revision,
    preparation: hostOperationPreparationSchema,
    admissionRevision: revision,
  }).strict(),
  z.object({ state: z.literal('pull-request-effect-possible'), deliveryRevision: revision }).strict(),
  z.object({
    state: z.literal('child-pending'),
    deliveryRevision: revision,
    evidence: transitionEvidenceSchema,
    move: childMoveSchema,
  }).strict(),
  z.object({
    state: z.literal('terminal'),
    outcome: z.enum(['succeeded', 'conflict', 'denied', 'failure', 'reconciliation-required']),
    deliveryRevision: revision.optional(),
    reason: terminalReasonSchema.optional(),
    host: z.object({
      preparation: hostOperationPreparationSchema,
      snapshot: hostOperationSnapshotSchema,
    }).strict().optional(),
  }).strict(),
])

type BranchDeliveryIntentOperation = z.infer<typeof intentOperationSchema>
type BranchDeliveryIntentCheckpoint = z.infer<typeof intentCheckpointSchema>
type BranchDeliveryTerminalCheckpoint = Extract<BranchDeliveryIntentCheckpoint, { state: 'terminal' }>
type BranchDeliveryChildCheckpoint = Extract<BranchDeliveryIntentCheckpoint, { state: 'child-pending' }>

const intentRecordSchema = z.object({
  id: sakiControlIntentIdSchema,
  schemaVersion: z.literal(1),
  revision,
  payloadDigest: digest,
  payload: z.object({ intent: branchDeliveryIntentSchema, actor: controlIntentActorSchema }).strict(),
  deliveryId: branchDeliveryIdSchema,
  operation: intentOperationSchema,
  checkpoint: intentCheckpointSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict()

/** Durable branch-delivery Control Intent record. */
export type BranchDeliveryIntentRecord = z.infer<typeof intentRecordSchema>

/** Strict schema for the common Branch Delivery Intent lifecycle. */
export const branchDeliveryIntentRecordSchema: z.ZodType<BranchDeliveryIntentRecord> = intentRecordSchema
  .superRefine((record, context) => {
    if (record.payloadDigest !== canonicalDigest('saki/branch-delivery-intent/v1', record.payload)) {
      context.addIssue({ code: 'custom', message: 'Branch Delivery Intent payload digest is stale' })
    }
    if (record.id !== record.payload.intent.intentId) {
      context.addIssue({ code: 'custom', message: 'Branch Delivery Intent id disagrees with its payload' })
    }
    if (record.payload.intent.type !== 'save-branch-delivery'
      && record.deliveryId !== record.payload.intent.deliveryId) {
      context.addIssue({ code: 'custom', message: 'Branch Delivery Intent aggregate id disagrees with its payload' })
    }
    if (record.updatedAt < record.createdAt) {
      context.addIssue({ code: 'custom', message: 'Branch Delivery Intent timestamps are not monotonic' })
    }
    if (record.operation.kind !== operationKind(record.payload.intent.type)) {
      context.addIssue({ code: 'custom', message: 'Branch Delivery operation disagrees with its Intent kind' })
    }
    if (record.operation.kind === 'push') {
      const source = record.operation.request.source
      if (source.intentId !== record.id
        || source.intentRevision !== 0 || source.payloadDigest !== record.payloadDigest) {
        context.addIssue({ code: 'custom', message: 'Branch Delivery Push source is not its admitting Intent' })
      }
    }
    if (record.operation.kind === 'pull-request-create'
      && (record.operation.request.operationId !== githubExternalOperationId(
        `branch-delivery:${record.id}:pull-request`,
      ) || record.operation.request.markerId !== pullRequestMarkerId(record.deliveryId))) {
      context.addIssue({ code: 'custom', message: 'Branch Delivery Pull Request request lacks stable recovery identity' })
    }
    const checkpoint = record.checkpoint
    if (checkpoint.state === 'terminal') {
      if ((checkpoint.outcome === 'succeeded') !== (checkpoint.reason === undefined)
        || (checkpoint.outcome === 'succeeded' && checkpoint.deliveryRevision === undefined)) {
        context.addIssue({ code: 'custom', message: 'Branch Delivery terminal checkpoint lacks its result evidence' })
      }
      if (checkpoint.host !== undefined && record.operation.kind !== 'push') {
        context.addIssue({ code: 'custom', message: 'Only a Push Intent may retain a terminal Host snapshot' })
      }
      if (checkpoint.host !== undefined && !hostEvidenceMatches(record, checkpoint.host)) {
        context.addIssue({ code: 'custom', message: 'Branch Delivery terminal Host evidence changed identity' })
      }
    } else if (checkpoint.state !== 'prepared'
      && !checkpointAllowed(record.operation.kind, checkpoint.state)) {
      context.addIssue({ code: 'custom', message: 'Branch Delivery checkpoint disagrees with its operation' })
    }
    if (checkpoint.state === 'child-pending') {
      if (!childCheckpointMatchesIntent(record, checkpoint)) {
        context.addIssue({ code: 'custom', message: 'Branch Delivery child checkpoint is not replayable' })
      }
      if (!transitionEvidenceDigestMatches(checkpoint.evidence)) {
        context.addIssue({ code: 'custom', message: 'Branch Delivery transition evidence digest is inconsistent' })
      }
    }
  })

type PushWriteAdmissionRecord = Extract<
  BindingWriteAdmissionRecord,
  { readonly state: 'manual-host-operation'; readonly action: 'project-branch:push' }
>

/** Unified Binding write-admission table shared with structured Git and Agent Runs. */
export type BranchDeliveryWriteAdmissionTable = KvTable<
  SakiResourceBindingId,
  BindingWriteAdmissionRecord
>

/** Durable current Branch Delivery table. */
export type BranchDeliveryTable = KvTable<SakiBranchDeliveryId, BranchDeliveryRecord>
/** Durable branch-delivery Control Intent table. */
export type BranchDeliveryIntentTable = KvTable<SakiControlIntentId, BranchDeliveryIntentRecord>

/** Trusted lookup result for current Project, mapping, and Work Item evidence. */
export type BranchDeliveryContextResult =
  | { readonly ok: true; readonly context: BranchDeliveryCurrentContext }
  | { readonly ok: false; readonly reason: 'not-found' | 'unavailable' }

/** Stable child transition issued through the existing MoveWorkItem owner. */
export interface BranchDeliveryMoveWorkItemRequest {
  readonly intentId: SakiControlIntentId
  readonly projectId: SakiDevelopmentProjectId
  readonly workItemId: SakiBoardWorkItemId
  readonly expectedRemoteFingerprint: SakiBoardRemoteFingerprint
  readonly targetStatus: 'in-review' | 'done'
}

/** Current result of exactly replaying one child MoveWorkItem transition. */
export type BranchDeliveryMoveWorkItemResult =
  | {
    readonly state: 'succeeded'
    readonly remoteFingerprint: SakiBoardRemoteFingerprint
  }
  | { readonly state: 'pending' | 'unavailable' | 'conflict' | 'reconciliation-required' }

/** Fixed authority action names used by branch-delivery admission. */
export type BranchDeliveryAction =
  | 'branch-delivery:save'
  | 'branch-delivery:push'
  | 'branch-delivery:pull-request:create'
  | 'branch-delivery:pull-request:associate'
  | 'branch-delivery:review'
  | 'branch-delivery:accept'

/** Dependencies supplied by existing Saki owners at the Branch Delivery seam. */
export interface BranchDeliveryOperationsOptions {
  readonly deliveryTable: BranchDeliveryTable
  readonly intentTable: BranchDeliveryIntentTable
  readonly admissionTable: BranchDeliveryWriteAdmissionTable
  readonly execution: SakiHostExecution
  readonly projectExists: (projectId: SakiDevelopmentProjectId) => boolean
  readonly resolveContext: (
    projectId: SakiDevelopmentProjectId,
    workItemId: SakiBoardWorkItemId,
  ) => BranchDeliveryContextResult
  readonly currentLocalHead: (
    binding: ActiveHostProjectBinding,
    signal: AbortSignal,
  ) => Promise<{ readonly ok: true; readonly commitId: GitHubCommitId; readonly observedAt?: number }
    | { readonly ok: false; readonly reason: 'unavailable' | 'conflict' }>
  readonly authorityCurrent: (actor: ControlIntentActor, action: BranchDeliveryAction) => boolean
  readonly validateActorReference: (actor: ControlIntentActor) => void
  readonly moveWorkItem: (
    request: BranchDeliveryMoveWorkItemRequest,
    actor: ControlIntentActor,
    signal: AbortSignal,
  ) => Promise<BranchDeliveryMoveWorkItemResult>
  readonly observationFreshForMs: number
  readonly notifyChanged: () => void
  readonly reportUnexpectedFailure: (error: unknown) => void
  readonly lifetime: AbortSignal
}

type DeliveryRead<T> =
  | { readonly ok: true; readonly fact: T }
  | { readonly ok: false; readonly failure: GitHubFailure }

interface DeliveryEvidenceReads {
  readonly remoteRef: DeliveryRead<GitHubBranchHeadFact>
  readonly pullRequest: DeliveryRead<GitHubPullRequestFact> | undefined
  readonly reviews: DeliveryRead<GitHubPullRequestReviewsFact> | undefined
  readonly ci: DeliveryRead<GitHubCommitCiFact> | undefined
}

/** Fully parsed Branch Delivery state in deterministic restart order. */
export interface ValidatedBranchDeliveryState {
  readonly deliveries: readonly BranchDeliveryRecord[]
  readonly intents: readonly BranchDeliveryIntentRecord[]
}

type ReadonlyTable<K extends string, V> = Pick<KvTable<K, V>, 'entries' | 'get' | 'size'>

/** Stable browser-safe result for one branch-delivery Intent attempt. */
export type BranchDeliveryIntentResult =
  | {
    readonly ok: true
    readonly receipt: {
      readonly intentId: SakiControlIntentId
      readonly deliveryId: SakiBranchDeliveryId
      readonly state: 'pending' | 'succeeded'
      readonly deliveryRevision?: number | undefined
    }
  }
  | {
    readonly ok: false
    readonly reason: 'denied' | 'conflict' | 'unavailable' | 'reconciliation-required'
    readonly receipt?: {
      readonly intentId: SakiControlIntentId
      readonly deliveryId: SakiBranchDeliveryId
      readonly state: 'conflict' | 'denied' | 'failure' | 'reconciliation-required'
      readonly deliveryRevision?: number | undefined
    }
  }

/** Result of one targeted evidence refresh that never advances the Board checkpoint. */
export type BranchDeliveryRefreshResult =
  | { readonly ok: true; readonly record: BranchDeliveryRecord }
  | { readonly ok: false; readonly reason: 'not-found' | 'unavailable' | 'immutable' }

/**
 * Derive the only current Branch Delivery identity for one Project and Work Item.
 * @param projectId - owning Development Project identity.
 * @param workItemId - Project-scoped Work Item identity.
 * @returns stable identity derived from the Project and Work Item pair.
 */
export function branchDeliveryId(
  projectId: SakiDevelopmentProjectId,
  workItemId: SakiBoardWorkItemId,
): SakiBranchDeliveryId {
  return branchDeliveryIdSchema.parse(`branch-delivery-${canonicalDigest('saki/branch-delivery/id/v1', {
    projectId,
    workItemId,
  })}`)
}

/**
 * Validate the complete Branch Delivery aggregate, Intent, and Push-admission relation.
 * @param deliveryTable - opened Branch Delivery aggregate table.
 * @param intentTable - opened Branch Delivery Intent table.
 * @param admissionTable - opened unified Binding write-admission table.
 * @param projectExists - current Development Project membership lookup.
 * @param otherIntentIds - ids already retained by earlier Control Intent families.
 * @param validateActorReference - Foundation relationship validator for immutable attribution.
 * @returns detached aggregates and Intents in deterministic restart order.
 */
export function validateBranchDeliveryOperationsDurableState(
  deliveryTable: ReadonlyTable<SakiBranchDeliveryId, BranchDeliveryRecord>,
  intentTable: ReadonlyTable<SakiControlIntentId, BranchDeliveryIntentRecord>,
  admissionTable: ReadonlyTable<SakiResourceBindingId, BindingWriteAdmissionRecord>,
  projectExists: (projectId: SakiDevelopmentProjectId) => boolean,
  otherIntentIds: ReadonlySet<SakiControlIntentId>,
  validateActorReference: (actor: ControlIntentActor) => void,
): ValidatedBranchDeliveryState {
  const deliveries = [...deliveryTable.entries()].map(([key, value]) => {
    const record = branchDeliveryRecordSchema.parse(value)
    if (record.id !== key) throw new Error('Branch Delivery id disagrees with its table key')
    if (record.id !== branchDeliveryId(record.projectId, record.workItemId)) {
      throw new Error('Branch Delivery id disagrees with its Project and Work Item')
    }
    if (!projectExists(record.projectId)) {
      throw new Error('Branch Delivery targets a missing Development Project')
    }
    return record
  })
  const deliveryById = new Map(deliveries.map(record => [record.id, record] as const))
  const intents = [...intentTable.entries()].map(([key, value]) => {
    const record = branchDeliveryIntentRecordSchema.parse(value)
    if (record.id !== key) throw new Error('Branch Delivery Intent id disagrees with its table key')
    if (otherIntentIds.has(key)) throw new Error(`Saki Control Intent '${key}' is retained by multiple Intent kinds`)
    validateActorReference(record.payload.actor)
    const delivery = deliveryById.get(record.deliveryId)
    if (record.payload.intent.type === 'save-branch-delivery') {
      if (!projectExists(record.payload.intent.projectId)) {
        throw new Error('Branch Delivery save Intent targets a missing Development Project')
      }
      if (record.deliveryId !== branchDeliveryId(
        record.payload.intent.projectId,
        record.payload.intent.workItemId,
      )) throw new Error('Branch Delivery save Intent targets another aggregate')
    } else if (delivery === undefined) {
      const checkpoint = record.checkpoint
      if (checkpoint.state !== 'terminal'
        || (checkpoint.outcome !== 'conflict' && checkpoint.outcome !== 'denied')) {
        throw new Error('Branch Delivery Intent targets a missing aggregate')
      }
    }
    return record
  })
  const intentById = new Map(intents.map(record => [record.id, record] as const))
  for (const delivery of deliveries) {
    const last = intentById.get(delivery.lastIntentId)
    if (last === undefined || last.deliveryId !== delivery.id || !intentMatchesDelivery(last, delivery)) {
      throw new Error('Branch Delivery last Intent reference is inconsistent')
    }
    if (delivery.activeIntentId !== undefined && delivery.activeIntentId !== last.id && !terminalIntent(last)) {
      throw new Error('Branch Delivery has two recoverable Intent owners')
    }
    if (delivery.activeIntentId === undefined) continue
    const owner = intentById.get(delivery.activeIntentId)
    if (owner === undefined || owner.deliveryId !== delivery.id || terminalIntent(owner)) {
      throw new Error('Branch Delivery active Intent owner is inconsistent')
    }
    const ownerIntent = owner.payload.intent
    if (ownerIntent.type === 'save-branch-delivery'
      || delivery.revision !== ownerIntent.expectedDeliveryRevision + 1
      || (owner.checkpoint.state !== 'prepared' && owner.checkpoint.state !== 'terminal'
        && owner.checkpoint.deliveryRevision !== delivery.revision)) {
      throw new Error('Branch Delivery active Intent revision fence is inconsistent')
    }
  }
  for (const intent of intents) {
    if (terminalIntent(intent) || intent.payload.intent.type === 'save-branch-delivery'
      || intent.checkpoint.state === 'prepared') continue
    const delivery = deliveryById.get(intent.deliveryId)
    if (delivery?.activeIntentId !== intent.id && delivery?.lastIntentId !== intent.id) {
      throw new Error('recoverable Branch Delivery Intent has no matching aggregate owner')
    }
    if (!intentMatchesDelivery(intent, delivery)) {
      throw new Error('recoverable Branch Delivery Intent changed its exact target')
    }
  }
  for (const delivery of deliveries) {
    const pushIntent = delivery.push === undefined ? undefined : intentById.get(delivery.push.intentId)
    if (delivery.push !== undefined && (pushIntent?.operation.kind !== 'push'
      || !intentMatchesDelivery(pushIntent, delivery))) {
      throw new Error('Branch Delivery Push Intent reference is inconsistent')
    }
    const acceptanceIntent = delivery.acceptance === undefined
      ? undefined
      : intentById.get(delivery.acceptance.intentId)
    if (delivery.acceptance !== undefined && (acceptanceIntent?.operation.kind !== 'accept'
      || !intentMatchesDelivery(acceptanceIntent, delivery)
      || !acceptanceCheckpointValid(acceptanceIntent))) {
      throw new Error('Branch Delivery acceptance Intent reference is inconsistent')
    }
    if (delivery.repair !== undefined) {
      const repairIntent = intentById.get(delivery.repair.intentId)
      if (repairIntent === undefined || !repairCheckpointValid(repairIntent, delivery)) {
        throw new Error('Branch Delivery repair Intent reference is inconsistent')
      }
    }
  }
  for (const [, value] of admissionTable.entries()) {
    const admission = bindingWriteAdmissionRecordSchema.parse(value)
    if (!isPushAdmission(admission)) continue
    const intent = intentById.get(admission.source.intentId)
    if (intent === undefined || !pushAdmissionMatches(admission, intent, requirePushRequest(intent))
      || !admissionMatchesCheckpoint(admission, intent)) {
      throw new Error('Branch Delivery Push admission has no matching recovery checkpoint')
    }
  }
  return {
    deliveries: deliveries.toSorted(compareDeliveryOrder),
    intents: intents.toSorted(compareIntentOrder),
  }
}

/** Owns exact-revision Branch Delivery selection and its recoverable external effects. */
export class BranchDeliveryOperations {
  private readonly intentTails = new Map<SakiControlIntentId, Promise<void>>()
  private readonly deliveryTails = new Map<SakiBranchDeliveryId, Promise<void>>()
  private readonly active = new Set<Promise<void>>()
  private github: {
    readonly provider: SakiGitHub
    readonly lifetime: AbortController
  } | undefined

  /** @param options - existing durable tables, authorities, and external capability owners. */
  constructor(private readonly options: BranchDeliveryOperationsOptions) {}

  /**
   * Attach the current Product App provider and return a disposer that aborts and drains its work.
   * @param provider - Product App provider for targeted reads and mutations.
   * @returns asynchronous disposer for this provider attachment.
   */
  attach(provider: SakiGitHub): () => Promise<void> {
    if (this.github !== undefined) throw new Error('Saki Branch Delivery GitHub provider is already attached')
    const lifetime = new AbortController()
    const attachment = { provider, lifetime }
    this.github = attachment
    this.options.notifyChanged()
    const recoverySignal = AbortSignal.any([lifetime.signal, this.options.lifetime])
    const recovery = this.track(this.recoverProviderPending(recoverySignal).catch((error: unknown) => {
      if (!recoverySignal.aborted) throw error
    }))
    return async () => {
      if (this.github === attachment) {
        this.github = undefined
        lifetime.abort(new Error('Saki Branch Delivery GitHub provider is detaching'))
        this.options.notifyChanged()
      }
      await recovery
    }
  }

  /**
   * Project source freshness while retaining each last-confirmed fact.
   * @param deliveryId - Branch Delivery aggregate to project.
   * @param now - current epoch time used to derive freshness.
   * @returns browser-safe projection, or undefined when the aggregate is absent.
   */
  project(deliveryId: SakiBranchDeliveryId, now: number): BranchDeliveryProjection | undefined {
    const value = this.options.deliveryTable.get(deliveryId)
    if (value === undefined) return undefined
    const record = branchDeliveryRecordSchema.parse(value)
    return {
      delivery: projectBrowserDelivery(record),
      remoteRef: projectObservation(record.remoteRef, now, this.options.observationFreshForMs),
      pullRequest: projectObservation(record.pullRequest, now, this.options.observationFreshForMs),
      reviews: projectObservation(record.reviews, now, this.options.observationFreshForMs),
      ci: {
        ...projectObservation(record.ci, now, this.options.observationFreshForMs),
        ...(record.ci.confirmed === undefined
          ? {}
          : { confirmedSummary: summarizeCommitCi(record.ci.confirmed.fact) }),
      },
    }
  }

  /**
   * Refresh exact ref, known Pull Request, and exact-Commit CI facts independently.
   * @param deliveryId - mutable Branch Delivery aggregate to refresh.
   * @param signal - caller lifetime for the targeted reads and durable update.
   * @returns retained aggregate or a closed refresh failure.
   */
  async refresh(
    deliveryId: SakiBranchDeliveryId,
    signal: AbortSignal,
  ): Promise<BranchDeliveryRefreshResult> {
    return await enqueueKeyedOperation(this.deliveryTails, deliveryId, async () => {
      const value = this.options.deliveryTable.get(deliveryId)
      if (value === undefined) return { ok: false, reason: 'not-found' }
      const delivery = branchDeliveryRecordSchema.parse(value)
      if (delivery.phase === 'accepted') return { ok: false, reason: 'immutable' }
      if (delivery.activeIntentId !== undefined || this.lastIntentPending(delivery)) {
        return { ok: false, reason: 'unavailable' }
      }
      const attachment = this.github
      if (attachment === undefined) return { ok: false, reason: 'unavailable' }
      const providerSignal = AbortSignal.any([signal, attachment.lifetime.signal])
      const evidence = await this.readEvidence(delivery, attachment.provider, providerSignal, true)
      providerSignal.throwIfAborted()
      const saved = await this.updateDelivery(delivery, evidenceUpdates(delivery, evidence, true))
      this.options.notifyChanged()
      return { ok: true, record: saved }
    })
  }

  /** Wait for notification-driven recovery already contained by this module. */
  async dispose(): Promise<void> {
    await Promise.all([...this.active, ...this.intentTails.values(), ...this.deliveryTails.values()])
  }

  /**
   * Validate every owned record and recovery relationship without external effects.
   * @param otherIntentIds - Control Intent ids retained by other operation families.
   * @returns detached validated records in deterministic restart order.
   */
  validateDurableState(otherIntentIds: ReadonlySet<SakiControlIntentId>): ValidatedBranchDeliveryState {
    return validateBranchDeliveryOperationsDurableState(
      this.options.deliveryTable,
      this.options.intentTable,
      this.options.admissionTable,
      this.options.projectExists,
      otherIntentIds,
      this.options.validateActorReference,
    )
  }

  /**
   * Resume every validated nonterminal Intent once after startup.
   * @param state - validated records in deterministic restart order.
   */
  async initializeValidated(state: ValidatedBranchDeliveryState): Promise<void> {
    for (const intent of state.intents) {
      if (intent.checkpoint.state === 'terminal' && intent.checkpoint.host === undefined) continue
      this.options.lifetime.throwIfAborted()
      await enqueueKeyedOperation(this.intentTails, intent.id, () => (
        enqueueKeyedOperation(this.deliveryTails, intent.deliveryId, () => this.resume(intent.id, this.options.lifetime))
      ))
    }
  }

  /**
   * Submit or exactly replay one attributed Branch Delivery Intent.
   * @param intent - validated-on-entry delivery request and replay identity.
   * @param actor - immutable attribution whose current authority is revalidated.
   * @param signal - caller lifetime for submission and any resumed work.
   * @returns stable receipt or a closed denial, conflict, availability, or reconciliation result.
   */
  async submit(
    intent: BranchDeliveryIntent,
    actor: ControlIntentActor,
    signal: AbortSignal,
  ): Promise<BranchDeliveryIntentResult> {
    const parsed = branchDeliveryIntentSchema.parse(intent)
    this.options.validateActorReference(actor)
    return await enqueueKeyedOperation(this.intentTails, parsed.intentId, async () => {
      signal.throwIfAborted()
      const existing = this.options.intentTable.get(parsed.intentId)
      if (existing !== undefined) {
        const record = branchDeliveryIntentRecordSchema.parse(existing)
        if (!isDeepStrictEqual(record.payload, { intent: parsed, actor })) return { ok: false, reason: 'conflict' }
        return await enqueueKeyedOperation(
          this.deliveryTails,
          record.deliveryId,
          () => this.resume(record.id, signal),
        )
      }
      if (parsed.type === 'save-branch-delivery') {
        return await this.submitSave(parsed, actor, signal)
      }
      return await this.submitExistingDeliveryIntent(parsed, actor, signal)
    })
  }

  private async submitExistingDeliveryIntent(
    intent: Exclude<BranchDeliveryIntent, BranchDeliverySaveIntent>,
    actor: ControlIntentActor,
    signal: AbortSignal,
  ): Promise<BranchDeliveryIntentResult> {
    return await enqueueKeyedOperation(this.deliveryTails, intent.deliveryId, async () => {
      const action = actionFor(intent.type)
      if (!this.options.authorityCurrent(actor, action)) return { ok: false, reason: 'denied' }
      const value = this.options.deliveryTable.get(intent.deliveryId)
      if (value === undefined) return { ok: false, reason: 'unavailable' }
      const delivery = branchDeliveryRecordSchema.parse(value)
      if (this.lastIntentPending(delivery)) return { ok: false, reason: 'unavailable' }
      if (delivery.revision !== intent.expectedDeliveryRevision || delivery.phase === 'accepted'
        || delivery.activeIntentId !== undefined || delivery.repair !== undefined) {
        return { ok: false, reason: 'conflict' }
      }
      const resolved = this.options.resolveContext(delivery.projectId, delivery.workItemId)
      if (!resolved.ok || !contextMatchesDelivery(resolved.context, delivery)) {
        return { ok: false, reason: 'conflict' }
      }
      const payload = { intent, actor }
      const payloadDigest = canonicalDigest('saki/branch-delivery-intent/v1', payload)
      signal.throwIfAborted()
      const now = Date.now()
      const record = branchDeliveryIntentRecordSchema.parse({
        id: intent.intentId,
        schemaVersion: 1,
        revision: 0,
        payloadDigest,
        payload,
        deliveryId: delivery.id,
        operation: intentOperation(intent, delivery, payloadDigest),
        checkpoint: { state: 'prepared' },
        createdAt: now,
        updatedAt: now,
      })
      await this.putIntent(record)
      return await this.resume(record.id, signal)
    })
  }

  private async reservePreparedIntent(
    initial: BranchDeliveryIntentRecord,
    signal: AbortSignal,
  ): Promise<BranchDeliveryIntentRecord> {
    let record = initial
    const intent = record.payload.intent
    if (intent.type === 'save-branch-delivery' || record.checkpoint.state !== 'prepared') {
      throw new Error('Branch Delivery reservation requires a prepared existing-delivery Intent')
    }
    const value = this.options.deliveryTable.get(record.deliveryId)
    if (value === undefined) return await this.finishIntent(record, 'conflict', 'expected-evidence')
    const delivery = branchDeliveryRecordSchema.parse(value)
    if (delivery.activeIntentId === record.id) {
      return await this.updateIntent(record, {
        checkpoint: { state: 'active', deliveryRevision: delivery.revision },
      })
    }
    if (this.lastIntentPending(delivery)) return record
    const action = actionFor(intent.type)
    if (!this.options.authorityCurrent(record.payload.actor, action)) {
      return await this.finishIntent(record, 'denied', 'authority', delivery.revision)
    }
    if (delivery.revision !== intent.expectedDeliveryRevision || delivery.phase === 'accepted'
      || delivery.activeIntentId !== undefined || delivery.repair !== undefined) {
      return await this.finishIntent(
        record,
        'conflict',
        delivery.phase === 'accepted' ? 'immutable' : 'expected-revision',
        delivery.revision,
      )
    }
    const resolved = this.options.resolveContext(delivery.projectId, delivery.workItemId)
    if (!resolved.ok) return record
    if (!contextMatchesDelivery(resolved.context, delivery)) {
      return await this.finishIntent(record, 'conflict', 'expected-evidence', delivery.revision)
    }
    if (intent.type === 'push-branch-delivery') {
      const localHead = await this.options.currentLocalHead(delivery.target.binding, signal)
      signal.throwIfAborted()
      if (!localHead.ok) {
        return localHead.reason === 'unavailable'
          ? record
          : await this.finishIntent(record, 'conflict', 'expected-evidence', delivery.revision)
      }
      if (localHead.commitId !== delivery.commitId) {
        return await this.finishIntent(record, 'conflict', 'expected-evidence', delivery.revision)
      }
    }
    if (!this.options.authorityCurrent(record.payload.actor, action)) {
      return await this.finishIntent(record, 'denied', 'authority', delivery.revision)
    }
    const current = this.options.resolveContext(delivery.projectId, delivery.workItemId)
    if (!current.ok) return record
    if (!contextMatchesDelivery(current.context, delivery)) {
      return await this.finishIntent(record, 'conflict', 'expected-evidence', delivery.revision)
    }
    const reserved = await this.updateDelivery(delivery, { activeIntentId: record.id })
    record = await this.updateIntent(record, {
      checkpoint: { state: 'active', deliveryRevision: reserved.revision },
    })
    this.options.notifyChanged()
    return record
  }

  private async resume(intentId: SakiControlIntentId, signal: AbortSignal): Promise<BranchDeliveryIntentResult> {
    signal.throwIfAborted()
    let record = this.requireIntent(intentId)
    if (terminalIntent(record)) return await this.replayTerminal(record, signal)
    if (record.checkpoint.state === 'prepared') {
      if (record.payload.intent.type === 'save-branch-delivery') return await this.resumeSave(record, signal)
      record = await this.reservePreparedIntent(record, signal)
      if (terminalIntent(record) || record.checkpoint.state === 'prepared') return resultFor(record)
    }
    const delivery = this.requireDelivery(record.deliveryId)
    if (delivery.repair?.intentId === record.id) {
      let snapshot: HostOperationSnapshot<'push-branch'> | undefined
      if (record.checkpoint.state === 'push-host-accepted') {
        snapshot = await this.options.execution.inspectOperation<'push-branch'>(
          requireHostPreparation(record).operation,
          signal,
        )
        assertPushSnapshot(record, snapshot)
        if (snapshot.state !== 'reconciliation-required' || snapshot.reason !== delivery.repair.reason) {
          throw new Error('Branch Delivery repair disagrees with its Host snapshot')
        }
      }
      return await this.finishRepair(record, delivery.repair.reason,
        record.operation.kind === 'in-review' || record.operation.kind === 'accept'
          ? 'child-transition' : delivery.repair.reason,
        delivery.repair.recordedAt, snapshot)
    }
    switch (record.payload.intent.type) {
      case 'push-branch-delivery':
        return await this.resumePush(record, signal)
      case 'create-branch-delivery-pull-request':
        return await this.resumePullRequestCreate(record, signal)
      case 'save-branch-delivery':
        throw new Error('prepared Branch Delivery Save escaped recovery')
      case 'associate-branch-delivery-pull-request':
        return await this.resumePullRequestAssociation(record, signal)
      case 'mark-branch-delivery-in-review':
        return await this.resumeWorkItemTransition(record, signal, 'in-review')
      case 'accept-branch-delivery':
        return await this.resumeWorkItemTransition(record, signal, 'done')
      default:
        return assertNever(record.payload.intent)
    }
  }

  /**
   * Treat Host changes only as durable-inspection wakeups.
   * @param change - changed Host Operation identity used to find matching recovery work.
   */
  hostChanged(change: HostOperationChange): void {
    const intent = [...this.options.intentTable.entries()]
      .map(([, value]) => branchDeliveryIntentRecordSchema.parse(value))
      .find(candidate => hostPreparation(candidate)?.operation.id === change.operation.id)
    if (intent === undefined || terminalIntent(intent)) return
    void this.track(enqueueKeyedOperation(this.intentTails, intent.id, () => enqueueKeyedOperation(
      this.deliveryTails,
      intent.deliveryId,
      () => this.resume(intent.id, this.options.lifetime),
    )))
  }

  private async recoverProviderPending(signal: AbortSignal): Promise<void> {
    const pending = [...this.options.intentTable.entries()]
      .map(([, value]) => branchDeliveryIntentRecordSchema.parse(value))
      .filter(record => !terminalIntent(record)
        && record.operation.kind !== 'save' && record.operation.kind !== 'push')
      .toSorted(compareIntentOrder)
    let failed = false
    let firstFailure: unknown
    for (const record of pending) {
      signal.throwIfAborted()
      try {
        await enqueueKeyedOperation(this.intentTails, record.id, () => enqueueKeyedOperation(
          this.deliveryTails,
          record.deliveryId,
          () => this.resume(record.id, signal),
        ))
      } catch (error) {
        signal.throwIfAborted()
        if (!failed) {
          failed = true
          firstFailure = error
        }
      }
    }
    if (failed) throw firstFailure
  }

  /**
   * Recover nonterminal provider work and refresh every eligible durable Delivery once.
   * @param signal - provider lifetime for this pass.
   * @returns completion after every independently isolated eligible record has been attempted.
   */
  async pollPending(signal: AbortSignal): Promise<void> {
    let failed = false
    let firstFailure: unknown
    try {
      await this.recoverProviderPending(signal)
    } catch (error) {
      signal.throwIfAborted()
      failed = true
      firstFailure = error
    }
    const eligible = [...this.options.deliveryTable.entries()]
      .map(([, value]) => branchDeliveryRecordSchema.parse(value))
      .filter(record => record.phase !== 'accepted' && record.activeIntentId === undefined)
      .toSorted(compareDeliveryOrder)
    for (const record of eligible) {
      signal.throwIfAborted()
      try {
        await this.refresh(record.id, signal)
      } catch (error) {
        signal.throwIfAborted()
        if (!failed) {
          failed = true
          firstFailure = error
        }
      }
    }
    if (failed) throw firstFailure
  }

  private track(operation: Promise<unknown>): Promise<void> {
    const work = operation.then(
      () => undefined,
      (error: unknown) => { this.options.reportUnexpectedFailure(error) },
    )
    this.active.add(work)
    void work.finally(() => { this.active.delete(work) })
    return work
  }

  private async resumePush(
    initial: BranchDeliveryIntentRecord,
    signal: AbortSignal,
  ): Promise<BranchDeliveryIntentResult> {
    let record = initial
    const request = requirePushRequest(record)
    const applied = this.requireDelivery(record.deliveryId)
    if (applied.activeIntentId === undefined && applied.lastIntentId === record.id
      && applied.push?.intentId === record.id && intentMatchesDelivery(record, applied)) {
      const snapshot = await this.options.execution.inspectOperation<'push-branch'>(
        requireHostPreparation(record).operation, signal,
      )
      if (snapshot.state !== 'succeeded'
        || !isDeepStrictEqual(snapshot.result, applied.push.result)
        || snapshot.completedAt !== applied.push.confirmedAt) {
        throw new Error('Applied Branch Push disagrees with its Host snapshot')
      }
      return await this.finishPushSnapshot(record, snapshot)
    }
    if (record.checkpoint.state === 'active') {
      if (!this.intentTargetCurrent(record, 'branch-delivery:push')) {
        const value = this.options.admissionTable.get(request.expected.binding.id)
        if (value === undefined) return unavailableResult(record)
        const admission = bindingWriteAdmissionRecordSchema.parse(value)
        if (!isPushAdmission(admission) || !pushAdmissionMatches(admission, record, request)) {
          return await this.cancelActiveIntent(record, 'conflict', 'expected-evidence')
        }
      }
      try {
        await this.reservePushAdmission(record, request)
      } catch (error) {
        if (error instanceof AdmissionBusy || error instanceof AdmissionUnavailable) return unavailableResult(record)
        throw error
      }
    }
    const prepared = await this.options.execution.prepareOperation(
      request,
      (expectation, admissionSignal) => this.admitPush(expectation, admissionSignal),
      signal,
    )
    signal.throwIfAborted()
    if (!prepared.ok) {
      return prepared.reason === 'unavailable'
        ? unavailableResult(record)
        : await this.reconcileHost(record, 'evidence-conflict')
    }
    assertPushPreparation(record, prepared.preparation, prepared.snapshot)
    if (record.checkpoint.state === 'active') {
      let admission: PushWriteAdmissionRecord
      try {
        admission = await this.acceptPushAdmission(record, prepared.preparation)
      } catch (error) {
        if (error instanceof AdmissionBusy || error instanceof AdmissionUnavailable) return unavailableResult(record)
        throw error
      }
      record = await this.updateIntent(record, {
        checkpoint: {
          state: 'push-host-accepted',
          deliveryRevision: activeDeliveryRevision(record),
          preparation: prepared.preparation,
          admissionRevision: admission.revision,
        },
      })
    } else if (!isDeepStrictEqual(hostPreparation(record), prepared.preparation)) {
      throw new Error('Push Host preparation changed during replay')
    }
    const preparation = requireHostPreparation(record)
    const inspected = await this.options.execution.inspectOperation<'push-branch'>(
      preparation.operation,
      signal,
    )
    assertPushSnapshot(record, inspected)
    if (terminalHostSnapshot(inspected.state)) return await this.finishPushSnapshot(record, inspected)
    const started = await this.options.execution.startOperation<'push-branch'>(
      preparation.operation,
      prepared.acceptance,
      signal,
    )
    signal.throwIfAborted()
    assertPushSnapshot(record, started.snapshot)
    if (terminalHostSnapshot(started.snapshot.state)) return await this.finishPushSnapshot(record, started.snapshot)
    if (!started.ok && started.reason !== 'busy' && started.reason !== 'unavailable') {
      const reason = started.reason === 'authority-revoked' ? 'authority-revoked' : 'source-canceled'
      const canceled = await this.options.execution.cancelOperation(preparation.operation, reason, signal)
      signal.throwIfAborted()
      assertPushSnapshot(record, canceled)
      if (terminalHostSnapshot(canceled.state)) return await this.finishPushSnapshot(record, canceled)
    }
    this.options.notifyChanged()
    return unavailableResult(record)
  }

  private async finishPushSnapshot(
    record: BranchDeliveryIntentRecord,
    snapshot: HostOperationSnapshot<'push-branch'>,
  ): Promise<BranchDeliveryIntentResult> {
    assertPushSnapshot(record, snapshot)
    const delivery = this.requireDelivery(record.deliveryId)
    if (snapshot.state === 'reconciliation-required') {
      return await this.reconcileHost(record, snapshot.reason, snapshot)
    }
    if (snapshot.state === 'succeeded') {
      const result = snapshot.result
      assertPushResult(result, delivery)
      let saved: BranchDeliveryRecord
      if (delivery.activeIntentId === record.id) {
        saved = await this.updateDelivery(delivery, {
          activeIntentId: undefined,
          push: { intentId: record.id, result, confirmedAt: snapshot.completedAt },
          lastIntentId: record.id,
          repair: undefined,
        })
      } else if (delivery.lastIntentId === record.id
        && delivery.push?.result.commitId === result.commitId) {
        saved = delivery
      } else {
        throw new Error('Push success lost its Branch Delivery ownership')
      }
      record = await this.finishIntent(record, 'succeeded', undefined, saved.revision, snapshot)
      await this.releasePushAdmission(record)
      this.options.notifyChanged()
      return resultFor(record)
    }
    if (snapshot.state !== 'failed' && snapshot.state !== 'canceled') {
      throw new Error(`Nonterminal Host snapshot cannot finish Push Intent '${record.id}'`)
    }
    const outcome = snapshot.state === 'canceled' && snapshot.reason === 'authority-revoked' ? 'denied' : 'failure'
    const reason = snapshot.state === 'failed' ? 'host-operation'
      : snapshot.reason === 'authority-revoked' ? 'authority' : 'host-operation'
    const saved = delivery.activeIntentId === record.id
      ? await this.updateDelivery(delivery, { activeIntentId: undefined, lastIntentId: record.id })
      : delivery
    record = await this.finishIntent(record, outcome, reason, saved.revision, snapshot)
    await this.releasePushAdmission(record)
    this.options.notifyChanged()
    return resultFor(record)
  }

  private async reconcileHost(
    record: BranchDeliveryIntentRecord,
    reason: 'effect-unknown' | 'evidence-conflict',
    snapshot?: HostOperationSnapshot<'push-branch'>,
  ): Promise<BranchDeliveryIntentResult> {
    return await this.finishRepair(record, reason, reason, Date.now(), snapshot)
  }

  private async replayTerminal(
    record: BranchDeliveryIntentRecord,
    signal: AbortSignal,
  ): Promise<BranchDeliveryIntentResult> {
    const checkpoint = requireTerminalCheckpoint(record)
    if (checkpoint.host !== undefined) {
      const inspected = await this.options.execution.inspectOperation<'push-branch'>(
        checkpoint.host.preparation.operation as HostOperationPreparation<'push-branch'>['operation'],
        signal,
      )
      assertPushSnapshot(record, inspected)
      if (!terminalHostSnapshot(inspected.state) || !isDeepStrictEqual(inspected, checkpoint.host.snapshot)) {
        throw new Error(`terminal Push snapshot disagrees with Branch Delivery Intent '${record.id}'`)
      }
      if (checkpoint.outcome !== 'reconciliation-required') await this.releasePushAdmissionIfOwned(record)
    }
    return resultFor(record)
  }

  private async reservePushAdmission(
    record: BranchDeliveryIntentRecord,
    request: PushBranchHostOperationRequest,
  ): Promise<PushWriteAdmissionRecord> {
    const bindingId = request.expected.binding.id
    if (this.options.admissionTable.get(bindingId) === undefined) throw new AdmissionUnavailable()
    try {
      const next = await this.options.admissionTable.update(bindingId, (value) => {
        const current = bindingWriteAdmissionRecordSchema.parse(value)
        if (isPushAdmission(current)) {
          if (pushAdmissionMatches(current, record, request)) return current
          throw new AdmissionBusy()
        }
        if (current.state !== 'available') throw new AdmissionBusy()
        const now = Math.max(Date.now(), current.updatedAt)
        return bindingWriteAdmissionRecordSchema.parse({
          id: bindingId,
          schemaVersion: 1,
          revision: current.revision + 1,
          state: 'manual-host-operation',
          phase: 'reserved',
          bindingRevision: request.expected.binding.revision,
          source: request.source,
          action: 'project-branch:push',
          reservedAt: now,
          updatedAt: now,
        })
      })
      if (!isPushAdmission(next)) throw new AdmissionUnavailable()
      return next
    } catch (error) {
      if (error instanceof AdmissionBusy || error instanceof AdmissionUnavailable) throw error
      const replay = this.options.admissionTable.get(bindingId)
      if (replay !== undefined) {
        const parsed = bindingWriteAdmissionRecordSchema.parse(replay)
        if (isPushAdmission(parsed) && pushAdmissionMatches(parsed, record, request)) return parsed
      }
      throw error
    }
  }

  private async acceptPushAdmission(
    record: BranchDeliveryIntentRecord,
    preparation: HostOperationPreparation<'push-branch'>,
  ): Promise<PushWriteAdmissionRecord> {
    const request = requirePushRequest(record)
    const bindingId = request.expected.binding.id
    try {
      const next = await this.options.admissionTable.update(bindingId, (value) => {
        const current = bindingWriteAdmissionRecordSchema.parse(value)
        if (!isPushAdmission(current) || !pushAdmissionMatches(current, record, request)) {
          throw new AdmissionBusy()
        }
        if (current.phase === 'accepted') return current
        const now = Math.max(Date.now(), current.updatedAt)
        return bindingWriteAdmissionRecordSchema.parse({
          ...current,
          revision: current.revision + 1,
          phase: 'accepted',
          preparation,
          acceptedAt: now,
          updatedAt: now,
        })
      })
      /* jscpd:ignore-start -- accepted-phase replay must reassert the phase that reserved admission deliberately does not require */
      if (!isPushAdmission(next) || next.phase !== 'accepted') throw new AdmissionUnavailable()
      return next
    } catch (error) {
      if (error instanceof AdmissionBusy || error instanceof AdmissionUnavailable) throw error
      const replay = this.options.admissionTable.get(bindingId)
      if (replay !== undefined) {
        const parsed = bindingWriteAdmissionRecordSchema.parse(replay)
        if (isPushAdmission(parsed) && parsed.phase === 'accepted'
          && pushAdmissionMatches(parsed, record, request)) return parsed
      }
      throw error
      /* jscpd:ignore-end */
    }
  }

  private admitPush(
    expectation: HostOperationAdmissionExpectation,
    signal: AbortSignal,
  ): Promise<HostOperationAdmissionDecision> {
    signal.throwIfAborted()
    if (expectation.source.kind !== 'control-intent') {
      return Promise.resolve({ kind: 'denied', reason: 'not-current' })
    }
    const value = this.options.intentTable.get(expectation.source.intentId)
    if (value === undefined) return Promise.resolve({ kind: 'denied', reason: 'not-current' })
    const record = branchDeliveryIntentRecordSchema.parse(value)
    const request = record.operation.kind === 'push' ? record.operation.request : undefined
    const checkpoint = record.checkpoint
    if (checkpoint.state !== 'push-host-accepted' || request === undefined
      || !isDeepStrictEqual(expectation.source, request.source)
      || !isDeepStrictEqual(expectation.preparation, checkpoint.preparation)
      || expectation.bindingId !== request.expected.binding.id
      || expectation.bindingRevision !== request.expected.binding.revision) {
      return Promise.resolve({ kind: 'denied', reason: 'not-current' })
    }
    const admissionValue = this.options.admissionTable.get(expectation.bindingId)
    if (admissionValue === undefined) return Promise.resolve({ kind: 'unavailable' })
    const admission = bindingWriteAdmissionRecordSchema.safeParse(admissionValue)
    if (!admission.success || !isPushAdmission(admission.data) || admission.data.phase !== 'accepted'
      || admission.data.revision !== checkpoint.admissionRevision
      || !pushAdmissionMatches(admission.data, record, request)) {
      return Promise.resolve({ kind: 'denied', reason: 'not-current' })
    }
    if (!this.intentTargetCurrent(record, 'branch-delivery:push')) {
      const authority = this.options.authorityCurrent(record.payload.actor, 'branch-delivery:push')
      return Promise.resolve({ kind: 'denied', reason: authority ? 'not-current' : 'authority-revoked' })
    }
    return Promise.resolve({ kind: 'accepted', admissionRevision: admission.data.revision })
  }

  private async releasePushAdmission(record: BranchDeliveryIntentRecord): Promise<void> {
    const request = requirePushRequest(record)
    const bindingId = request.expected.binding.id
    const value = this.options.admissionTable.get(bindingId)
    if (value === undefined) throw new AdmissionUnavailable()
    const current = bindingWriteAdmissionRecordSchema.parse(value)
    if (current.state === 'available') return
    if (!isPushAdmission(current) || !pushAdmissionMatches(current, record, request)) throw new AdmissionBusy()
    try {
      await this.options.admissionTable.update(bindingId, (storedValue) => {
        const stored = bindingWriteAdmissionRecordSchema.parse(storedValue)
        if (stored.state === 'available') return stored
        // Push release validates its aggregate-owned admission independently from generic Git operations.
        /* jscpd:ignore-start */
        if (!isPushAdmission(stored) || stored.revision !== current.revision
          || !pushAdmissionMatches(stored, record, request)) throw new AdmissionBusy()
        return bindingWriteAdmissionRecordSchema.parse({
          id: bindingId,
          schemaVersion: 1,
          revision: stored.revision + 1,
          state: 'available',
          updatedAt: Math.max(stored.updatedAt, Date.now()),
        })
      })
    } catch (error) {
      const replay = this.options.admissionTable.get(bindingId)
      if (replay !== undefined) {
        const parsed = bindingWriteAdmissionRecordSchema.parse(replay)
        if (parsed.state === 'available' && parsed.revision >= current.revision + 1) return
      }
      throw error
      /* jscpd:ignore-end */
    }
  }

  private async releasePushAdmissionIfOwned(record: BranchDeliveryIntentRecord): Promise<void> {
    const request = requirePushRequest(record)
    const value = this.options.admissionTable.get(request.expected.binding.id)
    if (value === undefined) throw new AdmissionUnavailable()
    const current = bindingWriteAdmissionRecordSchema.parse(value)
    if (current.state === 'available' || !isPushAdmission(current)) return
    if (pushAdmissionMatches(current, record, request)) await this.releasePushAdmission(record)
  }

  private async resumePullRequestCreate(
    initial: BranchDeliveryIntentRecord,
    signal: AbortSignal,
  ): Promise<BranchDeliveryIntentResult> {
    let record = initial
    if (record.operation.kind !== 'pull-request-create') {
      throw new Error('Pull Request create Intent lacks its immutable request')
    }
    const request = record.operation.request
    const applied = this.requireDelivery(record.deliveryId)
    if (applied.activeIntentId === undefined && applied.lastIntentId === record.id
      && applied.pullRequest.confirmed !== undefined && intentMatchesDelivery(record, applied)) {
      record = await this.finishIntent(record, 'succeeded', undefined, applied.revision)
      return resultFor(record)
    }
    const attachment = this.github
    if (attachment === undefined) return unavailableResult(record)
    const provider = attachment.provider
    const providerSignal = AbortSignal.any([signal, attachment.lifetime.signal])
    if (record.checkpoint.state === 'pull-request-effect-possible') {
      return await this.inspectPossiblePullRequestEffect(record, request, provider, providerSignal)
    }
    let inspection: GitHubPullRequestCreateInspection
    try {
      inspection = await provider.inspectMutation<'pull-request-create'>(request, providerSignal)
    } catch (error) {
      providerFailure(error)
      return unavailableResult(record)
    }
    providerSignal.throwIfAborted()
    const outcome = inspection.snapshot.outcome
    if (outcome.state === 'unique-pull-request') {
      return await this.confirmPullRequest(record, outcome.pullRequest, inspection, providerSignal)
    }
    if (outcome.state === 'incomplete') return unavailableResult(record)
    if (outcome.state !== 'absent-complete') {
      return await this.reconcilePullRequest(record, inspection, reconciliationReason(outcome.state))
    }
    if (!this.intentTargetCurrent(record, 'branch-delivery:pull-request:create')) {
      return await this.cancelActiveIntent(record, 'conflict', 'expected-evidence')
    }
    record = await this.updateIntent(record, {
      checkpoint: {
        state: 'pull-request-effect-possible',
        deliveryRevision: activeDeliveryRevision(record),
      },
    })
    if (!this.intentTargetCurrent(record, 'branch-delivery:pull-request:create')) {
      return await this.reconcilePullRequest(record, inspection, 'evidence-conflict')
    }
    let hint: Awaited<ReturnType<typeof provider.dispatch<'pull-request-create'>>>
    try {
      hint = await provider.dispatch<'pull-request-create'>(request, providerSignal)
    } catch (error) {
      const failure = tryProviderFailure(error)
      if (failure === undefined) throw error
      try {
        return await this.inspectPossiblePullRequestEffect(record, request, provider, providerSignal)
      } catch (inspectionError) {
        if (!(inspectionError instanceof GitHubProviderError)) throw inspectionError
        providerFailure(inspectionError)
        return unavailableResult(record)
      }
    }
    providerSignal.throwIfAborted()
    const inspectionRequest = githubPullRequestCreateRequestSchema.parse({ ...request, inspectionHint: hint })
    record = await this.updateIntent(record, {
      operation: { kind: 'pull-request-create', request: inspectionRequest },
    })
    return await this.inspectPossiblePullRequestEffect(record, inspectionRequest, provider, providerSignal)
  }

  private async resumePullRequestAssociation(
    record: BranchDeliveryIntentRecord,
    signal: AbortSignal,
  ): Promise<BranchDeliveryIntentResult> {
    const intent = record.payload.intent
    if (intent.type !== 'associate-branch-delivery-pull-request') {
      throw new Error('Pull Request association selected another Intent kind')
    }
    const delivery = this.requireDelivery(record.deliveryId)
    if (delivery.activeIntentId === undefined && delivery.lastIntentId === record.id
      && delivery.pullRequest.confirmed?.fact.id === intent.pullRequestId) {
      record = await this.finishIntent(record, 'succeeded', undefined, delivery.revision)
      return resultFor(record)
    }
    const attachment = this.github
    if (attachment === undefined) return unavailableResult(record)
    const providerSignal = AbortSignal.any([signal, attachment.lifetime.signal])
    let association
    try {
      association = await attachment.provider.read<'pull-request-association'>({
        kind: 'pull-request-association',
        installation: delivery.target.installation,
        repositoryId: delivery.target.repository.id,
        repositoryDatabaseId: delivery.target.repository.databaseId,
        headRef: branchName(delivery.headRef),
        baseRef: branchName(delivery.baseRef),
        expectedHeadCommitId: delivery.commitId,
      }, providerSignal)
    } catch (error) {
      providerFailure(error)
      return unavailableResult(record)
    }
    providerSignal.throwIfAborted()
    const pullRequest = association.state === 'unique'
      && association.pullRequest.id === intent.pullRequestId
      && association.pullRequest.number === intent.pullRequestNumber
      ? association.pullRequest
      : undefined
    if (pullRequest === undefined || !pullRequestMatchesDelivery(pullRequest, delivery)) {
      return await this.cancelActiveIntent(record, 'conflict', 'expected-evidence')
    }
    if (!this.intentTargetCurrent(record, 'branch-delivery:pull-request:associate')) {
      return await this.cancelActiveIntent(record, 'conflict', 'expected-evidence')
    }
    const confirmedAt = Math.max(Date.now(), association.observedAt, pullRequest.observedAt)
    const saved = await this.updateDelivery(delivery, {
      activeIntentId: undefined,
      pullRequest: {
        confirmed: { fact: pullRequest, confirmedAt },
        current: { state: 'confirmed', observedAt: pullRequest.observedAt },
      },
      reviews: reviewsAfterPullRequestConfirmation(delivery, pullRequest),
      lastIntentId: record.id,
    })
    record = await this.finishIntent(record, 'succeeded', undefined, saved.revision)
    this.options.notifyChanged()
    return resultFor(record)
  }

  private async resumeWorkItemTransition(
    initial: BranchDeliveryIntentRecord,
    signal: AbortSignal,
    targetStatus: 'in-review' | 'done',
  ): Promise<BranchDeliveryIntentResult> {
    let record = initial
    const applied = this.requireDelivery(record.deliveryId)
    if (targetStatus === 'in-review' && applied.activeIntentId === undefined
      && applied.lastIntentId === record.id && applied.phase === 'in-review') {
      record = await this.finishIntent(record, 'succeeded', undefined, applied.revision)
      return resultFor(record)
    }
    if (record.checkpoint.state !== 'child-pending') {
      const prepared = await this.prepareWorkItemTransition(record, signal, targetStatus)
      if ('result' in prepared) return prepared.result
      record = prepared.record
    }
    const checkpoint = record.checkpoint
    if (checkpoint.state !== 'child-pending' || checkpoint.move.targetStatus !== targetStatus) {
      throw new Error(`Branch Delivery ${targetStatus} Intent lacks its child transition`)
    }
    if (targetStatus === 'done') {
      const sealed = await this.ensureAcceptanceSealed(record, signal)
      if ('result' in sealed) return sealed.result
      record = sealed.record
    }
    const result = await this.options.moveWorkItem(checkpoint.move, record.payload.actor, signal)
    switch (result.state) {
      case 'pending':
      case 'unavailable': return unavailableResult(record)
      case 'conflict':
        return targetStatus === 'done'
          ? await this.finishAcceptedChildFailure(record, 'child-transition')
          : await this.cancelActiveIntent(record, 'conflict', 'child-transition')
      case 'reconciliation-required':
        return targetStatus === 'done'
          ? await this.finishAcceptedChildFailure(record, 'child-transition')
          : await this.reconcileTransition(record, 'evidence-conflict')
      case 'succeeded': break
      default: return assertNever(result)
    }
    if (targetStatus === 'done') {
      const delivery = this.requireDelivery(record.deliveryId)
      if (delivery.phase !== 'accepted' || delivery.acceptance?.intentId !== record.id) {
        throw new Error('Done child transition lost its immutable acceptance')
      }
      record = await this.finishIntent(record, 'succeeded', undefined, delivery.revision)
      this.options.notifyChanged()
      return resultFor(record)
    }
    const delivery = this.requireDelivery(record.deliveryId)
    const evidence = checkpoint.evidence
    if (delivery.activeIntentId !== record.id) {
      throw new Error('In-review child transition lost its prepared evidence')
    }
    const saved = await this.updateDelivery(delivery, {
      activeIntentId: undefined,
      phase: 'in-review',
      target: {
        ...delivery.target,
        workItem: {
          ...delivery.target.workItem,
          remoteFingerprint: result.remoteFingerprint,
        },
      },
      remoteRef: confirmedObservation(evidence.remoteRef) as BranchDeliveryRecord['remoteRef'],
      pullRequest: confirmedObservation(evidence.pullRequest) as BranchDeliveryRecord['pullRequest'],
      reviews: reviewsAfterPullRequestConfirmation(delivery, evidence.pullRequest),
      lastIntentId: record.id,
    })
    record = await this.finishIntent(record, 'succeeded', undefined, saved.revision)
    this.options.notifyChanged()
    return resultFor(record)
  }

  private async prepareWorkItemTransition(
    record: BranchDeliveryIntentRecord,
    signal: AbortSignal,
    targetStatus: 'in-review' | 'done',
  ): Promise<{ readonly record: BranchDeliveryIntentRecord } | { readonly result: BranchDeliveryIntentResult }> {
    const intent = record.payload.intent
    if (intent.type !== 'mark-branch-delivery-in-review' && intent.type !== 'accept-branch-delivery') {
      throw new Error('Work Item transition selected another Branch Delivery Intent kind')
    }
    const action = targetStatus === 'done' ? 'branch-delivery:accept' : 'branch-delivery:review'
    const delivery = this.requireDelivery(record.deliveryId)
    if (delivery.activeIntentId !== record.id || delivery.revision !== activeDeliveryRevision(record)
      || delivery.push === undefined || delivery.push.result.commitId !== delivery.commitId
      || delivery.pullRequest.confirmed === undefined
      || (targetStatus === 'done' && delivery.phase !== 'in-review')
      || (targetStatus === 'in-review' && delivery.phase !== 'draft')) {
      return { result: await this.cancelActiveIntent(record, 'conflict', 'expected-evidence') }
    }
    if (intent.expectedWorkItemRemoteFingerprint !== delivery.target.workItem.remoteFingerprint) {
      return { result: await this.cancelActiveIntent(record, 'conflict', 'expected-revision') }
    }
    if (!this.intentTargetCurrent(record, action)) {
      const denied = !this.options.authorityCurrent(record.payload.actor, action)
      return {
        result: await this.cancelActiveIntent(
          record,
          denied ? 'denied' : 'conflict',
          denied ? 'authority' : 'expected-evidence',
        ),
      }
    }
    const attachment = this.github
    if (attachment === undefined) return { result: unavailableResult(record) }
    const providerSignal = AbortSignal.any([signal, attachment.lifetime.signal])
    const localHeadPromise = this.options.currentLocalHead(delivery.target.binding, providerSignal)
    const evidencePromise = this.readEvidence(
      delivery,
      attachment.provider,
      providerSignal,
      targetStatus === 'done',
    )
    const [localHead, reads] = await Promise.all([localHeadPromise, evidencePromise])
    providerSignal.throwIfAborted()
    if (!this.options.authorityCurrent(record.payload.actor, action)) {
      return { result: await this.cancelActiveIntent(record, 'denied', 'authority') }
    }
    const readFailure = firstEvidenceFailure(reads, targetStatus === 'done')
    if (readFailure !== undefined || !localHead.ok) {
      return {
        result: await this.finishEvidenceRejection(record, delivery, reads, targetStatus === 'done', 'failure'),
      }
    }
    const remoteRef = reads.remoteRef.ok ? reads.remoteRef.fact : undefined
    const pullRequest = reads.pullRequest?.ok === true ? reads.pullRequest.fact : undefined
    const ci = reads.ci?.ok === true ? reads.ci.fact : undefined
    const evidenceMatches = localHead.commitId === delivery.commitId
      && remoteRef !== undefined && remoteRefMatches(delivery)(remoteRef)
      && pullRequest !== undefined && pullRequestMatchesDelivery(pullRequest, delivery)
      && (targetStatus !== 'done' || (ci !== undefined
        && ciMatches(delivery)(ci)
        && summarizeCommitCi(ci).state === 'successful'))
    if (!evidenceMatches || !this.intentTargetCurrent(record, action)) {
      return {
        result: await this.finishEvidenceRejection(record, delivery, reads, targetStatus === 'done', 'conflict'),
      }
    }
    const localCommitObservedAt = localHead.observedAt ?? Date.now()
    const evidenceMaterial = {
      localCommitObservedAt,
      remoteRef,
      pullRequest,
      ...(targetStatus === 'done' && ci !== undefined ? { ci } : {}),
    }
    const transitionEvidence = transitionEvidenceSchema.parse({
      ...evidenceMaterial,
      digest: canonicalDigest('saki/branch-delivery/transition-evidence/v1', evidenceMaterial),
    })
    const childMove = childMoveSchema.parse({
      intentId: childMoveIntentId(record.id, targetStatus),
      projectId: delivery.projectId,
      workItemId: delivery.workItemId,
      expectedRemoteFingerprint: intent.expectedWorkItemRemoteFingerprint,
      targetStatus,
    })
    record = await this.updateIntent(record, {
      checkpoint: {
        state: 'child-pending',
        deliveryRevision: activeDeliveryRevision(record),
        evidence: transitionEvidence,
        move: childMove,
      },
    })
    return { record }
  }

  private async ensureAcceptanceSealed(
    record: BranchDeliveryIntentRecord,
    signal: AbortSignal,
  ): Promise<{ readonly record: BranchDeliveryIntentRecord } | { readonly result: BranchDeliveryIntentResult }> {
    const checkpoint = record.checkpoint
    const intent = record.payload.intent
    if (checkpoint.state !== 'child-pending' || checkpoint.move.targetStatus !== 'done'
      || intent.type !== 'accept-branch-delivery') {
      throw new Error('Branch Delivery acceptance lacks its prepared Done transition')
    }
    const delivery = this.requireDelivery(record.deliveryId)
    if (delivery.phase === 'accepted' && delivery.acceptance?.intentId === record.id) return { record }
    if (delivery.phase !== 'in-review' || delivery.activeIntentId !== record.id
      || delivery.revision !== checkpoint.deliveryRevision
      || intent.expectedWorkItemRemoteFingerprint !== delivery.target.workItem.remoteFingerprint) {
      return { result: await this.cancelActiveIntent(record, 'conflict', 'expected-evidence') }
    }
    /* jscpd:ignore-start -- child completion rechecks the acceptance authority after a separately durable Work Item transition */
    if (!this.intentTargetCurrent(record, 'branch-delivery:accept')) {
      const denied = !this.options.authorityCurrent(record.payload.actor, 'branch-delivery:accept')
      return {
        result: await this.cancelActiveIntent(
          record,
          denied ? 'denied' : 'conflict',
          denied ? 'authority' : 'expected-evidence',
        ),
      }
    }
    /* jscpd:ignore-end */
    const attachment = this.github
    if (attachment === undefined) return { result: unavailableResult(record) }
    const providerSignal = AbortSignal.any([signal, attachment.lifetime.signal])
    const [localHead, reads] = await Promise.all([
      this.options.currentLocalHead(delivery.target.binding, providerSignal),
      this.readEvidence(delivery, attachment.provider, providerSignal, true),
    ])
    providerSignal.throwIfAborted()
    if (!this.options.authorityCurrent(record.payload.actor, 'branch-delivery:accept')) {
      return { result: await this.cancelActiveIntent(record, 'denied', 'authority') }
    }
    if (firstEvidenceFailure(reads, true) !== undefined || !localHead.ok) {
      return { result: await this.finishEvidenceRejection(record, delivery, reads, true, 'failure') }
    }
    const remoteRef = reads.remoteRef.ok ? reads.remoteRef.fact : undefined
    const pullRequest = reads.pullRequest?.ok === true ? reads.pullRequest.fact : undefined
    const ci = reads.ci?.ok === true ? reads.ci.fact : undefined
    const current = localHead.commitId === delivery.commitId
      && remoteRef !== undefined && remoteRefMatches(delivery)(remoteRef)
      && pullRequest !== undefined && pullRequestMatchesDelivery(pullRequest, delivery)
      && ci !== undefined && ciMatches(delivery)(ci)
      && summarizeCommitCi(ci).state === 'successful'
      && this.intentTargetCurrent(record, 'branch-delivery:accept')
    if (!current) {
      return { result: await this.finishEvidenceRejection(record, delivery, reads, true, 'conflict') }
    }
    const evidenceMaterial = {
      localCommitObservedAt: localHead.observedAt ?? Date.now(),
      remoteRef,
      pullRequest,
      ci,
    }
    const acceptanceEvidence = acceptanceEvidenceSchema.parse({
      ...evidenceMaterial,
      digest: canonicalDigest('saki/branch-delivery/transition-evidence/v1', evidenceMaterial),
    })
    await this.updateDelivery(delivery, {
      activeIntentId: undefined,
      phase: 'accepted',
      remoteRef: confirmedObservation(remoteRef) as BranchDeliveryRecord['remoteRef'],
      pullRequest: confirmedObservation(pullRequest) as BranchDeliveryRecord['pullRequest'],
      reviews: sourceObservation(
        delivery.reviews,
        requireReviewsRead(reads),
        fact => reviewsMatchDelivery(fact, delivery, pullRequest),
      ) as BranchDeliveryRecord['reviews'],
      ci: confirmedObservation(ci) as BranchDeliveryRecord['ci'],
      acceptance: {
        intentId: record.id,
        actor: record.payload.actor,
        acceptedAt: Math.max(Date.now(), ci.observedAt),
        evidence: acceptanceEvidence,
      },
      lastIntentId: record.id,
    })
    this.options.notifyChanged()
    return { record }
  }

  private async finishEvidenceRejection(
    record: BranchDeliveryIntentRecord,
    delivery: BranchDeliveryRecord,
    reads: DeliveryEvidenceReads,
    includeCi: boolean,
    outcome: 'failure' | 'conflict',
  ): Promise<BranchDeliveryIntentResult> {
    const saved = await this.updateDelivery(delivery, {
      activeIntentId: undefined,
      ...evidenceUpdates(delivery, reads, includeCi),
      lastIntentId: record.id,
    })
    record = await this.finishIntent(record, outcome, 'expected-evidence', saved.revision)
    this.options.notifyChanged()
    return resultFor(record)
  }

  private async reconcileTransition(
    record: BranchDeliveryIntentRecord,
    reason: 'evidence-conflict',
  ): Promise<BranchDeliveryIntentResult> {
    return await this.finishRepair(record, reason, 'child-transition', Date.now())
  }

  private async finishAcceptedChildFailure(
    record: BranchDeliveryIntentRecord,
    reason: 'child-transition',
  ): Promise<BranchDeliveryIntentResult> {
    const delivery = this.requireDelivery(record.deliveryId)
    if (delivery.phase !== 'accepted' || delivery.acceptance?.intentId !== record.id) {
      throw new Error('accepted child failure lost its immutable Delivery evidence')
    }
    record = await this.finishIntent(record, 'reconciliation-required', reason, delivery.revision)
    this.options.notifyChanged()
    return resultFor(record)
  }

  private async readEvidence(
    delivery: BranchDeliveryRecord,
    provider: SakiGitHub,
    signal: AbortSignal,
    includeCi: boolean,
  ): Promise<DeliveryEvidenceReads> {
    const branch = branchName(delivery.headRef)
    const remoteRef = readGitHub(() => provider.read<'branch-head'>({
      kind: 'branch-head',
      installation: delivery.target.installation,
      repositoryId: delivery.target.repository.id,
      repositoryDatabaseId: delivery.target.repository.databaseId,
      branch,
    }, signal))
    const knownPullRequest = delivery.pullRequest.confirmed?.fact
    const pullRequest = knownPullRequest === undefined
      ? Promise.resolve(undefined)
      : readGitHub(() => provider.read<'pull-request'>({
        kind: 'pull-request',
        installation: delivery.target.installation,
        repositoryId: delivery.target.repository.id,
        repositoryDatabaseId: delivery.target.repository.databaseId,
        pullRequestId: knownPullRequest.id,
        pullRequestNumber: knownPullRequest.number,
      }, signal))
    const reviews = knownPullRequest === undefined
      ? Promise.resolve(undefined)
      : readGitHub(() => provider.read<'pull-request-reviews'>({
        kind: 'pull-request-reviews',
        installation: delivery.target.installation,
        repositoryId: delivery.target.repository.id,
        repositoryDatabaseId: delivery.target.repository.databaseId,
        pullRequestId: knownPullRequest.id,
        pullRequestNumber: knownPullRequest.number,
      }, signal))
    const ci = includeCi
      ? readGitHub(() => provider.read<'commit-ci'>({
        kind: 'commit-ci',
        installation: delivery.target.installation,
        repositoryId: delivery.target.repository.id,
        repositoryDatabaseId: delivery.target.repository.databaseId,
        commitId: delivery.commitId,
      }, signal))
      : Promise.resolve(undefined)
    const [remoteRefResult, pullRequestResult, reviewsResult, ciResult] = await Promise.all([
      remoteRef, pullRequest, reviews, ci,
    ])
    return {
      remoteRef: remoteRefResult,
      pullRequest: pullRequestResult,
      reviews: reviewsResult,
      ci: ciResult,
    }
  }

  private async inspectPossiblePullRequestEffect(
    record: BranchDeliveryIntentRecord,
    request: GitHubPullRequestCreateRequest,
    provider: SakiGitHub,
    signal: AbortSignal,
  ): Promise<BranchDeliveryIntentResult> {
    let inspection: GitHubPullRequestCreateInspection
    try {
      inspection = await provider.inspectMutation<'pull-request-create'>(request, signal)
    } catch (error) {
      providerFailure(error)
      return unavailableResult(record)
    }
    signal.throwIfAborted()
    const outcome = inspection.snapshot.outcome
    if (outcome.state === 'unique-pull-request') {
      return await this.confirmPullRequest(record, outcome.pullRequest, inspection, signal)
    }
    if (outcome.state === 'incomplete') return unavailableResult(record)
    return await this.reconcilePullRequest(
      record,
      inspection,
      outcome.state === 'absent-complete' || outcome.state === 'known-pull-request-absent'
        ? 'effect-unknown'
        : reconciliationReason(outcome.state),
    )
  }

  private async confirmPullRequest(
    record: BranchDeliveryIntentRecord,
    pullRequest: GitHubPullRequestFact,
    inspection: GitHubPullRequestCreateInspection,
    signal: AbortSignal,
  ): Promise<BranchDeliveryIntentResult> {
    signal.throwIfAborted()
    const delivery = this.requireDelivery(record.deliveryId)
    if (!pullRequestMatchesDelivery(pullRequest, delivery)) {
      return await this.reconcilePullRequest(record, inspection, 'evidence-conflict')
    }
    const confirmedAt = Math.max(Date.now(), inspection.observedAt, pullRequest.observedAt)
    let saved: BranchDeliveryRecord
    if (delivery.activeIntentId === record.id) {
      saved = await this.updateDelivery(delivery, {
        activeIntentId: undefined,
        pullRequest: {
          confirmed: { fact: pullRequest, confirmedAt },
          current: { state: 'confirmed', observedAt: pullRequest.observedAt },
        },
        reviews: reviewsAfterPullRequestConfirmation(delivery, pullRequest),
        lastIntentId: record.id,
        repair: undefined,
      })
    } else if (delivery.lastIntentId === record.id
      && delivery.pullRequest.confirmed?.fact.id === pullRequest.id) {
      saved = delivery
    } else {
      throw new Error('Pull Request confirmation lost its Branch Delivery ownership')
    }
    record = await this.finishIntent(record, 'succeeded', undefined, saved.revision)
    this.options.notifyChanged()
    return resultFor(record)
  }

  private async reconcilePullRequest(
    record: BranchDeliveryIntentRecord,
    inspection: GitHubPullRequestCreateInspection,
    reason: 'effect-unknown' | 'evidence-conflict' | 'marker-ambiguous',
  ): Promise<BranchDeliveryIntentResult> {
    return await this.finishRepair(record, reason, reason, Math.max(Date.now(), inspection.observedAt))
  }

  private async finishRepair(
    record: BranchDeliveryIntentRecord,
    repairReason: NonNullable<BranchDeliveryRecord['repair']>['reason'],
    terminalReason: TerminalReason,
    recordedAt: number,
    snapshot?: HostOperationSnapshot<'push-branch'>,
  ): Promise<BranchDeliveryIntentResult> {
    const delivery = this.requireDelivery(record.deliveryId)
    let saved = delivery
    if (delivery.activeIntentId === record.id) {
      saved = await this.updateDelivery(delivery, {
        activeIntentId: undefined,
        repair: { intentId: record.id, reason: repairReason, recordedAt },
        lastIntentId: record.id,
      })
    }
    record = await this.finishIntent(
      record,
      'reconciliation-required',
      terminalReason,
      saved.revision,
      snapshot,
    )
    this.options.notifyChanged()
    return resultFor(record)
  }

  private async submitSave(
    intent: BranchDeliverySaveIntent,
    actor: ControlIntentActor,
    signal: AbortSignal,
  ): Promise<BranchDeliveryIntentResult> {
    const id = branchDeliveryId(intent.projectId, intent.workItemId)
    return await enqueueKeyedOperation(this.deliveryTails, id, async () => {
      const currentValue = this.options.deliveryTable.get(id)
      if (currentValue !== undefined && this.lastIntentPending(branchDeliveryRecordSchema.parse(currentValue))) {
        return { ok: false, reason: 'unavailable' }
      }
      if (!this.options.authorityCurrent(actor, 'branch-delivery:save')) {
        return { ok: false, reason: 'denied' }
      }
      const resolved = this.options.resolveContext(intent.projectId, intent.workItemId)
      if (!resolved.ok) return { ok: false, reason: 'unavailable' }
      signal.throwIfAborted()
      const payload = { intent, actor }
      const now = Date.now()
      const record = branchDeliveryIntentRecordSchema.parse({
        id: intent.intentId,
        schemaVersion: 1,
        revision: 0,
        payloadDigest: canonicalDigest('saki/branch-delivery-intent/v1', payload),
        payload,
        deliveryId: id,
        operation: { kind: 'save' },
        checkpoint: { state: 'prepared' },
        createdAt: now,
        updatedAt: now,
      })
      await this.putIntent(record)
      return await this.resumeSave(record, signal)
    })
  }

  private async resumeSave(
    initial: BranchDeliveryIntentRecord,
    signal: AbortSignal,
  ): Promise<BranchDeliveryIntentResult> {
    let record = initial
    const intent = record.payload.intent
    if (intent.type !== 'save-branch-delivery' || record.checkpoint.state !== 'prepared') {
      throw new Error('Branch Delivery Save lacks its prepared checkpoint')
    }
    const appliedValue = this.options.deliveryTable.get(record.deliveryId)
    const applied = appliedValue === undefined ? undefined : branchDeliveryRecordSchema.parse(appliedValue)
    if (applied?.lastIntentId === record.id
      && deliveryMatchesSave(applied, intent, applied.target)
      && contextMatchesExpectation(applied.target, intent.expected)) {
      record = await this.finishIntent(record, 'succeeded', undefined, applied.revision)
      return resultFor(record)
    }
    if (!this.options.authorityCurrent(record.payload.actor, 'branch-delivery:save')) {
      record = await this.finishIntent(record, 'denied', 'authority')
      return resultFor(record)
    }
    const resolved = this.options.resolveContext(intent.projectId, intent.workItemId)
    if (!resolved.ok) return unavailableResult(record)
    const localHead = await this.options.currentLocalHead(resolved.context.binding, signal)
    signal.throwIfAborted()
    const currentContext = this.options.resolveContext(intent.projectId, intent.workItemId)
    if (!currentContext.ok) return unavailableResult(record)
    const currentValue = this.options.deliveryTable.get(record.deliveryId)
    const current = currentValue === undefined ? undefined : branchDeliveryRecordSchema.parse(currentValue)
    if (!localHead.ok) {
      if (localHead.reason === 'unavailable') return unavailableResult(record)
      record = await this.finishIntent(record, 'conflict', 'expected-evidence')
      return resultFor(record)
    }
    if (localHead.commitId !== intent.commitId
      || !this.options.authorityCurrent(record.payload.actor, 'branch-delivery:save')
      || !contextMatchesExpectation(currentContext.context, intent.expected)) {
      record = await this.finishIntent(record, 'conflict', 'expected-evidence')
      return resultFor(record)
    }
    if ((current === undefined) !== (intent.expected.deliveryRevision === null)
      || (current !== undefined && current.revision !== intent.expected.deliveryRevision)) {
      record = await this.finishIntent(record, 'conflict', 'expected-revision')
      return resultFor(record)
    }
    if (current?.phase === 'accepted') {
      record = await this.finishIntent(record, 'conflict', 'immutable')
      return resultFor(record)
    }
    if (current?.activeIntentId !== undefined || current?.repair !== undefined) {
      record = await this.finishIntent(record, 'conflict', 'expected-evidence', current.revision)
      return resultFor(record)
    }
    const saved = await this.saveDelivery(record, currentContext.context, current)
    record = await this.finishIntent(record, 'succeeded', undefined, saved.revision)
    this.options.notifyChanged()
    return resultFor(record)
  }

  private async saveDelivery(
    intentRecord: BranchDeliveryIntentRecord,
    context: BranchDeliveryCurrentContext,
    current: BranchDeliveryRecord | undefined,
  ): Promise<BranchDeliveryRecord> {
    const intent = intentRecord.payload.intent
    if (intent.type !== 'save-branch-delivery') throw new Error('Branch Delivery save record has another Intent kind')
    const now = Math.max(Date.now(), current?.updatedAt ?? 0)
    const candidate = branchDeliveryRecordSchema.parse({
      id: intentRecord.deliveryId,
      schemaVersion: 1,
      revision: current === undefined ? 0 : current.revision + 1,
      projectId: intent.projectId,
      workItemId: intent.workItemId,
      target: context,
      commitId: intent.commitId,
      headRef: intent.headRef,
      baseRef: intent.baseRef,
      markerId: pullRequestMarkerId(intentRecord.deliveryId),
      phase: 'draft',
      remoteRef: emptyObservation(),
      pullRequest: emptyObservation(),
      reviews: emptyObservation(),
      ci: emptyObservation(),
      lastIntentId: intentRecord.id,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    })
    if (current === undefined) {
      try {
        await this.options.deliveryTable.put(candidate.id, candidate)
        return candidate
      } catch (error) {
        const replay = this.options.deliveryTable.get(candidate.id)
        if (replay !== undefined && isDeepStrictEqual(branchDeliveryRecordSchema.parse(replay), candidate)) return candidate
        throw error
      }
    }
    try {
      return await this.options.deliveryTable.update(candidate.id, (value) => {
        const stored = branchDeliveryRecordSchema.parse(value)
        if (stored.revision !== current.revision || stored.phase === 'accepted') throw new IntentCasConflict()
        return candidate
      })
    } catch (error) {
      const replay = this.options.deliveryTable.get(candidate.id)
      if (replay !== undefined && isDeepStrictEqual(branchDeliveryRecordSchema.parse(replay), candidate)) return candidate
      throw error
    }
  }

  private intentTargetCurrent(record: BranchDeliveryIntentRecord, action: BranchDeliveryAction): boolean {
    const deliveryValue = this.options.deliveryTable.get(record.deliveryId)
    if (deliveryValue === undefined) return false
    const delivery = branchDeliveryRecordSchema.parse(deliveryValue)
    if (delivery.activeIntentId !== record.id || delivery.revision !== activeDeliveryRevision(record)
      || delivery.phase === 'accepted' || delivery.repair !== undefined
      || !this.options.authorityCurrent(record.payload.actor, action)) return false
    const resolved = this.options.resolveContext(delivery.projectId, delivery.workItemId)
    return resolved.ok && contextMatchesDelivery(resolved.context, delivery)
  }

  private async cancelActiveIntent(
    record: BranchDeliveryIntentRecord,
    outcome: 'conflict' | 'denied' | 'failure',
    reason: TerminalReason,
  ): Promise<BranchDeliveryIntentResult> {
    const delivery = this.requireDelivery(record.deliveryId)
    let saved = delivery
    if (delivery.activeIntentId === record.id) {
      saved = await this.updateDelivery(delivery, {
        activeIntentId: undefined,
        lastIntentId: record.id,
      })
    }
    record = await this.finishIntent(record, outcome, reason, saved.revision)
    this.options.notifyChanged()
    return resultFor(record)
  }

  private requireIntent(id: SakiControlIntentId): BranchDeliveryIntentRecord {
    const value = this.options.intentTable.get(id)
    if (value === undefined) throw new Error(`Saki Branch Delivery Intent '${id}' is missing`)
    return branchDeliveryIntentRecordSchema.parse(value)
  }

  private requireDelivery(id: SakiBranchDeliveryId): BranchDeliveryRecord {
    const value = this.options.deliveryTable.get(id)
    if (value === undefined) throw new Error(`Saki Branch Delivery '${id}' is missing`)
    return branchDeliveryRecordSchema.parse(value)
  }

  private lastIntentPending(delivery: BranchDeliveryRecord): boolean {
    const value = this.options.intentTable.get(delivery.lastIntentId)
    if (value === undefined) throw new Error('Branch Delivery last Intent is missing')
    return !terminalIntent(branchDeliveryIntentRecordSchema.parse(value))
  }

  private async updateDelivery(
    current: BranchDeliveryRecord,
    values: Partial<BranchDeliveryRecord>,
  ): Promise<BranchDeliveryRecord> {
    try {
      return await this.options.deliveryTable.update(current.id, (value) => {
        const stored = branchDeliveryRecordSchema.parse(value)
        if (stored.revision !== current.revision) throw new IntentCasConflict()
        const candidate = {
          ...stored,
          ...values,
          revision: stored.revision + 1,
          updatedAt: Math.max(stored.updatedAt, Date.now()),
        }
        return branchDeliveryRecordSchema.parse(Object.fromEntries(
          Object.entries(candidate).filter(([, next]) => next !== undefined),
        ))
      })
    } catch (error) {
      const replay = this.options.deliveryTable.get(current.id)
      if (replay !== undefined) {
        const parsed = branchDeliveryRecordSchema.parse(replay)
        if (parsed.revision === current.revision + 1
          && Object.entries(values).every(([key, expected]) => isDeepStrictEqual(
            parsed[key as keyof BranchDeliveryRecord], expected,
          ))) return parsed
      }
      throw error
    }
  }

  private async putIntent(record: BranchDeliveryIntentRecord): Promise<void> {
    try {
      await this.options.intentTable.put(record.id, record)
    } catch (error) {
      const replay = this.options.intentTable.get(record.id)
      if (replay !== undefined
        && branchDeliveryIntentRecordSchema.parse(replay).payloadDigest === record.payloadDigest) return
      throw error
    }
  }

  private async finishIntent(
    current: BranchDeliveryIntentRecord,
    outcome: 'succeeded' | 'conflict' | 'denied' | 'failure' | 'reconciliation-required',
    terminalReason?: TerminalReason,
    resultDeliveryRevision?: number,
    hostSnapshot?: HostOperationSnapshot<'push-branch'>,
  ): Promise<BranchDeliveryIntentRecord> {
    return await this.updateIntent(current, {
      checkpoint: {
        state: 'terminal',
        outcome,
        ...(terminalReason === undefined ? {} : { reason: terminalReason }),
        ...(resultDeliveryRevision === undefined ? {} : { deliveryRevision: resultDeliveryRevision }),
        ...(hostSnapshot === undefined ? {} : {
          host: { preparation: requireHostPreparation(current), snapshot: hostSnapshot },
        }),
      },
    })
  }

  private async updateIntent(
    current: BranchDeliveryIntentRecord,
    values: Partial<BranchDeliveryIntentRecord>,
  ): Promise<BranchDeliveryIntentRecord> {
    try {
      return await this.options.intentTable.update(current.id, (value) => {
        const stored = branchDeliveryIntentRecordSchema.parse(value)
        if (stored.revision !== current.revision || stored.payloadDigest !== current.payloadDigest) {
          throw new IntentCasConflict()
        }
        return branchDeliveryIntentRecordSchema.parse({
          ...stored,
          ...values,
          revision: stored.revision + 1,
          updatedAt: Math.max(stored.updatedAt, Date.now()),
        })
      })
    } catch (error) {
      const replay = this.options.intentTable.get(current.id)
      if (replay !== undefined) {
        const parsed = branchDeliveryIntentRecordSchema.parse(replay)
        if (parsed.payloadDigest === current.payloadDigest && parsed.revision === current.revision + 1
          && Object.entries(values).every(([key, expected]) => isDeepStrictEqual(
            parsed[key as keyof BranchDeliveryIntentRecord], expected,
          ))) return parsed
      }
      throw error
    }
  }
}

class IntentCasConflict extends Error {}
class AdmissionBusy extends Error {}
class AdmissionUnavailable extends Error {}

function emptyObservation<T>(): BranchDeliverySourceObservation<T> {
  return { current: { state: 'unobserved' } }
}

function reviewsAfterPullRequestConfirmation(
  delivery: BranchDeliveryRecord,
  pullRequest: GitHubPullRequestFact,
): BranchDeliveryRecord['reviews'] {
  const previousPullRequest = delivery.pullRequest.confirmed?.fact
  if (previousPullRequest === undefined
    || previousPullRequest.repositoryId !== pullRequest.repositoryId
    || previousPullRequest.id !== pullRequest.id
    || previousPullRequest.number !== pullRequest.number
    || previousPullRequest.head.repositoryId !== pullRequest.head.repositoryId
    || previousPullRequest.head.ref !== pullRequest.head.ref
    || previousPullRequest.head.commitId !== pullRequest.head.commitId) {
    return { current: { state: 'unobserved' } }
  }
  if (previousPullRequest.updatedAt === pullRequest.updatedAt) return structuredClone(delivery.reviews)
  return {
    ...(delivery.reviews.confirmed === undefined
      ? {}
      : { confirmed: structuredClone(delivery.reviews.confirmed) }),
    current: {
      state: 'invalidated',
      invalidatedAt: pullRequest.observedAt,
      reason: 'target-changed',
    },
  }
}

function sourceObservation<T>(
  previous: BranchDeliverySourceObservation<T>,
  read: DeliveryRead<T>,
  matches: (fact: T) => boolean,
): BranchDeliverySourceObservation<T> {
  if (!read.ok) {
    return {
      ...previous,
      current: {
        state: 'failure',
        failedAt: Date.now(),
        failure: structuredClone(read.failure),
      },
    }
  }
  const observedAt = observationTime(read.fact)
  if (!matches(read.fact)) {
    return {
      ...previous,
      current: { state: 'invalidated', invalidatedAt: observedAt, reason: invalidationReason(read.fact) },
    }
  }
  return {
    confirmed: { fact: structuredClone(read.fact), confirmedAt: Math.max(Date.now(), observedAt) },
    current: { state: 'confirmed', observedAt },
  }
}

function invalidationReason(fact: unknown): 'target-absent' | 'target-changed' {
  return typeof fact === 'object' && fact !== null && 'state' in fact && fact.state === 'absent'
    ? 'target-absent'
    : 'target-changed'
}

function evidenceUpdates(
  delivery: BranchDeliveryRecord,
  reads: DeliveryEvidenceReads,
  includeCi: boolean,
): Partial<Pick<BranchDeliveryRecord, 'remoteRef' | 'pullRequest' | 'reviews' | 'ci'>> {
  return {
    remoteRef: sourceObservation(
      delivery.remoteRef,
      reads.remoteRef,
      remoteRefMatches(delivery),
    ) as BranchDeliveryRecord['remoteRef'],
    ...(reads.pullRequest === undefined ? {} : {
      pullRequest: sourceObservation(
        delivery.pullRequest,
        reads.pullRequest,
        fact => pullRequestMatchesDelivery(fact, delivery),
      ) as BranchDeliveryRecord['pullRequest'],
    }),
    ...(reads.reviews === undefined ? {} : {
      reviews: sourceObservation(
        delivery.reviews,
        reads.reviews,
        fact => reviewsMatchDelivery(
          fact,
          delivery,
          reads.pullRequest?.ok === true ? reads.pullRequest.fact : delivery.pullRequest.confirmed?.fact,
        ),
      ) as BranchDeliveryRecord['reviews'],
    }),
    ...(includeCi ? {
      ci: sourceObservation(delivery.ci, requireCiRead(reads), ciMatches(delivery)) as BranchDeliveryRecord['ci'],
    } : {}),
  }
}

function projectObservation<T>(
  observation: BranchDeliverySourceObservation<T>,
  now: number,
  freshForMs: number,
): BranchDeliverySourceProjection<T> {
  const confirmed = observation.confirmed === undefined
    ? {}
    : { confirmed: structuredClone(observation.confirmed) }
  const current = observation.current.state === 'failure'
    ? { ...observation.current, failure: projectGitHubFailure(observation.current.failure) }
    : structuredClone(observation.current)
  if (current.state !== 'confirmed' || now <= current.observedAt + freshForMs) {
    return { ...confirmed, current }
  }
  return {
    ...confirmed,
    current: {
      state: 'stale',
      observedAt: current.observedAt,
      staleAt: current.observedAt + freshForMs,
    },
  }
}

function projectBrowserDelivery(record: BranchDeliveryRecord): BranchDeliveryBrowserRecord {
  return {
    id: record.id,
    schemaVersion: record.schemaVersion,
    revision: record.revision,
    projectId: record.projectId,
    workItemId: record.workItemId,
    target: {
      registryRevision: record.target.registryRevision,
      projectRevision: record.target.projectRevision,
      binding: {
        id: record.target.binding.id,
        revision: record.target.binding.revision,
        hostId: record.target.binding.hostId,
        health: record.target.binding.health,
      },
      synchronizationRevision: record.target.synchronizationRevision,
      mappingRevision: record.target.mappingRevision,
      installation: {
        appId: record.target.installation.appId,
        installationId: record.target.installation.installationId,
        accountId: record.target.installation.accountId,
      },
      repository: structuredClone(record.target.repository),
      workItem: structuredClone(record.target.workItem),
    },
    commitId: record.commitId,
    headRef: record.headRef,
    baseRef: record.baseRef,
    phase: record.phase,
    ...(record.activeIntentId === undefined ? {} : { activeIntentId: record.activeIntentId }),
    ...(record.push === undefined ? {} : {
      push: { intentId: record.push.intentId, confirmedAt: record.push.confirmedAt },
    }),
    ...(record.acceptance === undefined ? {} : {
      acceptance: {
        intentId: record.acceptance.intentId,
        actor: structuredClone(record.acceptance.actor),
        acceptedAt: record.acceptance.acceptedAt,
        evidenceDigest: record.acceptance.evidence.digest,
      },
    }),
    ...(record.repair === undefined ? {} : { repair: structuredClone(record.repair) }),
    lastIntentId: record.lastIntentId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function observationTime(fact: unknown): number {
  if (typeof fact !== 'object' || fact === null || !('observedAt' in fact)
    || typeof fact.observedAt !== 'number') throw new Error('targeted GitHub fact lacks observedAt')
  return fact.observedAt
}

async function readGitHub<T>(read: () => Promise<T>): Promise<DeliveryRead<T>> {
  try {
    return { ok: true, fact: await read() }
  } catch (error) {
    return { ok: false, failure: providerFailure(error) }
  }
}

function remoteRefMatches(delivery: BranchDeliveryRecord): (fact: GitHubBranchHeadFact) => boolean {
  return fact => fact.state === 'present'
    && fact.repositoryId === delivery.target.repository.id
    && fact.branch === branchName(delivery.headRef)
    && fact.commitId === delivery.commitId
}

function ciMatches(delivery: BranchDeliveryRecord): (fact: GitHubCommitCiFact) => boolean {
  return fact => fact.repositoryId === delivery.target.repository.id && fact.commitId === delivery.commitId
}

function reviewsMatchDelivery(
  fact: GitHubPullRequestReviewsFact,
  delivery: BranchDeliveryRecord,
  pullRequest: GitHubPullRequestFact | undefined,
): boolean {
  return reviewsTargetDelivery(fact, delivery, pullRequest)
    && fact.pullRequestUpdatedAt === pullRequest?.updatedAt
}

function reviewsTargetDelivery(
  fact: GitHubPullRequestReviewsFact,
  delivery: BranchDeliveryRecord,
  pullRequest: GitHubPullRequestFact | undefined,
): boolean {
  return pullRequest !== undefined
    && pullRequestMatchesDelivery(pullRequest, delivery)
    && fact.repositoryId === delivery.target.repository.id
    && fact.pullRequestId === pullRequest.id
    && fact.pullRequestNumber === pullRequest.number
    && fact.headCommitId === delivery.commitId
}

function firstEvidenceFailure(
  reads: DeliveryEvidenceReads,
  includeCi: boolean,
): GitHubFailure | undefined {
  if (!reads.remoteRef.ok) return reads.remoteRef.failure
  if (reads.pullRequest !== undefined && !reads.pullRequest.ok) return reads.pullRequest.failure
  if (includeCi) {
    const ci = requireCiRead(reads)
    if (!ci.ok) return ci.failure
  }
  return undefined
}

function requireCiRead(reads: DeliveryEvidenceReads): DeliveryRead<GitHubCommitCiFact> {
  if (reads.ci === undefined) throw new Error('exact-Commit CI was not requested')
  return reads.ci
}

function requireReviewsRead(reads: DeliveryEvidenceReads): DeliveryRead<GitHubPullRequestReviewsFact> {
  if (reads.reviews === undefined) throw new Error('exact-Pull-Request reviews were not requested')
  return reads.reviews
}

function confirmedObservation<T extends { readonly observedAt: number }>(
  fact: T,
): BranchDeliverySourceObservation<T> {
  return {
    confirmed: { fact: structuredClone(fact), confirmedAt: Math.max(Date.now(), fact.observedAt) },
    current: { state: 'confirmed', observedAt: fact.observedAt },
  }
}

function childCheckpointMatchesIntent(
  record: BranchDeliveryIntentRecord,
  checkpoint: BranchDeliveryChildCheckpoint,
): boolean {
  const intent = record.payload.intent
  if (intent.type !== 'mark-branch-delivery-in-review' && intent.type !== 'accept-branch-delivery') return false
  const targetStatus = intent.type === 'accept-branch-delivery' ? 'done' : 'in-review'
  return checkpoint.move.targetStatus === targetStatus
    && checkpoint.move.intentId === childMoveIntentId(record.id, targetStatus)
    && checkpoint.move.expectedRemoteFingerprint === intent.expectedWorkItemRemoteFingerprint
    && (intent.type === 'accept-branch-delivery') === (checkpoint.evidence.ci !== undefined)
}

function transitionEvidenceDigestMatches(evidence: z.infer<typeof transitionEvidenceSchema>): boolean {
  const material = {
    localCommitObservedAt: evidence.localCommitObservedAt,
    remoteRef: evidence.remoteRef,
    pullRequest: evidence.pullRequest,
    ...(evidence.ci === undefined ? {} : { ci: evidence.ci }),
  }
  return evidence.digest === canonicalDigest('saki/branch-delivery/transition-evidence/v1', material)
}

function acceptanceMatchesDelivery(
  evidence: z.infer<typeof acceptanceEvidenceSchema>,
  delivery: BranchDeliveryRecord,
): boolean {
  return transitionEvidenceDigestMatches(evidence)
    && remoteRefMatches(delivery)(evidence.remoteRef)
    && pullRequestMatchesDelivery(evidence.pullRequest, delivery)
    && ciMatches(delivery)(evidence.ci)
    && summarizeCommitCi(evidence.ci).state === 'successful'
}

function childMoveIntentId(
  parentIntentId: SakiControlIntentId,
  targetStatus: 'in-review' | 'done',
): SakiControlIntentId {
  const value = canonicalDigest('saki/branch-delivery/child-move-intent/v1', {
    parentIntentId,
    targetStatus,
  })
  return sakiControlIntentIdSchema.parse(
    `intent-${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`,
  )
}

function contextMatchesExpectation(
  context: BranchDeliveryCurrentContext,
  expected: BranchDeliveryExpectation,
): boolean {
  return context.registryRevision === expected.registryRevision
    && context.projectRevision === expected.projectRevision
    && context.binding.id === expected.binding.id
    && context.binding.revision === expected.binding.revision
    && context.synchronizationRevision === expected.synchronizationRevision
    && context.mappingRevision === expected.mappingRevision
    && context.workItem.remoteFingerprint === expected.workItemRemoteFingerprint
}

function contextMatchesDelivery(
  context: BranchDeliveryCurrentContext,
  delivery: BranchDeliveryRecord,
): boolean {
  return context.registryRevision === delivery.target.registryRevision
    && context.projectRevision === delivery.target.projectRevision
    && isDeepStrictEqual(context.binding, delivery.target.binding)
    && context.synchronizationRevision === delivery.target.synchronizationRevision
    && context.mappingRevision === delivery.target.mappingRevision
    && context.installation.appId === delivery.target.installation.appId
    && context.installation.installationId === delivery.target.installation.installationId
    && context.installation.accountId === delivery.target.installation.accountId
    && context.installation.privateKeyRef === delivery.target.installation.privateKeyRef
    && isDeepStrictEqual(context.repository, delivery.target.repository)
    && isDeepStrictEqual(context.workItem, delivery.target.workItem)
}

function deliveryMatchesSave(
  delivery: BranchDeliveryRecord,
  intent: BranchDeliverySaveIntent,
  context: BranchDeliveryCurrentContext,
): boolean {
  const expectedRevision = intent.expected.deliveryRevision === null ? 0 : intent.expected.deliveryRevision + 1
  return delivery.revision === expectedRevision
    && delivery.projectId === intent.projectId
    && delivery.workItemId === intent.workItemId
    && delivery.commitId === intent.commitId
    && delivery.headRef === intent.headRef
    && delivery.baseRef === intent.baseRef
    && isDeepStrictEqual(delivery.target, context)
}

function intentMatchesDelivery(
  record: BranchDeliveryIntentRecord,
  delivery: BranchDeliveryRecord,
): boolean {
  if (record.deliveryId !== delivery.id) return false
  switch (record.operation.kind) {
    case 'save':
      return record.payload.intent.type === 'save-branch-delivery'
        && delivery.projectId === record.payload.intent.projectId
        && delivery.workItemId === record.payload.intent.workItemId
        && delivery.commitId === record.payload.intent.commitId
        && delivery.headRef === record.payload.intent.headRef
        && delivery.baseRef === record.payload.intent.baseRef
    /* jscpd:ignore-start -- aggregate recovery and installation maintenance independently validate persisted Push associations */
    case 'push': {
      const request = record.operation.request
      return isDeepStrictEqual(request.expected.binding, delivery.target.binding)
        && request.expected.commitId === delivery.commitId
        && request.expected.repository.nameWithOwner === delivery.target.repository.nameWithOwner
        && request.targetRef === delivery.headRef
    }
    /* jscpd:ignore-end */
    case 'pull-request-create': {
      const request = record.operation.request
      const intent = record.payload.intent
      if (intent.type !== 'create-branch-delivery-pull-request') return false
      const { inspectionHint: ignoredInspectionHint, ...requestWithoutInspectionHint } = request
      void ignoredInspectionHint
      return isDeepStrictEqual(requestWithoutInspectionHint, pullRequestCreateRequest(delivery, intent))
    }
    case 'pull-request-associate': {
      const intent = record.payload.intent
      if (intent.type !== 'associate-branch-delivery-pull-request') return false
      if (delivery.lastIntentId !== record.id) return true
      if (delivery.pullRequest.confirmed?.fact.id === intent.pullRequestId
        && delivery.pullRequest.confirmed.fact.number === intent.pullRequestNumber) return true
      const checkpoint = record.checkpoint
      return delivery.activeIntentId === undefined && (checkpoint.state === 'active'
        || (checkpoint.state === 'terminal'
          && (checkpoint.outcome === 'conflict' || checkpoint.outcome === 'denied'
            || checkpoint.outcome === 'failure')))
    }
    case 'in-review':
    case 'accept': {
      const checkpoint = record.checkpoint
      const intent = record.payload.intent
      if (intent.type !== 'mark-branch-delivery-in-review' && intent.type !== 'accept-branch-delivery') return false
      if (delivery.activeIntentId === record.id
        && intent.expectedWorkItemRemoteFingerprint !== delivery.target.workItem.remoteFingerprint) return false
      if (record.operation.kind === 'accept' && delivery.acceptance?.intentId === record.id
        && !isDeepStrictEqual(delivery.acceptance.actor, record.payload.actor)) return false
      return checkpoint.state !== 'child-pending' || (checkpoint.move.projectId === delivery.projectId
        && checkpoint.move.workItemId === delivery.workItemId
        && remoteRefMatches(delivery)(checkpoint.evidence.remoteRef)
        && pullRequestMatchesDelivery(checkpoint.evidence.pullRequest, delivery)
        && (checkpoint.evidence.ci === undefined || ciMatches(delivery)(checkpoint.evidence.ci)))
    }
    default: return assertNever(record.operation)
  }
}

function acceptanceCheckpointValid(record: BranchDeliveryIntentRecord): boolean {
  const checkpoint = record.checkpoint
  return (checkpoint.state === 'child-pending' && checkpoint.move.targetStatus === 'done')
    || (checkpoint.state === 'terminal' && (checkpoint.outcome === 'succeeded'
      || (checkpoint.outcome === 'reconciliation-required' && checkpoint.reason === 'child-transition')))
}

function repairCheckpointValid(record: BranchDeliveryIntentRecord, delivery: BranchDeliveryRecord): boolean {
  const repair = delivery.repair
  if (record.operation.kind === 'save' || record.operation.kind === 'pull-request-associate'
    || repair === undefined || record.deliveryId !== delivery.id || delivery.activeIntentId !== undefined
    || delivery.lastIntentId !== record.id) return false
  const checkpoint = record.checkpoint
  const transition = record.operation.kind === 'in-review' || record.operation.kind === 'accept'
  if (transition && repair.reason !== 'evidence-conflict') return false
  if (record.operation.kind === 'push' && repair.reason === 'marker-ambiguous') return false
  if (checkpoint.state === 'terminal') {
    return checkpoint.outcome === 'reconciliation-required'
      && checkpoint.reason === (transition ? 'child-transition' : repair.reason)
      && (checkpoint.host === undefined || (checkpoint.host.snapshot.state === 'reconciliation-required'
        && checkpoint.host.snapshot.reason === repair.reason))
  }
  if (record.payload.intent.type === 'save-branch-delivery' || checkpoint.state === 'prepared'
    || delivery.revision !== checkpoint.deliveryRevision + 1) return false
  switch (record.operation.kind) {
    case 'push': return checkpoint.state === 'push-host-accepted'
      || (checkpoint.state === 'active' && repair.reason === 'evidence-conflict')
    case 'pull-request-create': return checkpoint.state === 'active'
      || checkpoint.state === 'pull-request-effect-possible'
    case 'in-review':
    case 'accept': return checkpoint.state === 'child-pending'
    default: return assertNever(record.operation)
  }
}

function intentOperation(
  intent: Exclude<BranchDeliveryIntent, BranchDeliverySaveIntent>,
  delivery: BranchDeliveryRecord,
  payloadDigest: string,
): BranchDeliveryIntentOperation {
  switch (intent.type) {
    case 'push-branch-delivery':
      return {
        kind: 'push',
        request: pushBranchHostOperationRequestSchema.parse({
          type: 'push-branch',
          source: { kind: 'control-intent', intentId: intent.intentId, intentRevision: 0, payloadDigest },
          expected: {
            binding: delivery.target.binding,
            commitId: delivery.commitId,
            repository: { nameWithOwner: delivery.target.repository.nameWithOwner },
          },
          targetRef: delivery.headRef,
        }),
      }
    case 'create-branch-delivery-pull-request':
      return { kind: 'pull-request-create', request: pullRequestCreateRequest(delivery, intent) }
    case 'associate-branch-delivery-pull-request': return { kind: 'pull-request-associate' }
    case 'mark-branch-delivery-in-review': return { kind: 'in-review' }
    case 'accept-branch-delivery': return { kind: 'accept' }
    default: return assertNever(intent)
  }
}

function operationKind(type: BranchDeliveryIntent['type']): BranchDeliveryIntentOperation['kind'] {
  switch (type) {
    case 'save-branch-delivery': return 'save'
    case 'push-branch-delivery': return 'push'
    case 'create-branch-delivery-pull-request': return 'pull-request-create'
    case 'associate-branch-delivery-pull-request': return 'pull-request-associate'
    case 'mark-branch-delivery-in-review': return 'in-review'
    case 'accept-branch-delivery': return 'accept'
    default: return assertNever(type)
  }
}

function checkpointAllowed(
  operation: BranchDeliveryIntentOperation['kind'],
  checkpoint: Exclude<BranchDeliveryIntentCheckpoint['state'], 'prepared' | 'terminal'>,
): boolean {
  switch (checkpoint) {
    case 'active': return operation !== 'save'
    case 'push-host-accepted': return operation === 'push'
    case 'pull-request-effect-possible': return operation === 'pull-request-create'
    case 'child-pending': return operation === 'in-review' || operation === 'accept'
    default: return assertNever(checkpoint)
  }
}

function terminalIntent(record: BranchDeliveryIntentRecord): boolean {
  return record.checkpoint.state === 'terminal'
}

function activeDeliveryRevision(record: BranchDeliveryIntentRecord): number {
  if (record.checkpoint.state === 'prepared' || record.checkpoint.state === 'terminal') {
    throw new Error(`Branch Delivery Intent '${record.id}' has no active Delivery revision`)
  }
  return record.checkpoint.deliveryRevision
}

function checkpointDeliveryRevision(record: BranchDeliveryIntentRecord): number | undefined {
  return record.checkpoint.state === 'prepared' ? undefined : record.checkpoint.deliveryRevision
}

function hostPreparation(record: BranchDeliveryIntentRecord): HostOperationPreparation<'push-branch'> | undefined {
  const checkpoint = record.checkpoint
  if (checkpoint.state === 'push-host-accepted') {
    return checkpoint.preparation as HostOperationPreparation<'push-branch'>
  }
  if (checkpoint.state === 'terminal' && checkpoint.host !== undefined) {
    return checkpoint.host.preparation as HostOperationPreparation<'push-branch'>
  }
  return undefined
}

function requireHostPreparation(record: BranchDeliveryIntentRecord): HostOperationPreparation<'push-branch'> {
  const preparation = hostPreparation(record)
  if (preparation === undefined) throw new Error(`Branch Delivery Intent '${record.id}' lacks Host preparation`)
  return preparation
}

function requireTerminalCheckpoint(record: BranchDeliveryIntentRecord): BranchDeliveryTerminalCheckpoint {
  if (record.checkpoint.state !== 'terminal') {
    throw new Error(`Branch Delivery Intent '${record.id}' is not terminal`)
  }
  return record.checkpoint
}

function requirePushRequest(record: BranchDeliveryIntentRecord): PushBranchHostOperationRequest {
  if (record.operation.kind !== 'push') {
    throw new Error(`Branch Delivery Intent '${record.id}' lacks its Push request`)
  }
  return record.operation.request
}

function admissionMatchesCheckpoint(
  admission: PushWriteAdmissionRecord,
  record: BranchDeliveryIntentRecord,
): boolean {
  const checkpoint = record.checkpoint
  if (admission.phase === 'reserved') {
    return checkpoint.state === 'active'
      || (checkpoint.state === 'terminal' && checkpoint.outcome === 'reconciliation-required'
        && checkpoint.host === undefined)
  }
  if (checkpoint.state === 'active') return true
  if (checkpoint.state === 'push-host-accepted'
    && admission.revision !== checkpoint.admissionRevision) return false
  const preparation = hostPreparation(record)
  return preparation !== undefined
    && isDeepStrictEqual(admission.preparation, preparation)
    && (checkpoint.state === 'push-host-accepted'
      || checkpoint.state === 'terminal')
}

function isPushAdmission(
  record: BindingWriteAdmissionRecord,
): record is PushWriteAdmissionRecord {
  return record.state === 'manual-host-operation'
    && (record as { readonly action: string }).action === 'project-branch:push'
}

function pushAdmissionMatches(
  admission: PushWriteAdmissionRecord,
  record: BranchDeliveryIntentRecord,
  request: PushBranchHostOperationRequest,
): boolean {
  return admission.id === request.expected.binding.id
    && admission.bindingRevision === request.expected.binding.revision
    && admission.source.intentId === record.id
    && admission.source.intentRevision === request.source.intentRevision
    && admission.source.payloadDigest === record.payloadDigest
    && isDeepStrictEqual(admission.source, request.source)
    && (admission.phase === 'reserved'
      || admission.preparation.operation.hostId === request.expected.binding.hostId)
}

function assertPushPreparation(
  record: BranchDeliveryIntentRecord,
  preparation: HostOperationPreparation,
  snapshot: HostOperationSnapshot,
): asserts preparation is HostOperationPreparation<'push-branch'> {
  if (preparation.operation.type !== 'push-branch'
    || snapshot.operation.type !== 'push-branch'
    || preparation.operation.id !== snapshot.operation.id
    || preparation.operation.hostId !== snapshot.operation.hostId
    || !isDeepStrictEqual(preparation.requestFingerprint, snapshot.requestFingerprint)) {
    throw new Error(`Push Host preparation disagrees with Branch Delivery Intent '${record.id}'`)
  }
  assertPushSnapshot(record, snapshot as HostOperationSnapshot<'push-branch'>)
}

function assertPushSnapshot(
  record: BranchDeliveryIntentRecord,
  snapshot: HostOperationSnapshot<'push-branch'>,
): void {
  const request = requirePushRequest(record)
  if (snapshot.operation.hostId !== request.expected.binding.hostId
    || snapshot.bindingId !== request.expected.binding.id
    || snapshot.bindingRevision !== request.expected.binding.revision
    || !isDeepStrictEqual(snapshot.source, request.source)) {
    throw new Error(`Push Host snapshot disagrees with Branch Delivery Intent '${record.id}'`)
  }
  const preparation = hostPreparation(record)
  if (preparation !== undefined
    && (preparation.operation.id !== snapshot.operation.id
      || !isDeepStrictEqual(preparation.requestFingerprint, snapshot.requestFingerprint))) {
    throw new Error(`Push Host snapshot changed preparation for Branch Delivery Intent '${record.id}'`)
  }
}

function assertPushResult(result: PushBranchHostOperationResult, delivery: BranchDeliveryRecord): void {
  if (!pushResultMatches(result, delivery)) {
    throw new Error('Push result disagrees with its exact Branch Delivery target')
  }
}

function pushResultMatches(result: PushBranchHostOperationResult, delivery: BranchDeliveryRecord): boolean {
  return result.commitId === delivery.commitId
    && result.targetRef === delivery.headRef
    && result.repository.nameWithOwner === delivery.target.repository.nameWithOwner
}

function hostEvidenceMatches(
  record: BranchDeliveryIntentRecord,
  host: NonNullable<BranchDeliveryTerminalCheckpoint['host']>,
): boolean {
  if (record.operation.kind !== 'push') return false
  const request = record.operation.request
  const { preparation, snapshot } = host
  return preparation.operation.type === 'push-branch'
    && terminalHostSnapshot(snapshot.state)
    && snapshot.operation.type === 'push-branch'
    && preparation.operation.id === snapshot.operation.id
    && preparation.operation.hostId === snapshot.operation.hostId
    && isDeepStrictEqual(preparation.requestFingerprint, snapshot.requestFingerprint)
    && snapshot.operation.hostId === request.expected.binding.hostId
    && snapshot.bindingId === request.expected.binding.id
    && snapshot.bindingRevision === request.expected.binding.revision
    && isDeepStrictEqual(snapshot.source, request.source)
    && (record.checkpoint.state !== 'terminal'
      || hostSnapshotMatchesOutcome(snapshot, record.checkpoint.outcome))
}

function hostSnapshotMatchesOutcome(
  snapshot: HostOperationSnapshot,
  outcome: BranchDeliveryTerminalCheckpoint['outcome'],
): boolean {
  if (outcome === 'succeeded') return snapshot.state === 'succeeded'
  if (outcome === 'reconciliation-required') return snapshot.state === 'reconciliation-required'
  if (outcome === 'denied') return snapshot.state === 'canceled' && snapshot.reason === 'authority-revoked'
  return outcome === 'failure' && (snapshot.state === 'failed' || snapshot.state === 'canceled')
}

function terminalHostSnapshot(state: HostOperationSnapshot<'push-branch'>['state']): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'canceled'
    || state === 'reconciliation-required'
}

function pullRequestCreateRequest(
  delivery: BranchDeliveryRecord,
  intent: BranchDeliveryCreatePullRequestIntent,
): GitHubPullRequestCreateRequest {
  const text = githubPullRequestCreateTextPreparationSchema.parse({
    markerId: delivery.markerId,
    title: intent.title,
    body: intent.body,
  })
  return githubPullRequestCreateRequestSchema.parse({
    kind: 'pull-request-create',
    operationId: githubExternalOperationId(`branch-delivery:${intent.intentId}:pull-request`),
    installation: delivery.target.installation,
    repositoryId: delivery.target.repository.id,
    repositoryDatabaseId: delivery.target.repository.databaseId,
    markerId: text.markerId,
    headRef: branchName(delivery.headRef),
    baseRef: branchName(delivery.baseRef),
    expectedHeadCommitId: delivery.commitId,
    title: text.title,
    body: text.body,
  })
}

function pullRequestMatchesDelivery(
  pullRequest: GitHubPullRequestFact,
  delivery: BranchDeliveryRecord,
): boolean {
  return pullRequest.repositoryId === delivery.target.repository.id
    && pullRequest.head.repositoryId === delivery.target.repository.id
    && pullRequest.base.repositoryId === delivery.target.repository.id
    && pullRequest.head.ref === branchName(delivery.headRef)
    && pullRequest.base.ref === branchName(delivery.baseRef)
    && pullRequest.head.commitId === delivery.commitId
    && (pullRequest.state === 'open' || pullRequest.merged)
}

function branchName(ref: string): string {
  return ref.slice('refs/heads/'.length)
}

function reconciliationReason(
  state: Exclude<
    GitHubPullRequestCreateInspection['snapshot']['outcome']['state'],
    'unique-pull-request' | 'absent-complete' | 'incomplete'
  >,
): 'evidence-conflict' | 'marker-ambiguous' {
  return state === 'multiple-matches' ? 'marker-ambiguous' : 'evidence-conflict'
}

function actionFor(type: Exclude<BranchDeliveryIntent['type'], 'save-branch-delivery'>): BranchDeliveryAction {
  switch (type) {
    case 'push-branch-delivery': return 'branch-delivery:push'
    case 'create-branch-delivery-pull-request': return 'branch-delivery:pull-request:create'
    case 'associate-branch-delivery-pull-request': return 'branch-delivery:pull-request:associate'
    case 'mark-branch-delivery-in-review': return 'branch-delivery:review'
    case 'accept-branch-delivery': return 'branch-delivery:accept'
    default: return assertNever(type)
  }
}

function providerFailure(error: unknown): GitHubFailure {
  if (error instanceof GitHubProviderError) return error.failure
  throw error
}

function tryProviderFailure(error: unknown): GitHubFailure | undefined {
  return error instanceof GitHubProviderError ? error.failure : undefined
}

function unavailableResult(record: BranchDeliveryIntentRecord): BranchDeliveryIntentResult {
  return {
    ok: false,
    reason: 'unavailable',
    receipt: {
      intentId: record.id,
      deliveryId: record.deliveryId,
      state: 'failure',
      ...(checkpointDeliveryRevision(record) === undefined
        ? {}
        : { deliveryRevision: checkpointDeliveryRevision(record) }),
    },
  }
}

function compareDeliveryOrder(left: BranchDeliveryRecord, right: BranchDeliveryRecord): number {
  return left.createdAt - right.createdAt || String(left.id).localeCompare(String(right.id))
}

function compareIntentOrder(left: BranchDeliveryIntentRecord, right: BranchDeliveryIntentRecord): number {
  return left.createdAt - right.createdAt || String(left.id).localeCompare(String(right.id))
}

function assertNever(value: never): never {
  throw new Error(`Unexpected Branch Delivery value: ${String(value)}`)
}

function pullRequestMarkerId(deliveryId: SakiBranchDeliveryId): GitHubPullRequestCreateMarkerId {
  return githubPullRequestCreateMarkerIdSchema.parse(
    `pull-request-marker-${canonicalDigest('saki/branch-delivery/pull-request-marker/v1', { deliveryId })}`,
  )
}

function resultFor(record: BranchDeliveryIntentRecord): BranchDeliveryIntentResult {
  const checkpoint = record.checkpoint
  const base = {
    intentId: record.id,
    deliveryId: record.deliveryId,
    ...(checkpointDeliveryRevision(record) === undefined
      ? {}
      : { deliveryRevision: checkpointDeliveryRevision(record) }),
  }
  if (checkpoint.state !== 'terminal') return { ok: true, receipt: { ...base, state: 'pending' } }
  if (checkpoint.outcome === 'succeeded') return { ok: true, receipt: { ...base, state: 'succeeded' } }
  if (checkpoint.outcome === 'reconciliation-required') {
    return { ok: false, reason: 'reconciliation-required', receipt: { ...base, state: checkpoint.outcome } }
  }
  if (checkpoint.outcome === 'denied') {
    return { ok: false, reason: 'denied', receipt: { ...base, state: checkpoint.outcome } }
  }
  if (checkpoint.outcome === 'failure') {
    return { ok: false, reason: 'unavailable', receipt: { ...base, state: checkpoint.outcome } }
  }
  return { ok: false, reason: 'conflict', receipt: { ...base, state: 'conflict' } }
}
