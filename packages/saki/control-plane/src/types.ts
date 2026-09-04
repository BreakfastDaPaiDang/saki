/** Public Saki control-plane value types. @module @breakfastdapaidang/saki-control-plane/types */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {
  GitHubAccountId,
  GitHubAppId,
  GitHubFailure,
  GitHubInstallationId,
  GitHubIssueId,
  GitHubMilestoneId,
  GitHubProjectBoardFingerprint,
  GitHubProjectBoardScanCandidate,
  GitHubProjectBoardScanRequest,
  GitHubProjectFieldId,
  GitHubProjectId,
  GitHubProjectItemId,
  GitHubProjectOptionId,
  GitHubRepositoryDatabaseId,
  GitHubRepositoryId,
} from '@breakfastdapaidang/saki-github'
import type {
  CommitHostOperationResult,
  HostOperationId,
  HostOperationKind,
  HostOperationSnapshot,
  InheritedChangeBaseline,
  InspectProjectResult,
  InspectProjectSelectionResult,
  ProjectGitChangeFingerprint,
  ProjectGitChangeId,
  ProjectGitHead,
  ProjectGitIndexEvidence,
  ProjectGitMutationBlocker,
  ProjectGitStatusFingerprint,
  ProjectGitStatusObservation,
  ProjectGitWorktreeFingerprint,
  ProjectInspectionFingerprint,
  ProjectSelectionProjection,
  ReadProjectDiffRequest,
  ReadProjectDiffResult,
  SessionId,
  SakiAgentProfileId,
  SakiControlIntentId,
  SakiAgentRunId,
  SakiExecutionDispatchId,
  SakiHostId,
  SakiResourceBindingId,
  SakiWorkSessionId,
  SelectedProjectGitChange,
  StageFilesHostOperationResult,
  UnstageFilesHostOperationResult,
} from '@breakfastdapaidang/saki-execution'
import type {
  BranchDeliveryIntent,
  BranchDeliveryIntentResult,
  BranchDeliveryProjection,
} from './branch-delivery.ts'
import type {
  MilestoneDeliveryIntent,
  MilestoneDeliveryIntentResult,
} from './milestone-delivery.ts'
import type { MilestoneViewProjection } from './milestone-view.ts'
import type { SakiGitHubFailureProjection } from './github-failure-projection.ts'

export type {
  SakiAgentRunId,
  SakiAgentProfileId,
  SakiControlIntentId,
  SakiExecutionDispatchId,
  SakiHostId,
  SakiResourceBindingId,
  SakiWorkSessionId,
} from '@breakfastdapaidang/saki-execution'
export type { ProjectGitChangeFingerprint, ProjectGitChangeId, SelectedProjectGitChange }
export type {
  GitHubAccountId,
  GitHubAppId,
  GitHubFailure,
  GitHubInstallationId,
  GitHubIssueId,
  GitHubMilestoneId,
  GitHubProjectBoardFingerprint,
  GitHubProjectBoardScanCandidate,
  GitHubProjectBoardScanRequest,
  GitHubProjectFieldId,
  GitHubProjectId,
  GitHubProjectItemId,
  GitHubProjectOptionId,
  GitHubRepositoryDatabaseId,
  GitHubRepositoryId,
} from '@breakfastdapaidang/saki-github'

/** Stable identity of one Saki Installation. */
export type SakiInstallationId = Branded<'SakiInstallationId'>
/** Historical v2 Installation State Generation identity retained for exact migration input. */
export type SakiInstallationGenerationId = Branded<'SakiInstallationGenerationId'>
/** Stable identity sealed into one physical Saki storage generation. */
export type SakiStorageGenerationId = Branded<'SakiStorageGenerationId'>
/** Provenance identity of the Saki build that created one artifact. */
export type SakiBuildId = Branded<'SakiBuildId'>
/** Stable identity of one security Principal. */
export type SakiPrincipalId = Branded<'SakiPrincipalId'>
/** Stable identity of one authorization Grant. */
export type SakiGrantId = Branded<'SakiGrantId'>
/** Stable identity of the Installation Access aggregate. */
export type SakiInstallationAccessId = Branded<'SakiInstallationAccessId'>
/** Stable identity of one one-time Bootstrap Challenge. */
export type SakiBootstrapChallengeId = Branded<'SakiBootstrapChallengeId'>
/** Stable identity of one server-owned Browser Session. */
export type SakiBrowserSessionId = Branded<'SakiBrowserSessionId'>
/** Stable identity of one Development Project. */
export type SakiDevelopmentProjectId = Branded<'SakiDevelopmentProjectId'>
/** Stable receipt identity retained with one accepted Intent. */
export type SakiIntentReceiptId = Branded<'SakiIntentReceiptId'>
/** Stable identity of one durable request for Host Operator action. */
export type SakiInterventionRequestId = Branded<'SakiInterventionRequestId'>
/** Stable identity of one Work Assignment. */
export type SakiWorkAssignmentId = Branded<'SakiWorkAssignmentId'>
/** Stable identity of one short-lived Execution Dispatch claim. */
export type SakiDispatchClaimId = Branded<'SakiDispatchClaimId'>
/** Stable identity of one GitHub-backed Work Item across Project membership changes. */
export type SakiBoardWorkItemId = Branded<'SakiBoardWorkItemId'>
/** Durable recovery identity scoped to one Development Project and Work Item. */
export type SakiWorkItemRecoveryId = Branded<'SakiWorkItemRecoveryId'>
/** Durable identity fencing one complete GitHub scan attempt. */
export type SakiGitHubScanAttemptId = Branded<'SakiGitHubScanAttemptId'>
/** Deterministic fingerprint of one Work Item's confirmed remote mutation inputs. */
export type SakiBoardRemoteFingerprint = Branded<'SakiBoardRemoteFingerprint'>

/** Why one local launcher credential was issued. */
export type SakiBootstrapChallengePurpose = 'initial-bootstrap' | 'local-reauthentication'

/** Display-safe stable identities for local maintenance and startup diagnostics. */
export interface SakiInstallationIdentity {
  /** Product Installation identity, retained across Host replacement. */
  readonly installationId: SakiInstallationId
  /** Independently enrolled Local Host identity. */
  readonly hostId: SakiHostId
}

/** Trusted transport facts used by the local bootstrap exchange. */
export interface SakiBootstrapTransportContext {
  /** Exact browser Origin header, or absence when the carrier supplied none. */
  readonly origin: string | undefined
}

/** Bootstrap secret submitted only in the exchange request body. */
export interface SakiBootstrapExchangeRequest {
  /** Clear one-time secret from the local launcher handoff. */
  readonly secret: string
}

/** Closed unauthenticated Access state that reveals no Installation facts. */
export type SakiUnauthenticatedAccessProjection =
  | { readonly kind: 'bootstrap-required'; readonly message: 'Local bootstrap is required.' }
  | { readonly kind: 'session-required'; readonly message: 'A local browser session is required.' }
  | { readonly kind: 'unavailable'; readonly message: 'Local access is temporarily unavailable.' }

/** Authenticated Access state derived from the presented HttpOnly cookie. */
export interface SakiAuthenticatedAccessProjection {
  /** Authenticated Access discriminant. */
  readonly kind: 'authenticated'
  /** Display-safe Principal facts. */
  readonly principal: {
    /** Stable authenticated Principal identity. */
    readonly id: SakiPrincipalId
    /** Local display name. */
    readonly displayName: string
  }
  /** Server-clock Browser Session expiry as epoch milliseconds. */
  readonly expiresAt: number
  /** Session-derived request-forgery token for later mutations. */
  readonly requestToken: string
}

/** Access response returned before or after local authentication. */
export type AccessProjection = SakiUnauthenticatedAccessProjection | SakiAuthenticatedAccessProjection

/** Bootstrap exchange result; cookie material is carried out-of-band by the trusted Host adapter. */
export type SakiAccessExchangeResult =
  | { readonly ok: true; readonly access: SakiAuthenticatedAccessProjection }
  | { readonly ok: false; readonly reason: 'unavailable' }

/** Logout result; cookie expiration is carried out-of-band by the trusted Host adapter. */
export type SakiAccessLogoutResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'unavailable' }

/** Protected Host inspection query. */
export interface SakiInspectProjectSelectionQuery {
  readonly type: 'inspect-project-selection'
  readonly hostId: SakiHostId
  readonly directoryLocator: string
}

/** Project-index query. */
export interface SakiProjectIndexQuery {
  /** Query discriminant. */
  readonly type: 'project-index'
}

/** One Project workspace-detail query guarded by the caller's observed registry revision. */
export interface SakiDevelopmentWorkspaceQuery {
  readonly type: 'development-workspace'
  readonly projectId: SakiDevelopmentProjectId
  readonly expectedRegistryRevision: number
}

/** Current structured Git status for one Project at an exact Registry revision. */
export interface SakiProjectChangesQuery {
  readonly type: 'project-changes'
  readonly projectId: SakiDevelopmentProjectId
  readonly expectedRegistryRevision: number
}

