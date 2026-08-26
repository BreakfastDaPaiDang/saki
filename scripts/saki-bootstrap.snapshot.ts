/** Keyless source-and-artifact snapshot for Saki Project registration over the real `/saki` transport. */

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  cleanupSnapshot,
  createRepository,
  fixtureGitEnvironment,
  freePort,
  rawRequest,
  registerSnapshotProject,
  rpc,
  runWithCleanup,
  serializeSnapshotRecords,
  startSaki,
  verifySnapshotOutput,
  type StartedSaki,
} from './fixtures/saki-host-snapshot.ts'
import { sakiSnapshotEnvironment } from './saki-snapshot-environment.ts'

const root = resolve(import.meta.dirname, '..')
const sourceBin = join(root, 'packages/saki/bundle/src/bin.ts')
const builtBin = join(root, 'packages/saki/bundle/lib/bin.js')
const expected = join(root, 'scripts/snapshots/saki-bootstrap/access.expected.jsonl')
const refreshing = process.env.DSH_SNAPSHOT === 'record' || process.env.DSH_SNAPSHOT === 'refresh'
const nullConfig = process.platform === 'win32' ? 'NUL' : '/dev/null'

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
    const {
      initial,
      exchangeValue,
      cookie,
      initialIndex,
      inspection,
      selection,
      registrationIntent,
      confirmed,
    } = await registerSnapshotProject(port, bootstrapSecret, repository)
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
    const output = serializeSnapshotRecords(
      records,
      [directory, repository, bootstrapSecret, cookie, exchangeValue.access.requestToken],
    )
    await second.stop()
    second = undefined
    return output
  }, async () => { await cleanupSnapshot(directory, first, second) })
}

async function verify(entry: string): Promise<void> {
  const output = await transcript(entry)
  await verifySnapshotOutput(expected, output, refreshing)
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
