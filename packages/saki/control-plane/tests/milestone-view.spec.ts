import { describe, expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  githubCommitId,
  githubIssueId,
  githubMilestoneId,
  githubProjectId,
  githubReleaseTagName,
  githubRepositoryDatabaseId,
  githubRepositoryId,
} from '@breakfastdapaidang/saki-github'
import {
  sakiBoardRemoteFingerprintSchema,
  sakiBoardWorkItemIdSchema,
  sakiControlIntentIdSchema,
  sakiDevelopmentProjectIdSchema,
} from '../src/ids.ts'
import {
  milestoneDeliveryId,
  milestoneDeliveryRecordSchema,
  type MilestoneDeliveryRecord,
} from '../src/milestone-delivery.ts'
import { SAKI_BOARD_PROJECTION_FIXTURES } from '../src/fixtures.ts'
import {
  milestoneBoardEvidence,
  projectMilestoneView,
} from '../src/milestone-view.ts'
import type { ReleaseEvidencePolicyV1Snapshot } from '../src/release-evidence-policy.ts'

const PROJECT_ID = sakiDevelopmentProjectIdSchema.parse('project-00000000-0000-4000-8000-000000000801')
const INTENT_ID = sakiControlIntentIdSchema.parse('intent-00000000-0000-4000-8000-000000000802')
const REPOSITORY_ID = githubRepositoryId('R_milestone_view')
const REPOSITORY_DATABASE_ID = githubRepositoryDatabaseId('801')
const GITHUB_PROJECT_ID = githubProjectId('P_milestone_view')
const MILESTONE_ID = githubMilestoneId('M_milestone_view')
const COMMIT_ID = githubCommitId('8'.repeat(40))
const WORK_ITEM_ID = sakiBoardWorkItemIdSchema.parse(`work-item-${'8'.repeat(64)}`)
const ISSUE_ID = githubIssueId('I_milestone_view')
const UNMAPPED_ISSUE_ID = githubIssueId('I_unmapped')

