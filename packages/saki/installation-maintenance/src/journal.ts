/** Immutable Saki maintenance journals and their sole active-operation selector. */

import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { TextDecoder } from 'node:util'
import { z } from 'zod'
import type { Branded } from '@deepseek-ai/dsh-brand'
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
import { SakiMaintenanceError } from './error.ts'
import {
  requireOwnedPathAncestors,
  validateOwnedPathAncestors,
} from './owned-path.ts'
import { readStableBoundedRegularFile } from './stable-files.ts'

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const MAX_OPERATION_JSON_BYTES = 16 * 1_024

/** Fixed selector for the sole recoverable maintenance operation. */
export const ACTIVE_OPERATION_LEAF = 'active-operation.json' as const
/** Fixed publication intent written before an immutable journal can appear. */
export const PENDING_OPERATION_LEAF = 'pending-operation.json' as const
/** Fixed non-authority tombstone for an operation whose state outcome is already settled. */
export const SETTLED_OPERATION_LEAF = 'settled-operation.json' as const
/** Fixed non-authority destination for the settled operation's immutable journal bytes. */
export const SETTLED_OPERATION_JOURNAL_LEAF = 'operations/settled-operation-journal.json' as const

/** Stable identity of one immutable maintenance operation journal. */
export type SakiMaintenanceOperationId = Branded<'SakiMaintenanceOperationId'>

/** Stable identity of one Recovery Backup. */
export type SakiRecoveryBackupId = Branded<'SakiRecoveryBackupId'>

/** Strict maintenance-operation identity. */
export const sakiMaintenanceOperationIdSchema = z.string()
  .regex(new RegExp(`^operation-${UUID_PATTERN}$`))
  .transform(value => value as SakiMaintenanceOperationId)

/** Strict Recovery Backup identity. */
export const sakiRecoveryBackupIdSchema = z.string()
  .regex(new RegExp(`^backup-${UUID_PATTERN}$`))
  .transform(value => value as SakiRecoveryBackupId)

const operationJournalLeafSchema = z.string()
  .max(200)
  .regex(new RegExp(`^operations/operation-${UUID_PATTERN}\\.json$`))

const backupPartialLeafSchema = z.string()
  .max(200)
  .regex(new RegExp(`^backups/backup-${UUID_PATTERN}\\.partial$`))

const backupFinalLeafSchema = z.string()
  .max(200)
  .regex(new RegExp(`^backups/backup-${UUID_PATTERN}$`))

function candidateLeafSchema(suffix: '' | '.partial'): z.ZodType<string> {
  return z.string().max(200).superRefine((value, context) => {
    const match = suffix === '.partial'
      ? /^generations\/([^/]+)\.partial$/u.exec(value)
      : /^generations\/([^/]+)$/u.exec(value)
    if (match === null || !sakiStorageGenerationIdSchema.safeParse(match[1]).success) {
      context.addIssue({ code: 'custom', message: 'invalid storage-generation destination leaf' })
    }
  })
}

const candidatePartialLeafSchema = candidateLeafSchema('.partial')

const candidateFinalLeafSchema = candidateLeafSchema('')

const backupDestinationSchema = z.object({
  partialLeaf: backupPartialLeafSchema,
  finalLeaf: backupFinalLeafSchema,
}).strict()

const candidateDestinationSchema = z.object({
  partialLeaf: candidatePartialLeafSchema,
  finalLeaf: candidateFinalLeafSchema,
}).strict()

interface BackupDestinationOwner {
  readonly backupId: SakiRecoveryBackupId
  readonly backup: z.infer<typeof backupDestinationSchema>
}

interface CandidateDestinationOwner {
  readonly candidateStorageGenerationId: SakiStorageGenerationId
  readonly candidate: z.infer<typeof candidateDestinationSchema>
}

