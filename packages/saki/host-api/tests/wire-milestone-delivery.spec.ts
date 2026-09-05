import { describe, expect, it } from 'vitest'
import {
  sakiFinalizeMilestoneDeliveryIntentSchema,
  sakiIntentRequestSchema,
  sakiMilestoneDeliveryIntentResultSchema,
  sakiMilestoneViewResultSchema,
  sakiQueryRequestSchema,
  sakiSaveMilestoneDeliveryIntentSchema,
} from '../src/wire.ts'

const PROJECT_ID = 'project-11111111-1111-4111-8111-111111111111'
const MILESTONE_ID = 'M_release_010'
const DELIVERY_ID = `milestone-delivery-${'2'.repeat(64)}`
const RELEASE_COMMIT_ID = '3'.repeat(40)
const UPSTREAM_COMMIT_ID = '4'.repeat(40)
const WORK_ITEM_ID = `work-item-${'5'.repeat(64)}`
const BRANCH_DELIVERY_ID = `branch-delivery-${'6'.repeat(64)}`
const RELEASE = {
  repositoryId: 'R_saki',
  projectId: 'P_saki',
  milestoneId: MILESTONE_ID,
  milestoneNumber: 1,
  tagName: 'saki-v0.1.0',
  releaseCommitId: RELEASE_COMMIT_ID,
  upstreamRepositoryId: 'R_upstream',
  upstreamRepositoryDatabaseId: '321',
  upstreamRepositoryNameWithOwner: 'deepseek-ai/deepseek-harness',
  upstreamCommitId: UPSTREAM_COMMIT_ID,
} as const
const SAVE_INTENT = {
  type: 'save-milestone-delivery',
  intentId: 'intent-22222222-2222-4222-8222-222222222222',
  projectId: PROJECT_ID,
  expectedDeliveryRevision: null,
  expectedRegistryRevision: 5,
  expectedProjectRevision: 3,
  phase: 'planned',
  release: RELEASE,
} as const
const FINALIZE_INTENT = {
  type: 'finalize-milestone-delivery',
  intentId: 'intent-33333333-3333-4333-8333-333333333333',
  deliveryId: DELIVERY_ID,
  expectedDeliveryRevision: 2,
  release: RELEASE,
} as const

const CACHED_RESULT = {
  ok: true,
  projection: {
    type: 'milestone-view',
    refresh: { requested: 'cached', state: 'cached' },
    milestoneView: {
      delivery: { id: DELIVERY_ID, revision: 2, phase: 'planned', release: RELEASE },
      sources: {
        board: { current: { state: 'unobserved' } },
        milestone: { current: { state: 'unobserved' } },
        tag: { current: { state: 'unobserved' } },
        release: { current: { state: 'unobserved' } },
        releaseCommit: { current: { state: 'unobserved' } },
        upstreamCommit: { current: { state: 'unobserved' } },
        upstreamAncestry: { current: { state: 'unobserved' } },
      },
      blockages: [
        { kind: 'view-source', source: 'board', state: 'unobserved' },
        { kind: 'view-source', source: 'milestone', state: 'unobserved' },
      ],
    },
  },
} as const

