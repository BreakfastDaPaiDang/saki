/** Shared real-process harness for Saki Host snapshots. */

import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { expect } from 'vitest'
import type { ProjectGitHead } from '@breakfastdapaidang/saki-execution'
import { sakiSnapshotEnvironment } from '../saki-snapshot-environment.ts'

const SNAPSHOT_RPC_TIMEOUT_MS = 30_000

const root = resolve(import.meta.dirname, '../..')
const tsxLoader = import.meta.resolve('tsx/esm')
const run = promisify(execFile)
const nullConfig = process.platform === 'win32' ? 'NUL' : '/dev/null'

/** Running Saki child and the safe launcher handoff captured from stdout. */
export interface StartedSaki {
  readonly child: ChildProcessWithoutNullStreams
  readonly bootstrapPurpose?: 'initial-bootstrap' | 'local-reauthentication'
  readonly bootstrapSecret?: string
  readonly records: readonly unknown[]
  readonly stop: () => Promise<void>
}

/** Narrow fixture controls explicitly supplied to one Saki child. */
export interface SakiSnapshotStartOptions {
  readonly agentRunSnapshot?: boolean
  readonly boardProviderEnabled?: boolean
  readonly boardProviderStatePath?: string
}

/** Raw response retained for pre-dispatch HTTP rejection snapshots. */
export interface RawHttpResponse {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

/** Exact external-Git observation of the snapshot repository's HEAD, index, and worktree. */
export interface SnapshotRepositoryGitState {
  readonly headObjectId: string
  readonly headBlobObjectId: string
  readonly indexBlobObjectId: string
  readonly worktreeBlobObjectId: string
  readonly commitCount: number
  readonly stagedPaths: readonly string[]
  readonly unstagedPaths: readonly string[]
}

interface SnapshotProjectSelection {
  readonly displayLocation: string
  readonly objectFormat: 'sha1' | 'sha256'
  readonly head: ProjectGitHead
  readonly inheritedChangeEntryCount: number
  readonly automaticMutationEligible: boolean
  readonly workspaceId?: string
  readonly baseline: { readonly kind: string }
  readonly fingerprint: unknown
}

interface SnapshotProjectInspection {
  readonly ok: true
  readonly projection: {
    readonly result: {
      readonly ok: true
      readonly selection: SnapshotProjectSelection
    }
  }
}

/**
 * Return a Git process environment isolated from ambient user configuration and credentials.
 * @returns scrubbed Git subprocess environment.
 */
export function fixtureGitEnvironment(): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(sakiSnapshotEnvironment()).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
  )
  environment.GIT_CONFIG_GLOBAL = nullConfig
  environment.GIT_CONFIG_NOSYSTEM = '1'
  environment.GIT_TERMINAL_PROMPT = '0'
  environment.GIT_ASKPASS = ''
  return environment
}

function caughtError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message, { cause: value })
}

/**
 * Run one snapshot body and preserve both its failure and any cleanup failure.
 * @param body - snapshot operation.
 * @param cleanup - teardown that always runs after the operation.
 * @returns the snapshot operation result.
 */
