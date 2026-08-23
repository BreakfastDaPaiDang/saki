/** Public value types for Saki Host Execution. @module @breakfastdapaidang/saki-execution/types */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'

export type { WorkspaceId } from '@deepseek-ai/dsh-workspace'

/** Stable identity of one enrolled Saki Host. */
export type SakiHostId = Branded<'SakiHostId'>

/** Versioned digest of one confirmed project-selection inspection. */
export interface ProjectInspectionFingerprint {
  readonly version: 1
  readonly digest: string
}

/** Applied bounds recorded with a registration-time baseline capture. */
export interface InheritedChangeBaselineBounds {
  readonly maxEntries: number
  readonly maxPathBytes: number
  readonly maxGitOutputBytes: number
  readonly maxFileBytes: number
  readonly maxTotalFileBytes: number
  readonly maxCaptureMs: number
}

/** Observed resource totals retained for a complete or unavailable capture. */
export interface InheritedChangeBaselineObservedLimits {
  readonly entries: number
  readonly pathBytes: number
  /** Bytes of allowlisted parsed Git evidence; raw output is bounded before parsing and never retained. */
  readonly gitOutputBytes: number
  readonly hashedBytes: number
  readonly elapsedMs: number
}

/** Raw current-worktree evidence for one changed path, without plaintext path or content. */
export type InheritedCurrentWorktreeEvidence =
  | { readonly kind: 'regular'; readonly mode: '100644' | '100755'; readonly byteLength: number; readonly contentDigest: string }
  | { readonly kind: 'symlink'; readonly targetDigest: string }
  | { readonly kind: 'submodule'; readonly objectId: string }
  | { readonly kind: 'missing' }

/** One present Git tree or index object retained without its plaintext path. */
export interface InheritedGitObjectEvidence {
  readonly kind: 'object'
  readonly mode: '100644' | '100755' | '120000' | '160000'
  readonly objectId: string
}

/** Explicit presence or absence of one HEAD, index, or conflict-stage slot. */
export type InheritedGitObjectSlot = InheritedGitObjectEvidence | { readonly kind: 'missing' }

interface InheritedChangeBaselineEntryBase {
  readonly formatVersion: 1
  readonly pathDigest: string
  readonly digest: string
}

/** One ordered registration baseline entry keyed only by exact Git path-byte digest. */
export type InheritedChangeBaselineEntry =
  | InheritedChangeBaselineEntryBase & {
    readonly statusKind: 'tracked'
    readonly head: InheritedGitObjectSlot
    readonly index: InheritedGitObjectSlot
    readonly worktree: InheritedCurrentWorktreeEvidence
  }
  | InheritedChangeBaselineEntryBase & {
    readonly statusKind: 'untracked'
    readonly worktree: InheritedCurrentWorktreeEvidence
  }
  | InheritedChangeBaselineEntryBase & {
    readonly statusKind: 'unmerged'
    readonly head: InheritedGitObjectSlot
    readonly stages: readonly [InheritedGitObjectSlot, InheritedGitObjectSlot, InheritedGitObjectSlot]
    readonly worktree: InheritedCurrentWorktreeEvidence
  }

/** Complete registration baseline, including the valid zero-entry clean result. */
export interface CompleteInheritedChangeBaseline {
  readonly kind: 'complete'
  readonly formatVersion: 1
  readonly capturedAt: number
  readonly bounds: InheritedChangeBaselineBounds
  readonly observed: InheritedChangeBaselineObservedLimits
  readonly entries: readonly InheritedChangeBaselineEntry[]
  readonly digest: string
}

/** Closed bounded reasons why no complete registration baseline is available. */
export type InheritedChangeBaselineUnavailableReason =
  | 'entry-limit'
  | 'path-limit'
  | 'git-output-limit'
  | 'file-limit'
  | 'hash-limit'
  | 'time-limit'
  | 'invalid-utf8'
  | 'duplicate-path'
  | 'unsupported-state'
  | 'unstable-content'
  | 'io-failure'

/** Explicit absence of a complete baseline; no partial entries or complete digest exist. */
export interface UnavailableInheritedChangeBaseline {
  readonly kind: 'unavailable'
  readonly reason: InheritedChangeBaselineUnavailableReason
  readonly observed: InheritedChangeBaselineObservedLimits
}

