/** Durable publication and exact cleanup of one selected maintenance operation. */

import { mkdir, open, readdir, rename } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  ACTIVE_OPERATION_LEAF,
  operationJournalReference,
  PENDING_OPERATION_LEAF,
  readActiveOperation,
  readPendingOperation,
  readSettledOperation,
  renderActiveOperationSelector,
  renderClearedPendingOperation,
  renderOperationJournal,
  renderPendingOperationIntent,
  SETTLED_OPERATION_JOURNAL_LEAF,
  SETTLED_OPERATION_LEAF,
} from './journal.ts'
import type { ActiveOperation, SakiOperationJournal } from './journal.ts'
import {
  discardDurableFileTemporary,
  publishMissingFile,
  replaceFileDurably,
} from './durable-files.ts'
import type { DurableFilePlatform, DurableFileResult } from './durable-files.ts'
import { SakiMaintenanceError } from './error.ts'
import { movePathWin32WriteThrough } from './durable-directories.ts'
import {
  requireOwnedPathAncestors,
  validateOwnedPathAncestors,
} from './owned-path.ts'

/** Platform effects used to prove durable operation cleanup ordering. */
export interface OperationFileEffects {
  /** Override the Host publication family. */
  readonly platform?: DurableFilePlatform
  /** Override a Windows write-through move while preserving explicit replace intent. */
  readonly movePathWin32?: (
    existingPath: string,
    targetPath: string,
    replaceExisting: boolean,
  ) => Promise<void>
  /** Override POSIX parent-directory synchronization. */
  readonly syncDirectory?: (path: string) => Promise<void>
}

class OperationNamespaceDurabilityError extends Error {
  constructor(cause: unknown) {
    super('Saki operation namespace commit could not be made durable', { cause })
    this.name = 'OperationNamespaceDurabilityError'
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

function isExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EEXIST'
}

function asError(error: unknown, message: string): Error {
  return error instanceof Error ? error : new Error(message, { cause: error })
}

/* v8 ignore start -- Windows cannot open directories for fsync; POSIX Hosts exercise this default effect. */
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
/* v8 ignore stop */

function sameSelectedOperation(left: ActiveOperation, right: ActiveOperation): boolean {
  return left.journal.operationId === right.journal.operationId
    && left.selectorEvidence.bytes.equals(right.selectorEvidence.bytes)
    && left.journalEvidence.bytes.equals(right.journalEvidence.bytes)
}

function sameOperationSelector(
  left: ActiveOperation['selector'],
  right: ActiveOperation['selector'],
): boolean {
  return left.operationId === right.operationId
    && left.journal.leaf === right.journal.leaf
    && left.journal.byteLength === right.journal.byteLength
    && left.journal.sha256 === right.journal.sha256
}

async function moveSettledPath(
  installationRoot: string,
  existingPath: string,
  targetPath: string,
  signal: AbortSignal,
  effects: OperationFileEffects,
): Promise<void> {
  await requireOwnedPathAncestors(installationRoot, existingPath, signal)
  await requireOwnedPathAncestors(installationRoot, targetPath, signal)
  /* v8 ignore next -- process.platform is Host-invariant; injected effects cover both families. */
  const platform = effects.platform ?? (process.platform === 'win32' ? 'win32' : 'posix')
  if (platform === 'win32') {
    signal.throwIfAborted()
    const injectedMove = effects.movePathWin32
    /* v8 ignore next 2 -- the Windows test lane covers the default write-through adapter. */
    if (injectedMove === undefined) {
      await movePathWin32WriteThrough(existingPath, targetPath, true, signal)
    } else {
      await injectedMove(existingPath, targetPath, true)
    }
    return
  }
  await rename(existingPath, targetPath)
  /* v8 ignore next -- Windows cannot run the POSIX default; injected sync covers its ordering. */
  const sync = effects.syncDirectory ?? syncDirectory
  const targetParent = dirname(targetPath)
  try {
    await sync(targetParent)
  } catch (error) {
    throw new OperationNamespaceDurabilityError(error)
  }
}

async function ensureOwnedParentDirectory(
  installationRoot: string,
  targetPath: string,
  signal: AbortSignal,
): Promise<void> {
  if (!await validateOwnedPathAncestors(installationRoot, targetPath, signal)) {
    await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 })
  }
  await requireOwnedPathAncestors(installationRoot, targetPath, signal)
}

