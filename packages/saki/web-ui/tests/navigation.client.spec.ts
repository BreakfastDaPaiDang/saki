// @vitest-environment jsdom
/**
 * Navigation store account: surface actions, Project selection memory,
 * persistence, and the shell-token mapping. Uses the test-sanctioned engine
 * path: factory self-call + .create() gives the real instance.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createSakiNavigationStore, surfaceTokenOf } from '../src/client/navigation.ts'
import type { SakiWireProjectId } from '@breakfastdapaidang/saki-host-api/wire'

const PROJECT_A = 'project-0a1b2c3d-0000-4000-8000-00000000000a' as SakiWireProjectId
const PROJECT_B = 'project-0a1b2c3d-0000-4000-8000-00000000000b' as SakiWireProjectId

beforeEach(() => { localStorage.clear() })

describe('createSakiNavigationStore', () => {
  it('starts on the conversation fallback (null surface)', () => {
    const { store } = createSakiNavigationStore().create()
    expect(store.getSnapshot()).toEqual({ surface: null, projectId: null, lastProjectId: null })
    expect(surfaceTokenOf(store.getSnapshot())).toBeNull()
  })

  it('showWork/showProject map to the shell surface token', () => {
    const { store, actions } = createSakiNavigationStore().create()
    actions.showWork()
    expect(surfaceTokenOf(store.getSnapshot())).toBe('saki:work')
    actions.showProject()
    expect(surfaceTokenOf(store.getSnapshot())).toBe('saki:project')
    actions.clearSurface()
    expect(surfaceTokenOf(store.getSnapshot())).toBeNull()
  })

  it('selectProject remembers the project and restores it on the next project surface', () => {
    const { store, actions } = createSakiNavigationStore().create()
    actions.selectProject(PROJECT_A)
    expect(store.getSnapshot().projectId).toBe(PROJECT_A)
    actions.clearProject()
    actions.showProject()
    expect(store.getSnapshot().projectId).toBe(PROJECT_A)
    actions.selectProject(PROJECT_B)
    actions.showWork()
    actions.showProject()
    expect(store.getSnapshot().projectId).toBe(PROJECT_B)
  })

  it('persists the surface and selection across instances', () => {
    const first = createSakiNavigationStore().create()
    first.actions.selectProject(PROJECT_A)
    const second = createSakiNavigationStore().create()
    expect(second.store.getSnapshot().projectId).toBe(PROJECT_A)
    expect(second.store.getSnapshot().surface).toBe('project')
    second.actions.clearSurface()
    const third = createSakiNavigationStore().create()
    expect(third.store.getSnapshot().surface).toBeNull()
  })
})
