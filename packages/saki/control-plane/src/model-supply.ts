/** Durable Model Account lifecycle and reconciliation. @module @breakfastdapaidang/saki-control-plane/model-supply */

import { isDeepStrictEqual } from 'node:util'
import { CREDENTIAL_PROTECTION_LOCAL_USER_TRUST, credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { modelAccountProfileId, modelAccountRouteId } from '@breakfastdapaidang/saki-model-account'
import type { ModelAccountProfileId, ModelAccountService } from '@breakfastdapaidang/saki-model-account'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { ControlIntentActor } from './spec.ts'
import type { SakiControlIntentId } from './types.ts'
import { resolvedAccountModelRouteSchema } from './model-routing-spec.ts'
import type { AccountModelSelection, ResolvedAccountModelRoute } from './model-routing-spec.ts'
import { enqueueKeyedOperation } from './keyed-operation.ts'
import { modelAccountBindingSchema, modelAccountRecordSchema, modelAccountSnapshotSchema } from './model-supply-spec.ts'
import type {
  ModelAccountIntent, ModelAccountIntentRecord, ModelAccountIntentResult, ModelAccountRecord, ModelSupplyProjection,
} from './model-supply-spec.ts'

/** Control-plane-owned durable account inventory. */
export type ModelAccountTable = KvTable<ModelAccountProfileId, ModelAccountRecord>
/** Replayable account Control Intents, including unfinished authorization. */
export type ModelAccountIntentTable = KvTable<SakiControlIntentId, ModelAccountIntentRecord>

interface Options {
  readonly profiles: ModelAccountTable
  readonly intents: ModelAccountIntentTable
  readonly accounts: () => ModelAccountService | undefined
  readonly credentials: () => CredentialProvider | undefined
  readonly authorityCurrent: (actor: ControlIntentActor) => boolean
  readonly notifyChanged: () => void
  readonly lifetime: AbortSignal
}

/** One Installation's account orchestration; provider packages never own product selection. */
export class ModelSupply {
  private readonly operations = new Map<ModelAccountProfileId, Promise<void>>()
  private readonly running = new Map<SakiControlIntentId, { controller: AbortController; done: Promise<void> }>()
  private readonly active = new Map<ModelAccountProfileId, { routeId: string; dispose: () => Promise<void> }>()
  private closed = false

  constructor(private readonly options: Options) {}

  /**
   * Project operator-safe inventory and login progress.
   * @returns current durable facts without credentials or provider configuration.
   */
  projection(): ModelSupplyProjection {
    return {
      type: 'model-supply',
      providers: (this.options.accounts()?.list() ?? []).map(provider => ({
        id: provider.id, implementation: provider.implementation, methods: provider.methods,
      })),
      profiles: [...this.options.profiles.entries()].map(([, profile]) => ({
        id: profile.id, name: profile.name, revision: profile.revision,
        providerId: profile.binding.providerId, routeId: profile.binding.routeId,
        configurationRevision: profile.binding.revision, implementation: profile.implementation,
        connected: profile.connected, desiredActive: profile.desiredActive,
        effectiveActive: this.active.get(profile.id)?.routeId === profile.binding.routeId
          && this.options.accounts()?.isActive(profile.binding.routeId) === true,
        snapshot: profile.snapshot, lastConfirmedUsage: profile.lastConfirmedUsage,
      })),
      authorizations: [...this.options.intents.entries()]
        .filter(([, intent]) => intent.request.type === 'authorize-model-account')
        .map(([, intent]) => ({ intentId: intent.id, profileId: intent.profileId,
          state: intent.state, progress: intent.progress })),
    }
  }

  /**
   * Capture a selected account revision after checking its current protected credential and catalog.
   * @param selection - exact account configuration and model chosen by the operator.
   * @param signal - admission lifetime, before any model request begins.
   * @returns detached route attribution with no credential address or material.
   */
  async resolveSelection(selection: AccountModelSelection, signal: AbortSignal): Promise<ResolvedAccountModelRoute> {
    return await enqueueKeyedOperation(this.operations, selection.accountProfileId, async () => {
      signal.throwIfAborted()
      const profile = this.options.profiles.get(selection.accountProfileId)
      const accounts = this.options.accounts()
      const provider = profile === undefined ? undefined : accounts?.get(profile.binding.providerId)
      if (this.closed || this.options.lifetime.aborted || profile === undefined || !profile.connected || !profile.desiredActive
        || profile.binding.revision !== selection.configurationRevision || provider === undefined
        || !isDeepStrictEqual(provider.implementation, profile.implementation)
        || !accounts?.isActive(profile.binding.routeId)) throw new Error('Selected account route is unavailable')
      const snapshot = modelAccountSnapshotSchema.parse(await provider.inspect(profile.binding, signal))
      signal.throwIfAborted()
      const usage = snapshot.usage.state === 'available' ? snapshot.usage : profile.lastConfirmedUsage
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Provider inspection can outlive disposal or cancellation.
      if (this.closed || this.options.lifetime.aborted || accounts.get(profile.binding.providerId) !== provider
        || !accounts.isActive(profile.binding.routeId) || snapshot.authentication !== 'authorized'
        || snapshot.protectionLevel !== profile.binding.requiredProtection || snapshot.identity !== profile.binding.accountIdentity
        || snapshot.identity === null || snapshot.health === 'unavailable' || snapshot.entitlement === 'denied'
        || !snapshot.models.some(model => model.id === selection.model)
        || usage?.windows.some(window => window.blocksRequests && window.remaining === 0
          && (window.resetsAt === null || window.resetsAt > Date.now()))) throw new Error('Selected account model is unavailable')
      return resolvedAccountModelRouteSchema.parse({ selection, provider: profile.binding.routeId,
        accountIdentity: snapshot.identity, implementation: profile.implementation, configuration: profile.binding.configuration })
    })
  }

  /**
   * Accept or replay an exact account Intent before starting provider effects.
   * @param request - validated operator request without credentials.
   * @param actor - current attributed Host Operator.
   * @param signal - admission cancellation, not the background login lifetime.
   * @returns durable acknowledgement or a closed rejection reason.
   */
  async submit(request: ModelAccountIntent, actor: ControlIntentActor, signal: AbortSignal): Promise<ModelAccountIntentResult> {
    signal.throwIfAborted()
    if (this.closed || this.options.lifetime.aborted) return { ok: false, reason: 'unavailable' }
    if (!this.options.authorityCurrent(actor)) return { ok: false, reason: 'denied' }
    const existing = this.options.intents.get(request.intentId)
    if (existing !== undefined) {
      return isDeepStrictEqual(existing.request, request) && isDeepStrictEqual(existing.actor, actor)
        ? this.receipt(existing) : { ok: false, reason: 'conflict' }
    }
    if (request.type === 'cancel-model-authorization') return this.cancel(request, actor)
    const profileId = request.type === 'authorize-model-account'
      ? request.existing?.profileId ?? modelAccountProfileId(request.intentId.slice('intent-'.length)) : request.profileId
    return enqueueKeyedOperation(this.operations, profileId, async () => {
      signal.throwIfAborted()
      if (this.closed || this.options.lifetime.aborted) return { ok: false, reason: 'unavailable' }
      if (!this.options.authorityCurrent(actor)) return { ok: false, reason: 'denied' }
      const replay = this.options.intents.get(request.intentId)
      if (replay !== undefined) {
        return isDeepStrictEqual(replay.request, request) && isDeepStrictEqual(replay.actor, actor)
          ? this.receipt(replay) : { ok: false, reason: 'conflict' }
      }
      if ([...this.options.intents.entries()].some(([, intent]) => intent.profileId === profileId
        && intent.request.type === 'authorize-model-account'
        && (intent.state === 'accepted' || intent.state === 'authorizing'))) {
        return { ok: false, reason: 'conflict' }
      }
      const profile = this.options.profiles.get(profileId)
      const expected = request.type === 'authorize-model-account' ? request.existing?.expectedRevision : request.expectedRevision
      if (expected !== profile?.revision) return { ok: false, reason: 'conflict' }
      const providerId = request.type === 'authorize-model-account' ? request.providerId : profile?.binding.providerId
      const provider = providerId === undefined ? undefined : this.options.accounts()?.get(providerId)
      if (profile !== undefined && profile.binding.providerId !== providerId) return { ok: false, reason: 'conflict' }
      let binding: NonNullable<ModelAccountIntentRecord['binding']>
      let implementation: ModelAccountIntentRecord['implementation']
      if (request.type === 'authorize-model-account') {
        if (provider === undefined) return { ok: false, reason: 'unavailable' }
        if (!provider.methods.some(method => method.id === request.method)) return { ok: false, reason: 'unavailable' }
        implementation = provider.implementation
        binding = modelAccountBindingSchema.parse({
          profileId, providerId: provider.id, routeId: modelAccountRouteId(profileId, (profile?.binding.revision ?? 0) + 1),
          revision: (profile?.binding.revision ?? 0) + 1,
          credentialKey: credentialKey(`saki-model-account-${provider.id}`, `authorization-${request.intentId}`),
          requiredProtection: CREDENTIAL_PROTECTION_LOCAL_USER_TRUST,
          accountIdentity: profile?.binding.accountIdentity ?? null,
          configuration: provider.resolveConfiguration(request.configuration ?? profile?.binding.configuration ?? {}),
        })
      } else {
        if (profile === undefined) return { ok: false, reason: 'conflict' }
        binding = profile.binding
        implementation = profile.implementation
      }
      const now = Date.now()
      const record: ModelAccountIntentRecord = {
        schemaVersion: 1, id: request.intentId, request, actor, profileId, binding,
        implementation, state: 'accepted', progress: null, createdAt: now, updatedAt: now,
      }
      await this.options.intents.put(record.id, record)
      this.options.notifyChanged()
      if (request.type === 'authorize-model-account') this.startAuthorization(record)
      else await this.apply(record)
      return this.currentReceipt(record.id)
    })
  }

  /** Recover acknowledgement loss without repeating a login or allocating another Profile. */
  async recover(): Promise<void> {
    for (const [, record] of this.options.intents.entries()) {
      if (record.state === 'cancelled' && record.request.type === 'authorize-model-account') {
        const current = record.profileId === null ? undefined : this.options.profiles.get(record.profileId)
        if (current?.revision === record.request.existing?.expectedRevision) await this.finishAuthorization(record, true)
        continue
      }
      if (record.state !== 'accepted' && record.state !== 'authorizing') continue
      if (record.request.type === 'authorize-model-account') await this.finishAuthorization(record, true)
      else await this.apply(record)
    }
    for (const [, profile] of this.options.profiles.entries()) await this.reconcile(profile)
  }

  /** Reconcile retained choices when an account implementation mounts or withdraws. */
  async providersChanged(): Promise<void> {
    if (this.closed || this.options.lifetime.aborted) return
    for (const [, record] of this.options.intents.entries()) {
      if (record.profileId === null || record.request.type !== 'authorize-model-account' || this.running.has(record.id)
        || !['accepted', 'authorizing', 'interrupted'].includes(record.state)) continue
      await enqueueKeyedOperation(this.operations, record.profileId, async () => {
        if (this.closed || this.options.lifetime.aborted) return
        await this.finishAuthorization(record, true)
      })
    }
    for (const [id] of this.options.profiles.entries()) {
      await enqueueKeyedOperation(this.operations, id, async () => {
        const profile = this.options.profiles.get(id)
        if (profile !== undefined && !this.closed && !this.options.lifetime.aborted) await this.reconcile(profile)
      })
    }
    this.options.notifyChanged()
  }

  /** Cancel owned logins, await settlement and withdraw all account routes. */
  async dispose(): Promise<void> {
    this.closed = true
    for (const operation of this.running.values()) operation.controller.abort()
    await Promise.allSettled([...this.running.values()].map(operation => operation.done))
    await Promise.allSettled(this.operations.values())
    await Promise.all([...this.active.values()].map(registration => registration.dispose()))
    this.active.clear()
  }

  private currentReceipt(id: SakiControlIntentId): ModelAccountIntentResult {
    const record = this.options.intents.get(id)
    if (record === undefined) throw new Error('Accepted Model Account Intent is missing')
    return this.receipt(record)
  }

  private isClosed(): boolean { return this.closed }

  private receipt(record: ModelAccountIntentRecord): ModelAccountIntentResult {
    return { ok: true, receipt: { intentId: record.id, state: record.state, profileId: record.profileId } }
  }

  private async settle(id: SakiControlIntentId, state: ModelAccountIntentRecord['state']): Promise<void> {
    await this.options.intents.update(id, current => ({ ...current, state, progress: null, updatedAt: Date.now() }))
    this.options.notifyChanged()
  }

  private startAuthorization(record: ModelAccountIntentRecord): void {
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, this.options.lifetime])
    const done = Promise.resolve().then(async () => {
      const provider = record.binding === null ? undefined : this.options.accounts()?.get(record.binding.providerId)
      if (provider === undefined || record.binding === null || record.request.type !== 'authorize-model-account'
        || !isDeepStrictEqual(provider.implementation, record.implementation)) {
        await this.settle(record.id, 'failed')
        return
      }
      let progressWrites = Promise.resolve()
      try {
        signal.throwIfAborted()
        await this.options.intents.update(record.id, current => current.state === 'accepted'
          ? { ...current, state: 'authorizing' } : current)
        signal.throwIfAborted()
        if (this.options.intents.get(record.id)?.state !== 'authorizing') return
        await provider.authorize(record.binding, record.request.method, (progress) => {
          progressWrites = progressWrites.then(async () => {
            if (signal.aborted) return
            await this.options.intents.update(record.id, current => current.state !== 'authorizing' ? current
              : { ...current, progress, updatedAt: Date.now() })
            this.options.notifyChanged()
          })
          void progressWrites.catch(() => { controller.abort() })
        }, signal)
      } catch {
        // Authorization exceptions can carry credentials; settlement inspects the protected record instead.
      }
      await progressWrites
      if (record.profileId === null) throw new Error('Authorization has no Profile')
      await enqueueKeyedOperation(this.operations, record.profileId, () => this.finishAuthorization(record, false))
    }).finally(() => { this.running.delete(record.id) })
    this.running.set(record.id, { controller, done })
    // Teardown and recovery own settlement; a failed durable write must not become an unhandled rejection.
    void done.catch(() => { this.options.notifyChanged() })
  }

  private async finishAuthorization(record: ModelAccountIntentRecord, recovering: boolean): Promise<void> {
    if (record.binding === null || record.profileId === null || record.implementation === null
      || record.request.type !== 'authorize-model-account') throw new Error('Invalid Model Account authorization record')
    const existing = this.options.profiles.get(record.profileId)
    if (existing?.changedByIntentId === record.id) {
      await this.settle(record.id, 'completed')
      return
    }
    const provider = this.options.accounts()?.get(record.binding.providerId)
    if (!this.options.authorityCurrent(record.actor) || provider === undefined
      || !isDeepStrictEqual(provider.implementation, record.implementation)) {
      await this.settle(record.id, 'interrupted')
      return
    }
    const signal = this.options.lifetime
    if (signal.aborted || this.closed) {
      await this.settle(record.id, 'interrupted')
      return
    }
    let snapshot
    try {
      snapshot = modelAccountSnapshotSchema.parse(await provider.inspect(record.binding, signal))
    } catch {
      // Provider failures may contain credentials; durable settlement uses only a fixed state.
      await this.settle(record.id, this.options.intents.get(record.id)?.state === 'cancelled' ? 'cancelled' : 'interrupted')
      return
    }
    signal.throwIfAborted()
    if (this.isClosed() || !this.options.authorityCurrent(record.actor)
      || this.options.accounts()?.get(record.binding.providerId) !== provider) {
      await this.settle(record.id, 'interrupted')
      return
    }
    if (snapshot.authentication !== 'authorized' || snapshot.protectionLevel !== record.binding.requiredProtection
      || snapshot.identity === null
      || (record.binding.accountIdentity !== null && snapshot.identity !== record.binding.accountIdentity)) {
      const cancelled = this.options.intents.get(record.id)?.state === 'cancelled'
      await this.settle(record.id, cancelled ? 'cancelled' : recovering ? 'interrupted' : 'failed')
      return
    }
    if (existing?.revision !== record.request.existing?.expectedRevision) {
      await this.settle(record.id, 'failed')
      return
    }
    const profile = modelAccountRecordSchema.parse({
      schemaVersion: 1, id: record.profileId, name: record.request.name,
      revision: (existing?.revision ?? 0) + 1, connected: true, desiredActive: existing?.desiredActive ?? false,
      binding: { ...record.binding, accountIdentity: snapshot.identity }, implementation: record.implementation,
      snapshot, lastConfirmedUsage: snapshot.usage.state === 'available' ? snapshot.usage : existing?.lastConfirmedUsage ?? null,
      changedByIntentId: record.id,
    })
    await this.options.profiles.put(profile.id, profile)
    await this.settle(record.id, 'completed')
    await this.reconcile(profile)
  }

  private async cancel(
    request: Extract<ModelAccountIntent, { type: 'cancel-model-authorization' }>,
    actor: ControlIntentActor,
  ): Promise<ModelAccountIntentResult> {
    const target = this.options.intents.get(request.authorizationIntentId)
    if (target?.request.type !== 'authorize-model-account') return { ok: false, reason: 'conflict' }
    const now = Date.now()
    const record: ModelAccountIntentRecord = { schemaVersion: 1, id: request.intentId, request, actor,
      profileId: target.profileId, binding: null, implementation: null, state: 'accepted', progress: null,
      createdAt: now, updatedAt: now }
    await this.options.intents.put(record.id, record)
    await this.apply(record)
    return this.currentReceipt(record.id)
  }

  private async apply(record: ModelAccountIntentRecord): Promise<void> {
    const request = record.request
    if (!this.options.authorityCurrent(record.actor)) { await this.settle(record.id, 'failed'); return }
    if (request.type === 'authorize-model-account') throw new Error('Authorization requires its owned lifecycle')
    if (request.type === 'cancel-model-authorization') {
      await this.options.intents.update(request.authorizationIntentId, current => (
        current.state === 'accepted' || current.state === 'authorizing'
          ? { ...current, state: 'cancelled', progress: null, updatedAt: Date.now() } : current
      ))
      this.running.get(request.authorizationIntentId)?.controller.abort()
      await this.settle(record.id, 'completed')
      return
    }
    const current = this.options.profiles.get(request.profileId)
    if (current === undefined || (current.changedByIntentId !== record.id && current.revision !== request.expectedRevision)) {
      await this.settle(record.id, 'failed')
      return
    }
    let profile = current
    if (current.changedByIntentId !== record.id) {
      if (request.type === 'refresh-model-account') {
        const provider = this.options.accounts()?.get(current.binding.providerId)
        if (provider === undefined || !isDeepStrictEqual(provider.implementation, current.implementation)) {
          await this.settle(record.id, 'failed')
          return
        }
        const snapshot = modelAccountSnapshotSchema.parse(await provider.inspect(current.binding, this.options.lifetime))
        this.options.lifetime.throwIfAborted()
        if (this.isClosed() || !this.options.authorityCurrent(record.actor)
          || this.options.accounts()?.get(current.binding.providerId) !== provider) {
          await this.settle(record.id, 'failed')
          return
        }
        profile = { ...current, snapshot,
          lastConfirmedUsage: snapshot.usage.state === 'available' ? snapshot.usage : current.lastConfirmedUsage,
          changedByIntentId: record.id }
      } else {
        profile = { ...current, revision: current.revision + 1, changedByIntentId: record.id,
          ...request.type === 'rename-model-account' ? { name: request.name } : {},
          ...request.type === 'set-model-account-active' ? { desiredActive: request.active } : {},
          ...request.type === 'disconnect-model-account' ? { connected: false, desiredActive: false } : {},
        }
      }
      await this.options.profiles.put(profile.id, profile)
    }
    await this.reconcile(profile)
    if (request.type === 'disconnect-model-account') {
      const credentials = this.options.credentials()
      if (credentials === undefined) { await this.settle(record.id, 'failed'); return }
      await credentials.deleteRecord(profile.binding.credentialKey)
    }
    await this.settle(record.id, 'completed')
  }

  private async reconcile(profile: ModelAccountRecord): Promise<void> {
    const existing = this.active.get(profile.id)
    const accounts = this.options.accounts()
    const provider = accounts?.get(profile.binding.providerId)
    const usage = profile.snapshot?.usage.state === 'available' ? profile.snapshot.usage : profile.lastConfirmedUsage
    const eligible = profile.connected && profile.desiredActive && !this.closed
      && provider?.implementation.name === profile.implementation.name
      && provider.implementation.version === profile.implementation.version
      && profile.snapshot?.authentication === 'authorized'
      && profile.snapshot.health !== 'unavailable'
      && profile.snapshot.entitlement !== 'denied'
      && !usage?.windows.some(window => window.blocksRequests && window.remaining === 0
        && (window.resetsAt === null || window.resetsAt > Date.now()))
    if (existing !== undefined && (!eligible || existing.routeId !== profile.binding.routeId
      || !accounts?.isActive(profile.binding.routeId))) {
      await existing.dispose()
      this.active.delete(profile.id)
    }
    if (!eligible || this.active.has(profile.id) || accounts === undefined) return
    try {
      const dispose = await accounts.activate(profile.binding, this.options.lifetime)
      if (this.closed || !isDeepStrictEqual(this.options.profiles.get(profile.id), profile)) {
        await dispose()
        return
      }
      this.active.set(profile.id, { routeId: profile.binding.routeId, dispose })
      this.options.notifyChanged()
    } catch {
      // Failed activation remains desired-but-inactive; product selection and credential ownership are retained.
      this.options.notifyChanged()
    }
  }
}
