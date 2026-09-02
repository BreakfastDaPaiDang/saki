/** Canonical Saki project-inspection identity material. @module @breakfastdapaidang/saki-execution/fingerprint */

import type {
  InheritedChangeBaseline,
  InheritedChangeBaselineBounds,
  InheritedChangeBaselineEntry,
  InheritedChangeBaselineObservedLimits,
  InheritedChangeBaselineUnavailableReason,
  ProjectGitChange,
  ProjectGitChangeFingerprint,
  ProjectGitChangeId,
  ProjectGitHead,
  ProjectGitStatusFingerprint,
  ProjectGitStatusObservation,
  ProjectInspectionFingerprint,
  ProjectSelectionProjection,
  RepositoryComparisonObservation,
  SafeGitRemoteObservation,
  StartAgentRunInputMessage,
  TrustedProjectSelectionObservation,
  WorkspaceId,
} from './types.ts'
import { canonicalDigest, exactBytesDigest } from './canonical.ts'

const UTF8 = new TextEncoder()

/**
 * Compute the immutable payload identity of one preallocated Agent Run input.
 * @param input - complete identified UserMessage, including Saki provenance.
 * @returns lowercase canonical SHA-256 digest.
 */
export function computeStartAgentRunPayloadDigest(input: StartAgentRunInputMessage): string {
  return canonicalDigest('saki/start-agent-run-input/v1', input)
}

/** Stable baseline material with capture timestamp and elapsed duration removed. */
export type InheritedChangeBaselineIdentityMaterial =
  | {
    readonly kind: 'unavailable'
    readonly reason: InheritedChangeBaselineUnavailableReason
    readonly observed: Omit<InheritedChangeBaselineObservedLimits, 'elapsedMs'>
  }
  | {
    readonly kind: 'complete'
    readonly formatVersion: 1
    readonly bounds: InheritedChangeBaselineBounds
    readonly observed: Omit<InheritedChangeBaselineObservedLimits, 'elapsedMs'>
    readonly entries: readonly InheritedChangeBaselineEntry[]
    readonly digest: string
  }

/** Explicit Workspace observation bound into a confirmed inspection. */
export type ProjectInspectionWorkspaceObservation =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly workspaceId: WorkspaceId }

/** Complete stable material covered by a project-inspection fingerprint. */
export interface ProjectInspectionFingerprintMaterial {
  readonly observationVersion: 2
  readonly hostId: ProjectSelectionProjection['hostId']
  readonly displayLocation: string
  readonly worktreePathDigest: string
  readonly gitDirectoryDigest: string
  readonly commonDirectoryDigest: string
  readonly gitDirectoryIdentity: TrustedProjectSelectionObservation['gitDirectoryIdentity']
  readonly commonGitDirectoryIdentity: TrustedProjectSelectionObservation['commonGitDirectoryIdentity']
  readonly objectFormat: ProjectSelectionProjection['objectFormat']
  readonly head: ProjectGitHead
  readonly locked: boolean
  readonly inheritedChangeEntryCount: number
  readonly conversionAmbiguous: boolean
  readonly comparison: RepositoryComparisonObservation
  readonly workspace: ProjectInspectionWorkspaceObservation
  readonly upstream?: string
  readonly remotes: readonly SafeGitRemoteObservation[]
  readonly githubRepositoryCandidates?: readonly string[]
  readonly baseline: InheritedChangeBaselineIdentityMaterial
}

/** Stable inspection material excluding only the phase-sensitive Workspace observation. */
export type ProjectInspectionWorkspaceIndependentMaterial = Omit<ProjectInspectionFingerprintMaterial, 'workspace'>

/** Complete stable material covered by one structured Git-status fingerprint. */
export type ProjectGitStatusFingerprintMaterial = Omit<ProjectGitStatusObservation, 'fingerprint' | 'observedAt'>

/** One public change row without its observation-scoped identity. */
export type ProjectGitChangeMaterial = ProjectGitChange extends infer Change
  ? Change extends ProjectGitChange ? Omit<Change, 'id'> : never
  : never

