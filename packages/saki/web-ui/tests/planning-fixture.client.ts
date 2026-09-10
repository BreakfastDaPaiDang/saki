/** Owned API observations and gesture fixtures for the planning object and presentation tests. */
import { vi } from 'vitest'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { SAKI_BOARD_PROJECTION_FIXTURES } from '@breakfastdapaidang/saki-control-plane/fixtures'
import type { SakiWireAccessProjection, SakiWireProjectionWatchResult, SakiWireMoveWorkItemIntent, SakiWireMoveWorkItemResult } from '@breakfastdapaidang/saki-host-api/wire'
import { sakiProjectMappingResultSchema, sakiConfigureGitHubSynchronizationIntentSchema } from '@breakfastdapaidang/saki-host-api/wire'
import { PlanningController } from '../src/client/planning-controller.ts'
import type { PlanningBoard } from '../src/client/planning-controller.ts'
import { createPlanningStore } from '../src/client/planning-state.ts'
import { createSakiNavigationStore } from '../src/client/navigation.ts'
import { BOARD_STATUSES } from '../src/client/planning-cards.ts'

export const AUTH = { kind: 'authenticated', principal: { id: 'principal-0a1b2c3d-0000-4000-8000-000000000001', displayName: 'Operator' }, expiresAt: 9_999_999_999_999, requestToken: 'request-1' } as Extract<SakiWireAccessProjection, { kind: 'authenticated' }>
export const BOARD: PlanningBoard = { ...SAKI_BOARD_PROJECTION_FIXTURES.confirmedStaleFailure, scan: { state: 'idle' }, failure: undefined }
export const ITEM = BOARD.confirmed!.items[0]!
export const PROJECT_ID = BOARD.projectId
export const OTHER_PROJECT_ID = 'project-0a1b2c3d-0000-4000-8000-000000000002' as typeof PROJECT_ID
export const MAPPING_PATCH = sakiConfigureGitHubSynchronizationIntentSchema.shape.patch.parse({
  statusFieldNodeId: 'FIELD_status', statusOptionNodeIds: {
    inbox: 'option-inbox', backlog: 'option-backlog', ready: 'option-ready', inProgress: 'option-in-progress',
    inReview: 'option-in-review', done: 'option-done', canceled: 'option-canceled',
  },
})
export const MAPPING = sakiProjectMappingResultSchema.parse({ ok: true, projection: {
  type: 'project-mapping', projectId: PROJECT_ID, synchronizationRevision: 1, canConfigure: true,
  choices: { projectId: 'PVT_project', observedAt: 1, fields: [{
    kind: 'single-select', id: MAPPING_PATCH.statusFieldNodeId, name: 'Workflow Status',
    options: BOARD_STATUSES.map(name => ({ name, id: `option-${name}` })),
  }] },
} })

type Api = ConstructorParameters<typeof PlanningController>[0]
export function successfulMove(intent: SakiWireMoveWorkItemIntent): SakiWireMoveWorkItemResult {
  return { ok: true, receipt: { id: intent.intentId.replace('intent-', 'receipt-') as Extract<SakiWireMoveWorkItemResult, { ok: true }>['receipt']['id'], type: 'move-work-item', intentId: intent.intentId, projectId: intent.projectId, state: 'succeeded', workItemId: intent.workItemId, issueNumber: ITEM.issueNumber, url: ITEM.url, remoteFingerprint: ITEM.remoteFingerprint } }
}
export function planningFixture() {
  const navigation = createSakiNavigationStore().create()
  const interaction = createPlanningStore().create()
  let currentBoard = BOARD
  const watchers = new Set<ReturnType<typeof Promise.withResolvers<SakiWireProjectionWatchResult>>>()
  const api = {
    readAccess: vi.fn<Api['readAccess']>().mockResolvedValue(AUTH),
    exchangeBootstrap: vi.fn<Api['exchangeBootstrap']>().mockResolvedValue({ ok: true, access: AUTH }),
    queryBoard: vi.fn<Api['queryBoard']>().mockImplementation(async projectId => ({ ok: true, projection: { ...currentBoard, projectId } })),
    queryProjectMilestones: vi.fn<Api['queryProjectMilestones']>().mockImplementation(async projectId => ({ ok: true, projection: { type: 'project-milestones', projectId, items: [], next: null } })),
    queryWorkItemView: vi.fn<Api['queryWorkItemView']>().mockImplementation(async projectId => ({ ok: true, projection: { type: 'work-item-view', projectId, workItem: ITEM, body: { state: 'confirmed', markdown: '## Acceptance criteria\n- Keep confirmed facts.', issueUpdatedAt: ITEM.updatedAt, observedAt: 10, matchesBoard: true }, assignments: [], runs: [], interventions: [], branchDelivery: null, milestones: [], activity: [], earlierActivity: false } })),
    queryMilestoneView: vi.fn<Api['queryMilestoneView']>().mockResolvedValue({ ok: false, reason: 'not-found' }),
    queryProjectMapping: vi.fn<Api['queryProjectMapping']>().mockResolvedValue({ ok: false, reason: 'unavailable' }),
    moveWorkItem: vi.fn<Api['moveWorkItem']>().mockImplementation(async intent => successfulMove(intent)),
    configureGitHubSynchronization: vi.fn<Api['configureGitHubSynchronization']>().mockResolvedValue({ ok: false, reason: 'unavailable' }),
    watchProjections: vi.fn<Api['watchProjections']>().mockImplementation(async (_cursor, signal) => {
      const held = Promise.withResolvers<SakiWireProjectionWatchResult>()
      const abort = () => { held.reject(signal?.reason) }
      signal?.addEventListener('abort', abort, { once: true })
      watchers.add(held)
      try { return await held.promise } finally { signal?.removeEventListener('abort', abort); watchers.delete(held) }
    }),
  } satisfies Api
  const controller = new PlanningController(api, navigation, interaction)
  return { api, navigation, interaction, controller,
    board: (board: PlanningBoard) => { currentBoard = board },
    invalidate: (cursor = randomUUID()) => { for (const watcher of [...watchers]) watcher.resolve({ ok: true, cursor: cursor as Extract<SakiWireProjectionWatchResult, { ok: true }>['cursor'] }) },
    failWatch: () => { for (const watcher of [...watchers]) watcher.reject(new Error('watch transport failed')) },
    start: async () => { navigation.actions.selectProject(PROJECT_ID); controller.start(); await vi.waitFor(() => { if (controller.getSnapshot().project?.board.value == null) throw new Error('Board pending') }) },
  }
}
