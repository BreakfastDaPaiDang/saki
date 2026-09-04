/** Fixed targeted-reader orchestration for version-one release snapshots. */

import {
  GitHubProviderError,
  type GitHubCommitComparisonFact,
  type GitHubInstallationProfile,
  type GitHubPullRequestFact,
  type GitHubReleaseByTagObservation,
  type GitHubTagPeelFact,
  type GitHubTagReferenceFact,
  type GitHubTagTarget,
  type SakiGitHub,
} from '@breakfastdapaidang/saki-github'
import type {
  BranchDeliveryRecord,
  BranchDeliverySourceObservation,
} from './branch-delivery.ts'
import type { MilestoneDeliverySources } from './milestone-delivery.ts'
import type {
  ReleaseEvidencePolicyV1Expectation,
  ReleaseEvidencePolicyV1Snapshot,
  SakiTargetedEvidence,
} from './release-evidence-policy.ts'
import { assembleReleaseSnapshot, type ReleaseSnapshotDeliveryInput } from './release-snapshot.ts'
import type { DevelopmentProjectRecord } from './spec.ts'
import type { GitHubSynchronizationConfiguration } from './types.ts'

/** Current trusted inputs required to read one complete fixed-policy snapshot. */
export interface ReadReleaseSnapshotV1Input {
  readonly project: DevelopmentProjectRecord
  readonly github: Pick<SakiGitHub, 'read'>
  readonly configuration: GitHubSynchronizationConfiguration
  readonly expected: ReleaseEvidencePolicyV1Expectation
  readonly milestoneSources: MilestoneDeliverySources
  readonly branchDeliveries: readonly BranchDeliveryRecord[]
  readonly board: ReleaseEvidencePolicyV1Snapshot['board']
}

/**
 * Read every fixed V1 release source and assemble one detached policy snapshot.
 * @param input - current Project, Product App configuration, durable confirmations, and fixed release target.
 * @param signal - required caller lifetime and cancellation.
 * @returns one snapshot retaining prior confirmation when a targeted source fails or changes identity.
 */
export async function readReleaseSnapshotV1(
  input: ReadReleaseSnapshotV1Input,
  signal: AbortSignal,
): Promise<ReleaseEvidencePolicyV1Snapshot> {
  assertCurrentTarget(input)
  const installation = installationProfile(input.configuration)
  const mainTarget = {
    installation,
    repositoryId: input.expected.repositoryId,
    repositoryDatabaseId: input.configuration.repositoryDatabaseId,
  }
  const milestone = await readTargeted(
    input.milestoneSources.milestone,
    () => input.github.read<'milestone'>({
      kind: 'milestone',
      ...mainTarget,
      milestoneId: input.expected.milestoneId,
      milestoneNumber: input.expected.milestoneNumber,
    }, signal),
    fact => fact.repositoryId === input.expected.repositoryId
      && fact.id === input.expected.milestoneId
      && fact.number === input.expected.milestoneNumber,
    fact => fact.observedAt,
    signal,
  )
  const tag = await readTag(input, installation, signal)
  const release = await readTargeted(
    input.milestoneSources.release,
    () => input.github.read<'release-by-tag'>({
      kind: 'release-by-tag',
      ...mainTarget,
      tagName: input.expected.tagName,
    }, signal),
    fact => releaseTarget(fact).repositoryId === input.expected.repositoryId
      && releaseTarget(fact).tagName === input.expected.tagName,
    fact => releaseTarget(fact).observedAt,
    signal,
  )
  const releaseCommit = await readTargeted(
    input.milestoneSources.releaseCommit,
    () => input.github.read<'commit'>({
      kind: 'commit',
      ...mainTarget,
      commitId: input.expected.releaseCommitId,
    }, signal),
    fact => fact.repositoryId === input.expected.repositoryId && fact.id === input.expected.releaseCommitId,
    fact => fact.observedAt,
    signal,
  )
  const upstreamCommit = await readTargeted(
    input.milestoneSources.upstreamCommit,
    () => input.github.read<'public-commit'>({
      kind: 'public-commit',
      repositoryId: input.expected.upstreamRepositoryId,
      repositoryDatabaseId: input.expected.upstreamRepositoryDatabaseId,
      repositoryNameWithOwner: input.expected.upstreamRepositoryNameWithOwner,
      commitId: input.expected.upstreamCommitId,
    }, signal),
    fact => fact.repositoryId === input.expected.upstreamRepositoryId && fact.id === input.expected.upstreamCommitId,
    fact => fact.observedAt,
    signal,
  )
  const upstreamAncestry = await readTargeted(
    input.milestoneSources.upstreamAncestry,
    () => input.github.read<'compare-commits'>({
      kind: 'compare-commits',
      ...mainTarget,
      baseCommitId: input.expected.upstreamCommitId,
      headCommitId: input.expected.releaseCommitId,
    }, signal),
    fact => comparisonTargets(
      fact,
      input.expected.repositoryId,
      input.expected.upstreamCommitId,
      input.expected.releaseCommitId,
    ),
    fact => fact.observedAt,
    signal,
  )
  const deliveries = await readDoneDeliveries(input, milestone, installation, signal)
  signal.throwIfAborted()

  return assembleReleaseSnapshot({
    developmentProjectId: input.project.id,
    capturedAt: Date.now(),
    board: input.board,
    milestone,
    deliveries,
    tag,
    release,
    releaseCommit,
    upstreamCommit,
    upstreamAncestry,
  })
}

