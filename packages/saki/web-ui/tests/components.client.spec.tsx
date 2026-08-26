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
import type { SakiWireHostId } from '@breakfastdapaidang/saki-host-api/wire'
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
    remotes: ['origin'],
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
})

describe('RegisterProjectDialog', () => {
  it('reviews evidence and confirms registration with fingerprint, baseline, and expected revision', async () => {
    const { props, inspectProjectSelection, registerDevelopmentProject, onRegistered } = dialogProps()
    inspectProjectSelection.mockResolvedValue({
      ok: true,
      projection: { type: 'inspect-project-selection', result: { ok: true, selection: selection() } },
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
    fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: 'demo' } })
    fireEvent.click(screen.getByRole('button', { name: '确认登记' }))
    await waitFor(() => { expect(onRegistered).toHaveBeenCalledWith('project-0a1b2c3d-0000-4000-8000-0000000000aa') })
    const intent = registerDevelopmentProject.mock.calls[0]![0]
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
})