function backupDestination(backupId: SakiRecoveryBackupId): z.infer<typeof backupDestinationSchema> {
  return {
    partialLeaf: `backups/${backupId}.partial`,
    finalLeaf: `backups/${backupId}`,
  }
}

function candidateDestination(
  storageGenerationId: SakiStorageGenerationId,
): z.infer<typeof candidateDestinationSchema> {
  return {
    partialLeaf: `generations/${storageGenerationId}.partial`,
    finalLeaf: `generations/${storageGenerationId}`,
  }
}

function refineBackupDestination(value: BackupDestinationOwner, context: z.RefinementCtx): void {
  const expected = backupDestination(value.backupId)
  if (value.backup.partialLeaf !== expected.partialLeaf) {
    context.addIssue({
      code: 'custom',
      path: ['backup', 'partialLeaf'],
      message: 'Recovery Backup partial leaf disagrees with its identity',
    })
  }
  if (value.backup.finalLeaf !== expected.finalLeaf) {
    context.addIssue({
      code: 'custom',
      path: ['backup', 'finalLeaf'],
      message: 'Recovery Backup final leaf disagrees with its identity',
    })
  }
}

function refineCandidateDestination(value: CandidateDestinationOwner, context: z.RefinementCtx): void {
  const expected = candidateDestination(value.candidateStorageGenerationId)
  if (value.candidate.partialLeaf !== expected.partialLeaf) {
    context.addIssue({
      code: 'custom',
      path: ['candidate', 'partialLeaf'],
      message: 'candidate partial leaf disagrees with its storage-generation identity',
    })
  }
  if (value.candidate.finalLeaf !== expected.finalLeaf) {
    context.addIssue({
      code: 'custom',
      path: ['candidate', 'finalLeaf'],
      message: 'candidate final leaf disagrees with its storage-generation identity',
    })
  }
}

const operationJournalSharedShape = {
  formatVersion: z.literal(1),
  operationId: sakiMaintenanceOperationIdSchema,
  installationId: sakiInstallationIdSchema,
}

/** Immutable plan for provisioning a fresh Installation. */
export const freshOperationJournalSchema = z.object({
  ...operationJournalSharedShape,
  kind: z.literal('fresh'),
  candidateStorageGenerationId: sakiStorageGenerationIdSchema,
  candidate: candidateDestinationSchema,
}).strict().superRefine(refineCandidateDestination)

/** Immutable plan for creating one Recovery Backup. */
export const backupOperationJournalSchema = z.object({
  ...operationJournalSharedShape,
  kind: z.literal('backup'),
  backupId: sakiRecoveryBackupIdSchema,
  backup: backupDestinationSchema,
}).strict().superRefine(refineBackupDestination)

/** Immutable plan for backup-first forward upgrade into one candidate generation. */
export const upgradeOperationJournalSchema = z.object({
  ...operationJournalSharedShape,
  kind: z.literal('upgrade'),
  sourceStateVersion: z.union([
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5),
    z.literal(6),
    z.literal(7),
    z.literal(8),
  ]),
  sourceStorageGenerationId: sakiStorageGenerationIdSchema,
  sourceBuildId: sakiBuildIdSchema,
  backupId: sakiRecoveryBackupIdSchema,
  backup: backupDestinationSchema,
  candidateStorageGenerationId: sakiStorageGenerationIdSchema,
  candidate: candidateDestinationSchema,
}).strict().superRefine((value, context) => {
  refineBackupDestination(value, context)
  refineCandidateDestination(value, context)
  if (value.sourceStorageGenerationId === value.candidateStorageGenerationId) {
    context.addIssue({
      code: 'custom',
      path: ['candidateStorageGenerationId'],
      message: 'upgrade candidate must use a fresh physical generation identity',
    })
  }
})

/** Strict discriminated immutable journal format for every maintenance operation. */
export const operationJournalSchema = z.discriminatedUnion('kind', [
  freshOperationJournalSchema,
  backupOperationJournalSchema,
  upgradeOperationJournalSchema,
])

