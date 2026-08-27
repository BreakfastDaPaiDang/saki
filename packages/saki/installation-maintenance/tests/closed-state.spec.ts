import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KvUnitSnapshot } from '@deepseek-ai/dsh-storage'
import { descriptorOf, type DomainSpec } from '@deepseek-ai/dsh-storage-domain'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import {
  createStorageGenerationSeal,
  sakiControlPlaneV2DomainSpec,
  sakiControlPlaneV3DomainSpec,
  sakiStorageGenerationDomainSpec,
  sakiStorageGenerationV1DomainSpec,
  STORAGE_GENERATION_KEY,
  storageGenerationV1SealRecordSchema,
  type SakiBuildId,
  type SakiGrantId,
  type SakiHostId,
  type SakiInstallationAccessId,
  type SakiInstallationId,
  type SakiPrincipalId,
  type SakiStorageGenerationId,
} from '@breakfastdapaidang/saki-control-plane'
import {
  CONTROL_STATE_KEY,
  DEVELOPMENT_PROJECT_REGISTRY_KEY,
  sakiControlPlaneDomainSpec,
} from '@breakfastdapaidang/saki-control-plane/src/spec.ts'
import {
  readClosedCurrentSakiState,
  readClosedProvisioningSakiState,
  readClosedSakiV2State,
  readClosedSakiV3State,
} from '../src/closed-state.ts'

const INSTALLATION_ID = 'installation-00000000-0000-4000-8000-000000000001' as SakiInstallationId
const STORAGE_GENERATION_ID =
  'storage-generation-00000000-0000-4000-8000-000000000002' as SakiStorageGenerationId
const HOST_ID = 'host-00000000-0000-4000-8000-000000000003' as SakiHostId
const PRINCIPAL_ID = 'principal-00000000-0000-4000-8000-000000000004' as SakiPrincipalId
const GRANT_ID = 'grant-00000000-0000-4000-8000-000000000005' as SakiGrantId
const ACCESS_ID = 'access-00000000-0000-4000-8000-000000000006' as SakiInstallationAccessId
const BUILD_ID = 'saki-build-closed-state-test' as SakiBuildId
const OTHER_BUILD_ID = 'saki-build-other' as SakiBuildId
const roots: string[] = []
// oxlint-disable-next-line typescript/unbound-method -- fault tests invoke it with the backend receiver.
const realClose = SqliteStorageBackend.prototype.close

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function databasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'saki-closed-state-'))
  roots.push(root)
  return join(root, 'state.sqlite')
}

function emptySnapshot(spec: DomainSpec): KvUnitSnapshot {
  return {
    tables: Object.fromEntries(Object.keys(spec.tables).map(table => [table, {}])),
    global: null,
  }
}

function currentControlSnapshot(): KvUnitSnapshot {
  return {
    global: null,
    tables: {
      control_state: {
        [CONTROL_STATE_KEY]: {
          schemaVersion: 2,
          revision: 1,
          phase: 'ready',
          installationId: INSTALLATION_ID,
          initialHostId: HOST_ID,
          hostOperatorPrincipalId: PRINCIPAL_ID,
          hostOperatorGrantId: GRANT_ID,
          installationAccessId: ACCESS_ID,
        },
      },
      installations: {
        [INSTALLATION_ID]: {
          id: INSTALLATION_ID,
          revision: 1,
          state: 'active',
          currentHostId: HOST_ID,
        },
      },
      hosts: {
        [HOST_ID]: {
          id: HOST_ID,
          revision: 1,
          installationId: INSTALLATION_ID,
          state: 'enrolled',
        },
      },
      principals: {
        [PRINCIPAL_ID]: {
          id: PRINCIPAL_ID,
          revision: 1,
          kind: 'human',
          displayName: 'Host Operator',
          state: 'active',
        },
      },
      grants: {
        [GRANT_ID]: {
          id: GRANT_ID,
          revision: 1,
          installationId: INSTALLATION_ID,
          principalId: PRINCIPAL_ID,
          state: 'active',
          actions: ['development-project:register'],
          scope: { kind: 'installation', installationId: INSTALLATION_ID },
        },
      },
      installation_access: {
        [ACCESS_ID]: {
          id: ACCESS_ID,
          schemaVersion: 2,
          revision: 0,
          installationId: INSTALLATION_ID,
          nextChallengeOrdinal: 0,
          nextSessionOrdinal: 0,
          requestTokenDerivation: { version: 1, domain: 'saki/browser-request-token' },
          challenges: [],
          sessions: [],
        },
      },
      development_project_registry: {
        [DEVELOPMENT_PROJECT_REGISTRY_KEY]: {
          id: DEVELOPMENT_PROJECT_REGISTRY_KEY,
          schemaVersion: 1,
          revision: 0,
          projects: [],
          resourceBindings: [],
          canonicalWorktreeIndex: [],
          gitDirectoryIndex: [],
          intentMappings: [],
        },
      },
      registration_intents: {},
      github_project_sync: {},
      github_sync_configuration_intents: {},
    },
  }
}

