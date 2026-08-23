/** Package invariant companion for Saki control-plane persistence. @module @breakfastdapaidang/saki-control-plane/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@breakfastdapaidang/saki-control-plane'

/** Cordis companion plugin name. */
export const name = 'saki-control-plane-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: every query reads the authoritative domain records
 * directly. The owning module validates Installation Access, Project Registry,
 * Binding, and Intent relationships at open, then serializes writes.
 */
const install: InvariantInstaller = () => {
}

/**
 * Register this package's invariant companion.
 * @param ctx - Context carrying the invariant registry.
 * @returns the installed registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
