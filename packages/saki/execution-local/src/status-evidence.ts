/** Local Host status evidence. @module @breakfastdapaidang/saki-execution-local/status-evidence */

import { isGitObjectId, type ProjectGitHead } from '@breakfastdapaidang/saki-execution'
import {
  capturedInventoryEntryHasGitlink,
  classifyCapturedInventoryEntry,
  type CapturedInventoryGitObject,
  type CapturedRepositoryInventory,
  type CapturedRepositoryInventoryEntry,
} from './baseline.ts'
import type { RepositoryInventoryGit } from './inventory.ts'
import {
  parseStatusPorcelainV2,
  type ParsedGitMode,
  type ParsedOrdinaryStatusEntry,
  type ParsedStatusEntry,
  type ParsedStatusPorcelainV2,
  type ParsedSubmoduleStatus,
  type ParsedUnmergedStatusEntry,
} from './status-porcelain-v2.ts'
import { projectStatusQueryArguments } from './status-query.ts'

const EMPTY_BLOB_OBJECT_IDS = {
  sha1: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
  sha256: '473a0f4c3be8a93681a267e3b1e9a7dcda1185436fe141f7749120a303721813',
} as const
const UTF8 = new TextDecoder('utf-8', { fatal: true })

/** Independent branch facts that one private status command must reproduce. */
export interface RepositoryStatusBranchExpectation {
  readonly head: ProjectGitHead
  readonly upstreamShort?: string
}

/** Bounds shared with the raw inventory whose membership status verifies. */
export interface RepositoryStatusBounds {
  readonly maxEntries: number
  readonly maxPathBytes: number
}

/** Canonically ordered porcelain facts proven against one raw inventory. */
export interface VerifiedRepositoryStatus extends ParsedStatusPorcelainV2 {
  readonly entries: readonly ParsedStatusEntry[]
  readonly index:
    | { readonly kind: 'tree'; readonly treeId: string }
    | { readonly kind: 'unmerged' }
}

/** Closed internal status failure used by inspection error mapping. */
export class RepositoryStatusError extends Error {
  /** @param kind - structural, racing, or configured-capacity failure. */
  constructor(readonly kind: 'malformed' | 'ambiguous' | 'limit') {
    super(`Saki repository status ${kind}`)
  }
}

/**
 * Execute the fixed status query and prove its declarations against raw evidence.
 * @param git - private repository runner within one aggregate observation round.
 * @param cwd - canonical bound worktree path.
 * @param objectFormat - admitted repository object format.
 * @param branch - independently inspected HEAD and upstream spelling.
 * @param inventory - raw HEAD, index-stage, untracked, and current-byte evidence.
 * @param bounds - maximum retained entry and path totals.
 * @param signal - observation lifetime.
 * @param assumeUnchangedPaths - exact CE_VALID paths whose ordinary rows may be rebuilt from raw evidence.
 * @returns canonical status facts without decoding any path.
 */
export async function captureVerifiedRepositoryStatus(
  git: RepositoryInventoryGit,
  cwd: string,
  objectFormat: 'sha1' | 'sha256',
  branch: RepositoryStatusBranchExpectation,
  inventory: CapturedRepositoryInventory,
  bounds: RepositoryStatusBounds,
  signal: AbortSignal,
  assumeUnchangedPaths: readonly Uint8Array[] = [],
): Promise<VerifiedRepositoryStatus> {
  signal.throwIfAborted()
  const output = await git.run(cwd, projectStatusQueryArguments(), signal)
  if (output.stderr.byteLength !== 0) throw new RepositoryStatusError('malformed')
  let parsed: ParsedStatusPorcelainV2
  try {
    parsed = parseStatusPorcelainV2(output.stdout)
  } catch {
    throw new RepositoryStatusError('malformed')
  }
  const expectedWidth = objectFormat === 'sha1' ? 40 : 64
  if (parsed.objectIdWidth !== undefined && parsed.objectIdWidth !== expectedWidth) {
    throw new RepositoryStatusError('malformed')
  }
  validateBranch(parsed, branch)
  const entries = mergeRawOwnedEntries(parsed.entries, inventory, assumeUnchangedPaths)
    .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
  const pathBytes = entries.reduce((total, entry) => total + entry.path.byteLength, 0)
  if (entries.length > bounds.maxEntries || pathBytes > bounds.maxPathBytes) {
    throw new RepositoryStatusError('limit')
  }
  validateEntries(entries, inventory)
  const index = inventory.entries.some(entry => entry.stages.some(stage => stage !== undefined))
    ? { kind: 'unmerged' as const }
    : { kind: 'tree' as const, treeId: await writeIndexTree(git, cwd, objectFormat, signal) }
  signal.throwIfAborted()
  return { ...parsed, entries, index }
}

