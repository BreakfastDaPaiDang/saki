// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest'
import { sakiConfigureGitHubSynchronizationIntentSchema } from '@breakfastdapaidang/saki-host-api/wire'
import { createPlanningStore, initialPlanningAddress, type MilestoneId } from '../src/client/planning-state.ts'
import { AUTH, MAPPING_PATCH, PROJECT_ID } from './planning-fixture.client.ts'

beforeEach(() => { localStorage.clear() })

it('restores viewing choices and exact mapping Intents inside their Principal scope', () => {
  const state = createPlanningStore().create()
  const address = { ...initialPlanningAddress(), view: 'milestone' as const, milestoneId: 'M_release' as MilestoneId }
  state.actions.address(AUTH.principal.id, PROJECT_ID, address)
  const intent = sakiConfigureGitHubSynchronizationIntentSchema.parse({
    type: 'configure-github-synchronization', intentId: 'intent-00000000-0000-4000-8000-000000000001',
    projectId: PROJECT_ID, expectedSynchronizationRevision: 7, patch: MAPPING_PATCH,
  })
  state.actions.mapping(AUTH.principal.id, intent)
  const restored = createPlanningStore().create()
  restored.actions.hydrate(JSON.parse(JSON.stringify(state.store.getSnapshot())))
  expect(restored.store.getSnapshot().scopes[AUTH.principal.id]).toMatchObject({
    addresses: { [PROJECT_ID]: address }, pendingMapping: { [PROJECT_ID]: intent },
  })
  restored.actions.forgetMapping('different-principal', PROJECT_ID)
  expect(restored.store.getSnapshot().scopes[AUTH.principal.id]?.pendingMapping[PROJECT_ID]).toEqual(intent)
  restored.actions.forgetMapping(AUTH.principal.id, PROJECT_ID)
  expect(restored.store.getSnapshot().scopes[AUTH.principal.id]?.pendingMapping).toEqual({})
})

it('rejects malformed persisted data and never hydrates authoritative business facts', () => {
  const state = createPlanningStore().create()
  state.actions.address(AUTH.principal.id, PROJECT_ID, initialPlanningAddress())
  const invalid = { ...state.store.getSnapshot(), confirmedBoard: { status: 'done' } }
  state.actions.hydrate(invalid)
  expect(state.store.getSnapshot()).toEqual({ scopes: {} })
  state.actions.hydrate({ scopes: { [AUTH.principal.id]: { addresses: {}, pendingMoves: { bad: {} }, pendingMapping: {} } } })
  expect(state.store.getSnapshot()).toEqual({ scopes: {} })
  state.actions.forgetMove(AUTH.principal.id, 'missing')
  expect(state.store.getSnapshot()).toEqual({ scopes: {} })
})
