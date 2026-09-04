/** Tests for pure Milestone release-snapshot assembly. */

import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it } from 'vitest'
import { canonicalDigest } from '@breakfastdapaidang/saki-execution'
import {
  githubCommitId,
  githubPullRequestCreateMarkerId,
  githubRepositoryId,
} from '@breakfastdapaidang/saki-github'
import {
  branchDeliveryId,
  type BranchDeliveryRecord,
} from '../src/branch-delivery.ts'
import {
  sakiBoardWorkItemIdSchema,
  sakiControlIntentIdSchema,
  sakiDevelopmentProjectIdSchema,
  sakiResourceBindingIdSchema,
} from '../src/ids.ts'
import type { ReleaseEvidencePolicyV1Snapshot } from '../src/release-evidence-policy.ts'
import { assembleReleaseSnapshot } from '../src/release-snapshot.ts'
import { controlIntentActorSchema } from '../src/spec.ts'

const PROJECT_ID = sakiDevelopmentProjectIdSchema.parse('project-00000000-0000-4000-8000-000000000701')
const OTHER_PROJECT_ID = sakiDevelopmentProjectIdSchema.parse('project-00000000-0000-4000-8000-000000000702')
const FIRST_WORK_ITEM_ID = sakiBoardWorkItemIdSchema.parse(`work-item-${'1'.repeat(64)}`)
const SECOND_WORK_ITEM_ID = sakiBoardWorkItemIdSchema.parse(`work-item-${'2'.repeat(64)}`)
const BINDING_ID = sakiResourceBindingIdSchema.parse('binding-00000000-0000-4000-8000-000000000703')
const PRIVATE_KEY_REF = credentialRef('SAKI_PRODUCT_PRIVATE_KEY')
const REPOSITORY_ID = githubRepositoryId('R_release_snapshot')
const COMMIT_ID = githubCommitId('3'.repeat(40))
const ACTOR = controlIntentActorSchema.parse({
  installationId: 'installation-00000000-0000-4000-8000-000000000704',
  storageGenerationId: 'storage-generation-00000000-0000-4000-8000-000000000705',
  hostId: 'host-00000000-0000-4000-8000-000000000706',
  principalId: 'principal-00000000-0000-4000-8000-000000000707',
  principalRevision: 4,
  grantId: 'grant-00000000-0000-4000-8000-000000000708',
  grantRevision: 5,
})

describe('assembleReleaseSnapshot', () => {
  it('maps safe delivery facts in stable order and preserves independent source health', () => {
    const first = delivery(FIRST_WORK_ITEM_ID, 7, '709')
    const second = delivery(SECOND_WORK_ITEM_ID, 3, '710')
    const board = {
      failure: { failure: { code: 'transient-transport' as const, retryAfterMs: 250 }, failedAt: 31 },
      invalidatedAt: 32,
    } satisfies ReleaseEvidencePolicyV1Snapshot['board']
    const pullRequest = {
      failure: { failure: { code: 'not-found' as const, resource: 'pull-request' }, failedAt: 33 },
      invalidatedAt: 34,
    } satisfies ReleaseEvidencePolicyV1Snapshot['deliveries'][number]['pullRequest']
    const ci = {
      failure: { failure: { code: 'primary-rate-limit' as const, resetAt: 35 }, failedAt: 36 },
    } satisfies ReleaseEvidencePolicyV1Snapshot['deliveries'][number]['ci']
    const ancestry = {
      invalidatedAt: 37,
    } satisfies ReleaseEvidencePolicyV1Snapshot['deliveries'][number]['ancestry']

    const snapshot = assembleReleaseSnapshot({
      developmentProjectId: PROJECT_ID,
      capturedAt: 40,
      board,
      milestone: {},
      deliveries: [
        { record: second, pullRequest: {}, ci: {}, ancestry: {} },
        { record: first, pullRequest, ci, ancestry },
      ],
      tag: {},
      release: {},
      releaseCommit: {},
      upstreamCommit: {},
      upstreamAncestry: {},
    })

    expect(snapshot.deliveries.map(item => item.deliveryId)).toEqual([first.id, second.id])
    expect(snapshot.deliveries[0]).toMatchObject({
      deliveryId: first.id,
      revision: first.revision,
      workItemId: first.workItemId,
      repositoryId: REPOSITORY_ID,
      commitId: COMMIT_ID,
      headRef: first.headRef,
      baseRef: first.baseRef,
      acceptance: {
        deliveryRevision: first.revision,
        acceptedAt: first.acceptance?.acceptedAt,
        intentId: first.acceptance?.intentId,
        actorDigest: canonicalDigest('saki/release-snapshot/acceptance-actor/v1', ACTOR),
      },
    })
    expect(snapshot.board).toEqual(board)
    expect(snapshot.board).not.toBe(board)
    expect(snapshot.deliveries[0]?.pullRequest).toEqual(pullRequest)
    expect(snapshot.deliveries[0]?.pullRequest).not.toBe(pullRequest)
    expect(snapshot.deliveries[0]?.ci).toEqual(ci)
    expect(snapshot.deliveries[0]?.ancestry).toEqual(ancestry)
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain(BINDING_ID)
    expect(serialized).not.toContain(PRIVATE_KEY_REF)
    expect(serialized).not.toContain(ACTOR.principalId)
  })

  it('fails loud when a Branch Delivery belongs to another Development Project', () => {
    expect(() => assembleReleaseSnapshot({
      developmentProjectId: OTHER_PROJECT_ID,
      capturedAt: 40,
      board: {},
      milestone: {},
      deliveries: [{
        record: delivery(FIRST_WORK_ITEM_ID, 7, '711'),
        pullRequest: {},
        ci: {},
        ancestry: {},
      }],
      tag: {},
      release: {},
      releaseCommit: {},
      upstreamCommit: {},
      upstreamAncestry: {},
    })).toThrow('Branch Delivery belongs to another Development Project')
  })
})

function delivery(
  workItemId: typeof FIRST_WORK_ITEM_ID,
  revision: number,
  intentSuffix: string,
): BranchDeliveryRecord {
  const intentId = sakiControlIntentIdSchema.parse(
    `intent-00000000-0000-4000-8000-000000000${intentSuffix}`,
  )
  return {
    id: branchDeliveryId(PROJECT_ID, workItemId),
    schemaVersion: 1,
    revision,
    projectId: PROJECT_ID,
    workItemId,
    target: {
      binding: { id: BINDING_ID },
      installation: { privateKeyRef: PRIVATE_KEY_REF },
      repository: { id: REPOSITORY_ID },
    } as BranchDeliveryRecord['target'],
    commitId: COMMIT_ID,
    headRef: 'refs/heads/feature/release-snapshot',
    baseRef: 'refs/heads/master',
    markerId: githubPullRequestCreateMarkerId(`pull-request-marker-${'4'.repeat(64)}`),
    phase: 'accepted',
    remoteRef: { current: { state: 'unobserved' } },
    pullRequest: { current: { state: 'unobserved' } },
    reviews: { current: { state: 'unobserved' } },
    ci: { current: { state: 'unobserved' } },
    acceptance: {
      intentId,
      actor: ACTOR,
      acceptedAt: 30,
      evidence: { digest: '5'.repeat(64) } as NonNullable<BranchDeliveryRecord['acceptance']>['evidence'],
    },
    lastIntentId: intentId,
    createdAt: 10,
    updatedAt: 30,
  }
}