async function writeIndexTree(
  git: RepositoryInventoryGit,
  cwd: string,
  objectFormat: 'sha1' | 'sha256',
  signal: AbortSignal,
): Promise<string> {
  const { stdout, stderr } = await git.run(cwd, ['write-tree'], signal)
  if (stderr.byteLength !== 0) throw new RepositoryStatusError('malformed')
  let text: string
  try {
    text = UTF8.decode(stdout)
  } catch {
    throw new RepositoryStatusError('malformed')
  }
  const treeId = text.endsWith('\r\n') ? text.slice(0, -2) : text.endsWith('\n') ? text.slice(0, -1) : undefined
  if (treeId === undefined || !isGitObjectId(treeId, objectFormat)) throw new RepositoryStatusError('malformed')
  return treeId
}

function validateBranch(
  status: ParsedStatusPorcelainV2,
  expected: RepositoryStatusBranchExpectation,
): void {
  const oidMatches = expected.head.kind === 'unborn'
    ? status.branch.oid.kind === 'initial'
    : status.branch.oid.kind === 'commit' && status.branch.oid.objectId === expected.head.objectId
  const symbolicRef = expected.head.symbolicRef
  const headMatches = symbolicRef === undefined
    ? status.branch.head.kind === 'detached'
    : status.branch.head.kind === 'attached'
      && status.branch.head.name === symbolicRef.slice('refs/heads/'.length)
  if (!oidMatches || !headMatches || status.branch.upstream?.name !== expected.upstreamShort) {
    throw new RepositoryStatusError('malformed')
  }
}

function validateEntries(
  statusEntries: readonly ParsedStatusEntry[],
  inventory: CapturedRepositoryInventory,
): void {
  const inventoryByPath = new Map(inventory.entries.map(entry => [pathKey(entry.path), entry]))
  const statusByPath = new Map<string, ParsedStatusEntry>()
  for (const status of statusEntries) {
    const key = pathKey(status.path)
    const raw = inventoryByPath.get(key)
    if (raw === undefined) throw new RepositoryStatusError('ambiguous')
    statusByPath.set(key, status)
    if (status.kind === 'ordinary') validateOrdinary(status, raw, inventory)
    else if (status.kind === 'unmerged') validateUnmerged(status, raw)
    else validateUntracked(raw)
  }
  for (const raw of inventory.entries) {
    const status = statusByPath.get(pathKey(raw.path))
    const classification = classifyCapturedInventoryEntry(raw, inventory.comparison)
    if (status === undefined && capturedInventoryEntryHasGitlink(raw)) continue
    if (raw.current.kind === 'unavailable' && status === undefined) {
      throw new RepositoryStatusError('ambiguous')
    }
    if (classification.conflicted && status?.kind !== 'unmerged') throw new RepositoryStatusError('ambiguous')
    if (raw.untracked && status?.kind !== 'untracked') throw new RepositoryStatusError('ambiguous')
    if (!classification.conflicted && !raw.untracked && classification.staged && status?.kind !== 'ordinary') {
      throw new RepositoryStatusError('ambiguous')
    }
    if (!classification.conflicted && !raw.untracked
      && !classification.conversionAmbiguous && raw.current.kind === 'captured') {
      if (classification.unstaged !== (status?.kind === 'ordinary' && status.worktreeStatus !== 'unchanged')) {
        throw new RepositoryStatusError('ambiguous')
      }
    }
  }
}

