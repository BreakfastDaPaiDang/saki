/** Versioned Milestone phase metadata and atomic release evidence. */

import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  canonicalDigest,
  type SakiControlIntentId,
} from '@breakfastdapaidang/saki-execution'
import {
  githubCommitComparisonFactSchema,
  githubCommitFactSchema,
  githubCommitIdSchema,
  githubFailureSchema,
  githubIssueIdSchema,
  githubMilestoneFactSchema,
  githubMilestoneIdSchema,
  githubProjectIdSchema,
  githubReleaseByTagObservationSchema,
  githubReleaseTagNameSchema,
  githubRepositoryDatabaseIdSchema,
  githubRepositoryIdSchema,
  githubRepositoryNameWithOwnerSchema,
  githubTagPeelFactSchema,
  githubTagReferenceFactSchema,
  type GitHubMilestoneFact,
  type GitHubMilestoneId,
} from '@breakfastdapaidang/saki-github'
import { enqueueKeyedOperation } from './keyed-operation.ts'
import {
  controlIntentActorSchema,
  type ControlIntentActor,
} from './spec.ts'
import {
  sakiBoardWorkItemIdSchema,
  sakiControlIntentIdSchema,
  sakiDevelopmentProjectIdSchema,
} from './ids.ts'
import type {
  SakiDevelopmentProjectId,
} from './types.ts'
import type {
  ReleaseEvidencePolicyV1Blockage,
  ReleaseEvidencePolicyV1Evidence,
  ReleaseEvidencePolicyV1Expectation,
  ReleaseEvidencePolicyV1Snapshot,
  SakiTargetedEvidence,
} from './release-evidence-policy.ts'
import {
  evaluateReleaseEvidencePolicyV1,
  releaseEvidencePolicyV1EvidenceSchema,
} from './release-evidence-policy.ts'

const revision = z.number().int().nonnegative()
const timestamp = z.number().int().nonnegative()
const digest = z.string().regex(/^[0-9a-f]{64}$/u)

/** Stable identity of one Project's current record for one GitHub Milestone. */
export type SakiMilestoneDeliveryId = Branded<'SakiMilestoneDeliveryId'>

const milestoneDeliveryIdSchema = z.string()
  .regex(/^milestone-delivery-[0-9a-f]{64}$/u)
  .transform(value => value as SakiMilestoneDeliveryId)

const releaseExpectationSchema = z.object({
  repositoryId: githubRepositoryIdSchema,
  projectId: githubProjectIdSchema,
  milestoneId: githubMilestoneIdSchema,
  milestoneNumber: z.number().int().positive(),
  tagName: githubReleaseTagNameSchema,
  releaseCommitId: githubCommitIdSchema,
  upstreamRepositoryId: githubRepositoryIdSchema,
  upstreamRepositoryDatabaseId: githubRepositoryDatabaseIdSchema,
  upstreamRepositoryNameWithOwner: githubRepositoryNameWithOwnerSchema,
  upstreamCommitId: githubCommitIdSchema,
}).strict() satisfies z.ZodType<ReleaseEvidencePolicyV1Expectation>

/* jscpd:ignore-start -- durable Release Evidence and its browser projection validate the closed blockage union independently */
const releaseEvidenceBlockageSchema: z.ZodType<ReleaseEvidencePolicyV1Blockage> = z.union([
  z.object({
    kind: z.enum(['source-unavailable', 'source-failed', 'source-stale', 'source-invalidated']),
    pass: z.enum(['evaluation', 'final-reread']),
    source: z.string().min(1).max(512),
  }).strict(),
  z.object({
    kind: z.enum([
      'milestone-target-mismatch',
      'milestone-closed',
      'scope-empty',
      'tag-mismatch',
      'release-mismatch',
      'release-commit-mismatch',
      'upstream-commit-mismatch',
      'upstream-ancestry-mismatch',
      'final-reread-mismatch',
    ]),
  }).strict(),
  z.object({ kind: z.literal('scope-unmapped'), issueId: githubIssueIdSchema }).strict(),
  z.object({
    kind: z.enum([
      'work-item-nonterminal',
      'delivery-duplicate',
      'delivery-not-accepted',
      'delivery-pr-mismatch',
      'delivery-ci-not-successful',
      'delivery-ancestry-mismatch',
    ]),
    workItemId: sakiBoardWorkItemIdSchema,
  }).strict(),
])
/* jscpd:ignore-end */

function targetedEvidenceSchema<T extends z.ZodType>(value: T) {
  return z.object({
    confirmed: z.object({ value, observedAt: timestamp }).strict().optional(),
    failure: z.object({ failure: githubFailureSchema, failedAt: timestamp }).strict().optional(),
    invalidatedAt: timestamp.optional(),
  }).strict()
}

const milestoneDeliverySourcesSchema = z.object({
  revision,
  milestone: targetedEvidenceSchema(githubMilestoneFactSchema),
  tag: targetedEvidenceSchema(z.object({
    reference: githubTagReferenceFactSchema,
    peel: githubTagPeelFactSchema,
  }).strict()),
  release: targetedEvidenceSchema(githubReleaseByTagObservationSchema),
  releaseCommit: targetedEvidenceSchema(githubCommitFactSchema),
  upstreamCommit: targetedEvidenceSchema(githubCommitFactSchema),
  upstreamAncestry: targetedEvidenceSchema(githubCommitComparisonFactSchema),
  updatedAt: timestamp,
}).strict()

/** Durable targeted facts owned by one Milestone Delivery without changing its metadata revision. */
export type MilestoneDeliverySources = z.infer<typeof milestoneDeliverySourcesSchema>

/** Mutable pre-release phases owned by Saki. */
export type MilestoneDeliveryPhase = 'planned' | 'in-progress' | 'ready-to-release' | 'canceled'

/** Create or revise pre-release metadata at an exact record and Project revision. */
export interface SaveMilestoneDeliveryIntent {
  readonly type: 'save-milestone-delivery'
  readonly intentId: SakiControlIntentId
  readonly projectId: SakiDevelopmentProjectId
  readonly expectedDeliveryRevision: number | null
  readonly expectedRegistryRevision: number
  readonly expectedProjectRevision: number
  readonly phase: MilestoneDeliveryPhase
  readonly release: ReleaseEvidencePolicyV1Expectation
}

/** Finalize immutable release evidence for an exact metadata revision. */
export interface FinalizeMilestoneDeliveryIntent {
  readonly type: 'finalize-milestone-delivery'
  readonly intentId: SakiControlIntentId
  readonly deliveryId: SakiMilestoneDeliveryId
  readonly expectedDeliveryRevision: number
  readonly release: ReleaseEvidencePolicyV1Expectation
}

