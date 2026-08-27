/** Inventory-backed Git status projection for the Local Host. @module @breakfastdapaidang/saki-execution-local/status */

import type {
  ActiveHostProjectBinding,
  InheritedChangeBaseline,
  InheritedChangeBaselineEntry,
  InspectProjectFailureReason,
  ProjectGitChangeAttribution,
  ProjectGitChangeFingerprintMaterial,
  ProjectGitChangeMaterial,
  ProjectGitFileMode,
  ProjectGitHead,
  ProjectGitSubmoduleStatus,
  ProjectGitWorktreeEvidence,
  ProjectGitStatusObservation,
  ProjectGitStatusSeedMaterial,
  ProjectSelectionInspection,
} from '@breakfastdapaidang/saki-execution'
import {
  computeProjectGitChangeFingerprint,
  computeProjectGitChangeId,
  computeProjectGitStatusFingerprint,
  computeProjectGitStatusSeedDigest,
  isRepositoryRelativeGitPath,
  MAX_PROJECT_GIT_STATUS_CHANGES,
  MAX_PROJECT_GIT_STATUS_PATH_BYTES,
} from '@breakfastdapaidang/saki-execution'
import {
  capturedInventoryEntryHasGitlink,
  capturedInventoryPathDigest,
  classifyCapturedInventoryEntry,
  projectCapturedBaselineEntry,
  type CapturedInventoryGitObject,
  type CapturedRepositoryInventory,
  type CapturedRepositoryInventoryEntry,
} from './baseline.ts'
import { canonicalDigest } from './canonical.ts'
import type { VerifiedRepositoryStatus } from './status-evidence.ts'
import type {
  ParsedGitMode,
  ParsedStatusEntry,
  ParsedSubmoduleStatus,
} from './status-porcelain-v2.ts'

const UTF8 = new TextDecoder('utf-8', { fatal: true })

/** Minimum Resource Binding evidence needed for status attribution. */
export type ProjectGitStatusBinding = Pick<
  ActiveHostProjectBinding,
  'id' | 'revision' | 'health' | 'inheritedChangeBaseline'
>

/** Closed failure raised when a complete browser-safe projection cannot be built. */
export class ProjectGitStatusProjectionError extends Error {
  /** @param reason - bounded failure class safe for the Host API to translate. */
  constructor(readonly reason: Extract<InspectProjectFailureReason, 'invalid-path' | 'limit' | 'unavailable'>) {
    super(`Saki project Git status projection ${reason}`)
  }
}

/**
 * Project one confirmed raw inventory into browser-safe structured Git status.
 * @param inventory - final stable inventory from the same inspection observation.
 * @param inspection - confirmed safe and trusted selected-project evidence.
 * @param binding - revision and inherited baseline owned by the Resource Binding.
 * @param signal - required caller cancellation.
 * @param verifiedStatus - cross-validated porcelain truth for status membership and exact row state.
 * @param preEffectBaseline - fresh baseline derived from the same stable inventory.
 * @param unsupportedIndexState - special index flags or sparse state absent from tree identity.
 * @returns canonical status, index, worktree, and fingerprint evidence.
 */
