/** Host Execution Service Definition for Saki. @module @breakfastdapaidang/saki-execution */

import { Context, Service } from '@deepseek-ai/cordis'
import type { InspectProjectSelectionRequest, InspectProjectSelectionResult } from './types.ts'

export { canonicalDigest, compareCanonicalText, exactBytesDigest } from './canonical.ts'
export {
  computeProjectInspectionFingerprint,
  inheritedChangeBaselineIdentityMaterial,
  projectInspectionFingerprintMaterial,
  projectInspectionWorkspaceIndependentMaterial,
} from './fingerprint.ts'

export {
  compareSafeGitRemoteObservations,
  deriveGitHubRepositoryCandidates,
  isAbsoluteHostPath,
  isSafeDisplayLocation,
  isGitObjectId,
  isSafeGitBranchName,
  isSafeGitRef,
  isNormalizedRemoteCoordinate,
  MAX_DISPLAY_LOCATION_CHARS,
  MAX_GIT_REF_CHARS,
  MAX_INHERITED_BASELINE_ENTRIES,
  MAX_INVENTORY_ENTRIES,
  MAX_REMOTE_COORDINATE_CHARS,
  MAX_SAFE_REMOTES,
  MAX_TRUSTED_PATH_CHARS,
  inheritedChangeBaselineBoundsSchema,
  inheritedChangeBaselineEntrySchema,
  inheritedChangeBaselineObservedLimitsSchema,
  inheritedChangeBaselineSchema,
  inheritedCurrentWorktreeEvidenceSchema,
  inspectProjectSelectionResultSchema,
  projectInspectionFingerprintSchema,
  projectSelectionInspectionSchema,
  projectSelectionProjectionSchema,
  safeGitRemoteObservationSchema,
  safeGitRemoteObservationKey,
  trustedProjectSelectionObservationSchema,
} from './schemas.ts'

export type {
  CompleteInheritedChangeBaseline,
  InheritedChangeBaseline,
  InheritedChangeBaselineBounds,
  InheritedChangeBaselineEntry,
  InheritedChangeBaselineObservedLimits,
  InheritedChangeBaselineUnavailableReason,
  InheritedCurrentWorktreeEvidence,
  InheritedGitObjectEvidence,
  InheritedGitObjectSlot,
  InspectProjectSelectionRequest,
  InspectProjectSelectionResult,
  ProjectInspectionFingerprint,
  ProjectSelectionInspection,
  ProjectSelectionProjection,
  ProjectSelectionRejectionReason,
  RepositoryAdministrativeIdentity,
  RepositoryComparisonObservation,
  SafeGitRemoteObservation,
  SakiHostExecutionOperationMap,
  SakiHostExecutionRequest,
  SakiHostExecutionResult,
  SakiHostId,
  TrustedProjectSelectionObservation,
  UnavailableInheritedChangeBaseline,
  WorkspaceId,
} from './types.ts'

export type {
  InheritedChangeBaselineIdentityMaterial,
  ProjectInspectionFingerprintMaterial,
  ProjectInspectionWorkspaceObservation,
  ProjectInspectionWorkspaceIndependentMaterial,
} from './fingerprint.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host-owned read-only project-selection inspection used by Saki Consumers. */
    sakiHostExecution: SakiHostExecution
  }
}

/**
 * Host Execution capability. Providers resolve untrusted locators in their
 * own execution world; control-plane Consumers own product policy and state.
 */
export abstract class SakiHostExecution extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sakiHostExecution')
  }

  /**
   * Resolve and inspect one selected directory without creating a Workspace or
   * changing repository state.
   * @param request - selected Host and untrusted directory locator.
   * @param signal - required caller lifetime and cancellation.
   * @returns detached safe evidence plus the trusted Host observation, or a bounded rejection.
   */
  abstract inspectProjectSelection(
    request: InspectProjectSelectionRequest,
    signal: AbortSignal,
  ): Promise<InspectProjectSelectionResult>
}

export default SakiHostExecution
