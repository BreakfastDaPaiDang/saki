import { describe, expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { canonicalDigest } from '@breakfastdapaidang/saki-execution'
import {
  githubAccountId,
  githubAppId,
  githubExternalOperationId,
  githubInstallationId,
  githubIssueId,
  githubProjectFieldId,
  githubProjectId,
  githubProjectItemId,
  githubProjectOptionId,
  githubRepositoryDatabaseId,
  githubRepositoryId,
  type GitHubTargetedWorkItemSnapshot,
} from '@breakfastdapaidang/saki-github'
import {
  createWorkItemIntentSchema,
  type GitHubWorkItemIntentRecord,
  githubWorkItemIntentRecordSchema,
  githubWorkItemRecoveryRecordSchema,
  moveWorkItemIntentSchema,
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

const issueObservation = {
  stageMutationId: githubExternalOperationId(createRecord.stages[0].mutationId),
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
    },
  },
} as const

const membershipObservation = {
  stageMutationId: githubExternalOperationId(createRecord.stages[1].mutationId),
  stageKind: 'project-item-add',
  workItemId: WORK_ITEM_ID,
  facts: membershipFacts,
  observedAt: 101,
} as const

const statusObservation = {
  ...confirmedObservation,
  stageMutationId: githubExternalOperationId(createRecord.stages[2].mutationId),
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
} as const

const OTHER_ITEM_ID = githubProjectItemId('PVTI_other')
const OTHER_ISSUE_ID = githubIssueId('I_other')
const OTHER_WORK_ITEM_ID = sakiBoardWorkItemIdSchema.parse(`work-item-${canonicalDigest('saki/board-work-item/v1', {
  repositoryId: targetedSnapshot.repositoryId,
  issueId: OTHER_ISSUE_ID,
})}`)
const OTHER_RECOVERY_ID = sakiWorkItemRecoveryIdSchema.parse(`work-item-recovery-${'f'.repeat(64)}`)

const movePayload = {
  intent: {
    type: 'move-work-item',
    intentId: INTENT_ID,
    projectId: PROJECT_ID,
    workItemId: WORK_ITEM_ID,
    expectedRemoteFingerprint: REMOTE_FINGERPRINT,
    targetStatus: 'inbox',
  },
  actor,
} as const

const moveTarget = {
  kind: 'move-work-item',
  installation,
  repositoryId: targetedSnapshot.repositoryId,
  repositoryDatabaseId: targetedSnapshot.repositoryDatabaseId,
  projectId: targetedSnapshot.projectId,
  issueId: targetedSnapshot.issue.id,
  projectItemId: targetedSnapshot.membership.item.id,
  source: {
    membership: 'present',
    issueState: 'open',
    status: 'inbox',
    projectItemId: targetedSnapshot.membership.item.id,
    archived: false,
  },
  statusFieldId: targetedSnapshot.statusFieldId,
  desiredStatusOptionId: targetedSnapshot.membership.item.statusOptionId,
} as const

const moveRecord = {
  ...createRecord,
  payload: movePayload,
  payloadDigest: canonicalDigest('saki/github-work-item-intent/v1', movePayload),
  target: moveTarget,
  stages: [{
    mutationId: githubExternalOperationId(`work-item:${INTENT_ID}:status`),
    kind: 'project-item-status-set',
    state: 'prepared',
    effectPossible: false,
  }],
} as const

const moveStatusResolvedTarget = {
  kind: 'project-item-status-set',
  installation,
  repositoryId: moveTarget.repositoryId,
  repositoryDatabaseId: moveTarget.repositoryDatabaseId,
  projectId: moveTarget.projectId,
  issueId: moveTarget.issueId,
  projectItemId: moveTarget.projectItemId,
  statusFieldId: moveTarget.statusFieldId,
  desiredStatusOptionId: moveTarget.desiredStatusOptionId,
} as const

const moveStatusObservation = {
  ...confirmedObservation,
  stageMutationId: moveRecord.stages[0].mutationId,
} as const