/** Parsed immutable maintenance operation journal. */
export type SakiOperationJournal = z.infer<typeof operationJournalSchema>

/** Identities fixed before any fresh-Installation effect. */
export interface FreshOperationJournalRequest {
  /** Operation identity selecting its immutable journal leaf. */
  readonly operationId: SakiMaintenanceOperationId
  /** New Installation identity. */
  readonly installationId: SakiInstallationId
  /** New physical generation identity. */
  readonly candidateStorageGenerationId: SakiStorageGenerationId
  /** Operation discriminator. */
  readonly kind: 'fresh'
}

/** Identities fixed before any Recovery Backup effect. */
export interface BackupOperationJournalRequest {
  /** Operation identity selecting its immutable journal leaf. */
  readonly operationId: SakiMaintenanceOperationId
  /** Installation whose selected source is backed up. */
  readonly installationId: SakiInstallationId
  /** Recovery Backup identity. */
  readonly backupId: SakiRecoveryBackupId
  /** Operation discriminator. */
  readonly kind: 'backup'
}

/** Identities fixed before any forward-upgrade effect. */
export interface UpgradeOperationJournalRequest {
  /** Operation identity selecting its immutable journal leaf. */
  readonly operationId: SakiMaintenanceOperationId
  /** Installation retained by backup and candidate. */
  readonly installationId: SakiInstallationId
  /** Exact retained state format that the Recovery Backup must preserve. */
  readonly sourceStateVersion: 2 | 3 | 4 | 5 | 6 | 7 | 8
  /** Physical source generation that the Recovery Backup must preserve. */
  readonly sourceStorageGenerationId: SakiStorageGenerationId
  /** Source-build provenance that the Recovery Backup must repeat. */
  readonly sourceBuildId: SakiBuildId
  /** Required pre-upgrade Recovery Backup identity. */
  readonly backupId: SakiRecoveryBackupId
  /** New physical generation identity. */
  readonly candidateStorageGenerationId: SakiStorageGenerationId
  /** Operation discriminator. */
  readonly kind: 'upgrade'
}

/** Identities from which every immutable journal field is derived. */
export type OperationJournalRequest =
  | FreshOperationJournalRequest
  | BackupOperationJournalRequest
  | UpgradeOperationJournalRequest

/** Exact byte evidence for one immutable operation journal. */
export const operationJournalReferenceSchema = z.object({
  leaf: operationJournalLeafSchema,
  byteLength: z.number().int().nonnegative().max(MAX_OPERATION_JSON_BYTES),
  sha256: z.string().regex(SHA256_PATTERN),
}).strict()

/** Exact reference to one immutable operation journal. */
export type OperationJournalReference = z.infer<typeof operationJournalReferenceSchema>

interface OperationJournalReferenceOwner {
  readonly operationId: SakiMaintenanceOperationId
  readonly journal: OperationJournalReference
}

function refineOperationJournalReference(
  value: OperationJournalReferenceOwner,
  context: z.RefinementCtx,
  message: string,
): void {
  if (value.journal.leaf !== operationJournalLeaf(value.operationId)) {
    context.addIssue({
      code: 'custom',
      path: ['journal', 'leaf'],
      message,
    })
  }
}

/** Sole selector for the recoverable operation journal. */
export const activeOperationSelectorSchema = z.object({
  formatVersion: z.literal(1),
  operationId: sakiMaintenanceOperationIdSchema,
  journal: operationJournalReferenceSchema,
}).strict().superRefine((value, context) => {
  refineOperationJournalReference(
    value,
    context,
    'operation journal leaf disagrees with its identity',
  )
})

/** Parsed active-operation selector. */
export type ActiveOperationSelector = z.infer<typeof activeOperationSelectorSchema>

