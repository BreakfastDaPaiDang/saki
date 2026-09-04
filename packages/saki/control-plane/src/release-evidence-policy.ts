/** Fixed version-one Milestone release-evidence policy. @module @breakfastdapaidang/saki-control-plane/src/release-evidence-policy */

import {
  canonicalDigest,
  isSafeGitRef,
  MAX_GIT_REF_CHARS,
  type SakiControlIntentId,
} from '@breakfastdapaidang/saki-execution'
import { z } from 'zod'
import {
  GITHUB_PROJECT_BOARD_SCAN_COLLECTION_LIMIT,
  githubCommitCiFactSchema,
  githubCommitComparisonFactSchema,
  githubCommitFactSchema,
  githubIssueIdSchema,
  githubMilestoneFactSchema,
  githubMilestoneIdSchema,
  githubProjectBoardFingerprintSchema,
  githubProjectIdSchema,
  githubPullRequestFactSchema,
  githubReleaseFactSchema,
  githubRepositoryDatabaseIdSchema,
  githubRepositoryIdSchema,
  githubRepositoryNameWithOwnerSchema,
  githubTagPeelFactSchema,
  githubTagReferenceFactSchema,
  type GitHubCommitCiFact,
  type GitHubCommitComparisonFact,
  type GitHubCommitFact,
  type GitHubCommitId,
  type GitHubFailure,
  type GitHubIssueId,
  type GitHubMilestoneFact,
  type GitHubMilestoneId,
  type GitHubProjectBoardFingerprint,
  type GitHubProjectId,
  type GitHubPullRequestFact,
  type GitHubReleaseByTagObservation,
  type GitHubReleaseTagName,
  type GitHubRepositoryDatabaseId,
  type GitHubRepositoryId,
  type GitHubTagPeelFact,
  type GitHubTagReferenceFact,
  type GitHubTagTarget,
} from '@breakfastdapaidang/saki-github'
import {
  sakiBoardRemoteFingerprintSchema,
  sakiBoardWorkItemIdSchema,
  sakiControlIntentIdSchema,
} from './ids.ts'
import type {
  SakiBoardRemoteFingerprint,
  SakiBoardStatus,
  SakiBoardWorkItemId,
} from './types.ts'
import { summarizeCommitCi } from './delivery-evidence.ts'

/** Stable identity of the only release-evidence policy shipped by version 0.1.0. */
export const RELEASE_EVIDENCE_POLICY_V1 = 'release-evidence/v1' as const

/** Last confirmed targeted fact plus newer failure or invalidation state. */
export interface SakiTargetedEvidence<T> {
  readonly confirmed?: {
    readonly value: T
    readonly observedAt: number
  } | undefined
  readonly failure?: {
    readonly failure: GitHubFailure
    readonly failedAt: number
  } | undefined
  readonly invalidatedAt?: number | undefined
}

/** Complete Board-generation facts needed by the fixed release selector. */
export interface SakiReleaseBoardFact {
  readonly repositoryId: GitHubRepositoryId
  readonly projectId: GitHubProjectId
  readonly generation: number
  readonly sourceFingerprint: GitHubProjectBoardFingerprint
  readonly items: readonly {
    readonly workItemId: SakiBoardWorkItemId
    readonly issueId: GitHubIssueId
    readonly status: SakiBoardStatus
    readonly remoteFingerprint: SakiBoardRemoteFingerprint
  }[]
}

/** Current accepted Branch Delivery facts considered for one Milestone item. */
export interface SakiReleaseDeliveryFact {
  readonly deliveryId: string
  readonly revision: number
  readonly workItemId: SakiBoardWorkItemId
  readonly repositoryId: GitHubRepositoryId
  readonly commitId: GitHubCommitId
  readonly headRef: string
  readonly baseRef: string
  readonly pullRequest: SakiTargetedEvidence<GitHubPullRequestFact>
  readonly ci: SakiTargetedEvidence<GitHubCommitCiFact>
  readonly ancestry: SakiTargetedEvidence<GitHubCommitComparisonFact>
  readonly acceptance?: {
    readonly deliveryRevision: number
    readonly acceptedAt: number
    readonly intentId: SakiControlIntentId
    readonly actorDigest: string
  } | undefined
}