export async function runWithCleanup<T>(body: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
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

/**
 * Stop every retained child and remove its temporary root.
 * @param directory - exact temporary root to remove.
 * @param started - retained child processes that may still be running.
 * @returns when all children and the temporary root have settled.
 */
export async function cleanupSnapshot(
  directory: string,
  ...started: readonly (StartedSaki | undefined)[]
): Promise<void> {
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

/**
 * Record or replay one deterministic file snapshot.
 * @param expectedPath - checked-in expected-output path.
 * @param output - deterministic snapshot transcript.
 * @param refreshing - whether to replace the expected output before matching.
 * @returns when the expected output matches.
 */
export async function verifySnapshotOutput(
  expectedPath: string,
  output: string,
  refreshing: boolean,
): Promise<void> {
  if (refreshing) {
    await mkdir(dirname(expectedPath), { recursive: true })
    await writeFile(expectedPath, output)
  } else {
    await access(expectedPath)
  }
  await expect(output).toMatchFileSnapshot(expectedPath)
}

/**
 * Serialize JSONL records and reject any caller-owned sensitive value.
 * @param records - stable snapshot records.
 * @param sensitiveValues - secrets and temporary paths that must not escape.
 * @returns newline-terminated scrubbed JSONL transcript.
 */
export function serializeSnapshotRecords(
  records: readonly unknown[],
  sensitiveValues: readonly (string | undefined)[],
): string {
  const output = `${records.map(record => JSON.stringify(record)).join('\n')}\n`
  for (const sensitive of sensitiveValues) {
    if (sensitive !== undefined) expect(output).not.toContain(sensitive)
  }
  return output
}

/**
 * Reserve and release one loopback port for the next Saki child.
 * @returns released loopback port number.
 */
export async function freePort(): Promise<number> {
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

/**
 * Start one source or built Saki entry and wait for readiness plus any required bootstrap handoff.
 * @param entry - source or built executable module.
 * @param databasePath - prepared SQLite state path.
 * @param port - released loopback port reserved for this child.
 * @param expectBootstrap - whether readiness also requires a launcher secret.
 * @param runtimeRoot - isolated child working directory.
 * @param options - narrow fixture controls for this child.
 * @returns running child and its launcher handoff.
 */
export async function startSaki(
  entry: string,
  databasePath: string,
  port: number,
  expectBootstrap: boolean,
  runtimeRoot: string,
  options: SakiSnapshotStartOptions = {},
): Promise<StartedSaki> {
  const source = entry.endsWith('.ts')
  const environment = sakiSnapshotEnvironment()
  environment.DSH_HOME = join(runtimeRoot, 'home')
  environment.SAKI_DATABASE_PATH = databasePath
  environment.SAKI_PORT = String(port)
  if (options.boardProviderStatePath !== undefined) {
    environment.SAKI_BOARD_SNAPSHOT_PROVIDER_STATE = options.boardProviderStatePath
  }
  if (options.boardProviderEnabled !== undefined) {
    environment.SAKI_BOARD_SNAPSHOT_PROVIDER_ENABLED = options.boardProviderEnabled ? '1' : '0'
  }
  if (options.agentRunSnapshot === true) environment.SAKI_AGENT_RUN_SNAPSHOT = '1'
  if (source) environment.TSX_TSCONFIG_PATH = join(root, 'tsconfig.json')
  const child = spawn(process.execPath, [
    ...(source ? ['--import', tsxLoader] : []),
    entry,
  ], {
    cwd: runtimeRoot,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
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
  let linesDidClose = false
  const linesClosed = new Promise<void>((resolveLinesClosed) => {
    lines.once('close', () => {
      linesDidClose = true
      resolveLinesClosed()
    })
  })
  let ready = false
  let bootstrapPurpose: 'initial-bootstrap' | 'local-reauthentication' | undefined
  let bootstrapSecret: string | undefined
  const records: unknown[] = []
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
    if (!childDidClose && child.exitCode === null && child.signalCode === null) {
      if (options.agentRunSnapshot === true) child.stdin.end()
      else child.kill('SIGTERM')
    }
    if (!await closesWithin(5_000)) {
      const forced = child.kill('SIGKILL')
      if (!await closesWithin(5_000)) throw new Error('Saki snapshot host did not close after SIGKILL')
      if (forced && failOnForcedTermination) throw new Error('Saki snapshot host required SIGKILL during normal teardown')
    }
    if (!linesDidClose) {
      await Promise.race([
        linesClosed,
        new Promise<void>(resolveDrain => setTimeout(resolveDrain, 1_000)),
      ])
    }
    if (!linesDidClose) lines.close()
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
          return
        }
        records.push(value)
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
    records,
    stop: async () => {
      await stopChild()
      expect(stderr).toBe('')
    },
  }
}

/**
 * Call one real `/saki` endpoint and unwrap its successful transport envelope.
 * @param port - Saki Host loopback port.
 * @param endpoint - logical `/saki` RPC endpoint.
 * @param payload - endpoint payload.
 * @param options - authenticated cookie and request token when required.
 * @returns raw response and successful business result.
 */
export async function rpc(
  port: number,
  endpoint: string,
  payload: unknown,
  options: { readonly cookie?: string; readonly requestToken?: string } = {},
): Promise<{ readonly response: Response; readonly value: unknown }> {
  const origin = `http://127.0.0.1:${String(port)}`
  const response = await fetch(`${origin}/saki/${endpoint}`, {
    method: 'POST',
    signal: AbortSignal.timeout(SNAPSHOT_RPC_TIMEOUT_MS),
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
  expect(envelope.result.ok, JSON.stringify(envelope.result)).toBe(true)
  return { response, value: envelope.result.value }
}

/**
 * Complete one real `/saki` RPC request but discard its business response after the first body bytes arrive.
 * @param port - Saki Host loopback port.
 * @param endpoint - logical `/saki` RPC endpoint.
 * @param payload - endpoint payload.
 * @param options - authenticated cookie and request token when required.
 * @returns transport evidence that the response began before the client discarded it.
 */
export async function dropRpcResponse(
  port: number,
  endpoint: string,
  payload: unknown,
  options: { readonly cookie?: string; readonly requestToken?: string } = {},
): Promise<{ readonly status: number; readonly discarded: 'after-first-byte' }> {
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: `snapshot-${endpoint}-discarded`,
    method: endpoint,
    payload,
  })
  return await new Promise<{ readonly status: number; readonly discarded: 'after-first-byte' }>((resolveRequest, reject) => {
    let settled = false
    const settleFailure = (error: Error): void => {
      if (settled) return
      settled = true
      reject(error)
    }
    const request = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: `/saki/${endpoint}`,
      method: 'POST',
      headers: {
        'content-length': String(Buffer.byteLength(body)),
        'content-type': 'application/json',
        origin: `http://127.0.0.1:${String(port)}`,
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
        ...(options.requestToken === undefined ? {} : { 'x-saki-request-token': options.requestToken }),
      },
    }, (response) => {
      const status = response.statusCode ?? 0
      response.once('error', settleFailure)
      response.once('data', (chunk: Buffer) => {
        if (settled) return
        if (status !== 200) {
          settleFailure(new Error(`Saki snapshot discarded RPC returned HTTP ${String(status)}`))
          return
        }
        if (chunk.byteLength === 0) {
          settleFailure(new Error('Saki snapshot discarded RPC returned an empty first body chunk'))
          return
        }
        settled = true
        resolveRequest({ status, discarded: 'after-first-byte' })
        response.destroy()
      })
      response.once('end', () => {
        if (!settled) settleFailure(new Error('Saki snapshot discarded RPC returned no body bytes'))
      })
    })
    request.setTimeout(SNAPSHOT_RPC_TIMEOUT_MS, () => {
      request.destroy(new Error('Saki snapshot discarded RPC timed out'))
    })
    request.once('error', settleFailure)
    request.end(body)
  })
}

/**
 * Bootstrap local access and register one deterministic Development Project.
 * @param port - Saki Host loopback port.
 * @param bootstrapSecret - one-use launcher secret.
 * @param repository - isolated Git repository to register.
 * @returns access, inspection, Intent, and confirmed registration values.
 */
export async function registerSnapshotProject(
  port: number,
  bootstrapSecret: string | undefined,
  repository: string,
): Promise<{
  readonly initial: Awaited<ReturnType<typeof rpc>>
  readonly exchangeValue: {
    readonly ok: true
    readonly access: { readonly kind: 'authenticated'; readonly requestToken: string }
  }
  readonly cookie: string
  readonly initialIndex: {
    readonly ok: true
    readonly projection: { readonly revision: number; readonly hosts: [{ readonly id: string }]; readonly projects: [] }
  }
  readonly inspection: SnapshotProjectInspection
  readonly selection: SnapshotProjectSelection
  readonly registrationIntent: {
    readonly type: 'register-development-project'
    readonly intentId: 'intent-11111111-1111-4111-8111-111111111111'
    readonly projectTitle: 'Snapshot project'
    readonly hostId: string
    readonly directoryLocator: string
    readonly expectedRegistryRevision: number
    readonly confirmedFingerprint: unknown
    readonly confirmedBaseline: { readonly kind: string }
  }
  readonly confirmed: {
    readonly ok: true
    readonly receipt: {
      readonly id: string
      readonly intentId: string
      readonly state: 'confirmed'
      readonly projectId: string
      readonly resourceBindingId: string
      readonly registryRevision: number
    }
  }
}> {
  const initial = await rpc(port, 'access/read', {})
  const exchange = await rpc(port, 'access/exchange', { secret: bootstrapSecret })
  const exchangeValue = exchange.value as {
    readonly ok: true
    readonly access: { readonly kind: 'authenticated'; readonly requestToken: string }
  }
  const cookie = exchange.response.headers.get('set-cookie')?.split(';', 1)[0]
  if (cookie === undefined) throw new Error('Saki snapshot exchange returned no session cookie')
  const query = await rpc(port, 'control/query', { type: 'project-index' }, { cookie })
  const initialIndex = query.value as {
    readonly ok: true
    readonly projection: { readonly revision: number; readonly hosts: [{ readonly id: string }]; readonly projects: [] }
  }
  const hostId = initialIndex.projection.hosts[0].id
  const inspected = await rpc(port, 'control/query', {
    type: 'inspect-project-selection',
    hostId,
    directoryLocator: repository,
  }, { cookie })
  const inspection = inspected.value as SnapshotProjectInspection
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
    readonly ok: true
    readonly receipt: {
      readonly id: string
      readonly intentId: string
      readonly state: 'confirmed'
      readonly projectId: string
      readonly resourceBindingId: string
      readonly registryRevision: number
    }
  }
  return {
    initial,
    exchangeValue,
    cookie,
    initialIndex,
    inspection,
    selection,
    registrationIntent,
    confirmed,
  }
}