const RELEASED_RESULT = {
  ...CACHED_RESULT,
  projection: {
    ...CACHED_RESULT.projection,
    refresh: { requested: 'cached', state: 'immutable' },
    milestoneView: {
      ...CACHED_RESULT.projection.milestoneView,
      delivery: {
        ...CACHED_RESULT.projection.milestoneView.delivery,
        phase: 'released',
        releaseEvidence: {
          intentId: FINALIZE_INTENT.intentId,
          actor: {
            installationId: 'installation-11111111-1111-4111-8111-111111111111',
            storageGenerationId: 'storage-generation-11111111-1111-4111-8111-111111111111',
            hostId: 'host-11111111-1111-4111-8111-111111111111',
            principalId: 'principal-11111111-1111-4111-8111-111111111111',
            principalRevision: 1,
            grantId: 'grant-11111111-1111-4111-8111-111111111111',
            grantRevision: 1,
          },
          priorMetadataRevision: 1,
          evidence: {
            policy: 'release-evidence/v1',
            evaluationDigest: 'a'.repeat(64),
            projectId: RELEASE.projectId,
            boardGeneration: 4,
            boardFingerprint: { version: 1, digest: 'b'.repeat(64) },
            milestoneId: MILESTONE_ID,
            milestoneNumber: 1,
            milestone: {
              id: MILESTONE_ID,
              repositoryId: RELEASE.repositoryId,
              number: 1,
              state: 'open',
              title: '0.1.0',
              url: 'https://github.com/o/r/milestone/1',
              updatedAt: 100,
              issues: [],
              observedAt: 200,
            },
            scopeFingerprint: 'c'.repeat(64),
            workItems: [],
            deliveries: [{
              deliveryId: BRANCH_DELIVERY_ID,
              deliveryRevision: 3,
              workItemId: WORK_ITEM_ID,
              commitId: RELEASE_COMMIT_ID,
              headRef: 'refs/heads/feature/b10',
              baseRef: 'refs/heads/master',
              pullRequest: {
                id: 'PR_release',
                repositoryId: RELEASE.repositoryId,
                number: 72,
                state: 'open',
                merged: false,
                draft: true,
                title: 'B10',
                url: 'https://github.com/o/r/pull/72',
                head: {
                  repositoryId: RELEASE.repositoryId,
                  ref: 'feature/b10',
                  commitId: RELEASE_COMMIT_ID,
                },
                base: {
                  repositoryId: RELEASE.repositoryId,
                  ref: 'master',
                  commitId: RELEASE_COMMIT_ID,
                },
                updatedAt: 180,
                observedAt: 200,
              },
              ci: {
                repositoryId: RELEASE.repositoryId,
                commitId: RELEASE_COMMIT_ID,
                workflowRuns: [],
                checkRuns: [],
                commitStatuses: [],
                observedAt: 200,
              },
              acceptance: {
                deliveryRevision: 3,
                acceptedAt: 190,
                intentId: SAVE_INTENT.intentId,
                actorDigest: 'd'.repeat(64),
              },
              ancestry: {
                repositoryId: RELEASE.repositoryId,
                baseCommitId: RELEASE_COMMIT_ID,
                headCommitId: RELEASE_COMMIT_ID,
                status: 'identical',
                aheadBy: 0,
                behindBy: 0,
                mergeBaseCommitId: RELEASE_COMMIT_ID,
                observedAt: 200,
              },
            }],
            tag: {
              reference: {
                repositoryId: RELEASE.repositoryId,
                tagName: RELEASE.tagName,
                ref: `refs/tags/${RELEASE.tagName}`,
                target: { kind: 'commit', id: RELEASE_COMMIT_ID },
                observedAt: 200,
              },
              peel: {
                repositoryId: RELEASE.repositoryId,
                tagObjects: [],
                commitId: RELEASE_COMMIT_ID,
                observedAt: 200,
              },
            },
            release: {
              id: 'REL_release',
              repositoryId: RELEASE.repositoryId,
              tagName: RELEASE.tagName,
              targetCommitish: 'master',
              draft: false,
              prerelease: false,
              url: 'https://github.com/o/r/releases/tag/saki-v0.1.0',
              publishedAt: 190,
              observedAt: 200,
            },
            releaseCommit: {
              id: RELEASE_COMMIT_ID,
              repositoryId: RELEASE.repositoryId,
              url: `https://github.com/o/r/commit/${RELEASE_COMMIT_ID}`,
              committedAt: 180,
              observedAt: 200,
            },
            upstreamRepositoryId: RELEASE.upstreamRepositoryId,
            upstreamRepositoryDatabaseId: RELEASE.upstreamRepositoryDatabaseId,
            upstreamRepositoryNameWithOwner: RELEASE.upstreamRepositoryNameWithOwner,
            upstreamCommit: {
              id: UPSTREAM_COMMIT_ID,
              repositoryId: RELEASE.upstreamRepositoryId,
              url: `https://github.com/upstream/r/commit/${UPSTREAM_COMMIT_ID}`,
              committedAt: 170,
              observedAt: 200,
            },
            upstreamAncestry: {
              repositoryId: RELEASE.repositoryId,
              baseCommitId: UPSTREAM_COMMIT_ID,
              headCommitId: RELEASE_COMMIT_ID,
              status: 'ahead',
              aheadBy: 1,
              behindBy: 0,
              mergeBaseCommitId: UPSTREAM_COMMIT_ID,
              observedAt: 200,
            },
            confirmedAt: 200,
          },
          embeddedAt: 200,
        },
      },
    },
  },
} as const