/** One complete targeted fact set evaluated by the policy. */
export interface ReleaseEvidencePolicyV1Snapshot {
  readonly capturedAt: number
  readonly board: SakiTargetedEvidence<SakiReleaseBoardFact>
  readonly milestone: SakiTargetedEvidence<GitHubMilestoneFact>
  readonly deliveries: readonly SakiReleaseDeliveryFact[]
  readonly tag: SakiTargetedEvidence<{
    readonly reference: GitHubTagReferenceFact
    readonly peel: GitHubTagPeelFact
  }>
  readonly release: SakiTargetedEvidence<GitHubReleaseByTagObservation>
  readonly releaseCommit: SakiTargetedEvidence<GitHubCommitFact>
  readonly upstreamCommit: SakiTargetedEvidence<GitHubCommitFact>
  readonly upstreamAncestry: SakiTargetedEvidence<GitHubCommitComparisonFact>
}

/** Immutable metadata that fixes what one finalization is allowed to prove. */
export interface ReleaseEvidencePolicyV1Expectation {
  readonly repositoryId: GitHubRepositoryId
  readonly projectId: GitHubProjectId
  readonly milestoneId: GitHubMilestoneId
  readonly milestoneNumber: number
  readonly tagName: GitHubReleaseTagName
  readonly releaseCommitId: GitHubCommitId
  readonly upstreamRepositoryId: GitHubRepositoryId
  readonly upstreamRepositoryDatabaseId: GitHubRepositoryDatabaseId
  readonly upstreamRepositoryNameWithOwner: string
  readonly upstreamCommitId: GitHubCommitId
}

/** Typed reason a complete Milestone release fact cannot be published. */
export type ReleaseEvidencePolicyV1Blockage =
  | {
    readonly kind: 'source-unavailable' | 'source-failed' | 'source-stale' | 'source-invalidated'
    readonly pass: 'evaluation' | 'final-reread'
    readonly source: string
  }
  | { readonly kind: 'milestone-target-mismatch' | 'milestone-closed' | 'scope-empty' }
  | { readonly kind: 'scope-unmapped'; readonly issueId: GitHubIssueId }
  | { readonly kind: 'work-item-nonterminal'; readonly workItemId: SakiBoardWorkItemId }
  | { readonly kind: 'delivery-duplicate'; readonly workItemId: SakiBoardWorkItemId }
  | {
    readonly kind: 'delivery-not-accepted' | 'delivery-pr-mismatch' | 'delivery-ci-not-successful'
      | 'delivery-ancestry-mismatch'
    readonly workItemId: SakiBoardWorkItemId
  }
  | { readonly kind: 'tag-mismatch' | 'release-mismatch' | 'release-commit-mismatch'
    | 'upstream-commit-mismatch' | 'upstream-ancestry-mismatch' }
  | { readonly kind: 'final-reread-mismatch' }