/** Strict pre-activation reference for one operation journal. */
export const pendingOperationIntentSchema = z.object({
  formatVersion: z.literal(1),
  status: z.literal('pending'),
  operationId: sakiMaintenanceOperationIdSchema,
  journal: operationJournalReferenceSchema,
}).strict().superRefine((value, context) => {
  refineOperationJournalReference(
    value,
    context,
    'pending operation journal leaf disagrees with its identity',
  )
})

/** Strict marker proving that no publication intent remains in the fixed pending slot. */
export const clearedPendingOperationSchema = z.object({
  formatVersion: z.literal(1),
  status: z.literal('cleared'),
}).strict()

/** Strict fixed pending-slot state. */
export const pendingOperationStateSchema = z.union([
  pendingOperationIntentSchema,
  clearedPendingOperationSchema,
])

/** Parsed fixed pending-slot state. */
export type PendingOperationState = z.infer<typeof pendingOperationStateSchema>

/** Strict JSON bytes and their exact integrity evidence. */
export interface OperationJsonEvidence<T> {
  /** Parsed strict JSON value. */
  readonly value: T
  /** Exact bytes read and hashed. */
  readonly bytes: Buffer
  /** Exact byte length. */
  readonly byteLength: number
  /** Lowercase SHA-256 of the exact bytes. */
  readonly sha256: string
}

/** Exact active selector and its one referenced immutable journal. */
export interface ActiveOperation {
  /** Strict fixed-path selector. */
  readonly selector: ActiveOperationSelector
  /** Strict immutable journal selected by the exact reference. */
  readonly journal: SakiOperationJournal
  /** Selector bytes retained for diagnostics. */
  readonly selectorEvidence: OperationJsonEvidence<ActiveOperationSelector>
  /** Journal bytes retained for recovery and integrity checks. */
  readonly journalEvidence: OperationJsonEvidence<SakiOperationJournal>
  /** Absolute path derived exclusively from the selected operation identity. */
  readonly journalPath: string
}

/** Exact fixed pending-slot state, with journal evidence when the intent was materialized. */
export type PendingOperation =
  | {
    /** Fixed-slot discriminator. */
    readonly status: 'cleared'
    /** Canonical cleared marker. */
    readonly state: z.infer<typeof clearedPendingOperationSchema>
    /** Exact fixed-slot bytes. */
    readonly stateEvidence: OperationJsonEvidence<PendingOperationState>
  }
  | {
    /** Fixed-slot discriminator. */
    readonly status: 'pending'
    /** Pre-activation journal intent. */
    readonly state: z.infer<typeof pendingOperationIntentSchema>
    /** Active-selector fields derived from the pending intent. */
    readonly selector: ActiveOperationSelector
    /** Exact fixed-slot bytes. */
    readonly stateEvidence: OperationJsonEvidence<PendingOperationState>
    /** Parsed journal when the exact intended dynamic leaf exists. */
    readonly journal: SakiOperationJournal | undefined
    /** Exact journal evidence when the intended dynamic leaf exists. */
    readonly journalEvidence: OperationJsonEvidence<SakiOperationJournal> | undefined
    /** Absolute path derived exclusively from the pending operation identity. */
    readonly journalPath: string
  }

/**
 * Create a fresh unique maintenance-operation identity.
 * @returns strict branded operation identity.
 */
export function createSakiMaintenanceOperationId(): SakiMaintenanceOperationId {
  return sakiMaintenanceOperationIdSchema.parse(`operation-${randomUUID()}`)
}

/**
 * Create a fresh unique Recovery Backup identity.
 * @returns strict branded Recovery Backup identity.
 */
export function createSakiRecoveryBackupId(): SakiRecoveryBackupId {
  return sakiRecoveryBackupIdSchema.parse(`backup-${randomUUID()}`)
}

/**
 * Derive the sole allowed immutable journal leaf for an operation.
 * @param operationId - strict maintenance-operation identity.
 * @returns bounded POSIX-style leaf stored in the active selector.
 */
