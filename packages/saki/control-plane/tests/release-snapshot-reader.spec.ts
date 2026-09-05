import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  GitHubCommitCiFact,
  GitHubCommitComparisonFact,
  GitHubCommitFact,
  GitHubCommitId,
  GitHubIssueId,
  GitHubMilestoneFact,
  GitHubMilestoneId,
  GitHubProjectId,
  GitHubPullRequestFact,
  GitHubPullRequestId,
  GitHubReadRequest,
  GitHubReleaseByTagObservation,
  GitHubReleaseTagName,
  GitHubRepositoryDatabaseId,
  GitHubRepositoryId,
  GitHubTagObjectId,
  GitHubTagPeelFact,
  GitHubTagReferenceFact,
  SakiGitHub,
} from '@breakfastdapaidang/saki-github'
import {
  GitHubProviderError,
  githubCommitStatusId,
  githubReleaseId,
} from '@breakfastdapaidang/saki-github'
import { branchDeliveryId, type BranchDeliveryRecord } from '../src/branch-delivery.ts'
import { SAKI_PROJECT_PROJECTION_FIXTURES } from '../src/fixtures.ts'
import { sakiHostIdSchema } from '../src/ids.ts'
import type { MilestoneDeliverySources } from '../src/milestone-delivery.ts'
import type { ReleaseEvidencePolicyV1Expectation, ReleaseEvidencePolicyV1Snapshot } from '../src/release-evidence-policy.ts'
import { readReleaseSnapshotV1, type ReadReleaseSnapshotV1Input } from '../src/release-snapshot-reader.ts'
import type { DevelopmentProjectRecord } from '../src/spec.ts'
import type {
  GitHubSynchronizationConfiguration,
  SakiBoardRemoteFingerprint,
  SakiBoardWorkItemId,
  SakiControlIntentId,
  SakiDevelopmentProjectId,
} from '../src/types.ts'

const DEVELOPMENT_PROJECT_ID = 'project-00000000-0000-4000-8000-000000000801' as SakiDevelopmentProjectId
const REPOSITORY_ID = 'R_release_reader' as GitHubRepositoryId
const REPOSITORY_DATABASE_ID = '801' as GitHubRepositoryDatabaseId
const UPSTREAM_REPOSITORY_ID = 'R_upstream_reader' as GitHubRepositoryId
const UPSTREAM_REPOSITORY_DATABASE_ID = '802' as GitHubRepositoryDatabaseId
const GITHUB_PROJECT_ID = 'P_release_reader' as GitHubProjectId
const MILESTONE_ID = 'M_release_reader' as GitHubMilestoneId
const ISSUE_ID = 'I_release_reader' as GitHubIssueId
const WORK_ITEM_ID = `work-item-${'8'.repeat(64)}` as SakiBoardWorkItemId
const OUT_OF_SCOPE_WORK_ITEM_ID = `work-item-${'7'.repeat(64)}` as SakiBoardWorkItemId
const REMOTE_FINGERPRINT = `remote-fingerprint-${'9'.repeat(64)}` as SakiBoardRemoteFingerprint
const DELIVERY_COMMIT_ID = '1'.repeat(40) as GitHubCommitId
const RELEASE_COMMIT_ID = '2'.repeat(40) as GitHubCommitId
const UPSTREAM_COMMIT_ID = '3'.repeat(40) as GitHubCommitId
const TAG_NAME = 'saki-v0.1.0' as GitHubReleaseTagName
const TAG_OBJECT_ID = 'T_release_reader' as GitHubTagObjectId
const PULL_REQUEST_ID = 'PR_release_reader' as GitHubPullRequestId
const INTENT_ID = 'intent-00000000-0000-4000-8000-000000000802' as SakiControlIntentId

const PROJECT = {
  id: DEVELOPMENT_PROJECT_ID,
  revision: 4,
  projectTitle: 'Release reader',
  resourceBindingId: 'binding-00000000-0000-4000-8000-000000000803',
  state: 'active',
  defaultAgentProfileId: 'agent-profile-00000000-0000-4000-8000-000000000804',
  createdAt: 10,
} as DevelopmentProjectRecord

