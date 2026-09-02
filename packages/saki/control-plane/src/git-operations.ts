/** Recoverable structured Git Control Intents and single-Binding write admission. */

import { isDeepStrictEqual } from 'node:util'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  canonicalDigest,
  hostOperationRequestSchema,
  hostOperationSnapshotSchema,
} from '@breakfastdapaidang/saki-execution'
import type {
  HostOperationAdmissionDecision,
  HostOperationAdmissionExpectation,
  HostOperationChange,
  HostOperationKind,
  HostOperationPreparation,
  HostOperationSnapshot,
  InspectProjectResult,
  ProjectGitChange,
  SakiHostExecution,
} from '@breakfastdapaidang/saki-execution'
import { enqueueKeyedOperation } from './keyed-operation.ts'
import { activeHostProjectBinding } from './projects.ts'
import type { DevelopmentProjects } from './projects.ts'
import {
  bindingWriteAdmissionRecordSchema,
  gitOperationIntentRecordSchema,
} from './spec.ts'
import type {
  BindingWriteAdmissionRecord,
  ControlIntentActor,
  DevelopmentProjectRegistryRecord,
  GitOperationIntentRecord,
  ResourceBindingRecord,
} from './spec.ts'
import type {
  SakiControlIntentId,
  SakiCurrentGitOperationProjection,
  SakiGitOperationAvailabilityProjection,
  SakiGitOperationIntent,
  SakiGitOperationIntentReceipt,
  SakiGitOperationReceipt,
  SakiGitOperationReferenceProjectionFor,
  SakiGitOperationsProjection,
  SakiResourceBindingId,
} from './types.ts'

/** Durable structured Git Intent table. */
export type GitOperationIntentTable = KvTable<SakiControlIntentId, GitOperationIntentRecord>
/** Single-writer admission table keyed by Resource Binding. */
export type BindingWriteAdmissionTable = KvTable<SakiResourceBindingId, BindingWriteAdmissionRecord>

type GitIntentType = SakiGitOperationIntent['type']
type GitIntentResult = SakiGitOperationIntentReceipt<GitIntentType>
type GitAction = 'project-changes:stage' | 'project-changes:unstage' | 'project-commit:create'
type CorrelatedOperationProjection<S extends HostOperationSnapshot['state']> =
  | {
    readonly type: 'stage-files'
    readonly operation: SakiGitOperationReferenceProjectionFor<'stage-files', S>
    readonly snapshot: HostOperationSnapshot<'stage-files'> & { readonly state: S }
  }
  | {
    readonly type: 'unstage-files'
    readonly operation: SakiGitOperationReferenceProjectionFor<'unstage-files', S>
    readonly snapshot: HostOperationSnapshot<'unstage-files'> & { readonly state: S }
  }
  | {
    readonly type: 'create-commit'
    readonly operation: SakiGitOperationReferenceProjectionFor<'create-commit', S>
    readonly snapshot: HostOperationSnapshot<'commit'> & { readonly state: S }
  }

interface GitOperationsOptions {
  readonly intentTable: GitOperationIntentTable
  readonly admissionTable: BindingWriteAdmissionTable
  readonly execution: SakiHostExecution
  readonly projects: DevelopmentProjects
  readonly authorityCurrent: (actor: ControlIntentActor, action: GitAction) => boolean
  readonly validateActorReference: (actor: ControlIntentActor) => void
  readonly notifyChanged: () => void
  readonly lifetime: AbortSignal
}

/** Fully cross-validated Git Intent state in owner-first startup recovery order. */
export interface ValidatedGitOperationsState {
  readonly intents: readonly GitOperationIntentRecord[]
}

class IntentCasConflict extends Error {}
class AdmissionBusy extends Error {}
class AdmissionUnavailable extends Error {}

type ReadonlyTable<K extends string, V> = Pick<KvTable<K, V>, 'entries' | 'get' | 'size'>

function readAdmission(
  table: BindingWriteAdmissionTable,
  bindingId: SakiResourceBindingId,
): BindingWriteAdmissionRecord | undefined {
  const value = table.get(bindingId)
  return value === undefined ? undefined : bindingWriteAdmissionRecordSchema.parse(value)
}

/**
 * Validate the complete Git Intent/write-admission relation without writes or Host calls.
 * @param intentTable - opened unified Git Intent table.
 * @param admissionTable - opened single-writer table.
 * @param registry - validated Project Registry, or absence in a new provisioning generation.
 * @param otherIntentIds - ids retained by every other Control Intent table.
 * @param recoverableMissingBindingIds - Registry children whose registration admission handoff is incomplete.
 * @param validateActorReference - Foundation relationship validator for immutable attribution.
 * @returns current manual owners first, then remaining Intents by creation time and id.
 */
export function validateGitOperationsDurableState(
  intentTable: ReadonlyTable<SakiControlIntentId, GitOperationIntentRecord>,
  admissionTable: ReadonlyTable<SakiResourceBindingId, BindingWriteAdmissionRecord>,
  registry: DevelopmentProjectRegistryRecord | undefined,
  otherIntentIds: ReadonlySet<SakiControlIntentId>,
  recoverableMissingBindingIds: ReadonlySet<SakiResourceBindingId>,
  validateActorReference: (actor: ControlIntentActor) => void,
): ValidatedGitOperationsState {
  const intents = [...intentTable.entries()].map(([key, value]) => {
    const intent = gitOperationIntentRecordSchema.parse(value)
    if (intent.id !== key) throw new Error('Saki Git operation Intent id disagrees with its table key')
    if (otherIntentIds.has(key)) {
      throw new Error(`Saki Control Intent '${key}' is retained by multiple Intent kinds`)
    }
    validateActorReference(intent.payload.actor)
    return intent
  })
  const byId = new Map(intents.map(intent => [intent.id, intent]))
  if (registry === undefined) {
    if (intents.length !== 0 || admissionTable.size !== 0) {
      throw new Error('Saki Git operation state exists without the Project Registry')
    }
    return { intents: [] }
  }
  const bindingById = new Map(registry.resourceBindings.map(binding => [binding.id, binding]))
  const manualOwnerIds = new Set<SakiControlIntentId>()
  for (const binding of registry.resourceBindings) {
    if (admissionTable.get(binding.id) === undefined && !recoverableMissingBindingIds.has(binding.id)) {
      throw new Error('Saki Resource Binding has no write admission')
    }
  }
  for (const [key, value] of admissionTable.entries()) {
    const admission = bindingWriteAdmissionRecordSchema.parse(value)
    if (admission.id !== key) throw new Error('Saki Binding write admission id disagrees with its table key')
    const binding = bindingById.get(key)
    if (binding === undefined) throw new Error('Saki Binding write admission has no Resource Binding')
    if (admission.state === 'available') continue
    if (admission.state === 'agent-run') continue
    const intent = byId.get(admission.source.intentId)
    if (intent === undefined) throw new Error('Saki manual write admission has no Git operation Intent')
    assertAdmissionMatchesIntent(admission, intent)
    manualOwnerIds.add(intent.id)
    if (admission.bindingRevision > binding.revision) {
      throw new Error('Saki manual write admission targets a future Binding revision')
    }
  }
  for (const intent of intents) {
    const project = registry.projects.find(candidate => candidate.id === intent.payload.intent.expected.projectId)
    if (intent.hostRequest === undefined) continue
    const binding = bindingById.get(intent.hostRequest.expected.binding.id)
    if (project === undefined || binding === undefined || project.resourceBindingId !== binding.id
      || binding.projectId !== project.id
      || intent.hostRequest.expected.binding.revision > binding.revision) {
      throw new Error('Saki Git operation Intent target is inconsistent')
    }
    const expectedBinding = activeHostProjectBinding(binding, intent.hostRequest.expected.binding.revision)
    if (!isDeepStrictEqual(intent.hostRequest.expected.binding, expectedBinding)) {
      throw new Error('Saki Git operation Intent Binding authority is inconsistent')
    }
    const admissionValue = admissionTable.get(binding.id)
    if (admissionValue === undefined) {
      if (intent.phase === 'prepared' && recoverableMissingBindingIds.has(binding.id)) continue
      throw new Error('Saki Git operation Intent Binding has no write admission')
    }
    const admission = bindingWriteAdmissionRecordSchema.parse(admissionValue)
    const needsOwner = intent.phase === 'admission-reserved' || intent.phase === 'host-prepared'
      || intent.phase === 'accepted' || intent.phase === 'reconciliation-required'
    if (needsOwner && (admission.state !== 'manual-host-operation'
      || admission.source.intentId !== intent.id)) {
      throw new Error('Saki Git operation Intent has no matching write admission')
    }
    if (intent.phase === 'accepted' || intent.phase === 'reconciliation-required') {
      if (admission.state !== 'manual-host-operation' || admission.phase !== 'accepted'
        || admission.revision !== intent.admissionRevision) {
        throw new Error('Saki accepted Git operation Intent has inconsistent admission fencing')
      }
      assertAdmissionMatchesIntent(admission, intent)
    }
  }
  return {
    intents: intents.toSorted((left, right) => {
      const ownerOrder = Number(manualOwnerIds.has(right.id)) - Number(manualOwnerIds.has(left.id))
      return ownerOrder || left.createdAt - right.createdAt || String(left.id).localeCompare(String(right.id))
    }),
  }
}

