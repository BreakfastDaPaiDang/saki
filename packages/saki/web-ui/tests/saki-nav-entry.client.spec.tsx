// @vitest-environment jsdom
/**
 * SakiNavEntry row behavior: label and icon per surface, active projection
 * from the shared navigation store (test-sanctioned factory + .create()),
 * rail form hiding the label, and the open action. Props are fed directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { SakiNavEntry } from '../src/client/components/SakiNavEntry.tsx'
import { createSakiNavigationStore } from '../src/client/navigation.ts'
import { zh, NS } from '../src/client/locales.ts'

afterEach(() => { cleanup() })
beforeEach(() => { localStorage.clear() })

const t = ((key: string) => (zh as Record<string, string>)[key] ?? key) as TranslateNS<typeof NS>

// The component never reads the global hooks, but they ride the standard
// props share; stub them as never-called functions.
const neverHook = (() => { throw new Error('SakiNavEntry must not read global hooks') }) as never

/** Test-local selector hook over the real navigation store instance. */
function navigationHook() {
  const instance = createSakiNavigationStore().create()
  const subscribe = (listener: () => void) => instance.store.subscribe(listener)
  const getSnapshot = () => instance.store.getSnapshot()
  const useNavigation = <S,>(select: (state: ReturnType<typeof getSnapshot>) => S): S =>
    select(useSyncExternalStore(subscribe, getSnapshot))
  return { instance, useNavigation }
}

describe('SakiNavEntry', () => {
  it('renders the wide 「工作」 row, marks it current when elected, and opens on click', () => {
    const { instance, useNavigation } = navigationHook()
    const open = vi.fn()
    render(<SakiNavEntry wide={true} open={open} sakiSurface="work" useNavigation={useNavigation} useSessions={neverHook} useWorkspaces={neverHook} t={t} />)
    const entry = screen.getByRole('button', { name: '工作' })
    expect(entry.textContent).toContain('▤')
    expect(entry.textContent).toContain('工作')
    expect(entry.getAttribute('aria-current')).toBeNull()
    act(() => { instance.actions.showWork() })
    expect(screen.getByRole('button', { name: '工作' }).getAttribute('aria-current')).toBe('page')
    act(() => { instance.actions.showProject() })
    expect(screen.getByRole('button', { name: '工作' }).getAttribute('aria-current')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '工作' }))
    expect(open).toHaveBeenCalledOnce()
  })

  it('renders the collapsed 「项目」 rail without the label and tracks the project surface', () => {
    const { instance, useNavigation } = navigationHook()
    const open = vi.fn()
    render(<SakiNavEntry wide={false} open={open} sakiSurface="project" useNavigation={useNavigation} useSessions={neverHook} useWorkspaces={neverHook} t={t} />)
    const entry = screen.getByRole('button', { name: '项目' })
    expect(entry.textContent).toBe('▦')
    act(() => { instance.actions.showProject() })
    expect(screen.getByRole('button', { name: '项目' }).getAttribute('aria-current')).toBe('page')
    fireEvent.click(screen.getByRole('button', { name: '项目' }))
    expect(open).toHaveBeenCalledOnce()
  })
})