/** One opaque file-scoped Diff read at an exact Registry and status observation. */
export interface SakiProjectDiffQuery {
  readonly type: 'project-diff'
  readonly projectId: SakiDevelopmentProjectId
  readonly expectedRegistryRevision: number
  readonly request: ReadProjectDiffRequest
}

/** Project Settings query for one Development Project. */
export interface SakiProjectSettingsQuery {
  readonly type: 'project-settings'
  readonly projectId: SakiDevelopmentProjectId
}

/** Board query for one Development Project with an explicit refresh policy. */
export interface SakiBoardQuery {
  readonly type: 'board'
  readonly projectId: SakiDevelopmentProjectId
  readonly refresh: 'cached' | 'interactive'
}

/** One Work Item's Branch Delivery with an explicit targeted-refresh policy. */
export interface SakiBranchDeliveryQuery {
  readonly type: 'branch-delivery'
  readonly projectId: SakiDevelopmentProjectId
  readonly workItemId: SakiBoardWorkItemId
  readonly refresh: 'cached' | 'interactive'
}

/** Browser-safe Branch Delivery plus the outcome of this query's refresh policy. */
export interface SakiBranchDeliveryProjection {
  readonly type: 'branch-delivery'
  readonly refresh: {
    readonly requested: 'cached' | 'interactive'
    readonly state: 'cached' | 'confirmed' | 'unavailable' | 'immutable'
  }
  readonly branchDelivery: BranchDeliveryProjection
}

/** One Project Milestone with an explicit targeted-refresh policy. */
export interface SakiMilestoneViewQuery {
  readonly type: 'milestone-view'
  readonly projectId: SakiDevelopmentProjectId
  readonly milestoneId: GitHubMilestoneId
  readonly refresh: 'cached' | 'interactive'
}

/** Browser-safe Milestone View plus the outcome of this query's refresh policy. */
export interface SakiMilestoneViewProjection {
  readonly type: 'milestone-view'
  readonly refresh: {
    readonly requested: 'cached' | 'interactive'
    readonly state: 'cached' | 'confirmed' | 'unavailable' | 'immutable'
  }
  readonly milestoneView: MilestoneViewProjection
}

/** Browser-safe Host inspection result with trusted Host paths removed. */
export interface SakiProjectSelectionInspectionProjection {
  readonly type: 'inspect-project-selection'
  readonly result:
    | { readonly ok: true; readonly selection: ProjectSelectionProjection }
    | Extract<InspectProjectSelectionResult, { readonly ok: false }>
}

/** Display-safe current Host choice for project operations. */
export interface SakiHostChoiceProjection {
  readonly id: SakiHostId
  readonly revision: number
  readonly state: 'enrolled'
}

/** One Development Project summary in the Project index. */
export interface SakiDevelopmentProjectSummary {
  readonly id: SakiDevelopmentProjectId
  readonly revision: number
  readonly projectTitle: string
  readonly binding: {
    readonly id: SakiResourceBindingId
    readonly revision: number
    readonly health: 'active' | 'missing' | 'repair-required'
    readonly hostId: SakiHostId
    readonly displayLocation: string
    readonly objectFormat: 'sha1' | 'sha256'
    readonly head: ProjectGitHead
    readonly inheritedChangeEntryCount: number
    readonly baseline: 'complete' | 'unavailable'
    readonly automaticMutationEligible: boolean
    readonly configurationGaps: readonly (
      | 'baseline-unavailable'
      | 'conversion-ambiguous'
      | 'binding-missing'
      | 'binding-repair-required'
    )[]
  }
}

/** Revisioned Project-index Projection. */
export interface SakiProjectIndexProjection {
  readonly type: 'project-index'
  readonly revision: number
  readonly hosts: readonly SakiHostChoiceProjection[]
  readonly projects: readonly SakiDevelopmentProjectSummary[]
}

/** One Development Project plus its current detached Git observation. */
export interface SakiDevelopmentWorkspaceProjection {
  readonly type: 'development-workspace'
  readonly registryRevision: number
  readonly project: SakiDevelopmentProjectSummary
  readonly currentSelection?: ProjectSelectionProjection
  readonly recovery: {
    readonly state: 'ready' | 'blocked'
    readonly reasons: readonly (
      | 'binding-missing'
      | 'binding-repair-required'
      | 'baseline-unavailable'
      | 'conversion-ambiguous'
      | 'dirty'
      | 'locked'
    )[]
  }
}

/** Browser-safe structured Git status from one exact Project and Binding revision. */
export type SakiProjectChangesObservationResult =
  | { readonly ok: true; readonly observation: ProjectGitStatusObservation }
  | Extract<InspectProjectResult, { readonly ok: false }>

/** Browser-safe operation reference without Host routing evidence. */
export interface SakiGitOperationReferenceProjection {
  readonly id: HostOperationId
  readonly type: HostOperationKind
  readonly revision: number
  readonly state: HostOperationSnapshot['state']
}

/** Repository-level reason why a structured mutation is not currently eligible. */
export type SakiGitOperationUnavailableReason =
  | ProjectGitMutationBlocker
  | 'detached-head'
  | 'no-staged-changes'
  | 'status-unavailable'
  | 'action-denied'
  | 'write-admission-busy'
  | 'write-admission-unavailable'

/** Repository-level eligibility; selected rows are validated only when an Intent is submitted. */
export type SakiGitOperationAvailabilityProjection =
  | { readonly available: true; readonly reasons: readonly [] }
  | { readonly available: false; readonly reasons: readonly SakiGitOperationUnavailableReason[] }

type SakiHostOperationKindForIntent<T extends SakiGitOperationIntent['type']> =
  T extends 'create-commit' ? 'commit' : T

/** Intent- and lifecycle-correlated browser-safe Host Operation reference. */
export type SakiGitOperationReferenceProjectionFor<
  T extends SakiGitOperationIntent['type'],
  S extends HostOperationSnapshot['state'],
> = Omit<SakiGitOperationReferenceProjection, 'type' | 'state'> & {
  readonly type: SakiHostOperationKindForIntent<T>
  readonly state: S
}

type SakiCurrentGitOperationProjectionFor<T extends SakiGitOperationIntent['type']> =
  | {
    readonly intentId: SakiControlIntentId
    readonly type: T
    readonly state: 'admission-reserved'
  }
  | {
    readonly intentId: SakiControlIntentId
    readonly type: T
    readonly state: 'host-prepared'
    readonly operation: SakiGitOperationReferenceProjectionFor<T, 'prepared'>
  }
  | {
    readonly intentId: SakiControlIntentId
    readonly type: T
    readonly state: 'accepted'
    readonly operation: SakiGitOperationReferenceProjectionFor<T, 'accepted' | 'planning' | 'publishing'>
  }
  | {
    readonly intentId: SakiControlIntentId
    readonly type: T
    readonly state: 'reconciliation-required'
    readonly operation: SakiGitOperationReferenceProjectionFor<T, 'reconciliation-required'>
  }

/** Current write-owning Intent, if the Binding cannot admit another Saki writer. */
export type SakiCurrentGitOperationProjection =
  | SakiCurrentGitOperationProjectionFor<'stage-files'>
  | SakiCurrentGitOperationProjectionFor<'unstage-files'>
  | SakiCurrentGitOperationProjectionFor<'create-commit'>

/** Structured Git actions and the Binding's current single-writer state. */
export interface SakiGitOperationsProjection {
  readonly stageFiles: SakiGitOperationAvailabilityProjection
  readonly unstageFiles: SakiGitOperationAvailabilityProjection
  readonly createCommit: SakiGitOperationAvailabilityProjection
  readonly current?: SakiCurrentGitOperationProjection
}

/** Browser-safe structured Git status from one exact Project and Binding revision. */
export interface SakiProjectChangesProjection {
  readonly type: 'project-changes'
  readonly registryRevision: number
  readonly projectId: SakiDevelopmentProjectId
  readonly projectRevision: number
  readonly result: SakiProjectChangesObservationResult
  readonly gitOperations: SakiGitOperationsProjection
}

/** Browser-safe bounded Diff result from one exact Project and status observation. */
export interface SakiProjectDiffProjection {
  readonly type: 'project-diff'
  readonly registryRevision: number
  readonly projectId: SakiDevelopmentProjectId
  readonly projectRevision: number
  readonly result: ReadProjectDiffResult
}

/** Status-option identities whose node ids remain authoritative across display-name changes. */
export interface GitHubStatusOptionMapping {
  readonly inbox: GitHubProjectOptionId
  readonly backlog: GitHubProjectOptionId
  readonly ready: GitHubProjectOptionId
  readonly inProgress: GitHubProjectOptionId
  readonly inReview: GitHubProjectOptionId
  readonly done: GitHubProjectOptionId
  readonly canceled: GitHubProjectOptionId
}