export function operationJournalLeaf(operationId: SakiMaintenanceOperationId): string {
  return `operations/${operationId}.json`
}

/**
 * Create an immutable journal value and derive every partial and final destination.
 * @param request - identities fixed before operation effects begin.
 * @returns strict operation journal ready for canonical rendering.
 */
export function createOperationJournal(request: OperationJournalRequest): SakiOperationJournal {
  switch (request.kind) {
    case 'fresh':
      return freshOperationJournalSchema.parse({
        formatVersion: 1,
        ...request,
        candidate: candidateDestination(request.candidateStorageGenerationId),
      })
    case 'backup':
      return backupOperationJournalSchema.parse({
        formatVersion: 1,
        ...request,
        backup: backupDestination(request.backupId),
      })
    case 'upgrade':
      return upgradeOperationJournalSchema.parse({
        formatVersion: 1,
        ...request,
        backup: backupDestination(request.backupId),
        candidate: candidateDestination(request.candidateStorageGenerationId),
      })
    /* v8 ignore next 2 -- OperationJournalRequest is a closed same-process union. */
    default:
      return assertNever(request)
  }
}

/**
 * Render canonical immutable operation-journal bytes.
 * @param journal - strict complete journal including derived destinations.
 * @returns UTF-8 JSON with one trailing newline.
 */
export function renderOperationJournal(journal: SakiOperationJournal): Buffer {
  const value = operationJournalSchema.parse(journal)
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
}

/**
 * Build the exact reference stored in `active-operation.json`.
 * @param operationId - operation identity owning the immutable bytes.
 * @param bytes - complete operation-journal bytes.
 * @returns bounded leaf, exact length, and SHA-256.
 */
export function operationJournalReference(
  operationId: SakiMaintenanceOperationId,
  bytes: Buffer,
): OperationJournalReference {
  return operationJournalReferenceSchema.parse({
    leaf: operationJournalLeaf(operationId),
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
  })
}

/**
 * Render canonical active-operation selector bytes.
 * @param operationId - sole recoverable operation identity.
 * @param reference - exact immutable journal reference.
 * @returns UTF-8 JSON with one trailing newline.
 */
export function renderActiveOperationSelector(
  operationId: SakiMaintenanceOperationId,
  reference: OperationJournalReference,
): Buffer {
  const value = activeOperationSelectorSchema.parse({
    formatVersion: 1,
    operationId,
    journal: reference,
  })
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
}

/**
 * Render a canonical pre-activation reference before its journal is published.
 * @param operationId - operation identity owning the immutable bytes.
 * @param reference - exact immutable journal reference.
 * @returns UTF-8 JSON with one trailing newline.
 */
export function renderPendingOperationIntent(
  operationId: SakiMaintenanceOperationId,
  reference: OperationJournalReference,
): Buffer {
  const value = pendingOperationIntentSchema.parse({
    formatVersion: 1,
    status: 'pending',
    operationId,
    journal: reference,
  })
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
}

/**
 * Render the canonical state of an inactive pending slot.
 * @returns UTF-8 JSON with one trailing newline.
 */
export function renderClearedPendingOperation(): Buffer {
  const value = clearedPendingOperationSchema.parse({ formatVersion: 1, status: 'cleared' })
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
}

async function readBoundedRegularFile(
  path: string,
  signal: AbortSignal,
  allowInitiallyMissing: true,
): Promise<Buffer | undefined>
async function readBoundedRegularFile(
  path: string,
  signal: AbortSignal,
  allowInitiallyMissing?: false,
): Promise<Buffer>
async function readBoundedRegularFile(
  path: string,
  signal: AbortSignal,
  allowInitiallyMissing = false,
): Promise<Buffer | undefined> {
  return await readStableBoundedRegularFile(path, signal, {
    byteLimit: MAX_OPERATION_JSON_BYTES,
    description: `Saki operation metadata '${path}'`,
    invalid: message => new SakiMaintenanceError('recovery-required', message),
  }, allowInitiallyMissing)
}

