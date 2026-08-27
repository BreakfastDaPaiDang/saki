/**
 * Saki navigation state: which top-level Saki surface is active and which
 * Development Project the 「项目」 page addresses. One instance is created in
 * apply and shared through the inject faces' hooks compartment, so sidebar
 * entries and the surface entry see the same snapshot; it persists so a
 * browser reload restores the exact surface and Project. The token handed to
 * the shell (`ctx.layout.requestSurface`) is derived from this state — never
 * the other way around.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { SakiWireProjectId } from '@breakfastdapaidang/saki-host-api/wire'

/** The two Saki top-level surfaces; null means the shell's Conversation fallback. */
export type SakiSurface = 'work' | 'project'

/** Navigation snapshot: the elected surface plus the Project the 「项目」 page addresses. */
export interface SakiNavigationState {
  /** Active top-level Saki surface; null renders the shell's Conversation fallback. */
  surface: SakiSurface | null
  /** The project shown by the 「项目」 page; null renders the Project selector. */
  projectId: SakiWireProjectId | null
  /** Last opened project, so 「项目」 reopens where the user left off. */
  lastProjectId: SakiWireProjectId | null
}

type SakiNavigationActions = {
  showWork: (d: SakiNavigationState) => void
  showProject: (d: SakiNavigationState) => void
  selectProject: (d: SakiNavigationState, projectId: SakiWireProjectId) => void
  clearProject: (d: SakiNavigationState) => void
  clearSurface: (d: SakiNavigationState) => void
}

/**
 * Create the navigation store handle (factory, not an instance).
 * @returns the store handle whose `create()` yields the shared navigation store.
 */
export function createSakiNavigationStore(): EngineStoreHandle<SakiNavigationState, SakiNavigationActions> {
  return defineStore({
    init: (): SakiNavigationState => ({ surface: null, projectId: null, lastProjectId: null }),
    persist: 'saki.navigation',
    actions: {
      showWork: (d) => { d.surface = 'work' },
      showProject: (d) => {
        d.surface = 'project'
        if (d.projectId === null) d.projectId = d.lastProjectId
      },
      selectProject: (d, projectId: SakiWireProjectId) => {
        d.surface = 'project'
        d.projectId = projectId
        d.lastProjectId = projectId
      },
      clearProject: (d) => { d.projectId = null },
      clearSurface: (d) => { d.surface = null },
    },
  })
}

/** Bound action face the components receive (framework-baked actions). */
export type SakiNavigationActionsFace = ReturnType<ReturnType<typeof createSakiNavigationStore>['create']>['actions']

/**
 * Map the navigation state to the generic shell surface token.
 * @param state - current navigation snapshot.
 * @returns the `saki:<surface>` token, or null for the Conversation fallback.
 */
export function surfaceTokenOf(state: SakiNavigationState): string | null {
  return state.surface === null ? null : `saki:${state.surface}`
}