export function buildProjectGitStatusObservation(
  inventory: CapturedRepositoryInventory,
  inspection: ProjectSelectionInspection,
  binding: ProjectGitStatusBinding,
  signal: AbortSignal,
  verifiedStatus: VerifiedRepositoryStatus,
  preEffectBaseline: InheritedChangeBaseline,
  unsupportedIndexState = false,
): ProjectGitStatusObservation {
  signal.throwIfAborted()
  if (!inventoryMatchesInspection(inventory, inspection)) {
    throw new ProjectGitStatusProjectionError('unavailable')
  }
  const baselineEntries = indexBaselineEntries(binding.inheritedChangeBaseline)
  const entries = [...inventory.entries]
    .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
  const inventoryByPath = new Map(entries.map(entry => [Buffer.from(entry.path).toString('hex'), entry]))
  const statusPaths = new Set(verifiedStatus.entries.map(entry => Buffer.from(entry.path).toString('hex')))
  const changeMaterials: ProjectGitChangeMaterial[] = []
  let changePathBytes = 0
  let conversionAmbiguous = false
  let currentUnavailable = false
  const indexEntries: Array<{
    readonly pathDigest: string
    readonly index: CapturedInventoryGitObject | null
    readonly stages: readonly [
      CapturedInventoryGitObject | null,
      CapturedInventoryGitObject | null,
      CapturedInventoryGitObject | null,
    ]
  }> = []
  const worktreeEntries: Array<{
    readonly pathDigest: string
    readonly current: CapturedRepositoryInventoryEntry['current']
    readonly skipWorktree?: boolean
  }> = []

  for (const entry of entries) {
    signal.throwIfAborted()
    const pathDigest = capturedInventoryPathDigest(entry.path)
    const classification = classifyCapturedInventoryEntry(entry, inventory.comparison)
    conversionAmbiguous ||= classification.conversionAmbiguous
    if (classification.changed && capturedInventoryEntryHasGitlink(entry)
      && !statusPaths.has(Buffer.from(entry.path).toString('hex'))) {
      throw new ProjectGitStatusProjectionError('unavailable')
    }
    if (entry.index !== undefined || entry.stages.some(stage => stage !== undefined)) {
      indexEntries.push({
        pathDigest,
        index: entry.index ?? null,
        stages: [entry.stages[0] ?? null, entry.stages[1] ?? null, entry.stages[2] ?? null],
      })
    }
    worktreeEntries.push({
      pathDigest,
      current: entry.current,
      ...(entry.skipWorktree === true ? { skipWorktree: true } : {}),
    })
  }

  for (const status of verifiedStatus.entries) {
    signal.throwIfAborted()
    const entry = inventoryByPath.get(Buffer.from(status.path).toString('hex'))
    if (entry === undefined) throw new ProjectGitStatusProjectionError('unavailable')
    if (entry.skipWorktree === true) throw new ProjectGitStatusProjectionError('unavailable')
    const pathDigest = capturedInventoryPathDigest(entry.path)
    const path = decodeInventoryPath(status.path)
    changePathBytes += status.path.byteLength
    if (changeMaterials.length >= MAX_PROJECT_GIT_STATUS_CHANGES
      || changePathBytes > MAX_PROJECT_GIT_STATUS_PATH_BYTES) {
      throw new ProjectGitStatusProjectionError('limit')
    }
    const retained = entry.current.kind === 'captured'
      ? projectCapturedBaselineEntry({ ...entry, current: entry.current }, pathDigest)
      : undefined
    const worktreeEvidence = projectWorktreeEvidence(entry.current)
    currentUnavailable ||= worktreeEvidence.kind === 'unavailable'
    const fingerprintMaterial = projectChange(
      status,
      path,
      changeAttribution(binding.inheritedChangeBaseline, baselineEntries, retained),
      worktreeEvidence,
    )
    changeMaterials.push({ ...fingerprintMaterial, fingerprint: computeProjectGitChangeFingerprint(fingerprintMaterial) })
  }

  const index = verifiedStatus.index.kind === 'tree'
    ? verifiedStatus.index
    : {
      kind: 'unmerged' as const,
      stagesDigest: {
        version: 1 as const,
        digest: canonicalDigest('saki/project-git-unmerged-index/v1', {
          formatVersion: 1,
          objectFormat: inventory.objectFormat,
          entries: indexEntries,
        }),
      },
    }
  const worktree = {
    version: 1 as const,
    digest: canonicalDigest('saki/project-git-worktree/v1', {
      formatVersion: 1,
      objectFormat: inventory.objectFormat,
      comparison: inventory.comparison,
      entries: worktreeEntries,
      changes: changeMaterials.map(change => change.fingerprint),
    }),
  }
  const projection = inspection.projection
  const branch = verifiedStatus.branch.head.kind === 'detached'
    ? { kind: 'detached' as const }
    : {
      kind: 'attached' as const,
      ref: attachedBranchRef(projection.head),
      name: verifiedStatus.branch.head.name,
    }
  const statusUpstream = verifiedStatus.branch.upstream
  const upstream = statusUpstream === undefined
    ? undefined
    : {
      ref: requiredUpstreamRef(projection.upstream),
      name: statusUpstream.name,
      ...(statusUpstream.ahead === undefined || statusUpstream.behind === undefined
        ? {}
        : { divergence: { ahead: statusUpstream.ahead, behind: statusUpstream.behind } }),
    }
  const mutationBlockers = [
    ...(preEffectBaseline.kind === 'unavailable' ? ['baseline-unavailable' as const] : []),
    ...(conversionAmbiguous ? ['conversion-ambiguous' as const] : []),
    ...(currentUnavailable ? ['current-unavailable' as const] : []),
    ...(unsupportedIndexState ? ['index-flags' as const] : []),
    ...(verifiedStatus.index.kind === 'unmerged' ? ['unmerged' as const] : []),
    ...(projection.locked ? ['locked' as const] : []),
  ]
  const seed: ProjectGitStatusSeedMaterial = {
    observationVersion: 1 as const,
    bindingId: binding.id,
    bindingRevision: binding.revision,
    bindingHealth: binding.health,
    locked: projection.locked,
    objectFormat: projection.objectFormat,
    head: projection.head,
    branch,
    ...(upstream === undefined ? {} : { upstream }),
    index,
    worktree,
    changes: changeMaterials,
    structuredMutation: mutationBlockers.length === 0
      ? { available: true, blockers: [] }
      : { available: false, blockers: mutationBlockers },
  }
  const statusSeedDigest = computeProjectGitStatusSeedDigest(seed)
  const changes = changeMaterials.map(change => ({
    id: computeProjectGitChangeId(statusSeedDigest, change),
    ...change,
  }))
  const material = { ...seed, changes }
  const observed = { ...material, observedAt: Date.now() }
  signal.throwIfAborted()
  return {
    ...observed,
    fingerprint: computeProjectGitStatusFingerprint(observed),
  }
}

