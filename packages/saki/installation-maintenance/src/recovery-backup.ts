/** Immutable Recovery Backup creation and exact verification. */

import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { TextDecoder } from 'node:util'
import { z } from 'zod'
import { parseLosslessJsonValue } from '@deepseek-ai/dsh-storage'
import {
  sakiBuildIdSchema,
  sakiInstallationIdSchema,
  sakiStorageGenerationIdSchema,
} from '@breakfastdapaidang/saki-control-plane'
import type {
  SakiBuildId,
  SakiInstallationId,
  SakiStorageGenerationId,
} from '@breakfastdapaidang/saki-control-plane'
import {
  assertSqliteArtifactSetUnchanged,
  captureSqliteArtifactSet,
} from './artifacts.ts'
import type {
  SqliteArtifactEvidence,
  SqliteArtifactSet,
} from './artifacts.ts'
import { movePathWin32WriteThrough } from './durable-directories.ts'
import { publishMissingFile } from './durable-files.ts'
import type { DurableFilePlatform, DurableFileResult } from './durable-files.ts'
import { SakiMaintenanceError } from './error.ts'
import {
  sakiRecoveryBackupIdSchema,
} from './journal.ts'
import type { SakiRecoveryBackupId } from './journal.ts'
import {
  protectRecoveryBackupPathWin32,
  requireRecoveryBackupPathOwnerOnlyWin32,
} from './recovery-backup-win32.ts'
import type { RecoveryBackupWindowsPathKind } from './recovery-backup-win32.ts'
import {
  readStableBoundedRegularFile,
  readStableRegularFileEvidence,
} from './stable-files.ts'
import type { StableRegularFileFailures } from './stable-files.ts'
import type { SakiStateCapability } from './state-version.ts'

const BACKUP_METADATA_LEAF = 'backup.json'
const BACKUP_DATABASE_LEAF = 'state.sqlite'
const MAX_BACKUP_METADATA_BYTES = 16 * 1_024
const MOVEFILE_WRITE_THROUGH = 0x00000008
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const NEVER_ABORT_SIGNAL = new AbortController().signal

const artifactSharedShape = {
  byteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(SHA256_PATTERN),
}

const recoveryBackupArtifactSchema = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('database'),
    suffix: z.literal(''),
    ...artifactSharedShape,
  }).strict(),
  z.object({
    role: z.literal('wal'),
    suffix: z.literal('-wal'),
    ...artifactSharedShape,
  }).strict(),
  z.object({
    role: z.literal('shm'),
    suffix: z.literal('-shm'),
    ...artifactSharedShape,
  }).strict(),
  z.object({
    role: z.literal('journal'),
    suffix: z.literal('-journal'),
    ...artifactSharedShape,
  }).strict(),
])

const ARTIFACT_ORDER = Object.freeze(['database', 'wal', 'shm', 'journal'] as const)

/** Strict canonical metadata stored at `backup.json`. */
export const recoveryBackupManifestSchema = z.object({
  formatVersion: z.literal(1),
  purpose: z.literal('recovery-backup'),
  backupId: sakiRecoveryBackupIdSchema,
  installationId: sakiInstallationIdSchema,
  storageGenerationId: sakiStorageGenerationIdSchema,
  stateVersion: z.union([
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5),
    z.literal(6),
    z.literal(7),
    z.literal(8),
  ]),
  sourceBuildId: sakiBuildIdSchema,
  databaseLeaf: z.literal(BACKUP_DATABASE_LEAF),
  artifacts: z.array(recoveryBackupArtifactSchema).min(1).max(4),
}).strict().superRefine((value, context) => {
  if (value.artifacts[0]?.role !== 'database') {
    context.addIssue({
      code: 'custom',
      path: ['artifacts'],
      message: 'Recovery Backup inventory must begin with its database',
    })
  }
  let prior = -1
  for (const [index, artifact] of value.artifacts.entries()) {
    const position = ARTIFACT_ORDER.indexOf(artifact.role)
    if (position <= prior) {
      context.addIssue({
        code: 'custom',
        path: ['artifacts', index],
        message: 'Recovery Backup inventory is duplicated or out of canonical order',
      })
    }
    prior = position
  }
})

/** Parsed strict Recovery Backup metadata. */
export type RecoveryBackupManifest = z.infer<typeof recoveryBackupManifestSchema>

/** Identity and state provenance fixed before a Recovery Backup is copied. */
export interface RecoveryBackupCreateRequest {
  /** Installation retained by the backup. */
  readonly installationId: SakiInstallationId
  /** Physical storage generation copied into the backup. */
  readonly storageGenerationId: SakiStorageGenerationId
  /** Product-state format of the copied database. */
  readonly stateVersion: 2 | 3 | 4 | 5 | 6 | 7 | 8
  /** Build provenance; this value never decides readability. */
  readonly sourceBuildId: SakiBuildId
}

/** Exact verified Recovery Backup and its physical artifact evidence. */
export interface VerifiedRecoveryBackup {
  /** Strict canonical backup metadata. */
  readonly manifest: RecoveryBackupManifest
  /** Absolute final directory derived from Installation root and backup identity. */
  readonly directory: string
  /** Canonical main database path inside the final directory. */
  readonly databasePath: string
  /** Fresh exact evidence for the database and all declared sidecars. */
  readonly artifacts: SqliteArtifactSet
}

