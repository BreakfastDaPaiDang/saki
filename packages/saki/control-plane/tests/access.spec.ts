import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
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
  type Config,
  type SakiControlIntentId,
  type SakiControlPlaneModule,
  type SakiDevelopmentProjectId,
} from '../src/index.ts'
import { SakiAuthenticationContext } from '../src/authentication.ts'
import {
  resolveSakiAuthentication,
  sakiSessionCookieName,
  takeSakiCookieHeader,
} from '../src/host.ts'
import {
  CONTROL_STATE_KEY,
  sakiControlPlaneDomainSpec,
} from '../src/spec.ts'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { InstallationAccessRecord } from '../src/spec.ts'
import {
  materializeCandidateStorageGenerationSeal,
  NEXT_SAKI_INSTALLATION_STATE,
  provideSakiInstallationState,
  TEST_SAKI_INSTALLATION_STATE,
  type TestSakiInstallationState,
} from './installation-state.ts'

const ORIGIN = 'http://127.0.0.1:43119'
const COOKIE_NAME = 'saki_session'
const tempDirectories: string[] = []
const CONTROL_PLANE_CONFIG = {
  origin: ORIGIN,
  challengeTtlMs: 60_000,
  sessionTtlMs: 3_600_000,
  terminalRetentionMs: 86_400_000,
  githubScanAttemptTtlMs: 300_000,
  agentDispatchClaimTtlMs: 30_000,
  cookieName: COOKIE_NAME,
  defaultAgentProfile: { agentPresetId: 'standard' },
} as const

interface RunningHarness {
  readonly ctx: Context
  readonly controlPlane: SakiControlPlaneModule
  readonly close: () => Promise<void>
}

interface FailureHarness extends RunningHarness {
  readonly failNextAccessWrite: (failure: 'before-commit' | 'after-commit') => void
}

interface PauseHandle {
  readonly entered: Promise<void>
  readonly release: () => void
}

interface PauseHarness extends RunningHarness {
  readonly pauseNextAccessWrite: () => PauseHandle
}

interface PutHooks {
  readonly beforePut?: (table: string) => Promise<void> | void
  readonly afterPut?: (table: string) => Promise<void> | void
}

async function start(
  databasePath: string,
  config: Required<Config> = CONTROL_PLANE_CONFIG,
  state?: TestSakiInstallationState,
): Promise<RunningHarness> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageSqlite, { path: databasePath, journalMode: 'delete' })
  await ctx.plugin(StorageDomain, { backend: 'sqlite' })
  return startControlPlane(ctx, config, state)
}

async function startControlPlane(
  ctx: Context,
  config: Required<Config> = CONTROL_PLANE_CONFIG,
  state?: TestSakiInstallationState,
): Promise<RunningHarness> {
  await provideSakiInstallationState(ctx, state)
  ctx.provide('sakiHostExecution', {
    inspectProjectSelection: () => Promise.resolve({ ok: false, reason: 'unavailable' }),
    onChanged: () => () => {},
  } as never)
  ctx.provide('workspaceRegistry', {
    list: () => [],
    create: () => Promise.reject(new Error('workspace creation is outside B01 access tests')),
  } as never)
  const fiber = await ctx.plugin(SakiControlPlane, config)
  return {
    ctx,
    controlPlane: ctx.sakiControlPlane,
    close: async () => {
      await fiber.dispose()
      await ctx.fiber.dispose()
    },
  }
}

async function copyAsCandidate(
  sourcePath: string,
  state: TestSakiInstallationState,
): Promise<string> {
  const candidatePath = await database()
  await copyFile(sourcePath, candidatePath)
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageSqlite, { path: candidatePath, journalMode: 'delete' })
  await ctx.plugin(StorageDomain, { backend: 'sqlite' })
  try {
    await materializeCandidateStorageGenerationSeal(ctx, state)
  } finally {
    await ctx.fiber.dispose()
  }
  return candidatePath
}

