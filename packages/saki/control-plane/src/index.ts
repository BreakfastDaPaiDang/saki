/** Saki Installation control plane and local Access interface. @module @breakfastdapaidang/saki-control-plane */

export { SakiControlPlaneService } from './service.ts'
export {
  SAKI_BOARD_WORK_ITEM_LIMIT,
  SAKI_GITHUB_CAPACITY_OBSERVED_LIMIT,
  SAKI_GITHUB_MAPPING_ISSUE_LIMIT,
} from './constants.ts'
export { SakiInstallationState } from './installation-state.ts'
export {
  bindingWriteAdmissionRecordSchema,
  gitOperationIntentRecordSchema,
  sakiControlPlaneDomainSpec,
} from './spec.ts'
export type {
  BindingWriteAdmissionRecord,
  GitOperationIntentRecord,
} from './spec.ts'
export {
  sakiBuildIdSchema,
  sakiInstallationIdSchema,
  sakiStorageGenerationIdSchema,
} from './ids.ts'
export {
  createStorageGenerationSeal,
  sakiStorageGenerationDomainSpec,
  sakiStorageGenerationV1DomainSpec,
  sakiStorageGenerationV2DomainSpec,
  sakiStorageGenerationV3DomainSpec,
  STORAGE_GENERATION_KEY,
  storageGenerationSealRecordSchema,
  storageGenerationV1SealRecordSchema,
  storageGenerationV2SealRecordSchema,
  storageGenerationV3SealRecordSchema,
} from './state-version.ts'
export type {
  StorageGenerationSealRecord,
  StorageGenerationV1SealRecord,
  StorageGenerationV2SealRecord,
  StorageGenerationV3SealRecord,
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
  MoveWorkItemIntent,
  SakiBoardMutationOverlayProjection,
  SakiWorkItemIntentReceipt,
} from './types.ts'
export type {
  AccessProjection,
  SakiAccessExchangeResult,
  SakiAccessLogoutResult,
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