/** Successful final-directory publication evidence. */
export type RecoveryBackupPublication =
  | {
    /** The final directory rename and namespace durability completed. */
    readonly outcome: 'durable'
    /** Immediate exact readback of the published backup. */
    readonly backup: VerifiedRecoveryBackup
  }
  | {
    /** The exact final backup is visible, but namespace durability was not confirmed. */
    readonly outcome: 'published'
    /** Immediate exact readback of the published backup. */
    readonly backup: VerifiedRecoveryBackup
    /** Failure at or after the directory commit. */
    readonly cause: Error
  }

/** Final-directory state observed after a possibly committed rename. */
export type RecoveryBackupFinalState = 'different' | 'missing' | 'unreadable'

/** A directory commit may have occurred, but exact final verification cannot prove it. */
export class RecoveryBackupOutcomeUnknownError extends Error {
  /** Stable machine-readable failure class. */
  readonly code = 'publication-outcome-unknown' as const
  /** Recovery must assume the final directory may have been published. */
  readonly publicationPossible = true as const
  /** Final-path evidence that prevented exact publication confirmation. */
  readonly finalState: RecoveryBackupFinalState

  /**
   * @param directory - derived final Recovery Backup directory.
   * @param finalState - exact final-path classification.
   * @param cause - rename, durability, or verification failure.
   */
  constructor(directory: string, finalState: RecoveryBackupFinalState, cause: Error) {
    super(`Recovery Backup publication at '${directory}' has an unknown outcome`, { cause })
    this.name = 'RecoveryBackupOutcomeUnknownError'
    this.finalState = finalState
  }
}

/** Why a callback-scoped missing-target reservation was rejected. */
export type MissingTargetReservationFailure = 'consumed' | 'expired' | 'foreign'

/** Use of a missing-target reservation outside its sole owner and callback lifetime. */
export class MissingTargetReservationError extends Error {
  /** Stable machine-readable failure class. */
  readonly code = 'missing-target-reservation-invalid' as const
  /** Exact reservation invariant that failed. */
  readonly reason: MissingTargetReservationFailure

  /**
   * @param reason - exact reservation invariant that failed.
   */
  constructor(reason: MissingTargetReservationFailure) {
    super(`Recovery Backup missing-target reservation is ${reason}`)
    this.name = 'MissingTargetReservationError'
    this.reason = reason
  }
}

declare const reservationBrand: unique symbol

/** Unforgeable callback-scoped authority to consume one derived missing target. */
export interface MissingTargetReservation {
  /** Backup identity whose partial and final paths were reserved. */
  readonly backupId: SakiRecoveryBackupId
  /** Compile-time nominal marker; runtime ownership is held privately. */
  readonly [reservationBrand]: true
}

/** Injectable final-directory and metadata effects for focused fault tests. */
export interface RecoveryBackupEffects {
  /** Override the Host directory-publication family. */
  readonly platform?: DurableFilePlatform
  /** Observe or fail immediately before the final missing-target check. */
  readonly beforeFinalize?: (partialDirectory: string, finalDirectory: string) => Promise<void>
  /** Observe or fail immediately after the directory commit. */
  readonly afterFinalize?: (partialDirectory: string, finalDirectory: string) => Promise<void>
  /** Override POSIX directory synchronization. */
  readonly syncDirectory?: (directory: string) => Promise<void>
  /** Override the complete directory move for commit-outcome fault tests. */
  readonly moveDirectory?: (partialDirectory: string, finalDirectory: string) => Promise<void>
  /** Override the native Windows directory move while retaining production flags. */
  readonly moveDirectoryWin32?: (
    partialDirectory: string,
    finalDirectory: string,
    flags: number,
  ) => Promise<void>
  /** Override create-only metadata publication. */
  readonly publishMetadata?: (
    path: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ) => Promise<DurableFileResult>
  /** Override protected owner-plus-LocalSystem DACL effects for focused tests. */
  readonly windowsAcl?: RecoveryBackupWindowsAcl
}

/** Injectable exact Windows DACL operations used by Recovery Backup paths. */
export interface RecoveryBackupWindowsAcl {
  /**
   * Replace a path's DACL with the protected Recovery Backup policy.
   * @param path - existing path to protect.
   * @param kind - file or descendant-inheriting directory policy.
   * @param signal - cancellation observed around native calls.
   */
  protect(
    path: string,
    kind: RecoveryBackupWindowsPathKind,
    signal: AbortSignal,
  ): Promise<void>
  /**
   * Require the exact protected Recovery Backup policy.
   * @param path - existing path to inspect.
   * @param kind - file or descendant-inheriting directory policy.
   * @param signal - cancellation observed around native calls.
   */
  require(
    path: string,
    kind: RecoveryBackupWindowsPathKind,
    signal: AbortSignal,
  ): Promise<void>
}

