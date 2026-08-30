/** Test-only installation point for Local Host Git mutation leaf adapters. @module */

import type { Context } from '@deepseek-ai/cordis'
import type { LocalGitMutationInternals } from './git-mutation.ts'

const installed = new WeakMap<Context, LocalGitMutationInternals>()

/**
 * Install one application-root-scoped mutation adapter override.
 * @param owner - context whose application root owns the override.
 * @param internals - complete provider-private adapter set.
 * @internal
 */
export function installLocalGitMutationInternals(
  owner: Context,
  internals: LocalGitMutationInternals,
): void {
  installed.set(owner.root, internals)
}

/**
 * Read adapters installed for the root shared by one provider context.
 * @param owner - provider context whose root owns the override.
 * @returns installed adapters, or `undefined` for production defaults.
 * @internal
 */
export function localGitMutationInternalsFor(owner: Context): LocalGitMutationInternals | undefined {
  return installed.get(owner.root)
}