/** Policy-owned immutable supporting facts, before outer Actor/Intent CAS attribution. */
export interface ReleaseEvidencePolicyV1Evidence {
  readonly policy: typeof RELEASE_EVIDENCE_POLICY_V1
  readonly evaluationDigest: string
  readonly projectId: GitHubProjectId
  readonly boardGeneration: number
  readonly boardFingerprint: GitHubProjectBoardFingerprint
  readonly milestoneId: GitHubMilestoneId
  readonly milestoneNumber: number
  readonly milestone: GitHubMilestoneFact
  readonly scopeFingerprint: string
  readonly workItems: readonly {
    readonly workItemId: SakiBoardWorkItemId
    readonly issueId: GitHubIssueId
    readonly status: 'done' | 'canceled'
    readonly remoteFingerprint: SakiBoardRemoteFingerprint
  }[]
  readonly deliveries: readonly {
    readonly deliveryId: string
    readonly deliveryRevision: number
    readonly workItemId: SakiBoardWorkItemId
    readonly commitId: GitHubCommitId
    readonly headRef: string
    readonly baseRef: string
    readonly pullRequest: GitHubPullRequestFact
    readonly ci: GitHubCommitCiFact
    readonly acceptance: NonNullable<SakiReleaseDeliveryFact['acceptance']>
    readonly ancestry: GitHubCommitComparisonFact
  }[]
  readonly tag: {
    readonly reference: GitHubTagReferenceFact
    readonly peel: GitHubTagPeelFact
  }
  readonly release: Exclude<GitHubReleaseByTagObservation, { readonly kind: 'absent' }>['release']
  readonly releaseCommit: GitHubCommitFact
  readonly upstreamRepositoryId: GitHubRepositoryId
  readonly upstreamRepositoryDatabaseId: GitHubRepositoryDatabaseId
  readonly upstreamRepositoryNameWithOwner: string
  readonly upstreamCommit: GitHubCommitFact
  readonly upstreamAncestry: GitHubCommitComparisonFact
  readonly confirmedAt: number
}

const nonnegativeInteger = z.number().int().nonnegative()
const digest = z.string().regex(/^[0-9a-f]{64}$/u)
const canonicalBranchRef = z.string()
  .min('refs/heads/a'.length)
  .max(MAX_GIT_REF_CHARS)
  .refine(value => value.startsWith('refs/heads/') && isSafeGitRef(value))

const releaseEvidenceObjectSchema = z.object({
  policy: z.literal(RELEASE_EVIDENCE_POLICY_V1),
  evaluationDigest: digest,
  projectId: githubProjectIdSchema,
  boardGeneration: nonnegativeInteger,
  boardFingerprint: githubProjectBoardFingerprintSchema,
  milestoneId: githubMilestoneIdSchema,
  milestoneNumber: z.number().int().positive(),
  milestone: githubMilestoneFactSchema,
  scopeFingerprint: digest,
  workItems: z.array(z.object({
    workItemId: sakiBoardWorkItemIdSchema,
    issueId: githubIssueIdSchema,
    status: z.enum(['done', 'canceled']),
    remoteFingerprint: sakiBoardRemoteFingerprintSchema,
  }).strict()).max(GITHUB_PROJECT_BOARD_SCAN_COLLECTION_LIMIT),
  deliveries: z.array(z.object({
    deliveryId: z.string().regex(/^branch-delivery-[0-9a-f]{64}$/u),
    deliveryRevision: nonnegativeInteger,
    workItemId: sakiBoardWorkItemIdSchema,
    commitId: z.string().regex(/^[0-9a-f]{40}$/u).transform(value => value as GitHubCommitId),
    headRef: canonicalBranchRef,
    baseRef: canonicalBranchRef,
    pullRequest: githubPullRequestFactSchema,
    ci: githubCommitCiFactSchema,
    acceptance: z.object({
      deliveryRevision: nonnegativeInteger,
      acceptedAt: nonnegativeInteger,
      intentId: sakiControlIntentIdSchema,
      actorDigest: digest,
    }).strict(),
    ancestry: githubCommitComparisonFactSchema,
  }).strict()).max(GITHUB_PROJECT_BOARD_SCAN_COLLECTION_LIMIT),
  tag: z.object({
    reference: githubTagReferenceFactSchema,
    peel: githubTagPeelFactSchema,
  }).strict(),
  release: githubReleaseFactSchema,
  releaseCommit: githubCommitFactSchema,
  upstreamRepositoryId: githubRepositoryIdSchema,
  upstreamRepositoryDatabaseId: githubRepositoryDatabaseIdSchema,
  upstreamRepositoryNameWithOwner: githubRepositoryNameWithOwnerSchema,
  upstreamCommit: githubCommitFactSchema,
  upstreamAncestry: githubCommitComparisonFactSchema,
  confirmedAt: nonnegativeInteger,
}).strict()

