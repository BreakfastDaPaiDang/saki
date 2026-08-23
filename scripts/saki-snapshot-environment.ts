/** Shared ambient environment policy for Saki fixture children. */

import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

/**
 * Return the canonical scrubbed parent environment without ambient DSH, Saki, TSX, or Node launcher controls.
 * @returns a fresh environment object ready for explicit fixture-owned values.
 */
export function sakiSnapshotEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.entries(scrubbedParentEnv()).filter(([key]) => {
    const normalized = key.toUpperCase()
    return !normalized.startsWith('SAKI_')
      && !normalized.startsWith('NODE_')
      && !normalized.startsWith('TSX_')
  }))
}
