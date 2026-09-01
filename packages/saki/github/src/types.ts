/** Provider-neutral GitHub capability values for Saki. Types only. @module @breakfastdapaidang/saki-github/types */

import type { CredentialRef } from '@deepseek-ai/dsh-credentials/types'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Canonical positive-decimal GitHub App identity. */
export type GitHubAppId = Branded<'GitHubAppId'>
/** Opaque GitHub App installation identity. */
export type GitHubInstallationId = Branded<'GitHubInstallationId'>
/** Opaque GitHub user or organization node identity. */
export type GitHubAccountId = Branded<'GitHubAccountId'>
/** Opaque GitHub Repository node identity. */
export type GitHubRepositoryId = Branded<'GitHubRepositoryId'>
/** Canonical positive-decimal GitHub Repository database identity. */
export type GitHubRepositoryDatabaseId = Branded<'GitHubRepositoryDatabaseId'>
/** Opaque GitHub Project v2 node identity. */
export type GitHubProjectId = Branded<'GitHubProjectId'>
/** Opaque GitHub Project v2 field node identity. */
export type GitHubProjectFieldId = Branded<'GitHubProjectFieldId'>
/** Opaque GitHub Project v2 single-select option identity. */
export type GitHubProjectOptionId = Branded<'GitHubProjectOptionId'>
/** Opaque GitHub Project v2 item node identity. */
export type GitHubProjectItemId = Branded<'GitHubProjectItemId'>
/** Opaque GitHub Issue node identity. */
export type GitHubIssueId = Branded<'GitHubIssueId'>
/** Persisted high-entropy identity embedded in one Saki Work Item Issue body. */
export type GitHubIssueCreateMarkerId = Branded<'GitHubIssueCreateMarkerId'>
/** Opaque GitHub pull-request node identity retained as raw item content. */
export type GitHubPullRequestId = Branded<'GitHubPullRequestId'>
/** Opaque annotated-tag object identity. */
export type GitHubTagObjectId = Branded<'GitHubTagObjectId'>
/** Opaque GitHub Release node identity. */
export type GitHubReleaseId = Branded<'GitHubReleaseId'>
/** Exact Git commit object identity. */
export type GitHubCommitId = Branded<'GitHubCommitId'>
/** Exact Saki release-tag name without the `refs/tags/` prefix. */
export type GitHubReleaseTagName = Branded<'GitHubReleaseTagName'>
/** Provider-neutral identity assigned before a GitHub mutation begins. */
export type GitHubExternalOperationId = Branded<'GitHubExternalOperationId'>

/** Caller-selected installation credentials and expected target account. */
export interface GitHubInstallationProfile {
  /** Canonical positive-decimal GitHub App id. */
  readonly appId: GitHubAppId
  /** Installation used to obtain a short-lived token. */
  readonly installationId: GitHubInstallationId
  /** Account the installation must target. */
  readonly accountId: GitHubAccountId
  /** Credential reference containing the GitHub App private key. */
  readonly privateKeyRef: CredentialRef
}

/** One granted GitHub permission, kept in platform vocabulary. */
export interface GitHubPermissionFact {
  /** GitHub permission name. */
  readonly name: string
  /** Granted access level. */
  readonly access: 'read' | 'write' | 'admin'
}

/** Safe installation, account, permission, and token-lifetime facts. */
export interface GitHubInstallationFact {
  /** Observed installation identity. */
  readonly installationId: GitHubInstallationId
  /** Account GitHub reports for the installation. */
  readonly account: {
    readonly id: GitHubAccountId
    readonly login: string
    readonly type: 'organization' | 'user'
  }
  /** Whether the installation reaches every repository or a selected set. */
  readonly repositorySelection: 'all' | 'selected'
  /** Platform permission grants separated by GitHub scope. */
  readonly permissions: {
    readonly repository: readonly GitHubPermissionFact[]
    readonly organization: readonly GitHubPermissionFact[]
  }
  /** Repository node ids accessible to a selected-repository installation. */
  readonly accessibleRepositoryIds: readonly GitHubRepositoryId[]
  /** Suspension time, when GitHub reports the installation suspended. */
  readonly suspendedAt?: number | undefined
  /** Expiry of the short-lived installation token used for this observation. */
  readonly tokenExpiresAt: number
  /** Time the provider completed this observation. */
  readonly observedAt: number
}