/** Strict self-digesting schema for immutable embedded V1 Release Evidence. */
export const releaseEvidencePolicyV1EvidenceSchema: z.ZodType<ReleaseEvidencePolicyV1Evidence> =
  releaseEvidenceObjectSchema.superRefine((evidence, context) => {
    const { policy: _policy, evaluationDigest, confirmedAt: _confirmedAt, ...evaluated } = evidence
    if (canonicalDigest('saki/release-evidence-policy/v1', stripObservationTimes(evaluated))
      !== evaluationDigest) {
      context.addIssue({ code: 'custom', message: 'Release Evidence digest does not match its facts' })
    }
    if (evidence.milestone.id !== evidence.milestoneId
      || evidence.milestone.number !== evidence.milestoneNumber) {
      context.addIssue({ code: 'custom', message: 'Release Evidence Milestone identity disagrees' })
    }
    if (!evidenceRelationshipsMatch(evidence)) {
      context.addIssue({ code: 'custom', message: 'Release Evidence facts disagree' })
    }
  })

/** Complete fixed-policy evaluation input; no item predicate or exclusion is accepted. */
export interface ReleaseEvidencePolicyV1Input {
  readonly preparedAt: number
  readonly evaluatedAt: number
  readonly maxObservationAgeMs: number
  readonly expected: ReleaseEvidencePolicyV1Expectation
  readonly evaluation: ReleaseEvidencePolicyV1Snapshot
  readonly finalReread: ReleaseEvidencePolicyV1Snapshot
}

/** Result of evaluating both the candidate world and its final matching reread. */
export type ReleaseEvidencePolicyV1Result =
  | { readonly ok: true; readonly evidence: ReleaseEvidencePolicyV1Evidence }
  | { readonly ok: false; readonly blockages: readonly ReleaseEvidencePolicyV1Blockage[] }

/**
 * Evaluate the fixed V1 Milestone selector, current facts, and final reread.
 * @param input - trusted complete-source snapshots and immutable release expectation.
 * @returns immutable evidence or typed fail-closed blockages.
 */
export function evaluateReleaseEvidencePolicyV1(
  input: ReleaseEvidencePolicyV1Input,
): ReleaseEvidencePolicyV1Result {
  if (!Number.isSafeInteger(input.maxObservationAgeMs) || input.maxObservationAgeMs <= 0) {
    throw new TypeError('release evidence freshness must be one positive safe integer')
  }
  if (input.preparedAt > input.evaluation.capturedAt
    || input.evaluation.capturedAt > input.evaluatedAt
    || input.evaluatedAt > input.finalReread.capturedAt) {
    throw new TypeError('release evidence evaluation timestamps are not monotonic')
  }
  const first = evaluateSnapshot(
    input.evaluation,
    input.expected,
    input.preparedAt,
    input.evaluatedAt,
    input.maxObservationAgeMs,
    'evaluation',
  )
  if (!first.ok) return first
  const final = evaluateSnapshot(
    input.finalReread,
    input.expected,
    input.evaluation.capturedAt,
    input.finalReread.capturedAt,
    input.maxObservationAgeMs,
    'final-reread',
  )
  if (!final.ok) return final
  if (first.comparisonDigest !== final.comparisonDigest) {
    return { ok: false, blockages: [{ kind: 'final-reread-mismatch' }] }
  }
  return {
    ok: true,
    evidence: releaseEvidencePolicyV1EvidenceSchema.parse({
      ...final.evidence,
      policy: RELEASE_EVIDENCE_POLICY_V1,
      evaluationDigest: final.digest,
      confirmedAt: input.finalReread.capturedAt,
    }),
  }
}

