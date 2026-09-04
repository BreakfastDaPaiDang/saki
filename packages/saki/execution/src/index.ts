/** Host Execution Service Definition for Saki. @module @breakfastdapaidang/saki-execution */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  InspectProjectRequest,
  InspectProjectResult,
  InspectProjectCommitRequest,
  InspectProjectCommitResult,
  InspectProjectSelectionRequest,
  InspectProjectSelectionResult,
  InspectInterventionOpeningRequest,
  InterventionOpeningEvidence,
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
  StartAgentRunHostOperationRequest,
} from './types.ts'

export { canonicalDigest, compareCanonicalText, exactBytesDigest } from './canonical.ts'
export { HostOperationAcceptance } from './types.ts'
export {
  computeProjectGitChangeFingerprint,
  computeProjectGitChangeId,
  computeProjectGitStatusFingerprint,
  computeProjectGitStatusSeedDigest,
  computeProjectInspectionFingerprint,
  computeStartAgentRunPayloadDigest,
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
  inspectProjectCommitRequestSchema,
  inspectProjectCommitResultSchema,
  inspectProjectSelectionResultSchema,
  inspectInterventionOpeningRequestSchema,
  interventionOpeningEvidenceSchema,
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
  pushBranchHostOperationRequestSchema,
  pushBranchHostOperationResultSchema,
  gitCredentialHelperIdSchema,
  controlIntentHostOperationSourceSchema,
  executionDispatchHostOperationSourceSchema,
  hostGitMutationPreconditionSchema,
  hostOperationChangeSchema,
  hostOperationIdSchema,
  hostOperationPreparationSchema,
  hostOperationReferenceSchema,
  hostOperationRequestFingerprintSchema,
  hostOperationRequestSchema,
  hostOperationRequestV2Schema,
  hostOperationSnapshotSchema,
  hostOperationStartResultSchema,
  hostOperationSourceSchema,
  MAX_HOST_OPERATION_COMMIT_MESSAGE_UTF8_BYTES,
  MAX_HOST_OPERATION_SELECTED_CHANGES,
  MAX_START_AGENT_RUN_INPUT_UTF8_BYTES,
  sakiAgentRunIdSchema,
  sakiAgentRunMessageSourceSchema,
  sakiAgentProfileIdSchema,
  sakiControlIntentActorAttributionSchema,
  sakiControlIntentIdSchema,
  sakiExecutionDispatchIdSchema,
  sakiInterventionAnswerMessageSourceSchema,
  sakiInterventionRequestIdSchema,
  sakiWorkSessionIdSchema,
  selectedProjectGitChangeSchema,
  stageFilesHostOperationRequestSchema,
  stageFilesHostOperationResultSchema,
  startAgentRunHostOperationRequestSchema,
  startAgentRunHostOperationRequestV2Schema,
  startAgentRunHostOperationResultSchema,
  startAgentRunInputMessageSchema,
  startAgentRunInputMessageV2Schema,
  startAgentRunMessageSourceSchema,
  startAgentRunProfileSchema,
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
  GitHubRepositoryCoordinates,
  GitCredentialHelperId,
  GitRemoteBranchState,
  CompleteInheritedChangeBaseline,
  ControlIntentHostOperationSource,
  ExecutionDispatchHostOperationSource,
  InheritedChangeBaseline,
  InheritedChangeBaselineBounds,
  InheritedChangeBaselineEntry,
  InheritedChangeBaselineObservedLimits,
  InheritedChangeBaselineUnavailableReason,
  InheritedCurrentWorktreeEvidence,
  InheritedGitObjectEvidence,
  InheritedGitObjectSlot,
  InspectInterventionOpeningRequest,
  InterventionOpeningEvidence,
  InterventionOpeningExpectedToolResult,
  InspectProjectFailureReason,
  InspectProjectRequest,
  InspectProjectResult,
  InspectProjectCommitRequest,
  InspectProjectCommitResult,
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
  HostOperationRequestV2,
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
  PushBranchHostOperationRequest,
  PushBranchHostOperationResult,
  ReadProjectDiffOperationRequest,
  ReadProjectDiffRequest,
  ReadProjectDiffResult,
  RepositoryAdministrativeIdentity,
  RepositoryComparisonObservation,
  SafeGitRemoteObservation,
  SakiAgentRunId,
  SakiAgentRunMessageSource,
  SakiAgentProfileId,
  SakiControlIntentActorAttribution,
  SakiControlIntentId,
  SakiHostExecutionOperationMap,
  SakiHostExecutionRequest,
  SakiHostExecutionResult,
  SakiHostId,
  SakiExecutionDispatchId,
  SakiGrantId,
  SakiInstallationId,
  SakiInterventionAnswerMessageSource,
  SakiInterventionRequestId,
  SakiPrincipalId,
  SakiResourceBindingId,
  MessageId,
  SessionId,
  SakiWorkSessionId,
  SakiStorageGenerationId,
  SelectedProjectGitChange,
  StageFilesHostOperationRequest,
  StageFilesHostOperationResult,
  StartAgentRunHostOperationRequest,
  StartAgentRunHostOperationRequestV2,
  StartAgentRunHostOperationResult,
  StartAgentRunInputMessage,
  StartAgentRunInputMessageV2,
  StartAgentRunMessageSource,
  StartAgentRunProfile,
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
   * Revalidate one Resource Binding and confirm one exact local object is a Commit.
   * @param request - active binding and exact object id; arbitrary revisions are not accepted.
   * @param signal - required caller lifetime and cancellation.
   * @returns exact Commit presence or one bounded local-boundary failure.
   */
  abstract inspectProjectCommit(
    request: InspectProjectCommitRequest,
    signal: AbortSignal,
  ): Promise<InspectProjectCommitResult>

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
   * Inspect one exact `request_intervention` call in durable Session state
   * without exposing or mutating that Session.
   * @param request - stable Session, call, Intervention, and expected model-visible result.
   * @param signal - required caller lifetime and cancellation.
   * @returns whether the opening is absent, incomplete, exactly confirmed, or conflicting.
   */
  abstract inspectInterventionOpening(
    request: InspectInterventionOpeningRequest,
    signal: AbortSignal,
  ): Promise<InterventionOpeningEvidence>

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
   * Restore the live handle for one control-plane-validated running Agent Run
   * from the exact succeeded Host Operation and durable Session evidence.
   * This recovery never wakes the Agent or submits model input.
   * @param operation - exact succeeded StartAgentRun Host Operation reference.
   * @param request - complete immutable request retained by the validated control plane.
   * @param signal - required startup lifetime and cancellation.
   * @returns after the matching live Agent handle has been restored for the exact Session.
   * @throws when the operation, request, physical Session evidence, or live Agent conflicts or is unavailable.
   */
  abstract resumeAgentRun(
    operation: HostOperationReference<'start-agent-run'>,
    request: StartAgentRunHostOperationRequest,
    signal: AbortSignal,
  ): Promise<void>

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
