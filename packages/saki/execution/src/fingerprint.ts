/** Canonical Saki project-inspection identity material. @module @breakfastdapaidang/saki-execution/fingerprint */

import type {
  InheritedChangeBaseline,
  InheritedChangeBaselineBounds,
  InheritedChangeBaselineEntry,
  InheritedChangeBaselineObservedLimits,
  InheritedChangeBaselineUnavailableReason,
  ProjectInspectionFingerprint,
  ProjectSelectionProjection,
  RepositoryComparisonObservation,
  SafeGitRemoteObservation,
  TrustedProjectSelectionObservation,
  WorkspaceId,
} from './types.ts'
import { canonicalDigest, exactBytesDigest } from './canonical.ts'

const UTF8 = new TextEncoder()

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
  readonly observationVersion: 1
  readonly hostId: ProjectSelectionProjection['hostId']
  readonly displayLocation: string
  readonly worktreePathDigest: string
  readonly gitDirectoryDigest: string
  readonly commonDirectoryDigest: string
  readonly gitDirectoryIdentity: TrustedProjectSelectionObservation['gitDirectoryIdentity']
  readonly commonGitDirectoryIdentity: TrustedProjectSelectionObservation['commonGitDirectoryIdentity']
  readonly objectFormat: ProjectSelectionProjection['objectFormat']
  readonly head: string
  readonly branch?: string
  readonly detached: boolean
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
    ...(projection.branch === undefined ? {} : { branch: `refs/heads/${projection.branch}` }),
    detached: projection.detached,
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
    version: 1,
    digest: canonicalDigest('saki/project-inspection/v1', projectInspectionFingerprintMaterial(projection, trusted)),
  }
}
