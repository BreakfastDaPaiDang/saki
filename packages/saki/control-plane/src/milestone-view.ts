/** Safe, network-free projection of one Milestone Delivery and its targeted GitHub facts. */

import { canonicalDigest } from '@breakfastdapaidang/saki-execution'
import type {
  GitHubIssueId,
  GitHubProjectBoardFingerprint,
} from '@breakfastdapaidang/saki-github'
import {
  projectGitHubFailure,
  type SakiGitHubFailureProjection,
} from './github-failure-projection.ts'
import {
  projectMilestoneDelivery,
  type MilestoneDeliveryProjection,
  type MilestoneDeliveryRecord,
} from './milestone-delivery.ts'
import type {
  ReleaseEvidencePolicyV1Snapshot,
  SakiReleaseBoardFact,
  SakiTargetedEvidence,
} from './release-evidence-policy.ts'
import type {
  SakiBoardProjection,
  SakiBoardStatus,
  SakiBoardWorkItemId,
} from './types.ts'

/**
 * Adapt one complete Board projection into release-policy evidence.
 * @param board - current durable Board projection.
 * @param projectedAt - time used to invalidate a retained Board after configuration drift.
 * @returns the last confirmed generation plus any newer failure or invalidation.
 */
export function milestoneBoardEvidence(
  board: SakiBoardProjection,
  projectedAt: number,
): SakiTargetedEvidence<SakiReleaseBoardFact> {
  const confirmed = board.confirmed
  const checkpoint = board.checkpoint
  const currentFailure = board.failure
  const providerFailure = currentFailure?.failure.kind === 'provider'
    ? {
      failure: projectGitHubFailure(currentFailure.failure.failure),
      failedAt: currentFailure.failedAt,
    }
    : undefined
  const nonProviderFailure = currentFailure !== undefined && currentFailure.failure.kind !== 'provider'
    ? currentFailure
    : undefined
  const configurationInvalidated = confirmed !== undefined
    && (board.mapping.state === 'revalidation-required' || board.mapping.state === 'repair-required')
  const invalidatedAt = configurationInvalidated
    ? Math.max(projectedAt, nonProviderFailure?.failedAt ?? 0)
    : nonProviderFailure?.failedAt

  return {
    ...(confirmed === undefined || checkpoint === undefined
      ? {}
      : {
        confirmed: {
          value: {
            repositoryId: confirmed.repository.id,
            projectId: confirmed.project.id,
            generation: confirmed.generation,
            sourceFingerprint: structuredClone(checkpoint.sourceFingerprint),
            items: confirmed.items.map(item => ({
              workItemId: item.id,
              issueId: item.source.issueId,
              status: item.status,
              remoteFingerprint: item.remoteFingerprint,
            })),
          },
          observedAt: checkpoint.observedAt,
        },
      }),
    ...(providerFailure === undefined ? {} : { failure: providerFailure }),
    ...(invalidatedAt === undefined ? {} : { invalidatedAt }),
  }
}

/** Current health derived without discarding any last-confirmed targeted fact. */
export type MilestoneViewSourceState =
  | { readonly state: 'unobserved' }
  | { readonly state: 'confirmed'; readonly observedAt: number }
  | { readonly state: 'failure'; readonly failedAt: number; readonly failure: SakiGitHubFailureProjection }
  | { readonly state: 'invalidated'; readonly invalidatedAt: number }
  | { readonly state: 'stale'; readonly observedAt: number; readonly staleAt: number }

/** Browser-safe targeted source with independent confirmation and health evidence. */
export interface MilestoneViewSourceProjection<T> {
  readonly confirmed?: { readonly value: T; readonly observedAt: number } | undefined
  readonly failure?: { readonly failure: SakiGitHubFailureProjection; readonly failedAt: number } | undefined
  readonly invalidatedAt?: number | undefined
  readonly current: MilestoneViewSourceState
}

