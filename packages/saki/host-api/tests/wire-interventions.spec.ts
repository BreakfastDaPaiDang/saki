import { describe, expect, it } from 'vitest'
import {
  sakiAnswerInterventionIntentSchema,
  sakiAnswerInterventionResultSchema,
  sakiAttentionResultSchema,
  sakiIntentRequestSchema,
  sakiIntentResultSchema,
  sakiMyWorkResultSchema,
  sakiQueryRequestSchema,
} from '../src/wire.ts'

const PRINCIPAL_ID = 'principal-11111111-1111-4111-8111-111111111111'
const PROJECT_ID = 'project-22222222-2222-4222-8222-222222222222'
const WORK_ITEM_ID = `work-item-${'3'.repeat(64)}`
const WORK_SESSION_ID = 'work-session-44444444-4444-4444-8444-444444444444'
const AGENT_RUN_ID = 'agent-run-55555555-5555-4555-8555-555555555555'
const ASSIGNMENT_ID = 'assignment-66666666-6666-4666-8666-666666666666'
const INTERVENTION_ID = 'intervention-77777777-7777-4777-8777-777777777777'
const DISPATCH_ID = 'dispatch-88888888-8888-4888-8888-888888888888'
const INTENT_ID = 'intent-99999999-9999-4999-8999-999999999999'
const RECEIPT_ID = 'receipt-99999999-9999-4999-8999-999999999999'
const OTHER_PRINCIPAL_ID = 'principal-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_PROJECT_ID = 'project-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const REMOTE_FINGERPRINT = `remote-fingerprint-${'c'.repeat(64)}`

const requiredAnswer = {
  kind: 'text',
  prompt: 'Which public API should this use?',
  maxLength: 16_384,
} as const

const returnAddress = {
  kind: 'agent-run',
  projectId: PROJECT_ID,
  workItemId: WORK_ITEM_ID,
  workSessionId: WORK_SESSION_ID,
  agentRunId: AGENT_RUN_ID,
} as const

const intervention = {
  id: INTERVENTION_ID,
  revision: 3,
  kind: 'text-input',
  state: 'open',
  targetPrincipalId: PRINCIPAL_ID,
  requiredAnswer,
  createdAt: 100,
  updatedAt: 120,
  returnAddress,
} as const

const myWork = {
  type: 'my-work',
  principalId: PRINCIPAL_ID,
  items: [{
    project: { id: PROJECT_ID, title: 'Saki' },
    workItem: {
      id: WORK_ITEM_ID,
      title: 'Persist intervention requests',
      issueNumber: 31,
      status: 'in-progress',
      updatedAt: 90,
    },
    group: 'waiting-for-operator',
    assignment: {
      id: ASSIGNMENT_ID,
      revision: 2,
      ownerPrincipalId: PRINCIPAL_ID,
      state: 'active',
    },
    run: { id: AGENT_RUN_ID, revision: 4, state: 'waiting' },
    intervention,
    returnAddress,
    recommendation: {
      available: true,
      offer: {
        type: 'answer-intervention',
        interventionId: INTERVENTION_ID,
        expectedInterventionRevision: 3,
        requiredAnswer,
        reason: 'response-required',
      },
    },
  }],
} as const

const attention = {
  type: 'attention',
  principalId: PRINCIPAL_ID,
  items: [{
    source: { kind: 'intervention', id: INTERVENTION_ID, revision: 3 },
    projectId: PROJECT_ID,
    targetPrincipalId: PRINCIPAL_ID,
    severity: 'action-required',
    openedAt: 110,
    requiredResponse: requiredAnswer,
    returnAddress,
  }],
} as const

const readyItem = {
  project: myWork.items[0].project,
  workItem: { ...myWork.items[0].workItem, status: 'ready' },
  group: 'ready-to-start',
  returnAddress: { kind: 'work-item', projectId: PROJECT_ID, workItemId: WORK_ITEM_ID },
  recommendation: {
    available: true,
    offer: {
      type: 'give-work-item-to-agent',
      projectId: PROJECT_ID,
      workItemId: WORK_ITEM_ID,
      expectedProjectRevision: 2,
      expectedRemoteFingerprint: REMOTE_FINGERPRINT,
      reason: 'ready',
    },
  },
} as const