/** Bound Recovery Backup reservation, creation, and verification operations. */
export interface RecoveryBackupStore {
  /**
   * Reserve journal-derived missing partial and final directories for one callback.
   * @param installationRoot - trusted Installation metadata root.
   * @param backupId - strict journal-owned Recovery Backup identity.
   * @param signal - cancellation observed throughout reservation.
   * @param callback - sole lifetime in which the reservation may be consumed.
   * @returns callback result.
   */
  withMissingTarget<T>(
    installationRoot: string,
    backupId: SakiRecoveryBackupId,
    signal: AbortSignal,
    callback: (reservation: MissingTargetReservation) => T | Promise<T>,
  ): Promise<T>
  /**
   * Copy, publish, and verify one captured SQLite state into a reserved backup.
   * @param reservation - active one-shot missing-target authority.
   * @param source - already captured SQLite artifact set.
   * @param request - Installation, generation, state-version, and provenance metadata.
   * @param capability - code-owned state readability used without build-id comparison.
   * @param signal - cancellation observed until the final directory commit.
   * @returns durable or exact visible final publication evidence.
   */
  create(
    reservation: MissingTargetReservation,
    source: SqliteArtifactSet,
    request: RecoveryBackupCreateRequest,
    capability: SakiStateCapability,
    signal: AbortSignal,
  ): Promise<RecoveryBackupPublication>
  /**
   * Verify only the final directory selected by an explicit backup identity.
   * @param installationRoot - trusted Installation metadata root.
   * @param backupId - exact final Recovery Backup identity to inspect.
   * @param capability - code-owned state readability.
   * @param signal - caller cancellation throughout bounded reads and hashes.
   * @returns exact strict metadata and fresh artifact evidence.
   */
  verify(
    installationRoot: string,
    backupId: SakiRecoveryBackupId,
    capability: SakiStateCapability,
    signal: AbortSignal,
  ): Promise<VerifiedRecoveryBackup>
}

interface ReservationState {
  readonly owner: symbol
  readonly backupId: SakiRecoveryBackupId
  readonly partialDirectory: string
  readonly finalDirectory: string
  active: boolean
  consumed: boolean
}

interface BackupPaths {
  readonly backupId: SakiRecoveryBackupId
  readonly installationRoot: string
  readonly backupsDirectory: string
  readonly partialDirectory: string
  readonly finalDirectory: string
}

type FinalReadback =
  | { readonly state: 'exact'; readonly backup: VerifiedRecoveryBackup }
  | { readonly state: RecoveryBackupFinalState; readonly cause: Error }

const reservations = new WeakMap<object, ReservationState>()

/* v8 ignore start -- this classifier requires external replacement of an owned, just-synced backup file. */
const recoveryBackupCopyFailures = Object.freeze({
  invalid(path, reason) {
    const message = reason === 'not-regular'
      ? 'copied Recovery Backup artifact is not a regular file'
      : `copied Recovery Backup artifact changed while ${reason === 'changed-opening' ? 'opening' : 'hashing'}`
    return recoveryFailure(path, new Error(message))
  },
} satisfies StableRegularFileFailures)
/* v8 ignore stop */

const nativeWindowsAcl: RecoveryBackupWindowsAcl = Object.freeze({
  protect: protectRecoveryBackupPathWin32,
  require: requireRecoveryBackupPathOwnerOnlyWin32,
})

/**
 * Render the only canonical `backup.json` byte representation.
 * @param manifest - complete strict Recovery Backup metadata.
 * @returns UTF-8 compact JSON with one trailing newline.
 */
export function renderRecoveryBackupManifest(manifest: RecoveryBackupManifest): Buffer {
  const value = recoveryBackupManifestSchema.parse(manifest)
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
  /* v8 ignore next 3 -- the strict schema bounds all fields and at most four artifacts below 16 KiB. */
  if (bytes.byteLength > MAX_BACKUP_METADATA_BYTES) {
    throw new SakiMaintenanceError('recovery-required', 'Recovery Backup metadata exceeds 16 KiB')
  }
  return bytes
}

/**
 * Bind Recovery Backup operations to optional finalization fault effects.
 * @param effects - platform and publication-adjacent effects.
 * @returns bound reservation, creation, and verification operations.
 */
