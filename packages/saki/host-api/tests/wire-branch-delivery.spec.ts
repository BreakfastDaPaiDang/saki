import { describe, expect, it } from 'vitest'
import {
  GITHUB_PULL_REQUEST_CREATE_BODY_UTF8_LIMIT,
  GITHUB_PULL_REQUEST_CREATE_TITLE_UTF8_LIMIT,
} from '@breakfastdapaidang/saki-github'
import {
  sakiAcceptBranchDeliveryIntentSchema,
  sakiAssociateBranchDeliveryPullRequestIntentSchema,
  sakiBranchDeliveryIntentResultSchema,
  sakiBranchDeliveryResultSchema,
  sakiCreateBranchDeliveryPullRequestIntentSchema,
  sakiIntentRequestSchema,
  sakiMarkBranchDeliveryInReviewIntentSchema,
  sakiPushBranchDeliveryIntentSchema,
  sakiQueryRequestSchema,
  sakiSaveBranchDeliveryIntentSchema,
} from '../src/wire.ts'

const PROJECT_ID = 'project-11111111-1111-4111-8111-111111111111'
const WORK_ITEM_ID = `work-item-${'2'.repeat(64)}`
const DELIVERY_ID = `branch-delivery-${'3'.repeat(64)}`
const BINDING_ID = 'binding-44444444-4444-4444-8444-444444444444'
const REMOTE_FINGERPRINT = `remote-fingerprint-${'5'.repeat(64)}`
const COMMIT_ID = '6'.repeat(40)
const PULL_REQUEST_MARKER_ID = `pull-request-marker-${'0'.repeat(64)}`
const PULL_REQUEST_MARKER_SUFFIX = `\n<!-- saki-pull-request:${PULL_REQUEST_MARKER_ID} -->\n`

const SAVE_INTENT = {
  type: 'save-branch-delivery',
  intentId: 'intent-11111111-1111-4111-8111-111111111111',
  projectId: PROJECT_ID,
  workItemId: WORK_ITEM_ID,
  expected: {
    deliveryRevision: null,
    registryRevision: 2,
    projectRevision: 1,
    binding: { id: BINDING_ID, revision: 3 },
    synchronizationRevision: 4,
    mappingRevision: 4,
    workItemRemoteFingerprint: REMOTE_FINGERPRINT,
  },
  commitId: COMMIT_ID,
  headRef: 'refs/heads/saki/issue-32',
  baseRef: 'refs/heads/master',
} as const

const EXISTING_INTENTS = [
  {
    type: 'push-branch-delivery',
    intentId: 'intent-22222222-2222-4222-8222-222222222222',
    deliveryId: DELIVERY_ID,
    expectedDeliveryRevision: 0,
  },
  {
    type: 'create-branch-delivery-pull-request',
    intentId: 'intent-33333333-3333-4333-8333-333333333333',
    deliveryId: DELIVERY_ID,
    expectedDeliveryRevision: 0,
    title: 'Deliver issue 32',
    body: 'Browser-safe Pull Request content.',
  },
  {
    type: 'associate-branch-delivery-pull-request',
    intentId: 'intent-44444444-4444-4444-8444-444444444444',
    deliveryId: DELIVERY_ID,
    expectedDeliveryRevision: 0,
    pullRequestId: 'PR_issue_32',
    pullRequestNumber: 32,
  },
  {
    type: 'mark-branch-delivery-in-review',
    intentId: 'intent-55555555-5555-4555-8555-555555555555',
    deliveryId: DELIVERY_ID,
    expectedDeliveryRevision: 0,
    expectedWorkItemRemoteFingerprint: REMOTE_FINGERPRINT,
  },
  {
    type: 'accept-branch-delivery',
    intentId: 'intent-66666666-6666-4666-8666-666666666666',
    deliveryId: DELIVERY_ID,
    expectedDeliveryRevision: 0,
    expectedWorkItemRemoteFingerprint: REMOTE_FINGERPRINT,
  },
] as const

const CACHED_RESULT = {
  ok: true,
  projection: {
    type: 'branch-delivery',
    refresh: { requested: 'cached', state: 'cached' },
    branchDelivery: {
      delivery: {
        id: DELIVERY_ID,
        schemaVersion: 1,
        revision: 0,
        projectId: PROJECT_ID,
        workItemId: WORK_ITEM_ID,
        target: {
          registryRevision: 2,
          projectRevision: 1,
          binding: {
            id: BINDING_ID,
            revision: 3,
            hostId: 'host-77777777-7777-4777-8777-777777777777',
            health: 'active',
          },
          synchronizationRevision: 4,
          mappingRevision: 4,
          installation: { appId: '123', installationId: '456', accountId: 'O_saki' },
          repository: { id: 'R_saki', databaseId: '789', nameWithOwner: 'BreakfastDaPaiDang/saki' },
          workItem: { id: WORK_ITEM_ID, remoteFingerprint: REMOTE_FINGERPRINT, issueId: 'I_issue_32' },
        },
        commitId: COMMIT_ID,
        headRef: 'refs/heads/saki/issue-32',
        baseRef: 'refs/heads/master',
        phase: 'draft',
        lastIntentId: SAVE_INTENT.intentId,
        createdAt: 100,
        updatedAt: 100,
      },
      remoteRef: { current: { state: 'unobserved' } },
      pullRequest: { current: { state: 'unobserved' } },
      reviews: { current: { state: 'unobserved' } },
      ci: { current: { state: 'unobserved' } },
    },
  },
} as const