function inventoryMatchesInspection(
  inventory: CapturedRepositoryInventory,
  inspection: ProjectSelectionInspection,
): boolean {
  const comparison = inspection.trusted.comparison
  return inventory.objectFormat === inspection.projection.objectFormat
    && inventory.comparison.fileMode === comparison.fileMode
    && inventory.comparison.symlinks === comparison.symlinks
    && inventory.comparison.autocrlf === comparison.autocrlf
}

function indexBaselineEntries(
  baseline: InheritedChangeBaseline,
): ReadonlyMap<string, InheritedChangeBaselineEntry> | undefined {
  if (baseline.kind === 'unavailable') return undefined
  const entries = new Map<string, InheritedChangeBaselineEntry>()
  for (const entry of baseline.entries) {
    if (entries.has(entry.pathDigest)) throw new ProjectGitStatusProjectionError('unavailable')
    entries.set(entry.pathDigest, entry)
  }
  return entries
}

function projectChange(
  status: ParsedStatusEntry,
  path: string,
  attribution: ProjectGitChangeAttribution,
  worktreeEvidence: ProjectGitWorktreeEvidence,
): ProjectGitChangeFingerprintMaterial {
  switch (status.kind) {
    case 'ordinary': return {
      path,
      kind: status.kind,
      indexStatus: status.indexStatus,
      worktreeStatus: status.worktreeStatus,
      submodule: projectSubmodule(status.submodule),
      head: { mode: projectMode(status.head.mode), objectId: status.head.objectId },
      index: { mode: projectMode(status.index.mode), objectId: status.index.objectId },
      worktreeMode: projectMode(status.worktreeMode),
      worktreeEvidence,
      attribution,
    }
    case 'untracked': return {
      path,
      kind: status.kind,
      indexStatus: status.indexStatus,
      worktreeStatus: status.worktreeStatus,
      submodule: { kind: 'not-submodule' },
      worktreeMode: projectUntrackedWorktreeMode(worktreeEvidence),
      worktreeEvidence,
      attribution,
    }
    case 'unmerged': return {
      path,
      kind: status.kind,
      indexStatus: status.indexStatus,
      worktreeStatus: status.worktreeStatus,
      conflict: status.conflict,
      submodule: projectSubmodule(status.submodule),
      stages: {
        base: { mode: projectMode(status.base.mode), objectId: status.base.objectId },
        ours: { mode: projectMode(status.ours.mode), objectId: status.ours.objectId },
        theirs: { mode: projectMode(status.theirs.mode), objectId: status.theirs.objectId },
      },
      worktreeMode: projectMode(status.worktreeMode),
      worktreeEvidence,
      attribution,
    }
  }
}

function projectWorktreeEvidence(
  current: CapturedRepositoryInventoryEntry['current'],
): ProjectGitWorktreeEvidence {
  return current.kind === 'captured'
    ? current.evidence
    : { kind: 'unavailable', reason: current.reason }
}

function projectMode(mode: ParsedGitMode): ProjectGitFileMode {
  if (mode === '040000') throw new ProjectGitStatusProjectionError('unavailable')
  return mode
}

function projectUntrackedWorktreeMode(
  evidence: ProjectGitWorktreeEvidence,
): '100644' | '100755' | '120000' | 'unknown' {
  switch (evidence.kind) {
    case 'unavailable': return 'unknown'
    case 'regular': return evidence.mode
    case 'symlink': return '120000'
    case 'missing':
    case 'submodule': throw new ProjectGitStatusProjectionError('unavailable')
  }
}

function projectSubmodule(status: ParsedSubmoduleStatus): ProjectGitSubmoduleStatus {
  if (status.kind === 'not-submodule') return status
  return {
    kind: 'submodule',
    commit: status.commitChanged === 'unknown'
      ? 'unknown'
      : status.commitChanged ? 'changed' : 'unchanged',
  }
}

function attachedBranchRef(head: ProjectGitHead): string {
  if (head.symbolicRef === undefined) throw new ProjectGitStatusProjectionError('unavailable')
  return head.symbolicRef
}

function requiredUpstreamRef(ref: string | undefined): string {
  if (ref === undefined) throw new ProjectGitStatusProjectionError('unavailable')
  return ref
}

function changeAttribution(
  baseline: InheritedChangeBaseline,
  entries: ReadonlyMap<string, InheritedChangeBaselineEntry> | undefined,
  current: InheritedChangeBaselineEntry | undefined,
): ProjectGitChangeAttribution {
  if (current === undefined || baseline.kind === 'unavailable' || entries === undefined) return 'unattributed'
  const inherited = entries.get(current.pathDigest)
  if (inherited === undefined) return 'not-inherited'
  return inherited.digest === current.digest ? 'inherited' : 'unattributed'
}

function decodeInventoryPath(path: Uint8Array): string {
  let value: string
  try {
    value = UTF8.decode(path)
  } catch {
    throw new ProjectGitStatusProjectionError('invalid-path')
  }
  if (!isRepositoryRelativeGitPath(value)) throw new ProjectGitStatusProjectionError('invalid-path')
  return value
}
