/** Browser client for the typed Saki Connection channel. @module @breakfastdapaidang/saki-host-api/client */

import { Context, Service } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import {
  sakiAccessExchangeResultSchema,
  sakiAccessLogoutResultSchema,
  sakiAccessProjectionSchema,
  sakiAnswerInterventionResultSchema,
  sakiAttentionResultSchema,
  sakiBranchDeliveryIntentResultSchema,
  sakiBranchDeliveryResultSchema,
  sakiBoardResultSchema,
  sakiConfigureGitHubSynchronizationResultSchema,
  sakiCreateCommitResultSchema,
  sakiCreateWorkItemResultSchema,
  sakiGiveWorkItemToAgentResultSchema,
  sakiDevelopmentWorkspaceResultSchema,
  sakiInspectProjectSelectionResultSchema,
  sakiMilestoneDeliveryIntentResultSchema,
  sakiMilestoneViewResultSchema,
  sakiProjectDiffResultSchema,
  sakiProjectChangesResultSchema,
  sakiRegisterDevelopmentProjectResultSchema,
  sakiProjectIndexResultSchema,
  sakiProjectSettingsResultSchema,
  sakiMoveWorkItemResultSchema,
  sakiMyWorkResultSchema,
  sakiStageFilesResultSchema,
  sakiUnstageFilesResultSchema,
} from '../wire.ts'
import type {
  SakiWireAccessExchangeResult,
  SakiWireAccessLogoutResult,
  SakiWireAccessProjection,
  SakiWireAnswerInterventionIntent,
  SakiWireAnswerInterventionResult,
  SakiWireAttentionResult,
  SakiWireAcceptBranchDeliveryIntent,
  SakiWireAssociateBranchDeliveryPullRequestIntent,
  SakiWireBranchDeliveryIntent,
  SakiWireBranchDeliveryIntentResult,
  SakiWireBranchDeliveryRefresh,
  SakiWireBranchDeliveryResult,
  SakiWireBoardRefresh,
  SakiWireBoardResult,
  SakiWireConfigureGitHubSynchronizationIntent,
  SakiWireConfigureGitHubSynchronizationResult,
  SakiWireCreateCommitIntent,
  SakiWireCreateCommitResult,
  SakiWireCreateBranchDeliveryPullRequestIntent,
  SakiWireCreateWorkItemIntent,
  SakiWireCreateWorkItemResult,
  SakiWireGiveWorkItemToAgentIntent,
  SakiWireGiveWorkItemToAgentResult,
  SakiWireDevelopmentWorkspaceResult,
  SakiWireHostId,
  SakiWireInspectProjectSelectionResult,
  SakiWireProjectId,
  SakiWireProjectDiffRequest,
  SakiWireProjectDiffResult,
  SakiWireProjectIndexResult,
  SakiWireProjectChangesResult,
  SakiWireProjectSettingsResult,
  SakiWireMoveWorkItemIntent,
  SakiWireMoveWorkItemResult,
  SakiWireMarkBranchDeliveryInReviewIntent,
  SakiWireMilestoneDeliveryIntent,
  SakiWireMilestoneDeliveryIntentResult,
  SakiWireMilestoneViewRefresh,
  SakiWireMilestoneViewResult,
  SakiWireMyWorkResult,
  SakiWireRegisterDevelopmentProjectIntent,
  SakiWireRegisterDevelopmentProjectResult,
  SakiWirePushBranchDeliveryIntent,
  SakiWireFinalizeMilestoneDeliveryIntent,
  SakiWireSaveBranchDeliveryIntent,
  SakiWireSaveMilestoneDeliveryIntent,
  SakiWireStageFilesIntent,
  SakiWireStageFilesResult,
  SakiWireUnstageFilesIntent,
  SakiWireUnstageFilesResult,
} from '../wire.ts'

const CHANNEL = '/saki'
const REQUEST_TOKEN_HEADER = 'x-saki-request-token'

/**
 * Browser operations exposed by the Saki Host API.
 * Business outcomes are returned as typed values; cancellation, Connection RPC
 * failures, and invalid outbound payloads reject the returned Promise.
 */