/** Complete safe configuration required before GitHub synchronization can activate. */
export interface GitHubSynchronizationConfiguration {
  readonly appId: GitHubAppId
  readonly githubInstallationId: GitHubInstallationId
  readonly accountNodeId: GitHubAccountId
  readonly repositoryNodeId: GitHubRepositoryId
  readonly repositoryDatabaseId: GitHubRepositoryDatabaseId
  readonly projectNodeId: GitHubProjectId
  readonly credentialRef: CredentialRef
  readonly statusFieldNodeId: GitHubProjectFieldId
  readonly statusOptionNodeIds: GitHubStatusOptionMapping
  readonly activePollIntervalMs: number
  readonly backgroundPollIntervalMs: number
  readonly rateLimitReserve: number
}

/** One independently editable GitHub synchronization configuration field. */
export type GitHubSynchronizationConfigurationField = keyof GitHubSynchronizationConfiguration

/** Field-scoped synchronization configuration patch; omitted fields retain their candidate or active value. */
export type GitHubSynchronizationConfigurationPatch = Partial<GitHubSynchronizationConfiguration>

/** Fixed Saki Board status projected from persisted GitHub Status option ids. */
export type SakiBoardStatus =
  | 'inbox'
  | 'backlog'
  | 'ready'
  | 'in-progress'
  | 'in-review'
  | 'done'
  | 'canceled'

/** Attributed mapping defect that prevents a scan from activating configuration. */
export type SakiGitHubMappingIssue =
  | {
    readonly reason: 'status-field-missing'
    readonly statusFieldId: GitHubProjectFieldId
  }
  | {
    readonly reason: 'status-option-missing'
    readonly status: SakiBoardStatus
    readonly statusOptionId: GitHubProjectOptionId
  }
  | {
    readonly reason: 'work-item-status-missing'
    readonly issueId: GitHubIssueId
  }
  | {
    readonly reason: 'work-item-status-unknown'
    readonly issueId: GitHubIssueId
    readonly statusOptionId: GitHubProjectOptionId
  }

/** Safe failure input retained for a complete GitHub scan attempt. */
export type SakiGitHubScanFailure =
  | { readonly kind: 'provider'; readonly failure: GitHubFailure }
  | { readonly kind: 'mapping'; readonly issues: readonly SakiGitHubMappingIssue[] }
  | { readonly kind: 'candidate'; readonly reason: 'target-mismatch' | 'invalid-candidate' }
  | {
    readonly kind: 'capacity'
    readonly resource: 'board-work-items'
    readonly limit: number
    readonly observed: number
  }
  | { readonly kind: 'attempt'; readonly reason: 'expired' }

/** Credential-free browser projection of one complete GitHub scan failure. */
export type SakiGitHubScanFailureProjection =
  | { readonly kind: 'provider'; readonly failure: SakiGitHubFailureProjection }
  | Exclude<SakiGitHubScanFailure, { readonly kind: 'provider' }>

/** One due complete scan returned to the trusted polling Consumer. */
export interface SakiGitHubDueScan {
  readonly projectId: SakiDevelopmentProjectId
  readonly priority: 'interactive' | 'background'
  readonly reason: 'startup' | 'configuration' | 'poll' | 'interactive' | 'retry'
  readonly attemptAt: number
}

/** Fenced provider request durably accepted by the scan coordinator. */
export interface SakiGitHubScanLease {
  readonly attemptId: SakiGitHubScanAttemptId
  readonly projectId: SakiDevelopmentProjectId
  readonly configurationRevision: number
  readonly expiresAt: number
  readonly request: GitHubProjectBoardScanRequest
}

/** Result of beginning one complete scan. */
export type SakiGitHubScanBeginResult =
  | { readonly ok: true; readonly lease: SakiGitHubScanLease }
  | { readonly ok: false; readonly reason: 'not-found' | 'unconfigured' | 'in-flight' }

/** Immediate scan request plus the already-admitted attempt that cannot satisfy it. */
export type SakiGitHubScanRequestFenceResult =
  | {
    readonly state: 'scheduled'
    readonly preexistingAttemptId?: SakiGitHubScanAttemptId | undefined
  }
  | { readonly state: 'not-found' | 'unconfigured' }

/** Result of publishing one complete scan candidate under its durable fence. */
export type SakiGitHubScanPublishResult =
  | { readonly state: 'published'; readonly generation: number; readonly configurationRevision: number }
  | { readonly state: 'activation-failed'; readonly issues: readonly SakiGitHubMappingIssue[] }
  | { readonly state: 'failed'; readonly failure: SakiGitHubScanFailure }
  | { readonly state: 'stale' }

/** Result of waiting for one complete Board scan admitted after the request fence. */
export type SakiGitHubFreshBoardScanResult =
  | SakiGitHubScanPublishResult
  | {
    readonly state: 'unavailable'
    readonly reason:
      | 'not-found'
      | 'unconfigured'
      | 'provider-detached'
      | 'provider-failed'
      | 'consumer-failed'
  }

/** Result of recording a failed complete scan under its durable fence. */
export type SakiGitHubScanFailResult = { readonly state: 'failed' | 'stale' }

/** Trusted complete-scan coordinator; provider calls occur outside durable update callbacks. */
export interface SakiGitHubSynchronizationCoordinator {
  /** Persist or strengthen a future scan request. */
  requestScan(
    projectId: SakiDevelopmentProjectId,
    priority: 'interactive' | 'background',
    reason: 'startup' | 'configuration' | 'poll' | 'interactive' | 'retry',
    attemptAt: number,
    signal: AbortSignal,
  ): Promise<'scheduled' | 'not-found' | 'unconfigured'>
  /** Persist an immediate interactive request and fence out the currently admitted attempt. */
  requestScanAfterCurrent(
    projectId: SakiDevelopmentProjectId,
    signal: AbortSignal,
  ): Promise<SakiGitHubScanRequestFenceResult>
  /** List due scans without claiming them. */
  listDueScans(now: number): readonly SakiGitHubDueScan[]
  /** Durably claim one configuration revision before invoking the provider. */
  beginScan(
    projectId: SakiDevelopmentProjectId,
    priority: 'interactive' | 'background',
    expiresAt: number,
    signal: AbortSignal,
  ): Promise<SakiGitHubScanBeginResult>
  /** Atomically publish one complete candidate or retain the prior Board. */
  publishScan(
    projectId: SakiDevelopmentProjectId,
    attemptId: SakiGitHubScanAttemptId,
    candidate: GitHubProjectBoardScanCandidate,
    signal: AbortSignal,
  ): Promise<SakiGitHubScanPublishResult>
  /** Retain the prior Board while recording one safe current failure. */
  failScan(
    projectId: SakiDevelopmentProjectId,
    attemptId: SakiGitHubScanAttemptId,
    failure: SakiGitHubScanFailure,
    signal: AbortSignal,
  ): Promise<SakiGitHubScanFailResult>
}

/** Current failure of the latest accepted scan attempt. */
export interface SakiGitHubSynchronizationFailureProjection {
  readonly attemptId: SakiGitHubScanAttemptId
  readonly configurationRevision: number
  readonly failedAt: number
  readonly failure: SakiGitHubScanFailureProjection
}

/** Mapping state owned by the current synchronization configuration lifecycle. */
export type SakiGitHubMappingHealthProjection =
  | { readonly state: 'unconfigured' }
  | { readonly state: 'revalidation-required'; readonly configurationRevision: number }
  | {
    readonly state: 'valid'
    readonly configurationRevision: number
    readonly validatedAt: number
  }
  | {
    readonly state: 'repair-required'
    readonly configurationRevision: number
    readonly issues: readonly SakiGitHubMappingIssue[]
  }

/** Provider-neutral summary of safe rate observations retained with a checkpoint. */
export type SakiGitHubRateLimitProjection =
  | { readonly state: 'unobserved' }
  | {
    readonly state: 'available'
    readonly observedAt: number
    readonly minimumRemaining: number
    readonly resetAt: number
  }
  | {
    readonly state: 'limited'
    readonly observedAt: number
    readonly resetAt?: number | undefined
  }

/** Atomic complete-scan checkpoint paired with one confirmed Board generation. */
export interface SakiGitHubSyncCheckpointProjection {
  readonly generation: number
  readonly configurationRevision: number
  readonly attemptId: SakiGitHubScanAttemptId
  readonly installationId: GitHubInstallationId
  readonly repositoryId: GitHubRepositoryId
  readonly projectId: GitHubProjectId
  readonly statusFieldId: GitHubProjectFieldId
  readonly sourceFingerprint: GitHubProjectBoardFingerprint
  readonly observedAt: number
  readonly confirmedAt: number
  readonly rateLimit: SakiGitHubRateLimitProjection
}

/** Freshness of the last complete confirmed Board scan. */
export type SakiBoardFreshnessProjection =
  | { readonly state: 'unavailable' }
  | {
    readonly state: 'fresh' | 'stale'
    readonly confirmedAt: number
    readonly staleAt: number
    readonly ageMs: number
  }

/** Current durable scan scheduling state. */
export type SakiGitHubScanStateProjection =
  | { readonly state: 'idle' }
  | {
    readonly state: 'scheduled'
    readonly priority: 'interactive' | 'background'
    readonly reason: 'startup' | 'configuration' | 'poll' | 'interactive' | 'retry'
    readonly attemptAt: number
  }
  | {
    readonly state: 'in-flight'
    readonly attemptId: SakiGitHubScanAttemptId
    readonly priority: 'interactive' | 'background'
    readonly configurationRevision: number
    readonly startedAt: number
    readonly expiresAt: number
  }

