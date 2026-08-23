/** Saki Installation control plane and local Access interface. @module @breakfastdapaidang/saki-control-plane */

export { SakiControlPlaneService } from './service.ts'
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
  SakiInstallationGenerationId,
  SakiInstallationId,
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
export { SakiBootstrapHandoff } from './secrets.ts'

import type { SakiControlPlaneModule } from './service.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Saki Installation control plane and local access authority. */
    sakiControlPlane: SakiControlPlaneModule
  }
}

export { default } from './service.ts'
