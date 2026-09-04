import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import SakiControlPlane from '../src/index.ts'
import type { SakiControlPlaneModule } from '../src/index.ts'
import {
  CONTROL_STATE_KEY,
  DEVELOPMENT_PROJECT_REGISTRY_KEY,
} from '../src/spec.ts'
import { sakiControlPlaneDomainSpec } from '../src/domain-spec.ts'
import { sakiStorageGenerationDomainSpec } from '../src/state-version.ts'
import type {
  InstallationAccessRecord,
} from '../src/spec.ts'
import type {
  SakiBootstrapChallengeId,
  SakiBrowserSessionId,
  SakiGrantId,
  SakiHostId,
  SakiInstallationAccessId,
  SakiInstallationId,
  SakiPrincipalId,
} from '../src/types.ts'
import {
  HISTORICAL_STORAGE_GENERATION_ID,
  provideSakiInstallationState,
  TEST_SAKI_INSTALLATION_STATE,
  type TestSakiInstallationState,
} from './installation-state.ts'

const ORIGIN = 'http://127.0.0.1:43119'
const CONFIG = {
  origin: ORIGIN,
  challengeTtlMs: 60_000,
  sessionTtlMs: 3_600_000,
  terminalRetentionMs: 86_400_000,
  cookieName: 'saki_session',
} as const
const OTHER_INSTALLATION_ID = 'installation-00000000-0000-4000-8000-000000000101' as SakiInstallationId
const OTHER_HOST_ID = 'host-00000000-0000-4000-8000-000000000103' as SakiHostId
const OTHER_PRINCIPAL_ID = 'principal-00000000-0000-4000-8000-000000000104' as SakiPrincipalId
const OTHER_GRANT_ID = 'grant-00000000-0000-4000-8000-000000000105' as SakiGrantId
const OTHER_ACCESS_ID = 'access-00000000-0000-4000-8000-000000000106' as SakiInstallationAccessId
const tempDirectories: string[] = []

interface RunningHarness {
  readonly ctx: Context
  readonly controlPlane: SakiControlPlaneModule
  readonly close: () => Promise<void>
}

type SakiDomain = Domain<typeof sakiControlPlaneDomainSpec>
type AccessMutation = (record: InstallationAccessRecord) => InstallationAccessRecord

async function database(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'saki-b01-invariants-'))
  tempDirectories.push(directory)
  return join(directory, 'control.sqlite')
}

async function storageContext(
  path: string,
  state?: TestSakiInstallationState,
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageSqlite, { path, journalMode: 'delete' })
  await ctx.plugin(StorageDomain, { backend: 'sqlite' })
  await provideSakiInstallationState(ctx, state)
  ctx.provide('sakiHostExecution', {
    inspectProjectSelection: () => Promise.resolve({ ok: false, reason: 'unavailable' }),
    inspectProject: () => Promise.resolve({ ok: false, reason: 'unavailable' }),
    readDiff: () => Promise.resolve({ ok: false, reason: 'unavailable' }),
    prepareOperation: () => Promise.resolve({ ok: false, reason: 'unavailable' }),
    startOperation: () => Promise.reject(new Error('Host Operations are outside access invariant tests')),
    inspectOperation: () => Promise.reject(new Error('Host Operations are outside access invariant tests')),
    cancelOperation: () => Promise.reject(new Error('Host Operations are outside access invariant tests')),
    onChanged: () => () => undefined,
  } as never)
  ctx.provide('workspaceRegistry', {
    list: () => [],
    create: () => Promise.reject(new Error('workspace creation is outside access invariant tests')),
  } as never)
  return ctx
}

async function start(
  path: string,
  state?: TestSakiInstallationState,
): Promise<RunningHarness> {
  const ctx = await storageContext(path, state)
  const fiber = await ctx.plugin(SakiControlPlane, CONFIG)
  return {
    ctx,
    controlPlane: ctx.sakiControlPlane,
    close: async () => {
      await fiber.dispose()
      await ctx.fiber.dispose()
    },
  }
}

async function edit(path: string, operation: (domain: SakiDomain) => Promise<void>): Promise<void> {
  const ctx = await storageContext(path)
  const domain = await ctx.storageDomain.open(sakiControlPlaneDomainSpec)
  try {
    await operation(domain)
  } finally {
    await domain.close()
    await ctx.fiber.dispose()
  }
}

async function expectStartFailure(
  path: string,
  message: string,
  state?: TestSakiInstallationState,
): Promise<void> {
  const ctx = await storageContext(path, state)
  try {
    await expect(ctx.plugin(SakiControlPlane, CONFIG)).rejects.toThrow(message)
  } finally {
    await ctx.fiber.dispose()
  }
}

