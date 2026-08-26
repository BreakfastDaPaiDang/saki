/** Offline Saki Recovery Backup, verification, and v2-to-v3 upgrade orchestration. */

import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import {
  sakiBuildIdSchema,
  sakiStateCapability,
  sakiStorageGenerationIdSchema,
} from '@breakfastdapaidang/saki-control-plane'
import type {
  SakiBuildId,
  SakiInstallationId,
  SakiStorageGenerationId,
} from '@breakfastdapaidang/saki-control-plane'
import { assertSqliteArtifactSetUnchanged } from './artifacts.ts'
import type { SqliteArtifactSet } from './artifacts.ts'
import {
  createRecoveryBackup,
  verifyRecoveryBackup,
  withMissingRecoveryBackupTarget,
} from './recovery-backup.ts'
import type { VerifiedRecoveryBackup } from './recovery-backup.ts'
import {
  createOperationJournal,
  createSakiMaintenanceOperationId,
  createSakiRecoveryBackupId,
} from './journal.ts'
import type { SakiRecoveryBackupId, UpgradeOperationJournalRequest } from './journal.ts'
import { clearActiveOperation, publishActiveOperation } from './operation-files.ts'
import { publishSakiGenerationCandidate } from './candidate.ts'
import type { SakiCandidatePublicationEffects } from './candidate.ts'
import { migrateSakiV2Generation } from './generation.ts'
import {
  INSTALLATION_MANIFEST_LEAF,
  readInstallationManifest,
  readSelectedGeneration,
  renderInstallationManifest,
} from './manifest.ts'
import type { ManifestBytes, InstallationManifest, SelectedGeneration } from './manifest.ts'
import { publishMissingFile, replaceFileDurably } from './durable-files.ts'
import type { DurableFileResult } from './durable-files.ts'
import { readClosedCurrentSakiState } from './closed-state.ts'
import { selectSakiInstallationSource } from './layout.ts'
import { validateClosedSakiV2Source } from './legacy-state.ts'
import type { ValidatedSakiV2Source } from './legacy-state.ts'
import { withInstallationLease } from './lease.ts'
import { SakiMaintenanceError } from './error.ts'
import { recoverActiveSakiOperation } from './recovery.ts'

/** Exact paths and build provenance required by offline maintenance. */
export interface SakiMaintenanceOptions {
  /** Absolute Installation metadata root. */
  readonly installationRoot: string
  /** Exact absolute B03 database path used only in the manifest-less layout. */
  readonly legacyDatabasePath: string
  /** Provenance recorded for a generation created by this build. */
  readonly currentBuildId: SakiBuildId
  /** Provenance attached to the one known manifest-less B03 source. */
  readonly legacyBuildId: SakiBuildId
}

/** Upgrade milestones exposed only for deterministic crash injection. */
export interface SakiMaintenanceEffects {
  /** Runs after the immutable journal becomes active. */
  readonly afterJournalPublication?: () => Promise<void>
  /** Runs after exact Recovery Backup verification. */
  readonly afterBackupVerification?: () => Promise<void>
  /** Runs after the journal-owned partial candidate directory is created. */
  readonly afterCandidatePartialCreation?: () => Promise<void>
  /** Runs after migration has materialized the complete candidate database. */
  readonly afterCandidateMaterialization?: () => Promise<void>
  /** Runs after generation.json is durable and immediately before the final directory commit. */
  readonly afterCandidateManifestPublication?: () => Promise<void>
  /** Runs after the migrated candidate directory becomes final but remains inactive. */
  readonly afterCandidatePublication?: () => Promise<void>
  /** Runs after current schemas and product relationships validate on the closed candidate. */
  readonly afterCandidateValidation?: () => Promise<void>
  /** Runs immediately before the sole Installation authority commit. */
  readonly beforeManifestPublication?: () => Promise<void>
  /** Runs immediately after the authority commit and before operation cleanup. */
  readonly afterManifestPublication?: () => Promise<void>
}

/** Successful real adjacent Saki state upgrade. */
export interface SakiUpgradeResult {
  /** Exact pre-upgrade rollback artifact. */
  readonly backup: VerifiedRecoveryBackup
  /** Manifest-selected current generation after publication and readback. */
  readonly selected: SelectedGeneration
  /** Exact adjacent source version. */
  readonly sourceVersion: 2
  /** Sole writable target version. */
  readonly targetVersion: 3
}

