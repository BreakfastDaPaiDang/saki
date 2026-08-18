/** Package invariant companion for Saki control-plane persistence. @module @breakfastdapaidang/saki-control-plane/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@breakfastdapaidang/saki-control-plane'

/** Cordis companion plugin name. */
export const name = 'saki-control-plane-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No continuous companion relation: every query reads the authoritative domain
 * records directly, while the owning module validates persisted relationships
 * at open and permits later writes only through its serialized operations.
 */
const install: InvariantInstaller = () => {
  // No runtime invariant: the module validates persisted relationships at open
  // and owns every later serialized Installation Access mutation.
}

/**
 * Register this package's invariant companion.
 * @param ctx - Context carrying the invariant registry.
 * @returns the installed registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