/** Concrete Milestone Delivery Intents supported by version 0.1.0. */
export type MilestoneDeliveryIntent = SaveMilestoneDeliveryIntent | FinalizeMilestoneDeliveryIntent

const saveIntentSchema = z.object({
  type: z.literal('save-milestone-delivery'),
  intentId: sakiControlIntentIdSchema,
  projectId: sakiDevelopmentProjectIdSchema,
  expectedDeliveryRevision: revision.nullable(),
  expectedRegistryRevision: revision,
  expectedProjectRevision: revision,
  phase: z.enum(['planned', 'in-progress', 'ready-to-release', 'canceled']),
  release: releaseExpectationSchema,
}).strict() satisfies z.ZodType<SaveMilestoneDeliveryIntent>

const finalizeIntentSchema = z.object({
  type: z.literal('finalize-milestone-delivery'),
  intentId: sakiControlIntentIdSchema,
  deliveryId: milestoneDeliveryIdSchema,
  expectedDeliveryRevision: revision,
  release: releaseExpectationSchema,
}).strict() satisfies z.ZodType<FinalizeMilestoneDeliveryIntent>

/** Strict browser-safe Milestone Delivery Intent schema. */
export const milestoneDeliveryIntentSchema: z.ZodType<MilestoneDeliveryIntent> = z.discriminatedUnion('type', [
  saveIntentSchema,
  finalizeIntentSchema,
])