const succeededMoveRecord = {
  ...moveRecord,
  phase: 'succeeded',
  stages: [{
    ...moveRecord.stages[0],
    resolvedTarget: moveStatusResolvedTarget,
    state: 'confirmed',
    effectPossible: true,
  }],
  observedPrefix: [moveStatusObservation],
  terminalEvidence: {
    kind: 'succeeded',
    confirmedObservation: moveStatusObservation,
    confirmedAt: 101,
  },
  updatedAt: 101,
} as const

const validatedMoveRecord = githubWorkItemIntentRecordSchema.parse(moveRecord)
const validatedIssueObservation = githubWorkItemIntentRecordSchema.parse(issueConfirmed).observedPrefix[0]
if (validatedIssueObservation?.stageKind !== 'issue-create') {
  throw new Error('Issue-create observation fixture is missing')
}

const absentStatusFacts = {
  ...targetedSnapshot,
  membership: { state: 'absent' },
} as const

const absentStatusObservation = {
  ...statusObservation,
  facts: absentStatusFacts,
  remoteFingerprint: targetedBoardRemoteFingerprint(absentStatusFacts),
} as const

const absentMembershipObservation = {
  ...membershipObservation,
  facts: { ...membershipFacts, membership: { state: 'absent' } },
} as const

type WorkItemRecordMutation = (record: GitHubWorkItemIntentRecord) => void
type InvalidWorkItemRecordCase = readonly [message: string, record: unknown]
type InvalidWorkItemMutationCase = readonly [message: string, mutation: WorkItemRecordMutation]
type WorkItemStage = GitHubWorkItemIntentRecord['stages'][number]
type TargetedProjectItemFact = Extract<
  GitHubTargetedWorkItemSnapshot['membership'],
  { state: 'present' }
>['item']

function requiredStage(record: GitHubWorkItemIntentRecord, index: number): WorkItemStage {
  const stage = record.stages[index]
  if (stage === undefined) throw new Error(`Work Item stage fixture ${index} is missing`)
  return stage
}

function patchStage(
  record: GitHubWorkItemIntentRecord,
  index: number,
  patch: Partial<WorkItemStage>,
): void {
  Object.assign(requiredStage(record, index), patch)
}

function mutatedWorkItemRecord(base: unknown, mutation: WorkItemRecordMutation): GitHubWorkItemIntentRecord {
  const record = githubWorkItemIntentRecordSchema.parse(base)
  mutation(record)
  return record
}

function expectInvalidWorkItemRecords(cases: readonly InvalidWorkItemRecordCase[]): void {
  for (const [message, record] of cases) {
    const result = githubWorkItemIntentRecordSchema.safeParse(record)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map(issue => issue.message)).toContain(message)
    }
  }
}

function expectInvalidWorkItemMutations(base: unknown, cases: readonly InvalidWorkItemMutationCase[]): void {
  expectInvalidWorkItemRecords(cases.map(([message, mutation]) => [
    message,
    mutatedWorkItemRecord(base, mutation),
  ]))
}

function targetedFactsWithItem(patch: Partial<TargetedProjectItemFact>): GitHubTargetedWorkItemSnapshot {
  return {
    ...targetedSnapshot,
    membership: {
      state: 'present',
      item: { ...targetedSnapshot.membership.item, ...patch },
    },
  }
}

function succeededCreateWithStatusFacts(facts: GitHubTargetedWorkItemSnapshot): unknown {
  const observation = {
    ...statusObservation,
    facts,
    remoteFingerprint: targetedBoardRemoteFingerprint(facts),
  } as const
  return {
    ...idempotentSuccess,
    observedPrefix: [issueObservation, membershipObservation, observation],
    terminalEvidence: {
      ...idempotentSuccess.terminalEvidence,
      confirmedObservation: observation,
    },
  }
}

