/** Package-owned invariant companion for Saki Host Execution. @module @breakfastdapaidang/saki-execution/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@breakfastdapaidang/saki-execution'
/** Cordis companion plugin name. */
export const name = 'saki-execution-invariant'
/** Services required by the invariant companion. */
export const inject = ['invariants']

/** No runtime invariant: schemas and canonical value helpers retain no mutable relationship. */
const install: InvariantInstaller = () => {}

/** @param ctx - context carrying the invariant registry. @returns registration disposer. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