export interface SakiHostClient {
  /**
   * Read the current browser access state.
   * @param signal - optional cancellation.
   * @returns current display-safe Access state.
   */
  readAccess(signal?: AbortSignal): Promise<SakiWireAccessProjection>
  /**
   * Exchange the launcher secret for an authenticated browser session.
   * @param secret - clear one-time launcher secret.
   * @param signal - optional cancellation.
   * @returns exchange outcome.
   */
  exchangeBootstrap(secret: string, signal?: AbortSignal): Promise<SakiWireAccessExchangeResult>
  /**
   * Revoke the current browser session.
   * @param requestToken - current session-derived request token.
   * @param signal - optional cancellation.
   * @returns logout outcome.
   */
  logout(requestToken: string, signal?: AbortSignal): Promise<SakiWireAccessLogoutResult>
  /**
   * Read work assigned to the current Principal.
   * @param signal - optional cancellation.
   * @returns current Principal-scoped My Work.
   */
  queryMyWork(signal?: AbortSignal): Promise<SakiWireMyWorkResult>
  /**
   * Read current Principal-scoped attention items.
   * @param signal - optional cancellation.
   * @returns current Principal-scoped Attention.
   */
  queryAttention(signal?: AbortSignal): Promise<SakiWireAttentionResult>
  /**
   * Read the current revisioned Project index.
   * @param signal - optional cancellation.
   * @returns the revisioned Project index or `denied`/`unavailable`.
   */
  queryProjectIndex(signal?: AbortSignal): Promise<SakiWireProjectIndexResult>
  /**
   * Inspect a selected local project directory.
   * @param hostId - selected enrolled Host.
   * @param directoryLocator - untrusted selected directory.
   * @param signal - optional cancellation.
   * @returns an authorized Projection containing either a safe selection or a
   * bounded selection rejection, or an outer `denied`/`unavailable` result.
   */
  inspectProjectSelection(
    hostId: SakiWireHostId,
    directoryLocator: string,
    signal?: AbortSignal,
  ): Promise<SakiWireInspectProjectSelectionResult>
  /**
   * Read one Development Workspace Projection.
   * @param projectId - stable Project id.
   * @param expectedRegistryRevision - caller-observed registry revision.
   * @param signal - optional cancellation.
   * @returns the current Development Workspace or `denied`, `unavailable`, `stale`, or `not-found`.
   */
  queryDevelopmentWorkspace(
    projectId: SakiWireProjectId,
    expectedRegistryRevision: number,
    signal?: AbortSignal,
  ): Promise<SakiWireDevelopmentWorkspaceResult>
  /**
   * Read one Project's current structured Git status.
   * @param projectId - stable Project id.
   * @param expectedRegistryRevision - caller-observed Registry revision.
   * @param signal - optional cancellation.
   * @returns bounded status evidence or a typed authorization, resolution, or Host failure.
   */
  queryProjectChanges(
    projectId: SakiWireProjectId,
    expectedRegistryRevision: number,
    signal?: AbortSignal,
  ): Promise<SakiWireProjectChangesResult>
  /**
   * Read one bounded file-scoped Diff page without supplying a path.
   * @param projectId - stable Project id.
   * @param expectedRegistryRevision - caller-observed Registry revision.
   * @param request - expected status, opaque change id, layer, and optional cursor.
   * @param signal - optional cancellation.
   * @returns one bounded Diff page or a typed authorization, resolution, or Host failure.
   */
  readProjectDiff(
    projectId: SakiWireProjectId,
    expectedRegistryRevision: number,
    request: SakiWireProjectDiffRequest,
    signal?: AbortSignal,
  ): Promise<SakiWireProjectDiffResult>
  /**
   * Read one Project's GitHub synchronization settings.
   * @param projectId - stable Project id.
   * @param signal - optional cancellation.
   * @returns current safe configuration and activation state, or `denied`, `unavailable`, or `not-found`.
   */
  queryProjectSettings(
    projectId: SakiWireProjectId,
    signal?: AbortSignal,
  ): Promise<SakiWireProjectSettingsResult>
  /**
   * Read one Project's complete Board Projection.
   * @param projectId - stable Project id.
   * @param refresh - `cached` reads durable state only; `interactive` also schedules a durable high-priority scan.
   * @param signal - optional cancellation.
   * @returns current complete Board and synchronization evidence, or `denied`, `unavailable`, or `not-found`.
   */
  queryBoard(
    projectId: SakiWireProjectId,
    refresh: SakiWireBoardRefresh,
    signal?: AbortSignal,
  ): Promise<SakiWireBoardResult>
  /**
   * Read one Work Item's Branch Delivery projection.
   * @param projectId - stable Project id.
   * @param workItemId - stable Work Item id from the Board projection.
   * @param refresh - cached-only or interactive targeted evidence refresh.
   * @param signal - optional cancellation.
   * @returns the browser-safe delivery projection or `denied`/`not-found`.
   */
  queryBranchDelivery(
    projectId: SakiWireProjectId,
    workItemId: SakiWireSaveBranchDeliveryIntent['workItemId'],
    refresh: SakiWireBranchDeliveryRefresh,
    signal?: AbortSignal,
  ): Promise<SakiWireBranchDeliveryResult>
  /**
   * Read one Project Milestone joined to current Board and release sources.
   * @param projectId - stable Project id.
   * @param milestoneId - exact GitHub Milestone node id.
   * @param refresh - cached-only or interactive targeted evidence refresh.
   * @param signal - optional cancellation.
   * @returns the browser-safe Milestone View or `denied`/`not-found`.
   */
  queryMilestoneView(
    projectId: SakiWireProjectId,
    milestoneId: SakiWireSaveMilestoneDeliveryIntent['release']['milestoneId'],
    refresh: SakiWireMilestoneViewRefresh,
    signal?: AbortSignal,
  ): Promise<SakiWireMilestoneViewResult>
  /**
   * Submit a confirmed Project-registration Intent.
   * @param intent - complete confirmed registration Intent.
   * @param requestToken - current session-derived request token.
   * @param signal - optional cancellation.
   * @returns a confirmed receipt or typed `denied`, `unavailable`, `conflict`,
   * `failure`, or `reconciliation-required` result with only phase-valid receipt fields.
   */
  registerDevelopmentProject(
    intent: SakiWireRegisterDevelopmentProjectIntent,
    requestToken: string,
    signal?: AbortSignal,
  ): Promise<SakiWireRegisterDevelopmentProjectResult>
  /**
   * Save one field-scoped GitHub synchronization configuration candidate.
   * @param intent - expected-revision configuration patch.
   * @param requestToken - current session-derived request token.
   * @param signal - optional cancellation.
   * @returns a saved receipt or typed `denied`, `unavailable`, `conflict`, or `failure` result.
   */
  configureGitHubSynchronization(
    intent: SakiWireConfigureGitHubSynchronizationIntent,
    requestToken: string,
    signal?: AbortSignal,
  ): Promise<SakiWireConfigureGitHubSynchronizationResult>
  /**
   * Stage an exact set of opaque rows from one observed Changes Projection.
   * @param intent - revision-fenced, path-free StageFiles Intent.
   * @param requestToken - current session-derived request token.
   * @param signal - optional cancellation.
   * @returns a succeeded receipt or a typed durable/recoverable outcome.
   */
  stageFiles(
    intent: SakiWireStageFilesIntent,
    requestToken: string,
    signal?: AbortSignal,
  ): Promise<SakiWireStageFilesResult>
  /**
   * Unstage an exact set of opaque rows from one observed Changes Projection.
   * @param intent - revision-fenced, path-free UnstageFiles Intent.
   * @param requestToken - current session-derived request token.
   * @param signal - optional cancellation.
   * @returns a succeeded receipt or a typed durable/recoverable outcome.
   */
  unstageFiles(
    intent: SakiWireUnstageFilesIntent,
    requestToken: string,
    signal?: AbortSignal,
  ): Promise<SakiWireUnstageFilesResult>
  /**
   * Create one deterministic hook-free unsigned Commit from observed Git evidence.
   * @param intent - revision-fenced message and Git evidence without identity or ref authority.
   * @param requestToken - current session-derived request token.
   * @param signal - optional cancellation.
   * @returns a succeeded receipt or a typed durable/recoverable outcome.
   */
  createCommit(
    intent: SakiWireCreateCommitIntent,
    requestToken: string,
    signal?: AbortSignal,
  ): Promise<SakiWireCreateCommitResult>
  /**
   * Create one GitHub-backed Work Item from browser-safe product fields.
   * @param intent - revision-fenced creation Intent without provider authority.
   * @param requestToken - current session-derived request token.
   * @param signal - optional cancellation.
   * @returns a succeeded receipt or a typed durable/recoverable outcome.
   */
  createWorkItem(
    intent: SakiWireCreateWorkItemIntent,
    requestToken: string,
    signal?: AbortSignal,
  ): Promise<SakiWireCreateWorkItemResult>
  /**
   * Move one confirmed Work Item using its exact remote fingerprint.
   * @param intent - status and optional Saki-relative placement Intent.
   * @param requestToken - current session-derived request token.
   * @param signal - optional cancellation.
   * @returns a succeeded receipt or a typed durable/recoverable outcome.
   */
  moveWorkItem(
    intent: SakiWireMoveWorkItemIntent,
    requestToken: string,
    signal?: AbortSignal,
  ): Promise<SakiWireMoveWorkItemResult>
  /**
   * Persist the exact Commit selected for Branch Delivery.
   * @param intent - exact Commit selection.
   * @param requestToken - mutation token.
   * @param signal - cancellation.
   * @returns durable delivery outcome.
   */
  saveBranchDelivery(
    intent: SakiWireSaveBranchDeliveryIntent,
    requestToken: string,
    signal?: AbortSignal,
  ): Promise<SakiWireBranchDeliveryIntentResult>
  /**
   * Push the selected delivery Commit through the configured Host.
   * @param intent - exact delivery Push request.
   * @param requestToken - mutation token.
   * @param signal - cancellation.
   * @returns durable delivery outcome.
   */
  pushBranchDelivery(
    intent: SakiWirePushBranchDeliveryIntent,
    requestToken: string,
    signal?: AbortSignal,
  ): Promise<SakiWireBranchDeliveryIntentResult>
  /**
   * Create or recover the Pull Request owned by the delivery marker.
   * @param intent - marker-owned Pull Request request.
   * @param requestToken - mutation token.
   * @param signal - cancellation.
   * @returns durable delivery outcome.
   */
  createBranchDeliveryPullRequest(
    intent: SakiWireCreateBranchDeliveryPullRequestIntent,
    requestToken: string,
    signal?: AbortSignal,
  ): Promise<SakiWireBranchDeliveryIntentResult>
  /**
   * Associate an observed Pull Request with the exact delivery.
   * @param intent - exact observed Pull Request association.
   * @param requestToken - mutation token.
   * @param signal - cancellation.
   * @returns durable delivery outcome.
   */
  associateBranchDeliveryPullRequest(
    intent: SakiWireAssociateBranchDeliveryPullRequestIntent,
    requestToken: string,
    signal?: AbortSignal,
  ): Promise<SakiWireBranchDeliveryIntentResult>
  /**
   * Record the transition of a delivery to review.
   * @param intent - In-review transition.
   * @param requestToken - mutation token.
   * @param signal - cancellation.
   * @returns durable delivery outcome.
   */
  markBranchDeliveryInReview(
    intent: SakiWireMarkBranchDeliveryInReviewIntent,
    requestToken: string,
    signal?: AbortSignal,
  ): Promise<SakiWireBranchDeliveryIntentResult>
  /**
   * Record attributed acceptance of the selected delivery.
   * @param intent - attributed acceptance transition.
   * @param requestToken - mutation token.
   * @param signal - cancellation.
   * @returns durable delivery outcome.
   */
  acceptBranchDelivery(
    intent: SakiWireAcceptBranchDeliveryIntent,
    requestToken: string,
    signal?: AbortSignal,
  ): Promise<SakiWireBranchDeliveryIntentResult>
  /**
   * Persist Milestone metadata and its release target.
   * @param intent - exact Milestone metadata and release target.
   * @param requestToken - mutation token.
   * @param signal - cancellation.
   * @returns durable Milestone Delivery outcome.
   */
  saveMilestoneDelivery(
    intent: SakiWireSaveMilestoneDeliveryIntent,
    requestToken: string,
    signal?: AbortSignal,
  ): Promise<SakiWireMilestoneDeliveryIntentResult>
  /**
   * Finalize the exact Milestone revision and release target.
   * @param intent - exact Milestone revision and release target to finalize.
   * @param requestToken - mutation token.
   * @param signal - cancellation.
   * @returns durable Milestone Delivery outcome.
   */
  finalizeMilestoneDelivery(
    intent: SakiWireFinalizeMilestoneDeliveryIntent,
    requestToken: string,
    signal?: AbortSignal,
  ): Promise<SakiWireMilestoneDeliveryIntentResult>
  /**
   * Start or resume one manual Agent Run for an exact Ready Work Item.
   * @param intent - revision-fenced Work Item command without execution authority.
   * @param requestToken - current session-derived request token.
   * @param signal - optional cancellation.
   * @returns the stable started identities or one typed recoverable outcome.
   */
  giveWorkItemToAgent(
    intent: SakiWireGiveWorkItemToAgentIntent,
    requestToken: string,
    signal?: AbortSignal,
  ): Promise<SakiWireGiveWorkItemToAgentResult>
  /**
   * Answer one open Intervention under its projected revision.
   * @param intent - revision-fenced text answer without Actor or delivery authority.
   * @param requestToken - current session-derived request token.
   * @param signal - optional cancellation.
   * @returns the accepted delivery receipt or one typed recoverable outcome.
   */
  answerIntervention(
    intent: SakiWireAnswerInterventionIntent,
    requestToken: string,
    signal?: AbortSignal,
  ): Promise<SakiWireAnswerInterventionResult>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Typed browser client for Saki Access, Projections, and Control Intents. */
    sakiHostClient: SakiHostClient
  }
}