const CONFIGURATION = {
  appId: '801',
  githubInstallationId: '802',
  accountNodeId: 'O_release_reader',
  repositoryNodeId: REPOSITORY_ID,
  repositoryDatabaseId: REPOSITORY_DATABASE_ID,
  projectNodeId: GITHUB_PROJECT_ID,
  credentialRef: credentialRef('SAKI_PRODUCT_PRIVATE_KEY'),
  statusFieldNodeId: 'PVTF_release_reader',
  statusOptionNodeIds: {
    inbox: 'PVTO_inbox',
    backlog: 'PVTO_backlog',
    ready: 'PVTO_ready',
    inProgress: 'PVTO_progress',
    inReview: 'PVTO_review',
    done: 'PVTO_done',
    canceled: 'PVTO_canceled',
  },
  activePollIntervalMs: 1_000,
  backgroundPollIntervalMs: 5_000,
  rateLimitReserve: 50,
} as GitHubSynchronizationConfiguration

const EXPECTED = {
  repositoryId: REPOSITORY_ID,
  projectId: GITHUB_PROJECT_ID,
  milestoneId: MILESTONE_ID,
  milestoneNumber: 1,
  tagName: TAG_NAME,
  releaseCommitId: RELEASE_COMMIT_ID,
  upstreamRepositoryId: UPSTREAM_REPOSITORY_ID,
  upstreamRepositoryDatabaseId: UPSTREAM_REPOSITORY_DATABASE_ID,
  upstreamRepositoryNameWithOwner: 'deepseek-ai/deepseek-harness',
  upstreamCommitId: UPSTREAM_COMMIT_ID,
} satisfies ReleaseEvidencePolicyV1Expectation

const BOARD = {
  confirmed: {
    observedAt: 180,
    value: {
      repositoryId: REPOSITORY_ID,
      projectId: GITHUB_PROJECT_ID,
      generation: 3,
      sourceFingerprint: { version: 1, digest: 'a'.repeat(64) },
      items: [{
        workItemId: WORK_ITEM_ID,
        issueId: ISSUE_ID,
        status: 'done',
        remoteFingerprint: REMOTE_FINGERPRINT,
      }],
    },
  },
} satisfies ReleaseEvidencePolicyV1Snapshot['board']