type SnapshotEvaluation =
  | {
    readonly ok: true
    readonly digest: string
    readonly comparisonDigest: string
    readonly evidence: Omit<ReleaseEvidencePolicyV1Evidence, 'policy' | 'evaluationDigest' | 'confirmedAt'>
  }
  | { readonly ok: false; readonly blockages: readonly ReleaseEvidencePolicyV1Blockage[] }

function evaluateSnapshot(
  snapshot: ReleaseEvidencePolicyV1Snapshot,
  expected: ReleaseEvidencePolicyV1Expectation,
  requiredObservedAt: number,
  now: number,
  maxAgeMs: number,
  pass: 'evaluation' | 'final-reread',
): SnapshotEvaluation {
  const blockages: ReleaseEvidencePolicyV1Blockage[] = []
  const board = currentSource(snapshot.board, 'board', pass, requiredObservedAt, now, maxAgeMs, blockages)
  const milestone = currentSource(snapshot.milestone, 'milestone', pass, requiredObservedAt, now, maxAgeMs, blockages)
  const tag = currentSource(snapshot.tag, 'tag', pass, requiredObservedAt, now, maxAgeMs, blockages)
  const release = currentSource(snapshot.release, 'release', pass, requiredObservedAt, now, maxAgeMs, blockages)
  const releaseCommit = currentSource(
    snapshot.releaseCommit,
    'release-commit',
    pass,
    requiredObservedAt,
    now,
    maxAgeMs,
    blockages,
  )
  const upstreamCommit = currentSource(
    snapshot.upstreamCommit,
    'upstream-commit',
    pass,
    requiredObservedAt,
    now,
    maxAgeMs,
    blockages,
  )
  const upstreamAncestry = currentSource(
    snapshot.upstreamAncestry,
    'upstream-ancestry',
    pass,
    requiredObservedAt,
    now,
    maxAgeMs,
    blockages,
  )
  if (blockages.length > 0 || board === undefined || milestone === undefined || tag === undefined
    || release === undefined || releaseCommit === undefined || upstreamCommit === undefined
    || upstreamAncestry === undefined) {
    return { ok: false, blockages }
  }

  if (board.repositoryId !== expected.repositoryId || board.projectId !== expected.projectId
    || milestone.id !== expected.milestoneId || milestone.number !== expected.milestoneNumber
    || milestone.repositoryId !== expected.repositoryId) {
    blockages.push({ kind: 'milestone-target-mismatch' })
  }
  if (milestone.state !== 'open') blockages.push({ kind: 'milestone-closed' })
  if (milestone.issues.length === 0) blockages.push({ kind: 'scope-empty' })

  const boardByIssue = new Map(board.items.map(item => [item.issueId, item] as const))
  const selected = milestone.issues.flatMap((issue) => {
    const item = issue.repositoryId === expected.repositoryId ? boardByIssue.get(issue.id) : undefined
    if (item === undefined) {
      blockages.push({ kind: 'scope-unmapped', issueId: issue.id })
      return []
    }
    if (item.status !== 'done' && item.status !== 'canceled') {
      blockages.push({ kind: 'work-item-nonterminal', workItemId: item.workItemId })
      return []
    }
    return [{ ...item, status: item.status }]
  })

  const deliveryByWorkItem = new Map<SakiBoardWorkItemId, SakiReleaseDeliveryFact>()
  for (const delivery of snapshot.deliveries) {
    if (deliveryByWorkItem.has(delivery.workItemId)) {
      blockages.push({ kind: 'delivery-duplicate', workItemId: delivery.workItemId })
    } else {
      deliveryByWorkItem.set(delivery.workItemId, delivery)
    }
  }

  const selectedDeliveries = selected.flatMap((item) => {
    if (item.status !== 'done') return []
    const delivery = deliveryByWorkItem.get(item.workItemId)
    if (delivery === undefined) return []
    const acceptance = delivery.acceptance
    if (acceptance === undefined || acceptance.deliveryRevision !== delivery.revision) {
      blockages.push({ kind: 'delivery-not-accepted', workItemId: item.workItemId })
      return []
    }
    const pullRequest = currentSource(
      delivery.pullRequest,
      `delivery:${delivery.deliveryId}:pull-request`,
      pass,
      requiredObservedAt,
      now,
      maxAgeMs,
      blockages,
    )
    const ci = currentSource(
      delivery.ci,
      `delivery:${delivery.deliveryId}:ci`,
      pass,
      requiredObservedAt,
      now,
      maxAgeMs,
      blockages,
    )
    const ancestry = currentSource(
      delivery.ancestry,
      `delivery:${delivery.deliveryId}:ancestry`,
      pass,
      requiredObservedAt,
      now,
      maxAgeMs,
      blockages,
    )
    if (pullRequest === undefined || ci === undefined || ancestry === undefined) return []
    if (!pullRequestMatches(delivery, pullRequest)) {
      blockages.push({ kind: 'delivery-pr-mismatch', workItemId: item.workItemId })
    }
    if (ci.repositoryId !== delivery.repositoryId || ci.commitId !== delivery.commitId
      || summarizeCommitCi(ci).state !== 'successful') {
      blockages.push({ kind: 'delivery-ci-not-successful', workItemId: item.workItemId })
    }
    if (!ancestorComparisonMatches(ancestry, delivery.repositoryId, delivery.commitId, expected.releaseCommitId)) {
      blockages.push({ kind: 'delivery-ancestry-mismatch', workItemId: item.workItemId })
    }
    return [{
      deliveryId: delivery.deliveryId,
      deliveryRevision: delivery.revision,
      workItemId: delivery.workItemId,
      commitId: delivery.commitId,
      headRef: delivery.headRef,
      baseRef: delivery.baseRef,
      pullRequest,
      ci,
      acceptance,
      ancestry,
    }]
  })

  if (!tagMatches(tag, expected)) blockages.push({ kind: 'tag-mismatch' })
  if (release.kind !== 'present' || release.release.repositoryId !== expected.repositoryId
    || release.release.tagName !== expected.tagName || release.release.draft
    || release.release.publishedAt === undefined) {
    blockages.push({ kind: 'release-mismatch' })
  }
  if (releaseCommit.repositoryId !== expected.repositoryId || releaseCommit.id !== expected.releaseCommitId) {
    blockages.push({ kind: 'release-commit-mismatch' })
  }
  if (upstreamCommit.repositoryId !== expected.upstreamRepositoryId
    || upstreamCommit.id !== expected.upstreamCommitId) {
    blockages.push({ kind: 'upstream-commit-mismatch' })
  }
  if (!ancestorComparisonMatches(
    upstreamAncestry,
    expected.repositoryId,
    expected.upstreamCommitId,
    expected.releaseCommitId,
  )) {
    blockages.push({ kind: 'upstream-ancestry-mismatch' })
  }
  if (blockages.length > 0 || release.kind !== 'present') return { ok: false, blockages }

  const evidence = {
    projectId: expected.projectId,
    boardGeneration: board.generation,
    boardFingerprint: board.sourceFingerprint,
    milestoneId: milestone.id,
    milestoneNumber: milestone.number,
    milestone,
    scopeFingerprint: canonicalDigest(
      'saki/release-evidence-milestone-scope/v1',
      stripObservationTimes(milestone.issues),
    ),
    workItems: selected.map(item => ({
      workItemId: item.workItemId,
      issueId: item.issueId,
      status: item.status,
      remoteFingerprint: item.remoteFingerprint,
    })),
    deliveries: selectedDeliveries,
    tag: {
      reference: tag.reference,
      peel: tag.peel,
    },
    release: release.release,
    releaseCommit,
    upstreamRepositoryId: expected.upstreamRepositoryId,
    upstreamRepositoryDatabaseId: expected.upstreamRepositoryDatabaseId,
    upstreamRepositoryNameWithOwner: expected.upstreamRepositoryNameWithOwner,
    upstreamCommit,
    upstreamAncestry,
  }
  return {
    ok: true,
    digest: canonicalDigest('saki/release-evidence-policy/v1', stripObservationTimes(evidence)),
    comparisonDigest: releaseWorldComparisonDigest(evidence),
    evidence,
  }
}