/** Required Client Connection carrier. */
export const inject = ['connection']

/** Browser Saki client backed by same-origin Connection calls. */
export class SakiHostClientService extends Service implements SakiHostClient {
  private readonly connection: ConnectionHandle

  /** @param ctx - Client context carrying Connection. */
  constructor(ctx: Context) {
    super(ctx, 'sakiHostClient')
    const connection = ctx.get('connection') as ConnectionHandle | undefined
    if (connection === undefined) throw new Error('saki Host client requires the active Connection carrier')
    this.connection = connection
  }

  /** @inheritdoc */
  async readAccess(signal?: AbortSignal): Promise<SakiWireAccessProjection> {
    return sakiAccessProjectionSchema.parse(await this.call('access/read', {}, signal))
  }

  /** @inheritdoc */
  async exchangeBootstrap(secret: string, signal?: AbortSignal): Promise<SakiWireAccessExchangeResult> {
    return sakiAccessExchangeResultSchema.parse(await this.call('access/exchange', { secret }, signal))
  }

  /** @inheritdoc */
  async logout(requestToken: string, signal?: AbortSignal): Promise<SakiWireAccessLogoutResult> {
    return sakiAccessLogoutResultSchema.parse(await this.call(
      'access/logout',
      {},
      signal,
      { [REQUEST_TOKEN_HEADER]: requestToken },
    ))
  }

