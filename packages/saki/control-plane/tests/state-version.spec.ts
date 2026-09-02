import { describe, expect, it } from 'vitest'
import {
  createStorageGenerationSeal,
  sakiBuildIdSchema,
  sakiStorageGenerationDomainSpec,
  sakiStorageGenerationV1DomainSpec,
  sakiStorageGenerationV2DomainSpec,
  sakiStorageGenerationV3DomainSpec,
  sakiStorageGenerationV4DomainSpec,
  STORAGE_GENERATION_KEY,
  storageGenerationV3SealRecordSchema,
  storageGenerationV4SealRecordSchema,
  storageGenerationV1SealRecordSchema,
  storageGenerationV2SealRecordSchema,
  type SakiBuildId,
  type SakiInstallationId,
  type SakiStorageGenerationId,
} from '../src/index.ts'

const INSTALLATION_ID = 'installation-00000000-0000-4000-8000-000000000001' as SakiInstallationId
const STORAGE_GENERATION_ID = 'storage-generation-00000000-0000-4000-8000-000000000002' as SakiStorageGenerationId
const BUILD_ID = 'saki-build-0.1.0-test' as SakiBuildId

describe('Saki product state versions', () => {
  it('seals one v7 storage generation without widening the historical v3 through v6 seals', () => {
    const seal = createStorageGenerationSeal(INSTALLATION_ID, STORAGE_GENERATION_ID, BUILD_ID)
    expect(seal).toEqual({
      schemaVersion: 5,
      installationId: INSTALLATION_ID,
      storageGenerationId: STORAGE_GENERATION_ID,
      stateVersion: 7,
      createdByBuildId: BUILD_ID,
    })
    expect(sakiStorageGenerationDomainSpec.tables.storage_generation.valueSchema.parse(seal)).toEqual(seal)
    expect(sakiStorageGenerationV1DomainSpec.tables.storage_generation.valueSchema.safeParse(seal).success).toBe(false)
    expect(sakiStorageGenerationV2DomainSpec.tables.storage_generation.valueSchema.safeParse(seal).success).toBe(false)
    expect(sakiStorageGenerationV3DomainSpec.tables.storage_generation.valueSchema.safeParse(seal).success).toBe(false)
    expect(sakiStorageGenerationV4DomainSpec.tables.storage_generation.valueSchema.safeParse(seal).success).toBe(false)
    const historicalV3Seal = storageGenerationV1SealRecordSchema.parse({
      schemaVersion: 1,
      installationId: INSTALLATION_ID,
      storageGenerationId: STORAGE_GENERATION_ID,
      stateVersion: 3,
      createdByBuildId: BUILD_ID,
    })
    const historicalV4Seal = storageGenerationV2SealRecordSchema.parse({
      schemaVersion: 2,
      installationId: INSTALLATION_ID,
      storageGenerationId: STORAGE_GENERATION_ID,
      stateVersion: 4,
      createdByBuildId: BUILD_ID,
    })
    const historicalV5Seal = storageGenerationV3SealRecordSchema.parse({
      schemaVersion: 3,
      installationId: INSTALLATION_ID,
      storageGenerationId: STORAGE_GENERATION_ID,
      stateVersion: 5,
      createdByBuildId: BUILD_ID,
    })
    const historicalV6Seal = storageGenerationV4SealRecordSchema.parse({
      schemaVersion: 4,
      installationId: INSTALLATION_ID,
      storageGenerationId: STORAGE_GENERATION_ID,
      stateVersion: 6,
      createdByBuildId: BUILD_ID,
    })
    expect(sakiStorageGenerationDomainSpec.tables.storage_generation.valueSchema.safeParse(historicalV3Seal).success)
      .toBe(false)
    expect(sakiStorageGenerationDomainSpec.tables.storage_generation.valueSchema.safeParse(historicalV4Seal).success)
      .toBe(false)
    expect(sakiStorageGenerationDomainSpec.tables.storage_generation.valueSchema.safeParse(historicalV5Seal).success)
      .toBe(false)
    expect(sakiStorageGenerationDomainSpec.tables.storage_generation.valueSchema.safeParse(historicalV6Seal).success)
      .toBe(false)
    expect(STORAGE_GENERATION_KEY).toBe('storage-generation')
  })

  it('keeps build provenance bounded without treating it as a compatibility key', () => {
    expect(sakiBuildIdSchema.parse('saki-build-0.1.0+abcdef')).toBe('saki-build-0.1.0+abcdef')
    expect(sakiBuildIdSchema.safeParse('../build').success).toBe(false)
    expect(sakiBuildIdSchema.safeParse('x'.repeat(201)).success).toBe(false)
  })
})
