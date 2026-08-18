/**
 * Empty Saki application readiness row.
 * @module @breakfastdapaidang/saki-bundle
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'saki-readiness'
/** Loader settlement is the readiness precondition. */
export const inject = ['loader']

/** Deterministic repository-launch readiness record. */
export const SAKI_READY_RECORD = Object.freeze({ product: 'saki', status: 'ready' } as const)

/** Process stream used by the readiness row; tests replace it with a capture. */
export const internals: { stdout: { write(chunk: string): unknown } } = {
  stdout: process.stdout,
}

/**
 * Announce the settled empty application and request a clean process exit.
 * @param ctx - plugin context carrying Loader and the launcher-owned exit request.
 */
export function apply(ctx: Context): void {
  const loader = ctx.get('loader')
  const exit = ctx.get('appExit')
  if (loader === undefined || exit === undefined) {
    throw new Error('saki-readiness: the launcher must provide ctx.appExit and Loader before the tree mounts')
  }

  let active = true
  ctx.effect(() => () => { active = false })
  void loader.await().then(() => {
    if (!active || ctx.get('loader') === undefined) return
    internals.stdout.write(`${JSON.stringify(SAKI_READY_RECORD)}\n`)
    exit(0)
  }).catch(() => {
    // boot() owns Loader-settlement diagnostics and process failure; this
    // observer only prevents its duplicate await from becoming unhandled.
  })
}