describe('projectMilestoneView', () => {
  it('joins one current complete Milestone scope to one confirmed Board generation', () => {
    const input = snapshot()
    const view = projectMilestoneView(record(input), input.board, 120, 50)

    expect(view.delivery).toMatchObject({ phase: 'in-progress', revision: 0 })
    expect(view.sources.milestone.current).toEqual({ state: 'confirmed', observedAt: 100 })
    expect(view.sources.board.current).toEqual({ state: 'confirmed', observedAt: 100 })
    expect(view.sources.tag.current).toEqual({ state: 'unobserved' })
    expect(view.scope).toMatchObject({
      boardGeneration: 7,
      total: 1,
      mapped: 1,
      unmapped: 0,
      unsupported: 0,
      complete: true,
      statusCounts: {
        inbox: 0,
        backlog: 0,
        ready: 0,
        'in-progress': 0,
        'in-review': 1,
        done: 0,
        canceled: 0,
      },
      items: [{ issueId: ISSUE_ID, workItemId: WORK_ITEM_ID, status: 'in-review' }],
    })
    expect(view.blockages).toEqual([])
  })

  it('retains confirmations but suppresses a mixed stale or invalidated scope', () => {
    const input = snapshot()
    const view = projectMilestoneView(record({
      ...input,
      milestone: { ...input.milestone, invalidatedAt: 121 },
    }), input.board, 200, 50)

    expect(view.sources.board).toMatchObject({
      confirmed: { observedAt: 100 },
      current: { state: 'stale', observedAt: 100, staleAt: 150 },
    })
    expect(view.sources.milestone).toMatchObject({
      confirmed: { observedAt: 100 },
      invalidatedAt: 121,
      current: { state: 'invalidated', invalidatedAt: 121 },
    })
    expect(view.scope).toBeUndefined()
    expect(view.blockages).toEqual([
      { kind: 'view-source', source: 'board', state: 'stale' },
      { kind: 'view-source', source: 'milestone', state: 'invalidated' },
    ])
  })

  it('shows exact unmapped scope without inventing status totals', () => {
    const input = snapshot()
    const milestone = input.milestone.confirmed
    if (milestone === undefined) throw new Error('Milestone fixture is missing')
    const withExpandedScope = {
      ...input,
      milestone: {
        confirmed: {
          ...milestone,
          value: {
            ...milestone.value,
            issues: [
              ...milestone.value.issues,
              issue(UNMAPPED_ISSUE_ID, REPOSITORY_ID, 33),
            ],
          },
        },
      },
    }
    const view = projectMilestoneView(record(withExpandedScope), withExpandedScope.board, 120, 50)

    expect(view.scope).toMatchObject({
      total: 2,
      mapped: 1,
      unmapped: 1,
      unsupported: 0,
      complete: false,
      statusCounts: { 'in-review': 1 },
    })
    expect(view.blockages).toEqual([{ kind: 'scope-unmapped', issueId: UNMAPPED_ISSUE_ID }])
  })

  it('keeps a current source failure separate from its last confirmation', () => {
    const input = snapshot()
    const withReleaseFailure: ReleaseEvidencePolicyV1Snapshot = {
      ...input,
      release: {
        confirmed: {
          value: {
            kind: 'absent',
            repositoryId: REPOSITORY_ID,
            tagName: githubReleaseTagName('saki-v0.1.0'),
            observedAt: 100,
          },
          observedAt: 100,
        },
        failure: {
          failure: { code: 'primary-rate-limit', resetAt: 500 },
          failedAt: 121,
        },
      },
    }
    const view = projectMilestoneView(record(withReleaseFailure), withReleaseFailure.board, 120, 50)

    expect(view.sources.release).toMatchObject({
      confirmed: { value: { kind: 'absent' }, observedAt: 100 },
      failure: { failure: { code: 'primary-rate-limit' }, failedAt: 121 },
      current: { state: 'failure', failedAt: 121 },
    })
    expect(view.scope?.complete).toBe(true)
  })

  it('omits an authentication credential reference from retained and current source failures', () => {
    const input = snapshot()
    const ref = credentialRef('PRODUCT_APP_KEY')
    const withReleaseFailure: ReleaseEvidencePolicyV1Snapshot = {
      ...input,
      release: {
        failure: {
          failure: { code: 'auth-unavailable', credentialRef: ref },
          failedAt: 121,
        },
      },
    }
    const retained = record(withReleaseFailure)

    const view = projectMilestoneView(retained, withReleaseFailure.board, 120, 50)

    expect(retained.sources.release.failure?.failure).toEqual({
      code: 'auth-unavailable',
      credentialRef: ref,
    })
    expect(view.sources.release.failure).toEqual({
      failure: { code: 'auth-unavailable' },
      failedAt: 121,
    })
    expect(view.sources.release.current).toEqual({
      state: 'failure',
      failure: { code: 'auth-unavailable' },
      failedAt: 121,
    })
  })
})

describe('milestoneBoardEvidence', () => {
  it('retains one complete generation and its newer provider failure', () => {
    const board = SAKI_BOARD_PROJECTION_FIXTURES.confirmedStaleFailure
    const confirmed = board.confirmed
    const checkpoint = board.checkpoint
    const failure = board.failure
    const evidence = milestoneBoardEvidence(board, checkpoint.confirmedAt + 50_000)

    expect(evidence.confirmed).toEqual({
      observedAt: checkpoint.observedAt,
      value: {
        repositoryId: confirmed.repository.id,
        projectId: confirmed.project.id,
        generation: confirmed.generation,
        sourceFingerprint: checkpoint.sourceFingerprint,
        items: confirmed.items.map(item => ({
          workItemId: item.id,
          issueId: item.source.issueId,
          status: item.status,
          remoteFingerprint: item.remoteFingerprint,
        })),
      },
    })
    expect(evidence.failure).toEqual({
      failure: failure.failure.failure,
      failedAt: failure.failedAt,
    })
    expect(evidence.invalidatedAt).toBeUndefined()
  })

  it('invalidates a retained generation while its mapping is being revalidated', () => {
    const board = SAKI_BOARD_PROJECTION_FIXTURES.mappingRevalidation

    expect(milestoneBoardEvidence(board, 123_456)).toMatchObject({
      confirmed: { observedAt: board.checkpoint.observedAt },
      invalidatedAt: 123_456,
    })
  })
})