/** One confirmed Work Item derived only from complete GitHub facts. */
export interface SakiBoardWorkItemProjection {
  readonly id: SakiBoardWorkItemId
  readonly title: string
  readonly issueNumber: number
  readonly url: string
  readonly issueState: 'open' | 'closed'
  readonly status: SakiBoardStatus
  /** Last confirmed non-terminal Status, or `null` when no such observation exists. */
  readonly latestNonTerminalStatus: Exclude<SakiBoardStatus, 'done' | 'canceled'> | null
  readonly order: number
  readonly archived: boolean
  readonly notInProject: boolean
  readonly updatedAt: number
  readonly source: {
    readonly kind: 'github-issue'
    readonly repositoryId: GitHubRepositoryId
    readonly issueId: GitHubIssueId
    readonly projectItemId?: GitHubProjectItemId | undefined
    readonly apiOrder?: number | undefined
  }
  readonly remoteFingerprint: SakiBoardRemoteFingerprint
}

/** One complete confirmed Board generation. */
export interface SakiConfirmedBoardProjection {
  readonly generation: number
  readonly configurationRevision: number
  readonly repository: {
    readonly id: GitHubRepositoryId
    readonly nameWithOwner: string
    readonly url: string
  }
  readonly project: {
    readonly id: GitHubProjectId
    readonly title: string
    readonly url: string
  }
  readonly items: readonly SakiBoardWorkItemProjection[]
}

/** Why #27 exposes no effective GitHub mutation even when reads are healthy. */
export type SakiBoardMutationUnavailableReason =
  | 'synchronization-unconfigured'
  | 'configuration-not-activated'
  | 'mapping-revalidation-required'
  | 'mapping-repair-required'
  | 'checkpoint-unavailable'
  | 'provider-unavailable'
  | 'action-denied'

/** Effective create/move availability after mapping, provider, and authority checks. */
export type SakiBoardMutationAvailabilityProjection =
  | { readonly available: true; readonly reasons: readonly [] }
  | { readonly available: false; readonly reasons: readonly SakiBoardMutationUnavailableReason[] }

/** Durable local state layered over the last complete confirmed Board. */
export type SakiBoardMutationOverlayProjection =
  | {
    readonly state: 'optimistic'
    readonly intentId: SakiControlIntentId
    readonly type: 'create-work-item'
    readonly title: string
    readonly targetStatus: 'inbox'
  }
  | {
    readonly state: 'optimistic'
    readonly intentId: SakiControlIntentId
    readonly type: 'move-work-item'
    readonly workItemId: SakiBoardWorkItemId
    readonly targetStatus: SakiBoardStatus
    readonly position?: MoveWorkItemPosition | undefined
  }
  | {
    readonly state: 'targeted-confirmed'
    readonly intentId: SakiControlIntentId
    readonly type: 'create-work-item' | 'move-work-item'
    readonly workItem: SakiBoardWorkItemProjection
    readonly confirmedAt: number
  }
  | {
    readonly state: 'conflict'
    readonly intentId: SakiControlIntentId
    readonly type: 'create-work-item' | 'move-work-item'
    readonly reason: 'expected-revision' | 'stale-remote' | 'mapping-repair-required'
    readonly workItem?: SakiBoardWorkItemProjection | undefined
    readonly confirmedAt?: number | undefined
  }
  | {
    readonly state: 'partial-failure'
    readonly intentId: SakiControlIntentId
    readonly type: 'create-work-item' | 'move-work-item'
    readonly workItemId?: SakiBoardWorkItemId | undefined
    readonly stage: SakiWorkItemMutationStageKind
    readonly recoveryAction: SakiWorkItemRecoveryAction
  }
  | {
    readonly state: 'reconciliation-required'
    readonly intentId: SakiControlIntentId
    readonly type: 'create-work-item' | 'move-work-item'
    readonly workItemId?: SakiBoardWorkItemId | undefined
    readonly stage: SakiWorkItemMutationStageKind
    readonly reason: 'effect-unknown' | 'evidence-conflict' | 'marker-ambiguous'
  }
  | {
    readonly state: 'repair-required'
    readonly workItemId: SakiBoardWorkItemId
    readonly reason: 'external-close' | 'external-reopen'
    readonly action: 'move-with-actor'
    readonly suggestedStatus: SakiBoardStatus
  }

/** Read-only confirmed Board and its synchronization evidence. */
export interface SakiBoardProjection {
  readonly type: 'board'
  readonly projectId: SakiDevelopmentProjectId
  readonly state: 'unconfigured' | 'awaiting-first-checkpoint' | 'confirmed'
  readonly synchronizationRevision: number
  readonly confirmed?: SakiConfirmedBoardProjection | undefined
  readonly checkpoint?: SakiGitHubSyncCheckpointProjection | undefined
  readonly mapping: SakiGitHubMappingHealthProjection
  readonly failure?: SakiGitHubSynchronizationFailureProjection | undefined
  readonly freshness: SakiBoardFreshnessProjection
  readonly scan: SakiGitHubScanStateProjection
  readonly effectiveMutationAvailability: SakiBoardMutationAvailabilityProjection
  readonly mutationOverlays: readonly SakiBoardMutationOverlayProjection[]
}

/** The sole answer shape accepted by the first durable Agent-question slice. */
export interface SakiInterventionRequiredAnswer {
  readonly kind: 'text'
  readonly prompt: string
  readonly maxLength: number
}

/** One inert text response to an Intervention Request. */
export interface SakiInterventionTextAnswer {
  readonly kind: 'text'
  readonly text: string
}

/** Stable browser navigation back to the product object that owns work. */
export type SakiReturnAddress =
  | {
    readonly kind: 'work-item'
    readonly projectId: SakiDevelopmentProjectId
    readonly workItemId: SakiBoardWorkItemId
  }
  | {
    readonly kind: 'work-session'
    readonly projectId: SakiDevelopmentProjectId
    readonly workItemId: SakiBoardWorkItemId
    readonly workSessionId: SakiWorkSessionId
  }
  | {
    readonly kind: 'agent-run'
    readonly projectId: SakiDevelopmentProjectId
    readonly workItemId: SakiBoardWorkItemId
    readonly workSessionId: SakiWorkSessionId
    readonly agentRunId: SakiAgentRunId
  }

/** Browser-safe durable Intervention summary without answer drafts or authority material. */
export interface SakiInterventionRequestProjection {
  readonly id: SakiInterventionRequestId
  readonly revision: number
  readonly kind: 'text-input'
  readonly state: 'open' | 'answered' | 'resolved' | 'reconciliation-required'
  readonly targetPrincipalId: SakiPrincipalId
  readonly requiredAnswer: SakiInterventionRequiredAnswer
  readonly createdAt: number
  readonly updatedAt: number
  readonly returnAddress: Extract<SakiReturnAddress, { readonly kind: 'agent-run' }>
}

/** Presentation group for Principal-scoped work; it is not Work Item Status. */
export type SakiMyWorkGroup =
  | 'ready-to-start'
  | 'active'
  | 'waiting-for-operator'
  | 'recently-finished'

/** At most one currently eligible next action projected for a My Work item. */
export type SakiActionOffer =
  | {
    readonly type: 'give-work-item-to-agent'
    readonly projectId: SakiDevelopmentProjectId
    readonly workItemId: SakiBoardWorkItemId
    readonly expectedProjectRevision: number
    readonly expectedRemoteFingerprint: SakiBoardRemoteFingerprint
    readonly reason: string
  }
  | {
    readonly type: 'answer-intervention'
    readonly interventionId: SakiInterventionRequestId
    readonly expectedInterventionRevision: number
    readonly requiredAnswer: SakiInterventionRequiredAnswer
    readonly reason: string
  }

/** Reasoned eligibility result; only the available arm carries authority-neutral input hints. */
export type SakiActionRecommendation =
  | { readonly available: true; readonly offer: SakiActionOffer }
  | { readonly available: false; readonly reason: string }

/** One Principal-scoped Work card derived from authoritative product records. */
export interface SakiMyWorkItemProjection {
  readonly project: {
    readonly id: SakiDevelopmentProjectId
    readonly title: string
  }
  readonly workItem: {
    readonly id: SakiBoardWorkItemId
    readonly title: string
    readonly issueNumber: number
    readonly status: SakiBoardStatus
    readonly updatedAt: number
  }
  readonly group: SakiMyWorkGroup
  readonly assignment?: {
    readonly id: SakiWorkAssignmentId
    readonly revision: number
    readonly ownerPrincipalId: SakiPrincipalId
    readonly state: 'assigned' | 'active' | 'canceled' | 'reconciliation-required'
  } | undefined
  readonly run?: {
    readonly id: SakiAgentRunId
    readonly revision: number
    readonly state:
      | 'allocated'
      | 'starting'
      | 'running'
      | 'waiting'
      | 'resume-pending'
      | 'canceled'
      | 'reconciliation-required'
  } | undefined
  readonly intervention?: SakiInterventionRequestProjection | undefined
  readonly returnAddress: SakiReturnAddress
  readonly recommendation: SakiActionRecommendation
}

