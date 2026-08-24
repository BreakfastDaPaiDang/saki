import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import WorkspaceRegistry, {
  WorkspaceId,
  workspaceDomainSpec,
} from '@deepseek-ai/dsh-workspace'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalSakiHostExecution from '@breakfastdapaidang/saki-execution-local'
import {
  canonicalDigest,
  computeProjectInspectionFingerprint,
} from '@breakfastdapaidang/saki-execution'
import type {
  InspectProjectSelectionResult,
  ProjectSelectionInspection,
  ProjectSelectionProjection,
  SakiHostExecution,
  SakiHostId,
  TrustedProjectSelectionObservation,
} from '@breakfastdapaidang/saki-execution'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SakiControlPlane, {
  type RegisterDevelopmentProjectIntent,
  type SakiAuthenticationContext,
  type SakiControlIntentId,
  type SakiControlPlaneModule,
  type SakiInstallationGenerationId,
} from '../src/index.ts'
import { SAKI_PROJECT_PROJECTION_FIXTURES } from '../src/fixtures.ts'
import { resolveSakiAuthentication, takeSakiCookieHeader } from '../src/host.ts'
import { DevelopmentProjects } from '../src/projects.ts'
import {
  registrationIntentRecordSchema,
  resourceBindingRecordSchema,
  sakiControlPlaneDomainSpec,
} from '../src/spec.ts'
import type {
  DevelopmentProjectRegistryRecord,
  RegistrationIntentRecord,
  ResourceBindingRecord,
} from '../src/spec.ts'

const run = promisify(execFile)
const roots: string[] = []
const openHarnesses = new Set<Harness>()
const ORIGIN = 'http://127.0.0.1:43119'
const CONTROL_CONFIG = {
  origin: ORIGIN,
  challengeTtlMs: 60_000,
  sessionTtlMs: 3_600_000,
  terminalRetentionMs: 86_400_000,
  cookieName: 'saki_session',
} as const

interface DurablePaths {
  readonly root: string
  readonly json: string
  readonly sqlite: string
}

interface Harness {
  readonly ctx: Context
  readonly control: SakiControlPlaneModule
  readonly authentication: SakiAuthenticationContext
  readonly close: () => Promise<void>
}

type SakiDomain = Domain<typeof sakiControlPlaneDomainSpec>

afterEach(async () => {
  await Promise.all([...openHarnesses].map(harness => harness.close()))
  await Promise.all(roots.splice(0).map(async (root) => { await rm(root, { recursive: true, force: true }) }))
})

async function paths(): Promise<DurablePaths> {
  const root = await mkdtemp(join(tmpdir(), 'saki-projects-'))
  roots.push(root)
  return { root, json: join(root, 'storages'), sqlite: join(root, 'saki.sqlite') }
}

async function repository(parent: string, name: string): Promise<string> {
  const root = join(parent, name)
  await run('git', ['init', root], { windowsHide: true })
  await run('git', ['config', 'user.name', 'Saki Test'], { cwd: root, windowsHide: true })
  await run('git', ['config', 'user.email', 'saki@example.invalid'], { cwd: root, windowsHide: true })
  await writeFile(join(root, 'tracked.txt'), 'initial\n')
  await run('git', ['add', 'tracked.txt'], { cwd: root, windowsHide: true })
  await run('git', ['commit', '-m', 'initial'], { cwd: root, windowsHide: true })
  return root
}

async function context(durable: DurablePaths, baselineMaxFileBytes = 1024 * 1024): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: durable.json })
  await ctx.plugin(StorageSqlite, { path: durable.sqlite, journalMode: 'delete' })
  await ctx.plugin(StorageDomain, { backend: 'json', routes: { saki_control_plane: 'sqlite' } })
  ctx.provide('sessionPersistence', {
    list: () => Promise.resolve([]),
    load: () => Promise.reject(new Error('no sessions')),
    inspect: () => Promise.reject(new Error('no sessions')),
  } as never)
  await ctx.plugin(WorkspaceRegistry)
  await ctx.plugin(LocalFileSystem, { cwd: durable.root })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalSakiHostExecution, {
    gitCommandTimeoutMs: 10_000,
    gitTerminationGraceMs: 100,
    maxGitStdoutBytes: 1024 * 1024,
    maxGitStderrBytes: 64 * 1024,
    baselineMaxEntries: 1_000,
    baselineMaxPathBytes: 1024 * 1024,
    baselineMaxFileBytes,
    baselineMaxTotalFileBytes: 4 * 1024 * 1024,
    baselineMaxCaptureMs: 10_000,
  })
  return ctx
}

async function seedWorkspace(durable: DurablePaths, id: string, path: string): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: durable.json })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  const domain = await ctx.storageDomain.open(workspaceDomainSpec)
  const workspaceId = WorkspaceId(id)
  const timestamp = '2026-08-20T00:00:00.000Z'
  try {
    await domain.table('workspaces').put(workspaceId, {
      path: await realpath(path),
      title: 'Pre-existing Workspace',
      sessionIds: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    await domain.global.set({
      initialized: true,
      workspaceIds: [workspaceId],
      archivedSessionIds: [],
    })
  } finally {
    await domain.close()
    await ctx.fiber.dispose()
  }
}

async function start(durable: DurablePaths, baselineMaxFileBytes = 1024 * 1024): Promise<Harness> {
  const ctx = await context(durable, baselineMaxFileBytes)
  return await mountControlPlane(ctx)
}

async function mountControlPlane(ctx: Context): Promise<Harness> {
  const controlFiber = await ctx.plugin(SakiControlPlane, CONTROL_CONFIG)
  const secret = ctx.sakiControlPlane.bootstrap.take()!.consume()
  const exchange = await ctx.sakiControlPlane.access.exchangeBootstrap(
    { origin: ORIGIN }, { secret }, new AbortController().signal,
  )
  if (!exchange.ok) throw new Error('bootstrap failed')
  const cookieHeader = takeSakiCookieHeader(exchange)
  const cookie = cookieHeader?.split(';', 1)[0]?.split('=', 2)[1]
  if (cookie === undefined) throw new Error('bootstrap returned no cookie')
  const resolution = await resolveSakiAuthentication(ctx.sakiControlPlane, cookie, {
    origin: ORIGIN,
    mutation: false,
  }, new AbortController().signal)
  if (!resolution.ok) throw new Error('authentication failed')
  let closed = false
  const harness: Harness = {
    ctx,
    control: ctx.sakiControlPlane,
    authentication: resolution.authentication,
    close: async () => {
      if (closed) return
      closed = true
      openHarnesses.delete(harness)
      await controlFiber.dispose()
      await ctx.fiber.dispose()
    },
  }
  openHarnesses.add(harness)
  return harness
}

function liveSakiDomain(ctx: Context): SakiDomain {
  const domain = ctx.storageDomain.get(sakiControlPlaneDomainSpec.name)
  if (domain === undefined) throw new Error('Saki durable domain is not open')
  return domain as unknown as SakiDomain
}

async function editSaki(durable: DurablePaths, operation: (domain: SakiDomain) => Promise<void>): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageSqlite, { path: durable.sqlite, journalMode: 'delete' })
  await ctx.plugin(StorageDomain, { backend: 'sqlite' })
  const domain = await ctx.storageDomain.open(sakiControlPlaneDomainSpec)
  try {
    await operation(domain)
  } finally {
    await domain.close()
    await ctx.fiber.dispose()
  }
}

function durableState(domain: SakiDomain): unknown {
  return structuredClone({
    control: [...domain.table('control_state').entries()],
    installations: [...domain.table('installations').entries()],
    hosts: [...domain.table('hosts').entries()],
    principals: [...domain.table('principals').entries()],
    grants: [...domain.table('grants').entries()],
    access: [...domain.table('installation_access').entries()],
    registry: [...domain.table('development_project_registry').entries()],
    intents: [...domain.table('registration_intents').entries()],
  })
}

async function inspected(harness: Harness, directoryLocator: string) {
  const identity = harness.control.identity()
  const result = await harness.control.query(harness.authentication, {
    type: 'inspect-project-selection',
    hostId: identity.hostId,
    directoryLocator,
  }, new AbortController().signal)
  expect(result.ok).toBe(true)
  if (!result.ok || result.projection.type !== 'inspect-project-selection' || !result.projection.result.ok) {
    throw new Error('inspection failed')
  }
  return result.projection.result.selection
}

function intent(
  id: string,
  title: string,
  directoryLocator: string,
  expectedRegistryRevision: number,
  selection: Awaited<ReturnType<typeof inspected>>,
): RegisterDevelopmentProjectIntent {
  return {
    type: 'register-development-project',
    intentId: id as SakiControlIntentId,
    projectTitle: title,
    hostId: selection.hostId,
    directoryLocator,
    expectedRegistryRevision,
    confirmedFingerprint: selection.fingerprint,
    confirmedBaseline: selection.baseline,
  }
}

function signedInspection(
  projection: Omit<ProjectSelectionProjection, 'fingerprint'>,
  trusted: TrustedProjectSelectionObservation,
): ProjectSelectionInspection {
  return {
    trusted,
    projection: {
      ...projection,
      fingerprint: computeProjectInspectionFingerprint(projection, trusted),
    },
  }
}

function fixtureInspection(
  hostId: SakiHostId,
  canonicalWorktreePath: string,
  identityDigit: string,
  workspaceId?: WorkspaceId,
): ProjectSelectionInspection {
  const { fingerprint, ...projection } = SAKI_PROJECT_PROJECTION_FIXTURES.cleanSelection
  void fingerprint
  const canonicalGitDirectory = join(canonicalWorktreePath, '.git')
  return signedInspection({
    ...projection,
    hostId,
    ...(workspaceId === undefined ? {} : { workspaceId }),
  }, {
    canonicalWorktreePath,
    canonicalGitDirectory,
    canonicalCommonGitDirectory: canonicalGitDirectory,
    gitDirectoryIdentity: { version: 1, digest: identityDigit.repeat(64) },
    commonGitDirectoryIdentity: { version: 1, digest: identityDigit.repeat(64) },
    comparison: { fileMode: true, symlinks: true, autocrlf: false },
  })
}

function clearRegistrationCommit(candidate: RegistrationIntentRecord): void {
  delete candidate.projectId
  delete candidate.resourceBindingId
  delete candidate.registryRevision
}

function clearRegistrationWorkspace(candidate: RegistrationIntentRecord): void {
  delete candidate.workspaceId
  delete candidate.workspaceInspection
}

async function disposeDuringDispatchInspection(
  harness: Harness,
  request: RegisterDevelopmentProjectIntent,
): Promise<void> {
  const originalInspect = harness.ctx.sakiHostExecution.inspectProjectSelection
    .bind(harness.ctx.sakiHostExecution)
  const started = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  let inspectionCount = 0
  vi.spyOn(harness.ctx.sakiHostExecution, 'inspectProjectSelection')
    .mockImplementation(async (input, signal) => {
      inspectionCount += 1
      if (inspectionCount === 2) {
        started.resolve(undefined)
        await release.promise
      }
      return await originalInspect(input, signal)
    })
  const submission = harness.control.submit(
    harness.authentication,
    request,
    new AbortController().signal,
  )
  await started.promise
  const closing = harness.close()
  release.resolve(undefined)
  await expect(submission).rejects.toThrow()
  await closing
}

