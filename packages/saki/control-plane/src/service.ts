/**
 * Deep Saki control-plane module for Installation access, Projects, Git operations, and GitHub synchronization.
 * @module @breakfastdapaidang/saki-control-plane/src/service
 */

import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { isLoopbackHostname } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-llm'
import type { Domain, DomainChanged, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@breakfastdapaidang/saki-execution'
import { SakiAuthenticationContext } from './authentication.ts'
import type {
  SakiAuthenticationRequest,
  SakiAuthenticationResolution,
} from './authentication.ts'
import {
  CONTROL_STATE_KEY,
  DEVELOPMENT_PROJECT_REGISTRY_KEY,
  configureGitHubSynchronizationIntentSchema,
  createWorkItemIntentSchema,
  createCommitIntentSchema,
  giveWorkItemToAgentIntentSchema,
  githubWorkItemRecoveryId,
  githubWorkItemRecoveryRecordSchema,
  HOST_OPERATOR_ACTIONS,
  moveWorkItemIntentSchema,
  registerDevelopmentProjectIntentSchema,
  sakiControlPlaneDomainSpec,
  stageFilesIntentSchema,
  unstageFilesIntentSchema,
} from './spec.ts'
import type {
  BootstrapChallengeRecord,
  BrowserSessionRecord,
  ControlIntentActor,
  ControlStateRecord,
  GrantRecord,
  HostRecord,
  InstallationAccessRecord,
  InstallationRecord,
  PrincipalRecord,
  DevelopmentProjectRegistryRecord,
  RegistrationActor,
  RegistrationIntentRecord,
} from './spec.ts'
import {
  baselineMatches,
  DevelopmentProjects,
  recoverableRegistrationAdmissionBindingIds,
} from './projects.ts'
import {
  GitOperations,
  type BindingWriteAdmissionTable,
  type GitOperationIntentTable,
} from './git-operations.ts'
import {
  GitHubProjectSynchronization,
  GitHubSynchronizationConsumer,
  type GitHubProjectSyncTable,
  type GitHubSynchronizationConfigurationIntentTable,
} from './github-sync.ts'
import {
  GitHubWorkItemOperations,
  type GitHubWorkItemIntentTable,
  type GitHubWorkItemRecoveryTable,
} from './work-item-operations.ts'
import {
  AgentOperations,
  type AgentOperationIntentTable,
  type AgentRunTable,
  type ExecutionDispatchTable,
  type WorkAssignmentTable,
  type WorkSessionTable,
} from './agent-operations.ts'
import {
  bootstrapDigest,
  constantTimeTextEqual,
  cookieDigest,
  deriveRequestToken,
  generateCredential,
  registerCookieHeader,
  SakiBootstrapHandoff,
} from './secrets.ts'
import type {
  AccessProjection,
  SakiAccessExchangeResult,
  SakiAccessLogoutResult,
  SakiBootstrapChallengeId,
  SakiBootstrapChallengePurpose,
  SakiBootstrapExchangeRequest,
  SakiBootstrapTransportContext,
  SakiBrowserSessionId,
  SakiChangedDisposer,
  SakiGrantId,
  SakiHostId,
  SakiInstallationAccessId,
  SakiInstallationId,
  SakiInstallationIdentity,
  SakiIntentReceipt,
  SakiPrincipalId,
  SakiProjectionKey,
  SakiQuery,
  SakiQueryMap,
  SakiQueryResult,
  RegisterDevelopmentProjectIntent,
  SakiControlIntentId,
  SakiIntent,
  ConfigureGitHubSynchronizationIntent,
  CreateWorkItemIntent,
  CreateCommitIntent,
  GiveWorkItemToAgentIntent,
  SakiGitOperationIntent,
  SakiGitOperationIntentReceipt,
  SakiGiveWorkItemToAgentIntentReceipt,
  SakiWorkItemIntentReceipt,
  StageFilesIntent,
  MoveWorkItemIntent,
  UnstageFilesIntent,
} from './types.ts'
import { enqueueKeyedOperation } from './keyed-operation.ts'
import type { SakiInstallationState } from './installation-state.ts'
import {
  assertRegistrationActorReference,
  validateCurrentSakiState,
  validateInstallationAccessRecord,
} from './state-validation.ts'
import { sakiStorageGenerationDomainSpec } from './state-version.ts'

type SakiWorkItemIntent = CreateWorkItemIntent | MoveWorkItemIntent

async function closeOpenedDomains(
  domains: readonly { close(): Promise<void> }[],
  message: string,
): Promise<void> {
  const results = await Promise.allSettled(domains.map(domain => domain.close()))
  const failures: unknown[] = []
  for (const result of results) {
    if (result.status === 'rejected') failures.push(result.reason as unknown)
  }
  if (failures.length === 1) {
    const failure = failures[0]
    throw failure instanceof Error ? failure : new Error(message, { cause: failure })
  }
  if (failures.length > 1) throw new AggregateError(failures, message)
}

function validateDisjointControlIntentIds(
  ...collections: readonly (readonly { readonly id: SakiControlIntentId }[])[]
): void {
  const ids = new Set<SakiControlIntentId>()
  for (const collection of collections) {
    for (const intent of collection) {
      if (ids.has(intent.id)) {
        throw new Error(`Saki Control Intent '${intent.id}' is retained by multiple Intent kinds`)
      }
      ids.add(intent.id)
    }
  }
}

/** Composition configuration for local Saki access. */
export interface Config {
  /** Exact loopback browser origin accepted by every access mutation. */
  origin: string
  /** Lifetime of a clear one-time local sign-in handoff. */
  challengeTtlMs?: number
  /** Lifetime of one server-owned Browser Session. */
  sessionTtlMs?: number
  /** Minimum retention of terminal challenge and session evidence. */
  terminalRetentionMs?: number
  /** Cookie name used only by the trusted Host transport. */
  cookieName?: string
  /** Maximum lifetime of one durable GitHub complete-scan lease. */
  githubScanAttemptTtlMs?: number
  /** Lifetime of one recoverable Execution Dispatch claim before its fencing token advances. */
  agentDispatchClaimTtlMs?: number
  /** Template copied into the first immutable Agent Profile of each new Project. */
  defaultAgentProfile?: {
    /** Existing DSH Agent Preset mounted for the Project's development runs. */
    agentPresetId: string
    /** Explicit provider/model route; absence leaves agent dispatch unavailable. */
    modelRouteRequest?: {
      provider: string
      model: string
    } | null
  }
}

/** Local launcher channel for one clear initial-bootstrap or reauthentication secret. */
export interface SakiBootstrapLaunch {
  /**
   * Take the process-local sign-in handoff.
   * @returns one opaque handoff, or `undefined` after prior consumption.
   */
  take(): SakiBootstrapHandoff | undefined
}

/** Access operations that own bootstrap and Browser Session lifecycle. */
export interface SakiAccess {
  /**
   * Read closed unauthenticated Access or the current authenticated Access.
   * @param presentedSession - raw cookie credential from trusted transport metadata.
   * @param signal - caller cancellation before a durable mutation begins.
   * @returns display-safe Access Projection.
   */
  readAccess(presentedSession: string | undefined, signal: AbortSignal): Promise<AccessProjection>

  /**
   * Atomically consume one local challenge and create one Browser Session.
   * @param transportContext - trusted Origin metadata.
   * @param request - exact clear-secret request body.
   * @param signal - caller cancellation before the compare-and-set.
   * @returns safe exchange result; Set-Cookie remains in a trusted opaque handoff.
   */
  exchangeBootstrap(
    transportContext: SakiBootstrapTransportContext,
    request: SakiBootstrapExchangeRequest,
    signal: AbortSignal,
  ): Promise<SakiAccessExchangeResult>

  /**
   * Revoke the current Browser Session without consulting Grant authority.
   * @param authentication - trusted server-derived AuthenticationContext.
   * @param requestToken - token freshly derived from the presented cookie.
   * @param signal - caller cancellation before the compare-and-set.
   * @returns safe logout result; cookie expiration remains in a trusted opaque handoff.
   */
  logoutCurrentSession(
    authentication: SakiAuthenticationContext,
    requestToken: string,
    signal: AbortSignal,
  ): Promise<SakiAccessLogoutResult>
}

/** Control-plane operations used by trusted Consumers. */
export interface SakiControlPlaneModule {
  /** Access lifecycle separated from Control Intent authority. */
  readonly access: SakiAccess
  /** Local clear-secret launcher channel. */
  readonly bootstrap: SakiBootstrapLaunch
  /**
   * Read trusted local Installation and current Host identities.
   * @returns stable independent identities.
   */
  identity(): SakiInstallationIdentity

  /**
   * Query one protected Projection after revalidating current authority.
   * @param authentication - trusted server-derived AuthenticationContext.
   * @param query - closed Projection query.
   * @param signal - caller cancellation.
   * @returns the authorized Projection or that query kind's typed `denied`,
   * `unavailable`, `stale`, `not-found`, or `binding-unavailable` failure.
   */
  query<K extends keyof SakiQueryMap>(
    authentication: SakiAuthenticationContext,
    query: SakiQueryMap[K]['request'],
    signal: AbortSignal,
  ): Promise<SakiQueryResult<K>>

  /**
   * Submit one durable Control Intent after current authorization.
   * @param authentication - trusted server-derived AuthenticationContext.
   * @param intent - bounded immutable content for one declared Intent kind.
   * @param signal - caller cancellation.
   * @returns the kind-correlated terminal or recoverable receipt, or a typed
   * `denied`, `unavailable`, `conflict`, `failure`, `canceled`, or
   * `reconciliation-required` result with only phase-valid receipt fields.
   */
  submit<I extends SakiIntent>(
    authentication: SakiAuthenticationContext,
    intent: I,
    signal: AbortSignal,
  ): Promise<SakiIntentReceipt<I['type']>>

  /**
   * Subscribe to contained post-commit Projection invalidations.
   * @param listener - listener that re-queries affected Projection keys.
   * @returns disposer removing the listener.
   */
  onChanged(listener: (keys: readonly SakiProjectionKey[]) => void): SakiChangedDisposer
}

type ControlStateTable = KvTable<typeof CONTROL_STATE_KEY, ControlStateRecord>
type InstallationTable = KvTable<SakiInstallationId, InstallationRecord>
type HostTable = KvTable<SakiHostId, HostRecord>
type PrincipalTable = KvTable<SakiPrincipalId, PrincipalRecord>
type GrantTable = KvTable<SakiGrantId, GrantRecord>
type AccessTable = KvTable<SakiInstallationAccessId, InstallationAccessRecord>
type ProjectRegistryTable = KvTable<typeof DEVELOPMENT_PROJECT_REGISTRY_KEY, DevelopmentProjectRegistryRecord>
type RegistrationIntentTable = KvTable<SakiControlIntentId, RegistrationIntentRecord>

interface CurrentFoundation {
  readonly control: ControlStateRecord
  readonly installation: InstallationRecord
  readonly host: HostRecord
  readonly principal: PrincipalRecord
  readonly grant: GrantRecord
}

class AccessUnavailable extends Error {}
class AccessCasConflict extends Error {}

const BOOTSTRAP_REQUIRED: AccessProjection = Object.freeze({
  kind: 'bootstrap-required',
  message: 'Local bootstrap is required.',
})
const SESSION_REQUIRED: AccessProjection = Object.freeze({
  kind: 'session-required',
  message: 'A local browser session is required.',
})

/** Concrete single-writer Saki control plane. */
export class SakiControlPlaneService extends Service implements SakiControlPlaneModule {
  static inject = ['storageDomain', 'sakiInstallationState', 'sakiHostExecution', 'workspaceRegistry']
  static Config: z<Config> = z.object({
    origin: z.string().required(),
    challengeTtlMs: z.natural().min(1).default(15 * 60 * 1_000),
    sessionTtlMs: z.natural().min(1).default(12 * 60 * 60 * 1_000),
    terminalRetentionMs: z.natural().min(1).default(7 * 24 * 60 * 60 * 1_000),
    cookieName: z.string().pattern(/^[A-Za-z0-9_]+$/).default('saki_session'),
    githubScanAttemptTtlMs: z.natural().min(1_000).max(86_400_000).default(5 * 60 * 1_000),
    agentDispatchClaimTtlMs: z.natural().min(1_000).max(5 * 60 * 1_000).default(30_000),
    defaultAgentProfile: z.object({
      agentPresetId: z.string().min(1).max(200).pattern(/^[a-z0-9][a-z0-9-]*$/).default('standard'),
      modelRouteRequest: z.union([
        z.const(null),
        z.object({
          provider: z.string().min(1).max(200).required(),
          model: z.string().min(1).max(200).required(),
        }),
      ]).default(null),
    }).default({ agentPresetId: 'standard', modelRouteRequest: null }),
  })

  private controlStateTable!: ControlStateTable
  private installationTable!: InstallationTable
  private hostTable!: HostTable
  private principalTable!: PrincipalTable
  private grantTable!: GrantTable
  private accessTable!: AccessTable
  private projectRegistryTable!: ProjectRegistryTable
  private registrationIntentTable!: RegistrationIntentTable
  private githubProjectSyncTable!: GitHubProjectSyncTable
  private githubSynchronizationConfigurationIntentTable!: GitHubSynchronizationConfigurationIntentTable
  private githubWorkItemIntentTable!: GitHubWorkItemIntentTable
  private githubWorkItemRecoveryTable!: GitHubWorkItemRecoveryTable
  private gitOperationIntentTable!: GitOperationIntentTable
  private bindingWriteAdmissionTable!: BindingWriteAdmissionTable
  private agentOperationIntentTable!: AgentOperationIntentTable
  private workAssignmentTable!: WorkAssignmentTable
  private workSessionTable!: WorkSessionTable
  private agentRunTable!: AgentRunTable
  private executionDispatchTable!: ExecutionDispatchTable
  private projects!: DevelopmentProjects
  private gitOperations!: GitOperations
  private agentOperations!: AgentOperations
  private githubSynchronization!: GitHubProjectSynchronization
  private githubWorkItemOperations!: GitHubWorkItemOperations
  private githubSynchronizationConsumer: GitHubSynchronizationConsumer | undefined
  private pendingBootstrap: SakiBootstrapHandoff | undefined
  private readonly listeners = new Set<(keys: readonly SakiProjectionKey[]) => void>()
  private readonly intentOperationTails = new Map<SakiControlIntentId, Promise<void>>()
  private readonly activeOperations = new Set<Promise<void>>()
  private operationAdmissionOpen = true
  private readonly lifetime = new AbortController()
  private startupSettled: Promise<void> = Promise.resolve()
  private readonly installationState: Readonly<Pick<
    SakiInstallationState,
    'phase' | 'installationId' | 'storageGenerationId' | 'createdByBuildId' | 'activateAfterValidation'
  >>

  /** Access interface with no storage or trusted resolver exposure. */
  readonly access: SakiAccess = {
    readAccess: (presentedSession, signal) => this.runOwnedOperation(
      signal,
      operationSignal => this.readAccess(presentedSession, operationSignal),
    ),
    exchangeBootstrap: (transportContext, request, signal) =>
      this.runOwnedOperation(
        signal,
        operationSignal => this.exchangeBootstrap(transportContext, request, operationSignal),
      ),
    logoutCurrentSession: (authentication, requestToken, signal) =>
      this.runOwnedOperation(
        signal,
        operationSignal => this.logoutCurrentSession(authentication, requestToken, operationSignal),
      ),
  }

  /** Process-local one-shot launcher handoff. */
  readonly bootstrap: SakiBootstrapLaunch = {
    take: () => {
      const handoff = this.pendingBootstrap
      this.pendingBootstrap = undefined
      return handoff
    },
  }

  /** @param ctx - owning Cordis context. @param config - resolved access configuration. */
  constructor(ctx: Context, private readonly config: Required<Config>) {
    super(ctx, 'sakiControlPlane')
    this.installationState = Object.freeze({
      phase: ctx.sakiInstallationState.phase,
      installationId: ctx.sakiInstallationState.installationId,
      storageGenerationId: ctx.sakiInstallationState.storageGenerationId,
      createdByBuildId: ctx.sakiInstallationState.createdByBuildId,
      activateAfterValidation: signal => ctx.sakiInstallationState.activateAfterValidation(signal),
    })
    const parsed = new URL(config.origin)
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.origin !== config.origin) {
      throw new Error('saki control plane origin must be one exact HTTP(S) origin without a path')
    }
    if (!isLoopbackHostname(parsed.hostname)) {
      throw new Error('saki control plane origin must be a loopback origin')
    }
    ctx.on('domain/changed', (change: DomainChanged) => {
      if (change.domain !== sakiControlPlaneDomainSpec.name) return
      if (change.table === 'registration_intents' || change.table === 'github_sync_configuration_intents'
        || change.table === 'git_operation_intents' || change.table === 'agent_operation_intents'
        || change.table === 'work_assignments' || change.table === 'work_sessions'
        || change.table === 'agent_runs' || change.table === 'execution_dispatches') return
      if (change.table === 'github_work_item_intents' || change.table === 'github_work_item_recovery') {
        this.notify(['board'])
        return
      }
      if (change.table === 'binding_write_admissions') {
        this.notify(['project-changes'])
        return
      }
      if (change.table === 'github_project_sync') {
        this.githubSynchronizationConsumer?.wake()
        this.notify(['project-settings', 'board'])
        return
      }
      if (change.table === 'development_project_registry') {
        this.notify(['project-index', 'development-workspace', 'project-changes'])
        return
      }
      this.notify(['access', 'project-index', 'development-workspace', 'project-changes'])
    })
    ctx.effect(() => () => {
      this.listeners.clear()
      this.pendingBootstrap = undefined
    }, 'saki-control-plane.processState')
  }

  /** Open, resume, validate, and reconcile the single Installation domain. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(sakiControlPlaneDomainSpec)
    let storageGenerationDomain: Domain<typeof sakiStorageGenerationDomainSpec>
    try {
      storageGenerationDomain = await this.ctx.storageDomain.open(sakiStorageGenerationDomainSpec)
    } catch (error) {
      try {
        await domain.close()
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          'opening Saki storage-generation state and closing its control-plane domain failed',
        )
      }
      throw error instanceof Error
        ? error
        : new Error('opening Saki storage-generation state failed', { cause: error })
    }
    let gitOperationsForDisposal: GitOperations | undefined
    let workItemOperationsForDisposal: GitHubWorkItemOperations | undefined
    let agentOperationsForDisposal: AgentOperations | undefined
    this.ctx.effect(() => async () => {
      this.operationAdmissionOpen = false
      this.lifetime.abort(new Error('saki control plane is disposing'))
      await Promise.all([
        this.startupSettled,
        ...this.activeOperations,
        ...this.intentOperationTails.values(),
        gitOperationsForDisposal?.dispose() ?? Promise.resolve(),
        workItemOperationsForDisposal?.dispose() ?? Promise.resolve(),
        agentOperationsForDisposal?.dispose() ?? Promise.resolve(),
      ])
      await closeOpenedDomains(
        [domain, storageGenerationDomain],
        'closing Saki product-state domains failed',
      )
    }, 'saki-control-plane.domainClose')
    this.controlStateTable = domain.table('control_state')
    this.installationTable = domain.table('installations')
    this.hostTable = domain.table('hosts')
    this.principalTable = domain.table('principals')
    this.grantTable = domain.table('grants')
    this.accessTable = domain.table('installation_access')
    this.projectRegistryTable = domain.table('development_project_registry')
    this.registrationIntentTable = domain.table('registration_intents')
    this.githubProjectSyncTable = domain.table('github_project_sync')
    this.githubSynchronizationConfigurationIntentTable = domain.table('github_sync_configuration_intents')
    this.githubWorkItemIntentTable = domain.table('github_work_item_intents')
    this.githubWorkItemRecoveryTable = domain.table('github_work_item_recovery')
    this.gitOperationIntentTable = domain.table('git_operation_intents')
    this.bindingWriteAdmissionTable = domain.table('binding_write_admissions')
    this.agentOperationIntentTable = domain.table('agent_operation_intents')
    this.workAssignmentTable = domain.table('work_assignments')
    this.workSessionTable = domain.table('work_sessions')
    this.agentRunTable = domain.table('agent_runs')
    this.executionDispatchTable = domain.table('execution_dispatches')

    let settleStartup!: () => void
    this.startupSettled = new Promise((resolve) => { settleStartup = resolve })
    try {
      let control = this.controlStateTable.get(CONTROL_STATE_KEY)
      if (control === undefined) {
        if (this.installationState.phase !== 'provisioning') {
          throw new Error('saki ready storage generation is missing control state')
        }
        this.assertEmptyUnprovisionedDomain()
        control = this.createControlState()
        await this.controlStateTable.put(CONTROL_STATE_KEY, control)
      } else if (this.controlStateTable.size !== 1) {
        throw new Error('saki control plane has unexpected provisioning owner records')
      }

      this.assertControlInstallationState(control)

      if (control.phase === 'provisioning') {
        if (this.installationState.phase !== 'provisioning') {
          throw new Error('saki ready storage generation contains unfinished provisioning')
        }
        await this.resumeProvisioning(control)
      }
      this.requireFoundation()
      this.validateAccess(this.requireAccess())
      this.projects = new DevelopmentProjects({
        registryTable: this.projectRegistryTable,
        intentTable: this.registrationIntentTable,
        execution: this.ctx.sakiHostExecution,
        workspaces: this.ctx.workspaceRegistry,
        authorityCurrent: actor => this.intentAuthorityCurrent(actor, 'development-project:register'),
        validateActorReference: (actor) => {
          this.validateRegistrationActorReference(actor)
        },
        defaultAgentProfileTemplate: {
          agentPresetId: this.config.defaultAgentProfile.agentPresetId,
          modelRouteRequest: this.config.defaultAgentProfile.modelRouteRequest ?? null,
        },
        ensureBindingWriteAdmission: binding => this.gitOperations.ensureBindingWriteAdmission(binding),
      })
      const projects = this.projects.validateDurableState()
      this.githubSynchronization = new GitHubProjectSynchronization({
        syncTable: this.githubProjectSyncTable,
        intentTable: this.githubSynchronizationConfigurationIntentTable,
        workItemRecovery: (projectId, workItemId) => {
          const value = this.githubWorkItemRecoveryTable.get(githubWorkItemRecoveryId(projectId, workItemId))
          if (value === undefined) return undefined
          const recovery = githubWorkItemRecoveryRecordSchema.parse(value)
          const observation = recovery.confirmed.observation
          return {
            latestNonTerminalStatus: recovery.latestNonTerminalStatus,
            observedAt: observation.observedAt,
            repositoryId: observation.facts.repositoryId,
            repositoryDatabaseId: observation.facts.repositoryDatabaseId,
            projectId: observation.facts.projectId,
            statusFieldId: observation.facts.statusFieldId,
          }
        },
        installationId: this.installationState.installationId,
        projectExists: projectId => this.projects.registry().projects.some(project => project.id === projectId),
        authorityCurrent: actor => this.intentAuthorityCurrent(actor, 'github-synchronization:configure'),
        validateActorReference: (actor) => { this.validateRegistrationActorReference(actor) },
      })
      const githubSynchronization = this.githubSynchronization.validateDurableState()
      this.githubWorkItemOperations = new GitHubWorkItemOperations({
        intentTable: this.githubWorkItemIntentTable,
        recoveryTable: this.githubWorkItemRecoveryTable,
        mutationContext: projectId => this.githubSynchronization.mutationContext(projectId),
        projectRevision: (projectId) => {
          const project = this.projects.registry().projects.find(candidate => candidate.id === projectId)
          return project?.revision ?? 'not-found'
        },
        authorityCurrent: (actor, action) => this.intentAuthorityCurrent(actor, action),
        validateActorReference: (actor) => { this.validateRegistrationActorReference(actor) },
        requestScan: async (projectId) => {
          await this.githubSynchronization.requestScan(
            projectId,
            'interactive',
            'interactive',
            Date.now(),
            this.lifetime.signal,
          )
          this.githubSynchronizationConsumer?.wake()
        },
        notifyChanged: () => { this.notify(['project-settings', 'board']) },
        reportUnexpectedFailure: (error) => {
          this.ctx.logger.error(`Saki GitHub Work Item recovery failed: ${String(error)}`)
        },
        lifetime: this.lifetime.signal,
      })
      workItemOperationsForDisposal = this.githubWorkItemOperations
      const workItemOtherIntentIds = new Set([
        ...projects.intents.map(intent => intent.id),
        ...githubSynchronization.intents.map(intent => intent.id),
      ])
      const workItems = this.githubWorkItemOperations.validateDurableState(workItemOtherIntentIds)
      this.gitOperations = new GitOperations({
        intentTable: this.gitOperationIntentTable,
        admissionTable: this.bindingWriteAdmissionTable,
        execution: this.ctx.sakiHostExecution,
        projects: this.projects,
        authorityCurrent: (actor, action) => this.intentAuthorityCurrent(actor, action),
        validateActorReference: (actor) => { this.validateRegistrationActorReference(actor) },
        notifyChanged: () => { this.notify(['project-changes']) },
        lifetime: this.lifetime.signal,
      })
      gitOperationsForDisposal = this.gitOperations
      const otherIntentIds = new Set([
        ...projects.intents.map(intent => intent.id),
        ...githubSynchronization.intents.map(intent => intent.id),
        ...workItems.intents.map(intent => intent.id),
      ])
      const recoverableMissingBindingIds = recoverableRegistrationAdmissionBindingIds(
        projects.registry,
        projects.intents,
      )
      const gitOperations = this.gitOperations.validateDurableState(
        otherIntentIds,
        projects.registry,
        recoverableMissingBindingIds,
      )
      this.agentOperations = new AgentOperations({
        intentTable: this.agentOperationIntentTable,
        assignmentTable: this.workAssignmentTable,
        workSessionTable: this.workSessionTable,
        agentRunTable: this.agentRunTable,
        dispatchTable: this.executionDispatchTable,
        admissionTable: this.bindingWriteAdmissionTable,
        execution: this.ctx.sakiHostExecution,
        projects: this.projects,
        mutationContext: projectId => this.githubSynchronization.mutationContext(projectId),
        authorityCurrent: (actor, action) => this.intentAuthorityCurrent(actor, action),
        validateActorReference: (actor) => { this.validateRegistrationActorReference(actor) },
        resolveModelRoute: async (route, signal) => {
          const llm = this.ctx.get('llm')
          if (llm === undefined) throw new Error('Saki Agent dispatch requires an LLM runtime')
          await llm.resolveModelInfo(route.provider, route.model, signal)
        },
        moveWorkItem: async (intent, actor, signal) => {
          if (this.hasControlIntentConflict(intent.intentId, 'work-item')) {
            return { ok: false, reason: 'conflict' }
          }
          return await this.githubWorkItemOperations.submit(intent, actor, signal)
        },
        claimTtlMs: this.config.agentDispatchClaimTtlMs,
        notifyChanged: () => { this.notify(['project-changes', 'board']) },
        lifetime: this.lifetime.signal,
      })
      agentOperationsForDisposal = this.agentOperations
      const agentOperations = this.agentOperations.validateDurableState(
        new Set([
          ...otherIntentIds,
          ...gitOperations.intents.map(intent => intent.id),
        ]),
        projects.registry,
      )
      validateDisjointControlIntentIds(
        projects.intents,
        githubSynchronization.intents,
        workItems.intents,
        gitOperations.intents,
        agentOperations.intents,
      )
      validateCurrentSakiState(
        domain,
        storageGenerationDomain,
        this.installationState.installationId,
        this.installationState.storageGenerationId,
        this.installationState.createdByBuildId,
      )
      await this.reconcileAccess(Date.now())
      await this.projects.initializeValidated(projects, this.lifetime.signal)
      const disposeHostOperationChanges = this.ctx.sakiHostExecution.onChanged(
        (change) => {
          this.gitOperations.hostChanged(change)
          this.agentOperations.hostChanged(change)
        },
      )
      this.ctx.effect(() => disposeHostOperationChanges, 'saki-control-plane.hostOperationChanges')
      await this.gitOperations.initializeValidated(gitOperations)
      await this.agentOperations.initializeValidated(agentOperations)
      await this.githubSynchronization.initializeValidated(githubSynchronization, this.lifetime.signal)
      await this.githubWorkItemOperations.initializeValidated(workItems)
      this.lifetime.signal.throwIfAborted()
      await this.issueStartupChallenge()
      await this.installationState.activateAfterValidation(this.lifetime.signal)
      this.installGitHubSynchronizationConsumer()
    } finally {
      settleStartup()
    }
  }

  /** @returns stable Installation and independently enrolled current Host identities. */
  identity(): SakiInstallationIdentity {
    const foundation = this.requireFoundation()
    return { installationId: foundation.installation.id, hostId: foundation.host.id }
  }

  /**
   * Resolve trusted authentication for the Host adapter; never a wire operation.
   * @param presentedSession - raw cookie credential extracted by the Host adapter.
   * @param request - trusted transport facts for the protected operation.
   * @param signal - caller cancellation before reconciliation.
   * @returns trusted authentication or a generic unavailable result.
   */
  async resolveAuthentication(
    presentedSession: string | undefined,
    request: SakiAuthenticationRequest,
    signal: AbortSignal,
  ): Promise<SakiAuthenticationResolution> {
    return await this.runOwnedOperation(signal, async (operationSignal) => {
      operationSignal.throwIfAborted()
      if (presentedSession === undefined) return { ok: false, reason: 'unavailable' }
      const authenticated = await this.authenticateCookie(presentedSession)
      operationSignal.throwIfAborted()
      if (authenticated === undefined) return { ok: false, reason: 'unavailable' }
      if (request.mutation) {
        if (request.origin !== this.config.origin
          || !authenticated.matchesRequestToken(request.requestToken ?? '')) {
          return { ok: false, reason: 'unavailable' }
        }
      }
      return { ok: true, authentication: authenticated }
    })
  }

  /**
   * Read the configured cookie name for the trusted Host adapter.
   * @returns the configured cookie name.
   */
  sessionCookieName(): string {
    return this.config.cookieName
  }

  /** @inheritdoc */
  async query<K extends keyof SakiQueryMap>(
    authentication: SakiAuthenticationContext,
    query: SakiQueryMap[K]['request'],
    signal: AbortSignal,
  ): Promise<SakiQueryResult<K>> {
    return await this.runOwnedOperation(signal, async (operationSignal) => {
      const result = await this.queryCurrent(authentication, query, operationSignal)
      return result as SakiQueryResult<K>
    })
  }

  private async queryCurrent(
    authentication: SakiAuthenticationContext,
    query: SakiQuery,
    signal: AbortSignal,
  ): Promise<SakiQueryResult> {
    signal.throwIfAborted()
    switch (query.type) {
      case 'inspect-project-selection': {
        if (!this.authorized(authentication, 'inspect-project-selection')
          || query.hostId !== this.requireFoundation().host.id) {
          return { ok: false, reason: 'denied' }
        }
        const result = await this.ctx.sakiHostExecution.inspectProjectSelection({
          hostId: query.hostId,
          directoryLocator: query.directoryLocator,
        }, signal)
        signal.throwIfAborted()
        return {
          ok: true,
          projection: {
            type: 'inspect-project-selection',
            result: result.ok
              ? { ok: true, selection: result.inspection.projection }
              : result,
          },
        }
      }
      case 'project-index': {
        if (!this.authorized(authentication, 'project-index:read')) return { ok: false, reason: 'denied' }
        const host = this.requireFoundation().host
        return {
          ok: true,
          projection: this.projects.projectIndex({ id: host.id, revision: host.revision, state: 'enrolled' }),
        }
      }
      case 'development-workspace': {
        if (!this.authorized(authentication, 'development-workspace:read')) return { ok: false, reason: 'denied' }
        const projection = this.projects.developmentWorkspace(query.projectId, query.expectedRegistryRevision)
        return typeof projection === 'string'
          ? { ok: false, reason: projection }
          : { ok: true, projection }
      }
      case 'project-changes': {
        if (!this.authorized(authentication, 'project-changes:read')) return { ok: false, reason: 'denied' }
        const resolved = this.projects.activeBinding(query.projectId, query.expectedRegistryRevision)
        if (typeof resolved === 'string') return { ok: false, reason: resolved }
        const result = await this.ctx.sakiHostExecution.inspectProject({ binding: resolved.binding }, signal)
        signal.throwIfAborted()
        if (!this.authorized(authentication, 'project-changes:read')) return { ok: false, reason: 'denied' }
        const current = this.projects.activeBinding(query.projectId, query.expectedRegistryRevision)
        if (typeof current === 'string') return { ok: false, reason: current }
        return {
          ok: true,
          projection: {
            type: 'project-changes',
            registryRevision: resolved.registryRevision,
            projectId: resolved.projectId,
            projectRevision: resolved.projectRevision,
            result: result.ok
              ? { ok: true, observation: result.observation }
              : result,
            gitOperations: this.gitOperations.project(resolved.binding.id, result, {
              'project-changes:stage': this.authorized(authentication, 'project-changes:stage'),
              'project-changes:unstage': this.authorized(authentication, 'project-changes:unstage'),
              'project-commit:create': this.authorized(authentication, 'project-commit:create'),
            }),
          },
        }
      }
      case 'project-diff': {
        if (!this.authorized(authentication, 'project-diff:read')) return { ok: false, reason: 'denied' }
        const resolved = this.projects.activeBinding(query.projectId, query.expectedRegistryRevision)
        if (typeof resolved === 'string') return { ok: false, reason: resolved }
        const result = await this.ctx.sakiHostExecution.readDiff(resolved.binding, query.request, signal)
        signal.throwIfAborted()
        if (!this.authorized(authentication, 'project-diff:read')) return { ok: false, reason: 'denied' }
        const current = this.projects.activeBinding(query.projectId, query.expectedRegistryRevision)
        if (typeof current === 'string') return { ok: false, reason: current }
        return {
          ok: true,
          projection: {
            type: 'project-diff',
            registryRevision: resolved.registryRevision,
            projectId: resolved.projectId,
            projectRevision: resolved.projectRevision,
            result,
          },
        }
      }
      case 'project-settings': {
        if (!this.authorized(authentication, 'project-settings:read')) return { ok: false, reason: 'denied' }
        const projection = this.githubSynchronization.projectSettings(query.projectId)
        if (projection === 'not-found') return { ok: false, reason: 'not-found' }
        const workItems = this.githubWorkItemOperations.project(
          query.projectId,
          undefined,
          projection.synchronization.effectiveMutationAvailability,
          {
            'work-item:create': this.authorized(authentication, 'work-item:create'),
            'work-item:move': this.authorized(authentication, 'work-item:move'),
          },
        )
        return {
          ok: true,
          projection: {
            ...projection,
            synchronization: {
              ...projection.synchronization,
              effectiveMutationAvailability: workItems.effectiveMutationAvailability,
            },
          },
        }
      }
      case 'board': {
        if (!this.authorized(authentication, 'board:read')) return { ok: false, reason: 'denied' }
        if (query.refresh === 'interactive') {
          const scheduled = await this.githubSynchronization.requestScan(
            query.projectId,
            'interactive',
            'interactive',
            Date.now(),
            signal,
          )
          if (scheduled === 'not-found') return { ok: false, reason: 'not-found' }
          this.githubSynchronizationConsumer?.wake()
        }
        const projection = this.githubSynchronization.board(query.projectId)
        if (projection === 'not-found') return { ok: false, reason: 'not-found' }
        return {
          ok: true,
          projection: {
            ...projection,
            ...this.githubWorkItemOperations.project(
              query.projectId,
              projection.confirmed,
              projection.effectiveMutationAvailability,
              {
                'work-item:create': this.authorized(authentication, 'work-item:create'),
                'work-item:move': this.authorized(authentication, 'work-item:move'),
              },
              projection.checkpoint?.observedAt,
            ),
          },
        }
      }
      /* v8 ignore next 2 -- SakiQuery is closed and Host wire parsing rejects unknown tags before dispatch. */
      default: return assertNever(query)
    }
  }

  /** @inheritdoc */
  async submit<I extends SakiIntent>(
    authentication: SakiAuthenticationContext,
    intent: I,
    signal: AbortSignal,
  ): Promise<SakiIntentReceipt<I['type']>> {
    let result: Promise<SakiIntentReceipt>
    switch (intent.type) {
      case 'register-development-project': {
        const parsed = registerDevelopmentProjectIntentSchema.parse(intent) as RegisterDevelopmentProjectIntent
        result = this.runOwnedOperation(signal, operationSignal => this.enqueueIntentOperation(
          parsed.intentId,
          async () => {
            operationSignal.throwIfAborted()
            if (!this.authorized(authentication, 'development-project:register')) {
              return { ok: false, reason: 'denied' }
            }
            if (this.hasControlIntentConflict(parsed.intentId, 'registration')) {
              return { ok: false, reason: 'conflict' }
            }
            return await this.registerDevelopmentProject(authentication, parsed, operationSignal)
          },
        ))
        break
      }
      case 'configure-github-synchronization': {
        const parsed = configureGitHubSynchronizationIntentSchema.parse(intent)
        result = this.runOwnedOperation(signal, operationSignal => this.enqueueIntentOperation(
          parsed.intentId,
          async () => {
            operationSignal.throwIfAborted()
            if (!this.authorized(authentication, 'github-synchronization:configure')) {
              return { ok: false, reason: 'denied' }
            }
            if (this.hasControlIntentConflict(parsed.intentId, 'github-synchronization')) {
              return { ok: false, reason: 'conflict' }
            }
            return await this.githubSynchronization.configure(
              parsed as ConfigureGitHubSynchronizationIntent,
              this.currentControlIntentActor(),
              operationSignal,
            )
          },
        ))
        break
      }
      case 'stage-files': {
        const parsed = stageFilesIntentSchema.parse(intent) as StageFilesIntent
        result = this.runOwnedOperation(signal, operationSignal => this.enqueueIntentOperation(
          parsed.intentId,
          () => this.submitGitOperation(authentication, parsed, operationSignal),
        ))
        break
      }
      case 'unstage-files': {
        const parsed = unstageFilesIntentSchema.parse(intent) as UnstageFilesIntent
        result = this.runOwnedOperation(signal, operationSignal => this.enqueueIntentOperation(
          parsed.intentId,
          () => this.submitGitOperation(authentication, parsed, operationSignal),
        ))
        break
      }
      case 'create-commit': {
        const parsed = createCommitIntentSchema.parse(intent) as CreateCommitIntent
        result = this.runOwnedOperation(signal, operationSignal => this.enqueueIntentOperation(
          parsed.intentId,
          () => this.submitGitOperation(authentication, parsed, operationSignal),
        ))
        break
      }
      case 'create-work-item': {
        const parsed = createWorkItemIntentSchema.parse(intent) as CreateWorkItemIntent
        result = this.runOwnedOperation(signal, operationSignal => this.enqueueIntentOperation(
          parsed.intentId,
          () => this.submitWorkItem(authentication, parsed, operationSignal),
        ))
        break
      }
      case 'move-work-item': {
        const parsed = moveWorkItemIntentSchema.parse(intent) as MoveWorkItemIntent
        result = this.runOwnedOperation(signal, operationSignal => this.enqueueIntentOperation(
          parsed.intentId,
          () => this.submitWorkItem(authentication, parsed, operationSignal),
        ))
        break
      }
      case 'give-work-item-to-agent': {
        const parsed = giveWorkItemToAgentIntentSchema.parse(intent) as GiveWorkItemToAgentIntent
        result = this.runOwnedOperation(signal, operationSignal => this.enqueueIntentOperation(
          parsed.intentId,
          () => this.submitAgentOperation(authentication, parsed, operationSignal),
        ))
        break
      }
      /* v8 ignore next 2 -- SakiIntent is closed and Host wire parsing rejects unknown tags before dispatch. */
      default: return assertNever(intent)
    }
    // TypeScript cannot retain the generic Intent/receipt correlation across the exhaustive switch.
    // oxlint-disable-next-line typescript/no-unnecessary-type-assertion
    return await result as SakiIntentReceipt<I['type']>
  }

  private async submitGitOperation<I extends SakiGitOperationIntent>(
    authentication: SakiAuthenticationContext,
    intent: I,
    signal: AbortSignal,
  ): Promise<SakiGitOperationIntentReceipt<I['type']>> {
    signal.throwIfAborted()
    const action = intent.type === 'stage-files'
      ? 'project-changes:stage'
      : intent.type === 'unstage-files' ? 'project-changes:unstage' : 'project-commit:create'
    if (!this.authorized(authentication, action)) return { ok: false, reason: 'denied' }
    if (this.hasControlIntentConflict(intent.intentId, 'git-operation')) {
      return { ok: false, reason: 'conflict' }
    }
    return await this.gitOperations.submit(intent, this.currentControlIntentActor(), signal)
  }

  private async submitWorkItem<I extends SakiWorkItemIntent>(
    authentication: SakiAuthenticationContext,
    intent: I,
    signal: AbortSignal,
  ): Promise<SakiWorkItemIntentReceipt<I['type']>> {
    signal.throwIfAborted()
    const action = intent.type === 'create-work-item' ? 'work-item:create' : 'work-item:move'
    if (!this.authorized(authentication, action)) return { ok: false, reason: 'denied' }
    if (this.hasControlIntentConflict(intent.intentId, 'work-item')) {
      return { ok: false, reason: 'conflict' }
    }
    return await this.githubWorkItemOperations.submit(intent, this.currentControlIntentActor(), signal)
  }

  private async submitAgentOperation(
    authentication: SakiAuthenticationContext,
    intent: GiveWorkItemToAgentIntent,
    signal: AbortSignal,
  ): Promise<SakiGiveWorkItemToAgentIntentReceipt> {
    signal.throwIfAborted()
    if (!this.authorized(authentication, 'work-item:give-to-agent')) return { ok: false, reason: 'denied' }
    if (this.hasControlIntentConflict(intent.intentId, 'agent-operation')) {
      return { ok: false, reason: 'conflict' }
    }
    return await this.agentOperations.submit(intent, this.currentControlIntentActor(), signal)
  }

  private hasControlIntentConflict(
    intentId: SakiControlIntentId,
    owner: 'registration' | 'github-synchronization' | 'git-operation' | 'work-item' | 'agent-operation',
  ): boolean {
    return (owner !== 'registration' && this.requireRegistrationIntentTable().get(intentId) !== undefined)
      || (owner !== 'github-synchronization'
        && this.requireGitHubSynchronizationConfigurationIntentTable().get(intentId) !== undefined)
      || (owner !== 'git-operation' && this.requireGitOperationIntentTable().get(intentId) !== undefined)
      || (owner !== 'work-item' && this.requireGitHubWorkItemIntentTable().get(intentId) !== undefined)
      || (owner !== 'agent-operation' && this.requireAgentOperationIntentTable().get(intentId) !== undefined)
  }

  private currentControlIntentActor(): ControlIntentActor {
    const foundation = this.requireFoundation()
    return {
      installationId: foundation.installation.id,
      storageGenerationId: this.installationState.storageGenerationId,
      hostId: foundation.host.id,
      principalId: foundation.principal.id,
      principalRevision: foundation.principal.revision,
      grantId: foundation.grant.id,
      grantRevision: foundation.grant.revision,
    }
  }

  private async registerDevelopmentProject(
    authentication: SakiAuthenticationContext,
    intent: RegisterDevelopmentProjectIntent,
    signal: AbortSignal,
  ): Promise<SakiIntentReceipt> {
    const replay = await this.projects.replayExisting(intent, signal)
    if (replay !== undefined) return replay
    const beforeInspection = this.requireFoundation()
    if (intent.hostId !== beforeInspection.host.id) return { ok: false, reason: 'denied' }
    const inspected = await this.ctx.sakiHostExecution.inspectProjectSelection({
      hostId: intent.hostId,
      directoryLocator: intent.directoryLocator,
    }, signal)
    signal.throwIfAborted()
    if (!inspected.ok) {
      return inspected.reason === 'unavailable'
        ? { ok: false, reason: 'unavailable' }
        : { ok: false, reason: 'conflict' }
    }
    if (!isDeepStrictEqual(inspected.inspection.projection.fingerprint, intent.confirmedFingerprint)
      || !baselineMatches(inspected.inspection.projection.baseline, intent.confirmedBaseline)) {
      return { ok: false, reason: 'conflict' }
    }
    signal.throwIfAborted()
    if (!this.authorized(authentication, 'development-project:register')) {
      return { ok: false, reason: 'denied' }
    }
    const actor = this.currentControlIntentActor()
    return await this.projects.register(intent, actor, inspected.inspection, signal)
  }

  private enqueueIntentOperation<T>(
    intentId: SakiControlIntentId,
    operation: () => Promise<T>,
  ): Promise<T> {
    return enqueueKeyedOperation(this.intentOperationTails, intentId, operation)
  }

  private operationSignal(signal: AbortSignal): AbortSignal {
    return AbortSignal.any([signal, this.lifetime.signal])
  }

  private runOwnedOperation<T>(
    signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (!this.operationAdmissionOpen) {
      return Promise.reject(new Error('saki control plane is disposing'))
    }
    const operationSignal = this.operationSignal(signal)
    const result = Promise.resolve().then(async () => {
      operationSignal.throwIfAborted()
      return await operation(operationSignal)
    })
    const settled = result.then(() => undefined, () => undefined)
    this.activeOperations.add(settled)
    return result.finally(() => { this.activeOperations.delete(settled) })
  }

  /** @inheritdoc */
  onChanged(listener: (keys: readonly SakiProjectionKey[]) => void): SakiChangedDisposer {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private async readAccess(presentedSession: string | undefined, signal: AbortSignal): Promise<AccessProjection> {
    signal.throwIfAborted()
    await this.reconcileAccess(Date.now())
    if (presentedSession !== undefined) {
      const authentication = await this.authenticateCookie(presentedSession)
      if (authentication !== undefined) return this.accessProjection(authentication)
    }
    return this.requireAccess().bootstrapCompletion === undefined ? BOOTSTRAP_REQUIRED : SESSION_REQUIRED
  }

  private async exchangeBootstrap(
    transportContext: SakiBootstrapTransportContext,
    request: SakiBootstrapExchangeRequest,
    signal: AbortSignal,
  ): Promise<SakiAccessExchangeResult> {
    signal.throwIfAborted()
    if (transportContext.origin !== this.config.origin) return { ok: false, reason: 'unavailable' }
    await this.reconcileAccess(Date.now())
    signal.throwIfAborted()

    const foundation = this.requireFoundation()
    if (!this.activeFoundation(foundation)) return { ok: false, reason: 'unavailable' }
    const current = this.requireAccess()
    const challengeIndex = this.matchingChallengeIndex(current, request.secret)
    const challenge = current.challenges[challengeIndex]
    const now = Date.now()
    if (challenge === undefined
      || challenge.state !== 'issued'
      || challenge.expiresAt <= now
      || !this.challengeAuthorityIsCurrent(challenge, foundation)) {
      return { ok: false, reason: 'unavailable' }
    }

    const expectedRevision = current.revision
    const cookie = generateCredential()
    const sessionOrdinal = current.nextSessionOrdinal
    const sessionId = this.browserSessionId(current.id, sessionOrdinal)
    let session: BrowserSessionRecord | undefined
    try {
      await this.requireAccessTable().update(current.id, (stored) => {
        if (stored.revision !== expectedRevision) throw new AccessCasConflict()
        const storedIndex = stored.challenges.findIndex(candidate => candidate.id === challenge.id)
        const storedChallenge = stored.challenges[storedIndex]
        if (storedChallenge === undefined
          || storedChallenge.state !== 'issued'
          || storedChallenge.expiresAt <= now
          || !constantTimeTextEqual(
            storedChallenge.verifierDigest,
            bootstrapDigest(storedChallenge.id, request.secret),
          )
          || !this.challengeAuthorityIsCurrent(storedChallenge, foundation)) {
          throw new AccessUnavailable()
        }
        if ((stored.bootstrapCompletion === undefined) !== (storedChallenge.purpose === 'initial-bootstrap')) {
          throw new AccessUnavailable()
        }
        session = {
          id: sessionId,
          ordinal: sessionOrdinal,
          revision: 0,
          installationId: storedChallenge.installationId,
          storageGenerationId: storedChallenge.storageGenerationId,
          principalId: storedChallenge.principalId,
          cookieDigest: cookieDigest(sessionId, cookie),
          createdAt: now,
          expiresAt: now + this.config.sessionTtlMs,
          state: 'active',
        }
        const consumed: BootstrapChallengeRecord = {
          ...storedChallenge,
          revision: storedChallenge.revision + 1,
          state: 'consumed',
          terminalAt: now,
          browserSessionId: sessionId,
        }
        const challenges = stored.challenges.map((entry, index): BootstrapChallengeRecord => {
          if (index === storedIndex) return consumed
          return entry.state === 'issued'
            ? { ...entry, revision: entry.revision + 1, state: 'revoked', terminalAt: now }
            : entry
        })
        const bootstrapCompletion = stored.bootstrapCompletion ?? {
          challengeId: consumed.id,
          sessionId,
          hostId: consumed.hostId,
          principalId: consumed.principalId,
          completedAt: now,
        }
        const next: InstallationAccessRecord = {
          ...stored,
          revision: stored.revision + 1,
          nextSessionOrdinal: stored.nextSessionOrdinal + 1,
          bootstrapCompletion,
          challenges,
          sessions: [...stored.sessions, session],
        }
        this.validateAccess(next)
        return next
      })
    } catch (error) {
      if (error instanceof AccessUnavailable || error instanceof AccessCasConflict) {
        return { ok: false, reason: 'unavailable' }
      }
      throw error
    }
    const created = session
    /* v8 ignore next -- a successful table update ran the callback that assigns the new Browser Session. */
    if (created === undefined) throw new Error('saki access commit returned without a Browser Session')
    const authentication = new SakiAuthenticationContext(
      created.id,
      created.principalId,
      created.storageGenerationId,
      deriveRequestToken(created.id, cookie, current.requestTokenDerivation.domain),
    )
    const result: SakiAccessExchangeResult = { ok: true, access: this.accessProjection(authentication) }
    registerCookieHeader(result, this.sessionCookieHeader(cookie, created.expiresAt - now))
    return result
  }

  private async logoutCurrentSession(
    authentication: SakiAuthenticationContext,
    requestToken: string,
    signal: AbortSignal,
  ): Promise<SakiAccessLogoutResult> {
    signal.throwIfAborted()
    if (!this.activeAuthentication(authentication)
      || !authentication.matchesRequestToken(requestToken)) {
      return { ok: false, reason: 'unavailable' }
    }
    const current = this.requireAccess()
    const expectedRevision = current.revision
    const now = Date.now()
    try {
      await this.requireAccessTable().update(current.id, (stored) => {
        if (stored.revision !== expectedRevision) throw new AccessCasConflict()
        const index = stored.sessions.findIndex(candidate => candidate.id === authentication.sessionId)
        const session = stored.sessions[index]
        if (session === undefined || session.state !== 'active') throw new AccessUnavailable()
        const sessions = [...stored.sessions]
        sessions[index] = {
          ...session,
          revision: session.revision + 1,
          state: 'revoked',
          terminalAt: now,
        }
        const next = { ...stored, revision: stored.revision + 1, sessions }
        this.validateAccess(next)
        return next
      })
    } catch (error) {
      if (error instanceof AccessUnavailable || error instanceof AccessCasConflict) {
        return { ok: false, reason: 'unavailable' }
      }
      throw error
    }
    const result: SakiAccessLogoutResult = { ok: true }
    registerCookieHeader(result, this.expiredCookieHeader())
    return result
  }

  private async authenticateCookie(cookie: string): Promise<SakiAuthenticationContext | undefined> {
    await this.reconcileAccess(Date.now())
    const foundation = this.requireFoundation()
    const access = this.requireAccess()
    const sessionIndex = this.matchingSessionIndex(access, cookie)
    const session = access.sessions[sessionIndex]
    if (session === undefined
      || session.state !== 'active'
      || session.expiresAt <= Date.now()
      || !this.sessionAuthorityIsCurrent(session, foundation)) return undefined
    return new SakiAuthenticationContext(
      session.id,
      session.principalId,
      session.storageGenerationId,
      deriveRequestToken(session.id, cookie, access.requestTokenDerivation.domain),
    )
  }

  private accessProjection(authentication: SakiAuthenticationContext): Extract<AccessProjection, { kind: 'authenticated' }> {
    const principal = this.requirePrincipal(authentication.principalId)
    const session = this.requireAccess().sessions.find(candidate => candidate.id === authentication.sessionId)
    /* v8 ignore next -- callers pass only authentication resolved from this same current Access record. */
    if (session === undefined) throw new Error('saki authenticated Browser Session is absent')
    return {
      kind: 'authenticated',
      principal: { id: principal.id, displayName: principal.displayName },
      expiresAt: session.expiresAt,
      requestToken: authentication.projectRequestToken(),
    }
  }

  private authorized(
    authentication: SakiAuthenticationContext,
    action?: GrantRecord['actions'][number],
  ): boolean {
    if (!this.activeAuthentication(authentication)) return false
    const foundation = this.requireFoundation()
    const grant = foundation.grant
    return grant.state === 'active'
      && grant.principalId === authentication.principalId
      && grant.installationId === foundation.installation.id
      && grant.scope.installationId === foundation.installation.id
      && (action === undefined || grant.actions.includes(action))
  }

  private intentAuthorityCurrent(
    actor: RegistrationActor,
    action: GrantRecord['actions'][number],
  ): boolean {
    const foundation = this.requireFoundation()
    return foundation.installation.id === actor.installationId
      && foundation.installation.state === 'active'
      && actor.storageGenerationId === this.installationState.storageGenerationId
      && foundation.host.id === actor.hostId
      && foundation.host.state === 'enrolled'
      && foundation.principal.id === actor.principalId
      && foundation.principal.state === 'active'
      && foundation.grant.id === actor.grantId
      && foundation.grant.state === 'active'
      && foundation.grant.scope.installationId === foundation.installation.id
      && foundation.grant.actions.includes(action)
  }

  private validateRegistrationActorReference(actor: RegistrationActor): void {
    const control = this.requireControlStateTable().get(CONTROL_STATE_KEY)
    const installation = this.requireInstallation(actor.installationId)
    const host = this.requireHost(actor.hostId)
    const principal = this.requirePrincipal(actor.principalId)
    const grant = this.requireGrant(actor.grantId)
    /* v8 ignore next -- startup requires the singleton control row and this service exposes no deletion path. */
    if (control === undefined) throw new Error('Saki registration Intent actor reference is inconsistent')
    assertRegistrationActorReference(
      actor,
      control.installationId,
      installation,
      host,
      principal,
      grant,
      'Saki',
    )
  }

  private activeAuthentication(authentication: SakiAuthenticationContext): boolean {
    if (!(authentication instanceof SakiAuthenticationContext) || !authentication.isAuthentic()) return false
    const foundation = this.requireFoundation()
    const session = this.requireAccess().sessions.find(candidate => candidate.id === authentication.sessionId)
    return session?.state === 'active'
      && session.expiresAt > Date.now()
      && session.principalId === authentication.principalId
      && session.storageGenerationId === this.installationState.storageGenerationId
      && authentication.storageGenerationId === this.installationState.storageGenerationId
      && foundation.installation.state === 'active'
      && foundation.host.state === 'enrolled'
      && foundation.principal.id === authentication.principalId
      && foundation.principal.state === 'active'
  }

  private async reconcileAccess(now: number): Promise<void> {
    const table = this.requireAccessTable()
    const current = this.requireAccess()
    const foundation = this.requireFoundation()
    const shouldChange = current.challenges.some(entry =>
      entry.state === 'issued' && (
        entry.expiresAt <= now || !this.challengeAuthorityIsCurrent(entry, foundation)))
      || current.sessions.some(entry =>
        entry.state === 'active' && (
          entry.expiresAt <= now || !this.sessionAuthorityIsCurrent(entry, foundation)))
      || current.challenges.some(entry =>
        entry.state !== 'issued' && entry.terminalAt !== undefined
        && entry.terminalAt + this.config.terminalRetentionMs <= now)
      || current.sessions.some(entry =>
        entry.state !== 'active' && entry.terminalAt !== undefined
        && entry.terminalAt + this.config.terminalRetentionMs <= now)
    if (!shouldChange) return
    const expectedRevision = current.revision
    try {
      await table.update(current.id, (stored) => {
        if (stored.revision !== expectedRevision) throw new AccessCasConflict()
        const challenges = stored.challenges
          .map((entry): BootstrapChallengeRecord => entry.state === 'issued' && (
            entry.expiresAt <= now || !this.challengeAuthorityIsCurrent(entry, foundation))
            ? {
              ...entry,
              revision: entry.revision + 1,
              state: entry.expiresAt <= now ? 'expired' : 'revoked',
              terminalAt: now,
            }
            : entry)
          .filter(entry => entry.state === 'issued'
            || entry.terminalAt === undefined
            || entry.terminalAt + this.config.terminalRetentionMs > now)
        const sessions = stored.sessions
          .map((entry): BrowserSessionRecord => entry.state === 'active' && (
            entry.expiresAt <= now || !this.sessionAuthorityIsCurrent(entry, foundation))
            ? {
              ...entry,
              revision: entry.revision + 1,
              state: entry.expiresAt <= now ? 'expired' : 'revoked',
              terminalAt: now,
            }
            : entry)
          .filter(entry => entry.state === 'active'
            || entry.terminalAt === undefined
            || entry.terminalAt + this.config.terminalRetentionMs > now)
        const next = { ...stored, revision: stored.revision + 1, challenges, sessions }
        this.validateAccess(next)
        return next
      })
    } catch (error) {
      if (!(error instanceof AccessCasConflict)) throw error
      // A competing Access update owns the newer revision. The next operation
      // rechecks expiry and authority against that committed record.
    }
  }

  private async issueStartupChallenge(): Promise<void> {
    const foundation = this.requireFoundation()
    if (!this.activeFoundation(foundation)) return
    const access = this.requireAccess()
    const purpose: SakiBootstrapChallengePurpose = access.bootstrapCompletion === undefined
      ? 'initial-bootstrap'
      : 'local-reauthentication'
    const ordinal = access.nextChallengeOrdinal
    const id = this.challengeId(access.id, ordinal)
    const secret = generateCredential()
    const now = Date.now()
    const challenge: BootstrapChallengeRecord = {
      id,
      ordinal,
      revision: 0,
      purpose,
      installationId: foundation.installation.id,
      storageGenerationId: this.installationState.storageGenerationId,
      hostId: foundation.host.id,
      principalId: foundation.principal.id,
      verifierDigest: bootstrapDigest(id, secret),
      issuedAt: now,
      expiresAt: now + this.config.challengeTtlMs,
      state: 'issued',
    }
    await this.requireAccessTable().update(access.id, (stored) => {
      /* v8 ignore next -- startup initialization is the sole writer until the service is published. */
      if (stored.revision !== access.revision
        || stored.nextChallengeOrdinal !== ordinal
        || (stored.bootstrapCompletion === undefined) !== (purpose === 'initial-bootstrap')) {
        throw new AccessCasConflict()
      }
      const next: InstallationAccessRecord = {
        ...stored,
        revision: stored.revision + 1,
        nextChallengeOrdinal: stored.nextChallengeOrdinal + 1,
        challenges: [...stored.challenges, challenge],
      }
      this.validateAccess(next)
      return next
    })
    this.pendingBootstrap = new SakiBootstrapHandoff(purpose, secret)
  }

  private async resumeProvisioning(control: ControlStateRecord): Promise<void> {
    this.assertProvisioningRows(control)
    this.validateProvisioningChildren(control)
    await this.ensureInstallation(control)
    await this.ensureHost(control)
    await this.ensurePrincipal(control)
    await this.ensureGrant(control)
    await this.ensureAccess(control)
    await this.requireControlStateTable().update(CONTROL_STATE_KEY, (stored) => {
      /* v8 ignore next -- a committed ready transition bypasses provisioning on restart. */
      if (stored.phase === 'ready') return stored
      /* v8 ignore next -- provisioning initialization is the sole writer until the service is published. */
      if (stored.revision !== control.revision || !this.sameControlReferences(stored, control)) {
        throw new Error('saki provisioning owner changed while child records were created')
      }
      return { ...stored, revision: stored.revision + 1, phase: 'ready' }
    })
  }

  private async ensureInstallation(control: ControlStateRecord): Promise<void> {
    const expected = this.expectedInstallation(control)
    const table = this.requireInstallationTable()
    const existing = table.get(expected.id)
    if (existing === undefined) await table.put(expected.id, expected)
  }

  private async ensureHost(control: ControlStateRecord): Promise<void> {
    const expected = this.expectedHost(control)
    const table = this.requireHostTable()
    const existing = table.get(expected.id)
    if (existing === undefined) await table.put(expected.id, expected)
  }

  private async ensurePrincipal(control: ControlStateRecord): Promise<void> {
    const expected = this.expectedPrincipal(control)
    const table = this.requirePrincipalTable()
    const existing = table.get(expected.id)
    if (existing === undefined) await table.put(expected.id, expected)
  }

  private async ensureGrant(control: ControlStateRecord): Promise<void> {
    const expected = this.expectedGrant(control)
    const table = this.requireGrantTable()
    const existing = table.get(expected.id)
    if (existing === undefined) await table.put(expected.id, expected)
  }

  private async ensureAccess(control: ControlStateRecord): Promise<void> {
    const expected = this.expectedAccess(control)
    const table = this.requireAccessTable()
    const existing = table.get(expected.id)
    if (existing === undefined) await table.put(expected.id, expected)
  }

  private validateProvisioningChildren(control: ControlStateRecord): void {
    this.assertProvisioningRecord(
      this.requireInstallationTable(),
      this.expectedInstallation(control),
      'Installation',
    )
    this.assertProvisioningRecord(this.requireHostTable(), this.expectedHost(control), 'Host')
    this.assertProvisioningRecord(
      this.requirePrincipalTable(),
      this.expectedPrincipal(control),
      'Principal',
    )
    this.assertProvisioningRecord(this.requireGrantTable(), this.expectedGrant(control), 'Grant')
    this.assertProvisioningRecord(
      this.requireAccessTable(),
      this.expectedAccess(control),
      'Installation Access',
    )
  }

  private assertProvisioningRecord<K extends string, V extends object>(
    table: KvTable<K, V>,
    expected: V & { readonly id: K },
    name: string,
  ): void {
    const existing = table.get(expected.id)
    if (existing !== undefined && !this.sameRecord(existing, expected)) {
      throw new Error(`saki provisioning ${name} is inconsistent`)
    }
  }

  private expectedInstallation(control: ControlStateRecord): InstallationRecord {
    return {
      id: control.installationId,
      revision: 0,
      state: 'active',
      currentHostId: control.initialHostId,
    }
  }

  private expectedHost(control: ControlStateRecord): HostRecord {
    return {
      id: control.initialHostId,
      revision: 0,
      installationId: control.installationId,
      state: 'enrolled',
    }
  }

  private expectedPrincipal(control: ControlStateRecord): PrincipalRecord {
    return {
      id: control.hostOperatorPrincipalId,
      revision: 0,
      kind: 'human',
      displayName: 'Host Operator',
      state: 'active',
    }
  }

  private expectedGrant(control: ControlStateRecord): GrantRecord {
    return {
      id: control.hostOperatorGrantId,
      revision: 0,
      installationId: control.installationId,
      principalId: control.hostOperatorPrincipalId,
      state: 'active',
      actions: [
        ...HOST_OPERATOR_ACTIONS,
      ],
      scope: { kind: 'installation', installationId: control.installationId },
    }
  }

  private expectedAccess(control: ControlStateRecord): InstallationAccessRecord {
    return {
      id: control.installationAccessId,
      schemaVersion: 2,
      revision: 0,
      installationId: control.installationId,
      nextChallengeOrdinal: 0,
      nextSessionOrdinal: 0,
      requestTokenDerivation: { version: 1, domain: 'saki/browser-request-token' },
      challenges: [],
      sessions: [],
    }
  }

  private createControlState(): ControlStateRecord {
    return {
      schemaVersion: 2,
      revision: 0,
      phase: 'provisioning',
      installationId: this.installationState.installationId,
      initialHostId: this.hostId(),
      hostOperatorPrincipalId: this.principalId(),
      hostOperatorGrantId: this.grantId(),
      installationAccessId: this.accessId(),
    }
  }

  private requireFoundation(): CurrentFoundation {
    const control = this.requireControlStateTable().get(CONTROL_STATE_KEY)
    if (control === undefined || control.phase !== 'ready') {
      throw new Error('saki control plane provisioning is not ready')
    }
    this.assertControlInstallationState(control)
    const installation = this.requireInstallation(control.installationId)
    const initialHost = this.requireHost(control.initialHostId)
    const host = this.requireHost(installation.currentHostId)
    const principal = this.requirePrincipal(control.hostOperatorPrincipalId)
    const grant = this.requireGrant(control.hostOperatorGrantId)
    if (principal.kind !== 'human') {
      throw new Error('saki Host Operator Principal must be human')
    }
    if (initialHost.installationId !== installation.id
      || host.installationId !== installation.id
      || grant.installationId !== installation.id
      || grant.principalId !== principal.id
      || grant.scope.installationId !== installation.id) {
      throw new Error('saki control-plane entity relationships are inconsistent')
    }
    return { control, installation, host, principal, grant }
  }

  private activeFoundation(foundation: CurrentFoundation): boolean {
    return foundation.installation.state === 'active'
      && foundation.host.state === 'enrolled'
      && foundation.principal.state === 'active'
  }

  private challengeAuthorityIsCurrent(
    challenge: BootstrapChallengeRecord,
    foundation: CurrentFoundation,
  ): boolean {
    const host = this.requireHost(challenge.hostId)
    const principal = this.requirePrincipal(challenge.principalId)
    const installation = this.requireInstallation(challenge.installationId)
    return installation.id === foundation.installation.id
      && installation.state === 'active'
      && challenge.storageGenerationId === this.installationState.storageGenerationId
      && challenge.hostId === installation.currentHostId
      && host.installationId === installation.id
      && host.state === 'enrolled'
      && principal.id === foundation.principal.id
      && principal.state === 'active'
  }

  private sessionAuthorityIsCurrent(
    session: BrowserSessionRecord,
    foundation: CurrentFoundation,
  ): boolean {
    const installation = this.requireInstallation(session.installationId)
    const principal = this.requirePrincipal(session.principalId)
    return installation.id === foundation.installation.id
      && installation.state === 'active'
      && session.storageGenerationId === this.installationState.storageGenerationId
      && principal.id === foundation.principal.id
      && principal.state === 'active'
  }

  private validateAccess(record: InstallationAccessRecord): void {
    const control = this.requireControlStateTable().get(CONTROL_STATE_KEY)
    /* v8 ignore next -- startup requires the singleton control row and this service exposes no deletion path. */
    if (control === undefined) throw new Error('saki Installation Access belongs to another provisioning owner')
    validateInstallationAccessRecord(
      record,
      control.installationAccessId,
      control.installationId,
      id => this.requireInstallation(id),
      id => this.requireHost(id),
      id => this.requirePrincipal(id),
      'saki',
    )
  }

  private matchingChallengeIndex(access: InstallationAccessRecord, secret: string): number {
    let matched = -1
    for (const [index, challenge] of access.challenges.entries()) {
      const equal = constantTimeTextEqual(
        challenge.verifierDigest,
        bootstrapDigest(challenge.id, secret),
      )
      if (equal && matched < 0) matched = index
    }
    return matched
  }

  private matchingSessionIndex(access: InstallationAccessRecord, cookie: string): number {
    let matched = -1
    for (const [index, session] of access.sessions.entries()) {
      const equal = constantTimeTextEqual(session.cookieDigest, cookieDigest(session.id, cookie))
      /* v8 ignore next -- validated session digests are unique, while the loop still compares every entry. */
      if (equal && matched < 0) matched = index
    }
    return matched
  }

  private assertEmptyUnprovisionedDomain(): void {
    if (this.requireControlStateTable().size !== 0
      || this.requireInstallationTable().size !== 0
      || this.requireHostTable().size !== 0
      || this.requirePrincipalTable().size !== 0
      || this.requireGrantTable().size !== 0
      || this.requireAccessTable().size !== 0
      || this.hasDevelopmentProductRows()) {
      throw new Error('saki control state is missing from a non-empty domain')
    }
  }

  private assertProvisioningRows(control: ControlStateRecord): void {
    if (this.hasDevelopmentProductRows()) {
      throw new Error('saki provisioning contains Development Project product records')
    }
    this.assertOnlyProvisioningRow(this.requireInstallationTable(), control.installationId)
    this.assertOnlyProvisioningRow(this.requireHostTable(), control.initialHostId)
    this.assertOnlyProvisioningRow(this.requirePrincipalTable(), control.hostOperatorPrincipalId)
    this.assertOnlyProvisioningRow(this.requireGrantTable(), control.hostOperatorGrantId)
    this.assertOnlyProvisioningRow(this.requireAccessTable(), control.installationAccessId)
  }

  private hasDevelopmentProductRows(): boolean {
    return this.requireProjectRegistryTable().size !== 0
      || this.requireRegistrationIntentTable().size !== 0
      || this.requireGitHubProjectSyncTable().size !== 0
      || this.requireGitHubSynchronizationConfigurationIntentTable().size !== 0
      || this.requireGitHubWorkItemIntentTable().size !== 0
      || this.requireGitHubWorkItemRecoveryTable().size !== 0
      || this.requireGitOperationIntentTable().size !== 0
      || this.requireBindingWriteAdmissionTable().size !== 0
      || this.requireAgentOperationIntentTable().size !== 0
      || this.requireWorkAssignmentTable().size !== 0
      || this.requireWorkSessionTable().size !== 0
      || this.requireAgentRunTable().size !== 0
      || this.requireExecutionDispatchTable().size !== 0
  }

  private assertOnlyProvisioningRow<K extends string, V>(table: KvTable<K, V>, key: K): void {
    if (table.size > 1 || (table.size === 1 && table.get(key) === undefined)) {
      throw new Error('saki provisioning contains a child outside its stable references')
    }
  }

  private sameControlReferences(left: ControlStateRecord, right: ControlStateRecord): boolean {
    return left.installationId === right.installationId
      && left.initialHostId === right.initialHostId
      && left.hostOperatorPrincipalId === right.hostOperatorPrincipalId
      && left.hostOperatorGrantId === right.hostOperatorGrantId
      && left.installationAccessId === right.installationAccessId
  }

  private sameRecord(left: object, right: object): boolean {
    return isDeepStrictEqual(left, right)
  }

  private assertControlInstallationState(control: ControlStateRecord): void {
    if (control.installationId !== this.installationState.installationId) {
      throw new Error('saki control state belongs to another active Installation')
    }
  }

  private notify(keys: readonly SakiProjectionKey[]): void {
    for (const listener of this.listeners) {
      try {
        listener(keys)
      } catch {
        console.error('[saki-control-plane] Projection listener failed')
      }
    }
  }

  private installGitHubSynchronizationConsumer(): void {
    const providerFiber = this.ctx.inject(['sakiGitHub'], (providerContext: Context) => {
      const detachWorkItemOperations = this.githubWorkItemOperations.attach(providerContext.sakiGitHub)
      const detachAgentOperations = this.agentOperations.attachGitHub(providerContext.sakiGitHub)
      const consumer = new GitHubSynchronizationConsumer({
        synchronization: this.githubSynchronization,
        github: providerContext.sakiGitHub,
        attemptTtlMs: this.config.githubScanAttemptTtlMs,
        reportUnexpectedFailure: (scope) => {
          this.ctx.logger.error(`Saki GitHub synchronization ${scope} failed outside its typed failure interface`)
        },
      })
      this.githubSynchronizationConsumer = consumer
      consumer.wake()
      providerContext.effect(() => async () => {
        detachWorkItemOperations()
        detachAgentOperations()
        this.githubSynchronizationConsumer = undefined
        await consumer.dispose()
      }, 'saki-control-plane.githubSynchronizationConsumer')
    })
    this.ctx.effect(() => () => providerFiber.dispose(), 'saki-control-plane.optionalGitHubProvider')
  }

  private requireControlStateTable(): ControlStateTable {
    return this.controlStateTable
  }

  private requireInstallationTable(): InstallationTable {
    return this.installationTable
  }

  private requireHostTable(): HostTable {
    return this.hostTable
  }

  private requirePrincipalTable(): PrincipalTable {
    return this.principalTable
  }

  private requireGrantTable(): GrantTable {
    return this.grantTable
  }

  private requireAccessTable(): AccessTable {
    return this.accessTable
  }

  private requireProjectRegistryTable(): ProjectRegistryTable {
    return this.projectRegistryTable
  }

  private requireRegistrationIntentTable(): RegistrationIntentTable {
    return this.registrationIntentTable
  }

  private requireGitHubProjectSyncTable(): GitHubProjectSyncTable {
    return this.githubProjectSyncTable
  }

  private requireGitHubSynchronizationConfigurationIntentTable(): GitHubSynchronizationConfigurationIntentTable {
    return this.githubSynchronizationConfigurationIntentTable
  }

  private requireGitHubWorkItemIntentTable(): GitHubWorkItemIntentTable {
    return this.githubWorkItemIntentTable
  }

  private requireGitHubWorkItemRecoveryTable(): GitHubWorkItemRecoveryTable {
    return this.githubWorkItemRecoveryTable
  }

  private requireGitOperationIntentTable(): GitOperationIntentTable {
    return this.gitOperationIntentTable
  }

  private requireBindingWriteAdmissionTable(): BindingWriteAdmissionTable {
    return this.bindingWriteAdmissionTable
  }

  private requireAgentOperationIntentTable(): AgentOperationIntentTable {
    return this.agentOperationIntentTable
  }

  private requireWorkAssignmentTable(): WorkAssignmentTable {
    return this.workAssignmentTable
  }

  private requireWorkSessionTable(): WorkSessionTable {
    return this.workSessionTable
  }

  private requireAgentRunTable(): AgentRunTable {
    return this.agentRunTable
  }

  private requireExecutionDispatchTable(): ExecutionDispatchTable {
    return this.executionDispatchTable
  }

  private requireInstallation(id: SakiInstallationId): InstallationRecord {
    const record = this.requireInstallationTable().get(id)
    if (record === undefined) throw new Error(`saki Installation ${JSON.stringify(id)} is missing`)
    if (record.id !== id) throw new Error('saki Installation record id disagrees with its table key')
    return record
  }

  private requireHost(id: SakiHostId): HostRecord {
    const record = this.requireHostTable().get(id)
    if (record === undefined) throw new Error(`saki Host ${JSON.stringify(id)} is missing`)
    if (record.id !== id) throw new Error('saki Host record id disagrees with its table key')
    return record
  }

  private requirePrincipal(id: SakiPrincipalId): PrincipalRecord {
    const record = this.requirePrincipalTable().get(id)
    if (record === undefined) throw new Error(`saki Principal ${JSON.stringify(id)} is missing`)
    if (record.id !== id) throw new Error('saki Principal record id disagrees with its table key')
    return record
  }

  private requireGrant(id: SakiGrantId): GrantRecord {
    const record = this.requireGrantTable().get(id)
    if (record === undefined) throw new Error(`saki Grant ${JSON.stringify(id)} is missing`)
    if (record.id !== id) throw new Error('saki Grant record id disagrees with its table key')
    return record
  }

  private requireAccess(): InstallationAccessRecord {
    const control = this.requireControlStateTable().get(CONTROL_STATE_KEY)
    if (control === undefined) throw new Error('saki control plane is not provisioned')
    const record = this.requireAccessTable().get(control.installationAccessId)
    if (record === undefined) throw new Error('saki Installation Access is not initialized')
    return record
  }

  private sessionCookieHeader(cookie: string, lifetimeMs: number): string {
    const secure = new URL(this.config.origin).protocol === 'https:' ? '; Secure' : ''
    return `${this.config.cookieName}=${cookie}; Path=/saki; HttpOnly; SameSite=Strict; Max-Age=${String(Math.ceil(lifetimeMs / 1_000))}${secure}`
  }

  private expiredCookieHeader(): string {
    const secure = new URL(this.config.origin).protocol === 'https:' ? '; Secure' : ''
    return `${this.config.cookieName}=; Path=/saki; HttpOnly; SameSite=Strict; Max-Age=0${secure}`
  }

  private hostId = (): SakiHostId => `host-${randomUUID()}` as SakiHostId
  private principalId = (): SakiPrincipalId => `principal-${randomUUID()}` as SakiPrincipalId
  private grantId = (): SakiGrantId => `grant-${randomUUID()}` as SakiGrantId
  private accessId = (): SakiInstallationAccessId => `access-${randomUUID()}` as SakiInstallationAccessId
  private challengeId = (accessId: SakiInstallationAccessId, value: number): SakiBootstrapChallengeId =>
    `${accessId}:challenge:${String(value)}` as SakiBootstrapChallengeId
  private browserSessionId = (accessId: SakiInstallationAccessId, value: number): SakiBrowserSessionId =>
    `${accessId}:session:${String(value)}` as SakiBrowserSessionId
}

/* v8 ignore start -- the closed SakiQuery switch above exhausts every same-process variant. */
function assertNever(value: never): never {
  throw new Error(`unhandled Saki operation: ${JSON.stringify(value)}`)
}
/* v8 ignore stop */

export default SakiControlPlaneService
