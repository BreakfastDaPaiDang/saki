/** Saki Installation control plane and local Access interface. @module @breakfastdapaidang/saki-control-plane */

export { SakiControlPlaneService } from './service.ts'
export {
  MAX_INTERVENTION_ANSWER_CHARS,
  MAX_INTERVENTION_PROMPT_CHARS,
  SAKI_BOARD_WORK_ITEM_LIMIT,
  SAKI_GITHUB_CAPACITY_OBSERVED_LIMIT,
  SAKI_GITHUB_MAPPING_ISSUE_LIMIT,
} from './constants.ts'
export { SakiInstallationState } from './installation-state.ts'
export type { SakiGitHubFailureProjection } from './github-failure-projection.ts'
export {
  agentOperationIntentRecordSchema,
  agentRunRecordSchema,
  agentRunV1RecordSchema,
  answerInterventionIntentSchema,
  bindingWriteAdmissionRecordSchema,
  executionDispatchRecordSchema,
  executionDispatchV1RecordSchema,
  giveWorkItemToAgentIntentSchema,
  interventionRequestRecordSchema,
  gitOperationIntentRecordSchema,
  workAssignmentRecordSchema,
  workSessionRecordSchema,
} from './spec.ts'
export type {
  AgentOperationIntentRecord,
  AgentRunRecord,
  AgentRunV1Record,
  BindingWriteAdmissionRecord,
  ExecutionDispatchRecord,
  ExecutionDispatchV1Record,
  GitOperationIntentRecord,
  InterventionRequestRecord,
  WorkAssignmentRecord,
  WorkSessionRecord,
} from './spec.ts'
export { sakiControlPlaneDomainSpec } from './domain-spec.ts'
export {
  branchDeliveryId,
  branchDeliveryIntentSchema,
  branchDeliveryRecordSchema,
} from './branch-delivery.ts'
export type {
  BranchDeliveryIntent,
  BranchDeliveryIntentResult,
  BranchDeliveryProjection,
  BranchDeliveryRecord,
  SakiBranchDeliveryId,
} from './branch-delivery.ts'
export {
  milestoneDeliveryId,
  milestoneDeliveryIntentSchema,
  milestoneDeliveryRecordSchema,
} from './milestone-delivery.ts'
export type {
  MilestoneDeliveryIntent,
  MilestoneDeliveryIntentResult,
  MilestoneDeliveryPhase,
  MilestoneDeliveryProjection,
  MilestoneDeliveryRecord,
  SakiMilestoneDeliveryId,
} from './milestone-delivery.ts'
export {
  evaluateReleaseEvidencePolicyV1,
  RELEASE_EVIDENCE_POLICY_V1,
  releaseEvidencePolicyV1EvidenceSchema,
} from './release-evidence-policy.ts'
export type {
  ReleaseEvidencePolicyV1Blockage,
  ReleaseEvidencePolicyV1Evidence,
  ReleaseEvidencePolicyV1Expectation,
  ReleaseEvidencePolicyV1Snapshot,
  SakiReleaseBoardFact,
  SakiReleaseDeliveryFact,
  SakiTargetedEvidence,
} from './release-evidence-policy.ts'
export {
  milestoneBoardEvidence,
  projectMilestoneView,
} from './milestone-view.ts'
export type {
  MilestoneViewBlockage,
  MilestoneViewProjection,
  MilestoneViewScope,
  MilestoneViewScopeItem,
  MilestoneViewSourceProjection,
  MilestoneViewSourceState,
} from './milestone-view.ts'
export { assembleReleaseSnapshot } from './release-snapshot.ts'
export type {
  AssembleReleaseSnapshotInput,
  ReleaseSnapshotDeliveryInput,
} from './release-snapshot.ts'
export {
  sakiAgentProfileIdSchema,
  sakiBuildIdSchema,
  sakiDispatchClaimIdSchema,
  sakiInstallationIdSchema,
  sakiInterventionRequestIdSchema,
  sakiStorageGenerationIdSchema,
  sakiWorkAssignmentIdSchema,
} from './ids.ts'
export {
  createStorageGenerationSeal,
  sakiStorageGenerationDomainSpec,
  sakiStorageGenerationV1DomainSpec,
  sakiStorageGenerationV2DomainSpec,
  sakiStorageGenerationV3DomainSpec,
  sakiStorageGenerationV4DomainSpec,
  sakiStorageGenerationV5DomainSpec,
  sakiStorageGenerationV6DomainSpec,
  STORAGE_GENERATION_KEY,
  storageGenerationSealRecordSchema,
  storageGenerationV1SealRecordSchema,
  storageGenerationV2SealRecordSchema,
  storageGenerationV3SealRecordSchema,
  storageGenerationV4SealRecordSchema,
  storageGenerationV5SealRecordSchema,
  storageGenerationV6SealRecordSchema,
} from './state-version.ts'
export type {
  StorageGenerationSealRecord,
  StorageGenerationV1SealRecord,
  StorageGenerationV2SealRecord,
  StorageGenerationV3SealRecord,
  StorageGenerationV4SealRecord,
  StorageGenerationV5SealRecord,
  StorageGenerationV6SealRecord,
} from './state-version.ts'
export {
  validateCurrentSakiState,
  validateSakiV2SourceState,
  validateSakiV3SourceState,
  validateSakiV4SourceState,
} from './state-validation.ts'
export type {
  Config,
  SakiAgentInterventionRequest,
  SakiAgentInterventionRequestResult,
  SakiAgentInterventions,
  SakiAccess,
  SakiBootstrapLaunch,
  SakiControlPlaneModule,
} from './service.ts'
export type { SakiAuthenticationContext } from './authentication.ts'
export type {
  AnswerInterventionIntent,
  CreateWorkItemIntent,
  GiveWorkItemToAgentIntent,
  MoveWorkItemIntent,
  SakiBoardMutationOverlayProjection,
  SakiGiveWorkItemToAgentIntentReceipt,
  SakiGiveWorkItemToAgentReceipt,
  SakiAnswerInterventionIntentReceipt,
  SakiAnswerInterventionReceipt,
  SakiWorkItemIntentReceipt,
} from './types.ts'
export type {
  AccessProjection,
  SakiAccessExchangeResult,
  SakiAgentProfileId,
  SakiAccessLogoutResult,
  SakiAgentRunProjection,
  SakiAuthenticatedAccessProjection,
  SakiBootstrapChallengeId,
  SakiBuildId,
  SakiBootstrapChallengePurpose,
  SakiBootstrapExchangeRequest,
  SakiBootstrapTransportContext,
  SakiBoardFreshnessProjection,
  SakiBoardMutationAvailabilityProjection,
  SakiBoardMutationUnavailableReason,
  SakiBoardProjection,
  SakiBoardQuery,
  SakiBranchDeliveryProjection,
  SakiBranchDeliveryQuery,
  SakiBoardRemoteFingerprint,
  SakiBoardStatus,
  SakiBoardWorkItemId,
  SakiBoardWorkItemProjection,
  SakiBrowserSessionId,
  SakiControlIntentId,
  ConfigureGitHubSynchronizationIntent,
  CreateCommitIntent,
  GitMutationExpectation,
  GitHubAccountId,
  GitHubAppId,
  GitHubInstallationId,
  GitHubMilestoneId,
  GitHubProjectFieldId,
  GitHubProjectId,
  GitHubProjectOptionId,
  GitHubRepositoryDatabaseId,
  GitHubRepositoryId,
  GitHubStatusOptionMapping,
  GitHubSynchronizationConfiguration,
  GitHubSynchronizationConfigurationField,
  GitHubSynchronizationConfigurationPatch,
  SakiDevelopmentProjectId,
  SakiDevelopmentProjectSummary,
  SakiDevelopmentWorkspaceProjection,
  SakiDevelopmentWorkspaceQuery,
  SakiGrantId,
  SakiDispatchClaimId,
  SakiHostId,
  SakiInstallationAccessId,
  SakiInstallationId,
  SakiStorageGenerationId,
  SakiInstallationIdentity,
  SakiIntent,
  SakiIntentInput,
  SakiIntentMap,
  SakiIntentReceipt,
  SakiIntentReceiptMap,
  SakiIntentReceiptId,
  SakiInterventionRequestId,
  SakiInterventionRequestProjection,
  SakiMyWorkItemProjection,
  SakiMyWorkProjection,
  SakiMyWorkQuery,
  SakiMilestoneViewProjection,
  SakiMilestoneViewQuery,
  SakiAttentionItemProjection,
  SakiAttentionProjection,
  SakiAttentionQuery,
  SakiWorkAssignmentId,
  SakiWorkItemDetailProjection,
  SakiAgentRunId,
  SakiExecutionDispatchId,
  SakiWorkSessionId,
  SakiGitHubSynchronizationReceipt,
  SakiGitOperationAvailabilityProjection,
  SakiGitOperationIntent,
  SakiGitOperationIntentReceipt,
  SakiGitOperationReceipt,
  SakiGitOperationReceiptState,
  SakiGitOperationReferenceProjection,
  SakiGitOperationReferenceProjectionFor,
  SakiGitOperationsProjection,
  SakiGitOperationTerminalReason,
  SakiGitOperationUnavailableReason,
  SakiCurrentGitOperationProjection,
  SakiGitHubMappingHealthProjection,
  SakiGitHubMappingIssue,
  SakiGitHubRateLimitProjection,
  SakiGitHubScanAttemptId,
  SakiGitHubScanFailure,
  SakiGitHubScanFailureProjection,
  SakiGitHubScanStateProjection,
  SakiGitHubSyncCheckpointProjection,
  SakiGitHubSynchronizationFailureProjection,
  SakiConfirmedBoardProjection,
  SakiPrincipalId,
  SakiProjectIndexProjection,
  SakiProjectIndexQuery,
  SakiProjectDiffProjection,
  SakiProjectDiffQuery,
  SakiProjectChangesProjection,
  SakiProjectChangesObservationResult,
  SakiProjectChangesQuery,
  SakiProjectSettingsProjection,
  SakiProjectSettingsQuery,
  SakiProjectSelectionInspectionProjection,
  SakiInspectProjectSelectionQuery,
  SakiRegistrationReceipt,
  SakiResourceBindingId,
  StageFilesIntent,
  UnstageFilesIntent,
  RegisterDevelopmentProjectIntent,
  SakiProjectionKey,
  SakiQuery,
  SakiQueryMap,
  SakiQueryResult,
  SakiUnauthenticatedAccessProjection,
} from './types.ts'
export {
  migratedStorageGenerationId,
  sakiControlPlaneMigrationPlan,
  sakiControlPlaneV2DomainSpec,
  sakiControlPlaneV3DomainSpec,
  sakiControlPlaneV4DomainSpec,
  sakiControlPlaneV5DomainSpec,
  sakiControlPlaneV6DomainSpec,
  sakiControlPlaneV7DomainSpec,
  sakiControlPlaneV8DomainSpec,
} from './migration.ts'
export { SakiBootstrapHandoff } from './secrets.ts'

import type { SakiControlPlaneModule } from './service.ts'
import type { SakiInstallationState } from './installation-state.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Verified active Saki Installation and storage-generation identities. */
    sakiInstallationState: SakiInstallationState
    /** Saki Installation control plane and local access authority. */
    sakiControlPlane: SakiControlPlaneModule
  }
}

export { default } from './service.ts'
