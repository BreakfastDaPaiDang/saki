/** Public Saki control-plane value types. @module @breakfastdapaidang/saki-control-plane/types */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type {
  InheritedChangeBaseline,
  InspectProjectSelectionResult,
  ProjectInspectionFingerprint,
  ProjectSelectionProjection,
  SakiHostId,
} from '@breakfastdapaidang/saki-execution'

export type { SakiHostId } from '@breakfastdapaidang/saki-execution'

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

/** Control-plane Intent request map. */
export interface SakiIntentMap {
  readonly 'register-development-project': RegisterDevelopmentProjectIntent
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

/** Stable terminal or recoverable result of submitting a Control Intent. */
export type SakiIntentReceipt =
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

/** Projection key invalidated after a committed access or authority change. */
export type SakiProjectionKey = 'access' | 'project-index' | 'development-workspace'

/** Disposer for a contained post-commit Projection invalidation listener. */
export type SakiChangedDisposer = () => void