function assertCurrentTarget(input: ReadReleaseSnapshotV1Input): void {
  if (input.configuration.repositoryNodeId !== input.expected.repositoryId
    || input.configuration.projectNodeId !== input.expected.projectId) {
    throw new TypeError('release snapshot target disagrees with the active GitHub configuration')
  }
  if (input.branchDeliveries.some(delivery => delivery.projectId !== input.project.id)) {
    throw new TypeError('release snapshot Branch Delivery belongs to another Development Project')
  }
}

function installationProfile(configuration: GitHubSynchronizationConfiguration): GitHubInstallationProfile {
  return {
    appId: configuration.appId,
    installationId: configuration.githubInstallationId,
    accountId: configuration.accountNodeId,
    privateKeyRef: configuration.credentialRef,
  }
}

async function readTag(
  input: ReadReleaseSnapshotV1Input,
  installation: GitHubInstallationProfile,
  signal: AbortSignal,
): Promise<ReleaseEvidencePolicyV1Snapshot['tag']> {
  const current = input.milestoneSources.tag
  let reference: GitHubTagReferenceFact
  try {
    signal.throwIfAborted()
    reference = await input.github.read<'tag-reference'>({
      kind: 'tag-reference',
      installation,
      repositoryId: input.expected.repositoryId,
      repositoryDatabaseId: input.configuration.repositoryDatabaseId,
      tagName: input.expected.tagName,
    }, signal)
    signal.throwIfAborted()
  } catch (error) {
    return failedEvidence(current, error)
  }
  if (reference.repositoryId !== input.expected.repositoryId
    || reference.tagName !== input.expected.tagName
    || reference.ref !== `refs/tags/${input.expected.tagName}`) {
    return invalidatedEvidence(current)
  }

  let peel: GitHubTagPeelFact
  try {
    peel = await input.github.read<'tag-object'>({
      kind: 'tag-object',
      installation,
      repositoryId: input.expected.repositoryId,
      repositoryDatabaseId: input.configuration.repositoryDatabaseId,
      target: reference.target,
    }, signal)
    signal.throwIfAborted()
  } catch (error) {
    return failedEvidence(current, error)
  }
  if (peel.repositoryId !== input.expected.repositoryId || !peelStartsAt(peel, reference.target)) {
    return invalidatedEvidence(current)
  }
  return confirmedEvidence({ reference, peel }, Math.min(reference.observedAt, peel.observedAt))
}

async function readDoneDeliveries(
  input: ReadReleaseSnapshotV1Input,
  milestone: ReleaseEvidencePolicyV1Snapshot['milestone'],
  installation: GitHubInstallationProfile,
  signal: AbortSignal,
): Promise<readonly ReleaseSnapshotDeliveryInput[]> {
  const scopedIssues = new Set(milestone.confirmed?.value.issues
    .filter(issue => issue.repositoryId === input.expected.repositoryId)
    .map(issue => issue.id) ?? [])
  const doneWorkItems = new Set(input.board.confirmed?.value.items
    .filter(item => item.status === 'done' && scopedIssues.has(item.issueId))
    .map(item => item.workItemId) ?? [])
  const results: ReleaseSnapshotDeliveryInput[] = []
  for (const record of input.branchDeliveries) {
    if (!doneWorkItems.has(record.workItemId)) continue
    results.push(await readDelivery(input, record, installation, signal))
  }
  return results
}

