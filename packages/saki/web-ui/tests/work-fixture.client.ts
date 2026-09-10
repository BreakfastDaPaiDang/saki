/** Typed Host observations for Work presentation and lifecycle tests. */
import { vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { sakiMyWorkResultSchema, sakiProjectIndexResultSchema } from '@breakfastdapaidang/saki-host-api/wire'
import type { PlanningSnapshot } from '../src/client/planning-controller.ts'
import { WorkController } from '../src/client/work-controller.ts'
import { createWorkStore } from '../src/client/work-state.ts'
import { AUTH, BOARD, ITEM, PROJECT_ID, successfulMove } from './planning-fixture.client.ts'

export const WORK_INDEX = sakiProjectIndexResultSchema.parse({ ok: true, projection: {
  type: 'project-index', revision: 1, hosts: [], projects: [{ id: PROJECT_ID, revision: 2, projectTitle: 'Project Alpha', binding: {
    id: 'binding-0a1b2c3d-0000-4000-8000-000000000001', revision: 1, health: 'active', hostId: 'host-0a1b2c3d-0000-4000-8000-000000000001',
    displayLocation: 'alpha', objectFormat: 'sha1', head: { kind: 'commit', objectId: 'a'.repeat(40), symbolicRef: 'refs/heads/main' },
    inheritedChangeEntryCount: 2, baseline: 'complete', automaticMutationEligible: false, configurationGaps: [],
  } }],
} })
export const MY_WORK = sakiMyWorkResultSchema.parse({ ok: true, projection: { type: 'my-work', principalId: AUTH.principal.id, items: [{
  project: { id: PROJECT_ID, title: 'Project Alpha' }, workItem: { id: ITEM.id, title: ITEM.title, issueNumber: ITEM.issueNumber, status: ITEM.status, updatedAt: ITEM.updatedAt },
  group: 'ready-to-start', returnAddress: { kind: 'work-item', projectId: PROJECT_ID, workItemId: ITEM.id }, recommendation: {
    available: true, offer: { type: 'give-work-item-to-agent', projectId: PROJECT_ID, workItemId: ITEM.id, expectedProjectRevision: 2, expectedRemoteFingerprint: ITEM.remoteFingerprint, reason: 'ready-for-agent', launch: {
      profileId: 'agent-profile-0a1b2c3d-0000-4000-8000-000000000001', profileVersion: 1, provider: 'deepseek', model: 'deepseek-chat', bindingId: 'binding-0a1b2c3d-0000-4000-8000-000000000001', bindingRevision: 1, displayLocation: 'alpha', inheritedChangeEntryCount: 2,
    } },
  },
}] } })
export const WORK_BOARD = { ...BOARD, effectiveMutationAvailability: { available: true as const, reasons: [] as const }, mapping: { state: 'valid' as const, configurationRevision: 3, validatedAt: 1 } }
type Api = ConstructorParameters<typeof WorkController>[0]
export function workFixture(interaction = createWorkStore().create()) {
  const authority = createSnapshotStore<PlanningSnapshot>({ access: AUTH, offline: false, project: null })
  const api = {
    queryMyWork: vi.fn<Api['queryMyWork']>().mockResolvedValue(MY_WORK),
    queryProjectIndex: vi.fn<Api['queryProjectIndex']>().mockResolvedValue(WORK_INDEX),
    queryBoard: vi.fn<Api['queryBoard']>().mockResolvedValue({ ok: true, projection: WORK_BOARD }),
    watchProjections: vi.fn<Api['watchProjections']>().mockImplementation(async (_cursor, signal) => await new Promise((_, reject) => {
      if (signal?.aborted) { reject(new Error('watch aborted')); return }
      signal?.addEventListener('abort', () => { reject(new Error('watch aborted')) }, { once: true })
    })),
    createWorkItem: vi.fn<Api['createWorkItem']>().mockImplementation(async (intent) => {
      const moved = successfulMove({ type: 'move-work-item', intentId: intent.intentId, projectId: intent.projectId, workItemId: ITEM.id, expectedRemoteFingerprint: ITEM.remoteFingerprint, targetStatus: 'inbox' })
      if (!moved.ok) throw new Error('successfulMove must succeed')
      return { ok: true, receipt: { ...moved.receipt, type: 'create-work-item' } }
    }),
    giveWorkItemToAgent: vi.fn<Api['giveWorkItemToAgent']>().mockResolvedValue({ ok: false, reason: 'unavailable' }),
    answerIntervention: vi.fn<Api['answerIntervention']>().mockResolvedValue({ ok: false, reason: 'unavailable' }),
  } satisfies Api
  const access = {
    getSnapshot: () => authority.getSnapshot(), subscribe: (listener: () => void) => authority.subscribe(listener),
    reloadAccess: vi.fn(async () => {}),
  }
  const controller = new WorkController(api, access, interaction)
  return { api, authority, access, interaction, controller, start: async () => {
    controller.start()
    await vi.waitFor(() => { if (controller.getSnapshot().projects.value == null) throw new Error('Projects pending') })
  } }
}