function mergeRawOwnedEntries(
  statusEntries: readonly ParsedStatusEntry[],
  inventory: CapturedRepositoryInventory,
  assumeUnchangedPaths: readonly Uint8Array[],
): ParsedStatusEntry[] {
  const inventoryByPath = new Map(inventory.entries.map(entry => [pathKey(entry.path), entry]))
  const assumeUnchanged = new Map<string, CapturedRepositoryInventoryEntry & {
    readonly index: CapturedInventoryGitObject
  }>()
  for (const path of assumeUnchangedPaths) {
    const key = pathKey(path)
    const raw = inventoryByPath.get(key)
    if (assumeUnchanged.has(key) || raw?.index === undefined) {
      throw new RepositoryStatusError('ambiguous')
    }
    assumeUnchanged.set(key, raw as CapturedRepositoryInventoryEntry & {
      readonly index: CapturedInventoryGitObject
    })
  }
  const merged = statusEntries.filter((entry) => {
    const raw = inventoryByPath.get(pathKey(entry.path))
    return raw === undefined || (!capturedInventoryEntryHasGitlink(raw)
      && (!assumeUnchanged.has(pathKey(entry.path)) || potentialIntentToAdd(raw, inventory.objectFormat)))
  })
  for (const raw of inventory.entries) {
    if (capturedInventoryEntryHasGitlink(raw)) {
      if (!classifyCapturedInventoryEntry(raw, inventory.comparison).changed) continue
      const entry = rawGitlinkStatusEntry(raw, inventory)
      if (entry !== undefined) merged.push(entry)
      continue
    }
    const assumed = assumeUnchanged.get(pathKey(raw.path))
    if (assumed === undefined || potentialIntentToAdd(assumed, inventory.objectFormat)) continue
    const entry = rawAssumeUnchangedStatusEntry(assumed, inventory)
    if (entry !== undefined) merged.push(entry)
  }
  return merged
}

function rawAssumeUnchangedStatusEntry(
  raw: CapturedRepositoryInventoryEntry & { readonly index: CapturedInventoryGitObject },
  inventory: CapturedRepositoryInventory,
): ParsedOrdinaryStatusEntry | undefined {
  const classification = classifyCapturedInventoryEntry(raw, inventory.comparison)
  if (raw.current.kind !== 'captured' || classification.conversionAmbiguous) {
    throw new RepositoryStatusError('ambiguous')
  }
  if (!classification.changed) return undefined
  const observedWorktreeMode = capturedEvidenceMode(raw.current.evidence)
  const observedWorktreeStatus = worktreeStatus(raw, inventory)
  return {
    kind: 'ordinary',
    path: raw.path.slice(),
    indexStatus: indexStatus(raw.head, raw.index),
    worktreeStatus: observedWorktreeStatus,
    submodule: { kind: 'not-submodule' },
    head: statusObjectSlot(raw.head, inventory.objectFormat),
    index: statusObjectSlot(raw.index, inventory.objectFormat),
    worktreeMode: observedWorktreeStatus === 'unchanged' ? raw.index.mode : observedWorktreeMode,
  }
}

function potentialIntentToAdd(
  raw: CapturedRepositoryInventoryEntry,
  objectFormat: CapturedRepositoryInventory['objectFormat'],
): boolean {
  return raw.head === undefined && raw.index?.objectId === EMPTY_BLOB_OBJECT_IDS[objectFormat]
}

function rawGitlinkStatusEntry(
  raw: CapturedRepositoryInventoryEntry,
  inventory: CapturedRepositoryInventory,
): ParsedStatusEntry | undefined {
  if (raw.untracked) throw new RepositoryStatusError('malformed')
  const observedWorktreeMode = capturedWorktreeMode(raw)
  if (observedWorktreeMode === undefined) return undefined
  if (raw.stages.some(stage => stage !== undefined)) {
    return {
      kind: 'unmerged',
      path: raw.path.slice(),
      indexStatus: 'unmerged',
      worktreeStatus: observedWorktreeMode === '000000' ? 'absent' : 'present',
      conflict: conflictStatus(raw),
      submodule: rawSubmoduleStatus(raw, capturedUnmergedEntryHasGitlink(raw)),
      base: statusObjectSlot(raw.stages[0], inventory.objectFormat),
      ours: statusObjectSlot(raw.stages[1], inventory.objectFormat),
      theirs: statusObjectSlot(raw.stages[2], inventory.objectFormat),
      worktreeMode: observedWorktreeMode,
    }
  }
  const worktreeStatus = rawWorktreeStatus(raw, inventory, observedWorktreeMode)
  if (worktreeStatus === undefined) return undefined
  return {
    kind: 'ordinary',
    path: raw.path.slice(),
    indexStatus: indexStatus(raw.head, raw.index),
    worktreeStatus,
    submodule: rawSubmoduleStatus(raw, true),
    head: statusObjectSlot(raw.head, inventory.objectFormat),
    index: statusObjectSlot(raw.index, inventory.objectFormat),
    worktreeMode: worktreeStatus === 'unchanged'
      ? raw.index?.mode ?? '000000'
      : observedWorktreeMode,
  }
}

