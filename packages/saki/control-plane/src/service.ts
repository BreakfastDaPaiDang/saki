/**
 * Deep Saki control-plane module for Installation access and B01 Projections.
 * @module @breakfastdapaidang/saki-control-plane/src/service
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import { SakiAuthenticationContext } from './authentication.ts'
import type {
  SakiAuthenticationRequest,
  SakiAuthenticationResolution,
} from './authentication.ts'
import {
  FOUNDATION_KEY,
  INSTALLATION_ACCESS_KEY,
  sakiControlPlaneDomainSpec,
} from './spec.ts'
import type {
  BootstrapChallengeRecord,
  BrowserSessionRecord,
  FoundationRecord,
  InstallationAccessRecord,
} from './spec.ts'
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
  SakiQueryResult,
} from './types.ts'

/** Composition configuration for local Saki access. */
export interface Config {
  /** Exact loopback browser origin accepted by every access mutation. */
  origin: string
  /** Lifetime of a clear one-time bootstrap handoff. */
  challengeTtlMs?: number
  /** Lifetime of one server-owned Browser Session. */
  sessionTtlMs?: number
  /** Minimum retention of terminal challenge and session evidence. */
  terminalRetentionMs?: number
  /** Cookie name used only by the trusted Host transport. */
  cookieName?: string
}

/** Local launcher channel for the one clear bootstrap secret. */
export interface SakiBootstrapLaunch {
  /**
   * Take the process-local bootstrap handoff.
   * @returns one opaque handoff, or `undefined` after bootstrap or prior consumption.
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
   * Atomically consume the one-time challenge and create one Browser Session.
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

/** Public deep-module operations used by Host and future automation Consumers. */
export interface SakiControlPlaneModule {
  /** Access lifecycle separated from Control Intent authority. */
  readonly access: SakiAccess
  /** Local clear-secret launcher channel. */
  readonly bootstrap: SakiBootstrapLaunch

  /**
   * Read trusted local Installation and Host identities.
   * @returns stable independent identities.
   */
  identity(): SakiInstallationIdentity

  /**
   * Query one protected Projection after revalidating current authority.
   * @param authentication - trusted server-derived AuthenticationContext.
   * @param query - closed B01 Projection query.
   * @param signal - caller cancellation.
   * @returns authorized Projection or safe denial.
   */
  query(
    authentication: SakiAuthenticationContext,
    query: SakiQuery,
    signal: AbortSignal,
  ): Promise<SakiQueryResult>

  /**
   * Reject the empty B01 Intent map after revalidating current authority.
   * @param authentication - trusted server-derived AuthenticationContext.
   * @param intent - absent only while the merge-extensible Intent map is empty.
   * @param signal - caller cancellation.
   * @returns stable unavailable receipt.
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

type FoundationTable = KvTable<typeof FOUNDATION_KEY, FoundationRecord>
type AccessTable = KvTable<typeof INSTALLATION_ACCESS_KEY, InstallationAccessRecord>

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
  static inject = ['storageDomain']
  static Config: z<Config> = z.object({
    origin: z.string().required(),
    challengeTtlMs: z.natural().min(1).default(15 * 60 * 1_000),
    sessionTtlMs: z.natural().min(1).default(12 * 60 * 60 * 1_000),
    terminalRetentionMs: z.natural().min(1).default(7 * 24 * 60 * 60 * 1_000),
    cookieName: z.string().pattern(/^[A-Za-z0-9_]+$/).default('saki_session'),
  })

  private foundationTable?: FoundationTable
  private accessTable?: AccessTable
  private pendingBootstrap: SakiBootstrapHandoff | undefined
  private readonly listeners = new Set<(keys: readonly SakiProjectionKey[]) => void>()

  /** Access interface with no storage or trusted resolver exposure. */
  readonly access: SakiAccess = {
    readAccess: (presentedSession, signal) => this.readAccess(presentedSession, signal),
    exchangeBootstrap: (transportContext, request, signal) =>
      this.exchangeBootstrap(transportContext, request, signal),
    logoutCurrentSession: (authentication, requestToken, signal) =>
      this.logoutCurrentSession(authentication, requestToken, signal),
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
    ctx.on('domain/changed', (change: DomainChanged) => {
      if (change.domain !== sakiControlPlaneDomainSpec.name) return
      this.notify(['access', 'project-index'])
    })
    ctx.effect(() => () => { this.listeners.clear() }, 'saki-control-plane.listeners')
  }