function currentSource<T>(
  source: SakiTargetedEvidence<T>,
  name: string,
  pass: 'evaluation' | 'final-reread',
  requiredObservedAt: number,
  now: number,
  maxAgeMs: number,
  blockages: ReleaseEvidencePolicyV1Blockage[],
): T | undefined {
  const confirmed = source.confirmed
  if (confirmed === undefined) {
    blockages.push({ kind: 'source-unavailable', pass, source: name })
    return undefined
  }
  if (source.failure !== undefined && source.failure.failedAt >= confirmed.observedAt) {
    blockages.push({ kind: 'source-failed', pass, source: name })
    return undefined
  }
  if (source.invalidatedAt !== undefined && source.invalidatedAt >= confirmed.observedAt) {
    blockages.push({ kind: 'source-invalidated', pass, source: name })
    return undefined
  }
  if (confirmed.observedAt < requiredObservedAt || confirmed.observedAt > now
    || now - confirmed.observedAt > maxAgeMs) {
    blockages.push({ kind: 'source-stale', pass, source: name })
    return undefined
  }
  return confirmed.value
}

function pullRequestMatches(delivery: SakiReleaseDeliveryFact, pullRequest: GitHubPullRequestFact): boolean {
  return pullRequest.repositoryId === delivery.repositoryId
    && pullRequest.head.repositoryId === delivery.repositoryId
    && pullRequest.head.ref === branchName(delivery.headRef)
    && pullRequest.head.commitId === delivery.commitId
    && pullRequest.base.repositoryId === delivery.repositoryId
    && pullRequest.base.ref === branchName(delivery.baseRef)
    && (pullRequest.state === 'open' || pullRequest.merged)
}