describe('readReleaseSnapshotV1', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each(['configuration', 'delivery project'] as const)('rejects a changed %s before reading any sources', async (mode) => {
    const read = vi.fn(async (request: GitHubReadRequest) => successfulFact(request))
    const input = readerInput(read)
    const changed = mode === 'configuration'
      ? { ...input, configuration: { ...CONFIGURATION, repositoryNodeId: UPSTREAM_REPOSITORY_ID } }
      : { ...input, branchDeliveries: [{ ...delivery(), projectId: 'project-00000000-0000-4000-8000-000000000899' as SakiDevelopmentProjectId }] }
    await expect(readReleaseSnapshotV1(changed, new AbortController().signal)).rejects.toBeInstanceOf(TypeError)
    expect(read).not.toHaveBeenCalled()
  })

  it.each(['reference failure', 'peel failure', 'reference mismatch', 'peel mismatch', 'lightweight', 'missing annotated object'] as const)(
    'preserves independent tag observation: %s', async (mode) => {
      const read = vi.fn(async (request: GitHubReadRequest) => {
        if ((request.kind === 'tag-reference' && mode === 'reference failure')
          || (request.kind === 'tag-object' && mode === 'peel failure')) {
          throw new GitHubProviderError({ code: 'not-found', resource: request.kind })
        }
        if (request.kind === 'tag-reference') return {
          repositoryId: REPOSITORY_ID, tagName: TAG_NAME,
          ref: mode === 'reference mismatch' ? 'refs/tags/another-release' : `refs/tags/${TAG_NAME}`,
          target: mode === 'lightweight' ? { kind: 'commit', id: RELEASE_COMMIT_ID } : { kind: 'tag', id: TAG_OBJECT_ID },
          observedAt: 190,
        } satisfies GitHubTagReferenceFact
        if (request.kind === 'tag-object') return {
          repositoryId: mode === 'peel mismatch' ? UPSTREAM_REPOSITORY_ID : REPOSITORY_ID,
          tagObjects: mode === 'lightweight' || mode === 'missing annotated object' ? []
            : [{ id: TAG_OBJECT_ID, target: { kind: 'commit', id: RELEASE_COMMIT_ID } }],
          commitId: RELEASE_COMMIT_ID, observedAt: 191,
        } satisfies GitHubTagPeelFact
        return successfulFact(request)
      })
      const snapshot = await readReleaseSnapshotV1(readerInput(read), new AbortController().signal)
      if (mode === 'lightweight') expect(snapshot.tag).toMatchObject({ confirmed: { observedAt: 190,
        value: { reference: { target: { kind: 'commit' } }, peel: { tagObjects: [], commitId: RELEASE_COMMIT_ID } } } })
      else if (mode === 'reference failure' || mode === 'peel failure') expect(snapshot.tag).toMatchObject({ failure: { failure: { code: 'not-found' } } })
      else expect(snapshot.tag).toHaveProperty('invalidatedAt')
      expect(snapshot.releaseCommit.confirmed?.value.id).toBe(RELEASE_COMMIT_ID)
      if (mode === 'reference failure' || mode === 'reference mismatch') expect(read.mock.calls.some(([request]) => request.kind === 'tag-object')).toBe(false)
    })

  it.each(['unobserved board', 'unobserved milestone', 'foreign milestone issue', 'not Done'] as const)(
    'does not read deliveries without confirmed scope: %s', async (mode) => {
      const read = vi.fn(async (request: GitHubReadRequest) => {
        if (request.kind === 'milestone' && mode === 'unobserved milestone') throw new GitHubProviderError({ code: 'not-found', resource: 'milestone' })
        if (request.kind === 'milestone' && mode === 'foreign milestone issue') {
          const fact = milestone(190)
          return { ...fact, issues: fact.issues.map(issue => ({ ...issue, repositoryId: UPSTREAM_REPOSITORY_ID })) }
        }
        return successfulFact(request)
      })
      const input = readerInput(read)
      const board = mode === 'unobserved board' ? {} : mode === 'not Done'
        ? { confirmed: { ...BOARD.confirmed, value: { ...BOARD.confirmed.value,
          items: BOARD.confirmed.value.items.map(item => ({ ...item, status: 'in-review' as const })) } } }
        : BOARD
      const snapshot = await readReleaseSnapshotV1({ ...input, board }, new AbortController().signal)
      expect(snapshot.deliveries).toEqual([])
      expect(read.mock.calls.some(([request]) => request.kind === 'pull-request' || request.kind === 'commit-ci')).toBe(false)
    })

  it.each(['repository changed', 'no Pull Request', 'failed source', 'invalidated source'] as const)(
    'retains delivery evidence while handling %s', async (mode) => {
      vi.spyOn(Date, 'now').mockReturnValue(220)
      const current = delivery()
      if (mode === 'repository changed') current.target.repository.id = UPSTREAM_REPOSITORY_ID
      if (mode === 'no Pull Request') current.pullRequest = { current: { state: 'unobserved' } }
      if (mode === 'failed source') current.pullRequest.current = {
        state: 'failure', failure: { code: 'not-found', resource: 'pull-request' }, failedAt: 170,
      }
      if (mode === 'invalidated source') current.ci.current = { state: 'invalidated', invalidatedAt: 170, reason: 'target-changed' }
      const read = vi.fn(async (request: GitHubReadRequest) => {
        if (mode === 'failed source' && request.kind === 'pull-request') throw new GitHubProviderError({ code: 'transient-transport' })
        if (mode === 'invalidated source' && request.kind === 'commit-ci') return { ...commitCi(190), commitId: RELEASE_COMMIT_ID }
        return successfulFact(request)
      })
      const snapshot = await readReleaseSnapshotV1({ ...readerInput(read), branchDeliveries: [current] }, new AbortController().signal)
      const result = snapshot.deliveries[0]
      expect(result).toBeDefined()
      if (mode === 'repository changed') {
        expect(result).toMatchObject({ pullRequest: { confirmed: { observedAt: 160 }, invalidatedAt: 220 },
          ci: { confirmed: { observedAt: 160 }, invalidatedAt: 220 }, ancestry: { invalidatedAt: 220 } })
        expect(read.mock.calls.some(([request]) => request.kind === 'pull-request' || request.kind === 'commit-ci')).toBe(false)
      } else if (mode === 'no Pull Request') {
        expect(result?.pullRequest).toEqual({ invalidatedAt: 220 })
        expect(read.mock.calls.some(([request]) => request.kind === 'pull-request')).toBe(false)
      } else if (mode === 'failed source') expect(result?.pullRequest).toMatchObject({ confirmed: { observedAt: 160 }, failure: { failure: { code: 'transient-transport' } } })
      else expect(result?.ci).toMatchObject({ confirmed: { observedAt: 160 }, invalidatedAt: 220 })
    })

  it.each(['before reading', 'tag reference', 'tag peel', 'final delivery'] as const)(
    'propagates cancellation %s without returning a partial snapshot', async (mode) => {
      const controller = new AbortController()
      const reason = new Error('release snapshot canceled')
      if (mode === 'before reading') controller.abort(reason)
      const read = vi.fn(async (request: GitHubReadRequest) => {
        if ((mode === 'tag reference' && request.kind === 'tag-reference')
          || (mode === 'tag peel' && request.kind === 'tag-object')
          || (mode === 'final delivery' && request.kind === 'compare-commits' && request.baseCommitId === DELIVERY_COMMIT_ID)) controller.abort(reason)
        return successfulFact(request)
      })
      await expect(readReleaseSnapshotV1(readerInput(read), controller.signal)).rejects.toBe(reason)
      if (mode === 'before reading') expect(read).not.toHaveBeenCalled()
    })

  it('reads every fixed global and Done-delivery source through exact authenticated or public requests', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(200)
    const read = vi.fn(async (request: GitHubReadRequest) => successfulFact(request))
    const outOfScopeDelivery = {
      ...delivery(),
      id: branchDeliveryId(DEVELOPMENT_PROJECT_ID, OUT_OF_SCOPE_WORK_ITEM_ID),
      workItemId: OUT_OF_SCOPE_WORK_ITEM_ID,
    }
    const snapshot = await readReleaseSnapshotV1({
      project: PROJECT,
      github: { read } as unknown as Pick<SakiGitHub, 'read'>,
      configuration: CONFIGURATION,
      expected: EXPECTED,
      milestoneSources: emptySources(),
      branchDeliveries: [delivery(), outOfScopeDelivery],
      board: BOARD,
    }, new AbortController().signal)

    expect(snapshot.capturedAt).toBe(200)
    expect(snapshot.milestone.confirmed?.value.id).toBe(MILESTONE_ID)
    expect(snapshot.tag.confirmed?.value.peel.commitId).toBe(RELEASE_COMMIT_ID)
    expect(snapshot.releaseCommit.confirmed?.value.id).toBe(RELEASE_COMMIT_ID)
    expect(snapshot.upstreamCommit.confirmed?.value.id).toBe(UPSTREAM_COMMIT_ID)
    expect(snapshot.deliveries).toHaveLength(1)
    expect(snapshot.deliveries[0]).toMatchObject({
      workItemId: WORK_ITEM_ID,
      pullRequest: { confirmed: { value: { id: PULL_REQUEST_ID } } },
      ci: { confirmed: { value: { commitId: DELIVERY_COMMIT_ID } } },
      ancestry: { confirmed: { value: { baseCommitId: DELIVERY_COMMIT_ID, headCommitId: RELEASE_COMMIT_ID } } },
    })
    expect(read).toHaveBeenCalledTimes(10)
    expect(read.mock.calls.map(([request]) => request)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'milestone', milestoneId: MILESTONE_ID, milestoneNumber: 1 }),
      expect.objectContaining({ kind: 'tag-reference', tagName: TAG_NAME }),
      expect.objectContaining({ kind: 'tag-object', target: { kind: 'tag', id: TAG_OBJECT_ID } }),
      expect.objectContaining({ kind: 'release-by-tag', tagName: TAG_NAME }),
      expect.objectContaining({ kind: 'commit', repositoryId: REPOSITORY_ID, commitId: RELEASE_COMMIT_ID }),
      expect.objectContaining({
        kind: 'public-commit', repositoryId: UPSTREAM_REPOSITORY_ID,
        repositoryNameWithOwner: 'deepseek-ai/deepseek-harness', commitId: UPSTREAM_COMMIT_ID,
      }),
      expect.objectContaining({
        kind: 'compare-commits', repositoryId: REPOSITORY_ID,
        baseCommitId: UPSTREAM_COMMIT_ID, headCommitId: RELEASE_COMMIT_ID,
      }),
      expect.objectContaining({ kind: 'pull-request', pullRequestId: PULL_REQUEST_ID, pullRequestNumber: 32 }),
      expect.objectContaining({ kind: 'commit-ci', commitId: DELIVERY_COMMIT_ID }),
      expect.objectContaining({
        kind: 'compare-commits', baseCommitId: DELIVERY_COMMIT_ID, headCommitId: RELEASE_COMMIT_ID,
      }),
    ]))
    const publicRequest = read.mock.calls.map(([request]) => request)
      .find(request => request.kind === 'public-commit')
    expect(publicRequest).not.toHaveProperty('installation')
    expect(read.mock.calls.map(([request]) => request)
      .filter(request => request.kind !== 'public-commit')
      .every(request => request.installation.privateKeyRef === CONFIGURATION.credentialRef)).toBe(true)
    vi.restoreAllMocks()
  })

  it('preserves confirmations on provider failure or mismatch while confirming semantic negative facts', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(220)
    const oldMilestone = milestone(150)
    const currentDelivery = delivery()
    const oldPullRequest = currentDelivery.pullRequest.confirmed?.fact
    if (oldPullRequest === undefined) throw new Error('delivery fixture lacks a Pull Request')
    const read = vi.fn(async (request: GitHubReadRequest) => {
      if (request.kind === 'milestone') {
        throw new GitHubProviderError({ code: 'transient-transport', retryAfterMs: 500 })
      }
      if (request.kind === 'pull-request') {
        return { ...pullRequest(210), id: 'PR_wrong' as GitHubPullRequestId }
      }
      if (request.kind === 'release-by-tag') {
        return {
          kind: 'absent', repositoryId: REPOSITORY_ID, tagName: TAG_NAME, observedAt: 210,
        } satisfies GitHubReleaseByTagObservation
      }
      if (request.kind === 'commit-ci') {
        return {
          ...commitCi(210),
          commitStatuses: [{
            id: githubCommitStatusId('901'), context: 'required', state: 'failure', createdAt: 209, updatedAt: 210,
          }],
        } satisfies GitHubCommitCiFact
      }
      if (request.kind === 'compare-commits') {
        return { ...comparison(request.baseCommitId, request.headCommitId, 210), status: 'diverged' as const }
      }
      return successfulFact(request)
    })
    const sources = emptySources()
    const snapshot = await readReleaseSnapshotV1({
      project: PROJECT,
      github: { read } as unknown as Pick<SakiGitHub, 'read'>,
      configuration: CONFIGURATION,
      expected: EXPECTED,
      milestoneSources: {
        ...sources,
        milestone: {
          confirmed: {
            value: { ...oldMilestone, issues: [...oldMilestone.issues] },
            observedAt: oldMilestone.observedAt,
          },
        },
      },
      branchDeliveries: [currentDelivery],
      board: BOARD,
    }, new AbortController().signal)

    expect(snapshot.milestone).toEqual({
      confirmed: { value: oldMilestone, observedAt: oldMilestone.observedAt },
      failure: { failure: { code: 'transient-transport', retryAfterMs: 500 }, failedAt: 220 },
    })
    expect(snapshot.deliveries[0]?.pullRequest).toEqual({
      confirmed: { value: oldPullRequest, observedAt: oldPullRequest.observedAt },
      invalidatedAt: 220,
    })
    expect(snapshot.release.confirmed?.value.kind).toBe('absent')
    expect(snapshot.deliveries[0]?.ci.confirmed?.value.commitStatuses[0]?.state).toBe('failure')
    expect(snapshot.deliveries[0]?.ancestry.confirmed?.value.status).toBe('diverged')
    expect(snapshot.upstreamAncestry.confirmed?.value.status).toBe('diverged')
    vi.restoreAllMocks()
  })

  it('propagates unexpected provider implementation errors', async () => {
    const failure = new Error('implementation defect')
    const read = vi.fn(async () => { throw failure })
    await expect(readReleaseSnapshotV1({
      project: PROJECT,
      github: { read },
      configuration: CONFIGURATION,
      expected: EXPECTED,
      milestoneSources: emptySources(),
      branchDeliveries: [delivery()],
      board: BOARD,
    }, new AbortController().signal)).rejects.toBe(failure)
  })
})

