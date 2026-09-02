/** Public value types for Saki Host Execution. @module @breakfastdapaidang/saki-execution/types */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { MessageId, TextBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'

export type { MessageId } from '@deepseek-ai/dsh-llm'
export type { SessionId } from '@deepseek-ai/dsh-session'
export type { WorkspaceId } from '@deepseek-ai/dsh-workspace'

/** Stable identity of one enrolled Saki Host. */
export type SakiHostId = Branded<'SakiHostId'>

/** Stable identity of one Host-owned Saki Resource Binding. */
export type SakiResourceBindingId = Branded<'SakiResourceBindingId'>

/** Stable idempotency identity of one Saki Control Intent. */
export type SakiControlIntentId = Branded<'SakiControlIntentId'>

/** Stable identity of one versioned Saki Development Agent Profile. */
export type SakiAgentProfileId = Branded<'SakiAgentProfileId'>

/** Stable identity of one Saki Execution Dispatch. */
export type SakiExecutionDispatchId = Branded<'SakiExecutionDispatchId'>

/** Stable identity of one Saki Agent Run. */
export type SakiAgentRunId = Branded<'SakiAgentRunId'>

/** Stable user-visible identity of one Saki Work Session. */
export type SakiWorkSessionId = Branded<'SakiWorkSessionId'>

/** Stable identity of one durable Host Operation. */
export type HostOperationId = Branded<'HostOperationId'>

/** Observation-scoped identity of one structured Git change row. */
export type ProjectGitChangeId = Branded<'ProjectGitChangeId'>

/** Provider-owned continuation token for one stable bounded Diff observation. */
export type ProjectGitDiffCursor = Branded<'ProjectGitDiffCursor'>

/** Current Git HEAD without representing an unborn branch as a zero object id. */
export type ProjectGitHead =
  | {
    readonly kind: 'commit'
    readonly objectId: string
    /** Full `refs/heads/*` name when HEAD is attached. */
    readonly symbolicRef?: string
  }
  | {
    readonly kind: 'unborn'
    readonly symbolicRef: string
  }

/** Versioned digest of one confirmed project-selection inspection. */
export interface ProjectInspectionFingerprint {
  readonly version: 2
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
  readonly observationVersion: 2
  readonly hostId: SakiHostId
  readonly displayLocation: string
  readonly objectFormat: 'sha1' | 'sha256'
  readonly head: ProjectGitHead
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

/** Revisioned active binding evidence supplied by an authorized Host-side Consumer. */
export interface ActiveHostProjectBinding {
  readonly id: SakiResourceBindingId
  readonly revision: number
  readonly health: 'active'
  readonly hostId: SakiHostId
  readonly workspaceId: WorkspaceId
  /** Accepted registration inspection; the provider must revalidate its trusted resource identity before reading. */
  readonly expectedInspection: ProjectSelectionInspection
  /** Registration-time evidence used only to attribute current changes. */
  readonly inheritedChangeBaseline: InheritedChangeBaseline
}

/** Versioned digest of one complete structured repository-status observation. */
export interface ProjectGitStatusFingerprint {
  readonly version: 1
  readonly digest: string
}

/** Versioned digest of one exact public change row. */
export interface ProjectGitChangeFingerprint {
  readonly version: 1
  readonly digest: string
}

/** Complete worktree digest over ordered rows and private raw-content evidence. */
export interface ProjectGitWorktreeFingerprint {
  readonly version: 1
  readonly digest: string
}

/** File mode retained from porcelain v2, including a missing slot. */
export type ProjectGitFileMode = '000000' | '100644' | '100755' | '120000' | '160000'

/** Exact mode and object-id pair retained from one porcelain v2 slot. */
export interface ProjectGitObjectSlot {
  readonly mode: ProjectGitFileMode
  readonly objectId: string
}

/** Parent-repository Gitlink state; nested tracked and untracked dirtiness is not observed. */
export type ProjectGitSubmoduleStatus =
  | { readonly kind: 'not-submodule' }
  | {
    readonly kind: 'submodule'
    readonly commit: 'changed' | 'unchanged' | 'unknown'
  }

/** Relationship between current exact evidence and the registration baseline. */
export type ProjectGitChangeAttribution = 'inherited' | 'not-inherited' | 'unattributed'

/** Per-row current worktree evidence, including an explicit bounded capture failure. */
export type ProjectGitWorktreeEvidence = InheritedCurrentWorktreeEvidence | {
  readonly kind: 'unavailable'
  readonly reason: InheritedChangeBaselineUnavailableReason
}

interface ProjectGitChangeBase {
  readonly id: ProjectGitChangeId
  readonly path: string
  readonly attribution: ProjectGitChangeAttribution
  readonly fingerprint: ProjectGitChangeFingerprint
}

/** One ordinary changed tracked path with exact index/worktree state. */
export interface ProjectGitOrdinaryChange extends ProjectGitChangeBase {
  readonly kind: 'ordinary'
  readonly indexStatus: 'unchanged' | 'modified' | 'type-changed' | 'added' | 'deleted'
  readonly worktreeStatus: 'unchanged' | 'modified' | 'type-changed' | 'added' | 'deleted'
  readonly submodule: ProjectGitSubmoduleStatus
  readonly head: ProjectGitObjectSlot
  readonly index: ProjectGitObjectSlot
  /** Exact worktree mode reported by porcelain v2; raw filesystem evidence remains separate. */
  readonly worktreeMode: ProjectGitFileMode
  readonly worktreeEvidence: ProjectGitWorktreeEvidence
}

/** One untracked path absent from HEAD and the index. */
export interface ProjectGitUntrackedChange extends ProjectGitChangeBase {
  readonly kind: 'untracked'
  readonly indexStatus: 'absent'
  readonly worktreeStatus: 'untracked'
  readonly submodule: { readonly kind: 'not-submodule' }
  /** Exact current mode, or `unknown` only when current evidence is explicitly unavailable. */
  readonly worktreeMode: '100644' | '100755' | '120000' | 'unknown'
  readonly worktreeEvidence: ProjectGitWorktreeEvidence
}

/** One path whose index retains unmerged stages. */
export interface ProjectGitUnmergedChange extends ProjectGitChangeBase {
  readonly kind: 'unmerged'
  readonly indexStatus: 'unmerged'
  readonly worktreeStatus: 'present' | 'absent'
  readonly conflict:
    | 'both-deleted'
    | 'added-by-us'
    | 'deleted-by-them'
    | 'added-by-them'
    | 'deleted-by-us'
    | 'both-added'
    | 'both-modified'
  readonly submodule: ProjectGitSubmoduleStatus
  readonly stages: {
    readonly base: ProjectGitObjectSlot
    readonly ours: ProjectGitObjectSlot
    readonly theirs: ProjectGitObjectSlot
  }
  /** Exact worktree mode reported by porcelain v2; raw filesystem evidence remains separate. */
  readonly worktreeMode: ProjectGitFileMode
  readonly worktreeEvidence: ProjectGitWorktreeEvidence
}

/** One exact changed repository-relative path without file content or Host paths. */
export type ProjectGitChange =
  | ProjectGitOrdinaryChange
  | ProjectGitUntrackedChange
  | ProjectGitUnmergedChange

/** Attached or detached branch state cross-checked against HEAD. */
export type ProjectGitBranch =
  | { readonly kind: 'attached'; readonly ref: string; readonly name: string }
  | { readonly kind: 'detached' }

/** Configured upstream plus divergence when both commits are available. */
export interface ProjectGitUpstream {
  readonly ref: string
  readonly name: string
  readonly divergence?: { readonly ahead: number; readonly behind: number }
}

/** Complete index evidence usable as a structured mutation precondition. */
export type ProjectGitIndexEvidence =
  | { readonly kind: 'tree'; readonly treeId: string }
  | {
    readonly kind: 'unmerged'
    readonly stagesDigest: { readonly version: 1; readonly digest: string }
  }

/** Stable reasons why the current observation cannot authorize structured Git mutation. */
export type ProjectGitMutationBlocker =
  | 'baseline-unavailable'
  | 'conversion-ambiguous'
  | 'current-unavailable'
  | 'index-flags'
  | 'unmerged'
  | 'locked'

/** Whether the complete observation can serve as a structured mutation precondition. */
export type ProjectGitMutationAvailability =
  | { readonly available: true; readonly blockers: readonly [] }
  | { readonly available: false; readonly blockers: readonly ProjectGitMutationBlocker[] }

/** Complete browser-safe Git status for one exact Resource Binding revision. */
export interface ProjectGitStatusObservation {
  readonly observationVersion: 1
  /** Projection time excluded from status identity and observation-scoped change ids. */
  readonly observedAt: number
  readonly bindingId: SakiResourceBindingId
  readonly bindingRevision: number
  readonly bindingHealth: 'active'
  readonly locked: boolean
  readonly objectFormat: 'sha1' | 'sha256'
  readonly head: ProjectGitHead
  readonly branch: ProjectGitBranch
  readonly upstream?: ProjectGitUpstream
  readonly index: ProjectGitIndexEvidence
  readonly worktree: ProjectGitWorktreeFingerprint
  readonly changes: readonly ProjectGitChange[]
  readonly structuredMutation: ProjectGitMutationAvailability
  readonly fingerprint: ProjectGitStatusFingerprint
}

/** Closed safe reasons why no complete bound project status is available. */
export type InspectProjectFailureReason =
  | 'binding-stale'
  | 'missing'
  | 'malformed'
  | 'limit'
  | 'invalid-path'
  | 'ambiguous'
  | 'unavailable'

/** Read-only status request scoped to one revisioned Host Resource Binding. */
export interface InspectProjectRequest {
  readonly binding: ActiveHostProjectBinding
}

/** Complete structured repository status or one bounded safe failure. */
export type InspectProjectResult =
  | {
    readonly ok: true
    readonly observation: ProjectGitStatusObservation
    /** Fresh baseline captured from the observation's same stable inventory. */
    readonly preEffectBaseline: InheritedChangeBaseline
  }
  | { readonly ok: false; readonly reason: InspectProjectFailureReason }

/** Index side compared by one file-scoped Diff request. */
export type ProjectGitDiffLayer = 'staged' | 'unstaged' | 'conflict'

/** Versioned digest of the complete raw patch behind one or more Diff pages. */
export interface ProjectGitPatchFingerprint {
  readonly version: 1
  readonly digest: string
}

/** One bounded page of LF-terminated unified Diff lines. */
export interface ProjectGitDiffPage {
  readonly pageVersion: 1
  /** Status observation from which the provider resolved the opaque change id. */
  readonly observation: ProjectGitStatusFingerprint
  readonly changeId: ProjectGitChangeId
  readonly layer: ProjectGitDiffLayer
  readonly patchFingerprint: ProjectGitPatchFingerprint
  readonly range: {
    readonly startLine: number
    readonly endLineExclusive: number
    readonly totalLines: number
  }
  /** UTF-8 text lines with their required trailing LF omitted. */
  readonly lines: readonly string[]
  /** UTF-8 bytes in the returned lines, including one omitted LF per line. */
  readonly pageUtf8Bytes: number
  /** UTF-8 bytes in the complete stable patch, including LF separators. */
  readonly totalUtf8Bytes: number
  readonly omittedBeforeLines: number
  readonly omittedAfterLines: number
  readonly truncated: boolean
  readonly nextCursor?: ProjectGitDiffCursor
}

/** Read-only file Diff request scoped to one exact binding and status observation. */
export interface ReadProjectDiffRequest {
  readonly expectedStatus: ProjectGitStatusFingerprint
  readonly changeId: ProjectGitChangeId
  readonly layer: ProjectGitDiffLayer
  readonly cursor?: ProjectGitDiffCursor
}

/** Internal Host-operation envelope that pairs trusted binding evidence with one Diff query. */
export interface ReadProjectDiffOperationRequest {
  readonly binding: ActiveHostProjectBinding
  readonly request: ReadProjectDiffRequest
}

/** Closed browser-safe reasons why one bounded Diff page is unavailable. */
export type ProjectGitDiffFailureReason =
  | 'binding-stale'
  | 'observation-stale'
  | 'change-missing'
  | 'change-ambiguous'
  | 'layer-missing'
  | 'invalid-cursor'
  | 'cursor-stale'
  | 'total-bytes'
  | 'total-lines'
  | 'line-bytes'
  | 'time'
  | 'untracked'
  | 'conflict'
  | 'binary'
  | 'command-length'
  | 'invalid-utf8'
  | 'malformed'
  | 'ambiguous'
  | 'unavailable'

/** One complete bounded Diff page or a closed safe failure. */
export type ReadProjectDiffResult =
  | { readonly ok: true; readonly page: ProjectGitDiffPage }
  | { readonly ok: false; readonly reason: ProjectGitDiffFailureReason }

/** Direct Control Intent that owns one structured Git Host Operation. */
export interface ControlIntentHostOperationSource {
  readonly kind: 'control-intent'
  readonly intentId: SakiControlIntentId
  /** Intent revision that froze the Host request, not its later current lifecycle revision. */
  readonly intentRevision: number
  readonly payloadDigest: string
}

/** Stable Execution Dispatch that owns one Agent-start Host Operation. */
export interface ExecutionDispatchHostOperationSource {
  readonly kind: 'execution-dispatch'
  readonly dispatchId: SakiExecutionDispatchId
  readonly payloadDigest: string
}

/** Immutable product command that owns one Host Operation. */
export type HostOperationSource = ControlIntentHostOperationSource | ExecutionDispatchHostOperationSource

/** Exact complete Git evidence required before one writable Host operation. */
export interface HostGitMutationPrecondition {
  readonly binding: ActiveHostProjectBinding
  readonly status: ProjectGitStatusFingerprint
  readonly head: ProjectGitHead
  readonly index: Extract<ProjectGitIndexEvidence, { readonly kind: 'tree' }>
  readonly worktree: ProjectGitWorktreeFingerprint
  readonly preEffectBaseline: CompleteInheritedChangeBaseline
}

/** One observation-scoped selection without caller-supplied path authority. */
export interface SelectedProjectGitChange {
  readonly id: ProjectGitChangeId
  readonly fingerprint: ProjectGitChangeFingerprint
}

/** Prepare a literal selected-file index mutation. */
export interface StageFilesHostOperationRequest {
  readonly type: 'stage-files'
  readonly source: ControlIntentHostOperationSource
  readonly expected: HostGitMutationPrecondition
  readonly changes: readonly SelectedProjectGitChange[]
}

/** Prepare a literal selected-file reset of the index only. */
export interface UnstageFilesHostOperationRequest {
  readonly type: 'unstage-files'
  readonly source: ControlIntentHostOperationSource
  readonly expected: HostGitMutationPrecondition
  readonly changes: readonly SelectedProjectGitChange[]
}

/** Prepare one hook-free, unsigned deterministic Git Commit. */
export interface CommitHostOperationRequest {
  readonly type: 'commit'
  readonly source: ControlIntentHostOperationSource
  readonly expected: HostGitMutationPrecondition
  readonly message: string
}

/** Provenance of the exact initial input for one Saki Agent Run. */
export interface SakiAgentRunMessageSource {
  readonly kind: 'saki-agent-run'
  readonly dispatchId: SakiExecutionDispatchId
  readonly agentRunId: SakiAgentRunId
  readonly workSessionId: SakiWorkSessionId
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Initial product input frozen by a Saki Execution Dispatch. */
    readonly 'saki-agent-run': SakiAgentRunMessageSource
  }
}

/** Exact bounded text-only UserMessage preallocated for one Agent Run. */
export type StartAgentRunInputMessage = UserMessage & {
  readonly id: MessageId
  readonly role: 'user'
  readonly content: [TextBlock]
  readonly source: SakiAgentRunMessageSource
}

/** Immutable Development Agent Profile values mounted by the target Host. */
export interface StartAgentRunProfile {
  readonly id: SakiAgentProfileId
  readonly version: number
  readonly agentPresetId: string
  readonly modelRoute: {
    readonly provider: string
    readonly model: string
  }
}

/** Prepare one exact Saki Agent Run and its initial durable input. */
export interface StartAgentRunHostOperationRequest {
  readonly type: 'start-agent-run'
  readonly source: ExecutionDispatchHostOperationSource
  readonly expected: HostGitMutationPrecondition
  readonly run: {
    readonly agentRunId: SakiAgentRunId
    readonly workSessionId: SakiWorkSessionId
    readonly sessionId: SessionId
    readonly profile: StartAgentRunProfile
    readonly input: StartAgentRunInputMessage
  }
}

/** One selected row resolved to a repository-relative path by the Host. */
export interface AppliedProjectGitChange extends SelectedProjectGitChange {
  readonly path: string
}

/** Stable evidence of one successful StageFiles publication. */
export interface StageFilesHostOperationResult {
  readonly type: 'stage-files'
  readonly changes: readonly AppliedProjectGitChange[]
  readonly resultingIndex: Extract<ProjectGitIndexEvidence, { readonly kind: 'tree' }>
}

/** Stable evidence of one successful UnstageFiles publication. */
export interface UnstageFilesHostOperationResult {
  readonly type: 'unstage-files'
  readonly changes: readonly AppliedProjectGitChange[]
  readonly resultingIndex: Extract<ProjectGitIndexEvidence, { readonly kind: 'tree' }>
}

/** Parent edge recorded in one deterministic Commit result. */
export type ProjectGitCommitParent =
  | { readonly kind: 'none' }
  | { readonly kind: 'commit'; readonly objectId: string }

/** Safe ref target advanced by one deterministic Commit. */
export type ProjectGitCommitTarget =
  | { readonly kind: 'symbolic-ref'; readonly ref: string }
  | { readonly kind: 'detached-head' }

/** Exact identity and time persisted for deterministic Commit replay. */
export interface ProjectGitCommitSignature {
  readonly name: string
  readonly email: string
  readonly timestamp: number
  readonly timezone: string
  readonly source: 'git-config'
}

/** Stable evidence of one successful deterministic Commit publication. */
export interface CommitHostOperationResult {
  readonly type: 'commit'
  readonly commitId: string
  readonly treeId: string
  readonly parent: ProjectGitCommitParent
  readonly target: ProjectGitCommitTarget
  readonly author: ProjectGitCommitSignature
  readonly committer: ProjectGitCommitSignature
}

/** Stable evidence that one intended Agent Run and its exact initial input exist. */
export interface StartAgentRunHostOperationResult {
  readonly type: 'start-agent-run'
  readonly agentRunId: SakiAgentRunId
  readonly workSessionId: SakiWorkSessionId
  readonly sessionId: SessionId
  readonly inputMessageId: MessageId
}

/** Declaration-merge extensible Host Operation request/result map. */
export interface HostOperationRequestMap {
  readonly 'stage-files': {
    readonly request: StageFilesHostOperationRequest
    readonly result: StageFilesHostOperationResult
  }
  readonly 'unstage-files': {
    readonly request: UnstageFilesHostOperationRequest
    readonly result: UnstageFilesHostOperationResult
  }
  readonly commit: {
    readonly request: CommitHostOperationRequest
    readonly result: CommitHostOperationResult
  }
  readonly 'start-agent-run': {
    readonly request: StartAgentRunHostOperationRequest
    readonly result: StartAgentRunHostOperationResult
  }
}

/** Current Host Operation discriminants. */
export type HostOperationKind = keyof HostOperationRequestMap

/** Host Operation request correlated to one operation kind. */
export type HostOperationRequest<K extends HostOperationKind = HostOperationKind> =
  K extends HostOperationKind ? HostOperationRequestMap[K]['request'] : never

/** Successful Host Operation result correlated to one operation kind. */
export type HostOperationResult<K extends HostOperationKind = HostOperationKind> =
  K extends HostOperationKind ? HostOperationRequestMap[K]['result'] : never

/** Stable provider-routed reference to one Host Operation. */
export interface HostOperationReference<K extends HostOperationKind = HostOperationKind> {
  readonly id: HostOperationId
  readonly hostId: SakiHostId
  readonly type: K
}

/** Versioned digest of one Host Operation's complete immutable request. */
export interface HostOperationRequestFingerprint {
  readonly version: 1
  readonly digest: string
}

/** Durable preparation evidence safe to retain outside the Provider. */
export interface HostOperationPreparation<K extends HostOperationKind = HostOperationKind> {
  readonly operation: HostOperationReference<K>
  readonly preparationRevision: number
  readonly requestFingerprint: HostOperationRequestFingerprint
}

/** Exact current manual-write admission expected by the Host. */
export interface HostOperationAdmissionExpectation<K extends HostOperationKind = HostOperationKind> {
  readonly bindingId: SakiResourceBindingId
  readonly bindingRevision: number
  readonly preparation: HostOperationPreparation<K>
  readonly source: HostOperationRequest<K>['source']
}

/** Current control-plane decision for one effect-boundary admission check. */
export type HostOperationAdmissionDecision =
  | { readonly kind: 'accepted'; readonly admissionRevision: number }
  | {
    readonly kind: 'denied'
    readonly reason: 'not-current' | 'source-canceled' | 'authority-revoked'
  }
  | { readonly kind: 'unavailable' }

/** Same-process callback that rechecks current Binding write admission. */
export type HostOperationAdmissionSource = (
  expectation: HostOperationAdmissionExpectation,
  signal: AbortSignal,
) => Promise<HostOperationAdmissionDecision>

/** Durable cancellation reasons; caller AbortSignal cancellation is not one. */
export type HostOperationCancellationReason = 'source-canceled' | 'authority-revoked'

/** Proven no-effect failure of one prepared Host Operation. */
export interface HostOperationFailure {
  readonly reason:
    | 'binding-stale'
    | 'observation-stale'
    | 'invalid-selection'
    | 'unsupported-state'
}

/** Ambiguous or contradictory effect evidence that requires reconciliation. */
export type HostOperationReconciliationReason = 'effect-unknown' | 'evidence-conflict'

/** Durable evidence of whether a control-plane admission accepted the operation. */
export type HostOperationAdmissionEvidence =
  | { readonly kind: 'not-accepted' }
  | { readonly kind: 'accepted'; readonly revision: number; readonly acceptedAt: number }

interface HostOperationSnapshotBase<K extends HostOperationKind> {
  readonly operation: HostOperationReference<K>
  readonly revision: number
  readonly source: HostOperationRequest<K>['source']
  readonly requestFingerprint: HostOperationRequestFingerprint
  readonly bindingId: SakiResourceBindingId
  readonly bindingRevision: number
  readonly preparedAt: number
  readonly updatedAt: number
}

/** Durable inspectable lifecycle of one Host Operation. */
export type HostOperationSnapshot<K extends HostOperationKind = HostOperationKind> =
  K extends HostOperationKind
    ? HostOperationSnapshotBase<K> & (
      | { readonly state: 'prepared'; readonly admission: { readonly kind: 'not-accepted' } }
      | {
        readonly state: 'accepted'
        readonly admission: Extract<HostOperationAdmissionEvidence, { readonly kind: 'accepted' }>
      }
      | {
        readonly state: 'planning'
        readonly admission: Extract<HostOperationAdmissionEvidence, { readonly kind: 'accepted' }>
        readonly plannedAt: number
      }
      | {
        readonly state: 'publishing'
        readonly admission: Extract<HostOperationAdmissionEvidence, { readonly kind: 'accepted' }>
        readonly plannedAt: number
        readonly effectPlannedAt: number
        readonly publishingAt: number
      }
      | {
        readonly state: 'succeeded'
        readonly admission: Extract<HostOperationAdmissionEvidence, { readonly kind: 'accepted' }>
        readonly completedAt: number
        readonly result: HostOperationResult<K>
      }
      | {
        readonly state: 'failed'
        readonly admission: HostOperationAdmissionEvidence
        readonly completedAt: number
        readonly failure: HostOperationFailure
        readonly effect: 'none'
      }
      | {
        readonly state: 'canceled'
        readonly admission: HostOperationAdmissionEvidence
        readonly completedAt: number
        readonly reason: HostOperationCancellationReason
        readonly effect: 'none'
      }
      | {
        readonly state: 'reconciliation-required'
        readonly admission: Extract<HostOperationAdmissionEvidence, { readonly kind: 'accepted' }>
        readonly observedAt: number
        readonly reason: HostOperationReconciliationReason
      }
    )
    : never

/**
 * Provider-owned same-process capability needed to start one prepared
 * operation. Its nominal private field deliberately prevents structural JSON
 * values from satisfying the type; Providers retain all callable state.
 */
export abstract class HostOperationAcceptance {
  protected constructor() {
    this.#establishNominalIdentity()
  }

  #establishNominalIdentity(): undefined { return undefined }
}

/** Prepare result; only its successful arm carries the non-serializable acceptance. */
export type HostOperationReceipt<K extends HostOperationKind = HostOperationKind> =
  | {
    readonly ok: true
    readonly preparation: HostOperationPreparation<K>
    readonly snapshot: HostOperationSnapshot<K>
    readonly acceptance: HostOperationAcceptance
  }
  | { readonly ok: false; readonly reason: 'source-conflict' | 'unavailable' }

/** Effect-boundary start result including current-admission denial. */
export type HostOperationStartResult<K extends HostOperationKind = HostOperationKind> =
  | { readonly ok: true; readonly snapshot: HostOperationSnapshot<K> }
  | {
    readonly ok: false
    readonly reason:
      | 'acceptance-mismatch'
      | 'not-current'
      | 'source-canceled'
      | 'authority-revoked'
      | 'busy'
      | 'unavailable'
    readonly snapshot: HostOperationSnapshot<K>
  }

/** Post-commit notification for one Host Operation revision, including initial revision zero. */
export interface HostOperationChange {
  readonly operation: HostOperationReference
  readonly revision: number
}

/** Disposer for one contained Host Operation change listener. */
export type HostOperationChangedDisposer = () => void

/** Merge-extensible Host Execution operation map. */
export interface SakiHostExecutionOperationMap {
  readonly 'inspect-project-selection': {
    readonly request: InspectProjectSelectionRequest
    readonly result: InspectProjectSelectionResult
  }
  readonly 'inspect-project': {
    readonly request: InspectProjectRequest
    readonly result: InspectProjectResult
  }
  readonly 'read-project-diff': {
    readonly request: ReadProjectDiffOperationRequest
    readonly result: ReadProjectDiffResult
  }
}

/** Request union derived from the Host Execution operation map. */
export type SakiHostExecutionRequest = SakiHostExecutionOperationMap[keyof SakiHostExecutionOperationMap]['request']
/** Result union derived from the Host Execution operation map. */
export type SakiHostExecutionResult = SakiHostExecutionOperationMap[keyof SakiHostExecutionOperationMap]['result']
