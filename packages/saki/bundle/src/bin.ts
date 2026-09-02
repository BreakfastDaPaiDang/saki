#!/usr/bin/env node
/**
 * Repository-local launcher for the Saki composition.
 * @module @breakfastdapaidang/saki-bundle/bin
 */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@breakfastdapaidang/saki-control-plane'
import { providePreparedSakiState, withPreparedSakiServingState } from '@breakfastdapaidang/saki-installation-maintenance'
import { boot, installFailLoud, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { announceSakiReadiness } from './index.ts'
import { sakiAgentPresetsPatch, sakiPreparedStoragePatch, sakiServingInstallationOptions } from './launcher.ts'

const NAME = 'saki'
const ROOT_CONFIG = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const BUNDLE_PATCH = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))

/* v8 ignore start -- executable composition covered by source and built process smokes */
let app: Context | undefined
let requestedExit: { readonly code: number; readonly reason: Error } | undefined
const lifetime = new AbortController()
let resolveExit!: (code: number) => void
let rejectExit!: (error: unknown) => void
const exitCode = new Promise<number>((resolve, reject) => {
  resolveExit = resolve
  rejectExit = reject
})
let resolveExitRequest!: (request: { readonly code: number; readonly reason: Error }) => void
const exitRequest = new Promise<{ readonly code: number; readonly reason: Error }>((resolve) => {
  resolveExitRequest = resolve
})

const requestExit = (code: number): void => {
  if (requestedExit !== undefined) return
  const request = { code, reason: new Error(`saki exit requested with code ${String(code)}`) }
  requestedExit = request
  resolveExitRequest(request)
  lifetime.abort(request.reason)
  void (async () => {
    try {
      await app?.fiber.dispose()
      resolveExit(code)
    } catch (error) {
      rejectExit(error)
    }
  })()
}

const exitAfterReadiness = process.env.SAKI_ONESHOT === '1'
const stop = (): void => { requestExit(0) }
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

const uninstallFailLoud = installFailLoud(NAME, process, async () => { await app?.fiber.dispose() })
try {
  process.exitCode = await withPreparedSakiServingState(
    sakiServingInstallationOptions(),
    lifetime.signal,
    async (prepared) => {
      try {
        const patches = [
          ...loadOverlayPatches(NAME, BUNDLE_PATCH),
          sakiAgentPresetsPatch(),
          sakiPreparedStoragePatch(prepared.databasePath),
        ]
        const startup = announceSakiReadiness(
          boot(
            NAME,
            ROOT_CONFIG,
            patches,
            (hostCtx) => {
              app = hostCtx
              providePreparedSakiState(hostCtx, prepared)
              provideCmdline(hostCtx, { args: [], exit: requestExit })
            },
            import.meta.url,
          ),
          { stdout: process.stdout, exit: requestExit },
          { exitAfterAnnounce: exitAfterReadiness },
        )
        const ctx = await Promise.race([
          startup,
          exitRequest.then((request) => { throw request.reason }),
        ])
        app = ctx
        if (!exitAfterReadiness) {
          const handoff = ctx.sakiControlPlane.bootstrap.take()
          if (handoff !== undefined) {
            process.stdout.write(`${JSON.stringify({
              product: 'saki',
              bootstrapPurpose: handoff.purpose,
              bootstrapSecret: handoff.consume(),
              url: `http://127.0.0.1:${String(ctx.webServer.port)}`,
            })}\n`)
          }
        }
        return await exitCode
      } finally {
        await app?.fiber.dispose()
      }
    },
  )
} catch (error) {
  await app?.fiber.dispose()
  if (requestedExit !== undefined && error === requestedExit.reason) {
    process.exitCode = await exitCode
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : `${NAME}: ${String(error)}`}\n`)
    process.exitCode = 1
  }
} finally {
  lifetime.abort(new Error('saki launcher stopped'))
  process.off('SIGINT', stop)
  process.off('SIGTERM', stop)
  uninstallFailLoud()
}
/* v8 ignore stop */
