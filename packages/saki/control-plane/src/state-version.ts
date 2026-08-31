/** Storage-generation seal formats owned by the Saki control plane. @module @breakfastdapaidang/saki-control-plane/state-version */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import {
  sakiBuildIdSchema,
  sakiInstallationIdSchema,
  sakiStorageGenerationIdSchema,
} from './ids.ts'
import { v4Source } from './migration-v4-source.ts'
import type {
  SakiBuildId,
  SakiInstallationId,
  SakiStorageGenerationId,
} from './types.ts'

/** Stable key of the one storage-generation seal record. */
export const STORAGE_GENERATION_KEY = 'storage-generation' as const

const {
  V4_STORAGE_GENERATION_KEY,
  v4BuildIdSchema,
  v4InstallationIdSchema,
  v4StorageGenerationIdSchema,
} = v4Source

/** Exact historical singleton that binds a v3 database to its Installation and physical generation. */
export const storageGenerationV1SealRecordSchema = z.object({
  schemaVersion: z.literal(1),
  installationId: sakiInstallationIdSchema,
  storageGenerationId: sakiStorageGenerationIdSchema,
  stateVersion: z.literal(3),
  createdByBuildId: sakiBuildIdSchema,
}).strict()

/** Exact historical singleton that binds a v4 database to its Installation and physical generation. */
export const storageGenerationV2SealRecordSchema = z.object({
  schemaVersion: z.literal(2),
  installationId: v4InstallationIdSchema,
  storageGenerationId: v4StorageGenerationIdSchema,
  stateVersion: z.literal(4),
  createdByBuildId: v4BuildIdSchema,
}).strict()

/** Exact historical singleton that binds a v5 database to its Installation and physical generation. */
export const storageGenerationV3SealRecordSchema = z.object({
  schemaVersion: z.literal(3),
  installationId: sakiInstallationIdSchema,
  storageGenerationId: sakiStorageGenerationIdSchema,
  stateVersion: z.literal(5),
  createdByBuildId: sakiBuildIdSchema,
}).strict()

/** Required singleton that binds a current v6 database to its Installation and physical generation. */
export const storageGenerationSealRecordSchema = z.object({
  schemaVersion: z.literal(4),
  installationId: sakiInstallationIdSchema,
  storageGenerationId: sakiStorageGenerationIdSchema,
  stateVersion: z.literal(6),
  createdByBuildId: sakiBuildIdSchema,
}).strict()

/** Parsed current storage-generation seal. */
export type StorageGenerationSealRecord = z.infer<typeof storageGenerationSealRecordSchema>

/** Parsed exact historical v3 storage-generation seal. */
export type StorageGenerationV1SealRecord = z.infer<typeof storageGenerationV1SealRecordSchema>

/** Parsed exact historical v4 storage-generation seal. */
export type StorageGenerationV2SealRecord = z.infer<typeof storageGenerationV2SealRecordSchema>

/** Parsed exact historical v5 storage-generation seal. */
export type StorageGenerationV3SealRecord = z.infer<typeof storageGenerationV3SealRecordSchema>

/** Exact storage-generation identity domain retained for v3 reads and upgrades. */
export const sakiStorageGenerationV1DomainSpec = defineDomain({
  name: 'saki_storage_generation',
  version: 1,
  tables: {
    storage_generation: domainTable<typeof STORAGE_GENERATION_KEY, StorageGenerationV1SealRecord>(
      storageGenerationV1SealRecordSchema,
    ),
  },
})

/** Exact storage-generation identity domain retained for v4 reads and upgrades. */
export const sakiStorageGenerationV2DomainSpec = defineDomain({
  name: 'saki_storage_generation',
  version: 2,
  tables: {
    storage_generation: domainTable<typeof V4_STORAGE_GENERATION_KEY, StorageGenerationV2SealRecord>(
      storageGenerationV2SealRecordSchema,
    ),
  },
})

/** Exact storage-generation identity domain retained for v5 reads and upgrades. */
export const sakiStorageGenerationV3DomainSpec = defineDomain({
  name: 'saki_storage_generation',
  version: 3,
  tables: {
    storage_generation: domainTable<typeof STORAGE_GENERATION_KEY, StorageGenerationV3SealRecord>(
      storageGenerationV3SealRecordSchema,
    ),
  },
})

/** Separate required current storage-generation identity domain. */
export const sakiStorageGenerationDomainSpec = defineDomain({
  name: 'saki_storage_generation',
  version: 4,
  tables: {
    storage_generation: domainTable<typeof STORAGE_GENERATION_KEY, StorageGenerationSealRecord>(
      storageGenerationSealRecordSchema,
    ),
  },
})

/**
 * Create the exact singleton stored in a new v6 generation.
 * @param installationId - Installation retained across physical generations.
 * @param storageGenerationId - new physical generation identity.
 * @param createdByBuildId - provenance of the creating build.
 * @returns strict seal record for `saki_storage_generation@4`.
 */
export function createStorageGenerationSeal(
  installationId: SakiInstallationId,
  storageGenerationId: SakiStorageGenerationId,
  createdByBuildId: SakiBuildId,
): StorageGenerationSealRecord {
  return storageGenerationSealRecordSchema.parse({
    schemaVersion: 4,
    installationId,
    storageGenerationId,
    stateVersion: 6,
    createdByBuildId,
  })
}