  /** Open, validate, reconcile, and provision the single Installation domain. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(sakiControlPlaneDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'saki-control-plane.domainClose')
    this.foundationTable = domain.table('foundation')
    this.accessTable = domain.table('installation_access')

    let foundation = this.foundationTable.get(FOUNDATION_KEY)
    const access = this.accessTable.get(INSTALLATION_ACCESS_KEY)
    if (foundation === undefined) {
      if (this.foundationTable.size !== 0 || access !== undefined || this.accessTable.size !== 0) {
        throw new Error('saki control plane foundation is missing from a non-empty domain')
      }
      foundation = this.createFoundation()
      await this.foundationTable.put(FOUNDATION_KEY, foundation)
    }
    this.validateFoundation(foundation)

    if (access === undefined) {
      if (this.accessTable.size !== 0) throw new Error('saki control plane has an unexpected access record')
      const secret = generateCredential()
      const created = this.createAccess(foundation, secret, Date.now())
      await this.accessTable.put(INSTALLATION_ACCESS_KEY, created)
      this.pendingBootstrap = new SakiBootstrapHandoff(secret)
    } else {
      this.validateAccess(foundation, access)
      await this.reconcileAccess(Date.now())
      const current = this.requireAccess()
      if (!current.bootstrapCompleted
        && !current.challenges.some(challenge => challenge.state === 'issued')) {
        await this.issueBootstrapChallenge(foundation, current)
      }
    }
  }

  /** @returns stable Installation and independently enrolled Local Host identities. */
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
    signal.throwIfAborted()
    if (presentedSession === undefined) return { ok: false, reason: 'unavailable' }
    const authenticated = await this.authenticateCookie(presentedSession)
    if (authenticated === undefined) return { ok: false, reason: 'unavailable' }
    if (request.mutation) {
      if (request.origin !== this.config.origin
        || !authenticated.matchesRequestToken(request.requestToken ?? '')) {
        return { ok: false, reason: 'unavailable' }
      }
    }
    return { ok: true, authentication: authenticated }
  }

  /**
   * Read the configured cookie name for the trusted Host adapter.
   * @returns the configured cookie name.
   */
  sessionCookieName(): string {
    return this.config.cookieName
  }

  /** @inheritdoc */
  query(
    authentication: SakiAuthenticationContext,
    _query: SakiQuery,
    signal: AbortSignal,
  ): Promise<SakiQueryResult> {
    signal.throwIfAborted()
    if (!this.authorized(authentication, 'project-index:read')) {
      return Promise.resolve({ ok: false, reason: 'denied' })
    }
    return Promise.resolve({ ok: true, projection: { type: 'project-index', revision: 0, projects: [] } })
  }

  /** @inheritdoc */
  submit(
    authentication: SakiAuthenticationContext,
    _intent: SakiIntentInput,
    signal: AbortSignal,
  ): Promise<SakiIntentReceipt> {
    signal.throwIfAborted()
    if (!this.authorized(authentication)) return Promise.resolve({ ok: false, reason: 'denied' })
    return Promise.resolve({ ok: false, reason: 'intent-unavailable' })
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
    return this.requireAccess().bootstrapCompleted ? SESSION_REQUIRED : BOOTSTRAP_REQUIRED
  }