/** Principal-derived cross-Project Work query. */
export interface SakiMyWorkQuery {
  readonly type: 'my-work'
}

/** Complete Principal-scoped My Work read model. */
export interface SakiMyWorkProjection {
  readonly type: 'my-work'
  readonly principalId: SakiPrincipalId
  readonly items: readonly SakiMyWorkItemProjection[]
}

/** One source record requiring the current Principal's attention. */
export interface SakiAttentionItemProjection {
  readonly source:
    | { readonly kind: 'intervention'; readonly id: SakiInterventionRequestId; readonly revision: number }
    | { readonly kind: 'work-assignment'; readonly id: SakiWorkAssignmentId; readonly revision: number }
    | { readonly kind: 'execution-dispatch'; readonly id: SakiExecutionDispatchId; readonly revision: number }
  readonly projectId: SakiDevelopmentProjectId
  readonly targetPrincipalId: SakiPrincipalId
  readonly severity: 'information' | 'warning' | 'action-required'
  readonly openedAt: number
  readonly requiredResponse?: SakiInterventionRequiredAnswer | undefined
  readonly returnAddress: SakiReturnAddress
}

/** Principal-derived Attention query. */
export interface SakiAttentionQuery {
  readonly type: 'attention'
}

/** Rebuildable Attention Inbox read model; no durable inbox revision exists. */
export interface SakiAttentionProjection {
  readonly type: 'attention'
  readonly principalId: SakiPrincipalId
  readonly items: readonly SakiAttentionItemProjection[]
}

interface SakiAgentRunProjectionBase {
  readonly id: SakiAgentRunId
  readonly revision: number
  readonly assignmentId: SakiWorkAssignmentId
  readonly workSessionId: SakiWorkSessionId
  readonly sessionId: SessionId
  readonly source: {
    readonly kind: 'manual-give-to-agent'
    readonly intentId: SakiControlIntentId
    readonly projectId: SakiDevelopmentProjectId
    readonly workItemId: SakiBoardWorkItemId
  }
  readonly profile: {
    readonly id: SakiAgentProfileId
    readonly version: number
    readonly agentPresetId: string
  }
  readonly model: {
    readonly provider: string
    readonly model: string
  }
  readonly createdAt: number
  readonly updatedAt: number
}

type SakiCurrentAgentRunProjection = SakiAgentRunProjectionBase & {
  readonly state: 'allocated' | 'starting' | 'running'
  readonly recovery: { readonly state: 'resumable' }
}

type SakiRecentAgentRunProjection = SakiAgentRunProjectionBase & (
  | {
    readonly state: 'canceled'
    readonly recovery: { readonly state: 'terminal'; readonly reason: 'authority-revoked' }
  }
  | {
    readonly state: 'reconciliation-required'
    readonly recovery: {
      readonly state: 'required'
      readonly reason: 'effect-unknown' | 'evidence-conflict' | 'protocol'
    }
  }
)

/** Browser-safe summary of one current or recent manual Agent Run. */
export type SakiAgentRunProjection = SakiCurrentAgentRunProjection | SakiRecentAgentRunProjection

/** Browser-safe assigned Work Item definition and its current and recent execution state. */
export interface SakiWorkItemDetailProjection {
  readonly type: 'work-item-detail'
  readonly projectId: SakiDevelopmentProjectId
  readonly workItemId: SakiBoardWorkItemId
  readonly definition: {
    readonly title: string
    readonly url: string
    readonly number: number
    readonly status: SakiBoardStatus
    readonly intendedOutcome: string
    readonly acceptanceCriteria: readonly string[]
    readonly blockage: readonly string[]
  }
  readonly assignment: {
    readonly id: SakiWorkAssignmentId
    readonly revision: number
    readonly state: 'assigned' | 'active' | 'canceled' | 'reconciliation-required'
    readonly primaryWorkSessionId: SakiWorkSessionId
    readonly createdAt: number
    readonly updatedAt: number
  }
  readonly primaryWorkSession: {
    readonly id: SakiWorkSessionId
    readonly revision: number
    readonly state: 'open' | 'canceled' | 'reconciliation-required'
    readonly createdAt: number
    readonly updatedAt: number
  }
  readonly currentAgentRun?: SakiCurrentAgentRunProjection | undefined
  readonly recentAgentRuns: readonly SakiRecentAgentRunProjection[]
}

/** Safe Project Settings state for the selected Project's GitHub synchronization. */
export interface SakiProjectSettingsProjection {
  readonly type: 'project-settings'
  readonly projectId: SakiDevelopmentProjectId
  readonly synchronization: {
    readonly revision: number
    readonly state: 'unconfigured' | 'saved' | 'activating' | 'activated' | 'activation-failed'
    readonly active?: {
      readonly revision: number
      readonly configuration: GitHubSynchronizationConfiguration
      readonly activatedAt: number
    }
    readonly pending?: {
      readonly revision: number
      readonly changedFields: readonly GitHubSynchronizationConfigurationField[]
      readonly state: 'saved' | 'activating' | 'activation-failed'
      readonly configuration: GitHubSynchronizationConfiguration
      readonly savedAt: number
    }
    readonly checkpoint?: SakiGitHubSyncCheckpointProjection | undefined
    readonly mapping: SakiGitHubMappingHealthProjection
    readonly failure?: SakiGitHubSynchronizationFailureProjection | undefined
    readonly freshness: SakiBoardFreshnessProjection
    readonly scan: SakiGitHubScanStateProjection
    readonly effectiveMutationAvailability: SakiBoardMutationAvailabilityProjection
  }
}

/** Control-plane Projection query map. */
export interface SakiQueryMap {
  /** Principal-scoped cross-Project Work. */
  readonly 'my-work': {
    readonly request: SakiMyWorkQuery
    readonly projection: SakiMyWorkProjection
    readonly failure: 'denied' | 'unavailable'
  }
  /** Principal-scoped unresolved attention. */
  readonly attention: {
    readonly request: SakiAttentionQuery
    readonly projection: SakiAttentionProjection
    readonly failure: 'denied' | 'unavailable'
  }
  /** Read-only Host project-selection inspection. */
  readonly 'inspect-project-selection': {
    readonly request: SakiInspectProjectSelectionQuery
    readonly projection: SakiProjectSelectionInspectionProjection
    readonly failure: 'denied' | 'unavailable'
  }
  /** Development Project index. */
  readonly 'project-index': {
    readonly request: SakiProjectIndexQuery
    readonly projection: SakiProjectIndexProjection
    readonly failure: 'denied' | 'unavailable'
  }
  /** One Project's Development Workspace. */
  readonly 'development-workspace': {
    readonly request: SakiDevelopmentWorkspaceQuery
    readonly projection: SakiDevelopmentWorkspaceProjection
    readonly failure: 'denied' | 'unavailable' | 'stale' | 'not-found'
  }
  /** One Project's current structured Git status. */
  readonly 'project-changes': {
    readonly request: SakiProjectChangesQuery
    readonly projection: SakiProjectChangesProjection
    readonly failure: 'denied' | 'unavailable' | 'stale' | 'not-found' | 'binding-unavailable'
  }
  /** One bounded file-scoped Project Diff page. */
  readonly 'project-diff': {
    readonly request: SakiProjectDiffQuery
    readonly projection: SakiProjectDiffProjection
    readonly failure: 'denied' | 'unavailable' | 'stale' | 'not-found' | 'binding-unavailable'
  }
  /** One Project's configuration and synchronization activation state. */
  readonly 'project-settings': {
    readonly request: SakiProjectSettingsQuery
    readonly projection: SakiProjectSettingsProjection
    readonly failure: 'denied' | 'unavailable' | 'not-found'
  }
  /** One Project's last complete confirmed Board. */
  readonly board: {
    readonly request: SakiBoardQuery
    readonly projection: SakiBoardProjection
    readonly failure: 'denied' | 'unavailable' | 'not-found'
  }
  /** One Work Item's current Branch Delivery. */
  readonly 'branch-delivery': {
    readonly request: SakiBranchDeliveryQuery
    readonly projection: SakiBranchDeliveryProjection
    readonly failure: 'denied' | 'not-found'
  }
  /** One current Milestone Delivery joined to exact GitHub and Board facts. */
  readonly 'milestone-view': {
    readonly request: SakiMilestoneViewQuery
    readonly projection: SakiMilestoneViewProjection
    readonly failure: 'denied' | 'not-found'
  }
}

/** Query request union derived from {@link SakiQueryMap}. */
export type SakiQuery = SakiQueryMap[keyof SakiQueryMap]['request']

/** Result correlated to one protected Projection query kind. */
export type SakiQueryResult<K extends keyof SakiQueryMap = keyof SakiQueryMap> = K extends keyof SakiQueryMap
  ? | { readonly ok: true; readonly projection: SakiQueryMap[K]['projection'] }
    | { readonly ok: false; readonly reason: SakiQueryMap[K]['failure'] }
  : never