async function readDelivery(
  input: ReadReleaseSnapshotV1Input,
  record: BranchDeliveryRecord,
  installation: GitHubInstallationProfile,
  signal: AbortSignal,
): Promise<ReleaseSnapshotDeliveryInput> {
  const pullRequestCurrent = branchEvidence(record.pullRequest)
  const ciCurrent = branchEvidence(record.ci)
  const currentRepository = record.target.repository.id === input.expected.repositoryId
    && record.target.repository.databaseId === input.configuration.repositoryDatabaseId
  if (!currentRepository) {
    return {
      record,
      pullRequest: invalidatedEvidence(pullRequestCurrent),
      ci: invalidatedEvidence(ciCurrent),
      ancestry: { invalidatedAt: Date.now() },
    }
  }
  const target = {
    installation,
    repositoryId: input.expected.repositoryId,
    repositoryDatabaseId: input.configuration.repositoryDatabaseId,
  }
  const knownPullRequest = record.pullRequest.confirmed?.fact
  const pullRequest = knownPullRequest === undefined
    ? invalidatedEvidence(pullRequestCurrent)
    : await readTargeted(
      pullRequestCurrent,
      () => input.github.read<'pull-request'>({
        kind: 'pull-request',
        ...target,
        pullRequestId: knownPullRequest.id,
        pullRequestNumber: knownPullRequest.number,
      }, signal),
      fact => pullRequestTargets(fact, knownPullRequest, record),
      fact => fact.observedAt,
      signal,
    )
  const ci = await readTargeted(
    ciCurrent,
    () => input.github.read<'commit-ci'>({ kind: 'commit-ci', ...target, commitId: record.commitId }, signal),
    fact => fact.repositoryId === input.expected.repositoryId && fact.commitId === record.commitId,
    fact => fact.observedAt,
    signal,
  )
  const ancestry = await readTargeted<GitHubCommitComparisonFact>(
    {},
    () => input.github.read<'compare-commits'>({
      kind: 'compare-commits',
      ...target,
      baseCommitId: record.commitId,
      headCommitId: input.expected.releaseCommitId,
    }, signal),
    fact => comparisonTargets(
      fact,
      input.expected.repositoryId,
      record.commitId,
      input.expected.releaseCommitId,
    ),
    fact => fact.observedAt,
    signal,
  )
  return { record, pullRequest, ci, ancestry }
}

async function readTargeted<T>(
  current: SakiTargetedEvidence<T>,
  read: () => Promise<T>,
  targets: (fact: T) => boolean,
  observedAt: (fact: T) => number,
  signal: AbortSignal,
): Promise<SakiTargetedEvidence<T>> {
  try {
    signal.throwIfAborted()
    const fact = await read()
    signal.throwIfAborted()
    return targets(fact) ? confirmedEvidence(fact, observedAt(fact)) : invalidatedEvidence(current)
  } catch (error) {
    return failedEvidence(current, error)
  }
}

function confirmedEvidence<T>(value: T, observedAt: number): SakiTargetedEvidence<T> {
  return { confirmed: { value: structuredClone(value), observedAt } }
}

function retainedConfirmation<T>(current: SakiTargetedEvidence<T>): SakiTargetedEvidence<T> {
  return current.confirmed === undefined ? {} : { confirmed: structuredClone(current.confirmed) }
}

function failedEvidence<T>(current: SakiTargetedEvidence<T>, error: unknown): SakiTargetedEvidence<T> {
  if (!(error instanceof GitHubProviderError)) throw error
  return {
    ...retainedConfirmation(current),
    failure: { failure: structuredClone(error.failure), failedAt: Date.now() },
  }
}

function invalidatedEvidence<T>(current: SakiTargetedEvidence<T>): SakiTargetedEvidence<T> {
  return { ...retainedConfirmation(current), invalidatedAt: Date.now() }
}

function branchEvidence<T extends { readonly observedAt: number }>(
  source: BranchDeliverySourceObservation<T>,
): SakiTargetedEvidence<T> {
  const confirmed = source.confirmed === undefined
    ? {}
    : { confirmed: { value: structuredClone(source.confirmed.fact), observedAt: source.confirmed.fact.observedAt } }
  if (source.current.state === 'failure') {
    return {
      ...confirmed,
      failure: { failure: structuredClone(source.current.failure), failedAt: source.current.failedAt },
    }
  }
  if (source.current.state === 'invalidated') {
    return { ...confirmed, invalidatedAt: source.current.invalidatedAt }
  }
  return confirmed
}

function releaseTarget(value: GitHubReleaseByTagObservation) {
  return value.kind === 'present' ? value.release : value
}

function peelStartsAt(peel: GitHubTagPeelFact, target: GitHubTagTarget): boolean {
  const [first] = peel.tagObjects
  return target.kind === 'commit'
    ? first === undefined && peel.commitId === target.id
    : first?.id === target.id
}

function pullRequestTargets(
  fact: GitHubPullRequestFact,
  known: GitHubPullRequestFact,
  record: BranchDeliveryRecord,
): boolean {
  return fact.id === known.id
    && fact.number === known.number
    && fact.repositoryId === record.target.repository.id
    && fact.head.repositoryId === record.target.repository.id
    && fact.base.repositoryId === record.target.repository.id
    && fact.head.ref === branchName(record.headRef)
    && fact.base.ref === branchName(record.baseRef)
    && fact.head.commitId === record.commitId
}

function branchName(ref: string): string {
  return ref.slice('refs/heads/'.length)
}

function comparisonTargets(
  fact: GitHubCommitComparisonFact,
  repositoryId: ReleaseEvidencePolicyV1Expectation['repositoryId'],
  baseCommitId: ReleaseEvidencePolicyV1Expectation['releaseCommitId'],
  headCommitId: ReleaseEvidencePolicyV1Expectation['releaseCommitId'],
): boolean {
  return fact.repositoryId === repositoryId
    && fact.baseCommitId === baseCommitId
    && fact.headCommitId === headCommitId
}