/** Durable Consumer for direct structured Git Host Operations. */
export class GitOperations {
  private readonly intentTails = new Map<SakiControlIntentId, Promise<void>>()
  private readonly bindingTails = new Map<SakiResourceBindingId, Promise<void>>()
  private readonly active = new Set<Promise<void>>()

  constructor(private readonly options: GitOperationsOptions) {}

  /**
   * Parse all records and validate relationships without writes or Host calls.
   * @param otherIntentIds - ids retained by every other Control Intent table.
   * @param registry - validated Project Registry, or absence in a new provisioning generation.
   * @param recoverableMissingBindingIds - Registry children whose registration admission handoff is incomplete.
   * @returns current manual owners first, then remaining Intents by creation time and id.
   */
  validateDurableState(
    otherIntentIds: ReadonlySet<SakiControlIntentId>,
    registry: DevelopmentProjectRegistryRecord | undefined,
    recoverableMissingBindingIds: ReadonlySet<SakiResourceBindingId> = new Set(),
  ): ValidatedGitOperationsState {
    return validateGitOperationsDurableState(
      this.options.intentTable,
      this.options.admissionTable,
      registry,
      otherIntentIds,
      recoverableMissingBindingIds,
      this.options.validateActorReference,
    )
  }

  /**
   * Reconcile every retained Intent once after complete current-state validation.
   * @param state - fully validated durable state from the same opened generation.
   */
  async initializeValidated(state: ValidatedGitOperationsState): Promise<void> {
    for (const intent of state.intents) {
      this.options.lifetime.throwIfAborted()
      await this.enqueueIntent(intent.id, () => terminal(intent.phase)
        ? this.replayTerminal(intent, this.options.lifetime)
        : this.resume(intent.id, this.options.lifetime))
    }
  }

  /** Wait until every contained notification-driven recovery attempt settles. */
  async dispose(): Promise<void> {
    await Promise.all([...this.active, ...this.intentTails.values(), ...this.bindingTails.values()])
  }

  /**
   * Create the fail-closed available row before Project registration confirms.
   * @param binding - newly committed Resource Binding that will own the row.
   */
  async ensureBindingWriteAdmission(binding: ResourceBindingRecord): Promise<void> {
    await enqueueKeyedOperation(this.bindingTails, binding.id, async () => {
      const existing = this.options.admissionTable.get(binding.id)
      if (existing !== undefined) {
        const parsed = bindingWriteAdmissionRecordSchema.parse(existing)
        if (parsed.id !== binding.id) throw new Error('Saki Binding write admission id disagrees with its key')
        return
      }
      const record = bindingWriteAdmissionRecordSchema.parse({
        id: binding.id,
        schemaVersion: 1,
        revision: 0,
        state: 'available',
        updatedAt: binding.observedAt,
      })
      try {
        await this.options.admissionTable.put(binding.id, record)
      } catch (error) {
        const replay = this.options.admissionTable.get(binding.id)
        if (replay !== undefined && isDeepStrictEqual(bindingWriteAdmissionRecordSchema.parse(replay), record)) return
        throw error
      }
    })
  }

  /**
   * Submit or replay one browser-confirmed structured Git Intent.
   * @param intent - strict path-free mutation request and expected repository evidence.
   * @param actor - authenticated authority attribution captured for durable rechecks.
   * @param signal - lifetime of this attempt; aborting it does not cancel durable work.
   * @returns browser-safe current or terminal receipt.
   */
  async submit<I extends SakiGitOperationIntent>(
    intent: I,
    actor: ControlIntentActor,
    signal: AbortSignal,
  ): Promise<SakiGitOperationIntentReceipt<I['type']>> {
    const result = await this.enqueueIntent(intent.intentId, async () => {
      const existing = this.options.intentTable.get(intent.intentId)
      if (existing !== undefined) {
        const parsed = gitOperationIntentRecordSchema.parse(existing)
        if (!isDeepStrictEqual(parsed.payload.intent, intent)) return { ok: false, reason: 'conflict' } as const
        return await this.resume(parsed.id, signal)
      }
      const action = actionFor(intent.type)
      if (!this.options.authorityCurrent(actor, action)) return { ok: false, reason: 'denied' } as const
      const resolved = this.options.projects.activeBinding(
        intent.expected.projectId,
        intent.expected.expectedRegistryRevision,
      )
      if (typeof resolved === 'string' || resolved.projectRevision !== intent.expected.expectedProjectRevision
        || resolved.binding.id !== intent.expected.expectedBinding.id
        || resolved.binding.revision !== intent.expected.expectedBinding.revision) {
        return await this.persistPreHostConflict(intent, actor, 'expected-evidence')
      }
      const inspected = await this.options.execution.inspectProject({ binding: resolved.binding }, signal)
      signal.throwIfAborted()
      if (!inspected.ok) {
        return inspected.reason === 'unavailable'
          ? { ok: false, reason: 'unavailable' } as const
          : await this.persistPreHostConflict(intent, actor, 'expected-evidence')
      }
      if (!this.options.authorityCurrent(actor, action)) return { ok: false, reason: 'denied' } as const
      if (!matchesExpectation(intent, resolved.projectRevision, inspected)) {
        return await this.persistPreHostConflict(intent, actor, 'expected-evidence')
      }
      if (inspected.preEffectBaseline.kind !== 'complete') {
        return { ok: false, reason: 'unavailable' } as const
      }
      if (!inspected.observation.structuredMutation.available) {
        return inspected.observation.structuredMutation.blockers.includes('baseline-unavailable')
          ? { ok: false, reason: 'unavailable' } as const
          : await this.persistPreHostConflict(intent, actor, 'expected-evidence')
      }
      if (intent.type === 'create-commit' && (inspected.observation.branch.kind === 'detached'
        || !hasStagedOrdinaryChange(inspected.observation.changes))) {
        return { ok: false, reason: 'unavailable' } as const
      }
      if (!selectionMatches(intent, inspected)) {
        return await this.persistPreHostConflict(intent, actor, 'invalid-selection')
      }
      const payload = { intent, actor }
      const payloadDigest = canonicalDigest('saki/git-operation-intent/v1', payload)
      const hostRequestBase = {
        source: {
          kind: 'control-intent' as const,
          intentId: intent.intentId,
          intentRevision: 0,
          payloadDigest,
        },
        expected: {
          binding: resolved.binding,
          status: inspected.observation.fingerprint,
          head: inspected.observation.head,
          index: inspected.observation.index,
          worktree: inspected.observation.worktree,
          preEffectBaseline: inspected.preEffectBaseline,
        },
      }
      const hostRequest = (() => {
        switch (intent.type) {
          case 'stage-files':
            return hostOperationRequestSchema.parse({ ...hostRequestBase, type: 'stage-files', changes: intent.changes })
          case 'unstage-files':
            return hostOperationRequestSchema.parse({ ...hostRequestBase, type: 'unstage-files', changes: intent.changes })
          case 'create-commit':
            return hostOperationRequestSchema.parse({ ...hostRequestBase, type: 'commit', message: intent.message })
          /* v8 ignore next -- closed-union exhaustiveness guard */
          default: return assertNever(intent)
        }
      })()
      const now = Date.now()
      const record = gitOperationIntentRecordSchema.parse({
        id: intent.intentId,
        schemaVersion: 1,
        revision: 0,
        receiptId: receiptId(intent.intentId),
        payloadDigest,
        payload,
        requestRevision: 0,
        hostRequest,
        phase: 'prepared',
        createdAt: now,
        updatedAt: now,
      })
      const persisted = await this.persistNewIntent(record)
      return await this.resume(persisted.id, signal)
    })
    if (!resultMatchesIntentType<I['type']>(result, intent.type)) {
      throw new Error(`Git operation result kind disagrees with Intent '${intent.intentId}'`)
    }
    return result
  }

