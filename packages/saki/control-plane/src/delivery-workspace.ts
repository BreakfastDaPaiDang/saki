/** Read-only delivery choices and advisory action eligibility from current Host and GitHub owners. */
import { isDeepStrictEqual } from 'node:util'
import { GitHubProviderError } from '@breakfastdapaidang/saki-github'
import type { GitHubPullRequestAssociationFact, SakiGitHub } from '@breakfastdapaidang/saki-github'
import type { GitCredentialHelperId } from '@breakfastdapaidang/saki-execution'
import { branchDeliveryId } from './branch-delivery.ts'
import type { BranchDeliveryAction, BranchDeliveryBrowserRecord, BranchDeliveryContextResult, BranchDeliveryExpectation, BranchDeliveryOperations, BranchDeliveryProjection } from './branch-delivery.ts'
import type { SakiBoardWorkItemId, SakiDevelopmentProjectId } from './types.ts'

/** Explicit refresh policy for one Work Item's delivery controls. */
export interface SakiDeliveryWorkspaceQuery {
  readonly type: 'delivery-workspace'
  readonly projectId: SakiDevelopmentProjectId
  readonly workItemId: SakiBoardWorkItemId
  readonly refresh: 'cached' | 'interactive'
}
/** Product reasons an explicit delivery gesture is currently unavailable. */
export type DeliveryActionBlockage = 'authority' | 'context-unavailable' | 'selection-required' | 'busy' | 'repair-required' | 'accepted' | 'credentials-unavailable' | 'provider-unavailable' | 'push-required' | 'pull-request-required' | 'association-required' | 'evidence-unconfirmed' | 'ci-not-successful' | 'phase' | 'already-pushed' | 'already-associated'
/** Advisory availability; submission still rechecks current authority and exact evidence. */
export interface DeliveryActionAvailability { readonly available: boolean; readonly reasons: readonly DeliveryActionBlockage[] }
/** Explicit gestures offered by the delivery destination. */
export type DeliveryGesture = 'save' | 'push' | 'create' | 'associate' | 'review' | 'accept'
/** Retained delivery plus safe selection premises and complete PR discovery. */
export interface SakiDeliveryWorkspaceProjection {
  readonly type: 'delivery-workspace'
  readonly projectId: SakiDevelopmentProjectId
  readonly workItemId: SakiBoardWorkItemId
  readonly selection: { readonly expected: BranchDeliveryExpectation; readonly target: BranchDeliveryBrowserRecord['target'] } | null
  readonly pushCredentialHelper: GitCredentialHelperId | null
  readonly branchDelivery: BranchDeliveryProjection | null
  readonly association: GitHubPullRequestAssociationFact | { readonly state: 'unobserved' | 'unavailable' }
  readonly actions: Readonly<Record<DeliveryGesture, DeliveryActionAvailability>>
}
/** Current owners required for a read; no mutation authority leaves this module. */
export interface DeliveryWorkspaceDependencies {
  readonly resolveContext: () => BranchDeliveryContextResult
  readonly deliveries: Pick<BranchDeliveryOperations, 'project' | 'refresh'>
  readonly provider: () => SakiGitHub | undefined
  readonly authorized: (action: BranchDeliveryAction) => boolean
  readonly pushCredentialHelper: GitCredentialHelperId | undefined
}

/** Retains PR discovery only for one delivery revision within the owning Provider lifetime. */
export class DeliveryWorkspaceReader {
  private readonly associations = new Map<ReturnType<typeof branchDeliveryId>, {
    readonly revision: number
    readonly target: BranchDeliveryBrowserRecord['target']
    readonly fact: GitHubPullRequestAssociationFact
  }>()

  /** Discard Provider-owned discovery when the Provider detaches. */
  clear(): void { this.associations.clear() }