async function discardOwnedDurableFileTemporary(
  installationRoot: string,
  targetPath: string,
  signal: AbortSignal,
): Promise<void> {
  if (!await validateOwnedPathAncestors(installationRoot, targetPath, signal)) return
  await discardDurableFileTemporary(targetPath, signal)
}

async function discardFixedOperationTemporaries(
  installationRoot: string,
  signal: AbortSignal,
): Promise<void> {
  for (const leaf of [
    PENDING_OPERATION_LEAF,
    ACTIVE_OPERATION_LEAF,
    SETTLED_OPERATION_LEAF,
    SETTLED_OPERATION_JOURNAL_LEAF,
  ]) {
    await discardOwnedDurableFileTemporary(
      installationRoot,
      resolve(installationRoot, ...leaf.split('/')),
      signal,
    )
  }
}

async function requireExactOperationJournalNamespace(
  installationRoot: string,
  active: ActiveOperation | undefined,
  signal: AbortSignal,
): Promise<void> {
  const operationsRoot = resolve(installationRoot, 'operations')
  const probePath = resolve(operationsRoot, '.namespace-audit')
  if (!await validateOwnedPathAncestors(installationRoot, probePath, signal)) return
  const allowedPaths = new Set<string>()
  const fixedSettledJournalPath = resolve(
    installationRoot,
    ...SETTLED_OPERATION_JOURNAL_LEAF.split('/'),
  )
  const settled = await readSettledOperation(installationRoot, signal)
  if (settled?.journalPath === fixedSettledJournalPath) {
    allowedPaths.add(fixedSettledJournalPath)
  }
  if (active !== undefined) allowedPaths.add(active.journalPath)
  for (const entry of await readdir(operationsRoot, { withFileTypes: true })) {
    signal.throwIfAborted()
    const path = resolve(operationsRoot, entry.name)
    if (entry.isFile() && allowedPaths.has(path)) continue
    throw new SakiMaintenanceError(
      'recovery-required',
      `Saki Installation has an unselected operation artifact at '${path}'`,
    )
  }
}

async function clearPendingOperation(
  installationRoot: string,
  signal: AbortSignal,
): Promise<void> {
  const pendingPath = resolve(installationRoot, PENDING_OPERATION_LEAF)
  await requireOwnedPathAncestors(installationRoot, pendingPath, signal)
  requireDurable(
    await replaceFileDurably(pendingPath, renderClearedPendingOperation(), signal),
    'Saki pending-operation marker',
  )
}

async function publishPendingOperation(
  installationRoot: string,
  operationId: SakiOperationJournal['operationId'],
  reference: ReturnType<typeof operationJournalReference>,
  signal: AbortSignal,
): Promise<void> {
  const pendingPath = resolve(installationRoot, PENDING_OPERATION_LEAF)
  await requireOwnedPathAncestors(installationRoot, pendingPath, signal)
  const bytes = renderPendingOperationIntent(operationId, reference)
  const existing = await readPendingOperation(installationRoot, signal)
  requireDurable(
    existing === undefined
      ? await publishMissingFile(pendingPath, bytes, signal)
      : await replaceFileDurably(pendingPath, bytes, signal),
    'Saki pending-operation intent',
  )
  const pending = await readPendingOperation(installationRoot, signal)
  if (pending === undefined || pending.status !== 'pending'
    || !sameOperationSelector(pending.selector, {
      formatVersion: 1,
      operationId,
      journal: reference,
    })) {
    throw new SakiMaintenanceError(
      'recovery-required',
      'published Saki pending-operation intent failed exact readback',
    )
  }
}

async function publishSettledOperationSelector(
  installationRoot: string,
  selector: ActiveOperation['selector'],
  signal: AbortSignal,
): Promise<void> {
  const settledPath = resolve(installationRoot, ...SETTLED_OPERATION_LEAF.split('/'))
  await ensureOwnedParentDirectory(installationRoot, settledPath, signal)
  requireDurable(
    await replaceFileDurably(
      settledPath,
      renderActiveOperationSelector(selector.operationId, selector.journal),
      signal,
    ),
    'Saki settled-operation selector',
  )
}