/** First durable Project-registration Control Intent. */
export interface RegisterDevelopmentProjectIntent {
  readonly type: 'register-development-project'
  readonly intentId: SakiControlIntentId
  readonly projectTitle: string
  readonly hostId: SakiHostId
  readonly directoryLocator: string
  readonly expectedRegistryRevision: number
  readonly confirmedFingerprint: ProjectInspectionFingerprint
  readonly confirmedBaseline: InheritedChangeBaseline
}

/** Save one expected-revision, field-scoped GitHub synchronization candidate. */
export interface ConfigureGitHubSynchronizationIntent {
  readonly type: 'configure-github-synchronization'
  readonly intentId: SakiControlIntentId
  readonly projectId: SakiDevelopmentProjectId
  readonly expectedSynchronizationRevision: number
  readonly patch: GitHubSynchronizationConfigurationPatch
}

/** Browser-confirmed repository and Binding evidence for one structured Git mutation. */
export interface GitMutationExpectation {
  readonly projectId: SakiDevelopmentProjectId
  readonly expectedRegistryRevision: number
  readonly expectedProjectRevision: number
  readonly expectedBinding: {
    readonly id: SakiResourceBindingId
    readonly revision: number
  }
  readonly expectedStatus: ProjectGitStatusFingerprint
  readonly expectedHead: ProjectGitHead
  readonly expectedIndex: Extract<ProjectGitIndexEvidence, { readonly kind: 'tree' }>
  readonly expectedWorktree: ProjectGitWorktreeFingerprint
}

/** Stage an exact non-empty set of rows from one complete Changes observation. */
export interface StageFilesIntent {
  readonly type: 'stage-files'
  readonly intentId: SakiControlIntentId
  readonly expected: GitMutationExpectation
  readonly changes: readonly SelectedProjectGitChange[]
}

/** Reset the index side of an exact non-empty set of staged rows. */
export interface UnstageFilesIntent {
  readonly type: 'unstage-files'
  readonly intentId: SakiControlIntentId
  readonly expected: GitMutationExpectation
  readonly changes: readonly SelectedProjectGitChange[]
}

/** Create one deterministic hook-free unsigned Commit from an exact index tree. */
export interface CreateCommitIntent {
  readonly type: 'create-commit'
  readonly intentId: SakiControlIntentId
  readonly expected: GitMutationExpectation
  readonly message: string
}

/** Browser-originated structured Git mutation Intent. */
export type SakiGitOperationIntent = StageFilesIntent | UnstageFilesIntent | CreateCommitIntent

/** Revisions that fence a new Work Item against Project and mapping changes. */
interface CreateWorkItemExpectation {
  readonly projectRevision: number
  readonly synchronizationRevision: number
  readonly mappingRevision: number
}

/** Create one GitHub-backed Work Item through the configured Project mapping. */
export interface CreateWorkItemIntent {
  readonly type: 'create-work-item'
  readonly intentId: SakiControlIntentId
  readonly projectId: SakiDevelopmentProjectId
  readonly expected: CreateWorkItemExpectation
  readonly title: string
  readonly intendedOutcome: string
  readonly acceptanceCriteria: readonly string[]
}

/** API-native predecessor placement expressed only with Saki Work Item identities. */
type MoveWorkItemPosition =
  | { readonly afterWorkItemId: null }
  | {
    readonly afterWorkItemId: SakiBoardWorkItemId
    readonly expectedAfterRemoteFingerprint: SakiBoardRemoteFingerprint
  }

/** Move one confirmed Work Item with an exact remote-state precondition. */
export interface MoveWorkItemIntent {
  readonly type: 'move-work-item'
  readonly intentId: SakiControlIntentId
  readonly projectId: SakiDevelopmentProjectId
  readonly workItemId: SakiBoardWorkItemId
  readonly expectedRemoteFingerprint: SakiBoardRemoteFingerprint
  readonly targetStatus: SakiBoardStatus
  readonly position?: MoveWorkItemPosition | undefined
}

/** Explicit Host-Operator request to start one Work Item's primary Agent Run. */
export interface GiveWorkItemToAgentIntent {
  readonly type: 'give-work-item-to-agent'
  readonly intentId: SakiControlIntentId
  readonly projectId: SakiDevelopmentProjectId
  readonly workItemId: SakiBoardWorkItemId
  readonly expectedProjectRevision: number
  readonly expectedRemoteFingerprint: SakiBoardRemoteFingerprint
}

/** First authorized expected-revision answer to one open Intervention Request. */
export interface AnswerInterventionIntent {
  readonly type: 'answer-intervention'
  readonly intentId: SakiControlIntentId
  readonly interventionId: SakiInterventionRequestId
  readonly expectedInterventionRevision: number
  readonly answer: SakiInterventionTextAnswer
}

/** Browser-originated create or move Work Item Intent. */
type SakiWorkItemIntent = CreateWorkItemIntent | MoveWorkItemIntent

/** Control-plane Intent request map. */
export interface SakiIntentMap {
  readonly 'register-development-project': RegisterDevelopmentProjectIntent
  readonly 'configure-github-synchronization': ConfigureGitHubSynchronizationIntent
  readonly 'stage-files': StageFilesIntent
  readonly 'unstage-files': UnstageFilesIntent
  readonly 'create-commit': CreateCommitIntent
  readonly 'create-work-item': CreateWorkItemIntent
  readonly 'move-work-item': MoveWorkItemIntent
  readonly 'save-branch-delivery': Extract<BranchDeliveryIntent, { readonly type: 'save-branch-delivery' }>
  readonly 'push-branch-delivery': Extract<BranchDeliveryIntent, { readonly type: 'push-branch-delivery' }>
  readonly 'create-branch-delivery-pull-request': Extract<
    BranchDeliveryIntent,
    { readonly type: 'create-branch-delivery-pull-request' }
  >
  readonly 'associate-branch-delivery-pull-request': Extract<
    BranchDeliveryIntent,
    { readonly type: 'associate-branch-delivery-pull-request' }
  >
  readonly 'mark-branch-delivery-in-review': Extract<
    BranchDeliveryIntent,
    { readonly type: 'mark-branch-delivery-in-review' }
  >
  readonly 'accept-branch-delivery': Extract<BranchDeliveryIntent, { readonly type: 'accept-branch-delivery' }>
  readonly 'save-milestone-delivery': Extract<
    MilestoneDeliveryIntent,
    { readonly type: 'save-milestone-delivery' }
  >
  readonly 'finalize-milestone-delivery': Extract<
    MilestoneDeliveryIntent,
    { readonly type: 'finalize-milestone-delivery' }
  >
  readonly 'give-work-item-to-agent': GiveWorkItemToAgentIntent
  readonly 'answer-intervention': AnswerInterventionIntent
}

/** Control Intent union derived from the request map. */
export type SakiIntent = SakiIntentMap[keyof SakiIntentMap]

/** Control-plane submission union derived from the declared Intent kinds. */
export type SakiIntentInput = SakiIntent

interface SakiRegistrationReceiptBase {
  readonly id: SakiIntentReceiptId
  readonly intentId: SakiControlIntentId
}

/** Durable receipt for one accepted registration Intent. */
export type SakiRegistrationReceipt =
  | (SakiRegistrationReceiptBase & { readonly state: 'prepared' })
  | (SakiRegistrationReceiptBase & {
    readonly state: 'confirmed'
    readonly projectId: SakiDevelopmentProjectId
    readonly resourceBindingId: SakiResourceBindingId
    readonly registryRevision: number
  })
  | (SakiRegistrationReceiptBase & {
    readonly state: 'conflict'
    readonly reason: 'expected-revision' | 'duplicate-binding'
  })
  | (SakiRegistrationReceiptBase & {
    readonly state: 'failure'
    readonly reason: 'authority'
  })
  | (SakiRegistrationReceiptBase & {
    readonly state: 'reconciliation-required'
    readonly reason: 'workspace' | 'observation'
  })

interface SakiGitHubSynchronizationReceiptBase {
  readonly id: SakiIntentReceiptId
  readonly intentId: SakiControlIntentId
}

/** Durable receipt for one GitHub synchronization configuration Intent. */
export type SakiGitHubSynchronizationReceipt =
  | (SakiGitHubSynchronizationReceiptBase & { readonly state: 'prepared' })
  | (SakiGitHubSynchronizationReceiptBase & {
    readonly state: 'saved'
    readonly projectId: SakiDevelopmentProjectId
    readonly synchronizationRevision: number
    readonly candidateRevision: number
  })
  | (SakiGitHubSynchronizationReceiptBase & {
    readonly state: 'conflict'
    readonly reason:
      | 'expected-revision'
      | 'project-not-found'
      | 'configuration-incomplete'
      | 'configuration-unchanged'
  })
  | (SakiGitHubSynchronizationReceiptBase & {
    readonly state: 'failure'
    readonly reason: 'authority'
  })