const positionEvidenceRecord = githubWorkItemIntentRecordSchema.parse(mutatedWorkItemRecord(
  succeededMoveRecord,
  (record) => {
    if (record.payload.intent.type !== 'move-work-item' || record.target.kind !== 'move-work-item'
      || record.target.projectItemId === undefined) {
      throw new Error('position move fixture changed kind')
    }
    record.payload.intent.position = { afterWorkItemId: null }
    record.payloadDigest = canonicalDigest('saki/github-work-item-intent/v1', record.payload)
    record.target.position = { kind: 'top' }
    const stageMutationId = githubExternalOperationId(`work-item:${INTENT_ID}:position`)
    const observation = {
      stageMutationId,
      stageKind: 'project-item-position-set' as const,
      workItemId: WORK_ITEM_ID,
      facts: { ...targetedSnapshot, after: { state: 'top' as const } },
      observedAt: 101,
    }
    record.stages.push({
      mutationId: stageMutationId,
      kind: 'project-item-position-set',
      resolvedTarget: {
        kind: 'project-item-position-set',
        installation: record.target.installation,
        repositoryId: record.target.repositoryId,
        repositoryDatabaseId: record.target.repositoryDatabaseId,
        projectId: record.target.projectId,
        issueId: record.target.issueId,
        projectItemId: record.target.projectItemId,
        statusFieldId: record.target.statusFieldId,
        afterItemId: null,
      },
      state: 'confirmed',
      effectPossible: true,
    })
    record.observedPrefix.push(observation)
    record.phase = 'canceled'
    record.terminalEvidence = { kind: 'canceled', reason: 'authority-revoked' }
  },
))

const issueStateEvidenceRecord = githubWorkItemIntentRecordSchema.parse(mutatedWorkItemRecord(
  succeededMoveRecord,
  (record) => {
    if (record.payload.intent.type !== 'move-work-item' || record.target.kind !== 'move-work-item') {
      throw new Error('Issue-state move fixture changed kind')
    }
    const doneOptionId = githubProjectOptionId('O_done')
    record.payload.intent.targetStatus = 'done'
    record.payloadDigest = canonicalDigest('saki/github-work-item-intent/v1', record.payload)
    record.target.desiredStatusOptionId = doneOptionId
    const statusTarget = requiredStage(record, 0).resolvedTarget
    const statusObservation = record.observedPrefix[0]
    if (statusTarget?.kind !== 'project-item-status-set'
      || statusObservation?.stageKind !== 'project-item-status-set'
      || statusObservation.facts.membership.state !== 'present') {
      throw new Error('Status fixture evidence is missing')
    }
    statusTarget.desiredStatusOptionId = doneOptionId
    statusObservation.facts.membership.item.statusOptionId = doneOptionId
    statusObservation.remoteFingerprint = targetedBoardRemoteFingerprint(statusObservation.facts)
    const stageMutationId = githubExternalOperationId(`work-item:${INTENT_ID}:issue-state`)
    const observation = {
      stageMutationId,
      stageKind: 'issue-state-set' as const,
      workItemId: WORK_ITEM_ID,
      facts: { issue: { ...targetedSnapshot.issue, state: 'closed' as const } },
      observedAt: 101,
    }
    record.stages.push({
      mutationId: stageMutationId,
      kind: 'issue-state-set',
      resolvedTarget: {
        kind: 'issue-state-set',
        installation: record.target.installation,
        repositoryId: record.target.repositoryId,
        repositoryDatabaseId: record.target.repositoryDatabaseId,
        issueId: record.target.issueId,
        desiredState: 'closed',
      },
      state: 'confirmed',
      effectPossible: true,
    })
    record.observedPrefix.push(observation)
    record.phase = 'canceled'
    record.terminalEvidence = { kind: 'canceled', reason: 'authority-revoked' }
  },
))

