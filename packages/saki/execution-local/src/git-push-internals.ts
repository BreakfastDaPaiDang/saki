/** Test-only installation point for Local Host Push transport adapters. @module */

import type { Context } from '@deepseek-ai/cordis'
import type { LocalGitPushInternals } from './git-push.ts'

const installed = new WeakMap<Context, LocalGitPushInternals>()

/**
 * Install one application-root-scoped Push transport override.
 * @param owner - Context whose application root owns the override.
 * @param internals - Complete provider-private Push adapters.
 * @internal
 */
export function installLocalGitPushInternals(owner: Context, internals: LocalGitPushInternals): void {
  installed.set(owner.root, internals)
}

/**
 * Read the Push override installed for one application root.
 * @param owner - Context whose application root owns the override.
 * @returns The installed adapters, or undefined when production transport applies.
 * @internal
 */
export function localGitPushInternalsFor(owner: Context): LocalGitPushInternals | undefined {
  return installed.get(owner.root)
}
