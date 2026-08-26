/**
 * Package-owned invariant companion for `@breakfastdapaidang/saki-web-ui`.
 * @module @breakfastdapaidang/saki-web-ui/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@breakfastdapaidang/saki-web-ui'

/** Cordis companion plugin name. */
export const name = 'saki-web-ui-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package renders Saki Projections through the
 * shell's additive slots and submits Intents through `saki-host-api`; it emits
 * no cordis events and owns no cross-plugin mutable state, and its slot
 * registrations prove disposal through the HMR-safety spec.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
