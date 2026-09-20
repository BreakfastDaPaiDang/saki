/** Subscription-helper allowance observations. @module @breakfastdapaidang/saki-model-account-codex/usage */

import { z } from 'zod'
import { createCodexUsageReader } from 'dsh-codex-subscription'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import type { AuthResult, OAuthCredential } from '@earendil-works/pi-ai'
import type { ModelAccountUsage } from '@breakfastdapaidang/saki-model-account'

const snapshotSchema = z.object({
  fetchedAt: z.number(),
  rateLimits: z.array(z.object({
    id: z.string().min(1),
    windows: z.array(z.object({
      remainingPercent: z.number().min(0).max(100),
      windowSeconds: z.number().int().positive(),
      resetsAt: z.number().int().nonnegative().optional(),
    })),
  })),
})

/**
 * Read one captured account; failures preserve unknown quantities and discard provider error bodies.
 * @param auth - resolved credentials from the same account transaction.
 * @param credential - corresponding account record, never a global active-account lookup.
 * @param timeoutMs - configured provider request limit.
 * @param signal - operation cancellation.
 * @returns safe allowance observations with explicit retrieval status.
 */
export async function readUsage(
  auth: AuthResult,
  credential: OAuthCredential,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ModelAccountUsage> {
  const source = 'dsh-codex-subscription@2.1.2'
  const reader = createCodexUsageReader({
    getAuth: () => Promise.resolve(auth),
    readCredential: () => Promise.resolve(credential),
    timeoutMs,
    fetch: (input, init) => {
      const headers = new Headers(init?.headers)
      for (const [name, value] of Object.entries(attributionHeaders())) headers.set(name, value)
      return globalThis.fetch(input, { ...init, headers })
    },
  })
  try {
    const result = snapshotSchema.parse(await reader.read({ signal }))
    const windows = result.rateLimits.flatMap(limit => limit.windows.map((window, index) => ({
      id: `${limit.id}:${window.windowSeconds}:${index}`,
      unit: 'percent' as const,
      remaining: window.remainingPercent,
      limit: 100,
      resetsAt: window.resetsAt === undefined ? null : window.resetsAt * 1000,
      blocksRequests: limit.id === 'codex',
    })))
    if (windows.length === 0) return { state: 'temporarily-unavailable', observedAt: result.fetchedAt, source }
    return { state: 'available', observedAt: result.fetchedAt, source, windows }
  } catch {
    // The helper's rejection can contain network or provider text; only retrieval state crosses into Saki.
    signal.throwIfAborted()
    return { state: 'temporarily-unavailable', observedAt: Date.now(), source }
  }
}
