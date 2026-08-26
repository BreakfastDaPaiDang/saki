import { describe, expect, it, vi } from 'vitest'
import type { KvUnitSnapshot } from '@deepseek-ai/dsh-storage'
import { descriptorOf } from '@deepseek-ai/dsh-storage-domain'
import {
  sakiControlPlaneV2DomainSpec,
  type SakiBuildId,
  type SakiInstallationId,
  type SakiStorageGenerationId,
} from '@breakfastdapaidang/saki-control-plane'

const controls = vi.hoisted(() => ({
  assertUnchanged: vi.fn<(...args: unknown[]) => Promise<void>>(),
  capture: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  construct: vi.fn<(...args: unknown[]) => {
    readonly kv: unknown
    readonly close: () => Promise<void>
  }>(),
}))

vi.mock('../src/artifacts.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/artifacts.ts')>()
  return {
    ...original,
    assertSqliteArtifactSetUnchanged: controls.assertUnchanged,
    captureSqliteArtifactSet: controls.capture,
  }
})

vi.mock('@deepseek-ai/dsh-storage-sqlite', () => ({
  SqliteStorageBackend: class {
    readonly kv: unknown
    private readonly closeBackend: () => Promise<void>

    constructor(config: unknown) {
      const backend = controls.construct(config)
      this.kv = backend.kv
      this.closeBackend = backend.close
    }

    async close(): Promise<void> {
      await this.closeBackend()
    }
  },
}))

import { SakiMaintenanceError } from '../src/error.ts'
import { readClosedCurrentSakiState, readClosedSakiV2State } from '../src/closed-state.ts'

const INSTALLATION_ID = 'installation-00000000-0000-4000-8000-000000000001' as SakiInstallationId
const GENERATION_ID = 'storage-generation-00000000-0000-4000-8000-000000000002' as SakiStorageGenerationId
const BUILD_ID = 'saki-build-closed-boundary-test' as SakiBuildId
const SOURCE_ARTIFACTS = { databasePath: 'fake.sqlite', artifacts: [] }

function currentExpectation() {
  return {
    installationId: INSTALLATION_ID,
    storageGenerationId: GENERATION_ID,
    createdByBuildId: BUILD_ID,
  }
}

function resetArtifactEffects(): void {
  controls.capture.mockReset().mockResolvedValue(SOURCE_ARTIFACTS)
  controls.assertUnchanged.mockReset().mockResolvedValue(undefined)
  controls.construct.mockReset()
}

describe('closed Saki state boundary failures', () => {
  it('retains an already-classified source capture failure', async () => {
    resetArtifactEffects()
    const failure = new SakiMaintenanceError('recovery-required', 'already classified')
    controls.capture.mockRejectedValueOnce(failure)

    await expect(readClosedSakiV2State('fake.sqlite', AbortSignal.timeout(2_000)))
      .rejects.toBe(failure)
  })

  it('wraps a primitive source capture failure as an Error cause', async () => {
    resetArtifactEffects()
    controls.capture.mockRejectedValueOnce('primitive capture failure')

    await expect(readClosedSakiV2State('fake.sqlite', AbortSignal.timeout(2_000)))
      .rejects.toMatchObject({
        code: 'recovery-required',
        cause: { message: 'primitive capture failure' },
      })
  })

  it('verifies captured artifacts even when backend construction fails', async () => {
    resetArtifactEffects()
    const failure = new Error('backend construction failed')
    controls.construct.mockImplementationOnce(() => { throw failure })

    await expect(readClosedSakiV2State('fake.sqlite', AbortSignal.timeout(2_000)))
      .rejects.toBe(failure)
    expect(controls.assertUnchanged).toHaveBeenCalledOnce()
  })

  it('rejects a current backend without closed-unit operations', async () => {
    resetArtifactEffects()
    controls.construct.mockReturnValueOnce({
      kv: { closed: undefined },
      close: async () => undefined,
    })

    await expect(readClosedCurrentSakiState(
      'fake.sqlite',
      currentExpectation(),
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('rejects a backend that loses closed-unit operations before the hybrid check', async () => {
    resetArtifactEffects()
    const descriptor = descriptorOf(sakiControlPlaneV2DomainSpec)
    const inspection = { ...descriptor, tables: [...descriptor.tables].sort() }
    const snapshot: KvUnitSnapshot = {
      global: null,
      tables: Object.fromEntries(Object.keys(sakiControlPlaneV2DomainSpec.tables).map(table => [table, {}])),
    }
    const operations = {
      withReservedUnit: async (
        _name: string,
        _signal: AbortSignal,
        operation: (lease: unknown) => Promise<unknown>,
      ) => await operation({
        inspect: async () => inspection,
        read: async () => snapshot,
      }),
    }
    let access = 0
    const kv = {}
    Object.defineProperty(kv, 'closed', {
      get: () => {
        access += 1
        return access === 1 ? operations : undefined
      },
    })
    controls.construct.mockReturnValueOnce({ kv, close: async () => undefined })

    const failure = await readClosedSakiV2State('fake.sqlite', AbortSignal.timeout(2_000))
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'recovery-required' })
    expect((failure as Error).cause).toMatchObject({
      message: 'SQLite backend does not provide closed-unit operations',
    })
  })
})