  private async exchangeBootstrap(
    transportContext: SakiBootstrapTransportContext,
    request: SakiBootstrapExchangeRequest,
    signal: AbortSignal,
  ): Promise<SakiAccessExchangeResult> {
    signal.throwIfAborted()
    if (transportContext.origin !== this.config.origin) return { ok: false, reason: 'unavailable' }
    await this.reconcileAccess(Date.now())
    const foundation = this.requireFoundation()
    const current = this.requireAccess()
    const expectedRevision = current.revision
    const presentedDigest = bootstrapDigest(request.secret)
    const cookie = generateCredential()
    const now = Date.now()
    const sessionId = this.browserSessionId()
    let session: BrowserSessionRecord | undefined
    try {
      await this.requireAccessTable().update(INSTALLATION_ACCESS_KEY, (stored) => {
        if (stored.revision !== expectedRevision) throw new AccessCasConflict()
        if (stored.bootstrapCompleted) throw new AccessUnavailable()
        const challengeIndex = stored.challenges.findIndex(challenge =>
          constantTimeTextEqual(challenge.verifierDigest, presentedDigest))
        const challenge = stored.challenges[challengeIndex]
        if (challenge === undefined
          || challenge.state !== 'issued'
          || challenge.expiresAt <= now
          || challenge.installationId !== foundation.installation.id
          || challenge.generationId !== foundation.installation.generationId
          || challenge.principalId !== foundation.principal.id
          || foundation.principal.state !== 'active') {
          throw new AccessUnavailable()
        }
        session = {
          id: sessionId,
          revision: 0,
          installationId: foundation.installation.id,
          generationId: foundation.installation.generationId,
          principalId: foundation.principal.id,
          cookieDigest: cookieDigest(cookie),
          createdAt: now,
          expiresAt: now + this.config.sessionTtlMs,
          state: 'active',
        }
        const consumed: BootstrapChallengeRecord = {
          ...challenge,
          revision: challenge.revision + 1,
          state: 'consumed',
          terminalAt: now,
          browserSessionId: sessionId,
        }
        const challenges = stored.challenges.map((entry, index): BootstrapChallengeRecord => {
          if (index === challengeIndex) return consumed
          return entry.state === 'issued'
            ? { ...entry, revision: entry.revision + 1, state: 'revoked', terminalAt: now }
            : entry
        })
        return {
          ...stored,
          revision: stored.revision + 1,
          bootstrapCompleted: true,
          challenges,
          sessions: [...stored.sessions, session],
        }
      })
    } catch (error) {
      if (error instanceof AccessUnavailable || error instanceof AccessCasConflict) {
        return { ok: false, reason: 'unavailable' }
      }
      throw error
    }
    const created = session
    if (created === undefined) throw new Error('saki access commit returned without a Browser Session')
    const authentication = new SakiAuthenticationContext(
      created.id,
      created.principalId,
      created.generationId,
      deriveRequestToken(cookie, current.requestTokenDerivation.domain),
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
      await this.requireAccessTable().update(INSTALLATION_ACCESS_KEY, (stored) => {
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
        return { ...stored, revision: stored.revision + 1, sessions }
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
    const presentedDigest = cookieDigest(cookie)
    const session = access.sessions.find(candidate =>
      constantTimeTextEqual(candidate.cookieDigest, presentedDigest))
    if (session === undefined
      || session.state !== 'active'
      || session.expiresAt <= Date.now()
      || session.installationId !== foundation.installation.id
      || session.generationId !== foundation.installation.generationId
      || session.principalId !== foundation.principal.id
      || foundation.principal.state !== 'active') return undefined
    return new SakiAuthenticationContext(
      session.id,
      session.principalId,
      session.generationId,
      deriveRequestToken(cookie, access.requestTokenDerivation.domain),
    )
  }

  private accessProjection(authentication: SakiAuthenticationContext): Extract<AccessProjection, { kind: 'authenticated' }> {
    const foundation = this.requireFoundation()
    const session = this.requireAccess().sessions.find(candidate => candidate.id === authentication.sessionId)
    if (session === undefined) throw new Error('saki authenticated Browser Session is absent')
    return {
      kind: 'authenticated',
      principal: { id: foundation.principal.id, displayName: foundation.principal.displayName },
      expiresAt: session.expiresAt,
      requestToken: authentication.projectRequestToken(),
    }
  }

  private authorized(
    authentication: SakiAuthenticationContext,
    action?: FoundationRecord['grant']['actions'][number],
  ): boolean {
    if (!this.activeAuthentication(authentication)) return false
    const foundation = this.requireFoundation()
    const grant = foundation.grant
    return grant.state === 'active'
      && grant.principalId === authentication.principalId
      && grant.installationId === foundation.installation.id
      && (action === undefined || grant.actions.includes(action))
  }

  private activeAuthentication(authentication: SakiAuthenticationContext): boolean {
    if (!(authentication instanceof SakiAuthenticationContext) || !authentication.isAuthentic()) return false
    const foundation = this.requireFoundation()
    const session = this.requireAccess().sessions.find(candidate => candidate.id === authentication.sessionId)
    return session?.state === 'active'
      && session.expiresAt > Date.now()
      && session.principalId === authentication.principalId
      && session.generationId === foundation.installation.generationId
      && authentication.generationId === foundation.installation.generationId
      && foundation.principal.id === authentication.principalId
      && foundation.principal.state === 'active'
  }

  private async reconcileAccess(now: number): Promise<void> {
    const table = this.requireAccessTable()
    const current = table.get(INSTALLATION_ACCESS_KEY)
    if (current === undefined) return
    const foundation = this.requireFoundation()
    const shouldChange = current.challenges.some(entry =>
      entry.state === 'issued' && entry.expiresAt <= now)
      || current.sessions.some(entry =>
        entry.state === 'active' && (entry.expiresAt <= now
          || entry.generationId !== foundation.installation.generationId
          || entry.principalId !== foundation.principal.id
          || foundation.principal.state !== 'active'))
      || current.challenges.some(entry =>
        entry.state !== 'issued' && entry.terminalAt !== undefined
        && entry.terminalAt + this.config.terminalRetentionMs <= now)
      || current.sessions.some(entry =>
        entry.state !== 'active' && entry.terminalAt !== undefined
        && entry.terminalAt + this.config.terminalRetentionMs <= now)
    if (!shouldChange) return
    const expectedRevision = current.revision
    try {
      await table.update(INSTALLATION_ACCESS_KEY, (stored) => {
        if (stored.revision !== expectedRevision) throw new AccessCasConflict()
        const challenges = stored.challenges
          .map((entry): BootstrapChallengeRecord => entry.state === 'issued' && entry.expiresAt <= now
            ? { ...entry, revision: entry.revision + 1, state: 'expired', terminalAt: now }
            : entry)
          .filter(entry => entry.state === 'issued'
            || entry.terminalAt === undefined
            || entry.terminalAt + this.config.terminalRetentionMs > now)
        const sessions = stored.sessions
          .map((entry): BrowserSessionRecord => entry.state === 'active' && (
            entry.expiresAt <= now
            || entry.generationId !== foundation.installation.generationId
            || entry.principalId !== foundation.principal.id
            || foundation.principal.state !== 'active')
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
        return { ...stored, revision: stored.revision + 1, challenges, sessions }
      })
    } catch (error) {
      if (!(error instanceof AccessCasConflict)) throw error
      // A competing Access update owns the newer revision. The next operation
      // rechecks expiry and authority against that committed record.
    }
  }

  private async issueBootstrapChallenge(
    foundation: FoundationRecord,
    access: InstallationAccessRecord,
  ): Promise<void> {
    const secret = generateCredential()
    const now = Date.now()
    const challenge = this.createChallenge(foundation, secret, now)
    await this.requireAccessTable().update(INSTALLATION_ACCESS_KEY, (stored) => {
      if (stored.revision !== access.revision || stored.bootstrapCompleted) throw new AccessCasConflict()
      if (stored.challenges.some(entry => entry.state === 'issued')) throw new AccessCasConflict()
      return { ...stored, revision: stored.revision + 1, challenges: [...stored.challenges, challenge] }
    })
    this.pendingBootstrap = new SakiBootstrapHandoff(secret)
  }

  private createFoundation(): FoundationRecord {
    const installationId = this.installationId()
    const principalId = this.principalId()
    return {
      schemaVersion: 1,
      installation: {
        id: installationId,
        generationId: this.generationId(),
        state: 'active',
      },
      host: { id: this.hostId(), installationId, state: 'enrolled' },
      principal: { id: principalId, kind: 'human', displayName: 'Host Operator', state: 'active' },
      grant: {
        id: this.grantId(),
        principalId,
        revision: 1,
        state: 'active',
        actions: ['project-index:read'],
        installationId,
      },
    }
  }

  private createAccess(foundation: FoundationRecord, secret: string, now: number): InstallationAccessRecord {
    return {
      id: this.accessId(),
      schemaVersion: 1,
      revision: 0,
      installationId: foundation.installation.id,
      bootstrapCompleted: false,
      requestTokenDerivation: { version: 1, domain: 'saki/browser-request-token' },
      challenges: [this.createChallenge(foundation, secret, now)],
      sessions: [],
    }
  }

  private createChallenge(
    foundation: FoundationRecord,
    secret: string,
    now: number,
  ): BootstrapChallengeRecord {
    return {
      id: this.challengeId(),
      revision: 0,
      installationId: foundation.installation.id,
      generationId: foundation.installation.generationId,
      hostId: foundation.host.id,
      principalId: foundation.principal.id,
      verifierDigest: bootstrapDigest(secret),
      issuedAt: now,
      expiresAt: now + this.config.challengeTtlMs,
      state: 'issued',
    }
  }

  private validateFoundation(record: FoundationRecord): void {
    if (record.host.installationId !== record.installation.id
      || record.grant.installationId !== record.installation.id
      || record.grant.principalId !== record.principal.id) {
      throw new Error('saki control plane foundation relationships are inconsistent')
    }
  }

  private validateAccess(foundation: FoundationRecord, record: InstallationAccessRecord): void {
    if (record.installationId !== foundation.installation.id) {
      throw new Error('saki Installation Access belongs to another Installation')
    }
    if (new Set(record.challenges.map(entry => entry.id)).size !== record.challenges.length
      || new Set(record.sessions.map(entry => entry.id)).size !== record.sessions.length) {
      throw new Error('saki Installation Access contains duplicate security-record identities')
    }
    for (const challenge of record.challenges) {
      const terminal = challenge.state !== 'issued'
      if (terminal !== (challenge.terminalAt !== undefined)
        || challenge.installationId !== foundation.installation.id
        || challenge.hostId !== foundation.host.id
        || challenge.principalId !== foundation.principal.id
        || (challenge.state === 'consumed') !== (challenge.browserSessionId !== undefined)) {
        throw new Error('saki Installation Access contains an invalid Bootstrap Challenge')
      }
      if (challenge.browserSessionId !== undefined
        && !record.sessions.some(session => session.id === challenge.browserSessionId)) {
        throw new Error('saki consumed Bootstrap Challenge references a missing Browser Session')
      }
    }
    for (const session of record.sessions) {
      if ((session.state !== 'active') !== (session.terminalAt !== undefined)
        || session.installationId !== foundation.installation.id
        || session.principalId !== foundation.principal.id) {
        throw new Error('saki Installation Access contains an invalid Browser Session')
      }
    }
    if (!record.bootstrapCompleted && record.challenges.some(entry => entry.state === 'consumed')) {
      throw new Error('saki Installation Access has consumed challenge evidence before bootstrap completion')
    }
  }

  private notify(keys: readonly SakiProjectionKey[]): void {
    for (const listener of this.listeners) {
      try {
        listener(keys)
      } catch (error) {
        console.error('[saki-control-plane] Projection listener threw:', error)
      }
    }
  }

  private requireFoundation(): FoundationRecord {
    const record = this.foundationTable?.get(FOUNDATION_KEY)
    if (record === undefined) throw new Error('saki control plane is not initialized')
    return record
  }

  private requireAccess(): InstallationAccessRecord {
    const record = this.accessTable?.get(INSTALLATION_ACCESS_KEY)
    if (record === undefined) throw new Error('saki Installation Access is not initialized')
    return record
  }

  private requireAccessTable(): AccessTable {
    if (this.accessTable === undefined) throw new Error('saki control plane is not initialized')
    return this.accessTable
  }

  private sessionCookieHeader(cookie: string, lifetimeMs: number): string {
    const secure = new URL(this.config.origin).protocol === 'https:' ? '; Secure' : ''
    return `${this.config.cookieName}=${cookie}; Path=/saki; HttpOnly; SameSite=Strict; Max-Age=${String(Math.floor(lifetimeMs / 1_000))}${secure}`
  }

  private expiredCookieHeader(): string {
    const secure = new URL(this.config.origin).protocol === 'https:' ? '; Secure' : ''
    return `${this.config.cookieName}=; Path=/saki; HttpOnly; SameSite=Strict; Max-Age=0${secure}`
  }

  private installationId = (): SakiInstallationId => `installation-${randomUUID()}` as SakiInstallationId
  private hostId = (): SakiHostId => `host-${randomUUID()}` as SakiHostId
  private generationId = (): SakiInstallationGenerationId => `generation-${randomUUID()}` as SakiInstallationGenerationId
  private principalId = (): SakiPrincipalId => `principal-${randomUUID()}` as SakiPrincipalId
  private grantId = (): SakiGrantId => `grant-${randomUUID()}` as SakiGrantId
  private accessId = (): SakiInstallationAccessId => `access-${randomUUID()}` as SakiInstallationAccessId
  private challengeId = (): SakiBootstrapChallengeId => `challenge-${randomUUID()}` as SakiBootstrapChallengeId
  private browserSessionId = (): SakiBrowserSessionId => `browser-session-${randomUUID()}` as SakiBrowserSessionId
}

export default SakiControlPlaneService
