/** Saki Installation control plane and local Access interface. @module @breakfastdapaidang/saki-control-plane */

export { SakiControlPlaneService } from './service.ts'
export {
  SAKI_BOARD_WORK_ITEM_LIMIT,
  SAKI_GITHUB_CAPACITY_OBSERVED_LIMIT,
  SAKI_GITHUB_MAPPING_ISSUE_LIMIT,
} from './constants.ts'
export { SakiInstallationState } from './installation-state.ts'
export {
  agentOperationIntentRecordSchema,
  agentRunRecordSchema,
  bindingWriteAdmissionRecordSchema,
  executionDispatchRecordSchema,
  giveWorkItemToAgentIntentSchema,
  gitOperationIntentRecordSchema,
  sakiControlPlaneDomainSpec,
  workAssignmentRecordSchema,
  workSessionRecordSchema,
} from './spec.ts'
export type {
  AgentOperationIntentRecord,
  AgentRunRecord,
  BindingWriteAdmissionRecord,
  ExecutionDispatchRecord,
  GitOperationIntentRecord,
  WorkAssignmentRecord,
  WorkSessionRecord,
} from './spec.ts'
export {
  sakiAgentProfileIdSchema,
  sakiBuildIdSchema,
  sakiDispatchClaimIdSchema,
  sakiInstallationIdSchema,
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
  STORAGE_GENERATION_KEY,
  storageGenerationSealRecordSchema,
  storageGenerationV1SealRecordSchema,
  storageGenerationV2SealRecordSchema,
  storageGenerationV3SealRecordSchema,
  storageGenerationV4SealRecordSchema,
} from './state-version.ts'
export type {
  StorageGenerationSealRecord,
  StorageGenerationV1SealRecord,
  StorageGenerationV2SealRecord,
  StorageGenerationV3SealRecord,
  StorageGenerationV4SealRecord,
} from './state-version.ts'
export {
  validateCurrentSakiState,
  validateSakiV2SourceState,
  validateSakiV3SourceState,
  validateSakiV4SourceState,
} from './state-validation.ts'
export type {
  Config,
  SakiAccess,
  SakiBootstrapLaunch,
  SakiControlPlaneModule,
} from './service.ts'
export type { SakiAuthenticationContext } from './authentication.ts'
export type {
  CreateWorkItemIntent,
  GiveWorkItemToAgentIntent,
  MoveWorkItemIntent,
  SakiBoardMutationOverlayProjection,
  SakiGiveWorkItemToAgentIntentReceipt,
  SakiGiveWorkItemToAgentReceipt,
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
