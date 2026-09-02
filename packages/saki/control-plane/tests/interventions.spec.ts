import { describe, expect, it } from 'vitest'
import { canonicalDigest } from '@breakfastdapaidang/saki-execution'
import { sakiInterventionRequestIdSchema } from '../src/ids.ts'
import {
  agentRunRecordSchema,
  agentRunV1RecordSchema,
  answerInterventionIntentSchema,
  interventionRequestRecordSchema,
  workAssignmentRecordSchema,
  workAssignmentV1RecordSchema,
} from '../src/spec.ts'

const INTERVENTION_ID = 'intervention-11111111-1111-4111-8111-111111111111'
const INTENT_ID = 'intent-22222222-2222-4222-8222-222222222222'
const RECEIPT_ID = 'receipt-22222222-2222-4222-8222-222222222222'
const PROJECT_ID = 'project-44444444-4444-4444-8444-444444444444'
const WORK_ITEM_ID = `work-item-${'5'.repeat(64)}`
const WORK_SESSION_ID = 'work-session-66666666-6666-4666-8666-666666666666'
const AGENT_RUN_ID = 'agent-run-77777777-7777-4777-8777-777777777777'
const DISPATCH_ID = 'dispatch-88888888-8888-4888-8888-888888888888'
const INITIAL_DISPATCH_ID = 'dispatch-89898989-8989-4989-8989-898989898989'
const SESSION_ID = 'session-99999999-9999-4999-8999-999999999999'
const PRINCIPAL_ID = 'principal-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ASSIGNMENT_ID = 'assignment-abababab-abab-4bab-8bab-abababababab'
const BINDING_ID = 'binding-acacacac-acac-4cac-8cac-acacacacacac'
const OTHER_PROJECT_ID = 'project-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const OTHER_WORK_SESSION_ID = 'work-session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const OTHER_AGENT_RUN_ID = 'agent-run-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const OTHER_SESSION_ID = 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function expectSchemaIssue(
  result: { success: boolean; error?: { issues: readonly { message: string }[] } },
  message: string,
): void {
  expect(result.success).toBe(false)
  expect(result.error?.issues.map(issue => issue.message)).toContain(message)
}

const common = {
  id: INTERVENTION_ID,
  schemaVersion: 1,
  revision: 2,
  kind: 'text-input',
  projectId: PROJECT_ID,
  owner: { kind: 'agent-run', agentRunId: AGENT_RUN_ID, workSessionId: WORK_SESSION_ID },
  subject: { kind: 'agent-run', agentRunId: AGENT_RUN_ID },
  targetPrincipalId: PRINCIPAL_ID,
  requiredAnswer: { kind: 'text', prompt: 'Which migration should the Agent use?', maxLength: 1_000 },
  blockingScope: { kind: 'agent-run', agentRunId: AGENT_RUN_ID },
  cause: {
    kind: 'agent-request',
    agentRunId: AGENT_RUN_ID,
    workSessionId: WORK_SESSION_ID,
    sessionId: SESSION_ID,
    toolCallId: 'call_durable_question',
  },
  returnAddress: {
    kind: 'agent-run',
    projectId: PROJECT_ID,
    workItemId: WORK_ITEM_ID,
    workSessionId: WORK_SESSION_ID,
    agentRunId: AGENT_RUN_ID,
  },
  createdAt: 10,
  updatedAt: 11,
} as const

const answerIntent = {
  type: 'answer-intervention',
  intentId: INTENT_ID,
  interventionId: INTERVENTION_ID,
  expectedInterventionRevision: 1,
  answer: { kind: 'text', text: 'Use the adjacent v7 to v8 migration.' },
} as const

const actor = {
  installationId: 'installation-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  storageGenerationId: 'storage-generation-cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  hostId: 'host-dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  principalId: PRINCIPAL_ID,
  principalRevision: 4,
  grantId: 'grant-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  grantRevision: 5,
} as const

const answer = {
  receiptId: RECEIPT_ID,
  payloadDigest: canonicalDigest('saki/answer-intervention/v1', { intent: answerIntent, actor }),
  payload: { intent: answerIntent, actor },
  acceptedAt: 11,
  dispatchId: DISPATCH_ID,
  inputPlan: {
    messageId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    payloadDigest: '1'.repeat(64),
  },
} as const

