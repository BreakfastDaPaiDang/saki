#!/usr/bin/env node
/** Offline Saki Installation maintenance executable. @module @breakfastdapaidang/saki-installation-maintenance/bin */

/* v8 ignore start -- executable wiring is covered by process smokes */
import { runSakiMaintenanceCli } from './cli.ts'
import { createSakiMaintenanceOperations } from './maintenance-operations.ts'

const lifetime = new AbortController()
const abort = (): void => { lifetime.abort() }
process.on('SIGINT', abort)
process.on('SIGTERM', abort)

try {
  const outcome = await runSakiMaintenanceCli(
    process.argv.slice(2),
    process.env,
    createSakiMaintenanceOperations(),
    lifetime.signal,
  )
  const line = `${JSON.stringify(outcome.value)}\n`
  if (outcome.stream === 'stdout') process.stdout.write(line)
  else process.stderr.write(line)
  process.exitCode = outcome.exitCode
} catch {
  process.stderr.write(`${JSON.stringify({ ok: false, error: 'operation-failed' })}\n`)
  process.exitCode = 1
} finally {
  process.off('SIGINT', abort)
  process.off('SIGTERM', abort)
}
/* v8 ignore stop */