describe('Development Project registration', { timeout: 60_000 }, () => {
  it('persists one real Git/Workspace/SQLite registration and replays stable ids after restart', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'ordinary')
    let harness = await start(durable)
    const selection = await inspected(harness, repo)
    const request = intent('intent-11111111-1111-4111-8111-111111111111', 'Ordinary project', repo, 0, selection)

    const first = await harness.control.submit(harness.authentication, request, new AbortController().signal)
    expect(first).toMatchObject({ ok: true, receipt: { state: 'confirmed', registryRevision: 1 } })
    const replay = await harness.control.submit(harness.authentication, request, new AbortController().signal)
    expect(replay).toEqual(first)
    const index = await harness.control.query(harness.authentication, { type: 'project-index' }, new AbortController().signal)
    expect(index).toMatchObject({
      ok: true,
      projection: {
        type: 'project-index',
        revision: 1,
        projects: [{ projectTitle: 'Ordinary project', binding: { health: 'active', baseline: 'complete' } }],
      },
    })
    await harness.close()

    harness = await start(durable)
    const reopened = await harness.control.query(harness.authentication, { type: 'project-index' }, new AbortController().signal)
    expect(reopened).toMatchObject({
      ok: true,
      projection: { projects: [{ id: first.ok ? first.receipt.projectId : 'missing' }] },
    })
    const workspaceMedium = JSON.parse(await readFile(join(durable.json, 'workspace.json'), 'utf8')) as {
      unit: { name: string; version: number }
      global: { archivedSessionIds: unknown }
    }
    expect(workspaceMedium.unit).toEqual({ name: 'workspace', version: 2 })
    expect(workspaceMedium.global).toHaveProperty('archivedSessionIds')
    const database = new DatabaseSync(durable.sqlite)
    try {
      expect(database.prepare('SELECT name, version FROM units ORDER BY name').all()).toEqual([
        { name: 'saki_control_plane', version: 2 },
      ])
      const tables = database.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
      ).all().map(row => (row as { name: string }).name)
      expect(tables).toEqual([
        'u_saki_control_plane_control_state',
        'u_saki_control_plane_development_project_registry',
        'u_saki_control_plane_grants',
        'u_saki_control_plane_hosts',
        'u_saki_control_plane_installation_access',
        'u_saki_control_plane_installations',
        'u_saki_control_plane_principals',
        'u_saki_control_plane_registration_intents',
        'unit_globals',
        'units',
      ])
    } finally {
      database.close()
    }
    await harness.close()
  })

  it('returns typed Project and selection misses without changing the registered aggregate', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'typed-misses')
    const harness = await start(durable)
    const selection = await inspected(harness, repo)
    const request = intent(
      'intent-18181818-1818-4818-8818-181818181818',
      'Typed misses',
      repo,
      0,
      selection,
    )
    const registered = await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )
    if (!registered.ok) throw new Error('registration failed')

    expect(await harness.control.query(harness.authentication, {
      type: 'development-workspace',
      projectId: registered.receipt.projectId,
      expectedRegistryRevision: 0,
    }, new AbortController().signal)).toEqual({ ok: false, reason: 'stale' })
    expect(await harness.control.query(harness.authentication, {
      type: 'development-workspace',
      projectId: 'project-18181818-1818-4818-8818-181818181819' as typeof registered.receipt.projectId,
      expectedRegistryRevision: 1,
    }, new AbortController().signal)).toEqual({ ok: false, reason: 'not-found' })
    expect(await harness.control.query(harness.authentication, {
      type: 'inspect-project-selection',
      hostId: harness.control.identity().hostId,
      directoryLocator: join(durable.root, 'missing-selection'),
    }, new AbortController().signal)).toEqual({
      ok: true,
      projection: {
        type: 'inspect-project-selection',
        result: { ok: false, reason: 'missing' },
      },
    })
    expect(await harness.control.submit(harness.authentication, {
      ...request,
      intentId: 'intent-18181818-1818-4818-8818-18181818181a' as SakiControlIntentId,
      directoryLocator: join(durable.root, 'missing-registration'),
      expectedRegistryRevision: 1,
    }, new AbortController().signal)).toEqual({ ok: false, reason: 'conflict' })
    expect(await harness.control.submit(harness.authentication, {
      ...request,
      intentId: 'intent-18181818-1818-4818-8818-18181818181b' as SakiControlIntentId,
      hostId: 'host-18181818-1818-4818-8818-181818181818' as SakiHostId,
      expectedRegistryRevision: 1,
    }, new AbortController().signal)).toEqual({ ok: false, reason: 'denied' })
    expect(liveSakiDomain(harness.ctx).table('development_project_registry')
      .get('development-project-registry')?.projects).toHaveLength(1)
    await harness.close()
  })

  it('rejects changed replay payload and duplicate aliases without creating a second Project', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'duplicate')
    const harness = await start(durable)
    const selection = await inspected(harness, repo)
    const accepted = intent('intent-22222222-2222-4222-8222-222222222222', 'First title', repo, 0, selection)
    expect((await harness.control.submit(harness.authentication, accepted, new AbortController().signal)).ok).toBe(true)

    const changed = await harness.control.submit(harness.authentication, { ...accepted, projectTitle: 'Changed title' }, new AbortController().signal)
    expect(changed).toEqual({ ok: false, reason: 'conflict' })
    const alias = `${repo}/`
    const aliasSelection = await inspected(harness, alias)
    const duplicate = intent(
      'intent-33333333-3333-4333-8333-333333333333',
      'Alias',
      alias,
      1,
      aliasSelection,
    )
    const duplicateResult = await harness.control.submit(harness.authentication, duplicate, new AbortController().signal)
    expect(duplicateResult).toMatchObject({ ok: false, reason: 'conflict', receipt: { reason: 'duplicate-binding' } })
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(1)
    const index = await harness.control.query(harness.authentication, { type: 'project-index' }, new AbortController().signal)
    expect(index.ok && index.projection.type === 'project-index' ? index.projection.projects : []).toHaveLength(1)
    await harness.close()
  })

  it('scopes canonical-path duplicate identities to their owning Host', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'cross-host-path')
    const harness = await start(durable)
    const firstRequest = intent(
      'intent-28282828-2828-4828-8828-282828282828',
      'First Host project',
      repo,
      0,
      await inspected(harness, repo),
    )
    expect(await harness.control.submit(
      harness.authentication,
      firstRequest,
      new AbortController().signal,
    )).toMatchObject({ ok: true })

    const registryTable = liveSakiDomain(harness.ctx).table('development_project_registry')
    const intentTable = liveSakiDomain(harness.ctx).table('registration_intents')
    const firstIntent = intentTable.get(firstRequest.intentId)
    const registry = registryTable.get('development-project-registry')
    const firstInspection = registry?.resourceBindings[0]?.currentInspection
    if (firstIntent === undefined || firstInspection === undefined) {
      throw new Error('first Host registration fixture is incomplete')
    }
    const otherHostId = 'host-29292929-2929-4929-8929-292929292929' as SakiHostId
    const otherWorkspaceId = WorkspaceId('workspace-other-host')
    const { fingerprint: _fingerprint, ...projection } = firstInspection.projection
    const otherInspection = signedInspection({
      ...projection,
      hostId: otherHostId,
      workspaceId: otherWorkspaceId,
    }, firstInspection.trusted)
    const otherRequest = intent(
      'intent-29292929-2929-4929-8929-292929292929',
      'Other Host project',
      repo,
      1,
      otherInspection.projection,
    )
    const execution = {
      inspectProjectSelection: () => Promise.resolve({ ok: true, inspection: otherInspection }),
    } as unknown as SakiHostExecution
    const projects = new DevelopmentProjects({
      registryTable,
      intentTable,
      execution,
      workspaces: {
        list: () => [{ id: otherWorkspaceId, path: firstInspection.trusted.canonicalWorktreePath }],
        create: vi.fn(),
      } as never,
      authorityCurrent: () => true,
      validateActorReference: () => {},
    })

    expect(await projects.register(
      otherRequest,
      { ...firstIntent.payload.actor, hostId: otherHostId },
      otherInspection,
      new AbortController().signal,
    )).toMatchObject({ ok: true, receipt: { state: 'confirmed', registryRevision: 2 } })
    const committed = projects.registry()
    expect(committed.resourceBindings.map(binding => binding.hostId)).toEqual([
      firstIntent.payload.actor.hostId,
      otherHostId,
    ])
    expect(new Set(committed.canonicalWorktreeIndex.map(entry => entry.path))).toEqual(new Set([
      firstInspection.trusted.canonicalWorktreePath,
    ]))
    expect(new Set(committed.canonicalWorktreeIndex.map(entry => entry.hostId))).toEqual(new Set([
      firstIntent.payload.actor.hostId,
      otherHostId,
    ]))
    await harness.close()
  })

  it('registers linked worktrees independently while sharing their common Git directory', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'linked-main')
    const linked = join(durable.root, 'linked-secondary')
    await run('git', ['worktree', 'add', '-b', 'linked-fixture', linked], {
      cwd: repo,
      windowsHide: true,
    })
    const harness = await start(durable)
    const hostId = harness.control.identity().hostId
    const mainObservation = await harness.ctx.sakiHostExecution.inspectProjectSelection({
      hostId,
      directoryLocator: repo,
    }, new AbortController().signal)
    const linkedObservation = await harness.ctx.sakiHostExecution.inspectProjectSelection({
      hostId,
      directoryLocator: linked,
    }, new AbortController().signal)
    if (!mainObservation.ok || !linkedObservation.ok) throw new Error('linked-worktree fixture inspection failed')
    expect(mainObservation.inspection.trusted.canonicalCommonGitDirectory)
      .toBe(linkedObservation.inspection.trusted.canonicalCommonGitDirectory)
    expect(mainObservation.inspection.trusted.canonicalGitDirectory)
      .not.toBe(linkedObservation.inspection.trusted.canonicalGitDirectory)

    const first = await harness.control.submit(harness.authentication, intent(
      'intent-34343434-3434-4434-8434-343434343434',
      'Main worktree',
      repo,
      0,
      mainObservation.inspection.projection,
    ), new AbortController().signal)
    const secondSelection = await inspected(harness, linked)
    const second = await harness.control.submit(harness.authentication, intent(
      'intent-35353535-3535-4535-8535-353535353535',
      'Linked worktree',
      linked,
      1,
      secondSelection,
    ), new AbortController().signal)

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(first.ok && second.ok ? first.receipt.projectId : undefined)
      .not.toBe(second.ok ? second.receipt.projectId : undefined)
    const index = await harness.control.query(
      harness.authentication,
      { type: 'project-index' },
      new AbortController().signal,
    )
    expect(index.ok && index.projection.type === 'project-index'
      ? index.projection.projects
      : []).toHaveLength(2)
    await harness.close()
  })

  it.each([
    { label: 'empty', workspaceId: '' },
    { label: 'non-UUID', workspaceId: 'workspace-sentinel' },
  ])('adopts and reopens a pre-existing $label Workspace identity', async ({ workspaceId }) => {
    const durable = await paths()
    const repo = await repository(durable.root, `workspace-id-${workspaceId === '' ? 'empty' : 'opaque'}`)
    await seedWorkspace(durable, workspaceId, repo)
    let harness = await start(durable)
    const selection = await inspected(harness, repo)
    expect(Object.hasOwn(selection, 'workspaceId')).toBe(true)
    expect(selection.workspaceId).toBe(workspaceId)
    const request = intent(
      workspaceId === ''
        ? 'intent-36363636-3636-4636-8636-363636363636'
        : 'intent-37373737-3737-4737-8737-373737373737',
      'Opaque Workspace identity',
      repo,
      0,
      selection,
    )
    const create = vi.spyOn(harness.ctx.workspaceRegistry, 'create')
    const first = await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )
    expect(first).toMatchObject({ ok: true, receipt: { state: 'confirmed' } })
    expect(create).not.toHaveBeenCalled()
    if (!first.ok) throw new Error('pre-existing Workspace registration failed')
    const detail = await harness.control.query(harness.authentication, {
      type: 'development-workspace',
      projectId: first.receipt.projectId,
      expectedRegistryRevision: first.receipt.registryRevision,
    }, new AbortController().signal)
    expect(detail.ok && detail.projection.type === 'development-workspace'
      ? detail.projection.currentSelection?.workspaceId
      : undefined).toBe(workspaceId)
    await harness.close()

    harness = await start(durable)
    expect(harness.ctx.workspaceRegistry.list().map(workspace => workspace.id)).toEqual([workspaceId])
    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toEqual(first)
    await harness.close()
  })

  it('registers an explicit unavailable baseline but disables automatic mutation', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'bounded')
    await writeFile(join(repo, 'tracked.txt'), 'content beyond bound\n')
    const harness = await start(durable, 4)
    const selection = await inspected(harness, repo)
    expect(selection.baseline).toMatchObject({ kind: 'unavailable', reason: 'file-limit' })
    expect(selection.baseline).not.toHaveProperty('digest')
    const request = intent('intent-44444444-4444-4444-8444-444444444444', 'Bounded', repo, 0, selection)
    const registered = await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )
    if (!registered.ok) throw new Error('registration failed')
    const index = await harness.control.query(harness.authentication, { type: 'project-index' }, new AbortController().signal)
    expect(index).toMatchObject({
      ok: true,
      projection: { projects: [{ binding: {
        baseline: 'unavailable',
        automaticMutationEligible: false,
        configurationGaps: ['baseline-unavailable'],
      } }] },
    })
    expect(await harness.control.query(harness.authentication, {
      type: 'development-workspace',
      projectId: registered.receipt.projectId,
      expectedRegistryRevision: registered.receipt.registryRevision,
    }, new AbortController().signal)).toMatchObject({
      ok: true,
      projection: {
        recovery: { state: 'blocked', reasons: ['baseline-unavailable', 'dirty'] },
      },
    })
    await harness.close()
  })

  it('marks a missing registered binding on restart without changing stable ids', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'movable')
    const canonicalRepo = await realpath(repo)
    let harness = await start(durable)
    const selection = await inspected(harness, repo)
    const registered = await harness.control.submit(harness.authentication,
      intent('intent-55555555-5555-4555-8555-555555555555', 'Movable', repo, 0, selection),
      new AbortController().signal)
    if (!registered.ok) throw new Error('registration failed')
    await harness.close()

    const restartMissing = async () => {
      const restarted = await context(durable)
      const inspect = vi.spyOn(restarted.sakiHostExecution, 'inspectProjectSelection')
        .mockResolvedValue({ ok: false, reason: 'missing' })
      return { harness: await mountControlPlane(restarted), inspect }
    }
    let missing = await restartMissing()
    harness = missing.harness
    expect(missing.inspect).toHaveBeenCalled()
    expect(missing.inspect.mock.calls.every(([input]) => input.directoryLocator === canonicalRepo)).toBe(true)
    const index = await harness.control.query(harness.authentication, { type: 'project-index' }, new AbortController().signal)
    expect(index).toMatchObject({
      ok: true,
      projection: { projects: [{
        id: registered.receipt.projectId,
        binding: { health: 'missing', automaticMutationEligible: false, configurationGaps: ['binding-missing'] },
      }] },
    })
    expect(await harness.control.query(harness.authentication, {
      type: 'development-workspace',
      projectId: registered.receipt.projectId,
      expectedRegistryRevision: index.ok && index.projection.type === 'project-index'
        ? index.projection.revision
        : -1,
    }, new AbortController().signal)).toMatchObject({
      ok: true,
      projection: {
        recovery: { state: 'blocked', reasons: ['binding-missing'] },
      },
    })
    const firstMissingRevision = index.ok && index.projection.type === 'project-index'
      ? index.projection.revision
      : -1
    await harness.close()

    missing = await restartMissing()
    harness = missing.harness
    expect(missing.inspect.mock.calls.every(([input]) => input.directoryLocator === canonicalRepo)).toBe(true)
    expect(await harness.control.query(
      harness.authentication,
      { type: 'project-index' },
      new AbortController().signal,
    )).toMatchObject({ ok: true, projection: { revision: firstMissingRevision } })
    await harness.close()
  })

  it('requires repair when Git administration is rebuilt at the registered path', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'replacement-clone')
    let harness = await start(durable)
    const request = intent(
      'intent-57575757-5757-4757-8757-575757575757',
      'Replacement clone',
      repo,
      0,
      await inspected(harness, repo),
    )
    const registered = await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )
    if (!registered.ok) throw new Error('registration failed')
    const retained = liveSakiDomain(harness.ctx).table('development_project_registry')
      .get('development-project-registry')?.resourceBindings[0]?.registrationInspection.trusted
    if (retained === undefined) throw new Error('registration identity fixture is absent')
    await harness.close()

    await rename(join(repo, '.git'), join(durable.root, 'replacement-prior-git'))
    await run('git', ['init'], { cwd: repo, windowsHide: true })
    await run('git', ['config', 'user.name', 'Saki Test'], { cwd: repo, windowsHide: true })
    await run('git', ['config', 'user.email', 'saki@example.invalid'], { cwd: repo, windowsHide: true })
    await run('git', ['add', 'tracked.txt'], { cwd: repo, windowsHide: true })
    await run('git', ['commit', '-m', 'replacement'], { cwd: repo, windowsHide: true })

    harness = await start(durable)
    const registry = liveSakiDomain(harness.ctx).table('development_project_registry')
      .get('development-project-registry')
    const binding = registry?.resourceBindings[0]
    expect(binding).toMatchObject({
      id: registered.receipt.resourceBindingId,
      health: 'repair-required',
    })
    expect(binding?.currentInspection).toBeUndefined()
    const fresh = await harness.ctx.sakiHostExecution.inspectProjectSelection({
      hostId: harness.control.identity().hostId,
      directoryLocator: repo,
    }, new AbortController().signal)
    if (!fresh.ok) throw new Error('replacement clone inspection failed')
    expect(fresh.inspection.trusted.canonicalWorktreePath).toBe(retained.canonicalWorktreePath)
    expect(fresh.inspection.trusted.canonicalGitDirectory).toBe(retained.canonicalGitDirectory)
    expect(fresh.inspection.trusted.gitDirectoryIdentity).not.toEqual(retained.gitDirectoryIdentity)
    expect(await harness.control.query(
      harness.authentication,
      { type: 'project-index' },
      new AbortController().signal,
    )).toMatchObject({
      ok: true,
      projection: { projects: [{ binding: {
        health: 'repair-required',
        automaticMutationEligible: false,
        configurationGaps: ['binding-repair-required'],
      } }] },
    })
    await harness.close()
  })

  it('projects repair, dirty, ambiguous, and locked recovery evidence', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'projection-recovery')
    let harness = await start(durable)
    const request = intent(
      'intent-19191919-1919-4919-8919-191919191919',
      'Projection recovery',
      repo,
      0,
      await inspected(harness, repo),
    )
    const registered = await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )
    if (!registered.ok) throw new Error('registration failed')
    const workspaceId = harness.ctx.workspaceRegistry.list()[0]?.id
    if (workspaceId === undefined) throw new Error('Workspace fixture is absent')
    expect(await harness.ctx.workspaceRegistry.delete(workspaceId)).toBe(true)
    await harness.close()

    harness = await start(durable)
    const repairedIndex = await harness.control.query(
      harness.authentication,
      { type: 'project-index' },
      new AbortController().signal,
    )
    expect(repairedIndex).toMatchObject({
      ok: true,
      projection: { projects: [{ binding: {
        health: 'repair-required',
        configurationGaps: ['binding-repair-required'],
      } }] },
    })
    const repairRevision = repairedIndex.ok && repairedIndex.projection.type === 'project-index'
      ? repairedIndex.projection.revision
      : -1
    expect(await harness.control.query(harness.authentication, {
      type: 'development-workspace',
      projectId: registered.receipt.projectId,
      expectedRegistryRevision: repairRevision,
    }, new AbortController().signal)).toMatchObject({
      ok: true,
      projection: {
        recovery: { state: 'blocked', reasons: ['binding-repair-required'] },
      },
    })

    const registryTable = liveSakiDomain(harness.ctx).table('development_project_registry')
    await registryTable.update('development-project-registry', (registry) => {
      const binding = registry.resourceBindings[0]
      if (binding === undefined) throw new Error('Binding fixture is absent')
      const current = binding.registrationInspection
      const {
        fingerprint: _fingerprint,
        branch: _branch,
        upstream: _upstream,
        ...projection
      } = current.projection
      const baseline = SAKI_PROJECT_PROJECTION_FIXTURES.dirtySelection.baseline
      binding.health = 'active'
      binding.currentInspection = signedInspection({
        ...projection,
        workspaceId,
        detached: true,
        locked: true,
        inheritedChangeEntryCount: baseline.observed.entries,
        conversionAmbiguous: true,
        automaticMutationEligible: false,
        blockingReasons: ['dirty', 'conversion-ambiguous', 'locked'],
        baseline,
      }, current.trusted)
      registry.revision += 1
      binding.revision += 1
      return registry
    })
    const blockedIndex = await harness.control.query(
      harness.authentication,
      { type: 'project-index' },
      new AbortController().signal,
    )
    expect(blockedIndex).toMatchObject({
      ok: true,
      projection: { projects: [{ binding: {
        health: 'active',
        detached: true,
        automaticMutationEligible: false,
        configurationGaps: ['conversion-ambiguous'],
      } }] },
    })
    if (!blockedIndex.ok || blockedIndex.projection.type !== 'project-index') {
      throw new Error('Project index fixture failed')
    }
    expect(blockedIndex.projection.projects[0]?.binding).not.toHaveProperty('branch')
    expect(await harness.control.query(harness.authentication, {
      type: 'development-workspace',
      projectId: registered.receipt.projectId,
      expectedRegistryRevision: blockedIndex.projection.revision,
    }, new AbortController().signal)).toMatchObject({
      ok: true,
      projection: {
        recovery: {
          state: 'blocked',
          reasons: ['conversion-ambiguous', 'dirty', 'locked'],
        },
      },
    })
    await harness.close()
  })

  it('serializes exact replays by Intent id and performs the Workspace effect once', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'single-flight')
    const harness = await start(durable)
    const selection = await inspected(harness, repo)
    const request = intent(
      'intent-66666666-6666-4666-8666-666666666666',
      'Single flight',
      repo,
      0,
      selection,
    )
    const create = vi.spyOn(harness.ctx.workspaceRegistry, 'create')

    const [left, right] = await Promise.all([
      harness.control.submit(harness.authentication, request, new AbortController().signal),
      harness.control.submit(harness.authentication, request, new AbortController().signal),
    ])

    expect(left).toEqual(right)
    expect(left).toMatchObject({ ok: true, receipt: { state: 'confirmed', registryRevision: 1 } })
    expect(create).toHaveBeenCalledTimes(1)
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(1)
    await harness.close()
  })

  it('recovers a Workspace durable before its identity is retained by the Intent', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'create-recovery')
    let harness = await start(durable)
    const selection = await inspected(harness, repo)
    const request = intent(
      'intent-77777777-7777-4777-8777-777777777777',
      'Create recovery',
      repo,
      0,
      selection,
    )
    const originalCreate = harness.ctx.workspaceRegistry.create.bind(harness.ctx.workspaceRegistry)
    const create = vi.spyOn(harness.ctx.workspaceRegistry, 'create')
      .mockImplementationOnce(async (path, title) => {
        await originalCreate(path, title)
        throw new Error('durable Workspace survived an unknown create outcome')
      })

    const first = await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )
    expect(first).toMatchObject({ ok: false, reason: 'unavailable', receipt: { state: 'prepared' } })
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(1)
    await harness.close()

    harness = await start(durable)
    const replay = await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )
    expect(replay).toMatchObject({ ok: true, receipt: { state: 'confirmed', registryRevision: 1 } })
    expect(create).toHaveBeenCalledTimes(1)
    await harness.close()
  })

  it('recovers after the prepared Intent is durable but its first response is lost', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'prepared-cut')
    let harness = await start(durable)
    const request = intent(
      'intent-73737373-7373-4373-8373-737373737373',
      'Prepared cut',
      repo,
      0,
      await inspected(harness, repo),
    )
    const intents = liveSakiDomain(harness.ctx).table('registration_intents')
    const put = intents.put.bind(intents)
    vi.spyOn(intents, 'put').mockImplementationOnce(async (key, value) => {
      await put(key, value)
      throw new Error('simulated response loss after prepared Intent')
    })

    await expect(harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).rejects.toThrow('simulated response loss')
    expect(intents.get(request.intentId)).toMatchObject({ phase: 'prepared' })
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(0)
    await harness.close()

    harness = await start(durable)
    const recovered = await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )
    expect(recovered).toMatchObject({ ok: true, receipt: { state: 'confirmed' } })
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(1)
    await harness.close()
  })

  it('recovers after dispatch is durable before the first Workspace effect', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'dispatch-cut')
    let harness = await start(durable)
    const request = intent(
      'intent-74747474-7474-4474-8474-747474747474',
      'Dispatch cut',
      repo,
      0,
      await inspected(harness, repo),
    )
    const originalInspect = harness.ctx.sakiHostExecution.inspectProjectSelection
      .bind(harness.ctx.sakiHostExecution)
    let inspections = 0
    vi.spyOn(harness.ctx.sakiHostExecution, 'inspectProjectSelection')
      .mockImplementation(async (input, signal) => {
        inspections += 1
        if (inspections === 2) {
          expect(liveSakiDomain(harness.ctx).table('registration_intents').get(request.intentId))
            .toMatchObject({ phase: 'workspace-dispatching' })
          throw new Error('simulated crash after dispatch')
        }
        return await originalInspect(input, signal)
      })

    await expect(harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).rejects.toThrow('simulated crash after dispatch')
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(0)
    await harness.close()

    harness = await start(durable)
    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toMatchObject({ ok: true, receipt: { state: 'confirmed' } })
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(1)
    await harness.close()
  })

  it('recovers through the retained canonical locator after the submitted alias disappears', async () => {
    const durable = await paths()
    const repo = join(durable.root, 'alias-disappears-repository')
    await mkdir(repo)
    const canonicalRepo = await realpath(repo)
    const alias = join(durable.root, 'alias-disappears-selection')
    let harness = await start(durable)
    const inspection = fixtureInspection(harness.control.identity().hostId, canonicalRepo, '4')
    const request = intent(
      'intent-74707070-7470-4470-8470-747070707470',
      'Alias disappears',
      alias,
      0,
      inspection.projection,
    )
    let inspections = 0
    vi.spyOn(harness.ctx.sakiHostExecution, 'inspectProjectSelection')
      .mockImplementation(async () => {
        inspections += 1
        if (inspections === 2) return { ok: false, reason: 'unavailable' }
        return { ok: true, inspection }
      })
    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toMatchObject({ ok: false, reason: 'unavailable', receipt: { state: 'prepared' } })
    expect(liveSakiDomain(harness.ctx).table('registration_intents').get(request.intentId))
      .toMatchObject({ phase: 'workspace-dispatching' })
    await harness.close()

    const restarted = await context(durable)
    const inspect = vi.spyOn(restarted.sakiHostExecution, 'inspectProjectSelection')
      .mockImplementation(async (input) => {
        if (input.directoryLocator === canonicalRepo) return { ok: true, inspection: fixtureInspection(
          inspection.projection.hostId,
          canonicalRepo,
          '4',
          restarted.workspaceRegistry.list().find(workspace => workspace.path === canonicalRepo)?.id,
        ) }
        if (input.directoryLocator === alias) return { ok: false, reason: 'missing' }
        return { ok: false, reason: 'unavailable' }
      })
    harness = await mountControlPlane(restarted)
    expect(inspect).toHaveBeenCalled()
    expect(inspect.mock.calls.every(([input]) => input.directoryLocator === canonicalRepo)).toBe(true)
    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toMatchObject({ ok: true, receipt: { state: 'confirmed' } })
    expect(harness.ctx.workspaceRegistry.list()).toEqual([
      expect.objectContaining({ path: canonicalRepo }),
    ])
    await harness.close()
  })

  it('recovers the original repository after the submitted alias points elsewhere', async () => {
    const durable = await paths()
    const repo = join(durable.root, 'alias-retarget-original')
    const unrelated = join(durable.root, 'alias-retarget-unrelated')
    await Promise.all([mkdir(repo), mkdir(unrelated)])
    const alias = join(durable.root, 'alias-retarget-selection')
    const canonicalRepo = await realpath(repo)
    const canonicalUnrelated = await realpath(unrelated)
    const harness = await start(durable)
    const inspection = fixtureInspection(harness.control.identity().hostId, canonicalRepo, '5')
    const unrelatedInspection = fixtureInspection(harness.control.identity().hostId, canonicalUnrelated, '6')
    const request = intent(
      'intent-74717171-7471-4471-8471-747171717471',
      'Alias retarget',
      alias,
      0,
      inspection.projection,
    )
    let inspections = 0
    vi.spyOn(harness.ctx.sakiHostExecution, 'inspectProjectSelection')
      .mockImplementation(async () => {
        inspections += 1
        if (inspections === 2) return { ok: false, reason: 'unavailable' }
        return { ok: true, inspection }
      })
    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toMatchObject({ ok: false, reason: 'unavailable', receipt: { state: 'prepared' } })
    await harness.close()

    const restarted = await context(durable)
    const inspect = vi.spyOn(restarted.sakiHostExecution, 'inspectProjectSelection')
      .mockImplementation(async (input) => {
        if (input.directoryLocator === canonicalRepo) return { ok: true, inspection: fixtureInspection(
          inspection.projection.hostId,
          canonicalRepo,
          '5',
          restarted.workspaceRegistry.list().find(workspace => workspace.path === canonicalRepo)?.id,
        ) }
        if (input.directoryLocator === alias) return { ok: true, inspection: unrelatedInspection }
        return { ok: false, reason: 'unavailable' }
      })
    const create = vi.spyOn(restarted.workspaceRegistry, 'create')
    const controlFiber = await restarted.plugin(SakiControlPlane, CONTROL_CONFIG)
    try {
      expect(inspect).toHaveBeenCalled()
      expect(inspect.mock.calls.every(([input]) => input.directoryLocator === canonicalRepo)).toBe(true)
      expect(create).toHaveBeenCalledWith(canonicalRepo, 'Alias retarget')
      expect(restarted.workspaceRegistry.list()).toEqual([
        expect.objectContaining({ path: canonicalRepo }),
      ])
      const domain = liveSakiDomain(restarted)
      expect(domain.table('registration_intents').get(request.intentId)).toMatchObject({ phase: 'confirmed' })
      expect(domain.table('development_project_registry').get('development-project-registry'))
        .toMatchObject({ resourceBindings: [{ registrationInspection: {
          trusted: { canonicalWorktreePath: canonicalRepo },
        } }] })
    } finally {
      await controlFiber.dispose()
      await restarted.fiber.dispose()
    }
  })

  it('revalidates a registered Binding independently of later alias drift', async () => {
    const durable = await paths()
    const repo = join(durable.root, 'alias-revalidation-original')
    const unrelated = join(durable.root, 'alias-revalidation-unrelated')
    await Promise.all([mkdir(repo), mkdir(unrelated)])
    const alias = join(durable.root, 'alias-revalidation-selection')
    const canonicalRepo = await realpath(repo)
    const canonicalUnrelated = await realpath(unrelated)
    const harness = await start(durable)
    const inspection = fixtureInspection(harness.control.identity().hostId, canonicalRepo, '7')
    const unrelatedInspection = fixtureInspection(harness.control.identity().hostId, canonicalUnrelated, '8')
    const request = intent(
      'intent-74727272-7472-4472-8472-747272727472',
      'Alias revalidation',
      alias,
      0,
      inspection.projection,
    )
    vi.spyOn(harness.ctx.sakiHostExecution, 'inspectProjectSelection')
      .mockImplementation(async () => ({
        ok: true,
        inspection: fixtureInspection(
          inspection.projection.hostId,
          canonicalRepo,
          '7',
          harness.ctx.workspaceRegistry.list().find(workspace => workspace.path === canonicalRepo)?.id,
        ),
      }))
    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toMatchObject({ ok: true, receipt: { state: 'confirmed' } })
    await harness.close()

    const restarted = await context(durable)
    const inspect = vi.spyOn(restarted.sakiHostExecution, 'inspectProjectSelection')
      .mockImplementation(async (input) => {
        if (input.directoryLocator === canonicalRepo) return { ok: true, inspection: fixtureInspection(
          inspection.projection.hostId,
          canonicalRepo,
          '7',
          restarted.workspaceRegistry.list().find(workspace => workspace.path === canonicalRepo)?.id,
        ) }
        if (input.directoryLocator === alias) return { ok: true, inspection: unrelatedInspection }
        return { ok: false, reason: 'unavailable' }
      })
    const controlFiber = await restarted.plugin(SakiControlPlane, CONTROL_CONFIG)
    try {
      expect(inspect).toHaveBeenCalled()
      expect(inspect.mock.calls.every(([input]) => input.directoryLocator === canonicalRepo)).toBe(true)
      expect(liveSakiDomain(restarted).table('development_project_registry')
        .get('development-project-registry')).toMatchObject({
        resourceBindings: [{
          health: 'active',
          registrationInspection: { trusted: { canonicalWorktreePath: canonicalRepo } },
          currentInspection: { trusted: { canonicalWorktreePath: canonicalRepo } },
        }],
      })
    } finally {
      await controlFiber.dispose()
      await restarted.fiber.dispose()
    }
  })

  it('recovers after Workspace observation is durable before the Registry commit', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'workspace-observed-cut')
    let harness = await start(durable)
    const request = intent(
      'intent-75757575-7575-4575-8575-757575757575',
      'Workspace observed cut',
      repo,
      0,
      await inspected(harness, repo),
    )
    const registry = liveSakiDomain(harness.ctx).table('development_project_registry')
    vi.spyOn(registry, 'update').mockImplementationOnce(async () => {
      expect(liveSakiDomain(harness.ctx).table('registration_intents').get(request.intentId))
        .toMatchObject({ phase: 'workspace-observed' })
      throw new Error('simulated crash before Registry commit')
    })

    await expect(harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).rejects.toThrow('simulated crash before Registry commit')
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(1)
    expect(registry.get('development-project-registry')?.projects).toHaveLength(0)
    await harness.close()

    harness = await start(durable)
    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toMatchObject({ ok: true, receipt: { state: 'confirmed', registryRevision: 1 } })
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(1)
    await harness.close()
  })

  it('recovers a Registry CAS that commits before the Intent phase advances', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'registry-cas-cut')
    let harness = await start(durable)
    const request = intent(
      'intent-76767676-7676-4676-8676-767676767676',
      'Registry CAS cut',
      repo,
      0,
      await inspected(harness, repo),
    )
    const registry = liveSakiDomain(harness.ctx).table('development_project_registry')
    const update = registry.update.bind(registry)
    vi.spyOn(registry, 'update').mockImplementationOnce(async (key, transform) => {
      await update(key, transform)
      throw new Error('simulated response loss after Registry CAS')
    })

    await expect(harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).rejects.toThrow('simulated response loss after Registry CAS')
    expect(registry.get('development-project-registry')).toMatchObject({
      revision: 1,
      projects: [{ projectTitle: 'Registry CAS cut' }],
      intentMappings: [{ intentId: request.intentId }],
    })
    expect(liveSakiDomain(harness.ctx).table('registration_intents').get(request.intentId))
      .toMatchObject({ phase: 'workspace-observed' })
    await harness.close()

    harness = await start(durable)
    const recovered = await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )
    expect(recovered).toMatchObject({ ok: true, receipt: { state: 'confirmed', registryRevision: 1 } })
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(1)
    await harness.close()
  })

  it('replays a confirmed Intent after confirmation commits before its response', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'confirmation-cut')
    let harness = await start(durable)
    const request = intent(
      'intent-76707070-7670-4670-8670-767070707670',
      'Confirmation cut',
      repo,
      0,
      await inspected(harness, repo),
    )
    const intents = liveSakiDomain(harness.ctx).table('registration_intents')
    const update = intents.update.bind(intents)
    vi.spyOn(intents, 'update').mockImplementation(async (key, transform) => {
      let confirmationCommitted = false
      const next = await update(key, (current) => {
        const transformed = transform(current)
        confirmationCommitted = current.phase === 'registry-committed'
          && transformed.phase === 'confirmed'
        return transformed
      })
      if (confirmationCommitted) throw new Error('simulated response loss after confirmation')
      return next
    })

    await expect(harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).rejects.toThrow('simulated response loss after confirmation')
    const confirmed = intents.get(request.intentId)
    expect(confirmed).toMatchObject({ phase: 'confirmed', registryRevision: 1 })
    await harness.close()

    harness = await start(durable)
    const replay = await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )
    expect(replay).toEqual({
      ok: true,
      receipt: {
        id: confirmed?.receiptId,
        intentId: request.intentId,
        state: 'confirmed',
        projectId: confirmed?.projectId,
        resourceBindingId: confirmed?.resourceBindingId,
        registryRevision: 1,
      },
    })
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(1)
    await harness.close()
  })

  it('never treats a re-signed retained canonical locator as sufficient authority', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'trusted-original')
    const substituted = await repository(durable.root, 'trusted-substituted')
    const requestId = 'intent-77707070-7770-4770-8770-777070707770' as SakiControlIntentId
    const harness = await start(durable)
    const request = intent(requestId, 'Trusted path substitution', repo, 0, await inspected(harness, repo))
    const originalInspect = harness.ctx.sakiHostExecution.inspectProjectSelection
      .bind(harness.ctx.sakiHostExecution)
    let inspections = 0
    vi.spyOn(harness.ctx.sakiHostExecution, 'inspectProjectSelection')
      .mockImplementation(async (input, signal) => {
        inspections += 1
        if (inspections === 2) return { ok: false, reason: 'unavailable' }
        return await originalInspect(input, signal)
      })
    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toMatchObject({ ok: false, reason: 'unavailable' })
    await harness.close()

    const substitutedPath = await realpath(substituted)
    await editSaki(durable, async (domain) => {
      await domain.table('registration_intents').update(requestId, (current) => {
        const trusted = {
          ...current.inspection.trusted,
          canonicalWorktreePath: substitutedPath,
        }
        const { fingerprint: _fingerprint, ...projectionMaterial } = current.inspection.projection
        const fingerprint = computeProjectInspectionFingerprint(projectionMaterial, trusted)
        const inspection = {
          trusted,
          projection: { ...projectionMaterial, fingerprint },
        }
        const payload = {
          ...current.payload,
          intent: { ...current.payload.intent, confirmedFingerprint: fingerprint },
        }
        return registrationIntentRecordSchema.parse({
          ...current,
          revision: current.revision + 1,
          inspection,
          payload,
          payloadDigest: canonicalDigest('saki/register-development-project/v1', payload),
          updatedAt: current.updatedAt + 1,
        })
      })
    })

    const restarted = await context(durable)
    const inspect = vi.spyOn(restarted.sakiHostExecution, 'inspectProjectSelection')
    const create = vi.spyOn(restarted.workspaceRegistry, 'create')
    const controlFiber = await restarted.plugin(SakiControlPlane, CONTROL_CONFIG)
    try {
      expect(inspect).toHaveBeenCalled()
      expect(inspect.mock.calls.every(([input]) => input.directoryLocator === substitutedPath)).toBe(true)
      expect(create).not.toHaveBeenCalled()
      expect(liveSakiDomain(restarted).table('registration_intents').get(requestId)).toMatchObject({
        phase: 'reconciliation-required',
        terminalReason: 'observation',
      })
    } finally {
      await controlFiber.dispose()
      await restarted.fiber.dispose()
    }
  })

  it('returns an unavailable result without preparing an Intent when the acceptance inspection is unavailable', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'acceptance-unavailable')
    const harness = await start(durable)
    const selection = await inspected(harness, repo)
    const request = intent(
      'intent-70707070-7070-4070-8070-707070707070',
      'Acceptance unavailable',
      repo,
      0,
      selection,
    )
    vi.spyOn(harness.ctx.sakiHostExecution, 'inspectProjectSelection')
      .mockResolvedValueOnce({ ok: false, reason: 'unavailable' })

    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toEqual({ ok: false, reason: 'unavailable' })
    expect(liveSakiDomain(harness.ctx).table('registration_intents').size).toBe(0)
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(0)
    await harness.close()
  })

  it('retains a dispatching Intent when the pre-effect inspection is unavailable and resumes it', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'dispatch-unavailable')
    const harness = await start(durable)
    const selection = await inspected(harness, repo)
    const request = intent(
      'intent-71717171-7171-4171-8171-717171717171',
      'Dispatch unavailable',
      repo,
      0,
      selection,
    )
    const originalInspect = harness.ctx.sakiHostExecution.inspectProjectSelection
      .bind(harness.ctx.sakiHostExecution)
    let inspections = 0
    vi.spyOn(harness.ctx.sakiHostExecution, 'inspectProjectSelection')
      .mockImplementation(async (input, signal) => {
        inspections += 1
        if (inspections === 2) return { ok: false, reason: 'unavailable' }
        return await originalInspect(input, signal)
      })

    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toMatchObject({ ok: false, reason: 'unavailable', receipt: { state: 'prepared' } })
    expect(liveSakiDomain(harness.ctx).table('registration_intents').get(request.intentId))
      .toMatchObject({ phase: 'workspace-dispatching' })
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(0)

    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toMatchObject({ ok: true, receipt: { state: 'confirmed' } })
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(1)
    await harness.close()
  })

  it('retains a Workspace-observed Intent when reinspection is unavailable and resumes it', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'observed-unavailable')
    const harness = await start(durable)
    const selection = await inspected(harness, repo)
    const request = intent(
      'intent-72727272-7272-4272-8272-727272727272',
      'Observed unavailable',
      repo,
      0,
      selection,
    )
    const originalInspect = harness.ctx.sakiHostExecution.inspectProjectSelection
      .bind(harness.ctx.sakiHostExecution)
    let inspections = 0
    vi.spyOn(harness.ctx.sakiHostExecution, 'inspectProjectSelection')
      .mockImplementation(async (input, signal) => {
        inspections += 1
        if (inspections === 3) return { ok: false, reason: 'unavailable' }
        return await originalInspect(input, signal)
      })
    const create = vi.spyOn(harness.ctx.workspaceRegistry, 'create')

    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toMatchObject({ ok: false, reason: 'unavailable', receipt: { state: 'prepared' } })
    expect(liveSakiDomain(harness.ctx).table('registration_intents').get(request.intentId))
      .toMatchObject({ phase: 'workspace-observed' })
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(1)

    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toMatchObject({ ok: true, receipt: { state: 'confirmed' } })
    expect(create).toHaveBeenCalledTimes(1)
    await harness.close()
  })

  it('preserves non-whitespace Project titles exactly and rejects whitespace-only content', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'title')
    const harness = await start(durable)
    const selection = await inspected(harness, repo)
    const exactTitle = '  👩‍💻  '
    const request = intent(
      'intent-88888888-8888-4888-8888-888888888888',
      exactTitle,
      repo,
      0,
      selection,
    )
    const result = await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )
    expect(result.ok).toBe(true)
    expect(harness.ctx.workspaceRegistry.list()[0]?.title).toBe(exactTitle)
    const index = await harness.control.query(
      harness.authentication,
      { type: 'project-index' },
      new AbortController().signal,
    )
    expect(index.ok && index.projection.type === 'project-index'
      ? index.projection.projects[0]?.projectTitle
      : undefined).toBe(exactTitle)
    await expect(harness.control.submit(harness.authentication, {
      ...request,
      intentId: 'intent-99999999-9999-4999-8999-999999999999' as SakiControlIntentId,
      projectTitle: ' \t\n ',
      expectedRegistryRevision: 1,
    }, new AbortController().signal)).rejects.toThrow()
    await harness.close()
  })

  it('validates every Intent and known Actor generation before recovering the first nonterminal Intent', async () => {
    const durable = await paths()
    const firstRepo = await repository(durable.root, 'first-recovery')
    const secondRepo = await repository(durable.root, 'later-corrupt')
    const firstId = 'intent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as SakiControlIntentId
    const secondId = 'intent-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as SakiControlIntentId
    const harness = await start(durable)
    const firstSelection = await inspected(harness, firstRepo)
    expect((await harness.control.submit(
      harness.authentication,
      intent(firstId, 'First recovery', firstRepo, 0, firstSelection),
      new AbortController().signal,
    )).ok).toBe(true)
    const secondSelection = await inspected(harness, secondRepo)
    expect((await harness.control.submit(
      harness.authentication,
      intent(secondId, 'Later corrupt', secondRepo, 1, secondSelection),
      new AbortController().signal,
    )).ok).toBe(true)
    await harness.close()

    await editSaki(durable, async (domain) => {
      await domain.table('registration_intents').update(firstId, (current) => {
        const {
          projectId: _projectId,
          resourceBindingId: _resourceBindingId,
          registryRevision: _registryRevision,
          ...withoutCommit
        } = current
        return registrationIntentRecordSchema.parse({
          ...withoutCommit,
          revision: current.revision + 1,
          phase: 'workspace-observed',
          updatedAt: current.updatedAt + 1,
        })
      })
      await domain.table('registration_intents').update(secondId, (current) => {
        const payload = {
          ...current.payload,
          actor: {
            ...current.payload.actor,
            installationGenerationId:
              'installation-generation-abababab-abab-4bab-8bab-abababababab' as SakiInstallationGenerationId,
          },
        }
        return registrationIntentRecordSchema.parse({
          ...current,
          revision: current.revision + 1,
          payload,
          payloadDigest: canonicalDigest('saki/register-development-project/v1', payload),
          updatedAt: current.updatedAt + 1,
        })
      })
    })
    let before: unknown
    await editSaki(durable, async (domain) => { before = durableState(domain) })

    const failed = await context(durable)
    const inspect = vi.spyOn(failed.sakiHostExecution, 'inspectProjectSelection')
    const list = vi.spyOn(failed.workspaceRegistry, 'list')
    const create = vi.spyOn(failed.workspaceRegistry, 'create')
    try {
      await expect(failed.plugin(SakiControlPlane, CONTROL_CONFIG))
        .rejects.toThrow('registration Intent actor reference is inconsistent')
      expect(inspect).not.toHaveBeenCalled()
      expect(list).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()
    } finally {
      await failed.fiber.dispose()
    }
    await editSaki(durable, async (domain) => { expect(durableState(domain)).toEqual(before) })
  })

  it('rejects each inconsistent Resource Binding relation at the durable schema', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'binding-schema-relations')
    const harness = await start(durable)
    const request = intent(
      'intent-b0b0b0b0-b0b0-40b0-80b0-b0b0b0b0b0b0',
      'Binding schema relations',
      repo,
      0,
      await inspected(harness, repo),
    )
    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toMatchObject({ ok: true })
    const binding = liveSakiDomain(harness.ctx).table('development_project_registry')
      .get('development-project-registry')?.resourceBindings[0]
    if (binding === undefined || binding.currentInspection === undefined) {
      throw new Error('registered Binding fixture is incomplete')
    }
    const otherHost = 'host-b0b0b0b0-b0b0-40b0-80b0-b0b0b0b0b0b1' as SakiHostId
    const otherWorkspace = WorkspaceId('workspace-other')
    const alternateBaseline = SAKI_PROJECT_PROJECTION_FIXTURES.dirtySelection.baseline
    const mutations: readonly [string, (candidate: ResourceBindingRecord) => void][] = [
      ['binding observation predates creation', (candidate) => { candidate.observedAt = candidate.createdAt - 1 }],
      ['binding inspection belongs to another Host', (candidate) => {
        const inspection = candidate.registrationInspection
        const { fingerprint: _fingerprint, ...projection } = inspection.projection
        candidate.registrationInspection = signedInspection({ ...projection, hostId: otherHost }, inspection.trusted)
      }],
      ['binding inspection belongs to another Host', (candidate) => {
        const inspection = candidate.currentInspection!
        const { fingerprint: _fingerprint, ...projection } = inspection.projection
        candidate.currentInspection = signedInspection({ ...projection, hostId: otherHost }, inspection.trusted)
      }],
      ['binding inherited baseline differs from registration evidence', (candidate) => {
        candidate.inheritedChangeBaseline = alternateBaseline
      }],
      ['active binding has no current inspection', (candidate) => { delete candidate.currentInspection }],
      ['missing binding retains a current inspection', (candidate) => { candidate.health = 'missing' }],
      ['binding current inspection disagrees with Workspace identity', (candidate) => {
        const inspection = candidate.currentInspection!
        const { fingerprint: _fingerprint, workspaceId: _workspaceId, ...projection } = inspection.projection
        candidate.currentInspection = signedInspection(projection, inspection.trusted)
      }],
      ['binding current inspection disagrees with Workspace identity', (candidate) => {
        const inspection = candidate.currentInspection!
        const { fingerprint: _fingerprint, ...projection } = inspection.projection
        candidate.currentInspection = signedInspection({ ...projection, workspaceId: otherWorkspace }, inspection.trusted)
      }],
      ['binding current inspection changed resource identity', (candidate) => {
        const inspection = candidate.currentInspection!
        const { fingerprint: _fingerprint, ...projection } = inspection.projection
        const trusted = { ...inspection.trusted, canonicalWorktreePath: join(durable.root, 'other-worktree') }
        candidate.currentInspection = signedInspection(projection, trusted)
      }],
      ['binding current inspection changed resource identity', (candidate) => {
        const inspection = candidate.currentInspection!
        const { fingerprint: _fingerprint, ...projection } = inspection.projection
        const trusted = { ...inspection.trusted, canonicalGitDirectory: join(durable.root, 'other-git-directory') }
        candidate.currentInspection = signedInspection(projection, trusted)
      }],
      ['binding current inspection changed resource identity', (candidate) => {
        const inspection = candidate.currentInspection!
        const { fingerprint: _fingerprint, ...projection } = inspection.projection
        const trusted = {
          ...inspection.trusted,
          gitDirectoryIdentity: { version: 1 as const, digest: 'e'.repeat(64) },
        }
        candidate.currentInspection = signedInspection(projection, trusted)
      }],
      ['binding current inspection changed resource identity', (candidate) => {
        const inspection = candidate.currentInspection!
        const { fingerprint: _fingerprint, ...projection } = inspection.projection
        const trusted = {
          ...inspection.trusted,
          commonGitDirectoryIdentity: { version: 1 as const, digest: 'f'.repeat(64) },
        }
        candidate.currentInspection = signedInspection(projection, trusted)
      }],
    ]
    for (const [message, mutate] of mutations) {
      const candidate = structuredClone(binding)
      mutate(candidate)
      const parsed = resourceBindingRecordSchema.safeParse(candidate)
      expect(parsed.success, message).toBe(false)
      if (!parsed.success) expect(parsed.error.issues.map(issue => issue.message)).toContain(message)
    }
    await harness.close()
  })

  it('rejects each inconsistent registration Intent relation at the durable schema', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'intent-schema-relations')
    const harness = await start(durable)
    const request = intent(
      'intent-b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1',
      'Intent schema relations',
      repo,
      0,
      await inspected(harness, repo),
    )
    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toMatchObject({ ok: true })
    const confirmed = liveSakiDomain(harness.ctx).table('registration_intents').get(request.intentId)
    if (confirmed === undefined || confirmed.workspaceId === undefined
      || confirmed.workspaceInspection === undefined) {
      throw new Error('confirmed Intent fixture is incomplete')
    }
    const otherHost = 'host-b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b2' as SakiHostId
    const otherWorkspace = WorkspaceId('workspace-other')
    const alternateBaseline = SAKI_PROJECT_PROJECTION_FIXTURES.dirtySelection.baseline
    const refreshPayloadDigest = (candidate: RegistrationIntentRecord): void => {
      candidate.payloadDigest = canonicalDigest('saki/register-development-project/v1', candidate.payload)
    }
    const mutations: readonly [string, (candidate: RegistrationIntentRecord) => void][] = [
      ['Intent update predates creation', (candidate) => { candidate.updatedAt = candidate.createdAt - 1 }],
      ['Intent terminal reason disagrees with phase', (candidate) => { candidate.terminalReason = 'authority' }],
      ['Intent terminal reason disagrees with phase', (candidate) => {
        candidate.phase = 'failure'
        delete candidate.terminalReason
        clearRegistrationCommit(candidate)
        clearRegistrationWorkspace(candidate)
      }],
      ['Intent id disagrees with immutable payload', (candidate) => {
        candidate.id = 'intent-b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b3' as SakiControlIntentId
      }],
      ['receipt id disagrees with Intent id', (candidate) => {
        candidate.receiptId = 'receipt-b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b3' as typeof candidate.receiptId
      }],
      ['registration actor belongs to another Host', (candidate) => {
        candidate.payload.actor.hostId = otherHost
        refreshPayloadDigest(candidate)
      }],
      ['Intent confirmation disagrees with retained inspection', (candidate) => {
        const inspection = candidate.inspection
        const { fingerprint: _fingerprint, ...projection } = inspection.projection
        candidate.inspection = signedInspection({ ...projection, hostId: otherHost }, inspection.trusted)
      }],
      ['Intent confirmation disagrees with retained inspection', (candidate) => {
        candidate.payload.intent.confirmedFingerprint = {
          version: 1,
          digest: canonicalDigest('saki/test/alternate-fingerprint/v1', { id: candidate.id }),
        }
        refreshPayloadDigest(candidate)
      }],
      ['Intent confirmation disagrees with retained inspection', (candidate) => {
        candidate.payload.intent.confirmedBaseline = alternateBaseline
        refreshPayloadDigest(candidate)
      }],
      ['Intent payload digest is stale', (candidate) => {
        candidate.payload.intent.projectTitle = 'Changed without refreshing the digest'
      }],
      ['Workspace inspection has no retained identity', (candidate) => {
        candidate.phase = 'workspace-dispatching'
        clearRegistrationCommit(candidate)
        delete candidate.workspaceId
      }],
      ['Workspace observation disagrees with retained identity', (candidate) => {
        const inspection = candidate.workspaceInspection!
        const { fingerprint: _fingerprint, ...projection } = inspection.projection
        candidate.workspaceInspection = signedInspection({ ...projection, hostId: otherHost }, inspection.trusted)
      }],
      ['Workspace observation disagrees with retained identity', (candidate) => {
        const inspection = candidate.workspaceInspection!
        const { fingerprint: _fingerprint, workspaceId: _workspaceId, ...projection } = inspection.projection
        candidate.workspaceInspection = signedInspection(projection, inspection.trusted)
      }],
      ['Workspace observation disagrees with retained identity', (candidate) => {
        const inspection = candidate.workspaceInspection!
        const { fingerprint: _fingerprint, ...projection } = inspection.projection
        candidate.workspaceInspection = signedInspection(
          { ...projection, workspaceId: otherWorkspace },
          inspection.trusted,
        )
      }],
      ['Existing Workspace identity changed during registration', (candidate) => {
        const inspection = candidate.inspection
        const { fingerprint: _fingerprint, ...projection } = inspection.projection
        candidate.inspection = signedInspection(
          { ...projection, workspaceId: otherWorkspace },
          inspection.trusted,
        )
        candidate.payload.intent.confirmedFingerprint = candidate.inspection.projection.fingerprint
        refreshPayloadDigest(candidate)
      }],
      ['Workspace observation changed repository evidence', (candidate) => {
        const inspection = candidate.workspaceInspection!
        const { fingerprint: _fingerprint, ...projection } = inspection.projection
        candidate.workspaceInspection = signedInspection(projection, {
          ...inspection.trusted,
          canonicalGitDirectory: join(durable.root, 'changed-git-directory'),
        })
      }],
      ['registry commit fields must appear together', (candidate) => { delete candidate.resourceBindingId }],
      ['early Intent phase contains later-phase evidence', (candidate) => { candidate.phase = 'prepared' }],
      ['workspace-observed phase evidence is incomplete', (candidate) => {
        candidate.phase = 'workspace-observed'
        clearRegistrationCommit(candidate)
        delete candidate.workspaceId
      }],
      ['workspace-observed phase evidence is incomplete', (candidate) => {
        candidate.phase = 'workspace-observed'
      }],
      ['committed Intent phase evidence is incomplete', (candidate) => { delete candidate.workspaceId }],
      ['committed Intent phase evidence is incomplete', (candidate) => { delete candidate.workspaceInspection }],
      ['terminal Intent contains registry commit evidence', (candidate) => {
        candidate.phase = 'conflict'
        candidate.terminalReason = 'expected-revision'
      }],
      ['Intent commit revision disagrees with expected revision', (candidate) => {
        candidate.registryRevision = candidate.payload.intent.expectedRegistryRevision + 2
      }],
      ['conflict phase has an invalid terminal reason', (candidate) => {
        candidate.phase = 'conflict'
        candidate.terminalReason = 'authority'
        clearRegistrationCommit(candidate)
      }],
      ['conflict phase has no Workspace evidence', (candidate) => {
        candidate.phase = 'conflict'
        candidate.terminalReason = 'expected-revision'
        clearRegistrationCommit(candidate)
        clearRegistrationWorkspace(candidate)
      }],
      ['failure phase has an invalid terminal reason', (candidate) => {
        candidate.phase = 'failure'
        candidate.terminalReason = 'workspace'
        clearRegistrationCommit(candidate)
        clearRegistrationWorkspace(candidate)
      }],
      ['authority failure contains Workspace evidence', (candidate) => {
        candidate.phase = 'failure'
        candidate.terminalReason = 'authority'
        clearRegistrationCommit(candidate)
      }],
      ['reconciliation phase has an invalid terminal reason', (candidate) => {
        candidate.phase = 'reconciliation-required'
        candidate.terminalReason = 'authority'
        clearRegistrationCommit(candidate)
        clearRegistrationWorkspace(candidate)
      }],
    ]
    for (const [message, mutate] of mutations) {
      const candidate = structuredClone(confirmed)
      mutate(candidate)
      const parsed = registrationIntentRecordSchema.safeParse(candidate)
      expect(parsed.success, message).toBe(false)
      if (!parsed.success) expect(parsed.error.issues.map(issue => issue.message)).toContain(message)
    }
    await harness.close()
  })

  it('rejects hostile Project Registry and Intent graph mutations before recovery or revalidation', async () => {
    const durable = await paths()
    const firstRepo = await repository(durable.root, 'registry-graph-first')
    const secondRepo = await repository(durable.root, 'registry-graph-second')
    const harness = await start(durable)
    const firstRequest = intent(
      'intent-b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2',
      'Registry graph first',
      firstRepo,
      0,
      await inspected(harness, firstRepo),
    )
    const secondRequest = intent(
      'intent-b3b3b3b3-b3b3-43b3-83b3-b3b3b3b3b3b3',
      'Registry graph second',
      secondRepo,
      1,
      await inspected(harness, secondRepo),
    )
    expect(await harness.control.submit(
      harness.authentication,
      firstRequest,
      new AbortController().signal,
    )).toMatchObject({ ok: true })
    expect(await harness.control.submit(
      harness.authentication,
      secondRequest,
      new AbortController().signal,
    )).toMatchObject({ ok: true })
    const registryTable = liveSakiDomain(harness.ctx).table('development_project_registry')
    const intentTable = liveSakiDomain(harness.ctx).table('registration_intents')
    const registry = registryTable.get('development-project-registry')
    if (registry === undefined || registry.projects.length !== 2
      || registry.resourceBindings.length !== 2 || registry.intentMappings.length !== 2) {
      throw new Error('two-Project Registry fixture is incomplete')
    }
    const firstIntent = intentTable.get(firstRequest.intentId)
    const secondIntent = intentTable.get(secondRequest.intentId)
    if (firstIntent === undefined || secondIntent === undefined) {
      throw new Error('two-Intent Registry fixture is incomplete')
    }
    const projects = new DevelopmentProjects({
      registryTable,
      intentTable,
      execution: harness.ctx.sakiHostExecution,
      workspaces: harness.ctx.workspaceRegistry,
      authorityCurrent: () => true,
      validateActorReference: () => {},
    })
    const missingProjectId = 'project-b4b4b4b4-b4b4-44b4-84b4-b4b4b4b4b4b4' as typeof registry.projects[number]['id']
    const missingBindingId = 'binding-b4b4b4b4-b4b4-44b4-84b4-b4b4b4b4b4b4' as typeof registry.resourceBindings[number]['id']
    const missingHostId = 'host-b4b4b4b4-b4b4-44b4-84b4-b4b4b4b4b4b4' as SakiHostId
    const mutations: readonly [string, (candidate: DevelopmentProjectRegistryRecord) => void][] = [
      ['Saki registry repeats Project identity', (candidate) => {
        candidate.projects.push(structuredClone(candidate.projects[0]!))
      }],
      ['Saki registry repeats Resource Binding identity', (candidate) => {
        candidate.resourceBindings.push(structuredClone(candidate.resourceBindings[0]!))
      }],
      ['Saki registry repeats Workspace identity', (candidate) => {
        const first = candidate.resourceBindings[0]!
        const second = candidate.resourceBindings[1]!
        second.workspaceId = first.workspaceId
        const inspection = second.currentInspection!
        const { fingerprint: _fingerprint, ...projection } = inspection.projection
        second.currentInspection = signedInspection(
          { ...projection, workspaceId: first.workspaceId },
          inspection.trusted,
        )
      }],
      ['Saki registry repeats Project-to-Binding reference identity', (candidate) => {
        candidate.projects[1]!.resourceBindingId = candidate.projects[0]!.resourceBindingId
      }],
      ['Saki registry repeats Binding-to-Project reference identity', (candidate) => {
        candidate.resourceBindings[1]!.projectId = candidate.resourceBindings[0]!.projectId
      }],
      ['Saki registry repeats canonical worktree identity', (candidate) => {
        candidate.canonicalWorktreeIndex[1]!.path = candidate.canonicalWorktreeIndex[0]!.path
      }],
      ['Saki registry repeats per-worktree Git directory identity', (candidate) => {
        candidate.gitDirectoryIndex[1]!.path = candidate.gitDirectoryIndex[0]!.path
      }],
      ['Saki registry repeats registration Intent mapping identity', (candidate) => {
        candidate.intentMappings[1]!.intentId = candidate.intentMappings[0]!.intentId
      }],
      ['Saki registry repeats mapped Project identity', (candidate) => {
        candidate.intentMappings[1]!.projectId = candidate.intentMappings[0]!.projectId
      }],
      ['Saki registry repeats mapped Resource Binding identity', (candidate) => {
        candidate.intentMappings[1]!.resourceBindingId = candidate.intentMappings[0]!.resourceBindingId
      }],
      ['Saki registry repeats mapping commit revision identity', (candidate) => {
        candidate.intentMappings[1]!.registryRevision = candidate.intentMappings[0]!.registryRevision
      }],
      ['Saki Project Registry child and index cardinalities disagree', (candidate) => {
        candidate.resourceBindings.pop()
      }],
      ['Saki Project Registry child and index cardinalities disagree', (candidate) => {
        candidate.canonicalWorktreeIndex.pop()
      }],
      ['Saki Project Registry child and index cardinalities disagree', (candidate) => {
        candidate.gitDirectoryIndex.pop()
      }],
      ['Saki Project Registry child and index cardinalities disagree', (candidate) => {
        candidate.intentMappings.pop()
      }],
      ['has an inconsistent Resource Binding', (candidate) => {
        candidate.projects[0]!.resourceBindingId = missingBindingId
      }],
      ['has an inconsistent Resource Binding', (candidate) => {
        const left = candidate.projects[0]!.resourceBindingId
        candidate.projects[0]!.resourceBindingId = candidate.projects[1]!.resourceBindingId
        candidate.projects[1]!.resourceBindingId = left
      }],
      ['has inconsistent path indices', (candidate) => {
        candidate.canonicalWorktreeIndex[0]!.path = join(durable.root, 'wrong-worktree')
      }],
      ['has inconsistent path indices', (candidate) => {
        candidate.gitDirectoryIndex[0]!.path = join(durable.root, 'wrong-git-directory')
      }],
      ['has inconsistent path indices', (candidate) => {
        candidate.canonicalWorktreeIndex[0]!.hostId = missingHostId
      }],
      ['has inconsistent path indices', (candidate) => {
        candidate.gitDirectoryIndex[0]!.hostId = missingHostId
      }],
      ['maps to inconsistent children', (candidate) => {
        candidate.intentMappings[0]!.projectId = missingProjectId
      }],
      ['maps to inconsistent children', (candidate) => {
        candidate.intentMappings[0]!.resourceBindingId = missingBindingId
      }],
      ['maps to inconsistent children', (candidate) => {
        const left = candidate.intentMappings[0]!.resourceBindingId
        candidate.intentMappings[0]!.resourceBindingId = candidate.intentMappings[1]!.resourceBindingId
        candidate.intentMappings[1]!.resourceBindingId = left
      }],
      ['maps to inconsistent children', (candidate) => {
        candidate.intentMappings[0]!.registryRevision = candidate.revision + 1
      }],
    ]
    for (const [message, mutate] of mutations) {
      const candidate = structuredClone(registry)
      mutate(candidate)
      await registryTable.put('development-project-registry', candidate)
      expect(() => projects.validateDurableState(), message).toThrow(message)
    }
    const otherHost = 'host-b4b4b4b4-b4b4-44b4-84b4-b4b4b4b4b4b5' as SakiHostId
    const otherWorkspace = WorkspaceId('workspace-registry-graph-other')
    const crossMutations: readonly [
      string,
      (
        candidateRegistry: DevelopmentProjectRegistryRecord,
        candidateIntents: RegistrationIntentRecord[],
      ) => void,
    ][] = [
      ['has no Intent', (_candidateRegistry, candidateIntents) => { candidateIntents.shift() }],
      ['must not retain a mapping', (_candidateRegistry, candidateIntents) => {
        const candidate = candidateIntents[0]!
        candidate.phase = 'conflict'
        candidate.terminalReason = 'expected-revision'
        clearRegistrationCommit(candidate)
      }],
      ['maps before its Workspace observation', (_candidateRegistry, candidateIntents) => {
        const candidate = candidateIntents[0]!
        candidate.phase = 'workspace-dispatching'
        clearRegistrationCommit(candidate)
        clearRegistrationWorkspace(candidate)
      }],
      ['has an invalid commit revision', (candidateRegistry) => {
        candidateRegistry.intentMappings[0]!.registryRevision = 0
      }],
      ['disagrees with its committed children', (candidateRegistry) => {
        candidateRegistry.projects[0]!.projectTitle = 'Hostile title replacement'
      }],
      ['disagrees with its committed children', (candidateRegistry) => {
        candidateRegistry.projects[0]!.revision += 1
      }],
      ['disagrees with its committed children', (candidateRegistry) => {
        const binding = candidateRegistry.resourceBindings[0]!
        binding.hostId = otherHost
        const registration = binding.registrationInspection
        const { fingerprint: _registrationFingerprint, ...registrationProjection } = registration.projection
        binding.registrationInspection = signedInspection(
          { ...registrationProjection, hostId: otherHost },
          registration.trusted,
        )
        const current = binding.currentInspection!
        const { fingerprint: _currentFingerprint, ...currentProjection } = current.projection
        binding.currentInspection = signedInspection(
          { ...currentProjection, hostId: otherHost },
          current.trusted,
        )
        candidateRegistry.canonicalWorktreeIndex.find(entry =>
          entry.resourceBindingId === binding.id)!.hostId = otherHost
        candidateRegistry.gitDirectoryIndex.find(entry =>
          entry.resourceBindingId === binding.id)!.hostId = otherHost
      }],
      ['disagrees with its committed children', (candidateRegistry) => {
        const binding = candidateRegistry.resourceBindings[0]!
        binding.workspaceId = otherWorkspace
        const current = binding.currentInspection!
        const { fingerprint: _fingerprint, ...projection } = current.projection
        binding.currentInspection = signedInspection(
          { ...projection, workspaceId: otherWorkspace },
          current.trusted,
        )
      }],
      ['disagrees with its committed children', (candidateRegistry) => {
        const binding = candidateRegistry.resourceBindings[0]!
        const registration = binding.registrationInspection
        const { fingerprint: _fingerprint, ...projection } = registration.projection
        binding.registrationInspection = signedInspection({
          ...projection,
          displayLocation: `${projection.displayLocation}-changed`,
        }, registration.trusted)
      }],
      ['disagrees with its committed children', (candidateRegistry) => {
        const binding = candidateRegistry.resourceBindings[0]!
        const baseline = binding.inheritedChangeBaseline
        if (baseline.kind !== 'complete') throw new Error('expected a complete registration baseline')
        binding.inheritedChangeBaseline = { ...baseline, capturedAt: baseline.capturedAt + 1 }
      }],
      ['has invalid initial binding evidence', (candidateRegistry, candidateIntents) => {
        candidateIntents[0]!.phase = 'registry-committed'
        candidateRegistry.resourceBindings[0]!.revision += 1
      }],
      ['has invalid initial binding evidence', (candidateRegistry, candidateIntents) => {
        candidateIntents[0]!.phase = 'registry-committed'
        const binding = candidateRegistry.resourceBindings[0]!
        binding.health = 'missing'
        delete binding.currentInspection
      }],
      ['has invalid initial binding evidence', (candidateRegistry, candidateIntents) => {
        candidateIntents[0]!.phase = 'registry-committed'
        const binding = candidateRegistry.resourceBindings[0]!
        const current = binding.currentInspection!
        const { fingerprint: _fingerprint, ...projection } = current.projection
        binding.currentInspection = signedInspection({
          ...projection,
          displayLocation: `${projection.displayLocation}-changed`,
        }, current.trusted)
      }],
      ['has invalid initial binding evidence', (_candidateRegistry, candidateIntents) => {
        const candidate = candidateIntents[0]!
        candidate.phase = 'workspace-observed'
        delete candidate.workspaceInspection
        clearRegistrationCommit(candidate)
      }],
      ['disagrees with its initial current inspection', (candidateRegistry) => {
        const binding = candidateRegistry.resourceBindings[0]!
        const current = binding.currentInspection!
        const { fingerprint: _fingerprint, ...projection } = current.projection
        binding.currentInspection = signedInspection({
          ...projection,
          displayLocation: `${projection.displayLocation}-changed`,
        }, current.trusted)
      }],
      ['has an unreachable binding revision', (candidateRegistry) => {
        candidateRegistry.resourceBindings[0]!.revision = candidateRegistry.revision
      }],
      ['disagrees with its commit mapping', (_candidateRegistry, candidateIntents) => {
        candidateIntents[0]!.projectId = missingProjectId
      }],
      ['disagrees with its commit mapping', (_candidateRegistry, candidateIntents) => {
        candidateIntents[0]!.resourceBindingId = missingBindingId
      }],
      ['has no mapping', (candidateRegistry) => {
        const mapping = candidateRegistry.intentMappings.shift()!
        candidateRegistry.projects = candidateRegistry.projects.filter(project => project.id !== mapping.projectId)
        candidateRegistry.resourceBindings = candidateRegistry.resourceBindings
          .filter(binding => binding.id !== mapping.resourceBindingId)
        candidateRegistry.canonicalWorktreeIndex = candidateRegistry.canonicalWorktreeIndex
          .filter(entry => entry.resourceBindingId !== mapping.resourceBindingId)
        candidateRegistry.gitDirectoryIndex = candidateRegistry.gitDirectoryIndex
          .filter(entry => entry.resourceBindingId !== mapping.resourceBindingId)
      }],
    ]
    for (const [message, mutate] of crossMutations) {
      const candidateRegistry = structuredClone(registry)
      const candidateIntents = structuredClone([firstIntent, secondIntent])
      mutate(candidateRegistry, candidateIntents)
      await registryTable.put('development-project-registry', candidateRegistry)
      for (const [intentId] of intentTable.entries()) await intentTable.delete(intentId)
      for (const candidate of candidateIntents) await intentTable.put(candidate.id, candidate)
      expect(() => projects.validateDurableState(), message).toThrow(message)
    }
    await registryTable.put('development-project-registry', registry)
    for (const [intentId] of intentTable.entries()) await intentTable.delete(intentId)
    await intentTable.put(firstIntent.id, firstIntent)
    await intentTable.put(secondIntent.id, secondIntent)
    const otherRegistryKey = 'other-development-project-registry' as 'development-project-registry'
    await registryTable.put(otherRegistryKey, registry)
    expect(() => projects.validateDurableState()).toThrow('invalid singleton key')
    await registryTable.delete('development-project-registry')
    expect(() => projects.validateDurableState()).toThrow('invalid singleton key')
    await registryTable.delete(otherRegistryKey)
    expect(() => projects.registry()).toThrow('Project Registry is absent')
    expect(() => projects.validateDurableState()).toThrow('Intents exist without the Project Registry')
    await registryTable.put('development-project-registry', registry)

    const otherIntentKey = 'intent-b5b5b5b5-b5b5-45b5-85b5-b5b5b5b5b5b5' as SakiControlIntentId
    await intentTable.delete(firstIntent.id)
    await intentTable.put(otherIntentKey, firstIntent)
    expect(() => projects.validateDurableState()).toThrow('Intent id disagrees with its table key')
    await intentTable.delete(otherIntentKey)
    const tiedFirst = {
      ...firstIntent,
      createdAt: secondIntent.createdAt,
      updatedAt: Math.max(firstIntent.updatedAt, secondIntent.createdAt),
    }
    const tiedSecond = { ...secondIntent, createdAt: secondIntent.createdAt }
    await intentTable.delete(secondIntent.id)
    await intentTable.put(tiedSecond.id, tiedSecond)
    await intentTable.put(tiedFirst.id, tiedFirst)
    expect(projects.validateDurableState().intents.map(candidate => candidate.id)).toEqual([
      firstIntent.id,
      secondIntent.id,
    ])
    await intentTable.put(firstIntent.id, firstIntent)
    await intentTable.put(secondIntent.id, secondIntent)

    const replayed = await projects.register(
      firstRequest,
      firstIntent.payload.actor,
      firstIntent.inspection,
      new AbortController().signal,
    )
    expect(replayed).toMatchObject({ ok: true, receipt: { intentId: firstRequest.intentId } })
    expect(await projects.register(
      { ...firstRequest, projectTitle: 'Changed replay content' },
      firstIntent.payload.actor,
      firstIntent.inspection,
      new AbortController().signal,
    )).toEqual({ ok: false, reason: 'conflict' })
    expect(projects.validateDurableState().registry).toEqual(registry)
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(2)
    await harness.close()
  })

  it('recovers every retained pre-commit phase from fresh Host and Workspace evidence', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'retained-phase-evidence')
    const harness = await start(durable)
    const request = intent(
      'intent-20202020-2020-4020-8020-202020202020',
      'Retained phase evidence',
      repo,
      0,
      await inspected(harness, repo),
    )
    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toMatchObject({ ok: true })
    const registryTable = liveSakiDomain(harness.ctx).table('development_project_registry')
    const intentTable = liveSakiDomain(harness.ctx).table('registration_intents')
    const confirmedRegistry = registryTable.get('development-project-registry')
    const confirmed = intentTable.get(request.intentId)
    if (confirmedRegistry === undefined || confirmed === undefined
      || confirmed.workspaceInspection === undefined || confirmed.workspaceId === undefined) {
      throw new Error('confirmed registration fixture is incomplete')
    }
    const emptyRegistry: DevelopmentProjectRegistryRecord = {
      ...structuredClone(confirmedRegistry),
      revision: 0,
      projects: [],
      resourceBindings: [],
      canonicalWorktreeIndex: [],
      gitDirectoryIndex: [],
      intentMappings: [],
    }
    const earlyRecord = (
      phase: 'prepared' | 'workspace-dispatching',
      inspection = confirmed.inspection,
      incoming = confirmed.payload.intent,
    ): RegistrationIntentRecord => {
      const candidate = structuredClone(confirmed)
      candidate.phase = phase
      candidate.inspection = inspection
      candidate.payload = { intent: incoming, actor: candidate.payload.actor }
      candidate.payloadDigest = canonicalDigest('saki/register-development-project/v1', candidate.payload)
      delete candidate.terminalReason
      clearRegistrationWorkspace(candidate)
      clearRegistrationCommit(candidate)
      return registrationIntentRecordSchema.parse(candidate)
    }
    const workspaceObserved = (): RegistrationIntentRecord => {
      const candidate = structuredClone(confirmed)
      candidate.phase = 'workspace-observed'
      delete candidate.terminalReason
      clearRegistrationCommit(candidate)
      return registrationIntentRecordSchema.parse(candidate)
    }
    const retain = async (record: RegistrationIntentRecord): Promise<void> => {
      await registryTable.put('development-project-registry', structuredClone(emptyRegistry))
      await intentTable.put(record.id, record)
    }
    let authority = true
    const inspect = vi.spyOn(harness.ctx.sakiHostExecution, 'inspectProjectSelection')
    const projects = () => new DevelopmentProjects({
      registryTable,
      intentTable,
      execution: harness.ctx.sakiHostExecution,
      workspaces: harness.ctx.workspaceRegistry,
      authorityCurrent: () => authority,
      validateActorReference: () => {},
    })

    authority = false
    await retain(earlyRecord('prepared'))
    inspect.mockClear()
    expect(await projects().replayExisting(request, new AbortController().signal)).toMatchObject({
      ok: false,
      receipt: { state: 'failure', reason: 'authority' },
    })
    expect(inspect).not.toHaveBeenCalled()

    authority = true
    await retain(earlyRecord('prepared'))
    inspect.mockResolvedValueOnce({ ok: false, reason: 'unavailable' })
    expect(await projects().replayExisting(request, new AbortController().signal)).toMatchObject({
      ok: false,
      reason: 'unavailable',
      receipt: { state: 'prepared' },
    })

    await retain(earlyRecord('prepared'))
    inspect.mockResolvedValueOnce({ ok: false, reason: 'missing' })
    expect(await projects().replayExisting(request, new AbortController().signal)).toMatchObject({
      ok: false,
      receipt: { state: 'reconciliation-required', reason: 'observation' },
    })

    const { fingerprint: _fingerprint, ...projection } = confirmed.inspection.projection
    const changedInspection = signedInspection({
      ...projection,
      displayLocation: `${projection.displayLocation}-changed`,
    }, confirmed.inspection.trusted)
    await retain(earlyRecord('prepared'))
    inspect.mockResolvedValueOnce({ ok: true, inspection: changedInspection })
    expect(await projects().replayExisting(request, new AbortController().signal)).toMatchObject({
      ok: false,
      receipt: { state: 'reconciliation-required', reason: 'observation' },
    })

    await retain(earlyRecord('workspace-dispatching'))
    inspect.mockResolvedValueOnce({ ok: false, reason: 'not-git' })
    expect(await projects().replayExisting(request, new AbortController().signal)).toMatchObject({
      ok: false,
      receipt: { state: 'reconciliation-required', reason: 'observation' },
    })

    const selectedWorkspaceIntent = {
      ...confirmed.payload.intent,
      confirmedFingerprint: confirmed.workspaceInspection.projection.fingerprint,
      confirmedBaseline: confirmed.workspaceInspection.projection.baseline,
    }
    await retain(earlyRecord(
      'workspace-dispatching',
      confirmed.workspaceInspection,
      selectedWorkspaceIntent,
    ))
    inspect.mockResolvedValueOnce({ ok: true, inspection: confirmed.inspection })
    expect(await projects().replayExisting(
      selectedWorkspaceIntent,
      new AbortController().signal,
    )).toMatchObject({
      ok: false,
      receipt: { state: 'reconciliation-required', reason: 'workspace' },
    })

    const {
      fingerprint: _workspaceFingerprint,
      ...workspaceProjection
    } = confirmed.workspaceInspection.projection
    const unmatchedWorkspace = signedInspection({
      ...workspaceProjection,
      workspaceId: WorkspaceId('workspace-unmatched'),
    }, confirmed.workspaceInspection.trusted)
    await retain(earlyRecord('workspace-dispatching'))
    inspect.mockResolvedValueOnce({ ok: true, inspection: unmatchedWorkspace })
    expect(await projects().replayExisting(request, new AbortController().signal)).toMatchObject({
      ok: false,
      receipt: { state: 'reconciliation-required', reason: 'workspace' },
    })

    await retain(workspaceObserved())
    inspect.mockResolvedValueOnce({ ok: false, reason: 'malformed' })
    expect(await projects().replayExisting(request, new AbortController().signal)).toMatchObject({
      ok: false,
      receipt: { state: 'reconciliation-required', reason: 'observation' },
    })
    await harness.close()
  })

  it('fences competing Intent transitions and Binding revalidation writes', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'durable-writer-fencing')
    const harness = await start(durable)
    const request = intent(
      'intent-21212121-2121-4121-8121-212121212121',
      'Durable writer fencing',
      repo,
      0,
      await inspected(harness, repo),
    )
    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toMatchObject({ ok: true })
    const registryTable = liveSakiDomain(harness.ctx).table('development_project_registry')
    const intentTable = liveSakiDomain(harness.ctx).table('registration_intents')
    const confirmedRegistry = registryTable.get('development-project-registry')
    const confirmed = intentTable.get(request.intentId)
    if (confirmedRegistry === undefined || confirmed === undefined) {
      throw new Error('confirmed registration fixture is incomplete')
    }
    const emptyRegistry: DevelopmentProjectRegistryRecord = {
      ...structuredClone(confirmedRegistry),
      revision: 0,
      projects: [],
      resourceBindings: [],
      canonicalWorktreeIndex: [],
      gitDirectoryIndex: [],
      intentMappings: [],
    }
    const prepared = (): RegistrationIntentRecord => {
      const candidate = structuredClone(confirmed)
      candidate.phase = 'prepared'
      delete candidate.terminalReason
      clearRegistrationWorkspace(candidate)
      clearRegistrationCommit(candidate)
      return registrationIntentRecordSchema.parse(candidate)
    }
    const retainPrepared = async (): Promise<void> => {
      await registryTable.put('development-project-registry', structuredClone(emptyRegistry))
      await intentTable.put(request.intentId, prepared())
    }
    const aggregate = (execution: SakiHostExecution) => new DevelopmentProjects({
      registryTable,
      intentTable,
      execution,
      workspaces: harness.ctx.workspaceRegistry,
      authorityCurrent: () => true,
      validateActorReference: () => {},
    })
    const race = async (
      firstResult: InspectProjectSelectionResult,
      laterResult: InspectProjectSelectionResult,
    ): Promise<PromiseSettledResult<unknown>[]> => {
      const bothInspecting = Promise.withResolvers<undefined>()
      const release = Promise.withResolvers<undefined>()
      let calls = 0
      const execution = harness.ctx.sakiHostExecution
      vi.spyOn(execution, 'inspectProjectSelection').mockImplementation(async () => {
        calls += 1
        if (calls <= 2) {
          if (calls === 2) bothInspecting.resolve(undefined)
          await release.promise
          return firstResult
        }
        return laterResult
      })
      const results = Promise.allSettled([
        aggregate(execution).replayExisting(request, new AbortController().signal),
        aggregate(execution).replayExisting(request, new AbortController().signal),
      ])
      await bothInspecting.promise
      release.resolve(undefined)
      return await results
    }

    await retainPrepared()
    let results = await race(
      { ok: true, inspection: confirmed.inspection },
      { ok: false, reason: 'unavailable' },
    )
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({
      reason: { name: 'IntentCasConflict', message: 'registration Intent changed outside its serialized lifecycle' },
    })

    vi.restoreAllMocks()
    await retainPrepared()
    results = await race(
      { ok: false, reason: 'missing' },
      { ok: false, reason: 'unavailable' },
    )
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(results.find(result => result.status === 'fulfilled')).toMatchObject({
      value: { ok: false, receipt: { state: 'reconciliation-required' } },
    })

    vi.restoreAllMocks()
    await registryTable.put('development-project-registry', structuredClone(confirmedRegistry))
    await intentTable.put(request.intentId, structuredClone(confirmed))
    const revalidationExecution = harness.ctx.sakiHostExecution
    vi.spyOn(revalidationExecution, 'inspectProjectSelection').mockImplementationOnce(async () => {
      await registryTable.update('development-project-registry', (registry) => {
        const binding = registry.resourceBindings[0]
        if (binding === undefined) throw new Error('Binding fixture is absent')
        registry.revision += 1
        binding.revision += 1
        return registry
      })
      return { ok: false, reason: 'unavailable' }
    })
    const projects = aggregate(revalidationExecution)
    await expect(projects.initializeValidated(
      projects.validateDurableState(),
      new AbortController().signal,
    )).rejects.toThrow('Resource Binding changed during serialized startup revalidation')
    await harness.close()
  })

  it('commits and invalidates only one concurrent registration at an exact Registry revision', async () => {
    const durable = await paths()
    const leftRepo = await repository(durable.root, 'cas-left')
    const rightRepo = await repository(durable.root, 'cas-right')
    const harness = await start(durable)
    const left = intent(
      'intent-cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'CAS left',
      leftRepo,
      0,
      await inspected(harness, leftRepo),
    )
    const right = intent(
      'intent-dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      'CAS right',
      rightRepo,
      0,
      await inspected(harness, rightRepo),
    )
    const invalidations: {
      readonly keys: readonly string[]
      readonly registryRevision: number | undefined
      readonly projectIds: readonly string[]
    }[] = []
    const disposeInvalidation = harness.control.onChanged((keys) => {
      const registry = liveSakiDomain(harness.ctx).table('development_project_registry')
        .get('development-project-registry')
      invalidations.push({
        keys: [...keys],
        registryRevision: registry?.revision,
        projectIds: registry?.projects.map(project => project.id) ?? [],
      })
    })

    const results = await Promise.all([
      harness.control.submit(harness.authentication, left, new AbortController().signal),
      harness.control.submit(harness.authentication, right, new AbortController().signal),
    ])
    disposeInvalidation()

    const accepted = results.find(result => result.ok)
    expect(accepted).toMatchObject({ ok: true, receipt: { registryRevision: 1 } })
    if (accepted === undefined || !accepted.ok) throw new Error('concurrent registration produced no accepted result')
    const rejected = results.find(result => !result.ok)
    expect(rejected).toMatchObject({
      ok: false,
      reason: 'conflict',
      receipt: { state: 'conflict', reason: 'expected-revision' },
    })
    expect(invalidations).toEqual([{
      keys: ['project-index', 'development-workspace'],
      registryRevision: 1,
      projectIds: [accepted.receipt.projectId],
    }])
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(2)
    const index = await harness.control.query(
      harness.authentication,
      { type: 'project-index' },
      new AbortController().signal,
    )
    expect(index.ok && index.projection.type === 'project-index'
      ? index.projection.projects
      : []).toHaveLength(1)
    await harness.close()
  })

  it('rejects an operator-confirmed Workspace identity after it disappears or is replaced', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'workspace-confirmation')
    const harness = await start(durable)
    const original = await harness.ctx.workspaceRegistry.create(repo, 'Original Workspace')
    const selection = await inspected(harness, repo)
    const request = intent(
      'intent-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      'Workspace confirmation',
      repo,
      0,
      selection,
    )

    expect(await harness.ctx.workspaceRegistry.delete(original.id)).toBe(true)
    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toEqual({ ok: false, reason: 'conflict' })

    const replacement = await harness.ctx.workspaceRegistry.create(repo, 'Replacement Workspace')
    expect(replacement.id).not.toBe(original.id)
    const create = vi.spyOn(harness.ctx.workspaceRegistry, 'create')
    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toEqual({ ok: false, reason: 'conflict' })
    expect(create).not.toHaveBeenCalled()
    await harness.close()
  })

  it('adopts a Workspace that appears after an absent selection is durably prepared', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'concurrent-workspace')
    const harness = await start(durable)
    const selection = await inspected(harness, repo)
    const request = intent(
      'intent-ffffffff-ffff-4fff-8fff-ffffffffffff',
      'Concurrent Workspace',
      repo,
      0,
      selection,
    )
    const originalInspect = harness.ctx.sakiHostExecution.inspectProjectSelection
      .bind(harness.ctx.sakiHostExecution)
    let inspectionCount = 0
    const inspect = vi.spyOn(harness.ctx.sakiHostExecution, 'inspectProjectSelection')
      .mockImplementation(async (input, signal) => {
        inspectionCount += 1
        if (inspectionCount === 2) {
          await harness.ctx.workspaceRegistry.create(repo, 'Concurrent owner')
        }
        return await originalInspect(input, signal)
      })

    const result = await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )

    expect(result).toMatchObject({ ok: true, receipt: { state: 'confirmed', registryRevision: 1 } })
    expect(inspect).toHaveBeenCalledTimes(3)
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(1)
    await harness.close()
  })

  it('retains the Workspace identity when repository evidence changes after create', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'post-effect-change')
    const harness = await start(durable)
    const selection = await inspected(harness, repo)
    const request = intent(
      'intent-12121212-1212-4212-8212-121212121212',
      'Post-effect change',
      repo,
      0,
      selection,
    )
    const originalCreate = harness.ctx.workspaceRegistry.create.bind(harness.ctx.workspaceRegistry)
    vi.spyOn(harness.ctx.workspaceRegistry, 'create').mockImplementationOnce(async (path, title) => {
      const workspace = await originalCreate(path, title)
      await writeFile(join(repo, 'tracked.txt'), 'changed after Workspace effect\n')
      return workspace
    })

    const result = await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )
    expect(result).toMatchObject({
      ok: false,
      reason: 'reconciliation-required',
      receipt: { state: 'reconciliation-required', reason: 'observation' },
    })
    const workspaceId = harness.ctx.workspaceRegistry.list()[0]?.id
    expect(workspaceId).toBeDefined()
    await harness.close()
    await editSaki(durable, async (domain) => {
      expect(domain.table('registration_intents').get(request.intentId)).toMatchObject({
        phase: 'reconciliation-required',
        workspaceId,
        terminalReason: 'observation',
      })
      expect(domain.table('development_project_registry').get('development-project-registry')
        ?.projects).toHaveLength(0)
    })
  })

  it('aborts and drains a paused inspection before closing its durable domain', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'dispose-inspection')
    const harness = await start(durable)
    const hostId = harness.control.identity().hostId
    const observed = await harness.ctx.sakiHostExecution.inspectProjectSelection({
      hostId,
      directoryLocator: repo,
    }, new AbortController().signal)
    if (!observed.ok) throw new Error('fixture inspection failed')
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(harness.ctx.sakiHostExecution, 'inspectProjectSelection').mockImplementation(async () => {
      started.resolve(undefined)
      await release.promise
      return observed
    })
    const query = harness.control.query(harness.authentication, {
      type: 'inspect-project-selection',
      hostId,
      directoryLocator: repo,
    }, new AbortController().signal)
    await started.promise
    let disposed = false
    const closing = harness.close().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)

    release.resolve(undefined)
    await expect(query).rejects.toThrow('saki control plane is disposing')
    await closing
    expect(disposed).toBe(true)
    await expect(harness.control.query(harness.authentication, {
      type: 'project-index',
    }, new AbortController().signal)).rejects.toThrow('saki control plane is disposing')
  })

  it('persists a completed Workspace effect before disposal closes the Intent domain', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'dispose-create')
    const harness = await start(durable)
    const selection = await inspected(harness, repo)
    const request = intent(
      'intent-13131313-1313-4313-8313-131313131313',
      'Dispose create',
      repo,
      0,
      selection,
    )
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const originalCreate = harness.ctx.workspaceRegistry.create.bind(harness.ctx.workspaceRegistry)
    vi.spyOn(harness.ctx.workspaceRegistry, 'create').mockImplementationOnce(async (path, title) => {
      const workspace = await originalCreate(path, title)
      started.resolve(undefined)
      await release.promise
      return workspace
    })
    const submission = harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )
    await started.promise
    let disposed = false
    const closing = harness.close().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)

    release.resolve(undefined)
    await expect(submission).rejects.toThrow('saki control plane is disposing')
    await closing
    expect(disposed).toBe(true)
    await editSaki(durable, async (domain) => {
      expect(domain.table('registration_intents').get(request.intentId)).toMatchObject({
        phase: 'workspace-observed',
      })
    })
  })

  it('rejects an Intent admitted immediately before disposal starts its keyed operation', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'dispose-before-intent-tail')
    const harness = await start(durable)
    const request = intent(
      'intent-22222222-2222-4222-8222-222222222223',
      'Dispose before Intent tail',
      repo,
      0,
      await inspected(harness, repo),
    )

    const submission = harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )
    const closing = harness.close()

    await expect(submission).rejects.toThrow('saki control plane is disposing')
    await closing
    await editSaki(durable, async (domain) => {
      expect(domain.table('registration_intents').get(request.intentId)).toBeUndefined()
    })
  })

  it('rechecks the Installation generation after initial inspection before preparing an Intent', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'generation-barrier')
    const harness = await start(durable)
    const selection = await inspected(harness, repo)
    const request = intent(
      'intent-14141414-1414-4414-8414-141414141414',
      'Generation barrier',
      repo,
      0,
      selection,
    )
    const originalInspect = harness.ctx.sakiHostExecution.inspectProjectSelection
      .bind(harness.ctx.sakiHostExecution)
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(harness.ctx.sakiHostExecution, 'inspectProjectSelection').mockImplementation(async (input, signal) => {
      started.resolve(undefined)
      await release.promise
      return await originalInspect(input, signal)
    })
    const create = vi.spyOn(harness.ctx.workspaceRegistry, 'create')
    const submission = harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )
    await started.promise
    const domain = liveSakiDomain(harness.ctx)
    const installation = [...domain.table('installations').entries()][0]
    if (installation === undefined) throw new Error('Installation fixture is absent')
    await domain.table('installations').update(installation[0], current => ({
      ...current,
      revision: current.revision + 1,
      currentInstallationGenerationId:
        'installation-generation-14141414-1414-4414-8414-141414141414' as SakiInstallationGenerationId,
    }))
    release.resolve(undefined)

    expect(await submission).toEqual({ ok: false, reason: 'denied' })
    expect(create).not.toHaveBeenCalled()
    expect(domain.table('registration_intents').size).toBe(0)
    expect(domain.table('development_project_registry').get('development-project-registry')
      ?.projects).toHaveLength(0)
    await harness.close()
  })

  it('recovers under benign Principal and Grant revision changes', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'revision-recovery')
    let harness = await start(durable)
    const request = intent(
      'intent-15151515-1515-4515-8515-151515151515',
      'Revision recovery',
      repo,
      0,
      await inspected(harness, repo),
    )
    await disposeDuringDispatchInspection(harness, request)
    await editSaki(durable, async (domain) => {
      const retained = domain.table('registration_intents').get(request.intentId)
      if (retained === undefined) throw new Error('Intent fixture is absent')
      await domain.table('principals').update(retained.payload.actor.principalId, current => ({
        ...current,
        revision: current.revision + 1,
      }))
      await domain.table('grants').update(retained.payload.actor.grantId, current => ({
        ...current,
        revision: current.revision + 1,
      }))
    })

    harness = await start(durable)
    const index = await harness.control.query(
      harness.authentication,
      { type: 'project-index' },
      new AbortController().signal,
    )
    expect(index.ok && index.projection.type === 'project-index'
      ? index.projection.projects
      : []).toHaveLength(1)
    expect(liveSakiDomain(harness.ctx).table('registration_intents').get(request.intentId))
      .toMatchObject({ phase: 'confirmed' })
    await harness.close()
  })

  it('blocks a not-yet-started Workspace effect after the retained Grant is revoked', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'revoked-recovery')
    const harness = await start(durable)
    const request = intent(
      'intent-16161616-1616-4616-8616-161616161616',
      'Revoked recovery',
      repo,
      0,
      await inspected(harness, repo),
    )
    await disposeDuringDispatchInspection(harness, request)
    await editSaki(durable, async (domain) => {
      const retained = domain.table('registration_intents').get(request.intentId)
      if (retained === undefined) throw new Error('Intent fixture is absent')
      await domain.table('grants').update(retained.payload.actor.grantId, current => ({
        ...current,
        revision: current.revision + 1,
        state: 'revoked',
      }))
    })

    const restarted = await context(durable)
    const create = vi.spyOn(restarted.workspaceRegistry, 'create')
    const controlFiber = await restarted.plugin(SakiControlPlane, CONTROL_CONFIG)
    try {
      expect(create).not.toHaveBeenCalled()
      const domain = liveSakiDomain(restarted)
      expect(domain.table('registration_intents').get(request.intentId)).toMatchObject({
        phase: 'failure',
        terminalReason: 'authority',
      })
      expect(domain.table('development_project_registry').get('development-project-registry')
        ?.projects).toHaveLength(0)
    } finally {
      await controlFiber.dispose()
      await restarted.fiber.dispose()
    }
  })

  it('adopts a possibly completed Workspace effect after the retained Grant is revoked', async () => {
    const durable = await paths()
    const repo = await repository(durable.root, 'revoked-after-effect')
    const requestId = 'intent-17171717-1717-4717-8717-171717171717' as SakiControlIntentId
    const harness = await start(durable)
    const request = intent(
      requestId,
      'Revoked after effect',
      repo,
      0,
      await inspected(harness, repo),
    )
    const originalCreate = harness.ctx.workspaceRegistry.create.bind(harness.ctx.workspaceRegistry)
    vi.spyOn(harness.ctx.workspaceRegistry, 'create').mockImplementationOnce(async (path, title) => {
      await originalCreate(path, title)
      throw new Error('Workspace commit response was lost')
    })
    expect(await harness.control.submit(
      harness.authentication,
      request,
      new AbortController().signal,
    )).toMatchObject({ ok: false, reason: 'unavailable', receipt: { state: 'prepared' } })
    expect(harness.ctx.workspaceRegistry.list()).toHaveLength(1)
    await harness.close()

    await editSaki(durable, async (domain) => {
      const retained = domain.table('registration_intents').get(requestId)
      if (retained === undefined) throw new Error('Intent fixture is absent')
      await domain.table('grants').update(retained.payload.actor.grantId, current => ({
        ...current,
        revision: current.revision + 1,
        state: 'revoked',
      }))
    })
    const restarted = await context(durable)
    const create = vi.spyOn(restarted.workspaceRegistry, 'create')
    const controlFiber = await restarted.plugin(SakiControlPlane, CONTROL_CONFIG)
    try {
      expect(create).not.toHaveBeenCalled()
      const domain = liveSakiDomain(restarted)
      expect(domain.table('registration_intents').get(requestId)).toMatchObject({ phase: 'confirmed' })
      expect(domain.table('development_project_registry').get('development-project-registry')?.projects)
        .toHaveLength(1)
    } finally {
      await controlFiber.dispose()
      await restarted.fiber.dispose()
    }
  })
})