/** Bound offline maintenance operations with optional crash hooks. */
export interface SakiMaintenanceOperations {
  /** Create and verify one explicit Recovery Backup under the Installation lease. */
  backup(options: SakiMaintenanceOptions, signal: AbortSignal): Promise<VerifiedRecoveryBackup>
  /** Verify one explicit Recovery Backup under the same Installation lease. */
  verify(
    options: SakiMaintenanceOptions,
    backupId: SakiRecoveryBackupId,
    signal: AbortSignal,
  ): Promise<VerifiedRecoveryBackup>
  /** Upgrade exact B03 state into a fresh validated v3 generation. */
  upgrade(options: SakiMaintenanceOptions, signal: AbortSignal): Promise<SakiUpgradeResult>
}

interface ValidatedSourceBase {
  readonly databasePath: string
  readonly installationId: SakiInstallationId
  readonly storageGenerationId: SakiStorageGenerationId
  readonly sourceBuildId: SakiBuildId
  readonly sourceArtifacts: SqliteArtifactSet
  readonly authority: ManifestBytes<InstallationManifest> | undefined
}

interface ValidatedV2Source extends ValidatedSourceBase {
  readonly stateVersion: 2
  readonly legacy: ValidatedSakiV2Source
}

interface ValidatedV3Source extends ValidatedSourceBase {
  readonly stateVersion: 3
}

type ValidatedSource = ValidatedV2Source | ValidatedV3Source

function requireAbsolutePath(path: string, subject: string): string {
  const absolute = resolve(path)
  if (path === ':memory:' || absolute !== path) {
    throw new Error(`${subject} must be an absolute filesystem path`)
  }
  return absolute
}

function normalizedOptions(options: SakiMaintenanceOptions): SakiMaintenanceOptions {
  return {
    installationRoot: requireAbsolutePath(options.installationRoot, 'Saki Installation root'),
    legacyDatabasePath: requireAbsolutePath(options.legacyDatabasePath, 'legacy Saki database path'),
    currentBuildId: sakiBuildIdSchema.parse(options.currentBuildId),
    legacyBuildId: sakiBuildIdSchema.parse(options.legacyBuildId),
  }
}

function requireDurable(result: DurableFileResult, subject: string): void {
  if (result.outcome === 'published') {
    throw new SakiMaintenanceError(
      'recovery-required',
      `${subject} is visible but its namespace durability is uncertain`,
      { cause: result.cause },
    )
  }
}

async function loadValidatedSource(
  options: SakiMaintenanceOptions,
  signal: AbortSignal,
): Promise<ValidatedSource> {
  const authority = await readInstallationManifest(options.installationRoot, signal)
  const source = await selectSakiInstallationSource(
    options.installationRoot,
    options.legacyDatabasePath,
    signal,
  )
  if (source.kind === 'fresh') {
    throw new SakiMaintenanceError('state-unsupported', 'fresh Saki state has nothing to maintain')
  }
  if (source.kind === 'legacy-v2') {
    if (authority !== undefined) {
      throw new SakiMaintenanceError('recovery-required', 'legacy source was selected despite an Installation manifest')
    }
    const legacy = await validateClosedSakiV2Source(source.databasePath, undefined, undefined, signal)
    return {
      stateVersion: 2,
      databasePath: source.databasePath,
      installationId: legacy.installationId,
      storageGenerationId: legacy.storageGenerationId,
      sourceBuildId: options.legacyBuildId,
      sourceArtifacts: legacy.sourceArtifacts,
      authority: undefined,
      legacy,
    }
  }
  if (authority === undefined) {
    throw new SakiMaintenanceError('recovery-required', 'selected generation has no Installation manifest evidence')
  }
  if (authority.value.phase !== 'ready') {
    throw new SakiMaintenanceError(
      'recovery-required',
      'offline maintenance requires a ready Installation; finish provisioning first',
    )
  }
  const version = sakiStateCapability.resolveReadable(source.selected.installation.stateVersion)
  if (version?.version === 2) {
    const legacy = await validateClosedSakiV2Source(
      source.selected.databasePath,
      source.selected.installation.installationId,
      source.selected.installation.storageGenerationId,
      signal,
    )
    return {
      stateVersion: 2,
      databasePath: source.selected.databasePath,
      installationId: legacy.installationId,
      storageGenerationId: legacy.storageGenerationId,
      sourceBuildId: source.selected.generation.createdByBuildId,
      sourceArtifacts: legacy.sourceArtifacts,
      authority,
      legacy,
    }
  }
  if (version?.version === 3) {
    const current = await readClosedCurrentSakiState(
      source.selected.databasePath,
      {
        installationId: source.selected.installation.installationId,
        storageGenerationId: source.selected.installation.storageGenerationId,
        createdByBuildId: source.selected.generation.createdByBuildId,
      },
      signal,
    )
    return {
      stateVersion: 3,
      databasePath: source.selected.databasePath,
      installationId: source.selected.installation.installationId,
      storageGenerationId: source.selected.installation.storageGenerationId,
      sourceBuildId: source.selected.generation.createdByBuildId,
      sourceArtifacts: current.sourceArtifacts,
      authority,
    }
  }
  throw new SakiMaintenanceError(
    'state-unsupported',
    `Saki state version ${String(source.selected.installation.stateVersion)} is not readable by this build`,
  )
}

