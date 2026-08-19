/** Keyless source-and-artifact snapshot for authenticated B01 access over the real `/saki` transport. */

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync } from 'node:fs'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const sourceBin = join(root, 'packages/saki/bundle/src/bin.ts')
const builtBin = join(root, 'packages/saki/bundle/lib/bin.js')
const expected = join(root, 'scripts/snapshots/saki-bootstrap/access.expected.jsonl')
const refreshing = process.env.DSH_SNAPSHOT === 'record' || process.env.DSH_SNAPSHOT === 'refresh'

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
): Promise<StartedSaki> {
  const source = entry.endsWith('.ts')
  const child = spawn(process.execPath, [
    ...(source ? ['--import', 'tsx/esm'] : []),
    entry,
  ], {
    cwd: root,
    env: {
      ...process.env,
      SAKI_DATABASE_PATH: databasePath,
      SAKI_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  const lines = createInterface({ input: child.stdout })
  let ready = false
  let bootstrapPurpose: 'initial-bootstrap' | 'local-reauthentication' | undefined
  let bootstrapSecret: string | undefined
  await new Promise<void>((resolveReady, reject) => {
    const timeout = setTimeout(() => { reject(new Error('Saki snapshot startup timed out')) }, 20_000)
    const complete = (): void => {
      if (!ready || (expectBootstrap && bootstrapSecret === undefined)) return
      clearTimeout(timeout)
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
    child.once('exit', () => {
      clearTimeout(timeout)
      reject(new Error(`Saki snapshot host exited before readiness${stderr === '' ? '' : ': stderr was non-empty'}`))
    })
  })
  return {
    child,
    ...(bootstrapPurpose === undefined ? {} : { bootstrapPurpose }),
    ...(bootstrapSecret === undefined ? {} : { bootstrapSecret }),
    stop: async () => {
      if (child.exitCode !== null) return
      const exited = new Promise<void>(resolveExit => child.once('exit', () => { resolveExit() }))
      child.kill('SIGTERM')
      await exited
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

async function transcript(entry: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'saki-bootstrap-snapshot-'))
  const databasePath = join(directory, 'control.sqlite')
  const port = await freePort()
  let first: StartedSaki | undefined
  let second: StartedSaki | undefined
  try {
    first = await startSaki(entry, databasePath, port, true)
    const initial = await rpc(port, 'access/read', {})
    const exchange = await rpc(port, 'access/exchange', { secret: first.bootstrapSecret })
    const exchangeValue = exchange.value as {
      ok: true
      access: { kind: 'authenticated'; requestToken: string }
    }
    const cookie = exchange.response.headers.get('set-cookie')?.split(';', 1)[0]
    if (cookie === undefined) throw new Error('Saki snapshot exchange returned no session cookie')
    const query = await rpc(port, 'control/query', { type: 'project-index' }, { cookie })
    const records: unknown[] = [
      { step: 'first-launcher', purpose: first.bootstrapPurpose },
      { step: 'first-access', access: initial.value },
      { step: 'bootstrap-exchange', ok: exchangeValue.ok, cookie: 'set' },
      { step: 'project-index', result: query.value },
    ]
    await first.stop()
    first = undefined

    second = await startSaki(entry, databasePath, port, true)
    const restoredAccess = await rpc(port, 'access/read', {}, { cookie })
    const restoredQuery = await rpc(port, 'control/query', { type: 'project-index' }, { cookie })
    const safeAccess = restoredAccess.value as {
      kind: string
      principal?: { displayName?: string }
      expiresAt?: number
      requestToken?: string
    }
    records.push(
      { step: 'restart-launcher', purpose: second.bootstrapPurpose },
      {
        step: 'restart-access',
        access: {
          kind: safeAccess.kind,
          principal: safeAccess.principal?.displayName,
          session: safeAccess.expiresAt === undefined ? 'absent' : 'restored',
          requestToken: safeAccess.requestToken === undefined ? 'absent' : 'derived',
        },
      },
      { step: 'restart-project-index', result: restoredQuery.value },
    )
    return `${records.map(record => JSON.stringify(record)).join('\n')}\n`
  } finally {
    await first?.stop()
    await second?.stop()
    await rm(directory, { recursive: true, force: true })
  }
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
  it('runs the source bundle through bootstrap, query, and restart', async () => {
    await verify(sourceBin)
  })

  it.skipIf(!existsSync(builtBin))('runs the built bundle through the same Host transport', async () => {
    await verify(builtBin)
  })

  it.skipIf(!existsSync(builtBin))('keeps built pre-dispatch failures inside the Saki rejection policy', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'saki-bootstrap-snapshot-'))
    const port = await freePort()
    let started: StartedSaki | undefined
    try {
      started = await startSaki(builtBin, join(directory, 'control.sqlite'), port, true)
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
    } finally {
      await started?.stop()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