/** Raw GitHub Repository identity and visibility facts. */
export interface GitHubRepositoryFact {
  /** Repository node id. */
  readonly id: GitHubRepositoryId
  /** Repository database id. */
  readonly databaseId: GitHubRepositoryDatabaseId
  /** Owner account node id. */
  readonly ownerAccountId: GitHubAccountId
  /** Canonical `owner/name` spelling. */
  readonly nameWithOwner: string
  /** GitHub visibility value. */
  readonly visibility: 'public' | 'private' | 'internal'
  /** Credential-free canonical web URL. */
  readonly url: string
  /** Platform update observation. */
  readonly updatedAt: number
  /** Provider observation time. */
  readonly observedAt: number
}

/** Raw GitHub Project v2 identity and update facts. */
export interface GitHubProjectFact {
  /** Project node id. */
  readonly id: GitHubProjectId
  /** Owner account node id. */
  readonly ownerAccountId: GitHubAccountId
  /** Account-local Project number. */
  readonly number: number
  /** Current Project title. */
  readonly title: string
  /** Whether the Project is closed. */
  readonly closed: boolean
  /** Credential-free canonical web URL. */
  readonly url: string
  /** Platform update observation. */
  readonly updatedAt: number
  /** Provider observation time. */
  readonly observedAt: number
}

/** One raw Project v2 single-select option. */
export interface GitHubProjectOptionFact {
  /** Option node id. */
  readonly id: GitHubProjectOptionId
  /** Current platform label. */
  readonly name: string
}

/** One Project v2 field, preserving single-select options and other field types. */
export type GitHubProjectFieldFact =
  | {
    readonly kind: 'single-select'
    readonly id: GitHubProjectFieldId
    readonly name: string
    readonly options: readonly GitHubProjectOptionFact[]
  }
  | {
    readonly kind: 'field'
    readonly id: GitHubProjectFieldId
    readonly name: string
    readonly dataType: string
  }

/** Raw Issue identity, state, title, URL, and update observation. */
export interface GitHubIssueFact {
  /** Issue node id. */
  readonly id: GitHubIssueId
  /** Owning Repository node id. */
  readonly repositoryId: GitHubRepositoryId
  /** Owning Repository database id. */
  readonly repositoryDatabaseId: GitHubRepositoryDatabaseId
  /** Repository-local Issue number. */
  readonly number: number
  /** GitHub Issue state. */
  readonly state: 'open' | 'closed'
  /** Current Issue title. */
  readonly title: string
  /** Credential-free canonical web URL. */
  readonly url: string
  /** Platform update observation used as the Issue revision. */
  readonly updatedAt: number
}

/** Raw content attached to a Project item, including content Saki does not manage. */
export type GitHubProjectItemContent =
  | { readonly kind: 'issue'; readonly issue: GitHubIssueFact }
  | {
    readonly kind: 'pull-request'
    readonly id: GitHubPullRequestId
    readonly repositoryId?: GitHubRepositoryId | undefined
    readonly url?: string | undefined
  }
  | { readonly kind: 'draft-issue'; readonly title: string }
  | { readonly kind: 'redacted' }
  | { readonly kind: 'other'; readonly typeName: string }

/** One Project item in GitHub API order with raw content and field value. */
export interface GitHubProjectItemFact {
  /** Project item node id. */
  readonly id: GitHubProjectItemId
  /** Owning Project node id. */
  readonly projectId: GitHubProjectId
  /** Platform content union. */
  readonly content: GitHubProjectItemContent
  /** Selected option of the persisted Status field, when present. */
  readonly statusOptionId?: GitHubProjectOptionId | undefined
  /** GitHub archived flag. */
  readonly archived: boolean
  /** Zero-based order in the completely paged API result. */
  readonly apiOrder: number
  /** Item update observation. */
  readonly updatedAt: number
}