describe('Saki Milestone Delivery Host wire', () => {
  it('parses the exact Milestone query and both strict release Intents', () => {
    const query = {
      type: 'milestone-view', projectId: PROJECT_ID, milestoneId: MILESTONE_ID, refresh: 'interactive',
    } as const
    expect(sakiQueryRequestSchema.parse(query)).toEqual(query)
    expect(sakiQueryRequestSchema.safeParse({ ...query, milestoneId: '' }).success).toBe(false)

    expect(sakiSaveMilestoneDeliveryIntentSchema.parse(SAVE_INTENT)).toEqual(SAVE_INTENT)
    expect(sakiFinalizeMilestoneDeliveryIntentSchema.parse(FINALIZE_INTENT)).toEqual(FINALIZE_INTENT)
    expect(sakiIntentRequestSchema.parse(SAVE_INTENT)).toEqual(SAVE_INTENT)
    expect(sakiIntentRequestSchema.parse(FINALIZE_INTENT)).toEqual(FINALIZE_INTENT)
    expect(sakiIntentRequestSchema.safeParse({
      ...SAVE_INTENT,
      release: { ...RELEASE, releaseCommitId: 'not-a-commit' },
    }).success).toBe(false)
    expect(sakiIntentRequestSchema.safeParse({ ...SAVE_INTENT, privateKeyRef: 'PRODUCT_APP_KEY' }).success)
      .toBe(false)
  })

  it('admits only the browser-safe Milestone View projection', () => {
    expect(sakiMilestoneViewResultSchema.parse(CACHED_RESULT)).toEqual(CACHED_RESULT)
    expect(sakiMilestoneViewResultSchema.safeParse({
      ...CACHED_RESULT,
      projection: { ...CACHED_RESULT.projection, privateKeyRef: 'PRODUCT_APP_KEY' },
    }).success).toBe(false)
    expect(sakiMilestoneViewResultSchema.safeParse({
      ...CACHED_RESULT,
      projection: { ...CACHED_RESULT.projection, localPath: 'D:/private/repository' },
    }).success).toBe(false)

    const failed = {
      ...CACHED_RESULT,
      projection: {
        ...CACHED_RESULT.projection,
        milestoneView: {
          ...CACHED_RESULT.projection.milestoneView,
          sources: {
            ...CACHED_RESULT.projection.milestoneView.sources,
            board: {
              failure: {
                failure: { code: 'auth-unavailable', credentialRef: 'PRODUCT_APP_KEY' },
                failedAt: 120,
              },
              current: {
                state: 'failure',
                failure: { code: 'auth-unavailable', credentialRef: 'PRODUCT_APP_KEY' },
                failedAt: 120,
              },
            },
          },
        },
      },
    } as const
    expect(JSON.stringify(sakiMilestoneViewResultSchema.parse(failed))).not.toContain('PRODUCT_APP_KEY')
  })

  it('requires the exact release identity closure on browser-visible evidence', () => {
    expect(sakiMilestoneViewResultSchema.parse(RELEASED_RESULT)).toEqual(RELEASED_RESULT)

    const evidence = RELEASED_RESULT.projection.milestoneView.delivery.releaseEvidence.evidence
    const { projectId: _projectId, ...withoutProject } = evidence
    expect(sakiMilestoneViewResultSchema.safeParse({
      ...RELEASED_RESULT,
      projection: {
        ...RELEASED_RESULT.projection,
        milestoneView: {
          ...RELEASED_RESULT.projection.milestoneView,
          delivery: {
            ...RELEASED_RESULT.projection.milestoneView.delivery,
            releaseEvidence: {
              ...RELEASED_RESULT.projection.milestoneView.delivery.releaseEvidence,
              evidence: withoutProject,
            },
          },
        },
      },
    }).success).toBe(false)

    const delivery = evidence.deliveries[0]
    if (delivery === undefined) throw new Error('fixture Delivery is missing')
    const { headRef: _headRef, ...withoutHeadRef } = delivery
    expect(sakiMilestoneViewResultSchema.safeParse({
      ...RELEASED_RESULT,
      projection: {
        ...RELEASED_RESULT.projection,
        milestoneView: {
          ...RELEASED_RESULT.projection.milestoneView,
          delivery: {
            ...RELEASED_RESULT.projection.milestoneView.delivery,
            releaseEvidence: {
              ...RELEASED_RESULT.projection.milestoneView.delivery.releaseEvidence,
              evidence: { ...evidence, deliveries: [withoutHeadRef] },
            },
          },
        },
      },
    }).success).toBe(false)
  })

  it('parses the shared Milestone receipt lifecycle and typed blockages', () => {
    for (const result of [
      { ok: true, receipt: { intentId: SAVE_INTENT.intentId, deliveryId: DELIVERY_ID, state: 'pending' } },
      {
        ok: true,
        receipt: {
          intentId: FINALIZE_INTENT.intentId,
          deliveryId: DELIVERY_ID,
          state: 'succeeded',
          deliveryRevision: 3,
        },
      },
      {
        ok: false,
        reason: 'conflict',
        receipt: { intentId: SAVE_INTENT.intentId, deliveryId: DELIVERY_ID, state: 'conflict' },
      },
      {
        ok: false,
        reason: 'reconciliation-required',
        blockages: [{ kind: 'milestone-closed' }],
        receipt: {
          intentId: FINALIZE_INTENT.intentId,
          deliveryId: DELIVERY_ID,
          state: 'reconciliation-required',
          deliveryRevision: 3,
        },
      },
    ] as const) {
      expect(sakiMilestoneDeliveryIntentResultSchema.parse(result)).toEqual(result)
    }
  })
})