export function createRecoveryBackupStore(
  effects: RecoveryBackupEffects = {},
): RecoveryBackupStore {
  const owner = Symbol('RecoveryBackupStore')
  const platform = effects.platform ?? hostDurableFilePlatform()
  const accessPlatform = effects.windowsAcl === undefined
    ? hostDurableFilePlatform()
    : platform
  const windowsAcl = effects.windowsAcl ?? nativeWindowsAcl
  const synchronizeDirectory = effects.syncDirectory ?? syncDirectory

  const withMissingTarget = async <T>(
    installationRoot: string,
    backupId: SakiRecoveryBackupId,
    signal: AbortSignal,
    callback: (reservation: MissingTargetReservation) => T | Promise<T>,
  ): Promise<T> => {
    signal.throwIfAborted()
    const paths = backupPaths(installationRoot, backupId)
    await requirePrivateInstallationRoot(paths.installationRoot, signal)
    const createdBackupsDirectory = await ensurePrivateBackupsDirectory(paths.backupsDirectory, signal)
    await requireMissing(paths.partialDirectory)
    await requireMissing(paths.finalDirectory)
    signal.throwIfAborted()
    try {
      await mkdir(paths.partialDirectory, { mode: 0o700 })
    /* v8 ignore start -- only an out-of-lease creator can race the two missing-target checks. */
    } catch (error) {
      if (isExists(error)) throw targetExists(paths.partialDirectory, error)
      throw error
    }
    /* v8 ignore stop */
    /* v8 ignore else -- POSIX CI covers owner-mode directories; Windows covers protected DACLs. */
    if (accessPlatform === 'win32') {
      await protectWindowsPath(
        windowsAcl,
        paths.partialDirectory,
        'directory',
        signal,
      )
    } else {
      await chmod(paths.partialDirectory, 0o700)
    }
    if (platform === 'posix') {
      await synchronizeDirectory(paths.backupsDirectory)
      if (createdBackupsDirectory) {
        await synchronizeDirectory(paths.installationRoot)
      }
    }
    signal.throwIfAborted()
    const reservation = Object.freeze({ backupId: paths.backupId }) as MissingTargetReservation
    const state: ReservationState = {
      owner,
      backupId: paths.backupId,
      partialDirectory: paths.partialDirectory,
      finalDirectory: paths.finalDirectory,
      active: true,
      consumed: false,
    }
    reservations.set(reservation, state)
    try {
      return await callback(reservation)
    } finally {
      state.active = false
    }
  }

  const create = async (
    reservation: MissingTargetReservation,
    source: SqliteArtifactSet,
    request: RecoveryBackupCreateRequest,
    capability: SakiStateCapability,
    signal: AbortSignal,
  ): Promise<RecoveryBackupPublication> => {
    const state = consumeReservation(reservation, owner)
    let result: RecoveryBackupPublication | undefined
    let operationFailure: unknown
    try {
      result = await createReservedBackup(
        state,
        source,
        request,
        capability,
        signal,
        effects,
        platform,
        accessPlatform,
        windowsAcl,
        synchronizeDirectory,
      )
    } catch (error) {
      operationFailure = error
    }
    let sourceFailure: unknown
    try {
      await assertSqliteArtifactSetUnchanged(source, NEVER_ABORT_SIGNAL)
    } catch (error) {
      sourceFailure = error
    }
    if (operationFailure !== undefined && sourceFailure !== undefined) {
      throw new AggregateError(
        [operationFailure, sourceFailure],
        'Recovery Backup creation and final source verification both failed',
      )
    }
    if (operationFailure !== undefined) {
      throw asError(operationFailure, 'Recovery Backup creation failed')
    }
    if (sourceFailure !== undefined) {
      throw asError(sourceFailure, 'Recovery Backup source verification failed')
    }
    /* v8 ignore next -- createReservedBackup either returns a publication or supplies operationFailure. */
    if (result === undefined) throw new Error('Recovery Backup creation produced no result')
    return result
  }

  return {
    withMissingTarget,
    create,
    verify: async (installationRoot, backupId, capability, signal) => {
      const paths = backupPaths(installationRoot, backupId)
      return await verifyRecoveryBackupAt(
        paths.finalDirectory,
        paths.backupId,
        capability,
        signal,
        accessPlatform,
        windowsAcl,
      )
    },
  }
}

const defaultStore = createRecoveryBackupStore()

/**
 * Reserve journal-derived missing backup directories for one callback.
 * @param installationRoot - trusted Installation metadata root.
 * @param backupId - strict journal-owned Recovery Backup identity.
 * @param signal - cancellation observed throughout reservation.
 * @param callback - sole lifetime in which the reservation may be consumed.
 * @returns callback result.
 */
export async function withMissingRecoveryBackupTarget<T>(
  installationRoot: string,
  backupId: SakiRecoveryBackupId,
  signal: AbortSignal,
  callback: (reservation: MissingTargetReservation) => T | Promise<T>,
): Promise<T> {
  return await defaultStore.withMissingTarget(installationRoot, backupId, signal, callback)
}

/**
 * Copy and publish a captured SQLite state through a default reservation.
 * @param reservation - active one-shot missing-target authority.
 * @param source - already captured SQLite artifact set.
 * @param request - Installation, generation, state-version, and provenance metadata.
 * @param capability - code-owned state readability used without build-id comparison.
 * @param signal - cancellation observed until the final directory commit.
 * @returns durable or exact visible final publication evidence.
 */
export async function createRecoveryBackup(
  reservation: MissingTargetReservation,
  source: SqliteArtifactSet,
  request: RecoveryBackupCreateRequest,
  capability: SakiStateCapability,
  signal: AbortSignal,
): Promise<RecoveryBackupPublication> {
  return await defaultStore.create(reservation, source, request, capability, signal)
}

/**
 * Verify only the final Recovery Backup selected by an explicit identity.
 * @param installationRoot - trusted Installation metadata root.
 * @param backupId - exact final Recovery Backup identity to inspect.
 * @param capability - code-owned state readability.
 * @param signal - caller cancellation throughout bounded reads and hashes.
 * @returns exact strict metadata and fresh artifact evidence.
 */
export async function verifyRecoveryBackup(
  installationRoot: string,
  backupId: SakiRecoveryBackupId,
  capability: SakiStateCapability,
  signal: AbortSignal,
): Promise<VerifiedRecoveryBackup> {
  return await defaultStore.verify(installationRoot, backupId, capability, signal)
}

