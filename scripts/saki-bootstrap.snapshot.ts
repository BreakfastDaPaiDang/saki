/** Keyless source-and-artifact snapshot for Saki Project registration over the real `/saki` transport. */

import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync } from 'node:fs'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { sakiSnapshotEnvironment } from './saki-snapshot-environment.ts'

const root = resolve(import.meta.dirname, '..')
const sourceBin = join(root, 'packages/saki/bundle/src/bin.ts')
const builtBin = join(root, 'packages/saki/bundle/lib/bin.js')
const expected = join(root, 'scripts/snapshots/saki-bootstrap/access.expected.jsonl')
const refreshing = process.env.DSH_SNAPSHOT === 'record' || process.env.DSH_SNAPSHOT === 'refresh'
const tsxLoader = import.meta.resolve('tsx/esm')
const run = promisify(execFile)
const nullConfig = process.platform === 'win32' ? 'NUL' : '/dev/null'

function fixtureGitEnvironment(): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(sakiSnapshotEnvironment()).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
  )
  environment.GIT_CONFIG_GLOBAL = nullConfig
  environment.GIT_CONFIG_NOSYSTEM = '1'
  environment.GIT_TERMINAL_PROMPT = '0'
  environment.GIT_ASKPASS = ''
  return environment
}

interface StartedSaki {
  readonly child: ChildProcessByStdio<null, Readable, Readable>
  readonly bootstrapPurpose?: 'initial-bootstrap' | 'local-reauthentication'
  readonly bootstrapSecret?: string
  readonly stop: () => Promise<void>
}

interface RawHttpResponse {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

function caughtError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message, { cause: value })
}

async function runWithCleanup<T>(body: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
  let outcome: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: Error }
  try {
    outcome = { ok: true, value: await body() }
  } catch (error) {
    outcome = {
      ok: false,
      error: caughtError(error, 'Saki snapshot operation failed'),
    }
  }
  let cleanupFailure: Error | undefined
  try {
    await cleanup()
  } catch (error) {
    cleanupFailure = caughtError(error, 'Saki snapshot cleanup failed')
  }
  if (!outcome.ok) {
    if (cleanupFailure !== undefined) {
      throw new AggregateError([outcome.error, cleanupFailure], 'Saki snapshot operation and cleanup both failed')
    }
    throw outcome.error
  }
  if (cleanupFailure !== undefined) throw cleanupFailure
  return outcome.value
}

async function cleanupSnapshot(directory: string, ...started: readonly (StartedSaki | undefined)[]): Promise<void> {
  const results = await Promise.allSettled(
    started.map(async (instance) => { await instance?.stop() }),
  )
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => caughtError(result.reason, 'Saki snapshot child cleanup failed'))
  try {
    await rm(directory, { recursive: true, force: true })
  } catch (error) {
    failures.push(caughtError(error, 'Saki snapshot temporary-directory cleanup failed'))
  }
  const firstFailure = failures[0]
  if (firstFailure !== undefined && failures.length === 1) throw firstFailure
  if (failures.length > 1) throw new AggregateError(failures, 'Saki snapshot cleanup failed')
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Saki snapshot could not reserve a loopback port')
  await new Promise<void>((resolveClose, reject) => server.close((error) => {
    if (error === undefined) resolveClose()
    else reject(error)
  }))
  return address.port
}