async function createVerifiedBackup(
  root: string,
  backupId: SakiRecoveryBackupId,
  source: ValidatedSource,
  signal: AbortSignal,
): Promise<VerifiedRecoveryBackup> {
  const result = await withMissingRecoveryBackupTarget(root, backupId, signal, async reservation =>
    await createRecoveryBackup(
      reservation,
      source.sourceArtifacts,
      {
        installationId: source.installationId,
        storageGenerationId: source.storageGenerationId,
        stateVersion: source.stateVersion,
        sourceBuildId: source.sourceBuildId,
      },
      sakiStateCapability,
      signal,
    ))
  if (result.outcome === 'published') {
    throw new SakiMaintenanceError(
      'recovery-required',
      'Recovery Backup is exact and visible but its directory durability is uncertain',
      { cause: result.cause },
    )
  }
  return result.backup
}

function newCandidateId(forbidden: ReadonlySet<SakiStorageGenerationId>): SakiStorageGenerationId {
  for (;;) {
    const candidate = sakiStorageGenerationIdSchema.parse(`storage-generation-${randomUUID()}`)
    if (!forbidden.has(candidate)) return candidate
  }
}

async function publishReadyAuthority(
  options: SakiMaintenanceOptions,
  source: ValidatedV2Source,
  candidate: SelectedGeneration,
  signal: AbortSignal,
): Promise<Buffer> {
  const bytes = renderInstallationManifest(
    'ready',
    candidate.generation,
    candidate.installation.generationJson,
  )
  const path = resolve(options.installationRoot, INSTALLATION_MANIFEST_LEAF)
  const current = await readInstallationManifest(options.installationRoot, signal)
  if (source.authority === undefined) {
    if (current !== undefined) {
      throw new SakiMaintenanceError('recovery-required', 'Installation authority appeared during legacy upgrade')
    }
    requireDurable(await publishMissingFile(path, bytes, signal), 'upgraded Saki Installation manifest')
  } else {
    if (current === undefined || !current.bytes.equals(source.authority.bytes)) {
      throw new SakiMaintenanceError('recovery-required', 'source Installation authority changed during upgrade')
    }
    requireDurable(await replaceFileDurably(path, bytes, signal), 'upgraded Saki Installation manifest')
  }
  const published = await readInstallationManifest(options.installationRoot, new AbortController().signal)
  if (published === undefined || !published.bytes.equals(bytes)) {
    throw new SakiMaintenanceError('recovery-required', 'upgraded Installation manifest failed exact readback')
  }
  return bytes
}

/**
 * Bind offline maintenance commands to deterministic crash hooks.
 * @param effects - optional phase-adjacent failures used by crash tests.
 * @returns scoped backup, verify, and upgrade operations.
 */