async function createReservedBackup(
  reservation: ReservationState,
  source: SqliteArtifactSet,
  request: RecoveryBackupCreateRequest,
  capability: SakiStateCapability,
  signal: AbortSignal,
  effects: RecoveryBackupEffects,
  platform: DurableFilePlatform,
  accessPlatform: DurableFilePlatform,
  windowsAcl: RecoveryBackupWindowsAcl,
  synchronizeDirectory: (directory: string) => Promise<void>,
): Promise<RecoveryBackupPublication> {
  signal.throwIfAborted()
  requireReservationActive(reservation)
  if (capability.resolveReadable(request.stateVersion) === undefined) {
    throw unsupportedState(request.stateVersion)
  }
  const manifest = recoveryBackupManifestSchema.parse({
    formatVersion: 1,
    purpose: 'recovery-backup',
    backupId: reservation.backupId,
    installationId: request.installationId,
    storageGenerationId: request.storageGenerationId,
    stateVersion: request.stateVersion,
    sourceBuildId: request.sourceBuildId,
    databaseLeaf: BACKUP_DATABASE_LEAF,
    artifacts: source.artifacts.map(({ role, suffix, byteLength, sha256 }) => ({
      role,
      suffix,
      byteLength,
      sha256,
    })),
  })
  await assertSqliteArtifactSetUnchanged(source, signal)
  for (const artifact of source.artifacts) {
    requireReservationActive(reservation)
    await copyArtifact(
      artifact,
      join(reservation.partialDirectory, `${BACKUP_DATABASE_LEAF}${artifact.suffix}`),
      signal,
      accessPlatform,
      windowsAcl,
    )
  }
  requireReservationActive(reservation)
  const metadataBytes = renderRecoveryBackupManifest(manifest)
  const metadataPath = join(reservation.partialDirectory, BACKUP_METADATA_LEAF)
  await (effects.publishMetadata ?? publishMissingFile)(metadataPath, metadataBytes, signal)
  /* v8 ignore else -- POSIX CI covers owner-mode metadata; Windows covers protected DACLs. */
  if (accessPlatform === 'win32') {
    await protectWindowsPath(windowsAcl, metadataPath, 'file', signal)
  } else {
    await setOwnerFileMode(metadataPath)
  }
  if (platform === 'posix') {
    await synchronizeDirectory(reservation.partialDirectory)
  }
  signal.throwIfAborted()
  requireReservationActive(reservation)
  await verifyRecoveryBackupAt(
    reservation.partialDirectory,
    reservation.backupId,
    capability,
    signal,
    accessPlatform,
    windowsAcl,
  )
  return await finalizeBackup(
    reservation,
    capability,
    signal,
    effects,
    platform,
    accessPlatform,
    windowsAcl,
    synchronizeDirectory,
  )
}

async function finalizeBackup(
  reservation: ReservationState,
  capability: SakiStateCapability,
  signal: AbortSignal,
  effects: RecoveryBackupEffects,
  platform: DurableFilePlatform,
  accessPlatform: DurableFilePlatform,
  windowsAcl: RecoveryBackupWindowsAcl,
  synchronizeDirectory: (directory: string) => Promise<void>,
): Promise<RecoveryBackupPublication> {
  signal.throwIfAborted()
  requireReservationActive(reservation)
  await effects.beforeFinalize?.(reservation.partialDirectory, reservation.finalDirectory)
  signal.throwIfAborted()
  requireReservationActive(reservation)
  await requireMissing(reservation.finalDirectory)

  let move: () => Promise<void>
  if (effects.moveDirectory !== undefined) {
    const injectedMove = effects.moveDirectory
    move = async () => {
      await injectedMove(reservation.partialDirectory, reservation.finalDirectory)
    }
  } else if (platform === 'win32') {
    const injectedMove = effects.moveDirectoryWin32
    if (injectedMove !== undefined) {
      move = async () => {
        await injectedMove(
          reservation.partialDirectory,
          reservation.finalDirectory,
          MOVEFILE_WRITE_THROUGH,
        )
      }
    } else {
      move = () => movePathWin32WriteThrough(
        reservation.partialDirectory,
        reservation.finalDirectory,
        false,
        signal,
      )
    }
  } else {
    move = async () => {
      await rename(reservation.partialDirectory, reservation.finalDirectory)
    }
  }
  signal.throwIfAborted()
  requireReservationActive(reservation)

  let commitFailure: Error | undefined
  try {
    await move()
  } catch (error) {
    if (isExists(error)) throw targetExists(reservation.finalDirectory, error)
    commitFailure = asError(error, 'Recovery Backup directory move failed')
  }
  if (commitFailure !== undefined) {
    return await classifyFinalPublication(
      reservation.finalDirectory,
      reservation.backupId,
      capability,
      commitFailure,
      accessPlatform,
      windowsAcl,
    )
  }

  const postCommitFailures: Error[] = []
  try {
    await effects.afterFinalize?.(reservation.partialDirectory, reservation.finalDirectory)
  } catch (error) {
    postCommitFailures.push(asError(error, 'post-publication Recovery Backup effect failed'))
  }
  if (platform === 'posix') {
    try {
      await synchronizeDirectory(dirname(reservation.finalDirectory))
    } catch (error) {
      postCommitFailures.push(asError(error, 'Recovery Backup parent-directory sync failed'))
    }
  }
  const cause = postCommitFailures.length === 0
    ? undefined
    : combineFailures(postCommitFailures)
  return await classifyFinalPublication(
    reservation.finalDirectory,
    reservation.backupId,
    capability,
    cause,
    accessPlatform,
    windowsAcl,
  )
}

