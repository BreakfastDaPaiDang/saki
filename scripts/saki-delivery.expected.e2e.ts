/** Keyless assembled Saki snapshot from a real local Commit through immutable release evidence. */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type {
  SakiBoardProjection,
  SakiProjectChangesProjection,
  StageFilesIntent,
} from '@breakfastdapaidang/saki-control-plane'
import type { ProjectGitStatusObservation, SelectedProjectGitChange } from '@breakfastdapaidang/saki-execution'
import { sakiControlIntentIdSchema } from '@breakfastdapaidang/saki-execution'
import {
  sakiBoardResultSchema,
  sakiBranchDeliveryIntentResultSchema,
  sakiBranchDeliveryResultSchema,
  sakiConfigureGitHubSynchronizationResultSchema,
  sakiCreateCommitResultSchema,
  sakiMilestoneDeliveryIntentResultSchema,
  sakiMilestoneViewResultSchema,
  sakiProjectChangesResultSchema,
  sakiProjectIndexResultSchema,
  sakiStageFilesResultSchema,
} from '@breakfastdapaidang/saki-host-api'
import { describe, expect, it } from 'vitest'
import {
  SAKI_BOARD_SNAPSHOT_CONFIGURATION,
  SAKI_DELIVERY_SNAPSHOT_RELEASE_TARGET,
  initializeSakiBoardSnapshotMutationState,
  readSakiBoardSnapshotMutationState,
} from './fixtures/saki-board-fake-github.ts'
import {
  cleanupSnapshot,
  createRepository,
  freePort,
  inspectSnapshotRepositoryGitState,
  mutationExpectation,
  registerSnapshotProject,
  rpc,
  runWithCleanup,
  serializeSnapshotRecords,
  startSaki,
  verifySnapshotOutput,
  type StartedSaki,
} from './fixtures/saki-host-snapshot.ts'

const root = resolve(import.meta.dirname, '..')
const driver = join(root, 'scripts/fixtures/saki-board-snapshot-driver.ts')
const expected = join(root, 'scripts/tests/expected/saki-delivery/delivery.expected.jsonl')
const refreshing = process.env.DSH_SNAPSHOT === 'record' || process.env.DSH_SNAPSHOT === 'refresh'

type ConfirmedBoard = SakiBoardProjection & {
  readonly state: 'confirmed'
  readonly confirmed: NonNullable<SakiBoardProjection['confirmed']>
  readonly checkpoint: NonNullable<SakiBoardProjection['checkpoint']>
}

type SuccessfulChanges = Omit<SakiProjectChangesProjection, 'result'> & {
  readonly result: Extract<SakiProjectChangesProjection['result'], { readonly ok: true }>
}

function requireConfirmedBoard(projection: SakiBoardProjection): ConfirmedBoard | undefined {
  if (projection.state !== 'confirmed' || projection.confirmed === undefined || projection.checkpoint === undefined) {
    return undefined
  }
  return projection as ConfirmedBoard
}

async function waitForConfirmedBoard(
  port: number,
  cookie: string,
  projectId: string,
  accept: (projection: ConfirmedBoard) => boolean = () => true,
): Promise<ConfirmedBoard> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const response = await rpc(port, 'control/query', { type: 'board', projectId, refresh: 'cached' }, { cookie })
    const result = sakiBoardResultSchema.parse(response.value)
    const confirmed = result.ok ? requireConfirmedBoard(result.projection) : undefined
    if (confirmed !== undefined && confirmed.mapping.state === 'valid' && accept(confirmed)) return confirmed
    await delay(20)
  }
  throw new Error('Saki Delivery snapshot did not reach a confirmed Board')
}

async function queryBranchDelivery(
  port: number,
  cookie: string,
  projectId: string,
  workItemId: string,
  refresh: 'cached' | 'interactive' = 'cached',
) {
  const response = await rpc(port, 'control/query', {
    type: 'branch-delivery',
    projectId,
    workItemId,
    refresh,
  }, { cookie })
  const result = sakiBranchDeliveryResultSchema.parse(response.value)
  if (!result.ok) throw new Error('Saki Delivery snapshot lost its Branch Delivery')
  return result.projection
}

