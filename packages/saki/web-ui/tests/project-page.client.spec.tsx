// @vitest-environment jsdom
/**
 * 「项目」 page behavior: the selector's loading/empty/list/denied/unavailable/
 * offline states, the registration dialog round trip (refresh-before-open),
 * and the Development Workspace's revisioned read, confirmed facts, repair
 * evidence, refresh keeping confirmed values, and the stale/not-found exits.
 * Props are fed directly; nav is the real navigation store instance.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SakiWireHostId, SakiWireProjectId } from '@breakfastdapaidang/saki-host-api/wire'
import { ProjectPage } from '../src/client/components/ProjectPage.tsx'
import type { ProjectPageProps } from '../src/client/components/ProjectPage.tsx'
import { createSakiNavigationStore } from '../src/client/navigation.ts'
import { zh, NS } from '../src/client/locales.ts'

afterEach(() => { cleanup() })
beforeEach(() => { localStorage.clear() })

const t = ((key: string) => (zh as Record<string, string>)[key] ?? key) as TranslateNS<typeof NS>

const PROJECT_A = 'project-0a1b2c3d-0000-4000-8000-00000000000a' as SakiWireProjectId
const PROJECT_B = 'project-0a1b2c3d-0000-4000-8000-00000000000b' as SakiWireProjectId
const HOST = { id: 'host-0a1b2c3d-0000-4000-8000-000000000001' as SakiWireHostId, revision: 0, state: 'enrolled' as const }
const ACCESS = {
  kind: 'authenticated' as const,
  principal: { id: 'principal-0a1b2c3d-0000-4000-8000-000000000001', displayName: '你' },
  expiresAt: 1,
  requestToken: 'token-1',
}

interface SummaryOverrides {
  id?: SakiWireProjectId
  projectTitle?: string
  health?: 'active' | 'missing' | 'repair-required'
  detached?: boolean
  branch?: string
  head?: string
  inheritedChangeEntryCount?: number
  baseline?: 'complete' | 'unavailable'
  configurationGaps?: string[]
}

function summary(overrides: SummaryOverrides = {}) {
  const detached = overrides.detached ?? false
  const branch = detached ? undefined : (overrides.branch === undefined ? 'main' : overrides.branch)
  return {
    id: overrides.id ?? PROJECT_A,
    revision: 1,
    projectTitle: overrides.projectTitle ?? '示例项目',
    binding: {
      id: 'binding-0a1b2c3d-0000-4000-8000-000000000001',
      revision: 1,
      health: overrides.health ?? 'active',
      hostId: HOST.id,
      displayLocation: 'D:\\projects\\demo',
      head: overrides.head ?? 'a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e',
      ...(branch === undefined ? {} : { branch }),
      detached,
      inheritedChangeEntryCount: overrides.inheritedChangeEntryCount ?? 0,
      baseline: overrides.baseline ?? 'complete',
      automaticMutationEligible: (overrides.health ?? 'active') === 'active'
        && (overrides.inheritedChangeEntryCount ?? 0) === 0
        && (overrides.baseline ?? 'complete') === 'complete'
        && (overrides.configurationGaps ?? []).length === 0,
      configurationGaps: overrides.configurationGaps ?? [],
    },
  }
}

function indexResult(projects: ReturnType<typeof summary>[], revision = 3) {
  return { ok: true as const, projection: { type: 'project-index' as const, revision, hosts: [HOST], projects } }
}

function workspaceResult(project: ReturnType<typeof summary>, recovery?: { state: 'ready' | 'blocked'; reasons: string[] }) {
  return {
    ok: true as const,
    projection: {
      type: 'development-workspace' as const,
      registryRevision: 3,
      project,
      recovery: recovery ?? { state: 'ready' as const, reasons: [] },
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function bench(projectId: SakiWireProjectId | null) {
  const navigation = createSakiNavigationStore().create()
  const face = {
    queryProjectIndex: vi.fn(),
    inspectProjectSelection: vi.fn(),
    queryDevelopmentWorkspace: vi.fn(),
    registerDevelopmentProject: vi.fn(),
  }
  const props: ProjectPageProps = {
    access: ACCESS as ProjectPageProps['access'],
    projectId,
    queryProjectIndex: face.queryProjectIndex as never,
    inspectProjectSelection: face.inspectProjectSelection as never,
    queryDevelopmentWorkspace: face.queryDevelopmentWorkspace as never,
    registerDevelopmentProject: face.registerDevelopmentProject as never,
    nav: navigation.actions,
    t,
  }
  return { navigation, face, props }
}

describe('ProjectPage — Project selector', () => {
  it('loads the index and offers registration when no project is enrolled', async () => {
    const { face, props } = bench(null)
    const read = deferred<unknown>()
    face.queryProjectIndex.mockReturnValue(read.promise)
    render(<ProjectPage {...props} />)
    expect(screen.getByText('正在读取 Development Workspace…')).toBeTruthy()
    read.resolve(indexResult([]))
    await waitFor(() => { expect(screen.getByText('还没有登记任何 Development Project。')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '登记已有目录' }))
    expect(screen.getByRole('dialog', { name: '登记 Development Project' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('lists enrolled projects with their binding health and selects one on click', async () => {
    const { navigation, face, props } = bench(null)
    face.queryProjectIndex.mockResolvedValue(indexResult([
      summary(),
      summary({ id: PROJECT_B, projectTitle: '缺失目录', health: 'missing', configurationGaps: ['binding-missing'] }),
    ]))
    render(<ProjectPage {...props} />)
    await waitFor(() => { expect(screen.getByText('示例项目')).toBeTruthy() })
    expect(screen.getByText('缺失目录')).toBeTruthy()
    expect(screen.getAllByText('D:\\projects\\demo')).toHaveLength(2)
    expect(screen.getByText('已连接')).toBeTruthy()
    expect(screen.getByText('目录缺失')).toBeTruthy()
    fireEvent.click(screen.getByText('示例项目'))
    expect(navigation.store.getSnapshot().projectId).toBe(PROJECT_A)
    expect(navigation.store.getSnapshot().surface).toBe('project')
  })

  it('renders the denied notice without a retry when the index read is denied', async () => {
    const { face, props } = bench(null)
    face.queryProjectIndex.mockResolvedValue({ ok: false, reason: 'denied' })
    render(<ProjectPage {...props} />)
    await waitFor(() => { expect(screen.getByText('当前身份无权查看该项目。')).toBeTruthy() })
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('renders the unavailable notice and recovers through its retry', async () => {
    const { face, props } = bench(null)
    face.queryProjectIndex.mockResolvedValueOnce({ ok: false, reason: 'unavailable' })
    render(<ProjectPage {...props} />)
    await waitFor(() => { expect(screen.getByText('暂时不可用，请稍后重试。')).toBeTruthy() })
    face.queryProjectIndex.mockResolvedValue(indexResult([summary()]))
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => { expect(screen.getByText('示例项目')).toBeTruthy() })
    expect(face.queryProjectIndex).toHaveBeenCalledTimes(2)
  })

  it('renders the offline notice when the read rejects and recovers through its retry', async () => {
    const { face, props } = bench(null)
    face.queryProjectIndex.mockRejectedValueOnce(new Error('down'))
    render(<ProjectPage {...props} />)
    await waitFor(() => { expect(screen.getByText('连接已断开：显示最近一次已确认的状态。')).toBeTruthy() })
    face.queryProjectIndex.mockResolvedValue(indexResult([summary()]))
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => { expect(screen.getByText('示例项目')).toBeTruthy() })
    expect(face.queryProjectIndex).toHaveBeenCalledTimes(2)
  })

  it('refreshes the index before opening a registered project and keeps the list when the refresh fails', async () => {
    const { navigation, face, props } = bench(null)
    face.queryProjectIndex.mockResolvedValueOnce(indexResult([summary()]))
    face.inspectProjectSelection.mockResolvedValue({
      ok: true,
      projection: {
        type: 'inspect-project-selection',
        result: {
          ok: true,
          selection: {
            observationVersion: 1,
            hostId: HOST.id,
            displayLocation: 'D:\\projects\\fresh',
            objectFormat: 'sha1',
            head: 'a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e',
            branch: 'main',
            detached: false,
            locked: false,
            inheritedChangeEntryCount: 0,
            conversionAmbiguous: false,
            remotes: [{ transport: 'https' as const, coordinate: 'github.com/example/origin' }],
            automaticMutationEligible: true,
            blockingReasons: [],
            fingerprint: { version: 1, digest: 'abc123' },
            baseline: { kind: 'complete' },
          },
        },
      },
    })
    face.registerDevelopmentProject.mockResolvedValue({
      ok: true,
      receipt: {
        id: 'receipt-0a1b2c3d-0000-4000-8000-0000000000bb',
        intentId: 'intent-0a1b2c3d-0000-4000-8000-0000000000bb',
        state: 'confirmed',
        projectId: PROJECT_B,
        resourceBindingId: 'binding-0a1b2c3d-0000-4000-8000-0000000000bb',
        registryRevision: 4,
      },
    })
    render(<ProjectPage {...props} />)
    await waitFor(() => { expect(screen.getByText('示例项目')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '登记已有目录' }))
    fireEvent.change(screen.getByLabelText('本地目录路径'), { target: { value: 'D:\\projects\\fresh' } })
    fireEvent.click(screen.getByRole('button', { name: '检查目录' }))
    await waitFor(() => { expect(screen.getByLabelText('项目名称')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '确认登记' }))
    // The registry advanced; the refresh rejects, so the confirmed list stays.
    face.queryProjectIndex.mockRejectedValueOnce(new Error('down'))
    await waitFor(() => { expect(navigation.store.getSnapshot().projectId).toBe(PROJECT_B) })
    expect(face.queryProjectIndex).toHaveBeenCalledTimes(2)
    expect(screen.getByText('示例项目')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('ProjectPage — Development Workspace', () => {
  it('re-reads the workspace with the observed registry revision once the index is ready', async () => {
    const { navigation, face, props } = bench(PROJECT_A)
    navigation.actions.selectProject(PROJECT_A)
    const indexRead = deferred<unknown>()
    const workspaceRead = deferred<unknown>()
    face.queryProjectIndex.mockReturnValue(indexRead.promise)
    face.queryDevelopmentWorkspace.mockReturnValue(workspaceRead.promise)
    render(<ProjectPage {...props} />)
    await waitFor(() => { expect(face.queryDevelopmentWorkspace).toHaveBeenCalledWith(PROJECT_A, 0) })
    // Until the facts arrive, the heading falls back to the selected id.
    expect(screen.getByRole('heading', { name: PROJECT_A })).toBeTruthy()
    indexRead.resolve(indexResult([summary()]))
    await waitFor(() => { expect(face.queryDevelopmentWorkspace).toHaveBeenLastCalledWith(PROJECT_A, 3) })
    workspaceRead.resolve(workspaceResult(summary()))
    await waitFor(() => { expect(screen.getByRole('heading', { name: '示例项目' })).toBeTruthy() })
    expect(screen.getByText('D:\\projects\\demo')).toBeTruthy()
    expect(screen.getByText('main')).toBeTruthy()
    expect(screen.getByText('a1b2c3d4e5')).toBeTruthy()
    expect(screen.getAllByText('无')).toHaveLength(2)
    expect(screen.getByText('完整')).toBeTruthy()
    expect(screen.getByText('已连接')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '返回项目选择' }))
    expect(navigation.store.getSnapshot().projectId).toBeNull()
  })

  it('renders repair evidence for a blocked, repair-required workspace', async () => {
    const { face, props } = bench(PROJECT_A)
    face.queryProjectIndex.mockResolvedValue(indexResult([summary()]))
    face.queryDevelopmentWorkspace.mockResolvedValue(workspaceResult(
      summary({
        health: 'repair-required',
        detached: true,
        inheritedChangeEntryCount: 2,
        baseline: 'unavailable',
        configurationGaps: ['binding-missing', 'conversion-ambiguous'],
      }),
      {
        state: 'blocked',
        reasons: ['binding-missing', 'binding-repair-required', 'baseline-unavailable', 'conversion-ambiguous', 'dirty', 'locked'],
      },
    ))
    render(<ProjectPage {...props} />)
    await waitFor(() => { expect(screen.getByText('项目当前被阻止写入')).toBeTruthy() })
    expect(screen.getByText('游离 HEAD')).toBeTruthy()
    expect(screen.getByText('2 条')).toBeTruthy()
    expect(screen.getByText('不可用')).toBeTruthy()
    expect(screen.getByText('Binding 缺失；存在歧义的混合变更')).toBeTruthy()
    expect(screen.getByText('需要修复')).toBeTruthy()
    expect(screen.getByText(/需要修复 — 修复与 rebind 属于后续切片/)).toBeTruthy()
    expect(screen.getByText('Binding 需要修复')).toBeTruthy()
    expect(screen.getByText('继承变更基线不可用')).toBeTruthy()
    expect(screen.getByText('工作树有未提交修改')).toBeTruthy()
    expect(screen.getByText('存在活动写操作占用')).toBeTruthy()
    // The blocked notice and the binding-health notice both carry the repair note.
    expect(screen.getAllByText(/修复与 rebind 属于后续切片/)).toHaveLength(2)
  })

  it('renders the branch placeholder when an attached binding carries no branch name', async () => {
    const { face, props } = bench(PROJECT_A)
    face.queryProjectIndex.mockResolvedValue(indexResult([summary()]))
    const attached = summary()
    const binding = { ...attached.binding }
    delete (binding as { branch?: string }).branch
    face.queryDevelopmentWorkspace.mockResolvedValue(workspaceResult({ ...attached, binding }))
    render(<ProjectPage {...props} />)
    await waitFor(() => { expect(screen.getByText('—')).toBeTruthy() })
  })

  it('keeps confirmed values during a refresh and survives a failed refresh', async () => {
    const { face, props } = bench(PROJECT_A)
    face.queryProjectIndex.mockResolvedValue(indexResult([summary()]))
    face.queryDevelopmentWorkspace.mockResolvedValue(workspaceResult(summary()))
    render(<ProjectPage {...props} />)
    await waitFor(() => { expect(screen.getByText('完整')).toBeTruthy() })
    const refresh = deferred<unknown>()
    face.queryDevelopmentWorkspace.mockReturnValue(refresh.promise)
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => {
      const button = screen.getByRole('button', { name: '正在刷新，仍显示已确认值' }) as HTMLButtonElement
      expect(button.disabled).toBe(true)
    })
    expect(screen.getByRole('status').textContent).toBe('正在刷新，仍显示已确认值')
    expect(screen.getByText('完整')).toBeTruthy()
    refresh.reject(new Error('down'))
    await waitFor(() => {
      const button = screen.getByRole('button', { name: '刷新' }) as HTMLButtonElement
      expect(button.disabled).toBe(false)
    })
    expect(screen.getByText('完整')).toBeTruthy()
  })

  it('shows the offline notice when the read rejects and reloads through the notice retry', async () => {
    const { face, props } = bench(PROJECT_A)
    face.queryProjectIndex.mockResolvedValue(indexResult([summary()]))
    face.queryDevelopmentWorkspace.mockRejectedValueOnce(new Error('down'))
    render(<ProjectPage {...props} />)
    await waitFor(() => { expect(screen.getByText('连接已断开：显示最近一次已确认的状态。')).toBeTruthy() })
    face.queryDevelopmentWorkspace.mockResolvedValue(workspaceResult(summary()))
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => { expect(screen.getByText('完整')).toBeTruthy() })
  })

  it('reloads from the offline state through the header refresh as well', async () => {
    const { face, props } = bench(PROJECT_A)
    face.queryProjectIndex.mockResolvedValue(indexResult([summary()]))
    face.queryDevelopmentWorkspace.mockRejectedValueOnce(new Error('down'))
    render(<ProjectPage {...props} />)
    await waitFor(() => { expect(screen.getByText('连接已断开：显示最近一次已确认的状态。')).toBeTruthy() })
    face.queryDevelopmentWorkspace.mockResolvedValue(workspaceResult(summary()))
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => { expect(screen.getByText('完整')).toBeTruthy() })
  })

  it('refreshes the index when the workspace reports a stale revision', async () => {
    const { face, props } = bench(PROJECT_A)
    face.queryProjectIndex.mockResolvedValue(indexResult([summary()]))
    face.queryDevelopmentWorkspace.mockResolvedValue({ ok: false, reason: 'stale' })
    render(<ProjectPage {...props} />)
    await waitFor(() => { expect(screen.getByText('本地视图已过时，请刷新后重试。')).toBeTruthy() })
    const callsBefore = face.queryProjectIndex.mock.calls.length
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: '刷新' }))
    await waitFor(() => { expect(face.queryProjectIndex.mock.calls.length).toBe(callsBefore + 1) })
  })

  it('renders the denied and unavailable notices', async () => {
    const { face, props } = bench(PROJECT_A)
    face.queryProjectIndex.mockResolvedValue(indexResult([summary()]))
    face.queryDevelopmentWorkspace.mockResolvedValue({ ok: false, reason: 'denied' })
    const first = render(<ProjectPage {...props} />)
    await waitFor(() => { expect(screen.getByText('当前身份无权查看该项目。')).toBeTruthy() })
    first.unmount()
    const second = bench(PROJECT_A)
    second.face.queryProjectIndex.mockResolvedValue(indexResult([summary()]))
    second.face.queryDevelopmentWorkspace.mockResolvedValue({ ok: false, reason: 'unavailable' })
    render(<ProjectPage {...second.props} />)
    await waitFor(() => { expect(screen.getByText('暂时不可用，请稍后重试。')).toBeTruthy() })
  })

  it('offers the way back to the selector when the project is not found', async () => {
    const { navigation, face, props } = bench(PROJECT_A)
    navigation.actions.selectProject(PROJECT_A)
    face.queryProjectIndex.mockResolvedValue(indexResult([summary()]))
    face.queryDevelopmentWorkspace.mockResolvedValue({ ok: false, reason: 'not-found' })
    render(<ProjectPage {...props} />)
    await waitFor(() => { expect(screen.getByText('找不到该项目：可能已在其他地方退役。')).toBeTruthy() })
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: '返回项目选择' }))
    expect(navigation.store.getSnapshot().projectId).toBeNull()
  })
})