function readerInput(read: (request: GitHubReadRequest) => Promise<unknown>): ReadReleaseSnapshotV1Input {
  return { project: PROJECT, github: { read } as unknown as Pick<SakiGitHub, 'read'>,
    configuration: CONFIGURATION, expected: EXPECTED, milestoneSources: emptySources(),
    branchDeliveries: [delivery()], board: BOARD }
}

function emptySources(): MilestoneDeliverySources {
  return {
    revision: 0,
    milestone: {},
    tag: {},
    release: {},
    releaseCommit: {},
    upstreamCommit: {},
    upstreamAncestry: {},
    updatedAt: 100,
  }
}

function delivery(): BranchDeliveryRecord {
  const pr = pullRequest(160)
  const ci = commitCi(160)
  return {
    id: branchDeliveryId(DEVELOPMENT_PROJECT_ID, WORK_ITEM_ID),
    schemaVersion: 1,
    revision: 7,
    projectId: DEVELOPMENT_PROJECT_ID,
    workItemId: WORK_ITEM_ID,
    target: {
      registryRevision: 4,
      projectRevision: PROJECT.revision,
      binding: {
        id: PROJECT.resourceBindingId,
        revision: 0,
        health: 'active',
        hostId: sakiHostIdSchema.parse('host-00000000-0000-4000-8000-000000000002'),
        workspaceId: WorkspaceId('workspace-release-reader'),
        expectedInspection: {
          projection: SAKI_PROJECT_PROJECTION_FIXTURES.cleanSelection,
          trusted: {
            canonicalWorktreePath: '/fixture/repository',
            canonicalGitDirectory: '/fixture/repository/.git',
            canonicalCommonGitDirectory: '/fixture/repository/.git',
            gitDirectoryIdentity: { version: 1, digest: '4'.repeat(64) },
            commonGitDirectoryIdentity: { version: 1, digest: '4'.repeat(64) },
            comparison: { fileMode: true, symlinks: true, autocrlf: false },
          },
        },
        inheritedChangeBaseline: SAKI_PROJECT_PROJECTION_FIXTURES.cleanSelection.baseline,
      },
      synchronizationRevision: 1,
      mappingRevision: 1,
      installation: {
        appId: CONFIGURATION.appId,
        installationId: CONFIGURATION.githubInstallationId,
        accountId: CONFIGURATION.accountNodeId,
        privateKeyRef: CONFIGURATION.credentialRef,
      },
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
    },
    commitId: DELIVERY_COMMIT_ID,
    headRef: 'refs/heads/feature/issue-32',
    baseRef: 'refs/heads/master',
    phase: 'accepted',
    markerId: `pull-request-marker-${'4'.repeat(64)}` as BranchDeliveryRecord['markerId'],
    remoteRef: { current: { state: 'unobserved' } },
    pullRequest: { confirmed: { fact: pr, confirmedAt: 160 }, current: { state: 'confirmed', observedAt: 160 } },
    reviews: { current: { state: 'unobserved' } },
    ci: {
      confirmed: {
        fact: {
          ...ci,
          workflowRuns: [...ci.workflowRuns],
          checkRuns: [...ci.checkRuns],
          commitStatuses: [...ci.commitStatuses],
        },
        confirmedAt: 160,
      },
      current: { state: 'confirmed', observedAt: 160 },
    },
    acceptance: {
      intentId: INTENT_ID,
      actor: {} as NonNullable<BranchDeliveryRecord['acceptance']>['actor'],
      acceptedAt: 170,
      evidence: { digest: 'b'.repeat(64) } as NonNullable<BranchDeliveryRecord['acceptance']>['evidence'],
    },
    lastIntentId: INTENT_ID,
    createdAt: 100,
    updatedAt: 170,
  }
}

