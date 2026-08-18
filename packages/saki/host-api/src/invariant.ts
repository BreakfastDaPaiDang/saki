/** Package invariant companion for the stateless Saki Host adapter. @module @breakfastdapaidang/saki-host-api/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@breakfastdapaidang/saki-host-api'

/** Cordis companion plugin name. */
export const name = 'saki-host-api-invariant'
/** Service required before package ownership can be reserved. */
export const inject = ['invariants']

/** No mutable companion relation: this adapter validates and forwards each request without retained state. */
const install: InvariantInstaller = () => {
  // No runtime invariant: this adapter validates and forwards each request
  // without retaining a mutable relationship.
}

/**
 * Register this package's invariant companion.
 * @param ctx - Context carrying the invariant registry.
 * @returns the installed registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
