/** Package invariant companion for the Local Host provider. @module @breakfastdapaidang/saki-execution-local/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@breakfastdapaidang/saki-execution-local'

/** Cordis companion plugin name. */
export const name = 'saki-execution-local-invariant'
/** Service required before package ownership can be reserved. */
export const inject = ['invariants']

/**
 * No runtime invariant: the domain parser validates every provider-owned Host
 * Operation record at open and before each write. Live acceptance callbacks
 * are intentionally absent from durable state.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Context carrying the invariant registry.
 * @returns the installed registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
