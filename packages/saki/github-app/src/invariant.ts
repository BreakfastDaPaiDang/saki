/** Package-owned invariant companion for the Saki Product GitHub App Provider. @module @breakfastdapaidang/saki-github-app/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@breakfastdapaidang/saki-github-app'
/** Cordis companion plugin name. */
export const name = 'saki-github-app-invariant'
/** Services required by the invariant companion. */
export const inject = ['invariants']

/** No runtime invariant: the provider retains no authoritative cross-plugin relationship. */
const install: InvariantInstaller = () => {}

/** @param ctx - context carrying the invariant registry. @returns registration disposer. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