function rawSubmoduleStatus(
  raw: CapturedRepositoryInventoryEntry,
  gitlink: boolean,
): ParsedSubmoduleStatus {
  if (!gitlink) return { kind: 'not-submodule' }
  return {
    kind: 'submodule',
    commitChanged: raw.index?.mode === '160000'
      && raw.current.kind === 'captured'
      && raw.current.evidence.kind === 'submodule'
      ? raw.index.objectId !== raw.current.evidence.objectId
      : 'unknown',
    trackedChanges: false,
    untrackedChanges: false,
  }
}

function capturedUnmergedEntryHasGitlink(raw: CapturedRepositoryInventoryEntry): boolean {
  return raw.stages.some(stage => stage?.mode === '160000')
    || (raw.current.kind === 'captured'
      ? raw.current.evidence.kind === 'submodule'
      : raw.current.observedMode === '160000')
}

function statusObjectSlot(
  value: CapturedInventoryGitObject | undefined,
  objectFormat: CapturedRepositoryInventory['objectFormat'],
): { readonly mode: ParsedGitMode; readonly objectId: string } {
  return value === undefined
    ? { mode: '000000', objectId: '0'.repeat(objectFormat === 'sha1' ? 40 : 64) }
    : value
}

function capturedWorktreeMode(raw: CapturedRepositoryInventoryEntry): ParsedGitMode | undefined {
  if (raw.current.kind === 'unavailable') {
    return raw.current.observedMode
  }
  return capturedEvidenceMode(raw.current.evidence)
}

function capturedEvidenceMode(
  evidence: Extract<CapturedRepositoryInventoryEntry['current'], { readonly kind: 'captured' }>['evidence'],
): ParsedGitMode {
  switch (evidence.kind) {
    case 'missing': return '000000'
    case 'submodule': return '160000'
    case 'symlink': return '120000'
    case 'regular': return evidence.mode
  }
}

function rawWorktreeStatus(
  raw: CapturedRepositoryInventoryEntry,
  inventory: CapturedRepositoryInventory,
  worktreeMode: ParsedGitMode,
): ParsedOrdinaryStatusEntry['worktreeStatus'] | undefined {
  if (raw.skipWorktree === true) return 'unchanged'
  if (raw.current.kind === 'captured') return worktreeStatus(raw, inventory)
  if (raw.index === undefined) return 'added'
  return modeKind(raw.index.mode) === modeKind(worktreeMode) ? undefined : 'type-changed'
}

function validateOrdinary(
  status: ParsedOrdinaryStatusEntry,
  raw: CapturedRepositoryInventoryEntry,
  inventory: CapturedRepositoryInventory,
): void {
  const intentToAdd = isIntentToAdd(status, raw, inventory.objectFormat)
  if (raw.untracked || raw.stages.some(stage => stage !== undefined)
    || !sameObjectSlot(status.head, raw.head)
    || (!intentToAdd && !sameObjectSlot(status.index, raw.index))
    || (!intentToAdd && status.indexStatus !== indexStatus(raw.head, raw.index))) {
    throw new RepositoryStatusError('malformed')
  }
  validateSubmodule(status.submodule, raw, capturedInventoryEntryHasGitlink(raw))
  const classification = classifyCapturedInventoryEntry(raw, inventory.comparison)
  if (!classification.conversionAmbiguous && raw.current.kind === 'captured') {
    const expected = intentToAdd ? 'added' : worktreeStatus(raw, inventory)
    if (status.worktreeStatus !== expected || !worktreeModeMatches(status.worktreeMode, raw, inventory)) {
      throw new RepositoryStatusError('ambiguous')
    }
  }
}

function isIntentToAdd(
  status: ParsedOrdinaryStatusEntry,
  raw: CapturedRepositoryInventoryEntry,
  objectFormat: 'sha1' | 'sha256',
): boolean {
  return status.indexStatus === 'unchanged'
    && status.worktreeStatus === 'added'
    && status.head.mode === '000000'
    && status.index.mode === '000000'
    && raw.head === undefined
    && raw.index?.objectId === EMPTY_BLOB_OBJECT_IDS[objectFormat]
}

function validateUnmerged(
  status: ParsedUnmergedStatusEntry,
  raw: CapturedRepositoryInventoryEntry,
): void {
  if (raw.untracked || raw.index !== undefined
    || !sameObjectSlot(status.base, raw.stages[0])
    || !sameObjectSlot(status.ours, raw.stages[1])
    || !sameObjectSlot(status.theirs, raw.stages[2])
    || status.conflict !== conflictStatus(raw)) {
    throw new RepositoryStatusError('malformed')
  }
  validateSubmodule(status.submodule, raw, capturedUnmergedEntryHasGitlink(raw))
  if (raw.current.kind === 'captured') {
    const present = raw.current.evidence.kind !== 'missing'
    if ((status.worktreeStatus === 'present') !== present) throw new RepositoryStatusError('ambiguous')
  }
}

