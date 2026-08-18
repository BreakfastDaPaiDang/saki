/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-credentials-windows-dpapi`.
 * @module @deepseek-ai/dsh-credentials-windows-dpapi/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-credentials-windows-dpapi'

/** Cordis companion plugin name. */
export const name = 'credentials-windows-dpapi-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the Service Definition companion owns update-event
 * lifetime, while native decryption and document agreement require
 * asynchronous I/O and are pinned by the Provider suite.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context that owns the invariant registry.
 * @returns disposer for the package reservation.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