  private async persistPreHostConflict(
    intent: SakiGitOperationIntent,
    actor: ControlIntentActor,
    terminalReason: 'expected-evidence' | 'invalid-selection',
  ): Promise<GitIntentResult> {
    const payload = { intent, actor }
    const now = Date.now()
    const record = gitOperationIntentRecordSchema.parse({
      id: intent.intentId,
      schemaVersion: 1,
      revision: 0,
      receiptId: receiptId(intent.intentId),
      payloadDigest: canonicalDigest('saki/git-operation-intent/v1', payload),
      payload,
      requestRevision: 0,
      phase: 'conflict',
      terminalReason,
      createdAt: now,
      updatedAt: now,
    })
    return resultFor(await this.persistNewIntent(record))
  }

  private async persistNewIntent(record: GitOperationIntentRecord): Promise<GitOperationIntentRecord> {
    try {
      await this.options.intentTable.put(record.id, record)
      return record
    } catch (error) {
      const replay = this.options.intentTable.get(record.id)
      if (replay !== undefined) {
        const parsed = gitOperationIntentRecordSchema.parse(replay)
        if (parsed.payloadDigest === record.payloadDigest) return parsed
      }
      throw error
    }
  }

  /**
   * Derive repository-level eligibility without treating a browser selection as authority.
   * @param bindingId - Resource Binding whose admission state is projected.
   * @param status - current authoritative repository observation or bounded unavailability.
   * @param allowed - current authorization decisions for each structured mutation.
   * @returns repository-level availability and any current durable operation.
   */
  project(
    bindingId: SakiResourceBindingId,
    status: InspectProjectResult,
    allowed: Readonly<Record<GitAction, boolean>>,
  ): SakiGitOperationsProjection {
    const admissionValue = this.options.admissionTable.get(bindingId)
    const admission = admissionValue === undefined
      ? undefined
      : bindingWriteAdmissionRecordSchema.safeParse(admissionValue)
    const unavailable = admission === undefined || !admission.success
    const busy = admission?.success === true && admission.data.state !== 'available'
    const statusReasons = status.ok
      ? status.observation.structuredMutation.blockers
      : ['status-unavailable' as const]
    const noStagedChanges = status.ok
      && status.observation.structuredMutation.available
      && !hasStagedOrdinaryChange(status.observation.changes)
    const availability = (action: GitAction): SakiGitOperationAvailabilityProjection => {
      const reasons = [
        ...statusReasons,
        ...(action === 'project-commit:create'
          && status.ok
          && status.observation.branch.kind === 'detached'
          ? ['detached-head' as const]
          : []),
        ...(action === 'project-commit:create' && noStagedChanges
          ? ['no-staged-changes' as const]
          : []),
        ...(!allowed[action] ? ['action-denied' as const] : []),
        ...(unavailable ? ['write-admission-unavailable' as const] : []),
        ...(busy ? ['write-admission-busy' as const] : []),
      ]
      return reasons.length === 0
        ? { available: true, reasons: [] }
        : { available: false, reasons: [...new Set(reasons)] }
    }
    const current = admission?.success === true && admission.data.state === 'manual-host-operation'
      ? this.currentProjection(admission.data)
      : undefined
    return {
      stageFiles: availability('project-changes:stage'),
      unstageFiles: availability('project-changes:unstage'),
      createCommit: availability('project-commit:create'),
      ...(current === undefined ? {} : { current }),
    }
  }

  /**
   * Treat Host notifications only as wake-ups; durable inspection remains authoritative.
   * @param change - minimal changed operation reference used to locate its Intent.
   */
  hostChanged(change: HostOperationChange): void {
    const intent = [...this.options.intentTable.entries()]
      .map(([, value]) => gitOperationIntentRecordSchema.parse(value))
      .find(candidate => candidate.preparation?.operation.id === change.operation.id)
    if (intent === undefined || terminal(intent.phase)) return
    const work = this.enqueueIntent(intent.id, () => this.resume(intent.id, this.options.lifetime))
      .then(() => undefined, () => undefined)
    this.active.add(work)
    void work.finally(() => { this.active.delete(work) })
  }

  private async resume(intentId: SakiControlIntentId, signal: AbortSignal): Promise<GitIntentResult> {
    while (true) {
      signal.throwIfAborted()
      let record = this.requireIntent(intentId)
      if (terminal(record.phase)) {
        return await this.replayTerminal(record, signal)
      }
      const hostRequest = requireHostRequest(record)
      const action = actionFor(record.payload.intent.type)
      if (!this.options.authorityCurrent(record.payload.actor, action)) {
        return await this.cancelForRevocation(record, signal)
      }
      if (record.phase === 'prepared') {
        let admission: Extract<BindingWriteAdmissionRecord, { readonly state: 'manual-host-operation' }>
        try {
          admission = await this.reserve(record)
        } catch (error) {
          if (error instanceof AdmissionBusy || error instanceof AdmissionUnavailable) return unavailable(record)
          throw error
        }
        record = await this.updateIntent(record, {
          phase: 'admission-reserved',
          reservationRevision: admission.revision,
        })
        continue
      }
      if (record.phase === 'admission-reserved') {
        let admission: BindingWriteAdmissionRecord
        try {
          admission = this.requireAdmission(hostRequest.expected.binding.id)
        } catch (error) {
          if (error instanceof AdmissionUnavailable) return unavailable(record)
          throw error
        }
        if (admission.state !== 'manual-host-operation' || admission.source.intentId !== record.id) {
          return unavailable(record)
        }
        const prepared = await this.options.execution.prepareOperation(
          hostRequest,
          (expectation, admissionSignal) => this.admit(expectation, admissionSignal),
          signal,
        )
        signal.throwIfAborted()
        if (!prepared.ok) {
          if (prepared.reason === 'unavailable') return unavailable(record)
          record = await this.updateIntent(record, {
            phase: 'conflict',
            terminalReason: 'source-conflict',
          })
          await this.release(record)
          this.options.notifyChanged()
          return resultFor(record)
        }
        assertPreparedReceipt(record, prepared.preparation, prepared.snapshot)
        if (prepared.snapshot.state !== 'prepared') {
          return await this.finishSnapshot(record, prepared.snapshot, prepared.preparation)
        }
        await this.updateIntent(record, {
          phase: 'host-prepared',
          preparation: prepared.preparation,
          operationSnapshot: prepared.snapshot,
        })
        continue
      }
      if (record.phase === 'host-prepared') {
        const preparation = requirePreparation(record)
        let admission: Extract<BindingWriteAdmissionRecord, {
          readonly state: 'manual-host-operation'
          readonly phase: 'accepted'
        }>
        try {
          admission = await this.accept(record, preparation)
        } catch (error) {
          if (error instanceof AdmissionBusy || error instanceof AdmissionUnavailable) return unavailable(record)
          throw error
        }
        await this.updateIntent(record, {
          phase: 'accepted',
          admissionRevision: admission.revision,
        })
        continue
      }
      return await this.driveAccepted(record, signal)
    }
  }