export function createSakiMaintenanceOperations(
  effects: SakiMaintenanceEffects = {},
): SakiMaintenanceOperations {
  return {
    backup: async (rawOptions, signal) => {
      const options = normalizedOptions(rawOptions)
      return await withInstallationLease(options.installationRoot, signal, async () => {
        await recoverActiveSakiOperation(
          options.installationRoot,
          options.legacyDatabasePath,
          signal,
        )
        const source = await loadValidatedSource(options, signal)
        const backupId = createSakiRecoveryBackupId()
        const active = await publishActiveOperation(
          options.installationRoot,
          createOperationJournal({
            kind: 'backup',
            operationId: createSakiMaintenanceOperationId(),
            installationId: source.installationId,
            backupId,
          }),
          signal,
        )
        const backup = await createVerifiedBackup(options.installationRoot, backupId, source, signal)
        await clearActiveOperation(options.installationRoot, active)
        return backup
      })
    },
    verify: async (rawOptions, backupId, signal) => {
      const options = normalizedOptions(rawOptions)
      return await withInstallationLease(options.installationRoot, signal, async () => {
        await recoverActiveSakiOperation(
          options.installationRoot,
          options.legacyDatabasePath,
          signal,
        )
        return await verifyRecoveryBackup(options.installationRoot, backupId, sakiStateCapability, signal)
      })
    },
    upgrade: async (rawOptions, signal) => {
      const options = normalizedOptions(rawOptions)
      return await withInstallationLease(options.installationRoot, signal, async () => {
        await recoverActiveSakiOperation(
          options.installationRoot,
          options.legacyDatabasePath,
          signal,
        )
        const selectedSource = await loadValidatedSource(options, signal)
        if (selectedSource.stateVersion !== 2) {
          throw new SakiMaintenanceError('state-unsupported', 'selected Saki state is already current')
        }
        const source = selectedSource
        const backupId = createSakiRecoveryBackupId()
        const candidateStorageGenerationId = newCandidateId(source.legacy.historicalStorageGenerationIds)
        const journalRequest: UpgradeOperationJournalRequest = {
          kind: 'upgrade',
          operationId: createSakiMaintenanceOperationId(),
          installationId: source.installationId,
          backupId,
          candidateStorageGenerationId,
        }
        const active = await publishActiveOperation(
          options.installationRoot,
          createOperationJournal(journalRequest),
          signal,
        )
        /* v8 ignore next -- Exact publication/readback returns the journal rendered above byte-for-byte. */
        if (active.journal.kind !== 'upgrade') throw new Error('upgrade journal changed kind after publication')
        await effects.afterJournalPublication?.()
        const backup = await createVerifiedBackup(options.installationRoot, backupId, source, signal)
        await effects.afterBackupVerification?.()
        const identity = {
          installationId: source.installationId,
          storageGenerationId: candidateStorageGenerationId,
          createdByBuildId: options.currentBuildId,
        }
        const candidate = await publishSakiGenerationCandidate(
          options.installationRoot,
          active.journal,
          identity,
          signal,
          async (databasePath) => {
            await migrateSakiV2Generation(
              source.databasePath,
              databasePath,
              identity,
              signal,
            )
          },
          candidatePublicationEffects(effects),
        )
        await effects.afterCandidatePublication?.()
        await readClosedCurrentSakiState(candidate.databasePath, identity, signal)
        await effects.afterCandidateValidation?.()
        await assertSqliteArtifactSetUnchanged(source.sourceArtifacts, signal)
        await effects.beforeManifestPublication?.()
        const publishedAuthorityBytes = await publishReadyAuthority(options, source, candidate, signal)
        await effects.afterManifestPublication?.()
        const authority = await readInstallationManifest(options.installationRoot, new AbortController().signal)
        if (authority === undefined || !authority.bytes.equals(publishedAuthorityBytes)) {
          throw new SakiMaintenanceError(
            'recovery-required',
            'upgraded Installation authority changed before operation cleanup',
          )
        }
        const selected = await readSelectedGeneration(
          options.installationRoot,
          authority.value,
          new AbortController().signal,
        )
        await readClosedCurrentSakiState(selected.databasePath, identity, new AbortController().signal)
        await assertSqliteArtifactSetUnchanged(source.sourceArtifacts, new AbortController().signal)
        await clearActiveOperation(options.installationRoot, active)
        return { backup, selected, sourceVersion: 2, targetVersion: 3 }
      })
    },
  }
}

function candidatePublicationEffects(
  effects: SakiMaintenanceEffects,
): SakiCandidatePublicationEffects {
  return {
    ...(effects.afterCandidatePartialCreation === undefined
      ? {}
      : { afterPartialCreation: effects.afterCandidatePartialCreation }),
    ...(effects.afterCandidateMaterialization === undefined
      ? {}
      : { afterMaterialization: effects.afterCandidateMaterialization }),
    ...(effects.afterCandidateManifestPublication === undefined
      ? {}
      : { afterGenerationManifestPublication: effects.afterCandidateManifestPublication }),
  }
}

const defaultOperations = createSakiMaintenanceOperations()

/**
 * Create and verify one explicit Recovery Backup under the Installation lease.
 * @param options - Installation paths and fixed build provenance.
 * @param signal - cancellation retained through lease release.
 * @returns the verified immutable backup.
 */
export async function backupSakiInstallation(
  options: SakiMaintenanceOptions,
  signal: AbortSignal,
): Promise<VerifiedRecoveryBackup> {
  return await defaultOperations.backup(options, signal)
}

/**
 * Verify one explicit Recovery Backup under the Installation lease.
 * @param options - Installation paths and fixed build provenance.
 * @param backupId - exact backup selected by the caller.
 * @param signal - cancellation retained through lease release.
 * @returns the verified immutable backup.
 */
export async function verifySakiInstallationBackup(
  options: SakiMaintenanceOptions,
  backupId: SakiRecoveryBackupId,
  signal: AbortSignal,
): Promise<VerifiedRecoveryBackup> {
  return await defaultOperations.verify(options, backupId, signal)
}

/**
 * Upgrade exact B03 state through a verified backup into a fresh v3 generation.
 * @param options - Installation paths and fixed build provenance.
 * @param signal - cancellation retained through lease release.
 * @returns the published v3 generation and its verified backup.
 */
export async function upgradeSakiInstallation(
  options: SakiMaintenanceOptions,
  signal: AbortSignal,
): Promise<SakiUpgradeResult> {
  return await defaultOperations.upgrade(options, signal)
}