const activeItem = {
  ...readyItem,
  workItem: { ...readyItem.workItem, status: 'in-progress' },
  group: 'active',
  assignment: myWork.items[0].assignment,
  run: { ...myWork.items[0].run, state: 'running' },
  returnAddress,
  recommendation: { available: false, reason: 'active-work' },
} as const

describe('Saki Intervention and Principal work wire contract', () => {
  it('admits the two Principal-scoped query tags and strict answer Intent', () => {
    expect(sakiQueryRequestSchema.parse({ type: 'my-work' })).toEqual({ type: 'my-work' })
    expect(sakiQueryRequestSchema.parse({ type: 'attention' })).toEqual({ type: 'attention' })

    const intent = {
      type: 'answer-intervention',
      intentId: INTENT_ID,
      interventionId: INTERVENTION_ID,
      expectedInterventionRevision: 3,
      answer: { kind: 'text', text: 'Use the Principal-scoped projection.' },
    } as const
    expect(sakiAnswerInterventionIntentSchema.parse(intent)).toEqual(intent)
    expect(sakiIntentRequestSchema.parse(intent)).toEqual(intent)
    expect(sakiAnswerInterventionIntentSchema.safeParse({
      ...intent,
      actor: { principalId: PRINCIPAL_ID },
    }).success).toBe(false)
    expect(sakiAnswerInterventionIntentSchema.safeParse({
      ...intent,
      answer: { kind: 'text', text: '' },
    }).success).toBe(false)
    for (const text of ['contains\0nul', '\ud800']) {
      expect(sakiAnswerInterventionIntentSchema.safeParse({
        ...intent,
        answer: { kind: 'text', text },
      }).success).toBe(false)
    }
  })

  it('accepts every derived My Work group and unavailable recommendation class', () => {
    const terminal = {
      ...readyItem,
      workItem: { ...readyItem.workItem, status: 'done' as const },
      group: 'recently-finished' as const,
      recommendation: { available: false as const, reason: 'terminal-work-item' },
    }
    const review = {
      ...activeItem,
      workItem: { ...activeItem.workItem, status: 'in-review' as const },
      group: 'waiting-for-operator' as const,
      recommendation: { available: false as const, reason: 'acceptance-not-available' },
    }
    const reconciliation = {
      ...activeItem,
      group: 'waiting-for-operator' as const,
      assignment: { ...activeItem.assignment, state: 'reconciliation-required' as const },
      recommendation: { available: false as const, reason: 'reconciliation-required' },
    }
    const reconciledIntervention = {
      ...myWork.items[0],
      intervention: { ...intervention, state: 'reconciliation-required' as const },
      recommendation: { available: false as const, reason: 'reconciliation-required' },
    }
    const deniedOpenIntervention = {
      ...myWork.items[0],
      recommendation: { available: false as const, reason: 'response-action-denied' },
    }
    const unavailableReady = {
      ...readyItem,
      recommendation: { available: false as const, reason: 'git-unavailable' },
    }
    const projection = {
      type: 'my-work' as const,
      principalId: PRINCIPAL_ID,
      items: [readyItem, activeItem, terminal, review, reconciliation, reconciledIntervention,
        deniedOpenIntervention, unavailableReady],
    }

    expect(sakiMyWorkResultSchema.parse({ ok: true, projection }))
      .toEqual({ ok: true, projection })
  })

  it('rejects independently valid My Work ownership, grouping, and recommendation mismatches', () => {
    const cases = [
      { ...readyItem, returnAddress: { ...readyItem.returnAddress, projectId: OTHER_PROJECT_ID } },
      { ...activeItem, assignment: { ...activeItem.assignment, ownerPrincipalId: OTHER_PRINCIPAL_ID } },
      { ...myWork.items[0], intervention: { ...intervention, targetPrincipalId: OTHER_PRINCIPAL_ID } },
      { ...activeItem, run: undefined },
      { ...activeItem, group: 'ready-to-start' },
      { ...activeItem, assignment: { ...activeItem.assignment, state: 'canceled' } },
      { ...readyItem, workItem: { ...readyItem.workItem, status: 'backlog' } },
      { ...activeItem, returnAddress: { ...returnAddress, agentRunId: 'agent-run-dddddddd-dddd-4ddd-8ddd-dddddddddddd' } },
      { ...readyItem, recommendation: { available: false, reason: 'active-work' } },
      {
        ...readyItem,
        recommendation: {
          ...readyItem.recommendation,
          offer: { ...readyItem.recommendation.offer, projectId: OTHER_PROJECT_ID },
        },
      },
      {
        ...myWork.items[0],
        recommendation: {
          ...myWork.items[0].recommendation,
          offer: { ...myWork.items[0].recommendation.offer, expectedInterventionRevision: 4 },
        },
      },
    ]
    for (const item of cases) {
      expect(sakiMyWorkResultSchema.safeParse({
        ok: true,
        projection: { type: 'my-work', principalId: PRINCIPAL_ID, items: [item] },
      }).success).toBe(false)
    }

    expect(sakiMyWorkResultSchema.safeParse({
      ok: true,
      projection: {
        type: 'my-work',
        principalId: PRINCIPAL_ID,
        items: [{ ...myWork.items[0], intervention: { ...intervention, updatedAt: 99 } }],
      },
    }).success).toBe(false)
  })

  it('accepts every Attention source and rejects cross-record mismatches', () => {
    const workAssignment = {
      ...attention.items[0],
      source: { kind: 'work-assignment' as const, id: ASSIGNMENT_ID, revision: 2 },
      severity: 'warning' as const,
    }
    const { requiredResponse: _workAssignmentResponse, ...workAssignmentWithoutResponse } = workAssignment
    const executionDispatch = {
      ...workAssignmentWithoutResponse,
      source: { kind: 'execution-dispatch' as const, id: DISPATCH_ID, revision: 2 },
      severity: 'action-required' as const,
    }
    const projection = {
      ...attention,
      items: [...attention.items, workAssignmentWithoutResponse, executionDispatch],
    }
    expect(sakiAttentionResultSchema.parse({ ok: true, projection })).toEqual({ ok: true, projection })

    for (const item of [
      { ...attention.items[0], projectId: OTHER_PROJECT_ID },
      { ...workAssignmentWithoutResponse, requiredResponse: requiredAnswer },
      { ...attention.items[0], severity: 'information' },
      { ...workAssignmentWithoutResponse, returnAddress: readyItem.returnAddress },
      { ...executionDispatch, severity: 'warning' },
      { ...attention.items[0], targetPrincipalId: OTHER_PRINCIPAL_ID },
    ]) {
      expect(sakiAttentionResultSchema.safeParse({
        ok: true,
        projection: { ...attention, items: [item] },
      }).success).toBe(false)
    }
  })

  it('round-trips detached My Work and Attention results without transport authority', () => {
    expect(sakiMyWorkResultSchema.parse({ ok: true, projection: myWork }))
      .toEqual({ ok: true, projection: myWork })
    expect(sakiAttentionResultSchema.parse({ ok: true, projection: attention }))
      .toEqual({ ok: true, projection: attention })
    const { requiredResponse: _requiredResponse, ...reconciliationItem } = attention.items[0]
    const reconciliationAttention = {
      ...attention,
      items: [{ ...reconciliationItem, severity: 'warning' as const }],
    }
    expect(sakiAttentionResultSchema.parse({ ok: true, projection: reconciliationAttention }))
      .toEqual({ ok: true, projection: reconciliationAttention })

    expect(sakiMyWorkResultSchema.safeParse({
      ok: true,
      projection: {
        ...myWork,
        items: [{
          ...myWork.items[0],
          returnAddress: { ...returnAddress, canonicalWorktreePath: 'D:/private/repository' },
        }],
      },
    }).success).toBe(false)
    expect(sakiMyWorkResultSchema.safeParse({
      ok: true,
      projection: {
        ...myWork,
        items: [{
          ...myWork.items[0],
          recommendation: {
            available: true,
            offer: { ...myWork.items[0].recommendation.offer, intentId: INTENT_ID },
          },
        }],
      },
    }).success).toBe(false)
    expect(sakiMyWorkResultSchema.safeParse({
      ok: true,
      projection: {
        ...myWork,
        items: [{
          ...myWork.items[0],
          intervention: { ...intervention, state: 'reconciliation-required' },
        }],
      },
    }).success).toBe(false)
    expect(sakiAttentionResultSchema.safeParse({
      ok: true,
      projection: {
        ...attention,
        items: [{ ...attention.items[0], dismissed: true }],
      },
    }).success).toBe(false)
  })

  it('rejects projection combinations that the Principal derivation cannot produce', () => {
    expect(sakiMyWorkResultSchema.safeParse({
      ok: true,
      projection: {
        ...myWork,
        items: [{
          ...myWork.items[0],
          group: 'recently-finished',
          intervention: { ...intervention, state: 'resolved' },
          recommendation: { available: false, reason: 'terminal-work-item' },
        }],
      },
    }).success).toBe(false)
    expect(sakiMyWorkResultSchema.safeParse({
      ok: true,
      projection: {
        ...myWork,
        items: [{
          ...myWork.items[0],
          returnAddress: { kind: 'work-item', projectId: PROJECT_ID, workItemId: WORK_ITEM_ID },
        }],
      },
    }).success).toBe(false)
    const { requiredResponse: _requiredResponse, ...withoutResponse } = attention.items[0]
    expect(sakiAttentionResultSchema.safeParse({
      ok: true,
      projection: { ...attention, items: [withoutResponse] },
    }).success).toBe(false)
    expect(sakiAttentionResultSchema.safeParse({
      ok: true,
      projection: {
        ...attention,
        items: [{
          ...withoutResponse,
          source: { kind: 'execution-dispatch', id: DISPATCH_ID, revision: 1 },
          severity: 'warning',
        }],
      },
    }).success).toBe(false)
  })

  it('serializes the durable answer receipt without Actor or answer text', () => {
    const result = {
      ok: true,
      receipt: {
        id: RECEIPT_ID,
        intentId: INTENT_ID,
        type: 'answer-intervention',
        interventionId: INTERVENTION_ID,
        interventionRevision: 5,
        state: 'resolved',
        dispatchId: DISPATCH_ID,
      },
    } as const
    expect(sakiAnswerInterventionResultSchema.parse(result)).toEqual(result)
    expect(sakiIntentResultSchema.parse(result)).toEqual(result)
    expect(JSON.stringify(result)).not.toMatch(/principal|grant|"answer"|"text"/iu)
  })

  it('round-trips every recoverable Intervention answer receipt phase', () => {
    const identity = {
      id: RECEIPT_ID,
      intentId: INTENT_ID,
      type: 'answer-intervention' as const,
      interventionId: INTERVENTION_ID,
      interventionRevision: 5,
    }
    const results = [
      { ok: true, receipt: { ...identity, state: 'answered', dispatchId: DISPATCH_ID } },
      {
        ok: false,
        reason: 'unavailable',
        receipt: { ...identity, state: 'answered', dispatchId: DISPATCH_ID },
      },
      {
        ok: false,
        reason: 'conflict',
        receipt: { ...identity, state: 'conflict', reason: 'already-answered' },
      },
      {
        ok: false,
        reason: 'reconciliation-required',
        receipt: { ...identity, state: 'reconciliation-required', reason: 'effect-unknown' },
      },
    ]
    for (const result of results) {
      expect(sakiAnswerInterventionResultSchema.parse(result)).toEqual(result)
      expect(sakiIntentResultSchema.parse(result)).toEqual(result)
    }
  })
})
