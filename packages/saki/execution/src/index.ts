/** Host Execution Service Definition for Saki. @module @breakfastdapaidang/saki-execution */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  InspectProjectRequest,
  InspectProjectResult,
  InspectProjectSelectionRequest,
  InspectProjectSelectionResult,
  ActiveHostProjectBinding,
  HostOperationAcceptance,
  HostOperationAdmissionSource,
  HostOperationCancellationReason,
  HostOperationChange,
  HostOperationChangedDisposer,
  HostOperationKind,
  HostOperationReceipt,
  HostOperationReference,
  HostOperationRequest,
  HostOperationSnapshot,
  HostOperationStartResult,
  ReadProjectDiffRequest,
  ReadProjectDiffResult,
} from './types.ts'

export { canonicalDigest, compareCanonicalText, exactBytesDigest } from './canonical.ts'
export { HostOperationAcceptance } from './types.ts'
export {
  computeProjectGitChangeFingerprint,
  computeProjectGitChangeId,
  computeProjectGitStatusFingerprint,
  computeProjectGitStatusSeedDigest,
  computeProjectInspectionFingerprint,
  inheritedChangeBaselineIdentityMaterial,
  projectGitStatusFingerprintMaterial,
  projectGitStatusSeedMaterial,
  projectInspectionFingerprintMaterial,
  projectInspectionWorkspaceIndependentMaterial,
} from './fingerprint.ts'

export {
  compareRepositoryRelativeGitPaths,
  compareSafeGitRemoteObservations,
  deriveGitHubRepositoryCandidates,
  isAbsoluteHostPath,
  isSafeDisplayLocation,
  isGitObjectId,
  isSafeGitBranchName,
  isSafeGitRef,
  isNormalizedRemoteCoordinate,
  isRepositoryRelativeGitPath,
  MAX_DISPLAY_LOCATION_CHARS,
  MAX_GIT_REF_CHARS,
  MAX_INHERITED_BASELINE_ENTRIES,
  MAX_INVENTORY_ENTRIES,
  MAX_PROJECT_GIT_DIFF_CURSOR_CHARS,
  MAX_PROJECT_GIT_DIFF_LINE_UTF8_BYTES,
  MAX_PROJECT_GIT_DIFF_PAGE_LINES,
  MAX_PROJECT_GIT_DIFF_PAGE_UTF8_BYTES,
  MAX_PROJECT_GIT_DIFF_TOTAL_LINES,
  MAX_PROJECT_GIT_DIFF_TOTAL_UTF8_BYTES,
  MAX_PROJECT_GIT_STATUS_CHANGES,
  MAX_PROJECT_GIT_STATUS_PATH_BYTES,
  MAX_REMOTE_COORDINATE_CHARS,
  MAX_SAFE_REMOTES,
  MAX_TRUSTED_PATH_CHARS,
  inheritedChangeBaselineBoundsSchema,
  completeInheritedChangeBaselineSchema,
  inheritedChangeBaselineEntrySchema,
  inheritedChangeBaselineObservedLimitsSchema,
  inheritedChangeBaselineSchema,
  inheritedCurrentWorktreeEvidenceSchema,
  activeHostProjectBindingSchema,
  inspectProjectRequestSchema,
  inspectProjectResultSchema,
  inspectProjectSelectionResultSchema,
  projectGitDiffCursorSchema,
  projectGitDiffLayerSchema,
  projectGitDiffPageSchema,
  projectGitIndexEvidenceSchema,
  projectGitChangeSchema,
  projectGitChangeFingerprintSchema,
  projectGitChangeIdSchema,
  projectGitHeadSchema,
  projectGitMutationAvailabilitySchema,
  projectGitPatchFingerprintSchema,
  projectGitStatusFingerprintSchema,
  projectGitStatusObservationSchema,
  projectGitWorktreeFingerprintSchema,
  projectInspectionFingerprintSchema,
  projectSelectionInspectionSchema,
  projectSelectionProjectionSchema,
  safeGitRemoteObservationSchema,
  safeGitRemoteObservationKey,
  readProjectDiffRequestSchema,
  readProjectDiffOperationRequestSchema,
  readProjectDiffResultSchema,
  appliedProjectGitChangeSchema,
  commitHostOperationRequestSchema,
  commitHostOperationResultSchema,
  hostGitMutationPreconditionSchema,
  hostOperationChangeSchema,
  hostOperationIdSchema,
  hostOperationPreparationSchema,
  hostOperationReferenceSchema,
  hostOperationRequestFingerprintSchema,
  hostOperationRequestSchema,
  hostOperationSnapshotSchema,
  hostOperationStartResultSchema,
  hostOperationSourceSchema,
  MAX_HOST_OPERATION_COMMIT_MESSAGE_UTF8_BYTES,
  MAX_HOST_OPERATION_SELECTED_CHANGES,
  sakiControlIntentIdSchema,
  selectedProjectGitChangeSchema,
  stageFilesHostOperationRequestSchema,
  stageFilesHostOperationResultSchema,
  unstageFilesHostOperationRequestSchema,
  unstageFilesHostOperationResultSchema,
  sakiResourceBindingIdSchema,
  trustedProjectSelectionObservationSchema,
} from './schemas.ts'

