/**
 * Package-owned invariant companion for `@breakfastdapaidang/saki-bundle`.
 * @module @breakfastdapaidang/saki-bundle/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@breakfastdapaidang/saki-bundle'

/** Cordis companion plugin name. */
export const name = 'saki-bundle-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: the package owns only static composition metadata and
 * a one-shot readiness line, with no retained mutable relationship to audit.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
