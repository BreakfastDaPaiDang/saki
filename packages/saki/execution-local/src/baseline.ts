/** Registration-time inherited-change baseline projection. @module @breakfastdapaidang/saki-execution-local/baseline */

import { performance } from 'node:perf_hooks'
import type {
  InheritedChangeBaseline,
  InheritedChangeBaselineBounds,
  InheritedChangeBaselineEntry,
  InheritedChangeBaselineUnavailableReason,
  InheritedCurrentWorktreeEvidence,
  InheritedGitObjectEvidence,
  InheritedGitObjectSlot,
} from '@breakfastdapaidang/saki-execution'
import { canonicalDigest, exactBytesDigest } from './canonical.ts'

type BaselineEntryWithoutDigest = InheritedChangeBaselineEntry extends infer Entry
  ? Entry extends InheritedChangeBaselineEntry ? Omit<Entry, 'digest'> : never
  : never

/** One HEAD, stage-zero, or conflict-stage object in the closed inventory. */
export type CapturedInventoryGitObject = Omit<InheritedGitObjectEvidence, 'kind'>

/** Raw current evidence plus the repository-format object id used for comparison. */
export type CapturedInventoryWorktree =
  | {
    readonly kind: 'captured'
    readonly evidence: InheritedCurrentWorktreeEvidence
    readonly rawObjectId?: string
    readonly rawByteLength: number
    readonly gitEvidenceBytes: number
  }
  | {
    readonly kind: 'unavailable'
    readonly reason: InheritedChangeBaselineUnavailableReason
  }

/** Conversion classes retained in memory for one exact inventory path. */
export interface CapturedInventoryConversion {
  readonly executableFilter: boolean
  readonly unmodeled: boolean
  readonly lineEnding: boolean
}

/** One exact path joined across HEAD, index stages, untracked, and current facts. */
export interface CapturedRepositoryInventoryEntry {
  readonly path: Uint8Array
  readonly head?: CapturedInventoryGitObject
  readonly index?: CapturedInventoryGitObject
  readonly stages: readonly [
    CapturedInventoryGitObject | undefined,
    CapturedInventoryGitObject | undefined,
    CapturedInventoryGitObject | undefined,
  ]
  readonly untracked: boolean
  readonly current: CapturedInventoryWorktree
  readonly conversion: CapturedInventoryConversion
}

type CapturedRepositoryInventoryEntryWithCurrent = CapturedRepositoryInventoryEntry & {
  readonly current: Extract<CapturedInventoryWorktree, { readonly kind: 'captured' }>
}

/** Complete raw-byte inventory needed to derive changed membership and retention. */
export interface CapturedRepositoryInventory {
  readonly objectFormat: 'sha1' | 'sha256'
  readonly comparison: {
    readonly fileMode: boolean
    readonly symlinks: boolean
    readonly autocrlf: boolean
  }
  readonly allowlistedGitEvidenceBytes: number
  readonly capture: { readonly elapsedMs: number; readonly rawBytes: number }
  readonly entries: readonly CapturedRepositoryInventoryEntry[]
}

/** Browser-safe aggregate facts plus the exact baseline result. */
export interface BuiltInheritedChangeBaseline {
  readonly baseline: InheritedChangeBaseline
  readonly inheritedChangeEntryCount: number
  readonly conversionAmbiguous: boolean
}

/**
 * Build retained inherited-change evidence from one complete closed inventory.
 * @param inventory - complete joined HEAD, index, current, and conversion facts.
 * @param bounds - independent bounds applied only to changed-entry retention.
 * @param capturedAt - Host clock evidence excluded from the baseline digest.
 * @param signal - required caller cancellation.
 * @returns aggregate raw-change facts and a complete or unavailable baseline.
 */