function sealSnapshot(createdByBuildId: SakiBuildId = BUILD_ID): KvUnitSnapshot {
  return {
    global: null,
    tables: {
      storage_generation: {
        [STORAGE_GENERATION_KEY]: createStorageGenerationSeal(
          INSTALLATION_ID,
          STORAGE_GENERATION_ID,
          createdByBuildId,
        ),
      },
    },
  }
}

function v3ControlSnapshot(): KvUnitSnapshot {
  const current = currentControlSnapshot()
  const tables = { ...current.tables }
  delete tables['github_project_sync']
  delete tables['github_sync_configuration_intents']
  return { global: null, tables }
}

function v1SealSnapshot(createdByBuildId: SakiBuildId = BUILD_ID): KvUnitSnapshot {
  return {
    global: null,
    tables: {
      storage_generation: {
        [STORAGE_GENERATION_KEY]: storageGenerationV1SealRecordSchema.parse({
          schemaVersion: 1,
          installationId: INSTALLATION_ID,
          storageGenerationId: STORAGE_GENERATION_ID,
          stateVersion: 3,
          createdByBuildId,
        }),
      },
    },
  }
}

async function materialize(
  path: string,
  units: readonly { readonly spec: DomainSpec; readonly snapshot: KvUnitSnapshot }[],
): Promise<void> {
  const backend = new SqliteStorageBackend({ path, journalMode: 'delete' })
  try {
    const closed = backend.kv.closed
    if (closed === undefined) throw new Error('test SQLite backend has no closed operations')
    for (const unit of units) {
      await closed.withReservedUnit(unit.spec.name, AbortSignal.timeout(2_000), async (lease) => {
        const result = await lease.materializeMissing(descriptorOf(unit.spec), unit.snapshot)
        if (result.outcome !== 'durable') throw result.cause
      })
    }
  } finally {
    await backend.close()
  }
}

async function exactFiles(path: string): Promise<readonly [Buffer, Buffer]> {
  return await Promise.all([readFile(path), readFile(`${path}-shm`)])
}

