// @vitest-environment jsdom
/**
 * SakiSurfaceRoot behavior: the first access read gates every page, a failed
 * read renders the unavailable gate with a working retry, a successful
 * bootstrap exchange swaps the gate for the elected page, and the matched
 * page comes from the chain selector outcome. The navigation store is the
 * real instance (factory + .create()); host callbacks are plain stubs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SakiWireAccessProjection } from '@breakfastdapaidang/saki-host-api/wire'
import { SakiSurfaceRoot } from '../src/client/components/SurfaceRoot.tsx'
import * as ProjectPageModule from '../src/client/components/ProjectPage.tsx'
import * as PlanningPageModule from '../src/client/components/PlanningPage.tsx'
import { workFixture } from './work-fixture.client.ts'
import { changesFixture } from './changes-fixture.client.ts'
import { planningFixture, PROJECT_ID } from './planning-fixture.client.ts'
import { zh, NS } from '../src/client/locales.ts'

const controllers = new Set<{ dispose: () => void }>()
afterEach(() => { cleanup(); for (const controller of controllers) controller.dispose(); controllers.clear() })
beforeEach(() => { localStorage.clear() })

const t = ((key: string) => (zh as Record<string, string>)[key] ?? key) as TranslateNS<typeof NS>

const AUTHENTICATED: Extract<SakiWireAccessProjection, { kind: 'authenticated' }> = {
  kind: 'authenticated',
  principal: { id: 'principal-0a1b2c3d-0000-4000-8000-000000000001', displayName: '你' },
  expiresAt: 1,
  requestToken: 'token-1',
} as Extract<SakiWireAccessProjection, { kind: 'authenticated' }>

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function bench(readAccess: () => Promise<SakiWireAccessProjection>, matched: { page: 'work' | 'project' }) {
  const fixture = planningFixture()
  const { navigation, controller } = fixture
  controllers.add(controller)
  fixture.api.readAccess.mockImplementation(readAccess)
  const subscribe = (listener: () => void) => navigation.store.subscribe(listener)
  const getSnapshot = () => navigation.store.getSnapshot()
  const useNavigation = <S,>(select: (state: ReturnType<typeof getSnapshot>) => S): S =>
    select(useSyncExternalStore(subscribe, getSnapshot))
  const face = {
    ...fixture.api,
    queryProjectIndex: vi.fn(),
    inspectProjectSelection: vi.fn(),
    queryDevelopmentWorkspace: vi.fn(),
    registerDevelopmentProject: vi.fn(),
  }
  const work = workFixture().controller
  controllers.add(work)
  const changes = changesFixture().controller
  controllers.add(changes)
  const props = {
    page: matched.page,
    ...face,
    nav: navigation.actions,
    useNavigation,
    planning: controller,
    work,
    changes,
    useChanges: (select: (state: ReturnType<typeof changes.getSnapshot>) => unknown) =>
      select(useSyncExternalStore(changes.subscribe, changes.getSnapshot)),
    useWork: (select: (state: ReturnType<typeof work.getSnapshot>) => unknown) =>
      select(useSyncExternalStore(work.subscribe, work.getSnapshot)),
    openSession: vi.fn(),
    exchangeBootstrap: controller.exchangeBootstrap,
    usePlanning: (select: (state: ReturnType<typeof controller.getSnapshot>) => unknown) =>
      select(useSyncExternalStore(controller.subscribe, controller.getSnapshot)),
    t,
  } as unknown as Parameters<typeof SakiSurfaceRoot>[0]
  controller.start()
  return { navigation, face, props, controller }
}

describe('SakiSurfaceRoot', () => {
  it('opens Changes as a Project destination and retains its Work Item return address', async () => {
    const { props, controller, navigation } = bench(() => Promise.resolve(AUTHENTICATED), { page: 'project' })
    render(<SakiSurfaceRoot {...props} />)
    await act(async () => { await controller.reloadAccess(); navigation.actions.selectProject(PROJECT_ID) })
    await act(async () => { controller.navigate({ view: 'changes' }) })
    expect(screen.getByRole('heading', { name: '变更' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '返回看板' }))
    expect(controller.getSnapshot().project?.address.view).toBe('board')
  })
  it('opens the registered workspace and returns between the Board and workspace destinations', async () => {
    const projectPage = vi.spyOn(ProjectPageModule, 'ProjectPage').mockImplementation(props => <>
      <button onClick={() => { props.nav.selectProject(PROJECT_ID); props.showRegisteredWorkspace?.() }}>registered</button>
      <button onClick={props.openBoard}>board</button>
    </>)
    const planningPage = vi.spyOn(PlanningPageModule, 'PlanningPage').mockImplementation(props =>
      <button onClick={() => { props.actions.navigate({ view: 'workspace' }) }}>workspace</button>)
    try {
      const { props, controller } = bench(() => Promise.resolve(AUTHENTICATED), { page: 'project' })
      render(<SakiSurfaceRoot {...props} />)
      await screen.findByRole('button', { name: 'registered' })
      fireEvent.click(screen.getByRole('button', { name: 'registered' }))
      expect(controller.getSnapshot().project?.address.view).toBe('workspace')
      fireEvent.click(screen.getByRole('button', { name: 'board' }))
      await screen.findByRole('button', { name: 'workspace' })
      expect(controller.getSnapshot().project?.address.view).toBe('board')
      fireEvent.click(screen.getByRole('button', { name: 'workspace' }))
      await screen.findByRole('button', { name: 'registered' })
      expect(controller.getSnapshot().project?.address.view).toBe('workspace')
    } finally {
      cleanup()
      projectPage.mockRestore()
      planningPage.mockRestore()
    }
  })
  it('shows the loading hint while the first access read is in flight, then the bootstrap gate', async () => {
    const read = deferred<SakiWireAccessProjection>()
    const { props } = bench(() => read.promise, { page: 'work' })
    render(<SakiSurfaceRoot {...props} />)
    expect(screen.getByText('正在读取 Development Workspace…')).toBeTruthy()
    await act(async () => { read.resolve({ kind: 'bootstrap-required', message: 'Local bootstrap is required.' }) })
    expect(screen.getByRole('heading', { name: '完成本地引导' })).toBeTruthy()
  })

  it('renders the unavailable gate when the read rejects and re-reads on retry', async () => {
    const { face, props } = bench(() => Promise.reject(new Error('down')), { page: 'work' })
    render(<SakiSurfaceRoot {...props} />)
    await waitFor(() => { expect(screen.getByText('本地访问暂不可用')).toBeTruthy() })
    face.readAccess.mockResolvedValue({ kind: 'bootstrap-required', message: 'Local bootstrap is required.' })
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => { expect(screen.getByRole('heading', { name: '完成本地引导' })).toBeTruthy() })
    expect(face.readAccess).toHaveBeenCalledTimes(2)
  })

  it('swaps the gate for the elected work page after a successful exchange', async () => {
    const { navigation, face, props } = bench(
      () => Promise.resolve({ kind: 'bootstrap-required', message: 'Local bootstrap is required.' }),
      { page: 'work' },
    )
    face.exchangeBootstrap.mockResolvedValue({ ok: true, access: AUTHENTICATED })
    render(<SakiSurfaceRoot {...props} />)
    await waitFor(() => { expect(screen.getByRole('heading', { name: '完成本地引导' })).toBeTruthy() })
    fireEvent.change(screen.getByLabelText('粘贴 bootstrap secret'), { target: { value: 'secret-1' } })
    fireEvent.click(screen.getByRole('button', { name: '完成引导' }))
    await waitFor(() => { expect(screen.getByRole('heading', { name: '我的工作' })).toBeTruthy() })
    expect(face.exchangeBootstrap).toHaveBeenCalledWith('secret-1', expect.any(AbortSignal))
    // The work page's 打开项目 action routes through the shared navigation actions.
    fireEvent.click(screen.getByRole('button', { name: '打开项目' }))
    expect(navigation.store.getSnapshot().surface).toBe('project')
  })

  it('keeps the gate when the exchange does not authenticate', async () => {
    const { face, props } = bench(
      () => Promise.resolve({ kind: 'bootstrap-required', message: 'Local bootstrap is required.' }),
      { page: 'work' },
    )
    face.exchangeBootstrap.mockResolvedValue({ ok: false, reason: 'unavailable' })
    render(<SakiSurfaceRoot {...props} />)
    await waitFor(() => { expect(screen.getByRole('heading', { name: '完成本地引导' })).toBeTruthy() })
    fireEvent.change(screen.getByLabelText('粘贴 bootstrap secret'), { target: { value: 'secret-1' } })
    fireEvent.click(screen.getByRole('button', { name: '完成引导' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('引导失败') })
    expect(screen.queryByRole('heading', { name: '我的工作' })).toBeNull()
  })

  it('renders the project selector for the matched project page', async () => {
    const { face, props } = bench(() => Promise.resolve(AUTHENTICATED), { page: 'project' })
    face.queryProjectIndex.mockResolvedValue({
      ok: true,
      projection: { type: 'project-index', revision: 1, hosts: [], projects: [] },
    })
    render(<SakiSurfaceRoot {...props} />)
    await waitFor(() => { expect(screen.getByText('还没有登记任何 Development Project。')).toBeTruthy() })
    expect(face.queryProjectIndex).toHaveBeenCalledOnce()
  })

  it('ignores the access read settling after unmount', async () => {
    const read = deferred<SakiWireAccessProjection>()
    const { props } = bench(() => read.promise, { page: 'work' })
    const { unmount } = render(<SakiSurfaceRoot {...props} />)
    unmount()
    await act(async () => { read.resolve({ kind: 'bootstrap-required', message: 'Local bootstrap is required.' }) })
    const failed = deferred<SakiWireAccessProjection>()
    const second = bench(() => failed.promise, { page: 'work' })
    const secondRender = render(<SakiSurfaceRoot {...second.props} />)
    secondRender.unmount()
    await act(async () => { failed.reject(new Error('down')) })
  })
})

it('routes Work cards to their Project Board and Work Item through the shared navigation', async () => {
  const workPage = await import('../src/client/components/WorkPage.tsx')
  const mock = vi.spyOn(workPage, 'WorkPage').mockImplementation(props => <>
    <button onClick={() => { props.openBoard(PROJECT_ID) }}>work-board</button>
    <button onClick={() => { props.openItem(PROJECT_ID, 'work-item-1111111111111111111111111111111111111111111111111111111111111111' as Parameters<typeof props.openItem>[1]) }}>work-detail</button>
  </>)
  try {
    const { props, navigation, controller } = bench(() => Promise.resolve(AUTHENTICATED), { page: 'work' })
    render(<SakiSurfaceRoot {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: 'work-board' }))
    expect(navigation.store.getSnapshot().projectId).toBe(PROJECT_ID)
    expect(controller.getSnapshot().project?.address.view).toBe('board')
    fireEvent.click(screen.getByRole('button', { name: 'work-detail' }))
    expect(controller.getSnapshot().project?.address.view).toBe('detail')
  } finally { mock.mockRestore() }
})