/** Stable observations taken before and after all paginated board reads. */
export interface GitHubProjectBoardUpdateFence {
  /** Project update time. */
  readonly projectUpdatedAt: number
  /** Repository update time. */
  readonly repositoryUpdatedAt: number
  /** Complete Project item count. */
  readonly projectItemCount: number
  /** Complete open-Issue count. */
  readonly openIssueCount: number
}

/** GraphQL primary-rate observation. */
export interface GitHubGraphqlRateObservation {
  readonly kind: 'graphql'
  readonly cost: number
  readonly limit: number
  readonly used: number
  readonly remaining: number
  readonly resetAt: number
  readonly observedAt: number
}

/** REST primary-rate headers and optional Retry-After. */
export interface GitHubRestRateObservation {
  readonly kind: 'rest'
  readonly resource: string
  readonly limit: number
  readonly used: number
  readonly remaining: number
  readonly resetAt: number
  readonly retryAfterMs?: number | undefined
  readonly observedAt: number
}

/** Secondary-limit response observation. */
export interface GitHubSecondaryRateObservation {
  readonly kind: 'secondary-limit'
  readonly retryAfterMs?: number | undefined
  readonly observedAt: number
}

/** Safe GitHub rate information retained with a completed operation. */
export type GitHubRateObservation =
  | GitHubGraphqlRateObservation
  | GitHubRestRateObservation
  | GitHubSecondaryRateObservation

/** Versioned deterministic identity for one complete Project-board candidate. */
export interface GitHubProjectBoardFingerprint {
  readonly version: 1
  readonly digest: string
}

/** One complete, validated Project-board scan; no cursor or partial-result arm exists. */
export interface GitHubProjectBoardScanCandidate {
  readonly kind: 'project-board'
  readonly formatVersion: 1
  readonly installation: GitHubInstallationFact
  readonly repository: GitHubRepositoryFact
  readonly project: GitHubProjectFact
  readonly statusFieldId: GitHubProjectFieldId
  readonly fields: readonly GitHubProjectFieldFact[]
  readonly items: readonly GitHubProjectItemFact[]
  readonly openIssues: readonly GitHubIssueFact[]
  readonly fences: {
    readonly before: GitHubProjectBoardUpdateFence
    readonly after: GitHubProjectBoardUpdateFence
  }
  readonly rateObservations: readonly GitHubRateObservation[]
  readonly fingerprint: GitHubProjectBoardFingerprint
  readonly observedAt: number
}

/** Fingerprint input; rate timing and operation observation time are deliberately ignored. */
export type GitHubProjectBoardFingerprintSource = Omit<GitHubProjectBoardScanCandidate, 'fingerprint'>

/** Read the installation identity, grants, repository access, and safe token expiry. */
export interface GitHubInstallationReadRequest {
  readonly kind: 'installation'
  readonly installation: GitHubInstallationProfile
}

/** Read one exact Repository. */
export interface GitHubRepositoryReadRequest {
  readonly kind: 'repository'
  readonly installation: GitHubInstallationProfile
  readonly repositoryId: GitHubRepositoryId
  readonly repositoryDatabaseId: GitHubRepositoryDatabaseId
}

/** Read one exact Issue revision. */
export interface GitHubIssueReadRequest {
  readonly kind: 'issue'
  readonly installation: GitHubInstallationProfile
  readonly repositoryId: GitHubRepositoryId
  readonly repositoryDatabaseId: GitHubRepositoryDatabaseId
  readonly issueId: GitHubIssueId
}

/** Read one exact Issue together with its complete bounded Markdown body. */
export interface GitHubIssueDetailReadRequest {
  readonly kind: 'issue-detail'
  readonly installation: GitHubInstallationProfile
  readonly repositoryId: GitHubRepositoryId
  readonly repositoryDatabaseId: GitHubRepositoryDatabaseId
  readonly issueId: GitHubIssueId
}

/** Exact Issue facts plus the complete current Markdown body. */
export interface GitHubIssueDetailFact extends GitHubIssueFact {
  readonly body: string
}

/** Inspect effective write-safety rules for one exact branch name. */
export interface GitHubBranchSafetyReadRequest {
  readonly kind: 'branch-safety'
  readonly installation: GitHubInstallationProfile
  readonly repositoryId: GitHubRepositoryId
  readonly repositoryDatabaseId: GitHubRepositoryDatabaseId
  readonly branch: string
}