describe('closed Saki state reads', () => {
  it('validates current state through detached read-only domains without changing source artifacts', async () => {
    const path = await databasePath()
    await materialize(path, [
      { spec: sakiControlPlaneDomainSpec, snapshot: currentControlSnapshot() },
      { spec: sakiStorageGenerationDomainSpec, snapshot: sealSnapshot() },
    ])
    await writeFile(`${path}-shm`, Buffer.from([1, 3, 3, 7]))
    const before = await exactFiles(path)

    const state = await readClosedCurrentSakiState(path, {
      installationId: INSTALLATION_ID,
      storageGenerationId: STORAGE_GENERATION_ID,
      createdByBuildId: BUILD_ID,
    }, AbortSignal.timeout(2_000))

    expect(state.controlPlane.table('installations').get(INSTALLATION_ID)?.currentHostId).toBe(HOST_ID)
    expect(state.storageGeneration.table('storage_generation').size).toBe(1)
    const installations = state.controlPlane.table('installations')
    const installation = installations.get(INSTALLATION_ID)!
    expect([...installations.keys()]).toEqual([INSTALLATION_ID])
    expect(() => state.controlPlane.global).toThrow('declares no global')
    await expect(installations.put(INSTALLATION_ID, installation)).rejects.toThrow('read-only')
    await expect(installations.delete(INSTALLATION_ID)).rejects.toThrow('read-only')
    await expect(installations.update(INSTALLATION_ID, value => value)).rejects.toThrow('read-only')
    await expect(state.controlPlane.close()).resolves.toBeUndefined()
    expect(await exactFiles(path)).toEqual(before)
    expect(state.sourceArtifacts.artifacts.map(artifact => artifact.role)).toEqual(['database', 'shm'])
  })

  it('accepts an empty current control plane while provisioning and leaves every source artifact unchanged', async () => {
    const path = await databasePath()
    await materialize(path, [
      { spec: sakiControlPlaneDomainSpec, snapshot: emptySnapshot(sakiControlPlaneDomainSpec) },
      { spec: sakiStorageGenerationDomainSpec, snapshot: sealSnapshot() },
    ])
    await writeFile(`${path}-shm`, Buffer.from([2, 4, 6, 8]))
    const before = await exactFiles(path)

    const state = await readClosedProvisioningSakiState(path, {
      installationId: INSTALLATION_ID,
      storageGenerationId: STORAGE_GENERATION_ID,
      stateVersion: 4,
      createdByBuildId: BUILD_ID,
    }, AbortSignal.timeout(2_000))

    expect(state.controlPlane.table('control_state').size).toBe(0)
    expect(state.storageGeneration.table('storage_generation').get(STORAGE_GENERATION_KEY))
      .toMatchObject({ createdByBuildId: BUILD_ID })
    expect(await exactFiles(path)).toEqual(before)
  })

  it('rejects a provisioning generation with no seal without changing source artifacts', async () => {
    const path = await databasePath()
    await materialize(path, [
      { spec: sakiControlPlaneDomainSpec, snapshot: emptySnapshot(sakiControlPlaneDomainSpec) },
    ])
    await writeFile(`${path}-shm`, Buffer.from([5, 5, 5]))
    const before = await exactFiles(path)

    await expect(readClosedProvisioningSakiState(path, {
      installationId: INSTALLATION_ID,
      storageGenerationId: STORAGE_GENERATION_ID,
      stateVersion: 4,
      createdByBuildId: BUILD_ID,
    }, AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'recovery-required' })
    expect(await exactFiles(path)).toEqual(before)
  })

  it('rejects an empty storage-generation domain without changing source artifacts', async () => {
    const path = await databasePath()
    await materialize(path, [
      { spec: sakiControlPlaneDomainSpec, snapshot: emptySnapshot(sakiControlPlaneDomainSpec) },
      { spec: sakiStorageGenerationDomainSpec, snapshot: emptySnapshot(sakiStorageGenerationDomainSpec) },
    ])
    const before = await readFile(path)

    await expect(readClosedProvisioningSakiState(path, {
      installationId: INSTALLATION_ID,
      storageGenerationId: STORAGE_GENERATION_ID,
      stateVersion: 4,
      createdByBuildId: BUILD_ID,
    }, AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'recovery-required' })
    await expect(readFile(path)).resolves.toEqual(before)
  })

  it('rejects a provisioning seal that disagrees with fixed build provenance without changing the source', async () => {
    const path = await databasePath()
    await materialize(path, [
      { spec: sakiControlPlaneDomainSpec, snapshot: emptySnapshot(sakiControlPlaneDomainSpec) },
      { spec: sakiStorageGenerationDomainSpec, snapshot: sealSnapshot(OTHER_BUILD_ID) },
    ])
    await writeFile(`${path}-shm`, Buffer.from([7, 7, 7]))
    const before = await exactFiles(path)

    await expect(readClosedProvisioningSakiState(path, {
      installationId: INSTALLATION_ID,
      storageGenerationId: STORAGE_GENERATION_ID,
      stateVersion: 4,
      createdByBuildId: BUILD_ID,
    }, AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'recovery-required' })
    expect(await exactFiles(path)).toEqual(before)
  })

  it('rejects a selected current generation with a missing seal without changing source artifacts', async () => {
    const path = await databasePath()
    await materialize(path, [{ spec: sakiControlPlaneDomainSpec, snapshot: currentControlSnapshot() }])
    await writeFile(`${path}-shm`, 'sidecar-evidence')
    const before = await exactFiles(path)

    await expect(readClosedCurrentSakiState(path, {
      installationId: INSTALLATION_ID,
      storageGenerationId: STORAGE_GENERATION_ID,
      createdByBuildId: BUILD_ID,
    }, AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'recovery-required' })
    expect(await exactFiles(path)).toEqual(before)
  })

  it('rejects corrupt current records without changing source artifacts', async () => {
    const path = await databasePath()
    const corrupt = currentControlSnapshot()
    corrupt.tables.control_state = { [CONTROL_STATE_KEY]: { corrupt: true } }
    await materialize(path, [
      { spec: sakiControlPlaneDomainSpec, snapshot: corrupt },
      { spec: sakiStorageGenerationDomainSpec, snapshot: sealSnapshot() },
    ])
    await writeFile(`${path}-shm`, Buffer.from([9, 8, 7]))
    const before = await exactFiles(path)

    await expect(readClosedCurrentSakiState(path, {
      installationId: INSTALLATION_ID,
      storageGenerationId: STORAGE_GENERATION_ID,
      createdByBuildId: BUILD_ID,
    }, AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'recovery-required' })
    expect(await exactFiles(path)).toEqual(before)
  })

  it('returns structural v2 data for separate validation and rejects a v2-plus-seal hybrid', async () => {
    const path = await databasePath()
    await materialize(path, [{ spec: sakiControlPlaneV2DomainSpec, snapshot: emptySnapshot(sakiControlPlaneV2DomainSpec) }])

    const historical = await readClosedSakiV2State(path, AbortSignal.timeout(2_000))
    expect(historical.controlPlane.table('control_state').size).toBe(0)
    await expect(historical.controlPlane.table('control_state').delete(CONTROL_STATE_KEY))
      .rejects.toThrow('read-only')

    await materialize(path, [{ spec: sakiStorageGenerationDomainSpec, snapshot: sealSnapshot() }])
    await expect(readClosedSakiV2State(path, AbortSignal.timeout(2_000)))
      .rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('validates exact historical v3 control and storage-generation domains', async () => {
    const path = await databasePath()
    await materialize(path, [
      { spec: sakiControlPlaneV3DomainSpec, snapshot: v3ControlSnapshot() },
      { spec: sakiStorageGenerationV1DomainSpec, snapshot: v1SealSnapshot() },
    ])

    const historical = await readClosedSakiV3State(path, {
      installationId: INSTALLATION_ID,
      storageGenerationId: STORAGE_GENERATION_ID,
      createdByBuildId: BUILD_ID,
    }, AbortSignal.timeout(2_000))

    expect(historical.stateVersion).toBe(3)
    expect(historical.controlPlane.table('installations').get(INSTALLATION_ID)?.currentHostId).toBe(HOST_ID)
    expect(historical.storageGeneration.table('storage_generation').size).toBe(1)
  })

  it('classifies a historical v3 seal that disagrees with selected build provenance', async () => {
    const path = await databasePath()
    await materialize(path, [
      { spec: sakiControlPlaneV3DomainSpec, snapshot: v3ControlSnapshot() },
      { spec: sakiStorageGenerationV1DomainSpec, snapshot: v1SealSnapshot(OTHER_BUILD_ID) },
    ])

    await expect(readClosedSakiV3State(path, {
      installationId: INSTALLATION_ID,
      storageGenerationId: STORAGE_GENERATION_ID,
      createdByBuildId: BUILD_ID,
    }, AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('preserves a state-read failure together with backend-close failure', async () => {
    const path = await databasePath()
    await materialize(path, [{ spec: sakiControlPlaneV2DomainSpec, snapshot: emptySnapshot(sakiControlPlaneV2DomainSpec) }])
    const closeFailure = new Error('close failed')
    vi.spyOn(SqliteStorageBackend.prototype, 'close').mockRejectedValueOnce(closeFailure)

    const failure = await readClosedCurrentSakiState(path, {
      installationId: INSTALLATION_ID,
      storageGenerationId: STORAGE_GENERATION_ID,
      createdByBuildId: BUILD_ID,
    }, AbortSignal.timeout(2_000)).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toHaveLength(2)
    expect((failure as AggregateError).errors[0]).toMatchObject({ code: 'recovery-required' })
    expect((failure as AggregateError).errors[1]).toBe(closeFailure)
  })

  it('classifies a missing source database as recovery-required', async () => {
    await expect(readClosedSakiV2State(
      await databasePath(),
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('preserves cancellation while capturing source artifacts', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled')
    controller.abort(reason)

    await expect(readClosedSakiV2State(await databasePath(), controller.signal)).rejects.toBe(reason)
  })

  it('rejects a source that changes after its closed read', async () => {
    const path = await databasePath()
    await materialize(path, [{ spec: sakiControlPlaneV2DomainSpec, snapshot: emptySnapshot(sakiControlPlaneV2DomainSpec) }])
    vi.spyOn(SqliteStorageBackend.prototype, 'close').mockImplementationOnce(async function (this: SqliteStorageBackend) {
      await realClose.call(this)
      await writeFile(path, 'changed after closed read')
    })

    await expect(readClosedSakiV2State(path, AbortSignal.timeout(2_000)))
      .rejects.toMatchObject({ code: 'source-changed' })
  })

  it('retains backend-close and source-verification failures after a successful read', async () => {
    const path = await databasePath()
    await materialize(path, [{ spec: sakiControlPlaneV2DomainSpec, snapshot: emptySnapshot(sakiControlPlaneV2DomainSpec) }])
    const closeFailure = new Error('close failed')
    vi.spyOn(SqliteStorageBackend.prototype, 'close').mockImplementationOnce(async function (this: SqliteStorageBackend) {
      await realClose.call(this)
      await writeFile(path, 'changed after closed read')
      throw closeFailure
    })

    const failure = await readClosedSakiV2State(path, AbortSignal.timeout(2_000))
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toHaveLength(2)
    expect((failure as AggregateError).errors[0]).toBe(closeFailure)
  })
})
