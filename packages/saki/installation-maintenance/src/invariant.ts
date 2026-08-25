/** Package invariant companion for Saki Installation maintenance. @module @breakfastdapaidang/saki-installation-maintenance/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@breakfastdapaidang/saki-installation-maintenance'

/** Cordis companion plugin name. */
export const name = 'saki-installation-maintenance-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

const install: InvariantInstaller = () => {
  // No runtime invariant: offline entry points validate durable state while holding the Installation lease.
}

/**
 * Reserve package invariant ownership; durable state is checked by maintenance entry points.
 * @param ctx - Context carrying the invariant registry.
 * @returns the installed registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
