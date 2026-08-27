#!/usr/bin/env node
/** Source Loader driver for the assembled keyless Saki Board snapshot. */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  providePreparedSakiState,
  withPreparedSakiServingState,
} from '@breakfastdapaidang/saki-installation-maintenance'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { announceSakiReadiness } from '../../packages/saki/bundle/src/index.ts'
import {
  sakiPreparedStoragePatch,
  sakiServingInstallationOptions,
} from '../../packages/saki/bundle/src/launcher.ts'

const ROOT_CONFIG = fileURLToPath(new URL('../../packages/saki/bundle/cordis.yml', import.meta.url))
const BUNDLE_PATCH = fileURLToPath(new URL('../../packages/saki/bundle/cordis.patch.yml', import.meta.url))

const lifetime = new AbortController()
let app: Context | undefined
let resolveStop!: () => void
const stopped = new Promise<void>((resolve) => { resolveStop = resolve })

function requestStop(): void {
  if (lifetime.signal.aborted) return
  lifetime.abort(new Error('Saki Board snapshot driver stopped'))
  resolveStop()
}

process.once('SIGINT', requestStop)
process.once('SIGTERM', requestStop)

try {
  process.exitCode = await withPreparedSakiServingState(
    sakiServingInstallationOptions(),
    lifetime.signal,
    async (prepared) => {
      const fakeProviderEnabled = process.env.SAKI_BOARD_SNAPSHOT_PROVIDER_ENABLED !== '0'
      const patches = [
        ...loadOverlayPatches('saki-board-snapshot', BUNDLE_PATCH),
        { id: 'saki-github-app', disabled: true },
        ...(fakeProviderEnabled ? [{
          insert: [{
            id: 'saki-board-snapshot-github',
            name: '../../../scripts/fixtures/saki-board-fake-github.ts',
          }],
        }] : []),
        sakiPreparedStoragePatch(prepared.databasePath),
      ]
      app = await announceSakiReadiness(
        boot(
          'saki-board-snapshot',
          ROOT_CONFIG,
          patches,
          (ctx) => {
            providePreparedSakiState(ctx, prepared)
            provideCmdline(ctx, { args: [], exit: requestStop })
          },
          import.meta.url,
        ),
        { stdout: process.stdout, exit: requestStop },
        { exitAfterAnnounce: false },
      )
      const handoff = app.sakiControlPlane.bootstrap.take()
      if (handoff !== undefined) {
        process.stdout.write(`${JSON.stringify({
          product: 'saki',
          bootstrapPurpose: handoff.purpose,
          bootstrapSecret: handoff.consume(),
          url: `http://127.0.0.1:${String(app.webServer.port)}`,
        })}\n`)
      }
      await stopped
      await app.fiber.dispose()
      app = undefined
      return 0
    },
  )
} catch (error) {
  await app?.fiber.dispose()
  if (lifetime.signal.aborted) {
    process.exitCode = 0
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
} finally {
  lifetime.abort(new Error('Saki Board snapshot driver settled'))
  process.off('SIGINT', requestStop)
  process.off('SIGTERM', requestStop)
}
