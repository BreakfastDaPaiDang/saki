/** Package-owned invariant companion for the stateless Saki GitHub Service Definition. @module @breakfastdapaidang/saki-github/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@breakfastdapaidang/saki-github'
/** Cordis companion plugin name. */
export const name = 'saki-github-invariant'
/** Services required by the invariant companion. */
export const inject = ['invariants']

/** No runtime invariant: the Service Definition retains no mutable relationship. */
const install: InvariantInstaller = () => {}

/** @param ctx - context carrying the invariant registry. @returns registration disposer. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
