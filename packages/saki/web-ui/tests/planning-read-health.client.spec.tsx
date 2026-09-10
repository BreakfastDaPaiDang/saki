// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { ReadHealth } from '../src/client/components/PlanningReadHealth.tsx'
import { NS, zh } from '../src/client/locales.ts'

const t = ((key: string) => (zh as Record<string, string>)[key] ?? key) as TranslateNS<typeof NS>
afterEach(() => { cleanup() })
it.each([
  ['denied', 'planning.denied'], ['not-found', 'planning.not-found'],
  ['offline', 'planning.offline'], ['unavailable', 'planning.unavailable'],
] as const)('names %s independently of retained values', (failure, key) => {
  render(<ReadHealth read={{ value: { retained: true }, loading: true, failure }} t={t} />)
  expect(screen.getByRole('alert').textContent).toBe(t(key))
  expect(screen.getByRole('status').textContent).toBe(t('planning.loading'))
})
it('adds no loading or failure notice for a settled successful read', () => {
  render(<ReadHealth read={{ value: null, loading: false, failure: null }} t={t} />)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByRole('status')).toBeNull()
})
