/** Wire-valid delivery evidence and independently held network calls for browser interaction tests. */
import { vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { sakiDeliveryWorkspaceResultSchema, sakiBranchDeliveryIntentResultSchema } from '@breakfastdapaidang/saki-host-api/wire'
import { DeliveryController, type DeliveryWorkspace } from '../src/client/delivery-controller.ts'
import { createDeliveryStore, type DeliveryIntent } from '../src/client/delivery-state.ts'
import type { ChangesSnapshot } from '../src/client/changes-controller.ts'
import type { PlanningProject, PlanningSnapshot } from '../src/client/planning-controller.ts'
import { AUTH, ITEM, PROJECT_ID } from './planning-fixture.client.ts'
import { CHANGES, CHANGES_PROJECT } from './changes-fixture.client.ts'
import { BRANCH } from './planning-evidence.client.ts'

if (!CHANGES.ok || !CHANGES.projection.result.ok) throw new Error('Expected complete Changes fixture')
const observation = CHANGES.projection.result.observation
const changesProjection = CHANGES.projection
const { acceptance: _acceptance, ...unaccepted } = BRANCH.delivery
export const DELIVERY = {
  ...BRANCH,
  delivery: { ...unaccepted, phase: 'draft' as const, target: { ...unaccepted.target,
    registryRevision: CHANGES.projection.registryRevision, projectRevision: CHANGES.projection.projectRevision,
    binding: { ...unaccepted.target.binding, id: observation.bindingId, revision: observation.bindingRevision },
  } },
  pullRequest: { current: { state: 'unobserved' as const } },
  ci: { current: { state: 'unobserved' as const } },
}
const target = DELIVERY.delivery.target
const allowed = { available: true, reasons: [] }
const parsed = sakiDeliveryWorkspaceResultSchema.parse({ ok: true, projection: {
  type: 'delivery-workspace', projectId: PROJECT_ID, workItemId: ITEM.id,
  selection: { expected: {
    deliveryRevision: DELIVERY.delivery.revision, registryRevision: target.registryRevision, projectRevision: target.projectRevision,
    binding: { id: target.binding.id, revision: target.binding.revision }, synchronizationRevision: target.synchronizationRevision,
    mappingRevision: target.mappingRevision, workItemRemoteFingerprint: ITEM.remoteFingerprint,
  }, target },
  branchDelivery: DELIVERY, pushCredentialHelper: 'git-credential-manager',
  association: { state: 'unique', pullRequest: BRANCH.pullRequest.confirmed!.fact, observedAt: 10 },
  actions: { save: allowed, push: allowed, create: allowed, associate: allowed, review: allowed, accept: allowed },
} })
if (!parsed.ok) throw new Error('Expected delivery workspace fixture')
export const DELIVERY_WORKSPACE: DeliveryWorkspace = parsed.projection
export const DELIVERY_PROJECT: PlanningProject = { ...CHANGES_PROJECT,
  address: { ...CHANGES_PROJECT.address, view: 'delivery', workItemId: ITEM.id },
  detail: { loading: false, failure: null, value: {
    type: 'work-item-view', projectId: PROJECT_ID, workItem: ITEM,
    body: { state: 'confirmed', markdown: 'Deliver the reviewed commit.', issueUpdatedAt: ITEM.updatedAt, observedAt: 1, matchesBoard: true },
    assignments: [], runs: [], interventions: [], branchDelivery: DELIVERY, milestones: [], activity: [], earlierActivity: false,
  } },
}
export function deliveryResult(intent: DeliveryIntent, state: 'pending' | 'succeeded' | 'failure' = 'succeeded') {
  return sakiBranchDeliveryIntentResultSchema.parse({ ok: state !== 'failure', ...(state === 'failure' ? { reason: 'unavailable' } : {}), receipt: {
    intentId: intent.intentId, deliveryId: DELIVERY.delivery.id, deliveryRevision: 3, state,
  } })
}
type Api = ConstructorParameters<typeof DeliveryController>[0]
export function deliveryFixture(interaction = createDeliveryStore().create()) {
  const authority = createSnapshotStore<PlanningSnapshot>({ access: AUTH, offline: false, project: DELIVERY_PROJECT })
  const changes = createSnapshotStore<ChangesSnapshot>({ read: { value: changesProjection, loading: false, failure: null },
    diff: { value: null, loading: false, failure: null }, selection: null,
    draft: { message: '', pending: null }, operation: null, confirmation: null, inputError: false })
  const planning = { ...authority, refresh: vi.fn<() => Promise<void>>().mockResolvedValue(undefined) }
  const api = {
    queryDeliveryWorkspace: vi.fn<Api['queryDeliveryWorkspace']>().mockResolvedValue({ ok: true, projection: DELIVERY_WORKSPACE }),
    saveBranchDelivery: vi.fn<Api['saveBranchDelivery']>().mockImplementation(async request => deliveryResult(request)),
    pushBranchDelivery: vi.fn<Api['pushBranchDelivery']>().mockImplementation(async request => deliveryResult(request)),
    createBranchDeliveryPullRequest: vi.fn<Api['createBranchDeliveryPullRequest']>().mockImplementation(async request => deliveryResult(request)),
    associateBranchDeliveryPullRequest: vi.fn<Api['associateBranchDeliveryPullRequest']>().mockImplementation(async request => deliveryResult(request)),
    markBranchDeliveryInReview: vi.fn<Api['markBranchDeliveryInReview']>().mockImplementation(async request => deliveryResult(request)),
    acceptBranchDelivery: vi.fn<Api['acceptBranchDelivery']>().mockImplementation(async request => deliveryResult(request)),
  } satisfies Api
  const controller = new DeliveryController(api, planning, changes, interaction)
  return { api, controller, authority, planning, changes, interaction, start: async () => {
    controller.start(); await vi.waitFor(() => { expectRead(controller.getSnapshot().read.loading) })
  } }
}
function expectRead(loading: boolean): void { if (loading) throw new Error('Delivery workspace is still loading') }