describe('durable GitHub Work Item state', () => {
  it('freezes browser-safe create input separately from server-derived targets and stable stages', () => {
    const oversizedCreate = createWorkItemIntentSchema.safeParse({
      ...createPayload.intent,
      acceptanceCriteria: Array.from({ length: 50 }, () => 'x'.repeat(4_096)),
    })
    expect(oversizedCreate.success).toBe(false)
    if (!oversizedCreate.success) {
      expect(oversizedCreate.error.issues.map(issue => issue.message)).toContain(
        'generated GitHub Issue body exceeds the UTF-8 byte limit',
      )
    }
    const selfPosition = moveWorkItemIntentSchema.safeParse({
      ...movePayload.intent,
      position: { afterWorkItemId: WORK_ITEM_ID, expectedAfterRemoteFingerprint: REMOTE_FINGERPRINT },
    })
    expect(selfPosition.success).toBe(false)
    if (!selfPosition.success) {
      expect(selfPosition.error.issues.map(issue => issue.message)).toContain(
        'Work Item cannot be positioned after itself',
      )
    }
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

  it('rejects invalid atomic stage and targeted observation evidence', () => {
    const inconsistentItemFacts: readonly (readonly [string, GitHubTargetedWorkItemSnapshot])[] = [
      ['Project item order exceeds the complete connection', targetedFactsWithItem({ apiOrder: 1 })],
      ['Project item previous neighbor disagrees with its complete position',
        targetedFactsWithItem({ previousItemId: OTHER_ITEM_ID })],
      ['Project item next neighbor disagrees with its complete position',
        targetedFactsWithItem({ totalCount: 2, nextItemId: null })],
      ['Project item neighbors must be distinct', targetedFactsWithItem({
        apiOrder: 1,
        totalCount: 3,
        previousItemId: OTHER_ITEM_ID,
        nextItemId: OTHER_ITEM_ID,
      })],
      ['targeted Issue ownership disagrees with Repository facts', {
        ...targetedSnapshot,
        issue: { ...targetedSnapshot.issue, repositoryId: githubRepositoryId('R_other') },
      }],
      ['targeted membership ownership disagrees with Work Item facts',
        targetedFactsWithItem({ projectId: githubProjectId('P_other') })],
    ]
    expectInvalidWorkItemMutations(createRecord, [
      ['mutation target kind disagrees with its stage',
        (record) => { patchStage(record, 0, { resolvedTarget: membershipResolvedTarget }) }],
      ['prepared mutation stage contains effect evidence',
        (record) => { patchStage(record, 0, { effectPossible: true }) }],
      ['started mutation stage lacks a concrete target', (record) => {
        record.phase = 'running'
        patchStage(record, 0, { state: 'dispatching', effectPossible: true, resolvedTarget: undefined })
      }],
      ['started mutation stage must admit a possible effect', (record) => {
        record.phase = 'running'
        patchStage(record, 0, { state: 'dispatching', effectPossible: false })
      }],
      ['failed mutation stage lacks failure evidence', (record) => {
        record.phase = 'partial-failure'
        patchStage(record, 0, { state: 'failed', effectPossible: true })
      }],
      ['non-failed mutation stage contains failure evidence', (record) => { patchStage(record, 0, {
        state: 'confirmed',
        effectPossible: true,
        failure: { code: 'transient-transport' },
      }) }],
    ])
    expectInvalidWorkItemRecords(inconsistentItemFacts.map(([message, facts]) => [
      message,
      succeededCreateWithStatusFacts(facts),
    ]))
  })

  it('rejects targets that disagree with the frozen Work Item topology', () => {
    expect(githubWorkItemIntentRecordSchema.parse(moveRecord)).toEqual(moveRecord)
    expectInvalidWorkItemMutations(createRecord, [
      ['Work Item Intent payload digest is stale', (record) => { record.payloadDigest = 'f'.repeat(64) }],
      ['Work Item Intent time evidence is inconsistent', (record) => { record.updatedAt = record.createdAt - 1 }],
      ['server-derived Work Item target disagrees with Intent kind',
        (record) => { record.target = structuredClone(validatedMoveRecord.target) }],
      ['Work Item stage mutation id is not stable', (record) => { patchStage(record, 0, {
        mutationId: githubExternalOperationId(`work-item:${INTENT_ID}:wrong`),
      }) }],
      ['resolved mutation target disagrees with the frozen provider target', (record) => {
        const resolved = requiredStage(record, 0).resolvedTarget
        if (resolved?.kind !== 'issue-create') throw new Error('Issue-create fixture target is missing')
        resolved.repositoryId = githubRepositoryId('R_other')
      }],
      ['resolved membership target lacks its confirmed Issue input',
        (record) => { patchStage(record, 1, { resolvedTarget: membershipResolvedTarget }) }],
      ['resolved Status target lacks its confirmed stage inputs',
        (record) => { patchStage(record, 2, { resolvedTarget: statusResolvedTarget }) }],
    ])
    expectInvalidWorkItemMutations(moveRecord, [
      ['server-derived position disagrees with Saki Intent', (record) => {
        if (record.payload.intent.type !== 'move-work-item') throw new Error('move fixture changed kind')
        record.payload.intent.position = { afterWorkItemId: null }
        record.payloadDigest = canonicalDigest('saki/github-work-item-intent/v1', record.payload)
      }],
      ['joined move target disagrees with its source Project item', (record) => {
        if (record.target.kind === 'move-work-item') record.target.projectItemId = OTHER_ITEM_ID
      }],
      ['unjoined move target materializes without membership evidence', (record) => {
        record.target = {
          ...moveTarget,
          projectItemId: OTHER_ITEM_ID,
          source: { membership: 'absent', issueState: 'open', status: 'inbox' },
        }
        record.stages = [{
          ...moveRecord.stages[0],
          mutationId: githubExternalOperationId(`work-item:${INTENT_ID}:membership`),
          kind: 'project-item-add',
        }, { ...moveRecord.stages[0] }]
      }],
    ])
    expectInvalidWorkItemMutations(positionEvidenceRecord, [[
      'resolved position target disagrees with move material', (record) => {
        const stage = requiredStage(record, 1).resolvedTarget
        const observation = record.observedPrefix[1]
        if (stage?.kind !== 'project-item-position-set'
          || observation?.stageKind !== 'project-item-position-set'
          || observation.facts.membership.state !== 'present') throw new Error('position evidence is missing')
        stage.projectItemId = OTHER_ITEM_ID
        observation.facts.membership.item.id = OTHER_ITEM_ID
      }]])
    expectInvalidWorkItemMutations(issueStateEvidenceRecord, [[
      'resolved Issue-state target disagrees with move material', (record) => {
        const stage = requiredStage(record, 1).resolvedTarget
        const observation = record.observedPrefix[1]
        if (stage?.kind !== 'issue-state-set' || observation?.stageKind !== 'issue-state-set') {
          throw new Error('Issue-state evidence is missing')
        }
        stage.issueId = OTHER_ISSUE_ID
        observation.facts.issue.id = OTHER_ISSUE_ID
        observation.workItemId = OTHER_WORK_ITEM_ID
      }]])
  })

  it('rejects observations that cannot form one confirmed mutation prefix', () => {
    expectInvalidWorkItemMutations(createRecord, [
      ['observed prefix does not match confirmed mutation stages',
        (record) => { record.observedPrefix = [structuredClone(validatedIssueObservation)] }],
      ['started mutation stage lacks a concrete target', (record) => {
        patchStage(record, 0, { state: 'confirmed', effectPossible: true, resolvedTarget: undefined })
        record.observedPrefix = [structuredClone(validatedIssueObservation)]
      }],
      ['confirmed mutation stages must form the observed prefix',
        (record) => { patchStage(record, 0, { state: 'confirmed', effectPossible: true }) }],
      ['Issue creation cannot be confirmed before its effect became possible', (record) => {
        patchStage(record, 0, { state: 'confirmed', effectPossible: false })
        record.observedPrefix = [structuredClone(validatedIssueObservation)]
      }],
    ])
    expectInvalidWorkItemMutations(idempotentSuccess, [
      ['Issue-create observation disagrees with its target', (record) => {
        const observation = record.observedPrefix[0]
        if (observation?.stageKind !== 'issue-create') throw new Error('Issue-create observation fixture is missing')
        observation.repositoryId = githubRepositoryId('R_other')
      }],
      ['membership observation does not confirm one exact Project item',
        (record) => { record.observedPrefix[1] = absentMembershipObservation }],
      ['Status observation does not confirm the desired Work Item state', (record) => {
        record.observedPrefix[2] = absentStatusObservation
        record.terminalEvidence = {
          ...idempotentSuccess.terminalEvidence,
          confirmedObservation: absentStatusObservation,
        }
      }],
    ])
    expectInvalidWorkItemMutations(positionEvidenceRecord, [
      ['position Work Item id disagrees with observed Issue identity', (record) => {
        const observation = record.observedPrefix[1]
        if (observation?.stageKind !== 'project-item-position-set') throw new Error('position evidence is missing')
        observation.workItemId = OTHER_WORK_ITEM_ID
      }],
      ['position observation does not confirm the requested API position', (record) => {
        const observation = record.observedPrefix[1]
        if (observation?.stageKind !== 'project-item-position-set') throw new Error('position evidence is missing')
        observation.facts.membership = { state: 'absent' }
      }],
    ])
    expectInvalidWorkItemMutations(issueStateEvidenceRecord, [
      ['Issue-state Work Item id disagrees with observed Issue identity', (record) => {
        const observation = record.observedPrefix[1]
        if (observation?.stageKind !== 'issue-state-set') throw new Error('Issue-state evidence is missing')
        observation.workItemId = OTHER_WORK_ITEM_ID
      }],
      ['Issue-state observation does not confirm the requested state', (record) => {
        const observation = record.observedPrefix[1]
        if (observation?.stageKind !== 'issue-state-set') throw new Error('Issue-state evidence is missing')
        observation.facts.issue.state = 'open'
      }],
    ])
  })

  it('rejects terminal evidence that cannot safely close or recover the Work Item', () => {
    const staleConflictWithoutTimestamp = {
      kind: 'conflict',
      reason: 'stale-remote',
      confirmedObservation: statusObservation,
    } as const
    expectInvalidWorkItemMutations(createRecord, [
      ['Work Item conflict evidence disagrees with reason', (record) => {
        record.phase = 'conflict'
        record.terminalEvidence = { kind: 'conflict', reason: 'stale-remote' }
      }],
      ['Work Item conflict evidence disagrees with reason', (record) => {
        record.phase = 'conflict'
        record.terminalEvidence = staleConflictWithoutTimestamp
      }],
      ['prepared Work Item Intent lacks one safe stage frontier',
        (record) => { record.terminalEvidence = { kind: 'canceled', reason: 'authority-revoked' } }],
      ['partial Work Item failure disagrees with failed stage', (record) => { record.phase = 'partial-failure' }],
      ['terminal Work Item evidence disagrees with phase', (record) => { record.phase = 'canceled' }],
      ['reconciliation does not identify an effect-possible stage', (record) => {
        record.phase = 'reconciliation-required'
        record.terminalEvidence = {
          kind: 'reconciliation-required',
          reason: 'effect-unknown',
          stageMutationId: githubExternalOperationId(`work-item:${INTENT_ID}:missing`),
        }
      }],
      ['reconciliation does not identify an effect-possible stage', (record) => {
        record.phase = 'reconciliation-required'
        record.terminalEvidence = {
          kind: 'reconciliation-required',
          reason: 'effect-unknown',
          stageMutationId: githubExternalOperationId(createRecord.stages[0].mutationId),
        }
      }],
    ])
    expectInvalidWorkItemMutations(moveRecord, [
      ['succeeded Work Item Intent lacks final confirmed evidence', (record) => { record.phase = 'succeeded' }],
    ])
    expectInvalidWorkItemMutations(succeededMoveRecord, [
      ['succeeded Work Item Intent lacks final confirmed evidence', (record) => {
        if (record.terminalEvidence?.kind !== 'succeeded') throw new Error('succeeded terminal evidence is missing')
        record.terminalEvidence.confirmedObservation = absentStatusObservation
      }],
    ])
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
    const wrongRecoveryId = githubWorkItemRecoveryRecordSchema.safeParse({
      ...recovery,
      id: OTHER_RECOVERY_ID,
    })
    expect(wrongRecoveryId.success).toBe(false)
    if (!wrongRecoveryId.success) {
      expect(wrongRecoveryId.error.issues).toContainEqual(expect.objectContaining({
        message: 'Work Item recovery id disagrees with its Development Project scope',
        path: ['id'],
      }))
    }
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
