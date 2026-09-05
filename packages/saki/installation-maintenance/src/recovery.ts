/** Deterministic recovery of the sole selected Saki maintenance operation. */

import { lstat, rmdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type {
  SakiBuildId,
  SakiStorageGenerationId,
} from '@breakfastdapaidang/saki-control-plane'
import {
  readClosedCurrentSakiState,
  readClosedProvisioningSakiState,
  readClosedSakiV3State,
  readClosedSakiV4State,
  readClosedSakiV5State,
  readClosedSakiV6State,
  readClosedSakiV7State,
  readClosedSakiV8State,
} from './closed-state.ts'
import { SakiMaintenanceError } from './error.ts'
import { sakiStateCapability } from './state-version.ts'
import { discardDurableFileTemporary } from './durable-files.ts'
import type { ActiveOperation } from './journal.ts'
import { readActiveOperation } from './journal.ts'
import type { SakiOperationJournal } from './journal.ts'
import {
  readInstallationManifest,
  readSelectedGeneration,
  readUnselectedGeneration,
  INSTALLATION_MANIFEST_LEAF,
} from './manifest.ts'
import type { SelectedGeneration } from './manifest.ts'
import { clearActiveOperation, reconcileOperationMetadata } from './operation-files.ts'
import { removeOwnedDirectory } from './owned-directory.ts'
import {
  requireOwnedPathAncestors,
  validateOwnedPathAncestors,
} from './owned-path.ts'
import { verifyRecoveryBackup } from './recovery-backup.ts'
import type { VerifiedRecoveryBackup } from './recovery-backup.ts'
import { validateClosedSakiV2Source } from './legacy-state.ts'
import { LEGACY_B03_BUILD_ID } from './release.ts'

const PREVIOUS_WRITABLE_STATE_VERSION = 8 as const

function requireAbsolutePath(path: string, subject: string): string {
  const absolute = resolve(path)
  if (path === ':memory:' || absolute !== path) {
    throw new Error(`${subject} must be an absolute filesystem path`)
  }
  return absolute
}

function resolveLeaf(root: string, leaf: string): string {
  return resolve(root, ...leaf.split('/'))
}

async function pathExists(path: string, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted()
  try {
    await lstat(path)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT') return false
    if (code === 'ENOTDIR') {
      throw new SakiMaintenanceError(
        'recovery-required',
        `cannot inspect ${path} because an ancestor is not a directory`,
        { cause: error },
      )
    }
    throw error
  }
}

async function pruneEmptyDirectory(path: string): Promise<void> {
  try {
    await rmdir(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw error
  }
}

async function clearSettledOperation(root: string, active: ActiveOperation): Promise<void> {
  await clearActiveOperation(root, active)
  await pruneEmptyDirectory(dirname(active.journalPath))
}

async function removeOwnedPath(
  root: string,
  path: string,
  signal: AbortSignal,
): Promise<void> {
  if (!await validateOwnedPathAncestors(root, path, signal)) return
  removeOwnedDirectory(path, signal)
}

async function removeJournalDirectory(
  root: string,
  leaf: string,
  signal: AbortSignal,
): Promise<string> {
  const path = resolveLeaf(root, leaf)
  await removeOwnedPath(root, path, signal)
  return path
}

async function recoverFresh(
  root: string,
  active: ActiveOperation,
  journal: Extract<SakiOperationJournal, { readonly kind: 'fresh' }>,
  signal: AbortSignal,
): Promise<void> {
  const manifest = await readInstallationManifest(root, signal)
  const partial = resolveLeaf(root, journal.candidate.partialLeaf)
  const final = resolveLeaf(root, journal.candidate.finalLeaf)
  if (manifest === undefined) {
    await removeOwnedPath(root, partial, signal)
    await removeOwnedPath(root, final, signal)
    await pruneEmptyDirectory(dirname(final))
    await clearSettledOperation(root, active)
    return
  }
  if (manifest.value.installationId !== journal.installationId
    || manifest.value.storageGenerationId !== journal.candidateStorageGenerationId
    || !isRecoverableJournalTarget(manifest.value.stateVersion)) {
    throw new SakiMaintenanceError(
      'recovery-required',
      'active fresh operation disagrees with the published Installation authority',
    )
  }
  const selected = await readSelectedGeneration(root, manifest.value, signal)
  await validateSelectedJournalTarget(selected, signal)
  await removeOwnedPath(root, partial, signal)
  await clearSettledOperation(root, active)
}

function isRecoverableJournalTarget(stateVersion: number): boolean {
  return stateVersion === PREVIOUS_WRITABLE_STATE_VERSION
    || stateVersion === sakiStateCapability.writable.version
}

async function validateSelectedJournalTarget(
  selected: SelectedGeneration,
  signal: AbortSignal,
): Promise<void> {
  const expectation = {
    installationId: selected.installation.installationId,
    storageGenerationId: selected.installation.storageGenerationId,
    createdByBuildId: selected.generation.createdByBuildId,
  }
  if (selected.generation.stateVersion === PREVIOUS_WRITABLE_STATE_VERSION) {
    await readClosedSakiV8State(selected.databasePath, expectation, signal)
    return
  }
  if (selected.installation.phase === 'ready') {
    await readClosedCurrentSakiState(selected.databasePath, expectation, signal)
    return
  }
  await readClosedProvisioningSakiState(
    selected.databasePath,
    { ...expectation, stateVersion: sakiStateCapability.writable.version },
    signal,
  )
}

async function verifyJournalBackup(
  root: string,
  journal: Extract<SakiOperationJournal, { readonly kind: 'backup' | 'upgrade' }>,
  signal: AbortSignal,
): Promise<VerifiedRecoveryBackup | undefined> {
  const final = resolveLeaf(root, journal.backup.finalLeaf)
  if (!await pathExists(final, signal)) return undefined
  const backup = await verifyRecoveryBackup(
    root,
    journal.backupId,
    sakiStateCapability,
    signal,
  )
  if (backup.manifest.installationId !== journal.installationId) {
    throw new SakiMaintenanceError(
      'recovery-required',
      'journal-owned Recovery Backup belongs to another Installation',
    )
  }
  return backup
}

async function recoverBackup(
  root: string,
  active: ActiveOperation,
  journal: Extract<SakiOperationJournal, { readonly kind: 'backup' }>,
  signal: AbortSignal,
): Promise<void> {
  const partial = await removeJournalDirectory(root, journal.backup.partialLeaf, signal)
  await verifyJournalBackup(root, journal, signal)
  await pruneEmptyDirectory(dirname(partial))
  await clearSettledOperation(root, active)
}

async function validateUpgradeCandidate(
  root: string,
  journal: Extract<SakiOperationJournal, { readonly kind: 'upgrade' }>,
  signal: AbortSignal,
): Promise<SelectedGeneration> {
  const candidate = await readUnselectedGeneration(
    root,
    journal.installationId,
    journal.candidateStorageGenerationId,
    signal,
  )
  if (!isRecoverableJournalTarget(candidate.generation.stateVersion)
    || candidate.generation.stateVersion <= journal.sourceStateVersion) {
    throw new SakiMaintenanceError(
      'recovery-required',
      'upgrade candidate is not a recoverable forward Saki state',
    )
  }
  const expectation = {
    installationId: candidate.installation.installationId,
    storageGenerationId: candidate.installation.storageGenerationId,
    createdByBuildId: candidate.generation.createdByBuildId,
  }
  if (candidate.generation.stateVersion === PREVIOUS_WRITABLE_STATE_VERSION) {
    await readClosedSakiV8State(candidate.databasePath, expectation, signal)
  } else {
    await readClosedCurrentSakiState(candidate.databasePath, expectation, signal)
  }
  return candidate
}

function requireUpgradeBackupSource(
  journal: Extract<SakiOperationJournal, { readonly kind: 'upgrade' }>,
  backup: VerifiedRecoveryBackup,
): void {
  if (backup.manifest.stateVersion !== journal.sourceStateVersion
    || backup.manifest.storageGenerationId !== journal.sourceStorageGenerationId
    || backup.manifest.sourceBuildId !== journal.sourceBuildId) {
    throw new SakiMaintenanceError(
      'recovery-required',
      'upgrade Recovery Backup disagrees with the immutable source identity',
    )
  }
}

function requireRetainedUpgradeSource(
  journal: Extract<SakiOperationJournal, { readonly kind: 'upgrade' }>,
  stateVersion: 2 | 3 | 4 | 5 | 6 | 7 | 8,
  storageGenerationId: SakiStorageGenerationId,
  sourceBuildId: SakiBuildId,
): void {
  if (stateVersion !== journal.sourceStateVersion
    || storageGenerationId !== journal.sourceStorageGenerationId
    || sourceBuildId !== journal.sourceBuildId) {
    throw new SakiMaintenanceError(
      'recovery-required',
      'active upgrade disagrees with its retained source authority',
    )
  }
}

async function recoverUpgrade(
  root: string,
  legacyDatabasePath: string,
  active: ActiveOperation,
  journal: Extract<SakiOperationJournal, { readonly kind: 'upgrade' }>,
  signal: AbortSignal,
): Promise<void> {
  const manifest = await readInstallationManifest(root, signal)
  const candidateSelected = manifest !== undefined
    && manifest.value.phase === 'ready'
    && manifest.value.installationId === journal.installationId
    && manifest.value.storageGenerationId === journal.candidateStorageGenerationId
    && isRecoverableJournalTarget(manifest.value.stateVersion)
    && manifest.value.stateVersion > journal.sourceStateVersion
  if (candidateSelected) {
    const backup = await verifyJournalBackup(root, journal, signal)
    if (backup === undefined) {
      throw new SakiMaintenanceError(
        'recovery-required',
        'committed Saki upgrade has no exact historical Recovery Backup',
      )
    }
    requireUpgradeBackupSource(journal, backup)
    const selected = await readSelectedGeneration(root, manifest.value, signal)
    await validateSelectedJournalTarget(selected, signal)
    await removeJournalDirectory(root, journal.backup.partialLeaf, signal)
    await removeJournalDirectory(root, journal.candidate.partialLeaf, signal)
    await clearSettledOperation(root, active)
    return
  }

  let oldStorageGenerationId: SakiStorageGenerationId
  let oldStateVersion: 2 | 3 | 4 | 5 | 6 | 7 | 8
  let oldSourceBuildId: SakiBuildId
  if (manifest === undefined) {
    const legacy = await validateClosedSakiV2Source(
      legacyDatabasePath,
      journal.installationId,
      undefined,
      signal,
    )
    oldStorageGenerationId = legacy.storageGenerationId
    oldStateVersion = 2
    oldSourceBuildId = LEGACY_B03_BUILD_ID
  } else {
    if (manifest.value.phase !== 'ready'
      || manifest.value.installationId !== journal.installationId
      || (manifest.value.stateVersion !== 2
        && manifest.value.stateVersion !== 3
        && manifest.value.stateVersion !== 4
        && manifest.value.stateVersion !== 5
        && manifest.value.stateVersion !== 6
        && manifest.value.stateVersion !== 7
        && manifest.value.stateVersion !== 8)
      || manifest.value.storageGenerationId === journal.candidateStorageGenerationId) {
      throw new SakiMaintenanceError(
        'recovery-required',
        'active upgrade disagrees with the published Installation authority',
      )
    }
    const old = await readSelectedGeneration(root, manifest.value, signal)
    if (manifest.value.stateVersion === 2) {
      await validateClosedSakiV2Source(
        old.databasePath,
        journal.installationId,
        old.installation.storageGenerationId,
        signal,
      )
    } else if (manifest.value.stateVersion === 3) {
      await readClosedSakiV3State(
        old.databasePath,
        {
          installationId: old.installation.installationId,
          storageGenerationId: old.installation.storageGenerationId,
          createdByBuildId: old.generation.createdByBuildId,
        },
        signal,
      )
    } else if (manifest.value.stateVersion === 4) {
      await readClosedSakiV4State(
        old.databasePath,
        {
          installationId: old.installation.installationId,
          storageGenerationId: old.installation.storageGenerationId,
          createdByBuildId: old.generation.createdByBuildId,
        },
        signal,
      )
    } else if (manifest.value.stateVersion === 5) {
      await readClosedSakiV5State(
        old.databasePath,
        {
          installationId: old.installation.installationId,
          storageGenerationId: old.installation.storageGenerationId,
          createdByBuildId: old.generation.createdByBuildId,
        },
        signal,
      )
    } else if (manifest.value.stateVersion === 6) {
      await readClosedSakiV6State(
        old.databasePath,
        {
          installationId: old.installation.installationId,
          storageGenerationId: old.installation.storageGenerationId,
          createdByBuildId: old.generation.createdByBuildId,
        },
        signal,
      )
    } else if (manifest.value.stateVersion === 7) {
      await readClosedSakiV7State(
        old.databasePath,
        {
          installationId: old.installation.installationId,
          storageGenerationId: old.installation.storageGenerationId,
          createdByBuildId: old.generation.createdByBuildId,
        },
        signal,
      )
    } else {
      await readClosedSakiV8State(
        old.databasePath,
        {
          installationId: old.installation.installationId,
          storageGenerationId: old.installation.storageGenerationId,
          createdByBuildId: old.generation.createdByBuildId,
        },
        signal,
      )
    }
    oldStorageGenerationId = old.installation.storageGenerationId
    oldStateVersion = manifest.value.stateVersion
    oldSourceBuildId = old.generation.createdByBuildId
  }
  requireRetainedUpgradeSource(
    journal,
    oldStateVersion,
    oldStorageGenerationId,
    oldSourceBuildId,
  )

  const backup = await verifyJournalBackup(root, journal, signal)
  if (backup !== undefined) {
    requireUpgradeBackupSource(journal, backup)
  }
  const candidateFinal = resolveLeaf(root, journal.candidate.finalLeaf)
  const candidateExists = await pathExists(candidateFinal, signal)
  if (candidateExists) {
    await validateUpgradeCandidate(
      root,
      journal,
      signal,
    )
  }
  if (backup !== undefined) {
    await removeJournalDirectory(root, journal.backup.finalLeaf, signal)
  }
  const backupPartial = await removeJournalDirectory(root, journal.backup.partialLeaf, signal)
  if (candidateExists) {
    await removeOwnedPath(root, candidateFinal, signal)
  }
  const candidatePartial = await removeJournalDirectory(root, journal.candidate.partialLeaf, signal)
  await pruneEmptyDirectory(dirname(backupPartial))
  await pruneEmptyDirectory(dirname(candidatePartial))
  await clearSettledOperation(root, active)
}

/**
 * Settle the sole active maintenance journal while the caller holds the Installation lease.
 * Installation authority always comes from `installation.json` or the exact configured B03 path;
 * a journal supplies only identities for validation and safe cleanup.
 * @param installationRoot - absolute Installation root held exclusively by the caller.
 * @param legacyDatabasePath - exact configured manifest-less B03 database path.
 * @param signal - cancellation observed until outcome evidence is complete.
 * @returns after the selected operation is validated, rolled back, and cleared.
 */
export async function recoverActiveSakiOperation(
  installationRoot: string,
  legacyDatabasePath: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  const root = requireAbsolutePath(installationRoot, 'Saki Installation root')
  const legacy = requireAbsolutePath(legacyDatabasePath, 'legacy Saki database path')
  const installationManifestPath = resolve(root, INSTALLATION_MANIFEST_LEAF)
  await requireOwnedPathAncestors(root, installationManifestPath, signal)
  await discardDurableFileTemporary(installationManifestPath, signal)
  await reconcileOperationMetadata(root, signal)
  const active = await readActiveOperation(root, signal)
  if (active === undefined) return
  switch (active.journal.kind) {
    case 'fresh':
      await recoverFresh(root, active, active.journal, signal)
      return
    case 'backup':
      await recoverBackup(root, active, active.journal, signal)
      return
    case 'upgrade':
      await recoverUpgrade(root, legacy, active, active.journal, signal)
      return
    /* v8 ignore next 2 -- the selected journal schema is a closed discriminated union. */
    default:
      assertNever(active.journal)
  }
}

/* v8 ignore start -- the selected journal schema is a closed discriminated union. */
function assertNever(value: never): never {
  throw new Error(`unsupported Saki recovery journal '${JSON.stringify(value)}'`)
}
/* v8 ignore stop */