/** Safe control-plane lifecycle for one structured Git mutation. */
export type SakiGitOperationReceiptState =
  | 'prepared'
  | 'admission-reserved'
  | 'host-prepared'
  | 'accepted'
  | 'succeeded'
  | 'conflict'
  | 'failed'
  | 'canceled'
  | 'reconciliation-required'

/** Safe terminal reason without Host routing, authority, or admission evidence. */
export type SakiGitOperationTerminalReason =
  | 'expected-evidence'
  | 'invalid-selection'
  | 'source-conflict'
  | 'authority-revoked'
  | 'binding-stale'
  | 'observation-stale'
  | 'unsupported-state'
  | 'source-canceled'
  | 'effect-unknown'
  | 'evidence-conflict'
  | 'protocol'

interface SakiGitOperationReceiptBase<T extends SakiGitOperationIntent['type']> {
  readonly id: SakiIntentReceiptId
  readonly intentId: SakiControlIntentId
  readonly type: T
  readonly projectId: SakiDevelopmentProjectId
}

interface SakiGitOperationResultMap {
  readonly 'stage-files': StageFilesHostOperationResult
  readonly 'unstage-files': UnstageFilesHostOperationResult
  readonly 'create-commit': CommitHostOperationResult
}

type SakiGitOperationReceiptFor<T extends SakiGitOperationIntent['type']> =
  | (SakiGitOperationReceiptBase<T> & { readonly state: 'prepared' | 'admission-reserved' })
  | (SakiGitOperationReceiptBase<T> & {
    readonly state: 'host-prepared'
    readonly operation: SakiGitOperationReferenceProjectionFor<T, 'prepared'>
  })
  | (SakiGitOperationReceiptBase<T> & {
    readonly state: 'accepted'
    readonly operation: SakiGitOperationReferenceProjectionFor<T, 'accepted' | 'planning' | 'publishing'>
  })
  | (SakiGitOperationReceiptBase<T> & {
    readonly state: 'succeeded'
    readonly operation: SakiGitOperationReferenceProjectionFor<T, 'succeeded'>
    readonly result: SakiGitOperationResultMap[T]
  })
  | (SakiGitOperationReceiptBase<T> & {
    readonly state: 'conflict'
    readonly reason: 'expected-evidence' | 'invalid-selection' | 'source-conflict' | 'protocol'
    readonly operation?: SakiGitOperationReferenceProjectionFor<T, 'prepared'>
  })
  | (SakiGitOperationReceiptBase<T> & {
    readonly state: 'failed'
    readonly reason: Exclude<SakiGitOperationTerminalReason,
      | 'expected-evidence'
      | 'source-conflict'
      | 'protocol'
      | 'source-canceled'
      | 'authority-revoked'
      | 'effect-unknown'
      | 'evidence-conflict'>
    readonly operation: SakiGitOperationReferenceProjectionFor<T, 'failed'>
  })
  | (SakiGitOperationReceiptBase<T> & {
    readonly state: 'canceled'
    readonly reason: 'source-canceled' | 'authority-revoked'
    readonly operation?: SakiGitOperationReferenceProjectionFor<T, 'canceled'>
  })
  | (SakiGitOperationReceiptBase<T> & {
    readonly state: 'reconciliation-required'
    readonly reason: 'effect-unknown' | 'evidence-conflict'
    readonly operation: SakiGitOperationReferenceProjectionFor<T, 'reconciliation-required'>
  })

interface SakiGitOperationReceiptMap {
  readonly 'stage-files': SakiGitOperationReceiptFor<'stage-files'>
  readonly 'unstage-files': SakiGitOperationReceiptFor<'unstage-files'>
  readonly 'create-commit': SakiGitOperationReceiptFor<'create-commit'>
}

/** Browser-safe durable receipt for StageFiles, UnstageFiles, or CreateCommit. */
export type SakiGitOperationReceipt<
  T extends SakiGitOperationIntent['type'] = SakiGitOperationIntent['type'],
> = SakiGitOperationReceiptMap[T]

/** Submit result shared by the three structured Git mutation Intents. */
export type SakiGitOperationIntentReceipt<T extends SakiGitOperationIntent['type']> =
  | {
    readonly ok: true
    readonly receipt: Extract<SakiGitOperationReceipt<T>, { readonly state: 'succeeded' }>
  }
  | { readonly ok: false; readonly reason: 'denied'; readonly receipt?: never }
  | {
    readonly ok: false
    readonly reason: 'unavailable'
    readonly receipt?: Extract<SakiGitOperationReceipt<T>, {
      readonly state: 'prepared' | 'admission-reserved' | 'host-prepared' | 'accepted'
    }>
  }
  | {
    readonly ok: false
    readonly reason: 'conflict'
    readonly receipt?: Extract<SakiGitOperationReceipt<T>, { readonly state: 'conflict' }>
  }
  | {
    readonly ok: false
    readonly reason: 'failure'
    readonly receipt: Extract<SakiGitOperationReceipt<T>, { readonly state: 'failed' }>
  }
  | {
    readonly ok: false
    readonly reason: 'canceled'
    readonly receipt: Extract<SakiGitOperationReceipt<T>, { readonly state: 'canceled' }>
  }
  | {
    readonly ok: false
    readonly reason: 'reconciliation-required'
    readonly receipt: Extract<SakiGitOperationReceipt<T>, { readonly state: 'reconciliation-required' }>
  }

/** Provider-neutral atomic stage names safe to expose in Work Item recovery. */
export type SakiWorkItemMutationStageKind =
  | 'issue-create'
  | 'project-item-add'
  | 'project-item-status-set'
  | 'project-item-position-set'
  | 'issue-state-set'

/** Browser-safe next action for a partially completed Work Item saga. */
export type SakiWorkItemRecoveryAction =
  | { readonly kind: 'inspect-before-retry' }
  | { readonly kind: 'resume-intent' }
  | { readonly kind: 'repair-mapping'; readonly reason: string }

interface SakiWorkItemReceiptBase<T extends SakiWorkItemIntent['type']> {
  readonly id: SakiIntentReceiptId
  readonly intentId: SakiControlIntentId
  readonly type: T
  readonly projectId: SakiDevelopmentProjectId
}

/** Durable browser-safe lifecycle of one create or move Work Item saga. */
export type SakiWorkItemReceipt<T extends SakiWorkItemIntent['type'] = SakiWorkItemIntent['type']> =
  | (SakiWorkItemReceiptBase<T> & {
    readonly state: 'prepared' | 'running'
    readonly workItemId?: SakiBoardWorkItemId | undefined
  })
  | (SakiWorkItemReceiptBase<T> & {
    readonly state: 'partial-failure'
    readonly workItemId?: SakiBoardWorkItemId | undefined
    readonly stage: SakiWorkItemMutationStageKind
    readonly recoveryAction: SakiWorkItemRecoveryAction
  })
  | (SakiWorkItemReceiptBase<T> & {
    readonly state: 'succeeded'
    readonly workItemId: SakiBoardWorkItemId
    readonly issueNumber: number
    readonly url: string
    readonly remoteFingerprint: SakiBoardRemoteFingerprint
  })
  | (SakiWorkItemReceiptBase<T> & {
    readonly state: 'conflict'
    readonly reason: 'expected-revision' | 'stale-remote' | 'mapping-repair-required'
    readonly workItemId?: SakiBoardWorkItemId | undefined
    readonly remoteFingerprint?: SakiBoardRemoteFingerprint | undefined
  })
  | (SakiWorkItemReceiptBase<T> & {
    readonly state: 'reconciliation-required'
    readonly reason: 'effect-unknown' | 'evidence-conflict' | 'marker-ambiguous'
    readonly workItemId?: SakiBoardWorkItemId | undefined
    readonly stage: SakiWorkItemMutationStageKind
  })
  | (SakiWorkItemReceiptBase<T> & {
    readonly state: 'canceled'
    readonly reason: 'authority-revoked'
    readonly workItemId?: SakiBoardWorkItemId | undefined
  })

/** Submit result shared by Work Item creation and movement. */
export type SakiWorkItemIntentReceipt<T extends SakiWorkItemIntent['type']> =
  | {
    readonly ok: true
    readonly receipt: Extract<SakiWorkItemReceipt<T>, { readonly state: 'succeeded' }>
  }
  | { readonly ok: false; readonly reason: 'denied'; readonly receipt?: never }
  | {
    readonly ok: false
    readonly reason: 'unavailable'
    readonly receipt?: Extract<SakiWorkItemReceipt<T>, {
      readonly state: 'prepared' | 'running' | 'partial-failure'
    }> | undefined
  }
  | {
    readonly ok: false
    readonly reason: 'conflict'
    readonly receipt?: Extract<SakiWorkItemReceipt<T>, { readonly state: 'conflict' }> | undefined
  }
  | {
    readonly ok: false
    readonly reason: 'reconciliation-required'
    readonly receipt: Extract<SakiWorkItemReceipt<T>, { readonly state: 'reconciliation-required' }>
  }
  | {
    readonly ok: false
    readonly reason: 'canceled'
    readonly receipt: Extract<SakiWorkItemReceipt<T>, { readonly state: 'canceled' }>
  }

