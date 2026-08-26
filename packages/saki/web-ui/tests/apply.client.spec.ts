// @vitest-environment jsdom
/**
 * saki-web-ui apply wiring: dictionaries, the two sidebar entries, the
 * main.surface chain entry, the navigation→shell-token sync, the
 * session-selection hand-back, and teardown cleanup.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry, createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '@breakfastdapaidang/saki-web-ui/client'

interface NavigationSnapshot {
  surface: 'work' | 'project' | null
  projectId: string | null
  lastProjectId: string | null
}

function fakeHostClient() {
  return {
    readAccess: vi.fn(async () => ({ kind: 'bootstrap-required' as const, message: 'Local bootstrap is required.' })),
    exchangeBootstrap: vi.fn(),
    queryProjectIndex: vi.fn(),
    inspectProjectSelection: vi.fn(),
    queryDevelopmentWorkspace: vi.fn(),
    registerDevelopmentProject: vi.fn(),
  }
}

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const layout = { requestSurface: vi.fn(), toggleSidebar: vi.fn(), openDetails: vi.fn(), closeDetails: vi.fn() }
  const sessionsList = createSnapshotStore<{ current: string | undefined }>({ current: undefined })
  const sessions = { list: sessionsList }
  const hostClient = fakeHostClient()
  ctx.provide('layout', layout as never)
  ctx.provide('sessions', sessions as never)
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
  return { ctx, slots, layout, sessionsList, hostClient }
}

beforeEach(() => {
  localStorage.clear()
})

describe('saki-web-ui apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'layout', 'sessions', 'locale', 'sakiHostClient'])
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

  it('publishes the surface token from navigation state and clears it on session selection', async () => {
    const { ctx, slots, layout, sessionsList } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    expect(layout.requestSurface).toHaveBeenLastCalledWith(null)

    // Drive the shared navigation store through a sidebar entry's inject face.
    const workEntry = slots.entries('sidebar.primary.action')[0]!
    const face = (workEntry.inject as () => { open: () => void; hooks: { navigation: { getSnapshot: () => NavigationSnapshot } } })()
    face.open()
    expect(layout.requestSurface).toHaveBeenLastCalledWith('saki:work')

    // A session becoming current hands the surface back to the fallback.
    sessionsList.update((draft) => { draft.current = 'session-1' })
    expect(layout.requestSurface).toHaveBeenLastCalledWith(null)
    expect(face.hooks.navigation.getSnapshot().surface).toBeNull()
  })

  it('removes the entries and clears the surface token on teardown', async () => {
    const { ctx, slots, layout } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const face = (slots.entries('sidebar.primary.action')[0]!.inject as () => { open: () => void })()
    face.open()
    expect(layout.requestSurface).toHaveBeenLastCalledWith('saki:work')
    await fiber.dispose()
    expect(slots.entries('sidebar.primary.action')).toHaveLength(0)
    expect(slots.entries('main.surface')).toHaveLength(0)
    expect(layout.requestSurface).toHaveBeenLastCalledWith(null)
  })
})