  /**
   * Read selection premises and, on request, exact delivery sources and unique PR discovery.
   * @param query - selected Project, Work Item, and refresh policy.
   * @param dependencies - current authority, configuration, and evidence owners.
   * @param signal - caller lifetime; canceled or superseded reads cannot publish choices.
   * @returns browser-safe choices without fetching Git credentials or changing the Board checkpoint.
   */
  async read(
    query: SakiDeliveryWorkspaceQuery, dependencies: DeliveryWorkspaceDependencies, signal: AbortSignal,
  ): Promise<SakiDeliveryWorkspaceProjection> {
    const id = branchDeliveryId(query.projectId, query.workItemId)
    if (query.refresh === 'interactive') this.associations.delete(id)
    if (query.refresh === 'interactive' && dependencies.deliveries.project(id, Date.now()) !== undefined) {
      await dependencies.deliveries.refresh(id, signal)
      signal.throwIfAborted()
    }
    const resolved = dependencies.resolveContext()
    const branchDelivery = dependencies.deliveries.project(id, Date.now()) ?? null
    const context = resolved.ok ? resolved.context : null
    const selection = context === null ? null : {
      expected: {
        deliveryRevision: branchDelivery?.delivery.revision ?? null,
        registryRevision: context.registryRevision, projectRevision: context.projectRevision,
        binding: { id: context.binding.id, revision: context.binding.revision },
        synchronizationRevision: context.synchronizationRevision, mappingRevision: context.mappingRevision,
        workItemRemoteFingerprint: context.workItem.remoteFingerprint,
      },
      target: {
        registryRevision: context.registryRevision, projectRevision: context.projectRevision,
        binding: {
          id: context.binding.id, revision: context.binding.revision, hostId: context.binding.hostId, health: context.binding.health,
        },
        synchronizationRevision: context.synchronizationRevision, mappingRevision: context.mappingRevision,
        installation: {
          appId: context.installation.appId, installationId: context.installation.installationId, accountId: context.installation.accountId,
        },
        repository: context.repository, workItem: context.workItem,
      },
    }
    const provider = dependencies.provider()
    let association: SakiDeliveryWorkspaceProjection['association'] = { state: 'unobserved' }
    const delivery = branchDelivery?.delivery
    const retained = this.associations.get(id)
    if (retained !== undefined && provider !== undefined && retained.revision === delivery?.revision
    && isDeepStrictEqual(retained.target, selection?.target)) association = retained.fact
    if (query.refresh === 'interactive' && delivery !== undefined && delivery.phase !== 'accepted'
    && delivery.activeIntentId === undefined && delivery.repair === undefined && branchDelivery?.pullRequest.confirmed === undefined) {
      if (provider === undefined || context === null) association = { state: 'unavailable' }
      else {
        try {
          association = await provider.read<'pull-request-association'>({
            kind: 'pull-request-association', installation: context.installation,
            repositoryId: context.repository.id, repositoryDatabaseId: context.repository.databaseId,
            headRef: delivery.headRef.slice('refs/heads/'.length), baseRef: delivery.baseRef.slice('refs/heads/'.length),
            expectedHeadCommitId: delivery.commitId,
          }, signal)
        } catch (error) {
          if (!(error instanceof GitHubProviderError)) throw error
          association = { state: 'unavailable' }
        }
        signal.throwIfAborted()
      }
    }
    const unchanged = isDeepStrictEqual(resolved, dependencies.resolveContext())
    && dependencies.provider() === provider
    && dependencies.deliveries.project(id, Date.now())?.delivery.revision === delivery?.revision
    const stableSelection = unchanged ? selection : null
    if (!unchanged) association = { state: 'unavailable' }
    if (unchanged && delivery !== undefined && stableSelection !== null && 'observedAt' in association) {
      this.associations.set(id, { revision: delivery.revision, target: stableSelection.target, fact: association })
    }
    const currentTarget = stableSelection !== null && (delivery === undefined || isDeepStrictEqual(stableSelection.target, delivery.target))
    const common: DeliveryActionBlockage[] = [
      ...(!currentTarget ? ['context-unavailable'] as const : []),
      ...(delivery?.activeIntentId !== undefined ? ['busy'] as const : []),
      ...(delivery?.repair !== undefined ? ['repair-required'] as const : []),
      ...(delivery?.phase === 'accepted' ? ['accepted'] as const : []),
    ]
    const availability = (action: BranchDeliveryAction, reasons: readonly DeliveryActionBlockage[]): DeliveryActionAvailability => {
      const all = [...(!dependencies.authorized(action) ? ['authority'] as const : []), ...reasons]
      return { available: all.length === 0, reasons: all }
    }
    const existing: DeliveryActionBlockage[] = [...common, ...(delivery === undefined ? ['selection-required'] as const : [])]
    const remote: DeliveryActionBlockage[] = [...existing, ...(provider === undefined ? ['provider-unavailable'] as const : []), ...(delivery?.push === undefined ? ['push-required'] as const : [])]
    const transition: DeliveryActionBlockage[] = [...remote,
      ...(branchDelivery?.pullRequest.confirmed === undefined ? ['pull-request-required'] as const : []),
      ...(branchDelivery?.remoteRef.current.state !== 'confirmed' || branchDelivery.pullRequest.current.state !== 'confirmed' ? ['evidence-unconfirmed'] as const : []),
    ]
    return {
      type: 'delivery-workspace', projectId: query.projectId, workItemId: query.workItemId,
      selection: stableSelection, pushCredentialHelper: dependencies.pushCredentialHelper ?? null, branchDelivery, association,
      actions: {
        save: availability('branch-delivery:save', [
          ...common.filter(reason => reason !== 'context-unavailable'), ...(stableSelection === null ? ['context-unavailable'] as const : []),
        ]),
        push: availability('branch-delivery:push', [...existing,
          ...(dependencies.pushCredentialHelper === undefined ? ['credentials-unavailable'] as const : []),
          ...(delivery?.push !== undefined ? ['already-pushed'] as const : []),
        ]),
        create: availability('branch-delivery:pull-request:create', [...remote,
          ...(branchDelivery?.pullRequest.confirmed !== undefined ? ['already-associated'] as const : []),
          ...(association.state !== 'absent' ? ['association-required'] as const : []),
        ]),
        associate: availability('branch-delivery:pull-request:associate', [...remote,
          ...(branchDelivery?.pullRequest.confirmed !== undefined ? ['already-associated'] as const : []),
          ...(association.state !== 'unique' ? ['association-required'] as const : []),
        ]),
        review: availability('branch-delivery:review', [...transition, ...(delivery?.phase !== 'draft' ? ['phase'] as const : [])]),
        accept: availability('branch-delivery:accept', [...transition,
          ...(delivery?.phase !== 'in-review' ? ['phase'] as const : []),
          ...(branchDelivery?.ci.current.state !== 'confirmed' || branchDelivery.ci.confirmedSummary?.state !== 'successful' ? ['ci-not-successful'] as const : []),
        ]),
      },
    }
  }
}
