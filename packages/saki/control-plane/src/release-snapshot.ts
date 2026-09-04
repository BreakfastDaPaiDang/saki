/** Pure assembly of safe facts for one Milestone release-evidence pass. */

import { canonicalDigest } from '@breakfastdapaidang/saki-execution'
import type { BranchDeliveryRecord } from './branch-delivery.ts'
import type {
  ReleaseEvidencePolicyV1Snapshot,
  SakiReleaseDeliveryFact,
} from './release-evidence-policy.ts'
import type { SakiDevelopmentProjectId } from './types.ts'

const ACCEPTANCE_ACTOR_DIGEST_DOMAIN = 'saki/release-snapshot/acceptance-actor/v1'

/** Existing targeted evidence paired with one durable Branch Delivery. */
export interface ReleaseSnapshotDeliveryInput {
  readonly record: BranchDeliveryRecord
  readonly pullRequest: SakiReleaseDeliveryFact['pullRequest']
  readonly ci: SakiReleaseDeliveryFact['ci']
  readonly ancestry: SakiReleaseDeliveryFact['ancestry']
}

/** Complete already-read facts needed to assemble one release-evidence snapshot. */
export interface AssembleReleaseSnapshotInput {
  readonly developmentProjectId: SakiDevelopmentProjectId
  readonly capturedAt: number
  readonly board: ReleaseEvidencePolicyV1Snapshot['board']
  readonly milestone: ReleaseEvidencePolicyV1Snapshot['milestone']
  readonly deliveries: readonly ReleaseSnapshotDeliveryInput[]
  readonly tag: ReleaseEvidencePolicyV1Snapshot['tag']
  readonly release: ReleaseEvidencePolicyV1Snapshot['release']
  readonly releaseCommit: ReleaseEvidencePolicyV1Snapshot['releaseCommit']
  readonly upstreamCommit: ReleaseEvidencePolicyV1Snapshot['upstreamCommit']
  readonly upstreamAncestry: ReleaseEvidencePolicyV1Snapshot['upstreamAncestry']
}

/**
 * Assemble safe release-policy facts without reads, writes, or source-health interpretation.
 * @param input - already-read targeted facts and durable Branch Deliveries for one Development Project.
 * @returns detached snapshot with Branch Deliveries in stable Work Item and delivery-id order.
 */
export function assembleReleaseSnapshot(input: AssembleReleaseSnapshotInput): ReleaseEvidencePolicyV1Snapshot {
  const deliveries = input.deliveries.map(({ record, pullRequest, ci, ancestry }): SakiReleaseDeliveryFact => {
    if (record.projectId !== input.developmentProjectId) {
      throw new Error('Saki release snapshot Branch Delivery belongs to another Development Project')
    }
    const acceptance = record.acceptance
    return {
      deliveryId: record.id,
      revision: record.revision,
      workItemId: record.workItemId,
      repositoryId: record.target.repository.id,
      commitId: record.commitId,
      headRef: record.headRef,
      baseRef: record.baseRef,
      pullRequest: structuredClone(pullRequest),
      ci: structuredClone(ci),
      ancestry: structuredClone(ancestry),
      ...(acceptance === undefined
        ? {}
        : {
          acceptance: {
            deliveryRevision: record.revision,
            acceptedAt: acceptance.acceptedAt,
            intentId: acceptance.intentId,
            actorDigest: canonicalDigest(ACCEPTANCE_ACTOR_DIGEST_DOMAIN, acceptance.actor),
          },
        }),
    }
  }).sort((left, right) => compareText(left.workItemId, right.workItemId)
    || compareText(left.deliveryId, right.deliveryId))

  return {
    capturedAt: input.capturedAt,
    board: structuredClone(input.board),
    milestone: structuredClone(input.milestone),
    deliveries,
    tag: structuredClone(input.tag),
    release: structuredClone(input.release),
    releaseCommit: structuredClone(input.releaseCommit),
    upstreamCommit: structuredClone(input.upstreamCommit),
    upstreamAncestry: structuredClone(input.upstreamAncestry),
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