function parseOperationJson<T>(
  path: string,
  bytes: Buffer,
  schema: z.ZodType<T>,
): OperationJsonEvidence<T> {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new SakiMaintenanceError(
      'recovery-required',
      `Saki operation metadata '${path}' is not UTF-8`,
      { cause: error },
    )
  }
  let raw: unknown
  try {
    raw = parseLosslessJsonValue(text)
  } catch (error) {
    throw new SakiMaintenanceError(
      'recovery-required',
      `Saki operation metadata '${path}' is not strict JSON`,
      { cause: error },
    )
  }
  let value: T
  try {
    value = schema.parse(raw)
  } catch (error) {
    throw new SakiMaintenanceError(
      'recovery-required',
      `Saki operation metadata '${path}' has invalid fields`,
      { cause: error },
    )
  }
  return {
    value,
    bytes,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function recoveryFailure(path: string, error: unknown): SakiMaintenanceError {
  if (error instanceof SakiMaintenanceError) return error
  return new SakiMaintenanceError(
    'recovery-required',
    `Saki operation metadata '${path}' cannot be read exactly`,
    { cause: error },
  )
}

function parseSelectedJournal(
  journalPath: string,
  journalBytes: Buffer,
  selector: ActiveOperationSelector,
): OperationJsonEvidence<SakiOperationJournal> {
  if (journalBytes.byteLength !== selector.journal.byteLength
    || sha256(journalBytes) !== selector.journal.sha256) {
    throw new SakiMaintenanceError(
      'recovery-required',
      `selected operation journal '${journalPath}' fails its exact integrity reference`,
    )
  }
  const evidence = parseOperationJson(journalPath, journalBytes, operationJournalSchema)
  if (evidence.value.operationId !== selector.operationId) {
    throw new SakiMaintenanceError(
      'recovery-required',
      `selected operation journal '${journalPath}' disagrees with operation identity`,
    )
  }
  return evidence
}

/** Read one fixed selector and its exact selected or fixed-fallback journal. */
async function readSelectedOperation(
  installationRoot: string,
  selectorLeaf: string,
  fallbackJournalLeaf: string | undefined,
  signal: AbortSignal,
): Promise<ActiveOperation | undefined> {
  signal.throwIfAborted()
  const root = resolve(installationRoot)
  const selectorPath = resolve(root, ...selectorLeaf.split('/'))
  if (!await validateOwnedPathAncestors(root, selectorPath, signal)) return undefined
  let selectorBytes: Buffer | undefined
  try {
    selectorBytes = await readBoundedRegularFile(selectorPath, signal, true)
  } catch (error) {
    signal.throwIfAborted()
    throw recoveryFailure(selectorPath, error)
  }
  if (selectorBytes === undefined) return undefined
  const selectorEvidence = parseOperationJson(
    selectorPath,
    selectorBytes,
    activeOperationSelectorSchema,
  )
  const selector = selectorEvidence.value
  const selectedJournalPath = resolve(root, ...selector.journal.leaf.split('/'))
  let journalPath = selectedJournalPath
  let journalBytes: Buffer | undefined
  try {
    journalBytes = await validateOwnedPathAncestors(root, selectedJournalPath, signal)
      ? await readBoundedRegularFile(selectedJournalPath, signal, true)
      : undefined
    if (journalBytes === undefined && fallbackJournalLeaf !== undefined) {
      journalPath = resolve(root, ...fallbackJournalLeaf.split('/'))
      await requireOwnedPathAncestors(root, journalPath, signal)
      journalBytes = await readBoundedRegularFile(journalPath, signal)
    }
  } catch (error) {
    signal.throwIfAborted()
    throw recoveryFailure(journalPath, error)
  }
  if (journalBytes === undefined) {
    throw recoveryFailure(selectedJournalPath, new Error('selected operation journal is missing'))
  }
  const journalEvidence = parseSelectedJournal(journalPath, journalBytes, selector)
  return {
    selector,
    journal: journalEvidence.value,
    selectorEvidence,
    journalEvidence,
    journalPath,
  }
}

/**
 * Read the sole active operation and its exact immutable journal.
 * @param installationRoot - Installation metadata root.
 * @param signal - cancellation during bounded metadata reads.
 * @returns selected operation, or `undefined` when no active selector exists.
 */
export async function readActiveOperation(
  installationRoot: string,
  signal: AbortSignal,
): Promise<ActiveOperation | undefined> {
  return await readSelectedOperation(installationRoot, ACTIVE_OPERATION_LEAF, undefined, signal)
}

/**
 * Read the fixed publication intent without treating it as a recoverable operation.
 * A missing intended journal is valid because the pending reference is committed first.
 * @param installationRoot - Installation metadata root.
 * @param signal - cancellation during bounded metadata reads.
 * @returns exact pending-slot state, or `undefined` before its first publication.
 */
export async function readPendingOperation(
  installationRoot: string,
  signal: AbortSignal,
): Promise<PendingOperation | undefined> {
  signal.throwIfAborted()
  const root = resolve(installationRoot)
  const statePath = resolve(root, PENDING_OPERATION_LEAF)
  if (!await validateOwnedPathAncestors(root, statePath, signal)) return undefined
  let stateBytes: Buffer | undefined
  try {
    stateBytes = await readBoundedRegularFile(statePath, signal, true)
  } catch (error) {
    signal.throwIfAborted()
    throw recoveryFailure(statePath, error)
  }
  if (stateBytes === undefined) return undefined
  const stateEvidence = parseOperationJson(statePath, stateBytes, pendingOperationStateSchema)
  if (stateEvidence.value.status === 'cleared') {
    return { status: 'cleared', state: stateEvidence.value, stateEvidence }
  }
  const state = stateEvidence.value
  const selector = activeOperationSelectorSchema.parse({
    formatVersion: state.formatVersion,
    operationId: state.operationId,
    journal: state.journal,
  })
  const journalPath = resolve(root, ...state.journal.leaf.split('/'))
  let journalBytes: Buffer | undefined
  try {
    journalBytes = await validateOwnedPathAncestors(root, journalPath, signal)
      ? await readBoundedRegularFile(journalPath, signal, true)
      : undefined
  } catch (error) {
    signal.throwIfAborted()
    throw recoveryFailure(journalPath, error)
  }
  const journalEvidence = journalBytes === undefined
    ? undefined
    : parseSelectedJournal(journalPath, journalBytes, selector)
  return {
    status: 'pending',
    state,
    selector,
    stateEvidence,
    journal: journalEvidence?.value,
    journalEvidence,
    journalPath,
  }
}

/**
 * Read durable-clear metadata without treating it as an active operation.
 * The selected dynamic journal wins while a two-move cleanup is incomplete; afterward the
 * fixed journal fallback must satisfy the same exact selector reference.
 * @param installationRoot - Installation metadata root.
 * @param signal - cancellation during bounded metadata reads.
 * @returns settled metadata, or `undefined` when no settled selector exists.
 */
export async function readSettledOperation(
  installationRoot: string,
  signal: AbortSignal,
): Promise<ActiveOperation | undefined> {
  return await readSelectedOperation(
    installationRoot,
    SETTLED_OPERATION_LEAF,
    SETTLED_OPERATION_JOURNAL_LEAF,
    signal,
  )
}

/* v8 ignore start -- OperationJournalRequest is a closed same-process union. */
function assertNever(value: never): never {
  throw new Error(`unsupported Saki maintenance operation '${JSON.stringify(value)}'`)
}
/* v8 ignore stop */