describe('durable Intervention Request schemas', () => {
  it('brands only canonical Intervention Request identities', () => {
    expect(sakiInterventionRequestIdSchema.parse(INTERVENTION_ID)).toBe(INTERVENTION_ID)
    expect(sakiInterventionRequestIdSchema.safeParse(`intervention-request-${INTERVENTION_ID}`).success).toBe(false)
  })

  it('accepts only open requests without an answer winner', () => {
    expect(interventionRequestRecordSchema.parse({ ...common, state: 'open', openedAt: 11 }))
      .toMatchObject({ state: 'open' })
    expect(interventionRequestRecordSchema.safeParse({ ...common, state: 'open', openedAt: 11, answer }).success)
      .toBe(false)
  })

  it('accepts only the Agent-requested Agent Run relation shipped by v8', () => {
    expect(interventionRequestRecordSchema.safeParse({
      ...common,
      state: 'opening',
      owner: {
        kind: 'execution-dispatch',
        dispatchId: DISPATCH_ID,
        agentRunId: AGENT_RUN_ID,
        workSessionId: WORK_SESSION_ID,
      },
      cause: { kind: 'dispatch-recovery', dispatchId: DISPATCH_ID },
    }).success).toBe(false)
    expect(interventionRequestRecordSchema.safeParse({
      ...common,
      state: 'opening',
      subject: { kind: 'work-item', workItemId: WORK_ITEM_ID },
    }).success).toBe(false)
    expect(interventionRequestRecordSchema.safeParse({
      ...common,
      state: 'opening',
      blockingScope: { kind: 'execution-dispatch', dispatchId: DISPATCH_ID },
    }).success).toBe(false)
    expect(interventionRequestRecordSchema.safeParse({
      ...common,
      state: 'opening',
      returnAddress: { kind: 'work-item', projectId: PROJECT_ID, workItemId: WORK_ITEM_ID },
    }).success).toBe(false)
    expect(interventionRequestRecordSchema.safeParse({
      ...common,
      state: 'opening',
      deadlineAt: 20,
    }).success).toBe(false)
  })

  it('retains one attributed answer winner and its next Run input plan', () => {
    const record = interventionRequestRecordSchema.parse({ ...common, state: 'answered', openedAt: 11, answer })
    if (record.state !== 'answered') throw new Error('test Intervention did not retain its answer')
    expect(record.answer.payload.intent).toEqual(answerIntent)
    expect(record.answer.inputPlan.messageId).toBe('ffffffff-ffff-4fff-8fff-ffffffffffff')
  })

  it('binds the answer winner to the exact aggregate revision it changed', () => {
    const staleIntent = { ...answerIntent, expectedInterventionRevision: 0 }
    const staleAnswer = {
      ...answer,
      payload: { intent: staleIntent, actor },
      payloadDigest: canonicalDigest('saki/answer-intervention/v1', { intent: staleIntent, actor }),
    }
    expect(interventionRequestRecordSchema.safeParse({
      ...common,
      state: 'answered',
      openedAt: 11,
      answer: staleAnswer,
    }).success).toBe(false)
    expect(interventionRequestRecordSchema.parse({
      ...common,
      revision: 3,
      state: 'resolved',
      openedAt: 11,
      answer,
      resolvedAt: 12,
      updatedAt: 12,
    })).toMatchObject({ state: 'resolved', revision: 3 })
  })

  it('rejects lifecycle timestamps outside their aggregate revision', () => {
    expect(interventionRequestRecordSchema.safeParse({
      ...common,
      state: 'open',
      openedAt: common.updatedAt + 1,
    }).success).toBe(false)
    expect(interventionRequestRecordSchema.safeParse({
      ...common,
      state: 'answered',
      openedAt: 11,
      answer: { ...answer, acceptedAt: 10 },
    }).success).toBe(false)
    expect(interventionRequestRecordSchema.safeParse({
      ...common,
      state: 'reconciliation-required',
      openedAt: 11,
      reason: 'protocol',
      reconciliationRequiredAt: common.updatedAt + 1,
    }).success).toBe(false)
  })

  it('rejects an answer that exceeds the request-owned text bound', () => {
    const tooLong = {
      ...answer,
      payload: {
        intent: { ...answerIntent, answer: { kind: 'text', text: 'x'.repeat(1_001) } },
        actor,
      },
    }
    const candidate = {
      ...common,
      state: 'answered',
      openedAt: 11,
      answer: {
        ...tooLong,
        payloadDigest: canonicalDigest('saki/answer-intervention/v1', tooLong.payload),
      },
    }
    expect(interventionRequestRecordSchema.safeParse(candidate).success).toBe(false)
  })

  it('keeps every Agent-owned return relationship within its aggregate', () => {
    const inconsistentRecords = [
      {
        record: { ...common, state: 'opening', returnAddress: { ...common.returnAddress, projectId: OTHER_PROJECT_ID } },
        message: 'Intervention return address belongs to another Project',
      },
      {
        record: { ...common, state: 'opening', cause: { ...common.cause, agentRunId: OTHER_AGENT_RUN_ID } },
        message: 'Agent-owned Intervention cause is inconsistent',
      },
      {
        record: { ...common, state: 'opening', cause: { ...common.cause, workSessionId: OTHER_WORK_SESSION_ID } },
        message: 'Agent-owned Intervention cause is inconsistent',
      },
      {
        record: {
          ...common,
          state: 'opening',
          returnAddress: { ...common.returnAddress, workSessionId: OTHER_WORK_SESSION_ID },
        },
        message: 'Intervention Work Session return address is inconsistent',
      },
      {
        record: {
          ...common,
          state: 'opening',
          returnAddress: { ...common.returnAddress, agentRunId: OTHER_AGENT_RUN_ID },
        },
        message: 'Intervention Agent Run return address is inconsistent',
      },
    ] as const

    for (const { record, message } of inconsistentRecords) {
      expectSchemaIssue(interventionRequestRecordSchema.safeParse(record), message)
    }
  })

  it('rejects inconsistent answer receipts, digests, and terminal timestamps', () => {
    expectSchemaIssue(interventionRequestRecordSchema.safeParse({
      ...common,
      state: 'answered',
      openedAt: 11,
      answer: { ...answer, receiptId: 'receipt-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    }), 'Intervention answer receipt disagrees with its Intent')
    expectSchemaIssue(interventionRequestRecordSchema.safeParse({
      ...common,
      state: 'answered',
      openedAt: 11,
      answer: { ...answer, payloadDigest: '0'.repeat(64) },
    }), 'Intervention answer payload digest is stale')
    expectSchemaIssue(interventionRequestRecordSchema.safeParse({
      ...common,
      revision: 3,
      state: 'reconciliation-required',
      openedAt: 11,
      answer,
      reason: 'protocol',
      reconciliationRequiredAt: 10,
      updatedAt: 12,
    }), 'Intervention reconciliation timestamp is not monotonic')
    expectSchemaIssue(interventionRequestRecordSchema.safeParse({
      ...common,
      revision: 3,
      state: 'resolved',
      openedAt: 11,
      answer,
      resolvedAt: 10,
      updatedAt: 12,
    }), 'Intervention resolution timestamp is not monotonic')
  })

  it('exposes one strict expected-revision text-answer Intent', () => {
    expect(answerInterventionIntentSchema.parse(answerIntent)).toEqual(answerIntent)
    expect(answerInterventionIntentSchema.safeParse({ ...answerIntent, actor }).success).toBe(false)
  })
})

describe('Intervention-compatible Agent ownership schemas', () => {
  const assignmentV1 = {
    id: ASSIGNMENT_ID,
    schemaVersion: 1,
    revision: 0,
    intentId: INTENT_ID,
    projectId: PROJECT_ID,
    workItemId: WORK_ITEM_ID,
    primaryWorkSessionId: WORK_SESSION_ID,
    agentRunId: AGENT_RUN_ID,
    state: 'active',
    createdAt: 10,
    updatedAt: 11,
  } as const

  const runV1 = {
    id: AGENT_RUN_ID,
    schemaVersion: 1,
    revision: 3,
    intentId: INTENT_ID,
    assignmentId: ASSIGNMENT_ID,
    workSessionId: WORK_SESSION_ID,
    projectId: PROJECT_ID,
    workItemId: WORK_ITEM_ID,
    bindingId: BINDING_ID,
    profile: {
      id: 'agent-profile-adadadad-adad-4dad-8dad-adadadadadad',
      version: 1,
      agentPresetId: 'standard',
      modelRoute: { provider: 'fixture', model: 'fixture' },
    },
    sessionId: SESSION_ID,
    inputPlan: {
      messageId: 'aeaeaeae-aeae-4eae-8eae-aeaeaeaeaeae',
      payloadDigest: '2'.repeat(64),
    },
    dispatchIds: [INITIAL_DISPATCH_ID],
    state: 'running',
    hostResult: {
      type: 'start-agent-run',
      agentRunId: AGENT_RUN_ID,
      workSessionId: WORK_SESSION_ID,
      sessionId: SESSION_ID,
      inputMessageId: 'aeaeaeae-aeae-4eae-8eae-aeaeaeaeaeae',
    },
    createdAt: 10,
    updatedAt: 11,
  } as const

  it('makes Assignment ownership explicit while retaining exact v7 input', () => {
    expect(workAssignmentV1RecordSchema.parse(assignmentV1)).toEqual(assignmentV1)
    const current = { ...assignmentV1, schemaVersion: 2, ownerPrincipalId: PRINCIPAL_ID } as const
    expect(workAssignmentRecordSchema.parse(current)).toEqual(current)
    expect(workAssignmentRecordSchema.safeParse(assignmentV1).success).toBe(false)
    expect(workAssignmentV1RecordSchema.safeParse(current).success).toBe(false)
  })

  it('requires one exclusive blocker while a delivered Run waits or resumes', () => {
    const waiting = {
      ...runV1,
      schemaVersion: 2,
      state: 'waiting',
      blockingInterventionId: INTERVENTION_ID,
    } as const
    expect(agentRunRecordSchema.parse(waiting)).toEqual(waiting)
    expect(agentRunRecordSchema.safeParse({ ...waiting, blockingInterventionId: undefined }).success).toBe(false)

    const { hostResult: _priorResult, ...withoutPriorResult } = waiting
    const resumePending = {
      ...withoutPriorResult,
      state: 'resume-pending',
      inputPlan: {
        messageId: answer.inputPlan.messageId,
        payloadDigest: answer.inputPlan.payloadDigest,
      },
      dispatchIds: [...waiting.dispatchIds, answer.dispatchId],
    } as const
    expect(agentRunRecordSchema.parse(resumePending)).toEqual(resumePending)
    expect(agentRunRecordSchema.safeParse({ ...resumePending, hostResult: waiting.hostResult }).success).toBe(false)
    expect(agentRunV1RecordSchema.safeParse(waiting).success).toBe(false)
  })

  it('validates every relationship in the exact v7 Agent Run format', () => {
    expect(agentRunV1RecordSchema.parse(runV1)).toEqual(runV1)
    expectSchemaIssue(agentRunV1RecordSchema.safeParse({
      ...runV1,
      dispatchIds: [INITIAL_DISPATCH_ID, INITIAL_DISPATCH_ID],
    }), 'Agent Run repeats Dispatch ids')
    expectSchemaIssue(agentRunV1RecordSchema.safeParse({
      ...runV1,
      updatedAt: runV1.createdAt - 1,
    }), 'Agent Run timestamps are not monotonic')

    for (const hostResult of [
      { ...runV1.hostResult, agentRunId: OTHER_AGENT_RUN_ID },
      { ...runV1.hostResult, workSessionId: OTHER_WORK_SESSION_ID },
      { ...runV1.hostResult, sessionId: OTHER_SESSION_ID },
      { ...runV1.hostResult, inputMessageId: 'bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc' },
    ]) {
      expectSchemaIssue(agentRunV1RecordSchema.safeParse({ ...runV1, hostResult }),
        'Agent Run Host result disagrees with its exact input plan')
    }

    const { hostResult: _hostResult, ...withoutHostResult } = runV1
    expect(agentRunV1RecordSchema.parse({ ...withoutHostResult, state: 'allocated' }))
      .toMatchObject({ state: 'allocated' })
    expectSchemaIssue(agentRunV1RecordSchema.safeParse(withoutHostResult),
      'Agent Run Host result disagrees with state')
    expectSchemaIssue(agentRunV1RecordSchema.safeParse({ ...runV1, state: 'allocated' }),
      'Agent Run Host result disagrees with state')
  })
})