/** Fail-closed branch safety observation without Administration permission. */
export type GitHubBranchSafetyFact =
  | { readonly kind: 'safe'; readonly branchExists: true; readonly observedAt: number }
  | { readonly kind: 'protected'; readonly branchExists: boolean; readonly observedAt: number }
  | {
    readonly kind: 'legacy-protection-unknown'
    readonly branchExists: false
    readonly observedAt: number
  }

/** Read one exact Project v2 identity and update observation. */
export interface GitHubProjectReadRequest {
  readonly kind: 'project'
  readonly installation: GitHubInstallationProfile
  readonly projectId: GitHubProjectId
}

/** Read one exact `refs/tags/saki-v*` reference. */
export interface GitHubTagReferenceReadRequest {
  readonly kind: 'tag-reference'
  readonly installation: GitHubInstallationProfile
  readonly repositoryId: GitHubRepositoryId
  readonly repositoryDatabaseId: GitHubRepositoryDatabaseId
  readonly tagName: GitHubReleaseTagName
}

/** Git object target of a tag reference or annotated tag. */
export type GitHubTagTarget =
  | { readonly kind: 'tag'; readonly id: GitHubTagObjectId }
  | { readonly kind: 'commit'; readonly id: GitHubCommitId }

/** Exact Git tag reference observation. */
export interface GitHubTagReferenceFact {
  readonly repositoryId: GitHubRepositoryId
  readonly tagName: GitHubReleaseTagName
  readonly ref: string
  readonly target: GitHubTagTarget
  readonly observedAt: number
}

/** Read and recursively peel one tag target to a Commit. */
export interface GitHubTagObjectReadRequest {
  readonly kind: 'tag-object'
  readonly installation: GitHubInstallationProfile
  readonly repositoryId: GitHubRepositoryId
  readonly repositoryDatabaseId: GitHubRepositoryDatabaseId
  readonly target: GitHubTagTarget
}

/** One annotated tag in a recursive peel chain. */
export interface GitHubTagObjectFact {
  readonly id: GitHubTagObjectId
  readonly target: GitHubTagTarget
  readonly taggedAt?: number | undefined
  readonly url?: string | undefined
}

/** Complete recursive annotated-tag peel result. */
export interface GitHubTagPeelFact {
  readonly repositoryId: GitHubRepositoryId
  readonly tagObjects: readonly GitHubTagObjectFact[]
  readonly commitId: GitHubCommitId
  readonly observedAt: number
}

/** Read a Release whose `tag_name` exactly matches one Saki tag. */
export interface GitHubReleaseByTagReadRequest {
  readonly kind: 'release-by-tag'
  readonly installation: GitHubInstallationProfile
  readonly repositoryId: GitHubRepositoryId
  readonly repositoryDatabaseId: GitHubRepositoryDatabaseId
  readonly tagName: GitHubReleaseTagName
}

/** Raw GitHub Release facts relevant to release evidence. */
export interface GitHubReleaseFact {
  readonly id: GitHubReleaseId
  readonly repositoryId: GitHubRepositoryId
  readonly tagName: GitHubReleaseTagName
  readonly targetCommitish: string
  readonly draft: boolean
  readonly prerelease: boolean
  readonly url: string
  readonly publishedAt?: number | undefined
  readonly observedAt: number
}

/** Presence observation for a Release-by-tag lookup. */
export type GitHubReleaseByTagObservation =
  | { readonly kind: 'present'; readonly release: GitHubReleaseFact }
  | {
    readonly kind: 'absent'
    readonly repositoryId: GitHubRepositoryId
    readonly tagName: GitHubReleaseTagName
    readonly observedAt: number
  }

/** Read one exact Commit, including a configured-upstream existence check. */
export interface GitHubCommitReadRequest {
  readonly kind: 'commit'
  readonly installation: GitHubInstallationProfile
  readonly repositoryId: GitHubRepositoryId
  readonly repositoryDatabaseId: GitHubRepositoryDatabaseId
  readonly commitId: GitHubCommitId
}