/** Entire confirmed registration baseline result. */
export type InheritedChangeBaseline =
  | CompleteInheritedChangeBaseline
  | UnavailableInheritedChangeBaseline

/** Display-safe remote observation with credential-bearing URL material removed. */
export interface SafeGitRemoteObservation {
  readonly transport: 'https' | 'ssh' | 'file' | 'other'
  readonly coordinate?: string
}

/** Browser-safe detached project-selection evidence. */
export interface ProjectSelectionProjection {
  readonly observationVersion: 1
  readonly hostId: SakiHostId
  readonly displayLocation: string
  readonly objectFormat: 'sha1' | 'sha256'
  readonly head: string
  readonly branch?: string
  readonly detached: boolean
  readonly upstream?: string
  readonly locked: boolean
  /** Conservatively observed raw-byte inherited changes, not porcelain status rows. */
  readonly inheritedChangeEntryCount: number
  /** Whether configured conversion prevents raw bytes from proving equivalence. */
  readonly conversionAmbiguous: boolean
  readonly remotes: readonly SafeGitRemoteObservation[]
  /** Lowercase canonical public-GitHub repository coordinates derived from safe remotes. */
  readonly githubRepositoryCandidates?: readonly string[]
  readonly workspaceId?: WorkspaceId
  readonly automaticMutationEligible: boolean
  readonly blockingReasons: readonly ('dirty' | 'baseline-unavailable' | 'conversion-ambiguous' | 'locked')[]
  readonly fingerprint: ProjectInspectionFingerprint
  readonly baseline: InheritedChangeBaseline
}

/** Git settings that define raw worktree-to-index comparison semantics. */
export interface RepositoryComparisonObservation {
  readonly fileMode: boolean
  readonly symlinks: boolean
  readonly autocrlf: boolean
}

/** Opaque identity of one Git administrative directory on its owning Host. */
export interface RepositoryAdministrativeIdentity {
  readonly version: 1
  readonly digest: string
}

/** Trusted Host observation retained only in-process and in durable control-plane records. */
export interface TrustedProjectSelectionObservation {
  readonly canonicalWorktreePath: string
  readonly canonicalGitDirectory: string
  readonly canonicalCommonGitDirectory: string
  readonly gitDirectoryIdentity: RepositoryAdministrativeIdentity
  readonly commonGitDirectoryIdentity: RepositoryAdministrativeIdentity
  readonly comparison: RepositoryComparisonObservation
}

/** Successful Host inspection with separated trusted and browser-safe values. */
export interface ProjectSelectionInspection {
  readonly projection: ProjectSelectionProjection
  readonly trusted: TrustedProjectSelectionObservation
}

/** Safe rejection reason for a selection that cannot identify a registerable worktree. */
export type ProjectSelectionRejectionReason =
  | 'missing'
  | 'not-directory'
  | 'not-git'
  | 'bare'
  | 'prunable'
  | 'ambiguous'
  | 'malformed'
  | 'unavailable'

/** Read-only selected-directory inspection result. */
export type InspectProjectSelectionResult =
  | { readonly ok: true; readonly inspection: ProjectSelectionInspection }
  | { readonly ok: false; readonly reason: ProjectSelectionRejectionReason }

/** Selected Host plus an untrusted caller directory locator. */
export interface InspectProjectSelectionRequest {
  readonly hostId: SakiHostId
  readonly directoryLocator: string
}

/** Merge-extensible Host Execution operation map. */
export interface SakiHostExecutionOperationMap {
  readonly 'inspect-project-selection': {
    readonly request: InspectProjectSelectionRequest
    readonly result: InspectProjectSelectionResult
  }
}

/** Request union derived from the Host Execution operation map. */
export type SakiHostExecutionRequest = SakiHostExecutionOperationMap[keyof SakiHostExecutionOperationMap]['request']
/** Result union derived from the Host Execution operation map. */
export type SakiHostExecutionResult = SakiHostExecutionOperationMap[keyof SakiHostExecutionOperationMap]['result']
