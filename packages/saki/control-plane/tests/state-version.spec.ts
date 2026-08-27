import { describe, expect, it } from 'vitest'
import {
  createStorageGenerationSeal,
  sakiBuildIdSchema,
  sakiStateCapability,
  sakiStorageGenerationDomainSpec,
  sakiStorageGenerationV1DomainSpec,
  STORAGE_GENERATION_KEY,
  storageGenerationV1SealRecordSchema,
  type SakiBuildId,
  type SakiInstallationId,
  type SakiStorageGenerationId,
} from '../src/index.ts'

const INSTALLATION_ID = 'installation-00000000-0000-4000-8000-000000000001' as SakiInstallationId
const STORAGE_GENERATION_ID = 'storage-generation-00000000-0000-4000-8000-000000000002' as SakiStorageGenerationId
const BUILD_ID = 'saki-build-0.1.0-test' as SakiBuildId

describe('Saki product state versions', () => {
  it('declares exact readable v2, v3, and v4 formats with only v4 writable', () => {
    expect(sakiStateCapability.readable.map(spec => spec.version)).toEqual([2, 3, 4])
    expect(sakiStateCapability.resolveReadable(1)).toBeUndefined()
    expect(sakiStateCapability.resolveReadable(2)?.domains.map(domain => [domain.name, domain.version])).toEqual([
      ['saki_control_plane', 2],
    ])
    expect(sakiStateCapability.resolveReadable(3)?.domains.map(domain => [domain.name, domain.version])).toEqual([
      ['saki_control_plane', 3],
      ['saki_storage_generation', 1],
    ])
    expect(sakiStateCapability.resolveReadable(4)?.domains.map(domain => [domain.name, domain.version])).toEqual([
      ['saki_control_plane', 4],
      ['saki_storage_generation', 2],
    ])
    expect(sakiStateCapability.writable.version).toBe(4)
    expect(sakiStateCapability.writable.storageGeneration).toBe(sakiStorageGenerationDomainSpec)
    expect('buildId' in sakiStateCapability).toBe(false)
  })

  it('seals one v4 storage generation without widening the historical v3 seal', () => {
    const seal = createStorageGenerationSeal(INSTALLATION_ID, STORAGE_GENERATION_ID, BUILD_ID)
    expect(seal).toEqual({
      schemaVersion: 2,
      installationId: INSTALLATION_ID,
      storageGenerationId: STORAGE_GENERATION_ID,
      stateVersion: 4,
      createdByBuildId: BUILD_ID,
    })
    expect(sakiStorageGenerationDomainSpec.tables.storage_generation.valueSchema.parse(seal)).toEqual(seal)
    expect(sakiStorageGenerationV1DomainSpec.tables.storage_generation.valueSchema.safeParse(seal).success).toBe(false)
    const historicalSeal = storageGenerationV1SealRecordSchema.parse({
      schemaVersion: 1,
      installationId: INSTALLATION_ID,
      storageGenerationId: STORAGE_GENERATION_ID,
      stateVersion: 3,
      createdByBuildId: BUILD_ID,
    })
    expect(sakiStorageGenerationDomainSpec.tables.storage_generation.valueSchema.safeParse(historicalSeal).success)
      .toBe(false)
    expect(STORAGE_GENERATION_KEY).toBe('storage-generation')
    expect(Object.keys(sakiStateCapability.writable.controlPlane.tables)).not.toContain('storage_generation')
  })

  it('keeps build provenance bounded without treating it as a compatibility key', () => {
    expect(sakiBuildIdSchema.parse('saki-build-0.1.0+abcdef')).toBe('saki-build-0.1.0+abcdef')
    expect(sakiBuildIdSchema.safeParse('../build').success).toBe(false)
    expect(sakiBuildIdSchema.safeParse('x'.repeat(201)).success).toBe(false)
  })
})