/** One exact change row before adding its fingerprint and observation-scoped id. */
export type ProjectGitChangeFingerprintMaterial = ProjectGitChange extends infer Change
  ? Change extends ProjectGitChange ? Omit<Change, 'id' | 'fingerprint'> : never
  : never

/** Complete status material used to scope every change identity before final fingerprinting. */
export type ProjectGitStatusSeedMaterial = Omit<
  ProjectGitStatusObservation,
  'fingerprint' | 'changes' | 'observedAt'
> & { readonly changes: readonly ProjectGitChangeMaterial[] }

type ProjectGitStatusCommonMaterial = Omit<ProjectGitStatusFingerprintMaterial, 'changes'>

function projectGitStatusCommonMaterial(
  observation: Omit<ProjectGitStatusObservation, 'fingerprint'>,
): ProjectGitStatusCommonMaterial {
  return {
    observationVersion: observation.observationVersion,
    bindingId: observation.bindingId,
    bindingRevision: observation.bindingRevision,
    bindingHealth: observation.bindingHealth,
    locked: observation.locked,
    objectFormat: observation.objectFormat,
    head: observation.head,
    branch: observation.branch,
    ...(observation.upstream === undefined ? {} : { upstream: observation.upstream }),
    index: observation.index,
    worktree: observation.worktree,
    structuredMutation: observation.structuredMutation,
  }
}

/**
 * Remove change ids and the final fingerprint from one complete status.
 * @param observation - complete status material before final fingerprinting.
 * @returns canonical observation seed shared by every contained change id.
 */
export function projectGitStatusSeedMaterial(
  observation: Omit<ProjectGitStatusObservation, 'fingerprint'>,
): ProjectGitStatusSeedMaterial {
  return {
    ...projectGitStatusCommonMaterial(observation),
    changes: observation.changes.map(({ id: _id, ...change }) => change),
  }
}

/**
 * Digest the complete id-free status observation used to scope change identities.
 * @param material - canonical status seed with id-free rows.
 * @returns lowercase SHA-256 seed digest.
 */
export function computeProjectGitStatusSeedDigest(material: ProjectGitStatusSeedMaterial): string {
  return canonicalDigest('saki/project-git-status-seed/v1', material)
}

/**
 * Fingerprint one exact public change row independently of its observation.
 * @param change - exact row before its fingerprint and scoped id are attached.
 * @returns versioned canonical row fingerprint.
 */
export function computeProjectGitChangeFingerprint(
  change: ProjectGitChangeFingerprintMaterial,
): ProjectGitChangeFingerprint {
  return { version: 1, digest: canonicalDigest('saki/project-git-change/v1', change) }
}

/**
 * Derive one opaque change id from the complete observation seed and its public row.
 * @param statusSeedDigest - digest of the complete id-free status observation.
 * @param change - one id-free canonical change row contained by that observation.
 * @returns observation-scoped branded Git change identity.
 */
export function computeProjectGitChangeId(
  statusSeedDigest: string,
  change: ProjectGitChangeMaterial,
): ProjectGitChangeId {
  return `git-change-${canonicalDigest('saki/project-git-change-id/v1', { statusSeedDigest, change })}` as ProjectGitChangeId
}

/**
 * Reconstruct all facts covered by one structured Git-status fingerprint.
 * @param observation - complete status values, with or without their fingerprint.
 * @returns typed canonical material for durable comparison.
 */
export function projectGitStatusFingerprintMaterial(
  observation: Omit<ProjectGitStatusObservation, 'fingerprint'>,
): ProjectGitStatusFingerprintMaterial {
  return {
    ...projectGitStatusCommonMaterial(observation),
    changes: observation.changes,
  }
}

/**
 * Recompute the fingerprint for one complete structured Git-status observation.
 * @param observation - complete status values, with or without their fingerprint.
 * @returns versioned canonical status fingerprint.
 */
export function computeProjectGitStatusFingerprint(
  observation: Omit<ProjectGitStatusObservation, 'fingerprint'>,
): ProjectGitStatusFingerprint {
  return {
    version: 1,
    digest: canonicalDigest('saki/project-git-status/v1', projectGitStatusFingerprintMaterial(observation)),
  }
}