  private async driveAccepted(record: GitOperationIntentRecord, signal: AbortSignal): Promise<GitIntentResult> {
    const preparation = requirePreparation(record)
    const hostRequest = requireHostRequest(record)
    const inspected = await this.options.execution.inspectOperation(preparation.operation, signal)
    signal.throwIfAborted()
    assertSnapshotMatches(record, inspected)
    if (terminalHost(inspected.state)) return await this.finishSnapshot(record, inspected)
    record = await this.updateIntent(record, { operationSnapshot: inspected })
    this.options.notifyChanged()
    const prepared = await this.options.execution.prepareOperation(
      hostRequest,
      (expectation, admissionSignal) => this.admit(expectation, admissionSignal),
      signal,
    )
    signal.throwIfAborted()
    if (!prepared.ok) {
      return prepared.reason === 'unavailable'
        ? unavailable(record)
        : this.conflictAfterAcceptance(record)
    }
    assertPreparedReceipt(record, prepared.preparation, prepared.snapshot)
    const started = await this.options.execution.startOperation(
      prepared.preparation.operation,
      prepared.acceptance,
      signal,
    )
    signal.throwIfAborted()
    assertSnapshotMatches(record, started.snapshot)
    if (terminalHost(started.snapshot.state)) return await this.finishSnapshot(record, started.snapshot)
    record = await this.updateIntent(record, { operationSnapshot: started.snapshot })
    this.options.notifyChanged()
    if (!started.ok && started.reason !== 'busy' && started.reason !== 'unavailable') {
      const reason = started.reason === 'authority-revoked' ? 'authority-revoked' : 'source-canceled'
      const canceled = await this.options.execution.cancelOperation(preparation.operation, reason, signal)
      assertSnapshotMatches(record, canceled)
      if (terminalHost(canceled.state)) return await this.finishSnapshot(record, canceled)
      record = await this.updateIntent(record, { operationSnapshot: canceled })
      this.options.notifyChanged()
    }
    return unavailable(record)
  }

  private async finishSnapshot(
    record: GitOperationIntentRecord,
    snapshot: HostOperationSnapshot,
    preparation: HostOperationPreparation | undefined = record.preparation,
  ): Promise<GitIntentResult> {
    assertSnapshotMatches(record, snapshot)
    if (snapshot.state === 'succeeded') {
      record = await this.updateIntent(record, { phase: 'succeeded', preparation, operationSnapshot: snapshot })
    } else if (snapshot.state === 'failed') {
      record = await this.updateIntent(record, {
        phase: 'failed',
        preparation,
        admissionRevision: snapshot.admission.kind === 'accepted' ? record.admissionRevision : undefined,
        operationSnapshot: snapshot,
        terminalReason: snapshot.failure.reason,
      })
    } else if (snapshot.state === 'canceled') {
      record = await this.updateIntent(record, {
        phase: 'canceled',
        preparation,
        admissionRevision: snapshot.admission.kind === 'accepted' ? record.admissionRevision : undefined,
        operationSnapshot: snapshot,
        terminalReason: snapshot.reason,
      })
    } else if (snapshot.state === 'reconciliation-required') {
      record = await this.updateIntent(record, {
        phase: 'reconciliation-required',
        preparation,
        operationSnapshot: snapshot,
        terminalReason: snapshot.reason,
      })
      this.options.notifyChanged()
      return resultFor(record)
    } else {
      throw new Error(`Nonterminal Host snapshot cannot finish Saki Git operation '${record.id}'`)
    }
    await this.release(record)
    this.options.notifyChanged()
    return resultFor(record)
  }

  /** Retry Host cleanup and require exact durable evidence before owner-sensitive release. */
  private async replayTerminal(
    record: GitOperationIntentRecord,
    signal: AbortSignal,
  ): Promise<GitIntentResult> {
    if (record.preparation !== undefined) {
      const inspected = await this.options.execution.inspectOperation(record.preparation.operation, signal)
      signal.throwIfAborted()
      assertSnapshotMatches(record, inspected)
      if (!isDeepStrictEqual(inspected, record.operationSnapshot)) {
        throw new Error(`Host terminal snapshot disagrees with Saki Git operation '${record.id}'`)
      }
    }
    if (record.phase !== 'reconciliation-required' && record.hostRequest !== undefined) {
      await this.releaseIfStillOwned(record)
    }
    return resultFor(record)
  }

  private async cancelForRevocation(
    record: GitOperationIntentRecord,
    signal: AbortSignal,
  ): Promise<GitIntentResult> {
    if (record.preparation === undefined) {
      const bindingId = requireHostRequest(record).expected.binding.id
      if (this.options.admissionTable.get(bindingId) === undefined) return unavailable(record)
      record = await this.updateIntent(record, {
        phase: 'canceled',
        terminalReason: 'authority-revoked',
      })
      await this.releaseIfStillOwned(record)
      this.options.notifyChanged()
      return resultFor(record)
    }
    const inspected = await this.options.execution.inspectOperation(record.preparation.operation, signal)
    assertSnapshotMatches(record, inspected)
    if (terminalHost(inspected.state)) return await this.finishSnapshot(record, inspected)
    const canceled = await this.options.execution.cancelOperation(
      record.preparation.operation,
      'authority-revoked',
      signal,
    )
    assertSnapshotMatches(record, canceled)
    if (terminalHost(canceled.state)) return await this.finishSnapshot(record, canceled)
    record = await this.updateIntent(record, { operationSnapshot: canceled })
    this.options.notifyChanged()
    return unavailable(record)
  }

  private conflictAfterAcceptance(record: GitOperationIntentRecord): never {
    // An accepted source conflict contradicts the Provider's earlier exact preparation.
    throw new Error(`accepted Saki Git operation '${record.id}' changed its Host source mapping`)
  }

  private async reserve(record: GitOperationIntentRecord): Promise<Extract<BindingWriteAdmissionRecord, {
    readonly state: 'manual-host-operation'
  }>> {
    const hostRequest = requireHostRequest(record)
    const bindingId = hostRequest.expected.binding.id
    if (this.options.admissionTable.get(bindingId) === undefined) throw new AdmissionUnavailable()
    try {
      const next = await this.options.admissionTable.update(bindingId, (value) => {
        const current = bindingWriteAdmissionRecordSchema.parse(value)
        if (current.state === 'manual-host-operation') {
          if (current.source.intentId === record.id
            && current.source.intentRevision === record.requestRevision
            && current.source.payloadDigest === record.payloadDigest
            && current.bindingRevision === hostRequest.expected.binding.revision
            && current.action === actionFor(record.payload.intent.type)) return current
          throw new AdmissionBusy()
        }
        if (current.state === 'agent-run') throw new AdmissionBusy()
        const now = Math.max(current.updatedAt, Date.now())
        return bindingWriteAdmissionRecordSchema.parse({
          id: bindingId,
          schemaVersion: 1,
          revision: current.revision + 1,
          state: 'manual-host-operation',
          phase: 'reserved',
          bindingRevision: hostRequest.expected.binding.revision,
          source: hostRequest.source,
          action: actionFor(record.payload.intent.type),
          reservedAt: now,
          updatedAt: now,
        })
      })
      if (next.state !== 'manual-host-operation') throw new AdmissionUnavailable()
      return next
    } catch (error) {
      if (error instanceof AdmissionBusy || error instanceof AdmissionUnavailable) throw error
      const replay = readAdmission(this.options.admissionTable, bindingId)
      if (replay?.state === 'manual-host-operation' && replay.source.intentId === record.id
        && replay.source.payloadDigest === record.payloadDigest) {
        return replay
      }
      throw error
    }
  }