const milestoneDeliveryRecordObjectSchema = z.object({
  id: milestoneDeliveryIdSchema,
  schemaVersion: z.literal(1),
  revision,
  projectId: sakiDevelopmentProjectIdSchema,
  registryRevision: revision,
  projectRevision: revision,
  phase: z.enum(['planned', 'in-progress', 'ready-to-release', 'canceled']),
  release: releaseExpectationSchema,
  sources: milestoneDeliverySourcesSchema,
  releaseEvidence: z.object({
    intentId: sakiControlIntentIdSchema,
    actor: controlIntentActorSchema,
    priorMetadataRevision: revision,
    evidence: releaseEvidencePolicyV1EvidenceSchema,
    embeddedAt: timestamp,
  }).strict().optional(),
  repair: z.object({
    intentId: sakiControlIntentIdSchema,
    priorRevision: revision,
    reason: z.enum(['external-milestone-closed', 'concurrent-github-change']),
    blockages: z.array(releaseEvidenceBlockageSchema).min(1).max(10_000),
    recordedAt: timestamp,
  }).strict().optional(),
  lastIntentId: sakiControlIntentIdSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict()

/** Durable Saki-owned Milestone phase record. */
export type MilestoneDeliveryRecord = z.infer<typeof milestoneDeliveryRecordObjectSchema>

/** Strict schema for one current Milestone Delivery record. */
export const milestoneDeliveryRecordSchema: z.ZodType<MilestoneDeliveryRecord> =
  milestoneDeliveryRecordObjectSchema.superRefine((record, context) => {
    if (record.updatedAt < record.createdAt) {
      context.addIssue({ code: 'custom', message: 'Milestone Delivery timestamps are not monotonic' })
    }
    if (record.id !== milestoneDeliveryId(record.projectId, record.release.milestoneId)) {
      context.addIssue({ code: 'custom', message: 'Milestone Delivery id disagrees with its target' })
    }
    if (record.sources.updatedAt > record.updatedAt) {
      context.addIssue({ code: 'custom', message: 'Milestone Delivery sources postdate their aggregate' })
    }
    if (!milestoneSourcesMatchExpectation(record.sources, record.release)) {
      context.addIssue({ code: 'custom', message: 'Milestone Delivery source target disagrees' })
    }
    if (record.releaseEvidence !== undefined
      && (record.phase !== 'ready-to-release'
        || record.releaseEvidence.intentId !== record.lastIntentId
        || record.releaseEvidence.priorMetadataRevision + 1 !== record.revision
        || record.repair !== undefined)) {
      context.addIssue({ code: 'custom', message: 'Milestone Delivery release evidence is not an atomic finalization' })
    }
    if (record.releaseEvidence !== undefined
      && (record.releaseEvidence.embeddedAt !== record.releaseEvidence.evidence.confirmedAt
        || !releaseEvidenceMatchesExpectation(record.releaseEvidence.evidence, record.release))) {
      context.addIssue({ code: 'custom', message: 'Milestone Delivery release target disagrees with its evidence' })
    }
    if (record.repair !== undefined
      && (record.repair.intentId !== record.lastIntentId || record.repair.priorRevision + 1 !== record.revision)) {
      context.addIssue({ code: 'custom', message: 'Milestone Delivery repair is not an atomic observation' })
    }
  })

function releaseEvidenceMatchesExpectation(
  evidence: ReleaseEvidencePolicyV1Evidence,
  expectation: ReleaseEvidencePolicyV1Expectation,
): boolean {
  return isDeepStrictEqual({
    repositoryId: evidence.milestone.repositoryId,
    projectId: evidence.projectId,
    milestoneId: evidence.milestoneId,
    milestoneNumber: evidence.milestoneNumber,
    tagName: evidence.release.tagName,
    releaseCommitId: evidence.releaseCommit.id,
    upstreamRepositoryId: evidence.upstreamRepositoryId,
    upstreamRepositoryDatabaseId: evidence.upstreamRepositoryDatabaseId,
    upstreamRepositoryNameWithOwner: evidence.upstreamRepositoryNameWithOwner,
    upstreamCommitId: evidence.upstreamCommit.id,
  }, {
    repositoryId: expectation.repositoryId,
    projectId: expectation.projectId,
    milestoneId: expectation.milestoneId,
    milestoneNumber: expectation.milestoneNumber,
    tagName: expectation.tagName,
    releaseCommitId: expectation.releaseCommitId,
    upstreamRepositoryId: expectation.upstreamRepositoryId,
    upstreamRepositoryDatabaseId: expectation.upstreamRepositoryDatabaseId,
    upstreamRepositoryNameWithOwner: expectation.upstreamRepositoryNameWithOwner,
    upstreamCommitId: expectation.upstreamCommitId,
  })
}

function milestoneSourcesMatchExpectation(
  sources: MilestoneDeliverySources,
  expectation: ReleaseEvidencePolicyV1Expectation,
): boolean {
  const milestone = sources.milestone.confirmed?.value
  if (milestone !== undefined && (milestone.repositoryId !== expectation.repositoryId
    || milestone.id !== expectation.milestoneId || milestone.number !== expectation.milestoneNumber)) return false
  const tag = sources.tag.confirmed?.value
  if (tag !== undefined && (tag.reference.repositoryId !== expectation.repositoryId
    || tag.reference.tagName !== expectation.tagName
    || tag.reference.ref !== `refs/tags/${expectation.tagName}`
    || tag.peel.repositoryId !== expectation.repositoryId)) return false
  const release = sources.release.confirmed?.value
  if (release !== undefined) {
    const target = release.kind === 'present' ? release.release : release
    if (target.repositoryId !== expectation.repositoryId || target.tagName !== expectation.tagName) return false
  }
  const releaseCommit = sources.releaseCommit.confirmed?.value
  if (releaseCommit !== undefined && (releaseCommit.repositoryId !== expectation.repositoryId
    || releaseCommit.id !== expectation.releaseCommitId)) return false
  const upstreamCommit = sources.upstreamCommit.confirmed?.value
  if (upstreamCommit !== undefined && (upstreamCommit.repositoryId !== expectation.upstreamRepositoryId
    || upstreamCommit.id !== expectation.upstreamCommitId)) return false
  const upstreamAncestry = sources.upstreamAncestry.confirmed?.value
  return upstreamAncestry === undefined
    || (upstreamAncestry.repositoryId === expectation.repositoryId
      && upstreamAncestry.baseCommitId === expectation.upstreamCommitId
      && upstreamAncestry.headCommitId === expectation.releaseCommitId)
}

const intentRecordSchema = z.object({
  id: sakiControlIntentIdSchema,
  schemaVersion: z.literal(1),
  revision,
  payloadDigest: digest,
  payload: z.object({
    intent: milestoneDeliveryIntentSchema,
    actor: controlIntentActorSchema,
  }).strict(),
  deliveryId: milestoneDeliveryIdSchema,
  phase: z.enum([
    'prepared',
    'succeeded',
    'conflict',
    'denied',
    'unavailable',
    'blocked',
    'reconciliation-required',
  ]),
  resultDeliveryRevision: revision.optional(),
  blockages: z.array(releaseEvidenceBlockageSchema).min(1).max(10_000).optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict()

/** Durable Milestone Delivery Intent record. */
export type MilestoneDeliveryIntentRecord = z.infer<typeof intentRecordSchema>

/** Strict schema for one durable Milestone Delivery Intent. */
export const milestoneDeliveryIntentRecordSchema: z.ZodType<MilestoneDeliveryIntentRecord> = intentRecordSchema
  .superRefine((record, context) => {
    if (record.id !== record.payload.intent.intentId || record.updatedAt < record.createdAt) {
      context.addIssue({ code: 'custom', message: 'Milestone Delivery Intent identity or timestamps are invalid' })
    }
    if ((record.phase === 'succeeded' || record.phase === 'reconciliation-required')
      !== (record.resultDeliveryRevision !== undefined)) {
      context.addIssue({ code: 'custom', message: 'Milestone Delivery Intent result disagrees with its phase' })
    }
    if ((record.phase === 'blocked' || record.phase === 'reconciliation-required')
      !== (record.blockages !== undefined)) {
      context.addIssue({ code: 'custom', message: 'Milestone Delivery Intent blockages disagree with its phase' })
    }
    if (record.payloadDigest !== canonicalDigest('saki/milestone-delivery-intent/v1', record.payload)) {
      context.addIssue({ code: 'custom', message: 'Milestone Delivery Intent payload digest is invalid' })
    }
  })

/** Durable current Milestone Delivery table. */
export type MilestoneDeliveryTable = KvTable<SakiMilestoneDeliveryId, MilestoneDeliveryRecord>
/** Durable Milestone Delivery Intent table. */
export type MilestoneDeliveryIntentTable = KvTable<SakiControlIntentId, MilestoneDeliveryIntentRecord>

/** Current Project identities that fence Milestone metadata admission. */
export interface MilestoneDeliveryCurrentContext {
  readonly registryRevision: number
  readonly projectRevision: number
  readonly repositoryId: ReleaseEvidencePolicyV1Expectation['repositoryId']
  readonly projectId: ReleaseEvidencePolicyV1Expectation['projectId']
}

/** Result of resolving one current Development Project. */
export type MilestoneDeliveryContextResult =
  | { readonly ok: true; readonly context: MilestoneDeliveryCurrentContext }
  | { readonly ok: false; readonly reason: 'not-found' | 'unavailable' }

/** Fixed authority actions used by Milestone Delivery. */
export type MilestoneDeliveryAction = 'milestone-delivery:save' | 'milestone-delivery:finalize'

/** Dependencies supplied by current Project and targeted-read owners. */
export interface MilestoneDeliveryOperationsOptions {
  readonly deliveryTable: MilestoneDeliveryTable
  readonly intentTable: MilestoneDeliveryIntentTable
  readonly projectExists: (projectId: SakiDevelopmentProjectId) => boolean
  readonly resolveContext: (projectId: SakiDevelopmentProjectId) => MilestoneDeliveryContextResult
  readonly readReleaseSnapshot: (
    developmentProjectId: SakiDevelopmentProjectId,
    expectation: ReleaseEvidencePolicyV1Expectation,
    pass: 'view' | 'evaluation' | 'final-reread',
    signal: AbortSignal,
  ) => Promise<ReleaseEvidencePolicyV1Snapshot>
  readonly authorityCurrent: (actor: ControlIntentActor, action: MilestoneDeliveryAction) => boolean
  readonly validateActorReference: (actor: ControlIntentActor) => void
  readonly maxObservationAgeMs: number
  readonly notifyChanged: () => void
}

/** Stable browser-safe result for one Milestone Delivery Intent attempt. */
export type MilestoneDeliveryIntentResult =
  | {
    readonly ok: true
    readonly receipt: {
      readonly intentId: SakiControlIntentId
      readonly deliveryId: SakiMilestoneDeliveryId
      readonly state: 'pending' | 'succeeded'
      readonly deliveryRevision?: number | undefined
    }
  }
  | {
    readonly ok: false
    readonly reason: 'denied' | 'conflict' | 'unavailable' | 'reconciliation-required'
    readonly blockages?: readonly ReleaseEvidencePolicyV1Blockage[] | undefined
    readonly receipt?: {
      readonly intentId: SakiControlIntentId
      readonly deliveryId: SakiMilestoneDeliveryId
      readonly state: 'conflict' | 'denied' | 'blocked' | 'reconciliation-required'
      readonly deliveryRevision?: number | undefined
    }
  }

/** Result of retaining one fresh set of Milestone View source observations. */
export type MilestoneDeliveryRefreshResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'not-found' | 'conflict' }

/**
 * Derive the unique current record identity for one Project and GitHub Milestone.
 * @param projectId - owning Development Project identity.
 * @param milestoneId - configured GitHub Milestone identity.
 * @returns stable identity derived from the Project and Milestone pair.
 */
export function milestoneDeliveryId(
  projectId: SakiDevelopmentProjectId,
  milestoneId: GitHubMilestoneId,
): SakiMilestoneDeliveryId {
  return milestoneDeliveryIdSchema.parse(`milestone-delivery-${canonicalDigest('saki/milestone-delivery/id/v1', {
    projectId,
    milestoneId,
  })}`)
}

/** Browser-safe Saki phase and repair state derived from one durable record. */
export interface MilestoneDeliveryProjection {
  readonly id: SakiMilestoneDeliveryId
  readonly revision: number
  readonly phase: MilestoneDeliveryPhase | 'released'
  readonly release: ReleaseEvidencePolicyV1Expectation
  readonly releaseEvidence?: MilestoneDeliveryRecord['releaseEvidence'] | undefined
  readonly repair?: {
    readonly reason: 'external-milestone-closed' | 'concurrent-github-change'
    readonly source: 'record' | 'current-milestone'
    readonly observedAt: number
    readonly intentId?: SakiControlIntentId | undefined
    readonly blockages: readonly ReleaseEvidencePolicyV1Blockage[]
  } | undefined
}

/** Fully parsed Milestone Delivery state in deterministic restart order. */
export interface ValidatedMilestoneDeliveryState {
  readonly deliveries: readonly MilestoneDeliveryRecord[]
  readonly intents: readonly MilestoneDeliveryIntentRecord[]
}

type ReadonlyTable<K extends string, V> = Pick<KvTable<K, V>, 'entries' | 'get' | 'size'>

/**
 * Derive Released and external-closure repair without mutating immutable evidence.
 * @param value - current durable Milestone Delivery record.
 * @param milestone - current targeted Milestone evidence, including newer failure state.
 * @returns Saki-owned phase, release fact, and actionable repair state.
 */
export function projectMilestoneDelivery(
  value: MilestoneDeliveryRecord,
  milestone: SakiTargetedEvidence<GitHubMilestoneFact>,
): MilestoneDeliveryProjection {
  const record = milestoneDeliveryRecordSchema.parse(value)
  if (record.releaseEvidence !== undefined) {
    return {
      id: record.id,
      revision: record.revision,
      phase: 'released',
      release: record.release,
      releaseEvidence: record.releaseEvidence,
    }
  }
  if (record.repair !== undefined) {
    return {
      id: record.id,
      revision: record.revision,
      phase: record.phase,
      release: record.release,
      repair: {
        reason: record.repair.reason,
        source: 'record',
        observedAt: record.repair.recordedAt,
        intentId: record.repair.intentId,
        blockages: structuredClone(record.repair.blockages),
      },
    }
  }
  const confirmed = milestone.confirmed
  const current = confirmed !== undefined
    && !(milestone.failure !== undefined && milestone.failure.failedAt >= confirmed.observedAt)
    && !(milestone.invalidatedAt !== undefined && milestone.invalidatedAt >= confirmed.observedAt)
    ? confirmed
    : undefined
  return {
    id: record.id,
    revision: record.revision,
    phase: record.phase,
    release: record.release,
    ...(record.phase !== 'canceled' && current?.value.state === 'closed'
      ? {
        repair: {
          reason: 'external-milestone-closed' as const,
          source: 'current-milestone' as const,
          observedAt: current.observedAt,
          blockages: [{ kind: 'milestone-closed' as const }],
        },
      }
      : {}),
  }
}

/**
 * Validate the complete Milestone Delivery aggregate and Intent relation without reads or writes.
 * Save Intents may lack an aggregate because submission retains the Intent before authority and
 * Project resolution complete; retained aggregates never may lack their Development Project.
 * @param deliveryTable - opened Milestone Delivery aggregate table.
 * @param intentTable - opened Milestone Delivery Intent table.
 * @param projectExists - current Development Project membership lookup.
 * @param otherIntentIds - ids already retained by earlier Control Intent families.
 * @param validateActorReference - Foundation relationship validator for immutable attribution.
 * @returns detached aggregates and Intents in deterministic restart order.
 */
export function validateMilestoneDeliveryOperationsDurableState(
  deliveryTable: ReadonlyTable<SakiMilestoneDeliveryId, MilestoneDeliveryRecord>,
  intentTable: ReadonlyTable<SakiControlIntentId, MilestoneDeliveryIntentRecord>,
  projectExists: (projectId: SakiDevelopmentProjectId) => boolean,
  otherIntentIds: ReadonlySet<SakiControlIntentId>,
  validateActorReference: (actor: ControlIntentActor) => void,
): ValidatedMilestoneDeliveryState {
  const deliveries = [...deliveryTable.entries()].map(([key, value]) => {
    const record = milestoneDeliveryRecordSchema.parse(value)
    if (record.id !== key) throw new Error('Milestone Delivery id disagrees with its table key')
    if (!projectExists(record.projectId)) {
      throw new Error('Milestone Delivery targets a missing Development Project')
    }
    /* jscpd:ignore-start -- each durable Delivery aggregate validates its own Intent ownership graph before recovery */
    return record
  })
  const deliveryById = new Map(deliveries.map(record => [record.id, record] as const))
  const intents = [...intentTable.entries()].map(([key, value]) => {
    const record = milestoneDeliveryIntentRecordSchema.parse(value)
    if (record.id !== key) throw new Error('Milestone Delivery Intent id disagrees with its table key')
    if (otherIntentIds.has(key)) {
      throw new Error(`Saki Control Intent '${key}' is retained by multiple Intent kinds`)
    }
    validateActorReference(record.payload.actor)
    const target = record.payload.intent.type === 'save-milestone-delivery'
      ? milestoneDeliveryId(record.payload.intent.projectId, record.payload.intent.release.milestoneId)
      : record.payload.intent.deliveryId
    if (record.deliveryId !== target) {
      throw new Error('Milestone Delivery Intent targets another aggregate')
    }
    if ((record.phase === 'succeeded' || record.phase === 'reconciliation-required')
      && !deliveryById.has(record.deliveryId)) {
      throw new Error('completed Milestone Delivery Intent targets a missing aggregate')
    }
    return record
  })
  const intentById = new Map(intents.map(record => [record.id, record] as const))
  for (const delivery of deliveries) {
    const last = intentById.get(delivery.lastIntentId)
    if (last === undefined || last.deliveryId !== delivery.id || !lastIntentMatchesDelivery(last, delivery)) {
      throw new Error('Milestone Delivery last Intent reference is inconsistent')
    }
    /* jscpd:ignore-end */
  }
  return {
    deliveries: deliveries.toSorted(compareDeliveryOrder),
    intents: intents.toSorted(compareIntentOrder),
  }
}

/** Owns exact-revision Milestone phase metadata and release finalization. */
export class MilestoneDeliveryOperations {
  private readonly intentTails = new Map<SakiControlIntentId, Promise<void>>()
  private readonly deliveryTails = new Map<SakiMilestoneDeliveryId, Promise<void>>()

  /** @param options - durable tables and existing Project/read owners. */
  constructor(private readonly options: MilestoneDeliveryOperationsOptions) {
    if (!Number.isSafeInteger(options.maxObservationAgeMs) || options.maxObservationAgeMs <= 0) {
      throw new TypeError('Milestone Delivery observation freshness must be one positive safe integer')
    }
  }

  /**
   * Refresh and retain targeted View sources without changing the metadata revision.
   * @param deliveryId - Milestone Delivery aggregate to refresh.
   * @param signal - caller lifetime for targeted reads and durable retention.
   * @returns closed refresh outcome for the requested aggregate.
   */
  async refresh(
    deliveryId: SakiMilestoneDeliveryId,
    signal: AbortSignal,
  ): Promise<MilestoneDeliveryRefreshResult> {
    return await enqueueKeyedOperation(this.deliveryTails, deliveryId, async () => {
      const value = this.options.deliveryTable.get(deliveryId)
      if (value === undefined) return { ok: false, reason: 'not-found' }
      const current = milestoneDeliveryRecordSchema.parse(value)
      const snapshot = await this.options.readReleaseSnapshot(
        current.projectId,
        current.release,
        'view',
        signal,
      )
      signal.throwIfAborted()
      return await this.retainSnapshotSources(current, snapshot)
        ? { ok: true }
        : { ok: false, reason: 'conflict' }
    })
  }

  /**
   * Validate every owned record and Intent relationship without external effects.
   * @param otherIntentIds - Control Intent ids retained by other operation families.
   * @returns detached validated records in deterministic restart order.
   */
  validateDurableState(otherIntentIds: ReadonlySet<SakiControlIntentId>): ValidatedMilestoneDeliveryState {
    return validateMilestoneDeliveryOperationsDurableState(
      this.options.deliveryTable,
      this.options.intentTable,
      this.options.projectExists,
      otherIntentIds,
      this.options.validateActorReference,
    )
  }

  /**
   * Resume phase writes and locally committed finalization acknowledgements without starting provider reads.
   * @param state - validated records in deterministic restart order.
   * @param signal - startup recovery lifetime.
   */
  async initializeValidated(state: ValidatedMilestoneDeliveryState, signal: AbortSignal): Promise<void> {
    const deliveryById = new Map(state.deliveries.map(record => [record.id, record] as const))
    for (const record of state.intents) {
      if (record.phase !== 'prepared') continue
      if (record.payload.intent.type === 'finalize-milestone-delivery') {
        const delivery = deliveryById.get(record.deliveryId)
        if (delivery === undefined || !lastIntentMatchesDelivery(record, delivery)) continue
      }
      signal.throwIfAborted()
      await this.submit(record.payload.intent, record.payload.actor, signal)
    }
  }

  /**
   * Resume current prepared finalizations serially, then report the first isolated failure.
   * @param signal - provider lifetime for the recovery batch.
   */
  async resumePreparedFinalizations(signal: AbortSignal): Promise<void> {
    const prepared = [...this.options.intentTable.entries()]
      .map(([, value]) => milestoneDeliveryIntentRecordSchema.parse(value))
      .filter(record => record.phase === 'prepared'
        && record.payload.intent.type === 'finalize-milestone-delivery')
      .toSorted(compareIntentOrder)
    let failed = false
    let firstFailure: unknown
    for (const record of prepared) {
      signal.throwIfAborted()
      try {
        /* jscpd:ignore-start -- Milestone finalization recovery isolates failures independently from Branch provider recovery */
        await this.submit(record.payload.intent, record.payload.actor, signal)
      } catch (error) {
        signal.throwIfAborted()
        if (!failed) {
          failed = true
          firstFailure = error
        }
      }
    }
    if (failed) throw firstFailure
    /* jscpd:ignore-end */
  }

  /**
   * Resume prepared finalizations and refresh repair-bearing Views once.
   * @param signal - provider lifetime for this pass.
   * @returns completion after every independently isolated eligible record has been attempted.
   */
  async pollPending(signal: AbortSignal): Promise<void> {
    /* jscpd:ignore-start -- Milestone polling retains prepared-finalization failure while continuing its own repair batch */
    let failed = false
    let firstFailure: unknown
    try {
      await this.resumePreparedFinalizations(signal)
    } catch (error) {
      signal.throwIfAborted()
      failed = true
      firstFailure = error
    }
    /* jscpd:ignore-end */
    /* jscpd:ignore-start -- Milestone repair polling owns a distinct eligibility predicate and refresh operation */
    const eligible = [...this.options.deliveryTable.entries()]
      .map(([, value]) => milestoneDeliveryRecordSchema.parse(value))
      .filter(record => record.releaseEvidence === undefined
        && record.phase !== 'canceled' && record.repair !== undefined)
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
    /* jscpd:ignore-end */
  }

  /**
   * Submit or replay one attributed Milestone Delivery Intent.
   * @param intent - validated-on-entry phase or finalization request and replay identity.
   * @param actor - immutable attribution whose current authority is revalidated.
   * @param signal - caller lifetime for submission and any provider reads.
   * @returns stable receipt or a closed denial, conflict, or availability result.
   */
  async submit(
    intent: MilestoneDeliveryIntent,
    actor: ControlIntentActor,
    signal: AbortSignal,
  ): Promise<MilestoneDeliveryIntentResult> {
    /* jscpd:ignore-start -- Milestone replay validates its aggregate payload independently before phase-specific resumption */
    const parsed = milestoneDeliveryIntentSchema.parse(intent)
    this.options.validateActorReference(actor)
    return await enqueueKeyedOperation(this.intentTails, parsed.intentId, async () => {
      signal.throwIfAborted()
      const existing = this.options.intentTable.get(parsed.intentId)
      if (existing !== undefined) {
        const record = milestoneDeliveryIntentRecordSchema.parse(existing)
        if (!isDeepStrictEqual(record.payload, { intent: parsed, actor })) return { ok: false, reason: 'conflict' }
        if (record.phase === 'prepared' && parsed.type === 'finalize-milestone-delivery') {
          return await this.submitFinalize(parsed, actor, signal, record)
        }
        if (record.phase === 'prepared' && parsed.type === 'save-milestone-delivery') {
          return await this.submitSave(parsed, actor, record)
        }
        return resultFor(record)
      }
      /* jscpd:ignore-end */
      return parsed.type === 'save-milestone-delivery'
        ? await this.submitSave(parsed, actor)
        : await this.submitFinalize(parsed, actor, signal)
    })
  }

  private async submitSave(
    intent: SaveMilestoneDeliveryIntent,
    actor: ControlIntentActor,
    retained?: MilestoneDeliveryIntentRecord,
  ): Promise<MilestoneDeliveryIntentResult> {
    const id = milestoneDeliveryId(intent.projectId, intent.release.milestoneId)
    return await enqueueKeyedOperation(this.deliveryTails, id, async () => {
      const payload = { intent, actor }
      const now = Date.now()
      let operation = retained ?? milestoneDeliveryIntentRecordSchema.parse({
        id: intent.intentId,
        schemaVersion: 1,
        revision: 0,
        payloadDigest: canonicalDigest('saki/milestone-delivery-intent/v1', payload),
        payload,
        deliveryId: id,
        phase: 'prepared',
        createdAt: now,
        updatedAt: now,
      })
      if (retained === undefined) await this.options.intentTable.put(operation.id, operation)
      const retainedDelivery = this.options.deliveryTable.get(id)
      if (retainedDelivery !== undefined) {
        const completed = milestoneDeliveryRecordSchema.parse(retainedDelivery)
        const completedRevision = intent.expectedDeliveryRevision === null
          ? 0
          : intent.expectedDeliveryRevision + 1
        if (completed.lastIntentId === intent.intentId
          && completed.revision === completedRevision
          && completed.projectId === intent.projectId
          && completed.registryRevision === intent.expectedRegistryRevision
          && completed.projectRevision === intent.expectedProjectRevision
          && completed.phase === intent.phase
          && isDeepStrictEqual(completed.release, intent.release)) {
          operation = await this.finishIntent(operation, 'succeeded', completed.revision)
          this.options.notifyChanged()
          return resultFor(operation)
        }
      }
      if (!this.options.authorityCurrent(actor, 'milestone-delivery:save')) {
        operation = await this.finishIntent(operation, 'denied')
        return resultFor(operation)
      }
      const context = this.options.resolveContext(intent.projectId)
      if (!context.ok) {
        operation = await this.finishIntent(operation, 'unavailable')
        return resultFor(operation)
      }
      const currentValue = retainedDelivery
      if (context.context.registryRevision !== intent.expectedRegistryRevision
        || context.context.projectRevision !== intent.expectedProjectRevision
        || context.context.repositoryId !== intent.release.repositoryId
        || context.context.projectId !== intent.release.projectId
        || (currentValue === undefined) !== (intent.expectedDeliveryRevision === null)) {
        operation = await this.finishIntent(operation, 'conflict')
        return resultFor(operation)
      }
      const current = currentValue === undefined ? undefined : milestoneDeliveryRecordSchema.parse(currentValue)
      if (current !== undefined
        && (current.revision !== intent.expectedDeliveryRevision || current.releaseEvidence !== undefined)) {
        operation = await this.finishIntent(operation, 'conflict')
        return resultFor(operation)
      }
      const record = milestoneDeliveryRecordSchema.parse({
        id,
        schemaVersion: 1,
        revision: current === undefined ? 0 : current.revision + 1,
        projectId: intent.projectId,
        registryRevision: context.context.registryRevision,
        projectRevision: context.context.projectRevision,
        phase: intent.phase,
        release: intent.release,
        sources: current !== undefined && isDeepStrictEqual(current.release, intent.release)
          ? current.sources
          : emptyMilestoneDeliverySources(now),
        lastIntentId: intent.intentId,
        createdAt: current?.createdAt ?? now,
        updatedAt: Math.max(current?.updatedAt ?? 0, now),
      })
      if (current === undefined) {
        await this.options.deliveryTable.put(id, record)
      } else {
        await this.options.deliveryTable.update(id, (value) => {
          const stored = milestoneDeliveryRecordSchema.parse(value)
          if (stored.revision !== current.revision) throw new MilestoneDeliveryCasConflict()
          return record
        })
      }
      operation = await this.finishIntent(operation, 'succeeded', record.revision)
      this.options.notifyChanged()
      return resultFor(operation)
    })
  }

  private async submitFinalize(
    intent: FinalizeMilestoneDeliveryIntent,
    actor: ControlIntentActor,
    signal: AbortSignal,
    retained?: MilestoneDeliveryIntentRecord,
  ): Promise<MilestoneDeliveryIntentResult> {
    return await enqueueKeyedOperation(this.deliveryTails, intent.deliveryId, async () => {
      const payload = { intent, actor }
      const now = Date.now()
      let operation = retained ?? milestoneDeliveryIntentRecordSchema.parse({
        id: intent.intentId,
        schemaVersion: 1,
        revision: 0,
        payloadDigest: canonicalDigest('saki/milestone-delivery-intent/v1', payload),
        payload,
        deliveryId: intent.deliveryId,
        phase: 'prepared',
        createdAt: now,
        updatedAt: now,
      })
      if (retained === undefined) await this.options.intentTable.put(operation.id, operation)
      const value = this.options.deliveryTable.get(intent.deliveryId)
      if (value === undefined) {
        operation = await this.finishIntent(operation, 'conflict')
        return resultFor(operation)
      }
      const current = milestoneDeliveryRecordSchema.parse(value)
      if (current.releaseEvidence?.intentId === intent.intentId
        && current.releaseEvidence.priorMetadataRevision === intent.expectedDeliveryRevision
        && isDeepStrictEqual(current.releaseEvidence.actor, actor)
        && isDeepStrictEqual(current.release, intent.release)) {
        operation = await this.finishIntent(operation, 'succeeded', current.revision)
        this.options.notifyChanged()
        return resultFor(operation)
      }
      if (current.repair?.intentId === intent.intentId
        && current.repair.priorRevision === intent.expectedDeliveryRevision
        && current.lastIntentId === intent.intentId
        && isDeepStrictEqual(current.release, intent.release)) {
        operation = await this.finishIntent(
          operation,
          'reconciliation-required',
          current.revision,
          current.repair.blockages,
        )
        this.options.notifyChanged()
        return resultFor(operation)
      }
      if (!this.options.authorityCurrent(actor, 'milestone-delivery:finalize')) {
        operation = await this.finishIntent(operation, 'denied')
        return resultFor(operation)
      }
      if (current.revision !== intent.expectedDeliveryRevision
        || current.phase !== 'ready-to-release'
        || current.releaseEvidence !== undefined
        || !isDeepStrictEqual(current.release, intent.release)) {
        operation = await this.finishIntent(operation, 'conflict')
        return resultFor(operation)
      }
      const context = this.options.resolveContext(current.projectId)
      if (!context.ok) {
        operation = await this.finishIntent(operation, 'unavailable')
        return resultFor(operation)
      }
      if (!contextMatchesDelivery(context.context, current)) {
        operation = await this.finishIntent(operation, 'conflict')
        return resultFor(operation)
      }

      const evaluation = await this.options.readReleaseSnapshot(current.projectId, intent.release, 'evaluation', signal)
      signal.throwIfAborted()
      if (!await this.retainSnapshotSources(current, evaluation)) {
        operation = await this.finishIntent(operation, 'conflict')
        return resultFor(operation)
      }
      const evaluatedAt = Date.now()
      const finalReread = await this.options.readReleaseSnapshot(
        current.projectId,
        intent.release,
        'final-reread',
        signal,
      )
      signal.throwIfAborted()
      if (!await this.retainSnapshotSources(current, finalReread)) {
        operation = await this.finishIntent(operation, 'conflict')
        return resultFor(operation)
      }
      const policy = evaluateReleaseEvidencePolicyV1({
        preparedAt: operation.createdAt,
        evaluatedAt,
        maxObservationAgeMs: this.options.maxObservationAgeMs,
        expected: intent.release,
        evaluation,
        finalReread,
      })
      if (!policy.ok) {
        const repairReason = policy.blockages.some(blockage => blockage.kind === 'milestone-closed')
          ? 'external-milestone-closed' as const
          : policy.blockages.some(blockage => blockage.kind === 'final-reread-mismatch')
            ? 'concurrent-github-change' as const
            : undefined
        if (repairReason === undefined) {
          operation = await this.finishIntent(operation, 'blocked', undefined, policy.blockages)
          return resultFor(operation)
        }
        if (!this.options.authorityCurrent(actor, 'milestone-delivery:finalize')) {
          operation = await this.finishIntent(operation, 'denied')
          return resultFor(operation)
        }
        const repairContext = this.options.resolveContext(current.projectId)
        if (!repairContext.ok) {
          operation = await this.finishIntent(operation, 'unavailable')
          return resultFor(operation)
        }
        if (!contextMatchesDelivery(repairContext.context, current)) {
          operation = await this.finishIntent(operation, 'conflict')
          return resultFor(operation)
        }
        let repaired: MilestoneDeliveryRecord
        try {
          repaired = await this.options.deliveryTable.update(intent.deliveryId, (storedValue) => {
            const stored = milestoneDeliveryRecordSchema.parse(storedValue)
            if (stored.revision !== current.revision || stored.releaseEvidence !== undefined) {
              throw new MilestoneDeliveryCasConflict()
            }
            return milestoneDeliveryRecordSchema.parse({
              ...stored,
              revision: stored.revision + 1,
              repair: {
                intentId: intent.intentId,
                priorRevision: stored.revision,
                reason: repairReason,
                blockages: policy.blockages,
                recordedAt: finalReread.capturedAt,
              },
              lastIntentId: intent.intentId,
              updatedAt: Math.max(stored.updatedAt, finalReread.capturedAt),
            })
          })
        } catch (error) {
          if (!(error instanceof MilestoneDeliveryCasConflict)) throw error
          operation = await this.finishIntent(operation, 'conflict')
          return resultFor(operation)
        }
        operation = await this.finishIntent(
          operation,
          'reconciliation-required',
          repaired.revision,
          policy.blockages,
        )
        this.options.notifyChanged()
        return resultFor(operation)
      }
      if (!this.options.authorityCurrent(actor, 'milestone-delivery:finalize')) {
        operation = await this.finishIntent(operation, 'denied')
        return resultFor(operation)
      }
      const finalContext = this.options.resolveContext(current.projectId)
      if (!finalContext.ok) {
        operation = await this.finishIntent(operation, 'unavailable')
        return resultFor(operation)
      }
      if (!contextMatchesDelivery(finalContext.context, current)) {
        operation = await this.finishIntent(operation, 'conflict')
        return resultFor(operation)
      }
      let finalized: MilestoneDeliveryRecord
      try {
        finalized = await this.options.deliveryTable.update(intent.deliveryId, (storedValue) => {
          const stored = milestoneDeliveryRecordSchema.parse(storedValue)
          if (stored.revision !== current.revision || stored.releaseEvidence !== undefined
            || stored.phase !== 'ready-to-release' || !isDeepStrictEqual(stored.release, intent.release)) {
            throw new MilestoneDeliveryCasConflict()
          }
          const { repair: _resolvedRepair, ...retained } = stored
          return milestoneDeliveryRecordSchema.parse({
            ...retained,
            revision: stored.revision + 1,
            releaseEvidence: {
              intentId: intent.intentId,
              actor,
              priorMetadataRevision: stored.revision,
              evidence: policy.evidence,
              embeddedAt: policy.evidence.confirmedAt,
            },
            lastIntentId: intent.intentId,
            updatedAt: Math.max(stored.updatedAt, policy.evidence.confirmedAt),
          })
        })
      } catch (error) {
        if (!(error instanceof MilestoneDeliveryCasConflict)) throw error
        operation = await this.finishIntent(operation, 'conflict')
        return resultFor(operation)
      }
      operation = await this.finishIntent(operation, 'succeeded', finalized.revision)
      this.options.notifyChanged()
      return resultFor(operation)
    })
  }

  private async retainSnapshotSources(
    current: MilestoneDeliveryRecord,
    snapshot: ReleaseEvidencePolicyV1Snapshot,
  ): Promise<boolean> {
    try {
      await this.options.deliveryTable.update(current.id, (storedValue) => {
        const stored = milestoneDeliveryRecordSchema.parse(storedValue)
        if (stored.revision !== current.revision || !isDeepStrictEqual(stored.release, current.release)) {
          throw new MilestoneDeliveryCasConflict()
        }
        const sources = mergeMilestoneDeliverySources(stored.sources, snapshot)
        return milestoneDeliveryRecordSchema.parse({
          ...stored,
          sources,
          updatedAt: Math.max(stored.updatedAt, sources.updatedAt),
        })
      })
    } catch (error) {
      if (error instanceof MilestoneDeliveryCasConflict) return false
      throw error
    }
    this.options.notifyChanged()
    return true
  }

  private async finishIntent(
    current: MilestoneDeliveryIntentRecord,
    phase: Exclude<MilestoneDeliveryIntentRecord['phase'], 'prepared'>,
    resultDeliveryRevision?: number,
    blockages?: readonly ReleaseEvidencePolicyV1Blockage[],
  ): Promise<MilestoneDeliveryIntentRecord> {
    return await this.options.intentTable.update(current.id, value => milestoneDeliveryIntentRecordSchema.parse({
      ...milestoneDeliveryIntentRecordSchema.parse(value),
      phase,
      revision: current.revision + 1,
      ...(resultDeliveryRevision === undefined ? {} : { resultDeliveryRevision }),
      ...(blockages === undefined ? {} : { blockages }),
      updatedAt: Math.max(current.updatedAt, Date.now()),
    }))
  }
}

class MilestoneDeliveryCasConflict extends Error {}

function emptyMilestoneDeliverySources(now: number): MilestoneDeliverySources {
  return {
    revision: 0,
    milestone: {},
    tag: {},
    release: {},
    releaseCommit: {},
    upstreamCommit: {},
    upstreamAncestry: {},
    updatedAt: now,
  }
}

function mergeMilestoneDeliverySources(
  current: MilestoneDeliverySources,
  snapshot: ReleaseEvidencePolicyV1Snapshot,
): MilestoneDeliverySources {
  return milestoneDeliverySourcesSchema.parse({
    revision: current.revision + 1,
    milestone: mergeTargetedEvidence(current.milestone, snapshot.milestone),
    tag: mergeTargetedEvidence(current.tag, snapshot.tag),
    release: mergeTargetedEvidence(current.release, snapshot.release),
    releaseCommit: mergeTargetedEvidence(current.releaseCommit, snapshot.releaseCommit),
    upstreamCommit: mergeTargetedEvidence(current.upstreamCommit, snapshot.upstreamCommit),
    upstreamAncestry: mergeTargetedEvidence(current.upstreamAncestry, snapshot.upstreamAncestry),
    updatedAt: Math.max(current.updatedAt, snapshot.capturedAt),
  })
}

function mergeTargetedEvidence<T>(
  current: SakiTargetedEvidence<T>,
  next: SakiTargetedEvidence<T>,
): SakiTargetedEvidence<T> {
  const confirmed = next.confirmed === undefined
    || (current.confirmed !== undefined && current.confirmed.observedAt > next.confirmed.observedAt)
    ? current.confirmed
    : next.confirmed
  const failure = next.failure === undefined
    || (current.failure !== undefined && current.failure.failedAt > next.failure.failedAt)
    ? current.failure
    : next.failure
  const invalidatedAt = Math.max(current.invalidatedAt ?? -1, next.invalidatedAt ?? -1)
  return {
    ...(confirmed === undefined ? {} : { confirmed: structuredClone(confirmed) }),
    ...(failure === undefined ? {} : { failure: structuredClone(failure) }),
    ...(invalidatedAt < 0 ? {} : { invalidatedAt }),
  }
}

function contextMatchesDelivery(
  context: MilestoneDeliveryCurrentContext,
  delivery: MilestoneDeliveryRecord,
): boolean {
  return context.registryRevision === delivery.registryRevision
    && context.projectRevision === delivery.projectRevision
    && context.repositoryId === delivery.release.repositoryId
    && context.projectId === delivery.release.projectId
}

function lastIntentMatchesDelivery(
  record: MilestoneDeliveryIntentRecord,
  delivery: MilestoneDeliveryRecord,
): boolean {
  const intent = record.payload.intent
  if (intent.type === 'save-milestone-delivery') {
    const expectedRevision = intent.expectedDeliveryRevision === null ? 0 : intent.expectedDeliveryRevision + 1
    return (record.phase === 'prepared' || record.phase === 'succeeded')
      && (record.phase === 'prepared' || record.resultDeliveryRevision === delivery.revision)
      && delivery.revision === expectedRevision
      && delivery.projectId === intent.projectId
      && delivery.registryRevision === intent.expectedRegistryRevision
      && delivery.projectRevision === intent.expectedProjectRevision
      && delivery.phase === intent.phase
      && delivery.releaseEvidence === undefined
      && delivery.repair === undefined
      && isDeepStrictEqual(delivery.release, intent.release)
  }
  if (!isDeepStrictEqual(delivery.release, intent.release)
    || delivery.revision !== intent.expectedDeliveryRevision + 1) return false
  if (delivery.releaseEvidence !== undefined) {
    return (record.phase === 'prepared' || record.phase === 'succeeded')
      && (record.phase === 'prepared' || record.resultDeliveryRevision === delivery.revision)
      && delivery.releaseEvidence.intentId === record.id
      && delivery.releaseEvidence.priorMetadataRevision === intent.expectedDeliveryRevision
      && isDeepStrictEqual(delivery.releaseEvidence.actor, record.payload.actor)
  }
  return delivery.repair !== undefined
    && (record.phase === 'prepared' || record.phase === 'reconciliation-required')
    && (record.phase === 'prepared' || record.resultDeliveryRevision === delivery.revision)
    && delivery.repair.intentId === record.id
    && delivery.repair.priorRevision === intent.expectedDeliveryRevision
}

function compareDeliveryOrder(left: MilestoneDeliveryRecord, right: MilestoneDeliveryRecord): number {
  return left.createdAt - right.createdAt || String(left.id).localeCompare(String(right.id))
}

function compareIntentOrder(left: MilestoneDeliveryIntentRecord, right: MilestoneDeliveryIntentRecord): number {
  return left.createdAt - right.createdAt || String(left.id).localeCompare(String(right.id))
}

// Prepared Intents resume through submitSave/submitFinalize; only settled records reach this projection.
function resultFor(record: MilestoneDeliveryIntentRecord): MilestoneDeliveryIntentResult {
  const receipt = {
    intentId: record.id,
    deliveryId: record.deliveryId,
    ...(record.resultDeliveryRevision === undefined ? {} : { deliveryRevision: record.resultDeliveryRevision }),
  }
  if (record.phase === 'succeeded') return { ok: true, receipt: { ...receipt, state: 'succeeded' } }
  if (record.phase === 'denied') return { ok: false, reason: 'denied', receipt: { ...receipt, state: 'denied' } }
  if (record.phase === 'reconciliation-required') {
    return {
      ok: false,
      reason: 'reconciliation-required',
      blockages: record.blockages,
      receipt: { ...receipt, state: record.phase },
    }
  }
  if (record.phase === 'blocked') {
    return {
      ok: false,
      reason: 'unavailable',
      blockages: record.blockages,
      receipt: { ...receipt, state: 'blocked' },
    }
  }
  if (record.phase === 'unavailable') {
    return { ok: false, reason: 'unavailable', receipt: { ...receipt, state: 'blocked' } }
  }
  return { ok: false, reason: 'conflict', receipt: { ...receipt, state: 'conflict' } }
}