/** Exact GitHub Commit observation. */
export interface GitHubCommitFact {
  readonly id: GitHubCommitId
  readonly repositoryId: GitHubRepositoryId
  readonly url: string
  readonly committedAt: number
  readonly observedAt: number
}

/** Compare two exact Commits for ancestry evidence. */
export interface GitHubCompareCommitsReadRequest {
  readonly kind: 'compare-commits'
  readonly installation: GitHubInstallationProfile
  readonly repositoryId: GitHubRepositoryId
  readonly repositoryDatabaseId: GitHubRepositoryDatabaseId
  readonly baseCommitId: GitHubCommitId
  readonly headCommitId: GitHubCommitId
}

/** Raw compare/ancestry result. */
export interface GitHubCommitComparisonFact {
  readonly repositoryId: GitHubRepositoryId
  readonly baseCommitId: GitHubCommitId
  readonly headCommitId: GitHubCommitId
  readonly status: 'ahead' | 'behind' | 'identical' | 'diverged'
  readonly aheadBy: number
  readonly behindBy: number
  readonly mergeBaseCommitId?: GitHubCommitId | undefined
  readonly observedAt: number
}

/** Request a complete Project-board snapshot with persisted external Status ids. */
export interface GitHubProjectBoardScanRequest {
  readonly kind: 'project-board'
  readonly installation: GitHubInstallationProfile
  readonly projectId: GitHubProjectId
  readonly repositoryId: GitHubRepositoryId
  readonly repositoryDatabaseId: GitHubRepositoryDatabaseId
  readonly statusFieldId: GitHubProjectFieldId
  readonly requiredStatusOptionIds: readonly GitHubProjectOptionId[]
  readonly priority: 'interactive' | 'background'
  /** Caller-resolved GraphQL points retained for higher-priority work. */
  readonly rateLimitReserve: number
}

/** Add one exact Issue to one Project without assuming a Project item id. */
export interface GitHubProjectItemAddRequest {
  readonly kind: 'project-item-add'
  /** Caller-assigned id persisted before dispatch. */
  readonly operationId: GitHubExternalOperationId
  readonly installation: GitHubInstallationProfile
  readonly repositoryId: GitHubRepositoryId
  readonly repositoryDatabaseId: GitHubRepositoryDatabaseId
  readonly projectId: GitHubProjectId
  readonly issueId: GitHubIssueId
}

/** Set one Project item's persisted single-select Status option. */
export interface GitHubProjectItemStatusSetRequest {
  readonly kind: 'project-item-status-set'
  /** Caller-assigned id persisted before dispatch. */
  readonly operationId: GitHubExternalOperationId
  readonly installation: GitHubInstallationProfile
  readonly repositoryId: GitHubRepositoryId
  readonly repositoryDatabaseId: GitHubRepositoryDatabaseId
  readonly projectId: GitHubProjectId
  readonly issueId: GitHubIssueId
  readonly projectItemId: GitHubProjectItemId
  readonly statusFieldId: GitHubProjectFieldId
  readonly desiredStatusOptionId: GitHubProjectOptionId
}

/** Move one exact Project item after another API-position item, or to the top. */
export interface GitHubProjectItemPositionSetRequest {
  readonly kind: 'project-item-position-set'
  /** Caller-assigned id persisted before dispatch. */
  readonly operationId: GitHubExternalOperationId
  readonly installation: GitHubInstallationProfile
  readonly repositoryId: GitHubRepositoryId
  readonly repositoryDatabaseId: GitHubRepositoryDatabaseId
  readonly projectId: GitHubProjectId
  readonly issueId: GitHubIssueId
  readonly projectItemId: GitHubProjectItemId
  /** Persisted single-select Status field whose raw option is retained for the predecessor. */
  readonly statusFieldId: GitHubProjectFieldId
  /** Project item after which the moving item is placed; `null` means the top. */
  readonly afterItemId: GitHubProjectItemId | null
}