/** One GitHub Milestone Issue joined to its current Saki Work Item when available. */
export interface MilestoneViewScopeItem {
  readonly issueId: GitHubIssueId
  readonly number: number
  readonly state: 'open' | 'closed'
  readonly title: string
  readonly url: string
  readonly workItemId?: SakiBoardWorkItemId | undefined
  readonly status?: SakiBoardStatus | undefined
}

/** Exact Milestone scope and status distribution from one confirmed Board generation. */
export interface MilestoneViewScope {
  readonly scopeFingerprint: string
  readonly boardGeneration: number
  readonly boardFingerprint: GitHubProjectBoardFingerprint
  readonly total: number
  readonly mapped: number
  readonly unmapped: number
  readonly unsupported: number
  readonly complete: boolean
  readonly statusCounts: Readonly<Record<SakiBoardStatus, number>>
  readonly items: readonly MilestoneViewScopeItem[]
}

/** Typed reason the View cannot present a complete joined Milestone scope. */
export type MilestoneViewBlockage =
  | {
    readonly kind: 'view-source'
    readonly source: 'board' | 'milestone'
    readonly state: Exclude<MilestoneViewSourceState['state'], 'confirmed'>
  }
  | { readonly kind: 'milestone-target-mismatch' }
  | { readonly kind: 'scope-unmapped'; readonly issueId: GitHubIssueId }

/** Complete Milestone View projection over existing authoritative records and facts. */
export interface MilestoneViewProjection {
  readonly delivery: MilestoneDeliveryProjection
  readonly sources: {
    readonly board: MilestoneViewSourceProjection<NonNullable<ReleaseEvidencePolicyV1Snapshot['board']['confirmed']>['value']>
    readonly milestone: MilestoneViewSourceProjection<NonNullable<ReleaseEvidencePolicyV1Snapshot['milestone']['confirmed']>['value']>
    readonly tag: MilestoneViewSourceProjection<NonNullable<ReleaseEvidencePolicyV1Snapshot['tag']['confirmed']>['value']>
    readonly release: MilestoneViewSourceProjection<NonNullable<ReleaseEvidencePolicyV1Snapshot['release']['confirmed']>['value']>
    readonly releaseCommit: MilestoneViewSourceProjection<NonNullable<ReleaseEvidencePolicyV1Snapshot['releaseCommit']['confirmed']>['value']>
    readonly upstreamCommit: MilestoneViewSourceProjection<NonNullable<ReleaseEvidencePolicyV1Snapshot['upstreamCommit']['confirmed']>['value']>
    readonly upstreamAncestry: MilestoneViewSourceProjection<NonNullable<ReleaseEvidencePolicyV1Snapshot['upstreamAncestry']['confirmed']>['value']>
  }
  readonly scope?: MilestoneViewScope | undefined
  readonly blockages: readonly MilestoneViewBlockage[]
}

/**
 * Project one Milestone without reads, writes, or a second readiness policy.
 * @param record - current Saki-owned Milestone Delivery.
 * @param board - independently retained complete Board-generation evidence.
 * @param now - projection time used only to derive staleness.
 * @param freshForMs - maximum age of a currently confirmed source.
 * @returns safe source health, exact scope join, phase, repair, and release facts.
 */