/**
 * Finish only the non-authority half of an interrupted durable clear.
 * The settled selector is never replayed and never selects product state; it identifies only
 * the exact dynamic journal that must move to the fixed settled slot.
 * @param installationRoot - Installation metadata root held under its exclusive lease.
 * @param signal - cancellation while reading or finishing prior settled metadata.
 * @param effects - optional platform effects for fault tests.
 */
export async function settleClearedOperationMetadata(
  installationRoot: string,
  signal: AbortSignal,
  effects: OperationFileEffects = {},
): Promise<void> {
  const root = resolve(installationRoot)
  const settled = await readSettledOperation(root, signal)
  if (settled === undefined) return
  const fixedJournalPath = resolve(root, ...SETTLED_OPERATION_JOURNAL_LEAF.split('/'))
  if (settled.journalPath === fixedJournalPath) return
  let moveFailure: Error | undefined
  try {
    await moveSettledPath(root, settled.journalPath, fixedJournalPath, signal, effects)
  } catch (error) {
    moveFailure = asError(error, 'moving settled Saki operation journal failed')
  }
  const confirmed = await readSettledOperation(root, new AbortController().signal)
  if (moveFailure instanceof OperationNamespaceDurabilityError) throw moveFailure
  if (confirmed === undefined
    || confirmed.journalPath !== fixedJournalPath
    || !sameSelectedOperation(confirmed, settled)) {
    if (moveFailure !== undefined) throw moveFailure
    throw new SakiMaintenanceError(
      'recovery-required',
      'settled Saki operation journal failed exact fixed-path readback',
    )
  }
}

/**
 * Reconcile fixed non-authority operation metadata before recovery or a new publication.
 * @param installationRoot - Installation metadata root held under its exclusive lease.
 * @param signal - cancellation during exact metadata reconciliation.
 * @param effects - optional platform effects for fault tests.
 */
export async function reconcileOperationMetadata(
  installationRoot: string,
  signal: AbortSignal,
  effects: OperationFileEffects = {},
): Promise<void> {
  const root = resolve(installationRoot)
  await discardFixedOperationTemporaries(root, signal)
  await settleClearedOperationMetadata(root, signal, effects)
  let pending = await readPendingOperation(root, signal)
  if (pending?.status === 'pending') {
    await discardOwnedDurableFileTemporary(root, pending.journalPath, signal)
    pending = await readPendingOperation(root, signal)
  }
  const active = await readActiveOperation(root, signal)
  if (pending !== undefined && pending.status === 'pending') {
    if (active !== undefined) {
      if (!sameOperationSelector(active.selector, pending.selector)
        || pending.journalEvidence === undefined
        || !active.journalEvidence.bytes.equals(pending.journalEvidence.bytes)) {
        throw new SakiMaintenanceError(
          'recovery-required',
          'pending Saki operation disagrees with the active operation',
        )
      }
      await clearPendingOperation(root, signal)
    } else if (pending.journal === undefined) {
      await clearPendingOperation(root, signal)
    } else {
      await publishSettledOperationSelector(root, pending.selector, signal)
      await settleClearedOperationMetadata(root, signal, effects)
      await clearPendingOperation(root, signal)
    }
  }
  await requireExactOperationJournalNamespace(root, active, signal)
}

/**
 * Publish one immutable operation journal and then its sole active selector.
 * @param installationRoot - Installation metadata root held under its exclusive lease.
 * @param journal - complete immutable operation plan fixed before other effects.
 * @param signal - cancellation through selector publication.
 * @returns exact selected operation read back from its integrity reference.
 */
