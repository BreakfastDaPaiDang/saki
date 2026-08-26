/** Strict Installation and generation manifests with exact integrity references. */

import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { TextDecoder } from 'node:util'
import { z } from 'zod'
import { parseLosslessJsonValue } from '@deepseek-ai/dsh-storage'
import {
  sakiBuildIdSchema,
  sakiInstallationIdSchema,
  sakiStorageGenerationIdSchema,
  type SakiBuildId,
  type SakiInstallationId,
  type SakiStorageGenerationId,
} from '@breakfastdapaidang/saki-control-plane'
import { asError, SakiMaintenanceError } from './error.ts'
import { validateOwnedPathAncestors } from './owned-path.ts'
import { readStableBoundedRegularFile } from './stable-files.ts'

const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const MAX_MANIFEST_BYTES = 16 * 1_024

/** Fixed Installation authority manifest leaf. */
export const INSTALLATION_MANIFEST_LEAF = 'installation.json' as const
/** Fixed mutable database leaf inside one physical generation. */
export const GENERATION_DATABASE_LEAF = 'state.sqlite' as const

const generationJsonLeafSchema = z.string()
  .max(200)
  .refine((value) => {
    const prefix = 'generations/'
    const suffix = '/generation.json'
    if (!value.startsWith(prefix) || !value.endsWith(suffix)) return false
    return sakiStorageGenerationIdSchema.safeParse(value.slice(prefix.length, -suffix.length)).success
  })

/** Exact byte evidence for one bounded manifest leaf. */
export const manifestReferenceSchema = z.object({
  leaf: generationJsonLeafSchema,
  byteLength: z.number().int().nonnegative().max(MAX_MANIFEST_BYTES),
  sha256: z.string().regex(SHA256_PATTERN),
}).strict()

/** Installation authority document; no filename or timestamp outside this record selects state. */
export const installationManifestSchema = z.object({
  formatVersion: z.literal(1),
  phase: z.enum(['provisioning', 'ready']),
  installationId: sakiInstallationIdSchema,
  storageGenerationId: sakiStorageGenerationIdSchema,
  stateVersion: z.number().int().nonnegative(),
  generationJson: manifestReferenceSchema,
}).strict().superRefine((value, context) => {
  if (value.generationJson.leaf !== generationJsonLeaf(value.storageGenerationId)) {
    context.addIssue({
      code: 'custom',
      path: ['generationJson', 'leaf'],
      message: 'generation.json leaf disagrees with storage generation identity',
    })
  }
})

/** Parsed Installation authority manifest. */
export type InstallationManifest = z.infer<typeof installationManifestSchema>

/** Immutable metadata beside one mutable physical generation database. */
export const generationManifestSchema = z.object({
  formatVersion: z.literal(1),
  installationId: sakiInstallationIdSchema,
  storageGenerationId: sakiStorageGenerationIdSchema,
  stateVersion: z.number().int().nonnegative(),
  createdByBuildId: sakiBuildIdSchema,
  databaseLeaf: z.literal(GENERATION_DATABASE_LEAF),
}).strict()

/** Parsed immutable generation metadata. */
export type GenerationManifest = z.infer<typeof generationManifestSchema>

/** Verified manifest bytes plus their exact integrity evidence. */
export interface ManifestBytes<T> {
  /** Parsed strict manifest. */
  readonly value: T
  /** Exact bytes read and hashed. */
  readonly bytes: Buffer
  /** Exact byte length. */
  readonly byteLength: number
  /** Lowercase SHA-256 of the exact bytes. */
  readonly sha256: string
}

/** Manifest-selected generation after the authority and referenced metadata agree. */
export interface SelectedGeneration {
  /** Strict Installation authority manifest. */
  readonly installation: InstallationManifest
  /** Strict referenced generation metadata. */
  readonly generation: GenerationManifest
  /** Absolute verified generation.json path. */
  readonly generationManifestPath: string
  /** Absolute database path selected through generation.json. */
  readonly databasePath: string
}

/**
 * Derive the sole allowed generation.json leaf for an identity.
 * @param storageGenerationId - strict physical generation identity.
 * @returns bounded POSIX-style leaf stored in the Installation manifest.
 */
