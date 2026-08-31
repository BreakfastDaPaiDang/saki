import { describe, expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { canonicalDigest } from '@breakfastdapaidang/saki-execution'
import {
  githubAccountId,
  githubAppId,
  githubInstallationId,
  githubIssueId,
  githubProjectFieldId,
  githubProjectId,
  githubProjectItemId,
  githubProjectOptionId,
  githubRepositoryDatabaseId,
  githubRepositoryId,
} from '@breakfastdapaidang/saki-github'
import {
  githubWorkItemIntentRecordSchema,
  githubWorkItemRecoveryRecordSchema,
} from '../src/spec.ts'
import { targetedBoardRemoteFingerprint } from '../src/work-item-mapping.ts'
import { renderGitHubWorkItemIssueBody } from '../src/work-item-issue.ts'
import {
  sakiBoardWorkItemIdSchema,
  sakiControlIntentIdSchema,
  sakiDevelopmentProjectIdSchema,
  sakiIntentReceiptIdSchema,
  sakiWorkItemRecoveryIdSchema,
} from '../src/ids.ts'

const INTENT_ID = sakiControlIntentIdSchema.parse('intent-00000000-0000-4000-8000-000000000001')
const RECEIPT_ID = sakiIntentReceiptIdSchema.parse('receipt-00000000-0000-4000-8000-000000000001')
const PROJECT_ID = sakiDevelopmentProjectIdSchema.parse('project-00000000-0000-4000-8000-000000000002')
const WORK_ITEM_ID = sakiBoardWorkItemIdSchema.parse(`work-item-${canonicalDigest('saki/board-work-item/v1', {
  repositoryId: 'R_repo',
  issueId: 'I_issue',
})}`)
const RECOVERY_ID = sakiWorkItemRecoveryIdSchema.parse(`work-item-recovery-${canonicalDigest('saki/work-item-recovery/v1', {
  projectId: PROJECT_ID,
  workItemId: WORK_ITEM_ID,
})}`)

const actor = {
  installationId: 'installation-00000000-0000-4000-8000-000000000003',
  storageGenerationId: 'storage-generation-00000000-0000-4000-8000-000000000004',
  hostId: 'host-00000000-0000-4000-8000-000000000005',
  principalId: 'principal-00000000-0000-4000-8000-000000000006',
  principalRevision: 1,
  grantId: 'grant-00000000-0000-4000-8000-000000000007',
  grantRevision: 2,
} as const

const createPayload = {
  intent: {
    type: 'create-work-item',
    intentId: INTENT_ID,
    projectId: PROJECT_ID,
    expected: {
      projectRevision: 4,
      synchronizationRevision: 3,
      mappingRevision: 2,
    },
    title: 'Keep recovery durable',
    intendedOutcome: 'The operator can resume a partially-created Work Item.',
    acceptanceCriteria: ['Issue exists once', 'Project membership is confirmed'],
  },
  actor,
} as const

const installation = {
  appId: githubAppId('10'),
  installationId: githubInstallationId('11'),
  accountId: githubAccountId('A_account'),
  privateKeyRef: credentialRef('SAKI_GITHUB_PRIVATE_KEY'),
} as const

const createTarget = {
  kind: 'create-work-item',
  installation,
  repositoryId: githubRepositoryId('R_repo'),
  repositoryDatabaseId: githubRepositoryDatabaseId('12'),
  projectId: githubProjectId('P_project'),
  statusFieldId: githubProjectFieldId('F_status'),
  desiredStatusOptionId: githubProjectOptionId('O_inbox'),
  markerId: `work-item-marker-${'a'.repeat(64)}`,
} as const

const issueCreateResolvedTarget = {
  kind: 'issue-create',
  installation,
  repositoryId: createTarget.repositoryId,
  repositoryDatabaseId: createTarget.repositoryDatabaseId,
  markerId: createTarget.markerId,
  titleDigest: canonicalDigest('saki/work-item-issue-title/v1', { title: createPayload.intent.title }),
  bodyDigest: canonicalDigest('saki/work-item-issue-body/v1', {
    body: renderGitHubWorkItemIssueBody({
      intendedOutcome: createPayload.intent.intendedOutcome,
      acceptanceCriteria: createPayload.intent.acceptanceCriteria,
      markerId: createTarget.markerId,
    }),
  }),
} as const

const createRecord = {
  id: INTENT_ID,
  schemaVersion: 1,
  revision: 0,
  receiptId: RECEIPT_ID,
  payload: createPayload,
  payloadDigest: canonicalDigest('saki/github-work-item-intent/v1', createPayload),
  target: createTarget,
  phase: 'prepared',
  stages: [
    {
      mutationId: `work-item:${INTENT_ID}:issue`,
      kind: 'issue-create',
      resolvedTarget: issueCreateResolvedTarget,
      state: 'prepared',
      effectPossible: false,
    },
    {
      mutationId: `work-item:${INTENT_ID}:membership`,
      kind: 'project-item-add',
      state: 'prepared',
      effectPossible: false,
    },
    {
      mutationId: `work-item:${INTENT_ID}:status`,
      kind: 'project-item-status-set',
      state: 'prepared',
      effectPossible: false,
    },
  ],
  observedPrefix: [],
  createdAt: 100,
  updatedAt: 100,
} as const

const targetedSnapshot = {
  repositoryId: githubRepositoryId('R_repo'),
  repositoryDatabaseId: githubRepositoryDatabaseId('12'),
  projectId: githubProjectId('P_project'),
  statusFieldId: githubProjectFieldId('F_status'),
  issue: {
    id: githubIssueId('I_issue'),
    repositoryId: githubRepositoryId('R_repo'),
    repositoryDatabaseId: githubRepositoryDatabaseId('12'),
    number: 8,
    state: 'open',
    title: 'Keep recovery durable',
    url: 'https://github.com/example/repo/issues/8',
    updatedAt: 101,
  },
  membership: {
    state: 'present',
    item: {
      id: githubProjectItemId('PVTI_item'),
      projectId: githubProjectId('P_project'),
      issueId: githubIssueId('I_issue'),
      statusOptionId: githubProjectOptionId('O_inbox'),
      archived: false,
      apiOrder: 0,
      previousItemId: null,
      nextItemId: null,
      totalCount: 1,
      updatedAt: 101,
    },
  },
} as const

const REMOTE_FINGERPRINT = targetedBoardRemoteFingerprint(targetedSnapshot)

const confirmedObservation = {
  stageMutationId: 'saki:work-item:move:status',
  stageKind: 'project-item-status-set',
  workItemId: WORK_ITEM_ID,
  remoteFingerprint: REMOTE_FINGERPRINT,
  facts: targetedSnapshot,
  observedAt: 101,
} as const

describe('durable GitHub Work Item state', () => {
  it('freezes browser-safe create input separately from server-derived targets and stable stages', () => {
    expect(githubWorkItemIntentRecordSchema.parse(createRecord)).toEqual(createRecord)
    for (const key of ['titleDigest', 'bodyDigest'] as const) {
      const forgedTarget = { ...issueCreateResolvedTarget, [key]: 'f'.repeat(64) }
      expect(githubWorkItemIntentRecordSchema.safeParse({
        ...createRecord,
        stages: [{
          ...createRecord.stages[0],
          resolvedTarget: forgedTarget,
        }, ...createRecord.stages.slice(1)],
      }).success).toBe(false)
    }

    const issueObservation = {
      stageMutationId: createRecord.stages[0].mutationId,
      stageKind: 'issue-create',
      workItemId: WORK_ITEM_ID,
      repositoryId: targetedSnapshot.repositoryId,
      repositoryDatabaseId: targetedSnapshot.repositoryDatabaseId,
      markerId: createTarget.markerId,
      issue: targetedSnapshot.issue,
      observedAt: 101,
    } as const
    const membershipFacts = {
      repositoryId: targetedSnapshot.repositoryId,
      repositoryDatabaseId: targetedSnapshot.repositoryDatabaseId,
      projectId: targetedSnapshot.projectId,
      issue: targetedSnapshot.issue,
      membership: {
        state: 'present',
        item: {
          id: targetedSnapshot.membership.item.id,
          projectId: targetedSnapshot.membership.item.projectId,
          issueId: targetedSnapshot.membership.item.issueId,
          archived: targetedSnapshot.membership.item.archived,
          apiOrder: targetedSnapshot.membership.item.apiOrder,
          previousItemId: targetedSnapshot.membership.item.previousItemId,
          nextItemId: targetedSnapshot.membership.item.nextItemId,
          totalCount: targetedSnapshot.membership.item.totalCount,
          updatedAt: targetedSnapshot.membership.item.updatedAt,
        },
      },
    } as const
    const membershipObservation = {
      stageMutationId: createRecord.stages[1].mutationId,
      stageKind: 'project-item-add',
      workItemId: WORK_ITEM_ID,
      facts: membershipFacts,
      observedAt: 101,
    } as const
    const statusObservation = {
      ...confirmedObservation,
      stageMutationId: createRecord.stages[2].mutationId,
    } as const
    const observations = [issueObservation, membershipObservation, statusObservation] as const
    const membershipResolvedTarget = {
      kind: 'project-item-add',
      installation,
      repositoryId: createTarget.repositoryId,
      repositoryDatabaseId: createTarget.repositoryDatabaseId,
      projectId: createTarget.projectId,
      issueId: targetedSnapshot.issue.id,
    } as const
    const statusResolvedTarget = {
      kind: 'project-item-status-set',
      installation,
      repositoryId: createTarget.repositoryId,
      repositoryDatabaseId: createTarget.repositoryDatabaseId,
      projectId: createTarget.projectId,
      issueId: targetedSnapshot.issue.id,
      projectItemId: targetedSnapshot.membership.item.id,
      statusFieldId: createTarget.statusFieldId,
      desiredStatusOptionId: createTarget.desiredStatusOptionId,
    } as const
    const issueConfirmed = {
      ...createRecord,
      revision: 1,
      phase: 'prepared',
      stages: [
        {
          ...createRecord.stages[0],
          state: 'confirmed',
          effectPossible: true,
        },
        {
          ...createRecord.stages[1],
          resolvedTarget: membershipResolvedTarget,
        },
        createRecord.stages[2],
      ],
      observedPrefix: [observations[0]],
      updatedAt: 101,
    } as const
    expect(githubWorkItemIntentRecordSchema.parse(issueConfirmed)).toEqual(issueConfirmed)
    expect(githubWorkItemIntentRecordSchema.safeParse({
      ...issueConfirmed,
      stages: [
        issueConfirmed.stages[0],
        issueConfirmed.stages[1],
        {
          ...issueConfirmed.stages[2],
          resolvedTarget: statusResolvedTarget,
        },
      ],
    }).success).toBe(false)
    const membershipFailure = { code: 'transient-transport' } as const
    const failedBeforeEffect = {
      ...issueConfirmed,
      revision: 2,
      phase: 'partial-failure',
      stages: [
        issueConfirmed.stages[0],
        {
          ...issueConfirmed.stages[1],
          state: 'failed',
          effectPossible: false,
          failure: membershipFailure,
        },
        issueConfirmed.stages[2],
      ],
      updatedAt: 102,
    } as const
    expect(githubWorkItemIntentRecordSchema.parse(failedBeforeEffect)).toEqual(failedBeforeEffect)
    expect(githubWorkItemIntentRecordSchema.safeParse({
      ...failedBeforeEffect,
      phase: 'running',
    }).success).toBe(false)
    const idempotentSuccess = {
      ...createRecord,
      phase: 'succeeded',
      stages: [
        {
          ...createRecord.stages[0],
          state: 'confirmed',
          effectPossible: true,
        },
        {
          ...createRecord.stages[1],
          resolvedTarget: membershipResolvedTarget,
          state: 'confirmed',
          effectPossible: true,
        },
        {
          ...createRecord.stages[2],
          resolvedTarget: statusResolvedTarget,
          state: 'confirmed',
          effectPossible: false,
        },
      ],
      observedPrefix: observations,
      terminalEvidence: {
        kind: 'succeeded',
        confirmedObservation: observations[2],
        confirmedAt: 101,
      },
      updatedAt: 101,
    }
    expect(githubWorkItemIntentRecordSchema.parse(idempotentSuccess)).toEqual(idempotentSuccess)
    const forgedFingerprint = { ...observations[2], remoteFingerprint: `remote-fingerprint-${'f'.repeat(64)}` }
    expect(githubWorkItemIntentRecordSchema.safeParse({
      ...idempotentSuccess,
      observedPrefix: [...observations.slice(0, 2), forgedFingerprint],
      terminalEvidence: {
        ...idempotentSuccess.terminalEvidence,
        confirmedObservation: forgedFingerprint,
      },
    }).success).toBe(false)
    const forgedWorkItemId = `work-item-${'f'.repeat(64)}`
    const forgedWorkItemObservations = observations.map(observation => ({
      ...observation,
      workItemId: forgedWorkItemId,
    }))
    expect(githubWorkItemIntentRecordSchema.safeParse({
      ...idempotentSuccess,
      observedPrefix: forgedWorkItemObservations,
      terminalEvidence: {
        ...idempotentSuccess.terminalEvidence,
        confirmedObservation: forgedWorkItemObservations[2],
      },
    }).success).toBe(false)
    expect(githubWorkItemIntentRecordSchema.safeParse({
      ...idempotentSuccess,
      stages: [idempotentSuccess.stages[0]],
      observedPrefix: [observations[0]],
      terminalEvidence: {
        kind: 'succeeded',
        confirmedObservation: observations[0],
        confirmedAt: 101,
      },
    }).success).toBe(false)

    const hostilePayload = {
      ...createRecord,
      payload: {
        ...createRecord.payload,
        intent: { ...createRecord.payload.intent, repositoryId: 'R_browser-controlled' },
      },
    }
    expect(githubWorkItemIntentRecordSchema.safeParse(hostilePayload).success).toBe(false)
    expect(githubWorkItemIntentRecordSchema.safeParse({
      ...createRecord,
      target: { ...createRecord.target, markerId: `work-item-marker-${'z'.repeat(64)}` },
    }).success).toBe(false)
    expect(githubWorkItemIntentRecordSchema.safeParse({
      ...createRecord,
      target: {
        ...createRecord.target,
        installation: { ...createRecord.target.installation, privateKey: 'raw-secret' },
      },
    }).success).toBe(false)
    expect(githubWorkItemIntentRecordSchema.safeParse({
      ...createRecord,
      stages: [createRecord.stages[0], createRecord.stages[0]],
    }).success).toBe(false)
    expect(githubWorkItemIntentRecordSchema.safeParse({
      ...createRecord,
      phase: 'running',
      stages: createRecord.stages.map(stage => ({
        ...stage,
        state: 'dispatching',
        effectPossible: true,
      })),
    }).success).toBe(false)
  })

  it('retains only authoritative targeted recovery evidence', () => {
    const recovery = {
      id: RECOVERY_ID,
      workItemId: WORK_ITEM_ID,
      schemaVersion: 1,
      revision: 3,
      projectId: PROJECT_ID,
      latestNonTerminalStatus: 'in-review',
      confirmed: { sourceIntentId: INTENT_ID, observation: confirmedObservation, confirmedAt: 101 },
      updatedAt: 102,
    } as const

    expect(githubWorkItemRecoveryRecordSchema.parse(recovery)).toEqual(recovery)
    expect(githubWorkItemRecoveryRecordSchema.safeParse({
      ...recovery,
      repair: { kind: 'external-reopen' },
    }).success).toBe(false)
    expect(githubWorkItemRecoveryRecordSchema.safeParse({
      ...recovery,
      confirmed: { ...recovery.confirmed, confirmedAt: 99 },
    }).success).toBe(false)
    expect(githubWorkItemRecoveryRecordSchema.safeParse({
      ...recovery,
      confirmed: {
        ...recovery.confirmed,
        observation: {
          ...recovery.confirmed.observation,
          remoteFingerprint: `remote-fingerprint-${'5'.repeat(64)}`,
        },
      },
    }).success).toBe(false)
    expect(githubWorkItemRecoveryRecordSchema.safeParse({
      ...recovery,
      confirmed: {
        ...recovery.confirmed,
        observation: {
          ...recovery.confirmed.observation,
          semanticFence: { version: 1 },
        },
      },
    }).success).toBe(false)
    expect(githubWorkItemRecoveryRecordSchema.safeParse({
      ...recovery,
      confirmed: {
        ...recovery.confirmed,
        observation: {
          ...recovery.confirmed.observation,
          workItemId: `work-item-${'6'.repeat(64)}`,
        },
      },
    }).success).toBe(false)
  })
})