export type {
  ActiveHostProjectBinding,
  AppliedProjectGitChange,
  CommitHostOperationRequest,
  CommitHostOperationResult,
  CompleteInheritedChangeBaseline,
  InheritedChangeBaseline,
  InheritedChangeBaselineBounds,
  InheritedChangeBaselineEntry,
  InheritedChangeBaselineObservedLimits,
  InheritedChangeBaselineUnavailableReason,
  InheritedCurrentWorktreeEvidence,
  InheritedGitObjectEvidence,
  InheritedGitObjectSlot,
  InspectProjectFailureReason,
  InspectProjectRequest,
  InspectProjectResult,
  InspectProjectSelectionRequest,
  InspectProjectSelectionResult,
  HostGitMutationPrecondition,
  HostOperationAdmissionDecision,
  HostOperationAdmissionEvidence,
  HostOperationAdmissionExpectation,
  HostOperationAdmissionSource,
  HostOperationCancellationReason,
  HostOperationChange,
  HostOperationChangedDisposer,
  HostOperationFailure,
  HostOperationId,
  HostOperationKind,
  HostOperationPreparation,
  HostOperationReceipt,
  HostOperationReconciliationReason,
  HostOperationReference,
  HostOperationRequest,
  HostOperationRequestFingerprint,
  HostOperationRequestMap,
  HostOperationResult,
  HostOperationSnapshot,
  HostOperationStartResult,
  HostOperationSource,
  ProjectGitChange,
  ProjectGitChangeAttribution,
  ProjectGitChangeFingerprint,
  ProjectGitChangeId,
  ProjectGitCommitParent,
  ProjectGitCommitSignature,
  ProjectGitCommitTarget,
  ProjectGitBranch,
  ProjectGitDiffCursor,
  ProjectGitDiffFailureReason,
  ProjectGitDiffLayer,
  ProjectGitDiffPage,
  ProjectGitHead,
  ProjectGitIndexEvidence,
  ProjectGitFileMode,
  ProjectGitMutationAvailability,
  ProjectGitMutationBlocker,
  ProjectGitObjectSlot,
  ProjectGitOrdinaryChange,
  ProjectGitPatchFingerprint,
  ProjectGitStatusFingerprint,
  ProjectGitStatusObservation,
  ProjectGitSubmoduleStatus,
  ProjectGitUnmergedChange,
  ProjectGitUntrackedChange,
  ProjectGitUpstream,
  ProjectGitWorktreeFingerprint,
  ProjectGitWorktreeEvidence,
  ProjectInspectionFingerprint,
  ProjectSelectionInspection,
  ProjectSelectionProjection,
  ProjectSelectionRejectionReason,
  ReadProjectDiffOperationRequest,
  ReadProjectDiffRequest,
  ReadProjectDiffResult,
  RepositoryAdministrativeIdentity,
  RepositoryComparisonObservation,
  SafeGitRemoteObservation,
  SakiControlIntentId,
  SakiHostExecutionOperationMap,
  SakiHostExecutionRequest,
  SakiHostExecutionResult,
  SakiHostId,
  SakiResourceBindingId,
  SelectedProjectGitChange,
  StageFilesHostOperationRequest,
  StageFilesHostOperationResult,
  TrustedProjectSelectionObservation,
  UnavailableInheritedChangeBaseline,
  UnstageFilesHostOperationRequest,
  UnstageFilesHostOperationResult,
  WorkspaceId,
} from './types.ts'

