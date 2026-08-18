#!/usr/bin/env node
/**
 * Repository-local launcher for the empty Saki composition.
 * @module @breakfastdapaidang/saki-bundle/bin
 */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { boot, installFailLoud, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { announceSakiReadiness } from './index.ts'

const NAME = 'saki'
const ROOT_CONFIG = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const BUNDLE_PATCH = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))

/* v8 ignore start -- executable composition covered by source and built process smokes */
let app: Context | undefined
let requested = false
let resolveExit!: (code: number) => void
const exitCode = new Promise<number>((resolve) => { resolveExit = resolve })

const requestExit = (code: number): void => {
  if (requested) return
  requested = true
  void (async () => {
    await app?.fiber.dispose()
    resolveExit(code)
  })()
}

const uninstallFailLoud = installFailLoud(NAME, process, async () => { await app?.fiber.dispose() })
try {
  const ctx = await announceSakiReadiness(
    boot(
      NAME,
      ROOT_CONFIG,
      loadOverlayPatches(NAME, BUNDLE_PATCH),
      (hostCtx) => {
        app = hostCtx
        provideCmdline(hostCtx, { args: [], exit: requestExit })
      },
      import.meta.url,
    ),
    { stdout: process.stdout, exit: requestExit },
  )
  app = ctx
  process.exitCode = await exitCode
} catch (error) {
  await app?.fiber.dispose()
  process.stderr.write(`${error instanceof Error ? error.message : `${NAME}: ${String(error)}`}\n`)
  process.exitCode = 1
} finally {
  uninstallFailLoud()
}
/* v8 ignore stop */
