/** Plain-Node smoke for the built private Saki executable. */

import { execFile, spawn } from 'node:child_process'
import { existsSync, watch } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import type { FSWatcher } from 'node:fs'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { sakiSnapshotEnvironment } from '../../../../scripts/saki-snapshot-environment.ts'

const execFileAsync = promisify(execFile)
const bin = fileURLToPath(new URL('../lib/bin.js', import.meta.url))
const readyRecord = '{"product":"saki","status":"ready"}\n'

interface ChildOutcome {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}

interface ChildFailure extends Error {
  readonly code: string | number | null
  readonly stdout: string
  readonly stderr: string
}

interface RunningSaki {
  readonly child: ChildProcessWithoutNullStreams
  readonly outcome: Promise<ChildOutcome>
  readonly ready: Promise<void>
  stdout(): string
}

function keylessEnvironment(directory: string): NodeJS.ProcessEnv {
  const environment = sakiSnapshotEnvironment()
  environment.DSH_HOME = join(directory, 'home')
  environment.SAKI_ONESHOT = '1'
  return environment
}

async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('temporary Saki port did not resolve to a TCP address')
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
  })
  return address.port
}

async function runOneShot(directory: string, port: number): Promise<{ stdout: string; stderr: string }> {
  const environment = keylessEnvironment(directory)
  environment.SAKI_PORT = String(port)
  return await execFileAsync(process.execPath, [bin], {
    cwd: directory,
    env: environment,
    timeout: 30_000,
  })
}

function isChildFailure(value: unknown): value is ChildFailure {
  if (!(value instanceof Error) || !('code' in value) || !('stdout' in value) || !('stderr' in value)) return false
  return (typeof value.code === 'string' || typeof value.code === 'number' || value.code === null)
    && typeof value.stdout === 'string'
    && typeof value.stderr === 'string'
}

async function runOneShotExpectingFailure(directory: string, port: number): Promise<ChildFailure> {
  try {
    await runOneShot(directory, port)
  } catch (error) {
    if (isChildFailure(error)) return error
    throw error
  }
  throw new Error('Saki child unexpectedly exited successfully')
}

function startServing(directory: string, port: number): RunningSaki {
  const environment = keylessEnvironment(directory)
  Reflect.deleteProperty(environment, 'SAKI_ONESHOT')
  environment.SAKI_PORT = String(port)
  const child = spawn(process.execPath, [bin], {
    cwd: directory,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdin.end()
  let stdout = ''
  let stderr = ''
  let resolveReady!: () => void
  const ready = new Promise<void>((resolve) => { resolveReady = resolve })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
    if (stdout.includes(readyRecord)) resolveReady()
  })
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  const outcome = new Promise<ChildOutcome>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => { resolve({ code, signal, stdout, stderr }) })
  })
  return { child, outcome, ready, stdout: () => stdout }
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

function waitForLeafPublication(directory: string, leaf: string): { readonly seen: Promise<void>; close(): void } {
  let watcher: FSWatcher | undefined
  let resolveSeen!: () => void
  let rejectSeen!: (error: Error) => void
  const seen = new Promise<void>((resolve, reject) => {
    resolveSeen = resolve
    rejectSeen = reject
  })
  watcher = watch(directory, { encoding: 'utf8', persistent: false }, (_event, filename) => {
    if (filename === leaf) resolveSeen()
  })
  watcher.once('error', rejectSeen)
  return { seen, close: () => { watcher?.close(); watcher = undefined } }
}

async function stopChild(run: RunningSaki): Promise<void> {
  if (run.child.exitCode !== null || run.child.signalCode !== null) return
  run.child.kill('SIGKILL')
  await within(run.outcome, 10_000, 'forced Saki child exit')
}