export type {
  ProjectGitChangeFingerprintMaterial,
  InheritedChangeBaselineIdentityMaterial,
  ProjectGitChangeMaterial,
  ProjectGitStatusFingerprintMaterial,
  ProjectGitStatusSeedMaterial,
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

  /**
   * Revalidate the Host resource named by one Resource Binding and return
   * complete bounded Git status without changing the repository.
   * @param request - revisioned binding and registration-time attribution evidence.
   * @param signal - required caller lifetime and cancellation.
   * @returns browser-safe structured status or one bounded safe failure.
   */
  abstract inspectProject(
    request: InspectProjectRequest,
    signal: AbortSignal,
  ): Promise<InspectProjectResult>

  /**
   * Read one bounded page of a stable file-scoped Diff without accepting a
   * caller-controlled path or Git command.
   * @param binding - active Resource Binding evidence from the authorized control plane.
   * @param request - expected status, opaque change id, layer, and optional continuation.
   * @param signal - required caller lifetime and cancellation.
   * @returns one internally consistent Diff page or a bounded safe failure.
   */
  abstract readDiff(
    binding: ActiveHostProjectBinding,
    request: ReadProjectDiffRequest,
    signal: AbortSignal,
  ): Promise<ReadProjectDiffResult>

  /**
   * Durably create or replay one inert Host Operation before any external
   * effect and bind an ephemeral current-admission callback to its receipt.
   * @param request - complete immutable operation request and trusted Git preconditions.
   * @param admissionSource - same-process callback used only at the effect boundary.
   * @param signal - caller lifetime for preparation; aborting it is not durable cancellation.
   * @returns the durable preparation plus a Provider-owned nominal acceptance, or a bounded rejection.
   */
  abstract prepareOperation<K extends HostOperationKind>(
    request: HostOperationRequest<K>,
    admissionSource: HostOperationAdmissionSource,
    signal: AbortSignal,
  ): Promise<HostOperationReceipt<K>>

  /**
   * Start or resume one prepared operation after checking its Provider-owned
   * acceptance and current Binding write admission.
   * @param operation - stable reference returned by preparation.
   * @param acceptance - non-serializable Provider-owned acceptance from the matching receipt.
   * @param signal - caller lifetime for this start attempt; aborting it is not durable cancellation.
   * @returns the current durable snapshot and whether current admission allowed execution.
   */
  abstract startOperation<K extends HostOperationKind>(
    operation: HostOperationReference<K>,
    acceptance: HostOperationAcceptance,
    signal: AbortSignal,
  ): Promise<HostOperationStartResult<K>>

  /**
   * Inspect and recover one durable Host Operation without starting a new external effect.
   * @param operation - stable Provider-routed reference.
   * @param signal - required caller lifetime and cancellation.
   * @returns the current durable snapshot after evidence-driven lifecycle advancement.
   */
  abstract inspectOperation<K extends HostOperationKind>(
    operation: HostOperationReference<K>,
    signal: AbortSignal,
  ): Promise<HostOperationSnapshot<K>>

  /**
   * Request durable cancellation without treating caller cancellation as an
   * operation outcome.
   * @param operation - stable Provider-routed reference.
   * @param reason - closed durable product reason.
   * @param signal - caller lifetime for the cancellation request.
   * @returns the current durable operation snapshot after cancellation handling.
   */
  abstract cancelOperation<K extends HostOperationKind>(
    operation: HostOperationReference<K>,
    reason: HostOperationCancellationReason,
    signal: AbortSignal,
  ): Promise<HostOperationSnapshot<K>>

  /**
   * Subscribe to post-commit Host Operation revision changes.
   * @param listener - contained wake-up listener; snapshots remain authoritative.
   * @returns disposer for this subscription.
   */
  abstract onChanged(listener: (change: HostOperationChange) => void): HostOperationChangedDisposer
}

export default SakiHostExecution