async function interceptedContext(databasePath: string, hooks: PutHooks): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const inner = new StorageSqlite.SqliteStorageBackend({ path: databasePath, journalMode: 'delete' })
  const backend: StorageBackend = {
    kv: {
      open: async (descriptor) => {
        const unit = await inner.kv.open(descriptor)
        return {
          loadAll: () => unit.loadAll(),
          putRecord: async (table, key, value) => {
            await hooks.beforePut?.(table)
            await unit.putRecord(table, key, value)
            await hooks.afterPut?.(table)
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
  return ctx
}

async function startWithArmableAccessWriteFailure(databasePath: string): Promise<FailureHarness> {
  let nextFailure: 'before-commit' | 'after-commit' | undefined
  const fail = (table: string, phase: 'before-commit' | 'after-commit'): void => {
    if (table !== 'installation_access' || nextFailure !== phase) return
    nextFailure = undefined
    throw new Error('selected access durability interruption')
  }
  const ctx = await interceptedContext(databasePath, {
    beforePut: (table) => { fail(table, 'before-commit') },
    afterPut: (table) => { fail(table, 'after-commit') },
  })
  const running = await startControlPlane(ctx)
  return {
    ...running,
    failNextAccessWrite: (failure) => { nextFailure = failure },
  }
}

async function startWithPausableAccessWrite(databasePath: string): Promise<PauseHarness> {
  let pending: {
    readonly entered: () => void
    readonly released: Promise<void>
  } | undefined
  const ctx = await interceptedContext(databasePath, {
    beforePut: async (table) => {
      if (table !== 'installation_access' || pending === undefined) return
      const selected = pending
      pending = undefined
      selected.entered()
      await selected.released
    },
  })
  const running = await startControlPlane(ctx)
  return {
    ...running,
    pauseNextAccessWrite: () => {
      const entered = Promise.withResolvers<undefined>()
      const released = Promise.withResolvers<undefined>()
      pending = { entered: () => { entered.resolve(undefined) }, released: released.promise }
      return { entered: entered.promise, release: () => { released.resolve(undefined) } }
    },
  }
}

async function interruptProvisioning(
  databasePath: string,
  writeOrdinal: number,
  failure: 'before-commit' | 'after-commit',
): Promise<void> {
  let writes = 0
  const fail = (phase: 'before-commit' | 'after-commit'): void => {
    writes += phase === 'before-commit' ? 1 : 0
    if (writes === writeOrdinal && failure === phase) {
      throw new Error(`selected provisioning ${failure} interruption`)
    }
  }
  const ctx = await interceptedContext(databasePath, {
    beforePut: () => { fail('before-commit') },
    afterPut: () => { fail('after-commit') },
  })
  try {
    await expect(startControlPlane(ctx)).rejects.toThrow(`selected provisioning ${failure} interruption`)
  } finally {
    await ctx.fiber.dispose()
  }
}

function accessDomain(running: RunningHarness): Domain<typeof sakiControlPlaneDomainSpec> {
  return running.ctx.storageDomain.get(sakiControlPlaneDomainSpec.name) as unknown as
    Domain<typeof sakiControlPlaneDomainSpec>
}

function controlState(running: RunningHarness) {
  return accessDomain(running).table('control_state').get(CONTROL_STATE_KEY)!
}

function accessRecord(running: RunningHarness) {
  const control = controlState(running)
  return accessDomain(running).table('installation_access').get(control.installationAccessId)!
}

function replaceAccessBeforeNextUpdate(
  running: RunningHarness,
  transform: (record: InstallationAccessRecord) => InstallationAccessRecord,
): void {
  const table = accessDomain(running).table('installation_access')
  const update = table.update.bind(table)
  vi.spyOn(table, 'update').mockImplementationOnce((key, mutate) => {
    const stored = table.get(key)!
    Object.assign(stored, transform(structuredClone(stored)))
    return update(key, mutate)
  })
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
  it.each([
    ['before-commit', 1],
    ['before-commit', 2],
    ['before-commit', 3],
    ['before-commit', 4],
    ['before-commit', 5],
    ['before-commit', 6],
    ['before-commit', 7],
    ['after-commit', 1],
    ['after-commit', 2],
    ['after-commit', 3],
    ['after-commit', 4],
    ['after-commit', 5],
    ['after-commit', 6],
    ['after-commit', 7],
  ] as const)('resumes provisioning after a %s interruption at write %i', async (failure, writeOrdinal) => {
    const path = await database()
    await interruptProvisioning(path, writeOrdinal, failure)

    const recovered = await start(path, CONTROL_PLANE_CONFIG, TEST_SAKI_INSTALLATION_STATE)
    const domain = accessDomain(recovered)
    expect(controlState(recovered).phase).toBe('ready')
    expect(domain.table('control_state').size).toBe(1)
    expect(domain.table('installations').size).toBe(1)
    expect(domain.table('hosts').size).toBe(1)
    expect(domain.table('principals').size).toBe(1)
    expect(domain.table('grants').size).toBe(1)
    expect(domain.table('installation_access').size).toBe(1)
    expect(recovered.controlPlane.bootstrap.take()?.purpose).toBe('initial-bootstrap')
    await recovered.close()
  })

  it('materializes a fresh seal once and never rewrites or repairs it on ready selection', async () => {
    const path = await database()
    let sealWrites = 0
    let ctx = await interceptedContext(path, {
      beforePut: (table) => { sealWrites += table === 'storage_generation' ? 1 : 0 },
    })
    const fresh = await startControlPlane(ctx)
    expect(ctx.sakiInstallationState.phase).toBe('provisioning')
    expect(sealWrites).toBe(1)
    await fresh.close()

    ctx = await interceptedContext(path, {
      beforePut: (table) => { sealWrites += table === 'storage_generation' ? 1 : 0 },
    })
    const restarted = await startControlPlane(ctx)
    expect(ctx.sakiInstallationState.phase).toBe('ready')
    expect(sealWrites).toBe(1)
    await restarted.close()

    ctx = await interceptedContext(path, {
      beforePut: (table) => { sealWrites += table === 'storage_generation' ? 1 : 0 },
    })
    try {
      await expect(startControlPlane(ctx, CONTROL_PLANE_CONFIG, {
        ...TEST_SAKI_INSTALLATION_STATE,
        phase: 'ready',
        createdByBuildId: 'saki-build-other' as TestSakiInstallationState['createdByBuildId'],
      })).rejects.toThrow('disagrees with the existing storage-generation seal')
      expect(sealWrites).toBe(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

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

  it('withdraws an unclaimed launcher handoff when the service is disposed', async () => {
    const running = await start(await database())
    await running.close()
    expect(running.controlPlane.bootstrap.take()).toBeUndefined()
  })

  it('persists independent Installation and Local Host identities across restart', async () => {
    const path = await database()
    const first = await start(path)
    const firstIdentity = first.controlPlane.identity()
    expect(firstIdentity.installationId).toBe(TEST_SAKI_INSTALLATION_STATE.installationId)
    expect(firstIdentity.installationId).not.toBe(firstIdentity.hostId)
    expect(controlState(first)).toMatchObject({ schemaVersion: 2, installationId: firstIdentity.installationId })
    expect(accessRecord(first)).toMatchObject({ schemaVersion: 2, installationId: firstIdentity.installationId })
    expect(accessRecord(first).challenges[0]?.storageGenerationId)
      .toBe(TEST_SAKI_INSTALLATION_STATE.storageGenerationId)
    await bootstrap(first.controlPlane)
    await first.close()

    const second = await start(path)
    expect(second.controlPlane.identity()).toEqual(firstIdentity)
    expect(second.controlPlane.bootstrap.take()?.purpose).toBe('local-reauthentication')
    await second.close()
  })

  it('issues a fresh startup challenge while preserving earlier issued challenges', async () => {
    const path = await database()
    const first = await start(path)
    const oldSecret = first.controlPlane.bootstrap.take()!.consume()
    await first.close()

    const second = await start(path)
    const newSecret = second.controlPlane.bootstrap.take()!.consume()
    expect(newSecret).not.toBe(oldSecret)
    const access = accessRecord(second)
    expect(access.challenges.map(challenge => [challenge.purpose, challenge.state])).toEqual([
      ['initial-bootstrap', 'issued'],
      ['initial-bootstrap', 'issued'],
    ])
    expect(await second.controlPlane.access.exchangeBootstrap(
      { origin: ORIGIN }, { secret: oldSecret }, AbortSignal.timeout(1_000),
    )).toMatchObject({ ok: true })
    expect(accessRecord(second)
      .challenges.map(challenge => challenge.state)).toEqual(['consumed', 'revoked'])
    await second.close()
  })

  it('does not issue or exchange a launcher challenge for an inactive Installation', async () => {
    const path = await database()
    const first = await start(path)
    const secret = first.controlPlane.bootstrap.take()!.consume()
    const owner = controlState(first)
    await accessDomain(first).table('installations').update(owner.installationId, current => ({
      ...current,
      revision: current.revision + 1,
      state: 'retired',
    }))
    expect(await first.controlPlane.access.exchangeBootstrap(
      { origin: ORIGIN },
      { secret },
      AbortSignal.timeout(1_000),
    )).toEqual({ ok: false, reason: 'unavailable' })
    expect(accessRecord(first).challenges[0]?.state).toBe('revoked')
    await first.close()

    const second = await start(path)
    expect(second.controlPlane.bootstrap.take()).toBeUndefined()
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
    const stored = accessRecord(running)
    expect(stored.challenges).toHaveLength(1)
    expect(stored.sessions).toHaveLength(1)
    expect(stored.challenges[0]).toMatchObject({
      state: 'consumed',
      browserSessionId: stored.sessions[0]!.id,
      installationId: stored.sessions[0]!.installationId,
      principalId: stored.sessions[0]!.principalId,
    })
    expect(stored.sessions[0]!.state).toBe('active')
    expect(stored.sessions[0]!.storageGenerationId).toBe(TEST_SAKI_INSTALLATION_STATE.storageGenerationId)
    await running.close()
  })

  it.each([
    ['missing', (record: InstallationAccessRecord) => ({ ...record, challenges: [] })],
    ['terminal', (record: InstallationAccessRecord) => ({
      ...record,
      challenges: record.challenges.map(challenge => ({
        ...challenge,
        revision: 1,
        state: 'revoked' as const,
        terminalAt: Date.now(),
      })),
    })],
    ['expired', (record: InstallationAccessRecord) => ({
      ...record,
      challenges: record.challenges.map(challenge => ({ ...challenge, expiresAt: 0 })),
    })],
    ['digest', (record: InstallationAccessRecord) => ({
      ...record,
      challenges: record.challenges.map(challenge => ({ ...challenge, verifierDigest: 'f'.repeat(64) })),
    })],
    ['authority', (record: InstallationAccessRecord) => ({
      ...record,
      challenges: record.challenges.map(challenge => ({
        ...challenge,
        storageGenerationId: NEXT_SAKI_INSTALLATION_STATE.storageGenerationId,
      })),
    })],
    ['purpose', (record: InstallationAccessRecord) => ({
      ...record,
      challenges: record.challenges.map(challenge => ({
        ...challenge,
        purpose: 'local-reauthentication' as const,
      })),
    })],
  ] as const)('contains a concurrent %s challenge change during exchange', async (_scenario, transform) => {
    const running = await start(await database())
    const secret = running.controlPlane.bootstrap.take()!.consume()
    replaceAccessBeforeNextUpdate(running, transform)
    expect(await running.controlPlane.access.exchangeBootstrap(
      { origin: ORIGIN },
      { secret },
      AbortSignal.timeout(1_000),
    )).toEqual({ ok: false, reason: 'unavailable' })
    await running.close()
  })

  it('recovers from a lost Set-Cookie response with a fresh local reauthentication challenge', async () => {
    const path = await database()
    const first = await start(path)
    const firstSecret = first.controlPlane.bootstrap.take()!.consume()
    const lostExchange = await first.controlPlane.access.exchangeBootstrap(
      { origin: ORIGIN }, { secret: firstSecret }, AbortSignal.timeout(1_000),
    )
    expect(lostExchange.ok).toBe(true)
    await first.close()

    const second = await start(path)
    const recovery = second.controlPlane.bootstrap.take()!
    expect(recovery.purpose).toBe('local-reauthentication')
    const recoverySecret = recovery.consume()
    expect(await second.controlPlane.access.exchangeBootstrap(
      { origin: ORIGIN }, { secret: firstSecret }, AbortSignal.timeout(1_000),
    )).toEqual({ ok: false, reason: 'unavailable' })
    const recovered = await second.controlPlane.access.exchangeBootstrap(
      { origin: ORIGIN }, { secret: recoverySecret }, AbortSignal.timeout(1_000),
    )
    expect(recovered).toMatchObject({ ok: true, access: { kind: 'authenticated' } })
    const stored = accessRecord(second)
    expect(stored.sessions).toHaveLength(2)
    expect(stored.bootstrapCompletion).toMatchObject({
      challengeId: stored.challenges[0]!.id,
      sessionId: stored.sessions[0]!.id,
    })
    await second.close()
  })

  it('does not consume a challenge when cancellation arrives during reconciliation', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-19T00:00:00.000Z'))
    const path = await database()
    const first = await start(path)
    first.controlPlane.bootstrap.take()!.consume()
    await first.close()

    vi.advanceTimersByTime(30_000)
    const second = await start(path)
    const selectedSecret = second.controlPlane.bootstrap.take()!.consume()
    await second.close()

    const third = await startWithPausableAccessWrite(path)
    third.controlPlane.bootstrap.take()!.consume()
    const pause = third.pauseNextAccessWrite()
    vi.advanceTimersByTime(30_001)
    const controller = new AbortController()
    const exchange = third.controlPlane.access.exchangeBootstrap(
      { origin: ORIGIN },
      { secret: selectedSecret },
      controller.signal,
    )
    await pause.entered
    controller.abort()
    pause.release()
    await expect(exchange).rejects.toMatchObject({ name: 'AbortError' })
    expect(accessRecord(third).challenges.map(challenge => challenge.state)).toEqual([
      'expired',
      'issued',
      'issued',
    ])
    expect(accessRecord(third).sessions).toEqual([])
    await third.close()
  })

  it('keeps the challenge issued on a pre-commit interruption and consumes it on retry', async () => {
    const running = await startWithArmableAccessWriteFailure(await database())
    const secret = running.controlPlane.bootstrap.take()!.consume()
    running.failNextAccessWrite('before-commit')
    await expect(running.controlPlane.access.exchangeBootstrap(
      { origin: ORIGIN }, { secret }, AbortSignal.timeout(1_000),
    )).rejects.toThrow('selected access durability interruption')
    expect(accessRecord(running)
      .challenges.at(-1)?.state).toBe('issued')
    expect((await running.controlPlane.access.exchangeBootstrap(
      { origin: ORIGIN }, { secret }, AbortSignal.timeout(1_000),
    )).ok).toBe(true)
    await running.close()
  })

  it('keeps the committed challenge consumed after a post-commit interruption and restart', async () => {
    const path = await database()
    const first = await startWithArmableAccessWriteFailure(path)
    const secret = first.controlPlane.bootstrap.take()!.consume()
    first.failNextAccessWrite('after-commit')
    await expect(first.controlPlane.access.exchangeBootstrap(
      { origin: ORIGIN }, { secret }, AbortSignal.timeout(1_000),
    )).rejects.toThrow('selected access durability interruption')
    await first.close()

    const second = await start(path)
    expect(second.controlPlane.bootstrap.take()?.purpose).toBe('local-reauthentication')
    expect(await second.controlPlane.access.exchangeBootstrap(
      { origin: ORIGIN }, { secret }, AbortSignal.timeout(1_000),
    )).toEqual({ ok: false, reason: 'unavailable' })
    const stored = accessRecord(second)
    expect(stored.challenges.map(challenge => challenge.state)).toEqual(['consumed', 'issued'])
    expect(stored.sessions).toHaveLength(1)
    expect(stored.sessions[0]!.state).toBe('active')
    await second.close()
  })

  it('returns the current Host with an empty Project index and revalidates the current Grant', async () => {
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
      projection: {
        type: 'project-index',
        revision: 0,
        hosts: [{ id: running.controlPlane.identity().hostId, revision: 0, state: 'enrolled' }],
        projects: [],
      },
    })

    const control = controlState(running)
    await accessDomain(running).table('grants').update(control.hostOperatorGrantId, current => ({
      ...current,
      revision: current.revision + 1,
      state: 'revoked',
    }))
    expect(await running.controlPlane.query(
      resolution.authentication,
      { type: 'project-index' },
      AbortSignal.timeout(1_000),
    )).toEqual({ ok: false, reason: 'denied' })
    expect(await running.controlPlane.query(resolution.authentication, {
      type: 'development-workspace',
      projectId: 'project-00000000-0000-4000-8000-000000000902' as SakiDevelopmentProjectId,
      expectedRegistryRevision: 0,
    }, AbortSignal.timeout(1_000))).toEqual({ ok: false, reason: 'denied' })
    expect(await running.controlPlane.access.readAccess(cookie, AbortSignal.timeout(1_000)))
      .toMatchObject({ kind: 'authenticated' })
    await running.close()
  })

  it('keeps Host authentication and access projections closed around invalid session input', async () => {
    const running = await start(await database())
    const signal = AbortSignal.timeout(1_000)
    const secret = running.controlPlane.bootstrap.take()!.consume()

    expect(sakiSessionCookieName(running.controlPlane)).toBe(COOKIE_NAME)
    await expect(resolveSakiAuthentication(
      running.controlPlane,
      undefined,
      { origin: ORIGIN, mutation: false },
      signal,
    )).resolves.toEqual({ ok: false, reason: 'unavailable' })
    await expect(resolveSakiAuthentication(
      running.controlPlane,
      'not-a-session',
      { origin: ORIGIN, mutation: false },
      signal,
    )).resolves.toEqual({ ok: false, reason: 'unavailable' })
    await expect(running.controlPlane.access.readAccess(undefined, signal)).resolves.toEqual({
      kind: 'bootstrap-required',
      message: 'Local bootstrap is required.',
    })
    await expect(running.controlPlane.access.readAccess('not-a-session', signal)).resolves.toEqual({
      kind: 'bootstrap-required',
      message: 'Local bootstrap is required.',
    })
    await expect(running.controlPlane.access.exchangeBootstrap(
      { origin: 'http://127.0.0.1:1' },
      { secret },
      signal,
    )).resolves.toEqual({ ok: false, reason: 'unavailable' })
    await expect(running.controlPlane.access.exchangeBootstrap(
      { origin: ORIGIN },
      { secret },
      signal,
    )).resolves.toMatchObject({ ok: true })
    await expect(running.controlPlane.access.readAccess('not-a-session', signal)).resolves.toEqual({
      kind: 'session-required',
      message: 'A local browser session is required.',
    })

    await running.close()
  })

  it('rejects operations carrying a context that the access service did not mint', async () => {
    const running = await start(await database())
    const foreign = {} as SakiAuthenticationContext
    expect(await running.controlPlane.query(
      foreign,
      { type: 'project-index' },
      AbortSignal.timeout(1_000),
    )).toEqual({ ok: false, reason: 'denied' })
    const hostId = running.controlPlane.identity().hostId
    expect(await running.controlPlane.submit(
      foreign,
      {
        type: 'register-development-project',
        intentId: 'intent-00000000-0000-4000-8000-000000000901' as SakiControlIntentId,
        projectTitle: 'Foreign request',
        hostId,
        directoryLocator: '.',
        expectedRegistryRevision: 0,
        confirmedFingerprint: { version: 2, digest: '0'.repeat(64) },
        confirmedBaseline: {
          kind: 'unavailable',
          reason: 'io-failure',
          observed: { entries: 0, pathBytes: 0, gitOutputBytes: 0, hashedBytes: 0, elapsedMs: 0 },
        },
      },
      AbortSignal.timeout(1_000),
    )).toEqual({ ok: false, reason: 'denied' })
    expect(await running.controlPlane.access.logoutCurrentSession(
      foreign,
      'foreign-token',
      AbortSignal.timeout(1_000),
    )).toEqual({ ok: false, reason: 'unavailable' })
    await running.close()
  })

  it('contains concurrent logout attempts to the one current Browser Session', async () => {
    const running = await start(await database())
    const { cookie, access } = await bootstrap(running.controlPlane)
    const resolution = await resolveSakiAuthentication(
      running.controlPlane,
      cookie,
      { origin: ORIGIN, mutation: true, requestToken: access.requestToken },
      AbortSignal.timeout(1_000),
    )
    if (!resolution.ok) throw new Error('authentication unexpectedly failed')
    const results = await Promise.all([
      running.controlPlane.access.logoutCurrentSession(
        resolution.authentication,
        access.requestToken,
        AbortSignal.timeout(1_000),
      ),
      running.controlPlane.access.logoutCurrentSession(
        resolution.authentication,
        access.requestToken,
        AbortSignal.timeout(1_000),
      ),
    ])
    expect(results.filter(result => result.ok)).toHaveLength(1)
    expect(results.filter(result => !result.ok)).toEqual([{ ok: false, reason: 'unavailable' }])
    await running.close()
  })

  it.each(['missing', 'terminal'] as const)(
    'contains a concurrent %s Browser Session change during logout',
    async (scenario) => {
      const running = await start(await database())
      const { cookie, access } = await bootstrap(running.controlPlane)
      const resolution = await resolveSakiAuthentication(
        running.controlPlane,
        cookie,
        { origin: ORIGIN, mutation: true, requestToken: access.requestToken },
        AbortSignal.timeout(1_000),
      )
      if (!resolution.ok) throw new Error('authentication unexpectedly failed')
      replaceAccessBeforeNextUpdate(running, record => ({
        ...record,
        sessions: scenario === 'missing'
          ? []
          : record.sessions.map(session => ({
            ...session,
            revision: session.revision + 1,
            state: 'revoked' as const,
            terminalAt: Date.now(),
          })),
      }))
      expect(await running.controlPlane.access.logoutCurrentSession(
        resolution.authentication,
        access.requestToken,
        AbortSignal.timeout(1_000),
      )).toEqual({ ok: false, reason: 'unavailable' })
      await running.close()
    },
  )

  it('propagates an unexpected access-storage failure during logout', async () => {
    const running = await startWithArmableAccessWriteFailure(await database())
    const { cookie, access } = await bootstrap(running.controlPlane)
    const resolution = await resolveSakiAuthentication(
      running.controlPlane,
      cookie,
      { origin: ORIGIN, mutation: true, requestToken: access.requestToken },
      AbortSignal.timeout(1_000),
    )
    if (!resolution.ok) throw new Error('authentication unexpectedly failed')
    running.failNextAccessWrite('before-commit')
    await expect(running.controlPlane.access.logoutCurrentSession(
      resolution.authentication,
      access.requestToken,
      AbortSignal.timeout(1_000),
    )).rejects.toThrow('selected access durability interruption')
    await running.close()
  })

  it('contains Projection listener failures and continues notifying later subscribers', async () => {
    const running = await start(await database())
    const observed: (readonly string[])[] = []
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
    const disposeFailing = running.controlPlane.onChanged(() => { throw new Error('listener-secret-sentinel') })
    const disposeObserved = running.controlPlane.onChanged((keys) => { observed.push(keys) })
    running.ctx.emit('domain/changed', {
      domain: 'unrelated-domain',
      table: 'records',
      key: 'record',
      operation: 'put',
      value: {},
    })

    const control = controlState(running)
    await accessDomain(running).table('grants').update(control.hostOperatorGrantId, current => ({
      ...current,
      revision: current.revision + 1,
    }))
    disposeFailing()
    disposeObserved()
    await accessDomain(running).table('grants').update(control.hostOperatorGrantId, current => ({
      ...current,
      revision: current.revision + 1,
    }))

    await running.close()
    expect(observed).toEqual([[
      'access',
      'my-work',
      'attention',
      'project-index',
      'development-workspace',
      'project-changes',
    ]])
    expect(diagnostic).toHaveBeenCalledTimes(1)
    expect(diagnostic).toHaveBeenCalledWith('[saki-control-plane] Projection listener failed')
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('listener-secret-sentinel')
  })

  it('keeps an explicitly revoked Browser Session unavailable across restart', async () => {
    const path = await database()
    const first = await start(path)
    const { cookie } = await bootstrap(first.controlPlane)
    const accessId = controlState(first).installationAccessId
    await accessDomain(first).table('installation_access').update(accessId, current => ({
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

  it('invalidates the Browser Session after Principal retirement without reviving it', async () => {
    const running = await start(await database())
    const { cookie } = await bootstrap(running.controlPlane)
    const control = controlState(running)
    await accessDomain(running).table('principals').update(
      control.hostOperatorPrincipalId,
      current => ({ ...current, revision: current.revision + 1, state: 'retired' }),
    )
    expect(await running.controlPlane.access.readAccess(cookie, AbortSignal.timeout(1_000)))
      .toEqual({ kind: 'session-required', message: 'A local browser session is required.' })
    expect(accessRecord(running).sessions.at(-1)?.state).toBe('revoked')
    await running.close()
  })

  it('validates but cannot authenticate a Browser Session from an inactive storage generation', async () => {
    const sourcePath = await database()
    const first = await start(sourcePath)
    const { cookie } = await bootstrap(first.controlPlane)
    expect(accessRecord(first).sessions.at(-1)?.storageGenerationId)
      .toBe(TEST_SAKI_INSTALLATION_STATE.storageGenerationId)
    await first.close()

    const candidatePath = await copyAsCandidate(sourcePath, NEXT_SAKI_INSTALLATION_STATE)
    const second = await start(candidatePath, CONTROL_PLANE_CONFIG, NEXT_SAKI_INSTALLATION_STATE)
    expect(await second.controlPlane.access.readAccess(cookie, AbortSignal.timeout(1_000)))
      .toEqual({ kind: 'session-required', message: 'A local browser session is required.' })
    expect(accessRecord(second).sessions.at(-1)?.state).toBe('revoked')
    expect(accessRecord(second).challenges.at(-1)?.storageGenerationId)
      .toBe(NEXT_SAKI_INSTALLATION_STATE.storageGenerationId)
    await second.close()
  })

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
    expect(await resolveSakiAuthentication(
      running.controlPlane,
      cookie,
      { origin: ORIGIN, mutation: true },
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

  it('recovers a logged-out operator through the next local launcher challenge', async () => {
    const path = await database()
    const first = await start(path)
    const { cookie, access } = await bootstrap(first.controlPlane)
    const resolution = await resolveSakiAuthentication(
      first.controlPlane,
      cookie,
      { origin: ORIGIN, mutation: true, requestToken: access.requestToken },
      AbortSignal.timeout(1_000),
    )
    if (!resolution.ok) throw new Error('authentication unexpectedly failed')
    expect(await first.controlPlane.access.logoutCurrentSession(
      resolution.authentication,
      access.requestToken,
      AbortSignal.timeout(1_000),
    )).toMatchObject({ ok: true })
    await first.close()

    const second = await start(path)
    const recovery = second.controlPlane.bootstrap.take()!
    expect(recovery.purpose).toBe('local-reauthentication')
    expect(await second.controlPlane.access.exchangeBootstrap(
      { origin: ORIGIN },
      { secret: recovery.consume() },
      AbortSignal.timeout(1_000),
    )).toMatchObject({ ok: true, access: { kind: 'authenticated' } })
    await second.close()
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
    const recovery = second.controlPlane.bootstrap.take()!
    expect(recovery.purpose).toBe('local-reauthentication')
    expect(await second.controlPlane.access.exchangeBootstrap(
      { origin: ORIGIN },
      { secret: recovery.consume() },
      AbortSignal.timeout(1_000),
    )).toMatchObject({ ok: true })
    await second.close()
  })

  it('contains a competing reconciliation that commits the same expiry first', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-19T00:00:00.000Z'))
    const running = await start(await database())
    const { cookie } = await bootstrap(running.controlPlane)
    vi.advanceTimersByTime(3_600_001)
    const results = await Promise.all([
      running.controlPlane.access.readAccess(cookie, AbortSignal.timeout(1_000)),
      running.controlPlane.access.readAccess(cookie, AbortSignal.timeout(1_000)),
    ])
    expect(results).toEqual([
      { kind: 'session-required', message: 'A local browser session is required.' },
      { kind: 'session-required', message: 'A local browser session is required.' },
    ])
    expect(accessRecord(running).sessions[0]?.state).toBe('expired')
    await running.close()
  })

  it('propagates an unexpected access-storage failure during reconciliation', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-19T00:00:00.000Z'))
    const running = await startWithArmableAccessWriteFailure(await database())
    running.controlPlane.bootstrap.take()!.consume()
    vi.advanceTimersByTime(60_001)
    running.failNextAccessWrite('before-commit')
    await expect(running.controlPlane.access.readAccess(undefined, AbortSignal.timeout(1_000)))
      .rejects.toThrow('selected access durability interruption')
    await running.close()
  })

  it('expires a Bootstrap Challenge by server time and rejects it after clock rollback', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-19T00:00:00.000Z'))
    const path = await database()
    const running = await start(path)
    const secret = running.controlPlane.bootstrap.take()!.consume()
    vi.advanceTimersByTime(60_001)
    expect(await running.controlPlane.access.exchangeBootstrap(
      { origin: ORIGIN }, { secret }, AbortSignal.timeout(1_000),
    )).toEqual({ ok: false, reason: 'unavailable' })
    expect(accessRecord(running)
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
    const path = await database()
    const running = await start(path)
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
    const stored = accessRecord(running)
    expect(stored.sessions).toEqual([])
    expect(stored.challenges).toEqual([])
    expect(stored.bootstrapCompletion).toBeDefined()
    const completion = stored.bootstrapCompletion!
    expect(stored.nextChallengeOrdinal).toBe(1)
    expect(stored.nextSessionOrdinal).toBe(1)
    await running.close()

    const restarted = await start(path)
    const recovery = restarted.controlPlane.bootstrap.take()!
    expect(recovery.purpose).toBe('local-reauthentication')
    expect(accessRecord(restarted).challenges[0]?.ordinal).toBe(1)
    expect(await restarted.controlPlane.access.exchangeBootstrap(
      { origin: ORIGIN },
      { secret: recovery.consume() },
      AbortSignal.timeout(1_000),
    )).toMatchObject({ ok: true })
    const recovered = accessRecord(restarted)
    expect(recovered.nextChallengeOrdinal).toBe(2)
    expect(recovered.nextSessionOrdinal).toBe(2)
    expect(recovered.sessions[0]?.ordinal).toBe(1)
    expect(recovered.bootstrapCompletion).toEqual(completion)
    await restarted.close()
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

  it('marks session and logout cookies Secure for an HTTPS origin', async () => {
    const secureOrigin = 'https://127.0.0.1:43119'
    const running = await start(await database(), { ...CONTROL_PLANE_CONFIG, origin: secureOrigin })
    const secret = running.controlPlane.bootstrap.take()!.consume()
    const exchange = await running.controlPlane.access.exchangeBootstrap(
      { origin: secureOrigin },
      { secret },
      AbortSignal.timeout(1_000),
    )
    expect(exchange).toMatchObject({ ok: true })
    const cookieHeader = takeSakiCookieHeader(exchange)!
    expect(cookieHeader).toContain('; Secure')
    const cookie = rawCookie(cookieHeader)
    const access = (exchange as Extract<typeof exchange, { readonly ok: true }>).access
    const resolution = await resolveSakiAuthentication(
      running.controlPlane,
      cookie,
      { origin: secureOrigin, mutation: true, requestToken: access.requestToken },
      AbortSignal.timeout(1_000),
    )
    if (!resolution.ok) throw new Error('authentication unexpectedly failed')
    const logout = await running.controlPlane.access.logoutCurrentSession(
      resolution.authentication,
      access.requestToken,
      AbortSignal.timeout(1_000),
    )
    expect(takeSakiCookieHeader(logout)).toContain('; Secure')
    await running.close()
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

})
