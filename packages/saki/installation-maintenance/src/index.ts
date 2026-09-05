/** Saki cold Installation maintenance and serving-lifetime preparation. @module @breakfastdapaidang/saki-installation-maintenance */

export { SakiMaintenanceError } from './error.ts'
export type { SakiMaintenanceErrorCode } from './error.ts'
export { CURRENT_SAKI_BUILD_ID, LEGACY_B03_BUILD_ID } from './release.ts'
export { sakiStateCapability, sakiStateControlPlaneMigrationPlan } from './state-version.ts'
export type { SakiStateCapability, SakiStateVersionSpec } from './state-version.ts'
export { validateCurrentSakiProductState } from './state-validation.ts'
export {
  assertSqliteArtifactSetUnchanged,
  captureSqliteArtifactSet,
  copiedDatabasePath,
  copySqliteArtifactSet,
} from './artifacts.ts'
export type {
  FileEvidence,
  SqliteArtifactEvidence,
  SqliteArtifactRole,
  SqliteArtifactSet,
} from './artifacts.ts'
export {
  readClosedProvisioningSakiState,
  readClosedCurrentSakiState,
  readClosedSakiV2State,
  readClosedSakiV3State,
  readClosedSakiV4State,
  readClosedSakiV5State,
  readClosedSakiV6State,
  readClosedSakiV7State,
  readClosedSakiV8State,
} from './closed-state.ts'
export type {
  ClosedCurrentSakiState,
  ClosedCurrentSakiStateExpectation,
  ClosedProvisioningSakiState,
  ClosedSakiV2State,
  ClosedSakiV3State,
  ClosedSakiV4State,
  ClosedSakiV5State,
  ClosedSakiV6State,
  ClosedSakiV7State,
  ClosedSakiV8State,
} from './closed-state.ts'
export {
  createDurableFileWriter,
  discardDurableFileTemporary,
  durableFileTemporaryPath,
  DurableFileOutcomeUnknownError,
  publishMissingFile,
  replaceFileDurably,
} from './durable-files.ts'
export type {
  DurableFileEffects,
  DurableFileFinalState,
  DurableFilePlatform,
  DurableFileResult,
  DurableFileTemporaryEffects,
  DurableFileWriter,
} from './durable-files.ts'
export { INSTALLATION_LOCK_LEAF, withInstallationLease } from './lease.ts'
export type { InstallationLeaseEffects } from './lease.ts'
export {
  ACTIVE_OPERATION_LEAF,
  activeOperationSelectorSchema,
  backupOperationJournalSchema,
  clearedPendingOperationSchema,
  createOperationJournal,
  createSakiMaintenanceOperationId,
  createSakiRecoveryBackupId,
  freshOperationJournalSchema,
  operationJournalLeaf,
  operationJournalReference,
  operationJournalReferenceSchema,
  operationJournalSchema,
  pendingOperationIntentSchema,
  pendingOperationStateSchema,
  PENDING_OPERATION_LEAF,
  readActiveOperation,
  readPendingOperation,
  readSettledOperation,
  renderActiveOperationSelector,
  renderClearedPendingOperation,
  renderOperationJournal,
  renderPendingOperationIntent,
  sakiMaintenanceOperationIdSchema,
  sakiRecoveryBackupIdSchema,
  SETTLED_OPERATION_JOURNAL_LEAF,
  SETTLED_OPERATION_LEAF,
  upgradeOperationJournalSchema,
} from './journal.ts'
export {
  clearActiveOperation,
  publishActiveOperation,
  reconcileOperationMetadata,
  settleClearedOperationMetadata,
} from './operation-files.ts'
export type { OperationFileEffects } from './operation-files.ts'
export { recoverActiveSakiOperation } from './recovery.ts'
export { materializeFreshSakiGeneration, migrateSakiGeneration } from './generation.ts'
export type { NewSakiGenerationIdentity } from './generation.ts'
export { publishSakiGenerationCandidate } from './candidate.ts'
export type {
  CandidateOperationJournal,
  SakiCandidatePublicationEffects,
} from './candidate.ts'
export {
  backupSakiInstallation,
  createSakiMaintenanceOperations,
  upgradeSakiInstallation,
  verifySakiInstallationBackup,
} from './maintenance-operations.ts'
export type {
  SakiMaintenanceEffects,
  SakiMaintenanceOperations,
  SakiMaintenanceOptions,
  SakiUpgradeResult,
} from './maintenance-operations.ts'
export {
  createRecoveryBackup,
  createRecoveryBackupStore,
  recoveryBackupManifestSchema,
  renderRecoveryBackupManifest,
  verifyRecoveryBackup,
  withMissingRecoveryBackupTarget,
} from './recovery-backup.ts'
export type {
  MissingTargetReservation,
  RecoveryBackupCreateRequest,
  RecoveryBackupEffects,
  RecoveryBackupManifest,
  RecoveryBackupPublication,
  RecoveryBackupStore,
  VerifiedRecoveryBackup,
} from './recovery-backup.ts'
export { validateClosedSakiV2Source } from './legacy-state.ts'
export type { ValidatedSakiV2Source } from './legacy-state.ts'
export type {
  ActiveOperation,
  ActiveOperationSelector,
  BackupOperationJournalRequest,
  FreshOperationJournalRequest,
  OperationJournalReference,
  OperationJournalRequest,
  OperationJsonEvidence,
  PendingOperation,
  PendingOperationState,
  SakiMaintenanceOperationId,
  SakiOperationJournal,
  SakiRecoveryBackupId,
  UpgradeOperationJournalRequest,
} from './journal.ts'
export { selectSakiInstallationSource } from './layout.ts'
export type { SakiInstallationSource } from './layout.ts'
export { providePreparedSakiState } from './prepared-state.ts'
export type {
  PreparedProvisioningSakiState,
  PreparedReadySakiState,
  PreparedSakiState,
} from './prepared-state.ts'
export { withPreparedSakiServingState } from './serving.ts'
export type { SakiServingInstallationOptions } from './serving.ts'
export {
  GENERATION_DATABASE_LEAF,
  generationJsonLeaf,
  generationManifestReference,
  generationManifestSchema,
  INSTALLATION_MANIFEST_LEAF,
  installationManifestSchema,
  manifestReferenceSchema,
  readInstallationManifest,
  readSelectedGeneration,
  readUnselectedGeneration,
  renderGenerationManifest,
  renderInstallationManifest,
} from './manifest.ts'
export type {
  GenerationManifest,
  InstallationManifest,
  ManifestBytes,
  SelectedGeneration,
} from './manifest.ts'
