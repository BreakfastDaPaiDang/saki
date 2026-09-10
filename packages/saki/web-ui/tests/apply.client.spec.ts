// @vitest-environment jsdom
/**
 * saki-web-ui apply wiring: dictionaries, the two sidebar entries, the
 * main.surface chain entry, the navigation→shell-token sync, the
 * gesture-driven Session-navigation hand-back, reload restore, and teardown
 * cleanup.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '@breakfastdapaidang/saki-web-ui/client'
import { apply as hostApply } from '../src/index.ts'

const contexts = new Set<Context>()
afterEach(async () => { await Promise.all([...contexts].map(ctx => ctx.fiber.dispose())); contexts.clear() })

interface NavigationSnapshot {
  surface: 'work' | 'project' | null
  projectId: string | null
  lastProjectId: string | null
}

function fakeHostClient() {
  return {
    readAccess: vi.fn(async () => ({ kind: 'bootstrap-required' as const, message: 'Local bootstrap is required.' })),
    exchangeBootstrap: vi.fn(async () => ({ ok: false as const, reason: 'unavailable' as const })),
    queryProjectIndex: vi.fn(),
    inspectProjectSelection: vi.fn(),
    queryDevelopmentWorkspace: vi.fn(),
    registerDevelopmentProject: vi.fn(),
  }
}

async function bench() {
  const ctx = new Context()
  contexts.add(ctx)
  await ctx.plugin(SlotRegistry).await()
  const layout = { requestSurface: vi.fn(), toggleSidebar: vi.fn(), openDetails: vi.fn(), closeDetails: vi.fn() }
  const sessionsList = createSnapshotStore<{ current: string | undefined }>({ current: undefined })
  const sessions = { list: sessionsList }
  // The Workspace navigation face, reduced to its gesture signal; firing the
  // recorded listeners replays a user Session-navigation gesture.
  const navigationListeners = new Set<() => void>()
  const uiWorkspace = {
    onSessionNavigation: vi.fn((listener: () => void) => {
      navigationListeners.add(listener)
      return () => { navigationListeners.delete(listener) }
    }),
  }
  const emitSessionNavigation = () => { for (const listener of [...navigationListeners]) listener() }
  const hostClient = fakeHostClient()
  ctx.provide('layout', layout as never)
  ctx.provide('sessions', sessions as never)
  ctx.provide('uiWorkspace', uiWorkspace as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('sakiHostClient', hostClient as never)
  const slots = ctx.get('slots') as SlotRegistry
  // The shell owns the slots we inject into.
  slots.register(
    {
      name: 'root',
      children: {
        'sidebar': { kind: 'single', scope: 'root' },
        'main.surface': { kind: 'chain', scope: 'root' },
      },
    } as never,
    () => null,
  )
  slots.register({ name: 'sidebar', children: { 'sidebar.primary.action': { kind: 'list', scope: 'root' } } } as never, () => null)
  return { ctx, slots, layout, sessionsList, uiWorkspace, navigationListeners, emitSessionNavigation, hostClient }
}

beforeEach(() => {
  localStorage.clear()
})

describe('saki-web-ui apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'layout', 'uiWorkspace', 'locale', 'sakiHostClient'])
  })

  it('registers both sidebar entries and the surface chain entry', async () => {
    const { ctx, slots } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    const navEntries = slots.entries('sidebar.primary.action')
    expect(navEntries.map(entry => entry.options.id)).toEqual(['saki-work', 'saki-project'])
    const surfaceEntries = slots.entries('main.surface')
    expect(surfaceEntries).toHaveLength(1)
    const select = surfaceEntries[0]!.select as (owner: { surfaceKey: string | null }) => unknown
    expect(select({ surfaceKey: 'saki:work' })).toEqual({ page: 'work' })
    expect(select({ surfaceKey: 'saki:project' })).toEqual({ page: 'project' })
    expect(select({ surfaceKey: null })).toBeNull()
    expect(select({ surfaceKey: 'other:thing' })).toBeNull()
  })

  it('publishes the surface token from navigation state', async () => {
    const { ctx, slots, layout } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    expect(layout.requestSurface).toHaveBeenLastCalledWith(null)

    // Drive the shared navigation store through a sidebar entry's inject face.
    const workEntry = slots.entries('sidebar.primary.action')[0]!
    const face = (workEntry.inject as () => { open: () => void })()
    face.open()
    expect(layout.requestSurface).toHaveBeenLastCalledWith('saki:work')
  })

  it('clears the elected Saki surface on a user Session navigation gesture', async () => {
    const { ctx, slots, layout, emitSessionNavigation } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    const face = (slots.entries('sidebar.primary.action')[0]!.inject as () => {
      open: () => void
      hooks: { navigation: { getSnapshot: () => NavigationSnapshot } }
    })()
    face.open()
    expect(layout.requestSurface).toHaveBeenLastCalledWith('saki:work')

    // The Workspace navigation face reports the gesture: the center column
    // returns to the Conversation fallback. The Project selection is kept, so
    // re-entering 项目 reopens where the user left off.
    emitSessionNavigation()
    expect(face.hooks.navigation.getSnapshot().surface).toBeNull()
    expect(layout.requestSurface).toHaveBeenLastCalledWith(null)
  })

  it('keeps the Conversation fallback when a gesture arrives with no surface elected', async () => {
    const { ctx, layout, emitSessionNavigation } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    emitSessionNavigation()
    expect(layout.requestSurface).toHaveBeenLastCalledWith(null)
    expect(layout.requestSurface).toHaveBeenCalledTimes(1)
  })

  it('never moves the Saki surface on sessions-layer elections (startup auto-connect, selection restore)', async () => {
    const { ctx, slots, layout, sessionsList } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    const face = (slots.entries('sidebar.primary.action')[0]!.inject as () => {
      open: () => void
      hooks: { navigation: { getSnapshot: () => NavigationSnapshot } }
    })()
    face.open()
    expect(layout.requestSurface).toHaveBeenLastCalledWith('saki:work')

    // The shell's startup Workspace auto-connect and the persisted-selection
    // restore present exactly like this at the sessions layer: `current`
    // appears with no user gesture behind it. The plugin subscribes to no
    // sessions-layer signal, so the elected page survives both.
    sessionsList.update((draft) => { draft.current = 'session-1' })
    expect(face.hooks.navigation.getSnapshot().surface).toBe('work')
    expect(layout.requestSurface).toHaveBeenLastCalledWith('saki:work')
    sessionsList.update((draft) => { draft.current = 'session-2' })
    expect(face.hooks.navigation.getSnapshot().surface).toBe('work')
    expect(layout.requestSurface).toHaveBeenLastCalledWith('saki:work')
  })

  it('leaves the Conversation fallback untouched when a session becomes current with no surface elected', async () => {
    const { ctx, slots, layout, sessionsList } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    const face = (slots.entries('sidebar.primary.action')[0]!.inject as () => {
      hooks: { navigation: { getSnapshot: () => NavigationSnapshot } }
    })()
    sessionsList.update((draft) => { draft.current = 'session-1' })
    expect(layout.requestSurface).toHaveBeenLastCalledWith(null)
    expect(face.hooks.navigation.getSnapshot().surface).toBeNull()
  })

  it('restores the persisted Saki surface on a fresh apply (browser reload)', async () => {
    const first = await bench()
    await first.ctx.plugin({ inject: [...inject], apply }).await()
    const face = (first.slots.entries('sidebar.primary.action')[1]!.inject as () => { open: () => void })()
    face.open()
    expect(first.layout.requestSurface).toHaveBeenLastCalledWith('saki:project')

    // A reload is a fresh plugin apply over the same localStorage: the
    // persisted surface republishes before any gesture or election lands.
    const second = await bench()
    await second.ctx.plugin({ inject: [...inject], apply }).await()
    expect(second.layout.requestSurface).toHaveBeenLastCalledWith('saki:project')
    // The startup auto-connect landing on top of the restore leaves it in place.
    second.sessionsList.update((draft) => { draft.current = 'session-1' })
    expect(second.layout.requestSurface).toHaveBeenLastCalledWith('saki:project')
  })

  it('removes the entries, the gesture listener, and clears the surface token on teardown', async () => {
    const { ctx, slots, layout, navigationListeners, emitSessionNavigation } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const face = (slots.entries('sidebar.primary.action')[0]!.inject as () => { open: () => void })()
    face.open()
    expect(layout.requestSurface).toHaveBeenLastCalledWith('saki:work')
    expect(navigationListeners.size).toBe(1)
    await fiber.dispose()
    expect(slots.entries('sidebar.primary.action')).toHaveLength(0)
    expect(slots.entries('main.surface')).toHaveLength(0)
    expect(layout.requestSurface).toHaveBeenLastCalledWith(null)
    expect(navigationListeners.size).toBe(0)
    const calls = layout.requestSurface.mock.calls.length
    emitSessionNavigation()
    expect(layout.requestSurface).toHaveBeenCalledTimes(calls)
  })

  it('opens the project surface from the project sidebar entry', async () => {
    const { ctx, slots, layout } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    const face = (slots.entries('sidebar.primary.action')[1]!.inject as () => { open: () => void })()
    face.open()
    expect(layout.requestSurface).toHaveBeenLastCalledWith('saki:project')
  })

  it('delegates every surface-face read to the host client with the exact arguments', async () => {
    const { ctx, slots, layout, hostClient } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    const face = (slots.entries('main.surface')[0]!.inject as () => {
      readAccess: (signal?: AbortSignal) => unknown
      exchangeBootstrap: (secret: string, signal?: AbortSignal) => unknown
      queryProjectIndex: (signal?: AbortSignal) => unknown
      inspectProjectSelection: (hostId: string, directoryLocator: string, signal?: AbortSignal) => unknown
      queryDevelopmentWorkspace: (projectId: string, expectedRegistryRevision: number, signal?: AbortSignal) => unknown
      registerDevelopmentProject: (intent: unknown, requestToken: string, signal?: AbortSignal) => unknown
      nav: { showWork: () => void }
    })()
    const signal = new AbortController().signal
    face.readAccess(signal)
    expect(hostClient.readAccess).toHaveBeenCalledWith(signal)
    await face.exchangeBootstrap('secret-1', signal)
    expect(hostClient.exchangeBootstrap).toHaveBeenCalledWith('secret-1', expect.any(AbortSignal))
    face.queryProjectIndex(signal)
    expect(hostClient.queryProjectIndex).toHaveBeenCalledWith(signal)
    face.inspectProjectSelection('host-1', 'D:\\p', signal)
    expect(hostClient.inspectProjectSelection).toHaveBeenCalledWith('host-1', 'D:\\p', signal)
    face.queryDevelopmentWorkspace('project-1', 3, signal)
    expect(hostClient.queryDevelopmentWorkspace).toHaveBeenCalledWith('project-1', 3, signal)
    const intent = { type: 'register-development-project' }
    face.registerDevelopmentProject(intent, 'token-1', signal)
    expect(hostClient.registerDevelopmentProject).toHaveBeenCalledWith(intent, 'token-1', signal)
    // The face's nav is the shared navigation instance wired to the shell sync.
    face.nav.showWork()
    expect(layout.requestSurface).toHaveBeenLastCalledWith('saki:work')
  })
})

describe('saki-web-ui host half', () => {
  it('is a deliberate no-op: the browser half ships via exports["./client"]', () => {
    expect(() => { hostApply() }).not.toThrow()
  })
})
