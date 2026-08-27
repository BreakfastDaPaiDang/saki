/** Public Saki control-plane value types. @module @breakfastdapaidang/saki-control-plane/types */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {
  GitHubAccountId,
  GitHubAppId,
  GitHubFailure,
  GitHubInstallationId,
  GitHubIssueId,
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
  InheritedChangeBaseline,
  InspectProjectSelectionResult,
  ProjectInspectionFingerprint,
  ProjectSelectionProjection,
  SakiHostId,
} from '@breakfastdapaidang/saki-execution'

export type { SakiHostId } from '@breakfastdapaidang/saki-execution'
export type {
  GitHubAccountId,
  GitHubAppId,
  GitHubFailure,
  GitHubInstallationId,
  GitHubIssueId,
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
/** Stable identity of one Host-owned Resource Binding. */
export type SakiResourceBindingId = Branded<'SakiResourceBindingId'>
/** Stable idempotency identity of one Control Intent. */
export type SakiControlIntentId = Branded<'SakiControlIntentId'>
/** Stable receipt identity retained with one accepted Intent. */
export type SakiIntentReceiptId = Branded<'SakiIntentReceiptId'>
/** Stable identity of one GitHub-backed Work Item across Project membership changes. */
export type SakiBoardWorkItemId = Branded<'SakiBoardWorkItemId'>
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
    readonly head: string
    readonly branch?: string
    readonly detached: boolean
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

/** Result of publishing one complete scan candidate under its durable fence. */
export type SakiGitHubScanPublishResult =
  | { readonly state: 'published'; readonly generation: number; readonly configurationRevision: number }
  | { readonly state: 'activation-failed'; readonly issues: readonly SakiGitHubMappingIssue[] }
  | { readonly state: 'failed'; readonly failure: SakiGitHubScanFailure }
  | { readonly state: 'stale' }

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
  readonly failure: SakiGitHubScanFailure
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
  | 'no-concrete-mutation'

/** Effective mutation availability for the current read-only Board release. */
export interface SakiBoardMutationAvailabilityProjection {
  readonly available: false
  readonly reasons: readonly SakiBoardMutationUnavailableReason[]
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

/** Control-plane Intent request map. */
export interface SakiIntentMap {
  readonly 'register-development-project': RegisterDevelopmentProjectIntent
  readonly 'configure-github-synchronization': ConfigureGitHubSynchronizationIntent
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
}

/** Stable terminal or recoverable result of submitting a Control Intent. */
export type SakiIntentReceipt<K extends keyof SakiIntentReceiptMap = 'register-development-project'> =
  K extends keyof SakiIntentReceiptMap ? SakiIntentReceiptMap[K] : never

/** Projection key invalidated after a committed access or authority change. */
export type SakiProjectionKey = 'access' | 'project-index' | 'development-workspace' | 'project-settings' | 'board'

/** Disposer for a contained post-commit Projection invalidation listener. */
export type SakiChangedDisposer = () => void
