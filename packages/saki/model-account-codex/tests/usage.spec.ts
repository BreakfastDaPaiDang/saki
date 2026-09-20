import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OAuthCredential } from '@earendil-works/pi-ai'
import { readUsage } from '../src/usage.ts'

const credential: OAuthCredential = { type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: 1, accountId: 'fixture-account' }
afterEach(() => { vi.restoreAllMocks() })

describe('published Codex usage helper projection', () => {
  it('retains measured windows and captures the selected account on the actual helper request', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      expect((input instanceof Request ? input.url : input.toString())).toBe('https://chatgpt.com/backend-api/wham/usage')
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe('Bearer fixture-access')
      expect(headers.get('chatgpt-account-id')).toBe('fixture-account')
      expect(init?.redirect).toBe('error')
      return Response.json({ rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 2_000_000_000 } },
        code_review_rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 604800 } } })
    })
    try {
      const result = await readUsage({ auth: { apiKey: credential.access } }, credential, 1000, new AbortController().signal)
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(result).toMatchObject({ state: 'available', source: 'dsh-codex-subscription@2.1.2', windows: [
        { id: 'codex:18000:0', remaining: 75, unit: 'percent', limit: 100, resetsAt: 2_000_000_000_000, blocksRequests: true },
        { id: 'code_review:604800:0', remaining: 0, resetsAt: null, blocksRequests: false },
      ] })
      expect(JSON.stringify(result)).not.toMatch(/fixture-access|fixture-refresh/)
    } finally { fetch.mockRestore() }
  })

  it.each([{}, { rate_limit: {} }])('does not report an empty allowance response as a measured zero: %j', async (body) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(body))
    try {
      const result = await readUsage({ auth: { apiKey: credential.access } }, credential, 1000, new AbortController().signal)
      expect(result.state).toBe('temporarily-unavailable')
      expect(result).not.toHaveProperty('windows')
    } finally { fetch.mockRestore() }
  })

  it('discards provider error material and keeps cancellation distinct', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fixture-access fixture-refresh'))
    try {
      const result = await readUsage({ auth: { apiKey: credential.access } }, credential, 1000, new AbortController().signal)
      expect(result.state).toBe('temporarily-unavailable')
      expect(JSON.stringify(result)).not.toMatch(/fixture-access|fixture-refresh/)
      const controller = new AbortController()
      controller.abort()
      await expect(readUsage({ auth: { apiKey: credential.access } }, credential, 1000, controller.signal)).rejects.toThrow()
    } finally { fetch.mockRestore() }
  })
})