/**
 * Send one raw request to the Saki access route without Host transport normalization.
 * @param port - Saki Host loopback port.
 * @param method - pre-dispatch HTTP method.
 * @param body - optional rejection sentinel.
 * @returns raw status, headers, and body.
 */
export async function rawRequest(
  port: number,
  method: 'GET' | 'HEAD' | 'TRACE',
  body?: string,
): Promise<RawHttpResponse> {
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

/**
 * Re-read the snapshot repository through an isolated external Git process.
 * @param repository - exact snapshot repository root.
 * @returns independent HEAD, index, worktree, and diff evidence for `tracked.txt`.
 */
export async function inspectSnapshotRepositoryGitState(
  repository: string,
): Promise<SnapshotRepositoryGitState> {
  const environment = fixtureGitEnvironment()
  const gitText = async (arguments_: readonly string[]): Promise<string> => {
    const { stdout } = await run('git', [
      '--no-pager',
      '--no-optional-locks',
      '-c', 'core.hooksPath=',
      '-c', 'core.autocrlf=false',
      ...arguments_,
    ], { cwd: repository, env: environment, timeout: 20_000, windowsHide: true, encoding: 'utf8' })
    return stdout.trim()
  }
  const objectId = (value: string, label: string): string => {
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value)) {
      throw new Error(`Saki snapshot external Git returned an invalid ${label}`)
    }
    return value
  }
  const paths = (value: string): readonly string[] => value === '' ? [] : value.split('\n')
  const indexEntry = await gitText(['ls-files', '--stage', '--', 'tracked.txt'])
  const indexMatch = /^[0-7]{6} ([0-9a-f]{40}(?:[0-9a-f]{24})?) 0\ttracked\.txt$/.exec(indexEntry)
  if (indexMatch?.[1] === undefined) throw new Error('Saki snapshot external Git returned an invalid index entry')
  const commitCountText = await gitText(['rev-list', '--count', 'HEAD'])
  const commitCount = Number(commitCountText)
  if (!Number.isSafeInteger(commitCount) || commitCount < 1) {
    throw new Error('Saki snapshot external Git returned an invalid Commit count')
  }
  return {
    headObjectId: objectId(await gitText(['rev-parse', '--verify', 'HEAD']), 'HEAD object id'),
    headBlobObjectId: objectId(await gitText(['rev-parse', '--verify', 'HEAD:tracked.txt']), 'HEAD blob object id'),
    indexBlobObjectId: objectId(indexMatch[1], 'index blob object id'),
    worktreeBlobObjectId: objectId(
      await gitText(['hash-object', '--no-filters', '--', 'tracked.txt']),
      'worktree blob object id',
    ),
    commitCount,
    stagedPaths: paths(await gitText(['diff', '--cached', '--name-only', '--'])),
    unstagedPaths: paths(await gitText(['diff', '--name-only', '--'])),
  }
}

/**
 * Create one isolated clean Git repository accepted by the Saki registration flow.
 * @param directory - temporary parent directory.
 * @returns absolute repository path.
 */
export async function createRepository(directory: string): Promise<string> {
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
  await git(['config', '--local', 'user.name', 'Saki Snapshot'], repository)
  await git(['config', '--local', 'user.email', 'saki@example.invalid'], repository)
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