  private async accept(
    record: GitOperationIntentRecord,
    preparation: HostOperationPreparation,
  ): Promise<Extract<BindingWriteAdmissionRecord, { readonly state: 'manual-host-operation'; readonly phase: 'accepted' }>> {
    const bindingId = requireHostRequest(record).expected.binding.id
    try {
      const next = await this.options.admissionTable.update(bindingId, (value) => {
        const current = bindingWriteAdmissionRecordSchema.parse(value)
        if (current.state !== 'manual-host-operation') throw new AdmissionUnavailable()
        assertAdmissionMatchesIntent(current, record)
        if (current.phase === 'accepted') {
          return current
        }
        const now = Math.max(current.updatedAt, Date.now())
        return bindingWriteAdmissionRecordSchema.parse({
          ...current,
          revision: current.revision + 1,
          phase: 'accepted',
          preparation,
          acceptedAt: now,
          updatedAt: now,
        })
      })
      if (next.state !== 'manual-host-operation' || next.phase !== 'accepted') throw new AdmissionUnavailable()
      return next
    } catch (error) {
      if (error instanceof AdmissionBusy || error instanceof AdmissionUnavailable) throw error
      const replay = readAdmission(this.options.admissionTable, bindingId)
      if (replay?.state === 'manual-host-operation' && replay.phase === 'accepted') {
        assertAdmissionMatchesIntent(replay, record)
        return replay
      }
      throw error
    }
  }

  private async release(record: GitOperationIntentRecord): Promise<void> {
    const bindingId = requireHostRequest(record).expected.binding.id
    const current = this.options.admissionTable.get(bindingId)
    if (current === undefined) throw new AdmissionUnavailable()
    const parsed = bindingWriteAdmissionRecordSchema.parse(current)
    if (parsed.state === 'available') return
    if (parsed.state === 'agent-run') throw new AdmissionBusy()
    if (parsed.source.intentId !== record.id || parsed.source.payloadDigest !== record.payloadDigest) {
      throw new AdmissionBusy()
    }
    try {
      await this.options.admissionTable.update(bindingId, (value) => {
        const stored = bindingWriteAdmissionRecordSchema.parse(value)
        if (stored.state === 'available') return stored
        if (stored.state === 'agent-run') throw new AdmissionBusy()
        if (stored.revision !== parsed.revision || stored.source.intentId !== record.id
          || stored.source.payloadDigest !== record.payloadDigest) throw new AdmissionBusy()
        return bindingWriteAdmissionRecordSchema.parse({
          id: bindingId,
          schemaVersion: 1,
          revision: stored.revision + 1,
          state: 'available',
          updatedAt: Math.max(stored.updatedAt, Date.now()),
        })
      })
    } catch (error) {
      const replay = this.options.admissionTable.get(bindingId)
      if (replay !== undefined) {
        const available = bindingWriteAdmissionRecordSchema.parse(replay)
        if (available.state === 'available' && available.revision >= parsed.revision + 1) return
      }
      throw error
    }
  }

  /** Release this Intent only when it still owns admission; preserve another validated owner. */
  private async releaseIfStillOwned(record: GitOperationIntentRecord): Promise<void> {
    const bindingId = requireHostRequest(record).expected.binding.id
    while (true) {
      const current = this.options.admissionTable.get(bindingId)
      if (current === undefined) throw new AdmissionUnavailable()
      const admission = bindingWriteAdmissionRecordSchema.parse(current)
      if (admission.state === 'available') return
      if (admission.state === 'agent-run') return
      if (admission.source.intentId === record.id && admission.source.payloadDigest === record.payloadDigest) {
        try {
          await this.release(record)
          return
        } catch (error) {
          const replayValue = this.options.admissionTable.get(bindingId)
          if (replayValue === undefined) throw new AdmissionUnavailable()
          const replay = bindingWriteAdmissionRecordSchema.parse(replayValue)
          if (replay.state === 'available') return
          if (replay.state === 'agent-run') return
          if (replay.source.intentId !== record.id || replay.source.payloadDigest !== record.payloadDigest) {
            const ownerValue = this.options.intentTable.get(replay.source.intentId)
            if (ownerValue === undefined) throw new Error('Saki manual write admission has no Git operation Intent')
            assertAdmissionMatchesIntent(replay, gitOperationIntentRecordSchema.parse(ownerValue))
            return
          }
          if (error instanceof AdmissionBusy) continue
          throw error
        }
      }
      const ownerValue = this.options.intentTable.get(admission.source.intentId)
      if (ownerValue === undefined) throw new Error('Saki manual write admission has no Git operation Intent')
      const owner = gitOperationIntentRecordSchema.parse(ownerValue)
      assertAdmissionMatchesIntent(admission, owner)
      return
    }
  }

  private admit(
    expectation: HostOperationAdmissionExpectation,
    signal: AbortSignal,
  ): Promise<HostOperationAdmissionDecision> {
    return Promise.resolve(this.admissionDecision(expectation, signal))
  }

  private admissionDecision(
    expectation: HostOperationAdmissionExpectation,
    signal: AbortSignal,
  ): HostOperationAdmissionDecision {
    signal.throwIfAborted()
    if (expectation.source.kind !== 'control-intent') return { kind: 'denied', reason: 'not-current' }
    const recordValue = this.options.intentTable.get(expectation.source.intentId)
    if (recordValue === undefined) return { kind: 'denied', reason: 'not-current' }
    const record = gitOperationIntentRecordSchema.parse(recordValue)
    if (record.phase === 'canceled' || record.phase === 'conflict') {
      return { kind: 'denied', reason: 'source-canceled' }
    }
    if (record.phase !== 'accepted') return { kind: 'denied', reason: 'not-current' }
    const preparation = record.preparation
    const hostRequest = record.hostRequest
    const admissionRevision = record.admissionRevision
    /* v8 ignore next 3 -- The durable schema requires all accepted-phase evidence fields. */
    if (preparation === undefined || hostRequest === undefined || admissionRevision === undefined) {
      return { kind: 'denied', reason: 'not-current' }
    }
    if (!isDeepStrictEqual(hostRequest.source, expectation.source)
      || !isDeepStrictEqual(preparation, expectation.preparation)
      || expectation.bindingId !== hostRequest.expected.binding.id
      || expectation.bindingRevision !== hostRequest.expected.binding.revision) {
      return { kind: 'denied', reason: 'not-current' }
    }
    const admissionValue = this.options.admissionTable.get(expectation.bindingId)
    if (admissionValue === undefined) return { kind: 'unavailable' }
    const admission = bindingWriteAdmissionRecordSchema.safeParse(admissionValue)
    if (!admission.success) return { kind: 'unavailable' }
    if (admission.data.state !== 'manual-host-operation' || admission.data.phase !== 'accepted'
      || admission.data.revision !== admissionRevision) {
      return { kind: 'denied', reason: 'not-current' }
    }
    try {
      assertAdmissionMatchesIntent(admission.data, record)
    } catch {
      return { kind: 'denied', reason: 'not-current' }
    }
    const current = this.options.projects.currentActiveBinding(record.payload.intent.expected.projectId)
    if (typeof current === 'string' || current.projectRevision !== record.payload.intent.expected.expectedProjectRevision
      || !isDeepStrictEqual(current.binding, hostRequest.expected.binding)
      || current.binding.hostId !== expectation.preparation.operation.hostId) {
      return { kind: 'denied', reason: 'not-current' }
    }
    if (!this.options.authorityCurrent(record.payload.actor, actionFor(record.payload.intent.type))) {
      return { kind: 'denied', reason: 'authority-revoked' }
    }
    return { kind: 'accepted', admissionRevision: admission.data.revision }
  }