export function generationJsonLeaf(storageGenerationId: SakiStorageGenerationId): string {
  return `generations/${storageGenerationId}/generation.json`
}

/**
 * Render canonical immutable generation metadata.
 * @param installationId - retained Installation identity.
 * @param storageGenerationId - physical generation identity.
 * @param stateVersion - product state-format version.
 * @param createdByBuildId - creator provenance only.
 * @returns strict UTF-8 JSON with one trailing newline.
 */
export function renderGenerationManifest(
  installationId: SakiInstallationId,
  storageGenerationId: SakiStorageGenerationId,
  stateVersion: number,
  createdByBuildId: SakiBuildId,
): Buffer {
  const value = generationManifestSchema.parse({
    formatVersion: 1,
    installationId,
    storageGenerationId,
    stateVersion,
    createdByBuildId,
    databaseLeaf: GENERATION_DATABASE_LEAF,
  })
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
}

/**
 * Build the exact reference stored by the Installation manifest.
 * @param storageGenerationId - physical generation identity owning the bytes.
 * @param bytes - canonical generation.json bytes.
 * @returns bounded leaf, exact length, and SHA-256.
 */
export function generationManifestReference(
  storageGenerationId: SakiStorageGenerationId,
  bytes: Buffer,
): z.infer<typeof manifestReferenceSchema> {
  return manifestReferenceSchema.parse({
    leaf: generationJsonLeaf(storageGenerationId),
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  })
}

/**
 * Render one canonical Installation authority manifest.
 * @param phase - non-serving provisioning or serving-ready state.
 * @param generation - exact immutable generation metadata.
 * @param reference - integrity evidence for its exact bytes.
 * @returns strict UTF-8 JSON with one trailing newline.
 */
export function renderInstallationManifest(
  phase: InstallationManifest['phase'],
  generation: GenerationManifest,
  reference: z.infer<typeof manifestReferenceSchema>,
): Buffer {
  const value = installationManifestSchema.parse({
    formatVersion: 1,
    phase,
    installationId: generation.installationId,
    storageGenerationId: generation.storageGenerationId,
    stateVersion: generation.stateVersion,
    generationJson: reference,
  })
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
}

async function readBounded(path: string, signal: AbortSignal): Promise<Buffer> {
  return await readStableBoundedRegularFile(path, signal, {
    byteLimit: MAX_MANIFEST_BYTES,
    description: `Saki manifest '${path}'`,
    invalid: message => new SakiMaintenanceError('manifest-invalid', message),
  }) as Buffer
}

async function readRequiredManifestBytes(path: string, signal: AbortSignal): Promise<Buffer> {
  try {
    return await readBounded(path, signal)
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted()
    if (error instanceof SakiMaintenanceError) throw error
    throw new SakiMaintenanceError(
      'manifest-invalid',
      `required Saki manifest '${path}' is missing or unreadable`,
      { cause: asError(error, `reading required Saki manifest '${path}' failed`) },
    )
  }
}

