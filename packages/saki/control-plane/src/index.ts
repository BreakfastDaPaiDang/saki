/** Saki Installation control plane and local Access interface. @module @breakfastdapaidang/saki-control-plane */

export { SakiControlPlaneService } from './service.ts'
export { SakiInstallationState } from './installation-state.ts'
export {
  sakiBuildIdSchema,
  sakiInstallationIdSchema,
  sakiStorageGenerationIdSchema,
} from './ids.ts'
export {
  createStorageGenerationSeal,
  sakiStateCapability,
  sakiStateControlPlaneMigrationPlan,
  sakiStorageGenerationDomainSpec,
  STORAGE_GENERATION_KEY,
  storageGenerationSealRecordSchema,
} from './state-version.ts'
export type {
  SakiStateCapability,
  SakiStateVersionSpec,
  StorageGenerationSealRecord,
} from './state-version.ts'
export {
  validateCurrentSakiState,
  validateSakiV2SourceState,
} from './state-validation.ts'
export type {
  Config,
  SakiAccess,
  SakiBootstrapLaunch,
  SakiControlPlaneModule,
} from './service.ts'
export type { SakiAuthenticationContext } from './authentication.ts'
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
  SakiBrowserSessionId,
  SakiControlIntentId,
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
  SakiIntentReceiptId,
  SakiPrincipalId,
  SakiProjectIndexProjection,
  SakiProjectIndexQuery,
  SakiProjectSelectionInspectionProjection,
  SakiInspectProjectSelectionQuery,
  SakiRegistrationReceipt,
  SakiResourceBindingId,
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