  private currentProjection(
    admission: Extract<BindingWriteAdmissionRecord, { readonly state: 'manual-host-operation' }>,
  ): SakiCurrentGitOperationProjection | undefined {
    const value = this.options.intentTable.get(admission.source.intentId)
    if (value === undefined) return undefined
    const record = gitOperationIntentRecordSchema.safeParse(value)
    if (!record.success) return undefined
    const base = { intentId: record.data.id }
    const snapshot = record.data.operationSnapshot
    if (record.data.phase === 'reconciliation-required' && snapshot?.state === 'reconciliation-required') {
      const projected = operationProjectionForIntent(record.data, snapshot)
      switch (projected.type) {
        case 'stage-files':
          return { ...base, type: 'stage-files', operation: projected.operation, state: 'reconciliation-required' }
        case 'unstage-files':
          return { ...base, type: 'unstage-files', operation: projected.operation, state: 'reconciliation-required' }
        case 'create-commit':
          return { ...base, type: 'create-commit', operation: projected.operation, state: 'reconciliation-required' }
        /* v8 ignore next -- closed-union exhaustiveness guard */
        default: return assertNever(projected)
      }
    }
    if (snapshot?.state === 'prepared') {
      const projected = operationProjectionForIntent(record.data, snapshot)
      switch (projected.type) {
        case 'stage-files':
          return { ...base, type: 'stage-files', operation: projected.operation, state: 'host-prepared' }
        case 'unstage-files':
          return { ...base, type: 'unstage-files', operation: projected.operation, state: 'host-prepared' }
        case 'create-commit':
          return { ...base, type: 'create-commit', operation: projected.operation, state: 'host-prepared' }
        /* v8 ignore next -- closed-union exhaustiveness guard */
        default: return assertNever(projected)
      }
    }
    if (snapshot?.state === 'accepted' || snapshot?.state === 'planning' || snapshot?.state === 'publishing') {
      const projected = operationProjectionForIntent(record.data, snapshot)
      switch (projected.type) {
        case 'stage-files':
          return { ...base, type: 'stage-files', operation: projected.operation, state: 'accepted' }
        case 'unstage-files':
          return { ...base, type: 'unstage-files', operation: projected.operation, state: 'accepted' }
        case 'create-commit':
          return { ...base, type: 'create-commit', operation: projected.operation, state: 'accepted' }
        /* v8 ignore next -- closed-union exhaustiveness guard */
        default: return assertNever(projected)
      }
    }
    return { ...base, type: record.data.payload.intent.type, state: 'admission-reserved' }
  }

  private requireIntent(id: SakiControlIntentId): GitOperationIntentRecord {
    return gitOperationIntentRecordSchema.parse(this.options.intentTable.get(id))
  }

  private requireAdmission(id: SakiResourceBindingId): BindingWriteAdmissionRecord {
    const value = this.options.admissionTable.get(id)
    if (value === undefined) throw new AdmissionUnavailable()
    return bindingWriteAdmissionRecordSchema.parse(value)
  }

  private async updateIntent(
    current: GitOperationIntentRecord,
    values: Partial<Pick<GitOperationIntentRecord,
    | 'phase'
    | 'reservationRevision'
    | 'preparation'
    | 'admissionRevision'
    | 'operationSnapshot'
    | 'terminalReason'>>,
  ): Promise<GitOperationIntentRecord> {
    try {
      return await this.options.intentTable.update(current.id, (value) => {
        const stored = gitOperationIntentRecordSchema.parse(value)
        if (stored.revision !== current.revision || stored.payloadDigest !== current.payloadDigest) {
          throw new IntentCasConflict()
        }
        const candidate: Record<string, unknown> = {
          ...stored,
          ...values,
          revision: stored.revision + 1,
          updatedAt: Math.max(stored.updatedAt, Date.now()),
        }
        if ('admissionRevision' in values && values.admissionRevision === undefined) {
          delete candidate.admissionRevision
        }
        return gitOperationIntentRecordSchema.parse(candidate)
      })
    } catch (error) {
      const replay = this.options.intentTable.get(current.id)
      if (replay !== undefined) {
        const parsed = gitOperationIntentRecordSchema.parse(replay)
        if (parsed.payloadDigest === current.payloadDigest
          && parsed.revision === current.revision + 1
          && Object.entries(values).every(([key, expected]) => isDeepStrictEqual(
            parsed[key as keyof GitOperationIntentRecord], expected,
          ))) return parsed
      }
      throw error
    }
  }

  private enqueueIntent<T>(id: SakiControlIntentId, operation: () => Promise<T>): Promise<T> {
    return enqueueKeyedOperation(this.intentTails, id, operation)
  }
}

function matchesExpectation(
  intent: SakiGitOperationIntent,
  projectRevision: number,
  inspected: Extract<InspectProjectResult, { readonly ok: true }>,
): boolean {
  const expected = intent.expected
  const observed = inspected.observation
  return projectRevision === expected.expectedProjectRevision
    && observed.bindingId === expected.expectedBinding.id
    && observed.bindingRevision === expected.expectedBinding.revision
    && isDeepStrictEqual(observed.fingerprint, expected.expectedStatus)
    && isDeepStrictEqual(observed.head, expected.expectedHead)
    && isDeepStrictEqual(observed.index, expected.expectedIndex)
    && isDeepStrictEqual(observed.worktree, expected.expectedWorktree)
}

function selectionMatches(
  intent: SakiGitOperationIntent,
  inspected: Extract<InspectProjectResult, { readonly ok: true }>,
): boolean {
  switch (intent.type) {
    case 'create-commit': return true
    case 'stage-files':
    case 'unstage-files': {
      const byId = new Map(inspected.observation.changes.map(change => [change.id, change]))
      return intent.changes.every((selected) => {
        const change = byId.get(selected.id)
        if (change === undefined || !isDeepStrictEqual(change.fingerprint, selected.fingerprint)) return false
        return intent.type === 'stage-files' ? stageable(change) : unstageable(change)
      })
    }
    /* v8 ignore next -- closed-union exhaustiveness guard */
    default: return assertNever(intent)
  }
}

function stageable(change: ProjectGitChange): boolean {
  return change.kind === 'untracked' || (change.kind === 'ordinary' && change.worktreeStatus !== 'unchanged')
}

function unstageable(change: ProjectGitChange): boolean {
  return change.kind === 'ordinary' && change.indexStatus !== 'unchanged'
}

function actionFor(type: GitIntentType): GitAction {
  switch (type) {
    case 'stage-files': return 'project-changes:stage'
    case 'unstage-files': return 'project-changes:unstage'
    case 'create-commit': return 'project-commit:create'
    default: return assertNever(type)
  }
}

function assertPreparedReceipt(
  record: GitOperationIntentRecord,
  preparation: HostOperationPreparation,
  snapshot: HostOperationSnapshot,
): void {
  const hostRequest = requireHostRequest(record)
  if (preparation.operation.hostId !== record.payload.actor.hostId
    || preparation.operation.type !== hostRequest.type) {
    throw new Error('Host preparation disagrees with its Saki Git Intent')
  }
  assertSnapshotMatches(record, snapshot)
  if (snapshot.operation.id !== preparation.operation.id
    || !isDeepStrictEqual(snapshot.requestFingerprint, preparation.requestFingerprint)) {
    throw new Error('Host snapshot disagrees with its preparation')
  }
}

function assertSnapshotMatches(record: GitOperationIntentRecord, snapshot: HostOperationSnapshot): void {
  hostOperationSnapshotSchema.parse(snapshot)
  const hostRequest = requireHostRequest(record)
  if (snapshot.operation.hostId !== record.payload.actor.hostId
    || snapshot.operation.type !== hostRequest.type
    || snapshot.source.kind !== 'control-intent'
    || snapshot.source.intentId !== record.id
    || snapshot.source.intentRevision !== record.requestRevision
    || snapshot.source.payloadDigest !== record.payloadDigest
    || snapshot.bindingId !== hostRequest.expected.binding.id
    || snapshot.bindingRevision !== hostRequest.expected.binding.revision) {
    throw new Error('Host snapshot disagrees with its Saki Git Intent')
  }
}

function assertAdmissionMatchesIntent(
  admission: Extract<BindingWriteAdmissionRecord, { readonly state: 'manual-host-operation' }>,
  intent: GitOperationIntentRecord,
): void {
  const hostRequest = requireHostRequest(intent)
  if (admission.id !== hostRequest.expected.binding.id
    || admission.bindingRevision !== hostRequest.expected.binding.revision
    || admission.source.intentId !== intent.id
    || admission.source.intentRevision !== intent.requestRevision
    || admission.source.payloadDigest !== intent.payloadDigest
    || admission.action !== actionFor(intent.payload.intent.type)
    || (admission.phase === 'accepted'
      && (intent.preparation === undefined || !isDeepStrictEqual(admission.preparation, intent.preparation)))) {
    throw new Error('Saki Binding write admission disagrees with its Git operation Intent')
  }
}

