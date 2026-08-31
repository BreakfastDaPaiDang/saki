import { describe, expect, it } from 'vitest'
import { canonicalDigest } from '@breakfastdapaidang/saki-execution'
import {
  sakiBoardMutationAvailabilitySchema,
  sakiBoardMutationOverlaySchema,
  sakiCreateWorkItemIntentSchema,
  sakiCreateWorkItemResultSchema,
  sakiMoveWorkItemIntentSchema,
  sakiMoveWorkItemResultSchema,
} from '../src/wire.ts'

const INTENT_ID = 'intent-11111111-1111-4111-8111-111111111111'
const PROJECT_ID = 'project-22222222-2222-4222-8222-222222222222'
const RECEIPT_ID = 'receipt-11111111-1111-4111-8111-111111111111'
const WORK_ITEM_ID = `work-item-${'3'.repeat(64)}`
const NEIGHBOR_ID = `work-item-${'4'.repeat(64)}`
const REPOSITORY_ID = 'R_saki_repository'
const ISSUE_ID = 'I_saki_issue_28'
const CONFIRMED_WORK_ITEM_ID = `work-item-${canonicalDigest('saki/board-work-item/v1', {
  repositoryId: REPOSITORY_ID,
  issueId: ISSUE_ID,
})}`
const CONFIRMED_WORK_ITEM = {
  id: CONFIRMED_WORK_ITEM_ID,
  title: 'Conflict-safe Work Item mutations',
  issueNumber: 28,
  url: 'https://github.com/BreakfastDaPaiDang/saki/issues/28',
  issueState: 'open',
  status: 'in-progress',
  latestNonTerminalStatus: 'in-progress',
  order: 3,
  archived: false,
  notInProject: false,
  updatedAt: 200,
  source: {
    kind: 'github-issue',
    repositoryId: REPOSITORY_ID,
    issueId: ISSUE_ID,
    projectItemId: 'PVTI_saki_item_28',
    apiOrder: 3,
  },
  remoteFingerprint: `remote-fingerprint-${'6'.repeat(64)}`,
} as const

