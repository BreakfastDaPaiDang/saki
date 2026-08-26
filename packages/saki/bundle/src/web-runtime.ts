/**
 * Saki web runtime glue: mounts the `frontend-static` fallback owner over the
 * built web frontend dist. The dist location is workspace knowledge of this
 * bundle, never user config. The Saki launcher (bin.ts) prints the URL and the
 * bootstrap handoff; this row only wires the serving.
 * @module @breakfastdapaidang/saki-bundle/web-runtime
 */

import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import * as FrontendStatic from '@deepseek-ai/dsh-host-frontend-static'

/** Stable Cordis plugin name. */
export const name = 'saki-web-runtime'

/** The fallback owner mounts over the webserver. */
export const inject = ['webServer']

/**
 * Mount the frontend dist over the webserver's fallback seat.
 * @param ctx - plugin context carrying the webServer service.
 */
export function apply(ctx: Context): void {
  const require = createRequire(import.meta.url)
  const distIndex = require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')
  ctx.plugin(FrontendStatic, { distIndex })
}
