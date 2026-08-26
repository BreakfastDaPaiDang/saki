/** Deterministic Saki Installation source selection without generation discovery. */

import { lstat, readdir } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { INSTALLATION_LOCK_LEAF } from './lease.ts'
import {
  readInstallationManifest,
  readSelectedGeneration,
} from './manifest.ts'
import type { SelectedGeneration } from './manifest.ts'
import { SakiMaintenanceError } from './error.ts'
import {
  PENDING_OPERATION_LEAF,
  SETTLED_OPERATION_JOURNAL_LEAF,
  SETTLED_OPERATION_LEAF,
} from './journal.ts'

const SQLITE_SIDECAR_SUFFIXES = Object.freeze(['', '-wal', '-shm', '-journal'] as const)

/** Sole source selected for one cold Saki Installation operation. */
export type SakiInstallationSource =
  | { readonly kind: 'selected-generation'; readonly selected: SelectedGeneration }
  | { readonly kind: 'legacy-v2'; readonly databasePath: string }
  | { readonly kind: 'fresh' }

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

async function regularFileExists(path: string): Promise<boolean> {
  try {
    const value = await lstat(path)
    if (!value.isFile() || value.isSymbolicLink()) {
      throw new SakiMaintenanceError(
        'recovery-required',
        `Saki Installation artifact '${path}' is not a regular file`,
      )
    }
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

function isInside(root: string, candidate: string): boolean {
  const value = relative(root, candidate)
  return value !== '' && value !== '..' && !value.startsWith(`..${sep}`) && !value.includes(`..${sep}`)
}

function allowedAncestors(root: string, paths: ReadonlySet<string>): ReadonlySet<string> {
  const values = new Set<string>()
  for (const path of paths) {
    let parent = dirname(path)
    while (isInside(root, parent)) {
      values.add(parent)
      parent = dirname(parent)
    }
  }
  return values
}

async function assertNoUnselectedResidue(
  root: string,
  allowedFiles: ReadonlySet<string>,
  ignoredNonAuthorityDirectories: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<void> {
  const allowedDirectories = allowedAncestors(root, allowedFiles)
  const inspect = async (directory: string): Promise<void> => {
    signal.throwIfAborted()
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (isMissing(error) && directory === root) return
      throw error
    }
    for (const entry of entries) {
      signal.throwIfAborted()
      const path = resolve(directory, entry.name)
      if (entry.isDirectory() && ignoredNonAuthorityDirectories.has(path)) continue
      if (entry.isDirectory() && allowedDirectories.has(path)) {
        await inspect(path)
        continue
      }
      if (entry.isFile() && allowedFiles.has(path)) continue
      throw new SakiMaintenanceError(
        'recovery-required',
        `Saki Installation has unselected residue at '${path}'`,
      )
    }
  }
  await inspect(root)
}

/**
 * Select only the authority manifest, the exact configured B03 database, or fresh state.
 * No directory name, timestamp, journal, backup, or candidate is treated as authority.
 * @param installationRoot - root containing Installation metadata and generations.
 * @param legacyDatabasePath - exact B03 database configured by the old launcher.
 * @param signal - caller cancellation during bounded metadata inspection.
 * @returns the sole deterministic source classification.
 */
export async function selectSakiInstallationSource(
  installationRoot: string,
  legacyDatabasePath: string,
  signal: AbortSignal,
): Promise<SakiInstallationSource> {
  signal.throwIfAborted()
  const root = resolve(installationRoot)
  const manifest = await readInstallationManifest(root, signal)
  if (manifest !== undefined) {
    return {
      kind: 'selected-generation',
      selected: await readSelectedGeneration(root, manifest.value, signal),
    }
  }

  if (legacyDatabasePath === ':memory:') {
    throw new SakiMaintenanceError(
      'state-unsupported',
      'in-memory Saki state cannot participate in Installation maintenance',
    )
  }
  const legacyPath = resolve(legacyDatabasePath)
  const legacyExists = await regularFileExists(legacyPath)
  const legacyArtifacts = new Set(SQLITE_SIDECAR_SUFFIXES.map(suffix => `${legacyPath}${suffix}`))
  const lockPath = resolve(root, INSTALLATION_LOCK_LEAF)
  const allowedFiles = new Set(SQLITE_SIDECAR_SUFFIXES.map(suffix => `${lockPath}${suffix}`))
  allowedFiles.add(resolve(root, PENDING_OPERATION_LEAF))
  allowedFiles.add(resolve(root, ...SETTLED_OPERATION_LEAF.split('/')))
  allowedFiles.add(resolve(root, ...SETTLED_OPERATION_JOURNAL_LEAF.split('/')))
  if (legacyExists) {
    for (const path of legacyArtifacts) allowedFiles.add(path)
  } else {
    for (const sidecar of [...legacyArtifacts].slice(1)) {
      if (await regularFileExists(sidecar)) {
        throw new SakiMaintenanceError(
          'recovery-required',
          `legacy Saki database '${legacyPath}' is missing while a sidecar remains`,
        )
      }
    }
  }
  const ignoredNonAuthorityDirectories = legacyExists
    ? new Set([resolve(root, 'backups')])
    : new Set<string>()
  await assertNoUnselectedResidue(root, allowedFiles, ignoredNonAuthorityDirectories, signal)
  return legacyExists ? { kind: 'legacy-v2', databasePath: legacyPath } : { kind: 'fresh' }
}
