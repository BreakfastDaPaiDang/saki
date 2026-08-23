/**
 * Deep Saki control-plane module for Installation access and Project registration.
 * @module @breakfastdapaidang/saki-control-plane/src/service
 */

import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { isLoopbackHostname } from '@deepseek-ai/dsh-client-connection'
import type { DomainChanged, KvTable } from '@deepseek-ai/dsh-storage-domain'
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
  registerDevelopmentProjectIntentSchema,
  sakiControlPlaneDomainSpec,
} from './spec.ts'
import type {
  BootstrapChallengeRecord,
  BrowserSessionRecord,
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
import { baselineMatches, DevelopmentProjects } from './projects.ts'
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
  SakiInstallationGenerationId,
  SakiInstallationId,
  SakiInstallationIdentity,
  SakiIntentInput,
  SakiIntentReceipt,
  SakiPrincipalId,
  SakiProjectionKey,
  SakiQuery,
  SakiQueryMap,
  SakiQueryResult,
  RegisterDevelopmentProjectIntent,
  SakiControlIntentId,
} from './types.ts'

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
   * @returns the authorized Projection or that query kind's typed failure:
   * `denied` or `unavailable`, plus `stale` or `not-found` for Development Workspace reads.
   */
  query<K extends keyof SakiQueryMap>(
    authentication: SakiAuthenticationContext,
    query: SakiQueryMap[K]['request'],
    signal: AbortSignal,
  ): Promise<SakiQueryResult<K>>

  /**
   * Submit one durable Project-registration Intent after current authorization.
   * @param authentication - trusted server-derived AuthenticationContext.
   * @param intent - bounded immutable registration content.
   * @param signal - caller cancellation.
   * @returns a confirmed receipt or typed `denied`, `unavailable`, `conflict`,
   * `failure`, or `reconciliation-required` result with only phase-valid receipt fields.
   */
  submit(
    authentication: SakiAuthenticationContext,
    intent: SakiIntentInput,
    signal: AbortSignal,
  ): Promise<SakiIntentReceipt>

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
  static inject = ['storageDomain', 'sakiHostExecution', 'workspaceRegistry']
  static Config: z<Config> = z.object({
    origin: z.string().required(),
    challengeTtlMs: z.natural().min(1).default(15 * 60 * 1_000),
    sessionTtlMs: z.natural().min(1).default(12 * 60 * 60 * 1_000),
    terminalRetentionMs: z.natural().min(1).default(7 * 24 * 60 * 60 * 1_000),
    cookieName: z.string().pattern(/^[A-Za-z0-9_]+$/).default('saki_session'),
  })

  private controlStateTable!: ControlStateTable
  private installationTable!: InstallationTable
  private hostTable!: HostTable
  private principalTable!: PrincipalTable
  private grantTable!: GrantTable
  private accessTable!: AccessTable
  private projectRegistryTable!: ProjectRegistryTable
  private registrationIntentTable!: RegistrationIntentTable
  private projects!: DevelopmentProjects
  private pendingBootstrap: SakiBootstrapHandoff | undefined
  private readonly listeners = new Set<(keys: readonly SakiProjectionKey[]) => void>()
  private readonly intentOperationTails = new Map<SakiControlIntentId, Promise<void>>()
  private readonly activeOperations = new Set<Promise<void>>()
  private operationAdmissionOpen = true
  private readonly lifetime = new AbortController()
  private startupSettled: Promise<void> = Promise.resolve()

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
    const parsed = new URL(config.origin)
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.origin !== config.origin) {
      throw new Error('saki control plane origin must be one exact HTTP(S) origin without a path')
    }
    if (!isLoopbackHostname(parsed.hostname)) {
      throw new Error('saki control plane origin must be a loopback origin')
    }
    ctx.on('domain/changed', (change: DomainChanged) => {
      if (change.domain !== sakiControlPlaneDomainSpec.name) return
      if (change.table === 'registration_intents') return
      if (change.table === 'development_project_registry') {
        this.notify(['project-index', 'development-workspace'])
        return
      }
      this.notify(['access', 'project-index', 'development-workspace'])
    })
    ctx.effect(() => () => {
      this.listeners.clear()
      this.pendingBootstrap = undefined
    }, 'saki-control-plane.processState')
  }

  /** Open, resume, validate, and reconcile the single Installation domain. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(sakiControlPlaneDomainSpec)
    this.ctx.effect(() => async () => {
      this.operationAdmissionOpen = false
      this.lifetime.abort(new Error('saki control plane is disposing'))
      await Promise.all([
        this.startupSettled,
        ...this.activeOperations,
        ...this.intentOperationTails.values(),
      ])
      await domain.close()
    }, 'saki-control-plane.domainClose')
    this.controlStateTable = domain.table('control_state')
    this.installationTable = domain.table('installations')
    this.hostTable = domain.table('hosts')
    this.principalTable = domain.table('principals')
    this.grantTable = domain.table('grants')
    this.accessTable = domain.table('installation_access')
    this.projectRegistryTable = domain.table('development_project_registry')
    this.registrationIntentTable = domain.table('registration_intents')

    let settleStartup!: () => void
    this.startupSettled = new Promise((resolve) => { settleStartup = resolve })
    try {
      let control = this.controlStateTable.get(CONTROL_STATE_KEY)
      if (control === undefined) {
        this.assertEmptyUnprovisionedDomain()
        control = this.createControlState()
        await this.controlStateTable.put(CONTROL_STATE_KEY, control)
      } else if (this.controlStateTable.size !== 1) {
        throw new Error('saki control plane has unexpected provisioning owner records')
      }

      if (control.phase === 'provisioning') {
        await this.resumeProvisioning(control)
      }
      this.requireFoundation()
      this.validateAccess(this.requireAccess())
      this.projects = new DevelopmentProjects({
        registryTable: this.projectRegistryTable,
        intentTable: this.registrationIntentTable,
        execution: this.ctx.sakiHostExecution,
        workspaces: this.ctx.workspaceRegistry,
        authorityCurrent: actor => this.registrationAuthorityCurrent(actor),
        validateActorReference: (actor) => {
          this.validateRegistrationActorReference(actor)
        },
      })
      const projects = this.projects.validateDurableState()
      await this.reconcileAccess(Date.now())
      await this.projects.initializeValidated(projects, this.lifetime.signal)
      this.lifetime.signal.throwIfAborted()
      await this.issueStartupChallenge()
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
      /* v8 ignore next 2 -- SakiQuery is closed and Host wire parsing rejects unknown tags before dispatch. */
      default: return assertNever(query)
    }
  }

  /** @inheritdoc */
  async submit(
    authentication: SakiAuthenticationContext,
    intent: SakiIntentInput,
    signal: AbortSignal,
  ): Promise<SakiIntentReceipt> {
    const parsed = registerDevelopmentProjectIntentSchema.parse(intent)
    return await this.runOwnedOperation(signal, (operationSignal) => {
      return this.enqueueIntentOperation(parsed.intentId, async () => {
        operationSignal.throwIfAborted()
        if (!this.authorized(authentication, 'development-project:register')) {
          return { ok: false, reason: 'denied' }
        }
        return await this.registerDevelopmentProject(authentication, parsed, operationSignal)
      })
    })
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
    const foundation = this.requireFoundation()
    const actor: RegistrationActor = {
      installationId: foundation.installation.id,
      installationGenerationId: foundation.installation.currentInstallationGenerationId,
      hostId: foundation.host.id,
      principalId: foundation.principal.id,
      principalRevision: foundation.principal.revision,
      grantId: foundation.grant.id,
      grantRevision: foundation.grant.revision,
    }
    return await this.projects.register(intent, actor, inspected.inspection, signal)
  }

  private enqueueIntentOperation<T>(
    intentId: SakiControlIntentId,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.intentOperationTails.get(intentId) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(() => undefined, () => undefined)
    this.intentOperationTails.set(intentId, tail)
    return result.finally(() => {
      if (this.intentOperationTails.get(intentId) === tail) this.intentOperationTails.delete(intentId)
    })
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
          installationGenerationId: storedChallenge.installationGenerationId,
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
      created.installationGenerationId,
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
      session.installationGenerationId,
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

  private registrationAuthorityCurrent(actor: RegistrationActor): boolean {
    const foundation = this.requireFoundation()
    return foundation.installation.id === actor.installationId
      && foundation.installation.state === 'active'
      && foundation.installation.currentInstallationGenerationId === actor.installationGenerationId
      && foundation.host.id === actor.hostId
      && foundation.host.state === 'enrolled'
      && foundation.principal.id === actor.principalId
      && foundation.principal.state === 'active'
      && foundation.grant.id === actor.grantId
      && foundation.grant.state === 'active'
      && foundation.grant.scope.installationId === foundation.installation.id
      && foundation.grant.actions.includes('development-project:register')
  }

  private validateRegistrationActorReference(actor: RegistrationActor): void {
    const control = this.requireControlStateTable().get(CONTROL_STATE_KEY)
    const installation = this.requireInstallation(actor.installationId)
    const host = this.requireHost(actor.hostId)
    const principal = this.requirePrincipal(actor.principalId)
    const grant = this.requireGrant(actor.grantId)
    if (control === undefined
      || installation.id !== control.installationId
      || (actor.installationGenerationId !== control.initialInstallationGenerationId
        && actor.installationGenerationId !== installation.currentInstallationGenerationId)
      || host.installationId !== installation.id
      || principal.kind !== 'human'
      || actor.principalRevision > principal.revision
      || grant.installationId !== installation.id
      || grant.principalId !== principal.id
      || grant.scope.installationId !== installation.id
      || actor.grantRevision > grant.revision) {
      throw new Error('Saki registration Intent actor reference is inconsistent')
    }
  }

  private activeAuthentication(authentication: SakiAuthenticationContext): boolean {
    if (!(authentication instanceof SakiAuthenticationContext) || !authentication.isAuthentic()) return false
    const foundation = this.requireFoundation()
    const session = this.requireAccess().sessions.find(candidate => candidate.id === authentication.sessionId)
    return session?.state === 'active'
      && session.expiresAt > Date.now()
      && session.principalId === authentication.principalId
      && session.installationGenerationId === foundation.installation.currentInstallationGenerationId
      && authentication.installationGenerationId === foundation.installation.currentInstallationGenerationId
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
      installationGenerationId: foundation.installation.currentInstallationGenerationId,
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
      currentInstallationGenerationId: control.initialInstallationGenerationId,
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
        'inspect-project-selection',
        'project-index:read',
        'development-workspace:read',
        'development-project:register',
      ],
      scope: { kind: 'installation', installationId: control.installationId },
    }
  }

  private expectedAccess(control: ControlStateRecord): InstallationAccessRecord {
    return {
      id: control.installationAccessId,
      schemaVersion: 1,
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
      schemaVersion: 1,
      revision: 0,
      phase: 'provisioning',
      installationId: this.installationId(),
      initialInstallationGenerationId: this.installationGenerationId(),
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
      && challenge.installationGenerationId === installation.currentInstallationGenerationId
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
      && session.installationGenerationId === installation.currentInstallationGenerationId
      && principal.id === foundation.principal.id
      && principal.state === 'active'
  }

  private validateAccess(record: InstallationAccessRecord): void {
    const control = this.requireControlStateTable().get(CONTROL_STATE_KEY)
    if (control === undefined || record.id !== control.installationAccessId
      || record.installationId !== control.installationId) {
      throw new Error('saki Installation Access belongs to another provisioning owner')
    }
    const challengeIds = new Set<string>()
    const challengeOrdinals = new Set<number>()
    const challengeDigests = new Set<string>()
    const sessionIds = new Set<string>()
    const sessionOrdinals = new Set<number>()
    const sessionDigests = new Set<string>()

    for (const challenge of record.challenges) {
      const terminal = challenge.state !== 'issued'
      if (challenge.id !== this.challengeId(record.id, challenge.ordinal)
        || challenge.ordinal >= record.nextChallengeOrdinal
        || challengeIds.has(challenge.id)
        || challengeOrdinals.has(challenge.ordinal)
        || challengeDigests.has(challenge.verifierDigest)
        || terminal !== (challenge.terminalAt !== undefined)
        || (terminal && challenge.revision === 0)
        || challenge.expiresAt <= challenge.issuedAt
        || (challenge.terminalAt !== undefined && challenge.terminalAt < challenge.issuedAt)
        || (challenge.state === 'expired' && (challenge.terminalAt ?? -1) < challenge.expiresAt)
        || (challenge.state === 'consumed') !== (challenge.browserSessionId !== undefined)) {
        throw new Error('saki Installation Access contains an invalid Bootstrap Challenge')
      }
      if (challenge.installationId !== record.installationId) {
        throw new Error('saki Bootstrap Challenge belongs to another Installation')
      }
      const installation = this.requireInstallation(challenge.installationId)
      const host = this.requireHost(challenge.hostId)
      this.requirePrincipal(challenge.principalId)
      if (host.installationId !== installation.id) {
        throw new Error('saki Bootstrap Challenge references an unrelated Host')
      }
      challengeIds.add(challenge.id)
      challengeOrdinals.add(challenge.ordinal)
      challengeDigests.add(challenge.verifierDigest)
    }

    for (const session of record.sessions) {
      const terminal = session.state !== 'active'
      if (session.id !== this.browserSessionId(record.id, session.ordinal)
        || session.ordinal >= record.nextSessionOrdinal
        || sessionIds.has(session.id)
        || sessionOrdinals.has(session.ordinal)
        || sessionDigests.has(session.cookieDigest)
        || terminal !== (session.terminalAt !== undefined)
        || (terminal && session.revision === 0)
        || session.expiresAt <= session.createdAt
        || (session.terminalAt !== undefined && session.terminalAt < session.createdAt)
        || (session.state === 'expired' && (session.terminalAt ?? -1) < session.expiresAt)) {
        throw new Error('saki Installation Access contains an invalid Browser Session')
      }
      if (session.installationId !== record.installationId) {
        throw new Error('saki Browser Session belongs to another Installation')
      }
      this.requireInstallation(session.installationId)
      this.requirePrincipal(session.principalId)
      sessionIds.add(session.id)
      sessionOrdinals.add(session.ordinal)
      sessionDigests.add(session.cookieDigest)
    }

    const consumedSessionIds = new Set<SakiBrowserSessionId>()
    for (const challenge of record.challenges) {
      if (challenge.browserSessionId === undefined) continue
      if (consumedSessionIds.has(challenge.browserSessionId)) {
        throw new Error('saki multiple Bootstrap Challenges reference one Browser Session')
      }
      const session = record.sessions.find(candidate => candidate.id === challenge.browserSessionId)
      if (session === undefined
        || session.installationId !== challenge.installationId
        || session.installationGenerationId !== challenge.installationGenerationId
        || session.principalId !== challenge.principalId
        || session.createdAt !== challenge.terminalAt) {
        throw new Error('saki consumed Bootstrap Challenge references an inconsistent Browser Session')
      }
      consumedSessionIds.add(challenge.browserSessionId)
    }

    const completion = record.bootstrapCompletion
    if (completion === undefined) {
      if (record.sessions.length !== 0
        || record.challenges.some(challenge =>
          challenge.purpose !== 'initial-bootstrap' || challenge.state === 'consumed')) {
        throw new Error('saki Installation Access contains reauthentication state before bootstrap completion')
      }
      return
    }

    if (!this.allocatedEntryId(record.id, 'challenge', completion.challengeId, record.nextChallengeOrdinal)
      || !this.allocatedEntryId(record.id, 'session', completion.sessionId, record.nextSessionOrdinal)) {
      throw new Error('saki bootstrap completion references an unallocated entry identity')
    }

    const completionHost = this.requireHost(completion.hostId)
    this.requirePrincipal(completion.principalId)
    if (completionHost.installationId !== record.installationId
      || record.challenges.some(challenge =>
        challenge.purpose === 'initial-bootstrap'
        && (challenge.state === 'issued'
          || (challenge.state === 'consumed' && challenge.id !== completion.challengeId)))) {
      throw new Error('saki Installation Access contains an invalid bootstrap completion')
    }
    const completionChallenge = record.challenges.find(challenge => challenge.id === completion.challengeId)
    if (completionChallenge !== undefined
      && (completionChallenge.purpose !== 'initial-bootstrap'
        || completionChallenge.state !== 'consumed'
        || completionChallenge.browserSessionId !== completion.sessionId
        || completionChallenge.hostId !== completion.hostId
        || completionChallenge.principalId !== completion.principalId
        || completionChallenge.terminalAt !== completion.completedAt)) {
      throw new Error('saki bootstrap completion disagrees with its retained challenge')
    }
    const completionSession = record.sessions.find(session => session.id === completion.sessionId)
    if (completionSession !== undefined
      && (completionSession.principalId !== completion.principalId
        || completionSession.createdAt !== completion.completedAt)) {
      throw new Error('saki bootstrap completion disagrees with its retained Browser Session')
    }
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

  private allocatedEntryId(
    accessId: SakiInstallationAccessId,
    kind: 'challenge' | 'session',
    id: string,
    highWater: number,
  ): boolean {
    const prefix = `${accessId}:${kind}:`
    if (!id.startsWith(prefix)) return false
    const suffix = id.slice(prefix.length)
    const ordinal = Number(suffix)
    return Number.isSafeInteger(ordinal) && ordinal < highWater
  }

  private assertEmptyUnprovisionedDomain(): void {
    if (this.requireControlStateTable().size !== 0
      || this.requireInstallationTable().size !== 0
      || this.requireHostTable().size !== 0
      || this.requirePrincipalTable().size !== 0
      || this.requireGrantTable().size !== 0
      || this.requireAccessTable().size !== 0
      || this.requireProjectRegistryTable().size !== 0
      || this.requireRegistrationIntentTable().size !== 0) {
      throw new Error('saki control state is missing from a non-empty domain')
    }
  }

  private assertProvisioningRows(control: ControlStateRecord): void {
    if (this.requireProjectRegistryTable().size !== 0
      || this.requireRegistrationIntentTable().size !== 0) {
      throw new Error('saki provisioning contains Development Project product records')
    }
    this.assertOnlyProvisioningRow(this.requireInstallationTable(), control.installationId)
    this.assertOnlyProvisioningRow(this.requireHostTable(), control.initialHostId)
    this.assertOnlyProvisioningRow(this.requirePrincipalTable(), control.hostOperatorPrincipalId)
    this.assertOnlyProvisioningRow(this.requireGrantTable(), control.hostOperatorGrantId)
    this.assertOnlyProvisioningRow(this.requireAccessTable(), control.installationAccessId)
  }

  private assertOnlyProvisioningRow<K extends string, V>(table: KvTable<K, V>, key: K): void {
    if (table.size > 1 || (table.size === 1 && table.get(key) === undefined)) {
      throw new Error('saki provisioning contains a child outside its stable references')
    }
  }

  private sameControlReferences(left: ControlStateRecord, right: ControlStateRecord): boolean {
    return left.installationId === right.installationId
      && left.initialInstallationGenerationId === right.initialInstallationGenerationId
      && left.initialHostId === right.initialHostId
      && left.hostOperatorPrincipalId === right.hostOperatorPrincipalId
      && left.hostOperatorGrantId === right.hostOperatorGrantId
      && left.installationAccessId === right.installationAccessId
  }

  private sameRecord(left: object, right: object): boolean {
    return isDeepStrictEqual(left, right)
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

  private installationId = (): SakiInstallationId => `installation-${randomUUID()}` as SakiInstallationId
  private hostId = (): SakiHostId => `host-${randomUUID()}` as SakiHostId
  private installationGenerationId = (): SakiInstallationGenerationId =>
    `installation-generation-${randomUUID()}` as SakiInstallationGenerationId
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