function branchName(ref: string): string | undefined {
  const prefix = 'refs/heads/'
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : undefined
}

function ancestorComparisonMatches(
  comparison: GitHubCommitComparisonFact,
  repositoryId: GitHubRepositoryId,
  baseCommitId: GitHubCommitId,
  headCommitId: GitHubCommitId,
): boolean {
  return comparison.repositoryId === repositoryId
    && comparison.baseCommitId === baseCommitId
    && comparison.headCommitId === headCommitId
    && (comparison.status === 'ahead' || comparison.status === 'identical')
}

function tagMatches(
  tag: { readonly reference: GitHubTagReferenceFact; readonly peel: GitHubTagPeelFact },
  expected: Pick<ReleaseEvidencePolicyV1Expectation, 'repositoryId' | 'tagName' | 'releaseCommitId'>,
): boolean {
  if (tag.reference.repositoryId !== expected.repositoryId
    || tag.reference.tagName !== expected.tagName
    || tag.reference.ref !== `refs/tags/${expected.tagName}`
    || tag.peel.repositoryId !== expected.repositoryId
    || tag.peel.commitId !== expected.releaseCommitId) return false
  let target: GitHubTagTarget = tag.reference.target
  for (const object of tag.peel.tagObjects) {
    if (target.kind !== 'tag' || target.id !== object.id) return false
    target = object.target
  }
  return target.kind === 'commit' && target.id === tag.peel.commitId
}