export function buildInheritedChangeBaseline(
  inventory: CapturedRepositoryInventory,
  bounds: InheritedChangeBaselineBounds,
  capturedAt: number,
  signal: AbortSignal,
): BuiltInheritedChangeBaseline {
  const startedAt = performance.now()
  signal.throwIfAborted()
  const changed = inventory.entries
    .filter(entry => inventoryEntryChanged(entry, inventory.comparison))
    .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
  const conversionAmbiguous = inventory.entries.some(entry => conversionIsAmbiguous(entry, inventory.comparison))
  signal.throwIfAborted()
  const stableObserved = {
    entries: changed.length,
    pathBytes: changed.reduce((total, entry) => total + entry.path.byteLength, 0),
    gitOutputBytes: changed.reduce((total, entry) => total
      + (entry.current.kind === 'captured' ? entry.current.gitEvidenceBytes : 0),
    inventory.allowlistedGitEvidenceBytes),
    hashedBytes: changed.reduce((total, entry) => total
      + (entry.current.kind === 'captured' ? entry.current.rawByteLength : 0), 0),
  }
  const inventoryRawBytes = inventory.entries.reduce((total, entry) => total
    + (entry.current.kind === 'captured' ? entry.current.rawByteLength : 0), 0)
  const elapsedMs = (): number => inventory.capture.elapsedMs + Math.ceil(performance.now() - startedAt)
  const unavailable = (reason: InheritedChangeBaselineUnavailableReason): BuiltInheritedChangeBaseline => ({
    inheritedChangeEntryCount: changed.length,
    conversionAmbiguous,
    baseline: { kind: 'unavailable', reason, observed: { ...stableObserved, elapsedMs: elapsedMs() } },
  })
  if (changed.length > bounds.maxEntries) return unavailable('entry-limit')
  if (inventoryRawBytes !== inventory.capture.rawBytes) return unavailable('io-failure')
  if (stableObserved.pathBytes > bounds.maxPathBytes) return unavailable('path-limit')
  if (stableObserved.gitOutputBytes > bounds.maxGitOutputBytes) return unavailable('git-output-limit')
  if (changed.some(entry => entry.current.kind === 'captured'
    && entry.current.rawByteLength > bounds.maxFileBytes)) return unavailable('file-limit')
  if (stableObserved.hashedBytes > bounds.maxTotalFileBytes) return unavailable('hash-limit')
  if (elapsedMs() > bounds.maxCaptureMs) return unavailable('time-limit')
  const unavailableCurrent = changed.find(entry => entry.current.kind === 'unavailable')?.current
  if (unavailableCurrent?.kind === 'unavailable') return unavailable(unavailableCurrent.reason)
  const capturedChanged = changed.filter(
    (entry): entry is CapturedRepositoryInventoryEntryWithCurrent => entry.current.kind === 'captured',
  )

  const entries: InheritedChangeBaselineEntry[] = []
  const pathDigests = new Set<string>()
  for (const raw of capturedChanged) {
    signal.throwIfAborted()
    if (elapsedMs() > bounds.maxCaptureMs) return unavailable('time-limit')
    const pathDigest = exactBytesDigest('saki/inherited-path/v1', withNul(raw.path))
    if (pathDigests.has(pathDigest)) return unavailable('duplicate-path')
    pathDigests.add(pathDigest)
    const entry = retainedInventoryEntry(raw, pathDigest)
    if (entry === undefined) return unavailable('unsupported-state')
    entries.push({ ...entry, digest: canonicalDigest('saki/inherited-entry/v1', entry) })
  }
  const digest = canonicalDigest('saki/inherited-baseline/v1', {
    formatVersion: 1,
    bounds,
    observed: { ...stableObserved, elapsedMs: 0 },
    entries,
  })
  signal.throwIfAborted()
  const finalElapsedMs = elapsedMs()
  if (finalElapsedMs > bounds.maxCaptureMs) return unavailable('time-limit')
  const observed = { ...stableObserved, elapsedMs: finalElapsedMs }
  return {
    inheritedChangeEntryCount: changed.length,
    conversionAmbiguous,
    baseline: { kind: 'complete', formatVersion: 1, capturedAt, bounds, observed, entries, digest },
  }
}

function retainedInventoryEntry(
  raw: CapturedRepositoryInventoryEntryWithCurrent,
  pathDigest: string,
): BaselineEntryWithoutDigest | undefined {
  const common = { formatVersion: 1 as const, pathDigest }
  if (raw.stages.some(stage => stage !== undefined)) {
    return {
      ...common,
      statusKind: 'unmerged',
      head: objectSlot(raw.head),
      stages: [objectSlot(raw.stages[0]), objectSlot(raw.stages[1]), objectSlot(raw.stages[2])],
      worktree: raw.current.evidence,
    }
  }
  if (raw.head !== undefined || raw.index !== undefined) {
    return {
      ...common,
      statusKind: 'tracked',
      head: objectSlot(raw.head),
      index: objectSlot(raw.index),
      worktree: raw.current.evidence,
    }
  }
  if (raw.untracked
    && (raw.current.evidence.kind === 'regular' || raw.current.evidence.kind === 'symlink')) {
    return { ...common, statusKind: 'untracked', worktree: raw.current.evidence }
  }
  return undefined
}

function objectSlot(value: CapturedInventoryGitObject | undefined): InheritedGitObjectSlot {
  return value === undefined ? { kind: 'missing' } : { kind: 'object', ...value }
}

function inventoryEntryChanged(
  entry: CapturedRepositoryInventoryEntry,
  comparison: CapturedRepositoryInventory['comparison'],
): boolean {
  if (entry.stages.some(stage => stage !== undefined) || entry.untracked) return true
  if (!sameGitObject(entry.head, entry.index)) return true
  if (entry.current.kind === 'unavailable') return true
  return !currentMatchesIndex(entry.current, entry.index, comparison)
}

function conversionIsAmbiguous(
  entry: CapturedRepositoryInventoryEntry,
  comparison: CapturedRepositoryInventory['comparison'],
): boolean {
  if (entry.current.kind === 'captured' && entry.current.evidence.kind === 'submodule') return true
  if (entry.conversion.executableFilter || entry.conversion.unmodeled) return true
  if (!entry.conversion.lineEnding && !comparison.autocrlf) return false
  if (entry.current.kind === 'unavailable') return false
  return entry.current.rawObjectId !== entry.index?.objectId
}

function currentMatchesIndex(
  current: Extract<CapturedInventoryWorktree, { readonly kind: 'captured' }>,
  index: CapturedInventoryGitObject | undefined,
  comparison: CapturedRepositoryInventory['comparison'],
): boolean {
  if (index === undefined || current.rawObjectId === undefined) {
    return index === undefined && current.evidence.kind === 'missing'
  }
  if (current.rawObjectId !== index.objectId) return false
  switch (current.evidence.kind) {
    case 'regular':
      if (index.mode === '120000' && !comparison.symlinks) return true
      if (index.mode !== '100644' && index.mode !== '100755') return false
      return !comparison.fileMode || current.evidence.mode === index.mode
    case 'symlink': return index.mode === '120000'
    case 'submodule': return index.mode === '160000'
    case 'missing': return false
  }
}

function sameGitObject(
  left: CapturedInventoryGitObject | undefined,
  right: CapturedInventoryGitObject | undefined,
): boolean {
  return left === undefined || right === undefined
    ? left === right
    : left.mode === right.mode && left.objectId === right.objectId
}

function withNul(bytes: Uint8Array): Uint8Array {
  const framed = new Uint8Array(bytes.byteLength + 1)
  framed.set(bytes)
  return framed
}