/** Set one exact repository Issue to open or closed. */
export interface GitHubIssueStateSetRequest {
  readonly kind: 'issue-state-set'
  /** Caller-assigned id persisted before dispatch. */
  readonly operationId: GitHubExternalOperationId
  readonly installation: GitHubInstallationProfile
  readonly repositoryId: GitHubRepositoryId
  readonly repositoryDatabaseId: GitHubRepositoryDatabaseId
  readonly issueId: GitHubIssueId
  readonly desiredState: 'open' | 'closed'
}

/** Exact Issue identity returned by create and optionally supplied to reconcile that attempt. */
export interface GitHubIssueCreateInspectionHint {
  /** Expected Issue node id. */
  readonly issueId: GitHubIssueId
  /** Expected repository-local Issue number. */
  readonly issueNumber: number
}

/** Create one Issue whose complete deterministic body carries one persisted marker. */
export interface GitHubIssueCreateRequest {
  readonly kind: 'issue-create'
  /** Caller-assigned id persisted before dispatch. */
  readonly operationId: GitHubExternalOperationId
  readonly installation: GitHubInstallationProfile
  readonly repositoryId: GitHubRepositoryId
  readonly repositoryDatabaseId: GitHubRepositoryDatabaseId
  readonly title: string
  readonly body: string
  readonly markerId: GitHubIssueCreateMarkerId
  /** Reconciliation-only evidence; never sent by dispatch. */
  readonly inspectionHint?: GitHubIssueCreateInspectionHint | undefined
}

/** Durable-safe classification of one bounded exact-marker inspection. */
export type GitHubIssueCreateInspectionOutcome =
  | { readonly state: 'unique-issue'; readonly issue: GitHubIssueFact }
  | { readonly state: 'absent-complete' }
  | { readonly state: 'pull-request-marker-match' }
  | { readonly state: 'marker-removed' }
  | { readonly state: 'known-issue-absent' }
  | { readonly state: 'identity-conflict' }
  | { readonly state: 'multiple-matches' }
  | { readonly state: 'incomplete' }

/** Raw repository-bound Issue-create reconciliation facts. */
export interface GitHubIssueCreateSnapshot {
  readonly repositoryId: GitHubRepositoryId
  readonly repositoryDatabaseId: GitHubRepositoryDatabaseId
  readonly outcome: GitHubIssueCreateInspectionOutcome
}

/** Targeted exact-marker observation for one Issue-create mutation. */
export interface GitHubIssueCreateInspection {
  readonly snapshot: GitHubIssueCreateSnapshot
  readonly observedAt: number
}

/** Issue-backed Project item retained to identify one API-position predecessor. */
export interface GitHubProjectItemPositionAnchorFact {
  readonly id: GitHubProjectItemId
  readonly projectId: GitHubProjectId
  readonly issue: GitHubIssueFact
  readonly statusOptionId?: GitHubProjectOptionId | undefined
  readonly archived: boolean
  readonly apiOrder: number
  readonly totalCount: number
  readonly previousItemId: GitHubProjectItemId | null
  readonly nextItemId: GitHubProjectItemId | null
  readonly updatedAt: number
}

/** Observed membership and predecessor facts for one API-position mutation. */
interface GitHubProjectItemPositionSnapshot {
  readonly repositoryId: GitHubRepositoryId
  readonly repositoryDatabaseId: GitHubRepositoryDatabaseId
  readonly projectId: GitHubProjectId
  readonly statusFieldId: GitHubProjectFieldId
  readonly issue: GitHubIssueFact
  readonly membership: GitHubProjectItemPositionMembership
  readonly after:
    | { readonly state: 'top' }
    | { readonly state: 'present'; readonly item: GitHubProjectItemPositionAnchorFact }
    | { readonly state: 'absent'; readonly itemId: GitHubProjectItemId }
}

/** Targeted post-dispatch observation for one API-position mutation. */
export interface GitHubProjectItemPositionSetInspection {
  readonly snapshot: GitHubProjectItemPositionSnapshot
  readonly observedAt: number
}

/** Raw exact Issue facts used to reconcile one Issue-state mutation. */
interface GitHubIssueStateSnapshot {
  readonly issue: GitHubIssueFact
}

/** Targeted post-dispatch observation for one Issue-state mutation. */
export interface GitHubIssueStateSetInspection {
  readonly snapshot: GitHubIssueStateSnapshot
  readonly observedAt: number
}

