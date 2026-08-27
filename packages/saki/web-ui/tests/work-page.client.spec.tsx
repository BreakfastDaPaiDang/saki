// @vitest-environment jsdom
/**
 * 「工作」 page placeholder behavior: the unavailable card states the missing
 * My Work Projection honestly and routes to 「项目」. Props are fed directly.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { WorkPage } from '../src/client/components/WorkPage.tsx'
import { zh, NS } from '../src/client/locales.ts'

afterEach(() => { cleanup() })

const t = ((key: string) => (zh as Record<string, string>)[key] ?? key) as TranslateNS<typeof NS>

describe('WorkPage', () => {
  it('renders the unavailable state and opens 「项目」 from the action', () => {
    const openProject = vi.fn()
    render(<WorkPage openProject={openProject} t={t} />)
    expect(screen.getByRole('heading', { name: '我的工作' })).toBeTruthy()
    expect(screen.getByText('「工作」页将在后续版本提供')).toBeTruthy()
    expect(screen.getByText('My Work Projection 尚未进入当前后端切片。项目工作请从「项目」页进入。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '打开项目' }))
    expect(openProject).toHaveBeenCalledOnce()
  })
})