function milestone(observedAt: number): GitHubMilestoneFact {
  return {
    id: MILESTONE_ID,
    repositoryId: REPOSITORY_ID,
    number: 1,
    state: 'open',
    title: '0.1.0',
    url: 'https://github.com/BreakfastDaPaiDang/saki/milestone/1',
    updatedAt: observedAt,
    issues: [{ id: ISSUE_ID, repositoryId: REPOSITORY_ID } as GitHubMilestoneFact['issues'][number]],
    observedAt,
  }
}

function pullRequest(observedAt: number): GitHubPullRequestFact {
  return {
    id: PULL_REQUEST_ID,
    repositoryId: REPOSITORY_ID,
    number: 32,
    state: 'open',
    merged: false,
    draft: false,
    title: 'Deliver issue 32',
    url: 'https://github.com/BreakfastDaPaiDang/saki/pull/32',
    head: { repositoryId: REPOSITORY_ID, ref: 'feature/issue-32', commitId: DELIVERY_COMMIT_ID },
    base: { repositoryId: REPOSITORY_ID, ref: 'master', commitId: RELEASE_COMMIT_ID },
    updatedAt: observedAt,
    observedAt,
  }
}

function commitCi(observedAt: number): GitHubCommitCiFact {
  return {
    repositoryId: REPOSITORY_ID,
    commitId: DELIVERY_COMMIT_ID,
    workflowRuns: [],
    checkRuns: [],
    commitStatuses: [],
    observedAt,
  }
}