  /** @inheritdoc */
  async queryMyWork(signal?: AbortSignal): Promise<SakiWireMyWorkResult> {
    return sakiMyWorkResultSchema.parse(await this.call('control/query', { type: 'my-work' }, signal))
  }

  /** @inheritdoc */
  async queryAttention(signal?: AbortSignal): Promise<SakiWireAttentionResult> {
    return sakiAttentionResultSchema.parse(await this.call('control/query', { type: 'attention' }, signal))
  }

  /** @inheritdoc */
  async queryProjectIndex(signal?: AbortSignal): Promise<SakiWireProjectIndexResult> {
    return sakiProjectIndexResultSchema.parse(await this.call('control/query', { type: 'project-index' }, signal))
  }

  /** @inheritdoc */
  async inspectProjectSelection(
    hostId: SakiWireHostId,
    directoryLocator: string,
    signal?: AbortSignal,
  ): Promise<SakiWireInspectProjectSelectionResult> {
    return sakiInspectProjectSelectionResultSchema.parse(await this.call(
      'control/query',
      { type: 'inspect-project-selection', hostId, directoryLocator },
      signal,
    ))
  }

  /** @inheritdoc */
  async queryDevelopmentWorkspace(
    projectId: SakiWireProjectId,
    expectedRegistryRevision: number,
    signal?: AbortSignal,
  ): Promise<SakiWireDevelopmentWorkspaceResult> {
    return sakiDevelopmentWorkspaceResultSchema.parse(await this.call(
      'control/query',
      { type: 'development-workspace', projectId, expectedRegistryRevision },
      signal,
    ))
  }