interface SakiGiveWorkItemToAgentReceiptBase {
  readonly id: SakiIntentReceiptId
  readonly intentId: SakiControlIntentId
  readonly type: 'give-work-item-to-agent'
  readonly projectId: SakiDevelopmentProjectId
  readonly workItemId: SakiBoardWorkItemId
  readonly assignmentId: SakiWorkAssignmentId
  readonly workSessionId: SakiWorkSessionId
  readonly agentRunId: SakiAgentRunId
  readonly dispatchId: SakiExecutionDispatchId
}

/** Durable browser-safe lifecycle for one manual Agent assignment. */
export type SakiGiveWorkItemToAgentReceipt =
  | (SakiGiveWorkItemToAgentReceiptBase & {
    readonly state: 'prepared' | 'admission-reserved' | 'dispatching'
  })
  | (SakiGiveWorkItemToAgentReceiptBase & { readonly state: 'started' })
  | (SakiGiveWorkItemToAgentReceiptBase & {
    readonly state: 'conflict'
    readonly reason:
      | 'expected-revision'
      | 'stale-remote'
      | 'work-item-not-ready'
      | 'work-item-blocked'
      | 'acceptance-criteria-missing'
      | 'binding-unavailable'
      | 'inherited-changes-unsafe'
      | 'writable-run-active'
      | 'branch-protected'
      | 'legacy-protection-unknown'
  })
  | (SakiGiveWorkItemToAgentReceiptBase & {
    readonly state: 'canceled'
    readonly reason: 'authority-revoked'
  })
  | (SakiGiveWorkItemToAgentReceiptBase & {
    readonly state: 'reconciliation-required'
    readonly reason: 'effect-unknown' | 'evidence-conflict' | 'protocol'
  })

/** Stable result of submitting one manual Agent assignment Intent. */
export type SakiGiveWorkItemToAgentIntentReceipt =
  | {
    readonly ok: true
    readonly receipt: Extract<SakiGiveWorkItemToAgentReceipt, { readonly state: 'started' }>
  }
  | { readonly ok: false; readonly reason: 'denied'; readonly receipt?: never }
  | {
    readonly ok: false
    readonly reason: 'unavailable'
    readonly detail?: (
      | 'work-item-detail-unavailable'
      | 'branch-safety-unavailable'
      | 'agent-profile-unavailable'
      | 'model-route-unavailable'
      | 'host-unavailable') | undefined
    readonly receipt?: Extract<SakiGiveWorkItemToAgentReceipt, {
      readonly state: 'prepared' | 'admission-reserved' | 'dispatching'
    }> | undefined
  }
  | {
    readonly ok: false
    readonly reason: 'conflict'
    readonly receipt?: Extract<SakiGiveWorkItemToAgentReceipt, { readonly state: 'conflict' }> | undefined
  }
  | {
    readonly ok: false
    readonly reason: 'canceled'
    readonly receipt: Extract<SakiGiveWorkItemToAgentReceipt, { readonly state: 'canceled' }>
  }
  | {
    readonly ok: false
    readonly reason: 'reconciliation-required'
    readonly receipt: Extract<SakiGiveWorkItemToAgentReceipt, { readonly state: 'reconciliation-required' }>
  }

interface SakiAnswerInterventionReceiptBase {
  readonly id: SakiIntentReceiptId
  readonly intentId: SakiControlIntentId
  readonly type: 'answer-intervention'
  readonly interventionId: SakiInterventionRequestId
  readonly interventionRevision: number
}

/** Browser-safe durable result of one Intervention answer attempt. */
export type SakiAnswerInterventionReceipt =
  | (SakiAnswerInterventionReceiptBase & {
    readonly state: 'answered'
    readonly dispatchId: SakiExecutionDispatchId
  })
  | (SakiAnswerInterventionReceiptBase & {
    readonly state: 'resolved'
    readonly dispatchId: SakiExecutionDispatchId
  })
  | (SakiAnswerInterventionReceiptBase & {
    readonly state: 'conflict'
    readonly reason: 'expected-revision' | 'already-answered' | 'invalid-answer' | 'owner-unavailable'
  })
  | (SakiAnswerInterventionReceiptBase & {
    readonly state: 'reconciliation-required'
    readonly reason: 'effect-unknown' | 'evidence-conflict' | 'protocol'
    readonly dispatchId?: SakiExecutionDispatchId | undefined
  })

/** Stable result of submitting an Intervention answer Control Intent. */
export type SakiAnswerInterventionIntentReceipt =
  | {
    readonly ok: true
    readonly receipt: Extract<SakiAnswerInterventionReceipt, { readonly state: 'answered' | 'resolved' }>
  }
  | { readonly ok: false; readonly reason: 'denied'; readonly receipt?: never }
  | {
    readonly ok: false
    readonly reason: 'unavailable'
    readonly receipt?: Extract<SakiAnswerInterventionReceipt, { readonly state: 'answered' }> | undefined
  }
  | {
    readonly ok: false
    readonly reason: 'conflict'
    readonly receipt?: Extract<SakiAnswerInterventionReceipt, { readonly state: 'conflict' }> | undefined
  }
  | {
    readonly ok: false
    readonly reason: 'reconciliation-required'
    readonly receipt: Extract<SakiAnswerInterventionReceipt, { readonly state: 'reconciliation-required' }>
  }

/** Intent-correlated receipt result map. */
export interface SakiIntentReceiptMap {
  readonly 'register-development-project':
    | { readonly ok: true; readonly receipt: Extract<SakiRegistrationReceipt, { readonly state: 'confirmed' }> }
    | { readonly ok: false; readonly reason: 'denied'; readonly receipt?: never }
    | {
      readonly ok: false
      readonly reason: 'unavailable'
      readonly receipt?: Extract<SakiRegistrationReceipt, { readonly state: 'prepared' }>
    }
    | {
      readonly ok: false
      readonly reason: 'conflict'
      readonly receipt?: Extract<SakiRegistrationReceipt, { readonly state: 'conflict' }>
    }
    | {
      readonly ok: false
      readonly reason: 'failure'
      readonly receipt: Extract<SakiRegistrationReceipt, { readonly state: 'failure' }>
    }
    | {
      readonly ok: false
      readonly reason: 'reconciliation-required'
      readonly receipt: Extract<SakiRegistrationReceipt, { readonly state: 'reconciliation-required' }>
    }
  readonly 'configure-github-synchronization':
    | { readonly ok: true; readonly receipt: Extract<SakiGitHubSynchronizationReceipt, { readonly state: 'saved' }> }
    | { readonly ok: false; readonly reason: 'denied'; readonly receipt?: never }
    | {
      readonly ok: false
      readonly reason: 'unavailable'
      readonly receipt?: Extract<SakiGitHubSynchronizationReceipt, { readonly state: 'prepared' }>
    }
    | {
      readonly ok: false
      readonly reason: 'conflict'
      readonly receipt?: Extract<SakiGitHubSynchronizationReceipt, { readonly state: 'conflict' }>
    }
    | {
      readonly ok: false
      readonly reason: 'failure'
      readonly receipt: Extract<SakiGitHubSynchronizationReceipt, { readonly state: 'failure' }>
    }
  readonly 'stage-files': SakiGitOperationIntentReceipt<'stage-files'>
  readonly 'unstage-files': SakiGitOperationIntentReceipt<'unstage-files'>
  readonly 'create-commit': SakiGitOperationIntentReceipt<'create-commit'>
  readonly 'create-work-item': SakiWorkItemIntentReceipt<'create-work-item'>
  readonly 'move-work-item': SakiWorkItemIntentReceipt<'move-work-item'>
  readonly 'save-branch-delivery': BranchDeliveryIntentResult
  readonly 'push-branch-delivery': BranchDeliveryIntentResult
  readonly 'create-branch-delivery-pull-request': BranchDeliveryIntentResult
  readonly 'associate-branch-delivery-pull-request': BranchDeliveryIntentResult
  readonly 'mark-branch-delivery-in-review': BranchDeliveryIntentResult
  readonly 'accept-branch-delivery': BranchDeliveryIntentResult
  readonly 'save-milestone-delivery': MilestoneDeliveryIntentResult
  readonly 'finalize-milestone-delivery': MilestoneDeliveryIntentResult
  readonly 'give-work-item-to-agent': SakiGiveWorkItemToAgentIntentReceipt
  readonly 'answer-intervention': SakiAnswerInterventionIntentReceipt
}

/** Stable terminal or recoverable result of submitting a Control Intent. */
export type SakiIntentReceipt<K extends keyof SakiIntentReceiptMap = keyof SakiIntentReceiptMap> =
  SakiIntentReceiptMap[K]

/** Projection key invalidated after a committed access or authority change. */
export type SakiProjectionKey =
  | 'access'
  | 'my-work'
  | 'attention'
  | 'project-index'
  | 'development-workspace'
  | 'project-changes'
  | 'project-settings'
  | 'board'
  | 'branch-delivery'
  | 'milestone-view'

/** Disposer for a contained post-commit Projection invalidation listener. */
export type SakiChangedDisposer = () => void
