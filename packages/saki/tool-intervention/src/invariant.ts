/** Package-owned invariant companion for Saki's Intervention tool. @module @breakfastdapaidang/saki-tool-intervention/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@breakfastdapaidang/saki-tool-intervention'

/** Cordis companion plugin name. */
export const name = 'saki-tool-intervention-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: the control-plane and Host providers validate every durable relationship. */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant registry.
 * @returns disposer for the package ownership registration.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