/** One Project membership observed in API position order. */
export interface GitHubTargetedProjectItemFact {
  readonly id: GitHubProjectItemId
  readonly projectId: GitHubProjectId
  readonly issueId: GitHubIssueId
  readonly statusOptionId?: GitHubProjectOptionId | undefined
  readonly archived: boolean
  readonly apiOrder: number
  /** Cardinality of the completely traversed Project-item connection. */
  readonly totalCount: number
  readonly previousItemId: GitHubProjectItemId | null
  readonly nextItemId: GitHubProjectItemId | null
  readonly updatedAt: number
}

/** Minimal Project membership identity observed before or after an add attempt. */
export interface GitHubProjectMembershipItemFact {
  readonly id: GitHubProjectItemId
  readonly projectId: GitHubProjectId
  readonly issueId: GitHubIssueId
  readonly archived: boolean
}

/** Current Project membership for one exact Issue. */
type GitHubTargetedWorkItemMembership =
  | { readonly state: 'present'; readonly item: GitHubTargetedProjectItemFact }
  | { readonly state: 'absent' }

/** Position-target membership, including conflicting duplicate Issue memberships. */
export type GitHubProjectItemPositionMembership =
  | GitHubTargetedWorkItemMembership
  | {
    readonly state: 'duplicate-conflict'
    readonly items: readonly GitHubTargetedProjectItemFact[]
  }

/** Raw targeted facts used to reconcile one Work Item without a Board checkpoint. */
export interface GitHubTargetedWorkItemSnapshot {
  readonly repositoryId: GitHubRepositoryId
  readonly repositoryDatabaseId: GitHubRepositoryDatabaseId
  readonly projectId: GitHubProjectId
  readonly statusFieldId: GitHubProjectFieldId
  readonly issue: GitHubIssueFact
  readonly membership: GitHubTargetedWorkItemMembership
}

/** Targeted post-dispatch observation for one Status mutation. */
export interface GitHubProjectItemStatusSetInspection {
  readonly snapshot: GitHubTargetedWorkItemSnapshot
  readonly observedAt: number
}

/** Project membership observed by Issue identity before or after an add attempt. */
export type GitHubProjectItemAddMembership =
  | { readonly state: 'absent' }
  | { readonly state: 'present'; readonly item: GitHubProjectMembershipItemFact }
  | {
    readonly state: 'duplicate-conflict'
    readonly items: readonly GitHubProjectMembershipItemFact[]
  }

/** Raw targeted facts used to reconcile one Project membership mutation. */
interface GitHubProjectItemAddSnapshot {
  readonly repositoryId: GitHubRepositoryId
  readonly repositoryDatabaseId: GitHubRepositoryDatabaseId
  readonly projectId: GitHubProjectId
  readonly issue: GitHubIssueFact
  readonly membership: GitHubProjectItemAddMembership
}

/** Targeted observation for one Project membership mutation. */
export interface GitHubProjectItemAddInspection {
  readonly snapshot: GitHubProjectItemAddSnapshot
  readonly observedAt: number
}

/** Declaration-merge operation map for provider-neutral GitHub reads. */
export interface GitHubReadMap {
  installation: { readonly request: GitHubInstallationReadRequest; readonly result: GitHubInstallationFact }
  repository: { readonly request: GitHubRepositoryReadRequest; readonly result: GitHubRepositoryFact }
  issue: { readonly request: GitHubIssueReadRequest; readonly result: GitHubIssueFact }
  'issue-detail': { readonly request: GitHubIssueDetailReadRequest; readonly result: GitHubIssueDetailFact }
  'branch-safety': { readonly request: GitHubBranchSafetyReadRequest; readonly result: GitHubBranchSafetyFact }
  project: { readonly request: GitHubProjectReadRequest; readonly result: GitHubProjectFact }
  'tag-reference': { readonly request: GitHubTagReferenceReadRequest; readonly result: GitHubTagReferenceFact }
  'tag-object': { readonly request: GitHubTagObjectReadRequest; readonly result: GitHubTagPeelFact }
  'release-by-tag': { readonly request: GitHubReleaseByTagReadRequest; readonly result: GitHubReleaseByTagObservation }
  commit: { readonly request: GitHubCommitReadRequest; readonly result: GitHubCommitFact }
  'compare-commits': { readonly request: GitHubCompareCommitsReadRequest; readonly result: GitHubCommitComparisonFact }
}

