import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import type { StorageBackend } from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import SakiControlPlane, {
  type AccessProjection,
  type SakiControlPlaneModule,
} from '../src/index.ts'
import {
  resolveSakiAuthentication,
  takeSakiCookieHeader,
} from '../src/host.ts'
import {
  FOUNDATION_KEY,
  sakiControlPlaneDomainSpec,
} from '../src/spec.ts'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'

const ORIGIN = 'http://127.0.0.1:43119'
const COOKIE_NAME = 'saki_session'
const tempDirectories: string[] = []

interface RunningHarness {
  readonly ctx: Context
  readonly controlPlane: SakiControlPlaneModule
  readonly close: () => Promise<void>
}

async function start(databasePath: string): Promise<RunningHarness> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageSqlite, { path: databasePath, journalMode: 'delete' })
  await ctx.plugin(StorageDomain, { backend: 'sqlite' })
  const fiber = await ctx.plugin(SakiControlPlane, {
    origin: ORIGIN,
    challengeTtlMs: 60_000,
    sessionTtlMs: 3_600_000,
    terminalRetentionMs: 86_400_000,
    cookieName: COOKIE_NAME,
  })
  return {
    ctx,
    controlPlane: ctx.sakiControlPlane,
    close: async () => {
      await fiber.dispose()
      await ctx.fiber.dispose()
    },
  }
}

async function startWithExchangeWriteFailure(
  databasePath: string,
  failure: 'before-commit' | 'after-commit',
): Promise<RunningHarness> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const inner = new StorageSqlite.SqliteStorageBackend({ path: databasePath, journalMode: 'delete' })
  let puts = 0
  let injected = false
  const backend: StorageBackend = {
    kv: {
      open: async (descriptor) => {
        const unit = await inner.kv.open(descriptor)
        return {
          loadAll: () => unit.loadAll(),
          putRecord: async (table, key, value) => {
            puts += 1
            const selected = puts === 3 && !injected
            if (selected && failure === 'before-commit') {
              injected = true
              throw new Error('selected access durability interruption')
            }
            await unit.putRecord(table, key, value)
            if (selected && failure === 'after-commit') {
              injected = true
              throw new Error('selected access durability interruption')
            }
          },
          deleteRecord: (table, key) => unit.deleteRecord(table, key),
          setGlobal: value => unit.setGlobal(value),
          close: () => unit.close(),
        }
      },
    },
    close: () => inner.close(),
  }
  ctx.storage.backend.register('sqlite', backend)
  const facility = new StorageDomain.DomainFacility(ctx, { backend: 'sqlite', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  ctx.effect(() => async () => {
    await facility.closeAll()
    await backend.close()
  })
  const fiber = await ctx.plugin(SakiControlPlane, {
    origin: ORIGIN,
    challengeTtlMs: 60_000,
    sessionTtlMs: 3_600_000,
    terminalRetentionMs: 86_400_000,
    cookieName: COOKIE_NAME,
  })
  return {
    ctx,
    controlPlane: ctx.sakiControlPlane,
    close: async () => {
      await fiber.dispose()
      await ctx.fiber.dispose()
    },
  }
}

function accessDomain(running: RunningHarness): Domain<typeof sakiControlPlaneDomainSpec> {
  return running.ctx.storageDomain.get(sakiControlPlaneDomainSpec.name) as unknown as
    Domain<typeof sakiControlPlaneDomainSpec>
}

async function database(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'saki-b01-'))
  tempDirectories.push(directory)
  return join(directory, 'control.sqlite')
}

function rawCookie(header: string): string {
  const pair = header.split(';', 1)[0]
  expect(pair).toMatch(new RegExp(`^${COOKIE_NAME}=`))
  return pair!.slice(COOKIE_NAME.length + 1)
}