export async function publishActiveOperation(
  installationRoot: string,
  journal: SakiOperationJournal,
  signal: AbortSignal,
): Promise<ActiveOperation> {
  signal.throwIfAborted()
  const root = resolve(installationRoot)
  await reconcileOperationMetadata(root, signal)
  if (await readActiveOperation(root, signal) !== undefined) {
    throw new SakiMaintenanceError(
      'operation-active',
      `Saki Installation at '${root}' already has an active maintenance operation`,
    )
  }
  const journalBytes = renderOperationJournal(journal)
  const reference = operationJournalReference(journal.operationId, journalBytes)
  const journalPath = resolve(root, ...reference.leaf.split('/'))
  const selectorPath = resolve(root, ACTIVE_OPERATION_LEAF)
  await requireOwnedPathAncestors(root, selectorPath, signal)
  try {
    await publishPendingOperation(root, journal.operationId, reference, signal)
    await ensureOwnedParentDirectory(root, journalPath, signal)
    requireDurable(
      await publishMissingFile(journalPath, journalBytes, signal),
      'Saki operation journal',
    )
    requireDurable(
      await publishMissingFile(
        selectorPath,
        renderActiveOperationSelector(journal.operationId, reference),
        signal,
      ),
      'Saki active-operation selector',
    )
  } catch (error) {
    if (isExists(error)) {
      throw new SakiMaintenanceError(
        'operation-active',
        `Saki Installation at '${root}' already has operation metadata at the requested destination`,
        { cause: error },
      )
    }
    throw error
  }
  const selected = await readActiveOperation(root, signal)
  if (selected === undefined || selected.journal.operationId !== journal.operationId) {
    throw new SakiMaintenanceError(
      'recovery-required',
      'published Saki operation selector did not read back as the requested operation',
    )
  }
  await clearPendingOperation(root, signal)
  return selected
}

/**
 * Clear only an exactly re-read selected operation after its outcome is settled.
 * The selector and journal move into fixed same-parent settled slots in that order, so every
 * crash leaves either the active pair or exact non-authority metadata that startup can finish.
 * @param installationRoot - Installation metadata root held under its exclusive lease.
 * @param expected - operation previously selected and settled by this lease owner.
 * @param effects - optional platform effects for durable-ordering fault tests.
 * @returns after both namespace moves are durable and read back exactly.
 */
export async function clearActiveOperation(
  installationRoot: string,
  expected: ActiveOperation,
  effects: OperationFileEffects = {},
): Promise<void> {
  const root = resolve(installationRoot)
  const signal = new AbortController().signal
  await settleClearedOperationMetadata(root, signal, effects)
  const selected = await readActiveOperation(root, signal)
  if (selected === undefined) return
  if (!sameSelectedOperation(selected, expected)) {
    throw new SakiMaintenanceError(
      'recovery-required',
      'active Saki operation changed before exact cleanup',
    )
  }
  const selectorPath = resolve(root, ACTIVE_OPERATION_LEAF)
  const settledSelectorPath = resolve(root, ...SETTLED_OPERATION_LEAF.split('/'))
  const settledJournalPath = resolve(root, ...SETTLED_OPERATION_JOURNAL_LEAF.split('/'))
  await ensureOwnedParentDirectory(root, settledSelectorPath, signal)
  let selectorMoveFailure: Error | undefined
  try {
    await moveSettledPath(root, selectorPath, settledSelectorPath, signal, effects)
  } catch (error) {
    selectorMoveFailure = asError(error, 'moving active Saki operation selector failed')
  }
  const movedSelector = await readSettledOperation(root, signal)
  const activeAfterMove = await readActiveOperation(root, signal)
  if (selectorMoveFailure instanceof OperationNamespaceDurabilityError) {
    throw selectorMoveFailure
  }
  if (movedSelector === undefined || activeAfterMove !== undefined
    || !sameSelectedOperation(movedSelector, expected)) {
    if (selectorMoveFailure !== undefined) throw selectorMoveFailure
    throw new SakiMaintenanceError(
      'recovery-required',
      'settled Saki operation selector failed exact fixed-path readback',
    )
  }
  let journalMoveFailure: Error | undefined
  try {
    await moveSettledPath(root, expected.journalPath, settledJournalPath, signal, effects)
  } catch (error) {
    journalMoveFailure = asError(error, 'moving active Saki operation journal failed')
  }
  const settled = await readSettledOperation(root, signal)
  if (journalMoveFailure instanceof OperationNamespaceDurabilityError) {
    throw journalMoveFailure
  }
  if (settled === undefined || settled.journalPath !== settledJournalPath
    || !sameSelectedOperation(settled, expected)) {
    if (journalMoveFailure !== undefined) throw journalMoveFailure
    throw new SakiMaintenanceError(
      'recovery-required',
      'settled Saki operation journal failed exact fixed-path readback',
    )
  }
}