async function secondDomainOpenFailure(
  path: string,
  openingFailure: unknown,
  controlCloseFailure?: unknown,
): Promise<unknown> {
  const ctx = await storageContext(path)
  const open = ctx.storageDomain.open.bind(ctx.storageDomain)
  const restoreCloseSpies: Array<() => void> = []
  const openSpy = vi.spyOn(ctx.storageDomain, 'open').mockImplementation(async (spec) => {
    if (spec.name === sakiStorageGenerationDomainSpec.name) throw openingFailure
    const domain = await open(spec)
    if (controlCloseFailure !== undefined) {
      const closeSpy = vi.spyOn(domain, 'close').mockRejectedValue(controlCloseFailure)
      restoreCloseSpies.push(() => { closeSpy.mockRestore() })
    }
    return domain
  })
  let observed: unknown
  try {
    await ctx.plugin(SakiControlPlane, CONFIG)
  } catch (error) {
    observed = error
  } finally {
    openSpy.mockRestore()
    for (const restore of restoreCloseSpies) restore()
    await ctx.fiber.dispose()
  }
  return observed
}

async function productStateCloseFailure(path: string, failures: readonly unknown[]): Promise<unknown> {
  const ctx = await storageContext(path)
  const logged: unknown[] = []
  ctx.logger.error = (error: unknown) => { logged.push(error) }
  const open = ctx.storageDomain.open.bind(ctx.storageDomain)
  const restoreCloseSpies: Array<() => void> = []
  let opened = 0
  const openSpy = vi.spyOn(ctx.storageDomain, 'open').mockImplementation(async (spec) => {
    const domain = await open(spec)
    const failure = failures[opened]
    opened += 1
    if (failure !== undefined) {
      const closeSpy = vi.spyOn(domain, 'close').mockRejectedValue(failure)
      restoreCloseSpies.push(() => { closeSpy.mockRestore() })
    }
    return domain
  })
  const fiber = await ctx.plugin(SakiControlPlane, CONFIG)
  try {
    await fiber.dispose()
  } finally {
    openSpy.mockRestore()
    for (const restore of restoreCloseSpies) restore()
    await ctx.fiber.dispose()
  }
  return logged.at(-1)
}

function control(domain: SakiDomain) {
  return domain.table('control_state').get(CONTROL_STATE_KEY)!
}

function access(domain: SakiDomain): InstallationAccessRecord {
  const owner = control(domain)
  return domain.table('installation_access').get(owner.installationAccessId)!
}

function durableState(domain: SakiDomain): unknown {
  return structuredClone({
    control: [...domain.table('control_state').entries()],
    installations: [...domain.table('installations').entries()],
    hosts: [...domain.table('hosts').entries()],
    principals: [...domain.table('principals').entries()],
    grants: [...domain.table('grants').entries()],
    access: [...domain.table('installation_access').entries()],
    projects: [...domain.table('development_project_registry').entries()],
    intents: [...domain.table('registration_intents').entries()],
  })
}

async function mutateAccess(path: string, mutation: AccessMutation): Promise<void> {
  await edit(path, async (domain) => {
    const owner = control(domain)
    await domain.table('installation_access').update(
      owner.installationAccessId,
      current => mutation(structuredClone(current)),
    )
  })
}

async function initialAccessDatabase(): Promise<string> {
  const path = await database()
  const running = await start(path)
  running.controlPlane.bootstrap.take()!.consume()
  await running.close()
  return path
}