function record(snapshotValue: ReleaseEvidencePolicyV1Snapshot): MilestoneDeliveryRecord {
  const release = {
    repositoryId: REPOSITORY_ID,
    projectId: GITHUB_PROJECT_ID,
    milestoneId: MILESTONE_ID,
    milestoneNumber: 1,
    tagName: githubReleaseTagName('saki-v0.1.0'),
    releaseCommitId: COMMIT_ID,
    upstreamRepositoryId: githubRepositoryId('R_upstream'),
    upstreamRepositoryDatabaseId: githubRepositoryDatabaseId('802'),
    upstreamRepositoryNameWithOwner: 'deepseek-ai/deepseek-harness',
    upstreamCommitId: COMMIT_ID,
  }
  return milestoneDeliveryRecordSchema.parse({
    id: milestoneDeliveryId(PROJECT_ID, MILESTONE_ID),
    schemaVersion: 1,
    revision: 0,
    projectId: PROJECT_ID,
    registryRevision: 2,
    projectRevision: 3,
    phase: 'in-progress',
    release,
    sources: {
      revision: 1,
      milestone: snapshotValue.milestone,
      tag: snapshotValue.tag,
      release: snapshotValue.release,
      releaseCommit: snapshotValue.releaseCommit,
      upstreamCommit: snapshotValue.upstreamCommit,
      upstreamAncestry: snapshotValue.upstreamAncestry,
      updatedAt: snapshotValue.capturedAt,
    },
    lastIntentId: INTENT_ID,
    createdAt: 10,
    updatedAt: snapshotValue.capturedAt,
  })
}

function snapshot(): ReleaseEvidencePolicyV1Snapshot {
  return {
    capturedAt: 100,
    board: {
      confirmed: {
        observedAt: 100,
        value: {
          repositoryId: REPOSITORY_ID,
          projectId: GITHUB_PROJECT_ID,
          generation: 7,
          sourceFingerprint: { version: 1, digest: '8'.repeat(64) },
          items: [{
            workItemId: WORK_ITEM_ID,
            issueId: ISSUE_ID,
            status: 'in-review',
            remoteFingerprint: sakiBoardRemoteFingerprintSchema.parse(
              `remote-fingerprint-${'9'.repeat(64)}`,
            ),
          }],
        },
      },
    },
    milestone: {
      confirmed: {
        observedAt: 100,
        value: {
          id: MILESTONE_ID,
          repositoryId: REPOSITORY_ID,
          number: 1,
          state: 'open',
          title: '0.1.0',
          dueOn: 200,
          url: 'https://github.com/o/r/milestone/1',
          updatedAt: 90,
          issues: [issue(ISSUE_ID, REPOSITORY_ID, 32)],
          observedAt: 100,
        },
      },
    },
    deliveries: [],
    tag: {},
    release: {},
    releaseCommit: {},
    upstreamCommit: {},
    upstreamAncestry: {},
  }
}

function issue(id: typeof ISSUE_ID, repositoryId: typeof REPOSITORY_ID, number: number) {
  return {
    id,
    repositoryId,
    repositoryDatabaseId: REPOSITORY_DATABASE_ID,
    number,
    state: 'open' as const,
    title: `Issue ${number}`,
    url: `https://github.com/o/r/issues/${number}`,
    updatedAt: 90,
  }
}