async function classifyFinalPublication(
  finalDirectory: string,
  backupId: SakiRecoveryBackupId,
  capability: SakiStateCapability,
  publicationFailure: Error | undefined,
  platform: DurableFilePlatform,
  windowsAcl: RecoveryBackupWindowsAcl,
): Promise<RecoveryBackupPublication> {
  const readback = await readFinal(finalDirectory, backupId, capability, platform, windowsAcl)
  if (readback.state === 'exact') {
    return publicationFailure === undefined
      ? { outcome: 'durable', backup: readback.backup }
      : { outcome: 'published', backup: readback.backup, cause: publicationFailure }
  }
  const cause = publicationFailure === undefined
    ? readback.cause
    : combineFailures([publicationFailure, readback.cause])
  throw new RecoveryBackupOutcomeUnknownError(finalDirectory, readback.state, cause)
}

async function readFinal(
  finalDirectory: string,
  backupId: SakiRecoveryBackupId,
  capability: SakiStateCapability,
  platform: DurableFilePlatform,
  windowsAcl: RecoveryBackupWindowsAcl,
): Promise<FinalReadback> {
  try {
    const info = await lstat(finalDirectory)
    if (!info.isDirectory()) {
      return {
        state: 'different',
        cause: recoveryFailure(finalDirectory, new Error('final path is not a directory')),
      }
    }
  } catch (error) {
    /* v8 ignore next 3 -- the alternative needs a Host permission or I/O failure before inspection. */
    if (!isMissing(error)) {
      return { state: 'unreadable', cause: asError(error, 'final Recovery Backup is unreadable') }
    }
    return { state: 'missing', cause: asError(error, 'final Recovery Backup is missing') }
  }
  try {
    return {
      state: 'exact',
      backup: await verifyRecoveryBackupAt(
        finalDirectory,
        backupId,
        capability,
        NEVER_ABORT_SIGNAL,
        platform,
        windowsAcl,
      ),
    }
  } catch (error) {
    const cause = asError(error, 'final Recovery Backup verification failed')
    return { state: 'different', cause }
  }
}

async function verifyRecoveryBackupAt(
  directory: string,
  backupId: SakiRecoveryBackupId,
  capability: SakiStateCapability,
  signal: AbortSignal,
  platform: DurableFilePlatform,
  windowsAcl: RecoveryBackupWindowsAcl,
): Promise<VerifiedRecoveryBackup> {
  try {
    return await verifyRecoveryBackupAtUnchecked(
      directory,
      backupId,
      capability,
      signal,
      platform,
      windowsAcl,
    )
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof SakiMaintenanceError) throw error
    throw recoveryFailure(directory, error)
  }
}

async function verifyRecoveryBackupAtUnchecked(
  directory: string,
  backupId: SakiRecoveryBackupId,
  capability: SakiStateCapability,
  signal: AbortSignal,
  platform: DurableFilePlatform,
  windowsAcl: RecoveryBackupWindowsAcl,
): Promise<VerifiedRecoveryBackup> {
  signal.throwIfAborted()
  const directoryInfo = await lstat(directory)
  if (!directoryInfo.isDirectory()) {
    throw recoveryFailure(directory, new Error('Recovery Backup path is not a real directory'))
  }
  /* v8 ignore else -- POSIX CI covers owner-mode directories; Windows covers protected DACLs. */
  if (platform === 'win32') {
    await requireWindowsPath(windowsAcl, directory, 'directory', signal)
  } else if ((directoryInfo.mode & 0o777) !== 0o700) {
    throw recoveryFailure(directory, new Error('Recovery Backup directory is not owner-only'))
  }
  const metadataPath = join(directory, BACKUP_METADATA_LEAF)
  const metadataBytes = await readBoundedMetadata(metadataPath, signal)
  const manifest = parseRecoveryBackupManifest(metadataPath, metadataBytes, capability)
  if (manifest.backupId !== backupId) {
    throw recoveryFailure(metadataPath, new Error('Recovery Backup identity disagrees with its directory'))
  }
  const expectedLeaves = [
    BACKUP_METADATA_LEAF,
    ...manifest.artifacts.map(artifact => `${manifest.databaseLeaf}${artifact.suffix}`),
  ].sort()
  const beforeLeaves = (await readdir(directory)).sort()
  if (!sameStrings(beforeLeaves, expectedLeaves)) {
    throw recoveryFailure(directory, new Error('Recovery Backup artifact inventory is not exact'))
  }
  for (const leaf of expectedLeaves) {
    const info = await lstat(join(directory, leaf))
    if (!info.isFile()) {
      throw recoveryFailure(join(directory, leaf), new Error('Recovery Backup entry is not a regular file'))
    }
    /* v8 ignore else -- POSIX CI covers owner-mode files; Windows covers protected DACLs. */
    if (platform === 'win32') {
      await requireWindowsPath(windowsAcl, join(directory, leaf), 'file', signal)
    } else if ((info.mode & 0o777) !== 0o600) {
      throw recoveryFailure(join(directory, leaf), new Error('Recovery Backup entry is not owner-only'))
    }
  }
  const databasePath = join(directory, manifest.databaseLeaf)
  const artifacts = await captureSqliteArtifactSet(databasePath, signal)
  if (!sameManifestArtifacts(manifest, artifacts)) {
    throw recoveryFailure(directory, new Error('Recovery Backup artifact bytes disagree with metadata'))
  }
  const afterLeaves = (await readdir(directory)).sort()
  /* v8 ignore next 3 -- detects a namespace mutation racing the two exact inventory reads. */
  if (!sameStrings(beforeLeaves, afterLeaves)) {
    throw recoveryFailure(directory, new Error('Recovery Backup inventory changed during verification'))
  }
  signal.throwIfAborted()
  return { manifest, directory, databasePath, artifacts }
}

