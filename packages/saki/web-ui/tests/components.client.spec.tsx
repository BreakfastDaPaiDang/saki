// @vitest-environment jsdom
/**
 * Component behavior for the access gate and the registration dialog: secret
 * clearing, gate states, the inspect → evidence → confirm flow, and
 * non-converged outcomes keeping the dialog open. Props are fed directly;
 * no render machinery, no cordis.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { AccessGate } from '../src/client/components/AccessGate.tsx'
import { RegisterProjectDialog } from '../src/client/components/RegisterProjectDialog.tsx'
import type { RegisterProjectDialogProps } from '../src/client/components/RegisterProjectDialog.tsx'
import type { SakiWireHostId, SakiWireRegisterDevelopmentProjectIntent } from '@breakfastdapaidang/saki-host-api/wire'
import { zh, NS } from '../src/client/locales.ts'

afterEach(() => { cleanup() })

const t = ((key: string) => (zh as Record<string, string>)[key] ?? key) as TranslateNS<typeof NS>

function selection(overrides: Record<string, unknown> = {}) {
  return {
    observationVersion: 1 as const,
    hostId: 'host-0a1b2c3d-0000-4000-8000-000000000001',
    displayLocation: 'D:\\projects\\demo',
    objectFormat: 'directory',
    head: 'a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e',
    branch: 'main',
    detached: false,
    locked: false,
    inheritedChangeEntryCount: 0,
    conversionAmbiguous: false,
    remotes: [{ transport: 'https' as const, coordinate: 'github.com/example/origin' }],
    automaticMutationEligible: true,
    blockingReasons: [],
    fingerprint: { version: 1 as const, digest: 'abc123' },
    baseline: { kind: 'complete' as const },
    ...overrides,
  }
}

function dialogProps() {
  const inspectProjectSelection = vi.fn()
  const registerDevelopmentProject = vi.fn()
  const onClose = vi.fn()
  const onRegistered = vi.fn()
  const props: RegisterProjectDialogProps = {
    hosts: [{ id: 'host-0a1b2c3d-0000-4000-8000-000000000001' as SakiWireHostId, revision: 0, state: 'enrolled' as const }],
    expectedRegistryRevision: 3,
    requestToken: 'token-1',
    inspectProjectSelection: inspectProjectSelection as never,
    registerDevelopmentProject: registerDevelopmentProject as never,
    onClose,
    onRegistered,
    t,
  }
  return { props, inspectProjectSelection, registerDevelopmentProject, onClose, onRegistered }
}

describe('AccessGate', () => {
  it('clears the secret from state on submit, whatever the outcome', async () => {
    const exchange = vi.fn()
    exchange.mockResolvedValue({ ok: false, reason: 'unavailable' })
    render(
      <AccessGate
        access={{ kind: 'bootstrap-required', message: 'Local bootstrap is required.' }}
        exchange={exchange as never}
        reload={vi.fn()}
        t={t}
      />,
    )
    const input = screen.getByLabelText('粘贴 bootstrap secret')
    fireEvent.change(input, { target: { value: 'super-secret' } })
    fireEvent.click(screen.getByRole('button', { name: '完成引导' }))
    expect((input as HTMLInputElement).value).toBe('')
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('引导失败') })
    expect(exchange).toHaveBeenCalledWith('super-secret')
  })

  it('renders the unavailable state with a retry, and nothing when authenticated', () => {
    const reload = vi.fn()
    const { container, rerender } = render(
      <AccessGate access={{ kind: 'unavailable', message: 'Local access is temporarily unavailable.' }} exchange={vi.fn()} reload={reload} t={t} />,
    )
    expect(screen.getByText('本地访问暂不可用')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(reload).toHaveBeenCalledOnce()
    rerender(
      <AccessGate
        access={{ kind: 'authenticated', principal: { id: 'p', displayName: '你' }, expiresAt: 1, requestToken: 'tok' } as never}
        exchange={vi.fn()}
        reload={reload}
        t={t}
      />,
    )
    expect(container.textContent).toBe('')
  })

  it('shows only the loading hint while the first access read is in flight', () => {
    render(<AccessGate access={null} exchange={vi.fn()} reload={vi.fn()} t={t} />)
    expect(screen.getByText('正在读取 Development Workspace…')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders the session form and does not flag a failure when the exchange succeeds', async () => {
    const exchange = vi.fn()
    exchange.mockResolvedValue({
      ok: true,
      access: { kind: 'authenticated', principal: { id: 'p', displayName: '你' }, expiresAt: 1, requestToken: 'tok' },
    })
    render(
      <AccessGate
        access={{ kind: 'session-required', message: 'A local browser session is required.' }}
        exchange={exchange as never}
        reload={vi.fn()}
        t={t}
      />,
    )
    expect(screen.getByRole('heading', { name: '恢复会话' })).toBeTruthy()
    expect(screen.getByText('当前没有有效的本地会话。请粘贴本次启动器输出的 bootstrap secret 继续。')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('粘贴 bootstrap secret'), { target: { value: 'secret-2' } })
    fireEvent.click(screen.getByRole('button', { name: '恢复会话' }))
    await waitFor(() => { expect(exchange).toHaveBeenCalledWith('secret-2') })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('flags the failure when the exchange rejects', async () => {
    const exchange = vi.fn()
    exchange.mockRejectedValue(new Error('down'))
    render(
      <AccessGate
        access={{ kind: 'bootstrap-required', message: 'Local bootstrap is required.' }}
        exchange={exchange as never}
        reload={vi.fn()}
        t={t}
      />,
    )
    fireEvent.change(screen.getByLabelText('粘贴 bootstrap secret'), { target: { value: 'secret-3' } })
    fireEvent.click(screen.getByRole('button', { name: '完成引导' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('引导失败') })
  })

  it('ignores a form submit while the secret is blank', () => {
    const exchange = vi.fn()
    const { container } = render(
      <AccessGate
        access={{ kind: 'bootstrap-required', message: 'Local bootstrap is required.' }}
        exchange={exchange as never}
        reload={vi.fn()}
        t={t}
      />,
    )
    const form = container.querySelector('form')
    expect(form).not.toBeNull()
    fireEvent.submit(form!)
    expect(exchange).not.toHaveBeenCalled()
  })
})

describe('RegisterProjectDialog', () => {
  it('reviews evidence and confirms registration with fingerprint, baseline, and expected revision', async () => {
    const { props, inspectProjectSelection, registerDevelopmentProject, onRegistered } = dialogProps()
    inspectProjectSelection.mockResolvedValue({
      ok: true,
      projection: {
        type: 'inspect-project-selection',
        result: {
          ok: true,
          selection: selection({
            remotes: [
              { transport: 'https' as const, coordinate: 'github.com/example/origin' },
              { transport: 'ssh' as const },
            ],
          }),
        },
      },
    })
    registerDevelopmentProject.mockResolvedValue({
      ok: true,
      receipt: {
        id: 'receipt-0a1b2c3d-0000-4000-8000-0000000000aa',
        intentId: 'intent-0a1b2c3d-0000-4000-8000-0000000000aa',
        state: 'confirmed',
        projectId: 'project-0a1b2c3d-0000-4000-8000-0000000000aa',
        resourceBindingId: 'binding-0a1b2c3d-0000-4000-8000-0000000000aa',
        registryRevision: 4,
      },
    })
    render(<RegisterProjectDialog {...props} />)
    fireEvent.change(screen.getByLabelText('本地目录路径'), { target: { value: 'D:\\projects\\demo' } })
    fireEvent.click(screen.getByRole('button', { name: '检查目录' }))
    await waitFor(() => { expect(screen.getByText('D:\\projects\\demo')).toBeTruthy() })
    // Remotes render their display-safe coordinate, falling back to the transport.
    expect(screen.getByText('github.com/example/origin，ssh')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: 'demo' } })
    fireEvent.click(screen.getByRole('button', { name: '确认登记' }))
    await waitFor(() => { expect(onRegistered).toHaveBeenCalledWith('project-0a1b2c3d-0000-4000-8000-0000000000aa') })
    const intent = registerDevelopmentProject.mock.calls[0]![0] as SakiWireRegisterDevelopmentProjectIntent
    expect(intent.expectedRegistryRevision).toBe(3)
    expect(intent.confirmedFingerprint).toEqual({ version: 1, digest: 'abc123' })
    expect(intent.confirmedBaseline).toEqual({ kind: 'complete' })
    expect(intent.intentId).toMatch(/^intent-[0-9a-f-]{36}$/)
    expect(registerDevelopmentProject.mock.calls[0]![1]).toBe('token-1')
  })

  it('shows the rejection reason for a non-git directory and never submits', async () => {
    const { props, inspectProjectSelection, registerDevelopmentProject } = dialogProps()
    inspectProjectSelection.mockResolvedValue({
      ok: true,
      projection: { type: 'inspect-project-selection', result: { ok: false, reason: 'not-git' } },
    })
    render(<RegisterProjectDialog {...props} />)
    fireEvent.change(screen.getByLabelText('本地目录路径'), { target: { value: 'D:\\projects\\demo' } })
    fireEvent.click(screen.getByRole('button', { name: '检查目录' }))
    await waitFor(() => { expect(screen.getByText('该目录不是 Git 工作树。')).toBeTruthy() })
    expect(registerDevelopmentProject).not.toHaveBeenCalled()
  })

  it('keeps the dialog open with the conflict note on a stale revision', async () => {
    const { props, inspectProjectSelection, registerDevelopmentProject, onClose, onRegistered } = dialogProps()
    inspectProjectSelection.mockResolvedValue({
      ok: true,
      projection: { type: 'inspect-project-selection', result: { ok: true, selection: selection() } },
    })
    registerDevelopmentProject.mockResolvedValue({
      ok: false,
      reason: 'conflict',
    })
    render(<RegisterProjectDialog {...props} />)
    fireEvent.change(screen.getByLabelText('本地目录路径'), { target: { value: 'D:\\projects\\demo' } })
    fireEvent.click(screen.getByRole('button', { name: '检查目录' }))
    await waitFor(() => { expect(screen.getByLabelText('项目名称')).toBeTruthy() })
    fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: 'demo' } })
    fireEvent.click(screen.getByRole('button', { name: '确认登记' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('登记信息已变化') })
    expect(onClose).not.toHaveBeenCalled()
    expect(onRegistered).not.toHaveBeenCalled()
  })

  /** Drive the dialog from an empty path field to the evidence review step. */
  async function reachReview(props: RegisterProjectDialogProps, inspectProjectSelection: ReturnType<typeof vi.fn>) {
    inspectProjectSelection.mockResolvedValue({
      ok: true,
      projection: { type: 'inspect-project-selection', result: { ok: true, selection: selection() } },
    })
    render(<RegisterProjectDialog {...props} />)
    fireEvent.change(screen.getByLabelText('本地目录路径'), { target: { value: 'D:\\projects\\demo' } })
    fireEvent.click(screen.getByRole('button', { name: '检查目录' }))
    await waitFor(() => { expect(screen.getByLabelText('项目名称')).toBeTruthy() })
  }

  it('reports the unavailable outcome without calling the host when no host is enrolled', async () => {
    const { props, inspectProjectSelection } = dialogProps()
    props.hosts = []
    render(<RegisterProjectDialog {...props} />)
    fireEvent.change(screen.getByLabelText('本地目录路径'), { target: { value: 'D:\\projects\\demo' } })
    fireEvent.click(screen.getByRole('button', { name: '检查目录' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('登记暂时不可用，请稍后重试。') })
    expect(inspectProjectSelection).not.toHaveBeenCalled()
  })

  it('surfaces a denied inspection as a denied note', async () => {
    const { props, inspectProjectSelection } = dialogProps()
    inspectProjectSelection.mockResolvedValue({ ok: false, reason: 'denied' })
    render(<RegisterProjectDialog {...props} />)
    fireEvent.change(screen.getByLabelText('本地目录路径'), { target: { value: 'D:\\projects\\demo' } })
    fireEvent.click(screen.getByRole('button', { name: '检查目录' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('当前身份无权登记该项目。') })
  })

  it('surfaces an unavailable inspection as an unavailable note', async () => {
    const { props, inspectProjectSelection } = dialogProps()
    inspectProjectSelection.mockResolvedValue({ ok: false, reason: 'unavailable' })
    render(<RegisterProjectDialog {...props} />)
    fireEvent.change(screen.getByLabelText('本地目录路径'), { target: { value: 'D:\\projects\\demo' } })
    fireEvent.click(screen.getByRole('button', { name: '检查目录' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('登记暂时不可用，请稍后重试。') })
  })

  it('keeps the dialog open with the unavailable note when the registration call rejects', async () => {
    const { props, inspectProjectSelection, registerDevelopmentProject, onRegistered } = dialogProps()
    await reachReview(props, inspectProjectSelection)
    registerDevelopmentProject.mockRejectedValue(new Error('down'))
    fireEvent.click(screen.getByRole('button', { name: '确认登记' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('登记暂时不可用，请稍后重试。') })
    expect(onRegistered).not.toHaveBeenCalled()
  })

  it('keeps the dialog open with the denied note when registration is denied', async () => {
    const { props, inspectProjectSelection, registerDevelopmentProject } = dialogProps()
    await reachReview(props, inspectProjectSelection)
    registerDevelopmentProject.mockResolvedValue({ ok: false, reason: 'denied' })
    fireEvent.click(screen.getByRole('button', { name: '确认登记' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('当前身份无权登记该项目。') })
  })

  it('keeps the dialog open with the reconciliation note when the outcome is unknown', async () => {
    const { props, inspectProjectSelection, registerDevelopmentProject } = dialogProps()
    await reachReview(props, inspectProjectSelection)
    registerDevelopmentProject.mockResolvedValue({ ok: false, reason: 'reconciliation-required' })
    fireEvent.click(screen.getByRole('button', { name: '确认登记' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('登记结果不明：请检查后重试，不会重复创建。') })
  })

  it('keeps the dialog open with the unavailable note for any other failure outcome', async () => {
    const { props, inspectProjectSelection, registerDevelopmentProject } = dialogProps()
    await reachReview(props, inspectProjectSelection)
    registerDevelopmentProject.mockResolvedValue({ ok: false, reason: 'unavailable' })
    fireEvent.click(screen.getByRole('button', { name: '确认登记' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('登记暂时不可用，请稍后重试。') })
  })

  it('closes on a backdrop press but not on a press inside the dialog', () => {
    const { props, onClose } = dialogProps()
    const { container } = render(<RegisterProjectDialog {...props} />)
    fireEvent.mouseDown(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.mouseDown(container.firstElementChild!)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('reviews detached evidence with no remotes, blocking reasons, and an unavailable baseline', async () => {
    const { props, inspectProjectSelection, registerDevelopmentProject, onRegistered } = dialogProps()
    inspectProjectSelection.mockResolvedValue({
      ok: true,
      projection: {
        type: 'inspect-project-selection',
        result: {
          ok: true,
          selection: selection({
            detached: true,
            branch: undefined,
            remotes: [],
            githubRepositoryCandidates: ['github.com/acme/demo'],
            inheritedChangeEntryCount: 1,
            baseline: { kind: 'unavailable' },
            automaticMutationEligible: false,
            blockingReasons: ['dirty'],
          }),
        },
      },
    })
    registerDevelopmentProject.mockResolvedValue({
      ok: true,
      receipt: {
        id: 'receipt-0a1b2c3d-0000-4000-8000-0000000000aa',
        intentId: 'intent-0a1b2c3d-0000-4000-8000-0000000000aa',
        state: 'confirmed',
        projectId: 'project-0a1b2c3d-0000-4000-8000-0000000000aa',
        resourceBindingId: 'binding-0a1b2c3d-0000-4000-8000-0000000000aa',
        registryRevision: 4,
      },
    })
    render(<RegisterProjectDialog {...props} />)
    fireEvent.change(screen.getByLabelText('本地目录路径'), { target: { value: 'D:\\projects\\demo' } })
    fireEvent.click(screen.getByRole('button', { name: '检查目录' }))
    await waitFor(() => { expect(screen.getByText('游离 HEAD')).toBeTruthy() })
    // The derived title comes from the last path segment.
    const titleInput = screen.getByLabelText('项目名称')
    expect((titleInput as HTMLInputElement).value).toBe('demo')
    expect(screen.getByText('无')).toBeTruthy()
    expect(screen.getByText('github.com/acme/demo')).toBeTruthy()
    expect(screen.getByText('1 条（不可用）')).toBeTruthy()
    expect(screen.getByText('阻塞原因')).toBeTruthy()
    expect(screen.getByText('dirty')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: 'demo-renamed' } })
    fireEvent.click(screen.getByRole('button', { name: '确认登记' }))
    await waitFor(() => { expect(onRegistered).toHaveBeenCalledWith('project-0a1b2c3d-0000-4000-8000-0000000000aa') })
    const intent = registerDevelopmentProject.mock.calls[0]![0] as SakiWireRegisterDevelopmentProjectIntent
    expect(intent.projectTitle).toBe('demo-renamed')
    expect(intent.directoryLocator).toBe('D:\\projects\\demo')
    expect(intent.confirmedBaseline).toEqual({ kind: 'unavailable' })
  })

  it('renders the branch placeholder for an attached selection without a branch name', async () => {
    const { props, inspectProjectSelection } = dialogProps()
    inspectProjectSelection.mockResolvedValue({
      ok: true,
      projection: {
        type: 'inspect-project-selection',
        result: { ok: true, selection: selection({ branch: undefined }) },
      },
    })
    render(<RegisterProjectDialog {...props} />)
    fireEvent.change(screen.getByLabelText('本地目录路径'), { target: { value: 'D:\\projects\\demo' } })
    fireEvent.click(screen.getByRole('button', { name: '检查目录' }))
    await waitFor(() => { expect(screen.getByText('—')).toBeTruthy() })
  })
})