function parseManifest<T>(path: string, bytes: Buffer, schema: z.ZodType<T>): ManifestBytes<T> {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new SakiMaintenanceError('manifest-invalid', `Saki manifest '${path}' is not UTF-8`, { cause: error })
  }
  let raw: unknown
  try {
    raw = parseLosslessJsonValue(text)
  } catch (error) {
    throw new SakiMaintenanceError('manifest-invalid', `Saki manifest '${path}' is not strict JSON`, { cause: error })
  }
  let value: T
  try {
    value = schema.parse(raw)
  } catch (error) {
    throw new SakiMaintenanceError('manifest-invalid', `Saki manifest '${path}' has invalid fields`, { cause: error })
  }
  return {
    value,
    bytes,
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

/**
 * Read the sole Installation selector when present.
 * @param installationRoot - Installation metadata root.
 * @param signal - caller cancellation during bounded IO.
 * @returns strict manifest bytes, or `undefined` only when the selector is absent.
 */
export async function readInstallationManifest(
  installationRoot: string,
  signal: AbortSignal,
): Promise<ManifestBytes<InstallationManifest> | undefined> {
  const path = resolve(installationRoot, INSTALLATION_MANIFEST_LEAF)
  try {
    return parseManifest(path, await readBounded(path, signal), installationManifestSchema)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Resolve and verify exactly the generation selected by the Installation manifest.
 * @param installationRoot - Installation metadata root.
 * @param manifest - already-verified selector.
 * @param signal - caller cancellation during bounded IO.
 * @returns matching generation metadata and selected database path.
 */
export async function readSelectedGeneration(
  installationRoot: string,
  manifest: InstallationManifest,
  signal: AbortSignal,
): Promise<SelectedGeneration> {
  const generationManifestPath = resolve(
    installationRoot,
    ...manifest.generationJson.leaf.split('/'),
  )
  await validateOwnedPathAncestors(installationRoot, generationManifestPath, signal)
  const evidence = parseManifest(
    generationManifestPath,
    await readRequiredManifestBytes(generationManifestPath, signal),
    generationManifestSchema,
  )
  if (!await validateOwnedPathAncestors(installationRoot, generationManifestPath, signal)) {
    throw new SakiMaintenanceError(
      'manifest-invalid',
      `selected generation manifest '${generationManifestPath}' lost an Installation-owned ancestor`,
    )
  }
  if (evidence.byteLength !== manifest.generationJson.byteLength
    || evidence.sha256 !== manifest.generationJson.sha256) {
    throw new SakiMaintenanceError(
      'manifest-invalid',
      `selected generation manifest '${generationManifestPath}' fails its exact integrity reference`,
    )
  }
  const generation = evidence.value
  if (generation.installationId !== manifest.installationId
    || generation.storageGenerationId !== manifest.storageGenerationId
    || generation.stateVersion !== manifest.stateVersion) {
    throw new SakiMaintenanceError(
      'manifest-invalid',
      `selected generation manifest '${generationManifestPath}' disagrees with Installation authority`,
    )
  }
  return {
    installation: manifest,
    generation,
    generationManifestPath,
    databasePath: join(dirname(generationManifestPath), generation.databaseLeaf),
  }
}

/**
 * Verify one exact journal-named generation without granting it Installation authority.
 * This operation exists only to prove an unselected candidate's identity and contents before
 * journal-owned cleanup. Callers must never use its result to choose serving state.
 * @param installationRoot - Installation metadata root.
 * @param installationId - Installation identity fixed by the selected operation journal.
 * @param storageGenerationId - exact physical generation identity fixed by that journal.
 * @param signal - caller cancellation during both bounded exact metadata reads.
 * @returns generation evidence resolved through a provisional in-memory selector.
 */
export async function readUnselectedGeneration(
  installationRoot: string,
  installationId: SakiInstallationId,
  storageGenerationId: SakiStorageGenerationId,
  signal: AbortSignal,
): Promise<SelectedGeneration> {
  const leaf = generationJsonLeaf(storageGenerationId)
  const generationManifestPath = resolve(installationRoot, ...leaf.split('/'))
  await validateOwnedPathAncestors(installationRoot, generationManifestPath, signal)
  const evidence = parseManifest(
    generationManifestPath,
    await readRequiredManifestBytes(generationManifestPath, signal),
    generationManifestSchema,
  )
  if (!await validateOwnedPathAncestors(installationRoot, generationManifestPath, signal)) {
    throw new SakiMaintenanceError(
      'manifest-invalid',
      `unselected generation manifest '${generationManifestPath}' lost an Installation-owned ancestor`,
    )
  }
  const generation = evidence.value
  if (generation.installationId !== installationId
    || generation.storageGenerationId !== storageGenerationId) {
    throw new SakiMaintenanceError(
      'manifest-invalid',
      `unselected generation manifest '${generationManifestPath}' disagrees with its operation journal`,
    )
  }
  const provisional = installationManifestSchema.parse({
    formatVersion: 1,
    phase: 'provisioning',
    installationId,
    storageGenerationId,
    stateVersion: generation.stateVersion,
    generationJson: {
      leaf,
      byteLength: evidence.byteLength,
      sha256: evidence.sha256,
    },
  })
  return await readSelectedGeneration(installationRoot, provisional, signal)
}
