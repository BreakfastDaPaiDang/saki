/** Complete Saki product-state versions assembled by Installation maintenance. */

import {
  sakiControlPlaneDomainSpec,
  sakiControlPlaneMigrationPlan,
  sakiControlPlaneV2DomainSpec,
  sakiControlPlaneV3DomainSpec,
  sakiControlPlaneV4DomainSpec,
  sakiControlPlaneV5DomainSpec,
  sakiControlPlaneV6DomainSpec,
  sakiControlPlaneV7DomainSpec,
  sakiStorageGenerationDomainSpec,
  sakiStorageGenerationV1DomainSpec,
  sakiStorageGenerationV2DomainSpec,
  sakiStorageGenerationV3DomainSpec,
  sakiStorageGenerationV4DomainSpec,
  sakiStorageGenerationV5DomainSpec,
} from '@breakfastdapaidang/saki-control-plane'
import {
  sakiHostExecutionDomainMigrations,
  sakiHostExecutionDomainSpec,
  sakiHostExecutionV1DomainSpec,
  sakiHostExecutionV2DomainSpec,
} from '@breakfastdapaidang/saki-execution-local'

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
    domains: readonly [typeof sakiControlPlaneV4DomainSpec, typeof sakiStorageGenerationV2DomainSpec]
    controlPlane: typeof sakiControlPlaneV4DomainSpec
    storageGeneration: typeof sakiStorageGenerationV2DomainSpec
  }>
  | Readonly<{
    version: 5
    domains: readonly [
      typeof sakiControlPlaneV5DomainSpec,
      typeof sakiHostExecutionV1DomainSpec,
      typeof sakiStorageGenerationV3DomainSpec,
    ]
    controlPlane: typeof sakiControlPlaneV5DomainSpec
    hostExecution: typeof sakiHostExecutionV1DomainSpec
    storageGeneration: typeof sakiStorageGenerationV3DomainSpec
  }>
  | Readonly<{
    version: 6
    domains: readonly [
      typeof sakiControlPlaneV6DomainSpec,
      typeof sakiHostExecutionV1DomainSpec,
      typeof sakiStorageGenerationV4DomainSpec,
    ]
    controlPlane: typeof sakiControlPlaneV6DomainSpec
    hostExecution: typeof sakiHostExecutionV1DomainSpec
    storageGeneration: typeof sakiStorageGenerationV4DomainSpec
  }>
  | Readonly<{
    version: 7
    domains: readonly [
      typeof sakiControlPlaneV7DomainSpec,
      typeof sakiHostExecutionV2DomainSpec,
      typeof sakiStorageGenerationV5DomainSpec,
    ]
    controlPlane: typeof sakiControlPlaneV7DomainSpec
    hostExecution: typeof sakiHostExecutionV2DomainSpec
    storageGeneration: typeof sakiStorageGenerationV5DomainSpec
  }>
  | Readonly<{
    version: 8
    domains: readonly [
      typeof sakiControlPlaneDomainSpec,
      typeof sakiHostExecutionDomainSpec,
      typeof sakiStorageGenerationDomainSpec,
    ]
    controlPlane: typeof sakiControlPlaneDomainSpec
    hostExecution: typeof sakiHostExecutionDomainSpec
    storageGeneration: typeof sakiStorageGenerationDomainSpec
  }>

/** State-format support owned by code, independently of artifact build provenance. */
export interface SakiStateCapability {
  /** Every product-state version this build can inspect or migrate. */
  readonly readable: readonly SakiStateVersionSpec[]
  /** The sole product-state version this build may create or publish. */
  readonly writable: Extract<SakiStateVersionSpec, { readonly version: 8 }>
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
  domains: Object.freeze([sakiControlPlaneV4DomainSpec, sakiStorageGenerationV2DomainSpec] as const),
  controlPlane: sakiControlPlaneV4DomainSpec,
  storageGeneration: sakiStorageGenerationV2DomainSpec,
}) satisfies SakiStateVersionSpec

const V5_STATE_SPEC = Object.freeze({
  version: 5,
  domains: Object.freeze([
    sakiControlPlaneV5DomainSpec,
    sakiHostExecutionV1DomainSpec,
    sakiStorageGenerationV3DomainSpec,
  ] as const),
  controlPlane: sakiControlPlaneV5DomainSpec,
  hostExecution: sakiHostExecutionV1DomainSpec,
  storageGeneration: sakiStorageGenerationV3DomainSpec,
}) satisfies SakiStateVersionSpec

const V6_STATE_SPEC = Object.freeze({
  version: 6,
  domains: Object.freeze([
    sakiControlPlaneV6DomainSpec,
    sakiHostExecutionV1DomainSpec,
    sakiStorageGenerationV4DomainSpec,
  ] as const),
  controlPlane: sakiControlPlaneV6DomainSpec,
  hostExecution: sakiHostExecutionV1DomainSpec,
  storageGeneration: sakiStorageGenerationV4DomainSpec,
}) satisfies SakiStateVersionSpec

const V7_STATE_SPEC = Object.freeze({
  version: 7,
  domains: Object.freeze([
    sakiControlPlaneV7DomainSpec,
    sakiHostExecutionV2DomainSpec,
    sakiStorageGenerationV5DomainSpec,
  ] as const),
  controlPlane: sakiControlPlaneV7DomainSpec,
  hostExecution: sakiHostExecutionV2DomainSpec,
  storageGeneration: sakiStorageGenerationV5DomainSpec,
}) satisfies SakiStateVersionSpec

const V8_STATE_SPEC = Object.freeze({
  version: 8,
  domains: Object.freeze([
    sakiControlPlaneDomainSpec,
    sakiHostExecutionDomainSpec,
    sakiStorageGenerationDomainSpec,
  ] as const),
  controlPlane: sakiControlPlaneDomainSpec,
  hostExecution: sakiHostExecutionDomainSpec,
  storageGeneration: sakiStorageGenerationDomainSpec,
}) satisfies SakiStateVersionSpec

/** Current Saki state-format capability; build ids are deliberately absent. */
export const sakiStateCapability: SakiStateCapability = Object.freeze({
  readable: Object.freeze([
    V2_STATE_SPEC,
    V3_STATE_SPEC,
    V4_STATE_SPEC,
    V5_STATE_SPEC,
    V6_STATE_SPEC,
    V7_STATE_SPEC,
    V8_STATE_SPEC,
  ]),
  writable: V8_STATE_SPEC,
  resolveReadable: (version: number) => {
    if (version === V2_STATE_SPEC.version) return V2_STATE_SPEC
    if (version === V3_STATE_SPEC.version) return V3_STATE_SPEC
    if (version === V4_STATE_SPEC.version) return V4_STATE_SPEC
    if (version === V5_STATE_SPEC.version) return V5_STATE_SPEC
    if (version === V6_STATE_SPEC.version) return V6_STATE_SPEC
    if (version === V7_STATE_SPEC.version) return V7_STATE_SPEC
    if (version === V8_STATE_SPEC.version) return V8_STATE_SPEC
    return undefined
  },
})

/** Control-plane migration chain used when any retained v2-v7 format advances to writable v8. */
export const sakiStateControlPlaneMigrationPlan: typeof sakiControlPlaneMigrationPlan =
  sakiControlPlaneMigrationPlan

/** Host Execution migration used when a retained v5-v7 format advances to writable v8. */
export const sakiStateHostExecutionMigrationPlan: typeof sakiHostExecutionDomainMigrations =
  sakiHostExecutionDomainMigrations