/** Declaration-merge operation map for complete GitHub scans. */
export interface GitHubScanMap {
  'project-board': {
    readonly request: GitHubProjectBoardScanRequest
    readonly result: GitHubProjectBoardScanCandidate
  }
}

/** Declaration-merge operation map for atomic GitHub mutations. */
export interface GitHubMutationMap {
  'issue-create': {
    readonly request: GitHubIssueCreateRequest
    readonly result: GitHubIssueCreateInspectionHint
    readonly inspection: GitHubIssueCreateInspection
  }
  'project-item-add': {
    readonly request: GitHubProjectItemAddRequest
    readonly result: void
    readonly inspection: GitHubProjectItemAddInspection
  }
  'project-item-status-set': {
    readonly request: GitHubProjectItemStatusSetRequest
    readonly result: void
    readonly inspection: GitHubProjectItemStatusSetInspection
  }
  'project-item-position-set': {
    readonly request: GitHubProjectItemPositionSetRequest
    readonly result: void
    readonly inspection: GitHubProjectItemPositionSetInspection
  }
  'issue-state-set': {
    readonly request: GitHubIssueStateSetRequest
    readonly result: void
    readonly inspection: GitHubIssueStateSetInspection
  }
}

/** Union of every registered read request. */
export type GitHubReadRequest = GitHubReadMap[keyof GitHubReadMap]['request']
/** Union of every registered read result. */
export type GitHubReadResult = GitHubReadMap[keyof GitHubReadMap]['result']
/** Union of every registered scan request. */
export type GitHubScanRequest = GitHubScanMap[keyof GitHubScanMap]['request']
/** Union of every registered scan result. */
export type GitHubScanResult = GitHubScanMap[keyof GitHubScanMap]['result']
/** Closed safe failure codes shared by GitHub reads, scans, and mutations. */
export type GitHubFailureCode =
  | 'cancelled'
  | 'auth-unavailable'
  | 'permission-mismatch'
  | 'mapping-mismatch'
  | 'not-found'
  | 'invalid-external-response'
  | 'primary-rate-limit'
  | 'secondary-rate-limit'
  | 'transient-transport'
  | 'permanent-rejection'

/** Safe provider failure data; raw SDK errors, response bodies, and credentials are excluded. */
export type GitHubFailure =
  | { readonly code: 'cancelled' }
  | { readonly code: 'auth-unavailable'; readonly credentialRef?: CredentialRef | undefined }
  | {
    readonly code: 'permission-mismatch'
    readonly permission: string
    readonly required: 'none' | 'read' | 'write' | 'admin'
    readonly observed?: 'none' | 'read' | 'write' | 'admin' | undefined
    readonly requestId?: string | undefined
  }
  | {
    readonly code: 'mapping-mismatch'
    readonly reason: 'field-missing-or-not-single-select'
    readonly statusFieldId: GitHubProjectFieldId
  }
  | {
    readonly code: 'mapping-mismatch'
    readonly reason: 'required-options-missing'
    readonly statusFieldId: GitHubProjectFieldId
    readonly missingRequiredStatusOptionIds: readonly GitHubProjectOptionId[]
  }
  | { readonly code: 'not-found'; readonly resource: string; readonly requestId?: string | undefined }
  | { readonly code: 'invalid-external-response'; readonly operation: string; readonly requestId?: string | undefined }
  | { readonly code: 'primary-rate-limit'; readonly resetAt?: number | undefined; readonly requestId?: string | undefined }
  | { readonly code: 'secondary-rate-limit'; readonly retryAfterMs?: number | undefined; readonly requestId?: string | undefined }
  | { readonly code: 'transient-transport'; readonly retryAfterMs?: number | undefined; readonly requestId?: string | undefined }
  | { readonly code: 'permanent-rejection'; readonly status?: number | undefined; readonly requestId?: string | undefined }
