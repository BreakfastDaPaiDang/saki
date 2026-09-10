/** Presentation grouping over server-mapped statuses, positions, and explicit overlays. */
import type { PlanningBoard, PlanningItem, PlanningMove } from './planning-controller.ts'
import type { BoardStatus } from './planning-state.ts'

/** Fixed order of the seven mapped Status destinations. */
export const BOARD_STATUSES: readonly BoardStatus[] = ['inbox', 'backlog', 'ready', 'in-progress', 'in-review', 'done', 'canceled']
/** A confirmed card plus its independently displayed optimistic position. */
export interface PlanningCard { readonly item: PlanningItem; readonly status: BoardStatus; readonly pending: boolean }
/**
 * Group complete confirmations and targeted confirmations, then draw pending gestures separately.
 * @param board - complete Board and authoritative server overlays.
 * @param moves - this Client's pending and completed gestures.
 * @returns cards in display order without rewriting their confirmed item facts.
 */
export function planningCards(board: PlanningBoard | null, moves: readonly PlanningMove[]): PlanningCard[] {
  const items = new Map(board?.confirmed?.items.map(item => [item.id, item]))
  for (const overlay of board?.mutationOverlays ?? []) {
    if ((overlay.state === 'targeted-confirmed' || overlay.state === 'conflict') && overlay.workItem !== undefined) items.set(overlay.workItem.id, overlay.workItem)
  }
  const cards = [...items.values()]
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map(item => ({ item, status: item.status, pending: false }))
  const serverMoves = (board?.mutationOverlays ?? []).flatMap(overlay => overlay.state === 'optimistic' && overlay.type === 'move-work-item' ? [overlay] : [])
  const pending = [...serverMoves, ...moves.filter(move => move.state === 'pending').map(move => move.intent)]
  for (const intent of pending) {
    const card = cards.find(card => card.item.id === intent.workItemId)
    if (card === undefined) continue
    const index = cards.indexOf(card)
    cards.splice(index, 1)
    const shifted = { ...card, status: intent.targetStatus, pending: true }
    if (intent.position === undefined) cards.splice(index, 0, shifted)
    else if (intent.position.afterWorkItemId === null) cards.unshift(shifted)
    else {
      const after = cards.findIndex(candidate => candidate.item.id === intent.position?.afterWorkItemId)
      cards.splice(after < 0 ? cards.length : after + 1, 0, shifted)
    }
  }
  return cards
}