function requireHostRequest(
  record: GitOperationIntentRecord,
): NonNullable<GitOperationIntentRecord['hostRequest']> {
  /* v8 ignore next 1 -- The durable phase schema requires a Host request at every call site. */
  if (record.hostRequest === undefined) throw new Error(`Saki Git operation '${record.id}' has no Host request`)
  return record.hostRequest
}

function requirePreparation(record: GitOperationIntentRecord): HostOperationPreparation {
  /* v8 ignore next 1 -- The durable phase schema requires preparation at every call site. */
  if (record.preparation === undefined) throw new Error(`Saki Git operation '${record.id}' has no Host preparation`)
  return record.preparation
}

function operationProjectionForIntent<S extends HostOperationSnapshot['state']>(
  record: GitOperationIntentRecord,
  snapshot: HostOperationSnapshot & { readonly state: S },
): CorrelatedOperationProjection<S> {
  const operation = {
    id: snapshot.operation.id,
    revision: snapshot.revision,
    state: snapshot.state,
  }
  const intent = record.payload.intent
  switch (intent.type) {
    case 'stage-files': {
      /* v8 ignore next 3 -- The durable schema rejects Intent, request, and snapshot kind disagreement. */
      if (!snapshotHasOperationType(snapshot, 'stage-files')) {
        throw new Error('Host snapshot kind disagrees with its Git operation Intent')
      }
      return { type: 'stage-files', operation: { ...operation, type: 'stage-files' }, snapshot }
    }
    case 'unstage-files': {
      /* v8 ignore next 3 -- The durable schema rejects Intent, request, and snapshot kind disagreement. */
      if (!snapshotHasOperationType(snapshot, 'unstage-files')) {
        throw new Error('Host snapshot kind disagrees with its Git operation Intent')
      }
      return { type: 'unstage-files', operation: { ...operation, type: 'unstage-files' }, snapshot }
    }
    case 'create-commit': {
      /* v8 ignore next 3 -- The durable schema rejects Intent, request, and snapshot kind disagreement. */
      if (!snapshotHasOperationType(snapshot, 'commit')) {
        throw new Error('Host snapshot kind disagrees with its Git operation Intent')
      }
      return { type: 'create-commit', operation: { ...operation, type: 'commit' }, snapshot }
    }
    /* v8 ignore next -- closed-union exhaustiveness guard */
    default: return assertNever(intent)
  }
}

function snapshotHasOperationType(
  snapshot: HostOperationSnapshot,
  type: 'stage-files',
): snapshot is HostOperationSnapshot<'stage-files'>
function snapshotHasOperationType(
  snapshot: HostOperationSnapshot,
  type: 'unstage-files',
): snapshot is HostOperationSnapshot<'unstage-files'>
function snapshotHasOperationType(
  snapshot: HostOperationSnapshot,
  type: 'commit',
): snapshot is HostOperationSnapshot<'commit'>
function snapshotHasOperationType(snapshot: HostOperationSnapshot, type: HostOperationKind): boolean {
  return snapshot.operation.type === type
}

function resultFor(record: GitOperationIntentRecord): GitIntentResult {
  const receipt = receiptFor(record)
  switch (receipt.state) {
    case 'succeeded': return { ok: true, receipt }
    case 'conflict': return { ok: false, reason: 'conflict', receipt }
    case 'failed': return { ok: false, reason: 'failure', receipt }
    case 'canceled': return { ok: false, reason: 'canceled', receipt }
    case 'reconciliation-required': return { ok: false, reason: 'reconciliation-required', receipt }
    case 'prepared':
    case 'admission-reserved':
    case 'host-prepared':
    case 'accepted': return { ok: false, reason: 'unavailable', receipt }
    /* v8 ignore next -- closed receipt union exhaustiveness guard */
    default: return assertNever(receipt)
  }
}

function resultMatchesIntentType<T extends GitIntentType>(
  result: GitIntentResult,
  intentType: T,
): result is SakiGitOperationIntentReceipt<T> {
  return !('receipt' in result) || result.receipt.type === intentType
}

function unavailable(record: GitOperationIntentRecord): GitIntentResult {
  const receipt = receiptFor(record)
  switch (receipt.state) {
    case 'prepared':
    case 'admission-reserved':
    case 'host-prepared':
    case 'accepted': return { ok: false, reason: 'unavailable', receipt }
    /* v8 ignore start -- Durable phase routing excludes terminal receipts at every unavailable() call site. */
    case 'succeeded':
    case 'conflict':
    case 'failed':
    case 'canceled':
    case 'reconciliation-required': {
      throw new Error(`Terminal Git operation '${record.id}' cannot be returned as unavailable`)
    }
    /* v8 ignore stop */
    /* v8 ignore next -- closed receipt union exhaustiveness guard */
    default: return assertNever(receipt)
  }
}

function hostPreparedReceipt(
  record: GitOperationIntentRecord,
  snapshot: HostOperationSnapshot & { readonly state: 'prepared' },
): Extract<SakiGitOperationReceipt, { readonly state: 'host-prepared' }> {
  const base = {
    id: record.receiptId,
    intentId: record.id,
    projectId: record.payload.intent.expected.projectId,
  }
  const projected = operationProjectionForIntent(record, snapshot)
  switch (projected.type) {
    case 'stage-files':
      return { ...base, type: 'stage-files', state: 'host-prepared', operation: projected.operation }
    case 'unstage-files':
      return { ...base, type: 'unstage-files', state: 'host-prepared', operation: projected.operation }
    case 'create-commit':
      return { ...base, type: 'create-commit', state: 'host-prepared', operation: projected.operation }
    /* v8 ignore next -- closed-union exhaustiveness guard */
    default: return assertNever(projected)
  }
}