function parseRecoveryBackupManifest(
  path: string,
  bytes: Buffer,
  capability: SakiStateCapability,
): RecoveryBackupManifest {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw recoveryFailure(path, new Error('Recovery Backup metadata is not UTF-8', { cause: error }))
  }
  let raw: unknown
  try {
    raw = parseLosslessJsonValue(text)
  } catch (error) {
    throw recoveryFailure(path, new Error('Recovery Backup metadata is not strict JSON', { cause: error }))
  }
  const rawStateVersion = raw !== null && typeof raw === 'object' && 'stateVersion' in raw
    ? raw.stateVersion
    : undefined
  if (typeof rawStateVersion === 'number'
    && capability.resolveReadable(rawStateVersion) === undefined) {
    throw unsupportedState(rawStateVersion)
  }
  let manifest: RecoveryBackupManifest
  try {
    manifest = recoveryBackupManifestSchema.parse(raw)
  } catch (error) {
    throw recoveryFailure(path, new Error('Recovery Backup metadata has invalid fields', { cause: error }))
  }
  if (!renderRecoveryBackupManifest(manifest).equals(bytes)) {
    throw recoveryFailure(path, new Error('Recovery Backup metadata is not canonical JSON'))
  }
  return manifest
}

async function readBoundedMetadata(path: string, signal: AbortSignal): Promise<Buffer> {
  return await readStableBoundedRegularFile(path, signal, {
    byteLimit: MAX_BACKUP_METADATA_BYTES,
    description: `Recovery Backup metadata '${path}'`,
    invalid: message => recoveryFailure(path, new Error(message)),
  }) as Buffer
}

async function copyArtifact(
  source: SqliteArtifactEvidence,
  targetPath: string,
  signal: AbortSignal,
  platform: DurableFilePlatform,
  windowsAcl: RecoveryBackupWindowsAcl,
): Promise<void> {
  signal.throwIfAborted()
  const sourceHandle = await open(source.path, 'r')
  let targetHandle: Awaited<ReturnType<typeof open>> | undefined
  let operationFailure: unknown
  try {
    targetHandle = await open(targetPath, 'wx', 0o600)
    /* v8 ignore else -- POSIX CI covers owner-mode artifacts; Windows covers protected DACLs. */
    if (platform === 'win32') {
      await protectWindowsPath(windowsAcl, targetPath, 'file', signal)
    } else {
      await targetHandle.chmod(0o600)
    }
    const buffer = Buffer.allocUnsafe(64 * 1_024)
    let readOffset = 0
    for (;;) {
      signal.throwIfAborted()
      const result = await sourceHandle.read(buffer, 0, buffer.byteLength, readOffset)
      if (result.bytesRead === 0) break
      let written = 0
      while (written < result.bytesRead) {
        signal.throwIfAborted()
        const write = await targetHandle.write(
          buffer,
          written,
          result.bytesRead - written,
          readOffset + written,
        )
        /* v8 ignore next -- a successful regular-file write cannot make zero progress. */
        if (write.bytesWritten === 0) throw new Error(`zero-byte write to '${targetPath}'`)
        written += write.bytesWritten
      }
      readOffset += result.bytesRead
    }
    await targetHandle.sync()
  } catch (error) {
    operationFailure = error
  }
  const closeResults = await Promise.allSettled([
    sourceHandle.close(),
    targetHandle?.close() ?? Promise.resolve(),
  ])
  const failures: unknown[] = []
  if (operationFailure !== undefined) failures.push(operationFailure)
  for (const result of closeResults) {
    /* v8 ignore next -- descriptor-close rejection requires a Host I/O fault after copy work settled. */
    if (result.status === 'rejected') failures.push(result.reason as unknown)
  }
  /* v8 ignore next 4 -- multiple failures require a copy failure plus a descriptor-close double fault. */
  if (failures.length > 1) {
    throw new AggregateError(failures, `copying Recovery Backup artifact '${source.path}' failed`)
  }
  if (failures.length === 1) throw failures[0]
  const copied = await stableDigest(targetPath, signal)
  /* v8 ignore next 5 -- stableDigest just read the owned synced target; this guards a Host/filesystem fault. */
  if (copied.byteLength !== source.byteLength || copied.sha256 !== source.sha256) {
    throw new SakiMaintenanceError(
      'source-changed',
      `copied Recovery Backup artifact '${targetPath}' failed exact verification`,
    )
  }
}

async function stableDigest(
  path: string,
  signal: AbortSignal,
): Promise<{ readonly byteLength: number; readonly sha256: string }> {
  const evidence = await readStableRegularFileEvidence(path, signal, recoveryBackupCopyFailures)
  return { byteLength: evidence.byteLength, sha256: evidence.sha256 }
}