function comparison(
  baseCommitId: GitHubCommitId,
  headCommitId: GitHubCommitId,
  observedAt: number,
): GitHubCommitComparisonFact {
  return {
    repositoryId: REPOSITORY_ID,
    baseCommitId,
    headCommitId,
    status: 'ahead',
    aheadBy: 1,
    behindBy: 0,
    mergeBaseCommitId: baseCommitId,
    observedAt,
  }
}

function successfulFact(request: GitHubReadRequest): unknown {
  switch (request.kind) {
    case 'milestone': return milestone(190)
    case 'tag-reference': return {
      repositoryId: REPOSITORY_ID,
      tagName: TAG_NAME,
      ref: `refs/tags/${TAG_NAME}`,
      target: { kind: 'tag', id: TAG_OBJECT_ID },
      observedAt: 190,
    } satisfies GitHubTagReferenceFact
    case 'tag-object': return {
      repositoryId: REPOSITORY_ID,
      tagObjects: [{ id: TAG_OBJECT_ID, target: { kind: 'commit', id: RELEASE_COMMIT_ID } }],
      commitId: RELEASE_COMMIT_ID,
      observedAt: 191,
    } satisfies GitHubTagPeelFact
    case 'release-by-tag': return {
      kind: 'present',
      release: {
        id: githubReleaseId('REL_release_reader'),
        repositoryId: REPOSITORY_ID,
        tagName: TAG_NAME,
        targetCommitish: TAG_NAME,
        draft: false,
        prerelease: false,
        url: 'https://github.com/BreakfastDaPaiDang/saki/releases/tag/saki-v0.1.0',
        publishedAt: 180,
        observedAt: 190,
      },
    } satisfies GitHubReleaseByTagObservation
    case 'commit':
    case 'public-commit': return {
      id: request.commitId,
      repositoryId: request.repositoryId,
      url: `https://github.com/commit/${request.commitId}`,
      committedAt: 180,
      observedAt: 190,
    } satisfies GitHubCommitFact
    case 'compare-commits': return comparison(request.baseCommitId, request.headCommitId, 190)
    case 'pull-request': return pullRequest(190)
    case 'commit-ci': return commitCi(190)
    default: throw new Error(`Unexpected read ${request.kind}`)
  }
}
