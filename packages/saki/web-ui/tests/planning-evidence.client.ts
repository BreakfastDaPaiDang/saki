/** Wire-validated delivery facts for pure planning presentation tests. */
import { sakiMilestoneViewResultSchema, sakiBranchDeliveryProjectionSchema } from '@breakfastdapaidang/saki-host-api/wire'
import { AUTH, ITEM, PROJECT_ID } from './planning-fixture.client.ts'

const unobserved = { current: { state: 'unobserved' } }
const parsed = sakiMilestoneViewResultSchema.parse({ ok: true, projection: {
  type: 'milestone-view',
  refresh: { requested: 'cached', state: 'cached' },
  milestoneView: {
    delivery: {
      id: `milestone-delivery-${'1'.repeat(64)}`, revision: 0, phase: 'in-progress',
      release: {
        repositoryId: ITEM.source.repositoryId, projectId: 'PVT_project', milestoneId: 'M_release', milestoneNumber: 1,
        tagName: 'saki-v0.1.0', releaseCommitId: 'a'.repeat(40), upstreamRepositoryId: 'R_upstream',
        upstreamRepositoryDatabaseId: '456', upstreamRepositoryNameWithOwner: 'upstream/harness', upstreamCommitId: 'b'.repeat(40),
      },
    },
    sources: {
      board: unobserved, milestone: unobserved, tag: unobserved, release: unobserved,
      releaseCommit: unobserved, upstreamCommit: unobserved, upstreamAncestry: unobserved,
    }, blockages: [{ kind: 'view-source', source: 'board', state: 'unobserved' }],
  },
} })
if (!parsed.ok) throw new Error('Milestone fixture failed')
export const MILESTONE = parsed.projection
export const MILESTONE_SUMMARY = {
  id: MILESTONE.milestoneView.delivery.release.milestoneId, number: 1, title: null, url: null, dueAt: null,
  issueState: null, observedAt: null, phase: 'in-progress' as const, repairRequired: false, tagName: 'saki-v0.1.0',
}

export const EVIDENCE_ACTOR = {
  installationId: 'installation-11111111-1111-4111-8111-111111111111',
  storageGenerationId: 'storage-generation-11111111-1111-4111-8111-111111111111',
  hostId: 'host-11111111-1111-4111-8111-111111111111', principalId: AUTH.principal.id,
  principalRevision: 1, grantId: 'grant-11111111-1111-4111-8111-111111111111', grantRevision: 1,
}
export const BRANCH = sakiBranchDeliveryProjectionSchema.parse({
  type: 'branch-delivery', refresh: { requested: 'cached', state: 'cached' },
  branchDelivery: {
    delivery: {
      id: `branch-delivery-${'3'.repeat(64)}`, schemaVersion: 1, revision: 2, projectId: PROJECT_ID, workItemId: ITEM.id,
      target: {
        registryRevision: 0, projectRevision: 0, synchronizationRevision: 1, mappingRevision: 1,
        binding: { id: 'binding-11111111-1111-4111-8111-111111111111', revision: 0, hostId: EVIDENCE_ACTOR.hostId, health: 'active' },
        installation: { appId: '123', installationId: '456', accountId: 'O_saki' },
        repository: { id: ITEM.source.repositoryId, databaseId: '789', nameWithOwner: 'BreakfastDaPaiDang/saki' },
        workItem: { id: ITEM.id, remoteFingerprint: ITEM.remoteFingerprint, issueId: ITEM.source.issueId },
      },
      commitId: 'a'.repeat(40), headRef: 'refs/heads/feature/planning', baseRef: 'refs/heads/master', phase: 'accepted',
      lastIntentId: 'intent-11111111-1111-4111-8111-111111111111', createdAt: 1, updatedAt: 10,
      acceptance: { intentId: 'intent-11111111-1111-4111-8111-111111111111', actor: EVIDENCE_ACTOR, acceptedAt: 10, evidenceDigest: 'e'.repeat(64) },
    },
    remoteRef: unobserved, reviews: unobserved,
    pullRequest: { current: { state: 'confirmed', observedAt: 9 }, confirmed: { confirmedAt: 9, fact: {
      id: 'PR_planning', repositoryId: ITEM.source.repositoryId, number: 45, state: 'open', merged: false, draft: false,
      title: 'Confirmed planning views', url: 'https://example.test/pull/45',
      head: { repositoryId: ITEM.source.repositoryId, ref: 'feature/planning', commitId: 'a'.repeat(40) },
      base: { repositoryId: ITEM.source.repositoryId, ref: 'master', commitId: 'b'.repeat(40) }, updatedAt: 8, observedAt: 9,
    } } },
    ci: { current: { state: 'failure', failure: { code: 'transient-transport' }, failedAt: 10 },
      confirmedSummary: { state: 'successful', signalCount: 2, observedAt: 9 },
      confirmed: { confirmedAt: 9, fact: {
        repositoryId: ITEM.source.repositoryId, commitId: 'a'.repeat(40), observedAt: 9, commitStatuses: [],
        workflowRuns: [{ id: '101', workflowId: '11', name: 'Workflow CI', event: 'pull_request', runNumber: 1, runAttempt: 1,
          status: 'completed', conclusion: 'success', url: 'https://example.test/actions/101', createdAt: 7, updatedAt: 8 }],
        checkRuns: [{ id: '201', name: 'Required check', status: 'completed', conclusion: 'success',
          url: 'https://example.test/checks/201', startedAt: 7, completedAt: 8 }],
      } },
    },
  },
}).branchDelivery

