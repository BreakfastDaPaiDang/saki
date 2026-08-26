/** Product-level Saki state versions and the storage-generation seal. @module @breakfastdapaidang/saki-control-plane/state-version */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import {
  sakiBuildIdSchema,
  sakiInstallationIdSchema,
  sakiStorageGenerationIdSchema,
} from './ids.ts'
import {
  sakiControlPlaneMigrationPlan,
  sakiControlPlaneV2DomainSpec,
  sakiControlPlaneV3DomainSpec,
} from './migration.ts'
import { sakiControlPlaneDomainSpec } from './spec.ts'
import type {
  SakiBuildId,
  SakiInstallationId,
  SakiStorageGenerationId,
} from './types.ts'

/** Stable key of the one storage-generation seal record. */
export const STORAGE_GENERATION_KEY = 'storage-generation' as const

/** Exact historical singleton that binds a v3 database to its Installation and physical generation. */
export const storageGenerationV1SealRecordSchema = z.object({
  schemaVersion: z.literal(1),
  installationId: sakiInstallationIdSchema,
  storageGenerationId: sakiStorageGenerationIdSchema,
  stateVersion: z.literal(3),
  createdByBuildId: sakiBuildIdSchema,
}).strict()

/** Required singleton that binds a v4 database to its Installation and physical generation. */
export const storageGenerationSealRecordSchema = z.object({
  schemaVersion: z.literal(2),
  installationId: sakiInstallationIdSchema,
  storageGenerationId: sakiStorageGenerationIdSchema,
  stateVersion: z.literal(4),
  createdByBuildId: sakiBuildIdSchema,
}).strict()

/** Parsed durable storage-generation seal. */
export type StorageGenerationSealRecord = z.infer<typeof storageGenerationSealRecordSchema>

/** Parsed exact historical v3 storage-generation seal. */
export type StorageGenerationV1SealRecord = z.infer<typeof storageGenerationV1SealRecordSchema>

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

/** Separate required current storage-generation identity domain. */
export const sakiStorageGenerationDomainSpec = defineDomain({
  name: 'saki_storage_generation',
  version: 2,
  tables: {
    storage_generation: domainTable<typeof STORAGE_GENERATION_KEY, StorageGenerationSealRecord>(
      storageGenerationSealRecordSchema,
    ),
  },
})

/** One complete readable Saki product-state format. */
export type SakiStateVersionSpec =
  | Readonly<{
    version: 2
    domains: readonly [typeof sakiControlPlaneV2DomainSpec]
    controlPlane: typeof sakiControlPlaneV2DomainSpec
  }>
  | Readonly<{
    version: 3
    domains: readonly [typeof sakiControlPlaneV3DomainSpec, typeof sakiStorageGenerationV1DomainSpec]
    controlPlane: typeof sakiControlPlaneV3DomainSpec
    storageGeneration: typeof sakiStorageGenerationV1DomainSpec
  }>
  | Readonly<{
    version: 4
    domains: readonly [typeof sakiControlPlaneDomainSpec, typeof sakiStorageGenerationDomainSpec]
    controlPlane: typeof sakiControlPlaneDomainSpec
    storageGeneration: typeof sakiStorageGenerationDomainSpec
  }>

/** State-format support owned by code, independently of artifact build provenance. */
export interface SakiStateCapability {
  /** Every product-state version this build can inspect or migrate. */
  readonly readable: readonly SakiStateVersionSpec[]
  /** The sole product-state version this build may create or publish. */
  readonly writable: Extract<SakiStateVersionSpec, { readonly version: 4 }>
  /**
   * Resolve one readable product-state format.
   * @param version - untrusted manifest or backup state version.
   * @returns the exact readable format, or `undefined` when this build cannot read it.
   */
  resolveReadable(version: number): SakiStateVersionSpec | undefined
}

const V2_STATE_SPEC = Object.freeze({
  version: 2,
  domains: Object.freeze([sakiControlPlaneV2DomainSpec] as const),
  controlPlane: sakiControlPlaneV2DomainSpec,
}) satisfies SakiStateVersionSpec

const V3_STATE_SPEC = Object.freeze({
  version: 3,
  domains: Object.freeze([sakiControlPlaneV3DomainSpec, sakiStorageGenerationV1DomainSpec] as const),
  controlPlane: sakiControlPlaneV3DomainSpec,
  storageGeneration: sakiStorageGenerationV1DomainSpec,
}) satisfies SakiStateVersionSpec

const V4_STATE_SPEC = Object.freeze({
  version: 4,
  domains: Object.freeze([sakiControlPlaneDomainSpec, sakiStorageGenerationDomainSpec] as const),
  controlPlane: sakiControlPlaneDomainSpec,
  storageGeneration: sakiStorageGenerationDomainSpec,
}) satisfies SakiStateVersionSpec

/** Current Saki state-format capability; build ids are deliberately absent. */
export const sakiStateCapability: SakiStateCapability = Object.freeze({
  readable: Object.freeze([V2_STATE_SPEC, V3_STATE_SPEC, V4_STATE_SPEC]),
  writable: V4_STATE_SPEC,
  resolveReadable: (version: number) => {
    if (version === V2_STATE_SPEC.version) return V2_STATE_SPEC
    if (version === V3_STATE_SPEC.version) return V3_STATE_SPEC
    if (version === V4_STATE_SPEC.version) return V4_STATE_SPEC
    return undefined
  },
})

/** Migration plan used when a retained v2 or v3 format advances to writable v4. */
export const sakiStateControlPlaneMigrationPlan = sakiControlPlaneMigrationPlan

/**
 * Create the exact singleton stored in a new v4 generation.
 * @param installationId - Installation retained across physical generations.
 * @param storageGenerationId - new physical generation identity.
 * @param createdByBuildId - provenance of the creating build.
 * @returns strict seal record for `saki_storage_generation@2`.
 */
export function createStorageGenerationSeal(
  installationId: SakiInstallationId,
  storageGenerationId: SakiStorageGenerationId,
  createdByBuildId: SakiBuildId,
): StorageGenerationSealRecord {
  return storageGenerationSealRecordSchema.parse({
    schemaVersion: 2,
    installationId,
    storageGenerationId,
    stateVersion: 4,
    createdByBuildId,
  })
}
