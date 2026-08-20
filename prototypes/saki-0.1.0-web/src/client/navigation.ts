import type { ProjectSection, SakiViewAddress } from '../contract/types'
import { createStore } from './store'

export type { ProjectSection, SakiViewAddress }

/**
 * Navigation owns typed SakiViewAddress values. Addresses serialize to the
 * URL hash (shareable, reload-proof) and persist to localStorage so a reload
 * without a hash restores the last location. The Settings dialog remembers
 * the address it was opened from and returns there.
 */

const STORAGE_KEY = 'saki-proto-address'

export interface NavState {
  address: SakiViewAddress
  /** The address Settings was opened from; close returns here. */
  settingsFrom: SakiViewAddress | null
}

function serialize(address: SakiViewAddress): string {
  switch (address.kind) {
    case 'conversation':
      return address.sessionId ? `#/conversation/${address.sessionId}` : '#/conversation'
    case 'new-session':
      return '#/new-session'
    case 'my-work':
      return '#/work'
    case 'projects':
      return '#/projects'
    case 'settings':
      return `#/settings/${address.section}`
    case 'bootstrap':
      return '#/bootstrap'
    case 'work':
    case 'milestones':
    case 'changes':
    case 'sessions':
    case 'trace':
    case 'project-settings': {
      const params = new URLSearchParams()
      if (address.kind === 'work') {
        if (address.workItemId) params.set('item', address.workItemId)
        if (address.board?.milestoneId) params.set('milestone', address.board.milestoneId)
      }
      if (address.kind === 'milestones' && address.milestoneId) params.set('milestone', address.milestoneId)
      if (address.kind === 'changes' && address.file) params.set('file', address.file)
      if (address.kind === 'sessions') {
        if (address.workSessionId) params.set('session', address.workSessionId)
        if (address.agentRunId) params.set('run', address.agentRunId)
      }
      if (address.kind === 'trace' && address.workItemId) params.set('item', address.workItemId)
      const q = params.toString()
      return `#/project/${address.projectId}/${address.kind}${q ? `?${q}` : ''}`
    }
  }
}

function parse(hash: string): SakiViewAddress | null {
  const raw = hash.replace(/^#/, '')
  if (!raw) return null
  const [pathPart, queryPart] = raw.split('?')
  const segments = pathPart.split('/').filter(Boolean)
  const params = new URLSearchParams(queryPart ?? '')
  if (segments[0] === 'conversation') return { kind: 'conversation', sessionId: segments[1] ?? null }
  if (segments[0] === 'new-session') return { kind: 'new-session' }
  if (segments[0] === 'work') return { kind: 'my-work' }
  if (segments[0] === 'projects') return { kind: 'projects' }
  if (segments[0] === 'settings') return { kind: 'settings', section: segments[1] ?? 'general' }
  if (segments[0] === 'bootstrap') return { kind: 'bootstrap' }
  if (segments[0] === 'project' && segments[1]) {
    const section = (segments[2] ?? 'work') as ProjectSection
    const projectId = segments[1]
    switch (section) {
      case 'work':
        return { kind: 'work', projectId, workItemId: params.get('item') ?? undefined, board: params.get('milestone') ? { milestoneId: params.get('milestone')! } : undefined }
      case 'milestones':
        return { kind: 'milestones', projectId, milestoneId: params.get('milestone') ?? undefined }
      case 'changes':
        return { kind: 'changes', projectId, file: params.get('file') ?? undefined }
      case 'sessions':
        return { kind: 'sessions', projectId, workSessionId: params.get('session') ?? undefined, agentRunId: params.get('run') ?? undefined }
      case 'trace':
        return { kind: 'trace', projectId, workItemId: params.get('item') ?? undefined }
      case 'project-settings':
        return { kind: 'project-settings', projectId }
      default:
        return { kind: 'work', projectId }
    }
  }
  return null
}

function loadInitial(): SakiViewAddress {
  const fromHash = parse(window.location.hash)
  if (fromHash) return fromHash
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY)
    if (saved) {
      const parsed = JSON.parse(saved) as SakiViewAddress
      if (parsed && typeof parsed.kind === 'string') return parsed
    }
  } catch {
    // Corrupted prototype storage is safe to ignore; fall back to My Work.
  }
  return { kind: 'my-work' }
}

export const navStore = createStore<NavState>({ address: loadInitial(), settingsFrom: null })

export function navigate(address: SakiViewAddress, options?: { replace?: boolean }): void {
  const hash = serialize(address)
  const current = navStore.getSnapshot()
  // Opening Settings records the owning address so close returns there.
  const settingsFrom = address.kind === 'settings' ? (current.address.kind === 'settings' ? current.settingsFrom : current.address) : current.settingsFrom
  if (options?.replace) {
    history.replaceState(null, '', hash)
  } else {
    history.pushState(null, '', hash)
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(address))
  } catch {
    // Storage may be unavailable in private contexts; navigation still works.
  }
  navStore.set({ address, settingsFrom })
}

/** Close the Settings dialog, returning to the address it was opened from. */
export function closeSettings(): void {
  const { settingsFrom } = navStore.getSnapshot()
  navigate(settingsFrom ?? { kind: 'my-work' })
}

window.addEventListener('popstate', () => {
  const address = parse(window.location.hash)
  if (address) navStore.update((current) => ({ ...current, address }))
})

/** Project 页内部区段与 address kind 的映射。 */
export const projectSections: { kind: ProjectSection; label: string }[] = [
  { kind: 'work', label: '看板' },
  { kind: 'milestones', label: '里程碑' },
  { kind: 'changes', label: '变更' },
  { kind: 'sessions', label: '会话与运行' },
  { kind: 'trace', label: '追溯' },
  { kind: 'project-settings', label: '项目设置' },
]

export function projectAddress(projectId: string, section: ProjectSection): SakiViewAddress {
  switch (section) {
    case 'work':
      return { kind: 'work', projectId }
    case 'milestones':
      return { kind: 'milestones', projectId }
    case 'changes':
      return { kind: 'changes', projectId }
    case 'sessions':
      return { kind: 'sessions', projectId }
    case 'trace':
      return { kind: 'trace', projectId }
    case 'project-settings':
      return { kind: 'project-settings', projectId }
  }
}