async function queryMilestoneView(
  port: number,
  cookie: string,
  projectId: string,
  refresh: 'cached' | 'interactive' = 'cached',
) {
  const response = await rpc(port, 'control/query', {
    type: 'milestone-view',
    projectId,
    milestoneId: SAKI_DELIVERY_SNAPSHOT_RELEASE_TARGET.milestoneId,
    refresh,
  }, { cookie })
  const result = sakiMilestoneViewResultSchema.parse(response.value)
  if (!result.ok) throw new Error('Saki Delivery snapshot lost its Milestone Delivery')
  return result.projection
}

async function queryProjectChanges(
  port: number,
  cookie: string,
  projectId: string,
  expectedRegistryRevision: number,
): Promise<SuccessfulChanges> {
  const response = await rpc(port, 'control/query', {
    type: 'project-changes',
    projectId,
    expectedRegistryRevision,
  }, { cookie })
  const result = sakiProjectChangesResultSchema.parse(response.value)
  if (!result.ok || !result.projection.result.ok) {
    throw new Error('Saki Delivery snapshot could not inspect Project changes')
  }
  return result.projection as SuccessfulChanges
}

function selectedChanges(observation: ProjectGitStatusObservation): readonly SelectedProjectGitChange[] {
  const selected = observation.changes
    .filter(change => change.kind === 'untracked'
      || (change.kind === 'ordinary' && change.worktreeStatus !== 'unchanged'))
    .map(change => ({ id: change.id, fingerprint: change.fingerprint }))
  if (selected.length === 0) throw new Error('Saki Delivery snapshot found no changes to stage')
  return selected
}

