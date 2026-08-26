/**
 * Saki Web client plugin, browser half: registers the two top-level entries
 * (「工作」「项目」) into the shell's `sidebar.primary.action` list slot and
 * one takeover entry into the `main.surface` chain slot, owns the small
 * navigation store, and drives the Saki Host API client for access, Project
 * index, registration, and Development Workspace reads.
 *
 * Composition rules honored here: components are pure props; live business
 * facts arrive through the inject face (plain callbacks plus the reserved
 * hooks compartment); cross-plugin collaboration goes through slots and ctx
 * services only.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { SakiHostClient } from '@breakfastdapaidang/saki-host-api/client'
import { createSakiNavigationStore, surfaceTokenOf, type SakiNavigationActionsFace, type SakiSurface } from './navigation.ts'
import { en, NS, zh, type SakiKey } from './locales.ts'
import { SakiNavEntry } from './components/SakiNavEntry.tsx'
import { SakiSurfaceRoot } from './components/SurfaceRoot.tsx'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Browser half of the Saki Host API (provided by saki-host-api). */
    sakiHostClient: SakiHostClient
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Saki product copy. */
    saki: SakiKey
  }
}

/** Services the Saki client plugin requires. */
export const inject = ['slots', 'layout', 'sessions', 'locale', 'sakiHostClient']

/** Host callbacks the surface components receive through the inject face. */
export interface SakiHostFace {
  readAccess: SakiHostClient['readAccess']
  exchangeBootstrap: SakiHostClient['exchangeBootstrap']
  queryProjectIndex: SakiHostClient['queryProjectIndex']
  inspectProjectSelection: SakiHostClient['inspectProjectSelection']
  queryDevelopmentWorkspace: SakiHostClient['queryDevelopmentWorkspace']
  registerDevelopmentProject: SakiHostClient['registerDevelopmentProject']
}

type NavigationStore = ReturnType<ReturnType<typeof createSakiNavigationStore>['create']>['store']

/** Inject face shared by every Saki entry. */
export interface SakiInjected extends SakiHostFace {
  nav: SakiNavigationActionsFace
  hooks: { navigation: NavigationStore }
}

/**
 * Client plugin body: dictionaries, the shared navigation instance, the two
 * sidebar entries, the surface takeover entry, and the two-way sync between
 * Saki navigation and the shell's surface token.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'saki-web-ui: dictionaries')

  // One navigation instance for the whole apply (sidebar entries, the surface
  // entry, and the sync effects all share it).
  const navigation = createSakiNavigationStore().create()
  const injected: SakiInjected = {
    readAccess: signal => ctx.sakiHostClient.readAccess(signal),
    exchangeBootstrap: (secret, signal) => ctx.sakiHostClient.exchangeBootstrap(secret, signal),
    queryProjectIndex: signal => ctx.sakiHostClient.queryProjectIndex(signal),
    inspectProjectSelection: (hostId, directoryLocator, signal) =>
      ctx.sakiHostClient.inspectProjectSelection(hostId, directoryLocator, signal),
    queryDevelopmentWorkspace: (projectId, expectedRegistryRevision, signal) =>
      ctx.sakiHostClient.queryDevelopmentWorkspace(projectId, expectedRegistryRevision, signal),
    registerDevelopmentProject: (intent, requestToken, signal) =>
      ctx.sakiHostClient.registerDevelopmentProject(intent, requestToken, signal),
    nav: navigation.actions,
    hooks: { navigation: navigation.store },
  }

  // Nav state → shell surface token: the sidebar entries set the surface; the
  // shell elects the Saki entry through the main.surface chain.
  ctx.effect(() => {
    const publish = () => { ctx.layout.requestSurface(surfaceTokenOf(navigation.store.getSnapshot())) }
    const unsubscribe = navigation.store.subscribe(publish)
    publish()
    return () => {
      unsubscribe()
      // Leaving the bundle restores the conversation fallback.
      ctx.layout.requestSurface(null)
    }
  }, 'saki-web-ui: surface sync')

  // Selecting a session (the inherited Conversation navigation) hands the
  // surface back: the Saki surface clears and the fallback reappears.
  ctx.effect(() => {
    let wasCurrent = ctx.sessions.list.getSnapshot().current !== undefined
    const unsubscribe = ctx.sessions.list.subscribe(() => {
      const isCurrent = ctx.sessions.list.getSnapshot().current !== undefined
      if (isCurrent && !wasCurrent) navigation.actions.clearSurface()
      wasCurrent = isCurrent
    })
    return unsubscribe
  }, 'saki-web-ui: session fallback sync')

  const registerNavEntry = (surface: SakiSurface, id: string, order: number) =>
    ctx.slots.inject('sidebar.primary.action', () =>
      ctx.slots.register({
        name: 'sidebar.primary.action',
        id,
        order,
        locale: NS,
        inject: () => ({
          open: surface === 'work' ? navigation.actions.showWork : navigation.actions.showProject,
          sakiSurface: surface,
          hooks: { navigation: navigation.store },
        }),
      }, SakiNavEntry))

  registerNavEntry('work', 'saki-work', 0)
  registerNavEntry('project', 'saki-project', 10)

  ctx.slots.inject('main.surface', () =>
    ctx.slots.register({
      name: 'main.surface',
      locale: NS,
      inject: () => injected,
      select: (owner) => {
        if (owner.surfaceKey === 'saki:work') return { page: 'work' as const }
        if (owner.surfaceKey === 'saki:project') return { page: 'project' as const }
        return null
      },
    }, SakiSurfaceRoot))
}
