/** Owns a browser-test server from spawn through bootstrap or failed-start cleanup. */
import { spawn } from 'node:child_process'

/** A child whose output streams have closed. */
interface Outcome {
  code: number | null
  signal: NodeJS.Signals | null
  stderr: string
  error: Error | undefined
}

/** Start a server process and retain ownership before waiting for its handoff.
 * @param executable - Node executable.
 * @param args - built launcher or test-fixture arguments.
 * @param env - scrubbed child environment.
 * @param timeoutMs - maximum bootstrap wait.
 * @returns child, bounded readiness, and quiescent stop operation.
 */
export function startWebServerProcess(executable: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) {
  const child = spawn(executable, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.end()
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let stdout = ''
  let stderr = ''
  let spawnError: Error | undefined
  const outcome = new Promise<Outcome>((resolve) => {
    child.once('error', (error) => { spawnError = error })
    child.once('close', (code, signal) => { resolve({ code, signal, stderr, error: spawnError }) })
  })
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await within(outcome, 10_000, 'Saki child close')
  }
  const handoff = new Promise<{ url: string; secret: string }>((resolve, reject) => {
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      const lines = stdout.split('\n')
      lines.pop() // Only complete JSONL records can announce readiness.
      const line = lines.find(entry => entry.includes('"bootstrapSecret"'))
      if (line === undefined) return
      try {
        const parsed: unknown = JSON.parse(line)
        if (typeof parsed !== 'object' || parsed === null
          || !('url' in parsed) || typeof parsed.url !== 'string'
          || !('bootstrapSecret' in parsed) || typeof parsed.bootstrapSecret !== 'string'
          || !lines.includes('{"product":"saki","status":"ready"}')) {
          throw new Error('invalid Saki bootstrap handoff')
        }
        resolve({ url: parsed.url, secret: parsed.bootstrapSecret })
      } catch {
        reject(new Error('invalid Saki bootstrap handoff'))
      }
    })
  })
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  const ready = within(Promise.race([
    handoff,
    outcome.then((result) => {
      throw result.error ?? new Error(`Saki exited before bootstrap (code ${String(result.code)}, signal ${String(result.signal)}): ${result.stderr}`)
    }),
  ]), timeoutMs, 'Saki bootstrap handoff').catch(async (error: unknown) => {
    await stop()
    throw error
  })
  return { child, ready, stop }
}

async function within<T>(promise: Promise<T>, milliseconds: number, subject: string): Promise<T> {
  let timeout!: ReturnType<typeof setTimeout>
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => { reject(new Error(`${subject} did not settle within ${String(milliseconds)}ms`)) }, milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}