const release = MILESTONE.milestoneView.delivery.release
const milestone = {
  id: release.milestoneId, repositoryId: release.repositoryId, number: 1, state: 'open',
  title: 'September release', url: 'https://example.test/milestone/1', updatedAt: 9, observedAt: 10,
  issues: [{ id: ITEM.source.issueId, repositoryId: release.repositoryId, repositoryDatabaseId: '789',
    number: ITEM.issueNumber, title: ITEM.title, state: 'closed', url: ITEM.url, updatedAt: 9 }],
}
const releaseFact = {
  id: 'RELEASE_september', repositoryId: release.repositoryId, tagName: release.tagName, targetCommitish: release.tagName,
  draft: false, prerelease: false, url: 'https://example.test/releases/september', publishedAt: 9, observedAt: 10,
}
const upstreamAncestry = {
  repositoryId: release.repositoryId, baseCommitId: release.upstreamCommitId, headCommitId: release.releaseCommitId,
  status: 'ahead', aheadBy: 1, behindBy: 0, observedAt: 10,
}
const released = sakiMilestoneViewResultSchema.parse({ ok: true, projection: {
  ...MILESTONE, refresh: { requested: 'cached', state: 'immutable' }, milestoneView: {
    ...MILESTONE.milestoneView, blockages: [],
    sources: { ...MILESTONE.milestoneView.sources,
      milestone: { current: { state: 'confirmed', observedAt: 10 }, confirmed: { observedAt: 10, value: milestone } },
      release: { current: { state: 'confirmed', observedAt: 10 }, confirmed: { observedAt: 10, value: { kind: 'present', release: releaseFact } } },
    },
    delivery: { ...MILESTONE.milestoneView.delivery, phase: 'released', releaseEvidence: {
      intentId: BRANCH.delivery.lastIntentId, actor: EVIDENCE_ACTOR, priorMetadataRevision: 0, embeddedAt: 10,
      evidence: {
        policy: 'release-evidence/v1', evaluationDigest: 'e'.repeat(64), projectId: release.projectId,
        boardGeneration: 1, boardFingerprint: { version: 1, digest: 'b'.repeat(64) },
        milestoneId: release.milestoneId, milestoneNumber: 1, milestone, scopeFingerprint: 'c'.repeat(64),
        workItems: [{ workItemId: ITEM.id, issueId: ITEM.source.issueId, status: 'done', remoteFingerprint: ITEM.remoteFingerprint }],
        deliveries: [{ deliveryId: BRANCH.delivery.id, deliveryRevision: 2, workItemId: ITEM.id,
          commitId: BRANCH.delivery.commitId, headRef: BRANCH.delivery.headRef, baseRef: BRANCH.delivery.baseRef,
          pullRequest: BRANCH.pullRequest.confirmed!.fact, ci: BRANCH.ci.confirmed!.fact,
          acceptance: { deliveryRevision: 2, acceptedAt: 10, intentId: BRANCH.delivery.lastIntentId, actorDigest: 'f'.repeat(64) },
          ancestry: { ...upstreamAncestry, baseCommitId: release.releaseCommitId, status: 'identical', aheadBy: 0 },
        }],
        tag: { reference: { repositoryId: release.repositoryId, tagName: release.tagName, ref: `refs/tags/${release.tagName}`,
          target: { kind: 'commit', id: release.releaseCommitId }, observedAt: 10 },
        peel: { repositoryId: release.repositoryId, commitId: release.releaseCommitId, tagObjects: [], observedAt: 10 },
        },
        release: releaseFact,
        releaseCommit: { id: release.releaseCommitId, repositoryId: release.repositoryId, url: 'https://example.test/commit/release', committedAt: 8, observedAt: 10 },
        upstreamRepositoryId: release.upstreamRepositoryId, upstreamRepositoryDatabaseId: release.upstreamRepositoryDatabaseId,
        upstreamRepositoryNameWithOwner: release.upstreamRepositoryNameWithOwner,
        upstreamCommit: { id: release.upstreamCommitId, repositoryId: release.upstreamRepositoryId, url: 'https://example.test/commit/upstream', committedAt: 7, observedAt: 10 },
        upstreamAncestry, confirmedAt: 10,
      },
    } },
  },
} })
if (!released.ok) throw new Error('Released Milestone fixture failed')
export const RELEASED_MILESTONE = released.projection
