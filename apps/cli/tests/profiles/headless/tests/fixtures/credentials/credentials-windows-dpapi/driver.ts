#!/usr/bin/env node
/** Test driver for the Windows credential Provider's Loader composition. */

import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-api-settings-controller'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('credentials-windows-dpapi driver requires a config path')

const ref = credentialRef('DSH_DPAPI_LOADER_TEST')
const secret = 'loader-composition-secret'
const ctx = await boot('credentials-windows-dpapi-e2e', resolveConfigPath(configPath, undefined))
try {
  await ctx.credentials.set(ref, secret)
  const resolved = await ctx.credentials.resolve(ref)
  if (resolved?.value !== secret) throw new Error('credential Loader round trip changed the value')
  const response = await ctx.credentialsController.describe([ref])
  const view = response[ref]
  if (view === undefined || typeof view.observedAt !== 'number') {
    throw new Error('credentials-windows-dpapi Host response omitted observedAt')
  }
  Object.assign(view, { observedAt: '{{timestamp}}' })
  process.stdout.write(`${JSON.stringify(response)}\n`)
} finally {
  await ctx.fiber.dispose()
}