export function projectMilestoneView(
  record: MilestoneDeliveryRecord,
  board: SakiTargetedEvidence<SakiReleaseBoardFact>,
  now: number,
  freshForMs: number,
): MilestoneViewProjection {
  const sources = {
    board: projectSource(board, now, freshForMs),
    milestone: projectSource(record.sources.milestone, now, freshForMs),
    tag: projectSource(record.sources.tag, now, freshForMs),
    release: projectSource(record.sources.release, now, freshForMs),
    releaseCommit: projectSource(record.sources.releaseCommit, now, freshForMs),
    upstreamCommit: projectSource(record.sources.upstreamCommit, now, freshForMs),
    upstreamAncestry: projectSource(record.sources.upstreamAncestry, now, freshForMs),
  }
  const blockages: MilestoneViewBlockage[] = []
  addSourceBlockage(blockages, 'board', sources.board.current)
  addSourceBlockage(blockages, 'milestone', sources.milestone.current)

  let scope: MilestoneViewScope | undefined
  const boardFact = sources.board.current.state === 'confirmed' ? sources.board.confirmed?.value : undefined
  const milestone = sources.milestone.current.state === 'confirmed' ? sources.milestone.confirmed?.value : undefined
  if (boardFact !== undefined && milestone !== undefined) {
    if (boardFact.repositoryId !== record.release.repositoryId
      || boardFact.projectId !== record.release.projectId
      || milestone.repositoryId !== record.release.repositoryId
      || milestone.id !== record.release.milestoneId
      || milestone.number !== record.release.milestoneNumber) {
      blockages.push({ kind: 'milestone-target-mismatch' })
    } else {
      const boardByIssue = new Map(boardFact.items.map(item => [item.issueId, item] as const))
      const statusCounts = emptyStatusCounts()
      let mapped = 0
      let unmapped = 0
      const items = milestone.issues.map((issue): MilestoneViewScopeItem => {
        const common = {
          issueId: issue.id,
          number: issue.number,
          state: issue.state,
          title: issue.title,
          url: issue.url,
        }
        const workItem = boardByIssue.get(issue.id)
        if (workItem === undefined) {
          unmapped += 1
          blockages.push({ kind: 'scope-unmapped', issueId: issue.id })
          return common
        }
        mapped += 1
        statusCounts[workItem.status] += 1
        return { ...common, workItemId: workItem.workItemId, status: workItem.status }
      })
      scope = {
        scopeFingerprint: canonicalDigest('saki/release-evidence-milestone-scope/v1', milestone.issues),
        boardGeneration: boardFact.generation,
        boardFingerprint: structuredClone(boardFact.sourceFingerprint),
        total: milestone.issues.length,
        mapped,
        unmapped,
        unsupported: 0,
        complete: unmapped === 0,
        statusCounts,
        items,
      }
    }
  }

  return {
    delivery: projectMilestoneDelivery(record, record.sources.milestone),
    sources,
    ...(scope === undefined ? {} : { scope }),
    blockages,
  }
}

function projectSource<T>(
  source: SakiTargetedEvidence<T>,
  now: number,
  freshForMs: number,
): MilestoneViewSourceProjection<T> {
  const confirmed = source.confirmed === undefined
    ? {}
    : { confirmed: structuredClone(source.confirmed) }
  const failure = source.failure === undefined
    ? undefined
    : {
      failure: projectGitHubFailure(source.failure.failure),
      failedAt: source.failure.failedAt,
    }
  const observedAt = source.confirmed?.observedAt
  let current: MilestoneViewSourceState
  if (failure !== undefined && (observedAt === undefined || failure.failedAt >= observedAt)) {
    current = { state: 'failure', ...structuredClone(failure) }
  } else if (source.invalidatedAt !== undefined
    && (observedAt === undefined || source.invalidatedAt >= observedAt)) {
    current = { state: 'invalidated', invalidatedAt: source.invalidatedAt }
  } else if (observedAt === undefined) {
    current = { state: 'unobserved' }
  } else if (now > observedAt + freshForMs) {
    current = { state: 'stale', observedAt, staleAt: observedAt + freshForMs }
  } else {
    current = { state: 'confirmed', observedAt }
  }
  return {
    ...confirmed,
    ...(failure === undefined ? {} : { failure }),
    ...(source.invalidatedAt === undefined ? {} : { invalidatedAt: source.invalidatedAt }),
    current,
  }
}

function addSourceBlockage(
  blockages: MilestoneViewBlockage[],
  source: 'board' | 'milestone',
  state: MilestoneViewSourceState,
): void {
  if (state.state !== 'confirmed') blockages.push({ kind: 'view-source', source, state: state.state })
}

function emptyStatusCounts(): Record<SakiBoardStatus, number> {
  return {
    inbox: 0,
    backlog: 0,
    ready: 0,
    'in-progress': 0,
    'in-review': 0,
    done: 0,
    canceled: 0,
  }
}