describe('built Saki child environment', () => {
  it('scrubs mixed-case ambient credentials', () => {
    const key = 'sAkI_BuIlT_CaNaRy_SeCrEt'
    const previousNodeOptions = process.env.NODE_OPTIONS
    const previousNodePath = process.env.NODE_PATH
    const previousExtraCaCerts = process.env.NODE_EXTRA_CA_CERTS
    process.env[key] = 'secret'
    process.env.NODE_OPTIONS = '--import untrusted-loader'
    process.env.NODE_PATH = 'untrusted-modules'
    process.env.NODE_EXTRA_CA_CERTS = 'untrusted-certificates'
    try {
      const environment = keylessEnvironment('fixture')
      expect(environment[key]).toBeUndefined()
      expect(environment.NODE_OPTIONS).toBeUndefined()
      expect(environment.NODE_PATH).toBeUndefined()
      expect(environment.NODE_EXTRA_CA_CERTS).toBeUndefined()
    } finally {
      Reflect.deleteProperty(process.env, key)
      if (previousNodeOptions === undefined) Reflect.deleteProperty(process.env, 'NODE_OPTIONS')
      else process.env.NODE_OPTIONS = previousNodeOptions
      if (previousNodePath === undefined) Reflect.deleteProperty(process.env, 'NODE_PATH')
      else process.env.NODE_PATH = previousNodePath
      if (previousExtraCaCerts === undefined) Reflect.deleteProperty(process.env, 'NODE_EXTRA_CA_CERTS')
      else process.env.NODE_EXTRA_CA_CERTS = previousExtraCaCerts
    }
  })
})

describe.skipIf(!existsSync(bin))('built Saki executable', () => {
  it('boots under plain Node without credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'saki-built-bin-'))
    try {
      const { stdout, stderr } = await runOneShot(directory, await availablePort())

      expect(stdout).toBe(readyRecord)
      expect(stderr).toBe('')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reopens the exact ready generation on a second plain-Node launch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'saki-built-reopen-'))
    const manifestPath = join(directory, 'home', 'saki', 'installation.json')
    const port = await availablePort()
    try {
      const first = await runOneShot(directory, port)
      expect(first).toEqual({ stdout: readyRecord, stderr: '' })
      const firstManifest = await readFile(manifestPath, 'utf8')
      expect(JSON.parse(firstManifest)).toMatchObject({ phase: 'ready', stateVersion: 8 })

      const second = await runOneShot(directory, port)
      expect(second).toEqual({ stdout: readyRecord, stderr: '' })
      expect(await readFile(manifestPath, 'utf8')).toBe(firstManifest)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects a port that cannot identify the configured browser Origin', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'saki-built-bin-'))
    try {
      const error = await runOneShotExpectingFailure(directory, 0)
      expect(error.code).toBe(1)
      expect(error.stdout).toBe('')
      expect(error.stderr).toContain('SAKI_PORT must be an integer from 1 through 65535')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  describe.skipIf(process.platform === 'win32')('POSIX signal lifecycle', () => {
    it('releases the serving lease on SIGTERM so the next process starts immediately', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'saki-built-sigterm-ready-'))
      const port = await availablePort()
      let run: RunningSaki | undefined
      try {
        await runOneShot(directory, port)
        run = startServing(directory, port)
        await within(run.ready, 30_000, 'Saki readiness')
        const blocked = await runOneShotExpectingFailure(directory, await availablePort())
        expect(blocked.code).toBe(1)
        expect(blocked.stderr).toContain('already serving or under maintenance')
        expect(run.child.kill('SIGTERM')).toBe(true)
        const stopped = await within(run.outcome, 30_000, 'SIGTERM Saki exit')
        expect(stopped).toMatchObject({ code: 0, signal: null, stderr: '' })
        expect(stopped.stdout).toContain(readyRecord)

        const restarted = await runOneShot(directory, port)
        expect(restarted).toEqual({ stdout: readyRecord, stderr: '' })
      } finally {
        if (run !== undefined) await stopChild(run)
        await rm(directory, { recursive: true, force: true })
      }
    })

    it('releases and recovers the lease when SIGTERM arrives during fresh preflight', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'saki-built-sigterm-early-'))
      const installationRoot = join(directory, 'home', 'saki')
      await mkdir(installationRoot, { recursive: true })
      const publication = waitForLeafPublication(installationRoot, 'active-operation.json')
      const port = await availablePort()
      let run: RunningSaki | undefined
      try {
        run = startServing(directory, port)
        await within(publication.seen, 30_000, 'Saki active-operation publication')
        expect(run.stdout()).not.toContain(readyRecord)
        expect(run.child.kill('SIGTERM')).toBe(true)
        const stopped = await within(run.outcome, 30_000, 'early SIGTERM Saki exit')
        expect(stopped).toEqual({ code: 0, signal: null, stdout: '', stderr: '' })

        const restarted = await runOneShot(directory, port)
        expect(restarted).toEqual({ stdout: readyRecord, stderr: '' })
      } finally {
        publication.close()
        if (run !== undefined) await stopChild(run)
        await rm(directory, { recursive: true, force: true })
      }
    })
  })
})