function receiptFor(record: GitOperationIntentRecord): SakiGitOperationReceipt {
  const base = {
    id: record.receiptId,
    intentId: record.id,
    projectId: record.payload.intent.expected.projectId,
  }
  const snapshot = record.operationSnapshot
  const phase = record.phase
  switch (phase) {
    case 'prepared': {
      /* v8 ignore next 3 -- The durable schema rejects prepared records with Host evidence. */
      if (snapshot !== undefined) {
        throw new Error(`Prepared Git operation '${record.id}' retains Host evidence`)
      }
      return { ...base, type: record.payload.intent.type, state: 'prepared' }
    }
    case 'admission-reserved': {
      /* v8 ignore next 3 -- The durable schema rejects reserved records with Host evidence. */
      if (snapshot !== undefined) {
        throw new Error(`Reserved Git operation '${record.id}' retains Host evidence`)
      }
      return { ...base, type: record.payload.intent.type, state: 'admission-reserved' }
    }
    case 'host-prepared': {
      /* v8 ignore next 3 -- The durable schema requires prepared Host evidence in this phase. */
      if (snapshot?.state !== 'prepared') {
        throw new Error(`Host-prepared Git operation '${record.id}' lacks prepared Host evidence`)
      }
      return hostPreparedReceipt(record, snapshot)
    }
    case 'accepted': {
      /* v8 ignore next 3 -- The durable schema requires Host evidence throughout this phase. */
      if (snapshot === undefined) {
        throw new Error(`Accepted Git operation '${record.id}' lacks Host evidence`)
      }
      if (snapshot.state === 'prepared') {
        return hostPreparedReceipt(record, snapshot)
      }
      /* v8 ignore next 4 -- The durable schema rejects terminal Host evidence in this phase. */
      if (snapshot.state !== 'accepted' && snapshot.state !== 'planning' && snapshot.state !== 'publishing') {
        throw new Error(`Accepted Git operation '${record.id}' retains terminal Host evidence`)
      }
      const projected = operationProjectionForIntent(record, snapshot)
      switch (projected.type) {
        case 'stage-files':
          return { ...base, type: 'stage-files', state: 'accepted', operation: projected.operation }
        case 'unstage-files':
          return { ...base, type: 'unstage-files', state: 'accepted', operation: projected.operation }
        case 'create-commit':
          return { ...base, type: 'create-commit', state: 'accepted', operation: projected.operation }
        /* v8 ignore next -- closed-union exhaustiveness guard */
        default: return assertNever(projected)
      }
    }
    case 'succeeded': {
      /* v8 ignore next 3 -- The durable schema requires succeeded Host evidence in this phase. */
      if (snapshot?.state !== 'succeeded') {
        throw new Error(`Succeeded Git operation '${record.id}' lacks succeeded Host evidence`)
      }
      const projected = operationProjectionForIntent(record, snapshot)
      switch (projected.type) {
        case 'stage-files':
          return {
            ...base,
            type: 'stage-files',
            state: 'succeeded',
            operation: projected.operation,
            result: projected.snapshot.result,
          }
        case 'unstage-files':
          return {
            ...base,
            type: 'unstage-files',
            state: 'succeeded',
            operation: projected.operation,
            result: projected.snapshot.result,
          }
        case 'create-commit':
          return {
            ...base,
            type: 'create-commit',
            state: 'succeeded',
            operation: projected.operation,
            result: projected.snapshot.result,
          }
        /* v8 ignore next -- closed-union exhaustiveness guard */
        default: return assertNever(projected)
      }
    }
    case 'conflict': {
      const reason = conflictReason(record)
      if (snapshot === undefined) {
        return { ...base, type: record.payload.intent.type, state: 'conflict', reason }
      }
      /* v8 ignore next 3 -- The durable schema permits only prepared no-effect Host evidence here. */
      if (snapshot.state !== 'prepared') {
        throw new Error(`Conflicted Git operation '${record.id}' retains possible-effect Host evidence`)
      }
      const projected = operationProjectionForIntent(record, snapshot)
      switch (projected.type) {
        case 'stage-files':
          return { ...base, type: 'stage-files', state: 'conflict', reason, operation: projected.operation }
        case 'unstage-files':
          return { ...base, type: 'unstage-files', state: 'conflict', reason, operation: projected.operation }
        case 'create-commit':
          return { ...base, type: 'create-commit', state: 'conflict', reason, operation: projected.operation }
        /* v8 ignore next -- closed-union exhaustiveness guard */
        default: return assertNever(projected)
      }
    }
    case 'failed': {
      /* v8 ignore next 4 -- The durable schema requires matching failed Host evidence here. */
      if (snapshot?.state !== 'failed' || record.terminalReason !== snapshot.failure.reason) {
        throw new Error(`Failed Git operation '${record.id}' lacks matching failed Host evidence`)
      }
      const projected = operationProjectionForIntent(record, snapshot)
      switch (projected.type) {
        case 'stage-files':
          return {
            ...base,
            type: 'stage-files',
            state: 'failed',
            reason: projected.snapshot.failure.reason,
            operation: projected.operation,
          }
        case 'unstage-files':
          return {
            ...base,
            type: 'unstage-files',
            state: 'failed',
            reason: projected.snapshot.failure.reason,
            operation: projected.operation,
          }
        case 'create-commit':
          return {
            ...base,
            type: 'create-commit',
            state: 'failed',
            reason: projected.snapshot.failure.reason,
            operation: projected.operation,
          }
        /* v8 ignore next -- closed-union exhaustiveness guard */
        default: return assertNever(projected)
      }
    }
    case 'canceled': {
      const reason = cancellationReason(record)
      if (snapshot === undefined) {
        return { ...base, type: record.payload.intent.type, state: 'canceled', reason }
      }
      /* v8 ignore next 3 -- The durable schema requires matching canceled Host evidence here. */
      if (snapshot.state !== 'canceled' || reason !== snapshot.reason) {
        throw new Error(`Canceled Git operation '${record.id}' lacks matching canceled Host evidence`)
      }
      const projected = operationProjectionForIntent(record, snapshot)
      switch (projected.type) {
        case 'stage-files':
          return { ...base, type: 'stage-files', state: 'canceled', reason, operation: projected.operation }
        case 'unstage-files':
          return { ...base, type: 'unstage-files', state: 'canceled', reason, operation: projected.operation }
        case 'create-commit':
          return { ...base, type: 'create-commit', state: 'canceled', reason, operation: projected.operation }
        /* v8 ignore next -- closed-union exhaustiveness guard */
        default: return assertNever(projected)
      }
    }
    case 'reconciliation-required': {
      /* v8 ignore next 4 -- The durable schema requires matching reconciliation Host evidence here. */
      if (snapshot?.state !== 'reconciliation-required' || record.terminalReason !== snapshot.reason) {
        throw new Error(`Reconciling Git operation '${record.id}' lacks matching Host evidence`)
      }
      const projected = operationProjectionForIntent(record, snapshot)
      switch (projected.type) {
        case 'stage-files':
          return {
            ...base,
            type: 'stage-files',
            state: 'reconciliation-required',
            reason: projected.snapshot.reason,
            operation: projected.operation,
          }
        case 'unstage-files':
          return {
            ...base,
            type: 'unstage-files',
            state: 'reconciliation-required',
            reason: projected.snapshot.reason,
            operation: projected.operation,
          }
        case 'create-commit':
          return {
            ...base,
            type: 'create-commit',
            state: 'reconciliation-required',
            reason: projected.snapshot.reason,
            operation: projected.operation,
          }
        /* v8 ignore next -- closed-union exhaustiveness guard */
        default: return assertNever(projected)
      }
    }
    /* v8 ignore next -- closed lifecycle union exhaustiveness guard */
    default: return assertNever(phase)
  }
}

function conflictReason(
  record: GitOperationIntentRecord,
): 'expected-evidence' | 'invalid-selection' | 'source-conflict' | 'protocol' {
  switch (record.terminalReason) {
    case 'expected-evidence':
    case 'invalid-selection':
    case 'source-conflict':
    case 'protocol': return record.terminalReason
    /* v8 ignore next -- The durable phase schema permits only conflict reasons in a conflict record. */
    default: throw new Error(`Conflicted Git operation '${record.id}' has an invalid reason`)
  }
}

function cancellationReason(record: GitOperationIntentRecord): 'source-canceled' | 'authority-revoked' {
  switch (record.terminalReason) {
    case 'source-canceled':
    case 'authority-revoked': return record.terminalReason
    /* v8 ignore next -- The durable phase schema permits only cancellation reasons in a canceled record. */
    default: throw new Error(`Canceled Git operation '${record.id}' has an invalid reason`)
  }
}

function hasStagedOrdinaryChange(changes: readonly ProjectGitChange[]): boolean {
  return changes.some(change => change.kind === 'ordinary' && change.indexStatus !== 'unchanged')
}

function terminal(phase: GitOperationIntentRecord['phase']): boolean {
  switch (phase) {
    case 'prepared':
    case 'admission-reserved':
    case 'host-prepared':
    case 'accepted': return false
    case 'succeeded':
    case 'conflict':
    case 'failed':
    case 'canceled':
    case 'reconciliation-required': return true
    /* v8 ignore next -- closed lifecycle union exhaustiveness guard */
    default: return assertNever(phase)
  }
}

function terminalHost(state: HostOperationSnapshot['state']): boolean {
  switch (state) {
    case 'prepared':
    case 'accepted':
    case 'planning':
    case 'publishing': return false
    case 'succeeded':
    case 'failed':
    case 'canceled':
    case 'reconciliation-required': return true
    /* v8 ignore next -- closed lifecycle union exhaustiveness guard */
    default: return assertNever(state)
  }
}

function receiptId(intentId: SakiControlIntentId): `receipt-${string}` {
  return intentId.replace(/^intent-/u, 'receipt-') as `receipt-${string}`
}

function assertNever(value: never): never {
  throw new TypeError(`unexpected Saki Git operation discriminant: ${JSON.stringify(value)}`)
}