async function startSaki(
  entry: string,
  databasePath: string,
  port: number,
  expectBootstrap: boolean,
  runtimeRoot: string,
): Promise<StartedSaki> {
  const source = entry.endsWith('.ts')
  const environment = sakiSnapshotEnvironment()
  environment.DSH_HOME = join(runtimeRoot, 'home')
  environment.SAKI_DATABASE_PATH = databasePath
  environment.SAKI_PORT = String(port)
  if (source) environment.TSX_TSCONFIG_PATH = join(root, 'tsconfig.json')
  const child = spawn(process.execPath, [
    ...(source ? ['--import', tsxLoader] : []),
    entry,
  ], {
    cwd: runtimeRoot,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let childDidClose = false
  const childClosed = new Promise<void>((resolveClosed) => {
    child.once('close', () => {
      childDidClose = true
      resolveClosed()
    })
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  const lines = createInterface({ input: child.stdout })
  let ready = false
  let bootstrapPurpose: 'initial-bootstrap' | 'local-reauthentication' | undefined
  let bootstrapSecret: string | undefined
  const closesWithin = async (milliseconds: number): Promise<boolean> => {
    if (childDidClose) return true
    return await new Promise<boolean>((resolveWait) => {
      const timeout = setTimeout(() => { resolveWait(false) }, milliseconds)
      void childClosed.then(() => {
        clearTimeout(timeout)
        resolveWait(true)
      })
    })
  }
  const stopChild = async (failOnForcedTermination = true): Promise<void> => {
    if (!childDidClose && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    if (!await closesWithin(5_000)) {
      const forced = child.kill('SIGKILL')
      if (!await closesWithin(5_000)) throw new Error('Saki snapshot host did not close after SIGKILL')
      if (forced && failOnForcedTermination) throw new Error('Saki snapshot host required SIGKILL during normal teardown')
    }
    lines.close()
  }
  try {
    await new Promise<void>((resolveReady, reject) => {
      const timeout = setTimeout(() => { reject(new Error('Saki snapshot startup timed out')) }, 20_000)
      const cleanup = (): void => {
        clearTimeout(timeout)
        child.off('exit', onExit)
        child.off('error', onError)
      }
      const complete = (): void => {
        if (!ready || (expectBootstrap && bootstrapSecret === undefined)) return
        cleanup()
        resolveReady()
      }
      lines.on('line', (line) => {
        let value: unknown
        try {
          value = JSON.parse(line)
        } catch {
          // Loader diagnostics are not protocol records and cannot satisfy either
          // readiness condition, so the snapshot waits for the next stdout line.
          return
        }
        if ((value as { status?: unknown }).status === 'ready') ready = true
        const secret = (value as { bootstrapSecret?: unknown }).bootstrapSecret
        if (typeof secret === 'string') bootstrapSecret = secret
        const purpose = (value as { bootstrapPurpose?: unknown }).bootstrapPurpose
        if (purpose === 'initial-bootstrap' || purpose === 'local-reauthentication') bootstrapPurpose = purpose
        complete()
      })
      const onExit = (): void => {
        cleanup()
        reject(new Error(`Saki snapshot host exited before readiness${stderr === '' ? '' : ': stderr was non-empty'}`))
      }
      const onError = (): void => {
        cleanup()
        reject(new Error('Saki snapshot host could not start'))
      }
      child.once('exit', onExit)
      child.once('error', onError)
    })
  } catch (error) {
    try {
      await stopChild(false)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Saki snapshot startup failed and its child did not close')
    }
    throw error
  }
  return {
    child,
    ...(bootstrapPurpose === undefined ? {} : { bootstrapPurpose }),
    ...(bootstrapSecret === undefined ? {} : { bootstrapSecret }),
    stop: async () => {
      await stopChild()
      expect(stderr).toBe('')
    },
  }
}

async function rpc(
  port: number,
  endpoint: string,
  payload: unknown,
  options: { readonly cookie?: string; readonly requestToken?: string } = {},
): Promise<{ readonly response: Response; readonly value: unknown }> {
  const origin = `http://127.0.0.1:${String(port)}`
  const response = await fetch(`${origin}/saki/${endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      ...(options.requestToken === undefined ? {} : { 'x-saki-request-token': options.requestToken }),
    },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `snapshot-${endpoint}`,
      method: endpoint,
      payload,
    }),
  })
  expect(response.status).toBe(200)
  const envelope = await response.json() as { result: { ok: boolean; value?: unknown } }
  expect(envelope.result.ok).toBe(true)
  return { response, value: envelope.result.value }
}

async function rawRequest(port: number, method: 'GET' | 'HEAD' | 'TRACE', body?: string): Promise<RawHttpResponse> {
  return await new Promise<RawHttpResponse>((resolveRequest, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/saki/access/read',
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }),
        host: `127.0.0.1:${String(port)}`,
      },
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      response.once('end', () => {
        resolveRequest({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
    })
    request.once('error', reject)
    request.end(body)
  })
}

async function createRepository(directory: string): Promise<string> {
  const repository = join(directory, 'repository')
  const environment = fixtureGitEnvironment()
  const git = async (arguments_: readonly string[], cwd?: string): Promise<void> => {
    await run('git', [
      '--no-pager',
      '--no-optional-locks',
      '-c', 'core.hooksPath=',
      '-c', 'core.autocrlf=false',
      ...arguments_,
    ], { ...(cwd === undefined ? {} : { cwd }), env: environment, timeout: 20_000, windowsHide: true })
  }
  await git(['init', '--initial-branch=main', '--template=', repository])
  await writeFile(join(repository, 'tracked.txt'), 'initial\n')
  await git(['add', '--', 'tracked.txt'], repository)
  await git([
    '-c', 'user.name=Saki Snapshot',
    '-c', 'user.email=saki@example.invalid',
    '-c', 'commit.gpgSign=false',
    'commit', '--no-gpg-sign', '--no-verify', '-m', 'initial',
  ], repository)
  return repository
}

async function transcript(entry: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'saki-bootstrap-snapshot-'))
  let first: StartedSaki | undefined
  let second: StartedSaki | undefined
  return await runWithCleanup(async () => {
    const runtimeRoot = join(directory, 'runtime')
    await mkdir(runtimeRoot, { recursive: true })
    const repository = await createRepository(directory)
    const databasePath = join(directory, 'control.sqlite')
    const port = await freePort()
    first = await startSaki(entry, databasePath, port, true, runtimeRoot)
    const bootstrapSecret = first.bootstrapSecret
    const initial = await rpc(port, 'access/read', {})
    const exchange = await rpc(port, 'access/exchange', { secret: bootstrapSecret })
    const exchangeValue = exchange.value as {
      ok: true
      access: { kind: 'authenticated'; requestToken: string }
    }
    const cookie = exchange.response.headers.get('set-cookie')?.split(';', 1)[0]
    if (cookie === undefined) throw new Error('Saki snapshot exchange returned no session cookie')
    const query = await rpc(port, 'control/query', { type: 'project-index' }, { cookie })
    const initialIndex = query.value as {
      ok: true
      projection: { revision: number; hosts: [{ id: string }]; projects: [] }
    }
    const hostId = initialIndex.projection.hosts[0].id
    const inspected = await rpc(port, 'control/query', {
      type: 'inspect-project-selection',
      hostId,
      directoryLocator: repository,
    }, { cookie })
    const inspection = inspected.value as {
      ok: true
      projection: {
        result: {
          ok: true
          selection: {
            displayLocation: string
            detached: boolean
            inheritedChangeEntryCount: number
            automaticMutationEligible: boolean
            workspaceId?: string
            baseline: { kind: string }
            fingerprint: unknown
          }
        }
      }
    }
    const selection = inspection.projection.result.selection
    const registrationIntent = {
      type: 'register-development-project',
      intentId: 'intent-11111111-1111-4111-8111-111111111111',
      projectTitle: 'Snapshot project',
      hostId,
      directoryLocator: repository,
      expectedRegistryRevision: initialIndex.projection.revision,
      confirmedFingerprint: selection.fingerprint,
      confirmedBaseline: selection.baseline,
    } as const
    const registration = await rpc(
      port,
      'control/submit',
      registrationIntent,
      { cookie, requestToken: exchangeValue.access.requestToken },
    )
    const confirmed = registration.value as {
      ok: true
      receipt: {
        id: string
        intentId: string
        state: 'confirmed'
        projectId: string
        resourceBindingId: string
        registryRevision: number
      }
    }
    const registeredIndexResponse = await rpc(port, 'control/query', { type: 'project-index' }, { cookie })
    const registeredIndex = registeredIndexResponse.value as {
      ok: true
      projection: {
        revision: number
        hosts: readonly unknown[]
        projects: [{
          id: string
          projectTitle: string
          binding: {
            id: string
            health: string
            displayLocation: string
            head: string
            branch?: string
            detached: boolean
            inheritedChangeEntryCount: number
            baseline: string
            automaticMutationEligible: boolean
            configurationGaps: readonly string[]
          }
        }]
      }
    }
    const developmentResponse = await rpc(port, 'control/query', {
      type: 'development-workspace',
      projectId: confirmed.receipt.projectId,
      expectedRegistryRevision: confirmed.receipt.registryRevision,
    }, { cookie })
    const development = developmentResponse.value as {
      ok: true
      projection: {
        registryRevision: number
        project: { projectTitle: string }
        currentSelection?: { inheritedChangeEntryCount: number; workspaceId?: string }
        recovery: { state: string; reasons: readonly string[] }
      }
    }
    const registeredProject = registeredIndex.projection.projects[0]
    const summarizeBinding = (binding: typeof registeredProject.binding) => ({
      health: binding.health,
      displayLocation: binding.displayLocation,
      head: binding.head === '' ? 'absent' : 'present',
      branch: binding.branch === undefined ? 'absent' : 'present',
      detached: binding.detached,
      inheritedChangeEntryCount: binding.inheritedChangeEntryCount,
      baseline: binding.baseline,
      automaticMutationEligible: binding.automaticMutationEligible,
      configurationGaps: binding.configurationGaps,
    })
    const records: unknown[] = [
      { step: 'first-launcher', purpose: first.bootstrapPurpose },
      { step: 'first-access', access: initial.value },
      { step: 'bootstrap-exchange', ok: exchangeValue.ok, cookie: 'set' },
      {
        step: 'initial-project-index',
        result: {
          ok: initialIndex.ok,
          revision: initialIndex.projection.revision,
          hosts: initialIndex.projection.hosts.length,
          projects: initialIndex.projection.projects.length,
        },
      },
      {
        step: 'project-inspection',
        result: {
          ok: inspection.ok,
          displayLocation: selection.displayLocation,
          detached: selection.detached,
          inheritedChangeEntryCount: selection.inheritedChangeEntryCount,
          baseline: selection.baseline.kind,
          automaticMutationEligible: selection.automaticMutationEligible,
          workspace: selection.workspaceId === undefined ? 'absent' : 'present',
        },
      },
      {
        step: 'project-registration',
        result: {
          ok: confirmed.ok,
          state: confirmed.receipt.state,
          registryRevision: confirmed.receipt.registryRevision,
        },
      },
      {
        step: 'registered-project-index',
        result: {
          revision: registeredIndex.projection.revision,
          hosts: registeredIndex.projection.hosts.length,
          projects: registeredIndex.projection.projects.length,
          projectTitle: registeredProject.projectTitle,
          binding: summarizeBinding(registeredProject.binding),
        },
      },
      {
        step: 'development-workspace',
        result: {
          revision: development.projection.registryRevision,
          projectTitle: development.projection.project.projectTitle,
          recovery: development.projection.recovery,
          current: {
            inheritedChangeEntryCount: development.projection.currentSelection?.inheritedChangeEntryCount,
            workspace: development.projection.currentSelection?.workspaceId === undefined ? 'absent' : 'present',
          },
        },
      },
    ]
    await first.stop()
    first = undefined

    second = await startSaki(entry, databasePath, port, true, runtimeRoot)
    const restoredAccess = await rpc(port, 'access/read', {}, { cookie })
    const safeAccess = restoredAccess.value as {
      kind: string
      principal?: { displayName?: string }
      expiresAt?: number
      requestToken?: string
    }
    if (safeAccess.requestToken === undefined) throw new Error('Saki snapshot restored no request token')
    const replay = await rpc(port, 'control/submit', registrationIntent, {
      cookie,
      requestToken: safeAccess.requestToken,
    })
    const replayed = replay.value as typeof confirmed
    expect(replayed.receipt).toEqual(confirmed.receipt)
    const restoredQuery = await rpc(port, 'control/query', { type: 'project-index' }, { cookie })
    const restoredIndex = restoredQuery.value as typeof registeredIndex
    const restoredDevelopmentResponse = await rpc(port, 'control/query', {
      type: 'development-workspace',
      projectId: confirmed.receipt.projectId,
      expectedRegistryRevision: confirmed.receipt.registryRevision,
    }, { cookie })
    const restoredDevelopment = restoredDevelopmentResponse.value as typeof development
    const restoredProject = restoredIndex.projection.projects[0]
    expect(restoredProject.id).toBe(confirmed.receipt.projectId)
    expect(restoredProject.binding.id).toBe(confirmed.receipt.resourceBindingId)
    expect(restoredDevelopment.projection.currentSelection?.workspaceId)
      .toBe(development.projection.currentSelection?.workspaceId)
    records.push(
      { step: 'restart-launcher', purpose: second.bootstrapPurpose },
      {
        step: 'restart-access',
        access: {
          kind: safeAccess.kind,
          principal: safeAccess.principal?.displayName,
          session: safeAccess.expiresAt === undefined ? 'absent' : 'restored',
          requestToken: 'derived',
        },
      },
      {
        step: 'restart-registration-replay',
        result: { state: replayed.receipt.state, sameReceipt: true },
      },
      {
        step: 'restart-project-index',
        result: {
          revision: restoredIndex.projection.revision,
          hosts: restoredIndex.projection.hosts.length,
          projects: restoredIndex.projection.projects.length,
          projectTitle: restoredProject.projectTitle,
          stableProjectId: true,
          stableBindingId: true,
          binding: summarizeBinding(restoredProject.binding),
        },
      },
      {
        step: 'restart-development-workspace',
        result: {
          revision: restoredDevelopment.projection.registryRevision,
          projectTitle: restoredDevelopment.projection.project.projectTitle,
          recovery: restoredDevelopment.projection.recovery,
          current: {
            inheritedChangeEntryCount: restoredDevelopment.projection.currentSelection?.inheritedChangeEntryCount,
            workspace: restoredDevelopment.projection.currentSelection?.workspaceId === undefined ? 'absent' : 'present',
            stableWorkspaceId: true,
          },
        },
      },
    )
    const output = `${records.map(record => JSON.stringify(record)).join('\n')}\n`
    for (const sensitive of [directory, repository, bootstrapSecret, cookie, exchangeValue.access.requestToken]) {
      if (sensitive !== undefined) expect(output).not.toContain(sensitive)
    }
    await second.stop()
    second = undefined
    return output
  }, async () => { await cleanupSnapshot(directory, first, second) })
}

async function verify(entry: string): Promise<void> {
  const output = await transcript(entry)
  if (refreshing) {
    await mkdir(dirname(expected), { recursive: true })
    await writeFile(expected, output)
  } else {
    await access(expected)
  }
  await expect(output).toMatchFileSnapshot(expected)
}

describe('authenticated Saki bundle snapshot', () => {
  it('scrubs mixed-case ambient credentials from child processes', () => {
    const key = 'sAkI_SnApShOt_CaNaRy_ToKeN'
    process.env[key] = 'secret'
    try {
      expect(sakiSnapshotEnvironment()[key]).toBeUndefined()
    } finally {
      Reflect.deleteProperty(process.env, key)
    }
  })

  it('isolates fixture Git from mixed-case ambient control variables', () => {
    const key = 'gIt_WoRk_TrEe'
    process.env[key] = 'untrusted'
    try {
      const environment = fixtureGitEnvironment()
      expect(environment[key]).toBeUndefined()
      expect(environment.GIT_CONFIG_GLOBAL).toBe(nullConfig)
      expect(environment.GIT_CONFIG_NOSYSTEM).toBe('1')
      expect(environment.GIT_TERMINAL_PROMPT).toBe('0')
    } finally {
      Reflect.deleteProperty(process.env, key)
    }
  })

  it('runs the source bundle through bootstrap, query, and restart', async () => {
    await verify(sourceBin)
  })

  it.skipIf(!existsSync(builtBin))('runs the built bundle through the same Host transport', async () => {
    await verify(builtBin)
  })

  it.skipIf(!existsSync(builtBin))('keeps built pre-dispatch failures inside the Saki rejection policy', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'saki-bootstrap-snapshot-'))
    let started: StartedSaki | undefined
    await runWithCleanup(async () => {
      const port = await freePort()
      const runtimeRoot = join(directory, 'runtime')
      await mkdir(runtimeRoot, { recursive: true })
      started = await startSaki(builtBin, join(directory, 'control.sqlite'), port, true, runtimeRoot)
      const sentinel = 'credential-sentinel'
      for (const method of ['GET', 'HEAD'] as const) {
        const response = await rawRequest(port, method, sentinel)
        expect(response.status).toBe(400)
        expect(response.headers['cache-control']).toBe('no-store')
        expect(response.body).toBe(method === 'HEAD' ? '' : 'Saki request is unavailable')
        expect(response.body).not.toContain(sentinel)
      }
      const trace = await rawRequest(port, 'TRACE')
      expect(trace.status).toBe(400)
      expect(trace.headers['cache-control']).toBe('no-store')
      expect(trace.body).toBe('Saki request is unavailable')
      await started.stop()
      started = undefined
    }, async () => { await cleanupSnapshot(directory, started) })
  })
})