  /** @inheritdoc */
  async queryProjectChanges(
    projectId: SakiWireProjectId,
    expectedRegistryRevision: number,
    signal?: AbortSignal,
  ): Promise<SakiWireProjectChangesResult> {
    return sakiProjectChangesResultSchema.parse(await this.call(
      'control/query',
      { type: 'project-changes', projectId, expectedRegistryRevision },
      signal,
    ))
  }

  /** @inheritdoc */
  async readProjectDiff(
    projectId: SakiWireProjectId,
    expectedRegistryRevision: number,
    request: SakiWireProjectDiffRequest,
    signal?: AbortSignal,
  ): Promise<SakiWireProjectDiffResult> {
    return sakiProjectDiffResultSchema.parse(await this.call(
      'control/query',
      { type: 'project-diff', projectId, expectedRegistryRevision, request },
      signal,
    ))
  }

  /** @inheritdoc */
  async queryProjectSettings(
    projectId: SakiWireProjectId,
    signal?: AbortSignal,
  ): Promise<SakiWireProjectSettingsResult> {
    return sakiProjectSettingsResultSchema.parse(await this.call(
      'control/query',
      { type: 'project-settings', projectId },
      signal,
    ))
  }

  /** @inheritdoc */
  async queryBoard(
    projectId: SakiWireProjectId,
    refresh: SakiWireBoardRefresh,
    signal?: AbortSignal,
  ): Promise<SakiWireBoardResult> {
    return sakiBoardResultSchema.parse(await this.call(
      'control/query',
      { type: 'board', projectId, refresh },
      signal,
    ))
  }