describe('Saki Branch Delivery Host wire', () => {
  it('parses one explicit Branch Delivery query and all six path-free Intents', () => {
    expect(sakiQueryRequestSchema.parse({
      type: 'branch-delivery',
      projectId: PROJECT_ID,
      workItemId: WORK_ITEM_ID,
      refresh: 'interactive',
    })).toEqual({
      type: 'branch-delivery',
      projectId: PROJECT_ID,
      workItemId: WORK_ITEM_ID,
      refresh: 'interactive',
    })
    expect(sakiQueryRequestSchema.safeParse({
      type: 'branch-delivery', projectId: PROJECT_ID, workItemId: WORK_ITEM_ID,
    }).success).toBe(false)

    const schemas = [
      sakiSaveBranchDeliveryIntentSchema,
      sakiPushBranchDeliveryIntentSchema,
      sakiCreateBranchDeliveryPullRequestIntentSchema,
      sakiAssociateBranchDeliveryPullRequestIntentSchema,
      sakiMarkBranchDeliveryInReviewIntentSchema,
      sakiAcceptBranchDeliveryIntentSchema,
    ]
    for (const [index, intent] of [SAVE_INTENT, ...EXISTING_INTENTS].entries()) {
      expect(schemas[index]?.parse(intent)).toEqual(intent)
      expect(sakiIntentRequestSchema.parse(intent)).toEqual(intent)
    }
    expect(sakiIntentRequestSchema.safeParse({ ...SAVE_INTENT, directoryLocator: 'D:/private' }).success).toBe(false)
    const equalRefs = { ...SAVE_INTENT, baseRef: SAVE_INTENT.headRef }
    expect(sakiSaveBranchDeliveryIntentSchema.safeParse(equalRefs).success).toBe(false)
    expect(sakiIntentRequestSchema.safeParse(equalRefs).success).toBe(false)
  })

  it('admits only Pull Request text that produces a complete valid GitHub body', () => {
    const createIntent = EXISTING_INTENTS[1]
    const sourceBytes = GITHUB_PULL_REQUEST_CREATE_BODY_UTF8_LIMIT
      - Buffer.byteLength(PULL_REQUEST_MARKER_SUFFIX, 'utf8')
    const exactBody = 'x'.repeat(sourceBytes)
    const exactMultibyteBody = `${exactBody.slice(0, -3)}界`
    const exactTitle = 'x'.repeat(GITHUB_PULL_REQUEST_CREATE_TITLE_UTF8_LIMIT)
    const exactMultibyteTitle = `${'界'.repeat(341)}x`

    for (const [title, body] of [
      [exactTitle, exactBody],
      [exactMultibyteTitle, exactMultibyteBody],
    ]) {
      const intent = { ...createIntent, title, body }
      expect(sakiCreateBranchDeliveryPullRequestIntentSchema.safeParse(intent).success).toBe(true)
      expect(sakiIntentRequestSchema.safeParse(intent).success).toBe(true)
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
      { title: 'Title', body: `Body\n<!-- saki-pull-request:${PULL_REQUEST_MARKER_ID} -->` },
    ]
    for (const text of invalid) {
      const intent = { ...createIntent, ...text }
      expect(sakiCreateBranchDeliveryPullRequestIntentSchema.safeParse(intent).success).toBe(false)
      expect(sakiIntentRequestSchema.safeParse(intent).success).toBe(false)
    }
  })

  it('serializes only the browser projection and removes credential references from source failures', () => {
    expect(sakiBranchDeliveryResultSchema.parse(CACHED_RESULT)).toEqual(CACHED_RESULT)
    const withConfirmedCiSummary = {
      ...CACHED_RESULT,
      projection: {
        ...CACHED_RESULT.projection,
        branchDelivery: {
          ...CACHED_RESULT.projection.branchDelivery,
          ci: {
            confirmed: {
              fact: {
                repositoryId: 'R_saki',
                commitId: COMMIT_ID,
                workflowRuns: [],
                checkRuns: [],
                commitStatuses: [],
                observedAt: 110,
              },
              confirmedAt: 111,
            },
            confirmedSummary: { state: 'unavailable', signalCount: 0, observedAt: 110 },
            current: { state: 'confirmed', observedAt: 110 },
          },
        },
      },
    } as const
    expect(sakiBranchDeliveryResultSchema.parse(withConfirmedCiSummary)).toEqual(withConfirmedCiSummary)
    const withConfirmedReviews = {
      ...CACHED_RESULT,
      projection: {
        ...CACHED_RESULT.projection,
        branchDelivery: {
          ...CACHED_RESULT.projection.branchDelivery,
          reviews: {
            confirmed: {
              fact: {
                repositoryId: 'R_saki',
                pullRequestId: 'PR_issue_32',
                pullRequestNumber: 32,
                headCommitId: COMMIT_ID,
                pullRequestUpdatedAt: 109,
                reviews: [{
                  id: 'PRR_issue_32',
                  state: 'approved',
                  url: 'https://github.com/BreakfastDaPaiDang/saki/pull/32#pullrequestreview-1',
                  updatedAt: 109,
                }],
                observedAt: 110,
              },
              confirmedAt: 111,
            },
            current: { state: 'confirmed', observedAt: 110 },
          },
        },
      },
    } as const
    expect(sakiBranchDeliveryResultSchema.parse(withConfirmedReviews)).toEqual(withConfirmedReviews)
    const { reviews, ...withoutReviews } = CACHED_RESULT.projection.branchDelivery
    expect(reviews).toBeDefined()
    expect(sakiBranchDeliveryResultSchema.safeParse({
      ...CACHED_RESULT,
      projection: {
        ...CACHED_RESULT.projection,
        branchDelivery: withoutReviews,
      },
    }).success).toBe(false)
    expect(sakiBranchDeliveryResultSchema.safeParse({
      ...withConfirmedReviews,
      projection: {
        ...withConfirmedReviews.projection,
        branchDelivery: {
          ...withConfirmedReviews.projection.branchDelivery,
          reviews: {
            ...withConfirmedReviews.projection.branchDelivery.reviews,
            confirmed: {
              ...withConfirmedReviews.projection.branchDelivery.reviews.confirmed,
              fact: {
                ...withConfirmedReviews.projection.branchDelivery.reviews.confirmed.fact,
                acceptanceAuthority: true,
              },
            },
          },
        },
      },
    }).success).toBe(false)
    expect(sakiBranchDeliveryResultSchema.safeParse({
      ...CACHED_RESULT,
      projection: { ...CACHED_RESULT.projection, record: { privateKeyRef: 'SECRET' } },
    }).success).toBe(false)
    expect(sakiBranchDeliveryResultSchema.safeParse({
      ...CACHED_RESULT,
      projection: {
        ...CACHED_RESULT.projection,
        branchDelivery: {
          ...CACHED_RESULT.projection.branchDelivery,
          delivery: {
            ...CACHED_RESULT.projection.branchDelivery.delivery,
            target: {
              ...CACHED_RESULT.projection.branchDelivery.delivery.target,
              installation: {
                ...CACHED_RESULT.projection.branchDelivery.delivery.target.installation,
                privateKeyRef: 'SAKI_GITHUB_APP_PRIVATE_KEY',
              },
            },
          },
        },
      },
    }).success).toBe(false)
    expect(sakiBranchDeliveryResultSchema.safeParse({
      ...CACHED_RESULT,
      projection: {
        ...CACHED_RESULT.projection,
        branchDelivery: {
          ...CACHED_RESULT.projection.branchDelivery,
          delivery: {
            ...CACHED_RESULT.projection.branchDelivery.delivery,
            target: {
              ...CACHED_RESULT.projection.branchDelivery.delivery.target,
              repository: {
                ...CACHED_RESULT.projection.branchDelivery.delivery.target.repository,
                nameWithOwner: 'BreakfastDaPaiDang/saki\nprivate',
              },
            },
          },
        },
      },
    }).success).toBe(false)

    const failed = {
      ...CACHED_RESULT,
      projection: {
        ...CACHED_RESULT.projection,
        refresh: { requested: 'interactive', state: 'confirmed' },
        branchDelivery: {
          ...CACHED_RESULT.projection.branchDelivery,
          remoteRef: {
            current: {
              state: 'failure',
              failedAt: 120,
              failure: { code: 'auth-unavailable', credentialRef: 'SAKI_GITHUB_APP_PRIVATE_KEY' },
            },
          },
        },
      },
    }
    const parsed = sakiBranchDeliveryResultSchema.parse(failed)
    expect(JSON.stringify(parsed)).not.toContain('SAKI_GITHUB_APP_PRIVATE_KEY')
  })

  it('parses the exact shared Branch Delivery receipt lifecycle', () => {
    for (const result of [
      { ok: true, receipt: { intentId: SAVE_INTENT.intentId, deliveryId: DELIVERY_ID, state: 'pending' } },
      {
        ok: true,
        receipt: { intentId: SAVE_INTENT.intentId, deliveryId: DELIVERY_ID, state: 'succeeded', deliveryRevision: 0 },
      },
      { ok: false, reason: 'denied' },
      {
        ok: false,
        reason: 'conflict',
        receipt: { intentId: SAVE_INTENT.intentId, deliveryId: DELIVERY_ID, state: 'conflict' },
      },
      {
        ok: false,
        reason: 'unavailable',
        receipt: { intentId: SAVE_INTENT.intentId, deliveryId: DELIVERY_ID, state: 'failure' },
      },
      {
        ok: false,
        reason: 'reconciliation-required',
        receipt: { intentId: SAVE_INTENT.intentId, deliveryId: DELIVERY_ID, state: 'reconciliation-required' },
      },
    ] as const) {
      expect(sakiBranchDeliveryIntentResultSchema.parse(result)).toEqual(result)
    }
  })
})