async function transcript(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'saki-delivery-snapshot-'))
  let started: StartedSaki | undefined
  return await runWithCleanup(async () => {
    const runtimeRoot = join(directory, 'runtime')
    await mkdir(runtimeRoot, { recursive: true })
    const providerStatePath = join(directory, 'provider-state')
    await writeFile(providerStatePath, 'complete\n')
    const repository = await createRepository(directory)
    const initialGit = await inspectSnapshotRepositoryGitState(repository)
    await initializeSakiBoardSnapshotMutationState(providerStatePath, initialGit.headObjectId)
    await writeFile(join(repository, 'tracked.txt'), 'delivery\n')
    const databasePath = join(directory, 'control.sqlite')
    const port = await freePort()
    started = await startSaki(driver, databasePath, port, true, runtimeRoot, {
      boardProviderStatePath: providerStatePath,
      deliverySnapshot: true,
    })
    /* The delivery transcript owns its complete bootstrap/configuration prefix;
     * snapshot scenarios remain independently runnable and reviewable. */
    /* jscpd:ignore-start */
    const {
      exchangeValue,
      cookie,
      confirmed: registration,
    } = await registerSnapshotProject(port, started.bootstrapSecret, repository)

    const configurationResponse = await rpc(port, 'control/submit', {
      type: 'configure-github-synchronization',
      intentId: 'intent-22222222-2222-4222-8222-222222222222',
      projectId: registration.receipt.projectId,
      expectedSynchronizationRevision: 0,
      patch: SAKI_BOARD_SNAPSHOT_CONFIGURATION,
    }, { cookie, requestToken: exchangeValue.access.requestToken })
    const configured = sakiConfigureGitHubSynchronizationResultSchema.parse(configurationResponse.value)
    if (!configured.ok) throw new Error(`Saki Delivery snapshot configuration failed: ${configured.reason}`)
    /* jscpd:ignore-end */
    const board = await waitForConfirmedBoard(port, cookie, registration.receipt.projectId)
    const workItem = board.confirmed.items.find(item => item.issueNumber === 27)
    if (workItem === undefined || board.mapping.state !== 'valid') {
      throw new Error('Saki Delivery snapshot Board lacks its delivery Work Item')
    }

    const changes = await queryProjectChanges(
      port,
      cookie,
      registration.receipt.projectId,
      registration.receipt.registryRevision,
    )
    const stageIntent: StageFilesIntent = {
      type: 'stage-files',
      intentId: sakiControlIntentIdSchema.parse('intent-33333333-3333-4333-8333-333333333333'),
      expected: mutationExpectation(changes),
      changes: selectedChanges(changes.result.observation),
    }
    const stageResponse = await rpc(port, 'control/submit', stageIntent, {
      cookie,
      requestToken: exchangeValue.access.requestToken,
    })
    const staged = sakiStageFilesResultSchema.parse(stageResponse.value)
    if (!staged.ok) throw new Error(`Saki Delivery snapshot StageFiles failed: ${staged.reason}`)
    const commitReady = await queryProjectChanges(
      port,
      cookie,
      registration.receipt.projectId,
      registration.receipt.registryRevision,
    )
    const commitResponse = await rpc(port, 'control/submit', {
      type: 'create-commit',
      intentId: 'intent-44444444-4444-4444-8444-444444444444',
      expected: mutationExpectation(commitReady),
      message: 'Deliver snapshot Work Item',
    }, { cookie, requestToken: exchangeValue.access.requestToken })
    const committed = sakiCreateCommitResultSchema.parse(commitResponse.value)
    if (!committed.ok) throw new Error(`Saki Delivery snapshot CreateCommit failed: ${committed.reason}`)
    const git = await inspectSnapshotRepositoryGitState(repository)

    const indexResponse = await rpc(port, 'control/query', { type: 'project-index' }, { cookie })
    const index = sakiProjectIndexResultSchema.parse(indexResponse.value)
    if (!index.ok) throw new Error(`Saki Delivery snapshot Project index failed: ${index.reason}`)
    const project = index.projection.projects.find(candidate => candidate.id === registration.receipt.projectId)
    if (project === undefined || project.binding.health !== 'active') {
      throw new Error('Saki Delivery snapshot lost its active Project Binding')
    }
    const saveResponse = await rpc(port, 'control/submit', {
      type: 'save-branch-delivery',
      intentId: 'intent-55555555-5555-4555-8555-555555555555',
      projectId: project.id,
      workItemId: workItem.id,
      expected: {
        deliveryRevision: null,
        registryRevision: index.projection.revision,
        projectRevision: project.revision,
        binding: { id: project.binding.id, revision: project.binding.revision },
        synchronizationRevision: board.synchronizationRevision,
        mappingRevision: board.mapping.configurationRevision,
        workItemRemoteFingerprint: workItem.remoteFingerprint,
      },
      commitId: git.headObjectId,
      headRef: 'refs/heads/saki/snapshot-delivery',
      baseRef: 'refs/heads/main',
    }, { cookie, requestToken: exchangeValue.access.requestToken })
    const saved = sakiBranchDeliveryIntentResultSchema.parse(saveResponse.value)
    if (!saved.ok || saved.receipt.deliveryRevision === undefined) {
      throw new Error(`Saki Delivery snapshot save failed: ${JSON.stringify(saved)}`)
    }
    const pushResponse = await rpc(port, 'control/submit', {
      type: 'push-branch-delivery',
      intentId: 'intent-66666666-6666-4666-8666-666666666666',
      deliveryId: saved.receipt.deliveryId,
      expectedDeliveryRevision: saved.receipt.deliveryRevision,
    }, { cookie, requestToken: exchangeValue.access.requestToken })
    const pushed = sakiBranchDeliveryIntentResultSchema.parse(pushResponse.value)
    if (!pushed.ok || pushed.receipt.deliveryRevision === undefined) {
      const fakeRemote = await readSakiBoardSnapshotMutationState(providerStatePath)
      throw new Error(`Saki Delivery snapshot Push failed: ${JSON.stringify({ pushed, fakeRemote })}`)
    }
    const pushedDelivery = await queryBranchDelivery(port, cookie, project.id, workItem.id)
    const pushedRemote = await readSakiBoardSnapshotMutationState(providerStatePath)
    expect(pushedRemote.pushedCommitId).toBe(git.headObjectId)
    expect(pushedRemote.pushCount).toBe(1)

    const pullRequestResponse = await rpc(port, 'control/submit', {
      type: 'create-branch-delivery-pull-request',
      intentId: 'intent-77777777-7777-4777-8777-777777777777',
      deliveryId: pushed.receipt.deliveryId,
      expectedDeliveryRevision: pushed.receipt.deliveryRevision,
      title: 'Deliver snapshot Work Item',
      body: 'Carries the selected Commit through human acceptance.',
    }, { cookie, requestToken: exchangeValue.access.requestToken })
    const pullRequestCreated = sakiBranchDeliveryIntentResultSchema.parse(pullRequestResponse.value)
    if (!pullRequestCreated.ok || pullRequestCreated.receipt.deliveryRevision === undefined) {
      throw new Error(`Saki Delivery snapshot Pull Request create failed: ${JSON.stringify(pullRequestCreated)}`)
    }
    const pullRequestDelivery = await queryBranchDelivery(port, cookie, project.id, workItem.id)
    const pullRequestRemote = await readSakiBoardSnapshotMutationState(providerStatePath)
    expect(pullRequestRemote.pullRequestCreateCount).toBe(1)
    expect(pullRequestDelivery.branchDelivery.pullRequest.confirmed?.fact.number).toBe(72)

    const reviewResponse = await rpc(port, 'control/submit', {
      type: 'mark-branch-delivery-in-review',
      intentId: 'intent-88888888-8888-4888-8888-888888888888',
      deliveryId: pullRequestCreated.receipt.deliveryId,
      expectedDeliveryRevision: pullRequestCreated.receipt.deliveryRevision,
      expectedWorkItemRemoteFingerprint:
        pullRequestDelivery.branchDelivery.delivery.target.workItem.remoteFingerprint,
    }, { cookie, requestToken: exchangeValue.access.requestToken })
    const markedInReview = sakiBranchDeliveryIntentResultSchema.parse(reviewResponse.value)
    if (!markedInReview.ok || markedInReview.receipt.deliveryRevision === undefined) {
      throw new Error(`Saki Delivery snapshot review transition failed: ${JSON.stringify(markedInReview)}`)
    }
    const reviewDelivery = await queryBranchDelivery(port, cookie, project.id, workItem.id, 'interactive')
    const reviewRemote = await readSakiBoardSnapshotMutationState(providerStatePath)
    const approvedReviews = reviewDelivery.branchDelivery.reviews.confirmed?.fact.reviews
      .filter(review => review.state === 'approved') ?? []
    expect(reviewDelivery.refresh.state).toBe('confirmed')
    expect(reviewDelivery.branchDelivery.delivery.phase).toBe('in-review')
    expect(reviewDelivery.branchDelivery.reviews.current.state).toBe('confirmed')
    expect(approvedReviews).toHaveLength(1)
    expect(approvedReviews[0]?.commitId).toBe(git.headObjectId)
    expect(reviewDelivery.branchDelivery.delivery.acceptance).toBeUndefined()
    expect(reviewRemote.statusOptionId).toBe(SAKI_BOARD_SNAPSHOT_CONFIGURATION.statusOptionNodeIds.inReview)

    const acceptResponse = await rpc(port, 'control/submit', {
      type: 'accept-branch-delivery',
      intentId: 'intent-99999999-9999-4999-8999-999999999999',
      deliveryId: markedInReview.receipt.deliveryId,
      expectedDeliveryRevision: reviewDelivery.branchDelivery.delivery.revision,
      expectedWorkItemRemoteFingerprint: reviewDelivery.branchDelivery.delivery.target.workItem.remoteFingerprint,
    }, { cookie, requestToken: exchangeValue.access.requestToken })
    const accepted = sakiBranchDeliveryIntentResultSchema.parse(acceptResponse.value)
    if (!accepted.ok || accepted.receipt.deliveryRevision === undefined) {
      throw new Error(`Saki Delivery snapshot acceptance failed: ${JSON.stringify(accepted)}`)
    }
    const acceptedDelivery = await queryBranchDelivery(port, cookie, project.id, workItem.id, 'interactive')
    const acceptedRemote = await readSakiBoardSnapshotMutationState(providerStatePath)
    expect(acceptedDelivery.refresh.state).toBe('immutable')
    expect(acceptedDelivery.branchDelivery.delivery.phase).toBe('accepted')
    expect(acceptedDelivery.branchDelivery.reviews.current.state).toBe('confirmed')
    expect(acceptedDelivery.branchDelivery.reviews.confirmed?.fact.reviews)
      .toContainEqual(expect.objectContaining({ state: 'approved', commitId: git.headObjectId }))
    expect(acceptedDelivery.branchDelivery.delivery.acceptance?.intentId)
      .toBe('intent-99999999-9999-4999-8999-999999999999')
    expect(acceptedRemote.statusOptionId).toBe(SAKI_BOARD_SNAPSHOT_CONFIGURATION.statusOptionNodeIds.done)
    expect(acceptedRemote.issueState).toBe('closed')

    const doneBoard = await waitForConfirmedBoard(
      port,
      cookie,
      project.id,
      projection => projection.checkpoint.generation > board.checkpoint.generation
        && projection.mutationOverlays.length === 0
        && projection.confirmed.items.some(item => item.id === workItem.id
          && item.status === 'done' && item.issueState === 'closed'),
    )
    const doneWorkItem = doneBoard.confirmed.items.find(item => item.id === workItem.id)
    if (doneWorkItem === undefined) throw new Error('Saki Delivery snapshot lost its Done Work Item')

    const releaseIndexResponse = await rpc(port, 'control/query', { type: 'project-index' }, { cookie })
    const releaseIndex = sakiProjectIndexResultSchema.parse(releaseIndexResponse.value)
    if (!releaseIndex.ok) throw new Error(`Saki Delivery snapshot release index failed: ${releaseIndex.reason}`)
    const releaseProject = releaseIndex.projection.projects.find(candidate => candidate.id === project.id)
    if (releaseProject === undefined) throw new Error('Saki Delivery snapshot lost its release Project')
    const release = {
      repositoryId: SAKI_BOARD_SNAPSHOT_CONFIGURATION.repositoryNodeId,
      projectId: SAKI_BOARD_SNAPSHOT_CONFIGURATION.projectNodeId,
      milestoneId: SAKI_DELIVERY_SNAPSHOT_RELEASE_TARGET.milestoneId,
      milestoneNumber: SAKI_DELIVERY_SNAPSHOT_RELEASE_TARGET.milestoneNumber,
      tagName: SAKI_DELIVERY_SNAPSHOT_RELEASE_TARGET.tagName,
      releaseCommitId: git.headObjectId,
      upstreamRepositoryId: SAKI_DELIVERY_SNAPSHOT_RELEASE_TARGET.upstreamRepositoryId,
      upstreamRepositoryDatabaseId: SAKI_DELIVERY_SNAPSHOT_RELEASE_TARGET.upstreamRepositoryDatabaseId,
      upstreamRepositoryNameWithOwner: SAKI_DELIVERY_SNAPSHOT_RELEASE_TARGET.upstreamRepositoryNameWithOwner,
      upstreamCommitId: git.headObjectId,
    }
    const saveMilestoneResponse = await rpc(port, 'control/submit', {
      type: 'save-milestone-delivery',
      intentId: 'intent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      projectId: releaseProject.id,
      expectedDeliveryRevision: null,
      expectedRegistryRevision: releaseIndex.projection.revision,
      expectedProjectRevision: releaseProject.revision,
      phase: 'ready-to-release',
      release,
    }, { cookie, requestToken: exchangeValue.access.requestToken })
    const milestoneSaved = sakiMilestoneDeliveryIntentResultSchema.parse(saveMilestoneResponse.value)
    if (!milestoneSaved.ok || milestoneSaved.receipt.deliveryRevision === undefined) {
      throw new Error(`Saki Delivery snapshot Milestone save failed: ${JSON.stringify(milestoneSaved)}`)
    }
    const finalizeResponse = await rpc(port, 'control/submit', {
      type: 'finalize-milestone-delivery',
      intentId: 'intent-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      deliveryId: milestoneSaved.receipt.deliveryId,
      expectedDeliveryRevision: milestoneSaved.receipt.deliveryRevision,
      release,
    }, { cookie, requestToken: exchangeValue.access.requestToken })
    const finalized = sakiMilestoneDeliveryIntentResultSchema.parse(finalizeResponse.value)
    if (!finalized.ok || finalized.receipt.deliveryRevision === undefined) {
      throw new Error(`Saki Delivery snapshot Milestone finalization failed: ${JSON.stringify(finalized)}`)
    }
    const milestone = await queryMilestoneView(port, cookie, project.id, 'interactive')
    const evidence = milestone.milestoneView.delivery.releaseEvidence?.evidence
    const evidencedWorkItem = evidence?.workItems.find(item => item.workItemId === workItem.id)
    const evidencedDelivery = evidence?.deliveries.find(item => item.workItemId === workItem.id)
    if (evidence === undefined || evidencedWorkItem === undefined || evidencedDelivery === undefined) {
      throw new Error('Saki Delivery snapshot lacks complete immutable release evidence')
    }
    const releaseExpectation = milestone.milestoneView.delivery.release
    const evidenceIdentities = {
      milestoneId: evidence.milestoneId,
      milestoneNumber: evidence.milestoneNumber,
      tagName: evidence.tag.reference.tagName,
      tagRef: evidence.tag.reference.ref,
      releaseRepositoryId: evidence.release.repositoryId,
      releaseTagName: evidence.release.tagName,
      upstreamRepositoryId: releaseExpectation.upstreamRepositoryId,
      upstreamRepositoryNameWithOwner: releaseExpectation.upstreamRepositoryNameWithOwner,
      pullRequestHeadRef: evidencedDelivery.pullRequest.head.ref,
      pullRequestBaseRef: evidencedDelivery.pullRequest.base.ref,
    }
    const evidenceRelationships = {
      milestoneRepositoryExact: evidence.milestone.repositoryId === release.repositoryId,
      tagTargetIsReleaseCommit: evidence.tag.reference.target.kind === 'commit'
        && evidence.tag.reference.target.id === release.releaseCommitId,
      tagPeelIsReleaseCommit: evidence.tag.peel.commitId === release.releaseCommitId,
      releaseCommitExact: evidence.releaseCommit.id === release.releaseCommitId,
      upstreamExpectationExact:
        releaseExpectation.upstreamRepositoryId === SAKI_DELIVERY_SNAPSHOT_RELEASE_TARGET.upstreamRepositoryId
        && releaseExpectation.upstreamRepositoryDatabaseId
          === SAKI_DELIVERY_SNAPSHOT_RELEASE_TARGET.upstreamRepositoryDatabaseId
        && releaseExpectation.upstreamRepositoryNameWithOwner
          === SAKI_DELIVERY_SNAPSHOT_RELEASE_TARGET.upstreamRepositoryNameWithOwner,
      upstreamCommitExact: evidence.upstreamCommit.repositoryId === release.upstreamRepositoryId
        && evidence.upstreamCommit.id === release.upstreamCommitId,
      pullRequestRepositoryExact: evidencedDelivery.pullRequest.repositoryId === release.repositoryId
        && evidencedDelivery.pullRequest.head.repositoryId === release.repositoryId
        && evidencedDelivery.pullRequest.base.repositoryId === release.repositoryId,
      pullRequestBaseIsInitialCommit: evidencedDelivery.pullRequest.base.commitId === initialGit.headObjectId,
      deliveryAncestryEndpointsExact: evidencedDelivery.ancestry.baseCommitId === evidencedDelivery.commitId
        && evidencedDelivery.ancestry.headCommitId === release.releaseCommitId,
      upstreamAncestryEndpointsExact: evidence.upstreamAncestry.baseCommitId === release.upstreamCommitId
        && evidence.upstreamAncestry.headCommitId === release.releaseCommitId,
    }
    expect(milestone.refresh.state).toBe('immutable')
    expect(milestone.milestoneView.delivery.phase).toBe('released')
    expect(evidence.policy).toBe('release-evidence/v1')
    expect(evidencedWorkItem.status).toBe('done')
    expect(evidencedDelivery.commitId).toBe(git.headObjectId)
    expect(evidenceIdentities).toEqual({
      milestoneId: SAKI_DELIVERY_SNAPSHOT_RELEASE_TARGET.milestoneId,
      milestoneNumber: SAKI_DELIVERY_SNAPSHOT_RELEASE_TARGET.milestoneNumber,
      tagName: SAKI_DELIVERY_SNAPSHOT_RELEASE_TARGET.tagName,
      tagRef: `refs/tags/${SAKI_DELIVERY_SNAPSHOT_RELEASE_TARGET.tagName}`,
      releaseRepositoryId: SAKI_BOARD_SNAPSHOT_CONFIGURATION.repositoryNodeId,
      releaseTagName: SAKI_DELIVERY_SNAPSHOT_RELEASE_TARGET.tagName,
      upstreamRepositoryId: SAKI_DELIVERY_SNAPSHOT_RELEASE_TARGET.upstreamRepositoryId,
      upstreamRepositoryNameWithOwner: SAKI_DELIVERY_SNAPSHOT_RELEASE_TARGET.upstreamRepositoryNameWithOwner,
      pullRequestHeadRef: 'saki/snapshot-delivery',
      pullRequestBaseRef: 'main',
    })
    expect(evidenceRelationships).toEqual({
      milestoneRepositoryExact: true,
      tagTargetIsReleaseCommit: true,
      tagPeelIsReleaseCommit: true,
      releaseCommitExact: true,
      upstreamExpectationExact: true,
      upstreamCommitExact: true,
      pullRequestRepositoryExact: true,
      pullRequestBaseIsInitialCommit: true,
      deliveryAncestryEndpointsExact: true,
      upstreamAncestryEndpointsExact: true,
    })

    const records = [
      {
        step: 'real-commit',
        result: {
          staged: staged.receipt.state,
          committed: committed.receipt.state,
          commitCreated: git.commitCount === 2,
          cleanWorktree: git.stagedPaths.length === 0 && git.unstagedPaths.length === 0,
        },
      },
      {
        step: 'branch-selected',
        result: {
          state: saved.receipt.state,
          selectedCommitIsHead: pushedDelivery.branchDelivery.delivery.commitId === git.headObjectId,
          phase: pushedDelivery.branchDelivery.delivery.phase,
        },
      },
      {
        step: 'branch-pushed',
        result: {
          state: pushed.receipt.state,
          pushedOnce: pushedRemote.pushCount === 1,
          remoteMatchesCommit: pushedRemote.pushedCommitId === git.headObjectId,
        },
      },
      {
        step: 'pull-request-created',
        result: {
          state: pullRequestCreated.receipt.state,
          createdOnce: pullRequestRemote.pullRequestCreateCount === 1,
          exactHeadCommit: pullRequestDelivery.branchDelivery.pullRequest.confirmed?.fact.head.commitId
            === git.headObjectId,
        },
      },
      {
        step: 'human-in-review',
        result: {
          state: markedInReview.receipt.state,
          deliveryPhase: reviewDelivery.branchDelivery.delivery.phase,
          boardStatus: reviewRemote.statusOptionId === SAKI_BOARD_SNAPSHOT_CONFIGURATION.statusOptionNodeIds.inReview
            ? 'in-review'
            : 'unexpected',
          statusTransitions: reviewRemote.dispatchCount,
          reviewSource: reviewDelivery.branchDelivery.reviews.current.state,
          approvedReviewCount: approvedReviews.length,
          approvedReviewMatchesCommit: approvedReviews[0]?.commitId === git.headObjectId,
          reviewDidNotAcceptDelivery: reviewDelivery.branchDelivery.delivery.acceptance === undefined,
        },
      },
      {
        step: 'human-done',
        result: {
          state: accepted.receipt.state,
          deliveryPhase: acceptedDelivery.branchDelivery.delivery.phase,
          boardStatus: doneWorkItem.status,
          issueState: doneWorkItem.issueState,
          statusTransitions: acceptedRemote.dispatchCount,
          issueStateTransitions: acceptedRemote.issueStateDispatchCount,
          completeScanRetiredOverlays: doneBoard.mutationOverlays.length === 0,
          humanAcceptanceRecorded: acceptedDelivery.branchDelivery.delivery.acceptance !== undefined,
          humanAcceptanceIntentExact: acceptedDelivery.branchDelivery.delivery.acceptance?.intentId
            === 'intent-99999999-9999-4999-8999-999999999999',
          approvedReviewRemainsContext: acceptedDelivery.branchDelivery.reviews.confirmed?.fact.reviews
            .some(review => review.state === 'approved' && review.commitId === git.headObjectId) === true,
        },
      },
      {
        step: 'milestone-finalized',
        result: {
          saveState: milestoneSaved.receipt.state,
          finalizeState: finalized.receipt.state,
          viewState: milestone.refresh.state,
          phase: milestone.milestoneView.delivery.phase,
          policy: evidence.policy,
          scopeComplete: milestone.milestoneView.scope?.complete,
          workItemStatus: evidencedWorkItem.status,
          acceptedDeliveryCount: evidence.deliveries.length,
          commitRelationshipPreserved: evidencedDelivery.commitId === git.headObjectId,
          acceptanceRevisionSealed: evidencedDelivery.acceptance.deliveryRevision
            === evidencedDelivery.deliveryRevision,
          identities: evidenceIdentities,
          relationships: evidenceRelationships,
        },
      },
    ]
    const output = serializeSnapshotRecords(records, [
      directory,
      repository,
      providerStatePath,
      started.bootstrapSecret,
      cookie,
      exchangeValue.access.requestToken,
      initialGit.headObjectId,
      git.headObjectId,
    ])
    await started.stop()
    started = undefined
    return output
  }, async () => { await cleanupSnapshot(directory, started) })
}

async function verify(): Promise<void> {
  await verifySnapshotOutput(expected, await transcript(), refreshing)
}

describe('assembled Saki Branch and Milestone Delivery snapshot', () => {
  it('carries one real Commit through the keyless product delivery path', async () => {
    await verify()
  }, 600_000)
})