  /** @inheritdoc */
  async queryBranchDelivery(
    projectId: SakiWireProjectId,
    workItemId: SakiWireSaveBranchDeliveryIntent['workItemId'],
    refresh: SakiWireBranchDeliveryRefresh,
    signal?: AbortSignal,
  ): Promise<SakiWireBranchDeliveryResult> {
    return sakiBranchDeliveryResultSchema.parse(await this.call(
      'control/query',
      { type: 'branch-delivery', projectId, workItemId, refresh },
      signal,
    ))
  }

  /** @inheritdoc */
  async queryMilestoneView(
    projectId: SakiWireProjectId,
    milestoneId: SakiWireSaveMilestoneDeliveryIntent['release']['milestoneId'],
    refresh: SakiWireMilestoneViewRefresh,
    signal?: AbortSignal,
  ): Promise<SakiWireMilestoneViewResult> {
    return sakiMilestoneViewResultSchema.parse(await this.call(
      'control/query',
      { type: 'milestone-view', projectId, milestoneId, refresh },
      signal,
    ))
  }

  /** @inheritdoc */
  async registerDevelopmentProject(
    intent: SakiWireRegisterDevelopmentProjectIntent,
    requestToken: string,
    signal?: AbortSignal,
  ): Promise<SakiWireRegisterDevelopmentProjectResult> {
    return sakiRegisterDevelopmentProjectResultSchema.parse(await this.call(
      'control/submit',
      intent,
      signal,
      { [REQUEST_TOKEN_HEADER]: requestToken },
    ))
  }

