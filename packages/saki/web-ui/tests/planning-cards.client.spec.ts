// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { PlanningItem, PlanningMove } from '../src/client/planning-controller.ts'
import { confirmedPlanningItem } from '../src/client/planning-controller.ts'
import { planningCards } from '../src/client/planning-cards.ts'
import { BOARD, ITEM, PROJECT_ID } from './planning-fixture.client.ts'

const other: PlanningItem = { ...ITEM, id: `work-item-${'e'.repeat(64)}` as PlanningItem['id'], order: ITEM.order + 1 }
function move(position?: PlanningMove['intent']['position']): PlanningMove {
  return { state: 'pending', result: null, intent: {
    type: 'move-work-item', intentId: 'intent-00000000-0000-4000-8000-000000000001' as PlanningMove['intent']['intentId'],
    projectId: PROJECT_ID, workItemId: ITEM.id, expectedRemoteFingerprint: ITEM.remoteFingerprint,
    targetStatus: 'in-progress', ...(position === undefined ? {} : { position }),
  } }
}
const board = { ...BOARD, confirmed: { ...BOARD.confirmed!, items: [other, ITEM] } }

describe('planning card presentation', () => {
  it('keeps confirmed status and order separate from optimistic status and position', () => {
    const cards = planningCards(board, [move({ afterWorkItemId: other.id, expectedAfterRemoteFingerprint: other.remoteFingerprint })])
    expect(cards.map(card => card.item.id)).toEqual([other.id, ITEM.id])
    expect(cards[1]).toEqual({ item: ITEM, status: 'in-progress', pending: true })
    expect(ITEM.status).toBe('ready')
    expect(planningCards(board, [move({ afterWorkItemId: null })])[0]?.item).toBe(ITEM)
    expect(planningCards(board, [move()])[0]?.item).toBe(ITEM)
    expect(planningCards(board, [{ ...move(), state: 'unacknowledged' }])[0]).toEqual({ item: ITEM, status: 'ready', pending: false })
    expect(planningCards(null, [move()])).toEqual([])
    const missingAfter = `work-item-${'d'.repeat(64)}` as PlanningItem['id']
    expect(planningCards(board, [move({ afterWorkItemId: missingAfter, expectedAfterRemoteFingerprint: ITEM.remoteFingerprint })])
      .at(-1)?.item.id).toBe(ITEM.id)
    const sameOrder = { ...board, confirmed: { ...board.confirmed, items: [ITEM, { ...other, order: ITEM.order }] } }
    expect(planningCards(sameOrder, []).map(card => card.item.id)).toEqual([ITEM.id, other.id].sort())
  })

  it('uses targeted-confirmed and conflict observations without promoting pending gestures', () => {
    const confirmed = { ...ITEM, status: 'in-review' as const, order: other.order + 1 }
    const intent = move().intent
    const updated = { ...board, mutationOverlays: [{
      state: 'targeted-confirmed' as const, type: 'move-work-item' as const, intentId: intent.intentId,
      workItem: confirmed, confirmedAt: 100,
    }] }
    expect(confirmedPlanningItem(updated, ITEM.id)).toBe(confirmed)
    expect(planningCards(updated, []).find(card => card.item.id === ITEM.id)).toEqual({ item: confirmed, status: 'in-review', pending: false })
    expect(confirmedPlanningItem(null, ITEM.id)).toBeUndefined()
    const pending = { ...board, mutationOverlays: [{ state: 'optimistic' as const, ...intent }] }
    expect(confirmedPlanningItem(pending, ITEM.id)).toBe(ITEM)
    expect(planningCards(pending, []).find(card => card.item.id === ITEM.id)?.pending).toBe(true)
  })
})