async function bootstrap(controlPlane: SakiControlPlaneModule): Promise<{
  readonly cookie: string
  readonly access: Extract<AccessProjection, { readonly kind: 'authenticated' }>
  readonly secret: string
}> {
  const handoff = controlPlane.bootstrap.take()
  expect(handoff).toBeDefined()
  const secret = handoff!.consume()
  const exchange = await controlPlane.access.exchangeBootstrap(
    { origin: ORIGIN },
    { secret },
    new AbortController().signal,
  )
  expect(exchange).toMatchObject({ ok: true, access: { kind: 'authenticated' } })
  const cookieHeader = takeSakiCookieHeader(exchange)
  expect(cookieHeader).toContain('HttpOnly')
  expect(cookieHeader).toContain('SameSite=Strict')
  expect(cookieHeader).toContain('Path=/saki')
  expect(JSON.stringify(exchange)).not.toContain(secret)
  return {
    cookie: rawCookie(cookieHeader!),
    access: (exchange as Extract<typeof exchange, { readonly ok: true }>).access,
    secret,
  }
}

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(tempDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Saki Installation access', () => {
  it('redacts the process-local Bootstrap handoff from diagnostics', async () => {
    const running = await start(await database())
    const handoff = running.controlPlane.bootstrap.take()!
    const diagnostic = inspect(handoff, { showHidden: true })
    const enumerableValues = Object.values(handoff)
    const serialized = JSON.stringify(handoff)
    const rendered = String(handoff)
    const secret = handoff.consume()
    await running.close()
    expect(diagnostic).not.toContain(secret)
    expect(enumerableValues).not.toContain(secret)
    expect(serialized).not.toContain(secret)
    expect(rendered).not.toContain(secret)
  })

  it('persists independent Installation and Local Host identities across restart', async () => {
    const path = await database()
    const first = await start(path)
    const firstIdentity = first.controlPlane.identity()
    expect(firstIdentity.installationId).not.toBe(firstIdentity.hostId)
    await bootstrap(first.controlPlane)
    await first.close()

    const second = await start(path)
    expect(second.controlPlane.identity()).toEqual(firstIdentity)
    expect(second.controlPlane.bootstrap.take()).toBeUndefined()
    await second.close()
  })

  it('preserves an unexpired issued challenge across a normal restart', async () => {
    const path = await database()
    const first = await start(path)
    const oldSecret = first.controlPlane.bootstrap.take()!.consume()
    await first.close()

    const second = await start(path)
    const access = accessDomain(second).table('installation_access').get('installation-access')!
    expect(access.challenges.map(challenge => challenge.state)).toEqual(['issued'])
    expect(second.controlPlane.bootstrap.take()).toBeUndefined()
    expect(await second.controlPlane.access.exchangeBootstrap(
      { origin: ORIGIN }, { secret: oldSecret }, AbortSignal.timeout(1_000),
    )).toMatchObject({ ok: true })
    await second.close()
  })

  it('atomically consumes one challenge and permits at most one concurrent session', async () => {
    const running = await start(await database())
    const handoff = running.controlPlane.bootstrap.take()!
    const secret = handoff.consume()
    const attempts = await Promise.all([
      running.controlPlane.access.exchangeBootstrap({ origin: ORIGIN }, { secret }, AbortSignal.timeout(1_000)),
      running.controlPlane.access.exchangeBootstrap({ origin: ORIGIN }, { secret }, AbortSignal.timeout(1_000)),
    ])
    expect(attempts.filter(result => result.ok)).toHaveLength(1)
    expect(attempts.filter(result => !result.ok)).toEqual([{ ok: false, reason: 'unavailable' }])
    const success = attempts.find(result => result.ok)!
    expect(takeSakiCookieHeader(success)).toContain(`${COOKIE_NAME}=`)
    expect(takeSakiCookieHeader(success)).toBeUndefined()
    expect(await running.controlPlane.access.exchangeBootstrap(
      { origin: ORIGIN }, { secret }, AbortSignal.timeout(1_000),
    )).toEqual({ ok: false, reason: 'unavailable' })
    const stored = accessDomain(running).table('installation_access').get('installation-access')!
    expect(stored.challenges).toHaveLength(1)
    expect(stored.sessions).toHaveLength(1)
    expect(stored.challenges[0]).toMatchObject({
      state: 'consumed',
      browserSessionId: stored.sessions[0]!.id,
      installationId: stored.sessions[0]!.installationId,
      principalId: stored.sessions[0]!.principalId,
    })
    expect(stored.sessions[0]!.state).toBe('active')
    await running.close()
  })

  it('survives response loss and restart without reopening the consumed challenge', async () => {
    const path = await database()
    const first = await start(path)
    const { cookie, secret } = await bootstrap(first.controlPlane)
    await first.close()

    const second = await start(path)
    expect(second.controlPlane.bootstrap.take()).toBeUndefined()
    expect(await second.controlPlane.access.exchangeBootstrap(
      { origin: ORIGIN }, { secret }, AbortSignal.timeout(1_000),
    )).toEqual({ ok: false, reason: 'unavailable' })
    expect(await second.controlPlane.access.readAccess(cookie, AbortSignal.timeout(1_000)))
      .toMatchObject({ kind: 'authenticated' })
    await second.close()
  })

  it('keeps the challenge issued on a pre-commit interruption and consumes it on retry', async () => {
    const running = await startWithExchangeWriteFailure(await database(), 'before-commit')
    const secret = running.controlPlane.bootstrap.take()!.consume()
    await expect(running.controlPlane.access.exchangeBootstrap(
      { origin: ORIGIN }, { secret }, AbortSignal.timeout(1_000),
    )).rejects.toThrow('selected access durability interruption')
    expect(accessDomain(running).table('installation_access').get('installation-access')!
      .challenges.at(-1)?.state).toBe('issued')
    expect((await running.controlPlane.access.exchangeBootstrap(
      { origin: ORIGIN }, { secret }, AbortSignal.timeout(1_000),
    )).ok).toBe(true)
    await running.close()
  })

  it('keeps the committed challenge consumed after a post-commit interruption and restart', async () => {
    const path = await database()
    const first = await startWithExchangeWriteFailure(path, 'after-commit')
    const secret = first.controlPlane.bootstrap.take()!.consume()
    await expect(first.controlPlane.access.exchangeBootstrap(
      { origin: ORIGIN }, { secret }, AbortSignal.timeout(1_000),
    )).rejects.toThrow('selected access durability interruption')
    await first.close()

    const second = await start(path)
    expect(second.controlPlane.bootstrap.take()).toBeUndefined()
    expect(await second.controlPlane.access.exchangeBootstrap(
      { origin: ORIGIN }, { secret }, AbortSignal.timeout(1_000),
    )).toEqual({ ok: false, reason: 'unavailable' })
    const stored = accessDomain(second).table('installation_access').get('installation-access')!
    expect(stored.challenges.at(-1)?.state).toBe('consumed')
    expect(stored.sessions).toHaveLength(1)
    expect(stored.sessions[0]!.state).toBe('active')
    await second.close()
  })

  it('returns an authenticated empty Project index and revalidates the current Grant', async () => {
    const running = await start(await database())
    const { cookie } = await bootstrap(running.controlPlane)
    const resolution = await resolveSakiAuthentication(
      running.controlPlane,
      cookie,
      { origin: ORIGIN, mutation: false },
      AbortSignal.timeout(1_000),
    )
    expect(resolution.ok).toBe(true)
    if (!resolution.ok) throw new Error('authentication unexpectedly failed')
    expect(await running.controlPlane.query(
      resolution.authentication,
      { type: 'project-index' },
      AbortSignal.timeout(1_000),
    )).toEqual({
      ok: true,
      projection: { type: 'project-index', revision: 0, projects: [] },
    })

    const domain = running.ctx.storageDomain.get(sakiControlPlaneDomainSpec.name) as
      | Domain<typeof sakiControlPlaneDomainSpec>
      | undefined
    await domain!.table('foundation').update(FOUNDATION_KEY, current => ({
      ...current,
      grant: { ...current.grant, revision: current.grant.revision + 1, state: 'revoked' },
    }))
    expect(await running.controlPlane.query(
      resolution.authentication,
      { type: 'project-index' },
      AbortSignal.timeout(1_000),
    )).toEqual({ ok: false, reason: 'denied' })
    expect(await running.controlPlane.submit(
      resolution.authentication,
      undefined,
      AbortSignal.timeout(1_000),
    )).toEqual({ ok: false, reason: 'denied' })
    expect(await running.controlPlane.access.readAccess(cookie, AbortSignal.timeout(1_000)))
      .toMatchObject({ kind: 'authenticated' })
    await running.close()
  })

  it('contains Projection listener failures and continues notifying later subscribers', async () => {
    const running = await start(await database())
    const observed: (readonly string[])[] = []
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
    running.controlPlane.onChanged(() => { throw new Error('selected listener failure') })
    running.controlPlane.onChanged((keys) => { observed.push(keys) })

    await accessDomain(running).table('foundation').update(FOUNDATION_KEY, current => ({
      ...current,
      grant: { ...current.grant, revision: current.grant.revision + 1 },
    }))

    await running.close()
    expect(observed).toEqual([['access', 'project-index']])
    expect(diagnostic).toHaveBeenCalledWith(
      '[saki-control-plane] Projection listener threw:',
      expect.objectContaining({ message: 'selected listener failure' }),
    )
  })

  it('keeps an explicitly revoked Browser Session unavailable across restart', async () => {
    const path = await database()
    const first = await start(path)
    const { cookie } = await bootstrap(first.controlPlane)
    await accessDomain(first).table('installation_access').update('installation-access', current => ({
      ...current,
      revision: current.revision + 1,
      sessions: current.sessions.map(session => ({
        ...session,
        revision: session.revision + 1,
        state: 'revoked' as const,
        terminalAt: Date.now(),
      })),
    }))
    expect(await first.controlPlane.access.readAccess(cookie, AbortSignal.timeout(1_000)))
      .toEqual({ kind: 'session-required', message: 'A local browser session is required.' })
    await first.close()

    const second = await start(path)
    expect(await second.controlPlane.access.readAccess(cookie, AbortSignal.timeout(1_000)))
      .toEqual({ kind: 'session-required', message: 'A local browser session is required.' })
    await second.close()
  })

  it.each(['principal-retirement', 'generation-replacement'] as const)(
    'invalidates the Browser Session after %s without reviving it',
    async (scenario) => {
      const running = await start(await database())
      const { cookie } = await bootstrap(running.controlPlane)
      await accessDomain(running).table('foundation').update(FOUNDATION_KEY, current => scenario === 'principal-retirement'
        ? { ...current, principal: { ...current.principal, state: 'retired' } }
        : {
          ...current,
          installation: {
            ...current.installation,
            generationId: `${current.installation.generationId}-replacement` as typeof current.installation.generationId,
          },
        })
      expect(await running.controlPlane.access.readAccess(cookie, AbortSignal.timeout(1_000)))
        .toEqual({ kind: 'session-required', message: 'A local browser session is required.' })
      expect(accessDomain(running).table('installation_access').get('installation-access')!
        .sessions.at(-1)?.state).toBe('revoked')
      await running.close()
    },
  )

  it('requires the exact origin and session-derived request token for logout', async () => {
    const running = await start(await database())
    const { cookie, access } = await bootstrap(running.controlPlane)
    expect(await resolveSakiAuthentication(
      running.controlPlane,
      cookie,
      { origin: 'http://127.0.0.1:1', mutation: true, requestToken: access.requestToken },
      AbortSignal.timeout(1_000),
    )).toEqual({ ok: false, reason: 'unavailable' })
    expect(await resolveSakiAuthentication(
      running.controlPlane,
      cookie,
      { origin: ORIGIN, mutation: true, requestToken: `${access.requestToken}x` },
      AbortSignal.timeout(1_000),
    )).toEqual({ ok: false, reason: 'unavailable' })

    const resolution = await resolveSakiAuthentication(
      running.controlPlane,
      cookie,
      { origin: ORIGIN, mutation: true, requestToken: access.requestToken },
      AbortSignal.timeout(1_000),
    )
    if (!resolution.ok) throw new Error('authentication unexpectedly failed')
    const logout = await running.controlPlane.access.logoutCurrentSession(
      resolution.authentication,
      access.requestToken,
      AbortSignal.timeout(1_000),
    )
    expect(logout).toEqual({ ok: true })
    expect(takeSakiCookieHeader(logout)).toContain('Max-Age=0')
    expect(await running.controlPlane.access.readAccess(cookie, AbortSignal.timeout(1_000)))
      .toEqual({ kind: 'session-required', message: 'A local browser session is required.' })
    await running.close()
  })

  it('uses the server clock for terminal expiry and never revives an expired session', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-19T00:00:00.000Z'))
    const path = await database()
    const first = await start(path)
    const { cookie } = await bootstrap(first.controlPlane)
    vi.advanceTimersByTime(3_600_001)
    expect(await first.controlPlane.access.readAccess(cookie, AbortSignal.timeout(1_000)))
      .toEqual({ kind: 'session-required', message: 'A local browser session is required.' })
    vi.setSystemTime(new Date('2026-08-19T00:30:00.000Z'))
    expect(await first.controlPlane.access.readAccess(cookie, AbortSignal.timeout(1_000)))
      .toEqual({ kind: 'session-required', message: 'A local browser session is required.' })
    await first.close()

    const second = await start(path)
    expect(await second.controlPlane.access.readAccess(cookie, AbortSignal.timeout(1_000)))
      .toEqual({ kind: 'session-required', message: 'A local browser session is required.' })
    await second.close()
  })

  it('expires a Bootstrap Challenge by server time and rejects it after clock rollback', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-19T00:00:00.000Z'))
    const running = await start(await database())
    const secret = running.controlPlane.bootstrap.take()!.consume()
    vi.advanceTimersByTime(60_001)
    expect(await running.controlPlane.access.exchangeBootstrap(
      { origin: ORIGIN }, { secret }, AbortSignal.timeout(1_000),
    )).toEqual({ ok: false, reason: 'unavailable' })
    expect(accessDomain(running).table('installation_access').get('installation-access')!
      .challenges.at(-1)?.state).toBe('expired')
    vi.setSystemTime(new Date('2026-08-18T23:59:00.000Z'))
    expect(await running.controlPlane.access.exchangeBootstrap(
      { origin: ORIGIN }, { secret }, AbortSignal.timeout(1_000),
    )).toEqual({ ok: false, reason: 'unavailable' })
    await running.close()
  })

  it('cleans only terminal access evidence after the retention interval', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-19T00:00:00.000Z'))
    const running = await start(await database())
    const { cookie, access } = await bootstrap(running.controlPlane)
    const resolution = await resolveSakiAuthentication(
      running.controlPlane,
      cookie,
      { origin: ORIGIN, mutation: true, requestToken: access.requestToken },
      AbortSignal.timeout(1_000),
    )
    if (!resolution.ok) throw new Error('authentication unexpectedly failed')
    await running.controlPlane.access.logoutCurrentSession(
      resolution.authentication,
      access.requestToken,
      AbortSignal.timeout(1_000),
    )
    vi.advanceTimersByTime(86_400_001)
    await running.controlPlane.access.readAccess(cookie, AbortSignal.timeout(1_000))
    const stored = accessDomain(running).table('installation_access').get('installation-access')!
    expect(stored.sessions).toEqual([])
    expect(stored.challenges).toEqual([])
    expect(stored.bootstrapCompleted).toBe(true)
    await running.close()
  })

  it('keeps clear credentials and derived request tokens out of durable storage', async () => {
    const path = await database()
    const running = await start(path)
    const { cookie, access, secret } = await bootstrap(running.controlPlane)
    await running.close()
    const bytes = await readFile(path)
    const forbidden = [secret, cookie, access.requestToken]
    for (const value of forbidden) {
      expect(bytes.includes(Buffer.from(value))).toBe(false)
    }
  })

  it('keeps the derived request token out of AuthenticationContext diagnostics', async () => {
    const running = await start(await database())
    const { cookie, access } = await bootstrap(running.controlPlane)
    const resolution = await resolveSakiAuthentication(
      running.controlPlane,
      cookie,
      { origin: ORIGIN, mutation: false },
      AbortSignal.timeout(1_000),
    )
    if (!resolution.ok) throw new Error('authentication unexpectedly failed')
    const diagnostic = inspect(resolution.authentication, { showHidden: true })
    const enumerableValues = Object.values(resolution.authentication)
    const serialized = JSON.stringify(resolution.authentication)
    await running.close()
    expect(diagnostic).not.toContain(access.requestToken)
    expect(enumerableValues).not.toContain(access.requestToken)
    expect(serialized).not.toContain(access.requestToken)
  })

  it('publishes a closed empty Intent map and a stable unavailable receipt', async () => {
    const running = await start(await database())
    const { cookie, access } = await bootstrap(running.controlPlane)
    const resolution = await resolveSakiAuthentication(
      running.controlPlane,
      cookie,
      { origin: ORIGIN, mutation: true, requestToken: access.requestToken },
      AbortSignal.timeout(1_000),
    )
    if (!resolution.ok) throw new Error('authentication unexpectedly failed')
    expect(await running.controlPlane.submit(
      resolution.authentication,
      undefined,
      AbortSignal.timeout(1_000),
    )).toEqual({ ok: false, reason: 'intent-unavailable' })
    await running.close()
  })
})