function validateUntracked(raw: CapturedRepositoryInventoryEntry): void {
  if (!raw.untracked || raw.head !== undefined || raw.index !== undefined
    || raw.stages.some(stage => stage !== undefined)) {
    throw new RepositoryStatusError('malformed')
  }
}

function indexStatus(
  head: CapturedInventoryGitObject | undefined,
  index: CapturedInventoryGitObject | undefined,
): ParsedOrdinaryStatusEntry['indexStatus'] {
  if (head === undefined) return 'added'
  if (index === undefined) return 'deleted'
  if (head.mode === index.mode && head.objectId === index.objectId) return 'unchanged'
  return modeKind(head.mode) === modeKind(index.mode) ? 'modified' : 'type-changed'
}

function worktreeStatus(
  raw: CapturedRepositoryInventoryEntry,
  inventory: CapturedRepositoryInventory,
): ParsedOrdinaryStatusEntry['worktreeStatus'] {
  if (raw.current.kind !== 'captured') throw new RepositoryStatusError('ambiguous')
  const classification = classifyCapturedInventoryEntry(raw, inventory.comparison)
  if (!classification.unstaged) return 'unchanged'
  if (raw.current.evidence.kind === 'missing') return 'deleted'
  if (raw.index === undefined) return 'added'
  const currentKind = raw.current.evidence.kind === 'regular'
    ? 'regular'
    : raw.current.evidence.kind
  return modeKind(raw.index.mode) === currentKind ? 'modified' : 'type-changed'
}

function worktreeModeMatches(
  mode: ParsedGitMode,
  raw: CapturedRepositoryInventoryEntry,
  inventory: CapturedRepositoryInventory,
): boolean {
  if (raw.current.kind !== 'captured') return true
  if (raw.skipWorktree === true) return mode === (raw.index?.mode ?? '000000')
  switch (raw.current.evidence.kind) {
    case 'missing': return mode === '000000'
    case 'submodule': return mode === '160000'
    case 'symlink': return mode === '120000'
    case 'regular':
      return mode === raw.current.evidence.mode
        || (!inventory.comparison.fileMode && (mode === '100644' || mode === '100755'))
        || (!inventory.comparison.symlinks && raw.index?.mode === '120000' && mode === '120000')
  }
}

function validateSubmodule(
  status: ParsedSubmoduleStatus,
  raw: CapturedRepositoryInventoryEntry,
  gitlink: boolean,
): void {
  if ((status.kind === 'submodule') !== gitlink) throw new RepositoryStatusError('malformed')
  if (status.kind === 'submodule') {
    if (status.trackedChanges || status.untrackedChanges) throw new RepositoryStatusError('malformed')
    const commitChanged = raw.index?.mode === '160000' && raw.current.kind === 'captured'
      && raw.current.evidence.kind === 'submodule'
      ? raw.index.objectId !== raw.current.evidence.objectId
      : 'unknown'
    if (status.commitChanged !== commitChanged) {
      throw new RepositoryStatusError('ambiguous')
    }
  }
}

function conflictStatus(raw: CapturedRepositoryInventoryEntry): ParsedUnmergedStatusEntry['conflict'] {
  const mask = raw.stages.map(stage => stage === undefined ? '0' : '1').join('')
  switch (mask) {
    case '100': return 'both-deleted'
    case '010': return 'added-by-us'
    case '110': return 'deleted-by-them'
    case '001': return 'added-by-them'
    case '101': return 'deleted-by-us'
    case '011': return 'both-added'
    case '111': return 'both-modified'
    default: throw new RepositoryStatusError('malformed')
  }
}

function sameObjectSlot(
  status: { readonly mode: ParsedGitMode; readonly objectId: string },
  raw: CapturedInventoryGitObject | undefined,
): boolean {
  return raw === undefined
    ? status.mode === '000000' && /^0+$/u.test(status.objectId)
    : status.mode === raw.mode && status.objectId === raw.objectId
}

function modeKind(mode: ParsedGitMode): 'missing' | 'regular' | 'symlink' | 'submodule' {
  if (mode === '000000') return 'missing'
  if (mode === '120000') return 'symlink'
  if (mode === '160000') return 'submodule'
  return 'regular'
}

function pathKey(path: Uint8Array): string {
  return Buffer.from(path).toString('hex')
}