function consumeReservation(
  reservation: MissingTargetReservation,
  owner: symbol,
): ReservationState {
  const state = reservations.get(reservation)
  if (state === undefined || state.owner !== owner) {
    throw new MissingTargetReservationError('foreign')
  }
  if (!state.active) throw new MissingTargetReservationError('expired')
  if (state.consumed) throw new MissingTargetReservationError('consumed')
  state.consumed = true
  return state
}

function requireReservationActive(reservation: ReservationState): void {
  if (!reservation.active) throw new MissingTargetReservationError('expired')
}

function backupPaths(
  installationRoot: string,
  backupId: SakiRecoveryBackupId,
): BackupPaths {
  const parsedBackupId = sakiRecoveryBackupIdSchema.parse(backupId)
  const parsedRoot = resolve(installationRoot)
  const backupsDirectory = resolve(parsedRoot, 'backups')
  return {
    backupId: parsedBackupId,
    installationRoot: parsedRoot,
    backupsDirectory,
    partialDirectory: resolve(backupsDirectory, `${parsedBackupId}.partial`),
    finalDirectory: resolve(backupsDirectory, parsedBackupId),
  }
}

async function requirePrivateInstallationRoot(path: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const info = await lstat(path)
  if (!info.isDirectory()) {
    throw recoveryFailure(path, new Error('Installation root is not a real directory'))
  }
}

async function ensurePrivateBackupsDirectory(path: string, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted()
  let created = false
  try {
    await mkdir(path, { mode: 0o700 })
    created = true
  } catch (error) {
    /* v8 ignore next -- needs a Host permission or I/O failure while creating the fixed backup namespace. */
    if (!isExists(error)) throw error
  }
  const info = await lstat(path)
  if (!info.isDirectory()) {
    throw recoveryFailure(path, new Error('Recovery Backup namespace is not a real directory'))
  }
  /* v8 ignore next -- Windows mode bits are not POSIX permissions; POSIX tests exercise this effect. */
  if (created && process.platform !== 'win32') await chmod(path, 0o700)
  signal.throwIfAborted()
  return created
}

async function requireMissing(path: string): Promise<void> {
  try {
    await lstat(path)
  } catch (error) {
    /* v8 ignore next 3 -- the alternative needs a non-ENOENT Host failure during a fixed-path probe. */
    if (!isMissing(error)) throw error
    return
  }
  throw targetExists(path)
}

function sameManifestArtifacts(
  manifest: RecoveryBackupManifest,
  artifacts: SqliteArtifactSet,
): boolean {
  return manifest.artifacts.length === artifacts.artifacts.length
    && manifest.artifacts.every((expected, index) => {
      const actual = artifacts.artifacts[index]
      return actual !== undefined
        && expected.role === actual.role
        && expected.suffix === actual.suffix
        && expected.byteLength === actual.byteLength
        && expected.sha256 === actual.sha256
    })
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/* v8 ignore start -- Windows rejects directory fsync; POSIX coverage exercises this production effect. */
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
/* v8 ignore stop */

/* v8 ignore start -- owner-mode inode sync is a POSIX production effect. */
async function setOwnerFileMode(path: string): Promise<void> {
  await chmod(path, 0o600)
  const handle = await open(path, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
/* v8 ignore stop */

async function protectWindowsPath(
  windowsAcl: RecoveryBackupWindowsAcl,
  path: string,
  kind: RecoveryBackupWindowsPathKind,
  signal: AbortSignal,
): Promise<void> {
  try {
    await windowsAcl.protect(path, kind, signal)
  } catch (error) {
    signal.throwIfAborted()
    throw recoveryFailure(path, error)
  }
}

async function requireWindowsPath(
  windowsAcl: RecoveryBackupWindowsAcl,
  path: string,
  kind: RecoveryBackupWindowsPathKind,
  signal: AbortSignal,
): Promise<void> {
  try {
    await windowsAcl.require(path, kind, signal)
  } catch (error) {
    signal.throwIfAborted()
    throw recoveryFailure(path, error)
  }
}

function unsupportedState(stateVersion: number): SakiMaintenanceError {
  return new SakiMaintenanceError(
    'state-unsupported',
    `Saki state version ${stateVersion} is not readable by this build`,
  )
}

function targetExists(path: string, cause?: unknown): SakiMaintenanceError {
  return new SakiMaintenanceError(
    'target-exists',
    `Recovery Backup target '${path}' already exists`,
    cause === undefined ? undefined : { cause },
  )
}

function recoveryFailure(path: string, cause: unknown): SakiMaintenanceError {
  return new SakiMaintenanceError(
    'recovery-required',
    `Recovery Backup '${path}' cannot be verified exactly`,
    { cause },
  )
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

function isExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EEXIST'
}

function asError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message, { cause: value })
}

function combineFailures(failures: readonly Error[]): Error {
  /* v8 ignore next -- every caller supplies one or more failures. */
  return failures.length === 1
    ? failures[0] ?? new Error('Recovery Backup publication failed')
    : new AggregateError(failures, 'Recovery Backup publication and final verification failed')
}

/* v8 ignore start -- the Host branch is exercised by the corresponding platform CI job. */
function hostDurableFilePlatform(): DurableFilePlatform {
  return process.platform === 'win32' ? 'win32' : 'posix'
}
/* v8 ignore stop */