function evidenceRelationshipsMatch(evidence: ReleaseEvidencePolicyV1Evidence): boolean {
  const repositoryId = evidence.milestone.repositoryId
  if (evidence.milestone.state !== 'open' || evidence.milestone.issues.length === 0
    || evidence.scopeFingerprint !== canonicalDigest(
      'saki/release-evidence-milestone-scope/v1',
      stripObservationTimes(evidence.milestone.issues),
    )
    || evidence.release.repositoryId !== repositoryId
    || evidence.release.draft
    || evidence.release.publishedAt === undefined
    || evidence.releaseCommit.repositoryId !== repositoryId
    || evidence.upstreamCommit.repositoryId !== evidence.upstreamRepositoryId
    || !tagMatches(evidence.tag, {
      repositoryId,
      tagName: evidence.release.tagName,
      releaseCommitId: evidence.releaseCommit.id,
    })
    || !ancestorComparisonMatches(
      evidence.upstreamAncestry,
      repositoryId,
      evidence.upstreamCommit.id,
      evidence.releaseCommit.id,
    )) return false

  const issues = new Set<GitHubIssueId>()
  for (const issue of evidence.milestone.issues) {
    if (issue.repositoryId !== repositoryId || issues.has(issue.id)) return false
    issues.add(issue.id)
  }
  const workItems = new Map<SakiBoardWorkItemId, ReleaseEvidencePolicyV1Evidence['workItems'][number]>()
  const mappedIssues = new Set<GitHubIssueId>()
  for (const item of evidence.workItems) {
    if (workItems.has(item.workItemId) || mappedIssues.has(item.issueId) || !issues.has(item.issueId)) return false
    workItems.set(item.workItemId, item)
    mappedIssues.add(item.issueId)
  }
  if (mappedIssues.size !== issues.size) return false

  const deliveryIds = new Set<string>()
  const deliveredWorkItems = new Set<SakiBoardWorkItemId>()
  for (const delivery of evidence.deliveries) {
    const item = workItems.get(delivery.workItemId)
    if (item?.status !== 'done' || deliveryIds.has(delivery.deliveryId)
      || deliveredWorkItems.has(delivery.workItemId)
      || delivery.acceptance.deliveryRevision !== delivery.deliveryRevision
      || delivery.acceptance.acceptedAt > evidence.confirmedAt
      || delivery.pullRequest.repositoryId !== repositoryId
      || delivery.pullRequest.head.repositoryId !== repositoryId
      || delivery.pullRequest.head.ref !== branchName(delivery.headRef)
      || delivery.pullRequest.head.commitId !== delivery.commitId
      || delivery.pullRequest.base.repositoryId !== repositoryId
      || delivery.pullRequest.base.ref !== branchName(delivery.baseRef)
      || (delivery.pullRequest.state !== 'open' && !delivery.pullRequest.merged)
      || delivery.ci.repositoryId !== repositoryId
      || delivery.ci.commitId !== delivery.commitId
      || summarizeCommitCi(delivery.ci).state !== 'successful'
      || !ancestorComparisonMatches(
        delivery.ancestry,
        repositoryId,
        delivery.commitId,
        evidence.releaseCommit.id,
      )) return false
    deliveryIds.add(delivery.deliveryId)
    deliveredWorkItems.add(delivery.workItemId)
  }

  return evidenceObservationTimes(evidence).every(observedAt => observedAt <= evidence.confirmedAt)
}

function evidenceObservationTimes(evidence: ReleaseEvidencePolicyV1Evidence): readonly number[] {
  return [
    evidence.milestone.observedAt,
    evidence.tag.reference.observedAt,
    evidence.tag.peel.observedAt,
    evidence.release.observedAt,
    evidence.releaseCommit.observedAt,
    evidence.upstreamCommit.observedAt,
    evidence.upstreamAncestry.observedAt,
    ...evidence.deliveries.flatMap(delivery => [
      delivery.pullRequest.observedAt,
      delivery.ci.observedAt,
      delivery.ancestry.observedAt,
    ]),
  ]
}

function stripObservationTimes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => stripObservationTimes(item))
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'observedAt')
    .map(([key, item]) => [key, stripObservationTimes(item)]))
}

function releaseWorldComparisonDigest(
  evidence: Omit<ReleaseEvidencePolicyV1Evidence, 'policy' | 'evaluationDigest' | 'confirmedAt'>,
): string {
  const { boardGeneration: _boardGeneration, ...facts } = evidence
  return canonicalDigest('saki/release-evidence-policy/final-reread/v1', stripObservationTimes(facts))
}