describe('Saki Work Item wire contract', () => {
  it('admits an available mutation surface only with no unavailable reasons', () => {
    expect(sakiBoardMutationAvailabilitySchema.parse({ available: true, reasons: [] }))
      .toEqual({ available: true, reasons: [] })
    expect(sakiBoardMutationAvailabilitySchema.safeParse({
      available: true,
      reasons: ['provider-unavailable'],
    }).success).toBe(false)
    expect(sakiBoardMutationAvailabilitySchema.safeParse({
      available: false,
      reasons: [],
    }).success).toBe(false)
    expect(sakiBoardMutationAvailabilitySchema.safeParse({
      available: false,
      reasons: ['no-concrete-mutation'],
    }).success).toBe(false)
  })

  it('round-trips every durable Board mutation overlay and rejects extra provider evidence', () => {
    const overlays = [
      {
        state: 'optimistic',
        intentId: INTENT_ID,
        type: 'create-work-item',
        title: 'New Work Item',
        targetStatus: 'inbox',
      },
      {
        state: 'optimistic',
        intentId: INTENT_ID,
        type: 'move-work-item',
        workItemId: CONFIRMED_WORK_ITEM_ID,
        targetStatus: 'in-review',
        position: {
          afterWorkItemId: NEIGHBOR_ID,
          expectedAfterRemoteFingerprint: `remote-fingerprint-${'8'.repeat(64)}`,
        },
      },
      {
        state: 'targeted-confirmed',
        intentId: INTENT_ID,
        type: 'move-work-item',
        workItem: CONFIRMED_WORK_ITEM,
        confirmedAt: 210,
      },
      {
        state: 'conflict',
        intentId: INTENT_ID,
        type: 'move-work-item',
        reason: 'stale-remote',
        workItem: CONFIRMED_WORK_ITEM,
        confirmedAt: 210,
      },
      {
        state: 'partial-failure',
        intentId: INTENT_ID,
        type: 'create-work-item',
        workItemId: CONFIRMED_WORK_ITEM_ID,
        stage: 'project-item-add',
        recoveryAction: { kind: 'resume-intent' },
      },
      {
        state: 'reconciliation-required',
        intentId: INTENT_ID,
        type: 'create-work-item',
        stage: 'issue-create',
        reason: 'marker-ambiguous',
      },
      {
        state: 'repair-required',
        workItemId: CONFIRMED_WORK_ITEM_ID,
        reason: 'external-close',
        action: 'move-with-actor',
        suggestedStatus: 'done',
      },
    ] as const

    for (const overlay of overlays) {
      expect(sakiBoardMutationOverlaySchema.parse(overlay)).toEqual(overlay)
      expect(sakiBoardMutationOverlaySchema.safeParse({ ...overlay, installationId: '1234' }).success).toBe(false)
    }
    expect(sakiBoardMutationOverlaySchema.safeParse({
      state: 'repair-required',
      workItemId: CONFIRMED_WORK_ITEM_ID,
      reason: 'mapping-conflict',
      action: 'repair-mapping',
      suggestedStatus: 'done',
    }).success).toBe(false)
    expect(sakiBoardMutationOverlaySchema.safeParse({
      state: 'repair-required',
      workItemId: CONFIRMED_WORK_ITEM_ID,
      reason: 'external-close',
      action: 'move-with-actor',
    }).success).toBe(false)
  })

  it('requires coherent latest non-terminal Status memory on projected Work Items', () => {
    const overlay = {
      state: 'targeted-confirmed',
      intentId: INTENT_ID,
      type: 'move-work-item',
      workItem: CONFIRMED_WORK_ITEM,
      confirmedAt: 210,
    } as const
    expect(sakiBoardMutationOverlaySchema.safeParse({
      ...overlay,
      workItem: { ...CONFIRMED_WORK_ITEM, latestNonTerminalStatus: 'backlog' },
    }).success).toBe(false)
    const { latestNonTerminalStatus: _latestNonTerminalStatus, ...withoutLatestStatus } = CONFIRMED_WORK_ITEM
    expect(sakiBoardMutationOverlaySchema.safeParse({
      ...overlay,
      workItem: withoutLatestStatus,
    }).success).toBe(false)
    expect(sakiBoardMutationOverlaySchema.safeParse({
      ...overlay,
      workItem: {
        ...CONFIRMED_WORK_ITEM,
        issueState: 'closed',
        status: 'done',
        latestNonTerminalStatus: null,
      },
    }).success).toBe(true)
  })

  it('accepts only browser-safe Work Item creation authority', () => {
    const intent = {
      type: 'create-work-item',
      intentId: INTENT_ID,
      projectId: PROJECT_ID,
      expected: {
        projectRevision: 3,
        synchronizationRevision: 4,
        mappingRevision: 4,
      },
      title: 'Expose conflict-safe Board mutation',
      intendedOutcome: 'A confirmed GitHub-backed Work Item exists.',
      acceptanceCriteria: ['The Issue and Project membership are both confirmed.'],
    } as const

    expect(sakiCreateWorkItemIntentSchema.parse(intent)).toEqual(intent)
    expect(sakiCreateWorkItemIntentSchema.safeParse({
      ...intent,
      repositoryId: 'R_forbidden',
    }).success).toBe(false)
  })

  it('accepts an API-native Saki predecessor or top without provider placement authority', () => {
    const intent = {
      type: 'move-work-item',
      intentId: INTENT_ID,
      projectId: PROJECT_ID,
      workItemId: WORK_ITEM_ID,
      expectedRemoteFingerprint: `remote-fingerprint-${'5'.repeat(64)}`,
      targetStatus: 'in-review',
      position: {
        afterWorkItemId: NEIGHBOR_ID,
        expectedAfterRemoteFingerprint: `remote-fingerprint-${'6'.repeat(64)}`,
      },
    } as const

    expect(sakiMoveWorkItemIntentSchema.parse(intent)).toEqual(intent)
    expect(sakiMoveWorkItemIntentSchema.parse({
      ...intent,
      position: { afterWorkItemId: null },
    })).toEqual({ ...intent, position: { afterWorkItemId: null } })
    expect(sakiMoveWorkItemIntentSchema.safeParse({
      ...intent,
      projectItemId: 'PVTI_forbidden',
    }).success).toBe(false)
    expect(sakiMoveWorkItemIntentSchema.safeParse({
      ...intent,
      position: {
        afterWorkItemId: WORK_ITEM_ID,
        expectedAfterRemoteFingerprint: `remote-fingerprint-${'6'.repeat(64)}`,
      },
    }).success).toBe(false)
    expect(sakiMoveWorkItemIntentSchema.safeParse({
      ...intent,
      position: { afterWorkItemId: NEIGHBOR_ID },
    }).success).toBe(false)
  })

  it('projects every recoverable Work Item receipt state without provider authority', () => {
    const base = {
      id: RECEIPT_ID,
      intentId: INTENT_ID,
      type: 'create-work-item',
      projectId: PROJECT_ID,
    } as const
    const succeeded = {
      ...base,
      state: 'succeeded',
      workItemId: CONFIRMED_WORK_ITEM_ID,
      issueNumber: 28,
      url: 'https://github.com/BreakfastDaPaiDang/saki/issues/28',
      remoteFingerprint: `remote-fingerprint-${'6'.repeat(64)}`,
    } as const
    const results = [
      { ok: true, receipt: succeeded },
      { ok: false, reason: 'denied' },
      { ok: false, reason: 'unavailable' },
      { ok: false, reason: 'unavailable', receipt: { ...base, state: 'prepared' } },
      {
        ok: false,
        reason: 'unavailable',
        receipt: { ...base, state: 'running', workItemId: CONFIRMED_WORK_ITEM_ID },
      },
      {
        ok: false,
        reason: 'unavailable',
        receipt: {
          ...base,
          state: 'partial-failure',
          workItemId: CONFIRMED_WORK_ITEM_ID,
          stage: 'project-item-status-set',
          recoveryAction: { kind: 'repair-mapping', reason: 'Status mapping changed.' },
        },
      },
      { ok: false, reason: 'conflict' },
      {
        ok: false,
        reason: 'conflict',
        receipt: {
          ...base,
          state: 'conflict',
          reason: 'stale-remote',
          workItemId: CONFIRMED_WORK_ITEM_ID,
          remoteFingerprint: `remote-fingerprint-${'7'.repeat(64)}`,
        },
      },
      {
        ok: false,
        reason: 'reconciliation-required',
        receipt: {
          ...base,
          state: 'reconciliation-required',
          reason: 'marker-ambiguous',
          stage: 'issue-create',
        },
      },
      {
        ok: false,
        reason: 'canceled',
        receipt: {
          ...base,
          state: 'canceled',
          reason: 'authority-revoked',
          workItemId: CONFIRMED_WORK_ITEM_ID,
        },
      },
    ] as const

    for (const result of results) {
      expect(sakiCreateWorkItemResultSchema.parse(result)).toEqual(result)
    }
    expect(sakiCreateWorkItemResultSchema.safeParse({
      ok: true,
      receipt: { ...succeeded, projectItemId: 'PVTI_forbidden' },
    }).success).toBe(false)
    expect(sakiCreateWorkItemResultSchema.safeParse({
      ok: true,
      receipt: { ...succeeded, id: 'receipt-99999999-9999-4999-8999-999999999999' },
    }).success).toBe(false)
    expect(sakiCreateWorkItemResultSchema.safeParse({
      ok: false,
      reason: 'unavailable',
      receipt: succeeded,
    }).success).toBe(false)

    const moveSucceeded = {
      ok: true,
      receipt: { ...succeeded, type: 'move-work-item' },
    } as const
    expect(sakiMoveWorkItemResultSchema.parse(moveSucceeded)).toEqual(moveSucceeded)
  })
})