async function completedAccessDatabase(): Promise<string> {
  const path = await database()
  const running = await start(path)
  const secret = running.controlPlane.bootstrap.take()!.consume()
  expect(await running.controlPlane.access.exchangeBootstrap(
    { origin: ORIGIN },
    { secret },
    AbortSignal.timeout(1_000),
  )).toMatchObject({ ok: true })
  await running.close()
  return path
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Saki durable control-plane invariants', () => {
  it('preserves storage-generation open failures and aggregates a control-domain close failure', async () => {
    const openingFailure = new Error('storage-generation open failed')
    expect(await secondDomainOpenFailure(await database(), openingFailure)).toBe(openingFailure)

    const nonErrorFailure = await secondDomainOpenFailure(await database(), 'non-Error open failure')
    expect(nonErrorFailure).toMatchObject({
      message: 'opening Saki storage-generation state failed',
      cause: 'non-Error open failure',
    })

    const closeFailure = new Error('control-domain close failed')
    const aggregate = await secondDomainOpenFailure(await database(), openingFailure, closeFailure)
    expect(aggregate).toBeInstanceOf(AggregateError)
    expect((aggregate as AggregateError).errors).toEqual([openingFailure, closeFailure])
  })

  it('reports one or several product-state domain close failures without dropping causes', async () => {
    const firstFailure = new Error('control close failed')
    expect(await productStateCloseFailure(await database(), [firstFailure])).toBe(firstFailure)

    const nonErrorFailure = await productStateCloseFailure(await database(), ['non-Error close failure'])
    expect(nonErrorFailure).toMatchObject({
      message: 'closing Saki product-state domains failed',
      cause: 'non-Error close failure',
    })

    const secondFailure = new Error('storage-generation close failed')
    const aggregate = await productStateCloseFailure(await database(), [firstFailure, secondFailure])
    expect(aggregate).toBeInstanceOf(AggregateError)
    expect((aggregate as AggregateError).errors).toEqual([firstFailure, secondFailure])
  })

  it.each([
    ['ftp://127.0.0.1:43119', 'exact HTTP(S) origin'],
    ['http://127.0.0.1:43119/path', 'exact HTTP(S) origin'],
    ['http://192.168.1.5:43119', 'loopback origin'],
    ['https://saki.example:43119', 'loopback origin'],
  ] as const)('rejects an invalid configured origin %s', async (origin, message) => {
    const ctx = await storageContext(await database())
    try {
      await expect(ctx.plugin(SakiControlPlane, { ...CONFIG, origin })).rejects.toThrow(message)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('never provisions an empty generation selected by a ready manifest', async () => {
    const path = await database()
    const provisioning = await storageContext(path, TEST_SAKI_INSTALLATION_STATE)
    await provisioning.fiber.dispose()
    await expectStartFailure(path, 'ready storage generation is missing control state', {
      ...TEST_SAKI_INSTALLATION_STATE,
      phase: 'ready',
    })
    const ctx = await storageContext(path)
    const domain = await ctx.storageDomain.open(sakiControlPlaneDomainSpec)
    try {
      expect(domain.table('control_state').size).toBe(0)
    } finally {
      await domain.close()
      await ctx.fiber.dispose()
    }
  })

  it('never resumes unfinished provisioning selected by a ready manifest', async () => {
    const path = await initialAccessDatabase()
    let before: unknown
    await edit(path, async (domain) => {
      await domain.table('control_state').update(CONTROL_STATE_KEY, current => ({
        ...current,
        phase: 'provisioning',
      }))
      before = durableState(domain)
    })
    await expectStartFailure(path, 'ready storage generation contains unfinished provisioning', {
      ...TEST_SAKI_INSTALLATION_STATE,
      phase: 'ready',
    })
    await edit(path, async (domain) => {
      expect(durableState(domain)).toEqual(before)
    })
  })

  it('rejects durable control state from another active Installation', async () => {
    const path = await initialAccessDatabase()
    await edit(path, async (domain) => {
      await domain.table('control_state').update(CONTROL_STATE_KEY, current => ({
        ...current,
        installationId: OTHER_INSTALLATION_ID,
      }))
    })
    await expectStartFailure(path, 'control state belongs to another active Installation')
  })

  it('requires the referenced Host Operator Principal to remain human while permitting unrelated automation', async () => {
    const operatorPath = await initialAccessDatabase()
    await edit(operatorPath, async (domain) => {
      const owner = control(domain)
      await domain.table('principals').update(owner.hostOperatorPrincipalId, current => ({
        ...current,
        revision: current.revision + 1,
        kind: 'automation',
      }))
    })
    await expectStartFailure(operatorPath, 'Host Operator Principal must be human')

    const unrelatedPath = await initialAccessDatabase()
    await edit(unrelatedPath, async (domain) => {
      await domain.table('principals').put(OTHER_PRINCIPAL_ID, {
        id: OTHER_PRINCIPAL_ID,
        revision: 0,
        kind: 'automation',
        displayName: 'Project automation',
        state: 'active',
      })
    })
    const running = await start(unrelatedPath)
    expect(running.controlPlane.identity().installationId).toMatch(/^installation-/)
    await running.close()
  })

  it.each([
    ['challenge id', (record: InstallationAccessRecord) => {
      record.challenges[0]!.id = `${record.id}:challenge:1` as SakiBootstrapChallengeId
      return record
    }],
    ['challenge high-water', (record: InstallationAccessRecord) => {
      record.challenges[0]!.ordinal = record.nextChallengeOrdinal
      return record
    }],
    ['challenge duplicate id', (record: InstallationAccessRecord) => {
      record.challenges.push(structuredClone(record.challenges[0]!))
      return record
    }],
    ['challenge duplicate digest', (record: InstallationAccessRecord) => {
      record.challenges.push({
        ...record.challenges[0]!,
        id: `${record.id}:challenge:1` as SakiBootstrapChallengeId,
        ordinal: 1,
      })
      record.nextChallengeOrdinal = 2
      return record
    }],
    ['challenge terminal marker', (record: InstallationAccessRecord) => {
      record.challenges[0]!.terminalAt = record.challenges[0]!.issuedAt
      return record
    }],
    ['challenge terminal revision', (record: InstallationAccessRecord) => {
      Object.assign(record.challenges[0]!, {
        state: 'revoked' as const,
        terminalAt: record.challenges[0]!.issuedAt,
      })
      return record
    }],
    ['challenge lifetime', (record: InstallationAccessRecord) => {
      record.challenges[0]!.expiresAt = record.challenges[0]!.issuedAt
      return record
    }],
    ['challenge terminal time', (record: InstallationAccessRecord) => {
      Object.assign(record.challenges[0]!, {
        revision: 1,
        state: 'revoked' as const,
        terminalAt: record.challenges[0]!.issuedAt - 1,
      })
      return record
    }],
    ['challenge expired terminal time', (record: InstallationAccessRecord) => {
      Object.assign(record.challenges[0]!, {
        revision: 1,
        state: 'expired' as const,
        terminalAt: record.challenges[0]!.expiresAt - 1,
      })
      return record
    }],
    ['challenge consumed relation', (record: InstallationAccessRecord) => {
      Object.assign(record.challenges[0]!, {
        revision: 1,
        state: 'consumed' as const,
        terminalAt: record.challenges[0]!.issuedAt,
      })
      return record
    }],
  ] as const)('rejects an invalid %s', async (_name, mutation) => {
    const path = await initialAccessDatabase()
    await mutateAccess(path, mutation)
    await expectStartFailure(path, 'invalid Bootstrap Challenge')
  })

  it.each([
    ['session id', (record: InstallationAccessRecord) => {
      record.sessions[0]!.id = `${record.id}:session:1` as SakiBrowserSessionId
      return record
    }],
    ['session high-water', (record: InstallationAccessRecord) => {
      record.sessions[0]!.ordinal = record.nextSessionOrdinal
      return record
    }],
    ['session duplicate id', (record: InstallationAccessRecord) => {
      record.sessions.push(structuredClone(record.sessions[0]!))
      return record
    }],
    ['session duplicate digest', (record: InstallationAccessRecord) => {
      record.sessions.push({
        ...record.sessions[0]!,
        id: `${record.id}:session:1` as SakiBrowserSessionId,
        ordinal: 1,
      })
      record.nextSessionOrdinal = 2
      return record
    }],
    ['session terminal marker', (record: InstallationAccessRecord) => {
      record.sessions[0]!.terminalAt = record.sessions[0]!.createdAt
      return record
    }],
    ['session terminal revision', (record: InstallationAccessRecord) => {
      Object.assign(record.sessions[0]!, {
        state: 'revoked' as const,
        terminalAt: record.sessions[0]!.createdAt,
      })
      return record
    }],
    ['session lifetime', (record: InstallationAccessRecord) => {
      record.sessions[0]!.expiresAt = record.sessions[0]!.createdAt
      return record
    }],
    ['session terminal time', (record: InstallationAccessRecord) => {
      Object.assign(record.sessions[0]!, {
        revision: 1,
        state: 'revoked' as const,
        terminalAt: record.sessions[0]!.createdAt - 1,
      })
      return record
    }],
    ['session expired terminal time', (record: InstallationAccessRecord) => {
      Object.assign(record.sessions[0]!, {
        revision: 1,
        state: 'expired' as const,
        terminalAt: record.sessions[0]!.expiresAt - 1,
      })
      return record
    }],
  ] as const)('rejects an invalid %s', async (_name, mutation) => {
    const path = await completedAccessDatabase()
    await mutateAccess(path, mutation)
    await expectStartFailure(path, 'invalid Browser Session')
  })

  it.each([
    ['missing session', (record: InstallationAccessRecord) => {
      record.sessions = []
      return record
    }],
    ['installation', (record: InstallationAccessRecord) => {
      record.sessions[0]!.installationId = OTHER_INSTALLATION_ID
      return record
    }],
    ['generation', (record: InstallationAccessRecord) => {
      record.sessions[0]!.storageGenerationId = HISTORICAL_STORAGE_GENERATION_ID
      return record
    }],
    ['principal', (record: InstallationAccessRecord) => {
      record.sessions[0]!.principalId = OTHER_PRINCIPAL_ID
      return record
    }],
    ['creation time', (record: InstallationAccessRecord) => {
      record.sessions[0]!.createdAt += 1
      return record
    }],
  ] as const)('rejects a consumed challenge with an inconsistent %s', async (relation, mutation) => {
    const path = await completedAccessDatabase()
    if (relation === 'installation' || relation === 'principal') {
      await edit(path, async (domain) => {
        const owner = control(domain)
        if (relation === 'installation') {
          await domain.table('installations').put(OTHER_INSTALLATION_ID, {
            id: OTHER_INSTALLATION_ID,
            revision: 0,
            state: 'retired',
            currentHostId: owner.initialHostId,
          })
        } else {
          await domain.table('principals').put(OTHER_PRINCIPAL_ID, {
            id: OTHER_PRINCIPAL_ID,
            revision: 0,
            kind: 'human',
            displayName: 'Other',
            state: 'retired',
          })
        }
      })
    }
    await mutateAccess(path, mutation)
    await expectStartFailure(path, 'Browser Session')
  })

  it('rejects a retained Browser Session from another Installation after its challenge is cleaned', async () => {
    const path = await completedAccessDatabase()
    await edit(path, async (domain) => {
      const owner = control(domain)
      const otherInstallationId = OTHER_INSTALLATION_ID
      await domain.table('installations').put(otherInstallationId, {
        id: otherInstallationId,
        revision: 0,
        state: 'retired',
        currentHostId: owner.initialHostId,
      })
    })
    await mutateAccess(path, (record) => {
      record.challenges = []
      record.sessions[0]!.installationId = OTHER_INSTALLATION_ID
      return record
    })
    await expectStartFailure(path, 'Browser Session belongs to another Installation')
  })

  it('rejects two consumed challenges that reference the same Browser Session', async () => {
    const path = await completedAccessDatabase()
    await mutateAccess(path, (record) => {
      const initial = record.challenges[0]!
      record.challenges.push({
        ...initial,
        id: `${record.id}:challenge:1` as SakiBootstrapChallengeId,
        ordinal: 1,
        purpose: 'local-reauthentication',
        verifierDigest: 'd'.repeat(64),
      })
      record.nextChallengeOrdinal = 2
      return record
    })
    await expectStartFailure(path, 'multiple Bootstrap Challenges')
  })

  it('rejects session state before immutable bootstrap completion', async () => {
    const path = await completedAccessDatabase()
    await mutateAccess(path, (record) => {
      delete record.bootstrapCompletion
      return record
    })
    await expectStartFailure(path, 'reauthentication state before bootstrap completion')
  })

  it('rejects a reauthentication challenge before immutable bootstrap completion', async () => {
    const path = await initialAccessDatabase()
    await mutateAccess(path, (record) => {
      record.challenges[0]!.purpose = 'local-reauthentication'
      return record
    })
    await expectStartFailure(path, 'reauthentication state before bootstrap completion')
  })

  it.each([
    ['record id', (record: InstallationAccessRecord) => {
      record.id = OTHER_ACCESS_ID
      return record
    }],
    ['Installation relation', (record: InstallationAccessRecord) => {
      record.installationId = OTHER_INSTALLATION_ID
      return record
    }],
  ] as const)('rejects an Installation Access with an unrelated %s', async (_name, mutation) => {
    const path = await initialAccessDatabase()
    await mutateAccess(path, mutation)
    await expectStartFailure(path, 'belongs to another provisioning owner')
  })

  it('rejects a Bootstrap Challenge whose historical Host belongs to another Installation', async () => {
    const path = await initialAccessDatabase()
    await edit(path, async (domain) => {
      const otherInstallationId = OTHER_INSTALLATION_ID
      const otherHostId = OTHER_HOST_ID
      await domain.table('installations').put(otherInstallationId, {
        id: otherInstallationId,
        revision: 0,
        state: 'retired',
        currentHostId: otherHostId,
      })
      await domain.table('hosts').put(otherHostId, {
        id: otherHostId,
        revision: 0,
        installationId: otherInstallationId,
        state: 'retired',
      })
    })
    await mutateAccess(path, (record) => {
      record.challenges[0]!.hostId = OTHER_HOST_ID
      return record
    })
    await expectStartFailure(path, 'references an unrelated Host')
  })

  it('rejects a Bootstrap Challenge from another Installation', async () => {
    const path = await initialAccessDatabase()
    await edit(path, async (domain) => {
      const owner = control(domain)
      await domain.table('installations').put(OTHER_INSTALLATION_ID, {
        id: OTHER_INSTALLATION_ID,
        revision: 0,
        state: 'retired',
        currentHostId: owner.initialHostId,
      })
    })
    await mutateAccess(path, (record) => {
      record.challenges[0]!.installationId = OTHER_INSTALLATION_ID
      return record
    })
    await expectStartFailure(path, 'Bootstrap Challenge belongs to another Installation')
  })

  it('rejects an initial Bootstrap Challenge left issued after completion', async () => {
    const path = await completedAccessDatabase()
    await mutateAccess(path, (record) => {
      const completed = record.challenges[0]!
      const { terminalAt: _terminalAt, browserSessionId: _browserSessionId, ...issued } = completed
      record.challenges.push({
        ...issued,
        id: `${record.id}:challenge:1` as SakiBootstrapChallengeId,
        ordinal: 1,
        revision: 0,
        verifierDigest: 'f'.repeat(64),
        purpose: 'initial-bootstrap',
        state: 'issued',
        issuedAt: completed.issuedAt + 1,
        expiresAt: completed.expiresAt + 1,
      })
      record.nextChallengeOrdinal = 2
      return record
    })
    await expectStartFailure(path, 'invalid bootstrap completion')
  })

  it.each([
    ['purpose', async (_domain: SakiDomain, record: InstallationAccessRecord) => {
      record.challenges[0]!.purpose = 'local-reauthentication'
    }],
    ['state', async (_domain: SakiDomain, record: InstallationAccessRecord) => {
      record.challenges[0]!.state = 'revoked'
      delete record.challenges[0]!.browserSessionId
    }],
    ['session id', async (_domain: SakiDomain, record: InstallationAccessRecord) => {
      const original = record.sessions[0]!
      const secondId = `${record.id}:session:1` as SakiBrowserSessionId
      record.sessions.push({ ...original, id: secondId, ordinal: 1, cookieDigest: 'e'.repeat(64) })
      record.nextSessionOrdinal = 2
      record.bootstrapCompletion!.sessionId = secondId
    }],
    ['Host', async (domain: SakiDomain, record: InstallationAccessRecord) => {
      const owner = control(domain)
      const secondHostId = OTHER_HOST_ID
      await domain.table('hosts').put(secondHostId, {
        id: secondHostId,
        revision: 0,
        installationId: owner.installationId,
        state: 'retired',
      })
      record.bootstrapCompletion!.hostId = secondHostId
    }],
    ['Principal', async (domain: SakiDomain, record: InstallationAccessRecord) => {
      const secondPrincipalId = OTHER_PRINCIPAL_ID
      await domain.table('principals').put(secondPrincipalId, {
        id: secondPrincipalId,
        revision: 0,
        kind: 'human',
        displayName: 'Second',
        state: 'retired',
      })
      record.bootstrapCompletion!.principalId = secondPrincipalId
    }],
    ['completion time', async (_domain: SakiDomain, record: InstallationAccessRecord) => {
      record.bootstrapCompletion!.completedAt += 1
    }],
  ] as const)('rejects a completion summary that disagrees with its retained challenge %s', async (_name, corrupt) => {
    const path = await completedAccessDatabase()
    await edit(path, async (domain) => {
      const owner = control(domain)
      const record = structuredClone(access(domain))
      await corrupt(domain, record)
      await domain.table('installation_access').put(owner.installationAccessId, record)
    })
    await expectStartFailure(path, 'completion disagrees with its retained challenge')
  })

  it.each(['Principal', 'completion time'] as const)(
    'rejects a completion summary that disagrees with its retained Browser Session %s',
    async (scenario) => {
      const path = await completedAccessDatabase()
      await edit(path, async (domain) => {
        const owner = control(domain)
        const record = structuredClone(access(domain))
        record.challenges = []
        if (scenario === 'Principal') {
          const secondPrincipalId = OTHER_PRINCIPAL_ID
          await domain.table('principals').put(secondPrincipalId, {
            id: secondPrincipalId,
            revision: 0,
            kind: 'human',
            displayName: 'Second',
            state: 'retired',
          })
          record.bootstrapCompletion!.principalId = secondPrincipalId
        } else {
          record.bootstrapCompletion!.completedAt += 1
        }
        await domain.table('installation_access').put(owner.installationAccessId, record)
      })
      await expectStartFailure(path, 'completion disagrees with its retained Browser Session')
    },
  )

  it('rejects a completion Host from another Installation', async () => {
    const path = await completedAccessDatabase()
    await edit(path, async (domain) => {
      const owner = control(domain)
      const otherInstallationId = OTHER_INSTALLATION_ID
      const otherHostId = OTHER_HOST_ID
      await domain.table('installations').put(otherInstallationId, {
        id: otherInstallationId,
        revision: 0,
        state: 'retired',
        currentHostId: otherHostId,
      })
      await domain.table('hosts').put(otherHostId, {
        id: otherHostId,
        revision: 0,
        installationId: otherInstallationId,
        state: 'retired',
      })
      await domain.table('installation_access').update(owner.installationAccessId, record => ({
        ...record,
        bootstrapCompletion: { ...record.bootstrapCompletion!, hostId: otherHostId },
      }))
    })
    await expectStartFailure(path, 'invalid bootstrap completion')
  })

  it.each(['challengeId', 'sessionId'] as const)(
    'rejects an unallocated completion %s after detailed records are cleaned',
    async (field) => {
      const path = await completedAccessDatabase()
      await mutateAccess(path, (record) => {
        record.challenges = []
        record.sessions = []
        if (field === 'challengeId') {
          record.bootstrapCompletion!.challengeId = `${record.id}:challenge:99` as SakiBootstrapChallengeId
        } else {
          record.bootstrapCompletion!.sessionId = `${record.id}:session:99` as SakiBrowserSessionId
        }
        return record
      })
      await expectStartFailure(path, 'unallocated entry identity')
    },
  )

  it.each([
    ['another aggregate', (_record: InstallationAccessRecord) =>
      `${OTHER_ACCESS_ID}:challenge:0` as SakiBootstrapChallengeId],
    ['an unsafe ordinal', (record: InstallationAccessRecord) =>
      `${record.id}:challenge:${'9'.repeat(400)}` as SakiBootstrapChallengeId],
  ] as const)('rejects a completion challenge identity from %s', async (_name, challengeId) => {
    const path = await completedAccessDatabase()
    await mutateAccess(path, (record) => {
      record.challenges = []
      record.sessions = []
      record.bootstrapCompletion!.challengeId = challengeId(record)
      return record
    })
    await expectStartFailure(path, 'unallocated entry identity')
  })

  it.each([
    ['Installation', 'installations'],
    ['Host', 'hosts'],
    ['Principal', 'principals'],
    ['Grant', 'grants'],
    ['Installation Access', 'installation_access'],
  ] as const)('rejects an inconsistent provisioning %s child', async (_name, tableName) => {
    const path = await initialAccessDatabase()
    await edit(path, async (domain) => {
      await domain.table('development_project_registry').delete(DEVELOPMENT_PROJECT_REGISTRY_KEY)
      await domain.table('control_state').update(CONTROL_STATE_KEY, current => ({
        ...current,
        revision: current.revision + 1,
        phase: 'provisioning',
      }))
      const owner = control(domain)
      const table = domain.table(tableName)
      const key = tableName === 'installations'
        ? owner.installationId
        : tableName === 'hosts'
          ? owner.initialHostId
          : tableName === 'principals'
            ? owner.hostOperatorPrincipalId
            : tableName === 'grants'
              ? owner.hostOperatorGrantId
              : owner.installationAccessId
      await table.update(key, current => ({ ...current, revision: current.revision + 1 }))
    })
    await expectStartFailure(path, `provisioning ${_name} is inconsistent`, TEST_SAKI_INSTALLATION_STATE)
  })

  it('validates every retained provisioning child before filling an earlier missing child', async () => {
    const path = await initialAccessDatabase()
    await edit(path, async (domain) => {
      await domain.table('development_project_registry').delete(DEVELOPMENT_PROJECT_REGISTRY_KEY)
      await domain.table('control_state').update(CONTROL_STATE_KEY, current => ({
        ...current,
        revision: current.revision + 1,
        phase: 'provisioning',
      }))
      const owner = control(domain)
      await domain.table('installations').delete(owner.installationId)
      await domain.table('hosts').update(owner.initialHostId, current => ({
        ...current,
        revision: current.revision + 1,
      }))
    })
    let before: unknown
    await edit(path, async (domain) => { before = durableState(domain) })

    await expectStartFailure(path, 'provisioning Host is inconsistent', TEST_SAKI_INSTALLATION_STATE)

    await edit(path, async (domain) => { expect(durableState(domain)).toEqual(before) })
  })

  it('rejects Development Project product records before provisioning is ready', async () => {
    const path = await initialAccessDatabase()
    await edit(path, async (domain) => {
      await domain.table('control_state').update(CONTROL_STATE_KEY, current => ({
        ...current,
        revision: current.revision + 1,
        phase: 'provisioning',
      }))
    })

    await expectStartFailure(
      path,
      'provisioning contains Development Project product records',
      TEST_SAKI_INSTALLATION_STATE,
    )
  })

  it('rejects child rows outside the provisioning owner stable references', async () => {
    const path = await initialAccessDatabase()
    await edit(path, async (domain) => {
      await domain.table('development_project_registry').delete(DEVELOPMENT_PROJECT_REGISTRY_KEY)
      await domain.table('control_state').update(CONTROL_STATE_KEY, current => ({
        ...current,
        revision: current.revision + 1,
        phase: 'provisioning',
      }))
      await domain.table('hosts').put(OTHER_HOST_ID, {
        id: OTHER_HOST_ID,
        revision: 0,
        installationId: control(domain).installationId,
        state: 'retired',
      })
    })
    await expectStartFailure(path, 'child outside its stable references', TEST_SAKI_INSTALLATION_STATE)
  })

  it('rejects extra provisioning owners and a missing owner in a non-empty domain', async () => {
    const extraOwnerPath = await initialAccessDatabase()
    await edit(extraOwnerPath, async (domain) => {
      await domain.table('control_state').put('other-control' as typeof CONTROL_STATE_KEY, control(domain))
    })
    await expectStartFailure(
      extraOwnerPath,
      'unexpected provisioning owner records',
      TEST_SAKI_INSTALLATION_STATE,
    )

    const missingOwnerPath = await initialAccessDatabase()
    await edit(missingOwnerPath, async (domain) => {
      await domain.table('control_state').delete(CONTROL_STATE_KEY)
    })
    await expectStartFailure(
      missingOwnerPath,
      'control state is missing from a non-empty domain',
      TEST_SAKI_INSTALLATION_STATE,
    )
  })

  it.each([
    ['Installation', 'installations'],
    ['Host', 'hosts'],
    ['Principal', 'principals'],
    ['Grant', 'grants'],
    ['Installation Access', 'installation_access'],
  ] as const)('rejects a missing required %s record', async (name, tableName) => {
    const path = await initialAccessDatabase()
    await edit(path, async (domain) => {
      const owner = control(domain)
      const table = domain.table(tableName)
      const key = tableName === 'installations'
        ? owner.installationId
        : tableName === 'hosts'
          ? owner.initialHostId
          : tableName === 'principals'
            ? owner.hostOperatorPrincipalId
            : tableName === 'grants'
              ? owner.hostOperatorGrantId
              : owner.installationAccessId
      await table.delete(key)
    })
    await expectStartFailure(path, name === 'Installation Access' ? 'is not initialized' : `${name} `)
  })

  it.each(['Installation', 'Host', 'Principal', 'Grant'] as const)(
    'rejects a %s record whose embedded id disagrees with its table key',
    async (name) => {
      const path = await initialAccessDatabase()
      await edit(path, async (domain) => {
        const owner = control(domain)
        if (name === 'Installation') {
          await domain.table('installations').update(owner.installationId, current => ({
            ...current,
            id: OTHER_INSTALLATION_ID,
          }))
        } else if (name === 'Host') {
          await domain.table('hosts').update(owner.initialHostId, current => ({
            ...current,
            id: OTHER_HOST_ID,
          }))
        } else if (name === 'Principal') {
          await domain.table('principals').update(owner.hostOperatorPrincipalId, current => ({
            ...current,
            id: OTHER_PRINCIPAL_ID,
          }))
        } else {
          await domain.table('grants').update(owner.hostOperatorGrantId, current => ({
            ...current,
            id: OTHER_GRANT_ID,
          }))
        }
      })
      await expectStartFailure(path, `${name} record id disagrees with its table key`)
    },
  )

  it('rejects live reads while provisioning and inconsistent entity relationships', async () => {
    const path = await database()
    const running = await start(path)
    const domain = running.ctx.storageDomain.get(sakiControlPlaneDomainSpec.name) as unknown as SakiDomain
    await domain.table('control_state').update(CONTROL_STATE_KEY, current => ({
      ...current,
      revision: current.revision + 1,
      phase: 'provisioning',
    }))
    expect(() => running.controlPlane.identity()).toThrow('provisioning is not ready')
    await domain.table('control_state').update(CONTROL_STATE_KEY, current => ({
      ...current,
      revision: current.revision + 1,
      phase: 'ready',
    }))
    const owner = control(domain)
    await domain.table('grants').update(owner.hostOperatorGrantId, current => ({
      ...current,
      revision: current.revision + 1,
      installationId: OTHER_INSTALLATION_ID,
    }))
    expect(() => running.controlPlane.identity()).toThrow('entity relationships are inconsistent')
    await running.close()
  })

  it('rejects a live Access read after its provisioning owner is removed', async () => {
    const running = await start(await database())
    const domain = running.ctx.storageDomain.get(sakiControlPlaneDomainSpec.name) as unknown as SakiDomain
    await domain.table('control_state').delete(CONTROL_STATE_KEY)
    await expect(running.controlPlane.access.readAccess(undefined, AbortSignal.timeout(1_000)))
      .rejects.toThrow('control plane is not provisioned')
    await running.close()
  })
})