  /** @inheritdoc */
  async configureGitHubSynchronization(
    intent: SakiWireConfigureGitHubSynchronizationIntent,
    requestToken: string,
    signal?: AbortSignal,
  ): Promise<SakiWireConfigureGitHubSynchronizationResult> {
    return sakiConfigureGitHubSynchronizationResultSchema.parse(await this.call(
      'control/submit',
      intent,
      signal,
      { [REQUEST_TOKEN_HEADER]: requestToken },
    ))
  }

  /** @inheritdoc */
  async stageFiles(
    intent: SakiWireStageFilesIntent,
    requestToken: string,
    signal?: AbortSignal,
  ): Promise<SakiWireStageFilesResult> {
    return sakiStageFilesResultSchema.parse(await this.call(
      'control/submit',
      intent,
      signal,
      { [REQUEST_TOKEN_HEADER]: requestToken },
    ))
  }

  /** @inheritdoc */
  async unstageFiles(
    intent: SakiWireUnstageFilesIntent,
    requestToken: string,
    signal?: AbortSignal,
  ): Promise<SakiWireUnstageFilesResult> {
    return sakiUnstageFilesResultSchema.parse(await this.call(
      'control/submit',
      intent,
      signal,
      { [REQUEST_TOKEN_HEADER]: requestToken },
    ))
  }

  /** @inheritdoc */
  async createCommit(
    intent: SakiWireCreateCommitIntent,
    requestToken: string,
    signal?: AbortSignal,
  ): Promise<SakiWireCreateCommitResult> {
    return sakiCreateCommitResultSchema.parse(await this.call(
      'control/submit',
      intent,
      signal,
      { [REQUEST_TOKEN_HEADER]: requestToken },
    ))
  }

  /** @inheritdoc */
  async createWorkItem(
    intent: SakiWireCreateWorkItemIntent,
    requestToken: string,
    signal?: AbortSignal,
  ): Promise<SakiWireCreateWorkItemResult> {
    return sakiCreateWorkItemResultSchema.parse(await this.call(
      'control/submit',
      intent,
      signal,
      { [REQUEST_TOKEN_HEADER]: requestToken },
    ))
  }

  /** @inheritdoc */
  async moveWorkItem(
    intent: SakiWireMoveWorkItemIntent,
    requestToken: string,
    signal?: AbortSignal,
  ): Promise<SakiWireMoveWorkItemResult> {
    return sakiMoveWorkItemResultSchema.parse(await this.call(
      'control/submit',
      intent,
      signal,
      { [REQUEST_TOKEN_HEADER]: requestToken },
    ))
  }

  /** @inheritdoc */
  async saveBranchDelivery(
    intent: SakiWireSaveBranchDeliveryIntent,
    requestToken: string,
    signal?: AbortSignal,
  ): Promise<SakiWireBranchDeliveryIntentResult> {
    return await this.submitBranchDelivery(intent, requestToken, signal)
  }

  /** @inheritdoc */
  async pushBranchDelivery(
    intent: SakiWirePushBranchDeliveryIntent,
    requestToken: string,
    signal?: AbortSignal,
  ): Promise<SakiWireBranchDeliveryIntentResult> {
    return await this.submitBranchDelivery(intent, requestToken, signal)
  }

  /** @inheritdoc */
  async createBranchDeliveryPullRequest(
    intent: SakiWireCreateBranchDeliveryPullRequestIntent,
    requestToken: string,
    signal?: AbortSignal,
  ): Promise<SakiWireBranchDeliveryIntentResult> {
    return await this.submitBranchDelivery(intent, requestToken, signal)
  }