/**
 * Remove observation-time fields from baseline evidence used for identity.
 * @param baseline - complete or unavailable inherited-change evidence.
 * @returns stable evidence suitable for comparison and canonical hashing.
 */
export function inheritedChangeBaselineIdentityMaterial(
  baseline: InheritedChangeBaseline,
): InheritedChangeBaselineIdentityMaterial {
  const { elapsedMs: _elapsedMs, ...observed } = baseline.observed
  if (baseline.kind === 'unavailable') return { kind: baseline.kind, reason: baseline.reason, observed }
  return {
    kind: baseline.kind,
    formatVersion: baseline.formatVersion,
    bounds: baseline.bounds,
    observed,
    entries: baseline.entries,
    digest: baseline.digest,
  }
}

/**
 * Reconstruct all stable facts covered by one inspection fingerprint.
 * @param projection - browser-safe inspection values, with or without its fingerprint.
 * @param trusted - Host-only path and comparison evidence from the same observation.
 * @returns typed canonical material for strict or phase-aware comparison.
 */
export function projectInspectionFingerprintMaterial(
  projection: Omit<ProjectSelectionProjection, 'fingerprint'>,
  trusted: TrustedProjectSelectionObservation,
): ProjectInspectionFingerprintMaterial {
  return {
    observationVersion: projection.observationVersion,
    hostId: projection.hostId,
    displayLocation: projection.displayLocation,
    worktreePathDigest: exactBytesDigest('saki/worktree-path/v1', UTF8.encode(trusted.canonicalWorktreePath)),
    gitDirectoryDigest: exactBytesDigest('saki/git-directory/v1', UTF8.encode(trusted.canonicalGitDirectory)),
    commonDirectoryDigest: exactBytesDigest('saki/common-git-directory/v1', UTF8.encode(trusted.canonicalCommonGitDirectory)),
    gitDirectoryIdentity: trusted.gitDirectoryIdentity,
    commonGitDirectoryIdentity: trusted.commonGitDirectoryIdentity,
    objectFormat: projection.objectFormat,
    head: projection.head,
    locked: projection.locked,
    inheritedChangeEntryCount: projection.inheritedChangeEntryCount,
    conversionAmbiguous: projection.conversionAmbiguous,
    comparison: trusted.comparison,
    workspace: projection.workspaceId === undefined
      ? { kind: 'absent' }
      : { kind: 'present', workspaceId: projection.workspaceId },
    ...(projection.upstream === undefined ? {} : { upstream: projection.upstream }),
    remotes: projection.remotes,
    ...(projection.githubRepositoryCandidates === undefined
      ? {}
      : { githubRepositoryCandidates: projection.githubRepositoryCandidates }),
    baseline: inheritedChangeBaselineIdentityMaterial(projection.baseline),
  }
}

/**
 * Reconstruct the stable inspection facts that must survive an expected Workspace effect.
 * @param projection - browser-safe inspection values, with or without its fingerprint.
 * @param trusted - Host-only evidence from the same observation.
 * @returns fingerprint material with only the Workspace observation removed.
 */
export function projectInspectionWorkspaceIndependentMaterial(
  projection: Omit<ProjectSelectionProjection, 'fingerprint'>,
  trusted: TrustedProjectSelectionObservation,
): ProjectInspectionWorkspaceIndependentMaterial {
  const { workspace: _workspace, ...material } = projectInspectionFingerprintMaterial(projection, trusted)
  return material
}

/**
 * Recompute the fingerprint for one complete inspection observation.
 * @param projection - browser-safe inspection values, with or without its fingerprint.
 * @param trusted - Host-only evidence from the same observation.
 * @returns versioned canonical inspection fingerprint.
 */
export function computeProjectInspectionFingerprint(
  projection: Omit<ProjectSelectionProjection, 'fingerprint'>,
  trusted: TrustedProjectSelectionObservation,
): ProjectInspectionFingerprint {
  return {
    version: 2,
    digest: canonicalDigest('saki/project-inspection/v2', projectInspectionFingerprintMaterial(projection, trusted)),
  }
}
