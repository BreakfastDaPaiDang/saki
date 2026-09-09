/** Failed browser-test startup releases the child before reporting failure. */
import { afterEach, describe, expect, it } from 'vitest'
import { sakiSnapshotEnvironment } from '../../../../scripts/saki-snapshot-environment.ts'
import { startWebServerProcess } from './fixtures/web-server-process.ts'

const runs: ReturnType<typeof startWebServerProcess>[] = []
afterEach(async () => { await Promise.all(runs.splice(0).map(run => run.stop())) })

function start(script: string, timeoutMs = 10_000) {
  const run = startWebServerProcess(process.execPath, ['-e', script], sakiSnapshotEnvironment(), timeoutMs)
  runs.push(run)
  return run
}

describe('browser server startup ownership', () => {
  it('closes a live child after a malformed handoff', async () => {
    const run = start('console.log(\'{"bootstrapSecret":\'); setInterval(() => {}, 1000)')
    await expect(run.ready).rejects.toThrow('invalid Saki bootstrap handoff')
    expect(run.child.exitCode !== null || run.child.signalCode !== null).toBe(true)
    expect(run.child.stdout.destroyed).toBe(true)
  })

  it('closes the child after the bootstrap deadline', async () => {
    const run = start('setInterval(() => {}, 1000)', 50)
    await expect(run.ready).rejects.toThrow('Saki bootstrap handoff did not settle')
    expect(run.child.exitCode !== null || run.child.signalCode !== null).toBe(true)
    expect(run.child.stdout.destroyed).toBe(true)
  })

  it('reports an early exit without waiting for the bootstrap deadline', async () => {
    const run = start('process.stderr.write("fixture failed"); process.exitCode = 7')
    await expect(run.ready).rejects.toThrow('code 7, signal null): fixture failed')
    expect(run.child.exitCode).toBe(7)
  })

  it('waits for the complete handoff record', async () => {
    const run = start(`
      console.log('{"product":"saki","status":"ready"}');
      process.stdout.write('{"bootstrapSecret":"fixture",');
      setImmediate(() => console.log('"url":"http://127.0.0.1:1234"}'));
      setInterval(() => {}, 1000);
    `)
    await expect(run.ready).resolves.toEqual({ url: 'http://127.0.0.1:1234', secret: 'fixture' })
    expect(run.child.exitCode).toBeNull()
    expect(run.child.signalCode).toBeNull()
    await run.stop()
    expect(run.child.stdout.destroyed).toBe(true)
  })
})
