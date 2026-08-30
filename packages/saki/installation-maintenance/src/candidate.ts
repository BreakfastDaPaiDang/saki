/** Journal-derived creation and publication of one current Saki generation directory. */

import { lstat, mkdir } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import {
  generationManifestReference,
  generationManifestSchema,
  installationManifestSchema,
  readSelectedGeneration,
  renderGenerationManifest,
} from './manifest.ts'
import type { GenerationManifest, SelectedGeneration } from './manifest.ts'
import type { SakiOperationJournal } from './journal.ts'
import { publishMissingFile } from './durable-files.ts'
import type { DurableFileResult } from './durable-files.ts'
import { publishMissingDirectory } from './durable-directories.ts'
import { SakiMaintenanceError } from './error.ts'
import { sakiStateCapability } from './state-version.ts'
import type { NewSakiGenerationIdentity } from './generation.ts'
import {
  requireOwnedPathAncestors,
  validateOwnedPathAncestors,
} from './owned-path.ts'

/** Journal kind that owns a new candidate generation. */
export type CandidateOperationJournal = Extract<SakiOperationJournal, { readonly kind: 'fresh' | 'upgrade' }>

/** Candidate milestones exposed only for deterministic crash injection. */
export interface SakiCandidatePublicationEffects {
  /** Runs after the journal-owned partial directory is created. */
  readonly afterPartialCreation?: () => Promise<void>
  /** Runs after the complete candidate database is materialized. */
  readonly afterMaterialization?: () => Promise<void>
  /** Runs after immutable generation metadata is durable and before the final directory commit. */
  readonly afterGenerationManifestPublication?: () => Promise<void>
}

function isInside(root: string, path: string): boolean {
  const value = relative(root, path)
  return value !== '' && value !== '..' && !value.startsWith(`..${sep}`) && !value.includes(`..${sep}`)
}

function resolveLeaf(root: string, leaf: string): string {
  const path = resolve(root, ...leaf.split('/'))
  if (!isInside(root, path)) throw new Error(`Saki metadata leaf '${leaf}' escapes its Installation root`)
  return path
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

async function assertMissing(path: string): Promise<void> {
  try {
    await lstat(path)
  } catch (error) {
    if (isMissing(error)) return
    throw error
  }
  throw new SakiMaintenanceError('target-exists', `Saki maintenance target '${path}' already exists`)
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

/**
 * Build a journal-derived partial generation, publish its immutable metadata, and rename it final.
 * The Installation manifest remains untouched; callers validate product relationships before
 * publishing that sole authority.
 * @param installationRoot - Installation root held under its exclusive lease.
 * @param journal - selected immutable fresh or upgrade operation.
 * @param identity - identities fixed by the journal plus creator provenance.
 * @param signal - cancellation through the final directory commit.
 * @param materialize - creates the complete candidate database at the supplied missing path.
 * @param effects - optional phase-adjacent failures used by crash tests.
 * @returns exact generation selected through an in-memory authority document.
 */
export async function publishSakiGenerationCandidate(
  installationRoot: string,
  journal: CandidateOperationJournal,
  identity: NewSakiGenerationIdentity,
  signal: AbortSignal,
  materialize: (databasePath: string) => Promise<void>,
  effects: SakiCandidatePublicationEffects = {},
): Promise<SelectedGeneration> {
  signal.throwIfAborted()
  if (journal.installationId !== identity.installationId
    || journal.candidateStorageGenerationId !== identity.storageGenerationId) {
    throw new Error('Saki candidate identity disagrees with its immutable operation journal')
  }
  const root = resolve(installationRoot)
  const partial = resolveLeaf(root, journal.candidate.partialLeaf)
  const final = resolveLeaf(root, journal.candidate.finalLeaf)
  await validateOwnedPathAncestors(root, partial, signal)
  await mkdir(dirname(partial), { recursive: true, mode: 0o700 })
  await requireOwnedPathAncestors(root, partial, signal)
  await requireOwnedPathAncestors(root, final, signal)
  await assertMissing(partial)
  await assertMissing(final)
  await mkdir(partial, { mode: 0o700 })
  await effects.afterPartialCreation?.()
  const partialDatabasePath = resolve(partial, 'state.sqlite')
  await requireOwnedPathAncestors(root, partialDatabasePath, signal)
  await materialize(partialDatabasePath)
  await effects.afterMaterialization?.()
  await requireOwnedPathAncestors(root, partialDatabasePath, signal)
  const generationBytes = renderGenerationManifest(
    identity.installationId,
    identity.storageGenerationId,
    sakiStateCapability.writable.version,
    identity.createdByBuildId,
  )
  requireDurable(
    await publishMissingFile(resolve(partial, 'generation.json'), generationBytes, signal),
    'Saki generation manifest',
  )
  await effects.afterGenerationManifestPublication?.()
  signal.throwIfAborted()
  await requireOwnedPathAncestors(root, partialDatabasePath, signal)
  await requireOwnedPathAncestors(root, final, signal)
  requireDurable(
    await publishMissingDirectory(partial, final, signal),
    'Saki generation directory',
  )
  const generation: GenerationManifest = generationManifestSchema.parse({
    formatVersion: 1,
    ...identity,
    stateVersion: sakiStateCapability.writable.version,
    databaseLeaf: 'state.sqlite',
  })
  const reference = generationManifestReference(identity.storageGenerationId, generationBytes)
  const provisional = installationManifestSchema.parse({
    formatVersion: 1,
    phase: 'provisioning',
    installationId: generation.installationId,
    storageGenerationId: generation.storageGenerationId,
    stateVersion: generation.stateVersion,
    generationJson: reference,
  })
  return await readSelectedGeneration(root, provisional, new AbortController().signal)
}