  /** @inheritdoc */
  async associateBranchDeliveryPullRequest(
    intent: SakiWireAssociateBranchDeliveryPullRequestIntent,
    requestToken: string,
    signal?: AbortSignal,
  ): Promise<SakiWireBranchDeliveryIntentResult> {
    return await this.submitBranchDelivery(intent, requestToken, signal)
  }

  /** @inheritdoc */
  async markBranchDeliveryInReview(
    intent: SakiWireMarkBranchDeliveryInReviewIntent,
    requestToken: string,
    signal?: AbortSignal,
  ): Promise<SakiWireBranchDeliveryIntentResult> {
    return await this.submitBranchDelivery(intent, requestToken, signal)
  }

  /** @inheritdoc */
  async acceptBranchDelivery(
    intent: SakiWireAcceptBranchDeliveryIntent,
    requestToken: string,
    signal?: AbortSignal,
  ): Promise<SakiWireBranchDeliveryIntentResult> {
    return await this.submitBranchDelivery(intent, requestToken, signal)
  }

  /** @inheritdoc */
  async saveMilestoneDelivery(
    intent: SakiWireSaveMilestoneDeliveryIntent,
    requestToken: string,
    signal?: AbortSignal,
  ): Promise<SakiWireMilestoneDeliveryIntentResult> {
    return await this.submitMilestoneDelivery(intent, requestToken, signal)
  }

  /** @inheritdoc */
  async finalizeMilestoneDelivery(
    intent: SakiWireFinalizeMilestoneDeliveryIntent,
    requestToken: string,
    signal?: AbortSignal,
  ): Promise<SakiWireMilestoneDeliveryIntentResult> {
    return await this.submitMilestoneDelivery(intent, requestToken, signal)
  }

  /** @inheritdoc */
  async giveWorkItemToAgent(
    intent: SakiWireGiveWorkItemToAgentIntent,
    requestToken: string,
    signal?: AbortSignal,
  ): Promise<SakiWireGiveWorkItemToAgentResult> {
    return sakiGiveWorkItemToAgentResultSchema.parse(await this.call(
      'control/submit',
      intent,
      signal,
      { [REQUEST_TOKEN_HEADER]: requestToken },
    ))
  }

  /** @inheritdoc */
  async answerIntervention(
    intent: SakiWireAnswerInterventionIntent,
    requestToken: string,
    signal?: AbortSignal,
  ): Promise<SakiWireAnswerInterventionResult> {
    return sakiAnswerInterventionResultSchema.parse(await this.call(
      'control/submit',
      intent,
      signal,
      { [REQUEST_TOKEN_HEADER]: requestToken },
    ))
  }

  private async submitBranchDelivery(
    intent: SakiWireBranchDeliveryIntent,
    requestToken: string,
    signal?: AbortSignal,
  ): Promise<SakiWireBranchDeliveryIntentResult> {
    return sakiBranchDeliveryIntentResultSchema.parse(await this.call(
      'control/submit',
      intent,
      signal,
      { [REQUEST_TOKEN_HEADER]: requestToken },
    ))
  }

  private async submitMilestoneDelivery(
    intent: SakiWireMilestoneDeliveryIntent,
    requestToken: string,
    signal?: AbortSignal,
  ): Promise<SakiWireMilestoneDeliveryIntentResult> {
    return sakiMilestoneDeliveryIntentResultSchema.parse(await this.call(
      'control/submit',
      intent,
      signal,
      { [REQUEST_TOKEN_HEADER]: requestToken },
    ))
  }

  private async call(
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
    headers?: Readonly<Record<string, string>>,
  ): Promise<unknown> {
    const result = await this.connection.rpc.call(CHANNEL, endpoint, payload, {
      credentials: 'same-origin',
      ...(signal === undefined ? {} : { signal }),
      ...(headers === undefined ? {} : { headers }),
    })
    if (!result.ok) throw new Error(`Saki Host request failed: ${result.error.code}`)
    return result.value
  }
}

export default SakiHostClientService
